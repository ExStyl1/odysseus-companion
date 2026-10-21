/**
 * P6.421 — the refresh `plugins/install.md#install-a-plugin` puts AHEAD of a
 * named install.
 *
 * Verbatim from that section (fetched 2026-09-05, anchor confirmed by grepping
 * `id="install-plugins"` on the rendered page):
 *
 *   "**With a marketplace name**: when you install `plugin-name@marketplace-name`,
 *   in a session or with `claude plugin install`, Claude Code refreshes that
 *   marketplace before the lookup. Claude Code runs the refresh even if you
 *   turned off auto-update for the marketplace or set `DISABLE_AUTOUPDATER`.
 *   … Claude Code skips this refresh when: … Claude Code refreshed the
 *   marketplace within the last 30 seconds. … You set
 *   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`."
 *
 *   "If the refresh before a named install fails, for example because you're
 *   offline, Claude Code looks the plugin up in the cached catalog anyway."
 *
 * The primitive already existed (`upgrade({marketplaceId})`); only the install
 * path did not call it. So these assertions are about the SKIP LIST and the
 * fail-soft return, not about a second fetch path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistrySource, type MarketplaceRegistryStore } from '../registry-source.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type {
  PluginInstallPlan,
  PluginMarketplaceRegistry,
  PluginStagedInstall,
  RegistryStagingService,
} from '../../plugins/index.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'install-refresh-test-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

class MemoryRegistryStore implements MarketplaceRegistryStore {
  constructor(private registries: PluginMarketplaceRegistry[] = []) {}
  async readMarketplaceRegistries() {
    return { schemaVersion: 1, updatedAt: 0, registries: [...this.registries] };
  }
  async writeMarketplaceRegistries(file: { registries: PluginMarketplaceRegistry[]; schemaVersion: number; updatedAt: number }) {
    this.registries = [...file.registries];
  }
}

/** Counts clones so a SKIPPED refresh is distinguishable from a cheap one. */
class CountingStagingService implements RegistryStagingService {
  stageCalls = 0;
  fail = false;
  constructor(private readonly files: Record<string, string> = {}) {}
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
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
    };
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    if (this.fail) throw new Error('git clone failed (offline)');
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    for (const [name, contents] of Object.entries(this.files)) {
      const target = join(staged.rawDirectory, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    return staged;
  }
}

const CATALOG = JSON.stringify({ name: 'Acme', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }] });

function gitRegistry(overrides: Partial<PluginMarketplaceRegistry> = {}): PluginMarketplaceRegistry {
  return { id: 'acme', source: 'https://github.com/acme/registry', displayName: 'Acme', addedAt: 0, ...overrides };
}

describe('PluginRegistrySource.refreshForInstall', () => {
  it('refreshes the named marketplace — the positive control the whole row exists for', async () => {
    const staging = new CountingStagingService({ 'marketplace.json': CATALOG });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([gitRegistry()]),
      staging,
      baseTempDir: tempDir,
      now: () => 1_000_000,
      env: {},
    });

    const result = await source.refreshForInstall({ marketplaceId: 'acme' });

    expect(result).toEqual({ marketplaceId: 'acme', upgraded: true });
    expect(staging.stageCalls).toBe(1);
    await source.awaitPendingFetches();
  });

  it('skips a marketplace refreshed inside the page\'s 30-second window, without fetching', async () => {
    const staging = new CountingStagingService({ 'marketplace.json': CATALOG });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([gitRegistry({ lastUpgradedAt: 1_000_000 - 29_999 })]),
      staging,
      baseTempDir: tempDir,
      now: () => 1_000_000,
      env: {},
    });

    expect(await source.refreshForInstall({ marketplaceId: 'acme' }))
      .toEqual({ marketplaceId: 'acme', upgraded: false, reason: 'recently-refreshed' });
    // The point of the window: two installs in a row cost one clone, not two.
    expect(staging.stageCalls).toBe(0);
  });

  it('refreshes once the window has passed — the boundary, so the skip is a window and not an off switch', async () => {
    const staging = new CountingStagingService({ 'marketplace.json': CATALOG });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([gitRegistry({ lastUpgradedAt: 1_000_000 - 30_000 })]),
      staging,
      baseTempDir: tempDir,
      now: () => 1_000_000,
      env: {},
    });

    expect((await source.refreshForInstall({ marketplaceId: 'acme' })).upgraded).toBe(true);
    expect(staging.stageCalls).toBe(1);
    await source.awaitPendingFetches();
  });

  it('skips when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set at all', async () => {
    const staging = new CountingStagingService({ 'marketplace.json': CATALOG });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([gitRegistry()]),
      staging,
      baseTempDir: tempDir,
      now: () => 1_000_000,
      // Set-at-all, the reading every other consumer of this name takes.
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' },
    });

    expect(await source.refreshForInstall({ marketplaceId: 'acme' }))
      .toEqual({ marketplaceId: 'acme', upgraded: false, reason: 'nonessential-traffic-disabled' });
    expect(staging.stageCalls).toBe(0);
  });

  it('is a typed no-op for a local-folder marketplace, which was never fetched from a Git host', async () => {
    const staging = new CountingStagingService();
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ id: 'local', source: tempDir, displayName: 'Local', addedAt: 0 }]),
      staging,
      baseTempDir: tempDir,
      env: {},
    });

    expect((await source.refreshForInstall({ marketplaceId: 'local' })).reason).toBe('not-git');
    expect(staging.stageCalls).toBe(0);
  });

  it('reports a failed refresh instead of throwing, so the install falls back to the cached catalog', async () => {
    const staging = new CountingStagingService({ 'marketplace.json': CATALOG });
    staging.fail = true;
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([gitRegistry()]),
      staging,
      baseTempDir: tempDir,
      now: () => 1_000_000,
      env: {},
    });

    const result = await source.refreshForInstall({ marketplaceId: 'acme' });

    expect(result.upgraded).toBe(false);
    expect(result.reason).toBe('fetch-failed');
    await source.awaitPendingFetches();
  });

  it('refuses a managed-blocked marketplace by throwing — the one skip condition that also refuses the install', async () => {
    const staging = new CountingStagingService({ 'marketplace.json': CATALOG });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([gitRegistry()]),
      staging,
      baseTempDir: tempDir,
      blockedMarketplaces: [{ source: 'github', repo: 'acme/registry' }],
      env: {},
    });

    await expect(source.refreshForInstall({ marketplaceId: 'acme' })).rejects.toThrow();
    expect(staging.stageCalls).toBe(0);
  });
});
