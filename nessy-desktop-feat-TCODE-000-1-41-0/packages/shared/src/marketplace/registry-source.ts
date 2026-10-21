/**
 * Marketplace registry source + mutations (1.10.0 R3).
 *
 * Server-side glue that turns the persisted registry list (R1's
 * `PluginMarketplaceRegistryStore.readMarketplaceRegistries`) into browse items
 * and load errors for
 * the marketplace list, and owns the add / upgrade / remove / list-registries
 * mutations. It composes the R1 fetch seam (`fetchRegistryCatalog`, which reuses
 * the injected plugin-install staging — NO new network client) and the R2 mapper
 * (`registryCatalogItems`); it invents no new fetch, install, or enablement
 * machinery.
 *
 * Path discipline (Stop Condition): `installedRoot` / `catalogRoot` and any
 * staged temp dir stay INSIDE this module. Nothing returned from the mutation or
 * list methods carries an absolute path — the RPC Safe projection is a second
 * guard, but the shapes here are already path-free.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fetchRegistryCatalog,
  resolvePluginInstallSource,
  type PluginMarketplaceRegistry,
  type RegistryStagingService,
} from '../plugins/index.ts';
// The marketplace-registry store class is OFF the public plugins barrel: the
// registry source is composed HERE, inside the package, via the internal module
// path, and exposes a factory — server-core never constructs a store that could
// point at a path the source gate does not cover. `PluginInstallService` here is
// the V2-owned acquisition pipeline (`acquisition.ts`); it is off the barrel for
// the same reason, since a composition root needs a factory, not the class.
import { PluginMarketplaceRegistryStore, writeJsonAtomic } from '../plugins/marketplace-registry-store.ts';
import { PluginInstallService } from '../plugins/acquisition.ts';
import {
  blockedMarketplaceEntryFor,
  defaultMarketplaceAutoUpdate,
  describeManagedMarketplaceEntry,
  isManagedMarketplaceAllowed,
  isOfficialAnthropicMarketplaceSource,
  managedMarketplaceSourceIdentity,
  matchesManagedMarketplaceEntry,
  OFFICIAL_ANTHROPIC_MARKETPLACE_NAME,
  type DeliveredMarketplaceEntryV1,
  type ManagedMarketplaceEntryV1,
} from '../agent/pi-harness/managed-marketplace-entries.ts';
import {
  resolveManagedMarketplaceHeaders,
  type ManagedHeadersHelperOutcome,
} from './managed-headers-helper.ts';
import { PLUGINS_DIR } from '../workspaces/paths.ts';
import type { DpSessionBroker } from '../auth/dp/session-broker.ts';
import {
  builtInMarketplaceEntry,
  BUILT_IN_MARKETPLACES,
  type BuiltInMarketplaceEntry,
} from './built-in-marketplaces.ts';
import { registryCatalogItems, registryScannedCatalogItems } from './registry-catalog-items.ts';
import { reservedMarketplaceNameFor } from './reserved-names.ts';
import type { MarketplaceCatalogItem, MarketplaceRegistryLoadError } from './types.ts';
import type {
  MarketplaceRegistryListResult,
  MarketplaceRegistrySource,
} from './service.ts';

/**
 * Hard upper bound on a SINGLE registry fetch (git clone + manifest read).
 * Config-free constant (no user knob): a cold clone of a large repo over a
 * slow/blocked network must never hang unbounded. The browse list already runs
 * the fetch off its request path, but `upgrade()` awaits it and a leaked
 * background clone must still settle — so the fetch itself is timeout-bounded.
 */
const REGISTRY_FETCH_TIMEOUT_MS = 45_000;

/**
 * The window `plugins/install.md#install-a-plugin` names for the refresh ahead
 * of a named install: "Claude Code refreshed the marketplace within the last 30
 * seconds." A constant, not a knob — the page states one value and this fork
 * has no key for it.
 */
const INSTALL_REFRESH_WINDOW_MS = 30_000;

/**
 * Global cap on registry catalog fetches (full repo clones) running at once.
 * Without it, a browse-list read of N uncached registries would kick N cold
 * clones simultaneously — a bandwidth/disk storm on a slow bank network. The
 * single-flight map already dedupes PER registry; this bounds ACROSS them.
 */
const DEFAULT_MAX_CONCURRENT_FETCHES = 2;

/**
 * How many background re-attempts a registry gets after a catalog fetch FAILS.
 * A failure keeps the last good catalog on screen (see {@link mergeFailedFetch}),
 * and this is what stops that staleness from becoming permanent: browse keeps
 * trying while the budget lasts. Config-free constant — a user knob here would
 * only let someone turn the healing off.
 */
const FETCH_RETRIES_AFTER_FAILURE = 3;

/**
 * Schema tag for the on-disk parsed-catalog cache files.
 *
 * `2` (C3): rows now carry `formerIds` from the catalog's `renames` map. A `1`
 * file was written before that field existed, and a cache hit is served WITHOUT
 * a fetch until the registry's signature moves — which only happens on an
 * upgrade. Left at `1`, an already-cached registry would therefore serve
 * rename-blind rows indefinitely and the join would silently never fire. The
 * bump costs one background re-fetch per registry on the first browse after the
 * update, which is the module's ordinary cold-start path.
 */
const CATALOG_CACHE_SCHEMA_VERSION = 2;

/** Sub-directory (under the plugin store root) holding per-registry catalog caches. */
const CATALOG_CACHE_DIRNAME = 'registry-catalogs';

/**
 * A registry's last resolved catalog, cached in-memory on the (per-server
 * singleton) registry source so repeat browse-list reads never re-clone.
 * `signature` invalidates the entry when the registry's fetch-affecting fields
 * (source / ref / sparse paths / lastUpgradedAt) change.
 */
interface CachedRegistryEntry {
  signature: string;
  items: MarketplaceRegistryListResult['items'];
  loadError?: MarketplaceRegistryLoadError;
  /**
   * In-memory only (never written to disk): marks an entry that came from a
   * definitive successful fetch and is therefore safe to persist. Timeout /
   * staging-error / missing-catalog outcomes leave this false so a transient
   * failure is retried on the next start instead of being cached.
   */
  persistable?: boolean;
  /**
   * Marks an entry whose `items` are the LAST SUCCESSFULLY RESOLVED catalog,
   * re-keyed to a signature whose own fetch failed — a failure is never allowed
   * to stand in for a catalog. `loadError` carries the failure so the staleness
   * is visible, and {@link retriesLeft} bounds how long it lasts.
   */
  failedFetch?: boolean;
  /** Remaining background re-attempts (see {@link FETCH_RETRIES_AFTER_FAILURE}). */
  retriesLeft?: number;
  /**
   * P6.621 — the `name` this registry's catalog manifest declared for ITSELF, as
   * of this entry. Persisted with the entry so a rename that happens across a
   * restart is still a rename and not a first sighting.
   */
  catalogName?: string;
  /**
   * P6.621 — the rename announcement for the Plugins page, riding the same
   * `registryLoadErrors` channel `fetch_pending` uses (its own code, so a real
   * failure stays distinguishable). In-memory only and deliberately NOT
   * persisted: a notice written to disk would be re-announced on every start
   * forever. It stands until the next catalog commit replaces the entry.
   */
  renameNotice?: MarketplaceRegistryLoadError;
}

/**
 * On-disk projection of a {@link CachedRegistryEntry}. PATH-FREE by construction:
 * it stores only the parsed browse items (each carrying a durable, path-free
 * `structuredInstallSource`) and the load error — never the cloned repo or any
 * staged temp path. Keyed on disk by registry id; validated on read by
 * `signature` so an upgrade (which bumps `lastUpgradedAt`) invalidates it.
 */
interface PersistedCatalogEntry {
  schemaVersion: number;
  registryId: string;
  signature: string;
  items: MarketplaceCatalogItem[];
  loadError?: MarketplaceRegistryLoadError;
  /** P6.621 — the catalog's own declared name; a marketplace name, never a path. */
  catalogName?: string;
  updatedAt: number;
}

/** Minimal registry persistence seam (a `PluginMarketplaceRegistryStore` subset — R1 read/write). */
export interface MarketplaceRegistryStore {
  readMarketplaceRegistries(): Promise<{
    registries: PluginMarketplaceRegistry[];
    schemaVersion: number;
    updatedAt: number;
  }>;
  writeMarketplaceRegistries(file: {
    registries: PluginMarketplaceRegistry[];
    schemaVersion: number;
    updatedAt: number;
  }): Promise<void>;
}

export interface MarketplaceRegistrySourceOptions {
  store: MarketplaceRegistryStore;
  staging: RegistryStagingService;
  /** Staging base dir override (server-only path; never surfaced). */
  baseTempDir?: string;
  now?: () => number;
  /**
   * Environment read for the one variable this class consults —
   * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, a skip condition
   * `plugins/install.md#install-a-plugin` names for the refresh ahead of a
   * named install. Injected rather than read off `process.env` at the call
   * site so the two arms are testable without mutating the process (assigning
   * to `process.env.X` in Bun 1.3.14 leaves the name invisible to a spread).
   * Defaults to `process.env`.
   */
  env?: Record<string, string | undefined>;
  /**
   * Per-registry fetch timeout override (test seam — NOT a user config knob).
   * Defaults to {@link REGISTRY_FETCH_TIMEOUT_MS}.
   */
  fetchTimeoutMs?: number;
  /**
   * Directory for the on-disk parsed-catalog cache. When set, resolved catalogs
   * survive restarts so a cold start serves browse items WITHOUT re-cloning.
   * Omit to disable disk persistence (pure in-memory cache — used by unit tests
   * so they never touch the real store). The production factory points this at
   * the plugin store root.
   */
  catalogCacheDir?: string;
  /**
   * Global concurrent-fetch cap override (test seam). Defaults to
   * {@link DEFAULT_MAX_CONCURRENT_FETCHES}.
   */
  maxConcurrentFetches?: number;
  /**
   * The administrator's marketplace-source allowlist
   * (`plugins/org.md#allowlist-with-strictknownmarketplaces`'s `strictKnownMarketplaces`). Undefined imposes
   * no restriction; `[]` is `:678`'s complete lockdown. Captured at construction,
   * like every other managed-policy consumer in the server runtime.
   *
   * THE FOUR FIELDS BELOW ARE THE WHOLE MANAGED-MARKETPLACE SURFACE of this
   * fork, and the enumeration is load-bearing rather than decorative: P2.442
   * measured a FIFTH key the shipped Claude binary names in its own warning
   * text, `allowedPluginMarketplaces`, which appears in 0 of the 191 published
   * doc pages and is read by nothing here — it belongs to Claude Desktop's
   * managed marketplace sync, a product this fork does not talk to. Anyone
   * adding a managed marketplace control should read the verdict in
   * `reserved-names.ts` first: a key that arrives through managed settings and is
   * not one of these four has no reader, by decision and not by omission.
   *
   * This line said THREE until P2.467 added {@link blockedMarketplaces}, and the
   * count is written out rather than left implicit because the previous count
   * outlived its list once already.
   */
  strictKnownMarketplaces?: readonly ManagedMarketplaceEntryV1[];
  /**
   * The marketplace sources the administrator BLOCKS
   * (`settings-reference.md#blockedmarketplaces`) — "Block plugin marketplace
   * sources for your organization. Claude Code checks the blocklist on
   * marketplace add and on plugin install, update, refresh, and auto-update, so a
   * marketplace someone added before you set the policy can't be used to fetch
   * plugins either. Blocked sources are checked before download, so they never
   * touch the filesystem."
   *
   * The DANGEROUS half of the allowlist/blocklist pair, and the reason P2.467 is
   * a row: an unenforced allowlist can only narrow what an operator may do, while
   * an unenforced blocklist fails OPEN — the administrator sets it, sees no error
   * and the marketplaces they blocked keep working. Absent and `[]` are the same
   * answer here (nothing blocked), unlike
   * {@link MarketplaceRegistrySourceOptions.strictKnownMarketplaces} where `[]`
   * is a complete lockdown.
   *
   * Matched on the SOURCE identity and never on the display name — see
   * `matchesBlockedMarketplaceEntry` for the four documented rules that make
   * blocklist matching wider than the allowlist's, and for why the label would be
   * the wrong field.
   *
   * A blocked marketplace's LOAD-path refusal reuses the allowlist's diagnostic
   * code on purpose — see the gate in `resolveRegistryEntry` — and names the
   * blocklist entry in the log instead. The `add()`/`upgrade()` refusals name it
   * in the message a user sees.
   *
   * FED BY THE MANAGED POLICY since P2.481 (`a67c6db63` + `11ed02ba2`).
   * `ManagedPiPolicyV1` carries the key, `MANAGED_PI_POLICY_KEYS` classifies it,
   * and `createStorageRuntime` threads it here. This paragraph said the opposite
   * until P2.501 — it described the world in which the option existed and only
   * tests set it, which is exactly the state P2.467 called an unenforced
   * blocklist failing OPEN, so the text asserted the defect its own fix had
   * closed.
   */
  blockedMarketplaces?: readonly ManagedMarketplaceEntryV1[];
  /**
   * The marketplaces the administrator DELIVERS (`settings.md`'s
   * `extraKnownMarketplaces`), from the enforced managed policy.
   *
   * Registered through {@link PluginRegistrySource.add} — the same path an
   * interactive add takes — so a delivered marketplace passes exactly the gates
   * an added one does and never fewer. In particular
   * {@link MarketplaceRegistrySourceOptions.strictKnownMarketplaces} still
   * applies: an administrator who both restricts sources and delivers one whose
   * source their own allowlist forbids gets nothing registered, because the
   * allowlist is the narrowing half of the pair and a delivery must not be able
   * to widen it.
   */
  extraKnownMarketplaces?: readonly DeliveredMarketplaceEntryV1[];
  /**
   * `settings-reference.md#pluginsuggestionmarketplaces` — the marketplace NAMES
   * whose `relevance` declarations may surface as contextual suggestions.
   * Undefined and `[]` mean the same thing (no marketplace-declared suggestion
   * surfaces), unlike `strictKnownMarketplaces` where the two differ.
   * See {@link PluginRegistrySource.isSuggestionAllowed} for the source-binding
   * half of the rule, which is the part that makes the allowlist safe.
   */
  pluginSuggestionMarketplaces?: readonly string[];
  /**
   * P2.501 — RE-RESOLVE the four fields above at CHECK time instead of holding
   * the boot snapshot.
   *
   * ## The defect
   *
   * The four managed marketplace lists were captured once, in the constructor,
   * at `createStorageRuntime`. A marketplace blocklist an administrator edited
   * while the app ran reached the gate only at the next start — and an
   * unenforced blocklist fails OPEN, so the administrator saw no error and the
   * sources they blocked kept working until someone restarted.
   *
   * ## Why a restart is NOT what the vendor promises
   *
   * `managed-settings.md#where-and-when-a-policy-applies`, whole bullet:
   * *"**Running sessions**: a session picks up most changes on the schedule in
   * the table without a restart. Claude Code reads `forceRemoteSettingsRefresh`
   * and `requiredMinimumVersion` only at session start, arms a new or changed
   * `policyHelper` entry at the next launch, and reads some user-editable keys
   * once at session start."* The restart-bound set is CLOSED and named, and
   * `blockedMarketplaces` is not in it. The file mechanism's own row in
   * `#choose-a-delivery-mechanism` says the same for the file half: *"Read at
   * startup and reloaded when a file changes."*
   *
   * And the key's own entry says WHEN the check happens, which is what makes a
   * per-action resolve the right shape rather than a per-turn one —
   * `settings-reference.md#blockedmarketplaces`: *"Claude Code checks the
   * blocklist on marketplace add and on plugin install, update, refresh, and
   * auto-update, so a marketplace someone added before you set the policy can't
   * be used to fetch plugins either."*
   *
   * ## What this is NOT, and it is the trap the row named
   *
   * NOT the mid-turn re-read. `SessionManager` re-resolves the managed policy on
   * a delivery signal and at each turn boundary; naming these keys in that set
   * could not make a blocklist apply sooner — a marketplace action is not a turn
   * — and would only let an unrelated simultaneous policy change adopt halfway
   * through one. The gate here is per ACTION, and so is this seam.
   *
   * ## Shape
   *
   * A resolver, not a subscription, and for a measured reason: the host's
   * `subscribeManagedPolicyChange` publishes DELIVERY changes only
   * (`onManagedDeliveryChange`), while there is no watcher on the managed
   * settings FILE — so a subscription would still miss the edited file, which is
   * the case in the row's title. Re-resolving on read is also the pattern the
   * three sibling managed providers in `bootstrap/managed-policy-resolution.ts`
   * already use, verbatim: *"The provider re-resolves on every read."*
   *
   * Undefined keeps the constructor snapshot, so a unit test that passes the
   * four lists directly is unchanged, and so is any host that does not wire it.
   * A resolver that THROWS also falls back to the snapshot rather than to
   * nothing: keeping the boot policy is the fail-safe direction for a blocklist,
   * and the fallback says so on `console.warn` instead of degrading silently.
   */
  resolveManagedMarketplacePolicy?: () => ManagedMarketplacePolicySlice;
}

