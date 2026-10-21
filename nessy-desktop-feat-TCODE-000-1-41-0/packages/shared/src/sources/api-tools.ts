/**
 * Dynamic API Tool Factory
 *
 * Creates a single flexible MCP tool per API configuration.
 * Each tool accepts { path, method, params } and auto-injects authentication.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ApiConfig } from './types.ts';
import { debug } from '../utils/debug.ts';
import { guardLargeResult } from '../utils/large-response.ts';
import { MAX_DOWNLOAD_SIZE, formatBytes } from '../utils/binary-detection.ts';
import type { ApiCredential, BasicAuthCredential } from './credential-manager.ts';
import { isMultiHeaderCredential } from './credential-manager.ts';
import { appendQueryAuth, buildApiAuthHeaders } from '@nessy-agent/session-tools-core/api-auth';

// Re-export for convenience
export type { ApiCredential, BasicAuthCredential } from './credential-manager.ts';

// Authorization header assembly lives with the rest of the shared auth logic
// (`@nessy-agent/session-tools-core/api-auth`, UB3.1: one builder for the runtime
// request path and the source_test validator, OSS #1067).
export { buildAuthorizationHeader } from '@nessy-agent/session-tools-core/api-auth';

/**
 * API credential source — either a static credential value or a function that
 * resolves one on demand.
 *
 * Static form: a string / BasicAuthCredential / MultiHeaderCredential captured
 * at tool creation time. Used for the legacy path and for public APIs (empty
 * string).
 *
 * Getter form: a function called before each request. Two return shapes are
 * supported:
 *   - `() => Promise<string>` — OAuth / renew-endpoint sources that always
 *     resolve to a non-null access token.
 *   - `() => Promise<ApiCredential | null>` — non-OAuth API sources that read
 *     the latest credential from the vault on every call. Null is returned
 *     when the user has not (yet) provided a credential.
 *
 * Using a getter is what makes mid-session credential updates take effect
 * without restarting the in-process tool.
 */
export type ApiCredentialSource =
  | ApiCredential
  | (() => Promise<string>)
  | (() => Promise<ApiCredential | null>);

/**
 * Type guard to check if credential is BasicAuthCredential.
 *
 * Kept local (byte-identical to `api-auth.ts`'s export, UB3.1): its only
 * consumer is F1.309's `apiCredentialSecretValues` below, and importing the
 * shared one here would shadow nothing but cost this file its documented
 * line-anchor discipline for nothing.
 */
function isBasicAuthCredential(cred: ApiCredential): cred is BasicAuthCredential {
  return typeof cred === 'object' && cred !== null && 'username' in cred && 'password' in cred;
}

/**
 * Type guard to check if credential source is a token getter function.
 * Both narrow shapes (Promise<string> and Promise<ApiCredential | null>) flow
 * through the same call site and are normalized by the caller.
 */
function isTokenGetter(
  cred: ApiCredentialSource
): cred is () => Promise<string> | Promise<ApiCredential | null> {
  return typeof cred === 'function';
}

/** Summarize callback type — typically agent.runMiniCompletion.bind(agent) */
export type SummarizeCallback = (prompt: string) => Promise<string | null>;


/**
 * Build headers for an API request, injecting authentication and default headers.
 *
 * Thin wrapper over the shared assembly in
 * `@nessy-agent/session-tools-core/api-auth` (UB3.1, OSS #1067), which source_test
 * uses as well, so validator and runtime cannot drift.
 */
export function buildHeaders(
  auth: ApiConfig['auth'],
  credential: ApiCredential,
  defaultHeaders?: Record<string, string>
): Record<string, string> {
  return buildApiAuthHeaders(auth, credential, defaultHeaders);
}

/**
 * Build the full URL for an API request
 */
