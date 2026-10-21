import { mkdir, realpath, readFile } from 'node:fs/promises'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import type { IsolationDowngradeV1, ProcessEnvironmentProfile, ProcessSupervisorPort, SupervisedProcessDrainOptions, SupervisedProcessResult, SupervisedProcessStartRequest } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import {
  EXCLUDED_BY_POLICY_PROFILE,
  SANDBOX_DISABLED_BY_CONFIG_PROFILE,
  SANDBOX_DISABLED_BY_DECISION_PROFILE,
} from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { matchExcludedCommand } from '@nessy-agent/shared/config'
import type { WindowsSandboxRuntimeBinding } from '@nessy-agent/shared/agent/backend'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PiHarnessProcessSnapshotV1 } from '@nessy-agent/core/types'
import { denyRootPair, isPathContained, resolveProcessIsolation, type ProcessIsolationInput, type ProcessIsolationPlan } from './isolation.ts'
import {
  ProcessStore,
  describeMemoryPressureKill,
  describeOutputCeilingKill,
  resolveMemoryPressureThresholdPercent,
  resolveProcessOutputCeilingBytes,
  type StoredProcess,
} from './process-store.ts'
import { freemem, totalmem } from 'node:os'

export class ProcessSessionDrainError extends Error {
  constructor(readonly failedHandles: readonly string[]) {
    super('process-session-drain-failed')
    this.name = 'ProcessSessionDrainError'
  }
}

/**
 * P6.346(c) — the page's three reap guards, as inputs rather than as prose.
 *
 * The row asks for them *"verbatim — idle 30 minutes, no turn running, no
 * subagent running"*, and two of the three are facts about a SESSION, which this
 * class does not hold. They are therefore parameters: the host answers them, and
 * {@link resolveBackgroundShellReaping} is total and pure over the answer, so
 * the policy is assertable with no session store, no timer and no subprocess.
 *
 * Verified at HEAD before writing this: the host already enforces a strictly
 * STRONGER version of the same three for the live-agent reaper —
 * `DEFAULT_IDLE_AGENT_TTL_MS` is `30 * 60_000` and `liveAgentBusyDomains`
 * publishes NINE busy domains, among them `foreground_turn` / `backend_turn`
 * (no turn running), `child` / `background_task` (no subagent running) and
 * `background_shell` itself. So the guards are not invented here; this shape is
 * the same rule applied one level down, to the shell rather than to the agent.
 */
export interface BackgroundShellReapGuardsV1 {
  /** When this session last started or finished a turn. */
  readonly lastActiveAt: number
  /** A turn is running — foreground or backend. */
  readonly turnRunning: boolean
  /** A subagent or background task is running. */
  readonly subagentRunning: boolean
}

/** The idle window the live-agent reaper already uses, applied to a shell. */
export const DEFAULT_BACKGROUND_SHELL_IDLE_MS = 30 * 60_000

/**
 * May this process be reaped under memory pressure right now?
 *
 * Pure and total. Every guard is checked EXPLICITLY and every unknown reads as
 * "do not reap": an absent guard set, a non-finite clock, a `lastActiveAt` in
 * the future (a clock step, a restored header) and a threshold outside `(0,100)`
 * all return `false`. The failure direction of the other reading is destroyed
 * work, and this reaper acts under no user request at all.
 */
export function resolveBackgroundShellReaping(input: {
  guards: BackgroundShellReapGuardsV1 | undefined
  now: number
  idleAfterMs?: number
  freeBytes: number
  totalBytes: number
  thresholdPercent: number
}): { reap: boolean; freeRatioPercent: number } {
  const { freeBytes, totalBytes } = input
  const freeRatioPercent = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 100
  if (!(input.thresholdPercent > 0) || input.thresholdPercent >= 100) return { reap: false, freeRatioPercent }
  if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return { reap: false, freeRatioPercent }
  }
  if (freeRatioPercent >= input.thresholdPercent) return { reap: false, freeRatioPercent }
  const guards = input.guards
  if (guards === undefined) return { reap: false, freeRatioPercent }
  if (guards.turnRunning || guards.subagentRunning) return { reap: false, freeRatioPercent }
  const idleAfterMs = input.idleAfterMs ?? DEFAULT_BACKGROUND_SHELL_IDLE_MS
  if (!Number.isFinite(guards.lastActiveAt)) return { reap: false, freeRatioPercent }
  return { reap: input.now - guards.lastActiveAt >= idleAfterMs, freeRatioPercent }
}

/**
 * P6.825 — one machine reading, shared by both reaper edges.
 *
 * `freemem()` describes the HOST, not a process, so the sample is taken once per
 * window and handed to every live handle. Carrying the threshold alongside keeps
 * the two edges from resolving it twice and disagreeing.
 */
interface MemoryPressureReading {
  readonly now: number
  readonly freeBytes: number
  readonly totalBytes: number
  readonly thresholdPercent: number
}

