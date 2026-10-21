/**
 * F1.496 (origin WJ-ac P-WJac-1) — a plugin monitor's tick steered LIVE into a
 * running turn is VISIBLE in the transcript, once.
 *
 * ## What was read at HEAD `faa6fc19b`, before this row
 *
 * `SessionManager.armPluginPeripherals`' scheduled-monitor `deliver` called
 * `canDeliver()?.redirect(buildPluginMonitorSteer(...), { origin: 'monitor' })` and
 * returned its boolean — nothing was appended to `managed.messages` and nothing
 * went on the wire, so the model could change course mid-turn on plugin text the
 * user never saw. The RE-QUEUED path did show: a tick the backend handed back
 * (`requeueUndeliveredSteer`, F1.343/F1.485) rejoins the monitor-event queue and
 * `flushPendingTaskNotifications` delivers it on the next turn as F1.351's
 * labelled line (`Message.taskNotification`, drawn by `TaskNotificationLine`).
 *
 * ## What this row does (TRANSPARENT rule)
 *
 * - A tick `redirect()` ACCEPTS leaves ONE line in F1.351's exact shape — a user
 *   entry marked `taskNotification`, whose content is the framed steer the model
 *   was sent, so its body reads `Plugin monitor <id>:` — plus one `user_message`
 *   event. The backend is told the line's id, as it is told a user steer's.
 * - A tick `canDeliver()` or `redirect()` refuses leaves nothing (it is dropped,
 *   as before).
 * - A tick delivered live and then HANDED BACK is never drawn twice: the next
 *   group's flush shows only what no line shows yet, and when every tick in it
 *   already has its line the newest of them is the turn's entry and MOVES to the
 *   new turn (F1.349's re-stamp and `'processing'` event). The model receives the
 *   whole group either way.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { buildPluginMonitorSteer, buildTaskNotificationDelivery } from '../task-notification.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-496'
const MONITOR_ID = 'deploy-status'
const MONITOR_TEXT = 'deploy 42 failed on main'
const MONITOR_EVENT = `Plugin monitor ${MONITOR_ID}:\n${MONITOR_TEXT}`

interface Row { id: string; role: string; content: string; timestamp: number; isQueued?: boolean; taskNotification?: true }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  messageQueue: Array<{ message: string; messageId?: string }>
  pendingTaskNotifications?: string[]
  capabilityRuntime?: unknown
  stopRequested?: boolean
}
type Metadata = { messageId?: string; origin?: 'monitor' }
type WireEvent = { type: string; status?: string; message?: Row }

/** Holds steers the way Claude's PreToolUse emulation does, metadata and all. */
function claudeShapedAgent(accept = true) {
  const held: Array<{ message: string } & Metadata> = []
  const redirectCalls: Array<[string, Metadata | undefined]> = []
  return {
    held,
    redirectCalls,
    agent: {
      isProcessing: () => true,
      redirect(message: string, metadata?: Metadata) {
        redirectCalls.push([message, metadata])
        if (!accept) return false
        held.push({ message, ...metadata })
        return true
      },
      takePendingSteers: () => held.splice(0),
      forceAbort: () => undefined,
      interruptForHandoff: () => undefined,
    },
  }
}

