/**
 * P6.109 — the row reconciliation for a REPLACE-semantics background-task feed.
 *
 * `background_tasks_replaced` carries a runtime's WHOLE live set of background
 * agent tasks. It exists because the claude SDK's own feed
 * (`SDKBackgroundTasksChangedMessage`) is a replacement list with no per-task
 * start or end message to map onto — which is also why the adapter refuses to
 * mint `task_backgrounded` from it, a name `SessionManager` reacts to by
 * retaining a child authority.
 *
 * A pure function rather than three statements inside the event handler, for the
 * reason the rewind menu's decisions are pure too: this renderer has no React
 * DOM harness, so a rule that is not a function is a rule only a source read can
 * check.
 */

import type { BackgroundTask } from '@/atoms/sessions'
import {
  isTerminalBackgroundTask,
  markBackgroundTaskSignal,
} from '@/components/app-shell/background-task-chip-state'

/**
 * The renderer's row. Kept under its P6.109 name so the reconciliation's tests read the same; since UA12.18 it IS
 * the atom's `BackgroundTask`, lifecycle included.
 */
export type ReconcilableTaskRow = BackgroundTask

/** One entry of the wire payload. */
export interface ReplacedBackgroundTask {
  taskId?: unknown
  description?: unknown
  taskType?: unknown
  /** UA12.18 — the starting call's `tool_use_id` (core `BackgroundTaskSummary.toolUseId`), when the runtime saw it. */
  toolUseId?: unknown
}

/** The rows this feed owns: agent and workflow tasks. Shell rows have their own start and end events. */
function isFeedRow(row: Pick<BackgroundTask, 'type'>): boolean {
  return row.type === 'agent' || row.type === 'workflow'
}

/** Claude's `task_type` for a Workflow run (`SDKTaskStartedMessage.workflow_name` is "Only set when task_type is 'local_workflow'"). */
function isWorkflowTaskType(taskType: unknown): boolean {
  return taskType === 'local_workflow' || taskType === 'workflow'
}

/**
 * Swap the AGENT rows for `incoming`, keeping every shell row untouched.
 *
 * Three rules, each of which has a way to be wrong:
 *
 *  - **SHELL rows are not part of this set.** They come from
 *    `shell_backgrounded` and are retired by `shell_killed`; dropping them here
 *    would make a claude membership change delete the user's running commands
 *    from the bar. (UA12.18: an incoming id a shell row already shows is skipped,
 *    so one task is never drawn twice.)
 *  - **every agent row is replaced**, including one left by an earlier runtime.
 *    A runtime switch drains every child before it completes, so a stale agent
 *    row is work that is already gone — and keeping it would offer a Stop that
 *    can only be refused. UA12.18 keeps two exceptions, both without a Stop: a
 *    row already TERMINAL stays until its linger ends, and a LIVE row the set no
 *    longer names is HELD (`unlistedAt`) for the `task_completed` that follows
 *    the shrink — never guessed into a terminal state the runtime did not report.
 *  - **`startTime` and `elapsedSeconds` are carried** for an id that was already
 *    showing. Rebuilding them would restart every visible timer on every
 *    membership change, which is once per task on a busy turn.
 *
 * UA12.18 — the row's `toolUseId` is the starting call the feed names (core
 * `BackgroundTaskSummary.toolUseId`), else the one the row already had, else the
 * task id. Before, it was always the task id, so `task_progress` (addressed by the
 * call) never reached a rebuilt row. Being named in the set is itself a liveness
 * signal: a `stale` row the set still names recovers to `running`. A `local_workflow`
 * task is a `workflow` row.
 *
 * An entry with no usable `taskId` is dropped rather than rendered as a row with
 * no Stop target.
 */
