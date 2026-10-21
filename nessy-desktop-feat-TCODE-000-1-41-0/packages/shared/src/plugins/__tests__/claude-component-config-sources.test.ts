import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import type { PluginMarketplaceEntryDefinition, PluginOrigin } from '../types.ts';

const ORIGIN: PluginOrigin = {
  source: 'local-path',
  marketplaceId: 'test-marketplace',
  resolvedAt: 0,
};

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** The one server and the one hook every shape below has to produce. */
const SERVER_MAP = { db: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'] } };
const HOOK_MAP = {
  PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo formatted' }] }],
};

function bundle(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-config-sources-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'config-sources', version: '1.0.0', ...manifest }),
  );
  for (const [relativePath, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), body);
  }
  return root;
}

/** Kind + logical name, so a shape's whole surface can be compared in one go. */
async function capabilitySet(root: string, entry?: PluginMarketplaceEntryDefinition): Promise<string[]> {
  const result = await normalizeClaudePluginBundle(root, ORIGIN, entry ? { marketplaceEntry: entry } : {});
  expect(result.ok).toBe(true);
  return (result.value?.capabilities ?? [])
    .map(capability => capability.kind === 'mcp'
      ? `mcp:${capability.mcp.serverName}:${capability.mcp.command ?? ''}`
      : capability.kind === 'hook'
        ? `hook:${capability.hook.event}:${capability.hook.matcher ?? ''}`
        : `${capability.kind}:${capability.id}`)
    .sort();
}

/**
 * `plugins-reference.md` § Hooks: "**Location**: `hooks/hooks.json` in plugin
 * root, or inline in plugin.json", and § MCP servers: "**Location**: `.mcp.json`
 * in plugin root, or inline in plugin.json". The § Complete schema example
 * declares the third shape, a custom path: `"hooks": "./config/hooks.json"` and
 * `"mcpServers": "./mcp-config.json"`.
 *
 * The adapter used to read the two default files ONLY, so a bundle using either
 * of the other two documented shapes normalized to zero capabilities — measured
 * on `testdino` and `tres-finance-plugin`, two real entries in Anthropic's
 * community marketplace that declare `mcpServers` inline and installed with no
 * MCP server at all.
 */
describe('Claude hooks/mcpServers config sources', () => {
  it('yields the same capabilities from the default files, a declared path, and an inline object', async () => {
    const fromDefaultFiles = await capabilitySet(bundle({}, {
      '.mcp.json': JSON.stringify({ mcpServers: SERVER_MAP }),
      'hooks/hooks.json': JSON.stringify({ hooks: HOOK_MAP }),
    }));
    const fromDeclaredPaths = await capabilitySet(bundle(
      { mcpServers: './mcp-config.json', hooks: './config/hooks.json' },
      {
        'mcp-config.json': JSON.stringify({ mcpServers: SERVER_MAP }),
        'config/hooks.json': JSON.stringify({ hooks: HOOK_MAP }),
      },
    ));
    const fromInline = await capabilitySet(bundle({ mcpServers: SERVER_MAP, hooks: HOOK_MAP }));

    expect(fromDefaultFiles).toEqual(['hook:PostToolUse:Write', 'mcp:db:node']);
    expect(fromDeclaredPaths).toEqual(fromDefaultFiles);
    expect(fromInline).toEqual(fromDefaultFiles);
  });

  it('loads the testdino shape from its own .mcp.json, and names the entry map that does not apply', async () => {
    // `testdino` in `anthropics/claude-plugins-community`, re-read 2026-09-28:
    // `strict: false`, a relative source, the server map on the ENTRY — and a
    // plugin directory shipping a metadata-only `plugin.json` plus a `.mcp.json`
    // holding the same server. `plugins/marketplace-reference.md#entry-and-plugin-json`:
    // with a `plugin.json` present, "Entry `mcpServers`, `lspServers`,
    // `userConfig`, and `channels` don't apply" (F1.1032). The entry-only half,
    // with no `plugin.json`, is pinned in `marketplace-entry-authority.test.ts`.
    const server = { testdino: { type: 'http', url: 'https://mcp.testdino.com' } };
    const entry: PluginMarketplaceEntryDefinition = { strict: false, fields: { mcpServers: server } };
    const root = bundle({}, { '.mcp.json': JSON.stringify({ mcpServers: server }) });

    expect(await capabilitySet(root, entry)).toEqual(['mcp:testdino:']);
    const result = await normalizeClaudePluginBundle(root, ORIGIN, { marketplaceEntry: entry });
    expect(result.diagnostics?.filter(diagnostic =>
      diagnostic.code === 'plugin.format.claude_marketplace_entry_field_not_applied')
      .map(diagnostic => diagnostic.path)).toEqual(['mcpServers']);
  });

  it('stops reporting a followed declaration as an unread surface', async () => {
    const result = await normalizeClaudePluginBundle(
      bundle({ mcpServers: SERVER_MAP, hooks: './config/hooks.json' }, {
        'config/hooks.json': JSON.stringify({ hooks: HOOK_MAP }),
      }),
      ORIGIN,
    );

    expect(result.compatibility?.deferred.some(entry =>
      entry.reasonCode === 'plugin.deferred.claude_inline_config'
      || entry.reasonCode === 'plugin.deferred.claude_custom_path_mcp'
      || entry.reasonCode === 'plugin.deferred.claude_custom_path_hooks')).toBe(false);
    expect(result.compatibility?.state).toBe('supported');
  });

  it('warns about a declared path that does not exist and still reads the default file', async () => {
    const result = await normalizeClaudePluginBundle(
      bundle({ mcpServers: './missing-mcp.json' }, {
        '.mcp.json': JSON.stringify({ mcpServers: SERVER_MAP }),
      }),
      ORIGIN,
    );

    expect(result.diagnostics?.some(entry =>
      entry.code === 'plugin.format.claude_path_missing' && entry.path === 'missing-mcp.json')).toBe(true);
    expect(result.value?.capabilities.some(capability =>
      capability.kind === 'mcp' && capability.mcp.serverName === 'db')).toBe(true);
  });
});
