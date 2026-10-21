/**
 * UB14.4 (B3-08/F3, R2-01/R2-03; upstream v0.15.1 "A new look") — the app shell split: `SidebarPane` (New session,
 * the scrolling navigation, a PINNED footer), `LeftSidebar`'s `section` headings, `ShellResizeHandle` and
 * `DetailEmptyState`.
 *
 * Instrument: `renderToStaticMarkup` (no DOM in this repo's `bun test`), so "pinned" is read as its layout cause —
 * the footer sits AFTER the `flex-1 overflow-y-auto` scroller in its own `shrink-0` block — never as a measured
 * position; "not focusable" is read as the heading's markup (a div with no tabindex, no button role) plus the
 * `getItemProps` calls `LeftSidebar` makes (the roving-tabindex order). The links come from the playground entry's
 * own builder (`registry/left-sidebar.tsx`), so the state the dark sweep shows is the state asserted here;
 * `registry-render.test.ts` renders every variant of that entry.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { PanelsTopLeft } from 'lucide-react'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import { SidebarPane } from '../SidebarPane'
import { ShellResizeHandle } from '../ShellResizeHandle'
import { DetailEmptyState, SessionsEmptyState } from '../DetailEmptyState'
import type { SidebarItem } from '../LeftSidebar'
import { ActionRegistryProvider } from '@/actions/registry'
import { buildSidebarPaneLinks, leftSidebarComponents } from '@/playground/registry/left-sidebar'

let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: enMessages } } })
})

const t = (key: string) => (enMessages as Record<string, string>)[key] ?? key

function withI18n(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

function renderPane(links: SidebarItem[], footerLinks: SidebarItem[], getItemProps?: (id: string) => Record<string, unknown>): string {
  return withI18n(
    <SidebarPane
      paneRef={() => {}}
      width={232}
      focused={false}
      onKeyDown={() => {}}
      links={links}
      footerLinks={footerLinks}
      getItemProps={getItemProps as never}
      onNewSession={() => {}}
      newSessionLabel="New Session"
      newSessionHotkey="⌘N"
    />,
  )
}

const SCROLLER = 'class="flex-1 overflow-y-auto min-h-0 mask-fade-bottom pb-4 scrollbar-hide"'
const FOOTER = 'class="shrink-0 pb-1.5"'
/** React's server renderer escapes `'` (What's New) the same way in the attribute and the text. */
const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;')
const titleSpan = (name: string) => `<span class="min-w-0 flex-1 truncate" title="${esc(name)}">${esc(name)}</span>`

describe('UB14.4 — SidebarPane: the footer is pinned below the scrolling navigation', () => {
  const { links, footerLinks } = buildSidebarPaneLinks({ selected: 'allSessions', expanded: true }, t)

  it('POSITIVE — Settings, Plugins and What\'s New render AFTER the scroller, in a shrink-0 block of their own', () => {
    const html = renderPane(links, footerLinks)
    const scroller = html.indexOf(SCROLLER)
    const footer = html.indexOf(FOOTER)
    expect(scroller).toBeGreaterThan(-1)
    expect(footer).toBeGreaterThan(scroller)
    for (const name of [t('sidebar.settings'), t('sidebar.plugins'), t('sidebar.whatsNew')]) {
      // The LAST occurrence is the footer's (Plugins is also nested under Sources, inside the scroller).
      expect(html.lastIndexOf(titleSpan(name))).toBeGreaterThan(footer)
    }
    // The scrolling navigation holds the main set and none of the footer's own rows.
    const scrolled = html.slice(scroller, footer)
    expect(scrolled).toContain(titleSpan(t('sidebar.allSessions')))
    expect(scrolled).toContain(titleSpan(t('sidebar.automations')))
    expect(scrolled).not.toContain(titleSpan(t('sidebar.settings')))
    expect(scrolled).not.toContain(titleSpan(t('sidebar.whatsNew')))
    // The New-session row sits above the scroller with its shortcut as keycaps (shown on hover).
    expect(html.indexOf('data-tutorial="new-chat-button"')).toBeLessThan(scroller)
    expect(html).toContain('<kbd')
  })

  it('POSITIVE — a `section` item renders a quiet heading that is not focusable and not in the roving order', () => {
    const asked: string[] = []
    const html = renderPane(links, footerLinks, (id) => {
      asked.push(id)
      return { tabIndex: -1 }
    })
    const heading = `<div class="flex h-row-sidebar items-center px-2 mt-3 text-label-sm font-medium text-tertiary">${t('sidebar.workspaceSection')}</div>`
    expect(html).toContain(heading)
    expect(t('sidebar.workspaceSection')).toBe('Workspace')
    // Every link asks for its roving-tabindex props; the heading never does.
    expect(asked).toContain('nav:allSessions')
    expect(asked).toContain('nav:sources')
    expect(asked).toContain('nav:settings')
    expect(asked).not.toContain('section:workspace')
    expect(asked.filter(id => id.startsWith('section:') || id.startsWith('separator:'))).toEqual([])
    // The heading sits between Labels and Sources (it replaced `separator:chats-sources`).
    const at = html.indexOf(heading)
    expect(html.indexOf(titleSpan(t('sidebar.labels')))).toBeLessThan(at)
    expect(html.indexOf(titleSpan(t('sidebar.sources')))).toBeGreaterThan(at)
  })

  it('NEGATIVE — a long link title renders inside `.truncate` with `title=` the full name, never cut in JS', () => {
    const long = 'Quarterly gateway latency review for the Nestor coder and fast aliases across every region, with per-model breakdown too'
    const html = renderPane([{ id: 'nav:pages:long', title: long, icon: PanelsTopLeft, variant: 'ghost' }], [])
    expect(html).toContain(titleSpan(long))
    expect(html).not.toContain('…')
  })

  it('BOUNDARY — no footer links renders no footer block; a zero count renders no count', () => {
    const html = renderPane(links, [])
    expect(html).not.toContain(FOOTER)
    // `status.done` carries label "0": v0.15.1 shows no column of 0s; `status.todo`'s "12" still shows.
    const doneRow = html.slice(html.indexOf(titleSpan(t('status.done'))))
    expect(doneRow.slice(0, doneRow.indexOf('</button>'))).not.toContain('tabular-nums')
    expect(html).toContain('tabular-nums">12</span>')
  })

  it('the playground entry carries the pane\'s states, the 600 px window among them', () => {
    const entry = leftSidebarComponents.find(e => e.id === 'sidebar-pane')
    expect(entry?.variants?.map(v => v.name)).toEqual(['Tall window', '600 px window', 'Short window', 'Collapsed sections', 'Seam hovered'])
  })
})

