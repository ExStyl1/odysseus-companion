/**
 * UA4.1 — `SessionConductorHost` (`tasks/conductor-host.ts`) under the real `TaskRunner`: the three settle arms of a
 * queue-mode send raced on `onAck`, the settlement gate, the interrupt-pauses rule, and the child's folder, project
 * and announcement against a REAL SessionManager (plan UA4.1 "Tests", `conductor-host.test.ts`; the upstream
 * `sessions/session-created-notify.test.ts` is rewritten here as the `session_created` case).
 *
 * Positive: `max_parallel: 2` dispatches both nodes before either completes; a settled door completes the node; the
 * child is created in the orchestrator's folder and project and announced.
 * Negative: a send resolved without an ack fails the node "not delivered"; an error after the ack is reported once; a
 * rejection before the ack fails the node with it once; an interrupted child pauses the run; an unsettled door (turn,
 * goal, cron, running background task, unreadable registry) defers; no `createSession` carries `workingDirectory`;
 * `spec.project` is never the child's.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { readRunLog, saveTaskSpec, parseTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
// UA12.129 — the CASE-shaped budget: the one use below (the real-SessionManager describe) is the
// third argument of an `it()` case, and F1.668 refuses the hook-shaped name there. Measured
// 2026-10-03 (junit): that case ran 46.38 ms, ~6500x under CASE's 300 000.
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { TaskRunner } from '../TaskRunner'
import { createSessionConductorHost, getConductorRunner, PROMPT_NOT_DELIVERED, type ConductorSessionManager } from '../conductor-host'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw)
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues))
  return r.data
}

type SendArm = 'ack-pending' | 'ack-then-reject' | 'resolve-no-ack' | 'reject-before-ack'

/** A structural SessionManager: records every call; the test drives completions and the settlement facts. */
class FakeSessionManager {
  readonly listeners = new Set<(evt: SessionCompletionEvent) => void>()
  readonly created: { id: string; options: CreateSessionOptions }[] = []
  readonly announced: string[] = []
  readonly sends: { sessionId: string; message: string; options: unknown; context: unknown }[] = []
  readonly statuses: { sessionId: string; status: string }[] = []
  arm: SendArm = 'ack-pending'
  settled = true
  goalActive = false
  crons = 0
  runningTasks = 0
  registry = true
  private n = 0

  async createSession(_ws: string, options: CreateSessionOptions) {
    const id = `child-${options.name}-${++this.n}`
    this.created.push({ id, options })
    return { id }
  }
  announceSessionCreated(sessionId: string) { this.announced.push(sessionId) }
  sendMessage(sessionId: string, message: string, _a: unknown, _b: unknown, options: unknown, _c: unknown, _d: unknown,
    onAck?: (id: string) => void, context?: unknown): Promise<void> {
    this.sends.push({ sessionId, message, options, context })
    switch (this.arm) {
      case 'ack-pending': onAck?.('m'); return new Promise<void>(() => {})
      case 'ack-then-reject': onAck?.('m'); return Promise.reject(new Error('turn blew up'))
      case 'resolve-no-ack': return Promise.resolve()
      case 'reject-before-ack': return Promise.reject(new Error('session busy elsewhere'))
    }
  }
  async setSessionStatus(sessionId: string, status: string) { this.statuses.push({ sessionId, status }) }
  async setKanbanColumn() {}
  async setTaskNodeCount() {}
  async cancelProcessing() {}
  onSessionComplete(listener: (evt: SessionCompletionEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** UA12.50 — the children this fake created read as sessions; the ids here read `isProcessing`. */
  readonly processing = new Set<string>()
  getSessions() {
    return [{ id: 'orch', permissionMode: 'default' }, ...this.created.map(c => ({ id: c.id, isProcessing: this.processing.has(c.id) }))]
  }
  async getPiHarnessRuntimeSnapshot() {
    return { settlement: { settled: this.settled }, ...(this.goalActive ? { goal: { status: 'active' } } : {}) }
  }
  getProjectHandleService() { return undefined }
  listSessionScheduledWork() {
    if (!this.registry) return undefined
    return {
      crons: Array.from({ length: this.crons }, (_, i) => ({ id: `c${i}`, schedule: '* * * * *', recurring: true, prompt: 'p' })),
      tasks: Array.from({ length: this.runningTasks }, (_, i) => ({ id: `t${i}`, type: 'monitor', status: 'running', description: 'd' })),
    }
  }
  complete(sessionId: string, evt: Partial<SessionCompletionEvent> = {}) {
    for (const l of [...this.listeners]) l({ sessionId, workspaceId: 'ws', reason: 'complete', ...evt })
  }
}

function rig(tag: string, spec: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), `ua4-1-host-${tag}-`))
  roots.push(root)
  saveTaskSpec(root, specOf(spec))
  const sm = new FakeSessionManager()
  const runner = new TaskRunner({
    host: createSessionConductorHost(sm as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: root }),
    workspaceId: 'ws',
    workspaceRoot: root,
  })
  const finished = (slug: string, runId: string) => readRunLog(root, slug, runId).filter(e => e.kind === 'node-finished' || e.kind === 'node-retry')
  return { sm, runner, root, finished }
}

