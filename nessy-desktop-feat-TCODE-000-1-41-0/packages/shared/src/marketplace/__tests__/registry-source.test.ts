import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistrySource, type MarketplaceRegistryStore } from '../registry-source.ts';
import { clearManagedHeadersHelperReuse } from '../managed-headers-helper.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type {
  PluginDiagnostic,
  PluginInstallPlan,
  PluginMarketplaceRegistry,
  PluginStagedInstall,
  RegistryStagingService,
} from '../../plugins/index.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'registry-source-test-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** In-memory registry store (a `PluginStore` subset) so tests never touch disk. */
class MemoryRegistryStore implements MarketplaceRegistryStore {
  writes = 0;
  constructor(private registries: PluginMarketplaceRegistry[] = []) {}
  async readMarketplaceRegistries() {
    return { schemaVersion: 1, updatedAt: 0, registries: [...this.registries] };
  }
  async writeMarketplaceRegistries(file: { registries: PluginMarketplaceRegistry[]; schemaVersion: number; updatedAt: number }) {
    this.writes += 1;
    this.registries = [...file.registries];
  }
  snapshot() {
    return this.registries;
  }
  /** Mutate one persisted row — used to move a registry's cache signature. */
  patch(id: string, changes: Partial<PluginMarketplaceRegistry>) {
    this.registries = this.registries.map(registry => (registry.id === id ? { ...registry, ...changes } : registry));
  }
}

function fakePlan(source: string | import('../../plugins/types.ts').PluginInstallSource): PluginInstallPlan {
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

/** FAKE staging — seeds files into the staged rawDirectory; NO real network. */
class FakeStagingService implements RegistryStagingService {
  /** How many times a real stage (clone-equivalent) was performed. */
  stageCalls = 0;
  /** Flip to make every subsequent clone throw — a transient network failure. */
  fail = false;
  /** Every source the fetch planned, credential and all (P6.479 reads these). */
  readonly planned: Array<string | import('../../plugins/types.ts').PluginInstallSource> = [];
  constructor(private readonly seed: { files?: Record<string, string>; stagingDiagnostics?: PluginDiagnostic[] } = {}) {}
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
    this.planned.push(source);
    return fakePlan(source);
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    if (this.fail) throw new Error('git clone failed (transient)');
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    for (const [name, contents] of Object.entries(this.seed.files ?? {})) {
      const target = join(staged.rawDirectory, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    if (this.seed.stagingDiagnostics?.length) staged.diagnostics = [...staged.diagnostics, ...this.seed.stagingDiagnostics];
    return staged;
  }
}

/**
 * FAKE staging whose clone NEVER settles — stands in for a cold/blocked git
 * clone through a slow bank network. `listItems` must not await it; the fetch
 * timeout is what eventually unblocks a caller that does.
 */
class HangingStagingService implements RegistryStagingService {
  stageCalls = 0;
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
    return fakePlan(source);
  }
  async stageInstall(): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    return new Promise<PluginStagedInstall>(() => {});
  }
}

/**
 * FAKE staging whose clone is held open until the test releases it — the shape
 * of the 34.97 s `openai/plugins` refresh that produced the upgrade blind
 * window. `started` resolves the moment the clone begins.
 */
class HeldCloneStagingService implements RegistryStagingService {
  stageCalls = 0;
  private releaseGate: () => void = () => {};
  private markStarted: () => void = () => {};
  private readonly gate = new Promise<void>(resolve => { this.releaseGate = resolve; });
  readonly started = new Promise<void>(resolve => { this.markStarted = resolve; });
  constructor(private readonly files: Record<string, string> = {}) {}
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
    return fakePlan(source);
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    this.markStarted();
    await this.gate;
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    for (const [name, contents] of Object.entries(this.files)) {
      const target = join(staged.rawDirectory, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    return staged;
  }
  release(): void {
    this.releaseGate();
  }
}

describe('PluginRegistrySource.listItems', () => {
  it('fetches + parses each registry into tagged browse items (after the background fetch settles)', async () => {
    const catalog = { name: 'Acme', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }] };
    const store = new MemoryRegistryStore([
      { id: 'registry-1', source: 'https://github.com/acme/registry', displayName: 'Acme', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } }),
      baseTempDir: tempDir,
    });

    // First read never blocks: it kicks the fetch and rides out as pending.
    const pending = await source.listItems();
    expect(pending.items).toEqual([]);
    expect(pending.loadErrors?.[0]?.diagnosticCodes).toEqual(['marketplace.registry.fetch_pending']);

    await source.awaitPendingFetches();
    const result = await source.listItems();
    expect(result.items).toHaveLength(1);
    const [item] = result.items;
    expect(item?.marketplaceRegistryId).toBe('registry-1');
    expect(item?.marketplaceRegistryLabel).toBe('Acme');
    expect(result.loadErrors).toBeUndefined();
    // Stop Condition: no absolute path (catalogRoot / staged temp dir) leaks out.
    expect(JSON.stringify(result)).not.toMatch(new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('maps a directory-of-plugins registry (no root manifest) into browse items with typed sources', async () => {
    const store = new MemoryRegistryStore([
      { id: 'registry-dir', source: 'https://github.com/openai/plugins', refName: 'main', displayName: 'openai/plugins', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService({
        files: {
          'plugins/asana/.codex-plugin/plugin.json': JSON.stringify({ name: 'asana', description: 'Asana', version: '1.0.0' }),
          'plugins/notion/.claude-plugin/plugin.json': JSON.stringify({ name: 'notion' }),
        },
      }),
      baseTempDir: tempDir,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();
    expect(result.loadErrors).toBeUndefined();
    expect(result.items.map(i => i.name).sort()).toEqual(['asana', 'notion']);
    const asana = result.items.find(i => i.name === 'asana');
    expect(asana?.marketplaceRegistryId).toBe('registry-dir');
    expect(asana?.marketplaceRegistryLabel).toBe('openai/plugins');
    expect(asana?.structuredInstallSource).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/openai/plugins',
      ref: 'main',
      subdirectory: 'plugins/asana',
    });
    // Stop Condition: no staged temp path leaks into the projected items.
    expect(JSON.stringify(result)).not.toMatch(new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('collects a per-registry load error when the catalog is missing', async () => {
    const store = new MemoryRegistryStore([
      { id: 'registry-broken', source: 'https://github.com/acme/broken', displayName: 'Broken', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService({ files: {} }), baseTempDir: tempDir });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();
    expect(result.items).toEqual([]);
    expect(result.loadErrors).toEqual([{
      marketplaceRegistryId: 'registry-broken',
      displayName: 'Broken',
      diagnosticCodes: ['marketplace.registry.catalog_missing'],
    }]);
  });

  it('never blocks the browse list on a slow clone — returns pending while the fetch runs off the request path', async () => {
    const store = new MemoryRegistryStore([
      { id: 'registry-slow', source: 'https://github.com/openai/plugins', displayName: 'openai/plugins', addedAt: 0 },
    ]);
    const staging = new HangingStagingService();
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    // Resolves promptly even though the clone never settles.
    const result = await source.listItems();
    expect(result.items).toEqual([]);
    expect(result.loadErrors).toEqual([{
      marketplaceRegistryId: 'registry-slow',
      displayName: 'openai/plugins',
      diagnosticCodes: ['marketplace.registry.fetch_pending'],
    }]);
    // The fetch was kicked exactly once and left running in the background.
    expect(staging.stageCalls).toBe(1);
  });

  it('serves the staged catalog from cache on the next read without re-fetching', async () => {
    const catalog = { name: 'Acme', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }] };
    const store = new MemoryRegistryStore([
      { id: 'registry-cache', source: 'https://github.com/acme/registry', displayName: 'Acme', addedAt: 0 },
    ]);
    const staging = new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await source.listItems();
    await source.awaitPendingFetches();
    expect(staging.stageCalls).toBe(1);

    const first = await source.listItems();
    expect(first.items).toHaveLength(1);
    const second = await source.listItems();
    expect(second.items).toHaveLength(1);
    // Cache hits — no further clone.
    expect(staging.stageCalls).toBe(1);
  });

  it('surfaces a path-free timeout load error when a clone exceeds the fetch timeout', async () => {
    const store = new MemoryRegistryStore([
      { id: 'registry-timeout', source: 'https://github.com/openai/plugins', displayName: 'openai/plugins', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({
      store,
      staging: new HangingStagingService(),
      baseTempDir: tempDir,
      fetchTimeoutMs: 20,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();
    expect(result.items).toEqual([]);
    expect(result.loadErrors).toEqual([{
      marketplaceRegistryId: 'registry-timeout',
      displayName: 'openai/plugins',
      diagnosticCodes: ['marketplace.registry.fetch_timeout'],
    }]);
  });
});

describe('PluginRegistrySource.findCatalogItem', () => {
  it('resolves a cached item by id (with its durable install source) and never re-stages', async () => {
    const store = new MemoryRegistryStore([
      { id: 'registry-dir', source: 'https://github.com/openai/plugins', refName: 'main', displayName: 'openai/plugins', addedAt: 0 },
    ]);
    const staging = new FakeStagingService({
      files: { 'plugins/asana/.codex-plugin/plugin.json': JSON.stringify({ name: 'asana', version: '1.0.0' }) },
    });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    // Populate the cache exactly as a browse read would.
    await source.listItems();
    await source.awaitPendingFetches();
    expect(staging.stageCalls).toBe(1);

    const item = await source.findCatalogItem('registry-dir', 'registry-dir:asana');
    expect(item?.name).toBe('asana');
    expect(item?.structuredInstallSource).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/openai/plugins',
      ref: 'main',
      subdirectory: 'plugins/asana',
    });

    // Unknown item id and unknown registry both resolve to undefined — and a
    // lookup NEVER kicks a clone.
    expect(await source.findCatalogItem('registry-dir', 'registry-dir:missing')).toBeUndefined();
    expect(await source.findCatalogItem('registry-nope', 'registry-nope:asana')).toBeUndefined();
    expect(staging.stageCalls).toBe(1);
  });

  it('hydrates the lookup from the on-disk catalog cache on a fresh instance WITHOUT re-staging', async () => {
    const catalogCacheDir = join(tempDir, 'find-catalogs');
    const staging1 = new FakeStagingService({ files: SCAN_SEED });
    const first = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]), staging: staging1, baseTempDir: tempDir, catalogCacheDir,
    });
    await first.listItems();
    await first.awaitPendingFetches();
    expect(staging1.stageCalls).toBe(1);

    // Fresh instance (simulates a restart): the lookup reads the persisted
    // catalog straight from disk — no clone.
    const staging2 = new FakeStagingService({ files: SCAN_SEED });
    const second = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]), staging: staging2, baseTempDir: tempDir, catalogCacheDir,
    });
    const item = await second.findCatalogItem('registry-cache', 'registry-cache:asana');
    expect(item?.name).toBe('asana');
    expect(staging2.stageCalls).toBe(0);
  });
});

