import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { workspaceClaudeConfigDir } from '../agent/options.ts'
import { CONFIG_DIR, SESSIONS_DIR, WORKSPACES_DIR } from '../workspaces/paths.ts'
import {
  DAMAGED_LEGACY_CRON_SUFFIX,
  SESSION_CRON_EXPIRY_MS,
  openSessionCronStore,
  sessionCronFile,
} from './cron-store.ts'
import { loadSession, saveSession } from './storage.ts'
import type { StoredSession } from './types.ts'
import { runRetentionSweep } from './retention-sweep.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const CUTOFF = Date.now() - (7 * DAY_MS)

function daysAgo(days: number): number {
  return Date.now() - (days * DAY_MS)
}

function makeSession(
  workspaceId: string,
  id: string,
  options: { isArchived?: boolean; lastUsedAt?: number; archivedAt?: number } = {},
): StoredSession {
  return {
    id,
    workspaceId,
    createdAt: options.lastUsedAt ?? daysAgo(30),
    lastUsedAt: options.lastUsedAt ?? daysAgo(30),
    isArchived: options.isArchived,
    archivedAt: options.archivedAt,
    messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
}

/**
 * `saveSession` force-stamps `lastUsedAt` to now on every write, so a fixture
 * for an old session has to rewrite the JSONL header afterwards. This is the
 * same header `listSessions` reads, so the sweep still sees production data.
 */
async function saveAged(session: StoredSession, lastUsedAt: number): Promise<void> {
  await saveSession(session)
  const path = join(SESSIONS_DIR, session.workspaceId, session.id, 'session.jsonl')
  const lines = readFileSync(path, 'utf8').split('\n')
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), lastUsedAt })
  writeFileSync(path, lines.join('\n'))
}

/** Backdate a path so the config-root tier sees it as old. */
function backdate(path: string, days: number): void {
  const seconds = daysAgo(days) / 1000
  utimesSync(path, seconds, seconds)
}

/**
 * One session's cron store under an arbitrary workspace root, written through
 * the production writer and located by `sessionCronFile` itself — so a rename in
 * `cron-store.ts` fails a test here rather than quietly sweeping nothing. Shared
 * by every row below, whatever workspace root it is about.
 */
function seedCronFileUnder(workspaceRoot: string, sessionId: string): string {
  const store = openSessionCronStore(workspaceRoot, sessionId)
  store.create({ schedule: '0 9 * * *', recurring: true, prompt: `owned by ${sessionId}` })
  return sessionCronFile(workspaceRoot, sessionId)
}

