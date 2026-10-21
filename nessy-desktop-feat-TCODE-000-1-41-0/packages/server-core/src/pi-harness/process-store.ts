import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV,
  BASH_MAX_OUTPUT_LENGTH_ENV,
  resolveBashReadBackChars,
} from '@nessy-agent/shared/config/bash-output-limits'
import { encodeSessionKey, type SessionKey } from '@nessy-agent/shared/sessions/session-key'
import { SUPERVISED_PROCESS_HANDLE, type IsolationDowngradeV1, type ProcessEnvironmentProfile, type ProcessIsolationProfile } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'

/**
 * P3.320 — HOW MUCH OF ONE PROCESS'S OUTPUT THIS STORE KEEPS, AND WHICH
 * DOCUMENTED NUMBER GOVERNS.
 *
 * This is a RING: {@link ProcessStore.append} keeps the last `limit` bytes and
 * advances `baseCursor` past what it drops. Every foreground Bash result on Pi
 * is `readLog`'s output, so this constant — not any cap in `ProcessSupervisor`
 * — is what bounds the text the model reads.
 *
 * **The row that opened P3.320 said this field had NO byte bound at all. That
 * is REFUTED, by its own author, on a driven rig (W3-c 2026-09-03):** appending
 * 205 000 bytes in 200 chunks and reading back gave **exactly 65 536 bytes**,
 * beginning at `[chunk136]`, with `nextCursor` 204 600. The bound was here the
 * whole time; `readLog`'s `readFile` never sees more than this many bytes, so
 * the "5 GB `readFile`" the row feared cannot happen.
 *
 * **The real defect was the opposite one, and it is the worse of the two:** the
 * ring drops the HEAD, and said nothing. A build that failed on line 3 of a
 * 200 KB log handed the model the last 64 KiB with no notice, so the model
 * could not tell truncation from completion — the exact defect class
 * `config/bash-output-limits.ts` exists for, on its third path. That is what
 * {@link describeDroppedOutput} closes.
 *
 * ## The page's six numbers, and which one is this
 *
 * `tools-reference.md#output-limits` (anchor verified on the rendered page,
 * 2026-09-03), verbatim:
 *
 *  1. **5 GB stream kill** — "Claude Code streams a command's output to a
 *     working file as the command runs; a command whose output passes 5 GB is
 *     killed." NOT this constant, and NOT implemented: it is a KILL at the
 *     streaming layer, i.e. terminating a user's process, which is a product
 *     posture rather than a cap. Recorded as absent. The ring makes its memory
 *     argument moot — output past the window is dropped, not accumulated.
 *  2. **~30 000 characters, valid inline** — "Inline up to roughly 30,000
 *     characters; past that, the path of a file saved to the session directory,
 *     truncated past 64 MiB, plus a short preview from the start". Owned
 *     downstream by `LocalToolRuntime.guardResult`, at a MORE generous token
 *     threshold; P2.355 measured that adopting the page's number there would
 *     show the model less.
 *  3. **64 MiB working-file truncation** — same sentence. Not this constant:
 *     the ring is three orders of magnitude smaller, so it is already stricter
 *     than the page's file tier and cutting again at 64 MiB would be inert.
 *  4. **~10 000 characters, failure inline** — "Inline up to roughly 10,000
 *     characters; past that, a head-and-tail excerpt of that size cut from the
 *     read-back window, with no file path." Owned downstream by
 *     `applyBashOutputLimits`.
 *  5. **30 000 read-back default** and 6. **150 000 hard ceiling** —
 *     "`BASH_MAX_OUTPUT_LENGTH` sets how many characters of output Claude Code
 *     reads back from the working file into a command's result: 30,000 by
 *     default, up to a hard ceiling of 150,000."
 *
 * **Numbers 5 and 6 are this constant's**, and they are the reason the operator
 * knob is wired below: the page calls this variable the size of "the read-back
 * window", and the working file it reads back from is exactly this ring. Before
 * P3.320 an operator who set it got documented behaviour on the Claude
 * subprocess (the vendored binary carries the name nine times) and silence on
 * Pi.
 *
 * POSTURE, stated: **the default does not move.** `resolveBashReadBackChars`
 * returns 30 000, and 30 000 is below this floor, so an install that sets
 * nothing keeps exactly 65 536 bytes. Only an operator who raises the variable
 * past that gets a larger ring, and the page's own 150 000 ceiling clamps it.
 * The variable counts CHARACTERS and this counts BYTES; applying a character
 * budget as a byte budget is CONSERVATIVE — N bytes hold at most N characters —
 * so the model never sees more characters than the operator allowed.
 */
const MAX_LOG_BYTES = 64 * 1024

/**
 * The ring size for one append, honouring the documented operator knob.
 *
 * `override` is the constructor's `maxLogBytes` and still wins outright: it is
 * how a test pins the rollover at five bytes, and an explicit host decision must
 * not be second-guessed by an environment variable.
 */
export function resolveLogLimitBytes(
  override?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  if (override !== undefined) return override
  return Math.max(MAX_LOG_BYTES, resolveBashReadBackChars(env))
}

/**
 * The notice a reader gets when the ring dropped output it asked for.
 *
 * Prepended rather than appended: what was lost is the HEAD, so the notice
 * belongs where the missing text would have been, and a reader that only sees
 * the start of a long result still sees it. It names both numbers and the
 * variable that buys more, because a marker that says only "truncated" leaves
 * the reader unable to judge how much is missing.
 */
