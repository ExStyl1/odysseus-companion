/**
 * F1.574 (origin WJ-as P-WJas-2) — a Stop pressed while a turn waits at the capability-turn gate stops that turn's model
 * call.
 *
 * ## What was read, and what this file measures first
 *
 * `sendMessage` raises the flag and bumps the generation, then awaits `acquireCapabilityTurn`, which the previous loop
 * holds while its generator drains. That happens after the host ended the previous turn with the 5 s stop timer or a
 * plan / auth handoff (F1.529's window). A Stop pressed during that wait finds the turn processing. It sets
 * `stopRequested`, sends `interrupted`, and calls `forceAbort` on an agent that has no chat for this turn yet. Nothing
 * between the gate and `agent.chat` read the Stop again. So once the old loop let go, the stopped turn still made its
 * model call, tools included, and F1.165 dropped its stream. Two cases, both measured here by counting `agent.chat`
 * calls:
 * - the drain ends within 5 s: the stopped turn runs to its own `complete`;
 * - the drain takes longer: the Stop's own 5 s timer ends the turn first, and the chat is a ghost nobody sees.
 *
 * A notification group the stopped send had FOLDED goes back and waits for the next send, F1.530's hold. It is not
 * flushed as a turn of its own right after the Stop.
 *
 * The rig is the F1.529 rig (`stale-complete-ends-only-its-turn.test.ts`): the real `sendMessage` loop and the REAL
 * capability-turn gate.
 *
 * ## A stale Stop, found while fixing this (fixed in the same commit)
 *
 * A Stop that a plan / auth handoff overtook left `stopRequested` set: the handoff lowers the flag and never reaches
 * `onProcessingStopped`, the only place that cleared it. The next turn then started with it still set, so F1.165 dropped
 * that turn's whole stream until its own `complete`, and the check this row adds would have ended it unstarted. A turn
 * now clears it when it raises the flag, the way it already clears `turnTerminalReason`.
 *
 * ## CONTROLS
 *
 * - A Stop of a turn already in its chat is unchanged: one chat, `forceAbort` delivered to it, the drain ends the turn
 *   (`interrupted`, then `complete`).
 * - The next turn after a Stop that a handoff overtook calls the model, streams, and ends with `complete` alone.
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

async function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1574-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1574', name: 'F1.574', slug: 'f1574', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
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
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1574-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  /** Every `agent.chat` call (the model call this row is about) and every `forceAbort`. */
  const chats: string[] = []
  const aborts: number[] = []
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
    forceAbort: () => { aborts.push(generators.length) },
    interruptForHandoff: () => {},
    takePendingSteers: () => [],
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* (message: string) {
      chats.push(message)
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
    internals,
    managed: managed as unknown as { isProcessing: boolean; processingGeneration: number; stopRequested?: boolean; wasInterrupted?: boolean; pendingTaskNotifications?: string[]; id: string },
    workspace, sent, chats, aborts, generators, generator, send,
    cleanup: () => manager.cleanup(),
  }
}

type Rig = Awaited<ReturnType<typeof rig>>

const turnEndsAfter = (sent: SessionEvent[], index: number) =>
  sent.slice(index).map(event => event.type).filter(type => type === 'complete' || type === 'interrupted' || type === 'error')

/** Turn 1 parks in its chat; the host lowers the flag the way the plan / auth handoffs do; turn 2 is sent and waits at the gate turn 1's loop holds. */
async function secondTurnWaitingAtTheGate(r: Rig) {
  const first = r.send('first')
  await (await r.generator(0)).parked
  ;(r.internals.setProcessing as (managed: unknown, value: boolean) => void).call(r.manager, r.managed, false)
  const second = r.send('second')
  await tick(150)
  expect({ processing: r.managed.isProcessing, chats: r.chats.length }).toEqual({ processing: true, chats: 1 })
  return { first, second }
}

