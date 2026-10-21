/* Copied from v0.13.4:apps/electron/src/renderer/playground/registry/kanban.tsx
   (craft-agents-oss, Apache-2.0) by UA2.6, 2026-10-02. UA3.7 restored the simulated session window
   (a tile or subtask click opens `TaskChatPreview` in a faux window) and the task-window entry, which
   waited for `TaskChatPreview`; nothing is withheld any more.
   Adaptations, each named: the statuses, models and the status-on-move demo are ours (our five
   default statuses — `in-progress` is a column, never a status — and model ids our registry
   knows, plus a gateway alias); the tile-anatomy entry gains UA2.5's knobs (runtime chip,
   needs-input badge and what it waits on, the gateway model's connection icon); the active
   toggle segment's `shadow-sm` was `shadow-minimal` (nessy-styles/no-nonstandard-shadows; retired by UB14.52,
   below); the simulated window maps a RUNNING subtask to `todo` (upstream: the `in-progress` status, which is a
   column here) and opens a subtask with no model (UA12.46) with no model chip and an intro naming none.
   UA12.122 adds the focused-project knob (`focusedProject`): the demo project's own columns resolved
   through the container's `resolveActiveColumns` and edited through its `withUpdatedColumn` /
   `withAddedColumn`, the column editor + "add column" affordance + "Columns from" header line — the
   editor surface had existed nowhere a dark sweep reaches.
   UB14.52 (Nessy deviation from v0.15.1's playground, which still draws its own pre-redesign toggle): the board
   entry's header draws the SHIPPED `BoardListToggle` (v0.15.1's segmented control) instead of a local copy, so the
   dark sweep reads the real control in both states; the `kanban-new-task-composer` entry draws the real
   `NewTaskComposer` open — the field the column header's "+" opens, which no static board state can reach.
   UB14.60 (R2-16): the board entry's header mirrors the container's v0.15.1 header (48px, the gutter, label-lg, no
   surface of its own); the tile-anatomy entry gains the states the card restyle touches — `processing` (the
   Working line), `inColumn` (the card inside its built-in column: the column id is its home status, so a status
   equal to it draws no chip), `dragOverlay` (the overlay clone's lift) and `wokeAfterDone` (UA4.4's info chip) —
   and passes `onEdit`, so the corner pencil `IconButton` is in the sweep. */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import type { ComponentEntry } from './types'
import { IconButton } from '@/components/ui/button'
import { getModelShortName } from '@config/models'
import type { ProjectColorTreatment } from '@/utils/project-colors'
import type { KanbanColumnDef } from '@nessy-agent/shared/projects/types'
import { resolveActiveColumns, withAddedColumn, withUpdatedColumn } from '@/components/app-shell/kanban/project-columns'
import { KanbanBoard } from '@/components/app-shell/kanban/KanbanBoard'
import { BoardListToggle, type BoardListValue } from '@/components/app-shell/kanban/BoardListToggle'
import { NewTaskComposer } from '@/components/app-shell/kanban/NewTaskComposer'
import { TaskTile } from '@/components/app-shell/kanban/TaskTile'
import { TaskChatPreview } from '@/components/app-shell/kanban/TaskChatPreview'
import { StatusBadge } from '@/components/app-shell/kanban/StatusBadge'
import { ModelChip } from '@/components/app-shell/kanban/ModelChip'
import { KANBAN_COLUMNS, statusToColumn } from '@/components/app-shell/kanban/status-column'
import type {
  KanbanColumnId,
  KanbanModelProviderGroup,
  KanbanSubtask,
  KanbanTask,
  SubtaskRunState,
} from '@/components/app-shell/kanban/types'
import {
  mockTasks,
  mockProjectsById,
  mockStatuses,
  mockStatusesById,
  mockFocusedProject,
  DEFAULT_EXPANDED_TASK_IDS,
  ANATOMY_SUBTASKS,
  mockConnections,
  mockTaskWindow,
} from '../demos/kanban/mock-kanban-data'

