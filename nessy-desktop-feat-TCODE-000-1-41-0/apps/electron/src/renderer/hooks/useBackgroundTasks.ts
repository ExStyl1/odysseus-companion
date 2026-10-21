/**
 * useBackgroundTasks - Hook for managing active background tasks
 *
 * Tracks background agents and shells per session.
 * Updated via event handlers for task_backgrounded, shell_backgrounded, task_progress.
 */

import { useAtom } from 'jotai'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'
import { dismissBackgroundTask } from '@/lib/background-task-rows'
import type { StopAgentTaskFailureReason, StopAgentTaskResult } from '@nessy-agent/shared/protocol'

/**
 * UB14.7 — craft-agents-oss v0.15.1 `hooks/useBackgroundTasks.ts` (Apache-2.0): how long a chip shows "Stopping…"
 * after the host accepted the stop, waiting for the end event, before it offers Stop again.
 */
export const STOP_CONFIRM_TIMEOUT_MS = 15_000

export interface UseBackgroundTasksOptions {
  /** Session ID to track tasks for */
  sessionId: string
}

export interface UseBackgroundTasksResult {
  /** Active background tasks for this session */
  tasks: BackgroundTask[]
  /** Add a new background task */
  addTask: (task: Omit<BackgroundTask, 'elapsedSeconds'>) => void
  /** Update elapsed time for a task */
  updateTaskProgress: (toolUseId: string, elapsedSeconds: number) => void
  /** Remove a task (when completed or killed) */
  removeTask: (toolUseId: string) => void
  /**
   * Ask the host to stop a task.
   *
   * Resolves `true` when the host confirmed the stop — the row then reads "Stopping…" until its end event
   * (UB14.7) — and `false` when it did not, in which case the row is back to live and the user has been told why.
   */
  killTask: (taskId: string, type: 'agent' | 'shell') => Promise<boolean>
  /**
   * UB12.79 — v0.15.1's `stopTask(task)`, the task chip's Stop: {@link killTask} with the row's OWN type (UA12.135:
   * only a row the list calls a shell goes to `killShell`; an agent, a workflow and any later kind to the agent route).
   */
  stopTask: (task: BackgroundTask) => Promise<boolean>
  /**
   * UB12.79 — v0.15.1's `dismissTask(task)`, the task chip's Dismiss. Ours MARKS the row instead of removing it
   * (UA12.186: the live set would rebuild a removed one) and stops nothing.
   */
  dismissTask: (task: BackgroundTask) => void
}

/** The two host routes that can stop something, injected so the decision is testable. */
export interface StopTaskRoutes {
  killShell: (taskId: string) => Promise<{ success: boolean; error?: string }>
  stopAgentTask: (taskId: string) => Promise<StopAgentTaskResult>
}

export interface StopTaskOutcome {
  /** Only ever true when the host confirmed a stop. */
  removeRow: boolean
  /**
   * Present exactly when `removeRow` is false — the i18n key of the sentence to
   * put in front of the user. A KEY and not a sentence: the host's own strings are
   * backend English and were previously shown verbatim in every locale.
   */
  failureKey?: string
  /**
   * Backend detail for the LOG on the generic `failed` path — never shown to the
   * user, in any locale.
   *
   * IT USED TO BE THE TOAST'S DESCRIPTION, and that was the second half of the
   * defect this type's `failureKey` was invented to fix. Every value that can
   * arrive here is backend English: a thrown route's `error.message`, `killShell`
   * prose we did not recognise, or `stopBackgroundTask`'s `error`. So a Russian
   * user read a translated headline with an untranslated English sentence under
   * it. The protocol says so itself — `StopAgentTaskResult.error` is documented
   * "Backend detail for logs and bug reports — never the whole user-facing text"
   * — while `ClaudeAgent.stopBackgroundTask` claimed the opposite ("The `error` is
   * prose meant for the user") and returned three full English sentences. `dto.ts`
   * wins: the code picks the sentence, the backend string is a diagnostic.
   *
   * The cost is named rather than hidden: on the generic path the user now gets
   * only "Could not stop the task". Buying the precision back means letting arm 1
   * return a `StopAgentTaskFailureReason` of its own, which is a change to the
   * backend contract two runtimes implement — deliberately not done here.
   */
  failureDetail?: string
}

