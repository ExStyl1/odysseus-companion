import { createServer, type Server } from 'http';
import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { openUrl } from '../utils/open-url.ts';
import { generateCallbackPage } from './callback-page.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';
import type { McpOAuthConfig } from '../agent/backend/types.ts';

export type { McpOAuthConfig };

export interface OAuthConfig {
  mcpUrl: string; // Full MCP URL including path (e.g., https://mcp.example.com/my/mcp)
  /** Explicit OAuth protected resource; may differ from the MCP transport URL. */
  oauthResource?: string;
  clientId?: string;
  /**
   * The server's documented `oauth` object (`mcp.md:715`, `:735`):
   * `authServerMetadataUrl` overrides the discovery chain, `scopes` pins the
   * requested scope set. Both are non-secret admin levers.
   */
  oauth?: McpOAuthConfig;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
}

export interface OAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

// Port range for OAuth callback server - tries ports sequentially until one is available
const CALLBACK_PORT_START = 8914;
const CALLBACK_PORT_END = 8924;
const CALLBACK_PATH = '/oauth/callback';
const CLIENT_NAME = 'Claude Code (Nessy Desktop)';
/** Bound discovery hop, including response-body consumption. */
const DISCOVERY_TIMEOUT_MS = 5000;
/** Bound DCR/token hop, including response-body consumption. */
const OAUTH_MUTATION_TIMEOUT_MS = 30_000;
/** OAuth metadata and token responses are small; cap them before parsing. */
const OAUTH_RESPONSE_MAX_BYTES = 256 * 1024;
/** Redirects are followed explicitly so every hop receives the same SSRF checks. */
const OAUTH_MAX_REDIRECTS = 5;
const OAUTH_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export type OAuthHostResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

type OAuthResolvedAddress = { address: string; family: number };
type OAuthPinnedFetch = (
  url: string,
  options: RequestInit,
  addresses: readonly OAuthResolvedAddress[],
) => Promise<Response>;

const defaultOAuthHostResolver: OAuthHostResolver = hostname => (
  lookup(hostname, { all: true, verbatim: true })
);

export interface OAuthNetworkDependencies {
  fetchImpl: OAuthPinnedFetch;
  resolveHost: OAuthHostResolver;
}

const PRODUCTION_OAUTH_NETWORK: OAuthNetworkDependencies = {
  fetchImpl: fetchOAuthUrlPinned,
  resolveHost: defaultOAuthHostResolver,
};
const oauthNetworkContext = new AsyncLocalStorage<OAuthNetworkDependencies>();

/** Explicit async-scoped dependency seam for unit tests; production never mutates globals. */
export function withOAuthNetworkDependenciesForTests<T>(
  dependencies: OAuthNetworkDependencies,
  action: () => T,
): T {
  return oauthNetworkContext.run(dependencies, action);
}

function currentOAuthNetwork(): OAuthNetworkDependencies {
  return oauthNetworkContext.getStore() ?? PRODUCTION_OAUTH_NETWORK;
}

/** Connect only to the already-validated address, keeping the URL host for Host/SNI — or through this process's proxy for the URL (UA12.201); exported for the tests. */
export async function fetchOAuthUrlPinned(
  urlString: string,
  options: RequestInit,
  addresses: readonly OAuthResolvedAddress[],
): Promise<Response> {
  const url = new URL(urlString); if (processFetchUsesProxy(url.href)) return await fetchOAuthUrlThroughProxy(urlString, options); // UA12.201
  const address = addresses[0];
  if (!address) throw new Error('OAuth request has no validated address');

  const body = options.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new Error('Unsupported OAuth request body');
  }
  const headers = new Headers(options.headers);
  headers.set('host', url.host);
  if (typeof body === 'string' && !headers.has('content-length')) {
    headers.set('content-length', String(Buffer.byteLength(body)));
  }
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });

  return await new Promise<Response>((resolve, reject) => {
    const request = httpsRequest({
      protocol: 'https:',
      hostname: normalizeIpLiteral(address.address),
      port: url.port ? Number(url.port) : 443,
      method: options.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: requestHeaders,
      signal: options.signal ?? undefined, ...pinnedOAuthTls(), // UA12.185, UA12.200
      ...(isIP(normalizeIpLiteral(url.hostname)) ? {} : { servername: url.hostname }),
    }, incoming => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item);
        } else if (value !== undefined) {
          responseHeaders.set(name, value);
        }
      }

      const status = incoming.statusCode ?? 500;
      const hasBody = options.method?.toUpperCase() !== 'HEAD'
        && status !== 204 && status !== 205 && status !== 304;
      if (!hasBody) incoming.resume();
      const responseBody = hasBody
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              incoming.once('end', () => controller.close());
              incoming.once('error', error => controller.error(error));
            },
            cancel() {
              incoming.destroy();
            },
          })
        : null;
      resolve(new Response(responseBody, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function cancelOAuthBody(
  body: { cancel(reason?: unknown): Promise<void> } | null | undefined,
): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort and must never extend the network deadline.
  }
}

