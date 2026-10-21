/**
 * `/subtask` — the fork the USER starts, as opposed to the one the model
 * requests through the `subagent` tool.
 *
 * `sub-agents.md:1013`: "You can start a fork yourself with `/subtask` followed
 * by a task, WITH OR WITHOUT the variable set." That clause is the whole reason
 * this lives beside `createSubagentTool` rather than inside it: the tool refuses
 * `agent: "fork"` when fork mode is off (`:1010` makes offering the type one of
 * the two things enabling fork mode changes), and routing `/subtask` through the
 * tool would inherit that refusal and contradict `:1013`.
 *
 * `:895` says the same thing from the other side — "the limit blocks only
 * subagents Claude spawns with the Agent tool, so your own `/subtask` still
 * starts after Claude reaches the limit" — so a user fork is deliberately not a
 * tool call.
 *
 * Everything else is the shared engine: `spawnChildSession` composes the fork's
 * restrictions from the session (`composeForkRestrictions`), enforces `:1052`'s
 * no-nested-fork rule, and hands the host a child to branch — and
 * `registerBackgroundChildTask` performs the same background-task registration
 * the tool path performs, because "not a tool call" was never meant to mean "not
 * registered". Skipping it is what kept every `/subtask` fork out of the agents
 * panel: the host refuses a background child with no `backgroundTaskId`, so the
 * fork was rejected before a child session existed.
 */
import { FORK_AGENT_DEFINITION } from '../../../shared/src/agents/index.ts';
import { backgroundTasksDisabled } from '../../../shared/src/config/background-task-settings.ts';
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts';
import type { BackgroundTaskRegistry } from './background-task-registry.ts';
import { registerBackgroundChildTask, type BackgroundChildTaskEvent } from './background-child-task.ts';
import { spawnChildSession, type ChildSessionResult, type SpawnChildSessionArgs } from './spawner.ts';

/** `:1013` — "Claude Code names the fork from the first words of the task." */
const NAME_WORD_COUNT = 6;
const NAME_MAX_CHARS = 60;

export function subtaskForkName(task: string): string {
  const words = task.trim().split(/\s+/).filter(Boolean).slice(0, NAME_WORD_COUNT);
  const name = words.join(' ');
  return name.length > NAME_MAX_CHARS ? `${name.slice(0, NAME_MAX_CHARS - 1)}…` : name;
}

export interface StartSubtaskForkOptions {
  task: string;
  cwd: string;
  /** Injection seam for tests; production passes the real spawner. */
  spawn?: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>;
  /** Fires once the fork has settled, for hosts that want the terminal status. */
  onSettled?: (result: ChildSessionResult) => void;
  /**
   * The `/subtask` request id, used as the background task's `toolUseId`. A user
   * fork has no tool call, and the field must still be unique per run.
   */
  requestId?: string;
  /** The lifecycle channel to the host — see `registerBackgroundChildTask`. */
  emitEvent?: (event: BackgroundChildTaskEvent<'subagent'>) => void;
  /** The session's ONE background-task registry, so `stop_task` reaches a fork. */
  backgroundTasks?: BackgroundTaskRegistry;
  childSessionPort?: Pick<PiChildSessionPort, 'stopTask'>;
  /** Injection seam for tests; production mints a uuid. */
  makeRunId?: () => string;
}

export interface StartedSubtaskFork {
  agentId: string;
  name: string;
}

/**
 * Starts a fork and resolves as soon as the child has been admitted — `:1019`,
 * "The fork appears in a panel below your prompt and RUNS IN THE BACKGROUND
 * while you keep working." Awaiting the fork's result here would turn the
 * command into a blocking turn, which is the opposite of the documented shape.
 *
 * A spawn that fails before admission (a fork that cannot inherit, a nested
 * fork, an exhausted depth budget) rejects with the spawner's own reason rather
 * than reporting a started fork that does not exist.
 */
export async function startSubtaskFork(options: StartSubtaskForkOptions): Promise<StartedSubtaskFork> {
  const task = options.task.trim();
  if (!task) throw new Error('subtask-requires-a-task: /subtask needs a task description after the command');

  const name = subtaskForkName(task);
  const spawn = options.spawn ?? spawnChildSession;
  let admitted: ((agentId: string) => void) | undefined;
  const admission = new Promise<string>(resolve => { admitted = resolve; });

  // `:1019` runs a fork in the background; `:783` gives the hard off switch
  // precedence and keeps it in the foreground. Read through the one predicate
  // every detach site shares, and only a fork that IS detached becomes a
  // background task — a foreground fork settles inside the command's own turn.
  const background = !backgroundTasksDisabled();
  const runId = options.makeRunId?.() ?? crypto.randomUUID();
  const backgroundTaskId = `task-fork-${runId}`;
  const startFork = (signal?: AbortSignal): Promise<ChildSessionResult> => spawn({
    agentDef: FORK_AGENT_DEFINITION,
    task,
    cwd: options.cwd,
    // Depth 0: a user fork is started from the main conversation, not from
    // inside a delegated child, so it is the first level like any top-level
    // spawn. `spawnChildSession` still applies `:1052` against the SESSION's own
    // fork flag, which is what refuses a fork inside a fork.
    depth: 0,
    // `:902` — an in-session fork "takes a slot while it runs and is never
    // blocked by the limit". `'fork'` is counted and never gated, and it also
    // keeps the fork out of the workflow semaphore, which is what used to stall
    // a user's `/subtask` behind a background fan-out with no error and no panel.
    limitScope: 'fork',
    background,
    // The host refuses a background child without it, and the id is what makes
    // the fork reachable by `stop_task` and by generation teardown.
    ...(background ? { backgroundTaskId } : {}),
    ...(signal ? { signal } : {}),
    onAdmitted: agentId => admitted?.(agentId),
  });

  const run = background
    ? registerBackgroundChildTask({
      taskId: backgroundTaskId,
      // A user fork is not a tool call; the request id keeps the renderer's
      // background indicator unique per fork.
      toolUseId: options.requestId ?? backgroundTaskId,
      kind: 'subagent' as const,
      ...(options.emitEvent ? { emitEvent: options.emitEvent } : {}),
      ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
      ...(options.childSessionPort ? { childSessionPort: options.childSessionPort } : {}),
      run: signal => startFork(signal),
      outcome: (result: ChildSessionResult) => ({
        status: result.status === 'done' ? 'completed' : result.status === 'aborted' ? 'stopped' : 'failed',
        summary: result.text || result.error || '',
      }),
    }).settled
    : startFork();

  const settled = run.then(result => {
    options.onSettled?.(result);
    return result;
  });
  // Never leave an unhandled rejection behind when admission wins the race.
  settled.catch(() => undefined);

  const outcome = await Promise.race([
    admission.then(agentId => ({ kind: 'admitted' as const, agentId })),
    settled.then(result => ({ kind: 'settled' as const, result })),
  ]);

  if (outcome.kind === 'admitted') return { agentId: outcome.agentId, name };
  if (outcome.result.status === 'done' && outcome.result.agentId) {
    return { agentId: outcome.result.agentId, name };
  }
  throw new Error(outcome.result.error || outcome.result.text || 'subtask-fork-not-started');
}
