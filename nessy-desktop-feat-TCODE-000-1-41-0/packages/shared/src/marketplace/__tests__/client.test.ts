import { describe, expect, it } from 'bun:test';
import {
  MarketplaceClientError,
  SkillsMarketClient,
} from '../client.ts';

describe('SkillsMarketClient', () => {
  it('reads marketplace meta', async () => {
    const fetchImpl = jsonFetch({
      generated_at: '2026-07-08T17:50:30',
      skills_count: 2449,
      extensions_count: 72,
      etag: '"35fcb7e42d5a92d91df851b0ff209da68fd31e2e"',
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const meta = await client.getMarketplaceMeta();

    expect(meta.skills_count).toBe(2449);
    expect(meta.extensions_count).toBe(72);
    expect(meta.generated_at).toBe('2026-07-08T17:50:30');
  });

  it('lists skills using X-Total-Count and preserves request pagination', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return new Response(JSON.stringify([
        skillDto('skill-one'),
        skillDto('skill-two'),
      ]), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-total-count': '2449',
        },
      });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api/', fetchImpl });

    const result = await client.listMarketplaceSkills({
      query: 'review',
      page: 2,
      pageSize: 250,
      sort: 'name',
    });

    expect(requestedUrls).toEqual([
      'https://market.example/api/v1/skills?q=review&page=2&pageSize=100&sort=name',
    ]);
    expect(result.items.map(item => item.id)).toEqual(['skill-one', 'skill-two']);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(100);
    expect(result.total).toBe(2449);
    expect(result.visible).toBe(2);
    expect(result.nextPage).toBe(3);
  });

  it('lists plugins using the response total and plugin body shape', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return Response.json({
        total: 72,
        page: 1,
        pageSize: 100,
        plugins: [
          pluginDto('plugin-one'),
          pluginDto('plugin-two'),
        ],
      });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const result = await client.listMarketplacePlugins({
      pageSize: 500,
      capabilities: ['mcp', 'hook'],
      sort: 'installs',
    });

    expect(requestedUrls).toEqual([
      'https://market.example/api/v1/plugins?page=1&pageSize=100&sort=installs&kind=nessy-extension&capabilities=mcp%2Chook',
    ]);
    expect(result.items.map(item => item.id)).toEqual(['plugin-one', 'plugin-two']);
    expect(result.total).toBe(72);
    expect(result.visible).toBe(2);
    expect(result.nextPage).toBeUndefined();
  });

  // F1. `nessy-marketplace-api` v1.0 declares `profession`, `tag` and `tenant`
  // as plain repeated parameters and has no `phase` parameter at all. Measured
  // live 2026-07-31: `tenant[]=github-mirror` -> 6084 (unfiltered), plain
  // `tenant=github-mirror` -> 1062.
  it('sends skill filters under the parameter names the server reads', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return Response.json([skillDto('skill-one')], { headers: { 'x-total-count': '1' } });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await client.listMarketplaceSkills({
      tenants: ['github-mirror', 't-skills'],
      tags: ['python'],
      professions: ['Office Productivity'],
      domain: 'engineering',
      withDescription: true,
      phases: ['production'],
    });

    const url = new URL(requestedUrls[0] ?? '');
    expect(url.searchParams.getAll('tenant')).toEqual(['github-mirror', 't-skills']);
    expect(url.searchParams.getAll('tag')).toEqual(['python']);
    expect(url.searchParams.getAll('profession')).toEqual(['Office Productivity']);
    expect(url.searchParams.get('domain')).toBe('engineering');
    expect(url.searchParams.get('withDescription')).toBe('true');
    // Negative arm: the bracketed spellings the server ignores, and the `phase`
    // filter it does not implement, must not reach the wire.
    expect(url.searchParams.getAll('tenant[]')).toEqual([]);
    expect(url.searchParams.getAll('profession[]')).toEqual([]);
    expect(url.searchParams.getAll('phase[]')).toEqual([]);
    expect(url.searchParams.getAll('phase')).toEqual([]);
  });

  it('reads the skill filter vocabulary and drops malformed facet options', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return Response.json({
        tenants: [{ value: 'github-mirror', title: 'github-mirror', count: 1062 }],
        tags: [{ value: 'python', count: 34 }, { title: 'no value' }, 'not-an-object'],
        professions: [{ value: 'Office Productivity', title: 'Office Productivity', count: 21 }],
      });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const facets = await client.getMarketplaceSkillFacets();

    expect(requestedUrls).toEqual(['https://market.example/api/v1/skills/facets']);
    expect(facets.tenants).toEqual([{ value: 'github-mirror', title: 'github-mirror', count: 1062 }]);
    // A facet option with no `value` cannot be sent back as a filter, so it is
    // dropped; a missing `title` falls back to the value.
    expect(facets.tags).toEqual([{ value: 'python', title: 'python', count: 34 }]);
    expect(facets.professions.map(option => option.value)).toEqual(['Office Productivity']);
  });

  // F2. Shape and numbers recorded from the live catalog on 2026-07-31: a
  // `limit=50` page answered 50 groups over 57 variants, and the whole catalog
  // reports totalGroups 3914 / totalEntries 5341.
  it('lists one registry row per variant cluster, not one per entry', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return Response.json({
        generationId: 'reg_v2_4c57dfe3',
        totalGroups: 3914,
        totalEntries: 5341,
        nextCursor: 'eyJzY2hlbWFWZXJzaW9uIjoi',
        facets: { tags: [{ value: 'python', title: 'python', count: 34 }], tenants: [], professions: [], domains: [] },
        items: [
          registryGroupDto('whiteboard', ['skl_v1_aaa', 'skl_v1_bbb']),
          registryGroupDto('1on1-prepare', ['skl_v1_ccc']),
          // Unusable rows: no variants at all, and no display name.
          { groupId: 'grp_empty', display: { name: 'empty' }, defaultVariantId: 'skl_v1_ddd', variants: [] },
          { groupId: 'grp_nameless', display: {}, defaultVariantId: 'skl_v1_eee', variants: [{ registryId: 'skl_v1_eee' }] },
        ],
      });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const page = await client.listSkillsRegistryCatalog({ limit: 500, tags: ['python'] });

    const url = new URL(requestedUrls[0] ?? '');
    expect(url.pathname).toBe('/api/v2/registry/catalog');
    expect(url.searchParams.get('kind')).toBe('agent-skill');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('pageSize')).toBeNull();
    expect(url.searchParams.getAll('tag')).toEqual(['python']);
    // One browse row per group, and the group carries its duplicates.
    expect(page.groups.map(group => group.name)).toEqual(['whiteboard', '1on1-prepare']);
    expect(page.groups.flatMap(group => group.variants).length).toBe(3);
    expect(page.groups[0]?.variants.map(variant => variant.registryId)).toEqual(['skl_v1_aaa', 'skl_v1_bbb']);
    expect(page.groups[0]?.variants[0]?.installable).toBe(true);
    expect(page.groups[0]?.variants[0]?.canonicalAddress).toBe('t-skills/whiteboard');
    // The deduplicated row count is the server's, not the entry count.
    expect(page.totalGroups).toBe(3914);
    expect(page.totalEntries).toBe(5341);
    expect(page.nextCursor).toBe('eyJzY2hlbWFWZXJzaW9uIjoi');
    expect(page.facets.tags.map(option => option.value)).toEqual(['python']);
  });

  it('rejects a registry catalog response with no items array', async () => {
    const fetchImpl = jsonFetch({ generationId: 'reg_v2_4c57dfe3', totalGroups: 3914 });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await expect(client.listSkillsRegistryCatalog()).rejects.toMatchObject({
      code: 'invalid-response',
      endpoint: '/v2/registry/catalog',
    });
  });

  // F3. Payload shape recorded live from
  // /v2/skills/skl_v1_225cfdef…/releases/latest on 2026-07-31.
  it('reads the immutable snapshot identity a skill install must record', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return Response.json(latestReleaseDto());
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const snapshot = await client.getMarketplaceSkillSnapshot('skl_v1_225cfdef');

    expect(requestedUrls).toEqual(['https://market.example/api/v2/skills/skl_v1_225cfdef/releases/latest']);
    expect(snapshot.snapshotId).toBe('snp_v1_dad30e45');
    expect(snapshot.artifactId).toBe('art_v1_7a5274e5');
    expect(snapshot.contentDigest).toBe('sha256:dad30e45');
    expect(snapshot.sourceCommit).toBe('3123b04834ac645441d52a44e991de451919fbdf');
    expect(snapshot.archive).toEqual({
      digest: 'sha256:7a5274e5',
      downloadPath: '/v2/skills/skl_v1_225cfdef/artifacts/art_v1_7a5274e5/download',
      size: 84899,
      mediaType: 'application/zip',
    });
  });

  it('refuses a release response with no snapshot id rather than recording a partial identity', async () => {
    const { snapshotId: _dropped, ...withoutSnapshot } = latestReleaseDto();
    const fetchImpl = jsonFetch({ ...withoutSnapshot, artifact: { artifactId: 'art_v1_7a5274e5' } });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await expect(client.getMarketplaceSkillSnapshot('skl_v1_225cfdef')).rejects.toMatchObject({
      code: 'invalid-response',
      endpoint: '/v2/skills/skl_v1_225cfdef/releases/latest',
    });
  });

  it('reads skill and plugin details by id', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      if (url.toString().endsWith('/skills/skill-one')) {
        return Response.json(skillDto('skill-one'));
      }
      return Response.json(pluginDto('plugin-one'));
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const skill = await client.getMarketplaceSkill('skill-one');
    const plugin = await client.getMarketplacePlugin('plugin-one');

    expect(skill.id).toBe('skill-one');
    expect(plugin.id).toBe('plugin-one');
    expect(requestedUrls).toEqual([
      'https://market.example/api/v1/skills/skill-one',
      'https://market.example/api/v1/plugins/plugin-one',
    ]);
  });

  // F4. `/v1/skills/{id}/archive.zip` serves the whole tree anonymously in one
  // request. Measured live 2026-07-31: HTTP 200, application/zip, 84899 bytes,
  // and the ETag equals the sha256 of the body.
  it('fetches a skill tree in one request and checks the digest it was told to expect', async () => {
    const body = new TextEncoder().encode('PK pretend archive');
    const digest = await sha256Of(body);
    const requestedUrls: string[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request) => {
      requestedUrls.push(url.toString());
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          etag: `"${digest}"`,
          'x-skill-snapshot-id': 'snp_v1_dad30e45',
          'x-skill-artifact-id': 'art_v1_7a5274e5',
        },
      });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const archive = await client.downloadMarketplaceSkillArchive('skl_v1_225cfdef', {
      expectedDigest: `sha256:${digest}`,
    });

    // One request replaces the listing plus one request per file.
    expect(requestedUrls).toEqual(['https://market.example/api/v1/skills/skl_v1_225cfdef/archive.zip']);
    expect(archive.bytes.byteLength).toBe(body.byteLength);
    expect(archive.digest).toBe(digest);
    expect(archive.advertisedDigest).toBe(digest);
    expect(archive.snapshotId).toBe('snp_v1_dad30e45');
    expect(archive.artifactId).toBe('art_v1_7a5274e5');
  });

  it('refuses archive bytes that do not match the independently fetched digest', async () => {
    const body = new TextEncoder().encode('PK substituted archive');
    const digest = await sha256Of(body);
    const fetchImpl = asFetch(async () => new Response(body, {
      status: 200,
      // The server's own ETag agrees with the body it served — only the digest
      // fetched separately (from the release endpoint) catches the substitution.
      headers: { 'content-type': 'application/zip', etag: `"${digest}"` },
    }));
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await expect(client.downloadMarketplaceSkillArchive('skl_v1_225cfdef', {
      expectedDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    })).rejects.toMatchObject({
      code: 'digest-mismatch',
      endpoint: '/v1/skills/skl_v1_225cfdef/archive.zip',
    });
  });

  // F5. POST /v2/registry/entries/{kind}/{id}/installations takes no request
  // body and is bearer-authenticated; measured 2026-07-31 an anonymous POST
  // answers HTTP 401 without counting anything.
  it('reports one install with a bearer header, no body and nothing in the URL', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = asFetch(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url.toString(), ...(init ? { init } : {}) });
      return Response.json({ counted: true, installCount: 489 }, { status: 201 });
    });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    const receipt = await client.reportSkillsRegistryInstallation({
      id: 'skl_v1_225cfdef',
      accessToken: 'jwt-value',
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(
      'https://market.example/api/v2/registry/entries/agent-skill/skl_v1_225cfdef/installations',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    // Nothing beyond what the endpoint requires: no body, and the token is a
    // header rather than any part of the URL.
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(calls[0]?.url).not.toContain('jwt-value');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-value');
    expect(receipt).toEqual({ counted: true, installCount: 489 });
  });

  it('never fails an install because the marketplace counter refused or was unreachable', async () => {
    const unauthorized = new SkillsMarketClient({
      baseUrl: 'https://market.example/api',
      fetchImpl: asFetch(async () => Response.json({ statusCode: 401 }, { status: 401 })),
    });
    const offline = new SkillsMarketClient({
      baseUrl: 'https://market.example/api',
      fetchImpl: asFetch(async () => { throw new Error('offline'); }),
    });

    expect(await unauthorized.reportSkillsRegistryInstallation({ id: 'skl_v1_225cfdef' })).toBeNull();
    expect(await offline.reportSkillsRegistryInstallation({ id: 'skl_v1_225cfdef' })).toBeNull();
  });

  it('throws typed errors that include the endpoint and HTTP status', async () => {
    const fetchImpl = asFetch(async () => new Response('unavailable', { status: 503 }));
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await expect(client.listMarketplaceSkills()).rejects.toMatchObject({
      name: 'MarketplaceClientError',
      code: 'http-error',
      endpoint: '/v1/skills',
      status: 503,
    });
  });

  it('throws typed errors for invalid JSON payloads', async () => {
    const fetchImpl = asFetch(async () => new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await expect(client.getMarketplaceMeta()).rejects.toBeInstanceOf(MarketplaceClientError);
    await expect(client.getMarketplaceMeta()).rejects.toMatchObject({
      code: 'invalid-json',
      endpoint: '/v1/meta',
    });
  });

  it('rejects missing list payloads with a typed client error', async () => {
    const fetchImpl = jsonFetch({ ok: true });
    const client = new SkillsMarketClient({ baseUrl: 'https://market.example/api', fetchImpl });

    await expect(client.listMarketplaceSkills()).rejects.toMatchObject({
      code: 'invalid-response',
      endpoint: '/v1/skills',
    });
  });
});

