/**
 * F1.530 (origin the 1.41.0 review, finding E-host-sessions-hooks-2) — a Stop
 * that leaves the notification queue non-empty holds it: the drain that ends the
 * stopped turn starts no new turn, and the user's next send carries what was held.
 *
 * ## What was read, and what this file measures first
 *
 * `cancelProcessing` takes the steers the backend accepted and has not delivered
 * (F1.238). A plugin monitor's steer (`origin: 'monitor'`, F1.343) is not the
 * user's message, so `requeueUndeliveredSteer` routes it to `deliverMonitorEvent`,
 * which — the turn still processing — parks it in `pendingTaskNotifications`.
 * The Stop's queue pause was gated on `messageQueue.length > 0`, which such a
 * steer never touches, so when the drain ended `onProcessingStopped` found the
 * notification queue non-empty and unpaused and flushed it: a NEW model turn,
 * started by plugin output, right after the user pressed Stop — the contrary of
 * F1.343's "held while the queue is paused after a Stop".
 *
 * The rig drives the real `cancelProcessing` → `recoverPendingSteers` →
 * `requeueUndeliveredSteer` → `deliverMonitorEvent` → drain → `onProcessingStopped`
 * over a stub backend whose FIFO holds one monitor steer at the Stop.
 *
 * ## CONTROLS
 *
 * - A Stop with nothing pending ends the turn as before and starts nothing.
 * - The hold belongs to the stopped turn only: a notification that queues during
 *   a LATER, unstopped turn still starts the next turn at that turn's end (rule 2).
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

const MONITOR_TEXT = 'Plugin monitor build-watch: the nightly build turned red.'

interface Steer { message: string; messageId?: string; origin?: 'monitor' }

async function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1530-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1530', name: 'F1.530', slug: 'f1530', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1530-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  /** The steers the backend's FIFO holds (Claude's, as far as the host can see it). */
  const heldSteers: Steer[] = []
  /** What each turn's `agent.chat` was handed, and one gate per generator. */
  const chats: string[] = []
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
    takePendingSteers: () => heldSteers.splice(0),
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
  const deliverMonitorEvent = (text: string) => (internals.deliverMonitorEvent as (delivery: unknown) => Promise<void>).call(manager, {
    sessionKey: { workspaceId: workspace.id, sessionId: managed.id },
    taskId: 'probe-monitor',
    text,
  })
  return {
    manager,
    managed: managed as unknown as { isProcessing: boolean; processingGeneration: number; pendingTaskNotifications?: string[]; queuePaused: boolean; id: string },
    workspace, sent, heldSteers, chats, generators, generator, send, deliverMonitorEvent,
    cleanup: () => manager.cleanup(),
  }
}

const turnEndsAfter = (sent: SessionEvent[], index: number) =>
  sent.slice(index).map(event => event.type).filter(type => type === 'complete' || type === 'interrupted' || type === 'error')

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1

describe('F1.530 — a Stop holds the notification it recovered; the drain starts no turn', () => {
  it('THE DEFECT — a monitor steer the backend still held at Stop does not start a new turn when the drain ends', async () => {
    const r = await rig('f1530-monitor-steer')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      // A scheduled plugin monitor's tick was steered into this turn and not yet delivered (no tool boundary yet).
      r.heldSteers.push({ message: MONITOR_TEXT, origin: 'monitor' })
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      // The generator stops when asked: its trailing `complete` ends the turn (the drain).
      r.generators[0]!.release()
      await first
      await tick(400)

      expect({
        turnsStarted: r.chats.length,
        processing: r.managed.isProcessing,
        held: r.managed.pendingTaskNotifications ?? [],
        turnEndsSent: turnEndsAfter(r.sent, index),
      }).toEqual({ turnsStarted: 1, processing: false, held: [MONITOR_TEXT], turnEndsSent: ['interrupted', 'complete'] })

      // The user's next send carries the held notification, once, and nothing is left behind it.
      const next = r.send('ok, carry on')
      await (await r.generator(1)).parked
      expect(r.chats.length).toBe(2)
      expect(occurrences(r.chats[1]!, MONITOR_TEXT)).toBe(1)
      expect(r.chats[1]).toContain('ok, carry on')
      expect(r.managed.pendingTaskNotifications ?? []).toEqual([])
      r.generators[1]!.release()
      await next
      await tick(300)
      expect({ turnsStarted: r.chats.length, processing: r.managed.isProcessing }).toEqual({ turnsStarted: 2, processing: false })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})

describe('F1.530 — CONTROLS', () => {
  it('a Stop with nothing pending ends the turn exactly as before and starts nothing', async () => {
    const r = await rig('f1530-nothing-pending')
    try {
      const first = r.send('first')
      await (await r.generator(0)).parked
      const index = r.sent.length
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      r.generators[0]!.release()
      await first
      await tick(400)
      expect({
        turnsStarted: r.chats.length,
        processing: r.managed.isProcessing,
        held: r.managed.pendingTaskNotifications ?? [],
        queuePaused: r.managed.queuePaused,
        turnEndsSent: turnEndsAfter(r.sent, index),
      }).toEqual({ turnsStarted: 1, processing: false, held: [], queuePaused: false, turnEndsSent: ['interrupted', 'complete'] })
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })

  it('the hold is the stopped turn\'s only: a notification queued during a LATER, unstopped turn still starts the next turn at its end', async () => {
    const r = await rig('f1530-later-turn')
    try {
      // A stopped turn holding a recovered monitor steer…
      const first = r.send('first')
      await (await r.generator(0)).parked
      r.heldSteers.push({ message: MONITOR_TEXT, origin: 'monitor' })
      await r.manager.cancelProcessing(r.managed.id, false, r.workspace.id)
      r.generators[0]!.release()
      await first
      await tick(400)
      // …then the user's next turn, during which an ordinary monitor event arrives (rule 2: queued).
      const second = r.send('second')
      await (await r.generator(1)).parked
      await r.deliverMonitorEvent('Monitor probe-monitor: a later event.')
      expect(r.managed.pendingTaskNotifications ?? []).toEqual(['Monitor probe-monitor: a later event.'])
      r.generators[1]!.release()
      await second
      // Rule 2, unchanged: that turn's end starts the notification turn by itself.
      await (await r.generator(2)).parked
      expect(r.chats.length).toBe(3)
      expect(occurrences(r.chats[2]!, 'a later event.')).toBe(1)
    } finally {
      r.generators.forEach(generator => generator.release())
      r.cleanup()
    }
  })
})
