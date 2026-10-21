/**
 * P2.5 — the `--max-budget-usd` ceiling reaches the session's SUBAGENTS.
 *
 * The producer is unchanged and stays unchanged: the backend chat loop ends the
 * turn with `terminalReason: 'max_budget_usd'` and aborts the parent's own
 * session (`pi-agent.ts`, `base-agent.ts`). What that abort never reached is
 * everything below it — a background child is a separate managed session with
 * its own agent, so at the cap it kept burning, and the next turn could still
 * spawn more.
 *
 * This file drives the seam that closes both: `SessionManager` sees the same
 * `complete` event it already parks the reason from, latches the session,
 * stops the running children through the child-session service's existing stop
 * path, and says so in the transcript — while the reason it forwards to the
 * renderer is byte-identical to before (the regression pin below).
 *
 * The latch is re-evaluated per turn, exactly as the producer re-reads its own
 * ceiling per turn (`base-agent.ts`'s `getMaxBudgetUsd` calls
 * `loadConfigDefaults()` at each check). Nothing here decides the verdict — the
 * clear only stops the session caching yesterday's — but without it the
 * refusal's own advice, "ask the user to raise the limit", would be false: the
 * parent would run free on the next turn while its children stayed refused for
 * the life of the runtime.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Message } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { CHILD_SESSION_BUDGET_EXHAUSTED_ERROR, ChildSessionService } from '../pi-harness/child-session-service.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function usageFixture() {
  return { inputTokens: 12, outputTokens: 3, costUsd: 0.5 }
}

const restrictions = { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const }
const childBudgets = () => ({ depth: 1, maxDepth: 3, fanout: 4, concurrency: 4, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 60_000, ancestry: [] })

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

interface Rig {
  manager: SessionManager
  managed: { id: string; messages: Message[]; workspace: { id: string }; maxBudgetUsdReached?: boolean }
  events: SessionEvent[]
  stopped: string[]
  service: ChildSessionService
  /** The latch as the BACKEND saw it on entry to each turn, one entry per turn. */
  turnEntryLatch: Array<boolean | undefined>
  /** Run another turn on the same session, with a different backend script. */
  sendTurn(events: AgentEvent[]): Promise<void>
  cleanup(): void
}

interface RigOptions {
  /** Seed a running background child (default true). */
  startChild?: boolean
  /** Register the service on the manager, so the cap's sweep can find it (default true). */
  installService?: boolean
}

/**
 * A session with ONE running background child, then a turn whose backend emits
 * `backendEvents`. Mirrors `turn-terminal-reason.test.ts`'s rig — the reason
 * only leaves the main process through `sendMessage`'s completion path, so a
 * unit that skips the turn would not exercise the seam at all.
 */
async function runTurnWithBackgroundChild(backendEvents: AgentEvent[], options: RigOptions = {}): Promise<Rig> {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-budget-cap-'))
  roots.push(stateRoot)
  const workspace = {
    id: 'ws-budget-cap',
    name: 'Budget Cap Workspace',
    slug: 'budget-cap',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession(
    { id: 'session-budget-cap' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  )
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )

  const stopped: string[] = []
  let ids = 0
  const service = new ChildSessionService({
    parentSessionKey: { workspaceId: workspace.id, sessionId: managed.id },
    persist: async () => {},
    // The same reader `getOrCreatePiChildSessionService` installs — the third
    // case below pins that the real builder installs it too, so this double
    // cannot pass a gate the app is missing.
    budgetExhausted: () => (managed as unknown as { maxBudgetUsdReached?: boolean }).maxBudgetUsdReached === true,
    runtime: {
      start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' as const }),
      resume: async () => ({ status: 'completed' as const }),
      steer: async () => {},
      stop: async record => { stopped.push(record.agentId) },
    },
    makeId: () => (ids += 1) === 1 ? 'child-burning' : `child-${ids}`,
  })
  if (options.startChild ?? true) {
    await service.start({ agent: 'worker', task: 'keep working', background: true, restrictions, budgets: childBudgets() })
  }
  if (options.installService ?? true) {
    ;(manager as unknown as { piChildSessionServices: Map<string, ChildSessionService> })
      .piChildSessionServices.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: managed.id }), service)
  }

  const events: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => {
    events.push(event)
  }) as Parameters<SessionManager['setEventSink']>[0])

  const internals = manager as unknown as {
    persistSession(managed: unknown): void
    acquireCapabilityTurn(managed: unknown): Promise<() => void>
    createCapabilityTurn(managed: unknown): Promise<unknown>
    createRetainedCapabilityLease(leaseId: string): unknown
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
  }
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({
    snapshot: { leaseId: 'budget-cap-lease' },
    runtime: { view: { sources: [] }, materializer: {} },
  })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  // Recorded at the moment the BACKEND starts running, i.e. after the turn's
  // own reset ran and before this turn's `complete` can latch anything. It is
  // the only vantage point from which "cleared at turn start" is distinguishable
  // from "never set this turn".
  let script = backendEvents
  const turnEntryLatch: Array<boolean | undefined> = []

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
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* () {
      turnEntryLatch.push((managed as unknown as { maxBudgetUsdReached?: boolean }).maxBudgetUsdReached)
      for (const event of script) yield event
    },
  }
  internals.getOrCreateAgent = async () => {
    managed.agent = agent as never
    return agent
  }

  const send = (text: string) => manager.sendMessage(
    managed.id,
    text,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { workspaceId: workspace.id },
  )

  await send('budget cap probe')

  return {
    manager,
    managed: managed as unknown as Rig['managed'],
    events,
    stopped,
    service,
    turnEntryLatch,
    sendTurn: async (nextEvents: AgentEvent[]) => {
      script = nextEvents
      await send('next turn')
    },
    cleanup: () => manager.cleanup(),
  }
}

