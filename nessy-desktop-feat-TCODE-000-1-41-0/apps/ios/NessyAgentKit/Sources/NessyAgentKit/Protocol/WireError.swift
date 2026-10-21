import Foundation

/// Mirrors `ErrorCode` in `packages/shared/src/protocol/types.ts`.
/// Unknown wire values decode to `.unknown(rawValue)` instead of throwing,
/// so a client on an older build tolerates new server-side error codes.
///
/// That tolerance is what let this list fall EIGHT codes behind unnoticed
/// (P3.358): degrading is not the same as being current, and the parity guard
/// could not see this enum at all — `scripts/ios-wire-enum-parity.ts` discovered
/// only `String`-raw-value enums, and a case carrying an associated value
/// (`unknown(String)`) forbids a raw value. It reads both halves below by name
/// now, and checks them against each other as well as against TypeScript, so
/// adding a case in one place and not the other is caught on the TypeScript
/// side — where CI runs on every pipeline, rather than only when `apps/ios`
/// changes.
public enum ErrorCode: Equatable, Sendable {
    case handlerError
    case channelNotFound
    case authFailed
    case protocolVersionUnsupported
    case sessionNotIdle
    case sessionIdConflict
    case artifactNotPortable
    case transferTooLarge
    case transferTimeout
    case transferVerificationFailed
    case requestTimeout
    case capabilityUnavailable
    case clientDisconnected
    case clientRequestTimeout
    case browserNoCapableClient
    case browserInstanceNotOwned
    case browserRemoteUploadNotSupported
    case browserRemoteEvaluateBlocked
    /// Refusals that exist SO THAT they can be translated: the server sends a
    /// code rather than an English sentence precisely because a renderer that
    /// can only show the server's own words gives a Russian-locale user
    /// something that reads as a malfunction (P2.464). Falling to `.unknown`
    /// here defeats the reason the codes were minted.
    case browserManagedDisabled
    /// P6.536, and the same reason as the line above: the DevTools debugger was
    /// refused for an origin — an administrator locked CDP off, the user denied
    /// the origin, or there was no way to ask — and its navigation twin below is
    /// a separate code because the next step differs.
    case browserCdpDenied
    /// P6.536 — a navigation the per-origin trust store refused.
    case browserOriginDenied
    case modelRestrictedByPolicy
    /// Runtime switching. Each says which precondition failed, and each has a
    /// different next step, which is why they are not one code.
    case sessionBusy
    case connectionNotSwitchable
    case connectionInUse
    case worktreeExitUnavailable
    case worktreeDirty
    case runtimeUnhostable
    /// P6.498 — the operator requires the built-in gateway sign-in, so a
    /// personal-key or BYO connection cannot be created or edited. Host-side
    /// and runtime-blind. Mirrored for the same reason as the translated
    /// refusals above: falling to `.unknown` turns an explainable policy
    /// refusal into the generic "something went wrong".
    case connectionGatewayOnly
    /// UA12.149 — a project's stored folder no longer has the identity that
    /// was bound (moved, replaced, or its `config.json` edited on disk);
    /// `createSession({ projectId })` refuses rather than start a session
    /// elsewhere. The lowercase-dashed break from this list's
    /// SCREAMING_SNAKE convention is deliberate on the TypeScript side too —
    /// the refusal's readers compare case-sensitively.
    case projectFolderIdentityChanged
    case unknown(String)

