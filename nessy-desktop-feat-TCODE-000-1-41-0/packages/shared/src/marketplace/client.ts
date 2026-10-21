import {
  SKILLS_MARKET_MAX_PAGE_SIZE,
  SKILLS_MARKET_REGISTRY_MAX_LIMIT,
  type MarketplaceClientOptions,
  type MarketplaceFacetOption,
  type MarketplaceInstallationReceipt,
  type MarketplaceInstallationReport,
  type MarketplaceListParams,
  type MarketplaceMetaDto,
  type MarketplaceRawListResult,
  type MarketplaceSkillArchiveDownload,
  type MarketplaceSkillArchiveRef,
  type MarketplaceSkillFacets,
  type MarketplaceSkillSnapshot,
  type PluginDto,
  type PluginsResponseDto,
  type SkillDto,
  type SkillsRegistryCatalogPage,
  type SkillsRegistryCatalogParams,
  type SkillsRegistryGroup,
  type SkillsRegistryVariant,
} from './types.ts';

export const DEFAULT_SKILLS_MARKET_API_BASE_URL = 'https://skills-market.t-tech.team/api';

export type MarketplaceClientErrorCode =
  | 'digest-mismatch'
  | 'http-error'
  | 'invalid-json'
  | 'invalid-response'
  | 'network-error';

export interface MarketplaceClientErrorOptions {
  code: MarketplaceClientErrorCode;
  endpoint: string;
  status?: number;
  message: string;
  cause?: unknown;
}

export class MarketplaceClientError extends Error {
  override readonly name = 'MarketplaceClientError';
  readonly code: MarketplaceClientErrorCode;
  readonly endpoint: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(options: MarketplaceClientErrorOptions) {
    super(options.message);
    this.code = options.code;
    this.endpoint = options.endpoint;
    this.status = options.status;
    this.cause = options.cause;
  }
}

