import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPluginInstallPlan,
  createPluginStagingArea,
  resolvePluginInstallSource,
  sweepAbandonedPluginStages,
} from '../source-resolver.ts';
import { PluginInstallService } from '../acquisition.ts';
import type { PluginInstallSource } from '../types.ts';
import {
  parseExternalPluginCatalog,
  type ExternalPluginCatalogDto,
} from '../../marketplace/external-catalog-adapters.ts';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const path = cleanup.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe('plugin source resolver', () => {
  it('rejects legacy marketplace refs instead of routing around marketplace APIs', () => {
    const resolved = resolvePluginInstallSource('plugin://internal/toolkit@1.2.3', {
      now: () => 10,
      defaultMarketplaceBaseUrl: 'https://market.example/api/v1',
    });

    expect(resolved.source).toEqual({
      kind: 'unsupported',
      value: 'plugin://internal/toolkit@1.2.3',
      reason: 'unrecognized-string',
    });
    expect(resolved.origin.source).toBe('unknown');
    expect(resolved.artifact?.type).toBe('unknown');
    expect(resolved.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.source.unsupported');
  });

  it('creates install plans without changing installed/cache/trust state', () => {
    const plan = createPluginInstallPlan({ kind: 'local-path', path: '/tmp/toolkit' }, {
      now: () => 42,
      requestedScope: 'workspace',
      defaultMarketplaceId: 'internal',
    });

    expect(plan.state).toBe('resolved');
    expect(plan.planId).toMatch(/^plugin-plan-42-/);
    expect(plan.requestedScope).toBe('workspace');
    expect(plan.source).toEqual({ kind: 'local-path', path: '/tmp/toolkit' });
    expect(plan.lifecycle).toEqual(['resolved', 'staged', 'installed', 'trusted', 'enabled', 'projected']);
  });

  it('retains external marketplace provenance for a registry-local plugin source', () => {
    const resolved = resolvePluginInstallSource({
      kind: 'local-path',
      path: '/tmp/toolkit',
      marketplace: {
        marketplaceId: 'registry-1',
        itemId: 'registry-1:toolkit',
        listKind: 'plugins',
        itemKind: 'plugin',
        name: 'toolkit',
      },
    }, { now: () => 43 });

    expect(resolved.origin).toEqual({
      source: 'marketplace',
      marketplaceId: 'registry-1',
      localPath: '/tmp/toolkit',
      resolvedAt: 43,
      provenance: expect.objectContaining({ itemId: 'registry-1:toolkit' }),
    });
  });

  it('retains the exact npm registry and integrity needed by repair/update', () => {
    const resolved = resolvePluginInstallSource({
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/toolkit',
      version: '2.1.0',
      registry: 'https://artifactory.example.test/api/npm/npm-all',
      integrity: 'sha512-cGlubmVk',
      marketplace: {
        marketplaceId: 'skills-market',
        itemId: 'toolkit',
        listKind: 'plugins',
        itemKind: 'plugin',
        name: 'Toolkit',
      },
    }, { now: () => 44 });

    expect(resolved.origin.provenance).toMatchObject({
      packageName: '@ai-office/toolkit',
      version: '2.1.0',
      registry: 'https://artifactory.example.test/api/npm/npm-all',
      integrity: 'sha512-cGlubmVk',
    });
  });

  /**
   * C4. The refusal used to live at the staging layer, so an entry on a host we
   * have no acquisition route for browsed as installable, and clicking Install
   * spent a real HTTP request on the host's landing page before failing with a
   * message that blamed the URL. These arms drive the REAL catalogue parser and
   * the REAL installer: a helper-only assertion would pass while the user still
   * saw an enabled button and a network round trip.
   */
  describe('unsupported git host (C4)', () => {
    const catalog = {
      name: 'host-matrix',
      plugins: [
        { name: 'bitbucket-plugin', source: { source: 'url', url: 'https://bitbucket.org/team/plugin.git', sha: 'aa11bb22' } },
        // C3.260 gave Bitbucket a route, so the refusal arms below moved to a
        // forge that still has none. Keeping the bitbucket entry beside it is
        // deliberate: the same catalogue now proves both halves.
        { name: 'gitea-plugin', source: { source: 'url', url: 'https://gitea.example.com/team/plugin.git', sha: 'ee55ff66' } },
        { name: 'github-plugin', source: { source: 'url', url: 'https://github.com/JuliusBrussee/caveman.git', sha: '0d95a81d' } },
        { name: 'gitlab-plugin', source: { source: 'url', url: 'https://gitlab.tcsbank.ru/grp/repo.git', sha: 'cc33dd44' } },
        { name: 'subdir-plugin', source: { source: 'git-subdir', url: '42Crunch-AI/claude-plugins', path: 'plugins/api-security-testing', ref: 'v1.0.1' } },
      ],
    } as unknown as ExternalPluginCatalogDto;

    function resolveCatalogEntry(pluginName: string) {
      const { proposals } = parseExternalPluginCatalog('claude', catalog, { catalogRoot: tmpdir() });
      const proposal = proposals.find(candidate => candidate.pluginName === pluginName);
      if (!proposal) throw new Error(`catalog entry "${pluginName}" was not parsed`);
      return resolvePluginInstallSource(proposal.source, { now: () => 1 });
    }

    it('refuses an entry on a forge with no archive route, naming the host and the supported set', () => {
      const resolved = resolveCatalogEntry('gitea-plugin');

      expect(resolved.source.kind).toBe('unsupported');
      expect(resolved.artifact?.type).toBe('unknown');
      const refusal = resolved.diagnostics.find(d => d.code === 'plugin.source.unsupported_repository_host');
      expect(refusal?.severity).toBe('error');
      expect(refusal?.message).toContain('gitea.example.com');
      expect(refusal?.message).toContain('github.com');
      expect(refusal?.message).toContain('gitlab');
    });

    /**
     * C3.260 (born 2026-09-11 from W15-f's PR-1), the positive half of the same
     * catalogue: the entry C3.190 refused by name now resolves as a repository.
     */
    it('resolves the Bitbucket entry C3.190 refused', () => {
      const resolved = resolveCatalogEntry('bitbucket-plugin');
      // The catalogue parser keeps the entry's URL verbatim, `.git` and all —
      // the same shape the github entry takes — and the acquisition parser is
      // the one that strips the suffix.
      expect(resolved.source).toMatchObject({
        kind: 'repository',
        repositoryUrl: 'https://bitbucket.org/team/plugin.git',
        ref: 'aa11bb22',
      });
      expect(resolved.diagnostics.map(d => d.code))
        .not.toContain('plugin.source.unsupported_repository_host');
    });

    /**
     * P3.219 — the refusal has to carry a ROUTE, not only a "no". The row's
     * complaint was that `source-resolver.ts`'s own comment named a staged
     * acquisition path (C4b/C4c) that belonged to no row, so a corporate
     * deployment on a self-hosted forge read the refusal as a dead end.
     *
     * Both named alternatives are real here and both are host-agnostic:
     * `#zip-archives` (this app stages an `archive` source, verifies its
     * `sha256` and sends its `headers`) and `#npm-packages`.
     */
    it('names a route that works on this host, not only the hosts that do not need one', () => {
      const refusal = resolveCatalogEntry('gitea-plugin')
        .diagnostics.find(d => d.code === 'plugin.source.unsupported_repository_host');
      expect(refusal?.message).toContain('archive');
      expect(refusal?.message).toContain('npm');
      // The entry is not the problem — saying so is what stops an operator
      // rewriting a valid catalog.
      expect(refusal?.message).toContain('The entry itself is valid');
      expect(refusal?.details).toMatchObject({ supportedAlternatives: ['archive', 'npm'] });
    });

    /**
     * P3.219, measured — the worry this refutes: `#git-repositories` says "The
     * `.git` suffix is optional, so Azure DevOps and AWS CodeCommit URLs without
     * the suffix work", and `unsupportedRepositoryHost` only inspects the suffix
     * for a BARE STRING. A catalog entry that declares a git source never
     * reaches that test — `claudeRepositorySource` gives it `kind: 'repository'`
     * — so the refusal covers the suffix-less hosts the page names.
     */
    it('refuses a declared git source with no .git suffix, on the hosts the page names', () => {
      for (const url of [
        // C3.260 gave `dev.azure.com` a route; the two below still have none,
        // and CodeCommit can never have one — see the next case.
        'https://gitea.example.com/org/repo',
        'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/plugins',
      ]) {
        const resolved = resolvePluginInstallSource(
          { kind: 'repository', repositoryUrl: url },
          { now: () => 1 },
        );
        expect({ url, kind: resolved.source.kind }).toEqual({ url, kind: 'unsupported' });
        expect(resolved.diagnostics.map(d => d.code))
          .toContain('plugin.source.unsupported_repository_host');
      }
    });

    /**
     * C3.260's third clause. A reader who meets a bare "unsupported host"
     * cannot tell a route we have not written from one that cannot exist, and
     * the row asked for CodeCommit to be RECORDED for exactly that reason.
     */
    it('tells a CodeCommit URL the route cannot exist, where a plain forge is only unsupported', () => {
      const codeCommit = resolvePluginInstallSource(
        { kind: 'repository', repositoryUrl: 'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/plugins' },
        { now: () => 1 },
      ).diagnostics.find(d => d.code === 'plugin.source.unsupported_repository_host');
      expect(codeCommit?.message).toContain('there is none to add');
      expect(codeCommit?.details).toMatchObject({ structurallyUnroutable: true });

      // The control that makes the sentence a reading rather than boilerplate:
      // a forge that simply has no route yet gets no such claim.
      const gitea = resolvePluginInstallSource(
        { kind: 'repository', repositoryUrl: 'https://gitea.example.com/org/repo' },
        { now: () => 1 },
      ).diagnostics.find(d => d.code === 'plugin.source.unsupported_repository_host');
      expect(gitea?.message).not.toContain('there is none to add');
      expect(gitea?.details).not.toMatchObject({ structurallyUnroutable: true });
    });

    it('leaves a GitHub and a GitLab entry, and a git-subdir owner/repo shorthand, resolving', () => {
      for (const [pluginName, repositoryUrl] of [
        ['github-plugin', 'https://github.com/JuliusBrussee/caveman.git'],
        ['gitlab-plugin', 'https://gitlab.tcsbank.ru/grp/repo.git'],
        // 190 of the community catalogue's 2307 entries carry an `owner/repo`
        // shorthand rather than a URL; the parser expands it to github.com.
        ['subdir-plugin', 'https://github.com/42Crunch-AI/claude-plugins'],
      ] as const) {
        const resolved = resolveCatalogEntry(pluginName);
        expect({ pluginName, kind: resolved.source.kind }).toEqual({ pluginName, kind: 'repository' });
        expect(resolved.source).toMatchObject({ repositoryUrl });
        expect(resolved.diagnostics).toEqual([]);
      }
    });

    it('spends no HTTP request on an unsupported host, where a supported host still fetches', async () => {
      const baseTempDir = join(tmpdir(), `plugin-host-refusal-${Date.now()}`);
      cleanup.push(baseTempDir);
      const requested: string[] = [];
      const service = new PluginInstallService({
        baseTempDir,
        fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
          requested.push(String(input));
          return new Response('nope', { status: 404 });
        }) as unknown as typeof fetch,
        artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
      });

      const stage = async (source: string | PluginInstallSource) => {
        const plan = await service.createInstallPlanFromSource(source);
        const staged = await service.stageInstall(plan);
        cleanup.push(staged.stageDirectory);
        return staged;
      };
      const catalogEntry = (pluginName: string) => {
        const { proposals } = parseExternalPluginCatalog('claude', catalog, { catalogRoot: tmpdir() });
        return proposals.find(candidate => candidate.pluginName === pluginName)!.source;
      };

      // The catalogue shape: refused before staging, and by its host rather
      // than by a sentence about which URLs the repository route accepts.
      const refusedEntry = await stage(catalogEntry('gitea-plugin'));
      expect(requested).toEqual([]);
      expect(refusedEntry.diagnostics.map(d => d.code)).toContain('plugin.source.unsupported_repository_host');

      // The ad-hoc "install by URL" shape, which is where the wasted request
      // was: an `https://…​.git` string classified as an ARCHIVE and downloaded
      // the host's landing page before failing to extract it.
      const refusedUrl = await stage('https://gitea.example.com/team/plugin.git');
      expect(requested).toEqual([]);
      expect(refusedUrl.diagnostics.map(d => d.code)).toContain('plugin.source.unsupported_repository_host');

      // Positive control on the same counter: a supported host DOES reach it,
      // so the empty arrays above are refusals and not a broken seam.
      await stage(catalogEntry('github-plugin'));
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.every(url => url.includes('github.com'))).toBe(true);
    });

    /**
     * C3.190 (owner answer QL9, 2026-09-11) — the row's first done-clause, and
     * it is an ACQUISITION claim, not a parser one. Widening only
     * `source-resolver.ts` would have moved the refusal to
     * `acquisition.ts:normalizeRepositorySpec`, which asked the same question
     * with its own copy of the substring: the source would resolve and then
     * fail to fetch. So this drives the REAL installer and reads the URL it
     * actually requested.
     */
    it('installs from our own self-hosted git host, through the documented GitLab API route', async () => {
      const baseTempDir = join(tmpdir(), `plugin-self-hosted-${Date.now()}`);
      cleanup.push(baseTempDir);
      const requested: string[] = [];
      const service = new PluginInstallService({
        baseTempDir,
        fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
          requested.push(String(input));
          return new Response('nope', { status: 404 });
        }) as unknown as typeof fetch,
        artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
      });

      const resolved = resolvePluginInstallSource('https://git.tcsbank.ru/grp/repo.git', { now: () => 1 });
      expect(resolved.source).toMatchObject({ kind: 'repository', repositoryUrl: 'https://git.tcsbank.ru/grp/repo' });
      expect(resolved.diagnostics).toEqual([]);

      const staged = await service.stageInstall(await service.createInstallPlanFromSource(resolved.source));
      cleanup.push(staged.stageDirectory);
      // The GitLab v4 route, on the host that was typed — `repositoryApiUrl`
      // builds it from the repository URL's own origin, so the self-hosted
      // instance needs no route of its own.
      expect(requested.length).toBeGreaterThan(0);
      expect(requested.some(url => url.startsWith('https://git.tcsbank.ru/api/v4/projects/'))).toBe(true);
      expect(requested.every(url => url.startsWith('https://git.tcsbank.ru/'))).toBe(true);
    });

    /**
     * C3.260 — the same ACQUISITION claim as the self-hosted arm above, made
     * for the two hosts C3.190 priced and deferred. Widening only the resolver
     * would move the refusal into `acquisition.ts:normalizeRepositorySpec`,
     * where the source resolves and then fails to fetch, so this drives the
     * REAL installer and reads the URLs it actually requested.
     *
     * Bitbucket's two routes were MEASURED live from this rig on 2026-09-12:
     * `api.bitbucket.org/2.0/repositories/<ws>/<repo>` answers 200 with
     * `mainbranch.name`, and `bitbucket.org/<ws>/<repo>/get/<ref>.tar.gz`
     * answers 200 `application/x-tar-gz`.
     */
    it('installs from Bitbucket Cloud: the metadata origin for the default ref, the web origin for the archive', async () => {
      const baseTempDir = join(tmpdir(), `plugin-bitbucket-${Date.now()}`);
      cleanup.push(baseTempDir);
      const requested: string[] = [];
      const service = new PluginInstallService({
        baseTempDir,
        fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
          requested.push(String(input));
          return new Response('nope', { status: 404 });
        }) as unknown as typeof fetch,
        artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
      });

      const resolved = resolvePluginInstallSource('https://bitbucket.org/team/plugin.git', { now: () => 1 });
      expect(resolved.source).toMatchObject({ kind: 'repository', repositoryUrl: 'https://bitbucket.org/team/plugin' });
      expect(resolved.diagnostics).toEqual([]);

      const staged = await service.stageInstall(await service.createInstallPlanFromSource(resolved.source));
      cleanup.push(staged.stageDirectory);
      // Bitbucket is the ONE host whose API lives on a different origin from
      // its repository URL, so this is the arm a shared-origin assumption fails.
      expect(requested).toEqual(['https://api.bitbucket.org/2.0/repositories/team/plugin']);

      // With a ref in hand the archive route is the WEB origin, and there is
      // exactly one candidate — the retry below belongs to Azure alone.
      requested.length = 0;
      const pinned = await service.stageInstall(await service.createInstallPlanFromSource({
        kind: 'repository',
        repositoryUrl: 'https://bitbucket.org/team/plugin',
        ref: 'release-1.2',
      }));
      cleanup.push(pinned.stageDirectory);
      expect(requested).toEqual(['https://bitbucket.org/team/plugin/get/release-1.2.tar.gz']);
    });

    /**
     * C3.260, Azure DevOps — READ, NOT MEASURED, and the test says so because
     * the difference matters to whoever reads it next: `dev.azure.com` answers
     * 503 through this network's proxy (an HTML block page, 2026-09-12), so
     * every URL below is `learn.microsoft.com`'s shape and none of them has been
     * driven against the real host.
     *
     * The second candidate is the one thing here that is not a transcription: a
     * bare ref cannot say whether it names a branch or a tag, and Azure's
     * `versionDescriptor.versionType` is an enum where GitHub and GitLab each
     * take all three in one slot. A tag-resolved dependency pins the TAG name
     * (`marketplace/service.ts` symbol `withDependencyRef`), so without the
     * second attempt every version-constrained Azure install would fail.
     */
    it('requests the documented Azure DevOps items route, and retries a non-sha ref as a tag', async () => {
      const baseTempDir = join(tmpdir(), `plugin-azure-${Date.now()}`);
      cleanup.push(baseTempDir);
      const requested: string[] = [];
      const service = new PluginInstallService({
        baseTempDir,
        fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
          requested.push(String(input));
          return new Response('nope', { status: 404 });
        }) as unknown as typeof fetch,
        artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
      });

      const resolved = resolvePluginInstallSource('https://dev.azure.com/contoso/tools/_git/plugins', { now: () => 1 });
      expect(resolved.source).toMatchObject({
        kind: 'repository',
        repositoryUrl: 'https://dev.azure.com/contoso/tools/_git/plugins',
      });

      const staged = await service.stageInstall(await service.createInstallPlanFromSource({
        kind: 'repository',
        repositoryUrl: 'https://dev.azure.com/contoso/tools/_git/plugins',
        ref: 'vault--v1.2.3',
      }));
      cleanup.push(staged.stageDirectory);
      expect(requested).toEqual([
        'https://dev.azure.com/contoso/tools/_apis/git/repositories/plugins/items'
          + '?path=%2F&$format=zip&download=true'
          + '&versionDescriptor.versionType=branch&versionDescriptor.version=vault--v1.2.3&api-version=7.1',
        'https://dev.azure.com/contoso/tools/_apis/git/repositories/plugins/items'
          + '?path=%2F&$format=zip&download=true'
          + '&versionDescriptor.versionType=tag&versionDescriptor.version=vault--v1.2.3&api-version=7.1',
      ]);

      // A 40-hex ref can only be a commit, so it costs ONE request — the
      // control that makes the pair above a derivation and not a blanket retry.
      requested.length = 0;
      const pinned = await service.stageInstall(await service.createInstallPlanFromSource({
        kind: 'repository',
        repositoryUrl: 'https://dev.azure.com/contoso/tools/_git/plugins',
        ref: '0123456789abcdef0123456789abcdef01234567',
      }));
      cleanup.push(pinned.stageDirectory);
      expect(requested).toHaveLength(1);
      expect(requested[0]).toContain('versionDescriptor.versionType=commit');
    });

    /**
     * C3.260 — four hosts, THREE spellings of the default branch, and the two
     * new ones are both different from the two old ones. Had this stayed one
     * shared `default_branch` read, every unpinned install on either new host
     * would have failed as `plugin.install.repository_ref_unresolved` — a typed
     * refusal naming the wrong cause, which is the silent-divergence shape this
     * fork keeps paying for.
     *
     * `mainbranch.name` was MEASURED (`api.bitbucket.org`, 2026-09-12: the
     * response's top-level keys do not include `default_branch` at all);
     * `defaultBranch` and its `refs/heads/` prefix were READ.
     */
    it('reads each host\'s own default-branch field, and strips Azure\'s refs/heads prefix', async () => {
      const baseTempDir = join(tmpdir(), `plugin-default-ref-${Date.now()}`);
      cleanup.push(baseTempDir);

      const driveUnpinned = async (repositoryUrl: string, metadata: unknown) => {
        const requested: string[] = [];
        const service = new PluginInstallService({
          baseTempDir,
          fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
            const href = String(input);
            requested.push(href);
            return requested.length === 1
              ? new Response(JSON.stringify(metadata), { status: 200, headers: { 'content-type': 'application/json' } })
              : new Response('nope', { status: 404 });
          }) as unknown as typeof fetch,
          artifactAuthProvider: { fetchArtifact: (url, fetchImpl) => fetchImpl(url) },
        });
        const staged = await service.stageInstall(await service.createInstallPlanFromSource({
          kind: 'repository',
          repositoryUrl,
        }));
        cleanup.push(staged.stageDirectory);
        return requested;
      };

      const bitbucket = await driveUnpinned('https://bitbucket.org/team/plugin', {
        mainbranch: { name: 'trunk' },
        // The field the other two hosts use is absent here, which is the whole
        // reason the read is per-host.
      });
      expect(bitbucket[1]).toBe('https://bitbucket.org/team/plugin/get/trunk.tar.gz');

      const azure = await driveUnpinned('https://dev.azure.com/contoso/tools/_git/plugins', {
        defaultBranch: 'refs/heads/main',
      });
      expect(azure[0]).toBe('https://dev.azure.com/contoso/tools/_apis/git/repositories/plugins?api-version=7.1');
      expect(azure[1]).toContain('versionDescriptor.version=main');
      expect(azure[1]).not.toContain('refs%2Fheads');

      // The control: the old spelling still works where it always did, so the
      // switch above is a widening and not a replacement.
      const github = await driveUnpinned('https://github.com/acme/vault', { default_branch: 'main' });
      expect(github[1]).toBe('https://github.com/acme/vault/archive/main.tar.gz');
    });

    /**
     * C3.190's negative, and the shape that made the substring test dangerous:
     * a hostname that merely CONTAINS `gitlab` resolved at HEAD. It is refused
     * now, and the refusal names the setting that brings it back rather than
     * leaving a host that worked yesterday reading as unsupported.
     */
    it('refuses a hostname that only contains "gitlab", naming the setting that re-admits it', () => {
      const resolved = resolvePluginInstallSource('https://mygitlab.acme.com/grp/repo.git', { now: () => 1 });
      expect(resolved.source.kind).toBe('unsupported');
      const refusal = resolved.diagnostics.find(d => d.code === 'plugin.source.unsupported_repository_host');
      expect(refusal?.message).toContain('NESSY_PLUGIN_GITLAB_HOSTS');
      expect(refusal?.message).toContain('git.tcsbank.ru');
      expect(refusal?.details).toMatchObject({ supportedAlternatives: ['archive', 'npm'] });
    });

    /**
     * C3.190's non-git negative, and a latent defect measured at HEAD while
     * widening: `https://gitlab.example.com/team/marketplace.json` resolved to
     * `kind: 'repository'` with a `repositoryUrl` ending in `.json` — the
     * documented "remote URL to a `marketplace.json` file"
     * (`plugins/cli-reference.md#plugin-marketplace-add`) swallowed by the
     * repository branch on EVERY GitLab host. Unguarded, the widened host set
     * would have carried it onto our own git host too.
     */
    it('leaves a non-repository URL on a supported host as a fetchable URL', () => {
      for (const url of [
        'https://gitlab.example.com/team/marketplace.json',
        'https://git.tcsbank.ru/grp/releases/plugin.zip',
      ]) {
        const resolved = resolvePluginInstallSource(url, { now: () => 1 });
        expect({ url, kind: resolved.source.kind }).toEqual({ url, kind: 'url' });
        expect(resolved.diagnostics.map(d => d.code))
          .not.toContain('plugin.source.unsupported_repository_host');
      }
    });
  });

  /**
   * `plugin-marketplaces.md` § Zip archives — an `archive` entry is a zip
   * "that Claude Code downloads over HTTPS", optionally pinned by a `sha256`
   * "SHA-256 digest of the archive as 64 hex characters".
   *
   * This drives the REAL catalogue parser into the REAL resolver: the pin has
   * to survive BOTH hops to matter, and it did not — `artifactForSource`'s
   * `url` arm dropped `expectedHash` even though the source type declared it,
   * so a pinned archive would have downloaded and installed unverified.
   */
  it('carries a catalogue archive entry, and its sha256 pin, into the archive-url artifact', () => {
    const url = 'https://artifacts.example.com/claude-plugins/my-plugin-2.1.0.zip';
    const digest = '6bfa50e3d2e00c052b46abe51fff89346ac803e45771f76dcf6df1ab74cca5e1';
    const { proposals, diagnostics } = parseExternalPluginCatalog('claude', {
      name: 'archive-marketplace',
      plugins: [
        { name: 'pinned-archive', source: { source: 'archive', url, sha256: digest } },
        { name: 'unpinned-archive', source: { source: 'archive', url } },
      ],
    } as unknown as ExternalPluginCatalogDto, { catalogRoot: tmpdir() });
    expect(diagnostics).toEqual([]);

    const pinned = resolvePluginInstallSource(proposals[0]!.source, { now: () => 3 });
    expect(pinned.diagnostics).toEqual([]);
    expect(pinned.artifact).toMatchObject({
      type: 'archive-url',
      url,
      // The spelling `acquisition.ts:verifyExpectedHash` parses — it strips a
      // `sha256-` prefix and compares the rest against the computed lowercase
      // hex, so a `sha256:` colon would fail every pinned install instead.
      expectedHash: `sha256-${digest}`,
    });

    // An unpinned archive still resolves, and carries no pin to verify.
    const unpinned = resolvePluginInstallSource(proposals[1]!.source, { now: () => 3 });
    expect(unpinned.artifact).toEqual({ type: 'archive-url', url });
  });

  /**
   * The `marketplace-url` arm carries the same pin. `plugin-marketplaces.md`
   * § Zip archives (fetched 2026-08-24): `sha256` is the digest "Claude Code
   * verifies every download against it and refuses the install on a mismatch".
   * `artifactForSource`'s `marketplace-url` arm must hand that pin to the
   * `archive-url` artifact — the sibling of the `url`-arm drop P0.4 fixed — so a
   * pinned marketplace archive is never downloaded unverified.
   */
  it('carries a marketplace-url source\'s sha256 pin into the archive-url artifact', () => {
    const url = 'https://artifacts.example.com/claude-plugins/my-plugin-2.1.0.zip';
    const expectedHash = `sha256-${'a'.repeat(64)}`;

    const pinned = resolvePluginInstallSource({ kind: 'marketplace-url', url, expectedHash }, { now: () => 3 });
    expect(pinned.diagnostics).toEqual([]);
    expect(pinned.artifact).toMatchObject({ type: 'archive-url', url, expectedHash });

    // An unpinned marketplace-url archive still resolves and carries no pin.
    const unpinned = resolvePluginInstallSource({ kind: 'marketplace-url', url }, { now: () => 3 });
    expect(unpinned.artifact).toEqual({ type: 'archive-url', url });
  });

  /**
   * A `blob` marker addresses a FILE. Classifying it as a repository directory
   * dropped both the ref and the path, so the install silently acquired the
   * whole repository at its default branch instead of failing.
   */
  it('does not classify a blob (file) URL as a whole-repository source', () => {
    for (const url of [
      'https://gitlab.tcsbank.ru/grp/repo/-/blob/main/skills/x/SKILL.md',
      'https://github.com/o/r/blob/main/skills/x/SKILL.md',
    ]) {
      const resolved = resolvePluginInstallSource(url, { now: () => 2 });
      expect({ url, kind: resolved.source.kind }).not.toEqual({ url, kind: 'repository' });
      expect(JSON.stringify(resolved.source)).toContain('skills/x/SKILL.md');
    }

    // Positive control: the same shapes with a `tree` marker still classify,
    // keeping the ref and the subdirectory.
    expect(resolvePluginInstallSource('https://gitlab.tcsbank.ru/grp/repo/-/tree/main/skills/x').source)
      .toEqual({ kind: 'repository', repositoryUrl: 'https://gitlab.tcsbank.ru/grp/repo', ref: 'main', subdirectory: 'skills/x' });
    expect(resolvePluginInstallSource('https://github.com/o/r/tree/main/skills/x').source)
      .toEqual({ kind: 'repository', repositoryUrl: 'https://github.com/o/r', ref: 'main', subdirectory: 'skills/x' });
  });

  /**
   * `plugins/marketplace-reference.md#github-plugin-source` — "`<source>`: GitHub `owner/repo` shorthand,
   * git URL, remote URL to a `marketplace.json` file, or local directory path.
   * To pin to a branch or tag, append `@ref` to the GitHub shorthand".
   *
   * The resolver never implemented the shorthand, so a marketplace added the
   * way Claude's own docs spell it classified `unsupported` → artifact `unknown`
   * → `upgrade()` refused it as `not-git` and the browse fetch failed in ~4ms
   * with no network call and nothing in the log.
   */
  it('classifies a bare GitHub owner/repo shorthand as a clonable repository', () => {
    for (const [source, expected] of [
      ['anthropics/claude-code', 'https://github.com/anthropics/claude-code'],
      ['anthropics/claude-plugins-official', 'https://github.com/anthropics/claude-plugins-official'],
      ['openai/plugins', 'https://github.com/openai/plugins'],
    ] as const) {
      expect(resolvePluginInstallSource(source).source)
        .toEqual({ kind: 'repository', repositoryUrl: expected });
    }
    // `:953`'s second half — the `@ref` pin.
    expect(resolvePluginInstallSource('anthropics/claude-code@main').source)
      .toEqual({ kind: 'repository', repositoryUrl: 'https://github.com/anthropics/claude-code', ref: 'main' });
  });

  it('keeps a real local directory winning over the shorthand shape', () => {
    // `owner/repo` is also a legitimate relative path. The shorthand branch runs
    // AFTER the local-path probe precisely so an existing directory still wins;
    // getting this backwards would silently clone a stranger's GitHub repo in
    // place of the user's own folder.
    const cwd = mkdtempSync(join(tmpdir(), 'shorthand-cwd-'));
    cleanup.push(cwd);
    mkdirSync(join(cwd, 'acme', 'widgets'), { recursive: true });

    expect(resolvePluginInstallSource('acme/widgets', { cwd }).source)
      .toEqual({ kind: 'local-path', path: join(cwd, 'acme', 'widgets') });
    // Positive control: the same string with no such directory IS the shorthand.
    expect(resolvePluginInstallSource('acme/widgets', { cwd: tmpdir() }).source)
      .toEqual({ kind: 'repository', repositoryUrl: 'https://github.com/acme/widgets' });
  });

  it('refuses a scheme-less host, a traversal, and a bare word as shorthand', () => {
    // `:955` — "A URL must include its scheme. As of Claude Code v2.1.196, a
    // host typed without one, such as `gitlab.example.com/team/plugins`, is
    // rejected as an invalid `owner/repo` shorthand".
    for (const source of [
      'gitlab.example.com/team/plugins', // two slashes
      'gitlab.example.com/team', // dotted owner is not a GitHub owner
      'justonesegment',
      'anthropics/claude-code@', // an `@` with no ref is a typo, not a default-branch pin
    ]) {
      expect({ source, kind: resolvePluginInstallSource(source, { cwd: tmpdir() }).source.kind })
        .toEqual({ source, kind: 'unsupported' });
    }
    // A traversal never reaches the shorthand branch at all — it is path-like,
    // so it classifies local. This is what stops `../evil` being clone-shaped.
    expect(resolvePluginInstallSource('../evil', { cwd: tmpdir() }).source.kind).toBe('local-path');
  });

  it('stages in a temporary directory outside plugin cache state', async () => {
    const baseTempDir = join(tmpdir(), `plugin-source-test-${Date.now()}`);
    cleanup.push(baseTempDir);
    const plan = createPluginInstallPlan({ kind: 'local-path', path: '/tmp/toolkit' }, { now: () => 100 });

    const staged = await createPluginStagingArea(plan, { baseTempDir, now: () => 101 });
    cleanup.push(staged.stageDirectory);

    expect(staged.plan.state).toBe('staged');
    expect(staged.stageDirectory.startsWith(baseTempDir)).toBe(true);
    expect(existsSync(staged.rawDirectory)).toBe(true);
    expect(existsSync(staged.normalizedDirectory)).toBe(true);
  });
});

