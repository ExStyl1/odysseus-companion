/**
 * Registry catalog → browse items (1.10.0 R2).
 *
 * Turns a fetched registry catalog (R1's `fetchRegistryCatalog` output) into
 * `MarketplaceCatalogItem[]` for the marketplace browse list. The DTO is parsed
 * by the EXISTING `parseExternalPluginCatalog` — each proposal already carries a
 * typed, path-free `PluginInstallSource` plus provenance. This module ONLY maps
 * a proposal to a catalog row; it invents no new install/enablement machinery
 * and no new source resolution (install reuses `MarketplaceService.install`).
 *
 * `format` DECISION: R1 reads a format-agnostic `marketplace.json`/`plugins.json`
 * at the staged root, and `parseExternalPluginCatalog`'s `format` argument only
 * labels provenance + diagnostic wording — it does NOT change source resolution
 * (that branches on the entry `source` shape). The catalog DTO carries no
 * reliable format discriminator at the manifest root, so R2 defaults to
 * `'codex'` (the marketplace-catalog model this feature is built on) and lets a
 * registry override it (`RegistryCatalogInput.format`) when a later phase can
 * infer it from format-specific manifest markers.
 *
 * ## Two browse-time rows this module cannot fill, and why that is the page's
 * own answer rather than a gap (P6.423, measured 2026-09-06)
 *
 * `discover-plugins.md` § *Install a plugin* gives a not-yet-installed plugin's
 * detail pane "A **Context cost** estimate so you can see how many tokens the
 * plugin will add to your context window every turn" and "The plugin's **Last
 * updated** date". Neither has a source here:
 *
 * - No documented marketplace-entry field carries either datum. Both spellings
 *   score ZERO across the whole of `plugin-marketplaces.md`, which is where the
 *   entry field tables live. What a listing declares is component KINDS, and
 *   `declaredKindsForProposal` below is deliberate about that being a floor
 *   rather than an inventory — a kind has no size, so no honest token count can
 *   be derived from it.
 * - The estimator the row would reuse (`nessy-general-agent plugin details`) is
 *   post-install BY CONSTRUCTION: it measures the bytes of an installed bundle's
 *   components. Before an install there are no bytes, and for a `git`/`archive`
 *   listing getting them means fetching the bundle — which is the install.
 *
 * And the page says exactly this about the marketplace kinds this fork supports:
 * "Not every plugin provides the data behind these fields. For plugins from
 * local or custom marketplaces, you may not see the **Context cost** and **Last
 * updated** rows, and the **Will install** section may show **Components will be
 * discovered at installation** instead."
 *
 * So the honest browse row omits both rather than showing a number derived from
 * a kind list. If a catalog is ever found to publish either datum — the Skills
 * Market registry accepts `sort=updatedAt`, so its upstream knows an update
 * time even though no DTO field here carries one — it becomes an additive field
 * on `MarketplaceCatalogItem` and a row the card renders WHEN PRESENT, never a
 * placeholder.
 */
import { isAbsolute, relative } from 'node:path';
import {
  parseExternalPluginCatalog,
  type ExternalPluginCatalogDto,
  type ExternalPluginCatalogFormat,
  type ExternalPluginCatalogProposal,
} from './external-catalog-adapters.ts';
import { shortenArchiveDigest } from '../plugins/plugin-version-chain.ts';
import type { MarketplaceCatalogItem } from './types.ts';
import type { PluginMarketplaceRelevanceV1 } from './relevance.ts';
import type {
  PluginDiagnostic,
  PluginInstallSource,
  PluginMarketplaceEntryDefinition,
} from '../plugins/types.ts';
import {
  deriveRegistryPluginSource,
  type RegistryScannedPlugin,
} from '../plugins/registry-catalog-fetcher.ts';
import {
  declaredPluginComponentKinds,
  PLUGIN_DECLARED_COMPONENT_KINDS,
  type PluginDeclaredComponentKind,
} from '../plugins/declared-components.ts';

/** Default catalog format when a registry does not declare one (see file header). */
export const DEFAULT_REGISTRY_CATALOG_FORMAT: ExternalPluginCatalogFormat = 'codex';

