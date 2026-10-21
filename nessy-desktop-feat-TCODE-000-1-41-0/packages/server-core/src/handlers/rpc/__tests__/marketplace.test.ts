import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { isSafeMarketplacePluginInstallRequest, RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import {
  MarketplaceProposalRegistry,
  type MarketplaceCatalogItem,
} from '@nessy-agent/shared/marketplace'
import { PluginMutationCommittedError } from '@nessy-agent/shared/plugins'
import { pluginKeyFor } from '@nessy-agent/shared/workspaces'
import {
  CLIENT_PROPOSE_MCPB,
  type HandlerFn,
  type RequestContext,
  type RpcServer,
} from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerMarketplaceHandlers } from '../marketplace'
import {
  __resetTransferStateForTests,
  registerTransferHandlers,
} from '../transfer'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  __resetTransferStateForTests()
})

interface HarnessOptions {
  invokeClient?: (
    clientId: string,
    capability: string,
    handlers: Map<string, HandlerFn>,
  ) => Promise<unknown>
  capabilityCalls?: Array<{ clientId: string; capability: string }>
  includeTransfer?: boolean
  pluginRoot?: string
}

function createHarness(
  service: Record<string, (...args: any[]) => any>,
  proposalRegistry?: MarketplaceProposalRegistry,
  sessionManagerOverrides: Record<string, unknown> = {},
  marketplaceRegistrySource?: Record<string, (...args: any[]) => any>,
  options: HarnessOptions = {},
) {
  const handlers = new Map<string, HandlerFn>()
  const contexts: unknown[] = []
  const runtimeRefreshCalls: Array<unknown[]> = []
  const pushCalls: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, target, ...args) {
      pushCalls.push({ channel, target, args })
    },
    async invokeClient(clientId, capability) {
      options.capabilityCalls?.push({ clientId, capability })
      return await options.invokeClient?.(clientId, capability, handlers)
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    platform: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    sessionManager: {
      getWorkspaces() {
        return [{ id: 'ws-1', rootPath: '/work/ws' }]
      },
      async refreshPluginRuntime(...args: unknown[]) {
        runtimeRefreshCalls.push(args)
      },
      ...sessionManagerOverrides,
    },
    ...(marketplaceRegistrySource ? { marketplaceRegistrySource } : {}),
    ...(options.pluginRoot ? { pluginStore: { rootDirectory: options.pluginRoot } } : {}),
  } as unknown as HandlerDeps

  registerMarketplaceHandlers(server, deps, {
    createService(context) {
      contexts.push(context)
      return service as never
    },
    ...(proposalRegistry ? { proposalRegistry } : {}),
  })
  if (options.includeTransfer) registerTransferHandlers(server)

  return { handlers, contexts, runtimeRefreshCalls, pushCalls }
}

function ctx(clientId = 'client-1'): RequestContext {
  return { clientId, workspaceId: 'ws-1', webContentsId: 1 }
}

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-marketplace-mcpb-'))
  temporaryRoots.push(root)
  return root
}

function validMcpbArchive(): Uint8Array {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({
      manifest_version: '0.3',
      name: 'mcpb-test',
      version: '1.0.0',
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
      },
    })),
    'server/index.js': strToU8('process.stdout.write("ready")\n'),
  })
}

async function uploadMcpbThroughTransfer(
  handlers: Map<string, HandlerFn>,
  clientId: string,
  archive: Uint8Array,
): Promise<unknown> {
  const bytes = Buffer.from(archive)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const transferContext = ctx(clientId)
  const { transferId } = await handlers.get(RPC_CHANNELS.transfer.START)!(transferContext, {
    totalBytes: bytes.length,
    chunkCount: 1,
    channel: RPC_CHANNELS.marketplace.UPLOAD_MCPB,
    args: [null],
    largeArgIndex: 0,
    checksum,
  }) as { transferId: string }
  await handlers.get(RPC_CHANNELS.transfer.CHUNK)!(transferContext, {
    transferId,
    index: 0,
    data: bytes.toString('base64'),
  })
  return await handlers.get(RPC_CHANNELS.transfer.COMMIT)!(transferContext, { transferId })
}

function skillItem(overrides: Partial<MarketplaceCatalogItem> = {}): MarketplaceCatalogItem {
  return {
    id: 'code-review',
    kind: 'skill',
    listKind: 'skills',
    name: 'Code Review',
    description: 'Review code changes',
    version: '1.2.3',
    icon: { kind: 'symbol', name: 'skill' },
    sourceUrl: 'https://example.com/code-review?token=redacted',
    detailUrl: 'https://user:pass@example.com/private',
    repo: '/private/server/path',
    tenant: 'engineering',
    capabilities: ['skill'],
    installed: {
      pluginKey: pluginKeyFor('skills-market', 'code-review'),
      activeInstanceId: 'active-instance',
      pluginId: 'code-review',
      version: '1.2.3',
      activation: 'active',
    },
    install: {
      displayCommand: 'npx unsafe-install',
      source: {
        type: 'npm',
        packageName: '@example/code-review-skill',
        version: '1.2.3',
        raw: { type: 'npm', package: '@example/code-review-skill', version: '1.2.3' },
      },
      sourceConfidence: 'primary',
    },
    raw: { command: 'npx unsafe-install', workspaceRoot: '/work/ws' },
    ...overrides,
  }
}

