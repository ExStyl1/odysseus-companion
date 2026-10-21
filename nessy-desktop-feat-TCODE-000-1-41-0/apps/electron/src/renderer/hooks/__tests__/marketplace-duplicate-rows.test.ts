/**
 * F2 — the browse list stops showing the duplicates.
 *
 * The count arm runs against a distilled snapshot of the LIVE Skills Market
 * catalog (`/v1/skills`, all 61 pages, 2026-07-31): 6084 rows, 280 of them with
 * no description, and 654 buckets in which a name+description repeats. The
 * fixture keeps the live counts and replaces each description with a sha1
 * prefix, because only description EQUALITY reaches the collapse rule.
 *
 * The wiring arm exists because the helper being right proves nothing about the
 * browse list: `useMarketplaceItems` is what `PluginsPage` renders, and a helper
 * the hook stops calling is invisible to every assertion below it.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  collapseDuplicateCatalogRows,
  marketplaceBrowseRows,
  type SafeMarketplaceCatalogItem,
} from '../useMarketplaceItems.ts'
import type { SafeInstalledPluginSummary } from '@nessy-agent/shared/protocol/capabilities'

interface DuplicateRowsFixture {
  totalRows: number
  rowsWithoutDescription: number
  singletonBuckets: number
  /** `[name, descriptionDigest, rowCount]` for every repeated name+description. */
  duplicateBuckets: [string, string, number][]
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('./fixtures/skills-market-duplicate-rows.json', import.meta.url)),
  'utf8',
)) as DuplicateRowsFixture

const hookSource = readFileSync(
  fileURLToPath(new URL('../useMarketplaceItems.ts', import.meta.url)),
  'utf8',
)

describe('collapseDuplicateCatalogRows against the live Skills Market catalog', () => {
  it('collapses the 1373 duplicate rows the live catalog carries and keeps every distinguishable one', () => {
    const rows = liveCatalogRows()
    expect(rows).toHaveLength(fixture.totalRows)
    expect(fixture.totalRows).toBe(6084)

    const collapsed = collapseDuplicateCatalogRows(rows)

    const removed = fixture.duplicateBuckets.reduce((count, [, , rowCount]) => count + rowCount - 1, 0)
    expect(removed).toBe(1373)
    expect(collapsed).toHaveLength(fixture.totalRows - removed)
    expect(collapsed).toHaveLength(4711)
    // Every bucket keeps exactly one row, and no bucket is emptied.
    expect(new Set(collapsed.map(row => row.id)).size).toBe(collapsed.length)
    expect(collapsed.filter(row => !row.description).length).toBe(fixture.rowsWithoutDescription)
  })

  it('never collapses a row that has no description, and never merges two descriptions of one name', () => {
    const rows = [
      row({ id: 'a', name: 'access', description: '' }),
      row({ id: 'b', name: 'access', description: '' }),
      row({ id: 'c', name: 'access', description: 'reads the roster' }),
      row({ id: 'd', name: 'access', description: 'writes the roster' }),
      row({ id: 'e', name: 'access', description: 'reads the roster' }),
    ]
    expect(collapseDuplicateCatalogRows(rows).map(item => item.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps rows apart across marketplaces, lists and versions', () => {
    const rows = [
      row({ id: '1', marketplaceId: 'skills-market' }),
      row({ id: '2', marketplaceId: 'registry-a' }),
      row({ id: '3', listKind: 'plugins' }),
      row({ id: '4', version: '1.0.0' }),
      row({ id: '5', version: '2.0.0' }),
      row({ id: '6' }),
    ]
    expect(collapseDuplicateCatalogRows(rows).map(item => item.id)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('lets an installed duplicate take over its bucket in place', () => {
    const installed = safeInstalled('listing-second')
    const rows = [
      row({ id: 'listing-first' }),
      row({ id: 'listing-second', installed }),
      row({ id: 'other', name: 'other' }),
    ]
    const collapsed = collapseDuplicateCatalogRows(rows)

    expect(collapsed.map(item => item.id)).toEqual(['listing-second', 'other'])
    expect(collapsed[0]?.installed).toBe(installed)
  })
})

describe('the browse list the hook returns', () => {
  it('collapses duplicates for browse while the installed strip still joins the uncollapsed catalog', () => {
    const installed = safeInstalled('listing-second')
    const catalog = [row({ id: 'listing-first' }), row({ id: 'listing-second' })]

    const { items, installedItems } = marketplaceBrowseRows(catalog, [installed])

    expect(items.map(item => item.id)).toEqual(['listing-second'])
    expect(items[0]?.installed).toBe(installed)
    // The installed row joined its OWN catalog row, not the survivor's.
    expect(installedItems).toHaveLength(1)
    expect(installedItems[0]?.id).toBe('listing-second')
  })

  it('is what useMarketplaceItems returns as items/visible — not the raw catalog pages', () => {
    const body = hookSource.slice(
      hookSource.indexOf('export function useMarketplaceItems'),
      hookSource.indexOf('export function nextMarketplacePage'),
    )
    expect(body).toContain('marketplaceBrowseRows(catalogItems, statusQuery.data?.installedPlugins ?? [])')
    expect(body).toContain('items: rows.items,')
    expect(body).toContain('visible: rows.items.length,')
    // The pre-fix pipeline handed the raw flattened pages straight to the page.
    expect(body).not.toContain('items: catalogItems')
    expect(body).not.toContain('visible: catalogItems.length')
  })
})

/** Rebuild the live catalog's collapse-relevant shape from the snapshot. */
function liveCatalogRows(): SafeMarketplaceCatalogItem[] {
  const rows: SafeMarketplaceCatalogItem[] = []
  for (const [name, digest, count] of fixture.duplicateBuckets) {
    for (let index = 0; index < count; index += 1) {
      rows.push(row({ id: `dup-${rows.length}`, name, description: digest }))
    }
  }
  for (let index = 0; index < fixture.singletonBuckets; index += 1) {
    rows.push(row({ id: `single-${index}`, name: `skill-${index}`, description: `description-${index}` }))
  }
  for (let index = 0; index < fixture.rowsWithoutDescription; index += 1) {
    rows.push(row({ id: `bare-${index}`, name: `bare-${index % 7}`, description: '' }))
  }
  return rows
}

function row(overrides: Partial<SafeMarketplaceCatalogItem> = {}): SafeMarketplaceCatalogItem {
  const { description, ...rest } = overrides
  return {
    marketplaceId: 'skills-market',
    id: 'listing',
    kind: 'skill',
    listKind: 'skills',
    name: 'acceptance-criteria',
    ...(description === undefined
      ? { description: 'Write acceptance criteria for a user story.' }
      : description
        ? { description }
        : {}),
    icon: { kind: 'symbol', name: 'skill' },
    capabilities: ['skill'],
    install: { sourceConfidence: 'primary' },
    ...rest,
  }
}

function safeInstalled(listingId: string): SafeInstalledPluginSummary {
  return {
    pluginKey: 'skills-market/acceptance-criteria',
    activeInstanceId: 'plugin://skills-market/acceptance-criteria@1.0.0',
    origin: { marketplaceId: 'skills-market', pluginId: 'acceptance-criteria', listingId },
    name: 'acceptance-criteria',
    version: '1.0.0',
    installedAt: 1,
    lifecycleState: 'ready',
    capabilityKinds: ['skill'],
    activation: { effective: 'active', global: 'unset', workspace: 'unset' },
    actions: { canEnable: true, canDisable: true, canUpdate: false, canRepair: true, canUninstall: true, reasonCodes: [] },
  }
}
