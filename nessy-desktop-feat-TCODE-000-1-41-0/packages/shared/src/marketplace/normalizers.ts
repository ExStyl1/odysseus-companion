import type {
  InstallSourceDto,
  MarketplaceCatalogItem,
  MarketplaceDetailDto,
  MarketplaceIcon,
  MarketplaceInstalledPluginSummary,
  MarketplaceInstalledState,
  MarketplaceInstallDescriptor,
  MarketplaceInstallDto,
  MarketplaceItemKind,
  MarketplaceListKind,
  MarketplaceListResult,
  MarketplaceRawListResult,
  MarketplaceStructuredInstallSource,
  PluginDto,
  SkillDto,
} from './types.ts';
import { DEFAULT_SKILLS_MARKET_API_BASE_URL } from './client.ts';

export interface MarketplaceNormalizeOptions {
  installed?: MarketplaceInstalledPluginSummary[];
}

export function normalizeSkillDto(
  dto: SkillDto,
  options: MarketplaceNormalizeOptions = {},
): MarketplaceCatalogItem {
  const id = readString(dto.skillId) ?? readString(dto.id) ?? readString(dto.folder_name) ?? fallbackId(dto.name, 'skill');
  const name = readString(dto.name) ?? readString(dto.folder_name) ?? id;
  const install = normalizeInstallDescriptor(dto.install, {
    artifactDelivery: dto.artifactDelivery,
    sourceLocator: dto.sourceLocator,
    skillFileUrl: dto.skill_url,
    detail: dto.detail,
    command: dto.command,
  });
  const sourceUrl = readString(dto.repo_url) ?? readString(dto.skill_url) ?? sourceUrlFromInstall(install);
  const item: MarketplaceCatalogItem = {
    id,
    kind: 'skill',
    listKind: 'skills',
    name,
    ...(readString(dto.description) ? { description: readString(dto.description) } : {}),
    ...(versionFromInstall(install) ? { version: versionFromInstall(install) } : {}),
    icon: iconForKind('skill'),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(readString(dto.skill_url) ? { detailUrl: readString(dto.skill_url) } : {}),
    ...(readString(dto.tenant) ? { tenant: readString(dto.tenant) } : {}),
    ...(readString(dto.repo_display) ?? readString(dto.repo_path) ? { repo: readString(dto.repo_display) ?? readString(dto.repo_path) } : {}),
    capabilities: ['skill'],
    install,
    raw: dto,
  };
  return attachInstalledState(item, options);
}

export function normalizePluginDto(
  dto: PluginDto,
  options: MarketplaceNormalizeOptions = {},
): MarketplaceCatalogItem {
  const id = readString(dto.id) ?? fallbackId(dto.name, 'plugin');
  const name = readString(dto.name) ?? id;
  const capabilityInfo = normalizeCapabilities(dto.capabilities);
  const kind = classifyPluginKind(capabilityInfo);
  const install = normalizeInstallDescriptor(dto.install, {
    detail: dto.detail,
    command: dto.command,
    listing: { path: dto.path, name: dto.name, version: dto.version },
  });
  const sourceUrl = readString(dto.path) ?? readString(dto.marketUrl) ?? sourceUrlFromInstall(install);
  const item: MarketplaceCatalogItem = {
    id,
    kind,
    listKind: 'plugins',
    name,
    ...(readString(dto.description) ? { description: readString(dto.description) } : {}),
    ...(readString(dto.version) ?? versionFromInstall(install) ? { version: readString(dto.version) ?? versionFromInstall(install) } : {}),
    icon: iconForKind(kind),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(readString(dto.marketUrl) ? { detailUrl: readString(dto.marketUrl) } : {}),
    capabilities: capabilityInfo.values,
    install,
    raw: dto,
  };
  return attachInstalledState(item, options);
}

export function normalizeCatalogPluginDto(
  dto: PluginDto,
  options: MarketplaceNormalizeOptions = {},
): MarketplaceCatalogItem {
  return normalizePluginDto(dto, options);
}

