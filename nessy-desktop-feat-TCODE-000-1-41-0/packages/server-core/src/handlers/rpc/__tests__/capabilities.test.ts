import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { RPC_CHANNELS, projectWouldContribute } from '@nessy-agent/shared/protocol'
import {
  createCapabilityResolver,
  type CapabilityResolutionInputs,
  type CapabilityResolver,
} from '@nessy-agent/shared/capabilities/resolver'
import type { NativeCapabilityInventory } from '@nessy-agent/shared/capabilities/types'
import { toAgentRuntime } from '@nessy-agent/shared/capabilities/views'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import type {
  PluginManagementApi,
  PluginManagementStatusResult,
} from '@nessy-agent/shared/plugins'
import { PluginManagementServiceV2 } from '@nessy-agent/shared/plugins/management-service-v2'
import { resolvePluginProjectionCandidates } from '@nessy-agent/shared/plugins/projection-candidates'
import { PluginStoreV2 } from '@nessy-agent/shared/plugins/store-v2'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import {
  createMcpToolsCache,
  createMcpToolsLister,
  registerCapabilitiesHandlers,
  CapabilityContextScopeError,
  CapabilityTrustNotFoundError,
  CapabilityTrustRequestError,
  HANDLED_CHANNELS,
  type CapabilitiesHandlerOptions,
} from '../capabilities'

/**
 * A refusal's IDENTITY, not the fact that something was refused. Every
 * `rejects.toThrow()` below used to accept ANY rejection, and the handlers have
 * several: an invalid request shape, an unknown capabilityKey, a
 * cross-workspace context. Removing the request-shape guard entirely left the
 * suite green, because the unknown key threw instead — so the assertions could
 * not see the very gate their names promised.
 */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    result => { throw new Error(`expected a refusal, resolved with ${JSON.stringify(result)}`) },
    (error: unknown) => error,
  )
}
import type { SafeCapabilityContextRef, SafeMcpToolsResult } from '@nessy-agent/shared/protocol'

function nativeInventory(): NativeCapabilityInventory {
  return {
    records: [
      {
        key: 'skill:workspace:ws-1:myskill',
        kind: 'skill',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        logicalName: 'myskill',
        sourcePath: '/abs/managed/skills/myskill',
        revision: 'r1',
        contentHash: 'h1',
        mutable: true,
      },
      {
        key: 'source:workspace:ws-1:mysource',
        kind: 'source',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        logicalName: 'mysource',
        sourcePath: '/abs/managed/sources/mysource',
        revision: 'r2',
        contentHash: 'h2',
        mutable: true,
      },
      {
        key: 'mcp:workspace:ws-1:mymcp',
        kind: 'mcp',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        logicalName: 'mymcp',
        sourcePath: '/abs/managed/mcp/mymcp.json',
        revision: 'r3',
        contentHash: 'h3',
        mutable: true,
      },
    ],
    blockedLayers: [],
  }
}

function inputs(): CapabilityResolutionInputs {
  return {
    nativeInventory: nativeInventory(),
    installedPlugins: [],
    activePluginInstances: {},
    pluginCandidates: [],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'not-required',
  }
}

function createHarness(
  options: CapabilitiesHandlerOptions = {},
  depsOverrides: Partial<Pick<
    HandlerDeps,
    'capabilityTrustStore' | 'pluginManagement' | 'pluginStore' | 'workspaceService'
  >> = {},
) {
  const handlers = new Map<string, HandlerFn>()
  const openPaths: string[] = []
  const revealedPaths: string[] = []
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      async openPath(p: string) { openPaths.push(p) },
      showItemInFolder(p: string) { revealedPaths.push(p) },
    },
    sessionManager: {},
    ...depsOverrides,
  } as unknown as HandlerDeps

  const resolver = options.resolver ?? createCapabilityResolver({ inputs: () => inputs() })
  const handleService = options.handleService ?? new ProjectHandleService({
    identityOptions: {
      realpathSync: path => path,
      statSync: () => ({ dev: 1n, ino: 1n }),
      processSalt: 'capabilities-rpc-test',
    },
  })
  registerCapabilitiesHandlers(server, deps, { ...options, resolver, handleService })
  return { handlers, openPaths, revealedPaths, resolver }
}

function ctx(): RequestContext {
  return { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 }
}

