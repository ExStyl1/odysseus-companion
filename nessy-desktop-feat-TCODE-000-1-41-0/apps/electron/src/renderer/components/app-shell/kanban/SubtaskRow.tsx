/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/SubtaskRow.tsx
   (craft-agents-oss, Apache-2.0) by UA2.4, 2026-10-02. Manifest row UA3.6, moved to UA2.4 by O11 (the
   controller's pin, 2026-10-02): TaskTile imports it; inert before Phase 3 (no session has
   subtasks). One import adapted: `Spinner` comes from `@nessy-agent/ui/ui/LoadingIndicator`
   (the same component the `@nessy-agent/ui` barrel re-exports), as `chat/AuthRequestCard.tsx`
   does — the barrel's graph ends at a Vite-only pdfjs worker specifier bun's test runner
   cannot load, which would keep every board render out of `bun test`.
   UA12.46 (Nessy divergence, reason (c): our gateway aliases — upstream's `DEFAULT_MODEL` is an Anthropic
   model a Nessy Gateway workspace does not serve): a row with no model (nothing names one —
   board-derive.ts) shows no ModelChip, where upstream's rows always carried `DEFAULT_MODEL`.
   UA12.69 (Nessy): the chip reads the row's resolved connection (`KanbanSubtask.connection`,
   board-derive.ts) like the tile's own chip does, so a gateway alias's name and icon come from the
   SAME connection — before, the name read "Coder" over the no-connection Anthropic default icon.
   UA12.77 (Nessy, spec §11 item 2): a row whose session waits on a card shows the tile's needs-input mark,
   compact (the icon, the tile badge's label as its name), before the model chip.
   UB14.60 (R2-16), 2026-10-16 — v0.15.1's glyph and row hunks (changed in v0.15.0): one shape per run state in the
   solved roles (done = success check, running = the accent working mark, pending = the quiet ring, failed = the
   destructive cross), the 24px row with the fill-hover hover, the secondary/tertiary title. The UA12.77 needs-input
   mark keeps the "needs you" role (info) and takes the tile's mark (v0.15.1's session-row Hand) at the glyph size. */
import { CheckCircle2, Circle, Hand, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { cn } from '@/lib/utils'
import { ModelChip } from './ModelChip'
import type { KanbanSubtask, SubtaskRunState } from './types'

/**
 * Run-state glyph for a spawned subtask (design spec §2.4 vocabulary): done (success check),
 * running (the working mark in accent), pending (quiet ring), failed (destructive cross).
 * Each state has its own shape, so state is never carried by color alone.
 */
function RunStateIcon({ runState }: { runState: SubtaskRunState }) {
  const { t } = useTranslation()
  switch (runState) {
    case 'done':
      return <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-label={t('common.done')} />
    case 'running':
      return <Spinner className="shrink-0 text-label text-accent" />
    case 'failed':
      return <XCircle className="size-3.5 shrink-0 text-destructive" strokeWidth={2} aria-label={t('common.failed')} />
    case 'pending':
    default:
      return <Circle className="size-3.5 shrink-0 text-tertiary" strokeWidth={1.5} aria-label={t('common.pending')} />
  }
}

interface SubtaskRowProps {
  subtask: KanbanSubtask
  className?: string
  /** When set, the row becomes a button that opens the subtask's session window. */
  onClick?: () => void
}

/** UA12.77 — the needs-input mark of a row: TaskTile's `NeedsInputBadge` label, icon only. */
function SubtaskNeedsInput({ waitingOn }: { waitingOn?: KanbanSubtask['waitingOn'] }) {
  const { t } = useTranslation()
  const label =
    waitingOn?.type === 'ask_user'
      ? t('session.attention.waitingOnQuestion')
      : waitingOn?.toolName
        ? t('session.attention.waitingOn', { prompt: waitingOn.toolName })
        : t('session.attention.waiting')
  return (
    <span role="status" title={label} aria-label={label} data-kanban-subtask-needs-input="" className="shrink-0 text-info">
      <Hand className="size-3.5" aria-hidden />
    </span>
  )
}

/** One spawned-subtask row: run-state icon + title + the model it was routed to. */
export function SubtaskRow({ subtask, className, onClick }: SubtaskRowProps) {
  const isDone = subtask.runState === 'done'
  const interactive = !!onClick
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={
        interactive
          ? e => {
              e.stopPropagation()
              onClick?.()
            }
          : undefined
      }
      onKeyDown={
        interactive
          ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        'flex min-h-6 items-center gap-2 py-0.5',
        interactive &&
          '-mx-1 cursor-pointer rounded-sm px-1 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant',
        className
      )}
    >
      <RunStateIcon runState={subtask.runState} />
      <span className={cn('flex-1 truncate text-label-sm', isDone ? 'text-tertiary line-through' : 'text-secondary')}>
        {subtask.title}
      </span>
      {subtask.needsInput && <SubtaskNeedsInput waitingOn={subtask.waitingOn} />}
      {subtask.model && <ModelChip model={subtask.model} connection={subtask.connection} short className="w-20 shrink-0" />}
    </div>
  )
}
