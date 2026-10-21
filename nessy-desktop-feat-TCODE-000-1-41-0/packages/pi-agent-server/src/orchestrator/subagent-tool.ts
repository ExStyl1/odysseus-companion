import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { OrchestrationProgress, OrchestrationProgressAgent, OrchestrationResultPayload } from '../../../core/src/orchestration.ts';
import { isForkAgentName, resolveAgentDefinition, type AgentDefinition } from '../../../shared/src/agents/index.ts';
import { backgroundTasksDisabled } from '../../../shared/src/config/background-task-settings.ts';
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts';
import { scanToolResultForSecrets } from '../../../shared/src/agent/tool-result-secret-scan.ts';
import { resolveTaskMaxOutputChars } from '../../../shared/src/config/subagent-limits.ts';
import { scanSubagentOutput, subagentReportMarkerLine } from '../../../shared/src/prompts/untrusted-text.ts';
import { saveLargeResponse } from '../../../shared/src/utils/large-response.ts';
import {
  buildSchemaRetryPrompt,
  compileStructuredOutputSchema,
  runSchemaRetryLoop,
  validateStructuredOutputText,
  type CompiledStructuredOutputSchema,
} from '../../../shared/src/structured-output/index.ts';
import { renderStructuredOutputSchemaBlock, withSchemaBlock } from '../structured-output-prompt.ts';
import type { BackgroundTaskRegistry } from './background-task-registry.ts';
import { registerBackgroundChildTask } from './background-child-task.ts';
import {
  BUDGET_EXHAUSTED_SPAWN_MESSAGE,
  isBudgetExhaustedError,
  spawnChildSession,
  withResumedSubagentSlot,
  type ChildSessionResult,
  type SpawnChildSessionArgs,
} from './spawner.ts';

// T1: Claude-Code-class default, matching DEFAULT_PI_ORCHESTRATOR_CONFIG.maxParallelTasks.
// Only used when the host does not pass an orchestrator maxParallelTasks; in
// production buildSessionDefinition always supplies the normalized config value.
const DEFAULT_MAX_PARALLEL_TASKS = 100;

type Mode = 'single' | 'parallel' | 'chain' | 'resume';

export interface SubagentTaskInput {
  agent: string;
  task: string;
  outputSchema?: unknown;
  /**
   * `sub-agents.md:1048` — "When Claude spawns a fork through the Agent tool, it
   * can pass `isolation: "worktree"` so the fork's file edits are written to a
   * separate git worktree instead of your checkout." Fork-only, and advertised
   * only under fork mode, which is the only mode that accepts `agent: "fork"`.
   */
  isolation?: 'worktree';
}

export interface NormalizedSubagentRequest {
  mode: Mode;
  tasks: SubagentTaskInput[];
  resumeAgentId?: string;
  resumeInput?: string;
}

export interface SubagentToolDetails {
  progress?: OrchestrationProgress;
  result?: OrchestrationResultPayload;
  taskId?: string;
  agentIds?: string[];
  backgrounded?: boolean;
  stopped?: boolean;
  isError?: boolean;
  error?: string;
}

export interface SubagentBackgroundedEvent {
  type: 'task_backgrounded';
  toolUseId: string;
  taskId: string;
  kind: 'subagent';
}

export interface SubagentCompletedEvent {
  type: 'task_completed';
  taskId: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
}

export type SubagentBackgroundEvent = SubagentBackgroundedEvent | SubagentCompletedEvent;

export interface CreateSubagentToolOptions {
  getCwd: () => string;
  getRuntimeAgentDefinitions?: () => readonly AgentDefinition[];
  getDepth?: () => number;
  /**
   * Fork mode (sub-agents.md:1006), resolved HOST-side and delivered through the
   * execution manifest. Read once when the tool is built, because it changes the
   * tool's model-visible schema and that schema is hashed into the manifest's
   * `modelContractHash` — a value that varied per call could not be pinned.
   */
  isForkModeEnabled?: () => boolean;
  getMaxParallelTasks?: () => number | undefined;
  /**
   * The session folder, so an over-cap report can spill its full text to
   * `long_responses/` and name the file — `env-vars.md:428`, "the full output is
   * saved to disk and the path is included in the truncated response". The same
   * expression `createWorkflowTool` and `createWebFetchTool` already receive.
   * Absent = no spill, and the truncation marker falls back to naming
   * `get_subagent_result`.
   */
  getSessionPath?: () => string | undefined;
  makeRunId?: () => string;
  spawn?: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>;
  emitEvent?: (event: SubagentBackgroundEvent) => void;
  childSessionPort?: PiChildSessionPort;
  backgroundTasks?: BackgroundTaskRegistry;
}

type TaskState = OrchestrationProgressAgent;
type UpdateCallback = ((result: AgentToolResult<SubagentToolDetails>) => void) | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asTask(value: unknown, label: string): SubagentTaskInput {
  if (!isRecord(value) || typeof value.agent !== 'string' || typeof value.task !== 'string') {
    throw new Error(`${label} must include string agent and task`);
  }
  if (value.isolation !== undefined && value.isolation !== 'worktree') {
    throw new Error(`${label} isolation must be "worktree" when present`);
  }
  return {
    agent: value.agent,
    task: value.task,
    ...(value.outputSchema === undefined ? {} : { outputSchema: value.outputSchema }),
    ...(value.isolation === undefined ? {} : { isolation: 'worktree' as const }),
  };
}

function normalizeMaxParallelTasks(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_PARALLEL_TASKS;
}

