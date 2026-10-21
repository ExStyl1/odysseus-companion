import Foundation

/// P6.575 / P6.372 (the effort half) — the six-tier effort vocabulary, mirroring
/// `THINKING_LEVEL_IDS` in `packages/shared/src/agent/thinking-levels.ts`.
///
/// ## What was actually missing, measured at HEAD before this was written
///
/// The row said *"a per-session effort level cannot be set by any client,
/// because the only surface is the workspace setting"*. Half of that is refuted
/// by the tree:
///
///  - the **server** already has a session-scoped write —
///    `sessions:command` with `{ type: 'setThinkingLevel', level }`, validated in
///    `packages/server-core/src/handlers/rpc/sessions.ts` and applied by
///    `SessionManager.setSessionThinkingLevel`, which persists it and pushes it
///    onto the live agent;
///  - the **desktop** already binds to it (`App.tsx`, the composer's model
///    selector), so the composer half of the row's `done_means` is closed;
///  - the **read** already rides the session payload — `Session.thinkingLevel`
///    in `packages/shared/src/protocol/dto.ts`;
///  - the **phone** had nothing: `thinkingLevel` scored **0** occurrences under
///    `apps/ios` at HEAD.
///
/// So no new RPC was built. The owner's 2026-09-05 principle — take the
/// recommendation, integrate as simply as possible, less code because the
/// runtimes are upgraded often — points at the surface that already exists and
/// is already reachable from a remote client (`sessions:command` is on the
/// remote-allowed list in `packages/shared/src/protocol/routing.ts`). What is
/// added here is the client binding, and nothing else.
///
/// ## Why this is a raw `String` on `Session` and an enum only here
///
/// Same reason `Session.permissionMode` is a `String?`: a Swift raw-value
/// `Codable` enum THROWS on a value it does not know, so decoding the level
/// directly into this enum would let a seventh tier added on the server destroy
/// the decode of the whole session payload — the exact failure the permission
/// mode already suffered once (see `PermissionMode`'s own header). The wire
/// value stays a string; {@link ThinkingLevel.from(rawId:)} resolves it, and an
/// unknown tier reads as "no pick" rather than as a crash.
///
/// The ORDER is significant and mirrors the TypeScript list exactly: it is what
/// a picker renders, low to max. `off` is a real level, not an absence — it
/// means extended thinking disabled, and on the server it maps to a `null`
/// effort rather than to "use the default".
public enum ThinkingLevel: String, Codable, Sendable, CaseIterable {
    case off
    case low
    case medium
    case high
    case xhigh
    case max

    /// Low-to-max, mirroring `THINKING_LEVEL_IDS`, which that file's own comment
    /// calls the single source of truth and whose order it calls significant.
    public static var allCases: [ThinkingLevel] {
        [.off, .low, .medium, .high, .xhigh, .max]
    }

    /// The default a session gets when the workspace names none —
    /// `DEFAULT_THINKING_LEVEL` in `thinking-levels.ts`.
    public static let workspaceDefault: ThinkingLevel = .medium

    /// User-facing label. English here; the Russian pass is M4 (unlike
    /// `PermissionMode.displayName`, localized since F1.1069).
    public var displayName: String {
        switch self {
        case .off: return "Off"
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .xhigh: return "Extra High"
        case .max: return "Max"
        }
    }

    public var detail: String {
        switch self {
        case .off: return "No extended thinking"
        case .low: return "Light reasoning, faster replies"
        case .medium: return "Balanced speed and reasoning"
        case .high: return "Deep reasoning for complex work"
        case .xhigh: return "Extra-high reasoning"
        case .max: return "Maximum effort reasoning"
        }
    }

    /// Resolve a raw wire id. `nil` for an absent value AND for a tier this
    /// build does not know — see the header: an unknown level must not be able
    /// to fail a decode, and it must not be silently shown as some other level
    /// either.
    public static func from(rawId: String?) -> ThinkingLevel? {
        guard let rawId else { return nil }
        return ThinkingLevel(rawValue: rawId)
    }
}
