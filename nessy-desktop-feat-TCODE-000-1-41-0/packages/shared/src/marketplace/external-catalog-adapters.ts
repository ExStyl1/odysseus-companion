import { isAbsolute, relative, resolve } from 'node:path';
import { pluginDiagnostic } from '../plugins/schema.ts';
import { archiveUrlRefusalReason } from '../plugins/archive-url-guard.ts';
import {
  marketplaceEntryHeadersHelperDiagnostic,
  parseMarketplaceEntryHeaders,
} from '../plugins/archive-headers.ts';
import {
  manifestPathContainmentError,
  normalizeManifestPathText,
  resolveManifestComponentPaths,
} from '../plugins/format-adapters/manifest-paths.ts';
import type {
  PluginConnectorAuthTiming,
  PluginDiagnostic,
  PluginInstallSource,
  PluginMarketplaceEntryDefinition,
} from '../plugins/types.ts';
import { parseMarketplaceRelevance, type PluginMarketplaceRelevanceV1 } from './relevance.ts';

/**
 * Provider catalog formats accepted for ACQUISITION only (A3). Parsing one of
 * these never persists Codex/Claude naming, paths, or provider-scope labels
 * as Nessy runtime state — every proposal carries only a typed, Nessy-native
 * `PluginInstallSource` plus a provenance record for presentation.
 */
export type ExternalPluginCatalogFormat = 'codex' | 'claude';

export interface ExternalPluginCatalogSourceDto {
  type?: string;
  /** Current Codex marketplaces use `source`; older snapshots used `type`. */
  source?: string;
  path?: string;
  url?: string;
  repo?: string;
  ref?: string;
  sha?: string;
  package?: string;
  version?: string;
  registry?: string;
  /**
   * `plugin-marketplaces.md` § Zip archives, `archive` field table — "Optional.
   * SHA-256 digest of the archive as 64 hex characters, uppercase or lowercase.
   * Claude Code verifies every download against it and refuses the install on a
   * mismatch". Declared rather than left to the index signature because the
   * spelling is the contract: `sha256`, not `hash`, `digest`, or `integrity`.
   */
  sha256?: string;
  [key: string]: unknown;
}

