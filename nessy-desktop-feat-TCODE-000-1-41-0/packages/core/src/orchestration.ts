export type OrchestrationKind = 'subagent' | 'workflow';

/**
 * D1.253 — WHO produces each of these, and the decision about `aborted`.
 *
 * `queued`, `running`, `done` and `error` come from the runtimes: Pi's
 * orchestrator, codex's thread events and claude's `SDKTaskProgressMessage` all
 * report them through `task_progress`.
 *
 * **`aborted` has exactly one producer and it is the RENDERER**:
 * `event-processor/handlers/session.ts` `handleInterrupted` (D1.149,
 * `eecc2ff8a`), which marks every still-running agent aborted when the user
 * stops the turn. Before that it had four renderers and NO producer, so a
 * subagent card kept the last `running` it was sent, forever (RS-14's
 * *"Running Write…"*).
 *
 * ## The decision, stated: the renderer's inference IS the contract
 *
 * D1.253 asked whether each runtime should instead emit a final progress event
 * on its own interrupt path. It should not, and the reason is measured rather
 * than preferred: **`orchestrationProgress` is not persisted.**
 * `handleInterrupted`'s own header gives that as why it rewrites the map at all
 * — so the view matches the state after a reload. A host- or runtime-emitted
 * final event would reach the LIVE client and leave the reconstruction owed for
 * every reload anyway: two producers of one fact, which is the divergence class
 * this plan keeps closing, in exchange for nothing the view does not already
 * have.
 *
 * It is a `[product]` posture rather than a tidy-up, so it is written where a
 * reader meets the member: an `aborted` arriving from a runtime today would be
 * a SECOND producer, not a better one.
 *
 * ## What would reverse it
 *
 * Persisting `orchestrationProgress`. Then a host-side final event on the
 * interrupt path is the single producer, the reconstruction becomes redundant,
 * and this member changes hands — one commit, both halves, because a host event
 * landed beside the inference is the duplication above.
 */
export type OrchestrationAgentStatus = 'queued' | 'running' | 'done' | 'error' | 'aborted';

export interface OrchestrationProgressAgent {
  id: string;
  label: string;
  agentType: string;
  phase?: string;
  status: OrchestrationAgentStatus;
  /**
   * P6.641 — the input/output split, OPTIONAL since a runtime exists that cannot
   * produce it.
   *
   * These were required, and on claude that was unsatisfiable: the SDK's
   * `SDKTaskProgressMessage.usage` is `{ total_tokens, tool_uses, duration_ms }`
   * (agent-sdk 0.3.233) with no split anywhere on the message. The two ways to
   * satisfy a required field were to invent a split or to send `0`/`0`, and a
   * card reading "0 in / 0 out" beside a real total is a fabricated fact rather
   * than a missing one. Absent is the honest answer, so absent is expressible.
   *
   * A producer that HAS the split still sends it — Pi's orchestrator and codex's
   * `thread/tokenUsage/updated` both do — so nothing about those runtimes moves.
   */
  tokensIn?: number;
  /** @see tokensIn */
  tokensOut?: number;
  /**
   * P6.641 — the total, for a runtime that reports one and no split.
   *
   * Never a substitute for the pair: a consumer prefers `tokensIn + tokensOut`
   * when they are there, and falls back to this. A producer that sets both the
   * pair and this one is stating the same quantity twice and they must agree.
   */
  tokensTotal?: number;
  toolCalls?: number;
  costUsd?: number;
  startedAt?: string;
  endedAt?: string;
  lastActivity?: string;
  /**
   * I2.9 — whether this child was registered in the BACKGROUND, so the panel can
   * say which of its rows the turn is actually waiting on.
   *
   * `sdk.d.ts` at the vendored 0.3.251, verbatim: *"Whether the task was
   * registered in the background (true) or in the foreground with the spawning
   * tool call blocking on it (false). A resumed subagent is always registered in
   * the background. A later move to the background arrives as `task_updated`
   * patch.is_backgrounded. Set for local_agent and local_bash tasks."*
   *
   * OPTIONAL, and for the same reason {@link tokensIn} is: only the claude
   * adapter has a producer today. Absent means the runtime did not say — never
   * "foreground", which is what a defaulted `false` would assert on Pi and codex
   * about a distinction they never reported.
   */
  isBackgrounded?: boolean;
  /**
   * I2.9 — how deeply this child is nested.
   *
   * `sdk.d.ts` at 0.3.251, verbatim: *"Nesting depth of a spawned subagent
   * (local_agent) task: 1 for a top-level spawn, N+1 when spawned from inside a
   * depth-N agent. Not set on other tasks."*
   *
   * Optional for two reasons, not one: no other runtime produces it, AND the SDK
   * itself sets it only on `local_agent` tasks, so it is absent on plenty of
   * claude rows too. A consumer that rendered a default would be inventing a
   * depth for a `local_bash` task that has none.
   */
  spawnDepth?: number;
}