const MODEL_OPTIONS = [
  { label: 'Opus 4.8', value: 'claude-opus-4-8' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  // UA2.5 — a gateway alias the model registry does not know: the chip takes the connection's icon.
  { label: 'Gateway alias (coder)', value: 'coder' },
]

/** Our five default statuses (`packages/shared/src/statuses/storage.ts`). */
const STATUS_OPTIONS = [
  { label: 'Backlog', value: 'backlog' },
  { label: 'Todo', value: 'todo' },
  { label: 'Needs Review', value: 'needs-review' },
  { label: 'Done', value: 'done' },
  { label: 'Cancelled', value: 'cancelled' },
]

/** UA2.5 — the tile's runtime chip: none (an unknown connection), or one of the three runtimes. */
const RUNTIME_OPTIONS = [
  { label: 'None (unknown connection)', value: 'none' },
  { label: 'Pi (Nessy Gateway)', value: 'pi' },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
]

/** UA2.5 — what a needs-input tile waits on; the badge shows for all three. */
const WAITING_ON_OPTIONS = [
  { label: 'Unnamed request', value: 'none' },
  { label: 'A tool (Bash)', value: 'bash' },
  { label: 'A question', value: 'question' },
]

type RuntimeKnob = 'none' | 'pi' | 'claude' | 'codex'
type WaitingOnKnob = 'none' | 'bash' | 'question'

/** UA2.5 — the tile fields a runtime knob stands for (the container derives them from `llmConnection`). */
function runtimeFields(runtime: RuntimeKnob): Pick<KanbanTask, 'runtime' | 'connection'> {
  switch (runtime) {
    case 'pi':
      return { runtime: 'pi', connection: mockConnections.pi }
    case 'claude':
      return { runtime: 'anthropic', connection: mockConnections.claude }
    case 'codex':
      return { runtime: 'codex-runtime', connection: mockConnections.codex }
    default:
      return {}
  }
}

/** UA2.5 — the tile fields a needs-input knob stands for (the container derives them from the count). */
function needsInputFields(needsInput: boolean, waitingOn: WaitingOnKnob): Pick<KanbanTask, 'needsInput' | 'waitingOn'> {
  if (!needsInput) return {}
  if (waitingOn === 'bash') return { needsInput, waitingOn: { type: 'bash', toolName: 'Bash' } }
  if (waitingOn === 'question') return { needsInput, waitingOn: { type: 'ask_user', toolName: 'ask_user' } }
  return { needsInput }
}

const TREATMENT_OPTIONS = [
  { label: 'Stripe + tint', value: 'stripe-tint' },
  { label: 'Stripe only', value: 'stripe' },
]

/**
 * Provider→model catalog for the "Add subtask" composer. Stands in for the
 * workspace's real LLM connections (which the wiring phase will supply): the
 * point of the demo is that a subtask can be routed to *any* provider's model,
 * not just Anthropic. Provider keys drive the brand icons via `getProviderIcon`.
 */
const SUBTASK_MODEL_GROUPS: KanbanModelProviderGroup[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-4-7', name: 'Opus 4.7' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
    ],
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'openai/gpt-5', name: 'GPT-5' },
      { id: 'openai/gpt-5-mini', name: 'GPT-5 mini' },
    ],
  },
  {
    provider: 'google',
    label: 'Google AI Studio',
    models: [
      { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro' },
      { id: 'google/gemini-3-flash', name: 'Gemini 3 Flash' },
    ],
  },
  {
    provider: 'xai',
    label: 'xAI (Grok)',
    models: [{ id: 'xai/grok-4', name: 'Grok 4' }],
  },
  {
    provider: 'deepseek',
    label: 'DeepSeek',
    models: [{ id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }],
  },
  {
    provider: 'mistral',
    label: 'Mistral',
    models: [{ id: 'mistral/mistral-large', name: 'Mistral Large' }],
  },
  {
    provider: 'groq',
    label: 'Groq',
    models: [{ id: 'groq/llama-4-70b', name: 'Llama 4 70B' }],
  },
]

/** Model a freshly-spawned subtask is routed to when the picker isn't touched. */
const DEFAULT_SUBTASK_MODEL = 'claude-sonnet-4-6'

/** Build a new pending subtask from a typed title + chosen model (the "Add" path; Run dispatches it). */
function makeSubtask(title: string, idPrefix: string, model: string): KanbanSubtask {
  return { id: `${idPrefix}-new-${Date.now()}`, title, runState: 'pending', model }
}

// ============================================================================
// List ⇄ Board toggle (lives in the All-Sessions header)
// ============================================================================

// UB14.52: the shipped control (v0.15.1's segmented toggle), not a local copy of it.
type KanbanView = BoardListValue

