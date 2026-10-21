import { describe, expect, it } from 'bun:test';
import {
  CROSS_MARKETPLACE_ALLOWLIST_FIELD,
  DEPENDENCY_ACQUISITION_REASON_CODES,
  planDependencyAcquisition,
  resolveHeldConstraint,
  type DependencyCatalogRow,
} from '../dependency-acquisition.ts';
import type { PluginDependencySubject } from '../../plugins/dependencies.ts';
import { MarketplaceService, type MarketplaceRegistrySource } from '../service.ts';
import type {
  PluginManagementApi,
  PluginManagementInstallResult,
  PluginManagementInstalledSummary,
} from '../../plugins/management-types.ts';
import type { PluginDependencyDescriptor, PluginInstallSource } from '../../plugins/types.ts';
import type { MarketplaceCatalogItem } from '../types.ts';
import type { RepositoryTagRef } from '../../plugins/version-tags.ts';

function subject(
  overrides: Partial<PluginDependencySubject> & { name: string },
): PluginDependencySubject {
  return {
    pluginKey: `acme/${overrides.name}`,
    pluginId: overrides.name,
    marketplaceId: 'acme-tools',
    version: '1.0.0',
    ...overrides,
    manifest: { name: overrides.name, ...(overrides.manifest ?? {}) },
  } as PluginDependencySubject;
}

function catalogRow(overrides: Partial<DependencyCatalogRow> & { pluginName: string }): DependencyCatalogRow {
  return {
    marketplaceId: 'acme-tools',
    itemId: `acme-tools:${overrides.pluginName}`,
    ...overrides,
  };
}