export class SkillsMarketClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MarketplaceClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_SKILLS_MARKET_API_BASE_URL);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getMarketplaceMeta(): Promise<MarketplaceMetaDto> {
    const endpoint = '/v1/meta';
    const { payload } = await this.fetchJson(endpoint, this.buildUrl(endpoint));
    if (!isRecord(payload)) {
      throw invalidResponse(endpoint, 'Marketplace meta response must be an object');
    }
    return payload as MarketplaceMetaDto;
  }

  async listMarketplaceSkills(params: MarketplaceListParams = {}): Promise<MarketplaceRawListResult<SkillDto>> {
    const endpoint = '/v1/skills';
    const request = normalizeListParams(params);
    const url = this.buildListUrl(endpoint, request, { includePluginKind: false });
    const { payload, response } = await this.fetchJson(endpoint, url);
    const items = extractArray<SkillDto>(payload, ['skills', 'items', 'results', 'data']);
    if (!items) {
      throw invalidResponse(endpoint, 'Marketplace skills response must be an array or contain a skills array');
    }
    const total = parseTotalCountHeader(response.headers) ?? extractNumber(payload, 'total') ?? items.length;
    return createListResult({
      items,
      page: request.page,
      pageSize: request.pageSize,
      total,
      raw: payload,
      generatedAt: extractString(payload, 'generated_at'),
    });
  }

  async listMarketplacePlugins(params: MarketplaceListParams = {}): Promise<MarketplaceRawListResult<PluginDto>> {
    const endpoint = '/v1/plugins';
    const request = normalizeListParams(params);
    const url = this.buildListUrl(endpoint, request, { includePluginKind: true });
    const { payload } = await this.fetchJson(endpoint, url);
    const items = extractArray<PluginDto>(payload, ['plugins', 'items', 'results', 'data']);
    if (!items) {
      throw invalidResponse(endpoint, 'Marketplace plugins response must contain a plugins array');
    }
    const body = isRecord(payload) ? payload as PluginsResponseDto : {};
    const page = numberOrDefault(body.page, request.page);
    const pageSize = numberOrDefault(body.pageSize ?? body.page_size, request.pageSize);
    const total = numberOrDefault(body.total, items.length);
    return createListResult({
      items,
      page,
      pageSize,
      total,
      raw: payload,
      generatedAt: extractString(payload, 'generated_at'),
    });
  }

  /**
   * The filter vocabulary for `/v1/skills` — the only source of legal values for
   * the `tenant`, `tag` and `profession` parameters. Options the server sends in
   * an unexpected shape are dropped rather than failing the whole call; a facet
   * list is an aid to browsing, not a correctness boundary.
   */
  async getMarketplaceSkillFacets(): Promise<MarketplaceSkillFacets> {
    const endpoint = '/v1/skills/facets';
    const { payload } = await this.fetchJson(endpoint, this.buildUrl(endpoint));
    if (!isRecord(payload)) {
      throw invalidResponse(endpoint, 'Marketplace facets response must be an object');
    }
    return {
      tenants: facetOptions(payload.tenants),
      tags: facetOptions(payload.tags),
      professions: facetOptions(payload.professions),
    };
  }

  /**
   * The v2 Registry catalog, which groups variants of the same skill into one
   * cluster server-side. Browse lists a group, not an entry: measured
   * 2026-07-31, 3914 groups cover 5341 entries, so consuming entries shows 1427
   * duplicate rows.
   *
   * `kind` is pinned to `agent-skill` deliberately — the v2 Registry is
   * skills-only by server-side kind validation (`?kind=nessy-extension` answers
   * HTTP 400 `INVALID_REGISTRY_KIND`, and the OpenAPI document pins the
   * parameter to `enum: ["agent-skill"]`). Extensions keep the `/v1/plugins`
   * route. Paging is `limit` + `cursor`; a `pageSize` parameter is rejected with
   * HTTP 400 `INVALID_QUERY`.
   */
  async listSkillsRegistryCatalog(params: SkillsRegistryCatalogParams = {}): Promise<SkillsRegistryCatalogPage> {
    const endpoint = '/v2/registry/catalog';
    const url = this.buildUrl(endpoint);
    url.searchParams.set('kind', 'agent-skill');
    if (params.query?.trim()) url.searchParams.set('q', params.query.trim());
    url.searchParams.set(
      'limit',
      String(Math.min(clampPositiveInteger(params.limit, 50), SKILLS_MARKET_REGISTRY_MAX_LIMIT)),
    );
    if (params.cursor) url.searchParams.set('cursor', params.cursor);
    if (params.sort) url.searchParams.set('sort', params.sort);
    if (params.domain?.trim()) url.searchParams.set('domain', params.domain.trim());
    if (params.subdomain?.trim()) url.searchParams.set('subdomain', params.subdomain.trim());
    for (const profession of params.professions ?? []) url.searchParams.append('profession', profession);
    for (const tag of params.tags ?? []) url.searchParams.append('tag', tag);
    for (const tenant of params.tenants ?? []) url.searchParams.append('tenant', tenant);

    const { payload } = await this.fetchJson(endpoint, url);
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw invalidResponse(endpoint, 'Registry catalog response must contain an items array');
    }
    const groups = payload.items.flatMap(item => {
      const group = registryGroup(item);
      return group ? [group] : [];
    });
    const facets = isRecord(payload.facets) ? payload.facets : {};
    return {
      generationId: extractString(payload, 'generationId') ?? '',
      groups,
      totalGroups: extractNumber(payload, 'totalGroups') ?? groups.length,
      totalEntries: extractNumber(payload, 'totalEntries')
        ?? groups.reduce((count, group) => count + group.variants.length, 0),
      ...(extractString(payload, 'nextCursor') ? { nextCursor: extractString(payload, 'nextCursor') as string } : {}),
      facets: {
        tenants: facetOptions(facets.tenants),
        tags: facetOptions(facets.tags),
        professions: facetOptions(facets.professions),
        domains: facetOptions(facets.domains),
      },
    };
  }

  /**
   * The immutable snapshot a skill currently resolves to. An install records
   * `snapshotId` (and the archive digest) so the installed copy can later be
   * compared with the catalog; nothing else in the market API pins a revision.
   *
   * A response without the three identity fields is refused rather than
   * returned partially — a snapshot id that is absent is indistinguishable from
   * one that was never recorded, which is the state this call exists to end.
   */
  async getMarketplaceSkillSnapshot(id: string): Promise<MarketplaceSkillSnapshot> {
    const endpoint = `/v2/skills/${encodeURIComponent(id)}/releases/latest`;
    const { payload } = await this.fetchJson(endpoint, this.buildUrl(endpoint));
    if (!isRecord(payload)) {
      throw invalidResponse(endpoint, 'Skill release response must be an object');
    }
    const artifact = isRecord(payload.artifact) ? payload.artifact : {};
    const skillId = extractString(payload, 'skillId') ?? extractString(artifact, 'skillId');
    const snapshotId = extractString(payload, 'snapshotId') ?? extractString(artifact, 'snapshotId');
    const artifactId = extractString(payload, 'artifactId') ?? extractString(artifact, 'artifactId');
    if (!skillId || !snapshotId || !artifactId) {
      throw invalidResponse(endpoint, 'Skill release response must carry skillId, snapshotId and artifactId');
    }
    const sourceId = extractString(payload, 'sourceId') ?? extractString(artifact, 'sourceId');
    const contentDigest = extractString(artifact, 'contentDigest');
    const lifecycle = extractString(artifact, 'lifecycle');
    const sourceCommit = extractString(payload, 'sourceCommit');
    const sourceCommittedAt = extractString(payload, 'sourceCommittedAt');
    const filesPath = extractString(artifact, 'filesPath');
    const archive = archiveRef(artifact.archive);
    return {
      skillId,
      snapshotId,
      artifactId,
      ...(sourceId ? { sourceId } : {}),
      ...(contentDigest ? { contentDigest } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(sourceCommit ? { sourceCommit } : {}),
      ...(sourceCommittedAt ? { sourceCommittedAt } : {}),
      ...(filesPath ? { filesPath } : {}),
      ...(archive ? { archive } : {}),
    };
  }

  async getMarketplaceSkill(id: string): Promise<SkillDto> {
    const endpoint = `/v1/skills/${encodeURIComponent(id)}`;
    const { payload } = await this.fetchJson(endpoint, this.buildUrl(endpoint));
    if (!isRecord(payload)) {
      throw invalidResponse(endpoint, 'Marketplace skill detail response must be an object');
    }
    return payload as SkillDto;
  }

  /**
   * Fetch one skill's raw SKILL.md body (frontmatter + markdown) as text. Unlike
   * the JSON endpoints this returns the document verbatim, so it does its own
   * fetch instead of `fetchJson`. Throws a typed {@link MarketplaceClientError}
   * on network/HTTP failure so callers can fail soft.
   */
  async getMarketplaceSkillContent(id: string): Promise<string> {
    const endpoint = `/v1/skills/${encodeURIComponent(id)}/content`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(endpoint));
    } catch (error) {
      throw new MarketplaceClientError({
        code: 'network-error',
        endpoint,
        message: `Marketplace request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new MarketplaceClientError({
        code: 'http-error',
        endpoint,
        status: response.status,
        message: `Marketplace request failed for ${endpoint}: HTTP ${response.status}`,
      });
    }
    return response.text();
  }

  /**
   * A skill's whole file tree in ONE anonymous request, instead of a files
   * listing plus one request per file. Measured 2026-07-31 against
   * `/v1/skills/skl_v1_225cfdef…/archive.zip`: HTTP 200, `application/zip`,
   * 84899 bytes, and the response `ETag` equals the sha256 of the body.
   *
   * The v2 one-request variant that would need no unzip is broken server-side —
   * `/v2/skills/{id}/snapshots/{id}/files?content=inline` answers HTTP 503
   * "Skill artifact dependency is unavailable" for a multi-file snapshot — so
   * do not build on it.
   *
   * `expectedDigest` should come from {@link getMarketplaceSkillSnapshot}: a
   * digest read out of the SAME response only proves the transfer was not
   * corrupted, while one fetched independently pins which artifact arrived.
   * Both are checked; a mismatch throws rather than returning bytes.
   */
  async downloadMarketplaceSkillArchive(
    id: string,
    options: { expectedDigest?: string } = {},
  ): Promise<MarketplaceSkillArchiveDownload> {
    const endpoint = `/v1/skills/${encodeURIComponent(id)}/archive.zip`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(endpoint));
    } catch (error) {
      throw new MarketplaceClientError({
        code: 'network-error',
        endpoint,
        message: `Marketplace request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new MarketplaceClientError({
        code: 'http-error',
        endpoint,
        status: response.status,
        message: `Marketplace request failed for ${endpoint}: HTTP ${response.status}`,
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw invalidResponse(endpoint, 'Marketplace skill archive is empty');
    }
    const digest = await sha256Hex(bytes);
    const advertisedDigest = normalizeSha256(response.headers.get('etag'));
    const expectedDigest = normalizeSha256(options.expectedDigest);
    for (const candidate of [expectedDigest, advertisedDigest]) {
      if (candidate && candidate !== digest) {
        throw new MarketplaceClientError({
          code: 'digest-mismatch',
          endpoint,
          message: `Marketplace skill archive digest does not match the expected digest for ${endpoint}`,
        });
      }
    }
    const snapshotId = response.headers.get('x-skill-snapshot-id') ?? undefined;
    const artifactId = response.headers.get('x-skill-artifact-id') ?? undefined;
    return {
      bytes,
      digest,
      ...(advertisedDigest ? { advertisedDigest } : {}),
      ...(snapshotId ? { snapshotId } : {}),
      ...(artifactId ? { artifactId } : {}),
    };
  }

  /**
   * Tell the marketplace an install happened, so its own counters see desktop
   * installs at all — nothing in the repo called this endpoint, so every desktop
   * install was invisible to them.
   *
   * The endpoint takes NO request body; do not add one. It counts one daily
   * authenticated installation, so a second install on the same day answers
   * `counted: false` rather than failing, and an anonymous POST answers HTTP 401
   * (measured 2026-07-31) without counting anything.
   *
   * Fail-soft by construction: any network, HTTP or payload failure resolves to
   * `null`. A telemetry counter must never be able to fail an install, and
   * making that a property of the call keeps every caller from having to
   * remember it.
   */
  async reportSkillsRegistryInstallation(
    report: MarketplaceInstallationReport,
  ): Promise<MarketplaceInstallationReceipt | null> {
    const kind = report.kind ?? 'agent-skill';
    const endpoint = `/v2/registry/entries/${encodeURIComponent(kind)}/${encodeURIComponent(report.id)}/installations`;
    try {
      const response = await this.fetchImpl(this.buildUrl(endpoint), {
        method: 'POST',
        ...(report.accessToken ? { headers: { authorization: `Bearer ${report.accessToken}` } } : {}),
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.counted !== 'boolean') return null;
      return { counted: payload.counted, installCount: extractNumber(payload, 'installCount') ?? 0 };
    } catch {
      return null;
    }
  }

  async getMarketplacePlugin(id: string): Promise<PluginDto> {
    const endpoint = `/v1/plugins/${encodeURIComponent(id)}`;
    const { payload } = await this.fetchJson(endpoint, this.buildUrl(endpoint));
    if (!isRecord(payload)) {
      throw invalidResponse(endpoint, 'Marketplace plugin detail response must be an object');
    }
    return payload as PluginDto;
  }

  private buildUrl(endpoint: string): URL {
    return new URL(`${this.baseUrl}${endpoint}`);
  }

  private buildListUrl(
    endpoint: string,
    params: Required<Pick<MarketplaceListParams, 'page' | 'pageSize'>> & Omit<MarketplaceListParams, 'page' | 'pageSize'>,
    options: { includePluginKind: boolean },
  ): URL {
    const url = this.buildUrl(endpoint);
    if (params.query?.trim()) url.searchParams.set('q', params.query.trim());
    url.searchParams.set('page', String(params.page));
    url.searchParams.set('pageSize', String(params.pageSize));
    if (params.sort) url.searchParams.set('sort', params.sort);
    if (options.includePluginKind) url.searchParams.set('kind', 'nessy-extension');
    if (options.includePluginKind && params.capabilities?.length) {
      url.searchParams.set('capabilities', params.capabilities.join(','));
    }
    if (!options.includePluginKind) {
      // `/v1/skills` declares these as plain repeated parameters. The bracketed
      // `tenant[]`/`profession[]` spellings we used to send are silently ignored
      // by the server (measured 2026-07-31: `tenant[]=github-mirror` returns the
      // unfiltered 6084, `tenant=github-mirror` returns 1062). There is no
      // `phase` parameter at all, so `params.phases` is not put on the wire.
      if (params.domain?.trim()) url.searchParams.set('domain', params.domain.trim());
      if (params.subdomain?.trim()) url.searchParams.set('subdomain', params.subdomain.trim());
      if (params.withDescription) url.searchParams.set('withDescription', 'true');
      for (const profession of params.professions ?? []) url.searchParams.append('profession', profession);
      for (const tag of params.tags ?? []) url.searchParams.append('tag', tag);
      for (const tenant of params.tenants ?? []) url.searchParams.append('tenant', tenant);
    }
    return url;
  }

  private async fetchJson(endpoint: string, url: URL): Promise<{ payload: unknown; response: Response }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url);
    } catch (error) {
      throw new MarketplaceClientError({
        code: 'network-error',
        endpoint,
        message: `Marketplace request failed for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      });
    }

    if (!response.ok) {
      throw new MarketplaceClientError({
        code: 'http-error',
        endpoint,
        status: response.status,
        message: `Marketplace request failed for ${endpoint}: HTTP ${response.status}`,
      });
    }

    try {
      const payload = await response.json();
      if (payload === null || payload === undefined) {
        throw new SyntaxError('Missing JSON payload');
      }
      return { payload, response };
    } catch (error) {
      throw new MarketplaceClientError({
        code: 'invalid-json',
        endpoint,
        status: response.status,
        message: `Marketplace request returned invalid JSON for ${endpoint}`,
        cause: error,
      });
    }
  }
}

export function createSkillsMarketClient(options: MarketplaceClientOptions = {}): SkillsMarketClient {
  return new SkillsMarketClient(options);
}

function normalizeListParams(params: MarketplaceListParams): Required<Pick<MarketplaceListParams, 'page' | 'pageSize'>> & Omit<MarketplaceListParams, 'page' | 'pageSize'> {
  return {
    ...params,
    page: clampPositiveInteger(params.page, 1),
    pageSize: Math.min(clampPositiveInteger(params.pageSize, 20), SKILLS_MARKET_MAX_PAGE_SIZE),
  };
}

function createListResult<TItem>(options: {
  items: TItem[];
  page: number;
  pageSize: number;
  total: number;
  generatedAt?: string;
  raw: unknown;
}): MarketplaceRawListResult<TItem> {
  const visible = options.items.length;
  const nextPage = options.page * options.pageSize < options.total ? options.page + 1 : undefined;
  return {
    items: options.items,
    page: options.page,
    pageSize: options.pageSize,
    total: options.total,
    visible,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
    ...(nextPage ? { nextPage } : {}),
    raw: options.raw,
  };
}

function parseTotalCountHeader(headers: Headers): number | undefined {
  const value = headers.get('x-total-count') ?? headers.get('X-Total-Count');
  if (!value) return undefined;
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

function extractArray<TItem>(payload: unknown, keys: string[]): TItem[] | undefined {
  if (Array.isArray(payload)) return payload as TItem[];
  if (!isRecord(payload)) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value as TItem[];
  }
  return undefined;
}

function facetOptions(value: unknown): MarketplaceFacetOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    if (!isRecord(entry) || typeof entry.value !== 'string' || !entry.value) return [];
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0;
    return [{
      value: entry.value,
      title: typeof entry.title === 'string' && entry.title ? entry.title : entry.value,
      count,
    }];
  });
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Accept the digest in any of the spellings the API uses for the same value:
 * `sha256:<hex>` in a JSON body, a quoted (optionally weak) `<hex>` ETag.
 */
function normalizeSha256(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

function archiveRef(value: unknown): MarketplaceSkillArchiveRef | undefined {
  if (!isRecord(value)) return undefined;
  const digest = extractString(value, 'digest');
  const downloadPath = extractString(value, 'downloadPath');
  if (!digest || !downloadPath) return undefined;
  const size = extractNumber(value, 'size');
  const mediaType = extractString(value, 'mediaType');
  return {
    digest,
    downloadPath,
    ...(size === undefined ? {} : { size }),
    ...(mediaType ? { mediaType } : {}),
  };
}

/**
 * A catalog group with no id, no name or no usable variant cannot be browsed or
 * installed, so it is dropped rather than shown as an unusable row.
 */
function registryGroup(value: unknown): SkillsRegistryGroup | undefined {
  if (!isRecord(value)) return undefined;
  const groupId = extractString(value, 'groupId');
  const defaultVariantId = extractString(value, 'defaultVariantId');
  const display = isRecord(value.display) ? value.display : {};
  const name = extractString(display, 'name');
  if (!groupId || !defaultVariantId || !name) return undefined;
  const variants = Array.isArray(value.variants)
    ? value.variants.flatMap(entry => {
      const variant = registryVariant(entry);
      return variant ? [variant] : [];
    })
    : [];
  if (variants.length === 0) return undefined;
  const metrics = isRecord(value.metrics) ? value.metrics : {};
  return {
    groupId,
    name,
    ...(extractString(display, 'description') ? { description: extractString(display, 'description') as string } : {}),
    ...(extractString(display, 'author') ? { author: extractString(display, 'author') as string } : {}),
    defaultVariantId,
    installCount: extractNumber(metrics, 'install_count') ?? 0,
    variants,
  };
}

function registryVariant(value: unknown): SkillsRegistryVariant | undefined {
  if (!isRecord(value)) return undefined;
  const registryId = extractString(value, 'registryId');
  if (!registryId) return undefined;
  const entry = isRecord(value.entry) ? value.entry : {};
  const display = isRecord(entry.display) ? entry.display : {};
  const address = isRecord(entry.address) ? entry.address : {};
  const delivery = isRecord(entry.delivery) ? entry.delivery : {};
  return {
    registryId,
    name: extractString(display, 'name') ?? registryId,
    ...(extractString(display, 'description') ? { description: extractString(display, 'description') as string } : {}),
    ...(extractString(address, 'canonical') ? { canonicalAddress: extractString(address, 'canonical') as string } : {}),
    ...(extractString(delivery, 'installCommand')
      ? { installCommand: extractString(delivery, 'installCommand') as string }
      : {}),
    installable: delivery.installable === true,
    raw: value,
  };
}

function extractNumber(payload: unknown, key: string): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractString(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;
}

function invalidResponse(endpoint: string, message: string): MarketplaceClientError {
  return new MarketplaceClientError({
    code: 'invalid-response',
    endpoint,
    message: `${message} (${endpoint})`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
