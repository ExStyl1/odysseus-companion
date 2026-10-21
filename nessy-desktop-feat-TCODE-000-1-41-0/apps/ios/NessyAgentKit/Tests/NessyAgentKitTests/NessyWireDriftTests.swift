import XCTest
@testable import NessyAgentKit

/// M1 — the wire drift between this fork's desktop and the vendored client.
///
/// Both cases here started as measured failures against the vendored code, not
/// as hypotheses. A Swift `String` raw-value `Codable` enum THROWS on a value it
/// does not know, and an Optional property does not rescue it, so a single
/// unrecognised enum string discards the entire surrounding payload. That is the
/// silent-failure shape this fork keeps re-learning: nothing errors visibly, the
/// screen simply stays empty.
///
/// WHAT THIS FILE IS NOT, learned the hard way on 2026-08-25. These are decode-
/// BEHAVIOUR tests, and their expected values are literals frozen here on
/// 2026-08-09. They are not a parity check and never were: when
/// `PermissionRequestType` grew `worktree_setup` in TypeScript (`22d71972b`),
/// nothing in this file looked at TypeScript, so nothing failed — and the job
/// that runs `swift test` only fires on `changes: apps/ios/**`, which that
/// commit did not touch. The cross-language authority is
/// `scripts/ios-wire-enum-parity.test.ts`, which reads both languages as text
/// and runs under `bun test` on every pipeline. Keep these tests: they cover
/// what a list comparison cannot — that an unknown value DEGRADES instead of
/// discarding the payload around it.
final class NessyWireDriftTests: XCTestCase {

    // MARK: - PermissionRequestType

