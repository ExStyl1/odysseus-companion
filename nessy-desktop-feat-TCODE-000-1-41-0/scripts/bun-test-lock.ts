/**
 * A mutex for `bun test`, because two concurrent runs in this repo manufacture
 * failures through module-scope env mutation (AGENTS.md). A manufactured
 * failure is the worst available outcome for a verification harness: during a
 * mutation campaign or a re-break it marks a SURVIVING mutant as killed, so the
 * corrupt result looks better than the truth.
 *
 * The protocol this replaces was prose handed to each agent — a bare
 * `mkdir /tmp/nessy-bun-test.lock` with no ownership and no liveness. It failed
 * twice, in ways this file exists to make impossible:
 *
 *   1. A lane built a reaper shaped like
 *      `if ! pgrep "bun test"; then rmdir <lock>; fi` and DELETED A LOCK WHILE
 *      ITS HOLDER WAS USING IT. Here a holder is reapable only once its lease
 *      has gone cold; a warm lock is refused, loudly, with the holder's label.
 *   2. A corrected instruction said "after a successful mkdir, write your PID"
 *      without forbidding `-p`. `mkdir -p` SUCCEEDS ON AN EXISTING DIRECTORY,
 *      so a second lane stamped its owner file inside a lock the first held and
 *      both believed they owned it. Here the directory is created with a bare
 *      `mkdirSync` (never `recursive`), and the owner file is written with the
 *      `wx` flag so a second stamp fails instead of clobbering.
 *
 * Two design constraints, both learned by measurement:
 *
 *   * A DEAD PID DOES NOT MEAN A DEAD HOLDER, AND MAY NEVER AUTHORISE A REAP.
 *     Measured twice on 2026-08-25: `owner=agent-p2158-p2159 pid=37225` with
 *     `ps -p 37225` dead — and the agent that wrote it still working, because
 *     every tool call runs in a fresh shell and the recorded PID is routinely
 *     dead within seconds. So the liveness signal is the HEARTBEAT the holder
 *     refreshes while it works, and the PID is recorded only as corroboration:
 *       - heartbeat fresh                  -> held, never reapable, whatever ps says
 *       - heartbeat cold + PID gone        -> reapable (the case where six lanes
 *                                             died at once and every holder was
 *                                             genuinely gone)
 *       - heartbeat cold + PID still alive -> BLOCKED, not reaped: the PID may
 *                                             only ever withhold a reap, never
 *                                             grant one
 *       - heartbeat cold + PID unknown     -> reapable on the heartbeat alone
 *     Every refusal says so in words, with the time of the last heartbeat, so
 *     the next reader is not tempted to override it by hand — two of the day's
 *     near-misses were a human and an agent reasoning ABOUT a lock instead of
 *     asking it.
 *   * A LIVENESS CHECK THAT INVENTS ITS SUBJECTS ALWAYS REPORTS THE LOCK FREE.
 *     Grepping `[0-9]{3,6}` out of an owner file once returned `2026` (the year
 *     in a timestamp) and `588` (a fragment of a session id), and both were
 *     dutifully reported dead. So the owner file is a strict `key=value` record
 *     and an unparsable one is NEVER reported free — it is reported blocked,
 *     which is a state a lane must escalate rather than resolve.
 *
 * Arrival order (F1.474). Measured 2026-09-24 (WJ-pp-a P-3): a lane waited out
 * the default 1 800 s while six others took the lock, because every waiter
 * polled a bare `mkdir` every two seconds and the lock went to whichever poll
 * landed first after a release. A waiter now takes a ticket in a queue BESIDE
 * the lock and only the oldest live ticket tries the lock — see `joinQueue`,
 * which also says why a process still running the previous copy of this file
 * interoperates with it.
 *
 * Safety. An agent in this repo destroyed unrecoverable data by handing a real
 * home directory to a destructive verb, and a lock helper is exactly the kind
 * of code that ends up calling `rm -rf` on a path it computed. Removal here is
 * structurally confined:
 *
 *   * the caller never supplies a path — only a NAME, matched against
 *     `LOCK_NAME_PATTERN`, joined under a root that must resolve inside a
 *     system temp directory;
 *   * before any removal the target is RE-DERIVED from (name, root) and
 *     compared to the path being removed;
 *   * before any removal the target is also RE-IDENTIFIED from its owner file,
 *     so a lock re-acquired between a caller's decision and its action is
 *     refused instead of deleted — see `removeLockDirectory` (P2.237);
 *   * only two fixed filenames are ever unlinked inside a lock, and the directory
 *     itself goes with `rmdirSync`, which REFUSES a non-empty directory. There
 *     is no recursive delete in this file, so an unexpected file inside a lock
 *     blocks its removal instead of being destroyed with it. The queue beside
 *     the lock is never removed; only its `TICKET_NAME_PATTERN` entries are.
 *
 * Usage — prefer `run`, which cannot forget to release:
 *
 *   bun scripts/bun-test-lock.ts run --label my-lane -- bun test
 *   bun scripts/bun-test-lock.ts status
 *   bun scripts/bun-test-lock.ts acquire --label my-lane      # prints a token
 *   bun scripts/bun-test-lock.ts release --label my-lane --token <token>
 *
 * `status` reports a warm holder rather than clearing it. If a lock never
 * clears, report the blockage — that is the whole point of the row this file
 * closes.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, rmdirSync, statSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { CONTAMINATING_ENV_NAMES } from './cdp/lib/app-env.ts'

// ---------------------------------------------------------------------------
// Fixed vocabulary. Everything removable is named here and nowhere else.
// ---------------------------------------------------------------------------

/** The lock the prose protocol used, kept byte-identical so a lane still following it interoperates. */
export const DEFAULT_LOCK_NAME = 'nessy-bun-test.lock'

/**
 * `/tmp` rather than `os.tmpdir()`: on macOS `tmpdir()` is a per-user
 * `/var/folders/...` path, and the lock every lane has been taking is literally
 * `/tmp/nessy-bun-test.lock`. Windows has no `/tmp`, so it falls back.
 */
export const DEFAULT_LOCK_ROOT = process.platform === 'win32' ? tmpdir() : '/tmp'

/** No separators, no dots, no absolute paths — a name cannot describe a location. */
export const LOCK_NAME_PATTERN = /^nessy-bun-test[a-z0-9-]*\.lock$/

/** The only files this module will ever unlink inside a lock (a queue loses only `TICKET_NAME_PATTERN` entries). */
export const REMOVABLE_ENTRIES = ['owner', 'heartbeat'] as const

/**
 * Default lease for a manual `acquire`: minutes, not the lifetime of a process.
 * Long enough for an agent to think between tool calls, short enough that a
 * lane which died without releasing does not wedge the repo for half an hour.
 * `refresh` extends it; the acquire output prints the exact command.
 */