describe('registerMarketplaceHandlers', () => {
  it('registers only safe catalog/proposal/install/registry routes', () => {
    const { handlers } = createHarness({})
    expect(Object.values(RPC_CHANNELS.marketplace)).toEqual([
      'marketplace:list',
      'marketplace:content',
      'marketplace:components',
      'marketplace:proposeInstall',
      'marketplace:proposeMcpb',
      'marketplace:uploadMcpb',
      'marketplace:install',
      'marketplace:addRegistry',
      'marketplace:upgradeRegistry',
      'marketplace:removeRegistry',
      'marketplace:listRegistries',
      'marketplace:setRegistryAutoUpdate',
      'marketplace:enableOffer',
      // P6.563 — the Plugins page's Refresh-runtime action. Safe by the same
      // rule as the rest: it names a workspace and nothing else, and the only
      // thing it can do is refresh live runtimes the server already owns.
      'marketplace:refreshRuntime',
    ])
    expect([...handlers.keys()]).toEqual(
      Object.values(RPC_CHANNELS.marketplace).filter(channel => channel !== RPC_CHANNELS.marketplace.UPLOAD_MCPB),
    )
  })

  /**
   * `plugins/org.md#recommend-plugins` + `settings-reference.md#pluginsuggestionmarketplaces`
   * — a suggestion pin crosses the boundary ONLY as a signal, and ONLY for a
   * marketplace the managed allowlist admits by name AND source: "A name takes
   * effect only when the marketplace is registered on the machine and its
   * registered source is also declared in the same managed settings." The
   * working directory that produced the match is server state and never crosses
   * back.
   */
  describe('suggestion pins on the browse list', () => {
    const relevantRow = () => ({
      id: 'registry-abc:toolkit',
      kind: 'plugin' as const,
      listKind: 'plugins' as const,
      name: 'toolkit',
      icon: { kind: 'symbol' as const, name: 'plugin' as const },
      capabilities: [],
      install: { sourceConfidence: 'primary' as const },
      raw: {},
      marketplaceRegistryId: 'registry-abc',
      // No git root exists under a temp-free fake path, so the ABSOLUTE-path
      // half of `plugin-relevance.md`'s cwd rule is what this exercises.
      relevance: { signals: { cwd: ['**/infra'] } },
    })

    const listWith = (
      allowedIds: string[],
      workingDirectory: string | null,
    ) => createHarness(
      {
        async list() {
          return { items: [relevantRow()], page: 1, pageSize: 100, total: 1, visible: 1 }
        },
      },
      undefined,
      { getWorkingDirectory: () => workingDirectory },
      {
        async listSuggestionAllowedRegistryIds() { return allowedIds },
      },
    )

    it('pins a matching row from an allowlisted marketplace, carrying the signal only', async () => {
      const { handlers } = listWith(['registry-abc'], '/work/ws/infra/modules')
      const result = await handlers.get(RPC_CHANNELS.marketplace.LIST)!(
        ctx(),
        { kind: 'plugins', sessionId: 'session-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(result.items[0]?.suggestion).toEqual({ signal: 'cwd' })
      // Stop Condition: the directory that produced the match never crosses.
      expect(JSON.stringify(result)).not.toContain('/work/ws')
    })

    it('surfaces NOTHING when the registry is not on the managed allowlist', async () => {
      const { handlers } = listWith([], '/work/ws/infra/modules')
      const result = await handlers.get(RPC_CHANNELS.marketplace.LIST)!(
        ctx(),
        { kind: 'plugins', sessionId: 'session-1' },
      ) as { items: Array<Record<string, unknown>> }
      // "surfaces NOTHING" is about the SUGGESTION, not about the row. The
      // fixture always returns exactly one item, so `[0]?.` going undefined
      // would mean the handler dropped a marketplace row on the floor — the
      // opposite verdict, and indistinguishable without this line.
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.suggestion).toBeUndefined()
    })

    /**
     * P6.519's second signal, at the seam that feeds it. The matcher is pure
     * and was already pinned in `shared`; what was unpinned — and, until this
     * hand-off landed, not wired at all — is that the LIST handler reads the
     * project's manifests and passes them to the matcher, so a row whose only
     * signal is `manifestDeps` can be suggested.
     */
    it('pins a row whose only signal is manifestDeps, reading the project manifest from disk', async () => {
      const projectRoot = temporaryDirectory()
      writeFileSync(
        join(projectRoot, 'package.json'),
        JSON.stringify({ dependencies: { '@nessy-agent/probe': '1.0.0' } }),
      )
      const { handlers } = createHarness(
        {
          async list() {
            return {
              items: [{
                ...relevantRow(),
                relevance: {
                  signals: {
                    manifestDeps: [{ file: 'package\\.json$', pattern: '@nessy-agent/probe' }],
                  },
                },
              }],
              page: 1,
              pageSize: 100,
              total: 1,
              visible: 1,
            }
          },
        },
        undefined,
        { getWorkingDirectory: () => projectRoot },
        { async listSuggestionAllowedRegistryIds() { return ['registry-abc'] } },
      )

      const result = await handlers.get(RPC_CHANNELS.marketplace.LIST)!(
        ctx(),
        { kind: 'plugins', sessionId: 'session-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(result.items[0]?.suggestion).toEqual({ signal: 'manifestDeps' })
      // Stop Condition, unchanged by the new signal: the manifest's contents
      // and the directory it was read from are server state.
      expect(JSON.stringify(result)).not.toContain(projectRoot)
    })

    it('surfaces nothing when the manifest is on disk but declares nothing the row asks for', async () => {
      const projectRoot = temporaryDirectory()
      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: {} }))
      const { handlers } = createHarness(
        {
          async list() {
            return {
              items: [{
                ...relevantRow(),
                relevance: {
                  signals: {
                    manifestDeps: [{ file: 'package\\.json$', pattern: '@nessy-agent/probe' }],
                  },
                },
              }],
              page: 1,
              pageSize: 100,
              total: 1,
              visible: 1,
            }
          },
        },
        undefined,
        { getWorkingDirectory: () => projectRoot },
        { async listSuggestionAllowedRegistryIds() { return ['registry-abc'] } },
      )

      const result = await handlers.get(RPC_CHANNELS.marketplace.LIST)!(
        ctx(),
        { kind: 'plugins', sessionId: 'session-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.suggestion).toBeUndefined()
    })

    it('surfaces nothing without a session, and nothing when the cwd does not match', async () => {
      const withoutSession = listWith(['registry-abc'], '/work/ws/infra')
      const noSession = await withoutSession.handlers.get(RPC_CHANNELS.marketplace.LIST)!(
        ctx(),
        { kind: 'plugins' },
      ) as { items: Array<Record<string, unknown>> }
      expect(noSession.items).toHaveLength(1)
      expect(noSession.items[0]?.suggestion).toBeUndefined()

      const elsewhere = listWith(['registry-abc'], '/work/ws/docs')
      const noMatch = await elsewhere.handlers.get(RPC_CHANNELS.marketplace.LIST)!(
        ctx(),
        { kind: 'plugins', sessionId: 'session-1' },
      ) as { items: Array<Record<string, unknown>> }
      expect(noMatch.items).toHaveLength(1)
      expect(noMatch.items[0]?.suggestion).toBeUndefined()
    })
  })

  it('returns an allowlisted catalog and rejects caller-owned context roots', async () => {
    const listCalls: unknown[] = []
    const { handlers, contexts } = createHarness({
      async list(request: unknown) {
        listCalls.push(request)
        return {
          items: [skillItem()],
          page: 1,
          pageSize: 100,
          total: 1,
          visible: 1,
          generatedAt: '2026-07-12T00:00:00Z',
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.LIST)!(ctx(), {
      kind: 'skills',
      page: 1,
      pageSize: 100,
      sort: 'name',
    })

    expect(contexts).toEqual([{}])
    expect(listCalls).toEqual([{ kind: 'skills', page: 1, pageSize: 100, sort: 'name' }])
    expect(result.items).toEqual([{
      marketplaceId: 'skills-market',
      id: 'code-review',
      kind: 'skill',
      listKind: 'skills',
      name: 'Code Review',
      description: 'Review code changes',
      version: '1.2.3',
      icon: { kind: 'symbol', name: 'skill' },
      sourceUrl: 'https://example.com/code-review',
      tenant: 'engineering',
      capabilities: ['skill'],
      install: { sourceConfidence: 'primary' },
      presentation: { acquisition: 'nessy-marketplace', format: 'unknown' },
    }])
    expect(JSON.stringify(result)).not.toMatch(/raw|command|enabledScopes|workspaceRoot|projectRoot|displayCommand|packageName/)

    await expect(handlers.get(RPC_CHANNELS.marketplace.LIST)!(ctx(), {
      kind: 'skills',
      workspaceRoot: '/attacker/path',
    })).rejects.toThrow('Invalid marketplace list request')
    expect(listCalls).toHaveLength(1)
  })

  it('projects registry rows with their id + a path-free label, and never leaks an absolute path', async () => {
    const { handlers } = createHarness({
      async list() {
        return {
          items: [
            skillItem(),
            // A bring-your-own registry row (R2): tagged, typed source, absent DTO descriptor.
            {
              id: 'reg-1:toolkit',
              kind: 'plugin',
              listKind: 'plugins',
              name: 'toolkit',
              icon: { kind: 'symbol', name: 'plugin' },
              capabilities: [],
              install: { sourceConfidence: 'primary' },
              raw: {},
              marketplaceRegistryId: 'reg-1',
              marketplaceRegistryLabel: 'My Registry',
              // C3: the ids this row used to have, from the catalog's `renames`.
              formerIds: ['reg-1:toolkit-legacy'],
              structuredInstallSource: { kind: 'local-path', path: '/Users/attacker/clone/toolkit' },
            } as MarketplaceCatalogItem,
            // A row whose registry label is an absolute path — must be stripped.
            {
              id: 'reg-2:evil',
              kind: 'plugin',
              listKind: 'plugins',
              name: 'evil',
              icon: { kind: 'symbol', name: 'plugin' },
              capabilities: [],
              install: { sourceConfidence: 'primary' },
              raw: {},
              marketplaceRegistryId: 'reg-2',
              marketplaceRegistryLabel: '/Users/attacker/registries/evil',
              structuredInstallSource: { kind: 'url', url: 'https://example.invalid/evil' },
            } as MarketplaceCatalogItem,
          ],
          page: 1,
          pageSize: 100,
          total: 3,
          visible: 3,
          registryLoadErrors: [{
            marketplaceRegistryId: 'reg-3',
            // An absolute-path display name — must be stripped by safeCatalogLabel.
            displayName: '/Users/attacker/registries/broken',
            diagnosticCodes: ['marketplace.registry.catalog_missing'],
          }],
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.LIST)!(ctx(), {
      kind: 'plugins',
      page: 1,
      pageSize: 100,
    })

    // Skills Market row keeps the built-in id; registry rows carry their own.
    expect(result.items.map((item: { marketplaceId: string }) => item.marketplaceId)).toEqual([
      'skills-market',
      'reg-1',
      'reg-2',
    ])
    const registryRow = result.items.find((item: { id: string }) => item.id === 'reg-1:toolkit')
    expect(registryRow.registryLabel).toBe('My Registry')
    // C3: former listing ids cross the allowlist projection, so the renderer can
    // still recognise a plugin installed before the marketplace renamed it.
    expect(registryRow.formerIds).toEqual(['reg-1:toolkit-legacy'])
    // The absolute-path label is stripped, not projected.
    const evilRow = result.items.find((item: { id: string }) => item.id === 'reg-2:evil')
    expect(evilRow.registryLabel).toBeUndefined()
    // A row with no rename history does not gain an empty array.
    expect(evilRow).not.toHaveProperty('formerIds')
    // Load error: id + diagnostic codes cross; the absolute displayName is stripped.
    expect(result.registryLoadErrors).toEqual([{
      marketplaceId: 'reg-3',
      diagnosticCodes: ['marketplace.registry.catalog_missing'],
    }])
    // Stop Condition: NO absolute path, installedRoot, catalogRoot, marketplacePath,
    // or typed install source reaches the Safe result.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/\/Users/)
    expect(serialized).not.toMatch(/installedRoot|catalogRoot|marketplacePath|structuredInstallSource|local-path/)
  })

  it('issues an opaque proposal and consumes it once for installation', async () => {
    const source = {
      kind: 'repository' as const,
      repositoryUrl: 'https://github.com/example/toolkit',
      ref: 'main',
    }
    const installCalls: unknown[] = []
    const { handlers, runtimeRefreshCalls, pushCalls } = createHarness({
      async proposeInstall() {
        return {
          status: 'installable',
          sourceUrl: 'https://github.com/example/toolkit/tree/main?token=secret',
          repositoryUrl: 'https://github.com/example/toolkit',
          detectedFormat: 'codex-plugin',
          diagnostics: [{ code: 'proposal.ready' }],
          source,
        }
      },
      async install(request: unknown) {
        installCalls.push(request)
        return {
          ok: true,
          installed: { pluginKey: pluginKeyFor('skills-market', 'toolkit') },
          diagnostics: [{ code: 'plugin.installed' }],
        }
      },
    })

    const proposal = await handlers.get(RPC_CHANNELS.marketplace.PROPOSE_INSTALL)!(ctx(), {
      sourceUrl: 'https://github.com/example/toolkit/tree/main',
    })
    expect(proposal.status).toBe('installable')
    expect(typeof proposal.proposalId).toBe('string')
    expect(proposal.detectedFormat).toBe('codex-plugin')
    expect(proposal.diagnosticCodes).toEqual(['proposal.ready'])
    expect(JSON.stringify(proposal)).not.toMatch(/repositoryUrl|sourceUrl|source|token/)

    const installRequest = {
      source: { kind: 'proposal', proposalId: proposal.proposalId },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    }
    expect(isSafeMarketplacePluginInstallRequest(installRequest)).toBe(true)
    const result = await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), installRequest)
    expect(installCalls).toEqual([{
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
      source,
    }])
    expect(result).toEqual({
      ok: true,
      pluginKey: pluginKeyFor('skills-market', 'toolkit'),
      diagnosticCodes: ['plugin.installed'],
    })
    expect(runtimeRefreshCalls).toEqual([['ws-1', undefined, 'marketplace install']])
    expect(pushCalls.map(call => call.channel)).toEqual([RPC_CHANNELS.capabilities.CHANGED])

    await expect(handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: { kind: 'proposal', proposalId: proposal.proposalId },
    })).rejects.toThrow()
  })

  it('invalidates a committed install before surfacing connector activation failure', async () => {
    const { handlers, runtimeRefreshCalls, pushCalls } = createHarness({
      async inspect() {
        return { item: skillItem(), diagnostics: [] }
      },
      async install() {
        throw new PluginMutationCommittedError(
          'install',
          pluginKeyFor('skills-market', 'code-review'),
          new Error('connector-activation-failed'),
        )
      },
    })

    await expect(handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'skills-market',
        listingId: 'code-review',
        listingKind: 'skills',
      },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })).rejects.toThrow('connector-activation-failed')
    expect(runtimeRefreshCalls).toEqual([['ws-1', undefined, 'marketplace install']])
    expect(pushCalls[0]?.args[0]).toMatchObject({ effect: 'revoke-active-snapshot' })
  })

  it('accepts a client-bound MCPB upload and installs its 0600 snapshot by opaque proposal', async () => {
    const root = temporaryDirectory()
    const pluginRoot = join(root, 'plugins')
    const capabilityCalls: Array<{ clientId: string; capability: string }> = []
    const installCalls: unknown[] = []
    const { handlers } = createHarness({
      async install(request: unknown) {
        installCalls.push(request)
        return { ok: true, installed: { pluginKey: 'local.mcpb' }, diagnostics: [] }
      },
    }, undefined, {}, undefined, {
      includeTransfer: true,
      capabilityCalls,
      invokeClient: async (clientId, _capability, registered) => {
        return await uploadMcpbThroughTransfer(registered, clientId, validMcpbArchive())
      },
      pluginRoot,
    })

    const proposal = await handlers.get(RPC_CHANNELS.marketplace.PROPOSE_MCPB)!(ctx(), undefined)
    expect(proposal).toMatchObject({ status: 'installable', detectedFormat: 'mcpb' })
    expect(JSON.stringify(proposal)).not.toContain(root)
    expect(capabilityCalls).toEqual([{ clientId: 'client-1', capability: CLIENT_PROPOSE_MCPB }])

    const snapshots = readdirSync(join(pluginRoot, 'imports'))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatch(/^[a-f0-9]{64}\.mcpb$/)
    expect(statSync(join(pluginRoot, 'imports', snapshots[0]!)).mode & 0o777).toBe(0o600)
    await expect(handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx('client-2'), {
      source: { kind: 'proposal', proposalId: proposal.proposalId },
    })).rejects.toThrow('wrong-client')
    await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: { kind: 'proposal', proposalId: proposal.proposalId },
    })
    expect(installCalls).toEqual([{
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
      source: { kind: 'local-path', path: join(pluginRoot, 'imports', snapshots[0]!) },
    }])
  })

  it('rejects invalid or changed MCPB archives without exposing their path', async () => {
    const root = temporaryDirectory()
    const pluginRoot = join(root, 'plugins')
    const invalidHarness = createHarness({}, undefined, {}, undefined, {
      includeTransfer: true,
      invokeClient: async (clientId, _capability, registered) => {
        return await uploadMcpbThroughTransfer(registered, clientId, Buffer.from('not a zip'))
      },
      pluginRoot,
    })
    const unsupported = await invalidHarness.handlers.get(RPC_CHANNELS.marketplace.PROPOSE_MCPB)!(ctx(), undefined)
    expect(unsupported).toEqual({
      status: 'unsupported',
      displaySource: 'MCPB extension',
      diagnosticCodes: ['marketplace.mcpb.invalid_archive'],
    })
    expect(JSON.stringify(unsupported)).not.toContain(root)

    const installCalls: unknown[] = []
    const validHarness = createHarness({
      async install(request: unknown) {
        installCalls.push(request)
        return { ok: true, diagnostics: [] }
      },
    }, undefined, {}, undefined, {
      includeTransfer: true,
      invokeClient: async (clientId, _capability, registered) => {
        return await uploadMcpbThroughTransfer(registered, clientId, validMcpbArchive())
      },
      pluginRoot,
    })
    const proposal = await validHarness.handlers.get(RPC_CHANNELS.marketplace.PROPOSE_MCPB)!(ctx(), undefined)
    const snapshot = readdirSync(join(pluginRoot, 'imports')).find(name => /^[a-f0-9]{64}\.mcpb$/.test(name))!
    writeFileSync(join(pluginRoot, 'imports', snapshot), 'changed')
    await expect(validHarness.handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: { kind: 'proposal', proposalId: proposal.proposalId },
    })).rejects.toThrow('content-changed')
    expect(installCalls).toEqual([])
  })

  it('installs listings by stable IDs and rejects legacy item/source DTOs', async () => {
    const inspectCalls: unknown[] = []
    const installCalls: unknown[] = []
    const { handlers } = createHarness({
      async inspect(request: unknown) {
        inspectCalls.push(request)
        return { item: skillItem(), diagnostics: [] }
      },
      async install(request: unknown) {
        installCalls.push(request)
        return {
          ok: true,
          installed: { pluginKey: pluginKeyFor('skills-market', 'code-review') },
          diagnostics: [],
        }
      },
    })

    await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'skills-market',
        listingId: 'code-review',
        listingKind: 'skills',
      },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })
    expect(inspectCalls).toEqual([{
      id: 'code-review',
      kind: 'skills',
    }])
    expect(installCalls).toHaveLength(1)

    await expect(handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      item: skillItem(),
      source: { kind: 'local-path', path: '/tmp/plugin' },
      workspaceRoot: '/attacker/path',
    })).rejects.toThrow('Invalid marketplace install request')
    expect(installCalls).toHaveLength(1)
  })

  it('does not invalidate or drain runtimes after a rejected install', async () => {
    const { handlers, runtimeRefreshCalls, pushCalls } = createHarness({
      async inspect() {
        return { item: skillItem(), diagnostics: [] }
      },
      async install() {
        return {
          ok: false,
          diagnostics: [{ code: 'plugin.install.npm_metadata_fetch_failed' }],
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'skills-market',
        listingId: 'code-review',
        listingKind: 'skills',
      },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })

    expect(result).toEqual({
      ok: false,
      diagnosticCodes: ['plugin.install.npm_metadata_fetch_failed'],
    })
    expect(runtimeRefreshCalls).toEqual([])
    expect(pushCalls).toEqual([])
  })

  it('carries the installed manifest\'s adapter warnings across the boundary on a SUCCESSFUL install', async () => {
    // P2.155. The persisted `compatibility.adapter.warnings` is the non-gating
    // record of what the importer dropped; before this it stopped at the service
    // and the renderer could not report a successful install's drops at all.
    // Codes only — the messages name bundle paths and stay server-side.
    const { handlers } = createHarness({
      async inspect() {
        return { item: skillItem(), diagnostics: [] }
      },
      async install() {
        return {
          ok: true,
          installed: {
            pluginKey: pluginKeyFor('skills-market', 'toolkit'),
            adapterWarnings: ['plugin.format.codex_listing_metadata_dropped'],
          },
          diagnostics: [],
          compatibility: { format: 'codex', state: 'supported', supportedKinds: [], deferred: [], blocked: [] },
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: { kind: 'listing', marketplaceId: 'skills-market', listingId: 'code-review', listingKind: 'skills' },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })

    expect(result).toEqual({
      ok: true,
      pluginKey: pluginKeyFor('skills-market', 'toolkit'),
      diagnosticCodes: [],
      state: 'supported',
      deferred: [],
      adapterWarnings: ['plugin.format.codex_listing_metadata_dropped'],
    })
    // The posture, asserted rather than assumed: nothing here gates the install.
    expect(result.requiresConfirmation).toBeUndefined()
  })

  it('omits adapterWarnings when the importer dropped nothing', async () => {
    // The boundary: omit-when-empty, so the renderer's notice cannot fire on a
    // clean install.
    const { handlers } = createHarness({
      async inspect() {
        return { item: skillItem(), diagnostics: [] }
      },
      async install() {
        return {
          ok: true,
          installed: { pluginKey: pluginKeyFor('skills-market', 'toolkit'), adapterWarnings: [] },
          diagnostics: [],
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: { kind: 'listing', marketplaceId: 'skills-market', listingId: 'code-review', listingKind: 'skills' },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })

    expect('adapterWarnings' in result).toBe(false)
  })

  it('installs a bring-your-own registry item from its cached catalog source, never the Skills Market client', async () => {
    const inspectCalls: unknown[] = []
    const installCalls: unknown[] = []
    const findCalls: unknown[] = []
    const refreshCalls: unknown[] = []
    const registryItem: MarketplaceCatalogItem = {
      id: 'registry-abc:toolkit',
      kind: 'plugin',
      listKind: 'plugins',
      name: 'toolkit',
      icon: { kind: 'symbol', name: 'plugin' },
      capabilities: [],
      install: { sourceConfidence: 'primary' },
      raw: {},
      marketplaceRegistryId: 'registry-abc',
      structuredInstallSource: {
        kind: 'repository',
        repositoryUrl: 'https://github.com/openai/plugins',
        ref: 'main',
        subdirectory: 'plugins/toolkit',
      },
    }
    const { handlers } = createHarness({
      async inspect(request: unknown) {
        inspectCalls.push(request)
        throw new Error('inspect (Skills Market client) must not run for a registry item')
      },
      async install(request: unknown) {
        installCalls.push(request)
        return {
          ok: true,
          installed: { pluginKey: pluginKeyFor('registry-abc', 'toolkit') },
          diagnostics: [],
        }
      },
    }, undefined, {}, {
      async listItems() { return { items: [] } },
      // P6.421 landed in `c0176a3e3`: a NAMED install refreshes that
      // marketplace before the lookup, so the handler now calls this. The stub
      // had no such method and every registry install threw
      // `refreshForInstall is not a function` (P6.651).
      async refreshForInstall(request: { marketplaceId: string }) {
        refreshCalls.push(request)
        return { upgraded: false, reason: 'recently-refreshed' as const }
      },
      async findCatalogItem(marketplaceRegistryId: string, itemId: string) {
        findCalls.push({ marketplaceRegistryId, itemId })
        return marketplaceRegistryId === 'registry-abc' && itemId === 'registry-abc:toolkit' ? registryItem : undefined
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'registry-abc',
        listingId: 'registry-abc:toolkit',
        listingKind: 'plugins',
      },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })

    // Resolved from the registry catalog cache — the HTTP detail client (inspect) is never touched.
    expect(inspectCalls).toEqual([])
    // ...but the NAMED marketplace is refreshed first (`c0176a3e3`), and a skip
    // verdict does not stop the cache lookup.
    expect(refreshCalls).toEqual([{ marketplaceId: 'registry-abc' }])
    expect(findCalls).toEqual([{ marketplaceRegistryId: 'registry-abc', itemId: 'registry-abc:toolkit' }])
    // The install request carries the resolved item with its durable repository source.
    expect(installCalls).toEqual([{
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
      item: registryItem,
    }])
    expect(result).toEqual({
      ok: true,
      pluginKey: pluginKeyFor('registry-abc', 'toolkit'),
      diagnosticCodes: [],
    })
  })

  it('fails a registry install with a clean typed error when the item is absent from the cache', async () => {
    const inspectCalls: unknown[] = []
    const installCalls: unknown[] = []
    const { handlers } = createHarness({
      async inspect(request: unknown) {
        inspectCalls.push(request)
        return { item: skillItem(), diagnostics: [] }
      },
      async install(request: unknown) {
        installCalls.push(request)
        return { ok: true, diagnostics: [] }
      },
    }, undefined, {}, {
      async listItems() { return { items: [] } },
      // `c0176a3e3` — the refresh runs even when the catalog will miss; the
      // page's contract is that a failed or skipped refresh still falls through
      // to the cached lookup, so this returns a verdict rather than throwing.
      async refreshForInstall() { return { upgraded: false, reason: 'fetch-failed' as const } },
      async findCatalogItem() { return undefined },
    })

    await expect(handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'registry-gone',
        listingId: 'registry-gone:toolkit',
        listingKind: 'plugins',
      },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    })).rejects.toThrow(/Marketplace listing "registry-gone:toolkit" is not in the catalog of marketplace "registry-gone"/)
    // A6: the message names BOTH halves and the id shape, and no longer advises
    // "refresh the marketplace and try again" — the remedy that was itself the
    // cause of this failure until A4 moved the `lastUpgradedAt` stamp.
    const bareId = await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'registry-gone',
        listingId: 'toolkit',
        listingKind: 'plugins',
      },
      activateIn: { kind: 'workspace', workspaceId: 'ws-1' },
    }).then(() => null, (error: unknown) => (error as Error).message)
    expect(bareId).toContain('"<marketplaceId>:<name>"')
    expect(bareId).not.toContain('refresh the marketplace and try again')
    // Neither the HTTP detail client (inspect) nor install runs on a cache miss.
    expect(inspectCalls).toEqual([])
    expect(installCalls).toEqual([])
  })

  it('resolves project activation through an opaque project handle', async () => {
    const installCalls: unknown[] = []
    const { handlers, runtimeRefreshCalls } = createHarness({
      async inspect() {
        return { item: skillItem(), diagnostics: [] }
      },
      async install(request: unknown) {
        installCalls.push(request)
        return { ok: true, diagnostics: [] }
      },
    }, undefined, {
      getProjectHandleService() {
        return {
          async resolveHandle() {
            return {
              workspaceId: 'ws-1',
              canonicalPath: '/work/ws/project',
              projectKey: 'project-key',
              trustDecision: 'trusted',
              trustRevision: 'trust-1',
            }
          },
        }
      },
    })

    await handlers.get(RPC_CHANNELS.marketplace.INSTALL)!(ctx(), {
      source: {
        kind: 'listing',
        marketplaceId: 'skills-market',
        listingId: 'code-review',
        listingKind: 'skills',
      },
      activateIn: {
        kind: 'project',
        context: { workspaceId: 'ws-1', projectHandleId: 'project-handle-1' },
      },
    })

    expect(installCalls[0]).toMatchObject({
      activateIn: { kind: 'project', workspaceId: 'ws-1', projectKey: 'project-key' },
    })
    expect(runtimeRefreshCalls).toEqual([['ws-1', 'project-key', 'marketplace install']])
  })

  it('rejects repository URLs with embedded credentials before service resolution', async () => {
    let called = false
    const { handlers } = createHarness({
      async proposeInstall() {
        called = true
        return {}
      },
    })
    await expect(handlers.get(RPC_CHANNELS.marketplace.PROPOSE_INSTALL)!(ctx(), {
      sourceUrl: 'https://user:pass@github.com/example/toolkit',
    })).rejects.toThrow('Invalid marketplace proposal request')
    expect(called).toBe(false)
  })

  // ── R3 registry mutations ────────────────────────────────────────────────

  it('adds a registry and projects a path-free result (no installedRoot)', async () => {
    const addCalls: unknown[] = []
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async add(request: unknown) {
        addCalls.push(request)
        // The controller CAN carry an absolute installedRoot; the handler must DROP it.
        return {
          marketplaceId: 'registry-abc',
          displayName: 'plugins',
          alreadyAdded: false,
          installedRoot: '/Users/attacker/clone/registry-abc',
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.ADD_REGISTRY)!(ctx(), {
      source: 'openai/plugins',
      refName: 'v1.2.3',
      sparsePaths: ['plugins/codex'],
    })

    expect(addCalls).toEqual([{ source: 'openai/plugins', refName: 'v1.2.3', sparsePaths: ['plugins/codex'] }])
    expect(result).toEqual({ marketplaceId: 'registry-abc', displayName: 'plugins', alreadyAdded: false })
    // Stop Condition: no absolute path crosses the Safe boundary.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/\/Users/)
    expect(serialized).not.toMatch(/installedRoot|catalogRoot|source/)

    // Invalid shapes (extra keys / absolute-path fields) are rejected pre-service.
    await expect(handlers.get(RPC_CHANNELS.marketplace.ADD_REGISTRY)!(ctx(), {
      source: 'openai/plugins',
      installedRoot: '/attacker/path',
    })).rejects.toThrow('Invalid marketplace add-registry request')
    expect(addCalls).toHaveLength(1)
  })

  it('upgrades a git registry and returns a path-free no-op for local folders', async () => {
    const upgradeCalls: unknown[] = []
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async upgrade(request: { marketplaceId: string }) {
        upgradeCalls.push(request)
        return request.marketplaceId === 'registry-local'
          ? {
              marketplaceId: request.marketplaceId,
              upgraded: false,
              reason: 'not-git' as const,
              // Server-only detail: names internal subsystems, must NOT cross.
              diagnosticCodes: ['marketplace.registry.catalog_missing'],
            }
          : { marketplaceId: request.marketplaceId, upgraded: true }
      },
    })

    const git = await handlers.get(RPC_CHANNELS.marketplace.UPGRADE_REGISTRY)!(ctx(), { marketplaceId: 'registry-git' })
    // A success carries no `reason` — the field is omitted, not sent as null.
    expect(git).toEqual({ marketplaceId: 'registry-git', upgraded: true })

    const local = await handlers.get(RPC_CHANNELS.marketplace.UPGRADE_REGISTRY)!(ctx(), { marketplaceId: 'registry-local' })
    // `reason` NOW crosses (a fixed server-chosen enum) so the user is told why
    // instead of being shown the opaque registry id; `diagnosticCodes` still
    // stops here.
    expect(local).toEqual({ marketplaceId: 'registry-local', upgraded: false, reason: 'not-git' })
    expect(JSON.stringify(local)).not.toContain('diagnosticCodes')
    expect(JSON.stringify(local)).not.toContain('catalog_missing')
    expect(upgradeCalls).toHaveLength(2)

    await expect(handlers.get(RPC_CHANNELS.marketplace.UPGRADE_REGISTRY)!(ctx(), { source: 'x' }))
      .rejects.toThrow('Invalid marketplace upgrade-registry request')
  })

  it('removes a registry but never the built-in Skills Market', async () => {
    const removeCalls: unknown[] = []
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async remove(request: unknown) {
        removeCalls.push(request)
        return { marketplaceId: 'registry-abc', removed: true }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.REMOVE_REGISTRY)!(ctx(), { marketplaceId: 'registry-abc' })
    expect(result).toEqual({ marketplaceId: 'registry-abc', removed: true })
    expect(removeCalls).toEqual([{ marketplaceId: 'registry-abc' }])

    // The built-in Skills Market is not a bring-your-own registry — never removable.
    await expect(handlers.get(RPC_CHANNELS.marketplace.REMOVE_REGISTRY)!(ctx(), { marketplaceId: 'skills-market' }))
      .rejects.toThrow('cannot be removed')
    expect(removeCalls).toHaveLength(1)
  })

  it('lists registries as path-free rows (no source path / installedRoot)', async () => {
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async list() {
        return {
          registries: [
            { marketplaceId: 'registry-abc', displayName: 'plugins', refName: 'main' },
            { marketplaceId: 'registry-def', displayName: 'internal' },
          ],
          available: [],
        }
      },
    })

    const result = await handlers.get(RPC_CHANNELS.marketplace.LIST_REGISTRIES)!(ctx(), undefined)
    // P6.517/P6.518: with nothing on offer the payload is byte-identical to what
    // it was before offers existed — no empty `available` key for a renderer to
    // have to reason about.
    expect(result).toEqual({
      registries: [
        { marketplaceId: 'registry-abc', displayName: 'plugins', refName: 'main' },
        { marketplaceId: 'registry-def', displayName: 'internal' },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('available')
    expect(JSON.stringify(result)).not.toMatch(/\/Users|installedRoot|source|catalogRoot/)
  })

  /**
   * P6.517 / P6.518 — the delivered-but-off catalogs, and the one click.
   */
  it('projects the offers still switched off, and enables one by NAME alone', async () => {
    const enableCalls: unknown[] = []
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async list() {
        return {
          registries: [],
          available: [
            {
              name: 'claude-plugins-official',
              source: 'anthropics/claude-plugins-official',
              description: 'The official Anthropic plugin marketplace.',
            },
          ],
        }
      },
      async enableBuiltInMarketplace(request: unknown) {
        enableCalls.push(request)
        return {
          marketplaceId: 'registry-official',
          displayName: 'claude-plugins-official',
          alreadyAdded: false,
          installedRoot: '/Users/somebody/.nessy-agent/marketplaces/official',
        }
      },
    })

    const listed = await handlers.get(RPC_CHANNELS.marketplace.LIST_REGISTRIES)!(ctx(), undefined)
    expect(listed).toEqual({
      registries: [],
      available: [{
        name: 'claude-plugins-official',
        source: 'anthropics/claude-plugins-official',
        description: 'The official Anthropic plugin marketplace.',
      }],
    })

    const enabled = await handlers.get(RPC_CHANNELS.marketplace.ENABLE_OFFER)!(ctx(), {
      name: 'claude-plugins-official',
    })
    expect(enableCalls).toEqual([{ name: 'claude-plugins-official' }])
    // Same projection as ADD_REGISTRY — the clone path never crosses the wire.
    expect(enabled).toEqual({
      marketplaceId: 'registry-official',
      displayName: 'claude-plugins-official',
      alreadyAdded: false,
    })
    expect(JSON.stringify(enabled)).not.toMatch(/\/Users|installedRoot/)
  })

  it('refuses an enable-offer request that smuggles a source beside the name', async () => {
    const enableCalls: unknown[] = []
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async enableBuiltInMarketplace(request: unknown) {
        enableCalls.push(request)
        return { marketplaceId: 'x', displayName: 'x', alreadyAdded: false }
      },
    })

    // The whole security property of this channel: the source is pinned
    // server-side, so a caller that tries to carry one is rejected outright
    // rather than having the extra key quietly dropped.
    for (const bad of [
      { name: 'claude-plugins-official', source: 'attacker/repo' },
      { name: '' },
      { source: 'attacker/repo' },
      'claude-plugins-official',
    ]) {
      await expect(handlers.get(RPC_CHANNELS.marketplace.ENABLE_OFFER)!(ctx(), bad))
        .rejects.toThrow('Invalid marketplace enable-offer request')
    }
    expect(enableCalls).toEqual([])
  })

  it('throws when a registry mutation runs before the registry source is wired', async () => {
    const { handlers } = createHarness({})
    await expect(handlers.get(RPC_CHANNELS.marketplace.LIST_REGISTRIES)!(ctx(), undefined))
      .rejects.toThrow('Marketplace registries are unavailable')
  })
})