export function normalizeMarketplaceList(
  kind: MarketplaceListKind,
  response: MarketplaceRawListResult<SkillDto | PluginDto>,
  options: MarketplaceNormalizeOptions = {},
): MarketplaceListResult {
  const items = response.items.map(item => (
    kind === 'skills'
      ? normalizeSkillDto(item as SkillDto, options)
      : normalizePluginDto(item as PluginDto, options)
  ));
  return {
    items,
    page: response.page,
    pageSize: response.pageSize,
    total: response.total,
    visible: items.length,
    ...(response.generatedAt ? { generatedAt: response.generatedAt } : {}),
    ...(response.nextPage ? { nextPage: response.nextPage } : {}),
  };
}

export function marketplaceSkillPluginId(skillId: string): string {
  return `marketplace-skill-${sanitizePluginIdSegment(skillId)}`;
}

export interface MarketplaceInstallDescriptorExtras {
  artifactDelivery?: unknown;
  sourceLocator?: unknown;
  /** skills-market `skill_url`: a full `/-/blob/<ref>/<path>` GitLab file URL. */
  skillFileUrl?: unknown;
  detail?: MarketplaceDetailDto;
  command?: string;
  /**
   * The extension listing's own coordinates (`path`, `name`, `version`), used
   * only when nothing published a source. Threaded from `normalizePluginDto`
   * alone: `nessy extensions install` addresses extensions, not skills.
   */
  listing?: { path?: unknown; name?: unknown; version?: unknown };
}

function normalizeInstallDescriptor(
  install: MarketplaceInstallDto | undefined,
  extras: MarketplaceInstallDescriptorExtras = {},
): MarketplaceInstallDescriptor {
  const record = isRecord(install) ? install : undefined;

  const structuredSource = record ? normalizeStructuredInstallSource(record.source) : undefined;
  const structuredFallback = record ? normalizeStructuredInstallSource(record.fallback) : undefined;
  // skills-market `skill_url` is a complete `/-/blob/<ref>/<path>/SKILL.md`
  // file URL — the only catalog field carrying BOTH the ref and the full file
  // path. Prefer it over the path-only `sourceLocator` (repo root + directory,
  // no ref), which the GitLab fetcher cannot turn into a raw file request
  // (live failure `plugin.install.gitlab_skill_unexpected_html`, 2026-07-21).
  const artifactDeliverySource = !structuredSource ? normalizeArtifactDeliverySource(extras.artifactDelivery) : undefined;
  // The v2 per-file snapshot listing beats the single-file skill_url: it
  // carries every sibling resource with digests, straight from the market
  // (no GitLab auth), so multi-file skills install completely.
  const marketFilesSource = !structuredSource && !artifactDeliverySource
    ? normalizeMarketFilesSource(extras.artifactDelivery)
    : undefined;
  const skillFileSource = !structuredSource && !artifactDeliverySource && !marketFilesSource
    ? normalizeSkillFileUrlSource(extras.skillFileUrl)
    : undefined;
  const sourceLocatorSource = !structuredFallback ? normalizeSourceLocatorSource(extras.sourceLocator) : undefined;
  const detailManifestSource = !structuredSource && !artifactDeliverySource && !marketFilesSource && !skillFileSource
    ? normalizeDetailManifestSource(extras.detail)
    : undefined;
  const source = structuredSource ?? artifactDeliverySource ?? marketFilesSource ?? skillFileSource ?? detailManifestSource;
  const fallback = structuredFallback ?? sourceLocatorSource;

  const displayCommand = readString(record?.command) ?? readString(extras.command);
  const scopedCommands = normalizeScopedInstallCommands(record?.commands);
  const commandSource = !source && !fallback ? normalizeSourceFromInstallCommand(displayCommand) : undefined;
  const scopedCommandSource = !source && !fallback && !commandSource
    ? sourceFromScopedInstallCommands(scopedCommands)
    : undefined;
  // Last resort, and only for an extension listing that published NOTHING about
  // installing itself — which is the exact shape of the 106 rows (no `install`
  // key at all). A listing that DID state a command we cannot use is refused
  // rather than second-guessed: it made a claim, and overriding it with a guess
  // is how the wrong package gets installed quietly.
  const coordinateSource = !source && !fallback && !displayCommand && !scopedCommands
    ? normalizeSourceFromListingCoordinates(extras.listing)
    : undefined;
  const resolvedSource = source ?? commandSource ?? scopedCommandSource ?? coordinateSource;
  const descriptor: MarketplaceInstallDescriptor = {
    ...(displayCommand ? { displayCommand } : {}),
    ...(scopedCommands ? { scopedCommands } : {}),
    ...(resolvedSource ? { source: resolvedSource } : {}),
    ...(fallback ? { fallback } : {}),
    sourceConfidence: source
      ? 'primary'
      : fallback
        ? 'fallback'
        : commandSource ?? scopedCommandSource
          ? 'command-derived'
          : coordinateSource
            ? 'coordinates-derived'
            : displayCommand
              ? 'command-only'
              : scopedCommands
                ? 'unsupported-commands'
                : 'missing',
  };
  return descriptor;
}