function buildUrl(
  baseUrl: string,
  path: string,
  method: string,
  params: Record<string, unknown> | undefined,
  auth: ApiConfig['auth'],
  credential: ApiCredential
): string {
  // Normalize: remove trailing slash from baseUrl and ensure path starts with /
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let url = `${normalizedBase}${normalizedPath}`;

  // Query param auth (string credentials only), shared with source_test (UB3.1)
  url = appendQueryAuth(url, auth, credential);

  // Handle GET params in query string
  if (method === 'GET' && params && Object.keys(params).length > 0) {
    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        // Handle arrays and objects
        if (typeof value === 'object') {
          urlParams.append(key, JSON.stringify(value));
        } else {
          urlParams.append(key, String(value));
        }
      }
    }
    const queryString = urlParams.toString();
    if (queryString) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${queryString}`;
    }
  }

  return url;
}

/**
 * Build tool description from API config.
 *
 * The description is sent to the LLM with every request, so we keep it small
 * and point to `sources/{slug}/guide.md` for endpoint-specific detail. The
 * agent's PrerequisiteManager already blocks calls to this tool until the
 * guide has been Read in the current context window, so the guide always
 * lands in conversation history before the model can call anything — making
 * a duplicate copy here pure waste (and the cause of #683-style provider
 * rejections when guide.md is large).
 *
 * Exported only for unit testing; treat as internal.
 */
export function buildToolDescription(config: ApiConfig): string {
  // config.name is the source slug (set by SourceServerBuilder.buildApiConfig).
  let desc = `Make authenticated requests to the ${config.name} API (${config.baseUrl}).\n\n`;
  desc += `Authentication is handled automatically — pass path, method, and params.\n`;
  desc += `For non-JSON request bodies, use params: { _rawBody: "raw content", _contentType: "text/plain" }. The _rawBody value is sent as-is without JSON encoding.\n\n`;
  desc += `**Before the first call, Read the source guide at sources/${config.name}/guide.md** — `;
  desc += `it documents available endpoints, required params, and any quirks. The Read is required before the first call (enforced) and again after compaction.\n\n`;
  desc += `**Binary responses** (PDFs, images, archives) are auto-saved to the session downloads folder; reference the returned path when telling the user about downloaded files.`;

  if (config.docsUrl) {
    desc += `\n\nOfficial docs: ${config.docsUrl}`;
  }

  return desc;
}

/**
 * Create a single flexible MCP tool for an API configuration.
 * The tool accepts { path, method, params } and handles auth automatically.
 *
 * @param config - API configuration with documentation
 * @param credential - API credential source (string for API key/token, BasicAuthCredential for basic auth,
 *                     empty string for public APIs, or async function for OAuth token refresh)
 * @param sessionPath - Optional path to session folder for saving large responses
 * @returns SDK tool that can be included in an MCP server
 */
export function createApiTool(
  config: ApiConfig,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
) {
  const toolName = `api_${config.name}`;
  debug(`[api-tools] Creating flexible tool: ${toolName}`);

  const description = buildToolDescription(config);

  return tool(
    toolName,
    description,
    {
      path: z.string().describe('API endpoint path, e.g., "/search" or "/v1/completions"'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('HTTP method - check documentation for correct method per endpoint'),
      params: z.record(z.string(), z.unknown()).optional().describe('Request body (POST/PUT/PATCH) or query parameters (GET). For non-JSON bodies, pass { _rawBody: "raw string content", _contentType: "text/plain" } — _rawBody is sent as-is without JSON encoding, _contentType defaults to text/plain if omitted'),
      _intent: z.string().optional().describe('REQUIRED: Describe what you are trying to accomplish with this API call (1-2 sentences)'),
    },
    async (args) => {
      const { path, method, params, _intent } = args;
      let knownSecrets: string[] = []; // F1.309 — masked out of every error text below; see `apiCredentialSecretValues`
      try {
        // Resolve credential — if a getter, call it to get a fresh credential. A null result (vault has
        // nothing for this source) is normalized to an empty string; buildHeaders / buildUrl already
        // treat that as "no auth", letting the upstream API surface its own 401. Resolved HERE, once per
        // request, and passed RESOLVED: `executeApiRequest` takes the value as-is (no second getter call),
        // and the mask set below keeps covering every error text this handler returns — including a
        // `buildUrl` throw, which `executeApiRequest` does not wrap.
        const rawCredential = isTokenGetter(credential)
          ? await credential()
          : credential;
        const resolvedCredential: ApiCredential = rawCredential ?? '';
        knownSecrets = apiCredentialSecretValues(resolvedCredential);

        // UA12.63 — ONE fetch path: the request goes through `executeApiRequest`, the same path the
        // Pages action bridge's executor takes, so the agent tool and the bridge cannot drift. Its
        // F1.309 mask covers fetch refusals; the outer catch below covers everything else.
        const outcome = await executeApiRequest(config, resolvedCredential, { path, method, params });

        // Check for error responses first (errors are always text)
        if (!outcome.ok) {
          const text = maskKnownCredentialValues(outcome.buffer.toString('utf-8'), knownSecrets);
          debug(`[api-tools] ${config.name} error ${outcome.status}: ${text.substring(0, 200)}`);
          return {
            content: [{
              type: 'text' as const,
              text: `API Error ${outcome.status}: ${text}`,
            }],
            isError: true,
          };
        }

        // Centralized binary detection + large response handling
        if (sessionPath) {
          const guarded = await guardLargeResult(outcome.buffer, {
            sessionPath,
            toolName: `api_${config.name}`,
            input: params,
            intent: _intent,
            summarize,
          });
          if (guarded) {
            return { content: [{ type: 'text' as const, text: guarded }] };
          }
        }

        return { content: [{ type: 'text' as const, text: outcome.buffer.toString('utf-8') }] };
      } catch (error) {
        if (error instanceof ApiResponseTooLargeError) {
          // `executeApiRequest` refused an over-cap Content-Length before the body loaded; the
          // message is the static wording the inline path used to build here.
          return {
            content: [{ type: 'text' as const, text: error.message }],
            isError: true,
          };
        }
        const message = maskKnownCredentialValues(error instanceof Error ? error.message : 'Unknown error', knownSecrets);
        debug(`[api-tools] ${config.name} request failed: ${message}`);
        return {
          content: [{ type: 'text' as const, text: `Request failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

