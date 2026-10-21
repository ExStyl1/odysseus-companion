/**
 * F1.573 (origin WJ-as P-WJas-1) — a SUPERSEDED `complete` is charged to the session and parks nothing on the next turn.
 *
 * ## What was read, and what this file measures first
 *
 * F1.529 (`stale-complete-ends-only-its-turn.test.ts`) stopped a late `complete` from an ENDED turn's generator from
 * taking the next turn's steers or ending it. But the chat loop still handed that `complete` to `processEvent` BEFORE its
 * generation check, and `processEvent`'s `complete` case PARKS the turn-scoped fields there: `turnTerminalReason`,
 * `turnDeferredToolUse`, `turnTerminalIsError` and the structured output. The next turn cleared all of them at its own
 * start, before it waited on the capability gate the old loop still held. So they rode that turn's renderer `complete`,
 * and a verdict reason (`TERMINAL_REASON_NOTICE_VALUES`) wrote a verdict row onto the wrong turn. The Pi goal block
 * charged the stale tokens to the NEXT turn's goal reference. `goal-service.ts`'s `recordTurn` dedupes by `lastTurnId`,
 * so the next turn's OWN tokens were then dropped from the goal's accounting.
 *
 * The rig is the F1.529 rig (the real `sendMessage` loop, the REAL capability-turn gate), in its handoff shape: the host
 * lowers the flag the way the plan / auth handoffs do, the next turn is sent, then the old generator completes.
 *
 * ## The decision this file pins (P2.5's children sweep)
 *
 * A superseded `complete` whose reason is `max_budget_usd` still runs `onMaxBudgetUsdReached`. The session spent past its
 * ceiling, and the sweep stops the children that keep spending after the parent's turn ends. That is session money, so
 * it does not belong to any one turn. The REASON still never lands on the next turn: no verdict row, no `terminalReason`
 * on its renderer `complete`.
 *
 * ## CONTROLS
 *
 * - The next turn's OWN terminal reason still rides its renderer `complete`, and its verdict row lands once.
 * - The stale turn's usage and cost still count in the session's totals.
 * - The next turn's own tokens are the first goal record for its turn id.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

setDefaultTimeout(30_000)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

interface GoalRecord { goalId?: string; turnId: string; tokens: number; costUsd: number }

/** The stale turn's trailing `complete`: every turn-scoped field it can carry, and a cost. */
const STALE_COMPLETE_FIELDS = {
  deferredToolUse: { id: 'toolu_stale', name: 'Bash', input: { command: 'ls' } },
  terminalIsError: true,
  structuredOutput: { stale: true },
  structuredOutputSubtype: 'success' as const,
  structuredOutputErrors: ['stale error'],
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
}

async function rig(sessionId: string, completes: [AgentEvent, AgentEvent]) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1573-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1573', name: 'F1.573', slug: 'f1573', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  // `acquireCapabilityTurn` is NOT stubbed: the real gate is the production window.
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1573-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  // An ACTIVE Pi goal, as the goal service reports it. `recordTurn` records every call; the real service keeps the FIRST
  // record of a turn id (`lastTurnId` dedupe), which `accountedGoalTurns` below replays.
  const goalRecords: GoalRecord[] = []
  const goalService = {
    snapshot: () => ({ goal: { id: 'goal-f1573', status: 'active' } }),
    recordTurn: async (record: GoalRecord) => { goalRecords.push(record); return goalService.snapshot() },
  }
  const managedKey = (internals.managedKey as (m: unknown) => string).call(manager, managed)
  ;(internals.piGoalServices as Map<string, unknown>).set(managedKey, goalService)

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
    forceAbort: () => {},
    interruptForHandoff: () => {},
    takePendingSteers: () => [],
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      const index = generators.length
      let reach!: () => void
      const parked = new Promise<void>(resolve => { reach = resolve })
      let release!: () => void
      const outcome = new Promise<void>(resolve => { release = resolve })
      generators.push({ parked, release })
      yield { type: 'text_delta', text: 'working ', turnId: `T${index + 1}` } as AgentEvent
      reach()
      await outcome
      yield completes[index]!
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
    internals,
    managed: managed as unknown as {
      isProcessing: boolean
      processingGeneration: number
      id: string
      messages: Array<{ role: string; content: string; errorCode?: string }>
      tokenUsage?: { outputTokens: number; costUsd: number }
      maxBudgetUsdReached?: boolean
    },
    sent, generators, generator, send, goalRecords,
    cleanup: () => manager.cleanup(),
  }
}

type Rig = Awaited<ReturnType<typeof rig>>

/** The goal records the REAL service keeps: the first record of each turn id (`goal-service.ts`, `lastTurnId`). */
const accountedGoalTurns = (records: GoalRecord[]) => {
  const kept: GoalRecord[] = []
  for (const record of records) if (kept.at(-1)?.turnId !== record.turnId) kept.push(record)
  return kept
}

