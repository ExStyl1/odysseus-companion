/**
 * UA1.16 — the t-artifacts client: the ONE network target of the artifact
 * publishing chain (UA1.18 `publish_artifact`, UA1.19 the Published pages list,
 * UA1.23 Publish on previews, UA1.25 chat sharing, UA6.7 Publish on Pages).
 *
 * ## What the service is, and where each fact was read
 *
 * `https://t-artifacts.t-tech.team` — the internal artifact service the owner
 * named on 2026-09-23 (plan `2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md`
 * row UA1.16, spec §24). The service facts below were read from its source at
 * `14e402e` (`release-1.0.13`) by the 2026-09-23 research; the WIRE SHAPE (field
 * names, verbs, success statuses) was re-read on 2026-10-02 from the service's
 * own CLI, `@loyalty-personalization/artifact-publish@0.5.0` (`dist/cli.js`, the
 * copy in the local npm cache — read as evidence, nothing copied):
 *
 * - create `POST /api/artifacts`, update `PUT /api/artifacts/{id}` (200/201);
 *   both carry `{ content, content_type: 'html' | 'markdown', title?, emoji,
 *   description?, retention_days? }` — {@link PublishRequestBody}; the CLI's
 *   `slug` is not sent;
 * - `PATCH /api/artifacts/{id}` with `title` and/or `retention_days` (200);
 * - `DELETE /api/artifacts/{id}` (204); `GET /api/artifacts/mine` (200, an array);
 * - the answer carries `url`, `expires_at` (`null` = unlimited) and
 *   `retention_days`; an update WITHOUT `retention_days` keeps the old
 *   `expires_at` (`postgres_store.go` `Update`) — so this client never invents
 *   a default on an update;
 * - every call authorizes `Authorization: Bearer <dp auth print-token>`.
 *
 * ## Token custody — a stated product posture (plan UA1.16, OQ-22 (f))
 *
 * The bearer is the opaque `dp auth print-token` value: a platform-wide
 * credential sent to a third-party service, which resolves it through
 * devplatform `POST /api/v2/token-identity`. It is obtained by
 * `auth/dp/dp-api.ts` symbol `printToken` ON EVERY REQUEST and never cached,
 * held in one local for the duration of one `fetch`, and never logged, never
 * put in an error, a result or a cause. It is NEVER the Nestor JWT, never
 * anything read from `~/.nessy/dp_auth_creds.json`, and never
 * `ARTIFACT_AUTH_TOKEN` / `T_ARTIFACTS_TOKEN` from the environment. The move
 * to a delegated token (the service accepts RS256 delegated JWTs since
 * `022fead`) waits for dp to mint one.
 *
 * ## The fences, each one a refusal BEFORE the network
 *
 * 1. The origin is the module constant {@link T_ARTIFACTS_ORIGIN}. No env, no
 *    setting, no model argument moves it (`T_ARTIFACTS_ORIGIN` and the CLI's
 *    `ARTIFACT_SERVICE_URL` are deliberately not read). A `url` naming an
 *    update/delete target on any other origin is refused (`invalid`).
 * 2. Debug transports that print request headers — `BUN_CONFIG_VERBOSE_FETCH`
 *    set, or `NODE_DEBUG` naming `fetch`, `undici`, `http`, `http2`, `https` or
 *    a wildcard — would print the bearer: the request is refused (`network`,
 *    with the variable named).
 * 3. The managed network policy (`sandbox.network.deniedDomains`, and the
 *    managed allowlist when `allowManagedDomainsOnly` is on) is honoured
 *    (`policy`). `isDeniedNetworkTarget` is deliberately NOT applied: it denies
 *    10/8, and this host resolves to `10.219.171.192`.
 * 4. Only then the token: `undefined` → `needs-login`; a dp that is missing or
 *    did not start, or that failed → `dp-unavailable`; a dp that timed out or
 *    was cancelled → `network`. No `dp auth login`, no browser, no retry after
 *    a login — the needs-login card is the caller's.
 * 5. `fetch` with `redirect: 'error'`, so the Authorization header never
 *    follows a 3xx; a 3xx answered anyway (a fetch that ignores the option) is
 *    `network` too, with no second request. A 30 s budget per request.
 *
 * `fetch` is `globalThis.fetch` read AT CALL TIME, so the host network runtime
 * applies: the global undici dispatcher in Electron main
 * (`apps/electron/src/main/network-proxy.ts`) and the per-request `proxy`/`tls`
 * wrapper `nessy-server` installs (`config/network-runtime.ts`). A captured
 * reference taken at module load would bypass the server's wrapper.
 *
 * Logs carry the HTTP status and the error kind only — never headers, bodies,
 * URLs with ids, or the token.
 */