export interface ExternalPluginCatalogPluginDto {
  id?: string;
  name?: string;
  displayName?: string;
  description?: string;
  /** Claude catalogs may express `source` as a bare string (path or URL). */
  source?: string | ExternalPluginCatalogSourceDto;
  /**
   * `plugins/host-marketplace.md#authenticate-archive-downloads`, **Archive authentication
   * fields:** — "HTTP headers Claude Code sends when it downloads this entry's
   * archive", and a `headersHelper` command for a credential that expires.
   * Declared as `unknown` because both are untrusted catalog input validated at
   * the point of use (`plugins/archive-headers.ts`); the spellings are the
   * contract, so they are named rather than left to the index signature.
   */
  headers?: unknown;
  headersHelper?: unknown;
  /** Codex marketplace install policy. It is metadata, never executable input. */
  policy?: {
    installation?: string;
    authentication?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ExternalPluginCatalogDto {
  name?: string;
  description?: string;
  /**
   * `plugins/marketplace-reference.md#bare-names-under-pluginroot` — `metadata.pluginRoot` is the "Base directory
   * prepended to relative plugin source paths (for example, `"./plugins"` lets
   * you write `"source": "formatter"` instead of `"source": "./plugins/formatter"`)".
   */
  metadata?: { pluginRoot?: string; [key: string]: unknown };
  /**
   * `plugins/host-marketplace.md#migrate-users-with-a-renames-map` — "Map from a former plugin `name` to its
   * current name, or to `null` if the plugin was removed. Lets existing users
   * migrate automatically when you rename or remove an entry in `plugins`."
   */
  renames?: Record<string, string | null>;
  plugins: ExternalPluginCatalogPluginDto[];
  [key: string]: unknown;
}

/** Provenance-only metadata from the external catalog. Never a runtime discriminator. */
export interface ExternalPluginCatalogProvenance {
  catalogFormat: ExternalPluginCatalogFormat;
  catalogName?: string;
  catalogEntryId?: string;
  catalogEntryDisplayName?: string;
  /** Raw external spelling retained for audit (for example Codex `ON_USE`). */
  catalogAuthenticationPolicy?: string;
}

export interface ExternalPluginCatalogProposal {
  catalogFormat: ExternalPluginCatalogFormat;
  pluginName: string;
  source: PluginInstallSource;
  provenance: ExternalPluginCatalogProvenance;
  /** Plugin-wide connector auth timing declared by the external marketplace. */
  connectorAuthTiming?: PluginConnectorAuthTiming;
  /**
   * The entry's OWN plugin definition (S9): its component fields, `strict`, and
   * the metadata a manifest would otherwise have to carry. Present only when the
   * entry declared at least one of them.
   */
  entryDefinition?: PluginMarketplaceEntryDefinition;
  /** `version` declared on the entry itself (`:212`), for the catalog row. */
  entryVersion?: string;
  /** `description` declared on the entry itself (`:211`), for the catalog row. */
  entryDescription?: string;
  /**
   * `plugin-relevance.md` — the entry's `relevance` block, parsed into a typed
   * value for browse-time suggestion matching.
   *
   * It rides the PROPOSAL rather than `MARKETPLACE_ENTRY_CARRIED_FIELDS`, and
   * that placement is the point: the carried-fields allowlist feeds
   * `entryDefinition.fields`, which is persisted with the install record, and
   * relevance is browse-time matching data. Keeping it off that allowlist keeps
   * the allowlist's stated invariant true.
   */
  relevance?: PluginMarketplaceRelevanceV1;
}

export interface ParseExternalPluginCatalogOptions {
  /** Directory the catalog is pinned to; all relative paths resolve inside it. */
  catalogRoot: string;
  /**
   * P6.177 — the marketplace's OWN classified source, so a credential declared
   * on a `url` marketplace reaches the archive downloads the page says it
   * covers.
   *
   * `plugins/host-marketplace.md#authenticate-archive-downloads`, the "Place" table,
   * row "Marketplace `url` source", verbatim: "Archive downloads on the
   * marketplace URL's origin, meaning the same scheme, host, and port" /
   * "Before each fetch of the marketplace's `marketplace.json` and before each
   * archive download on that origin."
   *
   * Only the FETCH half of that sentence existed (P3.220): the row's headers
   * rode `FetchRegistryCatalogRequest` and stopped there, so an entry with no
   * `headers` of its own still 401'd on the same artifact server. Optional
   * because the low-level unit contract and every non-`url` marketplace pass
   * nothing; a source of any other kind contributes no headers.
   */
  marketplaceSource?: PluginInstallSource;
}

export interface ParseExternalPluginCatalogResult {
  proposals: ExternalPluginCatalogProposal[];
  diagnostics: PluginDiagnostic[];
  /**
   * Former plugin name → the name it resolves to today, or `null` when the
   * plugin was REMOVED upstream. Chains are already followed
   * (`plugins/host-marketplace.md#migrate-users-with-a-renames-map`: "Claude Code follows chains"), so a consumer
   * looks a stored name up exactly once. Present only when the catalog declared
   * at least one usable rename.
   */
  renames?: Record<string, string | null>;
}

const SUPPORTED_GIT_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * The entry-level component-path fields. `plugins/marketplace-reference.md`
 * § "How an entry combines with plugin.json" (`#entry-and-plugin-json`, read
 * 2026-09-28) names SIX: "`commands`, `agents`, `skills`, `hooks`, `outputStyles`,
 * and `themes`" (F1.1032 added the last two). `mcpServers`/`lspServers` apply only
 * with no `plugin.json`; `workflows` rides on "An entry also accepts every `plugin.json` field".
 */
const MARKETPLACE_ENTRY_PATH_FIELDS = [
  'skills',
  'commands',
  'agents',
  'workflows',
  'hooks',
  'outputStyles',
  'themes',
  'mcpServers',
  'lspServers',
] as const;

/**
 * Entry keys carried into the plugin definition. Deliberately an ALLOWLIST, not
 * a copy of the entry: a catalog row is untrusted input from a repository the
 * user may not control, and a key no adapter reads has no business travelling
 * through the install record onto disk.
 *
 * The metadata half is the subset the Claude adapter actually consumes
 * (`normalizeClaudePluginBundle`). `name` is deliberately absent: the entry name
 * is already the install identity (`plugins/manifest-reference.md#name`) and is threaded
 * through `PluginInstallSource`, so re-declaring it here would give one value two
 * owners.
 */
const MARKETPLACE_ENTRY_CARRIED_FIELDS: readonly string[] = [
  ...MARKETPLACE_ENTRY_PATH_FIELDS,
  'displayName',
  'description',
  'version',
  'author',
  'homepage',
  'defaultEnabled',
  // `plugins/manifest-reference.md#dependencies` — an entry may declare `dependencies`; not a path, so
  // a plain carry, shape-checked by the adapter's `normalizePluginDependencies`.
  'dependencies',
  // Without a plugin.json the entry IS the manifest, so these apply there (F1.1032, F1.1036).
  'userConfig', 'channels', 'settings', 'monitors', 'experimental',
];

/**
 * The catalog's declared plugin root, or the reason it cannot be used.
 *
 * `plugins/marketplace-reference.md#bare-names-under-pluginroot` — "Base directory prepended to relative plugin
 * source paths". Before S9 the field was unread, which was a silent
 * directory-substitution vector INSIDE a marketplace repository: with
 * `pluginRoot: "./plugins"` and `source: "formatter"`, Claude installs
 * `<root>/plugins/formatter` and we installed `<root>/formatter`. Anyone able to
 * land a top-level directory in that repository — a pull request to a public
 * marketplace — shadowed the intended plugin, with no diagnostic.
 *
 * CONTAINMENT APPLIES TO THE ROOT ITSELF, through B1a's own gate. A declared root
 * that escapes is not "fall back to the repository root": that fallback is
 * precisely the substitution this fixes, so the root is refused and with it every
 * relative source that would have resolved against it.
 *
 * EXISTENCE is not checked, and cannot be here: `fetchRegistryCatalog` removes the
 * staged clone in its `finally` before the caller parses, so the parser sees a
 * path string for a directory that is already gone. A declared root that does not
 * exist therefore resolves normally and the INSTALL fails on the resolved path,
 * naming it. That is the "install nothing and say so" pole — never a silent
 * fallback to the repository root.
 */
type CatalogPluginRoot =
  | { ok: true; path: string }
  | { ok: false; reason: string };

function readCatalogPluginRoot(
  dto: ExternalPluginCatalogDto,
  diagnostics: PluginDiagnostic[],
): CatalogPluginRoot {
  const raw = readString(dto.metadata?.pluginRoot);
  if (raw === undefined) return { ok: true, path: '' };
  const containmentError = manifestPathContainmentError(raw);
  if (containmentError) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'marketplace.catalog.plugin_root_uncontained',
      `Marketplace metadata.pluginRoot "${raw}" is not a contained relative path: ${containmentError}`,
      'metadata.pluginRoot',
      { pluginRoot: raw },
    ));
    return { ok: false, reason: containmentError };
  }
  return { ok: true, path: normalizeManifestPathText(raw, true) };
}

/**
 * Parse an entry's plugin-defining fields, refusing any component path that is
 * not a contained bundle-relative reference.
 *
 * The containment gate is B1a's shared `resolveManifestComponentPaths`
 * (`plugins/format-adapters/manifest-paths.ts`) — the same one every
 * `plugin.json` component path goes through — because a marketplace entry is
 * untrusted in exactly the way a manifest is. Running it HERE as well as at
 * normalization is deliberate: the entry is persisted with the install record,
 * so a `../../etc` path must never reach disk in the first place. A second,
 * filesystem-aware symlink pass still runs in the adapter, which is the one the
 * pure string gate cannot do.
 */
