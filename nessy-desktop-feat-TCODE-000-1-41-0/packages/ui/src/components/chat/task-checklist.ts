/**
 * The session task checklist, extracted from a transcript (R20 Task 5).
 *
 * `agent-sdk/todo-tracking.md` § "Migrate to Task tools" describes exactly this
 * job: "`TaskCreate` adds one item, `TaskUpdate` patches one item by `taskId`",
 * and a consumer should "Accumulate items across calls, or read a snapshot from
 * a `TaskList` tool result" while maintaining "a map keyed by task ID instead of
 * replacing the whole list on every call".
 *
 * Two traps this file exists to avoid:
 *
 * 1. **The id is only in the RESULT.** "The assigned task ID is not in the
 *    `TaskCreate` input. It comes back in the matching `tool_result` as
 *    `{ task: { id, subject } }`." So a create with no result yet has no id and
 *    cannot be keyed.
 * 2. **The stream carries the RAW model shape.** "Claude Code repairs some
 *    close-but-incorrect key names before execution... but that repair is not
 *    reflected in the stream." The host repair never reaches the renderer, so
 *    `id` / `task_id` / `active_form` are read defensively here as well.
 *
 * `TaskOutput`, `TaskStop` and backgrounded `Task`/`Agent` activities belong to
 * the background-task namespace and are deliberately not matched: six tools
 * share a `Task` prefix across two unrelated subsystems.
 */

import { isPlanWritingTool } from '@nessy-agent/shared/utils/toolNames'
import type { ActivityItem, TodoItem } from './TurnCard'

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed'

export interface ChecklistItem extends TodoItem {
  /** Harness-assigned id. Absent on legacy TodoWrite rows, which have none. */
  id?: string
}

const READ_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed'])

/** Tool names arrive bare or `mcp__session__`-prefixed depending on backend. */
function matchesTool(activity: ActivityItem, tool: string): boolean {
  const name = activity.toolName
  return name === tool || (name?.endsWith(`__${tool}`) ?? false)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseResult(content: string | undefined): Record<string, unknown> | undefined {
  if (!content?.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(content)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** The documented repair, applied read-only because the stream never carries it. */
function taskIdOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  return text(input.taskId) ?? text(input.id) ?? text(input.task_id)
}

function activeFormOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  return text(input.activeForm) ?? text(input.active_form)
}

function isTaskToolActivity(activity: ActivityItem): boolean {
  return matchesTool(activity, 'TaskCreate')
    || matchesTool(activity, 'TaskUpdate')
    || matchesTool(activity, 'TaskList')
}

/**
 * Legacy path: the newest whole-list write replaces the whole list, as it always
 * did.
 *
 * P3.295 · "whole-list write" is TWO tool names now, not one.
 * {@link isPlanWritingTool} owns the vocabulary — `TodoWrite` (Pi, claude) and
 * `update_plan` (codex, synthesized by `backend/codex/event-adapter.ts` from
 * `turn/plan/updated`, since the app-server emits no thread item for that call).
 * "Newest wins" already decides between them, which matters because ONE codex
 * session can carry both: its native plan and a bridged `mcp__session__TodoWrite`.
 */
function extractLegacyTodos(activities: ActivityItem[]): ChecklistItem[] {
  const latest = activities
    .filter(activity => isPlanWritingTool(activity.toolName) && activity.toolInput)
    .sort((left, right) => right.timestamp - left.timestamp)[0]
  const todos = latest?.toolInput?.todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap(todo => {
    if (!isRecord(todo)) return []
    const content = text(todo.content)
    const status = typeof todo.status === 'string' ? todo.status : ''
    if (!content || !READ_STATUSES.has(status)) return []
    const activeForm = text(todo.activeForm)
    return [{
      content,
      status: status as ChecklistStatus,
      ...(activeForm ? { activeForm } : {}),
    }]
  })
}

/**
 * Build the checklist from a turn's activities.
 *
 * Task tool activities win over a legacy TodoWrite snapshot: a session that
 * migrated mid-transcript must show the live list, not the frozen one.
 */
export function extractChecklistFromActivities(activities: ActivityItem[]): ChecklistItem[] {
  const relevant = activities.filter(isTaskToolActivity)
  if (relevant.length === 0) return extractLegacyTodos(activities)

  const ordered = [...relevant].sort((left, right) => left.timestamp - right.timestamp)
  const items = new Map<string, ChecklistItem>()

  for (const activity of ordered) {
    if (matchesTool(activity, 'TaskList')) {
      const tasks = parseResult(activity.content)?.tasks
      if (!Array.isArray(tasks)) continue
      // A snapshot is the host's own view, including tasks created before this
      // transcript window, so it replaces the accumulated map wholesale.
      items.clear()
      for (const task of tasks) {
        if (!isRecord(task)) continue
        const id = text(task.id)
        const content = text(task.subject)
        const status = typeof task.status === 'string' ? task.status : ''
        if (!id || !content || !READ_STATUSES.has(status)) continue
        items.set(id, { id, content, status: status as ChecklistStatus })
      }
      continue
    }

    if (matchesTool(activity, 'TaskCreate')) {
      // The id lives in the RESULT, never the input.
      const task = parseResult(activity.content)?.task
      if (!isRecord(task)) continue
      const id = text(task.id)
      const content = text(task.subject) ?? text(activity.toolInput?.subject)
      if (!id || !content) continue
      const activeForm = activeFormOf(activity.toolInput)
      items.set(id, {
        id,
        content,
        status: 'pending',
        ...(activeForm ? { activeForm } : {}),
      })
      continue
    }

    // TaskUpdate patches one item by id; it never creates one.
    const input = activity.toolInput
    const id = taskIdOf(input)
    const existing = id ? items.get(id) : undefined
    if (!id || !existing) continue

    const status = typeof input?.status === 'string' ? input.status : undefined
    if (status === 'deleted') {
      items.delete(id)
      continue
    }
    const subject = text(input?.subject)
    const activeForm = activeFormOf(input)
    items.set(id, {
      ...existing,
      ...(subject ? { content: subject } : {}),
      ...(status && READ_STATUSES.has(status) ? { status: status as ChecklistStatus } : {}),
      ...(activeForm ? { activeForm } : {}),
    })
  }

  return [...items.values()]
}

/** True when this activity belongs to the task-list checklist surface. */
export function isTaskChecklistActivity(activity: ActivityItem): boolean {
  return isTaskToolActivity(activity)
}

/** Label to show for an item: the active form while it is running. */
export function checklistItemLabel(item: ChecklistItem): string {
  return item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content
}
