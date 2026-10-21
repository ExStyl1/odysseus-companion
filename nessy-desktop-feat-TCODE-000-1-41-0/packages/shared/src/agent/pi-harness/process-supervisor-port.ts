import type { SessionKey } from '../../sessions/types.ts'

export type ProcessIsolationProfile = 'none' | 'read-only' | 'workspace' | 'networked' | 'plugin-mcp' | 'isolated-code'
export type ProcessEnvironmentProfile = 'restricted' | 'explicit' | 'trusted-host'

/**
 * Why one process ran WITHOUT isolation.
 *
 * Recorded on the result and on the persisted record so an audit can tell an
 * intentional, policy-sanctioned downgrade from a host that simply has no
 * backend — the latter surfaces as the `no-host-isolation` fallback in
 * `tool-executor.ts`, and the two must never be confused for each other.
 */
export interface IsolationDowngradeV1 {
  reason: 'excludedCommands' | 'dangerouslyDisableSandbox' | 'sandboxDisabled'
  /** The `excludedCommands` pattern that matched, when that is the reason. */
  pattern?: string
  /** The explicit per-invocation decision, when that is the reason. */
  decisionId?: string
}

/** Isolation profile recorded for a command excluded by sandbox settings. */
export const EXCLUDED_BY_POLICY_PROFILE = 'excluded-by-policy'

/** Isolation profile recorded for an explicitly decided sandbox bypass. */
export const SANDBOX_DISABLED_BY_DECISION_PROFILE = 'sandbox-disabled-by-decision'

/**
 * Isolation profile recorded when the T1 `sandbox.enabled` master switch is
 * off. Its OWN marker constant, deliberately distinct from both the ones
 * above and from `no-host-isolation` (the `tool-executor.ts` fallback for a
 * result with no profile at all): a config-driven, product-wide "nothing here
 * is wrapped" must never read like a missing backend or a single sanctioned
 * exclusion.
 */
export const SANDBOX_DISABLED_BY_CONFIG_PROFILE = 'unsandboxed:disabled-by-config'

export interface SupervisedProcessStartRequest {
  sessionKey: SessionKey
  executionId: string
  semanticId: string
  command: string
  args?: string[]
  cwd: string
  workspaceRoot: string
  profile: ProcessIsolationProfile
  background: boolean
  timeoutMs: number
  /**
   * What timeout expiry does to a still-running foreground process.
   *
   * `'kill'` (the default) preserves the historical SIGTERM→SIGKILL path.
   * `'background'` transitions the process to a background task instead: it
   * keeps running and writing to its existing log, the record stays `running`
   * with the deadline lifted, and the start() await resolves immediately with
   * `movedToBackground: true` so the caller can hand the model the documented
   * task-id + output-file handle (doc-verification § R10, `tools-reference.md`
   * §Background commands). Ignored for `background` and `persistent` requests.
   */
  onTimeout?: 'kill' | 'background'
  signal?: AbortSignal
  stdin?: 'ignore' | 'pipe'
  /** One-shot stdin payload, written and closed immediately after spawn. */
  stdinData?: string
  /** Defaults to true. Set false for callers that provide a complete allowlisted environment. */
  inheritHostEnv?: boolean
  /** Host-owned inheritance class. Defaults to `restricted`; `trusted-host` must be explicit. */
  environmentProfile?: ProcessEnvironmentProfile
  /** Additional env vars merged over the selected host environment for this spawn only. */
  env?: Record<string, string>
  /** Host-authorized managed data roots. Child process requests may not set this field. */
  additionalWritableRoots?: readonly string[]
  /** Host-only exact integrity gate run after isolation resolution and immediately before spawn. */
  beforeStart?: () => Promise<void>
  /** Host-only stdout stream; stderr remains separate in the supervisor log. */
  onStdout?: (chunk: Uint8Array) => void
  /** Host-only terminal notification. */
  onClose?: (exitCode: number | null, signal: string | null) => void
  /** Host-only long-lived process; lifecycle is owned by stop/drain. */
  persistent?: boolean
  /** Host-only: keep protocol/secret-bearing output in memory only, never in the process log. */
  persistOutput?: boolean
  /** Host-only per-process stdin frame limit; bounded by the supervisor maximum. */
  maxStdinWriteBytes?: number
  /**
   * Host-only: run this ONE command outside isolation.
   *
   * Requires {@link SupervisedProcessStartRequest.isolationDowngradeDecision}
   * and is refused outright when the host's sandbox settings set
   * `allowUnsandboxedCommands: false` (strict sandbox mode).
   *
   * HOST-PRODUCED ONLY. Child process requests may not set it —
   * `handleProcessStartRequest` rebuilds the host request from an allowlist, so
   * a subprocess-supplied flag could not be honoured even if one were sent.
   *
   * The producer is `PiAgent.recordAuthorizedSandboxDowngrade`: the model spells
   * `dangerouslyDisableSandbox` on the Bash tool input, the host gate decides it
   * — including the documented ask rule `Bash(dangerouslyDisableSandbox:true)`
   * (sandboxing.md:135), which compiles to a parameter matcher and forces a
   * prompt — and only an ALLOWED call leaves an `executionId -> decisionId`
   * entry for the matching process start to consume. In strict sandbox mode the
   * producer drops the flag entirely, so the parameter is "completely ignored"
   * as sandboxing.md:137 requires; the refusal below stays as the floor for any
   * other caller.
   */
  dangerouslyDisableSandbox?: boolean
  /**
   * Host-only id of the explicit decision that authorized
   * `dangerouslyDisableSandbox`. Recorded on the execution receipt so the
   * downgrade cannot be silent.
   */
  isolationDowngradeDecision?: string
}

