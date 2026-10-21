/**
 * Which scheduled automations missed a run, and what their cursor becomes.
 *
 * desktop-scheduled-tasks.md:74 — "When the app starts or your computer wakes,
 * Desktop checks whether each task missed any runs in the last seven days. If it
 * did, Desktop starts exactly one catch-up run for the most recently missed time
 * and discards anything older. A daily task that missed six days runs once on
 * wake."
 *
 * "Discards anything older" is implemented by the cursor, not by a loop: only
 * the single most recent past occurrence is ever considered, and moving the
 * cursor to it is what discards the five before it. There is deliberately no
 * enumeration of every missed occurrence — a daily task off for a month must not
 * be able to produce thirty sessions no matter what a later reader adds here.
 *
 * The complementary line governs the in-session path and is NOT this function's
 * job: :70 — "If your computer sleeps through a scheduled time, the run is
 * skipped." While the app is ticking every minute, each occurrence gets its own
 * tick, so the tick path only ADVANCES cursors (omit `windowMs`) and never
 * replays.
 *
 * Pure: the clock, the cursors and the matchers all come in as arguments, so a
 * seven-day window is testable without waiting seven days.
 */

import type { AutomationMatcher } from './types.ts';
import { previousOccurrence } from './cron-matcher.ts';
import type { ScheduleState } from './schedule-state.ts';

export interface CatchupFire {
  readonly matcherId: string;
  /** Epoch ms of the missed occurrence this run is catching up for. */
  readonly occurrenceAt: number;
}

export interface CatchupPlan {
  /** At most one entry per matcher. */
  readonly fires: readonly CatchupFire[];
  /**
   * matcher id -> new cursor. A superset of `fires`: a matcher that is only
   * being seeded, or whose most recent miss fell outside the window, still moves
   * its cursor so the same occurrence is never reconsidered.
   */
  readonly cursors: ScheduleState;
}

export interface CatchupPlanInput {
  /** The `SchedulerTick` matchers of one workspace. */
  readonly matchers: readonly AutomationMatcher[];
  readonly state: ScheduleState;
  /** Epoch ms of the sweep. */
  readonly now: number;
  /**
   * How far back a miss may be and still fire. Omit for the in-session tick
   * path, which advances cursors and never fires.
   */
  readonly windowMs?: number;
}

/** End of the minute containing `now`; see {@link previousOccurrence}'s exclusivity note. */
function endOfMinute(now: number): number {
  return Math.floor(now / 60_000) * 60_000 + 60_000;
}

export function planCatchupFires(input: CatchupPlanInput): CatchupPlan {
  const fires: CatchupFire[] = [];
  const cursors: ScheduleState = {};
  const before = endOfMinute(input.now);

  for (const matcher of input.matchers) {
    const matcherId = matcher.id;
    // No id means no durable identity to key a cursor by — backfillIds gives
    // every persisted matcher one, so this is a hand-written config mid-repair.
    if (!matcherId || !matcher.cron || matcher.enabled === false) continue;

    const occurrenceAt = previousOccurrence(matcher.cron, matcher.timezone, before);
    if (occurrenceAt === null) continue;

    const cursor = input.state[matcherId];
    if (cursor === undefined) {
      // First sight of this matcher. Seed, never fire: an empty state file —
      // fresh install, corrupt read, a task added by hand while the app was
      // closed — must not start a run for every task at once.
      cursors[matcherId] = occurrenceAt;
      continue;
    }
    if (occurrenceAt <= cursor) continue;
    if (input.windowMs === undefined || occurrenceAt < input.now - input.windowMs) {
      // Tick path, or a miss older than the window. Account for it silently.
      cursors[matcherId] = occurrenceAt;
      continue;
    }

    fires.push({ matcherId, occurrenceAt });
    cursors[matcherId] = occurrenceAt;
  }

  return { fires, cursors };
}