describe('registerCapabilitiesHandlers', () => {
  it('registers the safe capability channels', () => {
    const { handlers } = createHarness()
    expect(handlers.has(RPC_CHANNELS.capabilities.GET_CATALOG)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.GET_DETAIL)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.PREVIEW)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.SUMMARY)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.OPEN)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.REVEAL)).toBe(true)
    expect(handlers.has(RPC_CHANNELS.capabilities.SUBMIT_MANAGED_EDIT)).toBe(true)
    expect([...handlers.keys()]).not.toContain('capabilities:resolveIcon')
  })

  it('serves a path-free user catalog for a workspace-only context', async () => {
    const { handlers } = createHarness()
    const catalog = await handlers.get(RPC_CHANNELS.capabilities.GET_CATALOG)!(ctx(), { workspaceId: 'ws-1' }) as {
      generation: string
      capabilities: Array<{ key: string; logicalName: string }>
    }
    expect(catalog.generation).toBeTruthy()
    const names = catalog.capabilities.map(c => c.logicalName).sort()
    expect(names).toEqual(['mymcp', 'myskill', 'mysource'])
    // No absolute managed path may cross the safe boundary.
    expect(JSON.stringify(catalog)).not.toContain('/abs/')
    expect(JSON.stringify(catalog)).not.toContain('sourcePath')
  })

  it('composer catalog is a projection of the same generation', async () => {
    const { handlers } = createHarness()
    const user = await handlers.get(RPC_CHANNELS.capabilities.GET_CATALOG)!(ctx(), { workspaceId: 'ws-1' }) as { generation: string }
    const composer = await handlers.get(RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG)!(ctx(), { workspaceId: 'ws-1' }) as { generation: string; items: unknown[] }
    expect(composer.generation).toBe(user.generation)
    expect(composer.items.length).toBe(3)
  })

  it('releases the snapshot lease after every view call (registry returns to zero)', async () => {
    const { handlers, resolver } = createHarness()
    await handlers.get(RPC_CHANNELS.capabilities.GET_CATALOG)!(ctx(), { workspaceId: 'ws-1' })
    await handlers.get(RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG)!(ctx(), { workspaceId: 'ws-1' })
    await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(ctx(), { workspaceId: 'ws-1' }, 'source:workspace:ws-1:mysource')
    expect(resolver.leaseCount()).toBe(0)
  })

  it('releases the lease even when projection throws (unknown detail key)', async () => {
    const { handlers, resolver } = createHarness()
    await expect(
      handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(ctx(), { workspaceId: 'ws-1' }, 'no-such-key'),
    ).rejects.toMatchObject({ code: 'capability-not-found' })
    expect(resolver.leaseCount()).toBe(0)
  })

  it('builds a safe detail with managed-resource refs for a source', async () => {
    const { handlers } = createHarness()
    const detail = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
      ctx(),
      { workspaceId: 'ws-1' },
      'source:workspace:ws-1:mysource',
    ) as { summary: { key: string }; resources: Array<{ ref: { scope: string; file: string }; canPreview: boolean }> }
    expect(detail.summary.key).toBe('source:workspace:ws-1:mysource')
    const files = detail.resources.map(r => r.ref.file).sort()
    expect(files).toEqual(['config', 'guide'])
    const config = detail.resources.find(r => r.ref.file === 'config')!
    expect(config.canPreview).toBe(false) // source config is summary/edit-only
  })

  describe('U2 typed detail projections', () => {
    function inventoryWith(overrides: {
      skillAlwaysAllow?: string[]
      sourcePermissions?: Array<{ pattern: string; access: 'allowed' | 'blocked' }>
    }): NativeCapabilityInventory {
      const inv = nativeInventory()
      const skill = inv.records.find(r => r.kind === 'skill')!
      const source = inv.records.find(r => r.kind === 'source')!
      if (overrides.skillAlwaysAllow) skill.skillAlwaysAllow = overrides.skillAlwaysAllow
      if (overrides.sourcePermissions) source.sourcePermissions = overrides.sourcePermissions
      return inv
    }

    function harnessWith(inventory: NativeCapabilityInventory) {
      const resolver = createCapabilityResolver({
        inputs: () => ({ ...inputs(), nativeInventory: inventory }),
      })
      return createHarness({ resolver })
    }

    it('projects skill permissionModes only when alwaysAllow is present', async () => {
      const { handlers } = harnessWith(inventoryWith({ skillAlwaysAllow: ['Bash(git status)', 'mcp__gh__list'] }))
      const detail = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
        ctx(), { workspaceId: 'ws-1' }, 'skill:workspace:ws-1:myskill',
      ) as { permissionModes?: Array<{ mode: string; behavior: string }> }
      // F1.1052: the real mode ids, in the picker's order; the hidden dontAsk has no row.
      expect(detail.permissionModes).toEqual([
        { mode: 'auto', behavior: 'allowed' },
        { mode: 'default', behavior: 'allowed' },
        { mode: 'acceptEdits', behavior: 'allowed' },
        { mode: 'plan', behavior: 'blocked' },
        { mode: 'bypassPermissions', behavior: 'neutral' },
      ])
      // Path-free: the always-allowed tool names are NOT copied into the payload.
      expect(JSON.stringify(detail)).not.toContain('git status')
      expect(JSON.stringify(detail)).not.toContain('/abs/')
    })

    it('omits skill permissionModes when the skill declares no alwaysAllow', async () => {
      const { handlers } = createHarness()
      const detail = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
        ctx(), { workspaceId: 'ws-1' }, 'skill:workspace:ws-1:myskill',
      ) as { permissionModes?: unknown }
      expect(detail.permissionModes).toBeUndefined()
    })

    it('projects source permissions pattern/access rows when the config carries them', async () => {
      const { handlers } = harnessWith(inventoryWith({
        sourcePermissions: [
          { pattern: 'GET /issues', access: 'allowed' },
          { pattern: 'mcp__linear__delete_.*', access: 'blocked' },
        ],
      }))
      const detail = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
        ctx(), { workspaceId: 'ws-1' }, 'source:workspace:ws-1:mysource',
      ) as { permissions?: Array<{ pattern: string; access: string }> }
      expect(detail.permissions).toEqual([
        { pattern: 'GET /issues', access: 'allowed' },
        { pattern: 'mcp__linear__delete_.*', access: 'blocked' },
      ])
      expect(JSON.stringify(detail)).not.toContain('/abs/')
      expect(JSON.stringify(detail)).not.toContain('sourcePath')
    })

    it('omits source permissions when the config carries none', async () => {
      const { handlers } = createHarness()
      const detail = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
        ctx(), { workspaceId: 'ws-1' }, 'source:workspace:ws-1:mysource',
      ) as { permissions?: unknown }
      expect(detail.permissions).toBeUndefined()
    })

    it('never projects permissionModes for a source or permissions for a skill', async () => {
      const { handlers } = harnessWith(inventoryWith({
        skillAlwaysAllow: ['x'],
        sourcePermissions: [{ pattern: 'y', access: 'allowed' }],
      }))
      const skill = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
        ctx(), { workspaceId: 'ws-1' }, 'skill:workspace:ws-1:myskill',
      ) as { permissionModes?: unknown; permissions?: unknown }
      const source = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
        ctx(), { workspaceId: 'ws-1' }, 'source:workspace:ws-1:mysource',
      ) as { permissionModes?: unknown; permissions?: unknown }
      expect(skill.permissionModes).toBeDefined()
      expect(skill.permissions).toBeUndefined()
      expect(source.permissions).toBeDefined()
      expect(source.permissionModes).toBeUndefined()
    })
  })

  it('builds a useful path- and secret-free detail for a plugin MCP', async () => {
    const instanceId = `plugin://m/p@1.0.0#${'b'.repeat(64)}`
    const resolver = createCapabilityResolver({
      inputs: () => ({
        ...inputs(),
        pluginCandidates: [{
          key: 'plugin:mcp:demo',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'mcp-demo',
          kind: 'mcp',
          logicalName: 'demo-mcp',
          displayName: 'Demo MCP',
          description: 'Safe plugin MCP description',
          selectedScope: { kind: 'project', workspaceId: 'ws-1' },
          trust: { required: false },
          runtimeDefinition: {
            id: 'mcp-demo',
            kind: 'mcp',
            displayName: 'Demo MCP',
            description: 'Safe plugin MCP description',
            mcp: {
              serverName: 'demo-mcp',
              transport: 'stdio',
              command: '/private/bin/secret-command',
              env: { TOKEN: 'secret-value' },
            },
          },
        }],
      }),
    })
    const { handlers } = createHarness({ resolver })
    const detail = await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
      ctx(),
      { workspaceId: 'ws-1' },
      'plugin:mcp:demo',
    ) as {
      summary: { displayName?: string; description?: string }
      safeFields: Array<{ label: string; value: string }>
    }

    expect(detail.summary).toMatchObject({
      displayName: 'Demo MCP',
      description: 'Safe plugin MCP description',
    })
    expect(detail.safeFields).toEqual([
      { label: 'origin', value: 'plugin' },
      { label: 'transport', value: 'stdio' },
      { label: 'plugin', value: 'pk-1' },
      { label: 'capability', value: 'mcp-demo' },
    ])
    expect(JSON.stringify(detail)).not.toMatch(/secret-command|secret-value|TOKEN|plugin:\/\/|bundleHash|sourcePath/)
  })

  it('REVEAL resolves native Source, Skill and MCP paths by exact capability key', async () => {
    const { handlers, openPaths, revealedPaths, resolver } = createHarness()

    await handlers.get(RPC_CHANNELS.capabilities.REVEAL)!(
      ctx(),
      { workspaceId: 'ws-1' },
      'source:workspace:ws-1:mysource',
    )
    await handlers.get(RPC_CHANNELS.capabilities.REVEAL)!(
      ctx(),
      { workspaceId: 'ws-1' },
      'skill:workspace:ws-1:myskill',
    )
    await handlers.get(RPC_CHANNELS.capabilities.REVEAL)!(
      ctx(),
      { workspaceId: 'ws-1' },
      'mcp:workspace:ws-1:mymcp',
    )

    expect(revealedPaths).toEqual([
      '/abs/managed/sources/mysource',
      '/abs/managed/skills/myskill',
      '/abs/managed/mcp/mymcp.json',
    ])
    expect(openPaths).toEqual([])
    expect(resolver.leaseCount()).toBe(0)
  })

  it('REVEAL resolves plugin Skill content inside its bundle and plugin MCP to the bundle root', async () => {
    const instanceId = `plugin://m/p@1.0.0#${'b'.repeat(64)}`
    const resolver = createCapabilityResolver({
      inputs: () => ({
        ...inputs(),
        pluginCandidates: [
          {
            key: 'plugin:skill:demo',
            pluginKey: 'pk-1',
            pluginInstanceId: instanceId,
            capabilityId: 'skill-demo',
            kind: 'skill',
            logicalName: 'demo',
            selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
            resource: {
              pluginInstanceId: instanceId,
              relativePath: 'skills/demo/SKILL.md',
              contentHash: 'c'.repeat(64),
            },
            trust: { required: false },
          },
          {
            key: 'plugin:mcp:demo',
            pluginKey: 'pk-1',
            pluginInstanceId: instanceId,
            capabilityId: 'mcp-demo',
            kind: 'mcp',
            logicalName: 'demo-mcp',
            selectedScope: { kind: 'project', workspaceId: 'ws-1' },
            trust: { required: false },
            runtimeDefinition: {
              id: 'mcp-demo',
              kind: 'mcp',
              mcp: { serverName: 'demo-mcp', transport: 'stdio', command: 'node' },
            },
          },
        ],
        pluginRuntimeContextFor: () => ({
          rootPath: '/private/plugin-cache/demo',
          dataPath: '/private/plugin-data/demo',
          profile: 'generic-plugin-env-v1' as const,
        }),
      }),
    })
    const { handlers, openPaths, revealedPaths } = createHarness({ resolver })

    await handlers.get(RPC_CHANNELS.capabilities.REVEAL)!(ctx(), { workspaceId: 'ws-1' }, 'plugin:skill:demo')
    await handlers.get(RPC_CHANNELS.capabilities.REVEAL)!(ctx(), { workspaceId: 'ws-1' }, 'plugin:mcp:demo')

    expect(revealedPaths).toEqual([
      '/private/plugin-cache/demo/skills/demo/SKILL.md',
      '/private/plugin-cache/demo',
    ])
    expect(openPaths).toEqual([])
    expect(resolver.leaseCount()).toBe(0)
  })

  it('PREVIEW reads an exact plugin Skill from the pinned snapshot resource', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-skill-'))
    try {
      mkdirSync(join(bundleRoot, 'skills', 'demo'), { recursive: true })
      writeFileSync(join(bundleRoot, 'skills', 'demo', 'SKILL.md'), '# Demo\nPinned plugin instructions')
      const bundleHash = await computeNormalizedBundleHash(bundleRoot)
      const instanceId = `plugin://m/p@1.0.0#${bundleHash}`
      const resolver = createCapabilityResolver({
        inputs: () => ({
          ...inputs(),
          installedPlugins: [{
            pluginInstanceId: instanceId,
            pluginKey: 'pk-1',
            marketplaceId: 'm',
            pluginId: 'p',
            version: '1.0.0',
            bundleHash,
            cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash },
            manifest: {
              schemaVersion: 1,
              kind: 'plugin',
              id: 'p',
              name: 'Plugin P',
              version: '1.0.0',
              capabilities: [],
            },
            origin: { source: 'marketplace', resolvedAt: 0 },
            installedAt: 1,
            diagnostics: [],
          }],
          activePluginInstances: { 'pk-1': instanceId },
          pluginCandidates: [{
            key: 'plugin:skill:demo',
            pluginKey: 'pk-1',
            pluginInstanceId: instanceId,
            capabilityId: 'skill-demo',
            kind: 'skill',
            logicalName: 'demo',
            selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
            resource: {
              pluginInstanceId: instanceId,
              relativePath: 'skills/demo/SKILL.md',
              contentHash: 'e'.repeat(64),
            },
            trust: { required: false },
          }],
          pluginRuntimeContextFor: () => ({
            rootPath: bundleRoot,
            dataPath: join(bundleRoot, 'data'),
            profile: 'generic-plugin-env-v1' as const,
          }),
        }),
      })
      const { handlers } = createHarness({ resolver })
      const preview = await handlers.get(RPC_CHANNELS.capabilities.PREVIEW)!(
        ctx(),
        { workspaceId: 'ws-1' },
        { scope: 'skill', tier: 'plugin', pluginInstanceId: instanceId, capabilityId: 'skill-demo', file: 'instructions' },
      ) as { content: string; provenance?: string }

      expect(preview).toMatchObject({
        content: '# Demo\nPinned plugin instructions',
        provenance: 'Installed plugin',
      })
      await expect(handlers.get(RPC_CHANNELS.capabilities.PREVIEW)!(
        ctx(),
        { workspaceId: 'ws-1' },
        { scope: 'skill', tier: 'plugin', pluginInstanceId: instanceId, capabilityId: 'other', file: 'instructions' },
      )).rejects.toMatchObject({ code: 'unsupported-ref' })
      writeFileSync(join(bundleRoot, 'skills', 'demo', 'SKILL.md'), '# Changed')
      await expect(handlers.get(RPC_CHANNELS.capabilities.PREVIEW)!(
        ctx(),
        { workspaceId: 'ws-1' },
        { scope: 'skill', tier: 'plugin', pluginInstanceId: instanceId, capabilityId: 'skill-demo', file: 'instructions' },
      )).rejects.toMatchObject({ code: 'stale' })
      expect(resolver.leaseCount()).toBe(0)
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
    }
  })

  it('REVEAL rejects an unknown exact key and releases its snapshot lease', async () => {
    const { handlers, revealedPaths, resolver } = createHarness()

    await expect(
      handlers.get(RPC_CHANNELS.capabilities.REVEAL)!(ctx(), { workspaceId: 'ws-1' }, 'mcp:workspace:ws-1:missing'),
    ).rejects.toMatchObject({ code: 'capability-not-found' })
    expect(revealedPaths).toEqual([])
    expect(resolver.leaseCount()).toBe(0)
  })

  it('rejects an unsafe context ref carrying a raw project root and creates no lease', async () => {
    const { handlers, resolver } = createHarness()
    await expect(
      handlers.get(RPC_CHANNELS.capabilities.GET_CATALOG)!(ctx(), { workspaceId: 'ws-1', projectRoot: '/evil' }),
    ).rejects.toMatchObject({ name: 'CapabilityContextError', code: 'invalid-context-ref' })
    expect(resolver.leaseCount()).toBe(0)
  })

  describe('safe presentation origin (A9)', () => {
    const instanceId = `plugin://m/p@1.0.0#${'f'.repeat(64)}`

    function presentationResolverInputs(): CapabilityResolutionInputs {
      return {
        ...inputs(),
        installedPlugins: [{
          pluginInstanceId: instanceId,
          pluginKey: 'pk-1',
          marketplaceId: 'skills-market',
          pluginId: 'p',
          version: '1.0.0',
          bundleHash: 'f'.repeat(64),
          cacheRef: { marketplaceId: 'skills-market', pluginId: 'p', version: '1.0.0', bundleHash: 'f'.repeat(64) },
          manifest: {
            schemaVersion: 1,
            kind: 'plugin',
            id: 'p',
            name: 'Plugin P',
            version: '1.0.0',
            capabilities: [],
          },
          origin: {
            source: 'marketplace',
            marketplaceId: 'skills-market',
            adapterId: 'codex-plugin-json',
            resolvedAt: 0,
          },
          installedAt: 1,
          diagnostics: [],
        }],
        activePluginInstances: { 'pk-1': instanceId },
        pluginCandidates: [{
          key: 'plugin:skill:demo',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'skill-demo',
          kind: 'skill',
          logicalName: 'demo',
          displayName: 'Demo Skill',
          selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/demo/SKILL.md', contentHash: 'a'.repeat(64) },
          trust: { required: false },
        }],
      }
    }

    function pluginManagementStub(): PluginManagementApi {
      const status: PluginManagementStatusResult = {
        installed: [{
          pluginKey: 'pk-1',
          activeInstanceId: instanceId,
          marketplaceId: 'skills-market',
          pluginId: 'p',
          version: '1.0.0',
          name: 'Plugin P',
          installedAt: 1,
          capabilityKinds: ['skill'],
          diagnostics: [],
          presentation: { format: 'codex', acquisition: 'nessy-marketplace' },
        }],
        diagnostics: [],
      }
      return {
        status: async () => status,
        install: async () => { throw new Error('not implemented') },
        enable: async () => { throw new Error('not implemented') },
        disable: async () => { throw new Error('not implemented') },
        pruneDependencies: async () => { throw new Error('not implemented') },
        setCapabilityEnabled: async () => { throw new Error('not implemented') },
        configurationStatus: async () => ({ state: 'not-required', fields: [] }),
        configure: async () => ({ state: 'not-required', fields: [] }),
        clearConfiguration: async () => ({ state: 'not-required', fields: [] }),
        repair: async () => { throw new Error('not implemented') },
        update: async () => { throw new Error('not implemented') },
        uninstall: async () => { throw new Error('not implemented') },
        refresh: async () => status,
      }
    }

    it('GET_CATALOG joins presentation by pluginKey into the installed plugin and its capability', async () => {
      const resolver = createCapabilityResolver({ inputs: () => presentationResolverInputs() })
      const { handlers } = createHarness({ resolver }, { pluginManagement: pluginManagementStub() })

      const catalog = await handlers.get(RPC_CHANNELS.capabilities.GET_CATALOG)!(ctx(), { workspaceId: 'ws-1' }) as {
        installedPlugins: Array<{ pluginKey: string; presentation?: { format: string; acquisition: string } }>
        capabilities: Array<{ key: string; presentation?: { format: string; acquisition: string } }>
      }

      const installed = catalog.installedPlugins.find(p => p.pluginKey === 'pk-1')
      expect(installed?.presentation).toEqual({ format: 'codex', acquisition: 'nessy-marketplace' })
      const capability = catalog.capabilities.find(c => c.key === 'plugin:skill:demo')
      expect(capability?.presentation).toEqual({ format: 'codex', acquisition: 'nessy-marketplace' })
    })

    it('is absent from the agent runtime view and never enters resolver/trust/activation', async () => {
      const resolver = createCapabilityResolver({ inputs: () => presentationResolverInputs() })
      const { handlers } = createHarness({ resolver }, { pluginManagement: pluginManagementStub() })

      // The composer catalog is also a user-facing view, but presentation is
      // only wired through toUserCatalog (GET_CATALOG) per the plan; composer
      // callers never pass a presentation map, so nothing leaks there either.
      const composer = await handlers.get(RPC_CHANNELS.capabilities.GET_COMPOSER_CATALOG)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: Array<{ presentation?: unknown }> }
      expect(composer.items.every(item => item.presentation === undefined)).toBe(true)

      const snapshot = await resolver.resolve({
        workspaceId: 'ws-1',
        projectTrustState: 'none',
        projectTrustRevision: '',
      })
      try {
        // No lever in EffectiveCapabilitySnapshot/ResolvedCapability carries a
        // `presentation` field; toAgentRuntime has no presentation parameter
        // at all, so this asserts the runtime view is presentation-free by
        // construction, not merely by omission at one call site.
        const runtime = toAgentRuntime(snapshot)
        expect(JSON.stringify(runtime)).not.toMatch(/codex|nessy-marketplace|"format"|"acquisition"/)
        // Resolver generation is computed purely from resolution inputs
        // (native inventory + plugin/activation/trust state); it is
        // independent of the pluginManagement-sourced presentation map, so
        // fetching presentation for the same context never perturbs it.
        expect(JSON.stringify(snapshot.entries)).not.toMatch(/"presentation"/)
        expect(JSON.stringify(snapshot.installedPlugins)).not.toMatch(/"presentation"/)
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId)
      }
    })
  })

  describe('trust review RPCs', () => {
    const instanceId = `plugin://m/p@1.0.0#${'d'.repeat(64)}`
    const executableHash = 'e'.repeat(64)

    function trustResolverInputs(trustStore: CapabilityTrustStore): CapabilityResolutionInputs {
      return {
        ...inputs(),
        pluginCandidates: [{
          key: 'plugin:hook:demo',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'hook-demo',
          kind: 'hook',
          logicalName: 'demo-hook',
          displayName: 'Demo Hook',
          selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
          trust: { required: true, executableHash },
          runtimeDefinition: {
            id: 'hook-demo',
            kind: 'hook',
            hook: { id: 'hook-demo', event: 'PreToolUse', type: 'command', command: '/private/bin/secret' },
          },
        }],
        isEnvironmentVariableAvailable: () => true,
        resolveTrust: key => trustStore.resolve(key),
      }
    }

    function mcpTrustResolverInputs(
      trustStore: CapabilityTrustStore,
      mcpExecutableHash: string,
    ): CapabilityResolutionInputs {
      return {
        ...inputs(),
        pluginCandidates: [{
          key: 'plugin:mcp:docs',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'mcp-docs',
          kind: 'mcp',
          logicalName: 'docs',
          displayName: 'Docs MCP',
          selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
          trust: { required: true, executableHash: mcpExecutableHash },
          runtimeDefinition: {
            id: 'mcp-docs',
            kind: 'mcp',
            mcp: {
              serverName: 'docs',
              transport: 'http',
              url: 'https://docs.example.test/mcp',
              env: { DOCS_TOKEN: '${DOCS_TOKEN}' },
              environmentSources: { CODEX_HOME: 'CODEX_HOME', GITHUB_TOKEN: 'GH_TOKEN' },
              requiredEnvironmentNames: ['DOCS_TOKEN'],
              toolTimeoutMs: 900_000,
            },
          },
        }],
        isEnvironmentVariableAvailable: () => true,
        resolveTrust: key => trustStore.resolve(key),
      }
    }

    function agentTrustResolverInputs(trustStore: CapabilityTrustStore): CapabilityResolutionInputs {
      return {
        ...inputs(),
        pluginCandidates: [{
          key: 'plugin:agent:demo',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'agent-demo',
          kind: 'agent',
          logicalName: 'demo-agent',
          displayName: 'Demo Agent',
          selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
          resource: {
            pluginInstanceId: instanceId,
            relativePath: 'agents/demo.md',
            contentHash: 'a'.repeat(64),
          },
          trust: { required: true, executableHash },
          runtimeDefinition: {
            id: 'agent-demo',
            kind: 'agent',
            agent: { name: 'demo-agent', path: 'agents/demo.md', tools: ['read'] },
          },
        }],
        resolveTrust: key => trustStore.resolve(key),
      }
    }

    function workflowTrustResolverInputs(trustStore: CapabilityTrustStore): CapabilityResolutionInputs {
      return {
        ...inputs(),
        pluginCandidates: [{
          key: 'plugin:workflow:scan',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'workflow-scan',
          kind: 'workflow',
          logicalName: 'scan',
          displayName: 'Scan',
          selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
          resource: {
            pluginInstanceId: instanceId,
            relativePath: 'workflows/scan.js',
            contentHash: 'c'.repeat(64),
          },
          trust: { required: true, executableHash },
          runtimeDefinition: {
            id: 'workflow-scan',
            kind: 'workflow',
            workflow: { name: 'scan', path: 'workflows/scan.js' },
          },
        }],
        resolveTrust: key => trustStore.resolve(key),
      }
    }

    function executableSkillTrustResolverInputs(trustStore: CapabilityTrustStore): CapabilityResolutionInputs {
      return {
        ...inputs(),
        pluginCandidates: [{
          key: 'plugin:skill:demo',
          pluginKey: 'pk-1',
          pluginInstanceId: instanceId,
          capabilityId: 'skill-demo',
          kind: 'skill',
          logicalName: 'demo-skill',
          displayName: 'Demo Skill',
          selectedScope: { kind: 'workspace', workspaceId: 'ws-1' },
          resource: {
            pluginInstanceId: instanceId,
            relativePath: 'skills/demo/SKILL.md',
            contentHash: 'b'.repeat(64),
          },
          trust: { required: true, executableHash },
          runtimeDefinition: {
            id: 'skill-demo',
            kind: 'skill',
            skill: {
              slug: 'demo-skill',
              path: 'skills/demo/SKILL.md',
              entrypoint: 'skills/demo/run.sh',
            },
          },
        }],
        resolveTrust: key => trustStore.resolve(key),
      }
    }

    const projectKey = `p_${'a'.repeat(32)}` as const
    const projectHookKey = `hook::project::ws-1::${projectKey}::.nessy-agent/hooks.json`

    function nativeProjectTrustResolverInputs(
      trustStore: CapabilityTrustStore,
      contentHash = executableHash,
    ): CapabilityResolutionInputs {
      return {
        ...inputs(),
        nativeInventory: {
          records: [{
            key: projectHookKey,
            kind: 'hook',
            scope: { kind: 'project', workspaceId: 'ws-1', projectKey },
            logicalName: '.nessy-agent/hooks.json',
            sourcePath: '/project/.nessy-agent/hooks.json',
            revision: 'r-project-hook',
            contentHash,
            mutable: false,
          }],
          blockedLayers: [],
        },
        resolveTrust: key => trustStore.resolve(key),
      }
    }

    it('LIST_TRUST_REVIEWS excludes installed plugin capabilities', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => trustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const result = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(ctx(), { workspaceId: 'ws-1' }) as {
        items: Array<{
          capabilityKey: string
          capabilityName: string
          executableKind: string
          scope: unknown
          reasonCode: string
        }>
      }

      expect(result.items).toEqual([])
      expect(JSON.stringify(result)).not.toMatch(/secret|plugin:\/\/|deadbeef|e{64}/)
    })

    it('lists and grants only the exact native project hook without exposing its hash/path', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => nativeProjectTrustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const before = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(),
        { workspaceId: 'ws-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(before.items).toEqual([{
        capabilityKey: projectHookKey,
        capabilityName: '.nessy-agent/hooks.json',
        executableKind: 'native-project',
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey },
        reasonCode: 'review-required',
      }])
      expect(JSON.stringify(before)).not.toContain('/project/')
      expect(JSON.stringify(before)).not.toContain(executableHash)

      const result = await handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
        ctx(),
        { capabilityKey: projectHookKey, context: { workspaceId: 'ws-1' } },
      ) as { ok: boolean; capabilityKey: string }

      expect(result).toEqual({ ok: true, capabilityKey: projectHookKey })
      expect(trustStore.resolve({
        capabilityId: projectHookKey,
        executableHash,
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey },
      })).toBe('trusted')
    })

    it('keeps installed agents runnable and rejects obsolete plugin trust mutations', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => agentTrustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const before = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(before.items).toEqual([])
      expect(JSON.stringify(before)).not.toContain(executableHash)

      await expect(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(ctx(), {
        capabilityKey: 'plugin:agent:demo', context: { workspaceId: 'ws-1' },
      })).rejects.toThrow('capability-trust-not-required')
      expect(trustStore.resolve({
        pluginInstanceId: instanceId,
        capabilityId: 'agent-demo',
        executableHash,
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
      })).toBe('review-required')

      const snapshot = await resolver.resolve({
        workspaceId: 'ws-1',
        projectTrustState: 'none',
        projectTrustRevision: '',
      })
      try {
        const runtime = toAgentRuntime(snapshot)
        expect(runtime.agents.map(agent => agent.name)).toEqual(['demo-agent'])
        expect(JSON.stringify(runtime)).not.toContain(executableHash)
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId)
      }
    })

    it('keeps an installed executable skill runnable without a plugin trust record', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => executableSkillTrustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      await expect(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(ctx(), {
        capabilityKey: 'plugin:skill:demo', context: { workspaceId: 'ws-1' },
      })).rejects.toThrow('capability-trust-not-required')
      expect(trustStore.resolve({
        pluginInstanceId: instanceId,
        capabilityId: 'skill-demo',
        executableHash,
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
      })).toBe('review-required')

      const snapshot = await resolver.resolve({
        workspaceId: 'ws-1',
        projectTrustState: 'none',
        projectTrustRevision: '',
      })
      try {
        const runtime = toAgentRuntime(snapshot)
        expect(runtime.skills.map(skill => skill.logicalName)).toEqual(['myskill', 'demo-skill'])
        expect(JSON.stringify(runtime)).not.toContain(executableHash)
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId)
      }
    })

    it('lists and grants a plugin workflow, keyed to the exact host-derived hash', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => workflowTrustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const before = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(before.items).toEqual([{
        capabilityKey: 'plugin:workflow:scan',
        capabilityName: 'Scan',
        executableKind: 'plugin',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        reasonCode: 'review-required',
      }])
      // Path-free ingress AND egress: the review row never carries the hash the
      // server reconstructs, nor the bundle-relative path behind it.
      expect(JSON.stringify(before)).not.toContain(executableHash)
      expect(JSON.stringify(before)).not.toContain('workflows/scan.js')

      const result = await handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
        ctx(), { capabilityKey: 'plugin:workflow:scan', context: { workspaceId: 'ws-1' } },
      ) as { ok: boolean; capabilityKey: string }
      expect(result).toEqual({ ok: true, capabilityKey: 'plugin:workflow:scan' })

      // The grant is the exact (instance, capability, hash, scope) tuple the
      // resolver hashed — not the plugin, and not the capability at any hash.
      expect(trustStore.resolve({
        pluginInstanceId: instanceId,
        capabilityId: 'workflow-scan',
        executableHash,
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
      })).toBe('trusted')
      expect(trustStore.resolve({
        pluginInstanceId: instanceId,
        capabilityId: 'workflow-scan',
        executableHash: 'f'.repeat(64),
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
      })).toBe('review-required')

      const snapshot = await resolver.resolve({
        workspaceId: 'ws-1',
        projectTrustState: 'none',
        projectTrustRevision: '',
      })
      try {
        const entry = snapshot.entries.find(item => item.summary.key === 'plugin:workflow:scan')
        expect(entry?.summary.trustState).toBe('trusted')
        expect(entry?.summary.enabled).toBe(true)
        expect(entry?.summary.unavailableReason).toBeUndefined()
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId)
      }

      // And revoking it puts the workflow straight back behind the gate.
      await handlers.get(RPC_CHANNELS.capabilities.REVOKE_TRUST)!(
        ctx(), { capabilityKey: 'plugin:workflow:scan', context: { workspaceId: 'ws-1' } },
      )
      expect(trustStore.resolve({
        pluginInstanceId: instanceId,
        capabilityId: 'workflow-scan',
        executableHash,
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
      })).toBe('review-required')
    })

    it('never resolves a capability into review-required with no reachable grant', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => workflowTrustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const snapshot = await resolver.resolve({
        workspaceId: 'ws-1',
        projectTrustState: 'none',
        projectTrustRevision: '',
      })
      let gated: string[]
      try {
        gated = snapshot.entries
          .filter(entry => entry.summary.trustState === 'review-required')
          .map(entry => entry.summary.key)
      } finally {
        resolver.releaseSnapshot(snapshot.leaseId)
      }
      // Positive control: this rig DOES put something behind the gate, so an
      // empty `gated` would be a broken measurement rather than a clean bill.
      expect(gated).toEqual(['plugin:workflow:scan'])

      const reviews = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: Array<{ capabilityKey: string }> }
      expect(reviews.items.map(item => item.capabilityKey).sort()).toEqual([...gated].sort())
      for (const capabilityKey of gated) {
        await expect(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
          ctx(), { capabilityKey, context: { workspaceId: 'ws-1' } },
        )).resolves.toEqual({ ok: true, capabilityKey })
      }
    })

    it('revalidates the active capability after an uninstall wins the shared lifecycle lock', async () => {
      const root = mkdtempSync(join(tmpdir(), 'capability-uninstall-race-'))
      try {
        const store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') })
        const policyStore = new CapabilityPolicyStore({
          globalPath: join(root, 'capabilities.json'),
          workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
        })
        const trustStore = new CapabilityTrustStore({ path: join(root, 'trust.json') })
        let pluginIsActive = true
        let releaseUninstall!: () => void
        let markUninstallStarted!: () => void
        const uninstallStarted = new Promise<void>(resolve => { markUninstallStarted = resolve })
        const service = new PluginManagementServiceV2({
          store,
          policyStore,
          trustStore,
          baseTempDir: join(root, 'staging'),
          dataLifecycle: {
            onPluginUninstall: async () => {
              pluginIsActive = false
              markUninstallStarted()
              await new Promise<void>(resolve => { releaseUninstall = resolve })
            },
          },
        })
        const fixture = join(
          import.meta.dir,
          '..', '..', '..', '..', '..', 'shared', 'src', 'plugins', '__tests__',
          'fixtures', 'format-adapters', 'codex-core',
        )
        const install = await service.install({ kind: 'local-path', path: fixture })
        expect(install.ok).toBe(true)
        const pluginKey = install.installed!.pluginKey
        const pluginInstanceId = install.installed!.activeInstanceId
        const registry = await store.readInstalledRegistry()
        const installed = registry.plugins.find(entry => entry.pluginInstanceId === pluginInstanceId)!
        const pluginCandidates = resolvePluginProjectionCandidates(
          [installed],
          { kind: 'workspace', workspaceId: 'ws-1' },
        )
        const hookCandidate = pluginCandidates.find(candidate => candidate.kind === 'hook')!
        const hookHash = hookCandidate.trust?.executableHash
        expect(hookHash).toBeDefined()
        const resolver = createCapabilityResolver({
          inputs: () => pluginIsActive ? {
            ...inputs(),
            installedPlugins: [installed],
            activePluginInstances: { [pluginKey]: pluginInstanceId },
            pluginCandidates,
            resolveTrust: key => trustStore.resolve(key),
          } : inputs(),
        })
        const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

        const uninstall = service.uninstall(pluginKey)
        await uninstallStarted
        const grant = handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
          ctx(),
          { capabilityKey: hookCandidate.key, context: { workspaceId: 'ws-1' } },
        )
        releaseUninstall()
        await uninstall

        await expect(grant).rejects.toThrow('capability-not-found')
        expect(trustStore.resolve({
          pluginInstanceId,
          capabilityId: hookCandidate.capabilityId,
          executableHash: hookHash!,
          scope: { kind: 'workspace', workspaceId: 'ws-1' },
        })).toBe('review-required')
        expect((await store.readInstalledRegistry()).active[pluginKey]).toBeUndefined()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('keeps an installed plugin MCP out of trust reviews and rejects trust mutations', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const mcpExecutableHash = 'f'.repeat(64)
      const resolver = createCapabilityResolver({ inputs: () => mcpTrustResolverInputs(trustStore, mcpExecutableHash) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const before = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(before.items).toEqual([])
      expect(JSON.stringify(before)).not.toContain('${DOCS_TOKEN}')

      await expect(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(ctx(), {
        capabilityKey: 'plugin:mcp:docs', context: { workspaceId: 'ws-1' },
      })).rejects.toThrow('capability-trust-not-required')
      const exactKey = {
        pluginInstanceId: instanceId,
        capabilityId: 'mcp-docs',
        executableHash: mcpExecutableHash,
        scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
      }
      expect(trustStore.resolve(exactKey)).toBe('review-required')

      await expect(handlers.get(RPC_CHANNELS.capabilities.REVOKE_TRUST)!(ctx(), {
        capabilityKey: 'plugin:mcp:docs', context: { workspaceId: 'ws-1' },
      })).rejects.toThrow('capability-trust-not-required')
      expect(trustStore.resolve(exactKey)).toBe('review-required')
    })

    it('keeps connector Sources out of native project trust review', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({
        inputs: () => ({
          ...inputs(),
          nativeInventory: {
            records: [{
              key: 'source:workspace:ws-1:mail',
              kind: 'source',
              scope: { kind: 'workspace', workspaceId: 'ws-1' },
              logicalName: 'mail',
              sourcePath: '/workspace/sources/mail',
              revision: 'r-mail',
              contentHash: 'c'.repeat(64),
              mutable: true,
              sourceType: 'mcp',
              connectorOrigin: {
                pluginKey: 'm.p', connectorId: 'mail', serverName: 'mail-mcp', authTiming: 'ON_INSTALL',
              },
            }],
            blockedLayers: [],
          },
          resolveTrust: key => trustStore.resolve(key),
        }),
      })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      const reviews = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: unknown[] }
      expect(reviews.items).toEqual([])
      await expect(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(ctx(), {
        capabilityKey: 'source:workspace:ws-1:mail',
        context: { workspaceId: 'ws-1' },
      })).rejects.toThrow('capability-trust-not-required')
    })

    it('requires a fresh native project hook grant after its definition hash changes', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      let currentHash = '1'.repeat(64)
      const resolver = createCapabilityResolver({ inputs: () => nativeProjectTrustResolverInputs(trustStore, currentHash) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      await handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(ctx(), {
        capabilityKey: projectHookKey, context: { workspaceId: 'ws-1' },
      })
      expect(trustStore.resolve({
        capabilityId: projectHookKey,
        executableHash: currentHash,
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey },
      })).toBe('trusted')

      currentHash = '2'.repeat(64)
      const reviews = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(
        ctx(), { workspaceId: 'ws-1' },
      ) as { items: Array<{ capabilityKey: string }> }
      expect(reviews.items.map(item => item.capabilityKey)).toEqual([projectHookKey])
      expect(trustStore.resolve({
        capabilityId: projectHookKey,
        executableHash: currentHash,
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey },
      })).toBe('review-required')
    })

    it('REVOKE_TRUST revokes the native project hook and LIST_TRUST_REVIEWS reflects it again', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => nativeProjectTrustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      await handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
        ctx(),
        { capabilityKey: projectHookKey, context: { workspaceId: 'ws-1' } },
      )
      const before = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(ctx(), { workspaceId: 'ws-1' }) as { items: unknown[] }
      expect(before.items).toEqual([])

      const revoked = await handlers.get(RPC_CHANNELS.capabilities.REVOKE_TRUST)!(
        ctx(),
        { capabilityKey: projectHookKey, context: { workspaceId: 'ws-1' } },
      ) as { ok: boolean; capabilityKey: string }
      expect(revoked).toEqual({ ok: true, capabilityKey: projectHookKey })

      const after = await handlers.get(RPC_CHANNELS.capabilities.LIST_TRUST_REVIEWS)!(ctx(), { workspaceId: 'ws-1' }) as { items: Array<{ capabilityKey: string }> }
      expect(after.items.map(item => item.capabilityKey)).toEqual([projectHookKey])
    })

    it('rejects a grant/revoke request that tries to smuggle a hash or instance id', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => trustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      // The smuggled field must be what stops these, i.e. the request-shape
      // guard — NOT the unknown capabilityKey they also carry. Those two
      // refusals are different classes, and only the first one means the
      // client-supplied hash was refused.
      expect(await refusal(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
        ctx(),
        { capabilityKey: 'plugin:hook:demo', context: { workspaceId: 'ws-1' }, executableHash: 'attacker-hash' },
      ))).toBeInstanceOf(CapabilityTrustRequestError)
      expect(await refusal(handlers.get(RPC_CHANNELS.capabilities.REVOKE_TRUST)!(
        ctx(),
        { capabilityKey: 'plugin:hook:demo', context: { workspaceId: 'ws-1' }, pluginInstanceId: 'attacker-instance' },
      ))).toBeInstanceOf(CapabilityTrustRequestError)
    })

    it('rejects an unknown capabilityKey', async () => {
      const trustStore = new CapabilityTrustStore({ path: join(mkdtempSync(join(tmpdir(), 'trust-')), 'trust.json') })
      const resolver = createCapabilityResolver({ inputs: () => trustResolverInputs(trustStore) })
      const { handlers } = createHarness({ resolver }, { capabilityTrustStore: trustStore })

      // The mirror of the test above: a well-shaped request whose key is not in
      // the snapshot must fail on the LOOKUP, with the reason code that says so.
      const error = await refusal(handlers.get(RPC_CHANNELS.capabilities.GRANT_TRUST)!(
        ctx(),
        { capabilityKey: 'no-such-capability', context: { workspaceId: 'ws-1' } },
      ))
      expect(error).toBeInstanceOf(CapabilityTrustNotFoundError)
      expect((error as CapabilityTrustNotFoundError).code).toBe('capability-not-found')
    })
  })

  describe('U3 listMcpTools', () => {
    // Bespoke harness: registers the real handler wired to a SPY session-manager
    // accessor, with an injectable cache + clock, so we can assert routing,
    // fail-soft behavior, and the TTL cache without a live SessionManager.
    function mcpHarness(options: {
      listForCapability: (context: SafeCapabilityContextRef, key: string) => Promise<SafeMcpToolsResult>
      now?: () => number
    }) {
      const handlers = new Map<string, HandlerFn>()
      const server: RpcServer = {
        handle(channel, handler) { handlers.set(channel, handler) },
        push() {},
        async invokeClient() { return undefined },
        hasClientCapability() { return false },
        findClientsWithCapability() { return [] },
      }
      let clock = 0
      const deps = {
        platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
        sessionManager: {
          listMcpToolsForCapability: options.listForCapability,
          getWorkingDirectory: () => undefined,
        },
      } as unknown as HandlerDeps
      const resolver = createCapabilityResolver({ inputs: () => inputs() })
      const handleService = new ProjectHandleService({
        identityOptions: { realpathSync: p => p, statSync: () => ({ dev: 1n, ino: 1n }), processSalt: 'u3-mcp-test' },
      })
      registerCapabilitiesHandlers(server, deps, {
        resolver,
        handleService,
        mcpTools: { cache: createMcpToolsCache(), now: options.now ?? (() => clock) },
      })
      return {
        handlers,
        setClock: (v: number) => { clock = v },
      }
    }

    const mcpCtx = (): RequestContext => ({ clientId: 'c', workspaceId: 'ws-1', webContentsId: 1 })

    it('registers the LIST_MCP_TOOLS channel', () => {
      const { handlers } = mcpHarness({ listForCapability: async () => ({ status: 'refused', reason: 'no-session' }) })
      expect(handlers.has(RPC_CHANNELS.capabilities.LIST_MCP_TOOLS)).toBe(true)
    })

    it('routes an OK result through the session-manager accessor', async () => {
      const { handlers } = mcpHarness({
        listForCapability: async () => ({ status: 'ok', tools: [{ name: 'search', description: 'Search' }] }),
      })
      const result = await handlers.get(RPC_CHANNELS.capabilities.LIST_MCP_TOOLS)!(
        mcpCtx(), { workspaceId: 'ws-1', sessionId: 's-1' }, 'source:workspace:ws-1:mysource',
      )
      expect(result).toEqual({ status: 'ok', tools: [{ name: 'search', description: 'Search' }] })
    })

    it('fails soft to a typed error for a non-string capability key (never throws)', async () => {
      const { handlers } = mcpHarness({ listForCapability: async () => ({ status: 'ok', tools: [] }) })
      const result = await handlers.get(RPC_CHANNELS.capabilities.LIST_MCP_TOOLS)!(
        mcpCtx(), { workspaceId: 'ws-1', sessionId: 's-1' }, 123 as unknown as string,
      )
      expect(result).toEqual({ status: 'refused', reason: 'error' })
    })

    it('fails soft to a typed error on a workspace-scope mismatch (never throws)', async () => {
      const { handlers } = mcpHarness({ listForCapability: async () => ({ status: 'ok', tools: [] }) })
      const result = await handlers.get(RPC_CHANNELS.capabilities.LIST_MCP_TOOLS)!(
        mcpCtx(), { workspaceId: 'other-ws' }, 'source:workspace:ws-1:mysource',
      )
      expect(result).toEqual({ status: 'refused', reason: 'error' })
    })
  })
})

