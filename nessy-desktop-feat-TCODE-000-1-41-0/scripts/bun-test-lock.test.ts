/**
 * Every case here pins a failure that was MEASURED in this repo, not imagined.
 * The comments name which one, because a lock helper whose tests only prove the
 * happy path is the same artifact as the prose protocol it replaces.
 *
 * All filesystem work happens inside a private `mkdtemp` sandbox under the
 * system temp directory, with lock names that are deliberately NOT the real
 * `nessy-bun-test.lock`. Other lanes hold the real lock while this runs.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_LEASE_SECONDS,
  DEFAULT_LOCK_NAME,
  DEFAULT_LOCK_ROOT,
  LOCK_NAME_PATTERN,
  REMOVABLE_ENTRIES,
  acquireLock,
  assertLockName,
  childEnvForRun,
  describeStatus,
  inspectLock,
  lockDirFor,
  parseArgv,
  isProcessProvablyDead,
  parseKeyValueRecord,
  probeErrorMeansDead,
  reapExpiredLock,
  refreshLock,
  releaseLock,
  removeLockDirectory,
  resolveLockRoot,
} from './bun-test-lock.ts'
import { CONTAMINATING_ENV_NAMES } from './cdp/lib/app-env.ts'
import * as lockModule from './bun-test-lock.ts'

const SANDBOX_LOCK = 'nessy-bun-test-sandbox.lock'
const OTHER_LOCK = 'nessy-bun-test-sandbox-two.lock'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bun-test-lock-spec-'))
})

afterEach(() => {
  // Confined to this test's own mkdtemp directory, never a lock path the helper
  // derived and never an ambient root.
  rmSync(root, { recursive: true, force: true })
})

function ownerText(dir: string): string {
  return readFileSync(join(dir, 'owner'), 'utf-8')
}

/** A pid that has certainly exited: spawn something trivial and wait for it. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['bun', '-e', '""'], { stdout: 'ignore', stderr: 'ignore' })
  const pid = child.pid
  await child.exited
  return pid
}

/**
 * Builds a lock by hand with a chosen pid and heartbeat age. Needed because a
 * lock taken through `acquireLock` records THIS process's pid, which is alive
 * for the whole test run — and a cold heartbeat with a live pid is deliberately
 * blocked rather than reapable.
 */
function writeLockByHand(
  dir: string,
  options: { label?: string; token?: string; pid?: number | string; expiresInMs: number; refreshedAt?: string },
): void {
  mkdirSync(dir)
  const lines = [
    `label=${options.label ?? 'lane-a'}`,
    `token=${options.token ?? 'abc123'}`,
    'acquired_at=2026-08-25T12:56:20.000Z',
    'lease_seconds=600',
  ]
  if (options.pid !== undefined) lines.push(`pid=${String(options.pid)}`)
  writeFileSync(join(dir, 'owner'), `${lines.join('\n')}\n`)
  writeFileSync(
    join(dir, 'heartbeat'),
    `refreshed_at=${options.refreshedAt ?? '2026-08-25T12:56:20.000Z'}\nexpires_at_ms=${Date.now() + options.expiresInMs}\n`,
  )
}

describe('the lock the prose protocol used', () => {
  test('default name and root still describe /tmp/nessy-bun-test.lock', () => {
    // Interoperability: a lane still following the prose protocol takes exactly
    // this path, so the helper must not quietly move the lock.
    expect(DEFAULT_LOCK_NAME).toBe('nessy-bun-test.lock')
    if (process.platform !== 'win32') expect(DEFAULT_LOCK_ROOT).toBe('/tmp')
    expect(LOCK_NAME_PATTERN.test(DEFAULT_LOCK_NAME)).toBe(true)
  })
})

describe('mkdir -p succeeds on an existing directory (measured 2026-08-25)', () => {
  test('a second lane cannot acquire a lock the first holds', () => {
    const first = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', session: 'aaa' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-b', session: 'bbb' })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.status.state).toBe('held')
    expect(second.reason).toContain('lane-a')

    // The historical bug: lane B's owner file landed inside lane A's lock and
    // both believed they owned it.
    expect(ownerText(first.handle.dir)).toContain('label=lane-a')
    expect(ownerText(first.handle.dir)).not.toContain('lane-b')
  })

  test('an owner file is never clobbered, even when the directory already exists', () => {
    // Reproduces the `mkdir -p` shape directly: the directory is created by
    // someone else (recursive, as the broken instruction allowed) and already
    // carries an owner file. Acquisition must fail rather than stamp over it.
    const dir = join(root, SANDBOX_LOCK)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'owner'),
      'label=lane-a\ntoken=deadbeef\nacquired_at=2026-08-25T08:23:19.000Z\nlease_seconds=1800\n',
    )
    writeFileSync(join(dir, 'heartbeat'), `expires_at_ms=${Date.now() + 600_000}\n`)

    const result = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-b' })
    expect(result.ok).toBe(false)
    expect(ownerText(dir)).toContain('label=lane-a')
    expect(ownerText(dir)).not.toContain('lane-b')
  })

  test('exactly one of many simultaneous acquisitions wins', () => {
    const results = Array.from({ length: 12 }, (_unused, index) =>
      acquireLock({ root, name: SANDBOX_LOCK, label: `lane-${index}` }),
    )
    expect(results.filter((result) => result.ok)).toHaveLength(1)
  })
})