const two = (id: string, maxParallel: number) => ({ id, title: id, goal: 'g', max_parallel: maxParallel, nodes: [{ id: 'x', prompt: 'x' }, { id: 'y', prompt: 'y' }] })
const one = (id: string, node: Record<string, unknown> = {}) => ({ id, title: id, goal: 'g', nodes: [{ id: 'a', prompt: 'a', ...node }] })

describe('UA4.1 — SessionConductorHost: delivery, not the turn', () => {
  it('max_parallel: 2 dispatches BOTH nodes before either completes (the send returns at the ack)', async () => {
    const { sm, runner } = rig('par2', two('par2', 2))
    await runner.run('par2', { runId: 'r1' })
    await tick()
    expect(sm.sends.map(s => s.sessionId).sort()).toEqual(['child-x-1', 'child-y-2'])
    expect(runner.getRunState('par2', 'r1')!.nodes.map(n => n.state)).toEqual(['running', 'running'])
    // Control: max_parallel 1 holds the second until the first completes.
    const ctl = rig('par1', two('par1', 1))
    await ctl.runner.run('par1', { runId: 'r1' })
    await tick()
    expect(ctl.sm.sends).toHaveLength(1)
  })

  it('every Conductor send is queue mode, addressed to the runner\'s workspace', async () => {
    const { sm, runner } = rig('queue', one('queue'))
    await runner.run('queue', { runId: 'r1' })
    await tick()
    expect(sm.sends[0]).toMatchObject({ options: { midStreamOverride: 'queue' }, context: { workspaceId: 'ws' } })
  })

  it('a send RESOLVED without an ack fails the node "not delivered", exactly once', async () => {
    const { sm, runner, finished } = rig('noack', one('noack'))
    sm.arm = 'resolve-no-ack'
    await runner.run('noack', { runId: 'r1' })
    await tick(); await tick()
    expect(finished('noack', 'r1')).toEqual([
      expect.objectContaining({ kind: 'node-finished', nodeId: 'a', state: 'failed', reason: `dispatch failed: ${PROMPT_NOT_DELIVERED}` }),
    ])
    expect(runner.getRunState('noack', 'r1')!.status).toBe('failed')
  })

  it('a rejection BEFORE the ack fails the node with that error, exactly once', async () => {
    const { sm, runner, finished } = rig('prerej', one('prerej'))
    sm.arm = 'reject-before-ack'
    await runner.run('prerej', { runId: 'r1' })
    await tick(); await tick()
    expect(finished('prerej', 'r1')).toEqual([
      expect.objectContaining({ kind: 'node-finished', state: 'failed', reason: 'dispatch failed: session busy elsewhere' }),
    ])
  })

  it('an error AFTER the ack gives exactly one node-finished (and with retry, exactly one node-retry)', async () => {
    const { sm, runner, finished } = rig('postrej', one('postrej'))
    sm.arm = 'ack-then-reject'
    await runner.run('postrej', { runId: 'r1' })
    await tick(); await tick()
    expect(finished('postrej', 'r1')).toEqual([]) // the rejection itself reports nothing
    sm.complete('child-a-1', { reason: 'error' }) // the turn's outcome, through the seam
    await tick()
    expect(finished('postrej', 'r1')).toEqual([expect.objectContaining({ kind: 'node-finished', state: 'failed', reason: 'error' })])

    const retried = rig('postrej2', one('postrej2', { retry: { limit: 1 } }))
    retried.sm.arm = 'ack-then-reject'
    await retried.runner.run('postrej2', { runId: 'r1' })
    await tick(); await tick()
    retried.sm.complete('child-a-1', { reason: 'error' })
    await tick()
    expect(retried.finished('postrej2', 'r1')).toEqual([expect.objectContaining({ kind: 'node-retry', nodeId: 'a' })])
  })

  it('an interrupted child pauses the run, and Resume re-dispatches it', async () => {
    const { sm, runner } = rig('intr', one('intr'))
    await runner.run('intr', { runId: 'r1' })
    await tick()
    sm.complete('child-a-1', { reason: 'interrupted' })
    await tick()
    expect(runner.getRunState('intr', 'r1')!.status).toBe('paused')
    await runner.resume('intr', 'r1')
    await tick()
    expect(sm.created.map(c => c.id)).toEqual(['child-a-1', 'child-a-2'])
    expect(runner.getRunState('intr', 'r1')!.status).toBe('running')
  })
})