import type { DpExecOptions } from '../auth/dp/dp-api.ts';
import { printToken as dpPrintToken } from '../auth/dp/dp-api.ts';
import { resolveDpRuntime as dpResolveRuntime, type DpRuntimeRecord } from '../auth/dp/dp-binary.ts';
import { DpAuthError, DpAuthServiceError } from '../auth/dp/errors.ts';
import { matchesDomain } from '../config/network-address-guard.ts';
import { createLogger } from '../utils/debug.ts';

/** The one network target. A module constant on purpose — see the header. Defined in `origin.ts` (UA1.19: renderer-safe). */
import { T_ARTIFACTS_ORIGIN, isTArtifactsUrl } from './origin.ts';
export { T_ARTIFACTS_ORIGIN, isTArtifactsUrl };
const T_ARTIFACTS_HOST = new URL(T_ARTIFACTS_ORIGIN).hostname;

/** The service's content cap (`internal/artifact/artifact.go:38`), in bytes of UTF-8. */
export const MAX_ARTIFACT_CONTENT_BYTES = 16 * 1024 * 1024;

/** The service's default retention when `retention_days` is omitted on create (`retention.go:8-9`). */
export const DEFAULT_RETENTION_DAYS = 7;
/** The service's ceiling; `0` means unlimited. */
export const MAX_RETENTION_DAYS = 36_500;

/** Per-request budget (the service's own CLI uses the same 30 s). */
const REQUEST_TIMEOUT_MS = 30_000;
/** `dp auth print-token`'s budget, the same value `dp-api.ts` sizes against dp's startup hook. */
const PRINT_TOKEN_TIMEOUT_MS = 30_000;

const defaultLog = createLogger('t-artifacts');

/** Status codes and kinds only — the one shape a log line here may take. */
export interface ArtifactClientLog {
  info(message: string, detail: { status?: number; kind?: ArtifactClientErrorKind; method?: string }): void;
}

export type ArtifactClientErrorKind =
  | 'needs-login'
  | 'dp-unavailable'
  | 'forbidden'
  | 'policy'
  | 'gone'
  | 'too-large'
  | 'invalid'
  | 'network'
  | 'server';

/**
 * Every failure of the publishing chain, reduced to a kind the card can act on.
 * The message is a fixed sentence built here — it never quotes a response body,
 * a header or the token.
 */
export class ArtifactClientError extends Error {
  constructor(
    public readonly kind: ArtifactClientErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ArtifactClientError';
  }
}

export interface ArtifactRecord {
  id: string;
  url: string;
  title: string;
  /** ISO timestamp, or `null` when the artifact never expires (`retention_days: 0`). */
  expiresAt: string | null;
  retentionDays: number;
}

/** One row of `GET /api/artifacts/mine` — the record plus what the list shows. */
export interface OwnedArtifact extends ArtifactRecord {
  emoji?: string;
}

export type ArtifactContentType = 'html' | 'markdown';

