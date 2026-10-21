/**
 * Marketplace-first browse navigation + lightweight list virtualization.
 *
 * This file is deliberately SEPARATE from MarketplaceComponents.test.tsx: that
 * suite imports MarketplaceDetail → CapabilityContentPanel → Info_Markdown,
 * whose pdfjs-dist worker URL bun cannot resolve in isolation (a pre-existing
 * environmental failure). MarketplaceBrowsePage + the pure filter/pagination
 * helpers have no such dependency, so these tests actually run.
 *
 * The selector + kind-tab rows are asserted via renderToStaticMarkup (the house
 * style — there is no DOM test tooling in this package); the marketplace-first
 * selection / kind-availability / render-window / remove-fallback behaviour is
 * proven against the pure helpers PluginsPage drives.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'

import { MarketplaceBrowsePage, type MarketplaceBrowseSection } from '@/components/marketplace/MarketplaceBrowsePage'
import {
  BUILT_IN_MARKETPLACE_FILTER_ID,
  browseSelectionForInstallLink,
  buildMarketplaceFilterOptions,
  capListForRender,
  filterItemsForMarketplace,
  pinSuggestedItems,
  isBuiltInMarketplace,
  marketplaceKindAvailability,
  nextMarketplaceFilterAfterRemove,
  shouldShowMarketplaceFilter,
} from '@/pages/plugin-marketplace-filter'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

const tile = <span>icon</span>

// A minimal browse row shape for the pure filter/pagination helpers.
type Row = { id: string; marketplaceId?: string; listKind?: 'plugins' | 'skills' }
const rows: Row[] = [
  { id: 's1', marketplaceId: 'skills-market' },
  { id: 's2', marketplaceId: undefined },
  { id: 's3', marketplaceId: 'internal' },
  { id: 'a1', marketplaceId: 'acme', listKind: 'plugins' },
  { id: 'a2', marketplaceId: 'acme', listKind: 'plugins' },
  { id: 'b1', marketplaceId: 'openai-plugins', listKind: 'plugins' },
]

describe('marketplace selector option builder', () => {
  it('lists Skills Market first, then one chip per registry, and never offers All', () => {
    const options = buildMarketplaceFilterOptions({
      registries: [
        { marketplaceId: 'acme', displayName: 'Acme Registry' },
        { marketplaceId: 'openai-plugins', displayName: 'OpenAI Plugins' },
      ],
      builtInLabel: 'Skills Market',
    })
    expect(options.map(o => o.id)).toEqual([
      BUILT_IN_MARKETPLACE_FILTER_ID,
      'acme',
      'openai-plugins',
    ])
    expect(options.map(o => o.label)).toEqual(['Skills Market', 'Acme Registry', 'OpenAI Plugins'])
    expect(options.map(o => o.kind)).toEqual(['built-in', 'registry', 'registry'])
    // No cross-market "All" entry.
    expect(options.some(o => o.id === 'all')).toBe(false)
  })

  it('de-duplicates registries and never re-emits the reserved built-in ids', () => {
    const options = buildMarketplaceFilterOptions({
      registries: [
        { marketplaceId: 'acme', displayName: 'Acme Registry' },
        { marketplaceId: 'acme', displayName: 'Acme (dupe)' },
        { marketplaceId: 'skills-market', displayName: 'evil shadow' },
        { marketplaceId: 'internal', displayName: 'internal shadow' },
      ],
      builtInLabel: 'Skills Market',
    })
    expect(options.map(o => o.id)).toEqual([BUILT_IN_MARKETPLACE_FILTER_ID, 'acme'])
  })

  it('shows the selector only when at least one registry exists', () => {
    expect(shouldShowMarketplaceFilter(buildMarketplaceFilterOptions({
      registries: [], builtInLabel: 'Skills Market',
    }))).toBe(false)
    expect(shouldShowMarketplaceFilter(buildMarketplaceFilterOptions({
      registries: [{ marketplaceId: 'acme', displayName: 'Acme' }], builtInLabel: 'Skills Market',
    }))).toBe(true)
  })

  // P6.517 / P6.518 — a catalog this build DELIVERS and has not registered.
  it('appends the delivered-but-off offers after the registries, carrying their description', () => {
    const options = buildMarketplaceFilterOptions({
      registries: [{ marketplaceId: 'acme', displayName: 'Acme Registry' }],
      builtInLabel: 'Skills Market',
      offers: [{ name: 'claude-plugins-official', description: 'The official Anthropic plugin marketplace.' }],
    })
    expect(options.map(o => o.id)).toEqual([BUILT_IN_MARKETPLACE_FILTER_ID, 'acme', 'claude-plugins-official'])
    expect(options.map(o => o.kind)).toEqual(['built-in', 'registry', 'offer'])
    // The description is the offer's own — an offer is the one chip whose name
    // alone does not say what the user would be turning on.
    expect(options[2]?.description).toBe('The official Anthropic plugin marketplace.')
  })

  it('drops an offer a registered row already claims, and the row shows for an offer alone', () => {
    // The negative: enabling an offer registers it under its own name, so the
    // same catalog must stop being offered the moment it appears in registries.
    const enabled = buildMarketplaceFilterOptions({
      registries: [{ marketplaceId: 'claude-plugins-official', displayName: 'official' }],
      builtInLabel: 'Skills Market',
      offers: [{ name: 'claude-plugins-official', description: 'The official Anthropic plugin marketplace.' }],
    })
    expect(enabled.map(o => o.kind)).toEqual(['built-in', 'registry'])

    // With no registry at all, an offer is enough to render the row — hiding it
    // would hide the only affordance that turns the catalog on.
    expect(shouldShowMarketplaceFilter(buildMarketplaceFilterOptions({
      registries: [],
      builtInLabel: 'Skills Market',
      offers: [{ name: 'openai-skills', description: 'Reusable skills.' }],
    }))).toBe(true)
  })
})

describe('selecting a marketplace scopes the browse rows', () => {
  it('the built-in bucket matches skills-market / internal / absent ids', () => {
    expect(filterItemsForMarketplace(rows, BUILT_IN_MARKETPLACE_FILTER_ID).map(r => r.id)).toEqual(['s1', 's2', 's3'])
    // isBuiltInMarketplace is the shared predicate behind the bucket.
    expect(isBuiltInMarketplace(undefined)).toBe(true)
    expect(isBuiltInMarketplace('acme')).toBe(false)
  })

  it('a registry narrows the list to exactly that registry', () => {
    expect(filterItemsForMarketplace(rows, 'acme').map(r => r.id)).toEqual(['a1', 'a2'])
    expect(filterItemsForMarketplace(rows, 'openai-plugins').map(r => r.id)).toEqual(['b1'])
  })
})

/**
 * `plugins/org.md#recommend-plugins` — "plugins marked as relevant to your current
 * working directory are pinned at the top with a **suggested for this
 * directory** label."
 */