function normalizeMarketFilesSource(artifactDelivery: unknown): MarketplaceStructuredInstallSource | undefined {
  if (!isRecord(artifactDelivery)) return undefined;
  const filesPath = readString(artifactDelivery.filesPath);
  // Only a market-relative v2 snapshot path is accepted — never an arbitrary
  // absolute URL a catalog row could smuggle in.
  if (!filesPath || !filesPath.startsWith('/v2/')) return undefined;
  const filesUrl = `${DEFAULT_SKILLS_MARKET_API_BASE_URL}${filesPath}`;
  return { type: 'market-files', filesUrl, raw: { type: 'market-files', filesUrl } };
}

function normalizeSkillFileUrlSource(input: unknown): MarketplaceStructuredInstallSource | undefined {
  const url = readString(input);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    // Only a concrete file URL is actionable; a repo root or tree URL is not.
    if (!parsed.pathname.includes('/-/blob/')) return undefined;
  } catch {
    return undefined;
  }
  return { type: 'gitlab', url, raw: { type: 'gitlab', url } };
}

function normalizeArtifactDeliverySource(input: unknown): MarketplaceStructuredInstallSource | undefined {
  if (!isRecord(input)) return undefined;
  if (readString(input.type) !== 'npm-package') return undefined;
  const packageName = readString(input.packageName);
  if (!packageName) return undefined;
  return {
    type: 'npm',
    packageName,
    ...(readString(input.version) ? { version: readString(input.version) } : {}),
    ...(readString(input.registry) ? { registry: readString(input.registry) } : {}),
    raw: input as InstallSourceDto,
  };
}

function normalizeSourceLocatorSource(input: unknown): MarketplaceStructuredInstallSource | undefined {
  const structured = normalizeStructuredInstallSource(input);
  if (structured) return structured;
  // skills-market `sourceLocator` shape (live catalog, no `type` field):
  // { providerInstance: "gitlab.tcsbank.ru", repositoryPath: "grp/repo",
  //   skillPath: "skills/.../name" } -> a structured gitlab source. Without
  // this mapping every catalog skill fell through to 'command-only'/'missing'
  // confidence and Install failed with "does not expose a structured install
  // source" (live-audit finding 2026-07-20).
  if (!isRecord(input)) return undefined;
  const providerInstance = readString(input.providerInstance);
  const repositoryPath = readString(input.repositoryPath);
  if (!providerInstance || !repositoryPath) return undefined;
  if (!/^[A-Za-z0-9.-]+$/.test(providerInstance)) return undefined;
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(repositoryPath)) return undefined;
  const skillPath = readString(input.skillPath);
  return {
    type: 'gitlab',
    url: `https://${providerInstance}/${repositoryPath}`,
    ...(skillPath ? { path: skillPath } : {}),
    raw: input as InstallSourceDto,
  };
}

