import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  DEFAULT_REGISTRY_CATALOG_FORMAT,
  registryCatalogItems,
  registryScannedCatalogItems,
} from '../registry-catalog-items.ts';

const FIXTURES_ROOT = join(import.meta.dir, '../../plugins/__tests__/fixtures/catalog-adapters');
const CODEX_CATALOG_ROOT = join(FIXTURES_ROOT, 'codex');
const CODEX_MARKETPLACE_PATH = join(CODEX_CATALOG_ROOT, '.agents/plugins/marketplace.json');

describe('registryCatalogItems (R2)', () => {
  it('maps parsed proposals to registry-tagged plugin catalog items carrying the typed source', async () => {
    const catalog = JSON.parse(await Bun.file(CODEX_MARKETPLACE_PATH).text()) as unknown;

    const { items, diagnostics } = registryCatalogItems({
      marketplaceRegistryId: 'reg-1',
      displayName: 'My Registry',
      catalog,
      catalogRoot: CODEX_CATALOG_ROOT,
    });

    expect(diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.kind).toBe('plugin');
    expect(item?.listKind).toBe('plugins');
    expect(item?.name).toBe('sample-plugin');
    expect(item?.id).toBe('reg-1:sample-plugin');
    expect(item?.marketplaceRegistryId).toBe('reg-1');
    expect(item?.marketplaceRegistryLabel).toBe('My Registry');
    // The proposal's typed, path-free install source is carried straight through.
    expect(item?.structuredInstallSource).toEqual({
      kind: 'local-path',
      path: join(CODEX_CATALOG_ROOT, 'local-plugins/sample-plugin'),
    });
  });

  it('defaults the parser format to codex when a registry declares none', async () => {
    const catalog = JSON.parse(await Bun.file(CODEX_MARKETPLACE_PATH).text()) as unknown;
    expect(DEFAULT_REGISTRY_CATALOG_FORMAT).toBe('codex');

    const { items } = registryCatalogItems({
      marketplaceRegistryId: 'reg-1',
      catalog,
      catalogRoot: CODEX_CATALOG_ROOT,
    });

    expect(items).toHaveLength(1);
    // No display label injected → the label field is omitted.
    expect(items[0]).not.toHaveProperty('marketplaceRegistryLabel');
  });

  it('maps the current openai/plugins catalog entry to a durable pinned repository subdirectory', () => {
    const { items, diagnostics } = registryCatalogItems({
      marketplaceRegistryId: 'openai-curated',
      displayName: 'Codex official',
      catalog: {
        name: 'openai-curated',
        plugins: [{
          name: 'openai-developers',
          source: { source: 'local', path: './plugins/openai-developers' },
          policy: { authentication: 'ON_INSTALL' },
        }],
      },
      catalogRoot: '/staged/openai-plugins',
      registrySource: {
        kind: 'repository',
        repositoryUrl: 'https://github.com/openai/plugins',
        ref: '11c74d6ba24d3a6d48f54a194cd00ef3beea18f9',
      },
    });

    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(items[0]?.structuredInstallSource).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/openai/plugins',
      ref: '11c74d6ba24d3a6d48f54a194cd00ef3beea18f9',
      subdirectory: 'plugins/openai-developers',
    });
    expect(items[0]?.connectorAuthTiming).toBe('ON_INSTALL');
    expect(items[0]?.catalogAuthenticationPolicy).toBe('ON_INSTALL');
  });

  it('maps a root-level Honey catalog plugin to the durable repository root', () => {
    const registrySource = {
      kind: 'repository' as const,
      repositoryUrl: 'https://github.com/Green-PT/honey-for-devs',
      ref: '6335dfe214f407515a62cb957a3645d4a2a76300',
    };
    const { items, diagnostics } = registryCatalogItems({
      marketplaceRegistryId: 'greenpt',
      catalog: {
        name: 'greenpt',
        plugins: [{ name: 'honey', source: { source: 'local', path: './' } }],
      },
      catalogRoot: '/staged/honey',
      registrySource,
    });

    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(items[0]?.structuredInstallSource).toEqual(registrySource);
  });

  it('maps directory-of-plugins scan results straight to items carrying the durable typed source', () => {
    const items = registryScannedCatalogItems({
      marketplaceRegistryId: 'reg-1',
      displayName: 'openai/plugins',
      scannedPlugins: [
        {
          name: 'asana',
          description: 'Asana',
          version: '1.2.3',
          format: 'codex',
          source: { kind: 'repository', repositoryUrl: 'https://github.com/openai/plugins', ref: 'main', subdirectory: 'plugins/asana' },
        },
      ],
    });

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.id).toBe('reg-1:asana');
    expect(item?.kind).toBe('plugin');
    expect(item?.listKind).toBe('plugins');
    expect(item?.name).toBe('asana');
    expect(item?.description).toBe('Asana');
    expect(item?.version).toBe('1.2.3');
    expect(item?.marketplaceRegistryLabel).toBe('openai/plugins');
    expect(item?.structuredInstallSource).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/openai/plugins',
      ref: 'main',
      subdirectory: 'plugins/asana',
    });
  });

  it('surfaces parser diagnostics and drops the offending entry (path-traversal)', () => {
    const catalog = {
      name: 'traversal-catalog',
      plugins: [{ id: 'evil', name: 'evil', source: { type: 'local', path: '../../../etc/passwd' } }],
    };

    const { items, diagnostics } = registryCatalogItems({
      marketplaceRegistryId: 'reg-1',
      catalog,
      catalogRoot: CODEX_CATALOG_ROOT,
    });

    expect(items).toEqual([]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'marketplace.catalog.path_traversal' }),
    ]);
  });
});