function parseMarketplaceEntryDefinition(
  entry: ExternalPluginCatalogPluginDto,
  pluginName: string,
  sourceIsMarketplaceRoot: boolean,
  diagnostics: PluginDiagnostic[],
): PluginMarketplaceEntryDefinition | undefined {
  const fields: Record<string, unknown> = {};
  for (const key of MARKETPLACE_ENTRY_CARRIED_FIELDS) {
    const value = marketplaceEntryManifestMember(key, (entry as Record<string, unknown>)[key], pluginName, diagnostics);
    if (value === undefined) continue;
    if ((MARKETPLACE_ENTRY_PATH_FIELDS as readonly string[]).includes(key)) {
      const resolution = resolveManifestComponentPaths(value, { field: key });
      for (const rejection of resolution.rejected) {
        diagnostics.push(pluginDiagnostic(
          'error',
          'marketplace.catalog.entry_path_uncontained',
          `Catalog entry "${pluginName}" declares a ${key} path outside the plugin root: ${rejection.reason}`,
          rejection.diagnosticPath,
          { pluginName, field: key, path: rejection.raw },
        ));
      }
      // One refused path poisons the whole field rather than the entry: dropping
      // only the offending element would silently install a plugin with fewer
      // components than its author declared, and keeping it would resolve it.
      if (resolution.rejected.length > 0) continue;
    }
    fields[key] = value;
  }
  const strict = typeof entry.strict === 'boolean' ? entry.strict : undefined;
  if (Object.keys(fields).length === 0 && strict === undefined) return undefined;
  return {
    ...(strict === undefined ? {} : { strict }),
    ...(sourceIsMarketplaceRoot ? { sourceIsMarketplaceRoot: true } : {}),
    fields,
  };
}

export function parseExternalPluginCatalog(
  format: ExternalPluginCatalogFormat,
  dto: ExternalPluginCatalogDto,
  options: ParseExternalPluginCatalogOptions,
): ParseExternalPluginCatalogResult {
  const proposals: ExternalPluginCatalogProposal[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  const catalogName = readString(dto.name);
  const pluginRoot = readCatalogPluginRoot(dto, diagnostics);
  const renames = resolveCatalogRenames(dto, diagnostics);
  const marketplaceHeaders = readMarketplaceArchiveHeaders(options.marketplaceSource);

  for (const entry of dto.plugins ?? []) {
    const name = readString(entry.name) ?? readString(entry.id);
    if (!name) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'marketplace.catalog.missing_plugin_name',
        `${format} catalog entry is missing a name.`,
      ));
      continue;
    }

    // Codex uses this policy as an availability gate. Filter before resolving
    // the source so an intentionally unavailable entry cannot become an
    // install proposal (or emit irrelevant source diagnostics).
    if (format === 'codex' && readString(entry.policy?.installation) === 'NOT_AVAILABLE') {
      continue;
    }

    const resolved = resolveCatalogSource(entry.source, options.catalogRoot, name, pluginRoot);
    if (!resolved.ok) {
      diagnostics.push(resolved.diagnostic);
      continue;
    }

    const authentication = readString(entry.policy?.authentication);
    const connectorAuthTiming = authentication === 'ON_INSTALL'
      ? 'ON_INSTALL'
      : authentication === 'ON_USE' || authentication === 'ON_FIRST_USE'
        ? 'ON_FIRST_USE'
        : undefined;
    if (authentication && !connectorAuthTiming) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'marketplace.catalog.unsupported_authentication_policy',
        `Catalog entry "${name}" declares an unsupported authentication policy "${authentication}".`,
        undefined,
        { pluginName: name, authentication },
      ));
    }

    const entryDefinition = parseMarketplaceEntryDefinition(
      entry,
      name,
      resolved.isCatalogRoot === true,
      diagnostics,
    );
    const entryVersion = readString(entry.version);
    const entryDescription = readString(entry.description);
    const relevance = parseMarketplaceRelevance(entry.relevance);
    const source = applyEntryArchiveHeaders(entry, resolved.source, name, diagnostics, marketplaceHeaders);
    proposals.push({
      catalogFormat: format,
      pluginName: name,
      source,
      ...(entryDefinition ? { entryDefinition } : {}),
      ...(relevance ? { relevance } : {}),
      ...(entryVersion ? { entryVersion } : {}),
      ...(entryDescription ? { entryDescription } : {}),
      provenance: {
        catalogFormat: format,
        ...(catalogName ? { catalogName } : {}),
        ...(readString(entry.id) ? { catalogEntryId: readString(entry.id) } : {}),
        ...(readString(entry.displayName) ? { catalogEntryDisplayName: readString(entry.displayName) } : {}),
        ...(authentication ? { catalogAuthenticationPolicy: authentication } : {}),
      },
      ...(connectorAuthTiming ? { connectorAuthTiming } : {}),
    });
  }

  return { proposals, diagnostics, ...(renames ? { renames } : {}) };
}