describe('PluginRegistrySource mutations', () => {
  it('adds a registry, dedupes on the raw source, and never returns a path', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), now: () => 42 });

    const added = await source.add({ source: 'openai/plugins', refName: 'v1', sparsePaths: ['plugins/codex'] });
    expect(added.alreadyAdded).toBe(false);
    // Now that the shorthand classifies as a hosted repository, its label is the
    // `<owner>/<repo>` every other spelling of this same repo already produced
    // (see the table below) — it used to fall back to the last segment alone.
    expect(added.displayName).toBe('openai/plugins');
    expect(added.marketplaceId).toMatch(/^registry-/);
    // Path-free: no `installedRoot`, no raw `source` field, no absolute path.
    // The `/` inside an `<owner>/<repo>` LABEL is not a path and never was —
    // the guard could only spell itself `/\//` while the shorthand happened to
    // degrade to a single segment.
    expect(JSON.stringify(added)).not.toMatch(/installedRoot|"source"/);
    expect(added.displayName).not.toContain(tempDir);
    expect(added.displayName.startsWith('/')).toBe(false);
    const persisted = store.snapshot();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ source: 'openai/plugins', refName: 'v1', sparsePaths: ['plugins/codex'], addedAt: 42 });

    // Re-adding the same source is idempotent (alreadyAdded, no second row).
    const again = await source.add({ source: 'openai/plugins' });
    expect(again.alreadyAdded).toBe(true);
    expect(again.marketplaceId).toBe(added.marketplaceId);
    expect(store.snapshot()).toHaveLength(1);
  });

  it.each([
    ['https://github.com/openai/plugins/tree/main', 'openai/plugins'],
    ['https://github.com/openai/plugins/tree/main/plugins', 'openai/plugins'],
    ['https://github.com/openai/plugins', 'openai/plugins'],
    ['https://github.com/openai/plugins.git', 'openai/plugins'],
    ['git@github.com:openai/plugins.git', 'openai/plugins'],
    // Bare shorthand classifies as a hosted repo too, so it converges on the
    // SAME label as every other spelling above rather than degrading to the
    // last segment.
    ['openai/plugins', 'openai/plugins'],
    ['openai/plugins@v1', 'openai/plugins'],
  ])('derives owner/repo (never the ref/subdir) for %s', async (source, expected) => {
    const store = new MemoryRegistryStore();
    const registry = new PluginRegistrySource({ store, staging: new FakeStagingService(), now: () => 1 });
    const added = await registry.add({ source });
    expect(added.displayName).toBe(expected);
  });

  it('upgrades a git registry and no-ops a local-folder registry', async () => {
    const store = new MemoryRegistryStore([
      { id: 'reg-git', source: 'https://github.com/acme/registry', addedAt: 0 },
      { id: 'reg-local', source: tempDir, addedAt: 0 },
    ]);
    const catalog = { name: 'Acme', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }] };
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } }),
      baseTempDir: tempDir,
      now: () => 99,
    });

    const git = await source.upgrade({ marketplaceId: 'reg-git' });
    expect(git).toEqual({ marketplaceId: 'reg-git', upgraded: true });
    expect(store.snapshot().find(r => r.id === 'reg-git')?.lastUpgradedAt).toBe(99);

    const local = await source.upgrade({ marketplaceId: 'reg-local' });
    expect(local).toEqual({ marketplaceId: 'reg-local', upgraded: false, reason: 'not-git' });

    const missing = await source.upgrade({ marketplaceId: 'nope' });
    expect(missing).toEqual({ marketplaceId: 'nope', upgraded: false, reason: 'not-found' });
  });

  /**
   * The owner-reported defect: three marketplaces added as `owner/repo` — the
   * form Claude's docs use and our own add dialog advertises — never fetched.
   * `isGitRegistry` runs the real `resolvePluginInstallSource`, which classified
   * the shorthand `unsupported`, so `upgrade()` refused it as `not-git` before
   * any clone was attempted.
   */
  it('upgrades a registry added as a bare owner/repo shorthand', async () => {
    const store = new MemoryRegistryStore([
      { id: 'reg-short', source: 'anthropics/claude-code', addedAt: 0 },
    ]);
    const catalog = { name: 'Claude Code', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }] };
    const staging = new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir, now: () => 42 });

    const result = await source.upgrade({ marketplaceId: 'reg-short' });
    expect(result).toEqual({ marketplaceId: 'reg-short', upgraded: true });
    // It really cloned — the pre-fix path returned `not-git` with stageCalls 0.
    expect(staging.stageCalls).toBe(1);
    expect(store.snapshot().find(r => r.id === 'reg-short')?.lastUpgradedAt).toBe(42);

    const items = await source.listItems();
    expect(items.items.map(item => item.name)).toEqual(['toolkit']);
    expect(items.loadErrors).toBeUndefined();
  });

  /**
   * The silent half of the same defect: the registry that never loaded said so
   * nowhere. An aggregate "Some marketplaces could not be loaded." banner was
   * the only signal, and `main.log` carried nothing for `registry`/`clone`/`fetch`.
   */
  it('names the reason in the log when a fetch fails and when an upgrade does not happen', async () => {
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const store = new MemoryRegistryStore([
        { id: 'reg-broken', source: 'https://github.com/acme/registry', displayName: 'Acme', addedAt: 0 },
        { id: 'reg-local', source: tempDir, displayName: 'A folder', addedAt: 0 },
      ]);
      const staging = new FakeStagingService();
      staging.fail = true;
      const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir, now: () => 7 });

      const failed = await source.upgrade({ marketplaceId: 'reg-broken' });
      expect(failed.upgraded).toBe(false);
      // The log names the marketplace AND the reason — both halves, because the
      // id alone is what the user-facing surface used to show.
      expect(warnings.some(line => line.includes('Acme') && line.includes('reason=fetch-failed'))).toBe(true);

      const notGit = await source.upgrade({ marketplaceId: 'reg-local' });
      expect(notGit.reason).toBe('not-git');
      expect(warnings.some(line => line.includes('A folder') && line.includes('reason=not-git'))).toBe(true);

      // The catalog-fetch failure is logged with its diagnostic codes too.
      expect(warnings.some(line => line.includes('catalog fetch failed') && line.includes('Acme'))).toBe(true);
    } finally {
      console.warn = realWarn;
    }
  });

  it('removes a registry by id', async () => {
    const store = new MemoryRegistryStore([{ id: 'reg-1', source: 'openai/plugins', addedAt: 0 }]);
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService() });

    const removed = await source.remove({ marketplaceId: 'reg-1' });
    expect(removed).toEqual({ marketplaceId: 'reg-1', removed: true });
    expect(store.snapshot()).toEqual([]);

    const noop = await source.remove({ marketplaceId: 'reg-1' });
    expect(noop).toEqual({ marketplaceId: 'reg-1', removed: false });
  });

  it('removing a marketplace leaves its installed plugins installed (L103)', async () => {
    // `plugin-marketplaces.md` § Remove a marketplace — removing the marketplace
    // drops the SOURCE, never the plugins already installed from it. The
    // guarantee was readable from `remove()`'s body and asserted nowhere; P6.431
    // pins it, so a future `remove()` that reaches into the installed tree goes
    // red instead of quietly uninstalling.
    const catalogCacheDir = join(tempDir, 'catalog-cache');
    const installedRoot = join(tempDir, 'installed');
    mkdirSync(catalogCacheDir, { recursive: true });
    mkdirSync(join(installedRoot, 'formatter'), { recursive: true });
    writeFileSync(join(installedRoot, 'formatter', 'plugin.json'), '{"name":"formatter"}\n');
    writeFileSync(join(catalogCacheDir, 'reg-1.json'), '{"schemaVersion":1}\n');
    writeFileSync(join(catalogCacheDir, 'reg-2.json'), '{"schemaVersion":1}\n');

    const store = new MemoryRegistryStore([
      { id: 'reg-1', source: 'openai/plugins', addedAt: 0 },
      { id: 'reg-2', source: 'acme/plugins', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), catalogCacheDir });

    expect(await source.remove({ marketplaceId: 'reg-1' })).toEqual({ marketplaceId: 'reg-1', removed: true });
    // The registry row and ONLY its own catalog cache file are gone.
    expect(store.snapshot().map(registry => registry.id)).toEqual(['reg-2']);
    // `removeDiskEntry` is fire-and-forget (`void`) and its `rm()` settles on the
    // fs threadpool, so the single `Bun.sleep(0)` tick that stood here was a
    // VACUOUS wait — the same shape the known-failing register diagnoses for
    // `pi-runtime-cwd-transaction`. Measured at the 1.38.0 close-out
    // (2026-09-13, load ~8): 4 pass / 1 fail over five runs of this file ALONE,
    // the one failure reading `reg-1.json` still present. Wait for the very
    // observable the assertion consumes, bounded well inside the 5 s case
    // budget: past the deadline the assertion still runs and still fails with
    // its diff, so a `remove()` that stops deleting the cache file is still
    // caught rather than reported as a timeout.
    const cacheRemovalDeadline = Date.now() + 2000;
    while (Date.now() < cacheRemovalDeadline && readdirSync(catalogCacheDir).includes('reg-1.json')) {
      await Bun.sleep(5);
    }
    expect(readdirSync(catalogCacheDir).sort()).toEqual(['reg-2.json']);
    // The installed plugin is untouched — the assertion this row exists for.
    expect(readdirSync(installedRoot)).toEqual(['formatter']);
    expect(readFileSync(join(installedRoot, 'formatter', 'plugin.json'), 'utf-8')).toContain('formatter');
  });

  it('lists path-free registry rows', async () => {
    const store = new MemoryRegistryStore([
      { id: 'reg-1', source: '/Users/me/local/registry', displayName: 'Local', refName: 'main', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService() });

    const result = await source.list();
    // `autoUpdate` is the RESOLVED answer: nothing managed, nothing toggled, and
    // a local folder is not the official Anthropic marketplace →
    // `settings-reference.md#extraknownmarketplaces`'s third-party default.
    expect(result.registries).toEqual([
      { marketplaceId: 'reg-1', displayName: 'Local', refName: 'main', autoUpdate: false, autoUpdateManaged: false },
    ]);
    // The absolute `source` path is NEVER in the summary.
    expect(JSON.stringify(result)).not.toMatch(/\/Users/);
  });
});

