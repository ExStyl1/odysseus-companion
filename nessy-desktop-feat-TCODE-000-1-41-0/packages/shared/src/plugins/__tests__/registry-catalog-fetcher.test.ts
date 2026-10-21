import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchRegistryCatalog,
  type RegistryStagingService,
} from '../registry-catalog-fetcher.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../source-resolver.ts';
import type { PluginDiagnostic, PluginInstallPlan, PluginStagedInstall } from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'registry-catalog-test-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/**
 * A FAKE staging service — proves the fetcher reuses the injected acquisition
 * seam and adds NO network client of its own. It records the source it was
 * asked to plan, and writes caller-supplied files into the staged rawDirectory
 * to simulate a clone WITHOUT any real network/git.
 */
class FakeStagingService implements RegistryStagingService {
  plannedSource: unknown;
  stageCalls = 0;
  /** Every staged temp root handed out — so a test can assert cleanup. */
  stagedDirectories: string[] = [];

  constructor(
    private readonly seed: {
      files?: Record<string, string>;
      stagingDiagnostics?: PluginDiagnostic[];
    } = {},
  ) {}

  async createInstallPlanFromSource(source: string | import('../types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
    this.plannedSource = source;
    // Reuse the real resolver + staging-plan builder so the plan shape is honest.
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
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    this.stagedDirectories.push(staged.stageDirectory);
    for (const [name, contents] of Object.entries(this.seed.files ?? {})) {
      const target = join(staged.rawDirectory, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    if (this.seed.stagingDiagnostics?.length) {
      staged.diagnostics = [...staged.diagnostics, ...this.seed.stagingDiagnostics];
    }
    return staged;
  }
}

describe('fetchRegistryCatalog', () => {
  it('stages the registry source through the injected service and reads marketplace.json', async () => {
    const catalog = { name: 'Acme', description: 'Acme plugins', plugins: [{ name: 'a', source: './a' }] };
    const service = new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/acme/registry',
      refName: 'v1.2.3',
      sparsePaths: ['plugins'],
      baseTempDir: tempDir,
    });

    expect(service.stageCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.manifestFile).toBe('marketplace.json');
    expect(result.catalog).toEqual(catalog);
    expect(result.catalogRoot).toContain('nessy-plugin-stage-');
  });

  it("reads Claude Code's canonical .claude-plugin/marketplace.json aggregate", async () => {
    const catalog = { name: 'Claude MP', plugins: [{ name: 'b', source: './b' }] };
    const service = new FakeStagingService({
      files: { '.claude-plugin/marketplace.json': JSON.stringify(catalog) },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/acme/claude-marketplace',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.manifestFile).toBe('.claude-plugin/marketplace.json');
    expect(result.catalog).toEqual(catalog);
  });

  it("reads Codex's canonical .agents/plugins/marketplace.json aggregate", async () => {
    const catalog = {
      name: 'openai-curated',
      plugins: [{ name: 'openai-developers', source: { source: 'local', path: './plugins/openai-developers' } }],
    };
    const service = new FakeStagingService({
      files: { '.agents/plugins/marketplace.json': JSON.stringify(catalog) },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.manifestFile).toBe('.agents/plugins/marketplace.json');
    expect(result.catalog).toEqual(catalog);
  });

  it('attaches refName as the fetch ref for a repository source and does NOT thread sparsePaths', async () => {
    const service = new FakeStagingService({ files: { 'marketplace.json': '{"plugins":[]}' } });

    await fetchRegistryCatalog(service, {
      source: 'https://github.com/acme/registry',
      refName: 'release-9',
      sparsePaths: ['only/this'],
      baseTempDir: tempDir,
    });

    // refName is applied as ref; sparsePaths is metadata-only (never on the source).
    expect(service.plannedSource).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/acme/registry',
      ref: 'release-9',
    });
  });

  it('falls back to plugins.json when marketplace.json is absent', async () => {
    const catalog = { plugins: [{ name: 'b', source: 'https://x/y' }] };
    const service = new FakeStagingService({ files: { 'plugins.json': JSON.stringify(catalog) } });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(true);
    expect(result.manifestFile).toBe('plugins.json');
    expect(result.catalog).toEqual(catalog);
  });

  it('prefers marketplace.json over plugins.json when both exist', async () => {
    const service = new FakeStagingService({
      files: {
        'marketplace.json': '{"name":"preferred","plugins":[]}',
        'plugins.json': '{"name":"fallback","plugins":[]}',
      },
    });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.manifestFile).toBe('marketplace.json');
    expect((result.catalog as { name?: string }).name).toBe('preferred');
  });

  it('returns a typed error when no catalog manifest is present at the staged root', async () => {
    const service = new FakeStagingService({ files: { 'README.md': 'no catalog here' } });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(d => d.code === 'marketplace.registry.catalog_missing')).toBe(true);
    // Staged root is still surfaced for diagnostics/cleanup.
    expect(result.catalogRoot).toContain('nessy-plugin-stage-');
  });

  it('surfaces staging (clone/download) errors without attempting a manifest read', async () => {
    const service = new FakeStagingService({
      stagingDiagnostics: [
        { severity: 'error', code: 'plugin.install.repository_fetch_failed', message: 'clone failed' },
      ],
    });

    const result = await fetchRegistryCatalog(service, { source: 'https://github.com/acme/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(result.catalog).toBeUndefined();
    expect(result.diagnostics.some(d => d.code === 'plugin.install.repository_fetch_failed')).toBe(true);
  });

  it('rejects an empty source with a typed diagnostic', async () => {
    const service = new FakeStagingService();

    const result = await fetchRegistryCatalog(service, { source: '   ', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(service.stageCalls).toBe(0);
    expect(result.diagnostics[0]?.code).toBe('marketplace.registry.empty_source');
  });

  it('returns invalid-JSON diagnostic when the catalog manifest is malformed', async () => {
    const service = new FakeStagingService({ files: { 'marketplace.json': '{ not json' } });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(d => d.code === 'marketplace.registry.catalog_invalid_json')).toBe(true);
  });
});

describe('fetchRegistryCatalog staged-clone cleanup', () => {
  it('removes the staged clone after a SUCCESSFUL fetch (no $TMPDIR leak)', async () => {
    const catalog = { name: 'Acme', plugins: [{ name: 'a', source: 'https://github.com/acme/a' }] };
    const service = new FakeStagingService({ files: { 'marketplace.json': JSON.stringify(catalog) } });

    const result = await fetchRegistryCatalog(service, { source: 'https://github.com/acme/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(true);
    expect(service.stagedDirectories).toHaveLength(1);
    expect(existsSync(service.stagedDirectories[0]!)).toBe(false);
  });

  it('removes the staged clone after a PARSE FAILURE (finally on both paths)', async () => {
    const service = new FakeStagingService({ files: { 'marketplace.json': '{ not json' } });

    const result = await fetchRegistryCatalog(service, { source: 'https://github.com/acme/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(service.stagedDirectories).toHaveLength(1);
    expect(existsSync(service.stagedDirectories[0]!)).toBe(false);
  });

  it('removes the staged clone after the directory scan and returns the durable source', async () => {
    const service = new FakeStagingService({ files: { ...codexPlugin('plugins/asana', { name: 'asana' }) } });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      refName: 'main',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.scannedPlugins?.[0]?.source).toMatchObject({ kind: 'repository', subdirectory: 'plugins/asana' });
    expect(existsSync(service.stagedDirectories[0]!)).toBe(false);
  });
});

/** Per-plugin manifest fixture for the directory-of-plugins layout. */
function codexPlugin(dir: string, manifest: Record<string, unknown>): Record<string, string> {
  return { [`${dir}/.codex-plugin/plugin.json`]: JSON.stringify(manifest) };
}
function claudePlugin(dir: string, manifest: Record<string, unknown>): Record<string, string> {
  return { [`${dir}/.claude-plugin/plugin.json`]: JSON.stringify(manifest) };
}

describe('fetchRegistryCatalog directory-of-plugins fallback', () => {
  it('scans root/plugins/* for codex + claude plugin manifests and pins repo-root-relative repository sources', async () => {
    const service = new FakeStagingService({
      files: {
        ...codexPlugin('plugins/asana', { name: 'asana', version: '1.2.3', description: 'Asana integration' }),
        ...codexPlugin('plugins/github', { name: 'github', version: '2.0.0', description: 'GitHub' }),
        ...claudePlugin('plugins/notion', { name: 'notion', version: '0.1.0', description: 'Notion' }),
        // Non-plugin noise at root — must be ignored, not treated as a plugin.
        'README.md': '# registry',
      },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      refName: 'main',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.catalog).toBeUndefined();
    const byName = Object.fromEntries((result.scannedPlugins ?? []).map(p => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['asana', 'github', 'notion']);
    expect(byName.asana).toMatchObject({
      name: 'asana',
      version: '1.2.3',
      description: 'Asana integration',
      format: 'codex',
      source: {
        kind: 'repository',
        repositoryUrl: 'https://github.com/openai/plugins',
        ref: 'main',
        subdirectory: 'plugins/asana',
      },
    });
    expect(byName.notion?.format).toBe('claude');
    expect(byName.notion?.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/openai/plugins',
      ref: 'main',
      subdirectory: 'plugins/notion',
    });
  });

  it('converges the /tree/main/plugins subdir shape onto the SAME repo-root-relative subdirectory', async () => {
    // The subdir-scoped registry stages the `plugins` subdir as catalog root, so
    // the plugin dir sits at root/* — the fetcher must re-join the registry
    // subdirectory so install still points at `plugins/asana` in the repo.
    const service = new FakeStagingService({
      files: { ...codexPlugin('asana', { name: 'asana', version: '1.2.3' }) },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins/tree/main/plugins',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.scannedPlugins?.[0]?.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/openai/plugins',
      ref: 'main',
      subdirectory: 'plugins/asana',
    });
  });

  it('derives a durable local-folder subpath source for a local registry (never the temp staged root)', async () => {
    const localRoot = mkdtempSync(join(tempDir, 'local-registry-'));
    const service = new FakeStagingService({
      files: { ...codexPlugin('plugins/asana', { name: 'asana' }) },
    });

    const result = await fetchRegistryCatalog(service, { source: localRoot, baseTempDir: tempDir });

    expect(result.ok).toBe(true);
    expect(result.scannedPlugins?.[0]?.source).toEqual({
      kind: 'local-path',
      path: join(localRoot, 'plugins/asana'),
    });
  });

  it('fails closed when an archive registry cannot represent a durable plugin subdirectory source', async () => {
    const service = new FakeStagingService({
      files: { ...codexPlugin('plugins/asana', { name: 'asana' }) },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://downloads.example.com/plugins.zip',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(false);
    expect(result.scannedPlugins).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'marketplace.registry.scanned_plugin_source_not_durable',
    }));
    expect(existsSync(service.stagedDirectories[0]!)).toBe(false);
  });

  it('caps the number of scanned directories (bounded scan)', async () => {
    const service = new FakeStagingService({
      files: {
        ...codexPlugin('a', { name: 'a' }),
        ...codexPlugin('b', { name: 'b' }),
        ...codexPlugin('c', { name: 'c' }),
      },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      refName: 'main',
      baseTempDir: tempDir,
      maxScannedDirs: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.scannedPlugins).toHaveLength(2);
  });

  it('skips dotdirs and never scans a plugin whose dir name is unsafe (traversal defense)', async () => {
    const service = new FakeStagingService({
      files: {
        ...codexPlugin('.hidden', { name: 'hidden' }),
        ...codexPlugin('good', { name: 'good' }),
      },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      refName: 'main',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect((result.scannedPlugins ?? []).map(p => p.name)).toEqual(['good']);
    const source = result.scannedPlugins?.[0]?.source as { subdirectory?: string };
    expect(source.subdirectory).toBe('good');
    expect(source.subdirectory).not.toContain('..');
  });

  it('still reports catalog_missing when a manifest-less registry has no plugin directories', async () => {
    const service = new FakeStagingService({ files: { 'README.md': 'nothing here' } });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(result.scannedPlugins).toBeUndefined();
    expect(result.diagnostics.some(d => d.code === 'marketplace.registry.catalog_missing')).toBe(true);
  });

  it('fills a root catalog entry from the plugin manifest it points at (openai/plugins shape)', async () => {
    // The shipped `.agents/plugins/marketplace.json` carries only
    // `category/name/policy/source`; description + version + displayName live in
    // each `plugins/<name>/.codex-plugin/plugin.json`.
    const service = new FakeStagingService({
      files: {
        '.agents/plugins/marketplace.json': JSON.stringify({
          name: 'openai-curated',
          plugins: [
            { name: 'linear', source: { source: 'local', path: './plugins/linear' }, category: 'Productivity' },
          ],
        }),
        ...codexPlugin('plugins/linear', {
          name: 'linear',
          version: '0.0.3',
          description: 'Find and reference issues and projects.',
          interface: { displayName: 'Linear' },
        }),
      },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      baseTempDir: tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.manifestFile).toBe('.agents/plugins/marketplace.json');
    expect((result.catalog as { plugins: Record<string, unknown>[] }).plugins[0]).toEqual({
      name: 'linear',
      source: { source: 'local', path: './plugins/linear' },
      category: 'Productivity',
      description: 'Find and reference issues and projects.',
      version: '0.0.3',
      displayName: 'Linear',
    });
  });

  it('keeps what the entry declares and never enriches a row from an unrelated directory', async () => {
    const service = new FakeStagingService({
      files: {
        'marketplace.json': JSON.stringify({
          plugins: [
            // Declares its own metadata: `:216` makes the entry the primary
            // declaration, so the manifest must not overwrite it.
            { name: 'pinned', source: './plugins/pinned', description: 'Entry copy', version: '9.9.9' },
            // Remote source that happens to share a directory name — no match.
            { name: 'remote', source: { source: 'git', url: 'https://github.com/acme/remote', ref: 'v1' } },
          ],
        }),
        ...codexPlugin('plugins/pinned', {
          name: 'pinned',
          version: '0.0.1',
          description: 'Manifest copy',
        }),
        ...codexPlugin('plugins/remote', { name: 'remote', description: 'Wrong plugin' }),
      },
    });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    const plugins = (result.catalog as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins[0]).toMatchObject({ description: 'Entry copy', version: '9.9.9' });
    expect(plugins[1]).toEqual({
      name: 'remote',
      source: { source: 'git', url: 'https://github.com/acme/remote', ref: 'v1' },
    });
  });

  it('resolves an entry path through metadata.pluginRoot and refuses a traversing one', async () => {
    const service = new FakeStagingService({
      files: {
        'marketplace.json': JSON.stringify({
          metadata: { pluginRoot: './plugins' },
          plugins: [
            { name: 'rooted', source: 'rooted' },
            { name: 'escaping', source: '../plugins/rooted' },
          ],
        }),
        ...codexPlugin('plugins/rooted', { name: 'rooted', description: 'Rooted plugin' }),
      },
    });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    const plugins = (result.catalog as { plugins: Record<string, unknown>[] }).plugins;
    expect(plugins[0]).toMatchObject({ description: 'Rooted plugin' });
    expect(plugins[1]).toEqual({ name: 'escaping', source: '../plugins/rooted' });
  });

  it('does NOT scan when a broken root manifest is present (surfaces the parse error)', async () => {
    const service = new FakeStagingService({
      files: {
        'marketplace.json': '{ not json',
        ...codexPlugin('plugins/asana', { name: 'asana' }),
      },
    });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(false);
    expect(result.scannedPlugins).toBeUndefined();
    expect(result.diagnostics.some(d => d.code === 'marketplace.registry.catalog_invalid_json')).toBe(true);
  });
});

describe('fetchRegistryCatalog component declarations (D2)', () => {
  it('reports what each entry\'s own manifest declares WITHOUT merging it into the entry', async () => {
    // The real `openai/plugins` `figma` manifest declares three component paths.
    // They must reach the row as KINDS and must NOT reach the catalog entry: the
    // entry is a persisted manifest overlay, and a display fact has no business
    // changing what installs.
    const service = new FakeStagingService({
      files: {
        '.agents/plugins/marketplace.json': JSON.stringify({
          name: 'openai-curated',
          plugins: [{ name: 'figma', source: { source: 'local', path: './plugins/figma' } }],
        }),
        ...codexPlugin('plugins/figma', {
          name: 'figma',
          version: '2.0.13',
          skills: './skills/',
          apps: './.app.json',
          mcpServers: './.mcp.json',
        }),
      },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/openai/plugins',
      baseTempDir: tempDir,
    });

    expect(result.manifestComponentKinds).toEqual({ figma: ['skill', 'mcp', 'app'] });
    const entry = (result.catalog as { plugins: Record<string, unknown>[] }).plugins[0]!;
    expect(entry.skills).toBeUndefined();
    expect(entry.mcpServers).toBeUndefined();
    expect(entry.apps).toBeUndefined();
  });

  it('omits the map entirely when no scanned manifest declares a component', async () => {
    const service = new FakeStagingService({
      files: {
        '.agents/plugins/marketplace.json': JSON.stringify({
          name: 'openai-curated',
          plugins: [{ name: 'bare', source: { source: 'local', path: './plugins/bare' } }],
        }),
        ...codexPlugin('plugins/bare', { name: 'bare', version: '1.0.0' }),
      },
    });

    const result = await fetchRegistryCatalog(service, { source: '/local/registry', baseTempDir: tempDir });

    expect(result.ok).toBe(true);
    expect(result.manifestComponentKinds).toBeUndefined();
  });

  it('puts the declared kinds on a directory-scan plugin too', async () => {
    const service = new FakeStagingService({
      files: {
        ...claudePlugin('plugins/hooked', { name: 'hooked', hooks: './hooks/hooks.json' }),
        ...codexPlugin('plugins/bare', { name: 'bare' }),
      },
    });

    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/acme/registry',
      baseTempDir: tempDir,
    });

    const byName = Object.fromEntries((result.scannedPlugins ?? []).map(p => [p.name, p]));
    expect(byName.hooked?.declaredComponentKinds).toEqual(['hook']);
    expect(byName.bare?.declaredComponentKinds).toBeUndefined();
  });
});
