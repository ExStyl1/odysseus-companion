import { describe, expect, it } from 'bun:test'
import type { BackendConfig } from '../backend/types.ts'
import { PiAgent } from '../pi-agent.ts'
import type { CapabilityTurnRuntime } from '../backend/types.ts'
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'

function config(): BackendConfig {
  return {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' } as any,
    session: { id: 'parent', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 } as any,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0))
}

describe('PiAgent child orchestration port', () => {
  it('routes every child operation through the one injected SessionKey-bound host port', async () => {
    const calls: string[] = []
    const cfg = config()
    cfg.childSessionPort = {
      start: async input => { calls.push(`start:${input.agent}`); return { agentId: 'a1', ownerTaskId: input.ownerTaskId, status: 'running', output: '' } },
      resume: async (id, input) => { calls.push(`resume:${id}:${input}`); return { agentId: id, status: 'completed', output: 'done' } },
      steer: async (id, message) => { calls.push(`steer:${id}:${message}`) },
      getResult: async (id, options) => { calls.push(`result:${id}:${options?.wait === true}`); return { agentId: id, status: 'completed', output: 'done' } },
      stop: async id => { calls.push(`stop:${id}`) },
      stopTask: async id => { calls.push(`stopTask:${id}`) },
      sealOwnerTask: async id => { calls.push(`seal:${id}`) },
      searchOutput: async (id, query) => { calls.push(`search:${id}:${query}`); return { agentId: id, cursor: 4, status: 'running', results: ['match'] } },
      attach: async (id, cursor) => { calls.push(`attach:${id}:${cursor}`); return { agentId: id, cursor: 4, output: 'tail', status: 'running' } },
      monitor: async id => { calls.push(`monitor:${id}`); return { agentId: id, status: 'running', output: '' } },
    }
    const agent = new PiAgent(cfg)
    const sent: any[] = []
    ;(agent as any).send = (value: unknown) => { sent.push(value) }
    ;(agent as any).subprocess = {}
    const requests = [
      { operation: 'start', input: { agent: 'scout', task: 'inspect', ownerTaskId: 't1', backgroundTaskId: 'bg1', background: true, restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' }, budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: 1, deadlineAt: 1, ancestry: [] } } },
      { operation: 'resume', agentId: 'a1', input: 'continue' },
      { operation: 'steer', agentId: 'a1', message: 'focus' },
      { operation: 'get_result', agentId: 'a1', wait: true },
      { operation: 'stop', agentId: 'a1' },
      { operation: 'stop_task', taskId: 't1' },
      { operation: 'seal_owner_task', ownerTaskId: 'owner-1' },
      { operation: 'search_output', agentId: 'a1', query: 'x' },
      { operation: 'attach', agentId: 'a1', cursor: 2 },
      { operation: 'monitor', agentId: 'a1' },
    ]
    requests.forEach((request, index) => (agent as any).handleLine(JSON.stringify({ type: 'child_session_request', requestId: `r${index}`, request })))
    await flush()
    expect(calls).toEqual([
      'start:scout', 'resume:a1:continue', 'steer:a1:focus', 'result:a1:true', 'stop:a1',
      'stopTask:t1', 'seal:owner-1', 'search:a1:x', 'attach:a1:2', 'monitor:a1',
    ])
    expect(sent.filter(message => message.type === 'child_session_response')).toHaveLength(10)
    ;(agent as any).subprocess = null
    agent.destroy()
  })

  it('fails closed when the host port is absent', async () => {
    const agent = new PiAgent(config())
    const sent: any[] = []
    ;(agent as any).send = (value: unknown) => { sent.push(value) }
    ;(agent as any).subprocess = {}
    ;(agent as any).handleLine(JSON.stringify({ type: 'child_session_request', requestId: 'r1', request: { operation: 'get_result', agentId: 'a1' } }))
    await flush()
    expect(sent).toContainEqual({ type: 'child_session_response', requestId: 'r1', error: 'pi-child-session-port-unavailable' })
    ;(agent as any).subprocess = null
    agent.destroy()
  })

  it('registers exactly the allowed manifest surface when an extra MCP proxy exists', () => {
    const cfg = config()
    // R20: the legacy `mcp__session__Task` is no longer projected onto Pi by
    // default (NESSY_ENABLE_TASKS), so this pins the same invariant — an extra
    // MCP proxy is filtered out — against a tool that IS in the default surface.
    cfg.piAllowedTools = ['mcp__session__TaskList']
    cfg.mcpPool = {
      setElicitationHandler() {},
      getProxyToolDefs: () => [{ name: 'mcp__github__send', description: 'send', inputSchema: { type: 'object' } }],
      alwaysLoadProxyToolNames: () => new Set<string>(),
      // R5 made the MCP resource tools conditional on a connected source
      // advertising the capability; this pool advertises none.
      hasResourceCapability: () => false,
    } as any
    const agent = new PiAgent(cfg)
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'g1',
      sessionKey: { workspaceId: 'ws', sessionId: 'parent' },
      provenance: [{ capabilityKey: 'github', generation: 'g1' }],
      mcpSources: [{ wireName: 'github', capabilityKey: 'github', generation: 'g1' }],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: [],
    }
    agent.setCapabilityTurnRuntime({
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
      materializer: { assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' }, async readText() { return '' }, resolveCredential() { throw new Error('unused') } },
      piExecutionManifestSeed: seed,
    } as CapabilityTurnRuntime)
    try {
      const execution = (agent as any).buildExecutionManifestForCurrentTurn()
      expect(execution.tools.map((tool: any) => tool.name)).toEqual(['mcp__session__TaskList'])
      expect(execution.manifest.tools.map((tool: any) => tool.binding.bindingName)).toEqual(['mcp__session__TaskList'])
    } finally {
      agent.destroy()
    }
  })

  /**
   * S14: the env override has to reach the SIGNED manifest from the HOST.
   *
   * The decision function and the manifest builder are both covered on their own,
   * and neither notices if `buildExecutionManifestForCurrentTurn` stops passing
   * `toolSearchMode()`: deleting that one line typechecks clean and reddens
   * nothing. This is the only test that fails when the variable is read nowhere,
   * which is the declared-versus-enforced split this series keeps finding.
   */
  it('reads NESSY_ENABLE_TOOL_SEARCH on the host and carries it into the signed manifest', () => {
    const previous = process.env.NESSY_ENABLE_TOOL_SEARCH
    const cfg = config()
    cfg.mcpPool = {
      setElicitationHandler() {},
      getProxyToolDefs: () => [{ name: 'mcp__github__send', description: 'send', inputSchema: { type: 'object' } }],
      alwaysLoadProxyToolNames: () => new Set<string>(),
      hasResourceCapability: () => false,
    } as any
    const agent = new PiAgent(cfg)
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'g1',
      sessionKey: { workspaceId: 'ws', sessionId: 'parent' },
      provenance: [{ capabilityKey: 'github', generation: 'g1' }],
      mcpSources: [{ wireName: 'github', capabilityKey: 'github', generation: 'g1' }],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: [],
    }
    agent.setCapabilityTurnRuntime({
      view: { generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
      materializer: { assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' }, async readText() { return '' }, resolveCredential() { throw new Error('unused') } },
      piExecutionManifestSeed: seed,
    } as CapabilityTurnRuntime)
    try {
      // UNSET is now ON, and that is the whole of what changed here. The
      // workspace preference ships enabled, and `tool-search-settings.ts`'s
      // `(unset)` arm consults the preference and the presence of a candidate —
      // nothing else. This assertion used to read `enabled: false` with the
      // comment "the workspace preference off", which was true of the shipped
      // default until it was flipped and stale the moment it was.
      //
      // Worth keeping in view: this file is in `packages/shared/src/agent` while
      // the flip lives in `config/`, and the focused suites run for that change
      // did not include it. A default's blast radius is every test that encoded
      // the old default as a premise, which is not the same set as the tests
      // near the code.
      //
      // C5 then moved the same line a second time, which is why the candidate
      // list is no longer asserted by exact equality: session tools now defer
      // too, so the set is the MCP tool plus 42 session bindings, and pinning it
      // here would re-break on every future change to the deferrable set while
      // proving nothing this case is about. What the case is about is the
      // override, and that is asserted directly.
      delete process.env.NESSY_ENABLE_TOOL_SEARCH
      const unset = (agent as any).buildExecutionManifestForCurrentTurn().manifest
      expect(unset.deferredMcp.enabled).toBe(true)
      expect(unset.deferredMcp.candidatePiNames).toContain('mcp__github__send')

      // The env var is still the override, in BOTH directions — which is what
      // this case is actually for, and the half that the default cannot prove.
      process.env.NESSY_ENABLE_TOOL_SEARCH = 'true'
      const deferred = (agent as any).buildExecutionManifestForCurrentTurn().manifest
      expect(deferred.deferredMcp.enabled).toBe(true)
      expect(deferred.deferredMcp.candidatePiNames).toContain('mcp__github__send')

      process.env.NESSY_ENABLE_TOOL_SEARCH = 'false'
      expect((agent as any).buildExecutionManifestForCurrentTurn().manifest.deferredMcp)
        .toEqual({ enabled: false, candidatePiNames: [] })
    } finally {
      if (previous === undefined) delete process.env.NESSY_ENABLE_TOOL_SEARCH
      else process.env.NESSY_ENABLE_TOOL_SEARCH = previous
      agent.destroy()
    }
  })
})
