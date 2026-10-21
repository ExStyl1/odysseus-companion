import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import { PiAgent } from '../pi-agent.ts'
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'

// T5: a plugin MCP server's wire name changed from a bare logical name to
// `plugin_<pluginId>_<serverName>` (mcp-wire-name.ts, T2). These tests pin
// the read-path migration alias: a user-authored `piAllowedTools` pattern
// written against the OLD bare name must also match the plugin's new wire
// name — but only when exactly one active server carries that logical name.

function config(): BackendConfig {
  return {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' } as any,
    session: { id: 'parent', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 } as any,
  }
}

function baseView(mcpServers: unknown[]): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g1', sources: [], skills: [], mcpServers, hooks: [], automations: [],
      agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [],
      promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
      async readText() { return '' }, resolveCredential() { throw new Error('unused') },
    },
  } as CapabilityTurnRuntime
}

describe('PiAgent.expandMcpPatternAliases (T5)', () => {
  // NOTE: this proves STRING GENERATION only — that the wildcard shape mirrors
  // onto the wire name syntactically. It does NOT prove a `mcp__x__*` entry
  // admits anything: every consumer of the expanded set on the read path
  // (`buildCurrentProxyToolDefinitions`, `buildExecutionManifestForCurrentTurn`,
  // `harness-manifest.ts`) does exact membership testing, never a glob match,
  // so the aliased wildcard string is inert today. See the comment on the
  // wildcard branch inside `expandMcpPatternAliases` for the full accounting;
  // the exact-shape sibling test (`mcp__t-tracker__list`) below IS an
  // admission proof, via `buildCurrentProxyToolDefinitions`.
  it('generates the wire-qualified alias STRING for both the wildcard and exact pattern shapes', () => {
    const agent = new PiAgent(config())
    agent.setCapabilityTurnRuntime(baseView([
      { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
    ]))
    try {
      const expanded = (agent as any).expandMcpPatternAliases(['mcp__t-tracker__*', 'mcp__t-tracker__list'])
      // Originals are kept (the old pattern must keep working for any tool
      // that still resolves under it) and the wire-qualified mirror is
      // appended, in EACH shape it was requested in.
      expect(expanded).toEqual([
        'mcp__t-tracker__*',
        'mcp__t-tracker__list',
        'mcp__plugin_x_t-tracker__*',
        'mcp__plugin_x_t-tracker__list',
      ])
    } finally {
      agent.destroy()
    }
  })

  it('does not expand an ambiguous bare name (two active servers) or a non-plugin server', () => {
    const agent = new PiAgent(config())
    agent.setCapabilityTurnRuntime(baseView([
      // A builtin/scoped entry: no `pluginInstanceId`, wire name already
      // equals the logical name — aliasing it would be a no-op duplicate.
      { key: 'native:mcp:docs', wireName: 'docs', logicalName: 'docs' },
      // Two PLUGIN servers sharing one bare logical name: which one the user
      // meant is genuinely ambiguous, so neither wins — the safety-critical
      // arm that keeps this alias from silently widening a permission.
      { key: 'plug:mcp:a', wireName: 'plugin_a_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/a@1.0.0#hash' },
      { key: 'plug:mcp:b', wireName: 'plugin_b_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/b@1.0.0#hash' },
    ]))
    try {
      const expanded = (agent as any).expandMcpPatternAliases(['mcp__docs__*', 'mcp__t-tracker__*'])
      expect(expanded).toEqual(['mcp__docs__*', 'mcp__t-tracker__*'])
    } finally {
      agent.destroy()
    }
  })

  it('does not push a duplicate when the list already holds the migrated wire-qualified twin', () => {
    const agent = new PiAgent(config())
    agent.setCapabilityTurnRuntime(baseView([
      { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
    ]))
    try {
      // The list holds BOTH the stale bare pattern and its already-migrated
      // wire-qualified twin (e.g. the user re-saved half their patterns).
      // Without the dedup guard, expanding the bare entry pushes the
      // wire-qualified string a second time.
      const expanded = (agent as any).expandMcpPatternAliases(['mcp__t-tracker__list', 'mcp__plugin_x_t-tracker__list'])
      expect(expanded).toEqual(['mcp__t-tracker__list', 'mcp__plugin_x_t-tracker__list'])
    } finally {
      agent.destroy()
    }
  })
})

describe('PiAgent execution manifest: stale bare-name piAllowedTools admits the plugin wire name (T5)', () => {
  it('a piAllowedTools entry written against the old bare name still admits the renamed plugin tool', () => {
    const cfg = config()
    // The user's restriction predates the T2 rename and still names the bare
    // server. Without the T5 alias this would admit nothing post-rename.
    cfg.piAllowedTools = ['mcp__t-tracker__list']
    const agent = new PiAgent(cfg)
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'g1',
      sessionKey: { workspaceId: 'ws', sessionId: 'parent' },
      provenance: [],
      mcpSources: [],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      // A hand-built capability identity standing in for the plugin's
      // renamed proxy tool. `capabilityIdentities` in
      // `buildExecutionManifestForCurrentTurn` is built uniformly from
      // static + dynamic tool sources and gated by the SAME
      // `piAllowedTools`-derived set either way, so a static fixture here
      // exercises exactly the composition block T5 modifies without
      // depending on the separate MCP pool proxy-tool filter in
      // `buildCurrentProxyToolDefinitions` (also alias-aware — covered
      // directly by its own describe block below).
      staticTools: [{
        descriptor: { id: 'mcp_dynamic' },
        binding: {
          provider: 'pi', surfaceVersion: 2, piName: 'mcp__plugin_x_t-tracker__list',
          modelSchemaVersion: 1, bindingName: 'mcp__plugin_x_t-tracker__list', bindingSchemaVersion: 1,
          handlerName: 'mcp_dynamic', handlerSchemaVersion: 1, descriptorId: 'mcp_dynamic',
          permissionName: 'mcp__plugin_x_t-tracker__list',
        },
        source: { kind: 'piBuiltin', bindingId: 'mcp__plugin_x_t-tracker__list' },
      }] as any,
    }
    agent.setCapabilityTurnRuntime({
      ...baseView([
        { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
      ]),
      piExecutionManifestSeed: seed,
    } as CapabilityTurnRuntime)
    try {
      const execution = (agent as any).buildExecutionManifestForCurrentTurn()
      expect(execution.manifest.tools.map((tool: any) => tool.binding.bindingName)).toContain('mcp__plugin_x_t-tracker__list')
    } finally {
      agent.destroy()
    }
  })
})

// Review fix: `buildExecutionManifestForCurrentTurn`'s permission gate was
// alias-aware from the start, but the SIBLING filter that narrows the proxy
// tool list itself — `buildCurrentProxyToolDefinitions`, fed by
// `config.piAllowedTools` (which for a restricted child/subagent session is
// `managed.piChildRestrictions?.tools`, SessionManager.ts) — used the RAW
// patterns. A restricted session with a pre-rename bare-name pattern lost the
// plugin's tool entirely on this path even though the top-level manifest gate
// would have admitted it.
function poolWith(defs: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]) {
  return {
    setElicitationHandler() {},
    hasResourceCapability: () => false,
    getProxyToolDefs: () => defs,
  } as any
}

describe('PiAgent.buildCurrentProxyToolDefinitions: sibling piAllowedTools filter honors the alias too (T5 fix)', () => {
  it('a piAllowedTools entry written against the old bare name still admits the renamed plugin proxy tool', () => {
    const cfg = config()
    cfg.piAllowedTools = ['mcp__t-tracker__list']
    cfg.mcpPool = poolWith([
      { name: 'mcp__plugin_x_t-tracker__list', description: 'list tracker items', inputSchema: { type: 'object', properties: {} } },
    ])
    const agent = new PiAgent(cfg)
    agent.setCapabilityTurnRuntime(baseView([
      { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
    ]))
    try {
      const names = (agent as any).buildCurrentProxyToolDefinitions().map((tool: { name: string }) => tool.name)
      expect(names).toContain('mcp__plugin_x_t-tracker__list')
    } finally {
      agent.destroy()
    }
  })

  // The ambiguity guard must hold on THIS path too: this filter gates tool
  // visibility, so a wrong expansion here would widen what a restricted
  // session can call — the opposite of what a permission filter is for.
  it('does not admit either wire name when the bare logical name is ambiguous (two active servers)', () => {
    const cfg = config()
    cfg.piAllowedTools = ['mcp__t-tracker__list']
    cfg.mcpPool = poolWith([
      { name: 'mcp__plugin_a_t-tracker__list', description: 'list tracker items', inputSchema: { type: 'object', properties: {} } },
      { name: 'mcp__plugin_b_t-tracker__list', description: 'list tracker items', inputSchema: { type: 'object', properties: {} } },
    ])
    const agent = new PiAgent(cfg)
    agent.setCapabilityTurnRuntime(baseView([
      { key: 'plug:mcp:a', wireName: 'plugin_a_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/a@1.0.0#hash' },
      { key: 'plug:mcp:b', wireName: 'plugin_b_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/b@1.0.0#hash' },
    ]))
    try {
      const names = (agent as any).buildCurrentProxyToolDefinitions().map((tool: { name: string }) => tool.name)
      expect(names).not.toContain('mcp__plugin_a_t-tracker__list')
      expect(names).not.toContain('mcp__plugin_b_t-tracker__list')
    } finally {
      agent.destroy()
    }
  })
})

// Final-branch review, Finding 3: `expandMcpPatternAliases` widened a pattern
// that ALREADY resolved correctly on its own. `byLogical` was keyed from
// PLUGIN servers only, so a bare name a builtin/scoped server (or a user MCP
// source) already owns outright was never checked against — a pattern that
// means the non-plugin owner (`mcp__t-tracker__list`, say) ALSO admitted a
// same-named plugin's wire-qualified tool the pattern never named. That is a
// widening, not a migration: exactly the asymmetry a permission-surface fix
// must not introduce.
describe('PiAgent.expandMcpPatternAliases: a bare name already owned by a non-plugin entity never expands (Finding 3 fix)', () => {
  it('does not admit a plugin wire name when a builtin/scoped mcpServers entry already owns the bare name', () => {
    const agent = new PiAgent(config())
    agent.setCapabilityTurnRuntime(baseView([
      // The BUILTIN owns the bare name outright — N1: its wireName equals its
      // logicalName. A pattern naming it already resolves; aliasing besides
      // would ADMIT the plugin's tool under a name the pattern never spelled.
      { key: 'native:mcp:t-tracker', wireName: 't-tracker', logicalName: 't-tracker' },
      // A different plugin happens to bundle a same-named server — shadowed
      // at the bare name (T2), reachable only via its own qualified wire name.
      { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
    ]))
    try {
      const expanded = (agent as any).expandMcpPatternAliases(['mcp__t-tracker__list'])
      expect(expanded).toEqual(['mcp__t-tracker__list'])
    } finally {
      agent.destroy()
    }
  })

  it('does not admit a plugin wire name when a user MCP source already owns the bare name', () => {
    const agent = new PiAgent(config())
    const runtime = baseView([
      { key: 'plug:mcp:notes', wireName: 'plugin_x_notes', logicalName: 'notes', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
    ])
    ;(runtime.view as any).sources = [
      { key: 'source:mcp:notes', logicalName: 'notes', mcpWireName: 'notes' },
    ]
    agent.setCapabilityTurnRuntime(runtime)
    try {
      const expanded = (agent as any).expandMcpPatternAliases(['mcp__notes__list'])
      expect(expanded).toEqual(['mcp__notes__list'])
    } finally {
      agent.destroy()
    }
  })

  // Positive control: an UNOWNED bare name (no non-plugin server, no source)
  // still expands — proves the guard above targets ownership specifically and
  // did not just disable the alias outright.
  it('still expands a bare name nothing else owns', () => {
    const agent = new PiAgent(config())
    agent.setCapabilityTurnRuntime(baseView([
      { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
    ]))
    try {
      const expanded = (agent as any).expandMcpPatternAliases(['mcp__t-tracker__list'])
      expect(expanded).toEqual(['mcp__t-tracker__list', 'mcp__plugin_x_t-tracker__list'])
    } finally {
      agent.destroy()
    }
  })
})

// Final-branch review, Finding 3: the host computed the expanded alias set and
// used it to decide which manifest tools are admitted, but `spawnSubprocess`
// sent the SUBPROCESS's own tool ceiling (`allowedToolNames` on the init
// message, consumed by `resolvePiAllowedBindingNames` in
// pi-agent-server/src/harness/tool-manifest.ts) from the RAW, un-expanded
// `this.config.piAllowedTools` — so a restricted child/subagent session's
// alias-admitted plugin tool was present in the manifest but then filtered
// back out by the subprocess's own exact-match ceiling. This test drives the
// real `spawnSubprocess` (mocking only the OS-facing edges: process spawn,
// stdout stream, and the two RPCs that await a subprocess reply this test
// never sends) and asserts on the actual `type: 'init'` message payload —
// not on whether `expandMcpPatternAliases` was called.
function fakeChildProcess(stdout: PassThrough) {
  const child = new EventEmitter() as unknown as {
    stdout: PassThrough
    stderr: undefined
    stdin: { writable: boolean }
    kill(signal?: string): boolean
    pid: number
    exitCode: null
    on(event: string, listener: (...args: unknown[]) => void): void
  }
  Object.assign(child, {
    stdout,
    stderr: undefined,
    stdin: { writable: true },
    kill: () => true,
    pid: 4242,
    exitCode: null,
  })
  return child
}

describe('PiAgent.spawnSubprocess: allowedToolNames on the init message is the EXPANDED list (Finding 3 fix)', () => {
  it('sends the wire-qualified alias to the subprocess, not the raw stale bare-name pattern', async () => {
    const cfg = config()
    cfg.piAllowedTools = ['mcp__t-tracker__list']
    // Minimal runtime payload: no piAuthProvider (getPiAuth() short-circuits to
    // null with no credential-manager lookup) and a custom endpoint (so the
    // legacy-API-key fallback is skipped too) — spawnSubprocess reaches the
    // init send without touching real credentials.
    cfg.runtime = {
      paths: { piServer: '/fake/pi-server.js', node: process.execPath },
      customEndpoint: { api: 'openai-completions' },
    }
    const agent = new PiAgent(cfg)
    const state = agent as any

    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'g1',
      sessionKey: { workspaceId: 'ws', sessionId: 'parent' },
      provenance: [],
      mcpSources: [],
      orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
      staticTools: [],
    }
    agent.setCapabilityTurnRuntime({
      ...baseView([
        { key: 'plug:mcp:t-tracker', wireName: 'plugin_x_t-tracker', logicalName: 't-tracker', pluginInstanceId: 'plugin://internal/x@1.0.0#hash' },
      ]),
      piExecutionManifestSeed: seed,
    } as CapabilityTurnRuntime)

    const sent: Record<string, unknown>[] = []
    const attempt = state.beginSubprocessAttempt()
    const stdout = new PassThrough()
    state.spawnProcess = () => fakeChildProcess(stdout)
    state.send = (message: Record<string, unknown>) => {
      sent.push(message)
      // spawnSubprocess awaits attempt.ready right after sending init; nothing
      // else in this test ever resolves it.
      if (message.type === 'init') attempt.resolveReady()
    }
    // Both run their own RPC round trip this test never answers; neither is
    // under test here (the init message already carries what we're asserting
    // by the time either would run).
    state.publishExecutionManifest = async () => {}
    state.requestSetAutoCompaction = async () => true

    try {
      await state.spawnSubprocess(attempt)
      const init = sent.find(message => message.type === 'init')
      expect(init).toBeDefined()
      expect(init!.allowedToolNames).toEqual(['mcp__t-tracker__list', 'mcp__plugin_x_t-tracker__list'])
    } finally {
      // Skip the real subprocess-termination machinery (it expects a live
      // ChildProcess/readline pair) — this test only needs the init send.
      state.subprocess = null
      state.readline = null
      stdout.destroy()
      agent.destroy()
    }
  })
})