function StubSessionList() {
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="mx-auto max-w-md divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60 bg-card">
        {mockTasks.map(task => {
          const project = task.projectId ? mockProjectsById.get(task.projectId) : undefined
          const status = mockStatusesById.get(task.statusId)
          return (
            <div key={task.id} className="flex items-center gap-2 px-3 py-2">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: project?.color ?? 'var(--muted-foreground)' }}
                aria-hidden
              />
              <span className="flex-1 truncate text-sm text-foreground">{task.title}</span>
              {status && <StatusBadge status={status} />}
              {task.model && <ModelChip model={task.model} />}
            </div>
          )
        })}
      </div>
      <p className="mx-auto mt-3 max-w-md text-center text-xs text-foreground/40">
        List view is a stub here — the Board toggle is the focus of this preview.
      </p>
    </div>
  )
}

// ============================================================================
// Simulated "separate window" — opening a task or subtask session
// ============================================================================

type TaskWindowProps = React.ComponentProps<typeof TaskChatPreview>

type OpenTarget =
  | { kind: 'task'; taskId: string }
  | { kind: 'subtask'; taskId: string; subtaskId: string }

// NESSY: `in-progress` is a board column, never one of our statuses — a running subtask shows `todo`.
const SUBTASK_STATUS_BY_RUN_STATE: Record<SubtaskRunState, string> = {
  done: 'done',
  running: 'todo',
  pending: 'todo',
  failed: 'needs-review',
}

/** Chat-window props for a parent task opened from its tile. */
function buildTaskWindowProps(task: KanbanTask): TaskWindowProps {
  const project = task.projectId ? mockProjectsById.get(task.projectId) : undefined
  const hasSubtasks = task.subtasks.length > 0
  return {
    title: task.title,
    project,
    status: mockStatusesById.get(task.statusId),
    model: task.model,
    userMessage: `Coordinate "${task.title}" and route each part to the best-fit model.`,
    assistantIntro: hasSubtasks
      ? "I'm acting as the orchestrator — here are the subtasks I've spawned, each routed to a best-fit model:"
      : "I'm acting as the orchestrator. No subtasks have been spawned yet — add one from the tile to send it down to run.",
    subtasks: task.subtasks,
    assistantFollowUp: hasSubtasks
      ? "I'll update each subtask here as the spawned sessions report back."
      : undefined,
  }
}

/** Chat-window props for a single spawned subtask opened from its row. */
function buildSubtaskWindowProps(sub: KanbanSubtask, parent: KanbanTask): TaskWindowProps {
  const project = parent.projectId ? mockProjectsById.get(parent.projectId) : undefined
  const followUp: Record<SubtaskRunState, string> = {
    done: 'This subtask has completed and reported back to the parent task.',
    running: 'This subtask is running now; results will report back to the parent task.',
    pending: 'This subtask is queued and will start once upstream work is ready.',
    failed: 'This subtask failed; the parent task can retry or rerun it.',
  }

  return {
    title: sub.title,
    project,
    status: mockStatusesById.get(SUBTASK_STATUS_BY_RUN_STATE[sub.runState]),
    model: sub.model,
    userMessage: sub.title,
    // NESSY (UA12.46): a subtask with no model names none.
    assistantIntro: sub.model
      ? `Spawned from "${parent.title}" and routed to ${getModelShortName(sub.model)} as the best fit for this subtask.`
      : `Spawned from "${parent.title}".`,
    subtasks: [],
    assistantFollowUp: followUp[sub.runState],
  }
}

/**
 * Stand-in for opening a session in its own OS window. The playground can't spawn
 * real windows, so this overlays the same `TaskChatPreview` body inside a faux
 * window chrome (with a close button + Escape-to-close).
 */
