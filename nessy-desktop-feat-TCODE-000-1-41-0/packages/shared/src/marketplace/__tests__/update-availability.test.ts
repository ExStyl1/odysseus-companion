/**
 * R81 — the READ half of `plugins/loading.md#which-marketplaces-and-plugins-auto-update`.
 *
 * `:443` — "When auto-update is enabled for a marketplace, Claude Code refreshes
 * the marketplace data and updates installed plugins to their latest versions on
 * disk." R63 shipped the refresh, R72 the bundle re-materialization; this pins
 * the answer to "is there one" so a user can be told before either runs — and,
 * for a marketplace with auto-update off (`:454`'s default for third-party and
 * local marketplaces), instead of either running at all.
 */

import { describe, expect, it } from 'bun:test';
import {
  compareCandidateVersion,
  findCatalogRowForInstalled,
  isHigherVersion,
  isUncomparableVersion,
  planInstalledUpdate,
  resolveAvailableUpdateVersion,
  resolveAvailableUpdateVersions,
  resolveInstalledUpdateOptions,
  type InstalledUpdateSubject,
} from '../update-availability.ts';
import type { MarketplaceCatalogItem } from '../types.ts';
import type { PluginDependencyDescriptor } from '../../plugins/types.ts';

function item(overrides: Partial<MarketplaceCatalogItem> & { name: string }): MarketplaceCatalogItem {
  return {
    id: `acme-tools:${overrides.name}`,
    kind: 'plugin',
    listKind: 'plugins',
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    raw: {},
    marketplaceRegistryId: 'acme-tools',
    ...overrides,
  };
}

function installed(
  overrides: Partial<InstalledUpdateSubject> & { name: string; dependencies?: PluginDependencyDescriptor[] },
): InstalledUpdateSubject {
  return {
    pluginKey: `acme-tools/${overrides.name}`,
    pluginId: overrides.name,
    marketplaceId: 'acme-tools',
    version: '1.0.0',
    ...overrides,
    manifest: {
      name: overrides.name,
      ...(overrides.dependencies ? { dependencies: overrides.dependencies } : {}),
      ...(overrides.manifest ?? {}),
    },
  };
}

describe('isHigherVersion', () => {
  it('is strictly higher, never merely different', () => {
    expect(isHigherVersion('2.0.0', '1.0.0')).toBe(true);
    expect(isHigherVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isHigherVersion('1.0.0', '2.0.0')).toBe(false);
  });

  it('refuses to move on an unparseable version on either side', () => {
    expect(isHigherVersion('latest', '1.0.0')).toBe(false);
    expect(isHigherVersion('2.0.0', 'main')).toBe(false);
    expect(isHigherVersion(undefined, '1.0.0')).toBe(false);
  });
});

/**
 * P2.159 — the boolean above cannot tell "nothing newer" from "I cannot order
 * these", and the difference was measured on the official `claude-security`
 * plugin: it ships a FOUR-part `0.10.2.3`, strict `semver.parse` returns null,
 * and `canUpdate` was therefore false for the entire life of the install while
 * upstream moved twice.
 */
describe('compareCandidateVersion', () => {
  it('names an unorderable pair instead of answering "not newer"', () => {
    expect(compareCandidateVersion('0.10.2.3', '0.10.0')).toBe('incomparable');
    expect(compareCandidateVersion('0.10.0', '0.10.2.3')).toBe('incomparable');
    expect(compareCandidateVersion('latest', '1.0.0')).toBe('incomparable');
    // The boolean keeps its old answer, so no caller silently changes behavior.
    expect(isHigherVersion('0.10.2.3', '0.10.0')).toBe(false);
  });

  it('still orders the ordinary cases — the control for the case above', () => {
    expect(compareCandidateVersion('0.10.2', '0.10.0')).toBe('higher');
    expect(compareCandidateVersion('0.10.0', '0.10.0')).toBe('not-higher');
    expect(compareCandidateVersion('0.9.0', '0.10.0')).toBe('not-higher');
  });

  it('treats "no candidate at all" as nothing on offer, never as unorderable', () => {
    // The boundary: there is no second version to disagree about, so there is
    // nothing for a caller to report and no reason to alarm anyone.
    expect(compareCandidateVersion(undefined, '1.0.0')).toBe('not-higher');
    expect(compareCandidateVersion('', '1.0.0')).toBe('not-higher');
  });

  it('answers isUncomparableVersion for one side alone', () => {
    expect(isUncomparableVersion('0.10.2.3')).toBe(true);
    expect(isUncomparableVersion('0.10.2')).toBe(false);
    expect(isUncomparableVersion(undefined)).toBe(false);
  });
});