    private static let wireMap: [String: ErrorCode] = [
        "HANDLER_ERROR": .handlerError,
        "CHANNEL_NOT_FOUND": .channelNotFound,
        "AUTH_FAILED": .authFailed,
        "PROTOCOL_VERSION_UNSUPPORTED": .protocolVersionUnsupported,
        "SESSION_NOT_IDLE": .sessionNotIdle,
        "SESSION_ID_CONFLICT": .sessionIdConflict,
        "ARTIFACT_NOT_PORTABLE": .artifactNotPortable,
        "TRANSFER_TOO_LARGE": .transferTooLarge,
        "TRANSFER_TIMEOUT": .transferTimeout,
        "TRANSFER_VERIFICATION_FAILED": .transferVerificationFailed,
        "REQUEST_TIMEOUT": .requestTimeout,
        "CAPABILITY_UNAVAILABLE": .capabilityUnavailable,
        "CLIENT_DISCONNECTED": .clientDisconnected,
        "CLIENT_REQUEST_TIMEOUT": .clientRequestTimeout,
        "BROWSER_NO_CAPABLE_CLIENT": .browserNoCapableClient,
        "BROWSER_INSTANCE_NOT_OWNED": .browserInstanceNotOwned,
        "BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED": .browserRemoteUploadNotSupported,
        "BROWSER_REMOTE_EVALUATE_BLOCKED": .browserRemoteEvaluateBlocked,
        "BROWSER_MANAGED_DISABLED": .browserManagedDisabled,
        "BROWSER_CDP_DENIED": .browserCdpDenied,
        "BROWSER_ORIGIN_DENIED": .browserOriginDenied,
        "MODEL_RESTRICTED_BY_POLICY": .modelRestrictedByPolicy,
        "SESSION_BUSY": .sessionBusy,
        "CONNECTION_NOT_SWITCHABLE": .connectionNotSwitchable,
        "CONNECTION_IN_USE": .connectionInUse,
        "WORKTREE_EXIT_UNAVAILABLE": .worktreeExitUnavailable,
        "WORKTREE_DIRTY": .worktreeDirty,
        "RUNTIME_UNHOSTABLE": .runtimeUnhostable,
        "CONNECTION_GATEWAY_ONLY": .connectionGatewayOnly,
        "project-folder-identity-changed": .projectFolderIdentityChanged,
    ]

    /// NESSY DEVIATION (F14-UI): public so a test can build any code — including
    /// one this build has never seen — and assert the UI still says something.
    public init(wireValue: String) {
        self = Self.wireMap[wireValue] ?? .unknown(wireValue)
    }

    /// NESSY DEVIATION (F14-UI): made public so the app can print the code in
    /// small print beside a human message instead of dumping the whole type.
    public var wireValue: String {
        switch self {
        case .handlerError: return "HANDLER_ERROR"
        case .channelNotFound: return "CHANNEL_NOT_FOUND"
        case .authFailed: return "AUTH_FAILED"
        case .protocolVersionUnsupported: return "PROTOCOL_VERSION_UNSUPPORTED"
        case .sessionNotIdle: return "SESSION_NOT_IDLE"
        case .sessionIdConflict: return "SESSION_ID_CONFLICT"
        case .artifactNotPortable: return "ARTIFACT_NOT_PORTABLE"
        case .transferTooLarge: return "TRANSFER_TOO_LARGE"
        case .transferTimeout: return "TRANSFER_TIMEOUT"
        case .transferVerificationFailed: return "TRANSFER_VERIFICATION_FAILED"
        case .requestTimeout: return "REQUEST_TIMEOUT"
        case .capabilityUnavailable: return "CAPABILITY_UNAVAILABLE"
        case .clientDisconnected: return "CLIENT_DISCONNECTED"
        case .clientRequestTimeout: return "CLIENT_REQUEST_TIMEOUT"
        case .browserNoCapableClient: return "BROWSER_NO_CAPABLE_CLIENT"
        case .browserInstanceNotOwned: return "BROWSER_INSTANCE_NOT_OWNED"
        case .browserRemoteUploadNotSupported: return "BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED"
        case .browserRemoteEvaluateBlocked: return "BROWSER_REMOTE_EVALUATE_BLOCKED"
        case .browserManagedDisabled: return "BROWSER_MANAGED_DISABLED"
        case .browserCdpDenied: return "BROWSER_CDP_DENIED"
        case .browserOriginDenied: return "BROWSER_ORIGIN_DENIED"
        case .modelRestrictedByPolicy: return "MODEL_RESTRICTED_BY_POLICY"
        case .sessionBusy: return "SESSION_BUSY"
        case .connectionNotSwitchable: return "CONNECTION_NOT_SWITCHABLE"
        case .connectionInUse: return "CONNECTION_IN_USE"
        case .worktreeExitUnavailable: return "WORKTREE_EXIT_UNAVAILABLE"
        case .worktreeDirty: return "WORKTREE_DIRTY"
        case .runtimeUnhostable: return "RUNTIME_UNHOSTABLE"
        case .connectionGatewayOnly: return "CONNECTION_GATEWAY_ONLY"
        case .projectFolderIdentityChanged: return "project-folder-identity-changed"
        case .unknown(let raw): return raw
        }
    }
}

extension ErrorCode: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ErrorCode(wireValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wireValue)
    }
}

/// Mirrors `WireError` in `packages/shared/src/protocol/types.ts`.
public struct WireError: Codable, Equatable, Sendable {
    public let code: ErrorCode
    public let message: String
    public let data: JSONValue?

    public init(code: ErrorCode, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}
