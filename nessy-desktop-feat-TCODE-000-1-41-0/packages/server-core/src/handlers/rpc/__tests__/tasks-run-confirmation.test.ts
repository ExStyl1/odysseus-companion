/**
 * UA4.4 — the host-enforced run confirmation (spec §10 "Run confirmation", plan UA4.4 "Host path") and the
 * `tasks:getResults` fold of a node sent back (P-UA-ag-2), driven through the registered handlers against a REAL
 * SessionManager and workspace root, with a fixed ledger key (`TasksHandlerOptions.hostApprovalsKey`).
 *
 * Positive: the editor's create records the saved digest, so `tasks:get` asks for nothing and `tasks:run` runs; a
 * run carrying the confirmed digest of an unconfirmed spec runs and records it (the next `tasks:get` asks nothing);
 * the confirmation names each node's model, connection and EFFECTIVE mode (clamped to the orchestrator's), the sources
 * and the node count; `getResults` during a repair shows the node running, and pending once a retry sent it back; a
 * node whose session woke after done is marked, and `tasks:get` lists it for the tile.
 * Negative: an agent-created spec (`createTaskFromSpec`, the `create_board_task` path) asks, and `tasks:run` without
 * `confirmedDigest` — or with another digest — is refused by the host; an on-disk edit after a save asks again; a save
 * that adopts a Generate draft records nothing, nor does an edit-mode save that carries one (UA4.6 follow-up 3); a forged ledger entry is not a confirmation; a ledger key that cannot
 * be read records nothing and trusts nothing.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { HOST_APPROVALS_FILE, findHostApproval } from '@nessy-agent/shared/approvals/host-approvals'
import { appendRunLog, parseTaskYaml, taskYamlPath, writeRunSpecSnapshot } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { SessionManager } from '../../../sessions/SessionManager'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'
import { createTaskFromSpec } from '../../../tasks/create-task'
import { registerTasksHandlers, taskConfirmationSubject, taskYamlDigest } from '../tasks'
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// UA12.197 (VF-3 proposal 1) — the sibling of tasks-run-confirmation-plugins.test.ts (UA12.92 follow-up): the same real
// SessionManager rig per CASE (project-handle validation and trust, createTaskFromSpec, tasks:get), so the same cold or
// loaded exposure to bun's 5 000 ms default. Priced 2026-10-09 (warm, under the test lock): a zero-case `-t` control
// loads the graph in 704 ms; the 13 cases take 13–80 ms each (junit), the file 1 121 ms — the budget covers the cold
// tail the sibling measured (6 137–11 963 ms per case), not the warm path.
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const KEY = Buffer.alloc(32, 7)

type Snapshot = { runId: string; status: string }
type Got = {
  needsRunConfirmation?: boolean
  runConfirmation?: {
    digest: string
    nodeCount: number
    nodes: { id: string; title: string; model?: string; llmConnection?: string; permissionMode?: string }[]
    sources: string[]
    orchestratorPermissionMode?: string
  }
  wokeAfterDone?: string[]
}
type Results = { nodes: { id: string; title: string; state: string; sessionId?: string; wokeAfterDone?: boolean }[] }

function rig(tag: string, key: () => Promise<Buffer> = async () => KEY) {
  const root = mkdtempSync(join(tmpdir(), `ua4-4-confirm-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua4-4-${tag}-${Math.random().toString(36).slice(2, 8)}`
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
  const sm = createTestSessionManager({ workspaceService }) as SessionManager
  sm.setEventSink((() => undefined) as never)
  // The turn machinery: a send is delivered at once (the ack) and its turn never ends on its own.
  Object.assign(sm, {
    sendMessage: (_s: string, _m: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void) => {
      onAck?.('m')
      return new Promise<void>(() => {})
    },
    getPiHarnessRuntimeSnapshot: async () => ({ settlement: { settled: true } }),
    listSessionScheduledWork: () => ({ crons: [], tasks: [] }),
  })
  const handlers = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return true },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  registerTasksHandlers(server, { sessionManager: sm, workspaceService, platform: {} } as unknown as HandlerDeps, {
    assertNodesHostable: async () => {},
    hostApprovalsKey: key,
  })
  const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
  const wsRoot = join(root, 'workspaces', workspaceId)
  return { sm, workspaceId, wsRoot, call }
}

const yamlOf = (id: string, extra: string[] = []) => [
  `id: ${id}`,
  `title: ${JSON.stringify(id)}`,
  'goal: ship it',
  ...extra,
  'nodes:',
  '  - id: a',
  '    prompt: do a',
  '  - id: b',
  '    depends_on: [a]',
  '    prompt: do b',
  '',
].join('\n')

async function editorCreate(h: ReturnType<typeof rig>, slug: string, yaml = yamlOf(slug)) {
  const result = await h.call<{ slug: string; orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, h.workspaceId, { yaml })
  expect(result.slug).toBe(slug)
  return result.orchestratorSessionId
}

/** The `create_board_task` path: the shared create core, no `tasks:create`, so no confirmation is recorded. */
async function agentCreate(h: ReturnType<typeof rig>, slug: string, yaml = yamlOf(slug)) {
  const parsed = parseTaskYaml(yaml)
  expect(parsed.valid).toBe(true)
  const created = await createTaskFromSpec(h.sm, h.workspaceId, h.wsRoot, parsed.spec!, { permissionMode: 'default' })
  return created.orchestratorSessionId
}