async function readOAuthBodyBounded(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > OAUTH_RESPONSE_MAX_BYTES) {
    cancelOAuthBody(response.body);
    throw new Error(`OAuth response body exceeds ${OAUTH_RESPONSE_MAX_BYTES} bytes`);
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > OAUTH_RESPONSE_MAX_BYTES) {
        throw new Error(`OAuth response body exceeds ${OAUTH_RESPONSE_MAX_BYTES} bytes`);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    cancelOAuthBody(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function fetchOAuthResponse(
  url: string,
  options: RequestInit = {},
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  discardNonOkBody = false,
): Promise<{ response: Response; body: string }> {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const network = currentOAuthNetwork();

  try {
    let currentUrl = url;
    let currentOptions: RequestInit = { ...options };

    for (let redirectCount = 0; ; redirectCount += 1) {
      const currentCheck = await validateOAuthUrlForNetwork(
        currentUrl,
        network.resolveHost,
        controller.signal,
      );
      if (!currentCheck.safe) {
        throw new Error(`Unsafe OAuth URL rejected: ${currentCheck.reason}`);
      }

      const response = await network.fetchImpl(currentUrl, {
        ...currentOptions,
        redirect: 'manual',
        signal: controller.signal,
      }, currentCheck.addresses);
      if (!OAUTH_REDIRECT_STATUSES.has(response.status)) {
        if (discardNonOkBody && !response.ok) {
          cancelOAuthBody(response.body);
          return { response, body: '' };
        }
        // Keep the timer active until the body has been consumed. A server that
        // sends headers and then stalls cannot hold OAuth or the trust mutex open.
        const body = await readOAuthBodyBounded(response);
        return { response, body };
      }

      if (redirectCount >= OAUTH_MAX_REDIRECTS) {
        cancelOAuthBody(response.body);
        throw new Error(`OAuth redirect limit exceeded (${OAUTH_MAX_REDIRECTS})`);
      }
      const location = response.headers.get('location');
      if (!location) {
        cancelOAuthBody(response.body);
        throw new Error('OAuth redirect response is missing Location');
      }
      const nextUrl = new URL(location, currentUrl).toString();
      const nextCheck = isUrlSafeToFetch(nextUrl);
      if (!nextCheck.safe) {
        cancelOAuthBody(response.body);
        throw new Error(`Unsafe OAuth redirect rejected: ${nextCheck.reason}`);
      }

      const method = (currentOptions.method ?? 'GET').toUpperCase();
      const crossesOrigin = new URL(currentUrl).origin !== new URL(nextUrl).origin;
      if (crossesOrigin && method !== 'GET' && method !== 'HEAD') {
        cancelOAuthBody(response.body);
        throw new Error('Cross-origin OAuth mutation redirect rejected');
      }

      const headers = new Headers(currentOptions.headers);
      if (crossesOrigin) {
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete('proxy-authorization');
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        currentOptions = { ...currentOptions, method: 'GET', body: undefined, headers };
        headers.delete('content-length');
        headers.delete('content-type');
      } else {
        currentOptions = { ...currentOptions, headers };
      }
      cancelOAuthBody(response.body);
      currentUrl = nextUrl;
    }
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

function fetchOAuthDiscoveryResponse(
  url: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: string }> {
  return fetchOAuthResponse(url, options, DISCOVERY_TIMEOUT_MS, true);
}

/**
 * POST a token request. If the authorization server rejects the RFC 8707
 * `resource` parameter with `invalid_target` (RFC 8707 §2), retry once without
 * it (UB3.3, upstream OSS #1054): the MCP flow now sends a resource indicator
 * whenever the server declared one in its protected resource metadata, and
 * servers whose AS predates resource indicators must keep working. The
 * authorization step cannot be retried, but such servers ignore unknown
 * authorize parameters (RFC 6749 §3.1).
 */
async function postTokenRequest(
  tokenEndpoint: string,
  params: URLSearchParams,
  onStatus?: (message: string) => void,
): Promise<{ response: Response; body: string }> {
  const post = (p: URLSearchParams) =>
    fetchOAuthResponse(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p.toString(),
    }, OAUTH_MUTATION_TIMEOUT_MS);

  const first = await post(params);
  // `fetchOAuthResponse` has already read the body — classify from the string,
  // not from a clone of the consumed response.
  if (first.response.ok || !params.has('resource') || !isInvalidTargetBody(first.body)) {
    return first;
  }

  onStatus?.('Authorization server rejected the resource indicator (invalid_target); retrying without it');
  const withoutResource = new URLSearchParams(params);
  withoutResource.delete('resource');
  return post(withoutResource);
}

/** True when an OAuth error body is an `invalid_target` error (RFC 8707 §2). */
function isInvalidTargetBody(body: string): boolean {
  try {
    const data = JSON.parse(body) as { error?: unknown } | null;
    return data?.error === 'invalid_target';
  } catch {
    return false;
  }
}

/**
 * Canonicalize an MCP server URL into a resource identifier suitable for the
 * RFC 8707 `resource` parameter: an absolute URI with no fragment (UB3.3,
 * upstream OSS #1054).
 *
 * Exported as the derived-fallback audience helper; the flows themselves send
 * `resource` only when the server declared one in its protected resource
 * metadata (RFC 9728) or the operator set an explicit override — a derived
 * fallback on the wire breaks servers (e.g. Azure v1) that reject an unexpected
 * `resource` parameter.
 */
export function canonicalResourceIdentifier(mcpUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return undefined;
  }

  // RFC 8707 §2: the resource URI MUST NOT include a fragment component, and
  // query parameters should be stripped to avoid leaking embedded secrets
  // (e.g. ?apiKey=…) into the AS access log and browser address bar.
  url.hash = '';
  url.search = '';

  // Normalize a bare root path away so `https://host/` and `https://host`
  // produce the same identifier.
  const canonical = url.toString();
  return url.pathname === '/' && !url.search ? normalizeUrl(canonical) : canonical;
}

function parseOAuthJson<T>(body: string, context: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
}

// Generate PKCE code verifier and challenge
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// Generate random state for CSRF protection
function generateState(): string {
  return randomBytes(16).toString('hex');
}

export class NessyOAuth {
  private config: OAuthConfig;
  private server: Server | null = null;
  private callbacks: OAuthCallbacks;
  private sessionContext?: OAuthSessionContext;

  constructor(config: OAuthConfig, callbacks: OAuthCallbacks, sessionContext?: OAuthSessionContext) {
    this.config = config;
    this.callbacks = callbacks;
    this.sessionContext = sessionContext;
  }

  // Get OAuth server metadata using progressive discovery, or the configured
  // `authServerMetadataUrl` alone when the server entry names one.
  private async getServerMetadata(): Promise<OAuthMetadata> {
    const metadata = await discoverOAuthMetadata(
      this.config.oauthResource ?? this.config.mcpUrl,
      (msg) => this.callbacks.onStatus(msg),
      this.config.oauth,
    );

    if (!metadata) {
      throw new Error(`No OAuth metadata found for ${this.config.mcpUrl}`);
    }

    return metadata;
  }

  // Register OAuth client dynamically
  private async registerClient(registrationEndpoint: string, port: number): Promise<{
    client_id: string;
    client_secret?: string;
  }> {
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    const { response, body } = await fetchOAuthResponse(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none', // Public client
      }),
    }, OAUTH_MUTATION_TIMEOUT_MS);

    if (!response.ok) {
      throw new Error(`Failed to register OAuth client: ${body}`);
    }

    return parseOAuthJson<{
      client_id: string;
      client_secret?: string;
    }>(body, 'OAuth client registration');
  }

  // Exchange authorization code for tokens
  private async exchangeCodeForTokens(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
    clientId: string,
    port: number,
    resource?: string
  ): Promise<OAuthTokens> {
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    // RFC 8707 §2.2 (UB3.3) — keep the token request scoped to the same resource
    // the authorization request carried.
    if (resource) {
      params.set('resource', resource);
    }

    const { response, body } = await postTokenRequest(tokenEndpoint, params, (m) => this.callbacks.onStatus(m));

    if (!response.ok) {
      throw new Error(`Failed to exchange code for tokens: ${body}`);
    }

    const data = parseOAuthJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    }>(body, 'OAuth token endpoint');

    // Default to 3600s (1 hour) if server doesn't return expires_in.
    // Most OAuth access tokens expire in 1 hour per RFC 6749.
    // Without this, tokens with no expiresAt are never detected as needing refresh.
    const expiresIn = data.expires_in ?? 3600;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // Refresh access token
  async refreshAccessToken(
    refreshToken: string,
    clientId: string,
    clientSecret?: string,
  ): Promise<OAuthTokens> {
    const metadata = await this.getServerMetadata();

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    // Same hole as the code exchange: a confidential client has to authenticate
    // the refresh grant too, or the first silent renewal fails the same way.
    if (clientSecret) params.set('client_secret', clientSecret);
    // RFC 8707 §2.2 (UB3.3): refreshed tokens must carry the same audience. The
    // explicit `oauthResource` override wins; otherwise only the resource the
    // server declared in its protected resource metadata is sent — a derived
    // fallback breaks servers (e.g. Azure v1) that treat an unexpected
    // `resource` as `invalid_request` with no retry path on refresh.
    const resource = this.config.oauthResource ?? metadata.resource;
    if (resource) {
      params.set('resource', resource);
    }

    const { response, body } = await postTokenRequest(metadata.token_endpoint, params, (m) => this.callbacks.onStatus(m));

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    const data = parseOAuthJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    }>(body, 'OAuth refresh endpoint');

    const expiresIn = data.expires_in ?? 3600;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      tokenType: data.token_type || 'Bearer',
    };
  }

  // Check if the MCP server requires OAuth
  async checkAuthRequired(): Promise<boolean> {
    this.callbacks.onStatus('Checking if authentication is required...');

    try {
      const metadata = await discoverOAuthMetadata(
        this.config.oauthResource ?? this.config.mcpUrl,
        (msg) => this.callbacks.onStatus(msg),
        this.config.oauth,
      );

      if (metadata) {
        this.callbacks.onStatus('OAuth required - server has OAuth metadata');
        return true;
      }

      // No metadata found at any candidate URL
      this.callbacks.onStatus('No OAuth metadata found - server may be public');
      return false;
    } catch (error) {
      this.callbacks.onStatus('Could not reach OAuth metadata - assuming public');
      return false;
    }
  }

  // Start the OAuth flow
  async authenticate(): Promise<{ tokens: OAuthTokens; clientId: string }> {
    this.callbacks.onStatus('Fetching OAuth server configuration...');

    // 1. Get server metadata — no port dependency
    let metadata;
    try {
      metadata = await this.getServerMetadata();
      this.callbacks.onStatus(`Found OAuth endpoints at ${this.config.mcpUrl}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to get OAuth metadata: ${msg}`);
      throw error;
    }

    // 2. Generate PKCE and state — no dependencies
    const pkce = generatePKCE();
    const state = generateState();
    this.callbacks.onStatus('Generated PKCE challenge and state');

    // 3. Start callback server — binds directly with retry, returns the bound port.
    //    This must happen before client registration because the redirect_uri
    //    includes the port, and we need the *actually bound* port (not a checked-
    //    then-released one) to avoid a TOCTOU race condition.
    this.callbacks.onStatus('Starting callback server...');
    let port: number;
    let codePromise: Promise<string>;
    try {
      const server = await this.startCallbackServer(state);
      port = server.port;
      codePromise = server.codePromise;
      this.callbacks.onStatus(`Callback server listening on port ${port}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.callbacks.onStatus(`Failed to start callback server: ${msg}`);
      throw error;
    }

    // 4. Register client if endpoint available — now has the bound port
    let clientId: string;
    if (this.config.clientId) {
      clientId = this.config.clientId;
      this.callbacks.onStatus(`Using configured client ID: ${clientId}`);
    } else if (metadata.registration_endpoint) {
      this.callbacks.onStatus(`Registering client at ${metadata.registration_endpoint}...`);
      try {
        const client = await this.registerClient(metadata.registration_endpoint, port);
        clientId = client.client_id;
        this.callbacks.onStatus(`Registered as client: ${clientId}`);
      } catch (error) {
        // Clean up the callback server if registration fails
        this.stopServer();
        const msg = error instanceof Error ? error.message : 'Unknown error';
        this.callbacks.onStatus(`Client registration failed: ${msg}`);
        throw error;
      }
    } else {
      // Use a default client ID for public clients
      clientId = 'nessy-general-agent';
      this.callbacks.onStatus(`Using default client ID: ${clientId}`);
    }

    // 5. Build authorization URL
    const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    // RFC 8707 resource indicator (UB3.3, upstream OSS #1054) — required by
    // resource-bound MCP servers so the issued token is audience-scoped to this
    // MCP endpoint. The explicit `oauthResource` override wins; otherwise only
    // the resource the server declared in PRM is sent — a derived fallback
    // breaks servers (e.g. Azure v1) that reject an unexpected `resource`.
    const resource = this.config.oauthResource ?? metadata.resource;
    if (resource) {
      authUrl.searchParams.set('resource', resource);
      this.callbacks.onStatus(`Scoping authorization to resource: ${resource}`);
    }
    const scopeDecision = resolveMcpOAuthScopes(metadata, this.config.oauth);
    logScopeDecision(scopeDecision, (msg) => this.callbacks.onStatus(msg));
    if (scopeDecision.scope) authUrl.searchParams.set('scope', scopeDecision.scope);

    // 6. Open browser for authorization
    this.callbacks.onStatus('Opening browser for authorization...');
    await openUrl(authUrl.toString());

    // 7. Wait for the authorization code
    this.callbacks.onStatus('Waiting for you to authorize in browser...');
    const authCode = await codePromise;
    this.callbacks.onStatus('Authorization code received!');

    // 8. Exchange code for tokens
    this.callbacks.onStatus('Exchanging authorization code for tokens...');
    const tokens = await this.exchangeCodeForTokens(
      metadata.token_endpoint,
      authCode,
      pkce.verifier,
      clientId,
      port,
      resource
    );
    this.callbacks.onStatus('Tokens received successfully!');

    return { tokens, clientId };
  }

  /**
   * Start the OAuth callback server by binding directly to a port in the range
   * CALLBACK_PORT_START .. CALLBACK_PORT_END.
   *
   * Eliminates the TOCTOU race condition: the port returned is the port the
   * server is actually listening on — there is no gap between checking and
   * binding. On EADDRINUSE the candidate server is closed and the next port
   * is tried.
   *
   * Returns immediately once the server is bound, with a `codePromise` that
   * resolves when the OAuth callback delivers the authorization code.
   */
  private async startCallbackServer(
    expectedState: string
  ): Promise<{ port: number; codePromise: Promise<string> }> {
    // Set up the deferred code promise — resolved/rejected by the request handler
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const timeout = setTimeout(() => {
      this.stopServer();
      rejectCode(new Error('OAuth timeout - no callback received'));
    }, 300000); // 5 minute timeout

    // Try binding on each candidate port in the range
    for (let port = CALLBACK_PORT_START; port <= CALLBACK_PORT_END; port++) {
      const candidate = createServer((req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname === CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: error,
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error(`OAuth error: ${error}`));
            return;
          }

          if (state !== expectedState) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateCallbackPage({
              title: 'Security Error',
              isSuccess: false,
              errorDetail: 'State mismatch - possible CSRF attack.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('OAuth state mismatch'));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateCallbackPage({
              title: 'Authorization Failed',
              isSuccess: false,
              errorDetail: 'No authorization code received.',
            }));
            clearTimeout(timeout);
            this.stopServer();
            rejectCode(new Error('No authorization code'));
            return;
          }

          // Success!
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(generateCallbackPage({
            title: 'Authorization Successful',
            isSuccess: true,
            deeplinkUrl: buildOAuthDeeplinkUrl(this.sessionContext),
          }));

          clearTimeout(timeout);
          this.stopServer();
          resolveCode(code);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          candidate.once('error', reject);
          candidate.listen(port, 'localhost', () => {
            candidate.removeListener('error', reject);
            resolve();
          });
        });

        // Bind succeeded — keep this server
        this.server = candidate;
        this.server.on('error', (err) => {
          clearTimeout(timeout);
          rejectCode(new Error(`Callback server error: ${err.message}`));
        });
        return { port, codePromise };
      } catch (err: unknown) {
        // Port in use — close the candidate and try the next one
        candidate.close();
        const isAddressInUse =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
        if (!isAddressInUse) {
          // Unexpected error — clean up and propagate
          clearTimeout(timeout);
          throw err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    // All ports exhausted
    clearTimeout(timeout);
    throw new Error(
      `All OAuth callback ports (${CALLBACK_PORT_START}-${CALLBACK_PORT_END}) are in use. Please restart the application.`
    );
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // Cancel the OAuth flow
  cancel(): void {
    this.stopServer();
  }
}

/**
 * Register an MCP OAuth client dynamically.
 * Extracted from NessyOAuth.registerClient for reuse in prepareMcpOAuth.
 */
class McpClientRegistrationError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpClientRegistrationError';
    this.status = status;
  }
}

function shouldFallbackToDefaultMcpClient(error: unknown): boolean {
  return error instanceof McpClientRegistrationError && (error.status === 401 || error.status === 403);
}

async function registerMcpOAuthClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
  try {
    const { response, body } = await fetchOAuthResponse(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    }, OAUTH_MUTATION_TIMEOUT_MS);
    if (!response.ok) {
      throw new McpClientRegistrationError(
        `Failed to register OAuth client: ${body}`,
        response.status,
      );
    }
    return parseOAuthJson<{ client_id: string; client_secret?: string }>(
      body,
      'MCP OAuth client registration',
    );
  } catch (error) {
    if (error instanceof McpClientRegistrationError) throw error;
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${message}`);
  }
}

