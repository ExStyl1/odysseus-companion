import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts'
import {
  DAMAGED_LEGACY_CRON_SUFFIX,
  MAX_SESSION_CRON_TASKS,
  SESSION_CRON_ID_LENGTH,
  SessionCronStoreError,
  adoptLegacySessionCronStore,
  generateSessionCronId,
  openSessionCronStore,
  sessionCronDirectory,
  sessionCronFile,
} from './cron-store.ts'

const roots: string[] = []

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-cron-store-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('the session-scoped store (`scheduled-tasks.md:168`, `:217`)', () => {
  test('mints an 8-character id and round-trips the four documented fields', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    const record = store.create({ schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' })

    expect(record.id).toHaveLength(SESSION_CRON_ID_LENGTH)
    expect(record.schedule).toBe('0 9 * * 1-5')
    expect(record.recurring).toBe(true)
    expect(record.prompt).toBe('check the build')

    // Read back through a fresh handle: the store holds no in-memory state.
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([record])
  })

  test('the store is per session, so one session cannot see another', () => {
    const root = project()
    openSessionCronStore(root, 'session-a').create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    expect(openSessionCronStore(root, 'session-b').list()).toEqual([])
  })

  test('lands under the project namespace, not the config root (`:217`)', () => {
    const root = project()
    openSessionCronStore(root, 'session-a').create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    expect(sessionCronFile(root, 'session-a')).toBe(join(root, NESSY_AGENT_PROJECT_DIR, 'crons', 'session-a.json'))
    expect(existsSync(sessionCronFile(root, 'session-a'))).toBe(true)
  })

  test('the 51st task is refused (`:168`)', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    for (let index = 0; index < MAX_SESSION_CRON_TASKS; index += 1) {
      store.create({ schedule: '*/5 * * * *', recurring: true, prompt: `task ${index}` })
    }
    expect(store.list()).toHaveLength(MAX_SESSION_CRON_TASKS)

    let thrown: unknown
    try {
      store.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'one too many' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SessionCronStoreError)
    expect((thrown as SessionCronStoreError).code).toBe('capacity')
    expect((thrown as Error).message).toContain('50')
    // The refusal writes nothing.
    expect(store.list()).toHaveLength(MAX_SESSION_CRON_TASKS)
  })

  test('a symlinked store DIRECTORY is a hard error, not a fall-through (`:217`)', () => {
    const root = project()
    const elsewhere = project()
    mkdirSync(join(root, NESSY_AGENT_PROJECT_DIR), { recursive: true })
    symlinkSync(elsewhere, sessionCronDirectory(root))

    let thrown: unknown
    try {
      openSessionCronStore(root, 'session-a').create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SessionCronStoreError)
    expect((thrown as SessionCronStoreError).code).toBe('symlink')
    // Nothing was written through the link — the whole point of `:217`.
    expect(existsSync(join(elsewhere, 'session-a.json'))).toBe(false)
  })

  test('a symlinked TASK FILE is a hard error too (`:217`)', () => {
    const root = project()
    const elsewhere = project()
    const target = join(elsewhere, 'stolen.json')
    writeFileSync(target, '{"schemaVersion":1,"tasks":[]}', 'utf8')
    mkdirSync(sessionCronDirectory(root), { recursive: true })
    symlinkSync(target, sessionCronFile(root, 'session-a'))

    expect(() =>
      openSessionCronStore(root, 'session-a').create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' }),
    ).toThrow(SessionCronStoreError)
    expect(readFileSync(target, 'utf8')).toBe('{"schemaVersion":1,"tasks":[]}')
  })

  test('a symlinked project namespace directory is refused as well (`:217`)', () => {
    const root = project()
    const elsewhere = project()
    symlinkSync(elsewhere, join(root, NESSY_AGENT_PROJECT_DIR))
    expect(() =>
      openSessionCronStore(root, 'session-a').create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' }),
    ).toThrow(SessionCronStoreError)
  })

  test('remove returns the record and forgets it; an unknown id is undefined', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    const first = store.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    const second = store.create({ schedule: '0 9 * * *', recurring: false, prompt: 'b' })

    expect(store.remove('nosuchid')).toBeUndefined()
    expect(store.remove(first.id)).toEqual(first)
    expect(store.list()).toEqual([second])
  })

  test('markFired stamps only the named task', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    const first = store.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    const second = store.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'b' })

    store.markFired(first.id, 1_700_000_000_000)
    const after = store.list()
    expect(after.find(task => task.id === first.id)?.lastFiredAt).toBe(1_700_000_000_000)
    expect(after.find(task => task.id === second.id)?.lastFiredAt).toBeUndefined()
  })

  test('a fresh conversation clears everything (`:216`)', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    store.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    store.clear()
    expect(store.list()).toEqual([])
    expect(existsSync(sessionCronFile(root, 'session-a'))).toBe(false)
  })

  test('a corrupt file degrades to an empty list rather than throwing', () => {
    const root = project()
    mkdirSync(sessionCronDirectory(root), { recursive: true })
    writeFileSync(sessionCronFile(root, 'session-a'), '{ not json', 'utf8')
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([])
  })

  test('a traversal in the session id is refused rather than path-joined', () => {
    expect(() => sessionCronFile(project(), '../escape')).toThrow(/Invalid cron session id/)
  })

  test('an OLD-shape record (no R39 fields) still loads from disk', () => {
    const root = project()
    mkdirSync(sessionCronDirectory(root), { recursive: true })
    // Byte-for-byte what a pre-R39 build wrote: the four documented fields plus
    // createdAt, nothing else.
    writeFileSync(
      sessionCronFile(root, 'session-a'),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [{ id: 'abcdefgh', schedule: '*/5 * * * *', recurring: true, prompt: 'old', createdAt: 1_700_000_000_000 }],
      }),
      'utf8',
    )
    const loaded = openSessionCronStore(root, 'session-a').list()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.id).toBe('abcdefgh')
    expect(loaded[0]!.dynamic).toBeUndefined()
    expect(loaded[0]!.nextFireAt).toBeUndefined()
    expect(loaded[0]!.promptSource).toBeUndefined()
  })

  test('a NEW-shape dynamic record round-trips through save/load (R39)', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    const record = store.create({
      schedule: 'dynamic',
      recurring: true,
      prompt: 'self-paced loop',
      dynamic: true,
      nextFireAt: 1_700_000_060_000,
      promptSource: 'loop-md',
      now: 1_700_000_000_000,
    })
    expect(record.dynamic).toBe(true)
    expect(record.nextFireAt).toBe(1_700_000_060_000)
    expect(record.promptSource).toBe('loop-md')

    // Through a FRESH handle, off disk — schemaVersion stays 1.
    const reread = openSessionCronStore(root, 'session-a').list()
    expect(reread).toEqual([record])
    const raw = JSON.parse(readFileSync(sessionCronFile(root, 'session-a'), 'utf8')) as { schemaVersion: number }
    expect(raw.schemaVersion).toBe(1)
  })

  test('rearm rewrites the pending wakeup and the fallback marker like markFired rewrites lastFiredAt', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    const record = store.create({
      schedule: 'dynamic', recurring: true, prompt: 'p', dynamic: true, nextFireAt: 1_000, now: 500,
    })
    const other = store.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'q', now: 500 })

    // The service arms its fallback: wakeup moves, marker set.
    store.rearm(record.id, 2_000, true)
    let live = store.list().find(task => task.id === record.id)!
    expect(live.nextFireAt).toBe(2_000)
    expect(live.fallbackArmed).toBe(true)

    // A model reschedule: wakeup moves, marker CLEARED (omitted = normal).
    store.rearm(record.id, 3_000)
    live = store.list().find(task => task.id === record.id)!
    expect(live.nextFireAt).toBe(3_000)
    expect(live.fallbackArmed).toBeUndefined()

    // Clearing the wakeup: dueless record, marker kept for the last chance.
    store.rearm(record.id, undefined, true)
    live = store.list().find(task => task.id === record.id)!
    expect(live.nextFireAt).toBeUndefined()
    expect(live.fallbackArmed).toBe(true)

    // Only the named task was touched; unknown ids are ignored.
    expect(store.list().find(task => task.id === other.id)).toEqual(other)
    store.rearm('nosuchid', 9_000)
    expect(store.list()).toHaveLength(2)
  })

  test('generateSessionCronId never returns an id already taken', () => {
    // A generator that always proposes the same first value must still make
    // progress once that value is taken.
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    let index = 0
    const random = () => values[index++ % values.length]!
    const first = generateSessionCronId(new Set(), random)
    const second = generateSessionCronId(new Set([first]), random)
    expect(first).toHaveLength(SESSION_CRON_ID_LENGTH)
    expect(second).toHaveLength(SESSION_CRON_ID_LENGTH)
    expect(second).not.toBe(first)
  })
})