export function reconcileReplacedBackgroundTasks(
  current: readonly ReconcilableTaskRow[],
  incoming: readonly ReplacedBackgroundTask[],
  now: number = Date.now(),
): ReconcilableTaskRow[] {
  const previous = new Map(current.filter(isFeedRow).map(row => [row.id, row]))
  const shownAsShell = new Set(current.filter(row => !isFeedRow(row)).map(row => row.id))
  const named = new Set<string>()
  const replaced: ReconcilableTaskRow[] = []
  for (const task of incoming) {
    if (typeof task?.taskId !== 'string' || task.taskId.length === 0) continue
    if (shownAsShell.has(task.taskId) || named.has(task.taskId)) continue
    named.add(task.taskId)
    const kept = previous.get(task.taskId)
    const intent = typeof task.description === 'string' && task.description
      ? task.description
      : kept?.intent ?? (typeof task.taskType === 'string' && task.taskType ? task.taskType : undefined)
    const toolUseId = typeof task.toolUseId === 'string' && task.toolUseId
      ? task.toolUseId
      : kept?.toolUseId ?? task.taskId
    const type = isWorkflowTaskType(task.taskType) ? 'workflow' : kept?.type ?? 'agent'
    const lifecycle = kept
      ? markBackgroundTaskSignal(kept, now)
      : { status: 'running' as const, lastSignalAt: now }
    replaced.push({
      id: task.taskId,
      type,
      toolUseId,
      startTime: kept?.startTime ?? now,
      elapsedSeconds: kept?.elapsedSeconds ?? 0,
      status: lifecycle.status,
      ...(lifecycle.lastSignalAt === undefined ? {} : { lastSignalAt: lifecycle.lastSignalAt }),
      ...(kept?.completedAt === undefined ? {} : { completedAt: kept.completedAt }),
      // UA12.186 — carried like `startTime`: the set re-states every task it names, so a Dismiss it did not carry
      // was undone by the next membership change (the chip back, its clock at 0).
      ...(kept?.dismissedAt === undefined ? {} : { dismissedAt: kept.dismissedAt }),
      // UA12.210 follow-up — carried for the same reason: a terminal row the set still names is rebuilt here, and only
      // `task_completed` decides the mark, so dropping it hid View Output for a record the host can still read.
      ...(kept?.endOutput ? { endOutput: true as const } : {}),
      // UB14.7 — carried for the same reason: a rebuilt row keeps its live line, its pending Stop and its end summary.
      ...(kept?.activity ? { activity: kept.activity } : {}),
      ...(kept?.stopping ? { stopping: true } : {}),
      ...(kept?.summary ? { summary: kept.summary } : {}),
      ...(intent ? { intent } : {}),
      listed: true,
    })
  }
  // UA12.18 follow-up — a LIVE row the set stops naming is HELD (`unlistedAt`, no Stop) for its end report: Claude's
  // set shrinks before its `task_notification` (see `UNREPORTED_END_GRACE_MS`), and a dropped row left that report
  // nothing to mark. The ticker retires a held row whose report never comes; no terminal state is guessed for it.
  const lingering = current
    .filter(row => isFeedRow(row) && !named.has(row.id))
    .map(row => isTerminalBackgroundTask(row) || row.unlistedAt !== undefined ? row : { ...row, unlistedAt: now })
  return [...current.filter(row => !isFeedRow(row)), ...lingering, ...replaced]
}

/**
 * The tool-result wordings that mean "this call's task now runs in the background", so its result must NOT retire
 * the row. Older and current CLI wordings (upstream v0.14.0 `App.tsx`, measured present in our CLI 2.1.274: 'running
 * in background with ID:', 'moved to the background (ID:', 'backgrounded by user with ID:', 'Monitor started (task').
 * UA12.18 made this list load-bearing for Claude: a row rebuilt from the feed now carries the starting call's id, so
 * a backgrounding Bash or Monitor result would otherwise remove the row it just started.
 */
