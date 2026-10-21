import { describe, expect, it } from 'bun:test';
import {
  PluginInstallService,
  selectNpmVersionName,
  type PluginArtifactAuthProvider,
  type PluginInstallServiceOptions,
} from '../acquisition.ts';

/**
 * `selectNpmVersionName` and `listRepositoryTags` as units: pure acquisition
 * behaviour with no store and no staging area. Split verbatim out of the V1
 * installer's test file in F4 part 1; part 2 converted the rest of that file to
 * `acquisition-pipeline.test.ts`, which drives plan → stage → normalize end to
 * end.
 */

function createService(fetchImpl: typeof fetch, options: Partial<PluginInstallServiceOptions> = {}): PluginInstallService {
  return new PluginInstallService({
    fetchImpl,
    now: () => 10_000,
    ...options,
  });
}

function asFetch(fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<unknown>): typeof fetch {
  return fetchImpl as unknown as typeof fetch;
}

/**
 * The published version set of
 * `@ai-office/nessy-extension-nestor-nessy-default-extension`, read from
 * `artifactory.tcsbank.ru/api/npm/npm-all` on 2026-07-31. There is no plain
 * `1.0.9`, and `dist-tags.latest` is a build stamp.
 *
 * `dist` here carries the tarball only: this shape exists to exercise version
 * SELECTION. Every real version also publishes `integrity` (sha512) and
 * `shasum` (sha1 hex) — the digest matrix in `acquisition-pipeline.test.ts`
 * covers those arms.
 */
const REAL_REGISTRY_METADATA_SHAPE = {
  'dist-tags': { beta: '1.0.3-beta.0', latest: '1.0.9-source.20260716152955.45c8ba6c7514' },
  versions: {
    '1.0.3-beta.0': { dist: { tarball: 'https://registry.example.com/stamped-1.0.3-beta.0.tgz' } },
    '1.0.3-beta.0.nessy.1': { dist: { tarball: 'https://registry.example.com/stamped-1.0.3-beta.0.nessy.1.tgz' } },
    '1.0.3-beta.0.nessy.1-nessy.1': { dist: { tarball: 'https://registry.example.com/stamped-a.tgz' } },
    '1.0.3-beta.0.nessy.1-nessy.2': { dist: { tarball: 'https://registry.example.com/stamped-b.tgz' } },
    '1.0.6': { dist: { tarball: 'https://registry.example.com/stamped-1.0.6.tgz' } },
    '1.0.7': { dist: { tarball: 'https://registry.example.com/stamped-1.0.7.tgz' } },
    '1.0.7-source.20260616140806.cb4784c35c5c': { dist: { tarball: 'https://registry.example.com/stamped-1.0.7-source.tgz' } },
    '1.0.9-source.20260716152955.45c8ba6c7514': { dist: { tarball: 'https://registry.example.com/stamped-1.0.9-source.tgz' } },
  },
};

