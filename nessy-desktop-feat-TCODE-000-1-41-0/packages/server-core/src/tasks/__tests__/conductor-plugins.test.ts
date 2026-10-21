/**
 * UA4.1 — plugins and their MCP servers in Conductor node sessions (owner 2026-09-24; plan UA4.1 "Plugins",
 * `conductor-plugins.test.ts`). A node is an ordinary session of the orchestrator's project: its plugins come from the
 * host capability snapshot, whose inputs are the `CapabilityContext` SessionManager builds for a turn
 * (`createCapabilityTurn`). This suite drives that REAL builder for a Conductor child and for a normal new session in
 * the same project, on a Pi, a Claude Code and a Codex connection, through a recording resolver that answers plugin
 * activation by the context it is given (workspace-scoped, project-scoped by `projectKey`, session-scoped by
 * `sessionId`) — the scopes `PluginEnablementScope` and D1.69 define.
 *
 * Positive: a plugin enabled for the workspace exposes its MCP tool and its skill in the node's snapshot; one enabled
 * for the orchestrator's project does too.
 * Negative: a plugin enabled only for ANOTHER project is absent; the orchestrator's session-scoped plugin is absent; a
 * `task.yaml` naming a plugin enables nothing (the schema keeps no such field and the child's create options carry
 * none); the parity pin — the node's capability context equals a normal new session's in the same project on the same
 * runtime, `sessionId` aside.
 *
 * Reading (2026-10-02, the premise plan UA4.1 asked to measure): node `sources` narrow WORKSPACE source records only.
 * `bootstrap/storage-runtime.ts`'s `sessionSelection` keeps `kind === 'source'` records alone ("MCP (`kind === 'mcp'`
 * natives + plugin connectors) is EXEMPT and governed by plugin/config activation alone"), so plugin MCP servers follow
 * plugin enablement whatever `sources` says. Pinned below by the context: `enabledSourceNames` is the spec's sources
 * and plugin activation never reads it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR, addLlmConnection } from '@nessy-agent/shared/config'
import type { CapabilityContext, CapabilityResolver, EffectiveCapabilitySnapshot } from '@nessy-agent/shared/capabilities/resolver'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { parseTaskSpec, saveTaskSpec } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
// UA12.129 — the CASE-shaped budget: the uses below are third arguments of `it()` cases, and
// F1.668 refuses the hook-shaped name there. Measured 2026-10-03 (junit): largest case 340.11 ms
// (the three-providers control), ~880x under CASE's 300 000 — even the box's widest measured
// cold/warm spread (162x) applied to it stays ~55 s.
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { SessionCompletionEvent } from '../../sessions/SessionManager'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { TaskRunner } from '../TaskRunner'
import { createSessionConductorHost, type ConductorSessionManager } from '../conductor-host'

const CONNECTIONS = { pi: 'ua41p-pi', claude: 'ua41p-claude', codex: 'ua41p-codex' } as const
let previousConfigJson: string | null = null
const roots: string[] = []
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

// No module-graph budget (UA12.129): the body below is SYNCHRONOUS config writes — no dynamic
// import (this file's static graph, 0.87 s zero-case on 2026-10-03, is paid at load, not here) —
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
  addLlmConnection(connection(CONNECTIONS.pi, 'pi'))
  addLlmConnection(connection(CONNECTIONS.claude, 'claude-runtime'))
  addLlmConnection(connection(CONNECTIONS.codex, 'codex-runtime'))
})

afterAll(() => {
  const configPath = join(CONFIG_DIR, 'config.json')
  if (previousConfigJson === null) rmSync(configPath, { force: true })
  else writeFileSync(configPath, previousConfigJson, 'utf-8')
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Which plugins a context activates — the three scopes, decided from the context alone. */
interface PluginFixture { name: string; mcp: string; skill: string; scope: { kind: 'workspace' } | { kind: 'project'; projectKey: string } | { kind: 'session'; sessionId: string } }

function recordingResolver(plugins: () => PluginFixture[]): CapabilityResolver & { contexts: CapabilityContext[] } {
  let seq = 0
  const contexts: CapabilityContext[] = []
  return {
    contexts,
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      contexts.push(context)
      const active = plugins().filter(p => p.scope.kind === 'workspace'
        || (p.scope.kind === 'project' && p.scope.projectKey === context.projectKey)
        || (p.scope.kind === 'session' && p.scope.sessionId === context.sessionId))
      const entries = active.flatMap(p => [
        { summary: { key: `plugin:${p.name}:mcp:${p.mcp}`, kind: 'mcp', logicalName: p.mcp } },
        { summary: { key: `plugin:${p.name}:skill:${p.skill}`, kind: 'skill', logicalName: p.skill } },
      ])
      return { context, generation: `g-${++seq}`, leaseId: `lease-${seq}`, entries, installedPlugins: [], diagnostics: [] } as unknown as EffectiveCapabilitySnapshot
    },
    releaseSnapshot: () => undefined,
    invalidate: () => undefined,
    isLeaseActive: () => true,
    referencedInstances: () => new Set(),
    leaseCount: () => 0,
  } as unknown as CapabilityResolver & { contexts: CapabilityContext[] }
}

