import XCTest
@testable import NessyAgentKit

final class SessionEventDecodingTests: XCTestCase {
    func testDecodesTextDelta() throws {
        let json = Data("""
        {"type": "text_delta", "sessionId": "s1", "delta": "Hello"}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .textDelta(let sessionId, let delta, _) = event else {
            return XCTFail("expected .textDelta, got \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(delta, "Hello")
    }

    func testDecodesPermissionRequest() throws {
        let json = Data("""
        {
          "type": "permission_request",
          "sessionId": "s1",
          "request": {
            "requestId": "req-1",
            "toolName": "Bash",
            "command": "rm -rf /tmp/x",
            "description": "Delete a temp file"
          }
        }
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .permissionRequest(let sessionId, let request) = event else {
            return XCTFail("expected .permissionRequest, got \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(request.requestId, "req-1")
        XCTAssertEqual(request.command, "rm -rf /tmp/x")
    }

    // T14. Without these two cases both events fell to `.unknown`, so the
    // integration row could never learn that the session had moved.
    func testDecodesConnectionChanged() throws {
        let json = Data("""
        {"type":"connection_changed","sessionId":"s1","connectionSlug":"claude-gateway","supportsBranching":true}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .connectionChanged(let sessionId, let connectionSlug, let supportsBranching) = event else {
            return XCTFail("fell through to \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(connectionSlug, "claude-gateway")
        XCTAssertEqual(supportsBranching, true)
    }

    func testDecodesCapabilitiesChanged() throws {
        // The real payload carries far more than `connection`; the unmodelled
        // keys must be ignored rather than fail the decode.
        let json = Data("""
        {"type":"capabilities_changed","sessionId":"s1","capabilities":{
          "connection":{"switchable":true,"activeRuntime":"codex-runtime"},
          "attachments":{"images":false},"permissions":{"modes":["default"]}}}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .capabilitiesChanged(let sessionId, let capabilities) = event else {
            return XCTFail("fell through to \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(capabilities.connection?.switchable, true)
        XCTAssertEqual(capabilities.connection?.activeRuntime, "codex-runtime")
        // F1.1069: the permissions half is modelled now — the picker renders from it.
        XCTAssertEqual(capabilities.permissions?.modes, ["default"])
    }

    // Negative subject: the two new cases must not swallow their neighbours.
    // A `case` added to the wrong arm of that switch would still pass the two
    // rows above.
    func testAnAdjacentSessionEventStillDecodesToItsOwnCase() throws {
        let json = Data("""
        {"type":"session_model_changed","sessionId":"s1","model":"gpt-5.3-codex"}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .sessionModelChanged(_, let model) = event else {
            return XCTFail("expected .sessionModelChanged, got \(event)")
        }
        XCTAssertEqual(model, "gpt-5.3-codex")
    }

    /// `message_added` carries a whole `Message` for a row the server appended
    /// with no turn behind it. Until it was decoded the event fell to
    /// `.unknown`, so the live runtime-switch row was DROPPED and the boundary
    /// only appeared on the next transcript load.
    func testDecodesMessageAdded() throws {
        let json = Data("""
        {"type":"message_added","sessionId":"s1","message":{"id":"m-9","role":"info","content":"runtime_switched:pi:anthropic:{\\"carry\\":\\"native\\"}","timestamp":1750000000000}}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .messageAdded(let sessionId, let message) = event else {
            return XCTFail("fell through to \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(message.id, "m-9")
        XCTAssertEqual(message.role, .info)
        // The row reaches the client as the MARKER, not as prose: the sentence
        // is composed at render time so a durable row is not frozen in the
        // language it was written in.
        XCTAssertEqual(RuntimeSwitchNotice(markerContent: message.content)?.carry, .native)
    }

    // F1.436 — the phone showed every tool's raw wire name: `tool_start` carries
    // `toolDisplayName` and `toolDisplayMeta` (`packages/shared/src/protocol/dto.ts`,
    // the `tool_start` variant) and neither was decoded. The desktop row reads
    // "Spawn Session" for this very event.
    func testDecodesToolStartDisplayFields() throws {
        let json = Data("""
        {"type":"tool_start","sessionId":"s1","toolName":"mcp__session__spawn_session","toolUseId":"t1",
         "toolInput":{},"toolDisplayName":"Spawn a helper",
         "toolDisplayMeta":{"displayName":"Spawn Session","category":"native","description":"d"}}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .toolStart(_, let toolName, _, _, let displayName, let meta) = event else {
            return XCTFail("fell through to \(event)")
        }
        XCTAssertEqual(toolName, "mcp__session__spawn_session")
        XCTAssertEqual(displayName, "Spawn a helper")
        XCTAssertEqual(meta?.displayName, "Spawn Session")
        XCTAssertEqual(meta?.category, "native")
    }

    func testToolStartWithoutDisplayFieldsStillDecodes() throws {
        // Negative: an older host sends neither field; a malformed meta must not
        // drop the whole tool row either — it degrades to the wire name.
        for json in [
            #"{"type":"tool_start","sessionId":"s1","toolName":"Bash","toolUseId":"t1","toolInput":{}}"#,
            #"{"type":"tool_start","sessionId":"s1","toolName":"Bash","toolUseId":"t1","toolDisplayMeta":{"nope":1}}"#,
        ] {
            let event = try JSONDecoder().decode(SessionEvent.self, from: Data(json.utf8))
            guard case .toolStart(_, let toolName, _, _, let displayName, let meta) = event else {
                return XCTFail("fell through to \(event)")
            }
            XCTAssertEqual(toolName, "Bash")
            XCTAssertNil(displayName)
            XCTAssertNil(meta)
        }
    }

    // F1.436 — the title resolver, in the desktop's order (`formatToolDisplay`,
    // packages/ui TurnCard): the host's meta name, a native tool's own display
    // name over it, an MCP source's tool slug after it, and the raw name last.
    func testToolDisplayTitleFollowsTheDesktopOrder() {
        let meta = ToolDisplayMeta(displayName: "Spawn Session", category: "native")
        XCTAssertEqual(ToolDisplayMeta.title(toolName: "mcp__session__spawn_session", toolDisplayName: nil, toolDisplayMeta: meta), "Spawn Session")
        XCTAssertEqual(ToolDisplayMeta.title(toolName: "Read", toolDisplayName: "Read Config", toolDisplayMeta: ToolDisplayMeta(displayName: "Read", category: "native")), "Read Config")
        XCTAssertEqual(ToolDisplayMeta.title(toolName: "mcp__linear__create_issue", toolDisplayName: nil, toolDisplayMeta: ToolDisplayMeta(displayName: "Linear", category: "source")), "Linear: create_issue")
        XCTAssertEqual(ToolDisplayMeta.title(toolName: "mcp__sources__linear__create_issue", toolDisplayName: nil, toolDisplayMeta: ToolDisplayMeta(displayName: "Linear", category: "source")), "Linear: create_issue")
        XCTAssertEqual(ToolDisplayMeta.title(toolName: "Bash", toolDisplayName: "List Files", toolDisplayMeta: nil), "List Files")
        // CONTROL — nothing but the wire name: the wire name, as before.
        XCTAssertEqual(ToolDisplayMeta.title(toolName: "Bash", toolDisplayName: nil, toolDisplayMeta: nil), "Bash")
        XCTAssertEqual(ToolDisplayMeta.title(toolName: nil, toolDisplayName: nil, toolDisplayMeta: nil), "Tool")
    }

    func testTranscriptMessageDecodesDisplayFields() throws {
        // A reloaded transcript carries the same two fields on the stored `Message`.
        let json = Data("""
        {"id":"t1","role":"tool","content":"","timestamp":1,"toolName":"mcp__session__spawn_session",
         "toolDisplayMeta":{"displayName":"Spawn Session","category":"native"}}
        """.utf8)
        let message = try JSONDecoder().decode(ChatMessage.self, from: json)
        XCTAssertEqual(message.toolDisplayTitle, "Spawn Session")
    }

    func testUnknownEventTypeDoesNotThrow() throws {
        // Forward-compat: packages/shared/src/protocol/dto.ts has 46 SessionEvent
        // variants; MVP only models a subset. New server-side variants must not
        // crash the client.
        let json = Data("""
        {"type": "workflow_agent_completed", "sessionId": "s1", "workflowId": "w1", "agentId": "a1"}
        """.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .unknown(let type) = event else {
            return XCTFail("expected .unknown, got \(event)")
        }
        XCTAssertEqual(type, "workflow_agent_completed")
    }

    /// UA12.139 — `text_discard` previously fell to `.unknown`, so a voided
    /// partial stream stayed on screen until the next `text_complete`. The
    /// variant carries a REQUIRED `turnId` (unlike `text_delta`, where it is
    /// optional) — `SessionTextDiscardEvent`, dto.ts.
    func testTextDiscardDecodesWithItsTurnId() throws {
        let json = Data(#"{"type": "text_discard", "sessionId": "s1", "turnId": "t1"}"#.utf8)
        let event = try JSONDecoder().decode(SessionEvent.self, from: json)
        guard case .textDiscard(let sessionId, let turnId) = event else {
            return XCTFail("expected .textDiscard, got \(event)")
        }
        XCTAssertEqual(sessionId, "s1")
        XCTAssertEqual(turnId, "t1")
    }
}