describe('a reaper deleted a live holder lock (measured 2026-08-25)', () => {
  test('a warm holder is not reapable', () => {
    const acquired = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', leaseSeconds: 600 })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return

    const status = reapExpiredLock({ root, name: SANDBOX_LOCK })
    expect(status.state).toBe('held')
    // Still there, contents intact — the whole defect was a reaper removing this.
    expect(existsSync(acquired.handle.dir)).toBe(true)
    expect(ownerText(acquired.handle.dir)).toContain('label=lane-a')
  })

  test('a cold heartbeat whose holder is gone is reapable, and acquisition takes it over', async () => {
    writeLockByHand(join(root, SANDBOX_LOCK), { label: 'lane-a', pid: await deadPid(), expiresInMs: -60_000 })
    expect(inspectLock({ root, name: SANDBOX_LOCK }).state).toBe('expired')

    const takeover = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-b', leaseSeconds: 600 })
    expect(takeover.ok).toBe(true)
    if (!takeover.ok) return
    expect(ownerText(takeover.handle.dir)).toContain('label=lane-b')
  })

  test('a cold heartbeat whose process is still running is NOT taken over', () => {
    // The lock records this test process's pid, which is alive; a cold
    // heartbeat is therefore blocked rather than reapable, and acquisition
    // refuses instead of stealing it.
    const held = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', leaseSeconds: 1, now: 1_000 })
    expect(held.ok).toBe(true)
    expect(inspectLock({ root, name: SANDBOX_LOCK }, 60_000).state).toBe('blocked')

    const takeover = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-b', leaseSeconds: 600, now: 60_000 })
    expect(takeover.ok).toBe(false)
    expect(ownerText(join(root, SANDBOX_LOCK))).toContain('label=lane-a')
  })

  test('a refreshed lease keeps the lock warm past its original deadline', () => {
    const acquired = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', leaseSeconds: 10, now: 1_000 })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return

    // Blocked rather than expired: this process's pid is in the record and it is
    // alive, so the cold heartbeat may not authorise a reap on its own.
    expect(inspectLock({ root, name: SANDBOX_LOCK }, 30_000).state).toBe('blocked')
    refreshLock(acquired.handle, 25_000)
    expect(inspectLock({ root, name: SANDBOX_LOCK }, 30_000).state).toBe('held')
  })
})

describe('a dead PID does not mean a dead holder (measured twice, 2026-08-25)', () => {
  test('THE CASE THAT WOULD HAVE CORRUPTED A LIVE MEASUREMENT: dead pid, fresh heartbeat, not reapable', async () => {
    // Measured 2026-08-25: `owner=agent-p2158-p2159 pid=37225`, `ps -p 37225`
    // dead, and the agent still working — every tool call runs in a fresh shell,
    // so the pid recorded at acquisition is dead within seconds.
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { label: 'agent-p2158-p2159', pid: await deadPid(), expiresInMs: 300_000 })

    const status = inspectLock({ root, name: SANDBOX_LOCK })
    expect(status.state).toBe('held')
    expect(reapExpiredLock({ root, name: SANDBOX_LOCK }).state).toBe('held')
    expect(existsSync(dir)).toBe(true)

    // And it says so in words, so the next reader is not tempted to override it.
    const verdict = describeStatus(status)
    expect(verdict).toContain('heartbeat fresh at 2026-08-25T12:56:20.000Z')
    expect(verdict).toContain('NOT reaping')
    expect(verdict).toContain('which proves nothing here')
  })

  test('a cold heartbeat plus a gone pid is reapable — the day six lanes died at once', async () => {
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { label: 'agent-p2158-p2159', pid: await deadPid(), expiresInMs: -60_000 })

    const status = inspectLock({ root, name: SANDBOX_LOCK })
    expect(status.state).toBe('expired')
    expect(status.state === 'expired' && status.reason).toBe('heartbeat-cold-and-pid-gone')
    expect(describeStatus(status)).toContain('is gone — reapable')

    expect(reapExpiredLock({ root, name: SANDBOX_LOCK }).state).toBe('expired')
    expect(existsSync(dir)).toBe(false)
  })

  test('a cold heartbeat with a LIVE pid is blocked, not reaped — a pid may only withhold', () => {
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { label: 'agent-p2158-p2159', pid: process.pid, expiresInMs: -60_000 })

    const status = inspectLock({ root, name: SANDBOX_LOCK })
    expect(status.state).toBe('blocked')
    expect(status.state === 'blocked' && status.reason).toContain(`recorded pid ${process.pid}`)
    expect(describeStatus(status)).toContain('NOT reaping')

    expect(reapExpiredLock({ root, name: SANDBOX_LOCK }).state).toBe('blocked')
    expect(existsSync(dir)).toBe(true)
  })

  test('a cold heartbeat with no usable pid is reapable on the heartbeat alone', () => {
    for (const pid of [undefined, '0', '-1', 'abc', '', '1', '00']) {
      rmSync(join(root, SANDBOX_LOCK), { recursive: true, force: true })
      writeLockByHand(join(root, SANDBOX_LOCK), { pid, expiresInMs: -60_000 })
      const status = inspectLock({ root, name: SANDBOX_LOCK })
      expect(status.state).toBe('expired')
      expect(status.state === 'expired' && status.reason).toBe('heartbeat-cold-pid-unknown')
      expect(describeStatus(status)).toContain('no usable pid')
    }
  })

  test('an unbelievable pid is unknown, and unknown never blocks a cold reap either', () => {
    // The mirror of the case above: a garbage pid must not be read as "alive"
    // and used to veto, any more than it may be read as "dead" and used to reap.
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { pid: 2026, expiresInMs: -60_000 })
    const status = inspectLock({ root, name: SANDBOX_LOCK })
    // 2026 is a plausible-looking number that came out of a TIMESTAMP in the
    // real incident. It is only believed here because it arrived under the `pid`
    // key of a strict record — and if such a process happens to exist, the
    // conservative answer (blocked) is the one taken.
    expect(['expired', 'blocked']).toContain(status.state)
    if (status.state === 'expired') expect(status.reason).toBe('heartbeat-cold-and-pid-gone')
  })

  test('the owner record carries a stable label and a probeable pid, and declares nothing about supervision', () => {
    const acquired = acquireLock({ root, name: SANDBOX_LOCK, label: 'agent-citation-batch', session: 'bf588b7c' })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return

    const text = ownerText(acquired.handle.dir)
    expect(text).toContain('label=agent-citation-batch')
    expect(text).toContain('session=bf588b7c')
    expect(text).toContain(`pid=${process.pid}`)
    // There is no per-lock rule about whether the pid "supervises": the
    // heartbeat decides, always.
    expect(text).not.toContain('pid_supervises')
    // And the default lease is measured in minutes, not the lifetime of a process.
    expect(text).toContain(`lease_seconds=${DEFAULT_LEASE_SECONDS}`)
    expect(DEFAULT_LEASE_SECONDS).toBeLessThanOrEqual(900)
  })

  test('only ESRCH counts as dead — EPERM and every unknown code mean alive', () => {
    // Asserted against the classifier rather than a live pid: on a host where
    // every probe either succeeds or returns ESRCH (a container running as root,
    // for instance) the EPERM branch is unreachable through `process.kill`, and
    // a mutation that treats every probe failure as death survives.
    expect(probeErrorMeansDead({ code: 'ESRCH' })).toBe(true)
    expect(probeErrorMeansDead({ code: 'EPERM' })).toBe(false)
    expect(probeErrorMeansDead({ code: 'EINVAL' })).toBe(false)
    expect(probeErrorMeansDead(new Error('no code at all'))).toBe(false)
    expect(probeErrorMeansDead(undefined)).toBe(false)
    expect(probeErrorMeansDead(null)).toBe(false)
  })

  test('a live pid is alive and an exited pid is dead', async () => {
    expect(isProcessProvablyDead(process.pid)).toBe(false)
    expect(isProcessProvablyDead(await deadPid())).toBe(true)
    // pid 1 and below are never probed: on this platform they belong to init
    // and to signal-broadcast semantics, neither of which is a lock holder.
    expect(isProcessProvablyDead(1)).toBe(false)
    expect(isProcessProvablyDead(0)).toBe(false)
    expect(isProcessProvablyDead(-1)).toBe(false)
    expect(isProcessProvablyDead(undefined)).toBe(false)
  })
})

