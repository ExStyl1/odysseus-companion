import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRetentionSweep } from '@nessy-agent/shared/sessions/retention-sweep'
import {
  PROCESS_LIST_READ_CONCURRENCY,
  PROCESS_RUNNING_INDEX_DIR_NAME,
  PROCESS_RUNNING_INDEX_SENTINEL_NAME,
  ProcessStore,
  resolveLogLimitBytes,
  type StoredProcess,
} from './process-store.ts'

/**
 * T32. `list()` used to open EVERY record in one `Promise.all`; on the owner's
 * profile that was 807 files at once against an Electron soft limit of 256, and
 * it killed a runtime switch with `EMFILE: too many open files`. The bound is
 * the fix, so the bound is what this pins.
 *
 * The spy is the store's own `get` — the exact call `list()` fans out — rather
 * than a `mock.module` over `node:fs/promises`, which is global to the test
 * process and would amputate the module for every file that loads afterwards.
 */
describe('ProcessStore.list fd fan-out', () => {
  const owner = { workspaceId: 'w', sessionId: 's' }
  const stranger = { workspaceId: 'w', sessionId: 'other' }

  async function seed(store: ProcessStore, count: number, key: typeof owner): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await store.create({
        sessionKey: key,
        executionId: `exec-${index}`,
        semanticId: 'bash',
        pid: null,
        startedAt: index,
        deadlineAt: index + 1_000,
        status: 'exited',
        exitCode: 0,
        signal: null,
        pidStartMarker: null,
        profile: 'workspace',
        isolationProfile: 'test',
        environmentProfile: 'restricted',
        environmentDigest: 'digest',
        cwd: '/tmp',
      })
    }
  }

  /**
   * Counts records open SIMULTANEOUSLY and holds each one open long enough that
   * an unbounded implementation would show all of them at once.
   */
  function watchSimultaneousReads(store: ProcessStore): { peak: () => number } {
    const real = store.get.bind(store)
    let open = 0
    let peak = 0
    store.get = async (handle: string): Promise<StoredProcess> => {
      open += 1
      peak = Math.max(peak, open)
      try {
        await new Promise(resolve => setTimeout(resolve, 5))
        return await real(handle)
      } finally {
        open -= 1
      }
    }
    return { peak: () => peak }
  }

  test('more records than the bound: the pool never exceeds it, and every record is still read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-t32-bound-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      const mine = PROCESS_LIST_READ_CONCURRENCY + 8
      await seed(store, mine, owner)
      await seed(store, 4, stranger)

      const watch = watchSimultaneousReads(store)
      const records = await store.list(owner)

      // The bound holds...
      expect(watch.peak()).toBeLessThanOrEqual(PROCESS_LIST_READ_CONCURRENCY)
      // ...and it is a real pool, not an accidental serialization: with more
      // work than readers every reader is busy at once at some point.
      expect(watch.peak()).toBe(PROCESS_LIST_READ_CONCURRENCY)
      // The answer is unchanged: this session's records only, all of them.
      expect(records).toHaveLength(mine)
      expect(new Set(records.map(record => record.executionId)).size).toBe(mine)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('fewer records than the bound: no more readers than there is work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-t32-under-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      await seed(store, 3, owner)

      const watch = watchSimultaneousReads(store)
      const records = await store.list(owner)

      expect(watch.peak()).toBe(3)
      expect(records).toHaveLength(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('an unreadable record still fails the whole list, exactly as Promise.all did', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-t32-reject-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      await seed(store, PROCESS_LIST_READ_CONCURRENCY + 2, owner)
      const real = store.get.bind(store)
      let seen = 0
      store.get = async (handle: string): Promise<StoredProcess> => {
        if (++seen === 1) throw new Error('record-unreadable')
        return await real(handle)
      }
      await expect(store.list(owner)).rejects.toThrow('record-unreadable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * P2.22. The settlement wanted ONE integer — how many supervised processes this
 * session still has running — and paid `list()` for it: a `readdir` of the
 * single global `.pi-processes` plus a JSON parse of every record in it, before
 * the owner filter could run. MEASURED on the owner's profile 2026-08-23: 897
 * records, 175-204 ms per call, and the goal continuation takes TWO per attempt.
 *
 * The running index is a durable set of markers under `.running/`, so the read
 * costs what is actually running app-wide (0 at rest) instead of what the store
 * has accumulated for the life of the install. These rows pin the three
 * properties that make it a legal substitute for the scan: it counts only the
 * asking session's records, it comes back DOWN when a process ends, and it
 * cannot silently start reporting zero for a store written before it existed.
 */
describe('ProcessStore running index', () => {
  const owner = { workspaceId: 'w', sessionId: 's' }
  const stranger = { workspaceId: 'w', sessionId: 'other' }

  async function add(
    store: ProcessStore,
    key: typeof owner,
    status: StoredProcess['status'],
    executionId: string,
  ): Promise<StoredProcess> {
    return await store.create({
      sessionKey: key,
      executionId,
      semanticId: 'bash',
      pid: null,
      startedAt: 1,
      deadlineAt: 1_000,
      status,
      exitCode: status === 'exited' ? 0 : null,
      signal: null,
      pidStartMarker: null,
      profile: 'workspace',
      isolationProfile: 'test',
      environmentProfile: 'restricted',
      environmentDigest: 'digest',
      cwd: '/tmp',
    })
  }

  test('counts this session\'s running records without opening the rest of the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-count-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      // The shape the defect was measured on: a store dominated by terminal
      // records, most of them somebody else's.
      for (let index = 0; index < PROCESS_LIST_READ_CONCURRENCY + 8; index += 1) {
        await add(store, stranger, 'exited', `stranger-${index}`)
      }
      for (let index = 0; index < 5; index += 1) await add(store, owner, 'exited', `mine-done-${index}`)
      await add(store, owner, 'running', 'mine-live-1')
      await add(store, owner, 'running', 'mine-live-2')
      await add(store, stranger, 'running', 'stranger-live')

      const real = store.get.bind(store)
      let opened = 0
      store.get = async (handle: string): Promise<StoredProcess> => {
        opened += 1
        return await real(handle)
      }

      expect(await store.countRunning(owner)).toBe(2)
      // The whole point: the cost is the RUNNING set (three records app-wide),
      // not the store (48). A regression back to a whole-store scan reddens
      // here rather than only on the owner's profile six months later.
      expect(opened).toBe(3)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * P2.523 — the LIST beside the count, and the claim that makes it worth
   * having: it costs no extra traversal.
   *
   * The row exists because a projection rendered an EMPTY process list beside a
   * settlement figure counting the same session's running processes, and both
   * could not be true. The cheap resolution is that `countRunning` already opens
   * every record it counts, so returning them is free — which is only true while
   * `countRunning` IS `.length` over this method. Asserted three ways, because
   * each can rot separately: the same `opened` budget the count's own row pins
   * (a regression to `list()` reddens here too), the two answers agreeing on the
   * same rig, and the records being the OWNER's running ones rather than
   * whatever the index happened to name.
   */
  test('returns the running records the count already opened, for the same cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p2523-list-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      for (let index = 0; index < PROCESS_LIST_READ_CONCURRENCY + 8; index += 1) {
        await add(store, stranger, 'exited', `stranger-${index}`)
      }
      for (let index = 0; index < 5; index += 1) await add(store, owner, 'exited', `mine-done-${index}`)
      await add(store, owner, 'running', 'mine-live-1')
      await add(store, owner, 'running', 'mine-live-2')
      await add(store, stranger, 'running', 'stranger-live')

      const real = store.get.bind(store)
      let opened = 0
      store.get = async (handle: string): Promise<StoredProcess> => {
        opened += 1
        return await real(handle)
      }

      const running = await store.listRunning(owner)
      // Three records opened — the RUNNING set app-wide, not the store's 48.
      // Identical to the budget `countRunning` is pinned at, which is the whole
      // claim: the list is the count's own walk, not a second one.
      expect(opened).toBe(3)
      expect(running).toHaveLength(2)
      expect(running.every(record => record.status === 'running')).toBe(true)
      expect(running.map(record => record.executionId).sort())
        .toEqual(['mine-live-1', 'mine-live-2'])

      // The two answers on the same rig, so they cannot drift apart the way the
      // list and the settlement figure did.
      opened = 0
      expect(await store.countRunning(owner)).toBe(running.length)
      expect(opened).toBe(3)

      // The stranger's own running record is reachable, so the emptiness above
      // is ownership and not an index that lost everything.
      expect((await store.listRunning(stranger)).map(record => record.executionId))
        .toEqual(['stranger-live'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a session with no records of its own counts zero, and so does an empty store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-zero-'))
    try {
      const empty = new ProcessStore({ root: join(root, 'empty') })
      expect(await empty.countRunning(owner)).toBe(0)

      const store = new ProcessStore({ root: join(root, 'store') })
      await add(store, stranger, 'running', 'stranger-live')
      await add(store, stranger, 'exited', 'stranger-done')
      expect(await store.countRunning(owner)).toBe(0)
      // The positive control for that zero on the same rig.
      expect(await store.countRunning(stranger)).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a terminal status write retires the record from the count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-exit-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      const record = await add(store, owner, 'running', 'mine-live')
      expect(await store.countRunning(owner)).toBe(1)

      // A cursor-only update — the one `append` performs on every log chunk —
      // must not disturb the index.
      await store.update(record.handle, { nextCursor: 64 })
      expect(await store.countRunning(owner)).toBe(1)

      // This IS the write the supervisor already performs when a child closes.
      await store.update(record.handle, { status: 'exited', exitCode: 0 })
      expect(await store.countRunning(owner)).toBe(0)
      // Empty of MARKERS. The P2.64 sentinel is not one, and is never retired.
      expect(await readdir(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME)))
        .toEqual([PROCESS_RUNNING_INDEX_SENTINEL_NAME])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a store written before the index existed is backfilled, not silently reported empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-legacy-'))
    try {
      const seeded = new ProcessStore({ root: join(root, 'store') })
      await add(seeded, owner, 'running', 'mine-live')
      await add(seeded, owner, 'exited', 'mine-done')
      await add(seeded, stranger, 'running', 'stranger-live')
      // Every install that upgrades into this change has records and no index.
      await rm(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })

      const upgraded = new ProcessStore({ root: join(root, 'store') })
      // Rounding a legacy `running` record down to idle is the direction that
      // dispatches an unattended turn over a live process.
      expect(await upgraded.countRunning(owner)).toBe(1)
      expect(await upgraded.countRunning(stranger)).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a marker whose record is terminal or gone is neither counted nor left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-heal-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      const terminalized = await add(store, owner, 'running', 'mine-terminalized')
      const pruned = await add(store, owner, 'running', 'mine-pruned')
      const live = await add(store, owner, 'running', 'mine-live')

      // A record moved to a terminal status by something other than `update`
      // (an older host process, a hand edit) …
      await writeFile(
        join(root, 'store', `${terminalized.handle}.json`),
        `${JSON.stringify({ ...terminalized, status: 'stopped' })}\n`,
      )
      // … and a record the retention sweep removed out from under its marker.
      await rm(join(root, 'store', `${pruned.handle}.json`))

      expect(await store.countRunning(owner)).toBe(1)
      expect((await readdir(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME))).sort())
        .toEqual([PROCESS_RUNNING_INDEX_SENTINEL_NAME, live.handle].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The failure direction this whole index has to keep, asserted where it is
   * cheapest to get wrong: an index the reader CANNOT READ is not an index with
   * nothing in it.
   *
   * REVIEW-PROBED on a warm store holding one live `running` record: a
   * `readdir` failure swallowed into `[]` answered **0** while `list()` still
   * returned that record — `settled: true` over a live process, which is the one
   * answer the settlement is never allowed to guess. Warm matters: on a resolved
   * `ensureRunningIndex` the guard does not re-run, so this is the shape a
   * long-lived host process is in rather than a cold-start artefact. And it is
   * not hypothetical for THIS directory — `retention-sweep.ts` records a
   * measured `EMFILE … scandir '…/.pi-processes'`.
   */
  test('an index the reader cannot read throws, and is never counted as zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-unreadable-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      await add(store, owner, 'running', 'mine-live')
      // Warm — the guard is resolved from here on.
      expect(await store.countRunning(owner)).toBe(1)

      // ENOTDIR: the index replaced by something that is not a directory.
      await rm(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })
      await writeFile(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), '')
      await expect(store.countRunning(owner)).rejects.toThrow()

      // ENOENT: `ensureRunningIndex` has already promised this directory exists,
      // so its absence is a broken promise, not an empty answer.
      await rm(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), { force: true })
      await expect(store.countRunning(owner)).rejects.toThrow()

      // The positive control on the same rig: the record those reads failed to
      // see is still there, and still running.
      expect((await store.list(owner)).filter(record => record.status === 'running')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * The same failure direction in the ONE scan that ever runs, where the mistake
   * is permanent.
   *
   * REVIEW-PROBED on a 40-record legacy store with 6 `running` and one read made
   * to fail mid-scan: the build did not throw, the half-index was renamed into
   * place, and every later count — including from a fresh instance — reported 5.
   * A record that will not PARSE is a different thing and is still skipped: it
   * can name neither its status nor its owner, so it cannot be counted for
   * anybody, and failing the build over it would break the settlement for every
   * session instead of for none. A read that FAILED names nothing either way,
   * which is exactly why it may not be treated as an answer.
   */
  test('a backfill record whose read fails with an errno fails the build instead of being dropped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-backfill-errno-'))
    try {
      const seeded = new ProcessStore({ root: join(root, 'store') })
      await add(seeded, owner, 'running', 'mine-live-1')
      const unreadable = await add(seeded, owner, 'running', 'mine-live-2')
      await add(seeded, owner, 'exited', 'mine-done')
      const corrupt = await add(seeded, owner, 'running', 'mine-corrupt')
      await writeFile(join(root, 'store', `${corrupt.handle}.json`), '{ not json')
      // Every install that upgrades into P2.22 is in this state.
      await rm(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })

      const upgraded = new ProcessStore({ root: join(root, 'store') })
      const real = upgraded.get.bind(upgraded)
      let failing: string | undefined = unreadable.handle
      upgraded.get = async (handle: string): Promise<StoredProcess> => {
        if (handle === failing) {
          const error: NodeJS.ErrnoException = new Error('EMFILE: too many open files, open record')
          error.code = 'EMFILE'
          throw error
        }
        return await real(handle)
      }

      await expect(upgraded.countRunning(owner)).rejects.toThrow('EMFILE')
      // Nothing was renamed into place, so the next call rebuilds instead of
      // inheriting a count that is short by one for the life of the store.
      expect(await readdir(join(root, 'store'))).not.toContain(PROCESS_RUNNING_INDEX_DIR_NAME)

      failing = undefined
      expect(await upgraded.countRunning(owner)).toBe(2)
      // … and the unparseable record was skipped rather than failing the retry.
      const rebuilt = await readdir(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME))
      expect(rebuilt.filter(name => name !== PROCESS_RUNNING_INDEX_SENTINEL_NAME)).toHaveLength(2)
      expect(rebuilt).toContain(PROCESS_RUNNING_INDEX_SENTINEL_NAME)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * P2.64. Three doors in the ONE scan that ever runs, all the same shape: a
 * FAILURE being read as an ANSWER.
 *
 * The row above pins the case the predicate already got right — an errno. These
 * pin the polarity itself (the skip list is now closed and the rethrow list
 * open, not the reverse), the rename the first build performs, and the existence
 * probe that decides whether that build happens at all.
 */
describe('ProcessStore running index — the build fails closed (P2.64)', () => {
  const owner = { workspaceId: 'w', sessionId: 's' }

  async function add(
    store: ProcessStore,
    status: StoredProcess['status'],
    executionId: string,
  ): Promise<StoredProcess> {
    return await store.create({
      sessionKey: owner,
      executionId,
      semanticId: 'bash',
      pid: null,
      startedAt: 1,
      deadlineAt: 1_000,
      status,
      exitCode: status === 'exited' ? 0 : null,
      signal: null,
      pidStartMarker: null,
      profile: 'workspace',
      isolationProfile: 'test',
      environmentProfile: 'restricted',
      environmentDigest: 'digest',
      cwd: '/tmp',
    })
  }

  function errno(code: string): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error(`${code}: injected`)
    error.code = code
    return error
  }

  /**
   * The measured shape, rebuilt: a legacy store with SIX `running` records and no
   * index, one record's read made to fail. Returns what the upgraded instance
   * makes of it.
   */
  async function backfillWith(root: string, thrown: unknown): Promise<{
    count: () => Promise<number>
    indexNames: () => Promise<string[]>
    indexExists: () => Promise<boolean>
    heal: () => void
  }> {
    const seeded = new ProcessStore({ root })
    const records: StoredProcess[] = []
    for (let index = 0; index < 6; index += 1) records.push(await add(seeded, 'running', `live-${index}`))
    await add(seeded, 'exited', 'done')
    // Every install that upgrades into P2.22 is in this state.
    await rm(join(root, PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })

    const upgraded = new ProcessStore({ root })
    const real = upgraded.get.bind(upgraded)
    let failing: string | undefined = records[3]!.handle
    upgraded.get = async (handle: string): Promise<StoredProcess> => {
      if (handle === failing) throw thrown
      return await real(handle)
    }
    return {
      count: () => upgraded.countRunning(owner),
      indexNames: async () => (await readdir(join(root, PROCESS_RUNNING_INDEX_DIR_NAME)))
        .filter(name => name !== PROCESS_RUNNING_INDEX_SENTINEL_NAME),
      indexExists: async () => (await readdir(root)).includes(PROCESS_RUNNING_INDEX_DIR_NAME),
      heal: () => { failing = undefined },
    }
  }

  /**
   * The three shapes {@link ProcessStore.get} can raise that describe a record
   * nobody can count — and which therefore stay skipped. The list is closed by
   * audit: `get` is `validateHandle` + `readFile` + `JSON.parse`, and the only
   * further shapes either of those two can raise (`ERR_FS_FILE_TOO_LARGE`,
   * `ERR_STRING_TOO_LONG`) carry a string `code` and are read FAILURES.
   */
  const SKIPPED: { label: string; thrown: unknown }[] = [
    { label: 'a record that will not parse', thrown: new SyntaxError('Unexpected token n in JSON at position 2') },
    { label: 'a stray *.json name in the store root', thrown: new Error('invalid-process-handle') },
    { label: 'a record retention pruned mid-scan', thrown: errno('ENOENT') },
  ]

  for (const { label, thrown } of SKIPPED) {
    test(`${label} is skipped, and the index is built without it`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'nessy-p264-skip-'))
      try {
        const probe = await backfillWith(join(root, 'store'), thrown)
        // Five of six, and permanent — the accepted price for a record that can
        // name neither its status nor its owner. Failing the build over one would
        // break the settlement for every session instead of for none.
        expect(await probe.count()).toBe(5)
        expect(await probe.indexNames()).toHaveLength(5)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  /**
   * The polarity itself. `isFilesystemReadFailure` used to rethrow ONLY errors
   * carrying a string `code`, so the SKIP list was the open-ended one — every
   * throw nobody had classified was silently treated as "this record is not
   * running".
   *
   * RED-PROVED against the pre-change predicate on this exact rig: both rows
   * below RESOLVED, `countRunning` answered **5** where the store holds 6
   * running records, the five-marker index was renamed into place, and a fresh
   * instance answered 5 as well — permanently, because the index is
   * authoritative once it exists.
   */
  // Each row asserts the rejection is the SAME VALUE the read threw, not merely
  // that something threw. The non-Error row used to carry a match-anything regex
  // literal — dot-star between slashes — which matches every rejection there can
  // be, so it checked nothing its own label promised and would have stayed green
  // if the build had swallowed the string and rethrown something of its own.
  const RETHROWN: { label: string; thrown: unknown }[] = [
    { label: 'a plain Error with no code', thrown: new Error('record-unreadable') },
    { label: 'a non-Error throw with no code', thrown: 'record-unreadable' },
  ]

  for (const { label, thrown } of RETHROWN) {
    test(`${label} fails the build instead of truncating the index`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'nessy-p264-rethrow-'))
      try {
        const probe = await backfillWith(join(root, 'store'), thrown)
        await expect(probe.count()).rejects.toBe(thrown)
        // Nothing was renamed into place, so the count is not short forever.
        expect(await probe.indexExists()).toBe(false)

        // The positive control on the same rig: the six ARE there, and the very
        // next call finds them once the read stops failing.
        probe.heal()
        expect(await probe.count()).toBe(6)
        expect(await probe.indexNames()).toHaveLength(6)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  /**
   * The first-build rename, with the sentinel doing the work a lock was recorded
   * as needing.
   *
   * The interleaving is the documented one, driven deterministically: a cold
   * builder is held after it has READ the store and before it renames, a second
   * builder wins the directory, and the record the first one saw as `running`
   * then ends. The loser's index is now STALE, and pre-change its rename
   * SUCCEEDED — POSIX `rename` replaces an empty directory — putting a marker for
   * an ended process back into a correct index.
   *
   * CORRECTION to the source doc, measured here rather than taken on trust: it
   * says such a window loses a marker. It cannot. `markRunning` resolves
   * `.running` by NAME at `open` time, so a marker always lands in whichever
   * directory is current, and a directory holding one is not empty — which makes
   * the racing rename fail rather than clobber. The reachable damage is this
   * stale OVERCOUNT, which `countRunning` retires on sight. The sentinel is
   * still what makes the "backs off on ENOTEMPTY" claim unconditional, and it is
   * what stops the probe row below from ever rebuilding over a live index.
   */
  test('the loser of a first-build race backs off on ENOTEMPTY instead of replacing the winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p264-race-'))
    const store = join(root, 'store')
    try {
      const seeded = new ProcessStore({ root: store })
      const record = await add(seeded, 'running', 'mine-live')
      await rm(join(store, PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })

      // The loser: cold, and held between its scan and its rename.
      const loser = new ProcessStore({ root: store })
      const real = loser.get.bind(loser)
      let release!: () => void
      let reached!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const atGate = new Promise<void>(resolve => { reached = resolve })
      loser.get = async (handle: string): Promise<StoredProcess> => {
        const value = await real(handle)
        reached()
        await gate
        return value
      }
      const losing = loser.countRunning(owner)
      await atGate

      // The winner: builds the same index and renames it in first…
      const winner = new ProcessStore({ root: store })
      expect(await winner.countRunning(owner)).toBe(1)
      // … and the record the loser read as running then ends, so the loser's
      // index is stale and the winner's is empty of markers.
      await winner.update(record.handle, { status: 'exited', exitCode: 0 })
      expect(await winner.countRunning(owner)).toBe(0)
      const built = (await stat(join(store, PROCESS_RUNNING_INDEX_DIR_NAME))).ino

      release()
      await losing

      // THE assertion, and the one that is not vacuous: it is the WINNER's
      // directory that is still there. Pre-change this inode changed — the
      // loser's rename replaced it, because an empty directory is exactly what
      // POSIX `rename` is allowed to replace.
      expect((await stat(join(store, PROCESS_RUNNING_INDEX_DIR_NAME))).ino).toBe(built)
      // The winner's index is intact, and never empty — the mechanism itself.
      // One assertion, not two: a `toBeGreaterThan(0)` after this `toEqual` is
      // implied by it and reads as a second check while pinning nothing.
      const names = await readdir(join(store, PROCESS_RUNNING_INDEX_DIR_NAME))
      expect(names).toEqual([PROCESS_RUNNING_INDEX_SENTINEL_NAME])
      expect(await winner.countRunning(owner)).toBe(0)
      // No temporary directory was left behind by the back-off.
      expect((await readdir(store)).filter(name => name.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the sentinel is invisible to countRunning — never counted, never opened, never retired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p264-sentinel-count-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      await add(store, 'running', 'mine-live')
      await add(store, 'exited', 'mine-done')

      const real = store.get.bind(store)
      const opened: string[] = []
      store.get = async (handle: string): Promise<StoredProcess> => {
        opened.push(handle)
        return await real(handle)
      }

      expect(await store.countRunning(owner)).toBe(1)
      // Exactly the one marker — the sentinel was filtered before any open.
      expect(opened).toHaveLength(1)
      expect(opened).not.toContain(PROCESS_RUNNING_INDEX_SENTINEL_NAME)
      // And the retiring sweep inside `countRunning` did not remove it: a second
      // read still finds it, so the ENOTEMPTY guarantee survives the first read.
      expect(await readdir(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME)))
        .toContain(PROCESS_RUNNING_INDEX_SENTINEL_NAME)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the sentinel is invisible to list() — it is not a record, and not in the record root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p264-sentinel-list-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      await add(store, 'running', 'mine-live')
      await add(store, 'exited', 'mine-done')

      const records = await store.list(owner)
      expect(records.map(entry => entry.executionId).sort()).toEqual(['mine-done', 'mine-live'])
      // The positive control for that absence on the same rig: the sentinel does
      // exist, one directory down, where `list()` never enumerates.
      expect(await readdir(join(root, 'store'))).toContain(PROCESS_RUNNING_INDEX_DIR_NAME)
      expect(await readdir(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME)))
        .toContain(PROCESS_RUNNING_INDEX_SENTINEL_NAME)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the sentinel is invisible to the retention sweep — the real sweep over a real index', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'nessy-p264-sentinel-sweep-'))
    try {
      const sessionsDir = join(configDir, 'sessions')
      // The production layout: the store IS `<sessionsDir>/.pi-processes`.
      const store = new ProcessStore({ root: join(sessionsDir, '.pi-processes') })
      const live = await add(store, 'running', 'mine-live')
      const done = await add(store, 'exited', 'mine-done')

      const index = join(sessionsDir, '.pi-processes', PROCESS_RUNNING_INDEX_DIR_NAME)
      const sentinel = join(index, PROCESS_RUNNING_INDEX_SENTINEL_NAME)
      // Everything in the tree is older than the cutoff, so nothing survives by
      // being fresh — only by the tier's allowlist.
      const ancient = new Date(Date.now() - 3650 * 24 * 60 * 60 * 1_000)
      for (const path of [index, sentinel, join(index, live.handle), join(sessionsDir, '.pi-processes')]) {
        await utimes(path, ancient, ancient)
      }
      for (const handle of [live.handle, done.handle]) {
        for (const suffix of ['.json', '.log']) {
          await utimes(join(sessionsDir, '.pi-processes', `${handle}${suffix}`), ancient, ancient)
        }
      }

      const report = runRetentionSweep({ configDir, sessionsDir, cutoffMs: Date.now() })

      // The tier is an allowlist over `<handle>.json`/`.log` in the store root,
      // so it never descends here and never names either of these.
      expect(report.removed.map(entry => entry.path)).not.toContain(sentinel)
      expect(report.removed.map(entry => entry.path)).not.toContain(index)
      expect(report.failed).toEqual([])
      expect(await readdir(index)).toContain(PROCESS_RUNNING_INDEX_SENTINEL_NAME)
      // The positive control that the sweep really ran on this rig: the settled
      // record, which the allowlist DOES name, is gone.
      expect(report.removed.map(entry => entry.path))
        .toContain(join(sessionsDir, '.pi-processes', `${done.handle}.json`))
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  /**
   * The existence probe. `readdir(…).then(() => true, () => false)` answered
   * "no index exists" for every failure, so a transient `EMFILE` — measured on
   * this very directory in `retention-sweep.ts`, and real inside Electron, which
   * does not inherit the shell's `ulimit -n` — sent a single process into a full
   * rebuild: it responded to "too many open files" by opening every record in
   * the store.
   *
   * `EMFILE` itself cannot be raised on demand without mocking `node:fs/promises`
   * globally (which amputates the module for every later test file), so the
   * branch — `code !== 'ENOENT'` — is exercised with two REAL non-`ENOENT`
   * errnos on the same syscall.
   *
   * The discriminator is NOT that the call rejects: pre-change it rejected too,
   * at the rename, having first scanned the whole store. It is that NOTHING IS
   * OPENED. RED-PROVED: against the pre-change probe both rows below still
   * rejected but had opened every record in the store first.
   */
  const PROBE_FAILURES: { label: string; place: (path: string) => Promise<void> }[] = [
    { label: 'ENOTDIR — the index replaced by a file', place: path => writeFile(path, '') },
    { label: 'ELOOP — the index replaced by a self-referential symlink', place: path => symlink(path, path) },
  ]

  for (const { label, place } of PROBE_FAILURES) {
    test(`a probe that fails with ${label} is not an answer, and no rebuild starts`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'nessy-p264-probe-'))
      try {
        const seeded = new ProcessStore({ root: join(root, 'store') })
        await add(seeded, 'running', 'mine-live')
        await add(seeded, 'exited', 'mine-done')
        await rm(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })
        await place(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME))

        const store = new ProcessStore({ root: join(root, 'store') })
        const real = store.get.bind(store)
        let opened = 0
        store.get = async (handle: string): Promise<StoredProcess> => {
          opened += 1
          return await real(handle)
        }

        await expect(store.countRunning(owner)).rejects.toThrow()
        // The whole point: the store was never scanned. A failing probe is not
        // permission to re-read every record under fd pressure.
        expect(opened).toBe(0)
        expect((await readdir(join(root, 'store'))).filter(name => name.endsWith('.tmp'))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  test('a genuine ENOENT still means no index, and still builds one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p264-probe-enoent-'))
    try {
      const seeded = new ProcessStore({ root: join(root, 'store') })
      await add(seeded, 'running', 'mine-live')
      await add(seeded, 'exited', 'mine-done')
      await rm(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME), { recursive: true, force: true })

      const store = new ProcessStore({ root: join(root, 'store') })
      const real = store.get.bind(store)
      let opened = 0
      store.get = async (handle: string): Promise<StoredProcess> => {
        opened += 1
        return await real(handle)
      }

      // The positive control for the two rows above, on the same rig: the ONE
      // negative answer the probe is still allowed to give does build.
      expect(await store.countRunning(owner)).toBe(1)
      expect(opened).toBeGreaterThan(0)
      expect(await readdir(join(root, 'store', PROCESS_RUNNING_INDEX_DIR_NAME)))
        .toContain(PROCESS_RUNNING_INDEX_SENTINEL_NAME)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * P3.320 — the ring drops the HEAD, and it has to say so.
   *
   * Every foreground Bash result on Pi is this method's output, so a command
   * that produced more than the window handed the model its TAIL with no
   * notice — indistinguishable from a command that simply stopped there. The
   * row that opened P3.320 claimed the opposite defect (no bound at all); the
   * bound was always here, measured at exactly 65 536 bytes over a 205 000-byte
   * append, and the silence was the real one.
   */
  test('says how much the ring dropped, and stays silent for a reader that lost nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p3320-store-'))
    try {
      const store = new ProcessStore({ root, maxLogBytes: 10 })
      const record = await store.create({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'e', semanticId: 'bash', pid: null,
        pidStartMarker: null, startedAt: 1, deadlineAt: 2, status: 'running', exitCode: null, signal: null,
        profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted',
        environmentDigest: 'digest', cwd: root,
      })

      // Under the window: byte-for-byte, no notice. Without this the row below
      // would also pass if the notice were unconditional.
      await store.append(record.handle, 'abcde')
      expect(await store.readLog(record.handle, 0)).toEqual({ output: 'abcde', nextCursor: 5 })

      // Over it: the head goes, and the notice names both numbers and the knob.
      await store.append(record.handle, 'fghijklmno')
      const rolled = await store.readLog(record.handle, 0)
      expect(rolled.output.startsWith('[earlier output dropped: 5 of 15 bytes produced;')).toBe(true)
      expect(rolled.output).toContain('this result holds the last 10 bytes')
      expect(rolled.output).toContain('NESSY_BASH_MAX_OUTPUT_LENGTH')
      expect(rolled.output.endsWith('fghijklmno')).toBe(true)
      expect(rolled.nextCursor).toBe(15)

      // A follower inside the window is untouched — the notice is keyed on the
      // CALLER having lost bytes, not on the ring having rolled at all.
      expect(await store.readLog(record.handle, 5)).toEqual({ output: 'fghijklmno', nextCursor: 15 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * P3.320 — the documented operator knob sizes the ring, and the default does
   * not move.
   *
   * `tools-reference.md#output-limits`: "`BASH_MAX_OUTPUT_LENGTH` sets how many
   * characters of output Claude Code reads back from the working file into a
   * command's result: 30,000 by default, up to a hard ceiling of 150,000." The
   * working file it reads back from is this store's log, and before this row an
   * operator who set that variable got documented behaviour on the Claude
   * subprocess and silence on Pi.
   *
   * Injected rather than set on `process.env`: an assignment would be a
   * process-wide mutation whose unlock is sticky for the rest of the run, which
   * is how a fix gets asserted with the fix removed.
   */
  test('honours the documented read-back knob, and an unset environment keeps the floor', async () => {
    // The default: 30 000 is BELOW the 65 536 floor, so nothing moves for an
    // install that sets nothing. This is the posture row — if it ever fails, the
    // default window changed for everyone.
    expect(resolveLogLimitBytes(undefined, {})).toBe(65_536)
    expect(resolveLogLimitBytes(undefined, { NESSY_BASH_MAX_OUTPUT_LENGTH: '30000' })).toBe(65_536)

    // Raised past the floor, in both spellings — ours and the documented one.
    expect(resolveLogLimitBytes(undefined, { NESSY_BASH_MAX_OUTPUT_LENGTH: '150000' })).toBe(150_000)
    expect(resolveLogLimitBytes(undefined, { BASH_MAX_OUTPUT_LENGTH: '150000' })).toBe(150_000)

    // The page calls 150,000 a ceiling, not a suggestion.
    expect(resolveLogLimitBytes(undefined, { NESSY_BASH_MAX_OUTPUT_LENGTH: '9999999' })).toBe(150_000)

    // A malformed value takes the default rather than shrinking the window to
    // nothing — an operator typo must not silently blind the model.
    expect(resolveLogLimitBytes(undefined, { NESSY_BASH_MAX_OUTPUT_LENGTH: 'lots' })).toBe(65_536)

    // An explicit host decision still wins outright: it is how the rollover
    // tests pin a five-byte ring, and an env var must not overrule it.
    expect(resolveLogLimitBytes(5, { NESSY_BASH_MAX_OUTPUT_LENGTH: '150000' })).toBe(5)
  })
})