/** What the host sends on create and update — already normalised (`normalize.ts`). */
export interface PublishRequest {
  content: string;
  contentType: ArtifactContentType;
  /** Already HTML-escaped by `normalize.ts`: the service writes it RAW into `<title>`. */
  title: string;
  /** 1–2 emoji code points, validated by `normalize.ts`: the service writes it RAW into the favicon SVG. */
  emoji: string;
  description?: string;
  /** Omitted on an update = the old expiry stays. Never defaulted here. */
  retentionDays?: number;
}

/** The exact wire body — `publishRequest` on the service side. */
export interface PublishRequestBody {
  content: string;
  content_type: ArtifactContentType;
  title: string;
  emoji: string;
  description?: string;
  retention_days?: number;
}

export interface ArtifactPatch {
  title?: string;
  retentionDays?: number;
}

/** An existing artifact: its id, or its link on {@link T_ARTIFACTS_ORIGIN}. */
export type ArtifactTarget = { id: string } | { url: string };

/** `sandbox.network` as the host composes it (`SessionManager` `sandboxSettings.network`). */
export interface ArtifactNetworkPolicy {
  deniedDomains?: readonly string[];
  allowedDomains?: readonly string[];
  allowManagedDomainsOnly?: boolean;
}

export type ArtifactFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TArtifactsClientOptions {
  /** Test seam. Production: `globalThis.fetch`, read at call time. */
  fetch?: ArtifactFetch;
  /** Test seam. Production: `auth/dp/dp-api.ts` `printToken`. */
  printToken?: (dpPath: string, opts?: DpExecOptions) => Promise<string | undefined>;
  /** Test seam. Production: `auth/dp/dp-binary.ts` `resolveDpRuntime`. */
  resolveDpRuntime?: () => DpRuntimeRecord;
  /** The environment the debug-transport fence reads. Production: `process.env` at call time. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Read at call time, so a policy change reaches a long-lived client. */
  networkPolicy?: () => ArtifactNetworkPolicy | undefined;
  signal?: AbortSignal;
  /** Test seam for the 30 s budget. */
  timeoutMs?: number;
  /** Test seam. Production: the `t-artifacts` debug logger. */
  log?: ArtifactClientLog;
}

export interface TArtifactsClient {
  createArtifact(request: PublishRequest): Promise<ArtifactRecord>;
  updateArtifact(target: ArtifactTarget, request: PublishRequest): Promise<ArtifactRecord>;
  listOwnedArtifacts(): Promise<OwnedArtifact[]>;
  patchArtifact(target: ArtifactTarget, patch: ArtifactPatch): Promise<ArtifactRecord>;
  deleteArtifact(target: ArtifactTarget): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for the registry, the tool and their tests)
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
/** Current ids are 22 characters, legacy ones 11; a link may append `-<slug>` (the service CLI's `extractId`). */
const CURRENT_ID_LENGTH = 22;
const LEGACY_ID_LENGTH = 11;

function idFromSegment(segment: string): string {
  if (segment.length > CURRENT_ID_LENGTH && segment[CURRENT_ID_LENGTH] === '-') return segment.slice(0, CURRENT_ID_LENGTH);
  if (segment.length === CURRENT_ID_LENGTH) return segment;
  if (segment.length > LEGACY_ID_LENGTH && segment[LEGACY_ID_LENGTH] === '-') return segment.slice(0, LEGACY_ID_LENGTH);
  return segment;
}

/**
 * The artifact id behind a target, or an `invalid` refusal. A `url` must be on
 * {@link T_ARTIFACTS_ORIGIN}; an id must be a plain token (no `/`, no `..`), so
 * nothing a model writes can steer the request path.
 */
export function resolveArtifactId(target: ArtifactTarget): string {
  let id: string;
  if ('url' in target) {
    if (!isTArtifactsUrl(target.url)) {
      throw new ArtifactClientError('invalid', `Only links on ${T_ARTIFACTS_ORIGIN} can be updated or deleted; publish a new page instead.`);
    }
    const segments = new URL(target.url).pathname.split('/').filter(Boolean);
    id = idFromSegment(segments.at(-1) ?? '');
  } else {
    id = target.id;
  }
  if (!ID_PATTERN.test(id)) {
    throw new ArtifactClientError('invalid', 'The artifact id is not a valid t-artifacts id.');
  }
  return id;
}

