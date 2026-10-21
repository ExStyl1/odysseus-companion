import { afterEach, describe, expect, it } from 'bun:test';
import { CHATGPT_OAUTH_CONFIG } from '../chatgpt-oauth-config.ts';
import { prepareChatGptOAuth } from '../chatgpt-oauth.ts';
import { CLAUDE_OAUTH_CONFIG } from '../claude-oauth-config.ts';
import { clearOAuthState, prepareClaudeOAuth } from '../claude-oauth.ts';

function expectPkceAuthUrl(authUrl: string, expected: {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
}): void {
  const url = new URL(authUrl);
  const expectedUrl = new URL(expected.authUrl);

  expect(url.origin + url.pathname).toBe(expectedUrl.origin + expectedUrl.pathname);
  expect(url.searchParams.get('client_id')).toBe(expected.clientId);
  expect(url.searchParams.get('redirect_uri')).toBe(expected.redirectUri);
  expect(url.searchParams.get('scope')).toBe(expected.scopes);
  expect(url.searchParams.get('response_type')).toBe('code');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get('state')).toMatch(/^[A-Fa-f0-9]{64}$/);
  expect(authUrl).not.toContain('oauth/callback');
  expect(authUrl).not.toContain('oauth-relay');
}

describe('subscription OAuth prepare flows', () => {
  afterEach(() => {
    clearOAuthState();
  });

  it('builds a relay-independent Claude OAuth PKCE URL', () => {
    expectPkceAuthUrl(prepareClaudeOAuth(), {
      authUrl: CLAUDE_OAUTH_CONFIG.AUTH_URL,
      clientId: CLAUDE_OAUTH_CONFIG.CLIENT_ID,
      redirectUri: CLAUDE_OAUTH_CONFIG.REDIRECT_URI,
      scopes: CLAUDE_OAUTH_CONFIG.SCOPES,
    });
  });

  it('builds a relay-independent ChatGPT OAuth PKCE URL', () => {
    const flow = prepareChatGptOAuth();

    expect(flow.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.state).toMatch(/^[A-Fa-f0-9]{64}$/);
    expectPkceAuthUrl(flow.authUrl, {
      authUrl: CHATGPT_OAUTH_CONFIG.AUTH_URL,
      clientId: CHATGPT_OAUTH_CONFIG.CLIENT_ID,
      redirectUri: CHATGPT_OAUTH_CONFIG.REDIRECT_URI,
      scopes: CHATGPT_OAUTH_CONFIG.SCOPES,
    });

    const url = new URL(flow.authUrl);
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
  });
});