export const DEFAULT_LEASE_SECONDS = 600

/** `run` refreshes every 5s, so a lease this short makes a crashed run reapable within a minute. */
export const RUN_LEASE_SECONDS = 60
export const RUN_REFRESH_MS = 5_000

/**
 * F1.556 — how long `run` queues before it gives up when no `--wait` is given.
 * Measured 2026-09-24 (WJ-ay): with 10–18 lanes queued, the previous 1 800 s
 * ran out before a lane's turn came, twice in one lane. `acquire` keeps its own
 * default of 0: it is a try, not a run.
 */
export const DEFAULT_RUN_WAIT_SECONDS = 7_200

/**
 * F1.556 — what `run` prints when it gives up, on stderr AND stdout, after the
 * `not acquired` line it always printed (kept first, byte for byte). A run that
 * gave up exits 3 having run NOTHING; before this banner the only trace was
 * that one stderr line, so a background log read by its tail, or a capture of
 * stdout alone, looked like a run that had finished. The first and the last
 * line are the same sentence, so the head and the tail of a log both say it.
 */
export function describeRunGiveUp(options: {
  label: string
  reason: string
  waitSeconds: number
  waitedMs: number
  command: readonly string[]
}): string {
  const edge = '======== bun-test-lock: NOT ACQUIRED — THE COMMAND DID NOT RUN (exit 3) ========'
  return [
    edge,
    `  label:   ${options.label}`,
    `  queued:  ${Math.round(options.waitedMs / 1_000)} s of --wait ${options.waitSeconds} (run's default is ${DEFAULT_RUN_WAIT_SECONDS})`,
    `  reason:  ${options.reason}`,
    `  command: ${options.command.join(' ')}`,
    '  Nothing was tested and this run has no result to read. Run it again.',
    edge,
    '',
  ].join('\n')
}

const OWNER_KEY_PATTERN = /^[a-z_]+$/

/**
 * A pid is read from a NAMED key of a strict record, never mined out of free
 * text — and 0, 1 and negatives are not lock holders on any platform this runs
 * on, so they are not pids at all. ONE believability rule: a value this pattern
 * rejects is `undefined` everywhere downstream, so it can neither authorise a
 * reap by looking dead nor veto one by looking alive.
 */
const PID_PATTERN = /^([2-9]|[1-9][0-9]+)$/

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LockLocation = { name?: string; root?: string }

export type LockHolder = {
  label: string
  token: string
  session: string | undefined
  acquiredAt: string
  leaseSeconds: number
  /** Undefined when the record carries no pid, or one this module refuses to believe. */
  pid: number | undefined
}

export type LockHandle = {
  name: string
  root: string
  dir: string
  label: string
  token: string
  leaseSeconds: number
}

export type ExpiredReason = 'heartbeat-cold-and-pid-gone' | 'heartbeat-cold-pid-unknown'

export type LockStatus =
  | { state: 'free'; dir: string }
  | {
      state: 'held'
      dir: string
      holder: LockHolder
      expiresAtMs: number
      msRemaining: number
      refreshedAt: string | undefined
    }
  | {
      state: 'expired'
      dir: string
      holder: LockHolder | undefined
      expiredForMs: number
      refreshedAt: string | undefined
      reason: ExpiredReason
    }
  | { state: 'blocked'; dir: string; reason: string }

export type AcquireResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; status: LockStatus; reason: string }

// ---------------------------------------------------------------------------
// Path derivation — the only place a lock path is ever produced
// ---------------------------------------------------------------------------

function allowedRoots(): string[] {
  const candidates = [DEFAULT_LOCK_ROOT, tmpdir()]
  const resolved: string[] = []
  for (const candidate of candidates) {
    try {
      resolved.push(realpathSync(candidate))
    } catch {
      // A temp root that does not exist cannot contain a lock; skip it.
    }
  }
  return resolved
}

/**
 * Validates a root and returns its real path. A root must already exist — this
 * module never creates parent directories, because "create the parents" is
 * exactly the `-p` that let two lanes believe they owned one lock.
 */
export function resolveLockRoot(root: string = DEFAULT_LOCK_ROOT): string {
  if (root.length === 0) throw new Error('bun-test-lock: lock root must not be empty')
  if (!isAbsolute(root)) throw new Error(`bun-test-lock: lock root must be absolute, got ${JSON.stringify(root)}`)

  let real: string
  try {
    real = realpathSync(root)
  } catch {
    throw new Error(`bun-test-lock: lock root does not exist: ${root}`)
  }
  if (!statSync(real).isDirectory()) throw new Error(`bun-test-lock: lock root is not a directory: ${root}`)

  const permitted = allowedRoots()
  const inside = permitted.some((base) => real === base || real.startsWith(`${base}/`))
  if (!inside) {
    throw new Error(
      `bun-test-lock: refusing a lock root outside a system temp directory: ${real} ` +
        `(permitted: ${permitted.join(', ') || 'none resolvable'})`,
    )
  }
  return real
}

export function assertLockName(name: string): string {
  if (!LOCK_NAME_PATTERN.test(name)) {
    throw new Error(
      `bun-test-lock: refusing lock name ${JSON.stringify(name)} — must match ${String(LOCK_NAME_PATTERN)}`,
    )
  }
  return name
}

/** The single source of a lock's path. Both arguments are validated; nothing else derives a path. */
export function lockDirFor(location: LockLocation = {}): { dir: string; name: string; root: string } {
  const name = assertLockName(location.name ?? DEFAULT_LOCK_NAME)
  const root = resolveLockRoot(location.root ?? DEFAULT_LOCK_ROOT)
  return { dir: join(root, name), name, root }
}

// ---------------------------------------------------------------------------
// The owner record: strict parsing, so nothing is ever inferred from free text
// ---------------------------------------------------------------------------

/**
 * Returns undefined for anything that is not exactly `key=value` lines with
 * lowercase keys. A free-text owner file is malformed, not an invitation to
 * guess: the previous liveness check read a year and a session-id fragment as
 * process ids and called both dead.
 */
export function parseKeyValueRecord(text: string): Map<string, string> | undefined {
  const record = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const separator = line.indexOf('=')
    if (separator <= 0) return undefined
    const key = line.slice(0, separator)
    if (!OWNER_KEY_PATTERN.test(key)) return undefined
    if (record.has(key)) return undefined
    record.set(key, line.slice(separator + 1))
  }
  return record
}

function formatKeyValueRecord(entries: Array<[string, string]>): string {
  for (const [key, value] of entries) {
    if (!OWNER_KEY_PATTERN.test(key)) throw new Error(`bun-test-lock: illegal owner key ${JSON.stringify(key)}`)
    if (value.includes('\n')) throw new Error(`bun-test-lock: owner value for ${key} must be single-line`)
  }
  return `${entries.map(([key, value]) => `${key}=${value}`).join('\n')}\n`
}

