import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeNormalizedBundleHash } from '../bundle-hash.ts';
import { pluginKeyFor } from '../../workspaces/paths.ts';
import { PluginRepairDeferredError, PluginStoreV2, createPluginStoreV2 } from '../store-v2.ts';
import type { NessyPluginManifest, PluginOrigin } from '../types.ts';
import type { VerifiedStorageLayoutV2 } from '../../workspaces/storage-readiness.ts';

let tempDir: string;
const LAYOUT: VerifiedStorageLayoutV2 = { storageLayoutVersion: 2, verificationId: 'test' };

function origin(): PluginOrigin {
  return { source: 'marketplace', marketplaceId: 'internal', resolvedAt: 1 };
}

function manifest(version = '1.0.0'): NessyPluginManifest {
  return {
    schemaVersion: 1,
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version,
    capabilities: [{ kind: 'skill', id: 'review', skill: { slug: 'review', path: 'skills/review/SKILL.md' } }],
  };
}

/** Build a normalized bundle dir; `mutation` lets a caller vary content/mode. */
function stageBundle(name: string, mutation?: (root: string) => void): string {
  const root = join(tempDir, 'staged', name);
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify(manifest()));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');
  mutation?.(root);
  return root;
}

function newStore(now = makeClock()): PluginStoreV2 {
  return createPluginStoreV2(LAYOUT, { rootDirectory: join(tempDir, 'plugins'), now });
}

function makeClock(): () => number {
  let value = 1000;
  return () => value++;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for plugin prune');
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-store-v2-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('PluginStoreV2 install identity', () => {
  it('installs one content-addressed cache tree and an activation-free registry', async () => {
    const store = newStore();
    const entry = await store.install({ normalizedDirectory: stageBundle('a'), manifest: manifest(), origin: origin() });

    expect(entry.pluginInstanceId).toContain('plugin://internal/toolkit@1.0.0#');
    expect(entry.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(store.cachePathFor(entry.cacheRef))).toBe(true);

    const registryRaw = readFileSync(join(tempDir, 'plugins', 'installed.json'), 'utf-8');
    // Activation-free + portable: no activation, lifecycle or absolute paths.
    for (const forbidden of ['enabledScopes', 'lifecycleState', 'rootDirectory', 'versionDirectory', 'cacheDirectory', 'sourcePath']) {
      expect(registryRaw).not.toContain(forbidden);
    }
    expect(registryRaw).not.toContain(tempDir); // no absolute CONFIG_DIR path persisted
  });

  it('rejects an escaping normalized-bundle symlink at the store boundary', async () => {
    const outside = join(tempDir, 'outside.md');
    writeFileSync(outside, '# Outside');
    const bundle = stageBundle('unsafe', root => {
      rmSync(join(root, 'skills', 'review', 'SKILL.md'));
      symlinkSync(outside, join(root, 'skills', 'review', 'SKILL.md'));
    });
    const store = newStore();

    await expect(store.install({ normalizedDirectory: bundle, manifest: manifest(), origin: origin() }))
      .rejects.toThrow('escaping or dangling symlink');
    expect((await store.readInstalledRegistry()).plugins).toEqual([]);
  });

  /**
   * A materialized `npx` dependency graph (Task 9) vendors `node_modules/.bin`
   * entries as RELATIVE symlinks that stay inside the bundle. Placing the
   * bundle must copy them verbatim: a copy that resolves them would point the
   * cached bundle back at the staging directory, so both the containment check
   * and the content-addressed hash would reject a legitimate install.
   */
  it('installs a bundle whose relative symlink stays inside it and preserves the link target', async () => {
    const bundle = stageBundle('vendored', root => {
      mkdirSync(join(root, 'node_modules', 'astring', 'bin'), { recursive: true });
      mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'astring', 'bin', 'astring'), '#!/usr/bin/env node\n');
      symlinkSync('../astring/bin/astring', join(root, 'node_modules', '.bin', 'astring'));
    });
    const expectedHash = await computeNormalizedBundleHash(bundle);
    const store = newStore();

    const entry = await store.install({ normalizedDirectory: bundle, manifest: manifest(), origin: origin() });

    expect(entry.bundleHash).toBe(expectedHash);
    const cachedLink = join(store.cachePathFor(entry.cacheRef), 'node_modules', '.bin', 'astring');
    expect(readlinkSync(cachedLink)).toBe('../astring/bin/astring');
    expect(readFileSync(cachedLink, 'utf-8')).toBe('#!/usr/bin/env node\n');
  });

  /**
   * `fs.cp` RESOLVES relative symlinks by default, rewriting each one to an
   * absolute path into the source tree — the cached bundle would then depend on
   * a staging directory that is about to be removed. Bun's `cp` happens to copy
   * verbatim, so only an explicit option pins the behavior on the Node runtime
   * the desktop main process actually uses.
   */
  it('copies every placed bundle verbatim so relative symlinks are never resolved', async () => {
    const cp = spyOn(fsPromises, 'cp');
    try {
      const store = newStore();
      const entry = await store.install({ normalizedDirectory: stageBundle('verbatim-a'), manifest: manifest(), origin: origin() });
      await store.repair(entry.pluginInstanceId, {
        normalizedDirectory: stageBundle('verbatim-b'),
        manifest: manifest(),
        origin: origin(),
      });

      expect(cp.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [, , options] of cp.mock.calls) {
        expect(options).toMatchObject({ recursive: true, verbatimSymlinks: true });
      }
    } finally {
      cp.mockRestore();
    }
  });

  it('reinstalling the same bundle keeps a single cache tree', async () => {
    const store = newStore();
    await store.install({ normalizedDirectory: stageBundle('a'), manifest: manifest(), origin: origin() });
    await store.install({ normalizedDirectory: stageBundle('a2'), manifest: manifest(), origin: origin() });
    const registry = await store.readInstalledRegistry();
    expect(registry.plugins).toHaveLength(1);
  });

  it('resolves logical cache refs under a different config root (portable)', async () => {
    const store = newStore();
    const entry = await store.install({ normalizedDirectory: stageBundle('a'), manifest: manifest(), origin: origin() });
    // The same logical ref resolves under any other store root.
    const other = createPluginStoreV2(LAYOUT, { rootDirectory: join(tempDir, 'other-root') });
    const otherPath = other.cachePathFor(entry.cacheRef);
    expect(otherPath).toContain(join(tempDir, 'other-root'));
    expect(otherPath.endsWith(entry.bundleHash)).toBe(true);
  });

  it('refuses to import an incompatible registry schema', async () => {
    mkdirSync(join(tempDir, 'plugins'), { recursive: true });
    writeFileSync(join(tempDir, 'plugins', 'installed.json'), JSON.stringify({ schemaVersion: 1, plugins: [] }));
    await expect(newStore().readInstalledRegistry()).rejects.toThrow(/Incompatible/);
  });
});