/**
 * The `reason` codes the host can return, mapped to the sentence the user reads.
 *
 * `killShell` is the exception and the reason this is a MAP rather than a switch
 * on `reason`: the shell route predates the code and still answers with prose, so
 * its two known shapes are recognised below and everything else falls to the
 * generic key. Recognising a backend string is a last resort, not the design —
 * the agent route carries a code precisely so it never has to.
 */
const STOP_FAILURE_KEYS: Record<StopAgentTaskFailureReason, string> = {
  'session-not-found': 'toast.stopTaskSessionMissing',
  'unknown-task': 'toast.stopTaskGone',
  'unreachable-mcp': 'toast.stopTaskMcpUnreachable',
  'unreachable-workflow': 'toast.stopTaskWorkflowUnreachable',
  unsupported: 'toast.stopTaskUnsupported',
  failed: 'toast.stopTaskFailed',
}

/** `killShell`'s two known prose answers, which have no `reason` code to read. */
function classifyShellFailure(error: string | undefined): string {
  if (!error) return 'toast.stopTaskFailed'
  if (error.includes('Unknown supervised process handle')) return 'toast.stopTaskGone'
  if (error.includes('Session not found')) return 'toast.stopTaskSessionMissing'
  return 'toast.stopTaskFailed'
}

/**
 * L9 — ASK THE HOST TO STOP SOMETHING, AND REPORT WHAT IT SAID.
 *
 * Exported and pure because the repo has no renderHook/DOM lib (the established
 * pattern for renderer hooks — see `usePluginEnablement`), and because this is
 * the decision that used to be wrong: the row may only be dropped on a confirmed
 * stop.
 *
 * A THROWN CALL IS A FAILURE, not an "already gone". The code this replaced
 * swallowed the shell route's rejection under the comment *"Shell may already be
 * gone - that's OK, still remove from UI"* — reasoning that cannot tell a dead
 * shell from an unreachable host, a transport reconnect or a session that moved.
 * The host says so itself when the handle really is gone ("Unknown supervised
 * process handle"), and that arrives as a `success: false`, so the guess is not
 * needed to keep the common case tidy.
 *
 * NOTHING BACKEND-SHAPED REACHES THE USER AT ALL. `unknown-task-id:bg-9` and
 * "Unknown supervised process handle" used to be the toast body, untranslated in
 * every locale. The outcome carries an i18n KEY; a backend string survives only as
 * `failureDetail`, which the hook LOGS. (This paragraph used to end "as optional
 * detail underneath", and "underneath" was the toast's own description — still on
 * screen, still English, just smaller.)
 */
export async function requestTaskStop(
  taskId: string,
  type: 'agent' | 'shell',
  routes: StopTaskRoutes,
): Promise<StopTaskOutcome> {
  if (type === 'shell') {
    let result: { success: boolean; error?: string } | undefined
    try {
      result = await routes.killShell(taskId)
    } catch (error) {
      return {
        removeRow: false,
        failureKey: 'toast.stopTaskFailed',
        failureDetail: error instanceof Error ? error.message : String(error),
      }
    }
    if (result?.success) return { removeRow: true }
    const failureKey = classifyShellFailure(result?.error)
    return {
      removeRow: false,
      failureKey,
      // Only the generic key needs a detail; the specific ones already say it.
      ...(failureKey === 'toast.stopTaskFailed' && result?.error ? { failureDetail: result.error } : {}),
    }
  }

  let result: StopAgentTaskResult | undefined
  try {
    result = await routes.stopAgentTask(taskId)
  } catch (error) {
    return {
      removeRow: false,
      failureKey: 'toast.stopTaskFailed',
      failureDetail: error instanceof Error ? error.message : String(error),
    }
  }
  if (result?.success) return { removeRow: true }
  const reason = result?.reason
  const failureKey = (reason && STOP_FAILURE_KEYS[reason]) || 'toast.stopTaskFailed'
  return {
    removeRow: false,
    failureKey,
    ...(failureKey === 'toast.stopTaskFailed' && result?.error ? { failureDetail: result.error } : {}),
  }
}

/**
 * UB14.7 — set or clear a row's `stopping` mark (v0.15.1's `stopping`). Clearing touches only a row still marked, so a
 * late timer cannot undo an end; the same array comes back when nothing changed.
 */
export function markTaskStopping(current: BackgroundTask[], taskId: string, stopping: boolean): BackgroundTask[] {
  const target = current.find(t => t.id === taskId)
  if (!target || Boolean(target.stopping) === stopping) return current
  return current.map(t => {
    if (t !== target) return t
    if (stopping) return { ...t, stopping: true }
    const { stopping: _cleared, ...rest } = t
    return rest
  })
}