function readRecord(path: string): Map<string, string> | undefined | 'missing' {
  let text: string
  try {
    text = readFileSync(path, 'utf-8')
  } catch {
    return 'missing'
  }
  return parseKeyValueRecord(text)
}

function parseHolder(record: Map<string, string>): LockHolder | undefined {
  const label = record.get('label')
  const token = record.get('token')
  const acquiredAt = record.get('acquired_at')
  const leaseRaw = record.get('lease_seconds')
  if (!label || !token || !acquiredAt || !leaseRaw) return undefined
  const leaseSeconds = Number(leaseRaw)
  if (!Number.isFinite(leaseSeconds)) return undefined
  const pidRaw = record.get('pid')
  // A pid that is absent, zero, negative or not a plain number is UNKNOWN, and
  // unknown is never treated as dead.
  const pid = pidRaw !== undefined && PID_PATTERN.test(pidRaw) ? Number(pidRaw) : undefined
  return {
    label,
    token,
    session: record.get('session'),
    acquiredAt,
    leaseSeconds,
    pid,
  }
}

/**
 * ESRCH is the ONLY answer that means dead. EPERM means a live process this user
 * may not signal, and any other outcome is unknown — both are treated as alive,
 * because the expensive mistake is reaping a lock somebody is using.
 *
 * Split out from `isProcessProvablyDead` so this branch can be exercised
 * directly: on a host where every probe either succeeds or returns ESRCH, a
 * test that goes through `process.kill` cannot reach the EPERM case at all, and
 * a mutation that returns `true` for every probe failure survives it.
 */
export function probeErrorMeansDead(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ESRCH'
}

export function isProcessProvablyDead(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return probeErrorMeansDead(error)
  }
}

// ---------------------------------------------------------------------------
// Inspection — an unknown lock is blocked, never free
// ---------------------------------------------------------------------------

export function inspectLock(location: LockLocation = {}, now: number = Date.now()): LockStatus {
  const { dir } = lockDirFor(location)

  let dirStat: ReturnType<typeof statSync>
  try {
    dirStat = statSync(dir)
  } catch {
    return { state: 'free', dir }
  }
  if (!dirStat.isDirectory()) {
    return { state: 'blocked', dir, reason: `${dir} exists and is not a directory` }
  }

  const ownerRecord = readRecord(join(dir, 'owner'))
  if (ownerRecord === undefined) {
    return {
      state: 'blocked',
      dir,
      reason: `${join(dir, 'owner')} is not a key=value record — report the blockage rather than reaping it`,
    }
  }
  const holder = ownerRecord === 'missing' ? undefined : parseHolder(ownerRecord)
  if (ownerRecord !== 'missing' && holder === undefined) {
    return {
      state: 'blocked',
      dir,
      reason: `${join(dir, 'owner')} parses but names no label/token/lease — report the blockage rather than reaping it`,
    }
  }

  const heartbeat = readHeartbeat(dir, holder, dirStat.mtimeMs)
  if (heartbeat === undefined) {
    return {
      state: 'blocked',
      dir,
      reason: `${join(dir, 'heartbeat')} is not a key=value record — report the blockage rather than reaping it`,
    }
  }
  const expiresAtMs = heartbeat.expiresAtMs

  if (now < expiresAtMs) {
    // FRESH HEARTBEAT ENDS THE ENQUIRY. A dead recorded pid does not reopen it:
    // in this harness the pid recorded at acquisition is dead within seconds
    // while the lane that wrote it keeps working.
    if (holder === undefined) {
      // A directory with no owner file yet: a lane is mid-acquire. Warm, so not
      // reapable, but there is nobody to name.
      return { state: 'blocked', dir, reason: `${dir} exists with no owner file and its grace period is still warm` }
    }
    return { state: 'held', dir, holder, expiresAtMs, msRemaining: expiresAtMs - now, refreshedAt: heartbeat.refreshedAt }
  }

  // Heartbeat cold. The pid may only WITHHOLD a reap from here, never grant one.
  if (holder?.pid !== undefined && !isProcessProvablyDead(holder.pid)) {
    return {
      state: 'blocked',
      dir,
      reason:
        `heartbeat cold for ${Math.round((now - expiresAtMs) / 1000)}s (last refreshed ${heartbeat.refreshedAt ?? 'never'}), ` +
        `but the recorded pid ${String(holder.pid)} of holder ${holder.label} is still running — not reaping; ` +
        'investigate, or ask the holder to release',
    }
  }

  return {
    state: 'expired',
    dir,
    holder,
    expiredForMs: now - expiresAtMs,
    refreshedAt: heartbeat.refreshedAt,
    reason: holder?.pid === undefined ? 'heartbeat-cold-pid-unknown' : 'heartbeat-cold-and-pid-gone',
  }
}

/**
 * The lease deadline. Falls back to the lock DIRECTORY's mtime plus the default
 * lease when there is no heartbeat yet, so a lane that died between `mkdir` and
 * its first write cannot wedge the lock forever — bounded, and never "free".
 */
function readHeartbeat(
  dir: string,
  holder: LockHolder | undefined,
  dirMtimeMs: number,
): { expiresAtMs: number; refreshedAt: string | undefined } | undefined {
  const heartbeat = readRecord(join(dir, 'heartbeat'))
  if (heartbeat === undefined) return undefined
  if (heartbeat !== 'missing') {
    const raw = heartbeat.get('expires_at_ms')
    const parsed = raw === undefined ? Number.NaN : Number(raw)
    if (Number.isFinite(parsed)) return { expiresAtMs: parsed, refreshedAt: heartbeat.get('refreshed_at') }
  }
  const graceSeconds = holder?.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  return { expiresAtMs: dirMtimeMs + graceSeconds * 1_000, refreshedAt: undefined }
}

// ---------------------------------------------------------------------------
// Removal — confined by re-derivation, fixed filenames, and a non-recursive rmdir
// ---------------------------------------------------------------------------

/**
 * What a removal actually did. Three outcomes because a removal decided against
 * a snapshot has three honest endings, and collapsing them is how a lost race
 * gets reported as work done.
 */
export type RemovalOutcome =
  /** This call removed the lock it had inspected. */
  | 'removed'
  /** Somebody else removed it first. Benign: the caller retries. */
  | 'already-gone'
  /** It was re-acquired between the decision and this call, so nothing was touched. */
  | 'not-ours-any-more'