/**
 * Walk the catalog's `renames` map to its terminals and expose the FLATTENED
 * result — every key already one hop from its answer.
 *
 * The summary line used to read "into a one-hop lookup", which describes the
 * OUTPUT and was twice read as a description of the walk. It is not: the loop
 * below follows a chain of any length. Said the other way round so the next
 * reader cannot make the same inference (P6.425).
 *
 * WHAT THE PAGE ASKS FOR AND WHAT THIS TREE DOES — scored at HEAD, 2026-09-06,
 * because two of the three are absent and the absence was readable nowhere:
 *
 * 1. CHAINS — `:1161` "Claude Code follows chains … resolves through both
 *    entries to `formatter-pro`". PRESENT, here, and asserted by
 *    `external-catalog-adapters.test.ts`'s "follows chains" case.
 * 2. A ONCE-ONLY NOTICE — `:1157` "shows a one-line notice such as `Renamed to
 *    "code-formatter" in the "acme-tools" marketplace`", and `:1158` "For a
 *    `null` entry … the notice reports that the plugin was removed from the
 *    marketplace". ABSENT: `Renamed to` scores 0 across `packages` and `apps`,
 *    and a removal is dropped by `formerListingIdsByName` without a word.
 * 3. A SETTINGS REWRITE — `:1157` "rewrites the old key to the new key in the
 *    user, project, and local settings scopes for both `enabledPlugins` and
 *    `pluginConfigs`, so the notice appears once". ABSENT, and STRUCTURALLY
 *    different here rather than merely unbuilt: this fork persists no
 *    `enabledPlugins`/`pluginConfigs` map keyed by plugin name — an installed
 *    record keeps the identity captured at install time, and `formerIds`
 *    (`registry-catalog-items.ts`'s `formerListingIdsByName`, read by
 *    `update-availability.ts`'s `findCatalogRowForInstalled` and
 *    `protocol/capabilities.ts`'s `matchesInstalledItem`) makes the JOIN survive
 *    the rename instead of rewriting the stored key. So requirement 3's PURPOSE
 *    — the plugin keeps working under its new name — is met by a different
 *    mechanism, and its stated EFFECT — "so the notice appears once" — has no
 *    subject until requirement 2 exists.
 *
 * Residue, deliberately not built here: the notice (both the rename and the
 * removal arm) is a renderer surface with its own locale keys and a
 * seen-once record, which is a row of its own, not a line in a parser.
 *
 * `plugins/host-marketplace.md#migrate-users-with-a-renames-map` — "Claude Code follows chains, so if you later
 * rename `code-formatter` to `formatter-pro`, add a second entry rather than
 * editing the first. A user who still has the original `formatter` enabled then
 * resolves through both entries to `formatter-pro`." — so every key is walked to
 * its terminal before it is exposed.
 *
 * `:901` gives the two refusals verbatim: `claude plugin validate .` "rejects any
 * entry whose chain forms a cycle or doesn't terminate at `null` or a name listed
 * in `plugins`". Both are dropped here rather than exposed, because a rename that
 * points nowhere joins nothing anyway and a cycle would not terminate.
 *
 * A `null` terminal is REMOVED-upstream (`:897`: "Claude Code drops the old key
 * and the notice reports that the plugin was removed from the marketplace"), not
 * a rename — the value is carried through as `null` so a consumer can tell the
 * two apart.
 */
function resolveCatalogRenames(
  dto: ExternalPluginCatalogDto,
  diagnostics: PluginDiagnostic[],
): Record<string, string | null> | undefined {
  const raw = dto.renames;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const listed = new Set(
    (dto.plugins ?? [])
      .map(entry => readString(entry.name) ?? readString(entry.id))
      .filter((name): name is string => !!name),
  );
  const resolved: Record<string, string | null> = {};

  for (const formerName of Object.keys(raw)) {
    const from = readString(formerName);
    if (!from) continue;

    // Walk the chain. `seen` is per-key: the cycle it detects is this key's own,
    // and a shared set would mistake a converging chain for one.
    const seen = new Set<string>([from]);
    let current: string | null | undefined = raw[formerName];
    let cyclic = false;
    while (typeof current === 'string' && Object.hasOwn(raw, current)) {
      if (seen.has(current)) {
        cyclic = true;
        break;
      }
      seen.add(current);
      current = raw[current];
    }

    if (cyclic) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'marketplace.catalog.rename_cycle',
        `Marketplace rename chain for "${from}" forms a cycle.`,
        'renames',
        { formerName: from },
      ));
      continue;
    }
    if (current === null) {
      resolved[from] = null;
      continue;
    }
    const target = readString(current);
    if (!target) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'marketplace.catalog.rename_invalid_target',
        `Marketplace rename for "${from}" is neither a plugin name nor null.`,
        'renames',
        { formerName: from },
      ));
      continue;
    }
    if (!listed.has(target)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'marketplace.catalog.rename_unknown_target',
        `Marketplace rename "${from}" points at "${target}", which the catalog does not list.`,
        'renames',
        { formerName: from, target },
      ));
      continue;
    }
    resolved[from] = target;
  }

  return Object.keys(resolved).length ? resolved : undefined;
}

/**
 * Attach a marketplace entry's own archive-download headers to the install
 * source it resolved to.
 *
 * `plugins/host-marketplace.md#authenticate-archive-downloads`, **Archive authentication
 * fields:** — `headers` is "HTTP headers Claude Code sends when it downloads
 * this entry's archive", and `#authenticate-archive-downloads` states the
 * failure without them verbatim: "Before v2.1.238, Claude Code downloaded an
 * entry's archive without its `headers` or `headersHelper`, so an install that
 * relied on them failed with `HTTP 401 while downloading plugin archive from`,
 * followed by the URL, with the registry's status code in place of 401." That is
 * the whole of this row: an entry on a credentialed artifact server 401s.
 *
 * Deliberately NOT in `MARKETPLACE_ENTRY_CARRIED_FIELDS`, for the reason that
 * allowlist states about itself: it feeds `entryDefinition.fields`, which is the
 * plugin's DEFINITION and is read by the format adapters. A download credential
 * is not a component of the plugin, so it rides the install source instead —
 * where the downloader is the only thing that reads it.
 *
 * `headers` on a non-archive source is not an error and not silently kept: the
 * page scopes the field to "when the entry has an `archive` source", so an entry
 * that puts one on a `github` source is told the headers do not apply. The same
 * `kind: 'url'` shape covers the bare-string https source, which is the same
 * archive download under a different spelling.
 */
