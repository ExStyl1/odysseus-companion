/**
 * F1.475 (2/2) — a card a claude SUBAGENT raised belongs to that subagent: no parent turn's end declines it, and
 * the subagent's own end does.
 *
 * ## What F1.401 left
 *
 * F1.401 stamped each turn-bound host card (Monitor ws/command, EnterWorktree, archive_session) with the
 * `processingGeneration` of the turn running at the raise, so a card raised BETWEEN turns belongs to no turn. Its
 * stated residue: a claude background subagent's card raised while a LATER parent turn runs is stamped with that
 * turn and declined when it ends — the subagent outlives parent turns by design (P6.793) and is still waiting on
 * the answer. The arms below are that residue, measured on the host before any fix.
 *
 * ## What reaches the host now (F1.475 1/2)
 *
 * The in-process session tool puts `{ sessionId, toolUseId }` in scope for the call
 * (`backend/claude/session-tool-call-origin.ts`); the claude agent answers `subagentOfToolUse(toolUseId)` from its
 * own PreToolUse hook (`agent_id` is present only inside a subagent) and calls `onSubagentEnded(agentId)` on the
 * subagent's terminal `task_notification`, turn open or not. Measured on the vendored 2.1.251: that notification
 * arrives `completed` for a normal end and `stopped` after `stopTask` or an interrupt — so a Stop that kills the
 * subagent declines its card through the same door.
 *
 * ## The rig
 *
 * `host-card-raising-turn.test.ts`'s: the real raise sites, the real turn ends, `sendEvent` as the instrument. The
 * claude agent is a stand-in exposing exactly the three members the host reads; the scope is set with the real
 * `runInSessionToolCall`, as `registryTool` does.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { runInSessionToolCall } from '@nessy-agent/shared/agent/backend/claude/session-tool-call-origin'

import { createTestSessionManager } from './test-session-manager.ts'

const SUBAGENT = 'a4cad016e2165d3af'
const SUB_CALL = 'toolu_sub_whoami'
const MAIN_CALL = 'toolu_main_whoami'

type FakeClaude = {
  subagentOfToolUse(toolUseId: string): string | undefined
  subagentEnded(agentId: string): boolean
  onSubagentEnded?: (agentId: string) => void
  forceAbort(): void
  interruptForHandoff(): void
  end(agentId: string): void
}

/** The claude agent as the host sees it: the join from its PreToolUse hook, and its report of a subagent's end. */
function fakeClaude(): FakeClaude {
  const ended = new Set<string>()
  const agent: FakeClaude = {
    subagentOfToolUse: toolUseId => (toolUseId === SUB_CALL ? SUBAGENT : undefined),
    subagentEnded: agentId => ended.has(agentId),
    forceAbort: () => undefined,
    interruptForHandoff: () => undefined,
    end: agentId => { ended.add(agentId); agent.onSubagentEnded?.(agentId) },
  }
  return agent
}

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  isProcessing: boolean
  processingGeneration: number
  agent: FakeClaude
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'claude',
    permissionMode: 'default',
    // A LATER parent turn is running when the subagent's call arrives — F1.401's residue.
    isProcessing: true,
    processingGeneration: 3,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: `workspace-${id}`, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    agent: fakeClaude(),
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
  return manager
}

function watch(manager: any) {
  const rig = { raised: [] as string[], withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') { rig.withdrawn.push(event.requestId); return }
    if (event?.type === 'permission_request') rig.raised.push(event.request?.requestId as string)
  }
  return rig
}

async function state(wait: Promise<unknown>): Promise<unknown> {
  return Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])
}

const raiseSettles = () => new Promise<void>(resolve => { setTimeout(resolve, 20) })

type Raised = { manager: any; shownIn: SessionStub; rig: ReturnType<typeof watch>; wait: Promise<unknown>; cleanup?: () => Promise<void> }