describe('registryCatalogItems — the catalog `renames` map reaches the row (C3)', () => {
  /** Build a claude-format catalog whose plugins all resolve to one local fixture. */
  function catalogWith(
    pluginNames: readonly string[],
    renames?: Record<string, string | null>,
  ): unknown {
    return {
      name: 'claude-plugins-community',
      ...(renames ? { renames } : {}),
      plugins: pluginNames.map(name => ({ name, source: './local-plugins/sample-plugin' })),
    };
  }

  function formerIdsByName(
    pluginNames: readonly string[],
    renames?: Record<string, string | null>,
  ): Record<string, string[] | undefined> {
    const { items, diagnostics } = registryCatalogItems({
      marketplaceRegistryId: 'community',
      format: 'claude',
      catalog: catalogWith(pluginNames, renames),
      catalogRoot: CODEX_CATALOG_ROOT,
    });
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    return Object.fromEntries(items.map(item => [item.name, item.formerIds]));
  }

  const cases: {
    label: string;
    plugins: string[];
    renames?: Record<string, string | null>;
    expected: Record<string, string[] | undefined>;
  }[] = [
    {
      // The live `anthropics/claude-plugins-community` catalog (1 585 046 bytes,
      // 2307 plugins, fetched 2026-07-31) ships exactly four renames, one of
      // them a `null`.
      label: 'stamps the former listing id on the row the rename now points at',
      plugins: ['qodo', 'build-with-wordpress', 'auth0', 'twilio-developer-kit'],
      renames: {
        'qodo-skills': 'qodo',
        'wordpress-com': 'build-with-wordpress',
        'auth0-sdks': 'auth0',
        twilio: 'twilio-developer-kit',
      },
      expected: {
        qodo: ['community:qodo-skills'],
        'build-with-wordpress': ['community:wordpress-com'],
        auth0: ['community:auth0-sdks'],
        'twilio-developer-kit': ['community:twilio'],
      },
    },
    {
      // `plugins/host-marketplace.md#migrate-users-with-a-renames-map` — a `null` value means the plugin was
      // REMOVED. There is no surviving row, so nothing carries the name and no
      // installed record can ever be joined through it.
      label: 'never surfaces a `null` rename, which is a removal and not an alias',
      plugins: ['qodo'],
      renames: { 'qodo-skills': 'qodo', 'legacy-linter': null },
      expected: { qodo: ['community:qodo-skills'] },
    },
    {
      // `:899` — the parser already walks the chain, so both hops land on the
      // terminal row rather than on an intermediate that no longer exists.
      label: 'collapses an append-only rename chain onto the surviving row',
      plugins: ['formatter-pro'],
      renames: { formatter: 'code-formatter', 'code-formatter': 'formatter-pro' },
      expected: { 'formatter-pro': ['community:formatter', 'community:code-formatter'] },
    },
    {
      // A name the catalog still LISTS is not former. Carried, it would give two
      // rows the same id to answer to and one installed record would light up
      // both.
      label: 'drops a former name the catalog still lists, so no id is claimed twice',
      plugins: ['legacy', 'modern'],
      renames: { legacy: 'modern' },
      expected: { legacy: undefined, modern: undefined },
    },
    {
      label: 'leaves every row free of the field when the catalog declares no renames',
      plugins: ['qodo'],
      expected: { qodo: undefined },
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      expect(formerIdsByName(testCase.plugins, testCase.renames)).toEqual(testCase.expected);
    });
  }

  it('scopes every former id to the registry the row came from', () => {
    const { items } = registryCatalogItems({
      marketplaceRegistryId: 'registry-b',
      format: 'claude',
      catalog: catalogWith(['qodo'], { 'qodo-skills': 'qodo' }),
      catalogRoot: CODEX_CATALOG_ROOT,
    });

    // Same shape as the row's own id, so registry A's former name can never be
    // mistaken for registry B's row.
    expect(items[0]?.id).toBe('registry-b:qodo');
    expect(items[0]?.formerIds).toEqual(['registry-b:qodo-skills']);
  });
});

