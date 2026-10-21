/**
 * UA3.8 — the orchestrator lifecycle (OQ-13; spec §10 "Lifecycle"), driven on a REAL SessionManager and workspace root:
 * deleting an orchestrator removes `tasks/<slug>/` (`deleteTaskFolder`) unless another non-archived session carries
 * the slug; archiving keeps it; a non-orchestrator touches nothing; and an agent cannot archive a session mid-turn
 * (the processing arm of v0.13.4 `archive-guards.ts`, Apache-2.0). Plus the controller's hand-back control:
 * `tasks:delete` with only an ARCHIVED carrier removes the folder, and that carrier's tile reads the spec as missing
 * (`tasks:get` answers "not found") without throwing.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { saveTaskSpec, taskDir, type TaskSpec } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { registerTasksHandlers } from '../../handlers/rpc/tasks'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

interface Internals {
  getManaged(sessionId: string, workspaceId?: string): Record<string, unknown> | undefined
  archiveSessionForAgent(caller: unknown, sessionId: string | undefined, archived: boolean): Promise<{ status: string }>
  directPermissionResolvers: Map<string, { resolve(answer: boolean): void }>
}

function rig(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua3-8-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua3-8-${tag}-${Math.random().toString(36).slice(2, 8)}`
  const workspaceService = {
    resolve: (id: string) => ({
      id,
      workspaceRootPath: join(root, 'workspaces', id),
      sessionRootPath: join(root, 'sessions', id),
      config: { id, name: id, createdAt: 1, updatedAt: 1 },
      lastAccessedAt: 1,
    }),
    listResolved: () => [],
  } as unknown as WorkspaceService
  const sm = createTestSessionManager({ workspaceService })
  sm.setEventSink((() => undefined) as never)
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return true },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  registerTasksHandlers(server, { sessionManager: sm, workspaceService, platform: {} } as unknown as HandlerDeps, {
    assertNodesHostable: async () => undefined,
  })
  const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
  const wsRoot = join(root, 'workspaces', workspaceId)
  const spec = (id: string): TaskSpec => ({ id, title: id, goal: 'g', runner: 'conduct', nodes: [{ id: 'main', prompt: 'p' }] }) as unknown as TaskSpec
  /** An orchestrator the way `createTaskFromSpec` makes one: a session carrying the slug, and its task.yaml. */
  const orchestrator = async (slug: string, extra: Record<string, unknown> = {}) => {
    const session = await sm.createSession(workspaceId, { name: slug, taskSlug: slug, sessionStatus: 'todo', ...extra } as never)
    saveTaskSpec(wsRoot, spec(slug))
    return session
  }
  const folder = (slug: string) => existsSync(taskDir(wsRoot, slug))
  return { sm, workspaceId, wsRoot, call, orchestrator, folder, internals: sm as unknown as Internals }
}

describe('UA3.8 — deleting an orchestrator', () => {
  it('positive: delete removes tasks/<slug>/', async () => {
    const { sm, workspaceId, orchestrator, folder } = rig('delete')
    const orch = await orchestrator('fix-login')
    expect(folder('fix-login')).toBe(true)
    await sm.deleteSession(orch.id, workspaceId)
    expect(folder('fix-login')).toBe(false)
  })

  it('negative: archive keeps the folder', async () => {
    const { sm, workspaceId, orchestrator, folder } = rig('archive')
    const orch = await orchestrator('kept')
    await sm.archiveSession(orch.id, workspaceId)
    expect(folder('kept')).toBe(true)
  })

  it('negative: a non-orchestrator touches nothing (a plain session; a Conductor child node of the slug)', async () => {
    const { sm, workspaceId, orchestrator, folder } = rig('plain')
    await orchestrator('busy-task')
    const plain = await sm.createSession(workspaceId, { name: 'plain' })
    const node = await sm.createSession(workspaceId, { name: 'node', taskSlug: 'busy-task', taskNodeId: 'main', taskRunId: 'r1' } as never)
    await sm.deleteSession(plain.id, workspaceId)
    await sm.deleteSession(node.id, workspaceId)
    expect(folder('busy-task')).toBe(true)
  })

  it('negative: two sessions sharing a slug keep the folder; the last live carrier takes it', async () => {
    const { sm, workspaceId, orchestrator, folder } = rig('shared')
    const first = await orchestrator('twin')
    const second = await sm.createSession(workspaceId, { name: 'twin again', taskSlug: 'twin' } as never)
    await sm.deleteSession(first.id, workspaceId)
    expect(folder('twin')).toBe(true)
    await sm.deleteSession(second.id, workspaceId)
    expect(folder('twin')).toBe(false)
  })
})

