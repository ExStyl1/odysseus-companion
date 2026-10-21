/**
 * T10 (plugin-install plan § 9b): connection-timing policy resolution.
 *
 * The default is Claude parity (connect at session start); `false` at either
 * layer — user `sources.connectOnStartup` or managed `connectSourcesOnStartup`
 * — is terminal, and neither layer can force the other back on.
 *
 * Mutation probe: making the resolver ignore its inputs (always-on) turns the
 * user-off and managed-off rows red.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseSourceStartupSettingsV1,
  resolveConnectSourcesOnStartup,
} from '../source-startup-settings.ts';

describe('resolveConnectSourcesOnStartup', () => {
  test('defaults ON (Claude parity) and composes tighter-wins', () => {
    // The § 0b-4 default: absent everywhere → connect at session start.
    expect(resolveConnectSourcesOnStartup()).toBe(true);
    expect(resolveConnectSourcesOnStartup({})).toBe(true);
    expect(resolveConnectSourcesOnStartup({ userEnabled: true, managedEnabled: true })).toBe(true);
    // Either layer's `false` is terminal — the bank posture, restorable
    // per-user or fleet-wide.
    expect(resolveConnectSourcesOnStartup({ userEnabled: false })).toBe(false);
    expect(resolveConnectSourcesOnStartup({ managedEnabled: false })).toBe(false);
    expect(resolveConnectSourcesOnStartup({ userEnabled: true, managedEnabled: false })).toBe(false);
    expect(resolveConnectSourcesOnStartup({ userEnabled: false, managedEnabled: true })).toBe(false);
  });
});

describe('parseSourceStartupSettingsV1', () => {
  test('reads only a literal boolean; anything else falls back to the default', () => {
    expect(parseSourceStartupSettingsV1({ connectOnStartup: false })).toEqual({ connectOnStartup: false });
    expect(parseSourceStartupSettingsV1({ connectOnStartup: true })).toEqual({ connectOnStartup: true });
    expect(parseSourceStartupSettingsV1({ connectOnStartup: 'false' })).toEqual({});
    expect(parseSourceStartupSettingsV1(undefined)).toEqual({});
    expect(parseSourceStartupSettingsV1(null)).toEqual({});
    expect(parseSourceStartupSettingsV1([])).toEqual({});
    expect(parseSourceStartupSettingsV1('off')).toEqual({});
  });
});