describe('suggested rows are pinned to the top', () => {
  type PinRow = { id: string; suggestion?: { signal: string } }
  const pinRows: PinRow[] = [
    { id: 'a' },
    { id: 'b', suggestion: { signal: 'cwd' } },
    { id: 'c' },
    { id: 'd', suggestion: { signal: 'cwd' } },
  ]

  it('moves suggested rows to the front and keeps every other order intact', () => {
    expect(pinSuggestedItems(pinRows).map(row => row.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('leaves a list with no suggestion byte-identical', () => {
    const plain: PinRow[] = [{ id: 'a' }, { id: 'b' }]
    expect(pinSuggestedItems(plain).map(row => row.id)).toEqual(['a', 'b'])
  })
})

describe('kind tabs scope to the selected marketplace', () => {
  it('the built-in Skills Market offers both kinds', () => {
    expect(marketplaceKindAvailability(BUILT_IN_MARKETPLACE_FILTER_ID, [])).toEqual({ plugins: true, skills: true })
  })

  it('a registry offers Plugins but not Skills until its rows report a skill', () => {
    // Today registries feed plugins only → Skills tab disabled.
    expect(marketplaceKindAvailability('acme', rows)).toEqual({ plugins: true, skills: false })
    // Data-driven + future-proof: a skill-bearing registry row lights up Skills.
    const withSkill = [...rows, { id: 'a-skill', marketplaceId: 'acme', listKind: 'skills' as const }]
    expect(marketplaceKindAvailability('acme', withSkill)).toEqual({ plugins: true, skills: true })
  })
})

describe('client-side render cap grows on load-more', () => {
  it('caps to the limit and reports more to reveal', () => {
    const first = capListForRender(rows, 4)
    expect(first.visible.map(r => r.id)).toEqual(['s1', 's2', 's3', 'a1'])
    expect(first.hasMoreToReveal).toBe(true)
  })

  it('a grown limit reveals the rest and clears hasMoreToReveal', () => {
    const grown = capListForRender(rows, 4 + 40)
    expect(grown.visible).toHaveLength(rows.length)
    expect(grown.hasMoreToReveal).toBe(false)
  })
})

describe('removing the selected registry falls back to Skills Market', () => {
  it('removing the currently-selected registry resets to the built-in market', () => {
    expect(nextMarketplaceFilterAfterRemove('acme', 'acme')).toBe(BUILT_IN_MARKETPLACE_FILTER_ID)
  })
  it('removing a different registry keeps the current selection', () => {
    expect(nextMarketplaceFilterAfterRemove('acme', 'openai-plugins')).toBe('acme')
  })
})

describe('MarketplaceBrowsePage marketplace selector row', () => {
  const sections: MarketplaceBrowseSection[] = [
    {
      id: 'catalog:plugins',
      title: 'Plugins',
      cards: [{
        id: 'a', icon: tile, name: 'Skill A', installState: 'not-installed',
        installLabel: 'Install', installedLabel: 'Installed', installingLabel: 'Installing…',
      }],
    },
  ]

  function page(active: string) {
    return render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query=""
        searchPlaceholder="Search…"
        sections={sections}
        emptyMessage="No results found"
        marketplaceFilter={{
          active,
          options: [
            { id: BUILT_IN_MARKETPLACE_FILTER_ID, label: 'Skills Market' },
            { id: 'acme', label: 'Acme Registry' },
          ],
        }}
      />,
    )
  }

  it('renders a chip per marketplace (Skills Market + registry) with the active one pressed', () => {
    const html = page('acme')
    expect(html).toContain('data-testid="marketplace-filter"')
    expect((html.match(/data-testid="marketplace-filter-chip"/g) ?? []).length).toBe(2)
    expect(html).toContain('Skills Market')
    expect(html).toContain('Acme Registry')
    // The active chip carries aria-pressed="true"; the other does not.
    expect(html).toMatch(/data-filter-id="acme"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-filter-id="acme"/)
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1)
  })

  it('hides the selector when only Skills Market is offered (no registries)', () => {
    const html = render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query=""
        searchPlaceholder="Search…"
        sections={sections}
        emptyMessage="No results found"
        marketplaceFilter={{ active: BUILT_IN_MARKETPLACE_FILTER_ID, options: [{ id: BUILT_IN_MARKETPLACE_FILTER_ID, label: 'Skills Market' }] }}
      />,
    )
    expect(html).not.toContain('data-testid="marketplace-filter"')
  })

  // P6.517 / P6.518 — the offer chip is an OFF state and an enable click, not a
  // selection. Its markup has to say so on both counts.
  function offerPage(enabling?: readonly string[]) {
    return render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query=""
        searchPlaceholder="Search…"
        sections={sections}
        emptyMessage="No results found"
        marketplaceFilter={{
          active: BUILT_IN_MARKETPLACE_FILTER_ID,
          options: [
            { id: BUILT_IN_MARKETPLACE_FILTER_ID, label: 'Skills Market' },
            {
              id: 'claude-plugins-official',
              label: 'claude-plugins-official',
              offered: true,
              description: 'The official Anthropic plugin marketplace.',
            },
          ],
          offeredLabel: 'Not added',
          enableLabel: 'Enable this marketplace',
          ...(enabling ? { enabling } : {}),
        }}
      />,
    )
  }

  it('renders a delivered-but-off catalog as an offer chip that is not selectable', () => {
    const html = offerPage()
    expect(html).toContain('data-testid="marketplace-filter"')
    // One selectable chip (the built-in, pressed) and one offer — the offer is
    // NOT a selection chip, so it carries no aria-pressed at all and the single
    // pressed chip in the row is the built-in market.
    expect((html.match(/data-testid="marketplace-filter-chip"/g) ?? []).length).toBe(1)
    expect((html.match(/data-testid="marketplace-filter-offer"/g) ?? []).length).toBe(1)
    expect((html.match(/aria-pressed=/g) ?? []).length).toBe(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter-id="skills-market"/)
    expect(html).toContain('Not added')
    expect(html).toContain('aria-label="Enable this marketplace: claude-plugins-official"')
    // The description reaches the user as the chip's own title.
    expect(html).toContain('title="The official Anthropic plugin marketplace."')
    // Not disabled while idle. Matched on the ATTRIBUTE, not on the substring:
    // the chip's own class list carries `disabled:opacity-60`, so a bare
    // `/disabled/` here passes for the wrong reason.
    expect(html).not.toMatch(/<button[^>]*\sdisabled[^>]*data-testid="marketplace-filter-offer"/)
  })

  it('disables the offer chip while its enable click is in flight', () => {
    const html = offerPage(['claude-plugins-official'])
    // A second click cannot double-register the same catalog.
    expect(html).toMatch(/<button[^>]*disabled[^>]*data-testid="marketplace-filter-offer"/)
    expect(html).toContain('animate-spin')
  })
})

