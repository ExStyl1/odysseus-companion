import { describe, expect, it, spyOn } from 'bun:test';
import { resolveAutoCompactionSettings } from '../auto-compaction-settings.ts';
import { resetNumericSettingReports } from '../numeric-setting.ts';

describe('resolveAutoCompactionSettings', () => {
  it('defaults on and lets user, managed, or env disable without widening', () => {
    expect(resolveAutoCompactionSettings({ env: {} })).toEqual({ enabled: true });
    expect(resolveAutoCompactionSettings({ userEnabled: false, managedEnabled: true, env: {} }))
      .toEqual({ enabled: false });
    expect(resolveAutoCompactionSettings({ userEnabled: true, managedEnabled: false, env: {} }))
      .toEqual({ enabled: false });
    expect(resolveAutoCompactionSettings({
      userEnabled: true,
      managedEnabled: true,
      env: { DISABLE_AUTO_COMPACT: 'YeS' },
    })).toEqual({ enabled: false });
  });

  it('uses the repository truthiness convention and ignores non-true disable values', () => {
    for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      expect(resolveAutoCompactionSettings({ env: { DISABLE_AUTO_COMPACT: value } }).enabled).toBe(false);
    }
    for (const value of ['0', 'false', 'no', 'off', 'invalid']) {
      expect(resolveAutoCompactionSettings({ env: { DISABLE_AUTO_COMPACT: value } }).enabled).toBe(true);
    }
  });

  it('parses only bounded integer threshold overrides', () => {
    expect(resolveAutoCompactionSettings({
      env: {
        NESSY_AUTOCOMPACT_PCT_OVERRIDE: '50',
        NESSY_AUTO_COMPACT_WINDOW: '100000',
      },
    })).toEqual({
      enabled: true,
      thresholdPercent: 50,
      contextWindow: 100000,
    });

    for (const value of ['0', '101', '1.5', '50x', '-1']) {
      expect(resolveAutoCompactionSettings({
        env: { NESSY_AUTOCOMPACT_PCT_OVERRIDE: value },
      })).toEqual({ enabled: true });
    }
    for (const value of ['0', '-1', '1.5', '100x']) {
      expect(resolveAutoCompactionSettings({
        env: { NESSY_AUTO_COMPACT_WINDOW: value },
      })).toEqual({ enabled: true });
    }
  });

  // P6.565 · the two keys sit on OPPOSITE sides of `env-vars.md#variables`'
  // "except where a variable's row notes it takes plain digits only" clause, so
  // one rule for both was wrong for one of them.
  it('the threshold takes the GENERAL rule — its page row notes no restriction', () => {
    // `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`: "Set the percentage (1-100) of the
    // auto-compact window at which auto-compaction triggers…" — nothing about
    // spelling, so `5e1` is fifty.
    expect(resolveAutoCompactionSettings({ env: { NESSY_AUTOCOMPACT_PCT_OVERRIDE: '5e1' } }))
      .toEqual({ enabled: true, thresholdPercent: 50 });
    // The range still binds on top of the spelling.
    expect(resolveAutoCompactionSettings({ env: { NESSY_AUTOCOMPACT_PCT_OVERRIDE: '1.01e2' } }))
      .toEqual({ enabled: true });
  });

  it('the window takes PLAIN DIGITS ONLY — its page row says so in its own words', () => {
    // `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: "Accepts a plain integer such as
    // `500000` only: a value like `500k` reads as `500` and clamps to the 100K
    // minimum." A sixth plain-digits-only row, spelled differently from the five
    // that use the phrase "plain digits", which is why a phrase search missed it.
    expect(resolveAutoCompactionSettings({ env: { NESSY_AUTO_COMPACT_WINDOW: '500000' } }))
      .toEqual({ enabled: true, contextWindow: 500_000 });
    for (const value of ['5e5', '500_000', '5.0e5']) {
      expect(resolveAutoCompactionSettings({ env: { NESSY_AUTO_COMPACT_WINDOW: value } }), value)
        .toEqual({ enabled: true });
    }
  });
});

/**
 * P6.708 — the refusal is now SAID, on the real production path.
 *
 * `resolveAutoCompactionSettings` takes no sink, so the assertion is made
 * against `console.warn` itself: what an operator would actually see, rather
 * than what an injected function received. The value is still dropped — that
 * part was always right, because "this layer says nothing" is what the absent
 * field means and inventing a number here would override a runtime default we
 * do not know. What changed is that the drop is no longer silent.
 */
describe('a refused numeric value is stated rather than dropped (P6.708)', () => {
  it('names the variable and the accepted form, once, for the page\'s own refused example', () => {
    resetNumericSettingReports();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // `CLAUDE_CODE_AUTO_COMPACT_WINDOW`'s row: "a value like `500k` reads as
      // `500` and clamps to the 100K minimum" — so `500k` is the shape an
      // operator plausibly writes and this fork refuses.
      expect(resolveAutoCompactionSettings({ env: { NESSY_AUTO_COMPACT_WINDOW: '500k' } }))
        .toEqual({ enabled: true });
      // Said once, not once per resolve — these settings are read repeatedly.
      resolveAutoCompactionSettings({ env: { NESSY_AUTO_COMPACT_WINDOW: '500k' } });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain('NESSY_AUTO_COMPACT_WINDOW="500k"');
      expect(message).toContain('a whole number in plain digits');
      expect(message).toContain('stays unset');
      // No invented fallback: this layer has none to name.
      expect(message).not.toMatch(/using \d+ instead/);
    } finally {
      warn.mockRestore();
      resetNumericSettingReports();
    }
  });

  it('says nothing for an accepted value, or for an unset one — the control', () => {
    resetNumericSettingReports();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveAutoCompactionSettings({
        env: { NESSY_AUTO_COMPACT_WINDOW: '500000', NESSY_AUTOCOMPACT_PCT_OVERRIDE: '5e1' },
      })).toEqual({ enabled: true, thresholdPercent: 50, contextWindow: 500000 });
      expect(resolveAutoCompactionSettings({ env: {} })).toEqual({ enabled: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      resetNumericSettingReports();
    }
  });
});
