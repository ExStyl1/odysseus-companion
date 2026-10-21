/**
 * P6.567 hunk (3) / P6.350(a) — one malformed tool schema costs one tool, not a
 * whole server, and the model is told which tool and why.
 *
 * `validation.ts` records the constraint and its 400 verbatim: property keys in
 * a tool input schema "should match pattern '^[a-zA-Z0-9_.-]{1,64}$'", enforced
 * server-side by the Anthropic API and defined by no MCP specification. One
 * violation fails the WHOLE `tools` array, so before this filter a single bad
 * key from a single server silently took down every proxied tool on the turn —
 * and the checker that could have seen it was reachable only from the
 * source-validation path, never from the load path.
 *
 * The drop is applied on all three runtimes (Pi and codex would accept the key)
 * so the model's tool universe does not silently differ by runtime; the honest
 * half of that trade is the notice `getInstructions` now carries.
 */
import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import { ANTHROPIC_PROPERTY_NAME_PATTERN } from '../validation.ts';
import type { PoolClient } from '../client.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const wellFormed = (name: string): Tool => ({
  name,
  description: `desc ${name}`,
  inputSchema: { type: 'object', properties: { queryText: { type: 'string' } } },
} as Tool);

/** A key the API refuses: a space is outside `^[a-zA-Z0-9_.-]{1,64}$`. */
const malformed = (name: string): Tool => ({
  name,
  description: `desc ${name}`,
  inputSchema: { type: 'object', properties: { 'query text': { type: 'string' } } },
} as Tool);

/** The same violation one level down, inside an array's item schema. */
const malformedNested = (name: string): Tool => ({
  name,
  description: `desc ${name}`,
  inputSchema: {
    type: 'object',
    properties: {
      rows: { type: 'array', items: { type: 'object', properties: { 'row id': { type: 'string' } } } },
    },
  },
} as Tool);

class TestPool extends McpClientPool {
  async register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }
  catalogHash(): string {
    return (this as unknown as { effectiveToolCatalogHash(): string }).effectiveToolCatalogHash();
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

const served = (pool: TestPool, slug: string): string[] =>
  pool.getProxyToolDefs([slug]).map(def => def.name);

describe('a malformed tool schema drops the tool, never the server', () => {
  it('serves the healthy tools of a server that also advertises a malformed one', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient([
      wellFormed('createIssue'),
      malformed('searchIssues'),
      wellFormed('listTeams'),
    ]));

    const names = served(pool, 'linear');
    expect(names).toHaveLength(2);
    expect(names.some(name => name.includes('createIssue'))).toBe(true);
    expect(names.some(name => name.includes('listTeams'))).toBe(true);
    // The whole point: the server is still loaded and only the bad tool is gone.
    expect(names.some(name => name.includes('searchIssues'))).toBe(false);
  });

  it('catches the violation nested inside an array item schema', async () => {
    const pool = new TestPool();
    await pool.register('sheets', fakeClient([wellFormed('read'), malformedNested('appendRows')]));

    expect(served(pool, 'sheets').some(name => name.includes('appendRows'))).toBe(false);
    expect(served(pool, 'sheets').some(name => name.includes('read'))).toBe(true);
  });

  it('NEGATIVE CONTROL — a server with only legal keys loses nothing and says nothing', async () => {
    const pool = new TestPool();
    await pool.register('clean', fakeClient(
      [wellFormed('a'), wellFormed('b')],
      'Always search before creating.',
    ));

    expect(served(pool, 'clean')).toHaveLength(2);
    // No notice appended: the pass-through contract is untouched where there is
    // nothing to report, which is every ordinary server.
    expect(pool.getInstructions('clean')).toBe('Always search before creating.');
  });

  it('tells the MODEL the dropped name and the reason, beside the server\'s own prose', async () => {
    const pool = new TestPool();
    await pool.register('linear', fakeClient(
      [wellFormed('createIssue'), malformed('searchIssues')],
      'Always search before creating.',
    ));

    const instructions = pool.getInstructions('linear');
    expect(instructions).toBeDefined();
    // The server's own instructions survive verbatim — the notice is added, not
    // substituted.
    expect(instructions).toContain('Always search before creating.');
    expect(instructions).toContain('searchIssues');
    expect(instructions).toContain(ANTHROPIC_PROPERTY_NAME_PATTERN.source);
    // And it must not name a tool that is being served.
    expect(instructions).not.toContain('createIssue');
  });

  it('answers with the notice for a server that sent no instructions of its own', async () => {
    const pool = new TestPool();
    await pool.register('silent', fakeClient([malformed('broken')]));

    // Previously `undefined`: a server whose only tool was dropped told the
    // model nothing at all, which is the silence the row names.
    expect(pool.getInstructions('silent')).toContain('broken');
  });

  it('the catalog hash and the served list agree about the dropped tool', async () => {
    // If the hash counted a tool the pool never serves, a server flipping that
    // tool's schema would trigger a re-read for a tool no consumer can see.
    const withBad = new TestPool();
    await withBad.register('linear', fakeClient([wellFormed('createIssue'), malformed('searchIssues')]));
    const withoutBad = new TestPool();
    await withoutBad.register('linear', fakeClient([wellFormed('createIssue')]));

    expect(withBad.catalogHash()).toBe(withoutBad.catalogHash());
    expect(served(withBad, 'linear')).toEqual(served(withoutBad, 'linear'));
  });
});
