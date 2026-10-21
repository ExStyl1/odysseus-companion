/**
 * P6.24 — every `ContentBlock` an MCP tool result can carry reaches the model,
 * or is NAMED as unrenderable. Neither used to be true.
 *
 * The defect: `McpClientPool.callTool`'s flattening loop rendered three of the
 * five `ContentBlock` members the MCP SDK defines (text, image, audio) and let
 * the other two — `resource` and `resource_link` — fall through with no branch.
 * That was invisible for a result made ONLY of a resource, because the loop's
 * `JSON.stringify(result)` fallback fires when nothing at all was extracted and
 * put the whole payload back. It was a SILENT LOSS the moment the result also
 * carried text: the text was extracted, the fallback did not fire, and the
 * resource the server chose to return never reached the model.
 *
 * `mcp.md` is silent on rendering a resource inside a tool RESULT — it
 * specifies resources as `@server:uri` mentions and as the list/read tools
 * (`https://code.claude.com/docs/en/mcp.md#use-mcp-resources`: "MCP servers can
 * expose resources that you can reference using @ mentions, similar to how you
 * reference files.") — so the rendering pinned here is the host's own decision,
 * and what these cases actually pin is the invariant behind it: NO block is
 * dropped without a word.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContentBlockSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';
import type { PoolClient } from '../client.ts';
import { registerFixtureClient } from './pool-fixture.ts';

const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);

/** A client whose single tool returns exactly the blocks under test. */
function blockClient(content: unknown[]): PoolClient {
  return {
    async listTools() { return [tool('read')]; },
    async callTool() { return { content, isError: false }; },
    async close() {},
  } as unknown as PoolClient;
}

const register = (pool: McpClientPool, slug: string, client: PoolClient) =>
  registerFixtureClient(pool, slug, client);

/** 1x1 transparent GIF — real magic bytes, so the extension sniffer resolves. */
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