describe('createMcpToolsLister (U3 cache)', () => {
  const ctxRef: SafeCapabilityContextRef = { workspaceId: 'ws-1', sessionId: 's-1' }

  it('serves a repeat OK read from the bounded-TTL cache without re-calling the pool accessor', async () => {
    let calls = 0
    let now = 1000
    const lister = createMcpToolsLister({
      listForCapability: async () => { calls++; return { status: 'ok', tools: [{ name: 't' }] } },
      ttlMs: 5000,
      now: () => now,
    })
    const first = await lister(ctxRef, 'k')
    expect(first).toEqual({ status: 'ok', tools: [{ name: 't' }] })
    now = 2000 // within TTL
    const second = await lister(ctxRef, 'k')
    expect(second).toEqual(first)
    expect(calls).toBe(1) // cache hit skipped the second accessor call
  })

  it('re-reads after the TTL expires', async () => {
    let calls = 0
    let now = 0
    const lister = createMcpToolsLister({
      listForCapability: async () => { calls++; return { status: 'ok', tools: [] } },
      ttlMs: 5000,
      now: () => now,
    })
    await lister(ctxRef, 'k')
    now = 6000 // past TTL
    await lister(ctxRef, 'k')
    expect(calls).toBe(2)
  })

  it('does NOT cache refusals (a just-connected source is reflected on the next open)', async () => {
    let calls = 0
    const results: SafeMcpToolsResult[] = [
      { status: 'refused', reason: 'disconnected' },
      { status: 'ok', tools: [{ name: 't' }] },
    ]
    const lister = createMcpToolsLister({
      listForCapability: async () => results[calls++]!,
      now: () => 0,
    })
    expect(await lister(ctxRef, 'k')).toEqual({ status: 'refused', reason: 'disconnected' })
    expect(await lister(ctxRef, 'k')).toEqual({ status: 'ok', tools: [{ name: 't' }] })
    expect(calls).toBe(2)
  })

  it('maps a thrown accessor error to a typed error (never rethrows)', async () => {
    const lister = createMcpToolsLister({
      listForCapability: async () => { throw new Error('boom') },
      now: () => 0,
    })
    expect(await lister(ctxRef, 'k')).toEqual({ status: 'refused', reason: 'error' })
  })
})

