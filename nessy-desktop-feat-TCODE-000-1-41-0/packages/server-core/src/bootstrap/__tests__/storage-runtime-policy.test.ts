import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { createCapabilitySnapshotMaterializer } from '@nessy-agent/shared/capabilities/materializer'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  type PluginInstalledEntryV2,
  type PluginStoreV2,
} from '@nessy-agent/shared/plugins'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

const PROJECT_KEY = `p_${'a'.repeat(32)}` as const
const BUNDLE_HASH = 'b'.repeat(64)
const INSTANCE_ID = `plugin://internal/toolkit@1.0.0#${BUNDLE_HASH}`

let root: string
let workspaceRoot: string
let projectRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'storage-runtime-policy-'))
  workspaceRoot = join(root, 'workspace')
  projectRoot = join(root, 'project')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function installedEntry(): PluginInstalledEntryV2 {
  return {
    pluginInstanceId: INSTANCE_ID,
    pluginKey: 'pk-toolkit',
    marketplaceId: 'internal',
    pluginId: 'toolkit',
    version: '1.0.0',
    bundleHash: BUNDLE_HASH,
    cacheRef: {
      marketplaceId: 'internal',
      pluginId: 'toolkit',
      version: '1.0.0',
      bundleHash: BUNDLE_HASH,
    },
    manifest: {
      schemaVersion: 1,
      kind: 'plugin',
      id: 'toolkit',
      name: 'Toolkit',
      version: '1.0.0',
      capabilities: [],
    },
    origin: { source: 'marketplace', marketplaceId: 'internal', resolvedAt: 1 },
    installedAt: 1,
    diagnostics: [],
  }
}

function context(projectTrustState: CapabilityContext['projectTrustState']): CapabilityContext {
  return {
    workspaceId: 'ws_a',
    projectRoot,
    projectKey: PROJECT_KEY,
    projectTrustState,
    projectTrustRevision: 'trust-r1',
  }
}

function deps(policyStore = new CapabilityPolicyStore({
  globalPath: join(root, 'config', 'capabilities.json'),
  workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
})): CapabilityInputsV2Deps {
  const entry = installedEntry()
  return {
    resolveWorkspaceRootPath: () => workspaceRoot,
    nativeSourcesEnv: {
      // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
      // cannot read the machine's real administrator roots. Why the field is
      // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
      adminSkillsDirs: [],
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    pluginStore: {
      readInstalledRegistry: async () => ({
        schemaVersion: 2,
        updatedAt: 1,
        active: { [entry.pluginKey]: entry.pluginInstanceId },
        plugins: [entry],
      }),
      cachePathFor: () => join(root, 'cache'),
      acquireInstanceLease: () => () => {},
    } as unknown as PluginStoreV2,
    policyStore,
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: () => { throw new Error('unexpected credential bind') },
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as CapabilityInputsV2Deps['credentialBackend'],
  }
}

describe('buildCapabilityResolutionInputsV2 project policy overlay', () => {
  it('maps trusted project pluginId and instance selectors onto active v2 installs', async () => {
    const nessyDir = join(projectRoot, '.nessy-agent')
    mkdirSync(nessyDir, { recursive: true })
    writeFileSync(join(nessyDir, 'config.toml'), [
      '[plugins.toolkit]',
      'enabled = true',
      'enabled_capabilities = ["review"]',
      '',
      `[plugins."${INSTANCE_ID}"]`,
      'enabled_capabilities = ["format"]',
    ].join('\n'))

    const inputs = await buildCapabilityResolutionInputsV2(context('trusted'), deps())

    expect(inputs.resolveActivation({ pluginKey: 'pk-toolkit' }, 'review')).toMatchObject({
      enabled: true,
      suppressed: false,
    })
    expect(inputs.resolveActivation({ pluginInstanceId: INSTANCE_ID }, 'format')).toMatchObject({
      enabled: true,
      suppressed: false,
    })
  })

  it('threads REAL per-scope activation onto the resolved snapshot (U4 menu-label defect)', async () => {
    // A plugin enabled at the WORKSPACE scope must reach the snapshot as
    // workspace:'enabled' so the Sources/marketplace row menu offers "Disable"
    // (not the always-"Enable" of the pre-fix hardcoded 'unset').
    const policyStore = new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    })
    policyStore.recordWorkspace('ws_a', { pluginKey: 'pk-toolkit', enabled: true })

    const inputs = await buildCapabilityResolutionInputsV2(context('none'), deps(policyStore))
    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(context('none'))
    try {
      const plugin = snapshot.installedPlugins.find(p => p.pluginKey === 'pk-toolkit')
      expect(plugin?.activation).toEqual({ global: 'unset', workspace: 'enabled', project: 'unset' })
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('does not read the repository config for unknown or blocked projects', async () => {
    mkdirSync(join(projectRoot, '.nessy-agent', 'config.toml'), { recursive: true })

    for (const trustState of ['none', 'blocked'] as const) {
      const inputs = await buildCapabilityResolutionInputsV2(context(trustState), deps())
      expect(inputs.resolveActivation({ pluginKey: 'pk-toolkit' })).toEqual({
        enabled: false,
        suppressed: false,
        capabilities: {},
      })
    }
  })

  it('keeps an earlier terminal suppression when the trusted overlay enables the plugin', async () => {
    const nessyDir = join(projectRoot, '.nessy-agent')
    mkdirSync(nessyDir, { recursive: true })
    writeFileSync(join(nessyDir, 'config.toml'), [
      '[plugins.toolkit]',
      'enabled = true',
      'enabled_capabilities = ["review"]',
    ].join('\n'))
    const policyStore = new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    })
    policyStore.recordGlobal({ pluginKey: 'pk-toolkit', enabled: false })

    const inputs = await buildCapabilityResolutionInputsV2(context('trusted'), deps(policyStore))

    expect(inputs.resolveActivation({ pluginKey: 'pk-toolkit' })).toMatchObject({
      enabled: false,
      suppressed: true,
      capabilities: { review: true },
    })
  })

  it('pairs an active plugin MCP hash with its immutable cache root for runtime materialization', async () => {
    const bundleRoot = join(root, 'cache', 'toolkit')
    mkdirSync(bundleRoot, { recursive: true })
    writeFileSync(join(bundleRoot, 'plugin.json'), '{"kind":"plugin"}')
    const bundleHash = await computeNormalizedBundleHash(bundleRoot)
    const pluginInstanceId = `plugin://internal/toolkit@1.0.0#${bundleHash}`
    const entry: PluginInstalledEntryV2 = {
      ...installedEntry(),
      pluginInstanceId,
      bundleHash,
      cacheRef: { marketplaceId: 'internal', pluginId: 'toolkit', version: '1.0.0', bundleHash },
      manifest: {
        schemaVersion: 1,
        kind: 'plugin',
        id: 'toolkit',
        name: 'Toolkit',
        version: '1.0.0',
        capabilities: [{
          kind: 'mcp',
          id: 'wiki',
          mcp: { serverName: 'wiki', transport: 'stdio', command: 'wiki-mcp' },
        }],
      },
    }
    const policyStore = new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    })
    policyStore.recordGlobal({ pluginKey: entry.pluginKey, enabled: true })
    const testDeps: CapabilityInputsV2Deps = {
      ...deps(policyStore),
      pluginStore: {
        readInstalledRegistry: async () => ({
          schemaVersion: 2,
          updatedAt: 1,
          active: { [entry.pluginKey]: pluginInstanceId },
          plugins: [entry],
        }),
        cachePathFor: () => bundleRoot,
        acquireInstanceLease: () => () => {},
      } as unknown as PluginStoreV2,
    }
    const capabilityContext: CapabilityContext = {
      workspaceId: 'ws_a',
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
    const inputs = await buildCapabilityResolutionInputsV2(capabilityContext, testDeps)
    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(capabilityContext)

    try {
      expect(snapshot.installedPlugins[0]?.bundleRootPath).toBe(bundleRoot)
      expect(toAgentRuntime(snapshot).mcpServers).toHaveLength(1)
      await expect(
        createCapabilitySnapshotMaterializer(resolver, snapshot).verifyPlugin(pluginInstanceId),
      ).resolves.toBeUndefined()
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })
})

