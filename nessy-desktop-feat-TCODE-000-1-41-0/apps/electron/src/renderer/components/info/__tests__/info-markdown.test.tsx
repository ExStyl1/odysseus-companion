/**
 * UB14.17 (R3-11) — `Info_Markdown` on the info card language, as v0.15.1
 * `apps/electron/src/renderer/components/info/Info_Markdown.tsx`, with its new primitive
 * `Info_FullscreenButton` (ADDED in v0.15.0).
 *
 * Method (the row's): take, then re-apply ONE hunk — P6.850's leaf import of
 * `DocumentFormattedMarkdownOverlay` (upstream imports the `@craft-agent/ui` barrel).
 *
 * Instruments. Markup is read from `renderToStaticMarkup` (no DOM library ships); lucide draws
 * `lucide-<name>` into the svg class. The button's click is driven the way
 * `packages/ui/.../code-block-run.test.tsx` drives Run: a probe CALLS the component during its own
 * render, so the hooks are the probe's and the returned element is in hand; its `onClick` is invoked.
 *
 * Loading. `Info_Markdown` reaches `pdfjs-dist` through `Markdown` → `MarkdownPdfBlock` and through
 * the overlay, whose `pdf.worker.min.mjs?url` import bun cannot link. So the pdfjs recipe runs first
 * (the two `mock.module` stubs AND the `DOMMatrix` polyfill, one block) and the components are
 * imported INSIDE `beforeAll` on the shared module-graph budget (a static import would hoist above
 * the stubs).
 *
 * Arms:
 * - positive: `fullscreen` renders the named icon button (`table.viewFullscreen`, en and ru) on the
 *   floating material, touch-revealed, pinned top-right on the local layer, inside a `relative group`
 *   body that wears the card pad and the label type; the button's click reaches its handler.
 * - negative / boundary (the row's control): without `fullscreen` there is no button and no group;
 *   a caller's `px-4` (CapabilityContentPanel's override) REPLACES the card pad instead of stacking
 *   beside it, and `text-label` survives as the type size; the overlay import stays the leaf, never
 *   the barrel (P6.850).
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

// The pdfjs recipe, one block (see the docblock): the worker-URL stub, the bare-specifier stub, and
// the polyfill for the SECOND, nested pdfjs copy `react-pdf` resolves, which the stubs cannot reach.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let Info_Markdown: typeof import('../Info_Markdown')['Info_Markdown']
let Info_FullscreenButton: typeof import('../Info_FullscreenButton')['Info_FullscreenButton']
// A private instance through the provider, so labels never depend on which other test file
// initialised the global i18next first.
let testI18n: I18nInstance

beforeAll(async () => {
  Info_Markdown = (await import('../Info_Markdown')).Info_Markdown
  Info_FullscreenButton = (await import('../Info_FullscreenButton')).Info_FullscreenButton
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

/** The opening tag of the first element carrying `marker`, or '' when none does. */
function tagWith(html: string, marker: string): string {
  const at = html.indexOf(marker)
  if (at < 0) return ''
  const start = html.lastIndexOf('<', at)
  return html.slice(start, html.indexOf('>', at) + 1)
}

/** The class list of the first element whose opening tag carries `marker`. */
function classesOf(html: string, marker: string): string[] {
  return (tagWith(html, marker).match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean)
}

