/**
 * D2 — one resolver for both install channels.
 *
 * The agent's `plugin_plan_install` used to go straight to the Skills Market
 * client, so every bring-your-own registry id (`<registryId>:<name>`) 404'd
 * against a catalog that never held it.
 */
import { describe, expect, it } from 'bun:test';
import { resolveMarketplaceListingItem, splitListingId, SAFE_MARKETPLACE_ID } from '../listing-resolution.ts';
import type { MarketplaceCatalogItem } from '../types.ts';

function item(id: string, marketplaceRegistryId?: string): MarketplaceCatalogItem {
  return {
    id,
    kind: 'plugin',
    listKind: 'plugins',
    name: id.split(':').pop()!,
    icon: { kind: 'symbol', name: 'plugin' },
    capabilities: [],
    install: { sourceConfidence: 'primary' },
    raw: {},
    ...(marketplaceRegistryId ? { marketplaceRegistryId } : {}),
  } as MarketplaceCatalogItem;
}

function deps(options: { cached?: MarketplaceCatalogItem[]; onInspect?: () => void } = {}) {
  const inspected: string[] = [];
  const looked: Array<[string, string]> = [];
  return {
    inspected,
    looked,
    deps: {
      inspect: async (request: { id: string; kind: 'plugins' | 'skills' }) => {
        inspected.push(request.id);
        options.onInspect?.();
        return { item: item(request.id) };
      },
      catalogReader: {
        async peekCachedItems() { return options.cached ?? []; },
        async findCatalogItem(marketplaceRegistryId: string, itemId: string) {
          looked.push([marketplaceRegistryId, itemId]);
          return (options.cached ?? []).find(
            row => row.marketplaceRegistryId === marketplaceRegistryId && row.id === itemId,
          );
        },
      },
    },
  };
}

describe('splitListingId', () => {
  it('splits a registry-qualified id and refuses the shapes that are not one', () => {
    expect(splitListingId('acme:widgets')).toEqual({ marketplaceId: 'acme', rest: 'widgets' });
    expect(splitListingId('acme:sub:widgets')).toEqual({ marketplaceId: 'acme', rest: 'sub:widgets' });
    expect(splitListingId('widgets')).toBeUndefined();
    expect(splitListingId(':widgets')).toBeUndefined();
    expect(splitListingId('acme:')).toBeUndefined();
  });
});

describe('resolveMarketplaceListingItem', () => {
  it('resolves a BYO registry id from the cached catalog, never through inspect', async () => {
    const rig = deps({ cached: [item('acme:widgets', 'acme')] });

    const resolved = await resolveMarketplaceListingItem({ itemId: 'acme:widgets', kind: 'plugins' }, rig.deps);

    expect(resolved?.id).toBe('acme:widgets');
    expect(rig.looked).toEqual([['acme', 'acme:widgets']]);
    // The whole bug: this id must never reach the Skills Market client.
    expect(rig.inspected).toEqual([]);
  });

  it('keeps Skills-Market ids on the inspect path', async () => {
    const rig = deps({ cached: [item('acme:widgets', 'acme')] });

    const resolved = await resolveMarketplaceListingItem({ itemId: 'plain-widget', kind: 'plugins' }, rig.deps);

    expect(resolved?.id).toBe('plain-widget');
    expect(rig.inspected).toEqual(['plain-widget']);
    expect(rig.looked).toEqual([]);
  });

  it('treats the built-in marketplace id as Skills Market even when passed explicitly', async () => {
    const rig = deps();

    await resolveMarketplaceListingItem(
      { itemId: 'widgets', kind: 'plugins', marketplaceId: SAFE_MARKETPLACE_ID },
      rig.deps,
    );

    expect(rig.inspected).toEqual(['widgets']);
    expect(rig.looked).toEqual([]);
  });

  it('reports a miss for an explicit registry rather than asking the Skills Market about it', async () => {
    const rig = deps({ cached: [] });

    const resolved = await resolveMarketplaceListingItem(
      { itemId: 'acme:missing', kind: 'plugins', marketplaceId: 'acme' },
      rig.deps,
    );

    expect(resolved).toBeUndefined();
    expect(rig.inspected).toEqual([]);
  });

  it('falls back to inspect when a colon-shaped id belongs to no configured registry', async () => {
    // An inferred prefix is a guess; a Skills Market id may legitimately carry
    // a colon, so a cache miss on a GUESSED registry still tries inspect.
    const rig = deps({ cached: [] });

    const resolved = await resolveMarketplaceListingItem({ itemId: 'weird:id', kind: 'plugins' }, rig.deps);

    expect(resolved?.id).toBe('weird:id');
    expect(rig.inspected).toEqual(['weird:id']);
  });

  it('works with a reader that has no findCatalogItem (the narrow probe reader)', async () => {
    const resolved = await resolveMarketplaceListingItem(
      { itemId: 'acme:widgets', kind: 'plugins' },
      { inspect: async request => ({ item: item(request.id) }), catalogReader: { async peekCachedItems() { return []; } } },
    );

    expect(resolved?.id).toBe('acme:widgets');
  });
});