const created: Managed[] = []
const roots: string[] = []
afterEach(() => {
  for (const session of created.splice(0)) {
    session.stopRequested = false
    session.isProcessing = false
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rig(sessionId: string, agent: unknown) {
  const sm = createTestSessionManager()
  const events: WireEvent[] = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as WireEvent) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-496-'))
  roots.push(root)
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.496' },
    { id: WORKSPACE_ID, name: 'F1.496', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  // The user's own question, so the monitor queue may start a turn (rule 3 of `deliverMonitorEvent`).
  managed.messages.push({ id: 'u-1', role: 'user', content: 'watch the deploy', timestamp: 1 })
  managed.agent = agent
  managed.isProcessing = true
  created.push(managed)
  const internals = sm as unknown as {
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    armPluginPeripherals(managed: unknown, runtime: unknown, provider?: string): void
    automationSystems: Map<string, unknown>
    sendMessage: (...args: unknown[]) => Promise<void>
  }
  return { sm, managed, events, internals }
}

/** Arms ONE real scheduled plugin monitor and returns its SchedulerTick handler. */
function armMonitor(h: ReturnType<typeof rig>) {
  const ticks: Array<() => Promise<void>> = []
  h.internals.automationSystems.set(WORKSPACE_ID, {
    eventBus: {
      on: (name: string, handler: () => Promise<void>) => { if (name === 'SchedulerTick') ticks.push(handler) },
      off: () => undefined,
    },
  })
  const runtime = {
    view: {
      generation: 'generation-f1-496',
      monitors: [{ form: 'schedule', monitorId: MONITOR_ID, cron: '* * * * *', pluginInstanceId: 'plugin-f1-496', resource: { path: 'monitor.md' } }],
    },
    materializer: { assertActive: () => undefined, verifyPlugin: async () => undefined, readText: async () => MONITOR_TEXT },
  }
  h.managed.capabilityRuntime = runtime
  h.internals.armPluginPeripherals(h.managed, runtime, 'anthropic')
  expect(ticks).toHaveLength(1) // control: the monitor really armed
  return ticks[0]!
}

const lines = (managed: Managed) => managed.messages.filter(message => message.taskNotification === true)
const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

describe('F1.496 — a plugin monitor tick delivered LIVE leaves one labelled line', () => {
  it('THE ROW: a REAL tick redirect() accepts is ONE F1.351-shaped line naming the monitor, one wire event, and the backend is told its id', async () => {
    const backend = claudeShapedAgent()
    const h = rig('live-line', backend.agent)
    const tick = armMonitor(h)
    const before = h.managed.messages.length

    await tick()

    // THE DEFECT: nothing was appended and nothing went on the wire.
    expect(lines(h.managed)).toHaveLength(1)
    expect(h.managed.messages).toHaveLength(before + 1)
    const line = lines(h.managed)[0]!
    expect(line.role).toBe('user')
    expect(line.content).toBe(buildPluginMonitorSteer(MONITOR_ID, MONITOR_TEXT)) // what the model was sent
    expect(line.content).toContain(`Plugin monitor ${MONITOR_ID}:`) // the body names the monitor
    expect(backend.redirectCalls).toEqual([[line.content, { origin: 'monitor', messageId: line.id }]])
    const wire = h.events.filter(event => event.type === 'user_message')
    expect(wire).toHaveLength(1)
    expect(wire[0]!.status).toBe('accepted')
    expect(wire[0]!.message!.id).toBe(line.id)
    expect(wire[0]!.message!.taskNotification).toBe(true)
  })

  it('CONTROL — a tick canDeliver() refuses (the turn has ended) leaves no line and no event', async () => {
    const backend = claudeShapedAgent()
    const h = rig('refused-by-can-deliver', backend.agent)
    const tick = armMonitor(h)
    h.managed.isProcessing = false

    await tick()

    expect(backend.redirectCalls).toEqual([])
    expect(lines(h.managed)).toEqual([])
    expect(h.events.filter(event => event.type === 'user_message')).toEqual([])
  })

  it('CONTROL — a tick the backend refuses (redirect() → false) leaves no line and no event', async () => {
    const backend = claudeShapedAgent(false)
    const h = rig('refused-by-backend', backend.agent)
    const tick = armMonitor(h)

    await tick()

    expect(backend.redirectCalls).toHaveLength(1) // control: the tick did reach the backend
    expect(lines(h.managed)).toEqual([])
    expect(h.events.filter(event => event.type === 'user_message')).toEqual([])
  })

  it('CONTROL — a USER steer draws no monitor line', async () => {
    const backend = claudeShapedAgent()
    const h = rig('user-steer', backend.agent)

    await h.sm.sendMessage(h.managed.id, 'user correction')

    expect(backend.redirectCalls).toHaveLength(1) // control: it went out as a steer
    expect(h.managed.messages.at(-1)!.content).toBe('user correction')
    expect(lines(h.managed)).toEqual([])
  })
})

describe('F1.496 — a tick delivered live and then handed back shows ONCE', () => {
  it('THE ROW: the flush of a handed-back tick reuses its live line as the turn\'s entry; the model still receives the notification', async () => {
    const backend = claudeShapedAgent()
    const h = rig('hand-back-alone', backend.agent)
    const tick = armMonitor(h)
    await tick()
    const line = lines(h.managed)[0]!
    const calls: unknown[][] = []
    h.internals.sendMessage = async (...args: unknown[]) => { calls.push(args) }
    // The turn ended with no tool call: Claude hands the steer back, naming the line.
    h.managed.isProcessing = false

    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: line.content, messageId: line.id, origin: 'monitor' } as AgentEvent)
    await settle()

    expect(calls).toHaveLength(1)
    const [, message, , , , existingMessageId, , , context, modelMessage] = calls[0]!
    // THE DEFECT: no id, so `sendMessage` appended a SECOND line carrying the same tick.
    expect(existingMessageId).toBe(line.id)
    expect(message).toBe(line.content)
    expect(modelMessage).toBe(buildTaskNotificationDelivery([MONITOR_EVENT]))
    expect(context).toEqual({ workspaceId: WORKSPACE_ID, taskNotification: true })
    expect(lines(h.managed)).toHaveLength(1)
  })

  it('a group that also carries an event no line shows yet draws ONE new line with only that event; the model receives both', async () => {
    const backend = claudeShapedAgent()
    const h = rig('hand-back-mixed', backend.agent)
    const tick = armMonitor(h)
    await tick()
    const line = lines(h.managed)[0]!
    const calls: unknown[][] = []
    h.internals.sendMessage = async (...args: unknown[]) => { calls.push(args) }
    // Still mid-turn: the hand-back and another monitor event both wait in the queue.
    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: line.content, messageId: line.id, origin: 'monitor' } as AgentEvent)
    h.managed.pendingTaskNotifications = [...(h.managed.pendingTaskNotifications ?? []), 'Monitor build-watch: tests went red']
    h.managed.isProcessing = false

    await (h.sm as unknown as { flushPendingTaskNotifications(m: unknown): Promise<void> }).flushPendingTaskNotifications(h.managed)

    expect(calls).toHaveLength(1)
    const [, message, , , , existingMessageId, , , , modelMessage] = calls[0]!
    expect(existingMessageId).toBeUndefined()
    expect(message).toBe(buildTaskNotificationDelivery(['Monitor build-watch: tests went red']))
    expect(modelMessage).toBe(buildTaskNotificationDelivery([MONITOR_EVENT, 'Monitor build-watch: tests went red']))
  })

  it('CONTROL — a hand-back that names no live line is flushed exactly as before: F1.351\'s new line, the model text unchanged', async () => {
    const backend = claudeShapedAgent()
    const h = rig('hand-back-no-line', backend.agent)
    const calls: unknown[][] = []
    h.internals.sendMessage = async (...args: unknown[]) => { calls.push(args) }
    h.managed.isProcessing = false

    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: buildPluginMonitorSteer(MONITOR_ID, MONITOR_TEXT), origin: 'monitor' } as AgentEvent)
    await settle()

    expect(calls).toHaveLength(1)
    const [, message, , , , existingMessageId, , , context, modelMessage] = calls[0]!
    expect(message).toBe(buildTaskNotificationDelivery([MONITOR_EVENT]))
    expect(existingMessageId).toBeUndefined()
    expect(modelMessage).toBeUndefined()
    expect(context).toEqual({ workspaceId: WORKSPACE_ID, taskNotification: true })
  })
})