describe('kind tabs render scoped to the marketplace', () => {
  const sections: MarketplaceBrowseSection[] = [
    { id: 'catalog:plugins', title: 'Plugins', cards: [] },
  ]

  function tabsPage(tabs: React.ComponentProps<typeof MarketplaceBrowsePage>['tabs']) {
    return render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query=""
        searchPlaceholder="Search…"
        sections={sections}
        emptyMessage="No results found"
        tabs={tabs}
      />,
    )
  }

  it('the built-in market enables both tabs with no note', () => {
    const html = tabsPage({ active: 'skills', pluginsLabel: 'Plugins', skillsLabel: 'Skills' })
    expect(html).toContain('data-testid="marketplace-tabs"')
    expect(html).not.toContain('data-testid="marketplace-tabs-note"')
    expect((html.match(/disabled=""/g) ?? []).length).toBe(0)
  })

  it('a registry disables the Skills tab with a subtle note', () => {
    const html = tabsPage({
      active: 'plugins',
      pluginsLabel: 'Plugins',
      skillsLabel: 'Skills',
      disabled: { skills: true },
      note: 'This marketplace has no skills',
    })
    expect(html).toContain('data-testid="marketplace-tabs"')
    expect(html).toContain('data-testid="marketplace-tabs-note"')
    expect(html).toContain('This marketplace has no skills')
    // Exactly one tab (Skills) is disabled.
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1)
  })
})

