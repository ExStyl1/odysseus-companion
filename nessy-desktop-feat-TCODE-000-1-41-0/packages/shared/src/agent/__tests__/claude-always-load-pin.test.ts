/**
 * P2.454 — the claude-runtime half of the user's `alwaysLoad` pin.
 *
 * The flag reached the pool and stopped there. `capabilities/resolver.ts` said
 * so in prose for weeks: the per-server `alwaysLoad` is carried into the
 * resolved MCP server, `pi-agent.ts` reads it back out
 * (`mcpPool.alwaysLoadProxyToolNames`) to pin those tools out of deferral, and
 * `createSourceProxyServers` wrote neither of the two places the vendored SDK
 * accepts it. A user who pinned a server on claude-runtime got deferral anyway,
 * silently.
 *
 * ## Why PER TOOL and not per server
 *
 * `mcp.md#exempt-a-server-from-deferral` documents both spellings, and the pool's
 * set is the UNION of them — a server-level config pin is already expanded to
 * every tool of that server inside `alwaysLoadProxyToolNames`. So writing the
 * server-level flag from that set would pin a whole source whenever ONE tool
 * asked. The SDK's own wording forbids the "pass both to be safe" reading:
 * `CreateSdkMcpServerOptions.alwaysLoad` — *"Per-tool `tool({ alwaysLoad })`
 * still works and is OR'd with this."*
 *
 * ## Read where the runtime reads it
 *
 * Not off the options object. The vendored `tool()` turns the extras into
 * `_meta` (`if(o?.alwaysLoad)i["anthropic/alwaysLoad"]=!0`), and
 * `createSdkMcpServer` hands that `_meta` to `registerTool`, so the pin is
 * observable at `tools/list`. These tests connect an in-memory MCP client to the
 * built server's own instance and read it there — the same end-to-end instrument
 * `source-proxy-instructions.test.ts` uses, for the same reason: a value
 * accepted and then dropped before the handshake would still fail.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import type { PoolClient } from '../../mcp/client.ts';
import { createSourceProxyServers } from '../claude-agent.ts';

/** The wire key, spelled out rather than imported: it is a CONTRACT with the runtime. */
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';

function toolDef(name: string, pinned = false): Tool {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: {} },
    ...(pinned ? { _meta: { [ALWAYS_LOAD_META]: true } } : {}),
  } as Tool;
}

/**
 * DA3.16 — this is the ONE fixture deliberately left on `registerClient`, and
 * the reason is the case below, not inertia.
 *
 * `registerFixtureClient` (`mcp/__tests__/pool-fixture.ts`) is what every other
 * fixture uses now: it drives the real `connect`, so the connection key is the
 * pool's and `registerClient` gets all four arguments. `connect` also writes
 * `activeConfigs` — and the server-level-pin case in this file exists precisely
 * because `activeConfigs` is EMPTY on this path. Migrating it would make the
 * case pass for a different reason than the one it was written to measure.
 */
class TestPool extends McpClientPool {
  async register(slug: string, client: PoolClient) {
    return this.registerClient(slug, client);
  }
}

function fakeClient(tools: Tool[]): PoolClient {
  return {
    async listTools() { return tools; },
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
    async close() {},
  } as unknown as PoolClient;
}

/** `_meta` per tool name, as the model-facing `tools/list` reports it. */
async function pinsAtHandshake(server: { instance: McpServer }): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'always-load-pin-test', version: '1.0.0' });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return Object.fromEntries(listed.tools.map(entry => [
      entry.name,
      (entry as { _meta?: Record<string, unknown> })._meta?.[ALWAYS_LOAD_META],
    ]));
  } finally {
    await client.close().catch(() => {});
  }
}

describe('P2.454 · a pinned proxy tool is exempt from deferral on claude-runtime', () => {
  /**
   * KILLS THE ROW'S MUTANT: remove the spread on the tool constructor's extras
   * and the tool that asked to be pinned comes back with no `_meta`, i.e.
   * deferred behind tool search exactly as before the row.
   *
   * The unpinned sibling in the SAME server is the positive-and-negative pair in
   * one assertion: it proves the read works (the pinned one is `true`) and that
   * the pin is per tool (the sibling is not).
   */
  it('pins only the tool that asked, and leaves its sibling deferrable', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([toolDef('createIssue', true), toolDef('listIssues')]));

    const servers = createSourceProxyServers(pool);
    expect(await pinsAtHandshake(servers.linear as unknown as { instance: McpServer })).toEqual({
      createIssue: true,
      listIssues: undefined,
    });
  });

  /**
   * KILLS: pinning everything (the server-level spelling, or a spread whose
   * condition is inverted or dropped). A source nobody pinned must be
   * byte-identical to before this row.
   */
  it('leaves an unpinned source entirely alone', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([toolDef('createIssue'), toolDef('listIssues')]));

    const servers = createSourceProxyServers(pool);
    expect(await pinsAtHandshake(servers.linear as unknown as { instance: McpServer })).toEqual({
      createIssue: undefined,
      listIssues: undefined,
    });
  });

  /**
   * KILLS: reading the pool set with the wrong key. `alwaysLoadProxyToolNames`
   * returns PROXY names (`mcp__slug__segment`), while `tool()` is given the
   * segment — so a `has()` against the segment silently never matches, which is
   * a spread that looks right and pins nothing.
   */
  it('matches the pool set by proxy name, not by the segment tool() receives', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([toolDef('createIssue', true)]));
    const pinned = [...pool.alwaysLoadProxyToolNames(['linear'])];
    expect(pinned).toEqual(['mcp__linear__createIssue']);
    // The name `tool()` is handed is the segment alone, so the two are different
    // strings and only one of them is in the set.
    expect(pinned[0]).not.toBe('createIssue');
  });

  /**
   * KILLS: a server-level pin failing to reach the tools. This is the shape the
   * user actually configures (`"alwaysLoad": true` on the server), which the
   * pool expands to every tool of that server — so all of them come back pinned
   * here, and that is correct: the user pinned the source.
   */
  it('honours a server-level pin by expanding it through the pool, per tool', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([toolDef('createIssue'), toolDef('listIssues')]));
    // MEASURED, and it is why this is done by hand: `registerClient` — the only
    // route a test without a config loader has — never writes `activeConfigs`.
    // That map is written by the CONNECT path, so the user's server config has
    // to be seeded at the key `preferredConnectionKey` will look under, found
    // through the pool's own slug index rather than guessed.
    const internals = pool as unknown as {
      activeConfigs: Map<string, { alwaysLoad?: boolean }>;
      connectionSlugs: Map<string, string>;
    };
    const connectionKey = [...internals.connectionSlugs].find(([, slug]) => slug === 'linear')?.[0];
    expect(connectionKey, 'the pool holds no connection key for the registered slug').toBeDefined();
    internals.activeConfigs.set(connectionKey!, { alwaysLoad: true });

    const servers = createSourceProxyServers(pool);
    expect(await pinsAtHandshake(servers.linear as unknown as { instance: McpServer })).toEqual({
      createIssue: true,
      listIssues: true,
    });
  });
});
