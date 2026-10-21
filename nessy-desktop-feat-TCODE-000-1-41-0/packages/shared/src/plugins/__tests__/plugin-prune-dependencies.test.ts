/**
 * P6.557 — `prune` and the auto-installed provenance bit, the missing quarter of
 * P6.413.
 *
 * `plugins/cli-reference.md#plugin-prune`, verbatim: *"Remove auto-installed plugin
 * dependencies that are no longer required by any installed plugin. Dependencies
 * that Claude Code pulled in to satisfy another plugin's `dependencies` field
 * are removed; plugins you installed directly are never touched."*
 *
 * The provenance bit is the whole reason the verb could not be honest before:
 * without it the two populations are indistinguishable, and a prune written
 * against "has no dependents" alone would delete every standalone plugin the
 * user installed on purpose. That is the case pinned first below.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { removePluginData } from '../data-paths.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginKey } from '../types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-prune-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

function createService(): { service: PluginManagementServiceV2; store: PluginStoreV2 } {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') });
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
    workspaceIds: () => existsSync(join(dir, 'workspaces')) ? readdirSync(join(dir, 'workspaces')) : [],
  });
  return {
    store,
    service: installs.track(new PluginManagementServiceV2({
      store,
      policyStore,
      trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') }),
      fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
      baseTempDir: join(dir, 'staging'),
      dataLifecycle: { onPluginUninstall: ({ pluginKey }) => removePluginData(pluginKey, join(dir, 'plugins', 'data')) },
      pluginDataDir: join(dir, 'plugins', 'data'),
    })),
  };
}

/** One bundle, optionally declaring dependencies by bare name. */
function bundle(id: string, dependencies: string[] = []): string {
  const root = join(dir, `src-${id}`);
  mkdirSync(join(root, 'skills', id), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id,
    name: id,
    version: '1.0.0',
    ...(dependencies.length ? { dependencies: dependencies.map(name => ({ name })) } : {}),
    capabilities: [{ kind: 'skill', id, skill: { slug: id, path: `skills/${id}/SKILL.md` } }],
  }));
  writeFileSync(join(root, 'skills', id, 'SKILL.md'), `# ${id}`);
  return root;
}

async function install(
  service: PluginManagementServiceV2,
  id: string,
  options: { dependencies?: string[]; autoInstalled?: boolean } = {},
): Promise<PluginKey> {
  const result = await service.install(
    { kind: 'local-path', path: bundle(id, options.dependencies ?? []) },
    { ...(options.autoInstalled ? { autoInstalled: true } : {}) },
  );
  expect(result.ok).toBe(true);
  return result.installed!.pluginKey;
}

describe('P6.557 — prune removes only auto-installed orphans', () => {
  it('never touches a plugin the user installed directly, even with no dependents', async () => {
    // The control the provenance bit exists for: `standalone` has no dependents
    // and would be an orphan under a dependents-only rule.
    const { service } = createService();
    const standalone = await install(service, 'standalone');

    const outcome = await service.pruneDependencies();

    expect(outcome.removed).toEqual([]);
    expect(outcome.userInstalledCount).toBe(1);
    expect((await service.status()).installed.map(entry => entry.pluginKey)).toContain(standalone);
  });

  it('removes an auto-installed dependency once nothing declares it', async () => {
    const { service } = createService();
    await install(service, 'vault', { autoInstalled: true });
    const dependent = await install(service, 'deploy', { dependencies: ['vault'] });

    // Still required — the dependent is installed.
    const held = await service.pruneDependencies({ dryRun: true });
    expect(held.removed).toEqual([]);
    expect(held.kept.map(entry => entry.requiredBy)).toEqual([[dependent]]);

    await service.uninstall(dependent);
    const outcome = await service.pruneDependencies();

    expect(outcome.removed.map(entry => entry.name)).toEqual(['vault']);
    expect((await service.status()).installed).toEqual([]);
  });

  it('dry-run reports the same removal and removes nothing', async () => {
    const { service } = createService();
    const vault = await install(service, 'vault', { autoInstalled: true });

    const preview = await service.pruneDependencies({ dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(preview.removed.map(entry => entry.pluginKey)).toEqual([vault]);
    expect((await service.status()).installed.map(entry => entry.pluginKey)).toEqual([vault]);
  });

  it('cascades: an orphan\'s own auto-installed dependency is orphaned in the same pass', async () => {
    // The fixed point the page's "no longer required by any installed plugin"
    // demands: it is a property of the FINAL set, not of the starting one.
    const { service } = createService();
    await install(service, 'core', { autoInstalled: true });
    await install(service, 'vault', { dependencies: ['core'], autoInstalled: true });

    const outcome = await service.pruneDependencies();

    expect(outcome.removed.map(entry => entry.name).sort()).toEqual(['core', 'vault']);
    expect((await service.status()).installed).toEqual([]);
  });

  it('an entry with no provenance bit is read as user-installed, which can only under-remove', async () => {
    const { service, store } = createService();
    const key = await install(service, 'legacy');
    const registry = await store.readInstalledRegistry();
    expect(registry.plugins.find(entry => entry.pluginKey === key)?.autoInstalled).toBeUndefined();

    expect((await service.pruneDependencies()).removed).toEqual([]);
  });
});

describe('P6.557 — the provenance bit is persisted and survives an update', () => {
  it('is written only when the install says so', async () => {
    const { service, store } = createService();
    const auto = await install(service, 'vault', { autoInstalled: true });
    const manual = await install(service, 'deploy');
    const registry = await store.readInstalledRegistry();

    expect(registry.plugins.find(entry => entry.pluginKey === auto)?.autoInstalled).toBe(true);
    expect(registry.plugins.find(entry => entry.pluginKey === manual)?.autoInstalled).toBeUndefined();
  });

  it('an update does not launder a dependency into a user install', async () => {
    // `repair`/`update` re-materialize the bundle; without carrying the bit the
    // next update would silently make an auto-installed dependency unprunable.
    const { service, store } = createService();
    const key = await install(service, 'vault', { autoInstalled: true });

    const repaired = await service.repair(key, { source: { kind: 'local-path', path: bundle('vault') } });

    expect(repaired.ok).toBe(true);
    const registry = await store.readInstalledRegistry();
    expect(registry.plugins.find(entry => entry.pluginKey === key)?.autoInstalled).toBe(true);
  });
});

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