describe('buildCapabilityResolutionInputsV2 session-selection mapping (R3 A+C)', () => {
  // Session selection maps ONLY `kind === 'source'` logical names to enabled
  // keys. Native `.mcp.json`/`mcp.json` records (`kind === 'mcp'`) are exempt
  // and never appear in `enabledSourceKeys` — MCP is activation-governed.
  it('includes folder/API source keys but never native MCP keys, and MCP omission does not gate it off', async () => {
    // Workspace source (kind 'source', api transport).
    const sourceDir = join(workspaceRoot, 'sources', 'gmail')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ type: 'api', name: 'Gmail', enabled: true }))
    // Global native MCP server (kind 'mcp').
    const configDir = join(root, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'fs-mcp' } } }))

    const sessionContext: CapabilityContext = {
      workspaceId: 'ws_a',
      sessionId: 'sess-1',
      // A non-empty selection that names the source but NOT the MCP server.
      enabledSourceNames: ['gmail'],
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
    const inputs = await buildCapabilityResolutionInputsV2(sessionContext, deps())

    const mcpRecord = inputs.nativeInventory.records.find(r => r.kind === 'mcp' && r.logicalName === 'fs')
    const sourceRecord = inputs.nativeInventory.records.find(r => r.kind === 'source' && r.logicalName === 'gmail')
    expect(mcpRecord).toBeDefined()
    expect(sourceRecord).toBeDefined()

    // Mapping: the source key is present; the MCP key is NOT.
    expect(inputs.sessionSelection?.enabledSourceKeys).toContain(sourceRecord!.key)
    expect(inputs.sessionSelection?.enabledSourceKeys).not.toContain(mcpRecord!.key)

    // Resolver applies it: the MCP server stays available despite being absent
    // from the (non-empty) selection set — activation governs, not selection.
    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(sessionContext)
    try {
      const mcp = snapshot.entries.find(e => e.summary.key === mcpRecord!.key)!.summary
      const source = snapshot.entries.find(e => e.summary.key === sourceRecord!.key)!.summary
      expect(mcp.enabled).toBe(true)
      expect(mcp.unavailableReason).toBeUndefined()
      expect(source.enabled).toBe(true)
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  // PRODUCTION SHAPE of the empty-selection case. For a LIVE session,
  // `SessionManager.createCapabilityTurn` collapses undefined/[] to [] and
  // `buildCapabilityResolutionInputsV2` (with `context.sessionId` set) ALWAYS
  // emits `sessionSelection.enabledSourceKeys` as an ARRAY — empty when nothing
  // is selected — never `undefined`. An empty array is truthy in the resolver
  // (`new Set([])`, no length guard), so folder/API sources fall through the
  // `session-not-selected` gate while native MCP stays exempt/available. This
  // pins the REAL "не выбрал → не доступно" contract that the resolver-layer
  // `undefined`-branch test in `resolver.test.ts` does NOT exercise (production
  // never issues `undefined` for a running chat). Behavior is unchanged
  // (reviewer-approved option (a), 2026-07-19); this is a coverage add.
  it('empty selection on a live session gates folder/API sources off (session-not-selected) while native MCP stays available', async () => {
    // Workspace source (kind 'source', api transport).
    const sourceDir = join(workspaceRoot, 'sources', 'gmail')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({ type: 'api', name: 'Gmail', enabled: true }))
    // Global native MCP server (kind 'mcp').
    const configDir = join(root, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: { fs: { command: 'fs-mcp' } } }))

    const sessionContext: CapabilityContext = {
      workspaceId: 'ws_a',
      sessionId: 'sess-empty',
      // Live session with an EMPTY selection — nothing selected.
      enabledSourceNames: [],
      projectTrustState: 'none',
      projectTrustRevision: '',
    }
    const inputs = await buildCapabilityResolutionInputsV2(sessionContext, deps())

    const mcpRecord = inputs.nativeInventory.records.find(r => r.kind === 'mcp' && r.logicalName === 'fs')
    const sourceRecord = inputs.nativeInventory.records.find(r => r.kind === 'source' && r.logicalName === 'gmail')
    expect(mcpRecord).toBeDefined()
    expect(sourceRecord).toBeDefined()

    // A live session ALWAYS produces a sessionSelection object with an ARRAY
    // (never undefined); here the array is empty because nothing was selected.
    expect(inputs.sessionSelection).toBeDefined()
    expect(inputs.sessionSelection?.enabledSourceKeys).toEqual([])

    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(sessionContext)
    try {
      const source = snapshot.entries.find(e => e.summary.key === sourceRecord!.key)!.summary
      const mcp = snapshot.entries.find(e => e.summary.key === mcpRecord!.key)!.summary
      // Folder/API source: UNAVAILABLE — empty live selection = not selected.
      expect(source.enabled).toBe(false)
      expect(source.unavailableReason).toBe('session-not-selected')
      // Native MCP: still AVAILABLE — exempt from session selection.
      expect(mcp.enabled).toBe(true)
      expect(mcp.unavailableReason).toBeUndefined()
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })
})

