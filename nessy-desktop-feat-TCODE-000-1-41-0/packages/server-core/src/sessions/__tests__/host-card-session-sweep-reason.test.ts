/**
 * F1.404 (origin: the WJ-ff verifier on F1.264) — the session-wide sweep that
 * declines a turn-bound host card says it was CANCELLED, not "denied".
 *
 * ## What was measured first
 *
 * `clearPendingPermissionRequestsForSession` — called by the Pi strict drain
 * (auth retry, a project mutation, trust blocked, a root revoked), a runtime
 * switch, a rewind and a delete — resolved the four turn-bound cards (Monitor ws
 * and command, EnterWorktree, archive_session) `false` and recorded no reason,
 * so the raise site settled "… was denied." for a card nobody denied. The
 * verifier's probe arm A read exactly that; the DEFECT arm below is the same
 * reading through the sweep alone.
 *
 * ## What reaches it, and why the sweep records the reason anyway
 *
 * Read from source: every one of the four callers runs `disposeManagedAgentRuntime`
 * on the same session first (the Pi strict drain, and `strictDrainSessionForMutation`
 * for the runtime switch, the rewind and the delete), and since F1.403 that
 * teardown declines every turn-bound card with "was cancelled because the
 * session's agent runtime was shut down" — so on those paths the sweep finds no
 * such card left, and whether its text would have reached a persisted transcript
 * (only through the runtime that is being torn down) stops mattering. The
 * sweep records the same reason for any turn-bound card still in the map when it
 * runs (one raised during the drain's own awaits), so no path settles "denied".
 * The drain arm pins the ordering on the non-Pi route.
 *
 * ## CONTROLS
 *
 * A person's denial still reads the site's own "was denied"; the cross-session
 * dialog is still settled by the sweep and records no reason.
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
    isProcessing: true,
    processingGeneration: 4,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: 'workspace-f1404', rootPath: process.cwd() },
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

const CANCELLED = 'Monitor ws connection to wss://example.test/feed was cancelled because the session\'s agent runtime was shut down.'

describe('F1.404 — the session-wide sweep settles a turn-bound card as cancelled, not denied', () => {
  test('THE DEFECT — clearPendingPermissionRequestsForSession alone (probe arm A)', async () => {
    const session = sessionStub('sweep-alone')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session)
    await tick(20)
    expect(rig.raised).toHaveLength(1)
    manager.clearPendingPermissionRequestsForSession(session.id, session.workspace.id)
    expect({ after: await state(wait), resolvers: [...manager.directPermissionResolvers.keys()] })
      .toEqual({ after: CANCELLED, resolvers: [] })
    session.isProcessing = false
  })

  test('a non-Pi drain that keeps the session (runtime switch route) — its teardown names the reason before the sweep runs', async () => {
    const session = sessionStub('sweep-drain')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session)
    await tick(20)
    expect(rig.raised).toHaveLength(1)
    // Every step past the teardown's decline is out of scope here; a throw from one is not this row's reading.
    await manager.strictDrainSessionForMutation(session, 'runtime switch (connection-cross-runtime)', true).catch(() => undefined)
    manager.clearPendingPermissionRequestsForSession(session.id, session.workspace.id)
    expect({ after: await state(wait), withdrawn: rig.withdrawn }).toEqual({ after: CANCELLED, withdrawn: rig.raised.slice(0, 1) })
    session.isProcessing = false
  })
})

describe('F1.404 — CONTROLS', () => {
  test('a person\'s denial still reads the site\'s own words', async () => {
    const session = sessionStub('sweep-person-denies')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session)
    await tick(20)
    manager.respondToPermission(session.id, rig.raised[0]!, false, false, undefined, session.workspace.id)
    expect(await wait).toBe('Monitor ws connection to wss://example.test/feed was denied.')
    session.isProcessing = false
  })

  test('the cross-session dialog is still settled by the sweep, and no reason is recorded for it', async () => {
    const sender = sessionStub('sweep-xsession-sender')
    const target = sessionStub('sweep-xsession-target')
    const { manager, rig } = harness(sender, target)
    manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1404-xsession')
    expect(rig.raised).toEqual(['f1404-xsession'])
    manager.clearPendingPermissionRequestsForSession(target.id, target.workspace.id)
    expect({
      resolverLeft: manager.directPermissionResolvers.has('f1404-xsession'),
      reasonRecorded: manager.hostCardCancellations.has('f1404-xsession'),
    }).toEqual({ resolverLeft: false, reasonRecorded: false })
  })
})
