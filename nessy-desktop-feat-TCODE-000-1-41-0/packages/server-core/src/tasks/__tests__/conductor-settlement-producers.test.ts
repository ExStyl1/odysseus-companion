/**
 * UA4.8 — node completion vs background producers (plan UA4.8, spec §11 item 4): the settlement gate fixed for the
 * producers the host CAN see, and the re-check that lets a deferred node complete when its producer ends without
 * starting another turn.
 *
 * Measured at HEAD before this row (the readings are in the lane report): the gate counted the runtime settlement,
 * an active goal, crons and every `running` registry task. It never read the backend's own between-turns level
 * (`AgentBackend.backgroundWorkCount`: a Claude background `Agent`/`Workflow`/`Bash`, a codex background terminal),
 * so a Claude node that backgrounded a subagent was accepted at its first idle door while the subagent still ran.
 * And a door it DID defer waited for "the next idle door" alone, which never comes when the producer ends without a
 * host turn: a Claude task's end is delivered in a turn the CLI opens itself (no host `complete`, F1.492), codex has
 * no between-turns channel at all, and a Claude or codex background shell's registry entry never retires (no
 * supervisor record proves its exit, L7) — so such a node stayed `running` for good.
 *
 * Positive: backend activity defers the door, and the re-check completes the node with the deferred text once the
 * activity ends, with no second door; a `shell` registry entry alone no longer holds a settled session; the real
 * `SessionManager.getBackendBackgroundActivity` reads the activity level, then the liveness level, then zero.
 * Negative: activity that does not end never completes the node; a `monitor` entry still defers; a session the host
 * cannot read (`undefined`) defers; a node stopped while deferred is not completed by a late re-check, and a
 * completed node logs exactly one `node-finished`.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { readNodeOutput, readRunLog, saveTaskSpec, parseTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import { createManagedSession } from '../../sessions/SessionManager.ts'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { TaskRunner } from '../TaskRunner'
import { createSessionConductorHost, type ConductorSessionManager } from '../conductor-host'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RECHECK_MS = 5

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw)
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues))
  return r.data
}

/** A structural SessionManager: the test sets each settlement fact; nothing completes unless the test says so. */
class FakeSessionManager {
  readonly listeners = new Set<(evt: SessionCompletionEvent) => void>()
  settled = true
  monitors = 0
  shells = 0
  /** UA12.156 — the dynamic-cron records `listSessionScheduledWork` answers (a pending wake is one). */
  crons: Array<{ id: string; schedule: string; recurring: boolean; prompt: string }> = []
  /** `getBackendBackgroundActivity`'s answer; `undefined` = the host cannot read the session. */
  backend: number | undefined = 0
  backendReads = 0
  private n = 0
  async createSession(_ws: string, options: CreateSessionOptions) { return { id: `child-${options.name}-${++this.n}` } }
  announceSessionCreated() {}
  sendMessage(_s: string, _m: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void): Promise<void> {
    onAck?.('m')
    return new Promise<void>(() => {})
  }
  async setSessionStatus() {}
  async setKanbanColumn() {}
  async setTaskNodeCount() {}
  async cancelProcessing() {}
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSessions() { return [{ id: 'orch', permissionMode: 'default' }] }
  async getPiHarnessRuntimeSnapshot() { return { settlement: { settled: this.settled } } }
  getProjectHandleService() { return undefined }
  listSessionScheduledWork() {
    return {
      crons: this.crons,
      tasks: [
        ...Array.from({ length: this.monitors }, (_, i) => ({ id: `m${i}`, type: 'monitor', status: 'running', description: 'watch' })),
        ...Array.from({ length: this.shells }, (_, i) => ({ id: `claude-task-${i}`, type: 'shell', status: 'running', description: 'npm test' })),
      ],
    }
  }
  getBackendBackgroundActivity() { this.backendReads += 1; return this.backend }
  /** `hasHostTurnDueOrRunning`'s answer: a host delivery turn is due (Pi R86) or a turn runs. */
  hostTurnDue = false
  hasHostTurnDueOrRunning() { return this.hostTurnDue }
  complete(sessionId: string, evt: Partial<SessionCompletionEvent> = {}) {
    for (const l of [...this.listeners]) l({ sessionId, workspaceId: 'ws', reason: 'complete', ...evt })
  }
}