describe('UB14.17 — Info_Markdown with fullscreen renders Info_FullscreenButton (positive)', () => {
  it('renders the named icon button on the floating material, top-right on the local layer', async () => {
    await testI18n.changeLanguage('en')
    const html = render(<Info_Markdown fullscreen>Body text</Info_Markdown>)
    const button = tagWith(html, 'data-slot="icon-button"')
    expect(button).toContain('aria-label="View Fullscreen"')
    expect(button).toContain('title="View Fullscreen"')
    expect(button).toContain('data-touch-reveal="true"')
    expect(button).toContain('type="button"')
    const classes = classesOf(html, 'data-slot="icon-button"')
    for (const cls of [
      'size-control-sm',
      'state-overlay',
      'bg-floating',
      'shadow-elev-1',
      'opacity-0',
      'group-hover:opacity-100',
      'focus-visible:opacity-100',
      'duration-micro',
      'ease-out-subtle',
      'absolute',
      'top-2',
      'right-2',
      'z-local',
    ]) {
      expect(classes).toContain(cls)
    }
    // The old inline button's material is gone.
    expect(classes).not.toContain('bg-background')
    expect(classes).not.toContain('shadow-minimal')
    expect(classes).not.toContain('z-10')
    expect(html).toMatch(/lucide-maximize-?2/)
    // The body is the card: card pad, label type, and the group the button reveals on.
    const body = classesOf(html, 'class="px-card-pad')
    for (const cls of ['px-card-pad', 'pb-3', 'text-label', 'pt-1', 'relative', 'group']) {
      expect(body).toContain(cls)
    }
    expect(html).toContain('Body text')
  })

  it('names the button in Russian from the same key', async () => {
    await testI18n.changeLanguage('ru')
    try {
      const html = render(<Info_Markdown fullscreen>Текст</Info_Markdown>)
      expect(tagWith(html, 'data-slot="icon-button"')).toContain('aria-label="Во весь экран"')
    } finally {
      await testI18n.changeLanguage('en')
    }
  })

  it("the button's click reaches its handler", () => {
    let clicks = 0
    let element: React.ReactElement<{ onClick?: () => void; 'aria-label'?: string }> | null = null
    function Probe() {
      element = Info_FullscreenButton({ onClick: () => { clicks += 1 } }) as typeof element
      return null
    }
    render(<Probe />)
    expect(element).not.toBeNull()
    expect(element!.props['aria-label']).toBe('View Fullscreen')
    element!.props.onClick?.()
    expect(clicks).toBe(1)
  })
})

describe('UB14.17 — the control: no fullscreen, a caller override, the leaf import (negative / boundary)', () => {
  it('without fullscreen there is no button and no hover group', () => {
    const html = render(<Info_Markdown>Body text</Info_Markdown>)
    expect(html).not.toContain('data-slot="icon-button"')
    expect(html).not.toContain('View Fullscreen')
    expect(html).not.toMatch(/lucide-maximize-?2/)
    const body = classesOf(html, 'class="px-card-pad')
    expect(body).toContain('px-card-pad')
    expect(body).not.toContain('group')
    expect(body).not.toContain('relative')
    expect(html).toContain('Body text')
  })

  it("a caller's px-4 replaces the card pad instead of stacking beside it (CapabilityContentPanel)", () => {
    const html = render(
      <Info_Markdown fullscreen className="px-4 pt-3 pb-4">
        Body text
      </Info_Markdown>,
    )
    const body = classesOf(html, 'text-label')
    expect(body).toContain('px-4')
    expect(body).not.toContain('px-card-pad')
    expect(body).toContain('pt-3')
    expect(body).not.toContain('pt-1')
    expect(body).toContain('pb-4')
    expect(body).not.toContain('pb-3')
    // The token-aware merge keeps `text-label` as a SIZE (it is not read as a colour and dropped).
    expect(body).toContain('text-label')
  })

  it('keeps P6.850: the overlay is imported from its leaf, never the barrel', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'Info_Markdown.tsx'), 'utf8')
    expect(source).toContain(
      "import { DocumentFormattedMarkdownOverlay } from '@nessy-agent/ui/overlay/DocumentFormattedMarkdownOverlay'",
    )
    expect(source).not.toMatch(/from '@nessy-agent\/ui'/)
    expect(source).not.toMatch(/@craft-agent/)
    expect(source).toContain("import { Info_FullscreenButton } from './Info_FullscreenButton'")
  })
})
