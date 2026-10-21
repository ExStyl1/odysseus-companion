import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  MARKETPLACE_PENDING_POLL_MS,
  enrichCatalogWithInstalledInventory,
  joinInstalledInventory,
  marketplaceListingIdentity,
  marketplacePendingPollInterval,
  nextMarketplacePage,
  type SafeMarketplaceCatalogItem,
} from '../useMarketplaceItems.ts'
import type {
  SafeInstalledPluginSummary,
  SafeMarketplaceListResult,
} from '@nessy-agent/shared/protocol/capabilities'

describe('joinInstalledInventory', () => {
  it('includes safe installed rows missing from the current catalog page', () => {
    const installed = safeInstalled({ listingId: 'missing-from-page' })
    const result = joinInstalledInventory([installed], [catalogItem({ id: 'other' })])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(expect.objectContaining({
      id: 'missing-from-page',
      name: 'Hooks',
      installed,
    }))
    expect(JSON.stringify(result[0])).not.toContain('enabledScopes')
    expect(JSON.stringify(result[0])).not.toContain('workspaceRoot')
  })

  it('joins by stable listing id and preserves context activation from the safe view', () => {
    const installed = safeInstalled({ listingId: 'listing-1', marketplaceId: 'skills-market', workspace: 'enabled' })
    const result = joinInstalledInventory([installed], [catalogItem({ id: 'listing-1' })])
    expect(result[0]?.installed?.activation.workspace).toBe('enabled')
  })

  it('does not join equal listing ids across marketplaces', () => {
    const installed = safeInstalled({ listingId: 'shared', marketplaceId: 'registry-a' })
    const wrong = catalogItem({ marketplaceId: 'registry-b', id: 'shared', name: 'Wrong' })
    const right = catalogItem({ marketplaceId: 'registry-a', id: 'shared', name: 'Right' })

    expect(joinInstalledInventory([installed], [wrong, right])[0]?.name).toBe('Right')
    expect(marketplaceListingIdentity(wrong)).not.toBe(marketplaceListingIdentity(right))
  })

  it('surfaces the installed plugin presentation (A9) untouched through the join, matched or synthetic', () => {
    const presentation = { format: 'codex' as const, acquisition: 'nessy-marketplace' as const }
    const matched = joinInstalledInventory(
      [safeInstalled({ listingId: 'listing-1', presentation })],
      [catalogItem({ id: 'listing-1' })],
    )
    expect(matched[0]?.installed?.presentation).toEqual(presentation)

    const synthetic = joinInstalledInventory([safeInstalled({ listingId: 'missing-from-page', presentation })], [])
    expect(synthetic[0]?.installed?.presentation).toEqual(presentation)
  })
})

describe('enrichCatalogWithInstalledInventory', () => {
  it('carries installed state onto a matching browse row', () => {
    const installed = safeInstalled({ listingId: 'listing-1', marketplaceId: 'skills-market' })
    const catalog = [catalogItem({ id: 'listing-1' })]
    const result = enrichCatalogWithInstalledInventory(catalog, joinInstalledInventory([installed], catalog))

    expect(result[0]?.installed).toBe(installed)
  })

  it('leaves unmatched browse rows unchanged', () => {
    const catalog = catalogItem({ id: 'other' })
    const result = enrichCatalogWithInstalledInventory([catalog], joinInstalledInventory([safeInstalled({ listingId: 'listing-1' })], [catalog]))

    expect(result).toEqual([catalog])
    expect(result[0]?.installed).toBeUndefined()
  })

  it('does not add synthetic installed-only rows to the browse catalog', () => {
    const result = enrichCatalogWithInstalledInventory([], joinInstalledInventory([safeInstalled({ listingId: 'missing' })], []))

    expect(result).toEqual([])
  })
})

describe('nextMarketplacePage', () => {
  it('does not paginate again just because page one also carries a large external registry', () => {
    const external = Array.from({ length: 180 }, (_, index) => catalogItem({
      marketplaceId: 'registry-1',
      id: `registry-1:plugin-${index}`,
    }))

    expect(nextMarketplacePage({
      items: [catalogItem({ marketplaceId: 'skills-market' }), ...external],
      page: 1,
      pageSize: 100,
      total: 181,
      visible: 181,
    })).toBeUndefined()
  })

  it('keeps the server-provided built-in continuation when one exists', () => {
    expect(nextMarketplacePage({
      items: [],
      page: 1,
      pageSize: 100,
      total: 200,
      visible: 0,
      nextPage: 2,
    })).toBe(2)
  })
})

