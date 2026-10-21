import { describe, expect, it } from 'bun:test';
import type { PluginManagementApi } from '../../plugins/management-types.ts';
import {
  MarketplaceService,
  MarketplaceServiceError,
  type MarketplaceRegistrySource,
} from '../service.ts';
import { SkillsMarketClient } from '../client.ts';
import type { MarketplaceCatalogItem, MarketplaceRawListResult, PluginDto } from '../types.ts';

function stubClient(items: PluginDto[]): SkillsMarketClient {
  const raw: MarketplaceRawListResult<PluginDto> = {
    items,
    page: 1,
    pageSize: 100,
    total: items.length,
    visible: items.length,
    raw: {},
  };
  return {
    async listMarketplacePlugins() { return raw; },
    async listMarketplaceSkills() { return raw; },
  } as unknown as SkillsMarketClient;
}

function registryItem(overrides: Partial<MarketplaceCatalogItem> = {}): MarketplaceCatalogItem {
  return {
    id: 'reg-1:sample-plugin',
    kind: 'plugin',
    listKind: 'plugins',
    name: 'sample-plugin',
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    raw: {},
    marketplaceRegistryId: 'reg-1',
    marketplaceRegistryLabel: 'My Registry',
    structuredInstallSource: { kind: 'url', url: 'https://example.invalid/plugins/sample-plugin' },
    ...overrides,
  };
}