/**
 * Exchange an MCP authorization code for tokens (standalone, no class instance needed).
 */
async function exchangeMcpCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  oauthResource?: string,
  clientSecret?: string,
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (oauthResource) params.set('resource', oauthResource);
  // D5 live find (2026-08-14): a CONFIDENTIAL client must authenticate at the
  // token endpoint, and this function used to have no way to. Figma's AS
  // advertises only `client_secret_basic`/`client_secret_post` — no `'none'` —
  // so its dynamically registered client is confidential by construction, and
  // every exchange came back `{"error":"Client secret is required"}` while the
  // browser half looked perfect. `client_secret_post` (RFC 6749 §2.3.1) keeps
  // PKCE intact; a public client sends nothing extra, exactly as before.
  if (clientSecret) params.set('client_secret', clientSecret);

  // UB3.3 — an `invalid_target` here means the AS predates RFC 8707 although the
  // server published PRM; postTokenRequest retries once without the parameter.
  const { response, body } = await postTokenRequest(tokenEndpoint, params);

  if (!response.ok) {
    throw new Error(`Failed to exchange code for tokens: ${body}`);
  }

  const data = parseOAuthJson<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  }>(body, 'MCP OAuth token endpoint');

  const expiresIn = data.expires_in ?? 3600;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: data.token_type || 'Bearer',
  };
}

