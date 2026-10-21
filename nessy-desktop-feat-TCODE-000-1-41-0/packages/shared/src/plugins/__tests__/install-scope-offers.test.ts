/**
 * P6.752 — `PLUGIN_SCOPES` now has a production consumer, and this is the half
 * of that claim a type cannot make.
 *
 * `PLUGIN_INSTALL_SCOPE_OFFERS` is derived from `PLUGIN_SCOPES` through a
 * `Record<PluginScope, …>`, so a fourth scope arriving without copy is a
 * compile error and cannot reach this file. What the compiler cannot see is
 * copy that exists but is WRONG in the one way a keyed map invites: two scopes
 * pointing at the same i18n key, which renders as a picker offering the same
 * sentence twice and silently loses one choice's meaning.
 *
 * So the two assertions here are deliberately the ones the type system does not
 * already make: the derivation is complete and ordered, and no two scopes share
 * a string. The locale-coverage assertion for these keys already lives beside
 * the picker that renders them
 * (`apps/electron/src/renderer/hooks/__tests__/useMarketplaceInstall.test.ts`)
 * and is not repeated here.
 */
import { describe, expect, test } from 'bun:test';

import { PLUGIN_INSTALL_SCOPE_OFFERS, PLUGIN_SCOPES } from '../types.ts';

describe('P6.752 — the install-scope offers are the scope list, not a copy of it', () => {
  test('every scope the product has is offered exactly once, in PLUGIN_SCOPES order', () => {
    expect(PLUGIN_INSTALL_SCOPE_OFFERS.map(offer => offer.scope)).toEqual([...PLUGIN_SCOPES]);
    // Widest-first is stated once, in `PLUGIN_SCOPES`. If that list is ever
    // reordered the picker reorders with it, which is the point of deriving.
    expect(PLUGIN_INSTALL_SCOPE_OFFERS[0]?.scope).toBe('user/global');
    expect(PLUGIN_INSTALL_SCOPE_OFFERS).toHaveLength(PLUGIN_SCOPES.length);
  });

  test('no two scopes share a label or a hint — the mistake the Record cannot catch', () => {
    const keys = PLUGIN_INSTALL_SCOPE_OFFERS.flatMap(offer => [offer.labelKey, offer.hintKey]);
    expect(new Set(keys).size).toBe(keys.length);
    // And every offer carries both halves: a blank hint would render an empty
    // sentence under a real choice rather than fail anywhere.
    for (const offer of PLUGIN_INSTALL_SCOPE_OFFERS) {
      expect(offer.labelKey.startsWith('plugins.installScope')).toBe(true);
      expect(offer.hintKey.startsWith('plugins.installScope')).toBe(true);
    }
  });
});
