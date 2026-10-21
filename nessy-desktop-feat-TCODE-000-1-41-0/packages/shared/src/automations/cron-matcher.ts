/**
 * Cron Matching Utilities for Automations
 *
 * Determines if a cron expression matches the current time.
 * Used by SchedulerTick automations to trigger at specific intervals.
 */

import { Cron } from 'croner';
import { createLogger } from '../utils/debug.ts';

const log = createLogger('cron-matcher');

/**
 * Check if a cron expression matches the current time.
 * Uses croner's nextRun to determine if the current minute matches the cron pattern.
 *
 * @param cronExpr - Cron expression in 5-field format (minute hour day-of-month month day-of-week)
 * @param timezone - Optional IANA timezone (e.g., "Europe/Budapest", "America/New_York")
 * @returns true if the cron expression matches the current minute
 *
 * The renderer's next-run display (`computeNextRuns`, apps/electron/src/renderer/components/automations/utils.ts)
 * builds its Cron with the same zone rule, so the list, the info page and this matcher agree on the hour (UB14.49).
 *
 * @example
 * matchesCron('* * * * *')                    // Matches every minute
 * matchesCron('0 9 * * *', 'Europe/Budapest') // Matches 9:00 AM Budapest time
 */
export function matchesCron(cronExpr: string, timezone?: string): boolean {
  try {
    const options = timezone ? { timezone } : {};
    const job = new Cron(cronExpr, options);
    const now = new Date();

    // Get start of current minute (floored to :00 seconds)
    const startOfMinute = new Date(now);
    startOfMinute.setSeconds(0, 0);

    // Check from 1 second before the start of this minute
    const checkFrom = new Date(startOfMinute.getTime() - 1000);
    const nextRun = job.nextRun(checkFrom);

    log.debug(`[matchesCron] cron=${cronExpr}, tz=${timezone || 'default'}`);
    log.debug(`[matchesCron] now=${now.toISOString()}, startOfMinute=${startOfMinute.toISOString()}`);
    log.debug(`[matchesCron] checkFrom=${checkFrom.toISOString()}, nextRun=${nextRun?.toISOString() || 'null'}`);

    // If nextRun falls within the current minute, we have a match
    if (!nextRun) {
      log.debug(`[matchesCron] No nextRun, returning false`);
      return false;
    }

    const matches = nextRun.getTime() >= startOfMinute.getTime() &&
           nextRun.getTime() < startOfMinute.getTime() + 60_000;
    log.debug(`[matchesCron] matches=${matches} (nextRun ${nextRun.getTime()} vs startOfMinute ${startOfMinute.getTime()} to ${startOfMinute.getTime() + 60_000})`);
    return matches;
  } catch (e) {
    console.error(`[matchesCron] Error:`, e);
    return false;
  }
}

/**
 * The most recent occurrence of a cron expression strictly BEFORE `before`.
 *
 * Additive on purpose: {@link matchesCron} answers "is it now?" against the
 * process clock and has six callers plus pinned tests, so the catch-up sweep —
 * which must ask "when did this last fire?" about an arbitrary instant — gets
 * its own entry point rather than a new parameter on that one.
 *
 * `before` is EXCLUSIVE, which is croner's own `previousRuns(n, reference)`
 * semantics (verified against croner 10.0.1: a reference sitting exactly on an
 * occurrence returns the one before it, not itself). Callers that mean "at or
 * before the current minute" therefore pass the END of that minute.
 *
 * @returns epoch ms of the occurrence, or null when the expression has no past
 *   occurrence or cannot be parsed. Never throws.
 */
export function previousOccurrence(
  cronExpr: string,
  timezone: string | undefined,
  before: number,
): number | null {
  try {
    const job = new Cron(cronExpr, timezone ? { timezone } : {});
    const [previous] = job.previousRuns(1, new Date(before));
    if (!previous) return null;
    const at = previous.getTime();
    return Number.isFinite(at) ? at : null;
  } catch (e) {
    log.debug(`[previousOccurrence] Error for cron=${cronExpr}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
