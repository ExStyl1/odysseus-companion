/**
 * UB14.37 (R6-08) — the onboarding primitives at v0.15.1 (`onboarding/primitives.tsx`, taken 1:1): every step sits
 * on ONE paper card (`rounded-xl bg-paper shadow-elev-1`, flattened onto the canvas below `sm`) under the brand or
 * status mark, with a LEFT-ALIGNED serif display title and a copy lede; Continue is the step's one primary action
 * (solid accent, `lg`) and Back is a ghost of the same size, never heavier.
 *
 * Before the row the layout drew no card, a centred `text-lg font-semibold` sans title, and both buttons carried a
 * `bg-background`/`bg-foreground-2 shadow-minimal` override that `tailwind-merge` let win over the variant's fill —
 * so `data-variant` alone cannot tell the two trees apart (an un-varianted `Button` reads `primary`); the positives
 * below read the merged CLASS as well, and each fails on that tree.
 *
 * Instrument: `renderToStaticMarkup` of the primitives under the real i18n instance in its own `I18nextProvider`
 * (session-status-menu.test.tsx's recipe), English unless an arm names Russian: since UB12.57 the label-less
 * Back/Continue and the default loading text are `common.back` / `common.continue` / `common.loading`, not literals.
 * The playground sweep of every onboarding state in dark is `playground/__tests__/onboarding-registry.test.ts`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { setupI18n } from '@nessy-agent/shared/i18n/setupI18n'
import { BackButton, ContinueButton, StepActions, StepFormLayout, StepHeader } from '../primitives'

const LOCALES = join(import.meta.dir, '../../../../../../../packages/shared/src/i18n/locales')
const ru = JSON.parse(readFileSync(join(LOCALES, 'ru.json'), 'utf8')) as Record<string, string>
const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, string>

const i18n = setupI18n()

/** Static markup of `node` under the real i18n in `lng`; the instance's previous language is put back. */
const render = async (node: ReactElement, lng: 'en' | 'ru' = 'en') => {
  const previous = i18n.language
  await i18n.changeLanguage(lng)
  try {
    return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
  } finally {
    await i18n.changeLanguage(previous)
  }
}

const layout = (props: Partial<React.ComponentProps<typeof StepFormLayout>> = {}) =>
  render(
    <StepFormLayout
      title="Choose a provider"
      description="Pick how this app reaches a model."
      actions={<><BackButton /><ContinueButton /></>}
      {...props}
    >
      <div id="step-body">body</div>
    </StepFormLayout>,
  )

/** The `<button …>Label</button>` whose text is `label`. */
const buttonOf = (markup: string, label: string) =>
  markup.match(new RegExp(`<button data-slot="button"[^>]*>${label}</button>`))?.[0] ?? ''

/** The element that holds the title: the `<div …>` right before `<h1 class="step-title`. */
const headerOf = (markup: string) => markup.match(/<div class="([^"]*)"><h1 class="step-title[^"]*">/)

