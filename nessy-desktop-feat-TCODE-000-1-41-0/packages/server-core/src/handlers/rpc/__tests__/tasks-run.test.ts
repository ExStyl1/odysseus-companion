/**
 * UA4.3 — the Conductor's run RPCs (`tasks:run` / `pause` / `resume` / `stop`, `tasks:get`'s live run, and
 * `tasks:getResults`' `interrupted` derivation) and the resume from the run's spec snapshot and recorded params,
 * driven through the registered handlers against a REAL SessionManager and workspace root (plan UA4.3 "Tests",
 * `tasks-run.test.ts`). Only the turn machinery is replaced: `sendMessage` acks at once and never ends, the settlement
 * read answers "settled", and completions are emitted on the SessionManager's own seam.
 *
 * An "app restart" is a SECOND handler registration over a view of the same SessionManager whose completion
 * listeners are its own: the sessions on disk and in the list are the same, the Conductor runner (one per manager,
 * `getConductorRunner`) is new and empty — what a new process sees (measured 2026-10-02, UA-ag probe: a reloaded
 * child keeps its task fields and its `in-progress` column, is not processing, and no completion is emitted at load).
 *
 * Positive: run → per-node state (live in `tasks:get`, `running` in `getResults`); pause → `paused`; a resume after a
 * restart reuses done outputs, runs the SNAPSHOT's DAG with the params the run started with, and moves the child
 * abandoned at shutdown to `todo`; an interrupted run can be stopped.
 * Negative: a second active run on one orchestrator is refused (by run and by a restart resume); after a restart the
 * run reads `interrupted`, never `running`, and nothing is written until Resume; editing or deleting `task.yaml`
 * between the restart and Resume does not change the DAG; a late completion of the abandoned child is ignored; a
 * repair in flight at shutdown re-runs on resume instead of verifying the rejected output, and still as a repair (its
 * rejection reason, rebuilt from the log's `node-retry`; a plain retry gets its failure preamble); an ended run is not
 * resumed; a run with no orchestrator, with a session that is not this task's orchestrator, with a foreign caller, or
 * with a run id that is malformed, taken or unknown is refused.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { listRunIds, readRunLog, taskYamlPath } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { SessionCompletionEvent, SessionManager } from '../../../sessions/SessionManager'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'
import { registerTasksHandlers } from '../tasks'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 5; i++) await tick() }
/** The first real `createSession` of a file pays cold module and store work: wait for the fact, bounded. */
const waitFor = async (fact: () => boolean) => { for (let i = 0; i < 400 && !fact(); i++) await new Promise(r => setTimeout(r, 5)) }

type Snapshot = { runId: string; status: string; orchestratorSessionId?: string; nodes: { id: string; state: string; sessionId?: string }[] }
type Results = { runId: string | null; runIds: string[]; runStatus?: string; nodes: { id: string; state: string }[] }
type SeamManager = SessionManager
/** The SessionManager's own (private) completion seam, emitted as `onProcessingStopped` would. */
const emitOn = (manager: SessionManager, evt: SessionCompletionEvent) =>
  (manager as unknown as { emitSessionComplete(e: SessionCompletionEvent): void }).emitSessionComplete(evt)

