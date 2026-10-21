/**
 * D1.148 — the `SessionManager` half of the shared-warning-seam sweep,
 * classified the way WI-v classified codex's.
 *
 * ## The rule, and what it decides here
 *
 * C3.331: the app's own words about its own host, addressed to the person in
 * the chat, are LOCALISED; verbatim quotation of another program's text, and
 * copy addressed to whoever administers a config file, stay English. Nine of
 * this file's `type: 'info'` notices carried a literal message when the sweep
 * reached it. Seven were the app talking to the user and are now `i18n.t`
 * calls. TWO stay English BY DESIGN, and this file is where that decision is
 * met rather than guessed at:
 *
 *  - the hooks/automations **notes** notice wraps strings the config loader
 *    produced. It is WI-v's hook-relay class exactly: a translated frame around
 *    untranslated notes is half a sentence in each language.
 *  - the continuation notice's `summary` is a comma-joined list of internal
 *    reference names, so the same argument applies to a shorter sentence.
 *
 * ## Why the instrument is the SOURCE
 *
 * Each of the seven lives behind a different precondition — an expired
 * approval, a model the catalogue lost, an eviction, a refresh — and driving
 * seven of them would build seven rigs to assert one property that is visible
 * in one read. The property is "this notice goes through the locale layer", and
 * the source is where that is true or false. The positive control is that the
 * read finds the file and its two deliberately-English lines at all.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const SOURCE = readFileSync(join(import.meta.dir, '..', 'SessionManager.ts'), 'utf8')

/** The seven the sweep localised, by the key each one now composes. */
const LOCALISED_NOTICES = [
  'session.notice.permissionRequestExpired',
  'session.notice.modelNotInCatalogue',
  'session.notice.connectionDefaultModelSubstituted',
  'session.notice.sessionModelSubstituted',
  'session.notice.agentEvictedForCeiling',
  'session.notice.imagesNotSent',
  'session.notice.tokenExpiredRefreshing',
] as const

describe('D1.148 · the SessionManager notices, swept', () => {
  test('every localised notice composes through i18n.t and guards the init', () => {
    // The positive control FIRST: an empty read satisfies every `toContain`
    // below by making none of them run on real bytes.
    expect(SOURCE.length).toBeGreaterThan(100_000)

    for (const key of LOCALISED_NOTICES) {
      expect(SOURCE, key).toContain(`i18n.t('${key}'`)
    }
    // `i18n.t` answers the KEY in a process nothing initialised (measured by
    // WI-z on `judgeFailedMarker`), so each of the seven sits behind a guard.
    // Counted, because a single guard at the top of the file would satisfy a
    // `toContain` while six notices still answered with their key.
    const guards = SOURCE.split('if (!i18n.isInitialized) setupI18n()').length - 1
    expect(guards).toBeGreaterThanOrEqual(LOCALISED_NOTICES.length)
  })

  test('both keys of every family are real, with their interpolations', () => {
    const catalogue = en as unknown as Record<string, string>
    for (const key of LOCALISED_NOTICES) {
      // `imagesNotSent` is a PLURAL family, so the bare key does not exist and
      // the `_other` form is what a missing plural rule falls back to.
      const text = catalogue[key] ?? catalogue[`${key}_other`]
      expect(text, key).toBeDefined()
      expect((text ?? '').length, key).toBeGreaterThan(10)
    }
    // The two interpolation names that would break silently: `count` is
    // i18next's plural selector, so the catalogue notice uses `total`, and the
    // images family uses `count` on purpose.
    expect(catalogue['session.notice.modelNotInCatalogue']).toContain('{{total}}')
    expect(catalogue['session.notice.modelNotInCatalogue']).not.toContain('{{count}}')
    expect(catalogue['session.notice.imagesNotSent_other']).toContain('{{count}}')
  })

  test('the two English-by-design notices are still English, and still explained', () => {
    // Not an oversight: a translated frame around an untranslated body is half
    // a sentence in each language. If either of these is localised later, this
    // case is where the decision is re-taken deliberately.
    expect(SOURCE).toContain("'Your hooks and automations configuration has '") // F1.456 — no load claim
    expect(SOURCE).toContain('`Continuation restored without revoked references: ${summary}`')
  })

  test('F1.783 · the auth-retry notice says the credential was REJECTED, never that it expired', () => {
    // `attemptAuthRetry` raises this notice for EVERY auth error it retries: a
    // gateway 401 for a JWT whose `exp` is a year away (release sitting SIT-n
    // G10), `invalid_api_key`, `expired_oauth_token`, a plain auth message. A
    // rejection is true of all of them; an expiry of only some. The key keeps
    // its old name because locale lines are cited by number elsewhere.
    const key = 'session.notice.tokenExpiredRefreshing'
    const enText = (en as unknown as Record<string, string>)[key] ?? ''
    const ruText = (ru as unknown as Record<string, string>)[key] ?? ''
    // Positive: both say the credential was rejected and that a refresh runs.
    expect(enText).toMatch(/\brejected\b/i)
    expect(enText).toMatch(/refreshing/i)
    expect(ruText).toMatch(/отклонен/i)
    expect(ruText).toMatch(/обновляем/i)
    // Negative: neither claims expiry (the SIT-n wording).
    expect(enText).not.toMatch(/expir/i)
    expect(ruText).not.toMatch(/ист[её]к|просроч/i)
  })
})
