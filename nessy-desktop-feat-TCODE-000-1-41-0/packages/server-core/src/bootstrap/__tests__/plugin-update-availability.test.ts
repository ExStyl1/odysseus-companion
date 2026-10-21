/**
 * R81 — `availableUpdateVersion` finally has a producer.
 *
 * `plugins/loading.md#which-marketplaces-and-plugins-auto-update` — "Claude Code can automatically update marketplaces
 * and their installed plugins in the background after startup. When auto-update
 * is enabled for a marketplace, Claude Code refreshes the marketplace data and
 * updates installed plugins to their latest versions on disk."
 *
 * R63 shipped the marketplace refresh and R72 the bundle re-materialization.
 * Until this row, nothing produced the field the wire protocol has carried the
 * whole time, so `actions.canUpdate` was a constant `false` and a user was never
 * told an update existed — least of all for a marketplace with auto-update off,
 * which `:454` makes the default for "Third-party and local development
 * marketplaces" and where the background pass will never act at all.
 *
 * The perf shape is the other half of the row and it is asserted here too: this
 * function runs once per turn, so the reader is CACHED-ONLY by contract and is
 * not consulted at all when there is no plugin to ask about.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toUserCatalog } from '@nessy-agent/shared/capabilities/views'
import type { MarketplaceCatalogItem } from '@nessy-agent/shared/marketplace'
import type { PluginDependencyDescriptor } from '@nessy-agent/shared/plugins'
import { type PluginInstalledEntryV2, type PluginStoreV2 } from '@nessy-agent/shared/plugins'
import {
  buildCapabilityResolutionInputsV2,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

const BUNDLE_HASH = 'c'.repeat(64)

let root: string
let workspaceRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-update-availability-'))
  workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function entryFor(options: {
  name: string
  version?: string
  itemId?: string
  dependencies?: PluginDependencyDescriptor[]
}): PluginInstalledEntryV2 {
  const version = options.version ?? '1.0.0'
  return {
    pluginInstanceId: `plugin://acme-tools/${options.name}@${version}#${BUNDLE_HASH}`,
    // Path-free by construction — `encodePluginStorageKey` refuses a `/`.
    pluginKey: `pk-${options.name}`,
    marketplaceId: 'acme-tools',
    pluginId: options.name,
    version,
    bundleHash: BUNDLE_HASH,
    cacheRef: { marketplaceId: 'acme-tools', pluginId: options.name, version, bundleHash: BUNDLE_HASH },
    manifest: {
      schemaVersion: 1,
      kind: 'plugin',
      id: options.name,
      name: options.name,
      version,
      capabilities: [],
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    },
    origin: {
      source: 'marketplace',
      marketplaceId: 'acme-tools',
      resolvedAt: 1,
      ...(options.itemId ? { provenance: { itemId: options.itemId } } : {}),
    },
    installedAt: 1,
    diagnostics: [],
  }
}

function catalogItem(name: string, version: string): MarketplaceCatalogItem {
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
  }
}

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws_a',
  projectTrustState: 'none',
  projectTrustRevision: '',
}

function deps(options: {
  entries: PluginInstalledEntryV2[]
  reader?: CapabilityInputsV2Deps['marketplaceCatalogReader']
}): CapabilityInputsV2Deps {
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(root, 'config', 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
  })
  for (const entry of options.entries) policyStore.recordGlobal({ pluginKey: entry.pluginKey, enabled: true })
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
        active: Object.fromEntries(options.entries.map(entry => [entry.pluginKey, entry.pluginInstanceId])),
        plugins: options.entries,
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
    ...(options.reader ? { marketplaceCatalogReader: options.reader } : {}),
  }
}

describe('buildCapabilityResolutionInputsV2 update availability (`plugins/loading.md#which-marketplaces-and-plugins-auto-update`)', () => {
  it('stamps the catalog version when the marketplace is ahead, and `canUpdate` follows it', async () => {
    const entry = entryFor({ name: 'deploy-kit', version: '1.0.0', itemId: 'acme-tools:deploy-kit' })
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [entry],
      reader: { peekCachedItems: async () => [catalogItem('deploy-kit', '2.0.0')] },
    }))

    expect(inputs.installedPlugins[0]?.availableUpdateVersion).toBe('2.0.0')

    // End to end, because the field's whole purpose is the action derived from
    // it — `views.ts` reads `!!plugin.availableUpdateVersion`.
    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(CONTEXT)
    try {
      const plugin = toUserCatalog(snapshot).installedPlugins[0]
      expect(plugin?.availableUpdateVersion).toBe('2.0.0')
      expect(plugin?.actions.canUpdate).toBe(true)
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('stays silent when the catalog is level — and `canUpdate` is the pre-R81 false', async () => {
    const entry = entryFor({ name: 'deploy-kit', version: '2.0.0', itemId: 'acme-tools:deploy-kit' })
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [entry],
      reader: { peekCachedItems: async () => [catalogItem('deploy-kit', '2.0.0')] },
    }))

    expect(inputs.installedPlugins[0]?.availableUpdateVersion).toBeUndefined()

    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(CONTEXT)
    try {
      expect(toUserCatalog(snapshot).installedPlugins[0]?.actions.canUpdate).toBe(false)
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('stamps the unorderable-version verdict end to end, and canUpdate stays false (P2.159)', async () => {
    // The measured shape: the official `claude-security` bundle declares a
    // FOUR-part `0.10.2.3`. `canUpdate` is false here exactly as in the level
    // case above, and until this carry existed nothing downstream could tell the
    // two apart — so the row read as "up to date" forever.
    const entry = entryFor({ name: 'claude-security', version: '0.10.0', itemId: 'acme-tools:claude-security' })
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [entry],
      reader: { peekCachedItems: async () => [catalogItem('claude-security', '0.10.2.3')] },
    }))

    expect(inputs.installedPlugins[0]?.availableUpdateVersion).toBeUndefined()
    expect(inputs.installedPlugins[0]?.updateVersionUncomparable).toBe(true)

    const resolver = createCapabilityResolver({ inputs: () => inputs })
    const snapshot = await resolver.resolve(CONTEXT)
    try {
      const plugin = toUserCatalog(snapshot).installedPlugins[0]
      expect(plugin?.actions.canUpdate).toBe(false)
      expect(plugin?.actions.reasonCodes).toEqual(['update-version-uncomparable'])
    } finally {
      resolver.releaseSnapshot(snapshot.leaseId)
    }
  })

  it('leaves the field unset for an orderable catalog — the boundary for the carry', async () => {
    // POSITIVE CONTROL for the stamp above: same wiring, orderable versions.
    // Without it, a stamp that fired unconditionally would pass the case above.
    const entry = entryFor({ name: 'deploy-kit', version: '1.0.0', itemId: 'acme-tools:deploy-kit' })
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [entry],
      reader: { peekCachedItems: async () => [catalogItem('deploy-kit', '2.0.0')] },
    }))

    expect(inputs.installedPlugins[0]?.availableUpdateVersion).toBe('2.0.0')
    expect(inputs.installedPlugins[0]?.updateVersionUncomparable).toBeUndefined()
  })

  it('withholds a version a dependent holds back (`plugins/host-marketplace.md#hold-users-on-one-version`)', async () => {
    // The dependent pins `=2.1.0`, so `updateInstalledBundles` will never move
    // vault to 3.0.0. A badge promising it would be a control that does nothing.
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [
        entryFor({ name: 'plugin-a', dependencies: [{ name: 'vault', version: '=2.1.0' }] }),
        entryFor({ name: 'vault', version: '2.1.0' }),
      ],
      reader: { peekCachedItems: async () => [catalogItem('vault', '3.0.0')] },
    }))

    const vault = inputs.installedPlugins.find(plugin => plugin.pluginId === 'vault')
    expect(vault?.availableUpdateVersion).toBeUndefined()

    // POSITIVE CONTROL — same catalog, same vault, dependent removed. Without
    // it the absence above could just as well be a failed catalog join.
    const freed = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [entryFor({ name: 'vault', version: '2.1.0' })],
      reader: { peekCachedItems: async () => [catalogItem('vault', '3.0.0')] },
    }))
    expect(freed.installedPlugins[0]?.availableUpdateVersion).toBe('3.0.0')
  })

  it('does not consult the reader at all when nothing is installed', async () => {
    // The per-turn cost gate. With no active plugin there is no question to ask,
    // and the overwhelmingly common install pays nothing for this every turn.
    let peeks = 0
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [],
      reader: { peekCachedItems: async () => { peeks += 1; return [] } },
    }))

    expect(inputs.installedPlugins).toEqual([])
    expect(peeks).toBe(0)
  })

  it('leaves the field absent with no reader wired — every pre-R81 caller is unchanged', async () => {
    const entry = entryFor({ name: 'deploy-kit', version: '1.0.0', itemId: 'acme-tools:deploy-kit' })
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({ entries: [entry] }))
    // "every pre-R81 caller is unchanged" is a claim about a caller that still
    // gets its row, not about an empty list.
    expect(inputs.installedPlugins).toHaveLength(1)
    expect(inputs.installedPlugins[0]?.availableUpdateVersion).toBeUndefined()
  })

  it('survives a reader that throws — a missing badge, never a dead turn', async () => {
    const entry = entryFor({ name: 'deploy-kit', version: '1.0.0', itemId: 'acme-tools:deploy-kit' })
    const inputs = await buildCapabilityResolutionInputsV2(CONTEXT, deps({
      entries: [entry],
      reader: { peekCachedItems: async () => { throw new Error('catalog cache unreadable') } },
    }))

    expect(inputs.installedPlugins).toHaveLength(1)
    expect(inputs.installedPlugins[0]?.availableUpdateVersion).toBeUndefined()
  })
})
