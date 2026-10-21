/**
 * P2.201 — the merged-config memo, and the ONE property that makes it sound.
 *
 * The row asked for the memo to be landed with "invalidation by `pinnedConfigs`
 * array identity". Measured on 2026-09-03, the merged-config memo was already
 * there and content-keyed (which is stronger than identity); what was missing is
 * that BUILDING that content key cost about what rebuilding the merge cost, so a
 * warm hit saved nothing. The fix memoizes the pinned digest by array identity —
 * and identity is only a sound key because `freezePublishedLayers` (P2.55) deep
 * freezes what `setCapabilityPermissionLayers` publishes.
 *
 * So these tests do not measure speed. They pin the three facts a future edit
 * could break silently:
 *
 * 1. the published array really is frozen (the memo's whole premise);
 * 2. an equal-content array still shares one cache entry (the key did not change
 *    meaning when the digest started being memoized);
 * 3. an UNFROZEN array mutated in place still changes the answer — the test that
 *    fails the day someone deletes the `Object.isFrozen` guard and memoizes
 *    every array by identity.
 *
 * (3) is the important one. Without the guard, an inline-built context — several
 * exist, `SessionManager.assertCdRulesPermit` among them — could be mutated and
 * keep serving the pre-mutation policy, which is a wrong policy rather than a
 * stale cache.
 */
import { describe, expect, test } from 'bun:test';
import { PermissionManager } from '../core/permission-manager.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionsContext } from '../permissions-config.ts';

type PinnedConfigs = NonNullable<PermissionsContext['pinnedConfigs']>;

/** One layer's worth of parsed config, built fresh so no test shares an object. */
function layer(marker: string): PinnedConfigs[number] {
  return {
    config: {
      allowedBashPatterns: [],
      allowedMcpPatterns: [],
      allowedApiEndpoints: [],
      allowedWritePaths: [],
      // The observable: `deniedPaths` survives the merge as a plain `string[]`,
      // where `allowedBashPatterns` is compiled into a different shape and cannot
      // be read back by value. (It was `allowedWritePaths` until F1.715, which
      // drops that grant from a SOURCE layer — this one carries a `sourceSlug`.)
      deniedPaths: [`/ws/${marker}/**`],
      deniedToolPatterns: [],
      allowedTools: [],
      disallowedTools: [],
      toolRules: [],
      blockedTools: [],
      blockedCommandHints: [],
    },
    sourceSlug: `slug-${marker}`,
    scope: 'workspace',
  };
}

describe('P2.201 — the pinned-configs digest memo', () => {
  test('the published pinnedConfigs array is frozen — the memo\'s premise', () => {
    const manager = new PermissionManager({
      workspaceId: 'w2q-frozen',
      sessionId: 's-1',
      workspaceRootPath: '/ws-frozen',
    });
    manager.setCapabilityPermissionLayers(
      [{ content: JSON.stringify({ allowedBashPatterns: ['git status'] }), sourceSlug: 'a' }],
      'gen-1',
    );
    const pinned = manager.getCapabilityPermissionsContext()?.pinnedConfigs;
    expect(pinned).toBeDefined();
    const first = pinned?.[0];
    expect(first).toBeDefined();
    // The array AND its elements: `freezePublishedLayers` is a deep freeze, and
    // a shallow one would leave the layer objects mutable under a memoized key.
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.config)).toBe(true);
  });

  test('a frozen array and an equal-content unfrozen array share one cache entry', () => {
    permissionsConfigCache.clear();
    const frozen = Object.freeze([layer('x')]) as unknown as PinnedConfigs;
    const frozenLayer = frozen[0]!;
    Object.freeze(frozenLayer);
    Object.freeze(frozenLayer.config);
    const unfrozen = [layer('x')] as PinnedConfigs;

    const first = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/ws-shared',
      pinnedRevision: 'gen-1',
      pinnedConfigs: frozen,
    });
    const second = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/ws-shared',
      pinnedRevision: 'gen-1',
      pinnedConfigs: unfrozen,
    });

    // Same object, not merely equal: the digest is still content-addressed, so
    // memoizing it by identity did not partition the cache by array identity.
    expect(second).toBe(first);
  });

  test('an UNFROZEN array mutated in place still changes the merged config', () => {
    permissionsConfigCache.clear();
    const mutable = [layer('before')] as PinnedConfigs;
    const before = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/ws-mutable',
      pinnedRevision: 'gen-1',
      pinnedConfigs: mutable,
    });
    expect(before.deniedPaths).toContain('/ws/before/**');

    // In place: same array identity, different content. A memo keyed on identity
    // without the frozen guard would answer with the pre-mutation policy.
    mutable[0] = layer('after');
    const after = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: '/ws-mutable',
      pinnedRevision: 'gen-1',
      pinnedConfigs: mutable,
    });

    expect(after.deniedPaths).toContain('/ws/after/**');
    expect(after.deniedPaths).not.toContain('/ws/before/**');
  });

  test('a frozen array cannot be mutated, so identity implies content', () => {
    const frozen = Object.freeze([layer('pinned')]) as unknown as PinnedConfigs;
    // Positive control for the INSTRUMENT: the assignment below is what test 3
    // performs successfully on an unfrozen array. Here it must not take effect.
    expect(() => {
      'use strict';
      (frozen as PinnedConfigs)[0] = layer('swapped');
    }).toThrow();
    expect(frozen[0]!.config.deniedPaths).toContain('/ws/pinned/**');
  });
});
