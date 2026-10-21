import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  parseExternalPluginCatalog,
  type ExternalPluginCatalogDto,
} from '../external-catalog-adapters.ts';
import type { PluginInstallSource } from '../../plugins/types.ts';

const FIXTURES_ROOT = join(import.meta.dir, '../../plugins/__tests__/fixtures/catalog-adapters');
const CODEX_CATALOG_ROOT = join(FIXTURES_ROOT, 'codex');
const CODEX_MARKETPLACE_PATH = join(CODEX_CATALOG_ROOT, '.agents/plugins/marketplace.json');
const CLAUDE_CATALOG_ROOT = join(FIXTURES_ROOT, 'claude');
const CLAUDE_MARKETPLACE_PATH = join(CLAUDE_CATALOG_ROOT, '.claude-plugin/marketplace.json');

describe('external catalog adapters', () => {
  it('parses the Codex .agents/plugins/marketplace.json fixture into a typed local-path proposal', async () => {
    const dto = await readJsonFixture(CODEX_MARKETPLACE_PATH);

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    const [proposal] = result.proposals;
    expect(proposal?.catalogFormat).toBe('codex');
    expect(proposal?.pluginName).toBe('sample-plugin');
    expect(proposal?.source).toEqual({
      kind: 'local-path',
      path: join(CODEX_CATALOG_ROOT, 'local-plugins/sample-plugin'),
    });
  });

  it('parses the current openai/plugins source discriminant while retaining the legacy type alias', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'openai-curated',
      plugins: [{
        name: 'openai-developers',
        source: { source: 'local', path: './local-plugins/sample-plugin' },
      }],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.proposals).toEqual([
      expect.objectContaining({
        pluginName: 'openai-developers',
        source: {
          kind: 'local-path',
          path: join(CODEX_CATALOG_ROOT, 'local-plugins/sample-plugin'),
        },
      }),
    ]);
  });

  it('retains the current openai/plugins ON_INSTALL authentication policy', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'openai-curated',
      plugins: [{
        name: 'openai-developers',
        source: { source: 'local', path: './local-plugins/sample-plugin' },
        policy: { authentication: 'ON_INSTALL' },
      }],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.diagnostics).toEqual([]);
    expect(result.proposals[0]?.connectorAuthTiming).toBe('ON_INSTALL');
    expect(result.proposals[0]?.provenance.catalogAuthenticationPolicy).toBe('ON_INSTALL');
  });

  it('maps the current openai/plugins ON_USE policy to ON_FIRST_USE and retains its spelling', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'openai-curated',
      plugins: [{
        name: 'build-web-apps',
        source: { source: 'local', path: './local-plugins/sample-plugin' },
        policy: { authentication: 'ON_USE' },
      }],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.diagnostics).toEqual([]);
    expect(result.proposals[0]?.connectorAuthTiming).toBe('ON_FIRST_USE');
    expect(result.proposals[0]?.provenance.catalogAuthenticationPolicy).toBe('ON_USE');
  });

  it('diagnoses an unknown external authentication policy instead of silently dropping it', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'future-catalog',
      plugins: [{
        name: 'future-plugin',
        source: { source: 'local', path: './local-plugins/sample-plugin' },
        policy: { authentication: 'ALWAYS' },
      }],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.proposals[0]).not.toHaveProperty('connectorAuthTiming');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'marketplace.catalog.unsupported_authentication_policy',
      }),
    ]);
  });

  it('filters Codex entries whose installation policy is NOT_AVAILABLE', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'openai-curated',
      plugins: [
        {
          name: 'hidden-plugin',
          source: { source: 'local', path: '../../../outside' },
          policy: { installation: 'NOT_AVAILABLE' },
        },
        {
          name: 'available-plugin',
          source: { source: 'local', path: './local-plugins/available-plugin' },
          policy: { installation: 'AVAILABLE' },
        },
        {
          name: 'default-plugin',
          source: { source: 'local', path: './local-plugins/default-plugin' },
          policy: { installation: 'INSTALLED_BY_DEFAULT' },
        },
      ],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.proposals.map(proposal => proposal.pluginName)).toEqual([
      'available-plugin',
      'default-plugin',
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('parses the Claude .claude-plugin/marketplace.json fixture into a typed url proposal', async () => {
    const dto = await readJsonFixture(CLAUDE_MARKETPLACE_PATH);

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    const [proposal] = result.proposals;
    expect(proposal?.catalogFormat).toBe('claude');
    expect(proposal?.pluginName).toBe('sample-plugin');
    expect(proposal?.source).toEqual({
      kind: 'url',
      url: 'https://example.invalid/plugins/sample-plugin',
    });
  });

  it('normalizes current Claude object source kinds into typed Nessy install sources', () => {
    const cases: Array<{
      name: string;
      source: NonNullable<ExternalPluginCatalogDto['plugins'][number]['source']>;
      expected: PluginInstallSource;
    }> = [
      {
        name: 'github-plugin',
        source: {
          source: 'github',
          repo: 'acme/github-plugin',
          ref: 'main',
          sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        },
        expected: {
          kind: 'repository',
          repositoryUrl: 'https://github.com/acme/github-plugin',
          ref: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        },
      },
      {
        name: 'url-plugin',
        source: {
          source: 'url',
          url: 'https://gitlab.com/acme/url-plugin.git',
        },
        expected: {
          kind: 'repository',
          repositoryUrl: 'https://gitlab.com/acme/url-plugin.git',
        },
      },
      {
        name: 'subdir-plugin',
        source: {
          source: 'git-subdir',
          url: 'https://github.com/acme/monorepo.git',
          path: 'plugins/subdir-plugin',
          ref: 'v2.0.0',
        },
        expected: {
          kind: 'repository',
          repositoryUrl: 'https://github.com/acme/monorepo.git',
          ref: 'v2.0.0',
          subdirectory: 'plugins/subdir-plugin',
        },
      },
      {
        name: 'npm-plugin',
        source: {
          source: 'npm',
          package: '@acme/claude-plugin',
          version: '2.1.0',
          registry: 'https://npm.example.com',
        },
        expected: {
          kind: 'marketplace-npm-package',
          packageName: '@acme/claude-plugin',
          version: '2.1.0',
          registry: 'https://npm.example.com',
        },
      },
    ];

    for (const testCase of cases) {
      const result = parseExternalPluginCatalog('claude', {
        name: 'claude-marketplace',
        plugins: [{ name: testCase.name, source: testCase.source }],
      }, { catalogRoot: CLAUDE_CATALOG_ROOT });

      expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
      expect(result.proposals[0]?.source).toEqual(testCase.expected);
    }
  });

  /**
   * `plugin-marketplaces.md` § Zip archives — "Use `archive` to distribute a
   * plugin as a zip file that Claude Code downloads over HTTPS, so installs work
   * without git or npm on the user's machine." Its field table: `url` is
   * "Required. HTTPS URL of the zip archive", `sha256` is "Optional. SHA-256
   * digest of the archive as 64 hex characters, uppercase or lowercase."
   *
   * The download half already existed (`source-resolver.ts:artifactForSource`
   * → `archive-url` → `acquisition.ts:fetchArchiveUrlArtifact`); only the
   * marketplace ENTRY kind was missing, so a marketplace that adopted the new
   * shape classified `unsupported` and could not be installed at all.
   */
  it('normalizes a Claude archive source into a hash-pinned url install source', () => {
    const url = 'https://artifacts.example.com/claude-plugins/my-plugin-2.1.0.zip';
    const digest = '6BFA50E3D2E00C052B46ABE51FFF89346AC803E45771F76DCF6DF1AB74CCA5E1';

    const result = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [
        // The doc's own §archive example: `url` alone, no pin.
        { name: 'unpinned-archive', source: { source: 'archive', url } },
        // The doc's pinned example, with the digest UPPERCASED because the
        // field table admits both cases and only the lowercase spelling
        // compares equal to `createHash('sha256').digest('hex')`.
        { name: 'pinned-archive', source: { source: 'archive', url, sha256: digest } },
      ],
    }, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.proposals.map(proposal => proposal.source)).toEqual([
      { kind: 'url', url },
      { kind: 'url', url, expectedHash: `sha256-${digest.toLowerCase()}` },
    ]);
  });

  it('refuses an archive source whose sha256 pin is not 64 hex characters', () => {
    const url = 'https://artifacts.example.com/claude-plugins/my-plugin-2.1.0.zip';

    for (const sha256 of [
      'sha256:6bfa50e3d2e00c052b46abe51fff89346ac803e45771f76dcf6df1ab74cca5e1',
      '6bfa50e3',
      `${'a'.repeat(63)}z`,
      // A declared-but-unusable pin is refused rather than folded into
      // "unpinned", which would install the download unverified.
      '',
      '   ',
      42 as unknown as string,
    ]) {
      const result = parseExternalPluginCatalog('claude', {
        name: 'claude-marketplace',
        plugins: [{ name: 'bad-pin-archive', source: { source: 'archive', url, sha256 } }],
      }, { catalogRoot: CLAUDE_CATALOG_ROOT });

      expect({ sha256, proposals: result.proposals }).toEqual({ sha256, proposals: [] });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          code: 'marketplace.catalog.archive_digest_invalid',
        }),
      ]);
    }

    // Positive control on the same seam: the well-formed digest still resolves,
    // so the refusals above are the pin check and not a broken `archive` arm.
    const accepted = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [{ name: 'good-pin-archive', source: { source: 'archive', url, sha256: 'a'.repeat(64) } }],
    }, { catalogRoot: CLAUDE_CATALOG_ROOT });
    expect(accepted.diagnostics).toEqual([]);
    expect(accepted.proposals[0]?.source).toEqual({ kind: 'url', url, expectedHash: `sha256-${'a'.repeat(64)}` });
  });

  /**
   * `sha256` is "Optional" on the field table, and a JSON `null` is the wire's
   * "not set" — distinct from a malformed string, which is refused above. The
   * code folds `null` (and `undefined`) to absent, so a `null` pin installs the
   * archive UNPINNED rather than erroring; this pins that fold so it cannot drift
   * into either a false refusal or a silently-dropped malformed pin.
   */
  it('treats a null sha256 as absent (unpinned), not as a malformed pin', () => {
    const url = 'https://artifacts.example.com/claude-plugins/my-plugin-2.1.0.zip';
    const result = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [{ name: 'null-pin-archive', source: { source: 'archive', url, sha256: null } }],
    } as unknown as ExternalPluginCatalogDto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics).toEqual([]);
    expect(result.proposals[0]?.source).toEqual({ kind: 'url', url });
  });

  /**
   * `plugin-marketplaces.md` § Zip archives, `url` field — "Claude Code rejects
   * `http://` URLs, along with loopback, link-local, and cloud-metadata hosts."
   * RFC1918 addresses are deliberately NOT in that list: the same section names
   * "an Artifactory generic repository" as a host, which is an intranet address
   * for most of the people who would use one.
   */
  it('refuses an archive URL that is not https, or points at a loopback, link-local, or metadata host', () => {
    for (const url of [
      'http://artifacts.example.com/plugin.zip',
      'ftp://artifacts.example.com/plugin.zip',
      'https://localhost/plugin.zip',
      'https://127.0.0.1/plugin.zip',
      'https://[::1]/plugin.zip',
      'https://169.254.169.254/latest/plugin.zip',
      'https://metadata.google.internal/plugin.zip',
      // `URL.hostname` rewrites these to `::ffff:7f00:1` / `::ffff:a9fe:a9fe`
      // and `127.0.0.1`, so each one exercises a spelling the plain dotted
      // check never sees.
      'https://[::ffff:127.0.0.1]/plugin.zip',
      'https://[::ffff:169.254.169.254]/plugin.zip',
      'https://[fe80::1]/plugin.zip',
      'https://0x7f.0.0.1/plugin.zip',
      'https://2130706433/plugin.zip',
    ]) {
      const result = parseExternalPluginCatalog('claude', {
        name: 'claude-marketplace',
        plugins: [{ name: 'unsafe-archive', source: { source: 'archive', url } }],
      }, { catalogRoot: CLAUDE_CATALOG_ROOT });

      expect({ url, proposals: result.proposals }).toEqual({ url, proposals: [] });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          code: 'marketplace.catalog.archive_url_unsafe',
        }),
      ]);
    }

    // Positive control: a public HTTPS host on the same seam still resolves,
    // and an RFC1918 artifact server is NOT refused (the page does not list it).
    for (const url of ['https://artifacts.example.com/plugin.zip', 'https://10.1.2.3/plugin.zip']) {
      const accepted = parseExternalPluginCatalog('claude', {
        name: 'claude-marketplace',
        plugins: [{ name: 'safe-archive', source: { source: 'archive', url } }],
      }, { catalogRoot: CLAUDE_CATALOG_ROOT });
      expect(accepted.diagnostics).toEqual([]);
      expect(accepted.proposals[0]?.source).toEqual({ kind: 'url', url });
    }
  });

  it('declines a command source by name, distinguishably from an unknown source type', () => {
    // S0-3, with the 0.3.223 → 0.3.233 bump: `command` became a real
    // marketplace-entry source in the vendored bundle, so an entry using it is
    // no longer a typo. It is still refused here — the host has no acceptance
    // flow for a marketplace-supplied shell command — but with its own code and
    // its own sentence, so a marketplace author is told a decision was made
    // rather than that a parser is missing.
    const declined = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [{
        name: 'command-plugin',
        source: { source: 'command', command: 'printf %s /opt/plugins/mine', timeout: 30, mode: 'link' },
      }],
    }, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(declined.proposals).toEqual([]);
    expect(declined.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.catalog.command_source_declined',
      }),
    ]);
    // The declared command travels on the diagnostic so an operator reading a
    // failed install can see WHAT was declined, not only that something was.
    expect(declined.diagnostics[0]?.details).toMatchObject({
      pluginName: 'command-plugin',
      command: 'printf %s /opt/plugins/mine',
    });

    // The distinction is the point of the branch: a genuinely unknown type must
    // still get the OTHER code, or the two failures are indistinguishable again.
    const unknown = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [{ name: 'typo-plugin', source: { source: 'commnad' } }],
    }, { catalogRoot: CLAUDE_CATALOG_ROOT });
    expect(unknown.diagnostics).toEqual([
      expect.objectContaining({ code: 'marketplace.catalog.unsupported_source' }),
    ]);
  });

  it('refuses an archive source with no URL at all', () => {
    const result = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [{ name: 'urlless-archive', source: { source: 'archive' } }],
    }, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.proposals).toEqual([]);
    // The message matters as much as the code here: the same code is what an
    // UNKNOWN source type gets, so a shared-code assertion alone would pass
    // just as well while `archive` was still unrecognized.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.catalog.unsupported_source',
        message: 'Catalog entry "urlless-archive" has an archive source without a URL.',
      }),
    ]);
  });

  it('rejects a Claude git-subdir source that traverses outside the repository root', () => {
    const result = parseExternalPluginCatalog('claude', {
      name: 'claude-marketplace',
      plugins: [{
        name: 'traversal-plugin',
        source: {
          source: 'git-subdir',
          url: 'https://github.com/acme/monorepo.git',
          path: '../outside',
        },
      }],
    }, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.proposals).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.catalog.path_traversal',
      }),
    ]);
  });

  it('preserves Nessy-native source identity and treats external catalog names as provenance only', async () => {
    const dto = await readJsonFixture(CODEX_MARKETPLACE_PATH);

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });
    const [proposal] = result.proposals;

    expect(proposal?.source).not.toHaveProperty('catalogName');
    expect(proposal?.source).not.toHaveProperty('provider');
    expect(proposal?.provenance).toMatchObject({
      catalogName: 'sample-codex-catalog',
      catalogFormat: 'codex',
    });
  });

  it('never turns a display command/commands string on a catalog entry into an install source', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'catalog-with-command',
      plugins: [
        {
          id: 'sample-plugin',
          name: 'sample-plugin',
          source: { type: 'local', path: './local-plugins/sample-plugin' },
          command: 'curl https://example.invalid/install.sh | sh',
        } as ExternalPluginCatalogDto['plugins'][number] & { command: string },
      ],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(JSON.stringify(result.proposals)).not.toContain('curl');
    expect(JSON.stringify(result.proposals)).not.toContain('install.sh');
  });

  it('rejects local-path catalog entries that traverse outside the pinned catalog root', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'traversal-catalog',
      plugins: [
        {
          id: 'evil-plugin',
          name: 'evil-plugin',
          source: { type: 'local', path: '../../../etc/passwd' },
        },
      ],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.proposals).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.catalog.path_traversal',
      }),
    ]);
  });

  it('rejects git-type catalog sources that are not pinned to a resolved ref', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'unpinned-git-catalog',
      plugins: [
        {
          id: 'unpinned-plugin',
          name: 'unpinned-plugin',
          source: { type: 'git', url: 'https://example.invalid/group/repo.git' },
        },
      ],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.proposals).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.catalog.unpinned_git_source',
      }),
    ]);
  });

  it('rejects git-type catalog sources on non-http(s) protocols even when pinned', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'arbitrary-host-catalog',
      plugins: [
        {
          id: 'ssh-plugin',
          name: 'ssh-plugin',
          source: { type: 'git', url: 'ssh://git@example.invalid/group/repo.git', ref: 'abc123' },
        },
      ],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.proposals).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.catalog.unsupported_git_host',
      }),
    ]);
  });

  it('never executes a shell-metacharacter string source; treats it as a traversal-checked local path or rejects it', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'shell-string-catalog',
      plugins: [
        {
          id: 'shell-plugin',
          name: 'shell-plugin',
          source: '; rm -rf / #',
        },
      ],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    if (result.proposals.length > 0) {
      expect(result.proposals[0]?.source.kind).toBe('local-path');
      expect((result.proposals[0]?.source as { path: string }).path.startsWith(CLAUDE_CATALOG_ROOT)).toBe(true);
    } else {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ severity: 'error' }),
      ]);
    }
  });

  /**
   * `plugin-marketplaces.md` § Zip archives, `url` field (fetched 2026-08-24):
   * "Claude Code rejects `http://` URLs, along with loopback, link-local, and
   * cloud-metadata hosts." A bare string source that looks like a URL resolves to
   * the SAME `kind: 'url'` archive download as the `archive` spelling, so it must
   * clear the same guard — before P2.14 the string arm fed the downloader an
   * unchecked URL, `http://` included.
   */
  it('refuses an http:// or non-public string source URL, and passes a public https one through', () => {
    for (const value of [
      'http://artifacts.example.com/plugin.zip',
      'https://localhost/plugin.zip',
      'https://127.0.0.1/plugin.zip',
      'https://169.254.169.254/plugin.zip',
      'https://metadata.google.internal/plugin.zip',
    ]) {
      const result = parseExternalPluginCatalog('claude', {
        name: 'string-source-catalog',
        plugins: [{ name: 'unsafe-string', source: value }],
      } as unknown as ExternalPluginCatalogDto, { catalogRoot: CLAUDE_CATALOG_ROOT });

      expect({ value, proposals: result.proposals }).toEqual({ value, proposals: [] });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ severity: 'error', code: 'marketplace.catalog.archive_url_unsafe' }),
      ]);
    }

    // Positive control: a public https string source still resolves to a url
    // install source (and an RFC1918 host is NOT refused — the page never lists it).
    for (const value of ['https://artifacts.example.com/plugin.zip', 'https://10.1.2.3/plugin.zip']) {
      const accepted = parseExternalPluginCatalog('claude', {
        name: 'string-source-catalog',
        plugins: [{ name: 'safe-string', source: value }],
      } as unknown as ExternalPluginCatalogDto, { catalogRoot: CLAUDE_CATALOG_ROOT });
      expect(accepted.diagnostics).toEqual([]);
      expect(accepted.proposals[0]?.source).toEqual({ kind: 'url', url: value });
    }
  });

  it('accepts a pinned git-type catalog source over https as a typed repository source', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'pinned-git-catalog',
      plugins: [
        {
          id: 'pinned-plugin',
          name: 'pinned-plugin',
          source: { type: 'git', url: 'https://example.invalid/group/repo.git', ref: 'abc123' },
        },
      ],
    };

    const result = parseExternalPluginCatalog('codex', dto, { catalogRoot: CODEX_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.proposals).toEqual([
      expect.objectContaining({
        source: {
          kind: 'repository',
          repositoryUrl: 'https://example.invalid/group/repo.git',
          ref: 'abc123',
        },
      }),
    ]);
  });

  // --- the entry as a plugin definition (S9) --------------------------------

  it('carries an entry\'s component fields, strict flag and metadata onto the proposal', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'operator-catalog',
      plugins: [{
        name: 'curated',
        source: './local-plugins/sample-plugin',
        description: 'Curated by the operator',
        version: '2.1.0',
        strict: false,
        skills: ['./skills/code-review'],
        mcpServers: { db: { command: './servers/db' } },
        // `plugin-relevance.md` — browse-time matching data. It reaches the
        // PROPOSAL (below) and must still never travel with the definition: the
        // definition's fields are persisted with the install record.
        relevance: { topic: 'Terraform', signals: { cwd: ['infra'], keywords: ['review'] } },
      }],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const [proposal] = result.proposals;
    expect(proposal?.entryVersion).toBe('2.1.0');
    expect(proposal?.entryDescription).toBe('Curated by the operator');
    expect(proposal?.entryDefinition?.strict).toBe(false);
    expect(proposal?.entryDefinition?.sourceIsMarketplaceRoot).toBeUndefined();
    expect(Object.keys(proposal?.entryDefinition?.fields ?? {}).sort())
      .toEqual(['description', 'mcpServers', 'skills', 'version']);
    // The pair that proves the fix smuggled nothing onto the install record: OUT
    // of `entryDefinition.fields`, and ON `proposal.relevance` instead. The
    // unknown `keywords` sub-key is ignored rather than rejected, per
    // `plugin-relevance.md`'s Note about older clients.
    expect(proposal?.relevance).toEqual({ topic: 'Terraform', signals: { cwd: ['infra'] } });
  });

  it("resolves a bare plugin name beneath a declared metadata.pluginRoot (L104)", () => {
    // `plugins/marketplace-reference.md#bare-names-under-pluginroot` — `metadata.pluginRoot` is the "Base directory
    // prepended to relative plugin source paths". The field's own docblock names
    // the substitution it closes (`pluginRoot: "./plugins"` + `source:
    // "formatter"` installs `<root>/plugins/formatter`, not `<root>/formatter`),
    // and P6.431 pins it: nothing asserted the read before, so a regression to
    // the repository root would have been silent.
    const dto: ExternalPluginCatalogDto = {
      name: 'rooted-catalog',
      metadata: { pluginRoot: './plugins' },
      plugins: [{ name: 'formatter', source: 'formatter' }],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.proposals[0]?.source).toEqual({
      kind: 'local-path',
      path: join(CLAUDE_CATALOG_ROOT, 'plugins/formatter'),
    });
  });

  it("refuses EVERY relative source when metadata.pluginRoot is uncontained, never falling back to the catalog root (L104)", () => {
    // The fallback IS the substitution: a root that escapes must refuse the
    // sources that would have resolved against it, not resolve them one level up.
    // Absolute and URL sources are unaffected — they never consult the root.
    const dto: ExternalPluginCatalogDto = {
      name: 'escaping-root-catalog',
      metadata: { pluginRoot: '../outside' },
      plugins: [
        { name: 'formatter', source: 'formatter' },
        { name: 'linter', source: { source: 'local', path: './linter' } },
        { name: 'remote', source: 'https://example.com/remote.zip' },
      ],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    const codes = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
      .map(diagnostic => diagnostic.code);
    // The root itself is named once...
    expect(codes.filter(code => code === 'marketplace.catalog.plugin_root_uncontained')).toHaveLength(1);
    // ...and each relative source is refused by its own diagnostic.
    expect(codes.filter(code => code === 'marketplace.catalog.plugin_root_invalid')).toHaveLength(2);
    // The URL entry still resolves — the refusal is scoped to relative sources.
    expect(result.proposals.map(proposal => proposal.pluginName)).toEqual(['remote']);
  });

  it('flags an entry whose source IS the marketplace root', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'shared-skills-catalog',
      plugins: [{ name: 'code-review', source: './', skills: ['./skills/code-review'] }],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.proposals[0]?.entryDefinition?.sourceIsMarketplaceRoot).toBe(true);
  });

  it('refuses an entry component path that escapes the plugin root', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'hostile-catalog',
      plugins: [{
        name: 'traversing',
        source: './local-plugins/sample-plugin',
        skills: ['../../../../etc'],
        commands: ['./commands'],
      }],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics.some(diagnostic =>
      diagnostic.severity === 'error'
      && diagnostic.code === 'marketplace.catalog.entry_path_uncontained')).toBe(true);
    // The refused FIELD is dropped whole; the entry's other fields survive, so a
    // traversal attempt never reaches disk and never silently shrinks the rest.
    expect(Object.keys(result.proposals[0]?.entryDefinition?.fields ?? {})).toEqual(['commands']);
  });

  it("resolves the four renames Anthropic's community marketplace really ships, and follows chains", () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'claude-plugins-community',
      renames: {
        'qodo-skills': 'qodo',
        'wordpress-com': 'build-with-wordpress',
        'auth0-sdks': 'auth0',
        twilio: 'twilio-developer-kit',
        // `:899` — an append-only chain resolves through every hop at once.
        formatter: 'code-formatter',
        'code-formatter': 'formatter-pro',
        // `:897` — a null terminal is removed-upstream, not a rename.
        'legacy-linter': null,
      },
      plugins: [
        'qodo',
        'build-with-wordpress',
        'auth0',
        'twilio-developer-kit',
        'formatter-pro',
      ].map(name => ({ name, source: './local-plugins/sample-plugin' })),
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(result.renames).toEqual({
      'qodo-skills': 'qodo',
      'wordpress-com': 'build-with-wordpress',
      'auth0-sdks': 'auth0',
      twilio: 'twilio-developer-kit',
      formatter: 'formatter-pro',
      'code-formatter': 'formatter-pro',
      'legacy-linter': null,
    });
  });

  it('refuses a rename cycle and a target the catalog does not list', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'broken-renames',
      renames: { a: 'b', b: 'a', gone: 'never-listed', kept: 'real' },
      plugins: [{ name: 'real', source: './local-plugins/sample-plugin' }],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.renames).toEqual({ kept: 'real' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'marketplace.catalog.rename_cycle',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'marketplace.catalog.rename_unknown_target',
    }));
  });

  it('leaves the result free of a renames map when the catalog declares none', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'plain-catalog',
      plugins: [{ name: 'plain', source: './local-plugins/sample-plugin' }],
    };

    expect(parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT }).renames)
      .toBeUndefined();
  });

  it('leaves an entry with no plugin-defining fields without a definition at all', () => {
    const dto: ExternalPluginCatalogDto = {
      name: 'plain-catalog',
      plugins: [{ name: 'plain', source: './local-plugins/sample-plugin', category: 'productivity' }],
    };

    const result = parseExternalPluginCatalog('claude', dto, { catalogRoot: CLAUDE_CATALOG_ROOT });

    expect(result.proposals[0]?.entryDefinition).toBeUndefined();
  });
});

async function readJsonFixture(path: string): Promise<ExternalPluginCatalogDto> {
  return JSON.parse(await Bun.file(path).text()) as ExternalPluginCatalogDto;
}