function applyEntryArchiveHeaders(
  entry: ExternalPluginCatalogPluginDto,
  source: PluginInstallSource,
  pluginName: string,
  diagnostics: PluginDiagnostic[],
  marketplaceHeaders?: MarketplaceArchiveHeaders,
): PluginInstallSource {
  const helperDiagnostic = marketplaceEntryHeadersHelperDiagnostic(
    (entry as Record<string, unknown>).headersHelper,
    { pluginName },
  );
  if (helperDiagnostic) diagnostics.push(helperDiagnostic);

  const declared = (entry as Record<string, unknown>).headers;
  let entryHeaders: Record<string, string> | undefined;
  if (declared !== undefined && declared !== null) {
    const parsed = parseMarketplaceEntryHeaders(declared, { pluginName });
    diagnostics.push(...parsed.diagnostics);
    if (parsed.headers && source.kind !== 'url') {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'marketplace.catalog.entry_headers_not_applicable',
        `Catalog entry "${pluginName}" declares archive "headers", but its source is not an archive download; they are not sent.`,
        'headers',
        { pluginName, sourceKind: source.kind },
      ));
    } else {
      entryHeaders = parsed.headers;
    }
  }

  if (source.kind !== 'url') return source;

  // P6.177 — the marketplace's own credential, on the origin the page scopes it
  // to. An OFF-ORIGIN archive gets none, and the drop is STATED rather than left
  // to the 401 the page describes: an entry that points at a CDN while its
  // marketplace is on the artifact server is the case that otherwise looks like
  // a broken credential.
  let inherited: Record<string, string> | undefined;
  if (marketplaceHeaders) {
    if (sameHttpOrigin(source.url, marketplaceHeaders.origin)) {
      inherited = marketplaceHeaders.headers;
    } else if (!entryHeaders) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'marketplace.catalog.marketplace_headers_off_origin',
        `Catalog entry "${pluginName}" downloads its archive from another origin than the marketplace, so the marketplace's headers are not sent with it: ${Object.keys(marketplaceHeaders.headers).join(', ')}.`,
        'headers',
        {
          pluginName,
          marketplaceOrigin: marketplaceHeaders.origin,
          headerNames: Object.keys(marketplaceHeaders.headers),
        },
      ));
    }
  }

  // "Where both places set a header of the same name, Claude Code sends the
  // entry's value" — same page, same section. Case-insensitively, because HTTP
  // header names are, and because the two places are written by two people.
  const merged = mergeArchiveHeaders(inherited, entryHeaders);
  if (!merged) return source;
  return { ...source, headers: merged };
}

/**
 * The marketplace-level archive credential, reduced to the only two things the
 * entry loop needs: the origin it is scoped to, and the headers themselves.
 *
 * Header names are NOT re-filtered here. They arrive already filtered by the
 * managed parser that read them (`registry-source.ts`: "already-filtered
 * catalog-fetch headers"), through the same `request-header-filter.ts` an
 * entry's own `headers` pass; a second filter would be a second place for the
 * rule to drift.
 */
interface MarketplaceArchiveHeaders {
  origin: string;
  headers: Record<string, string>;
}

function readMarketplaceArchiveHeaders(
  source: PluginInstallSource | undefined,
): MarketplaceArchiveHeaders | undefined {
  // Scoped to a `url` marketplace on purpose: it is the only source kind whose
  // download this app performs itself, and the only row of the page's table
  // that names an origin. A `repository` marketplace authenticates through the
  // artifact auth provider instead.
  if (source?.kind !== 'url' || !source.headers) return undefined;
  const names = Object.keys(source.headers);
  if (!names.length) return undefined;
  const origin = httpOrigin(source.url);
  if (!origin) return undefined;
  return { origin, headers: { ...source.headers } };
}

/** `URL.origin` — scheme, host and port — for an http(s) URL, else `undefined`. */
function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // `URL.origin` is the opaque string "null" for a non-special scheme, which
    // would compare equal to another one. Only http(s) can carry this download.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function sameHttpOrigin(value: string, origin: string): boolean {
  const other = httpOrigin(value);
  return other !== undefined && other === origin;
}

function mergeArchiveHeaders(
  inherited: Record<string, string> | undefined,
  entryHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!inherited) return entryHeaders;
  if (!entryHeaders) return { ...inherited };
  const overridden = new Set(Object.keys(entryHeaders).map(name => name.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (overridden.has(name.toLowerCase())) continue;
    merged[name] = value;
  }
  return { ...merged, ...entryHeaders };
}

type ResolvedCatalogSource =
  | {
      ok: true;
      source: PluginInstallSource;
      /**
       * The entry's source IS the marketplace root — `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`'s
       * condition for the `skills` replace-instead-of-extend exception.
       */
      isCatalogRoot?: boolean;
    }
  | { ok: false; diagnostic: PluginDiagnostic };

function resolveCatalogSource(
  source: string | ExternalPluginCatalogSourceDto | undefined,
  catalogRoot: string,
  pluginName: string,
  pluginRoot: CatalogPluginRoot,
): ResolvedCatalogSource {
  if (source === undefined) {
    return unsupported(`Catalog entry "${pluginName}" is missing a source.`, { pluginName });
  }

  if (typeof source === 'string') {
    return resolveStringSource(source, catalogRoot, pluginName, pluginRoot);
  }

  const type = readString(source.source) ?? readString(source.type);
  if (type === 'local') {
    const path = readString(source.path);
    if (!path) {
      return unsupported(`Catalog entry "${pluginName}" has a local source without a path.`, { pluginName });
    }
    return resolveLocalPath(path, catalogRoot, pluginName, pluginRoot);
  }

  if (type === 'git') {
    return resolveGitSource(source, pluginName);
  }

  if (type === 'github') {
    return resolveClaudeGitHubSource(source, pluginName);
  }

  if (type === 'url') {
    return resolveClaudeUrlSource(source, pluginName);
  }

  if (type === 'git-subdir') {
    return resolveClaudeGitSubdirectorySource(source, pluginName);
  }

  if (type === 'npm') {
    return resolveClaudeNpmSource(source, pluginName);
  }

  if (type === 'archive') {
    return resolveClaudeArchiveSource(source, pluginName);
  }

  if (type === 'command') {
    return declineClaudeCommandSource(source, pluginName);
  }

  return unsupported(`Catalog entry "${pluginName}" declares an unsupported source type "${type ?? 'unknown'}".`, { pluginName, type });
}