/**
 * P6.421 — `plugins/install.md#install-a-plugin`, verbatim: "**With a
 * marketplace name**: when you install `plugin-name@marketplace-name`, in a
 * session or with `claude plugin install`, Claude Code refreshes that
 * marketplace before the lookup." Its sibling form, "**Plugin name only**",
 * "reads the cached catalogs without refreshing" — which is why the hook fires
 * for a NAMED marketplace and not for one merely inferred from an id prefix.
 */
describe('resolveMarketplaceListingItem — the refresh ahead of a named install', () => {
  it('refreshes the NAMED marketplace before the cache lookup, and in that order', async () => {
    const rig = deps({ cached: [item('acme:widgets', 'acme')] });
    const order: string[] = [];

    const resolved = await resolveMarketplaceListingItem(
      { itemId: 'acme:widgets', kind: 'plugins', marketplaceId: 'acme' },
      {
        ...rig.deps,
        catalogReader: {
          ...rig.deps.catalogReader,
          async findCatalogItem(marketplaceRegistryId: string, itemId: string) {
            order.push('lookup');
            return rig.deps.catalogReader.findCatalogItem(marketplaceRegistryId, itemId);
          },
        },
        refreshMarketplace: async (marketplaceId: string) => { order.push(`refresh:${marketplaceId}`); },
      },
    );

    expect(resolved?.id).toBe('acme:widgets');
    // "before the lookup" is the whole contract — a refresh after it buys nothing.
    expect(order).toEqual(['refresh:acme', 'lookup']);
  });

  it('does NOT refresh when the marketplace was only inferred from the id prefix', async () => {
    const rig = deps({ cached: [item('acme:widgets', 'acme')] });
    const refreshed: string[] = [];

    const resolved = await resolveMarketplaceListingItem(
      { itemId: 'acme:widgets', kind: 'plugins' },
      { ...rig.deps, refreshMarketplace: async (id: string) => { refreshed.push(id); } },
    );

    expect(resolved?.id).toBe('acme:widgets');
    // The page's "Plugin name only" form reads the cached catalogs without
    // refreshing, so browse and the agent's planner cost nothing new.
    expect(refreshed).toEqual([]);
  });

  it('resolves from the cached catalog anyway when the refresh reports a failure', async () => {
    // "If the refresh before a named install fails, for example because you're
    // offline, Claude Code looks the plugin up in the cached catalog anyway."
    const rig = deps({ cached: [item('acme:widgets', 'acme')] });

    const resolved = await resolveMarketplaceListingItem(
      { itemId: 'acme:widgets', kind: 'plugins', marketplaceId: 'acme' },
      { ...rig.deps, refreshMarketplace: async () => ({ marketplaceId: 'acme', upgraded: false, reason: 'fetch-failed' }) },
    );

    expect(resolved?.id).toBe('acme:widgets');
  });

  it('lets a managed refusal from the refresh escape, because it also refuses the install', async () => {
    // "Managed settings block the marketplace, in which case Claude Code also
    // refuses the install."
    const rig = deps({ cached: [item('acme:widgets', 'acme')] });

    await expect(resolveMarketplaceListingItem(
      { itemId: 'acme:widgets', kind: 'plugins', marketplaceId: 'acme' },
      { ...rig.deps, refreshMarketplace: async () => { throw new Error('not permitted by your organization'); } },
    )).rejects.toThrow('not permitted');
  });

  it('leaves the built-in Skills Market alone — it is not a refreshable registry', async () => {
    const rig = deps({ cached: [] });
    const refreshed: string[] = [];

    await resolveMarketplaceListingItem(
      { itemId: 'widgets', kind: 'plugins', marketplaceId: SAFE_MARKETPLACE_ID },
      { ...rig.deps, refreshMarketplace: async (id: string) => { refreshed.push(id); } },
    );

    expect(refreshed).toEqual([]);
    expect(rig.inspected).toEqual(['widgets']);
  });
});
