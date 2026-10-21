/**
 * F1.911 (origin WJ-crit-bbb P-3) — the two halves of the Stop/teardown residue
 * F1.900 left behind, measured on F1.208's rig (the real raise sites, the real
 * `cancelProcessing`, `sendEvent` as the instrument):
 *
 * 1. The `interrupted` event names the permission-request ids the host still
 *    holds for the session it stops, so the renderer's turn-end clear drops
 *    only what the host dropped and keeps the between-turn cards answerable.
 *    Before this, the renderer's clear hid every card filed under the session —
 *    including the composer `!` card the CONTROL in host-card-user-stop.test.ts
 *    proves the host still holds and counts.
 *
 * 2. `clearPendingPermissionRequestsForSession` (a Pi drain, a runtime switch,
 *    a rewind, a delete) withdraws every record it drops: an agent-raised
 *    record — one with no entry in `directPermissionResolvers` — used to be
 *    deleted with no `permission_request_cancelled` at all, leaving a card on
 *    screen whose resolver was gone.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  isProcessing: boolean
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'pi',
    permissionMode: 'default',
    isProcessing: true,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: `workspace-${id}`, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    ...extra,
  }
}

function harness(...sessions: SessionStub[]) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  for (const session of sessions) {
    manager.sessions.set(
      encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }),
      session,
    )
  }
  return manager
}

/** The full turn-end events, not just markers: the field under test rides on `interrupted`. */
function watchTurnEnds(manager: any) {
  const rig = { raised: [] as string[], interrupted: [] as Array<{ retainedPermissionRequestIds?: string[] }>, withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'interrupted') rig.interrupted.push(event)
    if (event?.type === 'permission_request_cancelled') rig.withdrawn.push(event.requestId)
    if (event?.type === 'permission_request') rig.raised.push(event.request?.requestId as string)
    return event
  }
  return rig
}

/** The 5 s stop safety timer reads these two; leave nothing for it to act on. */
function settleStub(shownIn: SessionStub) {
  shownIn.isProcessing = false
  shownIn.stopRequested = false
}

describe('F1.911 — the interrupted event names what the host still holds', () => {
  test('a Stop keeps the between-turn card answerable: the event carries its id', async () => {
    const shownIn = sessionStub('f1911-stop-composer', { isProcessing: false })
    const manager = harness(shownIn)
    const rig = watchTurnEnds(manager)
    const wait = manager.requestDirectShellPermission(shownIn, 'ls -la')
    try {
      await new Promise(resolve => { setTimeout(resolve, 20) })
      expect(manager.awaitingApprovalCount(shownIn)).toBe(1)
      expect(rig.raised).toHaveLength(1)
      const requestId = rig.raised[0]!
      // A turn starts while the card is up, and the person stops it.
      shownIn.isProcessing = true
      await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
      expect(rig.interrupted).toHaveLength(1)
      expect(rig.interrupted[0]!.retainedPermissionRequestIds).toEqual([requestId])
      // The card is untouched by the Stop — the host still holds it, and now says so.
      expect(manager.awaitingApprovalCount(shownIn)).toBe(1)
      expect(await Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])).toBe('STILL WAITING')
      manager.respondToPermission(shownIn.id, requestId, true, false, undefined, shownIn.workspace.id)
      expect(await wait).toBe(true)
    } finally {
      settleStub(shownIn)
    }
  })

  test('a Stop that leaves nothing held omits the field', async () => {
    const shownIn = sessionStub('f1911-stop-empty')
    const manager = harness(shownIn)
    const rig = watchTurnEnds(manager)
    try {
      await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
      expect(rig.interrupted).toHaveLength(1)
      expect(rig.interrupted[0]!.retainedPermissionRequestIds).toBeUndefined()
    } finally {
      settleStub(shownIn)
    }
  })
})