function resolveStringSource(
  value: string,
  catalogRoot: string,
  pluginName: string,
  pluginRoot: CatalogPluginRoot,
): ResolvedCatalogSource {
  if (/^https?:\/\//i.test(value)) {
    // `plugin-marketplaces.md` § Zip archives, `url` field (fetched 2026-08-24):
    // "Claude Code rejects `http://` URLs, along with loopback, link-local, and
    // cloud-metadata hosts." A bare string source that looks like a URL resolves
    // to the SAME `kind: 'url'` archive download the `archive` spelling produces
    // (`source-resolver.ts:artifactForSource` → `archive-url` →
    // `acquisition.ts:fetchArchiveUrlArtifact`), so it must clear the same guard
    // — `http://` and every refused host included — rather than feeding the
    // downloader an unchecked URL as it did before.
    const unsafeReason = archiveUrlRefusalReason(value);
    if (unsafeReason) {
      return {
        ok: false,
        diagnostic: pluginDiagnostic(
          'error',
          'marketplace.catalog.archive_url_unsafe',
          `Catalog entry "${pluginName}" declares a source URL that is not a public HTTPS URL: ${unsafeReason}.`,
          undefined,
          { pluginName, value, reason: unsafeReason },
        ),
      };
    }
    return { ok: true, source: { kind: 'url', url: value } };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return unsupported(`Catalog entry "${pluginName}" uses an unsupported source scheme.`, { pluginName, value });
  }
  return resolveLocalPath(value, catalogRoot, pluginName, pluginRoot);
}

function resolveLocalPath(
  path: string,
  catalogRoot: string,
  pluginName: string,
  pluginRoot: CatalogPluginRoot,
): ResolvedCatalogSource {
  // A declared-but-uncontained `metadata.pluginRoot` refuses every relative
  // source rather than resolving one against the repository root: that fallback
  // IS the directory substitution (`:187`'s own example installs
  // `<root>/plugins/formatter`, and the fallback installs `<root>/formatter`).
  if (!pluginRoot.ok) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.plugin_root_invalid',
        `Catalog entry "${pluginName}" has a relative source, and the marketplace's metadata.pluginRoot is not usable: ${pluginRoot.reason}`,
        undefined,
        { pluginName, path },
      ),
    };
  }
  const base = pluginRoot.path ? resolve(catalogRoot, pluginRoot.path) : catalogRoot;
  const resolvedPath = resolve(base, path);
  const relativePath = relative(catalogRoot, resolvedPath);
  // Containment against BOTH: the catalog root, as before, and the declared
  // plugin root, because `:187` makes every relative source resolve beneath it.
  const relativeToBase = relative(base, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)
    || relativeToBase.startsWith('..') || isAbsolute(relativeToBase)) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.path_traversal',
        `Catalog entry "${pluginName}" resolves outside the pinned catalog root.`,
        undefined,
        { pluginName, path, catalogRoot },
      ),
    };
  }
  return {
    ok: true,
    source: { kind: 'local-path', path: resolvedPath },
    // `""` is what `relative()` gives for the catalog root itself, which is the
    // `"source": "./"` shape `plugins/marketplace-reference.md#relative-path-plugin-source` uses for a marketplace
    // whose plugins share one `skills/` folder.
    ...(relativePath === '' ? { isCatalogRoot: true } : {}),
  };
}

function resolveGitSource(source: ExternalPluginCatalogSourceDto, pluginName: string): ResolvedCatalogSource {
  const url = readString(source.url);
  if (!url) {
    return unsupported(`Catalog entry "${pluginName}" has a git source without a URL.`, { pluginName });
  }
  const ref = readString(source.ref);
  if (!ref) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.unpinned_git_source',
        `Catalog entry "${pluginName}" declares a git source without a resolved commit/ref.`,
        undefined,
        { pluginName, url },
      ),
    };
  }
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return unsupported(`Catalog entry "${pluginName}" has an unparseable git source URL.`, { pluginName, url });
  }
  if (!SUPPORTED_GIT_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.unsupported_git_host',
        `Catalog entry "${pluginName}" declares a git source over an unsupported protocol "${protocol}".`,
        undefined,
        { pluginName, url },
      ),
    };
  }
  return { ok: true, source: { kind: 'repository', repositoryUrl: url, ref } };
}

function resolveClaudeGitHubSource(
  source: ExternalPluginCatalogSourceDto,
  pluginName: string,
): ResolvedCatalogSource {
  const repo = readString(source.repo);
  if (!repo) {
    return unsupported(`Catalog entry "${pluginName}" has a github source without a repo.`, { pluginName });
  }
  const repositoryUrl = githubRepositoryUrl(repo);
  if (!repositoryUrl) {
    return unsupported(`Catalog entry "${pluginName}" has an invalid github repo shorthand.`, { pluginName, repo });
  }
  return claudeRepositorySource(repositoryUrl, source);
}

function resolveClaudeUrlSource(
  source: ExternalPluginCatalogSourceDto,
  pluginName: string,
): ResolvedCatalogSource {
  const url = readString(source.url);
  if (!url) {
    return unsupported(`Catalog entry "${pluginName}" has a url source without a URL.`, { pluginName });
  }
  const invalidUrl = validateRepositoryUrl(url, pluginName);
  if (invalidUrl) return invalidUrl;
  return claudeRepositorySource(url, source);
}

