/**
 * F1.605 (origin WJ-bm P-WJbm-1) — a turn a plan or sign-in handoff ends is recorded on the Pi goal it ran under.
 *
 * ## What was read, and what this file measures first
 *
 * A turn records its goal turn in two places. The turn's own `complete` records it with the turn's usage
 * (`processEvent`, the goal block). `onProcessingStopped` records it at 0 tokens and clears the reference; the goal
 * service keeps the FIRST record of a turn id, so the usage-bearing one wins when both fire. The plan and auth handoffs
 * (`beginAuthRequest`, `projectPiPlanSubmission`) lower the flag directly and never reach `onProcessingStopped`, so a
 * handed-off turn is recorded only if its generator still yields a `complete`. `BaseAgent.chat` says Pi does not: "Pi
 * returns without a `complete` on its abort paths (`source_activated`, plan submitted, auth request)". The chat loop
 * then exits "after explicit handoff/stop" and records nothing, and the next send clears the reference and captures its
 * own. So the goal's turn count and elapsed clock never see the handed-off turn.
 *
 * The rig is F1.573's (the real `sendMessage` loop, the REAL capability-turn gate, a recording goal service), driven
 * through the REAL handoffs. The generator ends the way the backend's own docblock says Pi does: no `complete`.
 *
 * ## CONTROLS
 *
 * - A turn that ends through its own `complete` is recorded once, with its usage.
 * - A handed-off turn whose generator DOES yield a `complete` is recorded once, with that usage: the loop's exit path
 *   must not add a 0-token record on top (it cannot: the `complete` branch returns before the exit path).
 * - The next turn's own record is its first, in every shape: the handed-off turn never charges the next turn's reference
 *   (F1.573's decision).
 *
 * The second shape is the same defect one step later: the next send can come while the handed-off generator still runs.
 * The send used to clear the handed-off turn's reference before capturing its own, so that turn was never recorded.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * How each turn's generator ends once released: its own `complete`, nothing (Pi's and codex's handoff shape), or a THROW
 * (nestor-cloud's: its aborted stream rejects out of `NestorCloudTurn.run`, and `BaseAgent.chat` has no catch).
 */
type Ending = AgentEvent | 'no-complete' | { throws: Error }

/**
 * F1.629 — `endsOnHandoff`: the backend's own interrupt releases the parked generator, as codex's and nestor-cloud's do
 * (`interruptForHandoff` is `BaseAgent`'s default, `forceAbort`: codex finishes its turn sink, so `queue.drain()` returns;
 * nestor-cloud aborts the turn signal, so the in-flight stream rejects). Unset, the test releases it (Pi's and claude's
 * shapes, and every next-send-first arm).
 */
async function rig(sessionId: string, endings: Ending[], options: { endsOnHandoff?: boolean; endsOnForceAbort?: boolean } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1605-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1605', name: 'F1.605', slug: 'f1605', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown> & {
    projectPiPlanSubmission(managed: unknown, planPath: string): Promise<void>
    beginAuthRequest(managed: unknown, request: Record<string, unknown>): Promise<void>
  }
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  // `acquireCapabilityTurn` is NOT stubbed: the real gate is the production window.
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1605-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  // An ACTIVE goal, as the goal service reports it; every `recordTurn` call is recorded.
  const goalRecords: GoalRecord[] = []
  const goalService = {
    snapshot: () => ({ goal: { id: 'goal-f1605', status: 'active' } }),
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
    // F1.1182 — `endsOnForceAbort`: Pi's own `forceAbort` completes the turn's queue, so the parked generator ends by itself.
    forceAbort: () => { if (options.endsOnForceAbort) generators.at(-1)?.release() },
    interruptForHandoff: () => { if (options.endsOnHandoff) generators.at(-1)?.release() },
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
      const ending = endings[index]!
      if (ending === 'no-complete') return
      if ('throws' in ending) throw ending.throws
      yield ending
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }

  const generator = async (i: number) => {
    for (let n = 0; n < 500 && !generators[i]; n++) await tick(10)
    if (!generators[i]) throw new Error(`generator ${i} never started`)
    return generators[i]!
  }
  const send = (text: string) => manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
  const typedManaged = managed as unknown as { isProcessing: boolean; processingGeneration: number; id: string }
  const goalTurnId = () => `${typedManaged.id}-goal-turn-${typedManaged.processingGeneration}`

  const handoffs = {
    /** `beginAuthRequest` for a dp sign-in, the card a gateway turn raises. */
    auth: () => internals.beginAuthRequest(managed, {
      type: 'dp', provider: 'dp', requestId: 'req-f1605', sessionId, sourceSlug: 'dp', sourceName: 'Developer Platform',
    }),
    /** The Pi plan projection (no projection id: the adjacent path, the one a plain SubmitPlan takes). */
    plan: () => {
      const planPath = join(stateRoot, 'plan.md')
      writeFileSync(planPath, '# Plan\n\n1. do the thing\n')
      return internals.projectPiPlanSubmission(managed, planPath)
    },
  }

  return { manager, managed: typedManaged, sent, generators, generator, send, goalRecords, goalTurnId, handoffs, cleanup: () => manager.cleanup() }
}