/**
 * D3 — one listing's declared composition, before install. Two sources, and the
 * second one only when the first is silent: the browse list stays cheap
 * (2 307 community rows) while a DETAIL page may spend one request.
 */
describe('marketplace declared components', () => {
  function registryRow(capabilities: string[], source?: unknown): MarketplaceCatalogItem {
    return {
      id: 'registry-abc:figma',
      kind: 'plugin',
      listKind: 'plugins',
      name: 'figma',
      icon: { kind: 'symbol', name: 'plugin' },
      capabilities,
      install: { sourceConfidence: 'primary' },
      raw: {},
      marketplaceRegistryId: 'registry-abc',
      ...(source ? { structuredInstallSource: source as MarketplaceCatalogItem['structuredInstallSource'] } : {}),
    }
  }

  const request = {
    marketplaceId: 'registry-abc',
    listingId: 'registry-abc:figma',
    listingKind: 'plugins' as const,
  }

  it('answers from the row the browse list already has, without touching the network', async () => {
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async findCatalogItem() {
        // A row whose registry catalog already declared kinds — plus the
        // non-kind tokens `capabilities` also carries, which must not cross.
        return registryRow(['skill', 'linear', 'mcp'], {
          kind: 'repository',
          repositoryUrl: 'https://github.com/openai/plugins',
          ref: 'main',
          subdirectory: 'plugins/figma',
        })
      },
    })

    expect(await handlers.get(RPC_CHANNELS.marketplace.COMPONENTS)!(ctx(), request))
      .toEqual({ known: true, kinds: ['skill', 'mcp'] })
  })

  it('reports "does not say" — never an empty inventory — when nothing declares', async () => {
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      // A silent row with an UNADDRESSABLE source: the probe cannot build a URL,
      // so no request is made and the answer stays honestly unknown.
      async findCatalogItem() { return registryRow([], { kind: 'local-path', path: '/tmp/x' }) },
    })

    expect(await handlers.get(RPC_CHANNELS.marketplace.COMPONENTS)!(ctx(), request))
      .toEqual({ known: false, kinds: [] })
  })

  it('never probes the built-in Skills Market, and refuses a malformed request', async () => {
    let lookups = 0
    const { handlers } = createHarness({}, undefined, {}, {
      async listItems() { return { items: [] } },
      async findCatalogItem() { lookups += 1; return registryRow(['skill']) },
    })

    expect(await handlers.get(RPC_CHANNELS.marketplace.COMPONENTS)!(ctx(), {
      marketplaceId: 'skills-market', listingId: 'abc', listingKind: 'skills',
    })).toEqual({ known: false, kinds: [] })
    expect(lookups).toBe(0)

    await expect(handlers.get(RPC_CHANNELS.marketplace.COMPONENTS)!(ctx(), { listingId: 'abc' }))
      .rejects.toThrow('Invalid marketplace components request')
  })
})

