// [nessy-fork] desktop-internal-extension-marketplace
// [nessy-fork] desktop-skill-marketplace-install-state
import type {
  ExtensionMarketplaceItem,
  SkillMarketplaceItem,
} from '@craft-agent/shared/protocol';
import type { PlatformFetch } from '../runtime/platform';

export const INTERNAL_MARKETPLACE_BASE_URL =
  'https://skills-market.t-tech.team/api';

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;

interface SkillInstallDto {
  command?: string;
  commands?: {
    user?: string;
    workspace?: string;
  };
  source?: {
    type?: string;
    url?: string;
  };
}

interface SkillDto {
  id?: string;
  skillId?: string;
  legacySlug?: string;
  repo_url?: string;
  skill_url?: string;
  name?: string;
  description?: string;
  folder_name?: string;
  skill_path?: string;
  tags?: string[];
  metrics?: {
    installs?: number;
  };
  install?: SkillInstallDto & {
    fallback?: SkillInstallDto;
  };
  tenant?: string;
  repo_display?: string;
  author?: string;
  last_commit_at?: string;
  first_commit_at?: string;
  professions?: string[];
  taxonomy?: Record<string, unknown>;
  enrichment?: {
    source?: string;
    status?: string;
    category?: string;
    updated_at?: string;
    security?: {
      verdict?: string;
    };
  };
  cluster?: {
    sources?: Array<{
      tenant?: string;
      repo_path?: string;
      repo_url?: string;
      skill_url?: string;
      author?: string;
      relation?: string;
      last_commit_at?: string;
    }>;
    aggregated?: {
      installs?: number;
      authors?: string[];
    };
  };
}

interface SkillRegistryEntryDto {
  address?: {
    canonical?: string;
    owner?: string;
    name?: string;
  };
  display?: {
    name?: string;
    description?: string;
    author?: string;
  };
  agentSkill?: {
    canonicalName?: string;
    repositoryPath?: string;
    normalizedSkillPath?: string;
  };
  delivery?: {
    installable?: boolean;
    installCommand?: string;
  };
}

interface PluginDto {
  id: string;
  name: string;
  description: string;
  version: string;
  path: string;
  marketUrl?: string;
  metrics?: {
    install_count?: number;
  };
  install?: {
    command: string;
  };
  capabilities?: Record<string, unknown>;
}

interface PluginDetailsDto extends PluginDto {
  kind?: string;
  manifestUrl?: string;
  manifestPath?: string;
  summary?: string;
  manifest?: {
    tenant?: string;
    repository?: string;
    [key: string]: unknown;
  };
}

interface PluginsResponseDto {
  plugins: PluginDto[];
  total?: number;
}

export interface MarketplaceListOptions {
  page?: number;
  pageSize?: number;
  query?: string;
}

export interface MarketplaceListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface InternalMarketplaceClient {
  // [nessy-fork] desktop-skill-scope-management
  listSkills(
    options?: MarketplaceListOptions,
  ): Promise<
    MarketplaceListResult<
      Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>
    >
  >;
  getSkill(
    id: string,
    detailsId?: string,
  ): Promise<Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>>;
  getSkillDetails(skillReference: string): Promise<SkillDetails>;
  listExtensions(
    options?: MarketplaceListOptions,
  ): Promise<
    MarketplaceListResult<Omit<ExtensionMarketplaceItem, 'installed'>>
  >;
  getExtension(
    id: string,
  ): Promise<Omit<ExtensionMarketplaceItem, 'installed'>>;
}

export interface InternalMarketplaceClientOptions {
  fetch?: PlatformFetch;
}

