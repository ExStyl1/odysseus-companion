import Foundation

/// Mirrors `MessageRole` in `packages/core/src/types/message.ts`.
public enum MessageRole: String, Codable, Sendable {
    case user
    case assistant
    case tool
    case error
    case status
    case info
    case warning
    case plan
    case authRequest = "auth-request"
}

/// Mirrors the MVP-relevant fields of `Message` in
/// `packages/core/src/types/message.ts`.
public struct ChatMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public var role: MessageRole
    public var content: String
    public var timestamp: Double
    public var toolName: String?
    /// F1.436 — the model's own name for this call (`Message.toolDisplayName`).
    public var toolDisplayName: String?
    /// F1.436 — the host's display metadata (`Message.toolDisplayMeta`).
    public var toolDisplayMeta: ToolDisplayMeta?
    public var toolUseId: String?
    public var toolInput: [String: JSONValue]?
    public var toolResult: String?
    public var toolStatus: String?
    public var toolDuration: Double?
    public var parentToolUseId: String?
    public var isError: Bool?
    public var isStreaming: Bool?
    public var attachments: [StoredAttachment]?
    /// UB12.44 — UB2.14's `Message.hidden` (`packages/core/src/types/message.ts`):
    /// the host sent this row to the model (it drives a turn) but it never draws
    /// as a transcript bubble. The one producer today is the source-activation
    /// auto-retry, whose text restates a message the user already sees. `true`
    /// or absent on the wire; see `rendersInTranscript`.
    public var hidden: Bool?
    /// UB12.44 — F1.351's `Message.taskNotification`: a background-task
    /// notification the HOST delivered between turns, stored as a `user` entry
    /// because the model received it as one, though the user never typed it.
    /// Drawn as a labelled system line, not the user's bubble and not hidden;
    /// see `isTaskNotification`. `true` or absent on the wire.
    public var taskNotification: Bool?

    public init(
        id: String,
        role: MessageRole,
        content: String,
        timestamp: Double,
        toolName: String? = nil,
        toolDisplayName: String? = nil,
        toolDisplayMeta: ToolDisplayMeta? = nil,
        toolUseId: String? = nil,
        toolInput: [String: JSONValue]? = nil,
        toolResult: String? = nil,
        toolStatus: String? = nil,
        toolDuration: Double? = nil,
        parentToolUseId: String? = nil,
        isError: Bool? = nil,
        isStreaming: Bool? = nil,
        attachments: [StoredAttachment]? = nil,
        hidden: Bool? = nil,
        taskNotification: Bool? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.toolName = toolName
        self.toolDisplayName = toolDisplayName
        self.toolDisplayMeta = toolDisplayMeta
        self.toolUseId = toolUseId
        self.toolInput = toolInput
        self.toolResult = toolResult
        self.toolStatus = toolStatus
        self.toolDuration = toolDuration
        self.parentToolUseId = parentToolUseId
        self.isError = isError
        self.isStreaming = isStreaming
        self.attachments = attachments
        self.hidden = hidden
        self.taskNotification = taskNotification
    }
}

// MARK: - UB12.44: which rows a transcript draws, and how

extension ChatMessage {
    /// Whether this row draws in the transcript at all. Mirrors the desktop,
    /// which drops `Message.hidden` rows before grouping a transcript
    /// (`groupMessagesByTurn` in `packages/ui/src/components/chat/turn-utils.ts`).
    /// The row stays in the conversation's state — it is history the model
    /// read — and only its drawing is skipped.
    public var rendersInTranscript: Bool { hidden != true }

    /// The rows a transcript draws, in their order: every row but a hidden one.
    public static func transcriptRows(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter(\.rendersInTranscript)
    }

    /// A `user` entry the host delivered as a background-task notification
    /// (F1.351). The desktop draws it as a labelled system line
    /// (`TaskNotificationLine` in
    /// `apps/electron/src/renderer/components/app-shell/task-notification-line.tsx`),
    /// never as the user's own bubble.
    public var isTaskNotification: Bool { role == .user && taskNotification == true }

    private static let taskNotificationOpen = "<task-notification>"
    private static let taskNotificationClose = "</task-notification>"

    /// The body the host wrapped: the text between the `<task-notification>`
    /// tags, trimmed — the desktop's `taskNotificationBody`. A content that does
    /// not carry the block (a future framing, a legacy row) comes back whole
    /// rather than guessed at.
    public static func taskNotificationBody(_ content: String) -> String {
        guard let open = content.range(of: taskNotificationOpen),
              let close = content.range(of: taskNotificationClose, options: .backwards),
              close.lowerBound >= open.upperBound
        else { return content }
        return String(content[open.upperBound..<close.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
