import { describe, expect, it } from 'bun:test'
import {
  WorkspaceQuiescenceCoordinator,
  WorkspaceQuiescenceError,
  WorkspaceQuiescenceParticipantError,
  type WorkspaceQuiescenceParticipant,
} from './workspace-quiescence'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function participant(
  id: string,
  events: string[],
  options: { drainError?: string; releaseError?: string } = {},
): WorkspaceQuiescenceParticipant {
  return {
    id,
    async drain(workspaceId) {
      events.push(`drain:${id}:${workspaceId}`)
      if (options.drainError) throw new Error(options.drainError)
      return {
        async release() {
          events.push(`release:${id}:${workspaceId}`)
          if (options.releaseError) throw new Error(options.releaseError)
        },
      }
    },
  }
}

describe('Workspace quiescence coordinator', () => {
  it('marks the barrier before await and waits only pending admission sections', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    const events: string[] = []
    coordinator.registerParticipant(participant('sessions', events))
    const admission = coordinator.admit('sessions', 'workspace-a')

    const acquiring = coordinator.acquire('workspace-a')
    expect(() => coordinator.admit('sessions', 'workspace-a')).toThrow('workspace-draining')
    await Promise.resolve()
    expect(events).toEqual([])

    admission.release()
    const lease = await acquiring
    expect(events).toEqual(['drain:sessions:workspace-a'])
    await lease.release()
  })

  it('drains in stable order and releases in reverse order exactly once', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    const events: string[] = []
    coordinator.registerParticipant(participant('sessions', events))
    coordinator.registerParticipant(participant('automation', events))

    const lease = await coordinator.acquire('workspace-a')
    await Promise.all([lease.release(), lease.release()])
    await lease.release()

    expect(events).toEqual([
      'drain:sessions:workspace-a',
      'drain:automation:workspace-a',
      'release:automation:workspace-a',
      'release:sessions:workspace-a',
    ])
    expect(() => coordinator.admit('sessions', 'workspace-a')).not.toThrow()
  })

  it('rolls back every accepted participant and reports all acquire residuals', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    const events: string[] = []
    coordinator.registerParticipant(participant('first', events, { releaseError: 'first rollback failed' }))
    coordinator.registerParticipant(participant('second', events, { releaseError: 'second rollback failed' }))
    coordinator.registerParticipant(participant('failed', events, { drainError: 'drain failed' }))

    let error: unknown
    try {
      await coordinator.acquire('workspace-a')
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(WorkspaceQuiescenceError)
    expect(error).toMatchObject({
      code: 'workspace-quiescence-acquire-failed',
      workspaceId: 'workspace-a',
      residuals: [
        { participantId: 'failed', phase: 'drain', message: 'drain failed' },
        { participantId: 'second', phase: 'release', message: 'second rollback failed' },
        { participantId: 'first', phase: 'release', message: 'first rollback failed' },
      ],
    })
    expect(events).toEqual([
      'drain:first:workspace-a',
      'drain:second:workspace-a',
      'drain:failed:workspace-a',
      'release:second:workspace-a',
      'release:first:workspace-a',
    ])
    expect(() => coordinator.admit('first', 'workspace-a')).not.toThrow()
  })

  it('attempts every final release, clears the barrier, and shares one cleanup', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    const events: string[] = []
    coordinator.registerParticipant(participant('first', events, { releaseError: 'first failed' }))
    coordinator.registerParticipant(participant('second', events, { releaseError: 'second failed' }))
    const lease = await coordinator.acquire('workspace-a')

    const releases = [lease.release(), lease.release()]
    const settled = await Promise.allSettled(releases)

    expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected'])
    expect((settled[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'workspace-quiescence-release-failed',
      residuals: [
        { participantId: 'second', phase: 'release', message: 'second failed' },
        { participantId: 'first', phase: 'release', message: 'first failed' },
      ],
    })
    expect(events.filter(event => event.startsWith('release:'))).toHaveLength(2)
    expect(() => coordinator.admit('first', 'workspace-a')).not.toThrow()
  })

  it('rejects a second same-workspace generation while different workspaces proceed', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    const gate = deferred()
    const started: string[] = []
    coordinator.registerParticipant({
      id: 'sessions',
      async drain(workspaceId) {
        started.push(workspaceId)
        if (workspaceId === 'workspace-a') await gate.promise
        return { release: async () => {} }
      },
    })

    const first = coordinator.acquire('workspace-a')
    await Promise.resolve()
    await expect(coordinator.acquire('workspace-a')).rejects.toMatchObject({ code: 'workspace-already-draining' })
    const other = await coordinator.acquire('workspace-b')
    expect(started).toEqual(['workspace-a', 'workspace-b'])
    gate.resolve()
    const firstLease = await first
    await Promise.all([firstLease.release(), other.release()])
  })

  it('fails closed for duplicate and unknown participants and freezes registration during drain', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    const gate = deferred()
    const registration = coordinator.registerParticipant({
      id: 'sessions',
      async drain() {
        await gate.promise
        return { release: async () => {} }
      },
    })
    expect(() => coordinator.registerParticipant(participant('sessions', []))).toThrow('participant-already-registered')
    expect(() => coordinator.admit('missing', 'workspace-a')).toThrow('participant-not-registered')

    const acquiring = coordinator.acquire('workspace-a')
    await Promise.resolve()
    expect(() => coordinator.registerParticipant(participant('later', []))).toThrow('participant-registry-locked')
    expect(() => registration.dispose()).toThrow('participant-registry-locked')
    gate.resolve()
    const lease = await acquiring
    await lease.release()
    registration.dispose()
    registration.dispose()
    expect(() => coordinator.admit('sessions', 'workspace-a')).toThrow('participant-not-registered')
  })

  it('preserves structured participant resources through drain and release failures', async () => {
    const coordinator = new WorkspaceQuiescenceCoordinator()
    coordinator.registerParticipant({
      id: 'runtime',
      async drain() {
        throw new WorkspaceQuiescenceParticipantError('drain-failed', [
          { resourceType: 'process', resourceId: 'process_1', code: 'stop-failed' },
        ])
      },
    })
    await expect(coordinator.acquire('workspace-a')).rejects.toMatchObject({
      residuals: [{
        participantId: 'runtime',
        phase: 'drain',
        resources: [{ resourceType: 'process', resourceId: 'process_1', code: 'stop-failed' }],
      }],
    })

    const releaseCoordinator = new WorkspaceQuiescenceCoordinator()
    releaseCoordinator.registerParticipant({
      id: 'runtime',
      async drain() {
        return {
          async release() {
            throw new WorkspaceQuiescenceParticipantError('release-failed', [
              { resourceType: 'session', resourceId: 'workspace-a:session-a', code: 'release-failed' },
            ])
          },
        }
      },
    })
    const lease = await releaseCoordinator.acquire('workspace-a')
    await expect(lease.release()).rejects.toMatchObject({
      residuals: [{
        participantId: 'runtime',
        phase: 'release',
        resources: [{ resourceType: 'session', resourceId: 'workspace-a:session-a', code: 'release-failed' }],
      }],
    })
  })
})
