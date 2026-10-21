/**
 * Fire-time policy for session-scoped scheduled tasks (R27b Task 2).
 *
 * Pure decisions only — no timer, no filesystem, no session. The service that
 * ticks calls into this so every rule below can be tested against a fixed clock.
 *
 * Contract source, `scheduled-tasks.md` read raw:
 * - `:172` — "The scheduler checks every second for due tasks and enqueues them
 *   at low priority. A scheduled prompt fires between your turns, not while
 *   Claude is mid-response. If Claude is busy when a task comes due, the prompt
 *   waits until the current turn ends."
 * - `:178` — "the scheduler adds a deterministic offset to fire times".
 * - `:180` — "Recurring tasks fire up to 30 minutes after the scheduled time
 *   (or up to half the interval, for tasks that run more often than hourly). An
 *   hourly job scheduled for `:00` may fire anywhere up to `:30`."
 * - `:181` — "One-shot tasks scheduled for the top or bottom of the hour fire up
 *   to 90 seconds early."
 * - `:183` — "The offset is derived from the task ID, so the same task always
 *   gets the same offset. If exact timing matters, pick a minute that is not
 *   `:00` or `:30` … and the one-shot jitter will not apply."
 * - `:187` — "Recurring tasks automatically expire 7 days after creation. The
 *   task fires one final time, then deletes itself."
 * - `:215` — "No catch-up for missed fires. If a task's scheduled time passes
 *   while Claude is busy on a long-running request, it fires once when Claude
 *   becomes idle, not once per missed interval."
 * - `:216` — resuming "restores tasks that have not expired: recurring tasks
 *   within seven days of creation, and one-shot tasks whose scheduled time has
 *   not yet passed."
 */

import { cronIntervalMs, nextCronRun, parseCronExpression } from '@nessy-agent/session-tools-core'
import { SESSION_CRON_EXPIRY_MS, type SessionCronRecord } from './cron-store.ts'

/** `:180` — the recurring ceiling when the task runs hourly or less often. */
export const CRON_RECURRING_MAX_JITTER_MS = 30 * 60_000

/** `:181` — one-shot tasks on the hour or half hour fire up to this much EARLY. */
export const CRON_ONE_SHOT_EARLY_JITTER_MS = 90_000

/** `:180` — "more often than hourly" is the half-the-interval case. */
const ONE_HOUR_MS = 60 * 60_000

/**
 * FNV-1a over the task id, as a fraction in `[0, 1)`.
 *
 * `:183` makes the offset a function of the id and nothing else, so this must
 * be stable across PROCESSES, not merely within one: a resumed session has to
 * reproduce the same fire time a previous process computed. `Math.imul` with an
 * unsigned shift keeps it exact 32-bit integer arithmetic, which no engine,
 * locale, seed or `Math.random` state can perturb.
 */