describe('createMcpToolsCache (U3b finding 3 — bounded eviction)', () => {
  it('caps the entry count, evicting oldest-by-insertion first (TTL alone never evicts)', () => {
    const cache = createMcpToolsCache(2)
    cache.set('a', { result: { status: 'ok', tools: [] }, expiresAt: 1e12 })
    cache.set('b', { result: { status: 'ok', tools: [] }, expiresAt: 1e12 })
    cache.set('c', { result: { status: 'ok', tools: [] }, expiresAt: 1e12 }) // evicts 'a'
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })

  it('re-setting an existing key refreshes recency so it is not evicted next', () => {
    const cache = createMcpToolsCache(2)
    cache.set('a', { result: { status: 'ok', tools: [] }, expiresAt: 1e12 })
    cache.set('b', { result: { status: 'ok', tools: [] }, expiresAt: 1e12 })
    cache.set('a', { result: { status: 'ok', tools: [{ name: 'fresh' }] }, expiresAt: 1e12 }) // refresh 'a'
    cache.set('c', { result: { status: 'ok', tools: [] }, expiresAt: 1e12 }) // evicts 'b' (now oldest)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')?.result).toEqual({ status: 'ok', tools: [{ name: 'fresh' }] })
    expect(cache.get('c')).toBeDefined()
  })
})

