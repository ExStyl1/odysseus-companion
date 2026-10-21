/**
 * UA4.1 — adapted from craft-agents-oss `v0.13.4:packages/server-core/src/tasks/TaskRunner.ts` (Apache-2.0),
 * rebranded (`@craft-agent` → `@nessy-agent`).
 *
 * The scheduler, the run log, budgets, retry, the verdict and the repair frontier are upstream's, kept line for
 * line where nothing below names them. Stated divergences (spec §11 "Conductor", plan UA4.1 "Adaptations"):
 *
 * 1. **The host is {@link ConductorSessionHost}, built by `conductor-host.ts` over OUR SessionManager.** Upstream
 *    handed its SessionManager in structurally; ours resolves `sendMessage` when the turn is OVER (as upstream's
 *    does), so the adapter returns at DELIVERY (`onAck`) in queue mode and reports a turn's outcome only through
 *    `onSessionComplete` — exactly once (spec §5 "Settling a send").
 * 2. **A child's folder and project are the ORCHESTRATOR's**: `getSessionProjectHandleId` replaces upstream's
 *    `getSessionWorkingDirectory`, the child is created with `projectHandleId` and the orchestrator's `projectId`,
 *    never `spec.cwd` or `spec.project` at dispatch (our `CreateSessionOptions.workingDirectory` takes no path).
 *    The upstream case "children inherit the orchestrator's working directory (falling back to spec.cwd)" is
 *    inverted in the test file.
 * 3. **No `allow-all` default.** Upstream's `AUTONOMOUS_DEFAULT_MODE = 'allow-all'` (spec §19 defect 3) is gone: an
 *    unset node mode inherits the orchestrator's, and a requested mode is clamped to the orchestrator's with the
 *    one rule `clampPermissionModeToParent`. UA4.2: the lifetime ceiling key is SessionManager.clampChildPermissionModeToParent's, the managed normalisation the create door's.
 *    UA12.78: a run with NO orchestrator (a programmatic run; `tasks:run` requires one) clamps a requested mode at
 *    `default` ({@link ORCHESTRATORLESS_CEILING}) instead of sending a yaml's `bypassPermissions` unclamped.
 * 4. **Turn-scoped output.** A node's output is `evt.finalText ?? ''` — never upstream's
 *    `?? getSessionFinalText(…)` fallback, which hands back the PREVIOUS turn's answer when this turn produced
 *    none (controller hand-back from UA1.4). The verdict reads the same way — every final row of THIS turn (UA12.76: `evt.turnFinalTexts`, as codex marks no agent message intermediate). One carry-over is kept and stated: under
 *    the settlement gate (item 6) a door deferred as unsettled keeps its text, and a later settled door of the SAME
 *    session that produced none completes the node with that deferred text (the answer was given; only the
 *    settlement was waited for). UA12.100: when the gate settles, a final message the session wrote AFTER the door
 *    ({@link ConductorSessionHost.getSessionFinalMessage}, its id compared with the newest one at the door) is the
 *    output instead — the reply the Claude CLI writes in the turn it opens itself to deliver a background task's end
 *    (F1.492: no host door follows it). Only a message newer than the door can win, so no earlier turn's answer does.
 * 5. **`terminalIsError` fails the node**: a `complete` whose backend verdict is an error is a failure, not output.
 * 6. **Settlement gate** ({@link ConductorSessionHost.isSessionSettled}): a node's `complete` is accepted at an
 *    idle door only when the session is settled, has no active goal and no live monitor, cron or backgrounded
 *    record; otherwise it waits for the next idle door. A completion of a node already `done` is logged as
 *    `node-woke-after-done` (the tile badge is UA4.4's renderer).
 * 7. **The verdict turn must start after the verify message**: the verdict listener is armed only once that
 *    message is DELIVERED, so no earlier turn of the orchestrator is read as the verdict.
 * 8. **The running status is written only when the workspace defines it** (`in-progress` is not a default status,
 *    spec §8); the column always moves.
 * 9. **An interrupted child PAUSES the run when no user is behind it** (`fromUser: false` — a restart, a redirect
 *    respawn); Resume re-dispatches it. A USER's Stop (or the `timeout` one causes, UB2.8/B4-15, OQ-B4-3 (a)) instead
 *    leaves the node `waitingForUser`: it stays running in ITS OWN session — no cancel, no pause, no re-dispatch —
 *    the user's next turn in that session completes it with its reply, and a background producer's wake keeps it
 *    waiting (`completeNode(..., fromUser)`).
 * 10. **Preflight before the first dispatch, on run AND resume** ({@link TaskRunnerDeps.preflight}): the host's
 *     node hostability (UA1.7 `assertNodesHostable`) and the re-validation of `spec.cwd` through the project-handle
 *     service. `run` and `resume` are therefore async; a resume re-checks a paused run still in memory as well as
 *     a rehydrated one, and a refusal leaves it paused.
 * 11. **A completion from a previous attempt's session** (a retried or repaired node runs in a new session) is
 *     ignored instead of being read as the current attempt's — including while the new session is still being
 *     created: `markRunning` clears the node's session, so only the one `dispatch` assigns can settle the attempt.
 * 12. **A rejected verify send fails only a run still `verifying`** (`sendToOrchestrator`; upstream calls
 *     `finish('failed')` unconditionally), so a run stopped while the send was in flight stays stopped.
 *
 * 13. **A restart resumes the run it interrupted, not the live yaml** (UA4.3, spec §11 item 7): `run-started` records
 *     the resolved params, and `rehydrate` runs the run's own spec snapshot (`readRunSpecSnapshot`, re-validated)
 *     with those params — upstream reloaded the live `task.yaml` with default params, so an edit made between the
 *     restart and Resume changed the DAG. A rehydrate refuses an ended run (`task-run-ended`), a run with no snapshot
 *     (`task-run-snapshot-missing`) and an orchestrator that has another active run. `hydrate` also replays
 *     `node-scheduled` and `node-retry` (upstream read only `node-finished`), so a node a FAIL verdict sent back for
 *     repair re-runs instead of the rejected output being verified again — still as a repair: the retry preamble
 *     (the rejection reason, or a retry's failure) is rebuilt from the logged reason (`failurePreamble`). A child in
 *     flight at shutdown is not resumed by the host (measured 2026-10-02: it reloads idle, keeping its task fields and
 *     its `in-progress` column, and no completion is emitted); its node re-dispatches in a new child, the abandoned one
 *     moves to `todo` as a retried attempt's does, and a late turn there is ignored (item 11). UA12.75: its pending
 *     permission card is withdrawn too ({@link ConductorSessionHost.withdrawPendingApproval}) — the host re-presents a
 *     persisted card on open, and its Allow re-drove a turn in the abandoned child whose output the run ignores. Nothing is written at
 *     startup: a non-terminal log no live run holds reads `interrupted` (`rpc/tasks.ts`), and `stop` closes such a run
 *     with `run-stopped`.
 * 14. **A deferred idle door is re-checked on a timer** (UA4.8, {@link TaskRunnerDeps.settlementRecheckMs}): item 6
 *     waited for "the next idle door" alone, and a producer can end without one — a Claude background task's end
 *     arrives in a turn the CLI opens itself (no host `complete`, F1.492), codex has no between-turns channel, a
 *     Monitor watch can end with no event. So while a node's door is deferred, the gate is read again every
 *     {@link SETTLEMENT_RECHECK_MS} until it is settled (the node completes with the deferred text), the node leaves
 *     `running`, or the run ends. The only new output it reads is item 4's UA12.100 message written after the door.
 *     UB2.8 rides the same door: the door's origin travels with it (`fromUser`), an accepted completion with EMPTY
 *     text fails the node — `'finished without a reply'`, declared outputs or not (B4-19; the dependents never read
 *     an empty answer as done; the retry policy applies) — and a background wake (`fromUser: false`) of a node that
 *     `waitsForUser` keeps it waiting; the B4-18 residue stands (the node's output is its LAST settled reply, not
 *     upstream's join of a stopped step's turns);
 *     a door that arrives meanwhile goes first.
 *
 * 15. **A rehydrated dispatch merges the orchestrator's recorded mode into the ceiling** (UA12.152, SIT-D F2): the
 *     session resume table demotes a persisted `bypassPermissions` orchestrator to the mode a new session would
 *     start in, so the LIVE mode read at a rehydrate dispatch is not the mode the run was granted — the resumed
 *     child spawned narrower (`auto`), its Bash card was never answered, and the run wedged forever. `run-started`
 *     and every `node-spawned` now record the orchestrator's mode (the ceiling of that dispatch — UA12.173: in the
 *     entry's own `ceilingPermissionMode`, since its `permissionMode` is the CHILD's clamped mode, which as a carrier
 *     narrowed the run after a `plan` override; {@link permissionCarrierOf} — so a
 *     LIVE run captures a mid-run raise or lower with the same freshness the live ceiling has; a rehydrated
 *     run's dispatches record the MERGED mode — see the residue), and `hydrate` reads the
 *     LAST recorded one. The rehydrate's ceiling is the BROADER of the live reading and the recorded one: the
 *     recorded floor keeps the resumed child under the grant the run was started with (the wedge fix), and the live
 *     reading still propagates a post-restart raise — capping the live mode with the record would wedge the run the
 *     same way the demotion did. UA12.171 (2026-10-08): the floor cannot tell the restart demotion from a user's
 *     DELIBERATE lower, so a deliberate change is a carrier of its own — the host appends `mode-changed` to every
 *     live run of the orchestrator ({@link recordOrchestratorModeChange}, called from SessionManager's mode-change
 *     doors after a real transition), the restart demotion (the load-time resume table) writes nothing. The newest
 *     carrier is then the user's choice: a hydrated run re-reads it at every dispatch, SessionManager's child
 *     clamp reads it through {@link recordedLiveRunPermissionCeiling}, and a later rehydrate reads it in `hydrate`
 *     — so a lower caps the next dispatch and every node's next mode change again, and a raise after it is
 *     honoured up to the new mode. This closes V-fw3's measured residue (85d910220: "no rehydrate honours a lower
 *     after the last dispatch") for every lower that passes through a host door. Residue, stated: a re-dispatch
 *     still records its MERGED mode as its `node-spawned` carrier, so a demoted orchestrator nobody touched keeps
 *     the run's grant (UA12.165's case, by design); and a lower the host never sees (none known) is not recorded.
 *
 * 16. **A run runs the bytes its confirmation checked** (UA12.90, P-UAal-2): `tasks:run` hands the digest the
 *     confirmation check read to {@link TaskRunner.run} (`RunOptions.confirmedDigest`), and the run's own load
 *     ({@link loadConfirmedTaskSpec}) hashes the bytes it reads, refusing `run-confirmation-required` on a
 *     mismatch — an edit landing between the host's check and the run's read no longer runs unconfirmed bytes
 *     (upstream has no run confirmation at all; the check itself is UA4.4's, `rpc/tasks.ts` header).
 *
 * Kept from upstream and stated: a completed run closes the orchestrator (column `done`, status `done`) — spec §8,
 * OQ-6, waves O25.
 */
