/**
 * P2.173 — the CLASS rule the P2.159 instance implies, and its enforcement.
 *
 * **A per-item loop must contain its own failure, or one bad item silently
 * becomes zero items processed.**
 *
 * The instance: `resolveBundleUpdateTarget` compared versions with a bare
 * `semver.gt`, which throws on a string strict semver cannot parse, and the call
 * sat OUTSIDE `updateInstalledBundles`' per-plugin `try` — so one installed
 * plugin declaring `0.10.2.3` took the whole unattended pass down and skipped
 * every plugin behind it. That thrower is gone; these cases pin the STRUCTURE,
 * which is the part a future author can break again:
 *
 * 1. Any failure in deciding ONE plugin's target is contained, named, and the
 *    plugins behind it are still processed. The decision step awaits an INJECTED
 *    `listRepositoryTags`, so this is not hypothetical: the pass would otherwise
 *    be trusting a callback it does not own never to reject.
 * 2. A throwing semver comparator can only be reached through the one module
 *    that guards it. This is the mechanical half — it catches a reintroduction
 *    anywhere under `marketplace/`, not only at the two call sites case 1 covers.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MarketplaceService, type MarketplaceRegistrySource } from '../service.ts';
import type { MarketplaceCatalogItem } from '../types.ts';
import type {
  PluginManagementApi,
  PluginManagementInstalledSummary,
} from '../../plugins/management-types.ts';
import type { PluginDependencyDescriptor, PluginInstallSource } from '../../plugins/types.ts';

function item(name: string, version: string): MarketplaceCatalogItem {
  return {
    id: `acme-tools:${name}`,
    name,
    version,
    kind: 'plugin',
    listKind: 'plugins',
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    raw: {},
    // The join is by `marketplaceRegistryId`, not `marketplaceId`
    // (`findCatalogRowForInstalled`); getting that wrong makes every case pass
    // vacuously with an empty considered set.
    marketplaceRegistryId: 'acme-tools',
    structuredInstallSource: {
      kind: 'repository',
      repositoryUrl: `https://github.com/acme/${name}`,
    } as PluginInstallSource,
  } as MarketplaceCatalogItem;
}

function summary(
  name: string,
  version: string,
  dependencies?: PluginDependencyDescriptor[],
): PluginManagementInstalledSummary {
  return {
    pluginKey: `acme-tools/${name}`,
    activeInstanceId: `${name}-instance`,
    marketplaceId: 'acme-tools',
    pluginId: name,
    name,
    version,
    installedAt: 0,
    capabilityKinds: [],
    diagnostics: [],
    ...(dependencies ? { dependencies } : {}),
  } as unknown as PluginManagementInstalledSummary;
}

/** The pass, with an injected tag lister that can be made to REJECT per URL. */
function rig(options: {
  items: MarketplaceCatalogItem[];
  installed: PluginManagementInstalledSummary[];
  rejectTagsFor?: string[];
}) {
  const updates: string[] = [];
  const tagCalls: string[] = [];
  const pluginService = {
    async status() { return { installed: options.installed, diagnostics: [] }; },
    async update(pluginKey: string) {
      updates.push(pluginKey);
      return {
        ok: true,
        diagnostics: [],
        installed: summary(pluginKey.split('/')[1]!, '9.9.9'),
      };
    },
  } as unknown as PluginManagementApi;
  const registrySource: MarketplaceRegistrySource = {
    async listItems() { return { items: options.items }; },
  };
  return {
    updates,
    tagCalls,
    service: new MarketplaceService({
      pluginService,
      registrySource,
      listRepositoryTags: async (url: string) => {
        tagCalls.push(url);
        if (options.rejectTagsFor?.some(name => url.endsWith(`/${name}`))) {
          throw new Error('tag listing exploded');
        }
        return [{ name: 'vault--v2.1.0' }];
      },
    }),
  };
}

