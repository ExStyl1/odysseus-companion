import { useMemo, useRef } from 'react'
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryKey } from '@tanstack/react-query'
import type {
  SafeInstalledPluginSummary,
  SafeMarketplaceCatalogItem as SafeMarketplaceCatalogRow,
  SafeMarketplaceItemKind,
  SafeMarketplaceListKind,
  SafeMarketplaceListRequest,
  SafeMarketplaceListResult,
  SafeMarketplaceOffer,
  SafeMarketplaceRegistryLoadError,
  SafeMarketplaceRegistrySummary,
  SafeMarketplaceSort,
} from '@nessy-agent/shared/protocol/capabilities'
import { capabilityContext } from '@/lib/capability-catalog'

export const MARKETPLACE_PAGE_SIZE = 100

/**
 * The diagnostic a registry rides while its catalog fetch is still in flight
 * OFF the request path (`registry-source.ts:pendingLoadError`). It is not a
 * failure: a fetch that actually fails commits `marketplace.registry.fetch_failed`
 * / `…fetch_timeout` against the same signature instead, so this code is
 * strictly transient and always replaced.
 */
export const REGISTRY_FETCH_PENDING_CODE = 'marketplace.registry.fetch_pending'

/** How often to re-ask while at least one registry catalog is still landing. */
export const MARKETPLACE_PENDING_POLL_MS = 1500

export type SafeMarketplaceCatalogItem = SafeMarketplaceCatalogRow & {
  installed?: SafeInstalledPluginSummary
}

export function marketplaceListingIdentity(item: Pick<SafeMarketplaceCatalogRow, 'marketplaceId' | 'id'>): string {
  return JSON.stringify([item.marketplaceId, item.id])
}

export interface MarketplaceItemsQueryContext {
  kind: SafeMarketplaceListKind
  query?: string
  sort?: SafeMarketplaceSort
  capabilities?: string[]
  phases?: string[]
  professions?: string[]
  tenants?: string[]
  workspaceId?: string | null
  sessionId?: string | null
}

export interface UseMarketplaceItemsOptions extends MarketplaceItemsQueryContext {
  enabled?: boolean
}

export interface UseMarketplaceItemsResult {
  items: SafeMarketplaceCatalogItem[]
  installedItems: SafeMarketplaceCatalogItem[]
  installedCount: number
  /** Per-registry load failures for the current `plugins` list (R3, path-free). */
  registryLoadErrors: SafeMarketplaceRegistryLoadError[]
  /**
   * F1 — the distinct tenants of the rows this query has loaded, sorted. The
   * browse tenant filter's vocabulary is accumulated from this (see
   * {@link useTenantVocabulary}); it is read off the UNCOLLAPSED catalog because
   * the duplicate collapse keys on name+description and would otherwise drop a
   * bucket's second tenant out of the vocabulary.
   */
  loadedTenants: string[]
  total: number
  visible: number
  isLoading: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  hasNextPage: boolean
  fetchNextPage: () => Promise<unknown>
  error: Error | null
  refetch: () => Promise<unknown>
  data: InfiniteData<SafeMarketplaceListResult, number> | undefined
}

export const marketplaceQueryKeys = {
  all: ['marketplace'] as const,
  lists: () => [...marketplaceQueryKeys.all, 'list'] as const,
  list: (context: MarketplaceItemsQueryContext) => [...marketplaceQueryKeys.lists(), normalizeMarketplaceQueryContext(context)] as const,
  registries: () => [...marketplaceQueryKeys.all, 'registries'] as const,
  actions: () => [...marketplaceQueryKeys.all, 'actions'] as const,
  status: (context: Pick<MarketplaceItemsQueryContext, 'workspaceId' | 'sessionId'>) => [
    ...marketplaceQueryKeys.all,
    'status',
    context.workspaceId ?? null,
    context.sessionId ?? null,
  ] as const,
}

