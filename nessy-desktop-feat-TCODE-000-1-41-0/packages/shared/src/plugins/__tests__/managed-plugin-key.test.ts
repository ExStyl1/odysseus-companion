/**
 * P3.244 — the managed `enabledPlugins` key in the spelling the page documents.
 *
 * Two things are pinned here and they are different obligations. The first is
 * the DRIFT pin: `managed-plugin-key.ts` re-implements `pluginKeyFor`'s
 * base64url encoding rather than importing it, because `workspaces/paths.ts`
 * reads `CONFIG_DIR` at module scope and the managed-policy parser runs before a
 * config dir is settled. That duplication is only safe while something imports
 * BOTH and compares them, which is this file. The second is the behaviour:
 * driving the real tolerant parse, because an identifier probe cannot tell an
 * accepted key from a stripped one.
 */
import { describe, expect, it } from 'bun:test';
import { parseManagedPiPolicyTolerantV1 } from '../../agent/pi-harness/managed-policy.ts';
import { pluginKeyFor } from '../../workspaces/paths.ts';
import {
  isDocumentedPluginKeySpelling,
  normalizeManagedEnabledPluginKey,
} from '../managed-plugin-key.ts';

const parse = (enabledPlugins: unknown) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], enabledPlugins },
  { source: 'test' },
);

describe('normalizeManagedEnabledPluginKey', () => {
  it('produces exactly what pluginKeyFor produces, for every segment shape we accept', () => {
    // The drift pin. If `pluginKeyFor`'s encoding ever changes, this fails here
    // rather than silently in a fleet's managed policy.
    for (const [pluginId, marketplaceId] of [
      ['code-formatter', 'team-tools'],
      ['experimental-features', 'personal'],
      ['a', 'b'],
      ['Plugin_With.Dots', 'Market+Place'],
      ['юникод', 'магазин'],
    ] as const) {
      expect(normalizeManagedEnabledPluginKey(`${pluginId}@${marketplaceId}`))
        .toBe(pluginKeyFor(marketplaceId, pluginId));
    }
  });

  it('passes an already-stored key through unchanged', () => {
    const stored = pluginKeyFor('team-tools', 'code-formatter');
    expect(normalizeManagedEnabledPluginKey(stored)).toBe(stored);
    expect(isDocumentedPluginKeySpelling(stored)).toBe(false);
    expect(isDocumentedPluginKeySpelling('code-formatter@team-tools')).toBe(true);
  });

  it('refuses shapes that are neither spelling', () => {
    for (const bad of [
      '',
      'no-separator-at-all',
      '@team-tools',
      'code-formatter@',
      'a@b@c',
      'plug in@team-tools',
      'code-formatter@team/tools',
      'code-formatter@team\\tools',
      // A control character in the key, written as an ESCAPE: the value is
      // byte-identical at runtime and the source stays greppable, which is the
      // rule `lint:nul-bytes` enforces (AGENTS.md, measured 2026-08-29/30).
      'code\u0000formatter@team-tools',
    ]) {
      expect(normalizeManagedEnabledPluginKey(bad)).toBeUndefined();
    }
  });
});

describe('managed enabledPlugins accepts the documented spelling (settings-reference.md#enabledplugins)', () => {
  it("parses the page's own example instead of stripping it", () => {
    // `settings-reference.md#enabledplugins`: "Turn individual plugins on or
    // off, keyed by `plugin-name@marketplace-name`." Before P3.244 this exact
    // object parsed to `{}` with two `stripped` drops.
    const { policy, drops } = parse({
      'code-formatter@team-tools': true,
      'deployment-tools@team-tools': true,
      'experimental-features@personal': false,
    });
    expect(drops).toEqual([]);
    expect(policy.enabledPlugins).toEqual({
      [pluginKeyFor('team-tools', 'code-formatter')]: true,
      [pluginKeyFor('team-tools', 'deployment-tools')]: true,
      [pluginKeyFor('personal', 'experimental-features')]: false,
    });
  });

  it('keeps the stored spelling working, so a deployed policy is unaffected', () => {
    const stored = pluginKeyFor('team-tools', 'code-formatter');
    const { policy, drops } = parse({ [stored]: true });
    expect(drops).toEqual([]);
    expect(policy.enabledPlugins).toEqual({ [stored]: true });
  });

  it('still strips a key in neither spelling, and reports it by index only', () => {
    const { policy, drops } = parse({ 'not a plugin key': true, 'ok@market': true });
    expect(policy.enabledPlugins).toEqual({ [pluginKeyFor('market', 'ok')]: true });
    expect(drops.map(drop => [drop.field, drop.disposition])).toEqual([
      ['enabledPlugins[0]', 'stripped'],
    ]);
  });

  it('collapses the two spellings of one plugin when they agree', () => {
    const stored = pluginKeyFor('team-tools', 'code-formatter');
    const { policy, drops } = parse({ 'code-formatter@team-tools': false, [stored]: false });
    expect(drops).toEqual([]);
    expect(policy.enabledPlugins).toEqual({ [stored]: false });
  });

  it('keeps the first decision and reports the second when the two spellings disagree', () => {
    const stored = pluginKeyFor('team-tools', 'code-formatter');
    const { policy, drops } = parse({ 'code-formatter@team-tools': false, [stored]: true });
    // The BLOCK written first survives; the opposing force-enable is dropped
    // rather than silently overwriting it.
    expect(policy.enabledPlugins).toEqual({ [stored]: false });
    expect(drops.map(drop => [drop.field, drop.disposition])).toEqual([
      ['enabledPlugins[1]', 'stripped'],
    ]);
  });
});
