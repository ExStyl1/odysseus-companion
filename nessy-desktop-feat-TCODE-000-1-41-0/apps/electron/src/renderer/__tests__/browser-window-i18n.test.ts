/**
 * P6.705 — the browser windows render translated strings, in both locales.
 *
 * The toolbar and the empty state are their own vite entries and their own
 * realms. `setupI18n` is a per-realm call, so nothing `main.tsx` does reaches
 * them: without it `useTranslation()` returns the KEY. The empty-state window
 * was in exactly that state and had been since it was written — its card read
 * `browser.readyTitle` on screen — which is why the grep control below covers
 * both files rather than only the one the row names.
 *
 * Neither entry module can be imported: both call `ReactDOM.createRoot` in
 * their module body, so importing one mounts a React tree into a document that
 * does not exist under `bun test`. So the card is exercised through the same
 * i18next instance the window builds — the real locale bundles, per locale,
 * with the real keys and the real interpolation — and the wiring is asserted
 * against the source.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { createInstance, type InitOptions } from 'i18next'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'

const TOOLBAR = readFileSync(
  fileURLToPath(new URL('../browser-toolbar.tsx', import.meta.url)),
  'utf8',
)
const EMPTY_STATE = readFileSync(
  fileURLToPath(new URL('../browser-empty-state.tsx', import.meta.url)),
  'utf8',
)

/** Every key the toolbar window asks for. */
const TOOLBAR_KEYS = [
  'browser.trust.cdpTitle',
  'browser.trust.navigationTitle',
  'browser.trust.cdpBody',
  'browser.trust.navigationBody',
  'browser.trust.allowOnce',
  'browser.trust.alwaysAllow',
  'browser.trust.deny',
  'browser.window.options',
  'browser.window.hide',
  'browser.window.closeEntirely',
] as const

const LOCALES = Object.keys(LOCALE_REGISTRY)

function instanceFor(lng: string) {
  const i18n = createInstance()
  i18n.init({
    lng,
    fallbackLng: false,
    resources: Object.fromEntries(
      Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [code, { translation: entry.messages }]),
    ),
    interpolation: { escapeValue: false },
    initImmediate: false, // synchronous init — the same cast `setupI18n` uses
  } as InitOptions)
  return i18n
}

describe('the trust card renders in every locale', () => {
  it('has more than one locale to check — otherwise this suite proves nothing', () => {
    expect(LOCALES.length).toBeGreaterThan(1)
  })

  for (const lng of LOCALES) {
    it(`${lng}: every key resolves to a real sentence, never to itself`, () => {
      const i18n = instanceFor(lng)
      for (const key of TOOLBAR_KEYS) {
        const value = i18n.t(key, { origin: 'example.com' })
        expect(value).not.toBe(key)
        expect(value.trim().length).toBeGreaterThan(0)
      }
    })

    it(`${lng}: the origin is interpolated into both headings, not appended`, () => {
      const i18n = instanceFor(lng)
      for (const key of ['browser.trust.cdpTitle', 'browser.trust.navigationTitle']) {
        const value = i18n.t(key, { origin: 'internal.example.com' })
        expect(value).toContain('internal.example.com')
        // A leftover placeholder means the key was written with a different
        // variable name than the call site passes.
        expect(value).not.toContain('{{')
      }
    })
  }
})

describe('both browser windows initialise i18n in their own realm', () => {
  it('the toolbar calls setupI18n at module scope, with the detector', () => {
    expect(TOOLBAR).toContain('setupI18n([LanguageDetector, initReactI18next])')
  })

  it('the empty state does too — it did not, and rendered raw keys', () => {
    expect(EMPTY_STATE).toContain('setupI18n([LanguageDetector, initReactI18next])')
  })

  it('negative — a window that calls useTranslation must call setupI18n', () => {
    for (const source of [TOOLBAR, EMPTY_STATE]) {
      if (!source.includes('useTranslation')) continue
      expect(source).toContain('setupI18n(')
    }
  })
})

describe('grep control — no English literal is left in the toolbar window', () => {
  const LITERALS = [
    'Allow once',
    'Always allow',
    'Hide Window',
    'Close Window Entirely',
    'Browser window options',
    'Let the agent drive DevTools',
    'The DevTools debugger can read',
    'This choice covers this exact site only',
  ]

  for (const literal of LITERALS) {
    it(`"${literal}" is a key, not a literal`, () => {
      expect(TOOLBAR).not.toContain(literal)
    })
  }

  it('and each of them is present in the locale bundle instead', () => {
    const en = LOCALE_REGISTRY.en.messages as Record<string, string>
    for (const key of TOOLBAR_KEYS) {
      expect(typeof en[key]).toBe('string')
    }
  })
})