/** Each site raised from inside a session-tool call whose tool-use id is `toolUseId`, scoped to `scopeSession`. */
function raiseSites(toolUseId: string, scopeSession?: (shownIn: SessionStub) => string): Array<{ name: string; raise: () => Promise<Raised> }> {
  const inCall = <T>(shownIn: SessionStub, action: () => T): T =>
    runInSessionToolCall({ sessionId: scopeSession ? scopeSession(shownIn) : shownIn.id, toolUseId }, action)
  return [
    {
      name: 'authorizeMonitor (ws)',
      raise: async () => {
        const shownIn = sessionStub(`f1475-monitor-ws-${toolUseId}`)
        const manager = harness(shownIn)
        manager.resolveMonitorTargetHost = async () => 'example.test'
        manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
        const rig = watch(manager)
        const wait = inCall(shownIn, () => manager.authorizeMonitor({
          sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
          ws: { url: 'wss://example.test/feed' },
        })).then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, wait }
      },
    },
    {
      name: 'authorizeMonitorCommand',
      raise: async () => {
        const shownIn = sessionStub(`f1475-monitor-command-${toolUseId}`)
        const manager = harness(shownIn)
        manager.monitorGateSessionIsPi = () => false
        manager.evaluateMonitorCommandRules = () => undefined
        const rig = watch(manager)
        const wait = inCall(shownIn, () => manager.authorizeMonitorCommand({
          sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
          command: 'tail -f build.log',
        })).then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, wait }
      },
    },
    {
      name: 'authorizeWorktreeEnter',
      raise: async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'f1475-repo-'))
        const shownIn = sessionStub(`f1475-worktree-${toolUseId}`, { projectKey: repoRoot, workingDirectory: repoRoot })
        const manager = harness(shownIn)
        const rig = watch(manager)
        const wait = inCall(shownIn, () => manager.authorizeWorktreeEnter(shownIn, { path: join(tmpdir(), 'f1475-elsewhere') }))
          .then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, wait, cleanup: () => rm(repoRoot, { recursive: true, force: true }) }
      },
    },
    {
      name: 'archiveSessionForAgent',
      raise: async () => {
        const shownIn = sessionStub(`f1475-archive-caller-${toolUseId}`)
        const target = sessionStub(`f1475-archive-target-${toolUseId}`, { workspace: shownIn.workspace, isArchived: false, isProcessing: false })
        const manager = harness(shownIn, target)
        manager.archiveSession = async () => undefined
        const rig = watch(manager)
        const wait = inCall(shownIn, () => manager.archiveSessionForAgent(shownIn, target.id, true))
          .then((verdict: { status: string; note?: string }) => (verdict.status === 'applied' ? 'allowed' : `${verdict.status}: ${verdict.note}`), (error: Error) => error.message)
        return { manager, shownIn, rig, wait }
      },
    },
  ]
}

/** The parent turn that was running at the raise ends. */
const parentTurnEnds: Array<{ name: string; end: (manager: any, shownIn: SessionStub) => Promise<unknown> }> = [
  { name: 'completes', end: (m, s) => m.onProcessingStopped(s.id, 'complete', s.workspace.id) },
  { name: 'errors', end: (m, s) => m.onProcessingStopped(s.id, 'error', s.workspace.id) },
  { name: 'times out', end: (m, s) => m.onProcessingStopped(s.id, 'timeout', s.workspace.id) },
  // The host's Stop alone; on the real runtime the interrupt then kills the subagent, and ITS end declines the card.
  { name: 'is stopped by the user', end: (m, s) => m.cancelProcessing(s.id, false, s.workspace.id) },
]

describe('F1.475 — a subagent\'s card is not declined by the parent turn\'s end', () => {
  for (const site of raiseSites(SUB_CALL)) {
    for (const ending of parentTurnEnds) {
      test(`${site.name}: raised by a subagent while a parent turn runs, that turn ${ending.name} → the card stays up and answerable`, async () => {
        const { manager, shownIn, rig, wait, cleanup } = await site.raise()
        try {
          await raiseSettles()
          expect(rig.raised).toHaveLength(1)
          const requestId = rig.raised[0]!
          await ending.end(manager, shownIn)
          shownIn.isProcessing = false
          shownIn.stopRequested = false

          expect({
            count: manager.awaitingApprovalCount(shownIn),
            resolverLeft: manager.directPermissionResolvers.has(requestId),
            withdrawn: rig.withdrawn,
            after: await state(wait),
          }).toEqual({ count: 1, resolverLeft: true, withdrawn: [], after: 'STILL WAITING' })
          manager.respondToPermission(shownIn.id, requestId, true, false, undefined, shownIn.workspace.id)
          expect(await wait).toBe('allowed')
        } finally {
          shownIn.isProcessing = false
          shownIn.stopRequested = false
          await cleanup?.()
        }
      })
    }
  }
})

