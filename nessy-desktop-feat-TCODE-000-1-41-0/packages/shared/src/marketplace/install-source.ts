import { pluginDiagnostic } from '../plugins/schema.ts';
import { repositoryHostKind } from '../plugins/repository-hosts.ts';
import type {
  PluginDiagnostic,
  PluginInstallSource,
  PluginMarketplaceInstallMetadata,
} from '../plugins/types.ts';
import { deriveNessyExtensionCoordinates, marketplaceSkillPluginId } from './normalizers.ts';
import type { MarketplaceCatalogItem, MarketplaceStructuredInstallSource } from './types.ts';

type PluginRepositoryInstallSource = Extract<PluginInstallSource, { kind: 'repository' }>;

export interface MarketplacePluginInstallSourceResult {
  ok: boolean;
  source?: PluginInstallSource;
  diagnostics: PluginDiagnostic[];
}

export function createPluginInstallSourceFromMarketplaceItem(
  item: MarketplaceCatalogItem,
): MarketplacePluginInstallSourceResult {
  const source = item.install.source ?? item.install.fallback;
  if (!source) {
    return unsupportedSourceResult(item);
  }

  const marketplace = marketplaceMetadataForItem(item, source);
  switch (source.type) {
    case 'npm':
      return {
        ok: true,
        source: {
          kind: 'marketplace-npm-package',
          packageName: source.packageName,
          ...(source.version ? { version: source.version } : {}),
          ...(source.registry ? { registry: source.registry } : {}),
          ...(source.derivedCoordinates ? { derivedCoordinates: true } : {}),
          marketplace,
        },
        // A derived coordinate is never presented as a published one. The
        // package it resolved to is named out loud so a wrong guess is
        // visible in the install log rather than discovered as a wrong bundle.
        diagnostics: source.derivedCoordinates
          ? [pluginDiagnostic(
              'info',
              'marketplace.install.derived_source',
              `Marketplace item "${item.name}" publishes no install source; resolved npm coordinates ${source.packageName}${source.version ? `@${source.version}` : ''} from its repository path${source.registry ? ` on ${source.registry}` : ''}.`,
              'install.source',
              { itemId: item.id, packageName: source.packageName, sourceUrl: item.sourceUrl },
            )]
          : [],
      };
    case 'gitlab':
      if (item.kind !== 'skill') {
        if (isArchiveOrManifestUrl(source.url)) {
          return {
            ok: true,
            source: {
              kind: 'marketplace-url',
              url: source.url,
              marketplace,
            },
            diagnostics: [],
          };
        }
        const repositorySource = parseGitLabRepositorySource(source.url);
        if (repositorySource) {
          return {
            ok: true,
            source: {
              ...repositorySource,
              marketplace,
            },
            diagnostics: [],
          };
        }
        return unsupportedSourceResult(item);
      }
      return {
        ok: true,
        source: {
          kind: 'marketplace-gitlab-skill',
          url: source.url,
          ...(source.ref ? { ref: source.ref } : {}),
          ...(source.path ? { path: source.path } : {}),
          pluginId: marketplaceSkillPluginId(item.id),
          skillSlug: skillSlugForItem(item),
          name: item.name,
          ...(item.version ? { version: item.version } : {}),
          marketplace,
        },
        diagnostics: [],
      };
    case 'url':
      return {
        ok: true,
        source: {
          kind: 'marketplace-url',
          url: source.url,
          marketplace,
        },
        diagnostics: [],
      };
    case 'market-files':
      // v2 per-file snapshot install — skills only (the listing is a skill
      // directory; plugins keep their archive/manifest routes).
      if (item.kind !== 'skill') return unsupportedSourceResult(item);
      return {
        ok: true,
        source: {
          kind: 'marketplace-skill-files',
          filesUrl: source.filesUrl,
          pluginId: marketplaceSkillPluginId(item.id),
          skillSlug: skillSlugForItem(item),
          name: item.name,
          ...(item.version ? { version: item.version } : {}),
          marketplace,
        },
        diagnostics: [],
      };
  }
}

/**
 * Stamp a configured-registry listing identity onto its already typed source.
 * Registry catalogs intentionally carry executable-free typed sources rather
 * than renderer-visible install commands; this final server-side decoration is
 * what lets the installed record join back to the exact marketplace row.
 */
