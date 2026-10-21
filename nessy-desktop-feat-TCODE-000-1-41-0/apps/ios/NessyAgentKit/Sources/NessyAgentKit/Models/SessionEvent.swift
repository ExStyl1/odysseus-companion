import Foundation

/// Mirrors the MVP-relevant subset of the `SessionEvent` discriminated union
/// in `packages/shared/src/protocol/dto.ts`. Decoding an unrecognized `type`
/// yields `.unknown(type)` rather than throwing, so the client tolerates
/// server-side additions without a matching app release.
public enum SessionEvent: Equatable, Sendable {
    case textDelta(sessionId: String, delta: String, turnId: String?)
    case textComplete(sessionId: String, text: String)
    /// UA12.139 — `text_discard` (`SessionTextDiscardEvent`,
    /// `packages/shared/src/protocol/dto.ts`): the Pi adapter's verdict that a
    /// failed attempt's streamed text is void. The host cancels that turn's
    /// pending delta batch before forwarding it (never flushing failed text
    /// after the discard), so the client drops the still-streaming partial of
    /// `turnId` instead of letting the retry append to it. Ported from
    /// craft-agents-oss v0.13.4 (Apache-2.0).
    case textDiscard(sessionId: String, turnId: String)
    /// F1.436 — `toolDisplayName` / `toolDisplayMeta` ride the `tool_start` variant
    /// of `dto.ts`; both optional, so an older host decodes as before.
    case toolStart(
        sessionId: String, toolName: String, toolUseId: String, toolInput: [String: JSONValue],
        toolDisplayName: String? = nil, toolDisplayMeta: ToolDisplayMeta? = nil
    )
    case toolResult(sessionId: String, toolUseId: String, toolName: String, result: String, isError: Bool?)
    case errorEvent(sessionId: String, error: String)
    case complete(sessionId: String)
    case status(sessionId: String, message: String)
    case permissionRequest(sessionId: String, request: PermissionRequest)
    case credentialRequest(sessionId: String, request: CredentialRequest)
    case permissionModeChanged(sessionId: String, permissionMode: String)
    case sessionModelChanged(sessionId: String, model: String?)
    case connectionChanged(sessionId: String, connectionSlug: String, supportsBranching: Bool?)
    case capabilitiesChanged(sessionId: String, capabilities: ComposerCapabilities)
    case userMessage(sessionId: String, message: ChatMessage, status: String)
    case messageAdded(sessionId: String, message: ChatMessage)
    case sessionCreated(sessionId: String)
    case sessionDeleted(sessionId: String)
    case nameChanged(sessionId: String, name: String?)
    case sessionStatusChanged(sessionId: String, sessionStatus: String)
    case unknown(String)
}

extension SessionEvent: Codable {
    private enum CodingKeys: String, CodingKey {
        case type, sessionId, delta, turnId, text, toolName, toolUseId, toolInput
        case toolDisplayName, toolDisplayMeta
        case result, isError, error, message, statusType, request, status
        case name, sessionStatus, permissionMode, model
        case connectionSlug, supportsBranching, capabilities
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId) ?? ""

