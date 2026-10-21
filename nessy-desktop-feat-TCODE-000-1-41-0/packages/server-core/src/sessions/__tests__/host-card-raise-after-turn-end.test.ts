/**
 * F1.406 + F1.402 (origin: the WJ-ff verifiers on F1.264 and on F1.263) — a
 * turn-bound card whose raise was still IN FLIGHT when its turn ended is refused,
 * not raised.
 *
 * ## What was measured first
 *
 * `authorizeMonitor` (ws) awaits `resolveMonitorTargetHost` and
 * `isDeniedNetworkTarget` (a DNS lookup) BEFORE it registers its resolver. A turn
 * that ends inside that wait — a Stop, an error, a handoff — sweeps a map the card
 * is not in yet, and the card then lands for a turn nobody runs: raised, counted,
 * answerable, and a person's Allow starts the watch. The verifiers' probes P2 (an
 * error) and D (a Stop: `cancelProcessing` plus `onProcessingStopped('interrupted')`)
 * read exactly that; the arms below are the same readings, before any fix.
 *
 * The three other turn-bound sites (`authorizeMonitorCommand`,
 * `authorizeWorktreeEnter`, `archiveSessionForAgent`) register synchronously from
 * their entry, so no turn end can fall between the two; only the ws site has the
 * window, and the refusal is written there.
 *
 * ## CONTROLS
 *
 * P2c — the same raise with no delay is registered before the turn end and swept
 * by it. A raise in flight across NO turn end is shown as usual. And a raise that
 * started while no turn ran (F1.401's between-turns card) is shown as usual even
 * when a turn starts and ends meanwhile — it was never that turn's.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { runInSessionToolCall } from '@nessy-agent/shared/agent/backend/claude/session-tool-call-origin'

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
    activeProvider: 'codex',
    permissionMode: 'default',
    isProcessing: true,
    processingGeneration: 7,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: `workspace-${id}`, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    ...extra,
  }
}

function harness(session: SessionStub) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  manager.sessions.set(encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }), session)
  const rig = { raised: [] as string[], withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') { rig.withdrawn.push(event.requestId); return }
    if (event?.type === 'permission_request') rig.raised.push(event.request?.requestId as string)
  }
  return { manager, rig }
}

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
const state = (wait: Promise<unknown>) => Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])

/** The ws raise, its target-host guard held open for `delayMs`. */
function raiseWs(manager: any, session: SessionStub, delayMs: number): Promise<unknown> {
  manager.resolveMonitorTargetHost = async () => { if (delayMs) await tick(delayMs); return 'example.test' }
  manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
  return manager.authorizeMonitor({
    sessionKey: { workspaceId: session.workspace.id, sessionId: session.id },
    ws: { url: 'wss://example.test/feed' },
  }).then(() => 'allowed', (error: Error) => error.message)
}

const CANCELLED = 'Monitor ws connection to wss://example.test/feed was cancelled because the turn ended.'

const endingsInsideTheWait: Array<{ name: string; end: (manager: any, session: SessionStub) => Promise<unknown> }> = [
  { name: 'an error (P2)', end: (m, s) => m.onProcessingStopped(s.id, 'error', s.workspace.id) },
  {
    name: 'a user Stop, then its drain (D)',
    end: async (m, s) => {
      await m.cancelProcessing(s.id, false, s.workspace.id)
      await m.onProcessingStopped(s.id, 'interrupted', s.workspace.id)
    },
  },
  {
    name: 'a completion followed at once by the NEXT turn starting',
    end: async (m, s) => {
      await m.onProcessingStopped(s.id, 'complete', s.workspace.id)
      s.processingGeneration += 1
      s.isProcessing = true
    },
  },
]

describe('F1.406 / F1.402 — the turn ended while the ws card\'s guard was awaiting: the card is refused, never raised', () => {
  for (const ending of endingsInsideTheWait) {
    test(`${ending.name} inside the target-host wait → not raised, not counted, settled as cancelled`, async () => {
      const session = sessionStub(`in-flight-${ending.name.replace(/\W+/g, '-')}`)
      const { manager, rig } = harness(session)
      const wait = raiseWs(manager, session, 80)
      try {
        await tick(10)
        expect(rig.raised).toHaveLength(0) // still inside the guard's await
        await ending.end(manager, session)
        await tick(120)
        expect({
          raised: rig.raised,
          count: manager.awaitingApprovalCount(session),
          resolvers: [...manager.directPermissionResolvers.keys()],
          after: await state(wait),
        }).toEqual({ raised: [], count: 0, resolvers: [], after: CANCELLED })
      } finally {
        session.isProcessing = false
        session.stopRequested = false
      }
    })
  }
})

