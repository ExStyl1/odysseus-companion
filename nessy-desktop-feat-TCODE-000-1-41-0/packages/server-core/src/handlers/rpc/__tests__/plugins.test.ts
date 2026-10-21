import { beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { pluginKeyFor } from '@nessy-agent/shared/workspaces'
import {
  PluginMutationCommittedError,
  type PluginDependencyDescriptor,
  type PluginManagementInstallResult,
  type PluginManagementInstalledSummary,
  type PluginManagementRepairOptions,
} from '@nessy-agent/shared/plugins'
import type { MarketplaceCatalogItem } from '@nessy-agent/shared/marketplace'
import {
  onCapabilityInvalidation,
  type CapabilityInvalidation,
} from '@nessy-agent/shared/capabilities/invalidation'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'
import { registerPluginsHandlers } from '../plugins'

const enableCalls: unknown[][] = []
const disableCalls: unknown[][] = []
const setCapabilityCalls: unknown[][] = []
const configurationCalls: unknown[][] = []
const repairCalls: string[] = []
const updateCalls: string[] = []
/** R88: the update's SECOND argument — the whole point of the unit. */
const updateOptions: Array<PluginManagementRepairOptions | undefined> = []
const uninstallCalls: string[] = []
const runtimeRefreshCalls: Array<unknown[]> = []
const pushCalls: Array<{ channel: string; target: unknown; args: unknown[] }> = []
const catalogPeeks: number[] = []

beforeEach(() => {
  enableCalls.length = 0
  disableCalls.length = 0
  setCapabilityCalls.length = 0
  configurationCalls.length = 0
  repairCalls.length = 0
  updateCalls.length = 0
  updateOptions.length = 0
  uninstallCalls.length = 0
  runtimeRefreshCalls.length = 0
  pushCalls.length = 0
  catalogPeeks.length = 0
})

describe('registerPluginsHandlers', () => {
  it('registers only the safe PluginKey management route', () => {
    const { handlers } = createHarness()
    expect(Object.values(RPC_CHANNELS.plugins)).toEqual(['plugins:manage'])
    expect([...handlers.keys()]).toEqual([RPC_CHANNELS.plugins.MANAGE])
  })

  it('maps safe PluginKey activation to an ID-only Workspace target', async () => {
    const { handlers } = createHarness()
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')

    const result = await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey,
      action: 'enable',
      target: { kind: 'workspace', workspaceId: 'workspace-1' },
    })

    expect(enableCalls).toEqual([[pluginKey, { kind: 'workspace', workspaceId: 'workspace-1' }]])
    expect(result).toEqual({ ok: true, pluginKey, action: 'enable' })
    expect(runtimeRefreshCalls).toEqual([['workspace-1', undefined, 'plugin enable']])
    expect(pushCalls.map(call => call.channel)).toEqual([RPC_CHANNELS.capabilities.CHANGED])
  })

  it('returns value-free authentication requirements from plugin mutations', async () => {
    const requirement = {
      kind: 'dp' as const,
      capabilityIds: ['gitlab'],
      serverNames: ['dpGitlab'],
      sharedProvider: 'dp' as const,
      timing: 'ON_FIRST_USE' as const,
    }
    const { handlers } = createHarness({ enableResult: { authRequirements: [requirement] } })
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')

    const result = await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey,
      action: 'enable',
      target: { kind: 'workspace', workspaceId: 'workspace-1' },
    })

    expect(result).toEqual({ ok: true, pluginKey, action: 'enable', authRequirements: [requirement] })
  })

  it('rejects mismatched workspaces and legacy executable/root fields', async () => {
    const { handlers } = createHarness()
    const manage = handlers.get(RPC_CHANNELS.plugins.MANAGE)!
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')

    await expect(manage(ctx('workspace-1'), {
      pluginKey,
      action: 'disable',
      target: { kind: 'workspace', workspaceId: 'workspace-2' },
    })).rejects.toThrow('plugin.manage.workspace-mismatch')
    await expect(manage(ctx('workspace-1'), {
      pluginKey,
      action: 'uninstall',
      executableHash: 'legacy-hash',
    })).rejects.toThrow('plugin.manage.invalid-request')
    await expect(manage(ctx('workspace-1'), {
      pluginKey,
      action: 'enable',
      target: { kind: 'global', projectRoot: '/attacker/path' },
    })).rejects.toThrow('plugin.manage.invalid-request')
  })

  it('routes lifecycle actions by stable PluginKey only', async () => {
    const { handlers } = createHarness()
    const manage = handlers.get(RPC_CHANNELS.plugins.MANAGE)!
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')

    await manage(ctx('workspace-1'), { pluginKey, action: 'repair' })
    await manage(ctx('workspace-1'), { pluginKey, action: 'update' })
    await manage(ctx('workspace-1'), { pluginKey, action: 'uninstall' })

    expect(repairCalls).toEqual([pluginKey])
    expect(updateCalls).toEqual([pluginKey])
    expect(uninstallCalls).toEqual([pluginKey])
    expect(runtimeRefreshCalls).toEqual([
      [undefined, undefined, 'plugin repair', 'workspace-1'], // F1.484 — a global refresh; its VERDICT answers for the caller
      [undefined, undefined, 'plugin update', 'workspace-1'],
      [undefined, undefined, 'plugin uninstall', 'workspace-1'],
    ])
    expect(pushCalls.map(call => call.target)).toEqual([
      { to: 'workspace', workspaceId: 'workspace-1' },
      { to: 'workspace', workspaceId: 'workspace-2' },
      { to: 'workspace', workspaceId: 'workspace-1' },
      { to: 'workspace', workspaceId: 'workspace-2' },
      { to: 'workspace', workspaceId: 'workspace-1' },
      { to: 'workspace', workspaceId: 'workspace-2' },
    ])
  })

  it('preserves path-free partial compatibility on repair/update RPC results', async () => {
    const { handlers } = createHarness({
      repairResult: {
        ok: true,
        diagnostics: [],
        requiresConfirmation: true,
        compatibility: {
          format: 'codex',
          state: 'partial',
          supportedKinds: ['skill'],
          deferred: [{
            externalKind: 'lsp',
            reasonCode: 'plugin.deferred.codex_lsp',
            sourcePath: '/private/plugin/plugin.json',
          }],
          blocked: [],
        },
      },
    })
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const events: CapabilityInvalidation[] = []
    const unsubscribe = onCapabilityInvalidation(event => { events.push(event) })
    let result: unknown
    try {
      result = await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
        pluginKey,
        action: 'repair',
      })
    } finally {
      unsubscribe()
    }
    expect(result).toEqual({
      ok: true,
      pluginKey,
      action: 'repair',
      state: 'partial',
      requiresConfirmation: true,
      deferred: [{ externalKind: 'lsp', reasonCode: 'plugin.deferred.codex_lsp' }],
    })
    expect(JSON.stringify(result)).not.toContain('/private/plugin')
    expect(events.filter((event): event is Extract<CapabilityInvalidation, { kind: 'plugin' }> => (
      event.kind === 'plugin'
    )).map(event => event.effect)).toEqual(['remove'])
    expect(pushCalls.at(-1)?.args[0]).toMatchObject({ effect: 'revoke-active-snapshot' })
  })

  it('does not invalidate or drain runtimes after a rejected repair', async () => {
    const { handlers } = createHarness({
      repairResult: {
        ok: false,
        diagnostics: [{
          severity: 'error',
          code: 'plugin.install.npm_metadata_fetch_failed',
          message: 'Package metadata was unavailable.',
        }],
      },
    })
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const result = await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey,
      action: 'repair',
    })

    expect(result).toEqual({ ok: false, pluginKey, action: 'repair' })
    expect(runtimeRefreshCalls).toEqual([])
    expect(pushCalls).toEqual([])
  })

  it('routes set-capability-enabled with scope validation and directional effects', async () => {
    const { handlers } = createHarness()
    const manage = handlers.get(RPC_CHANNELS.plugins.MANAGE)!
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const events: CapabilityInvalidation[] = []
    const unsubscribe = onCapabilityInvalidation(event => { events.push(event) })
    try {
      const result = await manage(ctx('workspace-1'), {
        pluginKey,
        action: 'set-capability-enabled',
        target: { kind: 'workspace', workspaceId: 'workspace-1' },
        capabilityId: 'mcp-one',
        enabled: false,
      })
      expect(result).toEqual({ ok: true, pluginKey, action: 'set-capability-enabled' })
      expect(setCapabilityCalls).toEqual([
        [pluginKey, { kind: 'workspace', workspaceId: 'workspace-1' }, 'mcp-one', false],
      ])

      await manage(ctx('workspace-1'), {
        pluginKey,
        action: 'set-capability-enabled',
        target: { kind: 'workspace', workspaceId: 'workspace-1' },
        capabilityId: 'mcp-one',
        enabled: true,
      })
    } finally {
      unsubscribe()
    }

    // disable → remove; re-enable → add-or-refresh.
    const plugin = events.filter((event): event is Extract<CapabilityInvalidation, { kind: 'plugin' }> => event.kind === 'plugin')
    expect(plugin.map(event => event.effect)).toEqual(['remove', 'add-or-refresh'])

    // Cross-workspace target is rejected before any write.
    await expect(manage(ctx('workspace-1'), {
      pluginKey,
      action: 'set-capability-enabled',
      target: { kind: 'workspace', workspaceId: 'workspace-2' },
      capabilityId: 'mcp-one',
      enabled: false,
    })).rejects.toThrow('plugin.manage.workspace-mismatch')
    // Malformed payloads never reach the service.
    await expect(manage(ctx('workspace-1'), {
      pluginKey,
      action: 'set-capability-enabled',
      target: { kind: 'workspace', workspaceId: 'workspace-1' },
      enabled: false,
    })).rejects.toThrow('plugin.manage.invalid-request')
    expect(setCapabilityCalls).toHaveLength(2)
  })

  it('keeps configuration values one-way and invalidates only configure/clear', async () => {
    const { handlers } = createHarness()
    const manage = handlers.get(RPC_CHANNELS.plugins.MANAGE)!
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const secret = 'RPC_SECRET_CANARY'

    const status = await manage(ctx('workspace-1'), {
      pluginKey,
      action: 'configuration-status',
      workspaceId: 'workspace-1',
    })
    const configured = await manage(ctx('workspace-1'), {
      pluginKey,
      action: 'configure',
      workspaceId: 'workspace-1',
      values: { api_key: secret, count: 2 },
    })
    const cleared = await manage(ctx('workspace-1'), {
      pluginKey,
      action: 'clear-configuration',
      workspaceId: 'workspace-1',
    })

    expect(configurationCalls).toEqual([
      ['status', pluginKey, 'workspace-1'],
      ['configure', pluginKey, 'workspace-1', { api_key: secret, count: 2 }],
      ['clear', pluginKey, 'workspace-1'],
    ])
    expect(JSON.stringify([status, configured, cleared])).not.toContain(secret)
    expect(runtimeRefreshCalls).toEqual([
      ['workspace-1', undefined, 'plugin configure'],
      ['workspace-1', undefined, 'plugin clear-configuration'],
    ])
    await expect(manage(ctx('workspace-1'), {
      pluginKey,
      action: 'configuration-status',
      workspaceId: 'workspace-2',
    })).rejects.toThrow('plugin.manage.workspace-mismatch')
  })

  it('emits add/refresh vs remove capability invalidations', async () => {
    const { handlers } = createHarness()
    const manage = handlers.get(RPC_CHANNELS.plugins.MANAGE)!
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const events: CapabilityInvalidation[] = []
    const unsubscribe = onCapabilityInvalidation(event => { events.push(event) })
    try {
      await manage(ctx('workspace-1'), {
        pluginKey,
        action: 'enable',
        target: { kind: 'workspace', workspaceId: 'workspace-1' },
      })
      await manage(ctx('workspace-1'), {
        pluginKey,
        action: 'disable',
        target: { kind: 'workspace', workspaceId: 'workspace-1' },
      })
      await manage(ctx('workspace-1'), { pluginKey, action: 'uninstall' })
    } finally {
      unsubscribe()
    }

    const plugin = events.filter((event): event is Extract<CapabilityInvalidation, { kind: 'plugin' }> => event.kind === 'plugin')
    expect(plugin.map(event => event.effect)).toEqual(['add-or-refresh', 'remove', 'remove'])
    expect(plugin.map(event => event.scope)).toEqual([
      { kind: 'workspace', workspaceId: 'workspace-1' },
      { kind: 'workspace', workspaceId: 'workspace-1' },
      { kind: 'global' },
    ])
  })

  it('publishes remove invalidation before waiting for live runtime teardown', async () => {
    let signalRefreshStarted!: () => void
    const refreshStarted = new Promise<void>(resolve => { signalRefreshStarted = resolve })
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve })
    const { handlers } = createHarness({
      refreshPluginRuntime: async (...args: unknown[]) => {
        runtimeRefreshCalls.push(args)
        signalRefreshStarted()
        await refreshGate
      },
    })
    const manage = handlers.get(RPC_CHANNELS.plugins.MANAGE)!
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const events: CapabilityInvalidation[] = []
    const unsubscribe = onCapabilityInvalidation(event => { events.push(event) })
    const pending = manage(ctx('workspace-1'), {
      pluginKey,
      action: 'disable',
      target: { kind: 'workspace', workspaceId: 'workspace-1' },
    })

    await refreshStarted
    try {
      const plugin = events.filter((event): event is Extract<CapabilityInvalidation, { kind: 'plugin' }> => event.kind === 'plugin')
      expect(plugin.map(event => event.effect)).toEqual(['remove'])
      expect(pushCalls.map(call => call.channel)).toEqual([RPC_CHANNELS.capabilities.CHANGED])
    } finally {
      releaseRefresh()
      await pending
      unsubscribe()
    }
  })

  it('invalidates active runtimes when durable revoke committed before cleanup failed', async () => {
    const pluginKey = pluginKeyFor('skills-market', 'toolkit')
    const failure = new PluginMutationCommittedError(
      'uninstall',
      pluginKey,
      new Error('managed-data-cleanup-failed'),
    )
    const { handlers } = createHarness({ uninstallError: failure })
    const events: CapabilityInvalidation[] = []
    const unsubscribe = onCapabilityInvalidation(event => { events.push(event) })
    try {
      await expect(handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
        pluginKey,
        action: 'uninstall',
      })).rejects.toThrow('managed-data-cleanup-failed')
    } finally {
      unsubscribe()
    }

    const plugin = events.filter((event): event is Extract<CapabilityInvalidation, { kind: 'plugin' }> => (
      event.kind === 'plugin'
    ))
    expect(plugin.map(event => [event.scope, event.effect])).toEqual([
      [{ kind: 'global' }, 'remove'],
    ])
    expect(runtimeRefreshCalls).toEqual([[undefined, undefined, 'plugin uninstall', 'workspace-1']]) // F1.484
    expect(pushCalls.map(call => call.target)).toEqual([
      { to: 'workspace', workspaceId: 'workspace-1' },
      { to: 'workspace', workspaceId: 'workspace-2' },
    ])
  })
})

