/**
 * The `marketplaces.json` slot — all that is left of the pre-W10 plugin store.
 *
 * Seven rows retired with the V1 halves this file used to pin (F4): the staged
 * commit into raw/normalized cache directories with registry and lock updates,
 * trust keyed by instance/capability/hash/scope/provenance, per-scope plugin and
 * capability enablement, stale-cache reuse after uninstall, same-version
 * overwrite, lifecycle-while-any-scope-enabled, and exact-scope creation for
 * capability overrides. Every one of them described `PluginStore`'s installed
 * registry, lockfile or trust file, which no production module has read since the
 * W10 cutover; `PluginStoreV2` owns that ground and `store-v2.test.ts`,
 * `capabilities/__tests__/policy-store.test.ts` and
 * `capabilities/__tests__/trust-store.test.ts` pin its versions of them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginMarketplaceRegistryStore } from '../marketplace-registry-store.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'plugin-marketplace-registry-store-test-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('PluginMarketplaceRegistryStore', () => {
  it('returns an empty marketplace-registry file by default and round-trips writes', async () => {
    const store = new PluginMarketplaceRegistryStore({ rootDirectory: join(tempDir, 'plugins'), now: () => 7000 });

    const initial = await store.readMarketplaceRegistries();
    expect(initial).toEqual({ schemaVersion: 1, updatedAt: 7000, registries: [] });

    await store.writeMarketplaceRegistries({
      schemaVersion: 1,
      updatedAt: 0,
      registries: [
        {
          id: 'reg-1',
          source: 'https://github.com/acme/registry',
          refName: 'main',
          sparsePaths: ['plugins'],
          displayName: 'Acme Registry',
          installedRoot: '/abs/clone/path',
          addedAt: 7000,
        },
      ],
    });

    const roundTripped = await store.readMarketplaceRegistries();
    // updatedAt is stamped by the store on write, not carried from the caller.
    expect(roundTripped.updatedAt).toBe(7000);
    expect(roundTripped.registries).toHaveLength(1);
    expect(roundTripped.registries[0]).toMatchObject({
      id: 'reg-1',
      source: 'https://github.com/acme/registry',
      refName: 'main',
      sparsePaths: ['plugins'],
      displayName: 'Acme Registry',
      installedRoot: '/abs/clone/path',
      addedAt: 7000,
    });
  });

  it('writes marketplaces.json atomically with mode 0600 and a trailing newline', async () => {
    const rootDirectory = join(tempDir, 'plugins');
    const store = new PluginMarketplaceRegistryStore({ rootDirectory, now: () => 7100 });
    await store.writeMarketplaceRegistries({ schemaVersion: 1, updatedAt: 0, registries: [] });

    const filePath = join(rootDirectory, 'marketplaces.json');
    const contents = readFileSync(filePath, 'utf-8');
    expect(contents.endsWith('\n')).toBe(true);
    expect(JSON.parse(contents)).toEqual({ schemaVersion: 1, updatedAt: 7100, registries: [] });
    // Atomic writer leaves no temp files behind.
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect((statSync(filePath).mode & 0o777)).toBe(0o600);
  });

  it('throws on corrupt registry JSON instead of replacing it with empty state', async () => {
    const rootDirectory = join(tempDir, 'plugins');
    mkdirSync(rootDirectory, { recursive: true });
    writeFileSync(join(rootDirectory, 'marketplaces.json'), '{ this is not json');
    const store = new PluginMarketplaceRegistryStore({ rootDirectory, now: () => 6000 });

    await expect(store.readMarketplaceRegistries()).rejects.toThrow(/invalid JSON/);
    expect(readFileSync(join(rootDirectory, 'marketplaces.json'), 'utf-8')).toBe('{ this is not json');
  });
});
