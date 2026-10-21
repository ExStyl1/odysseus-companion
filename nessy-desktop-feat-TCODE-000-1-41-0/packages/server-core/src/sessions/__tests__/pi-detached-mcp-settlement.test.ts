/**
 * UB12.35 — a settled DETACHED Pi MCP call lets go of its evaluator entry, under the UA4.8 `hostDeliveriesDue`
 * discipline.
 *
 * Premise read at HEAD a4ed64075 (re-read at b45cc72af): the subprocess settles a `task-mcp-*` call with `task_notification` alone, on both its
 * resolve and its reject path (pi-agent-server `index.ts`, the R10 detach), and never with `task_completed` — the only
 * case that deleted a `piBackgroundTaskKinds` entry. `task_backgrounded` writes kind `'mcp'`, so the entry stayed until
 * the agent was disposed, and every reader of the map read the session as busy for good: the runtime snapshot's
 * settlement (`activeWorkflowEvaluators` → `workflow_evaluator` pending; the Pi `/goal` continuation and the Tasks
 * Conductor's `isSessionSettled` both stop on it), the live-agent busy domains and the reap guard's `subagentRunning`.
 *
 * The fix deletes the kind at the call's `task_notification`, AFTER marking its delivery due with the call's own text:
 * `settleHostDeliveriesCarriedBy` matches the notice's first line (`MCP background task <id> (<tool>) completed:`), so
 * the conductor cannot complete a node between the delete and the turn that carries the result. A bare delete would
 * open exactly that window.
 *
 * Driven on the REAL `processEvent` / `deliverMonitorEvent` / `sendMessage` / `onProcessingStopped` path over a parked
 * stub agent (the rig of `tasks/__tests__/conductor-settlement-producers.test.ts`, UA4.8 follow-up 2); only the
 * capability turn and disk writes are stubbed, and the runtime snapshot reads Pi with an empty process supervisor.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const TASK_ID = 'task-mcp-ub1235'
const NOTICE = `MCP background task ${TASK_ID} (mcp__s__write) completed:\nwrote 3 rows`

type Gen = { input: string; parked: Promise<void>; release: () => void }

async function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ub1235-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-ub1235', name: 'UB12.35', slug: 'ub1235', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true }) as unknown as {
    id: string
    isProcessing: boolean
    messages: Array<Record<string, unknown>>
    piBackgroundTaskKinds?: Map<string, string>
    hostDeliveriesDue?: Map<string, string | undefined>
    agent: unknown
  }
  const internals = manager as unknown as Record<string, unknown> & {
    sessions: Map<string, unknown>
    processEvent(m: unknown, event: unknown): Promise<void>
    hasHostTurnDueOrRunning(id: string, ws?: string): boolean
  }
  internals.sessions.set(`${workspace.id}:${managed.id}`, managed)
  manager.setEventSink((() => {}) as Parameters<typeof manager.setEventSink>[0])
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'ub1235-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })
  // The `/goal` continuation is not this row's subject.
  internals.schedulePiGoalContinuation = () => {}
  managed.messages.push({ id: 'u0', role: 'user', content: 'write the rows', timestamp: 0 })
  const generators: Gen[] = []
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
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* (input: unknown) {
      let reach!: () => void
      const parked = new Promise<void>(resolve => { reach = resolve })
      let release!: () => void
      const outcome = new Promise<void>(resolve => { release = resolve })
      generators.push({ input: String(input), parked, release })
      yield { type: 'text_delta', text: 'working ', turnId: `T${generators.length}` }
      reach()
      await outcome
      yield { type: 'complete' }
    },
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent; return agent }
  const generator = async (i: number) => {
    for (let n = 0; n < 500 && !generators[i]; n++) await sleep(10)
    if (!generators[i]) throw new Error(`generator ${i} never started`)
    await generators[i]!.parked
    return generators[i]!
  }
  const idle = async () => { for (let n = 0; n < 500 && managed.isProcessing; n++) await sleep(10) }
  const due = () => internals.hasHostTurnDueOrRunning(managed.id, workspace.id)
  /**
   * The runtime snapshot's settlement, read as a Pi session with no supervised process (so it rests on the turn and the
   * evaluator map alone). The two reads are pinned for the read only, at rest: the turn path keeps the real ones.
   */
  const settled = async () => {
    const provider = internals.resolveManagedProvider
    const supervisor = internals.piProcessSupervisor
    internals.resolveManagedProvider = () => 'pi'
    internals.piProcessSupervisor = { snapshot: async () => [] }
    try {
      return (await manager.getPiHarnessRuntimeSnapshot({ workspaceId: workspace.id, sessionId: managed.id })).settlement
    } finally {
      internals.resolveManagedProvider = provider
      internals.piProcessSupervisor = supervisor
    }
  }
  const event = (e: Record<string, unknown>) => internals.processEvent(managed, e)
  return { manager, managed, internals, generators, generator, idle, due, settled, event, cleanup: () => manager.cleanup() }
}

