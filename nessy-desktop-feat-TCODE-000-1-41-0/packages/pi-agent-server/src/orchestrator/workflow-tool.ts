import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type {
  OrchestrationFailure,
  OrchestrationProgress,
  OrchestrationProgressAgent,
  OrchestrationResultPayload,
} from '@nessy-agent/core';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeThinkingLevel, type ThinkingLevel } from '../../../shared/src/agent/thinking-levels.ts';
import type { PiChildSessionPort } from '../../../shared/src/agent/pi-harness/child-session-port.ts';
import { scanSubagentOutput, subagentReportMarkerLine } from '../../../shared/src/prompts/untrusted-text.ts';
import { parseWorkflowRecipe } from '../../../shared/src/workflows/workflow-loader.ts';
import {
  evaluateLargeWorkflowWarning,
  type WorkflowSizeGuideline,
} from '../../../shared/src/config/workflow-settings.ts';

import { resolveAgentDefinition, type AgentDefinition } from '../../../shared/src/agents/index.ts';
import { registerBackgroundChildTask } from './background-child-task.ts';
import type { BackgroundTaskRegistry } from './background-task-registry.ts';
import { hashWorkflowPrompt, WorkflowJournal } from './journal.ts';
import { compileWorkflowScript, type WorkflowRuntimeApi } from './sandbox.ts';
import { spawnChildSession, type ChildSessionResult, type SpawnChildSessionArgs } from './spawner.ts';
import {
  buildSchemaRetryPrompt,
  compileStructuredOutputSchema,
  runSchemaRetryLoop,
  type CompiledStructuredOutputSchema,
} from '../../../shared/src/structured-output/index.ts';
import { renderStructuredOutputSchemaBlock, withSchemaBlock } from '../structured-output-prompt.ts';
import {
  defaultWorkflowRecipeStore,
  normalizeWorkflowRecipeKey,
  type WorkflowRecipeStore,
} from './workflow-recipes.ts';

// T1: Claude-Code-class runaway backstop, matching
// DEFAULT_PI_ORCHESTRATOR_CONFIG.maxAgents. Caps the per-run agent() call count;
// a per-call `maxAgents` input can only LOWER it (Math.min against this ceiling).
const DEFAULT_MAX_AGENTS = 1000;

/**
 * P6.320 — the per-CALL fan-out cap, and it is NOT invented here.
 * `workflows.md#behavior-and-limits` states it verbatim: "Up to 4,096 items in a
 * single `parallel()` or `pipeline()` call: the runtime rejects a longer list
 * with an error", against the reason "A silent cap would drop part of the
 * workload without telling the script". The same table's "1,000 agents total per
 * run" is `DEFAULT_MAX_AGENTS` above — the positive control that this table is
 * the contract these helpers already follow.
 *
 * The two caps are different things and both are needed. `DEFAULT_MAX_AGENTS`
 * counts `agent()` calls across the whole run and throws on the 1001st, i.e.
 * AFTER 1,000 agents have already been dispatched; a 100,000-item list would
 * therefore run a thousand agents and abort mid-flight, leaving a partial
 * workload behind and no statement of how much was skipped. This cap is checked
 * BEFORE anything is dispatched, and the message carries the offending length so
 * the script author sees the number that was refused rather than a ceiling.
 *
 * A list that does not call `agent()` at all is bounded by nothing else, so the
 * check is on the helper's own input rather than on the agent counter.
 */
const MAX_FANOUT_ITEMS = 4096;

class WorkflowAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAbortError';
  }
}

interface WorkflowInput {
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: unknown;
  phases?: WorkflowPhaseInput[];
  resumeRunId?: string;
  tokenBudget?: number;
  maxAgents?: number;
}

interface WorkflowPhaseInput {
  title: string;
  detail?: string;
}

interface WorkflowAgentInput {
  agent: string;
  task: string;
  label: string;
  model?: string;
  effort?: ThinkingLevel;
  outputSchema?: unknown;
}

interface CreateWorkflowToolOptions {
  getCwd: () => string;
  getRuntimeAgentDefinitions?: () => readonly AgentDefinition[];
  getSessionPath?: () => string | undefined;
  getDepth?: () => number;
  getTokenBudget?: () => number | undefined;
  getMaxAgents?: () => number | undefined;
  makeRunId?: () => string;
  spawn?: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>;
  recipes?: WorkflowRecipeStore;
  getAllowedScriptRoots?: () => readonly string[];
  /**
   * The session's workflow size guideline. ADVICE ONLY: it selects the
   * threshold of the advisory large-run warning and nothing else. It must never
   * be read as a cap — `maxAgents` is the only agent-count limit, and a run
   * past the guideline still completes.
   */
  getSizeGuideline?: () => WorkflowSizeGuideline;
  /** Max-effort sessions already opted in to large runs, so the warning is suppressed. */
  isMaxEffort?: () => boolean;
  emitEvent?: (event: WorkflowBackgroundEvent) => void;
  childSessionPort?: PiChildSessionPort;
  backgroundTasks?: BackgroundTaskRegistry;
}

interface WorkflowBackgroundedEvent {
  type: 'task_backgrounded';
  toolUseId: string;
  taskId: string;
  kind: 'workflow';
}

interface WorkflowCompletedEvent {
  type: 'task_completed';
  taskId: string;
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
}

export type WorkflowBackgroundEvent = WorkflowBackgroundedEvent | WorkflowCompletedEvent;

