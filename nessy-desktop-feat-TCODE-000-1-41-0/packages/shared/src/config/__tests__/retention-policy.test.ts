import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RETENTION_DAYS,
  FALLBACK_CONFIG_DEFAULTS,
  InvalidRetentionDaysError,
  MIN_RETENTION_DAYS,
  resolveRetentionDecision,
  setRetentionDays,
} from '../storage.ts';
import { parseManagedPiPolicyV1 } from '../../agent/pi-harness/managed-policy.ts';

describe('the documented default and minimum', () => {
  it('defaults to 30 with a minimum of 1', () => {
    // settings.md: "**Default**: `30` days, minimum `1`." Ours was 0 with .min(0).
    expect(DEFAULT_RETENTION_DAYS).toBe(30);
    expect(MIN_RETENTION_DAYS).toBe(1);
  });

  it('ships 30 in both default sources, not just the in-code fallback', () => {
    expect(FALLBACK_CONFIG_DEFAULTS.defaults.retentionDays).toBe(30);
    const bundled = JSON.parse(readFileSync(
      join(import.meta.dir, '..', '..', '..', '..', '..', 'apps', 'electron', 'resources', 'config-defaults.json'),
      'utf8',
    ));
    expect(bundled.defaults.retentionDays).toBe(30);
  });

  it('a fresh install with no persisted value sweeps at the default', () => {
    expect(resolveRetentionDecision({
      config: { ok: true },
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    })).toEqual({ sweep: true, state: 'active', retentionDays: 30, source: 'default' });
  });
});

describe('new writes are strict', () => {
  const rejected = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const value of rejected) {
    it(`rejects a write of ${String(value)}`, () => {
      // "Setting `0` fails with a validation error."
      expect(() => setRetentionDays(value)).toThrow(InvalidRetentionDaysError);
    });
  }
});

describe('an existing persisted 0 migrates rather than crashing', () => {
  it('reads as cleanup-disabled with a warning, never as an error and never as 30', () => {
    const decision = resolveRetentionDecision({
      config: { ok: true, retentionDays: 0 },
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    });
    expect(decision.sweep).toBe(false);
    expect(decision.state).toBe('disabled');
    // The failure mode this avoids is not the crash — it is silently promoting
    // an explicit "never delete my data" to a 30-day delete, which is exactly
    // the pre-v2.1.203 regression the docs record.
    expect(decision.warning).toContain('0');
    expect(decision.warning).toContain('disabled');
  });

  it('a nonsense persisted value also disables rather than guessing', () => {
    const decision = resolveRetentionDecision({
      config: { ok: true, retentionDays: -7 },
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    });
    expect(decision).toMatchObject({ sweep: false, state: 'disabled' });
  });

  it('a valid persisted value wins over the default', () => {
    expect(resolveRetentionDecision({
      config: { ok: true, retentionDays: 7 },
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    })).toEqual({ sweep: true, state: 'active', retentionDays: 7, source: 'user' });
  });
});

describe('the unreadable-settings fail-safe', () => {
  it('pauses the sweep and produces a warning when the settings file cannot be read', () => {
    const decision = resolveRetentionDecision({
      config: { ok: false, error: 'config.json is not valid JSON' },
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
    });
    expect(decision.sweep).toBe(false);
    expect(decision.state).toBe('paused');
    expect(decision.warning).toContain('paused');
    expect(decision.warning).toContain('config.json is not valid JSON');
  });

  it('a managed cleanupPeriodDays runs the sweep through the same unreadable file', () => {
    // "…unless managed settings provide `cleanupPeriodDays`, in which case the
    // sweep runs at the managed value."
    expect(resolveRetentionDecision({
      config: { ok: false, error: 'config.json is not valid JSON' },
      defaultRetentionDays: DEFAULT_RETENTION_DAYS,
      managedRetentionDays: 14,
    })).toEqual({ sweep: true, state: 'active', retentionDays: 14, source: 'managed' });
  });

  it('managed also outranks a readable user value and a persisted 0', () => {
    for (const config of [
      { ok: true as const, retentionDays: 90 },
      { ok: true as const, retentionDays: 0 },
    ]) {
      expect(resolveRetentionDecision({
        config,
        defaultRetentionDays: DEFAULT_RETENTION_DAYS,
        managedRetentionDays: 14,
      })).toEqual({ sweep: true, state: 'active', retentionDays: 14, source: 'managed' });
    }
  });

  it('an out-of-range managed value does not become a sweep', () => {
    // Belt and braces: the parser rejects these, but the resolver must not
    // honour one that somehow arrives.
    for (const managedRetentionDays of [0, -1, 2.5]) {
      expect(resolveRetentionDecision({
        config: { ok: false, error: 'unreadable' },
        defaultRetentionDays: DEFAULT_RETENTION_DAYS,
        managedRetentionDays,
      })).toMatchObject({ sweep: false, state: 'paused' });
    }
  });
});

describe('managed cleanupPeriodDays parsing', () => {
  function policy(cleanupPeriodDays: unknown) {
    return { schemaVersion: 1, disabledPermissionModes: [], cleanupPeriodDays };
  }

  it('accepts an integer at or above the documented minimum', () => {
    expect(parseManagedPiPolicyV1(policy(1)).cleanupPeriodDays).toBe(1);
    expect(parseManagedPiPolicyV1(policy(30)).cleanupPeriodDays).toBe(30);
  });

  it('is absent when the admin does not set it', () => {
    expect(parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [] }).cleanupPeriodDays)
      .toBeUndefined();
  });

  for (const invalid of [0, -1, 1.5, '30', null]) {
    it(`rejects ${JSON.stringify(invalid)} fail-closed`, () => {
      expect(() => parseManagedPiPolicyV1(policy(invalid)))
        .toThrow('invalid managed Pi policy cleanupPeriodDays');
    });
  }
});