export type SupervisedProcessChildStartRequest = Omit<
  SupervisedProcessStartRequest,
  'sessionKey' | 'signal' | 'workspaceRoot' | 'inheritHostEnv' | 'environmentProfile' | 'env' | 'additionalWritableRoots'
    | 'beforeStart' | 'onStdout' | 'onClose' | 'persistent' | 'persistOutput'
    | 'maxStdinWriteBytes'
    // A child process request must never be able to ask for its own sandbox
    // bypass; only the host decides that.
    | 'dangerouslyDisableSandbox' | 'isolationDowngradeDecision'
>

/**
 * The host-side allowlist rebuild of a child process request.
 *
 * `handleProcessStartRequest` rebuilds the supervisor request field-by-field so
 * a subprocess can never smuggle host-only fields (sandbox bypass, env,
 * writable roots, callbacks). This function IS that allowlist — the host and
 * the e2e harness both call it, so a child-visible field that is not threaded
 * here provably never reaches the supervisor in production either.
 */
export function pickSupervisedChildStartFields(
  request: SupervisedProcessChildStartRequest,
): SupervisedProcessChildStartRequest {
  return {
    executionId: request.executionId,
    semanticId: request.semanticId,
    command: request.command,
    ...(request.args ? { args: request.args } : {}),
    cwd: request.cwd,
    profile: request.profile,
    background: request.background,
    timeoutMs: request.timeoutMs,
    ...(request.onTimeout ? { onTimeout: request.onTimeout } : {}),
    ...(request.stdin ? { stdin: request.stdin } : {}),
    ...(request.stdinData !== undefined ? { stdinData: request.stdinData } : {}),
  }
}

