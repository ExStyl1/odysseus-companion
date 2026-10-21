import type {
  PluginActivationTarget,
  PluginManagementInstallResult,
} from '../plugins/management-types.ts';
import type {
  PluginConnectorAuthTiming,
  PluginDiagnostic,
  PluginInstallSource,
  PluginMarketplaceEntryDefinition,
} from '../plugins/types.ts';
import type { PluginMarketplaceRelevanceV1 } from './relevance.ts';

export const SKILLS_MARKET_MAX_PAGE_SIZE = 100;

export type MarketplaceListKind = 'skills' | 'plugins';

export type MarketplaceItemKind = 'skill' | 'plugin' | 'mcp' | 'hook';

export type MarketplaceSourceType = 'npm' | 'gitlab' | 'url';

export type MarketplaceSort = 'installs' | 'name' | 'tenant' | 'path';

export interface MarketplaceClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface MarketplaceListParams {
  query?: string;
  page?: number;
  pageSize?: number;
  sort?: MarketplaceSort;
  capabilities?: string[];
  /**
   * @deprecated `nessy-marketplace-api` v1.0 exposes NO `phase` filter on
   * `/v1/skills` — the parameter list is `domain`, `subdomain`, `q`, `page`,
   * `pageSize`, `sort`, `withDescription`, `profession`, `tag`, `tenant`.
   * Measured 2026-07-31: `?phase[]=production` returns the unfiltered 6084.
   * The field is kept because the renderer and the RPC projection still carry
   * it; the client no longer puts it on the wire.
   */
  phases?: string[];
  professions?: string[];
  tenants?: string[];
  /** Skill tag facet (`/v1/skills/facets` -> `tags`), repeated `tag` params. */
  tags?: string[];
  /** Persisted taxonomy domain filter. */
  domain?: string;
  /** Persisted taxonomy subdomain filter. */
  subdomain?: string;
  /** Only skills with a non-empty description (5842 of 6084 on 2026-07-31). */
  withDescription?: boolean;
}

/** One `/v1/skills/facets` option: the filter value plus its catalog count. */
export interface MarketplaceFacetOption {
  value: string;
  title: string;
  count: number;
}

/**
 * The skills-market filter vocabulary. Measured 2026-07-31: 457 tenants,
 * 1354 tags, 10 professions — the values `MarketplaceListParams.tenants`,
 * `tags` and `professions` must be drawn from.
 */
export interface MarketplaceSkillFacets {
  tenants: MarketplaceFacetOption[];
  tags: MarketplaceFacetOption[];
  professions: MarketplaceFacetOption[];
}

/**
 * `/v2/registry/catalog` caps `limit` at 100 and rejects `pageSize` outright
 * (HTTP 400 `INVALID_QUERY`, measured 2026-07-31).
 */
export const SKILLS_MARKET_REGISTRY_MAX_LIMIT = 100;

export type SkillsRegistryCatalogSort = 'name' | 'installs' | 'updatedAt';

export interface SkillsRegistryCatalogParams {
  query?: string;
  limit?: number;
  cursor?: string;
  sort?: SkillsRegistryCatalogSort;
  tenants?: string[];
  tags?: string[];
  professions?: string[];
  domain?: string;
  subdomain?: string;
}

/**
 * One immutable Registry entry inside a variant cluster. Several variants of the
 * same skill (the same name published from different sources) share one group;
 * only the group belongs in a browse list.
 */
export interface SkillsRegistryVariant {
  registryId: string;
  name: string;
  description?: string;
  canonicalAddress?: string;
  installCommand?: string;
  installable: boolean;
  raw: unknown;
}

/**
 * A variant cluster from `/v2/registry/catalog` — the server-side grouping the
 * browse list must show one row for. Measured 2026-07-31: 3914 groups over 5341
 * entries, so 1427 of the entries are duplicate variants of a row already shown.
 *
 * Unrelated to {@link MarketplaceRegistrySource}, which is a bring-your-own
 * plugin catalog; this is the Skills Market's own v2 Registry.
 */
export interface SkillsRegistryGroup {
  groupId: string;
  name: string;
  description?: string;
  author?: string;
  defaultVariantId: string;
  installCount: number;
  variants: SkillsRegistryVariant[];
}

export interface SkillsRegistryCatalogFacets {
  tenants: MarketplaceFacetOption[];
  tags: MarketplaceFacetOption[];
  professions: MarketplaceFacetOption[];
  domains: MarketplaceFacetOption[];
}