describe('the `#ref` pin on a git URL', () => {
  // `plugins/cli-reference.md#plugin-marketplace-add` — "`<source>`: GitHub
  // `owner/repo` shorthand, git URL, remote URL to a `marketplace.json` file, or
  // local directory path. To pin to a branch or tag, append `@ref` to the GitHub
  // shorthand or `#ref` to a git URL". Only the `@ref` half was implemented; the
  // `#ref` half resolved to the default branch with no ref and no diagnostic.

  it('pins a hosted repository URL to the ref after the `#`', () => {
    for (const [source, expected] of [
      ['https://github.com/acme/plugins#v2.0.0', { repositoryUrl: 'https://github.com/acme/plugins', ref: 'v2.0.0' }],
      ['https://github.com/acme/plugins.git#v2.0.0', { repositoryUrl: 'https://github.com/acme/plugins', ref: 'v2.0.0' }],
      ['https://gitlab.com/group/proj#release-1', { repositoryUrl: 'https://gitlab.com/group/proj', ref: 'release-1' }],
      ['https://gitlab.tcsbank.ru/team/plugins.git#main', { repositoryUrl: 'https://gitlab.tcsbank.ru/team/plugins', ref: 'main' }],
    ] as const) {
      const resolved = resolvePluginInstallSource(source, { cwd: tmpdir() });
      expect({ source, ...resolved.source }).toEqual({ source, kind: 'repository', ...expected });
    }
  });

  it('keeps the scp-form git URL our own add dialog offers installable when it is pinned', () => {
    // The regression this closes: with the pin appended the string no longer
    // ended in `.git`, so every branch above the shorthand test failed and the
    // shorthand pattern refused it — a documented pin turned a SUPPORTED source
    // into `unsupported` outright.
    const resolved = resolvePluginInstallSource('git@github.com:acme/plugins.git#v1.2.3', { cwd: tmpdir() });
    expect(resolved.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'git@github.com:acme/plugins.git',
      ref: 'v1.2.3',
    });
  });

  it('treats an empty `#` as no pin, matching `URL.hash`', () => {
    const resolved = resolvePluginInstallSource('https://github.com/acme/plugins#', { cwd: tmpdir() });
    expect(resolved.source).toEqual({ kind: 'repository', repositoryUrl: 'https://github.com/acme/plugins' });
  });

  it('does not consume a fragment on a `marketplace.json` URL or a local path', () => {
    // The same sentence lists "remote URL to a `marketplace.json` file" as its
    // own `<source>` form; a fragment there is part of the URL, not a git ref.
    expect(resolvePluginInstallSource('https://files.example.com/catalog/marketplace.json#section', { cwd: tmpdir() }).source)
      .toEqual({ kind: 'url', url: 'https://files.example.com/catalog/marketplace.json#section' });

    // A local directory may legitimately carry a `#` in its name.
    const cwd = mkdtempSync(join(tmpdir(), 'ref-pin-cwd-'));
    cleanup.push(cwd);
    mkdirSync(join(cwd, 'plugins#draft'), { recursive: true });
    expect(resolvePluginInstallSource('./plugins#draft', { cwd }).source)
      .toEqual({ kind: 'local-path', path: join(cwd, 'plugins#draft') });
  });

  it('lets the pin win over a browse-URL ref and says so', () => {
    // The documentation is silent on a browse URL that names two refs, so the
    // choice is made here and made VISIBLE rather than queued.
    const resolved = resolvePluginInstallSource('https://github.com/acme/plugins/tree/v2/sub#v3', { cwd: tmpdir() });
    expect(resolved.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/acme/plugins',
      ref: 'v3',
      subdirectory: 'sub',
    });
    expect(resolved.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.source.ref_pin_overrides_url_ref');
  });

  it('stays silent when the pin agrees with the browse-URL ref', () => {
    const resolved = resolvePluginInstallSource('https://github.com/acme/plugins/tree/v2/sub#v2', { cwd: tmpdir() });
    expect(resolved.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/acme/plugins',
      ref: 'v2',
      subdirectory: 'sub',
    });
    expect(resolved.diagnostics).toEqual([]);
  });
});