describe('the unattended update pass contains one plugin\'s failure (P2.173)', () => {
  it('names the failed decision and still processes the plugins behind it', async () => {
    // `vault` is HELD, so deciding its target awaits the injected tag lister —
    // the step that used to run outside the guard. Make that step throw.
    const harness = rig({
      items: [item('vault', '3.0.0'), item('deploy-kit', '2.0.0')],
      installed: [
        summary('plugin-a', '1.0.0', [{ name: 'vault', version: '~2.1' }]),
        summary('vault', '2.1.0'),
        summary('deploy-kit', '1.0.0'),
      ],
      rejectTagsFor: ['vault'],
    });

    const result = await harness.service.updateInstalledBundles();

    // The failure is named — and named as its OWN fact, not as a failed update.
    expect(result.skipped).toEqual([
      { pluginKey: 'acme-tools/vault', reasonCode: 'plugin.update.decision_failed' },
    ]);
    // ...and the pass did not stop: the plugin BEHIND the bad one still moved.
    expect(result.updated.map(row => row.pluginKey)).toEqual(['acme-tools/deploy-kit']);
    expect(harness.updates).toEqual(['acme-tools/deploy-kit']);
  });

  it('reports nothing extra when every decision succeeds', async () => {
    // The boundary: the outer guard must not manufacture a skip on the happy
    // path, or "contained" would read as "always failing".
    const harness = rig({
      items: [item('deploy-kit', '2.0.0')],
      installed: [summary('deploy-kit', '1.0.0')],
    });

    const result = await harness.service.updateInstalledBundles();

    expect(result.skipped).toEqual([]);
    expect(result.updated.map(row => row.pluginKey)).toEqual(['acme-tools/deploy-kit']);
  });
});

/**
 * `semver`'s comparison family builds a `SemVer` from its arguments and throws
 * `TypeError: Invalid Version` on anything strict `parse` refuses; `satisfies`,
 * `validRange` and `parse` answer falsy instead. Only the throwing half is
 * confined.
 */
const THROWING_SEMVER_EXPORTS = [
  'gt', 'lt', 'gte', 'lte', 'eq', 'neq', 'cmp', 'compare', 'rcompare',
  'compareBuild', 'diff', 'inc', 'major', 'minor', 'patch', 'prerelease',
  'sort', 'rsort', 'subset', 'SemVer', 'Range', 'clean',
];

/** Every throwing `semver` export this source imports, by module path. */
function throwingSemverImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]semver['"]/g)) {
    for (const clause of match[1]!.split(',')) {
      // `parse as parseSemver` — the ORIGINAL name is what semver's contract is
      // about, so read the left-hand side.
      const original = clause.split(/\sas\s/)[0]!.replace(/^\s*type\s+/, '').trim();
      if (THROWING_SEMVER_EXPORTS.includes(original)) found.push(original);
    }
  }
  return found;
}

describe('a throwing version comparator is reachable through one guarded module only (P2.173)', () => {
  const marketplaceDir = join(import.meta.dir, '..');
  /**
   * The one module allowed to hold them: it wraps every throwing call behind
   * `compareCandidateVersion`, which parses first and compares parsed objects.
   */
  const GUARDED_MODULE = 'update-availability.ts';

  it('flags a bare import — the positive control for the detector below', () => {
    expect(throwingSemverImports("import { gt } from 'semver';")).toEqual(['gt']);
    expect(throwingSemverImports("import { parse as p, rcompare } from 'semver';")).toEqual(['rcompare']);
    // ...and does not flag the non-throwing half, or the assertion below would
    // be about nothing.
    expect(throwingSemverImports("import { satisfies, validRange, parse } from 'semver';")).toEqual([]);
  });

  it('finds them in no marketplace module except the guarded one', () => {
    const offenders: Array<{ file: string; imports: string[] }> = [];
    let scanned = 0;
    for (const entry of readdirSync(marketplaceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name === GUARDED_MODULE) continue;
      scanned += 1;
      const imports = throwingSemverImports(readFileSync(join(marketplaceDir, entry.name), 'utf8'));
      if (imports.length > 0) offenders.push({ file: entry.name, imports });
    }
    // The scan really read the directory (a zero-file sweep would pass vacuously).
    expect(scanned).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
    // And the guarded module really is the one that holds them, so the
    // exemption above is not exempting an empty set.
    expect(throwingSemverImports(readFileSync(join(marketplaceDir, GUARDED_MODULE), 'utf8')).length)
      .toBeGreaterThan(0);
  });
});