    func testDecodesTheFourTypesUpstreamNeverHad() throws {
        // Measured before the fix: `outside_root` threw
        // "Cannot initialize PermissionRequestType from invalid String value",
        // which meant no approval sheet at all for these requests.
        for raw in ["workflow_launch", "worktree_approval", "ask_user", "outside_root"] {
            let json = #"{"requestId":"r","toolName":"Bash","description":"d","type":"\#(raw)"}"#
            let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))
            XCTAssertNotEqual(req.type, .unknown, "\(raw) should have its own case")
            XCTAssertEqual(req.type?.rawValue, raw)
        }
    }

    func testEveryDeclaredTypeDecodesToItself() throws {
        // Derived from the enum, not from a list typed out beside it, so this
        // cannot freeze while the enum moves. What it CANNOT see is a value that
        // exists only in TypeScript — that is
        // `scripts/ios-wire-enum-parity.test.ts`'s job, and the reason it exists.
        for type in PermissionRequestType.allCases where type != .unknown {
            let json = #"{"requestId":"r","toolName":"Bash","description":"d","type":"\#(type.rawValue)"}"#
            let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))
            XCTAssertEqual(req.type, type, "\(type.rawValue) must decode to its own case")
        }
    }

    func testWorktreeSetupIsItsOwnTypeAndNotTheWorkflowRoute() throws {
        // `22d71972b`: the string is a ROUTE. The desktop deliberately did NOT
        // reuse `workflow_launch`, because that maps to the workflow card and
        // would show a workflow's name-and-phase consent for a shell command —
        // the user would approve a description of something else entirely.
        let json = #"{"requestId":"r","toolName":"Bash","description":"d","type":"worktree_setup"}"#
        let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))

        XCTAssertEqual(req.type, .worktreeSetup)
        XCTAssertNotEqual(req.type, .workflowLaunch)
        XCTAssertNotEqual(req.type, .unknown)
    }

    func testWorktreeCleanupIsItsOwnTypeAndNotAGenericApproval() throws {
        // P6.723. The desktop's card for this one drops Always Allow and the
        // destructive tone because "deny" is the SAFE half — the worktree and
        // its branch stay. Decoding it as `.unknown` erases exactly that
        // distinction, and this build did until the TypeScript-side parity
        // guard failed on it.
        let json = #"{"requestId":"r","toolName":"WorktreeCleanup","description":"d","type":"worktree_cleanup"}"#
        let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))

        XCTAssertEqual(req.type, .worktreeCleanup)
        XCTAssertNotEqual(req.type, .worktreeSetup)
        XCTAssertNotEqual(req.type, .unknown)
    }

    func testAnUnheardOfTypeStillYieldsARequest() throws {
        // The desktop ships on its own cadence, so the device WILL meet values
        // this build has never seen. It must degrade to a generic approval
        // rather than drop the request on the floor.
        let json = #"{"requestId":"r","toolName":"Bash","description":"d","type":"some_future_kind"}"#
        let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))
        XCTAssertEqual(req.type, .unknown)
        XCTAssertEqual(req.requestId, "r")
    }

    func testCarriesTheFieldsThatChangeBehaviour() throws {
        // `noAlwaysAllow` and `parentSessionId` are not decoration: one hides a
        // button the server refuses to honour, the other decides which session
        // the prompt belongs to. Dropping either is a user-visible defect.
        let json = #"""
        {"requestId":"r","toolName":"Bash","description":"d",
         "noAlwaysAllow":true,"parentSessionId":"visible-1","agentLabel":"scout",
         "commandHash":"h","approvalTtlSeconds":30}
        """#
        let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))
        XCTAssertEqual(req.noAlwaysAllow, true)
        XCTAssertEqual(req.parentSessionId, "visible-1")
        XCTAssertEqual(req.agentLabel, "scout")
        XCTAssertEqual(req.commandHash, "h")
        XCTAssertEqual(req.approvalTtlSeconds, 30)
    }

    // MARK: - Always Allow, the button the server can refuse (P6.727)

    func testAlwaysAllowIsWithheldWhenTheServerSaysItWillNotRememberThis() throws {
        // Arm 1. `noAlwaysAllow` decoded but read by nothing was the defect: the
        // sheet rendered all three buttons, and a tap on the middle one asked the
        // server for a standing grant it had already said it refuses to keep.
        let json = #"{"requestId":"r","toolName":"Monitor","description":"d","noAlwaysAllow":true}"#
        let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))

        XCTAssertEqual(req.noAlwaysAllow, true)
        XCTAssertFalse(req.canAlwaysAllow)
    }

    func testAlwaysAllowIsWithheldForAWorktreeCleanup() throws {
        // Arm 2, and it does NOT travel in `noAlwaysAllow`: the desktop derives it
        // from the type alone, because an "always remove" is a standing instruction
        // to delete directories (the posture P6.135 declined to take). A build that
        // gated only on the flag would still offer it here.
        let json = #"""
        {"requestId":"r","toolName":"ExitWorktree","description":"d","type":"worktree_cleanup"}
        """#
        let req = try JSONDecoder().decode(PermissionRequest.self, from: Data(json.utf8))

        XCTAssertEqual(req.type, .worktreeCleanup)
        XCTAssertNil(req.noAlwaysAllow)
        XCTAssertFalse(req.canAlwaysAllow)
    }

    func testAnOrdinaryApprovalStillOffersAlwaysAllow() throws {
        // The control. Without it a gate that always says "no" would pass both arms
        // above while silently removing the choice from every approval on the phone.
        let plain = #"{"requestId":"r","toolName":"Bash","description":"d","type":"bash"}"#
        XCTAssertTrue(try JSONDecoder().decode(PermissionRequest.self, from: Data(plain.utf8)).canAlwaysAllow)

        // And an explicit `false` is an offer, not a refusal — the flag is the
        // server saying "do not", never "do not mention".
        let explicit = #"{"requestId":"r","toolName":"Bash","description":"d","noAlwaysAllow":false}"#
        XCTAssertTrue(try JSONDecoder().decode(PermissionRequest.self, from: Data(explicit.utf8)).canAlwaysAllow)

        // A type this build has never heard of keeps the button: it degrades to a
        // generic approval, and withdrawing a working choice for every future type
        // would be a second silent divergence in the opposite direction.
        let future = #"{"requestId":"r","toolName":"X","description":"d","type":"some_future_kind"}"#
        let unknown = try JSONDecoder().decode(PermissionRequest.self, from: Data(future.utf8))
        XCTAssertEqual(unknown.type, .unknown)
        XCTAssertTrue(unknown.canAlwaysAllow)
    }

    // MARK: - PermissionMode

    func testDecodesClaudeCodesSixModes() throws {
        // Upstream knew three, and the desktop sends these (F1.1069: `explore`
        // is retired, so exactly Claude Code's six, in strictness order).
        let canonical = ["dontAsk", "plan", "default", "acceptEdits", "auto", "bypassPermissions"]
        for raw in canonical {
            let mode = try JSONDecoder().decode(PermissionMode.self, from: Data("\"\(raw)\"".utf8))
            XCTAssertEqual(mode.rawValue, raw)
        }
        XCTAssertEqual(PermissionMode.allCases.count, canonical.count)
    }

    func testStillReadsThePreMigrationSpellings() throws {
        // "Permanent read-path aliases" is the desktop's own rule; a session
        // persisted years ago still carries them.
        let expected: [(String, PermissionMode)] = [
            ("safe", .plan), ("ask", .default), ("allow-all", .bypassPermissions),
            ("execute", .bypassPermissions), ("manual", .default), ("automatic", .auto),
            // F1.1069: an older server still reports a session in `explore`.
            ("explore", .plan),
        ]
        for (raw, want) in expected {
            let mode = try JSONDecoder().decode(PermissionMode.self, from: Data("\"\(raw)\"".utf8))
            XCTAssertEqual(mode, want, "\(raw) should alias to \(want)")
        }
    }

    func testNeverWritesALegacySpellingBack() throws {
        // Aliases are read-only. Emitting one would push the old vocabulary
        // back onto a desktop that migrated away from it.
        // F1.1069: a session read as `explore` is written back as `plan`.
        let read = try JSONDecoder().decode(PermissionMode.self, from: Data("\"explore\"".utf8))
        let encoded = try JSONEncoder().encode(read)
        XCTAssertEqual(String(decoding: encoded, as: UTF8.self), "\"plan\"")
    }
}

/// M3 — a client that just opened a session must ask the server whether a turn
/// is running. Inferring it from observed events is wrong on reconnect, where
/// the server replays a buffer: the composer kept a stop button on an idle
/// session, so every stop press had nothing to cancel.
final class NessySessionStateTests: XCTestCase {
    func testReadsIsProcessingFromTheSessionPayload() throws {
        let json = #"{"id":"s1","isProcessing":true,"messages":[]}"#
        let state = try RPCClient.decodeSessionStateResult(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))

        XCTAssertTrue(state.isProcessing)
    }

    func testAnIdleSessionReadsIdle() throws {
        let json = #"{"id":"s1","isProcessing":false,"messages":[]}"#
        let state = try RPCClient.decodeSessionStateResult(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))

        XCTAssertFalse(state.isProcessing)
    }

    func testAServerThatOmitsTheFieldReadsIdleRatherThanFailing() throws {
        // Fail SAFE, not closed: an older server without the field must not
        // leave the composer stuck on "stopping", and must not fail the decode
        // and take the message list with it.
        let json = #"{"id":"s1","messages":[]}"#
        let state = try RPCClient.decodeSessionStateResult(try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)))

        XCTAssertFalse(state.isProcessing)
        XCTAssertTrue(state.messages.isEmpty)
    }

    func testANullResultIsAnEmptyIdleSession() throws {
        let state = try RPCClient.decodeSessionStateResult(.null)

        XCTAssertFalse(state.isProcessing)
        XCTAssertTrue(state.messages.isEmpty)
    }
}

/// M4 clarification (owner, 2026-08-09): surfaces are hidden by CAPABILITY, not
/// by a hardcoded list, so a screen revives on its own the day the server starts
/// serving its channel. The dangerous direction is the default: a server that
/// says nothing must read as "unknown", never as "supports nothing".
final class NessyCapabilityGateTests: XCTestCase {
    func testAServerThatAdvertisesAChannelSupportsIt() async {
        let transport = RPCTransport()
        await transport.setRegisteredChannelsForTesting(["sessions:get", "skills:get"])

        let supported = await transport.supportsChannel("skills:get")
        XCTAssertTrue(supported)
    }

    func testAServerThatAdvertisesWithoutTheChannelDoesNotSupportIt() async {
        let transport = RPCTransport()
        await transport.setRegisteredChannelsForTesting(["sessions:get"])

        let supported = await transport.supportsChannel("skills:get")
        XCTAssertFalse(supported)
    }

    func testAServerThatSaysNothingIsTreatedAsUNKNOWNRatherThanIncapable() async {
        // Fail OPEN. Reading silence as "supports nothing" would hide every
        // screen against an older server.
        let transport = RPCTransport()

        let supported = await transport.supportsChannel("skills:get")
        XCTAssertTrue(supported)
    }
}

/// F8 — the device picker must not offer what the server refuses. This is the
/// COSMETIC half; the enforcement is server-side
/// (`remote-permission-ceiling.test.ts`), and these tests say so out loud so
/// nobody later "simplifies" the server check away on the strength of this list.
final class NessyRemotePermissionModeTests: XCTestCase {
    func testTheDevicePickerDoesNotOfferBypass() {
        XCTAssertFalse(PermissionMode.settableFromRemoteDevice.contains(.bypassPermissions))
    }

    func testEveryOtherModeStaysAvailableOnTheDevice() {
        // A phone that cannot pick `plan` or `default` is not safer, just useless.
        let settable = PermissionMode.settableFromRemoteDevice

        XCTAssertEqual(settable.count, PermissionMode.allCases.count - 1)
        XCTAssertTrue(settable.contains(.plan))
        XCTAssertTrue(settable.contains(.default))
        XCTAssertTrue(settable.contains(.auto))
    }

    func testTheFullVocabularyStillDecodes() {
        // Hiding a mode from the picker must not stop the app UNDERSTANDING a
        // session that is already running in it — a desktop can still set bypass.
        XCTAssertEqual(PermissionMode(rawValue: "bypassPermissions"), .bypassPermissions)
    }
}

/// F1.1069 — the device's mode picker follows the unified modes (owner spec
/// 2026-09-28): a Nestor Cloud session offers ONLY the cloud agent's own modes,
/// every other session Auto, Manual, Accept edits, Plan and Bypass permissions
/// in Claude Desktop's order, and `dontAsk` is shown when a session holds it but
/// never offered. Until F1.1069 the menu iterated `settableFromRemoteDevice`
/// for every session — Nessy's own modes, `explore` and `dontAsk` included, on a
/// Nestor Cloud session too.
final class NessyPermissionModePickerTests: XCTestCase {
    private func permissions(_ json: String) throws -> ComposerCapabilities.PermissionsCapability? {
        try JSONDecoder().decode(ComposerCapabilities.self, from: Data(json.utf8)).permissions
    }

    func testANessySessionOffersTheUnifiedModesInClaudeDesktopsOrder() throws {
        // The server lists every mode in STRICTNESS order; the picker is a UI order.
        let entries = PermissionMode.pickerEntries(for: try permissions("""
        {"permissions":{"modes":["dontAsk","plan","default","acceptEdits","auto","bypassPermissions"]}}
        """))

        XCTAssertEqual(entries.map(\.mode), [.auto, .default, .acceptEdits, .plan, .bypassPermissions])
        XCTAssertEqual(entries.map(\.title), ["Auto", "Manual", "Accept edits", "Plan", "Bypass permissions"])
        // Listed so the menu matches the desktop's, not offered: the server
        // refuses it from a remote device (F8).
        XCTAssertEqual(entries.filter { !$0.isSelectable }.map(\.mode), [.bypassPermissions])
        // An older server that says nothing gets the same list, not an empty one.
        XCTAssertEqual(PermissionMode.pickerEntries(for: nil).map(\.mode), entries.map(\.mode))
    }

    func testANestorCloudSessionOffersOnlyTheModesTheAgentSupplies() throws {
        let caps = try permissions("""
        {"permissions":{"modes":["plan","default"],"modeOptions":[
          {"mode":"plan","label":"Plan","shortLabel":"Plan","description":"Remote planning mode.","remoteModeId":"plan"},
          {"mode":"default","label":"Act","shortLabel":"Act","description":"Remote implementation mode.","remoteModeId":"act"}]}}
        """)
        let entries = PermissionMode.pickerEntries(for: caps)

        XCTAssertEqual(entries.map(\.mode), [.plan, .default])
        XCTAssertEqual(entries.map(\.title), ["Plan", "Act"])
        XCTAssertEqual(entries.map(\.detail), ["Remote planning mode.", "Remote implementation mode."])
        XCTAssertTrue(entries.allSatisfy(\.isSelectable))
        // The capsule names the server's mode, not Nessy's Manual.
        XCTAssertEqual(PermissionMode.currentLabel(rawId: "default", permissions: caps), "Act")
    }

    func testAnOldServersExploreFoldsIntoPlanAndAnUnknownModeIsNotOffered() throws {
        // Boundary: the pre-F1.1050 list, plus a mode this build has never heard
        // of. The decode must survive both, and neither may appear as a row.
        let caps = try permissions("""
        {"permissions":{"modes":["dontAsk","explore","plan","default","acceptEdits","auto","bypassPermissions","turbo"]}}
        """)
        XCTAssertEqual(caps?.modes?.last, "turbo")

        let modes = PermissionMode.pickerEntries(for: caps).map(\.mode)
        XCTAssertEqual(modes, [.auto, .default, .acceptEdits, .plan, .bypassPermissions])
        XCTAssertFalse(modes.contains(.dontAsk))
    }

    func testTheCapsuleNamesHiddenLegacyAndUnknownModesHonestly() {
        // `dontAsk` is hidden from the picker, never from a session that holds it.
        XCTAssertEqual(PermissionMode.currentLabel(rawId: "dontAsk", permissions: nil), "Don't ask")
        XCTAssertEqual(PermissionMode.currentLabel(rawId: "explore", permissions: nil), "Plan")
        XCTAssertEqual(PermissionMode.currentLabel(rawId: "bypassPermissions", permissions: nil), "Bypass")
        // Shown by its raw name, never dropped and never guessed as a known mode.
        XCTAssertEqual(PermissionMode.currentLabel(rawId: "turbo", permissions: nil), "turbo")
        // P6.372's third state stays distinct: no mode is not a mode.
        XCTAssertNil(PermissionMode.currentLabel(rawId: nil, permissions: nil))
        XCTAssertNil(PermissionMode.currentLabel(rawId: "", permissions: nil))
    }
}

/// F3 — the Safe-capability projection. The kinds are decoded as STRINGS on
/// purpose: a server that grows a kind must not fail the whole catalog.
final class NessySafeCapabilityTests: XCTestCase {
    private func catalog(_ json: String) throws -> SafeCapabilityCatalog {
        try JSONDecoder().decode(SafeCapabilityCatalog.self, from: Data(json.utf8))
    }

    func testSplitsSkillsFromSources() throws {
        let decoded = try catalog("""
        {"capabilities":[
          {"key":"skill::a","kind":"skill","displayName":"A"},
          {"key":"mcp::b","kind":"mcp","displayName":"B"},
          {"key":"source::c","kind":"source","displayName":"C"},
          {"key":"agent::d","kind":"agent","displayName":"D"}
        ]}
        """)

        XCTAssertEqual(decoded.skills.map(\.title), ["A"])
        // Sources are the source entries PLUS the MCP servers — the same
        // grouping the desktop's Sources surface uses.
        XCTAssertEqual(decoded.sources.map(\.title), ["B", "C"])
    }

    func testAnUnknownKindDoesNotFailTheCatalog() throws {
        let decoded = try catalog("""
        {"capabilities":[
          {"key":"skill::a","kind":"skill","displayName":"A"},
          {"key":"future::x","kind":"some-future-kind","displayName":"X"}
        ]}
        """)

        XCTAssertEqual(decoded.capabilities.count, 2)
        XCTAssertEqual(decoded.skills.map(\.title), ["A"])
    }

    func testTitleFallsBackThroughDisplayNameLogicalNameThenKey() throws {
        let decoded = try catalog("""
        {"capabilities":[
          {"key":"k1","kind":"skill","displayName":"Shown"},
          {"key":"k2","kind":"skill","logicalName":"logical"},
          {"key":"k3","kind":"skill"}
        ]}
        """)

        XCTAssertEqual(decoded.capabilities.map(\.title), ["Shown", "logical", "k3"])
    }

    func testTheProjectionCarriesNoBodyOrPathField() {
        // The safe model's whole point. If a `content`/`path` field ever
        // appears here, that is a protocol decision to make deliberately, not
        // something to absorb by accident.
        let mirror = Mirror(reflecting: SafeCapabilitySummary(
            key: "k", kind: "skill", logicalName: nil, displayName: nil, description: nil,
            state: nil, trustState: nil, credentialState: nil, readOnly: nil, diagnosticCodes: nil
        ))
        let names = mirror.children.compactMap(\.label)

        XCTAssertFalse(names.contains("content"))
        XCTAssertFalse(names.contains("body"))
        XCTAssertFalse(names.contains("path"))
    }
}

/// F15 — "waiting for you" is the state this app exists for, so it has to
/// survive a server that does not send it and outrank everything that is merely
/// new.
final class NessyAwaitingApprovalTests: XCTestCase {
    private func session(id: String, at: Double, awaiting: Int?, unread: Bool = false) -> Session {
        Session(id: id, workspaceId: "w", workspaceName: "W", lastMessageAt: at,
                isProcessing: false, hasUnread: unread, awaitingApprovalCount: awaiting)
    }

    func testAnOlderServerReadsAsNotWaitingRatherThanFailing() throws {
        // The field is optional on the wire: a server without F15 must still
        // produce a decodable session list.
        let json = #"{"id":"s","workspaceId":"w","workspaceName":"W","lastMessageAt":1,"isProcessing":false}"#
        let decoded = try JSONDecoder().decode(Session.self, from: Data(json.utf8))

        XCTAssertNil(decoded.awaitingApprovalCount)
        XCTAssertFalse(decoded.isAwaitingApproval)
    }

    func testZeroIsNotWaiting() {
        XCTAssertFalse(session(id: "s", at: 1, awaiting: 0).isAwaitingApproval)
        XCTAssertTrue(session(id: "s", at: 1, awaiting: 1).isAwaitingApproval)
    }

    func testDecodesTheCountTheServerSends() throws {
        let json = #"{"id":"s","workspaceId":"w","workspaceName":"W","lastMessageAt":1,"isProcessing":false,"awaitingApprovalCount":2}"#
        let decoded = try JSONDecoder().decode(Session.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.awaitingApprovalCount, 2)
        XCTAssertTrue(decoded.isAwaitingApproval)
    }
}

/// F1.1165 (origin DN-275) — the phone's mode menu carries the desktop's badges (F1.1052): "Recommended" on Auto and
/// "Default" on the mode a new session in this workspace starts in, which the phone reads from
/// `sessions:getPermissionModeState` (`workspaceDefaultPermissionMode`, absent from an older host). A row the server
/// supplied itself (Nestor Cloud's Plan and Act) gets neither, as on the desktop.
final class NessyPermissionModeBadgeTests: XCTestCase {
    func testAutoIsRecommendedAndTheWorkspaceDefaultIsBadged() {
        let entries = PermissionMode.pickerEntries(for: nil, defaultMode: .plan)
        XCTAssertEqual(entries.filter(\.isRecommended).map(\.mode), [.auto])
        XCTAssertEqual(entries.filter(\.isDefault).map(\.mode), [.plan])
    }

    func testNoDefaultIsGuessedAndServerLabelledRowsGetNoBadge() throws {
        XCTAssertEqual(PermissionMode.pickerEntries(for: nil).filter(\.isDefault), [])
        let caps = try JSONDecoder().decode(ComposerCapabilities.self, from: Data("""
        {"permissions":{"modes":["plan","default"],"modeOptions":[
          {"mode":"plan","label":"Plan","shortLabel":"Plan","description":"Remote planning mode.","remoteModeId":"plan"},
          {"mode":"default","label":"Act","shortLabel":"Act","description":"Remote implementation mode.","remoteModeId":"act"}]}}
        """.utf8)).permissions
        let entries = PermissionMode.pickerEntries(for: caps, defaultMode: .plan)
        XCTAssertFalse(entries.contains { $0.isRecommended || $0.isDefault })
    }

    func testTheModeStateDecodesTheWorkspaceDefaultAndToleratesItsAbsence() throws {
        let withDefault = try JSONDecoder().decode(PermissionModeState.self, from: Data("""
        {"permissionMode":"plan","modeVersion":1,"changedAt":"2026-10-09T00:00:00Z","changedBy":"user","workspaceDefaultPermissionMode":"auto"}
        """.utf8))
        XCTAssertEqual(withDefault.workspaceDefaultPermissionMode, "auto")
        let older = try JSONDecoder().decode(PermissionModeState.self, from: Data("""
        {"permissionMode":"plan","modeVersion":1,"changedAt":"2026-10-09T00:00:00Z","changedBy":"user"}
        """.utf8))
        XCTAssertNil(older.workspaceDefaultPermissionMode)
    }
}
