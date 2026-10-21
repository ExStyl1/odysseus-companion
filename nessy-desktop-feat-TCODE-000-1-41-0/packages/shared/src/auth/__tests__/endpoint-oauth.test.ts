/**
 * C1 of the capability-path plan: the source-independent OAuth core.
 *
 * Proves the endpoint core's own contract — expiry decisions over a bare
 * `{expiresAt}` and the exact field routing of prepare/exchange/refresh over
 * an `OAuthEndpointDescriptor`. The companion extraction proof (that
 * `SourceCredentialManager` actually routes through this core, so a re-inline
 * goes red) lives in
 * `sources/__tests__/credential-manager-endpoint-core.test.ts`.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as oauthModule from '../oauth.ts';
import {
  ENDPOINT_CREDENTIAL_REFRESH_WINDOW_MS,
  endpointCredentialNeedsRefresh,
  exchangeEndpointOAuth,
  isEndpointCredentialExpired,
  prepareEndpointOAuth,
  refreshEndpointOAuthToken,
} from '../endpoint-oauth.ts';
import type { PreparedOAuthFlow } from '../oauth-flow-types.ts';

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

describe('endpoint credential expiry core', () => {
  test('no expiresAt: never expired, never proactively refreshed', () => {
    expect(isEndpointCredentialExpired({})).toBe(false);
    expect(endpointCredentialNeedsRefresh({})).toBe(false);
  });

  test('far-future token: valid and outside the refresh window', () => {
    const credential = { expiresAt: Date.now() + 60 * 60 * 1000 };
    expect(isEndpointCredentialExpired(credential)).toBe(false);
    expect(endpointCredentialNeedsRefresh(credential)).toBe(false);
  });

  test('inside the 5-minute window: not expired but needs refresh', () => {
    const credential = {
      expiresAt: Date.now() + ENDPOINT_CREDENTIAL_REFRESH_WINDOW_MS - 1000,
    };
    expect(isEndpointCredentialExpired(credential)).toBe(false);
    expect(endpointCredentialNeedsRefresh(credential)).toBe(true);
  });

  test('past expiry: both expired and needing refresh', () => {
    const credential = { expiresAt: Date.now() - 1000 };
    expect(isEndpointCredentialExpired(credential)).toBe(true);
    expect(endpointCredentialNeedsRefresh(credential)).toBe(true);
  });
});

describe('prepareEndpointOAuth', () => {
  test('routes every descriptor field into the MCP OAuth prepare machinery', async () => {
    const flow: PreparedOAuthFlow = {
      authUrl: 'https://auth.example.test/authorize?x=1',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'client-1',
      redirectUri: 'http://localhost:8914/oauth/callback',
      provider: 'mcp',
    };
    const prepareSpy = spyOn(oauthModule, 'prepareMcpOAuth').mockResolvedValue(flow);
    spies.push(prepareSpy);

    const onLog = () => {};
    const prepared = await prepareEndpointOAuth(
      {
        url: 'https://mcp.example.test/mcp',
        authType: 'oauth',
        clientId: 'client-1',
        oauthResource: 'https://mcp.example.test/',
        oauth: { authServerMetadataUrl: 'https://auth.example.test/.well-known/oauth-authorization-server' },
      },
      { callbackPort: 8914, onLog },
    );

    expect(prepared).toBe(flow);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy.mock.calls[0]![0]).toBe('https://mcp.example.test/mcp');
    expect(prepareSpy.mock.calls[0]![1]).toEqual({
      callbackPort: 8914,
      callbackUrl: undefined,
      clientId: 'client-1',
      oauthResource: 'https://mcp.example.test/',
      oauth: { authServerMetadataUrl: 'https://auth.example.test/.well-known/oauth-authorization-server' },
      onLog,
    });
  });

  test('a bare descriptor omits the oauth override and onLog entirely', async () => {
    const flow = {
      authUrl: 'a', state: 's', codeVerifier: 'v', tokenEndpoint: 't',
      clientId: 'c', redirectUri: 'r', provider: 'mcp',
    } as PreparedOAuthFlow;
    const prepareSpy = spyOn(oauthModule, 'prepareMcpOAuth').mockResolvedValue(flow);
    spies.push(prepareSpy);

    await prepareEndpointOAuth(
      { url: 'https://api.example.test', authType: 'oauth' },
      { callbackUrl: 'https://relay.example.test/cb' },
    );

    const options = prepareSpy.mock.calls[0]![1]!;
    expect('oauth' in options).toBe(false);
    expect('onLog' in options).toBe(false);
    expect(options.callbackUrl).toBe('https://relay.example.test/cb');
  });
});

describe('exchangeEndpointOAuth', () => {
  test('delegates the exchange params verbatim', async () => {
    const exchangeSpy = spyOn(oauthModule, 'exchangeMcpOAuth').mockResolvedValue({
      success: true,
      accessToken: 'token-1',
      oauthClientId: 'client-1',
    });
    spies.push(exchangeSpy);

    const params = {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'client-1',
      redirectUri: 'http://localhost:8914/oauth/callback',
      oauthResource: 'https://mcp.example.test/',
    };
    const result = await exchangeEndpointOAuth(params);

    expect(result).toEqual({ success: true, accessToken: 'token-1', oauthClientId: 'client-1' });
    expect(exchangeSpy).toHaveBeenCalledTimes(1);
    expect(exchangeSpy.mock.calls[0]![0]).toBe(params);
  });
});

describe('refreshEndpointOAuthToken', () => {
  test('refreshes through NessyOAuth with the endpoint config, silent callbacks', async () => {
    let capturedConfig: unknown;
    const refreshSpy = spyOn(oauthModule.NessyOAuth.prototype, 'refreshAccessToken')
      .mockImplementation(async function (this: { config?: unknown }, refreshToken: string, clientId: string) {
        capturedConfig = (this as unknown as { config: unknown }).config;
        expect(refreshToken).toBe('refresh-1');
        expect(clientId).toBe('client-1');
        return { accessToken: 'fresh-token', refreshToken: 'refresh-2', expiresAt: 123, tokenType: 'Bearer' };
      });
    spies.push(refreshSpy);

    const tokens = await refreshEndpointOAuthToken(
      {
        url: 'https://mcp.example.test/mcp',
        authType: 'oauth',
        oauthResource: 'https://mcp.example.test/',
        oauth: { scopes: 'read write' },
      },
      { refreshToken: 'refresh-1', clientId: 'client-1' },
    );

    expect(tokens).toEqual({
      accessToken: 'fresh-token', refreshToken: 'refresh-2', expiresAt: 123, tokenType: 'Bearer',
    });
    expect(capturedConfig).toEqual({
      mcpUrl: 'https://mcp.example.test/mcp',
      oauthResource: 'https://mcp.example.test/',
      oauth: { scopes: 'read write' },
    });
  });

  test('propagates a refresh failure to the caller (who owns needs-reauth marking)', async () => {
    const refreshSpy = spyOn(oauthModule.NessyOAuth.prototype, 'refreshAccessToken')
      .mockRejectedValue(new Error('Failed to refresh token'));
    spies.push(refreshSpy);

    await expect(refreshEndpointOAuthToken(
      { url: 'https://mcp.example.test/mcp', authType: 'oauth' },
      { refreshToken: 'refresh-1', clientId: 'client-1' },
    )).rejects.toThrow('Failed to refresh token');
  });
});