/** A directory-of-plugins catalog seed → durable, path-free repository sources. */
const SCAN_SEED = { 'plugins/asana/.codex-plugin/plugin.json': JSON.stringify({ name: 'asana', version: '1.0.0' }) };
const GIT_REGISTRY: PluginMarketplaceRegistry = {
  id: 'registry-cache', source: 'https://github.com/openai/plugins', refName: 'main', displayName: 'openai/plugins', addedAt: 0,
};

describe('PluginRegistrySource on-disk catalog cache', () => {
  it('persists a resolved catalog and serves it on a fresh instance WITHOUT re-staging', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs');

    const staging1 = new FakeStagingService({ files: SCAN_SEED });
    const first = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]), staging: staging1, baseTempDir: tempDir, catalogCacheDir,
    });
    await first.listItems();
    await first.awaitPendingFetches();
    expect((await first.listItems()).items.map(i => i.name)).toEqual(['asana']);
    expect(staging1.stageCalls).toBe(1);

    // Fresh instance (simulates a restart): SAME cache dir + registry row, a NEW
    // staging that would count any clone. The catalog is served from disk.
    const staging2 = new FakeStagingService({ files: SCAN_SEED });
    const second = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]), staging: staging2, baseTempDir: tempDir, catalogCacheDir,
    });
    const served = await second.listItems();
    expect(served.items.map(i => i.name)).toEqual(['asana']);
    expect(served.loadErrors).toBeUndefined();
    expect(staging2.stageCalls).toBe(0);
  });

  it('invalidates the disk cache when lastUpgradedAt changes (signature mismatch → re-fetch)', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-inv');

    const first = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]),
      staging: new FakeStagingService({ files: SCAN_SEED }), baseTempDir: tempDir, catalogCacheDir,
    });
    await first.listItems();
    await first.awaitPendingFetches();
    expect((await first.listItems()).items).toHaveLength(1);

    // Fresh instance whose registry row carries a NEWER lastUpgradedAt → the
    // disk cache's signature no longer matches → it is ignored and re-fetched.
    const staging2 = new FakeStagingService({ files: SCAN_SEED });
    const second = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY, lastUpgradedAt: 123 }]),
      staging: staging2, baseTempDir: tempDir, catalogCacheDir,
    });
    const pending = await second.listItems();
    expect(pending.loadErrors?.[0]?.diagnosticCodes).toEqual(['marketplace.registry.fetch_pending']);
    await second.awaitPendingFetches();
    expect(staging2.stageCalls).toBe(1);
  });

  it('writes a PATH-FREE cache file (no staged clone path; durable install source)', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-pf');
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]),
      staging: new FakeStagingService({ files: SCAN_SEED }), baseTempDir: tempDir, catalogCacheDir,
    });
    await source.listItems();
    await source.awaitPendingFetches();

    const files = readdirSync(catalogCacheDir);
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(catalogCacheDir, files[0]!), 'utf-8');
    // The staged clone path (under baseTempDir) must NEVER appear in the cache.
    expect(raw).not.toMatch(new RegExp(tempDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const parsed = JSON.parse(raw) as { schemaVersion: number; items: { structuredInstallSource: unknown }[] };
    // Bumped to 2 by C3 (rows gained `formerIds`); a v1 file is refused rather
    // than served rename-blind. Asserted literally on purpose — a schema change
    // that does not invalidate the old files should fail here first.
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.items[0]?.structuredInstallSource).toEqual({
      kind: 'repository', repositoryUrl: 'https://github.com/openai/plugins', ref: 'main', subdirectory: 'plugins/asana',
    });
  });
});

/**
 * FAKE staging that HOLDS every clone at a shared gate until released, recording
 * how many run concurrently — so a test can prove the global concurrency cap.
 */
class GatedStagingService implements RegistryStagingService {
  stageCalls = 0;
  concurrent = 0;
  maxConcurrent = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  openGate(): void { this.release(); }
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
    return fakePlan(source);
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    await this.gate;
    this.concurrent -= 1;
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    for (const [name, contents] of Object.entries(SCAN_SEED)) {
      const target = join(staged.rawDirectory, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    return staged;
  }
}

describe('PluginRegistrySource.upgrade — no blind window while the clone runs', () => {
  it('keeps the catalog resolvable for the whole clone and stamps lastUpgradedAt only after fresh bytes land', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-upgrade');
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);

    // Warm and healthy: resolved in memory AND persisted to disk.
    const warm = new PluginRegistrySource({
      store, staging: new FakeStagingService({ files: SCAN_SEED }), baseTempDir: tempDir, catalogCacheDir,
    });
    await warm.listItems();
    await warm.awaitPendingFetches();
    expect((await warm.listItems()).items).toHaveLength(1);

    // A fresh instance hydrates that catalog from disk without cloning, then
    // the user clicks Upgrade and the clone is held open.
    const gated = new HeldCloneStagingService(SCAN_SEED);
    const source = new PluginRegistrySource({
      store, staging: gated, baseTempDir: tempDir, catalogCacheDir, now: () => 777,
    });
    const before = await source.listItems();
    expect(before.items).toHaveLength(1);
    expect(gated.stageCalls).toBe(0);
    const itemId = before.items[0]?.id as string;
    expect(await source.findCatalogItem(GIT_REGISTRY.id, itemId)).toBeDefined();

    const upgrading = source.upgrade({ marketplaceId: GIT_REGISTRY.id });
    await gated.started;

    // ── the window the 34.97 s reproduction lived in ──────────────────────
    expect(await source.findCatalogItem(GIT_REGISTRY.id, itemId)).toBeDefined();
    const browsing = await source.listItems();
    expect(browsing.items).toHaveLength(1);
    expect(browsing.loadErrors).toBeUndefined();
    // The row is untouched until the fetch lands, so the signature never moves
    // ahead of the catalog it keys.
    expect(store.snapshot()[0]?.lastUpgradedAt).toBeUndefined();

    gated.release();
    expect(await upgrading).toEqual({ marketplaceId: GIT_REGISTRY.id, upgraded: true });
    expect(store.snapshot()[0]?.lastUpgradedAt).toBe(777);
    expect(await source.findCatalogItem(GIT_REGISTRY.id, itemId)).toBeDefined();
    expect((await source.listItems()).items).toHaveLength(1);
  });

