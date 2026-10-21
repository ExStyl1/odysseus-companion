/**
 * UA7.5 — the Pages playground (`registry/pages.tsx`): the library empty and populated with the three kinds, the
 * tile per kind (placeholder and poster), and the delete dialog. Upstream v0.13.4 has no Pages playground entry, so
 * the file is ours; it renders the SHIPPED `PagesHome`, `PageTile` and `DeletePageDialog` (no hand-drawn copy).
 *
 * - The entries are in category `Pages`, and `getCategories()` can show them: it silently DROPS a category missing
 *   from `categoryOrder`, so the order line, the union and the spread are pinned in the index SOURCE (importing the
 *   index loads every entry's graph — `kanban-registry.test.ts`).
 * - The mock library is one page per kind, and only the poster knob gives a page a fresh thumbnail.
 * - UA8.3 follow-up: UA8.3 has landed, so the refresh knob reaches the freshness it shipped — only the live page
 *   carries a schedule and a last run, and "failed" renders upstream's "Refresh failed"; with the knob at none, no
 *   page carries one.
 * - UA6.7: the `published` knob reaches the share badge (live only; a deletion still owed shows none), the delete
 *   dialog has its published note knob, and the Share dialog entry's review mock answers per state.
 * - The staged copies' rule (Review Focus 13) holds here too: no playground state leads into a withheld range —
 *   the `page-frame-source.test.ts` needles over this file's source.
 *
 * - UB14.53: the page view entry (`pages-view`, the shipped `PageView`) joins the category; the tile's placeholder is
 *   v0.15.1's kind icon in a raised circle (no title monogram), the share badge reads "Shared" (`title`, not an
 *   `aria-label`), and the header count is on the text roles. Every Pages state is rendered for real in DARK by
 *   `pages-restyle-registry.test.ts` (its probe wraps the view's tooltip in the entry frame's provider).
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo's `bun test`); every entry also renders through the
 * playground's own frame in `registry-render.test.ts`, which enumerates the registry.
 */
import { createElement, type ComponentType, type ReactNode } from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { ComponentEntry } from '../registry/types'
import type { LoadedPage } from '@nessy-agent/shared/pages/types'

const PLAYGROUND_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(PLAYGROUND_DIR, '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

let testI18n: I18nInstance
let pagesComponents: ComponentEntry[]
let mockPagesLibrary: (options: { posters: boolean; refresh?: 'none' | 'ok' | 'failed'; published?: 'none' | 'live' | 'pending' }) => LoadedPage[]
let DeletePageDialog: ComponentEntry['component']
let PlaygroundAppShellProvider: ComponentType<{ children: ReactNode }>
let PlaygroundChatProviders: ComponentType<{ children: ReactNode }>
// The entry's graph is the renderer's (PagesHome → navigation, app shell): imported under the module-graph budget.
// `registry/pages.tsx` takes `overrideElectronApiMethod` from `mock-utils`, whose import-time install runs only where a
// window exists (none here), and the overrides are effects, which a static render never runs.
beforeAll(async () => {
  ;({ pagesComponents, mockPagesLibrary } = await import('../registry/pages'))
  ;({ DeletePageDialog } = await import('@/components/pages/DeletePageDialog'))
  ;({ PlaygroundAppShellProvider } = await import('../PlaygroundAppShellProvider'))
  ;({ PlaygroundChatProviders } = await import('../registry/playground-chat-providers'))
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function entry(id: string) {
  const found = pagesComponents.find(c => c.id === id)
  if (!found) throw new Error(`no playground entry ${id}`)
  return found
}

/** The playground root's AppShell + the frame's navigation providers, as the page mounts an entry. */
function render(id: string, props: Record<string, unknown>): string {
  const found = entry(id)
  const Component = found.component as ComponentType<Record<string, unknown>>
  const merged = { ...(found.mockData?.() ?? {}), ...props }
  const tree: ReactNode = createElement(
    PlaygroundAppShellProvider,
    null,
    createElement(PlaygroundChatProviders, null, createElement(Component, merged)),
  )
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: testI18n }, tree))
}

const count = (html: string, needle: string) => html.split(needle).length - 1

/** `page-frame-source.test.ts` ABSENT_OWNERS, applied to the playground file (UA5.9's needle left with its landing, 2026-10-02). */
const ABSENT_OWNERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/PageGrantsDialog|PageGrantRequestDialog|PageSourceAuthBanner|pages\.grants\.|config\.grants|issuePageGrant|executePageAction/, 'UA9.3'],
]

