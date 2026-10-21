import * as React from 'react'
import { ArrowDown, ArrowUp, CornerDownRight, Pencil, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@nessy-agent/ui'
import type { QueuedMessageDto } from '@nessy-agent/shared/protocol'; import { isUnsteerableQueueRow } from './submit-control' // F1.481 — one line: this file is cited by line
import { IconButton } from '@/components/ui/button'
import { COMPOSER_META_CHIP } from './composer-styles'

/**
 * UB14.62 — the strip on the composer meta-chip material (R4-report, Message queue UI: "KEEP; restyle with the
 * FollowUpChips / COMPOSER_META_CHIP material"). Upstream v0.15.1 has no queue UI (B1), so this is our own surface
 * re-tokened: each row is `COMPOSER_STATIC_META_CHIP`'s raised fill and inset hairline in FollowUpChips' 28px
 * `rounded-md` row at `text-label`, the message on `text-secondary`; the row itself presses nothing (no
 * `motion-press`, which would scale it under a pressed child), its five verbs are named `IconButton`s with
 * tertiary icons, and Resume is the pressable meta chip itself. Behaviour is unchanged: F1.331 / F1.481 (2) Steer
 * and F1.339 Edit stay focusable with their reasons (`aria-disabled`), P6.51 reorder asks the server.
 */
const QUEUE_ROW = 'flex min-w-0 items-center gap-1.5 overflow-hidden rounded-md bg-raised py-0.5 pl-2.5 pr-0.5 ring-1 ring-inset ring-border'
/** IconButton has no aria-disabled arm: such a control keeps its tooltip (pointer events) and drops its hover and press tints. */
const QUEUE_ACTION = 'text-tertiary aria-disabled:cursor-default aria-disabled:text-disabled aria-disabled:hover:bg-transparent aria-disabled:hover:text-disabled aria-disabled:active:bg-transparent'
const QUEUE_ICON = 'size-3.5'

export interface QueuedMessageListProps {
  queue: QueuedMessageDto[]
  paused: boolean
  onSteer: (id: string) => void
  onEdit: (id: string, text: string) => void
  onDelete: (id: string) => void
  /**
   * P6.51 — move a queued message to `toIndex`. This is a REQUEST to the server,
   * not a local rearrangement: the authoritative order is
   * `ManagedSession.messageQueue`, drained by `shift()`, so the new order
   * arrives back through `queue_changed` like every other queue mutation. A
   * strip-local sort would change what the user sees and nothing about the send
   * order.
   */
  onReorder: (id: string, toIndex: number) => void
  onResume: () => void
}

// ponytail: drag-and-drop when queues get deep — the up/down pair below is the
// keyboard- and screen-reader-reachable half, and stays whatever dnd lands.
export function QueuedMessageList({
  queue,
  paused,
  onSteer,
  onEdit,
  onDelete,
  onReorder,
  onResume,
}: QueuedMessageListProps) {
  const { t } = useTranslation()

  if (queue.length === 0) return null

  return (
    <div data-slot="message-queue" className="mb-2 flex max-h-[30dvh] flex-col gap-1 overflow-y-auto overflow-x-hidden px-px">
      {paused && (
        <div className="flex min-w-0 items-center justify-between gap-2 pl-1">
          <span className="min-w-0 truncate text-label text-tertiary">{t('chat.queue.pausedBanner')}</span>
          <button type="button" onClick={onResume} className={cn(COMPOSER_META_CHIP, 'cursor-pointer')}>
            {t('chat.queue.resume')}
          </button>
        </div>
      )}

      <AnimatePresence initial={false}>
        {queue.map((m, index) => (
          <motion.div
            key={m.id}
            data-slot="queued-message"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className={QUEUE_ROW}
          >
            <span className="min-w-0 flex-1 truncate text-label text-secondary">
              {m.text || t('chat.queue.attachmentsOnly', { count: m.attachmentsCount })}
            </span>
            <span className="flex shrink-0 items-center gap-px">
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <IconButton
                    size="sm"
                    aria-label={t('chat.queue.steer')}
                    icon={<CornerDownRight className={QUEUE_ICON} />}
                    onClick={() => { if (!isUnsteerableQueueRow(m)) onSteer(m.id) }} aria-disabled={isUnsteerableQueueRow(m) || undefined} // F1.331 / F1.481 (2) — the host keeps such a row queued
                    className={QUEUE_ACTION}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-56 text-pretty"><span className="block font-medium">{t('chat.queue.steer')}</span>{m.attachmentsCount > 0 ? t('chat.queue.steerBlockedByFiles') : m.steerable === false ? t('chat.queue.steerBlockedWholeTurn') : t('chat.queue.steerTooltip')}</TooltipContent>
              </Tooltip>
              <IconButton
                size="sm"
                aria-label={t('chat.queue.moveUp')}
                tooltip
                icon={<ArrowUp className={QUEUE_ICON} />}
                // Disabled rather than hidden at the ends: a control that
                // disappears moves every other control under the pointer.
                disabled={index === 0}
                onClick={() => onReorder(m.id, index - 1)}
                className={QUEUE_ACTION}
              />
              <IconButton
                size="sm"
                aria-label={t('chat.queue.moveDown')}
                tooltip
                icon={<ArrowDown className={QUEUE_ICON} />}
                disabled={index === queue.length - 1}
                onClick={() => onReorder(m.id, index + 1)}
                className={QUEUE_ACTION}
              />
              {/*
                F1.339 — Edit puts back only the TEXT (it deletes the row and refills
                the composer), and a row's files cannot be handed back: the renderer
                holds a count, and the stored copies' paths are backend-only. So on a
                row with files Edit is disabled WITH its reason, left focusable
                (aria-disabled, not disabled) so the tooltip reaches the keyboard too.
              */}
              <Tooltip delayDuration={250}>
                <TooltipTrigger asChild>
                  <IconButton
                    size="sm"
                    aria-label={t('chat.queue.edit')}
                    icon={<Pencil className={QUEUE_ICON} />}
                    aria-disabled={m.attachmentsCount > 0 || undefined}
                    onClick={() => { if (m.attachmentsCount === 0) onEdit(m.id, m.text) }}
                    className={QUEUE_ACTION}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-56 text-pretty">
                  {m.attachmentsCount > 0 ? t('chat.queue.editBlockedByFiles') : t('chat.queue.edit')}
                </TooltipContent>
              </Tooltip>
              <IconButton
                size="sm"
                aria-label={t('chat.queue.delete')}
                tooltip
                icon={<Trash2 className={QUEUE_ICON} />}
                onClick={() => onDelete(m.id)}
                className={QUEUE_ACTION}
              />
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
