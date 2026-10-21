/**
 * The registration a DETACHED child run owes the rest of the system.
 *
 * One seam, both callers. The `subagent` tool grew this bookkeeping inline;
 * `/subtask` — which deliberately does not route through that tool, because
 * `sub-agents.md:1013` starts a user fork "with or without the variable set"
 * while the tool refuses `agent: "fork"` outside fork mode — had none of it. The
 * host does not treat it as optional: `createPiDelegatingChildSessionPort`
 * refuses a background child start that carries no `backgroundTaskId`
 * (`pi-background-child-task-id-required`), because a background child outlives
 * the turn that spawned it and needs a RETAINED capability authority to keep
 * running. A fork was therefore refused before any child session existed, which
 * is why no fork row ever reached the agents panel.
 *
 * The three facts a detached run must publish:
 *
 * - `task_backgrounded` — the host retains the capability authority for the id
 *   (`SessionManager.retainPiBackgroundChildAuthority`) and the renderer shows a
 *   running background task;
 * - a `BackgroundTaskRegistry` entry — `stop_task`, capability-generation
 *   teardown and shutdown can reach the run AND its durable descendants;
 * - `task_completed` — the host releases the authority and the renderer clears
 *   the indicator. Without it the retained capability generation leaks for the
 *   life of the session.
 */
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts';
import type { BackgroundTaskRegistry } from './background-task-registry.ts';

export type BackgroundChildTaskKind = 'subagent' | 'workflow';

export type BackgroundChildTaskStatus = 'completed' | 'failed' | 'stopped';

export interface BackgroundChildTaskOutcome {
  status: BackgroundChildTaskStatus;
  summary?: string;
}

/**
 * The lifecycle pair, parameterised by kind so a caller can keep its own
 * narrower event union (the tool surfaces still own their event types).
 */
export type BackgroundChildTaskEvent<K extends BackgroundChildTaskKind> =
  | { type: 'task_backgrounded'; toolUseId: string; taskId: string; kind: K }
  | { type: 'task_completed'; taskId: string; status: BackgroundChildTaskStatus; summary?: string };

export interface RegisterBackgroundChildTaskOptions<T, K extends BackgroundChildTaskKind> {
  taskId: string;
  /**
   * The tool call the run belongs to. `/subtask` is not a tool call, so it
   * passes its own request id: the host ignores this field and the renderer
   * no-ops when no tool message matches it, but the id must still be unique per
   * run or the renderer would collapse two indicators into one.
   */
  toolUseId: string;
  kind: K;
  emitEvent?: (event: BackgroundChildTaskEvent<K>) => void;
  backgroundTasks?: BackgroundTaskRegistry;
  childSessionPort?: Pick<PiChildSessionPort, 'stopTask'>;
  /** The run itself. Started HERE, after `task_backgrounded` has been emitted. */
  run: (signal: AbortSignal) => Promise<T>;
  outcome: (value: T) => BackgroundChildTaskOutcome;
}

/**
 * Announces, registers and reports one detached run. Returns the run's own
 * promise so the caller can still race it against its admissions — the caller
 * decides when to hand control back to the model or the user; this only owns the
 * bookkeeping.
 */
export function registerBackgroundChildTask<T, K extends BackgroundChildTaskKind>(
  options: RegisterBackgroundChildTaskOptions<T, K>,
): { settled: Promise<T> } {
  const controller = new AbortController();
  // Emitted BEFORE the run starts: the host retains the authority when this
  // arrives, so the child start that follows cannot race ahead of it.
  options.emitEvent?.({
    type: 'task_backgrounded',
    toolUseId: options.toolUseId,
    taskId: options.taskId,
    kind: options.kind,
  });
  const settled = options.run(controller.signal);
  const port = options.childSessionPort;
  const unregister = options.backgroundTasks?.register({
    taskId: options.taskId,
    controller,
    settled,
    ...(port
      ? {
        stopDescendants: async () => {
          try {
            await port.stopTask(options.taskId);
          } catch (error) {
            // A run that never admitted a child has no task to stop.
            if (!String(error).includes('unknown-task-id')) throw error;
          }
        },
      }
      : {}),
  }) ?? (() => undefined);
  void settled
    .then(value => {
      const outcome = options.outcome(value);
      options.emitEvent?.({
        type: 'task_completed',
        taskId: options.taskId,
        status: outcome.status,
        ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      });
    })
    .catch(error => {
      options.emitEvent?.({
        type: 'task_completed',
        taskId: options.taskId,
        status: controller.signal.aborted ? 'stopped' : 'failed',
        summary: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(unregister)
    ;
  return { settled };
}