describe('PluginStoreV2 lease-safe update and prune', () => {
  it('retains a leased prior instance across an update, then prunes it once released', async () => {
    const store = newStore();
    const v1 = await store.install({ normalizedDirectory: stageBundle('v1'), manifest: manifest('1.0.0'), origin: origin() });
    const v1CachePath = store.cachePathFor(v1.cacheRef);

    // A running turn captures a lease on the prior immutable instance.
    const release = store.acquireInstanceLease(v1.pluginInstanceId);

    const v2 = await store.install({ normalizedDirectory: stageBundle('v2'), manifest: manifest('2.0.0'), origin: origin() });
    expect(v2.pluginInstanceId).not.toBe(v1.pluginInstanceId);

    // Active switched to v2, but v1 is still readable under lease.
    const afterUpdate = await store.readInstalledRegistry();
    expect(afterUpdate.active[v1.pluginKey]).toBe(v2.pluginInstanceId);
    expect(afterUpdate.plugins.map(p => p.pluginInstanceId).sort()).toEqual(
      [v1.pluginInstanceId, v2.pluginInstanceId].sort(),
    );
    expect(existsSync(v1CachePath)).toBe(true);

    // Once the last lease drains, v1's record and cache tree are pruned
    // automatically; callers must not need a second lifecycle mutation.
    release();
    let pruned = await store.readInstalledRegistry();
    await waitFor(async () => {
      pruned = await store.readInstalledRegistry();
      return !existsSync(v1CachePath)
        && !pruned.plugins.some(p => p.pluginInstanceId === v1.pluginInstanceId);
    });
    expect(pruned.plugins.map(p => p.pluginInstanceId)).toEqual([v2.pluginInstanceId]);
    expect(existsSync(v1CachePath)).toBe(false);
    expect(existsSync(store.cachePathFor(v2.cacheRef))).toBe(true);
  });

  it('startup prune removes every inactive unleased instance', async () => {
    const store = newStore();
    const v1 = await store.install({ normalizedDirectory: stageBundle('v1'), manifest: manifest('1.0.0'), origin: origin() });
    const hold = store.acquireInstanceLease(v1.pluginInstanceId);
    const v2 = await store.install({ normalizedDirectory: stageBundle('v2'), manifest: manifest('2.0.0'), origin: origin() });
    hold();

    await store.pruneOnStartup();
    const registry = await store.readInstalledRegistry();
    expect(registry.plugins.map(p => p.pluginInstanceId)).toEqual([v2.pluginInstanceId]);
  });

  it('startup backfills missing runtime metadata from the hash-verified normalized bundle', async () => {
    const store = newStore();
    const compatibleManifest: NessyPluginManifest = {
      ...manifest(),
      runtimeCompatibility: { profiles: ['codex-plugin-env-v1'] },
    };
    const bundle = stageBundle('backfill-profile', root => {
      writeFileSync(join(root, 'plugin.json'), JSON.stringify(compatibleManifest));
    });
    const stale = await store.install({
      normalizedDirectory: bundle,
      manifest: manifest(),
      origin: origin(),
    });
    expect(stale.manifest.runtimeCompatibility).toBeUndefined();

    await store.pruneOnStartup();

    const registry = await store.readInstalledRegistry();
    expect(registry.plugins[0]?.manifest.runtimeCompatibility).toEqual({ profiles: ['codex-plugin-env-v1'] });
  });

  it('startup never backfills runtime metadata from cache bytes that fail the bundle hash', async () => {
    const store = newStore();
    const entry = await store.install({
      normalizedDirectory: stageBundle('tampered-profile'),
      manifest: manifest(),
      origin: origin(),
    });
    const tamperedManifest: NessyPluginManifest = {
      ...manifest(),
      runtimeCompatibility: { profiles: ['codex-plugin-env-v1'] },
    };
    writeFileSync(join(store.cachePathFor(entry.cacheRef), 'plugin.json'), JSON.stringify(tamperedManifest));

    await store.pruneOnStartup();

    const registry = await store.readInstalledRegistry();
    expect(registry.plugins[0]?.manifest.runtimeCompatibility).toBeUndefined();
  });

  it('queues a lease-release prune behind an in-flight prune', async () => {
    const store = newStore();
    const v1 = await store.install({ normalizedDirectory: stageBundle('v1'), manifest: manifest('1.0.0'), origin: origin() });
    const release = store.acquireInstanceLease(v1.pluginInstanceId);
    const v2 = await store.install({ normalizedDirectory: stageBundle('v2'), manifest: manifest('2.0.0'), origin: origin() });

    const internals = store as unknown as { pruneInactiveInstances(): Promise<void> };
    const originalPrune = internals.pruneInactiveInstances.bind(store);
    let calls = 0;
    let markStarted!: () => void;
    let continuePrune!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const resume = new Promise<void>(resolve => { continuePrune = resolve; });
    internals.pruneInactiveInstances = async () => {
      calls += 1;
      if (calls === 1) {
        markStarted();
        await resume;
      }
      await originalPrune();
    };

    const inFlight = store.prune();
    await started;
    release();
    continuePrune();
    await inFlight;

    expect(calls).toBe(2);
    const registry = await store.readInstalledRegistry();
    expect(registry.plugins.map(p => p.pluginInstanceId)).toEqual([v2.pluginInstanceId]);
  });
});

