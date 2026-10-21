import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import {
  LEGACY_NESSY_EXTENSION_ADAPTER_ID,
  LEGACY_NESSY_EXTENSION_ADAPTER_VERSION,
} from '../format-adapters.ts';
import { migrateOutdatedPluginAdaptersOnStartup } from '../adapter-migration.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { NessyPluginManifest, PluginOrigin } from '../types.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-adapter-migration-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installed plugin adapter migration', () => {
  it('repairs a stale legacy cache from its recorded adapter instead of generated plugin.json', async () => {
    const source = createLegacyBundle('stale');
    const store = new PluginStoreV2({ rootDirectory: join(root, 'store') });
    const trustStore = new CapabilityTrustStore({ path: join(root, 'trust.json') });
    const installed = await store.install({
      normalizedDirectory: source,
      manifest: staleManifest(),
      origin: legacyOrigin('1'),
    });
    const staleTrust = {
      pluginInstanceId: installed.pluginInstanceId,
      capabilityId: 'agent:diary-writer',
      executableHash: 'a'.repeat(64),
      scope: { kind: 'global' as const },
    };
    trustStore.grant(staleTrust);
    const reconciled: string[] = [];

    const result = await migrateOutdatedPluginAdaptersOnStartup({
      store,
      trustStore,
      onPluginRepair: entry => { reconciled.push(entry.pluginInstanceId); },
    });

    expect(result.migrated).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info',
      code: 'plugin.adapter_migration.completed',
    }));
    const registry = await store.readInstalledRegistry();
    const activeId = registry.active[installed.pluginKey];
    const repaired = registry.plugins.find(entry => entry.pluginInstanceId === activeId);
    expect(repaired).toBeDefined();
    if (!repaired) throw new Error('repaired plugin entry missing');
    expect(repaired.pluginInstanceId).not.toBe(installed.pluginInstanceId);
    expect(repaired.pluginKey).toBe(installed.pluginKey);
    expect(repaired.origin).toMatchObject({
      adapterId: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
      adapterVersion: LEGACY_NESSY_EXTENSION_ADAPTER_VERSION,
    });
    expect(repaired.manifest.compatibility?.adapter).toMatchObject({
      adapterId: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
      adapterVersion: LEGACY_NESSY_EXTENSION_ADAPTER_VERSION,
    });
    const agent = repaired.manifest.capabilities.find(capability => capability.kind === 'agent');
    expect(agent?.kind).toBe('agent');
    if (agent?.kind !== 'agent') throw new Error('repaired agent capability missing');
    expect(agent.agent).not.toHaveProperty('model');
    expect(agent.agent.tools).toEqual(['ReadFile', 'Grep']);
    expect(trustStore.isTrusted(staleTrust)).toBe(false);
    expect(reconciled).toEqual([repaired.pluginInstanceId]);
    expect(existsSync(join(store.cachePathFor(repaired.cacheRef), 'nessy-extension.json'))).toBe(true);
    const cachedManifest = JSON.parse(readFileSync(
      join(store.cachePathFor(repaired.cacheRef), 'plugin.json'),
      'utf-8',
    )) as NessyPluginManifest;
    expect(cachedManifest.capabilities).toEqual(repaired.manifest.capabilities);
  });

  it('leaves store and trust bytes unchanged when repair fails', async () => {
    const source = createLegacyBundle('repair-failure');
    const storeRoot = join(root, 'store');
    const trustPath = join(root, 'trust.json');
    const store = new PluginStoreV2({ rootDirectory: storeRoot });
    const trustStore = new CapabilityTrustStore({ path: trustPath });
    const installed = await store.install({
      normalizedDirectory: source,
      manifest: staleManifest(),
      origin: legacyOrigin('1'),
    });
    const trust = {
      pluginInstanceId: installed.pluginInstanceId,
      capabilityId: 'agent:diary-writer',
      executableHash: 'c'.repeat(64),
      scope: { kind: 'global' as const },
    };
    trustStore.grant(trust);
    const cacheManifestPath = join(store.cachePathFor(installed.cacheRef), 'plugin.json');
    const before = {
      registry: readFileSync(join(storeRoot, 'installed.json'), 'utf-8'),
      lock: readFileSync(join(storeRoot, 'lock.json'), 'utf-8'),
      trust: readFileSync(trustPath, 'utf-8'),
      cacheManifest: readFileSync(cacheManifestPath, 'utf-8'),
    };
    store.repair = async () => { throw new Error('injected repair failure'); };

    const result = await migrateOutdatedPluginAdaptersOnStartup({ store, trustStore });

    expect(result.migrated).toBe(0);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'warning',
      code: 'plugin.adapter_migration.failed',
    })]);
    expect(readFileSync(join(storeRoot, 'installed.json'), 'utf-8')).toBe(before.registry);
    expect(readFileSync(join(storeRoot, 'lock.json'), 'utf-8')).toBe(before.lock);
    expect(readFileSync(trustPath, 'utf-8')).toBe(before.trust);
    expect(readFileSync(cacheManifestPath, 'utf-8')).toBe(before.cacheManifest);
    expect(trustStore.isTrusted(trust)).toBe(true);
  });

  it('reports a committed repair when obsolete trust cleanup fails', async () => {
    const source = createLegacyBundle('trust-cleanup-failure');
    const store = new PluginStoreV2({ rootDirectory: join(root, 'store') });
    const trustStore = new CapabilityTrustStore({ path: join(root, 'trust.json') });
    const installed = await store.install({
      normalizedDirectory: source,
      manifest: staleManifest(),
      origin: legacyOrigin('1'),
    });
    trustStore.purgePluginInstances = () => { throw new Error('injected trust cleanup failure'); };

    const result = await migrateOutdatedPluginAdaptersOnStartup({ store, trustStore });

    expect(result.migrated).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'info',
      code: 'plugin.adapter_migration.completed',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'plugin.adapter_migration.trust_cleanup_pending',
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      code: 'plugin.adapter_migration.failed',
    }));
    const registry = await store.readInstalledRegistry();
    expect(registry.active[installed.pluginKey]).not.toBe(installed.pluginInstanceId);
  });

  it('does not rewrite an active cache already normalized by the current adapter', async () => {
    const source = createLegacyBundle('current');
    const storeRoot = join(root, 'store');
    const store = new PluginStoreV2({ rootDirectory: storeRoot });
    const trustStore = new CapabilityTrustStore({ path: join(root, 'trust.json') });
    const current = staleManifest();
    current.compatibility!.adapter!.adapterVersion = LEGACY_NESSY_EXTENSION_ADAPTER_VERSION;
    delete (current.capabilities[0] as Extract<NessyPluginManifest['capabilities'][number], { kind: 'agent' }>).agent.model;
    writeJson(join(source, 'plugin.json'), current);
    await store.install({
      normalizedDirectory: source,
      manifest: current,
      origin: legacyOrigin(LEGACY_NESSY_EXTENSION_ADAPTER_VERSION),
    });
    const before = readFileSync(join(storeRoot, 'installed.json'), 'utf-8');
    let reconciled = false;

    const result = await migrateOutdatedPluginAdaptersOnStartup({
      store,
      trustStore,
      onPluginRepair: () => { reconciled = true; },
    });

    expect(result).toEqual({ migrated: 0, diagnostics: [] });
    expect(readFileSync(join(storeRoot, 'installed.json'), 'utf-8')).toBe(before);
    expect(reconciled).toBe(false);
  });

  it('does not down-migrate a cache written by a newer adapter', async () => {
    const source = createLegacyBundle('future');
    const storeRoot = join(root, 'store');
    const store = new PluginStoreV2({ rootDirectory: storeRoot });
    const trustStore = new CapabilityTrustStore({ path: join(root, 'trust.json') });
    const future = staleManifest();
    future.compatibility!.adapter!.adapterVersion = '3';
    writeJson(join(source, 'plugin.json'), future);
    const installed = await store.install({
      normalizedDirectory: source,
      manifest: future,
      origin: legacyOrigin('3'),
    });
    const trust = {
      pluginInstanceId: installed.pluginInstanceId,
      capabilityId: 'agent:diary-writer',
      executableHash: 'b'.repeat(64),
      scope: { kind: 'global' as const },
    };
    trustStore.grant(trust);
    const before = readFileSync(join(storeRoot, 'installed.json'), 'utf-8');
    let reconciled = false;

    const result = await migrateOutdatedPluginAdaptersOnStartup({
      store,
      trustStore,
      onPluginRepair: () => { reconciled = true; },
    });

    expect(result.migrated).toBe(0);
    expect(result.diagnostics).toEqual([expect.objectContaining({
      severity: 'warning',
      code: 'plugin.adapter_migration.newer_adapter_version',
    })]);
    expect(readFileSync(join(storeRoot, 'installed.json'), 'utf-8')).toBe(before);
    expect(trustStore.isTrusted(trust)).toBe(true);
    expect(reconciled).toBe(false);
  });
});