/**
 * Create an in-process MCP server with a single flexible API tool.
 *
 * @param config - API configuration
 * @param credential - API credential source (string for API key/token, BasicAuthCredential for basic auth,
 *                     empty string for public APIs, or async function for OAuth token refresh)
 * @param sessionPath - Optional path to session folder for saving large responses
 * @returns SDK MCP server that can be passed to query()
 */
export function createApiServer(
  config: ApiConfig,
  credential: ApiCredentialSource,
  sessionPath?: string,
  summarize?: SummarizeCallback
): ReturnType<typeof createSdkMcpServer> {
  debug(`[api-tools] Creating server for ${config.name}${sessionPath ? ` (session: ${sessionPath})` : ''}`);

  const apiTool = createApiTool(config, credential, sessionPath, summarize);

  return createSdkMcpServer({
    name: `api_${config.name}`,
    version: '1.0.0',
    tools: [apiTool],
  });
}

/**
 * F1.236 — the loggable form of an API-source request URL: origin + path, with
 * every query VALUE replaced and the query NAMES kept, so a debug line still
 * says which endpoint and which parameters were called.
 *
 * Why: the handler above logged the URL `buildUrl` returns, and for a
 * query-auth source that URL carries the key (`?api_key=…`); the header line
 * beside it logged `JSON.stringify` of every header (the bearer value, the Basic
 * `user:password`, a custom header credential) and the raw-body line the first
 * 200 characters of the body. Debug is on under `NESSY_DEBUG=1`, in a dev build
 * and under `NESSY_IS_PACKAGED=false` (`utils/debug.ts` → stderr, and main.log
 * through electron-log in the main process). The handler now logs this form of
 * the URL, header NAMES only, and the raw body's content type and LENGTH only.
 * `new URL` drops userinfo (`user:pass@host`) and the fragment from `origin` for
 * free; an unparseable input yields a fixed placeholder — never the raw string,
 * which is exactly the case where we cannot tell what it contains.
 *
 * UA12.13 — the local copy is folded onto `utils/redaction.ts`, the module this
 * block's "Adapted from craft-agents-oss v0.13.4" note named: the two spellings
 * are byte-equivalent (the copy's `[REDACTED]` literal IS `REDACTED_VALUE`), and
 * the "No helper in this tree fit" reason predates that module. The name is
 * imported and re-exported HERE, in place of the old copy, because the F1.236
 * boundary test reads it from this module and nothing above the lines the docs
 * cite may move. UB3.1 (2026-10-15, OSS #1067) moved the anchors when it deleted
 * the duplicated header-building bodies this row existed to remove: the docs'
 * (8, 284, 336) content now sits at (8, 229, 281) — the SDK import at :8 kept its
 * line, the guardLargeResult call the doc-sweep cites moved 284→229, and the
 * createApiServer tail 336→281.
 */