export function describeDroppedOutput(
  droppedBytes: number,
  producedBytes: number,
  keptBytes: number,
): string {
  return `[earlier output dropped: ${droppedBytes} of ${producedBytes} bytes produced; `
    + `this result holds the last ${keptBytes} bytes. Raise ${BASH_MAX_OUTPUT_LENGTH_ENV} `
    + `(or ${BASH_MAX_OUTPUT_LENGTH_COMPAT_ENV}) to keep more.]\n`
}
/**
 * P6.346(b) — the note that says WHICH ceiling killed this process.
 *
 * Written into the LOG rather than onto a new record field, and that is the
 * design: `readLog`'s output IS every foreground Bash result on Pi (see
 * {@link MAX_LOG_BYTES}), so the log is the channel the model already reads, and
 * a new terminal status would have to travel through `StoredProcess.status`, the
 * snapshot projection, the protocol and the renderer to reach the same reader.
 *
 * Appended rather than prepended, unlike {@link describeDroppedOutput}: what
 * this announces happened at the END, and a reader who sees the output stop
 * needs the reason where the output stopped.
 *
 * Both sentences name the number and the way out, for the reason the drop notice
 * does: a marker that says only "killed" leaves the reader unable to tell a
 * runaway from a bug in their command.
 */
export function describeOutputCeilingKill(producedBytes: number, limitBytes: number): string {
  return `\n[process killed: it produced ${producedBytes} bytes, past the ${limitBytes}-byte lifetime `
    + `output ceiling. Set ${PROCESS_OUTPUT_CEILING_ENV}=0 to disable the ceiling, or a larger number `
    + `to raise it.]\n`
}

/**
 * The other half of the same sentence, for a kill the machine forced rather than
 * a number the process passed. Named separately so the transcript can never
 * blame the wrong ceiling — which is the whole of the row's *"with a note saying
 * which killed it"*.
 */
export function describeMemoryPressureKill(freeRatioPercent: number, thresholdPercent: number): string {
  return `\n[process killed: this machine was down to ${freeRatioPercent}% free memory, past the `
    + `${thresholdPercent}% reaping threshold. Set ${PROCESS_MEMORY_PRESSURE_ENV}=0 to disable the `
    + `reaper.]\n`
}

/**
 * The operator knob for the lifetime ceiling above, and the DEFAULT is read
 * rather than invented.
 *
 * `tools-reference.md#output-limits` on the runtime we vendor, verbatim:
 * *"Claude Code streams a command's output to a working file as the command
 * runs; a command whose output passes 5 GB is killed."* That sentence is
 * recorded three constants above as *"NOT implemented … Recorded as absent"* —
 * this is where it stops being absent, at the documented number rather than at
 * one this fork chose.
 *
 * `0` disables the ceiling outright: that is the operator's off switch, and it
 * must not be spelled as "kill everything", the same rule
 * `resolveIdleAgentReaping` states for its own zero.
 */
export const PROCESS_OUTPUT_CEILING_ENV = 'NESSY_PROCESS_MAX_OUTPUT_BYTES'

/** The page's own 5 GB, in bytes. */
export const DEFAULT_PROCESS_OUTPUT_CEILING_BYTES = 5 * 1024 * 1024 * 1024

export function resolveProcessOutputCeilingBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[PROCESS_OUTPUT_CEILING_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROCESS_OUTPUT_CEILING_BYTES
  const parsed = Number(raw)
  // A value that is not a non-negative integer leaves the documented default in
  // place rather than disabling the ceiling: the failure direction of the other
  // reading is a typo silently removing a bound.
  if (!Number.isSafeInteger(parsed) || parsed < 0) return DEFAULT_PROCESS_OUTPUT_CEILING_BYTES
  return parsed
}

/**
 * The memory-pressure reaper's threshold, as a PERCENTAGE of free physical
 * memory below which a background process may be taken.
 *
 * Native mechanism: **none, and this is recorded rather than implied.**
 * `memoryPressure` scored 0 over `packages` + `apps` when the row was filed and
 * still does; there is no OS memory-pressure signal reachable from Node — macOS
 * publishes one through `libdispatch`'s `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`
 * and Linux through cgroup PSI, neither of which has a binding here. So the host
 * samples `os.freemem()` / `os.totalmem()`, which is the same pair
 * `defaultLiveAgentCeiling` already sizes itself from, and the sentence in the
 * transcript says *free memory* rather than claiming an OS signal we do not have.
 *
 * DEFAULT OFF (`0`), deliberately, and this is a product posture stated rather
 * than taken: killing a user's running command because the machine is busy is a
 * decision the owner has not made, and the failure mode of guessing it wrong is
 * destroyed work. The mechanism is built, bounded and tested; an operator turns
 * it on.
 */
export const PROCESS_MEMORY_PRESSURE_ENV = 'NESSY_PROCESS_MEMORY_PRESSURE_PERCENT'

export function resolveMemoryPressureThresholdPercent(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[PROCESS_MEMORY_PRESSURE_ENV]
  if (raw === undefined || raw.trim() === '') return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) return 0
  return parsed
}

const PROCESS_HANDLE = SUPERVISED_PROCESS_HANDLE // UA12.205 — one pattern for the store and the renderer's View Output gate

/**
 * Whether a background-work handle is one of THIS store's — the shape
 * {@link ProcessStore.validateHandle} accepts and every other shape it throws
 * `invalid-process-handle` for.
 *
 * Exported because a host that holds handles from more than one producer has to
 * be able to ask before it hands one over. P3.26: a codex background terminal
 * lands in the same `backgroundShellCommands` map a Pi shell does, but its id is
 * the app-server's digit-parseable `processId` (`"4242"`), so `killShell` fed it
 * to this store and got `invalid-process-handle` — the press failed, the row
 * stayed, and the terminal kept running. The branch that fixes it reads THIS
 * predicate rather than a copy of the pattern, so the caller's idea of "not
 * mine" cannot drift from the gate that enforces it.
 *
 * Deliberately a SHAPE test and not a runtime-type test: a handle that is not
 * Pi's is not necessarily codex's, and the store is the only thing that knows
 * which shapes it owns.
 */
export function isPiProcessHandle(handle: string): boolean {
  return PROCESS_HANDLE.test(handle)
}

