import Foundation

/// Mirrors `PermissionRequestType`/`PermissionRequest` in
/// `packages/core/src/types/message.ts`.
/// NESSY DEVIATION (M1). Two changes, both measured rather than assumed.
///
/// 1. **Four cases were missing.** This fork's `PermissionRequestType`
///    (`packages/core/src/types/message.ts`) had nine values at the time;
///    upstream's enum had five. It has since grown a tenth, `worktree_setup`,
///    which this mirror learned only after the fact — see
///    `scripts/ios-wire-enum-parity.test.ts`, the check that now fails when
///    the two lists disagree, because nothing did. An eleventh,
///    `worktree_cleanup`, arrived the same way and was caught BY that check
///    rather than after the fact (P6.723) — which is the difference the guard
///    was built to make.
/// 2. **A missing case broke the WHOLE request, not one field.** A Swift
///    `String`-raw-value `Codable` enum throws on an unknown value, and an
///    Optional property does not rescue it — `decodeIfPresent` still throws
///    `DataCorrupted` when the string matches no case. Probed against the
///    vendored code: decoding `{"type":"outside_root"}` failed with
///    *"Cannot initialize PermissionRequestType from invalid String value
///    outside_root"*, so the approval sheet — the reason this app exists —
///    would simply never appear for those requests.
///
/// Hence both the added cases AND `unknown`: the enum must survive a value
/// this build has never heard of, because the desktop ships on its own cadence.
public enum PermissionRequestType: String, Codable, Sendable, CaseIterable {
    case bash
    case fileWrite = "file_write"
    case mcpMutation = "mcp_mutation"
    case apiMutation = "api_mutation"
    case adminApproval = "admin_approval"
    case workflowLaunch = "workflow_launch"
    case worktreeApproval = "worktree_approval"
    /// A `worktree.setupScript` awaiting consent. Its OWN type on purpose: the
    /// string is a ROUTE, and reusing `workflow_launch` would show a workflow's
    /// name-and-phase consent for a shell command (`22d71972b`).
    case worktreeSetup = "worktree_setup"
    /// P6.135's close-time keep-or-remove question. Its OWN type for the same
    /// reason `worktree_setup` is: the desktop card drops Always Allow and the
    /// destructive tone, because here "deny" is the SAFE half — the directory
    /// and the branch stay. A build that decodes it as `.unknown` cannot tell
    /// that apart from an ordinary allow/deny approval (P6.723).
    case worktreeCleanup = "worktree_cleanup"
    case askUser = "ask_user"
    case outsideRoot = "outside_root"
    /// F1.914 — the card a readable permission rule's `ask` raises on the Pi
    /// runtime (the Pi agent's PreToolUse gate). The desktop sent this value
    /// before any declaration named it, so this build decoded it as `unknown`
    /// and still opened a generic approval. Named now so the value survives;
    /// no screen switches on it, and the card offers no Always Allow
    /// (`noAlwaysAllow` rides the request).
    case permissionDsl = "permission_dsl"
    /// Any value a newer desktop sends. Renders as a generic approval rather
    /// than discarding the request.
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PermissionRequestType(rawValue: raw) ?? .unknown
    }
}

public struct PermissionRequest: Codable, Equatable, Sendable {
    public let requestId: String
    public let toolName: String
    public var command: String?
    public let description: String
    public var type: PermissionRequestType?
    public var appName: String?
    public var reason: String?
    public var impact: String?
    public var requiresSystemPrompt: Bool?
    public var rememberForMinutes: Int?

    // NESSY DEVIATION (M1). Fields this fork sends that upstream's model had no
    // place for. The first two change BEHAVIOUR and are not cosmetic.

    /// This approval covers one action and must not offer an always-allow
    /// choice. Ignoring it means offering a button the server refuses to
    /// honour — the sheet must hide it.
    public var noAlwaysAllow: Bool?
    /// The VISIBLE session a prompt must surface in when the session that
    /// raised it is a hidden child. A client that ignores this attaches the
    /// prompt to a session the user cannot see, which reads as "no prompt
    /// arrived" — the same silent failure a renamed channel produces.
    public var parentSessionId: String?
    /// Display label for the subagent that raised it.
    public var agentLabel: String?
    /// Server-side integrity binding; the device echoes nothing and may ignore it.
    public var commandHash: String?
    /// Server-side approval validity window; informational on the device.
    public var approvalTtlSeconds: Int?

    public init(
        requestId: String,
        toolName: String,
        command: String? = nil,
        description: String,
        type: PermissionRequestType? = nil,
        appName: String? = nil,
        reason: String? = nil,
        impact: String? = nil,
        requiresSystemPrompt: Bool? = nil,
        rememberForMinutes: Int? = nil,
        noAlwaysAllow: Bool? = nil,
        parentSessionId: String? = nil,
        agentLabel: String? = nil,
        commandHash: String? = nil,
        approvalTtlSeconds: Int? = nil
    ) {
        self.requestId = requestId
        self.toolName = toolName
        self.command = command
        self.description = description
        self.type = type
        self.appName = appName
        self.reason = reason
        self.impact = impact
        self.requiresSystemPrompt = requiresSystemPrompt
        self.rememberForMinutes = rememberForMinutes
        self.noAlwaysAllow = noAlwaysAllow
        self.parentSessionId = parentSessionId
        self.agentLabel = agentLabel
        self.commandHash = commandHash
        self.approvalTtlSeconds = approvalTtlSeconds
    }
}

extension PermissionRequest: Identifiable {
    public var id: String { requestId }
}

extension PermissionRequest {
    /// Whether the approval sheet may offer *Always Allow* — the desktop's two
    /// rules, in the one place both the sheet and a runnable test can read
    /// (P6.727).
    ///
    /// `apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest.tsx`
    /// gates its own button on `request.noAlwaysAllow !== true && !isWorktreeCleanup`.
    /// Two different reasons with the same answer:
    ///
    /// 1. `noAlwaysAllow` is the server saying it will not honour a standing
    ///    grant for this one action — the field's own docblock above says *the
    ///    sheet must hide it*, and offering the button promises something no
    ///    side performs.
    /// 2. A `worktree_cleanup` decision is about ONE worktree at ONE close. An
    ///    "always remove" would be a standing instruction to delete
    ///    directories, which is the posture P6.135 deliberately did not take.
    ///
    /// It lives on the MODEL rather than inside the SwiftUI view so that
    /// `swift test` can execute it. `NessyMobile` has no test target that runs
    /// on a machine without a working simulator, and a behavioural rule nothing
    /// can execute is exactly the shape this fork's silent divergences take.
    ///
    /// `.unknown` — a type a newer desktop sent that this build has never heard
    /// of — is deliberately NOT gated: the sheet renders it as an ordinary
    /// approval, and hiding the button for every future type would withdraw a
    /// working choice on the strength of not recognising a string. When such a
    /// type must not be remembered, the server says so with `noAlwaysAllow`,
    /// which is the field that exists for it.
    public var canAlwaysAllow: Bool {
        noAlwaysAllow != true && type != .worktreeCleanup
    }
}