// P6.563 — the Plugins page's Refresh-runtime action, which reached no server
// at all until this row. The two arms that matter are the verdict the button
// reports and the request shape it is allowed to send: a positive case where
// the refresh landed, and a negative case where a malformed request is refused
// rather than silently widened into a global refresh.
describe('marketplace refresh-runtime (P6.563)', () => {
  function refreshHarness(summary: { applied: number; deferred: number; untouched: number }) {
    const calls: Array<unknown[]> = []
    const { handlers } = createHarness({}, undefined, {
      async refreshPluginRuntime(...args: unknown[]) {
        calls.push(args)
        return summary
      },
    })
    return { handler: handlers.get(RPC_CHANNELS.marketplace.REFRESH_RUNTIME)!, calls }
  }

  it('calls refreshPluginRuntime for the workspace and reports the server verdict', async () => {
    const { handler, calls } = refreshHarness({ applied: 2, deferred: 0, untouched: 1 })

    expect(await handler(ctx(), { workspaceId: 'ws-1' })).toEqual({ verdict: 'applied' })
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('ws-1')
  })

  it('reports deferred over applied, and untouched when no runtime was refreshed', async () => {
    // A turn in flight still holds the previous paths, so `deferred` wins.
    const deferred = refreshHarness({ applied: 3, deferred: 1, untouched: 0 })
    expect(await deferred.handler(ctx(), { workspaceId: 'ws-1' })).toEqual({ verdict: 'deferred' })

    // Nothing was refreshed because nothing needed refreshing — deliberately
    // NOT folded into `applied`, which would assert a refresh that never ran.
    const untouched = refreshHarness({ applied: 0, deferred: 0, untouched: 4 })
    expect(await untouched.handler(ctx(), {})).toEqual({ verdict: 'untouched' })
    expect(untouched.calls[0]![0]).toBeUndefined()
  })

  it('refuses a malformed request instead of widening it to every workspace', async () => {
    const { handler, calls } = refreshHarness({ applied: 1, deferred: 0, untouched: 0 })

    await expect(handler(ctx(), { workspaceID: 'ws-1' }))
      .rejects.toThrow('Invalid marketplace refresh-runtime request')
    await expect(handler(ctx(), { workspaceId: 42 }))
      .rejects.toThrow('Invalid marketplace refresh-runtime request')
    await expect(handler(ctx(), { workspaceId: '' }))
      .rejects.toThrow('Invalid marketplace refresh-runtime request')
    expect(calls).toHaveLength(0)
  })
})