describe('retention sweep — session tier, through the real store', () => {
  let workspaceId: string
  let configDir: string

  beforeEach(() => {
    workspaceId = `retention-sweep-${Date.now()}-${Math.random().toString(36).slice(2)}`
    configDir = mkdtempSync(join(tmpdir(), 'nessy-retention-'))
  })

  afterEach(() => {
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  function sweep(options: { dryRun?: boolean; cutoffMs?: number } = {}) {
    return runRetentionSweep({
      configDir,
      sessionsDir: SESSIONS_DIR,
      cutoffMs: CUTOFF,
      workspaceIds: [workspaceId],
      ...options,
    })
  }

  test('an UNARCHIVED session older than the cutoff is swept — the archived-only hole', async () => {
    await saveAged(makeSession(workspaceId, 'old-unarchived', { isArchived: false }), daysAgo(30))
    await saveSession(makeSession(workspaceId, 'old-archived', { isArchived: true, archivedAt: daysAgo(30) }))
    await saveSession(makeSession(workspaceId, 'fresh-unarchived', { isArchived: false }))

    const report = sweep()
    expect(report.failed).toEqual([])
    expect(report.removed.filter(entry => entry.pathClass === 'session').map(entry => entry.session?.sessionId).sort())
      .toEqual(['old-archived', 'old-unarchived'])

    expect(loadSession(workspaceId, 'old-unarchived')).toBeNull()
    expect(loadSession(workspaceId, 'old-archived')).toBeNull()
    expect(loadSession(workspaceId, 'fresh-unarchived')).not.toBeNull()
  })

  test('the whole session subtree goes, covering transcript, plans, tool results and file history', async () => {
    await saveAged(makeSession(workspaceId, 'subtree'), daysAgo(30))
    const sessionDir = join(SESSIONS_DIR, workspaceId, 'subtree')
    for (const child of ['plans', 'long_responses', 'file_checkpoints', 'attachments']) {
      mkdirSync(join(sessionDir, child), { recursive: true })
      writeFileSync(join(sessionDir, child, 'payload.json'), '{}')
    }
    expect(existsSync(join(sessionDir, 'session.jsonl'))).toBe(true)

    sweep()
    expect(existsSync(sessionDir)).toBe(false)
  })

  test('the emptied workspace session root is removed after its contents', async () => {
    await saveAged(makeSession(workspaceId, 'only'), daysAgo(30))
    const root = join(SESSIONS_DIR, workspaceId)
    expect(existsSync(root)).toBe(true)

    const report = sweep()
    expect(existsSync(root)).toBe(false)
    const rootRemoval = report.removed.find(entry => entry.pathClass === 'workspace-session-root')
    expect(rootRemoval?.path).toBe(root)
    // Ordering matters: the contents are reported before the directory that held them.
    expect(report.removed.indexOf(rootRemoval!)).toBe(report.removed.length - 1)
  })

  test('a workspace root that still holds a live session is kept', async () => {
    await saveAged(makeSession(workspaceId, 'old'), daysAgo(30))
    await saveSession(makeSession(workspaceId, 'fresh'))
    sweep()
    expect(existsSync(join(SESSIONS_DIR, workspaceId))).toBe(true)
    expect(loadSession(workspaceId, 'fresh')).not.toBeNull()
  })

  test('a dry run removes nothing and reports exactly what a real run removes', async () => {
    await saveAged(makeSession(workspaceId, 'old-a'), daysAgo(30))
    await saveAged(makeSession(workspaceId, 'old-b'), daysAgo(20))
    await saveSession(makeSession(workspaceId, 'fresh'))

    const dry = sweep({ dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(loadSession(workspaceId, 'old-a')).not.toBeNull()
    expect(loadSession(workspaceId, 'old-b')).not.toBeNull()

    const real = sweep()
    expect(real.removed.filter(entry => entry.pathClass === 'session').map(entry => entry.path).sort())
      .toEqual(dry.removed.filter(entry => entry.pathClass === 'session').map(entry => entry.path).sort())
    expect(loadSession(workspaceId, 'old-a')).toBeNull()
    expect(loadSession(workspaceId, 'fresh')).not.toBeNull()
  })

  /**
   * T8 (c). The scheduled-task file is the one class here whose question leads
   * with OWNERSHIP rather than age, so every row states which session owns the
   * file it is about. The fixture path is built by `sessionCronFile` itself —
   * the production helper — for the same reason the vendor tier builds its own
   * from `workspaceClaudeConfigDir`: a rename over there must fail a test here
   * rather than silently sweep nothing.
   *
   * T10 added the second condition — unowned AND untouched since the cutoff — so
   * a row about a REMOVED file now backdates it. In production that costs
   * nothing: the file's mtime moves with the session's own activity, because
   * every writer in `cron-store.ts` rewrites the whole file.
   */
  describe('the scheduled-task tier', () => {
    const cronRoot = () => join(configDir, 'workspaces', workspaceId)

    function seedCronFile(sessionId: string): string {
      return seedCronFileUnder(cronRoot(), sessionId)
    }

    test('an orphaned file — its session was deleted cold — is removed', async () => {
      await saveSession(makeSession(workspaceId, 'still-here'))
      const orphan = seedCronFile('deleted-long-ago')
      const live = seedCronFile('still-here')
      // The orphan is aged past the cutoff; the live one is left FRESH, so the
      // pass has to separate them on ownership rather than on age.
      backdate(orphan, 30)
      expect(existsSync(orphan)).toBe(true)

      const report = sweep()
      expect(report.failed).toEqual([])
      expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
        .toEqual([orphan])
      expect(existsSync(orphan)).toBe(false)
      expect(existsSync(live)).toBe(true)
      // The directory itself stays, like `logs` and `feedback`.
      expect(existsSync(dirname(orphan))).toBe(true)
    })

    test('a session swept by the session tier takes its schedule with it, in the same pass', async () => {
      await saveAged(makeSession(workspaceId, 'aged-out'), daysAgo(30))
      const file = seedCronFile('aged-out')
      // A session last used thirty days ago has not written its store since
      // either — nothing can write it while the session is not loaded.
      backdate(file, 30)

      const report = sweep()
      expect(report.removed.filter(entry => entry.pathClass === 'session').map(entry => entry.session?.sessionId))
        .toEqual(['aged-out'])
      expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
        .toEqual([file])
      expect(existsSync(file)).toBe(false)
    })

    /**
     * T10 — the hole T8's review found. `listSessions` is NOT the set of live
     * sessions: it silently omits an EPHEMERAL session (which never writes a
     * `session.jsonl` — `store-v2.create` skips the write, `list` skips the
     * directory) and a session whose header has not landed or does not parse.
     * Both hold a live cron store, and before the mtime floor a sweep running in
     * a SECOND process on the same `CONFIG_DIR` deleted it out from under them
     * with no error on either side — the store re-reads per call, so `list()`
     * just went empty.
     *
     * The second half of this row is the positive control: the very same files,
     * backdated, ARE swept. Without it the row would also pass on a tier that
     * had stopped looking in this directory at all.
     */
    test('a live session the session list cannot see keeps its store; the floor is the only thing keeping it', () => {
      // What an ephemeral session leaves on disk: the directory, no session file.
      mkdirSync(join(SESSIONS_DIR, workspaceId, 'ephemeral-live'), { recursive: true })
      // …and a session whose header has not landed yet, or never parses.
      const unlisted = join(SESSIONS_DIR, workspaceId, 'header-never-parsed')
      mkdirSync(unlisted, { recursive: true })
      writeFileSync(join(unlisted, 'session.jsonl'), '{ not json at all\n', 'utf8')

      const ephemeralFile = seedCronFile('ephemeral-live')
      const unparsedFile = seedCronFile('header-never-parsed')

      const report = sweep()
      expect(report.failed).toEqual([])
      expect(report.removed.filter(entry => entry.pathClass === 'session-cron')).toEqual([])
      expect(existsSync(ephemeralFile)).toBe(true)
      expect(existsSync(unparsedFile)).toBe(true)

      backdate(ephemeralFile, 30)
      backdate(unparsedFile, 30)
      const later = sweep()
      expect(later.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path).sort())
        .toEqual([ephemeralFile, unparsedFile].sort())
      expect(existsSync(ephemeralFile)).toBe(false)
      expect(existsSync(unparsedFile)).toBe(false)
    })

    /**
     * T10 fix wave. The floor above is only a floor while `cutoffMs` is older
     * than a live store's quiet stretch, and `retentionDays` is user-settable
     * down to 1 — a day-old cutoff sits well inside the seven days a live store
     * can legitimately go unwritten (a weekly schedule rewrites the file once a
     * week; an armed store waiting to fire does not rewrite it at all). So the
     * tier compares against `min(cutoffMs, now − SESSION_CRON_EXPIRY_MS)`.
     *
     * Both halves in one row, on the same rig: the two-day-old live store is
     * kept, and the eight-day-old orphan in the same directory is still
     * collected — so the row cannot pass on a tier that simply stopped looking.
     */
    test('a one-day retention setting cannot eat a live store, and still collects the aged orphan', () => {
      mkdirSync(join(SESSIONS_DIR, workspaceId, 'ephemeral-live'), { recursive: true })
      const live = seedCronFile('ephemeral-live')
      const orphan = seedCronFile('deleted-long-ago')
      backdate(live, 2)
      backdate(orphan, (SESSION_CRON_EXPIRY_MS / DAY_MS) + 1)

      const report = sweep({ cutoffMs: daysAgo(1) })
      expect(report.failed).toEqual([])
      expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
        .toEqual([orphan])
      expect(existsSync(live)).toBe(true)
      expect(existsSync(orphan)).toBe(false)
    })

    test('a live session keeps its schedule however old the file is', async () => {
      await saveSession(makeSession(workspaceId, 'weekly'))
      const file = seedCronFile('weekly')
      backdate(file, 3650)

      const report = sweep()
      expect(report.removed.filter(entry => entry.pathClass === 'session-cron')).toEqual([])
      expect(existsSync(file)).toBe(true)
    })

    test('anything that is not a `<sessionId>.json` survives, and a dry run removes nothing', async () => {
      const orphan = seedCronFile('gone')
      backdate(orphan, 30)
      const unnamed = join(dirname(orphan), 'notes.md')
      writeFileSync(unnamed, 'not ours', 'utf8')
      backdate(unnamed, 30)

      const dry = sweep({ dryRun: true })
      expect(dry.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
        .toEqual([orphan])
      expect(existsSync(orphan)).toBe(true)

      sweep()
      expect(existsSync(orphan)).toBe(false)
      expect(existsSync(unnamed)).toBe(true)
    })

    /**
     * A symlinked cron file is skipped, and the property doing the skipping is
     * INCIDENTAL rather than stated anywhere: `entry.isFile()` is false for a
     * `DT_LNK` entry, so the allowlist's first clause rejects the link before
     * its `<sessionId>.json` name is ever read. Nothing declares that intent, so
     * it is pinned here — a switch to `statSync`-based typing (which follows the
     * link) would make `link.json` a nameable cron file pointing out of the
     * store, and this row would go red.
     *
     * The load-bearing assertion is the REPORT, not the target: `rmSync` unlinks
     * a symlink instead of following it, so the target survives a removal too.
     * What must not happen is the tier NAMING the link at all. The aged orphan
     * beside it is the positive control — without it the row would also pass on
     * a tier that had stopped looking in this directory.
     */
    test('a symlinked cron file is not a cron file, and the tier never names it', () => {
      const orphan = seedCronFile('gone')
      backdate(orphan, 30)
      // The link's target is outside the store, and old enough that a tier
      // willing to consider the link would collect it.
      const outside = join(configDir, 'outside-the-cron-store.json')
      writeFileSync(outside, '{"tasks":[]}', 'utf8')
      backdate(outside, 30)
      const link = join(dirname(orphan), 'link.json')
      symlinkSync(outside, link)

      const report = sweep()
      expect(report.failed).toEqual([])
      expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
        .toEqual([orphan])
      expect(existsSync(link)).toBe(true)
      expect(existsSync(outside)).toBe(true)
    })

    /**
     * T11 — the tier never visited a workspace the config no longer lists.
     * Production hands `runRetentionSweep` a `workspaceIds` built from
     * `config.workspaceRefs` (`config/storage.ts`), the session tier enumerates
     * exactly that list, and the cron tier used to read the map the session tier
     * filled — so a workspace REMOVED from the registry kept its `crons/`
     * directory, and every file in it, forever. The tier now enumerates `crons/`
     * from the FILESYSTEM, under the same `<configDir>/workspaces/<id>` anchor
     * `cron-store.ts` writes to.
     *
     * Ownership means the same thing over there, which is what the last row
     * pins: `listSessions` is keyed by PATH (`getWorkspaceSessionRootPath` →
     * `<sessionsDir>/<workspaceId>`) and never consults the registry, so a
     * dropped workspace whose session directories are still on disk still lists
     * those sessions and they still own their stores. "Dropped from config" is
     * therefore NOT "has no owner list" — the ownership half of the predicate is
     * asked, and answered, exactly as it is for a listed workspace.
     *
     * Every row here uses a workspace id the `sweep()` helper does NOT pass in
     * `workspaceIds`, and every row carries its own positive control in the same
     * directory, so none of them can pass on a tier that stopped looking.
     */
    describe('a workspace dropped from the registry', () => {
      let dropped: string
      const droppedRoot = () => join(configDir, 'workspaces', dropped)

      beforeEach(() => {
        dropped = `${workspaceId}-dropped`
      })

      afterEach(() => {
        rmSync(join(SESSIONS_DIR, dropped), { recursive: true, force: true })
      })

      function seedDroppedCronFile(sessionId: string): string {
        return seedCronFileUnder(droppedRoot(), sessionId)
      }

      test('its orphaned store is swept, and the directory it lived in stays', () => {
        const orphan = seedDroppedCronFile('gone-with-the-workspace')
        backdate(orphan, 30)

        const report = sweep()
        expect(report.failed).toEqual([])
        expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
          .toEqual([orphan])
        expect(existsSync(orphan)).toBe(false)
        // Kept like `logs` and `feedback`; the store recreates it on demand.
        expect(existsSync(dirname(orphan))).toBe(true)
      })

      test('the floor applies there too — a fresh store survives a one-day cutoff, the aged one goes', () => {
        const live = seedDroppedCronFile('quietly-armed')
        const orphan = seedDroppedCronFile('deleted-long-ago')
        backdate(live, 2)
        backdate(orphan, (SESSION_CRON_EXPIRY_MS / DAY_MS) + 1)

        const report = sweep({ cutoffMs: daysAgo(1) })
        expect(report.failed).toEqual([])
        expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
          .toEqual([orphan])
        expect(existsSync(live)).toBe(true)
        expect(existsSync(orphan)).toBe(false)
      })

      test('a quarantined `.damaged` file survives everything, while the orphan beside it is collected', () => {
        const orphan = seedDroppedCronFile('collected')
        backdate(orphan, 30)
        // What `adoptLegacySessionCronStore` leaves behind: not a `.json` name,
        // so the tier's allowlist keeps it out of reach by construction — the
        // property that must survive the widened enumeration. The suffix comes
        // from the production constant so a rename fails here.
        const quarantined = `${sessionCronFile(droppedRoot(), 'quarantined')}${DAMAGED_LEGACY_CRON_SUFFIX}`
        writeFileSync(quarantined, '{ "tasks": [ truncated', 'utf8')
        backdate(quarantined, 3650)

        const report = sweep()
        expect(report.failed).toEqual([])
        expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
          .toEqual([orphan])
        expect(existsSync(quarantined)).toBe(true)
      })

      test('a session the store still lists owns its file, registry or no registry', async () => {
        // The semantics this row pins: `listSessions` is path-keyed, so dropping
        // the workspace from `config.workspaceRefs` leaves its sessions listable
        // and owning. Both files are ancient, so only ownership separates them.
        await saveSession(makeSession(dropped, 'still-here'))
        const owned = seedDroppedCronFile('still-here')
        const orphan = seedDroppedCronFile('long-gone')
        backdate(owned, 3650)
        backdate(orphan, 3650)

        const report = sweep()
        expect(report.failed).toEqual([])
        expect(report.removed.filter(entry => entry.pathClass === 'session-cron').map(entry => entry.path))
          .toEqual([orphan])
        expect(existsSync(owned)).toBe(true)
        // …and the session tier still only touches the workspaces it was given.
        expect(report.removed.filter(entry => entry.pathClass === 'session')).toEqual([])
      })
    })

    /**
     * The `unreadableSessionLists` guard, which T11 shipped untested on the
     * belief that forcing `listSessions` to throw "is not portable on this rig".
     * It is: `chmodSync(dir, 0o000)` makes the `readdirSync` inside
     * `listSessions` raise EACCES, and nothing there catches it. Root reads
     * through any mode, so both rows skip themselves under uid 0 instead of
     * asserting a permission that does not exist there.
     *
     * Both rows restore 0o700 in a `finally`: a 0o000 directory is not removable
     * either, so without it the suite's own `afterEach` would fail on the
     * fixture it just made.
     *
     * The pair is what pins the guard, because each half alone is ambiguous. A
     * failure count of one on a DROPPED workspace shows the cron tier's own ask
     * failing safe; the same count on a REGISTERED one — where tier 1 has
     * already asked and already failed — is only one because the guard stopped
     * the second ask. Two entries there is the regression.
     */
    describe('a sessions directory the sweep cannot read', () => {
      const isRoot = process.getuid?.() === 0
      let unreadable: string

      beforeEach(() => {
        unreadable = `${workspaceId}-unreadable`
      })

      afterEach(() => {
        rmSync(join(SESSIONS_DIR, unreadable), { recursive: true, force: true })
      })

      test('a dropped workspace fails safe: one failure, no removals, the ancient orphan stays', () => {
        if (isRoot) return
        const orphan = seedCronFileUnder(join(configDir, 'workspaces', unreadable), 'long-gone')
        backdate(orphan, 3650)
        const sessionsRoot = join(SESSIONS_DIR, unreadable)
        mkdirSync(sessionsRoot, { recursive: true })
        chmodSync(sessionsRoot, 0o000)

        try {
          const report = sweep()
          // The tier had to ASK — this workspace is not in `workspaceIds`, so
          // the session tier's map holds nothing for it — and the ask threw.
          expect(report.failed.map(entry => entry.path)).toEqual([sessionsRoot])
          expect(report.removed.filter(entry => entry.pathClass === 'session-cron')).toEqual([])
          // A failed enumeration must never read as "no session owns this file",
          // however old the file is.
          expect(existsSync(orphan)).toBe(true)
        } finally {
          chmodSync(sessionsRoot, 0o700)
        }
      })

      test('a registered workspace is reported ONCE — the tier does not re-ask what tier 1 already failed', () => {
        if (isRoot) return
        const orphan = seedCronFile('long-gone')
        backdate(orphan, 3650)
        const sessionsRoot = join(SESSIONS_DIR, workspaceId)
        mkdirSync(sessionsRoot, { recursive: true })
        chmodSync(sessionsRoot, 0o000)

        try {
          const report = sweep()
          // Tier 1 threw and remembered it; the cron tier reaches the same
          // workspace from the filesystem and skips it on that memory. Without
          // the set this is two identical entries for one directory.
          expect(report.failed.map(entry => entry.path)).toEqual([sessionsRoot])
          expect(report.removed.filter(entry => entry.pathClass === 'session-cron')).toEqual([])
          expect(existsSync(orphan)).toBe(true)
        } finally {
          chmodSync(sessionsRoot, 0o700)
        }
      })
    })
  })
})

describe('retention sweep — the never-swept set', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'nessy-retention-never-'))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  test('history.jsonl survives regardless of age', () => {
    // No prompt-history file exists in this layout, so the documented
    // "kept until you delete them" class is proved by construction: the sweep is
    // an allowlist and never names it. Pinned so an opt-out refactor fails loudly.
    const history = join(configDir, 'history.jsonl')
    writeFileSync(history, '{"prompt":"never delete me"}\n')
    backdate(history, 3650)

    const report = runRetentionSweep({
      configDir,
      sessionsDir: join(configDir, 'sessions'),
      cutoffMs: CUTOFF,
      workspaceIds: [],
    })

    expect(report.removed.map(entry => entry.path)).not.toContain(history)
    expect(existsSync(history)).toBe(true)
    expect(readFileSync(history, 'utf8')).toContain('never delete me')
  })

  test('the config root and its long-lived files survive regardless of age', () => {
    const survivors = ['config.json', 'credentials.enc', 'preferences.json', 'recent-projects.json']
    for (const name of survivors) {
      const path = join(configDir, name)
      writeFileSync(path, '{}')
      backdate(path, 3650)
    }
    // And the count-capped config backups, which are the only copy of the registry.
    const backup = join(configDir, 'config.json.bak-2020-01-01')
    writeFileSync(backup, '{}')
    backdate(backup, 3650)

    runRetentionSweep({ configDir, sessionsDir: join(configDir, 'sessions'), cutoffMs: CUTOFF, workspaceIds: [] })

    for (const name of [...survivors, 'config.json.bak-2020-01-01']) {
      expect(existsSync(join(configDir, name))).toBe(true)
    }
  })

  test('.pi-processes is never a workspace, and nothing unrecognised inside it is swept', () => {
    const sessionsDir = join(configDir, 'sessions')
    const markers = join(sessionsDir, '.pi-processes')
    mkdirSync(markers, { recursive: true })
    // Deliberately NOT a handle-shaped record: the tier is an allowlist, so a
    // name it does not recognise survives by construction, at any age.
    const marker = join(markers, 'session-1.json')
    writeFileSync(marker, '{"pid":1}')
    backdate(marker, 3650)
    const scratch = join(markers, 'scratch')
    mkdirSync(scratch, { recursive: true })
    backdate(scratch, 3650)
    backdate(markers, 3650)

    // Enumerated mode — no explicit workspaceIds, so the sweep walks the root
    // itself. This is the path where the exclusion is load-bearing.
    const report = runRetentionSweep({ configDir, sessionsDir, cutoffMs: CUTOFF })

    expect(report.removed).toEqual([])
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(scratch)).toBe(true)
    // The directory itself is kept, exactly like `logs` and `feedback`.
    expect(existsSync(markers)).toBe(true)
  })

  test('an explicit .pi-processes in workspaceIds is filtered out too', () => {
    const sessionsDir = join(configDir, 'sessions')
    mkdirSync(join(sessionsDir, '.pi-processes'), { recursive: true })
    const report = runRetentionSweep({
      configDir, sessionsDir, cutoffMs: CUTOFF, workspaceIds: ['.pi-processes'],
    })
    expect(report.removed).toEqual([])
    expect(report.failed).toEqual([])
  })
})

