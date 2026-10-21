/**
 * F1.97 (origin D1.411, the F1.12 review's finding #12) — a command hook's
 * permission card must LEAVE THE SCREEN on every terminal path, not only on the
 * one where the user clicked it.
 *
 * ## The defect
 *
 * D1.333 bounded the approval wait by the hook's own declared budget, and
 * D1.346 made the card counted while it waits. Both terminal paths funnel
 * through `releaseHookCard`, which calls `removePendingPermissionRequest` — and
 * that method deletes the in-memory record and clears the durable
 * `managed.pendingApproval` while sending NOTHING to the client. So after the
 * deadline (or an abort, or a failed publish) the card was still on screen with
 * a live-looking Allow that answered nothing: `respondToPermission` finds no
 * pending record, falls through to the direct resolver that is already gone, and
 * returns without settling anything. Fail-closed — the stale click mints no
 * grant, which is why the review scored it MEDIUM rather than a permission hole
 * — but the user is left holding a button for a hook that ended minutes ago.
 *
 * ## The fix, and the one path that deliberately stays silent
 *
 * `permission_request_cancelled` is the event the host already has for exactly
 * this, and `cancelCrossSessionApprovalDialog` is the shape: take the card off
 * the screen without settling the thing behind it. It is folded into
 * `releaseHookCard` so all four terminal paths (click, abort, send failure,
 * deadline) spell it in one call.
 *
 * The CLICK path emits nothing, and that is the fix rather than a gap in it:
 * `respondToPermission` removes the pending record BEFORE it resolves the direct
 * resolver, so by the time `releaseHookCard` runs the removal answers false —
 * the card was already answered, and the renderer cleared it on the answer. That
 * boolean is the whole discriminator between "the card was still live" and "the
 * user answered it", and case (b) below is what makes it a measurement.
 *
 * ## The rig
 *
 * The REAL `pluginCommandHookRunner` throughout — the real `PermissionManager`,
 * the real gate verdict, the real `createPiPermissionService`, the real spawn
 * and the real `respondToPermission` entry point the desktop's click and the
 * harness's approver both arrive through. `SessionManager.hook-card-counted.test.ts`
 * is this file's sibling and its rig; the instrument here is the EVENT STREAM
 * rather than the count.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type SentEvent = { type: string; sessionId?: string; requestId?: string; request?: { requestId?: string } }

function managedSession(root: string) {
  return {
    id: 'session-f197',
    activeProvider: 'pi' as const,
    provider: 'pi',
    permissionMode: 'auto',
    isProcessing: true,
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: 'workspacef197', rootPath: root },
    workingDirectory: root,
    // F1.142 — a real ManagedSession always carries its transcript; the D1.343 disclosure is a row there now.
    messages: [] as unknown[],
  }
}

function harness(root: string) {
  const manager = createTestSessionManager() as any
  const managed = managedSession(root)
  manager.sessions.set(
    encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }),
    managed,
  )
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistSession = () => undefined
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  const sent: SentEvent[] = []
  let onCard: ((requestId: string) => void) | undefined
  manager.sendEvent = (event: SentEvent) => {
    sent.push(event)
    if (event.type !== 'permission_request') return
    const requestId = event.request?.requestId
    // The click arrives on a LATER tick, as a person's or the harness's does.
    if (typeof requestId === 'string' && onCard) setTimeout(() => onCard!(requestId), 0)
  }
  return {
    manager,
    managed,
    sent,
    answerWith: (fn: (requestId: string) => void) => { onCard = fn },
    raised: () => sent.filter(event => event.type === 'permission_request'),
    withdrawn: () => sent.filter(event => event.type === 'permission_request_cancelled'),
  }
}

const capabilityRuntime = {
  projectTrustState: 'trusted',
  view: { generation: 'gen-f197', hooks: [], permissionLayers: [] },
  materializer: { assertActive() {}, async readText() { return '' } },
}

const hookOptions = {
  event: 'UserPromptSubmit' as const,
  input: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
}

/** `cat >> <path>` is D1.333's rung: one redirect away from an allowed `cat`. */
function askingHook(root: string) {
  return { type: 'command' as const, command: `cat >> ${join(root, 'capture.jsonl')}` }
}

describe('F1.97 — a hook card is withdrawn on every terminal path but the answer', () => {
  test('(a) nothing answers: the deadline withdraws the card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f197-deadline-'))
    const rig = harness(root)

    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { ...askingHook(root), timeoutMs: 300 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )

    expect(result.success).toBe(false)
    // The positive control for the whole file: a card really WAS raised, so a
    // zero below is about the withdrawal and never about a missing card.
    expect(rig.raised()).toHaveLength(1)
    const requestId = rig.raised()[0]?.request?.requestId
    expect(typeof requestId).toBe('string')

    expect(rig.withdrawn()).toEqual([
      { type: 'permission_request_cancelled', sessionId: rig.managed.id, requestId },
    ])
    // And the count the card was holding is released, as D1.346 requires.
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('(b) control — an ANSWERED card is not withdrawn: the click already cleared it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f197-answered-'))
    const rig = harness(root)
    const delivered: boolean[] = []
    rig.answerWith(requestId => {
      delivered.push(rig.manager.respondToPermission(
        rig.managed.id, requestId, true, false, undefined, rig.managed.workspace.id,
      ))
    })

    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { ...askingHook(root), timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )

    // The answer was DELIVERED, which is what makes the silence below a
    // decision rather than a card that never existed.
    expect(delivered).toEqual([true])
    expect(result.success).toBe(true)
    expect(rig.raised()).toHaveLength(1)
    expect(rig.withdrawn()).toEqual([])
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('(c) an ABORTED turn withdraws the card too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f197-abort-'))
    const rig = harness(root)
    const controller = new AbortController()
    rig.answerWith(() => controller.abort())

    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { ...askingHook(root), timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'plugin', signal: controller.signal },
    )

    expect(result.success).toBe(false)
    expect(rig.raised()).toHaveLength(1)
    expect(rig.withdrawn()).toHaveLength(1)
    expect(rig.withdrawn()[0]?.requestId).toBe(rig.raised()[0]?.request?.requestId)
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('(d) the negative direction — a pre-authorized hook raises no card, so nothing is withdrawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f197-preauthorized-'))
    const rig = harness(root)

    // D1.343's user tier: the same command, admitted without a card. A
    // withdrawal here would be a cancellation for a card nobody ever saw.
    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { ...askingHook(root), timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'user' },
    )

    expect(result.success).toBe(true)
    expect(rig.raised()).toEqual([])
    expect(rig.withdrawn()).toEqual([])
  }, 60_000)
})
