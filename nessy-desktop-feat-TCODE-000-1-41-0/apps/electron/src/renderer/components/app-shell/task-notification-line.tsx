/**
 * F1.351 — a background-task notification the HOST delivered between turns, drawn
 * as a LABELLED SYSTEM LINE rather than as the user's own bubble.
 *
 * `SessionManager.flushPendingTaskNotifications` starts a turn whose "message" is
 * `buildTaskNotificationDelivery(...)` — a `<system-reminder>` frame plus a
 * `<task-notification>` block — and the transcript stores it as a user entry,
 * because that is what the model received. Before this row the renderer drew it
 * as an ordinary user bubble: the user saw words they never typed, with both
 * hyphenated tags printed literally (`wrapWithSafeProxy` turns an unknown tag
 * into text).
 *
 * DECIDED by the controller (2026-09-23, the transparent rule): a labelled
 * system line — WHAT it is and WHERE it came from — not a user bubble and NOT
 * hidden. Upstream (craft-agents-oss v0.13.4) hides it; hiding would leave the
 * model's reaction to it inexplicable to the user. The host marks the entry
 * (`Message.taskNotification`); this file draws it: the label as the summary of
 * a native disclosure, and the notification body — the text inside the
 * `<task-notification>` block, without the framing — behind it.
 *
 * UB14.18 — on v0.15.1's language the summary is a transcript status row (the
 * 28px, 13px secondary row `MessageBubble` gives a status line; a chevron in the
 * 16px icon slot that turns when open, a bell for "the host told the agent"),
 * and the body hangs under the work log's inset hairline in the tertiary ink.
 * Still the native disclosure: no state, keyboard and screen readers for free.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BellDot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ROW_ICON_SIZE, ROW_ICON_SLOT, WORK_LOG_BODY } from './transcript-card-chrome'

const OPEN = '<task-notification>'
const CLOSE = '</task-notification>'

/**
 * The body the host wrapped: the text between the `<task-notification>` tags,
 * trimmed. A content that does not carry the block (a future framing, a legacy
 * row) is returned whole rather than guessed at.
 */
export function taskNotificationBody(content: string): string {
  const open = content.indexOf(OPEN)
  const close = content.lastIndexOf(CLOSE)
  if (open < 0 || close <= open) return content
  return content.slice(open + OPEN.length, close).trim()
}

export function TaskNotificationLine({ content }: { content: string }) {
  const { t } = useTranslation()
  return (
    <details className="group/notification min-w-0" data-task-notification="">
      <summary
        className={cn(
          'flex min-h-7 min-w-0 cursor-pointer list-none select-none items-center gap-2 rounded-sm text-label text-secondary',
          'hover:text-foreground focus-visible:-outline-offset-2 [&::-webkit-details-marker]:hidden',
        )}
      >
        <span className={cn(ROW_ICON_SLOT, 'text-tertiary transition-transform duration-fast ease-out-subtle group-open/notification:rotate-90')}>
          <ChevronRight aria-hidden className={ROW_ICON_SIZE} />
        </span>
        <span className={cn(ROW_ICON_SLOT, 'text-tertiary')}>
          <BellDot aria-hidden className={ROW_ICON_SIZE} />
        </span>
        <span className="min-w-0 truncate">{t('chat.taskNotification.label')}</span>
      </summary>
      <div className={cn(WORK_LOG_BODY, 'mb-1')}>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words py-1 font-sans text-label-sm text-tertiary">
          {taskNotificationBody(content)}
        </pre>
      </div>
    </details>
  )
}