export function normalizeSubagentRequest(params: unknown, maxParallelTasks = DEFAULT_MAX_PARALLEL_TASKS): NormalizedSubagentRequest {
  if (!isRecord(params)) throw new Error('subagent arguments must be an object');

  const hasSingle = typeof params.agent === 'string' || typeof params.task === 'string';
  const hasParallel = params.tasks !== undefined;
  const hasChain = params.chain !== undefined;
  const hasResume = params.resume !== undefined;
  const modeCount = [hasSingle, hasParallel, hasChain, hasResume].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error('subagent requires exactly one mode: single {agent, task}, parallel {tasks}, chain {chain}, or resume {resume, input}');
  }

  if (hasResume) {
    if (typeof params.resume !== 'string' || !params.resume.trim()) throw new Error('resume must be a non-empty agent_id');
    if (typeof params.input !== 'string' || !params.input.trim() || Buffer.byteLength(params.input, 'utf8') > 32 * 1024) {
      throw new Error('resume input must be a non-empty string up to 32KB');
    }
    return { mode: 'resume', tasks: [], resumeAgentId: params.resume.trim(), resumeInput: params.input };
  }

  if (hasSingle) {
    return { mode: 'single', tasks: [asTask(params, 'single task')] };
  }

  if (hasParallel) {
    if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
      throw new Error('parallel tasks must be a non-empty array');
    }
    if (params.tasks.length > maxParallelTasks) {
      throw new Error(`parallel tasks cannot exceed ${maxParallelTasks}`);
    }
    return { mode: 'parallel', tasks: params.tasks.map((task, index) => asTask(task, `tasks[${index}]`)) };
  }

  if (!Array.isArray(params.chain) || params.chain.length === 0) {
    throw new Error('chain must be a non-empty array');
  }
  return { mode: 'chain', tasks: params.chain.map((task, index) => asTask(task, `chain[${index}]`)) };
}

/**
 * Child A's text becomes part of child B's TASK PROMPT — a higher-authority sink
 * than the parent's context, and upstream of any neutraliser on a parent-facing
 * return. So the substitution defangs here, not only where results are rendered.
 */
export function applyPreviousSubstitution(task: string, previous: string): string {
  return task.replaceAll('{previous}', scanSubagentOutput(previous));
}

/**
 * The inline output cap, and its spill.
 *
 * `env-vars.md:428`, the `TASK_MAX_OUTPUT_LENGTH` row, in both its sentences:
 * "Maximum number of characters in subagent output before truncation (default:
 * 32000, maximum: 160000). When truncated, the full output is saved to disk and
 * the path is included in the truncated response."
 *
 * CHARACTERS, not UTF-8 bytes. The old fixed byte cap cut Cyrillic — this fork's
 * primary locale — at roughly 16 000 characters instead of the documented
 * 32 000, and CJK worse.
 *
 * The spill uses `saveLargeResponse`, the writer the rest of the app already
 * uses for oversized tool results: same `long_responses/` folder the system
 * prompt already teaches the model to read, same timestamped filename, and it
 * returns `null` instead of throwing. A truncation that cannot name a file falls
 * back to the retrieval handle rather than failing the whole result.
 *
 * P6.786 — THE SECRET SCAN RUNS HERE, ONCE, AHEAD OF BOTH THE SLICE AND THE
 * SPILL. P6.777 moved the scan inside `guardLargeResult` so its five callers
 * were covered in one place, and said at that site that this spill is not one
 * of them: `saveLargeResponse` is called DIRECTLY here, so nothing that guard
 * does can see this text. The parent's truncated view is scrubbed downstream by
 * the Pi event adapter, but the FILE is not — which left the model holding a
 * redacted excerpt beside a path to the unredacted whole, and it has a file
 * reader. Scanning once before both consumers is what makes the two agree.
 *
 * The scanner is pure and returns a clean text by IDENTITY, so a report
 * carrying nothing credential-shaped is byte-for-byte what it was before this
 * existed — including the under-cap early return. It is idempotent behind the
 * adapter's later scan, because a marker carries no vendor prefix. And the cap
 * is applied to the SCANNED text: a marker is not the token it replaced, so
 * measuring the raw length would cut at a boundary the model never sees.
 *
 * The count-only notice is appended to the returned block rather than dropped:
 * before this, the adapter's own scan found the raw token in the truncated view
 * and told the model bytes had been removed. Redacting earlier must not make
 * that disclosure disappear.
 */
function truncateOutput(text: string, spill: { agent: string; sessionPath?: string }): string {
  const cap = resolveTaskMaxOutputChars();
  const scan = scanToolResultForSecrets(text);
  const withNotice = (block: string): string => (scan.notice ? `${block}\n\n${scan.notice}` : block);
  const scanned = scan.text;
  if (scanned.length <= cap) return withNotice(scanned);
  // A character slice cannot split a code point, but it CAN strand a lone high
  // surrogate when the cap lands between the halves of an astral pair.
  const lastUnit = scanned.charCodeAt(cap - 1);
  const keep = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cap - 1 : cap;
  const truncated = scanned.slice(0, keep);
  const saved = spill.sessionPath
    ? saveLargeResponse(spill.sessionPath, 'subagent', spill.agent, scanned)
    : null;
  const recovery = saved
    ? `Full output: ${saved.absolutePath}`
    : 'Retrieve the rest with get_subagent_result(agent_id, verbose: true).';
  return withNotice(`${truncated}\n\n[Output truncated to ${cap} characters for the parent context. ${recovery}]`);
}

/**
 * Validate result text against a caller-supplied JSON Schema through the shared
 * draft-07 engine (R18: replaces the hand-rolled type+required checker that
 * ignored enum/const/$ref/items/format/additionalProperties/oneOf/anyOf/allOf/
 * bounds/pattern). An invalid schema now reports the named gate error instead
 * of silently validating nothing (fail-closed, the documented v2.1.205 shape).
 */
export function parseSchemaResult(text: string, schema: unknown): string | null {
  if (!schema) return null;
  let compiled: CompiledStructuredOutputSchema;
  try {
    compiled = compileStructuredOutputSchema(schema);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const outcome = validateStructuredOutputText(compiled, text);
  return outcome.ok ? null : outcome.errors.join('; ');
}

function resultStatus(results: ChildSessionResult[]): OrchestrationResultPayload['status'] {
  if (results.some(result => result.status === 'aborted')) return 'aborted';
  if (results.some(result => result.status === 'error')) return 'error';
  return 'done';
}

function toResultPayload(kind: OrchestrationResultPayload['kind'], runId: string, results: ChildSessionResult[]): OrchestrationResultPayload {
  return {
    kind,
    runId,
    status: resultStatus(results),
    results: results.map((result, index) => ({
      id: result.agentId ?? `${runId}-${index + 1}`,
      label: result.agent,
      agentType: result.agent,
      status: result.status,
      text: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(result.error ? { error: result.error } : {}),
    })),
  };
}

/** The marker line plus a newline, or '' — see {@link subagentReportMarkerLine}. */
function markerPrefix(...sources: Array<string | undefined>): string {
  const marker = subagentReportMarkerLine(sources.filter(Boolean).join('\n'));
  return marker === null ? '' : `${marker}\n`;
}

/**
 * The lease ID as it may be printed into a tool result.
 *
 * Every ID this host mints is already `worktree-` + `safeWorktreeSegment`'s
 * `[a-z0-9._-]` or a UUID, so this strips nothing in practice. It is applied
 * anyway because the value arrives over the child-session RPC, where
 * `boundResult` bounds `output`/`result` and not this field: an unbounded,
 * newline-carrying string spliced into the block the parent model reads would
 * be a line the child chose. Stripping instead of neutralising is deliberate —
 * the notice is a host FACT, and a suspicion marker on it would say the
 * opposite of what it means.
 */
function sanitizeWorktreeLeaseId(worktreeLeaseId: string): string {
  return worktreeLeaseId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 128);
}