describe('F1.406 / F1.402 — CONTROLS', () => {
  test('P2c — no delay: the card registers inside the turn and the turn end sweeps it', async () => {
    const session = sessionStub('p2c')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session, 0)
    await tick(20)
    expect(rig.raised).toHaveLength(1)
    await manager.onProcessingStopped(session.id, 'error', session.workspace.id)
    expect(await state(wait)).toBe(CANCELLED)
    expect(rig.withdrawn).toEqual(rig.raised.slice(0, 1))
    session.isProcessing = false
  })

  test('a delayed raise across NO turn end is shown and answerable as usual', async () => {
    const session = sessionStub('no-end')
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session, 60)
    try {
      await tick(100)
      expect(rig.raised).toHaveLength(1)
      expect(manager.awaitingApprovalCount(session)).toBe(1)
      manager.respondToPermission(session.id, rig.raised[0]!, true, false, undefined, session.workspace.id)
      expect(await wait).toBe('allowed')
    } finally {
      session.isProcessing = false
    }
  })

  test('a raise that STARTED between turns is shown even when a turn starts and ends meanwhile (F1.401)', async () => {
    const session = sessionStub('between-turns', { isProcessing: false })
    const { manager, rig } = harness(session)
    const wait = raiseWs(manager, session, 80)
    try {
      await tick(10)
      session.processingGeneration += 1
      session.isProcessing = true
      await manager.onProcessingStopped(session.id, 'complete', session.workspace.id)
      await tick(120)
      expect(rig.raised).toHaveLength(1)
      expect(manager.awaitingApprovalCount(session)).toBe(1)
      manager.respondToPermission(session.id, rig.raised[0]!, true, false, undefined, session.workspace.id)
      expect(await wait).toBe('allowed')
    } finally {
      session.isProcessing = false
    }
  })
})

/**
 * F1.631 (origin WJ-bp P-WJ-bp-2) — the codex half of F1.406. A codex MAIN-thread bridge call carries its turn's
 * id in `_meta["x-codex-turn-metadata"].turn_id` (measured on the shipped binary 0.159.3, EQUALS the `turn/started`
 * `turn.id` the agent keeps as `activeTurnId`), so the host can tell a raise whose turn ENDED from F1.401's
 * between-turns raise and refuse the first at entry. The scope arrives over the loopback bridge
 * (`runInSessionToolCall`, F1.493 (2)'s plumbing) — here it is set directly, exactly as the bridge sets it.
 *
 * THE DEFECT — a main-thread call reaching the host after `turn/completed` is stamped with no turn
 * (`raisingTurnOf` reads `isProcessing`) and lands: up, counted, answerable. CONTROLS — a call whose turn is the
 * LIVE one still raises (and the turn's later end declines it); a subagent-thread call (F1.493) is untouched by the
 * turn check, even naming a dead child turn; a call whose `_meta` names no turn id keeps F1.401's behaviour (the
 * stated residue for a binary that writes none).
 */
describe('F1.631 — a codex main-thread raise whose turn ended is refused at entry, before any card', () => {
  /** The agent stub `raisingOriginOf` reads structurally: `turn-live` is the only active turn. */
  const agent = { raisingTurnEnded: (turnId: string) => turnId !== 'turn-live' }

  test('THE DEFECT — a main-thread call arriving after its turn ended is refused, not raised', async () => {
    const session = sessionStub('codex-late', { isProcessing: false, agent })
    const { manager, rig } = harness(session)
    const wait = runInSessionToolCall(
      { sessionId: session.id, toolUseId: 'call_late_1', turnId: 'turn-main-1' },
      () => raiseWs(manager, session, 0),
    )
    await tick(60)
    expect({
      raised: rig.raised,
      count: manager.awaitingApprovalCount(session),
      resolvers: [...manager.directPermissionResolvers.keys()],
      after: await state(wait),
    }).toEqual({
      raised: [],
      count: 0,
      resolvers: [],
      after: 'Refused — the codex turn that called this tool (turn turn-main-1) has ended; the card was not raised.',
    })
  })

  test('CONTROL — a call whose turn is the LIVE one still raises, and the turn\'s later end declines it', async () => {
    const session = sessionStub('codex-live', { agent })
    const { manager, rig } = harness(session)
    const wait = runInSessionToolCall(
      { sessionId: session.id, toolUseId: 'call_live_1', turnId: 'turn-live' },
      () => raiseWs(manager, session, 0),
    )
    try {
      await tick(20)
      expect(rig.raised).toHaveLength(1)
      await manager.onProcessingStopped(session.id, 'error', session.workspace.id)
      expect(await state(wait)).toBe(CANCELLED)
      session.isProcessing = false
    } finally {
      session.isProcessing = false
    }
  })

  test('CONTROL — a subagent-thread call (F1.493) is stamped with the child even when its turn is dead', async () => {
    const CHILD = '01a0d437-8ba3-76b3-a621-403e22a71ffa'
    const MAIN = '01a0d437-6061-7311-bcb2-e6d5d734223a'
    const subagentAgent = {
      ...agent,
      subagentOfToolUse: (_callId: string, threadId?: string) => (threadId && threadId !== MAIN ? threadId : undefined),
      onSubagentEnded: (_agentId: string) => undefined,
    }
    const session = sessionStub('codex-child', { isProcessing: false, agent: subagentAgent })
    const { manager, rig } = harness(session)
    const wait = runInSessionToolCall(
      { sessionId: session.id, toolUseId: 'call_child_1', threadId: CHILD, turnId: 'turn-child-dead' },
      () => raiseWs(manager, session, 0),
    )
    try {
      await tick(60)
      expect(rig.raised).toHaveLength(1)
      manager.respondToPermission(session.id, rig.raised[0]!, true, false, undefined, session.workspace.id)
      expect(await wait).toBe('allowed')
    } finally {
      session.isProcessing = false
    }
  })

  test('RESIDUE — a call whose _meta names no turn id keeps F1.401: it lands between turns, unstamped', async () => {
    const session = sessionStub('codex-no-turn-id', { isProcessing: false, agent })
    const { manager, rig } = harness(session)
    const wait = runInSessionToolCall(
      { sessionId: session.id, toolUseId: 'call_plain_1' },
      () => raiseWs(manager, session, 0),
    )
    try {
      await tick(60)
      expect(rig.raised).toHaveLength(1)
      expect(manager.awaitingApprovalCount(session)).toBe(1)
      manager.respondToPermission(session.id, rig.raised[0]!, true, false, undefined, session.workspace.id)
      expect(await wait).toBe('allowed')
    } finally {
      session.isProcessing = false
    }
  })
})

