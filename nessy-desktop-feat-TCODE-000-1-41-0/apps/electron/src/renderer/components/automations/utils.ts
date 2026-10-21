/**
 * Shared automation utilities.
 *
 * Cron helpers used by CronBuilder (visual editor) and AutomationInfoPage (info display).
 * Time formatting shared by AutomationsListPanel and AutomationEventTimeline.
 */

import { Cron } from 'croner'

/**
 * One relative time, as a translation KEY plus its count — never as a rendered
 * string. P2.518.
 *
 * This returns a descriptor for the same reason `mcpRowAuthMarkerKey` in
 * `McpServersPanel.tsx` does: the decision of WHICH phrase applies is then
 * testable without a renderer, and it cannot disagree between the two surfaces
 * that ask for it. It is also the only shape that works here, because this module
 * is not a component and has no `t` of its own.
 *
 * ## The hole this closes
 *
 * `formatShortRelativeTime` returned HARDCODED ENGLISH — `'Just now'`,
 * `` `${minutes}m ago` `` — and `AutomationsListPanel` wrapped that return value
 * in `t('automations.lastRan', { time })`, a translated sentence. So a Russian
 * user read «Последний запуск 5m ago»: half the line translated and half not.
 * Thirteen locale keys existed for exactly this and were reachable by nobody —
 * `common.justNow` and the twelve plural variants of `time.minutesAgo`,
 * `time.hoursAgo`, `time.daysAgo`, all three fully declined in Russian. The
 * reader that used to call them was dropped in `b0053399e`, out of
 * `SourceInfoPage.tsx`, and the four lines above are that reader's own branches
 * recovered from the commit that removed them.
 *
 * ## Long and compact are both wanted, and that is the product question answered
 *
 * The two surfaces are not the same slot, so one form cannot serve both:
 *
 *   - the TOOLTIP is prose (`automations.lastRan` = "Last ran {{time}}"), and
 *     prose takes the long form — which is what the twelve dead keys are, and
 *     what i18next declines correctly through `count`;
 *   - the trailing BADGE is `w-16 shrink-0 whitespace-nowrap` on the timeline and
 *     `whitespace-nowrap` on the list. "5 minutes ago" does not fit a 64 px slot,
 *     so it keeps the compact form — but localized now, through `time.compact.*`,
 *     the keys `shortTimeLocale` in `utils/session.ts` already uses for exactly
 *     this. Its visible change is that the badge reads "5m" rather than "5m ago";
 *     the tooltip beside it says the whole sentence.
 */
export interface RelativeTimeLabel {
  /** An i18next key. Plural families are named by their BASE — i18next appends the suffix. */
  readonly key: string
  /** Passed as `count`, so the plural rule of the active locale decides the variant. */
  readonly count?: number
}

/** The long form, for a sentence. `now` is a parameter so a test needs no clock. */
export function relativeTimeLabel(timestamp: number, now: number = Date.now()): RelativeTimeLabel {
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return { key: 'common.justNow' }
  if (minutes < 60) return { key: 'time.minutesAgo', count: minutes }
  if (hours < 24) return { key: 'time.hoursAgo', count: hours }
  return { key: 'time.daysAgo', count: days }
}

/**
 * Render one descriptor with a caller's `t`.
 *
 * The two-argument shape keeps the DECISION (which key, what count) in a module a
 * test can load, and the RENDERING in the component that owns the i18n instance —
 * so a call site is one expression rather than the same descriptor built twice.
 */
export function renderRelativeTime(
  label: RelativeTimeLabel,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return label.count === undefined ? t(label.key) : t(label.key, { count: label.count })
}

/** The compact form, for a fixed-width badge. Same boundaries, shorter words. */
export function compactTimeLabel(timestamp: number, now: number = Date.now()): RelativeTimeLabel {
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (seconds < 60) return { key: 'common.justNow' }
  if (minutes < 60) return { key: 'time.compact.minutes', count: minutes }
  if (hours < 24) return { key: 'time.compact.hours', count: hours }
  return { key: 'time.compact.days', count: days }
}

/**
 * Describe a cron expression in human-readable form.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'Invalid schedule'

  const [minute, hour, dom, month, dow] = parts

  if (cron.trim() === '* * * * *') return 'Every minute'
  if (minute.startsWith('*/')) return `Every ${minute.slice(2)} minutes`
  if (hour === '*' && minute !== '*') return `Every hour at :${minute.padStart(2, '0')}`
  if (dom === '*' && month === '*') {
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    if (dow === '*') return `Daily at ${time}`
    if (dow === '1-5') return `Weekdays at ${time}`
    if (dow === '0,6') return `Weekends at ${time}`
    return `At ${time} (weekday: ${dow})`
  }
  if (month === '*' && dow === '*') {
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    return `Monthly on day ${dom} at ${time}`
  }
  return cron
}

/**
 * Compute the next N run times for a cron expression using croner.
 * Pass the automation's IANA timezone: the scheduler evaluates the cron in that zone
 * (`matchesCron` in packages/shared/src/automations/cron-matcher.ts), so a 9:00 New York job must not be
 * computed as 9:00 in the viewer's zone. Omitted = the system zone, like the scheduler.
 * UB14.49, v0.15.1:apps/electron/src/renderer/components/automations/utils.ts (first in v0.15.0).
 * An invalid zone makes croner throw, so the caller gets `[]` and shows no next run.
 */
export function computeNextRuns(cron: string, count: number = 3, timezone?: string): Date[] {
  try {
    const job = new Cron(cron, timezone ? { timezone } : {})
    return job.nextRuns(count)
  } catch {
    return []
  }
}