describe('selectNpmVersionName against the real registry shape', () => {
  it('takes the CI build stamp for an advertised version that was never published plainly', () => {
    expect(selectNpmVersionName(REAL_REGISTRY_METADATA_SHAPE, '1.0.9')).toEqual({
      version: '1.0.9-source.20260716152955.45c8ba6c7514',
      rule: 'widened-within-base',
      info: { candidates: 1 },
    });
  });

  it('still prefers an exact publish over any stamp of the same base', () => {
    // 1.0.7 AND 1.0.7-source.<stamp> both exist; the exact one wins.
    expect(selectNpmVersionName(REAL_REGISTRY_METADATA_SHAPE, '1.0.7')).toEqual({
      version: '1.0.7',
      rule: 'exact',
      info: {},
    });
  });

  it('refuses rather than substituting a different base version', () => {
    // `dist-tags.latest` exists and would install cleanly — and is 1.0.9, not
    // 2.0.0. Reaching for it here is the silent substitution this forbids.
    expect(selectNpmVersionName(REAL_REGISTRY_METADATA_SHAPE, '2.0.0')).toBeUndefined();
    expect(selectNpmVersionName(REAL_REGISTRY_METADATA_SHAPE, '1.0.8')).toBeUndefined();
  });

  it('orders widened candidates by semver, not by string, and refuses unparseable ones', () => {
    // `-source.10.x` must beat `-source.9.x`: a string sort puts "10" first and
    // installs the OLDER build.
    expect(selectNpmVersionName({
      versions: {
        '2.0.0-source.9.aaa': { dist: {} },
        '2.0.0-source.10.bbb': { dist: {} },
      },
    }, '2.0.0')?.version).toBe('2.0.0-source.10.bbb');

    // A candidate that will not parse as semver is not a build of this release.
    expect(selectNpmVersionName({
      versions: { '2.0.0-': { dist: {} }, '2.0.0-not a version': { dist: {} } },
    }, '2.0.0')).toBeUndefined();

    // A request that already names a prerelease asks for THAT build, not a
    // wider family: `1.0.3-beta.0` must not widen to `1.0.3-beta.1`.
    expect(selectNpmVersionName({
      versions: { '1.0.3-beta.1': { dist: {} } },
    }, '1.0.3-beta.0')).toBeUndefined();

    // …but a stamp OF that prerelease is still the same build. Three live
    // catalog rows are published only this way.
    expect(selectNpmVersionName({
      versions: { '1.0.3-beta.0-source.20260627123722.90adde5e1b5a': { dist: {} } },
    }, '1.0.3-beta.0')).toEqual({
      version: '1.0.3-beta.0-source.20260627123722.90adde5e1b5a',
      rule: 'widened-within-base',
      info: { candidates: 1 },
    });
  });

  it('takes dist-tags.latest when nothing is pinned, and never across bases', () => {
    const metadata = {
      'dist-tags': { latest: '2.0.0' },
      versions: { '2.0.0': { dist: {} }, '1.0.0': { dist: {} } },
    };
    expect(selectNpmVersionName(metadata)).toEqual({ version: '2.0.0', rule: 'dist-tag-latest', info: {} });
    // latest is 2.0.0; requesting 1.0.1 must NOT fall through to it.
    expect(selectNpmVersionName(metadata, '1.0.1')).toBeUndefined();
    // Nor may a pinned request reach the tag at all: 1.0.0 IS published, so
    // this is the exact rule; 1.0.2 is not, and there is no stamp of it.
    expect(selectNpmVersionName(metadata, '1.0.0')?.rule).toBe('exact');
    expect(selectNpmVersionName(metadata, '1.0.2')).toBeUndefined();
  });
});

/**
 * `plugins/host-marketplace.md#run-release-channels` — "Claude Code lists the marketplace's tags". The
 * one new network route this feature needed; it hangs off the SAME api base
 * `fetchRepositoryDefaultRef` already uses and rides the same auth provider.
 */