function TaskWindowOverlay({ windowProps, onClose }: { windowProps: TaskWindowProps; onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center">
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        className="relative z-10 flex h-[88%] w-[90%] max-w-2xl flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/40 bg-foreground/[0.02] px-3 py-1.5">
          <span className="text-[11px] font-medium text-foreground/40">Session window</span>
          <button
            type="button"
            onClick={onClose}
            className="grid h-6 w-6 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/10 hover:text-foreground/80"
            aria-label="Close window"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <TaskChatPreview {...windowProps} />
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Entry 1 — full Kanban view (All-Sessions header + toggle + board)
// ============================================================================

/** UA12.122 — the column defs the board demo starts from: the focused project's own columns (a fresh copy), else none. */
export function seedFocusedColumnDefs(focusedProject: boolean): KanbanColumnDef[] {
  return focusedProject ? [...(mockFocusedProject.config.kanbanColumns ?? [])] : []
}

function KanbanViewPreview({
  view = 'board',
  treatment = 'stripe-tint',
  focusedProject = false,
}: {
  view?: KanbanView
  treatment?: ProjectColorTreatment
  /** UA12.122 — focus the demo project: its own columns and the column editor (the dark-sweep surface). */
  focusedProject?: boolean
}) {
  const { t } = useTranslation()
  const [activeView, setActiveView] = React.useState<KanbanView>(view)
  React.useEffect(() => setActiveView(view), [view])

  // Clone the module-level mock so the demo can mutate (add subtasks) without
  // leaking edits across previews.
  const [tasks, setTasks] = React.useState<KanbanTask[]>(() =>
    mockTasks.map(t => ({ ...t, subtasks: [...t.subtasks] }))
  )
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(DEFAULT_EXPANDED_TASK_IDS))
  const [openTarget, setOpenTarget] = React.useState<OpenTarget | null>(null)

  // UA12.122 — the focused project's own column defs, edited through the container's pure rules
  // (`withUpdatedColumn` / `withAddedColumn`; removal keeps the last column, as the board guards).
  // The board resolves them through `resolveActiveColumns`, exactly as the container does.
  const [columnDefs, setColumnDefs] = React.useState<KanbanColumnDef[]>(() => seedFocusedColumnDefs(focusedProject))
  // Follow-up (2026-10-08 verification): the playground mounts this entry on its defaults and the
  // variant picker only changes props on the same instance, so re-seed on the knob as `view` does.
  React.useEffect(() => setColumnDefs(seedFocusedColumnDefs(focusedProject)), [focusedProject])
  const updateColumn = (columnId: string, patch: Partial<KanbanColumnDef>) =>
    setColumnDefs(prev => withUpdatedColumn(prev, columnId, patch))
  const removeColumn = (columnId: string) =>
    setColumnDefs(prev => (prev.length > 1 ? prev.filter(c => c.id !== columnId) : prev))
  const addColumn = () => setColumnDefs(prev => withAddedColumn(prev, `col-${Date.now().toString(36)}`, 'New column'))
  const selectDropStatus = (columnId: string, statusId: string) =>
    setColumnDefs(prev => withUpdatedColumn(prev, columnId, { dropStatusId: statusId || undefined }))
  const activeColumns = React.useMemo(
    () =>
      focusedProject
        ? resolveActiveColumns({ config: { ...mockFocusedProject.config, kanbanColumns: columnDefs } })
        : KANBAN_COLUMNS,
    [focusedProject, columnDefs]
  )

  const toggleSubtasks = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const addSubtask = (taskId: string, title: string, model: string) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === taskId ? { ...t, subtasks: [...t.subtasks, makeSubtask(title, taskId, model)] } : t
      )
    )
    setExpanded(prev => new Set(prev).add(taskId))
  }

  // Dispatch a tile's pending subtasks: flip them to running (the "Play" path).
  const runSubtasks = (taskId: string) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => (s.runState === 'pending' ? { ...s, runState: 'running' } : s)) }
          : t
      )
    )
  }

  // Create a named task tile in the ToDo column (the inline "New Task" composer path).
  const createTask = (title: string) => {
    setTasks(prev => [
      ...prev,
      { id: `task-new-${Date.now()}`, title, column: 'todo', statusId: 'todo', model: DEFAULT_SUBTASK_MODEL, subtasks: [] },
    ])
  }

  const changeStatus = (taskId: string, statusId: string) => {
    setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, statusId } : t)))
  }

  // Demo of the per-column "status on move" mapping the live board reads from
  // settings: dropping into a column also folds the status to that column.
  // Nessy: `in-progress` is a column and not one of our statuses, so a drop there keeps the
  // task's status (an unmapped column, as the live board treats it).
  const COLUMN_STATUS: Partial<Record<KanbanColumnId, string>> = {
    todo: 'todo',
    done: 'done',
  }
  const moveTask = (taskId: string, toColumn: KanbanColumnId) => {
    setTasks(prev =>
      prev.map(t =>
        t.id === taskId ? { ...t, column: toColumn, statusId: COLUMN_STATUS[toColumn] ?? t.statusId } : t
      )
    )
  }

  // Derive overlay props from the *current* tasks so a freshly added subtask
  // shows up live in an already-open parent window.
  const windowProps = React.useMemo<TaskWindowProps | null>(() => {
    if (!openTarget) return null
    const task = tasks.find(t => t.id === openTarget.taskId)
    if (!task) return null
    if (openTarget.kind === 'task') return buildTaskWindowProps(task)
    const sub = task.subtasks.find(s => s.id === openTarget.subtaskId)
    return sub ? buildSubtaskWindowProps(sub, task) : null
  }, [openTarget, tasks])

  return (
    <div className="relative flex h-full flex-col">
      {/* UB14.60 — the container's v0.15.1 header: 48px, on the gutter, no surface of its own. */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-gutter">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label-lg font-semibold">{t('kanban.allTasks')}</span>
          {/* UA12.122 — the container's "Columns from <project>" line (kanban.column.columnsFrom). */}
          {focusedProject && (
            <span className="truncate text-label-sm text-tertiary">{t('kanban.column.columnsFrom', { project: mockFocusedProject.config.name })}</span>
          )}
        </div>
        <BoardListToggle value={activeView} onChange={setActiveView} />
      </div>
      {activeView === 'board' ? (
        <div className="min-h-0 flex-1">
          <KanbanBoard
            columns={activeColumns}
            tasks={tasks}
            projectsById={mockProjectsById}
            statusesById={mockStatusesById}
            statuses={mockStatuses}
            onChangeStatus={changeStatus}
            treatment={treatment}
            expandedTaskIds={expanded}
            onTaskClick={taskId => setOpenTarget({ kind: 'task', taskId })}
            onToggleSubtasks={toggleSubtasks}
            onSubtaskClick={(taskId, subtaskId) => setOpenTarget({ kind: 'subtask', taskId, subtaskId })}
            onAddSubtask={addSubtask}
            onRunSubtasks={runSubtasks}
            subtaskModelGroups={SUBTASK_MODEL_GROUPS}
            defaultSubtaskModel={DEFAULT_SUBTASK_MODEL}
            onCreateTask={createTask}
            onMoveTask={moveTask}
            {...(focusedProject
              ? {
                  onUpdateColumn: updateColumn,
                  onRemoveColumn: removeColumn,
                  onAddColumn: addColumn,
                  onSelectDropStatus: selectDropStatus,
                }
              : {})}
          />
        </div>
      ) : (
        <StubSessionList />
      )}

      {windowProps && <TaskWindowOverlay windowProps={windowProps} onClose={() => setOpenTarget(null)} />}
    </div>
  )
}