/** `plugin-dependencies.md`, page re-fetched 2026-08-07. */
describe('planDependencyAcquisition', () => {
  const base = {
    declaringMarketplaceId: 'acme-tools',
    rootMarketplaceId: 'acme-tools',
    configuredMarketplaceIds: ['acme-tools'],
  };

  it('installs every dependency of a bundle manifest (:52, :70)', () => {
    const declared: PluginDependencyDescriptor[] = [
      { name: 'secrets-vault' },
      { name: 'deploy-kit' },
      { name: 'db-migrate', version: '^3.0' },
      { name: 'oncall-runbook' },
    ];

    const decisions = planDependencyAcquisition({
      ...base,
      declared,
      installed: [],
      catalog: declared.map(entry => catalogRow({ pluginName: entry.name })),
    });

    expect(decisions.map(decision => decision.action)).toEqual(['install', 'install', 'install', 'install']);
    expect(decisions.find(decision => decision.name === 'db-migrate'))
      .toMatchObject({ action: 'install', range: '^3.0', itemId: 'acme-tools:db-migrate' });
  });

  it('refuses a cross-marketplace dependency and names the field to set (:81, :104)', () => {
    const decisions = planDependencyAcquisition({
      ...base,
      configuredMarketplaceIds: ['acme-tools', 'acme-shared'],
      declared: [{ name: 'audit-logger', marketplace: 'acme-shared' }],
      installed: [],
      catalog: [catalogRow({ pluginName: 'audit-logger', marketplaceId: 'acme-shared' })],
    });

    // The row IS in the catalog and the marketplace IS configured — the refusal
    // is the trust decision, not a lookup failure.
    expect(decisions).toEqual([{
      action: 'refuse',
      name: 'audit-logger',
      marketplaceId: 'acme-shared',
      reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.crossMarketplace,
      error: { code: 'dependency-unsatisfied', dependency: 'audit-logger', marketplace: 'acme-shared' },
    }]);
  });

  it('allows the same hop once the ROOT marketplace declares it (:83, :91)', () => {
    const decisions = planDependencyAcquisition({
      ...base,
      configuredMarketplaceIds: ['acme-tools', 'acme-shared'],
      allowCrossMarketplaceDependenciesOn: ['acme-shared'],
      declared: [{ name: 'audit-logger', marketplace: 'acme-shared' }],
      installed: [],
      catalog: [catalogRow({ pluginName: 'audit-logger', marketplaceId: 'acme-shared' })],
    });

    expect(decisions[0]).toMatchObject({ action: 'install', marketplaceId: 'acme-shared' });
  });

  it('does not chain trust: a nested declaration is checked against the ROOT allowlist (:83)', () => {
    const decisions = planDependencyAcquisition({
      ...base,
      // `acme-shared` declares a hop into `third-party`; only the root's list counts.
      declaringMarketplaceId: 'acme-shared',
      allowCrossMarketplaceDependenciesOn: ['acme-shared'],
      configuredMarketplaceIds: ['acme-tools', 'acme-shared', 'third-party'],
      declared: [{ name: 'sneaky', marketplace: 'third-party' }],
      installed: [],
      catalog: [catalogRow({ pluginName: 'sneaky', marketplaceId: 'third-party' })],
    });

    expect(decisions[0]).toMatchObject({
      action: 'refuse',
      reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.crossMarketplace,
    });
  });

  it('leaves a dependency from an unadded marketplace unresolved, distinctly from a missing row (:11)', () => {
    const decisions = planDependencyAcquisition({
      ...base,
      allowCrossMarketplaceDependenciesOn: ['not-added'],
      declared: [{ name: 'absent-here' }, { name: 'elsewhere', marketplace: 'not-added' }],
      installed: [],
      catalog: [],
    });

    expect(decisions.map(decision => decision.action === 'refuse' && decision.reasonCode)).toEqual([
      DEPENDENCY_ACQUISITION_REASON_CODES.notInCatalog,
      DEPENDENCY_ACQUISITION_REASON_CODES.marketplaceNotConfigured,
    ]);
  });

  it('refuses an unparseable range before it resolves anything (:213)', () => {
    const decisions = planDependencyAcquisition({
      ...base,
      declared: [{ name: 'vault', version: 'not-a-range', versionRangeValid: false }],
      installed: [],
      catalog: [catalogRow({ pluginName: 'vault' })],
    });

    expect(decisions[0]).toMatchObject({
      action: 'refuse',
      reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.rangeConflict,
      error: { code: 'range-conflict', dependency: 'vault', range: 'not-a-range' },
    });
  });

  it('intersects an installed dependent range with this one, and refuses an empty intersection (:142, :147)', () => {
    const installed = [subject({
      name: 'plugin-a',
      manifest: { name: 'plugin-a', dependencies: [{ name: 'vault', version: '~2.1' }] },
    })];

    const combined = planDependencyAcquisition({
      ...base,
      declared: [{ name: 'vault', version: '>=2.1.4' }],
      installed,
      catalog: [catalogRow({ pluginName: 'vault' })],
    });
    expect(combined[0]).toMatchObject({ action: 'install', range: '~2.1 >=2.1.4' });

    const conflicting = planDependencyAcquisition({
      ...base,
      declared: [{ name: 'vault', version: '~3.0' }],
      installed,
      catalog: [catalogRow({ pluginName: 'vault' })],
    });
    expect(conflicting[0]).toMatchObject({
      action: 'refuse',
      reasonCode: DEPENDENCY_ACQUISITION_REASON_CODES.rangeConflict,
      error: { code: 'range-conflict', range: '~2.1 ~3.0' },
    });
  });

  it('skips an installed dependency that satisfies, and re-resolves one that does not (:214)', () => {
    const catalog = [catalogRow({ pluginName: 'vault' })];

    const satisfied = planDependencyAcquisition({
      ...base,
      declared: [{ name: 'vault', version: '^2.0' }],
      installed: [subject({ name: 'vault', version: '2.4.0' })],
      catalog,
    });
    expect(satisfied[0]).toEqual({
      action: 'satisfied', name: 'vault', marketplaceId: 'acme-tools', version: '2.4.0',
    });

    const outOfRange = planDependencyAcquisition({
      ...base,
      declared: [{ name: 'vault', version: '^2.0' }],
      installed: [subject({ name: 'vault', version: '3.0.0' })],
      catalog,
    });
    expect(outOfRange[0]).toMatchObject({ action: 'install', installedVersion: '3.0.0', range: '^2.0' });
  });
});

describe('resolveHeldConstraint', () => {
  it('names the constraining plugins behind a pinned dependency (:148, :150)', () => {
    const held = resolveHeldConstraint(
      [
        subject({
          name: 'plugin-a',
          manifest: { name: 'plugin-a', dependencies: [{ name: 'vault', version: '=2.1.0' }] },
        }),
        subject({ name: 'unrelated', manifest: { name: 'unrelated' } }),
      ],
      'vault',
      'acme-tools',
    );

    expect(held).toEqual({ range: '=2.1.0', constrainedBy: ['plugin-a'] });
  });

  it('is undefined when nothing constrains the dependency (:152)', () => {
    expect(resolveHeldConstraint([subject({ name: 'plugin-a' })], 'vault', 'acme-tools')).toBeUndefined();
  });
});

// --- the wired path ---------------------------------------------------------

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
    structuredInstallSource: {
      kind: 'repository',
      repositoryUrl: `https://github.com/acme/${overrides.name}`,
    } as PluginInstallSource,
    ...overrides,
  };
}