describe('repository tag listing', () => {
  it('reads the GitHub /tags route through the artifact auth provider, paginated', async () => {
    const seen: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      name: `vault--v1.0.${index}`,
      commit: { sha: `sha-${index}` },
    }));
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      const href = String(url);
      seen.push(href);
      // `endsWith`, not `includes`: `per_page=100` contains the substring
      // `page=1`, so a looser stub silently serves page one to every page.
      const body = href.endsWith('&page=1') ? page1 : [{ name: 'vault--v2.0.0', commit: { sha: 'sha-final' } }];
      return { ok: true, status: 200, async json() { return body; } };
    });
    const authHeaders: string[] = [];
    const artifactAuthProvider: PluginArtifactAuthProvider = {
      async fetchArtifact(url, inner) {
        authHeaders.push(String(url));
        return inner(url);
      },
    };

    const tags = await createService(fetchImpl, { artifactAuthProvider })
      .listRepositoryTags('https://github.com/acme/vault');

    expect(seen[0]).toBe('https://api.github.com/repos/acme/vault/tags?per_page=100&page=1');
    expect(seen[1]).toBe('https://api.github.com/repos/acme/vault/tags?per_page=100&page=2');
    // Every request went through the auth provider, not around it.
    expect(authHeaders).toHaveLength(2);
    expect(tags).toHaveLength(101);
    expect(tags?.at(-1)).toEqual({ name: 'vault--v2.0.0', commitSha: 'sha-final' });
  });

  it('uses GitLab\'s /repository/tags route and reads commit.id', async () => {
    const seen: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() { return [{ name: 'vault--v1.2.3', commit: { id: 'gitlab-sha' } }]; },
      };
    });

    const tags = await createService(fetchImpl)
      .listRepositoryTags('https://gitlab.example.invalid/group/vault');

    expect(seen[0]).toContain('/api/v4/projects/group%2Fvault/repository/tags?per_page=100&page=1');
    expect(tags).toEqual([{ name: 'vault--v1.2.3', commitSha: 'gitlab-sha' }]);
  });

  /**
   * C3.260 — Bitbucket disagrees with GitHub and GitLab on all THREE parts of
   * this request, and every one of them was measured live from this rig on
   * 2026-09-12 against the public `atlassian/aui`:
   *
   * - the page-size parameter is `pagelen`, not `per_page` (the response echoes
   *   `pagelen`, and `per_page` is silently ignored — a listing capped at the
   *   default page size, not an error);
   * - the rows arrive inside a `values` envelope, where a shared
   *   `Array.isArray(payload)` reads "not a listing" and reports an unreachable
   *   listing for a request that succeeded;
   * - the commit is `target.hash`, not `commit.sha`.
   */
  it('reads Bitbucket\'s refs/tags route: pagelen, a values envelope, and target.hash', async () => {
    const seen: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            values: [{ name: 'vault--v1.2.3', target: { hash: '427be59da7b7323591364a1efe3bb681fb3cd4b9' } }],
            pagelen: 100,
            size: 1,
            page: 1,
          };
        },
      };
    });

    const tags = await createService(fetchImpl)
      .listRepositoryTags('https://bitbucket.org/atlassian/aui');

    expect(seen).toEqual(['https://api.bitbucket.org/2.0/repositories/atlassian/aui/refs/tags?pagelen=100&page=1']);
    expect(tags).toEqual([{ name: 'vault--v1.2.3', commitSha: '427be59da7b7323591364a1efe3bb681fb3cd4b9' }]);
  });

  /**
   * C3.260 — Azure DevOps, READ and not measured (`dev.azure.com` answers 503
   * through this network's proxy, 2026-09-12). Two shape differences, and the
   * second is the one that would have failed silently: a ref name arrives as
   * `refs/tags/<name>`, and an unstripped name matches no
   * `<plugin>--v<semver>` prefix at all, so every Azure repository would read as
   * carrying no tags — an authoritative "no tags", which is exactly the
   * distinction the case below this one exists to protect.
   */
  it('reads Azure DevOps refs: a value envelope, refs/tags stripped, peeled commit preferred', async () => {
    const seen: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            value: [
              { name: 'refs/tags/vault--v2.0.0', objectId: 'tag-object', peeledObjectId: 'commit-object' },
              { name: 'refs/tags/vault--v1.0.0', objectId: 'lightweight-commit' },
            ],
            count: 2,
          };
        },
      };
    });

    const tags = await createService(fetchImpl)
      .listRepositoryTags('https://dev.azure.com/contoso/tools/_git/plugins');

    // One request, not eleven: the refs listing pages by an opaque continuation
    // token rather than a page number, so it asks once for the whole ceiling.
    expect(seen).toEqual([
      'https://dev.azure.com/contoso/tools/_apis/git/repositories/plugins/refs?filter=tags&$top=1000&api-version=7.1',
    ]);
    expect(tags).toEqual([
      // An ANNOTATED tag's `objectId` is the tag object, not the commit.
      { name: 'vault--v2.0.0', commitSha: 'commit-object' },
      { name: 'vault--v1.0.0', commitSha: 'lightweight-commit' },
    ]);
  });

  it('answers undefined — not an empty list — when the listing cannot be read', async () => {
    // The distinction is the contract: an empty list is an authoritative "this
    // repository tags nothing", which `:127` turns into a refusal. An
    // unreachable listing must never be reported that way.
    const failing = asFetch(async () => ({ ok: false, status: 403, async json() { return []; } }));
    expect(await createService(failing).listRepositoryTags('https://github.com/acme/vault')).toBeUndefined();

    const throwing = asFetch(async () => { throw new Error('offline'); });
    expect(await createService(throwing).listRepositoryTags('https://github.com/acme/vault')).toBeUndefined();

    // An unsupported host is also not an empty tag list.
    const unused = asFetch(async () => ({ ok: true, status: 200, async json() { return []; } }));
    expect(await createService(unused).listRepositoryTags('https://example.invalid/acme/vault')).toBeUndefined();
  });
});
