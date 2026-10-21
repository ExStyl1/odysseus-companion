/**
 * D1.346 `[host]` `[safety]` — a command hook's permission card is COUNTED
 * while it waits, by the producer every other card is counted by.
 *
 * `Session.awaitingApprovalCount` is derived at read time from
 * `pendingPermissionRequests` and from nothing else, and
 * `pluginCommandHookRunner` raised its card by registering a resolver and
 * sending `permission_request` without ever writing that record. Measured on
 * the packaged 1.40.0 by SIT-5f (RS-86's rig): the card on screen with its
 * Allow once button clickable, all four sessions reading
 * `awaitingApprovalCount: 0`, so the harness's `approvePermissionsWhile` never
 * clicked and the turn sat for 180 s and again for 300 s; clicked by hand at
 * the same moment, the hook ran within seconds.
 *
 * The instrument is the production producer read AT THE MOMENT THE CARD IS
 * PUBLISHED — inside the very `sendEvent` that publishes it — which is the
 * reading the sitting took, rather than a flag beside it. The REAL runner runs
 * throughout: the real `PermissionManager`, the real gate verdict, the real
 * `createPiPermissionService`, the real spawn, and the real
 * `respondToPermission` entry point the desktop's click and the harness's
 * approver both arrive through.
 *
 * The CONTROL is an ordinary host Bash card raised through
 * `requestPiToolApproval` on the same manager, the same session and the same
 * instrument. It read 1 before this row and reads 1 after it: that is what
 * makes the hook arm's zero a fact about the hook card rather than about the
 * way this file reads the count.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './__tests__/test-session-manager.ts'

type SentEvent = { type: string; request?: { requestId?: string } }

type Rig = {
  manager: any
  managed: ReturnType<typeof managedSession>
  sent: SentEvent[]
  /** The count read inside the publish of each `permission_request`. */
  counts: number[]
  /** Set by a case that answers its card; absent means nothing answers. */
  onCard?: (requestId: string) => void
}

function managedSession(root: string) {
  return {
    id: 'session-d1346',
    // `resolveManagedProvider` answers off this field alone, so the settlement's
    // own invalidation never reads a workspace config file.
    activeProvider: 'pi' as const,
    provider: 'pi',
    permissionMode: 'auto',
    // A hook card is raised DURING a turn, and saying so also keeps the
    // settlement's invalidation from scheduling a goal continuation for a
    // service this harness has none of.
    isProcessing: true,
    // The session is REGISTERED here (the answer arrives through the public
    // entry point, which resolves by composite identity), so the supervisor's
    // own `onChanged` now finds it and reconciles its background shells — a
    // path the unregistered harnesses beside this file never reach.
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: 'workspaced1346', rootPath: root },
    workingDirectory: root,
    // F1.142 — a real ManagedSession always carries its transcript; the D1.343 disclosure is a row there now.
    messages: [] as unknown[],
  }
}

function harness(root: string): Rig {
  const manager = createTestSessionManager() as any
  const managed = managedSession(root)
  // Registered as a live session because the answer arrives through the public
  // `respondToPermission`, which resolves the session by composite identity.
  manager.sessions.set(
    encodeSessionKey({ workspaceId: managed.workspace.id, sessionId: managed.id }),
    managed,
  )
  manager.appendPiExecutionReceipt = () => undefined
  manager.piGoalReceiptReference = () => undefined
  manager.emitPiTelemetry = () => undefined
  manager.persistSession = () => undefined
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  const rig: Rig = { manager, managed, sent: [], counts: [] }
  manager.sendEvent = (event: SentEvent) => {
    rig.sent.push(event)
    if (event.type !== 'permission_request') return
    rig.counts.push(manager.awaitingApprovalCount(managed))
    const requestId = event.request?.requestId
    const answer = rig.onCard
    // The click arrives on a LATER tick, as a person's or the harness's does.
    if (typeof requestId === 'string' && answer) setTimeout(() => answer(requestId), 0)
  }
  return rig
}

const capabilityRuntime = {
  projectTrustState: 'trusted',
  view: { generation: 'gen-d1346', hooks: [], permissionLayers: [] },
  materializer: { assertActive() {}, async readText() { return '' } },
}