// ============================================================================
// Entry 2 — single tile (anatomy)
// ============================================================================

function TaskTilePreview({
  subtasksExpanded = true,
  statusId = 'todo',
  treatment = 'stripe-tint',
  model = 'claude-opus-4-8',
  runtime = 'claude',
  needsInput = false,
  waitingOn = 'bash',
  processing = false,
  inColumn = false,
  dragOverlay = false,
  wokeAfterDone = false,
}: {
  subtasksExpanded?: boolean
  statusId?: string
  treatment?: ProjectColorTreatment
  model?: string
  runtime?: RuntimeKnob
  needsInput?: boolean
  waitingOn?: WaitingOnKnob
  /** UB14.60 — a turn in flight (the Working line shows on an in-progress card). */
  processing?: boolean
  /** UB14.60 — the card inside its built-in column, whose id is its home status (`columnStatusId`). */
  inColumn?: boolean
  /** UB14.60 — the drag overlay clone. */
  dragOverlay?: boolean
  /** UB14.60 — UA4.4's woke-after-done mark. */
  wokeAfterDone?: boolean
}) {
  const [expanded, setExpanded] = React.useState(subtasksExpanded)
  React.useEffect(() => setExpanded(subtasksExpanded), [subtasksExpanded])

  const [subtasks, setSubtasks] = React.useState<KanbanSubtask[]>(() => [...ANATOMY_SUBTASKS])

  const task: KanbanTask = {
    id: 'anatomy',
    title: 'Migrate auth to new session model',
    column: statusToColumn(statusId),
    statusId,
    model,
    projectId: 'p-eng',
    subtasks,
    ...runtimeFields(runtime),
    ...needsInputFields(needsInput, waitingOn),
    ...(processing ? { isProcessing: true } : {}),
    ...(wokeAfterDone ? { wokeAfterDone: true } : {}),
  }

  return (
    <div className="w-[340px]">
      <TaskTile
        task={task}
        project={mockProjectsById.get('p-eng')}
        status={mockStatusesById.get(statusId)}
        treatment={treatment}
        expanded={expanded}
        columnStatusId={inColumn ? task.column : undefined}
        dragOverlay={dragOverlay}
        onClick={() => {}}
        onEdit={() => {}}
        onToggleSubtasks={() => setExpanded(v => !v)}
        onAddSubtask={(title, subtaskModel) => {
          setSubtasks(prev => [...prev, makeSubtask(title, 'anatomy', subtaskModel)])
          setExpanded(true)
        }}
        onRunSubtasks={() =>
          setSubtasks(prev => prev.map(s => (s.runState === 'pending' ? { ...s, runState: 'running' } : s)))
        }
        subtaskModelGroups={SUBTASK_MODEL_GROUPS}
        defaultSubtaskModel={DEFAULT_SUBTASK_MODEL}
      />
    </div>
  )
}