/**
 * The message {@link ProcessStore.validateHandle} throws, named once because
 * {@link isFilesystemReadFailure} recognises it BY VALUE. A rename of the string
 * that left the predicate behind would quietly turn a skipped record into a
 * failed build — so the two read the same constant instead of the same spelling.
 */
const INVALID_PROCESS_HANDLE = 'invalid-process-handle'

/**
 * How many record files {@link ProcessStore.list} may hold open at once.
 *
 * `list()` used to be `Promise.all(names.map(get))` — one `open` per record, all
 * in flight together. MEASURED on the owner's profile 2026-08-21: the store had
 * accumulated **807 records** (1 615 files counting the `.log` siblings), and
 * that fan-out raised `EMFILE: too many open files` on the FIRST runtime switch
 * of a freshly-launched app — killing the switch at its first step. The EMFILE
 * does not land on this directory first: the fd storm takes down whatever
 * unrelated read is in flight (the log's first two were `automations.json` and
 * `plugins/installed.json`), and `scandir '…/.pi-processes'` is its TAIL, 600 ms
 * later, which is why the cause read as a retention problem rather than a
 * fan-out one.
 *
 * The budget this has to fit inside is NOT the launcher's: `launchctl limit
 * maxfiles` reports a soft limit of **256** and the launcher's `ulimit -n 8192`
 * does not reach Electron (a Node child raises its own limit, Electron does
 * not). The main process holds ~127 fds at rest, so an 807-way fan-out cannot
 * fit however the shell is configured, and record AGE cannot save it either —
 * retention (`retention-sweep.ts`, the `pi-process-record` tier) caps the store
 * near 3 000 records at the measured accrual, which is more than the ~800 that
 * already broke it. The fix has to be the bound, not the count.
 *
 * 32 is chosen against the ~129 fds of headroom that measurement leaves, not
 * against the store's size: it stays comfortably inside the budget while any
 * realistic store still drains in a handful of rounds, and it is a CONSTANT, so
 * the ceiling no longer moves with the directory.
 *
 * Exported so the unit that proves the bound asserts against the shipped value
 * rather than a copy of it.
 */
export const PROCESS_LIST_READ_CONCURRENCY = 32

/**
 * The durable RUNNING index (P2.22): one empty marker file per record whose
 * status is `running`, named by its handle, in a sibling directory of the
 * records themselves.
 *
 * It exists because the settlement asks for ONE integer — how many supervised
 * processes does this session still have running — and {@link ProcessStore.list}
 * charged it a whole-store scan to answer. MEASURED on the owner's profile
 * 2026-08-23: 897 records, 175-204 ms per call, and the goal continuation takes
 * two per attempt on every non-Pi session. `SessionManager.ts`'s
 * `reconcileEndedBackgroundShells` already carries the standing warning that
 * `list()`'s "cost grows without bound for the life of the install"; this is
 * that warning applied to the settlement's read.
 *
 * What it costs to read is what is RUNNING app-wide — zero at rest — instead of
 * what the store has accumulated. What it does NOT do is decide ownership: the
 * markers are a candidate list, and every candidate's record is still opened and
 * still filtered on `owner`, exactly as `list()` filters. The index narrows the
 * scan; it does not replace the predicate.
 *
 * It is durable rather than in-memory on purpose. Records outlive the host
 * process that wrote them — `stopRecovered` adopts a child this host never
 * spawned, and `adoptSupervisedShellCommands` adopts the command lines — so a
 * per-process counter would report a restored session as idle and let the goal
 * continuation dispatch an unattended turn over a process the host still
 * believes is alive.
 *
 * Exported so the units that pin it name the shipped directory rather than a
 * copy of it.
 */
export const PROCESS_RUNNING_INDEX_DIR_NAME = '.running'

/**
 * The one non-handle-shaped file the index always contains (P2.64).
 *
 * It exists to make the first-ever build's rename FAIL for the loser. POSIX
 * `rename` replaces an existing EMPTY directory instead of raising
 * `ENOTEMPTY` — re-confirmed on this platform 2026-08-23, `rename(empty,
 * empty)` succeeds and `rename(empty, {.built})` gives `ENOTEMPTY` — and an
 * index built while nothing is running IS empty, which is this store's resting
 * state. So two first-time builders could both succeed, the second silently
 * replacing the first's directory — see {@link ProcessStore.ensureRunningIndex}
 * for what that actually cost, which is not what the source doc claimed. One
 * file written into the temporary directory before the rename removes the only
 * case where the "backs off on `ENOTEMPTY`" claim was conditional, without a
 * lock this store does not have.
 *
 * Deliberately not handle-shaped, so it is invisible to every reader that
 * already exists: {@link ProcessStore.countRunning} filters on
 * {@link PROCESS_HANDLE}, {@link ProcessStore.list} enumerates the store root
 * rather than this directory, and `retention-sweep.ts`'s `pi-process-record`
 * tier is an allowlist over `<handle>.json` in the store root that never
 * descends here. All four verified rather than assumed — see the rows in
 * `process-store.test.ts`.
 *
 * Exported so those rows name the shipped value rather than a copy of it.
 */
export const PROCESS_RUNNING_INDEX_SENTINEL_NAME = '.built'

