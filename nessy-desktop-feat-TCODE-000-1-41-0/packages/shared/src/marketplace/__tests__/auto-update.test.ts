/**
 * `discover-plugins.md` § Configure auto-updates, fetched 2026-08-07.
 *
 * `:445` — "Claude Code checks for marketplace and plugin updates after your
 * session starts, with a random delay of up to ten minutes, so the running
 * session keeps using the versions it loaded at launch."
 *
 * The delay is the contract, so it is asserted rather than assumed — and every
 * clock is injected, so no test here sleeps.
 */
import { describe, expect, it } from 'bun:test';
import {
  MARKETPLACE_AUTO_UPDATE_MAX_DELAY_MS,
  resolveMarketplaceAutoUpdateGate,
  scheduleMarketplaceAutoUpdate,
} from '../auto-update.ts';

/** A timer that records instead of firing, so the caller decides when time passes. */
function recordingTimer() {
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const cleared: unknown[] = [];
  return {
    scheduled,
    cleared,
    setTimer: (callback: () => void, delayMs: number) => {
      scheduled.push({ callback, delayMs });
      return scheduled.length - 1;
    },
    clearTimer: (handle: unknown) => { cleared.push(handle); },
    /** Advance to the point the single scheduled check fires. */
    fire: () => { scheduled.at(-1)?.callback(); },
  };
}

describe('resolveMarketplaceAutoUpdateGate', () => {
  it('runs by default', () => {
    expect(resolveMarketplaceAutoUpdateGate({})).toEqual({ run: true, reason: 'default' });
  });

  it(':458 — DISABLE_AUTOUPDATER turns the check off', () => {
    expect(resolveMarketplaceAutoUpdateGate({ DISABLE_AUTOUPDATER: '1' }))
      .toEqual({ run: false, reason: 'disabled-by-env' });
  });

  it(':460 — FORCE_AUTOUPDATE_PLUGINS=1 is the documented escape hatch from it', () => {
    expect(resolveMarketplaceAutoUpdateGate({ DISABLE_AUTOUPDATER: '1', FORCE_AUTOUPDATE_PLUGINS: '1' }))
      .toEqual({ run: true, reason: 'forced' });
  });

  it('reads the escape hatch only against a disable that is actually set', () => {
    // On its own it is not a second switch: the check already runs.
    expect(resolveMarketplaceAutoUpdateGate({ FORCE_AUTOUPDATE_PLUGINS: '1' }))
      .toEqual({ run: true, reason: 'default' });
    // And an explicitly-off disable is not a disable.
    expect(resolveMarketplaceAutoUpdateGate({ DISABLE_AUTOUPDATER: '0' }))
      .toEqual({ run: true, reason: 'default' });
  });
});

describe('scheduleMarketplaceAutoUpdate', () => {
  it(':445 — defers the check by a random delay bounded by ten minutes', async () => {
    const timer = recordingTimer();
    let ran = 0;
    const handle = scheduleMarketplaceAutoUpdate({
      env: {},
      random: () => 0.5,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      run: async () => { ran += 1; },
    });

    expect(handle.scheduled).toBe(true);
    expect(MARKETPLACE_AUTO_UPDATE_MAX_DELAY_MS).toBe(600_000);
    expect(handle.delayMs).toBe(300_000);
    expect(timer.scheduled).toHaveLength(1);
    // The whole point of the delay: nothing has run yet, so the session still
    // holds the versions it loaded at launch.
    expect(ran).toBe(0);

    timer.fire();
    await Promise.resolve();
    expect(ran).toBe(1);
  });

  it('never exceeds the ceiling, whatever the random source returns', () => {
    const timer = recordingTimer();
    for (const random of [() => 0, () => 0.999_999, () => 5, () => Number.NaN]) {
      const handle = scheduleMarketplaceAutoUpdate({
        env: {}, random, setTimer: timer.setTimer, clearTimer: timer.clearTimer, run: async () => {},
      });
      expect(handle.delayMs).toBeGreaterThanOrEqual(0);
      expect(handle.delayMs).toBeLessThanOrEqual(MARKETPLACE_AUTO_UPDATE_MAX_DELAY_MS);
    }
  });

  it('schedules NOTHING when DISABLE_AUTOUPDATER suppresses it', () => {
    const timer = recordingTimer();
    let ran = 0;
    const handle = scheduleMarketplaceAutoUpdate({
      env: { DISABLE_AUTOUPDATER: '1' },
      random: () => 0,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      run: async () => { ran += 1; },
    });

    expect(handle.scheduled).toBe(false);
    expect(handle.gate.reason).toBe('disabled-by-env');
    expect(timer.scheduled).toEqual([]);
    expect(ran).toBe(0);
  });

  it('cancels before firing, and a cancelled timer that still fires runs nothing', async () => {
    const timer = recordingTimer();
    let ran = 0;
    const handle = scheduleMarketplaceAutoUpdate({
      env: {}, random: () => 0, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
      run: async () => { ran += 1; },
    });
    handle.cancel();
    handle.cancel();
    expect(timer.cleared).toHaveLength(1);

    timer.fire();
    await Promise.resolve();
    expect(ran).toBe(0);
  });

  it('swallows a failing pass rather than raising an unhandled rejection', async () => {
    const timer = recordingTimer();
    scheduleMarketplaceAutoUpdate({
      env: {}, random: () => 0, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
      run: async () => { throw new Error('network down'); },
    });
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
  });
});
