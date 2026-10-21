/**
 * UB12.12 — the host half: the TURN's capability lease outlives the turn for a DETACHED
 * Pi MCP call, and only until that call settles.
 *
 * Premise read at HEAD 4428a844b: the retain already existed — the subprocess's R10
 * detach emits `task_backgrounded {kind: 'mcp'}` inside the turn, and that case calls
 * `retainPiBackgroundChildAuthority` with no kind filter, so the task authority holds a
 * reference to the turn's retainable lease and the send's end (`capabilityAutomationLease
 * .release()`) drops only the turn's own reference. The RELEASE did not: a detached MCP
 * call settles with `task_notification` (never `task_completed`, the only event that
 * released a task authority), so the lease — and the plugin instance leases under it —
 * stayed held until the agent was disposed.
 *
 * With the release at `task_notification`, `PiAgent.handleToolExecuteRequest` keeps the
 * lease check for a detached call (pi-detached-tool-survives-stop.test.ts, shared): after
 * the turn ends the lease is held unless REVOKED, so a revoke while no turn runs refuses
 * the late result, and an unrevoked call still reports it.
 */
import { describe, expect, test } from 'bun:test'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * The resolver contract this row rests on (resolver.ts `invalidate` / `isLeaseActive`,
 * pinned by resolver.test.ts "revoke-active-snapshot marks the matching lease inactive"):
 * a revoke marks a HELD lease inactive, and a released lease is gone.
 */
function createRevocableResolver(): CapabilityResolver {
  let sequence = 0
  const leases = new Map<string, { revoked: boolean }>()
  return {
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      sequence += 1
      const leaseId = `ub1212-lease-${sequence}`
      leases.set(leaseId, { revoked: false })
      return { context, generation: `ub1212-generation-${sequence}`, leaseId, entries: [], installedPlugins: [], diagnostics: [] }
    },
    releaseSnapshot: leaseId => { leases.delete(leaseId) },
    invalidate: (_scope, _reason, effect) => {
      if (effect !== 'revoke-active-snapshot') return
      for (const record of leases.values()) record.revoked = true
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
  const resolver = createRevocableResolver()
  const manager = createTestSessionManager({ resolver })
  const managed: any = {
    id: 'ub1212-session',
    workspace: { id: 'ub1212-workspace', rootPath: process.cwd() },
    llmConnection: 'pi',
    messages: [],
    messagesLoaded: true,
    backgroundTaskOutputs: new Map(),
    backgroundShellCommands: new Map(),
  }
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), managed)
  ;(manager as any).persistSession = () => {}
  // The R10 delivery (idle starts a turn, busy queues) is not this row's subject.
  const delivered: string[] = []
  ;(manager as any).deliverMonitorEvent = async (input: { taskId: string }) => { delivered.push(input.taskId) }

  const snapshot = await resolver.resolve({
    workspaceId: managed.workspace.id,
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

  return {
    manager,
    managed,
    resolver,
    leaseId: snapshot.leaseId,
    delivered,
    processEvent: (event: Record<string, unknown>) => (manager as any).processEvent(managed, event),
    /** The send's `finally`: the turn's fields cleared, then the TURN's reference released. */
    endTurn: () => {
      managed.agentAutomationCapabilityLease = undefined
      managed.capabilityLeaseId = undefined
      managed.capabilityRuntime = undefined
      lease.release()
    },
  }
}

describe('UB12.12 — a detached Pi MCP call holds the turn\'s lease until it settles', () => {
  test('POSITIVE — retained past the turn end (a revoke then reads inactive), released at the call\'s task_notification', async () => {
    const r = await rig()
    try {
      await r.processEvent({ type: 'task_backgrounded', toolUseId: 'call-mcp', taskId: 'task-mcp-ub1212', kind: 'mcp' })
      r.endTurn()
      // Held by the task authority: the turn's end did not release it.
      expect(r.resolver.isLeaseActive(r.leaseId)).toBe(true)
      expect(r.resolver.leaseCount()).toBe(1)

      // A revoke while no turn runs reaches the held lease, which is what the detached call's
      // lease check reads at its settle (`PiAgent.handleToolExecuteRequest`).
      r.resolver.invalidate({ kind: 'workspace', workspaceId: r.managed.workspace.id }, 'ub1212-revoke', 'revoke-active-snapshot')
      expect(r.resolver.isLeaseActive(r.leaseId)).toBe(false)

      // The call settles (the subprocess's `task_notification`, sent after the host's answer):
      // the authority lets go and the snapshot is released.
      await r.processEvent({ type: 'task_notification', taskId: 'task-mcp-ub1212', text: 'MCP background task task-mcp-ub1212 (mcp__s__w) completed:\nok' })
      expect(r.resolver.leaseCount()).toBe(0)
      expect(r.managed.piBackgroundChildTaskAuthorities?.has('task-mcp-ub1212') ?? false).toBe(false)
      expect(r.delivered).toEqual(['task-mcp-ub1212'])
    } finally {
      r.manager.cleanup()
    }
  })

  test('BOUNDARY — a task_notification for a task that is not a detached MCP call releases nothing', async () => {
    const r = await rig()
    try {
      await r.processEvent({ type: 'task_backgrounded', toolUseId: 'call-workflow', taskId: 'task-workflow-ub1212', kind: 'workflow' })
      r.endTurn()
      expect(r.resolver.leaseCount()).toBe(1)

      // Same id as the workflow's: only the `mcp` kind settles on a notification; a workflow
      // lets go at its own `task_completed`.
      await r.processEvent({ type: 'task_notification', taskId: 'task-workflow-ub1212', text: 'not an MCP settle' })
      expect(r.resolver.isLeaseActive(r.leaseId)).toBe(true)
      expect(r.resolver.leaseCount()).toBe(1)

      await r.processEvent({ type: 'task_completed', taskId: 'task-workflow-ub1212', status: 'stopped' })
      expect(r.resolver.leaseCount()).toBe(0)
    } finally {
      r.manager.cleanup()
    }
  })
})