describe('MarketplaceService v2 plugin boundary', () => {
  it('delegates install and activation only to the injected runtime-owned API', async () => {
    const calls: unknown[][] = [];
    const pluginService = {
      async install(...args: unknown[]) {
        calls.push(args);
        return { ok: true, diagnostics: [] };
      },
    } as unknown as PluginManagementApi;
    const service = new MarketplaceService({ pluginService });

    await service.install({
      source: { kind: 'local-path', path: '/server-owned/source' },
      activateIn: { kind: 'workspace', workspaceId: 'ws_a' },
    });

    expect(calls).toEqual([[
      { kind: 'local-path', path: '/server-owned/source' },
      { activateIn: { kind: 'workspace', workspaceId: 'ws_a' } },
    ]]);
  });

  it('fails closed when storage readiness has not injected plugin management', async () => {
    const service = new MarketplaceService();
    try {
      await service.install({ source: { kind: 'local-path', path: '/unused' } });
      throw new Error('expected install to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceServiceError);
      expect((error as MarketplaceServiceError).code).toBe('marketplace.install.unavailable');
    }
  });

  it('routes a registry catalog item to install via its pre-resolved typed source', async () => {
    const calls: unknown[][] = [];
    const pluginService = {
      async install(...args: unknown[]) {
        calls.push(args);
        return { ok: true, diagnostics: [] };
      },
    } as unknown as PluginManagementApi;
    const service = new MarketplaceService({ pluginService });

    await service.install({
      item: registryItem({
        connectorAuthTiming: 'ON_FIRST_USE',
        catalogAuthenticationPolicy: 'ON_USE',
      }),
      activateIn: { kind: 'global' },
    });

    // The typed proposal source is used directly — NO new install path or DTO
    // command re-derivation — but gains durable listing provenance so the
    // installed inventory can join back to this external marketplace row.
    expect(calls).toEqual([[
      {
        kind: 'marketplace-url',
        url: 'https://example.invalid/plugins/sample-plugin',
        marketplace: {
          marketplaceId: 'reg-1',
          itemId: 'reg-1:sample-plugin',
          listKind: 'plugins',
          itemKind: 'plugin',
          name: 'sample-plugin',
          raw: {},
        },
      },
      {
        activateIn: { kind: 'global' },
        connectorAuthTiming: 'ON_FIRST_USE',
        catalogAuthenticationPolicy: 'ON_USE',
      },
    ]]);
  });
});

describe('MarketplaceService skill content (SKILL.md preview)', () => {
  const asFetch = (impl: (url: string | URL | Request) => Promise<Response>): typeof fetch =>
    impl as unknown as typeof fetch;

  it('returns the raw SKILL.md body (frontmatter + markdown) for a market skill', async () => {
    const requested: string[] = [];
    const service = new MarketplaceService({
      marketplaceBaseUrl: 'https://market.example/api',
      fetchImpl: asFetch(async url => {
        requested.push(url.toString());
        return new Response('---\nname: demo\n---\n# Demo\nBody', { status: 200 });
      }),
    });

    const content = await service.skillContent('demo-skill');

    expect(content).toContain('# Demo');
    expect(requested).toEqual(['https://market.example/api/v1/skills/demo-skill/content']);
  });

  it('fails soft to null on an HTTP error so the renderer keeps the description', async () => {
    const service = new MarketplaceService({
      marketplaceBaseUrl: 'https://market.example/api',
      fetchImpl: asFetch(async () => new Response('nope', { status: 503 })),
    });

    expect(await service.skillContent('missing-skill')).toBeNull();
  });

  it('treats an empty/whitespace body as no content (null)', async () => {
    const service = new MarketplaceService({
      marketplaceBaseUrl: 'https://market.example/api',
      fetchImpl: asFetch(async () => new Response('   \n', { status: 200 })),
    });

    expect(await service.skillContent('blank-skill')).toBeNull();
  });
});

describe('MarketplaceService registry merge (R2)', () => {
  const skillsMarketDto: PluginDto = { id: 'sm-1', name: 'Skills Market Plugin', version: '1.0.0' };

  it('merges injected registry items into a plugins list, tagged by registry', async () => {
    const registrySource: MarketplaceRegistrySource = {
      async listItems() {
        return { items: [registryItem()] };
      },
    };
    const service = new MarketplaceService({
      client: stubClient([skillsMarketDto]),
      registrySource,
    });

    const result = await service.list({ kind: 'plugins', page: 1, pageSize: 100 });

    expect(result.items.map(item => item.id)).toEqual(['sm-1', 'reg-1:sample-plugin']);
    expect(result.items[1]?.marketplaceRegistryId).toBe('reg-1');
    expect(result.total).toBe(2);
    expect(result.visible).toBe(2);
    // No load errors → the field is omitted (additive, omit-when-empty).
    expect(result.registryLoadErrors).toBeUndefined();
  });

  it('filters registry rows by the same search query and injects them only on page one', async () => {
    const registrySource: MarketplaceRegistrySource = {
      async listItems() {
        return {
          items: [
            registryItem({ id: 'reg-1:figma', name: 'figma', description: 'Design workflows' }),
            registryItem({ id: 'reg-1:github', name: 'github', description: 'Repository workflows' }),
          ],
        };
      },
    };
    const service = new MarketplaceService({
      client: stubClient([]),
      registrySource,
    });

    const first = await service.list({ kind: 'plugins', query: 'figma', page: 1, pageSize: 100 });
    const second = await service.list({ kind: 'plugins', query: 'figma', page: 2, pageSize: 100 });

    expect(first.items.map(item => item.id)).toEqual(['reg-1:figma']);
    expect(first.total).toBe(1);
    expect(second.items).toEqual([]);
    expect(second.total).toBe(1);
  });

  it('leaves a skills list completely untouched even with a registry source injected', async () => {
    const registrySource: MarketplaceRegistrySource = {
      async listItems() {
        throw new Error('registry source must NOT be consulted for a skills list');
      },
    };
    const service = new MarketplaceService({
      client: stubClient([skillsMarketDto]),
      registrySource,
    });

    const result = await service.list({ kind: 'skills', page: 1, pageSize: 100 });

    expect(result.items).toHaveLength(1);
    expect(result.items.every(item => item.marketplaceRegistryId === undefined)).toBe(true);
    expect(result.registryLoadErrors).toBeUndefined();
  });

  it('surfaces a per-registry load error, path-free, alongside the merged items', async () => {
    const registrySource: MarketplaceRegistrySource = {
      async listItems() {
        return {
          items: [],
          loadErrors: [{
            marketplaceRegistryId: 'reg-broken',
            displayName: 'Broken Registry',
            diagnosticCodes: ['marketplace.registry.catalog_missing'],
          }],
        };
      },
    };
    const service = new MarketplaceService({
      client: stubClient([skillsMarketDto]),
      registrySource,
    });

    const result = await service.list({ kind: 'plugins', page: 1, pageSize: 100 });

    expect(result.registryLoadErrors).toEqual([{
      marketplaceRegistryId: 'reg-broken',
      displayName: 'Broken Registry',
      diagnosticCodes: ['marketplace.registry.catalog_missing'],
    }]);
    // Additive-compat: the whole result serializes to path-free JSON.
    expect(JSON.stringify(result)).not.toMatch(/\/Users|installedRoot|catalogRoot|marketplacePath/);
  });

  it('additive compatibility: a Skills-Market-only plugins list is unchanged without a registry source', async () => {
    const service = new MarketplaceService({ client: stubClient([skillsMarketDto]) });

    const result = await service.list({ kind: 'plugins', page: 1, pageSize: 100 });

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.registryLoadErrors).toBeUndefined();
    expect(result.items[0]).not.toHaveProperty('marketplaceRegistryId');
  });
});
