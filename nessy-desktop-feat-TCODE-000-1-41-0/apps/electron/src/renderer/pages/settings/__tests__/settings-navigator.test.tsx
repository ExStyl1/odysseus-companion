/**
 * UB15.2 — the settings navigator rows at v0.15.1 (`pages/settings/SettingsNavigator.tsx`, taken 1:1 with
 * our `nessy://` deep link re-applied).
 *
 * Rendered through `renderToStaticMarkup` (no DOM in this repo's `bun test`). The row's named tests:
 *  - positive: the selected row renders `data-selected` and both entity slots (title + subtitle), and only
 *    that row; our item list keeps the `import` page and has no `messaging` page;
 *  - negative: the "⋯" is a named button (`aria-label`) whose wrapper stays invisible AND unclickable until
 *    the row is hovered or holds focus; the open-in-new-window URL starts with `nessy://`, never
 *    `craftagents://`. The URL is read from the source: the menu item only mounts once the dropdown is
 *    open, which a static render cannot reach.
 */

import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import { SETTINGS_ITEMS } from '../../../../shared/menu-schema'
import type { SettingsSubpage } from '../../../../shared/types'
import SettingsNavigator from '../SettingsNavigator'

const EN = en as Record<string, string>
let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: EN } },
    interpolation: { escapeValue: false },
  })
})

function render(selectedSubpage: SettingsSubpage | null): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SettingsNavigator selectedSubpage={selectedSubpage} onSelectSubpage={() => {}} />
    </I18nextProvider>,
  )
}

/** One markup chunk per row, in order: everything from a row's `settings-item` wrapper to the next one. */
function rows(markup: string): string[] {
  return markup.split('<div class="settings-item"').slice(1)
}

/** The opening tag of the reveal wrapper around the "⋯" trigger, and the trigger's own opening tag. */
function moreButton(row: string): { wrapper: string; trigger: string } {
  const wrapper = row.match(/<div data-touch-reveal="true"[^>]*>/)?.[0] ?? ''
  const trigger = row.slice(row.indexOf(wrapper) + wrapper.length).match(/<button[^>]*>/)?.[0] ?? ''
  return { wrapper, trigger }
}

describe('settings navigator rows (UB15.2)', () => {
  it('positive: the selected row renders data-selected and both entity slots; only that row is selected', () => {
    const all = rows(render('workspace'))
    expect(all).toHaveLength(SETTINGS_ITEMS.length)
    const selected = all.filter(row => row.startsWith(' data-selected="true"'))
    expect(selected).toHaveLength(1)
    const [row] = selected
    expect(row).toContain(EN['settings.workspace.title'])
    expect(row).toContain(`<span data-slot="entity-row-title" class="font-medium text-foreground truncate">${EN['settings.workspace.title']}</span>`)
    expect(row).toContain(`<span data-slot="entity-row-subtitle" class="text-label-sm text-secondary line-clamp-1">${EN['settings.workspace.description']}</span>`)
    // Selection is the fill, never weight; the hairline hides under a selected row.
    expect(row).toContain('bg-fill-selected')
    expect(row).toContain('in-data-[selected]:after:hidden')
    // Boundary: an unselected row carries both slots too, but neither the attribute nor the selected fill.
    const other = all.find(row => row.includes(EN['settings.app.title']!))!
    expect(other.startsWith('>')).toBe(true)
    expect(other).toContain('data-slot="entity-row-title"')
    expect(other).toContain('data-slot="entity-row-subtitle"')
    expect(other).not.toContain('bg-fill-selected')
    expect(other).toContain('hover:bg-fill-hover')
  })

  it('boundary: the bare settings route (null) highlights no row', () => {
    const markup = render(null)
    expect(rows(markup)).toHaveLength(SETTINGS_ITEMS.length)
    expect(markup).not.toContain('data-selected')
    expect(markup).not.toContain('bg-fill-selected')
  })

  it('keeps our item list: the import page is a row, no messaging page exists', () => {
    const ids = SETTINGS_ITEMS.map(item => item.id as string)
    expect(ids).toContain('import')
    expect(ids).not.toContain('messaging')
    expect(render(null)).toContain(EN['settings.import.title'])
  })

  it('negative: the "⋯" is a named button, invisible and unclickable until hover or focus-within', () => {
    for (const row of rows(render('app'))) {
      const { wrapper, trigger } = moreButton(row)
      expect(wrapper).toContain('opacity-0 pointer-events-none')
      expect(wrapper).toContain('group-hover:opacity-100 group-hover:pointer-events-auto')
      expect(wrapper).toContain('group-focus-within:opacity-100 group-focus-within:pointer-events-auto')
      expect(trigger).toContain(`aria-label="${EN['common.more']}"`)
      expect(trigger).toContain('type="button"')
      // A sibling of the row button, never nested inside it (nested buttons are invalid HTML).
      expect(row.indexOf('data-touch-reveal')).toBeGreaterThan(row.indexOf('</button>'))
    }
  })

  it('negative: the open-in-new-window deep link is nessy://, never craftagents://', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'SettingsNavigator.tsx'), 'utf-8')
    // Control: the instrument reads the call that opens the window.
    expect(source).toContain('window.electronAPI.openUrl(')
    expect(source).toContain('window.electronAPI.openUrl(`nessy://settings/${item.id}?window=focused`)')
    expect(source).not.toContain('craftagents://')
  })
})
