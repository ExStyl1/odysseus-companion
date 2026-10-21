/**
 * Marketplace-first browse navigation + lightweight client-side pagination.
 *
 * The browse surface is MARKETPLACE-FIRST: the top level is a marketplace
 * selector (the built-in Skills Market + every bring-your-own registry — NO
 * cross-market "All" view), and the Plugins|Skills kind tabs live INSIDE the
 * selected marketplace, scoped to the kinds it actually carries. A large
 * registry (e.g. openai/plugins) can be hundreds of rows, so the browse list
 * also carries a client-side render cap that grows on the load-more /
 * infinite-scroll sentinel. Every transform here is pure so PluginsPage stays a
 * thin presentation layer and the behaviour is unit-testable without a DOM.
 */

import type { SafeMarketplaceListKind } from '@nessy-agent/shared/protocol/capabilities'
import { resolveInstallPluginLink, type InstallPluginLinkRefusal } from '@/contexts/deep-link-policy'

/** The built-in Skills Market id (server `SAFE_MARKETPLACE_ID`). */
export const SAFE_MARKETPLACE_ID = 'skills-market'

/** Selector id for the built-in Skills Market bucket (also the default home). */
export const BUILT_IN_MARKETPLACE_FILTER_ID = SAFE_MARKETPLACE_ID

/**
 * How many browse rows to render per client-side page. The registry list is
 * client-side (a server page already carries up to `MARKETPLACE_PAGE_SIZE`
 * rows), so this caps the DOM node count and grows on the load-more sentinel.
 */
export const PAGE_RENDER_STEP = 40

/**
 * The built-in Skills Market id (`skills-market`) + the synthetic `'internal'`
 * fallback + an absent id all group into the built-in bucket; every other
 * `marketplaceId` is a bring-your-own registry.
 */
export function isBuiltInMarketplace(marketplaceId: string | undefined): boolean {
  return !marketplaceId || marketplaceId === SAFE_MARKETPLACE_ID || marketplaceId === 'internal'
}

/**
 * One chip in the top-level marketplace selector.
 *
 * `kind: 'offer'` (P6.517 / P6.518) is a catalog this build DELIVERS but has
 * not registered: it is not selectable, and clicking it enables it. It carries
 * a `description` because an offer is the one chip whose name alone does not
 * say what the user would be turning on.
 */
export interface MarketplaceFilterOption {
  id: string
  label: string
  kind: 'built-in' | 'registry' | 'offer'
  description?: string
}

/** A path-free configured-registry summary (subset of the RPC row). */
export interface MarketplaceRegistryChoice {
  marketplaceId: string
  displayName: string
}

/** A delivered-but-disabled built-in catalog (subset of the RPC offer row). */
export interface MarketplaceOfferChoice {
  name: string
  description: string
}

/**
 * Build the marketplace selector list: the built-in `Skills Market` first (the
 * default home — always present), then one chip per configured registry (driven
 * by `listRegistries`). Registry chips are de-duplicated, never re-emit the
 * reserved built-in ids, and keep the RPC order. There is NO cross-market "All"
 * entry — the selector always resolves to exactly one marketplace.
 */
export function buildMarketplaceFilterOptions(input: {
  registries: readonly MarketplaceRegistryChoice[]
  builtInLabel: string
  /**
   * P6.517 / P6.518 — the delivered catalogs still switched off. The server has
   * already withheld any an administrator's policy would refuse, so every offer
   * here is a click it will accept. An offer whose name a registered row
   * already uses is dropped, so an enabled catalog stops being offered the
   * moment it appears in `registries`.
   */
  offers?: readonly MarketplaceOfferChoice[]
}): MarketplaceFilterOption[] {
  const options: MarketplaceFilterOption[] = [
    { id: BUILT_IN_MARKETPLACE_FILTER_ID, label: input.builtInLabel, kind: 'built-in' },
  ]
  const seen = new Set<string>([BUILT_IN_MARKETPLACE_FILTER_ID, SAFE_MARKETPLACE_ID, 'internal'])
  for (const registry of input.registries) {
    if (seen.has(registry.marketplaceId)) continue
    seen.add(registry.marketplaceId)
    options.push({ id: registry.marketplaceId, label: registry.displayName, kind: 'registry' })
  }
  for (const offer of input.offers ?? []) {
    if (seen.has(offer.name)) continue
    seen.add(offer.name)
    options.push({ id: offer.name, label: offer.name, kind: 'offer', description: offer.description })
  }
  return options
}

