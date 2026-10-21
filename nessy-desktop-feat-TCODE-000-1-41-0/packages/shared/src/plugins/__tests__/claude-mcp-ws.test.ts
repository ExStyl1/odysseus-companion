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
  const root = mkdtempSync(join(tmpdir(), 'claude-mcp-ws-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ws-plugin', version: '1.0.0' }),
  );
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  return root;
}

/**
 * `mcp.md:322` lists WebSocket among a plugin's supported MCP transports, and
 * `mcp.md:147` gives `ws` the same fields as `http`. The `.mcp.json` reader, the
 * pool AND plugin import now all carry it — the last blocker was one union in
 * `capabilities/resolver.ts`, widened after the executor that found it was done
 * with that file. This test pins the import, and its sibling pins that an http
 * server is untouched by the widening.
 */
describe('Claude plugin MCP servers with the ws transport', () => {
  it('imports a ws server as a capability rather than refusing it', async () => {
    const root = bundleWith({
      events: { type: 'ws', url: 'wss://mcp.example.test/socket' },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'events',
    );
    expect(capability).toBeDefined();
    expect(capability?.kind === 'mcp' ? capability.mcp.transport : undefined).toBe('ws');
    expect(capability?.kind === 'mcp' ? capability.mcp.url : undefined).toBe('wss://mcp.example.test/socket');
    // Neither the old named refusal nor the older misleading text a server with
    // no url gets. Both are pinned, because the refusal was itself a fix and a
    // regression could land on either side of it.
    expect(result.diagnostics?.some(
      entry => entry.code === 'plugin.format.claude_mcp_ws_unsupported',
    )).toBe(false);
    expect(result.diagnostics?.some(
      entry => entry.message.includes('requires a command (stdio) or url'),
    )).toBe(false);
    expect(result.compatibility?.deferred.some(
      entry => entry.reasonCode === 'plugin.deferred.claude_mcp_ws_unsupported',
    )).toBe(false);
  });

  // `mcp.md:83`: JSON configs accept `streamable-http` as an alias for `http`.
  // Without the fold, `??` cannot fall through the non-null string, so the
  // entry lost the `url ? 'http'` fallback and died with a diagnostic claiming
  // it had no url — misleading, because it does.
  it('imports a bundled streamable-http entry as the http transport', async () => {
    const root = bundleWith({
      docs: { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'docs',
    );
    expect(capability?.kind === 'mcp' ? capability.mcp.transport : undefined).toBe('http');
    expect(result.diagnostics?.some(
      entry => entry.message.includes('requires a command (stdio) or url'),
    )).toBe(false);
  });

  it('leaves an http server importing exactly as before', async () => {
    const root = bundleWith({
      docs: { type: 'http', url: 'https://mcp.example.test/mcp' },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    expect(result.value?.capabilities.some(
      capability => capability.kind === 'mcp' && capability.mcp.serverName === 'docs',
    )).toBe(true);
    expect(result.diagnostics?.some(entry => entry.code.includes('mcp'))).toBe(false);
  });

  // `mcp.md:768` + `:327`: headersHelper is carried on the imported descriptor,
  // plugin path placeholders substitute into it like url/headers, and neither
  // the old warning nor the old deferred record is filed.
  it('carries headersHelper with ${CLAUDE_PLUGIN_ROOT} rewritten, no deferral', async () => {
    const root = bundleWith({
      docs: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headersHelper: '${CLAUDE_PLUGIN_ROOT}/scripts/token.sh',
      },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities.find(
      entry => entry.kind === 'mcp' && entry.mcp.serverName === 'docs',
    );
    expect(capability?.kind === 'mcp' ? capability.mcp.headersHelper : undefined)
      .toBe('${NESSY_PLUGIN_ROOT}/scripts/token.sh');
    expect(result.diagnostics?.some(
      entry => entry.code === 'plugin.format.claude_mcp_headers_helper_unsupported',
    )).toBe(false);
    expect(result.compatibility?.deferred.some(
      entry => entry.reasonCode === 'plugin.deferred.claude_mcp_headers_helper_unsupported',
    )).toBe(false);
  });

  // `mcp.md:818`: a plugin headersHelper may not reference `${user_config.*}`
  // because the command runs through a shell — the server is reported as
  // misconfigured with an ERROR and is not imported; `headers` is the safe
  // place for the value.
  it('refuses a headersHelper that references ${user_config.*}', async () => {
    const root = bundleWith({
      docs: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headersHelper: './scripts/token.sh ${user_config.TOKEN}',
      },
    });

    const result = await normalizeClaudePluginBundle(root, ORIGIN);

    const diagnostic = result.diagnostics?.find(
      entry => entry.code === 'plugin.format.claude_mcp_headers_helper_user_config',
    );
    expect(diagnostic?.severity).toBe('error');
    expect(diagnostic?.message).toContain('headers');
    expect(result.value?.capabilities.some(
      capability => capability.kind === 'mcp' && capability.mcp.serverName === 'docs',
    ) ?? false).toBe(false);
  });
});
