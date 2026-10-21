/**
 * Registry catalog fetch (1.10.0 R1).
 *
 * A "registry" is a repo/URL/local folder whose catalog manifest lists MANY
 * plugins (Codex marketplace model). This module fetches a registry's catalog
 * by REUSING the existing plugin-install staging seam — it does NOT add a new
 * network client or fetcher. The registry SOURCE is staged through
 * `PluginInstallService.stageInstall` (the same Artifactory-governed clone path
 * plugin installs use), then the catalog manifest is read FROM the staged root.
 *
 * Supply-chain: no registry/Bun config bypass, no renderer-side fetch. The
 * install service is INJECTED so the reuse is enforced by construction — this
 * module has no `fetch`, no git, no archive code of its own.
 *
 * R1 fetches + locates the manifest only. Turning the DTO into browse items via
 * the existing `parseExternalPluginCatalog` is R2.
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { pluginDiagnostic } from './schema.ts';
import { resolvePluginInstallSource } from './source-resolver.ts';
import {
  declaredPluginComponentKinds,
  type PluginDeclaredComponentKind,
} from './declared-components.ts';
import type { PluginDiagnostic, PluginInstallSource } from './types.ts';

/**
 * Catalog manifest filename precedence, checked at the staged repo root.
 *
 * DECISION (plan anchor "UNVERIFIED — the exact catalog manifest FILENAME"):
 * prefer `marketplace.json`, then `plugins.json`. Both carry the
 * `{ name?, description?, plugins: [...] }` shape the EXISTING
 * `ExternalPluginCatalogDto` / `parseExternalPluginCatalog` already accept — R1
 * does NOT invent a new catalog schema, it only locates the manifest and reads
 * it as that DTO for R2 to parse.
 */
export const REGISTRY_CATALOG_MANIFEST_FILES = [
  'marketplace.json',
  'plugins.json',
  // Codex's canonical marketplace location (openai/plugins and compatible registries).
  '.agents/plugins/marketplace.json',
  // Claude Code's canonical marketplace location (aggregate catalog).
  '.claude-plugin/marketplace.json',
] as const;

/**
 * Minimal staging seam this module depends on — a subset of
 * `PluginInstallService`. Depending on the interface (not the class) keeps the
 * reuse explicit and makes the "no new network client" invariant testable with
 * a fake staging area (no real network).
 */
export interface RegistryStagingService {
  createInstallPlanFromSource(
    source: string | PluginInstallSource,
    options?: { now?: () => number },
  ): Promise<import('./types.ts').PluginInstallPlan>;
  stageInstall(
    plan: import('./types.ts').PluginInstallPlan,
    options?: { baseTempDir?: string },
  ): Promise<import('./types.ts').PluginStagedInstall>;
}

export interface FetchRegistryCatalogRequest {
  /** Raw user-supplied registry source string (repo/URL/local path). */
  source: string;
  /** Git ref to fetch (git sources only). Ignored for non-repository sources. */
  refName?: string;
  /**
   * Scoping hint (recorded on the registry row). METADATA-ONLY in R1: the
   * staging layer has no git sparse-checkout support, so these are not applied
   * during fetch. See `store.ts` `PluginMarketplaceRegistry.sparsePaths`.
   */
  sparsePaths?: string[];
  /**
   * P3.220 — the marketplace `url` source's own request headers, sent with the
   * catalog fetch. Applied ONLY to a source that resolves to a `url` install
   * source, because that is the only shape whose download this app performs
   * itself: a `repository` source authenticates through the artifact auth
   * provider instead, and a local path has no request at all.
   */
  headers?: Record<string, string>;
  baseTempDir?: string;
  now?: () => number;
  /**
   * Upper bound on directory entries examined by the directory-of-plugins scan
   * fallback (defense-in-depth against a pathological tree). Test seam; defaults
   * to {@link DEFAULT_REGISTRY_MAX_SCANNED_DIRS}.
   */
  maxScannedDirs?: number;
}

/**
 * One plugin discovered by the directory-of-plugins scan fallback (see
 * {@link scanPluginDirectories}). Carries a fully-typed, DURABLE
 * `PluginInstallSource` (the registry's OWN repo + subdirectory, or the local
 * folder subpath) so install routes through the existing install path without
 * re-parsing a manifest. This is the plugins-native equivalent of an external
 * catalog proposal — it deliberately does NOT depend on the marketplace-layer
 * `ExternalPluginCatalogProposal` (that would invert the package dependency).
 */