describe('PluginStoreV2 repair', () => {
  it('same-version different-hash repair stages side-by-side while a lease is held', async () => {
    const store = newStore();
    const original = await store.install({ normalizedDirectory: stageBundle('orig'), manifest: manifest('1.0.0'), origin: origin() });
    const originalPath = store.cachePathFor(original.cacheRef);
    const release = store.acquireInstanceLease(original.pluginInstanceId);

    // A different bundle hash (extra file) repairs side-by-side.
    const repaired = await store.repair(original.pluginInstanceId, {
      normalizedDirectory: stageBundle('repaired', root => writeFileSync(join(root, 'EXTRA.md'), 'x')),
      manifest: manifest('1.0.0'),
      origin: origin(),
    });
    expect(repaired.bundleHash).not.toBe(original.bundleHash);
    // Old and new hash directories coexist until the old lease drains.
    expect(existsSync(originalPath)).toBe(true);
    expect(existsSync(store.cachePathFor(repaired.cacheRef))).toBe(true);

    release();
    await store.prune();
    expect(existsSync(originalPath)).toBe(false);
  });

  it('same-hash repair defers while leased and replaces once unleased', async () => {
    const store = newStore();
    const entry = await store.install({ normalizedDirectory: stageBundle('orig'), manifest: manifest('1.0.0'), origin: origin() });
    const cachePath = store.cachePathFor(entry.cacheRef);

    // Corrupt the on-disk bytes (an identical-hash repair must restore them).
    writeFileSync(join(cachePath, 'skills', 'review', 'SKILL.md'), '# corrupted');
    const release = store.acquireInstanceLease(entry.pluginInstanceId);

    const identical = () =>
      store.repair(entry.pluginInstanceId, {
        normalizedDirectory: stageBundle('restore'),
        manifest: manifest('1.0.0'),
        origin: origin(),
      });

    await expect(identical()).rejects.toBeInstanceOf(PluginRepairDeferredError);
    // The leased bytes were not mutated by the deferred repair.
    expect(readFileSync(join(cachePath, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('# corrupted');

    release();
    await identical();
    // After the lease drains, the verified copy replaces the directory.
    expect(readFileSync(join(cachePath, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('# Review');
    expect(await computeNormalizedBundleHash(cachePath)).toBe(entry.bundleHash);
  });

  it('rolls back the original cache when the verified replacement rename fails', async () => {
    const store = newStore();
    const entry = await store.install({ normalizedDirectory: stageBundle('orig'), manifest: manifest('1.0.0'), origin: origin() });
    const cachePath = store.cachePathFor(entry.cacheRef);
    const originalRename = fsPromises.rename;
    let cacheWasRetired = false;
    const rename = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(from).startsWith(`${cachePath}.repair.`) && to === cachePath) {
        throw new Error('replacement-rename-failed');
      }
      if (from === cachePath && String(to).startsWith(`${cachePath}.retired.`)) cacheWasRetired = true;
      return originalRename(from, to);
    });

    try {
      await expect(store.repair(entry.pluginInstanceId, {
        normalizedDirectory: stageBundle('restore'),
        manifest: manifest('1.0.0'),
        origin: origin(),
      })).rejects.toThrow('replacement-rename-failed');
    } finally {
      rename.mockRestore();
    }

    expect(cacheWasRetired).toBe(true);
    expect(existsSync(cachePath)).toBe(true);
    expect(await computeNormalizedBundleHash(cachePath)).toBe(entry.bundleHash);
    const registry = await store.readInstalledRegistry();
    expect(registry.active[entry.pluginKey]).toBe(entry.pluginInstanceId);
  });

  it('fails closed in the registry when replacement and rollback both fail', async () => {
    const store = newStore();
    const entry = await store.install({ normalizedDirectory: stageBundle('orig'), manifest: manifest('1.0.0'), origin: origin() });
    const cachePath = store.cachePathFor(entry.cacheRef);
    const originalRename = fsPromises.rename;
    const rename = spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (to === cachePath && (
        String(from).startsWith(`${cachePath}.repair.`)
        || String(from).startsWith(`${cachePath}.retired.`)
      )) {
        throw new Error('cache-rename-failed');
      }
      return originalRename(from, to);
    });

    try {
      await expect(store.repair(entry.pluginInstanceId, {
        normalizedDirectory: stageBundle('restore'),
        manifest: manifest('1.0.0'),
        origin: origin(),
      })).rejects.toThrow('Plugin cache replacement and rollback failed');
    } finally {
      rename.mockRestore();
    }

    const registry = await store.readInstalledRegistry();
    expect(registry.active[entry.pluginKey]).toBeUndefined();
    expect(registry.plugins.some(candidate => candidate.pluginInstanceId === entry.pluginInstanceId)).toBe(false);
  });

  it('same-hash repair persists revalidated manifest metadata', async () => {
    const store = newStore();
    const compatibleManifest: NessyPluginManifest = {
      ...manifest(),
      runtimeCompatibility: { profiles: ['codex-plugin-env-v1'] },
    };
    const normalized = (name: string) => stageBundle(name, root => {
      writeFileSync(join(root, 'plugin.json'), JSON.stringify(compatibleManifest));
    });

    // Reproduces an entry installed while manifest normalization dropped the
    // profile even though the immutable normalized bundle already carried it.
    const stale = await store.install({
      normalizedDirectory: normalized('stale-profile'),
      manifest: manifest(),
      origin: origin(),
    });
    const repaired = await store.repair(stale.pluginInstanceId, {
      normalizedDirectory: normalized('revalidated-profile'),
      manifest: compatibleManifest,
      origin: origin(),
    });

    expect(repaired.pluginInstanceId).toBe(stale.pluginInstanceId);
    expect(repaired.manifest.runtimeCompatibility).toEqual({ profiles: ['codex-plugin-env-v1'] });
    const persisted = await store.readInstalledRegistry();
    expect(persisted.plugins[0]?.manifest.runtimeCompatibility).toEqual({ profiles: ['codex-plugin-env-v1'] });
  });

  it('retains the last known good instance readable and switches active atomically only after the new one validates', async () => {
    const store = newStore();
    const v1 = await store.install({ normalizedDirectory: stageBundle('v1'), manifest: manifest('1.0.0'), origin: origin() });

    // A concurrent reader captures a lease on the current (last known good)
    // instance before repair starts — it must see v1's active, valid bundle
    // throughout the repair, never a half-written directory.
    const release = store.acquireInstanceLease(v1.pluginInstanceId);
    const registryDuringRepair = await store.readInstalledRegistry();
    expect(registryDuringRepair.active[v1.pluginKey]).toBe(v1.pluginInstanceId);
    expect(await computeNormalizedBundleHash(store.cachePathFor(v1.cacheRef))).toBe(v1.bundleHash);

    const v2 = await store.repair(v1.pluginInstanceId, {
      normalizedDirectory: stageBundle('v2', root => writeFileSync(join(root, 'EXTRA.md'), 'v2')),
      manifest: manifest('1.0.0'),
      origin: origin(),
    });

    // The switch to the new instance is atomic and immediate...
    const afterRepair = await store.readInstalledRegistry();
    expect(afterRepair.active[v1.pluginKey]).toBe(v2.pluginInstanceId);
    // ...yet the last known good (v1) bundle is still intact and readable
    // under the still-held lease — it was never mutated or removed.
    expect(await computeNormalizedBundleHash(store.cachePathFor(v1.cacheRef))).toBe(v1.bundleHash);

    release();
    await store.prune();
    expect(existsSync(store.cachePathFor(v1.cacheRef))).toBe(false);
    expect(existsSync(store.cachePathFor(v2.cacheRef))).toBe(true);
  });

  it('does not lose either install under concurrent installs of two different plugins', async () => {
    const store = newStore();

    // Two unrelated plugins installed concurrently (e.g. two marketplace
    // installs racing) must both land in the shared registry.json — each is
    // active for its own distinct PluginKey, so both are legitimately kept,
    // proving the read-modify-write of the shared file is serialized rather
    // than one writer silently clobbering the other's `plugins` entry.
    const [a, b] = await Promise.all([
      store.install({ normalizedDirectory: stageBundle('plugin-a', root => writeFileSync(join(root, 'plugin.json'), JSON.stringify({ ...manifest(), id: 'plugin-a' }))), manifest: { ...manifest(), id: 'plugin-a' }, origin: origin() }),
      store.install({ normalizedDirectory: stageBundle('plugin-b', root => writeFileSync(join(root, 'plugin.json'), JSON.stringify({ ...manifest(), id: 'plugin-b' }))), manifest: { ...manifest(), id: 'plugin-b' }, origin: origin() }),
    ]);

    const registry = await store.readInstalledRegistry();
    expect(registry.plugins.map(p => p.pluginInstanceId).sort()).toEqual(
      [a.pluginInstanceId, b.pluginInstanceId].sort(),
    );
    expect(registry.active[a.pluginKey]).toBe(a.pluginInstanceId);
    expect(registry.active[b.pluginKey]).toBe(b.pluginInstanceId);
    for (const entry of registry.plugins) {
      expect(await computeNormalizedBundleHash(store.cachePathFor(entry.cacheRef))).toBe(entry.bundleHash);
    }
  });

  it('does not lose a leased prior instance under a concurrent update race on the same PluginKey', async () => {
    const store = newStore();
    const v1 = await store.install({ normalizedDirectory: stageBundle('v1'), manifest: manifest('1.0.0'), origin: origin() });

    // Two concurrent updates targeting the same stable PluginKey (e.g. a
    // user-initiated update racing an automatic refresh). v1 is leased (a
    // live turn references it), so — regardless of which racer's write to
    // the shared registry.json lands last — v1's entry must never be
    // silently dropped from `registry.plugins` by the other's unserialized
    // read-modify-write (RED-proven: without the mutex, one writer's whole
    // `plugins` array replaces the other's, losing the leased entry even
    // though nothing pruned it).
    const release = store.acquireInstanceLease(v1.pluginInstanceId);
    try {
      const [v2, v3] = await Promise.all([
        store.install({ normalizedDirectory: stageBundle('v2'), manifest: manifest('2.0.0'), origin: origin() }),
        store.repair(v1.pluginInstanceId, {
          normalizedDirectory: stageBundle('v1-repaired', root => writeFileSync(join(root, 'EXTRA.md'), 'r')),
          manifest: manifest('1.0.0'),
          origin: origin(),
        }),
      ]);

      const registry = await store.readInstalledRegistry();
      const instanceIds = registry.plugins.map(p => p.pluginInstanceId);
      expect(instanceIds).toContain(v1.pluginInstanceId);
      // `active` deterministically points at exactly one of the two racing
      // writers — never lost, never corrupted to an unknown value.
      expect(registry.active[v1.pluginKey]).toBeDefined();
      expect([v2.pluginInstanceId, v3.pluginInstanceId]).toContain(registry.active[v1.pluginKey]!);
      // Every cache tree still present in the registry is intact on disk.
      for (const entry of registry.plugins) {
        expect(await computeNormalizedBundleHash(store.cachePathFor(entry.cacheRef))).toBe(entry.bundleHash);
      }
    } finally {
      release();
    }
  });
});

/**
 * P6.418 — an image can lay plugins down for a first session to find.
 *
 * The row's title said they "cannot be pre-populated", which is too strong: the
 * registry file CAN be written by an image. The blocker is the HASH — every
 * entry carries a `bundleHash` the store computes and later verifies, so a
 * hand-laid entry is silently skipped, present in the file and absent from the
 * product. The seed is therefore a tree of normalized BUNDLES that the store's
 * own `install()` materialises, so the hash is computed by the code that
 * verifies it.
 */
describe('P6.418 — seeding plugins from a directory an image laid down', () => {
  it('installs each seeded bundle with a hash the store itself computed', async () => {
    const store = newStore();
    const seedDirectory = join(tempDir, 'seed');
    mkdirSync(join(seedDirectory, 'toolkit', 'skills', 'review'), { recursive: true });
    writeFileSync(join(seedDirectory, 'toolkit', 'plugin.json'), JSON.stringify(manifest()));
    writeFileSync(join(seedDirectory, 'toolkit', 'skills', 'review', 'SKILL.md'), '# Review');

    const seededKey = pluginKeyFor('seed', 'toolkit');
    const receipt = await store.seedFromDirectory(seedDirectory);
    expect(receipt.seeded).toEqual([seededKey]);

    const registry = await store.readInstalledRegistry();
    const entry = registry.plugins.find(plugin => plugin.pluginKey === seededKey);
    // The whole point of the row: the recorded hash is the one the verifier
    // derives from the bytes, not one an image guessed.
    expect(entry?.bundleHash).toBe(await computeNormalizedBundleHash(join(seedDirectory, 'toolkit')));
    expect(registry.active[seededKey]).toBe(entry?.pluginInstanceId);

    // Idempotent: an image is re-seeded on every start.
    const second = await store.seedFromDirectory(seedDirectory);
    expect(second.seeded).toEqual([]);
    expect(second.skipped).toEqual([{ directory: join(seedDirectory, 'toolkit'), reason: 'already installed' }]);
  });

  it('records a malformed bundle instead of failing the startup — the boundary', async () => {
    // Fail-soft in both directions: with no seed directory at all (the normal
    // case) the pass is silent, and one bad bundle must not take down an app
    // whose other plugins are fine. Without this arm the case above is equally
    // consistent with a pass that throws on anything unexpected.
    const store = newStore();
    expect(await store.seedFromDirectory(join(tempDir, 'absent'))).toEqual({ seeded: [], skipped: [] });

    const seedDirectory = join(tempDir, 'seed-bad');
    mkdirSync(join(seedDirectory, 'broken'), { recursive: true });
    writeFileSync(join(seedDirectory, 'broken', 'plugin.json'), '{ not json');
    const receipt = await store.seedFromDirectory(seedDirectory);
    expect(receipt.seeded).toEqual([]);
    expect(receipt.skipped[0]?.reason).toContain('invalid plugin.json');
  });
});