function summary(
  overrides: Partial<PluginManagementInstalledSummary> & { name: string },
): PluginManagementInstalledSummary {
  return {
    pluginKey: `acme-tools/${overrides.name}`,
    activeInstanceId: `${overrides.name}-instance`,
    marketplaceId: 'acme-tools',
    pluginId: overrides.name,
    version: '1.0.0',
    installedAt: 0,
    capabilityKinds: [],
    diagnostics: [],
    ...overrides,
  };
}

interface Harness {
  service: MarketplaceService;
  installs: Array<{ source: PluginInstallSource; activateIn: unknown }>;
  updates: Array<{ pluginKey: string; source?: PluginInstallSource }>;
}

function harness(options: {
  items: MarketplaceCatalogItem[];
  installed: PluginManagementInstalledSummary[];
  installResults: Record<string, PluginManagementInstallResult>;
  tags?: Record<string, RepositoryTagRef[]>;
}): Harness {
  const installs: Harness['installs'] = [];
  const updates: Harness['updates'] = [];
  const installed = [...options.installed];
  const pluginService = {
    async status() {
      return { installed, diagnostics: [] };
    },
    async install(source: PluginInstallSource, installOptions: { activateIn?: unknown } = {}) {
      installs.push({ source, activateIn: installOptions.activateIn });
      const key = JSON.stringify(source);
      const matched = Object.entries(options.installResults)
        .find(([name]) => key.includes(name));
      const result = matched?.[1] ?? { ok: true, diagnostics: [] };
      if (result.installed) installed.push(result.installed);
      return result;
    },
    async update(pluginKey: string, updateOptions: { source?: PluginInstallSource } = {}) {
      updates.push({ pluginKey, ...(updateOptions.source ? { source: updateOptions.source } : {}) });
      return {
        ok: true,
        diagnostics: [],
        installed: summary({ name: pluginKey.split('/')[1]!, version: '2.0.0' }),
      };
    },
  } as unknown as PluginManagementApi;
  const registrySource: MarketplaceRegistrySource = {
    async listItems() { return { items: options.items }; },
  };
  return {
    installs,
    updates,
    service: new MarketplaceService({
      pluginService,
      registrySource,
      listRepositoryTags: async url => options.tags?.[url],
    }),
  };
}

