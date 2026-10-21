/**
 * UB12.94 — the documented `mcp_tool` hook shape at import.
 *
 * hooks.md#mcp-tool-hook-fields gives an `mcp_tool` hook three fields: `server` ("Name of a configured MCP server.
 * For a plugin-bundled server, this is the scoped name `plugin:<plugin-name>:<server-name>`"), `tool` ("Name of the
 * tool to call on that server") and `input` ("Arguments passed to the tool. String values support `${path}`
 * substitution from the hook's JSON input"). The Claude adapter read only our own qualified `mcpTool`, so the
 * documented pair reached schema.ts as a bare tool name, and its `plugin.hook.invalid_mcp_tool` ERROR refused the
 * WHOLE plugin (measured 2026-10-16: ok:false for `{server:'db', tool:'query', input:{q:'x'}}`).
 *
 * Pinned decision: a hook the adapter cannot address fails THAT HOOK (a warning, the hook dropped), never the bundle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import { pluginMcpWireName, translatePluginMcpToolName } from '../../capabilities/mcp-wire-name.ts';
import { buildPoolProxyBaseName } from '../../mcp/mcp-pool.ts';
import type { PluginOrigin } from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mcp-tool-hook-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function origin(): PluginOrigin {
  return { source: 'local-path', localPath: tempDir, resolvedAt: 1 };
}

/** A Claude bundle named `name` whose `PostToolUse` group carries `hooks`, with `.mcp.json` when `servers` is given. */
function bundle(name: string, hooks: Array<Record<string, unknown>>, servers?: Record<string, unknown>): string {
  const root = join(tempDir, name);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks }] } }));
  if (servers) writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
  return root;
}

async function importHooks(root: string) {
  const normalized = await normalizeClaudePluginBundle(root, origin());
  const hooks = (normalized.value?.capabilities ?? []).flatMap(capability => capability.kind === 'hook' ? [capability.hook] : []);
  return { normalized, hooks, mcpHooks: hooks.filter(hook => hook.type === 'mcp') };
}

const DB_SERVER = { db: { command: 'node', args: ['server.js'] } };

describe('Claude mcp_tool hooks: the documented server/tool/input shape (UB12.94)', () => {
  it('imports the documented pair against a configured server as its proxy name, with input as the arguments', async () => {
    const { normalized, mcpHooks } = await importHooks(bundle('doc-shape', [
      { type: 'mcp_tool', server: 'db', tool: 'query', input: { q: 'x' } },
    ]));

    expect(normalized.ok).toBe(true);
    expect(normalized.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(mcpHooks).toHaveLength(1);
    expect(mcpHooks[0]!.mcpTool).toBe('mcp__db__query');
    expect(mcpHooks[0]!.mcpArgs).toEqual({ q: 'x' });
  });

  it('maps the scoped name of this plugin\'s own server onto the wire name the resolver mints, which its pass leaves alone', async () => {
    const { normalized, mcpHooks } = await importHooks(bundle('my-plugin', [
      { type: 'mcp_tool', server: 'plugin:my-plugin:db', tool: 'query' },
    ], DB_SERVER));

    expect(normalized.ok).toBe(true);
    const wireName = pluginMcpWireName('my-plugin', 'db');
    expect(mcpHooks.map(hook => hook.mcpTool)).toEqual([buildPoolProxyBaseName(wireName, 'query')]);
    expect(mcpHooks[0]!.mcpTool).toBe(`mcp__${wireName}__query`);
    // `capabilities/resolver.ts` re-qualifies a bare OWN-server key; an already-minted name must come out unchanged.
    expect(translatePluginMcpToolName(mcpHooks[0]!.mcpTool!, 'my-plugin', new Set(['db']))).toBe(mcpHooks[0]!.mcpTool!);
  });

  it('fails only the hook when the scoped name names a server this plugin does not bundle', async () => {
    const { normalized, hooks, mcpHooks } = await importHooks(bundle('my-plugin', [
      { type: 'mcp_tool', server: 'plugin:my-plugin:missing', tool: 'query' },
      { type: 'command', command: 'node format.js' },
    ], DB_SERVER));

    // The bundle imports: its server and its other hook survive.
    expect(normalized.ok).toBe(true);
    expect(normalized.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    expect(normalized.value?.capabilities.some(capability => capability.kind === 'mcp')).toBe(true);
    expect(hooks.map(hook => hook.type)).toEqual(['command']);
    expect(mcpHooks).toEqual([]);
    const refusal = normalized.diagnostics.find(diagnostic => diagnostic.code === 'plugin.format.claude_hook_mcp_tool_unaddressable');
    expect(refusal?.severity).toBe('warning');
    expect(refusal?.path).toBe('hooks/hooks.json.PostToolUse.0.hooks.0');
    expect(refusal?.details).toEqual({ kind: 'hook', server: 'plugin:my-plugin:missing' });
  });

  it('records a ${path} placeholder in input as a deferral rather than calling the tool with literal text', async () => {
    const { normalized, mcpHooks } = await importHooks(bundle('scan-plugin', [
      { type: 'mcp_tool', server: 'my_server', tool: 'security_scan', input: { file_path: '${tool_input.file_path}' } },
    ]));

    expect(normalized.ok).toBe(true);
    expect(mcpHooks).toEqual([]);
    expect(normalized.compatibility?.deferred).toContainEqual({
      externalKind: 'hook-mcp_tool-input-substitution-on-PostToolUse',
      reasonCode: 'plugin.deferred.claude_hook_mcp_tool_input_substitution',
    });
  });

  it('spells the tool segment the way the pool registers it, and refuses a server name no session server can carry', async () => {
    const longTool = 'a_tool_name_that_is_long_enough_to_cross_the_pools_sixty_four_cap';
    const { normalized, mcpHooks } = await importHooks(bundle('names', [
      { type: 'mcp_tool', server: 'db', tool: 'files.read' },
      { type: 'mcp_tool', server: 'db', tool: longTool },
      { type: 'mcp_tool', server: 'plugin:other-plugin:db', tool: 'query' },
      { type: 'mcp_tool', server: 'my server', tool: 'query' },
    ]));

    expect(normalized.ok).toBe(true);
    expect(mcpHooks.map(hook => hook.mcpTool)).toEqual([
      buildPoolProxyBaseName('db', 'files.read'),
      buildPoolProxyBaseName('db', longTool),
      buildPoolProxyBaseName(pluginMcpWireName('other-plugin', 'db'), 'query'),
    ]);
    expect(normalized.diagnostics.filter(diagnostic => diagnostic.code === 'plugin.format.claude_hook_mcp_tool_unaddressable')
      .map(diagnostic => diagnostic.details?.server)).toEqual(['my server']);
  });
});
