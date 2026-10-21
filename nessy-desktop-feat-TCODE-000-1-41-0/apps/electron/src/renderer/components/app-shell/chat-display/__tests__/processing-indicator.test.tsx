/**
 * UB14.15 (R2-10) — the live line extracted as v0.15.1
 * `app-shell/chat-display/ProcessingIndicator.tsx`, with OUR specifics re-applied: P6.274 (b)'s
 * `statusType === 'retrying'` arm, P6.916's producer `retry` facts, and P6.424's plugin spinner tip.
 *
 * Instrument: `renderToStaticMarkup` (no DOM library ships in this repo). The indicator imports
 * `Spinner` through the `@nessy-agent/ui` barrel, which reaches `pdfjs-dist` through `Markdown`, so
 * the pdfjs recipe runs first and the module is imported INSIDE `beforeAll` (the recipe of
 * `message-bubble.test.tsx`). Labels come from a private i18next instance per language with the real
 * en/ru tables. A static render runs no effect, so what it shows is the FIRST paint — which is why
 * the retry arm's arrival time is a lazy initial state: the first paint already reads the facts.
 *
 * Arms (the row's):
 * - positive: `statusType="retrying"` with `retry` facts renders OUR assembled retry line (the
 *   producer's reason, the localised attempt and the countdown), which is NOT the status text echoed;
 *   a `suggestion` renders the tip UNDER the spinner line (after it, outside the row).
 * - negative (control): no status renders only a cycling `chat.processing.*` label — no retry clause,
 *   no tip — and a non-retry status (compacting) is echoed verbatim.
 * - the look: v0.15.1's 28px row (`min-h-7`, label in secondary, accent spinner on a 16px slot); the
 *   elapsed time's format (`59s` → `1:00`), which a static paint never shows (an effect sets it).
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import en from '../../../../../../../../packages/shared/src/i18n/locales/en.json'
import ru from '../../../../../../../../packages/shared/src/i18n/locales/ru.json'

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

let Indicator: typeof import('../ProcessingIndicator')
const i18nByLng: Partial<Record<'en' | 'ru', I18nInstance>> = {}

beforeAll(async () => {
  Indicator = await import('../ProcessingIndicator')
  for (const lng of ['en', 'ru'] as const) {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: 'en',
      resources: { en: { translation: en }, ru: { translation: ru } },
      interpolation: { escapeValue: false },
    })
    i18nByLng[lng] = instance
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

type Props = import('../ProcessingIndicator').ProcessingIndicatorProps

function render(props: Props, lng: 'en' | 'ru' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18nByLng[lng]!}>
      <Indicator.ProcessingIndicator {...props} />
    </I18nextProvider>,
  )
}

/** Text as `renderToStaticMarkup` escapes it (React's own five). */
const esc = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')
const table = (lng: 'en' | 'ru') => (lng === 'en' ? en : ru) as Record<string, string>

/** The rate-limit rung as the producer publishes it: the reason in prose, the facts as fields (P6.916). */
const RETRY_MESSAGE = 'Rate limited by the provider'
const RETRY_FACTS = { kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 } as const

describe('ProcessingIndicator keeps our retry arm (P6.274 b, P6.916)', () => {
  it('POSITIVE — retrying with facts renders the assembled line, not the status echoed', () => {
    const html = render({ statusMessage: RETRY_MESSAGE, statusType: 'retrying', retry: RETRY_FACTS })
    // The producer's reason, then OUR clauses from the facts: attempt 2/5 and the 30s countdown.
    expect(html).toContain(`${RETRY_MESSAGE} — retry 2/5 in 30s`)
  })

  it('POSITIVE — the retry clauses are localised (ru), the reason stays the producer\'s', () => {
    const html = render({ statusMessage: RETRY_MESSAGE, statusType: 'retrying', retry: RETRY_FACTS }, 'ru')
    expect(html).toContain(RETRY_MESSAGE)
    expect(html).toContain(esc(table('ru')['chat.retryStatus.attempt']!.replace('{{attempt}}', '2').replace('{{max}}', '5')))
    expect(html).not.toContain('retry 2/5')
  })

  it('NEGATIVE (control) — a non-retry status is echoed verbatim, with no retry clause', () => {
    const html = render({ statusMessage: 'Compacting conversation…', statusType: 'compacting' })
    expect(html).toContain(esc('Compacting conversation…'))
    expect(html).not.toContain('retry ')
  })
})

describe('ProcessingIndicator keeps our plugin spinner tip (P6.424)', () => {
  it('POSITIVE — a suggestion renders the tip UNDER the spinner line, never in its place', () => {
    const html = render({ suggestion: { topic: 'Terraform', reference: 'terraform@nessy-plugins' } })
    const tip = html.indexOf('data-testid="plugin-suggestion-spinner-tip"')
    const row = html.indexOf('min-h-7')
    expect(tip).toBeGreaterThan(-1)
    // After the row (a second line), with the cycling label still drawn in the row.
    expect(tip).toBeGreaterThan(row)
    expect(html).toContain('terraform@nessy-plugins')
    const labels = Indicator.PROCESSING_MESSAGE_KEYS.map(key => esc(table('en')[key]!))
    expect(labels.some(label => html.slice(row, tip).includes(label))).toBe(true)
    // The tip sits under the LABEL: the 16px slot + the 8px gap.
    expect(html).toContain('pl-6 pt-0.5 text-label-sm text-tertiary')
  })

  it('NEGATIVE (control) — no status and no suggestion renders only a cycling chat.processing.* label', () => {
    const html = render({})
    expect(html).not.toContain('plugin-suggestion-spinner-tip')
    expect(html).not.toContain('retry ')
    const labels = Indicator.PROCESSING_MESSAGE_KEYS.map(key => esc(table('en')[key]!))
    expect(labels.filter(label => html.includes(`>${label}<`))).toHaveLength(1)
    // Every cycling key exists in both locales.
    for (const key of Indicator.PROCESSING_MESSAGE_KEYS) {
      expect(table('en')[key]?.length ?? 0).toBeGreaterThan(0)
      expect(table('ru')[key]?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('ProcessingIndicator wears v0.15.1\'s live line', () => {
  it('the 28px row: label in secondary, the accent spinner on a 16px slot', () => {
    // The elapsed time is set by an effect (upstream's `useState(0)`), so a static first paint
    // never shows it; its format is the next arm.
    const html = render({ startTime: Date.now() - 65_000 })
    expect(html).toContain('flex min-h-7 min-w-0 items-center gap-2 text-label text-secondary')
    expect(html).toContain('flex size-4 shrink-0 items-center justify-center')
    expect(html).toContain('text-caption text-accent')
    expect(html).toContain('min-w-0 truncate')
    // The old crossfade line's classes are gone.
    expect(html).not.toContain('text-[13px]')
    expect(html).not.toContain('text-muted-foreground')
  })

  it('formatElapsed: seconds under a minute, m:ss above (boundary 59 → 60)', () => {
    expect(Indicator.formatElapsed(59)).toBe('59s')
    expect(Indicator.formatElapsed(60)).toBe('1:00')
  })
})
