/**
 * P6.868 — the `crossSessionInbound` selector, asserted as SOURCE.
 *
 * Read as source rather than rendered, like its sibling
 * `notification-scope-note.test.ts`: `AppSettingsPage`'s module graph reaches
 * `@nessy-agent/ui`, which `app-settings-managed-updates.test.ts` already records
 * as unrenderable here, and a render test on this page costs minutes for an
 * answer a source assertion gives exactly.
 *
 * Four things are asserted, because each can rot on its own:
 *  1. the FOUR states are offered — the three vendor spellings plus the
 *     documented unset, whose write is `null`;
 *  2. the selector is HIDDEN while the operator control holds the key, not
 *     disabled — the page's own rule, and a disabled control would invite the
 *     user to argue with a value chosen somewhere else;
 *  3. the picker's sentinel never reaches the store;
 *  4. every string is in BOTH locales.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Static, at the top: a dynamic `await import` inside a case spends the whole
// module graph against the 5 s per-test timer (AGENTS.md §Traps, W9-u).
import { crossSessionInboundUnrecognizedSentence } from '@nessy-agent/shared/config/storage'

const PAGE = fileURLToPath(new URL('../AppSettingsPage.tsx', import.meta.url))
const LOCALES = (locale: string): string => fileURLToPath(new URL(
  `../../../../../../../packages/shared/src/i18n/locales/${locale}.json`,
  import.meta.url,
))

const source = readFileSync(PAGE, 'utf8')

describe('P6.868 — the four-state cross-session inbound selector', () => {
  it('reads and writes through the one resolved pair, not a local composition', () => {
    expect(source).toContain('window.electronAPI.getCrossSessionInboundSettings()')
    expect(source).toContain('window.electronAPI.setCrossSessionInbound(mode)')
  })

  it('offers the three vendor spellings from the shared constant, never a hand-typed list', () => {
    // The list is mapped from `CROSS_SESSION_INBOUND_SETTINGS`, so a fourth
    // vendor value would appear here without an edit — and a value this page
    // spelled itself could drift from `sdk.d.ts` in silence.
    expect(source).toContain('CROSS_SESSION_INBOUND_SETTINGS.map(mode => ({')
    expect(source).toContain('settings.crossSessionInbound.mode.${mode}')
  })

  it('offers unset as its own option and writes null for it', () => {
    expect(source).toContain('settings.crossSessionInbound.mode.unset')
    expect(source).toContain('handleCrossSessionInboundChange(null)')
    // The sentinel is compared and mapped BEFORE the writer, so it cannot reach
    // `config.json` — where it would be the very sentinel the store refuses.
    expect(source).toContain("const UNSET_CROSS_SESSION_INBOUND = '__unset__'")
    expect(source).toContain('if (value === UNSET_CROSS_SESSION_INBOUND) {')
  })

  it('HIDES the selector while the operator control holds the key, and never disables it', () => {
    // P6.1015 added the second half of "holds the key": an operator value this
    // host cannot READ refuses every message (`explicit: true`, P6.872), so the
    // selector cannot reach the outcome then either and is hidden for the same
    // reason. Both flags in one guard, asserted as one string so neither can be
    // dropped while the other keeps the test green.
    expect(source).toContain('{!inbound.operatorLocked && !inbound.operatorUnreadable && (')
    // The negative half: no `disabled` prop anywhere in the selector's block.
    // Bounded to the section so an unrelated `disabled` elsewhere on the page
    // cannot satisfy or break it.
    const start = source.indexOf('settings.crossSessionInbound.title')
    const end = source.indexOf('settings.tools.title')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).not.toContain('disabled=')
  })

  it('names the environment variable and its value in the hidden state', () => {
    expect(source).toContain('settings.crossSessionInbound.operatorLocked')
    expect(source).toContain('env: CROSS_SESSION_INBOUND_ENV_NAME')
    expect(source).toContain('mode: inbound.operatorMode')
  })

  /**
   * P6.1015 — the state the lock deliberately does not name.
   *
   * POSITIVE: an operator value this host cannot read renders its OWN sentence
   * and takes the selector away. NEGATIVE: `operatorLocked` keeps its own
   * narrow sentence and its own `{{mode}}`, so the two states cannot collapse
   * into one — which is what a widened `operatorLocked` would have done, with a
   * typo rendering *is set to “undefined” on this machine*.
   */
  it('names an operator value it cannot READ, in a sentence of its own (P6.1015)', () => {
    expect(source).toContain('{inbound.operatorUnreadable && (')
    expect(source).toContain('settings.crossSessionInbound.operatorUnreadable')
    expect(source).toContain('value: inbound.operatorUnreadable')
    // NEGATIVE: the narrow lock is untouched and still quotes the readable mode.
    expect(source).toContain('settings.crossSessionInbound.operatorLocked')
    expect(source).toContain('mode: inbound.operatorMode')
    // No Clear button in this branch — an environment variable is not this app's
    // to clear, and offering the stored-value fix here would write `config.json`
    // and change nothing the user can see. Bounded to the branch itself.
    const start = source.indexOf('{inbound.operatorUnreadable && (')
    const end = source.indexOf('{inbound.unrecognized && (', start)
    expect(end, 'the unrecognized banner no longer follows this branch').toBeGreaterThan(start)
    expect(source.slice(start, end)).not.toContain('settings.crossSessionInbound.clear')
    // Both sentences exist in both locales, and the new one interpolates the
    // value through the ONE renderer rather than quoting it a second way.
    for (const locale of ['en', 'ru']) {
      const table = JSON.parse(readFileSync(LOCALES(locale), 'utf8')) as Record<string, string>
      const sentence = table['settings.crossSessionInbound.operatorUnreadable']!
      expect(sentence, `${locale} has no unreadable sentence`).toBeTruthy()
      expect(sentence).toContain('{{env}}')
      expect(sentence).toContain('{{value}}')
      // It names the three accepted values, the same way its `unrecognized`
      // sibling does — a user told only "not readable" cannot fix anything.
      for (const value of ['accept', 'hold', 'refuse']) {
        expect(sentence, `${locale} unreadable sentence does not name ${value}`).toContain(value)
      }
      // And it must NOT interpolate `{{mode}}`: there is no readable mode in
      // this state, which is the whole reason the key exists.
      expect(sentence).not.toContain('{{mode}}')
    }
  })

  it('says the two project files can tighten whatever is chosen', () => {
    expect(source).toContain('settings.crossSessionInbound.scopeNote')
  })

  it('gives an unreadable stored value a notice AND a way out', () => {
    expect(source).toContain('{inbound.unrecognized && (')
    expect(source).toContain('settings.crossSessionInbound.unrecognized')
    expect(source).toContain('settings.crossSessionInbound.clear')
  })

  it('P6.952 — the banner and the doctor report agree, and only the banner has its own voice', () => {
    // The two surfaces are on ONE page — this section and
    // `<SettingsConfigDoctorSection />` (which renders `buildConfigDoctorReport`
    // as text and re-words nothing, so it inherits
    // `crossSessionInboundUnrecognizedSentence` through `validateConfig()`).
    // With an unreadable value both are visible at once, so what they share must
    // not disagree.
    expect(source).toContain('<SettingsConfigDoctorSection />')
    // NEGATIVE HALF: the doctor section must not grow a wording of its own. Its
    // whole design is one renderer for the report, and a `crossSessionInbound`
    // string appearing there would be a fourth voice on the same page.
    const doctorSection = readFileSync(
      fileURLToPath(new URL('../SettingsConfigDoctorSection.tsx', import.meta.url)),
      'utf8',
    )
    expect(doctorSection).not.toContain('crossSessionInbound')

    // The banner keeps its own sentence — it is localized and it points at the
    // Clear button — but it names the same three values the diagnostic names,
    // and says the same thing about what happens meanwhile.
    const diagnostic = crossSessionInboundUnrecognizedSentence('"reject"')
    for (const value of ['accept', 'hold', 'refuse']) {
      expect(diagnostic, `the diagnostic stopped naming ${value}`).toContain(value)
    }
    for (const locale of ['en', 'ru']) {
      const table = JSON.parse(readFileSync(LOCALES(locale), 'utf8')) as Record<string, string>
      const banner = table['settings.crossSessionInbound.unrecognized']!
      for (const value of ['accept', 'hold', 'refuse']) {
        expect(banner, `${locale} banner does not name ${value}`).toContain(value)
      }
      // The value itself is rendered ONCE, by
      // `describeUnrecognizedCrossSessionInbound` (the P6.868 rule) — the banner
      // interpolates that output rather than quoting the raw value again.
      expect(banner).toContain('{{value}}')
    }
    expect(source).toContain('value: inbound.unrecognized')
  })

  it('carries every string in both locales', () => {
    const keys = [
      'settings.crossSessionInbound.clear',
      'settings.crossSessionInbound.desc',
      'settings.crossSessionInbound.label',
      'settings.crossSessionInbound.mode.accept',
      'settings.crossSessionInbound.mode.hold',
      'settings.crossSessionInbound.mode.refuse',
      'settings.crossSessionInbound.mode.unset',
      'settings.crossSessionInbound.operatorLocked',
      'settings.crossSessionInbound.operatorUnreadable',
      'settings.crossSessionInbound.scopeNote',
      'settings.crossSessionInbound.title',
      'settings.crossSessionInbound.unrecognized',
    ]
    for (const locale of ['en', 'ru']) {
      const table = JSON.parse(readFileSync(LOCALES(locale), 'utf8')) as Record<string, string>
      for (const key of keys) expect(table[key]).toBeTruthy()
    }
  })
})
