/**
 * The relative-time label, asserted on VALUES through the real i18next — P2.518.
 *
 * The defect this closes was not a missing translation. Thirteen keys existed and
 * were fully declined in Russian; what was missing was the READER. A helper
 * returned hardcoded English and `AutomationsListPanel` wrapped that return value
 * in a translated sentence, so a Russian user read «Последний запуск 5m ago» —
 * half the line translated, half not. A source-text assertion could not have seen
 * that: the source contained `t('automations.lastRan', …)` and looked correct.
 *
 * So every case below drives the key through the real i18n instance in both
 * locales and asserts on what a user would READ. `now` is a parameter of the
 * subject, so none of this needs a clock.
 */
import { afterAll, describe, expect, it } from 'bun:test'

import { setupI18n } from '@nessy-agent/shared/i18n/setupI18n'

import { compactTimeLabel, relativeTimeLabel, renderRelativeTime } from '../utils'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

const i18n = setupI18n()
const t = (key: string, options?: Record<string, unknown>): string => i18n.t(key, options)

// i18next is global to the bun process and `setupI18n` short-circuits on an
// already-initialized singleton, so whichever file ran first owns the language.
// This file changes it deliberately; leaving it on `ru` would hand English copy
// assertions in a LATER file a Russian string and make it red on a defect that
// does not exist — `transport-connection-banner.test.ts` records that exact bite.
afterAll(async () => {
  await i18n.changeLanguage('en')
})

describe('which phrase applies', () => {
  it('names the base key of a plural family, not a variant', () => {
    // i18next appends `_one`/`_few`/`_many`/`_other` itself from `count`. Naming a
    // variant here would pin one locale's plural rules into the caller.
    expect(relativeTimeLabel(NOW - 5 * MINUTE, NOW)).toEqual({ key: 'time.minutesAgo', count: 5 })
    expect(relativeTimeLabel(NOW - 3 * HOUR, NOW)).toEqual({ key: 'time.hoursAgo', count: 3 })
    expect(relativeTimeLabel(NOW - 9 * DAY, NOW)).toEqual({ key: 'time.daysAgo', count: 9 })
  })

  it('carries no count under a minute, because the phrase has no number in it', () => {
    expect(relativeTimeLabel(NOW - 30_000, NOW)).toEqual({ key: 'common.justNow' })
    expect(compactTimeLabel(NOW - 30_000, NOW)).toEqual({ key: 'common.justNow' })
  })

  it('puts each boundary on the side the old branches put it', () => {
    // Recovered from `b0053399e`, the commit that dropped the original reader:
    // `minutes < 1` / `minutes < 60` / `hours < 24`. An off-by-one here shows up
    // as "60 minutes ago" instead of "1 hour ago", which no gate would catch.
    expect(relativeTimeLabel(NOW - 59_999, NOW).key).toBe('common.justNow')
    expect(relativeTimeLabel(NOW - MINUTE, NOW)).toEqual({ key: 'time.minutesAgo', count: 1 })
    expect(relativeTimeLabel(NOW - 59 * MINUTE, NOW)).toEqual({ key: 'time.minutesAgo', count: 59 })
    expect(relativeTimeLabel(NOW - HOUR, NOW)).toEqual({ key: 'time.hoursAgo', count: 1 })
    expect(relativeTimeLabel(NOW - 23 * HOUR, NOW)).toEqual({ key: 'time.hoursAgo', count: 23 })
    expect(relativeTimeLabel(NOW - DAY, NOW)).toEqual({ key: 'time.daysAgo', count: 1 })
  })

  it('uses the compact vocabulary for the fixed-width badge', () => {
    expect(compactTimeLabel(NOW - 5 * MINUTE, NOW)).toEqual({ key: 'time.compact.minutes', count: 5 })
    expect(compactTimeLabel(NOW - 3 * HOUR, NOW)).toEqual({ key: 'time.compact.hours', count: 3 })
    expect(compactTimeLabel(NOW - 9 * DAY, NOW)).toEqual({ key: 'time.compact.days', count: 9 })
  })
})

describe('what a user actually reads', () => {
  it('renders English through the real instance', async () => {
    await i18n.changeLanguage('en')
    expect(renderRelativeTime(relativeTimeLabel(NOW - 5 * MINUTE, NOW), t)).toBe('5 minutes ago')
    expect(renderRelativeTime(relativeTimeLabel(NOW - MINUTE, NOW), t)).toBe('1 minute ago')
    expect(renderRelativeTime(relativeTimeLabel(NOW - 30_000, NOW), t)).toBe('Just now')
    expect(renderRelativeTime(compactTimeLabel(NOW - 5 * MINUTE, NOW), t)).toBe('5m')
  })

  it('renders Russian, declined — the half of the line that used to stay English', async () => {
    await i18n.changeLanguage('ru')
    // The three Russian plural forms of one family, which is the whole reason the
    // count goes to i18next instead of being interpolated by hand.
    expect(renderRelativeTime(relativeTimeLabel(NOW - MINUTE, NOW), t)).toBe('1 минуту назад')
    expect(renderRelativeTime(relativeTimeLabel(NOW - 3 * MINUTE, NOW), t)).toBe('3 минуты назад')
    expect(renderRelativeTime(relativeTimeLabel(NOW - 7 * MINUTE, NOW), t)).toBe('7 минут назад')
    expect(renderRelativeTime(relativeTimeLabel(NOW - 30_000, NOW), t)).toBe('Только что')
  })

  it('leaves no key unresolved in either locale — the failure i18next reports by echoing the key', async () => {
    const cases = [30_000, MINUTE, 5 * MINUTE, 7 * MINUTE, HOUR, 3 * HOUR, DAY, 9 * DAY]
    for (const lang of ['en', 'ru']) {
      await i18n.changeLanguage(lang)
      for (const ago of cases) {
        for (const label of [relativeTimeLabel(NOW - ago, NOW), compactTimeLabel(NOW - ago, NOW)]) {
          const value = renderRelativeTime(label, t)
          expect(value, `${label.key} in ${lang}`).not.toBe(label.key)
          expect(value.trim().length, `${label.key} in ${lang}`).toBeGreaterThan(0)
          // The bug in one assertion: the rendered half of a translated sentence
          // must not still be English once the locale is Russian.
          if (lang === 'ru') expect(value, `${label.key}`).not.toMatch(/\b(ago|Just now)\b/)
        }
      }
    }
  })
})