describe('UA7.5 — Pages playground registry', () => {
  it('POSITIVE — the library, the tile and the delete dialog are in category Pages', () => {
    expect(pagesComponents.map(c => c.id)).toEqual(['pages-library', 'pages-tile', 'pages-delete-dialog', 'pages-share-dialog', 'pages-view'])
    for (const c of pagesComponents) expect(c.category).toBe('Pages')
    expect(entry('pages-delete-dialog').component).toBe(DeletePageDialog)
  })

  it('NEGATIVE — the categoryOrder line, the union and the spread carry Pages (else getCategories drops the entries)', () => {
    const index = readFileSync(join(PLAYGROUND_DIR, 'registry', 'index.ts'), 'utf8')
    expect(index.length).toBeGreaterThan(500)
    const orderLine = index.split('\n').find(line => line.includes('const categoryOrder: Category[]'))
    expect(orderLine).toBeDefined()
    expect(orderLine).toContain("'Kanban', 'Pages',")
    expect(index).toContain("import { pagesComponents } from './pages'")
    expect(index).toContain('...pagesComponents,')
    const types = readFileSync(join(PLAYGROUND_DIR, 'registry', 'types.ts'), 'utf8')
    expect(types).toContain("| 'Kanban' | 'Pages' |")
  })

  it('the mock library is one page per kind; only the poster knob carries a fresh thumbnail', () => {
    const plain = mockPagesLibrary({ posters: false })
    expect(plain.map(p => p.config.kind)).toEqual(['live', 'interactive', 'static'])
    for (const page of plain) {
      expect(page.config.thumbnail).toBeUndefined()
      expect(page.workspaceId).toBe('playground-workspace')
    }
    for (const page of mockPagesLibrary({ posters: true })) {
      expect(page.config.thumbnail?.digest).toBe(page.config.contentDigest!)
    }
  })

  it('populated: three tiles, one badge per kind, the header count and New Page', () => {
    const html = render('pages-library', { library: 'populated' })
    for (const page of mockPagesLibrary({ posters: false })) expect(html).toContain(`aria-label="${page.config.name}"`)
    for (const kind of ['static', 'interactive', 'live']) expect(count(html, `>${en[`pages.kind.${kind}`]}</span>`)).toBe(1)
    expect(html).toContain(`${en['sidebar.pages']}</span><span class="text-label-sm tabular-nums text-tertiary">3</span>`)
    expect(html).toContain(en['pages.newPage']!)
    expect(html).not.toContain(en['pages.emptyTitle']!)
  })

  it('NEGATIVE — empty: the empty screen with its two actions, and no tile', () => {
    const html = render('pages-library', { library: 'empty' })
    expect(html).toContain(en['pages.emptyTitle']!)
    expect(html).toContain(en['pages.askAgent']!)
    expect(html).toContain(en['pages.createBlank']!)
    for (const page of mockPagesLibrary({ posters: false })) expect(html).not.toContain(`aria-label="${page.config.name}"`)
  })

  it('the tile knob reaches the tile: its kind chip, and the kind placeholder (no title monogram) until a poster loads', () => {
    for (const kind of ['static', 'interactive', 'live'] as const) {
      const html = render('pages-tile', { kind, name: 'Build Health', poster: false })
      expect(html).toContain(`>${en[`pages.kind.${kind}`]}</span>`)
      // UB14.53: v0.15.1's placeholder — the kind icon in a raised circle; the v0.13.4 monogram is gone.
      expect(html).toContain('grid size-11 place-items-center rounded-full bg-raised text-secondary shadow-elev-1')
      expect(html).not.toContain('>B</span>')
    }
  })

  it('NEGATIVE — the staged-copy rule: no withheld owner\'s entry in the playground file', () => {
    const source = readFileSync(join(PLAYGROUND_DIR, 'registry', 'pages.tsx'), 'utf8')
    // Positive control: the needles fire when planted. UA8.3 has landed: a refresh outcome is no absent owner's.
    // UA6.7 has landed: the share dialog is no absent owner's; a planted grant dialog still is.
    expect(ABSENT_OWNERS.filter(([n]) => n.test('<SharePageDialog page={page} />')).map(([, o]) => o)).toEqual([])
    expect(ABSENT_OWNERS.filter(([n]) => n.test('<PageGrantsDialog open />')).map(([, o]) => o)).toEqual(['UA9.3'])
    expect(ABSENT_OWNERS.filter(([n]) => n.test('config.lastRefresh = { ok: false }')).map(([, o]) => o)).toEqual([])
    expect(ABSENT_OWNERS.filter(([n]) => n.test(source)).map(([, o]) => o)).toEqual([])
  })

  it('UA8.3 (presence) — the refresh knob: failed shows upstream\'s "Refresh failed" on the live tile alone; ok and none do not', () => {
    const failed = mockPagesLibrary({ posters: false, refresh: 'failed' })
    expect(failed.filter(p => p.config.lastRefresh).map(p => p.config.kind)).toEqual(['live'])
    expect(failed.find(p => p.config.kind === 'live')!.config.lastRefresh!.ok).toBe(false)
    expect(count(render('pages-library', { library: 'populated', refresh: 'failed' }), en['pages.refreshFailed']!)).toBe(1)
    expect(render('pages-tile', { kind: 'live', name: 'Build Health', poster: false, refresh: 'failed' })).toContain(en['pages.refreshFailed']!)
    // Boundary: an ok run and no schedule never say "Refresh failed"; with the knob at none no page carries a run.
    expect(render('pages-tile', { kind: 'live', name: 'Build Health', poster: false, refresh: 'ok' })).not.toContain(en['pages.refreshFailed']!)
    expect(render('pages-library', { library: 'populated' })).not.toContain(en['pages.refreshFailed']!)
    for (const posters of [false, true]) {
      for (const page of mockPagesLibrary({ posters })) expect(page.config.lastRefresh).toBeUndefined()
    }
  })

  it('UA6.7 (presence) — the published knob: a live publication badges the tile; a deletion still owed and none do not', () => {
    const badge = `title="${en['pages.shared']}"`
    expect(render('pages-tile', { kind: 'live', name: 'Build Health', poster: false, published: 'live' })).toContain(badge)
    expect(render('pages-tile', { kind: 'live', name: 'Build Health', poster: false, published: 'pending' })).not.toContain(badge)
    expect(render('pages-tile', { kind: 'live', name: 'Build Health', poster: false })).not.toContain(badge)
    expect(count(render('pages-library', { library: 'populated', published: 'live' }), badge)).toBe(1)
    const library = mockPagesLibrary({ posters: false, published: 'pending' })
    expect(library.filter(p => p.publication).map(p => [p.config.kind, p.publication!.pendingDelete])).toEqual([['live', true]])
  })

  it('UA6.7 — the share dialog\'s review mock: a card for publishable states, a refusal for the blocked ones', async () => {
    const { mockPageShareReview } = await import('../registry/pages')
    expect(mockPageShareReview('unpublished', false).review).toMatchObject({ ok: true, mode: 'create' })
    expect(mockPageShareReview('drifted', false).review).toMatchObject({ ok: true, mode: 'update' })
    expect(mockPageShareReview('script-blocked', false).review).toMatchObject({ ok: false, code: 'PAGE_SHARE_SCRIPT_GRANT' })
    expect(mockPageShareReview('review-refused', false).review).toMatchObject({ ok: false, code: 'PAGE_SHARE_SECRET' })
    expect(mockPageShareReview('unpublished', true).secretCandidates).toEqual(['kv.apiToken'])
    expect(mockPageShareReview('unpublished', false).secretCandidates).toEqual([])
  })

  it('every variant names only props the entry declares', () => {
    for (const c of pagesComponents) {
      const declared = new Set(c.props.map(p => p.name))
      expect((c.variants ?? []).length).toBeGreaterThan(0)
      for (const variant of c.variants ?? []) {
        for (const key of Object.keys(variant.props)) expect(declared.has(key)).toBe(true)
      }
    }
  })
})