/**
 * The Conductor — an in-process DAG runner for Tasks.
 *
 * A `task.yaml` (parsed + validated in @nessy-agent/shared/tasks) describes a
 * graph of nodes; each node is a child session. The Conductor:
 *   1. schedules ready nodes (deps satisfied) honoring `max_parallel`,
 *   2. dispatches each as a child session (create + sendMessage), interpolating
 *      `${nodes.<id>.output}` / `${params.<name>}` / `${inputs.<name>}` into the prompt,
 *   3. subscribes to SessionManager's in-process `onSessionComplete` seam,
 *   4. on completion reads the child's final assistant text as the node output,
 *      feeds it to dependents, and reschedules,
 *   5. drives child `sessionStatus` + `kanbanColumn` so the board renders the live DAG,
 *   6. persists an append-only run-log under `tasks/<slug>/runs/<runId>/`.
 *
 * v1 executes `kind: 'session'` nodes wired by `depends_on` + `inputs`. Control-flow
 * kinds (route/loop/approval/…) parse but are not yet executed (P4).
 *
 * The runner depends on a minimal `ConductorSessionHost` interface (built over
 * SessionManager by `conductor-host.ts`) so it is unit-testable with a mock.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol';
// UB6.6 — the decision-model wire types and the verdict classifier (parsing only; a parseable VERDICT line always wins).
import type { DecisionRequest, DecisionResult } from '@nessy-agent/shared/decisions';
import { classifyVerdictWithDecision } from './verdict-decision';
import { clampPermissionModeToParent, PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/mode-types';
import type { SessionCompletionEvent } from '../sessions/SessionManager';
import {
  type TaskSpec,
  type TaskNode,
  type NodeOutput,
  type RunLogEntry,
  type NodeRunState,
  nodeTitle,
  nodeDeps,
  extractRefs,
  interpolateRefs,
  materializeDeps,
  appendRunLog,
  writeNodeOutput,
  readNodeOutput,
  nodeOutputPath,
  readRunLog,
  listRunIds,
  loadTaskSpec,
  parseTaskYaml,
  writeRunSpecSnapshot,
  readRunSpecSnapshot,
  taskYamlPath,
  validateTaskInput,
  DEFAULT_REPAIR_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS_CAP,
} from '@nessy-agent/shared/tasks';

// ---------------------------------------------------------------------------
// Host interface (built over SessionManager by conductor-host.ts)
// ---------------------------------------------------------------------------

export interface ConductorSessionHost {
  /** Creates the child session AND announces it to the renderer (`session_created`), so the subtask appears on
   *  the board with its real title. */
  createSession(workspaceId: string, options: CreateSessionOptions): Promise<{ id: string }>;
  /**
   * NESSY — resolves once the message is DELIVERED (accepted into the transcript: started or queued), never when
   * the turn ends; rejects when it was not delivered. A turn that fails after delivery reports through
   * {@link onSessionComplete}, so every outcome is reported exactly once (header item 1).
   */
  sendMessage(sessionId: string, message: string): Promise<void>;
  setSessionStatus(sessionId: string, status: string): Promise<void>;
  setKanbanColumn(sessionId: string, column: string | null): Promise<void>;
  /** Records the total DAG node count on the orchestrator session for a stable board progress denominator. */
  setTaskNodeCount(sessionId: string, count: number): Promise<void>;
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>;
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void): () => void;
  /** NESSY — the orchestrator's project-handle id, so children run in its folder (replaces upstream's
   *  `getSessionWorkingDirectory`; header item 2). `undefined` when it has no folder. */
  getSessionProjectHandleId(sessionId: string): Promise<string | undefined>;
  /** NESSY — the orchestrator's project entity id, which children carry (never `spec.project`). */
  getSessionProjectId(sessionId: string): string | undefined;
  /** NESSY — the orchestrator's current permission mode: the default and the ceiling of a child's (header item 3). */
  getSessionPermissionMode(sessionId: string): PermissionMode | undefined;
  /** NESSY — the settlement gate (header item 6). Absent → every idle door counts, as upstream. */
  isSessionSettled?(sessionId: string): Promise<boolean>;
  /** NESSY — whether the workspace defines a session status id (header item 8). Absent → not defined. */
  hasSessionStatus?(status: string): boolean;
  /**
   * NESSY (header item 13, UA12.75) — withdraw the pending permission card of a child the run ABANDONED at a restart
   * (denied, nothing runs), so approving it cannot re-drive a turn there. Absent → nothing is withdrawn.
   */
  withdrawPendingApproval?(sessionId: string): Promise<void>;
  /**
   * NESSY (header item 4, UA12.100) — the session's newest final assistant message, NOT turn-scoped; read only to
   * tell whether one was written after a deferred door. Absent → the deferred door's text, as before.
   */
  getSessionFinalMessage?(sessionId: string): { id: string; text: string } | undefined;
}

export interface TaskRunnerDeps {
  host: ConductorSessionHost;
  workspaceId: string;
  workspaceRoot: string;
  /**
   * UB6.6 — the decision model reads a verdict out of a reply WITHOUT a parseable
   * VERDICT line (feature toggle `taskVerdicts`); `null`/absent → re-ask exactly as
   * before. Wired per call by `buildTaskVerdictDecider` (`rpc/tasks.ts`); tests inject
   * a stub. A decision never changes what PASS or FAIL do — parsing only.
   */
  decide?: TaskDecisionFn;
  /**
   * UB6.6 — narrows a FAIL whose reason names NO subtasks to the ones the reason
   * implicates (feature toggle `taskRepairs`); `null`/absent → the whole frontier as
   * before. Scoping only: FAIL still means repair, and the budget is unchanged.
   */
  pickRepairNodes?: RepairScopeFn;
  /**
   * UB6.7 — how a child's turn ENDED, read by the decision model (feature toggle
   * `turnOutcome`): a child that asked for input or gave up is failed (retry / needs-review)
   * instead of marked done — children run unattended, nobody would answer. `null`/absent →
   * marked done as before. `isActive()` short-circuits the async hop when the layer is off.
   */
  classifyNodeOutcome?: NodeOutcomeFn;
  /** Optional output summarizer (call_llm/Haiku). When absent, summarize-flagged inputs pass through. */
  summarize?: (text: string) => Promise<string>;
  /** Default `max_parallel` when the spec omits it. */
  defaultMaxParallel?: number;
  /** Injectable clock (run-log timestamps) + run-id generator, for determinism in tests. */
  now?: () => string;
  genRunId?: () => string;
  /**
   * NESSY — runs before the first dispatch of a run and of a resume, and refuses by throwing (header item 10):
   * the node hostability check and the `spec.cwd` re-validation (`conductor-host.ts` `createConductorPreflight`).
   */
  preflight?: (spec: TaskSpec, ctx: { slug: string; orchestratorSessionId?: string; phase: 'run' | 'resume' }) => Promise<void>;
  /** NESSY (header item 14) — how often a deferred idle door is re-checked; default {@link SETTLEMENT_RECHECK_MS}. */
  settlementRecheckMs?: number;
}

export interface RunOptions {
  /** The task's persistent parent/orchestrator session (author + final verifier). */
  orchestratorSessionId?: string;
  /** Resolved task param values (merged over the spec's declared defaults). */
  params?: Record<string, unknown>;
  /** Explicit run id (otherwise generated). */
  runId?: string;
  /** When the run completes, message the orchestrator to verify the result. Default true. */
  verifyOnComplete?: boolean;
  /**
   * UA12.90 (header item 16) — the `task.yaml` digest the run confirmation checked (`sha256:<hex>`, the
   * `rpc/tasks.ts` `taskYamlDigest` spelling). When set, the bytes THIS run reads are hashed and must equal it:
   * an edit landing between the confirmation check and the run's read refuses with `run-confirmation-required`
   * instead of running unconfirmed bytes.
   */
  confirmedDigest?: string;
}

export type RunStatus = 'running' | 'paused' | 'verifying' | 'stopped' | 'completed' | 'failed';

export interface NodeRunStatus {
  id: string;
  state: NodeRunState;
  sessionId?: string;
  attempt: number;
}

export interface RunSnapshot {
  slug: string;
  runId: string;
  taskId: string;
  status: RunStatus;
  orchestratorSessionId?: string;
  nodes: NodeRunStatus[];
  /** Sum of each child's (input + output) tokens observed at completion. */
  tokensUsed: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PARALLEL = 4;
// NESSY (header item 3): upstream's `AUTONOMOUS_DEFAULT_MODE = 'allow-all'` is not ported. An unset node mode
// inherits the orchestrator's, clamped by the one rule `clampPermissionModeToParent`; with no orchestrator it is
// left unset (the workspace default, as for any new session).
// UA12.78: with no orchestrator a REQUESTED mode (node override or task default) is clamped at this ceiling — the one
// the host reads for an orchestrator that records no mode (conductor-host `getSessionPermissionMode`, UA4.2) — so a
// yaml's `bypassPermissions` never reaches a child no orchestrator granted. `tasks:run` requires an orchestrator, so
// this is hardening for a programmatic run.
const ORCHESTRATORLESS_CEILING: PermissionMode = 'default';
// NESSY (header item 8): written only when the workspace defines it — `in-progress` is not a default status.
const RUNNING_STATUS = 'in-progress';
const DONE_STATUS = 'done';
// There is no 'failed' session status (the fixed set is todo|in-progress|needs-review|done|cancelled).
// We flag a failed child as 'needs-review' (amber, attention needed); the board's 'failed' run-state
// is derived from the run-log, not from a session status.
const FAILED_STATUS = 'needs-review';
// UB2.8 (B4-15) — a step the user stopped waits for them; the fixed status set's amber
// 'needs-review' is the state the board shows while it waits (upstream's WAITING_FOR_USER_STATUS
// carries the same value).
const WAITING_FOR_USER_STATUS = 'needs-review';

// A malformed verdict (no parseable VERDICT line) is re-asked this many times before we give up and
// fail the run. These re-asks are format-only — they do NOT consume the repair (max_iterations) budget.
/** UB6.6 — the decision-model seams ({@link TaskRunnerDeps.decide} / {@link TaskRunnerDeps.pickRepairNodes}). */
export type TaskDecisionFn = (request: DecisionRequest, context: { slug: string; runId: string }) => Promise<DecisionResult | null>;
export type RepairScopeFn = (
  reason: string,
  nodes: readonly { id: string; description: string }[],
  context: { slug: string; runId: string },
) => Promise<string[] | null>;

/**
 * UB6.7 — the child-node outcome classifier. `null` (unavailable, unsure) behaves as before
 * (the node is marked done). `isActive()` lets the runner skip the async hop when the
 * layer is off, so nodes complete synchronously exactly as without the dep.
 */
export type NodeOutcomeFn = ((finalText: string, context: { slug: string; runId: string; nodeId: string }) => Promise<'finished' | 'needs_input' | 'blocked' | null>) & {
  isActive?: () => boolean;
};

const MAX_UNPARSED_REASKS = 2;

/**
 * NESSY (header item 14): the re-check interval of a deferred idle door. Background producers run for minutes; five
 * seconds is the latency between a producer's end and its node's completion, at one settlement read per deferred
 * node (a codex level refreshes at most every 30 s on its own, `CODEX_BACKGROUND_TERMINALS_REFRESH_MIN_GAP_MS`).
 */
export const SETTLEMENT_RECHECK_MS = 5_000;

const INPUTS_REF_RE = /\$\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g;

/**
 * v0.15.1 (UB1.14, B4-16): an upstream reply longer than this is CUT in the dependent's prompt, with a pointer to
 * the full `nodes/<id>.json` ({@link nodeOutputPath}) — a whole exploration must not ride inside every dependent.
 */
const MAX_UPSTREAM_REPLY_CHARS = 40_000;

/** Distributive Omit so the run-log discriminated union keeps its per-variant fields. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RunLogEntryInput = DistributiveOmit<RunLogEntry, 't'>;

interface NodeStateEntry {
  state: NodeRunState;
  sessionId?: string;
  attempt: number;
  /** Reason the previous attempt failed, fed back into the retry prompt (failure-aware retry). */
  lastFailure?: string;
  /**
   * UB2.8 (B4-15, OQ-B4-3 (a)) — the user stopped this step (usually to steer it). It is not
   * finished and must not fail: it waits for them IN ITS OWN SESSION (no cancel, no pause, no
   * re-dispatch), and the turn that completes it later carries its output. A background
   * producer's wake (`fromUser: false`) keeps it waiting.
   */
  waitingForUser?: boolean;
}

