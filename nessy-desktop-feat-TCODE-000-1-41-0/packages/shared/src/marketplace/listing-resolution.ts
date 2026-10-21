import type { CachedMarketplaceCatalogReader } from './registry-source.ts';
import type { MarketplaceCatalogItem } from './types.ts';

/**
 * The built-in marketplace's id. Everything else is a bring-your-own registry
 * whose listings live in the local catalog, not behind the Skills Market HTTP
 * client — asking that client for one is how a BYO listing 404s.
 */
export const SAFE_MARKETPLACE_ID = 'skills-market';

export interface ListingResolutionDeps {
  /** Skills Market lookup — the only path that may reach the network. */
  inspect: (request: { id: string; kind: 'plugins' | 'skills' }) => Promise<{ item: MarketplaceCatalogItem }>;
  /**
   * Cache-only reader for BYO registries. Omitted — or wired without
   * `findCatalogItem`, which the narrower update-availability probe does —
   * simply means BYO ids stay unresolvable, which is the honest answer rather
   * than a Skills Market 404 wearing a confusing message.
   */
  catalogReader?: CachedMarketplaceCatalogReader;
  /**
   * P6.421. Refresh the named marketplace's catalog BEFORE the lookup, per
   * `plugins/install.md#install-a-plugin`: "when you install
   * `plugin-name@marketplace-name`, in a session or with `claude plugin
   * install`, Claude Code refreshes that marketplace before the lookup."
   *
   * Wired only on the INSTALL path, and only ever called for an EXPLICIT
   * marketplace id — which is precisely the page's "with a marketplace name"
   * form. The page's other form, "plugin name only", "reads the cached catalogs
   * without refreshing", and that is what an omitted hook (or an id whose
   * marketplace was merely inferred from its `<marketplaceId>:<name>` prefix)
   * keeps doing. So browse, the per-turn update probe and the agent's planner
   * cost nothing new.
   *
   * MUST NOT throw for an ordinary fetch failure: "if the refresh before a
   * named install fails, for example because you're offline, Claude Code looks
   * the plugin up in the cached catalog anyway." A managed refusal DOES throw
   * from the registry source, and the same paragraph wants that — "Managed
   * settings block the marketplace, in which case Claude Code also refuses the
   * install" — so this call is deliberately NOT wrapped in a catch.
   */
  refreshMarketplace?: (marketplaceId: string) => Promise<unknown>;
}

/** Split `<registryId>:<name>` into its halves; `undefined` when it is not that shape. */
export function splitListingId(itemId: string): { marketplaceId: string; rest: string } | undefined {
  const colon = itemId.indexOf(':');
  if (colon <= 0 || colon === itemId.length - 1) return undefined;
  return { marketplaceId: itemId.slice(0, colon), rest: itemId.slice(colon + 1) };
}

/**
 * Resolve one listing id to its catalog item, from whichever catalog owns it.
 *
 * Shared because the UI channel and the agent's `plugin_plan_install` were
 * resolving listings differently: the UI already fell back to the local
 * registry catalog, the agent went straight to `inspect` and 404'd on every
 * `<registryId>:<name>` id. One resolver, two callers.
 */
export async function resolveMarketplaceListingItem(
  args: { itemId: string; kind: 'plugins' | 'skills'; marketplaceId?: string },
  deps: ListingResolutionDeps,
): Promise<MarketplaceCatalogItem | undefined> {
  const marketplaceId = args.marketplaceId ?? splitListingId(args.itemId)?.marketplaceId;

  if (marketplaceId && marketplaceId !== SAFE_MARKETPLACE_ID) {
    // "With a marketplace name" — refresh ahead of the lookup, so a plugin
    // published since the last refresh resolves without the user being told to
    // run a manual refresh first. Only for an id whose marketplace the caller
    // NAMED; an inferred prefix stays on the cache-only path below.
    if (args.marketplaceId && deps.refreshMarketplace) {
      await deps.refreshMarketplace(marketplaceId);
    }
    // Cache-only by design: no fetch, no retry-budget spend — the same
    // narrowing rationale the agent's catalog reader carries.
    const item = await deps.catalogReader?.findCatalogItem?.(marketplaceId, args.itemId);
    if (item) return item;
    // An explicit marketplaceId that resolved to nothing is a miss, not a
    // reason to ask the Skills Market about someone else's listing.
    if (args.marketplaceId) return undefined;
  }

  return (await deps.inspect({ id: args.itemId, kind: args.kind })).item;
}