describe('MarketplaceService dependency acquisition', () => {
  it('installs the declared closure, pinned to the highest satisfying tag (:11, :70, :127)', async () => {
    const rig = harness({
      items: [item({ name: 'secrets-vault' }), item({ name: 'audit-logger' })],
      installed: [],
      installResults: {
        'backend-standard': {
          ok: true,
          diagnostics: [],
          installed: summary({
            name: 'backend-standard',
            dependencies: [{ name: 'secrets-vault', version: '~2.1.0' }],
          }),
        },
        'secrets-vault': {
          ok: true,
          diagnostics: [],
          installed: summary({
            name: 'secrets-vault',
            version: '2.1.7',
            // The transitive hop: this one declares its own dependency.
            dependencies: [{ name: 'audit-logger' }],
          }),
        },
        'audit-logger': {
          ok: true,
          diagnostics: [],
          installed: summary({ name: 'audit-logger', version: '4.0.0' }),
        },
      },
    });

    const result = await rig.service.install({
      item: item({ name: 'backend-standard' }),
      activateIn: { kind: 'global' },
    });

    expect(result.ok).toBe(true);
    expect(result.installedDependencies?.map(entry => entry.name)).toEqual(['secrets-vault', 'audit-logger']);
    // `:167` — a dependency "installs with `true` regardless of its own default".
    expect(rig.installs.every(call => call.activateIn !== undefined)).toBe(true);
  });

  it('pins the resolved tag as the install ref (:127, :134)', async () => {
    const rig = harness({
      items: [item({ name: 'secrets-vault' })],
      installed: [],
      installResults: {
        'deploy-kit': {
          ok: true,
          diagnostics: [],
          installed: summary({
            name: 'deploy-kit',
            dependencies: [{ name: 'secrets-vault', version: '~2.1.0' }],
          }),
        },
        'secrets-vault': {
          ok: true,
          diagnostics: [],
          installed: summary({ name: 'secrets-vault', version: '2.1.7' }),
        },
      },
      tags: {
        'https://github.com/acme/secrets-vault': [
          { name: 'secrets-vault--v2.1.0' },
          { name: 'secrets-vault--v2.1.7' },
          { name: 'secrets-vault--v2.2.0' },
        ],
      },
    });

    await rig.service.install({ item: item({ name: 'deploy-kit' }) });

    const dependencyInstall = rig.installs.find(call => JSON.stringify(call.source).includes('secrets-vault'));
    expect(dependencyInstall?.source).toMatchObject({ ref: 'secrets-vault--v2.1.7' });
  });

  /**
   * THE FAILURE STATE. `:127` — "If no matching tag exists, the dependent plugin
   * is disabled with an error listing the available versions", and `:208` —
   * "Claude Code disables the affected plugin until you resolve the error."
   */
  it('reports a failed install and never fetches the dependency when no tag satisfies the range (:127)', async () => {
    const rig = harness({
      items: [item({ name: 'secrets-vault' })],
      installed: [],
      installResults: {
        'deploy-kit': {
          ok: true,
          diagnostics: [],
          installed: summary({
            name: 'deploy-kit',
            dependencies: [{ name: 'secrets-vault', version: '~2.1.0' }],
          }),
        },
      },
      tags: {
        'https://github.com/acme/secrets-vault': [
          { name: 'secrets-vault--v1.0.0' },
          { name: 'secrets-vault--v1.4.2' },
        ],
      },
    });

    const result = await rig.service.install({ item: item({ name: 'deploy-kit' }) });

    expect(result.ok).toBe(false);
    expect(result.dependencyErrors).toEqual([{
      code: 'no-matching-tag',
      dependency: 'secrets-vault',
      range: '~2.1.0',
      availableVersions: ['1.4.2', '1.0.0'],
      marketplace: 'acme-tools',
    }]);
    expect(result.diagnostics.some(diagnostic => (
      diagnostic.code === DEPENDENCY_ACQUISITION_REASON_CODES.noMatchingTag
      && diagnostic.message.includes('1.4.2, 1.0.0')
    ))).toBe(true);
    // Nothing was fetched for the dependency: exactly one install ran, the root's.
    expect(rig.installs).toHaveLength(1);
    // And no half-set was reported as added.
    expect(result.installedDependencies).toBeUndefined();
  });

  it('refuses a cross-marketplace dependency with a message naming the allowlist field (:104)', async () => {
    const rig = harness({
      items: [item({ name: 'audit-logger', id: 'acme-shared:audit-logger', marketplaceRegistryId: 'acme-shared' })],
      installed: [],
      installResults: {
        'deploy-kit': {
          ok: true,
          diagnostics: [],
          installed: summary({
            name: 'deploy-kit',
            dependencies: [{ name: 'audit-logger', marketplace: 'acme-shared' }],
          }),
        },
      },
    });

    const result = await rig.service.install({ item: item({ name: 'deploy-kit' }) });

    expect(result.ok).toBe(false);
    expect(rig.installs).toHaveLength(1);
    const refusal = result.diagnostics.find(diagnostic => (
      diagnostic.code === DEPENDENCY_ACQUISITION_REASON_CODES.crossMarketplace
    ));
    expect(refusal?.message).toContain(CROSS_MARKETPLACE_ALLOWLIST_FIELD);
  });

  it('leaves an install with no declared dependencies on the untouched fast path', async () => {
    const rig = harness({
      items: [],
      installed: [],
      installResults: {
        'plain-plugin': { ok: true, diagnostics: [], installed: summary({ name: 'plain-plugin' }) },
      },
    });

    const result = await rig.service.install({ item: item({ name: 'plain-plugin' }) });

    expect(result.ok).toBe(true);
    expect(result.installedDependencies).toBeUndefined();
    expect(result.dependencyErrors).toBeUndefined();
    expect(rig.installs).toHaveLength(1);
  });
});