import { redactUrlForLog } from '../utils/redaction.ts';

export { redactUrlForLog };

/**
 * F1.309 (origin WJ-ee verifier F1.236-a, 2026-09-23) — every value of a
 * resolved credential that an error text could quote back: the string itself
 * (bearer, query and single-header auth), each value of a multi-header record,
 * and for Basic auth the password and the `user:password` pair, whose base64 is
 * what the header carries (`maskKnownCredentialValues` derives it). The
 * handler above masks these out of the fetch's error message and out of a 4xx
 * body before either reaches the debug log or the tool result the model reads —
 * bun refuses a header carrying a zero-width space, smart quotes or an LF with a
 * message that quotes the value, and an API may answer `invalid key: <key>`.
 */
export function apiCredentialSecretValues(credential: ApiCredential): string[] {
  if (typeof credential === 'string') return credential ? [credential] : [];
  if (isBasicAuthCredential(credential)) {
    return [credential.password, `${credential.username}:${credential.password}`];
  }
  if (isMultiHeaderCredential(credential)) {
    return Object.values(credential).filter((value): value is string => typeof value === 'string');
  }
  return [];
}

// F1.309 — imported at the end so no line the docs cite above moves (anchors
// re-derived at (8, 229, 281) by UB3.1, see the F1.236 docblock above).
import { maskKnownCredentialValues } from '../agent/tool-result-secret-scan.ts';

// ============================================================================
// UA9.2 — `executeApiRequest`, the fetch path the Pages action bridge's API executor takes (UA9.3 wires it).
//
// Copied from craft-agents-oss `v0.13.4:packages/shared/src/sources/api-tools.ts` L190–L297 (Apache-2.0) and
// appended here, below every line the docs cite — the P6.777 plan cell keeps its dated
// `:321`, a historical record of the 2026-09-08 measurement (anchors now (8, 229, 281) after UB3.1).
// UA12.63 re-routed
// `createApiTool`'s handler through it (upstream's shape, P-UAad-2): the agent tool and the Pages bridge
// take ONE fetch path. The handler still resolves the credential itself — once per request, passed
// RESOLVED — so its F1.309 mask set covers every error text it returns, including a `buildUrl` throw,
// which this function does not wrap; fetch refusals are masked here.
// ============================================================================

/** One API request as executed against a source's baseUrl */
export interface ApiRequestInput {
  /** Endpoint path under the source's baseUrl */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Request body (POST/PUT/PATCH) or query parameters (GET); supports _rawBody/_contentType */
  params?: Record<string, unknown>;
}

export interface ExecuteApiRequestOptions {
  /** Cancels the in-flight fetch when aborted */
  signal?: AbortSignal;
  /** Abort automatically after this many ms (composed with `signal`) */
  timeoutMs?: number;
}

