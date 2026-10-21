/**
 * UB15.4 — the Shortcuts page on v0.15.1's material (R5: "row not proposed separately").
 *
 * v0.15.1 `pages/settings/ShortcutsPage.tsx` renders through `SettingsPage` (title + the
 * `settings.shortcuts.description` lede), draws every key with the shared `Kbd` inside a `KbdGroup`
 * (`components/ui/kbd.tsx`, UB13.10) and gives each row `SHORTCUT_ROW_CLASS = 'min-h-11 py-2'`. Ours keeps
 * the rebind controls (P6.49) and the search row (C3.230, C3.317) — the search row is the first thing in
 * the column — and draws the rebind / unbind / reset controls with the shared `Button`.
 *
 * The page is rendered for real (`renderToStaticMarkup` under the real `ActionRegistryProvider`, the real
 * English locale and the shell context `SettingsPage`'s header reads). Effects do not run in a static
 * render, so this is the page's resting state: default bindings, no override, nothing recorded — the
 * state a user first opens. The rebind and lookup answers are driven in `shortcuts-search.test.ts`; the
 * retired surfaces and the live-region wiring stay pinned in `pages/__tests__/shortcuts-surfaces.test.ts`.
 */
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enTranslations from '@nessy-agent/shared/i18n/locales/en.json'
import { ActionRegistryProvider, actionList } from '@/actions'
import { AppShellProvider, type AppShellContextType } from '@/context/AppShellContext'
import { DETAIL_COLUMN_CLASS } from '@/components/settings'
import ShortcutsPage from '../ShortcutsPage'

const PAGE_SOURCE = readFileSync(fileURLToPath(new URL('../ShortcutsPage.tsx', import.meta.url)), 'utf8')

/** Comments quote the shapes these assertions forbid; assert against CODE. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** A local keycap component, as the page declared one until UB15.4. */
const LOCAL_KBD = /\bfunction\s+Kbd\b|\bconst\s+Kbd\s*=/
/** A raw `<kbd …>` element drawn by the page itself instead of the shared primitive. */
const RAW_KBD_ELEMENT = /<kbd[\s>]/

/** The three component sections hold nine rows (`useComponentSpecificSections`). */
const COMPONENT_ROWS = 9

let i18n: I18nInstance
let html = ''

beforeAll(async () => {
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    // The REAL shipped locale: a row whose key is missing renders the raw key, not a passing stub.
    resources: { en: { translation: enTranslations as Record<string, string> } },
    interpolation: { escapeValue: false },
  })
  const appShell = { isCompactMode: false } as unknown as AppShellContextType
  html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AppShellProvider value={appShell}>
        <ActionRegistryProvider>
          <ShortcutsPage />
        </ActionRegistryProvider>
      </AppShellProvider>
    </I18nextProvider>,
  )
})

/** The markup from the detail column's own opening tag onward. */
function column(): string {
  const at = html.indexOf(`<div class="${DETAIL_COLUMN_CLASS}">`)
  expect(at, 'the page does not render the SettingsPage column').toBeGreaterThan(-1)
  return html.slice(at)
}

/** Every rebind control: `[aria-label, inner markup]`. */
function rebindButtons(): Array<[string, string]> {
  return [...html.matchAll(/<button[^>]*aria-label="(Change the shortcut for [^"]*)"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(match => [match[1]!, match[2]!])
}

/** A key group made of shared keycaps and nothing else. */
const KBD_GROUP_OF_CHIPS = /^<kbd data-slot="kbd-group"[^>]*>(?:<kbd data-slot="kbd"[^>]*>[^<]+<\/kbd>)+<\/kbd>$/