/**
 * F1.631 follow-up — the leak the ws arm above could not show. At the THREE
 * SYNCHRONOUS sites (a command monitor start, an EnterWorktree, an
 * archive_session) the entry throw lived in the resolver literal, AFTER
 * `countHostRaisedCard` had already filed the record: the raise rejected with
 * the right sentence but left the record behind — `awaitingApprovalCount`
 * stuck at 1 for a card no event carried, no resolver could settle, no
 * turn-end sweep reached (they iterate `directPermissionResolvers`), and only
 * teardown's clear removed it. The fix reads the origin BEFORE the count (the
 * ws site's entry shape), so each refusal here settles count 0.
 */
describe('F1.631 — the synchronous sites refuse COUNT-CLEAN: the entry throw fires before the record is filed', () => {
  /** The agent stub the describe above uses: `turn-live` is the only active turn. */
  const agent = { raisingTurnEnded: (turnId: string) => turnId !== 'turn-live' }

  const cleanupRoots: string[] = []
  const refusedRaises: Array<{ name: string; raise: (manager: any, session: SessionStub) => Promise<unknown> }> = [
    {
      name: 'a command monitor start',
      raise: (manager, session) => {
        manager.monitorGateSessionIsPi = () => false
        manager.evaluateMonitorCommandRules = () => undefined
        return manager.authorizeMonitor({
          sessionKey: { workspaceId: session.workspace.id, sessionId: session.id },
          command: 'tail -f build.log',
        })
      },
    },
    {
      name: 'an EnterWorktree',
      raise: async (manager, session) => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'f1631-repo-'))
        session.projectKey = repoRoot
        session.workingDirectory = repoRoot
        cleanupRoots.push(repoRoot)
        return manager.authorizeWorktreeEnter(session, { path: join(tmpdir(), 'f1631-elsewhere') })
      },
    },
    {
      name: 'an archive_session',
      raise: (manager, session) => {
        manager.archiveSession = async () => undefined
        return manager.archiveSessionForAgent(session, undefined, true)
      },
    },
  ]

  for (const site of refusedRaises) {
    test(`${site.name} whose turn ended: refused with count 0 — nothing filed, nothing leaked`, async () => {
      const session = sessionStub(`sync-refused-${site.name.replace(/\W+/g, '-')}`, { isProcessing: false, agent })
      const { manager, rig } = harness(session)
      const wait = runInSessionToolCall(
        { sessionId: session.id, toolUseId: 'call_sync_1', turnId: 'turn-main-dead' },
        () => site.raise(manager, session).then(() => 'allowed', (error: Error) => error.message),
      )
      try {
        await tick(60)
        expect({
          raised: rig.raised,
          count: manager.awaitingApprovalCount(session),
          resolvers: [...manager.directPermissionResolvers.keys()],
          after: await state(wait),
        }).toEqual({
          raised: [],
          count: 0,
          resolvers: [],
          after: 'Refused — the codex turn that called this tool (turn turn-main-dead) has ended; the card was not raised.',
        })
      } finally {
        session.isProcessing = false
        session.stopRequested = false
        for (const root of cleanupRoots.splice(0)) await rm(root, { recursive: true, force: true })
      }
    })
  }
})