// ============================================================================
// Entry 3 — focused task window (chat-only)
// ============================================================================

function KanbanTaskWindowPreview() {
  return <TaskChatPreview {...mockTaskWindow} />
}

// ============================================================================
// Entry — the New Task composer, open (UB14.52)
// ============================================================================

/**
 * The inline composer the first column's header "+" opens (v0.15.1 `NewTaskComposer`, R4-03): the sunken field at
 * the top of the column, shaped like the card it creates. Closed it renders nothing — that state is the board
 * entry's header "+". Enter adds a task and keeps the field open; Escape or an empty blur closes it.
 */
function NewTaskComposerPreview() {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(true)
  const [created, setCreated] = React.useState<string[]>([])
  return (
    <div className="flex w-72 flex-col gap-2">
      {/* Closed (Escape, or an empty blur): the header's "+" opens it again, as on the board. */}
      {!open && (
        <IconButton size="sm" icon={<Plus />} aria-label={t('kanban.newTask')} tooltip className="self-end" onClick={() => setOpen(true)} />
      )}
      <NewTaskComposer open={open} onOpenChange={setOpen} onCreate={title => setCreated(prev => [title, ...prev])} />
      {created.map((title, index) => (
        <span key={`${index}-${title}`} className="truncate text-label-sm text-tertiary">{title}</span>
      ))}
    </div>
  )
}

// ============================================================================
// Registry
// ============================================================================