describe('UA4.1 — SessionConductorHost: the settlement gate', () => {
  for (const [label, unsettle] of [
    ['the runtime settlement says unsettled', (sm: FakeSessionManager) => { sm.settled = false }],
    ['an ACTIVE goal', (sm: FakeSessionManager) => { sm.goalActive = true }],
    ['a live cron', (sm: FakeSessionManager) => { sm.crons = 1 }],
    ['a running background task (monitor)', (sm: FakeSessionManager) => { sm.runningTasks = 1 }],
    ['an unreadable task registry (fail-closed)', (sm: FakeSessionManager) => { sm.registry = false }],
  ] as const) {
    it(`an idle door with ${label} DEFERS completion; the next settled door completes it`, async () => {
      const slug = `gate-${label.replace(/[^a-z]/g, '').slice(0, 20)}`
      const { sm, runner } = rig(slug, one(slug))
      await runner.run(slug, { runId: 'r1' })
      await tick()
      unsettle(sm)
      sm.complete('child-a-1', { finalText: 'ANSWER' })
      await tick(); await tick()
      expect(runner.getRunState(slug, 'r1')!.nodes[0]!.state).toBe('running')
      Object.assign(sm, { settled: true, goalActive: false, crons: 0, runningTasks: 0, registry: true })
      sm.complete('child-a-1', {})
      await tick(); await tick()
      expect(runner.getRunState(slug, 'r1')!.status).toBe('completed')
    })
  }
})