describe('a registry whose catalog is still landing gets asked again', () => {
  // The live defect: on the first browse after a marketplace is added — or after
  // any change that invalidates the on-disk catalogs (the
  // CATALOG_CACHE_SCHEMA_VERSION 1 -> 2 bump) — every registry answers
  // `fetch_pending`, react-query settles that page as a SUCCESS, and the browse
  // list keeps the zero-registry-row snapshot until the app restarts. Measured
  // live: 0 cards against 2777 rows the same RPC was already merging.
  const page = (overrides: Partial<SafeMarketplaceListResult> = {}): SafeMarketplaceListResult => ({
    items: [],
    page: 1,
    pageSize: 100,
    total: 0,
    visible: 0,
    ...overrides,
  })
  const infinite = (...pages: SafeMarketplaceListResult[]) => ({ pages, pageParams: pages.map((_, index) => index + 1) })

  it('polls while any registry rides the transient pending marker', () => {
    expect(marketplacePendingPollInterval(infinite(page({
      registryLoadErrors: [
        { marketplaceId: 'registry-a', displayName: 'openai/plugins', diagnosticCodes: ['marketplace.registry.fetch_pending'] },
      ],
    })))).toBe(MARKETPLACE_PENDING_POLL_MS)
  })

  it('keeps polling when page ONE is still pending and a later page has settled', () => {
    // The live race this rule exists for: a refetch re-runs the pages in order,
    // so page 2 can carry a newer snapshot than page 1 — and page 1 is the only
    // page registry rows are merged into. Stopping on the last page's clean
    // marker strands page 1 without its rows permanently (measured: 75 s at 0
    // cards on a cold boot, poll already stopped).
    const pending = page({
      registryLoadErrors: [
        { marketplaceId: 'registry-a', diagnosticCodes: ['marketplace.registry.fetch_pending'] },
      ],
    })
    expect(marketplacePendingPollInterval(infinite(pending, page({ page: 2 })))).toBe(MARKETPLACE_PENDING_POLL_MS)
    expect(marketplacePendingPollInterval(infinite(page(), pending))).toBe(MARKETPLACE_PENDING_POLL_MS)
  })

  it('stops for a settled list, for a genuinely broken registry, and before the first page', () => {
    expect(marketplacePendingPollInterval(infinite(page()))).toBe(false)
    expect(marketplacePendingPollInterval(infinite(page({
      registryLoadErrors: [
        { marketplaceId: 'registry-a', diagnosticCodes: ['marketplace.registry.fetch_failed'] },
        { marketplaceId: 'registry-b', diagnosticCodes: ['marketplace.registry.fetch_timeout'] },
      ],
    })))).toBe(false)
    expect(marketplacePendingPollInterval(undefined)).toBe(false)
  })

  it('is wired into the browse query (the poll that did not exist)', () => {
    const source = readFileSync(new URL('../useMarketplaceItems.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/refetchInterval:\s*\(\{ state \}\) => marketplacePendingPollInterval\(state\.data\)/)
  })
})

describe('a marketplace rename does not orphan what is installed (C3)', () => {
  // The row keeps its CURRENT id; `formerIds` is what the installed record was
  // stored under before the marketplace renamed the entry.
  const renamedRow = catalogItem({
    marketplaceId: 'registry-community',
    id: 'registry-community:qodo',
    name: 'qodo',
    formerIds: ['registry-community:qodo-skills'],
  })

  it('recognises a plugin installed under the former name, in both join directions', () => {
    const installed = safeInstalled({
      marketplaceId: 'registry-community',
      listingId: 'registry-community:qodo-skills',
    })

    const inventory = joinInstalledInventory([installed], [renamedRow])
    // The CURRENT id proves the catalog row was found; a failed join would have
    // produced a synthetic row carrying the stored former id instead.
    expect(inventory[0]?.id).toBe('registry-community:qodo')
    expect(inventory[0]?.installed).toBe(installed)

    // ...and the browse card shows as installed, which is what lets the user
    // uninstall it.
    expect(enrichCatalogWithInstalledInventory([renamedRow], inventory)[0]?.installed).toBe(installed)
  })

  it('does not join a plugin the marketplace REMOVED rather than renamed', () => {
    // A `renames` value of `null` is a removal, so no surviving row carries the
    // name — `formerIds` never mentions it and nothing can match it.
    const installed = safeInstalled({
      marketplaceId: 'registry-community',
      listingId: 'registry-community:legacy-linter',
    })

    const inventory = joinInstalledInventory([installed], [renamedRow])
    expect(inventory[0]?.id).toBe('registry-community:legacy-linter')
    expect(inventory[0]?.install.sourceConfidence).toBe('missing')
    expect(enrichCatalogWithInstalledInventory([renamedRow], inventory)[0]?.installed).toBeUndefined()
  })

  it('never lets one marketplace\'s former name reach another marketplace\'s record', () => {
    const installed = safeInstalled({
      marketplaceId: 'registry-other',
      listingId: 'registry-community:qodo-skills',
    })

    expect(joinInstalledInventory([installed], [renamedRow])[0]?.id)
      .toBe('registry-community:qodo-skills')
    expect(enrichCatalogWithInstalledInventory([renamedRow], [])[0]?.installed).toBeUndefined()
  })

  it('still refuses to join on the name alone, which is what `formerIds` exists to avoid', () => {
    // A name-only fallback was checked and refused: it fires across unrelated
    // plugins. This row shares the installed record's NAME and its marketplace
    // and matches on no id at all — the one case where a name fallback would
    // silently produce a wrong join.
    const installed = safeInstalled({ marketplaceId: 'registry-community', listingId: 'registry-community:unrelated' })
    const sameName = catalogItem({
      marketplaceId: 'registry-community',
      id: 'registry-community:qodo',
      name: installed.name,
      formerIds: ['registry-community:qodo-skills'],
    })

    expect(joinInstalledInventory([installed], [sameName])[0]?.id).toBe('registry-community:unrelated')
    expect(enrichCatalogWithInstalledInventory([sameName], [])[0]?.installed).toBeUndefined()
  })

  it('leaves a row with no rename history joining exactly as before', () => {
    const installed = safeInstalled({ marketplaceId: 'skills-market', listingId: 'listing-1' })
    expect(joinInstalledInventory([installed], [catalogItem({ id: 'listing-1' })])[0]?.installed).toBe(installed)
    expect(joinInstalledInventory([installed], [catalogItem({ id: 'listing-2' })])[0]?.id).toBe('listing-1')
  })
})

function safeInstalled(overrides: {
  listingId?: string
  marketplaceId?: string
  workspace?: 'enabled' | 'disabled' | 'unset'
  presentation?: SafeInstalledPluginSummary['presentation']
} = {}): SafeInstalledPluginSummary {
  return {
    pluginKey: 'internal/hooks',
    activeInstanceId: 'plugin://internal/hooks@1.0.0',
    origin: { marketplaceId: overrides.marketplaceId ?? 'internal', pluginId: 'hooks', ...(overrides.listingId ? { listingId: overrides.listingId } : {}) },
    ...(overrides.presentation ? { presentation: overrides.presentation } : {}),
    name: 'Hooks',
    version: '1.0.0',
    installedAt: 1,
    lifecycleState: 'ready',
    capabilityKinds: ['hook'],
    activation: { effective: 'active', global: 'unset', workspace: overrides.workspace ?? 'unset' },
    actions: { canEnable: true, canDisable: true, canUpdate: false, canRepair: true, canUninstall: true, reasonCodes: [] },
  }
}

function catalogItem(overrides: Partial<SafeMarketplaceCatalogItem> = {}): SafeMarketplaceCatalogItem {
  return {
    marketplaceId: 'skills-market',
    id: 'catalog-item',
    kind: 'plugin',
    listKind: 'plugins',
    name: 'Catalog item',
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'missing' },
    ...overrides,
  }
}
