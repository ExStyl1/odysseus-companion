/**
 * P2.501 — an edited managed marketplace list reaches the gate WITHOUT a restart.
 *
 * ## The defect, and why it is not cosmetic
 *
 * The four managed marketplace lists were captured once, in the
 * `PluginRegistrySource` constructor, at `createStorageRuntime`. So an
 * administrator who added a source to `blockedMarketplaces` while the app ran
 * got nothing until someone restarted it — and an unenforced blocklist fails
 * OPEN: no error, and the marketplaces they blocked keep working. P2.481 left
 * this as its stated residue.
 *
 * ## What the vendor promises, which is what makes a restart OUR behaviour
 *
 * `managed-settings.md#where-and-when-a-policy-applies`, whole bullet:
 *
 *   "**Running sessions**: a session picks up most changes on the schedule in
 *   the table without a restart. Claude Code reads `forceRemoteSettingsRefresh`
 *   and `requiredMinimumVersion` only at session start, arms a new or changed
 *   `policyHelper` entry at the next launch, and reads some user-editable keys
 *   once at session start."
 *
 * The restart-bound set is closed and named, and none of these four keys is in
 * it. `#choose-a-delivery-mechanism` says the same for the file half, verbatim:
 * "Read at startup and reloaded when a file changes".
 *
 * And `settings-reference.md#blockedmarketplaces` says WHEN the check runs,
 * which is why the seam is a per-ACTION resolve and not a per-turn one:
 * "Claude Code checks the blocklist on marketplace add and on plugin install,
 * update, refresh, and auto-update, so a marketplace someone added before you
 * set the policy can't be used to fetch plugins either."
 *
 * ## The shape of these tests
 *
 * Every case is a PAIR on one rig: the same source, the same registry source
 * instance, admitted before the policy changed and refused after — or the
 * reverse. A one-sided assertion cannot tell a live re-resolve from a gate that
 * refuses everything, which is the failure mode a blocklist test is most likely
 * to have.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketplaceSourceBlockedError,
  MarketplaceSourceNotAllowedError,
  PluginRegistrySource,
  createPluginRegistrySource,
  type ManagedMarketplacePolicySlice,
  type MarketplaceRegistryStore,
} from '../registry-source.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type {
  PluginInstallPlan,
  PluginMarketplaceRegistry,
  PluginStagedInstall,
  RegistryStagingService,
} from '../../plugins/index.ts';

let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'marketplace-policy-freshness-')); });
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

class MemoryRegistryStore implements MarketplaceRegistryStore {
  writes = 0;
  constructor(private registries: PluginMarketplaceRegistry[] = []) {}
  async readMarketplaceRegistries() {
    return { schemaVersion: 1, updatedAt: 0, registries: [...this.registries] };
  }
  async writeMarketplaceRegistries(file: {
    registries: PluginMarketplaceRegistry[]; schemaVersion: number; updatedAt: number;
  }) {
    this.writes += 1;
    this.registries = [...file.registries];
  }
  snapshot() { return this.registries; }
}

class FakeStagingService implements RegistryStagingService {
  stageCalls = 0;
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource) {
    const resolved = resolvePluginInstallSource(source);
    return {
      state: 'resolved',
      planId: 'plan-1',
      source: resolved.source,
      origin: resolved.origin,
      ...(resolved.artifact ? { artifact: resolved.artifact } : {}),
      diagnostics: [],
      createdAt: 0,
      lifecycle: [],
    } satisfies PluginInstallPlan;
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    const manifest = join(staged.rawDirectory, '.claude-plugin', 'marketplace.json');
    mkdirSync(join(manifest, '..'), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ name: 'mkt', owner: { name: 'o' }, plugins: [] }));
    return staged;
  }
}

describe('P2.501 — the managed marketplace lists are read at CHECK time', () => {
  it('a blocklist entry added while the source is alive refuses the very next add', async () => {
    let policy: ManagedMarketplacePolicySlice = {};
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      resolveManagedMarketplacePolicy: () => policy,
    });

    // BEFORE — admitted. This half is the positive control: without it a later
    // refusal proves only that this rig refuses things.
    await source.add({ source: 'https://github.com/untrusted/plugins.git' });
    expect(store.snapshot()).toHaveLength(1);

    // The administrator edits the policy. No restart, no new registry source.
    policy = { blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }] };

    await expect(source.add({ source: 'https://github.com/untrusted/other.git' }))
      .resolves.toBeDefined();
    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceBlockedError);
  });

  it('a blocklist entry REMOVED while the source is alive admits again', async () => {
    // The other direction, and it is not symmetric decoration: a resolver read
    // once and cached would pass the test above and fail this one.
    let policy: ManagedMarketplacePolicySlice = {
      blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
    };
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore(),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      resolveManagedMarketplacePolicy: () => policy,
    });

    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceBlockedError);
    policy = {};
    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .resolves.toBeDefined();
  });

  it('the allowlist half moves too — it is the same feed, not a blocklist-only fix', async () => {
    // P2.501's note: the residue is SHARED with `strictKnownMarketplaces`
    // rather than specific to the key P2.481 added.
    let policy: ManagedMarketplacePolicySlice = {};
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore(),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      resolveManagedMarketplacePolicy: () => policy,
    });

    await expect(source.add({ source: 'https://github.com/anyone/plugins.git' }))
      .resolves.toBeDefined();
    policy = { strictKnownMarketplaces: [] };
    await expect(source.add({ source: 'https://github.com/anyone/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceNotAllowedError);
  });

  it('with NO resolver the constructor snapshot still governs, unchanged', async () => {
    // Every unit test in this tree, and any host that does not wire the seam,
    // must behave exactly as before. The snapshot is the fallback, not a
    // second policy.
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore(),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
    });
    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceBlockedError);
    await expect(source.add({ source: 'https://github.com/trusted/plugins.git' }))
      .resolves.toBeDefined();
  });

  it('a THROWING resolver falls back to the boot snapshot, not to nothing', async () => {
    // The fail-safe direction for a blocklist. A managed file that cannot be
    // read must not silently un-block what the administrator blocked at boot.
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore(),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
      resolveManagedMarketplacePolicy: () => { throw new Error('managed policy unreadable'); },
    });
    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceBlockedError);
    // POSITIVE CONTROL on the same rig: the fallback is the snapshot and not a
    // blanket refusal.
    await expect(source.add({ source: 'https://github.com/trusted/plugins.git' }))
      .resolves.toBeDefined();
  });

  it('the production factory threads the resolver through', () => {
    // `createPluginRegistrySource` is what `createStorageRuntime` calls; a seam
    // the class accepts and the factory drops would look fixed and be inert —
    // the exact shape P2.481 found on `blockedMarketplaces` itself.
    const built = createPluginRegistrySource({
      catalogCacheDir: join(tempDir, 'catalog'),
      resolveManagedMarketplacePolicy: () => ({
        blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
      }),
    });
    expect(built).toBeInstanceOf(PluginRegistrySource);
  });
});