export interface RegistryCatalogInput {
  /** Registry-id tag stamped onto every produced item (R3 groups by this). */
  marketplaceRegistryId: string;
  /** Path-free registry display label (registry name only; never a path). */
  displayName?: string;
  /** Raw catalog manifest object from R1's fetcher (`FetchRegistryCatalogResult.catalog`). */
  catalog: unknown;
  /** ABSOLUTE staged root the catalog was read from (server-only; pins relative local sources). */
  catalogRoot: string;
  /**
   * The registry's OWN classified source (repo/URL/local folder). When present,
   * a `local` catalog entry (which the parser resolves to an absolute path
   * INSIDE the ephemeral, already-removed staged root) is rebuilt into a DURABLE
   * registry-relative source (repo + subdirectory, or real local subpath) — the
   * same shape the directory-of-plugins scan produces. Omit it and the parser's
   * raw local-path source is kept as-is (used by the low-level unit contract).
   */
  registrySource?: PluginInstallSource;
  /** Catalog format; defaults to {@link DEFAULT_REGISTRY_CATALOG_FORMAT}. */
  format?: ExternalPluginCatalogFormat;
  /**
   * Component kinds each entry's own per-plugin manifest declares, keyed by
   * entry name (R1's `FetchRegistryCatalogResult.manifestComponentKinds`).
   * Unioned with what the ENTRY itself declares — a Codex root catalog puts the
   * declaration in the manifest, a Claude one may put it in the entry, and
   * `anthropics/claude-plugins-official` does both across different rows.
   */
  manifestComponentKinds?: Readonly<Record<string, readonly string[]>>;
}

export interface RegistryCatalogItemsResult {
  items: MarketplaceCatalogItem[];
  diagnostics: PluginDiagnostic[];
}

/**
 * Parse a fetched registry catalog and map its proposals to browse items.
 * Parsing (path-traversal + unpinned-git rejection) is delegated wholesale to
 * `parseExternalPluginCatalog`; this function only shapes the rows.
 */
export function registryCatalogItems(input: RegistryCatalogInput): RegistryCatalogItemsResult {
  const format = input.format ?? DEFAULT_REGISTRY_CATALOG_FORMAT;
  const { proposals, diagnostics, renames } = parseExternalPluginCatalog(
    format,
    input.catalog as ExternalPluginCatalogDto,
    {
      catalogRoot: input.catalogRoot,
      // P6.177 — the same source already rebuilds `local` entries below; here it
      // carries the marketplace's own `headers` to the archive downloads on its
      // origin (`plugins/host-marketplace.md#authenticate-archive-downloads`). The
      // parser is the only place that knows an entry's resolved archive URL.
      ...(input.registrySource ? { marketplaceSource: input.registrySource } : {}),
    },
  );
  const formerIds = formerListingIdsByName(renames, proposals, input.marketplaceRegistryId);
  const items = proposals.map(proposal => proposalToCatalogItem(
    durableSourceProposal(proposal, input),
    input,
    formerIds.get(proposal.pluginName),
  ));
  return { items, diagnostics };
}

/**
 * Invert the parser's resolved `renames` into the FORMER LISTING IDS each
 * surviving row still answers to (C3).
 *
 * The map itself stops here on purpose: it is per-registry, and the row is the
 * only thing downstream that already carries its registry. Stamping the former
 * ids on the row keeps the join anchored to the marketplace the row came from
 * without a map having to cross four more type boundaries carrying its own
 * registry key.
 *
 * Two entries are dropped rather than exposed, and both are dropped HERE so no
 * consumer can get them wrong:
 *
 * - A `null` value is a REMOVAL, not a rename (`plugins/host-marketplace.md#migrate-users-with-a-renames-map`:
 *   "or to `null` if the plugin was removed"). There is no surviving row to
 *   attach it to, so it can never join an installed record to anything.
 * - A former name that the catalog STILL lists is not former. Such an entry
 *   would give two rows the same id to answer to, and an installed record would
 *   light up both. The parser rejects a rename whose TARGET is unlisted; this
 *   is the mirror case on the source side.
 *
 * Chains are already walked by `parseExternalPluginCatalog`, so every key here
 * is one hop from its terminal.
 */
function formerListingIdsByName(
  renames: Record<string, string | null> | undefined,
  proposals: readonly ExternalPluginCatalogProposal[],
  marketplaceRegistryId: string,
): Map<string, string[]> {
  const byCurrentName = new Map<string, string[]>();
  if (!renames) return byCurrentName;
  const listed = new Set(proposals.map(proposal => proposal.pluginName));
  for (const [formerName, currentName] of Object.entries(renames)) {
    if (currentName === null || listed.has(formerName)) continue;
    const formerId = registryItemId(marketplaceRegistryId, formerName);
    const existing = byCurrentName.get(currentName);
    if (existing) existing.push(formerId);
    else byCurrentName.set(currentName, [formerId]);
  }
  return byCurrentName;
}