describe('UA4.1 — SessionConductorHost over a REAL SessionManager: the child\'s folder, project and announcement', () => {
  it('the child is created in the orchestrator\'s folder (a handle, never workingDirectory) and project, never spec.project, and is announced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ua4-1-real-'))
    roots.push(root)
    const workspaceId = `ws-ua4-1-${Math.random().toString(36).slice(2, 8)}`
    const workspaceService = {
      resolve: (id: string) => ({
        id,
        workspaceRootPath: join(root, 'workspaces', id),
        sessionRootPath: join(root, 'sessions', id),
        config: { id, name: id, createdAt: 1, updatedAt: 1 },
        lastAccessedAt: 1,
      }),
      listResolved: () => [],
    } as unknown as WorkspaceService
    const real = createTestSessionManager({ workspaceService })
    const events: unknown[] = []
    real.setEventSink(((_channel: string, _target: unknown, event: unknown) => { events.push(event) }) as never)
    const folder = mkdtempSync(join(tmpdir(), 'ua4-1-folder-'))
    roots.push(folder)
    const handles = real.getProjectHandleService()
    const issued = await handles.validateProjectDirectory(workspaceId, folder)
    await handles.setProjectTrust({ workspaceId, projectHandleId: issued.id }, 'trusted')
    const projOrch = createProject(join(root, 'workspaces', workspaceId), { name: 'Orch' }).id // UA5.4 — createSession checks the project entity
    const orchestrator = await real.createSession(workspaceId, { name: 'orch', projectHandleId: issued.id, projectId: projOrch, permissionMode: 'default' })

    const createCalls: CreateSessionOptions[] = []
    const fake = new FakeSessionManager()
    // Real create/list/handles/announce; the turn machinery is the fake's (no backend runs in this process).
    const hybrid = {
      ...Object.fromEntries(['setSessionStatus', 'setKanbanColumn', 'setTaskNodeCount', 'cancelProcessing', 'onSessionComplete',
        'getPiHarnessRuntimeSnapshot', 'listSessionScheduledWork', 'sendMessage'].map(k => [k, (fake as unknown as Record<string, (...a: unknown[]) => unknown>)[k]!.bind(fake)])),
      createSession: (ws: string, options: CreateSessionOptions) => { createCalls.push(options); return real.createSession(ws, options) },
      announceSessionCreated: real.announceSessionCreated.bind(real),
      getSessions: real.getSessions.bind(real),
      getProjectHandleService: real.getProjectHandleService.bind(real),
    } as unknown as ConductorSessionManager
    const wsRoot = join(root, 'workspaces', workspaceId)
    saveTaskSpec(wsRoot, specOf({ id: 'real', title: 'real', goal: 'g', project: 'proj-spec', nodes: [{ id: 'a', prompt: 'a' }] }))
    const runner = getConductorRunner(hybrid, { workspaceId, workspaceRoot: wsRoot })
    expect(getConductorRunner(hybrid, { workspaceId, workspaceRoot: wsRoot })).toBe(runner) // one runner per workspace
    await runner.run('real', { runId: 'r1', orchestratorSessionId: orchestrator.id })
    for (let i = 0; i < 50 && createCalls.length === 0; i++) await tick()
    for (let i = 0; i < 50 && fake.sends.length === 0; i++) await tick()

    expect(createCalls).toHaveLength(1)
    expect('workingDirectory' in createCalls[0]!).toBe(false)
    expect(createCalls[0]).toMatchObject({ parentSessionId: orchestrator.id, projectId: projOrch, taskSlug: 'real', taskRunId: 'r1', taskNodeId: 'a' })
    const childId = runner.getRunState('real', 'r1')!.nodes[0]!.sessionId!
    const child = real.getSessions(workspaceId).find(s => s.id === childId)!
    const orch = real.getSessions(workspaceId).find(s => s.id === orchestrator.id)!
    expect(child.workingDirectory).toBe(orch.workingDirectory)
    expect(child.projectId).toBe(projOrch)
    expect(child.parentSessionId).toBe(orchestrator.id)
    expect(events).toContainEqual({ type: 'session_created', sessionId: childId })
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})

// UA5.4 — appended; imports are hoisted.
import { createProject } from '@nessy-agent/shared/projects'

