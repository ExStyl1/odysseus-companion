/**
 * UB14.12 (R3-06) — v0.15.1's answer footer, rendered.
 *
 * Instrument: `renderToStaticMarkup`, as in `activity-row.test.tsx`. `TurnCard.tsx` cannot be loaded
 * by bun (pdfjs through `Markdown`), but the footer it now draws lives in `turn/ResponseFooter.tsx`,
 * which reaches no `Markdown` — so these arms assert PAINTED markup, not source text. The whole
 * shell (answer, plan card, streaming answer, compact drawer) is rendered by the playground child in
 * `apps/electron/src/renderer/playground/__tests__/registry-render.test.ts` (UB14.12 block).
 *
 * Arms:
 * - positive: Copy, Markdown, Fullscreen and Branch are four NAMED 24px icon buttons (the former
 *   text buttons, same actions); a just-copied footer names itself "Copied!" with the success check;
 *   the answer footer is the quiet hover/focus-revealed row, and a Russian render names its buttons
 *   in Russian;
 * - negative (the control): without `onPopOut`, `onViewFullscreen` and `onBranch` only Copy is
 *   drawn — no empty slot, no unnamed button; the plan footer is ALWAYS visible (it holds Accept,
 *   so it never wears the hover reveal) and carries the trailing slot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@nessy-agent/shared/i18n'
import { TooltipProvider } from '../../../tooltip'
import { ResponseFooter, type ResponseFooterProps } from '../ResponseFooter'
import { HOVER_REVEAL } from '../turn-classes'

setupI18n()
beforeAll(async () => {
  await i18n.changeLanguage('en')
})
afterAll(async () => {
  await i18n.changeLanguage('en')
})

const noop = () => {}

const render = (over: Partial<ResponseFooterProps>): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <ResponseFooter variant="answer" copied={false} onCopy={noop} {...over} />
      </TooltipProvider>
    </I18nextProvider>,
  )

/** Every `<button …>` opening tag's aria-label, in document order. */
const buttonNames = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>/g)].map(m => m[1] ?? '')

/** The footer's own (outermost) opening tag. */
const rootTag = (html: string): string => html.match(/^<div[^>]*>/)?.[0] ?? ''

describe('ResponseFooter (UB14.12, v0.15.1 turn/ResponseFooter.tsx)', () => {
  it('POSITIVE — Copy, Markdown, Fullscreen and Branch render as named icon buttons, in that order', () => {
    const html = render({ onPopOut: noop, onViewFullscreen: noop, onBranch: noop })
    expect(buttonNames(html)).toEqual(['Copy', 'View as Markdown', 'View Fullscreen', 'Branch options'])
    // Every one is a real button with the 24px icon-button slot, none a text button.
    const tags = html.match(/<button[^>]*>/g) ?? []
    expect(tags).toHaveLength(4)
    for (const tag of tags) {
      expect(tag).toContain('type="button"')
      expect(tag).toContain('data-slot="icon-button"')
      expect(tag).toContain('size-control-sm')
    }
    expect(html).not.toContain('<span>Markdown</span>')
  })

  it('POSITIVE — the answer footer is the quiet row revealed on hover/focus of the answer', () => {
    const tag = rootTag(render({ onPopOut: noop }))
    expect(tag).toContain('data-touch-reveal="true"')
    for (const cls of HOVER_REVEAL.split(' ')) expect(tag).toContain(cls)
    expect(tag).toContain('group-hover/answer:opacity-100')
    expect(tag).toContain('group-focus-within/answer:opacity-100')
    expect(tag).not.toContain('border-t')
  })

  it('POSITIVE — a just-copied footer names itself "Copied!" and shows the success check', () => {
    const html = render({ copied: true })
    expect(buttonNames(html)).toEqual(['Copied!'])
    expect(html).toMatch(/<svg[^>]*class="[^"]*lucide-check[^"]*text-success/)
  })

  it('POSITIVE — a Russian render names the buttons in Russian', async () => {
    await i18n.changeLanguage('ru')
    try {
      const names = buttonNames(render({ onPopOut: noop, onViewFullscreen: noop, onBranch: noop }))
      expect(names).toEqual(['Копировать', 'Показать как Markdown', 'Во весь экран', 'Параметры ветки'])
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('NEGATIVE (control) — without onPopOut, onViewFullscreen and onBranch only Copy is drawn', () => {
    const html = render({})
    expect(buttonNames(html)).toEqual(['Copy'])
    expect(html).not.toContain('View as Markdown')
    expect(html).not.toContain('Branch options')
    expect(html).not.toContain('View Fullscreen')
    expect(html).not.toContain('lucide-git-branch')
  })

  it('NEGATIVE (control) — the plan footer is always visible, bordered, and carries the trailing slot', () => {
    const html = render({ variant: 'plan', trailing: <span data-accept-slot="">Accept</span> })
    const tag = rootTag(html)
    expect(tag).toContain('border-t border-subtle')
    expect(tag).not.toContain('data-touch-reveal')
    expect(tag).not.toContain('opacity-0')
    expect(html).toContain('<div class="ml-auto flex shrink-0 items-center"><span data-accept-slot="">Accept</span></div>')
  })
})
