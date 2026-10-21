/**
 * UB12.36 — a capability revoked while no turn of its lease runs ABORTS a detached Pi MCP call, not only refuses its
 * late result (UB12.12).
 *
 * Premise read at HEAD ec06707a2: the revoke arm (`subscribeInvalidation`, `revoke-active-snapshot`) iterated only the
 * sessions whose `capabilityLeaseId` the event names, and that field is unset between turns. A detached call's lease
 * outlives the turn in its task authority (`piBackgroundChildTaskAuthorities`, UB12.12), so a revoke while idle marked
 * the lease inactive and the call's result was refused at its settle, while the call itself kept executing on the host.
 *
 * Now the arm also walks, for every session it does not force-abort, the retained task authorities, and for one whose
 * lease the event revokes it calls `PiAgent.abortDetachedToolCallsForTask` with `capability-snapshot-revoked`: the same
 * abort the in-turn revoke's `forceAbort(InternalError)` sweep performs, scoped to that task. The idle session itself
 * is neither force-aborted nor given a turn note.
 *
 * The rig is the real `SessionManager` (its `subscribeInvalidation` seam captured, the UB12.12 revocable resolver) and
 * a real `PiAgent` holding one detached call; `pi-detached-tool-survives-stop.test.ts` (shared) pins the agent half.
 */
import { describe, expect, test } from 'bun:test'
import type { BackendConfig } from '@nessy-agent/shared/agent/backend/types'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

type InvalidationEvent = {
  scope: { kind: string; workspaceId?: string }
  effect: 'revoke-active-snapshot' | 'refresh-before-next-turn'
  revokedLeaseIds: string[]
  reason?: string
}

/** resolver.ts `invalidate`: a revoke marks every HELD lease the scope matches inactive and names it on the event. */
function createRevocableResolver(emit: (event: InvalidationEvent) => void): CapabilityResolver {
  let sequence = 0
  const leases = new Map<string, { revoked: boolean }>()
  return {
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      sequence += 1
      const leaseId = `ub1236-lease-${sequence}`
      leases.set(leaseId, { revoked: false })
      return { context, generation: `ub1236-generation-${sequence}`, leaseId, entries: [], installedPlugins: [], diagnostics: [] }
    },
    releaseSnapshot: leaseId => { leases.delete(leaseId) },
    invalidate: (scope, reason, effect) => {
      const revokedLeaseIds: string[] = []
      if (effect === 'revoke-active-snapshot') {
        for (const [leaseId, record] of leases) { record.revoked = true; revokedLeaseIds.push(leaseId) }
      }
      emit({ scope: scope as InvalidationEvent['scope'], reason, effect: effect as InvalidationEvent['effect'], revokedLeaseIds })
    },
    isLeaseActive: leaseId => {
      const record = leases.get(leaseId)
      return !!record && !record.revoked
    },
    referencedInstances: () => new Set(),
    leaseCount: () => leases.size,
  }
}