describe('buildCapabilityResolutionInputsV2 managed policy narrowing', () => {
  /**
   * P2.314. This case used to be called "filters only Pi snapshots while
   * Claude, Codex, and provider-neutral browse snapshots remain identical", and
   * it pinned the hole rather than a decision: the managed MCP denylist and the
   * managed plugin allow/deny lists were skipped on every runtime but Pi, so an
   * administrator's restrictions did not apply to a claude-runtime or
   * codex-runtime session at all. `managed-mcp.md#how-a-server-is-evaluated` —
   * "A server that matches any denylist entry, by URL, command, or name, is
   * blocked. Nothing overrides a denylist match."
   *
   * The axis is now RUNTIME TURN vs BROWSE. All three runtimes narrow
   * identically; the provider-neutral browse resolve still LISTS what the policy
   * denies, so a catalog read does not reproduce
   * `managed-mcp.md#how-restrictions-appear-to-users`'s worst case ("The server
   * silently disappears from `/mcp` and `claude mcp list` with no warning")
   * with nothing left to explain it.
   *
   * P2.351 corrected what "unnarrowed browse" is allowed to mean. It used to
   * mean the record survived UNTOUCHED, and that was not a listing decision: the
   * browse resolve is what `WorkspaceMcpPoolRegistry` syncs the workspace pool
   * from at every non-ephemeral session start, so an untouched denied record was
   * SPAWNED on the host with its configured env. Browse now keeps the row and
   * marks it unrunnable — `sourceEnabled: false` for a native record, a
   * `capabilities[capabilityId] === false` entry for a plugin one — which
   * `views.ts:isRunnable` honours, so nothing denied reaches `toAgentRuntime`
   * and therefore nothing denied reaches the pool. `#how-a-server-is-evaluated`
   * is pre-load and unconditional: "Before loading a server … Nothing overrides
   * a denylist match."
   */
  it('narrows every runtime turn identically and leaves provider-neutral browse listed but unrunnable', async () => {
    const configDir = join(root, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      mcpServers: { nativeDenied: { command: 'native-mcp' } },
    }))
    for (const [slug, config] of Object.entries({
      sourceDenied: { type: 'mcp', enabled: true },
      connectorDenied: {
        type: 'mcp',
        enabled: true,
        connectorOrigin: {
          pluginKey: 'ZGVueQ.cGx1Z2lu',
          connectorId: 'connector-1',
          serverName: 'connectorDenied',
        },
      },
    })) {
      const sourceDir = join(workspaceRoot, 'sources', slug)
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(config))
    }
    const allowedPlugin = {
      ...installedEntry(),
      pluginKey: 'YWJj.ZGVm',
      pluginInstanceId: `plugin://internal/allowed@1.0.0#${BUNDLE_HASH}`,
      manifest: {
        ...installedEntry().manifest,
        capabilities: [
          { kind: 'mcp' as const, id: 'plugin-mcp', mcp: { serverName: 'pluginDenied', transport: 'stdio' as const, command: 'plugin-mcp' } },
          { kind: 'hook' as const, id: 'plugin-hook', hook: { id: 'plugin-hook', event: 'PreToolUse', type: 'command' as const, command: 'echo hook' } },
        ],
      },
    }
    const deniedPlugin = {
      ...installedEntry(),
      pluginKey: 'ZGVueQ.cGx1Z2lu',
      pluginInstanceId: `plugin://internal/denied@1.0.0#${BUNDLE_HASH}`,
      manifest: {
        ...installedEntry().manifest,
        capabilities: [{ kind: 'mcp' as const, id: 'denied-plugin-mcp', mcp: { serverName: 'deniedPlugin', transport: 'stdio' as const, command: 'denied-mcp' } }],
      },
    }
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowedPluginKeys: ['YWJj.ZGVm'],
      deniedPluginKeys: ['ZGVueQ.cGx1Z2lu'],
      deniedMcpServers: ['nativeDenied', 'sourceDenied', 'connectorDenied', 'pluginDenied', 'deniedPlugin'],
      allowPluginHooks: false,
    })
    const testDeps: CapabilityInputsV2Deps = {
      ...deps(),
      nativeSourcesEnv: {
        // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
        // cannot read the machine's real administrator roots. Why the field is
        // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
        adminSkillsDirs: [],
        configDir,
        homeAgentsSkillsDir: join(root, 'agents', 'skills'),
      },
      pluginStore: {
        readInstalledRegistry: async () => ({
          schemaVersion: 2,
          updatedAt: 1,
          active: {
            [allowedPlugin.pluginKey]: allowedPlugin.pluginInstanceId,
            [deniedPlugin.pluginKey]: deniedPlugin.pluginInstanceId,
          },
          plugins: [allowedPlugin, deniedPlugin],
        }),
        cachePathFor: () => join(root, 'cache'),
        acquireInstanceLease: () => () => {},
      } as unknown as PluginStoreV2,
      managedPiPolicy,
    }
    const capabilityContext: CapabilityContext = {
      workspaceId: 'ws_a',
      projectTrustState: 'none',
      projectTrustRevision: '',
    }

    const piContext = { ...capabilityContext, provider: 'pi' as const }
    const claudeContext = { ...capabilityContext, provider: 'anthropic' as const }
    const codexContext = { ...capabilityContext, provider: 'codex-runtime' as const }
    const piInputs = await buildCapabilityResolutionInputsV2(piContext, testDeps)
    const claudeInputs = await buildCapabilityResolutionInputsV2(claudeContext, testDeps)
    const codexInputs = await buildCapabilityResolutionInputsV2(codexContext, testDeps)
    const browseInputs = await buildCapabilityResolutionInputsV2(capabilityContext, testDeps)

    for (const [name, inputs] of [['pi', piInputs], ['anthropic', claudeInputs], ['codex-runtime', codexInputs]] as const) {
      const records = inputs.nativeInventory.records.map(record => record.logicalName)
      // ONE assertion per denied record, deliberately. This pair used to be a
      // single `not.toEqual(expect.arrayContaining(['nativeDenied',
      // 'sourceDenied']))`, which is satisfied by EITHER name being absent —
      // so it stayed green with half the managed-MCP gate deleted (measured,
      // P2.351). The two arms it guards are now one condition in
      // `storage-runtime.ts`, and these are the two assertions that would
      // notice if they ever split again.
      expect(records, `${name} still carries the denied mcp.json server`).not.toContain('nativeDenied')
      expect(records, `${name} still carries the denied MCP Source`).not.toContain('sourceDenied')
      expect(inputs.pluginCandidates.map(candidate => candidate.pluginKey), `${name} still carries the denied plugin`)
        .not.toContain(deniedPlugin.pluginKey)
      expect(inputs.resolveActivation({ pluginKey: deniedPlugin.pluginKey }), `${name} did not suppress the denied plugin`)
        .toEqual({ enabled: false, suppressed: true, capabilities: {} })
    }
    // The deliberate half, and the positive control for the loop above: the
    // browse resolve carries no provider, so it still SEES what the policy
    // denies. Without this the loop could pass on an inventory that was empty
    // for some unrelated reason.
    const browseRecords = new Map(browseInputs.nativeInventory.records.map(record => [record.logicalName, record]))
    expect([...browseRecords.keys()]).toContain('nativeDenied')
    expect([...browseRecords.keys()]).toContain('sourceDenied')
    // P2.351 — listed, and unrunnable. `sourceEnabled: false` is what the
    // resolver turns into `enabled: false`, which is what keeps the record out
    // of `toAgentRuntime` and therefore out of the MCP pool's desired set.
    expect(browseRecords.get('nativeDenied')?.sourceEnabled).toBe(false)
    expect(browseRecords.get('sourceDenied')?.sourceEnabled).toBe(false)
    expect(browseInputs.pluginCandidates.map(candidate => candidate.pluginKey)).toContain(deniedPlugin.pluginKey)
    expect(browseInputs.resolveActivation({ pluginKey: deniedPlugin.pluginKey })).toEqual({
      enabled: false,
      suppressed: false,
      // P2.351 — the plugin half. The denied plugin's own MCP capability is
      // marked off per capability rather than the candidate being dropped, so
      // the row survives for the catalog.
      capabilities: { 'denied-plugin-mcp': false },
    })
    // The load-bearing case for that half: a plugin the policy ALLOWS whose MCP
    // server the policy denies. The plugin stays active; only its server stops.
    expect(browseInputs.resolveActivation({ pluginKey: allowedPlugin.pluginKey }).capabilities)
      .toMatchObject({ 'plugin-mcp': false })
    // C5: connector-origin source records never serve for ANY provider — the
    // capability path replaced the Source projection outright.
    expect(claudeInputs.nativeInventory.records.map(record => record.logicalName)).not.toContain('connectorDenied')
    expect(piInputs.nativeInventory.records.map(record => record.logicalName)).not.toContain('connectorDenied')

    const inputsByProvider = new Map([
      ['pi', piInputs],
      ['anthropic', claudeInputs],
      ['codex-runtime', codexInputs],
      ['browse', browseInputs],
    ])
    const resolver = createCapabilityResolver({
      inputs: context => inputsByProvider.get(context.provider ?? 'browse')!,
    })
    const [piSnapshot, claudeSnapshot, codexSnapshot, browseSnapshot] = await Promise.all([
      resolver.resolve(piContext),
      resolver.resolve(claudeContext),
      resolver.resolve(codexContext),
      resolver.resolve(capabilityContext),
    ])
    try {
      // What the AGENT is handed, per runtime: the denied servers and the denied
      // plugin's hook reach none of the three.
      for (const [name, snapshot] of [['pi', piSnapshot], ['anthropic', claudeSnapshot], ['codex-runtime', codexSnapshot]] as const) {
        const runtime = toAgentRuntime(snapshot)
        expect(runtime.mcpServers, `${name} runtime still exposes an MCP server`).toHaveLength(0)
        expect(runtime.sources.filter(source => source.mcpWireName), `${name} runtime still exposes an MCP source`).toHaveLength(0)
        expect(runtime.hooks, `${name} runtime still exposes a plugin hook`).toHaveLength(0)
      }
      expect(piSnapshot.generation).not.toBe(claudeSnapshot.generation)

      // P2.351 — and what the POOL is handed on the provider-neutral browse
      // resolve, which is the snapshot `WorkspaceMcpPoolRegistry.runSync`
      // materializes its desired set from at every non-ephemeral session start.
      // `toAgentRuntime` is the only door to it, so an empty `mcpServers` here
      // is the whole no-spawn claim at the inputs level; the real spawn is
      // measured end-to-end in `mcp/__tests__/managed-denied-mcp-spawn.test.ts`.
      const browseRuntime = toAgentRuntime(browseSnapshot)
      expect(browseRuntime.mcpServers, 'browse still hands the pool a denied MCP server').toHaveLength(0)
      expect(
        browseRuntime.sources.filter(source => source.mcpWireName),
        'browse still hands the pool a denied MCP source',
      ).toHaveLength(0)
      // Positive control on the same snapshot: browse is NOT empty — it lists
      // exactly the rows the runtime turns dropped, which is the surviving half
      // of the carve-out.
      expect(browseSnapshot.entries.map(entry => entry.summary.logicalName))
        .toEqual(expect.arrayContaining(['nativeDenied', 'sourceDenied']))

      const snapshotShape = (snapshot: typeof piSnapshot) => JSON.stringify({
        entries: snapshot.entries,
        installedPlugins: snapshot.installedPlugins,
        diagnostics: snapshot.diagnostics,
      })
      expect(snapshotShape(claudeSnapshot)).toBe(snapshotShape(codexSnapshot))
      expect(snapshotShape(claudeSnapshot)).toBe(snapshotShape(piSnapshot))
      // …and browse is the one that differs, which is the whole axis. An
      // equality here would mean the narrowing stopped happening at all.
      expect(snapshotShape(browseSnapshot)).not.toBe(snapshotShape(claudeSnapshot))
    } finally {
      for (const snapshot of [piSnapshot, claudeSnapshot, codexSnapshot, browseSnapshot]) {
        resolver.releaseSnapshot(snapshot.leaseId)
      }
    }
  })
})

