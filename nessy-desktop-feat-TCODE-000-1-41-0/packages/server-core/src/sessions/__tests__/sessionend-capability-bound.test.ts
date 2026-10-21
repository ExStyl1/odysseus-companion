/**
 * F1.642 (origin WJ-bu P-WJbu-1) — a SIGTERM'd codex session waited 14-23 s in
 * `createCapabilityTurn` during `endManagedAgentLifecycle` before SessionEnd
 * ran, and a 10 s supervisor grace killed the process first. The probe
 * (`work/wjbu/codex-probe-1.log`) split it: the capability-turn acquire 0 ms,
 * `createCapabilityTurn` itself 22.8 s (14.6 s with no turn), SessionEnd 4 s;
 * Pi 0.1 s on the same path. The row's own suggestions are both taken: the
 * lifecycle REUSES the session's live capability snapshot when one is still
 * leased, and otherwise BOUNDS the rebuild so the end-of-life teardown
 * completes inside the grace — the slow rebuild is dropped on the floor (its
 * lease released when it settles) and NO SessionEnd hook runs on that path:
 * the catch pins no hook authority, the shape a failed rebuild already had.
 *
 * The bound's arithmetic, stated: 4 s rebuild bound + the measured 4 s SessionEnd
 * is ~8 s inside the 10 s Docker default; Pi's 2.2 s and claude's 5.6 s totals
 * keep their healthy rebuilds whole.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

interface Turn {
  snapshot: { leaseId: string }
  runtime: unknown
}

interface LifecycleHarness {
  manager: any
  managed: any
  internals: Record<string, unknown> & {
    endManagedAgentLifecycle(managed: unknown, reason: string): Promise<void>
    createCapabilityTurn(managed: unknown): Promise<Turn>
    buildAgentAutomationSystem(...args: unknown[]): Promise<unknown>
    capabilityResolver: { isLeaseActive(leaseId: string): boolean; releaseSnapshot(leaseId: string): void; leaseCount(): number }
  }
  agent: {
    setAutomationSystem: (system: unknown) => void
    setCapabilityTurnRuntime: (runtime: unknown) => void
    endLifecycle: () => Promise<void>
  }
  calls: { automationSystems: unknown[]; runtimes: unknown[]; endLifecycles: number; creates: number }
  settleCreate(leaseId: string): void
  pendingCreates(): number
}

async function lifecycleHarness(sessionId: string): Promise<LifecycleHarness> {
  const manager = createTestSessionManager() as any
  const internals = manager as unknown as LifecycleHarness['internals'] & { persistSession(): void; emitPiHarnessInvalidation(): void }
  internals.persistSession = () => {}
  internals.emitPiHarnessInvalidation = () => {}
  internals.buildAgentAutomationSystem = async () => ({ pinned: true })
  const session = await manager.createSession(sessionId, {})
  const managed = manager.getManaged(session.id, sessionId)
  const calls = { automationSystems: [] as unknown[], runtimes: [] as unknown[], endLifecycles: 0, creates: 0 }
  const agent = {
    setAutomationSystem: (system: unknown) => { calls.automationSystems.push(system) },
    setCapabilityTurnRuntime: (runtime: unknown) => { calls.runtimes.push(runtime) },
    endLifecycle: async () => { calls.endLifecycles += 1 },
    drainAutomationEvents: async () => {},
  }
  managed.agent = agent
  const createCalls: Array<(value: Turn) => void> = []
  internals.createCapabilityTurn = ((): Promise<Turn> => {
    calls.creates += 1
    return new Promise(resolve => { createCalls.push(resolve) })
  }) as LifecycleHarness['internals']['createCapabilityTurn']
  return {
    manager,
    managed,
    internals: internals as LifecycleHarness['internals'],
    agent,
    calls,
    settleCreate: (leaseId: string) => { createCalls.shift()?.({ snapshot: { leaseId }, runtime: { made: leaseId } }) },
    pendingCreates: () => createCalls.length,
  }
}

const REAL_BOUND = (SessionManager as unknown as { SESSIONEND_REBUILD_BOUND_MS: number }).SESSIONEND_REBUILD_BOUND_MS
afterEach(() => {
  (SessionManager as unknown as { SESSIONEND_REBUILD_BOUND_MS: number }).SESSIONEND_REBUILD_BOUND_MS = REAL_BOUND
})

describe('F1.642 — SessionEnd runs inside the supervisor grace', () => {
  test('THE DEFECT — a hung capability rebuild no longer holds the lifecycle: it completes inside the bound, pins no hook authority, and the late lease is released', async () => {
    const h = await lifecycleHarness('f1642-hung-rebuild')
    // The spy pins the "released when it settles" half (F1.642 repair): the
    // dropped rebuild's lease is handed back when it eventually resolves.
    const released: string[] = []
    h.internals.capabilityResolver = {
      isLeaseActive: () => false,
      releaseSnapshot: (leaseId: string) => { released.push(leaseId) },
      leaseCount: () => 0,
    } as LifecycleHarness['internals']['capabilityResolver']
    ;(SessionManager as unknown as { SESSIONEND_REBUILD_BOUND_MS: number }).SESSIONEND_REBUILD_BOUND_MS = 50
    try {
      // At HEAD this await never returns: createCapabilityTurn is awaited
      // unconditionally, so a watchdog is what makes the red deterministic.
      const lifecycle = h.internals.endManagedAgentLifecycle(h.managed, 'session deletion')
      const ran = await Promise.race([
        lifecycle.then(() => true),
        tick(3_000).then(() => false),
      ])
      expect(ran).toBe(true)
      expect(h.calls.endLifecycles).toBe(1)
      expect(h.calls.creates).toBe(1)
      // Timeout path: the catch pins NO hook authority — the finally's own
      // disarm is the only setAutomationSystem call, so no SessionEnd hook
      // runs there (the shape a failed rebuild already had).
      expect(h.calls.automationSystems).toEqual([undefined])
      // The dropped rebuild is still pending; the lifecycle is done anyway.
      expect(h.pendingCreates()).toBe(1)
      // Settling it late must not throw and must not leak an unhandled rejection.
      h.settleCreate('lease-late')
      await tick(20)
      expect(h.calls.endLifecycles).toBe(1)
      // The late-settling rebuild's lease is released when it settles.
      expect(released).toEqual(['lease-late'])
    } finally {
      h.managed.agent = undefined
      await h.manager.cleanup()
    }
  })

  test('THE REUSE — a live, still-leased snapshot is pinned without a rebuild', async () => {
    const h = await lifecycleHarness('f1642-reuse-live')
    h.internals.capabilityResolver = {
      isLeaseActive: (leaseId: string) => leaseId === 'lease-live',
      releaseSnapshot: () => {},
      leaseCount: () => 0,
    } as LifecycleHarness['internals']['capabilityResolver']
    ;(h.managed as unknown as { capabilityLeaseId?: string }).capabilityLeaseId = 'lease-live'
    ;(h.managed as unknown as { capabilityRuntime?: unknown }).capabilityRuntime = { live: true }
    try {
      await h.internals.endManagedAgentLifecycle(h.managed, 'session deletion')
      expect(h.calls.creates).toBe(0)
      // The pin, then the lifecycle's own disarm (the finally sets null).
      expect(h.calls.runtimes).toEqual([{ live: true }, null])
      expect(h.calls.endLifecycles).toBe(1)
      expect(h.calls.automationSystems).toEqual([{ pinned: true }, undefined])
    } finally {
      h.managed.agent = undefined
      await h.manager.cleanup()
    }
  })

  test('CONTROL — a fast rebuild is still created, pinned and released as before', async () => {
    const h = await lifecycleHarness('f1642-fast-rebuild')
    ;(SessionManager as unknown as { SESSIONEND_REBUILD_BOUND_MS: number }).SESSIONEND_REBUILD_BOUND_MS = 50
    try {
      const lifecycle = h.internals.endManagedAgentLifecycle(h.managed, 'session deletion')
      await tick(5)
      h.settleCreate('lease-fast')
      await lifecycle
      expect(h.calls.creates).toBe(1)
      expect(h.calls.endLifecycles).toBe(1)
      expect(h.calls.automationSystems).toEqual([{ pinned: true }])
    } finally {
      h.managed.agent = undefined
      await h.manager.cleanup()
    }
  })
})