describe('UA12.50 — a send delivered and then rejected with no completion fails the node once', () => {
  const GRACE = 20
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  function rejectRig(tag: string, node: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), `ua12-50-${tag}-`))
    roots.push(root)
    saveTaskSpec(root, specOf(one(tag, node)))
    const sm = new FakeSessionManager()
    sm.arm = 'ack-then-reject'
    const runner = new TaskRunner({
      host: createSessionConductorHost(sm as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: root, afterDeliveryFailureGraceMs: GRACE }),
      workspaceId: 'ws',
      workspaceRoot: root,
    })
    const finished = () => readRunLog(root, tag, 'r1').filter(e => e.kind === 'node-finished' || e.kind === 'node-retry')
    return { sm, runner, finished }
  }

  it('CONTROL: acked, rejected, nothing emitted, the child idle -> the node fails exactly once after the grace', async () => {
    const { runner, finished } = rejectRig('idle')
    await runner.run('idle', { runId: 'r1' })
    await tick(); await tick()
    expect(finished()).toEqual([]) // nothing before the grace: a completion may still be on its way
    await wait(GRACE * 4)
    expect(finished()).toEqual([expect.objectContaining({ kind: 'node-finished', nodeId: 'a', state: 'failed', reason: 'error' })])
    expect(runner.getRunState('idle', 'r1')!.status).toBe('failed')
    await wait(GRACE * 2)
    expect(finished()).toHaveLength(1)
  })

  it('CONTROL (retry): the synthetic failure is an ordinary error — one node-retry, and the retry runs in a new child', async () => {
    const { sm, runner, finished } = rejectRig('retry', { retry: { limit: 1 } })
    await runner.run('retry', { runId: 'r1' })
    await wait(GRACE * 4)
    expect(finished()[0]).toMatchObject({ kind: 'node-retry', nodeId: 'a' })
    expect(sm.created.map(c => c.id)).toEqual(['child-a-1', 'child-a-2'])
  })

  it('NEGATIVE: the real completion arrives (before the grace ends) -> exactly one node-finished, no synthetic after it', async () => {
    const { sm, runner, finished } = rejectRig('real')
    await runner.run('real', { runId: 'r1' })
    await tick(); await tick()
    sm.complete('child-a-1', { reason: 'error' })
    await wait(GRACE * 4)
    expect(finished()).toEqual([expect.objectContaining({ kind: 'node-finished', state: 'failed', reason: 'error' })])
    expect(sm.listeners.size).toBe(0) // the run ended and the send's watcher let go: nothing left subscribed
  })

  it('NEGATIVE: the child is still processing at the re-read -> no synthetic (its own turn reports through the seam)', async () => {
    const { sm, runner, finished } = rejectRig('busy')
    await runner.run('busy', { runId: 'r1' })
    await tick()
    sm.processing.add('child-a-1')
    await wait(GRACE * 4)
    expect(finished()).toEqual([])
    expect(runner.getRunState('busy', 'r1')!.nodes[0]!.state).toBe('running')
    sm.complete('child-a-1', { finalText: 'late answer' })
    await tick(); await tick()
    expect(runner.getRunState('busy', 'r1')!.status).toBe('completed')
  })
})

describe('UA12.75 — the host forwards an abandoned child\'s card withdrawal to SessionManager', () => {
  it('withdrawPendingApproval calls withdrawAbandonedTaskChildApproval in the host\'s workspace; a throw there never rejects', async () => {
    const calls: [string, string][] = []
    const sm = Object.assign(new FakeSessionManager(), {
      async withdrawAbandonedTaskChildApproval(sessionId: string, workspaceId: string) { calls.push([sessionId, workspaceId]); return true },
    })
    const host = createSessionConductorHost(sm as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: '/nowhere' })
    await host.withdrawPendingApproval!('child-a-1')
    expect(calls).toEqual([['child-a-1', 'ws']])
    // Boundary: a manager that throws, and one without the method, both resolve (Resume must not fail on a card).
    const throwing = Object.assign(new FakeSessionManager(), { async withdrawAbandonedTaskChildApproval() { throw new Error('disk gone') } })
    await expect(createSessionConductorHost(throwing as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: '/nowhere' })
      .withdrawPendingApproval!('child-a-1')).resolves.toBeUndefined()
    await expect(createSessionConductorHost(new FakeSessionManager() as unknown as ConductorSessionManager, { workspaceId: 'ws', workspaceRoot: '/nowhere' })
      .withdrawPendingApproval!('child-a-1')).resolves.toBeUndefined()
  })
})
