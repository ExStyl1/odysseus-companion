/**
 * ChatGPT OAuth with PKCE
 *
 * Implements PKCE-based OAuth for authenticating with ChatGPT Plus accounts
 * via the Codex app-server OAuth endpoint.
 *
 * Architecture: server-owned flow.
 *   - prepareChatGptOAuth() — server generates PKCE + auth URL
 *   - Client opens browser + runs callback server (port 1455)
 *   - exchangeChatGptTokens() — server exchanges code for tokens
 *   - refreshChatGptTokens() — server refreshes expired tokens
 *
 * ## What this fork does NOT do, recorded so it is not re-derived (D1.195)
 *
 * A fourth function came in with the original seed and was REMOVED on
 * 2026-09-17: `exchangeIdTokenForApiKey`, an RFC 8693 token exchange turning the
 * `id_token` into a first-class OpenAI API key. It had **zero readers across
 * `packages` and `apps`** for the whole life of this fork — its three siblings
 * above all have live ones — and `git log -S` puts it in the `craft-agents-oss`
 * seed, so it was inherited rather than reserved.
 *
 * It is gone rather than documented-in-place because of what it was: an
 * untested, unexercised POST of a user's `id_token` to a third-party token
 * endpoint, exported from a shared auth module, for a path this product does not
 * take — the session uses the `accessToken` these functions already return, and
 * `pi-agent.ts` refreshes it through `refreshChatGptTokens`. Dead code that
 * reaches the network is not neutral.
 *
 * The FACT is kept here because deleting the knowledge is the other failure: if
 * the ChatGPT card is ever finished and an API key is genuinely wanted, this is
 * the grant to implement (`urn:ietf:params:oauth:grant-type:token-exchange`,
 * `subject_token_type` `…:id_token`, `requested_token: 'openai-api-key'`,
 * against the same `TOKEN_URL`), and it is in the history at this file's path.
 */
import { randomBytes, createHash } from 'node:crypto';
import { CHATGPT_OAUTH_CONFIG } from './chatgpt-oauth-config.ts';

// OAuth configuration from shared config
const CLIENT_ID = CHATGPT_OAUTH_CONFIG.CLIENT_ID;
const AUTH_URL = CHATGPT_OAUTH_CONFIG.AUTH_URL;
const TOKEN_URL = CHATGPT_OAUTH_CONFIG.TOKEN_URL;
const REDIRECT_URI = CHATGPT_OAUTH_CONFIG.REDIRECT_URI;
const OAUTH_SCOPES = CHATGPT_OAUTH_CONFIG.SCOPES;

export interface ChatGptTokens {
  /** JWT id_token containing user identity claims */
  idToken: string;
  /** Access token for API calls */
  accessToken: string;
  /** Refresh token for getting new tokens */
  refreshToken?: string;
  /** Token expiration timestamp (Unix ms) */
  expiresAt?: number;
}

/**
 * Generate a secure random state parameter
 */
function generateState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Use URL-safe base64 encoding for PKCE (43-128 characters)
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// Prepare / Exchange (server-owned flow)
// ---------------------------------------------------------------------------

export interface ChatGptPreparedFlow {
  authUrl: string;
  state: string;
  codeVerifier: string;
}

/**
 * Prepare a ChatGPT OAuth flow without side effects.
 * Returns PKCE parameters and auth URL — no callback server, no browser open.
 * Used by the server-owned flow where the client handles browser + callback.
 */
export function prepareChatGptOAuth(): ChatGptPreparedFlow {
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePKCE();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    codex_cli_simplified_flow: 'true',
    id_token_add_organizations: 'true',
  });

  return {
    authUrl: `${AUTH_URL}?${params.toString()}`,
    state,
    codeVerifier,
  };
}

/**
 * Exchange an authorization code for ChatGPT tokens (stateless).
 * Accepts the codeVerifier directly — does not rely on module-level state.
 */
export async function exchangeChatGptTokens(
  code: string,
  codeVerifier: string,
): Promise<ChatGptTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error_description || errorJson.error || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`Token exchange failed: ${response.status} - ${errorMessage}`);
  }

  const data = (await response.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * Refresh ChatGPT tokens using a refresh token
 *
 * @param refreshToken - The refresh token from a previous authentication
 * @param onStatus - Optional callback for status messages
 * @returns New ChatGptTokens
 */
export async function refreshChatGptTokens(
  refreshToken: string,
  onStatus?: (message: string) => void
): Promise<ChatGptTokens> {
  onStatus?.('Refreshing tokens...');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error_description || errorJson.error || errorText;
      } catch {
        errorMessage = errorText;
      }
      throw new Error(`Token refresh failed: ${response.status} - ${errorMessage}`);
    }

    const data = (await response.json()) as {
      id_token: string;
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    onStatus?.('Tokens refreshed successfully!');

    return {
      idToken: data.id_token,
      accessToken: data.access_token,
      // Use new refresh token if provided, otherwise keep the old one
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Token refresh failed: ${String(error)}`);
  }
}