type Rig = Awaited<ReturnType<typeof rig>>

const USAGE = { inputTokens: 10, outputTokens: 5, costUsd: 0.5 }

/** Turn 1 starts and parks; the handoff ends it; its generator then ends as scripted. No next send. */
async function handedOffTurn(r: Rig, handoff: 'auth' | 'plan') {
  const first = r.send('first')
  await (await r.generator(0)).parked
  const turnId = r.goalTurnId()
  await r.handoffs[handoff]()
  expect(r.managed.isProcessing).toBe(false)
  r.generators[0]!.release()
  await first
  await tick(120)
  return turnId
}

describe('F1.605 — a handed-off turn is recorded on the goal once', () => {
  for (const handoff of ['auth', 'plan'] as const) {
    it(`THE DEFECT (${handoff} handoff, Pi's shape: the generator ends with no \`complete\`, no next send) — the turn is recorded once`, async () => {
      const r = await rig(`f1605-${handoff}-no-complete`, ['no-complete'])
      try {
        const turnId = await handedOffTurn(r, handoff)
        expect(r.goalRecords).toEqual([{ goalId: 'goal-f1605', turnId, tokens: 0, costUsd: 0 }])
      } finally {
        r.generators.forEach(generator => generator.release())
        r.cleanup()
      }
    })
  }

  it('CONTROL — a handed-off turn whose generator still yields a `complete` is recorded once, with that usage', async () => {
    const r = await rig('f1605-auth-with-complete', [{ type: 'complete', usage: USAGE } as AgentEvent])
    try {
      const turnId = await handedOffTurn(r, 'auth')
      expect(r.goalRecords).toEqual([{ goalId: 'goal-f1605', turnId, tokens: 15, costUsd: 0.5 }])
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('CONTROL — a turn that ends through its own `complete` is recorded once, with its usage', async () => {
    const r = await rig('f1605-own-complete', [{ type: 'complete', usage: USAGE } as AgentEvent])
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const turnId = r.goalTurnId()
      r.generators[0]!.release()
      await first
      await tick(120)
      expect(r.managed.isProcessing).toBe(false)
      // The `complete` records 15 tokens; `onProcessingStopped` then records the same turn at 0, and the real service keeps
      // the first (`lastTurnId`). Both calls are visible to this recording double; the FIRST is the one that counts.
      expect(r.goalRecords[0]).toEqual({ goalId: 'goal-f1605', turnId, tokens: 15, costUsd: 0.5 })
      expect(new Set(r.goalRecords.map(record => record.turnId))).toEqual(new Set([turnId]))
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('THE DEFECT (next send first) — the next send comes while the handed-off generator still runs: the handed-off turn is recorded once, and the next turn\'s first record is its own', async () => {
    const r = await rig('f1605-next-send-first', ['no-complete', { type: 'complete', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.25 } } as AgentEvent])
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const firstTurnId = r.goalTurnId()
      // The plan handoff: a pending dp sign-in refuses the next send by design (`dp-auth-pending`), a submitted plan does not.
      await r.handoffs.plan()
      const second = r.send('second')
      await tick(150)
      expect(r.managed.isProcessing).toBe(true)
      const secondTurnId = r.goalTurnId()
      r.generators[0]!.release()
      await first
      await (await r.generator(1)).parked
      await tick(120)
      r.generators[1]!.release()
      await second
      await tick(150)
      expect(r.managed.isProcessing).toBe(false)
      expect({
        firstTurnRecords: r.goalRecords.filter(record => record.turnId === firstTurnId),
        secondTurnFirstRecord: r.goalRecords.find(record => record.turnId === secondTurnId),
      }).toEqual({
        // At 0: its usage never arrived (Pi's shape), and a superseded usage charges no goal turn (F1.573).
        firstTurnRecords: [{ goalId: 'goal-f1605', turnId: firstTurnId, tokens: 0, costUsd: 0 }],
        secondTurnFirstRecord: { goalId: 'goal-f1605', turnId: secondTurnId, tokens: 27, costUsd: 0.25 },
      })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

/**
 * F1.629 (origin WJ-bx P-WJbx-4) — the two runtime shapes F1.605 did not drive, and the one it named as residue.
 *
 * Read, not guessed: neither backend overrides `interruptForHandoff`, so both handoffs reach `forceAbort`.
 * - codex (`CodexAgent.forceAbort`): `turn/interrupt` is sent unawaited and the turn sink is finished at once, so
 *   `queue.drain()` returns and the generator ends with NO `complete` (the interrupt's own `turn/completed` lands on a
 *   finished sink). Pi's shape, but ended by the handoff itself rather than later.
 * - nestor-cloud (`NestorCloudAgent.forceAbort`): the turn signal is aborted, so the in-flight stream REJECTS and
 *   `NestorCloudTurn.run` rethrows the abort (`turn.test.ts`, "flushes buffered text when the turn signal aborts
 *   mid-stream"; the real client wraps it as `stream-failed` with the same message). `BaseAgent.chat` has no catch, so
 *   the throw reaches the chat loop's `catch`, whose F1.395 predicate reads the lowered flag as "an ended turn" and
 *   used to end nothing and record nothing.
 */
describe('F1.629 — the codex and nestor-cloud handoff shapes record the handed-off turn once', () => {
  const abortError = () => new DOMException('The operation was aborted.', 'AbortError')
  const shapes: Array<{ name: string; ending: Ending }> = [
    { name: 'codex (the sink is finished: no `complete`)', ending: 'no-complete' },
    { name: 'nestor-cloud (the aborted stream throws `AbortError`)', ending: { throws: abortError() } },
  ]
  for (const shape of shapes) {
    for (const handoff of ['auth', 'plan'] as const) {
      it(`${shape.name}, ${handoff} handoff, no next send — the turn is recorded once, at 0`, async () => {
        const r = await rig(`f1629-${handoff}-${shape.name.split(' ')[0]}`, [shape.ending], { endsOnHandoff: true })
        try {
          const turnId = await handedOffTurn(r, handoff)
          expect(r.goalRecords).toEqual([{ goalId: 'goal-f1605', turnId, tokens: 0, costUsd: 0 }])
        } finally {
          r.generators.forEach(generator => generator.release())
          r.cleanup()
        }
      })
    }
  }

  it('a handed-off turn whose generator throws a NON-abort error (a torn stream) is recorded once too', async () => {
    const r = await rig('f1629-auth-torn', [{ throws: new Error('Nestor stream failed: socket closed') }], { endsOnHandoff: true })
    try {
      const turnId = await handedOffTurn(r, 'auth')
      expect(r.goalRecords).toEqual([{ goalId: 'goal-f1605', turnId, tokens: 0, costUsd: 0 }])
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('BOUNDARY — a throw that lands after the NEXT send started charges nothing to the next turn: the handed-off turn is recorded once, and the next turn\'s first record is its own', async () => {
    const r = await rig('f1629-late-throw', [{ throws: abortError() }, { type: 'complete', usage: { inputTokens: 20, outputTokens: 7, costUsd: 0.25 } } as AgentEvent])
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const firstTurnId = r.goalTurnId()
      await r.handoffs.plan()
      const second = r.send('second')
      await tick(150)
      expect(r.managed.isProcessing).toBe(true)
      const secondTurnId = r.goalTurnId()
      r.generators[0]!.release()
      await first
      await (await r.generator(1)).parked
      await tick(120)
      r.generators[1]!.release()
      await second
      await tick(150)
      expect(r.managed.isProcessing).toBe(false)
      expect({
        firstTurnRecords: r.goalRecords.filter(record => record.turnId === firstTurnId),
        secondTurnFirstRecord: r.goalRecords.find(record => record.turnId === secondTurnId),
      }).toEqual({
        firstTurnRecords: [{ goalId: 'goal-f1605', turnId: firstTurnId, tokens: 0, costUsd: 0 }],
        secondTurnFirstRecord: { goalId: 'goal-f1605', turnId: secondTurnId, tokens: 27, costUsd: 0.25 },
      })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

/**
 * F1.628 (origin WJ-bx P-WJbx-3; DN-269 measured the Pi side) — Pi now ends a handed-off turn with ONE `complete` carrying
 * the turn's usage and the handoff's own reason (`PiAgent.handoffUsageComplete`; the reason keeps `BaseAgent.chat` from
 * holding it for a model-skill continuation). It arrives after the handoff lowered the flag, in the same generation, and
 * the host folds it in as its usage only: the session totals and the goal turn take the usage, and the reason parks
 * nothing (it used to be parked on the session for whichever turn end ran next).
 */
describe('F1.628 — a handed-off turn\'s own `complete` is folded in as usage', () => {
  const HANDOFF_USAGE = { inputTokens: 150, outputTokens: 12, costUsd: 0.75, costReporting: 'reported' as const }
  const reasons = { auth: 'auth_request', plan: 'plan_submitted' } as const
  for (const handoff of ['auth', 'plan'] as const) {
    it(`${handoff} handoff — the totals and the goal turn take the usage, and no stop reason is parked`, async () => {
      const r = await rig(`f1628-${handoff}`, [{ type: 'complete', usage: HANDOFF_USAGE, terminalReason: reasons[handoff] } as AgentEvent])
      try {
        const turnId = await handedOffTurn(r, handoff)
        const managed = r.managed as unknown as { tokenUsage?: { outputTokens: number; costUsd: number; inputTokens: number }; turnTerminalReason?: string }
        expect({
          totals: { inputTokens: managed.tokenUsage?.inputTokens, outputTokens: managed.tokenUsage?.outputTokens, costUsd: managed.tokenUsage?.costUsd },
          goalRecords: r.goalRecords,
          parkedReason: managed.turnTerminalReason,
        }).toEqual({
          totals: { inputTokens: 150, outputTokens: 12, costUsd: 0.75 },
          goalRecords: [{ goalId: 'goal-f1605', turnId, tokens: 162, costUsd: 0.75 }],
          parkedReason: undefined,
        })
      } finally {
        r.generators.forEach(generator => generator.release())
        r.cleanup()
      }
    })
  }

  it('BOUNDARY — a turn the host has NOT ended keeps its own `complete` whole: its reason reaches the turn end', async () => {
    const r = await rig('f1628-live-reason', [{ type: 'complete', usage: HANDOFF_USAGE, terminalReason: 'max_agent_turns' } as AgentEvent])
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.generators[0]!.release()
      await first
      await tick(150)
      expect(r.managed.isProcessing).toBe(false)
      const ends = r.sent.filter(event => event.type === 'complete') as Array<{ terminalReason?: string }>
      expect(ends.map(event => event.terminalReason)).toEqual(['max_agent_turns'])
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

/**
 * F1.1162 (origin DN-270) — a user Stop latches Pi's turn the way a handoff does (`forceAbort(UserStop)`), so Pi now ends a
 * stopped turn's drain with ONE `complete` carrying the calls made before the Stop, stamped `user_stop`
 * (`PiAgent.handoffUsageComplete`). `cancelProcessing` already ended that turn (`interrupted` sent) but lowers the flag only
 * at the loop exit, so the complete arrives with the flag still up: the host folds it in as usage and goal turn only, and
 * the turn still ends interrupted — no completed outcome, no parked reason for the next turn, no goal continuation.
 */
describe('F1.1162 — a stopped Pi turn\'s own `complete` is folded in as usage, and the turn still ends interrupted', () => {
  const STOP_USAGE = { inputTokens: 150, outputTokens: 12, costUsd: 0.75, costReporting: 'reported' as const }
  type Observed = { tokenUsage?: { outputTokens: number; costUsd: number; inputTokens: number }; turnTerminalReason?: string; piAgentViewOutcome?: string }

  /** Turn 1 starts and parks; the user presses Stop; its generator then ends as scripted. */
  async function stoppedTurn(r: Rig, whileRunning?: () => void) {
    const first = r.send('first')
    await (await r.generator(0)).parked
    const turnId = r.goalTurnId()
    whileRunning?.()
    await r.manager.cancelProcessing(r.managed.id, false, 'ws-f1605')
    expect(r.managed.isProcessing).toBe(true) // lowered at the loop exit, after the drain
    r.generators[0]!.release()
    await first
    await tick(150)
    expect(r.managed.isProcessing).toBe(false)
    return turnId
  }
  const observe = (r: Rig) => {
    const managed = r.managed as unknown as Observed
    return {
      totals: managed.tokenUsage && { inputTokens: managed.tokenUsage.inputTokens, outputTokens: managed.tokenUsage.outputTokens, costUsd: managed.tokenUsage.costUsd },
      outcome: managed.piAgentViewOutcome,
      parkedReason: managed.turnTerminalReason,
      interrupted: r.sent.filter(event => event.type === 'interrupted').length,
      endReasons: (r.sent.filter(event => event.type === 'complete') as Array<{ terminalReason?: string }>).map(event => event.terminalReason),
    }
  }

  it('THE DEFECT (Pi) — the totals and the goal turn take the stopped calls\' usage once, and the turn ends stopped', async () => {
    const r = await rig('f1162-pi-stop', [{ type: 'complete', usage: STOP_USAGE, terminalReason: 'user_stop' } as AgentEvent])
    try {
      const turnId = await stoppedTurn(r)
      expect(observe(r)).toEqual({
        totals: { inputTokens: 150, outputTokens: 12, costUsd: 0.75 },
        outcome: 'stopped',
        parkedReason: undefined,
        interrupted: 1,
        endReasons: [undefined],
      })
      // The usage-bearing record is the turn's FIRST (the real service keeps it); the loop exit's 0 is the same turn id.
      expect(r.goalRecords[0]).toEqual({ goalId: 'goal-f1605', turnId, tokens: 162, costUsd: 0.75 })
      expect(new Set(r.goalRecords.map(record => record.turnId))).toEqual(new Set([turnId]))
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('BOUNDARY (Pi) — a Stop before any call reported usage adds nothing, and the turn ends stopped as before', async () => {
    const r = await rig('f1162-pi-stop-early', ['no-complete'])
    try {
      const turnId = await stoppedTurn(r)
      expect(observe(r)).toEqual({ totals: undefined, outcome: 'stopped', parkedReason: undefined, interrupted: 1, endReasons: [undefined] })
      expect(r.goalRecords).toEqual([{ goalId: 'goal-f1605', turnId, tokens: 0, costUsd: 0 }])
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  /**
   * F1.1182 — the host's OTHER Stop: a strict drain (agent-view Stop, runtime switch, rewind, project mutation, trust block,
   * root revoke, deletion, app exit, a parent's child stop) calls `forceAbort(UserStop)` and never sets `stopRequested`, and
   * lowers the flag only at its own end. Driven through the real `strictDrainPiSession`. The goal continuation is counted at
   * its CALL, which only the completion path makes (its own mutation-boundary guard would refuse it during the drain).
   */
  async function drainedTurn(r: Rig) {
    const internals = r.manager as unknown as { strictDrainPiSession(managed: unknown, reason: string): Promise<void>; schedulePiGoalContinuation: (managed: unknown) => void }
    let continuations = 0
    internals.schedulePiGoalContinuation = () => { continuations += 1 }
    const first = r.send('first')
    await (await r.generator(0)).parked
    const turnId = r.goalTurnId()
    await internals.strictDrainPiSession(r.managed, 'agent view stop')
    await first
    await tick(150)
    expect(r.managed.isProcessing).toBe(false)
    return { turnId, continuations: () => continuations }
  }

  it('THE DEFECT (Pi, strict drain) — the stopped calls\' usage is folded in, the turn ends stopped, and no goal continuation is armed', async () => {
    const r = await rig('f1182-pi-drain', [{ type: 'complete', usage: STOP_USAGE, terminalReason: 'user_stop' } as AgentEvent], { endsOnForceAbort: true })
    try {
      const { turnId, continuations } = await drainedTurn(r)
      const seen = observe(r)
      expect({ totals: seen.totals, outcome: seen.outcome, parkedReason: seen.parkedReason, endReasons: seen.endReasons, continuations: continuations() })
        .toEqual({ totals: { inputTokens: 150, outputTokens: 12, costUsd: 0.75 }, outcome: 'stopped', parkedReason: undefined, endReasons: [undefined], continuations: 0 })
      expect(r.goalRecords[0]).toEqual({ goalId: 'goal-f1605', turnId, tokens: 162, costUsd: 0.75 })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('BOUNDARY (Pi, strict drain) — a drain before any call reported usage adds nothing, and the turn ends stopped as before', async () => {
    const r = await rig('f1182-pi-drain-early', ['no-complete'], { endsOnForceAbort: true })
    try {
      const { turnId, continuations } = await drainedTurn(r)
      const seen = observe(r)
      expect({ totals: seen.totals, outcome: seen.outcome, parkedReason: seen.parkedReason, endReasons: seen.endReasons, continuations: continuations() })
        .toEqual({ totals: undefined, outcome: 'stopped', parkedReason: undefined, endReasons: [undefined], continuations: 0 })
      expect(r.goalRecords).toEqual([{ goalId: 'goal-f1605', turnId, tokens: 0, costUsd: 0 }])
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  // F1.1239 — the completion path still takes claude's `user_stop` complete (its usage, its reason on the turn end), but a
  // turn the host stopped now ends `interrupted` there, so the outcome is `stopped` (it was `completed`, which re-armed a goal).
  it('CONTROL (claude) — claude\'s `user_stop` complete still ends its stopped turn through the completion path, as stopped', async () => {
    const r = await rig('f1162-claude-stop', [{ type: 'complete', usage: STOP_USAGE, terminalReason: 'user_stop' } as AgentEvent])
    try {
      // The rig's session resolves Pi (no connection); from the Stop on, it reads as a claude one.
      await stoppedTurn(r, () => { (r.manager as unknown as { resolveManagedProvider: () => string }).resolveManagedProvider = () => 'anthropic' })
      expect(observe(r)).toMatchObject({
        totals: { inputTokens: 150, outputTokens: 12, costUsd: 0.75 },
        outcome: 'stopped',
        interrupted: 1,
        endReasons: ['user_stop'],
      })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

/**
 * F1.1239 (origin: the final sitting, SIT2-b, DN-284's proposal 2) — a user Stop on a Claude session with an active goal
 * did not stop it: the SDK settles a stopped turn with a `complete` (`user_stop`), the chat loop took it down the completion
 * path as `onProcessingStopped('complete')`, the outcome read `completed`, and `schedulePiGoalContinuation` (which refuses
 * only a `stopped` outcome) dispatched "Continue active goal" about 8 s later, running tools after the user's Stop.
 *
 * Native posture: Claude Code's own `/goal` is "a wrapper around a session-scoped prompt-based Stop hook" (goal.md), and the
 * Stop hook "Does not run if the stoppage occurred due to a user interrupt" (hooks.md#stop). So a user's Stop ends the goal
 * loop for that run; the goal stays set and resumes after the user's next message — the posture Pi has had since F1.1162.
 *
 * Driven through the REAL `schedulePiGoalContinuation` (only the goal service's evaluation and the settlement read are
 * stubbed), so both re-arm doors are measured: the turn end's own, and a later one (a background task settling) that the
 * `stopped` outcome must refuse until the user sends.
 */
describe('F1.1239 — a host Stop on a claude goal session ends the goal loop for that run', () => {
  const STOP_USAGE = { inputTokens: 150, outputTokens: 12, costUsd: 0.75, costReporting: 'reported' as const }

  async function claudeGoalRig(sessionId: string, endings: Ending[]) {
    const r = await rig(sessionId, endings)
    const internals = r.manager as unknown as Record<string, unknown> & {
      managedKey(managed: unknown): string
      piGoalServices: Map<string, Record<string, unknown>>
      schedulePiGoalContinuation(managed: unknown): void
    }
    const goalService = internals.piGoalServices.get(internals.managedKey(r.managed))!
    let prompts = 0
    Object.assign(goalService, {
      evaluateAtSettlement: async () => ({ goal: { id: 'goal-f1605', revision: 3, status: 'active' } }),
      safeSnapshot: () => ({ id: 'goal-f1605', revision: 3, status: 'active' }),
      canContinue: async () => true,
      // One continuation at most, so a continued turn's own end does not chain another.
      continuationPrompt: () => (prompts++ === 0 ? 'Continue working toward the active goal.' : undefined),
    })
    internals.getPiHarnessRuntimeSnapshot = async () => ({ settlement: { settled: true } })
    const asClaude = () => { internals.resolveManagedProvider = () => 'anthropic' }
    const continuations = () => (r.managed as unknown as { messages: Array<{ role: string; content: string }> }).messages
      .filter(message => message.role === 'user' && message.content.startsWith('Continue active goal')).length
    return { ...r, asClaude, continuations, rearm: () => internals.schedulePiGoalContinuation(r.managed) }
  }

  it('THE DEFECT (claude, user Stop) — no continuation turn starts after the Stop, at the turn end or at a later re-arm', async () => {
    const r = await claudeGoalRig('f1239-claude-stop', [{ type: 'complete', usage: STOP_USAGE, terminalReason: 'user_stop' } as AgentEvent])
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.asClaude()
      await r.manager.cancelProcessing(r.managed.id, false, 'ws-f1605')
      r.generators[0]!.release()
      await first
      await tick(300)
      expect(r.managed.isProcessing).toBe(false)
      expect((r.managed as unknown as { piAgentViewOutcome?: string }).piAgentViewOutcome).toBe('stopped')
      // A background task settling re-arms through the same gate: still nothing until the user sends.
      r.rearm()
      await tick(300)
      expect({ generators: r.generators.length, continuations: r.continuations(), processing: r.managed.isProcessing })
        .toEqual({ generators: 1, continuations: 0, processing: false })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  /**
   * F1.1239 follow-up (CR-4 verifier) — the host's other end of a Stop: the 5 s safety timer in `cancelProcessing` ends the
   * turn as `onProcessingStopped('timeout')` when the claude CLI's interrupt receipt is slow (the sitting measured ~5.7 s).
   * That turn was a Stop too, so it must refuse a later re-arm (a background task settling) until the user sends. The timer
   * is shortened only for the `cancelProcessing` call (its 5000 ms delay → 20 ms); the late `user_stop` complete arrives after.
   */
  it('THE DEFECT (claude, Stop past the safety timer) — the timer\'s end is a Stop: no continuation at a later re-arm', async () => {
    const r = await claudeGoalRig('f1239-claude-stop-timer', [{ type: 'complete', usage: STOP_USAGE, terminalReason: 'user_stop' } as AgentEvent])
    const realSetTimeout = globalThis.setTimeout
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.asClaude()
      globalThis.setTimeout = ((handler: () => void, ms?: number, ...rest: unknown[]) =>
        realSetTimeout(handler, ms === 5000 ? 20 : ms, ...rest)) as typeof setTimeout
      try {
        await r.manager.cancelProcessing(r.managed.id, false, 'ws-f1605')
      } finally {
        globalThis.setTimeout = realSetTimeout
      }
      for (let n = 0; n < 100 && r.managed.isProcessing; n++) await tick(10)
      expect(r.managed.isProcessing).toBe(false) // the safety timer ended it; the generator is still parked
      expect((r.managed as unknown as { piAgentViewOutcome?: string }).piAgentViewOutcome).toBe('stopped')
      r.generators[0]!.release() // the late `user_stop` complete is folded as usage only
      await first
      await tick(150)
      r.rearm()
      await tick(300)
      expect({ generators: r.generators.length, continuations: r.continuations(), processing: r.managed.isProcessing })
        .toEqual({ generators: 1, continuations: 0, processing: false })
    } finally {
      globalThis.setTimeout = realSetTimeout
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('BOUNDARY (claude, no Stop) — a turn that completes normally still continues the active goal', async () => {
    const r = await claudeGoalRig('f1239-claude-complete', [
      { type: 'complete', usage: STOP_USAGE } as AgentEvent,
      { type: 'complete', usage: STOP_USAGE } as AgentEvent,
    ])
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.asClaude()
      r.generators[0]!.release()
      await first
      await (await r.generator(1)).parked
      expect(r.continuations()).toBe(1)
      r.generators[1]!.release()
      for (let n = 0; n < 100 && r.managed.isProcessing; n++) await tick(10)
      expect(r.managed.isProcessing).toBe(false)
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

/**
 * F1.1274 (origin lane CR-4, 2026-10-01; the residue F1.1239's own commit named) — the strict drain's OTHER Stop shape. The
 * non-Pi `strictDrainSessionForMutation` ends a live claude turn with `forceAbort(UserStop)` and lowers the flag itself
 * (`setProcessing(false)`), never reaching `onProcessingStopped`; the boundary is RELEASED when the mutation finishes, and
 * the claude generator's late `user_stop` complete lands only then. The fold reads `stopRequested` (reset by the drain) and
 * the boundary (gone), so the turn folded as `complete` — outcome `completed` — and `schedulePiGoalContinuation` re-armed a
 * goal on a session the person had just rewound or switched. The drain is the authority that stopped the turn: it stamps the
 * `stopped` outcome, and the fold reads it beside the boundary.
 *
 * Driven through the REAL `strictDrainSessionForMutation` (its teardown helpers stubbed — the behaviour under test is the
 * drain's flag and outcome, the fold, and the re-arm gate), in the same generation, with the generator released only after
 * the drain has returned.
 */
describe('F1.1274 — the strict drain\'s late claude `complete` is still a Stop', () => {
  const STOP_USAGE = { inputTokens: 150, outputTokens: 12, costUsd: 0.75, costReporting: 'reported' as const }

  async function drainedClaudeGoalRig(sessionId: string, ending: Ending) {
    const r = await rig(sessionId, [ending])
    const internals = r.manager as unknown as Record<string, unknown> & {
      managedKey(managed: unknown): string
      piGoalServices: Map<string, Record<string, unknown>>
      schedulePiGoalContinuation(managed: unknown): void
      getPiHarnessRuntimeSnapshot(...args: unknown[]): unknown
      resolveManagedProvider(managed: unknown): string
      strictDrainSessionForMutation(managed: unknown, reason: string, boundaryHeld?: boolean): Promise<void>
      disposeManagedAgentRuntime(...args: unknown[]): Promise<void>
      heldRuntimeCards(...args: unknown[]): unknown[]
      withdrawStoppedRuntimeCards(...args: unknown[]): void
    }
    // Teardown helpers outside the behaviour under test; the real dispose is what clears
    // `managed.agent`, so the stub clears it the same way the drain's residual check demands.
    internals.disposeManagedAgentRuntime = async () => { (r.managed as unknown as { agent?: unknown }).agent = undefined }
    internals.heldRuntimeCards = () => []
    internals.withdrawStoppedRuntimeCards = () => {}
    const goalService = internals.piGoalServices.get(internals.managedKey(r.managed))!
    let prompts = 0
    Object.assign(goalService, {
      evaluateAtSettlement: async () => ({ goal: { id: 'goal-f1605', revision: 3, status: 'active' } }),
      safeSnapshot: () => ({ id: 'goal-f1605', revision: 3, status: 'active' }),
      canContinue: async () => true,
      continuationPrompt: () => (prompts++ === 0 ? 'Continue working toward the active goal.' : undefined),
    })
    internals.getPiHarnessRuntimeSnapshot = async () => ({ settlement: { settled: true } })
    const continuations = () => (r.managed as unknown as { messages: Array<{ role: string; content: string }> }).messages
      .filter(message => message.role === 'user' && message.content.startsWith('Continue active goal')).length
    return { ...r, internals, continuations, rearm: () => internals.schedulePiGoalContinuation(r.managed) }
  }

  it('THE DEFECT — the drain lowered the flag and released the boundary; the late `user_stop` complete still ends stopped and no continuation re-arms', async () => {
    const r = await drainedClaudeGoalRig('f1274-claude-drain', { type: 'complete', usage: STOP_USAGE, terminalReason: 'user_stop' } as AgentEvent)
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.internals.resolveManagedProvider = () => 'anthropic'
      // The drain: forceAbort, dispose, the flag down, the boundary released — and the generator NOT yet released.
      await r.internals.strictDrainSessionForMutation(r.managed, 'conversation rewind')
      expect(r.managed.isProcessing).toBe(false)
      // The claude generator drains after the abort and yields its `user_stop` complete now — after the boundary is gone.
      r.generators[0]!.release()
      await first
      await tick(300)
      expect((r.managed as unknown as { piAgentViewOutcome?: string }).piAgentViewOutcome).toBe('stopped')
      r.rearm()
      await tick(300)
      expect({ generators: r.generators.length, continuations: r.continuations(), processing: r.managed.isProcessing })
        .toEqual({ generators: 1, continuations: 0, processing: false })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('BOUNDARY — the same drain whose generator ends with no `complete` ends stopped too', async () => {
    const r = await drainedClaudeGoalRig('f1274-claude-drain-quiet', 'no-complete')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.internals.resolveManagedProvider = () => 'anthropic'
      await r.internals.strictDrainSessionForMutation(r.managed, 'conversation rewind')
      expect(r.managed.isProcessing).toBe(false)
      r.generators[0]!.release()
      await first
      await tick(300)
      expect((r.managed as unknown as { piAgentViewOutcome?: string }).piAgentViewOutcome).toBe('stopped')
      r.rearm()
      await tick(300)
      expect({ generators: r.generators.length, continuations: r.continuations(), processing: r.managed.isProcessing })
        .toEqual({ generators: 1, continuations: 0, processing: false })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})
