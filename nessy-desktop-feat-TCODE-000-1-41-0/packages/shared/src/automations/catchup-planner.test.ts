/**
 * desktop-scheduled-tasks.md:74 — "When the app starts or your computer wakes,
 * Desktop checks whether each task missed any runs in the last seven days. If it
 * did, Desktop starts exactly one catch-up run for the most recently missed time
 * and discards anything older. A daily task that missed six days runs once on
 * wake."
 *
 * Every case runs against a fixed clock. The seven-day window is an argument,
 * not a wall-clock wait.
 */

import { describe, expect, it } from 'bun:test';
import { planCatchupFires } from './catchup-planner.ts';
import { AUTOMATION_CATCHUP_WINDOW_MS } from './constants.ts';
import type { AutomationMatcher } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 2026-08-07 11:23 UTC — a Friday, well past 09:00. */
const NOW = Date.parse('2026-08-07T11:23:45.000Z');
const TODAY_9AM_UTC = Date.parse('2026-08-07T09:00:00.000Z');

function daily(overrides: Partial<AutomationMatcher> = {}): AutomationMatcher {
  return {
    id: 'abc123',
    cron: '0 9 * * *',
    timezone: 'UTC',
    actions: [{ type: 'prompt', prompt: 'daily review' }],
    ...overrides,
  };
}

describe('planCatchupFires', () => {
  it('fires exactly once for a daily task that missed six days, and the cursor jumps past all six', () => {
    const plan = planCatchupFires({
      matchers: [daily()],
      state: { abc123: TODAY_9AM_UTC - 6 * DAY_MS },
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([{ matcherId: 'abc123', occurrenceAt: TODAY_9AM_UTC }]);
    expect(plan.cursors).toEqual({ abc123: TODAY_9AM_UTC });
  });

  it('does not fire when the most recent miss is older than the window, but still discards it', () => {
    // A task whose only recent occurrence is 8 days back: cron fires on the 1st
    // of each month and `now` is the 7th, so the last occurrence is > 7 days old.
    const monthly = daily({ id: 'monthly', cron: '0 9 1 * *' });
    const lastFirst = Date.parse('2026-08-01T09:00:00.000Z');

    const plan = planCatchupFires({
      matchers: [monthly],
      state: { monthly: lastFirst - 40 * DAY_MS },
      now: Date.parse('2026-08-20T11:23:45.000Z'),
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([]);
    expect(plan.cursors).toEqual({ monthly: lastFirst });
  });

  it('does not re-fire when the cursor already sits on the occurrence', () => {
    const plan = planCatchupFires({
      matchers: [daily()],
      state: { abc123: TODAY_9AM_UTC },
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([]);
    expect(plan.cursors).toEqual({});
  });

  it('seeds a matcher it has never seen instead of firing it', () => {
    const plan = planCatchupFires({
      matchers: [daily()],
      state: {},
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([]);
    expect(plan.cursors).toEqual({ abc123: TODAY_9AM_UTC });
  });

  it('ignores a disabled matcher entirely — no fire and no cursor', () => {
    const plan = planCatchupFires({
      matchers: [daily({ enabled: false })],
      state: { abc123: TODAY_9AM_UTC - 6 * DAY_MS },
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([]);
    expect(plan.cursors).toEqual({});
  });

  it('ignores a matcher with no id — there is nothing to key a cursor by', () => {
    const plan = planCatchupFires({
      matchers: [daily({ id: undefined })],
      state: {},
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([]);
    expect(plan.cursors).toEqual({});
  });

  it('ignores a matcher with no cron — a SchedulerTick matcher without one never fires', () => {
    const plan = planCatchupFires({
      matchers: [daily({ cron: undefined })],
      state: {},
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.cursors).toEqual({});
  });

  it('resolves the occurrence in the matcher timezone', () => {
    // 09:00 Europe/Budapest on 2026-08-07 is 07:00Z (CEST, UTC+2).
    const plan = planCatchupFires({
      matchers: [daily({ id: 'bud', timezone: 'Europe/Budapest' })],
      state: { bud: 0 },
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toEqual([
      { matcherId: 'bud', occurrenceAt: Date.parse('2026-08-07T07:00:00.000Z') },
    ]);
  });

  it('omitting windowMs is the in-session tick path: cursors advance, nothing fires', () => {
    const plan = planCatchupFires({
      matchers: [daily()],
      state: { abc123: TODAY_9AM_UTC - 6 * DAY_MS },
      now: NOW,
    });

    expect(plan.fires).toEqual([]);
    expect(plan.cursors).toEqual({ abc123: TODAY_9AM_UTC });
  });

  it('never emits more than one fire per matcher, however many occurrences were missed', () => {
    // Every-minute cron, cursor a month back: the doc allows exactly one run.
    const plan = planCatchupFires({
      matchers: [daily({ id: 'minutely', cron: '* * * * *' })],
      state: { minutely: NOW - 30 * DAY_MS },
      now: NOW,
      windowMs: AUTOMATION_CATCHUP_WINDOW_MS,
    });

    expect(plan.fires).toHaveLength(1);
    expect(plan.fires[0]!.occurrenceAt).toBe(Math.floor(NOW / 60_000) * 60_000);
  });
});
