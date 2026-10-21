import { Ban, Circle, CircleCheck, ListTodo } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { isPlanWritingTool } from '@nessy-agent/shared/utils/toolNames'
import { CHIP_NEUTRAL, ROW_ICON_SIZE, ROW_ICON_SLOT, RowSpinner, WORK_LOG_BODY, WORK_LOG_ROW, WORK_LOG_ROW_WRAPPER } from './transcript-card-chrome'

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted'

type TodoListItem = {
  id?: string
  content: string
  status: TodoStatus
  activeForm?: string
}

type TodoListCardProps = {
  activity: ActivityItem
}

const validStatuses = new Set<TodoStatus>(['pending', 'in_progress', 'completed', 'interrupted'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeTodo(value: unknown): TodoListItem | null {
  if (!isRecord(value)) return null

  const content = typeof value.content === 'string' ? value.content.trim() : ''
  const status = typeof value.status === 'string' ? value.status : ''
  if (!content || !validStatuses.has(status as TodoStatus)) return null

  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    content,
    status: status as TodoStatus,
    activeForm: typeof value.activeForm === 'string' ? value.activeForm.trim() : undefined,
  }
}

function normalizeTodos(value: unknown): TodoListItem[] {
  if (!Array.isArray(value)) return []
  return value.map(normalizeTodo).filter((todo): todo is TodoListItem => todo !== null)
}

function parseTodosFromResult(content: string | undefined): TodoListItem[] {
  if (!content?.trim()) return []

  try {
    const parsed = JSON.parse(content)
    if (isRecord(parsed)) {
      return normalizeTodos(parsed.todos)
    }
  } catch {
    return []
  }

  return []
}

/**
 * Whether this row writes the session plan at all — NAME only, nothing else.
 *
 * P3.295 · the vocabulary moved to `@nessy-agent/shared/utils/toolNames` and
 * gained codex's `update_plan`. It had only ever known `TodoWrite`, which is how
 * Pi and claude write a plan; codex writes one with `update_plan`, and the
 * adapter stamps that name on the row it synthesizes from `turn/plan/updated`.
 * The name kept its `isTodoWriteActivity` spelling because `ChatDisplay` and
 * this file's own tests route on it.
 */
export function isTodoWriteActivity(activity: ActivityItem): boolean {
  return isPlanWritingTool(activity.toolName)
}

/**
 * P2.503 — whether `ChatDisplay` should route this row to the card: the FULL
 * question, not the tool name.
 *
 * A card in the `renderActivity` slot CANNOT DECLINE A ROW. `TurnCard` writes
 * `renderActivity?.(props) ?? <ActivityRow …>`, and a returned card is an
 * ELEMENT — never nullish — so once the router has chosen a card the fallback
 * can no longer fire. A card that then renders `null` does not hand the row
 * back: it REMOVES the row from the transcript.
 *
 * That was live here. The router asked {@link isTodoWriteActivity}, the card
 * asks {@link getTodoListItems}, and the two disagree for every TodoWrite row
 * whose todos cannot be recovered — an in-flight call whose input has not been
 * parsed yet, a failed call whose result is an error string, a persisted row
 * whose JSON result does not carry a `todos` array. The user saw NO evidence
 * the tool had run at all, which is strictly worse than the plain tool row the
 * fallback would have painted.
 *
 * So the predicate asks the question the card will ask. Same shape as
 * `advisor-consultation.ts`'s `isAdvisorCardActivity` and
 * `activity-card-routing.ts`'s `isSubagentCardActivity`, and for the same
 * measured reason — see `__tests__/activity-slot-cards.test.tsx`, which is the
 * only thing that enumerates this slot's cards.
 */
export function isTodoCardActivity(activity: ActivityItem): boolean {
  return isTodoWriteActivity(activity) && getTodoListItems(activity).length > 0
}

export function getTodoListItems(activity: ActivityItem): TodoListItem[] {
  const inputTodos = normalizeTodos(activity.toolInput?.todos)
  if (inputTodos.length > 0) return inputTodos
  return parseTodosFromResult(activity.content)
}

function statusLabelKey(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return 'turnCard.todo.status.pending'
    case 'in_progress':
      return 'turnCard.todo.status.inProgress'
    case 'completed':
      return 'turnCard.todo.status.completed'
    case 'interrupted':
      return 'turnCard.todo.status.interrupted'
  }
}

/*
 * UB14.18 — drawn as v0.15.1's `turn/TodoList` draws the same TodoWrite state (its status glyphs, its
 * 28px rows, the done item struck through in the tertiary ink), hung as a work-log group: a header
 * row with TodoWrite's `ListTodo` icon (v0.15.1 `ActivityIcons`), the items under the inset hairline.
 * Ours on top, unchanged: the "n/m done" summary and each item's status word as a neutral chip. The
 * look sits below the routing on purpose: the ledger's H11 cites `:71`, `:100` and `:101` above.
 */

/** v0.15.1 `turn/TodoList` `TodoStatusIcon`, verbatim in its classes. */
function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'pending':
      return <Circle aria-hidden className={`${ROW_ICON_SIZE} text-tertiary`} />
    case 'in_progress':
      return <RowSpinner />
    case 'completed':
      return <CircleCheck aria-hidden className={`${ROW_ICON_SIZE} text-accent`} />
    case 'interrupted':
      return <Ban aria-hidden className={`${ROW_ICON_SIZE} text-tertiary`} />
  }
}

function TodoRow({ todo }: { todo: TodoListItem }) {
  const { t } = useTranslation()
  const label = t(statusLabelKey(todo.status))
  const displayText = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content
  const isDone = todo.status === 'completed'

  return (
    <div className="flex min-h-7 min-w-0 items-center gap-2 text-label text-secondary" data-todo-status={todo.status}>
      <span className={ROW_ICON_SLOT}>
        <TodoStatusIcon status={todo.status} />
      </span>
      <span className={isDone ? 'min-w-0 flex-1 truncate text-tertiary line-through' : 'min-w-0 flex-1 truncate'}>
        {displayText}
      </span>
      <span title={label} className={CHIP_NEUTRAL}>
        {label}
      </span>
    </div>
  )
}

export function TodoListCard({ activity }: TodoListCardProps) {
  const { t } = useTranslation()
  const todos = getTodoListItems(activity)
  if (todos.length === 0) return null

  const completedCount = todos.filter(todo => todo.status === 'completed').length

  return (
    <div className="flex min-w-0 flex-col" data-todo-card="">
      <div className={WORK_LOG_ROW_WRAPPER}>
        <div className={WORK_LOG_ROW}>
          <span className={ROW_ICON_SLOT}>
            <ListTodo aria-hidden className={`${ROW_ICON_SIZE} text-tertiary`} />
          </span>
          <span className="shrink-0">{t('turnCard.todo.title')}</span>
          <span className="min-w-0 flex-1 truncate tabular-nums text-tertiary">
            {t('turnCard.todo.summary', {
              completed: completedCount,
              count: todos.length,
            })}
          </span>
        </div>
      </div>
      <div className={`${WORK_LOG_BODY} mb-0.5`}>
        {todos.map((todo, index) => (
          <TodoRow key={todo.id ?? `${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    </div>
  )
}
