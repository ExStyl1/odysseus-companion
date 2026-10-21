/**
 * F2 (open seam) — the browse count stops contradicting the screen.
 *
 * `PluginsPage` used to hand the section header `marketplace.total`: the Skills
 * Market's own match count, 6084 on the live catalog. The list under that header
 * renders something else — F2's duplicate collapse removes 1373 rows before any
 * of them becomes a card (6084 -> 4711, measured 2026-07-31), and the client
 * render cap then shows `PAGE_RENDER_STEP` of what survives. So the number and
 * the rows disagreed by construction, and the gap grew as the user scrolled.
 *
 * `browseCatalogSection` derives the count from the section's own `cards`, which
 * is what makes the two unable to disagree again, and moves the catalog total
 * into the note as the already-translated "Showing {{visible}} of {{total}}" —
 * the "show both, labelled" half of the row. Both locales already carry
 * `plugins.showingCount` with no consumer, so no new key is needed.
 */

import { describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

const pageSource = readFileSync(fileURLToPath(new URL('../PluginsPage.tsx', import.meta.url)), 'utf8')
const enLocale = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../../packages/shared/src/i18n/locales/en.json', import.meta.url)),
  'utf8',
)) as Record<string, string>
const ruLocale = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../../../packages/shared/src/i18n/locales/ru.json', import.meta.url)),
  'utf8',
)) as Record<string, string>

function cards(count: number): { id: string; name: string; icon: undefined }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `card-${index}`,
    name: `card-${index}`,
    icon: undefined,
  }))
}

const showingNote = (counts: { visible: number; total: number; elsewhere: number }): string =>
  `${counts.elsewhere > 0 ? 'plugins.showingCountElsewhere' : 'plugins.showingCount'}:${counts.visible}/${counts.total}+${counts.elsewhere}`

describe('F2 — the displayed count equals the rendered row count', () => {
  it('counts the cards it renders, not the catalog the server matched', async () => {
    const { browseCatalogSection } = await import('@/pages/PluginsPage')

    // The live shape: 6084 matched, 4711 after the collapse, 24 rendered.
    const section = browseCatalogSection(
      { id: 'catalog:skills', title: 'Skills', cards: cards(24) as never },
      { catalogTotal: 6084, elsewhere: 0, showCount: true, showingNote },
    )

    expect(section.count).toBe(24)
    expect(section.count).toBe(section.cards.length)
    expect(section.note).toBe('plugins.showingCount:24/6084+0')
  })

  it('keeps the count off when the header does not ask for one, and still explains the difference', async () => {
    const { browseCatalogSection } = await import('@/pages/PluginsPage')
    const section = browseCatalogSection(
      { id: 'catalog:skills', title: 'Skills', cards: cards(24) as never },
      { catalogTotal: 6084, elsewhere: 0, showCount: false, showingNote },
    )

    expect('count' in section).toBe(false)
    expect(section.note).toBe('plugins.showingCount:24/6084+0')
  })

  it('says nothing when every matched row is on screen', async () => {
    const { browseCatalogSection } = await import('@/pages/PluginsPage')
    const section = browseCatalogSection(
      { id: 'catalog:skills', title: 'Skills', cards: cards(7) as never },
      { catalogTotal: 7, elsewhere: 0, showCount: true, showingNote },
    )

    expect(section.count).toBe(7)
    expect('note' in section).toBe(false)
  })

  it('never claims more rows than it renders when the collapse removed some', async () => {
    const { browseCatalogSection } = await import('@/pages/PluginsPage')
    // A total BELOW the rendered count cannot happen from the server, but a
    // stale total can: the count must still be the rows, never the total.
    const section = browseCatalogSection(
      { id: 'catalog:skills', title: 'Skills', cards: cards(30) as never },
      { catalogTotal: 12, elsewhere: 0, showCount: true, showingNote },
    )

    expect(section.count).toBe(30)
    expect('note' in section).toBe(false)
  })
})

/**
 * sev-4 (audit of the signed 1.25.0) — the note counted rows it does not show.
 *
 * `marketplace.list` merges every configured registry's matching rows into the
 * Skills Market response and ADDS them to `total`
 * (`packages/shared/src/marketplace/service.ts:mergeRegistryItems`), while the
 * list under the header is narrowed to ONE marketplace by the chip. Measured on
 * the signed build with the Skills Market chip and the query `chrome`: the RPC
 * answers `total: 4` (including the registry's `chrome-devtools-mcp`), the DOM
 * holds 2 cards, and the note read "Showing 2 of 4" — a numerator and a
 * denominator counted over two different sets, with no way to tell that the
 * missing rows are one chip away.
 */