/**
 * R88 — the user-clickable Update must fetch the NEW version.
 *
 * `PluginManagementServiceV2.update` is `repair` plus a caller-supplied source
 * and says so in its own docstring: "Called with no `source`, it therefore
 * re-fetches the version that is already installed. That is a real limit and it
 * is the caller's to fix." This handler is that caller and it passed nothing, so
 * clicking Update reinstalled the installed version and reported success — on
 * exactly the marketplaces `plugins/loading.md#which-marketplaces-and-plugins-auto-update` leaves auto-update OFF for
 * ("Third-party and local development marketplaces"), where the background pass
 * that DOES pass a source never runs.
 *
 * Every case below is decided from a CACHED catalog peek, never `listItems()`:
 * R81 disqualified that read for kicking a git clone onto the request, spending a
 * failed registry's retry budget and writing `marketplaces.json`.
 */
describe('registerPluginsHandlers update source (R88)', () => {
  it('installs the catalog version when the marketplace is ahead', async () => {
    const { handlers } = createHarness({
      installed: [installedRow({ version: '1.0.0', itemId: 'acme-tools:toolkit' })],
      catalogItems: [catalogRow('toolkit', '2.0.0')],
    })

    const result = await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'update',
    })

    expect(result).toEqual({ ok: true, pluginKey: TOOLKIT_KEY, action: 'update' })
    // THE defect: pre-R88 this was `undefined`, so `update` fell through to
    // `repair(pluginKey, {})` and re-fetched 1.0.0 while claiming success.
    expect(updateOptions).toEqual([{
      source: {
        kind: 'repository',
        repositoryUrl: 'https://example.test/acme-tools/toolkit.git',
        marketplace: expect.objectContaining({
          marketplaceId: 'acme-tools',
          itemId: 'acme-tools:toolkit',
          name: 'toolkit',
          version: '2.0.0',
        }),
      },
    }])
    expect(catalogPeeks).toHaveLength(1)
  })

  it('refuses the update when the two versions cannot be ordered (P2.159)', async () => {
    // The measured case: the official `claude-security` bundle declares a
    // FOUR-part `0.10.2.3`, which strict `semver.parse` refuses, so the
    // comparison answered "not newer" and this handler fell through to the
    // `current` branch -> `{}` -> `repair`. On a pinned origin whose ref is the
    // MOVING `main` branch, that silently installed whatever `main` pointed at
    // while reporting a same-version reinstall: the comparison was bypassed, not
    // satisfied. It must refuse, out loud, and MUST NOT call update at all.
    updateCalls.length = 0
    updateOptions.length = 0
    const { handlers } = createHarness({
      installed: [installedRow({ version: '0.10.0', itemId: 'acme-tools:toolkit' })],
      catalogItems: [catalogRow('toolkit', '0.10.2.3')],
    })

    await expect(handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'update',
    })).rejects.toThrow(/0\.10\.2\.3.*0\.10\.0.*not a semantic version/s)
    expect(updateCalls).toEqual([])
    expect(updateOptions).toEqual([])
  })

  it('repairs from the pinned origin when the catalog holds nothing newer', async () => {
    // `actions.canUpdate` withholds the control in this state, so it is reachable
    // only by raw RPC or by a click racing a catalog refresh. Neither is the
    // user's fault, and re-materializing the pinned origin is precisely what this
    // handler has always done — so it stays a success, not a new error surface.
    const { handlers } = createHarness({
      installed: [installedRow({ version: '2.0.0', itemId: 'acme-tools:toolkit' })],
      catalogItems: [catalogRow('toolkit', '2.0.0')],
    })

    const result = await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'update',
    })

    expect(result).toEqual({ ok: true, pluginKey: TOOLKIT_KEY, action: 'update' })
    expect(updateOptions).toEqual([{}])
  })

  it('fails honestly when no cached catalog row backs the installed plugin', async () => {
    // Without a row we cannot distinguish a real update from a same-version
    // reinstall, and reporting "updated" for the latter is the whole defect.
    const cases: Array<MarketplaceCatalogItem[] | null> = [
      // empty cache, a cache that holds only OTHER plugins, and no registry
      // source wired at all — all three are "we cannot tell".
      [],
      [catalogRow('other-plugin', '9.9.9')],
      null,
    ]
    for (const catalogItems of cases) {
      updateCalls.length = 0
      const { handlers } = createHarness({
        installed: [installedRow({ version: '1.0.0', itemId: 'acme-tools:toolkit' })],
        catalogItems,
      })

      await expect(handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
        pluginKey: TOOLKIT_KEY,
        action: 'update',
      })).rejects.toThrow('no installable marketplace catalog entry')
      // Nothing was re-installed, and nothing claimed it was.
      expect(updateCalls).toEqual([])
    }
    expect(runtimeRefreshCalls).toEqual([])
    expect(pushCalls).toEqual([])
  })

  it('refuses a plugin an installed dependent holds back', async () => {
    // `plugins/host-marketplace.md#hold-users-on-one-version` — "The dependency stays at `2.1.0`.
    // Auto-update skips newer versions while plugin A is installed." A manual
    // click must not do what the unattended pass refuses.
    const held = {
      installed: [
        installedRow({
          pluginKey: pluginKeyFor('skills-market', 'plugin-a'),
          pluginId: 'plugin-a',
          version: '1.0.0',
          dependencies: [{ name: 'toolkit', version: '=2.1.0' }],
        }),
        installedRow({ version: '2.1.0', itemId: 'acme-tools:toolkit' }),
      ],
      catalogItems: [catalogRow('toolkit', '3.0.0')],
    }
    const { handlers } = createHarness(held)

    await expect(handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'update',
    })).rejects.toThrow('plugin-a')
    expect(updateCalls).toEqual([])

    // POSITIVE CONTROL — same catalog, same installed toolkit, dependent
    // removed. Without it the refusal above could just as well be a failed
    // catalog join.
    const freed = createHarness({ installed: [held.installed[1]!], catalogItems: held.catalogItems })
    await freed.handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'update',
    })
    expect(updateOptions.at(-1)).toMatchObject({ source: { kind: 'repository' } })
  })

  it('leaves repair on the pinned origin — it never consults the catalog', async () => {
    const { handlers } = createHarness({
      installed: [installedRow({ version: '1.0.0', itemId: 'acme-tools:toolkit' })],
      catalogItems: [catalogRow('toolkit', '2.0.0')],
    })

    await handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'repair',
    })

    expect(repairCalls).toEqual([TOOLKIT_KEY])
    expect(catalogPeeks).toEqual([])
  })

  it('rejects an update for a plugin that is not installed', async () => {
    const { handlers } = createHarness({ installed: [], catalogItems: [catalogRow('toolkit', '2.0.0')] })

    await expect(handlers.get(RPC_CHANNELS.plugins.MANAGE)!(ctx('workspace-1'), {
      pluginKey: TOOLKIT_KEY,
      action: 'update',
    })).rejects.toThrow('plugin.manage.not-installed')
    expect(updateCalls).toEqual([])
  })
})