describe('UB12.35 — a settled detached Pi MCP call no longer holds the session unsettled', () => {
  it('POSITIVE — after the call\'s task_notification and its delivery turn, the runtime snapshot reads settled', async () => {
    const r = await rig('ub1235-positive')
    try {
      await r.event({ type: 'task_backgrounded', toolUseId: 'call-mcp', taskId: TASK_ID, kind: 'mcp' })
      // Control on the same instrument: the detached call's evaluator entry holds the session unsettled.
      const before = await r.settled()
      expect(before.settled).toBe(false)
      expect(before.pending).toContain('workflow_evaluator')

      // Idle with a user message: the delivery STARTS a turn, and the handler awaits that turn.
      const notified = r.event({ type: 'task_notification', taskId: TASK_ID, text: NOTICE })
      const delivery = await r.generator(0)
      expect(delivery.input).toContain(`MCP background task ${TASK_ID} (mcp__s__write) completed:`)
      delivery.release()
      await notified
      await r.idle()
      await sleep(20)

      expect(r.managed.piBackgroundTaskKinds?.has(TASK_ID) ?? false).toBe(false)
      const after = await r.settled()
      expect(after.pending).toEqual([])
      expect(after.settled).toBe(true)
      expect(r.due()).toBe(false) // the turn that carried the result cleared its mark: nothing holds the node for good
    } finally {
      r.cleanup()
    }
  }, 20_000)

  it('NEGATIVE — between the delete and the delivery turn\'s start, hasHostTurnDueOrRunning reads true', async () => {
    const r = await rig('ub1235-window')
    try {
      await r.event({ type: 'task_backgrounded', toolUseId: 'call-mcp', taskId: TASK_ID, kind: 'mcp' })
      expect(r.due()).toBe(false) // a running detached call is not a due delivery
      const flush = r.internals.flushPendingTaskNotifications as (m: unknown) => Promise<void>
      const readings: Array<{ evaluator: boolean; processing: boolean; due: boolean }> = []
      r.internals.flushPendingTaskNotifications = async function (this: unknown, m: unknown) {
        // The window: the evaluator entry is gone and no turn runs yet — every other gate input reads settled.
        readings.push({ evaluator: r.managed.piBackgroundTaskKinds?.has(TASK_ID) ?? false, processing: r.managed.isProcessing, due: r.due() })
        return flush.call(this, m)
      }
      const notified = r.event({ type: 'task_notification', taskId: TASK_ID, text: NOTICE })
      const delivery = await r.generator(0)
      expect(readings).toEqual([{ evaluator: false, processing: false, due: true }])
      expect(r.due()).toBe(true) // the delivery turn runs
      delivery.release()
      await notified
      await r.idle()
      await sleep(20)
      expect(r.due()).toBe(false)
    } finally {
      r.cleanup()
    }
  }, 20_000)

  it('BOUNDARY — a task_notification for a non-MCP id neither drops its kind nor marks a delivery due', async () => {
    const r = await rig('ub1235-boundary')
    try {
      await r.event({ type: 'task_backgrounded', toolUseId: 'call-workflow', taskId: 'task-workflow-ub1235', kind: 'workflow' })
      r.internals.deliverMonitorEvent = async () => {} // the R10 delivery is not this arm's subject
      await r.event({ type: 'task_notification', taskId: 'task-workflow-ub1235', text: 'not an MCP settle' })
      // A workflow lets go at its own `task_completed`, which marks its R86 delivery itself.
      expect(r.managed.piBackgroundTaskKinds?.get('task-workflow-ub1235')).toBe('workflow')
      expect(r.managed.hostDeliveriesDue?.has('task-workflow-ub1235') ?? false).toBe(false)
      expect((await r.settled()).settled).toBe(false)
    } finally {
      r.cleanup()
    }
  }, 20_000)
})