describe('sev-4 — the note counts the rows the chip can show', () => {
  it('scopes the denominator to the chip and names the rows one chip away', async () => {
    const { browseSectionCounts, browseShowingNoteKey } = await import('@/pages/plugin-marketplace-filter')

    // The measured case: 2 built-in rows on screen, 2 registry rows merged into
    // the server total by `mergeRegistryItems`.
    const counts = browseSectionCounts({ visible: 2, catalogTotal: 4, elsewhere: 2 })

    expect(counts).toEqual({ visible: 2, total: 2, elsewhere: 2 })
    expect(browseShowingNoteKey(counts!)).toBe('plugins.showingCountElsewhere')
  })

  it('scopes the denominator with no query too', async () => {
    const { browseSectionCounts, browseShowingNoteKey } = await import('@/pages/plugin-marketplace-filter')

    // "Showing 40 of 412" with 12 of those 412 belonging to registry chips.
    const counts = browseSectionCounts({ visible: 40, catalogTotal: 412, elsewhere: 12 })

    expect(counts).toEqual({ visible: 40, total: 400, elsewhere: 12 })
    expect(browseShowingNoteKey(counts!)).toBe('plugins.showingCountElsewhere')
  })

  it('keeps the plain sentence when no other marketplace holds a row', async () => {
    const { browseSectionCounts, browseShowingNoteKey } = await import('@/pages/plugin-marketplace-filter')

    // No bring-your-own registry configured: the server total IS the chip's.
    const counts = browseSectionCounts({ visible: 40, catalogTotal: 412, elsewhere: 0 })

    expect(counts).toEqual({ visible: 40, total: 412, elsewhere: 0 })
    expect(browseShowingNoteKey(counts!)).toBe('plugins.showingCount')
  })

  it('says nothing about an empty result', async () => {
    const { browseSectionCounts } = await import('@/pages/plugin-marketplace-filter')

    expect(browseSectionCounts({ visible: 0, catalogTotal: 0, elsewhere: 0 })).toBeNull()
    // Not even when other marketplaces have rows — an empty section renders no
    // header to hang a note under (the page drops the section entirely).
    expect(browseSectionCounts({ visible: 0, catalogTotal: 4, elsewhere: 4 })).toBeNull()
  })

  it('still says nothing when the whole scoped set is on screen and nothing is hidden', async () => {
    const { browseSectionCounts } = await import('@/pages/plugin-marketplace-filter')

    expect(browseSectionCounts({ visible: 7, catalogTotal: 7, elsewhere: 0 })).toBeNull()
    // A stale total can sit BELOW the rendered count; the denominator never
    // claims fewer rows than the screen shows.
    expect(browseSectionCounts({ visible: 30, catalogTotal: 12, elsewhere: 0 })).toBeNull()
  })

  it('the section note carries the scoped pair', async () => {
    const { browseCatalogSection } = await import('@/pages/PluginsPage')
    const section = browseCatalogSection(
      { id: 'catalog:plugins', title: 'Plugins', cards: cards(2) as never },
      { catalogTotal: 4, elsewhere: 2, showCount: true, showingNote },
    )

    expect(section.count).toBe(2)
    expect(section.note).toBe('plugins.showingCountElsewhere:2/2+2')
  })

  it('both locales carry the sentence, with the same three placeholders', () => {
    for (const locale of [enLocale, ruLocale]) {
      const sentence = locale['plugins.showingCountElsewhere']
      expect(typeof sentence).toBe('string')
      expect(sentence).toContain('{{visible}}')
      expect(sentence).toContain('{{total}}')
      expect(sentence).toContain('{{elsewhere}}')
    }
  })
})

describe('F2 — the wiring the helper cannot see', () => {
  it('the built-in catalog section is built through browseCatalogSection', () => {
    const start = pageSource.indexOf('if (isBuiltInMarketplace(marketplaceFilter)) {')
    const end = pageSource.indexOf('const label = visibleRows.find', start)
    expect(start).toBeGreaterThan(-1)
    const branch = pageSource.slice(start, end)

    expect(branch).toContain('return [browseCatalogSection({')
    expect(branch).toContain('catalogTotal: marketplace.total,')
    expect(branch).toContain('elsewhere: otherMarketplaceRows,')
    expect(branch).toContain('showingNote: counts => t(browseShowingNoteKey(counts), counts),')
  })

  it('the hidden-row count is the loaded rows the chip filters out', () => {
    // `marketplace.items` is every loaded row of this kind/query across
    // marketplaces; `filteredItems` is the same set narrowed to the chip.
    expect(pageSource).toMatch(/const otherMarketplaceRows = Math\.max\(0, marketplace\.items\.length - filteredItems\.length\)/)
  })

  it('no section anywhere on the page takes its count from the server total', () => {
    // The exact regression: `...(debouncedQuery ? { count: marketplace.total } : {})`.
    expect(pageSource).not.toMatch(/count:\s*marketplace\.total/)
    expect(pageSource).not.toMatch(/count:\s*\w*[Tt]otal\b/)
  })
})
