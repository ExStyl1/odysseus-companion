/**
 * UB15.1 — `SettingsToggle` at v0.15.1: the `note` line (v0.14.1) and the info `tooltip` (v0.15.0),
 * which supersede UB6.5's own tooltip/note hunk.
 *
 * Instruments without a DOM: `renderToStaticMarkup` for the material, and the element tree the
 * component returns (captured inside a probe's render) for the info button's click handler.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { SettingsToggle, type SettingsToggleProps } from '../SettingsToggle'

const EN = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>
const KEYS = ['common.info'] as const

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: Object.fromEntries(KEYS.map((key) => [key, EN[key]])) } },
    interpolation: { escapeValue: false },
  })
})

const wrap = (node: React.ReactNode) => (
  <I18nextProvider i18n={testI18n}>
    <TooltipProvider>{node}</TooltipProvider>
  </I18nextProvider>
)
const base: SettingsToggleProps = { label: 'Risk badges', checked: false, onCheckedChange: () => {} }
const render = (props: Partial<SettingsToggleProps> = {}) =>
  renderToStaticMarkup(wrap(<SettingsToggle {...base} {...props} />))

describe('UB15.1 · SettingsToggle — v0.15.1', () => {
  it('the shipped key exists', () => {
    expect(KEYS.filter((key) => typeof EN[key] !== 'string')).toEqual([])
  })

  it('POSITIVE — a note renders a tabular-nums tertiary line under the description', () => {
    const html = render({ description: 'Tags prompts with what the action does', note: '12 calls · 3,400 tokens' })
    expect(html).toMatch(/<div class="[^"]*\btabular-nums\b[^"]*">12 calls · 3,400 tokens<\/div>/)
    const noteTag = html.match(/<div class="([^"]*)">12 calls/)![1]!.split(/\s+/)
    expect(noteTag).toEqual(expect.arrayContaining(['text-label-sm', 'text-tertiary', 'mt-0.5', 'tabular-nums']))
    // The row geometry of the new primitives.
    expect(html).toContain('min-h-14')
  })

  it('NEGATIVE — no note, no tabular-nums line; no tooltip, no info button', () => {
    const html = render({ description: 'Plain row' })
    expect(html).not.toContain('tabular-nums')
    expect(html).not.toContain(`aria-label="${EN['common.info']}"`)
    // The one button left is the switch itself (Radix renders it as a button role=switch).
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toContain('role="switch"')
  })

  it('POSITIVE — a tooltip renders a named button (type=button) inside the label that controls the switch', () => {
    const html = render({ tooltip: 'Sends the command text to the decision model' })
    const label = html.match(/<label for="([^"]+)"[^>]*>(.*?)<\/label>/)
    expect(label).not.toBeNull()
    expect(label![2]).toMatch(new RegExp(`<button type="button" aria-label="${EN['common.info']}"`))
    // The switch the label controls is the role=switch beside it, OUTSIDE the label.
    expect(html).toMatch(new RegExp(`<button type="button" role="switch"[^>]*id="${label![1]}"`))
    expect(label![2]).not.toContain('role="switch"')
    expect(html.match(/<button[^>]*>/g) ?? []).toHaveLength(2)
  })

  it("NEGATIVE — the tooltip button's click does not toggle the switch (preventDefault on the label's default)", () => {
    const onCheckedChange = mock((_checked: boolean) => {})
    let tree: React.ReactNode = null
    function Probe() {
      tree = SettingsToggle({ ...base, onCheckedChange, tooltip: 'Help text' })
      return null
    }
    renderToStaticMarkup(wrap(<Probe />))
    const buttons: Record<string, unknown>[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!React.isValidElement<Record<string, unknown>>(node)) return
      if (node.type === 'button') buttons.push(node.props)
      walk(node.props.children)
    }
    walk(tree)
    expect(buttons).toHaveLength(1)
    const preventDefault = mock(() => {})
    ;(buttons[0]!.onClick as (event: unknown) => void)({ preventDefault })
    // The click's default — the enclosing <label for> activating the switch — is cancelled, and the
    // handler itself never reaches the switch's change handler.
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})