describe('registry management stays reachable in the selected registry view', () => {
  it('a registry section renders its Upgrade / Remove header actions', () => {
    const grouped: MarketplaceBrowseSection[] = [{
      id: 'registry:acme',
      title: 'Acme Registry',
      actions: (
        <>
          <button data-testid="marketplace-registry-upgrade">Upgrade</button>
          <button data-testid="marketplace-registry-remove">Remove</button>
        </>
      ),
      cards: [],
    }]
    const html = render(
      <MarketplaceBrowsePage
        title="Marketplace"
        status="ready"
        query=""
        searchPlaceholder="Search…"
        sections={grouped}
        emptyMessage="No results found"
        marketplaceFilter={{
          active: 'acme',
          options: [
            { id: BUILT_IN_MARKETPLACE_FILTER_ID, label: 'Skills Market' },
            { id: 'acme', label: 'Acme Registry' },
          ],
        }}
      />,
    )
    // Selecting the registry chip shows only its section, with management on it.
    expect(html).toContain('data-testid="marketplace-registry-upgrade"')
    expect(html).toContain('data-testid="marketplace-registry-remove"')
  })
})

/**
 * P6.512 — an `install-plugin` deep link PRE-FILLS the browse surface and
 * installs nothing. The verdict is `resolveInstallPluginLink`'s (its own suite
 * covers the grammar); what is pinned here is the last step — carrying a link's
 * marketplace NAME onto the opaque id the chip row is keyed by.
 */
describe('an install deep link becomes a browse selection', () => {
  const REGISTRIES = [
    { marketplaceId: 'registry-abc', displayName: 'acme-internal' },
    { marketplaceId: 'registry-def', displayName: 'openai-skills' },
  ]

  it('pre-fills the search and scopes to the marketplace the link named', () => {
    // Our own action format…
    expect(browseSelectionForInstallLink({ id: 'toolkit', marketplace: 'acme-internal' }, REGISTRIES))
      .toEqual({ ok: true, query: 'toolkit', marketplaceId: 'registry-abc' })
    // …and the vendor's documented `plugin-name@marketplace-name` spelling.
    expect(browseSelectionForInstallLink({ id: 'toolkit@openai-skills' }, REGISTRIES))
      .toEqual({ ok: true, query: 'toolkit', marketplaceId: 'registry-def' })
    // A bare name searches every marketplace the user already has.
    expect(browseSelectionForInstallLink({ id: 'toolkit' }, REGISTRIES))
      .toEqual({ ok: true, query: 'toolkit' })
  })

  it('refuses a marketplace this machine has not registered, and never adds one', () => {
    expect(browseSelectionForInstallLink({ id: 'toolkit', marketplace: 'evil-corp' }, REGISTRIES))
      .toEqual({ ok: false, reason: 'unknown-marketplace' })
    // The same link on a machine with NO registries is refused too — the check
    // is against the registered set, never against a pattern.
    expect(browseSelectionForInstallLink({ id: 'toolkit@acme-internal' }, []))
      .toEqual({ ok: false, reason: 'unknown-marketplace' })
    // And an unsafe name never reaches the search box.
    expect(browseSelectionForInstallLink({ id: '../../etc/passwd' }, REGISTRIES))
      .toEqual({ ok: false, reason: 'unsafe-name' })
  })
})
