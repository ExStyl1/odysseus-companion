import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import { sessionPersistenceQueue, type SessionStore } from '@nessy-agent/shared/sessions'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createWorkspaceService } from '@nessy-agent/shared/workspaces'
import { SessionManager, createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fixture(options: { stubMutationDrain?: boolean } = {}) {
  const stateRoot = root('nessy-project-mutation-')
  const projectPath = join(stateRoot, 'project')
  mkdirSync(projectPath)
  const handles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
    newId: () => 'project-handle',
  })
  const recents = new RecentProjectStore(
    { storageLayoutVersion: 2, verificationId: 'project-mutation-test' },
    { filePath: join(stateRoot, 'recent.json'), newId: () => 'recent-project' },
  )
  const manager = createTestSessionManager({
    projectHandleService: handles,
    recentProjectStore: recents,
  })
  if (options.stubMutationDrain !== false) {
    // These tests isolate the cwd transaction itself. Strict runtime settlement
    // is covered by the dedicated Pi drain/rewind/delete suites.
    ;(manager as any).strictDrainPiSession = async () => {}
    ;(manager as any).strictDrainSessionForMutation = async () => {}
  }
  const workspace = {
    id: 'ws-project',
    name: 'Project Workspace',
    slug: 'project-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-project' },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )
  return { manager, handles, recents, managed, workspace, projectPath }
}

function sessionStore(stateRoot: string): SessionStore {
  let id = 0
  return {
    ensureWorkspaceDir: workspaceId => join(stateRoot, 'sessions', workspaceId),
    getSessionPath: ({ workspaceId, sessionId }) => join(stateRoot, 'sessions', workspaceId, sessionId),
    getSessionFilePath: ({ workspaceId, sessionId }) => join(stateRoot, 'sessions', workspaceId, sessionId, 'session.jsonl'),
    create: async (workspaceId, options = {}) => {
      const sessionId = options.sessionId ?? `session-${++id}`
      const now = Date.now()
      return {
        id: sessionId,
        workspaceId,
        createdAt: now,
        lastUsedAt: now,
        sdkCwd: options.workingDirectory ?? join(stateRoot, 'sessions', workspaceId, sessionId),
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      }
    },
    load: () => null,
    list: () => [],
    delete: () => false,
  }
}

async function defaultProjectRestartFixture(
  nextIno: bigint,
  options: { restartedTreatsProjectAsHome?: boolean; removeProjectDirectory?: boolean } = {},
) {
  const stateRoot = root('nessy-default-project-')
  const configDir = join(stateRoot, 'config')
  const projectPath = join(stateRoot, 'project')
  const recentPath = join(stateRoot, 'recent.json')
  const trustPath = join(stateRoot, 'trust.json')
  mkdirSync(projectPath)
  const workspaceService = createWorkspaceService({
    configDir,
    credentialManager: { list: async () => [] },
  })
  const workspace = await workspaceService.create({ name: 'Default Project Workspace' })
  const identity = (ino: bigint) => ({
    realpathSync: (path: string) => path,
    statSync: () => ({ dev: 1n, ino }),
    processSalt: 'default-project-test',
  })
  const firstHandles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: trustPath }),
    identityOptions: identity(42n),
    managedRootPaths: [configDir],
    newId: () => 'initial-handle',
  })
  const firstRecents = new RecentProjectStore(
    { storageLayoutVersion: 2, verificationId: 'default-project-first' },
    { filePath: recentPath, newId: () => 'default-recent' },
  )
  const first = createTestSessionManager({
    sessionStore: sessionStore(stateRoot),
    workspaceService,
    projectHandleService: firstHandles,
    recentProjectStore: firstRecents,
  })
  const handle = await firstHandles.validateProjectDirectory(workspace.id, projectPath)
  await first.setWorkspaceDefaultProject({ workspaceId: workspace.id, projectHandleId: handle.id })
  first.cleanup()

  // The user deleted / renamed / unmounted the pinned directory between runs.
  // Done after the pin is written so workspace.json still carries it.
  if (options.removeProjectDirectory) rmSync(projectPath, { recursive: true, force: true })

  const restartedWorkspaceService = createWorkspaceService({
    configDir,
    credentialManager: { list: async () => [] },
  })
  const restartedHandles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: trustPath }),
    identityOptions: {
      ...identity(nextIno),
      // Simulates the glossary.md:231 home carve-out landing on a directory
      // that a pre-carve-out workspace.json pinned with a stable projectKey:
      // the restarted process resolves it process-only.
      ...(options.restartedTreatsProjectAsHome ? { homeDir: realpathSync(projectPath) } : {}),
    },
    managedRootPaths: [configDir],
    newId: () => 'restarted-handle',
  })
  const restarted = createTestSessionManager({
    sessionStore: sessionStore(stateRoot),
    workspaceService: restartedWorkspaceService,
    projectHandleService: restartedHandles,
    recentProjectStore: new RecentProjectStore(
      { storageLayoutVersion: 2, verificationId: 'default-project-restarted' },
      { filePath: recentPath },
    ),
  })
  return { restarted, restartedWorkspaceService, workspace, projectPath }
}

