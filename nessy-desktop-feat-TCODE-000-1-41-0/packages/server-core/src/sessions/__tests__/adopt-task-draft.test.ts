/**
 * UA3.4 — `adoptGeneratedTaskOrchestrator` / `bindExistingSessionToTask`, adapted from craft-agents-oss
 * `v0.13.4:packages/server-core/src/sessions/adopt-task-draft.test.ts` (Apache-2.0) onto Nessy's composite session
 * identity (W5: `sessions` is keyed by `encodeSessionKey`) and the three locks spec §10 adds:
 *
 * - the guards that must NEVER promote (missing, not a draft, bound to another slug) — upstream's arms, kept;
 * - the connection of a session WITH messages is never switched (`task-attach-connection-locked`, nothing changes);
 * - the mode is never RAISED (an `allow-all`/`bypassPermissions` spec on a `default` session leaves it `default`),
 *   but may be lowered;
 * - the folder is never reconciled (only `projects:setSessionProject` moves it);
 * - model and name go through their canonical mutators, and nothing churns when nothing changed;
 * - ONE `session_metadata_changed` carries `taskDraft: false` (a value — it survives the JSON wire) and the slug.
 */
import { describe, expect, it } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, type SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WS = 'ws-ua3-4-adopt'

interface Harness {
  sm: SessionManager
  calls: { model: unknown[]; mode: unknown[]; name: unknown[]; connection: unknown[]; cwd: unknown[] }
  events: Array<{ type: string; changes?: unknown }>
  managed: (id: string) => Record<string, unknown>
}

function harness(seeds: Record<string, Record<string, unknown>>): Harness {
  const sm = createTestSessionManager()
  const calls = { model: [] as unknown[], mode: [] as unknown[], name: [] as unknown[], connection: [] as unknown[], cwd: [] as unknown[] }
  const events: Array<{ type: string; changes?: unknown }> = []
  const any = sm as unknown as Record<string, unknown> & { sessions: Map<string, Record<string, unknown>> }
  any.sendEvent = (event: { type: string; changes?: unknown }) => { events.push(event) }
  any.persistSession = () => {}
  any.flushSession = async () => {}
  any.setMetadataWriteGuard = () => {}
  // The canonical mutators are tested elsewhere; here they only record that they were (or were not) reached.
  any.updateSessionModel = async (_id: string, _ws: string, model: string) => { calls.model.push(model) }
  any.setSessionPermissionMode = (_id: string, mode: string) => { calls.mode.push(mode) }
  any.renameSession = async (_id: string, name: string) => { calls.name.push(name) }
  any.setSessionConnection = async (_id: string, slug: string) => { calls.connection.push(slug) }
  any.updateWorkingDirectory = (_id: string, dir: string) => { calls.cwd.push(dir) }
  for (const [id, fields] of Object.entries(seeds)) {
    const managed = createManagedSession(
      { id, ...fields } as never,
      { id: WS, name: WS, rootPath: '/tmp/nessy-ua3-4', createdAt: 1 } as never,
      { messagesLoaded: true },
    ) as unknown as Record<string, unknown>
    any.sessions.set(encodeSessionKey({ workspaceId: WS, sessionId: id }), managed)
  }
  return { sm, calls, events, managed: (id: string) => any.sessions.get(encodeSessionKey({ workspaceId: WS, sessionId: id }))! }
}

describe('UA3.4 — adoptGeneratedTaskOrchestrator guards (v0.13.4, kept)', () => {
  it('returns false when the session does not exist', async () => {
    const { sm } = harness({})
    expect(await sm.adoptGeneratedTaskOrchestrator('missing', 'slug-a', undefined, WS)).toBe(false)
  })

  it('returns false when the session is not a task draft', async () => {
    const { sm, events } = harness({ plain: { taskDraft: false } })
    expect(await sm.adoptGeneratedTaskOrchestrator('plain', 'slug-a', undefined, WS)).toBe(false)
    expect(events).toEqual([])
  })

  it('is an idempotent no-op (true) when already bound to the same slug', async () => {
    const { sm, events } = harness({ orch: { taskDraft: false, taskSlug: 'slug-a' } })
    expect(await sm.adoptGeneratedTaskOrchestrator('orch', 'slug-a', undefined, WS)).toBe(true)
    expect(events).toEqual([])
  })

  it('refuses (false) to rebind a session already bound to a different slug, leaving it untouched', async () => {
    const { sm, managed } = harness({ orch: { taskDraft: false, taskSlug: 'slug-a' } })
    expect(await sm.adoptGeneratedTaskOrchestrator('orch', 'slug-b', undefined, WS)).toBe(false)
    expect(managed('orch').taskSlug).toBe('slug-a')
  })

  it('a session of ANOTHER workspace is not found (composite identity)', async () => {
    const { sm } = harness({ draft: { taskDraft: true } })
    expect(await sm.adoptGeneratedTaskOrchestrator('draft', 'slug-a', undefined, 'ws-other')).toBe(false)
  })
})

describe('UA3.4 — bindExistingSessionToTask guards (v0.13.4, kept)', () => {
  it('returns false when the session does not exist', async () => {
    const { sm } = harness({})
    expect(await sm.bindExistingSessionToTask('missing', 'slug-a', undefined, WS)).toBe(false)
  })

  it('is an idempotent no-op (true) when already bound to the same slug', async () => {
    const { sm } = harness({ orch: { taskSlug: 'slug-a' } })
    expect(await sm.bindExistingSessionToTask('orch', 'slug-a', undefined, WS)).toBe(true)
  })

  it('refuses (false) to rebind a session already owned by a different slug', async () => {
    const { sm, managed } = harness({ orch: { taskSlug: 'slug-a' } })
    expect(await sm.bindExistingSessionToTask('orch', 'slug-b', undefined, WS)).toBe(false)
    expect(managed('orch').taskSlug).toBe('slug-a')
  })
})