/** R63's deferred half: `plugins/loading.md#when-auto-update-runs`, "to their latest versions on disk". */
describe('MarketplaceService.updateInstalledBundles', () => {
  it('re-materializes an installed bundle when the catalog offers a higher version', async () => {
    const rig = harness({
      items: [item({ name: 'deploy-kit', version: '2.0.0' })],
      installed: [summary({ name: 'deploy-kit', version: '1.0.0', source: { marketplaceItemId: 'acme-tools:deploy-kit' } })],
      installResults: {},
    });

    const result = await rig.service.updateInstalledBundles({ marketplaceIds: ['acme-tools'] });

    expect(result.considered).toEqual(['acme-tools/deploy-kit']);
    expect(result.updated).toEqual([{
      pluginKey: 'acme-tools/deploy-kit', fromVersion: '1.0.0', toVersion: '2.0.0',
    }]);
    expect(rig.updates).toHaveLength(1);
  });

  it('does nothing when the catalog is not ahead — the pass is idempotent', async () => {
    const rig = harness({
      items: [item({ name: 'deploy-kit', version: '1.0.0' })],
      installed: [summary({ name: 'deploy-kit', version: '1.0.0' })],
      installResults: {},
    });

    const result = await rig.service.updateInstalledBundles();

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(rig.updates).toEqual([]);
  });

  it('holds a constrained dependency at the highest satisfying tag, not the catalog latest (:148, :150)', async () => {
    const rig = harness({
      items: [item({ name: 'vault', version: '3.0.0' })],
      installed: [
        summary({
          name: 'plugin-a',
          dependencies: [{ name: 'vault', version: '~2.1' }],
        }),
        summary({ name: 'vault', version: '2.1.0' }),
      ],
      installResults: {},
      tags: {
        'https://github.com/acme/vault': [
          { name: 'vault--v2.1.0' },
          { name: 'vault--v2.1.9' },
          { name: 'vault--v3.0.0' },
        ],
      },
    });

    const result = await rig.service.updateInstalledBundles();

    expect(result.updated).toEqual([{
      pluginKey: 'acme-tools/vault', fromVersion: '2.1.0', toVersion: '2.0.0', tag: 'vault--v2.1.9',
    }]);
    expect(rig.updates[0]?.source).toMatchObject({ ref: 'vault--v2.1.9' });
  });

  it('names the skip when the two versions cannot be ordered (P2.159)', async () => {
    // Before this, an unorderable pair produced a bare `{kind:'skip'}` with no
    // `reasonCode`, and `updateInstalledBundles` only records a skip that HAS
    // one — so the plugin left no trace in the result and no line in the log,
    // for as long as it stayed installed, with auto-update on.
    const rig = harness({
      items: [item({ name: 'claude-security', version: '0.10.2.3' })],
      installed: [summary({ name: 'claude-security', version: '0.10.0' })],
      installResults: {},
    });

    const result = await rig.service.updateInstalledBundles();

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([{
      pluginKey: 'acme-tools/claude-security',
      reasonCode: 'plugin.update.version_uncomparable',
    }]);
    expect(rig.updates).toEqual([]);
  });

  it('survives a four-part installed version on the HELD path instead of throwing', async () => {
    // The held branch compared with a bare `semver.gt`, which THROWS on a
    // version strict semver cannot parse (`TypeError: Invalid Version`) — and it
    // sits OUTSIDE the per-plugin try, so one such plugin took the whole
    // unattended pass down and skipped every plugin behind it.
    const rig = harness({
      items: [item({ name: 'vault', version: '3.0.0' }), item({ name: 'deploy-kit', version: '1.0.0' })],
      installed: [
        summary({ name: 'plugin-a', dependencies: [{ name: 'vault', version: '~2.1' }] }),
        summary({ name: 'vault', version: '2.1.0.7' }),
        summary({ name: 'deploy-kit', version: '1.0.0', source: { marketplaceItemId: 'acme-tools:deploy-kit' } }),
      ],
      installResults: {},
      tags: { 'https://github.com/acme/vault': [{ name: 'vault--v2.1.0' }, { name: 'vault--v2.1.9' }] },
    });

    const result = await rig.service.updateInstalledBundles();

    expect(result.skipped).toEqual([{
      pluginKey: 'acme-tools/vault',
      reasonCode: 'plugin.update.version_uncomparable',
      constrainedBy: ['plugin-a'],
    }]);
    // The pass did not abort: the plugin BEHIND the bad one was still considered.
    expect(result.considered).toContain('acme-tools/deploy-kit');
  });

  it('skips a held dependency no tag satisfies, and names the constraining plugin (:150)', async () => {
    const rig = harness({
      items: [item({ name: 'vault', version: '3.0.0' })],
      installed: [
        summary({ name: 'plugin-a', dependencies: [{ name: 'vault', version: '~9.9' }] }),
        summary({ name: 'vault', version: '2.1.0' }),
      ],
      installResults: {},
      tags: { 'https://github.com/acme/vault': [{ name: 'vault--v2.1.0' }, { name: 'vault--v3.0.0' }] },
    });

    const result = await rig.service.updateInstalledBundles();

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([{
      pluginKey: 'acme-tools/vault',
      reasonCode: 'plugin.update.no_tag_satisfies_constraints',
      constrainedBy: ['plugin-a'],
    }]);
    expect(rig.updates).toEqual([]);
  });
});
