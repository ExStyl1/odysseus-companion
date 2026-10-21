/**
 * UA12.41 — `labels:delete` end to end on the host: the label leaves the config, every session on
 * disk, AND every session SessionManager holds in memory (or the next persist of that session writes
 * the deleted id back: the fs.watch reconcile skips the strip as a self-write of this process), and
 * `labels:changed` is pushed. Before the fix the handler threw "Invalid workspace storage ID" from
 * the session strip, after the config was saved and before the push.
 *
 * Drives the SHIPPED handler against a real SessionManager (createTestSessionManager), real label
 * storage in a temp workspace root, and real session storage under the isolated test config dir.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLabel } from '@nessy-agent/shared/labels/crud'
import { loadLabelConfig, saveLabelConfig } from '@nessy-agent/shared/labels/storage'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createSession, loadSession } from '@nessy-agent/shared/sessions/storage'
import { getWorkspaceSessionRootPath } from '@nessy-agent/shared/workspaces/paths'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { createManagedSession } from '../../../sessions/SessionManager.ts'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'
import { registerLabelsHandlers } from '../labels'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

interface Managed { id: string; labels?: string[] }

/** `windowWorkspaceId: 'self'` binds the window to the rig's own (generated) workspace id. */
async function rig(opts: { windowWorkspaceId?: string } = {}) {
  const workspaceId = `ua12-41-${randomUUID()}`
  const windowWorkspaceId = opts.windowWorkspaceId === 'self' ? workspaceId : opts.windowWorkspaceId
  const root = mkdtempSync(join(tmpdir(), 'ua12-41-labels-rpc-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  cleanups.push(() => rmSync(getWorkspaceSessionRootPath(workspaceId), { recursive: true, force: true }))
  saveLabelConfig(root, { version: 1, labels: [] }) // no defaults: the test controls the tree

  const sm = createTestSessionManager()
  sm.setEventSink((() => undefined) as never)
  const internals = sm as unknown as {
    sessions: Map<string, unknown>
    persistSession(managed: unknown): void
    flushSession(sessionId: string, workspaceId?: string): Promise<void>
  }
  const runtimeWorkspace = { id: workspaceId, name: workspaceId, rootPath: root, createdAt: Date.now() }
  /** A session on disk that SessionManager also holds live (as every loaded session is). */
  const live = async (labels: string[]) => {
    const stored = await createSession(workspaceId, { labels })
    const managed = createManagedSession({ id: stored.id, labels }, runtimeWorkspace as never, { messagesLoaded: true }) as unknown as Managed
    internals.sessions.set(encodeSessionKey({ workspaceId, sessionId: stored.id }), managed)
    return managed
  }
  const labelWrites: Array<{ sessionId: string; labels: string[] }> = []
  const setSessionLabels = sm.setSessionLabels.bind(sm)
  sm.setSessionLabels = async (sessionId: string, labels: string[], wsId?: string) => {
    labelWrites.push({ sessionId, labels })
    await setSessionLabels(sessionId, labels, wsId)
  }

  const handlers = new Map<string, HandlerFn>()
  const pushes: string[] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push(channel) { pushes.push(channel) },
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    sessionManager: sm,
    workspaceService: { resolve: (id: string) => ({ id, workspaceRootPath: root }) },
    // UA12.43 — when the test binds a window, the window manager is the
    // authoritative source of the caller's workspace (assertCallerWorkspace).
    ...(windowWorkspaceId && {
      windowManager: { getWorkspaceForWindow: (_id: number) => windowWorkspaceId },
    }),
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerLabelsHandlers(server, deps)
  const ctx: RequestContext = { clientId: 'client-a', workspaceId, webContentsId: null }
  const del = (labelId: string, overrideCtx?: RequestContext) =>
    handlers.get(RPC_CHANNELS.labels.DELETE)!((overrideCtx ?? ctx) as RequestContext, workspaceId, labelId)
  const create = (input: { name: string; color?: string }, overrideCtx?: RequestContext) =>
    handlers.get(RPC_CHANNELS.labels.CREATE)!((overrideCtx ?? ctx) as RequestContext, workspaceId, input)
  const list = (overrideCtx?: RequestContext) =>
    handlers.get(RPC_CHANNELS.labels.LIST)!((overrideCtx ?? ctx) as RequestContext, workspaceId)
  /** "A later persist": write the live session's in-memory state to disk, as any later turn does. */
  const persist = async (managed: Managed) => {
    internals.persistSession(managed)
    await internals.flushSession(managed.id, workspaceId)
  }
  return { workspaceId, root, live, del, create, list, persist, pushes, labelWrites }
}

describe('UA12.41 — labels:delete', () => {
  it('strips the label from a live session in memory and on disk, survives a later persist, and pushes labels:changed', async () => {
    const { workspaceId, root, live, del, persist, pushes } = await rig()
    createLabel(root, { name: 'Bug', color: 'accent' })
    createLabel(root, { name: 'Keep', color: 'accent' })
    const tagged = await live(['bug', 'keep'])

    expect(await del('bug')).toEqual({ stripped: 1 })

    expect(loadLabelConfig(root).labels.map(l => l.id)).toEqual(['keep'])
    expect(tagged.labels).toEqual(['keep'])
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['keep'])
    await persist(tagged)
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['keep'])
    expect(pushes).toEqual([RPC_CHANNELS.labels.CHANGED])
  })

  it('rewrites only the live sessions that carry the label, and an unknown label rejects without touching any session', async () => {
    const { workspaceId, root, live, del, pushes, labelWrites } = await rig()
    createLabel(root, { name: 'Bug', color: 'accent' })
    createLabel(root, { name: 'Keep', color: 'accent' })
    const keepOnly = await live(['keep'])
    const tagged = await live(['bug'])

    expect(await del('keep')).toEqual({ stripped: 1 })
    expect(labelWrites).toEqual([{ sessionId: keepOnly.id, labels: [] }])
    expect(tagged.labels).toEqual(['bug'])

    labelWrites.length = 0
    await expect(del('missing')).rejects.toThrow("Label 'missing' not found")
    expect(labelWrites).toEqual([])
    expect(tagged.labels).toEqual(['bug'])
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['bug'])
    expect(loadLabelConfig(root).labels.map(l => l.id)).toEqual(['bug'])
    // The successful delete pushed once; the refused one changed nothing, so it pushes nothing.
    expect(pushes).toEqual([RPC_CHANNELS.labels.CHANGED])
  })
})

