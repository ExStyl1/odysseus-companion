import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { sessionPersistenceQueue, type StoredSession } from '@nessy-agent/shared/sessions'
import { ExecutionReceiptRing } from '@nessy-agent/shared/agent/pi-harness/execution-observability'
import { createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

afterEach(() => mock.restore())

describe('SessionManager durable execution observability', () => {
  it('persists only the canonical already-redacted envelope', () => {
    const workspace = { id: 'workspace-receipts', name: 'Workspace', rootPath: '/tmp/workspace', createdAt: 1 }
    const managed = createManagedSession({ id: 'session-receipts' }, workspace as never, { messagesLoaded: true })
    managed.piExecutionReceipts = new ExecutionReceiptRing({ workspaceId: workspace.id, sessionId: managed.id })
    managed.piExecutionReceipts.append({
      executionId: 'call-1', semanticId: 'mcp_dynamic', outcome: 'error', startedAt: 1, completedAt: 2,
      manifestGeneration: 'generation-1', responseEpoch: 1, effect: 'externalMutation', isolationProfile: 'plugin-mcp',
      decisionId: 'decision-1', code: 'execution_error', mcpServer: 'gitlab', mcpTool: 'get_repo',
    })
    let queued: StoredSession | undefined
    spyOn(sessionPersistenceQueue, 'enqueue').mockImplementation(value => { queued = value })

    const manager = createTestSessionManager()
    ;(manager as unknown as { enqueuePersist(value: typeof managed): void }).enqueuePersist(managed)

    expect(queued?.piExecutionObservations).toEqual(managed.piExecutionReceipts.persistedSnapshot())
    expect(JSON.stringify(queued?.piExecutionObservations)).not.toContain('/tmp/workspace')
    expect(JSON.stringify(queued?.piExecutionObservations)).not.toContain('credential')
  })

  /**
   * 2026-09-11 (W12-c) · both cases in this describe used to start from
   * a bare prototype double, which carries NO class field at
   * all, and each therefore had to enumerate by hand every private the code
   * under test happens to touch. That enumeration has gone stale for a string
   * of unrelated reasons — `crossSessionInboundStates` (W2-h, 2026-09-03),
   * `runtimeSwitchesInFlight` (T8), and in ONE sitting today `cliActiveSince`
   * (`f3160a2a0`, P6.461), `sessionIdleSubscriptions` (`d1e5a5b40`, P6.465) and
   * `persistFailureUnsubscribe` (`6e0ef8cf5`) — every time reading at the call
   * site as a telemetry defect rather than as a missing field, and each time
   * one layer deeper than the last.
   *
   * `createTestSessionManager` is the seam that already exists for this, it
   * takes `piTelemetry` as a dependency, and a real instance has every private
   * initialised at its declaration exactly as production does. So the fixtures
   * below are the overrides that STEER each case, and nothing that merely keeps
   * it from throwing. The enumeration cannot go stale again because there is
   * none.
   */
  it('emits receipt and lifecycle telemetry only for Pi and settles once after an empty queue', async () => {
    const events: Array<Record<string, unknown>> = []
    const manager = createTestSessionManager({
      piTelemetry: { emit: (_session: unknown, event: Record<string, unknown>) => events.push(event), shutdown: async () => undefined },
    } as never) as any
    const managed = {
      id: 'session-telemetry',
      workspace: { id: 'workspace-telemetry', rootPath: '/tmp/workspace', name: 'Workspace', createdAt: 1 },
      isProcessing: false,
      messageQueue: [],
      queuePaused: false,
      messages: [],
    }
    manager.resolveManagedProvider = () => 'pi'
    manager.persistSession = mock(() => {})
    manager.emitPiHarnessInvalidation = mock(() => {})

    manager.setProcessing(managed, true)
    manager.setProcessing(managed, true)
    manager.appendPiExecutionReceipt(managed, {
      executionId: 'execution-1', semanticId: 'plugin-hook', outcome: 'success', startedAt: 1, completedAt: 3,
      manifestGeneration: 'generation-1', responseEpoch: 1, effect: 'externalMutation', isolationProfile: 'workspace', decisionId: 'decision-1',
    })
    expect(events.map(event => event.name)).toEqual(['session.started', 'hook.completed'])

    manager.sessions = new Map([['workspace-telemetry:session-telemetry', managed]])
    manager.setProcessing = (value: typeof managed, processing: boolean) => { value.isProcessing = processing }
    manager.flushPendingPluginRuntimeRefresh = async () => undefined
    manager.getBrowserPaneManagerForSession = () => null
    manager.activeViewingSession = new Map()
    manager.sendEvent = mock(() => {})
    manager.persistSession = mock(() => {})
    manager.schedulePiGoalContinuation = mock(() => {})
    manager.getPiHarnessRuntimeSnapshot = async () => ({ settlement: { settled: true } })
    managed.isProcessing = true
    await manager.onProcessingStopped(managed.id, 'complete', managed.workspace.id)
    await manager.onProcessingStopped(managed.id, 'complete', managed.workspace.id)
    expect(events.filter(event => event.name === 'session.settled')).toEqual([
      expect.objectContaining({ outcome: 'success' }),
    ])

    manager.resolveManagedProvider = () => 'nestor-cloud-agent'
    manager.setProcessing(managed, true)
    manager.appendPiExecutionReceipt(managed, {
      executionId: 'execution-2', semanticId: 'tool-2', outcome: 'success', startedAt: 1, completedAt: 2,
      manifestGeneration: 'generation-1', responseEpoch: 1, effect: 'read', isolationProfile: 'workspace', decisionId: 'decision-2',
    })
    expect(events).toHaveLength(3)
  })

  it('awaits and swallows telemetry shutdown during cleanup', async () => {
    const shutdown = mock(async () => { throw new Error('collector unavailable') })
    // The whole fixture, where thirty-odd hand-seeded private maps used to
    // stand. Everything they were for — `cleanup()` clears each of them — a
    // real instance has already. `persistFailureUnsubscribe` (`6e0ef8cf5`) is
    // the arrival that settles the argument for the docblock above: it is a
    // FUNCTION called unqualified, not one more map cleared, so there was never
    // a shape a reader could have guessed from the maps around it — and it was
    // hiding one layer behind `sessionIdleSubscriptions`, which was itself
    // hiding behind `cliActiveSince`.
    const manager = createTestSessionManager({
      piTelemetry: { emit: () => undefined, shutdown },
    } as never) as any

    await expect(manager.cleanup()).resolves.toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