function contentForResults(results: ChildSessionResult[], sessionPath?: string): string {
  return results
    .map((result, index) => {
      const header = `${index + 1}. ${result.agent} - ${result.status}${result.agentId ? `\nagent_id: ${result.agentId}` : ''}`;
      // Neutralise BEFORE truncating so the output cap stays the authoritative
      // bound (defanging can only add zero-width spaces or drop control chars).
      //
      // Error AND text, not error OR text: a child that fails late still returns
      // the work it did, and the error slot used to win outright — so that
      // partial output never reached the model that asked for it.
      const body = [
        ...(result.error ? [scanSubagentOutput(result.error)] : []),
        ...(result.text
          ? [truncateOutput(scanSubagentOutput(result.text), {
            agent: result.agent,
            ...(sessionPath ? { sessionPath } : {}),
          })]
          : []),
      ];
      if (body.length === 0) body.push('(no output)');
      // Q6-D2. `sub-agents.md` § *Choose a model*: "Claude Code shows a warning
      // naming the requested model and the model the subagent runs on." The
      // child RAN, so this is neither an error nor part of its output — it leads
      // the block, because the reader has to know which model produced it, and it
      // is added AFTER the empty check so a silent child still says `(no output)`.
      // Host-resolved ids only, never child text, so no neutralising. F1.225's
      // `[partial]` notice (a host fact too) follows the same rule, one line down.
      if (result.turnLimitReached) body.unshift(turnLimitNotice(result.agent, result.agentId, Boolean(result.text)));
      if (result.modelSubstitution) {
        body.unshift(
          `[model] ${result.agent} asked for "${result.modelSubstitution.requested}", `
          + `which this session cannot serve; it ran on "${result.modelSubstitution.resolved}".`,
        );
      }
      // P6.18 — `sub-agents.md:262`: "A subagent starts in the main
      // conversation's current working directory. … To give the subagent an
      // isolated copy of the repository instead, set `isolation: worktree`."
      //
      // The spawner has carried `worktreeLeaseId` on the result since the lease
      // existed (`spawner.ts:961`) and NOTHING in this package read it — the
      // exact "parsed on one path, read on none" shape. The consequence was not
      // cosmetic: the child's edits land in a directory the parent cannot see,
      // so the parent's next `Read` of a file the child reported changing shows
      // the unedited version, with nothing anywhere saying why. `worktreeLeaseId`
      // is present exactly when the host actually acquired a lease
      // (`SessionManager.ts:13541`), so this line is never a guess about
      // isolation that degraded to `shared`.
      //
      // Path and branch are NOT available here: `PiChildResult` carries the
      // lease ID alone, and widening it is a host-side change outside this row's
      // zone. The ID is what the worktrees panel keys on, so it is the useful
      // half; the residue is stated rather than papered over.
      //
      // Same placement rule as `[model]` above — after the empty check, so a
      // silent isolated child still says `(no output)`. Order between the two
      // notices is not load-bearing.
      if (result.worktreeLeaseId) {
        body.unshift(
          `[worktree] ${result.agent} ran in its own git worktree `
          + `(lease "${sanitizeWorktreeLeaseId(result.worktreeLeaseId)}"), not in this session's `
          + 'working directory, so the files it changed are not visible here.',
        );
      }
      // The marker is decided from the UNTRUNCATED original and prepended
      // OUTSIDE the truncation, so an over-cap report can never lose the very
      // line that says it is suspicious. It leads the block — ahead of the
      // `[ERROR] ` prefix — because `:804` says the scan PREPENDS a line.
      return `${markerPrefix(result.error, result.text)}${result.status === 'error' ? '[ERROR] ' : ''}${header}\n${body.join('\n')}`;
    })
    .join('\n\n');
}

function makeProgress(runId: string, agents: TaskState[]): OrchestrationProgress {
  return {
    kind: 'subagent',
    runId,
    agents: agents.map(agent => ({ ...agent })),
  };
}

function textResult(text: string, details: SubagentToolDetails = {}): AgentToolResult<SubagentToolDetails> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

/**
 * What the model reads when a BACKGROUNDED call published no subagent.
 *
 * It leads the reason instead of replacing it: the spawner already writes a
 * distinct sentence per refusal (budget cap, depth limit, fork-in-fork, the
 * concurrent-subagent ceiling, a call-site `isolation`, a definition whose whole
 * `tools` list resolved to nothing, the host's own `start` refusals), and the
 * model's next move differs per reason, so this only says
 * what every one of them shares and what the success text used to deny.
 *
 * "refused, or stopped before it delivered a result" covers BOTH classes this
 * branch catches, and covering both is the point. Most are refused before
 * anything exists, but a spawn can also be admitted host-side and then stopped
 * or fail with its partial output carried in the failure text — `spawner.ts`,
 * "The child was admitted and may already have produced work; keep it", and the
 * `recoverPartialText` arm beside it. For those an "it never ran" lead would
 * contradict the work printed directly beneath it, and the model would read two
 * statements that disagree. The fix for that contradiction is this wording, NOT
 * narrowing the branch to `status === 'error'`: that would hand the abort class
 * back the success shape and re-open the defect this seam exists to close.
 *
 * "nothing to wait for" rather than "no result will arrive": the run's
 * `task_completed` still fires, carrying this same text rather than a result, so
 * the sentence must not promise a silence the host then breaks. "What follows is
 * all there is" says the same about any partial output below — it is the whole
 * yield, not a first instalment.
 */