  it('leaves the row unstamped when the re-clone fails, so the served catalog stays the one install resolves against', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-upgrade-fail');
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);

    const warm = new PluginRegistrySource({
      store, staging: new FakeStagingService({ files: SCAN_SEED }), baseTempDir: tempDir, catalogCacheDir,
    });
    await warm.listItems();
    await warm.awaitPendingFetches();
    const itemId = (await warm.listItems()).items[0]?.id as string;

    const failing = new FakeStagingService({ files: SCAN_SEED });
    failing.fail = true;
    const source = new PluginRegistrySource({ store, staging: failing, baseTempDir: tempDir, catalogCacheDir, now: () => 777 });
    expect((await source.listItems()).items).toHaveLength(1);
    // The clone threw, so the click is reported as the failure it was.
    expect(await source.upgrade({ marketplaceId: GIT_REGISTRY.id })).toEqual({
      marketplaceId: GIT_REGISTRY.id,
      upgraded: false,
      reason: 'fetch-failed',
      diagnosticCodes: ['marketplace.registry.fetch_failed'],
    });

    expect(failing.stageCalls).toBe(1);
    expect(store.snapshot()[0]?.lastUpgradedAt).toBeUndefined();
    expect(await source.findCatalogItem(GIT_REGISTRY.id, itemId)).toBeDefined();
    expect((await source.listItems()).items).toHaveLength(1);
  });
});

describe('PluginRegistrySource.upgrade — the result says what actually happened', () => {
  it('reports a timed-out re-clone as fetch-timeout, not as a successful upgrade', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const source = new PluginRegistrySource({
      store, staging: new HangingStagingService(), baseTempDir: tempDir, fetchTimeoutMs: 20, now: () => 777,
    });

    expect(await source.upgrade({ marketplaceId: GIT_REGISTRY.id })).toEqual({
      marketplaceId: GIT_REGISTRY.id,
      upgraded: false,
      reason: 'fetch-timeout',
      diagnosticCodes: ['marketplace.registry.fetch_timeout'],
    });
    expect(store.snapshot()[0]?.lastUpgradedAt).toBeUndefined();
  });

  /**
   * P2.159 — a refresh that did not land must not leave the retained catalog
   * looking CURRENT.
   *
   * Measured on the official Anthropic marketplace: `upgradeRegistry` answered
   * `fetch-timeout` on both attempts, so its catalog stayed frozen three weeks
   * back (`claude-security` still listed at `0.10.0` against an upstream
   * `0.10.2.3`) — and `listItems()` served those rows with NO `loadErrors` entry,
   * because the failure branch returned without touching the cache. Auto-update
   * was on for that marketplace, so nothing anywhere said a word.
   */
  it('stamps a failed refresh onto the retained catalog so the staleness is visible', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-upgrade-stale');
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);

    const warm = new PluginRegistrySource({
      store, staging: new FakeStagingService({ files: SCAN_SEED }), baseTempDir: tempDir, catalogCacheDir,
    });
    await warm.listItems();
    await warm.awaitPendingFetches();
    // The control: a HEALTHY catalog reports no load error at all, so the
    // assertion below is measuring the failure and not a permanently-set field.
    const healthy = await warm.listItems();
    expect(healthy.items).toHaveLength(1);
    expect(healthy.loadErrors).toBeUndefined();

    // A THROWING clone rather than a hanging one plus a small timeout: the
    // mechanism under test is `!entry.persistable`, which both outcomes reach,
    // and a 20 ms timeout knob is below this suite's resting state under full
    // load — it manufactured its own failure once in two runs. Which of the two
    // `reason` values a failure maps to has its own dedicated cases below.
    const failing = new FakeStagingService({ files: SCAN_SEED });
    failing.fail = true;
    const source = new PluginRegistrySource({
      store, staging: failing, baseTempDir: tempDir, catalogCacheDir, now: () => 777,
    });
    expect((await source.listItems()).items).toHaveLength(1);
    expect(await source.upgrade({ marketplaceId: GIT_REGISTRY.id })).toEqual({
      marketplaceId: GIT_REGISTRY.id,
      upgraded: false,
      reason: 'fetch-failed',
      diagnosticCodes: ['marketplace.registry.fetch_failed'],
    });

    const stale = await source.listItems();
    // The catalog is STILL SERVED — an install must keep resolving against the
    // rows it resolved against a moment ago — but it now says it is stale.
    expect(stale.items).toHaveLength(1);
    expect(stale.loadErrors?.map(error => ({
      marketplaceRegistryId: error.marketplaceRegistryId,
      diagnosticCodes: error.diagnosticCodes,
    }))).toEqual([{
      marketplaceRegistryId: GIT_REGISTRY.id,
      diagnosticCodes: ['marketplace.registry.fetch_failed'],
    }]);
    // Never persisted: the on-disk catalog is the only surviving copy of the
    // rows, and a failure must not be cached as though it were a resolution.
    expect(store.snapshot()[0]?.lastUpgradedAt).toBeUndefined();
  });

  it('reports the failed refreshes out of the unattended pass, not just the landed ones', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY, autoUpdate: true }]);
    const failing = new FakeStagingService({ files: SCAN_SEED });
    failing.fail = true;
    const source = new PluginRegistrySource({ store, staging: failing, baseTempDir: tempDir, now: () => 777 });

    // `refreshed` empty was the ONLY thing the caller looked at, and it returned
    // early on it — so a marketplace that failed every attempt produced no line
    // naming it anywhere. (A throwing clone, not a hung one: see the case above
    // for why a millisecond timeout is the wrong knob in this suite.)
    expect(await source.refreshAutoUpdateMarketplaces()).toEqual({
      considered: [GIT_REGISTRY.id],
      refreshed: [],
      failed: [{ marketplaceId: GIT_REGISTRY.id, reason: 'fetch-failed' }],
    });
  });

  it('reports a clone that produced no catalog manifest with the code that says so', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const source = new PluginRegistrySource({
      store, staging: new FakeStagingService({ files: {} }), baseTempDir: tempDir, now: () => 777,
    });

    // `reason` folds every non-timeout outcome into `fetch-failed`; the codes
    // are what keep "the clone died" apart from "the repo has no manifest".
    expect(await source.upgrade({ marketplaceId: GIT_REGISTRY.id })).toEqual({
      marketplaceId: GIT_REGISTRY.id,
      upgraded: false,
      reason: 'fetch-failed',
      diagnosticCodes: ['marketplace.registry.catalog_missing'],
    });
  });
});

describe('PluginRegistrySource — a failed fetch is not cached as if it were a catalog', () => {
  it('keeps serving the last resolved catalog with a load-error note, retries on later reads within a budget, and recovers after a restart', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-failed');
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const staging = new FakeStagingService({ files: SCAN_SEED });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir, catalogCacheDir });

    await source.listItems();
    await source.awaitPendingFetches();
    const itemId = (await source.listItems()).items[0]?.id as string;
    expect(itemId).toBeDefined();

    // The registry moves (a new ref lands) and the re-fetch fails transiently.
    staging.fail = true;
    store.patch(GIT_REGISTRY.id, { lastUpgradedAt: 500 });
    await source.listItems();
    await source.awaitPendingFetches();

    // The failure is recorded, NOT cached as an empty catalog.
    const afterFailure = await source.listItems();
    expect(afterFailure.items).toHaveLength(1);
    expect(afterFailure.loadErrors?.[0]?.diagnosticCodes).toEqual(['marketplace.registry.fetch_failed']);
    expect(await source.findCatalogItem(GIT_REGISTRY.id, itemId)).toBeDefined();

    // ...and browse keeps trying rather than freezing for the process lifetime.
    // The read above already spent one re-attempt; the budget bounds the rest,
    // so six more reads clone three times in total, not six.
    await source.awaitPendingFetches();
    for (let read = 0; read < 6; read += 1) {
      await source.listItems();
      await source.awaitPendingFetches();
    }
    // 1 good clone + 1 failed re-fetch + 3 bounded retries.
    expect(staging.stageCalls).toBe(5);

    // A restart recovers: the clone works again and the catalog is re-resolved.
    const restarted = new PluginRegistrySource({
      store, staging: new FakeStagingService({ files: SCAN_SEED }), baseTempDir: tempDir, catalogCacheDir,
    });
    await restarted.listItems();
    await restarted.awaitPendingFetches();
    const recovered = await restarted.listItems();
    expect(recovered.items).toHaveLength(1);
    expect(recovered.loadErrors).toBeUndefined();
    // The catalog written before the failure was never deleted — after a failed
    // refresh it is the only surviving copy.
    expect(readdirSync(catalogCacheDir)).toHaveLength(1);
  });

  it('does not invent items when there was never a resolved catalog, and still retries', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const staging = new FakeStagingService({ files: SCAN_SEED });
    staging.fail = true;
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await source.listItems();
    await source.awaitPendingFetches();
    const first = await source.listItems();
    expect(first.items).toEqual([]);
    expect(first.loadErrors?.[0]?.diagnosticCodes).toEqual(['marketplace.registry.fetch_failed']);
    expect(await source.findCatalogItem(GIT_REGISTRY.id, 'registry-cache:asana')).toBeUndefined();

    // The retry that heals it: the clone recovers and the catalog appears with
    // no signature change and no user action.
    await source.awaitPendingFetches();
    staging.fail = false;
    await source.listItems();
    await source.awaitPendingFetches();
    const healed = await source.listItems();
    expect(healed.items).toHaveLength(1);
    expect(healed.loadErrors).toBeUndefined();
  });
});