describe('SessionManager project mutation', () => {
  it('drains every provider bound to the same stable project identity before blocking trust', async () => {
    const stateRoot = root('nessy-project-trust-drain-')
    const projectPath = join(stateRoot, 'project')
    mkdirSync(projectPath)
    let nextHandle = 0
    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      newId: () => `project-handle-${++nextHandle}`,
    })
    const manager = createTestSessionManager({ projectHandleService: handles })
    const workspace = {
      id: 'ws-project-trust',
      name: 'Project Trust Workspace',
      slug: 'project-trust-workspace',
      rootPath: join(stateRoot, 'workspace'),
      createdAt: Date.now(),
    }
    const pi = createManagedSession({ id: 'session-pi' }, workspace, { messagesLoaded: true, ephemeral: true })
    const adjacent = createManagedSession({ id: 'session-adjacent' }, workspace, { messagesLoaded: true, ephemeral: true })
    const piHandle = await handles.validateProjectDirectory(workspace.id, projectPath)
    const adjacentHandle = await handles.validateProjectDirectory(workspace.id, projectPath)
    const target = await handles.validateProjectDirectory(workspace.id, projectPath)
    handles.bindSession(workspace.id, pi.id, piHandle.id)
    handles.bindSession(workspace.id, adjacent.id, adjacentHandle.id)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: pi.id }), pi)
    ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: adjacent.id }), adjacent)
    ;(manager as any).resolveManagedProvider = (managed: { id: string }) =>
      managed.id === pi.id ? 'pi' : 'anthropic'
    const drained: string[] = []
    ;(manager as any).strictDrainSessionForMutation = async (managed: { id: string }) => {
      drained.push(managed.id)
    }

    await manager.setProjectTrust({
      workspaceId: workspace.id,
      projectHandleId: target.id,
      state: 'untrusted',
    })
    expect(drained).toEqual(['session-adjacent', 'session-pi'])
    ;(manager as any).sessions.clear()
    await manager.cleanup()
  })

  // F1.977 (owner decision 2026-09-26, option A) — "Keep restricted" keeps stopping the live chats bound to the
  // folder, and each chat it stopped now says why in one line. Three chats: `live` is bound to the folder with a
  // running runtime, `idle` is bound to it with nothing started, `elsewhere` runs in another folder.
  async function trustBlockRig() {
    const stateRoot = root('nessy-project-trust-notice-')
    const projectPath = join(stateRoot, 'restricted-project')
    const otherPath = join(stateRoot, 'other-project')
    mkdirSync(projectPath)
    mkdirSync(otherPath)
    let nextHandle = 0
    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      newId: () => `notice-handle-${++nextHandle}`,
    })
    const manager = createTestSessionManager({ projectHandleService: handles })
    const workspace = {
      id: 'ws-project-trust-notice',
      name: 'Project Trust Notice Workspace',
      slug: 'project-trust-notice-workspace',
      rootPath: join(stateRoot, 'workspace'),
      createdAt: Date.now(),
    }
    const chat = (id: string) => createManagedSession({ id }, workspace, { messagesLoaded: true })
    const live = chat('session-live')
    const idle = chat('session-idle')
    const elsewhere = chat('session-elsewhere')
    handles.bindSession(workspace.id, live.id, (await handles.validateProjectDirectory(workspace.id, projectPath)).id)
    handles.bindSession(workspace.id, idle.id, (await handles.validateProjectDirectory(workspace.id, projectPath)).id)
    handles.bindSession(workspace.id, elsewhere.id, (await handles.validateProjectDirectory(workspace.id, otherPath)).id)
    const target = await handles.validateProjectDirectory(workspace.id, projectPath)
    for (const managed of [live, idle, elsewhere]) {
      ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
    }
    live.agent = { isProcessing: () => false } as never
    elsewhere.agent = { isProcessing: () => false } as never
    ;(manager as any).resolveManagedProvider = () => 'anthropic'
    const drained: string[] = []
    ;(manager as any).strictDrainSessionForMutation = async (managed: { id: string; agent: unknown }) => {
      drained.push(managed.id)
      managed.agent = null
    }
    const persisted: string[] = []
    ;(manager as any).persistSession = (managed: { id: string }) => { persisted.push(managed.id) }
    const sent: Array<Record<string, unknown>> = []
    manager.setEventSink(((_channel: unknown, _target: unknown, event: Record<string, unknown>) => {
      sent.push(event)
    }) as Parameters<typeof manager.setEventSink>[0])
    const notices = (managed: { id: string; messages: Array<{ role: string; content: string; infoLevel?: string }> }) => ({
      rows: managed.messages.filter(message => message.role === 'info'),
      events: sent.filter(event => event.type === 'info' && event.sessionId === managed.id),
    })
    const close = async () => {
      ;(manager as any).sessions.clear()
      await manager.cleanup()
    }
    return { manager, workspace, target, live, idle, elsewhere, drained, persisted, notices, close }
  }

  it('F1.977: "Keep restricted" posts one line naming the folder in the chat whose running runtime it stopped', async () => {
    const rig = await trustBlockRig()
    await rig.manager.setProjectTrust({ workspaceId: rig.workspace.id, projectHandleId: rig.target.id, state: 'untrusted' })

    expect(rig.drained).toContain(rig.live.id)
    const { rows, events } = rig.notices(rig.live as never)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.infoLevel).toBe('warning')
    expect(rows[0]!.content).toContain(rig.target.displayPath)
    expect(rows[0]!.content).not.toContain('session.notice.') // composed through the locale layer, not the bare key
    expect(events).toHaveLength(1)
    expect(events[0]!.message).toBe(rows[0]!.content)
    expect(events[0]!.level).toBe('warning')
    expect(rig.persisted).toContain(rig.live.id) // the line survives a reload
    await rig.close()
  })

  it('F1.977 BOUNDARY: a bound chat with nothing running, and a running chat in another folder, get no line', async () => {
    const rig = await trustBlockRig()
    await rig.manager.setProjectTrust({ workspaceId: rig.workspace.id, projectHandleId: rig.target.id, state: 'untrusted' })

    // The idle chat is still drained (the stop is unchanged), but it had nothing to stop, so it says nothing.
    expect(rig.drained.sort()).toEqual([rig.idle.id, rig.live.id].sort())
    expect(rig.notices(rig.idle as never).rows).toHaveLength(0)
    expect(rig.notices(rig.idle as never).events).toHaveLength(0)
    expect(rig.notices(rig.elsewhere as never).rows).toHaveLength(0)
    expect(rig.notices(rig.elsewhere as never).events).toHaveLength(0)
    expect(rig.elsewhere.agent).not.toBeNull()
    await rig.close()
  })

  // F1.1118 (origin DN-112) — a Pi chat whose only running work is background children (no agent loaded) is
  // drained too: `strictDrainPiSessionOwned` drains its durable `starting`/`running` children. That is a stop, so
  // it gets the same line. The predicate read the agent, the turn and the shells only.
  const childRow = (agentId: string, status: string) => ({ agentId, status }) as never
  it('F1.1118: a bound chat whose only running work is a background child gets the line', async () => {
    const rig = await trustBlockRig()
    ;(rig.idle as any).childSessionState = { children: [childRow('child-1', 'completed'), childRow('child-2', 'running')] }
    await rig.manager.setProjectTrust({ workspaceId: rig.workspace.id, projectHandleId: rig.target.id, state: 'untrusted' })

    expect(rig.drained).toContain(rig.idle.id)
    const { rows, events } = rig.notices(rig.idle as never)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toContain(rig.target.displayPath)
    expect(events).toHaveLength(1)
    await rig.close()
  })

  it('F1.1118 BOUNDARY: children that already ended stop nothing, so the bound chat gets no line', async () => {
    const rig = await trustBlockRig()
    ;(rig.idle as any).childSessionState = { children: [childRow('child-1', 'completed'), childRow('child-2', 'failed')] }
    await rig.manager.setProjectTrust({ workspaceId: rig.workspace.id, projectHandleId: rig.target.id, state: 'untrusted' })

    expect(rig.drained).toContain(rig.idle.id)
    expect(rig.notices(rig.idle as never).rows).toHaveLength(0)
    expect(rig.notices(rig.idle as never).events).toHaveLength(0)
    await rig.close()
  })

  it('holds the mutation boundary across an async context refresh admission', async () => {
    const fx = fixture()
    const entered = deferred()
    const release = deferred()
    ;(fx.manager as any).withCapabilityRuntime = async (
      _managed: unknown,
      action: (runtime: unknown) => Promise<unknown>,
    ) => {
      entered.resolve()
      await release.promise
      return action({})
    }
    ;(fx.manager as any).getOrCreateAgent = async () => ({
      requestContextUsage: async () => ({
        inputTokens: 10,
        contextWindow: 100,
        percent: 10,
        stale: false,
      }),
    })

    const refresh = fx.manager.refreshContextUsage(fx.managed.id, fx.workspace.id)
    await entered.promise
    await expect(fx.manager.sendMessage(
      fx.managed.id,
      'must not enter during refresh',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: fx.workspace.id },
    )).rejects.toThrow('session-project-mutation-busy')
    release.resolve()
    await expect(refresh).resolves.toMatchObject({ success: true })
  })

  it('uses one prepared runtime participant and blocks a turn until commit', async () => {
    const fx = fixture()
    const calls: string[] = []
    fx.manager.setEventSink((_channel, _target, event) => {
      if (event.type === 'working_directory_changed') calls.push('event')
    })
    const prepareEntered = deferred()
    let releasePrepare!: () => void
    const prepareGate = new Promise<void>(resolve => { releasePrepare = resolve })
    let enterFinalize!: () => void
    const finalizeEntered = new Promise<void>(resolve => { enterFinalize = resolve })
    let releaseFinalize!: () => void
    const finalizeGate = new Promise<void>(resolve => { releaseFinalize = resolve })
    fx.managed.agent = {
      isProcessing: () => false,
      prepareWorkingDirectoryUpdate: async () => {
        calls.push('prepare')
        prepareEntered.resolve()
        await prepareGate
        return {
          generation: 1,
          commit: async () => { calls.push('commit') },
          rollback: async () => { calls.push('rollback') },
          finalize: async () => {
            calls.push('finalize')
            enterFinalize()
            await finalizeGate
            calls.push('finalize-done')
          },
        }
      },
      updateWorkingDirectory: () => { calls.push('legacy-update') },
      updateSdkCwd: () => {},
    } as never

    const mutation = fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: null,
    })
    await prepareEntered.promise
    expect(calls).toEqual(['prepare'])

    await expect(fx.manager.sendMessage(
      fx.managed.id,
      'must not start during cwd prepare',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: fx.workspace.id },
    )).rejects.toThrow('session-project-mutation-busy')

    releasePrepare()
    await finalizeEntered
    expect(calls).toEqual(['prepare', 'commit', 'finalize'])
    expect(calls).not.toContain('event')
    releaseFinalize()
    await mutation
    expect(calls).toEqual(['prepare', 'commit', 'finalize', 'finalize-done', 'event'])
    fx.manager.cleanup()
  })

  it('rolls back persistence and emits no cwd success when runtime finalize fails', async () => {
    const fx = fixture()
    const previousPath = realpathSync(fx.projectPath)
    const nextPath = join(dirname(fx.projectPath), 'finalize-failure-cwd')
    mkdirSync(nextPath)
    fx.managed.workingDirectory = previousPath
    const calls: string[] = []
    const events: string[] = []
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event.type) })
    fx.managed.agent = {
      isProcessing: () => false,
      prepareWorkingDirectoryUpdate: async () => ({
        generation: 1,
        commit: async () => { calls.push('commit') },
        rollback: async () => { calls.push('rollback') },
        finalize: async () => {
          calls.push('finalize')
          throw new Error('runtime-finalize-failed')
        },
      }),
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never
    ;(fx.manager as unknown as { persistSession(managed: unknown): void }).persistSession = () => {}
    fx.manager.flushSession = async () => {}

    await expect(fx.manager.updateWorkingDirectory(
      fx.managed.id,
      nextPath,
      fx.workspace.id,
    )).rejects.toThrow('runtime-finalize-failed')

    expect(calls).toEqual(['commit', 'finalize', 'rollback'])
    expect(fx.managed.workingDirectory).toBe(previousPath)
    expect(events).not.toContain('working_directory_changed')
    fx.manager.cleanup()
  })

  it('gives an entering turn the same no-gap boundary before processing starts', async () => {
    const fx = fixture()
    let enterLoad!: () => void
    const loadEntered = new Promise<void>(resolve => { enterLoad = resolve })
    let releaseLoad!: () => void
    const loadGate = new Promise<void>(resolve => { releaseLoad = resolve })
    ;(fx.manager as unknown as {
      ensureMessagesLoaded(managed: unknown): Promise<void>
    }).ensureMessagesLoaded = async () => {
      enterLoad()
      await loadGate
      throw new Error('turn-boundary-probe')
    }

    const turn = fx.manager.sendMessage(
      fx.managed.id,
      'hold the turn boundary',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: fx.workspace.id },
    )
    const turnOutcome = turn.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )
    await loadEntered
    expect(fx.managed.isProcessing).toBe(false)
    await expect(fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: null,
    })).rejects.toThrow('session-project-mutation-busy')

    releaseLoad()
    expect(await turnOutcome).toBe('turn-boundary-probe')
    await expect(fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: null,
    })).resolves.toBeDefined()
    fx.manager.cleanup()
  })

  it('waits for an existing runtime refresh before acquiring the cwd mutation boundary', async () => {
    const fx = fixture()
    const mutationKey = `${fx.workspace.id}:${fx.managed.id}`
    let releaseRefresh!: () => void
    const refresh = new Promise<void>(resolve => { releaseRefresh = resolve })
    ;(fx.manager as unknown as {
      agentRefreshLocks: Map<string, Promise<void>>
    }).agentRefreshLocks.set(mutationKey, refresh)

    let processing = false
    let prepared = false
    fx.managed.agent = {
      isProcessing: () => processing,
      prepareWorkingDirectoryUpdate: async () => {
        prepared = true
        return {
          generation: 1,
          commit: async () => {},
          rollback: async () => {},
          finalize: async () => {},
        }
      },
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      dispose: () => {},
    } as never
    const nextPath = join(dirname(fx.projectPath), 'refresh-serialized-cwd')
    mkdirSync(nextPath)

    const mutation = fx.manager.updateWorkingDirectory(fx.managed.id, nextPath, fx.workspace.id)
    expect((fx.manager as unknown as {
      projectMutationSessions: Set<string>
    }).projectMutationSessions.has(mutationKey)).toBe(false)
    expect(prepared).toBe(false)

    processing = true
    releaseRefresh()
    await expect(mutation).rejects.toThrow('session-project-mutation-processing')
    expect(prepared).toBe(false)
    fx.manager.cleanup()
  })

  it('defers runtime refresh without publishing signatures while cwd mutation owns the boundary', async () => {
    const fx = fixture()
    const refreshes: unknown[] = []
    fx.managed.agent = {
      isProcessing: () => false,
      updateRuntimeConfig: async (input: unknown) => {
        refreshes.push(input)
        return true
      },
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      dispose: () => {},
    } as never
    const manager = fx.manager as unknown as {
      tryRefreshAgentRuntime(managed: unknown, reason: string): Promise<void>
      projectMutationSessions: Set<string>
    }
    await manager.tryRefreshAgentRuntime(fx.managed, 'capture current signatures')
    fx.managed.backendRuntimeSignature = '__stale_runtime_signature__'
    const staleRuntimeSignature = fx.managed.backendRuntimeSignature
    const restartSignature = fx.managed.backendRestartSignature
    manager.projectMutationSessions.add(`${fx.workspace.id}:${fx.managed.id}`)

    await manager.tryRefreshAgentRuntime(fx.managed, 'must defer for cwd mutation')

    expect(refreshes).toEqual([])
    expect(fx.managed.backendRuntimeSignature).toBe(staleRuntimeSignature)
    expect(fx.managed.backendRestartSignature).toBe(restartSignature)
    manager.projectMutationSessions.delete(`${fx.workspace.id}:${fx.managed.id}`)
    fx.manager.cleanup()
  })

  it('serializes every runtime refresh waiter and keeps cwd mutation behind the final owner', async () => {
    const fx = fixture()
    const manager = fx.manager as unknown as {
      tryRefreshAgentRuntime(managed: unknown, reason: string): Promise<void>
      runAgentRuntimeRefresh(...args: unknown[]): Promise<void>
    }
    const gates = [deferred(), deferred(), deferred()]
    const entered = [deferred(), deferred(), deferred()]
    let calls = 0
    let active = 0
    let maxActive = 0
    manager.runAgentRuntimeRefresh = async () => {
      const index = calls++
      active += 1
      maxActive = Math.max(maxActive, active)
      entered[index]!.resolve()
      await gates[index]!.promise
      active -= 1
    }
    fx.managed.agent = {
      isProcessing: () => false,
      updateRuntimeConfig: async () => true,
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      dispose: () => {},
      prepareWorkingDirectoryUpdate: async () => {
        prepared = true
        return {
          generation: 1,
          commit: async () => {},
          rollback: async () => {},
          finalize: async () => {},
        }
      },
    } as never
    fx.managed.backendRuntimeSignature = '__stale_runtime__'
    fx.managed.backendRestartSignature = '__stale_restart__'
    let prepared = false

    const first = manager.tryRefreshAgentRuntime(fx.managed, 'first')
    await entered[0]!.promise
    const second = manager.tryRefreshAgentRuntime(fx.managed, 'second')
    const third = manager.tryRefreshAgentRuntime(fx.managed, 'third')
    gates[0]!.resolve()
    await entered[1]!.promise
    await new Promise<void>(resolve => setImmediate(resolve))

    const nextPath = join(dirname(fx.projectPath), 'refresh-waiters-cwd')
    mkdirSync(nextPath)
    const mutation = fx.manager.updateWorkingDirectory(fx.managed.id, nextPath, fx.workspace.id)
    gates[2]!.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
    const preparedWhileSecondRefreshActive = prepared

    gates[1]!.resolve()
    await Promise.all([first, second, third, mutation])
    expect(maxActive).toBe(1)
    expect(preparedWhileSecondRefreshActive).toBe(false)
    expect(prepared).toBe(true)
    fx.manager.cleanup()
  })

  it('preserves the normal mid-stream redirect path without a mutation boundary', async () => {
    const fx = fixture()
    const mutationKey = `${fx.workspace.id}:${fx.managed.id}`
    const manager = fx.manager as unknown as {
      projectMutationSessions: Set<string>
      persistSession(managed: unknown): void
    }
    const redirected: string[] = []
    fx.managed.isProcessing = true
    fx.managed.agent = {
      isProcessing: () => true,
      redirect: (message: string) => {
        redirected.push(message)
        return true
      },
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never
    manager.persistSession = () => {}
    fx.manager.flushSession = async () => {}

    await fx.manager.sendMessage(
      fx.managed.id,
      'mid-stream steer',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: fx.workspace.id },
    )

    expect(redirected).toEqual(['mid-stream steer'])
    expect(manager.projectMutationSessions.has(mutationKey)).toBe(false)
    fx.managed.isProcessing = false
    fx.manager.cleanup()
  })

  it('queues a structured workflow command instead of degrading it to a model steer', async () => {
    const fx = fixture()
    const redirected: string[] = []
    fx.managed.isProcessing = true
    fx.managed.agent = {
      isProcessing: () => true,
      redirect: (message: string) => {
        redirected.push(message)
        return true
      },
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never
    const manager = fx.manager as unknown as {
      persistSession(managed: unknown): void
    }
    manager.persistSession = () => {}
    fx.manager.flushSession = async () => {}

    await fx.manager.sendMessage(
      fx.managed.id,
      '/audit release readiness',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: fx.workspace.id },
      '[workflow:audit] release readiness',
      { name: 'audit', args: { input: 'release readiness' } },
    )

    expect(redirected).toEqual([])
    expect(fx.managed.messageQueue).toHaveLength(1)
    expect(fx.managed.messageQueue[0]).toMatchObject({
      message: '/audit release readiness',
      modelMessage: '[workflow:audit] release readiness',
      workflowInvocation: {
        name: 'audit',
        args: { input: 'release readiness' },
      },
    })
    fx.managed.isProcessing = false
    fx.manager.cleanup()
  })

  it('queues a FIFO follow-up after ACK while the first send still owns its start boundary', async () => {
    const fx = fixture()
    const manager = fx.manager as unknown as {
      projectMutationSessions: Set<string>
      persistSession(managed: unknown): void
      createCapabilityTurn(managed: unknown): Promise<unknown>
      processNextQueuedMessage(sessionId: string, workspaceId: string): Promise<void>
    }
    const titleFlush = deferred()
    const titleFlushEntered = deferred()
    const events: Array<Record<string, unknown>> = []
    let flushCount = 0
    let redirects = 0
    let followUp: Promise<void> | undefined
    let followUpAck: string | undefined
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event as Record<string, unknown>) })
    manager.persistSession = () => {}
    fx.manager.flushSession = async () => {
      flushCount += 1
      if (flushCount === 2) {
        titleFlushEntered.resolve()
        await titleFlush.promise
      }
    }
    manager.createCapabilityTurn = async () => { throw new Error('stop-before-model-start') }
    manager.processNextQueuedMessage = async () => {}
    fx.managed.agent = {
      generateTitle: async () => 'generated title',
      isProcessing: () => false,
      redirect: () => { redirects += 1; return true },
      forceAbort: () => {},
      endLifecycle: async () => {},
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never

    const first = fx.manager.sendMessage(
      fx.managed.id,
      'first message',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        followUp = fx.manager.sendMessage(
          fx.managed.id,
          'follow-up after ack',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          id => { followUpAck = id },
          { workspaceId: fx.workspace.id },
        )
      },
      { workspaceId: fx.workspace.id },
    )
    const firstOutcome = first.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )
    await titleFlushEntered.promise
    if (!followUp) throw new Error('expected follow-up send after ACK')
    const followUpOutcome = await followUp.then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )
    const boundaryHeldDuringFollowUp = manager.projectMutationSessions.has(`${fx.workspace.id}:${fx.managed.id}`)
    titleFlush.resolve()
    expect(await firstOutcome).toBe('stop-before-model-start')

    expect(followUpOutcome).toBe('resolved')
    expect(followUpAck).toBeString()
    expect(fx.managed.messageQueue.map(entry => entry.message)).toEqual(['follow-up after ack'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'user_message', status: 'queued' }))
    expect(redirects).toBe(0)
    expect(boundaryHeldDuringFollowUp).toBe(true)
    fx.manager.cleanup()
  })

  it('holds the send boundary until the published agent enters chat', async () => {
    const fx = fixture()
    fx.managed.name = 'Existing title'
    const manager = fx.manager as unknown as {
      projectMutationSessions: Set<string>
      persistSession(managed: unknown): void
      acquireCapabilityTurn(managed: unknown): Promise<() => void>
      createCapabilityTurn(managed: unknown): Promise<unknown>
      createRetainedCapabilityLease(leaseId: string): unknown
      getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
      strictDrainSessionForMutation(managed: unknown, reason: string, boundaryHeld?: boolean): Promise<void>
      sessionStore: SessionStore
    }
    manager.persistSession = () => {}
    fx.manager.flushSession = async () => {}
    manager.acquireCapabilityTurn = async () => () => {}
    manager.createCapabilityTurn = async () => ({
      snapshot: { leaseId: 'send-start-lease' },
      runtime: { view: { sources: [] }, materializer: {} },
    })
    manager.createRetainedCapabilityLease = () => ({
      retain: () => () => {},
      release: () => {},
    })

    const agentConstructionEntered = deferred()
    const releaseAgentConstruction = deferred()
    const chatEntered = deferred()
    const releaseChat = deferred()
    let drains = 0
    let deleted = 0
    manager.strictDrainSessionForMutation = async () => { drains += 1 }
    manager.sessionStore.delete = () => { deleted += 1; return true }
    const agent = {
      isProcessing: () => true,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getModel: () => 'test-model',
      getSessionId: () => undefined,
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      drainAutomationEvents: async () => {},
      forceAbort: () => {},
      dispose: () => {},
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      chat: async function* () {
        chatEntered.resolve()
        await releaseChat.promise
        yield {
          type: 'complete' as const,
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        }
      },
    }
    manager.getOrCreateAgent = async () => {
      agentConstructionEntered.resolve()
      await releaseAgentConstruction.promise
      fx.managed.agent = agent as never
      return agent
    }

    const send = fx.manager.sendMessage(
      fx.managed.id,
      'send-start boundary probe',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { workspaceId: fx.workspace.id },
    )
    await agentConstructionEntered.promise
    await expect(fx.manager.deleteSession(
      fx.managed.id,
      fx.workspace.id,
    )).rejects.toThrow('session-project-mutation-busy')
    expect(drains).toBe(0)
    expect(deleted).toBe(0)

    releaseAgentConstruction.resolve()
    await chatEntered.promise
    expect(fx.managed.agent).toBe(agent as never)
    expect(manager.projectMutationSessions.has(`${fx.workspace.id}:${fx.managed.id}`)).toBe(false)
    releaseChat.resolve()
    await send
    fx.manager.cleanup()
  })

  it('blocks deletion at the cwd boundary and cancels persistence only after deletion acquires it', async () => {
    const fx = fixture()
    const manager = fx.manager as unknown as {
      sessionStore: SessionStore
    }
    const prepareGate = deferred()
    const prepareEntered = deferred()
    let deleted = 0
    manager.sessionStore.delete = () => { deleted += 1; return true }
    fx.managed.agent = {
      isProcessing: () => false,
      forceAbort: () => {},
      endLifecycle: async () => {},
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      prepareWorkingDirectoryUpdate: async () => {
        prepareEntered.resolve()
        await prepareGate.promise
        return {
          generation: 1,
          commit: async () => {},
          rollback: async () => {},
          finalize: async () => {},
        }
      },
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      dispose: () => {},
    } as never
    sessionPersistenceQueue.enqueue({
      id: fx.managed.id,
      workspaceId: fx.workspace.id,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as never)
    const nextPath = join(dirname(fx.projectPath), 'delete-boundary-cwd')
    mkdirSync(nextPath)
    const mutation = fx.manager.updateWorkingDirectory(fx.managed.id, nextPath, fx.workspace.id)
    await prepareEntered.promise

    const blockedDelete = await fx.manager.deleteSession(fx.managed.id, fx.workspace.id).then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )
    const deletedWhileMutationHeld = deleted
    const persistenceCancelledWhileBlocked = !sessionPersistenceQueue.hasPending({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    })

    prepareGate.resolve()
    await mutation
    await fx.manager.deleteSession(fx.managed.id, fx.workspace.id)

    expect(blockedDelete).toBe('session-project-mutation-busy')
    expect(deletedWhileMutationHeld).toBe(0)
    expect(persistenceCancelledWhileBlocked).toBe(false)
    expect(deleted).toBe(1)
    expect(sessionPersistenceQueue.hasPending({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    })).toBe(false)
    fx.manager.cleanup()
  })

  it('rejects a follow-up send while deletion owns the active-turn boundary', async () => {
    const fx = fixture({ stubMutationDrain: false })
    const manager = fx.manager as unknown as {
      sessionStore: SessionStore
      persistSession(managed: unknown): void
    }
    const deleteEntered = deferred()
    const events: Array<Record<string, unknown>> = []
    let deleted = 0
    let persisted = 0
    let acked = 0
    manager.sessionStore.delete = () => { deleted += 1; return true }
    manager.persistSession = () => { persisted += 1 }
    fx.manager.flushSession = async () => {}
    fx.manager.setEventSink((_channel, _target, event) => {
      events.push(event as Record<string, unknown>)
    })
    fx.managed.isProcessing = true
    fx.managed.agent = {
      isProcessing: () => true,
      forceAbort: () => { deleteEntered.resolve() },
      endLifecycle: async () => {},
      drainAutomationEvents: async () => {},
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      redirect: () => false,
      dispose: () => {},
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never

    const deletion = fx.manager.deleteSession(fx.managed.id, fx.workspace.id)
    await deleteEntered.promise
    const outcome = await fx.manager.sendMessage(
      fx.managed.id,
      'must not survive deletion',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => { acked += 1 },
      { workspaceId: fx.workspace.id },
    ).then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )
    await deletion

    expect({
      outcome,
      acked,
      messages: fx.managed.messages.length,
      queued: fx.managed.messageQueue.length,
      persisted,
      deleted,
      userEvents: events.filter(event => event.type === 'user_message').length,
    }).toEqual({
      outcome: 'session-project-mutation-busy',
      acked: 0,
      messages: 0,
      queued: 0,
      // The strict delete drain durably clears interaction state once.
      persisted: 1,
      deleted: 1,
      userEvents: 0,
    })
    fx.manager.cleanup()
  })

  it('restores runtime, managed state, persistence and exact binding after a fallible commit', async () => {
    const fx = fixture()
    const previousHandle = await fx.handles.validateProjectDirectory(fx.workspace.id, fx.projectPath)
    fx.handles.bindSession(fx.workspace.id, fx.managed.id, previousHandle.id)
    fx.managed.workingDirectory = realpathSync(fx.projectPath)
    fx.managed.sdkCwd = '/sdk-before-cwd-mutation'
    const nextPath = join(dirname(fx.projectPath), 'next-project')
    mkdirSync(nextPath)
    const calls: string[] = []
    const events: string[] = []
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event.type) })
    fx.managed.agent = {
      isProcessing: () => false,
      prepareWorkingDirectoryUpdate: async () => ({
        generation: 1,
        commit: async () => { calls.push('commit') },
        rollback: async () => { calls.push('rollback') },
        finalize: async () => { calls.push('finalize') },
      }),
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never
    let persistCount = 0
    let flushCount = 0
    ;(fx.manager as unknown as { persistSession(managed: unknown): void }).persistSession = () => {
      persistCount += 1
    }
    fx.manager.flushSession = async () => {
      flushCount += 1
      if (flushCount === 1) throw new Error('commit-flush-failed')
    }

    await expect(fx.manager.updateWorkingDirectory(
      fx.managed.id,
      nextPath,
      fx.workspace.id,
    )).rejects.toThrow('commit-flush-failed')

    expect(calls).toEqual(['commit', 'rollback'])
    expect(fx.managed.workingDirectory).toBe(realpathSync(fx.projectPath))
    expect(fx.managed.sdkCwd).toBe('/sdk-before-cwd-mutation')
    expect((await fx.handles.resolveHandle({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    }))?.id).toBe(previousHandle.id)
    expect({ persistCount, flushCount }).toEqual({ persistCount: 2, flushCount: 2 })
    expect(events).not.toContain('working_directory_changed')
    fx.manager.cleanup()
  })

  it('rolls back before finalize when capability invalidation fails', async () => {
    const fx = fixture()
    const previousHandle = await fx.handles.validateProjectDirectory(fx.workspace.id, fx.projectPath)
    fx.handles.bindSession(fx.workspace.id, fx.managed.id, previousHandle.id)
    fx.managed.workingDirectory = realpathSync(fx.projectPath)
    fx.managed.sdkCwd = '/sdk-before-invalidation-failure'
    const nextPath = join(dirname(fx.projectPath), 'invalidation-failure-project')
    mkdirSync(nextPath)
    const calls: string[] = []
    const events: string[] = []
    let finalized = false
    let persistCount = 0
    let flushCount = 0
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event.type) })
    fx.managed.agent = {
      isProcessing: () => false,
      prepareWorkingDirectoryUpdate: async () => ({
        generation: 1,
        commit: async () => { calls.push('commit') },
        rollback: async () => {
          calls.push('rollback')
          if (finalized) throw new Error('rollback-after-finalize')
        },
        finalize: async () => {
          calls.push('finalize')
          finalized = true
        },
      }),
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never
    const manager = fx.manager as unknown as {
      capabilityResolver: { invalidate(...args: unknown[]): void }
      persistSession(managed: unknown): void
    }
    manager.capabilityResolver.invalidate = () => {
      calls.push('invalidate')
      throw new Error('capability-invalidation-failed')
    }
    manager.persistSession = () => { persistCount += 1 }
    fx.manager.flushSession = async () => { flushCount += 1 }

    const failure = await fx.manager.updateWorkingDirectory(
      fx.managed.id,
      nextPath,
      fx.workspace.id,
    ).then(
      () => 'resolved',
      error => error instanceof Error ? error.message : String(error),
    )

    expect({
      calls,
      failure,
      workingDirectory: fx.managed.workingDirectory,
      sdkCwd: fx.managed.sdkCwd,
      binding: (await fx.handles.resolveHandle({
        workspaceId: fx.workspace.id,
        sessionId: fx.managed.id,
      }))?.id,
      persistCount,
      flushCount,
      successEvents: events.filter(type => type === 'working_directory_changed').length,
    }).toEqual({
      calls: ['commit', 'invalidate', 'rollback'],
      failure: 'capability-invalidation-failed',
      workingDirectory: realpathSync(fx.projectPath),
      sdkCwd: '/sdk-before-invalidation-failure',
      binding: previousHandle.id,
      persistCount: 2,
      flushCount: 2,
      successEvents: 0,
    })
    fx.manager.cleanup()
  })

  it('aggregates rollback failure after still attempting local, binding and persistence restore', async () => {
    const fx = fixture()
    const previousHandle = await fx.handles.validateProjectDirectory(fx.workspace.id, fx.projectPath)
    fx.handles.bindSession(fx.workspace.id, fx.managed.id, previousHandle.id)
    fx.managed.workingDirectory = realpathSync(fx.projectPath)
    fx.managed.sdkCwd = '/sdk-before-incomplete-rollback'
    const nextPath = join(dirname(fx.projectPath), 'aggregate-project')
    mkdirSync(nextPath)
    const events: string[] = []
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event.type) })
    fx.managed.agent = {
      isProcessing: () => false,
      prepareWorkingDirectoryUpdate: async () => ({
        generation: 1,
        commit: async () => {},
        rollback: async () => { throw new Error('runtime-rollback-failed') },
        finalize: async () => { throw new Error('finalize-must-not-run') },
      }),
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
    } as never
    let persistCount = 0
    let flushCount = 0
    ;(fx.manager as unknown as { persistSession(managed: unknown): void }).persistSession = () => {
      persistCount += 1
    }
    fx.manager.flushSession = async () => {
      flushCount += 1
      if (flushCount === 1) throw new Error('commit-flush-failed')
    }

    let failure: unknown
    try {
      await fx.manager.updateWorkingDirectory(fx.managed.id, nextPath, fx.workspace.id)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map(error => String(error))).toEqual([
      'Error: commit-flush-failed',
      'Error: runtime-rollback-failed',
    ])
    expect(fx.managed.workingDirectory).toBe(realpathSync(fx.projectPath))
    expect(fx.managed.sdkCwd).toBe('/sdk-before-incomplete-rollback')
    expect((await fx.handles.resolveHandle({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    }))?.id).toBe(previousHandle.id)
    expect({ persistCount, flushCount }).toEqual({ persistCount: 2, flushCount: 2 })
    expect(events).not.toContain('working_directory_changed')
    fx.manager.cleanup()
  })

  it('accepts only a Workspace-bound handle, binds it to the session and resets with null', async () => {
    const fx = fixture()
    const handle = await fx.handles.validateProjectDirectory(fx.workspace.id, fx.projectPath)

    const selected = await fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: handle.id,
    })
    expect(selected.workingDirectory).toBe(realpathSync(fx.projectPath))
    expect(await fx.handles.resolveHandle({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    })).not.toBeNull()
    expect(fx.recents.listRecentProjects(fx.workspace.id)).toHaveLength(1)

    const rawPath = join(dirname(fx.projectPath), 'legacy-raw-path')
    mkdirSync(rawPath)
    await fx.manager.updateWorkingDirectory(fx.managed.id, rawPath, fx.workspace.id)
    expect(fx.managed.workingDirectory).toBe(realpathSync(rawPath))
    expect(fx.managed.sdkCwd).toBe(realpathSync(rawPath))
    expect((await fx.handles.resolveHandle({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    }))?.id).toBe(handle.id)

    const reset = await fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: null,
    })
    expect(reset.workingDirectory).toBeUndefined()
    expect(await fx.handles.resolveHandle({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    })).toBeNull()
    fx.manager.cleanup()
  })

  it('rejects project mutation while a turn is processing', async () => {
    const fx = fixture()
    fx.managed.isProcessing = true
    await expect(fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: null,
    })).rejects.toThrow('session-project-mutation-processing')
    fx.manager.cleanup()
  })

  it('commits the Workspace default when recent history cannot be updated', async () => {
    const stateRoot = root('nessy-default-project-recent-failure-')
    const configDir = join(stateRoot, 'config')
    const projectPath = join(stateRoot, 'project')
    mkdirSync(projectPath)
    const workspaceService = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
    })
    const workspace = await workspaceService.create({ name: 'Default Project Workspace' })
    const handles = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
      identityOptions: {
        realpathSync,
        statSync: () => ({ dev: 0n, ino: 0n }),
        processSalt: 'recent-failure-test',
      },
      managedRootPaths: [configDir],
      newId: () => 'default-handle',
    })
    const recents = new RecentProjectStore(
      { storageLayoutVersion: 2, verificationId: 'default-project-recent-failure' },
      { filePath: join(stateRoot, 'recent.json') },
    )
    recents.recordValidatedProject = () => { throw new Error('recent-project-store-write-failed') }
    const manager = createTestSessionManager({
      sessionStore: sessionStore(stateRoot),
      workspaceService,
      projectHandleService: handles,
      recentProjectStore: recents,
    })
    const handle = await handles.validateProjectDirectory(workspace.id, projectPath)

    const selected = await manager.setWorkspaceDefaultProject({
      workspaceId: workspace.id,
      projectHandleId: handle.id,
    })
    const session = await manager.createSession(workspace.id, { ephemeral: true })

    expect(session.workingDirectory).toBe(realpathSync(projectPath))
    expect(recents.listRecentProjects(workspace.id)).toEqual([])
    const storedDefault = workspaceService.resolve(workspace.id).config.defaults?.defaultProject
    expect(storedDefault?.workingDirectory).toBe(projectPath)
    expect(storedDefault?.projectKey).toBeUndefined()
    expect(JSON.stringify(selected)).not.toContain(projectPath)
    manager.cleanup()
  })

  it('reissues and revalidates a durable default project after runtime restart', async () => {
    const fx = await defaultProjectRestartFixture(42n)

    const session = await fx.restarted.createSession(fx.workspace.id, { ephemeral: true })

    expect(session.workingDirectory).toBe(realpathSync(fx.projectPath))
    fx.restarted.cleanup()
  })

  it('rejects an identity-replaced default project after runtime restart', async () => {
    const fx = await defaultProjectRestartFixture(99n)

    await expect(fx.restarted.createSession(fx.workspace.id, { ephemeral: true }))
      .rejects.toThrow('workspace-default-project-invalid')
    fx.restarted.cleanup()
  })

  it('starts a session without the default project when the pinned directory is gone', async () => {
    // The directory a workspace pinned as its default project was deleted,
    // renamed, or lives on a drive that is not mounted. An absence cannot be a
    // spoofed identity, so the restore must NOT brick the workspace: without
    // this, every createSession throws workspace-default-project-invalid and
    // the only way out is hand-editing the workspace config.json.
    const fx = await defaultProjectRestartFixture(42n, { removeProjectDirectory: true })

    const session = await fx.restarted.createSession(fx.workspace.id, { ephemeral: true })

    expect(session.workingDirectory).toBeUndefined()
    fx.restarted.cleanup()
  })

  it('keeps the pin when the default-project directory is gone so a remount recovers it', async () => {
    // The other half of the decision: we cannot tell "deleted for good" from
    // "the external drive is unplugged until tonight", so the stale pin stays
    // on disk instead of being cleared behind the user's back.
    const fx = await defaultProjectRestartFixture(42n, { removeProjectDirectory: true })

    await fx.restarted.createSession(fx.workspace.id, { ephemeral: true })

    const storedDefault = fx.restartedWorkspaceService
      .resolve(fx.workspace.id).config.defaults?.defaultProject
    expect(storedDefault?.workingDirectory).toBe(fx.projectPath)
    fx.restarted.cleanup()
  })

  it('clears a stored default-project key that re-resolves process-only instead of failing the restore', async () => {
    // Compat guard for the glossary.md:231 home carve-out: workspace.json
    // pinned a stable projectKey for the directory before the carve-out; the
    // restarted process resolves the same directory process-only (per-process
    // salted key), so the pin can never match again. The restore must clear
    // the stale selection gracefully — session created WITHOUT the default
    // project — instead of throwing workspace-default-project-invalid on
    // every createSession in the workspace.
    const fx = await defaultProjectRestartFixture(42n, { restartedTreatsProjectAsHome: true })

    const session = await fx.restarted.createSession(fx.workspace.id, { ephemeral: true })

    expect(session.workingDirectory).toBeUndefined()
    fx.restarted.cleanup()
  })
})