describe('registryCatalogItems declared components (D2)', () => {
  const CLANGD_ENTRY = {
    name: 'clangd-lsp',
    source: './plugins/clangd-lsp',
    lspServers: { clangd: { command: 'clangd', args: ['--background-index'] } },
  };

  it('unions what the ENTRY declares with what the entry\'s manifest declares', () => {
    // Both halves are real: `clangd-lsp`'s official entry carries an inline
    // `lspServers` object (and its plugin directory has NO manifest at all —
    // fetched 2026-08-01, 404), while an `openai/plugins` row's declaration
    // lives only in the per-plugin manifest the fetcher scanned.
    const { items } = registryCatalogItems({
      marketplaceRegistryId: 'claude-official',
      format: 'claude',
      catalog: { name: 'claude-plugins-official', plugins: [CLANGD_ENTRY] },
      catalogRoot: CODEX_CATALOG_ROOT,
      manifestComponentKinds: { 'clangd-lsp': ['skill'] },
    });

    expect(items[0]?.capabilities).toEqual(['skill', 'lsp']);
  });

  it('leaves capabilities empty when neither the entry nor a manifest declares one', () => {
    // `figma`'s official entry, verbatim: name/description/category/source/homepage.
    const { items } = registryCatalogItems({
      marketplaceRegistryId: 'claude-official',
      format: 'claude',
      catalog: {
        name: 'claude-plugins-official',
        plugins: [{
          name: 'figma',
          description: 'Figma design platform integration.',
          category: 'design',
          source: { source: 'url', url: 'https://github.com/figma/mcp-server-guide.git', sha: 'ef474d1' },
          homepage: 'https://github.com/figma/mcp-server-guide',
        }],
      },
      catalogRoot: CODEX_CATALOG_ROOT,
    });

    // Empty is "the listing is silent", which the detail surface must render as
    // unknown — never as "ships no components".
    expect(items[0]?.capabilities).toEqual([]);
  });

  it('carries a directory-scan plugin\'s declared kinds onto its row', () => {
    const [item] = registryScannedCatalogItems({
      marketplaceRegistryId: 'reg-1',
      scannedPlugins: [{
        name: 'figma',
        format: 'codex',
        source: { kind: 'repository', repositoryUrl: 'https://github.com/openai/plugins', subdirectory: 'plugins/figma' },
        declaredComponentKinds: ['skill', 'mcp', 'app'],
      }],
    });

    expect(item?.capabilities).toEqual(['skill', 'mcp', 'app']);
  });

  /**
   * `plugin-marketplaces.md` § Zip archives (fetched 2026-08-24): "The `sha256`
   * digest also serves as the plugin's version when neither `plugin.json` nor the
   * marketplace entry declares one." `plugins-reference.md` § Version management
   * item 4: "The SHA-256 digest, for `archive` sources: the `sha256` pin in the
   * marketplace entry … Claude Code shortens it to the first 12 characters."
   */
  it('resolves an archive sha256 pin to the plugin version when the entry declares none, and lets an entry version win', () => {
    const digest = '6bfa50e3d2e00c052b46abe51fff89346ac803e45771f76dcf6df1ab74cca5e1';
    const { items, diagnostics } = registryCatalogItems({
      marketplaceRegistryId: 'reg-1',
      format: 'claude',
      catalog: {
        name: 'claude-marketplace',
        plugins: [
          // No version anywhere → the pin's first 12 hex characters are the version.
          { name: 'digest-versioned', source: { source: 'archive', url: 'https://artifacts.example.com/a.zip', sha256: digest } },
          // An entry version outranks the digest (resolution order item 2 over item 4).
          { name: 'entry-versioned', version: '2.1.0', source: { source: 'archive', url: 'https://artifacts.example.com/b.zip', sha256: digest } },
          // An unpinned archive carries no digest, so no version is invented here.
          { name: 'unpinned', source: { source: 'archive', url: 'https://artifacts.example.com/c.zip' } },
        ],
      },
      catalogRoot: '/staged',
    });

    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const byName = (name: string) => items.find(item => item.name === name);
    expect(byName('digest-versioned')?.version).toBe('6bfa50e3d2e0');
    expect(byName('entry-versioned')?.version).toBe('2.1.0');
    expect(byName('unpinned')?.version).toBeUndefined();
  });
});