export interface SkillsRegistryCatalogPage {
  generationId: string;
  /** One entry per variant cluster — already deduplicated by the server. */
  groups: SkillsRegistryGroup[];
  /** Row count a deduplicated browse list should report. */
  totalGroups: number;
  /** Registry entries behind those groups; the difference is the duplicates. */
  totalEntries: number;
  nextCursor?: string;
  facets: SkillsRegistryCatalogFacets;
}

/** The one-request archive behind a skill snapshot, with its published digest. */
export interface MarketplaceSkillArchiveRef {
  /** `sha256:<hex>` over the archive bytes. */
  digest: string;
  size?: number;
  mediaType?: string;
  /** Market-relative download path (`/v2/skills/...`). */
  downloadPath: string;
}

/**
 * The immutable identity of the skill revision an install actually took, from
 * `/v2/skills/{id}/releases/latest`. `snapshotId` is what makes an installed
 * market skill comparable with the catalog later — without it a record can
 * never be told stale.
 */
export interface MarketplaceSkillSnapshot {
  skillId: string;
  sourceId?: string;
  snapshotId: string;
  artifactId: string;
  /** `sha256:<hex>` over the snapshot content. */
  contentDigest?: string;
  lifecycle?: string;
  sourceCommit?: string;
  sourceCommittedAt?: string;
  /** Market-relative per-file listing path for this snapshot. */
  filesPath?: string;
  archive?: MarketplaceSkillArchiveRef;
}

/** One skill's whole file tree, fetched in a single digest-checked request. */
export interface MarketplaceSkillArchiveDownload {
  bytes: Uint8Array;
  /** sha256 hex computed over the received bytes. */
  digest: string;
  /** The digest the server advertised for this body, when it advertised one. */
  advertisedDigest?: string;
  snapshotId?: string;
  artifactId?: string;
}

export interface MarketplaceInstallationReport {
  /** Registry entry kind; the v2 Registry counts `agent-skill` entries. */
  kind?: string;
  id: string;
  /**
   * Bearer JWT for the marketplace. Travels in the `Authorization` header only —
   * never a query parameter — and is never logged or echoed in an error.
   */
  accessToken?: string;
}

export interface MarketplaceInstallationReceipt {
  /** False when the same user already had an install counted today. */
  counted: boolean;
  installCount: number;
}

export interface MarketplaceRawListResult<TItem> {
  items: TItem[];
  page: number;
  pageSize: number;
  total: number;
  visible: number;
  generatedAt?: string;
  nextPage?: number;
  raw: unknown;
}

/**
 * Path-free, per-registry load failure surfaced alongside a `plugins` list so
 * R3 can show a "some marketplaces could not be loaded" note. Mirrors the shape
 * of Codex `MarketplaceLoadErrorInfo` MINUS its absolute `marketplacePath` — no
 * `installedRoot` / `catalogRoot` / `marketplacePath` ever crosses this type
 * (Stop Condition). Additive: only produced when a registry source is injected.
 */
export interface MarketplaceRegistryLoadError {
  /** The registry-id tag (matches `MarketplaceCatalogItem.marketplaceRegistryId`). */
  marketplaceRegistryId: string;
  /** Path-free display label for the failing registry (never a filesystem path). */
  displayName?: string;
  /** Diagnostic codes only — no message paths, no absolute source. */
  diagnosticCodes: string[];
}

export interface MarketplaceListResult {
  items: MarketplaceCatalogItem[];
  page: number;
  pageSize: number;
  total: number;
  visible: number;
  generatedAt?: string;
  nextPage?: number;
  /**
   * Per-registry load failures for a `plugins` list (additive, omit-when-empty).
   * Never present for a `skills` list. Path-free by construction.
   */
  registryLoadErrors?: MarketplaceRegistryLoadError[];
}

export type MarketplaceInstallSourceConfidence =
  | 'primary'
  | 'fallback'
  | 'command-derived'
  /**
   * Coordinates DERIVED from the listing's own repository path + name, because
   * the entry published no install source, fallback or command at all — 106 of
   * the 118 live skills-market rows on 2026-07-31. Strictly weaker than
   * `command-derived`: the publisher never stated these coordinates, so the
   * registry is the authority on whether the package exists. Never silently
   * equivalent to a published source.
   */
  | 'coordinates-derived'
  | 'command-only'
  | 'unsupported-commands'
  | 'missing';

