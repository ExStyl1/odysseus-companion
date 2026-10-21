/**
 * P3.228 — an MCP server's own `instructions` reach the model.
 *
 * `mcp.md#scale-with-mcp-tool-search`: "Only tool names and server instructions
 * load at session start." Instructions are therefore HALF of what the model
 * knows about a server before it searches for a tool, and this repo proxied
 * every source while passing none — on any runtime.
 *
 * The vendored SDK states the cost verbatim, in
 * `CreateSdkMcpServerOptions.instructions`: "When proxying a real MCP server
 * through the SDK transport, pass the underlying server's `getInstructions()`
 * here so it isn't dropped."
 *
 * Two delivery surfaces, because there are two: `createSourceProxyServers`
 * (claude-runtime, one SDK server per source) and `McpPoolServer` (the HTTP
 * surface Pi and Codex subprocesses speak, N sources flattened into one).
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import { ApiSourcePoolClient } from '../api-source-pool-client.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);

/** Reach the protected registerClient without a live transport. */
class TestPool extends McpClientPool {
  async register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
  async drop(slug: string, connectionKey: string) {
    return (this as unknown as {
      disconnect(slug: string, connectionKey: string): Promise<void>;
    }).disconnect(slug, connectionKey);
  }
}

function fakeClient(tools: Tool[], instructions?: string): PoolClient {
  return {
    async listTools() { return tools; },
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
    async close() {},
    ...(instructions === undefined ? {} : { getInstructions: () => instructions }),
  } as unknown as PoolClient;
}

describe('pool captures a server\'s instructions', () => {
  it('exposes the connected server\'s instructions per slug', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([tool('createIssue')], 'Always search before creating.'));

    expect(pool.getInstructions('linear')).toBe('Always search before creating.');
    // Positive control on the same rig: the surface that already worked.
    expect(pool.getTools('linear').map(entry => entry.name)).toEqual(['createIssue']);
  });

  it('reports no instructions for a server that returned none, or only whitespace', async () => {
    const pool = new TestPool();
    await pool.register('silent', fakeClient([tool('a')]));
    await pool.register('blank', fakeClient([tool('b')], '   \n  '));

    // A server that said nothing must not spend prompt budget saying nothing.
    expect(pool.getInstructions('silent')).toBeUndefined();
    expect(pool.getInstructions('blank')).toBeUndefined();
  });

  it('stops answering once the connection is gone, rather than serving stale prose', async () => {
    const pool = new TestPool();
    const connectionKey = await pool.register('linear', fakeClient([tool('a')], 'Use the search tool first.'));
    expect(pool.getInstructions('linear')).toBe('Use the search tool first.');

    await pool.drop('linear', connectionKey);
    expect(pool.getInstructions('linear')).toBeUndefined();
  });

  it('captures instructions from an in-process API source too, not only a protocol server', async () => {
    // The exemption to check for: `ApiSourcePoolClient` is in-process. It still
    // performs a real `initialize` over the in-memory transport, so it is NOT
    // silently exempt from what the model is told about a server.
    const server = new McpServer(
      { name: 'api-source', version: '1.0.0' },
      { instructions: 'This source is read-only.' },
    );
    server.tool('ping', {}, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));

    const pool = new TestPool();
    await pool.register('api', new ApiSourcePoolClient(server), undefined);
    expect(pool.getInstructions('api')).toBe('This source is read-only.');
  });
});

describe('McpPoolServer forwards instructions to a subprocess runtime', () => {
  async function readInstructions(pool: McpClientPool): Promise<string | undefined> {
    const poolServer = new McpPoolServer(pool);
    const client = new Client({ name: 'instructions-test', version: '1.0.0' });
    try {
      await poolServer.start();
      await client.connect(new StreamableHTTPClientTransport(new URL(poolServer.url), {
        requestInit: { headers: { authorization: `Bearer ${poolServer.bearerToken}` } },
      }));
      return client.getInstructions();
    } finally {
      await client.close().catch(() => {});
      await poolServer.stop().catch(() => {});
    }
  }

  it('labels each source\'s instructions by slug, because N servers are flattened into one', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([tool('createIssue')], 'Search before creating.'));
    await pool.register('notion', fakeClient([tool('query')], 'Prefer database queries.'));

    const instructions = await readInstructions(pool);
    // The slug heading is the ONLY thing attributing a paragraph to a server on
    // this surface — dropping it would merge two servers' prose into one voice.
    expect(instructions).toBe(
      '## linear\n\nSearch before creating.\n\n## notion\n\nPrefer database queries.',
    );
  });

  it('sends no instructions block at all when no source has any', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([tool('createIssue')]));

    expect(await readInstructions(pool)).toBeUndefined();
    // Positive control: the handshake this asserts nothing about did happen.
    expect(pool.getTools('linear')).toHaveLength(1);
  });
});

describe('the pool client wrappers both read the underlying client', () => {
  it('ApiSourcePoolClient returns the in-process server\'s instructions', async () => {
    const server = new McpServer(
      { name: 'inproc', version: '1.0.0' },
      { instructions: 'Only call this during a review.' },
    );
    const client = new ApiSourcePoolClient(server);
    await client.connect();
    try {
      expect(client.getInstructions()).toBe('Only call this during a review.');
    } finally {
      await client.close();
    }
  });

  it('an in-memory MCP server with no instructions reports undefined', async () => {
    const server = new McpServer({ name: 'inproc', version: '1.0.0' });
    const client = new ApiSourcePoolClient(server);
    await client.connect();
    try {
      expect(client.getInstructions()).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});