/**
 * `settings-reference.md#enabledplugins` at managed scope — the activation
 * tier: "A plugin set to `false` here is blocked from installation at every
 * scope and hidden from the marketplace". It is also the subject of the hook
 * carve-out in `settings-reference.md#what-runs-under-allowmanagedhooksonly`.
 */
describe('buildCapabilityResolutionInputsV2 managed plugin activation', () => {
  /** Two plugins with one hook each: one force-enabled, one merely allowlisted. */
  function activationDeps(managedPiPolicy: ReturnType<typeof parseManagedPiPolicyV1>, policyStore = new CapabilityPolicyStore({
    globalPath: join(root, 'config', 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
  })): CapabilityInputsV2Deps {
    const hookPlugin = (pluginKey: string, slug: string) => ({
      ...installedEntry(),
      pluginKey,
      pluginInstanceId: `plugin://internal/${slug}@1.0.0#${BUNDLE_HASH}`,
      manifest: {
        ...installedEntry().manifest,
        capabilities: [
          {
            kind: 'hook' as const,
            id: `${slug}-hook`,
            hook: { id: `${slug}-hook`, event: 'PreToolUse', type: 'command' as const, command: `echo ${slug}` },
          },
        ],
      },
    })
    const forced = hookPlugin('YWJj.ZGVm', 'forced')
    const allowlisted = hookPlugin('b3RoZXI.cGx1Z2lu', 'allowlisted')
    return {
      ...deps(policyStore),
      pluginStore: {
        readInstalledRegistry: async () => ({
          schemaVersion: 2,
          updatedAt: 1,
          active: {
            [forced.pluginKey]: forced.pluginInstanceId,
            [allowlisted.pluginKey]: allowlisted.pluginInstanceId,
          },
          plugins: [forced, allowlisted],
        }),
        cachePathFor: () => join(root, 'cache'),
        acquireInstanceLease: () => () => {},
      } as unknown as PluginStoreV2,
      managedPiPolicy,
    }
  }

  const piContext: CapabilityContext = {
    workspaceId: 'ws_a',
    provider: 'pi',
    projectTrustState: 'none',
    projectTrustRevision: '',
  }

  it('activates a force-enabled plugin the user never enabled, and a user disable cannot undo it', async () => {
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      enabledPlugins: { 'YWJj.ZGVm': true },
    })
    const policyStore = new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    })
    const testDeps = activationDeps(managedPiPolicy, policyStore)

    // No activation record exists for either plugin.
    const inputs = await buildCapabilityResolutionInputsV2(piContext, testDeps)
    expect(inputs.resolveActivation({ pluginKey: 'YWJj.ZGVm' }))
      .toEqual({ enabled: true, suppressed: false, capabilities: {} })
    expect(inputs.resolveActivation({ pluginKey: 'b3RoZXI.cGx1Z2lu' }))
      .toEqual({ enabled: false, suppressed: false, capabilities: {} })

    // `:798` — the user's own disable, at the scope the UI writes.
    policyStore.recordWorkspace('ws_a', { pluginKey: 'YWJj.ZGVm', enabled: false })
    const afterDisable = await buildCapabilityResolutionInputsV2(piContext, testDeps)
    expect(afterDisable.resolveActivation({ pluginKey: 'YWJj.ZGVm' }))
      .toEqual({ enabled: true, suppressed: false, capabilities: {} })
    // And the row menu says so rather than offering an action that does nothing.
    expect(afterDisable.resolvePluginScopeActivation?.({ pluginKey: 'YWJj.ZGVm' }))
      .toEqual({ global: 'unset', workspace: 'disabled', project: 'ineligible', managed: 'enabled' })
  })

  it('under allowManagedHooksOnly, only the force-enabled plugin s hooks survive', async () => {
    // `settings-reference.md#what-runs-under-allowmanagedhooksonly` — the
    // carve-out's subject is the force-enabled set: "**Force-enabled plugin
    // hooks run**: hooks from plugins your managed settings force-enable
    // through `enabledPlugins`." The
    // allowlisted-but-not-force-enabled plugin is the case that conflating the
    // two lists would wrongly admit (the defect `93f886f1` removed).
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowManagedHooksOnly: true,
      allowedPluginKeys: ['YWJj.ZGVm', 'b3RoZXI.cGx1Z2lu'],
      enabledPlugins: { 'YWJj.ZGVm': true },
    })
    const inputs = await buildCapabilityResolutionInputsV2(piContext, activationDeps(managedPiPolicy))

    const hookCandidates = inputs.pluginCandidates.filter(candidate => candidate.kind === 'hook')
    expect(hookCandidates.map(candidate => candidate.pluginKey)).toEqual(['YWJj.ZGVm'])
  })

  it('without the lock, an allowlisted plugin keeps its hooks', async () => {
    // The carve-out narrows nothing when the lock is not engaged: this is the
    // negative that proves the filter is keyed on the lock and not on the map.
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowedPluginKeys: ['YWJj.ZGVm', 'b3RoZXI.cGx1Z2lu'],
      enabledPlugins: { 'YWJj.ZGVm': true },
    })
    const inputs = await buildCapabilityResolutionInputsV2(piContext, activationDeps(managedPiPolicy))

    expect(inputs.pluginCandidates.filter(candidate => candidate.kind === 'hook')
      .map(candidate => candidate.pluginKey).sort())
      .toEqual(['YWJj.ZGVm', 'b3RoZXI.cGx1Z2lu'].sort())
  })

  it('a managed false entry blocks the plugin and hides it from every projection', async () => {
    // `:793` — "block installation at all scopes and hide the plugin from the
    // marketplace". The install-time half is not implemented (see the register);
    // this is the projection half, enforced by the same predicate every listing
    // filter reads.
    const managedPiPolicy = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      enabledPlugins: { 'b3RoZXI.cGx1Z2lu': false },
    })
    const policyStore = new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    })
    // The user enabled it themselves; the managed block still wins.
    policyStore.recordGlobal({ pluginKey: 'b3RoZXI.cGx1Z2lu', enabled: true })
    const inputs = await buildCapabilityResolutionInputsV2(piContext, activationDeps(managedPiPolicy, policyStore))

    expect(inputs.pluginCandidates.map(candidate => candidate.pluginKey)).not.toContain('b3RoZXI.cGx1Z2lu')
    expect(inputs.resolveActivation({ pluginKey: 'b3RoZXI.cGx1Z2lu' }))
      .toEqual({ enabled: false, suppressed: true, capabilities: {} })
  })
})