function resolveClaudeGitSubdirectorySource(
  source: ExternalPluginCatalogSourceDto,
  pluginName: string,
): ResolvedCatalogSource {
  const rawUrl = readString(source.url);
  if (!rawUrl) {
    return unsupported(`Catalog entry "${pluginName}" has a git-subdir source without a URL.`, { pluginName });
  }
  const repositoryUrl = githubRepositoryUrl(rawUrl) ?? rawUrl;
  const invalidUrl = validateRepositoryUrl(repositoryUrl, pluginName);
  if (invalidUrl) return invalidUrl;

  const path = readString(source.path);
  if (!path) {
    return unsupported(`Catalog entry "${pluginName}" has a git-subdir source without a path.`, { pluginName });
  }
  const subdirectory = normalizeRepositorySubdirectory(path);
  if (!subdirectory) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.path_traversal',
        `Catalog entry "${pluginName}" declares a git subdirectory outside the repository root.`,
        undefined,
        { pluginName, path },
      ),
    };
  }
  return claudeRepositorySource(repositoryUrl, source, subdirectory);
}

function resolveClaudeNpmSource(
  source: ExternalPluginCatalogSourceDto,
  pluginName: string,
): ResolvedCatalogSource {
  const packageName = readString(source.package);
  if (!packageName) {
    return unsupported(`Catalog entry "${pluginName}" has an npm source without a package.`, { pluginName });
  }
  const version = readString(source.version);
  const registry = readString(source.registry);
  return {
    ok: true,
    source: {
      kind: 'marketplace-npm-package',
      packageName,
      ...(version ? { version } : {}),
      ...(registry ? { registry } : {}),
    },
  };
}

/**
 * `plugin-marketplaces.md` § Zip archives — "Use `archive` to distribute a
 * plugin as a zip file that Claude Code downloads over HTTPS, so installs work
 * without git or npm on the user's machine." Two fields, both quoted verbatim
 * on the checks below: `url` ("Required. HTTPS URL of the zip archive…") and
 * `sha256` ("Optional. SHA-256 digest of the archive as 64 hex characters…").
 *
 * The acquisition half already existed and is untouched: this returns the
 * `kind: 'url'` install source that `source-resolver.ts:artifactForSource`
 * turns into the `archive-url` artifact `acquisition.ts:fetchArchiveUrlArtifact`
 * downloads, hash-verifies and extracts. Only the marketplace ENTRY kind was
 * missing, so a marketplace that adopted the new shape classified `unsupported`
 * and could not be installed at all.
 */
function resolveClaudeArchiveSource(
  source: ExternalPluginCatalogSourceDto,
  pluginName: string,
): ResolvedCatalogSource {
  const url = readString(source.url);
  if (!url) {
    return unsupported(`Catalog entry "${pluginName}" has an archive source without a URL.`, { pluginName });
  }
  const unsafeReason = archiveUrlRefusalReason(url);
  if (unsafeReason) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.archive_url_unsafe',
        `Catalog entry "${pluginName}" declares an archive URL that is not a public HTTPS URL: ${unsafeReason}.`,
        undefined,
        { pluginName, url, reason: unsafeReason },
      ),
    };
  }

  // Read RAW rather than through `readString`, which folds `""` and a non-string
  // into `undefined`: for every other field that means "absent", but here it
  // would turn a malformed pin into a silently UNVERIFIED download. A declared
  // `sha256` that cannot be used is refused, never ignored.
  const declaredDigest = source.sha256 === undefined || source.sha256 === null ? undefined : source.sha256;
  const digest = typeof declaredDigest === 'string' ? declaredDigest.trim() : declaredDigest;
  if (digest !== undefined && (typeof digest !== 'string' || !/^[0-9a-f]{64}$/i.test(digest))) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.archive_digest_invalid',
        `Catalog entry "${pluginName}" declares an archive sha256 that is not 64 hex characters.`,
        undefined,
        { pluginName, url, sha256: digest },
      ),
    };
  }

  return {
    ok: true,
    source: {
      kind: 'url',
      url,
      // Normalized to the one spelling `acquisition.ts:verifyExpectedHash`
      // parses: it strips a `sha256-` prefix and compares the remainder against
      // `createHash('sha256').digest('hex')`, which is lowercase. The page
      // admits an uppercase digest, and an uppercase one compared as-is would
      // fail every pinned install with a hash mismatch.
      ...(digest ? { expectedHash: `sha256-${digest.toLowerCase()}` } : {}),
    },
  };
}

/**
 * The `command` source — DECLINED, and told apart from a source type we simply
 * do not recognise.
 *
 * It arrived in the vendored bundle with S0-3's 0.3.223 → 0.3.233 lift
 * (2026-09-03). At 2.1.223 the marketplace-entry source union was
 * `["npm","url","github","git-subdir","unsupported"]`; from 2.1.233 onward it is
 * `["npm","url","github","git-subdir","archive","command","unsupported"]` —
 * unchanged at the vendored `2.1.247`, where `archive-headers.ts` records the
 * `0.3.247` re-reading of the same union — and
 * the entry declares `command` (a shell line printing a plugin directory),
 * `timeout` and `mode: copy|link`.
 *
 * Why a branch of its own rather than the fallthrough. Before this, a
 * marketplace that adopted `command` got
 * *'declares an unsupported source type "command"'* — which is the message for a
 * typo, and reads as a parser that has not caught up. It has: this is a refusal.
 * A command source runs an arbitrary shell command from the user's home
 * directory with the agent's subprocess environment, re-resolved on every
 * install, every update and once per session in the background — a marketplace
 * that can publish an entry can therefore publish code execution. Claude Code
 * gates it behind managed `disableCommandPluginSources`
 * (`settings-reference.md#disablecommandpluginsources`); this host has no
 * acceptance flow for it and no per-entry consent surface, so the honest
 * position is to decline it and say why, per AGENTS.md §"Where the documentation
 * is silent: TRANSPARENT and SIMPLE" — the smallest honest thing, with the
 * residue named.
 *
 * A WARNING would be wrong: the entry cannot be installed either way, and a
 * proposal we cannot honour must not reach the catalog. So it is an error, like
 * every other unresolvable source — with a code and a sentence a reader can act
 * on instead of one that sends them to look for a missing parser.
 */