/**
 * The four managed marketplace lists, as {@link
 * MarketplaceRegistrySourceOptions.resolveManagedMarketplacePolicy} returns
 * them. Structural rather than `ManagedPiPolicyV1` so this module keeps its one
 * import from the managed layer (`managed-marketplace-entries.ts`) and a caller
 * can hand over a slice of any policy shape.
 */
export interface ManagedMarketplacePolicySlice {
  strictKnownMarketplaces?: readonly ManagedMarketplaceEntryV1[];
  blockedMarketplaces?: readonly ManagedMarketplaceEntryV1[];
  extraKnownMarketplaces?: readonly DeliveredMarketplaceEntryV1[];
  pluginSuggestionMarketplaces?: readonly string[];
}

/** What {@link PluginRegistrySource.ensureDeliveredMarketplaces} did, per entry. */
export interface DeliveredMarketplaceOutcome {
  name: string;
  /** `'registered'` on the run that added it; `'already-present'` afterwards. */
  state:
    | 'registered'
    | 'already-present'
    | 'refused-by-allowlist'
    /**
     * The administrator delivered a marketplace their OWN blocklist blocks. Its
     * own state for the same reason `'refused-by-allowlist'` is not `'failed'`,
     * and separate from it because the remedies are opposite: widen the
     * allowlist versus remove the blocklist entry.
     */
    | 'refused-by-blocklist'
    /**
     * The administrator's own entry named a reserved marketplace name. Its own
     * state, not `'failed'`: an entry refused by a naming rule is fixed by
     * renaming it, and lumping it in with a store write that broke would tell
     * the operator nothing about which of the two happened.
     */
    | 'refused-reserved-name'
    | 'failed';
  /** Present once the row exists. Never a path. */
  marketplaceId?: string;
}

/**
 * Thrown by {@link PluginRegistrySource.add} when managed settings forbid the
 * source. A named class so the RPC layer can map it to a typed refusal rather
 * than a generic failure.
 */
export class MarketplaceSourceNotAllowedError extends Error {
  override readonly name = 'MarketplaceSourceNotAllowedError';
}

/**
 * Thrown by {@link PluginRegistrySource.add} and {@link PluginRegistrySource.upgrade}
 * when the source matches an entry of `blockedMarketplaces` (P2.467).
 *
 * A SEPARATE class from {@link MarketplaceSourceNotAllowedError} even though both
 * are managed-policy refusals, because the administrator's remedy is the opposite
 * one — remove a blocklist entry rather than widen an allowlist — and because a
 * refusal that cannot name which of the two rules fired is the shape this plan
 * has closed rows over. The message names the matching entry.
 */
export class MarketplaceSourceBlockedError extends Error {
  override readonly name = 'MarketplaceSourceBlockedError';
  constructor(readonly blockedBy: string) {
    super(
      'This marketplace source is blocked by your organization\'s managed settings'
      + ` (blockedMarketplaces entry "${blockedBy}").`,
    );
  }
}

/**
 * Thrown by {@link PluginRegistrySource.add} and {@link PluginRegistrySource.upgrade}
 * when the name a registry would carry is reserved for official Anthropic use
 * (`reserved-names.ts` carries the page and the sixteen names).
 *
 * A named class for the same reason {@link MarketplaceSourceNotAllowedError} is
 * one, and the message NAMES the colliding reservation and the remedy: this
 * refusal is the whole point of the row — a reservation whose only trace is a
 * log line is indistinguishable from no reservation at all.
 */
export class MarketplaceReservedNameError extends Error {
  override readonly name = 'MarketplaceReservedNameError';
  constructor(readonly reservedName: string, readonly attemptedName: string) {
    super(
      `The marketplace name "${attemptedName}" is reserved for official Anthropic use`
      + ` (it collides with "${reservedName}"). Add it under a different name.`,
    );
  }
}

/** Path-free add-registry result (Codex `MarketplaceAddResponse` MINUS `installedRoot`). */
export interface RegistryAddResult {
  marketplaceId: string;
  displayName: string;
  alreadyAdded: boolean;
}

/** Path-free upgrade result. Local-folder registries are a typed no-op. */
export interface RegistryUpgradeResult {
  marketplaceId: string;
  upgraded: boolean;
  /**
   * Why nothing was upgraded. `'not-git'` — a local folder, nothing to
   * re-fetch. `'not-found'` — no such registry row. `'fetch-failed'` /
   * `'fetch-timeout'` — the re-clone produced no catalog, so the row was
   * deliberately left unstamped and the previous catalog is still what browse
   * and install see.
   *
   * A caller MUST read `upgraded` before reporting success: a clone that threw
   * used to cross this seam as a bare `{upgraded: true}`.
   *
   * Deliberately NOT widened for {@link
   * MarketplaceRegistryController.refreshForInstall}'s two extra verdicts: this
   * union crosses the RPC seam verbatim as `SafeMarketplaceUpgradeRegistryResult`,
   * and a reason the wire type cannot spell is a compile error at the handler.
   * They live in {@link InstallRefreshResult} instead.
   */
  reason?: 'not-git' | 'not-found' | 'fetch-failed' | 'fetch-timeout';
  /**
   * The failing fetch's path-free diagnostic codes, verbatim — `reason` folds
   * several of them (a missing manifest, a refused clone) into `'fetch-failed'`,
   * and this is what tells them apart at a user-facing surface.
   */
  diagnosticCodes?: string[];
}

/**
 * {@link MarketplaceRegistryController.refreshForInstall}'s result: an upgrade
 * result plus the two verdicts that mean the page's skip list fired rather than
 * a fetch failing. `'recently-refreshed'` — refreshed inside the 30-second
 * window; `'nonessential-traffic-disabled'` —
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Neither is a failure, and
 * neither crosses the RPC upgrade seam.
 */
export interface InstallRefreshResult extends Omit<RegistryUpgradeResult, 'reason'> {
  reason?: RegistryUpgradeResult['reason'] | 'recently-refreshed' | 'nonessential-traffic-disabled';
}

export interface RegistryRemoveResult {
  marketplaceId: string;
  removed: boolean;
}

/** Path-free list-registries row (NO source path / installedRoot). */
export interface RegistrySummaryRow {
  marketplaceId: string;
  displayName: string;
  refName?: string;
  /**
   * The EFFECTIVE auto-update answer (`settings-reference.md#extraknownmarketplaces`'s
   * `autoUpdate`) — already resolved
   * through managed value → user toggle → default polarity, so the UI toggle
   * renders one Boolean and never has to re-derive the precedence.
   */
  autoUpdate: boolean;
  /**
   * True when the managed policy declared `autoUpdate` for this marketplace, so
   * the value above is the administrator's and the user's toggle cannot move it.
   * The renderer disables the control rather than offering a click that silently
   * does nothing.
   */
  autoUpdateManaged: boolean;
}

/** What one scheduled auto-update pass did. Path-free; ids only. */
export interface RegistryAutoUpdateRunResult {
  /** Registries whose effective auto-update flag was on. */
  considered: string[];
  /** Registries whose catalog actually moved to fresh bytes. */
  refreshed: string[];
  /**
   * Registries whose refresh did NOT land, with the typed reason (P2.159).
   *
   * The pass used to return `{considered, refreshed}` only, and its caller then
   * `return`ed early whenever `refreshed` was empty — so a marketplace that
   * failed every attempt produced no line naming it and no evidence the pass had
   * even tried. Ids and a fixed reason enum only, like
   * {@link RegistryUpgradeResult.reason}; never a message, path or source.
   */
  failed: Array<{ marketplaceId: string; reason: NonNullable<RegistryUpgradeResult['reason']> }>;
}

export interface RegistrySetAutoUpdateResult {
  marketplaceId: string;
  autoUpdate: boolean;
}

/**
 * One catalog the product knows about and has NOT added (P6.517/P6.518).
 *
 * Path-free by construction: a public `owner/repo` slug, a name and one English
 * line. Present in the list so the "off" state is a state the UI can render,
 * rather than an absence a user has to know about to ask for.
 */
export interface BuiltInMarketplaceOffer {
  name: string;
  source: string;
  description: string;
}

export interface RegistryListSummary {
  registries: RegistrySummaryRow[];
  /**
   * The built-in catalogs still switched off. An administrator's allowlist or
   * blocklist removes an entry from here, so the affordance never offers a click
   * their policy would refuse.
   */
  available: BuiltInMarketplaceOffer[];
}

/**
 * The full registry controller the R3 RPC handlers depend on: the browse-merge
 * `listItems()` plus the add/upgrade/remove/list mutations. `HandlerDeps` carries
 * this so the handler can inject `listItems` into `MarketplaceService` AND drive
 * the mutation channels; tests stub the interface.
 */