type Internals = {
  getManaged(sessionId: string, workspaceId?: string): unknown
  createCapabilityTurn(managed: unknown): Promise<{ snapshot: EffectiveCapabilitySnapshot }>
}

async function snapshotOf(sm: unknown, sessionId: string, workspaceId: string): Promise<EffectiveCapabilitySnapshot> {
  const internals = sm as Internals
  return (await internals.createCapabilityTurn(internals.getManaged(sessionId, workspaceId))).snapshot
}
const names = (snapshot: EffectiveCapabilitySnapshot) =>
  (snapshot.entries as unknown as { summary: { logicalName: string } }[]).map(e => e.summary.logicalName).sort()
const withoutSession = (context: CapabilityContext) => {
  const { sessionId: _sessionId, ...rest } = context
  return rest
}

async function rig(runtime: keyof typeof CONNECTIONS) {
  const root = mkdtempSync(join(tmpdir(), `ua4-1-plug-${runtime}-`))
  roots.push(root)
  const workspaceId = `ws-ua4-1p-${runtime}-${Math.random().toString(36).slice(2, 8)}`
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
  let plugins: PluginFixture[] = []
  const resolver = recordingResolver(() => plugins)
  const real = createTestSessionManager({ workspaceService, resolver })
  real.setEventSink((() => undefined) as never)

  const handles = real.getProjectHandleService()
  const trusted = async (prefix: string) => {
    const folder = mkdtempSync(join(tmpdir(), prefix))
    roots.push(folder)
    const issued = await handles.validateProjectDirectory(workspaceId, folder)
    await handles.setProjectTrust({ workspaceId, projectHandleId: issued.id }, 'trusted')
    return issued.id
  }
  const projectHandle = await trusted('ua4-1p-proj-')
  const otherHandle = await trusted('ua4-1p-other-')
  const connection = CONNECTIONS[runtime]
  const orchestrator = await real.createSession(workspaceId, { name: 'orch', projectHandleId: projectHandle, llmConnection: connection, permissionMode: 'default' })
  const normal = await real.createSession(workspaceId, { name: 'normal', projectHandleId: projectHandle, llmConnection: connection, enabledSourceSlugs: ['docs'], permissionMode: 'default' })
  const elsewhere = await real.createSession(workspaceId, { name: 'elsewhere', projectHandleId: otherHandle, llmConnection: connection })
  const projectKey = (await snapshotOf(real, orchestrator.id, workspaceId)).context.projectKey!
  const otherKey = (await snapshotOf(real, elsewhere.id, workspaceId)).context.projectKey!
  plugins = [
    { name: 'ws-plugin', mcp: 'ws-mcp', skill: 'ws-skill', scope: { kind: 'workspace' } },
    { name: 'proj-plugin', mcp: 'proj-mcp', skill: 'proj-skill', scope: { kind: 'project', projectKey } },
    { name: 'other-plugin', mcp: 'other-mcp', skill: 'other-skill', scope: { kind: 'project', projectKey: otherKey } },
    { name: 'session-plugin', mcp: 'session-mcp', skill: 'session-skill', scope: { kind: 'session', sessionId: orchestrator.id } },
  ]

  // The Conductor over the real create/list/handles; the turn machinery is recorded (no backend runs here).
  const listeners = new Set<(evt: SessionCompletionEvent) => void>()
  const created: CreateSessionOptions[] = []
  const sm = {
    createSession: (ws: string, options: CreateSessionOptions) => { created.push(options); return real.createSession(ws, options) },
    announceSessionCreated: real.announceSessionCreated.bind(real),
    getSessions: real.getSessions.bind(real),
    getProjectHandleService: real.getProjectHandleService.bind(real),
    sendMessage: (_s: string, _m: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void) => { onAck?.('m'); return new Promise<void>(() => {}) },
    setSessionStatus: async () => {},
    setKanbanColumn: async () => {},
    setTaskNodeCount: async () => {},
    cancelProcessing: async () => {},
    onSessionComplete: (l: (evt: SessionCompletionEvent) => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    getPiHarnessRuntimeSnapshot: async () => ({ settlement: { settled: true } }),
    listSessionScheduledWork: () => ({ crons: [], tasks: [] }),
  } as unknown as ConductorSessionManager
  const wsRoot = join(root, 'workspaces', workspaceId)
  const runner = new TaskRunner({ host: createSessionConductorHost(sm, { workspaceId, workspaceRoot: wsRoot }), workspaceId, workspaceRoot: wsRoot })
  return { real, runner, wsRoot, workspaceId, orchestrator, normal, created, projectKey }
}

async function dispatchNode(r: Awaited<ReturnType<typeof rig>>, yaml: Record<string, unknown>) {
  const parsed = parseTaskSpec(yaml)
  if (!parsed.success) throw new Error('bad fixture: ' + JSON.stringify(parsed.error.issues))
  saveTaskSpec(r.wsRoot, parsed.data)
  await r.runner.run(parsed.data.id, { runId: 'r1', orchestratorSessionId: r.orchestrator.id })
  for (let i = 0; i < 200 && !r.runner.getRunState(parsed.data.id, 'r1')!.nodes[0]!.sessionId; i++) await tick()
  for (let i = 0; i < 20; i++) await tick()
  return r.runner.getRunState(parsed.data.id, 'r1')!.nodes[0]!.sessionId!
}

for (const runtime of ['pi', 'claude', 'codex'] as const) {
  describe(`UA4.1 — plugins in a Conductor node (${runtime})`, () => {
    it('workspace and orchestrator-project plugins reach the node; another project\'s and the orchestrator\'s session-scoped do not; the node\'s context equals a normal session\'s', async () => {
      const r = await rig(runtime)
      const childId = await dispatchNode(r, { id: `plug-${runtime}`, title: 't', goal: 'g', sources: ['docs'], nodes: [{ id: 'a', prompt: 'a', llmConnection: CONNECTIONS[runtime] }] })
      const node = await snapshotOf(r.real, childId, r.workspaceId)
      const normal = await snapshotOf(r.real, r.normal.id, r.workspaceId)
      const orchestrator = await snapshotOf(r.real, r.orchestrator.id, r.workspaceId)

      // Positive: workspace + project enablement.
      expect(names(node)).toEqual(['proj-mcp', 'proj-skill', 'ws-mcp', 'ws-skill'])
      // Negative: another project's plugin and the orchestrator's session-scoped plugin are absent.
      expect(names(node)).not.toContain('other-mcp')
      expect(names(node)).not.toContain('session-mcp')
      // Control: the session-scoped plugin IS in the orchestrator's own snapshot, so its absence above is the scope.
      expect(names(orchestrator)).toContain('session-mcp')
      // Parity pin: same project, same runtime → same snapshot inputs and the same plugins.
      expect(withoutSession(node.context)).toEqual(withoutSession(normal.context))
      expect(names(node)).toEqual(names(normal))
      expect(node.context.projectKey).toBe(r.projectKey)
      // `sources` select workspace sources (the context's enabledSourceNames); plugin activation never read them.
      expect(node.context.enabledSourceNames).toEqual(['docs'])
      r.real.cleanup()
    }, MODULE_GRAPH_CASE_BUDGET_MS)

    it('NEGATIVE: a task.yaml naming a plugin enables nothing', async () => {
      const r = await rig(runtime)
      const yaml = { id: `named-${runtime}`, title: 't', goal: 'g', plugins: ['other-plugin'], nodes: [{ id: 'a', prompt: 'a', plugins: ['other-plugin'], llmConnection: CONNECTIONS[runtime] }] }
      const parsed = parseTaskSpec(yaml)
      // The schema keeps no plugin field at either level (unknown keys are not carried into the spec).
      expect(parsed.success && 'plugins' in parsed.data).toBe(false)
      expect(parsed.success && 'plugins' in parsed.data.nodes[0]!).toBe(false)
      const childId = await dispatchNode(r, yaml)
      expect(r.created).toHaveLength(1)
      expect(Object.keys(r.created[0]!).some(k => k.toLowerCase().includes('plugin'))).toBe(false)
      expect(names(await snapshotOf(r.real, childId, r.workspaceId))).not.toContain('other-mcp')
      r.real.cleanup()
    }, MODULE_GRAPH_CASE_BUDGET_MS)
  })
}

describe('UA4.1 — the runtime reaches the context (control)', () => {
  it('the three connections resolve to three different providers in the node context', async () => {
    const providers: unknown[] = []
    for (const runtime of ['pi', 'claude', 'codex'] as const) {
      const r = await rig(runtime)
      const childId = await dispatchNode(r, { id: `prov-${runtime}`, title: 't', goal: 'g', nodes: [{ id: 'a', prompt: 'a', llmConnection: CONNECTIONS[runtime] }] })
      providers.push((await snapshotOf(r.real, childId, r.workspaceId)).context.provider)
      r.real.cleanup()
    }
    expect(new Set(providers).size).toBe(3)
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})
