/**
 * C4 of the capability-path plan, ADR § 8 risk 3: the refresh re-point.
 *
 * A plugin MCP slot refreshes through the C1 endpoint core AT THE POINT OF
 * CONSUMPTION. Proven: a near-expiry slot refreshes and the slot is updated;
 * a fresh slot is returned without touching the network; a refresh failure
 * never throws, keeps the stale-but-unexpired token, enters cooldown, and an
 * EXPIRED slot surfaces as null (needs-login); bearer slots never refresh.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as endpointOAuthModule from '../../auth/endpoint-oauth.ts';
import * as credentialsIndexModule from '../../credentials/index.ts';
import * as credentialsManagerModule from '../../credentials/manager.ts';
import { credentialIdToAccount, type CredentialId, type StoredCredential } from '../../credentials/types.ts';
import {
  ensureFreshPluginMcpToken,
  resetPluginMcpTokenRefreshForTests,
} from '../mcp-token-refresh.ts';

let rows: Map<string, StoredCredential>;
const spies: Array<{ mockRestore: () => void }> = [];

function fakeCredentialManager() {
  const account = (id: CredentialId) => credentialIdToAccount(id);
  return {
    get: async (id: CredentialId) => structuredClone(rows.get(account(id)) ?? null),
    set: async (id: CredentialId, credential: StoredCredential) => {
      rows.set(account(id), structuredClone(credential));
    },
    delete: async (id: CredentialId) => rows.delete(account(id)),
    deleteSync: (id: CredentialId) => rows.delete(account(id)),
    getRuntimeCredentialStatus: (id: CredentialId) => ({
      state: rows.has(account(id)) ? 'ready' : 'missing',
      revision: 0,
    }),
  };
}

const AUTH = {
  authType: 'oauth' as const,
  pluginKey: 'mk.tracker',
  serverName: 'tracker-mcp',
  oauthResource: 'https://tracker.example.test/',
};
const URL_ = 'https://tracker.example.test/mcp';
const SLOT = 'plugin_mcp_oauth::mk.tracker::tracker-mcp';

beforeEach(() => {
  rows = new Map();
  resetPluginMcpTokenRefreshForTests();
  const fake = fakeCredentialManager() as never;
  spies.push(spyOn(credentialsManagerModule, 'getCredentialManager').mockReturnValue(fake));
  spies.push(spyOn(credentialsIndexModule, 'getCredentialManager').mockReturnValue(fake));
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  resetPluginMcpTokenRefreshForTests();
});

describe('ensureFreshPluginMcpToken', () => {
  test('refreshes a near-expiry slot through the endpoint core and UPDATES the slot', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken').mockResolvedValue({
      accessToken: 'fresh-token',
      refreshToken: 'refresh-2',
      expiresAt: Date.now() + 3600_000,
      tokenType: 'Bearer',
    });
    spies.push(refreshSpy);
    rows.set(SLOT, {
      value: 'stale-token',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      expiresAt: Date.now() + 60_000, // inside the 5-minute window
    });

    const token = await ensureFreshPluginMcpToken(AUTH, URL_);

    expect(token).toBe('fresh-token');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0]![0]).toEqual({
      url: URL_,
      authType: 'oauth',
      oauthResource: 'https://tracker.example.test/',
    });
    expect(rows.get(SLOT)).toMatchObject({ value: 'fresh-token', refreshToken: 'refresh-2' });
  });

  test('returns a fresh token untouched and an empty slot as null', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken')
      .mockRejectedValue(new Error('must not be called'));
    spies.push(refreshSpy);

    rows.set(SLOT, {
      value: 'fresh-enough',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      expiresAt: Date.now() + 3600_000,
    });
    expect(await ensureFreshPluginMcpToken(AUTH, URL_)).toBe('fresh-enough');

    rows.delete(SLOT);
    expect(await ensureFreshPluginMcpToken(AUTH, URL_)).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test('failure never throws: stale-but-unexpired token survives, cooldown holds, expired yields null', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken')
      .mockRejectedValue(new Error('Failed to refresh token'));
    spies.push(refreshSpy);

    rows.set(SLOT, {
      value: 'stale-token',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      expiresAt: Date.now() + 60_000, // near expiry, not expired
    });
    expect(await ensureFreshPluginMcpToken(AUTH, URL_)).toBe('stale-token');
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Cooldown: the immediate next call never hits the core again.
    expect(await ensureFreshPluginMcpToken(AUTH, URL_)).toBe('stale-token');
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // Expired + in cooldown: no usable token — the caller surfaces needs-login.
    rows.set(SLOT, {
      value: 'expired-token',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
      expiresAt: Date.now() - 1000,
    });
    expect(await ensureFreshPluginMcpToken(AUTH, URL_)).toBeNull();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  test('a bearer slot never refreshes: valid value returned, expired value yields null', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken')
      .mockRejectedValue(new Error('must not be called'));
    spies.push(refreshSpy);
    const bearerAuth = { authType: 'bearer' as const, pluginKey: 'mk.suite', serverName: 'suite-mail' };

    rows.set('plugin_mcp_bearer::mk.suite::suite-mail', { value: 'bearer-token' });
    expect(await ensureFreshPluginMcpToken(bearerAuth, 'https://suite.example.test/mail')).toBe('bearer-token');

    rows.set('plugin_mcp_bearer::mk.suite::suite-mail', { value: 'bearer-token', expiresAt: Date.now() - 1000 });
    expect(await ensureFreshPluginMcpToken(bearerAuth, 'https://suite.example.test/mail')).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