/**
 * Rebuild a proposal whose source resolved to a path INSIDE the (now-removed)
 * staged catalog root into a DURABLE registry-relative source. Only fires for a
 * `local-path` source that is genuinely contained in the catalog root and only
 * when the registry's own source is known; otherwise the proposal is returned
 * untouched. The parser has already run its path-traversal containment check, so
 * a `..`/absolute `relative()` here just means "leave it alone".
 */
function durableSourceProposal(
  proposal: ExternalPluginCatalogProposal,
  input: RegistryCatalogInput,
): ExternalPluginCatalogProposal {
  if (!input.registrySource || proposal.source.kind !== 'local-path') return proposal;
  const relPath = relative(input.catalogRoot, proposal.source.path);
  // Empty means the plugin IS the registry root (Honey and other single-plugin
  // marketplaces use `path: "./"`). That is a valid durable mapping, not a
  // reason to retain the already-removed staging directory.
  if (relPath.startsWith('..') || isAbsolute(relPath)) return proposal;
  return {
    ...proposal,
    source: deriveRegistryPluginSource(input.registrySource, relPath, input.catalogRoot),
  };
}

export interface RegistryScannedItemsInput {
  /** Registry-id tag stamped onto every produced item (R3 groups by this). */
  marketplaceRegistryId: string;
  /** Path-free registry display label (registry name only; never a path). */
  displayName?: string;
  /** Plugins discovered by the directory-of-plugins scan fallback (R1 fetcher). */
  scannedPlugins: RegistryScannedPlugin[];
}

/**
 * Map directory-of-plugins scan results to browse items. The scan already
 * produced a typed, durable `PluginInstallSource` per plugin (no manifest to
 * re-parse), so this bypasses `parseExternalPluginCatalog` and only shapes rows.
 */
export function registryScannedCatalogItems(input: RegistryScannedItemsInput): MarketplaceCatalogItem[] {
  return input.scannedPlugins.map(plugin => buildRegistryCatalogItem({
    marketplaceRegistryId: input.marketplaceRegistryId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    name: plugin.name,
    ...(plugin.description ? { description: plugin.description } : {}),
    ...(plugin.version ? { version: plugin.version } : {}),
    source: plugin.source,
    ...(plugin.declaredComponentKinds?.length
      ? { capabilities: plugin.declaredComponentKinds }
      : {}),
  }));
}

/**
 * The component kinds this row's LISTING declares: the entry's own component
 * fields (`plugin-marketplaces.md` § Optional plugin fields, "Component
 * configuration fields") unioned with the ones the plugin's per-plugin manifest
 * declares. A declaration is a floor, not an inventory — the contract, and why,
 * is in `plugins/declared-components.ts`.
 */
function declaredKindsForProposal(
  proposal: ExternalPluginCatalogProposal,
  input: RegistryCatalogInput,
): PluginDeclaredComponentKind[] {
  const fromEntry = declaredPluginComponentKinds(proposal.entryDefinition?.fields);
  const fromManifest = input.manifestComponentKinds?.[proposal.pluginName] ?? [];
  if (!fromEntry.length && !fromManifest.length) return [];
  const union = new Set<string>([...fromEntry, ...fromManifest]);
  return PLUGIN_DECLARED_COMPONENT_KINDS.filter(kind => union.has(kind));
}

/**
 * The `archive`-source digest version (`plugins-reference.md` § Version
 * management, item 4, fetched 2026-08-24) — the first 12 hex characters of the
 * `sha256` pin. The pin reaches here as the `url` install source's
 * `expectedHash`, normalized to `sha256-<64 lowercase hex>` by
 * `external-catalog-adapters.ts:resolveClaudeArchiveSource`. Any other source
 * shape (an unpinned archive, a git/npm/local source) carries no pin, so returns
 * `undefined` and the caller leaves the version to its later resolution step.
 */
function archiveDigestVersion(source: PluginInstallSource): string | undefined {
  // P6.577 — the shortening rule itself now lives beside the rest of the chain
  // (`plugins/plugin-version-chain.ts`), because the install path resolves the
  // same step and two copies of "first 12 characters" is how the catalog's
  // answer and the installed answer drift apart.
  if (source.kind !== 'url') return undefined;
  return shortenArchiveDigest(source.expectedHash);
}