/**
 * MEASURED (P2.237, found reviewing P2.59). A lane waiting behind another died
 * with `bun-test-lock: ENOENT: no such file or directory, rmdir
 * '/private/tmp/nessy-bun-test.lock'`. Every lane of a parallel run polls this
 * one lock every two seconds, so when a lease goes cold they all see `expired`
 * in the same instant and all reap it: the winner's `rmdirSync` removes the
 * directory and every loser's lands on a path that is already gone. A plain retry succeeded, which
 * is the signature of a race and not of a wedge. The cost was misattribution —
 * a crash while QUEUEING reads, to a human and to an agent writing a report, as
 * a test failure.
 *
 * That crash was the harmless half. Had the winner been microseconds faster it
 * would have re-created and stamped the lock before the loser acted, and the
 * loser would have deleted a WARM lock belonging to a lane already running
 * `bun test` — defect 1 at the top of this file, arriving through the back door.
 * So a removal now re-identifies its subject from disk immediately before
 * acting, and tolerates exactly one failure: the subject being gone already.
 *
 * Exported for the reason `probeErrorMeansDead` is: neither race branch can be
 * reached on demand through `acquireLock` or `reapExpiredLock`, and forcing the
 * interleaving would mean racing two real `bun test` runs — the thing this file
 * exists to prevent. Being public changes none of its confinement: the path is
 * re-derived from (name, root), only `REMOVABLE_ENTRIES` are ever unlinked, and
 * the directory goes with a non-recursive `rmdirSync`.
 *
 * `expectedToken` is the owner token the caller READ when it decided to remove
 * this lock, or undefined for a lock that carried no owner file. Required, not
 * optional: a caller that cannot say what it inspected has no business removing
 * anything.
 */
export function removeLockDirectory(
  location: LockLocation,
  dir: string,
  expectedToken: string | undefined,
): RemovalOutcome {
  const derived = lockDirFor(location)
  if (derived.dir !== dir) {
    throw new Error(`bun-test-lock: refusing to remove ${dir} — does not re-derive from its own name and root`)
  }

  // Re-identification, not a courtesy: the decision to remove was taken against
  // a snapshot, and a snapshot is not the filesystem. A MISSING owner file is
  // the one benign disagreement — the lock is being released right now, or its
  // acquirer has not stamped it yet — and neither can strand a holder, because a
  // `wx` stamp into a removed directory fails instead of succeeding.
  const record = readRecord(join(dir, 'owner'))
  if (record !== 'missing') {
    const holder = record === undefined ? undefined : parseHolder(record)
    if (holder?.token !== expectedToken) return 'not-ours-any-more'
  }

  for (const entry of REMOVABLE_ENTRIES) {
    try {
      unlinkSync(join(dir, entry))
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') throw error
    }
  }
  // Non-recursive on purpose: an unexpected file inside the lock must block
  // removal (ENOTEMPTY) rather than be destroyed along with it.
  try {
    rmdirSync(dir)
  } catch (error) {
    const code = (error as { code?: string }).code
    // ENOENT AND NOTHING ELSE. "What I was about to remove is already gone" is
    // the benign end of the race above and the caller simply retries. Every
    // other code — ENOTEMPTY, ENOTDIR, EACCES, EPERM, EBUSY — says this process
    // cannot manipulate the lock, and a mutex that swallows those turns a wedged
    // lock into an invisible one: strictly worse than a crash, which is at least
    // legible.
    if (code !== 'ENOENT') throw error
    return 'already-gone'
  }
  return 'removed'
}

// ---------------------------------------------------------------------------
// Acquire / refresh / release / reap
// ---------------------------------------------------------------------------

function newToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

export function acquireLock(options: LockLocation & {
  label: string
  session?: string
  leaseSeconds?: number
  reapExpired?: boolean
  now?: number
}): AcquireResult {
  const { dir, name, root } = lockDirFor(options)
  if (options.label.length === 0 || options.label.includes('\n')) {
    throw new Error('bun-test-lock: label must be a non-empty single line')
  }
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error(`bun-test-lock: lease must be a positive number of seconds, got ${String(leaseSeconds)}`)
  }
  const now = options.now ?? Date.now()

  try {
    // Bare mkdir. NEVER `{ recursive: true }` — that is the `mkdir -p` which
    // succeeds on an existing directory and let two lanes stamp one lock.
    mkdirSync(dir)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'EEXIST') throw error
    const status = inspectLock({ name, root }, now)
    if (status.state === 'expired' && (options.reapExpired ?? true)) {
      if (removeLockDirectory({ name, root }, dir, status.holder?.token) === 'not-ours-any-more') {
        // Another waiter reaped this cold lock and took it over first. A lost
        // race is a normal outcome of nine lanes polling one lock, not a fault,
        // so answer with what is there now and let the wait loop try again —
        // crashing here is what made a queued run look like a failed one.
        const taken = inspectLock({ name, root }, now)
        return { ok: false, status: taken, reason: describeStatus(taken) }
      }
      return acquireLock({ ...options, root, name, now, reapExpired: false })
    }
    return { ok: false, status, reason: describeStatus(status) }
  }

  const token = newToken()
  const owner: Array<[string, string]> = [
    ['label', options.label],
    ['token', token],
    ['acquired_at', new Date(now).toISOString()],
    ['lease_seconds', String(leaseSeconds)],
    // Corroboration only, for `inspectLock` and for a human reading the file:
    // a dead pid can strengthen a cold heartbeat, and a live one can veto a
    // reap, but a pid never authorises one.
    ['pid', String(process.pid)],
  ]
  if (options.session) owner.push(['session', options.session])

  try {
    // `wx`: if an owner file somehow already exists, fail rather than clobber
    // it. This is the second half of the `mkdir -p` defect — the historical bug
    // was a lane stamping its identity over a live holder's.
    writeFileSync(join(dir, 'owner'), formatKeyValueRecord(owner), { flag: 'wx' })
  } catch (error) {
    const status = inspectLock({ name, root }, now)
    return {
      ok: false,
      status,
      reason: `created ${dir} but could not stamp ownership (${String((error as Error).message)}) — not removing a lock this process cannot prove it owns`,
    }
  }

  const handle: LockHandle = { name, root, dir, label: options.label, token, leaseSeconds }
  writeExpiry(handle, now)
  return { ok: true, handle }
}

function writeExpiry(handle: LockHandle, now: number): void {
  writeFileSync(
    join(handle.dir, 'heartbeat'),
    formatKeyValueRecord([
      ['refreshed_at', new Date(now).toISOString()],
      ['expires_at_ms', String(now + handle.leaseSeconds * 1_000)],
    ]),
  )
}

function assertStillOurs(handle: LockHandle, action: string): void {
  const derived = lockDirFor({ name: handle.name, root: handle.root })
  if (derived.dir !== handle.dir) {
    throw new Error(`bun-test-lock: refusing to ${action} ${handle.dir} — handle does not re-derive from its name and root`)
  }
  const record = readRecord(join(handle.dir, 'owner'))
  if (record === 'missing') throw new Error(`bun-test-lock: refusing to ${action} — ${handle.dir}/owner is gone`)
  if (record === undefined) throw new Error(`bun-test-lock: refusing to ${action} — ${handle.dir}/owner is unparsable`)
  const holder = parseHolder(record)
  if (!holder) throw new Error(`bun-test-lock: refusing to ${action} — ${handle.dir}/owner names no holder`)
  if (holder.token !== handle.token || holder.label !== handle.label) {
    throw new Error(
      `bun-test-lock: refusing to ${action} — ${handle.dir} is owned by ${holder.label}, not ${handle.label}. ` +
        'Never remove a lock you did not create.',
    )
  }
}