export function useMarketplaceItems(options: UseMarketplaceItemsOptions): UseMarketplaceItemsResult {
  const normalized = useMemo(() => normalizeMarketplaceQueryContext(options), [options])
  const enabled = options.enabled !== false && Boolean(window.electronAPI.marketplace)
  const query = useInfiniteQuery<SafeMarketplaceListResult, Error, InfiniteData<SafeMarketplaceListResult, number>, QueryKey, number>({
    queryKey: marketplaceQueryKeys.list(normalized),
    enabled,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => window.electronAPI.marketplace.list(marketplaceListRequest(normalized, pageParam)),
    getNextPageParam: nextMarketplacePage,
    refetchInterval: ({ state }) => marketplacePendingPollInterval(state.data),
  })
  const statusQuery = useQuery({
    queryKey: marketplaceQueryKeys.status(normalized),
    enabled: enabled && Boolean(normalized.workspaceId),
    queryFn: () => window.electronAPI.capabilities.getCatalog(capabilityContext(normalized.workspaceId!, normalized.sessionId)),
  })
  const catalogItems = useMemo<SafeMarketplaceCatalogItem[]>(() => query.data?.pages.flatMap(page => page.items) ?? [], [query.data])
  const rows = useMemo(
    () => marketplaceBrowseRows(catalogItems, statusQuery.data?.installedPlugins ?? []),
    [catalogItems, statusQuery.data],
  )
  const loadedTenants = useMemo(() => catalogTenants(catalogItems), [catalogItems])
  const total = query.data?.pages.at(-1)?.total ?? 0
  // Registry load errors ride the last page (they describe the whole `plugins`
  // list, not one page); absent on `skills` lists and additive-safe.
  const registryLoadErrors = query.data?.pages.at(-1)?.registryLoadErrors ?? []

  return {
    items: rows.items,
    installedItems: rows.installedItems,
    installedCount: rows.installedItems.length,
    registryLoadErrors,
    loadedTenants,
    total,
    visible: rows.items.length,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: Boolean(query.hasNextPage),
    fetchNextPage: () => query.fetchNextPage(),
    error: query.error ?? null,
    refetch: async () => { await Promise.all([query.refetch(), statusQuery.refetch()]) },
    data: query.data,
  }
}

/**
 * The one place a browse page request is built. The filter parameters
 * (`tenants`, `professions`, `capabilities`) are the reason this is exported:
 * `8319630c` corrected the spellings the Skills Market actually honours
 * (`tenant=`, not the bracketed `tenant[]=` it silently ignores), and a request
 * builder no caller can bypass is what keeps a selection provably on the wire.
 */
export function marketplaceListRequest(
  context: MarketplaceItemsQueryContext,
  page: number,
): SafeMarketplaceListRequest {
  const normalized = normalizeMarketplaceQueryContext(context)
  return {
    kind: normalized.kind,
    page,
    pageSize: MARKETPLACE_PAGE_SIZE,
    // `plugins/org.md#recommend-plugins` — the session whose working directory the `cwd`
    // relevance signal is matched against. The id only; the server resolves the
    // directory and never sends it back.
    ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
    ...(normalized.query ? { query: normalized.query } : {}),
    ...(normalized.sort ? { sort: normalized.sort } : {}),
    ...(normalized.capabilities.length ? { capabilities: normalized.capabilities } : {}),
    ...(normalized.phases.length ? { phases: normalized.phases } : {}),
    ...(normalized.professions.length ? { professions: normalized.professions } : {}),
    ...(normalized.tenants.length ? { tenants: normalized.tenants } : {}),
  }
}

/** Distinct, sorted tenants carried by the rows themselves. */
export function catalogTenants(items: readonly SafeMarketplaceCatalogItem[]): string[] {
  const tenants = new Set<string>()
  for (const item of items) {
    const tenant = item.tenant?.trim()
    if (tenant) tenants.add(tenant)
  }
  return [...tenants].sort((left, right) => left.localeCompare(right))
}

/**
 * F1 — the browse tenant filter's vocabulary, accumulated across loaded pages.
 *
 * The union only GROWS within one browsed set, and that is load-bearing:
 * selecting a tenant narrows the fetch to that tenant's rows, so a vocabulary
 * recomputed from the current rows would collapse to the single selected value
 * and strand the user inside their own filter.
 *
 * Returns `previous` unchanged (same identity) when nothing new arrived, so the
 * memo below it does not churn on every page.
 */