describe('UA3.4 — the locks: connection, mode, folder', () => {
  const base = { permissionMode: 'default', model: 'old-model', llmConnection: 'pi-conn', workingDirectory: '/old/dir', name: 'Old' }

  it('adopt promotes a draft: one session_metadata_changed with taskDraft false (survives JSON) and the slug', async () => {
    const { sm, events, managed } = harness({ draft: { ...base, taskDraft: true } })
    expect(await sm.adoptGeneratedTaskOrchestrator('draft', 'ship-it', { name: 'Ship it', projectId: 'proj-1' }, WS)).toBe(true)
    expect(managed('draft')).toMatchObject({ taskSlug: 'ship-it', taskDraft: false, projectId: 'proj-1' })
    const metadata = events.filter(event => event.type === 'session_metadata_changed')
    expect(JSON.parse(JSON.stringify(metadata))).toEqual([
      { type: 'session_metadata_changed', sessionId: 'draft', changes: { taskDraft: false, taskSlug: 'ship-it', projectId: 'proj-1' } },
    ])
  })

  it('NEGATIVE: a different connection on a session WITH messages is refused, and nothing changes', async () => {
    const { sm, calls, events, managed } = harness({ tile: { ...base, messageCount: 4 } })
    await expect(sm.bindExistingSessionToTask('tile', 'ship-it', { llmConnection: 'claude-gateway', model: 'new-model' }, WS))
      .rejects.toThrow('task-attach-connection-locked')
    expect(managed('tile')).toMatchObject({ llmConnection: 'pi-conn', model: 'old-model' })
    expect(managed('tile').taskSlug).toBeUndefined()
    expect(calls).toEqual({ model: [], mode: [], name: [], connection: [], cwd: [] })
    expect(events).toEqual([])
  })

  it('a different connection on an EMPTY session goes through setSessionConnection (the one switch path)', async () => {
    const { sm, calls } = harness({ fresh: { ...base, taskDraft: true } })
    expect(await sm.adoptGeneratedTaskOrchestrator('fresh', 'ship-it', { llmConnection: 'claude-gateway' }, WS)).toBe(true)
    expect(calls.connection).toEqual(['claude-gateway'])
  })

  it('NEGATIVE: an allow-all (bypassPermissions) spec never RAISES a default session', async () => {
    const { sm, calls, managed } = harness({ tile: { ...base } })
    expect(await sm.bindExistingSessionToTask('tile', 'ship-it', { permissionMode: 'bypassPermissions' }, WS)).toBe(true)
    expect(calls.mode).toEqual([])
    expect(managed('tile').permissionMode).toBe('default')
  })

  it('a stricter spec mode LOWERS the session through setSessionPermissionMode', async () => {
    const { sm, calls } = harness({ tile: { ...base } })
    expect(await sm.bindExistingSessionToTask('tile', 'ship-it', { permissionMode: 'plan' }, WS)).toBe(true)
    expect(calls.mode).toEqual(['plan'])
  })

  it('the folder is never reconciled, and model and name go through their mutators', async () => {
    const { sm, calls, managed } = harness({ draft: { ...base, taskDraft: true } })
    expect(await sm.adoptGeneratedTaskOrchestrator('draft', 'ship-it', { model: 'new-model', name: 'Renamed' }, WS)).toBe(true)
    expect(calls.model).toEqual(['new-model'])
    expect(calls.name).toEqual(['Renamed'])
    expect(calls.cwd).toEqual([])
    expect(managed('draft').workingDirectory).toBe('/old/dir')
  })

  it('nothing churns when nothing changed', async () => {
    const { sm, calls } = harness({ tile: { ...base } })
    expect(await sm.bindExistingSessionToTask('tile', 'ship-it', {
      model: 'old-model', llmConnection: 'pi-conn', permissionMode: 'default', name: 'Old',
    }, WS)).toBe(true)
    expect(calls).toEqual({ model: [], mode: [], name: [], connection: [], cwd: [] })
  })
})

describe('UA12.20 — concurrent bind/adopt of one session: the slug is claimed BEFORE the awaits (as upstream v0.13.4)', () => {
  // The race only opens when the first caller actually parks inside an await BEFORE writing the
  // slug — hence the model reconcile, whose mutator is awaited. With no reconcile at all the
  // synchronous prefix would claim the slug atomically and the race could not reproduce.
  it('NEGATIVE: two concurrent binds with slugs a and b — exactly one succeeds, one is refused, one slug stands', async () => {
    const { sm, managed } = harness({ tile: { permissionMode: 'default' } })
    const results = await Promise.all([
      sm.bindExistingSessionToTask('tile', 'slug-a', { model: 'new-model' }, WS),
      sm.bindExistingSessionToTask('tile', 'slug-b', { model: 'new-model' }, WS),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter(result => !result)).toHaveLength(1)
    expect(['slug-a', 'slug-b']).toContain(managed('tile').taskSlug as string)
  })

  it('the same race through adoptGeneratedTaskOrchestrator: one promotion, one refusal, one slug stands', async () => {
    const { sm, managed } = harness({ draft: { taskDraft: true } })
    const results = await Promise.all([
      sm.adoptGeneratedTaskOrchestrator('draft', 'slug-a', { model: 'new-model' }, WS),
      sm.adoptGeneratedTaskOrchestrator('draft', 'slug-b', { model: 'new-model' }, WS),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter(result => !result)).toHaveLength(1)
    expect(['slug-a', 'slug-b']).toContain(managed('draft').taskSlug as string)
    expect(managed('draft').taskDraft).toBe(false)
  })
})