/**
 * Hook for managing background tasks in a session
 */
export function useBackgroundTasks({ sessionId }: UseBackgroundTasksOptions): UseBackgroundTasksResult {
  const [tasks, setTasks] = useAtom(backgroundTasksAtomFamily(sessionId))
  const { t } = useTranslation()

  const addTask = useCallback((task: Omit<BackgroundTask, 'elapsedSeconds'>) => {
    setTasks(prev => {
      // Check if task already exists (prevent duplicates)
      if (prev.some(t => t.toolUseId === task.toolUseId)) {
        return prev
      }
      // Add new task with 0 elapsed seconds
      return [...prev, { ...task, elapsedSeconds: 0 }]
    })
  }, [setTasks])

  const updateTaskProgress = useCallback((toolUseId: string, elapsedSeconds: number) => {
    setTasks(prev => prev.map(t =>
      t.toolUseId === toolUseId
        ? { ...t, elapsedSeconds }
        : t
    ))
  }, [setTasks])

  const removeTask = useCallback((toolUseId: string) => {
    setTasks(prev => prev.filter(t => t.toolUseId !== toolUseId))
  }, [setTasks])

  /**
   * L9 — THE ROW ONLY DISAPPEARS WHEN SOMETHING ACTUALLY STOPPED.
   *
   * What this replaced was a lie rather than a missing feature. For a shell it
   * called `killShell` and swallowed the answer; for an agent it called NOTHING
   * — `console.warn('Killing agent tasks not yet implemented')` — and then both
   * arms ran "always remove from UI after kill attempt". So the user pressed
   * stop, the row vanished, and the task kept running with nothing anywhere
   * saying so.
   *
   * Now each arm has a real route (`killShell` for shells, `stopAgentTask` for
   * agents), the host's `success` is the ONLY licence to drop the row (UB14.7:
   * to show it stopping; its end event drops it), and a
   * failure is shown instead of logged to a console no user opens — as a
   * TRANSLATED sentence, never as the `unknown-task-id:…` token the first version
   * of this put in the toast body in every locale.
   */
  const killTask = useCallback(async (taskId: string, type: 'agent' | 'shell'): Promise<boolean> => {
    // UB14.7 (v0.15.1) — the chip reads "Stopping…" and its Stop is disabled while the host is asked.
    setTasks(prev => markTaskStopping(prev, taskId, true))
    const outcome = await requestTaskStop(taskId, type, {
      killShell: id => window.electronAPI.killShell(sessionId, id),
      stopAgentTask: id => window.electronAPI.stopAgentTask(sessionId, id),
    })

    if (!outcome.removeRow) {
      setTasks(prev => markTaskStopping(prev, taskId, false))
      // The SENTENCE is translated and the DETAIL is logged, never rendered — see
      // `StopTaskOutcome.failureDetail`. This used to pass the detail as the
      // toast's `description`, which put backend English under a Russian headline.
      if (outcome.failureDetail) {
        console.error(`[useBackgroundTasks] stop ${taskId} (${type}) refused:`, outcome.failureDetail)
      }
      toast.error(t(outcome.failureKey ?? 'toast.stopTaskFailed'))
      return false
    }

    // The host confirmed the stop. UB14.7 (v0.15.1): the row is NOT dropped here any more — the end arrives as an
    // event (`shell_killed` for a shell, the runtime's own `task_completed` for an agent), turns it `stopped`, clears
    // `stopping`, and the chip lingers to say so. No end within STOP_CONFIRM_TIMEOUT_MS: Stop is offered again, so the
    // chip is never shown stopped without that event.
    setTimeout(() => setTasks(prev => markTaskStopping(prev, taskId, false)), STOP_CONFIRM_TIMEOUT_MS)
    return true
  }, [sessionId, setTasks, t])

  const stopTask = useCallback(
    (task: BackgroundTask) => killTask(task.id, task.type === 'shell' ? 'shell' : 'agent'),
    [killTask],
  )

  const dismissTask = useCallback((task: BackgroundTask) => {
    setTasks(prev => dismissBackgroundTask(prev, task.id))
  }, [setTasks])

  return {
    tasks,
    addTask,
    updateTaskProgress,
    removeTask,
    killTask,
    stopTask,
    dismissTask,
  }
}