export interface StoredProcess {
  handle: string
  owner: string
  executionId: string
  semanticId: string
  pid: number | null
  startedAt: number
  deadlineAt: number
  status: 'running' | 'exited' | 'stopped' | 'timed-out' | 'lost'
  exitCode: number | null
  signal: string | null
  pidStartMarker: string | null
  profile: ProcessIsolationProfile
  isolationProfile: string
  /** Present ONLY when the process ran outside isolation by policy. */
  isolationDowngrade?: IsolationDowngradeV1
  environmentProfile: ProcessEnvironmentProfile
  environmentDigest: string
  /**
   * The command line this process was started with, as the requester spelled it
   * (D12). NOT the isolation plan's rewritten argv: what an audit needs is what
   * the agent asked to run, not which sandbox wrapper the host chose.
   *
   * Persisted rather than kept in memory because the record OUTLIVES the process
   * that wrote it — a session resumed after a restart adopts these records, and
   * the Stop hook that then asks "what did the agent leave running" would read a
   * blank field at exactly the moment an incident review needs it.
   *
   * Stored verbatim, with no redaction: the same string is already persisted
   * verbatim in the transcript (`Message.toolInput.command`) and already handed
   * to every `PreToolUse` hook as `tool_input`. Two different answers for the
   * same string would be the defect, not the safeguard.
   *
   * Optional only for records written before this field existed.
   */
  command?: string
  cwd: string
  baseCursor: number
  nextCursor: number
  /** Set when timeout expiry moved this process to a background task (R10). */
  movedToBackgroundAt?: number
}

/**
 * Did the READ fail, as opposed to the record being absent or unusable?
 *
 * The distinction is the whole of I2: a `SyntaxError` from `JSON.parse`, or the
 * `invalid-process-handle` a stray `*.json` name raises, describes a record that
 * cannot be counted for anybody and is safely skipped. An `ErrnoException` with
 * any code other than `ENOENT` — `EMFILE`, `EIO`, `EACCES` — describes a store
 * that could not be ASKED, and answering "not running" for it is the fail-open
 * direction the running index exists to prevent.
 *
 * `ENOENT` sits with the first group on purpose: a record that is gone was
 * pruned, and a pruned record is not running.
 *
 * P2.64 — the polarity of that paragraph and the polarity of the CODE disagreed.
 * This used to read `typeof code === 'string' && code !== 'ENOENT'`, i.e. only
 * an error carrying a string `code` was a read failure and EVERYTHING ELSE was
 * skipped. So the skip list was open-ended and the rethrow list was closed,
 * which is backwards: an unrecognised throw is precisely the one nobody has
 * shown to be safe. MEASURED against the pre-change predicate 2026-08-23, on a
 * store holding 6 `running` records with one read made to throw a plain
 * `Error`: the build skipped it, renamed a five-marker index into place, and
 * every later call — a fresh instance whose read no longer fails included —
 * answered **5**, permanently, because the index is authoritative once it
 * exists.
 *
 * Three shapes are recognised as unusable and skipped BY NAME; anything else
 * fails the build. That is the same line count and it is what the paragraph
 * above always claimed.
 *
 * AUDITED, because a fourth shape would be worth more than the fix:
 * {@link ProcessStore.get} is `validateHandle` + `readFile` + `JSON.parse`, so
 * it throws `invalid-process-handle` (a stray `*.json` in the store root),
 * an `ErrnoException` from `readFile`, or a `SyntaxError` from `JSON.parse`.
 * The two further shapes Node documents for those calls —
 * `ERR_FS_FILE_TOO_LARGE` and `ERR_STRING_TOO_LONG`, neither reproduced here —
 * both carry a string `code` and so rethrow under EITHER polarity; neither is a
 * record whose content was ever seen. The predicate is written for the shape it
 * cannot enumerate, not for those.
 */