// ---------------------------------------------------------------------------
// ActiveRun — a single run's state machine
// ---------------------------------------------------------------------------

class ActiveRun {
  private readonly state = new Map<string, NodeStateEntry>();
  private readonly sessionToNode = new Map<string, string>();
  private readonly outputs: Record<string, NodeOutput> = {};
  private readonly edges: Map<string, Set<string>>;
  private readonly maxParallel: number;
  private inFlight = 0;
  private tokensUsed = 0;
  /** Last observed cumulative (input+output) tokens per child session — for delta accounting. */
  private readonly sessionTokens = new Map<string, number>();
  /** NESSY — the newest text a node session produced at an idle door the settlement gate deferred (item 6). */
  private readonly deferredText = new Map<string, string>();
  /** NESSY (header item 4, UA12.100) — the newest final message id a deferred door's session had at that door. */
  private readonly deferredNewestMessageId = new Map<string, string | undefined>();
  /** NESSY — the pending re-check of a deferred idle door, per node session (header item 14). */
  private readonly recheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private runStatus: RunStatus = 'running';
  private unsubscribe?: () => void;
  /** NESSY (header item 15, UA12.152) — the orchestrator's mode the run-log last recorded (the latest carrier,
   * {@link permissionCarrierOf}). Set by `hydrate` only; a live run never reads it. */
  private hydratedPermissionCeiling?: PermissionMode;
  /** Detaches the one-shot orchestrator-verdict listener while a run is `verifying`. */
  private verdictOff?: () => void;
  /** FAIL verdicts that have triggered a repair pass (bounded by `maxRepairs`). */
  private repairsUsed = 0;
  /** Malformed-verdict re-asks issued (bounded by MAX_UNPARSED_REASKS); not a repair. */
  private unparsedReAsks = 0;
  /** UB6.6 — the previous FAIL repair was decision-scoped; a narrowed repair gets one chance, the next FAIL repairs everything. */
  private lastRepairScoped = false;
  /** Resolved repair cap = min(spec.max_iterations ?? DEFAULT, CAP). */
  private readonly maxRepairs: number;
  /** Inverted edges: node id → set of nodes that (directly) depend on it. Built lazily for the frontier. */
  private dependents?: Map<string, Set<string>>;
  private settled = false;
  private settleResolvers: ((s: RunSnapshot) => void)[] = [];

  constructor(
    readonly spec: TaskSpec,
    private readonly slug: string,
    private readonly runId: string,
    private readonly opts: Required<Pick<RunOptions, 'verifyOnComplete'>> & RunOptions,
    private readonly deps: TaskRunnerDeps,
  ) {
    this.edges = materializeDeps(spec);
    this.maxParallel = spec.max_parallel ?? deps.defaultMaxParallel ?? DEFAULT_MAX_PARALLEL;
    // Runner-side clamp (belt-and-suspenders: the schema already caps `max_iterations` at the same
    // bound, so a parsed spec can't exceed it — but a programmatically built spec might).
    this.maxRepairs = Math.min(spec.max_iterations ?? DEFAULT_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS_CAP);
    for (const node of spec.nodes) this.state.set(node.id, { state: 'pending', attempt: 0 });
  }

  // --- lifecycle ---

  start(): void {
    this.unsubscribe = this.deps.host.onSessionComplete((evt) => this.onSessionComplete(evt));
    // Snapshot the spec for this run so the Results view labels nodes by run-time titles even after
    // the live task.yaml is edited. Best-effort: a snapshot failure must not abort the run.
    try {
      writeRunSpecSnapshot(this.deps.workspaceRoot, this.slug, this.runId, this.spec);
    } catch {
      // ignore — Results falls back to run-log node ids when no snapshot exists
    }
    // NESSY (header item 13): the resolved params ride the entry, so a cross-restart resume runs with them.
    // NESSY (header item 15, UA12.152): so does the orchestrator's mode — the resume table demotes a persisted
    // bypass across a restart, and the live reading alone would re-dispatch the run's children narrower.
    const orchestratorMode = this.opts.orchestratorSessionId
      ? this.deps.host.getSessionPermissionMode(this.opts.orchestratorSessionId)
      : undefined;
    this.log({
      kind: 'run-started',
      taskId: this.spec.id,
      runId: this.runId,
      orchestratorSessionId: this.opts.orchestratorSessionId,
      ...(this.opts.params ? { params: this.opts.params } : {}),
      ...(orchestratorMode ? { permissionMode: orchestratorMode } : {}),
    });
    this.runStatus = 'running';
    // Move the task tile to the in-progress column for the duration of the run.
    if (this.opts.orchestratorSessionId) {
      void this.deps.host.setKanbanColumn(this.opts.orchestratorSessionId, 'in-progress');
      if (this.runningStatusDefined()) void this.deps.host.setSessionStatus(this.opts.orchestratorSessionId, RUNNING_STATUS);
      // Publish the full node count up front so the board's subtask progress denominator is stable,
      // rather than growing as children are spawned lazily at dispatch.
      void this.deps.host.setTaskNodeCount(this.opts.orchestratorSessionId, this.spec.nodes.length);
    }
    this.scheduleReady();
  }

  pause(): void {
    if (this.runStatus !== 'running') return;
    this.runStatus = 'paused';
    this.log({ kind: 'run-paused' });
    // In-flight children keep running; their completions still record output but won't schedule.
  }

  resume(): void {
    if (this.runStatus !== 'paused') return;
    // Cancelled nodes return to pending so they re-dispatch. Nodes that exhausted their `retry`
    // budget stay 'failed' — automatic retry happens in failNode within the run, not on resume.
    for (const [, st] of this.state) if (st.state === 'cancelled') st.state = 'pending';
    this.runStatus = 'running';
    this.log({ kind: 'run-resumed' });
    this.scheduleReady();
  }

  /**
   * Rebuild run state from a persisted run-log (cross-restart resume). Done nodes reuse their
   * recorded output and are NOT re-run; in-flight/cancelled nodes fall back to pending so they
   * re-dispatch. A done node whose output file is missing also falls back to pending.
   */
  hydrate(log: RunLogEntry[], loadOutput: (nodeId: string) => NodeOutput | null): void {
    for (const e of log) {
      // NESSY (header item 15, UA12.152): run-started names the mode the run was granted and every node-spawned
      // the mode that dispatch used; the LAST carrier in append order is the freshest mode this run dispatched
      // under (a mid-run raise or lower is captured at the next dispatch, exactly as the live ceiling is).
      // UA12.171: a deliberate mode change the host recorded (`mode-changed`) is a carrier too.
      // UA12.173: a node-spawned carries its dispatch CEILING (`ceilingPermissionMode`), never the child's own mode.
      const carried = permissionCarrierOf(e);
      if (carried) this.hydratedPermissionCeiling = carried;
      if (e.kind === 'node-spawned') {
        const st = this.state.get(e.nodeId);
        if (st) {
          st.sessionId = e.sessionId;
          this.sessionToNode.set(e.sessionId, e.nodeId);
        }
      } else if (e.kind === 'node-scheduled') {
        const st = this.state.get(e.nodeId);
        if (st) {
          st.attempt += 1;
          // NESSY (header item 13): a new attempt began — running until its `node-finished`; its session is the one
          // the next `node-spawned` names (as `markRunning` clears it, item 11).
          st.state = 'running';
          st.sessionId = undefined;
        }
      } else if (e.kind === 'node-retry') {
        // NESSY (header item 13): a retry or a verdict-FAIL repair sent the node back — not done any more — and the
        // prompt preamble the live path built is rebuilt from the logged reason, so the resumed attempt is still one.
        const st = this.state.get(e.nodeId);
        if (st) {
          st.state = 'pending';
          st.lastFailure = failurePreamble(e.reason);
        }
      } else if (e.kind === 'node-finished') {
        const st = this.state.get(e.nodeId);
        if (st) {
          st.state = e.state;
          if (e.state === 'done') st.lastFailure = undefined; // a later re-run is not a retry of this attempt
        }
      } else if (e.kind === 'verdict') {
        // Reconstruct the durable repair counters so a cross-restart resume honors the cap rather
        // than restarting the budget from zero (the in-memory counters reset on a fresh process).
        if (e.result === 'fail') this.repairsUsed += 1;
        else if (e.result === 'unparsed') this.unparsedReAsks += 1;
        else if (e.result === 'pass') this.unparsedReAsks = 0;
      }
    }
    for (const [nodeId, st] of this.state) {
      if (st.state === 'done') {
        const out = loadOutput(nodeId);
        if (out) this.outputs[nodeId] = out;
        else st.state = 'pending'; // recorded output missing → must re-run
      } else if (st.state === 'running' || st.state === 'cancelled') {
        // NESSY (header item 13): a child in flight at shutdown is abandoned — its node re-dispatches in a new one.
        if (st.state === 'running' && st.sessionId) this.abandonedSessions.push(st.sessionId);
        st.state = 'pending'; // in-flight at shutdown / cancelled → re-dispatch on resume
      }
    }
    this.inFlight = 0;
  }

  /** NESSY (header item 13): children in flight when the process ended, moved to `todo` when the run resumes. */
  private readonly abandonedSessions: string[] = [];

  /** Resume a hydrated run: subscribe, log, and schedule the ready set (finished nodes are skipped). */
  resumeFromHydrated(): void {
    if (this.unsubscribe) return;
    this.runStatus = 'running';
    this.unsubscribe = this.deps.host.onSessionComplete((evt) => this.onSessionComplete(evt));
    this.log({ kind: 'run-resumed' });
    for (const sessionId of this.abandonedSessions.splice(0)) {
      void this.deps.host.setKanbanColumn(sessionId, 'todo');
      // UA12.75 (header item 13): its card goes too — an Allow there would re-drive a turn the run ignores.
      void this.deps.host.withdrawPendingApproval?.(sessionId).catch(() => {});
    }
    this.scheduleReady();
  }

