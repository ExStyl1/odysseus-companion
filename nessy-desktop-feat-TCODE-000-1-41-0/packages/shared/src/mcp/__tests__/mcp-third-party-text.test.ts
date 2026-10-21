/**
 * P3.292 / P3.293 — what an MCP server's own prose does to the model, on the
 * surface where codex reads it.
 *
 * `mcp.md#for-mcp-server-authors`, verbatim: *"Claude Code truncates tool
 * descriptions and server instructions at 2KB each."* Measured before this row,
 * the three runtimes did three different things with the same server: claude
 * capped both natively, Pi capped instructions at 2048 UTF-8 BYTES and nothing
 * else, and codex — `parse_mcp_tool` at `rust-v0.148.0`, `description_limit:
 * None` — capped neither. The tests below drive the pool server end to end,
 * because a cap applied to a value that never reaches the protocol is the same
 * defect one layer over.
 */
import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { MCP_TEXT_MAX_CHARS, MCP_TEXT_TRUNCATION_MARKER, capMcpText } from '../third-party-text.ts';
import { registerFixtureClient } from './pool-fixture.ts';

class TestPool extends McpClientPool {
  async register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
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

/** One protocol session against the pool server: what the runtime is handed. */
async function handshake(pool: McpClientPool): Promise<{ instructions: string | undefined; tools: Tool[] }> {
  const poolServer = new McpPoolServer(pool);
  const client = new Client({ name: 'third-party-text-test', version: '1.0.0' });
  try {
    await poolServer.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(poolServer.url), {
      requestInit: { headers: { authorization: `Bearer ${poolServer.bearerToken}` } },
    }));
    const listed = await client.listTools();
    return { instructions: client.getInstructions(), tools: listed.tools as Tool[] };
  } finally {
    await client.close().catch(() => {});
    await poolServer.stop().catch(() => {});
  }
}

describe('capMcpText — claude\'s measured spelling of the 2KB rule', () => {
  it('leaves anything inside the cap byte-for-byte, marker-free', () => {
    const body = 'a'.repeat(MCP_TEXT_MAX_CHARS);
    expect(capMcpText(body)).toBe(body);
    // The marker is a CLAIM that something was cut; emitting it on an uncut
    // body would make every server look truncated.
    expect(capMcpText(body)).not.toContain(MCP_TEXT_TRUNCATION_MARKER);
  });

  it('cuts at 2048 CODE UNITS, not bytes — the difference the binary decides', () => {
    // The regression this replaces: a byte cap cut a non-ASCII body at roughly
    // half of what claude keeps, so the same server read differently across a
    // switch. Every character here is two UTF-8 bytes and one code unit.
    const body = 'д'.repeat(3000);
    const capped = capMcpText(body);
    expect(capped).toBe(`${'д'.repeat(MCP_TEXT_MAX_CHARS)}${MCP_TEXT_TRUNCATION_MARKER}`);
    // MUTATION KILLED: measuring `Buffer.byteLength`. That reading would cut
    // this body at 1024 characters.
    expect(capped.length - MCP_TEXT_TRUNCATION_MARKER.length).toBe(MCP_TEXT_MAX_CHARS);
  });

  it('never splits a surrogate pair, backing off one unit like the binary does', () => {
    // 1024 astral characters is exactly 2048 code units, so a cut at the limit
    // lands ON the boundary; one more character forces the back-off.
    const body = '\u{1F600}'.repeat(1200);
    const capped = capMcpText(body);
    const kept = capped.slice(0, capped.length - MCP_TEXT_TRUNCATION_MARKER.length);
    expect([...kept]).toHaveLength(1024);
    expect(kept.charCodeAt(kept.length - 1)).toBeGreaterThanOrEqual(0xDC00);

    // Odd offset: one filler unit means the limit falls BETWEEN the halves.
    const odd = capMcpText(`x${'\u{1F600}'.repeat(1200)}`);
    const oddKept = odd.slice(0, odd.length - MCP_TEXT_TRUNCATION_MARKER.length);
    // MUTATION KILLED: dropping the surrogate guard — that leaves a lone high
    // surrogate as the last unit, which is not a character.
    expect(oddKept.length).toBe(MCP_TEXT_MAX_CHARS - 1);
    expect(oddKept.charCodeAt(oddKept.length - 1)).toBeGreaterThanOrEqual(0xDC00);
  });

  it('uses the vendor\'s literal marker, so the same over-long server reads alike on all three', () => {
    // Measured in the vendored native binary (SDK 0.3.233): both the server
    // instructions helper and the MCP tool `prompt()` append this exact string.
    expect(MCP_TEXT_TRUNCATION_MARKER).toBe('… [truncated]');
  });
});

