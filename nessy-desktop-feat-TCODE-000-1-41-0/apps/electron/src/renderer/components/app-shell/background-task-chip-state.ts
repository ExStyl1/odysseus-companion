/**
 * UA12.18 — the background-task chip lifecycle.
 *
 * Ported from upstream craft-agents-oss `v0.13.4:apps/electron/src/renderer/components/app-shell/background-task-chip-state.ts`
 * (Apache-2.0). Kept: the terminal linger, the `stale` state for a running chip with no signal for
 * {@link RUNNING_SIGNAL_TIMEOUT_MS}, and {@link markBackgroundTaskSignal}. Dropped, with the reason (UA4.11 item 5):
 * `markLiveBackgroundTasksOrphaned` and the `orphaned` state — upstream reaches it only with its keep-alive switch OFF,
 * while Claude here declares `perTaskStopAffordance: true` (an interrupt spares background tasks natively) and Pi's
 * tasks are supervisor-owned, so turn end is not evidence a task died.
 *
 * Added here: {@link isTerminalBackgroundTask} and {@link backgroundTaskElapsedSeconds}, the two rules the chip
 * renders by, kept pure for the reason `lib/background-task-rows.ts` gives — this renderer has no DOM harness.
 */
import type { BackgroundTask } from '@/atoms/sessions'

/** How long a terminal chip (done / failed / stopped) stays visible. */
export const TERMINAL_LINGER_MS = 8_000

/**
 * A missing lifecycle signal is not proof that a task stopped. After this long,
 * replace the spinner with an explicit unknown/stale state while keeping the chip
 * available for a later progress or completion event.
 */
export const RUNNING_SIGNAL_TIMEOUT_MS = 20 * 60_000

/**
 * UA12.18 follow-up — how long a live chip the runtime's live set stopped naming (`unlistedAt`) waits for the report
 * of how its task ended. Claude's set shrinks BEFORE its `task_notification` (the vendored SDK's doc on
 * `SDKBackgroundTasksChangedMessage`: "in practice the level precedes them"), so the report arrives right behind the
 * shrink; one linger's length is the bound. Without a report the chip is retired at the bound, never claimed ended.
 */
export const UNREPORTED_END_GRACE_MS = TERMINAL_LINGER_MS

/** A chip whose task is known to have ended. Only these are pruned, and only these lose the Stop item. */
export function isTerminalBackgroundTask(task: Pick<BackgroundTask, 'status'>): boolean {
  return task.status === 'completed' || task.status === 'failed' || task.status === 'stopped'
}

/**
 * Advance age-based chip state and prune only states known to be terminal. UB14.7 (v0.15.1, Apache-2.0): `keepId` is
 * the chip whose card is open: it stays until the card closes, however long ago its task finished — and, ours, however
 * long a held chip has waited for its end report.
 * Returns the original array when nothing changed to avoid spurious Jotai renders.
 */
export function advanceBackgroundTaskChips(
  tasks: BackgroundTask[],
  now: number,
  keepId?: string | null,
): BackgroundTask[] {
  let changed = false
  const next = tasks
    .map((task) => {
      const lastSignalAt = task.lastSignalAt ?? task.startTime
      if (
        task.status === 'running'
        && task.unlistedAt === undefined
        && now - lastSignalAt >= RUNNING_SIGNAL_TIMEOUT_MS
      ) {
        changed = true
        return { ...task, status: 'stale' as const }
      }
      return task
    })
    .filter((task) => {
      if (task.id === keepId) return true
      // UA12.18 follow-up — a held chip whose end was never reported goes at the grace, with no state claimed for it.
      if (!isTerminalBackgroundTask(task)) return task.unlistedAt === undefined || now - task.unlistedAt < UNREPORTED_END_GRACE_MS
      const age = now - (task.completedAt ?? now)
      return age < TERMINAL_LINGER_MS
    })

  if (next.length !== tasks.length) changed = true
  return changed ? next : tasks
}

/**
 * Record evidence that a task is still alive. A stale task can recover to running,
 * but late progress must never resurrect a truly terminal task.
 */