function lastComplete(events: SessionEvent[]) {
  return events
    .filter((event): event is Extract<SessionEvent, { type: 'complete' }> => event.type === 'complete')
    .at(-1)
}

function budgetNotice(messages: Message[]): Message | undefined {
  return messages.find(message => message.role === 'info' && message.errorCode === 'max_budget_usd')
}

describe('the USD budget cap reaches subagents', () => {
  it('stops the running background child and says so in the parent transcript', async () => {
    const rig = await runTurnWithBackgroundChild([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    try {
      await waitUntil(() => rig.stopped.length > 0, 'background child stopped at the cap')
      // The EXISTING stop path — the runtime's own `stop` and the `stopped`
      // status the service already writes. No new termination kind.
      expect(rig.stopped).toEqual(['child-burning'])
      expect(rig.service.get('child-burning')?.status).toBe('stopped')

      await waitUntil(() => budgetNotice(rig.managed.messages) !== undefined, 'budget notice appended')
      const notice = budgetNotice(rig.managed.messages)!
      expect(notice.infoLevel).toBe('warning')
      // Honest about WHAT happened, not just that something did.
      expect(notice.content).toContain('Stopped 1 running subagent.')
      // P2.98 — and it no longer opens by RESTATING the cap. That sentence is
      // now the persisted verdict row's job, and this notice used to duplicate
      // it on every max_budget_usd stop of every runtime, landing FIRST in the
      // no-child-service case. What survives here is the half only this notice
      // knows: what happened to the subagents.
      expect(notice.content).not.toContain('Spending limit reached')
      expect(notice.content.startsWith('Stopped 1 running subagent.')).toBe(true)
      // Scoped to THIS TURN, because the latch is cleared at the next turn's
      // start: a promise of a permanent ban is false the moment the user raises
      // the ceiling and sends again.
      expect(notice.content).toContain(
        'No new subagents can start for the rest of this turn;'
        + ' raising the spending limit lets the next turn spawn again.',
      )
      expect(notice.content).not.toContain('in this session')
      // Nothing was left unreachable, so nothing claims to be.
      expect(notice.content).not.toMatch(/could not be stopped/i)
      expect(notice.content).not.toContain('Unreachable')
      expect(rig.events.some(event => event.type === 'info' && event.message === notice.content)).toBe(true)
    } finally {
      rig.cleanup()
    }
  })

  it('refuses the next spawn through the child-session service', async () => {
    const rig = await runTurnWithBackgroundChild([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    try {
      await waitUntil(() => rig.managed.maxBudgetUsdReached === true, 'session latched at the cap')
      // The gate the Pi spawner meets on the next turn.
      await expect(rig.service.start({
        agent: 'worker', task: 'one more', background: true, restrictions, budgets: childBudgets(),
      })).rejects.toThrow(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
    } finally {
      rig.cleanup()
    }
  })

  it('wires the same gate onto the service it builds for a live session', async () => {
    const rig = await runTurnWithBackgroundChild([{ type: 'complete', usage: usageFixture() }])
    try {
      // Not the seeded double: the service `getOrCreatePiChildSessionService`
      // constructs for a real session must carry the reader too, or the gate
      // above is proven on a stub and absent in the app.
      const internals = rig.manager as unknown as {
        piChildSessionServices: Map<string, ChildSessionService>
        getOrCreatePiChildSessionService(managed: unknown, worktreeService: unknown): ChildSessionService
      }
      internals.piChildSessionServices.clear()
      const built = internals.getOrCreatePiChildSessionService(rig.managed, {})
      expect(built).not.toBe(rig.service)
      rig.managed.maxBudgetUsdReached = true
      await expect(built.start({
        agent: 'worker', task: 'one more', background: true, restrictions, budgets: childBudgets(),
      })).rejects.toThrow(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
    } finally {
      rig.cleanup()
    }
  })

  it('leaves an ordinary completion alone — no latch, no stop, no notice', async () => {
    const rig = await runTurnWithBackgroundChild([{ type: 'complete', usage: usageFixture() }])
    try {
      // P2.106 — this line used to read
      // `expect(lastComplete(rig.events)?.terminalReason).toBeUndefined()`, and
      // an optional chain on a possibly-absent event yields `undefined` in every
      // world: measured by reading the reason out of an EMPTY event list, which
      // the old assertion passed. It therefore held whether or not the turn ever
      // completed — the exact 'a test that passes in every world' class.
      //
      // Two things fix it. The `complete` is emitted several awaits deep in
      // `sendTurnEndEvent` (P3.18's note on the regression pin at the bottom of
      // this file), so its arrival is AWAITED rather than assumed; and the
      // assertion then runs against the event itself, not against an optional
      // chain that swallows its absence.
      await waitUntil(
        () => lastComplete(rig.events) !== undefined,
        'the ordinary completion reached the event sink',
      )
      const complete = lastComplete(rig.events)!
      expect(complete.terminalReason).toBeUndefined()
      expect(rig.managed.maxBudgetUsdReached).toBeUndefined()
      expect(rig.stopped).toEqual([])
      expect(rig.service.get('child-burning')?.status).toBe('running')
      expect(budgetNotice(rig.managed.messages)).toBeUndefined()
      await expect(rig.service.start({
        agent: 'worker', task: 'another', background: true, restrictions, budgets: childBudgets(),
      })).resolves.toBeDefined()
    } finally {
      rig.cleanup()
    }
  })

  it('re-evaluates the latch per turn: a raised cap lets the next turn spawn again', async () => {
    // The producer already re-reads the ceiling every turn — `getMaxBudgetUsd`
    // calls `loadConfigDefaults()` at each check — so a cap the user raises
    // stops binding the PARENT on the next turn. Raising it here is modelled the
    // only way the host can observe it: the backend stops ending turns with
    // `max_budget_usd`. The children have to be freed on the same turn, or the
    // refusal's own advice ("ask the user to raise the limit") is false.
    const rig = await runTurnWithBackgroundChild([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    try {
      await waitUntil(() => rig.managed.maxBudgetUsdReached === true, 'session latched at the cap')

      await rig.sendTurn([{ type: 'complete', usage: usageFixture() }])
      // Cleared at turn START, not merely absent at turn end: the backend saw an
      // un-latched session on entry to turn 2 even though turn 1 latched it.
      expect(rig.turnEntryLatch).toEqual([undefined, undefined])
      expect(rig.managed.maxBudgetUsdReached).toBeUndefined()
      // And the gate really is open — this is the spawn the stuck latch refused.
      await expect(rig.service.start({
        agent: 'worker', task: 'after the raise', background: true, restrictions, budgets: childBudgets(),
      })).resolves.toBeDefined()
    } finally {
      rig.cleanup()
    }
  })

  it('re-trips immediately when the cap was NOT raised', async () => {
    // The other half of the same coin: clearing per turn is not forgiving the
    // ceiling. A turn that breaches it again latches again, on its own verdict.
    const capped = { type: 'complete' as const, usage: usageFixture(), terminalReason: 'max_budget_usd' as const }
    const rig = await runTurnWithBackgroundChild([capped])
    try {
      await waitUntil(() => rig.managed.maxBudgetUsdReached === true, 'session latched at the cap')
      await rig.sendTurn([capped])
      await waitUntil(() => rig.managed.maxBudgetUsdReached === true, 'session re-latched on the next turn')
      expect(rig.turnEntryLatch).toEqual([undefined, undefined])
      await expect(rig.service.start({
        agent: 'worker', task: 'one more', background: true, restrictions, budgets: childBudgets(),
      })).rejects.toThrow(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
    } finally {
      rig.cleanup()
    }
  })

  it('says so even when the cap found no children to stop', async () => {
    // The notice's load-bearing sentence is not "children were stopped" but "no
    // new subagents can start for the rest of this turn". A session that reaches
    // the ceiling with nothing running has still had its fan-out capability
    // withdrawn for the turn, and a silent withdrawal is the same shape of lie
    // as a silently ignored spawn.
    const rig = await runTurnWithBackgroundChild(
      [{ type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' }],
      { startChild: false },
    )
    try {
      await waitUntil(() => budgetNotice(rig.managed.messages) !== undefined, 'budget notice appended')
      const notice = budgetNotice(rig.managed.messages)!
      expect(notice.content).toContain('No new subagents can start for the rest of this turn;')
      // No children, so no count is claimed.
      expect(notice.content).not.toContain('Stopped')
      expect(rig.stopped).toEqual([])
    } finally {
      rig.cleanup()
    }
  })

  it('says so even when the session has no child-session service at all', async () => {
    const rig = await runTurnWithBackgroundChild(
      [{ type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' }],
      { startChild: false, installService: false },
    )
    try {
      await waitUntil(() => budgetNotice(rig.managed.messages) !== undefined, 'budget notice appended')
      expect(budgetNotice(rig.managed.messages)!.content)
        .toContain('No new subagents can start for the rest of this turn;')
    } finally {
      rig.cleanup()
    }
  })

  it('names the children it could not stop and the ones it could not reach', async () => {
    // Both surviving buckets, all the way through to the sentence: a child is
    // NAMED, because "1 unreachable" leaves the user nothing to act on — and a
    // child that refused its stop is no more actionable unnamed.
    const rig = await runTurnWithBackgroundChild([{ type: 'complete', usage: usageFixture() }])
    try {
      const internals = rig.manager as unknown as {
        appendMaxBudgetUsdChildNotice(
          managed: unknown,
          outcome: { stopped: string[]; failed: string[]; residual: string[] },
        ): void
      }
      internals.appendMaxBudgetUsdChildNotice(rig.managed, {
        stopped: ['child-a'],
        failed: ['child-b'],
        residual: ['child-c', 'child-d'],
      })
      const content = budgetNotice(rig.managed.messages)!.content
      expect(content).toContain('Stopped 1 running subagent.')
      expect(content).toContain('Could not be stopped and may still be running: child-b.')
      expect(content).toContain('Unreachable and may still be running: child-c, child-d.')
      expect(content).toContain('No new subagents can start for the rest of this turn;')
    } finally {
      rig.cleanup()
    }
  })

  it('still forwards the parent terminal reason unchanged (regression pin)', async () => {
    const rig = await runTurnWithBackgroundChild([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ])
    try {
      // The behaviour P2.5 must not disturb: the parent's turn still ends with
      // this reason on the `complete` the renderer sees.
      //
      // `turn-terminal-reason.test.ts` already pinned this for a plain session.
      // What this row adds is the CONTEXT P2.5 created around it — a live
      // background child, a sweep, and a notice appended to the same transcript —
      // none of which may displace the reason on the way out.
      //
      // P3.18 · await the real turn-end signal instead of assuming the
      // fire-and-forget `complete` has already reached the sink: it is emitted
      // several awaits deep in SessionManager's `sendTurnEndEvent`, so a future
      // await before that emit must only delay it here, never let this read a
      // sink that has not received it yet.
      await waitUntil(() => lastComplete(rig.events) !== undefined, 'parent complete reached the event sink')
      expect(lastComplete(rig.events)?.terminalReason).toBe('max_budget_usd')
    } finally {
      rig.cleanup()
    }
  })
})