export interface RegistryScannedPlugin {
  name: string;
  description?: string;
  version?: string;
  format: 'codex' | 'claude';
  source: PluginInstallSource;
  /**
   * Component KINDS this plugin's own manifest declares (D2). A floor, never an
   * inventory — see `declared-components.ts` for why an absent field is not an
   * absent component. Omitted when the manifest declares none.
   */
  declaredComponentKinds?: PluginDeclaredComponentKind[];
}

export interface FetchRegistryCatalogResult {
  ok: boolean;
  /**
   * The raw catalog manifest object read from the staged root, if found and
   * parseable. Shaped for the existing `ExternalPluginCatalogDto`; R2 feeds it
   * to `parseExternalPluginCatalog`. Untyped here because R1 does not parse it.
   */
  catalog?: unknown;
  /**
   * Plugins discovered by the directory-of-plugins scan fallback when NO root
   * catalog manifest exists (Codex/Claude marketplace repo layout). Mutually
   * exclusive with `catalog`: the mapper (`registryScannedCatalogItems`) turns
   * these straight into browse items — they already carry a typed source.
   */
  scannedPlugins?: RegistryScannedPlugin[];
  /**
   * Component kinds each ROOT-CATALOG entry's own per-plugin manifest declares,
   * keyed by the entry's catalog name (D2).
   *
   * Kept OUT of the merged `catalog` on purpose. Merging them onto the entry
   * would land them in `PluginMarketplaceEntryDefinition.fields`, which is a
   * manifest OVERLAY persisted with the install record — the same three-field
   * boundary {@link CATALOG_ENTRY_MANIFEST_FIELDS} draws. These kinds are for
   * DISPLAY, so they travel beside the catalog and change no install semantics.
   */
  manifestComponentKinds?: Record<string, PluginDeclaredComponentKind[]>;
  /** Manifest filename that was found (from `REGISTRY_CATALOG_MANIFEST_FILES`). */
  manifestFile?: string;
  /**
   * ABSOLUTE staged root the catalog was read from — pass as `catalogRoot` to
   * the R2 parser so relative `local` sources resolve inside it. SERVER-ONLY.
   *
   * NOTE: by the time this result is returned the staged tree has ALREADY been
   * removed (see the `finally` in {@link fetchRegistryCatalog}). The value is a
   * path STRING kept only for the R2 parser's pure path math (containment +
   * `relative()`); no consumer may read files under it. The directory-scan
   * fallback and durable-local remap (see {@link deriveRegistryPluginSource})
   * both run before removal, so no browse/install path depends on staged files.
   */
  catalogRoot?: string;
  /**
   * The classified, path-free registry source (repo/URL/local folder). Returned
   * so the R2 mapper can rebuild a DURABLE install source for a catalog entry
   * whose `local` path would otherwise resolve inside the (now-removed) staged
   * root. Mirrors what the directory-of-plugins scan already does per plugin.
   */
  registrySource?: PluginInstallSource;
  diagnostics: PluginDiagnostic[];
}

/**
 * Fixed manifest sub-path per external plugin format, checked inside each scanned
 * plugin directory (`<dir>/.codex-plugin/plugin.json`,
 * `<dir>/.claude-plugin/plugin.json`). The `.claude-plugin/marketplace.json`
 * AGGREGATE file at a repo root is a DIFFERENT thing (still handled by the root
 * manifest path) — this is the per-plugin manifest of the directory layout.
 */
const PLUGIN_MANIFEST_DESCRIPTORS = [
  { manifestDir: '.codex-plugin', format: 'codex' as const },
  { manifestDir: '.claude-plugin', format: 'claude' as const },
] as const;

/**
 * Directory prefixes scanned for plugin dirs, relative to the staged catalog
 * root: the root itself (`root/*`) and a conventional `plugins/` container
 * (`root/plugins/*`). Bounded so an arbitrary repo can never trigger a deep walk.
 */
const REGISTRY_SCAN_BASES = ['', 'plugins'] as const;

export const DEFAULT_REGISTRY_MAX_SCANNED_DIRS = 500;

/**
 * Fetch a registry's catalog by staging its source and reading the catalog
 * manifest from the staged root. Reuses the injected acquisition staging;
 * adds no network client of its own.
 */