export const kanbanComponents: ComponentEntry[] = [
  {
    id: 'kanban-board',
    name: 'Kanban Board',
    category: 'Kanban',
    description:
      'The 3-column board (ToDo / In Progress / Done) with the List⇄Board toggle in the All-Tasks header. Tiles place by column, independent from their status badge, and show the runtime that runs the session (Pi, Claude, Codex) and a needs-input badge when the session waits on you. Clicking a tile — or any spawned subtask row — opens that session in a (simulated) separate window; the "+ Add subtask" composer creates a pending subtask, and the Play (▶) button on a tile dispatches all pending subtasks to the orchestrator.',
    component: KanbanViewPreview,
    layout: 'full',
    props: [
      {
        name: 'view',
        description: 'Which view the All-Sessions header toggle starts on',
        control: { type: 'select', options: [{ label: 'Board', value: 'board' }, { label: 'List', value: 'list' }] },
        defaultValue: 'board',
      },
      {
        name: 'treatment',
        description: 'How a tile shows its project color',
        control: { type: 'select', options: TREATMENT_OPTIONS },
        defaultValue: 'stripe-tint',
      },
      {
        name: 'focusedProject',
        description: 'Focus the demo project: its own columns and the column editor (rename, colour, drop status, remove) with the "add column" affordance',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Board view', description: 'Default 3-column board', props: { view: 'board', treatment: 'stripe-tint' } },
      { name: 'Board · stripe only', description: 'Project color as a stripe without tint', props: { view: 'board', treatment: 'stripe' } },
      { name: 'List view (stub)', description: 'Toggle flipped to the (stubbed) list', props: { view: 'list' } },
      { name: 'Focused project', description: 'A project\'s own columns with the column editor and "add column" — the dark-sweep surface (UA12.122)', props: { view: 'board', focusedProject: true } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'kanban-new-task-composer',
    name: 'New Task composer (open)',
    category: 'Kanban',
    description:
      'The inline New Task field the first column\'s header "+" opens: a sunken field shaped like the card it creates. Enter adds a task and stays open for the next; Escape or blurring it empty closes it (closed, the column shows only its header "+").',
    component: NewTaskComposerPreview,
    layout: 'centered',
    props: [],
    mockData: () => ({}),
  },
  {
    id: 'kanban-task-tile',
    name: 'Task Tile (anatomy)',
    category: 'Kanban',
    description:
      'A single parent-session card (v0.15.1): project color, the Working line while a turn runs (or the needs-input line when the session waits on you), the meta row — status chip (skipped inside its own column), the woke-after-done chip, the runtime chip, orchestrator model (a gateway id takes its connection\'s icon), messages and age —, a collapsable auto-routed subtask list, an inline "+ Add subtask" composer (type a title → Add → creates a pending subtask), a Play (▶) button that dispatches all pending subtasks, and the hover pencil.',
    component: TaskTilePreview,
    layout: 'centered',
    props: [
      {
        name: 'subtasksExpanded',
        description: 'Expand the spawned-subtask list',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'statusId',
        description: 'Status badge — independent from the board column',
        control: { type: 'select', options: STATUS_OPTIONS },
        defaultValue: 'todo',
      },
      {
        name: 'treatment',
        description: 'Project color treatment',
        control: { type: 'select', options: TREATMENT_OPTIONS },
        defaultValue: 'stripe-tint',
      },
      {
        name: 'model',
        description: 'Orchestrator model for the parent task',
        control: { type: 'select', options: MODEL_OPTIONS },
        defaultValue: 'claude-opus-4-8',
      },
      {
        name: 'runtime',
        description: 'Runtime chip — from the session connection (none = a connection this window does not know)',
        control: { type: 'select', options: RUNTIME_OPTIONS },
        defaultValue: 'claude',
      },
      {
        name: 'needsInput',
        description: 'Needs-input badge — the session waits on you (awaitingApprovalCount > 0)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'waitingOn',
        description: 'What the session waits on (names the request in the badge label; never decides the badge)',
        control: { type: 'select', options: WAITING_ON_OPTIONS },
        defaultValue: 'bash',
      },
      {
        name: 'processing',
        description: 'A turn in flight: an in-progress card shows the Working line (live-pulse preference on)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'inColumn',
        description: 'Inside its board column: a status equal to the column\'s own draws no chip',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'dragOverlay',
        description: 'The drag overlay clone: lifted to elev-3, no hover ring',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'wokeAfterDone',
        description: 'A node\'s session worked again after done (the info chip in the meta row)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Expanded', description: 'Subtasks visible', props: { subtasksExpanded: true } },
      { name: 'Collapsed', description: 'Subtasks hidden', props: { subtasksExpanded: false } },
      { name: 'Needs Review', description: 'Needs-review badge (would sit in In Progress)', props: { statusId: 'needs-review' } },
      { name: 'Needs input', description: 'Waiting on a tool request (Bash), Codex runtime', props: { needsInput: true, waitingOn: 'bash', runtime: 'codex' } },
      { name: 'Needs input · unnamed', description: 'Waiting with no named request — the badge still shows', props: { needsInput: true, waitingOn: 'none', runtime: 'pi' } },
      { name: 'Gateway model', description: 'A gateway alias on the Nessy Gateway (Pi): the model chip takes the connection icon', props: { model: 'coder', runtime: 'pi' } },
      { name: 'No runtime chip', description: 'A connection this window does not know', props: { runtime: 'none' } },
      { name: 'Working', description: 'A turn in flight on an in-progress card: the Working line', props: { statusId: 'needs-review', processing: true } },
      { name: 'In its column', description: 'A Todo card in the Todo column: no status chip (it would repeat the header)', props: { statusId: 'todo', inColumn: true } },
      { name: 'Drag overlay', description: 'The clone that follows the pointer: elev-3, no hover ring', props: { dragOverlay: true, subtasksExpanded: false } },
      { name: 'Woke after done', description: 'A node worked again after it was done (UA4.4)', props: { wokeAfterDone: true } },
    ],
    mockData: () => ({}),
  },  {
    id: 'kanban-task-window',
    name: 'Task Window (chat-only)',
    category: 'Kanban',
    description:
      'The focused task window body: title bar, transcript showing Task mode acting as an orchestrator that spawns best-fit-model subtasks, and an input bar. No board, no sidebar.',
    component: KanbanTaskWindowPreview,
    layout: 'full',
    props: [],
    mockData: () => ({}),
  },
]
