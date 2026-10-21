import { describe, expect, test } from 'bun:test'
import type { ProcessSupervisorPort, SupervisedProcessStartRequest } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import {
  WorkspaceQuiescenceCoordinator,
  WorkspaceQuiescenceError,
} from '../workspaces/workspace-quiescence.ts'
import { ProcessSessionDrainError } from './process-supervisor.ts'
import { PiWorkspaceDrainParticipant } from './workspace-drain-participant.ts'
import { WorktreeLeaseError } from './worktree-lease-service.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fakeSupervisor(overrides: Partial<ProcessSupervisorPort> = {}) {
  const drained: SessionKey[] = []
  const port = {
    async start() { throw new Error('unused') },
    async read() { throw new Error('unused') },
    async stop() {},
    async drainSession(sessionKey: SessionKey) { drained.push(sessionKey); return [] },
    ...overrides,
  } as ProcessSupervisorPort & {
    start(request: SupervisedProcessStartRequest, onRegistered?: () => void): ReturnType<ProcessSupervisorPort['start']>
  }
  return { port, drained }
}

describe('Pi Workspace drain participant', () => {
  test('holds the barrier through publication and drains only target Workspace resources', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const supervisor = fakeSupervisor()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 1_000 })
    const createGate = deferred<{ id: string }>()
    const published: string[] = []
    let publishedRegistration: unknown
    const drained: string[] = []
    const keyA = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    const keyB = { workspaceId: 'workspace-b', sessionId: 'session-b' }

    const creating = participant.admitRuntime({
      sessionKey: keyA,
      resourceType: 'session',
      resourceId: 'workspace-a:session-a',
      create: () => createGate.promise,
      publish: (value, registration) => {
        published.push(value.id)
        publishedRegistration = registration
      },
      drain: async value => { drained.push(value.id) },
      disposeOnFailure: async value => { drained.push(`failed:${value.id}`) },
    })
    const acquiring = quiescence.acquire('workspace-a')
    await Promise.resolve()
    expect(drained).toEqual([])
    createGate.resolve({ id: 'agent-a' })
    const registrationA = await creating
    expect(publishedRegistration).toBe(registrationA)
    const leaseA = await acquiring
    expect(published).toEqual(['agent-a'])
    expect(drained).toEqual(['agent-a'])
    expect(supervisor.drained).toEqual([keyA])

    const registrationB = await participant.admitRuntime({
      sessionKey: keyB,
      resourceType: 'session',
          resourceId: 'workspace-a:session-a',
      create: async () => ({ id: 'agent-b' }),
      publish: () => {},
      drain: async value => { drained.push(value.id) },
      disposeOnFailure: async () => {},
    })
    expect(drained).not.toContain('agent-b')
    registrationA.dispose()
    registrationB.dispose()
    await leaseA.release()
    participant.dispose()
  })

  test('releases process admission after durable registration before foreground completion', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const foreground = deferred<never>()
    const registered = deferred()
    const supervisor = fakeSupervisor({
      start: (async (_request: SupervisedProcessStartRequest, onRegistered?: () => void) => {
        onRegistered?.()
        registered.resolve()
        return foreground.promise
      }) as ProcessSupervisorPort['start'],
    })
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 1_000 })
    const key = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    await participant.admitRuntime({
      sessionKey: key,
      resourceType: 'session',
      resourceId: 'managed-a',
      create: async () => ({ id: 'agent-a' }),
      publish: () => {},
      drain: async () => {},
      disposeOnFailure: async () => {},
    })
    void participant.processSupervisorPort.start({
      sessionKey: key,
      executionId: 'exec',
      semanticId: 'bash',
      command: 'command',
      cwd: '/tmp',
      workspaceRoot: '/tmp',
      profile: 'workspace',
      background: false,
      timeoutMs: 1_000,
    })
    await registered.promise

    const lease = await quiescence.acquire('workspace-a')
    expect(supervisor.drained).toEqual([key])
    await lease.release()
  })

  test('retains process SessionKey ownership after runtime registration disposal', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const key = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    const supervisor = fakeSupervisor({
      start: (async (_request: SupervisedProcessStartRequest, onRegistered?: () => void) => {
        onRegistered?.()
        return { handle: 'process-a', output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test' }
      }) as ProcessSupervisorPort['start'],
    })
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port })
    const registration = await participant.admitRuntime({
      sessionKey: key, resourceType: 'session', resourceId: 'managed-a',
      create: async () => ({}), publish: () => {}, drain: async () => {}, disposeOnFailure: async () => {},
    })
    await participant.processSupervisorPort.start({
      sessionKey: key, executionId: 'exec', semanticId: 'bash_background', command: 'command', cwd: '/tmp',
      workspaceRoot: '/tmp', profile: 'workspace', background: true, timeoutMs: 1_000,
    })
    registration.dispose()
    const lease = await quiescence.acquire('workspace-a')
    expect(supervisor.drained).toEqual([key])
    await lease.release()
  })

  test('reports only a still-pending process SessionKey when total drain deadline expires', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const key = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    const supervisor = fakeSupervisor({
      start: (async (_request: SupervisedProcessStartRequest, onRegistered?: () => void) => {
        onRegistered?.()
        return { handle: 'process-a', output: '', nextCursor: 0, isRunning: true, exitCode: null, signal: null, isolationProfile: 'workspace:test' }
      }) as ProcessSupervisorPort['start'],
      drainSession: () => new Promise<readonly string[]>(() => {}),
    })
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 10 })
    await participant.processSupervisorPort.start({
      sessionKey: key, executionId: 'exec', semanticId: 'bash_background', command: 'command', cwd: '/tmp',
      workspaceRoot: '/tmp', profile: 'workspace', background: true, timeoutMs: 1_000,
    })
    let error: unknown
    try { await quiescence.acquire('workspace-a') } catch (caught) { error = caught }
    expect(error).toMatchObject({ residuals: [{ resources: [{
      resourceType: 'process-session', resourceId: 'workspace-a:session-a', code: 'drain-timeout',
    }] }] })
  })

  test('preserves a bounded total-timeout SessionKey residual through Q0', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const supervisor = fakeSupervisor()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 10 })
    const key = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    await participant.admitRuntime({
      sessionKey: key,
      resourceType: 'session',
      resourceId: 'managed-a',
      create: async () => ({ id: 'agent-a' }),
      publish: () => {},
      drain: () => new Promise(() => {}),
      disposeOnFailure: async () => {},
    })

    let error: unknown
    try { await quiescence.acquire('workspace-a') } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(WorkspaceQuiescenceError)
    expect(error).toMatchObject({
      code: 'workspace-quiescence-acquire-failed',
      residuals: [{
        participantId: 'pi-harness',
        resources: [{ resourceType: 'session', resourceId: 'managed-a', code: 'drain-timeout' }],
      }],
    })
    expect(() => quiescence.admit('pi-harness', 'workspace-a')).not.toThrow()
  })

  test('preserves exact failed process handles through Q0 residuals', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const failedHandle = 'process_opaque_handle'
    const supervisor = fakeSupervisor({
      async drainSession() { throw new ProcessSessionDrainError([failedHandle]) },
    })
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 1_000 })
    await participant.admitRuntime({
      sessionKey: { workspaceId: 'workspace-a', sessionId: 'session-a' },
      resourceType: 'session',
      resourceId: 'managed-a',
      create: async () => ({ id: 'agent-a' }),
      publish: () => {},
      drain: async () => {},
      disposeOnFailure: async () => {},
    })

    let error: unknown
    try { await quiescence.acquire('workspace-a') } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(WorkspaceQuiescenceError)
    expect(error).toMatchObject({
      residuals: [{
        participantId: 'pi-harness',
        resources: [{ resourceType: 'process', resourceId: failedHandle, code: 'process-drain-failed' }],
      }],
    })
  })

  test('admits worktree leases and preserves a dirty lease across later drain attempts', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const supervisor = fakeSupervisor()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 1_000 })
    let dirty = true
    await participant.admitRuntime({
      sessionKey: { workspaceId: 'workspace-a', sessionId: 'parent' },
      resourceType: 'worktree',
      resourceId: 'worktree-agent-1',
      create: async () => ({ worktreeLeaseId: 'worktree-agent-1' }),
      publish: () => {},
      drain: async lease => {
        if (dirty) throw new WorktreeLeaseError('worktree-dirty', [{
          resourceType: 'worktree', resourceId: lease.worktreeLeaseId, code: 'worktree-dirty',
        }])
      },
      disposeOnFailure: async () => {},
    })

    await expect(quiescence.acquire('workspace-a')).rejects.toMatchObject({
      residuals: [{ participantId: 'pi-harness', resources: [{
        resourceType: 'worktree', resourceId: 'worktree-agent-1', code: 'resource-drain-failed',
      }] }],
    })
    dirty = false
    await expect(quiescence.acquire('workspace-a')).rejects.toMatchObject({
      residuals: [{ participantId: 'pi-harness', resources: [{ resourceId: 'worktree-agent-1' }] }],
    })
  })

  test('cleans partial publication and releases admission exactly once on failure', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const supervisor = fakeSupervisor()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port })
    let disposed = 0
    await expect(participant.admitRuntime({
      sessionKey: { workspaceId: 'workspace-a', sessionId: 'session-a' },
      resourceType: 'summary',
      resourceId: 'summary-a',
      create: async () => ({ id: 'temporary' }),
      publish: () => { throw new Error('publish-failed') },
      drain: async () => {},
      disposeOnFailure: async () => { disposed += 1 },
    })).rejects.toThrow('publish-failed')
    expect(disposed).toBe(1)
    const lease = await quiescence.acquire('workspace-a')
    await lease.release()
    participant.dispose()
    participant.dispose()
  })

  test('aggregates publication and cleanup failures without hiding either error', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: fakeSupervisor().port })
    const publicationError = new Error('publish-failed')
    const cleanupError = new Error('cleanup-failed')
    let caught: unknown
    try {
      await participant.admitRuntime({
        sessionKey: { workspaceId: 'workspace-a', sessionId: 'session-a' },
        resourceType: 'summary', resourceId: 'summary-a', create: async () => ({}),
        publish: () => { throw publicationError }, drain: async () => {},
        disposeOnFailure: async () => { throw cleanupError },
      })
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([publicationError, cleanupError])
    const lease = await quiescence.acquire('workspace-a')
    await lease.release()
  })

  test('keeps a failed drain registered across later Q0 acquisitions', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: fakeSupervisor().port })
    let drains = 0
    await participant.admitRuntime({
      sessionKey: { workspaceId: 'workspace-a', sessionId: 'session-a' },
      resourceType: 'session', resourceId: 'workspace-a:session-a', create: async () => ({}), publish: () => {},
      drain: async () => { drains += 1; throw new Error('strict-disposal-failed') },
      disposeOnFailure: async () => {},
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(quiescence.acquire('workspace-a')).rejects.toMatchObject({
        residuals: [{ resources: [{ resourceId: 'workspace-a:session-a', code: 'resource-drain-failed' }] }],
      })
    }
    expect(drains).toBe(1)
  })

  test('publishes a temporary summary runtime before its long-lived call and drains it during the call', async () => {
    const quiescence = new WorkspaceQuiescenceCoordinator()
    const supervisor = fakeSupervisor()
    const participant = new PiWorkspaceDrainParticipant({ quiescence, supervisor: supervisor.port, timeoutMs: 1_000 })
    const callGate = deferred<string>()
    const drained = deferred()
    const key = { workspaceId: 'workspace-a', sessionId: 'session-a' }
    let publishedRegistration: { dispose(): void } | undefined
    const registration = await participant.admitRuntime({
      sessionKey: key,
      resourceType: 'summary',
      resourceId: 'summary-a',
      create: async () => ({ run: () => callGate.promise }),
      publish: (_resource, ownedRegistration) => { publishedRegistration = ownedRegistration },
      drain: async () => {
        publishedRegistration?.dispose()
        drained.resolve()
      },
      disposeOnFailure: async () => {},
    })
    const running = registration.resource.run()
    expect(publishedRegistration).toBe(registration)
    const acquiring = quiescence.acquire('workspace-a')
    await drained.promise
    callGate.resolve('summary')
    expect(await running).toBe('summary')
    registration.dispose()
    const lease = await acquiring
    await lease.release()
  })
})