describe('capabilities:detectProjectContributions', () => {
  function detectHandleService(): ProjectHandleService {
    return new ProjectHandleService({
      identityOptions: {
        realpathSync: path => path,
        statSync: () => ({ dev: 1n, ino: 1n }),
        processSalt: 'detect-rpc-test',
      },
    })
  }

  it('projects a bounded, PATH-FREE report resolved from a handle', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'detect-proj-'))
    try {
      writeFileSync(join(projectDir, 'AGENTS.md'), '# guide')
      writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
        mcpServers: { files: { command: 'files-server', env: { SECRET: 'shh' } } },
      }))
      mkdirSync(join(projectDir, '.claude', 'agents'), { recursive: true })
      writeFileSync(join(projectDir, '.claude', 'agents', 'reviewer.md'), 'x')

      const handleService = detectHandleService()
      const { handlers } = createHarness({ handleService })
      const issued = await handleService.validateProjectDirectory('ws-1', projectDir)

      const handler = handlers.get(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS)!
      const report = await handler(ctx(), { workspaceId: 'ws-1', projectHandleId: issued.id })

      const types = (report.items as Array<{ itemType: string }>).map(i => i.itemType)
      expect(types).toContain('AGENTS_MD')
      expect(types).toContain('MCP_SERVER_CONFIG')
      expect(types).toContain('SUBAGENTS')
      // Only slugs/basenames cross the boundary — never the project path, file
      // contents, or env values.
      const serialized = JSON.stringify(report)
      expect(serialized).not.toContain(projectDir)
      expect(serialized).not.toContain('files-server')
      expect(serialized).not.toContain('shh')
      expect(serialized).toContain('files')
      expect(serialized).toContain('reviewer')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  // F1.809 (owner decision A) — on Pi, trust also starts the enabled plugin
  // language servers, so an ordinary code folder with one enabled must be asked
  // about. The stub resolver hands the handler the snapshot the session path
  // would read; `unavailableReason` is what the resolver's runtime gate stamps
  // for a session on a runtime that runs no plugin language server.
  function lspSnapshotResolver(unavailableReason?: 'unsupported-runtime') {
    const released: string[] = []
    const resolver = {
      async resolve() {
        return {
          leaseId: 'lease-lsp',
          generation: 'gen-lsp',
          entries: [{
            summary: {
              key: 'plugin-lsp-typescript', kind: 'lsp', logicalName: 'typescript',
              enabled: unavailableReason === undefined, trustState: 'trusted',
              ...(unavailableReason ? { unavailableReason } : {}),
            },
            runtimeBinding: {
              kind: 'lsp',
              lsp: { key: 'plugin-lsp-typescript', lspId: 'typescript', command: 'typescript-language-server', languages: ['typescript'], executableHash: 'h' },
            },
          }],
        }
      },
      releaseSnapshot(leaseId: string) { released.push(leaseId) },
    } as unknown as CapabilityResolver
    return { resolver, released }
  }

  it('F1.809: names an enabled plugin language server for a folder that carries no project file', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'detect-lsp-'))
    try {
      writeFileSync(join(projectDir, 'index.ts'), 'export const x: number = 1')
      const handleService = detectHandleService()
      const { resolver, released } = lspSnapshotResolver()
      const { handlers } = createHarness({ handleService, resolver })
      const issued = await handleService.validateProjectDirectory('ws-1', projectDir)

      const report = await handlers.get(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS)!(
        ctx(), { workspaceId: 'ws-1', projectHandleId: issued.id },
      )

      expect(report).toEqual({ items: [{
        itemType: 'LANGUAGE_SERVERS', sourceLabel: 'enabled plugins, Pi sessions', count: 1, names: ['typescript'],
      }] })
      expect(projectWouldContribute(report)).toBe(true)
      expect(JSON.stringify(report)).not.toContain('typescript-language-server')
      expect(released).toEqual(['lease-lsp'])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('F1.809: a language server the runtime gate withholds adds nothing, and the folder stays unasked', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'detect-lsp-off-'))
    try {
      writeFileSync(join(projectDir, 'index.ts'), 'export const x: number = 1')
      const handleService = detectHandleService()
      const { resolver, released } = lspSnapshotResolver('unsupported-runtime')
      const { handlers } = createHarness({ handleService, resolver })
      const issued = await handleService.validateProjectDirectory('ws-1', projectDir)

      const report = await handlers.get(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS)!(
        ctx(), { workspaceId: 'ws-1', projectHandleId: issued.id },
      )

      expect(report).toEqual({ items: [] })
      expect(projectWouldContribute(report)).toBe(false)
      expect(released).toEqual(['lease-lsp'])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  /**
   * F1.1133 (origin DN-159) — the trust gate's detection runs on a project HANDLE ref, which names no
   * session, so it could not know the chat's runtime and named Pi's plugin language servers for a Claude
   * or codex chat too, raising the trust prompt over a folder whose trust starts nothing there. The gate
   * now passes the chat as `runtimeSessionId` (outside the safe ref, which keeps a session and a handle
   * mutually exclusive); the provider is read from the live session server-side, like `contextFor`'s.
   */
  it('F1.1133: a Claude chat\'s trust gate is not asked about Pi language servers; a Pi chat\'s still is', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'detect-lsp-runtime-'))
    try {
      writeFileSync(join(projectDir, 'index.ts'), 'export const x: number = 1')
      const handleService = detectHandleService()
      const { resolver } = lspSnapshotResolver()
      const providers: Record<string, string> = { 'chat-claude': 'anthropic', 'chat-pi': 'pi' }
      const { handlers } = createHarness({ handleService, resolver }, {
        sessionManager: { getSessionProvider: (sessionId: string) => providers[sessionId] },
      } as never)
      const issued = await handleService.validateProjectDirectory('ws-1', projectDir)
      const detect = handlers.get(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS)!
      const ref = { workspaceId: 'ws-1', projectHandleId: issued.id }

      expect(await detect(ctx(), ref, { runtimeSessionId: 'chat-claude' })).toEqual({ items: [] })
      const pi = await detect(ctx(), ref, { runtimeSessionId: 'chat-pi' }) as { items: Array<{ itemType: string }> }
      expect(pi.items.map(item => item.itemType)).toEqual(['LANGUAGE_SERVERS'])
      // BOUNDARY — no chat named (the dialog, the sources panel), or one this process does not know: unchanged.
      const none = await detect(ctx(), ref) as { items: Array<{ itemType: string }> }
      expect(none.items.map(item => item.itemType)).toEqual(['LANGUAGE_SERVERS'])
      const unknown = await detect(ctx(), ref, { runtimeSessionId: 'chat-gone' }) as { items: Array<{ itemType: string }> }
      expect(unknown.items.map(item => item.itemType)).toEqual(['LANGUAGE_SERVERS'])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('returns an empty report for a workspace-only context (no project)', async () => {
    const { handlers } = createHarness({ handleService: detectHandleService() })
    const handler = handlers.get(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS)!
    expect(await handler(ctx(), { workspaceId: 'ws-1' })).toEqual({ items: [] })
  })

  it('fail-soft: an unknown handle or workspace mismatch yields an empty report', async () => {
    const { handlers } = createHarness({ handleService: detectHandleService() })
    const handler = handlers.get(RPC_CHANNELS.capabilities.DETECT_PROJECT_CONTRIBUTIONS)!
    // Unknown handle id.
    expect(await handler(ctx(), { workspaceId: 'ws-1', projectHandleId: 'nope' })).toEqual({ items: [] })
    // Context workspace does not match the request context (scope violation).
    expect(await handler(ctx(), { workspaceId: 'ws-2' })).toEqual({ items: [] })
  })
})