describe('a liveness check that invents its subjects reports the lock free (measured 2026-08-25)', () => {
  const freeText = 'owner=agent-citation-batch (session bf588b7c)\ntaken 2026-08-25T08:23:19Z\npid varies per tool call\n'

  test('the strict parser refuses free text instead of mining numbers out of it', () => {
    // `grep -aoE '[0-9]{3,6}'` over this text returned 2026 (the year) and 588
    // (a session-id fragment) and reported both processes dead.
    expect(parseKeyValueRecord(freeText)).toBeUndefined()
    expect(parseKeyValueRecord('label=lane-a\nlease_seconds=10\n')).toBeInstanceOf(Map)
    expect(parseKeyValueRecord('LABEL=lane-a\n')).toBeUndefined()
    expect(parseKeyValueRecord('label=a\nlabel=b\n')).toBeUndefined()
  })

  test('an unparsable owner file reports blocked, never free', () => {
    const dir = join(root, SANDBOX_LOCK)
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner'), freeText)

    const status = inspectLock({ root, name: SANDBOX_LOCK })
    expect(status.state).toBe('blocked')
    expect(status.state === 'blocked' && status.reason).toContain('report the blockage')

    // And nothing may reap it on that basis.
    expect(reapExpiredLock({ root, name: SANDBOX_LOCK }).state).toBe('blocked')
    expect(existsSync(dir)).toBe(true)
  })

  test('the prose protocol owner line is reported blocked, and its digits are never mined', () => {
    // The real lock carried exactly this on 2026-08-25 15:56Z. `pid=37225` sits
    // INSIDE the value of a single `owner=` key, so a keyed read finds no pid —
    // which is the correct answer, and the reason a foreign owner format is a
    // blockage to report rather than one to guess at.
    const line = 'owner=agent-p2158-p2159 pid=37225 taken=2026-08-25T12:56:20Z\n'
    const parsed = parseKeyValueRecord(line)
    expect(parsed).toBeInstanceOf(Map)
    expect(parsed?.get('pid')).toBeUndefined()
    expect(parsed?.get('owner')).toContain('pid=37225')

    const dir = join(root, SANDBOX_LOCK)
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner'), line)
    const status = inspectLock({ root, name: SANDBOX_LOCK })
    expect(status.state).toBe('blocked')
    expect(reapExpiredLock({ root, name: SANDBOX_LOCK }).state).toBe('blocked')
    expect(existsSync(dir)).toBe(true)
  })

  test('an owner file that parses but names no holder also reports blocked', () => {
    const dir = join(root, SANDBOX_LOCK)
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner'), 'note=took the lock at 11:11:43\n')
    expect(inspectLock({ root, name: SANDBOX_LOCK }).state).toBe('blocked')
  })

  test('a directory with no owner file is bounded, not free and not permanent', () => {
    // A lane that died between mkdir and its first write must neither wedge the
    // lock forever nor read as free.
    const dir = join(root, SANDBOX_LOCK)
    mkdirSync(dir)
    expect(inspectLock({ root, name: SANDBOX_LOCK }).state).toBe('blocked')
    expect(inspectLock({ root, name: SANDBOX_LOCK }, Date.now() + (DEFAULT_LEASE_SECONDS + 60) * 1_000).state).toBe(
      'expired',
    )
  })
})

