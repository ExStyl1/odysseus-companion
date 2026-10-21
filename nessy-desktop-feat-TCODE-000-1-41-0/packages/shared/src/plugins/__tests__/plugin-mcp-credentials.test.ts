/**
 * C2 of the capability-path plan: a plugin MCP server owns a GLOBAL credential
 * slot — `plugin_mcp_{oauth|bearer}::{pluginKey}::{serverName}`.
 *
 * Proven here:
 *  - key round-trip through the credential account codec (both directions,
 *    both auth types; incomplete ids never collide into the plugin format);
 *  - slot operations against a REAL encrypted store (save/load fallback,
 *    per-server delete, per-plugin purge that never touches another plugin's
 *    rows or any source row);
 *  - the live OAuth probe: the C1 endpoint core's REAL discovery/DCR/exchange
 *    code (driven through the explicit network seam) minting a token that
 *    lands in the plugin slot of a real temp-config encrypted store — and the
 *    raw token never appears in the file on disk;
 *  - uninstall through the real PluginManagementServiceV2 purges the plugin's
 *    slots and leaves every other row alone.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { SecureStorageBackendV2 } from '../../credentials/backends/secure-storage.ts';
import * as credentialsIndexModule from '../../credentials/index.ts';
import * as credentialsManagerModule from '../../credentials/manager.ts';
import { CredentialManager } from '../../credentials/manager.ts';
import {
  accountToCredentialId,
  credentialIdToAccount,
} from '../../credentials/types.ts';
import {
  exchangeEndpointOAuth,
  prepareEndpointOAuth,
} from '../../auth/endpoint-oauth.ts';
import { withOAuthNetworkDependenciesForTests } from '../../auth/oauth.ts';
import {
  deletePluginMcpServerCredentials,
  loadPluginMcpCredential,
  pluginMcpCredentialId,
  purgePluginMcpCredentials,
  savePluginMcpCredential,
} from '../mcp-credentials.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';

let root: string;
let credentialFile: string;
let credentials: CredentialManager;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plugin-mcp-credentials-'));
  credentialFile = join(root, 'credentials.enc');
  credentials = new CredentialManager(new SecureStorageBackendV2({ filePath: credentialFile }));
  spies.push(spyOn(credentialsManagerModule, 'getCredentialManager').mockReturnValue(credentials));
  spies.push(spyOn(credentialsIndexModule, 'getCredentialManager').mockReturnValue(credentials));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  while (spies.length) spies.pop()!.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('plugin MCP credential key round-trip', () => {
  test('oauth and bearer ids map to plugin_mcp_*::{pluginKey}::{serverName} and back', () => {
    const oauthId = pluginMcpCredentialId('oauth', 'bWs.dHJhY2tlcg', 'tracker-mcp');
    const bearerId = pluginMcpCredentialId('bearer', 'bWs.dHJhY2tlcg', 'tracker-mcp');
    expect(credentialIdToAccount(oauthId)).toBe('plugin_mcp_oauth::bWs.dHJhY2tlcg::tracker-mcp');
    expect(credentialIdToAccount(bearerId)).toBe('plugin_mcp_bearer::bWs.dHJhY2tlcg::tracker-mcp');
    expect(accountToCredentialId('plugin_mcp_oauth::bWs.dHJhY2tlcg::tracker-mcp')).toEqual(oauthId);
    expect(accountToCredentialId('plugin_mcp_bearer::bWs.dHJhY2tlcg::tracker-mcp')).toEqual(bearerId);
  });

  test('an incomplete plugin id falls to the global suffix, and source keying is untouched', () => {
    expect(credentialIdToAccount({ type: 'plugin_mcp_oauth', pluginKey: 'only-key' }))
      .toBe('plugin_mcp_oauth::global');
    // Positive control: the neighboring source format still round-trips.
    expect(accountToCredentialId('source_oauth::ws_a::my-tracker'))
      .toEqual({ type: 'source_oauth', workspaceId: 'ws_a', sourceId: 'my-tracker' });
  });
});

describe('slot operations on a real encrypted store', () => {
  test('save/load falls back oauth -> bearer, per-server delete clears both slots', async () => {
    await savePluginMcpCredential('bearer', 'mk.suite', 'suite-mail', { value: 'bearer-token' });
    // OAuth slot empty: the loader falls back to the bearer row.
    expect((await loadPluginMcpCredential('mk.suite', 'suite-mail'))?.value).toBe('bearer-token');

    await savePluginMcpCredential('oauth', 'mk.suite', 'suite-mail', {
      value: 'oauth-token',
      refreshToken: 'refresh-1',
      expiresAt: 4102444800000,
      clientId: 'client-1',
    });
    // OAuth slot wins once present.
    expect((await loadPluginMcpCredential('mk.suite', 'suite-mail'))?.value).toBe('oauth-token');

    expect(await deletePluginMcpServerCredentials('mk.suite', 'suite-mail')).toBe(2);
    expect(await loadPluginMcpCredential('mk.suite', 'suite-mail')).toBeNull();
  });

  test('per-plugin purge deletes only that plugin, never a sibling plugin or a source row', async () => {
    await savePluginMcpCredential('oauth', 'mk.victim', 'server-a', { value: 'victim-a' });
    await savePluginMcpCredential('bearer', 'mk.victim', 'server-b', { value: 'victim-b' });
    await savePluginMcpCredential('oauth', 'mk.survivor', 'server-a', { value: 'survivor-a' });
    await credentials.set(
      { type: 'source_oauth', workspaceId: 'ws_a', sourceId: 'my-tracker' },
      { value: 'source-token' },
    );

    expect(await purgePluginMcpCredentials('mk.victim')).toBe(2);

    expect(await loadPluginMcpCredential('mk.victim', 'server-a')).toBeNull();
    expect(await loadPluginMcpCredential('mk.victim', 'server-b')).toBeNull();
    expect((await loadPluginMcpCredential('mk.survivor', 'server-a'))?.value).toBe('survivor-a');
    expect((await credentials.get({ type: 'source_oauth', workspaceId: 'ws_a', sourceId: 'my-tracker' }))?.value)
      .toBe('source-token');
  });
});

describe('live OAuth probe: endpoint core -> plugin slot on a temp-config store', () => {
  test('discovery + DCR + exchange mint a token that lands ONLY encrypted in the plugin slot', async () => {
    const tokenValue = 'PLUGIN_SLOT_TOKEN_CANARY';
    const fetchImpl = async (url: string, options: RequestInit): Promise<Response> => {
      if (url.includes('/.well-known/')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          registration_endpoint: 'https://auth.example.test/register',
        }), { status: 200 });
      }
      if (url === 'https://auth.example.test/register') {
        return new Response(JSON.stringify({ client_id: 'dcr-client-1' }), { status: 200 });
      }
      if (url === 'https://auth.example.test/token') {
        const body = String(options.body);
        expect(body).toContain('grant_type=authorization_code');
        expect(body).toContain('client_id=dcr-client-1');
        return new Response(JSON.stringify({
          access_token: tokenValue,
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
        }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };
    const network = {
      fetchImpl,
      resolveHost: async () => [{ address: '203.0.114.10', family: 4 }],
    };

    const flow = await withOAuthNetworkDependenciesForTests(network, () => prepareEndpointOAuth(
      { url: 'https://mcp.example.test/mcp', authType: 'oauth' },
      { callbackPort: 8914 },
    ));
    expect(flow.clientId).toBe('dcr-client-1');
    expect(flow.tokenEndpoint).toBe('https://auth.example.test/token');

    const exchanged = await withOAuthNetworkDependenciesForTests(network, () => exchangeEndpointOAuth({
      code: 'code-1',
      codeVerifier: flow.codeVerifier,
      tokenEndpoint: flow.tokenEndpoint,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
    }));
    expect(exchanged.success).toBe(true);

    await savePluginMcpCredential('oauth', 'mk.probe', 'probe-mcp', {
      value: exchanged.accessToken!,
      refreshToken: exchanged.refreshToken,
      expiresAt: exchanged.expiresAt,
      clientId: exchanged.oauthClientId,
    });

    const stored = await loadPluginMcpCredential('mk.probe', 'probe-mcp');
    expect(stored?.value).toBe(tokenValue);
    expect(stored?.refreshToken).toBe('refresh-1');
    expect(stored?.clientId).toBe('dcr-client-1');
    // The store is encrypted: the raw token never appears in the file bytes.
    expect(readFileSync(credentialFile, 'utf8')).not.toContain(tokenValue);
  });
});

describe('uninstall purges the plugin slots through the real management service', () => {
  test('the uninstalled plugin loses its rows; sibling plugin and source rows survive', async () => {
    const store = new PluginStoreV2({ rootDirectory: join(root, 'plugins') });
    const service = installs.track(new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({
        globalPath: join(root, 'capabilities.json'),
        workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
      }),
      trustStore: new CapabilityTrustStore({ path: join(root, 'trust.json') }),
      credentialManager: credentials,
      baseTempDir: join(root, 'staging'),
    }));

    const bundle = join(root, 'bundle');
    mkdirSync(join(bundle, 'server'), { recursive: true });
    writeFileSync(join(bundle, 'server', 'index.js'), 'process.stdout.write("ready")\n');
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({
      manifest_version: '0.3',
      name: 'purge-fixture',
      version: '1.0.0',
      server: {
        type: 'node',
        entry_point: 'server/index.js',
        mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] },
      },
    }));
    const installed = await service.install({ kind: 'local-path', path: bundle });
    expect(installed.ok).toBe(true);
    const pluginKey = installed.installed!.pluginKey;

    await savePluginMcpCredential('oauth', pluginKey, 'purge-mcp', { value: 'doomed-token' });
    await savePluginMcpCredential('oauth', 'mk.sibling', 'other-mcp', { value: 'sibling-token' });
    await credentials.set(
      { type: 'source_oauth', workspaceId: 'ws_a', sourceId: 'my-tracker' },
      { value: 'source-token' },
    );

    await service.uninstall(pluginKey);

    expect(await loadPluginMcpCredential(pluginKey, 'purge-mcp')).toBeNull();
    expect((await loadPluginMcpCredential('mk.sibling', 'other-mcp'))?.value).toBe('sibling-token');
    expect((await credentials.get({ type: 'source_oauth', workspaceId: 'ws_a', sourceId: 'my-tracker' }))?.value)
      .toBe('source-token');
  });
});

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