function createLegacyBundle(name: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, 'agents'), { recursive: true });
  writeJson(join(directory, 'nessy-extension.json'), {
    id: 'diary-plugin',
    name: 'Diary plugin',
    version: '1.0.0',
    agents: ['agents/diary.md'],
  });
  writeFileSync(join(directory, 'agents', 'diary.md'), [
    '---',
    'name: diary-writer',
    'tools:',
    '  - ReadFile',
    '  - Grep',
    'modelConfig:',
    '  model: qwen3-coder-plus',
    '---',
    '',
    'Write a diary entry.',
    '',
  ].join('\n'));
  writeJson(join(directory, 'plugin.json'), staleManifest());
  return directory;
}

function staleManifest(): NessyPluginManifest {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    id: 'diary-plugin',
    name: 'Diary plugin',
    version: '1.0.0',
    capabilities: [{
      id: 'agent:diary-writer',
      kind: 'agent',
      agent: {
        name: 'diary-writer',
        path: 'agents/diary.md',
        model: 'qwen3-coder-plus',
        tools: ['ReadFile', 'Grep'],
      },
    }],
    compatibility: {
      rawExternalKind: 'nessy-extension',
      adapter: {
        adapterId: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
        adapterVersion: '1',
        rawKind: 'nessy-extension',
        warnings: [],
      },
    },
  };
}

function legacyOrigin(adapterVersion: string): PluginOrigin {
  return {
    source: 'marketplace',
    marketplaceId: 'internal',
    adapterId: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
    adapterVersion,
    resolvedAt: 1,
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
