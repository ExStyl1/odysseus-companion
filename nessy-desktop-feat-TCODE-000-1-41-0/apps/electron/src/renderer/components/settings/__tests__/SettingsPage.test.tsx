/**
 * UB15.1 — `SettingsPage` (ADDED in v0.15.0): the detail column every settings page renders through —
 * an actions-only panel header, then a centred 680px column holding the page title (`h2`), a one-line
 * lede (`p`) and the setting groups.
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { DETAIL_COLUMN_CLASS, SettingsPage, SettingsPageState } from '../SettingsPage'

const appShellValue = { isCompactMode: false } as unknown as AppShellContextType
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<AppShellProvider value={appShellValue}>{node}</AppShellProvider>)

/** The markup from the column's own opening tag onward. */
const column = (html: string): string => {
  const at = html.indexOf(`<div class="${DETAIL_COLUMN_CLASS}">`)
  expect(at, 'no detail column').toBeGreaterThan(-1)
  return html.slice(at)
}

describe('UB15.1 · SettingsPage — v0.15.1', () => {
  it('the column is v0.15.1\'s: 680px max, 28px sides, 16px in a compact panel', () => {
    expect(DETAIL_COLUMN_CLASS).toBe(
      'mx-auto w-full max-w-[680px] px-7 pt-2 pb-12 @max-mobile/panel:px-4 @max-mobile/panel:pb-10',
    )
  })

  it('POSITIVE — the title h2 and the lede p render inside the detail column, above the groups', () => {
    const html = render(
      <SettingsPage title="Appearance" description="Theme, font and motion.">
        <section data-probe="group">Group</section>
      </SettingsPage>,
    )
    const inner = column(html)
    expect(inner).toMatch(/<h2 class="text-title text-foreground">Appearance<\/h2>/)
    expect(inner).toMatch(/<p class="mt-1 text-label leading-5 text-secondary">Theme, font and motion\.<\/p>/)
    // The groups stack follows the title block, inside the same column.
    expect(inner.indexOf('Appearance</h2>')).toBeLessThan(inner.indexOf('data-probe="group"'))
    expect(inner).toContain('<div class="space-y-6"><section data-probe="group">')
    // The title lives in the column, so the panel header carries no title of its own (actions only).
    expect(html.slice(0, html.indexOf(DETAIL_COLUMN_CLASS))).not.toContain('Appearance')
  })

  it('NEGATIVE — no description, no lede; the title alone', () => {
    const inner = column(render(<SettingsPage title="Shortcuts"><div /></SettingsPage>))
    expect(inner).toContain('Shortcuts</h2>')
    expect(inner).not.toContain('<p')
  })

  it('header actions render before the column; SettingsPageState centres its message without a column', () => {
    const html = render(
      <SettingsPage title="Labels" actions={<button type="button" aria-label="More">⋯</button>}>
        <div />
      </SettingsPage>,
    )
    expect(html.indexOf('aria-label="More"')).toBeGreaterThan(-1)
    expect(html.indexOf('aria-label="More"')).toBeLessThan(html.indexOf(DETAIL_COLUMN_CLASS))
    const state = render(<SettingsPageState>Loading…</SettingsPageState>)
    expect(state).toContain('Loading…')
    expect(state).not.toContain(DETAIL_COLUMN_CLASS)
    expect(state).toContain('items-center justify-center')
  })
})
