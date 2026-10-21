/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/chat-display/MessageBubble.tsx (UB14.14; ADDED in v0.15.0).
 * Taken, then OUR hunks re-applied (UB14.14 Keep, each marked where it sits): F1.351 the task-notification
 * line before the user branch; `MemoryContextMenu` around the user and assistant branches (save to memory,
 * rewind to the ANCHOR id, C3.384); `workspaceId` + `onAttachmentOpen` (UA's session attachments); the
 * runtime-switch marker, redrawn in the compaction divider's style; the P2.37 terminal-reason notice;
 * P6.712/P6.731 `infoNoticeLayout`; and the memo comparator's two handler props.
 */
import * as React from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftRight, CheckCircle2, CircleAlert, ExternalLink, Info, TriangleAlert } from "lucide-react"
import { Spinner, UserMessageBubble } from "@nessy-agent/ui"
import { cn } from "@/lib/utils"
import { IconButton } from "@/components/ui/button"
import { Markdown, CollapsibleMarkdownProvider, StreamingMarkdown, type RenderMode } from "@/components/markdown"
import { parseTerminalReasonMarker, terminalReasonNoticeKey } from "@/lib/terminal-reason-copy"
import type { Message } from "../../../../shared/types"
import { parseRuntimeSwitchMarker, runtimeSwitchNoticeKey } from "../input/runtime-switch-copy"
import { infoNoticeLayout } from "../ChatDisplay.info-notice"
import { rewindAnchorId } from "../rewind-menu"
import { TaskNotificationLine } from "../task-notification-line" // F1.351
import { ErrorMessage } from "./ErrorMessage"
import { MemoryContextMenu, type SaveToMemoryHandler } from "./MemoryContextMenu"

/**
 * MessageBubble - Renders a single message based on its role
 *
 * Message Roles & Styles:
 * - user:      Right-aligned bubble (UserMessageBubble)
 * - assistant: Plain copy on the transcript, markdown rendered with clickable links
 * - error:     Inline error marker (destructive tint + 2px rule) with collapsible details
 * - status:    Live-line style row with the working spinner
 * - info:      One-line notice; compaction and a runtime switch render as a labelled divider
 * - warning:   Inline marker on the info tint
 *
 * Note: Tool messages are rendered by TurnCard, not MessageBubble
 */
export interface MessageBubbleProps {
  message: Message
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  sessionId?: string
  /** Ours: with `sessionId`, lets a user attachment open through the host (`openSessionAttachment`). */
  workspaceId?: string
  /**
   * Markdown render mode for assistant messages
   * @default 'minimal'
   */
  renderMode?: RenderMode
  /**
   * Callback to pop out message into a separate window
   */
  onPopOut?: (message: Message) => void
  /** Compact mode - reduces padding for popover embedding */
  compactMode?: boolean
  /** Callback to resend the user message that preceded an error */
  onRetry?: () => void
  /** Ours: save selected or full message text to MEMORY.md. */
  onSaveToMemory?: SaveToMemoryHandler
  /** Ours: rewind the conversation to this message. */
  onRewindMessage?: (messageId: string, restoreFiles: boolean) => Promise<void> | void
}

/** Info-level notices: icon shape + role color per level (status never by color alone). */
const INFO_LEVELS = {
  info: { icon: Info, className: 'text-secondary', iconClassName: 'text-tertiary' },
  warning: { icon: TriangleAlert, className: 'text-info', iconClassName: 'text-info' },
  error: { icon: CircleAlert, className: 'text-destructive', iconClassName: 'text-destructive' },
  success: { icon: CheckCircle2, className: 'text-success', iconClassName: 'text-success' },
} as const