function isFilesystemReadFailure(error: unknown): boolean {
  // `JSON.parse` on a record that is not JSON: unusable for every session.
  if (error instanceof SyntaxError) return false
  // `validateHandle` on a stray `*.json` name: not a record at all.
  if ((error as Error | null | undefined)?.message === INVALID_PROCESS_HANDLE) return false
  // A record that is gone was pruned, and a pruned record is not running.
  return (error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT'
}

export class ProcessStore {
  private readonly appendQueues = new Map<string, Promise<number>>()
  private readonly mutationQueues = new Map<string, Promise<void>>()
  private rootReady: Promise<void> | undefined
  private runningIndexReady: Promise<void> | undefined

  constructor(private readonly options: { root: string; maxLogBytes?: number }) {}

  get scratchRoot(): string { return join(this.options.root, 'scratch') }

  async ensureRoot(): Promise<void> {
    const ready = this.rootReady ??= (async () => {
      await mkdir(this.options.root, { recursive: true, mode: 0o700 })
      await chmod(this.options.root, 0o700)
    })()
    try {
      await ready
    } catch (error) {
      if (this.rootReady === ready) this.rootReady = undefined
      throw error
    }
  }

  async create(input: Omit<StoredProcess, 'handle' | 'owner' | 'baseCursor' | 'nextCursor'> & { sessionKey: SessionKey }): Promise<StoredProcess> {
    const { sessionKey, ...values } = input
    // Established by the store's FIRST write, so a store born after P2.22 never
    // needs the legacy scan below and its first count is already cheap.
    await this.ensureRunningIndex()
    const record: StoredProcess = {
      ...values,
      handle: `process_${randomUUID().replaceAll('-', '')}`,
      owner: encodeSessionKey(sessionKey),
      baseCursor: 0,
      nextCursor: 0,
    }
    await this.write(record)
    await writeFile(this.logPath(record.handle), new Uint8Array(), { mode: 0o600 })
    await chmod(this.logPath(record.handle), 0o600)
    // Record first, marker second — in both directions. Marker-first opens a
    // real (not merely crash-window) race: a concurrent `countRunning` would see
    // a marker whose record does not exist yet, retire it as stale, and leave a
    // `running` record permanently uncounted.
    if (record.status === 'running') await this.markRunning(record.handle)
    return record
  }

  async get(handle: string): Promise<StoredProcess> {
    this.validateHandle(handle)
    return JSON.parse(await readFile(this.recordPath(handle), 'utf8')) as StoredProcess
  }

  async assertOwner(sessionKey: SessionKey, handle: string): Promise<StoredProcess> {
    const record = await this.get(handle)
    if (record.owner !== encodeSessionKey(sessionKey)) throw new Error('process-handle-owner-mismatch')
    return record
  }

  async update(handle: string, patch: Partial<StoredProcess>): Promise<StoredProcess> {
    this.validateHandle(handle)
    let updated!: StoredProcess
    const previous = this.mutationQueues.get(handle) ?? Promise.resolve()
    const next = previous.then(async () => {
      updated = { ...await this.get(handle), ...patch, handle }
      await this.write(updated)
      // THIS is how the count learns that a process ended: the same write the
      // supervisor already performs when a child closes, is stopped, times out
      // or is declared lost. No second signal, so there is nothing for the two
      // to drift apart on. A patch that does not carry a status — the cursor
      // update `append` performs on every log chunk — never touches the index.
      if (patch.status !== undefined) {
        if (updated.status === 'running') await this.markRunning(handle)
        else await this.clearRunning(handle)
      }
    })
    this.mutationQueues.set(handle, next)
    try {
      await next
      return updated
    } finally {
      if (this.mutationQueues.get(handle) === next) this.mutationQueues.delete(handle)
    }
  }

  /**
   * Append, and return the record's LIFETIME produced-byte count.
   *
   * P6.346(b) — the return value is the row's missing half, and it existed
   * already: `nextCursor` is documented on {@link readLog} as *"the record's own
   * produced-byte count, not a length of what was returned"*, so it counts every
   * byte the process has ever written while the ring above keeps only the last
   * window of them. That is exactly the difference between the 64 KiB RING this
   * file has always had and the LIFETIME ceiling the row asks for, and it is why
   * no new field is needed to enforce one.
   *
   * Returned rather than re-read by the caller: `ProcessSupervisor.trackAppend`
   * runs on every chunk, and a second `get()` there would double this path's
   * file reads for a number this function has already computed.
   */
  async append(handle: string, chunk: Buffer | string): Promise<number> {
    this.validateHandle(handle)
    const previous = this.appendQueues.get(handle) ?? Promise.resolve()
    const next = previous.then(async () => {
      const record = await this.get(handle)
      const existing = await readFile(this.logPath(handle)).catch(() => Buffer.alloc(0))
      const added = Buffer.from(chunk)
      const combined = Buffer.concat([existing, added])
      const limit = resolveLogLimitBytes(this.options.maxLogBytes)
      const drop = Math.max(0, combined.byteLength - limit)
      await writeFile(this.logPath(handle), combined.subarray(drop), { mode: 0o600 })
      const produced = record.nextCursor + added.byteLength
      await this.update(handle, {
        baseCursor: record.baseCursor + drop,
        nextCursor: produced,
      })
      return produced
    })
    this.appendQueues.set(handle, next)
    try { return await next } finally {
      if (this.appendQueues.get(handle) === next) this.appendQueues.delete(handle)
    }
  }

  async flush(handle: string): Promise<void> { await this.appendQueues.get(handle) }

  /**
   * The output from `cursor` on, and a NOTICE when the ring already dropped part
   * of what was asked for (P3.320).
   *
   * The notice fires on `cursor < baseCursor` — the caller asked for bytes the
   * ring has thrown away. That is exactly two cases and no others: the
   * foreground one-shot read (`ProcessSupervisor.start` reads at `cursor: 0`),
   * and a follower that fell behind the window. A follower still inside the
   * window loses nothing and is handed byte-identical output to before, which is
   * why the notice is not simply attached to `baseCursor > 0`.
   *
   * `nextCursor` is unchanged and unaffected by the notice: it is the record's
   * own produced-byte count, not a length of what was returned, so a follower's
   * accounting cannot drift because a notice was added.
   */
  async readLog(handle: string, cursor = 0): Promise<{ output: string; nextCursor: number }> {
    await this.appendQueues.get(handle)
    const record = await this.get(handle)
    const log = await readFile(this.logPath(handle)).catch(() => Buffer.alloc(0))
    const start = Math.max(0, Math.min(log.byteLength, cursor - record.baseCursor))
    const output = log.subarray(start).toString('utf8')
    const dropped = Math.max(0, record.baseCursor - cursor)
    return {
      output: dropped > 0
        ? `${describeDroppedOutput(dropped, record.nextCursor, log.byteLength)}${output}`
        : output,
      nextCursor: record.nextCursor,
    }
  }

  /**
   * Every record in the store, filtered to one session's own.
   *
   * The owner lives INSIDE each record, so there is no way to skip a file
   * without opening it — the store is global (one `.pi-processes` for the whole
   * app) while every caller wants one session. What can be bounded is how many
   * are open at a time, and that is what {@link PROCESS_LIST_READ_CONCURRENCY}
   * is for: a fixed pool of readers walks the handle list instead of a
   * `Promise.all` over all of it, so the fd cost of a list stops scaling with
   * the directory. Rejection semantics are unchanged — one unreadable record
   * still fails the whole list, exactly as the `Promise.all` did.
   *
   * P2.22 — that first paragraph is still true of a LIST, and it is why the
   * settlement no longer asks for one. A caller that wants the running count and
   * nothing else has {@link countRunning}, which reads the durable running index
   * and opens only the records it names. Reach for `list` when the caller really
   * does want every record (`drainSession`, `snapshot`'s projection,
   * `sweepRestoredMonitors`), not to derive a count from it.
   *
   * NOTE, so the next person does not read the settlement's move as the end of
   * it: FOUR readers still derive a running-only answer from a whole-store scan.
   * Three go through `snapshot()` and filter `running || lost` —
   * `SessionManager.liveAgentBusyDomainsFor` (the hibernation gate),
   * `strictDrainPiSessionOwned` (the session-close residual check) and the
   * child-session drain's residual check — and `sweepRestoredMonitors`
   * (`session-monitor-service.ts`) walks `list()` itself. None is on the goal
   * continuation's path, which is why they are a note rather than this row's
   * work. Three were Pi-only when this was written; `liveAgentBusyDomainsFor` no
   * longer is (P2.23 removed its provider gate, because a `Monitor` watch on
   * claude or codex owns a supervised process too), so its scan is now paid on
   * every runtime — still only when the ceiling has a victim to choose or the
   * reaper an aged candidate, and still never on a hot path. They are also not one substitution:
   * `sweepRestoredMonitors` needs each record's `semanticId` and
   * `movedToBackgroundAt`, not a number, so it wants a `listRunning()` built on
   * the same index — a small addition here, not a one-line call swap.
   */
  async list(sessionKey: SessionKey): Promise<StoredProcess[]> {
    await this.ensureRoot()
    const owner = encodeSessionKey(sessionKey)
    const handles = await this.storedHandles()
    const records = new Array<StoredProcess>(handles.length)
    await this.readBounded(handles, async (handle, index) => { records[index] = await this.get(handle) })
    return records.filter(record => record.owner === owner)
  }

  /**
   * How many of this session's records are `running` — the settlement's whole
   * question, answered without {@link list}'s whole-store scan.
   *
   * Reads the running index (see {@link PROCESS_RUNNING_INDEX_DIR_NAME}) and
   * opens ONLY the records it names, so the cost is the number of processes
   * running app-wide rather than the size of the store. Ownership is decided
   * exactly where `list` decides it: on the `owner` stamped into each record at
   * create.
   *
   * Two answers a marker can give besides "running", and both retire it:
   * - the record is gone (retention pruned it out from under a stale marker);
   * - the record's status is no longer `running` (it was moved by something
   *   other than {@link update} — an older host process, a hand edit).
   *
   * Neither is counted, so a marker leaked by a crash costs one wasted open,
   * once. Any OTHER read failure is rethrown rather than swallowed: `list()` had
   * the same all-or-nothing semantics, the non-Pi settlement deliberately has no
   * catch of its own, and the continuation's catch turns the throw into a
   * skipped dispatch — the fail-closed answer, and the one this read must keep.
   *
   * That applies to the INDEX read itself, not only to the records it names, and
   * it is the reason the `readdir` below has no `catch`. It once had one, and it
   * was measured: on a warm store holding one live `running` record, an
   * unreadable `.running` answered **0** while `list()` still returned that
   * record — `settled: true` over a live process, in the same breath as the
   * paragraph above promising the opposite. Warm is the production shape: once
   * {@link ensureRunningIndex} has resolved, the guard does not re-run, so
   * nothing rebuilds the directory under the reader. Not even `ENOENT` is
   * swallowed here — `ensureRunningIndex` has just promised this directory
   * exists, so its absence is a broken promise rather than an empty answer, and
   * a settlement that skips one attempt costs a wait, while one that guesses
   * zero dispatches an unattended turn. `retention-sweep.ts` records a measured
   * `EMFILE: too many open files, scandir '…/.pi-processes'` on this very
   * directory, so the failing read is not hypothetical here.
   *
   * A file in the index whose name is not handle-shaped is filtered out on every
   * read and never retired, so a stray one stays forever. It is never counted and
   * never opened; sweeping it would mean deleting unrecognised files out of a
   * directory this store shares with nobody's expectations but its own, which is
   * the more expensive mistake.
   *
   * That tolerance stopped being merely defensive at P2.64: an index BUILT BY
   * `ensureRunningIndex` holds exactly one such name,
   * {@link PROCESS_RUNNING_INDEX_SENTINEL_NAME}. Not "the index always holds"
   * it, which this sentence used to claim and which cannot be true: the build
   * returns early when `.running` already exists, so a directory created by the
   * P2.22 code that shipped before the sentinel never acquires one and never
   * will. (Impact ≈ zero rather than zero — P2.22 is not on master, and no
   * rename is attempted against an existing directory — but a categorical claim
   * over an early return is the shape that gets believed later.) The sentence
   * also used to add "and nothing in the app writes such a name", which the
   * sentinel made false. Either way the filter is load-bearing rather than
   * belt-and-braces, and `clearRunning`'s `validateHandle` is what keeps the
   * sentinel from ever being unlinked by a retiring marker.
   */
  async countRunning(sessionKey: SessionKey): Promise<number> {
    return (await this.listRunning(sessionKey)).length
  }

  /**
   * P2.523 — the same walk {@link countRunning} does, RETURNING the records it
   * already opened instead of throwing them away.
   *
   * Everything the docblock above says about `countRunning` applies here
   * unchanged, because this IS `countRunning`: same index read with no catch,
   * same handle-shape filter, same `ENOENT`-only tolerance per record, same
   * `owner` comparison, same retirement of any marker whose record is missing or
   * no longer `running`. `countRunning` is now `.length` over this, so the two
   * can never answer differently — which was the point: a caller rendering an
   * EMPTY process list beside a settlement figure that counted the same
   * session's running processes had two answers to one question, and both could
   * not be true.
   *
   * **This is not `list()` and must not become it.** `list` readdirs and parses
   * every record in the single global `.pi-processes` directory — 897 records at
   * 170–300 ms when P2.22 measured it — which is exactly the read P2.22 removed
   * from the settlement's path. This walks the durable `.running` marker index
   * and opens only the records it names, at the 1.2–1.5 ms P2.22 measured for
   * the count. The extra cost of returning them rather than counting them is the
   * array, and nothing else: no additional `readdir`, no additional `get`, no
   * additional traversal of any kind. That claim is checkable by reading the two
   * methods, which is why the walk lives in ONE of them.
   *
   * Consequently this cannot see a `lost` record — the running index does not
   * hold one — so it answers the settlement's question ("what is running"), not
   * the liveness question (`ProcessSupervisor.countActive`'s
   * `running || lost`). A caller that needs the second still pays for a scan.
   *
   * Returned in reader-pool completion order, NOT sorted: {@link readBounded}
   * walks with a fixed pool, so the order is whatever finishes first. Callers
   * that RENDER these rows sort them themselves, the way
   * `ProcessSupervisor.snapshot` sorts `startedAt` DESC then handle — a second,
   * invisible sort here would just make the two projections harder to compare.
   *
   * D1.339 moved the WALK itself into {@link listRunningRecords}, which answers
   * the same question app-wide; this method is that answer filtered by `owner`.
   * Every paragraph above describes the walk and therefore describes both.
   */
  async listRunning(sessionKey: SessionKey): Promise<StoredProcess[]> {
    const owner = encodeSessionKey(sessionKey)
    return (await this.listRunningRecords()).filter(record => record.owner === owner)
  }

  /**
   * D1.339 — the SAME walk, before the owner filter: every record this store
   * holds that is still `running`, whichever session owns it.
   *
   * The walk lives here and {@link listRunning} is a filter over it, for the
   * reason its docblock already gives about `countRunning`: two readers of one
   * question must not be able to answer differently. Everything said there
   * applies unchanged — the index read with no catch, the handle-shape filter,
   * the `ENOENT`-only tolerance per record, the retirement of any marker whose
   * record is missing or no longer `running`, and the unsorted completion order.
   *
   * It exists because the host's re-adoption pass at startup asks the app-wide
   * question ONCE — "which supervised processes did the previous host process
   * leave running, and whose are they" — where a per-session loop would re-read
   * the same index once per restored session. `owner` is the session key each
   * record was stamped with at create, so the caller distributes by it.
   */
  async listRunningRecords(): Promise<StoredProcess[]> {
    await this.ensureRunningIndex()
    const handles = (await readdir(this.runningIndexRoot))
      .filter(name => PROCESS_HANDLE.test(name))
    const running: StoredProcess[] = []
    await this.readBounded(handles, async handle => {
      const record = await this.get(handle).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return undefined
      })
      if (record?.status === 'running') {
        running.push(record)
        return
      }
      await this.clearRunning(handle)
    })
    return running
  }

  /** Every handle the store holds a record for, in `readdir` order. */
  private async storedHandles(): Promise<string[]> {
    const names = await readdir(this.options.root)
    return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5))
  }

  /**
   * Walk handles with a fixed pool of readers rather than a `Promise.all` over
   * all of them — the T32 fd bound, kept in ONE place now that two readers need
   * it. Rejection semantics are the pool's: the first throw rejects the walk.
   */
  private async readBounded(
    handles: readonly string[],
    read: (handle: string, index: number) => Promise<void>,
  ): Promise<void> {
    let next = 0
    const readNext = async (): Promise<void> => {
      for (let index = next++; index < handles.length; index = next++) {
        await read(handles[index]!, index)
      }
    }
    const readers = Math.min(PROCESS_LIST_READ_CONCURRENCY, handles.length)
    await Promise.all(Array.from({ length: readers }, () => readNext()))
  }

  private get runningIndexRoot(): string { return join(this.options.root, PROCESS_RUNNING_INDEX_DIR_NAME) }

  /**
   * Make sure the running index exists, building it from the records once if it
   * does not.
   *
   * Every install that upgrades into P2.22 has records and no index, and there
   * the empty directory would be a LIE: a record left `running` by a previous
   * host process would become invisible, and the settlement would round it down
   * to idle — the one direction that dispatches an unattended turn over live
   * work. So the missing index is built by a single bounded scan, which is the
   * cost this row removes from the hot path, paid once for the life of the
   * store.
   *
   * Built into a temporary directory and `rename`d into place so no reader ever
   * observes a half-filled index. A concurrent builder that got there first
   * makes the rename fail (`ENOTEMPTY`/`EEXIST`) and this one backs off — its
   * work was the same work.
   *
   * P2.64 — that used to say USUALLY, and named the gap: POSIX `rename` replaces
   * an existing EMPTY directory instead of failing (re-confirmed on this
   * platform), and an index built when nothing is running IS empty, the resting
   * state of this store. So two processes building the index for the first time
   * at the same instant (the app and a `nessy-server` against one config dir)
   * could both succeed, the second replacing the first's directory. The doc
   * recorded it as needing a lock. It needs one FILE:
   * {@link PROCESS_RUNNING_INDEX_SENTINEL_NAME} is written into the temporary
   * directory before the rename, so the winner's index is never empty and the
   * loser always gets `ENOTEMPTY`. The "backs off" sentence above is now
   * unconditional.
   *
   * The doc's account of what that window COST was wrong — REFUTED, not
   * softened — and the corrected version is why the sentinel is still worth its
   * two lines. It said a marker written into the replaced directory "goes with
   * it", i.e. that a live process could be silently uncounted. **It cannot
   * happen, and this repo reasoned from the false version twice (P2.22 and P2.64
   * were both designed against it), so the measurement is recorded here rather
   * than left in a tracker note.**
   *
   * MEASURED, 3000 iterations of the pre-sentinel shape (macOS, this platform,
   * 2026-08-25): builder A renames an EMPTY temp dir onto `.running`, then a
   * marker write and builder B's rename race each other. The outcome is binary
   * and there is no third branch —
   *
   * - 2930/3000 the marker write won: the directory was no longer empty, so B's
   *   rename failed `ENOTEMPTY` and the marker survived;
   * - 70/3000 B's rename won: the marker write failed **`EINVAL`**, loudly, and
   *   the final index was empty.
   *
   * So a marker is never written successfully and then carried away. Either it
   * lands and the racing rename backs off, or the rename lands and the marker
   * write throws — and {@link markRunning} is allowed to throw, from `create`,
   * before the supervisor has spawned anything. The pre-P2.64 store was
   * therefore never fail-open here: what it actually risked was a stale
   * OVERCOUNT (a builder whose scan read a record as `running` before another
   * host retired it replaces a fresher index and reintroduces that marker),
   * which {@link countRunning} retires on sight, plus a visible spawn failure.
   * A wasted open and a silently discarded directory, not an unattended turn.
   *
   * Positive control on the same rig, 3000 more iterations WITH the sentinel:
   * 3000/3000 `ENOTEMPTY` for the loser and 3000/3000 marker writes succeeded,
   * so the zero above is a measurement and not a rig that cannot see failures.
   * That is also what makes "backs off on `ENOTEMPTY`" unconditional and what
   * stops a rebuild triggered by the probe below from landing on a live index.
   *
   * The EXISTENCE PROBE gets the same discipline, and it is the same fault as
   * the predicate above: `readdir(…).then(() => true, () => false)` read EVERY
   * failure as "no index exists". So a transient `EMFILE` on the probe answered
   * a question nobody had asked and sent a single process into a full rebuild
   * over a live index — responding to "too many open files" by opening every
   * record in the store, which is exactly the scan this row exists to avoid, at
   * exactly the moment the host cannot afford it. Not theoretical on this
   * directory: `retention-sweep.ts` records a measured `EMFILE: too many open
   * files, scandir '…/.pi-processes'`, and Electron does not inherit the shell's
   * `ulimit -n` (soft floor 256 here), so fd-hungry paths fail inside the app
   * while every shell probe succeeds. Only `ENOENT` is a negative answer now;
   * anything else propagates before a single record is opened, clears the
   * memoised guard below, and costs the caller one skipped attempt.
   *
   * A record that will not parse is SKIPPED rather than failing the build,
   * deliberately unlike `list()`. A corrupt record can name neither its status
   * nor its owner, so it cannot be counted for anybody; failing here instead
   * would make it permanent, and would break the settlement for every session
   * rather than for none.
   *
   * A record whose READ FAILED is not that, and is not skipped. It names nothing
   * either way — an `EMFILE`/`EIO`/`EACCES` says the store could not be asked,
   * not that the record is idle — and this is the one scan that ever runs, in
   * exactly the upgrade scenario the backfill exists for. MEASURED: a 40-record
   * legacy store with 6 `running` and one read made to fail mid-scan built a
   * half-index, renamed it into place, and reported 5 from every later call,
   * fresh instances included. So the failure is rethrown, the temporary
   * directory goes away with it, and the memoised guard is cleared — the next
   * call rebuilds instead of inheriting a count that is short forever.
   */
  private async ensureRunningIndex(): Promise<void> {
    const ready = this.runningIndexReady ??= (async () => {
      await this.ensureRoot()
      const present = await readdir(this.runningIndexRoot).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return false
        throw error
      })
      if (present) return
      const temporary = `${this.runningIndexRoot}.${randomUUID()}.tmp`
      await mkdir(temporary, { recursive: true, mode: 0o700 })
      try {
        await this.readBounded(await this.storedHandles(), async handle => {
          const record = await this.get(handle).catch((error: unknown) => {
            if (isFilesystemReadFailure(error)) throw error
            return undefined
          })
          if (record?.status !== 'running') return
          await writeFile(join(temporary, handle), new Uint8Array(), { mode: 0o600 })
        })
        // Never rename an EMPTY directory into place: see the sentinel's own doc.
        await writeFile(join(temporary, PROCESS_RUNNING_INDEX_SENTINEL_NAME), new Uint8Array(), { mode: 0o600 })
        await rename(temporary, this.runningIndexRoot)
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      }
    })()
    try {
      await ready
    } catch (error) {
      if (this.runningIndexReady === ready) this.runningIndexReady = undefined
      throw error
    }
  }

  private async markRunning(handle: string): Promise<void> {
    this.validateHandle(handle)
    await this.ensureRunningIndex()
    await writeFile(join(this.runningIndexRoot, handle), new Uint8Array(), { mode: 0o600 })
  }

  /**
   * Retire one marker. THE UNLINK is best-effort on purpose, and asymmetric with
   * {@link markRunning}, because the two failures are not the same failure.
   *
   * A marker that fails to appear undercounts a live process — fail-open — so
   * `markRunning` is allowed to throw, and it does so from `create`, where the
   * supervisor has not spawned anything yet. A marker that fails to disappear
   * only overcounts, and the reader retires it on sight, so throwing there would
   * add a brand-new way for a child's ordinary `close` handler to fail in
   * exchange for nothing.
   *
   * "Best-effort" scopes to the `unlink` and NOT to the method: `validateHandle`
   * throws on a bad handle, and the awaited {@link ensureRunningIndex} is
   * deliberately UNCAUGHT — since P2.64 its existence probe rethrows everything
   * but `ENOENT`, so a cold instance whose first touch of `.running` hits
   * `EMFILE`/`ENOTDIR`/`ELOOP` now fails here too. That is a new throw class on
   * this path, in the safe direction (the caller learns the store could not be
   * asked, instead of a marker quietly staying behind), but the docstring said
   * "best-effort" flatly and a caller reading only the first line would size its
   * error handling wrong.
   */
  private async clearRunning(handle: string): Promise<void> {
    this.validateHandle(handle)
    await this.ensureRunningIndex()
    await unlink(join(this.runningIndexRoot, handle)).catch(() => undefined)
  }

  private recordPath(handle: string): string { this.validateHandle(handle); return join(this.options.root, `${handle}.json`) }
  private logPath(handle: string): string { this.validateHandle(handle); return join(this.options.root, `${handle}.log`) }

  /** Absolute path of the log file for one handle — the R10 output-file handle. */
  outputFilePath(handle: string): string { return this.logPath(handle) }

  private validateHandle(handle: string): void {
    if (!PROCESS_HANDLE.test(handle)) throw new Error(INVALID_PROCESS_HANDLE)
  }

  private async write(record: StoredProcess): Promise<void> {
    await this.ensureRoot()
    const target = this.recordPath(record.handle)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await rename(temporary, target)
  }
}