describe('F1.475 — the subagent\'s own end declines its card', () => {
  for (const site of raiseSites(SUB_CALL)) {
    test(`${site.name}: the subagent ends (its task_notification) → declined, "was cancelled because the subagent that asked for it ended"`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        // Another subagent ending first leaves this card alone.
        shownIn.agent.end('a-some-other-subagent')
        expect({ count: manager.awaitingApprovalCount(shownIn), after: await state(wait) }).toEqual({ count: 1, after: 'STILL WAITING' })

        shownIn.agent.end(SUBAGENT)
        expect({ count: manager.awaitingApprovalCount(shownIn), withdrawn: rig.withdrawn }).toEqual({ count: 0, withdrawn: rig.raised.slice(0, 1) })
        const after = await state(wait)
        expect(after).not.toBe('STILL WAITING')
        expect(after).not.toBe('allowed')
        expect(String(after)).toContain('was cancelled because the subagent that asked for it ended')
      } finally {
        shownIn.isProcessing = false
        await cleanup?.()
      }
    })
  }

  test('authorizeMonitor (ws): the subagent ends DURING the target-host guard → refused, never raised', async () => {
    const shownIn = sessionStub('f1475-ws-guard')
    const manager = harness(shownIn)
    manager.resolveMonitorTargetHost = async () => 'example.test'
    let releaseGuard!: () => void
    const guard = new Promise<void>(resolve => { releaseGuard = resolve })
    manager.resolveNetworkAddressesFn = async () => { await guard; return ['93.184.216.34'] }
    const rig = watch(manager)
    const wait = runInSessionToolCall({ sessionId: shownIn.id, toolUseId: SUB_CALL }, () => manager.authorizeMonitor({
      sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
      ws: { url: 'wss://example.test/feed' },
    })).then(() => 'allowed', (error: Error) => error.message)
    await raiseSettles()
    shownIn.agent.end(SUBAGENT)
    releaseGuard()
    expect(await wait).toBe('Monitor ws connection to wss://example.test/feed was cancelled because the subagent that asked for it ended.')
    expect({ raised: rig.raised, count: manager.awaitingApprovalCount(shownIn) }).toEqual({ raised: [], count: 0 })
  })
})

describe('F1.475 — CONTROLS: what is not a subagent\'s card keeps F1.208 / F1.401', () => {
  for (const site of raiseSites(MAIN_CALL)) {
    test(`${site.name}: a MAIN-thread call raised mid-turn → declined by that turn's end, "was cancelled because the turn ended"`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        await manager.onProcessingStopped(shownIn.id, 'complete', shownIn.workspace.id)
        expect({ count: manager.awaitingApprovalCount(shownIn), withdrawn: rig.withdrawn }).toEqual({ count: 0, withdrawn: rig.raised.slice(0, 1) })
        expect(String(await state(wait))).toContain('was cancelled because the turn ended')
      } finally {
        shownIn.isProcessing = false
        await cleanup?.()
      }
    })
  }

  for (const site of raiseSites(SUB_CALL, shownIn => `${shownIn.id}-someone-else`)) {
    test(`${site.name}: a scope naming ANOTHER session is not read → the turn stamp, declined by the turn's end`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        await manager.onProcessingStopped(shownIn.id, 'complete', shownIn.workspace.id)
        expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
        expect(String(await state(wait))).toContain('was cancelled because the turn ended')
      } finally {
        shownIn.isProcessing = false
        await cleanup?.()
      }
    })
  }

  test('a subagent\'s card still closes when the session\'s runtime is torn down (F1.403)', async () => {
    const [site] = raiseSites(SUB_CALL)
    const { manager, shownIn, rig, wait } = await site!.raise()
    await raiseSettles()
    expect(rig.raised).toHaveLength(1)
    manager.declineHostCards(shownIn, 'Runtime dispose', "was cancelled because the session's agent runtime was shut down", () => true)
    expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
    expect(String(await state(wait))).toContain("was cancelled because the session's agent runtime was shut down")
  })
})