describe('F1.911 — the clear withdraws every record it drops', () => {
  test('an agent-raised record with no direct resolver is withdrawn, not dropped silently', () => {
    const shownIn = sessionStub('f1911-clear-agent-raised')
    const manager = harness(shownIn)
    const rig = watchTurnEnds(manager)
    // The shape `handleAgentPermissionRequest` registers: a live record, no
    // `directPermissionResolvers` entry — the resolver lives in the agent.
    manager.pendingPermissionRequests.set('req-agent-raised', {
      workspaceId: shownIn.workspace.id,
      sessionId: shownIn.id,
      requestId: 'req-agent-raised',
      toolName: 'bash',
      type: 'bash',
    })
    expect(manager.awaitingApprovalCount(shownIn)).toBe(1)
    manager.clearPendingPermissionRequestsForSession(shownIn.id, shownIn.workspace.id)
    expect(rig.withdrawn).toEqual(['req-agent-raised'])
    expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
  })

  test('CONTROL: a host-raised card is still withdrawn exactly once', () => {
    const shownIn = sessionStub('f1911-clear-host-raised')
    const manager = harness(shownIn)
    const rig = watchTurnEnds(manager)
    // Host-raised shape: a live record AND a direct resolver (F1.186's release
    // pair), as `requestDirectShellPermission` leaves them.
    manager.pendingPermissionRequests.set('req-host-raised', {
      workspaceId: shownIn.workspace.id,
      sessionId: shownIn.id,
      requestId: 'req-host-raised',
      toolName: 'run_shell_command',
      type: 'bash',
    })
    manager.directPermissionResolvers.set('req-host-raised', {
      sessionId: shownIn.id,
      resolve: () => undefined,
    })
    manager.clearPendingPermissionRequestsForSession(shownIn.id, shownIn.workspace.id)
    expect(rig.withdrawn).toEqual(['req-host-raised'])
    expect(manager.directPermissionResolvers.has('req-host-raised')).toBe(false)
  })

  test('the delete path withdraws too: a caller that has already dropped the map entry hands the clear its still-live reference', () => {
    const shownIn = sessionStub('f1911-delete-agent-raised')
    const manager = harness(shownIn)
    const rig = watchTurnEnds(manager)
    // The waiter-less agent-raised shape again — a live record, no
    // `directPermissionResolvers` entry (e.g. R7's re-shown durable card after
    // a restart, or any between-turn agent-raised record). A non-Pi drain
    // withdraws only a PROCESSING turn's runtime cards, so this record rides
    // past the drain into `deleteSession`, which removes the sessions-map entry
    // BEFORE its clear — the clear's own `getManaged` answers undefined there,
    // and the withdrawal can fire only on the reference the caller still holds.
    manager.pendingPermissionRequests.set('req-delete-agent-raised', {
      workspaceId: shownIn.workspace.id,
      sessionId: shownIn.id,
      requestId: 'req-delete-agent-raised',
      toolName: 'bash',
      type: 'bash',
    })
    manager.sessions.delete(encodeSessionKey({ workspaceId: shownIn.workspace.id, sessionId: shownIn.id }))
    manager.clearPendingPermissionRequestsForSession(shownIn.id, shownIn.workspace.id, shownIn)
    expect(rig.withdrawn).toEqual(['req-delete-agent-raised'])
    expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
  })

  test('WIRING: deleteSession passes the clear its still-live managed reference', () => {
    // Source-matched rather than driven for the reason the wiring tests above
    // (`agent-description-budget-wiring.test.ts`) spell out: the call sits
    // inside a 30 000-line class behind a full storage-delete pipeline, and the
    // proposition is which ARGUMENT the call carries. The three other callers
    // (a Pi drain, a runtime switch, a rewind) run while the session is still
    // in the map and stay two-argument; the delete caller — after the map
    // delete — is the one that must hand the reference over.
    const source = readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/this\.clearPendingPermissionRequestsForSession\(sessionId, managed\.workspace\.id, managed\)/)
  })
})
