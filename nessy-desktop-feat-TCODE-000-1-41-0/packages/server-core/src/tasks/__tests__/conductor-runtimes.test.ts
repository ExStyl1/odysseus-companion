/**
 * UA4.1 — the Conductor across the three runtimes (plan UA4.1 "Tests", `conductor-runtimes.test.ts`): one DAG whose
 * nodes run on a Pi, a Claude Code and a Codex connection, against a REAL SessionManager (children created and listed
 * for real; the turn machinery is a fake, no backend runs in this process), the hostability preflight, and
 * per-runtime `tokenUsage` fixtures for `token_budget`.
 *
 * Positive: a three-node DAG on pi → claude → codex passes `${nodes.a.output}` / `${nodes.b.output}`; each child is
 * created on its node's connection; the preflight accepts the three.
 * Negative: a node on a nestor-cloud connection is refused BEFORE any dispatch, naming the node; a run over its token
 * budget pauses before the next node instead of dispatching it.
 *
 * The connections are written through the REAL storage API into this process's isolated config dir
 * (`claude-gateway-always-allow-scope.test.ts`'s recipe: a v2 skeleton if none, the previous bytes put back after).
 *
 * Token readings (2026-10-02): the Conductor reads `SessionCompletionEvent.tokenUsage`, which is the HOST's
 * `managed.tokenUsage` — `inputTokens` the latest context size, `outputTokens` summed over the turn-end `complete`
 * events — on every runtime alike (SessionManager `complete` arm). The codex `usage.total ?? usage.last` read named by
 * spec §11 item 9 is in the collab child-progress path (`backend/codex/event-adapter.ts`, `thread/tokenUsage/updated`),
 * not in what the Conductor meters; whether codex's per-turn `complete` usage is cumulative stays a live reading
 * (UA4.12). The fixtures below are shaped as the host accumulates them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TokenUsage } from '@nessy-agent/core/types'
import { CONFIG_DIR, addLlmConnection, getLlmConnection } from '@nessy-agent/shared/config'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { parseTaskSpec, readRunLog, saveTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
// UA12.129 — the CASE-shaped budget: the uses below are third arguments of `it()` cases, and
// F1.668 refuses the hook-shaped name there. Measured 2026-10-03 (junit): largest case 77.25 ms
// (the three-node DAG), ~3900x under CASE's 300 000.
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { TaskRunner } from '../TaskRunner'
import { assertNodesHostable } from '../node-hostability'
import { createConductorPreflight, createSessionConductorHost, type ConductorSessionManager } from '../conductor-host'

const PI = 'ua41-pi'
const CLAUDE = 'ua41-claude'
const CODEX = 'ua41-codex'
const NESTOR = 'ua41-nestor'
let previousConfigJson: string | null = null
const roots: string[] = []
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

// No module-graph budget (UA12.129): the body below is SYNCHRONOUS config writes — no dynamic
// import (this file's static graph, 0.82 s zero-case on 2026-10-03, is paid at load, not here) —
// and a sync body cannot yield to a timer, so the module-graph hook budget was a mis-name the
// F1.668 gate refuses; there is no module-graph cost left here to budget.
beforeAll(() => {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const configPath = join(CONFIG_DIR, 'config.json')
  previousConfigJson = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null
  if (previousConfigJson === null) {
    writeFileSync(configPath, JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }), 'utf-8')
  }
  const connection = (slug: string, providerType: string) =>
    ({ slug, name: slug, providerType, authType: 'api_key', models: [] }) as unknown as Parameters<typeof addLlmConnection>[0]
  addLlmConnection(connection(PI, 'pi'))
  addLlmConnection(connection(CLAUDE, 'claude-runtime'))
  addLlmConnection(connection(CODEX, 'codex-runtime'))
  addLlmConnection(connection(NESTOR, 'nestor-cloud-agent'))
  // The fixture's own positive control: a failure below is about the Conductor, not four connections never stored.
  expect([PI, CLAUDE, CODEX, NESTOR].map(slug => getLlmConnection(slug)?.providerType)).toEqual(['pi', 'claude-runtime', 'codex-runtime', 'nestor-cloud-agent'])
})

afterAll(() => {
  const configPath = join(CONFIG_DIR, 'config.json')
  if (previousConfigJson === null) rmSync(configPath, { force: true })
  else writeFileSync(configPath, previousConfigJson, 'utf-8')
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw)
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues))
  return r.data
}

/** A real SessionManager for create/list/handles/announce; the turn machinery recorded and driven by the test. */
function rig(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `ua4-1-rt-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua4-1-${tag}-${Math.random().toString(36).slice(2, 8)}`
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
  real.setEventSink((() => undefined) as never)
  const listeners = new Set<(evt: SessionCompletionEvent) => void>()
  const sends: { sessionId: string; message: string }[] = []
  const created: CreateSessionOptions[] = []
  const sm = {
    createSession: (ws: string, options: CreateSessionOptions) => { created.push(options); return real.createSession(ws, options) },
    announceSessionCreated: real.announceSessionCreated.bind(real),
    getSessions: real.getSessions.bind(real),
    getProjectHandleService: real.getProjectHandleService.bind(real),
    sendMessage: (sessionId: string, message: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void) => {
      sends.push({ sessionId, message })
      onAck?.('m')
      return new Promise<void>(() => {})
    },
    setSessionStatus: async () => {},
    setKanbanColumn: async () => {},
    setTaskNodeCount: async () => {},
    cancelProcessing: async () => {},
    onSessionComplete: (l: (evt: SessionCompletionEvent) => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    getPiHarnessRuntimeSnapshot: async () => ({ settlement: { settled: true } }),
    listSessionScheduledWork: () => ({ crons: [], tasks: [] }),
  } as unknown as ConductorSessionManager
  const wsRoot = join(root, 'workspaces', workspaceId)
  const complete = (sessionId: string, finalText: string, tokenUsage?: TokenUsage) => {
    for (const l of [...listeners]) l({ sessionId, workspaceId, reason: 'complete', finalText, ...(tokenUsage ? { tokenUsage } : {}) })
  }
  const preflight = createConductorPreflight({
    sessionManager: sm,
    workspaceId,
    hostRuntime: {} as never,
    // The real UA1.7 check; only the binary/credential probe (`canHostSession`) is stubbed, as this process has neither.
    assertHostable: (spec, deps) => assertNodesHostable(spec, { ...deps, canHost: async () => ({ ok: true }) as never }),
  })
  const runner = new TaskRunner({ host: createSessionConductorHost(sm, { workspaceId, workspaceRoot: wsRoot }), workspaceId, workspaceRoot: wsRoot, preflight })
  return { real, sm, runner, wsRoot, workspaceId, sends, created, complete }
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await tick()
}

describe('UA4.1 — the Conductor on pi, claude and codex', () => {
  it('a three-node DAG on pi → claude → codex passes each node\'s output to the next, each child on its node\'s connection', async () => {
    const { real, runner, wsRoot, workspaceId, sends, created, complete } = rig('dag')
    saveTaskSpec(wsRoot, specOf({
      id: 'tri', title: 'tri', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'audit', llmConnection: PI },
        { id: 'b', depends_on: ['a'], prompt: 'design from ${nodes.a.output}', llmConnection: CLAUDE },
        { id: 'c', depends_on: ['b'], prompt: 'build from ${nodes.b.output}', llmConnection: CODEX },
      ],
    }))
    await runner.run('tri', { runId: 'r1' })
    const childOf = (node: string) => runner.getRunState('tri', 'r1')!.nodes.find(n => n.id === node)!.sessionId!
    await settle(() => sends.length === 1)
    complete(childOf('a'), 'PI-OUT')
    await settle(() => sends.length === 2)
    expect(sends[1]!.message).toBe('design from PI-OUT')
    complete(childOf('b'), 'CLAUDE-OUT')
    await settle(() => sends.length === 3)
    expect(sends[2]!.message).toBe('build from CLAUDE-OUT')
    complete(childOf('c'), 'CODEX-OUT')
    await settle(() => runner.getRunState('tri', 'r1')!.status === 'completed')
    expect(runner.getRunState('tri', 'r1')!.status).toBe('completed')

    expect(created.map(o => o.llmConnection)).toEqual([PI, CLAUDE, CODEX])
    const listed = real.getSessions(workspaceId)
    expect(['a', 'b', 'c'].map(node => listed.find(s => s.id === childOf(node))?.llmConnection)).toEqual([PI, CLAUDE, CODEX])
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE: a node on a nestor-cloud connection is refused BEFORE any dispatch, naming the node', async () => {
    const { real, runner, wsRoot, created } = rig('nestor')
    saveTaskSpec(wsRoot, specOf({
      id: 'cloud', title: 'cloud', goal: 'g',
      nodes: [{ id: 'local', prompt: 'p', llmConnection: PI }, { id: 'remote', prompt: 'r', llmConnection: NESTOR }],
    }))
    await expect(runner.run('cloud', { runId: 'r1' })).rejects.toThrow(/Task node "remote" cannot run on connection "ua41-nestor"/)
    expect(created).toEqual([])
    expect(readRunLog(wsRoot, 'cloud', 'r1')).toEqual([])
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})

describe('UA4.1 — per-runtime tokenUsage fixtures for token_budget', () => {
  // As the host accumulates them: `inputTokens` the turn's context size, `outputTokens` summed, `totalTokens` their sum.
  const usage = (input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage =>
    ({ inputTokens: input, outputTokens: output, totalTokens: input + output, contextTokens: input, costUsd: 0, ...extra })
  const FIXTURES: Record<string, TokenUsage> = {
    // Pi: gateway OpenAI-compatible usage; no cache fields.
    pi: usage(1_200, 300),
    // Claude Code: cache reads are reported beside the context size and are NOT added by the Conductor.
    claude: usage(2_000, 500, { cacheReadTokens: 9_000, cacheCreationTokens: 400 } as Partial<TokenUsage>),
    // Codex: the per-turn `complete` usage as the host stores it.
    codex: usage(1_800, 700),
  }

  it('tokensUsed is the sum of each child\'s input + output (cache tokens excluded), on all three fixtures', async () => {
    const { real, runner, wsRoot, sends, complete } = rig('tokens')
    saveTaskSpec(wsRoot, specOf({
      id: 'tok', title: 'tok', goal: 'g',
      nodes: [{ id: 'a', prompt: 'a', llmConnection: PI }, { id: 'b', prompt: 'b', llmConnection: CLAUDE }, { id: 'c', prompt: 'c', llmConnection: CODEX }],
    }))
    await runner.run('tok', { runId: 'r1' })
    await settle(() => sends.length === 3)
    const ids = runner.getRunState('tok', 'r1')!.nodes.map(n => n.sessionId!)
    complete(ids[0]!, 'x', FIXTURES.pi)
    complete(ids[1]!, 'y', FIXTURES.claude)
    complete(ids[2]!, 'z', FIXTURES.codex)
    await settle(() => runner.getRunState('tok', 'r1')!.status === 'completed')
    expect(runner.getRunState('tok', 'r1')!.tokensUsed).toBe(1_500 + 2_500 + 2_500)
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE: a run over token_budget pauses before dispatching the next node', async () => {
    const { real, runner, wsRoot, sends, complete } = rig('budget')
    saveTaskSpec(wsRoot, specOf({
      id: 'bud', title: 'bud', goal: 'g', token_budget: 2_000,
      nodes: [{ id: 'a', prompt: 'a', llmConnection: CODEX }, { id: 'b', depends_on: ['a'], prompt: 'b', llmConnection: CLAUDE }],
    }))
    await runner.run('bud', { runId: 'r1' })
    await settle(() => sends.length === 1)
    complete(runner.getRunState('bud', 'r1')!.nodes[0]!.sessionId!, 'x', FIXTURES.codex) // 2 500 ≥ 2 000
    await settle(() => runner.getRunState('bud', 'r1')!.status === 'paused')
    expect(runner.getRunState('bud', 'r1')!.status).toBe('paused')
    expect(sends).toHaveLength(1)
    expect(readRunLog(wsRoot, 'bud', 'r1').some(e => e.kind === 'budget-breach' && e.metric === 'tokens')).toBe(true)
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})