export function mergeTenantVocabulary(
  previous: readonly string[],
  loaded: readonly string[],
): readonly string[] {
  if (loaded.every(tenant => previous.includes(tenant))) return previous
  return [...new Set([...previous, ...loaded])].sort((left, right) => left.localeCompare(right))
}

/**
 * The value a tenant selection is allowed to put on the wire.
 *
 * Measured live 2026-08-01 on `/v1/skills`: `tenant=escape-tools` -> 139 rows,
 * `tenant=ads` -> 23, and `tenant=not-a-real-tenant` -> **0** where the
 * unfiltered list has 6084. An out-of-vocabulary value therefore empties the
 * browse list, which is why a selection is only accepted when the vocabulary —
 * built from rows the server itself returned — contains it.
 */
export function browseTenantFilter(
  selected: string | null | undefined,
  vocabulary: readonly string[],
): string | undefined {
  return selected && vocabulary.includes(selected) ? selected : undefined
}

const EMPTY_TENANT_VOCABULARY: readonly string[] = []

/**
 * Holds {@link mergeTenantVocabulary}'s union for one browsed set. `resetKey`
 * identifies that set (kind + marketplace): changing it drops the vocabulary,
 * because another marketplace's tenants are not this one's.
 */
export function useTenantVocabulary(loaded: readonly string[], resetKey: string): readonly string[] {
  const store = useRef<{ key: string; values: readonly string[] }>({
    key: resetKey,
    values: EMPTY_TENANT_VOCABULARY,
  })
  const previous = store.current.key === resetKey ? store.current.values : EMPTY_TENANT_VOCABULARY
  const values = mergeTenantVocabulary(previous, loaded)
  store.current = { key: resetKey, values }
  return values
}

/**
 * Poll while a registry catalog is still landing — otherwise the browse list
 * keeps the cold-start snapshot forever.
 *
 * `listItems()` never blocks on a clone: an uncached (or stale) registry kicks a
 * background fetch and rides out as a `fetch_pending` load error, and its rows
 * "appear on the next poll/refetch once the fetch settles"
 * (`registry-source.ts:399`, `:1007`). Nothing in the renderer was that poll.
 * On the first browse after a marketplace is added — or after ANY change that
 * invalidates the on-disk catalogs, e.g. the `CATALOG_CACHE_SCHEMA_VERSION`
 * 1 -> 2 bump — every registry answered `fetch_pending`, react-query settled
 * that page as a SUCCESS, and the list stayed at zero registry rows until the
 * user restarted the app or ran a mutation that invalidated the query. Measured
 * live 2026-08-01: 0 cards on the `openai/plugins` tab against 2777 rows already
 * merged by the same RPC; one manual `refetchQueries` produced 40.
 *
 * Self-terminating, and deliberately keyed on that one code: a fetch that fails
 * commits `fetch_failed`/`fetch_timeout` against the same signature, which
 * `listItems` then serves from cache instead of a fresh pending marker — so a
 * broken registry stops the poll rather than pinning it on.
 *
 * EVERY loaded page is tested, not the last one. A refetch re-runs the pages in
 * order, so each carries the `listItems()` snapshot of a DIFFERENT instant —
 * and registry rows are merged into page ONE only (`service.ts:mergeRegistryItems`),
 * while the banner reads its errors off the last. Reading the marker off the
 * last page therefore stops the poll on a registry that settled between page 1
 * and page 2, stranding page 1 without its rows for good. Measured live on a
 * cold boot: `claude-*` landed before page 1 was re-asked and rendered, while
 * `openai/plugins` settled during the gap, cleared the last page's marker,
 * stopped the poll, and stayed at 0 cards for the remaining 75 s. Page one is
 * where the rows are, so page one's marker has to be able to keep the poll on.
 */
export function marketplacePendingPollInterval(
  data: InfiniteData<SafeMarketplaceListResult, number> | undefined,
): number | false {
  const pending = data?.pages.some(page => page.registryLoadErrors
    ?.some(error => error.diagnosticCodes.includes(REGISTRY_FETCH_PENDING_CODE)))
  return pending ? MARKETPLACE_PENDING_POLL_MS : false
}

/**
 * Registry rows ride page one beside the Skills Market response. Only the
 * built-in rows are paginated, so a large external registry must not fabricate
 * extra pages after the built-in API says there is no continuation.
 */
