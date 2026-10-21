/**
 * `alwaysLoad` parsing across the three surfaces that can declare it.
 *
 * Documented contract (code.claude.com/docs/en/mcp, "Scale with MCP tool
 * search"): `alwaysLoad: true` in a server's configuration loads every tool from
 * that server at session start regardless of tool search, and a server may also
 * pin ONE tool by putting `"anthropic/alwaysLoad": true` in that tool's `_meta`.
 */

import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SourceServerBuilder } from '../../sources/server-builder.ts';
import type { FolderSourceConfig, LoadedSource } from '../../sources/types.ts';
import { parseMcpServersDocument } from '../project-config.ts';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

function mcpSource(mcp: FolderSourceConfig['mcp']): LoadedSource {
  return {
    config: {
      id: 'id', slug: 'srv', name: 'Srv', type: 'mcp', enabled: true, provider: 'custom', mcp,
    } as FolderSourceConfig,
    guide: null,
    folderPath: '/tmp/sources/srv',
    workspaceRootPath: '/tmp',
    workspaceId: 'ws',
  };
}

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

const fakeClient = (tools: Tool[]): PoolClient => ({
  listTools: async () => tools,
  callTool: async () => ({ content: [] }),
  close: async () => {},
});

const tool = (name: string, extra: Partial<Tool> = {}): Tool =>
  ({ name, description: name, inputSchema: { type: 'object', properties: {} }, ...extra } as Tool);

describe('alwaysLoad in server configuration', () => {
  it('carries an MCP source alwaysLoad onto the server config', () => {
    expect(new SourceServerBuilder().buildMcpServer(
      mcpSource({ transport: 'http', url: 'https://mcp.example.test/mcp', alwaysLoad: true }),
      null,
    )).toMatchObject({ alwaysLoad: true });
  });

  it('reads alwaysLoad from a .mcp.json entry and omits it otherwise', () => {
    const servers = parseMcpServersDocument({
      mcpServers: {
        pinned: { type: 'http', url: 'https://mcp.example.test/mcp', alwaysLoad: true },
        normal: { type: 'http', url: 'https://mcp.example.test/mcp' },
      },
    });
    expect(servers.pinned).toMatchObject({ alwaysLoad: true });
    expect('alwaysLoad' in servers.normal!).toBe(false);
  });
});

describe('McpClientPool.alwaysLoadProxyToolNames', () => {
  it('pins every tool of a server whose config sets alwaysLoad', async () => {
    const pool = new TestPool();
    await pool.register('pinned', fakeClient([tool('one'), tool('two')]), {
      type: 'http', url: 'https://mcp.example.test/mcp', alwaysLoad: true,
    });

    expect([...pool.alwaysLoadProxyToolNames()].sort())
      .toEqual(['mcp__pinned__one', 'mcp__pinned__two']);
  });

  it('pins a single tool that declares anthropic/alwaysLoad in its _meta', async () => {
    const pool = new TestPool();
    await pool.register('srv', fakeClient([
      tool('pinned', { _meta: { 'anthropic/alwaysLoad': true } }),
      tool('plain'),
      // Only the JSON boolean `true` counts, matching the sibling
      // `requiresUserInteraction` rule ("any other value is ignored").
      tool('stringy', { _meta: { 'anthropic/alwaysLoad': 'true' } }),
    ]), { type: 'http', url: 'https://mcp.example.test/mcp' });

    expect([...pool.alwaysLoadProxyToolNames()]).toEqual(['mcp__srv__pinned']);
  });

  it('is empty when nothing is pinned', async () => {
    const pool = new TestPool();
    await pool.register('srv', fakeClient([tool('one')]), {
      type: 'http', url: 'https://mcp.example.test/mcp',
    });
    expect([...pool.alwaysLoadProxyToolNames()]).toEqual([]);
  });
});
