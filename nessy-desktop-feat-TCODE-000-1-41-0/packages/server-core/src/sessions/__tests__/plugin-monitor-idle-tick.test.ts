/**
 * F1.502 (origin WJ-ah P-WJah-1) — a SCHEDULED plugin monitor's tick that fires
 * while no turn is running is skipped BY DESIGN, and `/tasks` now says so beside
 * the monitor instead of leaving the skip invisible.
 *
 * ## What a "scheduled" monitor is in this fork (read before deciding)
 *
 * NOT the monitor `plugins/components.md#monitors` documents. That page's monitor
 * is a shell command whose every stdout line is a notification; this fork runs it
 * as Claude's `experimental.monitors` command form through `SessionMonitorService`
 * → `deliverScheduledMonitorEvent` → `deliverMonitorEvent`, which already wakes an
 * idle session, queues behind a busy one and holds before the first prompt. The
 * SCHEDULED form is the fork's own `nessy-plugin.json` extension (`path` + `cron`
 * + `timezone`, `RuntimeScheduledMonitorRegistration`): a trusted text resource
 * read on each matching `SchedulerTick` through the TURN's capability
 * materializer. Its docblocks state the live-only design and the reason:
 * `PluginMonitorService` "deliberately owns no schedule, session, queue, or
 * durable state"; the registration is "delivered only into an already-live
 * turn"; `armPluginPeripherals`: "A capability generation is turn-pinned … must
 * never redirect into the current turn" from an earlier generation. It is armed
 * per capability turn and disarmed at that turn's end, so between turns it is
 * not even subscribed. So, as the row's decision provides for exactly this case,
 * the drop is KEPT and made visible where the user meets the monitor: `/tasks`.
 *
 * ## The arms
 *
 * - THE ROW (red at HEAD): after the turn that armed a scheduled monitor ends,
 *   `/tasks` names it with its schedule and says a tick while no turn runs is
 *   skipped, not queued — and does not claim "nothing scheduled" beside it; a
 *   later arm with none (a runtime that runs no plugin monitor, or a generation
 *   without one) takes the row away again.
 * - CONTROLS (green both sides): a session that never armed one reads the shared
 *   empty sentence byte for byte; an idle tick that really fired (it read the
 *   resource) still reaches nothing — no line, no event, nothing queued; a live
 *   tick is still exactly F1.496's one line; a hand-back still draws no second line.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { SESSION_SCHEDULED_WORK_EMPTY_LINE } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { buildPluginMonitorSteer } from '../task-notification.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-502'
const MONITOR_ID = 'deploy-status'
// Every minute, so a tick fired by the test always matches (`PluginMonitorService` checks `matchesCron` first).
const MONITOR_CRON = '* * * * *'
const MONITOR_TIMEZONE = 'Europe/Moscow'
const MONITOR_TEXT = 'check the deploy dashboard'

interface Row { id: string; role: string; content: string; timestamp: number; taskNotification?: true; infoLevel?: string }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  pendingTaskNotifications?: string[]
  capabilityRuntime?: unknown
  stopRequested?: boolean
}
type Metadata = { messageId?: string; origin?: 'monitor' }
type WireEvent = { type: string; status?: string; message?: Row }

/** Holds steers the way Claude's PreToolUse emulation does, metadata and all. */
function claudeShapedAgent() {
  const held: Array<{ message: string } & Metadata> = []
  const redirectCalls: Array<[string, Metadata | undefined]> = []
  return {
    redirectCalls,
    agent: {
      isProcessing: () => true,
      redirect(message: string, metadata?: Metadata) {
        redirectCalls.push([message, metadata])
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

function rig(sessionId: string) {
  const backend = claudeShapedAgent()
  const sm = createTestSessionManager()
  const events: WireEvent[] = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as WireEvent) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-502-'))
  roots.push(root)
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.502' },
    { id: WORKSPACE_ID, name: 'F1.502', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  managed.messages.push({ id: 'u-1', role: 'user', content: 'watch the deploy', timestamp: 1 })
  managed.agent = backend.agent
  managed.isProcessing = true
  created.push(managed)
  const internals = sm as unknown as {
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    armPluginPeripherals(managed: unknown, runtime: unknown, provider?: string): void
    disarmPluginPeripherals(managed: unknown): void
    runTasksSessionCommand(managed: unknown): void
    listSessionScheduledWork: (...args: unknown[]) => unknown
    automationSystems: Map<string, unknown>
    sendMessage: (...args: unknown[]) => Promise<void>
  }
  const ticks: Array<() => Promise<void>> = []
  const reads = { count: 0 }
  internals.automationSystems.set(WORKSPACE_ID, {
    eventBus: {
      on: (name: string, handler: () => Promise<void>) => { if (name === 'SchedulerTick') ticks.push(handler) },
      off: () => undefined,
    },
  })
  /** Arms the capability generation's monitors on `provider`; returns the SchedulerTick handler this arm subscribed, if any. */
  const arm = (provider: string, monitors: unknown[] = [scheduledMonitor()]) => {
    const subscribed = ticks.length
    const runtime = {
      view: { generation: `generation-${subscribed}`, monitors },
      materializer: { assertActive: () => undefined, verifyPlugin: async () => undefined, readText: async () => { reads.count += 1; return MONITOR_TEXT } },
    }
    managed.capabilityRuntime = runtime
    internals.armPluginPeripherals(managed, runtime, provider)
    return ticks.length > subscribed ? ticks.at(-1) : undefined
  }
  /** The turn ends: the send path's `finally` disarms the turn-pinned peripherals and lowers the flag. */
  const endTurn = () => {
    internals.disarmPluginPeripherals(managed)
    managed.capabilityRuntime = undefined
    managed.isProcessing = false
  }
  /** `/tasks` exactly as `sendMessage`'s D1.14 arm runs it; returns the ONE row it recorded. */
  const tasks = () => {
    const before = managed.messages.length
    internals.runTasksSessionCommand(managed)
    expect(managed.messages).toHaveLength(before + 1)
    const row = managed.messages.at(-1)!
    expect(row.role).toBe('info')
    return row
  }
  return { sm, managed, events, internals, backend, arm, endTurn, tasks, reads }
}

function scheduledMonitor() {
  return {
    form: 'schedule',
    key: 'plugin://market/deploy-tools/monitor#deploy-status',
    monitorId: MONITOR_ID,
    cron: MONITOR_CRON,
    timezone: MONITOR_TIMEZONE,
    executableHash: 'e'.repeat(64),
    pluginInstanceId: 'plugin://market/deploy-tools@1.0.0#' + 'b'.repeat(64),
    resource: { pluginInstanceId: 'plugin://market/deploy-tools@1.0.0#' + 'b'.repeat(64), relativePath: 'monitors/deploy.md', contentHash: 'd'.repeat(64) },
  }
}

const lines = (managed: Managed) => managed.messages.filter(message => message.taskNotification === true)
const settle = () => new Promise<void>(resolve => { setTimeout(resolve, 0) })

describe('F1.502 — /tasks names the scheduled plugin monitor and says a tick outside a turn is skipped', () => {
  it('THE ROW: after the turn that armed it ends, /tasks lists the monitor with its schedule and says the idle tick is skipped, not queued', () => {
    const h = rig('tasks-row')
    expect(h.arm('anthropic')).toBeDefined() // control: the monitor really armed
    h.endTurn()

    const row = h.tasks()

    expect(row.infoLevel).toBe('info')
    // THE DEFECT: the monitor had no /tasks row at all, so nothing told the user a tick between turns goes nowhere.
    expect(row.content).toContain(`${MONITOR_ID} — ${MONITOR_CRON} (${MONITOR_TIMEZONE})`)
    expect(row.content).toContain('only while a turn is running')
    expect(row.content).toContain('skipped, not queued')
    // A monitor on a schedule IS something scheduled, so the shared empty sentence must not stand beside it.
    expect(row.content).not.toContain('has nothing scheduled')
  })

  it('THE ROW: beside the rest of the inventory, the monitor section follows it', () => {
    const h = rig('tasks-row-with-cron')
    h.arm('anthropic')
    h.endTurn()
    h.internals.listSessionScheduledWork = () => ({
      tasks: [],
      crons: [{ id: 'cron_1', schedule: '0 9 * * *', recurring: true, prompt: 'nightly review' }],
    })

    const row = h.tasks()

    const cronAt = row.content.indexOf('cron_1 — 0 9 * * * (repeats) — nightly review')
    const monitorAt = row.content.indexOf(`${MONITOR_ID} — ${MONITOR_CRON} (${MONITOR_TIMEZONE})`)
    expect(cronAt).toBeGreaterThanOrEqual(0)
    expect(monitorAt).toBeGreaterThan(cronAt)
  })

  it('CONTROL — a session that never armed a scheduled monitor reads the shared empty sentence, byte for byte', () => {
    const h = rig('tasks-never-armed')
    h.endTurn()
    expect(h.tasks().content).toBe(SESSION_SCHEDULED_WORK_EMPTY_LINE)
  })

  it('THE ROW\'s boundary: a later arm with none takes the row away (a runtime that runs no plugin monitor; a generation without one)', () => {
    const h = rig('tasks-row-cleared')
    h.arm('anthropic')
    h.endTurn()
    expect(h.tasks().content).toContain(MONITOR_ID) // control: the row was there

    expect(h.arm('nestor-cloud-agent')).toBeUndefined() // nothing armed on a runtime that runs none
    h.endTurn()
    expect(h.tasks().content).toBe(SESSION_SCHEDULED_WORK_EMPTY_LINE)

    h.arm('anthropic')
    h.endTurn()
    expect(h.tasks().content).toContain(MONITOR_ID) // control: re-armed, back again
    h.arm('anthropic', [])
    h.endTurn()
    expect(h.tasks().content).toBe(SESSION_SCHEDULED_WORK_EMPTY_LINE)
  })
})

describe('F1.502 — the drop is KEPT: an idle tick reaches nothing', () => {
  it('CONTROL — a tick canDeliver() refuses (no running turn) leaves no line, no event, and nothing in the monitor-event queue', async () => {
    const h = rig('idle-tick')
    const tick = h.arm('anthropic')!
    h.managed.isProcessing = false

    await tick()

    expect(h.reads.count).toBe(1) // control: the tick really fired and read the resource
    expect(h.backend.redirectCalls).toEqual([])
    expect(lines(h.managed)).toEqual([])
    expect(h.events.filter(event => event.type === 'user_message')).toEqual([])
    expect(h.managed.pendingTaskNotifications ?? []).toEqual([])
  })

  it('CONTROL — a LIVE tick is still exactly F1.496\'s one line', async () => {
    const h = rig('live-tick')
    const tick = h.arm('anthropic')!

    await tick()

    expect(lines(h.managed)).toHaveLength(1)
    const line = lines(h.managed)[0]!
    expect(line.content).toBe(buildPluginMonitorSteer(MONITOR_ID, MONITOR_TEXT))
    expect(h.backend.redirectCalls).toEqual([[line.content, { origin: 'monitor', messageId: line.id }]])
    expect(h.events.filter(event => event.type === 'user_message')).toHaveLength(1)
  })

  it('CONTROL — a tick delivered live and handed back still draws no second line', async () => {
    const h = rig('hand-back')
    const tick = h.arm('anthropic')!
    await tick()
    const line = lines(h.managed)[0]!
    const calls: unknown[][] = []
    h.internals.sendMessage = async (...args: unknown[]) => { calls.push(args) }
    h.managed.isProcessing = false

    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: line.content, messageId: line.id, origin: 'monitor' } as AgentEvent)
    await settle()

    expect(calls).toHaveLength(1)
    expect(calls[0]![5]).toBe(line.id) // the live line is the turn's entry, not a second one
    expect(lines(h.managed)).toHaveLength(1)
  })
})