export class ProcessSupervisor implements ProcessSupervisorPort {
  static readonly MAX_STDIN_WRITE_BYTES = 64 * 1024
  static readonly MAX_STDIN_WRITE_BYTES_LIMIT = 16 * 1024 * 1024 + 1
  static readonly MAX_STDIN_DATA_BYTES = 1024 * 1024
  /**
   * P6.346(b) — how often the memory sampler may call `freemem()`.
   *
   * Five seconds, and the number is a cost bound rather than a policy: the
   * sampler sits on the per-chunk append path of every supervised process, and
   * the reaper's own decision is an idle-30-minutes one, so sampling faster buys
   * nothing a slower sample would miss.
   */
  static readonly MEMORY_PRESSURE_SAMPLE_MS = 5_000
  /**
   * P2.393 — WHAT THIS CAP PROTECTS, MEASURED RATHER THAN ASSUMED.
   *
   * It bounds {@link SupervisedProcessResult.stdout} and `.stderr`, the
   * FOREGROUND-only captures {@link appendBoundedStream} accumulates while a
   * non-background process runs. It is a host-survival cap on this process's own
   * memory; it is **not** an implementation of any published number, and
   * `tools-reference.md#output-limits` states its Bash figures in CHARACTERS
   * while this counts BYTES.
   *
   * **Measured at `7a8477690`: no production consumer reads either field.** The
   * one chain that reaches a foreground result — `pi-agent.ts`'s
   * `handleProcessStartRequest` replies `{ result }`, `pi-agent-server`'s
   * `requestSupervisedProcess` resolves it, and its `runCommand` builds the
   * model's Bash result — reads `supervised.output`, and so do every other
   * caller in the tree (`edit-feedback`, `formatter-registry`, the
   * `SessionManager` process handlers). `stdout`/`stderr` are computed, shipped
   * over the subprocess wire and dropped. Positive control for the absence, on
   * the same grep: `pi-agent-server/src/index.ts` shows `stdout:
   * supervised.output`, i.e. the instrument does find a real reader of the
   * result object.
   *
   * **`output` — the field everyone does read — IS bounded, and the sentence
   * that stood here saying otherwise was WRONG (retracted by its author,
   * P3.320, 2026-09-03).** It read: *"`ProcessStore.readLog` returns the whole
   * log file from the cursor with no byte limit … the page's two host-survival
   * numbers have no implementation on this path."* Measured on a driven rig:
   * 205 000 bytes appended in 200 chunks, **exactly 65 536 bytes read back**,
   * beginning at chunk 136. `ProcessStore` keeps a RING at `MAX_LOG_BYTES` —
   * dropping the head and advancing `baseCursor` — so `readLog`'s `readFile`
   * never sees more than the window, and the 5 GB `readFile` that claim feared
   * cannot happen.
   *
   * The absence was asserted from reading the append path's callers instead of
   * driving the store: the false-absence shape this repo keeps paying for,
   * this time inside a docblock written to correct another docblock.
   *
   * The real defect on that path was the opposite one — the ring dropped the
   * HEAD in silence, so a model could not tell truncation from completion — and
   * P3.320 closed it with a notice. What remains genuinely absent is the page's
   * **5 GB kill**, which is a kill at the streaming layer rather than a cap,
   * and therefore a product posture rather than a constant.
   *
   * The two claims that a check's output is "already capped by the supervisor"
   * (`edit-feedback.ts`, `formatter-registry.ts`) are right that a cap exists
   * and wrong about WHERE: it is `ProcessStore`'s ring, not this constant.
   * Both now say so.
   */
  static readonly MAX_FOREGROUND_STREAM_BYTES = 64 * 1024
  private readonly children = new Map<string, ChildProcess>()
  private readonly completions = new Map<string, Promise<void>>()
  private readonly requestedTerminal = new Map<string, 'stopped' | 'timed-out' | 'lost'>()
  private readonly stdinWrites = new Map<string, Promise<void>>()
  private readonly stdinWriteLimits = new Map<string, number>()
  /**
   * Handles this class has already killed for a ceiling. One kill, one notice:
   * the append path is per chunk, so without this a process producing a burst
   * past the limit would write the sentence once per chunk still in flight.
   */
  private readonly ceilingKilled = new Set<string>()
  /** The session a live handle belongs to, so a ceiling kill can name it. */
  private readonly handleSessions = new Map<string, SessionKey>()
  /**
   * F1.1207 — handles whose `start()` holds an admission between
   * `ProcessStore.create` and the spawn. A `stop()` that landed in that window
   * fell through to `stopRecovered`, which marked the never-started record
   * `lost`, threw, and let `start()` spawn the child anyway — alive, owned by
   * nobody, and unreachable by a second stop (which returns on a non-`running`
   * record without signalling anything).
   */
  private readonly admitting = new Set<string>()
  /**
   * F1.1207 — the request a `stop()` left for an admitting start: consumed at
   * the admission boundary, which then refuses the spawn exactly as it refuses
   * an aborted signal.
   */
  private readonly preSpawnStops = new Set<string>()
  private lastMemorySampleAt = 0
  /**
   * P6.825 — the sweep timer, the reaper's second edge.
   *
   * Armed while at least one supervised process is live AND the threshold is
   * non-zero; cleared the moment the last one exits, so an install that never
   * turns the reaper on and a host with nothing running both hold no timer.
   * `unref()` because a five-second heartbeat must never be the reason a
   * process (or a test runner) stays alive.
   */
  private memorySweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly options: {
    store: ProcessStore
    resolveIsolation?: (input: ProcessIsolationInput) => ProcessIsolationPlan
    platform?: NodeJS.Platform
    windowsSandboxRuntime?: WindowsSandboxRuntimeBinding
    deniedReadRoots?: readonly string[]
    /**
     * Host-resolved `sandbox.filesystem.allowRead`, applied to EVERY supervised
     * process.
     *
     * `sandboxing.md:176` — "re-allow specific paths within a denied region
     * using `sandbox.filesystem.allowRead`". Empty or unset leaves the
     * ambient-read posture exactly as it was, which is every install that never
     * wrote the key; non-empty is enforceable on darwin only and
     * `resolveProcessIsolation` refuses the spawn on the other two rather than
     * dropping it.
     */
    allowedReadRoots?: readonly string[]
    /**
     * Host-resolved readable-but-unwritable roots (`sandbox.denyWrite` and
     * `Edit(...)` deny rules — `settings-reference.md#sandbox-filesystem-denywrite`
     * merges "the paths from your `Edit(...)` deny permission rules" into the same
     * list). Kept apart from
     * {@link deniedReadRoots} because an edit deny must not also blind reads.
     */
    deniedWriteRoots?: readonly string[]
    /**
     * Host-resolved writable grants, applied to EVERY supervised process.
     *
     * `sandboxing.md:149` — "If subprocess commands like `kubectl`,
     * `terraform`, or `npm` need to write outside those directories, use
     * `sandbox.filesystem.allowWrite` to grant access to specific paths", and
     * `:162` — "These paths are enforced at the OS level, so all commands
     * running inside the sandbox, including their child processes, respect
     * them." A host-level grant that only reached the callers who happened to
     * pass a per-request root was a setting that appeared to widen the sandbox
     * and did nothing. Merged with, never replaced by, the per-request roots.
     */
    additionalWritableRoots?: readonly string[]
    /**
     * T1 (2026-08-12) master switch: resolved `sandbox.enabled`. `false`
     * skips isolation resolution UNCONDITIONALLY for every supervised
     * process — no egress exception, no interaction with
     * `dangerouslyDisableSandbox` or `excludedCommands` (checked first in
     * `resolveIsolationDowngrade`, ahead of both).
     *
     * Option ABSENT (not `false`) keeps this supervisor's own default of
     * "isolate" — fail-closed for a direct constructor or a test that never
     * sets it. The actual default-OFF for a fresh install lives in the
     * settings resolver (`SANDBOX_ENABLED_DEFAULT`), not here.
     */
    sandboxEnabled?: boolean
    /**
     * Command glob patterns permitted to run OUTSIDE isolation, resolved from
     * sandbox settings with the managed policy as the floor. Every match is
     * recorded as a downgrade on the result and the persisted record.
     */
    excludedCommands?: readonly string[]
    /**
     * Strict sandbox mode when false: `dangerouslyDisableSandbox` is refused
     * outright rather than prompted or downgraded-and-recorded.
     * `excludedCommands` still applies, which is what makes strict mode usable.
     * Defaults to true, so an unset host behaves exactly as before.
     */
    allowUnsandboxedCommands?: boolean
    /**
     * Host answer to `sandbox.network`, applied to EVERY supervised process.
     *
     * `sandboxing.md:325` — under `allowManagedDomainsOnly` "non-allowed domains
     * are blocked automatically instead of prompting". No backend we have can
     * express the allowlist half (`resolveSandboxNetworkEnforcement` records why
     * and reports each entry it cannot honour), so the lock is applied as a
     * total egress deny. Unset means unchanged: the profile's own network
     * dimension decides, which for the foreground shell is the `networked`
     * owner decision of 2026-07-28.
     */
    denyNetworkEgress?: boolean
    /**
     * Host answer to `sandbox.filesystem.disabled`, applied to EVERY supervised
     * process.
     *
     * Carried rather than acted on here: the supervisor still hands the funnel
     * every root it resolved, and `resolveProcessIsolation` decides which of them
     * survive the key. One decision site, one place to read what the layer being
     * off actually costs.
     */
    filesystemIsolationDisabled?: boolean
    spawnProcess?: typeof spawn
    runWindowsTaskkill?: (args: readonly string[]) => void
    readPidStartMarker?: (pid: number) => Promise<string>
    graceMs?: number
    onChanged?: (sessionKey: SessionKey) => void | Promise<void>
    /**
     * P6.346(b) — the LIFETIME output ceiling, in bytes. Defaults to the number
     * `tools-reference.md#output-limits` publishes for the runtime we vendor
     * (*"a command whose output passes 5 GB is killed"*); `0` disables it. An
     * explicit value wins outright, which is how a test pins the kill at a
     * handful of bytes.
     */
    maxLifetimeOutputBytes?: number
    /**
     * P6.346(b) — free-memory percentage below which a supervised process may be
     * reaped. `0` (the default) is OFF; see the constant's own header for why
     * that posture is stated rather than taken.
     */
    memoryPressurePercent?: number
    /**
     * P6.346(c) — the page's three reap guards, asked of whoever owns the
     * session's state, because this class owns none of it.
     *
     * `undefined` means the guards CANNOT be evaluated, and the reaper then
     * never fires. That is the fail-safe direction and it is deliberate: the
     * alternative default kills a user's running command on a machine that is
     * merely busy, which is the failure this whole row is trying to bound rather
     * than cause.
     */
    sessionQuiescence?: (sessionKey: SessionKey) => BackgroundShellReapGuardsV1 | undefined
    /** Test seam for the memory sampler; production reads `node:os`. */
    readFreeMemory?: () => { freeBytes: number; totalBytes: number }
  }) {}

  async start(
    request: SupervisedProcessStartRequest & { args?: string[] },
    onRegistered?: () => void,
  ): Promise<SupervisedProcessResult> {
    assertProcessStartActive(request.signal)
    if (request.stdinData !== undefined) {
      if (request.stdin !== 'pipe') throw new Error('process-stdin-data-requires-pipe')
      if (Buffer.byteLength(request.stdinData) > ProcessSupervisor.MAX_STDIN_DATA_BYTES) {
        throw new Error('process-stdin-data-too-large')
      }
    }
    const stdinWriteLimit = request.maxStdinWriteBytes ?? ProcessSupervisor.MAX_STDIN_WRITE_BYTES
    if (!Number.isSafeInteger(stdinWriteLimit)
      || stdinWriteLimit < 1
      || stdinWriteLimit > ProcessSupervisor.MAX_STDIN_WRITE_BYTES_LIMIT) {
      throw new Error('process-stdin-write-limit-invalid')
    }
    const workspaceRoot = await realpath(request.workspaceRoot)
    const cwd = await realpath(request.cwd)
    if (!isPathContained(workspaceRoot, cwd)) {
      throw new Error('process-working-directory-outside-workspace')
    }
    const args = request.args ?? []
    await this.options.store.ensureRoot()
    const requestedScratchRoot = join(
      this.options.store.scratchRoot,
      createHash('sha256').update(`${request.sessionKey.workspaceId}\0${request.sessionKey.sessionId}`).digest('hex'),
    )
    await mkdir(requestedScratchRoot, { recursive: true, mode: 0o700 })
    // macOS exposes its temp root through /var -> /private/var. sandbox-exec
    // compares canonical paths, so isolation and TMP* must use the same realpath.
    const scratchRoot = await realpath(requestedScratchRoot)
    const additionalWritableRoots = [...new Set(await Promise.all(
      [...(this.options.additionalWritableRoots ?? []), ...(request.additionalWritableRoots ?? [])].map(async root => {
        if (!isAbsolute(root)) throw new Error('process-additional-writable-root-not-absolute')
        await mkdir(root, { recursive: true })
        const canonical = await realpath(root)
        if (dirname(canonical) === canonical) throw new Error('process-additional-writable-root-too-broad')
        return canonical
      }),
    ))]
    // `denyRootPair` rather than a second copy of the canonicalisation: the same
    // rule stated twice is the defect `credential-deny-roots.ts` exists to avoid,
    // and only one of the two copies would have grown the symlink pair.
    const deniedReadRoots = [...new Set(
      (this.options.deniedReadRoots ?? []).flatMap(root => denyRootPair(root, 'read')),
    )]
    const deniedWriteRoots = [...new Set(
      (this.options.deniedWriteRoots ?? []).flatMap(root => denyRootPair(root, 'write')),
    )]
    const platform = this.options.platform ?? process.platform
    const requiredWindowsEnvironment = platform === 'win32'
      ? Object.fromEntries(
          ['SystemRoot', 'WINDIR']
            .map(name => [name, process.env[name]] as const)
            .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
        )
      : {}
    const environmentProfile = resolveEnvironmentProfile(request)
    const processEnvironment: Record<string, string> = {
      ...hostEnvironment(environmentProfile),
      ...requiredWindowsEnvironment,
      ...request.env,
      TMPDIR: scratchRoot,
      TMP: scratchRoot,
      TEMP: scratchRoot,
    }
    const environmentDigest = digestEnvironment(processEnvironment)
    const downgrade = this.resolveIsolationDowngrade(request, args)
    const plan = downgrade
      ? undefined
      : (this.options.resolveIsolation ?? resolveProcessIsolation)({
          ...(this.options.platform ? { platform: this.options.platform } : {}),
          profile: request.profile,
          command: request.command,
          args,
          workspaceRoot,
          workingDirectory: cwd,
          scratchRoot,
          environment: processEnvironment,
          windowsSandboxStateRoot: join(this.options.store.scratchRoot, 'windows-sandbox'),
          ...(this.options.windowsSandboxRuntime ? { windowsSandboxRuntime: this.options.windowsSandboxRuntime } : {}),
          ...(additionalWritableRoots.length > 0 ? { additionalWritableRoots } : {}),
          ...(deniedReadRoots.length > 0 ? { deniedReadRoots } : {}),
          ...((this.options.allowedReadRoots?.length ?? 0) > 0
            ? { allowedReadRoots: this.options.allowedReadRoots }
            : {}),
          ...(deniedWriteRoots.length > 0 ? { deniedWriteRoots } : {}),
          ...(this.options.denyNetworkEgress === true ? { denyNetworkEgress: true } : {}),
          ...(this.options.filesystemIsolationDisabled === true
            ? { filesystemIsolationDisabled: true }
            : {}),
        })
    // Deliberately its own marker, never `no-host-isolation`: that string is the
    // `tool-executor` fallback for a result with no profile at all, so reusing it
    // would make a sanctioned exclusion indistinguishable from a missing backend.
    const isolationProfile = downgrade
      ? (downgrade.reason === 'excludedCommands'
          ? EXCLUDED_BY_POLICY_PROFILE
          : downgrade.reason === 'sandboxDisabled'
            ? SANDBOX_DISABLED_BY_CONFIG_PROFILE
            : SANDBOX_DISABLED_BY_DECISION_PROFILE)
      : `${plan!.profile}:${plan!.backend}`
    const deadlineAt = request.persistent ? Number.MAX_SAFE_INTEGER : Date.now() + request.timeoutMs
    const record = await this.options.store.create({
      sessionKey: request.sessionKey,
      executionId: request.executionId,
      semanticId: request.semanticId,
      pid: null,
      startedAt: Date.now(),
      deadlineAt,
      status: 'running',
      exitCode: null,
      signal: null,
      pidStartMarker: null,
      profile: request.profile,
      isolationProfile,
      ...(downgrade ? { isolationDowngrade: downgrade } : {}),
      environmentProfile,
      environmentDigest,
      // The REQUESTED command line, before isolation rewrote it into a sandbox
      // invocation — see `StoredProcess.command`.
      command: [request.command, ...args].join(' ').trim(),
      cwd,
    })
    // F1.1207 — the admission latch. Armed before the record's first await, so
    // any stop whose decision block runs after the record exists sees it.
    this.admitting.add(record.handle)
    let child: ChildProcess
    try {
      assertProcessStartActive(request.signal)
      await request.beforeStart?.()
      const latestBeforeSpawn = await this.options.store.get(record.handle)
      // This is the final admission boundary: no await may be inserted between
      // this check and spawn without adding another cancellation check.
      assertProcessStartActive(request.signal)
      const stopBeforeSpawn = this.preSpawnStops.delete(record.handle)
      this.admitting.delete(record.handle)
      if (stopBeforeSpawn || latestBeforeSpawn.status !== 'running') {
        // F1.1207 — a stop consumed this admission, or landed while `create`
        // was still settling and marked the record terminal itself. Never
        // spawn: the child would run with no owner, and a second stop returns
        // on a non-`running` record without signalling it. `stopped` because a
        // stop was requested and nothing ever ran — a `lost` record with a
        // null pid can never be proven gone, so it would wedge a strict drain
        // for ever (the drain's residual half).
        await this.options.store.update(record.handle, { status: 'stopped' }).catch(() => undefined)
        this.notifyChanged(request.sessionKey)
        return this.read({ sessionKey: request.sessionKey, handle: record.handle, cursor: 0 })
      }
      child = (this.options.spawnProcess ?? spawn)(
        plan?.command ?? request.command,
        plan?.args ?? args,
        {
        cwd,
        // Every supervised process gets the same host-owned writable temp root.
        // This preserves ordinary tmp/cache behavior without opening the host's
        // ambient temp directory outside the filesystem isolation profile.
        env: plan?.environment ?? processEnvironment,
        detached: platform !== 'win32',
        stdio: [request.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        },
      )
    } catch (error) {
      this.admitting.delete(record.handle)
      this.preSpawnStops.delete(record.handle)
      const aborted = request.signal?.aborted === true
      await this.options.store.update(record.handle, { status: aborted ? 'stopped' : 'lost' })
        .catch(() => undefined)
      this.notifyChanged(request.sessionKey)
      if (aborted) return this.read({ sessionKey: request.sessionKey, handle: record.handle, cursor: 0 })
      throw error
    }
    const activeChild = child
    let exitObserved = false
    let stdoutCapture: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderrCapture: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    const persistOutput = request.persistOutput !== false
    this.children.set(record.handle, activeChild)
    // P6.346(b) — the owner, so a ceiling kill can stop the process through the
    // ordinary `stopWithTerminal` path rather than only SIGKILLing the tree.
    this.handleSessions.set(record.handle, request.sessionKey)
    // P6.825 — from here the reaper can look without being spoken to.
    this.armMemorySweep()
    this.stdinWriteLimits.set(record.handle, stdinWriteLimit)
    activeChild.stdout?.on('data', chunk => {
      if (!request.background) stdoutCapture = appendBoundedStream(stdoutCapture, chunk)
      try {
        request.onStdout?.(chunk)
      } catch (error) {
        if (persistOutput) this.trackAppend(record.handle, activeChild, error instanceof Error ? error.message : String(error), request.sessionKey)
        this.requestedTerminal.set(record.handle, 'lost')
        this.signalTree(activeChild, 'SIGKILL')
      }
      if (persistOutput) this.trackAppend(record.handle, activeChild, chunk, request.sessionKey)
    })
    activeChild.stderr?.on('data', chunk => {
      if (!request.background) stderrCapture = appendBoundedStream(stderrCapture, chunk)
      if (persistOutput) this.trackAppend(record.handle, activeChild, chunk, request.sessionKey)
    })
    const completion = new Promise<void>(resolve => {
      activeChild.once('exit', () => { exitObserved = true })
      activeChild.once('close', (exitCode, signal) => {
        this.children.delete(record.handle)
        this.handleSessions.delete(record.handle)
        this.ceilingKilled.delete(record.handle)
        // P6.825 — cleared on exit: the last process leaving takes the timer
        // with it, so an idle host holds none.
        this.disarmMemorySweepIfIdle()
        void (async () => {
          try {
            await this.options.store.flush(record.handle)
            const latest = await this.options.store.get(record.handle)
            await this.options.store.update(record.handle, {
              status: latest.status === 'lost' ? 'lost' : (this.requestedTerminal.get(record.handle) ?? 'exited'),
              exitCode,
              signal,
            })
          } catch {
            await this.options.store.update(record.handle, { status: 'lost', exitCode, signal }).catch(() => undefined)
          } finally {
            this.requestedTerminal.delete(record.handle)
            this.stdinWriteLimits.delete(record.handle)
            this.notifyChanged(request.sessionKey)
            try { request.onClose?.(exitCode, signal) } catch {}
            resolve()
          }
        })()
      })
      activeChild.once('error', error => {
        this.requestedTerminal.set(record.handle, 'lost')
        if (persistOutput) this.trackAppend(record.handle, activeChild, error.message, request.sessionKey)
      })
    })
    this.completions.set(record.handle, completion)
    completion.finally(() => this.completions.delete(record.handle))
    if (request.stdinData !== undefined && activeChild.stdin) {
      activeChild.stdin.on('error', () => undefined)
      activeChild.stdin.end(request.stdinData)
    }
    let terminalRequest: Promise<void> | undefined
    let movedToBackground = false
    let resolveBackgroundTransition!: () => void
    const backgroundTransition = new Promise<void>(resolve => { resolveBackgroundTransition = resolve })
    const requestStop = () => terminalRequest ??= this.stopWithTerminal(request.sessionKey, record.handle, 'stopped')
    // R10: a foreground request that opted in with `onTimeout: 'background'`
    // transitions to a background task on expiry INSTEAD of the SIGTERM path.
    // The one-shot `terminalRequest` latch is shared with stop/abort, so a stop
    // that won the race still kills and a transition that won keeps running.
    const requestTimeout = () => terminalRequest ??= (
      request.onTimeout === 'background' && !request.persistent && !request.background
        ? this.moveToBackground(request.sessionKey, record.handle).then(moved => {
            if (!moved) return
            movedToBackground = true
            resolveBackgroundTransition()
          })
        : this.stopWithTerminal(request.sessionKey, record.handle, 'timed-out')
    )
    const timer = request.persistent
      ? undefined
      : setTimeout(() => { void requestTimeout() }, Math.max(0, record.deadlineAt - Date.now()))
    timer?.unref()
    if (timer) completion.finally(() => clearTimeout(timer))
    const abort = () => { void requestStop() }
    if (request.signal) {
      request.signal.addEventListener('abort', abort, { once: true })
      completion.finally(() => request.signal?.removeEventListener('abort', abort))
      if (request.signal.aborted) abort()
    }
    onRegistered?.()
    this.notifyChanged(request.sessionKey)
    try {
      if (!activeChild.pid) throw new Error('process-start-missing-pid')
      await this.options.store.update(record.handle, { pid: activeChild.pid })
      const markerReader = this.pidStartMarkerReader()
      if (markerReader) {
        const marker = await Promise.race([
          markerReader(activeChild.pid)
            .then(pidStartMarker => ({ kind: 'marker' as const, pidStartMarker })),
          completion.then(() => ({ kind: 'completed' as const })),
        ])
        if (marker.kind === 'marker') {
          const latest = await this.options.store.get(record.handle)
          if (latest.status === 'running') {
            await this.options.store.update(record.handle, { pidStartMarker: marker.pidStartMarker })
          }
        }
      }
    } catch (error) {
      if (!exitObserved && activeChild.exitCode === null && activeChild.signalCode === null) {
        await Promise.race([completion, new Promise(resolve => setImmediate(resolve))])
      }
      if (exitObserved || activeChild.exitCode !== null || activeChild.signalCode !== null || !this.children.has(record.handle)) {
        await completion
      } else {
        this.requestedTerminal.set(record.handle, 'lost')
        this.signalTree(activeChild, 'SIGKILL')
        await completion
        throw error
      }
    }
    if (request.signal?.aborted) await requestStop()
    else if (!request.persistent && Date.now() >= record.deadlineAt) await requestTimeout()
    else if (terminalRequest) await terminalRequest
    // A background transition resolves the foreground await while the process
    // keeps running and keeps appending to its log (R10).
    if (!request.background) await Promise.race([completion, backgroundTransition])
    const result = await this.read({ sessionKey: request.sessionKey, handle: record.handle, cursor: 0 })
    return request.background
      ? result
      : {
          ...result,
          ...(movedToBackground ? { movedToBackground: true } : {}),
          stdout: stdoutCapture.toString('utf8'),
          stderr: stderrCapture.toString('utf8'),
        }
  }

  /**
   * R10 timeout transition: lift the deadline and mark the record as a
   * background task, leaving the process untouched. Returns false when the
   * process already reached (or is reaching) a terminal state, in which case
   * the ordinary completion path reports the outcome.
   */
  private async moveToBackground(sessionKey: SessionKey, handle: string): Promise<boolean> {
    const record = await this.options.store.assertOwner(sessionKey, handle)
    if (record.status !== 'running' || !this.children.has(handle)) return false
    await this.options.store.update(handle, {
      deadlineAt: Number.MAX_SAFE_INTEGER,
      movedToBackgroundAt: Date.now(),
    })
    this.notifyChanged(sessionKey)
    return true
  }

  async read(request: { sessionKey: SessionKey; handle: string; cursor?: number }): Promise<SupervisedProcessResult> {
    let record = await this.options.store.assertOwner(request.sessionKey, request.handle)
    if (record.status === 'running' && !this.children.has(request.handle)) {
      const completion = this.completions.get(request.handle)
      if (completion) {
        await completion
        record = await this.options.store.assertOwner(request.sessionKey, request.handle)
      } else {
        const markerReader = this.pidStartMarkerReader()
        const marker = record.pid && markerReader ? await markerReader(record.pid).catch(() => null) : null
        if (!marker || marker !== record.pidStartMarker) {
          record = await this.options.store.update(request.handle, { status: 'lost' })
          throw new Error('process-recovery-identity-mismatch')
        }
        throw new Error('process-recovery-host-owner-unavailable')
      }
    }
    const log = await this.options.store.readLog(request.handle, request.cursor ?? 0)
    return {
      handle: record.handle,
      output: log.output,
      outputFile: this.options.store.outputFilePath(record.handle),
      ...(record.movedToBackgroundAt !== undefined ? { movedToBackground: true } : {}),
      nextCursor: log.nextCursor,
      isRunning: record.status === 'running',
      exitCode: record.exitCode,
      signal: record.signal,
      isolationProfile: record.isolationProfile,
      ...(record.isolationDowngrade ? { isolationDowngrade: record.isolationDowngrade } : {}),
      environmentProfile: record.environmentProfile,
      environmentDigest: record.environmentDigest,
    }
  }

  /**
   * Decide whether this ONE process runs outside isolation, and why.
   *
   * `undefined` means it runs isolated, which stays the default for every
   * command that matches nothing — the fail-closed posture is unchanged.
   *
   * Order matters: the T1 `sandbox.enabled` master switch is checked FIRST
   * and UNCONDITIONALLY — «вообще выключены» — with no egress exception and
   * no interaction with either branch below. Strict sandbox mode is checked
   * next, so `dangerouslyDisableSandbox` is refused outright rather than
   * prompted or downgraded-and-recorded. `excludedCommands` is checked after
   * and is deliberately NOT subject to strict mode, which is what keeps
   * strict mode usable for sandbox-incompatible tooling.
   */
  private resolveIsolationDowngrade(
    request: SupervisedProcessStartRequest,
    args: readonly string[],
  ): IsolationDowngradeV1 | undefined {
    if (this.options.sandboxEnabled === false) {
      return { reason: 'sandboxDisabled' }
    }
    if (request.dangerouslyDisableSandbox) {
      if (this.options.allowUnsandboxedCommands === false) {
        throw new Error('process-isolation-unsandboxed-commands-disallowed')
      }
      if (!request.isolationDowngradeDecision) {
        throw new Error('process-isolation-downgrade-decision-required')
      }
      return { reason: 'dangerouslyDisableSandbox', decisionId: request.isolationDowngradeDecision }
    }
    const excluded = this.options.excludedCommands
    if (!excluded?.length) return undefined
    // Matched against the WHOLE requested command line, so `docker *` matches
    // both a shell string (`docker ps`, no args) and an argv split.
    const pattern = matchExcludedCommand([request.command, ...args].join(' ').trim(), excluded)
    return pattern === undefined ? undefined : { reason: 'excludedCommands', pattern }
  }

  async write(request: { sessionKey: SessionKey; handle: string; data: string }): Promise<void> {
    await this.options.store.assertOwner(request.sessionKey, request.handle)
    if (Buffer.byteLength(request.data) > (this.stdinWriteLimits.get(request.handle) ?? ProcessSupervisor.MAX_STDIN_WRITE_BYTES)) {
      throw new Error('process-stdin-write-too-large')
    }
    const previous = this.stdinWrites.get(request.handle) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      const child = this.children.get(request.handle)
      const stdin = child?.stdin
      if (!child || !stdin || stdin.destroyed || !stdin.writable) {
        throw new Error('process-stdin-unavailable')
      }
      await new Promise<void>((resolve, reject) => {
        stdin.write(request.data, error => error ? reject(error) : resolve())
      })
    })
    this.stdinWrites.set(request.handle, current)
    try {
      await current
    } catch (error) {
      throw new Error('process-stdin-unavailable', { cause: error })
    } finally {
      if (this.stdinWrites.get(request.handle) === current) this.stdinWrites.delete(request.handle)
    }
  }

  async waitAndRead(sessionKey: SessionKey, handle: string): Promise<SupervisedProcessResult> {
    await this.options.store.assertOwner(sessionKey, handle)
    await this.completions.get(handle)
    return this.read({ sessionKey, handle, cursor: 0 })
  }

  async stop(request: { sessionKey: SessionKey; handle: string }): Promise<void> {
    const record = await this.options.store.assertOwner(request.sessionKey, request.handle)
    if (record.status !== 'running') return
    const child = this.children.get(request.handle)
    if (!child || !child.pid) {
      const completion = this.completions.get(request.handle)
      if (completion) {
        await completion
        return
      }
      // F1.1207 — a `start()` is between `create` and the spawn: leave the
      // admission request for it instead of going down `stopRecovered`, which
      // would mark the never-started record `lost` and throw while `start()`
      // spawned the child anyway. The start re-checks at its admission
      // boundary, refuses the spawn, and settles the record `stopped`.
      if (this.admitting.has(request.handle)) {
        this.preSpawnStops.add(request.handle)
        await this.options.store.update(request.handle, { status: 'stopped' })
        this.notifyChanged(request.sessionKey)
        return
      }
      // `record` was read ACROSS an await, and the close handler writes the
      // record's terminal status BEFORE it resolves — and so before
      // `completion.finally` deregisters — that completion. So "no child and no
      // completion" is not only the recovered-from-a-previous-process case
      // `stopRecovered` exists for: it is also what a child that exited DURING
      // that await looks like. Re-read before treating it as a recovery,
      // because `stopRecovered` with no live marker for a pid that has gone
      // overwrites a clean `exited` with `lost` and throws
      // `process-recovery-identity-mismatch` at the caller — a stop landing in
      // the few milliseconds around a background child's normal exit.
      //
      // A genuinely recovered record still says `running` on disk (nothing in
      // this process ever finalised it), so this narrows nothing that path
      // needs. Measured at the 1.38.0 close-out on
      // `process-supervisor.test.ts`'s close-finalization case, run ALONE:
      // before this hunk 16 pass / 9 fail over 25 runs (WA-r; 6 of the 9 were
      // this `process-recovery-identity-mismatch`), after it 11 pass / 1 fail
      // over 12 runs at load ~7 (controller) — the one red was the case's OLD
      // `exited`/`stopped` poll symptom on a cold first run, not this throw.
      // The whole file then ran 46 pass / 0 fail in 25 s. Narrowed, not
      // closed: the register keeps the entry for the poll half.
      const latest = await this.options.store.get(request.handle)
      if (latest.status !== 'running') return
      await this.stopRecovered(request.sessionKey, latest)
      return
    }
    if (!this.requestedTerminal.has(request.handle)) this.requestedTerminal.set(request.handle, 'stopped')
    const isWindows = (this.options.platform ?? process.platform) === 'win32'
    const gracefulTerminationStarted = this.signalTree(child, 'SIGTERM')
    if (isWindows && !gracefulTerminationStarted && !this.signalTree(child, 'SIGKILL')) {
      this.requestedTerminal.delete(request.handle)
      throw new Error('process-tree-termination-failed')
    }
    const completion = this.completions.get(request.handle)
    if (completion) await Promise.race([completion, new Promise(resolve => setTimeout(resolve, this.options.graceMs ?? 500))])
    if (this.children.has(request.handle) && !this.signalTree(child, 'SIGKILL') && isWindows) {
      this.requestedTerminal.delete(request.handle)
      throw new Error('process-tree-termination-failed')
    }
    await this.completions.get(request.handle)
  }

  private async stopRecovered(sessionKey: SessionKey, record: StoredProcess): Promise<void> {
    const markerReader = this.pidStartMarkerReader()
    if (!record.pid || !record.pidStartMarker || !markerReader) {
      await this.options.store.update(record.handle, { status: 'lost' })
      this.notifyChanged(sessionKey)
      throw new Error('process-recovery-identity-mismatch')
    }
    const currentMarker = await markerReader(record.pid).catch(() => null)
    if (currentMarker !== record.pidStartMarker) {
      await this.options.store.update(record.handle, { status: 'lost' })
      this.notifyChanged(sessionKey)
      throw new Error('process-recovery-identity-mismatch')
    }

    const graceful = this.signalRecoveredTree(record.pid, 'SIGTERM')
    if (!graceful && (this.options.platform ?? process.platform) === 'win32'
      && !this.signalRecoveredTree(record.pid, 'SIGKILL')) {
      throw new Error('process-tree-termination-failed')
    }
    let stopped = await this.waitForRecoveredExit(record.pid, record.pidStartMarker)
    let signal: NodeJS.Signals = 'SIGTERM'
    if (!stopped) {
      signal = 'SIGKILL'
      if (!this.signalRecoveredTree(record.pid, signal)) {
        throw new Error('process-tree-termination-failed')
      }
      stopped = await this.waitForRecoveredExit(record.pid, record.pidStartMarker)
    }
    if (!stopped) throw new Error('process-tree-termination-failed')
    await this.options.store.update(record.handle, { status: 'stopped', signal })
    this.notifyChanged(sessionKey)
  }

  private signalRecoveredTree(pid: number, signal: NodeJS.Signals): boolean {
    if ((this.options.platform ?? process.platform) === 'win32') {
      try {
        ;(this.options.runWindowsTaskkill ?? runWindowsTaskkill)([
          '/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : []),
        ])
        return true
      } catch {
        return false
      }
    }
    try {
      process.kill(-pid, signal)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  }

  private async waitForRecoveredExit(pid: number, expectedMarker: string): Promise<boolean> {
    const markerReader = this.pidStartMarkerReader()
    if (!markerReader) return false
    const deadline = Date.now() + (this.options.graceMs ?? 500)
    do {
      const marker = await markerReader(pid).catch(() => null)
      if (marker === null || marker !== expectedMarker) return true
      await new Promise(resolve => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    return false
  }

  /**
   * Stop every process this session owns, except the ones the caller asks to
   * KEEP.
   *
   * `keepSemanticIds` is honoured in BOTH halves and has to be. The first half
   * is the obvious one: a kept record is never signalled. The second is the one
   * that would bite — this method re-lists after stopping and throws
   * `ProcessSessionDrainError` for anything still `running` or `lost`, so a
   * record deliberately left alive would report itself as the drain's own
   * failure and (under a strict teardown) fail the operation that spared it.
   * The `lost` arm is exempted with the `running` one on purpose: we did not
   * stop a kept record, so its unconfirmed state is not this drain's residual
   * either.
   *
   * UA12.153 — a `lost` (or unowned `running`) record is only a residual when it
   * is NOT proven gone: the residual half retires a record whose pid start-marker
   * no longer matches, exactly as `countActive` does (D1.345), so a session whose
   * records were stranded `lost` by an app quit still drains — and still DELETES.
   */
  async drainSession(
    sessionKey: SessionKey,
    options: SupervisedProcessDrainOptions = {},
  ): Promise<readonly string[]> {
    const keep = new Set(options.keepSemanticIds ?? [])
    const records = await this.options.store.list(sessionKey)
    const running = records
      .filter(record => record.status === 'running' && !keep.has(record.semanticId))
      .map(record => record.handle).sort()
    const settled = await Promise.allSettled(running.map(handle => this.stop({ sessionKey, handle })))
    const failed = running.filter((_, index) => settled[index]?.status === 'rejected')
    // UA12.153 (SIT-D F3) — the residual half asks the question `countActive`
    // already asks (D1.345) before counting: a record this supervisor does not
    // own and whose pid is PROVEN gone (start-marker mismatch — the shape an app
    // quit leaves behind when the close handler's flush loses the shutdown race
    // and writes `lost` for a process that died with the host) is RETIRED to
    // `exited`, not counted. Before this, a `lost` record was never stopped
    // (the first half reads `running` only) and never resolved (the residual
    // filter counted `lost` unconditionally), so the strict drain behind
    // `deleteSession` refused FOREVER on a session that holds no live work —
    // `pi-session-drain-failed:session deletion`, the SIT-D measurement. The
    // fail-closed direction is untouched: an owned handle (its stop already
    // reported through `failed`), a pid that still matches its marker (live
    // work) and a platform that cannot be asked (no marker reader) all stay
    // residuals exactly as before.
    const residuals: string[] = []
    for (const record of await this.options.store.list(sessionKey)) {
      if ((record.status !== 'running' && record.status !== 'lost') || keep.has(record.semanticId)) continue
      if (!this.children.has(record.handle) && await this.retireRecoveredProcessIfGone(record, sessionKey)) continue
      residuals.push(record.handle)
    }
    const failedHandles = [...new Set([...failed, ...residuals])].sort()
    if (failedHandles.length > 0) throw new ProcessSessionDrainError(failedHandles)
    return running
  }

  /**
   * How many processes this session still has running — the settlement's
   * question, and the ONLY thing it ever took from {@link snapshot}.
   *
   * Kept apart from `snapshot` because the two have different costs and only one
   * of them is on a hot path: `snapshot` projects the record LIST, so it pays
   * `ProcessStore.list`'s whole-store scan and has to (the renderer wants the
   * rows). The settlement wants one integer, twice per goal-continuation
   * attempt, and P2.22 measured that scan at 175-204 ms against 897 records.
   * `ProcessStore.countRunning` answers from the durable running index instead;
   * ownership and the `running` predicate are decided there, unchanged.
   */
  async countRunning(sessionKey: SessionKey): Promise<number> {
    return await this.options.store.countRunning(sessionKey)
  }

  /**
   * P2.523 — {@link countRunning}'s own walk, returning what it opened.
   *
   * Delegated for the same reason `countRunning` is: `ProcessStore.listRunning`
   * decides ownership and the `running` predicate, and this class adds nothing
   * to a pure record read. Cannot see a `lost` record (the running index holds
   * none), so it answers the settlement's question, not {@link countActive}'s.
   *
   * Free beside the count, which is the row's whole point: `countRunning` is
   * `.length` over this same body, so a caller that wants the list pays no
   * extra `readdir`, no extra `get` and no second traversal for it.
   */
  async listRunning(sessionKey: SessionKey): Promise<StoredProcess[]> {
    return await this.options.store.listRunning(sessionKey)
  }

  /**
   * D1.339 — is the process behind a RECOVERED `running` record provably gone?
   *
   * The same evidence, read the same way, as the two paths that already answer
   * this question inside this class: {@link read}'s recovery branch and
   * `stopRecovered` both compare the pid's CURRENT start marker against the one
   * stamped into the record, and treat a disagreement as
   * `process-recovery-identity-mismatch`. A pid alone proves nothing — the
   * number is reused — which is why the marker exists at all.
   *
   * **`true` means PROVEN GONE, and every other outcome is `false`.** The three
   * "cannot ask" shapes — a record with no pid, a record whose marker was never
   * stamped (the window between spawn and the marker write, and every Windows
   * record, where {@link pidStartMarkerReader} is undefined by design) — answer
   * `false`, because "I could not find out" is not a yes. That is `L7`'s floor
   * verbatim, and it is what keeps this predicate from retiring a live shell on
   * a platform that cannot be asked.
   *
   * The two callers that DECLARE a record `lost` do so having asked the user to
   * act on it; this one is a read for a startup pass, so it declares nothing and
   * only reports. What to do about a `true` is the caller's.
   */
  async recoveredProcessIsGone(record: StoredProcess): Promise<boolean> {
    const markerReader = this.pidStartMarkerReader()
    if (!record.pid || !record.pidStartMarker || !markerReader) return false
    const current = await markerReader(record.pid).catch(() => null)
    return current !== record.pidStartMarker
  }

  /**
   * D1.345 — ask {@link recoveredProcessIsGone}, and write the answer down.
   *
   * ## Why the answer has to be WRITTEN and not merely returned
   *
   * A record left `running` for a process that ended while this app was not
   * running pins its session busy for ever: `countActive` counts
   * `running || lost`, `SessionManager.liveAgentBusyDomainsFor` reads that as the
   * `process` domain, and nothing re-checks pid identity except {@link read} and
   * `stopRecovered` — both of which need a USER to ask about that handle. And a
   * caller that merely declined to COUNT such a record would hand the reaper a
   * session whose dispose then fails, because `drainSession` re-lists and throws
   * `ProcessSessionDrainError` for anything still `running` or `lost`. So the
   * record moves, once, and every later pass is cheap.
   *
   * ## `exited` with no code and no signal, and why not `lost`
   *
   * `lost` is this class's word for *"this host no longer owns the process and
   * cannot say whether it is alive"*, which is why `countActive` counts it. A
   * marker mismatch is the opposite: the host CAN say — that pid is a different
   * process now, or no process at all. Recording "cannot say" for something we
   * just established would keep the session pinned on the strength of an answer
   * we have.
   *
   * `exitCode: null` and `signal: null` because this host did not observe the
   * ending and must not invent one; that is the same pair a record carries
   * between spawn and close. Not `stopped` (nobody stopped it) and not
   * `timed-out` (no deadline fired). `exited` also puts it in
   * `SessionManager`'s `ENDED_SUPERVISED_PROCESS_STATUSES`, so the background
   * shell registry retires its entry on the next `onChanged` — one word, one
   * meaning, every reader.
   *
   * Returns whether the process is gone, which is the caller's question;
   * a store write that FAILS does not change that answer, because the process is
   * gone either way and the next pass will try the write again.
   *
   * `sessionKey` is what the notification needs and the RECORD cannot give: it
   * carries `owner` as an encoded string and this package has an encoder and no
   * decoder. Callers that hold the key pass it; the notification is skipped
   * rather than guessed when they do not.
   */
  async retireRecoveredProcessIfGone(record: StoredProcess, sessionKey?: SessionKey): Promise<boolean> {
    if (!(await this.recoveredProcessIsGone(record))) return false
    if (record.status !== 'running' && record.status !== 'lost') return true
    await this.options.store.update(record.handle, { status: 'exited', exitCode: null, signal: null })
      .then(() => { if (sessionKey) this.notifyChanged(sessionKey) })
      .catch(() => undefined)
    return true
  }

  /**
   * How many of this session's records are `running` OR `lost` — the liveness
   * question, answered WITHOUT a cap.
   *
   * P2.143. The busy read asked {@link snapshot} for this, and `snapshot` sorts
   * `startedAt` DESC and slices: it is a RENDERER projection, paginated on
   * purpose, and it refuses any limit above 100 outright
   * (`process-snapshot-limit-invalid`), so there was no cap the caller could
   * raise. MEASURED on a real store holding 121 records for one session whose
   * OLDEST was the still-running one: `snapshot(…, { limit: 100 })` returned the
   * 100 newest and the `running || lost` filter over them counted **0** — the
   * session read idle to the live-agent ceiling and to the reaper. Uncapped, the
   * same store answers 1.
   *
   * `lost` is counted with `running` for the reason the busy read gives: a
   * record whose process cannot be confirmed dead is exactly as unsafe to evict
   * over as a confirmed live one. That is also why {@link countRunning} is NOT
   * what this delegates to — it answers from the running index, which by
   * construction cannot see a `lost` record, and adopting it would trade one
   * fail-open answer for another.
   *
   * The cost is `ProcessStore.list`'s whole-store scan — the SAME scan the
   * capped `snapshot` was already paying before it threw most of its result
   * away, so this is not a new cost on the ceiling and reaper paths, only a
   * complete answer for it. {@link drainSession} has always read this way.
   */
  async countActive(sessionKey: SessionKey): Promise<number> {
    const records = await this.options.store.list(sessionKey)
    const active = records.filter(record => record.status === 'running' || record.status === 'lost')
    // D1.345 — before counting, ask about the ones this process does not own.
    //
    // `lost` is counted above because a process that cannot be CONFIRMED dead is
    // as unsafe to evict over as a live one. That is right, and it left a hole:
    // nothing ever confirmed. A record written by a previous host process whose
    // shell has since ended stayed `running` for ever, so the session it belongs
    // to read busy for ever — the reaper never fired for it, the ceiling never
    // chose it, and no surface said why. D1.339's startup pass retires one such
    // record once per host process; this is the same question asked on the same
    // evidence wherever the reaper and the ceiling already look.
    //
    // ONLY the unowned ones. A handle in `children` belongs to a child this
    // supervisor is holding right now — its liveness is not a question for `ps`,
    // and probing it would spend a process read on every foreground Bash.
    // Everything the predicate cannot ask about answers "not gone" and is
    // counted exactly as before, which is the direction that never evicts live
    // work.
    let gone = 0
    for (const record of active) {
      if (this.children.has(record.handle)) continue
      if (await this.retireRecoveredProcessIfGone(record, sessionKey)) gone += 1
    }
    return active.length - gone
  }

  async snapshot(sessionKey: SessionKey, options: { limit?: number } = {}): Promise<readonly PiHarnessProcessSnapshotV1[]> {
    const limit = options.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('process-snapshot-limit-invalid')
    const records = await this.options.store.list(sessionKey)
    return Object.freeze(records
      .sort((left, right) => right.startedAt - left.startedAt || left.handle.localeCompare(right.handle))
      .slice(0, limit)
      .map(record => Object.freeze({
        handle: record.handle,
        semanticId: record.semanticId,
        startedAt: record.startedAt,
        deadlineAt: record.deadlineAt,
        status: record.status,
        exitCode: record.exitCode,
        signal: record.signal,
        isolationProfile: record.isolationProfile,
        nextCursor: record.nextCursor,
      })))
  }

  private async timeout(sessionKey: SessionKey, handle: string): Promise<void> {
    const record = await this.options.store.assertOwner(sessionKey, handle)
    if (record.status !== 'running') return
    await this.stopWithTerminal(sessionKey, handle, 'timed-out')
  }

  private async stopWithTerminal(sessionKey: SessionKey, handle: string, terminal: 'stopped' | 'timed-out'): Promise<void> {
    if (!this.requestedTerminal.has(handle)) this.requestedTerminal.set(handle, terminal)
    await this.stop({ sessionKey, handle })
  }

  private signalTree(child: ChildProcess, signal: NodeJS.Signals): boolean {
    if (!child.pid) return true
    if ((this.options.platform ?? process.platform) === 'win32') {
      try {
        ;(this.options.runWindowsTaskkill ?? runWindowsTaskkill)([
          '/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : []),
        ])
        return true
      } catch {
        return false
      }
    }
    try {
      process.kill(-child.pid, signal)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      try {
        return child.kill(signal)
      } catch {
        return false
      }
    }
  }

  private trackAppend(
    handle: string,
    child: ChildProcess,
    chunk: Buffer | string,
    sessionKey?: SessionKey,
  ): void {
    void this.options.store.append(handle, chunk).then(
      async produced => {
        // P6.346(b) — the LIFETIME ceiling, which is the half `process-store.ts`
        // never had. Its `MAX_LOG_BYTES` is a RING: it drops the head and the
        // process keeps running, so a shell producing gigabytes was bounded in
        // what the model READ and in nothing else. `produced` is the record's
        // own lifetime count, so this is the first place the difference is
        // visible without a second file read.
        await this.enforceOutputCeiling(handle, child, produced)
        // ...and the machine's answer, which is a different question with a
        // different sentence. Sampled on the same edge because it is the only
        // periodic edge this class has, and throttled inside.
        await this.enforceMemoryPressure(handle, child, sessionKey)
      },
      async () => {
        this.requestedTerminal.set(handle, 'lost')
        this.signalTree(child, 'SIGKILL')
        await this.options.store.update(handle, { status: 'lost' }).catch(() => undefined)
      },
    )
  }

  /** P6.346(b) — kill on the lifetime ceiling, with the note saying which. */
  private async enforceOutputCeiling(handle: string, child: ChildProcess, produced: number): Promise<void> {
    if (this.ceilingKilled.has(handle)) return
    const limit = this.options.maxLifetimeOutputBytes ?? resolveProcessOutputCeilingBytes()
    if (!(limit > 0) || produced < limit) return
    // Marked BEFORE the log write, so a chunk arriving during the two awaits
    // below cannot start a second kill and write a second notice.
    this.ceilingKilled.add(handle)
    await this.options.store.append(handle, describeOutputCeilingKill(produced, limit)).catch(() => undefined)
    const owner = this.handleSessions.get(handle)
    if (owner === undefined) { this.signalTree(child, 'SIGKILL'); return }
    await this.stopWithTerminal(owner, handle, 'stopped').catch(() => {
      this.signalTree(child, 'SIGKILL')
    })
  }

  /**
   * P6.346(b)+(c) — the memory-pressure reaper, behind the three guards.
   *
   * Throttled to one sample per {@link MEMORY_PRESSURE_SAMPLE_MS}: `freemem()`
   * is a syscall and this runs on every chunk of every supervised process, so an
   * unthrottled read would make a chatty command's output path a system-call
   * loop — a cost with no ceiling, added by a ceiling.
   */
  private async enforceMemoryPressure(
    handle: string,
    child: ChildProcess,
    sessionKey?: SessionKey,
  ): Promise<void> {
    if (this.ceilingKilled.has(handle) || sessionKey === undefined) return
    const reading = this.sampleMemoryPressure()
    if (reading === undefined) return
    await this.applyMemoryPressure(handle, child, sessionKey, reading)
  }

  /**
   * P6.825 — the reaper's OTHER edge: it looks even when nobody speaks.
   *
   * The append edge above only fires when a process writes, so the shape the
   * reaper exists for — a memory-hungry process that has gone quiet — was the
   * one shape it could never see. `sleep 3600 &` and a leaking daemon produce no
   * chunk at all, and a build that allocates for ten minutes between two lines
   * of output produces one every ten minutes.
   *
   * ONE reading per tick, applied to every live handle: `freemem()` is a
   * property of the machine and not of a process, so re-sampling per handle
   * would multiply the syscall the throttle exists to bound — and, worse, the
   * throttle would then let the FIRST handle in insertion order consume every
   * sample window and starve the reapable one behind it. The per-handle part is
   * the guard set and the kill, which are per session.
   */
  private sweepMemoryPressure(): void {
    const reading = this.sampleMemoryPressure()
    if (reading === undefined) return
    for (const [handle, child] of [...this.children]) {
      const sessionKey = this.handleSessions.get(handle)
      if (sessionKey === undefined || this.ceilingKilled.has(handle)) continue
      void this.applyMemoryPressure(handle, child, sessionKey, reading).catch(() => undefined)
    }
  }

  /**
   * The throttled machine reading, or `undefined` when the reaper is off or the
   * sample window has not elapsed. Shared by both edges so the two can never
   * disagree about how often `freemem()` may be called.
   */
  private sampleMemoryPressure(): MemoryPressureReading | undefined {
    const thresholdPercent = this.options.memoryPressurePercent ?? resolveMemoryPressureThresholdPercent()
    if (!(thresholdPercent > 0)) return undefined
    const now = Date.now()
    if (now - this.lastMemorySampleAt < ProcessSupervisor.MEMORY_PRESSURE_SAMPLE_MS) return undefined
    this.lastMemorySampleAt = now
    const memory = this.options.readFreeMemory?.() ?? { freeBytes: freemem(), totalBytes: totalmem() }
    return { now, freeBytes: memory.freeBytes, totalBytes: memory.totalBytes, thresholdPercent }
  }

  /** The per-handle half: the session's guards, the verdict, the one notice. */
  private async applyMemoryPressure(
    handle: string,
    child: ChildProcess,
    sessionKey: SessionKey,
    reading: MemoryPressureReading,
  ): Promise<void> {
    const verdict = resolveBackgroundShellReaping({
      guards: this.options.sessionQuiescence?.(sessionKey),
      now: reading.now,
      freeBytes: reading.freeBytes,
      totalBytes: reading.totalBytes,
      thresholdPercent: reading.thresholdPercent,
    })
    if (!verdict.reap) return
    this.ceilingKilled.add(handle)
    await this.options.store
      .append(handle, describeMemoryPressureKill(verdict.freeRatioPercent, reading.thresholdPercent))
      .catch(() => undefined)
    await this.stopWithTerminal(sessionKey, handle, 'stopped').catch(() => {
      this.signalTree(child, 'SIGKILL')
    })
  }

  /**
   * P6.825 — arm the sweep, once, and only when there is something to sweep FOR.
   *
   * Gated on the threshold as well as on liveness: the reaper defaults OFF
   * (P6.346's stated posture), and an install that never turns it on must not
   * pay a five-second heartbeat for a decision that can only ever be "no".
   */
  private armMemorySweep(): void {
    if (this.memorySweepTimer !== undefined) return
    const thresholdPercent = this.options.memoryPressurePercent ?? resolveMemoryPressureThresholdPercent()
    if (!(thresholdPercent > 0)) return
    const timer = setInterval(
      () => this.sweepMemoryPressure(),
      ProcessSupervisor.MEMORY_PRESSURE_SAMPLE_MS,
    )
    timer.unref?.()
    this.memorySweepTimer = timer
  }

  /** Clear the sweep once the last supervised process has gone. */
  private disarmMemorySweepIfIdle(): void {
    if (this.children.size > 0 || this.memorySweepTimer === undefined) return
    clearInterval(this.memorySweepTimer)
    this.memorySweepTimer = undefined
  }

  private notifyChanged(sessionKey: SessionKey): void {
    void Promise.resolve(this.options.onChanged?.(sessionKey)).catch(() => undefined)
  }

  /**
   * Windows has no portable host-owned PID creation marker in the current
   * runtime. Processes owned by this live supervisor remain usable in memory;
   * recovery without that owner still fails closed because the persisted marker
   * stays null. Tests and future Windows bindings may inject a stronger reader.
   */
  private pidStartMarkerReader(): ((pid: number) => Promise<string>) | undefined {
    if (this.options.readPidStartMarker) return this.options.readPidStartMarker
    return (this.options.platform ?? process.platform) === 'win32' ? undefined : readPidStartMarker
  }
}

function assertProcessStartActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('process-start-aborted')
}

/**
 * The names a supervised child inherits from THIS host under the shipped
 * default profile. Everything else is dropped, which is the point.
 *
 * NO PROXY OR CA NAME IS HERE, AND THAT IS DELIBERATE SINCE C3.382
 * (2026-09-12). It was an ACCIDENT before: a Pi `bash` tool call is a
 * supervised process, so this allowlist was silently stripping the operator's
 * proxy off the model's shell, and R7 measured that shell reaching the public
 * internet while the app was pointed at a proxy refusing everything. The fix
 * does NOT belong here, for two reasons this back-pointer exists to keep
 * visible: an entry here forwards the HOST process's value, so it would miss
 * the in-app Settings proxy entirely; and `hostEnvironment` below enumerates
 * `Object.entries(process.env)`, the one read a runtime-ASSIGNED proxy name is
 * invisible to under Bun (AGENTS.md §Traps). The projection is delivered
 * instead through a start request's `env`, which this file merges OVER this
 * set: `packages/shared/src/config/proxy-env.ts` symbol
 * `buildShellChildNetworkEnv`, spread at `packages/shared/src/agent/pi-agent.ts`
 * symbol `handleProcessStartRequest`. Adding a proxy name here would not fix
 * that case and would quietly widen every other supervised child.
 */
const RESTRICTED_HOST_ENVIRONMENT = new Set([
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'JAVA_HOME', 'JDK_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
  'PYENV_ROOT', 'NVM_DIR', 'BUN_INSTALL', 'PNPM_HOME', 'DOTNET_ROOT',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'NESSY_UV', 'NESSY_CLI_DOC_PATH', 'NESSY_COMMANDS_DOC_PATH', 'NESSY_AGENT_VERSION',
])

export function isRestrictedHostEnvironmentKey(name: string): boolean {
  return RESTRICTED_HOST_ENVIRONMENT.has(name) || /^LC_[A-Z0-9_]+$/.test(name)
}

function resolveEnvironmentProfile(request: SupervisedProcessStartRequest): ProcessEnvironmentProfile {
  if (request.environmentProfile && request.inheritHostEnv !== undefined) {
    throw new Error('process-environment-profile-conflict')
  }
  if (request.environmentProfile) return request.environmentProfile
  if (request.inheritHostEnv === false) return 'explicit'
  if (request.inheritHostEnv === true) return 'trusted-host'
  return 'restricted'
}

function hostEnvironment(profile: ProcessEnvironmentProfile): Record<string, string> {
  if (profile === 'explicit') return {}
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => {
    if (entry[1] === undefined) return false
    return profile === 'trusted-host' || isRestrictedHostEnvironmentKey(entry[0])
  }))
}