function normalizeDetailManifestSource(detail: MarketplaceDetailDto | undefined): MarketplaceStructuredInstallSource | undefined {
  if (!detail) return undefined;
  const manifestUrl = readString(detail.manifestUrl);
  if (!manifestUrl) return undefined;
  return {
    type: 'url',
    url: manifestUrl,
    raw: {
      type: 'url',
      url: manifestUrl,
      ...(detail.manifest !== undefined ? { manifest: detail.manifest } : {}),
      ...(readString(detail.manifestPath) ? { manifestPath: readString(detail.manifestPath) } : {}),
    },
  };
}

function normalizeScopedInstallCommands(commands: unknown): MarketplaceInstallDescriptor['scopedCommands'] | undefined {
  if (!isRecord(commands)) return undefined;
  const user = readString(commands.user);
  const workspace = readString(commands.workspace);
  if (!user && !workspace) return undefined;
  return {
    ...(user ? { user } : {}),
    ...(workspace ? { workspace } : {}),
  };
}

function sourceFromScopedInstallCommands(
  commands: MarketplaceInstallDescriptor['scopedCommands'],
): MarketplaceStructuredInstallSource | undefined {
  if (!commands) return undefined;
  return normalizeSourceFromInstallCommand(commands.user)
    ?? normalizeSourceFromInstallCommand(commands.workspace);
}

/**
 * The npm scope + registry every published `nessy extensions install` command in
 * the live catalog names. The registry is NOT optional on a derived source:
 * `source-resolver.ts` records that dropping it makes an internal package fall
 * back to `registry.npmjs.org`, and a public package answering to an internal
 * name is a supply-chain hazard rather than a fallback.
 */
const NESSY_EXTENSION_PACKAGE_PREFIX = '@ai-office/nessy-extension-';
const NESSY_EXTENSION_NPM_REGISTRY = 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all';

/** Why a listing's coordinates could not be derived — named, never generic. */
export type NessyExtensionCoordinateGap =
  | 'listing-path-missing'
  | 'listing-path-not-a-repository-url'
  | 'listing-name-missing'
  | 'listing-path-tree-without-subdirectory';

export interface NessyExtensionCoordinates {
  packageName: string;
  registry: string;
}

/**
 * Derive an extension's npm coordinates from its marketplace listing.
 *
 * 106 of the live catalog's 118 rows carry no `install` field at all, so the
 * resolver refused the MAJORITY of the catalog — including every
 * `nessy-default-extension`, the entry carrying the base MCP set. The 12 rows
 * that DO publish a command establish the shape, and this reproduces all 12:
 *
 *   `<gitlab group>` + (the `/-/tree/<ref>/` subdirectory segments, each with a
 *   leading dot stripped) when the listing points INSIDE a repository, or the
 *   listing's own `name` when it points at a repository root.
 *
 * The repository name itself is never part of the package name — `gtech-sre/
 * gtech-sre-context/-/tree/master/.nessy/extensions/nessy-analyst-agent` is
 * published as `…-gtech-sre-nessy-extensions-nessy-analyst-agent` — and at a
 * repository root the listing NAME wins over the repository, which
 * `b2b-ai-market/idea-to-prod-extension` → `…-b2b-ai-market-init-deploy`
 * settles on its own.
 *
 * Segments are lowercased and `_` becomes `-`, which is a no-op on all 12
 * published commands and is how `dwh-tech-batch-etl/…/spark_sql_client_helper`
 * is published (`…-spark-sql-client-helper`, verified against the registry).
 *
 * Measured 2026-07-31 against `artifactory.tcsbank.ru/api/npm/npm-all`: 114 of
 * the 116 distinct derivations resolve. The 2 that do not are rows whose
 * package was never published — the registry says so cleanly, which is the
 * point of deriving coordinates rather than inventing an artifact.
 */