export type MarketplaceStructuredInstallSource =
  | {
      type: 'npm';
      packageName: string;
      version?: string;
      registry?: string;
      /** The coordinates were derived from the listing, not published by it. */
      derivedCoordinates?: boolean;
      raw: InstallSourceDto;
    }
  | {
      type: 'gitlab';
      url: string;
      ref?: string;
      path?: string;
      raw: InstallSourceDto;
    }
  | {
      type: 'url';
      url: string;
      ref?: string;
      path?: string;
      raw: InstallSourceDto;
    }
  | {
      /** skills-market v2 per-file snapshot listing (digests + download URLs). */
      type: 'market-files';
      filesUrl: string;
      raw: InstallSourceDto;
    };

export interface MarketplaceInstallDescriptor {
  displayCommand?: string;
  scopedCommands?: {
    user?: string;
    workspace?: string;
  };
  source?: MarketplaceStructuredInstallSource;
  fallback?: MarketplaceStructuredInstallSource;
  sourceConfidence: MarketplaceInstallSourceConfidence;
}

export type MarketplaceIcon =
  | { kind: 'symbol'; name: 'skill' | 'plugin' | 'mcp' | 'hook' }
  | { kind: 'url'; url: string };

export interface MarketplaceInstalledState {
  pluginKey: string;
  activeInstanceId: string;
  pluginId: string;
  version: string;
  activation: 'active' | 'inactive' | 'blocked';
  shadowed?: boolean;
}

export interface MarketplaceInstalledSourceMetadata {
  marketplaceItemId?: string;
  rawSkillId?: string;
  packageName?: string;
  packageVersion?: string;
  repositoryUrl?: string;
  sourceUrl?: string;
}

export interface MarketplaceInstalledPluginSummary {
  pluginKey: string;
  activeInstanceId: string;
  marketplaceId: string;
  pluginId: string;
  version: string;
  name: string;
  description?: string;
  installedAt: number;
  capabilityKinds: string[];
  diagnostics: unknown[];
  source?: MarketplaceInstalledSourceMetadata;
}

export interface MarketplaceCatalogItem {
  id: string;
  kind: MarketplaceItemKind;
  listKind: MarketplaceListKind;
  name: string;
  description?: string;
  version?: string;
  icon: MarketplaceIcon;
  sourceUrl?: string;
  detailUrl?: string;
  tenant?: string;
  repo?: string;
  capabilities: string[];
  installed?: MarketplaceInstalledState;
  install: MarketplaceInstallDescriptor;
  raw: unknown;
  /**
   * Registry-id tag (R2, additive). Present ONLY on items that came from an
   * injected bring-your-own registry catalog; absent on built-in Skills Market
   * items. R3 groups + routes the browse list by this id; the RPC Safe
   * projection stamps it as `marketplaceId`.
   */
  marketplaceRegistryId?: string;
  /**
   * Path-free display label for the owning registry (registry name only).
   * NEVER an absolute path (`installedRoot`/`catalogRoot`). Additive, R2.
   */
  marketplaceRegistryLabel?: string;
  /**
   * Listing ids this row used to have IN THIS SAME registry, from the catalog's
   * `renames` map (`plugins/host-marketplace.md#migrate-users-with-a-renames-map` — "Map from a former plugin
   * `name` to its current name ... Lets existing users migrate automatically
   * when you rename or remove an entry in `plugins`"). C3, additive,
   * omit-when-empty; absent on built-in Skills Market rows.
   *
   * Ids, not names, and that is the point: an installed record stores the
   * listing id it was installed under, so a former id is compared with exactly
   * the same equality the row's CURRENT id already uses. A `null` rename is a
   * removal and never appears here — it has no surviving row.
   */
  formerIds?: string[];
  /**
   * Pre-resolved typed install source (R2, additive). Registry catalog items
   * carry the parser's `PluginInstallSource` here so install routes through the
   * EXISTING `MarketplaceService.install` path without re-deriving a source from
   * the (absent) DTO `install` descriptor. Skills Market items leave this unset
   * and continue to resolve via `install.source`/`fallback`.
   */
  structuredInstallSource?: PluginInstallSource;
  /**
   * The catalog entry's OWN plugin definition (S9): component fields, `strict`,
   * and the marketplace-root flag. Carried from the parsed entry through install
   * so the format adapter can build the plugin the entry describes, not only the
   * one its `source` happens to contain. Absent for Skills Market rows.
   */
  marketplaceEntry?: PluginMarketplaceEntryDefinition;
  /** Server-only external catalog policy retained through listing -> install. */
  connectorAuthTiming?: PluginConnectorAuthTiming;
  /** Raw server-only external policy spelling retained for install provenance. */
  catalogAuthenticationPolicy?: string;
  /**
   * `plugin-relevance.md` § Add relevance to a plugin entry — the entry's own
   * `relevance` block, used ONLY to decide a browse-time suggestion. Additive
   * and omit-when-absent, so an existing on-disk parsed-catalog cache entry
   * simply lacks it until its signature moves and it re-fetches.
   *
   * Deliberately NOT part of `marketplaceEntry.fields`: that allowlist is
   * persisted with the install record, and browse-time matching data has no
   * business travelling onto disk with an installed plugin.
   */
  relevance?: PluginMarketplaceRelevanceV1;
}