export interface OrchestrationProgressPhase {
  title: string;
  detail?: string;
}

export interface OrchestrationProgress {
  kind: OrchestrationKind;
  runId: string;
  phases?: OrchestrationProgressPhase[];
  agents: OrchestrationProgressAgent[];
  /**
   * Advisory large-run notice for the progress line. DISPLAY ONLY: a workflow
   * that carries this still runs to completion — it is not a cap, a pause, or a
   * refusal. Absent when the run is under the threshold, or when the session is
   * at max effort and has therefore already opted in to large runs.
   */
  warning?: string;
}

export interface OrchestrationTaskResult {
  id: string;
  label: string;
  agentType: string;
  status: Extract<OrchestrationAgentStatus, 'done' | 'error' | 'aborted'>;
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  error?: string;
}

export interface OrchestrationFailure {
  helper: 'parallel' | 'pipeline';
  index: number;
  stageIndex?: number;
  phase?: string;
  error: string;
}

export interface OrchestrationResultPayload {
  kind: OrchestrationKind;
  runId: string;
  status: Extract<OrchestrationAgentStatus, 'done' | 'error' | 'aborted'>;
  results: OrchestrationTaskResult[];
  failures?: OrchestrationFailure[];
}

const progressStatuses = new Set<OrchestrationAgentStatus>(['queued', 'running', 'done', 'error', 'aborted']);
const resultStatuses = new Set<OrchestrationTaskResult['status']>(['done', 'error', 'aborted']);
const kinds = new Set<OrchestrationKind>(['subagent', 'workflow']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isProgressAgent(value: unknown): value is OrchestrationProgressAgent {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.label === 'string'
    && typeof value.agentType === 'string'
    && isOptionalString(value.phase)
    && typeof value.status === 'string'
    && progressStatuses.has(value.status as OrchestrationAgentStatus)
    && isOptionalNumber(value.tokensIn)
    && isOptionalNumber(value.tokensOut)
    && isOptionalNumber(value.tokensTotal)
    && isOptionalNumber(value.toolCalls)
    && isOptionalNumber(value.costUsd)
    && isOptionalString(value.startedAt)
    && isOptionalString(value.endedAt)
    && isOptionalString(value.lastActivity);
}

function isProgressPhase(value: unknown): value is OrchestrationProgressPhase {
  if (!isRecord(value)) return false;
  return typeof value.title === 'string'
    && isOptionalString(value.detail);
}

function isTaskResult(value: unknown): value is OrchestrationTaskResult {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.label === 'string'
    && typeof value.agentType === 'string'
    && typeof value.status === 'string'
    && resultStatuses.has(value.status as OrchestrationTaskResult['status'])
    && typeof value.text === 'string'
    && isFiniteNumber(value.tokensIn)
    && isFiniteNumber(value.tokensOut)
    && isOptionalNumber(value.costUsd)
    && isOptionalString(value.error);
}

function isFailure(value: unknown): value is OrchestrationFailure {
  if (!isRecord(value)) return false;
  return (value.helper === 'parallel' || value.helper === 'pipeline')
    && isFiniteNumber(value.index)
    && (value.stageIndex === undefined || isFiniteNumber(value.stageIndex))
    && isOptionalString(value.phase)
    && typeof value.error === 'string';
}

export function isOrchestrationProgress(value: unknown): value is OrchestrationProgress {
  if (!isRecord(value)) return false;
  return typeof value.kind === 'string'
    && kinds.has(value.kind as OrchestrationKind)
    && typeof value.runId === 'string'
    && (value.phases === undefined || (Array.isArray(value.phases) && value.phases.every(isProgressPhase)))
    && Array.isArray(value.agents)
    && value.agents.every(isProgressAgent);
}

export function isOrchestrationResultPayload(value: unknown): value is OrchestrationResultPayload {
  if (!isRecord(value)) return false;
  return typeof value.kind === 'string'
    && kinds.has(value.kind as OrchestrationKind)
    && typeof value.runId === 'string'
    && typeof value.status === 'string'
    && resultStatuses.has(value.status as OrchestrationResultPayload['status'])
    && Array.isArray(value.results)
    && value.results.every(isTaskResult)
    && (value.failures === undefined || (Array.isArray(value.failures) && value.failures.every(isFailure)));
}