/** What {@link resolveMcpOAuthScopes} decided, and why. */
export interface McpOAuthScopeDecision {
  /** The `scope` parameter value, or `undefined` to send no `scope` at all. */
  scope?: string;
  /** Pinned scopes the authorization server does not advertise; never requested. */
  unadvertised: string[];
  /** True when `offline_access` was appended because the server advertises it. */
  offlineAccessAppended: boolean;
}

/**
 * Resolve the `scope` parameter of an authorization request.
 *
 * `mcp.md:735`: "Set `oauth.scopes` to pin the scopes Claude Code requests
 * during the authorization flow. This is the supported way to restrict an MCP
 * server to a security-team-approved subset when the upstream authorization
 * server advertises more scopes than you want to grant."
 *
 * `:751`: "`oauth.scopes` takes precedence over both `authServerMetadataUrl` and
 * the scopes the server discovers at `/.well-known`."
 *
 * `:753`: metadata fetched from a configured `authServerMetadataUrl` "still
 * supplies its `scopes_supported` as the requested scopes", and with nothing
 * pinned and nothing advertised, no `scope` parameter is sent at all.
 *
 * `:755`: "If the authorization server advertises `offline_access` in
 * `scopes_supported`, Claude Code appends it to the pinned scopes so the access
 * token can be refreshed without a new browser sign-in."
 *
 * THE NARROWING RULE, which is ours and not the doc's. A pinned scope the
 * server does not advertise is dropped from the request and reported: this
 * field exists to restrict a grant, so it must never be the reason a scope is
 * asked for. Requesting an unadvertised scope also gets the whole authorization
 * rejected with `invalid_scope` by strict identity providers, which turns a
 * config typo into a login that cannot succeed and gives no hint why. A server
 * that advertises no `scopes_supported` at all has said nothing to contradict,
 * so the pinned set is sent as written.
 */