export interface MarketplaceMetaDto {
  generated_at?: string;
  skills_count?: number;
  extensions_count?: number;
  etag?: string;
  [key: string]: unknown;
}

/**
 * C3.260 widened this to the four hosts `plugins/repository-hosts.ts` has an
 * acquisition route for. It is deliberately a re-declaration rather than an
 * alias of `RepositoryHostKind`: this one is a WIRE field on
 * {@link MarketplaceRepositoryInstallProposal}, so it changes only when a
 * renderer is ready for the new value, where the acquisition kind may change
 * whenever a route is added.
 */
export type MarketplaceRepositoryHostKind = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops';

export type MarketplaceRepositoryDetectedFormat =
  | 'codex-plugin'
  | 'nessy-extension'
  | 'nessy-plugin'
  | 'skill'
  | 'unknown';

export interface MarketplaceRepositoryInstallRequest {
  url: string;
  ref?: string;
  subdirectory?: string;
}

export interface MarketplaceRepositoryInstallProposal {
  status: 'installable' | 'unsupported';
  sourceUrl: string;
  hostKind?: MarketplaceRepositoryHostKind;
  repositoryUrl?: string;
  ref?: string;
  subdirectory?: string;
  detectedFormat: MarketplaceRepositoryDetectedFormat;
  confidence: 'high' | 'medium' | 'low';
  candidateFiles: string[];
  diagnostics: PluginDiagnostic[];
  suggestedNextSteps: string[];
  source?: PluginInstallSource;
}

export interface MarketplaceListRequest extends MarketplaceListParams {
  kind: MarketplaceListKind;
}

export interface MarketplaceInspectRequest {
  id: string;
  kind: MarketplaceListKind | MarketplaceItemKind;
}

export interface MarketplaceInspectResult {
  item: MarketplaceCatalogItem;
  diagnostics: PluginDiagnostic[];
}

export interface MarketplaceInstallRequest {
  item?: MarketplaceCatalogItem;
  source?: PluginInstallSource;
  proposal?: MarketplaceRepositoryInstallProposal;
  activateIn?: PluginActivationTarget;
  baseTempDir?: string;
  /**
   * Catalog-derived install hints for a caller that has the hints but not the
   * whole catalog item — the agent path, which carries them through the
   * proposal. `item`'s own values win when both are present.
   */
  connectorAuthTiming?: PluginConnectorAuthTiming;
  catalogAuthenticationPolicy?: string;
}

export interface MarketplaceEnableRequest {
  pluginKey: string;
  target: PluginActivationTarget;
}

export interface MarketplaceDisableRequest extends MarketplaceEnableRequest {}

export interface MarketplaceUninstallRequest {
  pluginKey: string;
}

export type MarketplaceRefreshRequest = Record<string, never>;

/**
 * `plugins/loading.md#when-auto-update-runs` — the installed-BUNDLE half of auto-update. Scoped
 * to the marketplaces whose catalog just refreshed; omit `marketplaceIds` to
 * consider every installed plugin.
 */
export interface MarketplaceBundleUpdateRequest {
  marketplaceIds?: readonly string[];
}

