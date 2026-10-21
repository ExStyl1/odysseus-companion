/**
 * UB14.43 — the info primitives' playground (`registry/info-primitives.tsx`), swept in DARK theme: the
 * base state and every variant of `info-page` (content, loading, error, empty, bare hero),
 * `info-alerts` (the four roles, block and inline) and `info-badges` (every colour without and with
 * `dot`, the status badges, the four state pills) render the v0.15.1 anatomy.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo's `bun test`) inside a `.dark` root, the
 * AppShell provider `PanelHeader` reads, and a private i18n instance on the real en locale. Every
 * entry also renders through the playground's own frame in `registry-render.test.ts`, which
 * enumerates the registry. `createElement` rather than JSX keeps this file a `.ts`.
 *
 * The registry graph reaches `@nessy-agent/ui`'s barrel (upstream's own `Info_Page` import), whose
 * `pdfjs-dist` `?url` worker bun cannot link: the pdfjs recipe runs first and the registry is
 * imported INSIDE `beforeAll` on the shared module-graph budget.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { ComponentEntry } from '../registry/types'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

const LOCALES_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>

let infoPrimitiveComponents: ComponentEntry[]
let AppShellProvider: typeof import('@/context/AppShellContext')['AppShellProvider']
let i18n: I18nInstance

beforeAll(async () => {
  ;({ infoPrimitiveComponents } = await import('../registry/info-primitives'))
  ;({ AppShellProvider } = await import('@/context/AppShellContext'))
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function entry(id: string): ComponentEntry {
  const found = infoPrimitiveComponents.find(c => c.id === id)
  expect({ id, found: !!found }).toEqual({ id, found: true })
  return found!
}

/** The page's order: the defaults, then the variant's props over them. */
function renderDark(id: string, variant: string | null): string {
  const e = entry(id)
  const props: Record<string, unknown> = {}
  for (const prop of e.props) props[prop.name] = prop.defaultValue
  if (variant !== null) {
    const v = e.variants?.find(candidate => candidate.name === variant)
    expect({ id, variant, found: !!v }).toEqual({ id, variant, found: true })
    Object.assign(props, v!.props)
  }
  const Preview = e.component as (p: Record<string, unknown>) => ReturnType<typeof h>
  return renderToStaticMarkup(
    h(I18nextProvider, { i18n },
      h(AppShellProvider, {
        value: { isCompactMode: false } as never,
        children: h('div', { className: 'dark' }, h(Preview, props)),
      })),
  )
}

/** Every state an entry opens in: the base state and each variant. */
const statesOf = (id: string): Array<string | null> => [null, ...(entry(id).variants ?? []).map(v => v.name)]