describe('StepFormLayout — the paper card (UB14.37)', () => {
  it('POSITIVE — header, content and actions sit in one paper card, the title an h1 in the serif display role', async () => {
    const markup = await layout()
    expect(markup).toContain(
      '<div class="flex w-full flex-col rounded-xl bg-paper shadow-elev-1 px-7 pt-7 pb-6 max-sm:bg-transparent max-sm:shadow-none max-sm:px-1 max-sm:pt-2">',
    )
    expect(markup).toContain('<h1 class="step-title font-serif text-display text-foreground text-balance">Choose a provider</h1>')
    expect(markup).toContain('<p class="step-description mt-2 text-copy text-secondary">Pick how this app reaches a model.</p>')
    // Content and actions are INSIDE the card: the card opens before the title and closes after the actions.
    const card = markup.indexOf('bg-paper')
    expect(card).toBeGreaterThan(-1)
    expect(markup.indexOf('step-title')).toBeGreaterThan(card)
    expect(markup.indexOf('id="step-body"')).toBeGreaterThan(card)
    expect(markup.indexOf('step-actions')).toBeGreaterThan(markup.indexOf('id="step-body"'))
    expect(markup).toContain('<div class="flex w-full max-w-[440px] flex-col items-center">')
  })

  it('POSITIVE — Continue is the solid-accent primary at lg; Back is a ghost at the same size', async () => {
    const markup = await layout()
    const next = buttonOf(markup, 'Continue')
    expect(next).toContain('data-variant="primary"')
    expect(next).toContain('bg-accent-solid text-on-accent')
    expect(next).toContain('h-control-lg')
    const back = buttonOf(markup, 'Back')
    expect(back).toContain('data-variant="ghost"')
    expect(back).toContain('hover:bg-fill-hover')
    expect(back).toContain('h-control-lg')
    // The actions row tightened to gap-2 (v0.15.1); the layout's mt-6 wins over the row's own mt-8 (tailwind-merge).
    expect(markup).toContain('<div class="step-actions flex gap-2 justify-center mt-6 w-full shrink-0">')
  })

  it('NEGATIVE — the header is NOT centred inside the layout; the same instrument sees centring where it is asked for', async () => {
    const inLayout = headerOf(await layout())
    expect(inLayout).not.toBeNull()
    expect(inLayout![1]).not.toContain('text-center')
    // CONTROL: StepHeader on its own still centres by default (and centres its lede), so the probe can fail.
    const alone = headerOf(renderToStaticMarkup(<StepHeader title="T" description="D" />))
    expect(alone?.[1]).toBe('text-center')
    expect(renderToStaticMarkup(<StepHeader title="T" description="D" />)).toContain('step-description mt-2 text-copy text-secondary mx-auto')
  })

  it('NEGATIVE — no v0.14 override survives on the buttons or the title', async () => {
    const markup = await layout()
    for (const old of ['bg-foreground-2', 'shadow-minimal', 'max-w-[320px]', 'hover:bg-foreground/5', 'text-lg font-semibold', 'max-w-[28rem]', 'text-muted-foreground']) {
      expect({ old, present: markup.includes(old) }).toEqual({ old, present: false })
    }
  })

  it('BOUNDARY — a loading Continue is disabled, shows the spinner and its loading text, and stays primary', async () => {
    const markup = await render(<StepActions variant="flex"><ContinueButton loading loadingText="Connecting…" /></StepActions>)
    const next = markup.match(/<button data-slot="button"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''
    expect(next).toContain('data-variant="primary"')
    expect(next).toContain('disabled=""')
    expect(next).toContain('Connecting…')
    expect(next).not.toContain('>Continue<')
  })

  it('BOUNDARY — without actions or children the card holds only the header (no empty action row)', () => {
    const markup = renderToStaticMarkup(<StepFormLayout title="Done" />)
    expect(markup).toContain('bg-paper')
    expect(markup).not.toContain('step-actions')
    expect(markup).not.toContain('mt-5 w-full')
  })
})

/**
 * UB12.57 — v0.15.1 defaults the two buttons' labels to the literals 'Back' / 'Continue' (and the loading text to
 * 'Loading...'), so every step that passes no label (APISetupStep, CredentialsStep, LocalModelStep, GitBashWarning,
 * ByoRuntimeStep) showed English in the Russian UI. Ours read `common.back` / `common.continue` / `common.loading`.
 */
describe('Back and Continue read their default labels through t() (UB12.57)', () => {
  const KEYS = ['common.back', 'common.continue', 'common.loading'] as const

  it('CONTROL — the three keys exist in both locales and the Russian value differs, so the arms below can fail', () => {
    for (const key of KEYS) {
      expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
      expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
    }
  })

  it('POSITIVE — under ru a label-less BackButton reads Назад, a label-less ContinueButton Продолжить, a loading one Загрузка…', async () => {
    const markup = await render(<StepActions variant="flex"><BackButton /><ContinueButton /></StepActions>, 'ru')
    expect(buttonOf(markup, ru['common.back']!)).toContain('data-variant="ghost"')
    expect(buttonOf(markup, ru['common.continue']!)).toContain('data-variant="primary"')
    expect(markup).not.toContain('>Back<')
    expect(markup).not.toContain('>Continue<')
    // The visible text after the spinner (the spinner's own aria-label already reads common.loading, so the instrument
    // reads the button's TEXT, not the markup at large).
    const loading = await render(<ContinueButton loading />, 'ru')
    expect(loading).toEndWith(`</span>${ru['common.loading']}</button>`)
    expect(loading).not.toContain('Loading')
  })

  it('NEGATIVE — an explicit child label and an explicit loading text still win over the key, in ru as in en', async () => {
    const markup = await render(<StepActions variant="flex"><BackButton>Отмена</BackButton><ContinueButton>Войти</ContinueButton></StepActions>, 'ru')
    expect(buttonOf(markup, 'Отмена')).toContain('data-variant="ghost"')
    expect(buttonOf(markup, 'Войти')).toContain('data-variant="primary"')
    expect(markup).not.toContain(ru['common.back']!)
    expect(markup).not.toContain(ru['common.continue']!)
    const loading = await render(<ContinueButton loading loadingText="Подключение…" />, 'ru')
    expect(loading).toEndWith('</span>Подключение…</button>')
    expect(loading).not.toContain(`</span>${ru['common.loading']}</button>`)
  })

  it('BOUNDARY — the same label-less buttons read the English keys under en', async () => {
    const markup = await render(<StepActions variant="flex"><BackButton /><ContinueButton /></StepActions>, 'en')
    expect(buttonOf(markup, en['common.back']!)).toContain('data-variant="ghost"')
    expect(buttonOf(markup, en['common.continue']!)).toContain('data-variant="primary"')
  })
})
