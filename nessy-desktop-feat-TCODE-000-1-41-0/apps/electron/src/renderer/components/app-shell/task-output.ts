/**
 * L9 — ASK THE HOST FOR A BACKGROUND TASK'S OUTPUT, AND DECIDE WHAT TO SHOW.
 *
 * Pure and exported for the same two reasons `requestTaskStop` is: this repo has
 * no DOM/user-event library, so a decision that lives inside a component's click
 * handler is untestable; and the decision here is the one that used to be wrong.
 *
 * UB14.7 — the menu is gone; the task chip's card (`BackgroundTaskChip.tsx`) calls this from its Open button.
 * UB12.79 — and hands the answer up as an {@link OpenedTaskOutput}: an agent's digest, or the terminal data below.
 *
 * **THE DECISION THAT WAS WRONG.** `TaskActionMenu.handleViewOutput` called
 * `window.electronAPI.getTaskOutput(task.id)` and rendered
 * `output || t('chat.noOutputYet')`. `getTaskOutput` is written in exactly one
 * place — `SessionManager`'s `task_completed` handler — and the renderer removes
 * the row on that same event, so for every row a user could see it returned
 * `null` and the overlay said "No output available yet" about a command that had
 * printed megabytes. `null` from that route never meant "nothing printed"; it
 * meant "I have no record of this". Those two now have different answers.
 *
 * **AN EMPTY STRING IS A SUCCESS AND MUST STAY ONE.** A background command that
 * has not printed yet returns `success: true, output: ''`. That renders as an
 * empty terminal for a task the overlay's own header says is running, which is
 * true. Collapsing it into the failure path — the `output || …` idiom above — is
 * how the honest empty case and the unreadable case became the same sentence.
 *
 * **A FAILURE CARRIES AN i18n KEY, NEVER BACKEND PROSE.** Same rule and same
 * history as `StopTaskOutcome`: `process-recovery-host-owner-unavailable` and
 * `Unknown supervised process handle` are diagnostics for the log, not sentences
 * for a Russian user.
 */

import type { BackgroundTaskOutput, BackgroundTaskOutputFailureReason, BackgroundTaskOutputResult } from '@nessy-agent/shared/protocol'

/** Terminal data for overlay display. */
export interface TerminalOverlayData {
  command: string
  output: string
  description?: string
  toolType: 'bash' | 'grep' | 'glob'
  /** Present once the process ended; absent while it runs, so no exit badge shows. */
  exitCode?: number
  /**
   * True while the process was still running AT THE MOMENT THE OUTPUT WAS READ —
   * the output is a snapshot.
   *
   * A CLAIM WITH A SHELF LIFE, which is why the renderer does not trust it alone.
   * The read is fetch-once, and nothing re-reads while the overlay stays open, so
   * this field keeps saying "still running" after the process has exited — a
   * smaller instance of exactly the class of lie this row removed. `ChatDisplay`
   * therefore ANDs it with the live signal it already holds: whether the task is
   * still in the background-task list. That list is retired by the same events the
   * process's ending produces, so the notice stops the moment the row does.
   */
  isRunning?: boolean
  /** The task this output belongs to — the key the live running check needs. */
  taskId?: string
}

/** UB12.79 — v0.15.1's agent arm of `BackgroundTaskOutput`: an agent's latest message and its recent steps. */
export type AgentTaskOutput = Extract<BackgroundTaskOutput, { kind: 'agent' }>

/**
 * UB12.79 — what the task card's Open hands `ChatDisplay`, v0.15.1's `onOpenTaskOutput(task, output)`.
 *
 * - An AGENT's digest goes as the host gave it, to upstream's markdown overlay (its message, then its recent steps).
 * - A COMMAND's output goes as OUR L9 terminal data, not upstream's `{ kind: 'text', text, truncated }` (the card's
 *   tail): the whole log read afresh, the host's own command line, the exit code and the running fact the terminal
 *   overlay's header states ({@link taskOutputOverlayTitle}).
 */
export type OpenedTaskOutput = AgentTaskOutput | ({ kind: 'text' } & TerminalOverlayData)

/**
 * UB12.79 — v0.15.1's `TaskOutputOverlayState`: one member of `ChatDisplay`'s overlay union (so one close path, and
 * mutual exclusion by construction — see the L9 note there), titled by the task's intent or id as upstream.
 */
export interface TaskOutputOverlayState {
  type: 'task-output'
  title: string
  output: OpenedTaskOutput
}

/**
 * WHAT THE OVERLAY'S HEADER SAYS, and why `isRunning` had to be READ by something.
 *
 * **THE LAST SURVIVING HALF OF THE LIE.** `TerminalOutput` renders the literal
 * `(no output)` when `output` is `''`. That is a finished command's vocabulary, and
 * it is exactly the sentence this row exists to stop telling: a background command
 * that has printed nothing YET is not a command that produced nothing. The reason
 * code half is done — an id nothing owns becomes a translated toast and never opens
 * the overlay at all — but a genuinely running, genuinely silent shell DOES open it,
 * and until this function existed `isRunning` travelled from the process store,
 * through the protocol, into `ChatDisplay`'s overlay state and was read by NOTHING.
 * A field that reaches the screen and changes nothing on it is the same
 * green-and-dead shape as an item no caller can press.
 *
 * **THE HEADER, NOT THE OUTPUT PANE.** The notice goes in the overlay's title,
 * which `TerminalPreviewOverlay` already renders from `description`. Writing it
 * into `output` instead would put words in the command's mouth — a reader copying
 * the pane would carry our prose out with the program's — and teaching the shared
 * `TerminalOutput` a running state would change the activity path that ships today
 * for a read-only surface that does not need it.
 *
 * **A KEY, NOT A SENTENCE**, for the same reason `failureKey` is one: this module is
 * pure and has no `t`. The caller translates.
 *
 * **THE FACT COMES FIRST IN THE SENTENCE, and that is a layout decision rather
 * than a style one.** The title reaches the screen through
 * `FullscreenOverlayBaseHeader` → `PreviewHeaderBadge label={title} shrinkable`,
 * which is one `min-w-0` line with `truncate`, sharing its row with the tool-type
 * badge. So whatever sits at the END of this string is what disappears on a long
 * command — and the first draft put the notice there, which meant the one new fact
 * was the first casualty. `Still running — <subject>` clips the command instead,
 * and a clipped command is recoverable (it is in the output pane and in the row)
 * while a clipped "still running" is silently gone.
 */