describe('PluginRegistrySource fetch concurrency', () => {
  it('caps concurrent registry clones globally (default 2)', async () => {
    const registries: PluginMarketplaceRegistry[] = Array.from({ length: 5 }, (_unused, i) => ({
      id: `registry-${i}`, source: `https://github.com/openai/plugins-${i}`, refName: 'main', addedAt: 0,
    }));
    const staging = new GatedStagingService();
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore(registries), staging, baseTempDir: tempDir, maxConcurrentFetches: 2,
    });

    // One list read kicks all five fetches; only the cap may clone at once.
    await source.listItems();
    staging.openGate();
    await source.awaitPendingFetches();

    expect(staging.stageCalls).toBe(5);
    expect(staging.maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe('PluginRegistrySource under a managed marketplace allowlist', () => {
  // `plugins/org.md#how-entries-match` — "Restrictions are checked before any network
  // or filesystem operation. The check runs on marketplace add and on plugin
  // install, update, refresh, and auto-update."
  const internalOnly = [{ source: 'hostPattern' as const, hostPattern: '^gitlab\\.tcsbank\\.ru$' }];

  it('refuses `add` before reading the store or staging anything', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({
      store, staging, baseTempDir: tempDir, strictKnownMarketplaces: internalOnly,
    });

    await expect(source.add({ source: 'https://github.com/acme/registry' }))
      .rejects.toThrow(/managed settings/);
    // Proof the refusal is BEFORE any work: nothing was staged, and the registry
    // file was never written.
    expect(staging.stageCalls).toBe(0);
    expect(store.writes).toBe(0);
    expect(store.snapshot()).toEqual([]);
  });

  it('admits a source the allowlist matches', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store, staging: new FakeStagingService(), baseTempDir: tempDir, strictKnownMarketplaces: internalOnly,
    });

    const added = await source.add({ source: 'https://gitlab.tcsbank.ru/team/plugins.git' });
    expect(added.alreadyAdded).toBe(false);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('refuses to refresh a registry added before the policy, without cloning it', async () => {
    // `:762` — "If a marketplace was added before the policy was configured and
    // its source no longer matches the allowlist, Claude Code refuses to install
    // or update plugins from it."
    const staging = new FakeStagingService({
      files: { 'marketplace.json': JSON.stringify({ name: 'Acme', plugins: [] }) },
    });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([
        { id: 'registry-legacy', source: 'https://github.com/acme/registry', addedAt: 0 },
      ]),
      staging,
      baseTempDir: tempDir,
      strictKnownMarketplaces: internalOnly,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(staging.stageCalls).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.loadErrors?.[0]?.diagnosticCodes).toEqual(['marketplace.registry.source_not_allowed']);
  });

  it('refuses `upgrade` before stamping the registry or re-cloning', async () => {
    const store = new MemoryRegistryStore([
      { id: 'registry-legacy', source: 'https://github.com/acme/registry', addedAt: 0 },
    ]);
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({
      store, staging, baseTempDir: tempDir, strictKnownMarketplaces: internalOnly,
    });

    await expect(source.upgrade({ marketplaceId: 'registry-legacy' }))
      .rejects.toThrow(/managed settings/);
    expect(store.writes).toBe(0);
    expect(staging.stageCalls).toBe(0);
  });

  it('imposes nothing when the policy sets no allowlist', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });

    await source.add({ source: 'https://github.com/acme/registry' });
    expect(store.snapshot()).toHaveLength(1);
  });
});

/**
 * D13 — the delivery half of the marketplace policy pair.
 *
 * `settings-reference.md#extraknownmarketplaces` — "Register additional plugin
 * marketplaces by name, so that people who open the repository, or everyone your
 * managed settings reach, get the marketplace without adding it themselves."
 * (The repository-convenience wording this used to quote is on no page of
 * Claude's documentation index any more — checked 2026-09-10 over the 191-page
 * snapshot in `scripts/claude-doc-pages.tsv`, with the sentence above as the
 * positive control on the same rig. The key and its purpose are unchanged.)
 *
 * Every source below is a local fixture directory or an in-repo string: nothing
 * here fetches, installs or executes a plugin from a network marketplace.
 */
describe('delivered marketplaces (extraKnownMarketplaces)', () => {
  const internalOnly = [{ source: 'hostPattern' as const, hostPattern: '^gitlab\\.tcsbank\\.ru$' }];
  const corp = {
    name: 'corp-plugins',
    source: 'https://gitlab.tcsbank.ru/corp/plugins.git',
  };

  it('registers a delivered marketplace without any manual add', async () => {
    const catalog = { name: 'Corp', plugins: [{ name: 'corp-toolkit', source: 'https://gitlab.tcsbank.ru/corp/toolkit' }] };
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } }),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [corp],
    });

    // The mandated plugin resolves off the ordinary read path — nobody added
    // anything on this workstation.
    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(store.snapshot()).toHaveLength(1);
    expect(result.items.map(item => item.name)).toEqual(['corp-toolkit']);
    // The policy's own name is the label, not one derived from the URL.
    expect((await source.list()).registries[0]?.displayName).toBe('corp-plugins');
  });

  it('is idempotent across every read path and across repeated reads', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store, staging: new FakeStagingService(), baseTempDir: tempDir, extraKnownMarketplaces: [corp],
    });

    await source.list();
    await source.listItems();
    await source.findCatalogItem('missing', 'missing');
    await source.ensureDeliveredMarketplaces();

    expect(store.snapshot()).toHaveLength(1);
    expect(store.writes).toBe(1);
  });

  it('reports each entry once, and reports the second run as already present', async () => {
    const store = new MemoryRegistryStore();
    const first = new PluginRegistrySource({
      store, staging: new FakeStagingService(), baseTempDir: tempDir, extraKnownMarketplaces: [corp],
    });
    expect(await first.ensureDeliveredMarketplaces()).toEqual([
      { name: 'corp-plugins', state: 'registered', marketplaceId: expect.any(String) },
    ]);

    // A restart re-reads the same policy against a store that already has the row.
    const second = new PluginRegistrySource({
      store, staging: new FakeStagingService(), baseTempDir: tempDir, extraKnownMarketplaces: [corp],
    });
    expect((await second.ensureDeliveredMarketplaces())[0]?.state).toBe('already-present');
    expect(store.snapshot()).toHaveLength(1);
  });

  /**
   * The containment property. A delivered marketplace is a code-distribution
   * channel, so it takes the SAME gate an added one takes and never a weaker
   * one: `plugins/org.md#how-entries-match` puts the allowlist check "before any
   * network or filesystem operation", and a delivery may not widen it.
   */
  it('is refused by the administrator\'s own source allowlist, before any staging', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({
      store,
      staging,
      baseTempDir: tempDir,
      strictKnownMarketplaces: internalOnly,
      extraKnownMarketplaces: [{ name: 'outside', source: 'https://github.com/acme/registry' }],
    });

    expect(await source.ensureDeliveredMarketplaces()).toEqual([
      { name: 'outside', state: 'refused-by-allowlist' },
    ]);
    expect(store.snapshot()).toEqual([]);
    expect(store.writes).toBe(0);
    expect(staging.stageCalls).toBe(0);
  });

  it('delivers the entries the allowlist admits even when a sibling entry is refused', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      strictKnownMarketplaces: internalOnly,
      extraKnownMarketplaces: [{ name: 'outside', source: 'https://github.com/acme/registry' }, corp],
    });

    expect((await source.ensureDeliveredMarketplaces()).map(outcome => outcome.state))
      .toEqual(['refused-by-allowlist', 'registered']);
    expect(store.snapshot().map(registry => registry.source)).toEqual([corp.source]);
  });

  it('does nothing at all when the policy delivers nothing', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });

    expect(await source.ensureDeliveredMarketplaces()).toEqual([]);
    await source.list();
    expect(store.writes).toBe(0);
  });
});

