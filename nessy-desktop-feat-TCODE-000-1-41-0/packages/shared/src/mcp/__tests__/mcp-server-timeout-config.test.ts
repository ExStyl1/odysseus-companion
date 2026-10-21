/**
 * The per-server tool timeout as a USER-configurable field.
 *
 * `SdkMcpServerConfig.toolTimeoutMs` already existed and was already honoured by
 * `McpClientPool.callTool`, but only plugin-imported MCP servers could set it:
 * neither a user-configured MCP source nor a project `.mcp.json` entry had any
 * way to express a per-server ceiling.
 */

import { describe, expect, it } from 'bun:test';
import { SourceServerBuilder } from '../../sources/server-builder.ts';
import type { FolderSourceConfig, LoadedSource } from '../../sources/types.ts';
import { parseMcpServersDocument } from '../project-config.ts';

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

describe('per-server tool timeout in user configuration', () => {
  const builder = new SourceServerBuilder();

  it.each([
    ['http', { transport: 'http' as const, url: 'https://mcp.example.test/mcp', timeoutMs: 600_000 }],
    ['stdio', { transport: 'stdio' as const, command: '/bin/true', timeoutMs: 600_000 }],
  ])('carries an MCP source timeout onto the %s server config', (_label, mcp) => {
    expect(builder.buildMcpServer(mcpSource(mcp), null)).toMatchObject({ toolTimeoutMs: 600_000 });
  });

  it('omits the field when a source declares no timeout', () => {
    const built = builder.buildMcpServer(mcpSource({ transport: 'http', url: 'https://mcp.example.test/mcp' }), null);
    expect(built && 'toolTimeoutMs' in built).toBe(false);
  });

  it('reads the documented `timeout` field from a .mcp.json entry', () => {
    const servers = parseMcpServersDocument({
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example.test/mcp', timeout: 600_000 } },
    });
    expect(servers.docs).toMatchObject({ toolTimeoutMs: 600_000 });
  });

  it('ignores a .mcp.json timeout below the documented 1000ms floor', () => {
    // Documented: "Values below 1000 are ignored and fall through to
    // MCP_TOOL_TIMEOUT" — a 5ms ceiling would abort every call instantly.
    const servers = parseMcpServersDocument({
      mcpServers: { docs: { type: 'http', url: 'https://mcp.example.test/mcp', timeout: 5 } },
    });
    expect('toolTimeoutMs' in servers.docs!).toBe(false);
  });
});