  async stop(): Promise<void> {
    if (this.isTerminal()) return;
    this.runStatus = 'stopped';
    this.log({ kind: 'run-stopped' });
    for (const [nodeId, st] of this.state) {
      if (st.state === 'running') {
        st.state = 'cancelled';
        this.log({ kind: 'node-finished', nodeId, sessionId: st.sessionId ?? '', state: 'cancelled', reason: 'stopped' });
        if (st.sessionId) {
          void this.deps.host.cancelProcessing(st.sessionId, true);
          void this.deps.host.setKanbanColumn(st.sessionId, 'todo');
        }
      }
    }
    this.inFlight = 0;
    this.finalize();
  }

  waitUntilSettled(): Promise<RunSnapshot> {
    if (this.settled) return Promise.resolve(this.snapshot());
    return new Promise((resolve) => this.settleResolvers.push(resolve));
  }

  snapshot(): RunSnapshot {
    return {
      slug: this.slug,
      runId: this.runId,
      taskId: this.spec.id,
      status: this.runStatus,
      orchestratorSessionId: this.opts.orchestratorSessionId,
      tokensUsed: this.tokensUsed,
      nodes: this.spec.nodes.map((n) => {
        const st = this.state.get(n.id)!;
        return { id: n.id, state: st.state, sessionId: st.sessionId, attempt: st.attempt };
      }),
    };
  }

  // --- scheduling ---

  private scheduleReady(): void {
    if (this.runStatus !== 'running') return;
    for (const node of this.spec.nodes) {
      if (this.inFlight >= this.maxParallel) break;
      if (!this.isReady(node)) continue;
      if (this.isOverBudget()) {
        this.pauseForBudget();
        return;
      }
      this.markRunning(node);
      void this.dispatch(node);
    }
    this.maybeFinish();
  }

  private isReady(node: TaskNode): boolean {
    if (this.state.get(node.id)!.state !== 'pending') return false;
    for (const dep of this.edges.get(node.id) ?? []) {
      if (this.state.get(dep)?.state !== 'done') return false;
    }
    return true;
  }

  private markRunning(node: TaskNode): void {
    const st = this.state.get(node.id)!;
    st.state = 'running';
    st.attempt += 1;
    // NESSY (header item 11): the previous attempt's session no longer speaks for this node. Until dispatch() assigns
    // the new child (after the prompt build, the handle lookup and createSession), no completion can settle it.
    st.sessionId = undefined;
    this.inFlight += 1;
    this.log({ kind: 'node-scheduled', nodeId: node.id });
  }