describe('PluginRegistrySource — a catalog rename survives every cache layer (C3)', () => {
  /**
   * A renamed row is only useful to the installed-vs-catalog join if it is still
   * there on a CACHE HIT. Browse serves the in-memory cache on every read after
   * the first, and the on-disk cache on every read after a restart — so a fetch-
   * only assertion would pass while the shipped path never carried the field.
   */
  const RENAMED_CATALOG = {
    name: 'claude-plugins-community',
    renames: { 'qodo-skills': 'qodo', 'legacy-linter': null },
    plugins: [{ name: 'qodo', source: 'https://github.com/qodo-ai/qodo' }],
  };
  const RENAMED_SEED = { 'marketplace.json': JSON.stringify(RENAMED_CATALOG) };
  const RENAMED_REGISTRY: PluginMarketplaceRegistry = {
    id: 'registry-renames', source: 'https://github.com/anthropics/claude-plugins-community', displayName: 'Community', addedAt: 0,
  };

  it('carries the former listing id through the in-memory cache, the disk cache, and findCatalogItem', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-renames');
    const staging = new FakeStagingService({ files: RENAMED_SEED });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...RENAMED_REGISTRY }]), staging, baseTempDir: tempDir, catalogCacheDir,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const fresh = await source.listItems();
    expect(staging.stageCalls).toBe(1);
    expect(fresh.items[0]?.id).toBe('registry-renames:qodo');
    expect(fresh.items[0]?.formerIds).toEqual(['registry-renames:qodo-skills']);

    // Second read = in-memory cache hit (no further clone).
    const cached = await source.listItems();
    expect(staging.stageCalls).toBe(1);
    expect(cached.items[0]?.formerIds).toEqual(['registry-renames:qodo-skills']);

    // Fresh instance = restart. Served off disk, still WITHOUT a clone.
    const staging2 = new FakeStagingService({ files: RENAMED_SEED });
    const restarted = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...RENAMED_REGISTRY }]), staging: staging2, baseTempDir: tempDir, catalogCacheDir,
    });
    const served = await restarted.listItems();
    expect(staging2.stageCalls).toBe(0);
    expect(served.items[0]?.formerIds).toEqual(['registry-renames:qodo-skills']);

    // The install lookup reads the same cached rows.
    const found = await restarted.findCatalogItem('registry-renames', 'registry-renames:qodo');
    expect(found?.formerIds).toEqual(['registry-renames:qodo-skills']);

    // The `null` rename is a REMOVAL: it reaches no row, in any layer.
    expect(JSON.stringify(served.items)).not.toContain('legacy-linter');
  });

  it('ignores a catalog cache written before rows carried former ids', async () => {
    const catalogCacheDir = join(tempDir, 'catalogs-stale-schema');
    const staging = new FakeStagingService({ files: RENAMED_SEED });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...RENAMED_REGISTRY }]), staging, baseTempDir: tempDir, catalogCacheDir,
    });
    await source.listItems();
    await source.awaitPendingFetches();

    // Rewrite the persisted entry as the PREVIOUS schema version, with the
    // rename-blind rows that version wrote. A signature match would otherwise
    // serve them forever: the signature only moves on an upgrade.
    const [cacheFile] = readdirSync(catalogCacheDir);
    const path = join(catalogCacheDir, cacheFile!);
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as {
      schemaVersion: number; items: { formerIds?: string[] }[];
    };
    expect(persisted.schemaVersion).toBe(2);
    writeFileSync(path, JSON.stringify({
      ...persisted,
      schemaVersion: 1,
      items: persisted.items.map(({ formerIds: _dropped, ...item }) => item),
    }));

    const staging2 = new FakeStagingService({ files: RENAMED_SEED });
    const restarted = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...RENAMED_REGISTRY }]), staging: staging2, baseTempDir: tempDir, catalogCacheDir,
    });
    // The stale file is refused, so the read is pending and re-fetches...
    expect((await restarted.listItems()).loadErrors?.[0]?.diagnosticCodes)
      .toEqual(['marketplace.registry.fetch_pending']);
    await restarted.awaitPendingFetches();
    expect(staging2.stageCalls).toBe(1);
    expect((await restarted.listItems()).items[0]?.formerIds).toEqual(['registry-renames:qodo-skills']);
  });
});

/**
 * R63 — per-marketplace auto-update.
 *
 * `settings-reference.md#extraknownmarketplaces` — "**Type**: object mapping a
 * marketplace name to an object with a `source` object and an optional
 * `autoUpdate` Boolean", and "When omitted, `claude-plugins-official` and most
 * other official Anthropic marketplaces default to `true`, and third-party
 * marketplaces default to `false`."
 * `plugins/loading.md#which-marketplaces-and-plugins-auto-update` says the same as a polarity.
 */
describe('marketplace auto-update (settings-reference.md#extraknownmarketplaces)', () => {
  const catalogFile = { 'marketplace.json': JSON.stringify({ name: 'Acme', plugins: [] }) };
  const gitRow = (id: string, extra: Partial<PluginMarketplaceRegistry> = {}): PluginMarketplaceRegistry => ({
    id,
    source: `https://github.com/acme/${id}`,
    displayName: id,
    addedAt: 0,
    ...extra,
  });

  it('takes the third-party default of false, and the official-Anthropic default of true', async () => {
    const store = new MemoryRegistryStore([
      gitRow('third-party'),
      // The one source the documented `true` default applies to. Nessy registers
      // no such marketplace in practice; the polarity is still implemented, so
      // this is the branch that proves it exists.
      { id: 'official', source: 'anthropics/claude-plugins-official', displayName: 'claude-plugins-official', addedAt: 0 },
    ]);
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });

    const rows = (await source.list()).registries;
    expect(rows.map(row => [row.marketplaceId, row.autoUpdate])).toEqual([
      ['third-party', false],
      ['official', true],
    ]);
    expect(rows.every(row => row.autoUpdateManaged === false)).toBe(true);
  });

  it('lets the user toggle it, and refreshes ONLY the flagged marketplace', async () => {
    const store = new MemoryRegistryStore([gitRow('flagged'), gitRow('unflagged')]);
    const staging = new FakeStagingService({ files: catalogFile });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await source.setAutoUpdate({ marketplaceId: 'flagged', autoUpdate: true });
    expect(store.snapshot().find(row => row.id === 'flagged')?.autoUpdate).toBe(true);
    expect(store.snapshot().find(row => row.id === 'unflagged')?.autoUpdate).toBeUndefined();

    const result = await source.refreshAutoUpdateMarketplaces();
    expect(result.considered).toEqual(['flagged']);
    expect(result.refreshed).toEqual(['flagged']);
    // The unflagged registry was never staged: exactly one clone happened.
    expect(staging.stageCalls).toBe(1);
    expect(store.snapshot().find(row => row.id === 'unflagged')?.lastUpgradedAt).toBeUndefined();
  });

  it('does nothing at all when no marketplace is flagged', async () => {
    const store = new MemoryRegistryStore([gitRow('a'), gitRow('b')]);
    const staging = new FakeStagingService({ files: catalogFile });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    expect(await source.refreshAutoUpdateMarketplaces()).toEqual({ considered: [], refreshed: [], failed: [] });
    expect(staging.stageCalls).toBe(0);
  });

  /**
   * `plugins/org.md#turn-auto-update-on-or-off-per-marketplace` — an administrator enables it "without requiring
   * each user to toggle it", so the managed value outranks the stored one.
   */
  it('lets a managed extraKnownMarketplaces value outrank the user toggle, and refuses the toggle', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService({ files: catalogFile }),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [{ name: 'corp', source: 'https://github.com/acme/corp', autoUpdate: true }],
    });

    const [row] = (await source.list()).registries;
    expect(row?.autoUpdate).toBe(true);
    expect(row?.autoUpdateManaged).toBe(true);
    await expect(source.setAutoUpdate({ marketplaceId: row!.marketplaceId, autoUpdate: false }))
      .rejects.toThrow(/managed settings/);
    expect((await source.list()).registries[0]?.autoUpdate).toBe(true);
  });

  it('keeps the administrator\'s source allowlist on the unattended path', async () => {
    const store = new MemoryRegistryStore([gitRow('outside', { autoUpdate: true })]);
    const staging = new FakeStagingService({ files: catalogFile });
    const source = new PluginRegistrySource({
      store,
      staging,
      baseTempDir: tempDir,
      strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^gitlab\\.tcsbank\\.ru$' }],
    });

    // Considered (its flag is on) but refused before any clone: a scheduled
    // update must never reach a source an interactive one could not.
    const result = await source.refreshAutoUpdateMarketplaces();
    // `failed` stays empty: an allowlist refusal is a managed-policy decision the
    // browse path already reports as `source_not_allowed`, not a stale catalog.
    expect(result).toEqual({ considered: ['outside'], refreshed: [], failed: [] });
    expect(staging.stageCalls).toBe(0);
  });
});

/**
 * R63 — `pluginSuggestionMarketplaces`, and the anti-squatting rule that is the
 * reason it is not just a name match.
 *
 * `settings-reference.md#pluginsuggestionmarketplaces` — "A name takes effect
 * only when the marketplace is registered on the machine and its registered
 * source is also declared in the same managed settings, either as the
 * `extraKnownMarketplaces` entry for that name or as an entry of
 * `strictKnownMarketplaces`. Claude Code ignores a marketplace registered from a
 * different source under an allowlisted name. The official marketplace is exempt
 * from the source requirement."
 */