describe('buildCapabilityResolutionInputsV2 managed MCP identity (S5)', () => {
  // `managed-mcp.md:150` — a `serverName` entry "is not a security control …
  // To enforce which servers actually run, add `serverCommand` or `serverUrl`
  // entries." These assert the RUNTIME filter honours those two dimensions, not
  // just the parser.
  const piContext: CapabilityContext = {
    workspaceId: 'ws_a',
    provider: 'pi',
    projectTrustState: 'none',
    projectTrustRevision: '',
  }

  async function piMcpRecords(policy: unknown, servers: Record<string, unknown>) {
    const configDir = join(root, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: servers }))
    const inputs = await buildCapabilityResolutionInputsV2(piContext, {
      ...deps(),
      nativeSourcesEnv: {
        // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
        // cannot read the machine's real administrator roots. Why the field is
        // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
        adminSkillsDirs: [],
        configDir,
        homeAgentsSkillsDir: join(root, 'agents', 'skills'),
      },
      managedPiPolicy: parseManagedPiPolicyV1(policy),
      // Nothing has switched a built-in on, so the projected set is entirely
      // disabled — this suite is about the managed filter, not enablement.
      storedConfig: null,
    })
    return inputs.nativeInventory.records.filter(r => r.kind === 'mcp')
  }

  /**
   * The DISCOVERED `.mcp.json` servers. The built-in dp set (A7) rides the same
   * record list since option A and is subject to the same filter since P2.368,
   * so it is projected out here to keep these arms about the discovered half —
   * see the arm at the end of this describe for the built-in half.
   */
  async function piRecordNames(policy: unknown, servers: Record<string, unknown>): Promise<string[]> {
    return (await piMcpRecords(policy, servers))
      .filter(r => r.scope.kind !== 'builtin')
      .map(r => r.logicalName)
  }

  it('blocks a renamed .mcp.json server by its command, where a name deny is escaped', async () => {
    const servers = { 'totally-fine': { command: 'npx', args: ['-y', 'unapproved-package'] } }
    const base = { schemaVersion: 1, disabledPermissionModes: [] }

    // The escape a name-only denylist allows.
    expect(await piRecordNames({ ...base, deniedMcpServers: [{ serverName: 'unapproved' }] }, servers))
      .toEqual(['totally-fine'])
    // The documented `serverCommand` entry catches it.
    expect(await piRecordNames(
      { ...base, deniedMcpServers: [{ serverCommand: ['npx', '-y', 'unapproved-package'] }] },
      servers,
    )).toEqual([])
  })

  it('blocks a renamed remote .mcp.json server by its URL pattern', async () => {
    const servers = { github: { type: 'http', url: 'https://api.untrusted.example.com/mcp' } }
    const policy = {
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverUrl: 'https://*.untrusted.example.com/*' }],
    }
    expect(await piRecordNames(policy, servers)).toEqual([])
  })

  it('applies the type-dependent allowlist to a native stdio server', async () => {
    // `:171` — a stdio server needs a `serverCommand` entry, and "A serverName
    // match counts only when the allowlist contains no serverCommand entries".
    const servers = { fs: { command: 'fs-mcp' } }
    const base = { schemaVersion: 1, disabledPermissionModes: [] }

    expect(await piRecordNames({ ...base, allowedMcpServers: [{ serverName: 'fs' }] }, servers))
      .toEqual(['fs'])
    expect(await piRecordNames({
      ...base,
      allowedMcpServers: [{ serverName: 'fs' }, { serverCommand: ['other-mcp'] }],
    }, servers)).toEqual([])
    expect(await piRecordNames({ ...base, allowedMcpServers: [{ serverCommand: ['fs-mcp'] }] }, servers))
      .toEqual(['fs'])
  })

  it('P2.368 — the built-in dp set is inside the managed filter now, on both paths', async () => {
    // This arm used to assert the OPPOSITE, and the condition it named for
    // revisiting has been met. The two reasons it recorded were sound while the
    // fold was unfiltered — filtering the mirror alone would have hidden a row
    // while its server still started — and the owed work landed in the FOLD
    // (`mcp/runtime-pool-servers.ts:applyManagedMcpPolicy`), so the mirror now
    // follows it on the SAME identity.
    const denyAll = {
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowedMcpServers: [{ serverCommand: ['nothing-matches'] }],
    }
    // A Pi turn: the discovered server and every built-in are dropped outright,
    // exactly as the discovered sibling is.
    const runtimeTurn = await piMcpRecords(denyAll, { fs: { command: 'fs-mcp' } })
    expect(runtimeTurn.filter(r => r.scope.kind !== 'builtin')).toEqual([])
    expect(runtimeTurn.filter(r => r.scope.kind === 'builtin')).toEqual([])

    // Positive control on the same rig: with no lists, all 28 are back and carry
    // the identity the fold matches on.
    const unrestricted = await piMcpRecords(
      { schemaVersion: 1, disabledPermissionModes: [] },
      { fs: { command: 'fs-mcp' } },
    )
    expect(unrestricted.filter(r => r.scope.kind === 'builtin')).toHaveLength(28)
    expect(unrestricted.find(r => r.logicalName === 'dpJira')?.mcpServerIdentity)
      .toEqual({ transport: 'stdio', command: ['dp', 'ai', 'mcp', 'jira'] })

    // The BROWSE resolve keeps the row and disables it, so an administrator's
    // denial is visible rather than a silent disappearance
    // (`managed-mcp.md#how-restrictions-appear-to-users`).
    const configDir = join(root, 'config')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
    const browse = await buildCapabilityResolutionInputsV2({
      workspaceId: 'ws_a',
      projectTrustState: 'none',
      projectTrustRevision: '',
    }, {
      ...deps(),
      nativeSourcesEnv: {
        // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
        // cannot read the machine's real administrator roots. Why the field is
        // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
        adminSkillsDirs: [],
        configDir,
        homeAgentsSkillsDir: join(root, 'agents', 'skills'),
      },
      managedPiPolicy: parseManagedPiPolicyV1(denyAll),
      storedConfig: { builtinDpMcpServers: { enabled: { dpJira: true } } },
    })
    const jira = browse.nativeInventory.records.find(r => r.logicalName === 'dpJira')
    expect(jira, 'the denied built-in vanished from the provider-neutral catalog').toBeDefined()
    expect(jira!.sourceEnabled).toBe(false)
  })

  it('blocks a plugin MCP capability by the command its manifest declares', async () => {
    const entry: PluginInstalledEntryV2 = {
      ...installedEntry(),
      pluginKey: 'YWJj.ZGVm',
      manifest: {
        ...installedEntry().manifest,
        capabilities: [{
          kind: 'mcp' as const,
          id: 'wiki',
          mcp: { serverName: 'harmless', transport: 'stdio' as const, command: 'npx', args: ['-y', 'unapproved-package'] },
        }],
      },
    }
    const testDeps: CapabilityInputsV2Deps = {
      ...deps(),
      pluginStore: {
        readInstalledRegistry: async () => ({
          schemaVersion: 2,
          updatedAt: 1,
          active: { [entry.pluginKey]: entry.pluginInstanceId },
          plugins: [entry],
        }),
        cachePathFor: () => join(root, 'cache'),
        acquireInstanceLease: () => () => {},
      } as unknown as PluginStoreV2,
      managedPiPolicy: parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: [],
        deniedMcpServers: [{ serverCommand: ['npx', '-y', 'unapproved-package'] }],
      }),
    }
    const inputs = await buildCapabilityResolutionInputsV2(piContext, testDeps)
    expect(inputs.pluginCandidates.filter(candidate => candidate.kind === 'mcp')).toEqual([])
  })

  it('blocks an MCP Source by the URL in its config.json', async () => {
    const sourceDir = join(workspaceRoot, 'sources', 'friendly')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      type: 'mcp',
      enabled: true,
      mcp: { transport: 'http', url: 'https://api.untrusted.example.com/mcp' },
    }))
    const inputs = await buildCapabilityResolutionInputsV2(piContext, {
      ...deps(),
      managedPiPolicy: parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: [],
        deniedMcpServers: [{ serverUrl: 'https://*.untrusted.example.com/*' }],
      }),
    })
    expect(inputs.nativeInventory.records.map(record => record.logicalName)).not.toContain('friendly')
  })
})