describe('F1.574 — a Stop while the turn waits at the capability-turn gate stops its model call', () => {
  it('THE DEFECT (drain within 5 s) — Stop turn 2 at the gate, turn 1 drains: turn 2 must not call the model', async () => {
    const r = await rig('f1574-drain')
    try {
      const { first, second } = await secondTurnWaitingAtTheGate(r)
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      r.generators[0]!.release()
      await first
      await tick(300)
      // Whatever the defect started, let it finish so the send settles.
      r.generators.slice(1).forEach(generator => generator.release())
      await second
      await tick(150)
      expect({
        chats: r.chats,
        processing: r.managed.isProcessing,
        stopRequested: r.managed.stopRequested,
        // The interruption note is still owed to the next prompt: the stopped turn consumed nothing.
        wasInterrupted: r.managed.wasInterrupted,
        turnEndsSent: turnEndsAfter(r.sent, index),
      }).toEqual({ chats: ['first'], processing: false, stopRequested: false, wasInterrupted: true, turnEndsSent: ['interrupted', 'complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('a notification group turn 2 FOLDED goes back and is held for the next send (F1.530\'s contract), never flushed as a turn of its own', async () => {
    const r = await rig('f1574-folded')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      ;(r.internals.setProcessing as (managed: unknown, value: boolean) => void).call(r.manager, r.managed, false)
      // Pending while no turn is processing: turn 2's send folds it as model-only context (rule 3).
      const group = ['<task-notification>F1.574 monitor tick</task-notification>']
      r.managed.pendingTaskNotifications = [...group]
      const second = r.send('second')
      await tick(150)
      // The send drained it (the cast undoes the narrowing of the assignment above).
      expect({ processing: r.managed.isProcessing, pending: r.managed.pendingTaskNotifications as string[] | undefined }).toEqual({ processing: true, pending: undefined })
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      r.generators[0]!.release()
      await first
      await tick(300)
      r.generators.slice(1).forEach(generator => generator.release())
      await second
      await tick(300)
      expect({
        chats: r.chats,
        processing: r.managed.isProcessing,
        pending: r.managed.pendingTaskNotifications,
        turnEndsSent: turnEndsAfter(r.sent, index),
      }).toEqual({ chats: ['first'], processing: false, pending: group, turnEndsSent: ['interrupted', 'complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('THE DEFECT (drain past 5 s) — the Stop\'s own timer ends turn 2 at the gate; when turn 1 drains, turn 2 must not make a ghost model call', async () => {
    const r = await rig('f1574-timer')
    try {
      const { first, second } = await secondTurnWaitingAtTheGate(r)
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      await tick(5_300)
      expect(r.managed.isProcessing).toBe(false)
      r.generators[0]!.release()
      await first
      await tick(300)
      r.generators.slice(1).forEach(generator => generator.release())
      await second
      await tick(150)
      expect({ chats: r.chats, processing: r.managed.isProcessing, turnEndsSent: turnEndsAfter(r.sent, index) })
        .toEqual({ chats: ['first'], processing: false, turnEndsSent: ['interrupted', 'complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

describe('F1.574 — CONTROL: a Stop of a turn already in its chat is unchanged', () => {
  it('a Stop that a handoff overtook does not stop the NEXT turn: it calls the model, streams, and ends with `complete` alone', async () => {
    const r = await rig('f1574-stale-stop')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      // The drain delivers a plan / auth handoff: the flag goes down and `onProcessingStopped` never runs.
      ;(r.internals.setProcessing as (managed: unknown, value: boolean) => void).call(r.manager, r.managed, false)
      r.generators[0]!.release()
      await first
      await tick(150)
      expect({ processing: r.managed.isProcessing, stopRequested: r.managed.stopRequested }).toEqual({ processing: false, stopRequested: true })
      const index = r.sent.length
      const second = r.send('second')
      await (await r.generator(1)).parked
      r.generators[1]!.release()
      await second
      await tick(150)
      expect({
        // The first line: the rest is the interruption note the Stop leaves for the next prompt (`wasInterrupted`).
        chats: r.chats.map(chat => chat.split('\n')[0]),
        processing: r.managed.isProcessing,
        streamed: r.sent.slice(index).some(event => event.type === 'text_delta'),
        turnEndsSent: turnEndsAfter(r.sent, index),
      }).toEqual({ chats: ['first', 'second'], processing: false, streamed: true, turnEndsSent: ['complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('one chat, the abort reaches it, the drain ends the turn: `interrupted` then `complete`', async () => {
    const r = await rig('f1574-in-chat')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      r.generators[0]!.release()
      await first
      await tick(150)
      expect({ chats: r.chats, aborts: r.aborts, processing: r.managed.isProcessing, turnEndsSent: turnEndsAfter(r.sent, index) })
        .toEqual({ chats: ['first'], aborts: [1], processing: false, turnEndsSent: ['interrupted', 'complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})