function textOrFallback(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function lastPathSegment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutSkillFile = trimmed.replace(/\/SKILL\.md(?:[?#].*)?$/i, '');
  const parts = withoutSkillFile.split('/').filter(Boolean);
  return parts.at(-1);
}

const INTERNAL_SKILL_MARKETPLACE_HOST = 'skills-market.t-tech.team';
const INTERNAL_SKILL_MARKETPLACE_HASH_PREFIX = 'artifact/skill:';

/**
 * The catalog exposes an internal market link that wraps the real Skill source
 * URL in its hash: `https://skills-market.t-tech.team/#artifact/skill:<encoded
 * source url>`. resolve-source needs the unwrapped exact source URL. When the
 * input is not such a link (already a direct source URL) it is returned as-is.
 */
function extractSkillSourceUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.hostname !== INTERNAL_SKILL_MARKETPLACE_HOST) return input;
    const hash = decodeURIComponent(parsed.hash.replace(/^#/, ''));
    if (!hash.startsWith(INTERNAL_SKILL_MARKETPLACE_HASH_PREFIX)) return input;
    return hash.slice(INTERNAL_SKILL_MARKETPLACE_HASH_PREFIX.length);
  } catch {
    return input;
  }
}

function isInternalMarketLink(value: string): boolean {
  try {
    return new URL(value).hostname === INTERNAL_SKILL_MARKETPLACE_HOST;
  } catch {
    // Canonical addresses (`tenant/skill`) are not URLs — and never wrappers.
    return false;
  }
}

const INSTALL_COMMAND_PREFIX = /^dp\s+skills\s+install\s+/;

/**
 * The catalog ships ready-made CLI invocations (`install.command`,
 * `install.commands.user`, `install.commands.workspace`) that differ only in
 * their trailing flags. Desktop passes the scope separately over ACP, so only
 * the source argument is kept — flags after it are dropped.
 */
function parseInstallCommandSource(
  command: string | undefined,
): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed || !INSTALL_COMMAND_PREFIX.test(trimmed)) return undefined;
  const [source] = trimmed
    .replace(INSTALL_COMMAND_PREFIX, '')
    .split(/\s+/)
    .filter(Boolean);
  return source || undefined;
}

/**
 * `dp skills install` rejects the market wrapper link with `неподдерживаемый
 * source`, so a source is only usable once unwrapped to the real Skill URL.
 */
function directSkillSource(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const unwrapped = extractSkillSourceUrl(trimmed);
  return isInternalMarketLink(unwrapped) ? undefined : unwrapped;
}

function skillInstallSourceUrl(skill: SkillDto): string {
  const candidates = [
    parseInstallCommandSource(skill.install?.command),
    parseInstallCommandSource(skill.install?.fallback?.command),
    skill.install?.fallback?.source?.url,
    skill.skill_url,
    skill.repo_url,
  ];
  for (const candidate of candidates) {
    const source = directSkillSource(candidate);
    if (source) return source;
  }
  return '';
}

function mapSkill(
  skill: SkillDto,
): Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'> {
  const skillUrl = textOrFallback(skill.skill_url, skill.repo_url ?? '');
  const sourceUrl = skillInstallSourceUrl(skill);
  // id — legacySlug для API /v1/skills/{id}, fallback на skill.id или URL
  const id = skill.legacySlug ?? skill.id ?? (skillUrl || sourceUrl);
  const slug = textOrFallback(
    skill.folder_name,
    skill.name ??
      lastPathSegment(skill.skill_path) ??
      lastPathSegment(skillUrl) ??
      id,
  );
  const name = textOrFallback(skill.name, slug);
  const description = textOrFallback(skill.description, 'Nessy CLI skill');
  // tagline — первая часть описания (до точки или до Use)
  const tagline =
    description.split(
      /\.\s*(?=Use|When|Browser|Agent|Run|Create|Analyze|Search|Generate|Automate)/i,
    )[0] ?? description;
  return {
    id,
    slug,
    name,
    tagline: tagline.length < description.length ? tagline + '.' : tagline,
    description,
    iconKey: 'internal-skill',
    websiteUrl: skill.repo_url ?? skillUrl,
    sourceUrl,
    detailsId: skill.skillId,
    examples: [],
  };
}

