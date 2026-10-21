/**
 * `context: fork` — the subagent a SKILL starts, as opposed to the conversation
 * fork `/subtask` starts.
 *
 * `skills.md:569`: "Add `context: fork` to your frontmatter when you want a skill
 * to run in isolation. The skill content becomes the prompt that drives the
 * subagent. It won't have access to your conversation history." That last
 * sentence is the whole design: this is NOT `startSubtaskFork`'s sibling in
 * behaviour, only in plumbing. `FORK_AGENT_DEFINITION` and
 * `composeForkRestrictions` exist to make a child inherit the parent's history,
 * prompt, tools and model; building on them here would give the skill exactly the
 * thing the page says it must not have. The dispatch primitive is the ordinary
 * NAMED-subagent spawn, with the skill body as its task.
 *
 * `:592`'s table says the same from the other side — a skill with `context: fork`
 * takes its system prompt "From agent type" and its prompt from "SKILL.md
 * content" — and `:580` says it plainly: "the skill's subagent is a regular agent
 * type, so the exemption for subagents that fork the conversation doesn't cover
 * it."
 *
 * It lives in the subprocess, beside `/subtask`, rather than host-side where the
 * guardian judge calls `piChildSessionPort.start` directly. A host-started
 * background child would be invisible to `BackgroundTaskRegistry` (so `stopTask`
 * and generation teardown could not reach it, and the renderer would never show
 * it), would bypass the spawner's concurrency accounting, and would become a
 * THIRD composer of child restrictions where the spawner already warns that both
 * existing copies must change together.
 */
import { isForkAgentName, resolveAgentDefinition, type AgentDefinition } from '../../../shared/src/agents/index.ts';
import { backgroundTasksDisabled } from '../../../shared/src/config/background-task-settings.ts';
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts';
import type { BackgroundTaskRegistry } from './background-task-registry.ts';
import { registerBackgroundChildTask, type BackgroundChildTaskEvent } from './background-child-task.ts';
import { spawnChildSession, type ChildSessionResult, type SpawnChildSessionArgs } from './spawner.ts';

/**
 * The fork target when the skill names none. `skills.md:268` leaves the default
 * to the host (upstream picks its `general-purpose` agent); ours is the
 * general-purpose builtin of this fork's four, which is the only one with the
 * full toolset a task-content skill normally needs.
 */
export const DEFAULT_SKILL_FORK_AGENT = 'worker';

export interface StartSkillForkOptions {
  /** The skill's logical name — the label the child carries into the transcript. */
  skillName: string;
  /** `skills.md:268`'s `agent`, or absent for {@link DEFAULT_SKILL_FORK_AGENT}. */
  agent?: string;
  /**
   * `skills.md:265` — with `context: fork` the skill's `model` "sets the forked
   * subagent's model instead, and an excluded value follows the same rules as a
   * subagent model override". Passed as the spawner's per-CALL model, which is
   * one of the two inputs `model-config.md:154` names and which
   * `resolveAgentModelId` already drops (rather than raises on) when the managed
   * allowlist excludes it.
   */
  model?: string;
  /** The skill body, already `$ARGUMENTS`- and placeholder-substituted. */
  prompt: string;
  /** `skills.md:269`'s `background`, already defaulted to `true` by the reader. */
  background: boolean;
  cwd: string;
  getRuntimeAgentDefinitions?: () => readonly AgentDefinition[];
  /** Injection seam for tests; production passes the real spawner. */
  spawn?: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>;
  /** The invoking request id, used as the background task's `toolUseId`. */
  requestId?: string;
  emitEvent?: (event: BackgroundChildTaskEvent<'subagent'>) => void;
  backgroundTasks?: BackgroundTaskRegistry;
  childSessionPort?: Pick<PiChildSessionPort, 'stopTask'>;
  makeRunId?: () => string;
}

export interface StartedSkillFork {
  /** The agent type that actually ran, after the default was applied. */
  agent: string;
  /** What the dispatch DID, which is not always what the frontmatter asked. */
  background: boolean;
  agentId?: string;
  /** The background task id, so the invoking turn can name what it started. */
  taskId?: string;
  /** Terminal status — foreground only; a background fork has not settled yet. */
  status?: ChildSessionResult['status'];
  result?: string;
  error?: string;
}

/**
 * The completion summary a background skill fork publishes.
 *
 * The host's own notice (`buildBackgroundTaskCompletionNotice`) names the KIND
 * and the task id, not the skill, so the skill's name has to lead the summary or
 * the model is told "background subagent task task-skill-… finished" with no way
 * to connect it to the skill it invoked a turn earlier.
 */
export function skillForkCompletionSummary(
  skillName: string,
  result: ChildSessionResult,
): string {
  const outcome = result.status === 'done'
    ? 'completed'
    : result.status === 'aborted' ? 'was stopped' : 'failed';
  const body = [result.error, result.text].filter(Boolean).join('\n\n').trim();
  const headline = `Forked skill "${skillName}" ${outcome}.`;
  return body ? `${headline}\n${body}` : `${headline}\nIt returned no output.`;
}

