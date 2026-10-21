/**
 * F1.405 (origin: the WJ-ff verifier on F1.264) — the reason a turn-bound card
 * was CANCELLED is keyed per request, and the arms can tell.
 *
 * F1.264 put the reason beside the boolean: `releaseTurnBoundHostCards` writes
 * `hostCardCancellations.set(requestId, …)` right before it resolves the card
 * `false`, and the raise site reads it once through `hostCardRefusal(requestId)`.
 * Its twelve arms in `host-card-user-stop.test.ts` each raise ONE card in ONE
 * manager, so a single shared field in place of the per-request map passes all
 * of them — and their map-empty check (`hostCardCancellations?.size ?? 0`) passes
 * without checking anything if the field is renamed.
 *
 * These arms put TWO cards in one manager: one turn's card cancelled by a Stop
 * while a person denies another session's card (both orders), and two cards of
 * one turn cancelled by one Stop. Each asserts the field itself — no `?.`, no
 * `?? 0` — so a rename is a red, not a pass.
 *
 * The rig is `host-card-user-stop.test.ts`'s: the real raise sites
 * (`authorizeMonitor` ws, `authorizeMonitorCommand`), the real `cancelProcessing`
 * and `respondToPermission`, `sendEvent` as the instrument.
 *
 * CONTROL — the mutant that keys every write and read to ONE shared slot fails
 * the deny-then-Stop arm (measured on a copy, `work/wjssb/`, not in the tree).
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

type SessionStub = { id: string; workspace: { id: string; rootPath: string }; isProcessing: boolean; [key: string]: unknown }

function sessionStub(id: string, workspaceId = `workspace-${id}`): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'pi',
    permissionMode: 'default',
    // A model turn is running: each card below was raised by one of its tool calls.
    isProcessing: true,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: workspaceId, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
  }
}

function harness(...sessions: SessionStub[]) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.resolveMonitorTargetHost = async () => 'example.test'
  manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
  manager.monitorGateSessionIsPi = () => false
  manager.evaluateMonitorCommandRules = () => undefined
  for (const session of sessions) {
    manager.sessions.set(encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }), session)
  }
  const raised: string[] = []
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request') raised.push(event.request?.requestId as string)
  }
  return { manager, raised }
}

const raiseWs = (manager: any, session: SessionStub) => manager.authorizeMonitor({
  sessionKey: { workspaceId: session.workspace.id, sessionId: session.id },
  ws: { url: 'wss://example.test/feed' },
}).then(() => 'allowed', (error: Error) => error.message)

const raiseCommand = (manager: any, session: SessionStub) => manager.authorizeMonitorCommand({
  sessionKey: { workspaceId: session.workspace.id, sessionId: session.id },
  command: 'tail -f build.log',
}).then(() => 'allowed', (error: Error) => error.message)

/** Settled within a few ticks, or still waiting on the person. */
async function state(wait: Promise<unknown>): Promise<unknown> {
  return Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])
}
/** Past the raise's own awaits (the ws target-host guard). */
const raiseSettles = () => new Promise<void>(resolve => { setTimeout(resolve, 20) })
/** The 5 s stop safety timer reads these two; leave nothing for it to act on. */
const settleStub = (session: SessionStub) => { session.isProcessing = false; session.stopRequested = false }

const WS_CANCELLED = 'Monitor ws connection to wss://example.test/feed was cancelled because the turn was stopped.'
const COMMAND_CANCELLED = 'Monitor command watch of tail -f build.log was cancelled because the turn was stopped.'
const COMMAND_DENIED = 'Monitor command watch of tail -f build.log was denied.'

describe('F1.405 — two cards in one manager: each settles with ITS OWN reason', () => {
  for (const order of ['Stop first, then the person denies', 'the person denies first, then Stop'] as const) {
    test(`S1 is Stopped while a person denies S2 (${order})`, async () => {
      const s1 = sessionStub('keyed-s1', 'workspace-keyed')
      const s2 = sessionStub('keyed-s2', 'workspace-keyed')
      const { manager, raised } = harness(s1, s2)
      const w1 = raiseWs(manager, s1)
      const w2 = raiseCommand(manager, s2)
      try {
        await raiseSettles()
        expect(raised).toHaveLength(2)
        const s2Card = raised.find(id => id.startsWith('monitor-command-'))!
        expect(s2Card).toBeDefined()
        const deny = () => manager.respondToPermission(s2.id, s2Card, false, false, undefined, s2.workspace.id)
        let stop: Promise<unknown>
        if (order === 'Stop first, then the person denies') {
          stop = manager.cancelProcessing(s1.id, false, s1.workspace.id)
          deny()
        } else {
          deny()
          stop = manager.cancelProcessing(s1.id, false, s1.workspace.id)
        }
        await stop
        expect(await state(w1)).toBe(WS_CANCELLED)
        expect(await state(w2)).toBe(COMMAND_DENIED)
        // The field itself, not `?.size ?? 0`: a renamed map is a red here.
        expect(manager.hostCardCancellations).toBeInstanceOf(Map)
        expect(manager.hostCardCancellations.size).toBe(0)
      } finally {
        settleStub(s1)
        settleStub(s2)
      }
    })
  }

  test('two turn-bound cards in ONE session, one Stop: both cancelled, the map empty after', async () => {
    const s = sessionStub('keyed-two')
    const { manager, raised } = harness(s)
    const w1 = raiseWs(manager, s)
    const w2 = raiseCommand(manager, s)
    try {
      await raiseSettles()
      expect(raised).toHaveLength(2)
      await manager.cancelProcessing(s.id, false, s.workspace.id)
      expect(await state(w1)).toBe(WS_CANCELLED)
      expect(await state(w2)).toBe(COMMAND_CANCELLED)
      expect(manager.hostCardCancellations).toBeInstanceOf(Map)
      expect(manager.hostCardCancellations.size).toBe(0)
    } finally {
      settleStub(s)
    }
  })
})