describe('MCP tool-result content blocks reach the model or are named', () => {
  const tmpDirs: string[] = [];
  const mkSessionDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-pool-blocks-'));
    tmpDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  // THE ROW. Text beside a resource is the shape that lost the resource
  // silently: before the fix this assertion saw `'the answer is 42'` and
  // nothing else, with no diagnostic anywhere.
  it('keeps an embedded text resource that arrives BESIDE a text block', async () => {
    const pool = new McpClientPool({ sessionPath: mkSessionDir() });
    await register(pool, 'ctx', blockClient([
      { type: 'text', text: 'the answer is 42' },
      { type: 'resource', resource: { uri: 'file:///notes/answer.md', mimeType: 'text/markdown', text: '# why 42' } },
    ]));

    const res = await pool.callTool('mcp__ctx__read', {});

    expect(res.isError).toBe(false);
    expect(res.content).toContain('the answer is 42');
    expect(res.content).toContain('# why 42');
    expect(res.content).toContain('file:///notes/answer.md');
  });

  // The boundary the fallback used to hide behind: alone, a resource DID reach
  // the model — as a raw `JSON.stringify` of the whole result. It still
  // reaches it, now rendered rather than dumped.
  it('renders a lone embedded resource instead of falling back to the raw payload', async () => {
    const pool = new McpClientPool({ sessionPath: mkSessionDir() });
    await register(pool, 'ctx', blockClient([
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'alpha' } },
    ]));

    const res = await pool.callTool('mcp__ctx__read', {});

    expect(res.content).toContain('alpha');
    expect(res.content).toContain('file:///a.txt');
    expect(res.content).not.toContain('"isError"');
  });

  it('keeps a resource_link that arrives beside a text block', async () => {
    const pool = new McpClientPool({ sessionPath: mkSessionDir() });
    await register(pool, 'ctx', blockClient([
      { type: 'text', text: 'see also' },
      {
        type: 'resource_link',
        uri: 'https://example.test/report.pdf',
        name: 'Q3 report',
        mimeType: 'application/pdf',
        description: 'the quarterly numbers',
      },
    ]));

    const res = await pool.callTool('mcp__ctx__read', {});

    expect(res.content).toContain('see also');
    expect(res.content).toContain('Q3 report');
    expect(res.content).toContain('https://example.test/report.pdf');
    expect(res.content).toContain('the quarterly numbers');
  });

  it('persists a blob resource into the session downloads dir and names the file', async () => {
    const sessionDir = mkSessionDir();
    const pool = new McpClientPool({ sessionPath: sessionDir });
    await register(pool, 'ctx', blockClient([
      { type: 'text', text: 'here it is' },
      { type: 'resource', resource: { uri: 'file:///pixel.gif', mimeType: 'image/gif', blob: GIF_BASE64 } },
    ]));

    const res = await pool.callTool('mcp__ctx__read', {});

    expect(res.content).toContain('here it is');
    expect(res.content).toContain('Resource saved:');
    expect(res.content).toContain('file:///pixel.gif');
    expect(readdirSync(join(sessionDir, 'downloads')).length).toBe(1);
  });

  // Binary that cannot be persisted has nowhere to go, and saying so is the
  // whole point: the block still costs the model a line, not a silence.
  it('names a blob resource it cannot persist rather than dropping it', async () => {
    const pool = new McpClientPool(); // no session path — nothing to save into
    await register(pool, 'ctx', blockClient([
      { type: 'text', text: 'attached' },
      { type: 'resource', resource: { uri: 'file:///pixel.gif', mimeType: 'image/gif', blob: GIF_BASE64 } },
    ]));

    const res = await pool.callTool('mcp__ctx__read', {});

    expect(res.content).toContain('attached');
    expect(res.content).toContain('file:///pixel.gif');
    expect(res.content).toContain('not shown');
  });

  // The guard for the NEXT block type. This loop's defect was a member of the
  // union with no branch; an SDK revision that adds a sixth reproduces it
  // exactly, and this is what stops it being silent when it does.
  it('names a content block of an unrecognised type', async () => {
    const pool = new McpClientPool({ sessionPath: mkSessionDir() });
    await register(pool, 'ctx', blockClient([
      { type: 'text', text: 'partial' },
      { type: 'hologram', payload: 'whatever a later revision adds' },
    ]));

    const res = await pool.callTool('mcp__ctx__read', {});

    expect(res.content).toContain('partial');
    expect(res.content).toContain('hologram');
  });

  // Byte-compatibility: the two shapes that were already correct must not move.
  it('leaves a text-only result and an empty result exactly as they were', async () => {
    const pool = new McpClientPool({ sessionPath: mkSessionDir() });
    await register(pool, 'ctx', blockClient([{ type: 'text', text: 'plain' }]));
    expect((await pool.callTool('mcp__ctx__read', {})).content).toBe('plain');

    const empty = new McpClientPool({ sessionPath: mkSessionDir() });
    await register(empty, 'ctx', blockClient([]));
    // Nothing extracted → the raw payload, unchanged.
    expect((await empty.callTool('mcp__ctx__read', {})).content).toBe(JSON.stringify({ content: [], isError: false }));
  });

  /**
   * The DENOMINATOR, read from the vendored SDK's own union rather than from
   * prose. AGENTS.md: "the vendored bundle is the denominator and the
   * documentation is a subset of it" — an enumeration written into a comment
   * ages silently, this one cannot. A bump that adds a sixth member fails here,
   * next to the branch that would otherwise drop it.
   */
  it('accounts for every ContentBlock member the vendored MCP SDK declares', () => {
    const options = (ContentBlockSchema as unknown as { options: unknown[] }).options;
    const declared = options.map(option => {
      const shape = (option as { shape: { type: { value?: string } } }).shape;
      return shape.type.value;
    });
    expect(declared).toEqual(['text', 'image', 'audio', 'resource_link', 'resource']);
  });
});