export function MessageBubble({
  message,
  onOpenFile,
  onOpenUrl,
  sessionId,
  workspaceId,
  renderMode = 'minimal',
  onPopOut,
  compactMode,
  onRetry,
  onSaveToMemory,
  onRewindMessage,
}: MessageBubbleProps) {
  const { t } = useTranslation()

  // F1.351 — a background-task notification the HOST delivered between turns
  // (`flushPendingTaskNotifications`) is stored as a user entry because the model
  // received it as one, but the user never typed it. DECIDED by the controller
  // (2026-09-23): a LABELLED SYSTEM LINE, not the user's bubble and not hidden.
  if (message.role === 'user' && message.taskNotification) {
    return <TaskNotificationLine content={message.content} />
  }

  // === USER MESSAGE: Right-aligned bubble with attachments above ===
  if (message.role === 'user') {
    return (
      <MemoryContextMenu
        content={message.content}
        onSaveToMemory={onSaveToMemory}
        // C3.384 — the ANCHOR id, the same translation the rewind menu makes.
        // This is the OTHER way into `handleRewindConversation` and it carried
        // the identical defect: the optimistic id the server has never seen.
        onRewind={onRewindMessage
          ? (restoreFiles) => onRewindMessage(rewindAnchorId(message), restoreFiles)
          : undefined}
      >
        <UserMessageBubble
          content={message.content}
          attachments={message.attachments}
          badges={message.badges}
          isPending={message.isPending}
          isQueued={message.isQueued}
          onUrlClick={onOpenUrl}
          onFileClick={onOpenFile}
          onAttachmentOpen={sessionId && workspaceId
            ? handleId => void window.electronAPI.openSessionAttachment({
                session: { sessionId, workspaceId },
                handleId,
              })
            : undefined}
          compactMode={compactMode}
        />
      </MemoryContextMenu>
    )
  }

  // === ASSISTANT MESSAGE: plain copy with markdown rendering ===
  if (message.role === 'assistant') {
    return (
      <MemoryContextMenu content={message.content} onSaveToMemory={onSaveToMemory}>
        <div className="group relative min-w-0 select-text break-words text-copy text-foreground">
          {/* Pop-out button - visible on hover */}
          {onPopOut && !message.isStreaming && (
            <IconButton
              aria-label={t("sidebarMenu.openInNewWindow")}
              tooltip
              size="sm"
              icon={<ExternalLink />}
              onClick={() => onPopOut(message)}
              data-touch-reveal="true"
              className="absolute right-0 top-0 opacity-0 transition-opacity duration-micro ease-out-subtle group-hover:opacity-100 group-hover:duration-instant focus-visible:opacity-100"
            />
          )}
          {/* Use StreamingMarkdown for block-level memoization during streaming */}
          {message.isStreaming ? (
            <StreamingMarkdown
              content={message.content}
              isStreaming={true}
              mode={renderMode}
              onUrlClick={onOpenUrl}
              onFileClick={onOpenFile}
            />
          ) : (
            <CollapsibleMarkdownProvider>
              <Markdown
                mode={renderMode}
                onUrlClick={onOpenUrl}
                onFileClick={onOpenFile}
                id={message.id}
                collapsible
              >
                {message.content}
              </Markdown>
            </CollapsibleMarkdownProvider>
          )}
        </div>
      </MemoryContextMenu>
    )
  }

  // === ERROR MESSAGE: inline error marker with collapsible technical details ===
  if (message.role === 'error') {
    return <ErrorMessage message={message} onOpenUrl={onOpenUrl} sessionId={sessionId} onRetry={onRetry} />
  }

  // === STATUS MESSAGE: matches the live line (ProcessingIndicator) ===
  if (message.role === 'status') {
    return (
      <div className="flex min-h-7 min-w-0 items-center gap-2 text-label text-secondary">
        <span className="flex size-4 shrink-0 items-center justify-center">
          <Spinner className="text-caption text-accent" />
        </span>
        <span className="min-w-0 truncate">{message.content}</span>
      </div>
    )
  }

  // === INFO MESSAGE: Icon and color based on level ===
  if (message.role === 'info') {
    // Compaction complete message - render as horizontal rule with centered label
    // This persists after reload to show where context was compacted
    if (message.statusType === 'compaction_complete') {
      return (
        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-separator" />
          <span className="select-none text-label-sm text-tertiary">
            {t('chat.conversationCompacted')}
          </span>
          <div className="h-px flex-1 bg-separator" />
        </div>
      )
    }

    // Ours — the runtime-switch marker. The server writes a machine-readable
    // `runtime_switched:<from>:<to>` (it has no i18n and must survive a
    // language change), and the human copy is composed here. Rendered as a
    // rule rather than a notice line for the same reason `compaction_complete`
    // is, and in that divider's material: it marks a BOUNDARY in the
    // conversation, and a mixed transcript — one runtime's tool rows above,
    // another's below — reads as a rendering bug without it.
    //
    // R1 · the line also names WHAT CROSSED, chosen from the marker's own JSON
    // tail. A marker with no tail — every row written before R1 — falls back
    // to the plain sentence, which is why `runtimeSwitchNoticeKey` has a
    // default arm.
    const switchMarker = parseRuntimeSwitchMarker(message.content)
    if (switchMarker) {
      return (
        <div className="my-4 flex items-center gap-3" data-runtime-switch-marker="">
          <div className="h-px flex-1 bg-separator" />
          <span className="flex min-w-0 select-none items-center gap-1.5 text-center text-label-sm text-tertiary">
            <ArrowLeftRight aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0">{t(runtimeSwitchNoticeKey(switchMarker.carry), switchMarker)}</span>
          </span>
          <div className="h-px flex-1 bg-separator" />
        </div>
      )
    }

    // Ours — P2.37 · the turn's terminal verdict. Stored as
    // `terminal_reason:<reason>` for the same reason the switch marker is
    // stored machine-readable — the sentence is composed here, from
    // `chat.terminalReason.*`, so it follows the UI language. A marker this
    // build has no copy for renders NOTHING rather than leaking the enum value
    // into the transcript. The row itself is the ordinary notice line below,
    // with `infoLevel` (set from `terminalIsError`) picking the tone.
    const terminalReason = parseTerminalReasonMarker(message.content)
    const terminalNoticeKey = terminalReason ? terminalReasonNoticeKey(terminalReason) : undefined
    if (terminalReason && !terminalNoticeKey) return null
    const infoContent = terminalNoticeKey ? t(terminalNoticeKey) : message.content

    const config = INFO_LEVELS[message.infoLevel || 'info']
    const Icon = config.icon

    // Ours — P6.712: a seam answer (`/help`, `/mcp`, `/diff`) is a LIST and keeps
    // its lines; P6.731: and can then be copied. See `ChatDisplay.info-notice.ts`
    // for why both the pre-wrap and the select rule are conditional.
    const noticeLayout = infoNoticeLayout(infoContent)

    return (
      <div className={cn('flex min-h-7 min-w-0 gap-2 text-label', noticeLayout.rowSelectClassName, noticeLayout.rowAlignClassName, config.className)}>
        <span className={noticeLayout.iconClassName}>
          <Icon aria-hidden className={cn('size-3.5', config.iconClassName)} />
        </span>
        <span className={noticeLayout.textClassName}>{infoContent}</span>
      </div>
    )
  }

  // === WARNING MESSAGE: inline marker on the info tint ===
  // C3.331 — the heading is our own chrome and goes through `t()`; v0.15.1
  // names the key `chat.warning`, which replaced our `chat.warningBubble.heading`.
  if (message.role === 'warning') {
    return (
      <div className="flex min-w-0 select-none gap-2.5 rounded-md border-l-2 border-info bg-info-tint px-3 py-2.5">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
        <div className="min-w-0 flex-1 break-words">
          <div className="text-label font-semibold text-info">{t('chat.warning')}</div>
          <p className="mt-0.5 text-label leading-5 text-foreground">{message.content}</p>
        </div>
      </div>
    )
  }

  return null
}

/**
 * MemoizedMessageBubble - Prevents re-renders of non-streaming messages
 *
 * During streaming, the entire message list gets updated on each delta.
 * This wrapper skips re-renders for messages that haven't changed,
 * significantly improving performance for long conversations.
 */
export const MemoizedMessageBubble = React.memo(MessageBubble, (prev, next) => {
  // Always re-render streaming messages (content is changing)
  if (prev.message.isStreaming || next.message.isStreaming) {
    return false
  }
  // Skip re-render if key props unchanged
  return (
    prev.message.id === next.message.id &&
    prev.message.content === next.message.content &&
    prev.message.role === next.message.role &&
    prev.sessionId === next.sessionId &&
    prev.compactMode === next.compactMode &&
    // Ours — the memory menu and the rewind entry are props of the bubble.
    prev.onSaveToMemory === next.onSaveToMemory &&
    prev.onRewindMessage === next.onRewindMessage
  )
})