export function refreshLock(handle: LockHandle, now: number = Date.now()): void {
  assertStillOurs(handle, 'refresh')
  writeExpiry(handle, now)
}

export function releaseLock(handle: LockHandle): void {
  assertStillOurs(handle, 'release')
  const outcome = removeLockDirectory({ name: handle.name, root: handle.root }, handle.dir, handle.token)
  if (outcome === 'not-ours-any-more') {
    // `assertStillOurs` read our own token a moment ago, so arriving here means
    // the lock was reaped and re-acquired mid-release: somebody may be running
    // `bun test` alongside us right now. Loud, always. (`already-gone` is not
    // loud: the lock is gone, which is what a release wanted.)
    throw new Error(
      `bun-test-lock: released nothing — ${handle.dir} was taken over by another lane while ${handle.label} was releasing it`,
    )
  }
}

/**
 * Removes a lock whose lease has gone cold. Refuses every other state: a warm
 * holder is not reapable (the original defect), and a blocked lock is for a
 * human to look at.
 */
export function reapExpiredLock(location: LockLocation = {}, now: number = Date.now()): LockStatus {
  const status = inspectLock(location, now)
  if (status.state !== 'expired') return status
  // A lock re-acquired while this reap was deciding was NOT reaped, and
  // returning the stale snapshot would report somebody else's live lock as one
  // this call cleared. Re-read and answer with what is actually there.
  if (removeLockDirectory(location, status.dir, status.holder?.token) === 'not-ours-any-more') {
    return inspectLock(location, now)
  }
  return status
}

export function describeStatus(status: LockStatus): string {
  switch (status.state) {
    case 'free':
      return `free (${status.dir})`
    case 'held':
      return (
        `held by ${status.holder.label}${status.holder.session ? ` (session ${status.holder.session})` : ''} ` +
        `since ${status.holder.acquiredAt}; heartbeat fresh at ${status.refreshedAt ?? 'unknown'}, ` +
        `good for another ${Math.round(status.msRemaining / 1000)}s — NOT reaping` +
        (status.holder.pid !== undefined && isProcessProvablyDead(status.holder.pid)
          ? ` (recorded pid ${String(status.holder.pid)} is gone, which proves nothing here: a fresh heartbeat outranks it)`
          : '')
      )
    case 'expired':
      return (
        `heartbeat cold for ${Math.round(status.expiredForMs / 1000)}s ` +
        `(last refreshed ${status.refreshedAt ?? 'never'})` +
        (status.holder ? `, last holder ${status.holder.label}` : '') +
        (status.reason === 'heartbeat-cold-and-pid-gone'
          ? ` and its recorded pid ${String(status.holder?.pid)} is gone — reapable`
          : ' and it recorded no usable pid — reapable on the cold heartbeat alone')
      )
    case 'blocked':
      return `blocked, NOT reaping: ${status.reason}`
  }
}

// ---------------------------------------------------------------------------
// Arrival order (F1.474) — one ticket per waiter, in a queue BESIDE the lock
// ---------------------------------------------------------------------------

/** The queue directory is `<lock name>` plus this; it never matches `LOCK_NAME_PATTERN`. */
export const QUEUE_SUFFIX = '.queue'

/** The only entries of a queue directory this module reads or will ever unlink. */
export const TICKET_NAME_PATTERN = /^[0-9a-f]{32}\.ticket$/

/** A waiter refreshes its ticket every poll; one this stale belongs to a waiter that stopped. */
export const TICKET_LEASE_SECONDS = 60

/**
 * Every waiter polls at the cadence the loop always had, the head included. A
 * faster head would take a release sooner, but a waiter still running the
 * previous copy — which has no ticket and polls every two seconds — would then
 * lose almost every race to it; at one cadence it keeps the even chance it had.
 */
export const WAIT_POLL_MS = 2_000

export type QueueTicket = {
  label: string
  token: string
  /** Undefined when the ticket carries no pid, or one this module refuses to believe. */
  pid: number | undefined
  arrivedAtMs: number
  arrivedAt: string
}

export type TicketHandle = {
  name: string
  root: string
  queueDir: string
  file: string
  label: string
  token: string
  arrivedAtMs: number
  /** The ticket's exact bytes, kept so a ticket cleared while its waiter stalled goes back unchanged. */
  text: string
}

export type QueueReading = {
  dir: string
  /** Live tickets, in the order they will be served: arrival time, then token. */
  waiting: QueueTicket[]
  /** Tickets skipped as stale (cold, or their waiter is gone); cleared only when the reader was asked to. */
  stale: number
  /** Warm tickets that do not parse: skipped, never trusted, never removed while warm. */
  unreadable: number
}

/** The single source of a queue's path: the validated lock location plus a fixed suffix. */
export function queueDirFor(location: LockLocation = {}): { dir: string; name: string; root: string } {
  const { name, root } = lockDirFor(location)
  return { dir: join(root, `${name}${QUEUE_SUFFIX}`), name, root }
}

function servedBefore(left: { arrivedAtMs: number; token: string }, right: { arrivedAtMs: number; token: string }): boolean {
  if (left.arrivedAtMs !== right.arrivedAtMs) return left.arrivedAtMs < right.arrivedAtMs
  return left.token < right.token
}

type TicketVerdict =
  | { state: 'live'; ticket: QueueTicket }
  | { state: 'stale' }
  | { state: 'unreadable' }
  | { state: 'gone' }

function judgeTicket(dir: string, entry: string, now: number): TicketVerdict {
  const file = join(dir, entry)
  let mtimeMs: number
  let text: string
  try {
    mtimeMs = statSync(file).mtimeMs
    text = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { state: 'gone' }
    throw error
  }
  if (mtimeMs + TICKET_LEASE_SECONDS * 1_000 <= now) return { state: 'stale' }

  const record = parseKeyValueRecord(text)
  const label = record?.get('label')
  const token = record?.get('token')
  const arrivedAtMs = Number(record?.get('arrived_at_ms') ?? Number.NaN)
  // The file name IS the token: a ticket that disagrees with its own name is
  // not one this module wrote, so it is skipped like any other unreadable one.
  if (!record || !label || token === undefined || entry !== `${token}.ticket` || !Number.isFinite(arrivedAtMs)) {
    return { state: 'unreadable' }
  }
  const pidRaw = record.get('pid')
  const pid = pidRaw !== undefined && PID_PATTERN.test(pidRaw) ? Number(pidRaw) : undefined
  // A waiter is a live process for as long as it waits (it IS the `run` or
  // `acquire --wait` process), so here — unlike for the lock — a dead pid is a
  // real signal and needs no heartbeat to confirm it.
  if (isProcessProvablyDead(pid)) return { state: 'stale' }
  return {
    state: 'live',
    ticket: { label, token, pid, arrivedAtMs, arrivedAt: record.get('arrived_at') ?? new Date(arrivedAtMs).toISOString() },
  }
}

