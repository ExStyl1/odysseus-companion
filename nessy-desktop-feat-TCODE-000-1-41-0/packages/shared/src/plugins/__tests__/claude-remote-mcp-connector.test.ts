/**
 * T1 of the plugin-install usability plan (2026-07-31), redirected by C3 of
 * the capability-path plan: a Claude plugin's remote MCP server gets an auth
 * path — ON the capability path.
 *
 * The measured defect (§ 0.5, the owner's literal complaint): `claude.ts` kept
 * every `.mcp.json` entry as a `kind:'mcp'` capability, so a remote server
 * needing OAuth had NO auth surface — a missing credential silently omitted
 * the server from the pool (`runtime-pool-servers.ts`), and hand-creating a
 * Source was the only way to reach the OAuth flow.
 *
 * T1's detection logic survives verbatim: an http/sse entry that DECLARES
 * OAuth (the documented `.mcp.json` `oauth` object, `mcp.md:715`, or an
 * explicit `oauthResource`) gets the auth path; header/env entries keep their
 * reviewed binding; zero-auth remote, ws and stdio import exactly as before.
 * What changed under C3 is the SHAPE: the promoted entry stays a `kind:'mcp'`
 * capability carrying an auth descriptor (`authType`/`oauthResource`/
 * `clientId`) bound to its GLOBAL plugin credential slot, instead of becoming
 * a `PluginConnectorDescriptor` materialized into a Source.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import type { PluginOrigin } from '../types.ts';

const ORIGIN: PluginOrigin = {
  source: 'local-path',
  marketplaceId: 'test-marketplace',
  resolvedAt: 0,
};

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function bundleWith(servers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-remote-mcp-connector-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'remote-mcp-plugin', version: '1.0.0' }),
  );
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  return root;
}

describe('Claude remote MCP servers that declare OAuth become auth-carrying capabilities (T1 -> C3)', () => {
  it('an http entry with an oauth object becomes a kind:mcp capability with authType oauth, and NO connector', async () => {
    const root = bundleWith({
      linear: {
        type: 'http',
        url: 'https://mcp.linear.example/mcp',
        oauth: { scopes: ['read'] },
      },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'linear',
    );
    expect(capability?.kind).toBe('mcp');
    expect(capability?.kind === 'mcp' ? capability.mcp : undefined).toMatchObject({
      serverName: 'linear',
      transport: 'http',
      url: 'https://mcp.linear.example/mcp',
      authType: 'oauth',
    });
    // The Source projection receives nothing: no connector survives
    // normalization, and no silent credential-missing drop path remains.
    expect(result.value?.connectors ?? []).toHaveLength(0);
    expect(result.compatibility?.supportedKinds).not.toContain('connector');
  });

  it('carries oauthResource, clientId and toolTimeoutMs onto the auth-carrying capability', async () => {
    const root = bundleWith({
      tracker: {
        type: 'sse',
        url: 'https://mcp.tracker.example/sse',
        oauthResource: 'https://mcp.tracker.example',
        oauth: { clientId: 'public-client-1' },
        timeout: 30000,
      },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'tracker',
    );
    expect(capability?.kind === 'mcp' ? capability.mcp : undefined).toEqual({
      serverName: 'tracker',
      transport: 'sse',
      url: 'https://mcp.tracker.example/sse',
      authType: 'oauth',
      oauthResource: 'https://mcp.tracker.example',
      clientId: 'public-client-1',
      toolTimeoutMs: 30000,
    });
  });

  it('leaves a zero-auth http entry (context7-style) importing as a plain mcp capability', async () => {
    const root = bundleWith({
      context7: { type: 'http', url: 'https://mcp.context7.example/mcp' },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'context7',
    );
    expect(capability).toBeDefined();
    expect(capability?.kind === 'mcp' ? capability.mcp.url : undefined)
      .toBe('https://mcp.context7.example/mcp');
    expect(capability?.kind === 'mcp' ? capability.mcp.authType : 'set').toBeUndefined();
    expect(result.value?.connectors ?? []).toHaveLength(0);
    expect(result.compatibility?.supportedKinds).not.toContain('connector');
  });

  it('keeps a header-bearing oauth entry as a supervised capability with NO auth descriptor (reviewed auth binding wins)', async () => {
    const root = bundleWith({
      internal: {
        type: 'http',
        url: 'https://mcp.internal.example/mcp',
        oauth: {},
        headers: { 'X-Team': 'platform' },
      },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.value?.connectors ?? []).toHaveLength(0);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'internal',
    );
    expect(capability?.kind === 'mcp' ? capability.mcp.headers : undefined)
      .toEqual({ 'X-Team': 'platform' });
    expect(capability?.kind === 'mcp' ? capability.mcp.authType : 'set').toBeUndefined();
  });

  it('never gives a stdio entry an auth descriptor — no OAuth slot to gain', async () => {
    const root = bundleWith({
      local: { command: 'node', args: ['server.js'], oauth: {} },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.value?.connectors ?? []).toHaveLength(0);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'local',
    );
    expect(capability?.kind === 'mcp' ? capability.mcp.authType : 'set').toBeUndefined();
  });
});