export function nextMarketplacePage(lastPage: SafeMarketplaceListResult): number | undefined {
  if (lastPage.nextPage !== undefined) return lastPage.nextPage
  const builtInRows = lastPage.items.filter(item => item.marketplaceId === 'skills-market').length
  return builtInRows >= lastPage.pageSize ? lastPage.page + 1 : undefined
}

/**
 * Configured bring-your-own registries (path-free), used to drive the browse
 * per-marketplace filter chips. Rides `marketplaceQueryKeys.all`, so the
 * add/remove/upgrade mutations already invalidate it. Empty when no registries
 * are configured (the filter row then stays hidden).
 */
export function useMarketplaceRegistries(): {
  registries: SafeMarketplaceRegistrySummary[]
  /**
   * P6.517 / P6.518 — the built-in catalogs delivered but still OFF. Empty on
   * an older server, and empty once every offer has been enabled.
   */
  offers: SafeMarketplaceOffer[]
  isLoading: boolean
} {
  const enabled = Boolean(window.electronAPI.marketplace)
  const query = useQuery({
    queryKey: marketplaceQueryKeys.registries(),
    enabled,
    queryFn: () => window.electronAPI.marketplace.listRegistries(),
  })
  return {
    registries: query.data?.registries ?? [],
    offers: query.data?.available ?? [],
    isLoading: query.isLoading,
  }
}

/**
 * The browse list the page renders, plus the installed inventory beside it.
 *
 * Order is load-bearing and is why this is ONE function rather than two memos:
 * the installed inventory joins against the UNCOLLAPSED catalog, so an installed
 * skill that is a duplicate of an earlier row still finds its own catalog row
 * (and still appears in the installed strip); only the browse list collapses.
 */
export function marketplaceBrowseRows(
  catalogItems: readonly SafeMarketplaceCatalogItem[],
  installedPlugins: readonly SafeInstalledPluginSummary[],
): { items: SafeMarketplaceCatalogItem[]; installedItems: SafeMarketplaceCatalogItem[] } {
  const installedItems = joinInstalledInventory(installedPlugins, catalogItems)
  return {
    items: collapseDuplicateCatalogRows(enrichCatalogWithInstalledInventory(catalogItems, installedItems)),
    installedItems,
  }
}

/**
 * F2 — the browse list stops showing rows a user cannot tell apart.
 *
 * Two catalog rows with the same name AND the same description render an
 * identical card, so the second one is noise. Measured on the live Skills Market
 * (`/v1/skills`, all 61 pages, 2026-07-31): 6084 rows collapse to 4711 — 1373
 * duplicate rows removed, in 654 buckets.
 *
 * The rule is checked against the market's OWN clustering rather than invented:
 * `/v2/registry/catalog` groups 5341 registry entries into 3914 variant
 * clusters, and joining those clusters onto the same 6084 rows disagrees with
 * this rule in exactly 9 buckets (19 rows) — where the two rows carry a
 * byte-identical name and description anyway, so the card is the same either
 * way. `tenant`/`repo` are deliberately NOT part of the key: the registry's own
 * clusters span tenants (one `acceptance-criteria` cluster covers
 * `system-analysis`, `coin` and `sme-ios`), and keying on tenant would collapse
 * 383 rows instead of 1373.
 *
 * A row with no description never collapses — 280 live rows have none, and
 * name alone disagrees with the registry's clusters on 271 buckets.
 *
 * An installed duplicate takes over its bucket IN PLACE, so collapsing can never
 * hide the copy the user actually has behind an identical-looking stranger.
 */
export function collapseDuplicateCatalogRows(
  items: readonly SafeMarketplaceCatalogItem[],
): SafeMarketplaceCatalogItem[] {
  const keptAt = new Map<string, number>()
  const rows: SafeMarketplaceCatalogItem[] = []
  for (const item of items) {
    const key = duplicateRowKey(item)
    if (key === undefined) {
      rows.push(item)
      continue
    }
    const index = keptAt.get(key)
    if (index === undefined) {
      keptAt.set(key, rows.length)
      rows.push(item)
      continue
    }
    if (item.installed && !rows[index]?.installed) rows[index] = item
  }
  return rows
}