// ---------------------------------------------------------------------------
// R59 — `capabilities:getHeadlessInit`
// ---------------------------------------------------------------------------

describe('capabilities:getHeadlessInit', () => {
  it('registers the channel and names it in HANDLED_CHANNELS', () => {
    const { handlers } = createHarness()
    expect(handlers.has(RPC_CHANNELS.capabilities.GET_HEADLESS_INIT)).toBe(true)
    expect(HANDLED_CHANNELS).toContain(RPC_CHANNELS.capabilities.GET_HEADLESS_INIT)
  })

  it('serves the frame fields and omits both error keys on a clean workspace', async () => {
    const { handlers, resolver } = createHarness()
    const view = await handlers.get(RPC_CHANNELS.capabilities.GET_HEADLESS_INIT)!(
      ctx(),
      { workspaceId: 'ws-1' },
    ) as Record<string, unknown>

    expect(view.plugins).toEqual([])
    // The fixture's native `mcp.json` server, with the only status that exists
    // before a runtime has started.
    expect(view.mcp_servers).toEqual([{ name: 'mymcp', status: 'pending' }])
    expect('plugin_errors' in view).toBe(false)
    expect('mcp_server_errors' in view).toBe(false)
    // Same lease discipline as every other view route.
    expect(resolver.leaseCount()).toBe(0)
  })

  it('refuses a context outside the caller workspace', async () => {
    const { handlers } = createHarness()
    // The caller-workspace gate, not "some error happened": every capability
    // read routes through `contextFor`, and only this class means the mismatch
    // was refused there rather than a workspace lookup failing further in.
    expect(await refusal(handlers.get(RPC_CHANNELS.capabilities.GET_HEADLESS_INIT)!(
      ctx(),
      { workspaceId: 'ws-other' },
    ))).toBeInstanceOf(CapabilityContextScopeError)
  })
})

