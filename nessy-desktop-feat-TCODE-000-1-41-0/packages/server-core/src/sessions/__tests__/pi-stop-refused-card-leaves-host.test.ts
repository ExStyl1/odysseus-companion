/**
 * F1.910 (origin WJ-crit-bbb P-2, 2026-09-25) — a Pi tool-approval card whose turn is STOPPED leaves the host.
 * The Pi twin of F1.954 (claude, `claude-stop-refused-card-leaves-host.test.ts`).
 *
 * ## What was measured here, before the fix
 *
 * Pi `default`, a `Bash` card raised through the production seam (`createPiPermissionService`'s `requestApproval`
 * → `SessionManager.requestPiToolApproval`, the line `getOrCreateAgentUnchecked` wires), then a Stop through the
 * host's own `cancelProcessing`: `awaitingApprovalCount` stayed 1, `pendingApproval` stayed persisted, no
 * `permission_request_cancelled` was sent and the permission service's wait never settled. The renderer clears the
 * session's cards at a Stop (F1.900 keeps that on purpose), so the user saw no card while the badge said one was
 * waiting — and after a restart `reprojectPendingApproval` would re-show the stopped command as a live card whose
 * Allow re-drives the turn (R7), the path F1.954 closed on claude.
 *
 * ## The cause, read from the source
 *
 * `requestPiToolApproval` registered its `directPermissionResolvers` entry with the session id and the resolver
 * alone — no `releaseOnStop`, no raising turn — so `releaseTurnBoundHostCards` never saw it, and
 * `pi-harness/permission-service.ts` has no abort path. `PiAgent.forceAbort` settles the waiters IT holds
 * (`pendingPermissions`: `ask_user`, `outside_root`), not the host's.
 *
 * ## What this file pins (a REAL SessionManager, the REAL permission service, the REAL `cancelProcessing`)
 *
 * (1) The Stop withdraws the card THE STOPPED TURN's tool call raised: no record, count 0, no persisted
 *     `pendingApproval`, the renderer told `permission_request_cancelled`, and the service's wait settles DENY (fail
 *     closed — nothing runs) with a reason that says the turn was stopped. A redirect (the silent Stop) does the same.
 * CONTROLS (boundary): a Pi tool card raised while no turn ran, and a host consent card on the same seam that is not
 * a tool call's (no permission-service `subject` — the worktree-setup / cleanup / reopen-compact shape), both
 * survive the Stop and stay counted, and an Allow still reaches the service as allow; a card of the
 * running turn survives an ORDINARY turn end (F1.900's arm: only a Stop withdraws it).
 *
 * SAFETY: no real home directory, no credential; nothing is executed.
 */
import { describe, expect, test } from 'bun:test'
import {
  type PiPermissionAuthorizationRequest,
  type PiPermissionReceiptV1,
} from '@nessy-agent/shared/agent/pi-harness/permission-receipt'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createPiPermissionService } from '../../pi-harness/permission-service.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const COMMAND = 'rm -rf ./scratch-dir3'
let counter = 0

type Stub = {
  id: string
  workspace: { id: string; rootPath: string }
  isProcessing: boolean
  processingGeneration: number
  pendingApproval?: { requestId: string; command?: string }
  agent: { forceAbort(reason: unknown): void }
  [key: string]: unknown
}

function rig() {
  counter += 1
  const aborts: unknown[] = []
  const managed: Stub = {
    id: `session-f1-910-${counter}`,
    activeProvider: 'pi',
    permissionMode: 'default',
    isProcessing: true,
    processingGeneration: 3,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: `ws-f1-910-${counter}`, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    agent: { forceAbort: reason => { aborts.push(reason) } },
  }
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.sessions.set(encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }), managed)
  const withdrawn: string[] = []
  const raised: string[] = []
  manager.sendEvent = (event: { type?: string; requestId?: string; request?: { requestId?: string } }) => {
    if (event?.type === 'permission_request_cancelled' && event.requestId) withdrawn.push(event.requestId)
    if (event?.type === 'permission_request' && event.request?.requestId) raised.push(event.request.requestId)
  }
  // Production's line in `getOrCreateAgentUnchecked`, verbatim in shape.
  const service = createPiPermissionService({
    createDecisionId: () => `pi-permission-f1-910-${counter}-${raised.length + 1}`,
    requestApproval: request => manager.requestPiToolApproval(managed, request),
  })
  const count = (): number => manager.awaitingApprovalCount(managed)
  return { manager, managed, service, withdrawn, raised, aborts, count }
}

function bashAsk(managed: Stub, command = COMMAND): PiPermissionAuthorizationRequest {
  return {
    subject: {
      sessionKey: { workspaceId: managed.workspace.id, sessionId: managed.id },
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'bash',
      bindingName: 'bash',
      semanticId: 'bash',
      descriptorId: 'bash',
      manifestGeneration: 'generation-f1-910',
      manifestHash: 'hash-f1-910',
      manifestProvenance: [],
      responseEpoch: 1,
      contextProfile: 'bare',
      sandboxRequirement: 'workspace',
    },
    canonicalInput: { command },
    decision: {
      outcome: 'ask',
      reason: 'Bash requires approval',
      request: { toolName: 'Bash', type: 'bash', description: `Execute: ${command}`, command },
    },
    canonicalizeApprovedInput: input => ({ ...input }),
  } as PiPermissionAuthorizationRequest
}