        switch type {
        case "text_delta":
            self = .textDelta(
                sessionId: sessionId,
                delta: try container.decode(String.self, forKey: .delta),
                turnId: try container.decodeIfPresent(String.self, forKey: .turnId)
            )
        case "text_complete":
            self = .textComplete(sessionId: sessionId, text: try container.decode(String.self, forKey: .text))
        case "text_discard":
            // `{ type: 'text_discard'; sessionId; turnId }` — `turnId` is
            // required on this variant (it is optional on `text_delta`).
            self = .textDiscard(
                sessionId: sessionId,
                turnId: try container.decode(String.self, forKey: .turnId)
            )
        case "tool_start":
            self = .toolStart(
                sessionId: sessionId,
                toolName: try container.decode(String.self, forKey: .toolName),
                toolUseId: try container.decode(String.self, forKey: .toolUseId),
                toolInput: try container.decodeIfPresent([String: JSONValue].self, forKey: .toolInput) ?? [:],
                toolDisplayName: try container.decodeIfPresent(String.self, forKey: .toolDisplayName),
                // A malformed meta degrades to the wire name; it never drops the tool row.
                toolDisplayMeta: (try? container.decodeIfPresent(ToolDisplayMeta.self, forKey: .toolDisplayMeta)) ?? nil
            )
        case "tool_result":
            self = .toolResult(
                sessionId: sessionId,
                toolUseId: try container.decode(String.self, forKey: .toolUseId),
                toolName: try container.decode(String.self, forKey: .toolName),
                result: try container.decode(String.self, forKey: .result),
                isError: try container.decodeIfPresent(Bool.self, forKey: .isError)
            )
        case "error":
            self = .errorEvent(sessionId: sessionId, error: try container.decode(String.self, forKey: .error))
        case "complete":
            self = .complete(sessionId: sessionId)
        case "status":
            self = .status(sessionId: sessionId, message: try container.decode(String.self, forKey: .message))
        case "permission_request":
            self = .permissionRequest(
                sessionId: sessionId,
                request: try container.decode(PermissionRequest.self, forKey: .request)
            )
        case "credential_request":
            self = .credentialRequest(
                sessionId: sessionId,
                request: try container.decode(CredentialRequest.self, forKey: .request)
            )
        case "permission_mode_changed":
            self = .permissionModeChanged(
                sessionId: sessionId,
                permissionMode: try container.decode(String.self, forKey: .permissionMode)
            )
        case "session_model_changed":
            self = .sessionModelChanged(
                sessionId: sessionId,
                model: try container.decodeIfPresent(String.self, forKey: .model)
            )
        // `{ type, sessionId, connectionSlug, supportsBranching? }`
        // (`packages/shared/src/protocol/dto.ts:468`). This is the only event
        // that names the session's active integration, so it is what keeps the
        // model picker's integration row honest after a switch.
        case "connection_changed":
            self = .connectionChanged(
                sessionId: sessionId,
                connectionSlug: try container.decode(String.self, forKey: .connectionSlug),
                supportsBranching: try container.decodeIfPresent(Bool.self, forKey: .supportsBranching)
            )
        // `{ type, sessionId, capabilities }` (`dto.ts:491`). Only the
        // `connection` half is modelled — see `ComposerCapabilities`.
        case "capabilities_changed":
            self = .capabilitiesChanged(
                sessionId: sessionId,
                capabilities: try container.decode(ComposerCapabilities.self, forKey: .capabilities)
            )
        case "user_message":
            self = .userMessage(
                sessionId: sessionId,
                message: try container.decode(ChatMessage.self, forKey: .message),
                status: try container.decode(String.self, forKey: .status)
            )
        // `{ type, sessionId, message }` (`packages/shared/src/protocol/dto.ts:505`).
        // A whole `Message` appended to the transcript with no turn behind it —
        // the runtime-switch notice is its first producer. Without this case the
        // event fell to `.unknown` and the row was DROPPED, so the boundary only
        // appeared on the next transcript load.
        case "message_added":
            self = .messageAdded(
                sessionId: sessionId,
                message: try container.decode(ChatMessage.self, forKey: .message)
            )
        case "session_created":
            self = .sessionCreated(sessionId: sessionId)
        case "session_deleted":
            self = .sessionDeleted(sessionId: sessionId)
        case "name_changed":
            self = .nameChanged(sessionId: sessionId, name: try container.decodeIfPresent(String.self, forKey: .name))
        case "session_status_changed":
            self = .sessionStatusChanged(
                sessionId: sessionId,
                sessionStatus: try container.decode(String.self, forKey: .sessionStatus)
            )
        default:
            self = .unknown(type)
        }
    }

    public func encode(to encoder: Encoder) throws {
        // The client never re-encodes a SessionEvent onto the wire (it only
        // sends explicit RPC requests) — this satisfies `Codable` for
        // symmetry/testability but is not on any real send path.
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .textDelta(let sessionId, let delta, let turnId):
            try container.encode("text_delta", forKey: .type)
            try container.encode(sessionId, forKey: .sessionId)
            try container.encode(delta, forKey: .delta)
            try container.encodeIfPresent(turnId, forKey: .turnId)
        default:
            try container.encode("unknown", forKey: .type)
        }
    }
}
