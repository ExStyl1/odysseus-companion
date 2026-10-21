/**
 * F1 — the tenant filter reaches the browse UI.
 *
 * `8319630c` corrected the parameters `/v1/skills` actually honours (plain
 * `tenant=`, not the bracketed `tenant[]=` the server silently ignores) and
 * added `getMarketplaceSkillFacets`. Neither reached a control: measured on
 * HEAD before this row, `grep -a` for "facet" across the whole renderer
 * returned ZERO hits and `PluginsPage`'s query context was built from
 * kind/query/sort/workspaceId/sessionId only, so the corrected parameter was
 * unobservable.
 *
 * Live measurements this suite is pinned to (2026-08-01, anonymous, the same
 * rig and the same minute):
 *
 * | request | `x-total-count` |
 * |---|---|
 * | `/v1/skills` | 6084 |
 * | `/v1/skills?tenant=escape-tools` | 139 |
 * | `/v1/skills?tenant=ads` | 23 |
 * | `/v1/skills?tenant=not-a-real-tenant` | **0** |
 *
 * The last row is the hazard: an out-of-vocabulary value does not fail, it
 * returns an empty list where 6084 rows used to be. The control is therefore
 * populated from the tenants the loaded rows themselves carry — every option
 * provably has at least one row — and `browseTenantFilter` is the guard that
 * refuses anything else.
 *
 * `/v1/skills/facets` publishes the FULL vocabulary (457 tenants / 1354 tags /
 * 10 professions) and it is still not reachable from the renderer: it has no
 * channel, no safe result type, no service method, no RPC handler and no
 * preload bridge. The fixture records what the row-derived vocabulary costs
 * against it, so the gap is a number rather than a shrug.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  browseTenantFilter,
  catalogTenants,
  marketplaceListRequest,
  mergeTenantVocabulary,
  type SafeMarketplaceCatalogItem,
} from '../../hooks/useMarketplaceItems.ts'

mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

interface TenantFacetsFixture {
  pageRows: number
  rowTenants: string[]
  distinctTenantsOnPage1: string[]
  facetTenants: number
  catalogSkills: number
  skillsCoveredByPage1Vocabulary: number
  measuredNarrowing: Record<string, number>
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../hooks/__tests__/fixtures/skills-market-tenant-facets.json', import.meta.url)),
  'utf8',
)) as TenantFacetsFixture

const pageSource = readFileSync(fileURLToPath(new URL('../PluginsPage.tsx', import.meta.url)), 'utf8')
const hookSource = readFileSync(
  fileURLToPath(new URL('../../hooks/useMarketplaceItems.ts', import.meta.url)),
  'utf8',
)

function rowsFor(tenants: readonly string[]): SafeMarketplaceCatalogItem[] {
  return tenants.map((tenant, index) => ({
    marketplaceId: 'skills-market',
    id: `skill-${index}`,
    kind: 'skill',
    listKind: 'skills',
    name: `skill-${index}`,
    icon: { kind: 'symbol', name: 'skill' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    ...(tenant ? { tenant } : {}),
  }))
}

describe('F1 — the vocabulary the control offers', () => {
  it('is exactly the tenants the loaded rows carry, on the real first page', () => {
    const rows = rowsFor(fixture.rowTenants)
    expect(rows).toHaveLength(fixture.pageRows)
    expect(fixture.pageRows).toBe(100)

    const vocabulary = catalogTenants(rows)

    // Measured: page one of the live catalog carries 52 of the 457 tenants
    // `/v1/skills/facets` publishes. That is the recorded cost of deriving the
    // vocabulary from rows instead of from the facets endpoint.
    expect(vocabulary).toEqual(fixture.distinctTenantsOnPage1)
    expect(vocabulary).toHaveLength(52)
    expect(fixture.facetTenants).toBe(457)
    expect(fixture.skillsCoveredByPage1Vocabulary).toBe(1316)
  })

  it('ignores rows with no tenant and never offers a duplicate', () => {
    const vocabulary = catalogTenants(rowsFor(['ads', '', 'ads', '  ', 'escape-tools']))
    expect(vocabulary).toEqual(['ads', 'escape-tools'])
  })

  it('only grows, so selecting a tenant cannot strand the user inside the filter', () => {
    const browsing = mergeTenantVocabulary([], catalogTenants(rowsFor(['ads', 'escape-tools', 'coin'])))
    expect(browsing).toEqual(['ads', 'coin', 'escape-tools'])

    // What the server returns once `tenant=ads` is on the wire: only ads rows.
    // A vocabulary recomputed from those rows would collapse to ['ads'] and the
    // user could never reach another tenant without clearing the filter.
    const filtered = mergeTenantVocabulary(browsing, catalogTenants(rowsFor(['ads', 'ads'])))
    expect(filtered).toEqual(['ads', 'coin', 'escape-tools'])
    expect(filtered).toBe(browsing)

    const nextPage = mergeTenantVocabulary(filtered, ['nestor'])
    expect(nextPage).toEqual(['ads', 'coin', 'escape-tools', 'nestor'])
  })
})

describe('F1 — a selection narrows the list, an unknown value cannot be made', () => {
  it('puts the selected tenant on the wire as the parameter the market honours', () => {
    const request = marketplaceListRequest({ kind: 'skills', sort: 'installs', tenants: ['ads'] }, 1)

    expect(request.tenants).toEqual(['ads'])
    expect(request.kind).toBe('skills')
    // The narrowing this parameter buys, measured live: 6084 -> 23 rows.
    expect(fixture.measuredNarrowing.ads).toBe(23)
    expect(fixture.catalogSkills).toBe(6084)
  })

  it('omits the parameter entirely when nothing is selected', () => {
    const request = marketplaceListRequest({ kind: 'skills', sort: 'installs' }, 1)
    expect('tenants' in request).toBe(false)
  })

  it('refuses a tenant the vocabulary does not carry — the 0-row selection', () => {
    const vocabulary = ['ads', 'escape-tools']

    expect(browseTenantFilter('escape-tools', vocabulary)).toBe('escape-tools')
    expect(browseTenantFilter('not-a-real-tenant', vocabulary)).toBeUndefined()
    expect(browseTenantFilter(null, vocabulary)).toBeUndefined()
    // Positive control for the refusal: the same guard accepts the same string
    // as soon as a loaded row carries it.
    expect(browseTenantFilter('not-a-real-tenant', ['not-a-real-tenant'])).toBe('not-a-real-tenant')
    expect(fixture.measuredNarrowing['not-a-real-tenant']).toBe(0)
  })
})

describe('F1 — an empty result explains itself', () => {
  it('reads as "no results" under a filter, not as the pre-search prompt', async () => {
    const { browseEmptyMessageKey } = await import('@/pages/PluginsPage')

    expect(browseEmptyMessageKey({ tenant: 'ads' })).toBe('plugins.noResults')
    expect(browseEmptyMessageKey({ query: 'figma' })).toBe('plugins.noResults')
    expect(browseEmptyMessageKey({ query: '   ', tenant: null })).toBe('plugins.emptySearch')
    expect(browseEmptyMessageKey({})).toBe('plugins.emptySearch')
  })
})

describe('F1 — the wiring the helpers cannot see', () => {
  it('the browse query context carries the selected tenant', () => {
    const start = pageSource.indexOf('const queryContext = useMemo<MarketplaceItemsQueryContext>')
    const end = pageSource.indexOf('const marketplace = useMarketplaceItems', start)
    expect(start).toBeGreaterThan(-1)
    const context = pageSource.slice(start, end)
    expect(context).toContain('...(activeTenant ? { tenants: [activeTenant] } : {})')
  })

  it('the control is populated from the vocabulary and its selection goes through the guard', () => {
    const start = pageSource.indexOf('<TenantMenu')
    const end = pageSource.indexOf('/>', start)
    expect(start).toBeGreaterThan(-1)
    const control = pageSource.slice(start, end)
    expect(control).toContain('vocabulary={tenantVocabulary}')
    expect(control).toContain('browseTenantFilter(tenant, tenantVocabulary)')
    // The regression this row exists for: a hardcoded or invented option list.
    // Every rendered option must come from `tenantVocabulary`.
    const menu = pageSource.slice(pageSource.indexOf('function TenantMenu'), pageSource.indexOf('function CreateMenu'))
    expect(menu).toContain('vocabulary.map(tenant =>')
    expect(menu).not.toMatch(/const\s+\w*TENANTS\w*\s*=/)
  })

  it('the empty state and the page request both route through the exported decisions', () => {
    expect(pageSource).toContain('emptyMessage={t(browseEmptyMessageKey({ query: debouncedQuery, tenant: activeTenant }))}')
    expect(hookSource).toContain('window.electronAPI.marketplace.list(marketplaceListRequest(normalized, pageParam))')
  })
})