function proposalToCatalogItem(
  proposal: ExternalPluginCatalogProposal,
  input: RegistryCatalogInput,
  formerIds: string[] | undefined,
): MarketplaceCatalogItem {
  // `description` and `version` are entry-level fields (`plugin-marketplaces.md`
  // `:211`/`:212`) that were dropped before any consumer; `displayName` stays the
  // fallback description only because that is what the row showed before S9.
  const description = proposal.entryDescription ?? proposal.provenance.catalogEntryDisplayName;
  // `plugin-marketplaces.md` § Zip archives (fetched 2026-08-24): "The `sha256`
  // digest also serves as the plugin's version when neither `plugin.json` nor the
  // marketplace entry declares one." `plugins-reference.md` § Version management
  // item 4 fixes the form: "The SHA-256 digest, for `archive` sources: the
  // `sha256` pin in the marketplace entry … Claude Code shortens it to the first
  // 12 characters." So the marketplace-entry `version` (item 2) still wins, and an
  // unversioned archive entry falls back to the pin's first 12 hex characters.
  // (`plugin.json`, item 1, overrides both at install via `manifest.version`.)
  const version = proposal.entryVersion ?? archiveDigestVersion(proposal.source);
  return buildRegistryCatalogItem({
    marketplaceRegistryId: input.marketplaceRegistryId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    name: proposal.pluginName,
    capabilities: declaredKindsForProposal(proposal, input),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    source: proposal.source,
    ...(formerIds?.length ? { formerIds } : {}),
    ...(proposal.entryDefinition ? { marketplaceEntry: proposal.entryDefinition } : {}),
    ...(proposal.relevance ? { relevance: proposal.relevance } : {}),
    ...(proposal.connectorAuthTiming ? { connectorAuthTiming: proposal.connectorAuthTiming } : {}),
    ...(proposal.provenance.catalogAuthenticationPolicy
      ? { catalogAuthenticationPolicy: proposal.provenance.catalogAuthenticationPolicy }
      : {}),
  });
}

/** Shared row shaper for both root-manifest proposals and scanned plugins. */
function buildRegistryCatalogItem(args: {
  marketplaceRegistryId: string;
  displayName?: string;
  name: string;
  description?: string;
  version?: string;
  source: PluginInstallSource;
  formerIds?: string[];
  marketplaceEntry?: PluginMarketplaceEntryDefinition;
  relevance?: PluginMarketplaceRelevanceV1;
  connectorAuthTiming?: ExternalPluginCatalogProposal['connectorAuthTiming'];
  catalogAuthenticationPolicy?: string;
  /** Component kinds the listing DECLARES; `[]` means the listing is silent. */
  capabilities?: readonly string[];
}): MarketplaceCatalogItem {
  return {
    id: registryItemId(args.marketplaceRegistryId, args.name),
    kind: 'plugin',
    listKind: 'plugins',
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    ...(args.version ? { version: args.version } : {}),
    icon: { kind: 'symbol', name: 'plugin' },
    // Kinds the LISTING declares, never a measured inventory. Empty means the
    // listing said nothing, which is why the detail surface must not render it
    // as "ships no components" (`plugins/declared-components.ts`).
    capabilities: [...(args.capabilities ?? [])],
    // No display-oriented DTO descriptor for registry rows — the typed source
    // is carried on `structuredInstallSource` and routed straight to install.
    install: { sourceConfidence: 'primary' },
    // Never expose the raw catalog manifest to the renderer; keep it empty.
    raw: {},
    marketplaceRegistryId: args.marketplaceRegistryId,
    ...(args.displayName ? { marketplaceRegistryLabel: args.displayName } : {}),
    structuredInstallSource: args.source satisfies PluginInstallSource,
    ...(args.formerIds?.length ? { formerIds: args.formerIds } : {}),
    ...(args.marketplaceEntry ? { marketplaceEntry: args.marketplaceEntry } : {}),
    ...(args.relevance ? { relevance: args.relevance } : {}),
    ...(args.connectorAuthTiming ? { connectorAuthTiming: args.connectorAuthTiming } : {}),
    ...(args.catalogAuthenticationPolicy
      ? { catalogAuthenticationPolicy: args.catalogAuthenticationPolicy }
      : {}),
  };
}

/** Stable per-registry item id so R3 can dedupe/route without a path. */
function registryItemId(marketplaceRegistryId: string, pluginName: string): string {
  return `${marketplaceRegistryId}:${pluginName}`;
}