  private async dispatch(node: TaskNode): Promise<void> {
    try {
      // Task-level skills ride as [skill:slug] mentions on every child prompt — the agent
      // pipeline resolves each SKILL.md and blocks tools until it is read (skills-as-context).
      const prompt = skillsPreamble(this.spec.skills) + (await this.buildPrompt(node));
      // NESSY (header item 2): children run where the orchestrator runs — its folder HANDLE and its project
      // entity. Never `spec.cwd` (a raw path from a yaml) and never `spec.project`.
      const orchestrator = this.opts.orchestratorSessionId;
      const projectHandleId = orchestrator ? await this.deps.host.getSessionProjectHandleId(orchestrator) : undefined;
      const projectId = orchestrator ? this.deps.host.getSessionProjectId(orchestrator) : undefined;
      // NESSY (header item 3): node override → task default → the orchestrator's mode, never above it. The ceiling
      // is the BROADER of the live reading and — a rehydrated run — the recorded one (header item 15, UA12.152):
      // the record is the grant the run was started under (the restart's resume-table demotion must not narrow a
      // resumed child into a card nothing answers), the live reading still propagates a post-restart raise.
      const liveCeiling = orchestrator ? this.deps.host.getSessionPermissionMode(orchestrator) : undefined;
      // UA12.171: a hydrated run re-reads its recorded carrier at every dispatch, so a deliberate change the host
      // recorded after the resume (`mode-changed`) caps this dispatch; an unreadable log keeps the hydrated grant.
      const recordedCeiling = this.hydratedPermissionCeiling
        ? (recordedLiveRunPermissionCeiling(this.deps.workspaceRoot, this.slug, this.runId) ?? this.hydratedPermissionCeiling)
        : undefined;
      const ceiling = broadestPermissionCeiling(liveCeiling, recordedCeiling);
      const requested = node.permissionMode ?? this.spec.defaults?.permissionMode ?? ceiling;
      // UA12.78 (header item 3): no orchestrator, no grant — a requested mode is clamped at `default`; unset stays unset.
      const bound = ceiling ?? (orchestrator ? undefined : ORCHESTRATORLESS_CEILING);
      const permissionMode = requested && bound ? clampPermissionModeToParent(requested, bound) : requested;
      const model = node.model ?? this.spec.defaults?.model;
      // Required for non-default (e.g. pi/*) models to resolve a backend — without it the
      // child session completes instantly with no output.
      const llmConnection = node.llmConnection ?? this.spec.defaults?.llmConnection;
      const options: CreateSessionOptions = {
        ...(orchestrator ? { parentSessionId: orchestrator } : {}),
        // Link the child back to the task / run / node so the manual subtask composer can
        // tell Conductor-owned children apart from hand-authored subtasks (it skips the former).
        taskSlug: this.slug,
        taskRunId: this.runId,
        taskNodeId: node.id,
        name: nodeTitle(node),
        ...(model ? { model } : {}),
        ...(llmConnection ? { llmConnection } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(node.labels ? { labels: node.labels } : {}),
        // Inherit the orchestrator's task number (task::N) so the whole run filters as one task.
        applyTaskLabel: true,
        // Task-level sources become the child's enabled-sources set (spec omitted → workspace default). They
        // select WORKSPACE sources only: plugin MCP servers follow plugin enablement (UA4.1 reading).
        ...(this.spec.sources?.length ? { enabledSourceSlugs: this.spec.sources } : {}),
        ...(projectId ? { projectId } : {}),
        ...(projectHandleId ? { projectHandleId } : {}),
        ...(this.runningStatusDefined() ? { sessionStatus: RUNNING_STATUS } : {}),
      };
      // The host's createSession announces the child to the renderer, so it nests under the task
      // tile with its real title instead of a fabricated "New Chat" (or never appearing).
      const child = await this.deps.host.createSession(this.deps.workspaceId, options);
      const st = this.state.get(node.id)!;
      st.sessionId = child.id;
      this.sessionToNode.set(child.id, node.id);
      // NESSY (header item 15, UA12.152): the effective mode of THIS dispatch rides the entry, and UA12.173 its
      // CEILING the carrier, so a later rehydrate's recorded ceiling is as fresh as the live one (a mid-run raise or
      // lower lands here) and a node override narrower than the ceiling (plan) never narrows the run.
      this.log({ kind: 'node-spawned', nodeId: node.id, sessionId: child.id, ...(permissionMode ? { permissionMode } : {}), ...(ceiling ? { ceilingPermissionMode: ceiling } : {}) });
      await this.deps.host.setKanbanColumn(child.id, 'in-progress');
      await this.deps.host.sendMessage(child.id, prompt);
    } catch (err) {
      this.failNode(node.id, `dispatch failed: ${(err as Error).message}`);
    }
  }

  /** Resolve a node's prompt: declared inputs (+ optional summarize) then ${…} interpolation. */
  private async buildPrompt(node: TaskNode): Promise<string> {
    const inputValues: Record<string, unknown> = {};
    for (const [name, ref] of Object.entries(node.inputs ?? {})) {
      const fromExpr = typeof ref === 'string' ? ref : ref.from;
      const summarize = typeof ref === 'string' ? false : !!ref.summarize;
      let resolved = interpolateRefs(fromExpr, { nodeOutputs: this.outputs, params: this.opts.params });
      if (summarize && this.deps.summarize) resolved = await this.deps.summarize(resolved);
      inputValues[name] = resolved;
    }
    let text = interpolateRefs(node.prompt ?? '', { nodeOutputs: this.outputs, params: this.opts.params });
    text = text.replace(INPUTS_REF_RE, (raw, name: string) => (name in inputValues ? String(inputValues[name]) : raw));

    // v0.15.1 (UB1.14): the replies of the `depends_on` steps the prompt does not already place are prepended.
    const upstream = this.upstreamReplies(node);
    if (upstream) text = `${upstream}\n\n${text}`;

    // Failure-aware retry: prepend the prior failure so a retried session knows what went wrong
    // instead of blindly repeating a deterministic failure.
    const st = this.state.get(node.id)!;
    if (st.attempt > 1 && st.lastFailure) {
      text = `${st.lastFailure}\n\n${text}`;
    }
    return text;
  }

  /**
   * v0.15.1:packages/server-core/src/tasks/TaskRunner.ts (B4-16, UB1.14) — the replies of the `depends_on` steps
   * that the prompt does not already pull in with ${nodes.<id>.output} (directly or through `inputs`). Authors add
   * the edge and write "based on the exploration output"; the dependent used to start without it (upstream found
   * this live 2026-10-11, on the same generator prompt we had ported). A reply the prompt already places by an
   * explicit ref is NOT added again; an empty one adds nothing. A reply over {@link MAX_UPSTREAM_REPLY_CHARS} is
   * cut, pointing at the full `nodes/<id>.json`.
   *
   * NESSY: what it reads is our output recording — `completeNode` stores this turn's settled text (header item 4,
   * turn-scoped; header item 6, the settlement gate). Upstream v0.15.1's `st.replies` join of a stopped step's
   * turns is UB2.8's arm and is deliberately not ported here.
   */
  private upstreamReplies(node: TaskNode): string | null {
    const pulledIn = new Set<string>();
    const refTexts = [node.prompt ?? '', ...Object.values(node.inputs ?? {}).map((ref) => (typeof ref === 'string' ? ref : ref.from))];
    for (const text of refTexts) {
      for (const ref of extractRefs(text)) if (ref.kind === 'node' && !ref.field) pulledIn.add(ref.nodeId);
    }
    const sections: string[] = [];
    for (const depId of nodeDeps(node)) {
      const reply = this.outputs[depId]?.text;
      if (pulledIn.has(depId) || !reply?.trim()) continue;
      const dep = this.spec.nodes.find((n) => n.id === depId);
      const body = reply.length > MAX_UPSTREAM_REPLY_CHARS
        ? `${reply.slice(0, MAX_UPSTREAM_REPLY_CHARS)}\n…[cut at ${MAX_UPSTREAM_REPLY_CHARS} characters; the full reply is in ${nodeOutputPath(this.deps.workspaceRoot, this.slug, this.runId, depId)}]`
        : reply;
      sections.push(`### ${dep ? nodeTitle(dep) : depId}\n${body}`);
    }
    if (sections.length === 0) return null;
    return [`Replies of the step${sections.length === 1 ? '' : 's'} this one depends on:`, '', ...sections, '', '---'].join('\n');
  }

  // --- completion ---

  private onSessionComplete(evt: SessionCompletionEvent): void {
    const nodeId = this.sessionToNode.get(evt.sessionId);
    if (!nodeId) return; // not one of our child nodes
    const st = this.state.get(nodeId);
    // NESSY (header item 11): a previous attempt's session is not this attempt.
    if (!st || st.sessionId !== evt.sessionId) return;
    if (st.state === 'done') {
      // NESSY (header item 6): a turn ran in a node already marked done — the host started it after the idle door
      // (a background producer the settlement does not count). Recorded, never re-read as output.
      this.log({ kind: 'node-woke-after-done', nodeId, sessionId: evt.sessionId });
      return;
    }
    if (st.state !== 'running') return; // already settled/cancelled

    if (evt.tokenUsage) {
      // `tokenUsage` is cumulative-per-session; add only the delta since this session's last
      // observed total so a node that ever runs >1 turn (future retry/loop) can't double-count.
      const cumulative = (evt.tokenUsage.inputTokens ?? 0) + (evt.tokenUsage.outputTokens ?? 0);
      const prev = this.sessionTokens.get(evt.sessionId) ?? 0;
      this.tokensUsed += Math.max(0, cumulative - prev);
      this.sessionTokens.set(evt.sessionId, cumulative);
    }

    // Completion-time budget check: pause immediately on breach (not only at schedule-time), but
    // only while pending work remains — never block a run that is about to finish.
    if (this.isOverBudget() && this.runStatus === 'running' && this.hasPendingNodes()) {
      this.pauseForBudget();
    }

    const gate = this.deps.host.isSessionSettled;
    if (evt.reason === 'complete' && !evt.terminalIsError && gate) {
      // NESSY (header item 6): accept the idle door only once the session is settled; otherwise the next one.
      if (evt.finalText !== undefined) this.deferredText.set(evt.sessionId, evt.finalText);
      this.deferredNewestMessageId.set(evt.sessionId, this.deps.host.getSessionFinalMessage?.(evt.sessionId)?.id ?? evt.finalMessageId);
      this.checkSettlement(nodeId, evt.sessionId, evt.fromUser !== false);
      return;
    }

    if (evt.reason === 'complete' && evt.terminalIsError) {
      // NESSY (header item 5): the backend's own verdict says the turn failed.
      this.failNode(nodeId, `error${evt.terminalReason ? `: ${evt.terminalReason}` : ''}`, evt.sessionId);
    } else if (evt.reason === 'complete') {
      // NESSY (header item 4): turn-scoped — no fallback to an earlier turn's answer.
      this.completeNode(nodeId, evt.sessionId, evt.finalText ?? '', evt.fromUser !== false);
    } else if (evt.reason === 'interrupted' || evt.reason === 'timeout') {
      // UB2.8 (B4-15, OQ-B4-3 (a); upstream v0.15.1 `TaskRunner.ts`): the user stopped the
      // step, usually to steer it. It is not finished and must not fail or cancel: it WAITS
      // for them in its own session — the node stays running, the run keeps going, and the
      // user's next turn in that session completes it with its reply. A `timeout` answers a
      // Stop deadline the same way.
      if (evt.fromUser !== false) {
        st.waitingForUser = true;
        this.log({ kind: 'node-waiting', nodeId, sessionId: evt.sessionId, reason: 'stopped' });
        void this.deps.host.setSessionStatus(evt.sessionId, WAITING_FOR_USER_STATUS);
        return;
      }
      // NESSY (header item 9): a host interruption with no user behind it (a restart, a
      // redirect respawn) still PAUSES the run; Resume re-dispatches the cancelled node.
      st.state = 'cancelled';
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.log({ kind: 'node-finished', nodeId, sessionId: evt.sessionId, state: 'cancelled', reason: 'interrupted' });
      void this.deps.host.setKanbanColumn(evt.sessionId, 'todo');
      this.pause();
      this.scheduleReady();
    } else {
      // 'error'
      this.failNode(nodeId, evt.reason, evt.sessionId);
    }
  }

  /**
   * NESSY (header items 6 and 14): read the settlement gate for a node's idle door. Settled → the node completes with
   * the deferred text; unsettled → the next idle door, or the re-check {@link SETTLEMENT_RECHECK_MS} later, whichever
   * comes first. Every arm re-reads the node first, so a door and a re-check landing together complete it once.
   */
  private checkSettlement(nodeId: string, sessionId: string, fromUser = true): void {
    const gate = this.deps.host.isSessionSettled;
    if (!gate) return;
    void gate.call(this.deps.host, sessionId).catch(() => false).then((settled) => {
      const now = this.state.get(nodeId);
      if (this.settled || !now || now.state !== 'running' || now.sessionId !== sessionId) return;
      if (!settled) {
        this.armSettlementRecheck(nodeId, sessionId, fromUser);
        return;
      }
      // UA12.100 (header item 4): a final message written after the door — the Claude CLI's own delivery turn — wins.
      const atDoor = this.deferredNewestMessageId.get(sessionId);
      this.deferredNewestMessageId.delete(sessionId);
      const newest = this.deps.host.getSessionFinalMessage?.(sessionId);
      const text = newest && newest.id !== atDoor ? newest.text : (this.deferredText.get(sessionId) ?? '');
      this.deferredText.delete(sessionId);
      this.completeNode(nodeId, sessionId, text, fromUser);
    });
  }

  private armSettlementRecheck(nodeId: string, sessionId: string, fromUser = true): void {
    if (this.settled || this.recheckTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.recheckTimers.delete(sessionId);
      this.checkSettlement(nodeId, sessionId, fromUser);
    }, this.deps.settlementRecheckMs ?? SETTLEMENT_RECHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    this.recheckTimers.set(sessionId, timer);
  }

  /** A node's `complete` was accepted: record its output (or fail a node that owed output and gave none). */
  private completeNode(nodeId: string, sessionId: string, text: string, fromUser = true): void {
    const st = this.state.get(nodeId)!;
    // UB2.8 (B4-15): background agents survive a Stop and wake the session when they finish.
    // That turn's reply is kept as the node's running output, but the step still waits for the
    // user it was stopped for — their next turn completes it.
    if (st.waitingForUser && !fromUser) return;
    st.waitingForUser = false;
    // UB2.8 (B4-19; upstream 'finished without a reply'): a finished turn that delivered NO
    // reply fails the node — declared outputs or not — so the dependents never read an empty
    // answer as done. The retry policy applies from here.
    if (text.trim() === '') {
      this.failNode(nodeId, 'finished without a reply', sessionId);
      return;
    }
    // UB6.7 — the decision model reads how the child's turn ended before the node is marked
    // done; off (or the isActive() short-circuit) completes synchronously as before.
    if (this.deps.classifyNodeOutcome && (this.deps.classifyNodeOutcome.isActive?.() ?? true)) {
      void this.finishNodeAfterOutcomeCheck(nodeId, sessionId, text);
      return;
    }
    this.markNodeDone(nodeId, sessionId, text);
  }

  /** UB6.7 — the completion body as it was before the classifier existed. */
  private markNodeDone(nodeId: string, sessionId: string, text: string): void {
    const st = this.state.get(nodeId)!;
    const output: NodeOutput = { text };
    this.outputs[nodeId] = output;
    st.state = 'done';
    this.inFlight = Math.max(0, this.inFlight - 1);
    writeNodeOutput(this.deps.workspaceRoot, this.slug, this.runId, nodeId, output);
    this.log({ kind: 'node-finished', nodeId, sessionId, state: 'done' });
    void this.deps.host.setSessionStatus(sessionId, DONE_STATUS);
    void this.deps.host.setKanbanColumn(sessionId, 'done');
    this.scheduleReady();
  }

  /**
   * UB6.7 — ask the decision model how the child's turn ended before marking it done. The
   * classifier's input is the node output as UB2.8 defines it (the last settled reply this
   * door accepted — our logged divergence from upstream's join of `st.replies`). The node
   * stays `running` meanwhile; a stopped run, or a node re-dispatched during the await,
   * drops the answer. A node that asked for input or reported it is blocked is FAILED (the
   * retry policy applies): nobody is present inside a task run to answer it.
   */
  private async finishNodeAfterOutcomeCheck(nodeId: string, sessionId: string, text: string): Promise<void> {
    let outcome: 'finished' | 'needs_input' | 'blocked' | null = null;
    try {
      outcome = await this.deps.classifyNodeOutcome!(text, { slug: this.slug, runId: this.runId, nodeId });
    } catch {
      outcome = null;
    }
    const st = this.state.get(nodeId);
    if (!st || st.state !== 'running' || st.sessionId !== sessionId) return;
    if (this.runStatus === 'stopped' || this.runStatus === 'completed' || this.runStatus === 'failed') return;

    try {
      if (outcome === 'needs_input') {
        this.failNode(nodeId, 'asked for input instead of finishing (nobody answers inside a task run: decide and continue)', sessionId);
      } else if (outcome === 'blocked') {
        this.failNode(nodeId, 'reported that it could not finish', sessionId);
      } else {
        this.markNodeDone(nodeId, sessionId, text);
      }
    } catch (err) {
      // Same reporting channel as the synchronous completion listener; the async hop would
      // otherwise route this to unhandledRejection.
      console.error(`[conductor] node completion failed for ${this.slug}/${this.runId}/${nodeId}:`, err);
    }
  }

  private failNode(nodeId: string, reason: string, sessionId?: string): void {
    const st = this.state.get(nodeId)!;
    const wasRunning = st.state === 'running';
    if (wasRunning) this.inFlight = Math.max(0, this.inFlight - 1);

    // Bounded, failure-aware retry: re-dispatch the node when its `retry` policy still
    // has budget and matches this failure class. error/timeout/dispatch failures all map
    // to the `error` retry trigger (empty/invalid detection is deferred).
    const node = this.spec.nodes.find((n) => n.id === nodeId);
    const retry = node?.retry;
    if (retry && st.attempt <= retry.limit && retryMatches(retry.when, 'error')) {
      st.lastFailure = failurePreamble(reason);
      st.state = 'pending';
      const sid = sessionId ?? st.sessionId;
      if (sid) void this.deps.host.setKanbanColumn(sid, 'todo');
      this.log({ kind: 'node-retry', nodeId, attempt: st.attempt, reason });
      this.scheduleReady();
      return;
    }

    st.state = 'failed';
    const sid = sessionId ?? st.sessionId;
    this.log({ kind: 'node-finished', nodeId, sessionId: sid ?? '', state: 'failed', reason });
    if (sid) void this.deps.host.setSessionStatus(sid, FAILED_STATUS);
    this.scheduleReady();
  }

  private maybeFinish(): void {
    if (this.runStatus !== 'running') return;
    if (this.inFlight > 0) return;
    if (this.spec.nodes.some((n) => this.isReady(n))) return; // more to dispatch
    const allGood = this.spec.nodes.every((n) => {
      const s = this.state.get(n.id)!.state;
      return s === 'done' || s === 'skipped';
    });
    if (!allGood) {
      this.finish('failed');
      return;
    }
    // All nodes succeeded. Gate the terminal status on the orchestrator's verdict when there is one
    // to ask; with no orchestrator there is nothing to verify against, so complete directly.
    if (this.opts.verifyOnComplete && this.opts.orchestratorSessionId) {
      this.enterVerifying();
    } else {
      this.finish('completed');
    }
  }

  /** Enter the non-terminal `verifying` state and ask the orchestrator for a verdict. Does NOT finalize. */
  private enterVerifying(): void {
    this.runStatus = 'verifying';
    this.log({ kind: 'run-verifying' });
    void this.sendVerification();
  }

  private finish(status: RunStatus): void {
    this.runStatus = status;
    this.log({ kind: status === 'completed' ? 'run-completed' : 'run-failed' });
    // Settle the task tile: completed → done, failed → needs-review (the fixed status set has no
    // 'failed'). The in-progress column was set at start(). Kept from upstream and stated (spec §8, OQ-6).
    const orchestrator = this.opts.orchestratorSessionId;
    if (orchestrator) {
      if (status === 'completed') {
        void this.deps.host.setKanbanColumn(orchestrator, 'done');
        void this.deps.host.setSessionStatus(orchestrator, DONE_STATUS);
      } else {
        void this.deps.host.setSessionStatus(orchestrator, FAILED_STATUS);
      }
    }
    this.finalize();
  }

  private finalize(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.verdictOff?.();
    this.verdictOff = undefined;
    for (const timer of this.recheckTimers.values()) clearTimeout(timer);
    this.recheckTimers.clear();
    if (this.settled) return;
    this.settled = true;
    const snap = this.snapshot();
    for (const resolve of this.settleResolvers) resolve(snap);
    this.settleResolvers = [];
  }

  private async sendVerification(): Promise<void> {
    const orchestrator = this.opts.orchestratorSessionId;
    if (!orchestrator) {
      this.finish('completed');
      return;
    }
    const verdict = this.attachVerdictListener(orchestrator);
    const sections = this.spec.nodes.map((n) => {
      const out = this.outputs[n.id];
      return `### ${nodeTitle(n)} (${n.id})\n${out ? out.text : '(no output)'}`;
    });
    const rubric = this.spec.acceptance_criteria
      ? `Acceptance criteria:\n${this.spec.acceptance_criteria}`
      : `Goal: ${this.spec.goal}`;
    const message = [
      `The task "${this.spec.title}" has finished running.`,
      '',
      rubric,
      '',
      'Node outputs:',
      ...sections,
      '',
      'Verify the final result against the criteria above and summarize the outcome.',
      'End your reply with a verdict line, on its own line, in exactly one of these forms:',
      'VERDICT: PASS',
      'VERDICT: FAIL — <one-line reason>',
      'If only some subtasks need redoing, name them so only those (and their dependents) re-run:',
      'VERDICT: FAIL — nodes=<id>,<id> — <one-line reason>',
    ].join('\n');
    await this.sendToOrchestrator(orchestrator, message, verdict);
  }

  /**
   * Attach the one-shot orchestrator-verdict listener (separate from the run's main subscription).
   * It catches the orchestrator's next completion, detaches itself, and routes the text to handleVerdict.
   * NESSY (header item 7): it reads nothing until `arm()` — called once the verify message is DELIVERED — so a
   * completion of a turn that began before that message is never taken as the verdict.
   */
  private attachVerdictListener(orchestrator: string): { arm: () => void } {
    this.verdictOff?.();
    let armed = false;
    this.verdictOff = this.deps.host.onSessionComplete((evt) => {
      if (evt.sessionId !== orchestrator || !armed) return;
      // UB2.8 (B4-17; upstream v0.15.1): a stopped verification turn is NOT an answer — the
      // user stopped it to steer; their continuing turn answers. Stay armed (no detach, no
      // re-ask), so the next completion is taken as the verdict.
      if (evt.reason === 'interrupted' || evt.reason === 'timeout') return;
      // NESSY (header item 4): this turn's text only. UA12.76: EVERY final row of it, joined in order (the last verdict
      // line still wins), so a codex verdict written in an earlier agent message of the turn is read, not re-asked.
      const text = evt.turnFinalTexts?.length ? evt.turnFinalTexts.join('\n') : (evt.finalText ?? '');
      const verdict = parseVerdict(text);
      // UB2.8 (B4-17, OUR door, not upstream's count): an UNPARSED verdict at an unsettled
      // session is a door the settlement gate has not passed — wait for the next door instead
      // of re-asking mid-drain. A parsed verdict answers at once.
      if (verdict.result === 'unparsed' && this.deps.host.isSessionSettled) {
        void this.deps.host.isSessionSettled(orchestrator).catch(() => false).then((settled) => {
          if (!settled) return; // stay armed; the next completion (or re-check arm) answers
          if (!armed) return;
          this.verdictOff?.();
          this.verdictOff = undefined;
          this.handleVerdict(text);
        });
        return;
      }
      this.verdictOff?.();
      this.verdictOff = undefined;
      this.handleVerdict(text);
    });
    return { arm: () => { armed = true; } };
  }

  /** Send to the orchestrator, failing the run (rather than hanging in `verifying`) if the send rejects. */
  private async sendToOrchestrator(orchestrator: string, message: string, verdict: { arm: () => void }): Promise<void> {
    try {
      await this.deps.host.sendMessage(orchestrator, message);
      verdict.arm();
    } catch {
      // The verdict will never arrive — detach the listener and settle as failed instead of hanging.
      this.verdictOff?.();
      this.verdictOff = undefined;
      if (this.runStatus === 'verifying') this.finish('failed');
    }
  }

  /**
   * Apply the orchestrator's parsed verdict:
   *   PASS      → completed.
   *   unparsed  → re-ask for a well-formed verdict (bounded; not a repair); exhausted → failed.
   *   FAIL      → repair the frontier if budget remains, else failed (iterations/token budget breach).
   */
  private handleVerdict(text: string): void {
    if (this.runStatus !== 'verifying') return; // stopped/finalized while awaiting the verdict
    writeNodeOutput(this.deps.workspaceRoot, this.slug, this.runId, '__verdict__', { text });
    const verdict = parseVerdict(text);
    // UB6.6 — an unparsed reply is first CLASSIFIED by the decision model when one is wired
    // (deps.decide); the parseable-VERDICT-line path never reaches it.
    if (verdict.result === 'unparsed' && this.deps.decide) {
      void this.classifyUnparsedVerdict(text);
      return;
    }
    this.log({ kind: 'verdict', result: verdict.result, reason: verdict.reason, nodes: verdict.nodes });
    this.applyVerdict(verdict);
  }

  /**
   * UB6.6 — ask the decision model what an unparsed reply concludes. A confident PASS/FAIL is
   * applied like a parsed one (logged `via: 'decision'`); anything else is treated as
   * `unparsed` exactly as before. The run may have been stopped while we waited — re-check
   * before acting. Never throws into the run: failures fall through to the old re-ask.
   */
  private async classifyUnparsedVerdict(text: string): Promise<void> {
    const nodeIds = this.spec.nodes.map((n) => n.id);
    let outcome: Awaited<ReturnType<typeof classifyVerdictWithDecision>>;
    try {
      outcome = await classifyVerdictWithDecision(text, nodeIds, (request) =>
        this.deps.decide!(request, { slug: this.slug, runId: this.runId }),
      );
    } catch {
      outcome = { kind: 'unavailable' };
    }
    if (this.runStatus !== 'verifying') return;
    if (outcome.kind === 'decided') {
      const { verdict } = outcome;
      this.log({ kind: 'verdict', result: verdict.result, reason: verdict.reason, nodes: verdict.nodes, via: 'decision', confidence: verdict.confidence });
      this.applyVerdict({ result: verdict.result, reason: verdict.reason, nodes: verdict.nodes, via: 'decision' });
      return;
    }
    // `via: 'decision'` only when a decision actually ran; an unavailable layer logs like before.
    this.log(outcome.kind === 'unsure' ? { kind: 'verdict', result: 'unparsed', via: 'decision' } : { kind: 'verdict', result: 'unparsed' });
    this.applyVerdict({ result: 'unparsed' });
  }

  /**
   * Apply a verdict:
   *   PASS      → completed.
   *   unparsed  → re-ask for a well-formed verdict (bounded; not a repair); exhausted → failed.
   *   FAIL      → repair the frontier if budget remains, else failed (iterations/token budget breach).
   */
  private applyVerdict(verdict: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[]; via?: 'decision' }): void {
    if (verdict.result === 'pass') {
      this.unparsedReAsks = 0;
      this.finish('completed');
      return;
    }

    if (verdict.result === 'unparsed') {
      if (this.unparsedReAsks < MAX_UNPARSED_REASKS) {
        this.unparsedReAsks += 1;
        void this.reAskVerdict();
        return;
      }
      // Repeatedly malformed → don't hang the run forever.
      this.finish('failed');
      return;
    }

    // FAIL — repair the frontier if there is budget for it.
    if (this.repairsUsed >= this.maxRepairs) {
      this.log({ kind: 'budget-breach', metric: 'iterations', value: this.repairsUsed, limit: this.maxRepairs });
      this.finish('failed');
      return;
    }
    if (this.isOverBudget()) {
      this.log({ kind: 'budget-breach', metric: 'tokens', value: this.tokensUsed, limit: this.spec.token_budget! });
      this.finish('failed');
      return;
    }
    this.repairsUsed += 1;
    // UB6.6 — scoping needs the verifier's own reason: a FAIL the decision model read out of an
    // unparsed reply carries a fixed one. A narrowed repair gets one chance; the next FAIL
    // repairs everything. No picker wired → the whole frontier as before.
    const scopable = this.deps.pickRepairNodes && verdict.via !== 'decision' && !this.lastRepairScoped
      && (verdict.nodes?.length ?? 0) === 0 && verdict.reason;
    this.lastRepairScoped = false;
    if (scopable) {
      void this.repairAfterScoping(verdict.reason!);
      return;
    }
    this.repairForVerdict(verdict.reason, verdict.nodes);
  }

