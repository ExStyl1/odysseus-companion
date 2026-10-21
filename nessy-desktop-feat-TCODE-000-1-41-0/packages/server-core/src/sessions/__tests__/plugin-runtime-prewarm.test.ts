import { describe, expect, it, jest } from 'bun:test'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * H1 live-refresh pre-warm: after `afterPluginMutation` →
 * `SessionManager.refreshPluginRuntime`, an IDLE session eagerly rebuilds its
 * capability snapshot through the existing `CapabilityResolver.resolve`
 * (lease released immediately), while a BUSY session keeps today's
 * `pendingPluginRuntimeRefreshReason` defer behavior untouched.
 */
describe('SessionManager plugin runtime pre-warm', () => {
  function createRecordingResolver(): CapabilityResolver & {
    resolvedContexts: CapabilityContext[]
    released: string[]
  } {
    const resolvedContexts: CapabilityContext[] = []
    const released: string[] = []
    return {
      resolvedContexts,
      released,
      resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
        resolvedContexts.push(context)
        return {
          context,
          generation: `prewarm-generation-${resolvedContexts.length}`,
          leaseId: `prewarm-lease-${resolvedContexts.length}`,
          entries: [],
          installedPlugins: [],
          diagnostics: [],
        }
      },
      releaseSnapshot: leaseId => { released.push(leaseId) },
      invalidate: () => undefined,
      isLeaseActive: leaseId => !released.includes(leaseId),
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }
  }

  function createSession(
    manager: ReturnType<typeof createTestSessionManager>,
    sessionId = 'session-1',
  ) {
    const managed = createManagedSession(
      {
        id: sessionId,
        name: sessionId,
        enabledSourceSlugs: ['zeta-source', 'alpha-source'],
      },
      { id: 'ws_test', name: 'Test Workspace', rootPath: '/unused/prewarm/workspace', createdAt: 1 },
      { messagesLoaded: true },
    )
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
    return managed
  }

  it('pre-warms an idle session with a fresh snapshot immediately after a plugin mutation', async () => {
    const resolver = createRecordingResolver()
    const manager = createTestSessionManager({ resolver })
    const managed = createSession(manager)
    const dispose = jest.fn()
    managed.agent = {
      isProcessing: () => false,
      drainAutomationEvents: async () => undefined,
      setAutomationSystem: () => undefined,
      setCapabilityTurnRuntime: () => undefined,
      dispose,
    } as never

    await manager.refreshPluginRuntime('ws_test', undefined, 'plugin install:demo')

    // Runtime torn down now (idle path), not deferred.
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(managed.pendingPluginRuntimeRefreshReason).toBeUndefined()
    // Fresh snapshot resolved eagerly for this session and its lease released
    // right away — no turn state (capabilityRuntime/lease) is mutated.
    expect(resolver.resolvedContexts).toHaveLength(1)
    expect(resolver.resolvedContexts[0]).toMatchObject({
      workspaceId: 'ws_test',
      sessionId: 'session-1',
      enabledSourceNames: ['alpha-source', 'zeta-source'],
    })
    expect(resolver.released).toEqual(['prewarm-lease-1'])
    expect(managed.capabilityRuntime).toBeUndefined()
    expect(managed.capabilityLeaseId).toBeUndefined()
    manager.cleanup()
  })

  it('defers a busy session exactly as today and never pre-warms it', async () => {
    const resolver = createRecordingResolver()
    const manager = createTestSessionManager({ resolver })
    const managed = createSession(manager)
    const dispose = jest.fn()
    managed.isProcessing = true
    managed.agent = { isProcessing: () => false, dispose } as never

    await manager.refreshPluginRuntime('ws_test', undefined, 'plugin install:demo')

    // Deferred: reason recorded, runtime untouched, no eager resolve.
    expect(managed.pendingPluginRuntimeRefreshReason).toBe('plugin install:demo')
    expect(dispose).not.toHaveBeenCalled()
    expect(managed.agent).not.toBeNull()
    expect(resolver.resolvedContexts).toHaveLength(0)
    expect(resolver.released).toEqual([])
    managed.agent = null
    manager.cleanup()
  })

  it('refreshes independent idle sessions concurrently instead of serializing their teardown latency', async () => {
    const resolver = createRecordingResolver()
    const manager = createTestSessionManager({ resolver })
    const first = createSession(manager, 'session-a')
    const second = createSession(manager, 'session-b')
    const started: string[] = []
    let signalFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve })
    let releaseDisposals!: () => void
    const disposalGate = new Promise<void>(resolve => { releaseDisposals = resolve })
    const agent = (sessionId: string) => ({
      isProcessing: () => false,
      drainAutomationEvents: async () => undefined,
      setAutomationSystem: () => undefined,
      setCapabilityTurnRuntime: () => undefined,
      disposeForRestart: async () => {
        started.push(sessionId)
        if (started.length === 1) signalFirstStarted()
        await disposalGate
      },
    })
    first.agent = agent('session-a') as never
    second.agent = agent('session-b') as never

    const refresh = manager.refreshPluginRuntime('ws_test', undefined, 'plugin disable:demo')
    await firstStarted
    await Promise.resolve()
    try {
      // Both independent teardowns must have started before either is released.
      // With a serial loop this contains only the first session.
      expect(started.sort()).toEqual(['session-a', 'session-b'])
    } finally {
      releaseDisposals()
      await refresh
      manager.cleanup()
    }
  })
})