/** The managed-policy verdict for the one host, or `null` when allowed. */
export function artifactPolicyRefusal(policy: ArtifactNetworkPolicy | undefined): string | null {
  if (!policy) return null;
  const denied = (policy.deniedDomains ?? []).find(domain => matchesDomain(T_ARTIFACTS_HOST, domain));
  if (denied) return `${T_ARTIFACTS_HOST} is denied by sandbox.network.deniedDomains (${denied}), so nothing was published.`;
  if (policy.allowManagedDomainsOnly === true
    && !(policy.allowedDomains ?? []).some(domain => matchesDomain(T_ARTIFACTS_HOST, domain))) {
    return `${T_ARTIFACTS_HOST} is outside the managed domain allowlist (sandbox.network.allowManagedDomainsOnly), so nothing was published.`;
  }
  return null;
}

/** The debug-transport fence: the variable that would print the bearer, or `null`. */
export function headerLoggingTransportRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const verbose = env.BUN_CONFIG_VERBOSE_FETCH;
  if (verbose !== undefined && verbose.trim() !== '') {
    return 'BUN_CONFIG_VERBOSE_FETCH is set, and it prints request headers — including the dp token — to the log. Unset it and try again.';
  }
  const nodeDebug = env.NODE_DEBUG ?? '';
  const named = nodeDebug.split(/[\s,]+/).map(entry => entry.trim().toLowerCase()).filter(Boolean)
    .find(entry => /^(?:fetch|undici|http|http2|https)$/.test(entry) || entry.includes('*'));
  if (named) {
    return `NODE_DEBUG names "${named}", which can print request headers — including the dp token — to the log. Remove it and try again.`;
  }
  return null;
}

/** The exact POST/PUT body. Optional fields are absent, never `undefined`/`null`. */
export function buildPublishRequestBody(request: PublishRequest): PublishRequestBody {
  return {
    content: request.content,
    content_type: request.contentType,
    title: request.title,
    emoji: request.emoji,
    ...(request.description !== undefined && request.description !== '' ? { description: request.description } : {}),
    ...(request.retentionDays !== undefined ? { retention_days: request.retentionDays } : {}),
  };
}

function assertRetentionDays(days: number | undefined): void {
  if (days === undefined) return;
  if (!Number.isSafeInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    throw new ArtifactClientError('invalid', `retention_days must be an integer from 0 to ${MAX_RETENTION_DAYS} (0 = unlimited).`);
  }
}

function assertPublishRequest(request: PublishRequest): void {
  if (request.contentType !== 'html' && request.contentType !== 'markdown') {
    throw new ArtifactClientError('invalid', 'Only HTML and Markdown can be published.');
  }
  if (typeof request.title !== 'string' || request.title.trim() === '') {
    throw new ArtifactClientError('invalid', 'The page needs a title.');
  }
  if (typeof request.emoji !== 'string' || request.emoji === '') {
    throw new ArtifactClientError('invalid', 'The page needs an emoji.');
  }
  if (Buffer.byteLength(request.content, 'utf8') > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new ArtifactClientError('too-large', 'The page is larger than the 16 MiB the service accepts.');
  }
  assertRetentionDays(request.retentionDays);
}

/**
 * The service's answer → {@link ArtifactRecord}. A link on any other origin is a
 * `server` failure: the host never hands the model a link it did not expect.
 * `fallback` fills what an older server leaves out (the CLI's "retention:
 * unavailable on this server" case) — the PREVIOUS values on an update, the
 * requested or default ones on a create.
 */