describe('the pool server caps what a source says about itself', () => {
  it('caps each source\'s instructions BEFORE the join, not the composed string', async () => {
    // This surface flattens N sources into one `instructions` slot. A cap on the
    // join would let a first verbose source spend the budget of every source
    // after it, so `quiet` below is the load-bearing assertion.
    const pool = new TestPool();
    await pool.register('loud', fakeClient(
      [{ name: 'a', description: 'd', inputSchema: { type: 'object', properties: {} } } as Tool],
      `HEAD_MARK${'x'.repeat(4000)}TAIL_MARK`,
    ));
    await pool.register('quiet', fakeClient(
      [{ name: 'b', description: 'd', inputSchema: { type: 'object', properties: {} } } as Tool],
      'Prefer database queries.',
    ));

    const { instructions } = await handshake(pool);
    expect(instructions).toContain('## loud\n\nHEAD_MARK');
    // MUTATION KILLED: forwarding the instructions uncapped.
    expect(instructions).not.toContain('TAIL_MARK');
    expect(instructions).toContain(MCP_TEXT_TRUNCATION_MARKER);
    // MUTATION KILLED: capping the joined string instead of each source.
    expect(instructions).toContain('## quiet\n\nPrefer database queries.');
  });

  it('caps a tool DESCRIPTION, the half codex applies no cap to on this path', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([
      {
        name: 'createIssue',
        description: `HEAD_MARK${'y'.repeat(4000)}TAIL_MARK`,
        inputSchema: { type: 'object', properties: {} },
      } as Tool,
      {
        name: 'search',
        description: 'Search issues.',
        inputSchema: { type: 'object', properties: {} },
      } as Tool,
    ]));

    const { tools } = await handshake(pool);
    const big = tools.find(entry => entry.name.endsWith('createIssue'));
    expect(big?.description).toContain('HEAD_MARK');
    // MUTATION KILLED: passing `def.description` through.
    expect(big?.description).not.toContain('TAIL_MARK');
    expect(big?.description?.endsWith(MCP_TEXT_TRUNCATION_MARKER)).toBe(true);
    // CONTROL: a short description on the same listing is untouched, so the cap
    // is a cut and not a rewrite of every tool.
    expect(tools.find(entry => entry.name.endsWith('search'))?.description).toBe('Search issues.');
  });

  it('P3.293 CONTROL: neither field is fenced, wrapped or annotated', async () => {
    // The posture decided once for three, and it is a NEGATIVE: the claude
    // binary hands both fields to the model unframed, codex's
    // `regular_mcp_tool_info_from_listed_tool` copies `instructions` into
    // `namespace_description` verbatim, so we add nothing here either. A fence
    // on one runtime alone would make a server's own words read differently
    // after a switch.
    const pool = new TestPool();
    await pool.register('linear', fakeClient(
      [{ name: 'createIssue', description: 'Create an issue.', inputSchema: { type: 'object', properties: {} } } as Tool],
      'Search before creating.',
    ));

    const { instructions, tools } = await handshake(pool);
    expect(instructions).toBe('## linear\n\nSearch before creating.');
    expect(tools[0]?.description).toBe('Create an issue.');
    for (const text of [instructions ?? '', tools[0]?.description ?? '']) {
      expect(text).not.toContain('untrusted');
      expect(text).not.toContain('UNTRUSTED');
    }
  });
});
