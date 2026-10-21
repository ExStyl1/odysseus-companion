/**
 * F1.1243 (CR-B, the final CDP sitting 2026-10-01, SIT2-e FAIL 2) — a Pi outside-root card the Stop refused leaves
 * the host. The outside-root twin of F1.910 (`pi-stop-refused-card-leaves-host.test.ts`, Pi permission-service cards).
 *
 * Measured on the RC (session `8fe449d2`): after a Stop with "Allow write access outside the session root" up, the
 * session still showed `awaitingApprovalCount` 1, a persisted `pendingApproval` and the backend's pending entry.
 * `PiAgent.forceAbort` denied the call (`outside_root_response root:null`) and dropped its own entry, but sent the host
 * nothing, and the call's `outside_root_cancel` that followed found no entry to withdraw. After a restart
 * `reprojectPendingApproval` re-shows such a record, and one Allow re-drives the stopped call (R7).
 *
 * The rig is a REAL SessionManager and a REAL PiAgent wired the way `getOrCreateAgentUnchecked` wires them (the
 * out-of-turn channel, F1.369, and `onPermissionRequest`), the card raised through the agent's own `handleLine`, the
 * Stop through the host's own `cancelProcessing`. Only the subprocess pipe is replaced.
 *
 * SAFETY: no real home directory, no credential; nothing is executed.
 */
import { describe, expect, test } from 'bun:test'
import { PiAgent } from '@nessy-agent/shared/agent/pi-agent'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

let counter = 0

function rig() {
  counter += 1
  const workspace = { id: `ws-f1-1243-${counter}`, rootPath: process.cwd() }
  const sessionId = `session-f1-1243-${counter}`
  const agent = new PiAgent({
    provider: 'pi',
    workspace: { ...workspace, name: 'F1.1243', workspaceRootPath: process.cwd(), sessionRootPath: `/tmp/nessy-f1-1243-sessions/${workspace.id}` } as any,
    session: { id: sessionId, workspaceRootPath: process.cwd(), createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    isHeadless: true,
    skipConfigWatcher: true,
  } as any)
  const sent: Array<Record<string, unknown>> = []
  const runtime = agent as any
  runtime.send = (message: Record<string, unknown>) => { sent.push(message) }
  runtime.subprocess = {}
  runtime.emitAutomationEvent = async () => {}
  const managed: Record<string, any> = {
    id: sessionId,
    activeProvider: 'pi',
    permissionMode: 'default',
    isProcessing: true,
    processingGeneration: 3,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace,
    workingDirectory: process.cwd(),
    agent,
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId }), managed)
  const withdrawn: string[] = []
  const raised: string[] = []
  manager.sendEvent = (event: { type?: string; requestId?: string; request?: { requestId?: string } }) => {
    if (event?.type === 'permission_request_cancelled' && event.requestId) withdrawn.push(event.requestId)
    if (event?.type === 'permission_request' && event.request?.requestId) raised.push(event.request.requestId)
  }
  // Production's two lines in `getOrCreateAgentUnchecked`.
  manager.wireOutOfTurnCardWithdrawal(managed)
  agent.onPermissionRequest = request => manager.handleAgentPermissionRequest(managed, request)
  const line = (message: Record<string, unknown>) => runtime.handleLine(JSON.stringify(message))
  const count = (): number => manager.awaitingApprovalCount(managed)
  const dispose = () => { runtime.subprocess = null; agent.destroy() }
  return { manager, managed, agent, runtime, sent, withdrawn, raised, line, count, dispose }
}

/** `processEvent` runs behind a `void … .catch`, so let it land. */
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

describe('F1.1243 — a Pi outside-root card the Stop refused leaves the host', () => {
  for (const silent of [false, true]) {
    test(`${silent ? 'a redirect (silent Stop)' : 'a Stop'} with an outside-root card up: count 0, no pendingApproval, renderer told, the call denied`, async () => {
      const r = rig()
      try {
        r.runtime._isProcessing = true
        await r.line({ type: 'outside_root_request', requestId: 'pi-oroot-1243', canonicalTarget: '/Users/x/sit2-e/out.txt', access: 'write' })
        expect(r.raised).toEqual(['pi-oroot-1243'])
        expect(r.count()).toBe(1)
        expect(r.managed.pendingApproval?.requestId).toBe('pi-oroot-1243')

        await r.manager.cancelProcessing(r.managed.id, silent, r.managed.workspace.id)
        await settle()

        expect(r.sent).toContainEqual({ type: 'outside_root_response', requestId: 'pi-oroot-1243', root: null })
        expect(r.count()).toBe(0)
        expect(r.manager.pendingPermissionRequests.has('pi-oroot-1243')).toBe(false)
        expect(r.managed.pendingApproval).toBeUndefined()
        expect(r.withdrawn).toEqual(['pi-oroot-1243'])
      } finally {
        r.dispose()
      }
    })
  }

  test('CONTROL — a call that timed out between turns still withdraws its card through handleOutsideRootCancel', async () => {
    const r = rig()
    try {
      await r.line({ type: 'outside_root_request', requestId: 'pi-oroot-timeout', canonicalTarget: '/Users/x/late.txt', access: 'read' })
      expect(r.count()).toBe(1)
      r.runtime._isProcessing = false
      await r.line({ type: 'outside_root_cancel', requestId: 'pi-oroot-timeout', reason: 'timed_out' })
      await settle()
      expect(r.count()).toBe(0)
      expect(r.managed.pendingApproval).toBeUndefined()
      expect(r.withdrawn).toEqual(['pi-oroot-timeout'])
      expect(r.sent).toEqual([])
    } finally {
      r.dispose()
    }
  })
})