describe('UA12.42 — labels:list runs the load-time repair', () => {
  it('a pre-UA12.40 "" id is renamed, the live session relabeled in memory and on disk, labels:changed pushed, and a later persist keeps the new id', async () => {
    const { workspaceId, root, live, list, persist, pushes } = await rig()
    saveLabelConfig(root, { version: 1, labels: [{ id: '', name: 'Срочно', color: 'accent' }] })
    const tagged = await live([''])

    const listed = (await list()) as Array<{ id: string }>
    expect(listed.map(l => l.id)).toEqual(['label'])
    expect(loadLabelConfig(root).labels[0]?.name).toBe('Срочно')
    expect(tagged.labels).toEqual(['label'])
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['label'])
    await persist(tagged)
    expect(loadSession(workspaceId, tagged.id)?.labels).toEqual(['label'])
    expect(pushes).toEqual([RPC_CHANNELS.labels.CHANGED])
  })

  it('a healthy config lists unchanged and pushes nothing', async () => {
    const { root, live, list, pushes } = await rig()
    createLabel(root, { name: 'Bug', color: 'accent' })
    await live(['bug'])

    const listed = (await list()) as Array<{ id: string }>
    expect(listed.map(l => l.id)).toEqual(['bug'])
    expect(pushes).toEqual([])
  })
})

describe('UA12.43 — the caller-workspace guard on labels:list/create/delete', () => {
  it('labels:delete from a window bound to ws-b for this workspace is refused with labels-workspace-mismatch, writing nothing', async () => {
    const { workspaceId, root, del } = await rig({ windowWorkspaceId: 'ws-b' })
    createLabel(root, { name: 'Bug', color: 'accent' })
    const windowed: RequestContext = { clientId: 'client-a', workspaceId, webContentsId: 7 }

    await expect(del('bug', windowed)).rejects.toThrow('labels-workspace-mismatch')
    expect(loadLabelConfig(root).labels.map(l => l.id)).toEqual(['bug'])
  })

  it('the window binding wins over the ctx: a window bound to this workspace passes even when its ctx names another', async () => {
    const { root, del } = await rig({ windowWorkspaceId: 'self' })
    createLabel(root, { name: 'Bug', color: 'accent' })
    createLabel(root, { name: 'Keep', color: 'accent' })
    // The ctx names ws-b; the window manager binds the window to the target, and the binding is
    // authoritative — a guard that read ctx.workspaceId instead would refuse this call (the deny
    // direction is the first arm: window ws-b, ctx = the target).
    const stale: RequestContext = { clientId: 'client-a', workspaceId: 'ws-b', webContentsId: 7 }

    await expect(del('bug', stale)).resolves.toEqual({ stripped: 0 })
    expect(loadLabelConfig(root).labels.map(l => l.id)).toEqual(['keep'])
  })

  it('the same delete from the bound workspace passes', async () => {
    const { root, del } = await rig()
    createLabel(root, { name: 'Bug', color: 'accent' })
    createLabel(root, { name: 'Keep', color: 'accent' })

    await expect(del('bug')).resolves.toEqual({ stripped: 0 })
    expect(loadLabelConfig(root).labels.map(l => l.id)).toEqual(['keep'])
  })

  it('labels:create and labels:list are guarded by the same refusal', async () => {
    const { workspaceId, root, create, list } = await rig({ windowWorkspaceId: 'ws-b' })
    const windowed: RequestContext = { clientId: 'client-a', workspaceId, webContentsId: 7 }

    await expect(create({ name: 'Slipped', color: 'accent' }, windowed)).rejects.toThrow('labels-workspace-mismatch')
    await expect(list(windowed)).rejects.toThrow('labels-workspace-mismatch')
    expect(loadLabelConfig(root).labels).toEqual([])
  })
})
