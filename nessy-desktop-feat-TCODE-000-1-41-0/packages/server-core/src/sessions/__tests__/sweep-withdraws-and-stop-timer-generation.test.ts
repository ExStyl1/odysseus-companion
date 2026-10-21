/**
 * F1.476 (origin WJ-ss-a P-WJ-ss-a-2 and P-WJ-ss-a-3, both LOW) — two turn-end
 * edges the host settled without keeping the screen or the NEXT turn honest.
 *
 * ## (1) The session-wide sweep withdraws the card it settles
 *
 * `clearPendingPermissionRequestsForSession` (the Pi strict drain, a runtime
 * switch, a rewind, a delete) deleted every pending record of the session FIRST
 * and only then resolved the direct resolvers `false`. A host-raised card's
 * release (F1.186, `countHostRaisedCard`) withdraws the card from the screen only
 * when it finds the record LIVE — and it runs after the raise site's `await`
 * resumes, by which time the sweep had deleted it. So the card was settled and
 * left drawn: WJ-ss-a measured `withdrawn: []` on F1.404's sweep arm. Since
 * F1.403 the runtime teardown that precedes every sweep withdraws such cards
 * itself, so only a card that reaches the map between the teardown and the sweep
 * stayed drawn — the sweep-alone arm below is that card.
 *
 * ## (2) A Stop's 5 s safety timer ends only the turn it was armed for
 *
 * `cancelProcessing` arms a timer that force-ends the turn when its generator is
 * still stuck 5 s after the Stop, gated on `stopRequested && isProcessing` alone.
 * A Stop of turn N whose drain finishes at once, then turn N+1 started and
 * stopped inside those 5 s, left N's timer to end N+1 before N+1's own generator
 * had its 5 s — F1.395's family, on the timer side. Read, not measured, when it
 * was proposed; the DEFECT arm below is the measurement.
 *
 * ## CONTROLS
 *
 * - The drain route (the teardown declines and withdraws first) still withdraws
 *   the card exactly once.
 * - The cross-session dialog is still settled by the sweep with no reason
 *   recorded (F1.404's control); it was left drawn by the same ordering, so
 *   its withdrawal is a second DEFECT arm, not a control.
 * - The second turn IS force-ended by its own timer, 5 s after its own Stop.
 */
import { afterEach, describe, expect, it, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The timer arm waits out two real 5 s stop safety timers.
setDefaultTimeout(30_000)

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

// ─── (1) the sweep ─────────────────────────────────────────────────────────────

type SessionStub = { id: string; workspace: { id: string; rootPath: string }; isProcessing: boolean; [key: string]: unknown }

function sessionStub(id: string): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'claude',
    permissionMode: 'default',
    isProcessing: true,
    processingGeneration: 4,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: 'workspace-f1476', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
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

const settled = (wait: Promise<unknown>) => Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])

function raiseWs(manager: any, session: SessionStub): Promise<unknown> {
  manager.resolveMonitorTargetHost = async () => 'example.test'
  manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
  return manager.authorizeMonitor({
    sessionKey: { workspaceId: session.workspace.id, sessionId: session.id },
    ws: { url: 'wss://example.test/feed' },
  }).then(() => 'allowed', (error: Error) => error.message)
}

const CANCELLED = 'Monitor ws connection to wss://example.test/feed was cancelled because the session\'s agent runtime was shut down.'