/**
 * UA7.5 follow-up (UA-ao-fix, 2026-10-02) — the page channels stay installed across a variant switch. The bridge
 * used to be a `useEffect` keyed on `[pages]`: flipping the poster knob changes `pages` AND the tile's
 * `posterDigest` in one commit, and React runs every passive cleanup before the mount effects, child first — so the
 * parent's cleanup deleted `getPageThumbnail` (the base mock has none) and the tile's poster effect called a missing
 * method, unmounting the whole playground. No renderer in this repo's `bun test` runs effects, so the hook's shape is
 * pinned in its source, and the installer it calls is driven for real against a stand-in bridge.
 */
describe('UA7.5 follow-up — the page channels survive a pages change', () => {
  const CHANNELS = ['getPageThumbnail', 'regeneratePageThumbnail', 'createPage', 'deletePage'] as const

  it('POSITIVE — one install answers from the CURRENT pages, so a knob flip needs no reinstall; dispose removes all four', async () => {
    const { installPlaygroundPagesBridge } = await import('../registry/pages')
    const g = globalThis as { window?: unknown }
    const before = Object.getOwnPropertyDescriptor(g, 'window')
    const bridge: Record<string, unknown> = {}
    g.window = { electronAPI: bridge }
    try {
      let current = mockPagesLibrary({ posters: false })
      const dispose = installPlaygroundPagesBridge(() => current)
      type Thumb = (workspaceId: string, slug: string) => Promise<{ dataUrl: string; digest: string } | null>
      const thumb = () => bridge.getPageThumbnail as Thumb
      expect(await thumb()('playground-workspace', 'build-health')).toBeNull()
      current = mockPagesLibrary({ posters: true }) // the knob flips: a re-render, the install untouched
      const poster = await thumb()('playground-workspace', 'build-health')
      expect(poster?.digest).toBe(current[0]!.config.contentDigest!)
      expect(poster?.dataUrl.startsWith('data:image/svg+xml')).toBe(true)
      dispose()
      for (const name of CHANNELS) expect(name in bridge).toBe(false)
    } finally {
      if (before) Object.defineProperty(g, 'window', before)
      else delete g.window
    }
  })

  it('NEGATIVE — the hook installs once, in an effect keyed on nothing, never on [pages] (a re-keyed install is disposed in the commit where the tile fetches its poster)', () => {
    const source = readFileSync(join(PLAYGROUND_DIR, 'registry', 'pages.tsx'), 'utf8')
    const start = source.indexOf('function usePlaygroundPagesBridge(')
    expect(start).toBeGreaterThan(0)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain('React.useEffect(() => installPlaygroundPagesBridge(() => pagesRef.current), [])')
    expect(body).toContain('pagesRef.current = pages')
    expect(body).not.toMatch(/\[pages\]/)
    expect(body.split('React.useEffect(').length - 1).toBe(1)
  })
})
