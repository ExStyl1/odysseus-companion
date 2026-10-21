/**
 * P2.473 — the two windows `removeLockDirectory`'s fix left open on purpose,
 * driven ACROSS TWO REAL PROCESSES instead of described.
 *
 * ## Why this file exists
 *
 * P2.237 fixed the destructive half of the reap race and named two survivors in
 * its commit body, both non-destructive:
 *
 *  1. **Every release passes through a state where the lock reads as BLOCKED.**
 *     `removeLockDirectory` unlinks `owner`, then `heartbeat`, then `rmdir`s.
 *     A `bun scripts/bun-test-lock.ts status` landing between the first unlink
 *     and the `rmdir` sees a directory with no owner file and a warm lease, and
 *     `inspectLock` answers `blocked` — *"exists with no owner file and its
 *     grace period is still warm"*. A human is told the lock is held when it is
 *     being released. One poll, then the next reading is right.
 *  2. **A stale holder can write its heartbeat into a lock that was reaped and
 *     re-acquired underneath it**, bounded because the new holder's own refresh
 *     corrects it.
 *
 *  P2.473 recorded both, said the interleaving was *"proven by no test, and
 *  cannot be, because reproducing it means racing two real test processes for
 *  one lock — the exact thing the file exists to prevent"*, and added: *"if
 *  anyone builds an instrument for this, it belongs here."*
 *
 * ## The premise that turned out to be too strong
 *
 * Reproducing the interleaving does NOT require racing. It requires holding one
 * process inside the window while another reads — which a file handshake does
 * deterministically, with no timing assumption and no contention. There is no
 * seam inside `removeLockDirectory` or `refreshLock` to pause at, so the child
 * performs the window's own first step itself (`REMOVABLE_ENTRIES[0]`, read from
 * the module) and the parent reads with the REAL `inspectLock`. What is
 * reproduced is the pause; what is measured is the module's answer, in another
 * process, to a state a release genuinely passes through.
 *
 * ## Confinement
 *
 * A private `mkdtemp` root and lock names that are not the real
 * `nessy-bun-test.lock`, so this cannot touch the lock other lanes hold. Both
 * are validated by the module's own `resolveLockRoot` / `assertLockName`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLock,
  inspectLock,
  lockDirFor,
  reapExpiredLock,
  refreshLock,
  releaseLock,
} from './bun-test-lock.ts'

const RELEASE_LOCK = 'nessy-bun-test-w4b-window.lock'
const STALE_LOCK = 'nessy-bun-test-w4b-stale.lock'
const PROBE = new URL('./bun-test-lock-window-probe.ts', import.meta.url).pathname
/** Generous: this only bounds a child that never reached its marker. */
const HANDSHAKE_BUDGET_MS = 60_000
/**
 * Explicit per-case budget, because bun's default is 5 s and every case here
 * SPAWNS at least one `bun <file>` child — the window-2 case spawns two and
 * waits for the first to exit, which measured past the default under wave load
 * (5 003 ms, a timeout with zero assertion failures). Set against the measured
 * cost of a child start rather than at the resting floor, so it fires on a
 * genuinely stuck handshake and not on a loaded box.
 */
const CASE_BUDGET_MS = 120_000

let root: string
let syncDir: string
const children: Array<ReturnType<typeof Bun.spawn>> = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bun-test-lock-window-'))
  syncDir = join(root, 'sync')
  mkdirSync(syncDir)
  mkdirSync(join(root, 'config'))
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited.catch(() => undefined)
  }
  // Confined to this test's own mkdtemp directory, never a derived lock path.
  rmSync(root, { recursive: true, force: true })
})

function startProbe(mode: string, lockName: string) {
  const child = Bun.spawn(['bun', PROBE, mode, lockName, root, syncDir], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // The child inherits NODE_ENV=test and loads the repo-root bunfig's
      // top-level preload, but the isolate preload is `[test].preload` and does
      // not run for `bun <file>` — so `config/paths.ts` would throw its
      // refusing-to-touch-the-real-config guard. Point it at this test's own
      // sandbox, which is what that guard's message asks for.
      NESSY_CONFIG_DIR: join(root, 'config'),
    },
  })
  children.push(child)
  return child
}

