/**
 * UA12.92 — the run confirmation's plugin list has an in-process test (origin P-UAal-4, UA wave 5 UA-al, 2026-10-02).
 *
 * `registerTasksHandlers`' `nodePlugins` builds `TaskGetResult.runConfirmation.plugins` from a capability snapshot
 * of the orchestrator's project WITHOUT its session (a node is a new session of that project — UA4.1's parity pin —
 * so the orchestrator's session-scoped plugins are not in it) and lists only the ACTIVE plugins' MCP components.
 * The suites that drove the run confirmation before this row (`tasks-run-confirmation.test.ts`) wired the bare
 * test SessionManager, whose default resolver answers an EMPTY snapshot — the list had never been exercised with
 * plugins present.
 *
 * Driven like `conductor-plugins.test.ts`: a recording resolver answers activation by the context it is given
 * (workspace-scoped, project-scoped by `projectKey`, session-scoped by `sessionId`) and projects fixtures into the
 * snapshot shape `toUserCatalog` reads (`installedPlugins` with `activationEnabled`, `entries` carrying the
 * plugin's `pluginKey`).
 *
 * Positive: a workspace plugin and the orchestrator-project plugin are listed with their MCP server names — and
 * only those (a skill component is not an MCP server).
 * Negative: the orchestrator's session-scoped plugin is absent; another project's plugin is absent; a plugin in
 * scope but not activated is absent; a resolver whose read fails leaves `plugins` absent (the confirmation then
 * says it could not be read).
 * Controls (same instrument): the recorded context carries NO `sessionId` and the orchestrator's `projectKey` —
 * and the SAME fixture fires for the orchestrator's own full turn context, so the absence is that strip, not a
 * fixture that can never match; an empty snapshot lists `[]`, not absent (the honest "no plugins" is distinct
 * from "could not be read"); the bare default test resolver — the historical wiring — answers the empty shape.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type {
  CapabilityContext,
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
} from '@nessy-agent/shared/capabilities/resolver'
import { parseTaskYaml } from '@nessy-agent/shared/tasks'
import type { WorkspaceService } from '@nessy-agent/shared/workspaces'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import type { SessionManager } from '../../../sessions/SessionManager'
import { createTestSessionManager } from '../../../sessions/__tests__/test-session-manager.ts'
import { createTaskFromSpec } from '../../../tasks/create-task'
import { registerTasksHandlers } from '../tasks'
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// UA12.92 follow-up (2026-10-08 verification) — every case builds the real SessionManager rig (project-handle
// validation and trust, createTaskFromSpec, tasks:get): per-CASE I/O that timed out on bun's 5 000 ms default under
// load (11 963 / 10 471 / 6 137 ms cold, zero assertion failures), so the cases carry the module-graph CASE budget.
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)

const KEY = Buffer.alloc(32, 7)
const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

/** One plugin the recording resolver knows, with its scope — the three kinds `PluginEnablementScope` defines. */
interface PluginFixture {
  name: string
  pluginKey: string
  mcpServers: string[]
  /** A non-MCP component: must never surface as an MCP server name. */
  skill?: string
  scope: { kind: 'workspace' } | { kind: 'project'; projectKey: string } | { kind: 'session'; sessionId: string }
  /** In scope but NOT activated: installed, `activation.effective` 'inactive' — never listed. */
  deactivated?: boolean
}

/** Which plugins a context activates — decided from the context alone, as the scopes decide it. */
function recordingResolver(plugins: () => PluginFixture[]): CapabilityResolver & { contexts: CapabilityContext[] } {
  const contexts: CapabilityContext[] = []
  const component = (p: PluginFixture, kind: 'mcp' | 'skill', logicalName: string) => ({
    summary: {
      key: `plugin:${p.pluginKey}:${kind}:${logicalName}`,
      kind,
      logicalName,
      pluginKey: p.pluginKey,
      scope: { kind: 'global' },
      // No `enabled` — as `conductor-plugins.test.ts`'s fixture, so the run-time VIEW withholds
      // the entries (its runtimeBinding is a stub); the run-confirmation surface reads the
      // snapshot (`installedPlugins` + `entries`) and never the view.
      readOnly: false,
      trustState: 'trusted',
      credentialState: 'ready',
      diagnostics: [] as unknown[],
    },
    runtimeBinding: { kind },
  })
  return {
    contexts,
    resolve: async (context: CapabilityContext): Promise<EffectiveCapabilitySnapshot> => {
      contexts.push(context)
      const scoped = plugins().filter(p =>
        p.scope.kind === 'workspace'
        || (p.scope.kind === 'project' && p.scope.projectKey === context.projectKey)
        || (p.scope.kind === 'session' && p.scope.sessionId === context.sessionId))
      const entries = scoped.flatMap(p => [
        ...p.mcpServers.map(server => component(p, 'mcp', server)),
        ...(p.skill ? [component(p, 'skill', p.skill)] : []),
      ])
      const installedPlugins = scoped.map(p => ({
        pluginKey: p.pluginKey,
        activeInstanceId: `inst-${p.pluginKey}`,
        origin: { marketplaceId: 'ua12-92', pluginId: p.name },
        name: p.name,
        version: '1.0.0',
        installedAt: 0,
        lifecycleState: 'ready',
        capabilityKinds: ['mcp'],
        activationEnabled: !p.deactivated,
      }))
      return {
        context,
        generation: `g-${contexts.length}`,
        leaseId: `lease-${contexts.length}`,
        entries,
        installedPlugins,
        diagnostics: [],
      } as unknown as EffectiveCapabilitySnapshot
    },
    releaseSnapshot: () => undefined,
    invalidate: () => undefined,
    isLeaseActive: () => true,
    referencedInstances: () => new Set(),
    leaseCount: () => 0,
  } as unknown as CapabilityResolver & { contexts: CapabilityContext[] }
}

