/**
 * UA3.4 — `rpc/tasks.ts` (adapted from craft-agents-oss v0.13.4, Apache-2.0) driven through its registered
 * handlers against a REAL SessionManager, ProjectHandleService and workspace root: what lands on disk and in the
 * session list is read back, never assumed.
 *
 * Positive: create returns a slug and a `todo` orchestrator bound to it, with the yaml on disk; a trusted
 * `spec.cwd` becomes the orchestrator's folder (through a handle); `list`/`get` read it back; `delete` removes an
 * unclaimed spec; `validate` reports an unhostable node as a validation error.
 * Negative (plan UA3.4): an invalid spec gives `slug: ''` and writes nothing; a foreign workspace is refused; an
 * untrusted `cwd` is refused before any session exists; two saves titled "Задача" give two slugs and two files; a
 * Generate id equal to an existing slug does not overwrite; attaching a different connection to a session with
 * messages keeps its runtime; `allow-all` in the yaml does not raise an `ask` session; a fresh create whose
 * orchestrator is refused leaves no yaml, so its retry is not `task-slug-taken`; two concurrent creates of one id
 * leave one orchestrator and the first yaml (the second is `task-slug-taken`). Plus: a slug carried by a
 * live session cannot be deleted, a non-slug never becomes a path, and `tasks:getOutput` is not this module's.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodedError, RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { listTaskSlugs, saveTaskSpec, taskYamlPath, uniqueTaskSlug, type TaskSpec } from '@nessy-agent/shared/tasks'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'
import { HANDLED_CHANNELS, registerTasksHandlers } from '../tasks'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function rig(tag: string, hostable?: (spec: unknown) => Promise<void>, local = true) {
  const root = mkdtempSync(join(tmpdir(), `ua3-4-rpc-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua3-4-${tag}-${Math.random().toString(36).slice(2, 8)}`
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
    // A local Electron window advertises show-in-folder (`isLocalClient`); a phone does not.
    hasClientCapability() { return local },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const hostabilityCalls: unknown[] = []
  registerTasksHandlers(server, { sessionManager: sm, workspaceService, platform: {} } as unknown as HandlerDeps, {
    assertNodesHostable: async (spec) => { hostabilityCalls.push(spec); if (hostable) await hostable(spec) },
  })
  const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
  const callAs = <T>(caller: string, channel: string, ...args: unknown[]): Promise<T> =>
    Promise.resolve(handlers.get(channel)!({ ...ctx, workspaceId: caller }, ...args) as T)
  const wsRoot = join(root, 'workspaces', workspaceId)
  const sessions = () => sm.getSessions(workspaceId)
  return { sm, workspaceId, wsRoot, call, callAs, sessions, handlers, hostabilityCalls }
}

const yaml = (id: string, extra = '') => `id: ${id}\ntitle: ${JSON.stringify(id)}\ngoal: ship it\n${extra}nodes:\n  - id: main\n    prompt: do the work\n`

describe('UA3.4 — tasks RPC', () => {
  it('registers exactly its declared channels, and tasks:getOutput is not among them', () => {
    const { handlers } = rig('census')
    expect([...handlers.keys()].sort()).toEqual([...HANDLED_CHANNELS].sort())
    expect(HANDLED_CHANNELS as readonly string[]).not.toContain(RPC_CHANNELS.tasks.GET_OUTPUT)
  })

  it('create returns a slug and a todo orchestrator bound to it, with the yaml on disk; list and get read it back', async () => {
    const { call, workspaceId, wsRoot, sessions } = rig('create')
    const result = await call<{ slug: string; orchestratorSessionId: string; validation: { valid: boolean }; taskLabelId?: string }>(
      RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('ship-report') })
    expect(result.slug).toBe('ship-report')
    expect(result.validation.valid).toBe(true)
    const orchestrator = sessions().find(session => session.id === result.orchestratorSessionId)
    expect(orchestrator).toMatchObject({ sessionStatus: 'todo', taskSlug: 'ship-report' })
    expect(result.taskLabelId).toBeDefined()
    expect(orchestrator?.labels).toContain(result.taskLabelId!)
    expect(existsSync(taskYamlPath(wsRoot, 'ship-report'))).toBe(true)
    expect(await call<string[]>(RPC_CHANNELS.tasks.LIST, workspaceId)).toEqual(['ship-report'])
    const got = await call<{ validation: { valid: boolean }; spec?: { id: string }; run: unknown }>(RPC_CHANNELS.tasks.GET, workspaceId, 'ship-report')
    expect(got).toMatchObject({ validation: { valid: true }, spec: { id: 'ship-report' }, run: null })
  })

  it('NEGATIVE: an invalid spec gives slug "" and writes nothing', async () => {
    const { call, workspaceId, wsRoot, sessions } = rig('invalid')
    const result = await call<{ slug: string; orchestratorSessionId: string; validation: { valid: boolean } }>(
      RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: 'id: Not A Slug\ntitle: x\n' })
    expect(result).toMatchObject({ slug: '', orchestratorSessionId: '', validation: { valid: false } })
    expect(listTaskSlugs(wsRoot)).toEqual([])
    expect(sessions()).toEqual([])
  })

  it('NEGATIVE: a caller bound to another workspace is refused on every channel, and nothing is written', async () => {
    const { callAs, workspaceId, wsRoot, sessions } = rig('foreign')
    await expect(callAs('ws-other', RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('steal') })).rejects.toThrow('tasks-workspace-mismatch')
    await expect(callAs('ws-other', RPC_CHANNELS.tasks.LIST, workspaceId)).rejects.toThrow('tasks-workspace-mismatch')
    await expect(callAs('ws-other', RPC_CHANNELS.tasks.VALIDATE, workspaceId, yaml('x'))).rejects.toThrow('tasks-workspace-mismatch')
    await expect(callAs('ws-other', RPC_CHANNELS.tasks.DELETE, workspaceId, 'x')).rejects.toThrow('tasks-workspace-mismatch')
    expect(listTaskSlugs(wsRoot)).toEqual([])
    expect(sessions()).toEqual([])
  })

  it('NEGATIVE: an untrusted cwd is refused before any session or yaml exists; a trusted one becomes the folder', async () => {
    const { call, sm, workspaceId, wsRoot, sessions } = rig('cwd')
    const folder = mkdtempSync(join(tmpdir(), 'ua3-4-folder-'))
    roots.push(folder)
    await expect(call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('in-folder', `cwd: ${folder}\n`) })).rejects.toThrow('task-cwd-untrusted')
    expect(sessions()).toEqual([])
    expect(listTaskSlugs(wsRoot)).toEqual([])

    const handles = sm.getProjectHandleService()
    const issued = await handles.validateProjectDirectory(workspaceId, folder)
    await handles.setProjectTrust({ workspaceId, projectHandleId: issued.id }, 'trusted')
    const result = await call<{ orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('in-folder', `cwd: ${folder}\n`) })
    const orchestrator = sessions().find(session => session.id === result.orchestratorSessionId)
    expect(orchestrator?.workingDirectory).toBeDefined()
    expect(readFileSync(taskYamlPath(wsRoot, 'in-folder'), 'utf-8')).toContain(folder)
  })

  it('NEGATIVE: two saves titled "Задача" give two slugs and two files; a repeated id is refused, never overwritten', async () => {
    const { call, workspaceId, wsRoot } = rig('cyrillic')
    const first = uniqueTaskSlug('Задача', new Set(await call<string[]>(RPC_CHANNELS.tasks.LIST, workspaceId)))
    await call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml(first) })
    const second = uniqueTaskSlug('Задача', new Set(await call<string[]>(RPC_CHANNELS.tasks.LIST, workspaceId)))
    await call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml(second) })
    expect(first).toMatch(/^task-[0-9a-f]{6}$/)
    expect(second).toBe(`${first}-2`)
    expect(listTaskSlugs(wsRoot)).toEqual([first, second].sort())
    await expect(call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml(first, 'acceptance_criteria: replaced\n') }))
      .rejects.toThrow(`task-slug-taken:${first}`)
    expect(readFileSync(taskYamlPath(wsRoot, first), 'utf-8')).not.toContain('replaced')
  })

  it('NEGATIVE: a Generate id equal to an existing slug does not overwrite (the adopt path is create mode)', async () => {
    const { call, sm, workspaceId, wsRoot, sessions } = rig('adopt')
    await call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('weekly') })
    const before = readFileSync(taskYamlPath(wsRoot, 'weekly'), 'utf-8')
    const draft = await sm.createSession(workspaceId, { name: 'New task', taskDraft: true })
    await expect(call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('weekly', 'acceptance_criteria: generated\n'), orchestratorSessionId: draft.id }))
      .rejects.toThrow('task-slug-taken:weekly')
    expect(readFileSync(taskYamlPath(wsRoot, 'weekly'), 'utf-8')).toBe(before)
    expect(sessions().find(session => session.id === draft.id)).toMatchObject({ taskDraft: true })
    // Control: a fresh id adopts the draft in place — no second tile.
    const adopted = await call<{ orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('weekly-2'), orchestratorSessionId: draft.id })
    expect(adopted.orchestratorSessionId).toBe(draft.id)
    expect(sessions().find(session => session.id === draft.id)).toMatchObject({ taskDraft: false, taskSlug: 'weekly-2' })
  })

  it('NEGATIVE: attaching a different connection to a session with messages keeps its runtime, and writes no yaml', async () => {
    const { call, sm, workspaceId, wsRoot, sessions } = rig('attach-conn')
    const tile = await sm.createSession(workspaceId, { name: 'quick add' })
    const managed = (sm as unknown as { sessions: Map<string, Record<string, unknown>> }).sessions.get(encodeSessionKey({ workspaceId, sessionId: tile.id }))!
    managed.llmConnection = 'pi-connection'
    managed.messageCount = 3
    await expect(call(RPC_CHANNELS.tasks.CREATE, workspaceId, {
      yaml: yaml('attached', 'defaults:\n  llmConnection: claude-gateway\n'),
      attachToExistingSession: tile.id,
    })).rejects.toThrow('task-attach-connection-locked')
    expect(managed.llmConnection).toBe('pi-connection')
    expect(managed.taskSlug).toBeUndefined()
    expect(listTaskSlugs(wsRoot)).toEqual([])
    expect(sessions()).toHaveLength(1)
  })

  it('NEGATIVE: allow-all in the yaml does not raise an ask (default) session on attach', async () => {
    const { call, sm, workspaceId, sessions } = rig('attach-mode')
    const tile = await sm.createSession(workspaceId, { name: 'quick add', permissionMode: 'default' })
    await call(RPC_CHANNELS.tasks.CREATE, workspaceId, {
      yaml: yaml('careful', 'defaults:\n  permissionMode: allow-all\n'),
      attachToExistingSession: tile.id,
    })
    expect(sessions().find(session => session.id === tile.id)).toMatchObject({ taskSlug: 'careful', permissionMode: 'default' })
  })

  it('NEGATIVE: a remote client cannot create a task whose yaml mode is above the remote ceiling (F8); a local one can', async () => {
    const remote = rig('remote', undefined, false)
    await expect(remote.call(RPC_CHANNELS.tasks.CREATE, remote.workspaceId, { yaml: yaml('unattended', 'defaults:\n  permissionMode: allow-all\n') }))
      .rejects.toThrow('permission-mode-above-remote-ceiling')
    expect(remote.sessions()).toEqual([])
    expect(listTaskSlugs(remote.wsRoot)).toEqual([])
    // Control: at or below the ceiling a remote create goes through.
    await remote.call(RPC_CHANNELS.tasks.CREATE, remote.workspaceId, { yaml: yaml('supervised', 'defaults:\n  permissionMode: plan\n') })
    expect(listTaskSlugs(remote.wsRoot)).toEqual(['supervised'])
  })

  it('NEGATIVE: a fresh create whose orchestrator is refused leaves no task.yaml, and the same yaml then succeeds', async () => {
    const { call, sm, workspaceId, wsRoot, sessions } = rig('refused-create')
    const real = sm.createSession.bind(sm)
    // A refusal createSession raises after validation (e.g. `workspace-default-project-invalid`).
    sm.createSession = (async () => { throw new Error('workspace-default-project-invalid') }) as typeof sm.createSession
    await expect(call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('stuck') })).rejects.toThrow('workspace-default-project-invalid')
    expect(listTaskSlugs(wsRoot)).toEqual([])
    expect(sessions()).toEqual([])
    // Boundary: the identical retry is not refused with task-slug-taken — it creates the orchestrator and the yaml.
    sm.createSession = real
    const retried = await call<{ slug: string; orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('stuck') })
    expect(retried.slug).toBe('stuck')
    expect(sessions().find(session => session.id === retried.orchestratorSessionId)).toMatchObject({ taskSlug: 'stuck' })
    expect(listTaskSlugs(wsRoot)).toEqual(['stuck'])
  })

  it('NEGATIVE: two concurrent creates with one id leave one orchestrator and the winner\'s yaml; the other is task-slug-taken', async () => {
    const { call, workspaceId, wsRoot, sessions } = rig('race')
    // Two windows saving "Задача" at once send the same deterministic id; the second must not pass the guard
    // while the first is still inside createSession (before any yaml or session exists).
    const settled = await Promise.allSettled([
      call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('dup', 'acceptance_criteria: first author\n') }),
      call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('dup', 'acceptance_criteria: second author\n') }),
    ])
    expect(settled.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((settled[1] as PromiseRejectedResult).reason)).toContain('task-slug-taken:dup')
    expect(sessions().filter(session => session.taskSlug === 'dup')).toHaveLength(1)
    expect(readFileSync(taskYamlPath(wsRoot, 'dup'), 'utf-8')).toContain('first author')
    // Boundary: the claim ends with the create — a later different id is not held up by it.
    await call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('dup-2') })
    expect(listTaskSlugs(wsRoot)).toEqual(['dup', 'dup-2'])
  })

  it('validate runs the node-hostability preflight on a valid spec and reports a refusal as a validation error', async () => {
    const { call, workspaceId, hostabilityCalls } = rig('validate')
    const ok = await call<{ valid: boolean; errors: unknown[] }>(RPC_CHANNELS.tasks.VALIDATE, workspaceId, yaml('fine'))
    expect(ok).toMatchObject({ valid: true, errors: [] })
    expect(hostabilityCalls).toHaveLength(1)
    // An invalid spec never reaches the preflight.
    await call(RPC_CHANNELS.tasks.VALIDATE, workspaceId, 'id: Bad Id\n')
    expect(hostabilityCalls).toHaveLength(1)
  })

  it('NEGATIVE: a node no connection can host is a validation ERROR naming it, not a thrown RPC error', async () => {
    const refuse = async () => {
      throw new CodedError('RUNTIME_UNHOSTABLE', 'Task node "main" cannot run on connection "nestor": its runtime runs no host-side tool loop', { nodeId: 'main', connection: 'nestor', reason: 'runtime-not-node-capable' })
    }
    const { call, workspaceId } = rig('validate-refuse', refuse)
    const result = await call<{ valid: boolean; errors: Array<{ path: string; message: string; severity: string }> }>(RPC_CHANNELS.tasks.VALIDATE, workspaceId, yaml('remote'))
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([{ path: 'nodes.main.llmConnection', message: expect.stringContaining('Task node "main"'), severity: 'error' }])
  })

  it('delete removes an unclaimed spec; NEGATIVE: a slug a live session carries, or a non-slug, is refused', async () => {
    const { call, workspaceId, wsRoot } = rig('delete')
    await call(RPC_CHANNELS.tasks.CREATE, workspaceId, { yaml: yaml('carried') })
    await expect(call(RPC_CHANNELS.tasks.DELETE, workspaceId, 'carried')).rejects.toThrow('task-slug-in-use:carried')
    expect(listTaskSlugs(wsRoot)).toEqual(['carried'])
    await expect(call(RPC_CHANNELS.tasks.DELETE, workspaceId, '../escape')).rejects.toThrow('task-slug-invalid')
    await expect(call(RPC_CHANNELS.tasks.GET, workspaceId, '../escape')).rejects.toThrow('task-slug-invalid')
    expect(await call<unknown>(RPC_CHANNELS.tasks.DELETE, workspaceId, 'never-existed')).toEqual({ slug: 'never-existed', deleted: false })
    // Positive: a spec no live session carries (its orchestrator was never created, or was deleted) is removed.
    saveTaskSpec(wsRoot, { id: 'orphan', title: 'orphan', goal: 'g', runner: 'conduct', nodes: [{ id: 'main', prompt: 'p' }] } as unknown as TaskSpec)
    expect(await call<unknown>(RPC_CHANNELS.tasks.DELETE, workspaceId, 'orphan')).toEqual({ slug: 'orphan', deleted: true })
    expect(listTaskSlugs(wsRoot)).toEqual(['carried'])
  })
})