/**
 * `undefined` means "never collapse this row". `marketplaceId` and `listKind`
 * keep the buckets inside one list of one marketplace; `version` is on the card
 * for plugin rows, so two versions of a name stay two rows.
 */
function duplicateRowKey(item: SafeMarketplaceCatalogItem): string | undefined {
  const description = item.description?.trim()
  if (!description) return undefined
  return JSON.stringify([item.marketplaceId, item.listKind, item.name, item.version ?? null, description])
}

export function joinInstalledInventory(
  installedPlugins: readonly SafeInstalledPluginSummary[],
  catalogItems: readonly SafeMarketplaceCatalogItem[],
): SafeMarketplaceCatalogItem[] {
  return installedPlugins.map(installed => {
    const catalogItem = catalogItems.find(item => matchesInstalledItem(installed, item))
    return catalogItem ? { ...catalogItem, installed } : syntheticInstalledItem(installed)
  })
}

export function enrichCatalogWithInstalledInventory(
  catalogItems: readonly SafeMarketplaceCatalogItem[],
  installedItems: readonly SafeMarketplaceCatalogItem[],
): SafeMarketplaceCatalogItem[] {
  return catalogItems.map(item => {
    const installed = installedItems.find(candidate => candidate.installed && matchesInstalledItem(candidate.installed, item))?.installed
    return installed ? { ...item, installed } : item
  })
}

/**
 * C3 — a plugin installed under a name its marketplace has since renamed is
 * still recognised as installed.
 *
 * The installed record stores the identity captured AT INSTALL time, so after
 * an upstream rename nothing it carries equals the row's current id. `formerIds`
 * is the set of ids this row previously answered to in this same marketplace
 * (server-derived from the catalog's `renames` map), so a former id is tested
 * with exactly the same three equalities as the current one — no new join
 * semantics, and no name-only fallback, which was measured to fire across
 * unrelated plugins.
 *
 * The marketplace guard on the first line is what keeps the whole thing
 * anchored: a former name from one marketplace can never reach a record
 * installed from another.
 */
function matchesInstalledItem(installed: SafeInstalledPluginSummary, item: SafeMarketplaceCatalogItem): boolean {
  if (installed.origin.marketplaceId !== item.marketplaceId) return false
  return [item.id, ...(item.formerIds ?? [])].some(id => Boolean(
    (installed.origin.listingId && id === installed.origin.listingId)
    || id === installed.origin.pluginId
    || id === installed.pluginKey,
  ))
}

function syntheticInstalledItem(installed: SafeInstalledPluginSummary): SafeMarketplaceCatalogItem {
  const kind = installedKind(installed)
  return {
    marketplaceId: installed.origin.marketplaceId,
    id: installed.origin.listingId ?? installed.pluginKey,
    kind,
    listKind: kind === 'skill' ? 'skills' : 'plugins',
    name: installed.name,
    version: installed.version,
    icon: { kind: 'symbol', name: kind },
    capabilities: installed.capabilityKinds,
    installed,
    install: { sourceConfidence: 'missing' },
  }
}

function installedKind(installed: SafeInstalledPluginSummary): SafeMarketplaceItemKind {
  const kinds = new Set(installed.capabilityKinds)
  if (kinds.size === 1 && kinds.has('skill')) return 'skill'
  if (kinds.has('mcp')) return 'mcp'
  if (kinds.has('hook')) return 'hook'
  return 'plugin'
}

function normalizeMarketplaceQueryContext(context: MarketplaceItemsQueryContext): Required<Pick<MarketplaceItemsQueryContext, 'kind' | 'capabilities' | 'phases' | 'professions' | 'tenants'>> & Omit<MarketplaceItemsQueryContext, 'kind' | 'capabilities' | 'phases' | 'professions' | 'tenants'> {
  return {
    kind: context.kind,
    ...(context.query?.trim() ? { query: context.query.trim() } : {}),
    ...(context.sort ? { sort: context.sort } : {}),
    capabilities: [...(context.capabilities ?? [])].filter(Boolean).sort(),
    phases: [...(context.phases ?? [])].filter(Boolean).sort(),
    professions: [...(context.professions ?? [])].filter(Boolean).sort(),
    tenants: [...(context.tenants ?? [])].filter(Boolean).sort(),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  }
}