export interface MarketplaceRegistryController extends MarketplaceRegistrySource {
  add(request: {
    source: string;
    refName?: string;
    sparsePaths?: string[];
    displayName?: string;
    autoUpdate?: boolean;
    /** P3.220 — already-filtered catalog-fetch headers; delivery path only. */
    headers?: Record<string, string>;
  }): Promise<RegistryAddResult>;
  upgrade(request: { marketplaceId: string }): Promise<RegistryUpgradeResult>;
  /**
   * The refresh `plugins/install.md#install-a-plugin` puts AHEAD of a named
   * install: "when you install `plugin-name@marketplace-name`, in a session or
   * with `claude plugin install`, Claude Code refreshes that marketplace before
   * the lookup." The same paragraph says the refresh runs "even if you turned
   * off auto-update for the marketplace or set `DISABLE_AUTOUPDATER`", so this
   * is deliberately NOT gated on the auto-update flag {@link
   * refreshAutoUpdateMarketplaces} reads.
   *
   * Three of the page's five skip conditions apply to this fork, and each is
   * satisfied here or one layer down:
   *  - not added from a Git host / remote URL — {@link upgrade} already reports
   *    `'not-git'` without fetching;
   *  - refreshed within the last 30 seconds — the window below, read off
   *    `lastUpgradedAt`;
   *  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` — refused before the fetch.
   * The remaining two describe surfaces this fork does not have: a seed
   * directory, and a managed block, which {@link upgrade} already THROWS for
   * (`plugin-marketplaces` managed restrictions) so the install is refused
   * rather than resolved from cache.
   *
   * Fetch failure is NOT an error here: the page's next paragraph is "if the
   * refresh before a named install fails, for example because you're offline,
   * Claude Code looks the plugin up in the cached catalog anyway", which is
   * exactly what a `{upgraded: false, reason: 'fetch-failed'}` return lets the
   * caller do.
   */
  refreshForInstall(request: { marketplaceId: string }): Promise<InstallRefreshResult>;
  /**
   * `plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace` — the plugin manager's per-marketplace
   * "Enable auto-update" / "Disable auto-update". Refused for a marketplace the
   * managed policy already decided, so a user click can never silently lose to
   * an administrator's value.
   */
  setAutoUpdate(request: { marketplaceId: string; autoUpdate: boolean }): Promise<RegistrySetAutoUpdateResult>;
  /**
   * `plugins/loading.md#when-auto-update-runs`'s post-startup check: re-fetch the catalog of
   * every marketplace whose effective auto-update flag is on, and nothing else.
   * NEVER throws — one broken registry must not take the pass down.
   */
  refreshAutoUpdateMarketplaces(): Promise<RegistryAutoUpdateRunResult>;
  /**
   * The ids of the registered marketplaces whose `relevance` declarations the
   * managed `pluginSuggestionMarketplaces` allowlist admits — name AND
   * registered source, per `settings-reference.md#pluginsuggestionmarketplaces`.
   * Empty whenever the key is absent,
   * which is every unmanaged install.
   */
  listSuggestionAllowedRegistryIds(): Promise<string[]>;
  /**
   * Register every marketplace the managed policy delivers. Idempotent, and safe
   * to call on any read path: with no delivered entries it is a synchronous
   * no-op.
   */
  ensureDeliveredMarketplaces(): Promise<DeliveredMarketplaceOutcome[]>;
  remove(request: { marketplaceId: string }): Promise<RegistryRemoveResult>;
  list(): Promise<RegistryListSummary>;
  /**
   * Turn one built-in catalog on, by NAME. The source is read from
   * `built-in-marketplaces.ts` and never taken from the caller, so a surface that
   * can reach this call still cannot choose what gets added; everything else —
   * allowlist, blocklist, reserved names, dedupe — is {@link add} unchanged.
   */
  enableBuiltInMarketplace(request: { name: string }): Promise<RegistryAddResult>;
  /**
   * Resolve ONE browse item from a registry's cached catalog by its id, WITHOUT
   * triggering a network re-fetch. Install uses this so a bring-your-own registry
   * item is built from the durable `structuredInstallSource` the catalog already
   * carries — never routed through the Skills Market HTTP client (whose ids
   * differ, so a registry id `<registryId>:<name>` 404s there). Returns undefined
   * when the registry is unknown or its catalog is not currently cached.
   */
  findCatalogItem(marketplaceRegistryId: string, itemId: string): Promise<MarketplaceCatalogItem | undefined>;
  /**
   * Every ALREADY-RESOLVED catalog row, for a caller that must not cost
   * anything. See {@link PluginRegistrySource.peekCachedItems} for the four
   * things it deliberately does not do.
   */
  peekCachedItems(): Promise<MarketplaceCatalogItem[]>;
}

/**
 * The narrow reader the per-turn update-availability probe depends on. Named
 * separately from {@link MarketplaceRegistryController} so the capability path
 * takes a dependency it cannot possibly mutate anything through.
 */
export interface CachedMarketplaceCatalogReader {
  peekCachedItems(): Promise<MarketplaceCatalogItem[]>;
  /**
   * Resolve ONE row from a BYO registry's cached catalog. Cache-only, exactly
   * like `peekCachedItems`: no network re-fetch and no retry-budget spend, so a
   * capability-path caller cannot cost anything through this reader.
   */
  findCatalogItem?(marketplaceRegistryId: string, itemId: string): Promise<MarketplaceCatalogItem | undefined>;
  /**
   * P6.424 — the suggestion allowlist, for a caller that renders a suggestion
   * but must not be able to change one. Optional on this narrow reader so a
   * double that only feeds cached rows still satisfies it;
   * {@link PluginRegistrySource} implements it, and the session-start notice
   * simply stays silent when a reader does not.
   *
   * Reading it here rather than re-deriving the allowlist is the point: the
   * source-correspondence half (`isSuggestionAllowed`) needs the registered
   * rows, `extraKnownMarketplaces` and `strictKnownMarketplaces` in scope at
   * once, and a second copy of that rule is a second thing to keep in step.
   */
  listSuggestionAllowedRegistryIds?(): Promise<string[]>;
}

/**
 * The R3 registry source. `listItems()` satisfies the `MarketplaceRegistrySource`
 * contract the R2 `MarketplaceService` consumes; the mutation methods back the
 * add/upgrade/remove/list RPC handlers.
 */
export class PluginRegistrySource implements MarketplaceRegistryController {
  private readonly store: MarketplaceRegistryStore;
  private readonly staging: RegistryStagingService;
  private readonly baseTempDir?: string;
  private readonly now: () => number;
  /** See {@link MarketplaceRegistrySourceOptions.env}. */
  private readonly env: Record<string, string | undefined>;
  private readonly fetchTimeoutMs: number;
  private readonly catalogCacheDir?: string;
  private readonly maxConcurrentFetches: number;
  /**
   * The boot snapshot of the four managed marketplace lists. Read only when no
   * resolver is wired, or when a wired resolver throws — see {@link
   * MarketplaceRegistrySourceOptions.resolveManagedMarketplacePolicy} and the
   * four getters below, which are what every gate in this class actually reads.
   */
  private readonly snapshot: ManagedMarketplacePolicySlice;
  private readonly resolveManagedMarketplacePolicy?: () => ManagedMarketplacePolicySlice;
  /** One warning per source, not one per gate call: a broken policy is noisy. */
  private warnedResolverFailure = false;
  /** Single-flight delivery: every read path may call it, one run does it. */
  private deliveryRun?: Promise<DeliveredMarketplaceOutcome[]>;
  /** Last resolved catalog per registry id — survives across list requests. */
  private readonly catalogCache = new Map<string, CachedRegistryEntry>();
  /** Single-flight in-flight fetches keyed by registry id. */
  private readonly inFlight = new Map<string, { signature: string; promise: Promise<CachedRegistryEntry> }>();
  /** Global fetch-concurrency gate (see {@link DEFAULT_MAX_CONCURRENT_FETCHES}). */
  private runningFetches = 0;
  private readonly fetchWaiters: Array<() => void> = [];
  /** In-flight disk-cache writes — drained by {@link awaitPendingFetches}. */
  private readonly pendingPersists = new Set<Promise<void>>();

  constructor(options: MarketplaceRegistrySourceOptions) {
    this.store = options.store;
    this.staging = options.staging;
    this.baseTempDir = options.baseTempDir;
    this.now = options.now ?? (() => Date.now());
    this.env = options.env ?? process.env;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS;
    this.catalogCacheDir = options.catalogCacheDir;
    this.maxConcurrentFetches = options.maxConcurrentFetches ?? DEFAULT_MAX_CONCURRENT_FETCHES;
    this.snapshot = {
      ...(options.strictKnownMarketplaces === undefined
        ? {}
        : { strictKnownMarketplaces: options.strictKnownMarketplaces }),
      ...(options.blockedMarketplaces === undefined
        ? {}
        : { blockedMarketplaces: options.blockedMarketplaces }),
      extraKnownMarketplaces: options.extraKnownMarketplaces ?? [],
      ...(options.pluginSuggestionMarketplaces === undefined
        ? {}
        : { pluginSuggestionMarketplaces: options.pluginSuggestionMarketplaces }),
    };
    this.resolveManagedMarketplacePolicy = options.resolveManagedMarketplacePolicy;
  }

  /**
   * P2.501 — the managed marketplace lists AS OF NOW.
   *
   * Every gate in this class reads the four getters below rather than a field,
   * so an administrator's edit reaches the next marketplace add / install /
   * update / refresh instead of the next process start. With no resolver wired
   * this is the constructor snapshot and nothing changes.
   */
  private managedMarketplacePolicy(): ManagedMarketplacePolicySlice {
    if (!this.resolveManagedMarketplacePolicy) return this.snapshot;
    try {
      return this.resolveManagedMarketplacePolicy();
    } catch (error) {
      // Fall back to the BOOT policy, never to nothing: for a blocklist the
      // fail-safe direction is to keep enforcing what we last knew. Said out
      // loud, once, because a gate quietly running on stale policy is the shape
      // this row exists to remove.
      if (!this.warnedResolverFailure) {
        this.warnedResolverFailure = true;
        console.warn(
          '[MarketplaceRegistrySource] managed marketplace policy could not be re-resolved; '
          + 'still enforcing the policy read at startup. '
          + (error instanceof Error ? error.message : String(error)),
        );
      }
      return this.snapshot;
    }
  }

  private get strictKnownMarketplaces(): readonly ManagedMarketplaceEntryV1[] | undefined {
    return this.managedMarketplacePolicy().strictKnownMarketplaces;
  }

  private get blockedMarketplaces(): readonly ManagedMarketplaceEntryV1[] | undefined {
    return this.managedMarketplacePolicy().blockedMarketplaces;
  }

  private get extraKnownMarketplaces(): readonly DeliveredMarketplaceEntryV1[] {
    return this.managedMarketplacePolicy().extraKnownMarketplaces ?? [];
  }

  private get pluginSuggestionMarketplaces(): readonly string[] | undefined {
    return this.managedMarketplacePolicy().pluginSuggestionMarketplaces;
  }

  /**
   * Register the delivered marketplaces, once.
   *
   * `settings-reference.md#extraknownmarketplaces` gates a REPOSITORY-declared
   * marketplace on the workspace trust dialog: "Claude Code honors entries in a
   * repository's `.claude/settings.json` or `.claude/settings.local.json` only
   * after you accept the workspace trust dialog for that folder; in a folder you
   * haven't trusted, including a `-p` run there, it ignores them without a
   * message." That gate exists because there the declaration rides an untrusted
   * repository. This one rides MANAGED POLICY, which is host-owned and already
   * the authority for `strictKnownMarketplaces`, `enabledPlugins` and every deny
   * in the tier — a prompt there would be asking the user to ratify their own
   * administrator. Registering a marketplace is also not installing a plugin,
   * and every plugin-install gate is untouched here.
   *
   * This comment used to quote the page describing that gate as a per-marketplace
   * PROMPT a user could skip, and installation as requiring explicit consent.
   * Neither sentence is on any page of Claude's documentation index any more
   * (checked 2026-09-10 over the 191-page snapshot in
   * `scripts/claude-doc-pages.tsv`; positive control `extraKnownMarketplaces`
   * hits 13 pages on the same rig). The trust gate is what survived, so it is
   * what is cited — the reasoning above never depended on the prompt's wording.
   *
   * Called from the read paths rather than from a bootstrap hook so the
   * delivered rows are present on the first read that could observe them, with
   * no second registration path to keep in step.
   *
   * ## The stated limit: release channels reach a fleet, not a group (P6.248)
   *
   * `plugins/host-marketplace.md#run-release-channels` builds a stable/latest
   * split out of two halves. The FIRST half is native here and complete: "you
   * can set up two marketplaces that point to different refs or SHAs of the same
   * repo" — `refName` is carried on the registry row, honoured by the allowlist
   * check, and settable both from policy and from the add-marketplace field, so
   * an operator can run two ref-pinned marketplaces and deliver one through this
   * method.
   *
   * The SECOND half is out of reach, and this sentence exists so the absence is
   * a stated limit rather than a silent one. The page assigns a channel to a
   * user GROUP two ways, and both are delivery mechanisms this fork does not
   * have: "Deploy separate endpoint-managed settings, such as a managed settings
   * file or an MDM profile, to each group's devices", or "Define one Claude apps
   * gateway policy per group". `extraKnownMarketplaces` here is a SINGLE managed
   * policy source with no per-group match rule, so every device that reads the
   * policy gets the same channel. The page's own closing line describes the same
   * ceiling for the one tier it rules out: "Server-managed settings from the
   * admin console apply to every user in your organization, so they can't carry
   * a per-group assignment."
   *
   * Two channels for two FLEETS is therefore expressible today (two policy
   * sources, two device populations); two channels for two groups on one policy
   * source is not, and no amount of work inside this class would make it so —
   * it is a managed-DELIVERY question, not a marketplace one. Recorded in
   * `docs/architecture/unified-plugin-adapter-runtime.md` § Deferred.
   */
  ensureDeliveredMarketplaces(): Promise<DeliveredMarketplaceOutcome[]> {
    if (this.extraKnownMarketplaces.length === 0) return Promise.resolve([]);
    this.deliveryRun ??= this.deliverMarketplaces();
    return this.deliveryRun;
  }