describe('planInstalledUpdate — the unorderable pair', () => {
  const rows = [item({ name: 'vault', version: '0.10.2.3', structuredInstallSource: { kind: 'repository', repositoryUrl: 'https://example.test/vault.git' } })];

  it('refuses rather than falling through to a same-version reinstall', () => {
    const plan = planInstalledUpdate(rows, [installed({ name: 'vault', version: '0.10.0' })], 'acme-tools/vault');
    expect(plan).toEqual({
      kind: 'version-uncomparable',
      catalogVersion: '0.10.2.3',
      installedVersion: '0.10.0',
    });
  });

  it('still reports `current` for an orderable pair that is level — the control', () => {
    const level = [item({ name: 'vault', version: '0.10.0' })];
    expect(planInstalledUpdate(level, [installed({ name: 'vault', version: '0.10.0' })], 'acme-tools/vault'))
      .toEqual({ kind: 'current', version: '0.10.0' });
  });

  it('throws at the one place a click or an agent can ask for it', async () => {
    const catalog = { peekCachedItems: async () => rows };
    const management = { status: async () => ({
      installed: [{
        pluginKey: 'acme-tools/vault',
        pluginId: 'vault',
        marketplaceId: 'acme-tools',
        name: 'vault',
        version: '0.10.0',
      }],
    }) };
    await expect(resolveInstalledUpdateOptions(
      catalog as never,
      management as never,
      'acme-tools/vault',
    )).rejects.toThrow(/cannot be updated.*0\.10\.2\.3.*0\.10\.0.*not a semantic version/s);
  });

  it('leaves the `current` path returning {} — repair semantics are unchanged', async () => {
    const catalog = { peekCachedItems: async () => [item({ name: 'vault', version: '0.10.0' })] };
    const management = { status: async () => ({
      installed: [{
        pluginKey: 'acme-tools/vault',
        pluginId: 'vault',
        marketplaceId: 'acme-tools',
        name: 'vault',
        version: '0.10.0',
      }],
    }) };
    expect(await resolveInstalledUpdateOptions(catalog as never, management as never, 'acme-tools/vault'))
      .toEqual({});
  });
});

describe('findCatalogRowForInstalled', () => {
  const rows = [
    item({ name: 'deploy-kit', id: 'acme-tools:deploy-kit', version: '2.0.0' }),
    item({ name: 'vault', id: 'acme-tools:vault', version: '2.0.0' }),
  ];

  it('joins by the recorded listing id first', () => {
    const row = findCatalogRowForInstalled(
      rows,
      installed({ name: 'anything-else', marketplaceItemId: 'acme-tools:vault' }),
    );
    expect(row?.name).toBe('vault');
  });

  it('follows a rename through formerIds (`plugins/host-marketplace.md#migrate-users-with-a-renames-map`)', () => {
    const renamed = [item({ name: 'vault-next', id: 'acme-tools:vault-next', formerIds: ['acme-tools:vault'], version: '3.0.0' })];
    const row = findCatalogRowForInstalled(
      renamed,
      installed({ name: 'vault', marketplaceItemId: 'acme-tools:vault' }),
    );
    expect(row?.name).toBe('vault-next');
  });

  it('falls back to the name for a row installed before ids were stamped', () => {
    expect(findCatalogRowForInstalled(rows, installed({ name: 'vault' }))?.id).toBe('acme-tools:vault');
  });

  it('never joins across marketplaces, even on an identical name', () => {
    const other = [item({ name: 'vault', marketplaceRegistryId: 'other-market', version: '9.0.0' })];
    expect(findCatalogRowForInstalled(other, installed({ name: 'vault' }))).toBeUndefined();
  });
});