const TOOLKIT_KEY = pluginKeyFor('skills-market', 'toolkit')

/** One installed row, in the shape `PluginManagementApi.status()` returns. */
function installedRow(options: {
  pluginKey?: string
  pluginId?: string
  version?: string
  itemId?: string
  dependencies?: PluginDependencyDescriptor[]
} = {}): PluginManagementInstalledSummary {
  const pluginId = options.pluginId ?? 'toolkit'
  return {
    pluginKey: options.pluginKey ?? TOOLKIT_KEY,
    activeInstanceId: `plugin://acme-tools/${pluginId}`,
    marketplaceId: 'acme-tools',
    pluginId,
    version: options.version ?? '1.0.0',
    name: pluginId,
    installedAt: 1,
    capabilityKinds: [],
    diagnostics: [],
    ...(options.itemId ? { source: { marketplaceItemId: options.itemId } } : {}),
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
  } as PluginManagementInstalledSummary
}

/** One catalog row, as `peekCachedItems()` serves it (cached, path-free). */
function catalogRow(name: string, version: string): MarketplaceCatalogItem {
  return {
    id: `acme-tools:${name}`,
    kind: 'plugin',
    listKind: 'plugins',
    name,
    version,
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    raw: {},
    marketplaceRegistryId: 'acme-tools',
    structuredInstallSource: {
      kind: 'repository',
      repositoryUrl: `https://example.test/acme-tools/${name}.git`,
    },
  }
}