// Extended skill details for the detail panel
export interface SkillDetails {
  tenant?: string;
  repoDisplay?: string;
  repoUrl?: string;
  author?: string;
  lastCommitAt?: string;
  firstCommitAt?: string;
  professions?: string[];
  tags?: string[];
  taxonomy?: Record<string, unknown>;
  enrichment?: {
    source?: string;
    status?: string;
    category?: string;
    updatedAt?: string;
    securityVerdict?: string;
  };
  installCommand?: string;
  sources?: Array<{
    tenant?: string;
    repoPath?: string;
    repoUrl?: string;
    skillUrl?: string;
    author?: string;
    relation?: string;
    lastCommitAt?: string;
  }>;
  aggregatedInstalls?: number;
  aggregatedAuthors?: string[];
}

function mapSkillDetails(skill: SkillDto): SkillDetails {
  return {
    tenant: skill.tenant,
    repoDisplay: skill.repo_display,
    repoUrl: skill.repo_url,
    author: skill.author,
    lastCommitAt: skill.last_commit_at,
    firstCommitAt: skill.first_commit_at,
    professions: skill.professions,
    tags: skill.tags,
    taxonomy: skill.taxonomy,
    enrichment: skill.enrichment
      ? {
          source: skill.enrichment.source,
          status: skill.enrichment.status,
          category: skill.enrichment.category,
          updatedAt: skill.enrichment.updated_at,
          securityVerdict: skill.enrichment.security?.verdict,
        }
      : undefined,
    installCommand: skill.install?.command,
    sources: skill.cluster?.sources?.map((source) => ({
      tenant: source.tenant,
      repoPath: source.repo_path,
      repoUrl: source.repo_url,
      skillUrl: source.skill_url,
      author: source.author,
      relation: source.relation,
      lastCommitAt: source.last_commit_at,
    })),
    aggregatedInstalls: skill.cluster?.aggregated?.installs,
    aggregatedAuthors: skill.cluster?.aggregated?.authors,
  };
}

function mapSkillDetailsV2(card: Record<string, unknown>): SkillDetails {
  const source = card.source as Record<string, unknown> | undefined;
  return {
    tenant: source?.tenant as string | undefined,
    repoDisplay: source?.repositoryPath as string | undefined,
    repoUrl: source?.repositoryUrl as string | undefined,
    author: card.author as string | undefined,
    lastCommitAt: undefined,
    firstCommitAt: undefined,
    professions: undefined,
    tags: undefined,
    taxonomy: undefined,
    enrichment: undefined,
    installCommand: (card.install as { command?: string })?.command,
    sources: source
      ? [
          {
            tenant: source.tenant as string | undefined,
            repoPath: source.repositoryPath as string | undefined,
            repoUrl: source.repositoryUrl as string | undefined,
            skillUrl: source.skillPath as string | undefined,
            author: undefined,
            relation: 'owner',
            lastCommitAt: undefined,
          },
        ]
      : undefined,
    aggregatedInstalls: undefined,
    aggregatedAuthors: undefined,
  };
}

function mapPlugin(
  plugin: PluginDto,
): Omit<ExtensionMarketplaceItem, 'installed'> {
  return {
    id: plugin.id,
    name: plugin.name,
    tagline: plugin.description,
    description: plugin.description,
    version: plugin.version,
    sourceUrl: plugin.path,
    marketUrl: plugin.marketUrl,
    installCommand: plugin.install?.command ?? '',
    capabilities: plugin.capabilities ?? {},
    installCount: plugin.metrics?.install_count ?? 0,
  };
}

/** Thin in-memory cache with TTL expiry. */
class SimpleCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

function buildSkillsUrl(options: MarketplaceListOptions): string {
  const params = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 100),
    sort: 'installs',
    withDescription: 'true',
  });
  if (options.query) {
    params.set('q', options.query);
  }
  return `/v1/skills?${params.toString()}`;
}

function buildPluginsUrl(options: MarketplaceListOptions): string {
  const params = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 100),
    sort: 'installs',
  });
  if (options.query) {
    params.set('q', options.query);
  }
  return `/v1/plugins?${params.toString()}`;
}