  /**
   * UB6.6 — ask the decision model which subtasks a FAIL reason implicates, then repair those
   * (and their dependents); no answer repairs the whole DAG. Dropped if the run was stopped
   * meanwhile. Scoping only: FAIL still means repair, and the repair budget is unchanged.
   */
  private async repairAfterScoping(reason: string): Promise<void> {
    let nodes: string[] | null = null;
    try {
      const candidates = this.spec.nodes.map((n) => ({ id: n.id, description: `${n.title ?? n.id}: ${n.prompt ?? ''}`.trim() }));
      nodes = await this.deps.pickRepairNodes!(reason, candidates, { slug: this.slug, runId: this.runId });
    } catch {
      nodes = null;
    }
    if (this.runStatus !== 'verifying') return;
    this.lastRepairScoped = nodes !== null;
    this.repairForVerdict(reason, nodes ?? undefined);
  }

  /** Re-ask the orchestrator for a parseable verdict line (format-only; does not consume repair budget). */
  private async reAskVerdict(): Promise<void> {
    const orchestrator = this.opts.orchestratorSessionId;
    if (!orchestrator) {
      this.finish('completed');
      return;
    }
    const verdict = this.attachVerdictListener(orchestrator);
    const message = [
      'Your previous reply did not include a parseable verdict line.',
      'Reply with the verdict line only, on its own line, in exactly one of these forms:',
      'VERDICT: PASS',
      'VERDICT: FAIL — <one-line reason>',
      'VERDICT: FAIL — nodes=<id>,<id> — <one-line reason>',
    ].join('\n');
    await this.sendToOrchestrator(orchestrator, message, verdict);
  }