/** Raw outcome of an API request (body not yet interpreted) */
export interface ApiRequestOutcome {
  /** True for 2xx responses */
  ok: boolean;
  status: number;
  /** Raw response body */
  buffer: Buffer;
  /** Response Content-Type header, when present */
  contentType: string | null;
}

/** Thrown before the body is loaded when Content-Length exceeds MAX_DOWNLOAD_SIZE */
export class ApiResponseTooLargeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`Response too large: ${formatBytes(sizeBytes)} exceeds ${formatBytes(MAX_DOWNLOAD_SIZE)} limit. Use a streaming download tool for large files.`);
    this.name = 'ApiResponseTooLargeError';
  }
}

/**
 * Execute one authenticated request against an API source.
 *
 * Credential resolution stays lazy (resolved here, never crossing a process/IPC boundary) and cancellation
 * works through `signal` / `timeoutMs`. Header VALUES and query values are never logged.
 *
 * @throws ApiResponseTooLargeError when Content-Length exceeds the download cap
 * @throws on network failure or abort (fetch semantics), its message masked of the credential's values
 */
export async function executeApiRequest(
  config: ApiConfig,
  credential: ApiCredentialSource,
  request: ApiRequestInput,
  options?: ExecuteApiRequestOptions,
): Promise<ApiRequestOutcome> {
  const { path, method, params } = request;

  // Resolve credential — if a getter, call it to get a fresh credential.
  // A null result (vault has nothing for this source) is normalized to an
  // empty string; buildHeaders / buildUrl already treat that as "no auth",
  // letting the upstream API surface its own 401.
  const rawCredential = isTokenGetter(credential)
    ? await credential()
    : credential;
  const resolvedCredential: ApiCredential = rawCredential ?? '';
  const knownSecrets = apiCredentialSecretValues(resolvedCredential);

  const url = buildUrl(config.baseUrl, path, method, params, config.auth, resolvedCredential);
  const headers = buildHeaders(config.auth, resolvedCredential, config.defaultHeaders);

  // Never log the full URL: for query-auth sources buildUrl embeds the
  // credential (`?api_key=…`), and GET params may carry sensitive values too.
  debug(`[api-tools] ${config.name}: ${method} ${redactUrlForLog(url)}`);

  // Compose caller signal with the timeout signal (either aborts the fetch)
  const signals: AbortSignal[] = [];
  if (options?.signal) signals.push(options.signal);
  if (options?.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));

  const fetchOptions: RequestInit = {
    method,
    headers,
    ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
  };

  // Add body for non-GET requests
  if (method !== 'GET' && params && Object.keys(params).length > 0) {
    // Support raw text bodies via _rawBody param (e.g., for endpoints expecting plain text)
    if (typeof params._rawBody === 'string') {
      fetchOptions.body = params._rawBody;
      (fetchOptions.headers as Record<string, string>)['Content-Type'] =
        typeof params._contentType === 'string' ? params._contentType : 'text/plain';
    } else {
      fetchOptions.body = JSON.stringify(params);
    }
  }

  // Header VALUES are never logged — Authorization and friends are live credentials.
  debug(`[api-tools] ${config.name}: headerNames=[${Object.keys(headers).join(', ')}], bodyLength=${fetchOptions.body ? String(fetchOptions.body).length : 0}`);

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (error) {
    // F1.309 — a fetch error can quote a header value back (bun refuses some characters by naming them).
    if (error instanceof Error) {
      const masked = maskKnownCredentialValues(error.message, knownSecrets);
      if (masked !== error.message) {
        const safe = new Error(masked);
        safe.name = error.name;
        throw safe;
      }
    }
    throw error;
  }

  // OOM safety: reject before loading into memory
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > MAX_DOWNLOAD_SIZE) {
      throw new ApiResponseTooLargeError(size);
    }
  }

  // Load response as raw buffer — callers handle binary detection
  const buffer = Buffer.from(await response.arrayBuffer());

  return {
    ok: response.ok,
    status: response.status,
    buffer,
    contentType: response.headers.get('content-type'),
  };
}