function throwingResolver(): CapabilityResolver {
  return {
    resolve: async () => { throw new Error('ua12-92: the capability snapshot cannot be read') },
    releaseSnapshot: () => undefined,
    invalidate: () => undefined,
    isLeaseActive: () => false,
    referencedInstances: () => new Set(),
    leaseCount: () => 0,
  } as unknown as CapabilityResolver
}

type Got = {
  needsRunConfirmation?: boolean
  runConfirmation?: {
    digest: string
    nodeCount: number
    sources: string[]
    orchestratorPermissionMode?: string
    plugins?: { name: string; mcpServers: string[] }[]
  }
}

async function rig(tag: string, plugins: () => PluginFixture[] = () => [], resolver?: CapabilityResolver, bare = false) {
  const root = mkdtempSync(join(tmpdir(), `ua12-92-plugins-${tag}-`))
  roots.push(root)
  const workspaceId = `ws-ua12-92-${tag}-${Math.random().toString(36).slice(2, 8)}`
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
  const recording = recordingResolver(plugins)
  // `bare` → the bare default test resolver, exactly the historical wiring; otherwise the recording
  // one (or an explicit override).
  const wired = bare ? undefined : resolver ?? recording
  const sm = createTestSessionManager(wired ? { workspaceService, resolver: wired } : { workspaceService }) as SessionManager
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
    hostApprovalsKey: async () => KEY,
  })
  const ctx: RequestContext = { clientId: 'client-1', workspaceId, webContentsId: null }
  const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(handlers.get(channel)!(ctx, ...args) as T)
  const wsRoot = join(root, 'workspaces', workspaceId)

  // The orchestrator's trusted project folder: issued, trusted, its `projectKey` read back off the handle.
  const handles = sm.getProjectHandleService()
  const folder = mkdtempSync(join(tmpdir(), `ua12-92-proj-${tag}-`))
  roots.push(folder)
  const issued = await handles.validateProjectDirectory(workspaceId, folder)
  await handles.setProjectTrust({ workspaceId, projectHandleId: issued.id }, 'trusted')
  const projectKey = (await handles.resolveHandle({ workspaceId, projectHandleId: issued.id }))!.projectKey
  return { sm, recording, workspaceId, wsRoot, call, projectHandleId: issued.id, projectKey }
}

const yamlOf = (id: string) => [
  `id: ${id}`,
  `title: ${JSON.stringify(id)}`,
  'goal: ship it',
  'nodes:',
  '  - id: a',
  '    prompt: do a',
  '  - id: b',
  '    depends_on: [a]',
  '    prompt: do b',
  '',
].join('\n')

/** The `create_board_task` path (no `tasks:create`): the shared create core, so no confirmation is recorded. */
async function agentCreate(h: Awaited<ReturnType<typeof rig>>, slug: string): Promise<string> {
  const parsed = parseTaskYaml(yamlOf(slug))
  expect(parsed.valid).toBe(true)
  const created = await createTaskFromSpec(h.sm, h.workspaceId, h.wsRoot, parsed.spec!, {
    projectHandleId: h.projectHandleId,
    permissionMode: 'default',
  })
  return created.orchestratorSessionId
}