export function parseArtifactRecord(
  value: unknown,
  fallback: { title: string; retentionDays: number; expiresAt?: string | null; id?: string },
): ArtifactRecord {
  if (typeof value !== 'object' || value === null) throw new ArtifactClientError('server', 'The service answered something that is not an artifact.');
  const body = value as Record<string, unknown>;
  const url = body.url;
  if (typeof url !== 'string' || !isTArtifactsUrl(url)) {
    throw new ArtifactClientError('server', `The service answered a link that is not on ${T_ARTIFACTS_ORIGIN}.`);
  }
  let id = typeof body.id === 'string' && ID_PATTERN.test(body.id) ? body.id : undefined;
  if (id === undefined) {
    try { id = resolveArtifactId({ url }); } catch { id = fallback.id; }
  }
  if (id === undefined) throw new ArtifactClientError('server', 'The service answered an artifact without an id.');
  const expiresAt = body.expires_at === null ? null
    : typeof body.expires_at === 'string' ? body.expires_at
      : fallback.expiresAt !== undefined ? fallback.expiresAt : null;
  const retentionDays = typeof body.retention_days === 'number' && Number.isSafeInteger(body.retention_days)
    ? body.retention_days : fallback.retentionDays;
  const title = typeof body.title === 'string' ? body.title : fallback.title;
  return { id, url, title, expiresAt, retentionDays };
}

function kindForStatus(status: number): ArtifactClientErrorKind {
  if (status === 401) return 'needs-login';
  if (status === 403) return 'forbidden';
  if (status === 404 || status === 410) return 'gone';
  if (status === 413) return 'too-large';
  if (status === 400 || status === 422) return 'invalid';
  if (status >= 300 && status < 400) return 'network';
  return 'server';
}