/**
 * `strictPluginOnlyCustomization` (`settings-reference.md#strictpluginonlycustomization`)
 * — the ORIGIN lock, as opposed to the identity lists above.
 *
 * "Block skills, agents, hooks, and MCP servers from user and project sources,
 * so they can come only from plugins or managed settings."
 * Every native tier planted here is user-controlled: `<CONFIG_DIR>` is the user's
 * own config dir, the workspace root is theirs, and the project tier is admitted
 * by a per-USER trust prompt.
 */
describe('buildCapabilityResolutionInputsV2 strictPluginOnlyCustomization', () => {
  const BUNDLED_SLUG = 'nessy-bundled'
  let configDir: string
  let bundledRoot: string

  /** Every user/project-owned skill, agent and MCP tier this fork actually reads. */
  function plantNativeTiers(): void {
    configDir = join(root, 'config')
    bundledRoot = join(root, 'resources', 'skills')
    const skill = (dir: string, slug: string) => {
      mkdirSync(join(dir, slug), { recursive: true })
      writeFileSync(
        join(dir, slug, 'SKILL.md'),
        `---\nname: ${slug}\ndescription: A ${slug} skill\n---\n\nBody.\n`,
      )
    }
    // The bundled source root plus the copy a previous run seeded into the
    // managed skills root — what
    // `settings-reference.md#strictpluginonlycustomization-skills`'s "keeps
    // loading plugin skills, bundled skills, and skills in the managed policy
    // directory" has to survive on.
    skill(bundledRoot, BUNDLED_SLUG)
    skill(join(configDir, 'skills'), BUNDLED_SLUG)
    skill(join(configDir, 'skills'), 'global-skill')
    skill(join(workspaceRoot, 'skills'), 'workspace-skill')
    mkdirSync(join(configDir, 'agents'), { recursive: true })
    writeFileSync(join(configDir, 'agents', 'global-agent.md'), 'Global agent.\n')
    writeFileSync(join(workspaceRoot, 'workspace-agent.md'), 'Workspace agent.\n')
    mkdirSync(join(projectRoot, '.nessy-agent', 'agents'), { recursive: true })
    writeFileSync(join(projectRoot, '.nessy-agent', 'agents', 'project-agent.md'), 'Project agent.\n')
    writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
      mcpServers: { 'global-mcp': { command: 'global-mcp' } },
    }))
    const sourceDir = join(workspaceRoot, 'sources', 'workspace-mcp-source')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'config.json'), JSON.stringify({
      type: 'mcp',
      enabled: true,
      mcp: { transport: 'stdio', command: 'source-mcp' },
    }))
  }

  /** One plugin carrying a skill and an MCP server — the "still loads" side. */
  function pluginDeps(policy: unknown, provider?: CapabilityContext['provider']): {
    testDeps: CapabilityInputsV2Deps
    capabilityContext: CapabilityContext
  } {
    const entry: PluginInstalledEntryV2 = {
      ...installedEntry(),
      pluginKey: 'YWJj.ZGVm',
      manifest: {
        ...installedEntry().manifest,
        capabilities: [
          { kind: 'skill' as const, id: 'plugin-skill', skill: { slug: 'plugin-skill', path: 'skills/plugin-skill/SKILL.md' } },
          { kind: 'mcp' as const, id: 'plugin-mcp', mcp: { serverName: 'plugin-mcp', transport: 'stdio' as const, command: 'plugin-mcp' } },
        ],
      },
    }
    return {
      testDeps: {
        ...deps(),
        nativeSourcesEnv: {
          // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
          // cannot read the machine's real administrator roots. Why the field is
          // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
          adminSkillsDirs: [],
          configDir,
          homeAgentsSkillsDir: join(root, 'agents', 'skills'),
        },
        pluginStore: {
          readInstalledRegistry: async () => ({
            schemaVersion: 2,
            updatedAt: 1,
            active: { [entry.pluginKey]: entry.pluginInstanceId },
            plugins: [entry],
          }),
          cachePathFor: () => join(root, 'cache'),
          acquireInstanceLease: () => () => {},
        } as unknown as PluginStoreV2,
        ...(policy === undefined ? {} : { managedPiPolicy: parseManagedPiPolicyV1(policy) }),
        bundledSkillsEnv: {},
        storedConfig: {},
        bundledSkillRoots: { bundledRoot, skillsRoot: join(configDir, 'skills') },
      },
      capabilityContext: {
        ...context('trusted'),
        ...(provider ? { provider } : {}),
      },
    }
  }

  async function surfaces(policy: unknown, provider: CapabilityContext['provider'] = 'pi'): Promise<{
    skills: string[]
    agents: string[]
    mcp: string[]
    pluginKinds: string[]
  }> {
    const { testDeps, capabilityContext } = pluginDeps(policy, provider)
    const inputs = await buildCapabilityResolutionInputsV2(capabilityContext, testDeps)
    const native = inputs.nativeInventory.records.filter(record => record.scope.kind !== 'builtin')
    return {
      skills: native.filter(record => record.kind === 'skill').map(record => record.logicalName).sort(),
      agents: native.filter(record => record.kind === 'agent').map(record => record.logicalName).sort(),
      mcp: native
        .filter(record => record.kind === 'mcp' || record.sourceType === 'mcp')
        .map(record => record.logicalName)
        .sort(),
      pluginKinds: inputs.pluginCandidates.map(candidate => candidate.kind).sort(),
    }
  }

  beforeEach(() => {
    plantNativeTiers()
  })

  it('with the key absent, every user and project tier resolves — the control', async () => {
    // The positive control this repo requires before any absence claim below.
    expect(await surfaces(undefined)).toEqual({
      skills: ['global-skill', BUNDLED_SLUG, 'workspace-skill'],
      agents: ['global-agent', 'project-agent', 'workspace-agent'],
      mcp: ['global-mcp', 'workspace-mcp-source'],
      pluginKinds: ['mcp', 'skill'],
    })
  })

  it('locks exactly the named surfaces and leaves the others alone', async () => {
    // `settings-reference.md#strictpluginonlycustomization-skills` /
    // `#strictpluginonlycustomization-agents` — the two locked surfaces.
    // Bundled skills stay on the "keeps loading" side ("keeps loading plugin
    // skills, bundled skills, and skills in the managed policy directory"); so
    // do the plugin's skill and MCP server. `mcp` was
    // NOT named, so both MCP tiers are untouched: an array locks only what it
    // names, which is the whole reason the array form exists.
    expect(await surfaces({
      schemaVersion: 1,
      disabledPermissionModes: [],
      strictPluginOnlyCustomization: ['skills', 'agents'],
    })).toEqual({
      skills: [BUNDLED_SLUG],
      agents: [],
      mcp: ['global-mcp', 'workspace-mcp-source'],
      pluginKinds: ['mcp', 'skill'],
    })
  })

  it('`true` locks all four, and the lock does not lapse on a non-Pi turn', async () => {
    // `:1188` — a locked `mcp` blocks user and project server configuration while
    // "Plugin MCP servers" still load. And the origin lock sits BEFORE the
    // browse early return, which is what kept it honest while that gate still
    // read `provider === 'pi'` (P2.314): a lock that silently lapsed on a Claude
    // turn would be the "declared on one path, enforced on another" defect.
    const locked = { schemaVersion: 1, disabledPermissionModes: [], strictPluginOnlyCustomization: true }
    const expected = {
      skills: [BUNDLED_SLUG],
      agents: [],
      mcp: [],
      pluginKinds: ['mcp', 'skill'],
    }
    expect(await surfaces(locked, 'pi')).toEqual(expected)
    expect(await surfaces(locked, 'anthropic')).toEqual(expected)
  })
})