type Internals = {
  getManaged(sessionId: string, workspaceId?: string): unknown
  createCapabilityTurn(managed: unknown): Promise<{ snapshot: EffectiveCapabilitySnapshot }>
}
const namesOf = (snapshot: EffectiveCapabilitySnapshot) =>
  (snapshot.entries as unknown as { summary: { logicalName: string } }[]).map(e => e.summary.logicalName).sort()

describe('UA12.92 — the run confirmation\'s plugin list (nodePlugins)', () => {
  it('POSITIVE: a workspace and the orchestrator-project plugin are listed with their MCP server names; NEGATIVE: the orchestrator\'s session-scoped plugin, another project\'s plugin and an in-scope-but-deactivated plugin are not', async () => {
    const plugins: PluginFixture[] = []
    const h = await rig('list', () => plugins)
    try {
      const orchestrator = await agentCreate(h, 'ship-plugins')
      plugins.push(
        { name: 'ws-plugin', pluginKey: 'pk-ws', mcpServers: ['ws-mcp-a', 'ws-mcp-b'], skill: 'ws-skill', scope: { kind: 'workspace' } },
        { name: 'proj-plugin', pluginKey: 'pk-proj', mcpServers: ['proj-mcp'], scope: { kind: 'project', projectKey: h.projectKey } },
        { name: 'other-plugin', pluginKey: 'pk-other', mcpServers: ['other-mcp'], scope: { kind: 'project', projectKey: 'p_ua12-92-other' } },
        { name: 'session-plugin', pluginKey: 'pk-session', mcpServers: ['session-mcp'], scope: { kind: 'session', sessionId: orchestrator } },
        { name: 'ghost-plugin', pluginKey: 'pk-ghost', mcpServers: ['ghost-mcp'], scope: { kind: 'workspace' }, deactivated: true },
      )
      const got = await h.call<Got>(RPC_CHANNELS.tasks.GET, h.workspaceId, 'ship-plugins')
      expect(got.needsRunConfirmation).toBe(true)
      // Workspace + the orchestrator's project, MCP servers only (ws-plugin's skill is not a server);
      // exact equality also excludes ghost/session/other by construction.
      expect(got.runConfirmation!.plugins).toEqual([
        { name: 'ws-plugin', mcpServers: ['ws-mcp-a', 'ws-mcp-b'] },
        { name: 'proj-plugin', mcpServers: ['proj-mcp'] },
      ])
      // CONTROL: the list is the orchestrator's PROJECT snapshot — the resolver was given no session…
      const recorded = h.recording.contexts.at(-1)!
      expect(recorded.sessionId).toBeUndefined()
      expect(recorded.projectKey).toBe(h.projectKey)
      // …and the SAME fixture fires for the orchestrator's own full turn context, so the absence above is
      // that strip (UA4.1's parity pin), not a fixture that can never match.
      const internals = h.sm as unknown as Internals
      const turn = await internals.createCapabilityTurn(internals.getManaged(orchestrator, h.workspaceId))
      expect(namesOf(turn.snapshot)).toContain('session-mcp')
    } finally {
      await h.sm.cleanup()
    }
  })

  it('NEGATIVE: a resolver whose read fails leaves plugins absent', async () => {
    const failing = await rig('throw', () => [], throwingResolver())
    try {
      await agentCreate(failing, 'ship-throw')
      const got = await failing.call<Got>(RPC_CHANNELS.tasks.GET, failing.workspaceId, 'ship-throw')
      expect(got.needsRunConfirmation).toBe(true)
      expect(got.runConfirmation!.plugins).toBeUndefined()
    } finally {
      await failing.sm.cleanup()
    }
  })

  it('BOUNDARY: an empty snapshot lists an empty set, not an absent one', async () => {
    const empty = await rig('empty')
    try {
      await agentCreate(empty, 'ship-empty')
      const none = await empty.call<Got>(RPC_CHANNELS.tasks.GET, empty.workspaceId, 'ship-empty')
      expect(none.runConfirmation!.plugins).toEqual([])
    } finally {
      await empty.sm.cleanup()
    }
  })

  it('MEASURED (the P-UAal-4 premise, 2026-10-04): the bare default test resolver — the historical wiring — answers an EMPTY snapshot, so the historical suites read plugins: [] (present and empty), not undefined', async () => {
    const bare = await rig('bare', () => [], undefined, true)
    try {
      await agentCreate(bare, 'ship-bare')
      const got = await bare.call<Got>(RPC_CHANNELS.tasks.GET, bare.workspaceId, 'ship-bare')
      expect(got.runConfirmation!.plugins).toEqual([])
      // The default resolver answered: the recording one was never consulted.
      expect(bare.recording.contexts).toHaveLength(0)
    } finally {
      await bare.sm.cleanup()
    }
  })
})