const BACKGROUNDING_RESULT_PATTERNS: readonly RegExp[] = [
  // UA12.18 follow-up — CLI 2.1.274's Workflow receipt (`grep -aoF` on the native binary, 1 occurrence 2026-10-09).
  /Workflow launched in background\.?\s*Task ID:\s*[a-zA-Z0-9_-]+/i,
  /agentId:\s*[a-zA-Z0-9_-]+/,
  /shell_id:\s*[a-zA-Z0-9_-]+/,
  /"backgroundTaskId":\s*"[a-zA-Z0-9_-]+"/,
  /running in background with ID:\s*[a-zA-Z0-9_-]+/i,
  /backgrounded by user with ID:\s*[a-zA-Z0-9_-]+/i,
  /moved to the background \(ID:\s*[a-zA-Z0-9_-]+\)/i,
  /"resultType":\s*"task"/,
  /Monitor started \(task\s+[a-zA-Z0-9_-]+/,
]

/** Whether a tool result is a backgrounding receipt (see {@link BACKGROUNDING_RESULT_PATTERNS}). */
export function isBackgroundingToolResult(result: unknown): boolean {
  const text = typeof result === 'string' ? result : JSON.stringify(result)
  return Boolean(text) && BACKGROUNDING_RESULT_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * UA12.18 — one event's effect on a session's rows, the body `App.tsx` `handleBackgroundTaskEvent` used to hold,
 * moved here to be testable (this renderer has no DOM harness). Returns `current` itself when nothing changed.
 *
 * The lifecycle (v0.13.4 `App.tsx`, Apache-2.0, adapted): a new row is `running` with `lastSignalAt`; `task_progress`
 * is a liveness signal (a stale row recovers, a terminal one is never resurrected); `task_completed` turns the row
 * TERMINAL with the reported status instead of removing it, and `shell_killed` turns it `stopped` — the ticker in
 * `ActiveTasksBar` prunes both after `TERMINAL_LINGER_MS`. A row already showing under the same TASK id (the
 * Claude feed can name a task before its launch receipt arrives) adopts the receipt's call id instead of being drawn
 * a second time. Background rows are still never cleared on a turn's `complete`/`error`/`interrupted`.
 */
export function applyBackgroundTaskEvent(
  current: readonly BackgroundTask[],
  type: string,
  evt: Record<string, unknown>,
  now: number = Date.now(),
): BackgroundTask[] {
  const same = current as BackgroundTask[]
  if ((type === 'task_backgrounded' && 'taskId' in evt && 'toolUseId' in evt)
    || (type === 'shell_backgrounded' && 'shellId' in evt && 'toolUseId' in evt)) {
    const isShell = type === 'shell_backgrounded'
    const id = (isShell ? evt.shellId : evt.taskId) as string
    const toolUseId = evt.toolUseId as string
    const intent = typeof evt.intent === 'string' && evt.intent ? evt.intent : undefined
    const rowType: BackgroundTask['type'] = isShell ? 'shell' : evt.kind === 'workflow' ? 'workflow' : 'agent'
    // UA12.192 — by TASK id first: a Claude background Bash's `shell_backgrounded` names the same task id AND the same
    // call id as the row the live set already built (`task_started` re-stated it with that call id), and must turn that
    // row into a shell instead of being dropped as a repeat. A receipt that changes nothing returns `current` itself.
    const existing = current.find(t => t.id === id)
    if (existing) {
      const type = isShell || rowType === 'workflow' ? rowType : existing.type
      const adoptIntent = !existing.intent && intent
      if (existing.type === type && existing.toolUseId === toolUseId && !adoptIntent) return same
      return current.map(t => t === existing ? { ...t, type, toolUseId, ...(adoptIntent ? { intent } : {}) } : t)
    }
    if (current.some(t => t.toolUseId === toolUseId)) return same
    return [...current, {
      id,
      type: rowType,
      toolUseId,
      startTime: now,
      elapsedSeconds: 0,
      lastSignalAt: now,
      status: 'running',
      ...(intent ? { intent } : {}),
    }]
  }
  if (type === 'background_tasks_replaced' && Array.isArray(evt.tasks)) {
    // P6.109 — the claude backend's background AGENT tasks, with the payload's own REPLACE semantics.
    return reconcileReplacedBackgroundTasks(current, evt.tasks as ReplacedBackgroundTask[], now)
  }
  if (type === 'task_activity' && typeof evt.taskId === 'string') {
    // UB14.7 — craft-agents-oss v0.15.1 `App.tsx` (Apache-2.0): what a running task is doing (the card's live line and
    // step count), matched by task id or by its call. A liveness signal like `task_progress`; no row, no write.
    const matches = (t: BackgroundTask) => t.id === evt.taskId || (typeof evt.toolUseId === 'string' && t.toolUseId === evt.toolUseId)
    if (!current.some(matches)) return same
    return current.map(t => matches(t)
      ? {
          ...markBackgroundTaskSignal(t, now),
          activity: {
            ...t.activity,
            ...(typeof evt.summary === 'string' ? { summary: evt.summary } : {}),
            ...(typeof evt.lastToolName === 'string' ? { lastToolName: evt.lastToolName } : {}),
            ...(typeof evt.toolUses === 'number' ? { toolUses: evt.toolUses } : {}),
          },
        }
      : t)
  }
  if (type === 'task_progress' && typeof evt.toolUseId === 'string' && typeof evt.elapsedSeconds === 'number') {
    if (!current.some(t => t.toolUseId === evt.toolUseId)) return same
    return current.map(t => t.toolUseId === evt.toolUseId
      ? { ...markBackgroundTaskSignal(t, now), elapsedSeconds: evt.elapsedSeconds as number }
      : t)
  }
  if ((type === 'task_completed' && 'taskId' in evt) || (type === 'shell_killed' && 'shellId' in evt)) {
    const id = type === 'task_completed' ? evt.taskId : evt.shellId
    if (!current.some(t => t.id === id)) return same
    // UA12.186 — a dismissed chip is not brought back to say how its task ended: the end prunes it.
    if (current.some(t => t.id === id && !isShownBackgroundTask(t))) return current.filter(t => t.id !== id)
    const status: BackgroundTask['status'] = type === 'shell_killed'
      ? 'stopped'
      : evt.status === 'failed' || evt.status === 'stopped' ? evt.status : 'completed'
    // UA12.210 — whether the host now holds a record the completed-task read can answer from. `task_completed` is that
    // record's only writer and REPLACES it, so each end decides afresh; `shell_killed` writes none and changes nothing.
    const readable = (field: unknown) => typeof field === 'string' && field !== ''
    const endOutput = type === 'task_completed' ? readable(evt.outputFile) || readable(evt.summary) : undefined
    // UB14.7 (v0.15.1) — the end clears a pending Stop and keeps the end's summary for the card.
    const summary = type === 'task_completed' && readable(evt.summary) ? evt.summary as string : undefined
    return current.map(t => {
      if (t.id !== id) return t
      const { endOutput: previous, stopping: _stopping, ...rest } = t
      const ended = { ...rest, status, completedAt: isTerminalBackgroundTask(t) ? t.completedAt ?? now : now, ...(summary ? { summary } : {}) }
      return (endOutput ?? previous) ? { ...ended, endOutput: true as const } : ended
    })
  }
  if (type === 'tool_result' && 'toolUseId' in evt) {
    // A foreground call finished: its row goes. A backgrounding receipt does NOT end the task it started.
    if (isBackgroundingToolResult(evt.result)) return same
    // UA12.18 follow-up 2 — nor does the launch placeholder of a task the live set still names, whatever its wording
    // (an MCP auto-background, a cloud agent, a teammate): only the set and its `task_completed` end that row.
    const retired = (t: BackgroundTask) => t.toolUseId === evt.toolUseId && !(t.listed && t.unlistedAt === undefined)
    if (!current.some(retired)) return same
    return current.filter(t => !retired(t))
  }
  return same
}

/**
 * UA12.18 — Dismiss: hide one chip. Renderer-only; it never stops the task (Stop does that).
 *
 * UA12.186 — the row is MARKED (`dismissedAt`), not removed. Claude's live set re-states every task it names on each
 * membership change, so a removed row came back from the next update as a new running chip with its clock at 0. The
 * mark rides the reconciliation like `startTime`; the bar draws only {@link isShownBackgroundTask} rows; the task's
 * own end (`task_completed` / `shell_killed`) prunes the row, and the ticker still prunes a terminal one at its linger
 * and a held one at its grace. Kept in the atom, the id still counts as on screen for the scheduled-work read, so a
 * dismissed task is not redrawn there as a static badge.
 */
export function dismissBackgroundTask(
  current: readonly BackgroundTask[],
  taskId: string,
  now: number = Date.now(),
): BackgroundTask[] {
  if (!current.some(t => t.id === taskId && isShownBackgroundTask(t))) return current as BackgroundTask[]
  return current.map(t => t.id === taskId ? { ...t, dismissedAt: now } : t)
}

/** UA12.186 — whether a row is drawn as a chip: every row the user has not dismissed. */
export function isShownBackgroundTask(task: Pick<BackgroundTask, 'dismissedAt'>): boolean {
  return task.dismissedAt === undefined
}
