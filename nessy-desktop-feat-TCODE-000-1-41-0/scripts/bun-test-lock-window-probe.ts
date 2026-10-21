/**
 * The CHILD half of the deterministic two-process lock harness (P2.473).
 *
 * `bun-test-lock-interleaving.test.ts` is the other process. Nothing here is
 * imported by that test except the mode names below — every side effect sits
 * behind `import.meta.main`, because a fixture whose module body runs on import
 * kills the runner at import time and reports exit 0 with zero tests executed.
 *
 * The handshake is files in a directory the parent owns: this process writes a
 * marker, then SPINS until the parent writes the matching go-file. Spinning
 * rather than signalling because the point is to hold a real on-disk state open
 * across two processes for as long as the reader needs, with no timing
 * assumption anywhere.
 *
 * Every path here is confined to the parent's `mkdtemp` sandbox: the lock root
 * is validated by `resolveLockRoot` (system temp only) and the lock name by
 * `assertLockName`. No real home directory is ever a target.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  REMOVABLE_ENTRIES,
  acquireLock,
  lockDirFor,
  refreshLock,
  type LockHandle,
} from './bun-test-lock.ts'

export const PROBE_MODES = ['release-window', 'stale-acquire', 'stale-write'] as const
export type ProbeMode = (typeof PROBE_MODES)[number]

/** Long enough that nothing here can expire while a parent is reading. */
const WINDOW_LEASE_SECONDS = 600
/** Short enough that the parent can reap it without waiting on a wall clock. */
const STALE_LEASE_SECONDS = 1

function mark(syncDir: string, name: string): void {
  writeFileSync(join(syncDir, name), `${process.pid}\n`, 'utf-8')
}

function waitFor(syncDir: string, name: string): void {
  const path = join(syncDir, name)
  // A bounded spin: if the parent dies, this child must not become the wedge
  // the lock exists to prevent.
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`probe: timed out waiting for ${name}`)
    Bun.sleepSync(10)
  }
}

function acquire(name: string, root: string, label: string, leaseSeconds: number): LockHandle {
  const result = acquireLock({ name, root, label, leaseSeconds })
  if (!result.ok) throw new Error(`probe: could not acquire (${result.reason})`)
  return result.handle
}

/**
 * Hold the lock OPEN inside the removal window and let the parent read it.
 *
 * `removeLockDirectory` has no seam to pause at, so the child performs its first
 * step itself — unlinking `REMOVABLE_ENTRIES[0]`, read from the module rather
 * than spelled here, so reordering the removal breaks this harness instead of
 * silently invalidating it. Everything else is the real thing: a real
 * `acquireLock`, a real directory, and a real second process calling the real
 * `inspectLock` while the state is held.
 */
function releaseWindow(name: string, root: string, syncDir: string): void {
  const handle = acquire(name, root, 'W4-b-probe-release', WINDOW_LEASE_SECONDS)
  mark(syncDir, 'acquired')
  waitFor(syncDir, 'go-window')

  unlinkSync(join(handle.dir, REMOVABLE_ENTRIES[0]))
  mark(syncDir, 'owner-gone')
  waitFor(syncDir, 'go-heartbeat')

  for (const entry of REMOVABLE_ENTRIES.slice(1)) {
    try {
      unlinkSync(join(handle.dir, entry))
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }
  mark(syncDir, 'entries-gone')
  waitFor(syncDir, 'go-finish')

  rmdirSync(handle.dir)
  mark(syncDir, 'removed')
}

/**
 * Take a short-leased lock, record the handle, and EXIT.
 *
 * Exiting is the point, and it is a correction to this harness's first draft.
 * `inspectLock` refuses to call a cold lease expired while the recorded pid is
 * still running — *"heartbeat cold + PID still alive -> BLOCKED, not reaped"* —
 * so a child that stayed alive holding the handle made the parent's
 * `reapExpiredLock` answer `blocked`, and the takeover this window needs could
 * not legally happen at all. The module was right and the test was wrong; the
 * takeover branch requires a dead holder, which is what this mode produces.
 *
 * The handle is written out because a `LockHandle` is a plain record, and the
 * next process needs the ORIGINAL token to reach `refreshLock`'s own guard.
 */
function staleAcquire(name: string, root: string, syncDir: string): void {
  const handle = acquire(name, root, 'W4-b-probe-stale', STALE_LEASE_SECONDS)
  writeFileSync(join(syncDir, 'handle.json'), JSON.stringify(handle), 'utf-8')
  mark(syncDir, 'acquired')
}

/**
 * The stale holder's write, after somebody else has taken the lock over.
 *
 * `refreshLock` is `assertStillOurs` + `writeExpiry` and neither half is
 * reachable alone, so the write is reproduced here — the same two keys the
 * module writes, with a deliberately wrong, far-future expiry. What the parent
 * then proves with the REAL functions is the row's claim about the damage: that
 * the new holder's own `refreshLock` corrects it.
 *
 * The real `refreshLock` is called too, with the original handle, and its
 * refusal recorded — so the file shows that the only way to reach the poisoned
 * state is the sub-call window INSIDE `refreshLock`, not the whole function.
 */
function staleWrite(name: string, root: string, syncDir: string): void {
  const handle = JSON.parse(readFileSync(join(syncDir, 'handle.json'), 'utf-8')) as LockHandle
  const { dir } = lockDirFor({ name, root })
  writeFileSync(
    join(dir, 'heartbeat'),
    [
      `refreshed_at=${new Date().toISOString()}`,
      `expires_at_ms=${Date.now() + 3_600_000}`,
      '',
    ].join('\n'),
    'utf-8',
  )
  mark(syncDir, 'wrote-heartbeat')
  let refusal = 'none'
  try {
    refreshLock(handle)
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  writeFileSync(join(syncDir, 'refresh-refusal'), refusal, 'utf-8')
  mark(syncDir, 'done')
}

if (import.meta.main) {
  const [mode, name, root, syncDir] = process.argv.slice(2)
  if (!mode || !name || !root || !syncDir) {
    throw new Error('probe: usage <mode> <lock-name> <lock-root> <sync-dir>')
  }
  mkdirSync(syncDir, { recursive: true })
  if (mode === 'release-window') releaseWindow(name, root, syncDir)
  else if (mode === 'stale-acquire') staleAcquire(name, root, syncDir)
  else if (mode === 'stale-write') staleWrite(name, root, syncDir)
  else throw new Error(`probe: unknown mode ${mode}`)
}