describe('retention sweep — the Pi process-record tier', () => {
  let configDir: string
  let sessionsDir: string
  let store: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'nessy-retention-pi-'))
    sessionsDir = join(configDir, 'sessions')
    store = join(sessionsDir, '.pi-processes')
    mkdirSync(store, { recursive: true })
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  /** One record as `ProcessStore` writes it: `<handle>.json` plus `<handle>.log`. */
  function record(handle: string, ageDays: number): { json: string; log: string } {
    const json = join(store, `${handle}.json`)
    const log = join(store, `${handle}.log`)
    writeFileSync(json, `${JSON.stringify({ handle, status: 'exited', pid: 1 })}\n`)
    writeFileSync(log, 'output\n')
    backdate(json, ageDays)
    backdate(log, ageDays)
    return { json, log }
  }

  test('a settled record older than the cutoff goes, log and all; a fresh one stays', () => {
    // The operator profile that produced this row held 807 such records, none of
    // them ever swept, and the fan-out over them raised EMFILE on a live switch.
    const old = record('process_00142ee17ae048e88bef8bd1dae834a2', 30)
    const fresh = record('process_ffffffffffffffffffffffffffffffff', 1)

    const report = runRetentionSweep({ configDir, sessionsDir, cutoffMs: CUTOFF })

    expect(report.removed.filter(entry => entry.pathClass === 'pi-process-record').map(entry => entry.path).sort())
      .toEqual([old.json, old.log].sort())
    expect(existsSync(old.json)).toBe(false)
    expect(existsSync(old.log)).toBe(false)
    expect(existsSync(fresh.json)).toBe(true)
    expect(existsSync(fresh.log)).toBe(true)
    expect(report.failed).toEqual([])
  })

  test('a record whose log is still being written is kept — the pair ages from the NEWER file', () => {
    // `ProcessStore.append` re-writes the record on every chunk, so a live handle
    // cannot present a stale `.json`; taking the max is what makes that a
    // guarantee instead of a coincidence.
    const handle = 'process_0123456789abcdef0123456789abcdef'
    const { json, log } = record(handle, 30)
    backdate(log, 0)

    const report = runRetentionSweep({ configDir, sessionsDir, cutoffMs: CUTOFF })

    expect(report.removed).toEqual([])
    expect(existsSync(json)).toBe(true)
  })

  test('a dry run reports exactly what a real run removes', () => {
    const old = record('process_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 45)

    const dry = runRetentionSweep({ configDir, sessionsDir, cutoffMs: CUTOFF, dryRun: true })
    expect(dry.removed.map(entry => entry.path).sort()).toEqual([old.json, old.log].sort())
    expect(existsSync(old.json)).toBe(true)

    const real = runRetentionSweep({ configDir, sessionsDir, cutoffMs: CUTOFF })
    expect(real.removed.map(entry => entry.path).sort()).toEqual(dry.removed.map(entry => entry.path).sort())
    expect(existsSync(old.json)).toBe(false)
  })
})