describe('resolveAvailableUpdateVersion', () => {
  it('names the catalog version when it is strictly ahead', () => {
    const rows = [item({ name: 'vault', version: '2.1.0' })];
    expect(resolveAvailableUpdateVersion(rows, installed({ name: 'vault', version: '1.0.0' }))).toBe('2.1.0');
  });

  it('says nothing when the catalog is level or behind — the badge is not a version display', () => {
    const level = [item({ name: 'vault', version: '1.0.0' })];
    expect(resolveAvailableUpdateVersion(level, installed({ name: 'vault', version: '1.0.0' }))).toBeUndefined();
    const behind = [item({ name: 'vault', version: '0.9.0' })];
    expect(resolveAvailableUpdateVersion(behind, installed({ name: 'vault', version: '1.0.0' }))).toBeUndefined();
  });

  it('withholds a version outside a held range (`plugins/host-marketplace.md#hold-users-on-one-version`)', () => {
    // `:148` — "The dependency stays at `2.1.0`. Auto-update skips newer
    // versions while plugin A is installed." Advertising 3.0.0 here would be a
    // control that either does nothing or breaks the dependent.
    const rows = [item({ name: 'vault', version: '3.0.0' })];
    const held = { range: '=2.1.0', constrainedBy: ['plugin-a'] };
    expect(resolveAvailableUpdateVersion(rows, installed({ name: 'vault', version: '2.1.0' }), held))
      .toBeUndefined();
  });

  it('still advertises a version the held range admits', () => {
    const rows = [item({ name: 'vault', version: '2.1.9' })];
    const held = { range: '~2.1', constrainedBy: ['plugin-a'] };
    expect(resolveAvailableUpdateVersion(rows, installed({ name: 'vault', version: '2.1.0' }), held))
      .toBe('2.1.9');
  });
});

describe('resolveAvailableUpdateVersions', () => {
  it('omits every plugin with nothing to say, so an empty map is the ordinary result', () => {
    const rows = [item({ name: 'vault', version: '1.0.0' }), item({ name: 'deploy-kit', version: '3.0.0' })];
    const versions = resolveAvailableUpdateVersions(rows, [
      installed({ name: 'vault', version: '1.0.0' }),
      installed({ name: 'deploy-kit', version: '1.0.0' }),
    ]);
    expect([...versions.versions]).toEqual([['acme-tools/deploy-kit', '3.0.0']]);
    expect([...versions.uncomparable]).toEqual([]);
  });

  it('resolves the hold from the SAME installed set, matching the write side (:150)', () => {
    const rows = [item({ name: 'vault', version: '3.0.0' })];
    const versions = resolveAvailableUpdateVersions(rows, [
      installed({ name: 'plugin-a', dependencies: [{ name: 'vault', version: '=2.1.0' }] }),
      installed({ name: 'vault', version: '2.1.0' }),
    ]);
    expect(versions.versions.has('acme-tools/vault')).toBe(false);
  });

  it('resumes tracking once the constraining plugin is gone (`plugins/host-marketplace.md#hold-users-on-one-version`)', () => {
    // The positive control for the case above: same catalog, same vault, only
    // the dependent removed. Without it "no badge" proves nothing.
    const rows = [item({ name: 'vault', version: '3.0.0' })];
    const versions = resolveAvailableUpdateVersions(rows, [installed({ name: 'vault', version: '2.1.0' })]);
    expect(versions.versions.get('acme-tools/vault')).toBe('3.0.0');
  });

  it('is silent with no catalog at all — a cold cache must not read as "nothing new"', () => {
    expect(resolveAvailableUpdateVersions([], [installed({ name: 'vault' })]).versions.size).toBe(0);
  });

  it('reports the plugins whose versions cannot be ordered, separately from the silent ones', () => {
    const rows = [item({ name: 'vault', version: '0.10.2.3' }), item({ name: 'deploy-kit', version: '1.0.0' })];
    const availability = resolveAvailableUpdateVersions(rows, [
      installed({ name: 'vault', version: '0.10.0' }),
      installed({ name: 'deploy-kit', version: '1.0.0' }),
    ]);
    // `deploy-kit` is level: silent, and NOT reported as unorderable. That pair
    // is the whole point — one empty answer, two very different reasons.
    expect([...availability.versions]).toEqual([]);
    expect([...availability.uncomparable]).toEqual(['acme-tools/vault']);
  });
});
