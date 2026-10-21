/**
 * UB14.43 (R7-07) — the info primitives at v0.15.1 (`components/info/Info_{Alert,Badge,DataTable,Page,
 * Section,StatusBadge,Table,GroupedList,StatePill}.tsx`), taken 1:1 except `Info_GroupedList`'s
 * subpath `Spinner` (P6.844).
 *
 * Instruments. Markup is read from `renderToStaticMarkup` (no DOM library ships). `Info_Page` imports
 * the `@nessy-agent/ui` barrel (upstream's own import), whose graph reaches `pdfjs-dist`'s
 * `?url` worker that bun cannot link, so the pdfjs recipe runs first (the two `mock.module` stubs
 * AND the `DOMMatrix` polyfill, one block) and the components are imported INSIDE `beforeAll` on
 * the shared module-graph budget (a static import would hoist above the stubs).
 *
 * Arms (the row's):
 * - positive: `<Info_Badge dot color="success">` renders the aria-hidden dot span on the success tint;
 *   `Info_Page.Hero` with `meta` and `actions` renders both, beside the 36px ringed tile and the
 *   20/28 title; `Info_Page.Content` is the settings detail column with no edge mask.
 * - negative / boundary: `Info_StatePill tone="off"` still renders its label (state never by colour
 *   alone); a badge without `dot` draws no dot; a bare hero draws no meta line and no actions slot;
 *   `muted` is the outlined chip with no fill while `default` is the neutral fill.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// The pdfjs recipe, one block (see the docblock).
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let Info_Badge: typeof import('../Info_Badge')['Info_Badge']
let Info_StatePill: typeof import('../Info_StatePill')['Info_StatePill']
let Info_Page: typeof import('../Info_Page')['Info_Page']
let DETAIL_COLUMN_CLASS: string

beforeAll(async () => {
  Info_Badge = (await import('../Info_Badge')).Info_Badge
  Info_StatePill = (await import('../Info_StatePill')).Info_StatePill
  Info_Page = (await import('../Info_Page')).Info_Page
  DETAIL_COLUMN_CLASS = (await import('@/components/settings/SettingsPage')).DETAIL_COLUMN_CLASS
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const DOT = '<span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-current"></span>'

describe('Info_Badge and Info_StatePill (UB14.43)', () => {
  it('POSITIVE — a dot badge renders the aria-hidden dot before its text, on the success role tint', () => {
    const html = renderToStaticMarkup(<Info_Badge dot color="success">Active</Info_Badge>)
    expect(html).toContain(`${DOT}Active</span>`)
    expect(html).toContain('bg-success-tint text-success')
    expect(html).toContain('h-5 max-w-full items-center gap-1 whitespace-nowrap rounded-xs px-1.5 text-label-sm')
  })

  it('NEGATIVE (control) — without dot there is no dot; muted is outlined with no fill, default is the neutral fill', () => {
    const plain = renderToStaticMarkup(<Info_Badge color="success">Active</Info_Badge>)
    expect(plain).not.toContain('rounded-full bg-current')
    const muted = renderToStaticMarkup(<Info_Badge color="muted">Bash(git *)</Info_Badge>)
    expect(muted).toContain('text-secondary inset-ring inset-ring-border')
    expect(muted).not.toContain('bg-')
    expect(renderToStaticMarkup(<Info_Badge>MCP</Info_Badge>)).toContain('bg-fill-hover text-secondary')
    // v0.14's tinted-shadow chip is gone with its inline --shadow-color.
    expect(muted + plain).not.toContain('shadow-tinted')
    expect(muted + plain).not.toContain('style=')
  })

  it('NEGATIVE — Info_StatePill tone="off" still names its state in text, never by colour alone', () => {
    const off = renderToStaticMarkup(<Info_StatePill tone="off">Disabled</Info_StatePill>)
    expect(off).toContain(`${DOT}Disabled</span>`)
    expect(off).toContain('bg-fill-hover text-secondary')
    const bad = renderToStaticMarkup(<Info_StatePill tone="bad">Failed</Info_StatePill>)
    expect(bad).toContain('bg-destructive-tint text-destructive')
    expect(bad).toContain('>Failed</span>')
  })
})

describe('Info_Page hero and content column (UB14.43)', () => {
  it('POSITIVE — the hero renders meta and actions beside the 36px ringed tile and the 20/28 title', () => {
    const html = renderToStaticMarkup(
      <Info_Page.Hero
        avatar={<span data-probe="avatar" />}
        title="GitHub"
        tagline="Repositories and issues"
        meta={<span data-probe="meta">Connected</span>}
        actions={<button type="button" data-probe="action">Edit</button>}
      />,
    )
    expect(html).toContain('<div class="size-9 shrink-0 overflow-hidden rounded-md ring-1 ring-[var(--border-strong)]"><span data-probe="avatar"></span></div>')
    expect(html).toContain('<h2 class="text-title text-foreground [overflow-wrap:anywhere]">GitHub</h2>')
    // meta leads the meta line, the tagline follows it.
    expect(html).toMatch(/<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-label-sm text-secondary mt-0\.5"><span data-probe="meta">Connected<\/span><span class="min-w-0 line-clamp-2">Repositories and issues<\/span><\/div>/)
    expect(html).toContain('<div class="flex shrink-0 items-center gap-2"><button type="button" data-probe="action">Edit</button></div>')
  })

  it('NEGATIVE (control) — a bare hero draws no meta line and no actions slot', () => {
    const html = renderToStaticMarkup(<Info_Page.Hero avatar={<span />} title="GitHub" />)
    expect(html).not.toContain('gap-x-2 gap-y-1')
    expect(html).not.toContain('flex shrink-0 items-center gap-2')
    expect(html).toContain('>GitHub</h2>')
  })

  it('POSITIVE — Content is the settings detail column with no edge mask; NEGATIVE — no CHAT_LAYOUT width', () => {
    const html = renderToStaticMarkup(<Info_Page.Content><p>body</p></Info_Page.Content>)
    expect(html).toContain(`<div class="${DETAIL_COLUMN_CLASS}"><div class="space-y-6"><p>body</p></div></div>`)
    expect(html).not.toContain('mask-image')
    expect(html).not.toContain('px-5 pt-6 pb-10')
  })
})