describe('F1.476 (1) — the session-wide sweep withdraws the host card it settles', () => {
  test('THE DEFECT — the sweep alone settles a live Monitor card AND withdraws it from the screen, once', async () => {
    const session = sessionStub('sweep-alone')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session)
    await tick(20)
    expect(rig.raised).toHaveLength(1)
    manager.clearPendingPermissionRequestsForSession(session.id, session.workspace.id)
    expect({ after: await settled(wait), withdrawn: rig.withdrawn, count: manager.pendingPermissionRequests.size })
      .toEqual({ after: CANCELLED, withdrawn: rig.raised.slice(0, 1), count: 0 })
    session.isProcessing = false
  })

  test('CONTROL — the drain route (teardown first, then the sweep) still withdraws the card exactly once', async () => {
    const session = sessionStub('sweep-drain')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session)
    await tick(20)
    await manager.strictDrainSessionForMutation(session, 'runtime switch (connection-cross-runtime)', true).catch(() => undefined)
    manager.clearPendingPermissionRequestsForSession(session.id, session.workspace.id)
    expect({ after: await settled(wait), withdrawn: rig.withdrawn }).toEqual({ after: CANCELLED, withdrawn: rig.raised.slice(0, 1) })
    session.isProcessing = false
  })

  test('THE DEFECT, second card kind — the cross-session dialog leaves the screen too; CONTROL: it is settled with no reason recorded (F1.404)', async () => {
    const sender = sessionStub('sweep-xsession-sender')
    const target = sessionStub('sweep-xsession-target')
    const { manager, rig } = harness(sender, target)
    manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1476-xsession')
    expect(rig.raised).toEqual(['f1476-xsession'])
    manager.clearPendingPermissionRequestsForSession(target.id, target.workspace.id)
    expect({
      resolverLeft: manager.directPermissionResolvers.has('f1476-xsession'),
      reasonRecorded: manager.hostCardCancellations.has('f1476-xsession'),
      withdrawn: rig.withdrawn,
    }).toEqual({ resolverLeft: false, reasonRecorded: false, withdrawn: ['f1476-xsession'] })
  })
})

// ─── (2) the Stop's safety timer ───────────────────────────────────────────────

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function loopRig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1476-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1476', name: 'F1.476', slug: 'f1476', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1476-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  const generators: Array<{ parked: Promise<void>; release: () => void }> = []
  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    // The generator does not stop when asked: the case the safety timer exists for.
    forceAbort: () => {},
    interruptForHandoff: () => {},
    takePendingSteers: () => [],
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      let reach!: () => void
      const parked = new Promise<void>(resolve => { reach = resolve })
      let release!: () => void
      const outcome = new Promise<void>(resolve => { release = resolve })
      generators.push({ parked, release })
      yield { type: 'text_delta', text: 'working ', turnId: `T${generators.length}` } as AgentEvent
      reach()
      await outcome
      yield { type: 'complete' } as AgentEvent
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }

  const generator = async (i: number) => {
    for (let n = 0; n < 500 && !generators[i]; n++) await tick(10)
    if (!generators[i]) throw new Error(`generator ${i} never started`)
    return generators[i]!
  }
  const send = (text: string) => manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
  return {
    manager,
    managed: managed as unknown as { isProcessing: boolean; processingGeneration: number; id: string },
    workspace, sent, generators, generator, send,
    cleanup: () => manager.cleanup(),
  }
}

describe('F1.476 (2) — a Stop\'s 5 s safety timer ends only the turn it was armed for', () => {
  it('THE DEFECT — Stop turn N (it drains at once), start and Stop turn N+1 2 s later: N\'s timer leaves N+1 alone, N+1\'s own timer ends it', async () => {
    const r = await loopRig('f1476-two-stops')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      const firstStopAt = Date.now()
      // Turn N's generator stops when asked: the drain ends the turn at once.
      r.generators[0]!.release()
      await first
      await tick(120)
      expect(r.managed.isProcessing).toBe(false)

      // Turn N+1 starts, and its generator is the stuck kind.
      void r.send('second')
      await (await r.generator(1)).parked
      await tick(Math.max(0, firstStopAt + 2_000 - Date.now()))
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      const secondStopAt = Date.now()
      const index = r.sent.length

      // Past turn N's timer (Stop N + 5 s), still short of N+1's own (Stop N+1 + 5 s).
      await tick(Math.max(0, firstStopAt + 5_400 - Date.now()))
      expect(Date.now() - secondStopAt).toBeLessThan(5_000)
      expect({ processing: r.managed.isProcessing, turnEndsSent: r.sent.slice(index).map(event => event.type).filter(type => type === 'complete') })
        .toEqual({ processing: true, turnEndsSent: [] })

      // CONTROL — N+1's own timer still force-ends it, 5 s after its own Stop.
      await tick(Math.max(0, secondStopAt + 5_400 - Date.now()))
      expect({ processing: r.managed.isProcessing, turnEndsSent: r.sent.slice(index).map(event => event.type).filter(type => type === 'complete') })
        .toEqual({ processing: false, turnEndsSent: ['complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})
