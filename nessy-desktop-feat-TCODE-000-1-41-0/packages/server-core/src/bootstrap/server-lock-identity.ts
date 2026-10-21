/**
 * Who holds the server lock, and is it really them?
 *
 * Split out of `headless-start.ts` so the decision can be tested without
 * dragging the bootstrap graph into a unit test. Everything here is pure except
 * `readProcessExecutable`, which is injectable for the same reason.
 */
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

export interface LockPayload {
  pid: number
  startedAt: number
  leaseId?: string
  /**
   * The executable that wrote the lock. Absent in both older formats, which is
   * why every read of it has to tolerate `undefined`.
   */
  executable?: string
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM') {
      return true
    }
    return false
  }
}

/**
 * Compared as a BASENAME, not a path.
 *
 * `ps -o comm=` answers differently per platform — macOS usually gives a full
 * path, Linux gives the command name truncated to 15 characters — so comparing
 * paths would call a live twin foreign on one platform and not the other. The
 * basename survives both, and it is enough for the question being asked: is the
 * process holding this PID the same PROGRAM that wrote the lock, or something
 * unrelated that inherited the number.
 */
export function executableIdentity(pathOrName: string | undefined): string | null {
  const trimmed = pathOrName?.trim()
  if (!trimmed) return null
  return basename(trimmed).toLowerCase()
}

/**
 * The executable of a live process, or `null` when it cannot be determined.
 *
 * `null` is load-bearing and must never be read as "does not match": Windows has
 * no `ps`, a process owned by another user can refuse, and in both cases the
 * lock holder may well be a real running server. See `isLockFromForeignProcess`.
 */
export function readProcessExecutable(pid: number): string | null {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return executableIdentity(out)
  } catch {
    return null
  }
}

/**
 * True only when we can PROVE the live PID belongs to a different program.
 *
 * `process.kill(pid, 0)` answers "is some process using this number", which is
 * not the same question — an unrelated process that inherited a recycled PID
 * passes it, and the app then refuses to start against a lock nobody holds.
 * `isLockFromPreviousBoot` already covers recycling ACROSS a reboot; this covers
 * recycling within one, which is the half that was open.
 *
 * Deliberately fail-closed. A lock with no recorded executable (both older
 * formats) and a live process we cannot inspect both return false — keep
 * refusing rather than evict a lock that might be genuinely held. Only a
 * confirmed mismatch of two known names is treated as stale.
 */
export function isLockFromForeignProcess(
  lock: LockPayload,
  readExecutable: (pid: number) => string | null = readProcessExecutable,
): boolean {
  const recorded = executableIdentity(lock.executable)
  if (!recorded) return false
  // Normalised on BOTH sides rather than trusting the reader to have done it.
  // The default reader does; an injected one, or a future platform branch that
  // returns a full path, would otherwise compare a path against a basename and
  // call every live twin foreign — which is the one mistake here that lets two
  // servers share a storage root.
  const live = executableIdentity(readExecutable(lock.pid) ?? undefined)
  if (!live) return false
  return live !== recorded
}

/**
 * Parse the lock file content. THREE formats are readable, and all three stay
 * readable on purpose — an upgrade must not be blocked by a lock the previous
 * version wrote:
 *
 *   1. `{pid, startedAt, leaseId, executable}` — current
 *   2. `{pid, startedAt, leaseId}` — before the executable was recorded
 *   3. a bare PID number — the original format
 */
export function parseLockContent(raw: string): LockPayload | null {
  const trimmed = raw.trim()
  // Try JSON first (new format)
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
      const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
      const leaseId = typeof parsed.leaseId === 'string' ? parsed.leaseId : undefined
      const executable = typeof parsed.executable === 'string' ? parsed.executable : undefined
      if (!isNaN(pid)) return { pid, startedAt, leaseId, executable }
    } catch { /* fall through to legacy parse */ }
  }
  // Legacy format: plain PID number
  const pid = parseInt(trimmed, 10)
  if (!isNaN(pid)) return { pid, startedAt: 0 }
  return null
}