describe('F1.496 — the reused line MOVES to the turn that delivers it (the real sendMessage)', () => {
  async function turnRig(sessionId: string) {
    const stateRoot = mkdtempSync(join(tmpdir(), 'f1-496-turn-'))
    roots.push(stateRoot)
    const workspace = { id: WORKSPACE_ID, name: 'F1.496', slug: 'f1496', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const manager = createTestSessionManager()
    const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true }) as unknown as Managed
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)
    created.push(managed)
    const sent: WireEvent[] = []
    manager.setEventSink(((_channel: unknown, _target: unknown, event: WireEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])
    const internals = manager as unknown as Record<string, unknown>
    internals.persistSession = () => {}
    manager.flushSession = async () => {}
    internals.acquireCapabilityTurn = async () => () => {}
    internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1496-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
    internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })
    const received: string[] = []
    const agent = {
      isProcessing: () => false,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getModel: () => 'test-model',
      getSessionId: () => undefined,
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
      drainAutomationEvents: async () => {},
      forceAbort: () => {},
      interruptForHandoff: () => {},
      dispose: () => {},
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      chat: async function* (message: string) {
        received.push(message)
        yield { type: 'complete' } as AgentEvent
      },
    }
    internals.getOrCreateAgent = async () => { managed.agent = agent; return agent }
    return { manager, managed, sent, received, cleanup: () => manager.cleanup() }
  }

  it('THE ROW: sendMessage re-stamps the reused line past the answer it followed and says so on the wire; no new line, and the model gets the whole group', async () => {
    const h = await turnRig('move')
    const framed = buildPluginMonitorSteer(MONITOR_ID, MONITOR_TEXT)
    const group = buildTaskNotificationDelivery([MONITOR_EVENT, 'Monitor build-watch: tests went red'])
    h.managed.messages.push(
      { id: 'u-1', role: 'user', content: 'watch the deploy', timestamp: 500 },
      { id: 'line-1', role: 'user', content: framed, timestamp: 1_000, taskNotification: true },
      { id: 'a-1', role: 'assistant', content: 'the deploy is running', timestamp: 2_000 },
    )
    try {
      await h.manager.sendMessage(h.managed.id, framed, undefined, undefined, undefined, 'line-1', undefined, undefined, { workspaceId: WORKSPACE_ID, taskNotification: true }, group)

      const line = h.managed.messages.find(message => message.id === 'line-1')!
      // THE DEFECT: still 1 000, i.e. drawn above the answer, in the turn that never received it.
      expect(line.timestamp).toBeGreaterThan(2_000)
      const processing = h.sent.filter(event => event.type === 'user_message' && event.status === 'processing')
      expect(processing).toHaveLength(1)
      expect(processing[0]!.message!.id).toBe('line-1')
      expect(processing[0]!.message!.timestamp).toBe(line.timestamp)
      expect(lines(h.managed)).toHaveLength(1)
      expect(h.managed.messages.filter(message => message.role === 'user')).toHaveLength(2)
      expect(h.received).toHaveLength(1)
      expect(h.received[0]).toContain(group)
    } finally {
      h.cleanup()
    }
  })
})