/**
 * D1.187 — the staging directory a hard kill leaves behind.
 *
 * `releaseSessionScopedPlugins` runs on `deleteSession` and on `cleanup()`, so
 * only a kill leaks one. These cases drive the real `createPluginStagingArea`
 * for the marker and the real sweep for the removal; the ONE injected
 * collaborator is the liveness predicate, because a test cannot own a dead pid
 * (and a pid it invents may be reused by the time the case runs — which is
 * exactly the hazard the production predicate is written to fail safe on).
 */
describe('sweepAbandonedPluginStages (D1.187)', () => {
  function stageRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'nessy-stage-sweep-'));
    cleanup.push(root);
    return root;
  }

  async function stageIn(root: string, stagedAt: number): Promise<string> {
    const plan = createPluginInstallPlan({ kind: 'local-path', path: root });
    const staged = await createPluginStagingArea(plan, { baseTempDir: root, now: () => stagedAt });
    return staged.stageDirectory;
  }

  const DAY_AGO = Date.now() - 24 * 60 * 60 * 1000;

  it('writes an ownership marker carrying this process and nothing else', async () => {
    const root = stageRoot();
    const directory = await stageIn(root, DAY_AGO);

    const marker = JSON.parse(readFileSync(join(directory, '.nessy-stage-owner.json'), 'utf-8'));
    expect(marker).toEqual({ pid: process.pid, createdAt: DAY_AGO });
    // No path, no user, no source: a temp root is world-readable.
    expect(Object.keys(marker).sort()).toEqual(['createdAt', 'pid']);
  });

  it('removes an old stage whose owner is gone', async () => {
    const root = stageRoot();
    const directory = await stageIn(root, DAY_AGO);

    const removed = await sweepAbandonedPluginStages({
      baseTempDir: root,
      isProcessAlive: () => false,
    });

    expect(removed).toBe(1);
    expect(existsSync(directory)).toBe(false);
  });

  it('keeps a stage whose owner is still running', async () => {
    const root = stageRoot();
    const directory = await stageIn(root, DAY_AGO);

    expect(await sweepAbandonedPluginStages({ baseTempDir: root, isProcessAlive: () => true })).toBe(0);
    expect(existsSync(directory)).toBe(true);
  });

  it('keeps a stage younger than the age floor, dead owner or not', async () => {
    const root = stageRoot();
    const directory = await stageIn(root, Date.now());

    expect(await sweepAbandonedPluginStages({ baseTempDir: root, isProcessAlive: () => false })).toBe(0);
    expect(existsSync(directory)).toBe(true);
  });

  /**
   * The blast-radius control, and the reason the marker exists at all: a temp
   * root is shared with every other program on the machine, so a NAME match is
   * not ownership. Both arms are directories this sweep must never touch.
   */
  it('never touches a directory it cannot prove is ours', async () => {
    const root = stageRoot();
    const markerless = join(root, 'nessy-plugin-stage-from-an-older-build');
    mkdirSync(markerless, { recursive: true });
    const malformed = join(root, 'nessy-plugin-stage-malformed');
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, '.nessy-stage-owner.json'), 'not json at all');
    const foreign = join(root, 'some-other-programs-directory');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, '.nessy-stage-owner.json'), JSON.stringify({ pid: 1, createdAt: 0 }));

    expect(await sweepAbandonedPluginStages({ baseTempDir: root, isProcessAlive: () => false })).toBe(0);
    expect(existsSync(markerless)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it('answers 0 for a base directory that does not exist', async () => {
    expect(await sweepAbandonedPluginStages({ baseTempDir: join(stageRoot(), 'nope') })).toBe(0);
  });
});