describe('release only as owner', () => {
  test('a foreign token cannot release, and the lock survives the attempt', () => {
    const acquired = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a' })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return

    expect(() => releaseLock({ ...acquired.handle, token: 'not-my-token' })).toThrow(/owned by lane-a/)
    expect(() => releaseLock({ ...acquired.handle, label: 'lane-b' })).toThrow(/Never remove a lock you did not create/)
    expect(existsSync(acquired.handle.dir)).toBe(true)

    releaseLock(acquired.handle)
    expect(existsSync(acquired.handle.dir)).toBe(false)
    expect(inspectLock({ root, name: SANDBOX_LOCK }).state).toBe('free')
  })

  test('releasing a lock that another lane took over is refused', async () => {
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { label: 'lane-a', token: 'lane-a-token', pid: await deadPid(), expiresInMs: -60_000 })
    // Built through `lockDirFor` so the handle carries the RESOLVED root: on
    // macOS `os.tmpdir()` is a symlink, and a handle holding the unresolved
    // path is refused by the re-derivation check before ownership is ever read.
    const derived = lockDirFor({ root, name: SANDBOX_LOCK })
    const staleHandle = { ...derived, label: 'lane-a', token: 'lane-a-token', leaseSeconds: 600 }

    const second = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-b', leaseSeconds: 600 })
    expect(second.ok).toBe(true)

    expect(() => releaseLock(staleHandle)).toThrow(/owned by lane-b/)
    expect(existsSync(dir)).toBe(true)
  })

  test('two locks are independent', () => {
    const a = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a' })
    const b = acquireLock({ root, name: OTHER_LOCK, label: 'lane-b' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    releaseLock(a.handle)
    expect(existsSync(b.handle.dir)).toBe(true)
  })
})

describe('removal cannot escape a lock directory', () => {
  test('a name cannot describe a location', () => {
    for (const name of ['', '.', '..', '/tmp/nessy-bun-test.lock', 'nessy-bun-test.lock/../..', '../nessy-bun-test.lock', 'other.lock', 'nessy-bun-test.lock\n']) {
      expect(() => assertLockName(name)).toThrow(/refusing lock name/)
      expect(() => lockDirFor({ root, name })).toThrow(/refusing lock name/)
    }
    expect(assertLockName(SANDBOX_LOCK)).toBe(SANDBOX_LOCK)
  })

  test('a root outside a system temp directory is refused', () => {
    // The measured incident this pins: a destructive verb whose operand was a
    // real home directory.
    expect(() => resolveLockRoot(homedir())).toThrow(/outside a system temp directory/)
    expect(() => resolveLockRoot('/')).toThrow(/outside a system temp directory/)
    expect(() => resolveLockRoot('relative/path')).toThrow(/must be absolute/)
    expect(() => resolveLockRoot(join(root, 'does-not-exist'))).toThrow(/does not exist/)
    expect(resolveLockRoot(root)).toContain('bun-test-lock-spec-')
  })

  test('a lock directory is always a direct child of its validated root', () => {
    const derived = lockDirFor({ root, name: SANDBOX_LOCK })
    expect(derived.dir).toBe(join(derived.root, SANDBOX_LOCK))
    expect(REMOVABLE_ENTRIES).toEqual(['owner', 'heartbeat'])
  })

  test('a handle whose dir was tampered with cannot release anything', () => {
    const acquired = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a' })
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const victim = join(root, 'not-a-lock')
    mkdirSync(victim)

    expect(() => releaseLock({ ...acquired.handle, dir: victim })).toThrow(/does not re-derive/)
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(acquired.handle.dir)).toBe(true)
  })

  test('an unexpected file inside a cold lock blocks removal instead of being destroyed', async () => {
    // There is no recursive delete in the helper, so `rmdir` refuses a
    // non-empty directory. A lock that accumulated something nobody expected is
    // therefore a blockage to report, not data to lose.
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { label: 'lane-a', pid: await deadPid(), expiresInMs: -60_000 })
    const bystander = join(dir, 'campaign-results.json')
    writeFileSync(bystander, '{"mutants":"survived"}')

    expect(inspectLock({ root, name: SANDBOX_LOCK }).state).toBe('expired')
    expect(() => reapExpiredLock({ root, name: SANDBOX_LOCK })).toThrow(/ENOTEMPTY|not empty/)
    expect(readFileSync(bystander, 'utf-8')).toBe('{"mutants":"survived"}')
  })
})