/**
 * The operator ceiling on a model-chosen Bash deadline, and the default that
 * applies when the model chooses nothing.
 *
 * `env-vars.md#variables`, the two rows verbatim:
 *
 * > `BASH_DEFAULT_TIMEOUT_MS` | Default timeout for long-running bash commands
 * > (default: 120000, or 2 minutes)
 *
 * > `BASH_MAX_TIMEOUT_MS` | Maximum timeout the model can set for long-running
 * > bash commands (default: 600000, or 10 minutes). The effective ceiling is the
 * > larger of this and `BASH_DEFAULT_TIMEOUT_MS`
 *
 * `tools-reference.md#timeout-and-output-limits` says the same thing in one
 * sentence each, and is the page that states what the ceiling DOES:
 *
 * > `BASH_DEFAULT_TIMEOUT_MS` — the default when Claude passes no timeout; two
 * > minutes out of the box
 *
 * > `BASH_MAX_TIMEOUT_MS` — with the default, sets the ceiling that caps
 * > whatever Claude requests: the effective ceiling is the larger of the two,
 * > ten minutes out of the box
 *
 * ## Why the ceiling lives HERE and is applied on the host
 *
 * The supervisor's deadline is `Date.now() + request.timeoutMs` and there is no
 * `Math.min` anywhere in it, so before this the model's own number was the only
 * input: an operator who set a maximum had bounded nothing. The clamp belongs
 * next to {@link pickSupervisedChildStartFields} because that is the host-side
 * allowlist rebuild a subprocess provably cannot smuggle a field past — the same
 * seam, for the same reason.
 *
 * ## `background` is exempt, and that is not an oversight
 *
 * A `background: true` start does not carry a model-chosen timeout at all: the
 * Pi subprocess stamps its own `BACKGROUND_PROCESS_MAX_LIFETIME_MS` (24 h) for
 * `bash_background` and for `run_in_background: true`. Clamping that would cut
 * every background task to ten minutes while bounding nothing the model chose.
 * Claude documents no ceiling for background-task lifetime, so inventing one
 * here would be a product decision, not parity.
 *
 * `persistent` starts (plugin-MCP, LSP, monitors) are exempt BY CONSTRUCTION
 * rather than by a branch: `persistent` is one of the fields
 * {@link SupervisedProcessChildStartRequest} omits, so a child request cannot
 * carry it and this clamp can never reach the supervisor's
 * `Number.MAX_SAFE_INTEGER` branch.
 */
export type BashTimeoutEnvRecord = Record<string, string | undefined>

/** The Nessy spelling of the ceiling. */
export const BASH_MAX_TIMEOUT_ENV_VAR = 'NESSY_BASH_MAX_TIMEOUT_MS'

/** The documented Claude spelling, accepted as a compat alias. */
export const BASH_MAX_TIMEOUT_COMPAT_ENV_VAR = 'BASH_MAX_TIMEOUT_MS'

/** The Nessy spelling of the default. */
export const BASH_DEFAULT_TIMEOUT_ENV_VAR = 'NESSY_BASH_DEFAULT_TIMEOUT_MS'

/** The documented Claude spelling, accepted as a compat alias. */
export const BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR = 'BASH_DEFAULT_TIMEOUT_MS'

/** "(default: 600000, or 10 minutes)". */
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000

/** "(default: 120000, or 2 minutes)". */
export const DEFAULT_BASH_DEFAULT_TIMEOUT_MS = 120_000

/**
 * The numeric spellings `env-vars.md#variables` requires, in the page's words:
 * "Numeric variables such as timeouts, token budgets, and retry counts accept
 * scientific notation and digit-separator spellings in addition to plain digits
 * … Claude Code reads `2e3` as 2000 and `64_000` as 64000."
 *
 * So this is deliberately LOOSER than the `/^\d+$/` readers in
 * `config/subagent-spawn-depth.ts` and `config/print-background-wait.ts` — that
 * one's row says "plain digits" in so many words, and these two rows do not.
 * It is still stricter than bare `Number()`, which reads `0x3` and an empty
 * string. Underscores are accepted only BETWEEN digits, so `_1`, `1_` and
 * `1__0` are malformed rather than silently 1, 1 and 10.
 *
 * A malformed or non-positive value falls back to the documented default rather
 * than to "no bound": the page's own warning is that a mis-parse "could silently
 * set a much smaller value, such as `1e6` setting a timeout to 1", and the
 * symmetric failure — a typo buying an unbounded deadline — is the one this
 * whole change exists to close.
 */
function readNumericMsEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+(_\d+)*(\.\d+(_\d+)*)?([eE][+-]?\d+)?$/.test(trimmed)) return undefined
  const value = Number(trimmed.replace(/_/g, ''))
  if (!Number.isFinite(value) || value < 1) return undefined
  return Math.round(value)
}

function readAliasedMsEnv(
  env: BashTimeoutEnvRecord,
  nessyName: string,
  compatName: string,
): number | undefined {
  // The Nessy name wins when both are set — the `resolveMaxSubagentSpawnDepth`
  // and `resolvePrintBackgroundWaitCeilingMs` precedent for an aliased pair.
  return env[nessyName] !== undefined
    ? readNumericMsEnv(env[nessyName])
    : readNumericMsEnv(env[compatName])
}