describe('retention sweep — the config-root path classes', () => {
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'nessy-retention-classes-'))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
  })

  const classes = [
    { dir: 'logs', label: 'debug/ and legacy logs/' },
    { dir: 'feedback', label: 'feedback-bundles/' },
  ] as const

  for (const { dir, label } of classes) {
    test(`${dir} (${label}): old contents go, fresh contents stay, the directory stays`, () => {
      const root = join(configDir, dir)
      mkdirSync(root, { recursive: true })
      const old = join(root, 'old.log')
      const fresh = join(root, 'fresh.log')
      writeFileSync(old, 'old')
      writeFileSync(fresh, 'fresh')
      backdate(old, 30)

      const report = runRetentionSweep({
        configDir, sessionsDir: join(configDir, 'sessions'), cutoffMs: CUTOFF, workspaceIds: [],
      })

      expect(report.removed.map(entry => entry.path)).toEqual([old])
      expect(report.removed[0]!.pathClass).toBe(dir === 'logs' ? 'logs' : 'feedback')
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
      // The live directory itself is never removed — only legacy classes lose theirs.
      expect(existsSync(root)).toBe(true)
    })
  }

  test('a dry run over the config classes removes nothing and reports the same set', () => {
    const root = join(configDir, 'logs')
    mkdirSync(root, { recursive: true })
    const old = join(root, 'old.log')
    writeFileSync(old, 'old')
    backdate(old, 30)

    const dry = runRetentionSweep({
      configDir, sessionsDir: join(configDir, 'sessions'), cutoffMs: CUTOFF, workspaceIds: [], dryRun: true,
    })
    expect(dry.removed.map(entry => entry.path)).toEqual([old])
    expect(existsSync(old)).toBe(true)

    const real = runRetentionSweep({
      configDir, sessionsDir: join(configDir, 'sessions'), cutoffMs: CUTOFF, workspaceIds: [],
    })
    expect(real.removed.map(entry => entry.path)).toEqual(dry.removed.map(entry => entry.path))
    expect(existsSync(old)).toBe(false)
  })
})