describe('the wait loop crashed removing a lock another waiter had already removed (P2.237)', () => {
  // MEASURED: a run that was only QUEUEING behind another lane died with
  // `bun-test-lock: ENOENT: no such file or directory, rmdir
  // '/private/tmp/nessy-bun-test.lock'` — every waiter sees one cold lock in the
  // same instant, and the losers' `rmdirSync` lands on a path the winner has
  // already removed. The crash was the harmless half: microseconds later the
  // winner has re-created and stamped the lock, and the loser deletes it out
  // from under a live `bun test`.
  //
  // NOT FORCIBLE END TO END. Producing that interleaving needs two processes
  // contending for one lock, and the only honest way to arrange it here would be
  // racing two real `bun test` runs — the thing this file exists to prevent. So
  // both branches are driven through `removeLockDirectory`, the one function
  // `acquireLock`, `reapExpiredLock` and `releaseLock` all remove through. What
  // stays unproven by a test is the interleaving itself, in every direction.

  // Through `lockDirFor`, so `dir` carries the RESOLVED root: on macOS
  // `os.tmpdir()` is a symlink, and a path built by hand from the unresolved
  // root is refused by the re-derivation check before anything else is read.
  const derivedDir = (): string => lockDirFor({ root, name: SANDBOX_LOCK }).dir

  test('a removal whose subject is already gone is not a failure', () => {
    const dir = derivedDir()
    expect(existsSync(dir)).toBe(false)
    // Pre-fix this threw ENOENT out of `rmdirSync`, up through the wait loop, to
    // the CLI's top-level catch — exit 2, indistinguishable from a test failure.
    expect(removeLockDirectory({ root, name: SANDBOX_LOCK }, dir, 'the-token-the-waiter-inspected')).toBe('already-gone')
  })

  test('a lock re-acquired since it was inspected is refused, not deleted', () => {
    // The waiter decided while lane-a's cold lock was there; by the time it acts,
    // lane-b has reaped it, taken it over, and is running.
    const dir = derivedDir()
    writeLockByHand(dir, { label: 'lane-b', token: 'lane-b-token', expiresInMs: 300_000 })

    expect(removeLockDirectory({ root, name: SANDBOX_LOCK }, dir, 'lane-a-token')).toBe('not-ours-any-more')
    expect(existsSync(dir)).toBe(true)
    expect(ownerText(dir)).toContain('token=lane-b-token')
    expect(existsSync(join(dir, 'heartbeat'))).toBe(true)

    // Positive control on the same rig: the guard refuses a lock that CHANGED,
    // not every lock. The same call with the token actually on disk removes it.
    expect(removeLockDirectory({ root, name: SANDBOX_LOCK }, dir, 'lane-b-token')).toBe('removed')
    expect(existsSync(dir)).toBe(false)
  })

  test('a lock with no owner file yet has no token to match, and stays removable', () => {
    // The bounded mid-acquire case: a lane died between `mkdir` and its stamp, so
    // there is no token. Refusing here would wedge the lock permanently, which is
    // the failure the "bounded, not free and not permanent" case above pins.
    const dir = derivedDir()
    mkdirSync(dir)
    expect(removeLockDirectory({ root, name: SANDBOX_LOCK }, dir, undefined)).toBe('removed')
    expect(inspectLock({ root, name: SANDBOX_LOCK }).state).toBe('free')
  })
})

describe('argument parsing', () => {
  test('the command after -- is kept verbatim', () => {
    const parsed = parseArgv(['run', '--label', 'lane-a', '--lease', '60', '--', 'bun', 'test', '--bail'])
    expect(parsed.command).toBe('run')
    expect(parsed.flags.get('label')).toBe('lane-a')
    expect(parsed.rest).toEqual(['bun', 'test', '--bail'])
  })

  test('a flag without a value is refused rather than silently dropped', () => {
    expect(() => parseArgv(['acquire', '--label'])).toThrow(/needs a value/)
    expect(() => parseArgv(['acquire', 'label'])).toThrow(/unexpected argument/)
    expect(parseArgv(['status', '--json']).flags.has('json')).toBe(true)
  })
})