const verdictRows = (r: Rig) => r.managed.messages.filter(message => message.role === 'info' && message.content.startsWith('terminal_reason:'))
const budgetNotices = (r: Rig) => r.managed.messages.filter(message => message.errorCode === 'max_budget_usd')

/**
 * The handoff shape of F1.529: turn 1 parks, the host lowers the flag, turn 2 is sent and waits on the capability gate
 * turn 1's loop holds, turn 1's generator completes (SUPERSEDED), then turn 2 completes by itself. Returns turn 2's
 * renderer `complete` and the goal turn id turn 2 captured.
 */
async function supersededThenOwnComplete(r: Rig) {
  const first = r.send('first')
  await (await r.generator(0)).parked
  ;(r.internals.setProcessing as (managed: unknown, value: boolean) => void).call(r.manager, r.managed, false)
  const second = r.send('second')
  await tick(150)
  expect(r.managed.isProcessing).toBe(true)
  const secondGoalTurnId = `${r.managed.id}-goal-turn-${r.managed.processingGeneration}`
  const index = r.sent.length

  r.generators[0]!.release()
  await first
  await (await r.generator(1)).parked
  await tick(120)
  // F1.529 still holds: the superseded `complete` ended nothing.
  expect(r.managed.isProcessing).toBe(true)

  r.generators[1]!.release()
  await second
  await tick(150)
  expect(r.managed.isProcessing).toBe(false)
  const ends = r.sent.slice(index).filter(event => event.type === 'complete')
  expect(ends).toHaveLength(1)
  return { end: ends[0] as Record<string, unknown>, secondGoalTurnId }
}

const TURN_SCOPED_KEYS = ['terminalReason', 'deferredToolUse', 'terminalIsError', 'structuredOutput', 'structuredOutputSubtype', 'structuredOutputErrors']
const turnScopedFieldsOf = (end: Record<string, unknown>) => Object.fromEntries(TURN_SCOPED_KEYS.filter(key => key in end).map(key => [key, end[key]]))

describe('F1.573 — a superseded `complete` parks nothing on the next turn', () => {
  it('THE DEFECT — every turn-scoped field of the stale `complete` stays off the next turn; the stale cost still counts', async () => {
    const r = await rig('f1573-turn-scoped', [
      { type: 'complete', terminalReason: 'tool_deferred', ...STALE_COMPLETE_FIELDS } as AgentEvent,
      { type: 'complete', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.25 } } as AgentEvent,
    ])
    try {
      const { end, secondGoalTurnId } = await supersededThenOwnComplete(r)
      expect({
        nextTurnFields: turnScopedFieldsOf(end),
        verdictRows: verdictRows(r).length,
        // CONTROL — the stale usage is money spent: it still counts in the session's totals.
        outputTokens: r.managed.tokenUsage?.outputTokens,
        costUsd: r.managed.tokenUsage?.costUsd,
        // The next turn's OWN tokens are the goal record its turn id keeps.
        goalTurn: accountedGoalTurns(r.goalRecords).find(record => record.turnId === secondGoalTurnId),
        staleTokensOnAGoalTurn: r.goalRecords.filter(record => record.tokens === 15).length,
      }).toEqual({
        nextTurnFields: {},
        verdictRows: 0,
        outputTokens: 12,
        costUsd: 0.75,
        goalTurn: { goalId: 'goal-f1573', turnId: secondGoalTurnId, tokens: 27, costUsd: 0.25 },
        staleTokensOnAGoalTurn: 0,
      })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('`max_budget_usd` on the stale `complete` — the reason never lands on the next turn; the P2.5 children sweep still runs (the decision)', async () => {
    const r = await rig('f1573-budget', [
      { type: 'complete', terminalReason: 'max_budget_usd', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } } as AgentEvent,
      { type: 'complete', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.25 } } as AgentEvent,
    ])
    try {
      const { end } = await supersededThenOwnComplete(r)
      expect({
        nextTurnReason: end.terminalReason,
        verdictRows: verdictRows(r).length,
        budgetNotices: budgetNotices(r).length,
        latched: r.managed.maxBudgetUsdReached,
        costUsd: r.managed.tokenUsage?.costUsd,
      }).toEqual({ nextTurnReason: undefined, verdictRows: 0, budgetNotices: 1, latched: true, costUsd: 0.75 })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

describe('F1.573 — CONTROL: the next turn\'s OWN terminal reason still rides', () => {
  it('the next turn ends with `max_agent_turns` → its renderer `complete` carries it and ONE verdict row lands', async () => {
    const r = await rig('f1573-own-reason', [
      { type: 'complete', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 } } as AgentEvent,
      { type: 'complete', terminalReason: 'max_agent_turns', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.25 } } as AgentEvent,
    ])
    try {
      const { end } = await supersededThenOwnComplete(r)
      expect({ nextTurnFields: turnScopedFieldsOf(end), verdictRows: verdictRows(r).map(row => row.content) })
        .toEqual({ nextTurnFields: { terminalReason: 'max_agent_turns' }, verdictRows: ['terminal_reason:max_agent_turns'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})