export function resolveMcpOAuthScopes(
  metadata: OAuthMetadata,
  overrides?: McpOAuthConfig,
): McpOAuthScopeDecision {
  const advertised = metadata.scopes_supported;
  const pinned = overrides?.scopes?.trim()
    ? overrides.scopes.trim().split(/\s+/)
    : undefined;

  if (!pinned) {
    // Nothing pinned: a configured metadata URL supplies its own scopes (`:753`),
    // and otherwise no `scope` parameter is sent.
    const fromMetadata = overrides?.authServerMetadataUrl && advertised?.length
      ? advertised.join(' ')
      : undefined;
    return { ...(fromMetadata ? { scope: fromMetadata } : {}), unadvertised: [], offlineAccessAppended: false };
  }

  const unadvertised = advertised ? pinned.filter(scope => !advertised.includes(scope)) : [];
  const granted = advertised ? pinned.filter(scope => advertised.includes(scope)) : [...pinned];
  const offlineAccessAppended = !!advertised
    && advertised.includes('offline_access')
    && !granted.includes('offline_access');
  if (offlineAccessAppended) granted.push('offline_access');

  return {
    ...(granted.length > 0 ? { scope: granted.join(' ') } : {}),
    unadvertised,
    offlineAccessAppended,
  };
}

/** One operator-facing line per scope decision; never carries a token or code. */
function logScopeDecision(
  decision: McpOAuthScopeDecision,
  onLog: ((message: string) => void) | undefined,
): void {
  if (!onLog) return;
  if (decision.unadvertised.length > 0) {
    onLog(`oauth.scopes names ${decision.unadvertised.length} scope(s) the authorization server does not advertise; they were not requested: ${decision.unadvertised.join(' ')}`);
  }
  if (decision.offlineAccessAppended) {
    onLog('Appended offline_access to the pinned scopes (advertised by the authorization server)');
  }
  if (decision.scope) onLog(`Requesting scope: ${decision.scope}`);
}

/**
 * Prepare an MCP OAuth flow without starting a callback server or opening a browser.
 *
 * Performs metadata discovery, PKCE generation, optional client registration,
 * and auth URL construction. Accepts either callbackPort (Electron) or
 * callbackUrl (WebUI) to construct the redirect URI.
 */