export function markBackgroundTaskSignal(
  task: BackgroundTask,
  now: number,
): BackgroundTask {
  if (task.status !== 'running' && task.status !== 'stale') return task
  return {
    ...task,
    status: 'running',
    lastSignalAt: now,
  }
}

/**
 * The chip's elapsed seconds. Wall-clock from `startTime` for a live chip — upstream's choice, because several
 * producers (a shell, an async agent, a row rebuilt from the Claude feed before its progress arrives) send no
 * `task_progress` — never below what progress reported. A terminal chip freezes at `completedAt`.
 */
export function backgroundTaskElapsedSeconds(task: BackgroundTask, now: number): number {
  if (isTerminalBackgroundTask(task)) {
    return Math.max(0, Math.floor(((task.completedAt ?? now) - task.startTime) / 1000))
  }
  return Math.max(Math.floor((now - task.startTime) / 1000), task.elapsedSeconds)
}

/**
 * UA12.192 (P-LF-6-4) — how long BEFORE a shell chip's signal runs out the ticker asks the supervisor whether the
 * shell still runs. A shell gets no `task_progress` at all, so a long-running one (a dev server) turned "unknown"
 * after {@link RUNNING_SIGNAL_TIMEOUT_MS} while the host knew it was running — upstream's behaviour, kept for every
 * chip nobody can vouch for. Asking a minute early lets a confirmed shell never show the stale state.
 */
export const SHELL_LIVENESS_PROBE_LEAD_MS = 60_000

/** The part of the host's `readBackgroundTaskOutput` answer the probe reads. */
export interface ShellLivenessAnswer {
  success: boolean
  isRunning?: boolean
}

/**
 * UA12.192 — the Pi shell liveness signal: the supervisor's own `isRunning` (its record's status), read through the
 * same session-scoped route View Output uses. Asks, once per (row, signal) pair recorded in `asked`, about every
 * running or stale SHELL chip still named by its runtime whose last signal is within
 * {@link SHELL_LIVENESS_PROBE_LEAD_MS} of the timeout, and resolves with the ids the supervisor answered running for.
 * UB9.8 — a Claude shell the CLI's live level still names is read from its own task file and answers `isRunning:
 * true` from that level (`SessionManager.readBackgroundTaskOutput`), so it is confirmed too. A codex shell cannot be
 * read there (the Pi store refuses its handle), so it is never confirmed and keeps upstream's stale-after-20-min — it
 * has its own end signal (`task_completed`) instead. An ended answer, a refusal and a thrown read all confirm
 * nothing; the row's end, if it ended, arrives as its own event (L7's `shell_killed`).
 */
export async function probeShellLiveness(
  tasks: readonly BackgroundTask[],
  now: number,
  asked: Set<string>,
  read: (taskId: string) => Promise<ShellLivenessAnswer>,
): Promise<string[]> {
  const due = tasks.filter(task => task.type === 'shell'
    && (task.status === 'running' || task.status === 'stale')
    && task.unlistedAt === undefined
    && now - (task.lastSignalAt ?? task.startTime) >= RUNNING_SIGNAL_TIMEOUT_MS - SHELL_LIVENESS_PROBE_LEAD_MS)
  const answers = await Promise.all(due.map(async task => {
    const key = `${task.id}:${task.lastSignalAt ?? task.startTime}`
    if (asked.has(key)) return undefined
    asked.add(key)
    try {
      const answer = await read(task.id)
      return answer?.success === true && answer.isRunning === true ? task.id : undefined
    } catch {
      return undefined
    }
  }))
  return answers.filter((id): id is string => id !== undefined)
}

/** UA12.192 — record the supervisor's confirmation as a liveness signal ({@link markBackgroundTaskSignal}). */
export function confirmBackgroundTasksLive(
  tasks: BackgroundTask[],
  ids: readonly string[],
  now: number,
): BackgroundTask[] {
  if (ids.length === 0 || !tasks.some(task => ids.includes(task.id))) return tasks
  return tasks.map(task => ids.includes(task.id) ? markBackgroundTaskSignal(task, now) : task)
}