  /**
   * On a FAIL verdict, re-run the repair frontier with the rejection reason as failure context.
   * The frontier is the orchestrator-named nodes ∪ their transitive dependents (so a re-run upstream
   * node forces everything that consumes its output to re-run too). With no usable names it is the
   * whole DAG. Only `done` nodes are reset; scheduleReady re-dispatches from the satisfied sources.
   */
  private repairForVerdict(reason: string | undefined, named?: string[]): void {
    const detail = reason ?? 'the result did not meet the acceptance criteria';
    let reset = 0;
    for (const id of this.computeFrontier(named)) {
      const st = this.state.get(id);
      if (!st || st.state !== 'done') continue;
      st.state = 'pending';
      st.lastFailure = failurePreamble(`${VERDICT_FAIL_PREFIX}${detail}`);
      this.log({ kind: 'node-retry', nodeId: id, attempt: st.attempt, reason: `${VERDICT_FAIL_PREFIX}${detail}` });
      reset += 1;
    }
    if (reset === 0) {
      // No `done` node in the frontier to re-run → don't hang the run.
      this.finish('failed');
      return;
    }
    this.runStatus = 'running';
    this.scheduleReady();
  }

  /**
   * The set of nodes a repair pass re-runs: the orchestrator-named nodes plus everything that
   * (transitively) depends on them. Unknown/empty names degrade to the whole DAG.
   */
  private computeFrontier(named?: string[]): Set<string> {
    const valid = (named ?? []).filter((id) => this.state.has(id));
    if (valid.length === 0) return new Set(this.spec.nodes.map((n) => n.id));
    const dependents = this.dependentsMap();
    const frontier = new Set<string>();
    const queue = [...valid];
    while (queue.length) {
      const id = queue.shift()!;
      if (frontier.has(id)) continue;
      frontier.add(id);
      for (const d of dependents.get(id) ?? []) if (!frontier.has(d)) queue.push(d);
    }
    return frontier;
  }

  /** Inverted `edges`: node id → set of nodes that directly depend on it (memoized). */
  private dependentsMap(): Map<string, Set<string>> {
    if (this.dependents) return this.dependents;
    const map = new Map<string, Set<string>>();
    for (const n of this.spec.nodes) map.set(n.id, new Set());
    for (const [node, upstreams] of this.edges) {
      for (const u of upstreams) map.get(u)?.add(node);
    }
    this.dependents = map;
    return map;
  }

  // --- budget ---

  private isOverBudget(): boolean {
    return this.spec.token_budget !== undefined && this.tokensUsed >= this.spec.token_budget;
  }

  private pauseForBudget(): void {
    this.log({ kind: 'budget-breach', metric: 'tokens', value: this.tokensUsed, limit: this.spec.token_budget! });
    this.pause();
  }

  /** True if any node is still waiting to be dispatched (used to avoid pausing a finishable run). */
  private hasPendingNodes(): boolean {
    for (const st of this.state.values()) if (st.state === 'pending') return true;
    return false;
  }

  // --- helpers ---

  /** NESSY (header item 8): the running status is written only when the workspace defines it. */
  private runningStatusDefined(): boolean {
    return this.deps.host.hasSessionStatus?.(RUNNING_STATUS) ?? false;
  }

  private isTerminal(): boolean {
    return this.runStatus === 'completed' || this.runStatus === 'failed' || this.runStatus === 'stopped';
  }

  private log(entry: RunLogEntryInput): void {
    const t = this.deps.now ? this.deps.now() : new Date().toISOString();
    appendRunLog(this.deps.workspaceRoot, this.slug, this.runId, { ...entry, t } as RunLogEntry);
  }
}

// ---------------------------------------------------------------------------
// TaskRunner — registry/service over active runs
// ---------------------------------------------------------------------------

/** The `node-retry` reason prefix of a verdict-FAIL repair (a retry's reason is the failure itself). */
const VERDICT_FAIL_PREFIX = 'verdict-fail: ';

/**
 * The preamble a retried or repaired attempt's prompt starts with, from the reason its `node-retry` logs — one
 * source for the live paths (`failNode`, `repairForVerdict`) and for `hydrate` (header item 13).
 */
function failurePreamble(reason: string): string {
  return reason.startsWith(VERDICT_FAIL_PREFIX)
    ? `The previous result was rejected on verification: ${reason.slice(VERDICT_FAIL_PREFIX.length)}. Revise your output to meet the acceptance criteria.`
    : `Previous attempt failed: ${reason}. Address the cause before retrying.`;
}

/**
 * Prefix for dispatched child prompts carrying the task's skill list as [skill:slug]
 * mentions. The agent pipeline (base-agent) parses these from any message, resolves each
 * skill's SKILL.md, and blocks tool use until the files are read — so task-level skills
 * act as mandatory context for every subtask. Empty/absent skills → empty prefix.
 */
function skillsPreamble(skills: string[] | undefined): string {
  if (!skills?.length) return '';
  return `Apply these skills: ${skills.map((s) => `[skill:${s}]`).join(' ')}\n\n`;
}

/**
 * Whether a node's `retry.when` trigger covers a given failure class. An absent `when`
 * defaults to retrying on `error` (the common "transient failure" case); `empty`/`invalid`
 * triggers are opt-in and not yet produced by the runner, so they never match here.
 */
function retryMatches(when: 'error' | 'empty' | 'invalid' | undefined, failure: 'error'): boolean {
  return (when ?? 'error') === failure;
}

/**
 * Parse the orchestrator's machine-readable verdict line. Tolerant of surrounding prose: the last
 * `VERDICT: PASS|FAIL [— [nodes=a,b — ]reason]` occurrence wins. A missing/garbled line is `unparsed`
 * — the caller re-asks (bounded) rather than hanging the run on a malformed reply.
 *
 * The optional `nodes=<id>,<id>` prefix names the subtasks to re-run on a FAIL (scoped repair). Node
 * ids are slugs (may contain single hyphens), so the prefix is split from the reason on an em-dash or
 * colon only — never on the hyphen that legitimately appears inside a slug.
 */
function parseVerdict(text: string): { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] } {
  const matches = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)\b[ \t]*(?:[—:-]+[ \t]*([^\n]*))?/gi)];
  const last = matches.at(-1);
  if (!last) return { result: 'unparsed' };
  const result = last[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail';
  let rest = last[2]?.trim() || undefined;
  let nodes: string[] | undefined;
  if (rest) {
    const m = rest.match(/^nodes=([a-z0-9,\- ]+?)\s*(?:[—:]+\s*(.*))?$/i);
    if (m) {
      nodes = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
      rest = m[2]?.trim() || undefined;
    }
  }
  const out: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] } = { result };
  if (rest) out.reason = rest;
  if (nodes && nodes.length) out.nodes = nodes;
  return out;
}

/** A run is terminal (no further work) once completed/failed/stopped. running/paused/verifying are active. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

/**
 * NESSY (header item 15, UA12.152) — the broader of two optional permission ceilings, by the strictness order
 * `PERMISSION_MODE_ORDER` (a lower index is stricter; the order is the clamp's own index, so the two can never
 * disagree). Either side may be absent (no live reading, or a run-log written before the mode was recorded);
 * both absent → undefined. Used to merge a rehydrated run's RECORDED ceiling with the orchestrator's LIVE
 * mode at a re-dispatch: the broader of the two, never a cap on the live raise, never narrower than the grant.
 * UA12.165 exports it: SessionManager's child clamp floors its ceiling with the same rule, so the dispatch
 * and the post-creation clamp cannot compute two different ceilings for the same resumed child.
 */
export function broadestPermissionCeiling(
  live: PermissionMode | undefined,
  recorded: PermissionMode | undefined,
): PermissionMode | undefined {
  if (!live) return recorded;
  if (!recorded) return live;
  return PERMISSION_MODE_ORDER.indexOf(live) >= PERMISSION_MODE_ORDER.indexOf(recorded) ? live : recorded;
}

/**
 * NESSY (header item 15 follow-up, UA12.165 / RS-113 R2) — the orchestrator's recorded mode of a run that is
 * still LIVE, read from its run log for SessionManager's child clamp (`clampChildPermissionModeToParent`):
 * the LAST recorded carrier (`run-started` / `node-spawned`'s ceiling / `mode-changed`, {@link permissionCarrierOf}) is the grant the run last dispatched under, and
 * it floors a child's ceiling only while the log has not ended in a terminal state (`run-completed` /
 * `run-failed` / `run-stopped`) — once the run is over the recorded grant is stale and the ordinary parent
 * ceiling returns. `undefined` when nothing is recorded (a log from before UA12.152), the keys are absent
 * (not a run node), the log cannot be read (fail closed to today's behaviour — an unreadable log must not
 * mint a broader grant), or the run is no longer live, so every such caller keeps the pre-UA12.165 clamp.
 */
export function recordedLiveRunPermissionCeiling(
  workspaceRoot: string | undefined,
  slug: string | undefined,
  runId: string | undefined,
): PermissionMode | undefined {
  if (!workspaceRoot || !slug || !runId) return undefined;
  let log: RunLogEntry[];
  try {
    log = readRunLog(workspaceRoot, slug, runId);
  } catch {
    return undefined;
  }
  const status = runStatusFromLog(log);
  if (status !== 'running' && status !== 'paused' && status !== 'verifying') return undefined;
  let recorded: PermissionMode | undefined;
  for (const e of log) {
    // UA12.171: a recorded deliberate change (`mode-changed`) is the newest carrier, so a user's lower caps again.
    recorded = permissionCarrierOf(e) ?? recorded;
  }
  return recorded;
}

/**
 * NESSY (header item 15, UA12.173) — the permission-mode CARRIER a run-log entry holds, the one rule both readers
 * ({@link ActiveRun} `hydrate` and {@link recordedLiveRunPermissionCeiling}) apply: `run-started` and `mode-changed`
 * carry `permissionMode` (the orchestrator's), a `node-spawned` carries `ceilingPermissionMode` (the ceiling that
 * dispatch was clamped under). A `node-spawned`'s own `permissionMode` is the CHILD's mode after its override's clamp
 * (e.g. `plan` under a bypass orchestrator) — read as the carrier it narrowed every later re-dispatch, so it carries
 * nothing; neither does a `node-spawned` written before UA12.173 (the run's `run-started` grant stands).
 */
