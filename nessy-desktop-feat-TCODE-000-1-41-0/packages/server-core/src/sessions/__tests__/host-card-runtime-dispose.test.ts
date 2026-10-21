/**
 * F1.403 (origin: the WJ-ff verifier on F1.263) — tearing a session's agent
 * runtime down declines the turn-bound host cards that runtime raised.
 *
 * ## What was read, and what this file measures first
 *
 * F1.263's residue said "no card can wait at a model-call 401": the auth-retry
 * route disposes the runtime and starts a new one without a turn end. That holds
 * for a card the foreground turn raised — the turn waits on it, so no model call
 * is in flight — and fails for a card a claude background subagent raised, which
 * does not block the parent's model call. `disposeManagedAgentRuntime` (the
 * non-Pi auth-retry route, and every other teardown that keeps or drops the
 * session: the reaper, the ceiling, a runtime refresh) resolved no
 * `directPermissionResolvers` entry, so a card whose raiser died with the killed
 * runtime stayed up, counted and answerable. The DEFECT arm drives the real
 * method over a real Monitor card and reads the count and the wait.
 *
 * ## CONTROLS
 *
 * The cross-session dialog shown in the same session is not the runtime's card
 * and survives the same call; another session's card is untouched.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  isProcessing: boolean
  processingGeneration: number
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'claude',
    permissionMode: 'default',
    // The parent turn has ended; a background subagent of it is still running.
    isProcessing: false,
    processingGeneration: 2,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: 'workspace-f1403', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    ...extra,
  }
}

function harness(...sessions: SessionStub[]) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  for (const session of sessions) {
    manager.sessions.set(encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }), session)
  }
  const rig = { raised: [] as string[], withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') { rig.withdrawn.push(event.requestId); return }
    if (event?.type === 'permission_request') rig.raised.push(event.request?.requestId as string)
  }
  return { manager, rig }
}

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
const state = (wait: Promise<unknown>) => Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])

function raiseWs(manager: any, session: SessionStub): Promise<unknown> {
  manager.resolveMonitorTargetHost = async () => 'example.test'
  manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
  return manager.authorizeMonitor({
    sessionKey: { workspaceId: session.workspace.id, sessionId: session.id },
    ws: { url: 'wss://example.test/feed' },
  }).then(() => 'allowed', (error: Error) => error.message)
}

/** Every teardown step past the release is out of scope here; a throw from one is not this row's reading. */
async function dispose(manager: any, session: SessionStub, reason: string): Promise<void> {
  await manager.disposeManagedAgentRuntime(session, reason, true).catch(() => undefined)
}

describe('F1.403 — a runtime teardown declines the cards that runtime raised', () => {
  for (const reason of ['auth retry', 'idle-agent reaper', 'runtime config refresh']) {
    test(`disposeManagedAgentRuntime(…, '${reason}') → the Monitor card leaves the screen and the count, and the wait settles`, async () => {
      const session = sessionStub(`dispose-${reason.replace(/\W+/g, '-')}`)
      const { manager, rig } = harness(session)
      const wait = raiseWs(manager, session)
      await tick(20)
      expect(rig.raised).toHaveLength(1)
      const requestId = rig.raised[0]!
      expect(manager.awaitingApprovalCount(session)).toBe(1)

      await dispose(manager, session, reason)

      expect({
        count: manager.awaitingApprovalCount(session),
        resolverLeft: manager.directPermissionResolvers.has(requestId),
        withdrawn: rig.withdrawn,
        after: await state(wait),
      }).toEqual({
        count: 0,
        resolverLeft: false,
        withdrawn: [requestId],
        after: 'Monitor ws connection to wss://example.test/feed was cancelled because the session\'s agent runtime was shut down.',
      })
    })
  }
})

describe('F1.403 — CONTROLS: a teardown leaves the cards that are not the runtime\'s', () => {
  test('the cross-session dialog shown in the same session survives the teardown', async () => {
    const sender = sessionStub('dispose-xsession-sender')
    const target = sessionStub('dispose-xsession-target')
    const { manager, rig } = harness(sender, target)
    try {
      manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1403-xsession')
      expect(rig.raised).toEqual(['f1403-xsession'])
      await dispose(manager, target, 'auth retry')
      expect(rig.withdrawn).toEqual([])
      expect(manager.awaitingApprovalCount(target)).toBe(1)
      expect(manager.directPermissionResolvers.has('f1403-xsession')).toBe(true)
    } finally {
      manager.cancelCrossSessionApprovalDialog(target, 'f1403-xsession')
    }
  })

  test('another session\'s Monitor card is untouched by this session\'s teardown', async () => {
    const other = sessionStub('dispose-other')
    const disposed = sessionStub('dispose-this')
    const { manager, rig } = harness(other, disposed)
    const wait = raiseWs(manager, other)
    await tick(20)
    const requestId = rig.raised[0]!
    await dispose(manager, disposed, 'auth retry')
    expect(rig.withdrawn).toEqual([])
    expect(await state(wait)).toBe('STILL WAITING')
    manager.respondToPermission(other.id, requestId, true, false, undefined, other.workspace.id)
    expect(await wait).toBe('allowed')
  })
})
