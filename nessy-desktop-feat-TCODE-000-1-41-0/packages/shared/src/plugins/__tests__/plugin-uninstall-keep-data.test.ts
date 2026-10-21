/**
 * P6.437 — the documented `--keep-data` option, which this fork did not have.
 *
 * `plugins/components.md#path-variables-and-persistent-data`, verbatim: *"The data
 * directory is deleted automatically when you uninstall the plugin from the last
 * scope where it is installed. … The CLI deletes by default; pass `--keep-data`
 * to preserve it."* So delete-by-default is the page's own posture and stays
 * ours — the NEGATIVE arm below is as load-bearing as the positive one, because
 * a `keepData` that leaked into the default would silently start hoarding
 * uninstalled plugins' data.
 *
 * `#plugin-uninstall` gives the flag's stated purpose — *"for example when
 * reinstalling after testing a new version"* — which is why the retained path is
 * reported: kept data a caller cannot find is not preserved, it is lost.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { getPluginDataRoot } from '../../workspaces/paths.ts';
import { removePluginData, resolvePluginDataPath } from '../data-paths.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginKey } from '../types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-keep-data-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  return join(dir, 'plugins', 'data');
}

function createService(): PluginManagementServiceV2 {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') });
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
    workspaceIds: () => existsSync(join(dir, 'workspaces')) ? readdirSync(join(dir, 'workspaces')) : [],
  });
  return installs.track(new PluginManagementServiceV2({
    store,
    policyStore,
    trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') }),
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
    dataLifecycle: { onPluginUninstall: ({ pluginKey }) => removePluginData(pluginKey, dataDir()) },
    pluginDataDir: dataDir(),
  }));
}

function createBundle(): string {
  const root = join(dir, 'source');
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version: '1.0.0',
    capabilities: [{ kind: 'skill', id: 'review', skill: { slug: 'review', path: 'skills/review/SKILL.md' } }],
  }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');
  return root;
}

/** Install the bundle and leave one byte of writable data behind it. */
async function installWithData(service: PluginManagementServiceV2): Promise<PluginKey> {
  const result = await service.install(
    { kind: 'local-path', path: createBundle() },
    { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
  );
  expect(result.ok).toBe(true);
  const pluginKey = result.installed!.pluginKey;
  const bucket = resolvePluginDataPath(pluginKey, { workspaceId: 'ws_a' }, dataDir());
  mkdirSync(bucket, { recursive: true });
  writeFileSync(join(bucket, 'state.json'), '{"runs":3}');
  return pluginKey;
}

describe('P6.437 — uninstall --keep-data', () => {
  it('deletes the data directory by default, which is the page\'s own posture', async () => {
    const service = createService();
    const pluginKey = await installWithData(service);
    const root = getPluginDataRoot(pluginKey, dataDir());
    expect(existsSync(root)).toBe(true);

    const outcome = await service.uninstall(pluginKey);

    expect(existsSync(root)).toBe(false);
    // No path is reported when nothing was kept — the field is the retention's
    // receipt, not a description of where data would have been.
    expect(outcome.keptDataPath).toBeUndefined();
  });

  it('keeps the directory and names it by absolute path when asked', async () => {
    const service = createService();
    const pluginKey = await installWithData(service);
    const root = getPluginDataRoot(pluginKey, dataDir());

    const outcome = await service.uninstall(pluginKey, { keepData: true });

    expect(outcome.keptDataPath).toBe(root);
    expect(existsSync(join(
      resolvePluginDataPath(pluginKey, { workspaceId: 'ws_a' }, dataDir()),
      'state.json',
    ))).toBe(true);
  });

  it('the kept root is version-LESS, so a reinstall at a new version finds it again', async () => {
    // `data-paths.ts`'s own docblock: "Because the plugin key omits the version,
    // data survives version updates." That is the page's stated reason for the
    // flag ("when reinstalling after testing a new version"), so it is asserted
    // rather than assumed.
    const service = createService();
    const pluginKey = await installWithData(service);

    const outcome = await service.uninstall(pluginKey, { keepData: true });

    expect(outcome.keptDataPath).not.toContain('1.0.0');
    const reinstalled = await service.install({ kind: 'local-path', path: createBundle() });
    expect(reinstalled.installed!.pluginKey).toBe(pluginKey);
    expect(getPluginDataRoot(reinstalled.installed!.pluginKey, dataDir())).toBe(outcome.keptDataPath!);
  });

  it('the plugin itself is gone either way — keepData preserves data, not the install', async () => {
    const service = createService();
    const pluginKey = await installWithData(service);

    await service.uninstall(pluginKey, { keepData: true });

    const status = await service.status();
    expect(status.installed.map(entry => entry.pluginKey)).not.toContain(pluginKey);
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