  private async deliverMarketplaces(): Promise<DeliveredMarketplaceOutcome[]> {
    const outcomes: DeliveredMarketplaceOutcome[] = [];
    for (const entry of this.extraKnownMarketplaces) {
      try {
        const result = await this.add({
          source: entry.source,
          ...(entry.refName ? { refName: entry.refName } : {}),
          displayName: entry.name,
          // `settings-reference.md#extraknownmarketplaces`'s `autoUpdate`. Seeded
          // onto the row so the value survives a
          // restart even if the policy is later withdrawn; while the policy is
          // present {@link managedAutoUpdateFor} outranks the stored copy, so a
          // revised policy is honoured on the very next resolution.
          ...(entry.autoUpdate === undefined ? {} : { autoUpdate: entry.autoUpdate }),
          // P3.220 — the entry's own catalog-fetch credential. Delivered
          // through the SAME add path as every other field, so a policy-supplied
          // marketplace and a hand-added one still differ in exactly one thing:
          // who wrote the row.
          ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }),
        });
        outcomes.push({
          name: entry.name,
          state: result.alreadyAdded ? 'already-present' : 'registered',
          marketplaceId: result.marketplaceId,
        });
      } catch (error) {
        // The allowlist refusal is a POLICY outcome, not a failure: an
        // administrator who narrowed sources and then delivered one outside the
        // narrowing gets the narrowing. A reserved-name refusal is the same kind
        // of outcome under a different rule, and gets its own state so the two
        // are told apart — the remedies are opposite (widen the allowlist vs
        // rename the entry). A BLOCKLIST refusal is the third of that family
        // (P2.467) and reads the strangest of the three, which is exactly why it
        // gets its own state: the administrator delivered a marketplace their own
        // `blockedMarketplaces` blocks, and the remedy is to remove the blocklist
        // entry rather than to widen anything. Everything else (a store write
        // that failed, an empty source) is reported as a failure so one bad entry
        // never stops the rest from being delivered.
        outcomes.push({
          name: entry.name,
          state: deliveryRefusalState(error),
        });
      }
    }
    return outcomes;
  }

  /**
   * `plugins/org.md#how-entries-match` — "Restrictions are checked before any network
   * or filesystem operation." Pure by construction: the identity classifier does
   * no filesystem probing, so calling this first is genuinely first.
   */
  private isSourceAllowed(source: string, refName?: string): boolean {
    return isManagedMarketplaceAllowed(
      this.strictKnownMarketplaces,
      managedMarketplaceSourceIdentity(source, refName),
    );
  }

  /**
   * The `blockedMarketplaces` entry that refuses this source, as a path-free
   * token, or `undefined` (P2.467).
   *
   * A SECOND question rather than a stricter reading of the first, and always
   * asked: `settings-reference.md#blockedmarketplaces` makes the blocklist
   * independent of the allowlist — an administrator may deploy either alone, and
   * with no allowlist at all `isSourceAllowed` answers `true` for everything.
   * Folding the blocklist into that predicate would have made it unreachable in
   * exactly the deployment the key is written for.
   *
   * Pure, like its sibling, so both can honour
   * `plugins/org.md#how-entries-match`'s "Restrictions are checked
   * before any network or filesystem operation" and the reference's "Blocked
   * sources are checked before download, so they never touch the filesystem".
   */
  private blockedSourceEntry(source: string, refName?: string): string | undefined {
    const entry = blockedMarketplaceEntryFor(
      this.blockedMarketplaces,
      managedMarketplaceSourceIdentity(source, refName),
    );
    return entry === undefined ? undefined : describeManagedMarketplaceEntry(entry);
  }

  /**
   * The reserved name this registry would present itself under, or `undefined`
   * when it presents itself under a name nobody reserved.
   *
   * `plugins/marketplace-reference.md#reserved-names` — "Reserving these names prevents a
   * third-party marketplace from presenting itself as an Anthropic-published
   * source." The name a Nessy marketplace presents itself under is
   * {@link registryDisplayName}: the label the administrator gave it, else the
   * one derived from the source. So that is the string checked, and it is the
   * same string `isSuggestionAllowed` matches the managed allowlist on.
   *
   * The exemption is the page's own: a reserved name is permitted when the
   * source really IS the official Anthropic marketplace. That predicate already
   * exists, because `isSuggestionAllowed` needed it — and its docblock records
   * that "this fork enforces no such reservation, so checking the source here is
   * what makes the sentence true HERE rather than merely quoted". This method is
   * that missing reservation; the two now agree instead of one apologising for
   * the other.
   */
  private reservedNameCollision(name: string, source: string, refName?: string): string | undefined {
    const reserved = reservedMarketplaceNameFor(name);
    if (reserved === undefined) return undefined;
    return isOfficialAnthropicMarketplaceSource(source, refName) ? undefined : reserved;
  }

  /**
   * Browse-list projection of every persisted registry. This NEVER blocks on a
   * network clone: a registry whose catalog is already cached is served
   * straight from memory; an uncached (or stale) registry kicks a single-flight
   * background fetch and rides out as a path-free `fetch_pending` load error —
   * its staged items appear on the next poll/refetch once the fetch settles.
   * Per-registry failures are collected as path-free
   * `MarketplaceRegistryLoadError[]`; one broken registry never fails the list.
   */
  async listItems(): Promise<MarketplaceRegistryListResult> {
    await this.ensureDeliveredMarketplaces();
    const { registries } = await this.store.readMarketplaceRegistries();
    const items: MarketplaceRegistryListResult['items'] = [];
    const loadErrors: MarketplaceRegistryLoadError[] = [];

    for (const registry of registries) {
      const signature = registrySignature(registry);
      let cached = this.catalogCache.get(registry.id);
      // Cold start: hydrate the in-memory cache from the on-disk parsed catalog
      // before deciding to clone. A signature match means NO network at all.
      if ((!cached || cached.signature !== signature)) {
        const fromDisk = await this.loadDiskEntry(registry.id, signature);
        if (fromDisk) {
          this.catalogCache.set(registry.id, fromDisk);
          cached = fromDisk;
        }
      }
      if (cached && cached.signature === signature) {
        items.push(...cached.items);
        if (cached.loadError) loadErrors.push(cached.loadError);
        // P6.621 — the rename announcement, beside (never instead of) a real
        // failure: both can be true of the same registry at once.
        if (cached.renameNotice) loadErrors.push(cached.renameNotice);
        // A cached FAILURE is not a resolved catalog, so it must not silence
        // further fetches the way a success does. Keep serving what we have and
        // keep trying, until the retry budget is spent.
        if (
          cached.failedFetch
          && (cached.retriesLeft ?? 0) > 0
          && this.inFlight.get(registry.id)?.signature !== signature
        ) {
          this.catalogCache.set(registry.id, { ...cached, retriesLeft: (cached.retriesLeft ?? 0) - 1 });
          this.ensureBackgroundFetch(registry, signature);
        }
        continue;
      }
      // Uncached / stale → fetch OFF the request path so a cold clone through a
      // slow network can never hang the browse list.
      this.ensureBackgroundFetch(registry, signature);
      loadErrors.push(pendingLoadError(registry.id, registryDisplayName(registry)));
    }

    return {
      items,
      ...(loadErrors.length ? { loadErrors } : {}),
    };
  }

  /**
   * Every already-resolved catalog's rows, at zero cost and with zero effect.
   *
   * `listItems()` is the wrong read for a caller on a per-turn path, and not
   * only because it is slower — it is not a read at all in three places:
   *
   * 1. it opens with `await this.ensureDeliveredMarketplaces()`, whose first
   *    call `add()`s the managed marketplaces and therefore WRITES
   *    `marketplaces.json`;
   * 2. an uncached or stale registry gets `ensureBackgroundFetch()`, i.e. a git
   *    clone, kicked off the request path;
   * 3. a registry whose last fetch FAILED has its retry budget decremented and a
   *    fresh fetch kicked, so a background caller would silently spend the
   *    retries the browse list is meant to spend.
   *
   * Capability resolution runs once per turn
   * (`storage-runtime.ts:buildCapabilityResolutionInputsV2`), so all three would
   * be paid per turn. This does none of them: it reads the persisted registry
   * rows, serves the in-memory catalog for every signature that matches, and
   * hydrates that cache from the on-disk parsed catalog on a miss — which is
   * exactly what the disk cache exists for, and what makes a badge survive a
   * restart without a single network call. A registry with no resolved catalog
   * is simply absent; there is no `fetch_pending` error because no fetch was
   * requested.
   */
  async peekCachedItems(): Promise<MarketplaceCatalogItem[]> {
    const { registries } = await this.store.readMarketplaceRegistries();
    const items: MarketplaceCatalogItem[] = [];
    for (const registry of registries) {
      const signature = registrySignature(registry);
      let cached = this.catalogCache.get(registry.id);
      if (!cached || cached.signature !== signature) {
        const fromDisk = await this.loadDiskEntry(registry.id, signature);
        if (fromDisk) {
          this.catalogCache.set(registry.id, fromDisk);
          cached = fromDisk;
        }
      }
      if (cached?.signature === signature) items.push(...cached.items);
    }
    return items;
  }

  /**
   * Resolve once every in-flight background registry fetch has settled. The
   * browse list itself NEVER awaits this (it must not block); it is the
   * deterministic completion seam for callers/tests that want the staged
   * catalog resolved before the next `listItems()` read.
   */
  async awaitPendingFetches(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map(entry => entry.promise));
    // Each settled fetch commits its entry (populating pendingPersists) before
    // its allSettled slot resolves, so the set is fully seeded by now.
    await Promise.allSettled([...this.pendingPersists]);
  }

  /**
   * Resolve one cached browse item by id WITHOUT re-cloning. Hydrates the
   * in-memory cache from the on-disk parsed catalog when needed (mirroring
   * {@link listItems}), then returns the item whose id matches. A signature
   * mismatch, unknown registry, or absent cache yields undefined so install
   * fails with a clean typed error rather than kicking a network fetch. The
   * item carries the durable `structuredInstallSource` install routes through.
   */
  async findCatalogItem(
    marketplaceRegistryId: string,
    itemId: string,
  ): Promise<MarketplaceCatalogItem | undefined> {
    await this.ensureDeliveredMarketplaces();
    const { registries } = await this.store.readMarketplaceRegistries();
    const registry = registries.find(entry => entry.id === marketplaceRegistryId);
    if (!registry) return undefined;
    const signature = registrySignature(registry);
    let cached = this.catalogCache.get(registry.id);
    if (!cached || cached.signature !== signature) {
      const fromDisk = await this.loadDiskEntry(registry.id, signature);
      if (fromDisk) {
        this.catalogCache.set(registry.id, fromDisk);
        cached = fromDisk;
      }
    }
    if (!cached || cached.signature !== signature) return undefined;
    return cached.items.find(item => item.id === itemId);
  }

  /**
   * Start a single-flight background fetch for a registry unless an equivalent
   * one (same signature) is already running. On completion the cache is
   * populated — but only if a newer fetch (e.g. an `upgrade()`) has not
   * superseded this one. Fire-and-forget: `fetchRegistryEntry` never rejects.
   */
  private ensureBackgroundFetch(registry: PluginMarketplaceRegistry, signature: string): void {
    const existing = this.inFlight.get(registry.id);
    if (existing && existing.signature === signature) return;
    // Gate the actual clone behind the global concurrency cap so N uncached
    // registries never clone at once. The promise is registered immediately so
    // single-flight + awaitPendingFetches still see it while it waits its turn.
    const promise = this.withFetchSlot(() => this.fetchRegistryEntry(registry, signature));
    this.inFlight.set(registry.id, { signature, promise });
    void promise.then(entry => {
      const current = this.inFlight.get(registry.id);
      if (current && current.promise === promise) {
        this.commitEntry(registry.id, entry);
        this.inFlight.delete(registry.id);
      }
    });
  }

  /**
   * Commit a resolved entry to the in-memory cache and, when it came from a
   * definitive successful fetch, persist a path-free projection to disk (fire-
   * and-forget; a cache-write failure must never break browse).
   */
  private commitEntry(
    registryId: string,
    entry: CachedRegistryEntry,
    /**
     * P6.621 — the catalog name to compare against, for the ONE caller that has
     * already overwritten the cache slot before committing: `upgrade()` seeds the
     * fresh items under the previous signature so an interleaving reader still
     * resolves, and that seed carries the NEW name. Every other caller leaves the
     * previous entry in place, so the default reads it off the cache.
     */
    previousCatalogName = this.catalogCache.get(registryId)?.catalogName,
  ): void {
    if (!entry.persistable) {
      this.catalogCache.set(registryId, this.mergeFailedFetch(registryId, entry));
      return;
    }
    this.catalogCache.set(registryId, this.announceRename(registryId, entry, previousCatalogName));
    const write = this.persistDiskEntry(registryId, entry).finally(() => this.pendingPersists.delete(write));
    this.pendingPersists.add(write);
  }

  /**
   * P6.621 — a marketplace that renamed ITSELF between two refreshes says so, on
   * both arms.
   *
   * A marketplace's catalog declares its own `name`, and until this row nothing
   * compared one refresh's answer against the last: the label a user sees is
   * derived from the SOURCE, so a catalog could rename itself under an operator
   * and leave no trace anywhere. Both announcements are made here, at the one
   * point where the previous catalog and the new one are both in hand:
   *
   *  - the DURABLE channel — `console.warn`, this module's own operator channel,
   *    the same one a refused marketplace and a failed fetch already use, naming
   *    both spellings so the change is legible without a catalog diff;
   *  - the PLUGINS PAGE — a `marketplace.registry.renamed` code on the
   *    `registryLoadErrors` channel, which the page already renders as the
   *    section's note. Riding that channel rather than inventing one is the same
   *    move `fetch_pending` made, and for the same reason.
   *
   * TWO PROPERTIES WORTH KNOWING. A FIRST sighting is not a rename: with no
   * previous name recorded nothing is announced, so adding a marketplace is
   * silent. And the comparison needs the previous catalog to be in this process's
   * cache — hydrated from disk on any browse, or committed by an earlier fetch —
   * so a rename that lands on the very first refresh after a restart, before
   * anything has read the old catalog, is not announced. That is a stated
   * limitation and not a silent one: the alternative is a second durable record
   * of marketplace names with its own lifecycle, which is more machinery than an
   * announcement is worth.
   */
  private announceRename(
    registryId: string,
    entry: CachedRegistryEntry,
    previousName: string | undefined,
  ): CachedRegistryEntry {
    const currentName = entry.catalogName;
    if (!previousName || !currentName || previousName === currentName) return entry;
    console.warn(
      `[marketplace-registry] marketplace renamed (${registryId}):`
      + ` "${previousName}" is now "${currentName}"`,
    );
    return {
      ...entry,
      renameNotice: {
        marketplaceRegistryId: registryId,
        displayName: currentName,
        diagnosticCodes: ['marketplace.registry.renamed'],
      },
    };
  }

  /**
   * Fold a FAILED fetch into the cache without letting it stand in for a
   * catalog. `mcp.md` records the identical bug one subsystem over — "If a
   * refresh request fails, Claude Code keeps the server's previously discovered
   * tools, prompts, and resources until a later refresh succeeds. Before
   * v2.1.214, a transient error during the refresh replaced the server's tools,
   * prompts, and resources with an empty list." — and this is the marketplace
   * half of it: the last catalog we actually resolved keeps being served,
   * re-keyed to the signature the failed fetch was trying to satisfy, with the
   * failure recorded beside it and a bounded retry so the staleness ends.
   *
   * The re-key is deliberately failure-only: a signature mismatch on its own
   * still refuses to resolve, because the signature is what stops an install
   * binding to a catalog the registry has moved past. It is loosened here, and
   * only here, because the alternative measured worse — a cached failure was
   * indistinguishable from a cached empty success, so ONE transient clone
   * failure emptied the registry for the rest of the process lifetime.
   *
   * The orphaned on-disk catalog is NOT deleted: after a failed refresh it is
   * the only surviving copy, and removing it turns a recoverable state into an
   * unrecoverable one.
   */
  private mergeFailedFetch(registryId: string, failed: CachedRegistryEntry): CachedRegistryEntry {
    const previous = this.catalogCache.get(registryId);
    return {
      signature: failed.signature,
      items: previous?.items.length ? previous.items : failed.items,
      ...(failed.loadError ? { loadError: failed.loadError } : {}),
      persistable: false,
      failedFetch: true,
      // A retry that fails again inherits what is left of the budget; anything
      // else (a first failure, or one after a success) starts a fresh one.
      retriesLeft: previous?.failedFetch ? previous.retriesLeft ?? 0 : FETCH_RETRIES_AFTER_FAILURE,
    };
  }

  /**
   * Acquire a global fetch slot, run `fn`, and release the slot when it settles
   * (including on timeout). A queued waiter is handed the slot directly so the
   * running count never dips below the number of active fetches.
   *
   * When a slot is free it is taken WITHOUT awaiting, so `fn` runs in the same
   * microtask the caller scheduled it in (the browse list relies on the fetch
   * being kicked synchronously off the request path).
   */
  private async withFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.runningFetches < this.maxConcurrentFetches) {
      this.runningFetches += 1;
    } else {
      // Cap reached — queue until a running fetch hands us its slot.
      await new Promise<void>(resolve => this.fetchWaiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      this.releaseFetchSlot();
    }
  }

  private releaseFetchSlot(): void {
    const next = this.fetchWaiters.shift();
    if (next) next();
    else this.runningFetches -= 1;
  }

  /** Absolute path of a registry's on-disk catalog cache file. */
  private diskPath(registryId: string): string | undefined {
    if (!this.catalogCacheDir) return undefined;
    return join(this.catalogCacheDir, `${encodeURIComponent(registryId)}.json`);
  }

  /**
   * Read a registry's persisted catalog, returning it ONLY when the schema and
   * `signature` match (a stale/mismatched/absent/corrupt file yields undefined
   * so the caller falls back to a fetch). Never throws.
   */
  private async loadDiskEntry(registryId: string, signature: string): Promise<CachedRegistryEntry | undefined> {
    const path = this.diskPath(registryId);
    if (!path) return undefined;
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as PersistedCatalogEntry;
      if (parsed?.schemaVersion !== CATALOG_CACHE_SCHEMA_VERSION) return undefined;
      if (parsed.signature !== signature || !Array.isArray(parsed.items)) return undefined;
      return {
        signature: parsed.signature,
        items: parsed.items,
        ...(parsed.loadError ? { loadError: parsed.loadError } : {}),
        ...(typeof parsed.catalogName === 'string' ? { catalogName: parsed.catalogName } : {}),
        // Already on disk with a matching signature — no need to rewrite it.
        persistable: false,
      };
    } catch {
      return undefined;
    }
  }

  /** Atomically persist a path-free projection of a resolved entry. Never throws. */
  private async persistDiskEntry(registryId: string, entry: CachedRegistryEntry): Promise<void> {
    const path = this.diskPath(registryId);
    if (!path) return;
    const payload: PersistedCatalogEntry = {
      schemaVersion: CATALOG_CACHE_SCHEMA_VERSION,
      registryId,
      signature: entry.signature,
      items: entry.items,
      ...(entry.loadError ? { loadError: entry.loadError } : {}),
      ...(entry.catalogName ? { catalogName: entry.catalogName } : {}),
      updatedAt: this.now(),
    };
    try {
      await writeJsonAtomic(path, payload);
    } catch {
      // Best-effort cache write — never surface to the browse path.
    }
  }

  /** Remove a registry's on-disk catalog cache file (best-effort). */
  private async removeDiskEntry(registryId: string): Promise<void> {
    const path = this.diskPath(registryId);
    if (!path) return;
    await rm(path, { force: true }).catch(() => {});
  }

  /**
   * Fetch + parse ONE registry into a cache-ready entry, bounded by
   * {@link fetchTimeoutMs}. NEVER rejects: a timeout, staging error, parse
   * error, or unexpected throw all become a path-free per-registry load error.
   */
  private async fetchRegistryEntry(
    registry: PluginMarketplaceRegistry,
    signature: string,
  ): Promise<CachedRegistryEntry> {
    const entry = await this.resolveRegistryEntry(registry, signature);
    // A registry that never loaded has to SAY so. Until this line the ONLY
    // evidence a catalog fetch had failed was the aggregate "Some marketplaces
    // could not be loaded." banner: three registries added as `owner/repo`
    // shorthand failed in 4ms without one line in main.log for `registry`,
    // `clone` or `fetch`, so the silence read as "the fetch never ran".
    //
    // `console.warn` deliberately, NOT `createLogger` — every level of that
    // logger is gated on `isDebugEnabled()` (`utils/debug.ts`), so a failure
    // logged through it is invisible in a normal run, which is precisely the
    // run where it matters. Path-free by construction: the registry id, its
    // display label and the diagnostic CODES, never the source path or a
    // staged temp dir.
    //
    // "catalog fetch failed" is the wrong verb for a REFUSAL, and this line used
    // it for all four codes — an in-place fix found while adding the fifth
    // (P2.467). A managed-policy refusal and a network fault read identically in
    // main.log and have opposite remedies, which is the same defect P2.429 closed
    // on the renderer side of this very code path: nothing was ever fetched, so
    // nothing failed to fetch.
    if (entry.loadError) {
      const refused = entry.loadError.diagnosticCodes.some(code => (
        code === 'marketplace.registry.source_not_allowed'
        // P2.482. Both halves of that row move together or neither does: a code
        // added to the branch below and not to this list silently rejoins the
        // "catalog fetch failed" wording — the exact verb P2.467 already had to
        // fix once, on these same lines.
        || code === 'marketplace.registry.source_blocked'
        || code === 'marketplace.registry.reserved_name'
      ));
      console.warn(
        `[marketplace-registry] ${refused ? 'marketplace refused' : 'catalog fetch failed'}`
        + ` for "${entry.loadError.displayName ?? 'unnamed marketplace'}"`
        + ` (${entry.loadError.marketplaceRegistryId}):`
        + ` ${entry.loadError.diagnosticCodes.join(', ') || 'no diagnostic code'}`,
      );
    }
    return entry;
  }

  /**
   * P6.479 — the one place a marketplace `headersHelper` command is executed.
   *
   * The command is read from the LIVE managed policy on every fetch, never from
   * the registry row, and that is the property the whole decision rests on. A
   * row in `marketplaces.json` is a user-writable store: persisting the command
   * there would turn an administrator's command into a user-declared one the
   * moment the policy was withdrawn, which is exactly the tier owner decision Q7
   * option C refuses to execute. Reading it live also means a revised or removed
   * policy is honoured on the very next fetch — the same polarity
   * {@link managedAutoUpdateFor} already takes for `autoUpdate`.
   *
   * Matched on the source string because that is what `add()` dedupes on, so the
   * row and the policy entry cannot drift apart: `deliverMarketplaces` passes
   * `entry.source` straight into `add()`, which trims it and stores it verbatim.
   *
   * Returns `undefined` when nothing was minted (no managed entry, no command,
   * or one of the page's two documented skips — a non-https URL, or a command
   * outside the documented text shape), in which case the caller sends the
   * static `headers` alone, which is what the page prescribes for those skips.
   * Returns `'failed'` when the command ran and failed, which is fail-closed.
   */
  private managedHelperEntryFor(
    registry: PluginMarketplaceRegistry,
  ): DeliveredMarketplaceEntryV1 | undefined {
    return this.extraKnownMarketplaces.find(
      entry => entry.headersHelper !== undefined && entry.source.trim() === registry.source,
    );
  }

  private async mintedFetchHeaders(
    registry: PluginMarketplaceRegistry,
    managed: DeliveredMarketplaceEntryV1,
  ): Promise<Record<string, string> | undefined | 'failed'> {
    if (!managed.headersHelper) return undefined;
    let outcome: ManagedHeadersHelperOutcome;
    try {
      outcome = await resolveManagedMarketplaceHeaders({
        marketplaceName: managed.name,
        url: registry.source,
        command: managed.headersHelper,
      });
    } catch (error) {
      // The executor is written not to throw; a throw here would otherwise take
      // out a browse, and this method's whole contract is that it returns a
      // verdict. Treated as the failure it is.
      console.warn(
        `[marketplace-registry] headersHelper threw for "${managed.name}":`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
    switch (outcome.state) {
      case 'headers':
        return outcome.headers;
      case 'not-run':
        // Operator-visible and durable, because the remedy is in the policy file
        // and the person who can act on it does not read the Plugins page. Never
        // an error: the fetch still goes out with the static headers.
        console.warn(
          `[marketplace-registry] headersHelper not run for "${managed.name}" (${outcome.reason});`
          + ' only the fixed "headers" are sent',
        );
        return undefined;
      default:
        console.warn(
          `[marketplace-registry] headersHelper failed for "${managed.name}" (${outcome.reason});`
          + ' the catalog fetch was not made',
        );
        return 'failed';
    }
  }

  /** {@link fetchRegistryEntry}'s body — see that method for the failure log. */
  private async resolveRegistryEntry(
    registry: PluginMarketplaceRegistry,
    signature: string,
  ): Promise<CachedRegistryEntry> {
    const displayName = registryDisplayName(registry);
    // `:762`'s re-check: "If a marketplace was added before the policy was
    // configured and its source no longer matches the allowlist, Claude Code
    // refuses to install or update plugins from it." This is the ONE place a
    // registry's catalog is fetched, so gating it here covers the browse refresh,
    // the background auto-update and `upgrade()`'s eager re-stage alike — and it
    // runs before `fetchRegistryCatalog`, which is where the clone happens.
    if (!this.isSourceAllowed(registry.source, registry.refName)) {
      return {
        signature,
        items: [],
        loadError: toLoadError(registry.id, displayName, [
          { code: 'marketplace.registry.source_not_allowed' },
        ]),
      };
    }
    // The blocklist's own half of the same sentence: "Claude Code checks the
    // blocklist on marketplace add and on plugin install, update, refresh, and
    // auto-update, SO A MARKETPLACE SOMEONE ADDED BEFORE YOU SET THE POLICY
    // CAN'T BE USED TO FETCH PLUGINS EITHER." That clause is the whole reason
    // this gate is here and not only in `add()`: a row already in
    // `marketplaces.json` never passes through `add()` again, and the add gate
    // alone would leave exactly the marketplaces the sentence names still
    // loading. Placed before `fetchRegistryCatalog` — "Blocked sources are
    // checked before download, so they never touch the filesystem".
    //
    // ITS OWN DIAGNOSTIC CODE SINCE P2.482, and the paragraph that used to stand
    // here said the opposite. P2.467 reused the allowlist's
    // `source_not_allowed` under a measured constraint —
    // `plugin-registry-load-error.test.ts` extracts every
    // `marketplace.registry.*` literal from THIS FILE and requires each to be in
    // the renderer's message table, whose values are locale keys, so a fifth code
    // obliged an edit in `apps/electron/src/renderer/pages/` and in both locale
    // files, which belonged to a different owner. W3-d landed that half
    // (`5afd7772a`): `marketplace.registry.source_blocked` →
    // `plugins.registryLoadErrorSourceBlocked`, plus the two strings. This is the
    // producer, and the two halves are inert apart — a mapped code nothing emits
    // is dead, an emitted code nothing maps turns that suite red.
    //
    // Why it was worth a code at all: the two refusals have OPPOSITE remedies
    // (widen an allowlist, or remove a blocklist entry), and the shared sentence
    // could not say which fired. What still does NOT change is the blocked ENTRY
    // (`owner/*`): it stays on the operator's log line below. `toLoadError` is
    // path-free by construction — id, display label, closed codes — and widening
    // it to carry an administrator's pattern would put externally-authored text
    // on a rendering path, for the one reader who cannot act on it.
    const blockedBy = this.blockedSourceEntry(registry.source, registry.refName);
    if (blockedBy !== undefined) {
      console.warn(
        `[marketplace-registry] marketplace refused for "${displayName}" (${registry.id}):`
        + ` blocked by the blockedMarketplaces entry "${blockedBy}"`,
      );
      return {
        signature,
        items: [],
        loadError: toLoadError(registry.id, displayName, [
          { code: 'marketplace.registry.source_blocked' },
        ]),
      };
    }
    // The page's re-check, and it is a re-check by DESIGN, not belt-and-braces:
    // "Claude Code re-checks reserved names every time it loads a marketplace,
    // not only when you add one. A marketplace that was registered under one of
    // these names before the name became reserved stops loading and reports that
    // it is registered from an untrusted source." A row already in
    // `marketplaces.json` — written before this gate existed, hand-edited, or
    // carried over from a machine where the name was not yet reserved — never
    // passes through `add()` again, so the add gate alone would leave exactly the
    // marketplaces the page names still loading.
    //
    // Placed with the allowlist gate and BEFORE `fetchRegistryCatalog`, which is
    // where the clone happens: a refused marketplace must not cost a network
    // fetch. Not marked `failedFetch`, so it never spends the retry budget — the
    // refusal is a standing verdict about the name, not a transient failure that
    // could heal on its own.
    const reserved = this.reservedNameCollision(displayName, registry.source, registry.refName);
    if (reserved !== undefined) {
      return {
        signature,
        items: [],
        loadError: toLoadError(registry.id, displayName, [
          { code: 'marketplace.registry.reserved_name' },
        ]),
      };
    }
    // P6.479 — the minted half of the same credential, resolved BEFORE the fetch
    // because the page places it there: "Before each fetch of the marketplace's
    // `marketplace.json` and before each archive download on that origin."
    // Fail-closed, also the page's: a command that fails means Claude Code
    // "doesn't make the fetch or download it ran the command for", so this
    // returns without touching the network.
    //
    // The lookup is SYNCHRONOUS and the await is conditional, deliberately: a
    // registry with no managed helper — every registry on a machine with no such
    // policy — must reach `fetchRegistryCatalog` on the same tick it always did.
    // An unconditional `await` here delayed the background clone by one
    // microtask, which is invisible in production and turned a pinned
    // "the fetch was kicked exactly once" assertion red. Scheduling is behaviour.
    const managedHelper = this.managedHelperEntryFor(registry);
    const minted = managedHelper ? await this.mintedFetchHeaders(registry, managedHelper) : undefined;
    if (minted === 'failed') {
      return {
        signature,
        items: [],
        loadError: toLoadError(registry.id, displayName, [
          { code: 'marketplace.registry.headers_helper_failed' },
        ]),
      };
    }
    try {
      const fetched = await withTimeout(
        fetchRegistryCatalog(this.staging, {
          source: registry.source,
          ...(registry.refName ? { refName: registry.refName } : {}),
          ...(registry.sparsePaths ? { sparsePaths: registry.sparsePaths } : {}),
          // P3.220 — `plugins/host-marketplace.md#authenticate-archive-downloads`:
          // "Before each fetch of the marketplace's `marketplace.json`,
          // including a later refresh." This IS that fetch, and it is also the
          // refresh, so the headers ride the row rather than the add request.
          //
          // P6.479 — and the command's output rides on top of them: "Within one
          // place, a header the command prints overrides a header of the same
          // name listed in `headers`."
          ...(registry.headers || minted ? { headers: { ...registry.headers, ...minted } } : {}),
          ...(this.baseTempDir ? { baseTempDir: this.baseTempDir } : {}),
        }),
        this.fetchTimeoutMs,
      );
      // Directory-of-plugins registries (Codex/Claude marketplace repo layout)
      // carry pre-typed scanned plugins instead of a root catalog manifest.
      if (fetched.ok && fetched.scannedPlugins?.length) {
        return {
          signature,
          persistable: true,
          items: registryScannedCatalogItems({
            marketplaceRegistryId: registry.id,
            ...(displayName ? { displayName } : {}),
            scannedPlugins: fetched.scannedPlugins,
          }),
        };
      }
      if (!fetched.ok || fetched.catalog === undefined || fetched.catalogRoot === undefined) {
        return { signature, items: [], loadError: toLoadError(registry.id, displayName, fetched.diagnostics) };
      }
      const parsed = registryCatalogItems({
        marketplaceRegistryId: registry.id,
        ...(displayName ? { displayName } : {}),
        catalog: fetched.catalog,
        catalogRoot: fetched.catalogRoot,
        // Rebuild any `local` catalog entry into a DURABLE registry-relative
        // source — the staged root it resolved against is already removed.
        ...(fetched.registrySource ? { registrySource: fetched.registrySource } : {}),
        // Component kinds each entry's own manifest declares, read during the
        // same staged scan (D2). Display-only: it never reaches the install
        // record, so it cannot change what a row installs.
        ...(fetched.manifestComponentKinds
          ? { manifestComponentKinds: fetched.manifestComponentKinds }
          : {}),
      });
      const parseErrors = parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
      const catalogName = declaredCatalogName(fetched.catalog);
      return {
        signature,
        persistable: true,
        items: parsed.items,
        ...(catalogName ? { catalogName } : {}),
        ...(parseErrors.length ? { loadError: toLoadError(registry.id, displayName, parseErrors) } : {}),
      };
    } catch (error) {
      // Timeout or any unexpected throw → path-free load error (never a hang).
      const code = error instanceof RegistryFetchTimeoutError
        ? 'marketplace.registry.fetch_timeout'
        : 'marketplace.registry.fetch_failed';
      return { signature, items: [], loadError: toLoadError(registry.id, displayName, [{ code }]) };
    }
  }

  /**
   * Add a registry: classify the source server-side (URL parse — NO `gitlocal`
   * enum), dedupe on the raw source string, persist the row, and return a
   * path-free result. `installedRoot` is NEVER returned (Stop Condition).
   */
  async add(request: {
    source: string;
    refName?: string;
    sparsePaths?: string[];
    /**
     * Label to record instead of the one derived from the source. Only the
     * delivery path supplies it, so a policy-named marketplace shows the name
     * the administrator gave it; an interactive add still derives its own.
     */
    displayName?: string;
    /**
     * `settings-reference.md#extraknownmarketplaces`'s `autoUpdate`, when the
     * caller has an explicit answer.
     * Omitted by the interactive add path, which leaves the row undecided so the
     * documented default polarity applies.
     */
    autoUpdate?: boolean;
    /**
     * P3.220 — `settings-reference.md#extraknownmarketplaces`'s `url` source
     * `headers`, already filtered by the managed parser. Only the delivery path
     * supplies them: a marketplace a user adds by hand has no field to declare
     * a credential in, and inventing one would put a secret in a store slot
     * nobody owns.
     */
    headers?: Record<string, string>;
  }): Promise<RegistryAddResult> {
    const source = request.source.trim();
    if (!source) throw new Error('Registry source is empty.');
    // FIRST, before the store read below and long before any clone: `:762` puts
    // the check "before any network or filesystem operation", and a check placed
    // after the clone would be worse than none — the clone is what touches the
    // network.
    if (!this.isSourceAllowed(source, request.refName)) {
      throw new MarketplaceSourceNotAllowedError(
        'This marketplace source is not permitted by your organization\'s managed settings.',
      );
    }
    // And the blocklist, in the same position and for the same reason: the
    // reference puts it "on marketplace add", "before download, so they never
    // touch the filesystem", and the store read below is a filesystem operation.
    const addBlockedBy = this.blockedSourceEntry(source, request.refName);
    if (addBlockedBy !== undefined) throw new MarketplaceSourceBlockedError(addBlockedBy);
    // Reserved names, ALSO before the store read, for the same reason: the page
    // puts the restriction check "before any network or filesystem operation",
    // and reading the registry file is a filesystem operation. The name computed
    // here is byte-for-byte the one the row below will carry — the two must not
    // be allowed to drift, or the gate would guard a name the row never uses.
    const prospectiveName = request.displayName?.trim() || deriveDisplayName(source);
    const reserved = this.reservedNameCollision(prospectiveName, source, request.refName);
    if (reserved !== undefined) throw new MarketplaceReservedNameError(reserved, prospectiveName);
    const file = await this.store.readMarketplaceRegistries();
    const existing = file.registries.find(registry => registry.source === source);
    if (existing) {
      return {
        marketplaceId: existing.id,
        displayName: registryDisplayName(existing),
        alreadyAdded: true,
      };
    }
    const refName = request.refName?.trim();
    const sparsePaths = normalizeSparsePaths(request.sparsePaths);
    // The SAME string the reserved-name gate above ruled on, by construction.
    const displayName = prospectiveName;
    const registry: PluginMarketplaceRegistry = {
      id: `registry-${randomUUID()}`,
      source,
      ...(refName ? { refName } : {}),
      ...(sparsePaths.length ? { sparsePaths } : {}),
      ...(request.headers && Object.keys(request.headers).length > 0
        ? { headers: { ...request.headers } }
        : {}),
      displayName,
      ...(request.autoUpdate === undefined ? {} : { autoUpdate: request.autoUpdate }),
      addedAt: this.now(),
    };
    await this.store.writeMarketplaceRegistries({
      ...file,
      registries: [...file.registries, registry],
    });
    return { marketplaceId: registry.id, displayName, alreadyAdded: false };
  }

  /**
   * Upgrade a registry = git re-fetch. Git sources re-stage eagerly — this is
   * the one explicit user action allowed to await the clone (still bounded by
   * the SAME fetch timeout) — and stamp `lastUpgradedAt` (which invalidates the
   * cache signature) only ONCE fresh bytes exist. Local-folder registries are a
   * typed no-op (`reason: 'not-git'`).
   *
   * The stamp used to be persisted BEFORE the clone was awaited, and
   * `lastUpgradedAt` feeds {@link registrySignature}, which `findCatalogItem`
   * and `listItems` require an exact match on. So from the click until the
   * clone landed — 34.97 s measured on a real `openai/plugins` refresh — every
   * lookup missed a catalog that was sitting healthy in memory AND on disk, and
   * "refresh the marketplace and try again" was the cause of the failure it was
   * advising against. Fetch first, stamp after.
   *
   * Deliberately NOT routed through {@link withFetchSlot}: upgrade is awaited by
   * the user and would deadlock behind a queued browse fetch for the same
   * registry.
   */
  async upgrade(request: { marketplaceId: string }): Promise<RegistryUpgradeResult> {
    const file = await this.store.readMarketplaceRegistries();
    const registry = file.registries.find(entry => entry.id === request.marketplaceId);
    if (!registry) {
      return this.reportNotUpgraded(request.marketplaceId, undefined, 'not-found');
    }
    if (!isGitRegistry(registry)) {
      // Reached for a local folder — and, until the resolver learned the
      // `owner/repo` shorthand, for every registry added the way Claude's own
      // docs spell it. That was a typed no-op with no log and no user-facing
      // sentence, so an upgrade that could never happen looked like one that
      // simply had nothing new.
      return this.reportNotUpgraded(registry.id, registryDisplayName(registry), 'not-git');
    }
    // `:762` — the check runs on update too. Refused BEFORE anything is fetched
    // or stamped, so a forbidden registry's cache signature is not churned.
    if (!this.isSourceAllowed(registry.source, registry.refName)) {
      throw new MarketplaceSourceNotAllowedError(
        'This marketplace source is not permitted by your organization\'s managed settings.',
      );
    }
    // The blocklist runs "on plugin install, update, refresh, and auto-update"
    // too. Thrown here rather than left to the load gate for the reason spelled
    // out for the reserved name below: `upgrade()` maps a non-persistable entry
    // onto `'fetch-failed'`, and telling the user their refresh failed to fetch
    // when their administrator refused it is the wrong sentence.
    const upgradeBlockedBy = this.blockedSourceEntry(registry.source, registry.refName);
    if (upgradeBlockedBy !== undefined) throw new MarketplaceSourceBlockedError(upgradeBlockedBy);
    // Same treatment for the reserved name, and thrown rather than left to the
    // load gate below on purpose. `resolveRegistryEntry` would catch it — but
    // `upgrade()` maps a non-persistable entry onto `'fetch-failed'`, which would
    // tell the user their refresh failed to fetch when nothing was ever fetched.
    // A wrong reason is worse than a missing one; this is the click the user
    // made, so it gets the sentence that names what actually happened.
    const upgradeReserved = this.reservedNameCollision(
      registryDisplayName(registry), registry.source, registry.refName,
    );
    if (upgradeReserved !== undefined) {
      throw new MarketplaceReservedNameError(upgradeReserved, registryDisplayName(registry));
    }
    const previousSignature = registrySignature(registry);
    const upgradedRegistry: PluginMarketplaceRegistry = { ...registry, lastUpgradedAt: this.now() };
    const entry = await this.fetchRegistryEntry(upgradedRegistry, registrySignature(upgradedRegistry));
    if (!entry.persistable) {
      // Nothing fresh arrived. Leave the row — and therefore the signature the
      // cache is keyed by — exactly as it was, so the catalog the user can
      // still browse stays the catalog an install resolves against, and report
      // the failure rather than the click.
      this.inFlight.delete(registry.id);
      const diagnosticCodes = entry.loadError?.diagnosticCodes ?? [];
      // ...but the retained catalog must not go on looking CURRENT (P2.159).
      // Measured: `marketplace:upgradeRegistry` for the official Anthropic
      // marketplace failed `fetch-timeout` on both attempts, so its catalog
      // stayed frozen where it was three weeks earlier — `claude-security` still
      // listed at `0.10.0` while upstream was at `0.10.2.3` — and `listItems()`
      // served those rows with no `loadErrors` entry at all, because this branch
      // returned without touching the cache. Auto-update was ON for that
      // marketplace, so the whole failure was invisible: the user was told
      // nothing and offered nothing, indefinitely.
      //
      // Folding the failure onto the RETAINED entry is the same treatment a
      // failed BACKGROUND fetch already gets ({@link mergeFailedFetch}), routed
      // through the existing `loadErrors` -> `registryLoadErrors` channel that
      // the Plugins page already reads and labels. Pinned to the PREVIOUS
      // signature on purpose: the registry row was deliberately left unstamped,
      // so the new signature matches nothing and an entry keyed by it would be
      // silently unreachable — the exact silence this fixes. Never persisted
      // (`persistable: false`), and the items are untouched, so browse and
      // install keep resolving against the catalog they were resolving against
      // a moment ago.
      this.stampUpgradeFailure(registry, previousSignature, entry.loadError);
      return this.reportNotUpgraded(
        registry.id,
        registryDisplayName(registry),
        diagnosticCodes.includes('marketplace.registry.fetch_timeout') ? 'fetch-timeout' : 'fetch-failed',
        diagnosticCodes,
      );
    }
    // Swap atomically: seed the fresh items under the CURRENT signature first,
    // so a reader interleaving between the row write and the cache commit still
    // resolves; then flip the row and re-key the entry to its own signature.
    // P6.621 — read the outgoing catalog's own name BEFORE the seed below
    // replaces the slot, or the rename comparison would be the new name against
    // itself.
    const previousCatalogName = this.catalogCache.get(registry.id)?.catalogName;
    this.catalogCache.set(registry.id, { ...entry, signature: previousSignature, persistable: false });
    const updated = file.registries.map(other =>
      other.id === registry.id ? upgradedRegistry : other,
    );
    await this.store.writeMarketplaceRegistries({ ...file, registries: updated });
    this.commitEntry(registry.id, entry, previousCatalogName);
    this.inFlight.delete(registry.id);
    return { marketplaceId: registry.id, upgraded: true };
  }

  /**
   * P6.421. `plugins/install.md#install-a-plugin` — "when you install
   * `plugin-name@marketplace-name`, in a session or with `claude plugin
   * install`, Claude Code refreshes that marketplace before the lookup", and
   * that refresh runs "even if you turned off auto-update for the marketplace
   * or set `DISABLE_AUTOUPDATER`". So this is {@link upgrade} with the page's
   * skip list in front of it, NOT a second fetch path: the whole point is that
   * one primitive already exists and only the wiring was missing.
   *
   * The 30-second window is the page's own ("Claude Code refreshed the
   * marketplace within the last 30 seconds"), read off the `lastUpgradedAt`
   * stamp `upgrade()` writes, so two installs in a row cost one clone.
   */
  async refreshForInstall(request: { marketplaceId: string }): Promise<InstallRefreshResult> {
    // "You set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`." Set-at-all, the
    // same reading `telemetryOptedOut` takes of the same variable. Read from
    // the SERVER's own environment: the gateway path writes this name into the
    // claude SDK child's env object (`claude-agent.ts`), never into ours.
    if (this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC !== undefined) {
      return { marketplaceId: request.marketplaceId, upgraded: false, reason: 'nonessential-traffic-disabled' };
    }
    const { registries } = await this.store.readMarketplaceRegistries();
    const registry = registries.find(entry => entry.id === request.marketplaceId);
    // Both fall through to `upgrade()`, which owns the `'not-found'` and
    // `'not-git'` verdicts and their warning line — one place, not two.
    if (registry && isGitRegistry(registry)) {
      const lastUpgradedAt = registry.lastUpgradedAt;
      if (lastUpgradedAt !== undefined && this.now() - lastUpgradedAt < INSTALL_REFRESH_WINDOW_MS) {
        return { marketplaceId: request.marketplaceId, upgraded: false, reason: 'recently-refreshed' };
      }
    }
    return this.upgrade(request);
  }

  /**
   * Record a failed refresh against the catalog the registry is still serving,
   * so a stale catalog stops looking current (P2.159).
   *
   * In-memory only, and additive: `items` come from whatever is already cached
   * (or from disk, hydrated on the next `listItems()` — a miss simply leaves the
   * pre-existing behavior). `failedFetch` + `retriesLeft` are set for the same
   * reason `mergeFailedFetch` sets them: the staleness has to be able to END
   * without the user clicking, so the browse path re-attempts the SAME signature
   * a bounded number of times and a success clears the note.
   */
  private stampUpgradeFailure(
    registry: PluginMarketplaceRegistry,
    signature: string,
    loadError: MarketplaceRegistryLoadError | undefined,
  ): void {
    const previous = this.catalogCache.get(registry.id);
    if (!previous || previous.signature !== signature) return;
    this.catalogCache.set(registry.id, {
      ...previous,
      signature,
      ...(loadError
        ? { loadError: { ...loadError, marketplaceRegistryId: registry.id } }
        : {}),
      persistable: false,
      failedFetch: true,
      retriesLeft: previous.failedFetch ? previous.retriesLeft ?? 0 : FETCH_RETRIES_AFTER_FAILURE,
    });
  }

  /**
   * Log an upgrade that did not happen and return its typed result.
   *
   * Every `upgraded:false` exit routes through here so the reason cannot be
   * returned without also being recorded — `not-git` in particular used to be a
   * silent typed no-op, which is how three shorthand registries sat un-fetched
   * with nothing in main.log to say why. See {@link fetchRegistryEntry} for why
   * this is `console.warn` rather than the debug-gated `createLogger`.
   */
  private reportNotUpgraded(
    marketplaceId: string,
    displayName: string | undefined,
    reason: NonNullable<RegistryUpgradeResult['reason']>,
    diagnosticCodes: string[] = [],
  ): RegistryUpgradeResult {
    console.warn(
      `[marketplace-registry] upgrade did not happen for "${displayName ?? 'unnamed marketplace'}"`
      + ` (${marketplaceId}): reason=${reason}`
      + (diagnosticCodes.length ? ` diagnostics=${diagnosticCodes.join(', ')}` : ''),
    );
    return {
      marketplaceId,
      upgraded: false,
      reason,
      ...(diagnosticCodes.length ? { diagnosticCodes } : {}),
    };
  }

  /** Remove a registry by id. The caller gates the built-in Skills Market out. */
  async remove(request: { marketplaceId: string }): Promise<RegistryRemoveResult> {
    const file = await this.store.readMarketplaceRegistries();
    const remaining = file.registries.filter(entry => entry.id !== request.marketplaceId);
    if (remaining.length === file.registries.length) {
      return { marketplaceId: request.marketplaceId, removed: false };
    }
    await this.store.writeMarketplaceRegistries({ ...file, registries: remaining });
    // Drop any cached / in-flight catalog for the gone registry (re-adding it
    // later mints a fresh id, so the stale entry would only leak memory/disk).
    this.catalogCache.delete(request.marketplaceId);
    this.inFlight.delete(request.marketplaceId);
    void this.removeDiskEntry(request.marketplaceId);
    return { marketplaceId: request.marketplaceId, removed: true };
  }

  /** Path-free registry rows for the manage surface (NO source path / installedRoot). */
  async list(): Promise<RegistryListSummary> {
    await this.ensureDeliveredMarketplaces();
    const { registries } = await this.store.readMarketplaceRegistries();
    return {
      registries: registries.map(registry => ({
        marketplaceId: registry.id,
        displayName: registryDisplayName(registry),
        ...(registry.refName ? { refName: registry.refName } : {}),
        autoUpdate: this.resolveRegistryAutoUpdate(registry),
        autoUpdateManaged: this.managedAutoUpdateFor(registry) !== undefined,
      })),
      available: this.offeredBuiltInMarketplaces(registries),
    };
  }

  /**
   * The built-in catalogs that are neither already registered nor refused by the
   * administrator's own policy. Reads no catalog and touches no network: an
   * offer is a name and a slug until somebody enables it.
   */
  private offeredBuiltInMarketplaces(
    registries: readonly PluginMarketplaceRegistry[],
  ): BuiltInMarketplaceOffer[] {
    return BUILT_IN_MARKETPLACES
      .filter(entry => !registries.some(registry => registry.source === entry.source))
      .filter(entry => this.isSourceAllowed(entry.source) && this.blockedSourceEntry(entry.source) === undefined)
      .map(entry => ({ name: entry.name, source: entry.source, description: entry.description }));
  }

  /**
   * P6.517/P6.518 — the one click. The `displayName` is the entry's own published
   * name, which for the official Anthropic marketplace is a RESERVED name; `add`
   * exempts it because the pinned source is the one official source this fork can
   * recognise, and would refuse the very same name from any other source.
   */
  async enableBuiltInMarketplace(request: { name: string }): Promise<RegistryAddResult> {
    const entry: BuiltInMarketplaceEntry | undefined = builtInMarketplaceEntry(request.name);
    if (!entry) throw new Error(`Unknown built-in marketplace "${request.name}".`);
    return this.add({ source: entry.source, displayName: entry.name });
  }

  /* ----------------------------------------------------------------------- *
   * Auto-update (`settings-reference.md#extraknownmarketplaces`, `plugins/loading.md#which-marketplaces-and-plugins-auto-update`)
   * ----------------------------------------------------------------------- */

  /**
   * The managed policy's answer for a persisted row, or undefined when the
   * policy is silent about it.
   *
   * Matched on the SOURCE string rather than on the display name, because that
   * is what `add()` dedupes on: a delivered entry and its persisted row are the
   * same marketplace precisely when their sources are equal, and the display
   * name is a label a user-added row can coincidentally share.
   */
  private managedAutoUpdateFor(registry: PluginMarketplaceRegistry): boolean | undefined {
    return this.extraKnownMarketplaces
      .find(entry => entry.source.trim() === registry.source)
      ?.autoUpdate;
  }

  /**
   * The documented resolution order, in one place so no caller can re-derive it
   * differently:
   *
   *  1. the managed `extraKnownMarketplaces` value (`plugins/org.md#turn-auto-update-on-or-off-per-marketplace` —
   *     an administrator enables it "without requiring each user to toggle it",
   *     so the user's toggle cannot override it);
   *  2. the user's own persisted toggle (`plugins/install.md#turn-auto-update-on-or-off-for-a-marketplace`);
   *  3. `settings-reference.md#extraknownmarketplaces`'s default polarity —
   *     "When omitted, `claude-plugins-official` and most other official
   *     Anthropic marketplaces default to `true`, and third-party marketplaces
   *     default to `false`.".
   *
   * Step 3 lands on `false` for every marketplace this fork can currently
   * register; see {@link defaultMarketplaceAutoUpdate} for why the polarity is
   * written down anyway.
   */
  private resolveRegistryAutoUpdate(registry: PluginMarketplaceRegistry): boolean {
    return this.managedAutoUpdateFor(registry)
      ?? registry.autoUpdate
      ?? defaultMarketplaceAutoUpdate(registry.source, registry.refName);
  }

  async setAutoUpdate(request: { marketplaceId: string; autoUpdate: boolean }): Promise<RegistrySetAutoUpdateResult> {
    const file = await this.store.readMarketplaceRegistries();
    const registry = file.registries.find(entry => entry.id === request.marketplaceId);
    if (!registry) throw new Error('No such marketplace.');
    const managed = this.managedAutoUpdateFor(registry);
    if (managed !== undefined) {
      // Refused rather than silently ignored: the row would be written, the
      // resolver would keep answering the administrator's value, and the toggle
      // would flip back on the next list — which reads as a broken control.
      throw new Error('Auto-update for this marketplace is set by your organization\'s managed settings.');
    }
    if (registry.autoUpdate === request.autoUpdate) {
      return { marketplaceId: registry.id, autoUpdate: request.autoUpdate };
    }
    // `autoUpdate` is NOT part of `registrySignature`, so writing it cannot
    // invalidate the cached catalog — the toggle must not cost a re-clone.
    await this.store.writeMarketplaceRegistries({
      ...file,
      registries: file.registries.map(entry =>
        entry.id === registry.id ? { ...entry, autoUpdate: request.autoUpdate } : entry,
      ),
    });
    return { marketplaceId: registry.id, autoUpdate: request.autoUpdate };
  }

  /**
   * `plugins/loading.md#when-auto-update-runs` — "Claude Code can automatically update
   * marketplaces and their installed plugins in the background after startup.
   * When auto-update is enabled for a marketplace, Claude Code refreshes the
   * marketplace data and updates installed plugins to their latest versions on
   * disk."
   *
   * This implements the FIRST half — the catalog refresh — by driving the
   * existing {@link upgrade}, which already re-checks
   * `strictKnownMarketplaces` before it clones, is single-flight, and swaps the
   * cache atomically. A scheduled update therefore passes exactly the gates a
   * clicked one passes and never fewer, which is the property that matters for
   * an unattended network fetch.
   *
   * Sequential on purpose: `upgrade()` deliberately bypasses the global fetch
   * slot (it would deadlock behind a queued browse fetch), so running N of them
   * concurrently would bypass the concurrency cap N times over — a clone storm
   * on a slow bank network, unattended, with nobody watching.
   *
   * The installed-BUNDLE half is NOT here either, and that is a boundary rather
   * than a gap: it needs the plugin management service, which this controller
   * deliberately does not hold. It lives in
   * `MarketplaceService.updateInstalledBundles`, which the same post-startup
   * pass calls with `refreshed` as its scope — so a bundle is only ever updated
   * for a marketplace whose catalog just passed the allowlist gates above.
   *
   * Nothing in either half replaces a running plugin: `plugins/loading.md#when-auto-update-runs`
   * requires that "the running session keeps using the versions it loaded at
   * launch".
   */
  async refreshAutoUpdateMarketplaces(): Promise<RegistryAutoUpdateRunResult> {
    const considered: string[] = [];
    const refreshed: string[] = [];
    const failed: RegistryAutoUpdateRunResult['failed'] = [];
    try {
      await this.ensureDeliveredMarketplaces();
      const { registries } = await this.store.readMarketplaceRegistries();
      for (const registry of registries) {
        if (!this.resolveRegistryAutoUpdate(registry)) continue;
        considered.push(registry.id);
        try {
          const result = await this.upgrade({ marketplaceId: registry.id });
          if (result.upgraded) refreshed.push(registry.id);
          // `not-git` is a typed no-op, not a failure to report upward: a local
          // folder has nothing to re-fetch and its catalog is never stale.
          else if (result.reason && result.reason !== 'not-git') {
            failed.push({ marketplaceId: registry.id, reason: result.reason });
          }
        } catch {
          // An allowlist refusal or a store failure on one registry must not
          // stop the rest. `upgrade()` already logged the reason.
          //
          // Deliberately NOT recorded in `failed`: every throw here is a
          // managed-policy decision rather than a stale catalog —
          // `MarketplaceSourceNotAllowedError`, `MarketplaceSourceBlockedError`
          // (P2.467) or `MarketplaceReservedNameError` — and the browse path
          // already carries each as its own load error
          // (`source_not_allowed` / `source_blocked` / `reserved_name`). Calling
          // any of them `fetch-failed` would report an administrator's own
          // setting as a network fault.
          //
          // That sentence was FALSE from when it was written until P2.482 landed
          // in this same commit: `source_blocked` was emitted nowhere in the
          // tree, and `resolveRegistryEntry`'s blocklist branch returned
          // `source_not_allowed`. It escaped `plugin-registry-load-error.test.ts`
          // because it spells the code WITHOUT the `marketplace.registry.` prefix
          // that suite's extractor matches on — so a prose claim about a code was
          // the one form of the claim no machine check could see.
        }
      }
    } catch (error) {
      console.warn(
        '[marketplace-registry] scheduled auto-update pass failed: '
        + (error instanceof Error ? error.message : String(error)),
      );
    }
    return { considered, refreshed, failed };
  }

  /**
   * `settings-reference.md#pluginsuggestionmarketplaces` — the suggestion
   * allowlist's TWO-part gate, and the anti squatting rule that is the reason it
   * has two parts.
   *
   * "A name takes effect only when the marketplace is registered on the machine
   * and its registered source is also declared in the same managed settings,
   * either as the `extraKnownMarketplaces` entry for that name or as an entry of
   * `strictKnownMarketplaces`. Claude Code ignores a marketplace registered from
   * a different source under an allowlisted name. The official marketplace is
   * exempt from the source requirement: allowlisting its name alone suffices,
   * since that name can only register from the official Anthropic source."
   *
   * Without the second half, whoever can get a marketplace registered under an
   * allowlisted name — a user-added row whose derived label happens to collide,
   * a repository renamed upstream — has their plugins pinned in front of every
   * engineer in the org by the administrator's own setting. So the name is
   * necessary and never sufficient.
   *
   * The exemption is genuinely narrow: it applies only when the allowlisted name
   * IS the official one AND the registered source really is the official
   * Anthropic repository. `plugins/marketplace-reference.md#reserved-names` reserves that
   * name so no third party can register under it upstream, and since P6.41 this
   * fork enforces the reservation too ({@link reservedMarketplaceNameFor}, gated
   * at add and at load) — so the premise of the quoted sentence now holds HERE.
   * The source check below stays regardless: the reservation makes the name
   * unavailable to a third party, this makes it insufficient on its own, and a
   * gate that leans on the other being correct is a gate with one point of
   * failure.
   */
  isSuggestionAllowed(registry: PluginMarketplaceRegistry): boolean {
    if (this.pluginSuggestionMarketplaces === undefined) return false;
    const name = registryDisplayName(registry);
    if (!this.pluginSuggestionMarketplaces.includes(name)) return false;
    if (name === OFFICIAL_ANTHROPIC_MARKETPLACE_NAME) {
      return isOfficialAnthropicMarketplaceSource(registry.source, registry.refName);
    }
    const identity = managedMarketplaceSourceIdentity(registry.source, registry.refName);
    // Half one: the `extraKnownMarketplaces` entry FOR THAT NAME. Both halves
    // must agree — an entry that delivers this source under a DIFFERENT name
    // does not declare this name's source.
    const deliveredUnderThisName = this.extraKnownMarketplaces.some(
      entry => entry.name === name && entry.source.trim() === registry.source,
    );
    if (deliveredUnderThisName) return true;
    // Half two: an entry of `strictKnownMarketplaces`. `undefined` there means
    // "no restriction configured", which declares no source at all and therefore
    // satisfies nothing — `isManagedMarketplaceAllowed` would answer `true` for
    // every source, which is exactly the widening this gate exists to refuse.
    return (this.strictKnownMarketplaces ?? []).some(entry => matchesManagedMarketplaceEntry(entry, identity));
  }

  /** The persisted rows a suggestion pass may consider. Path-free ids only. */
  async listSuggestionAllowedRegistryIds(): Promise<string[]> {
    if (this.pluginSuggestionMarketplaces === undefined) return [];
    await this.ensureDeliveredMarketplaces();
    const { registries } = await this.store.readMarketplaceRegistries();
    return registries.filter(registry => this.isSuggestionAllowed(registry)).map(registry => registry.id);
  }
}

/** True when the raw source classifies to a git repository (vs a local folder / bare url). */
function isGitRegistry(registry: PluginMarketplaceRegistry): boolean {
  try {
    return resolvePluginInstallSource(registry.source).source.kind === 'repository';
  } catch {
    return false;
  }
}

/** Which delivery outcome a thrown `add()` failure is. See the call site. */
function deliveryRefusalState(error: unknown): DeliveredMarketplaceOutcome['state'] {
  if (error instanceof MarketplaceSourceNotAllowedError) return 'refused-by-allowlist';
  if (error instanceof MarketplaceSourceBlockedError) return 'refused-by-blocklist';
  if (error instanceof MarketplaceReservedNameError) return 'refused-reserved-name';
  return 'failed';
}

function registryDisplayName(registry: PluginMarketplaceRegistry): string {
  return registry.displayName?.trim() || deriveDisplayName(registry.source);
}

/**
 * A path-free display label derived from the raw source. For a hosted repository
 * we use `<owner>/<repo>` from the CLASSIFIED repository URL (e.g.
 * `https://github.com/openai/plugins/tree/main` and `.../tree/main/plugins` both
 * → `openai/plugins`) — never the git ref or a subdirectory. For a bare URL /
 * local folder we fall back to the last non-empty path segment. The absolute
 * source string itself is never surfaced as the label.
 */
function deriveDisplayName(source: string): string {
  const repositoryLabel = repositoryOwnerRepoLabel(source);
  if (repositoryLabel) return repositoryLabel;
  const withoutGit = source.replace(/\.git$/i, '');
  const segments = withoutGit.split(/[\\/:]+/).map(segment => segment.trim()).filter(Boolean);
  return segments.at(-1) ?? source;
}

/**
 * `<owner>/<repo>` for a source that CLASSIFIES to a hosted repository, taken
 * from the parsed `repositoryUrl` (which already has any `/tree/<ref>/<subdir>`
 * stripped). Returns undefined for non-repository sources so the caller falls
 * back to last-segment. This is what stops `/tree/main` yielding `main` and
 * `/tree/main/plugins` yielding `plugins`.
 */
function repositoryOwnerRepoLabel(source: string): string | undefined {
  let resolved;
  try {
    resolved = resolvePluginInstallSource(source).source;
  } catch {
    return undefined;
  }
  if (resolved.kind !== 'repository') return undefined;
  const withoutGit = resolved.repositoryUrl.replace(/\.git$/i, '');
  const segments = withoutGit.split(/[\\/:]+/).map(segment => segment.trim()).filter(Boolean);
  return segments.length >= 2 ? segments.slice(-2).join('/') : undefined;
}

function normalizeSparsePaths(sparsePaths?: string[]): string[] {
  if (!Array.isArray(sparsePaths)) return [];
  return sparsePaths.map(path => path.trim()).filter(Boolean);
}

function toLoadError(
  marketplaceRegistryId: string,
  displayName: string | undefined,
  diagnostics: { code: string }[],
): MarketplaceRegistryLoadError {
  return {
    marketplaceRegistryId,
    ...(displayName ? { displayName } : {}),
    diagnosticCodes: diagnostics.map(diagnostic => diagnostic.code),
  };
}

/**
 * P6.621 — the `name` a fetched catalog manifest declares for ITSELF, when it
 * declares one. The DTO is `unknown` at this seam by design, so the read is
 * defensive; an empty or non-string name is the same as none, which makes the
 * rename comparison skip rather than announce a change to nothing.
 */
function declaredCatalogName(catalog: unknown): string | undefined {
  if (catalog === null || typeof catalog !== 'object') return undefined;
  const name = (catalog as { name?: unknown }).name;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Path-free "still loading" marker for a registry whose catalog fetch is in
 * flight off the request path. Rides the existing `registryLoadErrors` channel
 * (a distinct diagnostic code, so a real failure stays distinguishable); the
 * registry's items replace it on the next poll/refetch once the fetch settles.
 */
function pendingLoadError(
  marketplaceRegistryId: string,
  displayName: string | undefined,
): MarketplaceRegistryLoadError {
  return {
    marketplaceRegistryId,
    ...(displayName ? { displayName } : {}),
    diagnosticCodes: ['marketplace.registry.fetch_pending'],
  };
}

/**
 * Stable digest of a registry's fetch-affecting fields. When any of them change
 * (notably `lastUpgradedAt` after an upgrade), the cached catalog is treated as
 * stale and re-fetched.
 */
function registrySignature(registry: PluginMarketplaceRegistry): string {
  return [
    registry.source,
    registry.refName ?? '',
    (registry.sparsePaths ?? []).join('|'),
    registry.lastUpgradedAt ?? '',
  ].join('\u0000');
}

class RegistryFetchTimeoutError extends Error {
  override readonly name = 'RegistryFetchTimeoutError';
}

/**
 * Reject with {@link RegistryFetchTimeoutError} if `promise` has not settled
 * within `ms`. The underlying operation is not cancellable (the staging layer
 * has no abort signal), but the caller is unblocked regardless — a leaked clone
 * simply resolves into a discarded result later.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RegistryFetchTimeoutError(`Registry fetch exceeded ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Production factory: compose the registry source over a default
 * `PluginMarketplaceRegistryStore` (marketplaces.json at `PLUGINS_DIR`) and a default `PluginInstallService` (the
 * R1 governed staging seam — its default `DpGitLabArtifactAuthProvider` reuses
 * the SAME Artifactory-governed auth path plugin installs use, so "no new network
 * client" holds by construction). server-core calls this so it never imports the
 * retired classes itself.
 */
export function createPluginRegistrySource(
  options: {
    baseTempDir?: string;
    now?: () => number;
    catalogCacheDir?: string;
    dpSessionBroker?: DpSessionBroker;
    /** `strictKnownMarketplaces` from the enforced managed policy, when set. */
    strictKnownMarketplaces?: readonly ManagedMarketplaceEntryV1[];
    /**
     * `blockedMarketplaces` (P2.467). Threaded through the factory so the gate
     * has a production feed the moment the policy schema carries the key — see
     * {@link MarketplaceRegistrySourceOptions.blockedMarketplaces} for why that
     * is a separate unit.
     */
    blockedMarketplaces?: readonly ManagedMarketplaceEntryV1[];
    /** `extraKnownMarketplaces` from the enforced managed policy, when set. */
    extraKnownMarketplaces?: readonly DeliveredMarketplaceEntryV1[];
    /** `pluginSuggestionMarketplaces` from the enforced managed policy, when set. */
    pluginSuggestionMarketplaces?: readonly string[];
    /**
     * P2.501 — re-resolve all four of the above at check time. See {@link
     * MarketplaceRegistrySourceOptions.resolveManagedMarketplacePolicy}; the
     * four fields above stay as the boot snapshot this falls back to.
     */
    resolveManagedMarketplacePolicy?: () => ManagedMarketplacePolicySlice;
  } = {},
): PluginRegistrySource {
  return new PluginRegistrySource({
    store: new PluginMarketplaceRegistryStore(),
    staging: new PluginInstallService({
      ...(options.dpSessionBroker ? { dpSessionBroker: options.dpSessionBroker } : {}),
    }),
    ...(options.strictKnownMarketplaces === undefined
      ? {}
      : { strictKnownMarketplaces: options.strictKnownMarketplaces }),
    ...(options.blockedMarketplaces === undefined
      ? {}
      : { blockedMarketplaces: options.blockedMarketplaces }),
    ...(options.extraKnownMarketplaces === undefined
      ? {}
      : { extraKnownMarketplaces: options.extraKnownMarketplaces }),
    ...(options.pluginSuggestionMarketplaces === undefined
      ? {}
      : { pluginSuggestionMarketplaces: options.pluginSuggestionMarketplaces }),
    ...(options.resolveManagedMarketplacePolicy === undefined
      ? {}
      : { resolveManagedMarketplacePolicy: options.resolveManagedMarketplacePolicy }),
    // Persist parsed catalogs under the plugin store root so a restart serves
    // browse items without re-cloning every configured registry.
    catalogCacheDir: options.catalogCacheDir ?? join(PLUGINS_DIR, CATALOG_CACHE_DIRNAME),
    ...(options.baseTempDir ? { baseTempDir: options.baseTempDir } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
