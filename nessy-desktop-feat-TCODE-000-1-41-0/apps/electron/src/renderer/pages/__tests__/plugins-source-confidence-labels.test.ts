/**
 * A0 — every install-source confidence renders a label, never a raw i18n key.
 *
 * `PluginsPage` interpolates the union member straight into the key
 * (`plugins.sourceConfidence.${item.install.sourceConfidence}`) in both
 * `installSourceLabel` (detail rows) and `unsupportedInstallReason` (the
 * blocked-card hint), with no guard. `8bbb1f73` added `coordinates-derived` to
 * the union without a locale entry, so 88 of the 118 live extension rows
 * displayed the literal string `plugins.sourceConfidence.coordinates-derived`.
 *
 * The two named i18n gates are BLIND to that regression: they compare the
 * locales against EACH OTHER, so deleting a key from both leaves
 * `lint:i18n:parity` and `lint:i18n:sorted` at rc=0 (measured by wave 1's
 * reviewer). Nothing else in the repo compares the locales against the key
 * space the code actually asks for. This file is that comparison, and it is
 * exhaustive over the union by construction so a member added later without a
 * key fails immediately rather than after a user reports a raw key on screen.
 */

import { describe, expect, it, mock } from 'bun:test'
import { createInstance, type InitOptions } from 'i18next'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import type { MarketplaceInstallSourceConfidence } from '@nessy-agent/shared/marketplace/types'
import type {
  SafeMarketplaceCatalogItem,
  SafeMarketplaceInstallSourceConfidence,
} from '@nessy-agent/shared/protocol/capabilities'

// PluginsPage transitively imports the info barrel (ThemeContext runs Vite's
// `import.meta.glob`) and pdfjs-dist (worker URL import). Same stubs as
// `capability-info-pages.test.tsx`.
mock.module('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}))
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

/**
 * Exhaustive by TYPE, not by hand: a member added to
 * `SafeMarketplaceInstallSourceConfidence` and missing here fails `typecheck`,
 * and a member added here that no longer exists fails too. The renderer only
 * ever sees the SAFE union (`SafeMarketplaceCatalogItem['install']`), which is
 * why that is the one enumerated — the plan named the domain union
 * (`marketplace/types.ts`), which never reaches a rendered surface.
 */
const CONFIDENCE_MEMBERS: Record<SafeMarketplaceInstallSourceConfidence, true> = {
  'primary': true,
  'fallback': true,
  'command-derived': true,
  'coordinates-derived': true,
  'command-only': true,
  'unsupported-commands': true,
  'missing': true,
}

/**
 * …and the domain union is the thing that FEEDS the safe one, so a member added
 * only in `marketplace/types.ts` must not slip past the record above. Mutual
 * assignability fails `typecheck` the moment the two drift.
 */
type DomainCoveredBySafe =
  MarketplaceInstallSourceConfidence extends SafeMarketplaceInstallSourceConfidence ? true : never
type SafeCoveredByDomain =
  SafeMarketplaceInstallSourceConfidence extends MarketplaceInstallSourceConfidence ? true : never
const UNIONS_AGREE: [DomainCoveredBySafe, SafeCoveredByDomain] = [true, true]

/**
 * The page is imported ONCE, at module scope, and not inside a test.
 *
 * Measured 2026-09-04 at load 17: the FIRST dynamic import of
 * `@/pages/PluginsPage` in this file cost **75 979 ms** against bun's 5 000 ms
 * default, while the three later ones in the same run cost nothing — the module
 * graph reaches `ThemeContext`, the info barrel and pdfjs-dist, and whichever
 * test happens to be first pays for all of it inside a timer. That is the "a
 * single module import in one hook" shape AGENTS.md names, not contention: the
 * redness moves between cases run to run because it is decided by where a yield
 * lands, and the only symptom is a timeout with ZERO assertion failures.
 *
 * Hoisting is preferred over four explicit budgets because a budget has to be
 * set against a measured floor that is itself a property of the machine, and
 * three of the four tests were never paying the cost at all. The `mock.module`
 * calls above run first, which is the ordering this import depends on.
 */
const PluginsPage = await import('@/pages/PluginsPage')

const MEMBERS = Object.keys(CONFIDENCE_MEMBERS) as SafeMarketplaceInstallSourceConfidence[]
const LOCALES = Object.keys(LOCALE_REGISTRY) as (keyof typeof LOCALE_REGISTRY)[]

function catalogItem(
  sourceConfidence: SafeMarketplaceInstallSourceConfidence,
): SafeMarketplaceCatalogItem {
  return {
    marketplaceId: 'internal',
    id: `listing-${sourceConfidence}`,
    kind: 'plugin',
    listKind: 'plugins',
    name: sourceConfidence,
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence },
  }
}

/** The app's own i18next configuration (`setupI18n`), minus the singleton. */
function translatorFor(language: keyof typeof LOCALE_REGISTRY) {
  const instance = createInstance()
  instance.init({
    resources: Object.fromEntries(
      LOCALES.map(code => [code, { translation: LOCALE_REGISTRY[code].messages }]),
    ),
    lng: language,
    fallbackLng: 'en',
    supportedLngs: LOCALES,
    interpolation: { escapeValue: false },
    initImmediate: false, // synchronous init — same cast `setupI18n` uses
  } as InitOptions)
  return (key: string, options?: Record<string, unknown>): string => String(instance.t(key, options))
}

