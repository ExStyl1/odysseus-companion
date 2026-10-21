// apps/ios/NessyMobile/NessyMobile/Chat/MessageBubble.swift
import SwiftUI
import NessyAgentKit

/// Renders user messages as compact bubbles and assistant output as a document
/// surface, matching the desktop hierarchy without copying its chrome.
struct MessageBubble: View {
    let message: ChatMessage

    private var isUser: Bool { message.role == .user }

    @ViewBuilder
    var body: some View {
        switch message.role {
        case .user where message.isTaskNotification:
            // UB12.44 — F1.351: the host delivered this between turns; the user
            // never typed it, so it is not drawn as their bubble.
            TaskNotificationLine(content: message.content)
        case .user:
            content
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .frame(maxWidth: 620, alignment: .trailing)
                .background(
                    NessyTheme.accent.opacity(0.13),
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
        case .plan:
            semanticCard(
                title: "Plan",
                systemImage: "list.bullet.clipboard",
                color: .green
            )
        case .error:
            semanticCard(
                title: "Error",
                systemImage: "exclamationmark.octagon.fill",
                color: .red
            )
        case .warning:
            semanticCard(
                title: "Warning",
                systemImage: "exclamationmark.triangle.fill",
                color: .orange
            )
        case .status, .info:
            // The runtime-switch marker is machine-readable and must never
            // reach the screen as itself. Before this arm the row rendered
            // `runtime_switched:pi:anthropic` verbatim inside an "Information"
            // card. Drawn as a boundary rule rather than a notice card, for the
            // reason the desktop draws it that way: it marks a BOUNDARY in the
            // conversation, and a mixed transcript — one runtime's tool rows
            // above, another's below — reads as a rendering bug without it.
            if let notice = MessageBubble.switchNotice(for: message) {
                runtimeSwitchDivider(notice)
            } else {
                semanticCard(
                    title: message.role == .status ? "Status" : "Information",
                    systemImage: message.role == .status ? "clock" : "info.circle.fill",
                    color: NessyTheme.accent
                )
            }
        case .authRequest:
            semanticCard(
                title: "Authentication required",
                systemImage: "key.fill",
                color: .orange
            )
        default:
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 2)
        }
    }

    private var content: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
            if let attachments = message.attachments, !attachments.isEmpty {
                ForEach(attachments) { attachment in
                    AttachmentThumbnail(attachment: attachment)
                }
            }
            if !message.content.isEmpty {
                MarkdownText(markdown: message.content)
            }
        }
        .textSelection(.enabled)
    }

    /// Whether this row is the switch marker rather than an ordinary notice.
    ///
    /// A `static func` and not an inline condition so the ROUTING decision is
    /// testable without a view hierarchy — the branch that decides whether a
    /// transcript row keeps its card is the half of this feature a compile
    /// cannot check. Scoped to `.info` because that is the role the server
    /// writes the marker under; a `.status` row is somebody else's row and
    /// keeps its card whatever its text says.
    static func switchNotice(for message: ChatMessage) -> RuntimeSwitchNotice? {
        guard message.role == .info else { return nil }
        return RuntimeSwitchNotice(markerContent: message.content)
    }

    /// The switch notice: two hairlines around the sentence the marker was
    /// standing in for. The sentence names what crossed when the marker says so
    /// — a whole conversation, a text summary and a resumed thread are three
    /// different events, and a row that persists forever should not call them
    /// the same thing.
    private func runtimeSwitchDivider(_ notice: RuntimeSwitchNotice) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Rectangle()
                .fill(NessyTheme.hairline)
                .frame(height: 1)
            HStack(spacing: 5) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.caption2)
                Text(notice.localizedText)
                    .font(.caption)
                    .multilineTextAlignment(.center)
            }
            .foregroundStyle(.secondary)
            .layoutPriority(1)
            Rectangle()
                .fill(NessyTheme.hairline)
                .frame(height: 1)
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func semanticCard(title: String, systemImage: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
            content
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(color.opacity(0.18))
        }
    }
}

/// UB12.44 — F1.351's background-task notification, drawn as the desktop draws
/// it (`TaskNotificationLine` in
/// `apps/electron/src/renderer/components/app-shell/task-notification-line.tsx`):
/// a LABELLED SYSTEM LINE — what it is and where it came from — with the
/// notification body, the text inside the `<task-notification>` block, behind a
/// disclosure. Not the user's bubble, and not hidden: the model reacts to it, so
/// hiding it would leave that reaction unexplained (controller, 2026-09-23).
struct TaskNotificationLine: View {
    let content: String

    var body: some View {
        DisclosureGroup {
            Text(ChatMessage.taskNotificationBody(content))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        } label: {
            // The desktop's `chat.taskNotification.label`; ru in Localizable.strings.
            Text("Background task notification — delivered by the app, not typed by you")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Shows a persisted attachment: an image (from its base64 thumbnail) or a
/// labeled chip for non-image files.
struct AttachmentThumbnail: View {
    let attachment: StoredAttachment

    var body: some View {
        if attachment.isImage, let image = decodedImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(maxWidth: 200, maxHeight: 200)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            Label(attachment.name, systemImage: icon)
                .font(.caption)
                .padding(6)
                .background(Color.secondary.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private var decodedImage: UIImage? {
        guard let base64 = attachment.thumbnailBase64,
              let data = Data(base64Encoded: base64) else { return nil }
        return UIImage(data: data)
    }

    private var icon: String {
        switch attachment.type {
        case "pdf": return "doc.richtext"
        case "office": return "doc.text"
        case "audio": return "waveform"
        case "text": return "doc.plaintext"
        default: return "doc"
        }
    }
}

/// A pending (not-yet-sent) attachment shown in the input area, with a remove
/// button. Images render from the picked bytes (`FileAttachment.base64`).
struct PendingAttachmentChip: View {
    let attachment: FileAttachment
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            content
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.white, .black.opacity(0.6))
            }
            .padding(2)
        }
    }

    @ViewBuilder
    private var content: some View {
        if attachment.type == .image, let image = decodedImage {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            VStack(spacing: 2) {
                Image(systemName: "doc")
                Text(attachment.name).lineLimit(1).font(.caption2)
            }
            .frame(width: 60, height: 60)
            .background(Color.secondary.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var decodedImage: UIImage? {
        guard let base64 = attachment.base64,
              let data = Data(base64Encoded: base64) else { return nil }
        return UIImage(data: data)
    }
}
