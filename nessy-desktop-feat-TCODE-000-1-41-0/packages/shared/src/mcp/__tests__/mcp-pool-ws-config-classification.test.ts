/**
 * `SdkMcpServerConfig` is a four-transport union — `http | sse`, `ws`, `stdio`
 * (`agent/backend/types.ts:793`) — and `registerClient` must recognise all of
 * them as CONFIGS rather than as in-process `McpServer` instances.
 *
 * `ws` was the one it did not, and the consequence was a split connection:
 * `connectMcpServer` keys the connection `["mcp", slug, hash]`, while
 * `registerClient` independently re-derived `["api", slug, n]` for the same
 * server. The client landed under one key and its config under the other, so a
 * WebSocket server worked while being unreachable through every lookup that
 * starts from its config.
 *
 * Mutation probe: drop `|| type === 'ws'` from `isSdkMcpServerConfig` and the
 * `ws` row goes red while the other three stay green.
 */

import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }

  configKeys(): string[] {
    return [...(this as unknown as { activeConfigs: Map<string, unknown> }).activeConfigs.keys()];
  }

  apiKeys(): string[] {
    return [...(this as unknown as { activeApiServers: Map<string, unknown> }).activeApiServers.keys()];
  }
}

const fakeClient = (): PoolClient => ({
  listTools: async (): Promise<Tool[]> => [
    { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } } as Tool,
  ],
  callTool: async () => ({ content: [] }),
  close: async () => {},
});

const CONFIGS: Array<[string, SdkMcpServerConfig]> = [
  ['http', { type: 'http', url: 'https://mcp.example.test/mcp' } as SdkMcpServerConfig],
  ['sse', { type: 'sse', url: 'https://mcp.example.test/sse' } as SdkMcpServerConfig],
  ['stdio', { type: 'stdio', command: 'true' } as unknown as SdkMcpServerConfig],
  ['ws', { type: 'ws', url: 'wss://mcp.example.test/ws' } as unknown as SdkMcpServerConfig],
];

describe('registerClient classifies every transport as a config', () => {
  it.each(CONFIGS)('keys a %s server as an MCP connection, not an API server', async (name, config) => {
    const pool = new TestPool();
    const key = await pool.register(`srv-${name}`, fakeClient(), config);

    // `["mcp", slug, hash]` vs the `["api", slug, n]` an McpServer instance gets.
    expect(JSON.parse(key)[0]).toBe('mcp');
    expect(pool.configKeys()).toContain(key);
    expect(pool.apiKeys()).not.toContain(key);
  });
});
