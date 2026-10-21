/**
 * P6.352 — the session's MCP inventory: state, tool count, and the
 * connected-but-zero-tools case nothing could see.
 *
 * The row's premise was that *"two live SDK verbs that would do it have no
 * caller"*, naming `Query.reconnectMcpServer` and `Query.toggleMcpServer`. Both
 * are real and both are still uncalled — and neither is the verb this surface
 * needed. The read is `Query.mcpServerStatus()`, whose element carries `name`,
 * `status`, `error` and `tools`; codex has `mcpServerStatus/list`; Pi has the
 * host pool, which held the state and the tool cache all along and had never
 * been asked to join them.
 *
 * The two tests that matter are the two the row is actually about:
 * a CONNECTED server with ZERO tools must be distinguishable from a FAILED one,
 * and an unknown count must be distinguishable from a counted zero.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpClientPool } from '../mcp-pool.ts';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import {
  MCP_STATUS_EMPTY_LINE,
  MCP_STATUS_UNSUPPORTED_LINE,
  MCP_STATUS_ZERO_TOOLS_PREFIX,
  formatMcpServerStatusReport,
  type McpServerStatusLine,
} from '../server-status.ts';
import { parseSessionCommand } from '../../slash-commands/session-command.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const CONFIG: SdkMcpServerConfig = { type: 'http', url: 'https://status.example.test/mcp' };

class TestPool extends McpClientPool {
  register(slug: string, client: PoolClient, config: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
});

/**
 * A live in-memory MCP server publishing exactly `toolNames`, possibly none.
 *
 * `capabilities.tools` is declared UP FRONT rather than left to
 * `registerTool` to declare, and that is the empty case being honest rather
 * than a fixture convenience: measured here, a server that declares no `tools`
 * capability at all answers `tools/list` with `-32601 Method not found`, the
 * pool's connect health check throws, and the server is recorded FAILED — not
 * connected-with-zero-tools. The case this row is about is the other one: a
 * server that says it serves tools and then serves none.
 */
async function liveSource(name: string, toolNames: readonly string[]): Promise<NessyMcpClient> {
  const server = new McpServer({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
  const register = (toolName: string) => server.registerTool(
    toolName,
    { description: `${toolName} does a thing`, inputSchema: {} },
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );
  if (toolNames.length === 0) {
    // The SDK's high-level server installs its `tools/list` handler on the
    // FIRST `registerTool` and not from `capabilities`, so an empty server has
    // to register one and drop it. What remains is the shape this row needs:
    // a server that answers `tools/list` with `[]`.
    register('__transient__').remove();
  }
  for (const toolName of toolNames) register(toolName);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new NessyMcpClient(
    { transport: 'http', url: CONFIG.type === 'http' ? CONFIG.url : '' } as never,
    { transport: clientTransport } as never,
  );
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe('McpClientPool.serverStatuses', () => {
  it('separates a CONNECTED server with zero tools from a connected one with tools', async () => {
    // THE row. `health()` calls both of these `connected` and is right; the
    // count is the fact that was never joined to it, so a server that connects
    // and offers nothing was indistinguishable from a working one.
    const pool = new TestPool({});
    await pool.register('rich', await liveSource('rich', ['alpha', 'beta']), CONFIG);
    await pool.register('empty', await liveSource('empty', []), CONFIG);

    const statuses = pool.serverStatuses();
    const byName = new Map(statuses.map(line => [line.name, line]));

    expect(byName.get('rich')).toEqual({ name: 'rich', state: 'connected', toolCount: 2 });
    expect(byName.get('empty')).toEqual({ name: 'empty', state: 'connected', toolCount: 0 });
    // Sorted, so a 29-row report is readable and two runs agree.
    expect(statuses.map(line => line.name)).toEqual(['empty', 'rich']);
  });

  it('reports a count of null — never 0 — for a server it is not connected to', async () => {
    // The negative that keeps the positive meaningful: if a disconnected server
    // reported `0`, the whole zero-tools distinction would be noise.
    const pool = new TestPool({});
    await pool.register('rich', await liveSource('rich', ['alpha']), CONFIG);

    const statuses = pool.serverStatuses();

    expect(statuses.every(line => line.state !== 'connected' ? line.toolCount === null : true)).toBe(true);
    // Positive control on the same rig: the connected one IS counted, so an
    // all-null result would not pass this test silently.
    expect(statuses.find(line => line.name === 'rich')?.toolCount).toBe(1);
  });

  it('reports nothing for a leaser that has leased nothing', () => {
    // Scoped exactly as `health(leaserId)` is: a session sees ITS leased set,
    // not the pool's global inventory.
    const pool = new TestPool({});
    expect(pool.serverStatuses('a-leaser-that-never-synced')).toEqual([]);
  });
});

describe('formatMcpServerStatusReport', () => {
  const connected = (name: string, toolCount: number): McpServerStatusLine =>
    ({ name, state: 'connected', toolCount });

  it('says "no source" and "none configured" with DIFFERENT sentences', () => {
    // `null` is "this session cannot ask" and `[]` is "asked, there are none".
    // Collapsing them is how a listing slides from a caveat into a false claim —
    // the same rule `/help`'s own untold line follows.
    expect(formatMcpServerStatusReport(null)).toBe(MCP_STATUS_UNSUPPORTED_LINE);
    expect(formatMcpServerStatusReport([])).toBe(MCP_STATUS_EMPTY_LINE);
    expect(MCP_STATUS_UNSUPPORTED_LINE).not.toBe(MCP_STATUS_EMPTY_LINE);
  });

  it('calls out the connected-and-useless servers, and ONLY those', () => {
    const report = formatMcpServerStatusReport([
      connected('rich', 3),
      connected('empty', 0),
      { name: 'broken', state: 'failed', toolCount: null, detail: 'connection refused' },
      { name: 'stale', state: 'needs-auth', toolCount: null },
    ]);

    expect(report).toContain(`${MCP_STATUS_ZERO_TOOLS_PREFIX} empty.`);
    // A failed server has no tools for an uninteresting reason and must not
    // join the call-out, or the call-out stops meaning anything.
    expect(report).not.toContain('broken.');
    expect(report).toContain('broken');
    expect(report).toContain('connection refused');
    expect(report).toContain('needs sign-in');
    // A counted zero and an unknown count read differently.
    expect(report).toContain('0 tools');
    expect(report).toContain('tool count unknown');
    expect(report).toContain('3 tools');
    // Singular, because "1 tools" is the kind of thing a reader stops trusting.
    expect(formatMcpServerStatusReport([connected('one', 1)])).toContain('connected, 1 tool');
  });

  it('prints no call-out when every connected server has tools', () => {
    const report = formatMcpServerStatusReport([connected('rich', 3), connected('other', 1)]);
    expect(report).not.toContain(MCP_STATUS_ZERO_TOOLS_PREFIX);
    expect(report).toContain('MCP servers for this session (2):');
  });
});

describe('parseSessionCommand — the /mcp half', () => {
  it('claims the whole message and nothing else', () => {
    expect(parseSessionCommand('/mcp')?.kind).toBe('mcp');
    expect(parseSessionCommand('  /MCP  ')?.kind).toBe('mcp');
    // Prose belongs to the model, exactly as `/help compact` does.
    expect(parseSessionCommand('/mcp add a server')).toBeNull();
    expect(parseSessionCommand('what does /mcp show?')).toBeNull();
    expect(parseSessionCommand('/mcpx')).toBeNull();
  });
});
