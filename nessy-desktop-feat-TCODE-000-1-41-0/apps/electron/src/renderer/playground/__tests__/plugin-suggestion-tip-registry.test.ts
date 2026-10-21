/**
 * P6.424 — the spinner tip's design surface.
 *
 * The tip is the one suggestion surface that is INVISIBLE on every shipped
 * install: `pluginSuggestionMarketplaces` is managed-settings-only, so without a
 * managed policy no suggestion is ever decided and the component never mounts.
 * That is precisely why it needs a screen a reviewer can open — and why the
 * assertion below is that the entry keeps a variant for the EMPTY state, not
 * only for the filled one. A design surface that shows only the populated case
 * makes the default look like the exception.
 *
 * Import ONLY this registry module, never `registry/index` — the index pulls the
 * full app component graph (ThemeContext's `import.meta.glob`), which bun cannot
 * evaluate. The index wiring is asserted against the index SOURCE TEXT, which is
 * what makes the entry reachable in the app at all.
 *
 * UB12.73 — the entry mounts the SHIPPED live line (`chat-display/ProcessingIndicator`)
 * instead of a stand-in label, so the module now reaches `Spinner` through the
 * `@nessy-agent/ui` barrel and with it pdfjs (via `Markdown`): the pdfjs recipe
 * of `processing-indicator.test.tsx` runs first and the import stays DYNAMIC
 * inside `beforeAll`. Every variant is then rendered for real with
 * `renderToStaticMarkup` (no DOM library ships here) inside a `.dark` root, with
 * the real en table; `createElement` rather than JSX keeps the file a `.ts`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { createElement as h, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import type { ComponentEntry } from '../registry/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// The pdfjs recipe, one block: the worker-URL stub, the bare-specifier stub, and the polyfill for
// the SECOND, nested pdfjs copy `react-pdf` resolves, which the stubs cannot reach.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let entries: ComponentEntry[]
let i18n: I18nInstance

beforeAll(async () => {
  entries = (await import('../registry/plugin-suggestion-tip')).pluginSuggestionTipComponents
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function entry(): ComponentEntry | undefined {
  return entries.find(candidate => candidate.id === 'plugin-suggestion-tip')
}

describe('plugin spinner tip playground entry', () => {
  it('registers one entry under the Chat category, beside the other chat surfaces', () => {
    expect(entries.map(candidate => candidate.id)).toEqual(['plugin-suggestion-tip'])
    expect(entry()?.category).toBe('Chat')
  })

  it('wires the module into registry/index so it renders', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'registry', 'index.ts'), 'utf-8')
    expect(src).toContain("import { pluginSuggestionTipComponents } from './plugin-suggestion-tip'")
    expect(src).toContain('...pluginSuggestionTipComponents,')
  })

  it('keeps a variant for the state every shipped install is in — no suggestion at all', () => {
    // The negative state, and the one that would be forgotten: `shown: false` is
    // what a machine with no managed suggestion allowlist renders, forever.
    const variants = entry()?.variants ?? []
    expect(variants.some(variant => variant.props.shown === false)).toBe(true)
    // …and the filled state is still there, or the surface shows nothing at all.
    expect(variants.some(variant => variant.props.shown === true)).toBe(true)
  })

  it('holds both wire fields as knobs, because the payload is structural', () => {
    // `{ topic, reference }` on the wire, worded by the locale key — so a
    // reviewer must be able to change each half independently.
    const names = (entry()?.props ?? []).map(prop => prop.name)
    expect(names).toContain('topic')
    expect(names).toContain('reference')
  })
})

describe('UB12.73 — the entry mounts the shipped live line, every state rendered in dark', () => {
  const TIP = 'data-testid="plugin-suggestion-spinner-tip"'
  const LINE = 'data-testid="processing-indicator"'

  function renderVariantDark(name: string): string {
    const variant = entry()?.variants?.find(candidate => candidate.name === name)
    expect(variant).toBeDefined()
    const Preview = entry()!.component as (props: Record<string, unknown>) => ReactElement
    return renderToStaticMarkup(
      h(I18nextProvider, { i18n }, h('div', { className: 'dark' }, h(Preview, variant!.props))),
    )
  }

  it('POSITIVE — "Under the spinner" is ProcessingIndicator\'s 28px row with the tip AFTER it, not a stand-in label', () => {
    const html = renderVariantDark('Under the spinner')
    const row = html.indexOf('min-h-7')
    const tip = html.indexOf(TIP)
    expect(html).toContain(LINE)
    expect(row).toBeGreaterThan(-1)
    // The tip is the live line's second line: after the row, at the label's indent.
    expect(tip).toBeGreaterThan(row)
    expect(html).toContain('k8s-helper@acme-plugins')
    // The hand-made stand-in (13px label, pulse dot) is gone.
    expect(html).not.toContain('text-[13px]')
    expect(html).not.toContain('animate-pulse')
  })

  it('NEGATIVE (control) — "No suggestion" draws the live line alone: no tip', () => {
    const html = renderVariantDark('No suggestion')
    expect(html).toContain(LINE)
    expect(html).toContain('min-h-7')
    expect(html).not.toContain(TIP)
  })

  it('BOUNDARY — "The tip alone" mounts no live line; every variant draws markup inside the dark root', () => {
    const alone = renderVariantDark('The tip alone')
    expect(alone).toContain(TIP)
    expect(alone).not.toContain(LINE)
    for (const variant of entry()?.variants ?? []) {
      const html = renderVariantDark(variant.name)
      expect(html.startsWith('<div class="dark"><div class="w-[520px] max-w-full"><')).toBe(true)
    }
    // The long topic is the wrapping case, and it is still the live line's second line.
    const long = renderVariantDark('A sentence for a topic')
    expect(long.indexOf(TIP)).toBeGreaterThan(long.indexOf('min-h-7'))
  })
})