/**
 * Whether the marketplace selector row should render at all.
 *
 * An OFFER is enough on its own: with no registry configured and a delivered
 * catalog still off, hiding the row would hide the only affordance that turns
 * it on — which is precisely the state P6.517 / P6.518 say is invisible today.
 */
export function shouldShowMarketplaceFilter(options: readonly MarketplaceFilterOption[]): boolean {
  return options.some(option => option.kind === 'registry' || option.kind === 'offer')
}

/**
 * Restrict browse rows to the selected marketplace. The built-in bucket matches
 * `isBuiltInMarketplace`; every other id matches rows carrying exactly that
 * `marketplaceId`. (No "All" pass-through — the selector is always specific.)
 */
export function filterItemsForMarketplace<T extends { marketplaceId?: string }>(
  items: readonly T[],
  filterId: string,
): T[] {
  if (filterId === BUILT_IN_MARKETPLACE_FILTER_ID) return items.filter(item => isBuiltInMarketplace(item.marketplaceId))
  return items.filter(item => item.marketplaceId === filterId)
}

/** Which kind tabs the selected marketplace offers. */
export interface MarketplaceKindAvailability {
  plugins: boolean
  skills: boolean
}

/**
 * Which kind tabs a marketplace offers, derived DATA-DRIVEN from its item kinds.
 * The built-in Skills Market always offers both (its plugins + skills
 * endpoints). A registry offers Plugins by default — the browse floor, so it
 * always lands on a valid tab — plus any kind its rows actually report. Today
 * registries only feed plugins, so the Skills tab stays hidden/disabled; a
 * future skill-bearing registry (Claude registries) whose rows carry
 * `listKind: 'skills'` lights up the Skills tab automatically.
 */
export function marketplaceKindAvailability(
  marketplaceId: string,
  items: readonly { marketplaceId?: string; listKind?: SafeMarketplaceListKind }[],
): MarketplaceKindAvailability {
  if (isBuiltInMarketplace(marketplaceId)) return { plugins: true, skills: true }
  const listKinds = new Set(
    items.filter(item => item.marketplaceId === marketplaceId).map(item => item.listKind),
  )
  return { plugins: true, skills: listKinds.has('skills') }
}

/**
 * `plugins/org.md#recommend-plugins` — "plugins marked as relevant to your current
 * working directory are pinned at the top with a **suggested for this
 * directory** label."
 *
 * A STABLE partition: suggested rows keep their relative order and so does
 * everything else, so a pin never reshuffles the rest of the catalog. Applied
 * BEFORE the render cap, so a pinned row can never fall outside the window.
 */
export function pinSuggestedItems<T extends { suggestion?: { signal: string } }>(
  items: readonly T[],
): T[] {
  const suggested: T[] = []
  const rest: T[] = []
  for (const item of items) (item.suggestion ? suggested : rest).push(item)
  return suggested.length === 0 ? [...items] : [...suggested, ...rest]
}

/** A capped render window over a client-side list. */
export interface RenderWindow<T> {
  visible: T[]
  /** More already-loaded rows exist beyond the cap (reveal them client-side). */
  hasMoreToReveal: boolean
}

/**
 * Cap the rendered rows to `limit`. `hasMoreToReveal` distinguishes "grow the
 * client-side slice" from "fetch the next server page": the sentinel reveals
 * more first, then falls back to `fetchNextPage`.
 */
export function capListForRender<T>(items: readonly T[], limit: number): RenderWindow<T> {
  const safeLimit = Math.max(0, limit)
  return {
    visible: items.slice(0, safeLimit),
    hasMoreToReveal: items.length > safeLimit,
  }
}

/**
 * The numbers the browse section note shows, all counted over ONE marketplace.
 *
 * A type alias, not an interface: the note interpolates it straight into `t()`,
 * and only an alias carries the implicit index signature `Record<string, unknown>`
 * needs.
 */
export type BrowseSectionCounts = {
  /** Cards on screen. */
  visible: number
  /** Rows the ACTIVE marketplace matched — the denominator, chip-scoped. */
  total: number
  /** Loaded rows the other marketplace chips hold for the same query. */
  elsewhere: number
}