describe('the run wrapper releases in every exit path', () => {
  const cli = join(import.meta.dir, 'bun-test-lock.ts')

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(['bun', cli, ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, NESSY_TEST_LOCK_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    return { exitCode: await child.exited, stdout, stderr }
  }

  test('a failing command still releases the lock and propagates its code', async () => {
    const failed = await runCli(['run', '--name', SANDBOX_LOCK, '--label', 'lane-a', '--', 'bun', '-e', 'process.exit(7)'])
    expect(failed.exitCode).toBe(7)
    expect(existsSync(join(root, SANDBOX_LOCK))).toBe(false)

    const status = await runCli(['status', '--name', SANDBOX_LOCK])
    expect(status.stdout).toContain('free')
  }, 30_000)

  test('run refuses to start while another lane holds the lock', async () => {
    const held = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', leaseSeconds: 600 })
    expect(held.ok).toBe(true)
    if (!held.ok) return

    const blocked = await runCli(['run', '--name', SANDBOX_LOCK, '--label', 'lane-b', '--wait', '0', '--', 'bun', '-e', '""'])
    expect(blocked.exitCode).toBe(3)
    expect(blocked.stderr).toContain('lane-a')
    expect(ownerText(held.handle.dir)).toContain('label=lane-a')
  }, 30_000)

  test('reap refuses a warm holder from the command line too', async () => {
    const held = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', leaseSeconds: 600 })
    expect(held.ok).toBe(true)
    if (!held.ok) return

    const reap = await runCli(['reap', '--name', SANDBOX_LOCK])
    expect(reap.exitCode).toBe(3)
    expect(reap.stderr).toContain('refusing to reap')
    expect(existsSync(join(root, SANDBOX_LOCK))).toBe(true)
  }, 30_000)

  test('reap clears a cold lock and says so from the snapshot it acted on', async () => {
    // The positive control for the refusal above, and for the reap path's single
    // inspection: the shape this replaced inspected, reaped (which inspected
    // again) and then reported the FIRST snapshot, so a lock cleared by somebody
    // else in between was announced as reaped by us.
    const dir = join(root, SANDBOX_LOCK)
    writeLockByHand(dir, { label: 'lane-a', pid: await deadPid(), expiresInMs: -60_000 })

    const reap = await runCli(['reap', '--name', SANDBOX_LOCK])
    expect(reap.exitCode).toBe(0)
    expect(reap.stdout).toContain('cleared a cold lock')
    expect(reap.stdout).toContain('lane-a')
    expect(existsSync(dir)).toBe(false)
  }, 30_000)

  test('a root outside a system temp directory is refused at the command line', async () => {
    const child = Bun.spawn(['bun', cli, 'status', '--root', homedir()], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    expect(await child.exited).toBe(2)
    expect(stderr).toContain('outside a system temp directory')
  }, 30_000)
})

describe('the run wrapper hands its child CI\'s environment, not the agent shell\'s (F1.131)', () => {
  // Measured 2026-09-20 (WI-cc, D1.440-F): `codex-subagent-model-projection.test.ts`
  // projected `opus` under the lock — 1 pass / 4 fail — because the lane's shell
  // exported `CLAUDE_CODE_SUBAGENT_MODEL` + `_FORCE`, and the same bytes under
  // `env -u` of those two names were 5 pass / 0 fail. Since 2026-09-23 every lane
  // shell carries both. The names are the cdp launcher's own list, imported, so
  // this arm and the lock can never disagree about which names they mean.
  const cli = join(import.meta.dir, 'bun-test-lock.ts')
  const CONTROL = 'NESSY_LOCK_ENV_CONTROL'

  test('the spawned command sees none of the product-read names, and an unrelated name survives', async () => {
    const names = CONTAMINATING_ENV_NAMES.map(({ name }) => name)
    expect(names).toContain('CLAUDE_CODE_SUBAGENT_MODEL')
    expect(names).toContain('CLAUDE_CODE_SUBAGENT_MODEL_FORCE')
    const planted: Record<string, string> = Object.fromEntries(names.map((name) => [name, `planted-value-for-${name}`]))
    const probe = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify([...names, CONTROL])}.map((n) => [n, process.env[n] ?? null]))))`

    const child = Bun.spawn(['bun', cli, 'run', '--name', SANDBOX_LOCK, '--label', 'lane-env', '--', 'bun', '-e', probe], {
      cwd: import.meta.dir,
      env: { ...process.env, ...planted, [CONTROL]: 'kept', NESSY_TEST_LOCK_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    expect(await child.exited).toBe(0)

    const seen = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, string | null>
    // The control first: a probe that read nothing would report every name absent.
    expect(seen[CONTROL]).toBe('kept')
    for (const name of names) expect(seen[name] ?? null).toBeNull()
    // The lock says what it removed — by NAME. A value never leaves the process:
    // one of these names is a credential by construction.
    for (const name of names) expect(stderr).toContain(name)
    for (const value of Object.values(planted)) expect(stderr).not.toContain(value)
    expect(stdout).not.toContain('planted-value-for-')
  }, 30_000)

  test('the copy is total over the list, leaves the caller untouched, and says nothing on a clean shell', () => {
    const names = CONTAMINATING_ENV_NAMES.map(({ name }) => name)
    const parent: Record<string, string | undefined> = { [CONTROL]: 'kept', UNSET_BUT_LISTED: undefined }
    for (const name of names) parent[name] = 'x'

    const { env, stripped } = childEnvForRun(parent)
    expect(stripped).toEqual(names)
    expect(Object.keys(env)).toEqual([CONTROL])
    // The caller's object is the process environment in production; it must not be edited.
    expect(parent[names[0]!]).toBe('x')

    // CI's shape: none of the names present, so nothing is removed and nothing is announced.
    expect(childEnvForRun({ [CONTROL]: 'kept' })).toEqual({ env: { [CONTROL]: 'kept' }, stripped: [] })
  })
})

describe('the lint rule that guards destructive operands is not inert', () => {
  // A rule that matches nothing reads exactly like a clean directory. The first
  // version of this selector only matched `fs.rmSync(...)`, so it matched
  // nothing in `scripts/`, where every call site imports the bare function.
  test('every forbidden delete operand shape is reported', async () => {
    const eslint = join(import.meta.dir, '..', 'node_modules', '.bin', 'eslint')
    const probe = [
      'import { rmSync } from "node:fs"',
      'import fs from "node:fs"',
      'import { homedir, tmpdir } from "node:os"',
      'rmSync(homedir(), { recursive: true, force: true })',
      'fs.rmSync(tmpdir())',
      'rmSync(process.env.HOME)',
      'rmSync(process.env.HOME!)',
      '',
    ].join('\n')

    const child = Bun.spawn([eslint, '--stdin', '--stdin-filename', 'probe-positive-control.ts', '--format', 'json'], {
      cwd: import.meta.dir,
      stdin: new TextEncoder().encode(probe),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    await child.exited

    const parsed = JSON.parse(stdout) as Array<{ messages: Array<{ ruleId: string | null; line: number }> }>
    const lines = (parsed[0]?.messages ?? [])
      .filter((message) => message.ruleId === 'no-restricted-syntax')
      .map((message) => message.line)
      .sort((left, right) => left - right)
    expect(lines).toEqual([4, 5, 6, 7])
  }, 60_000)
})

describe('the lock is granted in arrival order (F1.474)', () => {
  // Measured 2026-09-24 (WJ-pp-a P-3): a lane waited out the default 1 800 s
  // while six others took the lock. Every waiter polled a bare `mkdir` every two
  // seconds, so whichever poll landed first after a release won, and arriving
  // first counted for nothing. A waiter now joins a queue — one ticket file per
  // waiter in a directory BESIDE the lock, never inside it — and only the
  // oldest live ticket may take the lock. These arms write that queue by hand,
  // because the on-disk format is the contract a waiter running a newer or an
  // older copy of this script reads.
  const cli = join(import.meta.dir, 'bun-test-lock.ts')
  const queueDir = (): string => join(root, `${SANDBOX_LOCK}.queue`)
  const tickets = (): string[] =>
    existsSync(queueDir()) ? readdirSync(queueDir()).filter((entry) => entry.endsWith('.ticket')) : []

  function writeTicketByHand(options: { label: string; pid: number; arrivedAtMs: number; ageMs?: number }): string {
    if (!existsSync(queueDir())) mkdirSync(queueDir())
    const token = crypto.randomUUID().replace(/-/g, '')
    const file = join(queueDir(), `${token}.ticket`)
    const lines = [
      `label=${options.label}`,
      `token=${token}`,
      `pid=${String(options.pid)}`,
      `arrived_at_ms=${String(options.arrivedAtMs)}`,
      `arrived_at=${new Date(options.arrivedAtMs).toISOString()}`,
    ]
    writeFileSync(file, `${lines.join('\n')}\n`)
    if (options.ageMs !== undefined) {
      const seconds = (Date.now() - options.ageMs) / 1_000
      utimesSync(file, seconds, seconds)
    }
    return file
  }

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(['bun', cli, ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, NESSY_TEST_LOCK_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    return { exitCode: await child.exited, stdout, stderr }
  }

  test('a newcomer does not overtake a live waiter that arrived first, even while the lock is free', async () => {
    // Deterministic on purpose: the lock is FREE, so the only thing that can
    // refuse lane-b is the queue. Before F1.474 this acquired at once.
    writeTicketByHand({ label: 'lane-a', pid: process.pid, arrivedAtMs: Date.now() - 5_000 })

    const late = await runCli(['acquire', '--name', SANDBOX_LOCK, '--label', 'lane-b'])
    expect(late.exitCode).toBe(3)
    expect(late.stderr).toContain('lane-a')
    expect(existsSync(join(root, SANDBOX_LOCK))).toBe(false)
    // lane-b gave up, so it leaves nothing behind; lane-a keeps its place.
    expect(tickets()).toHaveLength(1)
  }, 60_000)

  test('status names the waiters in the order they will be served, and its first line is unchanged', async () => {
    const now = Date.now()
    // Written LATER-arrival first, so a listing in directory order would be wrong.
    writeTicketByHand({ label: 'lane-b', pid: process.pid, arrivedAtMs: now - 1_000 })
    writeTicketByHand({ label: 'lane-a', pid: process.pid, arrivedAtMs: now - 2_000 })

    const text = await runCli(['status', '--name', SANDBOX_LOCK])
    expect(text.exitCode).toBe(0)
    expect(text.stdout.split('\n')[0]).toBe(`free (${join(realpathSync(root), SANDBOX_LOCK)})`)
    expect(text.stdout.indexOf('lane-a')).toBeGreaterThan(0)
    expect(text.stdout.indexOf('lane-b')).toBeGreaterThan(text.stdout.indexOf('lane-a'))

    const json = await runCli(['status', '--name', SANDBOX_LOCK, '--json'])
    const parsed = JSON.parse(json.stdout) as { state: string; queue?: Array<{ label: string }> }
    expect(parsed.state).toBe('free')
    expect((parsed.queue ?? []).map((waiter) => waiter.label)).toEqual(['lane-a', 'lane-b'])
  }, 60_000)

  test('a ticket whose waiter is gone, or has gone cold, holds nobody back and is cleared', async () => {
    const now = Date.now()
    const dead = writeTicketByHand({ label: 'lane-dead', pid: await deadPid(), arrivedAtMs: now - 10_000 })
    // A live pid cannot keep a ticket that stopped refreshing: removing a ticket
    // costs its owner nothing (its next refresh puts it back, arrival time
    // included), where keeping it would stall every waiter behind it.
    const cold = writeTicketByHand({ label: 'lane-cold', pid: process.pid, arrivedAtMs: now - 9_000, ageMs: 10 * 60_000 })

    const acquired = await runCli(['acquire', '--name', SANDBOX_LOCK, '--label', 'lane-b'])
    expect(acquired.exitCode).toBe(0)
    expect(ownerText(join(root, SANDBOX_LOCK))).toContain('label=lane-b')
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(cold)).toBe(false)
    expect(tickets()).toEqual([])
  }, 60_000)

  test('the head of an empty queue takes a free lock and leaves no ticket behind', async () => {
    const acquired = await runCli(['acquire', '--name', SANDBOX_LOCK, '--label', 'lane-a'])
    expect(acquired.exitCode).toBe(0)
    expect(ownerText(join(root, SANDBOX_LOCK))).toContain('label=lane-a')
    expect(tickets()).toEqual([])
  }, 60_000)

  test('two waiters one second apart: the earlier one gets the lock first, and nothing is written inside the lock', async () => {
    // The row's own control. The release is timed right after lane-a's poll, the
    // moment the old wait loop handed the lock to whichever OTHER waiter polled
    // next. Each waiter's command records the lock directory's contents: a
    // queue that wrote inside the lock would make an older copy's non-recursive
    // release fail with ENOTEMPTY.
    const held = acquireLock({ root, name: SANDBOX_LOCK, label: 'holder', leaseSeconds: 600 })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    const orderFile = join(root, 'order.log')
    const probe =
      "const fs = require('node:fs'); fs.appendFileSync(process.env.LOCK_ORDER_FILE, " +
      "process.env.LOCK_WAITER + ' ' + fs.readdirSync(process.env.LOCK_DIR).sort().join(',') + '\\n')"

    type Waiter = { child: ReturnType<typeof Bun.spawn>; stderr: () => string; waits: () => number }
    function spawnWaiter(label: string): Waiter {
      const child = Bun.spawn(
        ['bun', cli, 'run', '--name', SANDBOX_LOCK, '--label', label, '--wait', '120', '--', 'bun', '-e', probe],
        {
          cwd: import.meta.dir,
          env: {
            ...process.env,
            NESSY_TEST_LOCK_ROOT: root,
            LOCK_ORDER_FILE: orderFile,
            LOCK_DIR: held.ok ? held.handle.dir : '',
            LOCK_WAITER: label,
          },
          stdout: 'ignore',
          stderr: 'pipe',
        },
      )
      let text = ''
      void (async () => {
        const decoder = new TextDecoder()
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) text += decoder.decode(chunk)
      })()
      return { child, stderr: () => text, waits: () => (text.match(/waiting/g) ?? []).length }
    }
    async function until(what: string, predicate: () => boolean, waiters: Waiter[]): Promise<void> {
      const deadline = Date.now() + 60_000
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${waiters.map((w) => w.stderr()).join('\n---\n')}`)
        await Bun.sleep(25)
      }
    }

    const a = spawnWaiter('lane-a')
    let b: Waiter | undefined
    try {
      await until('lane-a to wait', () => a.waits() >= 1, [a])
      await Bun.sleep(1_000)
      b = spawnWaiter('lane-b')
      const bWaiting = b
      await until('lane-b to wait', () => bWaiting.waits() >= 1, [a, bWaiting])
      const seen = a.waits()
      await until('lane-a to poll again', () => a.waits() > seen, [a, bWaiting])
      releaseLock(held.handle)

      expect(await a.child.exited).toBe(0)
      expect(await bWaiting.child.exited).toBe(0)
      expect(readFileSync(orderFile, 'utf-8').trim().split('\n')).toEqual(['lane-a heartbeat,owner', 'lane-b heartbeat,owner'])
      expect(tickets()).toEqual([])
    } finally {
      a.child.kill()
      b?.child.kill()
    }
  }, 180_000)
})