function rig(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua4-3-run-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua4-3-${tag}-${Math.random().toString(36).slice(2, 8)}`
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
  const sm = createTestSessionManager({ workspaceService }) as SeamManager
  sm.setEventSink((() => undefined) as never)
  // The turn machinery: a send is delivered at once (the ack) and its turn never ends on its own.
  const sends: { sessionId: string; message: string }[] = []
  Object.assign(sm, {
    sendMessage: (sessionId: string, message: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void) => {
      sends.push({ sessionId, message })
      onAck?.('m')
      return new Promise<void>(() => {})
    },
    getPiHarnessRuntimeSnapshot: async () => ({ settlement: { settled: true } }),
    listSessionScheduledWork: () => ({ crons: [], tasks: [] }),
  })
  const hostabilityCalls: unknown[] = []

  /** One process: a handler registration over `manager` (a fresh view = a fresh Conductor runner). */
  const processOver = (manager: SeamManager) => {
    const handlers = new Map<string, HandlerFn>()
    const server = {
      handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return true },
      findClientsWithCapability() { return [] },
    } as unknown as RpcServer
    registerTasksHandlers(server, { sessionManager: manager, workspaceService, platform: {} } as unknown as HandlerDeps, {
      assertNodesHostable: async (spec) => { hostabilityCalls.push(spec) },
      // UA4.4: a run needs a human-confirmed digest; `tasks:create` (the editor's path) records it under this key.
      hostApprovalsKey: async () => Buffer.alloc(32, 3),
    })
    const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
    const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
    const callAs = <T>(caller: string, channel: string, ...args: unknown[]): Promise<T> =>
      Promise.resolve(handlers.get(channel)!({ ...ctx, workspaceId: caller }, ...args) as T)
    const complete = (sessionId: string, finalText: string, reason: SessionCompletionEvent['reason'] = 'complete') =>
      emitOn(manager, { sessionId, workspaceId, reason, finalText })
    return { call, callAs, complete, handlers }
  }

  /** The restart: the same sessions, an empty runner, and completion listeners of its own. */
  const restart = () => {
    const view = Object.create(sm) as SeamManager
    Object.defineProperty(view, 'sessionCompletionListeners', { value: new Set(), writable: true })
    return processOver(view)
  }

  const wsRoot = join(root, 'workspaces', workspaceId)
  const sessions = () => sm.getSessions(workspaceId)
  const child = (nodeId: string, runId: string) =>
    sessions().filter(s => s.taskNodeId === nodeId && s.taskRunId === runId).map(s => s.id)
  /** The dispatch prompt of a node's n-th attempt, by SEND order (the session list is sorted by last message). */
  const attemptPrompt = (nodeId: string, runId: string, n: number) => {
    const ids = new Set(child(nodeId, runId))
    return sends.filter(x => ids.has(x.sessionId))[n]?.message
  }
  return { sm, workspaceId, wsRoot, sends, attemptPrompt, sessions, child, hostabilityCalls, first: processOver(sm), restart }
}

const chain = (id: string) => [
  `id: ${id}`,
  `title: ${JSON.stringify(id)}`,
  'goal: ship it',
  'params:',
  '  - name: env',
  '    default: dev',
  'nodes:',
  '  - id: a',
  '    prompt: do a in ${params.env}',
  '  - id: b',
  '    depends_on: [a]',
  '    prompt: do b after ${nodes.a.output} in ${params.env}',
  '',
].join('\n')

async function created(h: ReturnType<typeof rig>, slug: string, yaml = chain(slug)) {
  const result = await h.first.call<{ slug: string; orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, h.workspaceId, { yaml })
  expect(result.slug).toBe(slug)
  return result.orchestratorSessionId
}

describe('UA4.3 — tasks:run / pause / resume / stop', () => {
  it('registers the run controls beside UA3.4\'s channels', () => {
    const h = rig('census')
    for (const channel of [RPC_CHANNELS.tasks.RUN, RPC_CHANNELS.tasks.PAUSE, RPC_CHANNELS.tasks.RESUME, RPC_CHANNELS.tasks.STOP]) {
      expect(h.first.handlers.has(channel)).toBe(true)
    }
  })

  it('POSITIVE: run → per-node state, live in tasks:get and running in getResults; pause → paused', async () => {
    const h = rig('run')
    const orch = await created(h, 'ship-run')
    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-run', orchestratorSessionId: orch, params: { env: 'prod' } })
    await waitFor(() => h.sends.length > 0)
    expect(snap.orchestratorSessionId).toBe(orch)
    expect(snap.nodes.map(n => [n.id, n.state])).toEqual([['a', 'running'], ['b', 'pending']])
    expect(h.hostabilityCalls.length).toBeGreaterThan(0) // the preflight ran before the first dispatch
    const [childA] = h.child('a', snap.runId)
    expect(childA).toBeDefined()
    expect(h.sends.find(s => s.sessionId === childA)?.message).toContain('do a in prod')
    // The run-started entry records the resolved params (the resume reads them back).
    const started = readRunLog(h.wsRoot, 'ship-run', snap.runId).find(e => e.kind === 'run-started')
    expect(started).toMatchObject({ kind: 'run-started', orchestratorSessionId: orch, params: { env: 'prod' } })

    const got = await h.first.call<{ run: Snapshot | null }>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-run', snap.runId)
    expect(got.run?.nodes.find(n => n.id === 'a')).toMatchObject({ state: 'running', sessionId: childA })
    expect((await h.first.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-run')).runStatus).toBe('running')

    await h.first.call(RPC_CHANNELS.tasks.PAUSE, h.workspaceId, 'ship-run', snap.runId)
    expect((await h.first.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-run')).runStatus).toBe('paused')
  })

  it('NEGATIVE: a second active run on the same orchestrator is refused', async () => {
    const h = rig('second')
    const orch = await created(h, 'ship-twice')
    await h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-twice', orchestratorSessionId: orch })
    await expect(h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-twice', orchestratorSessionId: orch }))
      .rejects.toThrow('already has an active run')
    expect(listRunIds(h.wsRoot, 'ship-twice')).toHaveLength(1)
  })

  it('POSITIVE + NEGATIVE: after a restart the run reads interrupted (never running), nothing is written, and Resume reuses done outputs, the snapshot DAG and the recorded params', async () => {
    const h = rig('restart')
    const orch = await created(h, 'ship-restart')
    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-restart', orchestratorSessionId: orch, params: { env: 'prod' } })
    await waitFor(() => h.attemptPrompt('a', snap.runId, 0) !== undefined) // dispatched: its session settles the node
    const [childA] = h.child('a', snap.runId)
    h.first.complete(childA!, 'A-OUT')
    await waitFor(() => h.attemptPrompt('b', snap.runId, 0) !== undefined)
    const [childB] = h.child('b', snap.runId)
    expect(childB).toBeDefined() // b is in flight at "shutdown"
    const logBefore = readRunLog(h.wsRoot, 'ship-restart', snap.runId).length

    const after = h.restart()
    const results = await after.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-restart')
    expect(results.runStatus).toBe('interrupted')
    expect((await after.call<{ run: Snapshot | null }>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-restart', snap.runId)).run).toBeNull()
    expect(readRunLog(h.wsRoot, 'ship-restart', snap.runId)).toHaveLength(logBefore) // nothing written by a read

    // The live task.yaml changes between the restart and Resume: b's prompt and a new node c.
    writeFileSync(taskYamlPath(h.wsRoot, 'ship-restart'), chain('ship-restart')
      .replace('do b after ${nodes.a.output} in ${params.env}', 'EDITED b')
      .concat('  - id: c\n    prompt: a node the run never had\n'))

    await after.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-restart', snap.runId)
    await waitFor(() => h.attemptPrompt('b', snap.runId, 1) !== undefined)
    // a is reused from disk (no new child); b re-dispatches with the snapshot prompt and the recorded params; no c.
    expect(h.child('a', snap.runId)).toEqual([childA!])
    const bChildren = h.child('b', snap.runId)
    expect(bChildren).toHaveLength(2)
    const newB = bChildren.find(id => id !== childB)!
    expect(h.sends.find(s => s.sessionId === newB)?.message).toBe('do b after A-OUT in prod')
    expect(h.child('c', snap.runId)).toEqual([])
    // The child abandoned at shutdown leaves the in-progress column (as a retried attempt's does).
    expect(h.sessions().find(s => s.id === childB)?.kanbanColumn).toBe('todo')
    expect((await after.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-restart')).runStatus).toBe('running')

    // A late turn of the abandoned child (a re-presented card answered after the restart) is not the node's output.
    after.complete(childB!, 'STALE')
    await settle()
    const live = await after.call<{ run: Snapshot | null }>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-restart', snap.runId)
    expect(live.run?.nodes.find(n => n.id === 'b')).toMatchObject({ state: 'running', sessionId: newB })
    after.complete(newB, 'B-OUT')
    await waitFor(() => h.sends.some(x => x.sessionId === orch)) // the verify message
    expect((await after.call<{ run: Snapshot | null }>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-restart', snap.runId)).run?.status).toBe('verifying')
  })

  it('NEGATIVE: a deleted task.yaml does not stop a resume (the run carries its own spec)', async () => {
    const h = rig('noyaml')
    const orch = await created(h, 'ship-noyaml')
    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-noyaml', orchestratorSessionId: orch })
    await waitFor(() => h.attemptPrompt('a', snap.runId, 0) !== undefined)
    rmSync(taskYamlPath(h.wsRoot, 'ship-noyaml'))
    const after = h.restart()
    await after.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-noyaml', snap.runId)
    await waitFor(() => h.attemptPrompt('a', snap.runId, 1) !== undefined)
    expect(h.child('a', snap.runId)).toHaveLength(2)
    expect(h.sends.at(-1)?.message).toBe('do a in dev') // the declared default, recorded at run start
  })

  it('NEGATIVE: a repair in flight at shutdown re-runs on resume instead of verifying the rejected output', async () => {
    const h = rig('repair')
    const orch = await created(h, 'ship-repair', [
      'id: ship-repair', 'title: ship-repair', 'goal: g', 'max_iterations: 2', 'nodes:', '  - id: a', '    prompt: do a', '',
    ].join('\n'))
    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-repair', orchestratorSessionId: orch })
    await waitFor(() => h.attemptPrompt('a', snap.runId, 0) !== undefined) // dispatched: its session settles the node
    const toOrch = () => h.sends.filter(x => x.sessionId === orch).length
    const before = toOrch()
    h.first.complete(h.child('a', snap.runId)[0]!, 'first try')
    await waitFor(() => toOrch() > before) // the verify message is delivered before the verdict turn
    h.first.complete(orch, 'VERDICT: FAIL — redo it')
    await waitFor(() => h.attemptPrompt('a', snap.runId, 1) !== undefined)
    expect(h.child('a', snap.runId)).toHaveLength(2) // the repair is in flight at "shutdown"
    const rejected = 'The previous result was rejected on verification: redo it.'
    expect(h.attemptPrompt('a', snap.runId, 1)).toContain(rejected) // control: the live repair carries it

    const after = h.restart()
    await after.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-repair', snap.runId)
    await waitFor(() => h.attemptPrompt('a', snap.runId, 2) !== undefined)
    expect(h.child('a', snap.runId)).toHaveLength(3)
    const run = (await after.call<{ run: Snapshot | null }>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-repair', snap.runId)).run
    expect(run?.status).toBe('running')
    // Follow-up: the resumed attempt is still a REPAIR — the rejection reason comes back from the log's node-retry.
    expect(h.attemptPrompt('a', snap.runId, 2)).toContain(rejected)
  })

  it('NEGATIVE (boundary): a plain retry in flight at shutdown resumes with the failure preamble, never the verification one', async () => {
    const h = rig('retry')
    const orch = await created(h, 'ship-retry', [
      'id: ship-retry', 'title: ship-retry', 'goal: g', 'nodes:', '  - id: a', '    prompt: do a', '    retry:', '      limit: 2', '',
    ].join('\n'))
    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-retry', orchestratorSessionId: orch })
    await waitFor(() => h.attemptPrompt('a', snap.runId, 0) !== undefined)
    expect(h.attemptPrompt('a', snap.runId, 0)).not.toContain('Previous attempt failed') // attempt 1 carries none
    h.first.complete(h.child('a', snap.runId)[0]!, '', 'error')
    await waitFor(() => h.attemptPrompt('a', snap.runId, 1) !== undefined)
    expect(h.child('a', snap.runId)).toHaveLength(2) // the retry is in flight at "shutdown"
    const failed = 'Previous attempt failed: error. Address the cause before retrying.'
    expect(h.attemptPrompt('a', snap.runId, 1)).toContain(failed) // control: the live retry carries it

    const after = h.restart()
    await after.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-retry', snap.runId)
    await waitFor(() => h.attemptPrompt('a', snap.runId, 2) !== undefined)
    expect(h.child('a', snap.runId)).toHaveLength(3)
    const resumed = h.attemptPrompt('a', snap.runId, 2)
    expect(resumed).toContain(failed)
    expect(resumed).not.toContain('rejected on verification')
  })

  it('NEGATIVE: a restart resume is refused while another run is active on the orchestrator; an ended run is not resumed', async () => {
    const h = rig('busy')
    const orch = await created(h, 'ship-busy')
    const first = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-busy', orchestratorSessionId: orch })
    await settle()
    const after = h.restart()
    const second = await after.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-busy', orchestratorSessionId: orch })
    await expect(after.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-busy', first.runId)).rejects.toThrow('already has an active run')
    await after.call(RPC_CHANNELS.tasks.STOP, h.workspaceId, 'ship-busy', second.runId)
    const third = h.restart()
    await expect(third.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-busy', second.runId)).rejects.toThrow('task-run-ended')
  })

  it('POSITIVE: an interrupted run can be stopped, and then reads stopped', async () => {
    const h = rig('stopint')
    const orch = await created(h, 'ship-stop')
    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-stop', orchestratorSessionId: orch })
    await settle()
    const after = h.restart()
    expect((await after.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-stop')).runStatus).toBe('interrupted')
    await after.call(RPC_CHANNELS.tasks.STOP, h.workspaceId, 'ship-stop', snap.runId)
    expect((await after.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-stop')).runStatus).toBe('stopped')
    // Control: a stopped run is not stopped twice on disk.
    await after.call(RPC_CHANNELS.tasks.STOP, h.workspaceId, 'ship-stop', snap.runId)
    expect(readRunLog(h.wsRoot, 'ship-stop', snap.runId).filter(e => e.kind === 'run-stopped')).toHaveLength(1)
  })

  it('NEGATIVE: no orchestrator, a session that is not this task\'s orchestrator, a foreign caller, or a bad run id is refused before anything runs', async () => {
    const h = rig('refuse')
    const orch = await created(h, 'ship-refuse')
    const other = await created(h, 'ship-other')
    await expect(h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse' })).rejects.toThrow('task-orchestrator-required')
    await expect(h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse', orchestratorSessionId: other }))
      .rejects.toThrow('task-orchestrator-mismatch')
    await expect(h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse', orchestratorSessionId: 'no-such-session' }))
      .rejects.toThrow('task-orchestrator-mismatch')
    await expect(h.first.callAs('ws-other', RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse', orchestratorSessionId: orch }))
      .rejects.toThrow('tasks-workspace-mismatch')
    for (const channel of [RPC_CHANNELS.tasks.PAUSE, RPC_CHANNELS.tasks.RESUME, RPC_CHANNELS.tasks.STOP]) {
      await expect(h.first.callAs('ws-other', channel, h.workspaceId, 'ship-refuse', 'run-1')).rejects.toThrow('tasks-workspace-mismatch')
    }
    await expect(h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse', orchestratorSessionId: orch, runId: '../escape' }))
      .rejects.toThrow('task-run-id-invalid')
    expect(listRunIds(h.wsRoot, 'ship-refuse')).toEqual([])
    expect(h.sends).toEqual([])

    const snap = await h.first.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse', orchestratorSessionId: orch, runId: 'run-1' })
    expect(snap.runId).toBe('run-1') // control: the same request with a well-formed id runs
    await h.first.call(RPC_CHANNELS.tasks.STOP, h.workspaceId, 'ship-refuse', 'run-1')
    await expect(h.first.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-refuse', orchestratorSessionId: orch, runId: 'run-1' }))
      .rejects.toThrow('task-run-id-taken')
    await expect(h.first.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-refuse', 'run-404')).rejects.toThrow('task-run-not-found')
    await expect(h.first.call(RPC_CHANNELS.tasks.RESUME, h.workspaceId, 'ship-refuse', '../x')).rejects.toThrow('task-run-not-found')
    expect(existsSync(join(h.wsRoot, 'tasks', 'ship-refuse', 'runs', 'run-404'))).toBe(false)
  })
})