function declineClaudeCommandSource(
  source: ExternalPluginCatalogSourceDto,
  pluginName: string,
): ResolvedCatalogSource {
  const command = readString(source.command);
  return {
    ok: false,
    diagnostic: pluginDiagnostic(
      'error',
      'marketplace.catalog.command_source_declined',
      `Catalog entry "${pluginName}" declares a command source, which runs a shell command on this machine to produce the plugin. `
      + 'It is declined here rather than unsupported: this host has no acceptance flow for marketplace-supplied commands.',
      undefined,
      { pluginName, ...(command ? { command } : {}) },
    ),
  };
}

function claudeRepositorySource(
  repositoryUrl: string,
  source: ExternalPluginCatalogSourceDto,
  subdirectory?: string,
): ResolvedCatalogSource {
  // Claude gives an exact SHA precedence over a branch/tag ref.
  const ref = readString(source.sha) ?? readString(source.ref);
  return {
    ok: true,
    source: {
      kind: 'repository',
      repositoryUrl,
      ...(ref ? { ref } : {}),
      ...(subdirectory ? { subdirectory } : {}),
    },
  };
}

function githubRepositoryUrl(repo: string): string | undefined {
  const segments = repo.replace(/^\/+|\/+$/g, '').split('/');
  if (
    segments.length !== 2
    || segments.some(segment => !segment || segment === '.' || segment === '..' || !/^[a-z0-9_.-]+$/i.test(segment))
  ) {
    return undefined;
  }
  return `https://github.com/${segments.join('/')}`;
}

function validateRepositoryUrl(url: string, pluginName: string): ResolvedCatalogSource | undefined {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return unsupported(`Catalog entry "${pluginName}" has an unparseable git source URL.`, { pluginName, url });
  }
  if (!SUPPORTED_GIT_PROTOCOLS.has(protocol)) {
    return {
      ok: false,
      diagnostic: pluginDiagnostic(
        'error',
        'marketplace.catalog.unsupported_git_host',
        `Catalog entry "${pluginName}" declares a git source over an unsupported protocol "${protocol}".`,
        undefined,
        { pluginName, url },
      ),
    };
  }
  return undefined;
}

function normalizeRepositorySubdirectory(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return undefined;
  const segments = normalized.split('/').filter(segment => segment && segment !== '.');
  if (segments.length === 0 || segments.some(segment => segment === '..')) return undefined;
  return segments.join('/');
}

function unsupported(message: string, details: Record<string, unknown>): ResolvedCatalogSource {
  return {
    ok: false,
    diagnostic: pluginDiagnostic('error', 'marketplace.catalog.unsupported_source', message, undefined, details),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The value an entry's `settings`, `monitors` or `experimental` carries, or
 * `undefined` when it must not travel (F1.1036); every other key passes through.
 *
 * `plugins/marketplace-reference.md` § "How an entry combines with plugin.json"
 * (`#entry-and-plugin-json`, read 2026-09-28): "**No `plugin.json`**: the entry is
 * the manifest regardless of `strict`. Every manifest field in the entry
 * applies". The Fields table of `plugins/manifest-reference.md` (`#fields`) gives
 * `settings` ("Only `agent` and `subagentStatusLine` take effect"),
 * `experimental.monitors` ("A `.json` file holding the monitors array, or the
 * array itself"; "A top-level `monitors` key still loads") and
 * `experimental.themes` (a path or an array of paths). The Claude adapter reads
 * those three from the entry when there is no `plugin.json`.
 *
 * `experimental` keeps only the two members an adapter reads. `evals` is left
 * behind on purpose: nothing here reads it from a `plugin.json` either (the note
 * beside `CLAUDE_RETAINED_SURFACE_FIELDS` in `format-adapters/claude.ts`), and
 * the carry list's rule is that an unread key does not reach the install record.
 *
 * A PATH form goes through the same containment gate as the component path
 * fields, and one refused path drops the whole key, for the reason given in
 * `parseMarketplaceEntryDefinition`. An inline monitors array has no path to check.
 */
function marketplaceEntryManifestMember(
  key: string,
  value: unknown,
  pluginName: string,
  diagnostics: PluginDiagnostic[],
): unknown {
  if (value === undefined) return undefined;
  const pathMembers: Array<[string, unknown]> = [];
  let carried = value;
  if (key === 'monitors') {
    pathMembers.push(['monitors', value]);
  } else if (key === 'experimental') {
    if (!isPlainRecord(value)) return undefined;
    const kept: Record<string, unknown> = {};
    for (const member of ['themes', 'monitors']) {
      if (value[member] === undefined) continue;
      kept[member] = value[member];
      pathMembers.push([`experimental.${member}`, value[member]]);
    }
    if (Object.keys(kept).length === 0) return undefined;
    carried = kept;
  } else {
    return value;
  }
  let refused = false;
  for (const [field, member] of pathMembers) {
    for (const rejection of resolveManifestComponentPaths(member, { field }).rejected) {
      refused = true;
      diagnostics.push(pluginDiagnostic(
        'error',
        'marketplace.catalog.entry_path_uncontained',
        `Catalog entry "${pluginName}" declares a ${field} path outside the plugin root: ${rejection.reason}`,
        rejection.diagnosticPath,
        { pluginName, field, path: rejection.raw },
      ));
    }
  }
  return refused ? undefined : carried;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
