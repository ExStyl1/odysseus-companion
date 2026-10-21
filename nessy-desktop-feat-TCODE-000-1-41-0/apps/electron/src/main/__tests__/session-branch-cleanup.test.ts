import { describe, expect, it } from 'bun:test'
import { rollbackFailedBranchCreation } from '@nessy-agent/server-core/domain'

describe('rollbackFailedBranchCreation', () => {
  it('awaits strict Pi runtime disposal before deleting a failed branch', async () => {
    const agent = { id: 'pi-subprocess' }
    const managed: {
      agent: typeof agent | null
      poolServer?: { id: string }
      mcpPool?: { id: string }
      mcpPoolLease?: { id: string }
      mcpLeaserId?: string
      piDrainRegistration?: { id: string }
    } = {
      agent,
      poolServer: { id: 'pool-server' },
      mcpPool: { id: 'mcp-pool' },
      mcpPoolLease: { id: 'mcp-lease' },
      mcpLeaserId: 'session-leaser',
      piDrainRegistration: { id: 'drain-registration' },
    }
    const events: string[] = []
    let finishDisposal!: () => void
    const disposalMayFinish = new Promise<void>(resolve => {
      finishDisposal = resolve
    })

    const rollback = rollbackFailedBranchCreation({
      managed,
      preflightError: new Error('ensureBranchReady-failed'),
      workspaceId: 'workspace-1',
      sessionId: 'child-1',
      disposeRuntime: async expectedAgent => {
        expect(expectedAgent).toBe(agent)
        events.push('dispose:start')
        await disposalMayFinish
        managed.agent = null
        delete managed.poolServer
        delete managed.mcpPool
        delete managed.mcpPoolLease
        delete managed.mcpLeaserId
        delete managed.piDrainRegistration
        events.push('dispose:done')
      },
      deleteStoredSession: async () => {
        events.push('storage:delete')
      },
      deleteFromRuntimeSessions: () => {
        events.push('runtime:delete')
      },
    })

    await Promise.resolve()
    expect(events).toEqual(['dispose:start'])

    finishDisposal()
    await expect(rollback).rejects.toThrow('Could not create branch: ensureBranchReady-failed')
    expect(events).toEqual(['dispose:start', 'dispose:done', 'storage:delete', 'runtime:delete'])
    expect(managed.agent).toBeNull()
    expect(managed.poolServer).toBeUndefined()
    expect(managed.mcpPool).toBeUndefined()
    expect(managed.mcpPoolLease).toBeUndefined()
    expect(managed.mcpLeaserId).toBeUndefined()
    expect(managed.piDrainRegistration).toBeUndefined()
  })

  it('retains all owners and storage when strict Pi disposal fails', async () => {
    const preflightError = new Error('ensureBranchReady-failed')
    const disposalError = new AggregateError(
      [new Error('subprocess-still-running')],
      'pi-session-disposal-failed',
    )
    const agent = { id: 'pi-subprocess' }
    const poolServer = { id: 'pool-server' }
    const mcpPool = { id: 'mcp-pool' }
    const mcpPoolLease = { id: 'mcp-lease' }
    const piDrainRegistration = { id: 'drain-registration' }
    const managed = {
      agent,
      poolServer,
      mcpPool,
      mcpPoolLease,
      mcpLeaserId: 'session-leaser',
      piDrainRegistration,
    }
    let storageDeleted = false
    let runtimeDeleted = false
    let thrown: unknown

    try {
      await rollbackFailedBranchCreation({
        managed,
        preflightError,
        workspaceId: 'workspace-1',
        sessionId: 'child-2',
        disposeRuntime: async expectedAgent => {
          expect(expectedAgent).toBe(agent)
          throw disposalError
        },
        deleteStoredSession: async () => {
          storageDeleted = true
        },
        deleteFromRuntimeSessions: () => {
          runtimeDeleted = true
        },
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).message)
      .toBe('Could not create branch: ensureBranchReady-failed; rollback failed: pi-session-disposal-failed')
    expect((thrown as AggregateError).errors).toEqual([preflightError, disposalError])
    expect(storageDeleted).toBe(false)
    expect(runtimeDeleted).toBe(false)
    expect(managed.agent).toBe(agent)
    expect(managed.poolServer).toBe(poolServer)
    expect(managed.mcpPool).toBe(mcpPool)
    expect(managed.mcpPoolLease).toBe(mcpPoolLease)
    expect(managed.mcpLeaserId).toBe('session-leaser')
    expect(managed.piDrainRegistration).toBe(piDrainRegistration)
  })
})
