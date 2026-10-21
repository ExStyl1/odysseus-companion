import Foundation

/// Mirrors the MVP-relevant fields of `Session` in
/// `packages/shared/src/protocol/dto.ts`.
public struct Session: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let workspaceId: String
    public let workspaceName: String
    public var name: String?
    public var preview: String?
    public var lastMessageAt: Double
    public var isProcessing: Bool
    public var isFlagged: Bool?
    public var permissionMode: String?
    public var sessionStatus: String?
    public var labels: [String]?
    public var hasUnread: Bool?
    /// NESSY DEVIATION (F15): how many permission requests this session is
    /// waiting on a human to answer. Derived on the server from its live
    /// pending-request map, so it cannot go stale against reality; optional so
    /// an older server that omits it reads as "not waiting".
    public var awaitingApprovalCount: Int?

    public var model: String?
    public var messageCount: Int?

    /// P6.575 — the session's effort pick, as the server persisted it
    /// (`Session.thinkingLevel` in `packages/shared/src/protocol/dto.ts`).
    ///
    /// A raw `String?` for the same reason `permissionMode` is: a Swift
    /// raw-value enum throws on a tier it does not know, and one unknown level
    /// would fail the decode of the entire session. Read it through
    /// {@link effortLevel}.
    public var thinkingLevel: String?

    /// UA12.138 — `hidden` on the wire DTO (`packages/shared/src/protocol/dto.ts`,
    /// `Session.hidden`: mini edit sessions and other rows the list must not
    /// show). Optional so an older server that omits it decodes as before.
    public var hidden: Bool?
    /// UA12.138 — `parentSessionId` on the wire DTO (the UA3.1 interface merge
    /// of `dto.ts`): when set, this session is a subtask or a Conductor child of
    /// that parent, not a row of its own. NOT `PermissionRequest.parentSessionId`
    /// — that one names the visible ancestor a hidden child's prompt is routed
    /// to (see `PermissionRequest.swift`); this one is a persisted board
    /// relationship on the session itself.
    public var parentSessionId: String?
    /// UA12.138 — `taskDraft` on the wire DTO (same UA3.1 merge): a Tasks
    /// Conductor generate-time draft orchestrator, deliberately NOT hidden and
    /// hidden from the board only until adopted.
    public var taskDraft: Bool?

    /// F15: is this session waiting on a human right now?
    public var isAwaitingApproval: Bool { (awaitingApprovalCount ?? 0) > 0 }

    /// UA12.138 — a board-internal row the session list must not show flat:
    /// a hidden session, a child (parentSessionId set) or an unadopted task
    /// draft. The desktop filters exactly these client-side
    /// (`apps/electron/src/renderer/components/app-shell/kanban/board-derive.ts`:
    /// a row is a tile only when `!parentSessionId && !isArchived && !hidden
    /// && !taskDraft`); the phone's flat list applies the same rule so every
    /// DAG child and "New task" draft stops appearing as a top-level row.
    public var isBoardInternal: Bool {
        hidden == true || parentSessionId != nil || taskDraft == true
    }

    /// P6.575 — the effort tier this session is on, or `nil` when the server
    /// sent none (the session is on the workspace default) or sent one this
    /// build does not know.
    public var effortLevel: ThinkingLevel? { ThinkingLevel.from(rawId: thinkingLevel) }

    public init(
        id: String,
        workspaceId: String,
        workspaceName: String,
        name: String? = nil,
        preview: String? = nil,
        lastMessageAt: Double,
        isProcessing: Bool,
        isFlagged: Bool? = nil,
        permissionMode: String? = nil,
        sessionStatus: String? = nil,
        labels: [String]? = nil,
        hasUnread: Bool? = nil,
        awaitingApprovalCount: Int? = nil,
        model: String? = nil,
        messageCount: Int? = nil,
        thinkingLevel: String? = nil,
        hidden: Bool? = nil,
        parentSessionId: String? = nil,
        taskDraft: Bool? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
        self.name = name
        self.preview = preview
        self.lastMessageAt = lastMessageAt
        self.isProcessing = isProcessing
        self.isFlagged = isFlagged
        self.permissionMode = permissionMode
        self.sessionStatus = sessionStatus
        self.labels = labels
        self.hasUnread = hasUnread
        self.awaitingApprovalCount = awaitingApprovalCount
        self.model = model
        self.messageCount = messageCount
        self.thinkingLevel = thinkingLevel
        self.hidden = hidden
        self.parentSessionId = parentSessionId
        self.taskDraft = taskDraft
    }
}