/**
 * Unlinks one stale ticket, confined the way lock removal is: the directory is
 * re-derived from (name, root), the entry must match `TICKET_NAME_PATTERN`, and
 * the ticket is judged again immediately before the unlink.
 *
 * The window between that judgement and the unlink is deliberately tolerated:
 * a waiter that refreshes inside it loses its file and puts it back on its next
 * poll, arrival time included (`refreshTicket`). Removing a live TICKET costs
 * one poll of ordering; removing a live LOCK lets two test runs overlap, which
 * is why the two removals follow opposite rules.
 */
function clearStaleTicket(location: LockLocation, dir: string, entry: string, now: number): void {
  if (queueDirFor(location).dir !== dir || !TICKET_NAME_PATTERN.test(entry)) {
    throw new Error(`bun-test-lock: refusing to clear ${join(dir, entry)} — not a ticket of this queue`)
  }
  if (judgeTicket(dir, entry, now).state !== 'stale') return
  try {
    unlinkSync(join(dir, entry))
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }
}

/**
 * Reads the queue. Read-only unless `clearStale` is set — `status` only looks;
 * a waiter clears what it skipped, so a dead waiter's ticket goes with the next
 * poll of anybody behind it.
 */
export function readQueue(
  location: LockLocation = {},
  options: { now?: number; clearStale?: boolean } = {},
): QueueReading {
  const { dir, name, root } = queueDirFor(location)
  const now = options.now ?? Date.now()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { dir, waiting: [], stale: 0, unreadable: 0 }
    throw error
  }
  const reading: QueueReading = { dir, waiting: [], stale: 0, unreadable: 0 }
  for (const entry of entries) {
    if (!TICKET_NAME_PATTERN.test(entry)) continue
    const verdict = judgeTicket(dir, entry, now)
    if (verdict.state === 'live') reading.waiting.push(verdict.ticket)
    else if (verdict.state === 'unreadable') reading.unreadable += 1
    else if (verdict.state === 'stale') {
      reading.stale += 1
      if (options.clearStale) clearStaleTicket({ name, root }, dir, entry, now)
    }
  }
  reading.waiting.sort((left, right) => (servedBefore(left, right) ? -1 : servedBefore(right, left) ? 1 : 0))
  return reading
}

/**
 * Takes a ticket. Why the queue looks the way it does — every point below is
 * about not breaking a process that is ALREADY running, because a `run` keeps
 * the module it loaded and every lane waits on this lock at once:
 *
 *   * NOTHING IS WRITTEN INSIDE THE LOCK DIRECTORY. It still holds exactly
 *     `owner` and `heartbeat`, so a holder or waiter running the previous copy
 *     reads it and removes it exactly as before — a third file there would make
 *     that copy's non-recursive release fail with ENOTEMPTY.
 *   * THE MUTEX IS STILL THE BARE `mkdir`. The queue decides who may TRY; it
 *     grants nothing. A waiter running the previous copy knows no queue and can
 *     still win a race against the head until it exits (a bounded transition);
 *     mutual exclusion never depends on the queue, in either direction.
 *   * A TICKET IS CHEAP TO LOSE, so a ghost never holds the line: a ticket whose
 *     waiter is provably gone, or whose mtime is older than
 *     `TICKET_LEASE_SECONDS`, is skipped and cleared (`clearStaleTicket`).
 *   * A ticket is written once, whole (`wx`), and kept warm by its mtime, so a
 *     reader never meets a half-rewritten one. A ticket that does not parse is
 *     skipped: the only honest way to meet one is a waiter mid-create, which is
 *     the newest arrival anyway.
 *
 * Confinement is the lock's: the queue path is derived from the validated
 * (name, root) and created with a bare `mkdir` inside that already-validated
 * root, only `TICKET_NAME_PATTERN` entries are ever unlinked, and the queue
 * directory itself is never removed.
 */
export function joinQueue(options: LockLocation & { label: string; now?: number }): TicketHandle {
  const { dir, name, root } = queueDirFor(options)
  if (options.label.length === 0 || options.label.includes('\n')) {
    throw new Error('bun-test-lock: label must be a non-empty single line')
  }
  try {
    mkdirSync(dir)
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
  }
  if (!statSync(dir).isDirectory()) throw new Error(`bun-test-lock: ${dir} exists and is not a directory — report it`)

  const token = newToken()
  const arrivedAtMs = options.now ?? Date.now()
  const text = formatKeyValueRecord([
    ['label', options.label],
    ['token', token],
    ['pid', String(process.pid)],
    ['arrived_at_ms', String(arrivedAtMs)],
    ['arrived_at', new Date(arrivedAtMs).toISOString()],
  ])
  const file = join(dir, `${token}.ticket`)
  writeFileSync(file, text, { flag: 'wx' })
  return { name, root, queueDir: dir, file, label: options.label, token, arrivedAtMs, text }
}

function assertTicketPath(handle: TicketHandle, action: string): void {
  const derived = queueDirFor({ name: handle.name, root: handle.root }).dir
  if (derived !== handle.queueDir || handle.file !== join(derived, `${handle.token}.ticket`)) {
    throw new Error(`bun-test-lock: refusing to ${action} ${handle.file} — it does not re-derive from its name, root and token`)
  }
}

/** Keeps a ticket warm; puts it back, arrival time included, if it was cleared while this waiter stalled. */
export function refreshTicket(handle: TicketHandle, now: number = Date.now()): void {
  assertTicketPath(handle, 'refresh')
  try {
    utimesSync(handle.file, now / 1_000, now / 1_000)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    try {
      writeFileSync(handle.file, handle.text, { flag: 'wx' })
    } catch (rewrite) {
      if ((rewrite as { code?: string }).code !== 'EEXIST') throw rewrite
    }
  }
}

export function leaveQueue(handle: TicketHandle): void {
  assertTicketPath(handle, 'remove')
  try {
    unlinkSync(handle.file)
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
  }
}

export type TurnResult = AcquireResult & { ahead: QueueTicket[] }

/**
 * One poll of a queued waiter: keep the ticket warm, clear what is stale, and
 * try the lock ONLY if no live ticket was served before this one. A waiter that
 * is not first never touches the lock, not even to reap a cold one — the head
 * does that, through `acquireLock`, exactly as every waiter used to.
 */