function permissionCarrierOf(e: RunLogEntry): PermissionMode | undefined {
  if (e.kind === 'run-started' || e.kind === 'mode-changed') return e.permissionMode;
  if (e.kind === 'node-spawned') return e.ceilingPermissionMode;
  return undefined;
}

/**
 * NESSY (header item 15, UA12.171) — record a DELIBERATE permission-mode change of an orchestrator in every run of
 * it that is still live (a non-terminal log whose `run-started` names this orchestrator: running, paused, verifying
 * or interrupted by a restart), as a `mode-changed` carrier. Called by SessionManager's mode-change doors after a
 * real transition only — never by the load-time resume table — so the recorded ceiling follows the user's lower
 * (and raise) while the restart demotion leaves the run's grant in place (UA12.165). Returns the run ids written.
 * A log that cannot be read is skipped (nothing to floor from it); a failed append throws to the caller, which
 * logs it.
 */
export function recordOrchestratorModeChange(
  workspaceRoot: string | undefined,
  slug: string | undefined,
  orchestratorSessionId: string,
  permissionMode: PermissionMode,
  t: string = new Date().toISOString(),
): string[] {
  if (!workspaceRoot || !slug) return [];
  const written: string[] = [];
  for (const runId of listRunIds(workspaceRoot, slug)) {
    let log: RunLogEntry[];
    try {
      log = readRunLog(workspaceRoot, slug, runId);
    } catch {
      continue;
    }
    const started = log.find((e) => e.kind === 'run-started');
    if (!started || started.kind !== 'run-started' || started.orchestratorSessionId !== orchestratorSessionId) continue;
    const status = runStatusFromLog(log);
    if (!status || isTerminalRunStatus(status)) continue;
    appendRunLog(workspaceRoot, slug, runId, { t, kind: 'mode-changed', permissionMode });
    written.push(runId);
  }
  return written;
}

/**
 * NESSY (header item 13) — the run status a persisted log ends in, from its lifecycle entries (the last one wins);
 * `undefined` for a log with none. A non-terminal answer with no live run is an INTERRUPTED run (`rpc/tasks.ts`).
 */
export function runStatusFromLog(log: RunLogEntry[]): RunStatus | undefined {
  let status: RunStatus | undefined;
  for (const e of log) {
    if (e.kind === 'run-started' || e.kind === 'run-resumed') status = 'running';
    else if (e.kind === 'run-paused') status = 'paused';
    else if (e.kind === 'run-verifying') status = 'verifying';
    else if (e.kind === 'run-completed') status = 'completed';
    else if (e.kind === 'run-failed') status = 'failed';
    else if (e.kind === 'run-stopped') status = 'stopped';
  }
  return status;
}

function resolveParams(spec: TaskSpec, provided?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of spec.params ?? []) if (p.default !== undefined) out[p.name] = p.default;
  return { ...out, ...(provided ?? {}) };
}

/**
 * UA12.90 (header item 16) — load a task's yaml ONCE, hash the bytes read, and refuse when they are not the
 * confirmed ones: `tasks:run` passes the digest its confirmation check read (`RunOptions.confirmedDigest`), so an
 * edit landing between that check and this read refuses instead of running unconfirmed bytes (P-UAal-2). Null when
 * there is no task.yaml (the caller's not-found refusal, as `loadTaskSpec`); the mismatch error is
 * `run-confirmation-required: <slug>` — the same refusal the check itself gives, which the renderer re-asks on
 * (`run-controls.ts`, one re-ask against the refreshed `tasks:get`).
 */
function loadConfirmedTaskSpec(
  workspaceRoot: string,
  slug: string,
  confirmedDigest: string,
): ReturnType<typeof parseTaskYaml> | null {
  const path = taskYamlPath(workspaceRoot, slug);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== confirmedDigest) throw new Error(`run-confirmation-required: ${slug}`);
  return parseTaskYaml(bytes.toString('utf-8'));
}

export class TaskRunner {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly deps: TaskRunnerDeps) {}

  private key(slug: string, runId: string): string {
    return `${slug}:${runId}`;
  }

  /**
   * One active run per orchestrator: a second concurrent run would race the same parent session's
   * verdict listener (two runs attaching onSessionComplete on the same orchestrator would cross
   * their verifications). Block it. NOTE: this does not guard against a human typing into the
   * orchestrator mid-`verifying` — that race is a known, bounded v1 limitation.
   */
  private assertNoActiveRun(slug: string, orchestrator: string | undefined): void {
    if (!orchestrator) return;
    for (const existing of this.runs.values()) {
      const snap = existing.snapshot();
      if (snap.orchestratorSessionId === orchestrator && !isTerminalRunStatus(snap.status)) {
        throw new Error(
          `Task "${slug}" already has an active run (${snap.runId}) on this orchestrator; stop it before starting another.`,
        );
      }
    }
  }

  /**
   * Load + validate a task's yaml and start a run. Rejects if the task is missing or invalid, if the
   * orchestrator already has an active run, or if the host's preflight refuses (NESSY, header item 10).
   */
  async run(slug: string, opts: RunOptions = {}): Promise<RunSnapshot> {
    // UA12.90 (header item 16): with a confirmed digest, this load hashes the bytes it reads and refuses a
    // mismatch BEFORE any scheduling, preflight or dispatch side effect.
    const loaded = opts.confirmedDigest !== undefined
      ? loadConfirmedTaskSpec(this.deps.workspaceRoot, slug, opts.confirmedDigest)
      : loadTaskSpec(this.deps.workspaceRoot, slug);
    if (!loaded?.spec) throw new Error(`Task "${slug}" not found or has no valid task.yaml`);
    if (!loaded.valid) {
      throw new Error(`Refusing to run invalid task "${slug}": ${loaded.errors.map((e) => e.message).join('; ')}`);
    }
    const orchestrator = opts.orchestratorSessionId;
    this.assertNoActiveRun(slug, orchestrator);
    if (this.deps.preflight) {
      await this.deps.preflight(loaded.spec, { slug, orchestratorSessionId: orchestrator, phase: 'run' });
      // Re-checked after the await: a concurrent run on the same orchestrator may have started meanwhile.
      this.assertNoActiveRun(slug, orchestrator);
    }
    const runId = opts.runId ?? (this.deps.genRunId ? this.deps.genRunId() : `run-${Date.now()}`);
    const run = new ActiveRun(
      loaded.spec,
      slug,
      runId,
      { ...opts, params: resolveParams(loaded.spec, opts.params), verifyOnComplete: opts.verifyOnComplete ?? true },
      this.deps,
    );
    this.runs.set(this.key(slug, runId), run);
    run.start();
    return run.snapshot();
  }

  pause(slug: string, runId: string): void {
    this.runs.get(this.key(slug, runId))?.pause();
  }

  async resume(slug: string, runId: string): Promise<void> {
    const existing = this.runs.get(this.key(slug, runId));
    if (existing) {
      // NESSY (header item 10): a paused run still in memory is re-checked too, against the spec it runs.
      const snap = existing.snapshot();
      if (this.deps.preflight && snap.status === 'paused') {
        await this.deps.preflight(existing.spec, { slug, orchestratorSessionId: snap.orchestratorSessionId, phase: 'resume' });
      }
      existing.resume(); // a no-op unless the run is still paused after the await
      return;
    }
    // Not in memory (e.g. after an app restart): reconstruct from the persisted run-log.
    await this.rehydrate(slug, runId);
  }

  /**
   * Reconstruct an in-memory run from its persisted run-log + node outputs, then resume it.
   * NESSY (header item 13): from the run's spec SNAPSHOT and the params `run-started` recorded — never the live
   * `task.yaml` — and only a run that has not ended, on an orchestrator with no other active run.
   */
  private async rehydrate(slug: string, runId: string): Promise<RunSnapshot> {
    const log = readRunLog(this.deps.workspaceRoot, slug, runId);
    if (log.length === 0) throw new Error(`Cannot resume "${slug}:${runId}": no run-log found`);
    const status = runStatusFromLog(log);
    if (status && isTerminalRunStatus(status)) throw new Error(`task-run-ended: "${slug}:${runId}" already ${status}`);
    const snapshot = readRunSpecSnapshot(this.deps.workspaceRoot, slug, runId);
    if (!snapshot) throw new Error(`task-run-snapshot-missing: "${slug}:${runId}" has no spec snapshot to resume from`);
    const checked = validateTaskInput(snapshot);
    if (!checked.valid || !checked.spec) {
      throw new Error(`task-run-snapshot-invalid: "${slug}:${runId}": ${checked.errors.map((e) => e.message).join('; ')}`);
    }
    const spec = checked.spec;
    const started = log.find((e) => e.kind === 'run-started');
    const orchestratorSessionId = started && started.kind === 'run-started' ? started.orchestratorSessionId : undefined;
    const params = started && started.kind === 'run-started' && started.params ? started.params : resolveParams(spec);
    this.assertNoActiveRun(slug, orchestratorSessionId);
    if (this.deps.preflight) {
      await this.deps.preflight(spec, { slug, orchestratorSessionId, phase: 'resume' });
      // A concurrent resume of the same run may have rehydrated it meanwhile.
      const raced = this.runs.get(this.key(slug, runId));
      if (raced) {
        raced.resume();
        return raced.snapshot();
      }
      // Re-checked after the await: another run on the same orchestrator may have started meanwhile.
      this.assertNoActiveRun(slug, orchestratorSessionId);
    }
    const run = new ActiveRun(
      spec,
      slug,
      runId,
      { orchestratorSessionId, params, verifyOnComplete: true },
      this.deps,
    );
    run.hydrate(log, (nodeId) => readNodeOutput(this.deps.workspaceRoot, slug, runId, nodeId));
    this.runs.set(this.key(slug, runId), run);
    run.resumeFromHydrated();
    return run.snapshot();
  }

  async stop(slug: string, runId: string): Promise<void> {
    const live = this.runs.get(this.key(slug, runId));
    if (live) {
      await live.stop();
      return;
    }
    // NESSY (header item 13): an interrupted run (a non-terminal log no live run holds) is closed on disk, so it
    // stops reading as interrupted. Nothing runs, so nothing is cancelled.
    const log = readRunLog(this.deps.workspaceRoot, slug, runId);
    const status = runStatusFromLog(log);
    if (status && !isTerminalRunStatus(status)) {
      const t = this.deps.now ? this.deps.now() : new Date().toISOString();
      appendRunLog(this.deps.workspaceRoot, slug, runId, { t, kind: 'run-stopped' });
    }
  }

  getRunState(slug: string, runId: string): RunSnapshot | null {
    return this.runs.get(this.key(slug, runId))?.snapshot() ?? null;
  }

  /** Await a run reaching a terminal state (completed/failed/stopped). */
  waitUntilSettled(slug: string, runId: string): Promise<RunSnapshot> {
    const run = this.runs.get(this.key(slug, runId));
    if (!run) return Promise.reject(new Error(`No active run ${slug}:${runId}`));
    return run.waitUntilSettled();
  }
}
