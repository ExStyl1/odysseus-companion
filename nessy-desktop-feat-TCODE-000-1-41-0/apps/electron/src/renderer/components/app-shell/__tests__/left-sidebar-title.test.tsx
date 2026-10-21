/**
 * UB4.11 (B1-09; upstream v0.14.1 "Long sidebar names fit on one line") — a sidebar row's title sits in a
 * `min-w-0 truncate` span with `title=` the full name (v0.15.1, UB14.4: `min-w-0 flex-1 truncate`; the row
 * button itself is `text-left` now), so a long page name ends in "…" on ONE line and
 * shows in full on hover. Before the row, `LeftSidebar.tsx` `SidebarButton` rendered a bare `{link.title}` in the
 * flex button and a long page name wrapped onto several centred lines (the POSITIVE arms fail there: no span, no
 * `title=`).
 *
 * Instrument: `renderToStaticMarkup` (no DOM in this repo's `bun test`), so "one line" is read as its CSS cause —
 * the `truncate` utility (nowrap + hidden overflow + ellipsis) on a `min-w-0` flex item — never as a measured
 * height. The links come from the playground entry's own builder (`registry/left-sidebar.tsx`), so the state the
 * dark sweep shows is the state asserted here; `registry-render.test.ts` renders every variant of that entry.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { LeftSidebar, type SidebarItem } from '../LeftSidebar'
import {
  buildLeftSidebarLinks,
  leftSidebarComponents,
  LONG_PAGE_NAME,
  LONG_PROJECT_NAME,
  type LeftSidebarPreviewProps,
} from '@/playground/registry/left-sidebar'

const TITLES = { projects: 'Projects', pages: 'Pages' }
const TRUNCATING_SPAN = '<span class="min-w-0 flex-1 truncate" title="'

// `LeftSidebar` labels its nav with `t()`; an empty instance keeps react-i18next quiet (the keys are not asserted).
let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: {} } } })
})

function render(links: SidebarItem[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <LeftSidebar isCollapsed={false} links={links} />
    </I18nextProvider>,
  )
}

function renderState(state: LeftSidebarPreviewProps): string {
  return render(buildLeftSidebarLinks(state, TITLES))
}

/** The truncating span for `name`, exactly as `SidebarButton` writes it. */
const titleSpan = (name: string) => `${TRUNCATING_SPAN}${name}">${name}</span>`
const count = (html: string, needle: string) => html.split(needle).length - 1

describe('UB4.11 — sidebar titles stay on one line with the full name on hover', () => {
  it('POSITIVE — a 120-character page name renders in ONE truncating span whose title is the full name', () => {
    expect(LONG_PAGE_NAME.length).toBe(120)
    const html = renderState({ pageName: 'long', projectName: 'short', expanded: true })
    expect(count(html, titleSpan(LONG_PAGE_NAME))).toBe(1)
    // The text is never cut in JS: the whole name is in the DOM, the "…" is the CSS ellipsis alone.
    expect(html).not.toContain('…')
  })

  it('POSITIVE — a long top-level name truncates while its count badge stays OUTSIDE the span (still visible)', () => {
    const html = renderState({ pageName: 'short', projectName: 'long', expanded: true })
    const span = titleSpan(LONG_PROJECT_NAME)
    // Once as the project row under Projects, once as the top-level row.
    expect(count(html, span)).toBe(2)
    const topLevel = html.lastIndexOf(span)
    const badge = html.indexOf('>12</span>', topLevel)
    expect(badge).toBeGreaterThan(topLevel + span.length - 1)
  })

  it('NEGATIVE (control) — short names render unchanged: the same text, each its own title, every row one span', () => {
    const html = renderState({ pageName: 'short', projectName: 'short', expanded: true })
    for (const name of ['Projects', 'Pages', 'Nessy Desktop', 'Build Health', 'Release Notes', 'Automations']) {
      expect(count(html, titleSpan(name))).toBe(1)
    }
    // Six rows, six title spans: no row keeps a bare title beside the span, and no long name leaks in.
    expect(count(html, TRUNCATING_SPAN)).toBe(6)
    expect(html).not.toContain(LONG_PAGE_NAME)
    expect(html).not.toContain('…')
  })

  it('BOUNDARY — collapsed sections render no child rows; the top-level rows still truncate', () => {
    const html = renderState({ pageName: 'long', projectName: 'long', expanded: false })
    expect(html).not.toContain(LONG_PAGE_NAME)
    expect(html).not.toContain('Build Health')
    expect(count(html, TRUNCATING_SPAN)).toBe(3)
    expect(count(html, titleSpan(LONG_PROJECT_NAME))).toBe(1)
  })

  it('the playground entry carries the four states and is registered (getCategories would drop an unspread file)', () => {
    // UB14.4 added the SidebarPane and empty-state entries to this file; the UB4.11 entry is still the first.
    const [entry] = leftSidebarComponents
    expect(leftSidebarComponents.map(e => e.id)).toEqual(['left-sidebar-titles', 'sidebar-pane', 'detail-empty-states'])
    expect(entry!.category).toBe('Session List')
    expect(entry!.variants!.map(v => v.name)).toEqual(['Short names', 'Long page name', 'Long top-level name', 'Collapsed'])
    const index = readFileSync(join(import.meta.dir, '..', '..', '..', 'playground', 'registry', 'index.ts'), 'utf8')
    expect(index.length).toBeGreaterThan(500)
    expect(index).toContain("import { leftSidebarComponents } from './left-sidebar'")
    expect(index).toContain('...leftSidebarComponents,')
    const orderLine = index.split('\n').find(line => line.includes('const categoryOrder: Category[]'))
    expect(orderLine).toContain("'Session List'")
  })
})