/** The Bash deadline applied when the model sends no `timeout` of its own. */
export function resolveBashDefaultTimeoutMs(env: BashTimeoutEnvRecord = process.env): number {
  return readAliasedMsEnv(env, BASH_DEFAULT_TIMEOUT_ENV_VAR, BASH_DEFAULT_TIMEOUT_COMPAT_ENV_VAR)
    ?? DEFAULT_BASH_DEFAULT_TIMEOUT_MS
}

/**
 * "The effective ceiling is the larger of this and `BASH_DEFAULT_TIMEOUT_MS`" —
 * so an operator who lowers only the maximum below the default gets the default,
 * and a command can never be born already over the limit.
 */
export function resolveBashTimeoutCeilingMs(env: BashTimeoutEnvRecord = process.env): number {
  const maximum = readAliasedMsEnv(env, BASH_MAX_TIMEOUT_ENV_VAR, BASH_MAX_TIMEOUT_COMPAT_ENV_VAR)
    ?? DEFAULT_BASH_MAX_TIMEOUT_MS
  return Math.max(maximum, resolveBashDefaultTimeoutMs(env))
}

/** What an operator explicitly declared, for a surface that must say so. */
export interface DeclaredBashTimeoutCeiling {
  /** Which of the two spellings won the alias precedence. */
  envVar: string
  /** The operator's own text, trimmed — quoted back rather than re-rendered. */
  raw: string
  /** The ceiling actually in force, `resolveBashTimeoutCeilingMs`'s number. */
  ceilingMs: number
}

/**
 * P6.146's hand-off, applied: the "did the operator set one" question beside its
 * resolver, mirroring `config/subagent-limits.ts`'s
 * `declaredMaxConcurrentSubagents`.
 *
 * `codex-agent.ts`'s honest-surface diagnostic spelled the alias precedence and
 * the present-but-blank rule a SECOND time, because that file's lane did not
 * hold this one; its own docblock recorded that "a
 * `declaredBashTimeoutCeilingMs` beside its resolver is strictly better". Two
 * copies of a precedence is how one of them ages: a change to
 * {@link readAliasedMsEnv} would have moved the value the ceiling clamps to
 * while leaving the sentence that reports it reading the pair the old way round.
 *
 * PRESENCE, not parseability, and that is deliberate rather than sloppy. A
 * malformed explicit value still means the operator set the knob, and on codex
 * it is still not honoured — so the surface must still say so, quoting what they
 * wrote and naming the ceiling that is actually in force. Reporting nothing
 * would answer a question they did not ask. Present-but-blank is an accident and
 * counts as unset, the rule every explicit-only reader in this family follows.
 */
export function declaredBashTimeoutCeiling(
  env: BashTimeoutEnvRecord = process.env,
): DeclaredBashTimeoutCeiling | undefined {
  const envVar = env[BASH_MAX_TIMEOUT_ENV_VAR] !== undefined
    ? BASH_MAX_TIMEOUT_ENV_VAR
    : BASH_MAX_TIMEOUT_COMPAT_ENV_VAR
  const raw = env[envVar]?.trim() ?? ''
  if (raw === '') return undefined
  return { envVar, raw, ceilingMs: resolveBashTimeoutCeilingMs(env) }
}

/**
 * Bound a child-requested foreground deadline by the operator ceiling.
 *
 * Only ever LOWERS: a request under the ceiling is returned byte-identical, so a
 * caller cannot use this to widen anything. See the block comment above for why
 * `background` is exempt and why `persistent` needs no branch.
 */
export function clampSupervisedChildTimeoutMs<T extends { timeoutMs: number; background: boolean }>(
  fields: T,
  env: BashTimeoutEnvRecord = process.env,
): T {
  if (fields.background) return fields
  const ceiling = resolveBashTimeoutCeilingMs(env)
  if (fields.timeoutMs <= ceiling) return fields
  return { ...fields, timeoutMs: ceiling }
}

