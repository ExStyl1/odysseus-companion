/**
 * C1 extraction proof: `SourceCredentialManager` ROUTES its MCP OAuth
 * prepare/exchange/refresh through the source-independent endpoint core
 * (`auth/endpoint-oauth.ts`) instead of owning the machinery inline.
 *
 * This is the mutation gate's target: re-inline any of the three delegations
 * (call `prepareMcpOAuth`/`exchangeMcpOAuth`/`NessyOAuth` directly from
 * credential-manager.ts again) and the corresponding test here goes red,
 * because the spied core function is no longer reached.
 *
 * Spy instead of mock.module(): Bun module mocks leak across files in the same
 * process (house rule recorded in token-refresh-manager.test.ts).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as endpointOAuthModule from '../../auth/endpoint-oauth.ts';
import * as credentialsIndexModule from '../../credentials/index.ts';
import * as credentialsManagerModule from '../../credentials/manager.ts';
import { credentialIdToAccount, type CredentialId, type StoredCredential } from '../../credentials/types.ts';
import { SourceCredentialManager } from '../credential-manager.ts';
import { createSource, isSourceUsable, loadSource } from '../storage.ts';
import type { LoadedSource } from '../types.ts';

let root: string;
let workspaceRoot: string;
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

async function createMcpSource(): Promise<LoadedSource> {
  const created = await createSource(workspaceRoot, {
    name: 'Tracker',
    provider: 'custom',
    type: 'mcp',
    mcp: {
      transport: 'http',
      url: 'https://tracker.example.test/mcp',
      authType: 'oauth',
      oauthResource: 'https://tracker.example.test/',
      clientId: 'pinned-client',
      oauth: { scopes: 'read' },
    },
    enabled: true,
    icon: '🧪',
  });
  return loadSource(workspaceRoot, created.slug)!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'credential-manager-endpoint-core-'));
  workspaceRoot = join(root, 'ws_main');
  mkdirSync(join(workspaceRoot, 'sources'), { recursive: true });
  rows = new Map();
  const fake = fakeCredentialManager() as never;
  spies.push(spyOn(credentialsManagerModule, 'getCredentialManager').mockReturnValue(fake));
  spies.push(spyOn(credentialsIndexModule, 'getCredentialManager').mockReturnValue(fake));
});

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('prepareOAuth routes through the endpoint core', () => {
  test('an MCP source projects exactly its endpoint fields (no oauth override — carried behavior)', async () => {
    const flow = {
      authUrl: 'https://auth.example.test/authorize',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'pinned-client',
      redirectUri: 'http://localhost:8914/oauth/callback',
      provider: 'mcp' as const,
    };
    const prepareSpy = spyOn(endpointOAuthModule, 'prepareEndpointOAuth').mockResolvedValue(flow);
    spies.push(prepareSpy);

    const source = await createMcpSource();
    const manager = new SourceCredentialManager();
    const prepared = await manager.prepareOAuth(source, { callbackPort: 8914 });

    expect(prepared).toBe(flow);
    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy.mock.calls[0]![0]).toEqual({
      url: 'https://tracker.example.test/mcp',
      authType: 'oauth',
      clientId: 'pinned-client',
      oauthResource: 'https://tracker.example.test/',
    });
    expect(prepareSpy.mock.calls[0]![1]).toEqual({ callbackPort: 8914, callbackUrl: undefined });
  });

  test('a generic API source with auto-discovery rides the same core, relabeled generic', async () => {
    const flow = {
      authUrl: 'a', state: 's', codeVerifier: 'v', tokenEndpoint: 't',
      clientId: 'c', redirectUri: 'r', provider: 'mcp' as const,
    };
    const prepareSpy = spyOn(endpointOAuthModule, 'prepareEndpointOAuth').mockResolvedValue(flow);
    spies.push(prepareSpy);

    const created = await createSource(workspaceRoot, {
      name: 'Generic API',
      provider: 'custom',
      type: 'api',
      api: { baseUrl: 'https://api.example.test', authType: 'oauth' },
      enabled: true,
      icon: '🧪',
    });
    const source = loadSource(workspaceRoot, created.slug)!;
    const manager = new SourceCredentialManager();
    const prepared = await manager.prepareOAuth(source, { callbackUrl: 'https://relay.example.test/cb' });

    expect(prepared.provider).toBe('generic');
    expect(prepareSpy.mock.calls[0]![0]).toEqual({
      url: 'https://api.example.test',
      authType: 'oauth',
    });
  });
});

describe('exchangeAndStore routes through the endpoint core', () => {
  test('a successful exchange stores the tokens under the source slot and marks it authenticated', async () => {
    const exchangeSpy = spyOn(endpointOAuthModule, 'exchangeEndpointOAuth').mockResolvedValue({
      success: true,
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 4102444800000,
      oauthClientId: 'client-1',
    });
    spies.push(exchangeSpy);

    const source = await createMcpSource();
    const manager = new SourceCredentialManager();
    const result = await manager.exchangeAndStore(source, 'mcp', {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'client-1',
      redirectUri: 'http://localhost:8914/oauth/callback',
    });

    expect(result).toEqual({ success: true, email: undefined });
    expect(exchangeSpy).toHaveBeenCalledTimes(1);
    const stored = rows.get(`source_oauth::${source.workspaceId}::${source.config.slug}`);
    expect(stored).toEqual({
      value: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 4102444800000,
      clientId: 'client-1',
      clientSecret: undefined,
    });
    const reloaded = loadSource(workspaceRoot, source.config.slug)!;
    // isSourceUsable is the product's own gate: enabled AND authenticated.
    expect(isSourceUsable(reloaded)).toBe(true);
  });

  test('a failed exchange stores nothing and reports the core error', async () => {
    const exchangeSpy = spyOn(endpointOAuthModule, 'exchangeEndpointOAuth').mockResolvedValue({
      success: false,
      error: 'exchange refused',
    });
    spies.push(exchangeSpy);

    const source = await createMcpSource();
    const manager = new SourceCredentialManager();
    const result = await manager.exchangeAndStore(source, 'mcp', {
      code: 'code-1',
      codeVerifier: 'verifier-1',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'client-1',
      redirectUri: 'http://localhost:8914/oauth/callback',
    });

    expect(result).toEqual({ success: false, error: 'exchange refused' });
    expect(rows.size).toBe(0);
  });
});

describe('refresh routes through the endpoint core', () => {
  test('an MCP refresh delegates with the endpoint descriptor including the oauth override', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken').mockResolvedValue({
      accessToken: 'fresh-1',
      refreshToken: 'refresh-2',
      expiresAt: 4102444800000,
      tokenType: 'Bearer',
    });
    spies.push(refreshSpy);

    const source = await createMcpSource();
    rows.set(`source_oauth::${source.workspaceId}::${source.config.slug}`, {
      value: 'stale-token',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
    });

    const manager = new SourceCredentialManager();
    const token = await manager.refresh(source);

    expect(token).toBe('fresh-1');
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy.mock.calls[0]![0]).toEqual({
      url: 'https://tracker.example.test/mcp',
      authType: 'oauth',
      oauthResource: 'https://tracker.example.test/',
      oauth: { scopes: 'read' },
    });
    expect(refreshSpy.mock.calls[0]![1]).toEqual({ refreshToken: 'refresh-1', clientId: 'client-1' });
    expect(rows.get(`source_oauth::${source.workspaceId}::${source.config.slug}`)).toEqual({
      value: 'fresh-1',
      refreshToken: 'refresh-2',
      expiresAt: 4102444800000,
      clientId: 'client-1',
    });
  });

  test('a missing clientId still short-circuits BEFORE the core (carried guard)', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken').mockResolvedValue({
      accessToken: 'never', tokenType: 'Bearer',
    });
    spies.push(refreshSpy);

    const source = await createMcpSource();
    rows.set(`source_oauth::${source.workspaceId}::${source.config.slug}`, {
      value: 'stale-token',
      refreshToken: 'refresh-1',
    });

    const manager = new SourceCredentialManager();
    const token = await manager.refresh(source);

    expect(token).toBeNull();
    expect(refreshSpy).not.toHaveBeenCalled();
    const reloaded = loadSource(workspaceRoot, source.config.slug)!;
    expect(reloaded.config.connectionStatus).toBe('needs_auth');
  });

  test('a core refresh failure marks the source needing re-auth and returns null', async () => {
    const refreshSpy = spyOn(endpointOAuthModule, 'refreshEndpointOAuthToken')
      .mockRejectedValue(new Error('Failed to refresh token'));
    spies.push(refreshSpy);

    const source = await createMcpSource();
    rows.set(`source_oauth::${source.workspaceId}::${source.config.slug}`, {
      value: 'stale-token',
      refreshToken: 'refresh-1',
      clientId: 'client-1',
    });

    const manager = new SourceCredentialManager();
    const token = await manager.refresh(source);

    expect(token).toBeNull();
    const reloaded = loadSource(workspaceRoot, source.config.slug)!;
    expect(reloaded.config.connectionStatus).toBe('needs_auth');
    expect(reloaded.config.connectionError).toContain('Failed to refresh token');
  });
});

describe('expiry checks route through the endpoint core', () => {
  test('isExpired and needsRefresh agree with the core helpers', () => {
    const manager = new SourceCredentialManager();
    const nearExpiry = { value: 'x', expiresAt: Date.now() + 60 * 1000 };
    expect(manager.isExpired(nearExpiry)).toBe(endpointOAuthModule.isEndpointCredentialExpired(nearExpiry));
    expect(manager.needsRefresh(nearExpiry)).toBe(endpointOAuthModule.endpointCredentialNeedsRefresh(nearExpiry));
    expect(manager.needsRefresh(nearExpiry)).toBe(true);
    expect(manager.isExpired(nearExpiry)).toBe(false);
  });
});