export const BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE =
  'No background subagent task is running: every subagent in this call was refused, or stopped before it '
  + 'delivered a result, so there is no work in flight and nothing to wait for. '
  + 'What follows is all there is. Reason:';

/**
 * The value a member's settle slot carries when it ended without admission.
 *
 * Not exported and deliberately empty: `admittedAgentIds` is published through
 * `filter(Boolean)`, so this sentinel is invisible to `agent_ids` by
 * construction rather than by a second filter someone has to remember.
 */
const NOT_ADMITTED = '';

function errorResult(message: string): AgentToolResult<SubagentToolDetails> {
  return textResult(message, {
    isError: true,
    error: message,
  });
}

function completionStatus(status: OrchestrationResultPayload['status']): SubagentCompletedEvent['status'] {
  if (status === 'aborted') return 'stopped';
  if (status === 'error') return 'failed';
  return 'completed';
}

export function clearBackgroundSubagentTasksForTest(): void {
  // Background ownership is host-side; retained as a compatibility test seam.
}

async function runWithSchemaRetry(
  taskInput: SubagentTaskInput,
  agentDef: AgentDefinition,
  baseArgs: Omit<SpawnChildSessionArgs, 'agentDef' | 'task'>,
  spawn: CreateSubagentToolOptions['spawn'],
): Promise<ChildSessionResult> {
  const doSpawn = spawn ?? spawnChildSession;
  if (!taskInput.outputSchema) {
    return doSpawn({ ...baseArgs, agentDef, task: taskInput.task });
  }

  // Draft-07 gate BEFORE any child spawns: an invalid schema fails the call
  // with the named error instead of silently validating nothing.
  let compiled: CompiledStructuredOutputSchema;
  try {
    compiled = compileStructuredOutputSchema(taskInput.outputSchema);
  } catch (error) {
    return {
      agent: agentDef.name,
      status: 'error',
      text: '',
      tokensIn: 0,
      tokensOut: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // R18: the child is judged against the schema, so every attempt — the first
  // and each retry — must SHOW it the schema, not only the validation errors.
  const schemaBlock = await renderStructuredOutputSchemaBlock(
    taskInput.outputSchema as Record<string, unknown>,
  );

  const run = await runSchemaRetryLoop<ChildSessionResult>({
    compiled,
    runAttempt: async ({ attempt, retryErrors }) => {
      const task = withSchemaBlock(
        retryErrors ? buildSchemaRetryPrompt(taskInput.task, retryErrors) : taskInput.task,
        schemaBlock,
      );
      const result = await doSpawn({
        ...baseArgs,
        ...(attempt === 1 ? {} : { requestedAgentId: crypto.randomUUID() }),
        agentDef,
        task,
      });
      // Only a completed child produces validatable text; anything else passes
      // through unchanged (matching the pre-R18 status !== 'done' behavior).
      return { result, text: result.status === 'done' ? result.text : null };
    },
  });

  if (run.kind === 'exhausted') {
    return {
      ...run.result,
      status: 'error',
      error: `outputSchema validation failed: ${run.errors.join('; ')}`,
    };
  }
  return run.result;
}

export function createSubagentTool(options: CreateSubagentToolOptions): ToolDefinition<any, SubagentToolDetails> {
  const maxParallelTasks = normalizeMaxParallelTasks(options.getMaxParallelTasks?.());
  // :1010 — "Claude can spawn a fork by requesting the `fork` subagent type
  // explicitly" — is one of the two things ENABLING FORK MODE changes (:1008).
  // With fork mode off the type is not offered and not accepted, so the advice
  // and the enforcement cannot disagree.
  const forkMode = options.isForkModeEnabled?.() === true;

  return {
    name: 'subagent',
    label: 'Subagent',
    description: forkMode
      ? 'Delegate focused work to scout, planner, worker, reviewer, or workspace-defined subagents, or to the reserved agent "fork". Every call runs in the background: it returns a task id immediately and results arrive asynchronously. Resume runs inline and returns the resumed result directly.'
      : 'Delegate focused work to scout, planner, worker, reviewer, or workspace-defined subagents. Top-level single/parallel/chain calls default to background: they return a task id immediately and results arrive asynchronously. Resume runs inline and returns the resumed result directly.',
    promptSnippet: 'Use subagent for focused single, parallel, chained, or resumed child-agent work. Top-level single/parallel/chain calls default to background and return a task id immediately; resume always runs inline.',
    promptGuidelines: [
      'Call subagent with exactly one mode: single {agent, task}, parallel {tasks}, chain {chain}, or resume {resume, input}.',
      'Use subagent for delegated investigation, implementation, review, or multi-step orchestration.',
      ...(forkMode
        ? [
          'agent:"fork" forks THIS conversation: the child inherits the full message history, system prompt, tool pool, model and permission mode of this session, so the task can be a short instruction with no background re-explained. Use it when a named subagent would need too much context to be useful; use a named subagent when a fresh, isolated context is what you want.',
          // The description half of the two-sided fix (SendUserFile precedent:
          // the model reads the description BEFORE deciding to call, so a
          // guarantee stated only in the result arrives after the decision it
          // should inform).
          'A fork either inherits the whole conversation or does not run: it never falls back to a summary or a fresh child. A failed fork returns "fork-not-started" with the reason, and nothing ran in its place — treat that as work not done, not as a degraded result.',
          'A fork cannot fork again. From inside a fork, delegate to a named subagent instead.',
          'Pass isolation:"worktree" on a fork to write its file edits into a separate git worktree instead of this checkout. It applies to forks only; a named subagent declares isolation in its own definition file.',
        ]
        : []),
      forkMode
        // :783 — the `background` parameter is gone, so every call is a
        // background task and the choice is not yours to make.
        // `Monitor` (capitalised) is the `mcp__session__Monitor` binding name, which
        // `projectPiToolDefinition` rewrites only in compositions where that tool is
        // registered — a composition-dependent model contract, which is the exact
        // shape live-manifest-contract.test.ts exists to catch. Keep it lowercase.
        //
        // R86 — this line used to say results arrive "asynchronously … monitor
        // with get_subagent_result(agent_id, wait:true) or the task_completed
        // event". `task_completed` is emitted host- and renderer-only, so the
        // clause promised a delivery the model never saw, and the remaining
        // advice pointed at a BLOCKING poll — the opposite of what
        // `sub-agents.md` describes ("Claude waits for that notification before
        // reporting the subagent's results"). The host now delivers a completion
        // notification (`SessionManager` `task_completed` →
        // `deliverMonitorEvent`), so the sentence states that instead and
        // demotes the poll to the in-turn case it is actually for.
        ? 'Every single/parallel/chain call runs as a background task and returns task_id and agent_ids immediately. When a background task finishes the host delivers its result to you as a completion notification on a later turn, so end your turn and report the result when it arrives instead of polling for it; use get_subagent_result(agent_id, wait:true) only when you need a child result inside THIS turn, and stop a run with stopTask. Resume always runs inline and returns the resumed result directly (no task id).'
        : 'Top-level single/parallel/chain calls default to background: the call returns task_id and agent_ids immediately. When a background task finishes the host delivers its result to you as a completion notification on a later turn, so end your turn and report the result when it arrives instead of polling for it; use get_subagent_result(agent_id, wait:true) only when you need a child result inside THIS turn, and stop a run with stopTask. Pass background:false to wait inline. Nested calls default to foreground, and resume always runs inline and returns the resumed result directly (no task id).',
    ],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { type: 'string' },
        task: { type: 'string' },
        outputSchema: { type: 'object' },
        // :1048 — the fork's call-site isolation request. Advertised only under
        // fork mode, because fork mode is the only mode that accepts
        // `agent: "fork"` and this argument is refused for anything else. That
        // keeps it out of the default schema, so only the `subagent:fork-mode`
        // contract hash moves.
        ...(forkMode ? { isolation: { type: 'string', enum: ['worktree'] } } : {}),
        // :783 — "fork mode removes the `run_in_background` parameter from the
        // `Agent` tool". Ours is spelled `background`; the rule is the same. The
        // frontmatter `background` field having "no effect" is a CONSEQUENCE of
        // this removal, not an independent rule, so it is not implemented
        // separately — with the parameter gone every path already resolves to a
        // background run.
        ...(forkMode ? {} : { background: { type: 'boolean' } }),
        resume: { type: 'string', description: 'Durable agent_id to resume.' },
        input: { type: 'string', maxLength: 32768, description: 'Bounded input for a resumed subagent.' },
        // NO `maxItems`. It used to be `maxParallelTasks`, which made this
        // schema composition-dependent — and the schema is hashed into
        // `PI_STATIC_MODEL_CONTRACT_HASHES.subagent`, a single constant computed
        // for the default of 100. Any host passing a different
        // `orchestrator.maxParallelTasks` (which this package's README documents
        // as a supported init knob) therefore killed its own first turn with
        // "Pi execution manifest model contract mismatch for subagent".
        //
        // Pinning the advertised bound to the constant instead would have been
        // worse: a session configured for 4 would advertise 100 and reject the
        // fifth task — declared and enforced disagreeing, which is the defect
        // class this whole audit exists to remove. The cap is enforced in
        // `normalizeSubagentRequest`, whose error carries the real number.
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['agent', 'task'],
            properties: {
              agent: { type: 'string' },
              task: { type: 'string' },
              outputSchema: { type: 'object' },
              ...(forkMode ? { isolation: { type: 'string', enum: ['worktree'] } } : {}),
            },
          },
        },
        chain: {
          type: 'array',
          items: {
            type: 'object',
            required: ['agent', 'task'],
            properties: {
              agent: { type: 'string' },
              task: { type: 'string' },
              outputSchema: { type: 'object' },
              ...(forkMode ? { isolation: { type: 'string', enum: ['worktree'] } } : {}),
            },
          },
        },
      },
    } as any,
    prepareArguments: args => args as any,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<SubagentToolDetails>> {
      const request = normalizeSubagentRequest(params, maxParallelTasks);
      if (!forkMode) {
        const forked = request.tasks.find(task => isForkAgentName(task.agent));
        if (forked) {
          return errorResult(
            'fork-mode-disabled: the "fork" subagent type is only available when fork mode is on '
            + '(NESSY_FORK_SUBAGENT=1). Use a named subagent with a self-contained task description instead.',
          );
        }
      }
      // Background default mirrors the spawner: top-level sessions (depth 0)
      // default to background, nested child sessions stay foreground, and an
      // explicit call-site `background` argument always wins.
      //
      // :1011 — under fork mode "[e]very subagent runs in the background,
      // whether it is a fork or a named subagent" — and :783 — "
      // `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` takes precedence over fork mode
      // and keeps subagents in the foreground". Our off switch is
      // `NESSY_DISABLE_BACKGROUND_TASKS`, read through the one predicate every
      // detach site shares, so the precedence is stated once here rather than
      // rediscovered per surface.
      const depth = options.getDepth?.() ?? 0;
      const background = backgroundTasksDisabled()
        ? false
        : forkMode
          ? true
          : isRecord(params) && typeof params.background === 'boolean'
            ? params.background
            : depth === 0;
      if (request.mode === 'resume') {
        if (!options.childSessionPort) return errorResult('child-session-port-unavailable');
        // `sub-agents.md:903` — a resume "takes a fresh slot without checking the
        // limit, so resumes can push the running count past it". Both halves are
        // load-bearing: no check here (the resume is never refused), but the slot
        // IS held, so the count the next Agent-tool spawn is measured against
        // includes resumed children. Leaving resumes uncounted would make the
        // count a lie in exactly the direction that sentence warns about.
        // The host gates a resume at the spending ceiling exactly as it gates a
        // spawn (`:903` — a resume "takes a fresh slot"), and it refuses with
        // the same host-internal code. The spawn path translates that code into
        // a sentence; this path had no catch at all, so the refusal reached the
        // model as `child-session-max-budget-usd-exhausted` — a string that
        // reads as a crash and tells it nothing to do. Same translation, same
        // failure shape, so the two doors cannot disagree.
        let result;
        try {
          result = await withResumedSubagentSlot(
            () => options.childSessionPort!.resume(request.resumeAgentId!, request.resumeInput!),
          );
        } catch (error) {
          if (isBudgetExhaustedError(error)) return errorResult(BUDGET_EXHAUSTED_SPAWN_MESSAGE);
          throw error;
        }
        const raw = result.result ?? result.output ?? result.error ?? '(no output)';
        const content = scanSubagentOutput(raw);
        // A resumed child's final report is a REPORT, so it earns the marker.
        // `content` itself stays unmarked: it is also the UI summary and the
        // `details.error` value, neither of which is a model context.
        const marker = markerPrefix(raw);
        const payload: OrchestrationResultPayload = {
            kind: 'subagent', runId: result.agentId,
            status: result.status === 'failed' ? 'error' : result.status === 'stopped' || result.status === 'interrupted' ? 'aborted' : 'done',
            results: [{ id: result.agentId, label: result.agentId, agentType: result.agentId, status: result.status === 'failed' ? 'error' : result.status === 'stopped' || result.status === 'interrupted' ? 'aborted' : 'done', text: result.result ?? result.output, tokensIn: result.inputTokens ?? 0, tokensOut: result.outputTokens ?? 0, ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }) }],
        };
        if (payload.status === 'error') {
          options.emitEvent?.({ type: 'task_completed', taskId: payload.runId, status: 'failed', summary: content });
        }
        return textResult(`${marker}${turnLimitPrefix(result, `subagent ${result.agentId}`)}${payload.status === 'error' ? `[ERROR] ${content}` : content}`, {
          result: payload,
          ...(payload.status === 'error' ? { isError: true, error: content } : {}),
        });
      }
      const runId = options.makeRunId?.() ?? `subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerTaskId = `owner-${runId}`;
      const backgroundTaskId = `task-${runId}`;
      const agents = request.tasks.map((task, index): TaskState => ({
        id: `agent-${runId}-${index + 1}`,
        label: task.agent,
        agentType: task.agent,
        status: 'queued',
        tokensIn: 0,
        tokensOut: 0,
        toolCalls: 0,
      }));
      const admissionResolvers: Array<(agentId: string) => void> = [];
      const admittedAgentIds: string[] = [];
      let ownerUsed = false;
      /**
       * One promise per member, resolved when that member has SETTLED — which is
       * either of two things and used to be only one of them.
       *
       * It resolves with the agent id from `onAdmitted`, or with `NOT_ADMITTED`
       * when the member's own run ends without ever publishing one (P2.115). The
       * background return below waits on all of them in parallel mode, and while
       * only admission could resolve a slot a PARTIALLY refused fan-out never
       * satisfied that wait: the refused member's slot stayed pending forever, so
       * the supposedly-immediate background return blocked until the ENTIRE run
       * finished and then announced "Started background subagent task" for a run
       * that was already over — the opposite of what a background return is for.
       *
       * `NOT_ADMITTED` is the empty string because `admittedAgentIds` is read
       * through `filter(Boolean)`: a member that settled without admission can
       * never reach `agent_ids`, whatever it resolves with. `resolve` is
       * idempotent, so an admitted member keeps the id `onAdmitted` published and
       * the later settle call is a no-op.
       */
      const admissions = agents.map((_agent, index) => new Promise<string>(resolve => {
        admissionResolvers[index] = resolve;
      }));
      const settleMember = (index: number) => { admissionResolvers[index]?.(NOT_ADMITTED); };
      const emit = (notify: UpdateCallback) => notify?.({
        content: [{ type: 'text', text: `subagent ${request.mode} progress` }],
        details: { progress: makeProgress(runId, agents) },
      });
      const runTask = async (taskInput: SubagentTaskInput, index: number, runSignal: AbortSignal | undefined, notify: UpdateCallback, previous = '') => {
        const agentDef = resolveAgentDefinition(taskInput.agent, {
          runtimeDefinitions: options.getRuntimeAgentDefinitions?.() ?? [],
        });
        const task = request.mode === 'chain' ? applyPreviousSubstitution(taskInput.task, previous) : taskInput.task;
        const taskWithSubstitution = { ...taskInput, task };
        agents[index]!.status = 'running';
        agents[index]!.startedAt ??= new Date().toISOString();
        agents[index]!.lastActivity = 'started';
        emit(notify);
        ownerUsed = true;
        const result = await runWithSchemaRetry(taskWithSubstitution, agentDef, {
          cwd: options.getCwd(),
          signal: runSignal,
          // The gated path, stated explicitly rather than left to the default.
          // `sub-agents.md:898`'s limit "blocks only subagents Claude spawns with
          // the Agent tool" (`:900`) — this is that tool. A fork requested here
          // (`agent: "fork"`) is still an Agent-tool spawn and is gated with the
          // rest; `:902`'s never-blocked fork is the `/subtask` one.
          // Not to be confused with DEFAULT_MAX_PARALLEL_TASKS: that caps one
          // call's task array, which is a different limit.
          limitScope: 'agent-tool',
          depth,
          ownerTaskId,
          ...(background ? { backgroundTaskId } : {}),
          ...(taskInput.isolation ? { isolation: taskInput.isolation } : {}),
          requestedAgentId: agents[index]!.id,
          background,
          hookAgentId: agents[index]!.id,
          onAdmitted: agentId => {
            agents[index]!.id = agentId;
            admittedAgentIds[index] = agentId;
            admissionResolvers[index]?.(agentId);
          },
          onEvent: event => {
            if (event.type === 'tool_execution_start') {
              agents[index]!.toolCalls = (agents[index]!.toolCalls ?? 0) + 1;
            }
            agents[index]!.lastActivity = event.type;
            emit(notify);
          },
        }, options.spawn);
        agents[index]!.status = result.status;
        agents[index]!.endedAt = new Date().toISOString();
        agents[index]!.tokensIn = result.tokensIn;
        agents[index]!.tokensOut = result.tokensOut;
        if (result.costUsd !== undefined) agents[index]!.costUsd = result.costUsd;
        agents[index]!.lastActivity = result.status;
        emit(notify);
        return result;
      };

      const runAll = async (runSignal: AbortSignal | undefined, notify: UpdateCallback) => {
        emit(notify);

        let results: ChildSessionResult[];
        if (request.mode === 'chain') {
          results = [];
          let previous = '';
          for (let index = 0; index < request.tasks.length; index += 1) {
            // `.finally` and not a line after the await: a member that THREW
            // settled too, and leaving its slot pending is the P2.115 hang.
            const result = await runTask(request.tasks[index]!, index, runSignal, notify, previous)
              .finally(() => settleMember(index));
            results.push(result);
            if (result.status !== 'done') break;
            previous = result.text;
          }
        } else {
          results = await Promise.all(request.tasks.map(
            (task, index) => runTask(task, index, runSignal, notify).finally(() => settleMember(index)),
          ));
        }

        const result = toResultPayload('subagent', runId, results);
        return {
          result,
          content: contentForResults(results, options.getSessionPath?.()),
        };
      };
      const runAllAndSeal = async (runSignal: AbortSignal | undefined, notify: UpdateCallback) => {
        try { return await runAll(runSignal, notify); }
        finally {
          if (ownerUsed) await options.childSessionPort?.sealOwnerTask(ownerTaskId);
        }
      };

      if (background) {
        if (signal?.aborted) {
          return errorResult('subagent background task was aborted before start.');
        }

        // The shared registration seam (`background-child-task.ts`): announce,
        // register, report. `/subtask` joins the same one rather than growing a
        // second copy of it.
        const { settled: backgroundRun } = registerBackgroundChildTask({
          taskId: backgroundTaskId,
          toolUseId: toolCallId,
          kind: 'subagent' as const,
          ...(options.emitEvent ? { emitEvent: options.emitEvent } : {}),
          ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
          ...(options.childSessionPort ? { childSessionPort: options.childSessionPort } : {}),
          run: signal => runAllAndSeal(signal, undefined),
          outcome: ({ result, content }) => ({ status: completionStatus(result.status), summary: content }),
        });

        // WAIT FOR EVERY MEMBER TO SETTLE, not for every member to be ADMITTED.
        //
        // Chain mode has always waited on the first member alone, because the
        // rest do not exist until it succeeds. Parallel mode waited on ALL of
        // them, and a refused member's slot could only ever be resolved by the
        // admission it never got: a fan-out where one child was refused — the
        // concurrent-subagent ceiling, the USD cap, an unknown agent name — held
        // this `Promise.all` open until the run itself ended, so the background
        // return blocked for the whole run and then reported a START for work
        // that had already finished (P2.115). It is the same defect the refusal
        // arm below was written for, one door along: a tool naming an outcome it
        // did not observe.
        //
        // With `settleMember` resolving a member's slot when its run ends, this
        // now resolves as soon as every member is either running or over — which
        // is the moment the answer "these are the agents you have" becomes true.
        const requiredAdmissions = request.mode === 'chain' ? admissions.slice(0, 1) : admissions;
        // The run's OUTCOME, not merely the fact that it finished. When the race
        // is won by the run rather than by an admission, this is the only place
        // holding the reason it ended — `.then(() => [])` used to discard it.
        //
        // The rejection arm is deliberately absent, so a run that THREW still
        // rejects this race exactly as before: that class (an unknown agent
        // name, an unconfigured spawner) already reaches the model in the same
        // turn as a failed tool call, and adding a handler here would swallow a
        // rejection `registerBackgroundChildTask` has also already reported.
        let settledRun: { result: OrchestrationResultPayload; content: string } | undefined;
        await Promise.race([
          Promise.all(requiredAdmissions),
          backgroundRun.then(value => { settledRun = value; return []; }),
        ]);

        if (admittedAgentIds.filter(Boolean).length === 0 && settledRun === undefined) {
          // EVERY member settled and NONE was admitted, so the settle race can
          // now win where only the run used to. Nothing is in flight, so there
          // is no background return to make and no id to report — and the
          // refusal arm below needs the run's own reason, which only the run
          // holds. Waiting for it here restores exactly the wait this call had
          // before `settleMember` existed, for exactly the case that still needs
          // it, instead of letting the faster race hand back the success shape
          // with an empty `agent_ids` — the P2.114 lie, re-entered from the
          // side. A rejection propagates as it did when the race carried it.
          settledRun = await backgroundRun;
        }
        const publishedAgentIds = admittedAgentIds.filter(Boolean);
        // NOTHING WAS SPAWNED — refuse here rather than report a start.
        //
        // Every refusal in `spawner.ts` returns a `failure()` BEFORE calling
        // `onAdmitted`: the fork-in-fork rule, a call-site `isolation` on a
        // named subagent, `fork-session-tool-pool-unavailable`, the depth limit,
        // the concurrent-subagent ceiling, the USD budget cap, and every refusal
        // the host throws out of `start`.
        // `runWithSchemaRetry`'s invalid-schema gate does the same without
        // reaching the spawner at all. So a FINISHED run that published no
        // admission is the signature of a call with nothing running, and
        // reporting "Started background subagent task" with an empty
        // `agent_ids` for it let the model read success: the honest sentence
        // rode a later `task_completed: failed` that a capped session may never
        // usefully see. It has to be in this return value, in the turn the
        // model asked.
        //
        // `status !== 'done'`, NOT `status === 'error'`. The abort class belongs
        // here too: a spawn stopped between host-side admission and
        // `onAdmitted` publishes no id either, so narrowing this to errors
        // would hand it back the success shape. Its reason text can carry the
        // partial work the child produced, which is why the lead sentence says
        // "refused, or stopped before it delivered a result" instead of
        // claiming nothing ran.
        //
        // `settledRun.content` is `contentForResults` — the same rendering the
        // foreground refusal and the completion summary use, so one refusal
        // reads the same on all three doors and each reason keeps the sentence
        // the gate that produced it wrote. A partial fan-out is NOT this case:
        // one admitted child means a task really is running and a result really
        // will arrive, so it keeps the success shape below.
        if (publishedAgentIds.length === 0 && settledRun && settledRun.result.status !== 'done') {
          return errorResult(`${BACKGROUND_SPAWN_NOT_RUNNING_MESSAGE}\n${settledRun.content}`);
        }
        return textResult(`Started background subagent task\ntask_id: ${backgroundTaskId}\nagent_ids: ${publishedAgentIds.join(', ')}`, {
          taskId: backgroundTaskId,
          agentIds: publishedAgentIds,
          backgrounded: true,
          progress: makeProgress(runId, agents),
        });
      }

      const { result, content } = await runAllAndSeal(signal, onUpdate);
      if (result.status === 'error') {
        // The Pi tool adapter converts details.isError into a failed execution
        // receipt (and therefore an SDK error result). Emit the structured
        // terminal task event here because that conversion intentionally
        // throws and cannot preserve the orchestration sidecar.
        options.emitEvent?.({
          type: 'task_completed',
          taskId: result.runId,
          status: 'failed',
          summary: content,
        });
      }
      return {
        content: [{ type: 'text', text: content }],
        details: {
          result,
          ...(result.status === 'error' ? { isError: true, error: content } : {}),
        },
      };
    },
  };
}

export function createStopTaskTool(
  childSessionPort?: PiChildSessionPort,
  backgroundTasks?: BackgroundTaskRegistry,
): ToolDefinition<any, SubagentToolDetails> {
  return {
    name: 'stopTask',
    label: 'Stop Task',
    description: 'Stop a background subagent or workflow task by task_id.',
    promptSnippet: 'Use stopTask with task_id to abort a background subagent or workflow returned by background mode.',
    parameters: {
      type: 'object',
      required: ['task_id'],
      additionalProperties: false,
      properties: {
        task_id: {
          type: 'string',
          description: 'Background task id returned by subagent or workflow.',
        },
      },
    } as any,
    prepareArguments: args => args as any,
    async execute(_toolCallId, params): Promise<AgentToolResult<SubagentToolDetails>> {
      const taskId = isRecord(params) && typeof params.task_id === 'string' ? params.task_id.trim() : '';
      if (!taskId) {
        return errorResult('stopTask requires task_id.');
      }

      try {
        if (await backgroundTasks?.stop(taskId)) {
          return textResult(`Stopped task ${taskId}`, { taskId, stopped: true });
        }
      } catch (error) {
        return errorResult(`Failed to stop task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!childSessionPort) return errorResult('child-session-port-unavailable');
      try { await childSessionPort.stopTask(taskId); }
      catch { return errorResult(`Unknown task_id: ${taskId}`); }
      return textResult(`Stopped task ${taskId}`, {
        taskId,
        stopped: true,
      });
    },
  };
}