function digestEnvironment(environment: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256')
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(key).update('\0').update(value).update('\0')
  }
  return hash.digest('hex')
}

function runWindowsTaskkill(args: readonly string[]): void {
  execFileSync('taskkill.exe', [...args], {
    stdio: 'ignore',
    timeout: 5_000,
    windowsHide: true,
  })
}

/**
 * Append into the foreground capture, dropping everything past
 * {@link ProcessSupervisor.MAX_FOREGROUND_STREAM_BYTES}.
 *
 * The drop is SILENT — no marker, no flag on the result. That is tolerable only
 * because of the measurement on that constant: these two fields reach no
 * consumer, so there is nobody to mislead. **If a reader is ever added, this
 * function needs a truncation marker first**, for the reason
 * `config/bash-output-limits.ts` exists: a reader that cannot tell truncation
 * from completion misreads the result on every call.
 */
function appendBoundedStream(current: Buffer, chunk: Buffer | string): Buffer {
  const remaining = ProcessSupervisor.MAX_FOREGROUND_STREAM_BYTES - current.length
  if (remaining <= 0) return current
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  return Buffer.concat([current, next.subarray(0, remaining)])
}

/**
 * The host's own definition of process identity: a string that changes when the
 * pid is reused. EXPORTED since D1.339 so a test can stamp a record exactly as
 * the supervisor would — spelling the format a second time in a fixture is the
 * drift this export exists to prevent, and a record stamped wrongly would make
 * every liveness assertion pass for the wrong reason.
 */
export async function readPidStartMarker(pid: number): Promise<string> {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    return `linux:${parseLinuxProcStatStartTime(stat)}`
  }
  if (process.platform === 'darwin') {
    return `darwin:${execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim()}`
  }
  throw new Error(`process-identity-unavailable:${process.platform}`)
}

export function parseLinuxProcStatStartTime(stat: string): string {
  const boundary = stat.lastIndexOf(') ')
  if (boundary < 0) throw new Error('invalid-linux-proc-stat')
  const fieldsAfterComm = stat.slice(boundary + 2).trim().split(/\s+/)
  const startTime = fieldsAfterComm[19]
  if (!startTime || !/^\d+$/.test(startTime)) throw new Error('invalid-linux-proc-stat-start-time')
  return startTime
}
