// [nessy-fork] desktop-skill-marketplace-install-state
import { describe, expect, it, mock } from 'bun:test';
import { createInternalMarketplaceClient } from './internal-marketplace';
import type { PlatformFetch } from '../runtime/platform';

describe('createInternalMarketplaceClient', () => {
  it('requests the internal marketplace without authorization', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(
        JSON.stringify([
          {
            id: 'bailian-cli',
            skill_url: 'https://example.test/bailian-cli',
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const { items } = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://skills-market.t-tech.team/api/v1/skills?page=1&pageSize=100&sort=installs&withDescription=true',
    );
    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit).toEqual({
      headers: {
        Accept: 'application/json',
      },
      signal: expect.any(AbortSignal),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'bailian-cli' });
  });

  it('maps skills without an API id', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(
        JSON.stringify([
          {
            repo_url: 'https://gitlab.example.test/team/skills',
            skillId: 'skl_v1_whiteboard',
            folder_name: 'whiteboard',
            tenant: 'team',
            skill_url:
              'https://gitlab.example.test/team/skills/-/blob/master/skills/whiteboard/SKILL.md',
            name: 'whiteboard',
            description: 'Draw diagrams',
            install: {
              command:
                'dp skills install https://skills-market.t-tech.team/#artifact/skill%3Ahttps%3A%2F%2Fgitlab.example.test%2Fteam%2Fskills%2F-%2Fblob%2Fmaster%2Fskills%2Fwhiteboard%2FSKILL.md',
            },
          },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const { items: skills } = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills();

    expect(skills[0]).toMatchObject({
      id: 'https://gitlab.example.test/team/skills/-/blob/master/skills/whiteboard/SKILL.md',
      slug: 'whiteboard',
      name: 'whiteboard',
      // The market wrapper link is unwrapped — `dp` rejects it as an
      // unsupported source.
      sourceUrl:
        'https://gitlab.example.test/team/skills/-/blob/master/skills/whiteboard/SKILL.md',
      detailsId: 'skl_v1_whiteboard',
    });
  });

  it('drops scope flags when reading the install command', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(
        JSON.stringify([
          {
            legacySlug: 'team__skills__whiteboard',
            folder_name: 'whiteboard',
            install: {
              commands: {
                user: 'dp skills install team/whiteboard --agent nessy --global',
                workspace:
                  'dp skills install team/whiteboard --agent nessy --project',
              },
              command:
                'dp skills install team/whiteboard --agent nessy --global',
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { items: skills } = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills();

    expect(skills[0]).toMatchObject({ sourceUrl: 'team/whiteboard' });
  });

  it('falls back to the direct source when only a market link is offered', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(
        JSON.stringify([
          {
            legacySlug: 'team__skills__whiteboard',
            folder_name: 'whiteboard',
            install: {
              command:
                'dp skills install https://skills-market.t-tech.team/#artifact/broken',
              fallback: {
                command:
                  'dp skills install https://gitlab.example.test/team/skills/-/blob/master/skills/whiteboard/SKILL.md --agent nessy --global',
              },
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { items: skills } = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills();

    expect(skills[0]).toMatchObject({
      sourceUrl:
        'https://gitlab.example.test/team/skills/-/blob/master/skills/whiteboard/SKILL.md',
    });
  });

  it('loads the canonical registry address by skill id', async () => {
    const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes('/v1/skills?')) {
        return new Response(
          JSON.stringify([
            {
              legacySlug: 'hwaas__nmsgo__jira',
              skillId: 'skl_v1_jira',
              tenant: 'hwaas',
              folder_name: 'jira',
              name: 'jira',
              skill_url: 'https://example.test/jira/SKILL.md',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      expect(url).toBe(
        'https://skills-market.t-tech.team/api/v2/registry/entries/agent-skill/skl_v1_jira',
      );
      return new Response(
        JSON.stringify({
          address: { canonical: 'hwaas/jira-1' },
          display: { name: 'jira' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const skill = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).getSkill('hwaas__nmsgo__jira');

    expect(skill).toMatchObject({
      slug: 'jira',
      detailsId: 'skl_v1_jira',
      installSource: 'hwaas/jira-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('installs a skill outside the first catalog page via its registry entry', async () => {
    const requested: string[] = [];
    const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      requested.push(url);
      if (url.includes('/v2/registry/entries/agent-skill/')) {
        return new Response(
          JSON.stringify({
            address: {
              owner: 'sme-leasing',
              name: 'adding-new-idea',
              canonical: 'sme-leasing/adding-new-idea',
            },
            display: { name: 'adding-new-idea', description: 'Ideas' },
            agentSkill: { canonicalName: 'adding-new-idea' },
            delivery: { installable: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const skill = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).getSkill('sme-leasing__ai-tools__adding-new-idea', 'skl_v1_idea');

    // Neither the capped listing nor `/v1/skills/{legacySlug}` (404 for
    // unlisted skills) is consulted when the catalog id is known.
    expect(requested).toHaveLength(1);
    expect(skill).toMatchObject({
      id: 'sme-leasing__ai-tools__adding-new-idea',
      slug: 'adding-new-idea',
      name: 'adding-new-idea',
      installSource: 'sme-leasing/adding-new-idea',
      detailsId: 'skl_v1_idea',
    });
  });

  it('searches by folder segment when the skill is not on the first page', async () => {
    const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes('q=adding-new-idea')) {
        return new Response(
          JSON.stringify([
            {
              legacySlug: 'sme-leasing__ai-tools__adding-new-idea',
              skillId: 'skl_v1_idea',
              folder_name: 'adding-new-idea',
              name: 'adding-new-idea',
              skill_url: 'https://gitlab.example.test/idea/SKILL.md',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v1/skills?')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ address: { canonical: 'sme-leasing/adding-new-idea' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const skill = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).getSkill('sme-leasing__ai-tools__adding-new-idea');

    expect(skill).toMatchObject({
      slug: 'adding-new-idea',
      installSource: 'sme-leasing/adding-new-idea',
    });
  });

  it('loads details directly by catalog skill id', async () => {
    const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
      expect(String(args[0])).toBe(
        'https://skills-market.t-tech.team/api/v2/skills/skl_v1_search_all',
      );
      return new Response(
        JSON.stringify({
          skillId: 'skl_v1_search_all',
          author: 'developer',
          source: {
            tenant: 'team',
            repositoryPath: 'team/repository',
            repositoryUrl: 'https://gitlab.example.test/team/repository',
            skillPath: '.nessy/skills/search-all',
          },
          install: { command: 'dp skills install team/search-all' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const details = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).getSkillDetails('skl_v1_search_all');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(details).toMatchObject({
      tenant: 'team',
      author: 'developer',
      installCommand: 'dp skills install team/search-all',
    });
  });

  it('returns paginated result structure', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(
        JSON.stringify([
          { id: 'skill-1', skill_url: 'https://example.test/1' },
          { id: 'skill-2', skill_url: 'https://example.test/2' },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-total-count': '42',
          },
        },
      );
    });

    const result = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills({ page: 2, pageSize: 10 });

    expect(result).toMatchObject({
      items: [{ id: 'skill-1' }, { id: 'skill-2' }],
      total: 42,
      page: 2,
      pageSize: 10,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('page=2');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('pageSize=10');
  });

  it('passes query parameter when provided', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills({ query: 'whiteboard' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=whiteboard');
  });

  it('caches list results within TTL', async () => {
    let callCount = 0;
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      callCount += 1;
      return new Response(
        JSON.stringify([
          { id: 'cached-skill', skill_url: 'https://example.test/cached' },
        ]),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const client = createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    });

    const first = await client.listSkills();
    const second = await client.listSkills();

    expect(callCount).toBe(1);
    expect(first.items).toEqual(second.items);
  });

  it('uses AbortSignal timeout on requests', async () => {
    const fetchMock = mock(async (...args: Parameters<typeof fetch>) => {
      const init = args[1];
      expect(init).toBeDefined();
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listSkills();

    expect(fetchMock).toHaveBeenCalled();
  });

  it('validates response body is an array or object', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response('null', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      createInternalMarketplaceClient({
        fetch: fetchMock as unknown as PlatformFetch,
      }).listSkills(),
    ).rejects.toThrow('unexpected response format');
  });

  it('listExtensions returns paginated result', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(
        JSON.stringify({
          total: 42,
          plugins: [
            {
              id: 'ext-1',
              name: 'Extension 1',
              description: 'Test extension',
              version: '1.0.0',
              path: 'npm:@scope/ext-1',
              install: { command: 'nessy extensions install npm:@scope/ext-1' },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });

    const result = await createInternalMarketplaceClient({
      fetch: fetchMock as unknown as PlatformFetch,
    }).listExtensions({ query: 'ext' });

    expect(result).toMatchObject({
      items: [{ id: 'ext-1', name: 'Extension 1' }],
      total: 42,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('q=ext');
  });

  it('throws on non-ok response', async () => {
    const fetchMock = mock(async (..._args: Parameters<typeof fetch>) => {
      return new Response(null, {
        status: 500,
        statusText: 'Internal Server Error',
      });
    });

    await expect(
      createInternalMarketplaceClient({
        fetch: fetchMock as unknown as PlatformFetch,
      }).listSkills(),
    ).rejects.toThrow('Internal marketplace request failed: 500');
  });
});