export function attachMarketplaceListingMetadata(
  source: PluginInstallSource,
  item: MarketplaceCatalogItem,
): PluginInstallSource {
  const marketplace: PluginMarketplaceInstallMetadata = {
    marketplaceId: item.marketplaceRegistryId ?? 'skills-market',
    ...(!item.marketplaceRegistryId
      ? { marketplaceBaseUrl: 'https://skills-market.t-tech.team/api' }
      : {}),
    itemId: item.id,
    listKind: item.listKind,
    itemKind: item.kind,
    name: item.name,
    ...(item.version ? { version: item.version } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    // S9: the entry's own plugin definition rides the install source so the
    // format adapter sees it. Without this the catalog row carried it and the
    // installer never did.
    ...(item.marketplaceEntry ? { entry: item.marketplaceEntry } : {}),
    raw: scrubInstallCommands(item.raw),
  };
  const merge = (existing?: PluginMarketplaceInstallMetadata): PluginMarketplaceInstallMetadata => ({
    ...existing,
    ...marketplace,
  });

  switch (source.kind) {
    case 'marketplace-npm-package':
    case 'marketplace-gitlab-skill':
    case 'marketplace-skill-files':
    case 'marketplace-url':
    case 'repository':
    case 'local-path':
      return { ...source, marketplace: merge(source.marketplace) };
    case 'url':
      return {
        kind: 'marketplace-url',
        url: source.url,
        ...(source.expectedHash ? { expectedHash: source.expectedHash } : {}),
        marketplace,
      };
    case 'agent-proposed':
      return {
        ...source,
        source: attachMarketplaceListingMetadata(source.source, item),
      };
    case 'unsupported':
      return source;
  }
}

function parseGitLabRepositorySource(urlString: string): PluginRepositoryInstallSource | null {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // C3.190 — the SAME question as `plugins/source-resolver.ts` asks, and it
    // was spelled here as a third inline substring. Shared now, so our own git
    // host cannot install through one route and refuse through the other.
    if (repositoryHostKind(url.hostname) !== 'gitlab') return null;

    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (segments.length < 2) return null;

    const markerIndex = segments.indexOf('-');
    if (markerIndex === -1) {
      return {
        kind: 'repository',
        repositoryUrl: `${url.origin}/${segments.join('/').replace(/\.git$/, '')}`,
      };
    }

    const repoSegments = segments.slice(0, markerIndex);
    const marker = segments[markerIndex + 1];
    if (repoSegments.length < 2 || marker !== 'tree') return null;

    const ref = segments[markerIndex + 2];
    if (!ref) return null;

    const subdirectoryParts = segments.slice(markerIndex + 3);
    return {
      kind: 'repository',
      repositoryUrl: `${url.origin}/${repoSegments.join('/').replace(/\.git$/, '')}`,
      ref: decodeURIComponent(ref),
      ...(subdirectoryParts.length ? { subdirectory: subdirectoryParts.map(decodeURIComponent).join('/') } : {}),
    };
  } catch {
    return null;
  }
}

function isArchiveOrManifestUrl(urlString: string): boolean {
  try {
    const { pathname } = new URL(urlString);
    const normalizedPath = pathname.toLowerCase();
    return normalizedPath.endsWith('.tgz')
      || normalizedPath.endsWith('.zip')
      || normalizedPath.endsWith('.tar.gz')
      || normalizedPath.endsWith('.json');
  } catch {
    return false;
  }
}

function unsupportedSourceResult(item: MarketplaceCatalogItem): MarketplacePluginInstallSourceResult {
  return {
    ok: false,
    diagnostics: [
      pluginDiagnostic(
        'error',
        'marketplace.install.unsupported_source',
        `Marketplace item "${item.name}" does not expose a structured install source supported by Nessy Desktop: ${describeMissingSource(item)}`,
        'install.source',
        {
          itemId: item.id,
          sourceConfidence: item.install.sourceConfidence,
          hasDisplayCommand: Boolean(item.install.displayCommand),
        },
      ),
    ],
  };
}

/**
 * Say what was MISSING, not that something was. The generic sentence sent an
 * operator hunting through the installer for a defect whose whole content was
 * "this catalog row has no `install` field and its `path` is not a repository
 * URL we can derive coordinates from".
 */
function describeMissingSource(item: MarketplaceCatalogItem): string {
  if (item.install.source ?? item.install.fallback) {
    return 'its declared source is not one this app can acquire.';
  }
  if (item.install.displayCommand) {
    return 'its install command names no package this app can resolve.';
  }
  const derived = deriveNessyExtensionCoordinates({ path: item.sourceUrl, name: item.name });
  switch ('gap' in derived ? derived.gap : undefined) {
    case 'listing-path-missing':
      return 'it carries no `install` field and no repository path to derive npm coordinates from.';
    case 'listing-path-not-a-repository-url':
      return `it carries no \`install\` field and its path (${item.sourceUrl ?? 'none'}) is not a repository URL.`;
    case 'listing-path-tree-without-subdirectory':
      return 'it carries no `install` field and its path points at a branch with no extension directory.';
    case 'listing-name-missing':
      return 'it carries no `install` field, and its repository-root path needs a listing name to derive npm coordinates.';
    default:
      return 'it carries no `install` field this app can turn into an install source.';
  }
}

function marketplaceMetadataForItem(
  item: MarketplaceCatalogItem,
  source: MarketplaceStructuredInstallSource,
): PluginMarketplaceInstallMetadata {
  return {
    marketplaceId: 'skills-market',
    marketplaceBaseUrl: 'https://skills-market.t-tech.team/api',
    itemId: item.id,
    listKind: item.listKind,
    itemKind: item.kind,
    name: item.name,
    ...(item.version ? { version: item.version } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(source.type === 'npm' ? { packageName: source.packageName } : {}),
    raw: scrubInstallCommands(item.raw),
  };
}

function scrubInstallCommands(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key !== 'install') {
      next[key] = entry;
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      next[key] = entry;
      continue;
    }
    const install = entry as Record<string, unknown>;
    const scrubbedInstall: Record<string, unknown> = {};
    for (const [installKey, installValue] of Object.entries(install)) {
      if (installKey === 'command' || installKey === 'commands') continue;
      scrubbedInstall[installKey] = installValue;
    }
    next[key] = scrubbedInstall;
  }
  return next;
}

function skillSlugForItem(item: MarketplaceCatalogItem): string {
  const rawFolderName = item.raw
    && typeof item.raw === 'object'
    && !Array.isArray(item.raw)
    && typeof (item.raw as Record<string, unknown>).folder_name === 'string'
      ? (item.raw as { folder_name: string }).folder_name
      : '';

  return normalizeSkillSlug(rawFolderName)
    || normalizeSkillSlug(item.name)
    || normalizeSkillSlug(item.id)
    || 'skill';
}

function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
}