describe('Q8-D4 — the runtime gate reads a provider that actually arrives', () => {
  // The seam this suite exists for. `31da9b13f` gated an agent row on
  // `CapabilityContext.provider`, and its own test proved that gate with a
  // HAND-BUILT context that carried a provider — while production passed one
  // built by `resolveCapabilityContext`, which set the field on no branch. The
  // gate was correct and permanently dead, and the live acceptance run
  // (`q8-regate-report.md`, Q8-D4) measured a Codex session's catalog as
  // byte-identical to Pi's.
  //
  // So this drives the REAL registered handler over the REAL ingress: the only
  // fixture is the session manager's provider accessor, exactly the value
  // `SessionManager.getSessionProvider` returns in production. A resolver-level
  // assertion cannot fail the way production failed; this one can.
  function agentInventory(): NativeCapabilityInventory {
    return {
      records: [
        {
          key: 'agent:workspace:ws-1:reviewer',
          kind: 'agent',
          scope: { kind: 'workspace', workspaceId: 'ws-1' },
          logicalName: 'reviewer',
          sourcePath: '/abs/managed/agents/reviewer.md',
          revision: 'r1',
          contentHash: 'a1',
          mutable: true,
        },
        {
          key: 'skill:workspace:ws-1:myskill',
          kind: 'skill',
          scope: { kind: 'workspace', workspaceId: 'ws-1' },
          logicalName: 'myskill',
          sourcePath: '/abs/managed/skills/myskill',
          revision: 'r2',
          contentHash: 'h1',
          mutable: true,
        },
      ],
      blockedLayers: [],
    }
  }

  function agentHarness(provider?: string) {
    const handlers = new Map<string, HandlerFn>()
    const server: RpcServer = {
      handle(channel, handler) { handlers.set(channel, handler) },
      push() {},
      async invokeClient() { return undefined },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }
    const providerCalls: Array<[string, string]> = []
    const deps = {
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      sessionManager: {
        getWorkingDirectory: () => undefined,
        getSessionProvider: (sessionId: string, workspaceId?: string) => {
          providerCalls.push([workspaceId ?? '', sessionId])
          return provider
        },
      },
    } as unknown as HandlerDeps
    const resolver = createCapabilityResolver({
      inputs: () => ({ ...inputs(), nativeInventory: agentInventory() }),
    })
    const handleService = new ProjectHandleService({
      identityOptions: { realpathSync: p => p, statSync: () => ({ dev: 1n, ino: 1n }), processSalt: 'q8d4-test' },
    })
    registerCapabilitiesHandlers(server, deps, { resolver, handleService })
    return { handlers, providerCalls, resolver }
  }

  async function agentRowsFor(provider: string | undefined, ref: SafeCapabilityContextRef) {
    const { handlers, providerCalls, resolver } = agentHarness(provider)
    const catalog = await handlers.get(RPC_CHANNELS.capabilities.GET_CATALOG)!(ctx(), ref) as {
      capabilities: Array<{ kind: string; state: string; unavailableReason?: string }>
    }
    expect(resolver.leaseCount()).toBe(0)
    return {
      agents: catalog.capabilities.filter(entry => entry.kind === 'agent'),
      skills: catalog.capabilities.filter(entry => entry.kind === 'skill'),
      providerCalls,
    }
  }

  const sessionRef: SafeCapabilityContextRef = { workspaceId: 'ws-1', sessionId: 's-1' }

  it("refuses the agent row on a session whose runtime dispatches none", async () => {
    // This row used to be `codex-runtime`. Codex is wired now — it writes our
    // definitions as `[agents.<role>]` blocks — so the only provider the gate
    // still refuses is the remote A2A backend, which runs no local definitions
    // at all. The gate is unchanged; its membership set grew by one.
    const { agents, skills, providerCalls } = await agentRowsFor('nestor-cloud-agent', sessionRef)
    expect(agents.length).toBe(1)
    expect(agents[0]!.state).toBe('unsupported-runtime')
    expect(agents[0]!.unavailableReason).toBe('unsupported-runtime')
    // Scoped to agents: the gate is about a dispatch mechanism, not about the
    // runtime being unusable. A skill on the same session stays active.
    expect(skills.every(row => row.state === 'active')).toBe(true)
    // The provider was asked for with the SERVER's composite identity, not with
    // anything the ref could have carried.
    expect(providerCalls).toEqual([['ws-1', 's-1']])
  })

  it('keeps the agent row active on the three runtimes that really dispatch', async () => {
    // Positive control. A fix that turns every row `unsupported-runtime` — the
    // easy way to make the negative test above pass — dies here. `codex-runtime`
    // is in this list rather than the one above since `7bf2c84d6`'s writer was
    // wired to the session.
    for (const provider of ['pi', 'anthropic', 'codex-runtime']) {
      const { agents } = await agentRowsFor(provider, sessionRef)
      expect(agents.length).toBe(1)
      expect(agents[0]!.state).toBe('active')
      expect(agents[0]!.unavailableReason).toBeUndefined()
    }
  })

  it('leaves a session-less workspace catalog provider-blind and active', async () => {
    // Second positive control, and the branch that must NOT acquire a provider:
    // a `{ workspaceId }` read happens before any session exists, so which
    // runtime a future session picks is unknown and a definite refusal would be
    // invented from an indefinite input.
    //
    // The harness provider is the one the gate REFUSES, deliberately: with a
    // provider the gate would admit anyway, `active` here would prove nothing
    // about the branch staying blind. (It was `codex-runtime` until codex
    // joined the admitted set, at which point this row went vacuous.)
    const { agents, providerCalls } = await agentRowsFor('nestor-cloud-agent', { workspaceId: 'ws-1' })
    expect(agents.length).toBe(1)
    expect(agents[0]!.state).toBe('active')
    expect(providerCalls).toEqual([])
  })

  it('resolves provider-blind when the session is not managed in this process', async () => {
    // `getSessionProvider` returns undefined for a session this process never
    // materialized; the catalog fetch must still answer, not fail.
    const { agents } = await agentRowsFor(undefined, sessionRef)
    expect(agents.length).toBe(1)
    expect(agents[0]!.state).toBe('active')
  })
})
