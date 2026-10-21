/**
 * F1.529 (origin the 1.41.0 review, finding E-host-sessions-hooks-1) — a `complete`
 * that an ENDED turn's generator yields late ends only that ended turn: it takes
 * no steer and ends nothing once the NEXT turn has the generation.
 *
 * ## What was read, and what this file measures first
 *
 * `sendMessage`'s chat loop ends its turn from four places. F1.395 gave the
 * `catch` the predicate its two `finally` blocks read (`processingGeneration`
 * still the loop's own); the `complete` branch, which a backend reaches far more
 * often, had only `if (!managed.isProcessing)`. Once the host has ended a turn —
 * the 5 s stop safety timer after a Stop whose generator hangs, or a plan / auth
 * handoff, each of which lowers the flag — the next send raises the flag and
 * bumps the generation BEFORE it waits on the capability-turn gate the old loop
 * still holds. The old generator's trailing `complete` then saw `isProcessing`
 * true, took the shared agent's pending steers (F1.238's `recoverPendingSteers`)
 * and called `onProcessingStopped(…, 'complete')`: the NEXT turn's flag went
 * down, the renderer got a `complete` for it, its turn-bound cards were declined
 * (F1.263), and when it then reached `agent.chat` every stream event it produced
 * was dropped as "after the turn ended" (F1.165) and its own `complete` ended
 * nothing.
 *
 * The rig uses the REAL capability-turn gate (F1.395's rig stubs it), because
 * the gate is what makes the window certain in production: the next turn waits
 * there, processing, for exactly as long as the old generator drains.
 *
 * ## CONTROL
 *
 * The loop's OWN `complete` still ends its turn, exactly once, and still
 * recovers the steers its backend holds.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// The timer arm waits out the host's real 5 s stop safety timer.
setDefaultTimeout(30_000)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

interface Steer { message: string; messageId?: string }

async function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1529-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1529', name: 'F1.529', slug: 'f1529', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
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
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1529-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  /** The steers the shared backend holds (Claude's FIFO, as far as the host can see it), and every take. */
  const heldSteers: Steer[] = []
  const takes: number[] = []
  /** One gate per generator: the test decides when each parks and completes. */
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
    // A generator that does not stop when asked: the case the safety timer exists for.
    forceAbort: () => {},
    interruptForHandoff: () => {},
    takePendingSteers: () => { takes.push(Date.now()); return heldSteers.splice(0) },
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
      // The trailing `complete` a backend sends after an interrupt, too.
      yield { type: 'complete' } as AgentEvent
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }

  /** `sendMessage` reaches `agent.chat()` several awaits after it is called: wait for the i-th generator to exist. */
  const generator = async (i: number) => {
    for (let n = 0; n < 500 && !generators[i]; n++) await tick(10)
    if (!generators[i]) throw new Error(`generator ${i} never started`)
    return generators[i]!
  }
  const send = (text: string) => manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
  return {
    manager,
    internals,
    managed: managed as unknown as { isProcessing: boolean; processingGeneration: number; messageQueue: unknown[]; id: string },
    workspace, sent, heldSteers, takes, generators, generator, send,
    cleanup: () => manager.cleanup(),
  }
}

/** The renderer-facing turn ends the host sent after the given index. */
const turnEndsAfter = (sent: SessionEvent[], index: number) =>
  sent.slice(index).map(event => event.type).filter(type => type === 'complete' || type === 'interrupted' || type === 'error')

type Rig = Awaited<ReturnType<typeof rig>>

/**
 * The shared tail of both DEFECT arms: the old turn is already ended by the host
 * and the next one has been sent (processing, waiting on the capability gate the
 * old loop holds). The old generator now yields its trailing `complete`.
 */
async function staleCompleteAfterNextTurnStarted(r: Rig, first: Promise<void>) {
  const second = r.send('second')
  await tick(150)
  expect(r.managed.isProcessing).toBe(true)
  const generationOfSecond = r.managed.processingGeneration
  // A steer the backend holds for the running turn (the user steered while it waited).
  r.heldSteers.push({ message: 'also check the tests', messageId: 'steer-for-second' })
  const index = r.sent.length
  const takesBefore = r.takes.length

  r.generators[0]!.release()
  await first
  // The old loop has let go of the capability gate: the next turn reaches its chat.
  await (await r.generator(1)).parked
  await tick(120)

  expect({
    processing: r.managed.isProcessing,
    generation: r.managed.processingGeneration,
    turnEndsSent: turnEndsAfter(r.sent, index),
    steersTaken: r.takes.length - takesBefore,
    steersStillHeld: r.heldSteers.length,
  }).toEqual({ processing: true, generation: generationOfSecond, turnEndsSent: [], steersTaken: 0, steersStillHeld: 1 })

  // The next turn delivers its steer (at a tool boundary, in the real backend), then ends by itself, once.
  r.heldSteers.splice(0)
  r.generators[1]!.release()
  await second
  await tick(120)
  expect(r.managed.isProcessing).toBe(false)
  expect(turnEndsAfter(r.sent, index)).toEqual(['complete'])
}

describe('F1.529 — a late `complete` from an ENDED turn does not end the NEXT turn', () => {
  it('THE DEFECT (stop timer) — Stop, the 5 s timer ends the turn, the next turn starts, then the old generator completes', async () => {
    const r = await rig('f1529-stop-timer')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      // The first generator is stuck: the host's safety timer ends its turn.
      await tick(5_300)
      expect(r.managed.isProcessing).toBe(false)
      await staleCompleteAfterNextTurnStarted(r, first)
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('THE DEFECT (handoff shape) — the host lowers the flag the way the plan / auth handoffs do, the next turn starts, then the old generator completes', async () => {
    const r = await rig('f1529-handoff')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      // What `beginAuthRequest` and the two plan handoffs do to the flag (F1.214: before their awaits).
      ;(r.internals.setProcessing as (managed: unknown, value: boolean) => void).call(r.manager, r.managed, false)
      expect(r.managed.isProcessing).toBe(false)
      await staleCompleteAfterNextTurnStarted(r, first)
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

describe('F1.529 — CONTROL: the loop\'s own `complete` still ends its turn and recovers its steers', () => {
  it('one turn, its generator completes → one `complete`, the flag is down, its backend\'s steers are taken once', async () => {
    const r = await rig('f1529-own-complete')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const index = r.sent.length
      const takesBefore = r.takes.length
      r.generators[0]!.release()
      await first
      await tick(120)
      expect({
        processing: r.managed.isProcessing,
        turnEndsSent: turnEndsAfter(r.sent, index),
        steersTaken: r.takes.length - takesBefore,
        steersStillHeld: r.heldSteers.length,
      }).toEqual({ processing: false, turnEndsSent: ['complete'], steersTaken: 1, steersStillHeld: 0 })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})