function jsonFetch(payload: unknown, headers: Record<string, string> = {}): typeof fetch {
  return asFetch(async () => Response.json(payload, { headers }));
}

function asFetch(fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<unknown>): typeof fetch {
  return fetchImpl as unknown as typeof fetch;
}

function skillDto(id: string) {
  return {
    id,
    name: `Skill ${id}`,
    description: 'A useful skill',
    tenant: 'ai-office',
    repo_path: 'group/repo',
    repo_url: 'https://gitlab.example.com/group/repo',
    folder_name: id,
    skill_path: `skills/${id}/SKILL.md`,
    install: {
      source: {
        type: 'npm',
        package: `@scope/${id}`,
        version: '1.0.0',
        registry: 'https://registry.example.com',
      },
    },
  };
}

async function sha256Of(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

function latestReleaseDto() {
  return {
    skillId: 'skl_v1_225cfdef',
    sourceId: 'src_v1_d6e73403',
    snapshotId: 'snp_v1_dad30e45',
    artifactId: 'art_v1_7a5274e5',
    sourceCommit: '3123b04834ac645441d52a44e991de451919fbdf',
    sourceCommittedAt: '2026-04-28T14:19:24.000+00:00',
    artifact: {
      type: 'skill-artifact',
      skillId: 'skl_v1_225cfdef',
      sourceId: 'src_v1_d6e73403',
      snapshotId: 'snp_v1_dad30e45',
      artifactId: 'art_v1_7a5274e5',
      contentDigest: 'sha256:dad30e45',
      lifecycle: 'active',
      singleFile: false,
      filesPath: '/v2/skills/skl_v1_225cfdef/snapshots/snp_v1_dad30e45/files',
      archive: {
        digest: 'sha256:7a5274e5',
        size: 84899,
        mediaType: 'application/zip',
        downloadPath: '/v2/skills/skl_v1_225cfdef/artifacts/art_v1_7a5274e5/download',
      },
    },
  };
}

function registryGroupDto(name: string, registryIds: string[]) {
  return {
    groupId: `grp_v1_${name}`,
    display: { name, description: `The ${name} skill`, author: 'd.sin' },
    defaultVariantId: registryIds[0],
    metrics: { install_count: 488 },
    variants: registryIds.map(registryId => ({
      registryId,
      entry: {
        kind: 'agent-skill',
        id: registryId,
        address: { owner: 't-skills', name, canonical: `t-skills/${name}` },
        display: { name, description: `The ${name} skill` },
        delivery: { installable: true, installCommand: `dp skills install t-skills/${name}` },
      },
      metadata: { tags: [], professions: [] },
    })),
  };
}

function pluginDto(id: string) {
  return {
    id,
    kind: 'nessy-extension',
    name: `Plugin ${id}`,
    description: 'A useful plugin',
    version: '1.0.0',
    path: `https://gitlab.example.com/plugins/${id}`,
    capabilities: ['mcp'],
    install: {
      command: `nessy plugin install ${id}`,
    },
  };
}