export function tryInTurn(
  options: Parameters<typeof acquireLock>[0],
  ticket: TicketHandle,
  now: number = Date.now(),
): TurnResult {
  refreshTicket(ticket, now)
  const location = { name: options.name, root: options.root }
  const ahead = readQueue(location, { now, clearStale: true }).waiting.filter(
    (waiter) => waiter.token !== ticket.token && servedBefore(waiter, ticket),
  )
  if (ahead.length > 0) {
    const status = inspectLock(location, now)
    return {
      ok: false,
      status,
      ahead,
      reason:
        `queued behind ${ahead.length} earlier waiter(s): ${ahead.map((waiter) => waiter.label).join(', ')}; ` +
        `the lock is ${describeStatus(status)}`,
    }
  }
  return { ...acquireLock({ ...options, now }), ahead: [] }
}

export function describeQueue(reading: QueueReading, now: number = Date.now()): string | undefined {
  if (reading.waiting.length === 0 && reading.stale === 0 && reading.unreadable === 0) return undefined
  const served = reading.waiting.map(
    (waiter, index) =>
      `${index + 1}. ${waiter.label} (pid ${String(waiter.pid ?? 'unknown')}, queued ${Math.round((now - waiter.arrivedAtMs) / 1000)}s ago)`,
  )
  return (
    `queue: ${reading.waiting.length} waiter(s), served in this order${served.length > 0 ? ` — ${served.join(', ')}` : ''}` +
    (reading.stale > 0 ? `; ${reading.stale} stale ticket(s) the next waiter clears` : '') +
    (reading.unreadable > 0 ? `; ${reading.unreadable} unreadable ticket(s) skipped` : '')
  )
}

// ---------------------------------------------------------------------------
// The child's environment (F1.131)
// ---------------------------------------------------------------------------

/**
 * The environment `run` hands its command: the caller's, minus every name the
 * cdp launcher already refuses to hand the packaged app.
 *
 * Measured 2026-09-20 (WI-cc, D1.440-F): under this lock,
 * `codex-subagent-model-projection.test.ts` projected `opus` — 1 pass / 4 fail —
 * because the lane's shell exported `CLAUDE_CODE_SUBAGENT_MODEL=opus` and
 * `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, and the product READS both; the same
 * bytes under `env -u` of those two names were 5 pass / 0 fail. Four of the
 * eleven local reds in the 525-file agent chunk were this. It is AGENTS.md's
 * launcher trap one level down: a lane is a Claude Code agent, the suite is a
 * child of the lane's shell, and CI's runner exports none of these names — so a
 * lock run that inherits them measures a machine CI is not. Since 2026-09-23
 * every lane shell carries both names, so this is every run, not an edge.
 *
 * The list is IMPORTED from `scripts/cdp/lib/app-env.ts`
 * (`CONTAMINATING_ENV_NAMES`), never copied: that module owns the derivation
 * command and its dated reading, and a second list here would age on its own
 * schedule the way every prose enumeration in this repo has. A name the list
 * marks inert (`files: 0`) is stripped too — the launcher deletes it as well,
 * and deleting a name nothing reads costs nothing.
 *
 * Only NAMES leave this function's caller; one of them is a credential by
 * construction (`CLAUDE_CODE_MESSAGING_TOKEN`). The copy is a plain object, so
 * `delete` and `in` behave; the Bun `process.env` slot trap (AGENTS.md) only
 * bites a name ASSIGNED in-process, which nothing here does.
 */
export function childEnvForRun(parent: Readonly<Record<string, string | undefined>>): {
  env: Record<string, string>
  stripped: string[]
} {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined) env[name] = value
  }
  const stripped: string[] = []
  for (const { name } of CONTAMINATING_ENV_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) continue
    delete env[name]
    stripped.push(name)
  }
  return { env, stripped }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `bun scripts/bun-test-lock.ts <command> [options]

  run      --label <name> [--lease <s>] [--wait <s>] -- <command...>
           Acquire, keep the lease warm while the command runs, release on exit
           (including on failure and on SIGINT/SIGTERM), and propagate the exit
           code. Prefer this: it cannot forget to release. The command runs
           WITHOUT the agent-shell names the product reads (the cdp launcher's
           CONTAMINATING_ENV_NAMES), and the lock prints which it removed.
           Waiters are served in ARRIVAL ORDER: each takes a ticket in
           <lock>${QUEUE_SUFFIX} beside the lock, and only the oldest live
           ticket tries the lock (F1.474). --wait defaults to ${DEFAULT_RUN_WAIT_SECONDS} s;
           a run that gives up prints a banner on stderr AND stdout and
           exits 3 without running the command (F1.556).
  acquire  --label <name> [--lease <s>] [--wait <s>] [--session <id>]
           Prints the release command, token included. Queues like \`run\`,
           so --wait 0 is refused while an earlier waiter is queued.
  refresh  --label <name> --token <token>
  release  --label <name> --token <token>
  status   [--json]
           The lock, then the queue in the order it will be served.
  reap     Removes the lock ONLY if it is reapable: its lease has gone cold, or
           it recorded a supervising pid that is provably gone. Refuses a warm
           holder, and refuses a lock whose owner file it cannot parse — a
           foreign owner format is a blockage to report, never one to guess at.

  Common:  [--name <${DEFAULT_LOCK_NAME}-style name>] [--root <temp dir>]
           --root and NESSY_TEST_LOCK_ROOT must resolve inside a system temp
           directory. Default lock: ${join(DEFAULT_LOCK_ROOT, DEFAULT_LOCK_NAME)}
`

type Argv = { command: string; flags: Map<string, string>; rest: string[] }

export function parseArgv(argv: string[]): Argv {
  const separator = argv.indexOf('--')
  const head = separator === -1 ? argv : argv.slice(0, separator)
  const rest = separator === -1 ? [] : argv.slice(separator + 1)
  const command = head[0] ?? 'status'
  const flags = new Map<string, string>()
  for (let index = 1; index < head.length; index += 1) {
    const token = head[index]!
    if (!token.startsWith('--')) throw new Error(`bun-test-lock: unexpected argument ${JSON.stringify(token)}`)
    const key = token.slice(2)
    if (key === 'json') {
      flags.set(key, 'true')
      continue
    }
    const value = head[index + 1]
    if (value === undefined) throw new Error(`bun-test-lock: --${key} needs a value`)
    flags.set(key, value)
    index += 1
  }
  return { command, flags, rest }
}

function locationFrom(flags: Map<string, string>): LockLocation {
  const location: LockLocation = {}
  const name = flags.get('name')
  if (name !== undefined) location.name = name
  const root = flags.get('root') ?? process.env.NESSY_TEST_LOCK_ROOT
  if (root !== undefined) location.root = root
  return location
}