function createHarness(options: {
  enableResult?: { authRequirements: unknown[] }
  refreshPluginRuntime?: (...args: unknown[]) => Promise<void>
  repairResult?: PluginManagementInstallResult
  uninstallError?: Error
  /** Defaults to one row for TOOLKIT_KEY at 1.0.0. */
  installed?: PluginManagementInstalledSummary[]
  /**
   * Defaults to a LEVEL catalog (same version as installed), which is the
   * pre-R88 repair-equivalent path and keeps every lifecycle test unchanged.
   * `null` means "no registry source wired at all".
   */
  catalogItems?: MarketplaceCatalogItem[] | null
} = {}) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push(channel, target, ...args) { pushCalls.push({ channel, target, args }) },
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const installed = options.installed ?? [installedRow()]
  const catalogItems = options.catalogItems === undefined
    ? installed.map(entry => catalogRow(entry.pluginId, entry.version))
    : options.catalogItems
  const deps = {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {
      refreshPluginRuntime: options.refreshPluginRuntime
        ?? (async (...args: unknown[]) => { runtimeRefreshCalls.push(args) }),
    },
    ...(catalogItems ? {
      marketplaceRegistrySource: {
        async peekCachedItems() { catalogPeeks.push(1); return catalogItems },
      },
    } : {}),
    pluginManagement: {
      async status() { return { installed, diagnostics: [] } },
      async install() { return { ok: true, diagnostics: [] } },
      async enable(...args: unknown[]) { enableCalls.push(args); return options.enableResult ?? {} },
      async disable(...args: unknown[]) { disableCalls.push(args); return {} },
      async setCapabilityEnabled(...args: unknown[]) { setCapabilityCalls.push(args); return {} },
      async configurationStatus(pluginKey: string, workspaceId: string) {
        configurationCalls.push(['status', pluginKey, workspaceId])
        return { state: 'needs_configuration' as const, fields: [{ key: 'api_key', valueType: 'secret-ref' as const, required: true, hasDefault: false, configured: false, missing: true }] }
      },
      async configure(pluginKey: string, workspaceId: string, values: Record<string, unknown>) {
        configurationCalls.push(['configure', pluginKey, workspaceId, values])
        return { state: 'ready' as const, fields: [{ key: 'api_key', valueType: 'secret-ref' as const, required: true, hasDefault: false, configured: true, missing: false }] }
      },
      async clearConfiguration(pluginKey: string, workspaceId: string) {
        configurationCalls.push(['clear', pluginKey, workspaceId])
        return { state: 'needs_configuration' as const, fields: [{ key: 'api_key', valueType: 'secret-ref' as const, required: true, hasDefault: false, configured: false, missing: true }] }
      },
      async repair(pluginKey: string) {
        repairCalls.push(pluginKey)
        return options.repairResult ?? { ok: true, diagnostics: [] }
      },
      async update(pluginKey: string, updateOpts?: PluginManagementRepairOptions) {
        updateCalls.push(pluginKey)
        updateOptions.push(updateOpts)
        return { ok: true, diagnostics: [] }
      },
      async uninstall(pluginKey: string) {
        uninstallCalls.push(pluginKey)
        if (options.uninstallError) throw options.uninstallError
      },
      async refresh() { return { installed: [], diagnostics: [] } },
    },
    workspaceService: {
      listResolved() {
        return [
          { id: 'workspace-1' },
          { id: 'workspace-2' },
        ]
      },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerPluginsHandlers(server, deps)
  return { handlers }
}

function ctx(workspaceId: string | null): RequestContext {
  return { clientId: 'client-1', workspaceId, webContentsId: 1 }
}