export interface SupervisedProcessResult {
  handle: string
  /** Foreground-only bounded stdout capture. `output` remains the legacy combined log. */
  stdout?: string
  /** Foreground-only bounded stderr capture. */
  stderr?: string
  output: string
  /** Absolute path of the log file this process writes to (the R10 output-file handle). */
  outputFile?: string
  /** Present (true) once timeout expiry transitioned this process to a background task. */
  movedToBackground?: boolean
  nextCursor: number
  isRunning: boolean
  exitCode: number | null
  signal: string | null
  isolationProfile: string
  /** Present ONLY when the process ran outside isolation by policy. */
  isolationDowngrade?: IsolationDowngradeV1
  environmentProfile: ProcessEnvironmentProfile
  environmentDigest: string
}

/**
 * The semantic id every `Monitor` command watch is started under — the tool's
 * own watches and the plugin `monitors` arming path alike.
 *
 * It became load-bearing when the host teardown started SPARING those records
 * (`keepSemanticIds` below), so it is a named constant rather than a literal at
 * the one place that spares them. The place that STAMPS it is still a literal —
 * `SessionMonitorService.startCommand` passes `semanticId: 'monitor'` — so if
 * that string ever changes, this constant is the thing to change with it, and
 * the exemption is what goes quiet if it is not.
 */
export const MONITOR_SEMANTIC_ID = 'monitor'

/** How much of a session a drain is allowed to take. */
export interface SupervisedProcessDrainOptions {
  /**
   * Semantic ids this drain must LEAVE RUNNING.
   *
   * A kept record is exempt from BOTH halves of the drain: it is not stopped,
   * and it is not counted as a residual. The second half is not a nicety — the
   * drain re-lists after stopping and throws `ProcessSessionDrainError` for
   * anything still `running` or `lost`, so a record deliberately left alive
   * would otherwise turn every exempted teardown into a hard failure.
   *
   * The one producer today is `SessionManager`'s runtime-refresh teardown,
   * which keeps {@link MONITOR_SEMANTIC_ID} so a watch a user set up outlives a
   * `restart-required runtime change`, a `runtime config refresh` and (P2.166) a
   * plugin runtime refresh — the three teardowns that replace the runtime and
   * keep the session. A real session teardown passes nothing and still takes
   * everything.
   *
   * P2.166 also measured the boundary of that list, so the next producer meets
   * it as a decision rather than as an omission: the `auth retry` teardown has
   * the same shape but routes Pi through `strictDrainPiSession`, whose OWN
   * residual scan (`pi-session-process-residual`) knows nothing about this
   * option — so passing it there without teaching that scan would turn a spared
   * watch into the drain's own hard failure, and passing it only on the non-Pi
   * arm would re-create the per-runtime divergence P2.23 removed.
   */
  readonly keepSemanticIds?: readonly string[]
}

export interface ProcessSupervisorPort {
  start(request: SupervisedProcessStartRequest): Promise<SupervisedProcessResult>
  write(request: { sessionKey: SessionKey; handle: string; data: string }): Promise<void>
  read(request: { sessionKey: SessionKey; handle: string; cursor?: number }): Promise<SupervisedProcessResult>
  stop(request: { sessionKey: SessionKey; handle: string }): Promise<void>
  drainSession(sessionKey: SessionKey, options?: SupervisedProcessDrainOptions): Promise<readonly string[]>
}

/**
 * UA12.205 — the shape of a handle the supervisor mints (`process_` + 32 hex), named here, beside the port, so a
 * reader on either side of the wire asks the same question. `ProcessStore` (server-core) validates every handle
 * against THIS pattern and exports it as `isPiProcessHandle`; the renderer's View Output gate reads it to tell a
 * shell the host can read while it RUNS (the supervisor's store) from one minted by a runtime that gives the host no
 * live read — a Claude SDK task id or a codex app-server terminal id (`canViewTaskOutput`). A shape test, as the
 * store's own: a handle that is not the supervisor's is not necessarily any particular runtime's.
 */
export const SUPERVISED_PROCESS_HANDLE = /^process_[0-9a-f]{32}$/

/** UA12.205 — whether `handle` has the supervisor's shape ({@link SUPERVISED_PROCESS_HANDLE}). */
export function isSupervisedProcessHandle(handle: string): boolean {
  return SUPERVISED_PROCESS_HANDLE.test(handle)
}