export function createGetSubagentResultTool(childSessionPort: PiChildSessionPort): ToolDefinition<any, SubagentToolDetails> {
  return {
    name: 'get_subagent_result',
    label: 'Get Subagent Result',
    description: 'Get durable status and result for a subagent by agent_id.',
    promptSnippet: 'Use get_subagent_result to wait for or inspect a durable subagent.',
    parameters: {
      type: 'object', required: ['agent_id'], additionalProperties: false,
      properties: { agent_id: { type: 'string' }, wait: { type: 'boolean' }, verbose: { type: 'boolean' } },
    } as any,
    prepareArguments: args => args as any,
    async execute(_toolCallId, params) {
      const agentId = isRecord(params) && typeof params.agent_id === 'string' ? params.agent_id.trim() : '';
      if (!agentId) return errorResult('get_subagent_result requires agent_id.');
      try {
        const result = await childSessionPort.getResult(agentId, {
          wait: isRecord(params) && params.wait === true,
          verbose: isRecord(params) && params.verbose === true,
        });
        // The real background→model entrance: a durable child's text arrives here,
        // so it is a REPORT and carries the marker line ahead of the header.
        const durable = result.result ?? result.output;
        return textResult(`${markerPrefix(durable)}agent_id: ${result.agentId}\nstatus: ${result.status}\n${turnLimitPrefix(result, `subagent ${result.agentId}`)}${scanSubagentOutput(durable)}`, {
          isError: result.status === 'failed',
          ...(result.error === undefined ? {} : { error: result.error }),
        });
      } catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  };
}

export function createSteerSubagentTool(childSessionPort: PiChildSessionPort): ToolDefinition<any, SubagentToolDetails> {
  return {
    name: 'steer_subagent',
    label: 'Steer Subagent',
    description: 'Send one bounded steering message to a running subagent by agent_id.',
    promptSnippet: 'Use steer_subagent to redirect a running durable subagent.',
    parameters: {
      type: 'object', required: ['agent_id', 'message'], additionalProperties: false,
      properties: { agent_id: { type: 'string' }, message: { type: 'string', maxLength: 32768 } },
    } as any,
    prepareArguments: args => args as any,
    async execute(_toolCallId, params) {
      const agentId = isRecord(params) && typeof params.agent_id === 'string' ? params.agent_id.trim() : '';
      const message = isRecord(params) && typeof params.message === 'string' ? params.message.trim() : '';
      if (!agentId || !message || Buffer.byteLength(message, 'utf8') > 32 * 1024) return errorResult('steer_subagent requires agent_id and a message up to 32KB.');
      try { await childSessionPort.steer(agentId, message); return textResult(`Steered subagent ${agentId}`); }
      catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
    },
  };
}

/**
 * F1.225 — the one notice a parent model reads when a child's run stopped at its
 * `maxTurns` cap, on each door a child's result reaches it through: the spawn's
 * block (`contentForResults`, which a background completion reuses), the resume
 * branch and `get_subagent_result`.
 *
 * `sub-agents.md#resume-subagents`: "When a subagent stops at its `maxTurns`
 * limit, Claude Code marks the returned output as partial. For subagents that
 * return an agent ID, Claude Code also notes in the result that Claude can
 * message the subagent to continue from where it stopped." The two facts are the
 * page's and the wording is ours; the resume hint names THIS runtime's door,
 * `subagent {resume, input}` (F1.224 made a capped child resumable). Composed
 * from host facts only — the name the header already prints and the host-minted
 * agent id — never from child text, so it needs no neutralising.
 */
function turnLimitNotice(who: string, agentId: string | undefined, hasText: boolean): string {
  const what = hasText ? 'so the text below is incomplete' : 'and returned no report';
  const resume = agentId
    ? ` To let it continue from where it stopped, resume it: subagent {resume: "${agentId}", input: "<what to do next>"}.`
    : '';
  return `[partial] ${who} stopped at its maxTurns limit before finishing, ${what}.${resume}`;
}

/** {@link turnLimitNotice} plus a newline for a capped result, or '' — the resume and result doors' form. */
function turnLimitPrefix(result: { agentId: string; turnLimitReached?: true; result?: string; output?: string }, who: string): string {
  if (!result.turnLimitReached) return '';
  return `${turnLimitNotice(who, result.agentId, Boolean(result.result ?? result.output))}\n`;
}