export async function prepareMcpOAuth(
  mcpUrl: string,
  options: {
    callbackPort?: number;
    callbackUrl?: string;
    clientId?: string;
    oauthResource?: string;
    /** The server entry's documented `oauth` object (`mcp.md:715`, `:735`). */
    oauth?: McpOAuthConfig;
    onLog?: (message: string) => void;
  },
): Promise<PreparedOAuthFlow> {
  const discoveryTarget = options.oauthResource ?? mcpUrl;
  const metadata = await discoverOAuthMetadata(discoveryTarget, options.onLog, options.oauth);
  if (!metadata) {
    throw new Error(`No OAuth metadata found for ${discoveryTarget}`);
  }

  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}${CALLBACK_PATH}`;

  let clientId: string;
  let clientSecret: string | undefined;
  if (options.clientId) {
    clientId = options.clientId;
  } else if (metadata.registration_endpoint) {
    try {
      const client = await registerMcpOAuthClient(metadata.registration_endpoint, redirectUri);
      clientId = client.client_id;
      clientSecret = client.client_secret;
    } catch (error) {
      if (!shouldFallbackToDefaultMcpClient(error)) {
        throw error;
      }

      // Dynamic client registration can be intentionally gated by providers
      // (for example returning 403 for unapproved clients). In that case,
      // fall back to a default client ID and proceed with the flow.
      clientId = 'nessy-general-agent';
    }
  } else {
    clientId = 'nessy-general-agent';
  }

  // RFC 8707 resource indicator (UB3.3, upstream OSS #1054): the canonical
  // identifier the server declared in its protected resource metadata, with the
  // explicit `oauthResource` override winning. Only a DECLARED or configured
  // resource is sent — a derived fallback (the MCP URL itself) breaks servers
  // that reject an unexpected `resource` on authorize with no retry path.
  const resource = options.oauthResource ?? metadata.resource;

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  if (resource) authUrl.searchParams.set('resource', resource);
  const scopeDecision = resolveMcpOAuthScopes(metadata, options.oauth);
  logScopeDecision(scopeDecision, options.onLog);
  if (scopeDecision.scope) authUrl.searchParams.set('scope', scopeDecision.scope);

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    clientSecret,
    redirectUri,
    // The flow's resource is the EFFECTIVE one (explicit override or the
    // PRM-declared identifier): RFC 8707 §2.2 requires the token step to repeat
    // exactly what the authorization step carried.
    ...(resource ? { oauthResource: resource } : {}),
    provider: 'mcp',
  };
}

/**
 * Exchange an MCP authorization code for tokens (server-side).
 */
export async function exchangeMcpOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeMcpCodeForTokens(
      params.tokenEndpoint,
      params.code,
      params.codeVerifier,
      params.clientId,
      params.redirectUri,
      params.oauthResource,
      params.clientSecret,
    );

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      oauthClientId: params.clientId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'MCP OAuth exchange failed',
    };
  }
}

/**
 * Extract the origin (scheme + host + port) from an MCP URL.
 * This is the base URL for OAuth discovery per RFC 8414.
 */
export function getMcpBaseUrl(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    // If URL parsing fails, return as-is and let caller handle it
    return mcpUrl;
  }
}

export interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  /**
   * Canonical resource identifier of the protected resource (RFC 9728 `resource`,
   * UB3.3). Sent as the `resource` parameter in authorization/token/refresh
   * requests per RFC 8707 so the issued token is audience-scoped to this MCP
   * server. Only set when discovery went through protected resource metadata.
   */
  resource?: string;
  /**
   * RFC 8414 `scopes_supported`. Carried so a pinned `oauth.scopes` can be
   * checked against what the authorization server actually advertises, and so a
   * configured `authServerMetadataUrl` can supply the requested scopes itself
   * (`mcp.md:731`, `:753`).
   */
  scopes_supported?: string[];
}

async function validateOAuthMetadata(
  data: unknown,
  resolver: OAuthHostResolver,
  signal: AbortSignal,
): Promise<{ metadata?: OAuthMetadata; reason?: string }> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { reason: 'response is not an object' };
  }
  const candidate = data as Record<string, unknown>;
  const endpointNames = ['authorization_endpoint', 'token_endpoint'] as const;
  for (const endpointName of endpointNames) {
    const endpoint = candidate[endpointName];
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      return { reason: `missing ${endpointName}` };
    }
    const endpointCheck = await validateOAuthUrlForNetwork(endpoint, resolver, signal);
    if (!endpointCheck.safe) {
      return { reason: `unsafe ${endpointName}: ${endpointCheck.reason}` };
    }
  }
  const registrationEndpoint = candidate.registration_endpoint;
  if (registrationEndpoint !== undefined) {
    if (typeof registrationEndpoint !== 'string' || !registrationEndpoint.trim()) {
      return { reason: 'invalid registration_endpoint' };
    }
    const endpointCheck = await validateOAuthUrlForNetwork(registrationEndpoint, resolver, signal);
    if (!endpointCheck.safe) {
      return { reason: `unsafe registration_endpoint: ${endpointCheck.reason}` };
    }
  }
  const scopesSupported = Array.isArray(candidate.scopes_supported)
    ? candidate.scopes_supported.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0)
    : undefined;
  return {
    metadata: {
      authorization_endpoint: candidate.authorization_endpoint as string,
      token_endpoint: candidate.token_endpoint as string,
      ...(typeof registrationEndpoint === 'string'
        ? { registration_endpoint: registrationEndpoint }
        : {}),
      ...(scopesSupported && scopesSupported.length > 0 ? { scopes_supported: scopesSupported } : {}),
    },
  };
}

/**
 * Try to fetch OAuth authorization server metadata from a specific URL.
 * Returns the metadata if successful, null if not found or error.
 */
async function tryFetchAuthServerMetadata(
  url: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying: ${url}`);
    const { response, body } = await fetchOAuthDiscoveryResponse(url);
    if (response.ok) {
      const data = parseOAuthJson<unknown>(body, 'OAuth metadata endpoint');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
      let validated: Awaited<ReturnType<typeof validateOAuthMetadata>>;
      try {
        validated = await validateOAuthMetadata(
          data,
          currentOAuthNetwork().resolveHost,
          controller.signal,
        );
      } finally {
        clearTimeout(timeoutId);
      }
      if (validated.metadata) {
        onLog?.(`  ✓ Found OAuth metadata at ${url}`);
        return validated.metadata;
      }
      onLog?.(`  ✗ Invalid metadata at ${url} (${validated.reason})`);
    } else {
      onLog?.(`  ✗ ${response.status} at ${url}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onLog?.(`  ✗ Error fetching ${url}: ${msg}`);
  }
  return null;
}

/**
 * Protected resource metadata per RFC 9728
 */
interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

/**
 * Check if a URL is safe to fetch (SSRF protection).
 * Rejects private IPs, localhost, and non-HTTPS URLs.
 */
function isUrlSafeToFetch(urlString: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: 'Invalid URL' };
  }

  // Must be HTTPS (allow HTTP only for localhost in dev)
  if (url.protocol !== 'https:') {
    return { safe: false, reason: 'URL must use HTTPS' };
  }

  const hostname = normalizeIpLiteral(url.hostname.toLowerCase());

  // Block localhost variants
  if (hostname === 'localhost') {
    return { safe: false, reason: 'Localhost not allowed' };
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    return { safe: false, reason: 'Non-public IP address not allowed' };
  }

  return { safe: true };
}

/**
 * Resolve hostnames before every OAuth request/redirect/metadata endpoint and
 * reject the whole host if any A/AAAA answer is non-public. Every resolution
 * is bounded, including the production resolver and explicitly injected tests.
 */
export async function validateOAuthUrlForNetwork(
  urlString: string,
  resolver: OAuthHostResolver = defaultOAuthHostResolver,
  upstreamSignal?: AbortSignal,
): Promise<
  | { safe: true; addresses: OAuthResolvedAddress[] }
  | { safe: false; reason?: string }
> {
  const syntacticCheck = isUrlSafeToFetch(urlString);
  if (!syntacticCheck.safe) return { safe: false, reason: syntacticCheck.reason };

  const hostname = normalizeIpLiteral(new URL(urlString).hostname.toLowerCase());
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    return { safe: true, addresses: [{ address: hostname, family: literalFamily }] };
  }

  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort();
  if (upstreamSignal?.aborted) controller.abort();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timeoutId = upstreamSignal
    ? undefined
    : setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolveOAuthHost(resolver, hostname, controller.signal);
  } catch (error) {
    return {
      safe: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'OAuth hostname resolution timed out'
        : 'OAuth hostname could not be resolved safely',
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
  if (!addresses.length) {
    return { safe: false, reason: 'OAuth hostname resolved without addresses' };
  }
  const unsafe = addresses.find(({ address }) => !isPublicIpAddress(normalizeIpLiteral(address)));
  return unsafe
    ? { safe: false, reason: `OAuth hostname resolved to non-public address ${unsafe.address}` }
    : {
        safe: true,
        addresses: addresses.map(({ address, family }) => ({
          address: normalizeIpLiteral(address),
          family,
        })),
      };
}

async function resolveOAuthHost(
  resolver: OAuthHostResolver,
  hostname: string,
  signal: AbortSignal,
): Promise<Array<{ address: string; family: number }>> {
  if (signal.aborted) throw createOAuthAbortError();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      callback: () => void,
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(createOAuthAbortError()));
    signal.addEventListener('abort', onAbort, { once: true });

    void resolver(hostname).then(
      addresses => finish(() => resolve(addresses)),
      error => finish(() => reject(error)),
    );
  });
}

function createOAuthAbortError(): Error {
  const error = new Error('OAuth hostname resolution aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeIpLiteral(value: string): string {
  const unbracketed = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  const zoneIndex = unbracketed.indexOf('%');
  return (zoneIndex >= 0 ? unbracketed.slice(0, zoneIndex) : unbracketed).toLowerCase();
}

function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const value = ipv6ToBigInt(address);
  if (value === undefined || value === 0n || value === 1n) return false;
  // IPv4-mapped IPv6 (::ffff:0:0/96) must inherit the embedded IPv4 policy.
  if ((value >> 32n) === 0xffffn) {
    const embedded = Number(value & 0xffff_ffffn);
    return isPublicIpv4([
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ].join('.'));
  }
  if ((value >> 121n) === 0x7en) return false; // fc00::/7 unique-local
  if ((value >> 118n) === 0x3fan) return false; // fe80::/10 link-local
  if ((value >> 120n) === 0xffn) return false; // ff00::/8 multicast
  if ((value >> 96n) === 0x20010db8n) return false; // documentation
  // Current globally routable unicast space. Reject transition/special ranges
  // rather than guessing how they map an embedded private destination.
  return (value >> 125n) === 0x1n; // 2000::/3
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  );
}

function ipv6ToBigInt(address: string): bigint | undefined {
  let normalized = address;
  const dottedIndex = normalized.lastIndexOf(':');
  if (normalized.includes('.') && dottedIndex >= 0) {
    const ipv4 = normalized.slice(dottedIndex + 1);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return undefined;
    const parts = ipv4.split('.').map(Number);
    if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    normalized = `${normalized.slice(0, dottedIndex)}:${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return undefined;
  const groups = halves.length === 2
    ? [...left, ...Array.from({ length: omitted }, () => '0'), ...right]
    : left;
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

/**
 * Type guard for ProtectedResourceMetadata
 */
function isProtectedResourceMetadata(data: unknown): data is ProtectedResourceMetadata {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;

  // resource is required
  if (typeof obj.resource !== 'string') return false;

  // authorization_servers is optional but must be string array if present
  if (obj.authorization_servers !== undefined) {
    if (!Array.isArray(obj.authorization_servers)) return false;
    if (!obj.authorization_servers.every(s => typeof s === 'string')) return false;
  }

  return true;
}

/**
 * Normalize URL by removing trailing slash
 */
function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Parse the resource_metadata URL from a WWW-Authenticate header.
 * Example header: Bearer error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource/path"
 * Supports both double and single quoted values per RFC 7235.
 */
function parseResourceMetadataFromHeader(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;

  // Look for resource_metadata="..." or resource_metadata='...' in the header
  // Also handles optional spaces around the equals sign
  const match = wwwAuthenticate.match(/resource_metadata\s*=\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

/**
 * Fetch protected resource metadata and return the authorization server URL.
 * Per RFC 9728, the protected resource metadata contains authorization_servers array.
 */
async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  onLog?: (message: string) => void
): Promise<{ authorizationServer: string; resource: string } | null> {
  // SSRF protection: validate URL before fetching
  const urlCheck = isUrlSafeToFetch(metadataUrl);
  if (!urlCheck.safe) {
    onLog?.(`  ✗ Unsafe URL rejected: ${urlCheck.reason}`);
    return null;
  }

  try {
    onLog?.(`  Fetching protected resource metadata...`);
    const { response, body } = await fetchOAuthDiscoveryResponse(metadataUrl);
    if (!response.ok) {
      onLog?.(`  ✗ ${response.status} at metadata endpoint`);
      return null;
    }

    const data: unknown = parseOAuthJson(body, 'OAuth protected resource metadata endpoint');

    // Type guard validation
    if (!isProtectedResourceMetadata(data)) {
      onLog?.(`  ✗ Invalid protected resource metadata format`);
      return null;
    }

    // Check for non-empty authorization_servers array
    if (!data.authorization_servers?.length) {
      onLog?.(`  ✗ No authorization_servers in protected resource metadata`);
      return null;
    }

    const authServer = data.authorization_servers[0]!;

    // Validate the auth server URL too
    const authServerCheck = isUrlSafeToFetch(authServer);
    if (!authServerCheck.safe) {
      onLog?.(`  ✗ Unsafe authorization server URL rejected: ${authServerCheck.reason}`);
      return null;
    }

    onLog?.(`  ✓ Found authorization server`);
    return { authorizationServer: authServer, resource: data.resource };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      onLog?.(`  ✗ Request timeout fetching protected resource metadata`);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      onLog?.(`  ✗ Error fetching protected resource metadata: ${msg}`);
    }
    return null;
  }
}

/**
 * Try to discover OAuth metadata via RFC 9728 flow:
 * 1. Make a request to the MCP endpoint to get 401 with WWW-Authenticate header
 * 2. Parse resource_metadata URL from the header
 * 3. Fetch protected resource metadata
 * 4. Get authorization server URL and fetch its metadata
 */
async function discoverViaProtectedResource(
  mcpUrl: string,
  onLog?: (message: string) => void
): Promise<OAuthMetadata | null> {
  try {
    onLog?.(`  Trying RFC 9728 protected resource discovery...`);

    // Make a request to the MCP endpoint to trigger 401
    // Try HEAD first, fall back to GET, then POST (Streamable HTTP servers only accept POST)
    let response: Response;
    try {
      response = (await fetchOAuthDiscoveryResponse(mcpUrl, { method: 'HEAD' })).response;
      // Some servers don't support HEAD, fall back to GET
      if (response.status === 405) {
        onLog?.(`  HEAD not supported, trying GET...`);
        response = (await fetchOAuthDiscoveryResponse(mcpUrl, { method: 'GET' })).response;
      }
      // Streamable HTTP MCP servers only accept POST.
      // POST is not a safe HTTP method, but this is acceptable here:
      // 1. We only proceed if the response is 401 (all other statuses are ignored)
      // 2. The endpoint is user-configured and trusted by design
      // 3. The body '{}' is a no-op for JSON-RPC servers (missing required fields)
      if (response.status === 405) {
        onLog?.(`  GET not supported, trying POST...`);
        response = (await fetchOAuthDiscoveryResponse(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })).response;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        onLog?.(`  ✗ Request timeout`);
      }
      return null;
    }

    // We expect a 401 with WWW-Authenticate header
    if (response.status !== 401) {
      onLog?.(`  ✗ Expected 401, got ${response.status}`);
      return null;
    }

    const wwwAuth = response.headers.get('www-authenticate');
    const resourceMetadataUrl = parseResourceMetadataFromHeader(wwwAuth);

    if (!resourceMetadataUrl) {
      onLog?.(`  ✗ No resource_metadata in WWW-Authenticate header`);
      return null;
    }

    // SSRF protection: validate the resource_metadata URL
    const urlCheck = isUrlSafeToFetch(resourceMetadataUrl);
    if (!urlCheck.safe) {
      onLog?.(`  ✗ Unsafe resource_metadata URL rejected: ${urlCheck.reason}`);
      return null;
    }

    onLog?.(`  Found resource_metadata hint`);

    // Fetch protected resource metadata to get authorization server
    // Fetch protected resource metadata to get authorization server + resource id
    const prm = await fetchProtectedResourceMetadata(resourceMetadataUrl, onLog);
    if (!prm) {
      return null;
    }

    // Fetch authorization server metadata (normalize URL to avoid double slashes)
    const normalizedAuthServer = normalizeUrl(prm.authorizationServer);
    const authServerMetadataUrl = `${normalizedAuthServer}/.well-known/oauth-authorization-server`;
    const metadata = await tryFetchAuthServerMetadata(authServerMetadataUrl, onLog);
    if (!metadata) {
      return null;
    }
    // Carry the canonical resource identifier so the authorization and token
    // requests can be audience-scoped to this resource (RFC 8707, UB3.3).
    return { ...metadata, resource: prm.resource };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onLog?.(`  ✗ RFC 9728 discovery failed: ${msg}`);
    return null;
  }
}

/**
 * Discovers OAuth metadata using progressive discovery per RFC 8414 and RFC 9728.
 * Returns the first successful metadata, or null if all fail.
 *
 * Discovery order:
 * 1. RFC 9728: Parse resource_metadata from WWW-Authenticate header on 401
 * 2. Origin root: `{origin}/.well-known/oauth-authorization-server`
 * 3. Path-scoped: `{origin}/.well-known/oauth-authorization-server{pathname}`
 */
export async function discoverOAuthMetadata(
  mcpUrl: string,
  onLog?: (message: string) => void,
  overrides?: McpOAuthConfig,
): Promise<OAuthMetadata | null> {
  // `mcp.md:713`: "Point Claude Code at a specific OAuth authorization server
  // metadata URL to BYPASS the default discovery chain" (emphasis ours). An
  // override that fell back to the well-known chain would not be one — an
  // operator pointing at an internal proxy must not silently reach the public
  // endpoints when the proxy is down, so this returns null instead.
  const configuredMetadataUrl = overrides?.authServerMetadataUrl;
  if (configuredMetadataUrl) {
    onLog?.(`Using configured authServerMetadataUrl (discovery chain bypassed)`);
    const metadata = await tryFetchAuthServerMetadata(configuredMetadataUrl, onLog);
    if (!metadata) {
      onLog?.(`  ✗ Configured authServerMetadataUrl returned no usable metadata`);
    }
    return metadata;
  }

  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    onLog?.(`Invalid MCP URL: ${mcpUrl}`);
    return null;
  }

  onLog?.(`Discovering OAuth metadata for ${mcpUrl}`);

  // 1. Try RFC 9728 protected resource discovery first (handles Nessy MCP and other compliant servers)
  const rfc9728Metadata = await discoverViaProtectedResource(mcpUrl, onLog);
  if (rfc9728Metadata) {
    return rfc9728Metadata;
  }

  // 2. Fall back to RFC 8414 discovery locations
  const candidates = [
    // Origin root (most common for MCP servers)
    `${url.origin}/.well-known/oauth-authorization-server`,
    // Path-scoped (RFC 8414 allows this)
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
  ];

  for (const candidate of candidates) {
    const metadata = await tryFetchAuthServerMetadata(candidate, onLog);
    if (metadata) {
      return metadata;
    }
  }

  onLog?.(`No OAuth metadata found for ${mcpUrl}`);
  return null;
}

/**
 * UA12.185 — the pinned request verifies against this process's COMPOSED CA trust, the set its own `fetch` uses
 * (the Electron main's undici dispatcher, the headless server's fetch wrapper; `processCaTrust`): the Custom CA
 * setting, the bundled corporate CA and a managed `NODE_EXTRA_CA_CERTS`, beside the bundled Mozilla set and the
 * OS store as `certStore` says. `node:https` reaches neither of those, so before this the request trusted Node's
 * defaults alone, and its only corporate-CA path was a startup `NODE_EXTRA_CA_CERTS` — which the desktop binary's
 * `nodeOptions` fuse stops since UA12.22. `ca` is the COMPLETE set (it replaces the defaults, as the dispatcher's
 * does); with nothing composed the request keeps the runtime's default trust.
 *
 * UA12.200 — and it presents the client identity those same requests present (`processClientIdentity`: the
 * Settings `clientCertPath` / `clientKeyPath`, a managed `CLAUDE_CODE_CLIENT_CERT` / `_KEY`, and on the desktop the
 * environment's), so an authorization server or a proxy that requires a client certificate no longer refuses MCP
 * sign-in alone. A server that never requests a certificate ignores it, as the dispatcher's direct agent relies on.
 */
function pinnedOAuthTls(): { ca?: string[]; cert?: string; key?: string; passphrase?: string; rejectUnauthorized: boolean } {
  const ca = processCaTrust();
  const identity = processClientIdentity();
  return {
    // Verification is FORCED: the ambient `NODE_TLS_REJECT_UNAUTHORIZED=0` debug override
    // (read once at launch — Bun 1.3.14) must not silently disable it for the request that
    // carries OAuth credentials; the option wins over that env (measured 2026-10-10:
    // default → 200 against a throwaway self-signed server, explicit true →
    // DEPTH_ZERO_SELF_SIGNED_CERT). With nothing composed the trust set is unchanged.
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    ...(identity
      ? { cert: identity.cert, key: identity.key, ...(identity.passphrase ? { passphrase: identity.passphrase } : {}) }
      : {}),
  };
}
import { processCaTrust } from '../config/network-tls-ca.ts';
import { processClientIdentity } from '../config/network-mtls.ts';

/**
 * UA12.201 (DECIDED 2026-10-09, native-first) — when this process's own `fetch` would send the URL through a proxy
 * (`processFetchUsesProxy`: a managed `env` block's proxy, then Settings, then the environment, minus `NO_PROXY`),
 * the MCP OAuth request goes the same way: through that `fetch`, so the proxy is reached by HOST NAME (CONNECT) with
 * the process's composed CA set and client identity (the Electron main's undici dispatcher, the headless fetch
 * wrapper) — instead of a direct connection that a proxy-only network drops.
 *
 * Read first: Claude Code's own contract is that it "respects standard proxy environment variables"
 * (`network-config.md#proxy-configuration`), with no exception for MCP sign-in; in the shipped 2.1.274 binary the
 * MCP SDK's OAuth discovery (the `oauth-protected-resource` readers) takes a `fetch` parameter defaulting to the
 * global one, and no address pin was found beside it. So behind a proxy Claude Code's MCP sign-in goes through it.
 *
 * What the pin means then: the SSRF checks before this call (`validateOAuthUrlForNetwork`: every A/AAAA answer
 * must be public) still run on THIS machine's resolution, and a name that resolves to a private address is still
 * refused; but the proxy resolves the name itself and connects to whatever it finds. The pin is moot behind a
 * proxy the operator configured and trusts — the proxy is the egress policy there. Stated residue: a network
 * whose local resolver cannot answer the authorization server's name (proxy-side DNS only) still fails those
 * checks before any request; relaxing them is a safety trade this row does not take. Redirects stay manual (the
 * caller's `redirect: 'manual'`), so every hop is checked as before; the caller's deadline signal applies.
 */
async function fetchOAuthUrlThroughProxy(urlString: string, options: RequestInit): Promise<Response> {
  return await fetch(urlString, options);
}
import { processFetchUsesProxy } from '../config/network-proxy-utils.ts';