describe('UB14.4 — ShellResizeHandle and DetailEmptyState', () => {
  it('POSITIVE — a press on the handle starts the drag AppShell persists on release; a hover tracks the pointer', () => {
    // Called as a function so its returned element's own handlers can be driven (no DOM here).
    const calls: string[] = []
    const ys: Array<number | null> = []
    const ref = { current: { getBoundingClientRect: () => ({ top: 100 }), clientHeight: 400 } } as unknown as React.RefObject<HTMLDivElement>
    const el = ShellResizeHandle({
      handleRef: ref, left: 228, hoverY: null, onHoverYChange: y => ys.push(y), keepHoverOnLeave: false,
      onDragStart: () => calls.push('drag'),
    }) as React.ReactElement<{ onMouseDown: (e: unknown) => void; onMouseMove: (e: unknown) => void; onMouseLeave: () => void; style: React.CSSProperties }>
    let prevented = false
    el.props.onMouseDown({ preventDefault: () => { prevented = true } })
    el.props.onMouseMove({ clientY: 160 })
    el.props.onMouseLeave()
    expect({ calls, prevented, ys, left: el.props.style.left }).toEqual({ calls: ['drag'], prevented: true, ys: [60, null], left: 228 })
    // Mid-drag the gradient stays when the pointer leaves the strip.
    const dragging = ShellResizeHandle({ handleRef: ref, left: 0, hoverY: 60, onHoverYChange: y => ys.push(y), keepHoverOnLeave: true, onDragStart: () => {} }) as React.ReactElement<{ onMouseLeave: () => void }>
    dragging.props.onMouseLeave()
    expect(ys).toEqual([60, null])
  })

  it('POSITIVE — with nothing selected the pane shows one quiet line; the sessions variant picks its heading', () => {
    expect(withI18n(<DetailEmptyState message="Select an automation" />)).toContain('<p class="text-label text-tertiary">Select an automation</p>')
    const withSessions = withI18n(<ActionRegistryProvider><SessionsEmptyState hasSessions /></ActionRegistryProvider>)
    expect(withSessions).toContain(`>${t('session.emptyTitle')}</h2>`)
    expect(withSessions).toContain('<kbd')
  })

  it('BOUNDARY — a workspace without sessions asks the first-session question instead', () => {
    const first = withI18n(<ActionRegistryProvider><SessionsEmptyState hasSessions={false} /></ActionRegistryProvider>)
    expect(first).toContain(`>${t('session.emptyTitleFirst')}</h2>`)
    expect(first).not.toContain(t('session.emptyTitle') + '</h2>')
  })
})