describe('the anchor is resolved, never captured (T8 (b))', () => {
  const create = (store: ReturnType<typeof openSessionCronStore>, prompt: string) =>
    store.create({ schedule: '*/5 * * * *', recurring: true, prompt })

  test('a resolver anchor is re-read on every operation', () => {
    const first = project()
    const second = project()
    let anchor = first
    const store = openSessionCronStore(() => anchor, 'session-a')

    const early = create(store, 'written under the first anchor')
    expect(store.file).toBe(sessionCronFile(first, 'session-a'))
    expect(existsSync(sessionCronFile(first, 'session-a'))).toBe(true)

    // The anchor moves. A captured path would keep answering the first store —
    // which is exactly how a worktree session lost its records.
    anchor = second
    expect(store.file).toBe(sessionCronFile(second, 'session-a'))
    expect(store.list()).toEqual([])
    const late = create(store, 'written under the second anchor')
    expect(store.list().map(task => task.id)).toEqual([late.id])

    // And the first store is untouched, so nothing was silently migrated.
    expect(openSessionCronStore(first, 'session-a').list().map(task => task.id)).toEqual([early.id])
  })

  test('a plain string anchor behaves exactly as before', () => {
    const root = project()
    const store = openSessionCronStore(root, 'session-a')
    const record = create(store, 'a')
    expect(store.file).toBe(sessionCronFile(root, 'session-a'))
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([record])
  })
})

