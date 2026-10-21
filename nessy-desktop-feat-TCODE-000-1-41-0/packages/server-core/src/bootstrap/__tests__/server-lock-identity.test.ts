/**
 * U2 — a recycled PID must not look like a running server.
 *
 * `process.kill(pid, 0)` answers "is some process using this number", not "is
 * OUR server using it". `isLockFromPreviousBoot` already covers a PID recycled
 * across a reboot; the half left open was recycling within one boot, where the
 * timestamp is recent and the number belongs to something else entirely. The
 * app then refuses to start against a lock nobody holds.
 *
 * The two cases the unit exists for pull in opposite directions, which is why
 * both are here: a live-but-foreign PID must be treated as stale, and our own
 * live twin must still be refused. A fix that only satisfies the first is a way
 * to run two servers on one storage root.
 */
import { describe, expect, it } from 'bun:test'
import {
  executableIdentity,
  isLockFromForeignProcess,
  parseLockContent,
} from '../server-lock-identity'

const OURS = '/Applications/Nessy Desktop.app/Contents/MacOS/Nessy Desktop'
const THEIRS = '/usr/bin/python3'

describe('server lock: whose PID is it', () => {
  it('treats a live PID running a different executable as stale', () => {
    const foreign = isLockFromForeignProcess(
      { pid: 4242, startedAt: Date.now(), executable: OURS },
      () => THEIRS,
    )

    expect(foreign).toBe(true)
  })

  it('still refuses a lock held by our own live twin', () => {
    const foreign = isLockFromForeignProcess(
      { pid: 4242, startedAt: Date.now(), executable: OURS },
      () => OURS,
    )

    expect(foreign).toBe(false)
  })

  it('compares basenames, so the same program at a different path is still ours', () => {
    // `ps -o comm=` answers differently per platform — a full path on macOS, a
    // 15-character command name on Linux. Comparing paths would evict a live
    // twin on one platform and not the other.
    const foreign = isLockFromForeignProcess(
      { pid: 4242, startedAt: Date.now(), executable: OURS },
      () => '/Users/someone/build/Nessy Desktop',
    )

    expect(foreign).toBe(false)
  })

  it('keeps refusing when the live process cannot be inspected', () => {
    // Windows has no `ps`, and a process owned by another user can refuse. Both
    // return null, and null must never be read as "does not match" — the lock
    // holder may be a real running server.
    expect(isLockFromForeignProcess(
      { pid: 4242, startedAt: Date.now(), executable: OURS },
      () => null,
    )).toBe(false)
  })

  it('keeps refusing a lock written before executables were recorded', () => {
    // Both older formats carry no executable. Evicting them on that basis would
    // make every upgrade a chance to start a second server.
    expect(isLockFromForeignProcess(
      { pid: 4242, startedAt: Date.now() },
      () => THEIRS,
    )).toBe(false)
  })

  it('reads a blank or missing executable as unknown, not as a name', () => {
    expect(executableIdentity(undefined)).toBeNull()
    expect(executableIdentity('   ')).toBeNull()
    expect(executableIdentity('/usr/bin/Node')).toBe('node')
  })
})

describe('server lock: three payload formats stay readable', () => {
  it('reads the current format, executable included', () => {
    const lock = parseLockContent(JSON.stringify({
      pid: 7, startedAt: 1234, leaseId: 'abc', executable: OURS,
    }))

    expect(lock).toEqual({ pid: 7, startedAt: 1234, leaseId: 'abc', executable: OURS })
  })

  it('reads the format written before the executable was recorded', () => {
    const lock = parseLockContent(JSON.stringify({ pid: 7, startedAt: 1234, leaseId: 'abc' }))

    expect(lock).toEqual({ pid: 7, startedAt: 1234, leaseId: 'abc', executable: undefined })
  })

  it('reads the original bare-PID format', () => {
    // An upgrade must not be blocked by a lock the previous version wrote.
    expect(parseLockContent('4242')).toEqual({ pid: 4242, startedAt: 0 })
  })

  it('returns null on content that names no process at all', () => {
    expect(parseLockContent('not a lock')).toBeNull()
    expect(parseLockContent('{"leaseId":"abc"}')).toBeNull()
  })
})