function requiredFlag(flags: Map<string, string>, key: string): string {
  const value = flags.get(key)
  if (value === undefined) throw new Error(`bun-test-lock: --${key} is required`)
  return value
}

function numberFlag(flags: Map<string, string>, key: string, fallback: number): number {
  const raw = flags.get(key)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`bun-test-lock: --${key} must be a number, got ${JSON.stringify(raw)}`)
  return parsed
}

/**
 * Waits in turn (F1.474): one ticket for the whole wait, one poll per
 * `WAIT_POLL_MS`, and the ticket leaves on EVERY exit — acquired, timed out or
 * thrown. A waiter killed outright leaves its ticket behind, and its dead pid
 * clears it at the next poll of anybody behind it.
 */
async function acquireWithWait(
  options: Parameters<typeof acquireLock>[0] & { waitSeconds: number },
): Promise<AcquireResult> {
  const deadline = Date.now() + options.waitSeconds * 1_000
  const ticket = joinQueue({ name: options.name, root: options.root, label: options.label })
  try {
    for (;;) {
      const turn = tryInTurn(options, ticket)
      if (turn.ok) return turn
      if (Date.now() >= deadline) return turn
      process.stderr.write(`bun-test-lock: waiting${turn.ahead.length === 0 ? ' (first in line)' : ''} — ${turn.reason}\n`)
      await Bun.sleep(WAIT_POLL_MS)
    }
  } finally {
    leaveQueue(ticket)
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, flags, rest } = parseArgv(argv)
  const location = locationFrom(flags)

  switch (command) {
    case 'help':
    case '--help':
      process.stdout.write(USAGE)
      return 0

    case 'status': {
      // The first line (and every key of the JSON) is what it always was; the
      // queue is added after it, and only when there is one to show.
      const status = inspectLock(location)
      const queue = readQueue(location)
      if (flags.has('json')) process.stdout.write(`${JSON.stringify({ ...status, queue: queue.waiting }, null, 2)}\n`)
      else {
        const line = describeQueue(queue)
        process.stdout.write(`${describeStatus(status)}\n${line === undefined ? '' : `${line}\n`}`)
      }
      return status.state === 'blocked' ? 3 : 0
    }

    case 'reap': {
      // ONE inspection. The shape this replaces inspected, then called a reap
      // that inspected again, and then reported the FIRST snapshot — so a lock
      // cleared or taken over between the two reads was announced as reaped by
      // us. `cleared` rather than `reaped` because the winner of a two-waiter
      // race removed the directory a moment before this call reached it, and
      // either way the cold lock is gone.
      const status = reapExpiredLock(location)
      if (status.state !== 'expired') {
        process.stderr.write(`bun-test-lock: refusing to reap — ${describeStatus(status)}\n`)
        return status.state === 'free' ? 0 : 3
      }
      process.stdout.write(`bun-test-lock: cleared a cold lock — ${describeStatus(status)}\n`)
      return 0
    }

    case 'acquire': {
      const result = await acquireWithWait({
        ...location,
        label: requiredFlag(flags, 'label'),
        session: flags.get('session'),
        leaseSeconds: numberFlag(flags, 'lease', DEFAULT_LEASE_SECONDS),
        waitSeconds: numberFlag(flags, 'wait', 0),
      })
      if (!result.ok) {
        process.stderr.write(`bun-test-lock: not acquired — ${result.reason}\n`)
        return 3
      }
      const { handle } = result
      process.stdout.write(
        `bun-test-lock: acquired ${handle.dir} for ${handle.label}, lease ${handle.leaseSeconds}s\n` +
          `  refresh: bun scripts/bun-test-lock.ts refresh --label ${handle.label} --token ${handle.token}\n` +
          `  release: bun scripts/bun-test-lock.ts release --label ${handle.label} --token ${handle.token}\n` +
          `  note: this process exits with this tool call, so its pid proves nothing about you. The heartbeat is the only bound — refresh it, or the lock becomes reapable ${handle.leaseSeconds}s from now.\n`,
      )
      return 0
    }

    case 'refresh':
    case 'release': {
      const { dir, name, root } = lockDirFor(location)
      const status = inspectLock({ name, root })
      const leaseSeconds = status.state === 'held' ? status.holder.leaseSeconds : DEFAULT_LEASE_SECONDS
      const handle: LockHandle = {
        name,
        root,
        dir,
        label: requiredFlag(flags, 'label'),
        token: requiredFlag(flags, 'token'),
        leaseSeconds,
      }
      if (command === 'refresh') refreshLock(handle)
      else releaseLock(handle)
      process.stdout.write(`bun-test-lock: ${command}d ${dir} for ${handle.label}\n`)
      return 0
    }

    case 'run': {
      if (rest.length === 0) throw new Error('bun-test-lock: run needs a command after `--`')
      const label = requiredFlag(flags, 'label')
      const waitSeconds = numberFlag(flags, 'wait', DEFAULT_RUN_WAIT_SECONDS)
      const queuedAt = Date.now()
      const result = await acquireWithWait({
        ...location,
        label,
        session: flags.get('session'),
        leaseSeconds: numberFlag(flags, 'lease', RUN_LEASE_SECONDS),
        waitSeconds,
      })
      if (!result.ok) {
        process.stderr.write(`bun-test-lock: not acquired — ${result.reason}\n`)
        const banner = describeRunGiveUp({ label, reason: result.reason, waitSeconds, waitedMs: Date.now() - queuedAt, command: rest })
        process.stderr.write(banner)
        process.stdout.write(banner)
        return 3
      }
      const { handle } = result
      let released = false
      const releaseOnce = (): void => {
        if (released) return
        released = true
        clearInterval(timer)
        try {
          releaseLock(handle)
        } catch (error) {
          process.stderr.write(`bun-test-lock: release refused — ${String((error as Error).message)}\n`)
        }
      }
      const timer = setInterval(() => {
        try {
          refreshLock(handle)
        } catch (error) {
          process.stderr.write(`bun-test-lock: heartbeat refused — ${String((error as Error).message)}\n`)
        }
      }, RUN_REFRESH_MS)
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
          releaseOnce()
          process.exit(130)
        })
      }
      try {
        const { env, stripped } = childEnvForRun(process.env)
        if (stripped.length > 0) {
          process.stderr.write(
            `bun-test-lock: removed ${stripped.length} inherited name(s) the product reads and CI never sets ` +
              `(scripts/cdp/lib/app-env.ts CONTAMINATING_ENV_NAMES): ${stripped.join(', ')}\n`,
          )
        }
        const child = Bun.spawn(rest, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env })
        return await child.exited
      } finally {
        releaseOnce()
      }
    }

    default:
      process.stderr.write(`bun-test-lock: unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
      return 2
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`bun-test-lock: ${String((error as Error).message)}\n`)
      process.exit(2)
    })
}