describe('UA3.8 — tasks:delete with only an archived carrier (the dangling slug)', () => {
  it('removes the folder through deleteTaskFolder, and the archived carrier\'s spec reads as missing without throwing', async () => {
    const { sm, workspaceId, orchestrator, folder, call } = rig('dangling')
    const orch = await orchestrator('old-task')
    await sm.archiveSession(orch.id, workspaceId)
    await expect(call(RPC_CHANNELS.tasks.DELETE, workspaceId, 'old-task')).resolves.toEqual({ slug: 'old-task', deleted: true })
    expect(folder('old-task')).toBe(false)
    // The archived session keeps its slug (what it orchestrated); the board reads the spec as missing.
    expect(sm.getSessions(workspaceId).find(session => session.id === orch.id)?.taskSlug).toBe('old-task')
    const got = await call<{ spec?: unknown; validation: { valid: boolean; errors: Array<{ message: string }> } }>(RPC_CHANNELS.tasks.GET, workspaceId, 'old-task')
    expect(got.spec).toBeUndefined()
    expect(got.validation.valid).toBe(false)
    expect(got.validation.errors[0]!.message).toContain('not found')
  })

  it('control: a LIVE carrier still refuses tasks:delete and keeps the folder', async () => {
    const { workspaceId, orchestrator, folder, call } = rig('live')
    await orchestrator('in-use')
    await expect(call(RPC_CHANNELS.tasks.DELETE, workspaceId, 'in-use')).rejects.toThrow('task-slug-in-use:in-use')
    expect(folder('in-use')).toBe(true)
  })
})

describe('UA3.8 — archive_session refuses a target mid-turn (the ported processing arm)', () => {
  it('negative: archiving a processing target is refused before any card; positive: idle is asked; unarchive mid-turn passes', async () => {
    const { sm, workspaceId, internals } = rig('processing')
    const caller = await sm.createSession(workspaceId, { name: 'caller' })
    const target = await sm.createSession(workspaceId, { name: 'target' })
    const callerManaged = internals.getManaged(caller.id, workspaceId)!
    const targetManaged = internals.getManaged(target.id, workspaceId)!

    targetManaged.isProcessing = true
    const refused = internals.archiveSessionForAgent(callerManaged, target.id, true).then(
      verdict => ({ verdict, error: undefined as Error | undefined }),
      (error: Error) => ({ verdict: undefined, error }),
    )
    for (let i = 0; i < 50; i += 1) await Promise.resolve()
    const cardsRaised = internals.directPermissionResolvers.size
    // Without the arm a card is raised and would wait for a person; answer it so the probe ends either way.
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(false)
    const outcome = await refused
    expect(cardsRaised).toBe(0)
    expect(outcome.error?.message ?? `no refusal: ${outcome.verdict?.status}`).toContain('processing a turn')
    expect(targetManaged.isArchived ?? false).toBe(false)

    // Control: the same target idle raises the card (the refusal above is the arm, not a harness that never asks).
    targetManaged.isProcessing = false
    const pending = internals.archiveSessionForAgent(callerManaged, target.id, true)
    for (let i = 0; i < 50 && internals.directPermissionResolvers.size === 0; i += 1) await Promise.resolve()
    expect(internals.directPermissionResolvers.size).toBe(1)
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(false)
    expect((await pending).status).toBe('denied')

    // NESSY: the caller archiving ITSELF (always mid-turn while it calls the tool) is asked, not refused.
    callerManaged.isProcessing = true
    const self = internals.archiveSessionForAgent(callerManaged, undefined, true)
    for (let i = 0; i < 50 && internals.directPermissionResolvers.size === 0; i += 1) await Promise.resolve()
    expect(internals.directPermissionResolvers.size).toBe(1)
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(false)
    expect((await self).status).toBe('denied')

    // Unarchiving only restores visibility: a processing (archived) target is still asked, not refused.
    targetManaged.isArchived = true
    targetManaged.isProcessing = true
    const unarchive = internals.archiveSessionForAgent(callerManaged, target.id, false)
    for (let i = 0; i < 50 && internals.directPermissionResolvers.size === 0; i += 1) await Promise.resolve()
    expect(internals.directPermissionResolvers.size).toBe(1)
    for (const [, entry] of internals.directPermissionResolvers) entry.resolve(false)
    expect((await unarchive).status).toBe('denied')
  })
})