export async function fetchRegistryCatalog(
  service: RegistryStagingService,
  request: FetchRegistryCatalogRequest,
): Promise<FetchRegistryCatalogResult> {
  const source = buildRegistrySource(request);
  if (!source) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic(
        'error',
        'marketplace.registry.empty_source',
        'Registry source is empty.',
        'source',
      )],
    };
  }

  const planOptions = request.now ? { now: request.now } : {};
  const plan = await service.createInstallPlanFromSource(source, planOptions);
  const staged = await service.stageInstall(
    plan,
    request.baseTempDir ? { baseTempDir: request.baseTempDir } : {},
  );

  // The staged tree is a FULL repo clone (~100MB+); it exists ONLY to read the
  // catalog manifest / scan plugin directories. Remove it once that work is
  // done — success AND failure — so browsing registries never leaks clones into
  // $TMPDIR. Everything downstream (browse rows, install) is derived before the
  // `finally` runs and carries only path-free/durable data.
  try {
    // Surface staging (clone/download) errors verbatim — the same diagnostics a
    // plugin install would produce, since we reused its staging path.
    const stagingErrors = staged.diagnostics.filter(d => d.severity === 'error');
    if (stagingErrors.length) {
      return { ok: false, registrySource: source, diagnostics: staged.diagnostics };
    }

    const catalogRoot = staged.rawDirectory;
    const maxScannedDirs = request.maxScannedDirs ?? DEFAULT_REGISTRY_MAX_SCANNED_DIRS;
    const located = await readCatalogManifest(catalogRoot);
    if (located.ok) {
      // A root catalog manifest is NOT the end of discovery. Codex's own
      // `openai/plugins` ships an `.agents/plugins/marketplace.json` whose 180
      // entries carry only `['category','name','policy','source']` — the
      // description and version live in each `plugins/<name>/.codex-plugin/plugin.json`.
      // Returning here left every row nameless-but-blank in browse, so the scan
      // runs on this path too and fills the gaps the root entries leave.
      const manifests = await scanPluginManifests(catalogRoot, maxScannedDirs);
      const merged = mergePluginManifestMetadata(located.catalog, manifests);
      return {
        ok: true,
        catalog: merged.catalog,
        ...(Object.keys(merged.componentKinds).length
          ? { manifestComponentKinds: merged.componentKinds }
          : {}),
        manifestFile: located.manifestFile,
        catalogRoot,
        registrySource: source,
        diagnostics: staged.diagnostics,
      };
    }

    // No ROOT catalog manifest. A present-but-broken manifest (unreadable / invalid
    // JSON) is a hard error — only a genuinely ABSENT manifest falls through to the
    // directory-of-plugins scan (Codex/Claude marketplace repo layout: a DIRECTORY
    // of `<name>/.codex-plugin|.claude-plugin/plugin.json`, no root manifest).
    if (located.diagnostic.code === 'marketplace.registry.catalog_missing') {
      const scannedPlugins = await scanPluginDirectories(catalogRoot, source, maxScannedDirs);
      if (scannedPlugins.length) {
        const unsupportedPlugin = scannedPlugins.find(plugin => plugin.source.kind === 'unsupported');
        if (unsupportedPlugin) {
          return {
            ok: false,
            catalogRoot,
            registrySource: source,
            diagnostics: [...staged.diagnostics, pluginDiagnostic(
              'error',
              'marketplace.registry.scanned_plugin_source_not_durable',
              `Registry plugin "${unsupportedPlugin.name}" cannot be installed from a durable source.`,
              undefined,
              { pluginName: unsupportedPlugin.name, registrySourceKind: source.kind },
            )],
          };
        }
        return { ok: true, scannedPlugins, catalogRoot, registrySource: source, diagnostics: staged.diagnostics };
      }
    }

    return {
      ok: false,
      catalogRoot,
      registrySource: source,
      diagnostics: [...staged.diagnostics, located.diagnostic],
    };
  } finally {
    // Best-effort: a temp-removal hiccup must never fail the fetch.
    await rm(staged.stageDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Classify the raw source string into a typed `PluginInstallSource`, attaching
 * `refName` as the fetch `ref` for repository sources. Reuses the existing
 * `resolvePluginInstallSource` classifier (no bespoke URL parsing) so a
 * registry stages through exactly the same source shapes as a plugin install.
 * `sparsePaths` is intentionally NOT threaded here — the staging layer has no
 * sparse-checkout support (metadata-only, R1 limitation).
 */
function buildRegistrySource(request: FetchRegistryCatalogRequest): PluginInstallSource | undefined {
  const trimmed = request.source.trim();
  if (!trimmed) return undefined;

  const resolved = resolvePluginInstallSource(trimmed);
  const ref = request.refName?.trim();
  if (resolved.source.kind === 'repository' && ref) {
    return { ...resolved.source, ref };
  }
  // P3.220 — the marketplace's own credential, bound to the download this
  // module is about to make. Carried on the SOURCE rather than passed alongside
  // it because `source-resolver.ts:artifactForSource` is what the downloader
  // reads: a header left beside the source is a header that silently never
  // applies, which is the 401 this closes.
  if (resolved.source.kind === 'url' && request.headers && Object.keys(request.headers).length > 0) {
    return { ...resolved.source, headers: { ...request.headers } };
  }
  return resolved.source;
}

type LocatedCatalog =
  | { ok: true; catalog: unknown; manifestFile: string }
  | { ok: false; diagnostic: PluginDiagnostic };

async function readCatalogManifest(catalogRoot: string): Promise<LocatedCatalog> {
  for (const manifestFile of REGISTRY_CATALOG_MANIFEST_FILES) {
    let raw: string;
    try {
      raw = await readFile(join(catalogRoot, manifestFile), 'utf-8');
    } catch (error) {
      if (isNotFound(error)) continue;
      return {
        ok: false,
        diagnostic: pluginDiagnostic(
          'error',
          'marketplace.registry.catalog_unreadable',
          `Registry catalog "${manifestFile}" could not be read: ${errorMessage(error)}`,
        ),
      };
    }
    try {
      return { ok: true, catalog: JSON.parse(raw) as unknown, manifestFile };
    } catch (error) {
      return {
        ok: false,
        diagnostic: pluginDiagnostic(
          'error',
          'marketplace.registry.catalog_invalid_json',
          `Registry catalog "${manifestFile}" is not valid JSON: ${errorMessage(error)}`,
        ),
      };
    }
  }
  return {
    ok: false,
    diagnostic: pluginDiagnostic(
      'error',
      'marketplace.registry.catalog_missing',
      `Registry has no catalog manifest at its root (looked for ${REGISTRY_CATALOG_MANIFEST_FILES.join(', ')}).`,
    ),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Directory-of-plugins scan fallback. Bounded to `root/*` and `root/plugins/*`
 * (no recursive walk); each candidate directory is probed for a fixed
 * `.codex-plugin/plugin.json` / `.claude-plugin/plugin.json` manifest. Every hit
 * yields a DURABLE install source derived from the REGISTRY's own source (repo +
 * ref + subdirectory, or local folder subpath) — never a path into the ephemeral
 * staged temp dir. Directory names are validated (no dotdirs, no separators, no
 * traversal) and the total scanned dir count is capped.
 */
async function scanPluginDirectories(
  catalogRoot: string,
  registrySource: PluginInstallSource,
  maxScannedDirs: number,
): Promise<RegistryScannedPlugin[]> {
  const manifests = await scanPluginManifests(catalogRoot, maxScannedDirs);
  return manifests.map(located => buildScannedPlugin(
    located,
    located.relPath,
    located.dirName,
    registrySource,
    catalogRoot,
  ));
}

/** One per-plugin manifest found by the bounded directory scan. */
interface ScannedPluginManifest {
  relPath: string;
  dirName: string;
  format: 'codex' | 'claude';
  manifest: Record<string, unknown>;
}

/**
 * The bounded walk itself, shared by the directory-of-plugins fallback and by
 * the root-manifest enrichment (D1). Returns raw manifests: deriving a durable
 * install source is the fallback's job, not the enrichment's.
 */
async function scanPluginManifests(
  catalogRoot: string,
  maxScannedDirs: number,
): Promise<ScannedPluginManifest[]> {
  const found: ScannedPluginManifest[] = [];
  const seen = new Set<string>();
  let scanned = 0;

  for (const base of REGISTRY_SCAN_BASES) {
    const baseDir = base ? join(catalogRoot, base) : catalogRoot;
    const entries = await readDirEntries(baseDir);
    if (!entries) continue; // base dir absent (e.g. no `plugins/` container) — skip.
    for (const entry of entries) {
      if (scanned >= maxScannedDirs) return found;
      if (!entry.isDirectory() || !isSafePluginDirName(entry.name)) continue;
      scanned += 1;
      const relPath = base ? `${base}/${entry.name}` : entry.name;
      if (seen.has(relPath)) continue;
      const pluginDir = join(catalogRoot, relPath);
      if (!isPathInside(catalogRoot, pluginDir)) continue;
      const located = await readFirstPluginManifest(pluginDir);
      if (!located) continue;
      seen.add(relPath);
      found.push({ relPath, dirName: entry.name, ...located });
    }
  }
  return found;
}

/**
 * Manifest fields folded into a root catalog entry that omits them.
 *
 * Direction is deliberate: the ENTRY wins. `plugins/marketplace-reference.md#entry-and-plugin-json` —
 * "Plugin version. If set (here or in `plugin.json`), the plugin is pinned to
 * this string" — makes the entry the primary declaration, so the manifest only
 * fills a gap. Scope stays these three: MERGING lands browse identity
 * (name/description/version) only. Component declarations are read from the
 * same manifest but travel beside the catalog as
 * `FetchRegistryCatalogResult.manifestComponentKinds`, never merged into the
 * entry — see {@link mergePluginManifestMetadata}.
 */
const CATALOG_ENTRY_MANIFEST_FIELDS = ['description', 'version', 'displayName'] as const;

interface MergedPluginManifestMetadata {
  catalog: unknown;
  /** Declared component kinds per entry NAME (display-only; see the result field). */
  componentKinds: Record<string, PluginDeclaredComponentKind[]>;
}

/**
 * Fill the metadata a root catalog entry omits from that plugin's own manifest,
 * and collect the component kinds that manifest DECLARES.
 *
 * An entry is matched on its `local` source PATH only. Matching on the name as
 * well would enrich a row whose source is remote from a same-named directory
 * that is not its content — a wrong description is worse than none.
 *
 * The two outputs are separated deliberately: the identity strings are MERGED
 * into the entry (the entry is a manifest overlay and those three fields belong
 * to it), and the kinds are RETURNED BESIDE it because they are display facts
 * about a bundle, not a redeclaration of what to install.
 */
function mergePluginManifestMetadata(
  catalog: unknown,
  manifests: ScannedPluginManifest[],
): MergedPluginManifestMetadata {
  const componentKinds: Record<string, PluginDeclaredComponentKind[]> = {};
  if (!manifests.length || !isPlainObject(catalog)) return { catalog, componentKinds };
  const plugins = catalog.plugins;
  if (!Array.isArray(plugins)) return { catalog, componentKinds };

  const byPath = new Map(manifests.map(located => [located.relPath, located]));
  const metadata = isPlainObject(catalog.metadata) ? catalog.metadata : undefined;
  const pluginRoot = normalizeRelPath(readManifestString(metadata?.pluginRoot));

  let enriched = 0;
  const merged = plugins.map(entry => {
    if (!isPlainObject(entry)) return entry;
    const entryPath = catalogEntryRelPath(entry, pluginRoot);
    const located = entryPath ? byPath.get(entryPath) : undefined;
    if (!located) return entry;

    // The parser's own identity rule (`entry.name ?? entry.id`), so the key here
    // is the same string `registryItemId` builds the browse row's id from.
    const name = readManifestString(entry.name) ?? readManifestString(entry.id);
    const kinds = declaredPluginComponentKinds(located.manifest);
    if (name && kinds.length) componentKinds[name] = kinds;

    const additions: Record<string, unknown> = {};
    for (const field of CATALOG_ENTRY_MANIFEST_FIELDS) {
      if (readManifestString(entry[field]) !== undefined) continue;
      const value = readPluginManifestField(located.manifest, field);
      if (value) additions[field] = value;
    }
    if (!Object.keys(additions).length) return entry;
    enriched += 1;
    return { ...entry, ...additions };
  });

  return { catalog: enriched ? { ...catalog, plugins: merged } : catalog, componentKinds };
}

/**
 * The plugin directory a catalog entry points at, relative to the staged root,
 * or `undefined` for anything that is not a contained local path (remote source,
 * traversal, missing source).
 */
function catalogEntryRelPath(
  entry: Record<string, unknown>,
  pluginRoot: string,
): string | undefined {
  const source = entry.source;
  const raw = typeof source === 'string'
    ? source
    : isPlainObject(source) && (source.source === 'local' || source.type === 'local')
      ? readManifestString(source.path)
      : undefined;
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/')) return undefined;
  const relPath = normalizeRelPath(pluginRoot, raw);
  if (!relPath || relPath.split('/').includes('..')) return undefined;
  return relPath;
}

/**
 * A manifest field for the catalog row. Codex keeps the human-readable name
 * under `interface.displayName` (`plugins/build/plugins.md` § Manifest fields),
 * so that is read as a fallback for the top-level Claude spelling.
 */
function readPluginManifestField(
  manifest: Record<string, unknown>,
  field: (typeof CATALOG_ENTRY_MANIFEST_FIELDS)[number],
): string | undefined {
  const direct = readManifestString(manifest[field]);
  if (direct || field !== 'displayName') return direct;
  const codexInterface = manifest.interface;
  return isPlainObject(codexInterface) ? readManifestString(codexInterface.displayName) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function readDirEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

async function readFirstPluginManifest(
  pluginDir: string,
): Promise<{ format: 'codex' | 'claude'; manifest: Record<string, unknown> } | undefined> {
  for (const { manifestDir, format } of PLUGIN_MANIFEST_DESCRIPTORS) {
    let raw: string;
    try {
      raw = await readFile(join(pluginDir, manifestDir, 'plugin.json'), 'utf-8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { format, manifest: parsed as Record<string, unknown> };
      }
    } catch {
      // Malformed per-plugin manifest: skip this dir rather than fail the scan.
    }
  }
  return undefined;
}

function buildScannedPlugin(
  located: { format: 'codex' | 'claude'; manifest: Record<string, unknown> },
  relPath: string,
  dirName: string,
  registrySource: PluginInstallSource,
  catalogRoot: string,
): RegistryScannedPlugin {
  const name = readManifestString(located.manifest.name) ?? dirName;
  const description = readManifestString(located.manifest.description);
  const version = readManifestString(located.manifest.version);
  const declaredComponentKinds = declaredPluginComponentKinds(located.manifest);
  return {
    name,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    format: located.format,
    source: deriveRegistryPluginSource(registrySource, relPath, catalogRoot),
    ...(declaredComponentKinds.length ? { declaredComponentKinds } : {}),
  };
}

/**
 * A DURABLE install source for a plugin located at `relPath` inside a registry.
 * For a git registry: the registry's own repo + ref, with `subdirectory` = the
 * registry's own subdirectory joined with the plugin dir's path relative to the
 * staged root (so `/tree/main` and `/tree/main/plugins` converge on the same
 * repo-root-relative subdirectory). For a local folder: the real (non-temp)
 * folder subpath.
 *
 * Exported so the R2 catalog mapper can rebuild the SAME durable source for a
 * root-manifest `local` entry — otherwise its install source would resolve
 * inside the ephemeral staged root, which is removed after fetch.
 */
export function deriveRegistryPluginSource(
  registrySource: PluginInstallSource,
  relPath: string,
  _catalogRoot: string,
): PluginInstallSource {
  if (registrySource.kind === 'repository') {
    const subdirectory = joinSubdir(registrySource.subdirectory, relPath);
    return {
      kind: 'repository',
      repositoryUrl: registrySource.repositoryUrl,
      ...(registrySource.ref ? { ref: registrySource.ref } : {}),
      ...(subdirectory ? { subdirectory } : {}),
    };
  }
  if (registrySource.kind === 'local-path') {
    return { kind: 'local-path', path: join(registrySource.path, relPath) };
  }
  // URL/archive and other source kinds cannot encode a plugin subdirectory.
  // Never return the staged path: fetchRegistryCatalog removes it before return.
  return {
    kind: 'unsupported',
    value: relPath,
    reason: `Registry source kind "${registrySource.kind}" cannot represent a plugin subdirectory.`,
  };
}

function joinSubdir(base: string | undefined, rel: string): string {
  return normalizeRelPath(base, rel);
}

/** Join path parts into a `/`-separated relative path, dropping empty and `.` segments. */
function normalizeRelPath(...parts: (string | undefined)[]): string {
  return parts
    .flatMap(part => (part ?? '').split(/[\\/]+/))
    .map(segment => segment.trim())
    .filter(segment => segment && segment !== '.')
    .join('/');
}

function isSafePluginDirName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false; // skip dotdirs (.git, stray manifest dirs)
  return !/[\\/\0]/.test(name);
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('\0');
}

function readManifestString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