describe('A0 — install-source confidence labels resolve in every locale', () => {
  it('keeps the domain and safe confidence unions in agreement', () => {
    expect(UNIONS_AGREE).toEqual([true, true])
    expect(MEMBERS.length).toBeGreaterThan(0)
  })

  it('every locale bundle carries a non-empty label for every union member', () => {
    const missing: string[] = []
    for (const locale of LOCALES) {
      const messages = LOCALE_REGISTRY[locale].messages as Record<string, string>
      for (const member of MEMBERS) {
        const key = `plugins.sourceConfidence.${member}`
        const value = messages[key]
        if (typeof value !== 'string' || value.trim() === '' || value === key) {
          missing.push(`${locale}:${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('PluginsPage renders a label, never the raw key, for every member in every locale', async () => {
    const { installSourceLabel, unsupportedInstallReason } = PluginsPage
    for (const locale of LOCALES) {
      const t = translatorFor(locale)
      for (const member of MEMBERS) {
        const item = catalogItem(member)
        const label = installSourceLabel(item, t)
        const reason = unsupportedInstallReason(item, t)
        expect(label).not.toContain('plugins.sourceConfidence.')
        expect(label.trim()).not.toBe('')
        expect(reason).not.toContain('plugins.')
        expect(reason).toContain(label)
      }
    }
  })

  it('still prefers the installed row\'s marketplace id over the confidence label', async () => {
    const { installSourceLabel } = PluginsPage
    const installed = {
      ...catalogItem('coordinates-derived'),
      installed: { origin: { marketplaceId: 'internal-market' } },
    } as SafeMarketplaceCatalogItem
    expect(installSourceLabel(installed, translatorFor('en'))).toBe('internal-market')
  })

  /**
   * P2.518 unit 2 — the same defect class as this file's subject, found by the
   * same kind of reading and one interpolation over.
   *
   * The Scopes detail row is a TRANSLATED sentence with a `{{state}}` hole, and
   * the hole was filled with the raw union member: `Глобально: enabled`. This
   * file's existing cases prove a key resolves; these prove the value spliced
   * INTO one does too, which no gate in the tree could see — the key was
   * present in both locales, so parity and sorted were both green while the
   * text on screen was half English.
   */
  const ACTIVATION_STATES: Record<'enabled' | 'disabled' | 'unset' | 'ineligible', true> = {
    enabled: true, disabled: true, unset: true, ineligible: true,
  }

  it('P2.518 — the Scopes row translates the STATE, not just the sentence around it', async () => {
    const { activationLabel } = PluginsPage
    const states = Object.keys(ACTIVATION_STATES) as (keyof typeof ACTIVATION_STATES)[]
    let provedTranslated = 0
    for (const locale of LOCALES) {
      const t = translatorFor(locale)
      const messages = LOCALE_REGISTRY[locale].messages as Record<string, string>
      for (const state of states) {
        // `project` is the only scope whose union carries `ineligible`; the
        // other two are narrower, so the cast is what lets one loop cover all
        // three scopes rather than three loops covering one state each.
        const label = activationLabel({
          effective: 'active',
          global: state as 'enabled' | 'disabled' | 'unset',
          workspace: state as 'enabled' | 'disabled' | 'unset',
          project: state,
        }, t)
        const word = messages[`plugins.scope${state[0]!.toUpperCase()}${state.slice(1)}`]!
        expect(word, `${locale}/${state} has no locale entry`).toBeTruthy()
        // The locale's own word for the state appears once per scope. A dropped
        // or empty state would satisfy any `not.toContain` perfectly, which is
        // why the assertion counts rather than merely denying.
        expect(label.split(word).length - 1, `${locale}/${state}`).toBe(3)
        // ...and where the translation actually differs from the union member,
        // the member itself must be gone. That is vacuous in `en` by design —
        // `plugins.scopeEnabled` IS "enabled" there — so the counter below is
        // the control that some locale exercised it.
        if (word !== state) {
          expect(label, `${locale}/${state}`).not.toContain(state)
          provedTranslated += 1
        }
      }
    }
    // Without this the whole case passes on an English-only bundle, which is the
    // exact blindness that let the raw enum ship.
    expect(provedTranslated).toBeGreaterThan(0)
  })

  it('P2.518 — the EN control: the sentences themselves are unchanged', async () => {
    const { activationLabel } = PluginsPage
    expect(activationLabel(
      { effective: 'active', global: 'enabled', workspace: 'unset', project: 'ineligible' },
      translatorFor('en'),
    )).toBe('Global: enabled, Workspace: not set, Project: not applicable')
    // `project` is optional, and an absent one drops its whole clause rather
    // than rendering an empty state.
    expect(activationLabel(
      { effective: 'active', global: 'disabled', workspace: 'disabled' },
      translatorFor('en'),
    )).toBe('Global: disabled, Workspace: disabled')
  })
})