describe('retention sweep — the vendor transcript tree', () => {
  let workspaceId: string
  let configDir: string

  beforeEach(() => {
    workspaceId = `retention-vendor-${Date.now()}-${Math.random().toString(36).slice(2)}`
    configDir = mkdtempSync(join(tmpdir(), 'nessy-retention-vendor-'))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    // `vendorProjectDir` calls production's own helper, which mkdirs under the
    // REAL config root as a side effect. Nothing is ever swept there.
    rmSync(join(WORKSPACES_DIR, workspaceId), { recursive: true, force: true })
  })

  /**
   * The fixture's location is DERIVED from production's own helper rather than
   * spelled out here. `workspaceClaudeConfigDir` is the only thing that decides
   * where a Workspace's redirected vendor config dir sits, so if it moves, the
   * sweep stops finding this fixture and these tests fail — instead of passing
   * while the real tree silently goes unswept, which is the failure mode this
   * whole class exists to fix.
   *
   * Takes the workspace id, because the rows below are about a workspace the
   * registry no longer lists as much as about the one it does.
   */
  function vendorProjectDirFor(wsId: string, cwdKey: string): string {
    const vendorRoot = relative(CONFIG_DIR, workspaceClaudeConfigDir(wsId)!)
    const dir = join(configDir, vendorRoot, 'projects', cwdKey)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function vendorProjectDir(cwdKey: string): string {
    return vendorProjectDirFor(workspaceId, cwdKey)
  }

  function sweep(options: { dryRun?: boolean } = {}) {
    return runRetentionSweep({
      configDir,
      sessionsDir: join(configDir, 'sessions'),
      cutoffMs: CUTOFF,
      workspaceIds: [workspaceId],
      ...options,
    })
  }

  test('an aged vendor transcript is swept and a fresh one beside it is kept', () => {
    const project = vendorProjectDir('-Users-someone-project')
    const aged = join(project, '40795855-13b0-4d9e-8311-7f193d21cf55.jsonl')
    const fresh = join(project, '764dc59d-4014-4096-9910-2c9a4841f430.jsonl')
    writeFileSync(aged, '{"type":"user"}\n')
    writeFileSync(fresh, '{"type":"user"}\n')
    backdate(aged, 30)

    // The dry run first: this tier deletes user data in a vendor-owned tree, so
    // it has to report the exact set before a real run takes it.
    const dry = sweep({ dryRun: true })
    expect(dry.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path))
      .toEqual([aged])
    expect(existsSync(aged)).toBe(true)

    const report = sweep()
    expect(report.failed).toEqual([])
    expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path))
      .toEqual([aged])
    expect(existsSync(aged)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    // Still holds the fresh transcript, so the project directory stays.
    expect(existsSync(project)).toBe(true)
  })

  /**
   * P6.261 (denominator C24) — the control that makes the unswept half visible.
   *
   * The walker is an allowlist over `projects/`, so every SIBLING of it inside
   * the redirected `CLAUDE_CONFIG_DIR` survives at any age. C24 asks that of one
   * sibling in particular, the feedback bundle the runtime writes when it cannot
   * upload; this row asserts the general fact with that name, beside a transcript
   * the SAME pass does sweep, so it cannot pass by the sweep having stopped
   * looking. A lane that widens the walker flips this test rather than changing
   * behaviour silently.
   */
  test('a sibling of `projects/` in the vendor config dir is never swept, at any age', () => {
    const project = vendorProjectDir('-Users-someone-feedback')
    const aged = join(project, 'e2a91c47-5d38-4b0a-91fe-6c47a0d3b825.jsonl')
    writeFileSync(aged, '{"type":"user"}\n')
    backdate(aged, 3650)

    const vendorRoot = dirname(dirname(project))
    const bundles = join(vendorRoot, 'feedback-bundles')
    mkdirSync(bundles, { recursive: true })
    const bundle = join(bundles, 'bundle-1.json')
    writeFileSync(bundle, '{}')
    backdate(bundle, 3650)
    backdate(bundles, 3650)

    const report = sweep()
    expect(report.failed).toEqual([])
    // The positive control: the pass DID reach this workspace's vendor tree.
    expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path))
      .toEqual([aged])
    // …and walked straight past everything beside `projects/`.
    expect(report.removed.some(entry => entry.path.startsWith(bundles))).toBe(false)
    expect(existsSync(bundle)).toBe(true)
    expect(existsSync(bundles)).toBe(true)
  })

  test('the subagents sidecar goes with its transcript, the emptied project directory follows, and unnamed entries survive', () => {
    const sdkSessionId = '3b2ae85f-3384-43a4-b6ca-775e0d2adab3'
    const solo = vendorProjectDir('-Users-someone-solo')
    const soloTranscript = join(solo, `${sdkSessionId}.jsonl`)
    const soloSidecar = join(solo, sdkSessionId)
    mkdirSync(join(soloSidecar, 'subagents'), { recursive: true })
    writeFileSync(join(soloSidecar, 'subagents', 'agent-a02decf2032952301.jsonl'), '{}')
    writeFileSync(join(soloSidecar, 'subagents', 'agent-a02decf2032952301.meta.json'), '{}')
    writeFileSync(soloTranscript, '{"type":"user"}\n')
    backdate(soloTranscript, 30)
    backdate(soloSidecar, 30)

    // A second project directory holding an entry the allowlist never names.
    const shared = vendorProjectDir('-Users-someone-shared')
    const sharedTranscript = join(shared, 'bd6c379d-9d50-437f-a50b-4fa82eb57a2d.jsonl')
    const unnamed = join(shared, 'something-the-vendor-added-later')
    mkdirSync(unnamed, { recursive: true })
    writeFileSync(join(unnamed, 'payload.json'), '{}')
    writeFileSync(sharedTranscript, '{"type":"user"}\n')
    backdate(sharedTranscript, 30)
    backdate(unnamed, 3650)

    const report = sweep()
    expect(report.failed).toEqual([])
    expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path).sort())
      .toEqual([soloTranscript, soloSidecar, sharedTranscript].sort())

    // The transcript's sidecar went with it, and the directory that held them
    // both is gone rather than left as an empty husk.
    expect(existsSync(soloSidecar)).toBe(false)
    expect(existsSync(solo)).toBe(false)
    expect(report.removed.find(entry => entry.pathClass === 'vendor-project-root')?.path).toBe(solo)

    // The unnamed directory is old enough to be swept by age and survives anyway,
    // which keeps the shared project directory too.
    expect(existsSync(unnamed)).toBe(true)
    expect(existsSync(shared)).toBe(true)
    // And the vendor-owned `projects` root itself is never a removal candidate,
    // the same way `logs/` and `feedback/` keep theirs.
    expect(report.removed.map(entry => entry.path)).not.toContain(dirname(solo))
    expect(existsSync(dirname(solo))).toBe(true)
  })

  test('a sidecar keeps its transcript alive while it is still being written to', () => {
    const sdkSessionId = 'e337d050-4b57-4227-b4c7-20caf46322fa'
    const project = vendorProjectDir('-Users-someone-live')
    const transcript = join(project, `${sdkSessionId}.jsonl`)
    const sidecar = join(project, sdkSessionId)
    mkdirSync(sidecar, { recursive: true })
    writeFileSync(transcript, '{"type":"user"}\n')
    // The transcript's own mtime is past the cutoff; the sidecar's is not. Age
    // comes from the newer of the two, so neither is removed.
    backdate(transcript, 30)

    const report = sweep()
    expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript')).toEqual([])
    expect(existsSync(transcript)).toBe(true)
    expect(existsSync(sidecar)).toBe(true)
  })

  /**
   * T13a — the tier never visited a workspace the config no longer lists. It is
   * the hole T11 closed on the scheduled-task tier and said out loud it was
   * leaving open here: production hands `runRetentionSweep` a `workspaceIds`
   * built from `config.workspaceRefs` (`config/storage.ts`), this tier honoured
   * it, so a workspace the user REMOVED from the registry kept its whole
   * `claude-config/projects/` tree — every transcript in it — forever, however
   * long its sessions had been gone. And an unregistered workspace's tree is
   * unreachable by the app: no Workspace means no subprocess pointed there, so
   * nothing else will ever touch those files either.
   *
   * The tier now enumerates workspace directories under `<configDir>/workspaces/`
   * unconditionally — the root it already deleted from, and the only root this
   * tree lives under. Nothing else moved: the unit is still one
   * `<sdkSessionId>.jsonl` plus its same-named sidecar, aged from the newer of
   * the two against the same `cutoffMs`. There is no ownership half to widen
   * here, unlike the cron tier, because a vendor transcript is keyed by CWD
   * rather than by a Nessy session — age is the whole predicate.
   *
   * Every row uses a workspace id the `sweep()` helper does NOT pass in
   * `workspaceIds`, and every row carries a control a tier that had stopped
   * looking would fail: a survivor that must stay, or the registered workspace
   * swept in the same pass.
   */
  describe('a workspace dropped from the registry', () => {
    let dropped: string

    beforeEach(() => {
      dropped = `${workspaceId}-dropped`
    })

    afterEach(() => {
      // `vendorProjectDirFor` goes through production's helper for this id too,
      // which mkdirs under the REAL config root as a side effect.
      rmSync(join(WORKSPACES_DIR, dropped), { recursive: true, force: true })
    })

    test('its aged transcript is swept, the emptied project directory follows, and the projects root stays', () => {
      const project = vendorProjectDirFor(dropped, '-Users-someone-dropped')
      const aged = join(project, 'f1c0a6d2-8f4e-4f3a-9b21-6c0d5e7a4b18.jsonl')
      writeFileSync(aged, '{"type":"user"}\n')
      backdate(aged, 30)

      // The dry run first, for the same reason the registered rows take one:
      // this tier deletes user data in a vendor-owned tree.
      const dry = sweep({ dryRun: true })
      expect(dry.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path))
        .toEqual([aged])
      expect(existsSync(aged)).toBe(true)

      const report = sweep()
      expect(report.failed).toEqual([])
      expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path))
        .toEqual([aged])
      expect(existsSync(aged)).toBe(false)
      // Emptied, so it goes the same way a registered workspace's does…
      expect(existsSync(project)).toBe(false)
      expect(report.removed.find(entry => entry.pathClass === 'vendor-project-root')?.path).toBe(project)
      // …while the vendor-owned `projects` root itself is kept, like `logs` and
      // `feedback`. The SDK recreates the per-cwd directory on demand.
      expect(existsSync(dirname(project))).toBe(true)
    })

    test('the cutoff applies there too — the fresh transcript beside the aged one survives', () => {
      const project = vendorProjectDirFor(dropped, '-Users-someone-mixed')
      const aged = join(project, '2d7be913-45a0-4a6f-8c1d-3e9f70a2b5c4.jsonl')
      const fresh = join(project, '8a5c0e61-7b2d-4c9e-a013-45f6d8c1e207.jsonl')
      writeFileSync(aged, '{"type":"user"}\n')
      writeFileSync(fresh, '{"type":"user"}\n')
      backdate(aged, 30)

      const report = sweep()
      expect(report.failed).toEqual([])
      expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path))
        .toEqual([aged])
      expect(existsSync(fresh)).toBe(true)
      // Still holds the fresh transcript, so the project directory stays — the
      // widened enumeration did not turn the whole tree into a directory-level
      // unit.
      expect(existsSync(project)).toBe(true)
    })

    test('the registered workspace beside it is swept exactly as before', () => {
      const registered = vendorProjectDir('-Users-someone-registered')
      const registeredAged = join(registered, 'b3f24c80-19ad-4e57-90c6-2a7b8d4f1e63.jsonl')
      const registeredFresh = join(registered, 'c9e17d35-6b48-42fa-8d10-7e2c5a9b0f41.jsonl')
      writeFileSync(registeredAged, '{"type":"user"}\n')
      writeFileSync(registeredFresh, '{"type":"user"}\n')
      backdate(registeredAged, 30)

      const droppedProject = vendorProjectDirFor(dropped, '-Users-someone-dropped')
      const droppedAged = join(droppedProject, '5c81f0a4-2e93-4d7b-b6a8-0f34c7e29d15.jsonl')
      writeFileSync(droppedAged, '{"type":"user"}\n')
      backdate(droppedAged, 30)

      const report = sweep()
      expect(report.failed).toEqual([])
      // One pass, both workspaces: the widening ADDED the dropped one rather
      // than replacing the list the tier was given.
      expect(report.removed.filter(entry => entry.pathClass === 'vendor-transcript').map(entry => entry.path).sort())
        .toEqual([registeredAged, droppedAged].sort())
      expect(existsSync(registeredFresh)).toBe(true)
      expect(existsSync(registered)).toBe(true)
    })
  })
})