const hookOptions = {
  event: 'UserPromptSubmit' as const,
  input: { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
}

describe('D1.346 — a command hook card is counted while it waits', () => {
  test('counted on screen, released on the answer, and the hook then runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1346-answered-'))
    const rig = harness(root)
    const delivered: boolean[] = []
    rig.onCard = requestId => {
      delivered.push(rig.manager.respondToPermission(
        rig.managed.id,
        requestId,
        true,
        false,
        undefined,
        rig.managed.workspace.id,
      ))
    }
    const capture = join(root, 'capture.jsonl')

    // `cat >> <path>` is the rung D1.333 measured: one redirect away from an
    // allowed `cat`, and `plugin` is the tier D1.343 leaves asking.
    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )

    // The reading the sitting took, and the whole row: one card, counted.
    expect(rig.counts).toEqual([1])
    // The answer was DELIVERED, not swallowed: with the record present the click
    // takes `respondToPermission`'s long path instead of its early return.
    expect(delivered).toEqual([true])
    expect(result.success).toBe(true)
    expect(existsSync(capture)).toBe(true)
    // Released — a count that survived its card would badge the session for ever.
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('the ordinary Bash card reads 1 on the same instrument — the control', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1346-control-'))
    const rig = harness(root)
    rig.onCard = requestId => {
      rig.manager.respondToPermission(
        rig.managed.id,
        requestId,
        false,
        false,
        undefined,
        rig.managed.workspace.id,
      )
    }

    const answer = await rig.manager.requestPiToolApproval(rig.managed, {
      decisionId: 'd1346-control-request',
      toolName: 'Bash',
      type: 'bash',
      description: 'Run a command',
      command: 'echo control',
    })

    expect(rig.counts).toEqual([1])
    expect(answer.allowed).toBe(false)
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('nothing answers: counted while it waits, released at the hook budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1346-unanswered-'))
    // No `onCard`, so nothing ever clicks — the state D1.333 bounds.
    const rig = harness(root)
    const capture = join(root, 'capture.jsonl')

    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 300 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )

    expect(rig.counts).toEqual([1])
    expect(result.success).toBe(false)
    expect(result.error ?? '').toContain('needed your approval')
    expect(existsSync(capture)).toBe(false)
    // The deadline path releases it too. Without this the bounded wait would
    // leave a session permanently reporting an approval nobody can answer,
    // which is the same defect the other way round.
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('an Always answer mints no permanent repository rule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1346-always-'))
    const rig = harness(root)
    const persisted: unknown[][] = []
    rig.manager.persistBashAlwaysAllowRule = (...args: unknown[]) => { persisted.push(args) }
    rig.onCard = requestId => {
      rig.manager.respondToPermission(
        rig.managed.id,
        requestId,
        true,
        true,
        undefined,
        rig.managed.workspace.id,
      )
    }
    const capture = join(root, 'capture.jsonl')

    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'plugin' },
    )

    expect(rig.counts).toEqual([1])
    expect(result.success).toBe(true)
    // The record carries no `command`, so the widest grant class this file could
    // have acquired by accident stays exactly where it was: an Always on a hook
    // card is an allow, and nothing is written for later sessions.
    expect(persisted).toEqual([])
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)

  test('a pre-authorized hook raises no card and moves no count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1346-preauthorized-'))
    const rig = harness(root)
    const capture = join(root, 'capture.jsonl')

    // D1.343's user tier: the same command, admitted without a card. The
    // negative direction of this row — the count must follow the CARD, not the
    // hook.
    const result = await rig.manager.pluginCommandHookRunner(rig.managed, capabilityRuntime)(
      { type: 'command', command: `cat >> ${capture}`, timeoutMs: 20_000 },
      { ...hookOptions, cwd: root, hookSource: 'user' },
    )

    expect(result.success).toBe(true)
    expect(existsSync(capture)).toBe(true)
    expect(rig.sent.filter(event => event.type === 'permission_request')).toEqual([])
    expect(rig.counts).toEqual([])
    expect(rig.manager.awaitingApprovalCount(rig.managed)).toBe(0)
  }, 60_000)
})