export function deriveNessyExtensionCoordinates(input: {
  path?: unknown;
  name?: unknown;
}): NessyExtensionCoordinates | { gap: NessyExtensionCoordinateGap } {
  const path = readString(input.path);
  if (!path) return { gap: 'listing-path-missing' };
  let url: URL;
  try {
    url = new URL(path);
  } catch {
    return { gap: 'listing-path-not-a-repository-url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { gap: 'listing-path-not-a-repository-url' };
  }
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const group = segments[0];
  if (!group) return { gap: 'listing-path-not-a-repository-url' };

  let tail: string[];
  const treeIndex = segments.findIndex((segment, index) => (
    segment === '-' && segments[index + 1] === 'tree'
  ));
  if (treeIndex === -1) {
    const name = readString(input.name);
    if (!name) return { gap: 'listing-name-missing' };
    tail = [name];
  } else {
    // Skip the `-`, the `tree` marker and the ref; what remains is the
    // directory the extension lives in.
    tail = segments.slice(treeIndex + 3);
    if (tail.length === 0) return { gap: 'listing-path-tree-without-subdirectory' };
  }

  const packageName = NESSY_EXTENSION_PACKAGE_PREFIX
    + [group, ...tail].map(normalizeExtensionPackageSegment).join('-');
  if (!isSafeNpmPackageName(packageName)) return { gap: 'listing-path-not-a-repository-url' };
  return { packageName, registry: NESSY_EXTENSION_NPM_REGISTRY };
}

function normalizeExtensionPackageSegment(segment: string): string {
  return segment.replace(/^\.+/, '').toLowerCase().replace(/_/g, '-');
}

function normalizeSourceFromListingCoordinates(
  listing: { path?: unknown; name?: unknown; version?: unknown } | undefined,
): MarketplaceStructuredInstallSource | undefined {
  if (!listing) return undefined;
  const derived = deriveNessyExtensionCoordinates(listing);
  if ('gap' in derived) return undefined;
  const version = readString(listing.version);
  return {
    type: 'npm',
    packageName: derived.packageName,
    ...(version ? { version } : {}),
    registry: derived.registry,
    derivedCoordinates: true,
    raw: {
      type: 'npm',
      packageName: derived.packageName,
      ...(version ? { version } : {}),
      registry: derived.registry,
    } as InstallSourceDto,
  };
}

function normalizeSourceFromInstallCommand(command: string | undefined): MarketplaceStructuredInstallSource | undefined {
  if (!command || /[|;&`$<>]/.test(command)) return undefined;
  const tokens = tokenizeCommand(command);
  if (tokens.length < 4) return undefined;
  if (tokens[0] !== 'nessy' || tokens[1] !== 'extensions' || tokens[2] !== 'install') return undefined;

  let packageSpec: string | undefined;
  let registry: string | undefined;
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === '--registry') {
      registry = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--registry=')) {
      registry = token.slice('--registry='.length);
      continue;
    }
    if (token.startsWith('-')) continue;
    if (!packageSpec) packageSpec = token;
  }
  if (!packageSpec) return undefined;

  const packageInfo = splitNpmPackageSpec(packageSpec);
  if (!isSafeNpmPackageName(packageInfo.packageName)) return undefined;
  return {
    type: 'npm',
    packageName: packageInfo.packageName,
    ...(packageInfo.version ? { version: packageInfo.version } : {}),
    ...(registry ? { registry } : {}),
    raw: {
      type: 'npm',
      package: packageInfo.packageName,
      ...(packageInfo.version ? { version: packageInfo.version } : {}),
      ...(registry ? { registry } : {}),
      derivedFrom: 'nessy extensions install',
    },
  };
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function splitNpmPackageSpec(spec: string): { packageName: string; version?: string } {
  const slashIndex = spec.indexOf('/');
  const versionIndex = spec.lastIndexOf('@');
  if (versionIndex > 0 && versionIndex > slashIndex) {
    return {
      packageName: spec.slice(0, versionIndex),
      version: spec.slice(versionIndex + 1),
    };
  }
  return { packageName: spec };
}

function isSafeNpmPackageName(packageName: string): boolean {
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(packageName);
}

function normalizeStructuredInstallSource(input: unknown): MarketplaceStructuredInstallSource | undefined {
  if (!isRecord(input)) return undefined;
  const type = readString(input.type);
  switch (type) {
    case 'npm': {
      const packageName = readString(input.package);
      if (!packageName) return undefined;
      return {
        type: 'npm',
        packageName,
        ...(readString(input.version) ? { version: readString(input.version) } : {}),
        ...(readString(input.registry) ? { registry: readString(input.registry) } : {}),
        raw: input as InstallSourceDto,
      };
    }
    case 'gitlab': {
      const url = readString(input.url);
      if (!url) return undefined;
      return {
        type: 'gitlab',
        url,
        ...(readString(input.ref) ? { ref: readString(input.ref) } : {}),
        ...(readString(input.path) ? { path: readString(input.path) } : {}),
        raw: input as InstallSourceDto,
      };
    }
    case 'url': {
      const url = readString(input.url);
      if (!url) return undefined;
      return {
        type: 'url',
        url,
        ...(readString(input.ref) ? { ref: readString(input.ref) } : {}),
        ...(readString(input.path) ? { path: readString(input.path) } : {}),
        raw: input as InstallSourceDto,
      };
    }
    default:
      return undefined;
  }
}

function attachInstalledState(
  item: MarketplaceCatalogItem,
  options: MarketplaceNormalizeOptions,
): MarketplaceCatalogItem {
  const installed = findInstalledItem(item, options.installed ?? []);
  if (!installed) return item;
  return {
    ...item,
    installed: toInstalledState(installed),
  };
}

function findInstalledItem(
  item: MarketplaceCatalogItem,
  installed: MarketplaceInstalledPluginSummary[],
): MarketplaceInstalledPluginSummary | undefined {
  return installed.find(entry => installedEntryMatchesItem(entry, item));
}

function installedEntryMatchesItem(
  entry: MarketplaceInstalledPluginSummary,
  item: MarketplaceCatalogItem,
): boolean {
  if (entry.source?.marketplaceItemId === item.id || entry.source?.rawSkillId === item.id) return true;
  if (entry.pluginId === item.id) return true;
  if (item.kind === 'skill' && entry.pluginId === marketplaceSkillPluginId(item.id)) return true;

  const packageSource = installPackageSource(item.install);
  if (packageSource && entry.source?.packageName === packageSource.packageName) {
    return !packageSource.version
      || !entry.source.packageVersion
      || isSameNpmRelease(entry.source.packageVersion, packageSource.version)
      || entry.version === packageSource.version;
  }

  const sourceUrls = installSourceUrls(item.install);
  if (item.sourceUrl) sourceUrls.add(item.sourceUrl);
  if (entry.source?.repositoryUrl && sourceUrls.has(entry.source.repositoryUrl)) return true;
  if (entry.source?.sourceUrl && sourceUrls.has(entry.source.sourceUrl)) return true;

  return false;
}

/**
 * The catalog advertises `1.0.9`; the registry publishes only
 * `1.0.9-source.20260716152955.45c8ba6c7514`, the CI build stamp for that same
 * release, and since E6 the install record persists the RESOLVED version rather
 * than the advertised one. A plain `===` on those two strings therefore reports
 * a stamped install as not-installed in browse, which is the whole join.
 *
 * The rule mirrors `selectNpmVersionName`'s `widened-within-base`: a stamp is
 * the advertised version plus a suffix. It is deliberately one-directional —
 * `1.0.9` never matches an advertised `1.0.9-source.…` — and it never crosses a
 * base, so `1.0.10` is not read as a stamp of `1.0.1`.
 */
function isSameNpmRelease(installedVersion: string, advertisedVersion: string): boolean {
  return installedVersion === advertisedVersion
    || installedVersion.startsWith(`${advertisedVersion}-`);
}

function toInstalledState(
  entry: MarketplaceInstalledPluginSummary,
): MarketplaceInstalledState {
  return {
    pluginKey: entry.pluginKey,
    activeInstanceId: entry.activeInstanceId,
    pluginId: entry.pluginId,
    version: entry.version,
    activation: 'active',
  };
}

function installPackageSource(install: MarketplaceInstallDescriptor): Extract<MarketplaceStructuredInstallSource, { type: 'npm' }> | undefined {
  if (install.source?.type === 'npm') return install.source;
  if (install.fallback?.type === 'npm') return install.fallback;
  return undefined;
}

function installSourceUrls(install: MarketplaceInstallDescriptor): Set<string> {
  const urls = new Set<string>();
  for (const source of [install.source, install.fallback]) {
    if (!source) continue;
    if (source.type === 'gitlab' || source.type === 'url') urls.add(source.url);
  }
  return urls;
}

function normalizeCapabilities(input: unknown): { values: string[]; hasMcp: boolean; hasHook: boolean } {
  const values = new Set<string>();
  let hasMcp = false;
  let hasHook = false;

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry === 'string' && entry.trim()) {
        values.add(entry.trim());
        if (entry.toLowerCase().includes('mcp')) hasMcp = true;
        if (entry.toLowerCase().includes('hook')) hasHook = true;
        continue;
      }
      if (!isRecord(entry)) continue;
      const capabilityKind = readString(entry.kind)?.toLowerCase();
      const capabilityName = readString(entry.id) ?? readString(entry.name) ?? readString(entry.slug);
      if (capabilityName) values.add(capabilityName);
      if (capabilityKind === 'mcp') hasMcp = true;
      if (capabilityKind === 'hook') hasHook = true;
    }
    return { values: sorted(values), hasMcp, hasHook };
  }

  if (isRecord(input)) {
    for (const value of readStringArray(input.skills)) values.add(value);
    const mcpValues = [
      ...readStringArray(input.mcpServers),
      ...readStringArray(input.mcp_servers),
      ...readStringArray(input.mcp),
    ];
    for (const value of mcpValues) values.add(value);
    const hookValues = readStringArray(input.hooks);
    for (const value of hookValues) values.add(value);
    hasMcp = mcpValues.length > 0;
    hasHook = hookValues.length > 0;
    for (const [key, value] of Object.entries(input)) {
      if (['skills', 'mcpServers', 'mcp_servers', 'mcp', 'hooks'].includes(key)) continue;
      for (const entry of readStringArray(value)) values.add(entry);
    }
    return { values: sorted(values), hasMcp, hasHook };
  }

  return { values: [], hasMcp: false, hasHook: false };
}

function classifyPluginKind(capabilities: { hasMcp: boolean; hasHook: boolean }): MarketplaceItemKind {
  if (capabilities.hasMcp) return 'mcp';
  if (capabilities.hasHook) return 'hook';
  return 'plugin';
}

function iconForKind(kind: MarketplaceItemKind): MarketplaceIcon {
  return { kind: 'symbol', name: kind };
}

function versionFromInstall(install: MarketplaceInstallDescriptor): string | undefined {
  if (install.source?.type === 'npm') return install.source.version;
  if (install.fallback?.type === 'npm') return install.fallback.version;
  return undefined;
}

function sourceUrlFromInstall(install: MarketplaceInstallDescriptor): string | undefined {
  if (install.source?.type === 'gitlab' || install.source?.type === 'url') return install.source.url;
  if (install.fallback?.type === 'gitlab' || install.fallback?.type === 'url') return install.fallback.url;
  return undefined;
}

function fallbackId(name: unknown, prefix: string): string {
  return `${prefix}-${sanitizePluginIdSegment(typeof name === 'string' ? name : 'unknown')}`;
}

function sanitizePluginIdSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return sanitized || 'unknown';
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(entry => entry.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