/**
 * Start one forked skill.
 *
 * Foreground (`background: false`, `:571` — "wait for the result in the turn that
 * invoked the skill") resolves with the child's terminal result. Background —
 * the documented DEFAULT — resolves as soon as the child has been admitted, and
 * the result reaches the conversation later through the background-task
 * completion path every other detached child already uses.
 */
export async function startSkillFork(options: StartSkillForkOptions): Promise<StartedSkillFork> {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error('skill-fork-requires-content: a skill with "context: fork" needs body text to drive the subagent');
  }
  const requested = options.agent?.trim() || DEFAULT_SKILL_FORK_AGENT;
  // `:569` again, enforced rather than assumed. `agent: fork` would resolve to
  // the reserved conversation-fork type, whose entire contract is inheriting the
  // history a forked skill must not see.
  if (isForkAgentName(requested)) {
    throw new Error('skill-fork-agent-must-be-named: "context: fork" runs the skill in a named subagent, so its "agent" cannot be "fork"');
  }
  const agentDef = resolveAgentDefinition(requested, {
    runtimeDefinitions: options.getRuntimeAgentDefinitions?.() ?? [],
  });

  // `:576` — Claude Code also waits "When you set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
  // to 1, which also turns off all other background task features". Ours is
  // `NESSY_DISABLE_BACKGROUND_TASKS`, read through the one predicate every detach
  // site shares, and it outranks the frontmatter exactly as it does for a fork.
  const background = options.background && !backgroundTasksDisabled();
  const runId = options.makeRunId?.() ?? crypto.randomUUID();
  const taskId = `task-skill-${runId}`;

  let admitted: ((agentId: string) => void) | undefined;
  const admission = new Promise<string>(resolve => { admitted = resolve; });

  const startFork = (signal?: AbortSignal): Promise<ChildSessionResult> => (options.spawn ?? spawnChildSession)({
    agentDef,
    task: prompt,
    ...(options.model ? { model: options.model } : {}),
    cwd: options.cwd,
    // Depth 0: a skill fork starts from the conversation that invoked the skill,
    // so it is the first level like any top-level spawn.
    depth: 0,
    // `sub-agents.md:905` — agents that OTHER FEATURES run "follow their own
    // limits instead". A forked skill is not the model's `Agent` tool call
    // (`:900` scopes the concurrent-subagent refusal to that tool) and it is not
    // an in-session conversation fork (`:902`'s never-blocked slot, which `:580`
    // explicitly says does not cover it). So it keeps the workflow semaphore,
    // which bounds it without ever producing a refusal the invoking skill has no
    // way to act on.
    limitScope: 'internal',
    background,
    skillFork: { name: options.skillName },
    // The host refuses a background child without it, and the id is what makes
    // the fork reachable by `stop_task` and by generation teardown.
    ...(background ? { backgroundTaskId: taskId } : {}),
    ...(signal ? { signal } : {}),
    onAdmitted: agentId => admitted?.(agentId),
  });

  const settledFork = (result: ChildSessionResult): StartedSkillFork => ({
    agent: agentDef.name,
    background: false,
    ...(result.agentId ? { agentId: result.agentId } : {}),
    status: result.status,
    result: result.text,
    ...(result.error ? { error: result.error } : {}),
  });

  if (!background) return settledFork(await startFork());

  const { settled } = registerBackgroundChildTask({
    taskId,
    // A forked skill is not a tool call; the invoking request id keeps the
    // renderer's background indicator unique per fork.
    toolUseId: options.requestId ?? taskId,
    kind: 'subagent' as const,
    ...(options.emitEvent ? { emitEvent: options.emitEvent } : {}),
    ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
    ...(options.childSessionPort ? { childSessionPort: options.childSessionPort } : {}),
    run: signal => startFork(signal),
    outcome: (result: ChildSessionResult) => ({
      status: result.status === 'done' ? 'completed' : result.status === 'aborted' ? 'stopped' : 'failed',
      summary: skillForkCompletionSummary(options.skillName, result),
    }),
  });
  // Never leave an unhandled rejection behind when admission wins the race.
  settled.catch(() => undefined);

  const outcome = await Promise.race([
    admission.then(agentId => ({ kind: 'admitted' as const, agentId })),
    settled.then(result => ({ kind: 'settled' as const, result })),
  ]);
  if (outcome.kind === 'admitted') {
    return { agent: agentDef.name, background: true, agentId: outcome.agentId, taskId };
  }
  // Settled before admission: the spawn failed on its way in, and reporting a
  // started fork that does not exist is the one answer that would be wrong.
  if (outcome.result.status === 'done' && outcome.result.agentId) {
    return { agent: agentDef.name, background: true, agentId: outcome.result.agentId, taskId };
  }
  throw new Error(outcome.result.error || outcome.result.text || 'skill-fork-not-started');
}