/** Settled within a few ticks, or still waiting on the person. */
async function state<T>(wait: Promise<T>): Promise<T | 'STILL WAITING'> {
  return Promise.race([wait, new Promise<'STILL WAITING'>(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])
}

describe('F1.910 — a Pi tool card the Stop refused leaves the host', () => {
  for (const silent of [false, true]) {
    test(`${silent ? 'a redirect (silent Stop)' : 'a Stop'} withdraws the stopped turn's Pi tool card: count 0, no pendingApproval, renderer told, the wait settles deny`, async () => {
      const { manager, managed, service, withdrawn, raised, aborts, count } = rig()
      const receipt = service.authorize(bashAsk(managed))
      await Promise.resolve()
      expect(raised).toHaveLength(1)
      const requestId = raised[0]!
      expect(count()).toBe(1)
      expect(managed.pendingApproval?.requestId).toBe(requestId)

      await manager.cancelProcessing(managed.id, silent, managed.workspace.id)

      expect(aborts).toHaveLength(1)
      expect(count()).toBe(0)
      expect(manager.pendingPermissionRequests.has(requestId)).toBe(false)
      expect(managed.pendingApproval).toBeUndefined()
      expect(withdrawn).toEqual([requestId])
      expect(manager.directPermissionResolvers.has(requestId)).toBe(false)
      const settled = await state(receipt)
      expect(settled).not.toBe('STILL WAITING')
      const settledReceipt = settled as PiPermissionReceiptV1
      expect(settledReceipt.outcome).toBe('deny')
      expect(settledReceipt.reason).toContain('turn was stopped')
    })
  }

  test('CONTROL — a Pi tool card raised while no turn ran, and a host consent card that is not a tool call\'s, survive the Stop and stay answerable', async () => {
    const { manager, managed, service, withdrawn, raised, count } = rig()
    managed.isProcessing = false
    const betweenTurns = service.authorize(bashAsk(managed, 'echo between-turns'))
    await Promise.resolve()
    managed.isProcessing = true
    managed.processingGeneration = 4
    // The worktree-setup / cleanup / reopen-compact shape: the same seam, no permission-service subject.
    const consent = manager.requestPiToolApproval(managed, {
      decisionId: `worktree-setup-f1-910-${counter}`,
      toolName: 'WorktreeSetup',
      type: 'worktree_setup',
      description: 'Run the worktree setup script?',
      noAlwaysAllow: true,
    }) as Promise<{ allowed: boolean }>
    expect(raised).toHaveLength(2)
    expect(count()).toBe(2)

    await manager.cancelProcessing(managed.id, false, managed.workspace.id)

    expect(withdrawn).toEqual([])
    expect(count()).toBe(2)
    expect(await state(betweenTurns)).toBe('STILL WAITING')
    expect(await state(consent)).toBe('STILL WAITING')
    expect(manager.respondToPermission(managed.id, raised[0]!, true, false, undefined, managed.workspace.id)).not.toBe(false)
    expect((await betweenTurns).outcome).toBe('allow')
    manager.respondToPermission(managed.id, raised[1]!, true, false, undefined, managed.workspace.id)
    expect((await consent).allowed).toBe(true)
    expect(count()).toBe(0)
  })

  test('CONTROL (F1.900) — an ordinary turn end leaves the running turn\'s Pi tool card counted, persisted and answerable', async () => {
    const { manager, managed, service, withdrawn, raised, count } = rig()
    const receipt = service.authorize(bashAsk(managed))
    await Promise.resolve()
    const requestId = raised[0]!

    await manager.onProcessingStopped(managed.id, 'complete', managed.workspace.id)

    expect(withdrawn).toEqual([])
    expect(count()).toBe(1)
    expect(managed.pendingApproval?.requestId).toBe(requestId)
    expect(await state(receipt)).toBe('STILL WAITING')
    manager.respondToPermission(managed.id, requestId, true, false, undefined, managed.workspace.id)
    expect((await receipt).outcome).toBe('allow')
  })
})

/**
 * F1.1105 (origin DN-066) — a Pi turn that ends in an ERROR (a subprocess crash, `onProcessingStopped('error')`) took
 * the card its tool call raised nowhere: still counted and persisted, and an Allow then reached a turn nobody runs (it
 * failed closed — PiAgent's continuation check blocks the call — but the card lied). DECIDED: an error ending
 * withdraws the raising turn's Pi tool cards as a Stop does (F1.910); an ordinary turn end keeps them (F1.900, the
 * control above).
 */
describe('F1.1105 — an error-ended Pi turn withdraws its tool card', () => {
  test('error: count 0, no pendingApproval, renderer told, the wait settles deny with a reason naming the failed turn', async () => {
    const { manager, managed, service, withdrawn, raised, count } = rig()
    const receipt = service.authorize(bashAsk(managed))
    await Promise.resolve()
    const requestId = raised[0]!
    expect(count()).toBe(1)

    await manager.onProcessingStopped(managed.id, 'error', managed.workspace.id)

    expect(count()).toBe(0)
    expect(managed.pendingApproval).toBeUndefined()
    expect(withdrawn).toEqual([requestId])
    const settled = await state(receipt)
    expect(settled).not.toBe('STILL WAITING')
    expect((settled as PiPermissionReceiptV1).outcome).toBe('deny')
    expect((settled as PiPermissionReceiptV1).reason).toContain('turn ended with an error')
  })

  test('CONTROL — a card raised while no turn ran survives an error ending', async () => {
    const { manager, managed, service, withdrawn, count } = rig()
    managed.isProcessing = false
    const betweenTurns = service.authorize(bashAsk(managed, 'echo between-turns'))
    await Promise.resolve()
    managed.isProcessing = true
    managed.processingGeneration = 4

    await manager.onProcessingStopped(managed.id, 'error', managed.workspace.id)

    expect(withdrawn).toEqual([])
    expect(count()).toBe(1)
    expect(await state(betweenTurns)).toBe('STILL WAITING')
  })
})
