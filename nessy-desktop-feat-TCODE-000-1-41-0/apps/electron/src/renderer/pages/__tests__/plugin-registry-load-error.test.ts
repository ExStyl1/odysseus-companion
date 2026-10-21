/**
 * P2.429 — a refused marketplace must not be told to the user in the words of a
 * failed network fetch.
 *
 * The arms that matter, in order of what they defend:
 *
 * 1. The impersonation refusal P6.41 built (`reserved_name`) gets its OWN
 *    sentence, and that sentence differs from both the network sentences and
 *    the generic fallback — the codes' remedies diverge, so the copy must.
 * 2. `fetch_pending` is not a failure at all. Before this row it rode the
 *    "could not be loaded" banner, which was simply false.
 * 3. The fix is GENERAL: every `marketplace.registry.*` code the module that
 *    decides a registry's load verdict can emit is mapped. This is the arm that
 *    fires when a future refusal is added to `registry-source.ts` and nobody
 *    thinks to give it copy — the failure mode this row exists to end.
 * 4. Every key the table names exists in BOTH locales.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  REGISTRY_LOAD_ERROR_FALLBACK_KEY,
  REGISTRY_LOAD_ERROR_MESSAGE_KEYS,
  registryLoadErrorMessageKey,
} from '../plugin-registry-load-error'

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const registrySource = sourceOf('../../../../../../packages/shared/src/marketplace/registry-source.ts')
const pluginsPageSource = sourceOf('../PluginsPage.tsx')
const messages = en as Record<string, string>
const russian = ru as Record<string, string>

describe('registry load-error message mapping', () => {
  it('gives the impersonation refusal its own remedy, not the network one', () => {
    const reserved = registryLoadErrorMessageKey(['marketplace.registry.reserved_name'])
    const failed = registryLoadErrorMessageKey(['marketplace.registry.fetch_failed'])
    const timeout = registryLoadErrorMessageKey(['marketplace.registry.fetch_timeout'])

    expect(reserved).toBe('plugins.registryLoadErrorReservedName')
    expect(new Set([reserved, failed, timeout, REGISTRY_LOAD_ERROR_FALLBACK_KEY]).size).toBe(4)
    expect(messages[reserved]).not.toBe(messages[failed])
    expect(messages[reserved]).not.toBe(messages[REGISTRY_LOAD_ERROR_FALLBACK_KEY])
    // The remedy itself, not just a different sentence: renaming/removing, and
    // an explicit statement that retrying is not the answer.
    expect(messages[reserved]).toMatch(/Rename or remove/)
    expect(messages[failed]).toMatch(/try again/)
  })

  it('stops calling a fetch that is still in flight a failure', () => {
    const pending = registryLoadErrorMessageKey(['marketplace.registry.fetch_pending'])
    expect(pending).toBe('plugins.registryLoadErrorFetchPending')
    expect(messages[pending]).not.toMatch(/could not be/i)
    expect(messages[pending]).toMatch(/still loading/i)
  })

  it('falls back for an unmapped code and for none at all', () => {
    expect(registryLoadErrorMessageKey([])).toBe(REGISTRY_LOAD_ERROR_FALLBACK_KEY)
    expect(registryLoadErrorMessageKey(['marketplace.catalog.rename_cycle']))
      .toBe(REGISTRY_LOAD_ERROR_FALLBACK_KEY)
  })

  it('takes the first MAPPED code, skipping unmapped ones ahead of it', () => {
    expect(registryLoadErrorMessageKey([
      'marketplace.catalog.rename_cycle',
      'marketplace.registry.reserved_name',
    ])).toBe('plugins.registryLoadErrorReservedName')
    expect(registryLoadErrorMessageKey([
      'marketplace.registry.fetch_timeout',
      'marketplace.registry.reserved_name',
    ])).toBe('plugins.registryLoadErrorFetchTimeout')
  })

  it('maps every registry verdict code its own module can emit', () => {
    const emitted = new Set([...registrySource.matchAll(/marketplace\.registry\.[a-z_]+/g)].map(m => m[0]))
    // Positive control: the extraction really reads the file rather than
    // matching an empty set and passing vacuously.
    expect(emitted.has('marketplace.registry.reserved_name')).toBe(true)
    expect(emitted.size).toBeGreaterThanOrEqual(5)
    for (const code of emitted) {
      expect({ code, mapped: code in REGISTRY_LOAD_ERROR_MESSAGE_KEYS })
        .toEqual({ code, mapped: true })
    }
  })

  it('has every mapped key in both locales', () => {
    for (const key of [...Object.values(REGISTRY_LOAD_ERROR_MESSAGE_KEYS), REGISTRY_LOAD_ERROR_FALLBACK_KEY]) {
      expect({ key, en: typeof messages[key], ru: typeof russian[key] })
        .toEqual({ key, en: 'string', ru: 'string' })
      expect(russian[key]).not.toBe(messages[key])
    }
  })

  it('leaves no hard-coded generic note behind on the page', () => {
    expect(pluginsPageSource).toContain('registryLoadErrorMessageKey(loadError.diagnosticCodes)')
    expect(pluginsPageSource).not.toMatch(/t\('plugins\.registryLoadError'\)/)
  })
})