/**
 * sev-4 — the note stops counting rows it does not show.
 *
 * `marketplace.list` merges every configured registry's matching rows into the
 * Skills Market response and adds them to `total`
 * (`shared/src/marketplace/service.ts:mergeRegistryItems`), while the list under
 * the header is narrowed to ONE marketplace by {@link filterItemsForMarketplace}.
 * Handing the note that total therefore counted rows this header can never show:
 * measured on the signed 1.25.0 with the Skills Market chip and the query
 * `chrome`, the RPC answered `total: 4` (the registry's `chrome-devtools-mcp`
 * among them) against 2 cards in the DOM, and the note read "Showing 2 of 4".
 *
 * The denominator is scoped here by subtracting the rows the chip filters out,
 * and those rows are NAMED rather than silently dropped — "the missing rows are
 * one chip away" is precisely what a user could not otherwise tell, and with a
 * corrected denominator alone the whole note would have disappeared in the
 * measured case (2 of 2).
 *
 * `elsewhere` counts LOADED rows: registry rows all ride page one
 * (`useMarketplaceItems.ts:nextMarketplacePage`), so for the built-in chip they
 * are complete from the first response. `catalogTotal` remains F2's pre-collapse
 * catalog number; this changes its SCOPE, not that accepted imprecision.
 *
 * Returns `null` when the note has nothing to say — an empty section, or the
 * whole scoped set on screen with nothing hidden behind another chip.
 */
export function browseSectionCounts(input: {
  visible: number
  catalogTotal: number
  elsewhere: number
}): BrowseSectionCounts | null {
  const visible = Math.max(0, input.visible)
  const elsewhere = Math.max(0, input.elsewhere)
  // A stale (or over-counted) total must never make the note claim fewer rows
  // than the screen already shows.
  const total = Math.max(input.catalogTotal - elsewhere, visible)
  if (visible === 0) return null
  if (total === visible && elsewhere === 0) return null
  return { visible, total, elsewhere }
}

/** Which sentence the note uses — the one that names the hidden rows, or not. */
export function browseShowingNoteKey(
  counts: BrowseSectionCounts,
): 'plugins.showingCount' | 'plugins.showingCountElsewhere' {
  return counts.elsewhere > 0 ? 'plugins.showingCountElsewhere' : 'plugins.showingCount'
}

/**
 * Removing the registry that is the selected marketplace falls the browse view
 * back to the built-in Skills Market; removing any other registry leaves the
 * current selection untouched.
 */
export function nextMarketplaceFilterAfterRemove(currentFilter: string, removedMarketplaceId: string): string {
  return currentFilter === removedMarketplaceId ? BUILT_IN_MARKETPLACE_FILTER_ID : currentFilter
}

/**
 * P6.512 — what an `install-plugin` deep link turns into on the browse surface.
 *
 * The verdict itself belongs to `resolveInstallPluginLink`, which is the single
 * gate: it accepts our own action format and the vendor's documented
 * `plugin-name@marketplace-name`, and it checks any named marketplace against
 * the REGISTERED set rather than against a pattern. This function only carries
 * that verdict the last step — from a NAME the link spelled to the opaque
 * `marketplaceId` the chip row is keyed by — so the page keeps no policy of
 * its own.
 *
 * A link installs NOTHING. The success case is a pre-filled search box and, when
 * the link named a marketplace, a scoped browse; the final step is a person
 * pressing Install. A link that names a marketplace this machine has not
 * registered is refused, and no marketplace is added, allowlisted or fetched.
 */
export type InstallLinkBrowseSelection =
  | { ok: true; query: string; marketplaceId?: string }
  | { ok: false; reason: InstallPluginLinkRefusal }

export function browseSelectionForInstallLink(
  link: { id: string; marketplace?: string },
  registries: readonly MarketplaceRegistryChoice[],
): InstallLinkBrowseSelection {
  const verdict = resolveInstallPluginLink(
    link.marketplace ? { marketplace: link.marketplace } : {},
    link.id,
    registries.map(registry => registry.displayName),
  )
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  const named = verdict.target.marketplaceName
  if (named === undefined) return { ok: true, query: verdict.target.pluginName }
  // Registered by the line above, so the row is present; the guard is here
  // because two registries may share a display name and only one can be shown.
  const row = registries.find(registry => registry.displayName === named)
  return row
    ? { ok: true, query: verdict.target.pluginName, marketplaceId: row.marketplaceId }
    : { ok: true, query: verdict.target.pluginName }
}