async function awaitMarker(name: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const path = join(syncDir, name)
  const deadline = Date.now() + HANDSHAKE_BUDGET_MS
  while (!existsSync(path)) {
    if (child.exitCode !== null && !existsSync(path)) {
      const stderr = await new Response(child.stderr as ReadableStream).text().catch(() => '')
      throw new Error(`probe exited (${String(child.exitCode)}) before ${name}: ${stderr}`)
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for probe marker ${name}`)
    await Bun.sleep(10)
  }
}

function go(name: string): void {
  writeFileSync(join(syncDir, name), 'go\n', 'utf-8')
}

describe('P2.473 · window 1 — a release reads as BLOCKED to a concurrent process', () => {
  test('a second process inspecting mid-removal is told held, then free', async () => {
    const child = startProbe('release-window', RELEASE_LOCK)
    await awaitMarker('acquired', child)

    // Control: before the window, the module names the holder. Without this the
    // `blocked` below could be any failure at all.
    const held = inspectLock({ name: RELEASE_LOCK, root })
    expect(held.state).toBe('held')

    go('go-window')
    await awaitMarker('owner-gone', child)

    // THE WINDOW, held open across two processes. The owner file is gone and the
    // directory is not, which is exactly what `removeLockDirectory` leaves
    // between its first unlink and its `rmdir` — on every release, not only on a
    // reap.
    const midRemoval = inspectLock({ name: RELEASE_LOCK, root })
    expect(midRemoval.state).toBe('blocked')
    expect(midRemoval.state === 'blocked' && midRemoval.reason)
      .toContain('exists with no owner file and its grace period is still warm')

    // Second half of the same window: the heartbeat is gone too, so the lease
    // falls back to the directory's mtime — still warm, still `blocked`, and
    // still never `free`, which is the property that keeps it non-destructive.
    go('go-heartbeat')
    await awaitMarker('entries-gone', child)
    const afterEntries = inspectLock({ name: RELEASE_LOCK, root })
    expect(afterEntries.state).toBe('blocked')

    go('go-finish')
    await awaitMarker('removed', child)
    expect(inspectLock({ name: RELEASE_LOCK, root }).state).toBe('free')

    // And the cost is exactly one poll: the very next acquire succeeds.
    const next = acquireLock({ name: RELEASE_LOCK, root, label: 'after-window' })
    expect(next.ok).toBe(true)
    if (next.ok) releaseLock(next.handle)
  }, CASE_BUDGET_MS)

  test('the window is non-destructive: an acquire inside it cannot strand the holder', async () => {
    const child = startProbe('release-window', RELEASE_LOCK)
    await awaitMarker('acquired', child)
    go('go-window')
    await awaitMarker('owner-gone', child)

    // `mkdir` fails EEXIST, `inspectLock` says blocked, and the acquirer is
    // refused rather than stamping its identity into a directory another
    // process is still removing.
    const attempt = acquireLock({ name: RELEASE_LOCK, root, label: 'inside-the-window' })
    expect(attempt.ok).toBe(false)
    expect(attempt.ok === false && attempt.reason).toContain('blocked')

    go('go-heartbeat')
    await awaitMarker('entries-gone', child)
    go('go-finish')
    await awaitMarker('removed', child)
    expect(existsSync(lockDirFor({ name: RELEASE_LOCK, root }).dir)).toBe(false)
  }, CASE_BUDGET_MS)
})

describe('P2.473 · window 2 — a stale heartbeat is bounded by the new holder', () => {
  test('a takeover survives a stale writer, and the next refresh corrects the lease', async () => {
    const holder = startProbe('stale-acquire', STALE_LOCK)
    await awaitMarker('acquired', holder)
    // The holder must be GONE before the reap: `inspectLock` refuses to call a
    // cold lease expired while the recorded pid is alive, so a live child makes
    // the reap answer `blocked` and the takeover cannot legally happen. That is
    // the module being right; this line is the harness catching up to it.
    expect(await holder.exited).toBe(0)

    // Let the one-second lease go cold, then reap and take over — the real
    // functions, in this process, against a lock another process created.
    const coldAt = Date.now() + 2_000
    const reaped = reapExpiredLock({ name: STALE_LOCK, root }, coldAt)
    expect(reaped.state).toBe('expired')
    const taken = acquireLock({ name: STALE_LOCK, root, label: 'takeover', now: coldAt })
    expect(taken.ok).toBe(true)
    if (!taken.ok) return

    // The stale holder now writes its heartbeat into OUR lock, from a second
    // process carrying the original handle.
    const writer = startProbe('stale-write', STALE_LOCK)
    await awaitMarker('wrote-heartbeat', writer)

    const poisoned = inspectLock({ name: STALE_LOCK, root }, coldAt)
    expect(poisoned.state).toBe('held')
    // Ownership never moved — this is why the window is non-destructive. Only
    // the lease deadline is wrong, and it is wrong in the direction of holding
    // the lock LONGER, never of releasing it early.
    expect(poisoned.state === 'held' && poisoned.holder.label).toBe('takeover')
    expect(poisoned.state === 'held' && poisoned.msRemaining)
      .toBeGreaterThan(60 * 60 * 1_000 - 10_000)

    // The bound the row asserted, measured: the new holder's own refresh puts the
    // lease back where it belongs.
    refreshLock(taken.handle, coldAt)
    const corrected = inspectLock({ name: STALE_LOCK, root }, coldAt)
    expect(corrected.state).toBe('held')
    expect(corrected.state === 'held' && corrected.msRemaining)
      .toBeLessThanOrEqual(600 * 1_000)

    await awaitMarker('done', writer)
    // And the module's own guard refused the stale holder's `refreshLock`, so the
    // only way to reach this state at all is the sub-call window inside it.
    expect(readFileSync(join(syncDir, 'refresh-refusal'), 'utf-8'))
      .toContain('refusing to refresh')

    releaseLock(taken.handle)
  }, CASE_BUDGET_MS)
})