async function rig() {
  let listener: ((event: InvalidationEvent) => void) | undefined
  const resolver = createRevocableResolver(event => listener?.(event))
  const manager = createTestSessionManager({
    resolver,
    subscribeInvalidation: (next: (event: InvalidationEvent) => void) => { listener = next; return () => { listener = undefined } },
  } as never)
  const workspace = { id: 'ub1236-workspace', name: 'UB12.36', rootPath: process.cwd() }
  const agent = new PiAgent({
    provider: 'pi',
    workspace,
    model: '',
    isHeadless: true,
    skipConfigWatcher: true,
  } as unknown as BackendConfig) as any
  const forced: string[] = []
  agent.forceAbort = (reason: string) => { forced.push(reason) }
  const managed: any = {
    id: 'ub1236-session',
    workspace,
    llmConnection: 'pi',
    messages: [],
    messagesLoaded: true,
    backgroundTaskOutputs: new Map(),
    backgroundShellCommands: new Map(),
    agent,
  }
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), managed)
  ;(manager as any).persistSession = () => {}

  const snapshot = await resolver.resolve({
    workspaceId: workspace.id,
    sessionId: managed.id,
    enabledSourceNames: [],
    projectTrustState: 'none',
    projectTrustRevision: '',
  } as CapabilityContext)
  // A send's turn, as `sendMessage` opens it: the retainable lease and the turn runtime.
  const lease = (manager as any).createRetainedCapabilityLease(snapshot.leaseId)
  managed.capabilityRuntime = {
    materializer: { assertActive() { if (!resolver.isLeaseActive(snapshot.leaseId)) throw new Error('capability-snapshot-revoked') } },
  }
  managed.capabilityLeaseId = snapshot.leaseId
  managed.agentAutomationCapabilityLease = lease

  // The detached call, inside the turn: the subprocess's R10 detach moves the route out of the Stop sweep
  // (`tool_execute_detached`) and announces the task (`task_backgrounded {kind: 'mcp'}`), whose authority retains the lease.
  const route = new AbortController()
  agent.pendingToolExecutions.set('ub1236-request', route)
  agent.dispatchSubprocessMessage('tool_execute_detached', { requestId: 'ub1236-request', taskId: 'task-mcp-ub1236' })
  await (manager as any).processEvent(managed, { type: 'task_backgrounded', toolUseId: 'call-mcp', taskId: 'task-mcp-ub1236', kind: 'mcp' })

  // The send's `finally`: the turn's fields cleared, then the TURN's reference released. No turn runs from here on.
  managed.agentAutomationCapabilityLease = undefined
  managed.capabilityLeaseId = undefined
  managed.capabilityRuntime = undefined
  lease.release()

  return {
    manager,
    managed,
    resolver,
    agent,
    route,
    forced,
    leaseId: snapshot.leaseId,
    emit: (event: InvalidationEvent) => listener!(event),
    dispose: async () => {
      managed.agent = null
      agent.destroy()
      await manager.cleanup()
    },
  }
}

describe('UB12.36 — a revoke while no turn of its lease runs aborts the detached Pi MCP call it reaches', () => {
  test('POSITIVE — the revoke aborts the call\'s route signal with capability-snapshot-revoked; the idle session is not force-aborted', async () => {
    const r = await rig()
    try {
      expect(r.managed.capabilityLeaseId).toBeUndefined()
      expect(r.managed.piBackgroundChildTaskAuthorities?.get('task-mcp-ub1236')?.leaseId).toBe(r.leaseId)
      expect(r.route.signal.aborted).toBe(false)

      r.resolver.invalidate({ kind: 'workspace', workspaceId: r.managed.workspace.id }, 'plugin uninstall (local.ub1236)', 'revoke-active-snapshot')

      expect(r.route.signal.aborted).toBe(true)
      expect((r.route.signal.reason as Error).message).toBe('capability-snapshot-revoked')
      expect(r.agent.detachedToolExecutions.size).toBe(0)
      // Only the call: no turn of the lease ran, so nothing is force-aborted and no turn note is written.
      expect(r.forced).toEqual([])
      expect((r.managed.messages as unknown[]).length).toBe(0)
    } finally {
      await r.dispose()
    }
  })

  test('NEGATIVE — a refresh-before-next-turn invalidation does not abort it', async () => {
    const r = await rig()
    try {
      r.resolver.invalidate({ kind: 'workspace', workspaceId: r.managed.workspace.id }, 'plugin enable (local.ub1236)', 'refresh-before-next-turn')
      expect(r.route.signal.aborted).toBe(false)
      expect(r.agent.detachedToolExecutions.size).toBe(1)
      expect(r.forced).toEqual([])
    } finally {
      await r.dispose()
    }
  })

  test('BOUNDARY — a revoke naming another lease does not abort it', async () => {
    const r = await rig()
    try {
      r.emit({ scope: { kind: 'global' }, effect: 'revoke-active-snapshot', revokedLeaseIds: ['ub1236-lease-other'], reason: 'plugin uninstall (other)' })
      expect(r.route.signal.aborted).toBe(false)
      expect(r.agent.detachedToolExecutions.size).toBe(1)
    } finally {
      await r.dispose()
    }
  })
})
