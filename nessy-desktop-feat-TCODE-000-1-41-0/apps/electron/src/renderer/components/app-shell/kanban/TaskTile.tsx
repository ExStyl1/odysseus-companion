/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/TaskTile.tsx
   (craft-agents-oss, Apache-2.0) by UA2.4, 2026-10-02. One adaptation: provider icons draw
   through `ProviderIconMark` (ModelChip.tsx), because our `getProviderIcon` returns a mono
   component or a URL, not upstream's URL string.
   Every upstream entry is set by its row's container: `onRunSubtasks` (Play) by UA4.4, `onEdit` (the
   Pencil and the right-click "Edit task") and `onAddSubtask` (the Plus composer) by UA3.6. The live
   pulse keys on `isProcessing` as upstream. UA4.4 (Nessy, spec §11 item 4): the woke-after-done badge
   beside the needs-input one (`task.wokeAfterDone`).
   UA2.5 (Nessy adaptations, spec §9): the needs-input badge beside the status badge
   (`task.needsInput`, the session list's own predicate; its label names the request
   with the list's `session.attention.*` copy), the runtime chip in the footer
   (`task.runtime`, absent for an unknown connection), and ModelChip's gateway fallback
   (`task.connection`).
   UA3.6 follow-up: the add-subtask composer's pick carries the connection of the group it was made
   under (`onAddSubtask`'s third argument), and the check shows under that group only — two gateway
   cards both list `coder` (`model-catalog.ts` adaptation 4).
   UA12.46 (Nessy divergence, reason (c): our gateway aliases — upstream's `DEFAULT_MODEL` is an Anthropic
   model a Nessy Gateway workspace does not serve): the footer's ModelChip renders only when the
   tile names a model (board-derive.ts resolves the one the session will run on), and the add-subtask composer
   starts from `initialSubtaskModel` (v0.13.4 L423) — the workspace default connection's model, else none — never `DEFAULT_MODEL`.
   UA12.21 (Nessy, keyboard drag): the card opens on Enter only — Space is the board's pick-up/drop key
   (`board-keyboard-drag.ts`; upstream opens on both) — and takes `describedBy`, the board's hidden drag instructions.
   UA12.21 follow-up: while the tile is being dragged (`dragging`) the card does not open on Enter — Enter then drops
   it (dnd-kit's end key), and focus stays on this card during a keyboard move.
   UB14.60 (R2-16), 2026-10-16 — v0.15.1's card (changed in v0.15.0) taken onto this copy: the raised card (radius 8,
   elev-1, the border-strong hover ring) and `dragOverlay` (elev-3, no hover ring; the board's overlay passes it); the
   "Working…" live line (the accent working mark), gated by the same live-pulse preference, in place of the column-colour
   glow and the badge ping; the meta row (workflow status · model … messages · age), whose status chip is skipped when
   the status equals the column's (`columnStatusId`, the board's `homeStatusId`); the corner pencil as an `IconButton`;
   the subtask list expanding in place (`AnimatedCollapsibleContent`); the add-subtask composer on the field material
   with a `Button` Add. `AnimatedCollapsibleContent` and `Spinner` come from their `@nessy-agent/ui/ui/*` subpaths
   (the barrel trap, as `SubtaskRow.tsx`). Re-applied, each named: UA2.5 — the needs-input mark is drawn as the card's
   run-state line in the "needs you" role (v0.15.1's session-row vocabulary: the Hand mark in info), ahead of the
   Working line (the session list's precedence), never gated by the live-pulse preference; its word, its
   `session.attention.*` label and `data-kanban-needs-input` are unchanged; the runtime chip and ModelChip's
   connection sit in the meta row on the neutral chip; UA4.4 — the woke-after-done mark is an info chip in the meta
   row; UA12.46 — no ModelChip without a model; UA3.6 — the composer's pick keeps its connection; UA12.21 — Enter only,
   `describedBy`, `dragging`; UA12.151 — `data-kanban-subtasks-toggle`. */
import * as React from 'react'
import { Check, ChevronDown, ChevronRight, Flag, Hand, MessageSquare, Pencil, Play, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { formatDistanceToNowStrict, type Locale } from 'date-fns'
import { AnimatedCollapsibleContent } from '@nessy-agent/ui/ui/AnimatedCollapsibleContent'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { getModelShortName } from '@config/models'
import { cn } from '@/lib/utils'
import { getProviderIcon, type ProviderIcon } from '@/lib/provider-icons'
import { shortTimeLocale } from '@/utils/session'
import { kanbanLivePulseAtom } from '@/atoms/kanban'
import { Button, IconButton } from '@/components/ui/button'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import type { SessionStatus } from '@/config/session-status-config'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
  StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import { StatusBadge } from './StatusBadge'
import { ModelChip, ProviderIconMark } from './ModelChip'
import { SubtaskRow } from './SubtaskRow'
import { SubtaskProgress } from './SubtaskProgress'
import { runtimeLabel } from '../input/runtime-switch-copy'
import type { KanbanModelProviderGroup, KanbanProject, KanbanTask } from './types'
import { checkedConnectionSlug, initialSubtaskModel } from './model-catalog'

/**
 * Brand icon for a provider key. Providers with a bundled SVG (anthropic,
 * openai) resolve directly; others (google, mistral, xai, groq, deepseek, …)
 * resolve through the Pi auth-provider path, which covers both the remaining
 * SVGs and the favicon fallback for icon-less providers.
 */
function resolveProviderIcon(provider: string): ProviderIcon | null {
  return getProviderIcon(provider) ?? getProviderIcon('pi', null, provider)
}

interface TaskTileProps {
  task: KanbanTask
  /** Project the task is bound to (colors the tile). */
  project?: KanbanProject
  /** Resolved status for the badge. */
  status?: SessionStatus
  /** Ordered workspace statuses for the status picker. */
  statuses?: SessionStatus[]
  /** Change this task's status. When set (with `statuses`), the badge opens a picker. */
  onStatusChange?: (statusId: string) => void
  /** How the project color is drawn. Mirrors the SessionList project-color treatment. */
  treatment: ProjectColorTreatment
  /** Whether the subtask list is expanded. */
  expanded: boolean
  /** Open the task (focused chat window). */
  onClick?: () => void
  /** Open the full-pane editor for this task (edit mode). Enables the right-click "Edit task" item. */
  onEdit?: () => void
  /** Toggle the subtask list. */
  onToggleSubtasks?: () => void
  /** Open a spawned subtask's session window. */
  onSubtaskClick?: (subtaskId: string) => void
  /** Spawn a new subtask from a typed title, routed to the chosen model (and the connection it was picked under). */
  onAddSubtask?: (title: string, model: string, connectionSlug?: string) => void
  /** Run all pending (created-but-not-yet-dispatched) subtasks. Shows the Play button when set. */
  onRunSubtasks?: () => void
  /** Provider→model catalog for the "Add subtask" composer's picker. */
  subtaskModelGroups?: KanbanModelProviderGroup[]
  /** Model id pre-selected in the composer (defaults to the first catalog model). */
  defaultSubtaskModel?: string
  /** UA12.21 — id of the board's screen-reader drag instructions (the card's `aria-describedby`). */
  describedBy?: string
  /** UA12.21 follow-up — the tile is being dragged: Enter is the drop key then, never the open action. */
  dragging?: boolean
  /** Rendered as the drag overlay clone: lifted to elev-3, no hover ring. */
  dragOverlay?: boolean
  /** The status the tile's column stands for. A card in its column's status skips the status chip,
   *  which would only repeat the column header; a card that differs keeps it. */
  columnStatusId?: string
}

/**
 * A parent-session ("Task") card (design spec §7.14): raised, radius 8, elev-1; title 13px 500; a
 * live line while a turn runs; then subtasks and a meta row (workflow status · model … messages ·
 * age). Hover strengthens the hairline (elev-1 + a border-strong ring), in instantly, out in 100ms.
 *
 * Project color is drawn directly on the card: a full-height 3px leading stripe
 * plus an optional ~6% tint (same `color-mix` formula as
 * `SessionProjectColorWrapper`, applied on the card because a tile is an opaque
 * surface rather than a transparent list row).
 */
export function TaskTile({
  task,
  project,
  status,
  statuses,
  onStatusChange,
  treatment,
  expanded,
  onClick,
  onEdit,
  onToggleSubtasks,
  onSubtaskClick,
  onAddSubtask,
  onRunSubtasks,
  subtaskModelGroups,
  defaultSubtaskModel,
  describedBy,
  dragging,
  dragOverlay = false,
  columnStatusId,
}: TaskTileProps) {
  const { t } = useTranslation()
  const livePulseEnabled = useAtomValue(kanbanLivePulseAtom)

  const color = project?.color ?? null
  const showStripe = !!color
  const showTint = !!color && treatment === 'stripe-tint'
  const subtaskCount = task.subtasks.length
  // Play runs a spec-backed task's whole DAG (pending rows count even without a session —
  // the Conductor creates them), but only dispatches session-backed rows on plain tiles.
  // Disabled while anything is in flight: a second Conductor run would be refused anyway.
  const hasRunningSubtasks = task.subtasks.some(s => s.runState === 'running')
  const canRunSubtasks =
    !hasRunningSubtasks &&
    !task.isProcessing &&
    task.subtasks.some(s => s.runState === 'pending' && (task.taskSlug ? true : !!s.sessionId))

  // Live treatment: an in-flight turn on a tile parked in the active column,
  // gated by the user's live-pulse preference. Drawn as the card's live line (spec §2.4: the
  // working mark in accent + "Working…"), never as a colored glow on the card.
  const isLive = livePulseEnabled && !!task.isProcessing && task.column === 'in-progress'

  const relativeTime = task.lastMessageAt
    ? formatDistanceToNowStrict(new Date(task.lastMessageAt), {
        locale: shortTimeLocale as Locale,
        roundingMethod: 'floor',
      })
    : null
  const hasMessages = typeof task.messageCount === 'number' && task.messageCount > 0

  const card = (
    <div
      role="button"
      tabIndex={0}
      aria-describedby={describedBy}
      onClick={onClick}
      onKeyDown={e => {
        // UA12.21 — Enter only: Space picks the tile up for a keyboard move (board-keyboard-drag.ts);
        // mid-move Enter is dnd-kit's drop, so the card stands down while it is being dragged.
        if (e.key === 'Enter' && !dragging) {
          e.preventDefault()
          onClick?.()
        }
      }}
      className={cn(
        'group relative overflow-hidden rounded-md bg-raised text-left',
        dragOverlay
          ? 'cursor-grabbing shadow-elev-3'
          : cn(
              'cursor-pointer shadow-elev-1',
              'transition-shadow duration-micro ease-out-subtle hover:ring-1 hover:ring-[color:var(--border-strong)] hover:duration-instant',
            )
      )}
    >
      {showTint && color && (
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 6%, transparent)` }}
          aria-hidden
        />
      )}
      {showStripe && color && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}

      {onEdit && (
        <IconButton
          size="sm"
          icon={<Pencil className="size-3.5" strokeWidth={2} />}
          aria-label={t('kanban.editTask')}
          tooltip
          data-no-dnd="true"
          data-touch-reveal="true"
          onClick={e => {
            e.stopPropagation()
            onEdit()
          }}
          onKeyDown={e => e.stopPropagation()}
          // Opaque over the title: hover tints via state-overlay instead of replacing the raised fill.
          // motion-press (IconButton) fades the opacity: in instantly with the card hover, out in 100ms.
          className="state-overlay absolute right-1.5 top-1.5 z-local bg-raised shadow-elev-1 opacity-0 hover:bg-raised active:bg-raised group-hover:opacity-100 group-hover:duration-instant focus-visible:opacity-100"
        />
      )}

      <div className="relative flex flex-col gap-2 px-3 py-2.5">
        {(project || task.isFlagged) && (
          // Right padding keeps the flag clear of the hover-revealed corner pencil (always shown in compact).
          <div
            className={cn(
              'flex items-center justify-between gap-2',
              onEdit && (task.isFlagged ? 'pr-7' : '@max-mobile/shell:pr-7')
            )}
          >
            {project ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 text-label-sm text-tertiary">
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: project.color }}
                  aria-hidden
                />
                <span className="truncate">{project.name}</span>
              </span>
            ) : (
              <span />
            )}
            {task.isFlagged && (
              <Flag className="size-3.5 shrink-0 fill-current text-info" role="img" aria-label={t('sidebar.flagged')} />
            )}
          </div>
        )}

        <div
          className={cn(
            'line-clamp-2 text-label font-medium',
            // First line of the card in compact, where the corner pencil is always shown: keep clear of it.
            onEdit && !project && !task.isFlagged && '@max-mobile/shell:pr-7',
            // Strike done/cancelled by *status* (not column — placement ≠ status).
            status?.category === 'closed' ? 'text-tertiary line-through' : 'text-foreground'
          )}
        >
          {task.title}
        </div>

        {/* The card's run-state line (the session row's vocabulary): "needs you" first (UA2.5, always shown),
            else the Working line (gated by the live-pulse preference). */}
        {task.needsInput ? (
          <NeedsInputLine waitingOn={task.waitingOn} />
        ) : (
          isLive && (
            <span data-kanban-working="" className="flex min-w-0 items-center gap-1.5 text-label-sm text-secondary">
              <Spinner className="shrink-0 text-label text-accent" />
              <span className="truncate">{t('session.runState.working')}</span>
            </span>
          )
        )}

        {(subtaskCount > 0 || onAddSubtask) && (
          <div>
            {subtaskCount > 0 && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-no-dnd="true"
                  // UA12.151 — the unambiguous expand target: the status picker's Radix trigger also
                  // carries aria-expanded and precedes this button, so `button[aria-expanded]` opens the
                  // status menu instead (SIT-D F1). Pinned by __tests__/board-dom-hooks.test.tsx.
                  data-kanban-subtasks-toggle=""
                  onClick={e => {
                    e.stopPropagation()
                    onToggleSubtasks?.()
                  }}
                  className="flex min-h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm text-tertiary transition-colors duration-micro ease-out-subtle hover:text-secondary hover:duration-instant"
                  aria-expanded={expanded}
                  aria-label={t('kanban.subtasks')}
                >
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 transition-transform duration-[var(--spring-snap-dur)] ease-[var(--spring-snap)]',
                      expanded && 'rotate-90'
                    )}
                    strokeWidth={2}
                  />
                  <SubtaskProgress subtasks={task.subtasks} total={task.subtaskTotal} className="min-w-0 flex-1" />
                </button>
                {onRunSubtasks && (
                  <button
                    type="button"
                    data-no-dnd="true"
                    onClick={e => {
                      e.stopPropagation()
                      onRunSubtasks()
                    }}
                    disabled={!canRunSubtasks}
                    title={t('kanban.runSubtasks')}
                    aria-label={t('kanban.runSubtasks')}
                    // No `disabled:pointer-events-none`: it would let clicks pass THROUGH the
                    // disabled button to the card underneath (which opens the session list).
                    // A disabled button that keeps pointer events swallows the click instead.
                    className="inline-grid size-control-sm shrink-0 place-items-center rounded-sm text-tertiary transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:text-foreground hover:duration-instant disabled:text-disabled disabled:hover:bg-transparent disabled:hover:text-disabled"
                  >
                    <Play className="size-3.5" strokeWidth={2} />
                  </button>
                )}
              </div>
            )}

            {/* Expand in place: the rows swap in once and fade with a 4px drop (no height animation) */}
            <AnimatedCollapsibleContent isOpen={expanded || subtaskCount === 0}>
              {/* Subtask rows indent under the toggle's chevron; a lone "Add subtask" starts on the text edge */}
              <div className={cn(subtaskCount > 0 && 'mt-1 pl-1')}>
                {task.subtasks.map(subtask => {
                  // Synthetic rows (spec nodes not yet run) have no session to open.
                  const sessionId = subtask.sessionId
                  return (
                    <SubtaskRow
                      key={subtask.id}
                      subtask={subtask}
                      onClick={onSubtaskClick && sessionId ? () => onSubtaskClick(sessionId) : undefined}
                    />
                  )
                })}
                {onAddSubtask && (
                  <AddSubtask
                    onAdd={onAddSubtask}
                    modelGroups={subtaskModelGroups}
                    defaultModel={defaultSubtaskModel}
                  />
                )}
              </div>
            </AnimatedCollapsibleContent>
          </div>
        )}

        {/* Meta row: workflow status · model … messages · age (wraps on narrow cards). Ours beside the status:
            the woke-after-done mark (UA4.4), then the runtime chip (UA2.5) before the model (UA12.46: only a named one). */}
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-label-sm text-tertiary">
          <div className="flex min-w-0 items-center gap-1.5">
            {status && status.id !== columnStatusId &&
              (onStatusChange && statuses && statuses.length > 0 ? (
                <StatusPicker
                  status={status}
                  statuses={statuses}
                  activeStateId={task.statusId}
                  onSelect={onStatusChange}
                />
              ) : (
                <StatusBadge status={status} />
              ))}
            {task.wokeAfterDone && (
              <span
                title={t('kanban.wokeAfterDoneHint')}
                data-kanban-woke-after-done=""
                className="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-xs bg-info-tint px-1.5 text-label-sm font-medium text-info"
              >
                {t('kanban.wokeAfterDone')}
              </span>
            )}
            {task.runtime && <RuntimeChip label={runtimeLabel(task.runtime)} />}
            {task.model && <ModelChip model={task.model} connection={task.connection} />}
          </div>
          {(relativeTime || hasMessages) && (
            <div className="ml-auto flex shrink-0 items-center gap-2.5 tabular-nums">
              {hasMessages && (
                <span className="inline-flex items-center gap-1">
                  <MessageSquare className="size-3.5" strokeWidth={2} aria-hidden />
                  {task.messageCount}
                </span>
              )}
              {relativeTime && <span>{relativeTime}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  if (!onEdit) return card

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <StyledContextMenuContent>
        <StyledContextMenuItem onSelect={onEdit}>
          <Pencil className="h-4 w-4" />
          {t('kanban.editTask')}
        </StyledContextMenuItem>
      </StyledContextMenuContent>
    </ContextMenu>
  )
}

/**
 * UA2.5 — "needs input": the session waits on a human (a permission card or a question).
 * The visible word is the board's; the label is the session list's own copy for the same
 * state (`session.attention.*`, P6.270/P6.764), naming the request when its subject is
 * known and saying only "waiting" when it is not.
 * UB14.60 — drawn as the card's run-state line in v0.15.1's "needs you" vocabulary (the session
 * row's Hand mark in the info role), where the v0.13.4 board had a pill beside the status badge.
 */
function NeedsInputLine({ waitingOn }: { waitingOn?: KanbanTask['waitingOn'] }) {
  const { t } = useTranslation()
  const label =
    waitingOn?.type === 'ask_user'
      ? t('session.attention.waitingOnQuestion')
      : waitingOn?.toolName
        ? t('session.attention.waitingOn', { prompt: waitingOn.toolName })
        : t('session.attention.waiting')
  return (
    <span
      role="status"
      title={label}
      aria-label={label}
      data-kanban-needs-input=""
      className="flex min-w-0 items-center gap-1.5 text-label-sm text-info"
    >
      <Hand className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{t('kanban.needsInput')}</span>
    </span>
  )
}

/**
 * UA2.5 — the runtime mark (Pi, Claude, Codex) in the colours of the composer's
 * `RuntimeBadge` (ConnectionRow.tsx), sized to sit beside ModelChip, without importing the
 * composer's module graph. Brand names stay in English (`runtimeLabel`).
 * UB14.60 — the composer badge's roles (UB14.30) at the meta row's 20px chip height.
 */
function RuntimeChip({ label }: { label: string }) {
  return (
    <span
      data-kanban-runtime={label}
      className="inline-flex h-5 shrink-0 select-none items-center rounded-xs bg-fill-hover px-1.5 text-caption font-medium text-secondary"
    >
      {label}
    </span>
  )
}

/**
 * Status badge that opens the shared `SessionStatusMenu` in a popover. Stops
 * pointer/keyboard propagation so opening the picker never starts a drag or
 * triggers the tile's open-window handler; closes itself on select.
 */
function StatusPicker({
  status,
  statuses,
  activeStateId,
  onSelect,
}: {
  status: SessionStatus
  statuses: SessionStatus[]
  activeStateId: string
  onSelect: (statusId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The chip is the trigger: hover/open deepen its fill (pressed fill), like a chip button.
            The 20px chip sits in a 24px hit area (minimum target size). */}
        <button
          type="button"
          data-no-dnd="true"
          onClick={e => e.stopPropagation()}
          onKeyDown={e => e.stopPropagation()}
          aria-label={t('kanban.changeStatus')}
          className="group/status inline-flex h-6 shrink-0 items-center rounded-xs"
        >
          <StatusBadge
            status={status}
            className="transition-colors duration-micro ease-out-subtle group-hover/status:bg-fill-pressed group-hover/status:duration-instant group-data-[state=open]/status:bg-fill-pressed"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-auto border-0 bg-transparent p-0 shadow-none"
        data-no-dnd="true"
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
      >
        <SessionStatusMenu
          states={statuses}
          activeState={activeStateId}
          onSelect={statusId => {
            onSelect(statusId)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Inline composer for spawning a subtask off a tile. Collapsed it's a "+ Add
 * subtask" affordance; expanded it's a text field plus an action row with a
 * provider→model picker and an Add button that creates a subtask routed to the
 * chosen model. Creation does not execute the subtask — it lands as a pending
 * row, dispatched later by the tile's Play (Run subtasks) button. The picker
 * menu is portaled (the tile lives in an `overflow-y-auto` column that would
 * clip an inline panel). The composer root stops click/keydown propagation so
 * neither the picker, Add, nor keyboard activation ever reaches the tile card's
 * open-window handler.
 */
function AddSubtask({
  onAdd,
  modelGroups,
  defaultModel,
}: {
  onAdd: (title: string, model: string, connectionSlug?: string) => void
  modelGroups?: KanbanModelProviderGroup[]
  defaultModel?: string
}) {
  const { t } = useTranslation()
  const [composing, setComposing] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  const options = React.useMemo(() => (modelGroups ?? []).flatMap(g => g.models), [modelGroups])
  const [model, setModel] = React.useState(() => initialSubtaskModel(defaultModel, modelGroups))
  // The group the model was picked under; undefined until a pick (the default routes as the catalogue does).
  const [connectionSlug, setConnectionSlug] = React.useState<string | undefined>(undefined)
  const checked = checkedConnectionSlug(modelGroups ?? [], model, connectionSlug)

  React.useEffect(() => {
    if (composing) inputRef.current?.focus()
  }, [composing])

  const selectedGroup =
    modelGroups?.find(g => g.connectionSlug === checked && g.models.some(m => m.id === model)) ??
    modelGroups?.find(g => g.models.some(m => m.id === model))
  const selectedName = options.find(o => o.id === model)?.name ?? getModelShortName(model)
  const selectedIcon = selectedGroup ? resolveProviderIcon(selectedGroup.provider) : null

  const submit = () => {
    const title = draft.trim()
    if (!title) return
    onAdd(title, model, connectionSlug)
    setDraft('')
    setComposing(false)
  }

  if (!composing) {
    return (
      <button
        type="button"
        data-no-dnd="true"
        onClick={e => {
          e.stopPropagation()
          setComposing(true)
        }}
        className="flex min-h-6 w-full items-center gap-1 rounded-sm text-label-sm font-medium text-tertiary transition-colors duration-micro ease-out-subtle hover:text-secondary hover:duration-instant"
      >
        <Plus className="size-3.5" strokeWidth={2} />
        {t('kanban.addSubtask')}
      </button>
    )
  }

  return (
    <div
      className="mt-1.5 space-y-1.5"
      data-no-dnd="true"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <textarea
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setComposing(false)
            setDraft('')
          }
        }}
        rows={1}
        placeholder={t('kanban.describeSubtask')}
        className="field-surface w-full resize-none rounded-md px-2 py-1.5 text-label-sm field-sizing-content max-h-40"
      />
      <div className="flex items-center justify-between gap-1.5">
        {modelGroups && modelGroups.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="field-surface inline-flex h-control-sm min-w-0 items-center gap-1 rounded-sm px-1.5 text-label-sm font-medium text-secondary"
              >
                <ProviderIconMark icon={selectedIcon} className="size-3 shrink-0 rounded-[2px]" />
                <span className="truncate">{selectedName}</span>
                <ChevronDown className="size-3.5 shrink-0 text-tertiary" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[240px]">
              {modelGroups.map((group, gi) => (
                <React.Fragment key={group.connectionSlug ?? group.provider}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className="flex items-center gap-1.5">
                    {resolveProviderIcon(group.provider) && (
                      <ProviderIconMark icon={resolveProviderIcon(group.provider)} className="size-3 rounded-[2px]" />
                    )}
                    {group.label}
                  </DropdownMenuLabel>
                  {group.models.map(opt => (
                    <DropdownMenuItem
                      key={opt.id}
                      onSelect={() => {
                        setModel(opt.id)
                        setConnectionSlug(group.connectionSlug)
                      }}
                    >
                      <span className="truncate">{opt.name}</span>
                      {opt.id === model && group.connectionSlug === checked && (
                        <Check className="ml-auto shrink-0" strokeWidth={2} />
                      )}
                    </DropdownMenuItem>
                  ))}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span />
        )}
        <Button type="button" variant="primary" size="sm" onClick={submit} disabled={!draft.trim()}>
          {t('kanban.add')}
        </Button>
      </div>
    </div>
  )
}