describe('suggestion allowlist (settings-reference.md#pluginsuggestionmarketplaces)', () => {
  const corpRow: PluginMarketplaceRegistry = {
    id: 'corp',
    source: 'https://gitlab.tcsbank.ru/corp/plugins.git',
    displayName: 'acme-corp-plugins',
    addedAt: 0,
  };

  it('admits a name whose registered source is the extraKnownMarketplaces entry FOR THAT NAME', async () => {
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([corpRow]),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [{ name: 'acme-corp-plugins', source: corpRow.source }],
      pluginSuggestionMarketplaces: ['acme-corp-plugins'],
    });
    expect(await source.listSuggestionAllowedRegistryIds()).toEqual(['corp']);
  });

  it('admits a name whose registered source matches strictKnownMarketplaces instead', async () => {
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([corpRow]),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^gitlab\\.tcsbank\\.ru$' }],
      pluginSuggestionMarketplaces: ['acme-corp-plugins'],
    });
    expect(await source.listSuggestionAllowedRegistryIds()).toEqual(['corp']);
  });

  /**
   * THE security case. Without the source half, whoever gets a marketplace
   * registered under an allowlisted name has their plugins pinned in front of
   * every engineer in the org by the administrator's own setting.
   */
  it('REFUSES an allowlisted name registered from a different source', async () => {
    const squatter: PluginMarketplaceRegistry = {
      id: 'squatter',
      // Same NAME as the administrator's marketplace, a source they never named.
      source: 'https://github.com/someone-else/plugins',
      displayName: 'acme-corp-plugins',
      addedAt: 0,
    };
    // Both rows are registered under the same allowlisted name, side by side, so
    // the refusal cannot be an artefact of nothing being admitted at all.
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([corpRow, squatter]),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [{ name: 'acme-corp-plugins', source: corpRow.source }],
      pluginSuggestionMarketplaces: ['acme-corp-plugins'],
    });
    expect(await source.listSuggestionAllowedRegistryIds()).toEqual(['corp']);
  });

  it('REFUSES a delivered entry that carries the right source under a different name', async () => {
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([corpRow]),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      // Same source, different name: it declares no source for the allowlisted
      // name, and no strictKnownMarketplaces entry stands in for it either.
      extraKnownMarketplaces: [{ name: 'something-else', source: corpRow.source }],
      pluginSuggestionMarketplaces: ['acme-corp-plugins'],
    });
    expect(await source.listSuggestionAllowedRegistryIds()).toEqual([]);
  });

  it('exempts the official marketplace from the source declaration — but not from BEING official', async () => {
    const official: PluginMarketplaceRegistry = {
      id: 'official',
      source: 'anthropics/claude-plugins-official',
      displayName: 'claude-plugins-official',
      addedAt: 0,
    };
    const impostor: PluginMarketplaceRegistry = {
      id: 'impostor',
      source: 'https://github.com/someone-else/plugins',
      displayName: 'claude-plugins-official',
      addedAt: 0,
    };
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([official, impostor]),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      // No extraKnownMarketplaces, no strictKnownMarketplaces: the name alone.
      pluginSuggestionMarketplaces: ['claude-plugins-official'],
    });
    expect(await source.listSuggestionAllowedRegistryIds()).toEqual(['official']);
  });

  it('surfaces nothing at all when the managed key is absent', async () => {
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([corpRow]),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [{ name: 'acme-corp-plugins', source: corpRow.source }],
    });
    expect(await source.listSuggestionAllowedRegistryIds()).toEqual([]);
  });
});

/**
 * R81 — the reader `buildCapabilityResolutionInputsV2` may call once per turn.
 *
 * Every case here is about what it must NOT do. `listItems()` is the same read
 * on paper and is disqualified three times over: it delivers (writes
 * `marketplaces.json`), it kicks a clone for an uncached registry, and it spends
 * a failed registry's retry budget. Each of those would be paid per turn.
 */
describe('PluginRegistrySource.peekCachedItems — cached-only, side-effect free', () => {
  it('serves an already-resolved catalog and never stages a clone', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const staging = new FakeStagingService({ files: SCAN_SEED });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await source.listItems();
    await source.awaitPendingFetches();
    expect(staging.stageCalls).toBe(1);

    for (let turn = 0; turn < 5; turn += 1) {
      expect((await source.peekCachedItems()).map(entry => entry.name)).toEqual(['asana']);
    }
    // Five "turns" of reads cost zero clones and zero registry writes.
    expect(staging.stageCalls).toBe(1);
    expect(store.writes).toBe(0);
  });

  it('returns nothing for an UNRESOLVED registry instead of fetching one', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const staging = new FakeStagingService({ files: SCAN_SEED });
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    expect(await source.peekCachedItems()).toEqual([]);
    expect(staging.stageCalls).toBe(0);

    // POSITIVE CONTROL — the same cold registry on the same rig DOES clone the
    // moment `listItems` asks, so "no clone" above is the peek's doing and not
    // an inert fixture.
    await source.listItems();
    await source.awaitPendingFetches();
    expect(staging.stageCalls).toBe(1);
  });

  it('hydrates from the on-disk catalog after a restart, still without staging', async () => {
    const catalogCacheDir = join(tempDir, 'peek-catalogs');
    const staging1 = new FakeStagingService({ files: SCAN_SEED });
    const first = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]), staging: staging1, baseTempDir: tempDir, catalogCacheDir,
    });
    await first.listItems();
    await first.awaitPendingFetches();

    // Fresh instance = a restart. This is the case the badge actually lives on:
    // nothing has browsed yet this session, and auto-update never runs for a
    // marketplace with the flag off (`plugins/loading.md#which-marketplaces-and-plugins-auto-update`).
    const staging2 = new FakeStagingService({ files: SCAN_SEED });
    const second = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...GIT_REGISTRY }]), staging: staging2, baseTempDir: tempDir, catalogCacheDir,
    });
    expect((await second.peekCachedItems()).map(entry => entry.name)).toEqual(['asana']);
    expect(staging2.stageCalls).toBe(0);
  });

  it('does NOT deliver managed marketplaces — a per-turn read must not write the registry file', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService({ files: SCAN_SEED });
    const source = new PluginRegistrySource({
      store,
      staging,
      baseTempDir: tempDir,
      extraKnownMarketplaces: [{ name: 'acme-corp-plugins', source: 'https://github.com/acme/plugins' }],
    });

    expect(await source.peekCachedItems()).toEqual([]);
    expect(store.writes).toBe(0);
    expect(store.snapshot()).toEqual([]);

    // POSITIVE CONTROL — delivery is real on this rig; `listItems` performs it.
    await source.listItems();
    expect(store.writes).toBe(1);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('does not spend a failed registry\'s retry budget', async () => {
    const store = new MemoryRegistryStore([{ ...GIT_REGISTRY }]);
    const staging = new FakeStagingService({ files: SCAN_SEED });
    staging.fail = true;
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await source.listItems();
    await source.awaitPendingFetches();
    const afterFirstFailure = staging.stageCalls;
    expect(afterFirstFailure).toBeGreaterThan(0);

    for (let turn = 0; turn < 5; turn += 1) await source.peekCachedItems();
    expect(staging.stageCalls).toBe(afterFirstFailure);

    // POSITIVE CONTROL — the budget is genuinely spendable; a browse read spends it.
    await source.listItems();
    await source.awaitPendingFetches();
    expect(staging.stageCalls).toBeGreaterThan(afterFirstFailure);
  });
});

/**
 * P6.518 (Q-den 51 = B) — the official Anthropic marketplace, delivered PRESENT
 * BUT DISABLED. `plugins/anthropic-marketplaces.md#find-plugins-in-the-official-marketplace`, fetched
 * 2026-09-06: "Claude Code adds the official Anthropic marketplace
 * (`claude-plugins-official`) automatically the first time you start it
 * interactively." We do not; we offer it, from the source that same paragraph
 * names for a manual add — "add it yourself with `/plugin marketplace add
 * anthropics/claude-plugins-official`".
 */