describe('UB15.4 · Shortcuts page — v0.15.1 column, shared keycaps, our rebinding and search', () => {
  it('POSITIVE — the page is the SettingsPage column: title h2, the description lede, and the search row first', () => {
    const inner = column()
    expect(inner).toContain('<h2 class="text-title text-foreground">Shortcuts</h2>')
    expect(inner).toContain('>Keyboard shortcuts</p>')
    // Ours: the search row is the first thing under the title, above every table it filters.
    const search = inner.indexOf('data-shortcuts-search')
    const firstSection = inner.indexOf('<section')
    expect(search).toBeGreaterThan(inner.indexOf('Shortcuts</h2>'))
    expect(firstSection).toBeGreaterThan(-1)
    expect(search).toBeLessThan(firstSection)
    expect(inner.slice(search, firstSection)).toContain('data-slot="input"')
    expect(inner.slice(search, firstSection)).toContain('placeholder="Filter commands"')
  })

  it('POSITIVE — every key is a shared Kbd inside a KbdGroup, in the rebind buttons and the component rows alike', () => {
    const buttons = rebindButtons()
    // Every registry action has a row; none is dropped (P6.49's hole) and every one is bound by default.
    expect(buttons.length).toBe(actionList.length)
    for (const [label, inner] of buttons) {
      expect({ label, wrapped: KBD_GROUP_OF_CHIPS.test(inner) }).toEqual({ label, wrapped: true })
    }
    // The rebind control is the shared Button (ghost), not a hand-styled <button>.
    expect(html).toMatch(/<button[^>]*data-slot="button"[^>]*data-variant="ghost"[^>]*aria-label="Change the shortcut for New Chat"/)
    // Groups = one per action row + one per component row; every chip on the page sits in one of them.
    const groups = [...html.matchAll(/<kbd data-slot="kbd-group"[^>]*>((?:<kbd data-slot="kbd"[^>]*>[^<]+<\/kbd>)+)<\/kbd>/g)]
    expect(groups.length).toBe(actionList.length + COMPONENT_ROWS)
    const chipsInGroups = groups.reduce((sum, group) => sum + (group[1]!.match(/data-slot="kbd"/g) ?? []).length, 0)
    expect((html.match(/data-slot="kbd"/g) ?? []).length).toBe(chipsInGroups)
  })

  it('POSITIVE — every shortcut row takes v0.15.1\'s dense row class (44px, not the 56px setting row)', () => {
    const rows = [...html.matchAll(/<div data-layout="settings-row" class="([^"]*)"/g)].map(match => match[1]!)
    expect(rows.length).toBe(actionList.length + COMPONENT_ROWS)
    for (const classes of rows) {
      expect(classes.split(' ')).toEqual(expect.arrayContaining(['min-h-11', 'py-2']))
      // tailwind-merge dropped the 56px row geometry the class overrides.
      expect(classes.split(' ')).not.toContain('min-h-14')
    }
  })

  it('BOUNDARY — at rest every bound row offers Unbind and no row offers Reset (nothing is overridden yet)', () => {
    expect((html.match(/aria-label="Unbind the shortcut for /g) ?? []).length).toBe(actionList.length)
    expect(html).not.toContain('aria-label="Restore the default shortcut for ')
    expect(html).not.toContain('Not bound')
    // The collision notice's live region pre-exists its first message, empty (P6.49).
    expect(html).toContain('<span role="status" aria-live="polite" class="text-label-sm text-tertiary"></span>')
  })

  it('NEGATIVE — the page declares no local Kbd and draws no raw <kbd>: the keycap is the shared primitive', () => {
    const code = codeOf(PAGE_SOURCE)
    expect(code).not.toMatch(LOCAL_KBD)
    expect(code).not.toMatch(RAW_KBD_ELEMENT)
    expect(code).toContain("import { Kbd, KbdGroup } from '@/components/ui/kbd'")
    // Control: the two instruments fire on the shape the page had until UB15.4.
    const planted = 'function Kbd({ children }: { children: React.ReactNode }) {\n  return <kbd className="bg-muted">{children}</kbd>\n}'
    expect(planted).toMatch(LOCAL_KBD)
    expect(planted).toMatch(RAW_KBD_ELEMENT)
  })
})