async function fetchJson<T>(
  fetcher: PlatformFetch,
  path: string,
): Promise<{ body: T; total?: number }> {
  const url = new URL(
    path.replace(/^\/+/, ''),
    `${INTERNAL_MARKETPLACE_BASE_URL}/`,
  );
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Internal marketplace request failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = await response.json();
  if (!Array.isArray(body) && (typeof body !== 'object' || body === null)) {
    throw new Error('Internal marketplace returned unexpected response format');
  }
  const totalHeader = response.headers.get('x-total-count');
  const total = totalHeader === null ? undefined : Number(totalHeader);
  return {
    body: body as T,
    total: Number.isFinite(total) ? total : undefined,
  };
}

export function createInternalMarketplaceClient(
  options: InternalMarketplaceClientOptions = {},
): InternalMarketplaceClient {
  const fetcher: PlatformFetch =
    options.fetch ?? ((input, init) => fetch(input, init));
  const skillsCache = new SimpleCache<
    MarketplaceListResult<
      Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>
    >
  >(CACHE_TTL_MS);
  const extensionsCache = new SimpleCache<
    MarketplaceListResult<Omit<ExtensionMarketplaceItem, 'installed'>>
  >(CACHE_TTL_MS);

  async function listSkills(
    listOptions: MarketplaceListOptions = {},
  ): Promise<
    MarketplaceListResult<
      Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>
    >
  > {
    const cacheKey = JSON.stringify(listOptions);
    const cached = skillsCache.get(cacheKey);
    if (cached) return cached;

    const response = await fetchJson<SkillDto[]>(
      fetcher,
      buildSkillsUrl(listOptions),
    );
    const items = response.body.map(mapSkill);
    const result: MarketplaceListResult<
      Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>
    > = {
      items,
      total: response.total ?? items.length,
      page: listOptions.page ?? 1,
      pageSize: listOptions.pageSize ?? 100,
    };
    skillsCache.set(cacheKey, result);
    return result;
  }

  // [nessy-fork] desktop-skill-marketplace-pagination
  async function withInstallSource(
    skill: Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>,
  ): Promise<Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'>> {
    if (!skill.detailsId) return skill;
    const entry = await fetchRegistryEntry(skill.detailsId);
    const installSource = entry?.address?.canonical?.trim();
    return installSource ? { ...skill, installSource } : skill;
  }

  async function fetchRegistryEntry(
    detailsId: string,
  ): Promise<SkillRegistryEntryDto | undefined> {
    const response = await fetchJson<SkillRegistryEntryDto>(
      fetcher,
      `/v2/registry/entries/agent-skill/${encodeURIComponent(detailsId)}`,
    );
    return response.body;
  }

  /**
   * The registry entry alone carries everything an install needs, so a skill
   * outside the first catalog page (the API caps `pageSize` at 100) stays
   * installable — `/v1/skills/{legacySlug}` answers 404 for those.
   */
  // [nessy-fork] desktop-skill-marketplace-pagination
  async function skillFromRegistryEntry(
    id: string,
    detailsId: string,
  ): Promise<
    Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'> | undefined
  > {
    const entry = await fetchRegistryEntry(detailsId);
    const installSource = entry?.address?.canonical?.trim();
    if (!installSource) return undefined;
    const slug = textOrFallback(
      entry?.agentSkill?.canonicalName,
      entry?.address?.name ?? lastPathSegment(installSource) ?? id,
    );
    const description = textOrFallback(
      entry?.display?.description,
      'Nessy CLI skill',
    );
    return {
      id,
      slug,
      name: textOrFallback(entry?.display?.name, slug),
      tagline: description,
      description,
      iconKey: 'internal-skill',
      sourceUrl: installSource,
      installSource,
      detailsId,
      examples: [],
    };
  }

  /**
   * `q` does not match a legacy slug (`tenant__repo__folder`), so the folder
   * segment is used to find skills that fall outside the first page.
   */
  // [nessy-fork] desktop-skill-marketplace-pagination
  async function findListedSkill(
    id: string,
  ): Promise<
    Omit<SkillMarketplaceItem, 'installed' | 'installedScopes'> | undefined
  > {
    const firstPage = await listSkills();
    const listed = firstPage.items.find((item) => item.id === id);
    if (listed) return listed;
    const query = id.split('__').at(-1);
    if (!query || query === id) return undefined;
    const searched = await listSkills({ query });
    return searched.items.find((item) => item.id === id);
  }

  return {
    listSkills,

    async getSkill(id: string, detailsId?: string) {
      if (detailsId) {
        const fromRegistry = await skillFromRegistryEntry(id, detailsId);
        if (fromRegistry) return fromRegistry;
      }
      const listed = await findListedSkill(id);
      if (listed) return withInstallSource(listed);
      const response = await fetchJson<SkillDto>(
        fetcher,
        `/v1/skills/${encodeURIComponent(id)}`,
      );
      return withInstallSource(mapSkill(response.body));
    },

    async getSkillDetails(skillReference: string) {
      if (skillReference.startsWith('skl_')) {
        const detailResponse = await fetchJson<Record<string, unknown>>(
          fetcher,
          `/v2/skills/${encodeURIComponent(skillReference)}`,
        );
        return mapSkillDetailsV2(detailResponse.body);
      }

      // The catalog encodes the exact Skill source URL inside the internal
      // market link (`#artifact/skill:<encoded source url>`). resolve-source
      // needs that exact source URL — a bare repo root is rejected with 400.
      const resolvedSourceUrl = extractSkillSourceUrl(skillReference);
      // Use v2 API to resolve source URL to skill details
      const resolveResponse = await fetchJson<{
        skillId?: string;
        snapshotId?: string;
        artifactId?: string;
        name?: string;
      }>(
        fetcher,
        `/v2/skills/resolve-source?skillUrl=${encodeURIComponent(resolvedSourceUrl)}`,
      );

      const skillId = resolveResponse.body.skillId;
      if (!skillId) {
        throw new Error(`Skill not found for URL: ${skillReference}`);
      }

      const detailResponse = await fetchJson<Record<string, unknown>>(
        fetcher,
        `/v2/skills/${encodeURIComponent(skillId)}`,
      );
      return mapSkillDetailsV2(detailResponse.body);
    },

    async listExtensions(
      listOptions: MarketplaceListOptions = {},
    ): Promise<
      MarketplaceListResult<Omit<ExtensionMarketplaceItem, 'installed'>>
    > {
      const cacheKey = JSON.stringify(listOptions);
      const cached = extensionsCache.get(cacheKey);
      if (cached) return cached;

      const response = await fetchJson<PluginsResponseDto>(
        fetcher,
        buildPluginsUrl(listOptions),
      );
      const items = (response.body.plugins ?? []).map(mapPlugin);
      const result: MarketplaceListResult<
        Omit<ExtensionMarketplaceItem, 'installed'>
      > = {
        items,
        total: response.body.total ?? response.total ?? items.length,
        page: listOptions.page ?? 1,
        pageSize: listOptions.pageSize ?? 100,
      };
      extensionsCache.set(cacheKey, result);
      return result;
    },

    async getExtension(id: string) {
      const response = await fetchJson<PluginDetailsDto>(
        fetcher,
        `/v1/plugins/${encodeURIComponent(id)}`,
      );
      return mapPluginDetails(response.body);
    },
  };
}

function mapPluginDetails(
  plugin: PluginDetailsDto,
): Omit<ExtensionMarketplaceItem, 'installed'> {
  return {
    id: plugin.id,
    name: plugin.name,
    tagline: plugin.summary ?? plugin.description,
    description: plugin.description,
    version: plugin.version,
    sourceUrl: plugin.path,
    marketUrl: plugin.marketUrl,
    installCommand: plugin.install?.command ?? '',
    capabilities: plugin.capabilities ?? {},
    installCount: plugin.metrics?.install_count ?? 0,
    kind: plugin.kind,
    manifestUrl: plugin.manifestUrl,
    manifestPath: plugin.manifestPath,
    manifest: plugin.manifest,
  };
}