function rig(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua4-8-${tag}-`))
  roots.push(root)
  saveTaskSpec(root, specOf({ id: tag, title: tag, goal: 'g', nodes: [{ id: 'a', prompt: 'a' }] }))
  const sm = new FakeSessionManager()
  const runner = new TaskRunner({
    host: createSessionConductorHost(sm as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: root }),
    workspaceId: 'ws',
    workspaceRoot: root,
    settlementRecheckMs: RECHECK_MS,
  })
  const node = () => runner.getRunState(tag, 'r1')!.nodes[0]!
  const finished = () => readRunLog(root, tag, 'r1').filter(e => e.kind === 'node-finished')
  return { sm, runner, node, finished, root }
}

describe('UA4.8 — the gate reads the backend\'s between-turns activity', () => {
  it('a background agent defers the door; when it ends the re-check completes the node with the deferred text, no second door', async () => {
    const { sm, runner, node, finished, root } = rig('bg-agent')
    await runner.run('bg-agent', { runId: 'r1' })
    await sleep(0)
    sm.backend = 1
    sm.complete('child-a-1', { finalText: 'STARTED THE AGENT' })
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('running')
    sm.backend = 0 // the CLI's own turn delivered the result: no host `complete` follows
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('done')
    expect(finished()).toHaveLength(1)
    expect(readRunLog(root, 'bg-agent', 'r1').some(e => e.kind === 'node-woke-after-done')).toBe(false)
  })

  it('activity that never ends never completes the node (the re-check keeps reading)', async () => {
    const { sm, runner, node } = rig('bg-forever')
    await runner.run('bg-forever', { runId: 'r1' })
    await sleep(0)
    sm.backend = 2
    sm.complete('child-a-1', { finalText: 'X' })
    const before = sm.backendReads
    await sleep(RECHECK_MS * 10)
    expect(node().state).toBe('running')
    expect(sm.backendReads).toBeGreaterThan(before + 1)
    await runner.stop('bg-forever', 'r1')
  })

  it('a session the host cannot read defers (fail-closed)', async () => {
    const { sm, runner, node } = rig('bg-unread')
    await runner.run('bg-unread', { runId: 'r1' })
    await sleep(0)
    sm.backend = undefined
    sm.complete('child-a-1', { finalText: 'X' })
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('running')
    await runner.stop('bg-unread', 'r1')
  })
})

describe('UA4.8 — a background shell is read from its producer, not from the latched registry entry', () => {
  it('a shell entry alone (no backend activity, runtime settled) no longer holds the node', async () => {
    const { sm, runner, node } = rig('shell-latched')
    await runner.run('shell-latched', { runId: 'r1' })
    await sleep(0)
    sm.shells = 1
    sm.complete('child-a-1', { finalText: 'DONE' })
    await sleep(RECHECK_MS * 4)
    expect(node().state).toBe('done')
  })

  it('a monitor entry still defers (control on the same instrument)', async () => {
    const { sm, runner, node } = rig('monitor-live')
    await runner.run('monitor-live', { runId: 'r1' })
    await sleep(0)
    sm.monitors = 1
    sm.complete('child-a-1', { finalText: 'WATCHING' })
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('running')
    sm.monitors = 0 // the watch ended without an event: the re-check, not a door, completes it
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('done')
  })
})

describe('UA4.8 — the re-check never outlives its node', () => {
  it('a node stopped while deferred is not completed by a late re-check', async () => {
    const { sm, runner, node, finished } = rig('stopped')
    await runner.run('stopped', { runId: 'r1' })
    await sleep(0)
    sm.backend = 1
    sm.complete('child-a-1', { finalText: 'X' })
    await sleep(RECHECK_MS * 2)
    await runner.stop('stopped', 'r1')
    sm.backend = 0
    await sleep(RECHECK_MS * 6)
    expect(node().state).not.toBe('done')
    expect(finished().filter(e => 'state' in e && e.state === 'done')).toHaveLength(0)
  })

  it('a door and a re-check landing together complete the node once', async () => {
    const { sm, runner, finished } = rig('once')
    await runner.run('once', { runId: 'r1' })
    await sleep(0)
    sm.backend = 1
    sm.complete('child-a-1', { finalText: 'X' })
    await sleep(RECHECK_MS * 2)
    sm.backend = 0
    sm.complete('child-a-1', {})
    await sleep(RECHECK_MS * 6)
    expect(finished()).toHaveLength(1)
  })
})

describe('UA4.8 — SessionManager.getBackendBackgroundActivity over a REAL SessionManager', () => {
  it('reads the activity level, then the liveness level, then zero; undefined for a session it does not hold', async () => {
    const real = createTestSessionManager()
    try {
      const session = await real.createSession('ws-ua4-8', { name: 'node' })
      const managed = (real as unknown as { getManaged(id: string): { agent: unknown } | undefined }).getManaged(session.id)!
      const read = () => (real as unknown as { getBackendBackgroundActivity(id: string, ws?: string): number | undefined })
        .getBackendBackgroundActivity(session.id, 'ws-ua4-8')
      expect(read()).toBe(0) // no agent yet: nothing is held
      managed.agent = { backgroundWorkCount: () => 2, backgroundActivityCount: () => 1 }
      expect(read()).toBe(1) // claude: ambient tasks are not activity
      managed.agent = { backgroundWorkCount: () => 2 }
      expect(read()).toBe(2) // codex: every background terminal is activity
      managed.agent = {}
      expect(read()).toBe(0) // pi: its background work is in host maps the gate already reads
      expect((real as unknown as { getBackendBackgroundActivity(id: string): number | undefined })
        .getBackendBackgroundActivity('no-such-session')).toBeUndefined()
    } finally {
      real.cleanup()
    }
  })
})

describe('UA4.8 follow-up — a re-check never completes a node while a host delivery turn is due (the Pi R86 window)', () => {
  // The window: `task_completed` deletes the evaluator kind, then awaits the task store and R86's delivery send, which
  // flushes the session to disk before `setProcessing(true)`. Every other gate input reads settled in between; a
  // re-check landing there completed the node with the pre-background text and the delivery turn woke a done node.
  it('the re-check waits through the window; the delivery turn\'s own door completes the node with ITS text', async () => {
    const { sm, runner, node, root } = rig('r86-window')
    await runner.run('r86-window', { runId: 'r1' })
    await sleep(0)
    sm.settled = false // the backgrounded subagent's evaluator entry
    sm.complete('child-a-1', { finalText: 'STARTED THE AGENT' })
    await sleep(RECHECK_MS * 3)
    expect(node().state).toBe('running')
    sm.settled = true // `task_completed` deleted the kind …
    sm.hostTurnDue = true // … and the delivery turn is due, not yet processing
    await sleep(RECHECK_MS * 8)
    expect(node().state).toBe('running')
    sm.hostTurnDue = false // the delivery turn ran and ended: its door
    sm.complete('child-a-1', { finalText: 'THE SUBAGENT FOUND 3 BUGS' })
    await sleep(RECHECK_MS * 3)
    expect(node().state).toBe('done')
    expect(readNodeOutput(root, 'r86-window', 'r1', 'a')?.text).toBe('THE SUBAGENT FOUND 3 BUGS')
    expect(readRunLog(root, 'r86-window', 'r1').some(e => e.kind === 'node-woke-after-done')).toBe(false)
  })

  it('no turn due (boundary): the same settled reads complete the node by the re-check', async () => {
    const { sm, runner, node, root } = rig('r86-none')
    await runner.run('r86-none', { runId: 'r1' })
    await sleep(0)
    sm.settled = false
    sm.complete('child-a-1', { finalText: 'WATCHED' })
    await sleep(RECHECK_MS * 3)
    sm.settled = true
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('done')
    expect(readNodeOutput(root, 'r86-none', 'r1', 'a')?.text).toBe('WATCHED')
  })
})

describe('UA4.8 follow-up — SessionManager.hasHostTurnDueOrRunning over a REAL SessionManager', () => {
  type Managed = {
    agent: unknown
    isProcessing: boolean
    processingGeneration: number
    piBackgroundTaskKinds?: Map<string, string>
  }
  type Real = {
    getManaged(id: string): Managed | undefined
    processEvent(managed: Managed, event: unknown): Promise<void>
    hasHostTurnDueOrRunning(id: string, ws?: string): boolean
  }
  const ended = (taskId: string, status = 'completed') => ({ type: 'task_completed', taskId, status, summary: 'done' })

  it('a background subagent\'s end marks the R86 delivery due until a turn CARRYING it starts; a running turn reads due', async () => {
    const real = createTestSessionManager()
    try {
      const session = await real.createSession('ws-ua4-8b', { name: 'node' })
      const r = real as unknown as Real
      const managed = r.getManaged(session.id)!
      const due = () => r.hasHostTurnDueOrRunning(session.id, 'ws-ua4-8b')
      expect(due()).toBe(false)
      managed.piBackgroundTaskKinds = new Map([['task-1', 'subagent']])
      await r.processEvent(managed, ended('task-1'))
      expect(managed.piBackgroundTaskKinds.has('task-1')).toBe(false) // the evaluator entry is gone …
      expect(due()).toBe(true) // … and the delivery is due (held: this session has no user message yet)
      managed.isProcessing = true
      managed.processingGeneration += 1 // a turn started by hand: it carries no delivery
      expect(due()).toBe(true) // a running turn
      managed.isProcessing = false
      expect(due()).toBe(true) // it ended, and it did not carry the delivery: still due (follow-up 2)
      expect(r.hasHostTurnDueOrRunning('no-such-session')).toBe(true) // fail-closed
    } finally {
      real.cleanup()
    }
  })

  it('no delivery, no mark: a foreground result, a stopped task, and a runtime that delivers the end itself', async () => {
    const real = createTestSessionManager()
    try {
      const session = await real.createSession('ws-ua4-8c', { name: 'node' })
      const r = real as unknown as Real
      const managed = r.getManaged(session.id)!
      const due = () => r.hasHostTurnDueOrRunning(session.id, 'ws-ua4-8c')
      await r.processEvent(managed, ended('run-foreground'))
      expect(due()).toBe(false)
      managed.piBackgroundTaskKinds = new Map([['task-2', 'workflow']])
      await r.processEvent(managed, ended('task-2', 'stopped'))
      expect(due()).toBe(false)
      managed.agent = { deliversBackgroundTaskEndsItself: true }
      managed.piBackgroundTaskKinds = new Map([['task-3', 'subagent']])
      await r.processEvent(managed, ended('task-3'))
      expect(due()).toBe(false)
    } finally {
      real.cleanup()
    }
  })
})

describe('UA4.8 follow-up 2 — a due mark outlives a turn that does not CARRY its delivery (two close Pi ends)', () => {
  // The verifier's window (f89fdc465 counted a mark only until ANY turn started): a Pi background end stamps its mark,
  // then — before its delivery is queued — an unrelated turn starts (another end's delivery, a user message). The mark
  // went stale with that turn, and between its end and the turn that really carries the delivery every gate input read
  // settled. Driven on the REAL `sendMessage` / `deliverMonitorEvent` / `onProcessingStopped` path over a parked stub
  // agent (the rig of `late-abort-ends-only-its-turn.test.ts`); only the capability turn and disk writes are stubbed.
  type Gen = { input: string; parked: Promise<void>; release: () => void }
  async function liveRig(sessionId: string) {
    const stateRoot = mkdtempSync(join(tmpdir(), 'ua48-carry-'))
    roots.push(stateRoot)
    const workspace = { id: 'ws-ua48-carry', name: 'UA4.8', slug: 'ua48', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const manager = createTestSessionManager()
    const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true }) as unknown as {
      id: string
      isProcessing: boolean
      messages: Array<Record<string, unknown>>
      piBackgroundTaskKinds?: Map<string, string>
      agent: unknown
    }
    const internals = manager as unknown as Record<string, unknown> & {
      sessions: Map<string, unknown>
      piTaskServices: Map<string, unknown>
      managedKey(m: unknown): string
      processEvent(m: unknown, event: unknown): Promise<void>
      hasHostTurnDueOrRunning(id: string, ws?: string): boolean
    }
    internals.sessions.set(`${workspace.id}:${managed.id}`, managed)
    manager.setEventSink((() => {}) as Parameters<typeof manager.setEventSink>[0])
    internals.persistSession = () => {}
    manager.flushSession = async () => {}
    internals.acquireCapabilityTurn = async () => () => {}
    internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'ua48-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
    internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })
    managed.messages.push({ id: 'u0', role: 'user', content: 'run the node', timestamp: 0 })
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
    const send = (text: string) => manager.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
    const due = () => internals.hasHostTurnDueOrRunning(managed.id, workspace.id)
    const ended = (taskId: string) => internals.processEvent(managed, { type: 'task_completed', taskId, status: 'completed', summary: `${taskId} found 3 bugs` })
    return { manager, managed, internals, generators, generator, idle, send, due, ended, cleanup: () => manager.cleanup() }
  }

  it('A\'s delivery queued behind an unrelated turn stays due until the turn that carries it starts, then that turn clears it', async () => {
    const r = await liveRig('ua48-carry-busy')
    try {
      r.managed.piBackgroundTaskKinds = new Map([['task-A', 'subagent']])
      // A's handler awaits the task store between its mark and its delivery — the await an unrelated turn starts in.
      let storeWritten!: () => void
      const store = new Promise<void>(resolve => { storeWritten = resolve })
      r.internals.piTaskServices.set(r.internals.managedKey(r.managed), {
        snapshot: () => ({ tasks: [{ id: 'task-A', status: 'running' }] }),
        execute: () => store,
      })
      const endA = r.ended('task-A')
      expect(r.due()).toBe(true) // marked, evaluator entry gone
      void r.send('an unrelated turn') // carries nothing of A's
      const unrelated = await r.generator(0)
      expect(unrelated.input).not.toContain('task-A')
      storeWritten()
      await endA // A's text is queued behind the running turn
      const flush = r.internals.flushPendingTaskNotifications as (m: unknown) => Promise<void>
      const readings: boolean[] = []
      r.internals.flushPendingTaskNotifications = async function (this: unknown, m: unknown) {
        readings.push(r.due()) // the window: the unrelated turn has ended, A's delivery turn has not started
        return flush.call(this, m)
      }
      unrelated.release()
      const delivery = await r.generator(1)
      expect(readings).toEqual([true])
      expect(delivery.input).toContain('Background subagent task task-A finished (completed).')
      expect(r.due()).toBe(true) // A's delivery turn runs
      delivery.release()
      await r.idle()
      await sleep(20)
      expect(r.due()).toBe(false) // boundary: the turn that carried A cleared its mark — the node is not held for good
    } finally {
      r.cleanup()
    }
  })

  it('the send-start variant: A\'s delivery queued as a follow-up of another send stays due across that turn\'s end', async () => {
    const r = await liveRig('ua48-carry-sendstart')
    try {
      r.managed.piBackgroundTaskKinds = new Map([['task-A', 'subagent']])
      void r.send('an unrelated turn') // holds the send-start boundary
      await r.ended('task-A') // its flush meets that boundary: queued (`followUpDuringSendStart`)
      const unrelated = await r.generator(0)
      expect(unrelated.input).not.toContain('task-A')
      const next = r.internals.processNextQueuedMessage as (id: string, ws?: string) => void
      const readings: boolean[] = []
      r.internals.processNextQueuedMessage = function (this: unknown, id: string, ws?: string) {
        next.call(this, id, ws)
        readings.push(r.due()) // shifted, not yet started: the queue is empty and no turn runs
      }
      unrelated.release()
      const delivery = await r.generator(1)
      expect(readings).toEqual([true])
      expect(delivery.input).toContain('Background subagent task task-A finished (completed).')
      delivery.release()
      await r.idle()
      await sleep(20)
      expect(r.due()).toBe(false)
    } finally {
      r.cleanup()
    }
  })
})

/**
 * UA12.156 (SIT-D F6, the W/pi-wakeup re-run) — the sitting read "the node's wake is scheduled but no
 * marker and no later turn; woke-after-done 0, node done early" as the gate losing a scheduled wake. The
 * measured reading corrects the premise: the child called `ScheduleWakeup {delaySeconds:30}` with NO
 * self-paced loop in its session, and the host's cron port REFUSED the call — `rearmWakeup` throws
 * 'No self-paced /loop is active in this session.' (the shipped R39 contract: the tool "reschedules the
 * next iteration of a self-paced /loop" and "you don't call it directly"; a bare wake has no prompt to
 * deliver, so arming one would be a wake with nothing to wake). Instrument: `grep -ac
 * scheduled_work_changed` over the sitting's events.jsonl = 0 — a successful rearm nudges
 * (`SessionManager` rearm → `emitScheduledWorkChanged`), and no scheduled-work event exists anywhere in
 * the sitting; the surviving judge sub-session transcript (28b36403) shows the call passed the judge at
 * 09:19:07 and nothing was armed after it.
 *
 * What these arms PIN: the wake half of the mechanism the row asks about, on the gate's own inputs.
 * When a loop IS armed, the pending wake is a dynamic cron record — `listSessionScheduledWork().crons`
 * carries it (the real seam, arm 2), the gate defers the node's idle door (arm 1), the wake's delivery
 * turn completes the node with ITS text (arm 1, the "lands a turn" half), and the sitting's shape — no
 * loop, a refused call — leaves the registry EMPTY and settles the node at its turn's end (arm 2),
 * which is correct, not a defect. The residue is stated in `tasks.backgroundWorkHint`: a wake holds a
 * subtask only as part of a self-paced /loop.
 */
describe('UA12.156 — a Pi ScheduleWakeup wake: the gate holds the node and the wake turn completes it', () => {
  it('a pending wake (a dynamic cron record) defers the door; the wake turn\'s own door completes the node with ITS text, no woke-after-done', async () => {
    const { sm, runner, node, root } = rig('wake-holds')
    await runner.run('wake-holds', { runId: 'r1' })
    await sleep(0)
    sm.crons = [{ id: 'dyn1', schedule: 'dynamic', recurring: true, prompt: 'next iteration' }]
    sm.complete('child-a-1', { finalText: 'BG-STARTED' })
    await sleep(RECHECK_MS * 6)
    expect(node().state).toBe('running') // the wake has not fired: the door is deferred
    sm.crons = [] // the loop ended (stop: true / no re-arm): the wake's delivery turn starts…
    sm.complete('child-a-1', { finalText: 'WOKE' }) // …and ITS door, not a re-check, completes the node
    await sleep(RECHECK_MS * 3)
    expect(node().state).toBe('done')
    expect(readNodeOutput(root, 'wake-holds', 'r1', 'a')?.text).toBe('WOKE')
    expect(readRunLog(root, 'wake-holds', 'r1').some(e => e.kind === 'node-woke-after-done')).toBe(false)
  })
})

describe('UA12.156 — the ScheduleWakeup seam over a REAL SessionManager (the sitting\'s call, both arms)', () => {
  it('a BARE call is refused by name and arms nothing; an ARMED loop\'s wake is the dynamic record the gate reads', async () => {
    const real = createTestSessionManager()
    try {
      const session = await real.createSession('ws-ua12-156', { name: 'node' })
      const r = real as unknown as {
        getManaged(id: string, ws?: string): unknown
        getOrCreateSessionCronService(managed: unknown): { startSelfPaced(input: { prompt: string }): { id: string } } | undefined
        buildSessionCronPort(managed: unknown, service: unknown): {
          rearmWakeup(input: { delayMs: number }): Promise<{ firesAt: number }>
          stopWakeup(): Promise<boolean>
        }
        listSessionScheduledWork(id: string, ws?: string): { crons: Array<{ id: string; schedule: string; recurring: boolean; prompt: string }>; tasks: unknown[] }
      }
      const managed = r.getManaged(session.id, 'ws-ua12-156')!
      const service = r.getOrCreateSessionCronService(managed)
      expect(service).toBeDefined() // cron is not disabled in tests; the store is the workspace root's
      const port = r.buildSessionCronPort(managed, service!)

      // The sitting's exact call (W/pi-wakeup, 09:19:07): no loop exists — refused, nothing armed, and
      // the scheduled-work registry the gate reads stays EMPTY (the node settles; woke-after-done 0).
      await expect(port.rearmWakeup({ delayMs: 30_000 })).rejects.toThrow('No self-paced /loop is active in this session.')
      expect(r.listSessionScheduledWork(session.id, 'ws-ua12-156').crons).toEqual([])

      // The armed arm: a self-paced loop's rearm creates the pending wake as a dynamic record — the
      // producer `isSessionSettled` reads through `work.crons` — and stopping the loop clears it.
      service!.startSelfPaced({ prompt: 'poll the deploy' })
      const { firesAt } = await port.rearmWakeup({ delayMs: 60_000 })
      expect(firesAt).toBeGreaterThan(Date.now())
      const armed = r.listSessionScheduledWork(session.id, 'ws-ua12-156').crons
      expect(armed).toHaveLength(1)
      expect(armed[0]).toMatchObject({ schedule: 'dynamic', recurring: true, prompt: 'poll the deploy' })
      expect(await port.stopWakeup()).toBe(true)
      expect(r.listSessionScheduledWork(session.id, 'ws-ua12-156').crons).toEqual([])
    } finally {
      real.cleanup()
    }
  })
})
