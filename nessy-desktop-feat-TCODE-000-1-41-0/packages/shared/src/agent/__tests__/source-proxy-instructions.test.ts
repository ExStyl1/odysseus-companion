/**
 * P3.228 — the claude-runtime half: `createSourceProxyServers` passes each
 * source's own `instructions` into the SDK MCP server it builds for that source.
 *
 * The vendored SDK's `CreateSdkMcpServerOptions.instructions` says what the
 * omission cost, verbatim: "When proxying a real MCP server through the SDK
 * transport, pass the underlying server's `getInstructions()` here so it isn't
 * dropped." `mcp.md#scale-with-mcp-tool-search` says why it matters: "Only tool
 * names and server instructions load at session start."
 *
 * Read END TO END rather than off the options object: the assertions connect an
 * in-memory MCP client to the SDK server's own instance and read the
 * `initialize` result, so a value accepted by `createSdkMcpServer` and then
 * dropped before the handshake would still fail.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { PoolClient } from '../../mcp/client.ts';
import { POOLED_RESOURCE_SERVER_NAME } from '../../mcp/pool-server.ts';
import { createSourceProxyServers } from '../claude-agent.ts';
import { registerFixtureClient } from '../../mcp/__tests__/pool-fixture.ts';

const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);

class TestPool extends McpClientPool {
  async register(slug: string, client: PoolClient) {
    return registerFixtureClient(this, slug, client);
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

/** The instructions the SDK server actually reports at `initialize`. */
async function handshakeInstructions(
  server: { instance: McpServer } | undefined,
): Promise<string | undefined> {
  expect(server, 'no proxy server was built for this slug').toBeDefined();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'proxy-instructions-test', version: '1.0.0' });
  await server!.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return client.getInstructions();
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The PER-SOURCE proxies, which is what every assertion below is about.
 *
 * `82b701ea3` gave the map a second inhabitant: one pooled resource server,
 * registered UNCONDITIONALLY under {@link POOLED_RESOURCE_SERVER_NAME} because
 * MCP publishes capabilities in the `initialize` result and has no notification
 * that revises them — a source connecting after the handshake would otherwise be
 * permanently unreadable. It is not a source proxy and never was one, so the
 * key-set assertions read the map WITHOUT it, and its presence is asserted once,
 * by name, rather than smuggled into every expected list.
 */
const sourceProxyNames = (servers: Record<string, unknown>): string[] => {
  expect(Object.keys(servers), 'the pooled resource server is registered unconditionally')
    .toContain(POOLED_RESOURCE_SERVER_NAME);
  return Object.keys(servers).filter(name => name !== POOLED_RESOURCE_SERVER_NAME);
};

describe('createSourceProxyServers carries a source\'s instructions to the model', () => {
  it('forwards the connected server\'s instructions on the proxy it builds', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([tool('createIssue')], 'Search before creating an issue.'));

    const servers = createSourceProxyServers(pool);
    expect(await handshakeInstructions(servers.linear as unknown as { instance: McpServer }))
      .toBe('Search before creating an issue.');
  });

  it('leaves the block absent for a source that published none', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([tool('createIssue')]));

    const servers = createSourceProxyServers(pool);
    // Positive control on the same rig: the proxy WAS built, and its tool is
    // there — so `undefined` below is an absent instructions block, not an
    // absent server.
    expect(sourceProxyNames(servers)).toEqual(['linear']);
    expect(await handshakeInstructions(servers.linear as unknown as { instance: McpServer }))
      .toBeUndefined();
  });

  it('builds a proxy for a ZERO-TOOL source when it has instructions to contribute', async () => {
    // A resources/prompts-only source used to contribute no SDK server at all,
    // and the in-process SDK server type has no `resources`/`prompts` field
    // (P6.25) — so instructions are the only thing it could ever contribute.
    const pool = new TestPool();
    await pool.register('docs', fakeClient([], 'Ask before quoting a doc verbatim.'));

    const servers = createSourceProxyServers(pool);
    expect(sourceProxyNames(servers)).toEqual(['docs']);
    expect(await handshakeInstructions(servers.docs as unknown as { instance: McpServer }))
      .toBe('Ask before quoting a doc verbatim.');
  });

  it('still builds nothing for a zero-tool source with nothing to say', async () => {
    const pool = new TestPool();
    await pool.register('empty', fakeClient([]));

    expect(sourceProxyNames(createSourceProxyServers(pool))).toEqual([]);
  });
});