export interface TaskOutputOverlayTitle {
  /** The subject the header names: the row's own intent when it has one, else the command. */
  subject: string
  /** Wraps `subject` when the output is a snapshot of something still running. */
  runningKey?: 'chat.taskOutputRunningTitle'
}

export function taskOutputOverlayTitle(
  data: Pick<TerminalOverlayData, 'command' | 'description' | 'isRunning'>,
): TaskOutputOverlayTitle {
  // `command` is never blank — `requestTaskOutput` below falls back through the
  // row's intent to a synthesised label — so the header can never come out empty,
  // which reads as a broken overlay.
  const subject = data.description || data.command
  return data.isRunning ? { subject, runningKey: 'chat.taskOutputRunningTitle' } : { subject }
}

/** The one host route this needs, injected so the decision is testable. */
export interface TaskOutputRoutes {
  readOutput: (taskId: string, cursor?: number) => Promise<BackgroundTaskOutputResult>
}

export type TaskOutputOutcome =
  | {
      show: true
      data: TerminalOverlayData
      /**
       * UB12.79 — present when the host answered with an AGENT's digest (UB9.8: a Claude agent's task file): Open then
       * shows it as upstream's document (message and steps) instead of `data.output`, which carries the message alone.
       */
      agent?: AgentTaskOutput
    }
  | {
      show: false
      /** The i18n key of the sentence to put in front of the user. */
      failureKey: string
      /** Backend detail for the LOG only — never rendered, in any locale. */
      failureDetail?: string
    }

/**
 * The host's reason codes, mapped to the sentence the user reads.
 *
 * `unknown-task` is the honest answer for every id the Pi process store has no
 * record of — a Claude background task, an `mcp`/`workflow` agent task, a stale
 * id — so its sentence must not promise the output exists somewhere else.
 */
const OUTPUT_FAILURE_KEYS: Record<BackgroundTaskOutputFailureReason, string> = {
  'session-not-found': 'toast.taskOutputSessionMissing',
  'unknown-task': 'toast.taskOutputUnknown',
  unavailable: 'toast.taskOutputUnavailable',
  // UB14.7 — upstream v0.15.1's sentence for a read that went wrong (`toast.failedToLoadTaskOutput` is retired with the menu).
  failed: 'chat.backgroundTask.loadFailed',
}

export interface TaskOutputSubject {
  id: string
  type: 'agent' | 'shell' | 'workflow' // UA12.18 — the row's own union; a shell row, or an ENDED one (UA12.192), is offered the read
  intent?: string
}

export async function requestTaskOutput(
  task: TaskOutputSubject,
  routes: TaskOutputRoutes,
  cursor?: number,
): Promise<TaskOutputOutcome> {
  let result: BackgroundTaskOutputResult | undefined
  try {
    result = await routes.readOutput(task.id, cursor)
  } catch (error) {
    // A THROWN CALL IS A FAILURE, not an empty overlay. A transport reconnect and
    // a command that printed nothing must not look the same on screen.
    return {
      show: false,
      failureKey: 'chat.backgroundTask.loadFailed',
      failureDetail: error instanceof Error ? error.message : String(error),
    }
  }

  if (!result?.success) {
    const reason = result?.reason
    const failureKey = (reason && OUTPUT_FAILURE_KEYS[reason]) || 'chat.backgroundTask.loadFailed'
    return {
      show: false,
      failureKey,
      // Only the generic key needs a detail; the specific ones already say it.
      ...(failureKey === 'chat.backgroundTask.loadFailed' && result?.error ? { failureDetail: result.error } : {}),
    }
  }

  return {
    show: true,
    data: {
      // The host's own `command` when it has one — the supervisor's ownership map
      // holds the real command line. The row's `intent` is the fallback and the
      // synthesised label is the last resort, so the header is never blank.
      command: result.command || task.intent || `${task.type} task`,
      // `?? ''` and NOT `|| t('chat.noOutputYet')`: see this file's header.
      output: result.output ?? '',
      description: task.intent,
      toolType: 'bash',
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.isRunning === undefined ? {} : { isRunning: result.isRunning }),
      // Carried so the renderer can re-check "is it still running" against the
      // live task list instead of trusting this snapshot forever — see
      // `TerminalOverlayData.isRunning`.
      taskId: task.id,
    },
    // UB12.79 — a text digest (a Claude shell's tail) stays the terminal's: `output` already carries that tail.
    ...(result.digest?.kind === 'agent' ? { agent: result.digest } : {}),
  }
}
