/**
 * Source-independent OAuth core (C1 of the plugin-MCP capability-path plan).
 *
 * Operates over an OAuth-capable ENDPOINT — `{url, authType, oauthResource,
 * clientId, oauth?}` — optionally bound to an explicit `credentialId` naming
 * where its tokens live in the encrypted store. It owns the endpoint half of
 * the flow the Source model used to own end to end: prepare
 * (discovery/PKCE/dynamic client registration), exchange, expiry decisions and
 * refresh. It never reads or writes a Source record and never imports from
 * `sources/` — the caller supplies the endpoint fields and keeps custody of
 * where the resulting tokens are stored.
 *
 * `SourceCredentialManager` is the first caller (a source's MCP config is
 * projected into an endpoint descriptor; storage stays source-keyed). Plugin
 * MCP servers become the second caller without forking the auth stack
 * (ADR § 8 risk 1: "if the extraction is skipped and the flow is forked
 * instead, we end with two auth stacks — strictly worse than today").
 */

import {
  NessyOAuth,
  exchangeMcpOAuth,
  prepareMcpOAuth,
  type McpOAuthConfig,
  type OAuthTokens,
} from './oauth.ts';
import type {
  OAuthExchangeParams,
  OAuthExchangeResult,
  PreparedOAuthFlow,
} from './oauth-flow-types.ts';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';

/**
 * An OAuth-capable endpoint, described without any Source vocabulary.
 * `authType: 'bearer'` endpoints never run a flow — they only carry a stored
 * token — but share the descriptor so needs-auth aggregation can treat both
 * uniformly.
 */
export interface OAuthEndpointDescriptor {
  /** The protected endpoint URL (MCP http/sse URL, or an API base URL used for discovery). */
  url: string;
  /** How the endpoint authenticates. Only 'oauth' endpoints run a flow. */
  authType: 'oauth' | 'bearer';
  /** Explicit RFC 8707 protected-resource indicator; discovery prefers it over `url`. */
  oauthResource?: string;
  /** Pre-registered OAuth client id (skips dynamic client registration). */
  clientId?: string;
  /**
   * The documented `oauth` override object (`mcp.md:715`, `:735`):
   * `authServerMetadataUrl` replaces the discovery chain, `scopes` pins the
   * requested scope set. Non-secret admin levers.
   */
  oauth?: McpOAuthConfig;
}

/** An endpoint bound to the credential-store slot its tokens live in. */
export interface OAuthEndpointBinding extends OAuthEndpointDescriptor {
  credentialId: CredentialId;
}

/** Refresh proactively when a token is within this window of its expiry. */
export const ENDPOINT_CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when the stored token is past its expiry. A credential without
 * `expiresAt` never counts as expired (the refresh layer decides what to do
 * with unknown lifetimes).
 */
export function isEndpointCredentialExpired(
  credential: Pick<StoredCredential, 'expiresAt'>,
): boolean {
  if (!credential.expiresAt) return false;
  return Date.now() > credential.expiresAt;
}

/** True when the stored token is inside the proactive refresh window. */
export function endpointCredentialNeedsRefresh(
  credential: Pick<StoredCredential, 'expiresAt'>,
): boolean {
  if (!credential.expiresAt) return false;
  return Date.now() > credential.expiresAt - ENDPOINT_CREDENTIAL_REFRESH_WINDOW_MS;
}

/**
 * Prepare an OAuth flow for an endpoint (server-side): metadata discovery,
 * PKCE, optional dynamic client registration, auth-URL construction. No
 * browser, no callback server — the caller stores the returned flow and
 * forwards the auth URL.
 */
export async function prepareEndpointOAuth(
  endpoint: OAuthEndpointDescriptor,
  options: {
    callbackPort?: number;
    callbackUrl?: string;
    onLog?: (message: string) => void;
  },
): Promise<PreparedOAuthFlow> {
  return prepareMcpOAuth(endpoint.url, {
    callbackPort: options.callbackPort,
    callbackUrl: options.callbackUrl,
    clientId: endpoint.clientId,
    oauthResource: endpoint.oauthResource,
    ...(endpoint.oauth ? { oauth: endpoint.oauth } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
  });
}

/**
 * Exchange an authorization code for tokens (server-side). Pure endpoint
 * operation: the caller decides where the resulting tokens are stored.
 */
export async function exchangeEndpointOAuth(
  params: OAuthExchangeParams,
): Promise<OAuthExchangeResult> {
  return exchangeMcpOAuth(params);
}

/**
 * Refresh an endpoint's access token with its stored refresh token. Metadata
 * is rediscovered (honoring a configured `authServerMetadataUrl` override so a
 * token obtained through an internal proxy refreshes against the same chain).
 * Throws on failure — the caller owns needs-reauth marking and storage.
 */
export async function refreshEndpointOAuthToken(
  endpoint: OAuthEndpointDescriptor,
  refresh: { refreshToken: string; clientId: string },
): Promise<OAuthTokens> {
  const oauth = new NessyOAuth(
    {
      mcpUrl: endpoint.url,
      oauthResource: endpoint.oauthResource,
      ...(endpoint.oauth ? { oauth: endpoint.oauth } : {}),
    },
    {
      onStatus: () => {},
      onError: () => {},
    },
  );
  return oauth.refreshAccessToken(refresh.refreshToken, refresh.clientId);
}