const STATUS_SENTENCE: Record<ArtifactClientErrorKind, string> = {
  'needs-login': 'dp is not signed in (the service answered 401). Sign in to dp and try again.',
  'dp-unavailable': 'dp could not be run, so no token was available.',
  forbidden: 'The service refused: this artifact belongs to another dp identity (403).',
  policy: 'The managed network policy does not allow this host.',
  gone: 'The artifact no longer exists or has expired (404). Publish a new page instead.',
  'too-large': 'The service refused the page as too large (413).',
  invalid: 'The service refused the request as invalid.',
  network: 'The service answered a redirect, which the client never follows with a token.',
  server: 'The service failed to answer.',
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export function createTArtifactsClient(options: TArtifactsClientOptions = {}): TArtifactsClient {
  const env = () => options.env ?? process.env;
  const doFetch: ArtifactFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const getToken = options.printToken ?? dpPrintToken;
  const resolveRuntime = options.resolveDpRuntime ?? (() => dpResolveRuntime());
  const log: ArtifactClientLog = options.log ?? defaultLog;

  /** Fences 2 and 3 — local, before dp is spawned. */
  function preflight(): void {
    const transport = headerLoggingTransportRefusal(env());
    if (transport) {
      log.info('request refused before sending', { kind: 'network' });
      throw new ArtifactClientError('network', transport);
    }
    const policy = artifactPolicyRefusal(options.networkPolicy?.());
    if (policy) {
      log.info('request refused before sending', { kind: 'policy' });
      throw new ArtifactClientError('policy', policy);
    }
  }

  /** Fence 4 — a fresh token for exactly one request. */
  async function bearer(): Promise<string> {
    let runtime: DpRuntimeRecord;
    try {
      runtime = resolveRuntime();
    } catch {
      log.info('dp not resolvable', { kind: 'dp-unavailable' });
      throw new ArtifactClientError('dp-unavailable', 'dp was not found, so no token was available. Install dp and try again.');
    }
    let token: string | undefined;
    try {
      token = await getToken(runtime.dpPath, {
        timeoutMs: PRINT_TOKEN_TIMEOUT_MS,
        ...(runtime.workdir !== undefined ? { workdir: runtime.workdir } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (error instanceof DpAuthServiceError
        && (error.code === DpAuthError.Timeout || error.code === DpAuthError.Cancelled)) {
        log.info('dp print-token did not finish', { kind: 'network' });
        throw new ArtifactClientError('network', 'dp did not hand over a token in time. Try again.');
      }
      log.info('dp print-token failed', { kind: 'dp-unavailable' });
      throw new ArtifactClientError('dp-unavailable', 'dp could not produce a token. Check that dp runs and try again.');
    }
    if (token === undefined || token === '') {
      log.info('dp print-token: needs login', { kind: 'needs-login' });
      throw new ArtifactClientError('needs-login', 'dp is not signed in. Sign in to dp and try again.');
    }
    return token;
  }

  /** Fences 1–5 around ONE request; answers the parsed JSON (or `undefined` for 204). */
  async function send(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown,
    expected: readonly number[],
  ): Promise<unknown> {
    preflight();
    const token = await bearer();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await doFetch(`${T_ARTIFACTS_ORIGIN}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal,
      });
    } catch {
      // A redirect under `redirect: 'error'`, a TLS/DNS failure, an abort: the
      // raw error is dropped — it can carry the request, and so the header.
      log.info('request failed', { kind: 'network', method });
      throw new ArtifactClientError('network', timeout.aborted
        ? 'The service did not answer within 30 seconds.'
        : 'The service could not be reached (network, TLS or a redirect).');
    }
    if (!expected.includes(response.status)) {
      const kind = kindForStatus(response.status);
      log.info('request refused by the service', { status: response.status, kind, method });
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactClientError(kind, STATUS_SENTENCE[kind], response.status);
    }
    log.info('request answered', { status: response.status, method });
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new ArtifactClientError('server', 'The service answered something that is not JSON.', response.status);
    }
  }

  return {
    async createArtifact(request) {
      assertPublishRequest(request);
      const answer = await send('POST', '/api/artifacts', buildPublishRequestBody(request), [200, 201]);
      return parseArtifactRecord(answer, {
        title: request.title,
        retentionDays: request.retentionDays ?? DEFAULT_RETENTION_DAYS,
      });
    },
    async updateArtifact(target, request) {
      const id = resolveArtifactId(target);
      assertPublishRequest(request);
      const answer = await send('PUT', `/api/artifacts/${id}`, buildPublishRequestBody(request), [200, 201]);
      // An update without `retention_days` keeps the old expiry; a server that
      // omits the fields leaves the caller's registry values in place (the
      // registry merges with `undefined` meaning "unchanged").
      return parseArtifactRecord(answer, {
        id,
        title: request.title,
        retentionDays: request.retentionDays ?? Number.NaN,
      });
    },
    async listOwnedArtifacts() {
      const answer = await send('GET', '/api/artifacts/mine', undefined, [200]);
      if (!Array.isArray(answer)) throw new ArtifactClientError('server', 'The service answered a list that is not an array.');
      const owned: OwnedArtifact[] = [];
      for (const item of answer) {
        try {
          const record = parseArtifactRecord(item, { title: '', retentionDays: Number.NaN });
          const emoji = (item as { emoji?: unknown }).emoji;
          owned.push(typeof emoji === 'string' ? { ...record, emoji } : record);
        } catch {
          // A row with a foreign or missing link is not shown; counted only.
          log.info('list row skipped', { kind: 'server' });
        }
      }
      return owned;
    },
    async patchArtifact(target, patch) {
      const id = resolveArtifactId(target);
      assertRetentionDays(patch.retentionDays);
      if (patch.title === undefined && patch.retentionDays === undefined) {
        throw new ArtifactClientError('invalid', 'Nothing to change: give a title or retention_days.');
      }
      const body = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.retentionDays !== undefined ? { retention_days: patch.retentionDays } : {}),
      };
      const answer = await send('PATCH', `/api/artifacts/${id}`, body, [200]);
      return parseArtifactRecord(answer, { id, title: patch.title ?? '', retentionDays: patch.retentionDays ?? Number.NaN });
    },
    async deleteArtifact(target) {
      const id = resolveArtifactId(target);
      await send('DELETE', `/api/artifacts/${id}`, undefined, [200, 204]);
    },
  };
}