export interface MarketplaceBundleUpdateResult {
  /** Plugin keys whose catalog row was found and version-compared. */
  considered: string[];
  updated: Array<{ pluginKey: string; fromVersion: string; toVersion: string; tag?: string }>;
  /**
   * `plugins/host-marketplace.md#hold-users-on-one-version` — a skip that must be reportable, with the
   * constraining plugins named. A skip with no `reasonCode` is not listed: "the
   * catalog offers nothing newer" is the normal outcome, not an error.
   */
  skipped: Array<{ pluginKey: string; reasonCode: string; constrainedBy?: string[] }>;
}

export interface MarketplaceTryInChatRequest {
  item: MarketplaceCatalogItem;
  locale?: string;
}

export interface MarketplaceTryInChatResult {
  prompt: string;
  autoSend: false;
  itemId: string;
  itemName: string;
  kind: MarketplaceItemKind;
}

export type MarketplaceServiceErrorCode =
  | 'marketplace.install.invalid_source'
  | 'marketplace.install.unsupported_source'
  | 'marketplace.install.unavailable'
  | 'marketplace.enable.unavailable'
  | 'marketplace.disable.unavailable'
  | 'marketplace.uninstall.unavailable'
  | 'marketplace.refresh.unavailable';

export interface MarketplaceRepositoryInstaller {
  install(source: PluginInstallSource): Promise<PluginManagementInstallResult>;
}

export interface InstallSourceDto {
  type?: MarketplaceSourceType | string;
  url?: string;
  ref?: string;
  path?: string;
  package?: string;
  version?: string;
  registry?: string;
  [key: string]: unknown;
}

export interface MarketplaceInstallCommandsDto {
  user?: string;
  workspace?: string;
  [key: string]: unknown;
}

export interface MarketplaceInstallDto {
  command?: string;
  commands?: MarketplaceInstallCommandsDto;
  source?: InstallSourceDto;
  fallback?: InstallSourceDto;
  [key: string]: unknown;
}

/**
 * Structured artifact-delivery descriptor from the internal marketplace
 * snapshot (A3). Distinct shape from `InstallSourceDto` (`packageName` not
 * `package`, `type: 'npm-package'` not `'npm'`) — kept as its own DTO rather
 * than widening `InstallSourceDto`'s field names.
 */
export interface MarketplaceArtifactDeliveryDto {
  type?: 'npm-package' | string;
  packageName?: string;
  version?: string;
  registry?: string;
  [key: string]: unknown;
}

/** Structured source-locator descriptor from the internal marketplace snapshot (A3). */
export interface MarketplaceSourceLocatorDto {
  type?: MarketplaceSourceType | string;
  url?: string;
  ref?: string;
  path?: string;
  [key: string]: unknown;
}

/** Detail-endpoint manifest fields from the internal marketplace snapshot (A3). */
export interface MarketplaceDetailDto {
  manifest?: unknown;
  manifestUrl?: string;
  manifestPath?: string;
  [key: string]: unknown;
}

export interface SkillDto {
  id?: string;
  skillId?: string;
  name?: string;
  description?: string;
  tags?: string[];
  tenant?: string;
  repo_path?: string;
  repo_display?: string;
  repo_url?: string;
  folder_name?: string;
  skill_path?: string;
  skill_url?: string;
  phase?: string;
  professions?: string[];
  taxonomy?: unknown;
  security_block?: unknown;
  quality?: unknown;
  promotion?: unknown;
  signals?: unknown;
  metrics?: unknown;
  release?: unknown;
  install?: MarketplaceInstallDto;
  npmPackage?: unknown;
  artifactDelivery?: MarketplaceArtifactDeliveryDto;
  sourceLocator?: MarketplaceSourceLocatorDto;
  detail?: MarketplaceDetailDto;
  command?: string;
  [key: string]: unknown;
}

export interface PluginDto {
  id?: string;
  kind?: string;
  name?: string;
  description?: string;
  version?: string;
  path?: string;
  marketUrl?: string;
  metrics?: unknown;
  capabilities?: unknown;
  install?: MarketplaceInstallDto;
  detail?: MarketplaceDetailDto;
  command?: string;
  [key: string]: unknown;
}

export interface PluginsResponseDto {
  plugins?: PluginDto[];
  items?: PluginDto[];
  results?: PluginDto[];
  data?: PluginDto[];
  total?: number;
  page?: number;
  pageSize?: number;
  page_size?: number;
  generated_at?: string;
  [key: string]: unknown;
}

export interface CatalogDto {
  skills?: SkillDto[];
  extensions?: PluginDto[];
  generated_at?: string;
  [key: string]: unknown;
}