describe('PluginRegistrySource — built-in marketplaces are offered, not added', () => {
  it('lists the offer, fetches nothing, and writes nothing until it is enabled', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    const summary = await source.list();
    expect(summary.available).toEqual([
      {
        name: 'claude-plugins-official',
        source: 'anthropics/claude-plugins-official',
        description: 'The official Anthropic plugin marketplace.',
      },
      {
        name: 'openai-skills',
        source: 'openai/skills',
        description: 'Reusable skills that extend ChatGPT and Codex.',
      },
    ]);
    // "nothing is fetched until the user enables it" — no clone, no store write.
    expect(staging.stageCalls).toBe(0);
    expect(store.writes).toBe(0);
    expect(store.snapshot()).toEqual([]);
  });

  it('enables by NAME with the pinned source, under the reserved-name exemption, and then stops offering it', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });

    const added = await source.enableBuiltInMarketplace({ name: 'claude-plugins-official' });
    // The row carries the page's own name, which is RESERVED — accepted only
    // because the pinned source is the one official source this fork recognises.
    expect(added.displayName).toBe('claude-plugins-official');
    expect(store.snapshot().map(registry => registry.source)).toEqual(['anthropics/claude-plugins-official']);
    // Registered rows are not offered a second time — and only that one goes.
    expect((await source.list()).available.map(offer => offer.name)).toEqual(['openai-skills']);
  });

  /**
   * P6.517 (Q-den 49 = B) — `openai/skills`, the vendor's own catalog of reusable
   * skills. `learn.chatgpt.com/docs/open-source.md`, fetched 2026-09-06:
   * "Skills | openai/skills | Reusable skills that extend ChatGPT and Codex".
   * Nothing runtime-specific is missing: the installer already accepts a git
   * source, so this is one entry and its off state.
   */
  it('offers the vendor skills catalog under a slash-free name and enables it from the pinned slug', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    expect((await source.list()).available.map(offer => offer.source)).toContain('openai/skills');
    expect(staging.stageCalls).toBe(0);

    const added = await source.enableBuiltInMarketplace({ name: 'openai-skills' });
    // A registry row's name is its display name and its reserved-name subject, so
    // it carries no slash; the source keeps the slug.
    expect(added.displayName).toBe('openai-skills');
    expect(store.snapshot().map(registry => registry.source)).toEqual(['openai/skills']);
    expect((await source.list()).available.map(offer => offer.name)).toEqual(['claude-plugins-official']);
    // MEASURED, and worth writing down: enabling REGISTERS and still does not
    // stage. `add()` persists the row and the catalog fetch is lazy, on the first
    // browse — so the "nothing is fetched until you enable it" guarantee is in
    // fact stronger than the page's, and this assertion is the one that would go
    // red if `add()` ever grew an eager clone.
    expect(staging.stageCalls).toBe(0);
  });

  it('refuses an unknown name, and withholds an offer the administrator\'s policy would refuse', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });
    await expect(source.enableBuiltInMarketplace({ name: 'not-a-built-in' })).rejects.toThrow(
      'Unknown built-in marketplace "not-a-built-in".',
    );

    // An offer the allowlist would refuse is never shown: the affordance must not
    // offer a click the managed policy is going to reject.
    const restricted = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      strictKnownMarketplaces: [{ source: 'hostPattern' as const, hostPattern: '^gitlab\\.tcsbank\\.ru$' }],
    });
    expect((await restricted.list()).available).toEqual([]);
    // …and the blocklist does the same, for its own reason.
    const blocked = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      blockedMarketplaces: [{ source: 'github' as const, repo: 'anthropics/claude-plugins-official' }],
    });
    expect((await blocked.list()).available.map(offer => offer.name)).toEqual(['openai-skills']);
  });
});

/**
 * P6.621 — a marketplace that renames ITSELF between two refreshes says so, on
 * both arms: the durable operator channel and the Plugins page.
 *
 * Before this row nothing compared one refresh's declared catalog `name` against
 * the last, and the label a user sees is derived from the SOURCE — so a catalog
 * could rename itself under an operator and leave no trace anywhere.
 */
describe('PluginRegistrySource — a marketplace rename is announced on both arms', () => {
  const catalog = (name: string) => JSON.stringify({
    name,
    plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }],
  });
  const registry: PluginMarketplaceRegistry = {
    id: 'registry-renamed',
    source: 'https://github.com/acme/tools',
    displayName: 'Acme',
    addedAt: 0,
  };

  async function refreshedWithName(nextName: string) {
    const files = { 'marketplace.json': catalog('acme-tools') };
    const staging = new FakeStagingService({ files });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{ ...registry }]),
      staging,
      baseTempDir: tempDir,
      catalogCacheDir: join(tempDir, `catalogs-${nextName}`),
      now: () => Date.now(),
    });
    await source.listItems();
    await source.awaitPendingFetches();
    // A FIRST sighting is not a rename.
    const first = await source.listItems();
    expect(first.loadErrors ?? []).toEqual([]);

    files['marketplace.json'] = catalog(nextName);
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      await source.upgrade({ marketplaceId: registry.id });
      await source.awaitPendingFetches();
    } finally {
      console.warn = realWarn;
    }
    return { source, warnings };
  }

  it('announces it on the durable operator channel, naming both spellings', async () => {
    const { warnings } = await refreshedWithName('acme-platform');
    const renamed = warnings.filter(line => line.includes('marketplace renamed'));
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toContain('"acme-tools" is now "acme-platform"');
  });

  it('announces it in the Plugins page, on the channel that page already renders', async () => {
    const { source } = await refreshedWithName('acme-platform-page');
    const after = await source.listItems();
    expect(after.loadErrors?.map(error => error.diagnosticCodes))
      .toEqual([['marketplace.registry.renamed']]);
    expect(after.loadErrors?.[0]?.displayName).toBe('acme-platform-page');
    // The rows themselves are untouched: a rename is news, not a failure.
    expect(after.items.map(item => item.id)).toEqual(['registry-renamed:toolkit']);
  });

  it('says nothing when the name is unchanged across the same refresh', async () => {
    const { source, warnings } = await refreshedWithName('acme-tools');
    expect(warnings.filter(line => line.includes('marketplace renamed'))).toEqual([]);
    expect((await source.listItems()).loadErrors ?? []).toEqual([]);
  });
});

/**
 * P6.479 — the managed tier's `headersHelper`, wired to the one fetch that
 * needs it.
 *
 * The executor's own gates are pinned in `__tests__/managed-headers-helper.test.ts`.
 * What is asserted here is the WIRING, and it has three claims: the minted
 * headers reach the source the downloader reads, they override the static ones
 * by name, and a failed command means no fetch at all
 * (`plugins/host-marketplace.md#when-claude-code-skips-a-headershelper-command-or-drops-its-output`:
 * "Claude Code doesn't make the fetch or download it ran the command for").
 */
describe('P6.479 · a managed marketplace mints its catalog credential', () => {
  const CATALOG_URL = 'https://registry.example.com/plugins/marketplace.json';
  const CATALOG = JSON.stringify({ name: 'Acme', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }] });

  const managedRow = (): PluginMarketplaceRegistry => ({
    id: 'registry-managed',
    source: CATALOG_URL,
    displayName: 'acme-internal',
    headers: { Authorization: 'Bearer static', 'X-Registry-Scope': 'plugins' },
    addedAt: 0,
  });

  const sourceWith = (staging: FakeStagingService, headersHelper?: string) => new PluginRegistrySource({
    store: new MemoryRegistryStore([managedRow()]),
    staging,
    baseTempDir: tempDir,
    extraKnownMarketplaces: [{
      name: 'acme-internal',
      source: CATALOG_URL,
      headers: { Authorization: 'Bearer static', 'X-Registry-Scope': 'plugins' },
      ...(headersHelper === undefined ? {} : { headersHelper }),
    }],
  });

  /** Header set of the last url source the fetch planned. */
  const plannedHeaders = (staging: FakeStagingService): unknown => {
    const last = staging.planned.at(-1);
    return typeof last === 'string' ? undefined : (last as { headers?: unknown } | undefined)?.headers;
  };

  beforeEach(() => {
    // "Claude Code runs the command … from the configuration directory": the
    // executor's default cwd, which a test rig has to actually have.
    mkdirSync(CONFIG_DIR, { recursive: true });
    clearManagedHeadersHelperReuse();
  });
  afterEach(() => { clearManagedHeadersHelperReuse(); });

  it('sends the command output as the fetch headers, overriding the static ones by name', async () => {
    // "Within one place, a header the command prints overrides a header of the
    // same name listed in `headers`." `X-Registry-Scope` is the control: a
    // static header the command says nothing about still goes out.
    const staging = new FakeStagingService({ files: { 'marketplace.json': CATALOG } });
    const source = sourceWith(staging, 'printf \'{"Authorization":"Bearer minted"}\'');

    await source.listItems();
    await source.awaitPendingFetches();

    expect(plannedHeaders(staging)).toEqual({
      Authorization: 'Bearer minted',
      'X-Registry-Scope': 'plugins',
    });
    expect((await source.listItems()).items.map(item => item.id)).toEqual(['registry-managed:toolkit']);
  });

  it('THE CONTROL: with no headersHelper declared the same row fetches with its static headers', async () => {
    const staging = new FakeStagingService({ files: { 'marketplace.json': CATALOG } });
    const source = sourceWith(staging);

    await source.listItems();
    await source.awaitPendingFetches();

    expect(plannedHeaders(staging)).toEqual({
      Authorization: 'Bearer static',
      'X-Registry-Scope': 'plugins',
    });
  });

  it('makes NO fetch when the command fails, and says so on the channel the page renders', async () => {
    const staging = new FakeStagingService({ files: { 'marketplace.json': CATALOG } });
    const source = sourceWith(staging, 'exit 3');

    await source.listItems();
    await source.awaitPendingFetches();

    expect(staging.stageCalls).toBe(0);
    expect(staging.planned).toEqual([]);
    const after = await source.listItems();
    expect(after.items).toEqual([]);
    expect(after.loadErrors?.map(error => error.diagnosticCodes))
      .toEqual([['marketplace.registry.headers_helper_failed']]);
  });
});