describe('the info primitives playground (UB14.43)', () => {
  it('registers the three entries under Capability Detail and wires them into the registry index', () => {
    expect(infoPrimitiveComponents.map(c => c.id)).toEqual(['info-page', 'info-alerts', 'info-badges'])
    for (const c of infoPrimitiveComponents) expect(c.category).toBe('Capability Detail')
    const index = readFileSync(join(import.meta.dir, '..', 'registry', 'index.ts'), 'utf8')
    expect(index).toContain("import { infoPrimitiveComponents } from './info-primitives'")
    expect(index).toContain('...infoPrimitiveComponents')
    expect(statesOf('info-page')).toEqual([null, 'Loading', 'Error', 'Empty', 'Bare hero'])
  })

  it('POSITIVE — the content state: the detail column, the hero with meta (state pill) and actions, the named ⋯ in the header', () => {
    const html = renderDark('info-page', null)
    expect(html).toContain('mx-auto w-full max-w-[680px] px-7 pt-2 pb-12')
    expect(html).toContain('size-9 shrink-0 overflow-hidden rounded-md ring-1 ring-[var(--border-strong)]')
    expect(html).toContain('<h2 class="text-title text-foreground [overflow-wrap:anywhere]">GitHub</h2>')
    expect(html).toMatch(/gap-x-2 gap-y-1 text-label-sm text-secondary mt-0\.5"><span class="[^"]*bg-success-tint text-success[^"]*"><span aria-hidden="true"[^>]*><\/span>Connected<\/span>/)
    expect(html).toMatch(/<div class="flex shrink-0 items-center gap-2"><button[^>]*>.*Edit<\/button><\/div>/)
    expect(html).toContain('aria-label="More source actions"')
    // Info_Section: the quiet label with its tabular count, the raised card; Info_Table's 140px label column.
    expect(html).toContain('<h3 class="text-label-sm font-semibold text-secondary">Connection<span class="ml-1.5 text-label-sm font-normal text-tertiary tabular-nums">3</span></h3>')
    expect(html).toContain('overflow-hidden rounded-lg bg-raised shadow-elev-1')
    expect(html).toContain('--label-width:140px')
    // The status badges carry the dot (allowed → success, ask → info).
    expect(html).toContain(`>${en['table.statusAllowed']}</span>`)
    expect(html).toContain(`>${en['table.statusAsk']}</span>`)
  })

  it('NEGATIVE (control) — the bare hero draws no meta line, no actions slot and no header menu', () => {
    const html = renderDark('info-page', 'Bare hero')
    expect(html).toContain('>GitHub</h2>')
    expect(html).not.toContain('gap-x-2 gap-y-1')
    expect(html).not.toContain('flex shrink-0 items-center gap-2')
    expect(html).not.toContain('aria-label="More source actions"')
  })

  it('the loading, error and empty states render on the role type, with no hero', () => {
    expect(renderDark('info-page', 'Loading')).toContain('text-lg text-tertiary')
    const error = renderDark('info-page', 'Error')
    expect(error).toContain(`<p class="text-label font-medium text-foreground">${en['common.errorLoadingContent']}</p>`)
    expect(error).toContain('<p class="max-w-md text-label-sm text-tertiary">The source configuration could not be read.</p>')
    expect(renderDark('info-page', 'Empty')).toContain('<p class="text-label text-tertiary">Nothing to show for this source yet.</p>')
    for (const variant of ['Loading', 'Error', 'Empty']) expect(renderDark('info-page', variant)).not.toContain('>GitHub</h2>')
  })

  it('POSITIVE — all four alerts on their role tints with an inset hairline, block and inline', () => {
    for (const variant of statesOf('info-alerts')) {
      const html = renderDark('info-alerts', variant)
      expect(html).toContain('bg-fill-hover inset-ring inset-ring-border')
      expect(html).toContain('bg-destructive-tint inset-ring inset-ring-[var(--destructive-border)]')
      expect(html).toContain('bg-info-tint inset-ring inset-ring-[var(--info-border)]')
      expect(html).toContain('bg-success-tint inset-ring inset-ring-[var(--success-border)]')
      expect(html.split(variant === 'Inline' ? 'px-3.5 py-2' : 'px-3.5 py-3').length - 1).toBe(4)
      for (const old of ['rounded-[8px] border', 'bg-destructive/5', 'text-foreground/60']) expect(html).not.toContain(old)
    }
  })

  it('POSITIVE — badges: dots only with the knob, default the neutral fill, muted outlined; four state pills, each named', () => {
    const DOT = 'size-1.5 shrink-0 rounded-full bg-current'
    const plain = renderDark('info-badges', null)
    const dotted = renderDark('info-badges', 'With dots')
    // 3 status badges (always dotted) + 4 pills; the knob adds one per Info_Badge colour (5).
    expect(plain.split(DOT).length - 1).toBe(7)
    expect(dotted.split(DOT).length - 1).toBe(12)
    expect(plain).toContain('bg-fill-hover text-secondary">default</span>')
    expect(plain).toContain('text-secondary inset-ring inset-ring-border">muted</span>')
    for (const label of ['Connected', 'Needs sign-in', 'Failed', 'Disabled']) expect(plain).toContain(`></span>${label}</span>`)
    expect(plain + dotted).not.toContain('shadow-tinted')
  })
})