describe('a run that gives up says so LOUDLY, on both streams (F1.556)', () => {
  // Measured 2026-09-24 (WJ-ay, proposed row 4): with 10–18 lanes queued, two
  // background `run`s waited out the 1 800 s default, printed one
  // `not acquired` line on STDERR only and exited 3 having run NOTHING — and
  // read like finished runs until the log was opened, because a log tail or a
  // stdout-only capture never shows that line. The default is now 7 200 s and a
  // give-up prints a banner on stderr AND stdout whose first and last lines say
  // the command did not run. Everything else is unchanged: the old stderr line
  // (first, byte for byte), rc 3, every flag, and the lock and queue files.
  const cli = join(import.meta.dir, 'bun-test-lock.ts')

  async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const child = Bun.spawn(['bun', cli, ...args], {
      cwd: import.meta.dir,
      env: { ...process.env, NESSY_TEST_LOCK_ROOT: root },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text()
    return { exitCode: await child.exited, stdout, stderr }
  }

  test('run waits 7 200 s by default, and the run path reads that constant; acquire keeps its default of 0', () => {
    expect((lockModule as Record<string, unknown>).DEFAULT_RUN_WAIT_SECONDS).toBe(7_200)
    const source = readFileSync(cli, 'utf-8')
    expect(source).toContain("const waitSeconds = numberFlag(flags, 'wait', DEFAULT_RUN_WAIT_SECONDS)")
    expect(source).not.toContain("waitSeconds: numberFlag(flags, 'wait', 1_800)")
    // CONTROL — `acquire` is a try, not a run, and its default stays 0.
    expect(source).toContain("waitSeconds: numberFlag(flags, 'wait', 0)")
  })

  test('a forced give-up: rc 3, the old stderr line first, the banner on BOTH streams, and the command never ran', async () => {
    const held = acquireLock({ root, name: SANDBOX_LOCK, label: 'lane-a', leaseSeconds: 600 })
    expect(held.ok).toBe(true)
    if (!held.ok) return
    const marker = join(root, 'ran.marker')
    const blocked = await runCli([
      'run', '--name', SANDBOX_LOCK, '--label', 'lane-b', '--wait', '0', '--',
      'bun', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ])
    expect(blocked.exitCode).toBe(3)
    expect(existsSync(marker)).toBe(false)
    // Byte-compatible: whatever read the old line still finds it, first.
    expect(blocked.stderr.startsWith('bun-test-lock: not acquired — ')).toBe(true)
    for (const [stream, text] of [['stdout', blocked.stdout], ['stderr', blocked.stderr]] as const) {
      const lines = text.trimEnd().split('\n')
      const banner = lines.filter((line) => line.includes('NOT ACQUIRED'))
      expect({ stream, banner: banner.length }).toEqual({ stream, banner: 2 })
      expect(banner[0]).toContain('DID NOT RUN')
      // The LAST line of the stream is the banner's own, so `tail -1` of a log shows it.
      expect({ stream, last: lines.at(-1) }).toEqual({ stream, last: banner[1] })
      expect(text).toContain('lane-b')
      expect(text).toContain('lane-a')
      expect(text).toContain('--wait 0')
      expect(text).toContain('writeFileSync')
    }
    expect(ownerText(held.handle.dir)).toContain('label=lane-a')
  }, 30_000)

  test('CONTROL: a run that acquires prints no banner on either stream', async () => {
    const ran = await runCli(['run', '--name', SANDBOX_LOCK, '--label', 'lane-a', '--', 'bun', '-e', 'process.exit(0)'])
    expect(ran.exitCode).toBe(0)
    expect(ran.stdout).not.toContain('NOT ACQUIRED')
    expect(ran.stderr).not.toContain('NOT ACQUIRED')
  }, 30_000)
})
