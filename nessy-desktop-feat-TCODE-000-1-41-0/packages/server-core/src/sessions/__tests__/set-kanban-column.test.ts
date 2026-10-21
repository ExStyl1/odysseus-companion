/**
 * UA2.1 — `setKanbanColumn` and `session_metadata_changed` (upstream craft-agents v0.13.4
 * `SessionManager.setKanbanColumn`, Apache-2.0), the host half of the board's placement.
 *
 * The setter copies `setSessionStatus` line for line — in-memory field, metadata write guard,
 * `persistSession` + `flushSession` (the path that cannot race the debounced persistence queue),
 * then `sendEvent`, then the session-partition notify — so these arms ask of it what
 * `cold-session-metadata.test.ts` asks of `setSessionStatus`, plus the two things a board needs:
 * the event every window hears, and the placement surviving a restart's LISTING read (store-v2
 * `headerToMetadata` hand-copies every field, so an omission there drops the column on restart).
 *
 * NESSY DEVIATION pinned here: a clear travels as `kanbanColumn: null`. The WS codec is JSON,
 * and JSON drops an `undefined` key, so upstream's `{ kanbanColumn: undefined }` reaches a
 * window as `{}` and the clear is lost until a reload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import {
  createSessionStore,
  getSessionFilePath,
  loadSession,
  updateSessionMetadata,
  writeSessionJsonl,
  type StoredSession,
} from '@nessy-agent/shared/sessions'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

describe('UA2.1 — setKanbanColumn', () => {
  let workspaceId: string
  let sm: SessionManager
  let events: SessionEvent[]
  let notified: string[]

  beforeEach(() => {
    workspaceId = `ws-ua2-1-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
    events = []
    notified = []
    sm.setEventSink((_channel, _target, event) => { events.push(event as SessionEvent) })
    ;(sm as unknown as { configWatchers: Map<string, unknown> }).configWatchers.set(workspaceId, {
      notifySessionPartitionFileChange: (relativePath: string) => { notified.push(relativePath) },
    })
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  /** A session present on disk and registered in the manager, as after a restart. */
  function seed(sessionId: string, extra: Partial<StoredSession> = {}): void {
    const stored = {
      id: sessionId,
      workspaceId,
      name: 'board card',
      sessionStatus: 'todo',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      ...extra,
    } as StoredSession
    const file = getSessionFilePath(workspaceId, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeSessionJsonl(file, stored)
    const managed = createManagedSession(
      { id: sessionId, name: stored.name, sessionStatus: stored.sessionStatus, createdAt: 1, ...extra } as never,
      { id: workspaceId, name: 'Board', rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId), createdAt: 1 } as never,
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
  }

  function diskHeader(sessionId: string): Record<string, unknown> {
    const first = readFileSync(getSessionFilePath(workspaceId, sessionId), 'utf-8').split('\n')[0]
    if (!first) throw new Error('session file has no header line')
    return JSON.parse(first) as Record<string, unknown>
  }

  const metadataEvents = () => events.filter(event => event.type === 'session_metadata_changed')

  it('persists the column, fires session_metadata_changed once, and notifies the session partition', async () => {
    seed('card-1')

    await sm.setKanbanColumn('card-1', 'in-progress', workspaceId)

    // On disk when the call resolves — no external flush.
    expect(diskHeader('card-1').kanbanColumn).toBe('in-progress')
    expect(loadSession(workspaceId, 'card-1')?.kanbanColumn).toBe('in-progress')
    expect(metadataEvents()).toEqual([
      { type: 'session_metadata_changed', sessionId: 'card-1', changes: { kanbanColumn: 'in-progress' } },
    ])
    expect(notified).toEqual(['card-1/session.jsonl'])
    // Independent of the status: the column moved, the status did not.
    expect(diskHeader('card-1').sessionStatus).toBe('todo')
  })

  it('the placement survives a restart: the LISTING read and the renderer DTO both carry it', async () => {
    seed('card-2')
    await sm.setKanbanColumn('card-2', 'done', workspaceId)

    // A fresh store is what the next process lists sessions through (store-v2 `list`).
    const layout = { storageLayoutVersion: 2 as const, verificationId: `test-${randomUUID()}` }
    const listed = createSessionStore(layout).list(workspaceId).find(meta => meta.id === 'card-2')
    expect(listed?.kanbanColumn).toBe('done')

    // …and SessionManager hydrates from that listing, then hands the renderer `pickSessionFields`.
    const restarted = createTestSessionManager()
    const managed = createManagedSession(listed as never, { id: workspaceId, name: 'Board', rootPath: '/tmp/nessy-ua2-1', createdAt: 1 } as never)
    ;(restarted as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:card-2`, managed)
    expect(restarted.getSessions(workspaceId).find(session => session.id === 'card-2')?.kanbanColumn).toBe('done')
    restarted.cleanup()
  })

  it('null clears the column, and the clear survives the JSON wire as an explicit null', async () => {
    seed('card-3', { kanbanColumn: 'done' } as Partial<StoredSession>)
    expect(diskHeader('card-3').kanbanColumn).toBe('done')

    await sm.setKanbanColumn('card-3', null, workspaceId)

    expect('kanbanColumn' in diskHeader('card-3')).toBe(false)
    const [event] = metadataEvents()
    expect(event).toEqual({ type: 'session_metadata_changed', sessionId: 'card-3', changes: { kanbanColumn: null } })
    // What a window actually receives (the codec is JSON.stringify): the key is still there.
    expect(JSON.parse(JSON.stringify(event))).toEqual({ type: 'session_metadata_changed', sessionId: 'card-3', changes: { kanbanColumn: null } })
    expect(notified).toEqual(['card-3/session.jsonl'])
  })

  it('an unknown session emits nothing, notifies nothing, and writes nothing', async () => {
    seed('card-4')

    await sm.setKanbanColumn('no-such-session', 'done', workspaceId)

    expect(events).toEqual([])
    expect(notified).toEqual([])
    expect(existsSync(getSessionFilePath(workspaceId, 'no-such-session'))).toBe(false)
    expect('kanbanColumn' in diskHeader('card-4')).toBe(false)
  })
})

describe('UA2.1 — updateSessionMetadata carries kanbanColumn (the closed Pick and its `in` line)', () => {
  const workspaceId = `ws-ua2-1-pick-${Date.now()}`
  afterEach(() => rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true }))

  it('sets it, keeps it when the key is absent, and clears it when the key is present but undefined', async () => {
    const file = getSessionFilePath(workspaceId, 'pick-1')
    mkdirSync(dirname(file), { recursive: true })
    writeSessionJsonl(file, {
      id: 'pick-1', workspaceId, createdAt: 1, lastUsedAt: 1, messages: [],
    } as unknown as StoredSession)

    await updateSessionMetadata(workspaceId, 'pick-1', { kanbanColumn: 'todo' })
    expect(loadSession(workspaceId, 'pick-1')?.kanbanColumn).toBe('todo')

    await updateSessionMetadata(workspaceId, 'pick-1', { name: 'renamed' })
    expect(loadSession(workspaceId, 'pick-1')?.kanbanColumn).toBe('todo')

    await updateSessionMetadata(workspaceId, 'pick-1', { kanbanColumn: undefined })
    expect(loadSession(workspaceId, 'pick-1')?.kanbanColumn).toBeUndefined()
  })
})

/**
 * UA2.1 follow-up — the external reconcile (upstream v0.13.4 `applyExternalSessionMetadata`,
 * lines 1494-1498 there). Another process (a second instance, a nessy-server on the same
 * config dir) drops the card; this process's watcher sees the header change through the status
 * signature and re-persists `managed`. Without adopting the disk column, that write puts the old
 * column back next to the new status.
 */
describe('UA2.1 — an external kanbanColumn change is adopted, not written back over', () => {
  let workspaceId: string
  let sm: SessionManager
  let events: SessionEvent[]

  beforeEach(() => {
    workspaceId = `ws-ua2-1-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
    events = []
    sm.setEventSink((_channel, _target, event) => { events.push(event as SessionEvent) })
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  type Internals = {
    sessions: Map<string, { kanbanColumn?: string }>
    applyExternalSessionMetadata(managed: unknown, header: unknown): boolean
    flushSession(sessionId: string, workspaceId: string): Promise<void>
  }

  /** On disk as process B left it, and in memory as process A still holds it. */
  function seedStale(sessionId: string, column: string | undefined): { kanbanColumn?: string } {
    const file = getSessionFilePath(workspaceId, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeSessionJsonl(file, { id: sessionId, workspaceId, name: 'card', sessionStatus: 'todo', createdAt: 1, lastUsedAt: 1, messages: [] } as unknown as StoredSession)
    const managed = createManagedSession(
      { id: sessionId, name: 'card', sessionStatus: 'todo', createdAt: 1, ...(column ? { kanbanColumn: column } : {}) } as never,
      { id: workspaceId, name: 'Board', rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId), createdAt: 1 } as never,
    )
    ;(sm as unknown as Internals).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed as { kanbanColumn?: string }
  }

  function header(sessionId: string): Record<string, unknown> {
    const first = readFileSync(getSessionFilePath(workspaceId, sessionId), 'utf-8').split('\n')[0]
    if (!first) throw new Error('session file has no header line')
    return JSON.parse(first) as Record<string, unknown>
  }

  async function reconcile(sessionId: string, managed: unknown): Promise<void> {
    const internals = sm as unknown as Internals
    internals.applyExternalSessionMetadata(managed, header(sessionId))
    await internals.flushSession(sessionId, workspaceId)
  }

  it('adopts the column process B wrote, keeps it on disk, and tells this process\'s windows', async () => {
    const managed = seedStale('ext-1', 'todo')
    await updateSessionMetadata(workspaceId, 'ext-1', { sessionStatus: 'done', kanbanColumn: 'done' })

    await reconcile('ext-1', managed)

    expect(managed.kanbanColumn).toBe('done')
    expect(header('ext-1').kanbanColumn).toBe('done')
    expect(header('ext-1').sessionStatus).toBe('done')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([
      { type: 'session_metadata_changed', sessionId: 'ext-1', changes: { kanbanColumn: 'done' } },
    ])
  })

  it('an external clear is adopted as a clear (null on the wire), and an unchanged column emits nothing', async () => {
    const cleared = seedStale('ext-2', 'done')
    await updateSessionMetadata(workspaceId, 'ext-2', { sessionStatus: 'done' })
    await reconcile('ext-2', cleared)
    expect(cleared.kanbanColumn).toBeUndefined()
    expect('kanbanColumn' in header('ext-2')).toBe(false)
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([
      { type: 'session_metadata_changed', sessionId: 'ext-2', changes: { kanbanColumn: null } },
    ])

    events = []
    const same = seedStale('ext-3', 'review')
    await updateSessionMetadata(workspaceId, 'ext-3', { sessionStatus: 'done', kanbanColumn: 'review' })
    await reconcile('ext-3', same)
    expect(same.kanbanColumn).toBe('review')
    expect(header('ext-3').kanbanColumn).toBe('review')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([])
  })
})

/**
 * UA5.3 — `setSessionProjectId`, the external `projectId` reconcile and `unbindProjectFromSessions` (craft-agents-oss
 * v0.13.4 `SessionManager.setSessionProjectId` / `applyExternalSessionMetadata` / `unbindProjectFromSessions`,
 * Apache-2.0): the same setter path as the column above, upstream's `project_id_changed` event, and the delete
 * cascade's session half (live sessions through the setter, disk-only ones through storage).
 */
describe('UA5.3 — setSessionProjectId, the external projectId reconcile, unbindProjectFromSessions', () => {
  let workspaceId: string
  let rootPath: string
  let sm: SessionManager
  let events: SessionEvent[]
  let notified: string[]

  beforeEach(() => {
    workspaceId = `ws-ua5-3-${Date.now()}-${Math.random().toString(36).slice(2)}`
    rootPath = join(SESSIONS_DIR, '..', 'workspaces', workspaceId)
    sm = createTestSessionManager()
    events = []
    notified = []
    sm.setEventSink((_channel, _target, event) => { events.push(event as SessionEvent) })
    ;(sm as unknown as { configWatchers: Map<string, unknown> }).configWatchers.set(workspaceId, {
      notifySessionPartitionFileChange: (relativePath: string) => { notified.push(relativePath) },
    })
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
    rmSync(rootPath, { recursive: true, force: true })
  })

  function seed(sessionId: string, extra: Partial<StoredSession> = {}, register = true): { projectId?: string; workingDirectory?: string } {
    const stored = { id: sessionId, workspaceId, name: 'bound', sessionStatus: 'todo', createdAt: 1, lastUsedAt: 1, messages: [], ...extra } as StoredSession
    const file = getSessionFilePath(workspaceId, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeSessionJsonl(file, stored)
    const managed = createManagedSession(
      { id: sessionId, name: stored.name, sessionStatus: stored.sessionStatus, createdAt: 1, ...extra } as never,
      { id: workspaceId, name: 'Projects', rootPath, createdAt: 1 } as never,
    )
    if (register) (sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed as { projectId?: string; workingDirectory?: string }
  }

  function header(sessionId: string): Record<string, unknown> {
    const first = readFileSync(getSessionFilePath(workspaceId, sessionId), 'utf-8').split('\n')[0]
    if (!first) throw new Error('session file has no header line')
    return JSON.parse(first) as Record<string, unknown>
  }

  const projectEvents = () => events.filter(event => event.type === 'project_id_changed')

  it('binds and persists, emits project_id_changed once, notifies the partition, and never moves the folder', async () => {
    const { createProject } = await import('@nessy-agent/shared/projects')
    const project = createProject(rootPath, { name: 'Alpha' })
    const managed = seed('p-1', { workingDirectory: '/somewhere/else' } as Partial<StoredSession>)

    await sm.setSessionProjectId('p-1', project.id, workspaceId)

    expect(header('p-1').projectId).toBe(project.id)
    expect(projectEvents()).toEqual([{ type: 'project_id_changed', sessionId: 'p-1', projectId: project.id }])
    expect(notified).toEqual(['p-1/session.jsonl'])
    expect(managed.workingDirectory).toBe('/somewhere/else')
    expect(header('p-1').workingDirectory).toBe('/somewhere/else')
  })

  it('null unbinds, and the unbind survives the JSON wire as an explicit null', async () => {
    seed('p-2', { projectId: 'proj_gone0000' } as Partial<StoredSession>)

    await sm.setSessionProjectId('p-2', null, workspaceId)

    expect('projectId' in header('p-2')).toBe(false)
    const [event] = projectEvents()
    expect(JSON.parse(JSON.stringify(event))).toEqual({ type: 'project_id_changed', sessionId: 'p-2', projectId: null })
  })

  it('an id that names no project of the workspace is refused with nothing written, emitted or notified', async () => {
    seed('p-3')

    await expect(sm.setSessionProjectId('p-3', 'proj_nothere', workspaceId)).rejects.toThrow('project-not-found')

    expect('projectId' in header('p-3')).toBe(false)
    expect(events).toEqual([])
    expect(notified).toEqual([])
  })

  it('adopts a projectId another process wrote (and its clear), telling this process\'s windows', async () => {
    type Internals = { applyExternalSessionMetadata(managed: unknown, header: unknown): boolean; flushSession(id: string, ws: string): Promise<void> }
    const internals = sm as unknown as Internals
    const managed = seed('p-4')
    await updateSessionMetadata(workspaceId, 'p-4', { projectId: 'proj_extern00' })

    internals.applyExternalSessionMetadata(managed, header('p-4'))
    await internals.flushSession('p-4', workspaceId)
    expect(managed.projectId).toBe('proj_extern00')
    expect(header('p-4').projectId).toBe('proj_extern00')

    await updateSessionMetadata(workspaceId, 'p-4', { projectId: undefined })
    internals.applyExternalSessionMetadata(managed, header('p-4'))
    await internals.flushSession('p-4', workspaceId)
    expect(managed.projectId).toBeUndefined()
    expect('projectId' in header('p-4')).toBe(false)
    expect(projectEvents()).toEqual([
      { type: 'project_id_changed', sessionId: 'p-4', projectId: 'proj_extern00' },
      { type: 'project_id_changed', sessionId: 'p-4', projectId: null },
    ])
  })

  it('unbindProjectFromSessions unlinks live and disk-only sessions of that project and nothing else', async () => {
    const live = seed('u-live', { projectId: 'proj_doomed00' } as Partial<StoredSession>)
    seed('u-disk', { projectId: 'proj_doomed00' } as Partial<StoredSession>, false)
    const other = seed('u-other', { projectId: 'proj_kept0000' } as Partial<StoredSession>)

    const touched = await sm.unbindProjectFromSessions(workspaceId, 'proj_doomed00')

    expect(touched).toBe(2)
    expect(live.projectId).toBeUndefined()
    expect('projectId' in header('u-live')).toBe(false)
    expect('projectId' in header('u-disk')).toBe(false)
    expect(other.projectId).toBe('proj_kept0000')
    expect(header('u-other').projectId).toBe('proj_kept0000')
    // The live one went through the setter: its windows heard it.
    expect(projectEvents()).toEqual([{ type: 'project_id_changed', sessionId: 'u-live', projectId: null }])
  })
})

/**
 * UA12.14 — the row's control, driven through the REAL `onSessionMetadataChange` watcher callback
 * (the one `setupConfigWatcher` builds), not the reconciler directly as the describes above do:
 * a header written outside the manager (another instance on the same config dir) with a new
 * kanbanColumn is adopted — managed updated, one `session_metadata_changed` (the arm upstream
 * v0.13.4 `applyExternalSessionMetadata` L1494–L1498 carries, ported by 5729a4131) — while the
 * same header arriving INSIDE the metadata write guard (`setMetadataWriteGuard`, armed by every
 * programmatic setter) emits nothing at that moment: it is only stashed as `pendingExternalMetadata`
 * for the post-turn apply, so a stale watcher echo cannot revert a just-written column.
 */
describe('UA12.14 — the external kanbanColumn reconcile rides the real watcher callback: adopted outside the write guard, silent inside it', () => {
  let workspaceId: string
  let rootPath: string
  let sm: SessionManager
  let events: SessionEvent[]

  beforeEach(() => {
    workspaceId = `ws-ua12-14-${Date.now()}-${Math.random().toString(36).slice(2)}`
    rootPath = join(SESSIONS_DIR, '..', 'workspaces', workspaceId)
    mkdirSync(rootPath, { recursive: true })
    sm = createTestSessionManager()
    events = []
    sm.setEventSink((_channel, _target, event) => { events.push(event as SessionEvent) })
    sm.setupConfigWatcher(rootPath, workspaceId)
  })

  afterEach(() => {
    sm.cleanup()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
    rmSync(rootPath, { recursive: true, force: true })
  })

  type Internals = {
    configWatchers: Map<string, { callbacks: { onSessionMetadataChange?: (sessionId: string, header: unknown) => void } }>
    sessions: Map<string, unknown>
    setMetadataWriteGuard(managed: unknown): void
    flushSession(sessionId: string, workspaceId: string): Promise<void>
  }

  /** In memory as this process still holds it, on disk without the column yet. */
  function seedStale(sessionId: string, column: string): { kanbanColumn?: string; pendingExternalMetadata?: { kanbanColumn?: string } } {
    const file = getSessionFilePath(workspaceId, sessionId)
    mkdirSync(dirname(file), { recursive: true })
    writeSessionJsonl(file, { id: sessionId, workspaceId, name: 'card', sessionStatus: 'todo', createdAt: 1, lastUsedAt: 1, messages: [] } as unknown as StoredSession)
    const managed = createManagedSession(
      { id: sessionId, name: 'card', sessionStatus: 'todo', createdAt: 1, kanbanColumn: column } as never,
      { id: workspaceId, name: 'Board', rootPath, createdAt: 1 } as never,
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed as { kanbanColumn?: string; pendingExternalMetadata?: { kanbanColumn?: string } }
  }

  /** What the watcher's own `handleSessionMetadataChange` would read and hand the callback. */
  function header(sessionId: string): Record<string, unknown> {
    const first = readFileSync(getSessionFilePath(workspaceId, sessionId), 'utf-8').split('\n')[0]
    if (!first) throw new Error('session file has no header line')
    return JSON.parse(first) as Record<string, unknown>
  }

  function watcherCallback(): (sessionId: string, header: unknown) => void {
    const watcher = (sm as unknown as Internals).configWatchers.get(workspaceId)
    if (!watcher) throw new Error('setupConfigWatcher registered no watcher')
    const callback = watcher.callbacks.onSessionMetadataChange
    if (!callback) throw new Error('the watcher carries no onSessionMetadataChange callback')
    return callback
  }

  /** Process B's header write: a RAW file write — this process's persistence queue must learn no
   * signature from it (saveSession/updateSessionMetadata stamp `lastWrittenHeaderSignature`, and a
   * kanbanColumn-only change is invisible to the 7-field signature anyway), or the callback would
   * classify the header as this process's own self-write and skip the reconcile. */
  function writeExternalHeader(sessionId: string, column: string): void {
    const file = getSessionFilePath(workspaceId, sessionId)
    writeSessionJsonl(file, { id: sessionId, workspaceId, name: 'card', sessionStatus: 'todo', createdAt: 1, lastUsedAt: 1, messages: [], kanbanColumn: column } as unknown as StoredSession)
  }

  it('a header written outside the manager is adopted through the real callback: managed updated, one session_metadata_changed, nothing stashed', async () => {
    const managed = seedStale('cb-1', 'todo')
    writeExternalHeader('cb-1', 'done')

    watcherCallback()('cb-1', header('cb-1'))
    await (sm as unknown as Internals).flushSession('cb-1', workspaceId)

    expect(managed.kanbanColumn).toBe('done')
    expect(header('cb-1').kanbanColumn).toBe('done')
    expect(events.filter(event => event.type === 'session_metadata_changed')).toEqual([
      { type: 'session_metadata_changed', sessionId: 'cb-1', changes: { kanbanColumn: 'done' } },
    ])
    // The no-guard path applies at once; it must not defer.
    expect(managed.pendingExternalMetadata).toBeUndefined()
  })

  it('inside the metadata write guard the same header emits nothing: the column is untouched and the header stashed for the post-turn apply', async () => {
    const managed = seedStale('cb-2', 'todo')
    ;(sm as unknown as Internals).setMetadataWriteGuard(managed)
    writeExternalHeader('cb-2', 'review')
    const external = header('cb-2')

    watcherCallback()('cb-2', external)

    expect(events).toEqual([])
    expect(managed.kanbanColumn).toBe('todo')
    expect(managed.pendingExternalMetadata?.kanbanColumn).toBe('review')
  })
})