interface WorkflowToolDetails {
  runId?: string;
  scriptPath?: string;
  transcriptDir?: string;
  progress?: OrchestrationProgress;
  result?: OrchestrationResultPayload;
  journalPath?: string;
  returnValue?: unknown;
  logs?: string[];
  taskId?: string;
  agentIds?: string[];
  backgrounded?: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizePhases(value: unknown): WorkflowPhaseInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('workflow phases must be an array');
  }

  return value.map((phase, index) => {
    if (!isRecord(phase) || typeof phase.title !== 'string' || !phase.title.trim()) {
      throw new Error(`workflow phases[${index}] requires a non-empty title`);
    }
    if (phase.detail !== undefined && typeof phase.detail !== 'string') {
      throw new Error(`workflow phases[${index}].detail must be a string`);
    }
    return {
      title: phase.title,
      ...(phase.detail === undefined ? {} : { detail: phase.detail }),
    };
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed !== 'inherit' ? trimmed : undefined;
}

function normalizeInput(params: unknown): WorkflowInput {
  if (!isRecord(params)) {
    throw new Error('workflow requires script, name, or scriptPath');
  }
  for (const key of ['script', 'name', 'scriptPath'] as const) {
    if (params[key] !== undefined && typeof params[key] !== 'string') {
      throw new Error(`workflow ${key} must be a string`);
    }
  }
  const script = typeof params.script === 'string' && params.script.trim() ? params.script : undefined;
  const name = typeof params.name === 'string' && params.name.trim() ? params.name : undefined;
  const scriptPath = typeof params.scriptPath === 'string' && params.scriptPath.trim()
    ? params.scriptPath
    : undefined;
  if (!script && !name && !scriptPath) {
    throw new Error('workflow requires script, name, or scriptPath');
  }

  return {
    ...(script ? { script } : {}),
    ...(name ? { name } : {}),
    ...(scriptPath ? { scriptPath } : {}),
    args: params.args,
    phases: normalizePhases(params.phases),
    resumeRunId: typeof params.resumeRunId === 'string' && params.resumeRunId.trim() ? params.resumeRunId : undefined,
    tokenBudget: typeof params.tokenBudget === 'number' && params.tokenBudget > 0 ? params.tokenBudget : undefined,
    maxAgents: typeof params.maxAgents === 'number' && params.maxAgents > 0 ? Math.min(params.maxAgents, DEFAULT_MAX_AGENTS) : undefined,
  };
}

function executableWorkflowSource(source: string): string {
  return /^\s*export\s+const\s+meta\b/.test(source)
    ? parseWorkflowRecipe(source).source
    : source;
}

function isWithinRoot(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function readAllowedWorkflowScript(
  scriptPath: string,
  options: CreateWorkflowToolOptions,
): string {
  const requestedPath = resolve(options.getCwd(), scriptPath);
  if (lstatSync(requestedPath).isSymbolicLink()) {
    throw new Error(`workflow scriptPath cannot be a symlink: ${requestedPath}`);
  }
  const canonicalPath = realpathSync(requestedPath);
  if (!lstatSync(canonicalPath).isFile()) {
    throw new Error(`workflow scriptPath is not a file: ${canonicalPath}`);
  }
  const roots = [options.getCwd(), ...(options.getAllowedScriptRoots?.() ?? [])]
    .flatMap(root => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
  if (!roots.some(root => isWithinRoot(root, canonicalPath))) {
    throw new Error(`workflow scriptPath is outside allowed roots: ${requestedPath}`);
  }
  return readFileSync(canonicalPath, 'utf8');
}

async function resolveRawWorkflowSource(
  input: WorkflowInput,
  options: CreateWorkflowToolOptions,
  recipes: WorkflowRecipeStore,
): Promise<string> {
  if (input.scriptPath) {
    return readAllowedWorkflowScript(input.scriptPath, options);
  }
  if (input.script) return input.script;
  const key = normalizeWorkflowRecipeKey(input.name);
  const source = await recipes.get(key);
  if (source === undefined) throw new Error(`Unknown workflow recipe: ${key}`);
  return source;
}

function normalizeAgentInput(promptOrDef: unknown, opts: unknown): WorkflowAgentInput {
  const def = isRecord(promptOrDef) ? promptOrDef : {};
  const options = isRecord(opts) ? opts : {};
  const task = typeof promptOrDef === 'string'
    ? promptOrDef
    : typeof def.task === 'string'
      ? def.task
      : typeof def.prompt === 'string'
        ? def.prompt
        : '';
  const agent = typeof options.agent === 'string'
    ? options.agent
    : typeof def.agent === 'string'
      ? def.agent
      : 'worker';
  const label = typeof options.label === 'string'
    ? options.label
    : typeof def.label === 'string'
      ? def.label
      : agent;
  const model = normalizeOptionalString(options.model === undefined ? def.model : options.model);
  const effort = normalizeThinkingLevel(options.effort === undefined ? def.effort : options.effort);
  const outputSchema = options.outputSchema === undefined ? def.outputSchema : options.outputSchema;

  if (!task.trim()) throw new Error('agent() requires a non-empty task');
  return {
    agent,
    task,
    label,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function resultStatus(
  results: ChildSessionResult[],
  failures: OrchestrationFailure[],
  error?: string,
  aborted = false,
): OrchestrationResultPayload['status'] {
  if (aborted) return 'aborted';
  if (error || failures.length > 0) return 'error';
  if (results.some(result => result.status === 'error')) return 'error';
  if (results.some(result => result.status === 'aborted')) return 'aborted';
  return 'done';
}

/**
 * What the model reads when a BACKGROUNDED run has already ENDED without ever
 * admitting an agent.
 *
 * It leads the run's own report instead of replacing it: every gate writes its
 * own sentence — the spawner's depth limit and USD cap, a host `start` refusal,
 * this file's `maxAgents` ceiling, an unknown agent name, an unresolvable
 * recipe, an invalid `outputSchema`, a script that threw — and the model's next
 * move differs per reason. This says only what all of them share and what
 * "Started background workflow run" used to deny.
 *
 * "refused, stopped, or failed before any agent delivered a result" covers
 * EVERY shape this branch catches, and covering all of them is the point. Most
 * are refused before anything exists, but a run can also be STOPPED after a
 * child was admitted host-side and before `onAdmitted` published its id
 * (`spawner.ts`, "The child was admitted and may already have produced work;
 * keep it", and the `recoverPartialText` arm beside it): that run publishes no
 * id either and ends `aborted`, so an "it never ran" lead would contradict the
 * `workflow aborted` report printed directly beneath it and the model would read
 * two statements that disagree. The fix for that contradiction is this wording,
 * NOT narrowing the branch to `status === 'error'`: that hands the aborted class
 * back the success shape and re-opens the defect this seam exists to close.
 *
 * "nothing to wait for" rather than "no result will arrive": `task_completed`
 * still fires for this run, carrying this same report rather than a result, so
 * the sentence must not promise a silence the host then breaks. "What follows
 * is all there is" says the same about the report below — the phases and log
 * lines the script reached and the reason it stopped are the whole yield, not a
 * first instalment.
 */
export const BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE =
  'No background workflow run is in flight: this run ended without admitting a single agent — it was '
  + 'refused, stopped, or failed before any agent delivered a result — so there is no work in flight and '
  + 'nothing to wait for. What follows is all there is. Reason:';

/**
 * The same message for a run that REPLAYED finished work before it was refused.
 *
 * `resumeRunId` makes the plain sentence above false. The journal arm of
 * `agent()` pushes a cached entry into `results` and returns WITHOUT ever
 * calling `onAdmitted`, so a resumed run can carry delivered work while
 * `admittedAgentIds` is still empty; a later refusal then lands in this branch
 * and "before any agent delivered a result" would be printed directly above a
 * report listing `1. <label> - done` and the child's text. That is the same
 * contradiction P2.27 fixed for a stopped child's partial output, at a narrower
 * door — and the answer is the same one: say what the delivered work IS instead
 * of denying it.
 *
 * The condition is exact rather than heuristic. Only two things push into
 * `results` — the journal arm and a completed spawn — and the real spawner calls
 * `onAdmitted` before its only `done`-producing return (`spawner.ts`, verified
 * at P2.27), while production never injects a `spawn` override
 * (`index.ts` constructs this tool without one). So a `done` entry with an empty
 * `admittedAgentIds` is a journal replay and nothing else.
 *
 * Everything else is carried over verbatim: it is still not a start, there is
 * still nothing in flight, and "What follows is all there is" still says the
 * report below is the whole yield.
 */
export const BACKGROUND_WORKFLOW_REPLAYED_NOT_RUNNING_MESSAGE =
  'No background workflow run is in flight: this run ended without admitting a single agent — it was '
  + 'refused, stopped, or failed — so there is no work in flight and nothing to wait for. The completed '
  + "results below were replayed from an earlier run's journal, not produced by this call. What follows "
  + 'is all there is. Reason:';

/**
 * What the model would read if the race below could ever return with NEITHER an
 * admission nor an outcome. Since the `setTimeout(0)` arm was dropped it cannot,
 * so this is a kept fallback rather than a reachable answer.
 *
 * It used to be the usual production answer, and that is why the timer went. A
 * timer arm always beat the host: admission, the USD cap and every `start`
 * refusal each cost a round trip, so a healthy start, a capped one and a refused
 * one all came back saying only that nothing had been admitted yet, with the
 * reason arriving later on `task_completed`. Waiting for the first outcome
 * instead costs the immediate return and buys a reason the model can act on in
 * the same turn — the trade P2.27 already made at the subagent seam.
 *
 * Kept because it is the only true thing to say in that state, and because
 * deleting it would let a future non-outcome arm fall through to "Started
 * background workflow run" instead. It says exactly what is known — a run
 * exists, is registered, is stoppable by the `task_id` printed under it, and has
 * admitted nothing — and points at the channel that WILL carry the answer, the
 * same completion notification the tool's own guidelines promise.
 */
export const BACKGROUND_WORKFLOW_NOT_YET_ADMITTED_MESSAGE =
  'Background workflow run is starting: no agent has been admitted yet, so this is not yet a confirmed '
  + 'start — the run may still be refused. Its outcome, a result or a refusal, arrives as a completion '
  + 'notification.';

/**
 * What the model reads when a backgrounded run FINISHED SUCCESSFULLY without
 * ever admitting an agent (P2.163).
 *
 * This is a real and legitimate outcome, not a refusal and not an error, and it
 * has exactly two producers: a script that never calls `agent()` — logging,
 * arithmetic, a `return` — and a `resumeRunId` replay answered entirely from the
 * journal. Both were reported as "Started background workflow run", which is
 * false in the one way that matters: the run is OVER. Nothing will arrive later,
 * there is nothing to wait for and nothing to stop, and the model was being
 * pointed at a completion notification for work it had already been handed.
 *
 * Dropping the `setTimeout(0)` arm made this the ALWAYS case rather than the
 * unlucky one: with no clock to beat the script, every agent-less run now
 * reaches this branch, where before a slow one at least got the honest
 * "starting" sentence. One honesty fix uncovered the door behind it.
 *
 * The sentence therefore says the two things "Started" denied — it is finished,
 * and it admitted nothing — and then leads the run's own report, the same
 * `contentForResult` rendering the foreground return, the refusal arms and the
 * completion summary all use. The model gets the result in the turn it asked,
 * which is the whole point of naming the outcome instead of the intent.
 *
 * "no agent was needed" rather than "no agent ran": a journal replay DID have
 * agents, in an earlier run, and its report lists their delivered work directly
 * beneath this line. Denying that here would reproduce the contradiction
 * {@link BACKGROUND_WORKFLOW_REPLAYED_NOT_RUNNING_MESSAGE} exists to fix.
 */
export const BACKGROUND_WORKFLOW_COMPLETED_UNATTENDED_MESSAGE =
  'Background workflow run finished: it completed without admitting an agent of its own — no agent was '
  + 'needed, or its results were replayed from an earlier run\'s journal — so there is nothing in flight, '
  + 'nothing to wait for and no completion notification to expect. What follows is the whole result.';

function backgroundCompletionStatus(status: OrchestrationResultPayload['status']): WorkflowCompletedEvent['status'] {
  if (status === 'aborted') return 'stopped';
  if (status === 'error') return 'failed';
  return 'completed';
}

function toResultPayload(
  runId: string,
  results: ChildSessionResult[],
  labels: string[],
  failures: OrchestrationFailure[],
  error?: string,
  aborted = false,
): OrchestrationResultPayload {
  return {
    kind: 'workflow',
    runId,
    status: resultStatus(results, failures, error, aborted),
    results: results.map((result, index) => ({
      id: result.agentId ?? `${runId}-${index + 1}`,
      label: labels[index] ?? result.agent,
      agentType: result.agent,
      status: result.status,
      text: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ...(result.costUsd === undefined ? {} : { costUsd: result.costUsd }),
      ...(result.error ? { error: result.error } : {}),
    })),
    ...(failures.length > 0 ? { failures: failures.map(failure => ({ ...failure })) } : {}),
  };
}

function contentForResult(result: OrchestrationResultPayload, logs: string[], error?: string): string {
  const header = `workflow ${result.status}`;
  // Every text slot below is child-authored or derived from child text, and all
  // of it lands in the parent's context — defang before rendering.
  const logBlock = logs.length ? `\n\nLogs:\n${logs.map(line => `- ${scanSubagentOutput(line)}`).join('\n')}` : '';
  const failureBlock = result.failures?.length
    ? `\n\nFailures:\n${result.failures.map(failure => {
      const stage = failure.stageIndex === undefined ? '' : ` stage ${failure.stageIndex + 1}`;
      return `- ${failure.helper}[${failure.index}]${stage}: ${scanSubagentOutput(failure.error)}`;
    }).join('\n')}`
    : '';
  const resultBlock = result.results
    .map((entry, index) => `${index + 1}. ${entry.label} - ${entry.status}\nagent_id: ${entry.id}\n${scanSubagentOutput(entry.error || entry.text || '(no output)')}`)
    .join('\n\n');
  // ONE marker line for the whole assembled block, raised when ANY slot matched.
  // The per-slot calls above stay the FRAGMENT scan: a marker inside each entry
  // would put several harness lines in one rendered result and none of them
  // where `sub-agents.md:804` says the line goes, which is the front.
  const marker = subagentReportMarkerLine([
    error ?? '',
    ...logs,
    ...(result.failures ?? []).map(failure => failure.error),
    ...result.results.map(entry => `${entry.error ?? ''}\n${entry.text ?? ''}`),
  ].join('\n'));
  return `${marker === null ? '' : `${marker}\n`}${header}${error ? `\n${scanSubagentOutput(error)}` : ''}${logBlock}${failureBlock}${resultBlock ? `\n\n${resultBlock}` : ''}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkflowAbortError(error: unknown): error is WorkflowAbortError {
  return error instanceof WorkflowAbortError;
}

async function runAgentWithSchemaRetry(
  agentInput: WorkflowAgentInput,
  baseArgs: Omit<SpawnChildSessionArgs, 'task'>,
  spawn: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>,
): Promise<ChildSessionResult> {
  if (!agentInput.outputSchema) {
    return spawn({ ...baseArgs, task: agentInput.task });
  }

  // Draft-07 gate BEFORE any child spawns (same shared engine as the subagent
  // path): an invalid schema fails the stage with the named error.
  let compiled: CompiledStructuredOutputSchema;
  try {
    compiled = compileStructuredOutputSchema(agentInput.outputSchema);
  } catch (error) {
    return {
      agent: agentInput.agent,
      status: 'error',
      text: '',
      tokensIn: 0,
      tokensOut: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // R18: every attempt SHOWS the child the schema it must match (same rule as
  // the subagent path; the errors alone name a schema the child has not seen).
  const schemaBlock = await renderStructuredOutputSchemaBlock(
    agentInput.outputSchema as Record<string, unknown>,
  );

  const run = await runSchemaRetryLoop<ChildSessionResult>({
    compiled,
    runAttempt: async ({ attempt, retryErrors }) => {
      const task = withSchemaBlock(
        retryErrors ? buildSchemaRetryPrompt(agentInput.task, retryErrors) : agentInput.task,
        schemaBlock,
      );
      const result = await spawn({ ...baseArgs, ...(attempt === 1 ? {} : { requestedAgentId: crypto.randomUUID() }), task });
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

/**
 * P2.164 — WHAT THE BACKGROUND ARM COSTS AN AGENT-LESS SCRIPT, AND THE OWNER'S
 * ANSWER TO IT (2026-09-02).
 *
 * P2.131 dropped the `setTimeout(0)` arm from the background launch's
 * `Promise.race`, so a refusal needing a round trip to the host — the USD cap
 * and every `start` refusal — names its own reason in the turn the model asked.
 * **The accepted cost was described as "the background launch no longer returns
 * immediately", framed around waiting for the first spawn outcome. Measured, it
 * is wider than that**: a backgrounded script that never calls `agent()` at all
 * blocks for its ENTIRE duration. `firstAdmission` has nothing to resolve it,
 * `backgroundRun` settles only after `sealOwnerTask`, and the arm that actually
 * settles is `scriptSettled` — the script finishing. That reach was not stated
 * when the trade was taken, so it went back to the owner rather than being
 * absorbed.
 *
 * **ACCEPTED at its full width.** An agent-less "background" workflow is not a
 * background workflow, and blocking is the honest report of what it is: the
 * model is told the run finished when the run finished. The alternative offered
 * — bound it, by settling the turn once the script has demonstrably reached a
 * point where no admission can follow — was declined: it buys latency for the
 * one shape that least deserves it, and pays for it with a second definition of
 * "done" beside the race.
 *
 * **Not a licence to reintroduce a timer.** That is the thing P2.131 removed,
 * and a clock beating a refusal is the defect, not the latency.
 *
 * Recorded HERE rather than beside the race it is about, and the placement is
 * itself the finding: this factory's whole source text, comments included, is
 * the `workflow.execute` source-state digest pinned in
 * `__tests__/harness-contract/fixtures/tool-surface.json`, so a comment inside
 * `createWorkflowTool` moves a contract hash without moving anything the model
 * sees — including a one-line pointer back to here, which is why the race
 * carries none. It is the file's only race, over `firstAdmission`,
 * `scriptSettled` and `backgroundRun`, in the tool's background arm.
 */
export function createWorkflowTool(options: CreateWorkflowToolOptions): ToolDefinition<any, WorkflowToolDetails> {
  return {
    name: 'workflow',
    label: 'Workflow',
    description: 'Run a sandboxed JavaScript orchestration script by inline script, saved name, or scriptPath. scriptPath takes precedence. Inside the script, use agent() to run child sessions. Helpers also include workflow(nameOrRef,args), parallel(), pipeline(), phase(), log(), args, and budget.',
    promptSnippet: 'Use workflow with script, a saved name, or scriptPath for multi-phase orchestration with agent(), workflow(nameOrRef,args), parallel(), pipeline(), phase(), log(), args, and budget. A [workflow:<name>] user command means call this tool with that name and pass trailing text as args.input. Use background true for long workflow runs. parallel() and pipeline() return null for failed items; use filter(Boolean) before consuming successful outputs.',
    promptGuidelines: [
      'Call workflow with script, name, or scriptPath; scriptPath takes precedence over script and name.',
      'When a user command expands to [workflow:<name>], call workflow with that name and pass trailing text as args.input.',
      'Use workflow agent(promptOrDef, opts) inside the script to run child sessions.',
      'Use workflow(nameOrRef,args) only with a saved registry key; paths, URLs, and inline source are rejected.',
      'Use workflow parallel() or pipeline() with functions, for example parallel([() => agent({ agent: "scout", task: "Inspect" })]).',
      'Use workflow filter(Boolean) after parallel() or pipeline() when downstream work should skip failed null items.',
      'Use workflow phase(title) before meaningful phases so progress is visible.',
      // R86 — the guideline recommends background for exactly the runs a user
      // most wants answered, and a background workflow has no retrieval tool
      // (there is `get_subagent_result`, keyed on a child agent_id, and no
      // `get_workflow_result`). The host now delivers the run's result as a
      // completion notification, so following this guideline no longer makes the
      // result unreachable — and the sentence says so, because a model that is
      // not told will keep waiting inline.
      'Set background true for long-running workflows; the run returns a task_id immediately and its result is delivered to you as a completion notification on a later turn, so end your turn and report it when it arrives. Use stopTask with the returned task_id to abort a background run.',
    ],
    parameters: {
      type: 'object',
      anyOf: [
        { required: ['script'] },
        { required: ['name'] },
        { required: ['scriptPath'] },
      ],
      additionalProperties: false,
      properties: {
        script: {
          type: 'string',
          description: 'JavaScript body executed with injected helpers: agent(), workflow(nameOrRef,args), parallel(), pipeline(), phase(), log(), args, and budget. Example: phase("Inspect"); const out = await agent({ agent: "scout", task: "Inspect the repo" }); return out;',
        },
        name: { type: 'string', description: 'Saved or plugin workflow name resolved to a script.' },
        scriptPath: { type: 'string', description: 'Workflow script file. Takes precedence over script and name.' },
        args: { description: 'Optional JSON value exposed inside the script as args.' },
        phases: {
          type: 'array',
          description: 'Optional ordered workflow phases shown in progress before agents run.',
          items: {
            type: 'object',
            required: ['title'],
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
        resumeRunId: { type: 'string', description: 'Optional previous workflow runId for journal replay of completed agent() calls.' },
        tokenBudget: { type: 'number', description: 'Optional token budget for this workflow run.' },
        maxAgents: { type: 'number', description: 'Optional maximum number of agent() calls for this workflow run.' },
        background: { type: 'boolean', description: 'Run the workflow in the background and return the run id immediately.' },
      },
    } as any,
    prepareArguments: args => args as any,
    async execute(toolCallId, params, signal, onUpdate): Promise<AgentToolResult<WorkflowToolDetails>> {
      const input = normalizeInput(params);
      const background = isRecord(params) && params.background === true;
      const runId = options.makeRunId?.() ?? `workflow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const ownerTaskId = `owner-${runId}`;
      const backgroundTaskId = `task-${runId}`;
      const journal = new WorkflowJournal(options.getSessionPath?.(), runId, input.resumeRunId);
      const maxAgents = input.maxAgents ?? Math.min(options.getMaxAgents?.() ?? DEFAULT_MAX_AGENTS, DEFAULT_MAX_AGENTS);
      const tokenBudget = input.tokenBudget ?? options.getTokenBudget?.();
      const spawn = options.spawn ?? spawnChildSession;
      const recipes = options.recipes ?? defaultWorkflowRecipeStore;
      const transcriptDir = join(journal.dir, runId);
      const scriptPath = join(transcriptDir, 'workflow.js');
      mkdirSync(transcriptDir, { recursive: true });
      const runDetails = { runId, scriptPath, transcriptDir };
      const states: OrchestrationProgressAgent[] = [];
      const results: ChildSessionResult[] = [];
      const labels: string[] = [];
      const logs: string[] = [];
      // P2.184 — a resume journal that could not be read in full now costs the
      // replay rather than the run, and says so HERE, on the channel the run
      // already has: `logs` is rendered by `contentForResult` into the tool
      // result the model and the user both read. A silent partial replay would
      // be its own defect — the model was told those agent() calls would be
      // skipped.
      for (const warning of journal.loadWarnings) logs.push(warning);
      const failures: OrchestrationFailure[] = [];
      const declaredPhases = input.phases?.map(phase => ({ ...phase })) ?? [];
      let currentPhase = declaredPhases[0]?.title ?? 'start';
      let spentTokens = 0;
      let workflowDepth = 0;
      let runSignal = signal;
      let notify = onUpdate;
      let ownerUsed = false;
      const admittedAgentIds: string[] = [];
      let resolveFirstAdmission!: () => void;
      const firstAdmission = new Promise<void>(resolve => { resolveFirstAdmission = resolve; });

      // `workflows.md` §Cost: the large-run warning is ADVISORY — "it doesn't
      // pause or limit the run". It is therefore computed as a display field on
      // progress and read nowhere else; no branch in this file may consult it.
      const largeRunWarning = (): string | undefined => evaluateLargeWorkflowWarning({
        scheduledAgents: states.length,
        projectedTokens: spentTokens,
        sizeGuideline: options.getSizeGuideline?.() ?? 'unrestricted',
        maxEffort: options.isMaxEffort?.() ?? false,
      });
      const progress = (): OrchestrationProgress => {
        const warning = largeRunWarning();
        return {
          kind: 'workflow',
          runId,
          ...(declaredPhases.length > 0 ? { phases: declaredPhases.map(phase => ({ ...phase })) } : {}),
          agents: states.map(state => ({ ...state })),
          ...(warning ? { warning } : {}),
        };
      };
      const structuredError = (error: string): AgentToolResult<WorkflowToolDetails> => {
        const result = toResultPayload(runId, results, labels, failures, error);
        return {
          content: [{ type: 'text', text: contentForResult(result, logs, error) }],
          details: {
            ...runDetails,
            progress: progress(),
            result,
            journalPath: journal.path,
            logs,
            error,
          },
        };
      };
      let rawSource: string | undefined = input.scriptPath ? undefined : input.script;
      if (rawSource !== undefined) writeFileSync(scriptPath, rawSource);
      let script: string;
      try {
        rawSource ??= await resolveRawWorkflowSource(input, options, recipes);
        // Persist the accepted bytes before parsing metadata or compiling. A
        // malformed metadata prefix is still an auditable workflow run.
        writeFileSync(scriptPath, rawSource);
        script = executableWorkflowSource(rawSource);
        // Valid metadata is not part of the executable body persisted for replay.
        if (script !== rawSource) writeFileSync(scriptPath, script);
      } catch (caught) {
        if (rawSource === undefined) {
          writeFileSync(
            scriptPath,
            `// unresolved workflow invocation\n${JSON.stringify({
              ...(input.name ? { name: input.name } : {}),
              ...(input.scriptPath ? { scriptPath: input.scriptPath } : {}),
            }, null, 2)}\n`,
          );
        }
        return structuredError(errorMessage(caught));
      }
      const emit = () => notify?.({
        content: [{ type: 'text', text: `workflow ${currentPhase}` }],
        details: { progress: progress() },
      });
      const chargeBudget = (result: ChildSessionResult) => {
        spentTokens += result.tokensIn + result.tokensOut;
        if (tokenBudget !== undefined && spentTokens > tokenBudget) {
          throw new WorkflowAbortError(`workflow tokenBudget exceeded: spent ${spentTokens}, budget ${tokenBudget}`);
        }
      };
      const throwIfAborted = () => {
        if (runSignal?.aborted) {
          throw new WorkflowAbortError('workflow was aborted.');
        }
      };

      const runAgent: WorkflowRuntimeApi['agent'] = async (promptOrDef, opts) => {
        throwIfAborted();
        if (states.length >= maxAgents) {
          throw new WorkflowAbortError(`workflow maxAgents exceeded: ${maxAgents}`);
        }

        const agentInput = normalizeAgentInput(promptOrDef, opts);
        const promptHash = hashWorkflowPrompt(agentInput);
        const cached = journal.get(promptHash);
        const state: OrchestrationProgressAgent = {
          id: `agent-${runId}-${states.length + 1}`,
          label: agentInput.label,
          agentType: agentInput.agent,
          phase: currentPhase,
          status: cached ? cached.status : 'queued',
          tokensIn: cached?.tokensIn ?? 0,
          tokensOut: cached?.tokensOut ?? 0,
          toolCalls: 0,
          ...(cached?.costUsd === undefined ? {} : { costUsd: cached.costUsd }),
          lastActivity: cached ? 'journal-replay' : 'queued',
        };
        states.push(state);
        emit();

        if (cached) {
          results.push(cached);
          labels.push(agentInput.label);
          return cached.text;
        }

        const agentDef = resolveAgentDefinition(agentInput.agent, {
          runtimeDefinitions: options.getRuntimeAgentDefinitions?.() ?? [],
        });
        state.status = 'running';
        state.startedAt ??= new Date().toISOString();
        state.lastActivity = 'started';
        emit();

        ownerUsed = true;
        const result = await runAgentWithSchemaRetry(agentInput, {
          agentDef,
          // `sub-agents.md:905` — workflow agents "follow their own limits
          // instead". Theirs is the `cpuCores - 2` semaphore of
          // `workflows.md:322`, so they neither count against nor are refused by
          // the concurrent-subagent ceiling.
          limitScope: 'workflow',
          ...(agentInput.model === undefined ? {} : { model: agentInput.model }),
          ...(agentInput.effort === undefined ? {} : { effort: agentInput.effort }),
          cwd: options.getCwd(),
          signal: runSignal,
          depth: options.getDepth?.() ?? 0,
          ownerTaskId,
          ...(background ? { backgroundTaskId } : {}),
          requestedAgentId: state.id,
          background,
          hookAgentId: state.id,
          onAdmitted: agentId => {
            state.id = agentId;
            admittedAgentIds.push(agentId);
            resolveFirstAdmission();
          },
          onEvent: event => {
            if (event.type === 'tool_execution_start') {
              state.toolCalls = (state.toolCalls ?? 0) + 1;
            }
            state.lastActivity = event.type;
            emit();
          },
        }, spawn);

        state.status = result.status;
        state.endedAt = new Date().toISOString();
        state.tokensIn = result.tokensIn;
        state.tokensOut = result.tokensOut;
        if (result.costUsd !== undefined) state.costUsd = result.costUsd;
        state.lastActivity = result.status;
        results.push(result);
        labels.push(agentInput.label);
        journal.record(promptHash, result);
        emit();
        chargeBudget(result);

        if (result.status !== 'done') {
          if (result.status === 'aborted') throw new WorkflowAbortError(result.error || `agent ${agentInput.agent} was stopped`);
          throw new Error(result.error || `agent ${agentInput.agent} ended with ${result.status}`);
        }

        // The script sees defanged text, so anything it builds from a child's
        // output — a later task string, a log line — is already neutralised.
        return scanSubagentOutput(result.text);
      };

      const runWorkflow: WorkflowRuntimeApi['workflow'] = async (nameOrRef, recipeArgs) => {
        throwIfAborted();
        const key = normalizeWorkflowRecipeKey(nameOrRef);
        workflowDepth += 1;
        try {
          if (workflowDepth > 1) {
            throw new Error('workflow() recursion is not allowed');
          }
          const source = await recipes.get(key);
          throwIfAborted();
          if (source === undefined) {
            throw new Error(`Unknown workflow recipe: ${key}`);
          }
          // Forwarded VERBATIM, `undefined` included — see the note on
          // `makeApi(input.args)` below. `workflow('other')` with no second
          // argument is the in-script spelling of "args is omitted", so a `?? {}`
          // here would keep the divergence alive one level down even with the
          // top-level call fixed.
          return await compileWorkflowScript(source)(makeApi(recipeArgs));
        } finally {
          workflowDepth -= 1;
        }
      };

      const makeApi = (runtimeArgs: unknown): WorkflowRuntimeApi => ({
        agent: runAgent,
        workflow: runWorkflow,
        parallel: async thunks => {
          if (!Array.isArray(thunks) || thunks.some(thunk => typeof thunk !== 'function')) {
            throw new Error('parallel() requires an array of functions');
          }
          if (thunks.length > MAX_FANOUT_ITEMS) {
            throw new Error(`parallel() accepts at most ${MAX_FANOUT_ITEMS} items, received ${thunks.length}`);
          }
          const settled = await Promise.allSettled(thunks.map(thunk => thunk()));
          const abort = settled.find(entry => entry.status === 'rejected' && isWorkflowAbortError(entry.reason));
          if (abort?.status === 'rejected') {
            throw abort.reason;
          }
          return settled.map((entry, index) => {
            if (entry.status === 'fulfilled') return entry.value;
            failures.push({
              helper: 'parallel',
              index,
              phase: currentPhase,
              error: errorMessage(entry.reason),
            });
            return null;
          });
        },
        pipeline: async (items, ...stages) => {
          if (!Array.isArray(items) || stages.some(stage => typeof stage !== 'function')) {
            throw new Error('pipeline() requires an item array and stage functions');
          }
          if (items.length > MAX_FANOUT_ITEMS) {
            throw new Error(`pipeline() accepts at most ${MAX_FANOUT_ITEMS} items, received ${items.length}`);
          }
          return Promise.all(items.map(async (item, index) => {
            let value = item;
            for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
              const stage = stages[stageIndex];
              if (!stage) break;
              try {
                value = await stage(value);
              } catch (caught) {
                if (isWorkflowAbortError(caught)) {
                  throw caught;
                }
                failures.push({
                  helper: 'pipeline',
                  index,
                  stageIndex,
                  phase: currentPhase,
                  error: errorMessage(caught),
                });
                return null;
              }
            }
            return value;
          }));
        },
        phase: title => {
          currentPhase = String(title || 'phase');
          emit();
          return currentPhase;
        },
        log: message => {
          const line = String(message);
          logs.push(line);
          emit();
          return line;
        },
        args: runtimeArgs,
        budget: {
          total: tokenBudget,
          spent: () => spentTokens,
          remaining: () => tokenBudget === undefined ? undefined : Math.max(0, tokenBudget - spentTokens),
        },
      });

      let compiledScript: ReturnType<typeof compileWorkflowScript>;
      try {
        compiledScript = compileWorkflowScript(script);
      } catch (caught) {
        return structuredError(errorMessage(caught));
      }

      const runScript = async (): Promise<AgentToolResult<WorkflowToolDetails>> => {
        emit();

        let returnValue: unknown;
        let error: string | undefined;
        let aborted = false;
        try {
          // `workflows.md:225` — "If `args` is omitted, the global is
          // `undefined` inside the script." Passed through UNCHANGED, which
          // means no `?? {}` and no default parameter anywhere on this path:
          // `{}` is both defined and truthy, so substituting it makes every
          // documented no-input branch (`args === undefined`, `!args`,
          // `args ?? default`) unreachable and the script silently takes its
          // has-input path instead. `makeApi(runtimeArgs: unknown)` and
          // `WorkflowRuntimeApi.args: unknown` both accept `undefined`, and
          // `compileWorkflowScript` injects `api.args` verbatim as the `args`
          // function parameter, so nothing downstream re-substitutes it.
          returnValue = await compiledScript(makeApi(input.args));
        } catch (caught) {
          if (isWorkflowAbortError(caught) && runSignal?.aborted) {
            aborted = true;
          } else {
            error = caught instanceof Error ? caught.message : String(caught);
          }
        }

        const result = toResultPayload(runId, results, labels, failures, error, aborted);
        return {
          content: [{ type: 'text', text: contentForResult(result, logs, error) }],
          details: {
            ...runDetails,
            progress: progress(),
            result,
            journalPath: journal.path,
            returnValue,
            logs,
            ...(error ? { error } : {}),
          },
        };
      };
      // The run's OUTCOME, not merely the fact that it finished — the reason the
      // background race below can name a refusal instead of describing a clock.
      //
      // Both are published BEFORE the seal on purpose, and the race waits on
      // `scriptSettled` rather than on the sealed promise for that reason.
      // `sealOwnerTask` is a round trip to the host and the model gains nothing
      // by waiting for it: the run already has its terminal payload one line
      // above. Waiting for the SEALED promise would add that round trip to every
      // backgrounded refusal — the depth limit, `maxAgents`, an unknown agent
      // name, an invalid `outputSchema`, a script that threw — all of which are
      // decided in-process and are legible the moment `runScript` returns.
      let settledRun: AgentToolResult<WorkflowToolDetails> | undefined;
      let resolveScriptSettled!: () => void;
      const scriptSettled = new Promise<void>(resolve => { resolveScriptSettled = resolve; });
      const runScriptAndSeal = async () => {
        try {
          const output = await runScript();
          settledRun = output;
          resolveScriptSettled();
          return output;
        }
        finally {
          if (ownerUsed) await options.childSessionPort?.sealOwnerTask(ownerTaskId);
        }
      };

      if (background) {
        if (signal?.aborted) {
          return {
            content: [{ type: 'text', text: 'workflow background run was aborted before start.' }],
            details: { ...runDetails, error: 'workflow background run was aborted before start.' },
          };
        }

        // The shared registration seam (`background-child-task.ts`): announce,
        // register, report. This tool carried its own third copy of all three,
        // and the copy also STARTED the run before emitting `task_backgrounded`
        // — the one ordering that seam documents as load-bearing, because the
        // host retains the capability authority for the id when the event
        // arrives and the child start must not race ahead of it.
        //
        // The lifecycle is the same one, field for field: same registry entry,
        // same `unknown-task-id`-swallowing `stopDescendants`, same completion
        // pair, same `unregister` on settle. One difference is deliberate and is
        // an improvement rather than a port: a run that REJECTS while its
        // controller is aborted now reports `stopped` instead of `failed`. The
        // only rejection this path has is `sealOwnerTask` throwing, and a seal
        // that throws during a stop was never evidence of a failure.
        const { settled: backgroundRun } = registerBackgroundChildTask({
          taskId: backgroundTaskId,
          toolUseId: toolCallId,
          kind: 'workflow' as const,
          ...(options.emitEvent ? { emitEvent: options.emitEvent } : {}),
          ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
          ...(options.childSessionPort ? { childSessionPort: options.childSessionPort } : {}),
          run: backgroundSignal => {
            // Both assigned before the body runs: every spawn and every
            // `throwIfAborted` in the script reads `runSignal`, and a detached
            // run answers to the registry's controller rather than to the turn
            // that launched it. `notify` is dropped because there is no longer a
            // tool call listening for progress.
            runSignal = backgroundSignal;
            notify = undefined;
            return runScriptAndSeal();
          },
          outcome: output => {
            const summary = output.content[0]?.type === 'text' ? output.content[0].text : undefined;
            return {
              status: backgroundCompletionStatus(output.details?.result?.status ?? 'error'),
              ...(summary === undefined ? {} : { summary }),
            };
          },
        });

        // EVERY ARM IS AN OUTCOME. A `setTimeout(0)` arm used to sit here, and a
        // clock beats every refusal that needs a round trip to the host — the
        // USD cap and every `start` refusal — so those reasons could not be
        // named in the turn the model asked; measured, a genuine SUCCESS could
        // not be either, because host admission is a round trip too, so in
        // production the timer answered "nothing admitted yet" for all three.
        // Dropping it is deliberate and so is its cost: this call no longer
        // returns before the host has answered once. The subagent seam never had
        // a timer, and the two seams now behave the same way.
        //
        // `backgroundRun` stays as the arm that cannot be dropped: it is the
        // only one that settles if `runScript` itself rejects, and without it
        // such a run would hang this turn forever instead of failing it. Its
        // rejection arm is deliberately absent, as before — a run that THREW
        // reaches the model in the same turn as a failed tool call, and a
        // handler here would swallow a rejection `registerBackgroundChildTask`
        // has also already reported.
        await Promise.race([
          firstAdmission,
          scriptSettled,
          backgroundRun.then(() => undefined),
        ]);

        // NOTHING WAS ADMITTED, and the run is OVER. Two different things can
        // mean that — a refusal and a successful agent-less completion — and
        // "Started background workflow run" used to speak for both. P2.27 took
        // the refusal half; P2.163 took the other, so no arm below this line
        // announces a start for a run that has already finished.
        //
        // Unlike the subagent seam, this one cannot key on an empty id list:
        // `agent_ids` and `details.agentIds` are OMITTED entirely when nothing
        // was admitted, so there is no field to find empty. The tell here is a
        // POSITIVELY observed outcome — `settledRun`, the script's own terminal
        // payload — against the fact that no `onAdmitted` ever fired.
        if (admittedAgentIds.length === 0 && settledRun) {
          const status = settledRun.details?.result?.status;
          // `status !== 'done'`, NOT `status === 'error'`. The aborted class
          // belongs here too: a run stopped between host-side admission and
          // `onAdmitted` publishes no id either, so narrowing this to errors
          // would hand it back the success shape — the exact trap recorded at
          // the subagent seam. Its report can carry the partial work a child
          // produced, which is why the lead sentence says "refused, stopped, or
          // failed" instead of claiming nothing ran.
          //
          // A run that finished `done` without admitting anything is NOT this
          // case: a journal replay answers entirely from cache and a script that
          // never calls `agent()` never spawns, and neither is a refusal.
          if (status !== 'done') {
            // Exactly what the same run would have returned in the FOREGROUND,
            // with one sentence in front saying nothing is running. The report
            // is `contentForResult`, the rendering the foreground return and the
            // completion summary already use, so one refusal reads the same on
            // all three doors and each gate keeps the sentence it wrote — and
            // it is already defanged, marker line included.
            //
            // `taskId` and `backgrounded` are dropped with the success shape:
            // the run is over, its registration has been released, and naming a
            // task id here would invite `stopTask` on a task that is not there.
            const report = settledRun.content[0]?.type === 'text' ? settledRun.content[0].text : '';
            // A `done` entry with nothing admitted is a JOURNAL REPLAY (see the
            // constant), and the report below therefore lists delivered work. The
            // plain sentence denies exactly that, so the replayed spelling is
            // used instead — the branch itself is unchanged.
            const replayed = settledRun.details?.result?.results.some(entry => entry.status === 'done') ?? false;
            const lead = replayed
              ? BACKGROUND_WORKFLOW_REPLAYED_NOT_RUNNING_MESSAGE
              : BACKGROUND_WORKFLOW_NOT_RUNNING_MESSAGE;
            return {
              content: [{ type: 'text', text: `${lead}\n${report}` }],
              details: { ...settledRun.details },
            };
          }
          // The `done` half of the same observation, and it is NOT a refusal
          // (P2.163). A script that never calls `agent()` and a replay answered
          // entirely from the journal both finish successfully with nothing
          // admitted — legitimate outcomes that used to fall through to "Started
          // background workflow run" and describe a finished run as a beginning.
          //
          // Same shape as the arm above and for the same reasons: the run's own
          // report, so the result reaches the model in this turn; and no `taskId`
          // or `backgrounded`, because the run is over and naming a task id would
          // invite `stopTask` on a task that is not there. Only the lead sentence
          // differs, because only the meaning does.
          const completedReport = settledRun.content[0]?.type === 'text' ? settledRun.content[0].text : '';
          return {
            content: [{ type: 'text', text: `${BACKGROUND_WORKFLOW_COMPLETED_UNATTENDED_MESSAGE}\n${completedReport}` }],
            details: { ...settledRun.details },
          };
        }

        // Nothing admitted and no outcome — the honest third answer, kept as a
        // FALLBACK and, since the timer arm was dropped, UNREACHABLE.
        //
        // Unreachable because every arm above is an outcome: `firstAdmission`
        // resolves only from inside `onAdmitted`, which pushes its id first, so
        // arriving here means that arm did not win; and the other two publish
        // `settledRun` before they resolve, or reject and leave this function
        // entirely. Kept anyway, and deliberately — it is the only correct
        // answer if an arm that is NOT an outcome is ever added back, and
        // without it such an arm would fall through to the success text below,
        // which is exactly the "Started background workflow run" lie P2.114
        // removed. The task IS real in that state (announced, registered,
        // stoppable), so the details keep the success shape and only the
        // sentence changes.
        if (admittedAgentIds.length === 0 && settledRun === undefined) {
          return {
            content: [{
              type: 'text',
              text: `${BACKGROUND_WORKFLOW_NOT_YET_ADMITTED_MESSAGE}\nrun_id: ${runId}\ntask_id: ${backgroundTaskId}`,
            }],
            details: {
              ...runDetails,
              taskId: backgroundTaskId,
              backgrounded: true,
              progress: progress(),
              journalPath: journal.path,
            },
          };
        }

        return {
          content: [{ type: 'text', text: `Started background workflow run\nrun_id: ${runId}\ntask_id: ${backgroundTaskId}${admittedAgentIds.length > 0 ? `\nagent_ids: ${admittedAgentIds.join(', ')}` : ''}` }],
          details: {
            ...runDetails,
            taskId: backgroundTaskId,
            ...(admittedAgentIds.length > 0 ? { agentIds: [...admittedAgentIds] } : {}),
            backgrounded: true,
            progress: progress(),
            journalPath: journal.path,
          },
        };
      }

      return await runScriptAndSeal();
    },
  };
}