describe('UA4.4 — the host-enforced run confirmation', () => {
  it('POSITIVE: the editor create records the saved digest — tasks:get asks nothing and tasks:run runs', async () => {
    const h = rig('editor')
    const orch = await editorCreate(h, 'ship-editor')
    const digest = taskYamlDigest(h.wsRoot, 'ship-editor')
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(findHostApproval(h.wsRoot, KEY, 'task-confirmation', taskConfirmationSubject('ship-editor'))?.digest).toBe(digest!)
    const got = await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-editor')
    expect(got.needsRunConfirmation).toBe(false)
    expect(got.runConfirmation).toBeUndefined()
    const snap = await h.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-editor', orchestratorSessionId: orch })
    expect(snap.status).toBe('running')
  })

  it('NEGATIVE: an agent-created spec asks; tasks:run without confirmedDigest, or with another digest, is refused by the host', async () => {
    const h = rig('agent')
    const orch = await agentCreate(h, 'ship-agent')
    const got = await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-agent')
    expect(got.needsRunConfirmation).toBe(true)
    expect(got.runConfirmation?.digest).toBe(taskYamlDigest(h.wsRoot, 'ship-agent')!)
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-agent', orchestratorSessionId: orch }))
      .rejects.toThrow('run-confirmation-required')
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-agent', orchestratorSessionId: orch, confirmedDigest: 'sha256:' + '0'.repeat(64) }))
      .rejects.toThrow('run-confirmation-required')
    expect(findHostApproval(h.wsRoot, KEY, 'task-confirmation', taskConfirmationSubject('ship-agent'))).toBeUndefined()
  })

  it('POSITIVE: a run carrying the confirmed digest runs and records it — the next tasks:get asks nothing', async () => {
    const h = rig('confirm')
    const orch = await agentCreate(h, 'ship-confirm')
    const { runConfirmation } = await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-confirm')
    const snap = await h.call<Snapshot>(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-confirm', orchestratorSessionId: orch, confirmedDigest: runConfirmation!.digest })
    expect(snap.status).toBe('running')
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-confirm')).needsRunConfirmation).toBe(false)
  })

  it('POSITIVE: the confirmation names model, connection, the EFFECTIVE mode (clamped to the orchestrator), sources and the node count', async () => {
    const h = rig('names')
    const yaml = [
      'id: ship-names',
      'title: names',
      'goal: ship it',
      'sources: [linear]',
      'defaults:',
      '  model: coder',
      '  llmConnection: gw',
      'nodes:',
      '  - id: a',
      '    prompt: do a',
      '    permissionMode: acceptEdits',
      '  - id: b',
      '    prompt: do b',
      '    model: fast',
      '    llmConnection: other',
      '',
    ].join('\n')
    await agentCreate(h, 'ship-names', yaml)
    const { runConfirmation } = await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-names')
    expect(runConfirmation).toMatchObject({ nodeCount: 2, sources: ['linear'], orchestratorPermissionMode: 'default' })
    expect(runConfirmation!.nodes).toEqual([
      { id: 'a', title: 'a', model: 'coder', llmConnection: 'gw', permissionMode: 'default' },
      { id: 'b', title: 'b', model: 'fast', llmConnection: 'other', permissionMode: 'default' },
    ])
  })

  it('NEGATIVE: an on-disk edit after the editor save asks again, and the old run is refused', async () => {
    const h = rig('edit')
    const orch = await editorCreate(h, 'ship-edit')
    const path = taskYamlPath(h.wsRoot, 'ship-edit')
    writeFileSync(path, readFileSync(path, 'utf-8').replace('do b', 'do something else'))
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-edit')).needsRunConfirmation).toBe(true)
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-edit', orchestratorSessionId: orch }))
      .rejects.toThrow('run-confirmation-required')
  })

  it('NEGATIVE: a save that adopts a Generate draft records nothing', async () => {
    const h = rig('draft')
    const draft = await h.sm.createSession(h.workspaceId, { name: 'draft', taskDraft: true, permissionMode: 'dontAsk' })
    const result = await h.call<{ slug: string; orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, h.workspaceId, {
      yaml: yamlOf('ship-draft'),
      orchestratorSessionId: draft.id,
    })
    expect(result.orchestratorSessionId).toBe(draft.id)
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-draft')).needsRunConfirmation).toBe(true)
  })

  it('NEGATIVE (UA4.6 follow-up 3): an edit-mode save of a Generate plan (attach + draft id) records nothing; the same save without the draft id does', async () => {
    const h = rig('edit-gen')
    const orch = await editorCreate(h, 'ship-edit-gen')
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-edit-gen')).needsRunConfirmation).toBe(false)
    const draft = await h.sm.createSession(h.workspaceId, { name: 'draft', taskDraft: true, permissionMode: 'dontAsk' })
    const generated = yamlOf('ship-edit-gen').replace('do b', 'do what the draft wrote')
    const result = await h.call<{ orchestratorSessionId: string }>(RPC_CHANNELS.tasks.CREATE, h.workspaceId, {
      yaml: generated,
      attachToExistingSession: orch,
      orchestratorSessionId: draft.id,
    })
    // Attach wins: the task keeps its own orchestrator, the draft is not adopted.
    expect(result.orchestratorSessionId).toBe(orch)
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-edit-gen')).needsRunConfirmation).toBe(true)
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-edit-gen', orchestratorSessionId: orch }))
      .rejects.toThrow('run-confirmation-required')
    // CONTROL on the same instrument: the human's own edit save (attach, no draft) records the new bytes.
    await h.call(RPC_CHANNELS.tasks.CREATE, h.workspaceId, { yaml: generated.replace('do a', 'do a by hand'), attachToExistingSession: orch })
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-edit-gen')).needsRunConfirmation).toBe(false)
  })

  it('NEGATIVE: a forged ledger entry is not a confirmation', async () => {
    const h = rig('forged')
    const orch = await agentCreate(h, 'ship-forged')
    const digest = taskYamlDigest(h.wsRoot, 'ship-forged')!
    writeFileSync(join(h.wsRoot, HOST_APPROVALS_FILE), JSON.stringify({
      version: 1,
      entries: [{ kind: 'task-confirmation', subject: 'task:ship-forged', digest, createdAt: '2026-10-02T00:00:00.000Z', mac: 'a'.repeat(64) }],
    }))
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-forged')).needsRunConfirmation).toBe(true)
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-forged', orchestratorSessionId: orch }))
      .rejects.toThrow('run-confirmation-required')
  })

  it('NEGATIVE: a ledger key that cannot be read records nothing and trusts nothing — every run asks', async () => {
    const h = rig('nokey', async () => { throw new Error('the sealed host-approvals key cannot be unsealed') })
    const orch = await editorCreate(h, 'ship-nokey')
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-nokey')).needsRunConfirmation).toBe(true)
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-nokey', orchestratorSessionId: orch }))
      .rejects.toThrow('run-confirmation-required')
  })
})

describe('UA4.4 — tasks:getResults folds a node sent back, and marks a node that woke after done (P-UA-ag-2)', () => {
  const seedRun = (h: ReturnType<typeof rig>, slug: string, runId: string, tail: Parameters<typeof appendRunLog>[3][]) => {
    const parsed = parseTaskYaml(yamlOf(slug))
    writeRunSpecSnapshot(h.wsRoot, slug, runId, parsed.spec!)
    const t = '2026-10-02T00:00:00.000Z'
    for (const entry of [
      { t, kind: 'run-started', runId } as const,
      { t, kind: 'node-scheduled', nodeId: 'a' } as const,
      { t, kind: 'node-spawned', nodeId: 'a', sessionId: 'sess-a1' } as const,
      { t, kind: 'node-finished', nodeId: 'a', sessionId: 'sess-a1', state: 'done' } as const,
      ...tail,
    ]) appendRunLog(h.wsRoot, slug, runId, entry as Parameters<typeof appendRunLog>[3])
  }

  it('POSITIVE: during a repair the node reads running, in no session until the next is spawned', async () => {
    const h = rig('repair')
    await editorCreate(h, 'ship-repair')
    const t = '2026-10-02T00:00:01.000Z'
    seedRun(h, 'ship-repair', 'r1', [
      { t, kind: 'node-retry', nodeId: 'a', attempt: 1, reason: 'verdict FAIL: wrong' },
      { t, kind: 'node-scheduled', nodeId: 'a' },
    ])
    const results = await h.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-repair', 'r1')
    expect(results.nodes.find(n => n.id === 'a')).toEqual({ id: 'a', title: 'a', state: 'running' })
  })

  it('NEGATIVE: a node a retry sent back reads pending, not its old done', async () => {
    const h = rig('retry')
    await editorCreate(h, 'ship-retry')
    seedRun(h, 'ship-retry', 'r1', [{ t: '2026-10-02T00:00:01.000Z', kind: 'node-retry', nodeId: 'a', attempt: 1, reason: 'boom' }])
    const results = await h.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-retry', 'r1')
    expect(results.nodes.find(n => n.id === 'a')?.state).toBe('pending')
  })

  it('POSITIVE: a node whose session woke after done is marked in getResults and listed by tasks:get; NEGATIVE: none, none', async () => {
    const h = rig('woke')
    await editorCreate(h, 'ship-woke')
    seedRun(h, 'ship-woke', 'r1', [])
    expect((await h.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-woke', 'r1')).nodes[0]?.wokeAfterDone).toBeUndefined()
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-woke')).wokeAfterDone).toBeUndefined()
    appendRunLog(h.wsRoot, 'ship-woke', 'r1', { t: '2026-10-02T00:00:02.000Z', kind: 'node-woke-after-done', nodeId: 'a', sessionId: 'sess-a1' })
    const results = await h.call<Results>(RPC_CHANNELS.tasks.GET_RESULTS, h.workspaceId, 'ship-woke', 'r1')
    expect(results.nodes.find(n => n.id === 'a')).toMatchObject({ state: 'done', sessionId: 'sess-a1', wokeAfterDone: true })
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-woke')).wokeAfterDone).toEqual(['a'])
  })
})

describe('UA12.90 — the run runs the bytes the confirmation checked (P-UAal-2)', () => {
  it('NEGATIVE: an edit landing between the check and the runner\'s read is refused; POSITIVE: the task then asks again, for the new bytes', async () => {
    // The edit is staged through the ledger-key seam — the key reads are the host's awaits between the
    // confirmation check's read and the runner's read — so the race is deterministic in-process: the check
    // reads the original bytes, the runner reads the edited ones.
    let keyCalls = 0
    const h = rig('race', async () => {
      keyCalls += 1
      if (keyCalls >= 2) {
        const path = taskYamlPath(h.wsRoot, 'ship-race')
        writeFileSync(path, readFileSync(path, 'utf-8').replace('do b', 'do something else entirely'))
      }
      return KEY
    })
    const orch = await agentCreate(h, 'ship-race')
    const { runConfirmation } = await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-race')
    const confirmed = runConfirmation!.digest
    await expect(h.call(RPC_CHANNELS.tasks.RUN, h.workspaceId, { slug: 'ship-race', orchestratorSessionId: orch, confirmedDigest: confirmed }))
      .rejects.toThrow('run-confirmation-required')
    // The edit really landed (the control on the same instrument), and the run left the task asking — for the NEW bytes.
    expect(keyCalls).toBeGreaterThanOrEqual(2)
    expect(taskYamlDigest(h.wsRoot, 'ship-race')).not.toBe(confirmed)
    expect((await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-race')).needsRunConfirmation).toBe(true)
  })
})