describe('adopting a store left at the legacy anchor (T8 (a))', () => {
  test('records written under the old anchor are moved to the new one, once', () => {
    const legacy = project()
    const root = project()
    const written = openSessionCronStore(legacy, 'session-a')
      .create({ schedule: '0 9 * * *', recurring: true, prompt: 'created inside a worktree' })

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('adopted')

    expect(openSessionCronStore(root, 'session-a').list()).toEqual([written])
    // The legacy file is gone, so a second open cannot resurrect it.
    expect(existsSync(sessionCronFile(legacy, 'session-a'))).toBe(false)
    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('not-needed')
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([written])
  })

  test('merges into a root store that already holds records, and the root wins a shared id', () => {
    const legacy = project()
    const root = project()
    const kept = openSessionCronStore(root, 'session-a')
      .create({ schedule: '0 9 * * *', recurring: true, prompt: 'already at the root' })
    const legacyStore = openSessionCronStore(legacy, 'session-a')
    const moved = legacyStore.create({ schedule: '0 10 * * *', recurring: true, prompt: 'from the legacy anchor' })
    // Same id, different prompt: the root copy is the survivor.
    legacyStore.replace([...legacyStore.list(), { ...kept, prompt: 'stale duplicate' }])

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('adopted')

    const after = openSessionCronStore(root, 'session-a').list()
    expect(after.map(task => task.id)).toEqual([kept.id, moved.id])
    expect(after.find(task => task.id === kept.id)?.prompt).toBe('already at the root')
  })

  test('the same directory on both sides is not an adoption', () => {
    const root = project()
    openSessionCronStore(root, 'session-a').create({ schedule: '0 9 * * *', recurring: true, prompt: 'a' })
    expect(adoptLegacySessionCronStore({
      legacyProjectDir: root, projectDir: root, sessionId: 'session-a',
    })).toBe('not-needed')
    expect(openSessionCronStore(root, 'session-a').list()).toHaveLength(1)
  })

  test('a legacy anchor with no store at all is not an adoption', () => {
    expect(adoptLegacySessionCronStore({
      legacyProjectDir: project(), projectDir: project(), sessionId: 'session-a',
    })).toBe('not-needed')
  })

  /**
   * T10 — the removal is not "the adoption finished", it is "nothing was lost".
   * Both rows below used to end with the legacy file deleted and the records it
   * held gone for good.
   *
   * T10 fix wave — and then both of them kept the file AS IT WAS, which handed
   * an already-merged record back to the next adoption. What is kept now is the
   * part that never made it: the un-merged tail, rewritten in place, or the
   * damaged file itself, renamed out of the adoption path altogether.
   */
  test('the cap stops the merge, so the legacy file keeps the un-merged TAIL only', () => {
    const legacy = project()
    const root = project()
    const rootStore = openSessionCronStore(root, 'session-a')
    // One seat free at the root, and TWO records at the legacy anchor: the first
    // takes the seat, the second is stranded. That split is the whole row — a
    // file kept as it was would re-offer the one that already landed.
    for (let index = 0; index < MAX_SESSION_CRON_TASKS - 1; index += 1) {
      rootStore.create({ schedule: '*/5 * * * *', recurring: true, prompt: `root task ${index}` })
    }
    const legacyStore = openSessionCronStore(legacy, 'session-a')
    const fits = legacyStore.create({ schedule: '0 8 * * *', recurring: true, prompt: 'takes the last seat' })
    const stranded = legacyStore.create({ schedule: '0 9 * * *', recurring: true, prompt: 'no room at the root' })

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('partial')

    // The cap is still the cap; the record that did not fit is still where it
    // was, and the one that DID is no longer offered by the legacy file at all.
    expect(openSessionCronStore(root, 'session-a').list()).toHaveLength(MAX_SESSION_CRON_TASKS)
    expect(openSessionCronStore(legacy, 'session-a').list().map(task => task.id)).toEqual([stranded.id])
    expect(existsSync(sessionCronFile(legacy, 'session-a'))).toBe(true)

    // The user cancels the record that landed. The next adoption carries the
    // TAIL over — and cannot put the cancelled one back, because the file it
    // reads no longer holds it.
    rootStore.remove(fits.id)
    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('adopted')
    const after = openSessionCronStore(root, 'session-a').list().map(task => task.id)
    expect(after).toHaveLength(MAX_SESSION_CRON_TASKS)
    expect(after).toContain(stranded.id)
    expect(after).not.toContain(fits.id)
    expect(existsSync(sessionCronFile(legacy, 'session-a'))).toBe(false)

    // And the tail cannot come back either: cancel it, adopt again.
    rootStore.remove(stranded.id)
    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('not-needed')
    expect(openSessionCronStore(root, 'session-a').list().map(task => task.id)).not.toContain(stranded.id)
  })

  test('a damaged legacy file is QUARANTINED by rename — kept for a human, never read again', () => {
    const legacy = project()
    const root = project()
    const file = sessionCronFile(legacy, 'session-a')
    const quarantine = `${file}${DAMAGED_LEGACY_CRON_SUFFIX}`
    mkdirSync(sessionCronDirectory(legacy), { recursive: true })
    // Truncated mid-write: `readState` reports NO tasks for this, which is
    // exactly how it used to be mistaken for an empty store and deleted.
    writeFileSync(file, '{"schemaVersion":1,"tasks":[{"id":"abcdefgh","sched', 'utf8')

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('partial')
    // Not deleted: byte-for-byte what was there, under a name nothing enumerates.
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(quarantine, 'utf8')).toBe('{"schemaVersion":1,"tasks":[{"id":"abcdefgh","sched')

    // Quarantined ONCE. The next adoption has nothing to look at, and does not
    // reach into the quarantine to find some.
    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('not-needed')
    expect(existsSync(quarantine)).toBe(true)
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([])
  })

  /**
   * T10 fix wave, the reviewer's probe run verbatim as a row: a `'partial'`
   * adoption that RETAINED its legacy file re-appended, on the next service
   * build, a record the user had cancelled at the root in between. A service
   * rebuilt after a restart or a runtime switch is a map miss, so the adoption
   * really does run again against the same anchor.
   */
  test('a record cancelled at the root is NOT resurrected by the next adoption', () => {
    const legacy = project()
    const root = project()
    const legacyStore = openSessionCronStore(legacy, 'session-a')
    const keep = legacyStore.create({ schedule: '0 9 * * *', recurring: true, prompt: 'cancel me later' })
    // One unreadable entry beside it, so the adoption is `'partial'` — the state
    // in which the file used to survive with the readable record still in it.
    const file = sessionCronFile(legacy, 'session-a')
    const state = JSON.parse(readFileSync(file, 'utf8')) as { tasks: unknown[] }
    state.tasks.push({ id: 'zzzzzzzz', schedule: 5 })
    writeFileSync(file, JSON.stringify(state), 'utf8')

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('partial')
    expect(openSessionCronStore(root, 'session-a').list().map(task => task.id)).toEqual([keep.id])

    // The user cancels it at the root — `CronDelete`.
    openSessionCronStore(root, 'session-a').remove(keep.id)
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([])

    // The next service build re-runs the adoption. The cancellation stands.
    adoptLegacySessionCronStore({ legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a' })
    expect(openSessionCronStore(root, 'session-a').list()).toEqual([])
  })

  test('an empty legacy store that PARSES is still cleared away — the control', () => {
    const legacy = project()
    const root = project()
    openSessionCronStore(legacy, 'session-a').replace([])
    expect(existsSync(sessionCronFile(legacy, 'session-a'))).toBe(true)

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('adopted')
    expect(existsSync(sessionCronFile(legacy, 'session-a'))).toBe(false)
  })

  test('a symlinked destination is reported, never thrown — scheduling continues', () => {
    const legacy = project()
    const root = project()
    const elsewhere = project()
    openSessionCronStore(legacy, 'session-a').create({ schedule: '0 9 * * *', recurring: true, prompt: 'a' })
    mkdirSync(join(root, NESSY_AGENT_PROJECT_DIR), { recursive: true })
    symlinkSync(elsewhere, sessionCronDirectory(root))

    expect(adoptLegacySessionCronStore({
      legacyProjectDir: legacy, projectDir: root, sessionId: 'session-a',
    })).toBe('failed')
    // The legacy records are still there to try again with.
    expect(openSessionCronStore(legacy, 'session-a').list()).toHaveLength(1)
  })
})