export function cronJitterFraction(taskId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < taskId.length; index += 1) {
    hash ^= taskId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

/**
 * The signed offset applied to one scheduled time, in milliseconds.
 *
 * Positive (late) for recurring tasks, negative (early) for the one-shot case,
 * and exactly zero for a one-shot whose minute is neither `:00` nor `:30` —
 * `:183` states that as the way to opt out of jitter, so it is a real branch and
 * not a rounding artefact.
 *
 * @param intervalMs the measured gap between consecutive fires, or `null` when
 *   the expression fires at most once. Only the recurring bound uses it.
 */
export function cronJitterOffsetMs(
  record: Pick<SessionCronRecord, 'id' | 'recurring' | 'dynamic'>,
  scheduledAt: Date,
  intervalMs: number | null,
): number {
  // `:74` — "The jitter rules don't apply to" a dynamically scheduled loop.
  // Its fire time is a wakeup the model chose, not a wall-clock cron slot, so
  // there is no thundering herd to spread.
  if (record.dynamic) return 0

  const fraction = cronJitterFraction(record.id)

  if (record.recurring) {
    // "up to 30 minutes … or up to half the interval, for tasks that run more
    // often than hourly". An exactly hourly job keeps the 30-minute ceiling,
    // which `:180`'s own example ("An hourly job scheduled for `:00` may fire
    // anywhere up to `:30`") pins.
    const bound =
      intervalMs !== null && intervalMs < ONE_HOUR_MS
        ? Math.floor(intervalMs / 2)
        : CRON_RECURRING_MAX_JITTER_MS
    return Math.floor(fraction * bound)
  }

  const minute = scheduledAt.getMinutes()
  if (minute !== 0 && minute !== 30) return 0
  return -Math.floor(fraction * CRON_ONE_SHOT_EARLY_JITTER_MS)
}

/**
 * The next fire time for one task, jitter included, searched forward from
 * `after`. `null` when the expression can never match again.
 */
export function nextCronFireTime(record: SessionCronRecord, after: Date): Date | null {
  // R39 — a dynamic record's fire time IS its pending wakeup, jitter-free
  // (`:74`); `schedule` is never parsed for it. Absent `nextFireAt` means the
  // loop is over: the tick plan then expires the record instead of firing it.
  // This branch must run BEFORE the parse — a dynamic record's schedule field
  // holds the literal `dynamic`, which is not a cron expression.
  if (record.dynamic) {
    return record.nextFireAt === undefined ? null : new Date(record.nextFireAt)
  }

  let parsed
  try {
    parsed = parseCronExpression(record.schedule)
  } catch {
    // A record whose expression no longer parses is inert rather than fatal:
    // `CronCreate` validates on the way in, so this can only be a hand-edited
    // or downgraded file.
    return null
  }
  const scheduled = nextCronRun(parsed, after)
  if (!scheduled) return null
  const offset = cronJitterOffsetMs(record, scheduled, record.recurring ? cronIntervalMs(parsed, after) : null)
  return new Date(scheduled.getTime() + offset)
}

/** `:187` — the instant a recurring task's final fire becomes due. */
export function cronExpiresAt(record: SessionCronRecord): number {
  return record.createdAt + SESSION_CRON_EXPIRY_MS
}

/**
 * The cursor a due-check searches forward from.
 *
 * `lastFiredAt` once the task has fired, `createdAt` before that. Using the last
 * DELIVERY rather than the last scheduled occurrence is what implements `:215`:
 * every occurrence missed during a long turn is behind the cursor once the
 * single catch-up fire lands, so none of them can come due a second time.
 */
function cursorFor(record: SessionCronRecord): Date {
  return new Date(record.lastFiredAt ?? record.createdAt)
}

export interface CronFire {
  readonly record: SessionCronRecord
  /** The jittered time this fire was due. Always `<= now`. */
  readonly dueAt: number
  /**
   * `:187` — this is the final fire of an expired recurring task, or the single
   * fire of a one-shot. Either way the record is deleted once it is delivered.
   */
  readonly final: boolean
}

export interface CronTickPlan {
  /** Tasks that came due and are not already waiting to be delivered. */
  readonly fires: readonly CronFire[]
  /**
   * Ids to delete WITHOUT firing: a recurring task whose expression can no
   * longer match, and one whose expiry passed with nothing left to fire.
   */
  readonly expired: readonly string[]
}

export interface CronTickInput {
  readonly tasks: readonly SessionCronRecord[]
  readonly now: number
  /**
   * Ids already enqueued and waiting for the turn to end. `:215` — a task that
   * came due during a busy turn "fires once when Claude becomes idle, not once
   * per missed interval", so an id in here is skipped no matter how many further
   * occurrences pass while it waits.
   */
  readonly pending?: ReadonlySet<string>
  /**
   * Optional memo of `nextCronFireTime`, keyed by task id and cursor. `:172`
   * makes this a once-a-second loop that lives as long as the session, and a
   * yearly expression costs a multi-year day walk to resolve; the memo is
   * invalidated by construction, because the key changes exactly when the
   * answer can (the task fired, or it is a different task).
   */
  readonly fireTimeCache?: Map<string, number | null>
}

/**
 * One scheduler tick: which tasks fire now, and which are simply gone.
 *
 * Pure — the caller enqueues the fires and applies the deletions.
 */
export function planCronTick({ tasks, now, pending, fireTimeCache }: CronTickInput): CronTickPlan {
  const fires: CronFire[] = []
  const expired: string[] = []
  const waiting = pending ?? new Set<string>()

  for (const record of tasks) {
    if (waiting.has(record.id)) continue

    // T8 (e) — a final fire that was enqueued and never delivered. The record
    // was left on disk carrying the marker precisely so the owed prompt could
    // outlive the process (or the runtime) that enqueued it, so it is due NOW,
    // whatever its schedule would say; `flush` removes it once it is delivered.
    // Above the cursor arithmetic because a one-shot's cursor already points
    // past its only occurrence — the very reason the record could not be
    // recovered before this marker existed.
    if (record.owedFire) {
      fires.push({ record, dueAt: now, final: true })
      continue
    }

    const cursor = cursorFor(record)
    let dueAtMs: number | null
    if (record.dynamic) {
      // R39 — never memoized: the memo key is cursor-derived and a rearm moves
      // `nextFireAt` WITHOUT moving the cursor, so a cached answer would hide
      // the reschedule. The dynamic read is O(1) anyway; the memo exists for
      // cron day-walks.
      dueAtMs = nextCronFireTime(record, cursor)?.getTime() ?? null
    } else {
      const cacheKey = `${record.id}:${cursor.getTime()}`
      let cached = fireTimeCache?.get(cacheKey)
      if (cached === undefined) {
        cached = nextCronFireTime(record, cursor)?.getTime() ?? null
        fireTimeCache?.set(cacheKey, cached)
      }
      dueAtMs = cached
    }
    const dueAt = dueAtMs === null ? null : new Date(dueAtMs)
    if (!dueAt) {
      // Nothing can ever match again. A one-shot in this state has already run,
      // and a dynamic record without a pending wakeup is a loop that is over
      // (R39); either way the record is dead weight. The service protects a
      // just-delivered fallback iteration from this sweep via `pending` while
      // the iteration may still reschedule.
      expired.push(record.id)
      continue
    }
    if (dueAt.getTime() > now) continue

    // `:187` — the FIRST fire at or after the expiry instant is the final one.
    // It is delivered and then the record deletes itself; skipping it would be
    // the off-by-one this rule is most often implemented as.
    const final = !record.recurring || dueAt.getTime() >= cronExpiresAt(record)
    fires.push({ record, dueAt: dueAt.getTime(), final })
  }

  return { fires, expired }
}

export interface CronRestorePlan {
  readonly keep: readonly SessionCronRecord[]
  readonly drop: readonly SessionCronRecord[]
}

/**
 * `:216` — the resume sweep. "Recurring tasks within seven days of creation,
 * and one-shot tasks whose scheduled time has not yet passed."
 *
 * A recurring task exactly at its expiry is KEPT, because `:187` still owes it
 * one final fire; the tick plan delivers that fire and then deletes it. Dropping
 * it here would swallow the fire the contract promises.
 *
 * T8 (f) — a DUELESS DYNAMIC record is dropped here, and that is INTENDED.
 * A `dynamic` record with no `nextFireAt` is a self-paced loop whose last
 * iteration ended without a `ScheduleWakeup`: `nextCronFireTime` answers `null`
 * for it, `owedFinalFire` is therefore false, and it lands in `drop`. The only
 * thing that keeps such a record alive is `SessionCronService`'s IN-MEMORY
 * `awaitingReschedule` set, which shields it for exactly as long as the
 * delivered iteration might still reschedule — deliberately in memory, because
 * the shield is scoped to one live iteration and a record that outlived the
 * process running it has no iteration left to wait for. `:130`'s "ends the loop
 * when that iteration doesn't reschedule either" is the same outcome by a
 * shorter route, so a restore that ends the loop is the contract, not a loss.
 * The counterpart note is on `SessionCronService.sweepAwaitingReschedule`.
 */
export function planCronRestore(tasks: readonly SessionCronRecord[], now: number): CronRestorePlan {
  const keep: SessionCronRecord[] = []
  const drop: SessionCronRecord[] = []

  for (const record of tasks) {
    // T8 (e) — an owed final fire outranks every expiry rule below: the record
    // is on disk only because a delivery is still owed, and the tick plan is
    // what settles it. T10 — that is an exemption from `:187` with NO clock on
    // it, i.e. a deliberate permanent-retention class bounded by the session
    // rather than by seven days; the reasoning is written out on the `owedFire`
    // field in `cron-store.ts`, next to the marker itself.
    if (record.owedFire) {
      keep.push(record)
      continue
    }
    if (record.recurring) {
      const owedFinalFire = nextCronFireTime(record, cursorFor(record)) !== null
      if (owedFinalFire && now <= cronExpiresAt(record)) keep.push(record)
      else drop.push(record)
      continue
    }
    const fireAt = nextCronFireTime(record, cursorFor(record))
    if (fireAt && fireAt.getTime() > now) keep.push(record)
    else drop.push(record)
  }

  return { keep, drop }
}
