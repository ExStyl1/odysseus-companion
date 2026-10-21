/**
 * F1.226 (P-WJu-6) — the page-level "Some marketplaces could not be loaded."
 * banner has a producer.
 *
 * `MarketplaceBrowsePage` has rendered a `loadErrorNote` above the sections since
 * R3 — the partial state where one registry failed and the rest still render —
 * and nothing passed it: its only other occurrence was a component test. So a
 * registry whose catalogue fetch failed was said only in its OWN section, on its
 * own chip, and a user browsing any other chip learned nothing (F1.81 lands the
 * user on a registry they just added; this covers the one they navigated away
 * from, or one that broke on a later refresh).
 *
 * The controller decided the direction (2026-09-23): wire it from
 * `registryLoadErrors`. The rule, stated once in `registryLoadFailuresElsewhere`:
 * a registry counts when its error is a FAILURE — `fetch_pending` is a fetch in
 * flight and `renamed` a catalogue that is unchanged, the two codes the section
 * notes already say are not failures — and it is not the SELECTED marketplace,
 * whose own section already names the reason in its specific words. The banner
 * reuses `plugins.registryLoadError`, the sentence the prop was written for; no
 * new locale key.
 *
 * `PluginsPage` has no DOM harness in this tree, so the wiring is read from its
 * source (the instrument `add-registry-lands-on-its-section.test.ts` uses for the
 * same page); the rendering of the prop is `MarketplaceComponents.test.tsx`'s.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  REGISTRY_LOAD_ERROR_FALLBACK_KEY,
  registryLoadFailuresElsewhere,
} from '../plugin-registry-load-error'

const failed = (marketplaceId: string, ...diagnosticCodes: string[]) => ({ marketplaceId, diagnosticCodes })

describe('F1.226 · which registry failures the page-level banner stands for', () => {
  const CASES: Array<{ name: string; errors: ReturnType<typeof failed>[]; selected: string; expected: string[] }> = [
    { name: 'a failed fetch on another chip', errors: [failed('acme', 'marketplace.registry.fetch_failed')], selected: 'skills-market', expected: ['acme'] },
    { name: 'a policy refusal and a timeout, both elsewhere', errors: [failed('a', 'marketplace.registry.source_not_allowed'), failed('b', 'marketplace.registry.fetch_timeout')], selected: 'skills-market', expected: ['a', 'b'] },
    { name: 'an unmapped parse error is still a failure', errors: [failed('acme', 'plugin.install.repository_ref_unresolved')], selected: 'skills-market', expected: ['acme'] },
    { name: 'BOUNDARY: a fetch still in flight is not a failure', errors: [failed('acme', 'marketplace.registry.fetch_pending')], selected: 'skills-market', expected: [] },
    { name: 'BOUNDARY: a marketplace that renamed itself is not a failure', errors: [failed('acme', 'marketplace.registry.renamed')], selected: 'skills-market', expected: [] },
    { name: 'BOUNDARY: the selected registry speaks in its own section', errors: [failed('acme', 'marketplace.registry.fetch_failed')], selected: 'acme', expected: [] },
    { name: 'no errors, no banner', errors: [], selected: 'skills-market', expected: [] },
  ]
  for (const row of CASES) {
    it(row.name, () => {
      expect(registryLoadFailuresElsewhere(row.errors, row.selected)).toEqual(row.expected)
    })
  }

  it('the sentence it shows exists in both locales', () => {
    expect((en as Record<string, string>)[REGISTRY_LOAD_ERROR_FALLBACK_KEY]).toBe('Some marketplaces could not be loaded.')
    expect((ru as Record<string, string>)[REGISTRY_LOAD_ERROR_FALLBACK_KEY]).toBeTruthy()
  })
})

describe('F1.226 · PluginsPage passes the banner to the browse page', () => {
  const src = readFileSync(fileURLToPath(new URL('../PluginsPage.tsx', import.meta.url)), 'utf-8')
  const browse = src.slice(src.indexOf('<MarketplaceBrowsePage'), src.indexOf('onRetry={() => void marketplace.refetch()}'))

  it('from the registries\' load errors and the selected chip, in the fallback sentence', () => {
    expect(browse.length, 'the browse-page element was not found').toBeGreaterThan(0)
    expect(browse).toContain('loadErrorNote={registryLoadFailuresElsewhere(marketplace.registryLoadErrors, marketplaceFilter).length > 0 ? t(REGISTRY_LOAD_ERROR_FALLBACK_KEY) : undefined}')
  })

  it('CONTROL: the selected registry\'s own section note is untouched', () => {
    expect(src).toContain('note: t(registryLoadErrorMessageKey(loadError.diagnosticCodes))')
  })
})
