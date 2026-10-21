/**
 * UB7.11 — the pool's agent-facing prompt reads (`listPrompts`, `getPromptText`):
 * pagination with the truncated flag, the rendered+guarded prompt text, and the
 * honest refusals (not connected, API source, capability not declared). The
 * user-command `getPrompt` contract is untouched; the fixtures here are fake
 * `PoolClient`s through `registerFixtureClient` (DA3.16), like the rest of the
 * pool suites.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientPool } from '../mcp-pool.ts';
import type { McpPromptGetResult, McpPromptListPage, PoolClient } from '../client.ts';
import { registerFixtureClient } from './pool-fixture.ts';

/** A minimal prompt-serving client: capabilities + paged listing + get. */
function promptClient(pages: Array<{ prompts: unknown[]; nextCursor?: string }>, prompts: Record<string, McpPromptGetResult>): PoolClient {
  let call = 0;
  return {
    async callTool() { return {}; },
    async close() {},
    async listTools() { return []; },
    getServerCapabilities() { return { prompts: {} }; },
    async listPrompts(cursor?: string): Promise<McpPromptListPage> {
      void cursor;
      const page = pages[Math.min(call, pages.length - 1)]!;
      call++;
      return page;
    },
    async getPrompt(name: string): Promise<McpPromptGetResult> {
      const result = prompts[name];
      if (!result) throw new Error(`unknown prompt ${name}`);
      return result;
    },
  };
}

describe('McpClientPool prompt reads (UB7.11)', () => {
  it('positive: a paged listing walks every page and reports honest truncation; getPromptText renders role, description and arguments', async () => {
    const pool = new McpClientPool();
    await registerFixtureClient(pool, 'bookmarks', promptClient(
      [
        { prompts: [{ name: 'one' }], nextCursor: 'c1' },
        { prompts: [{ name: 'two' }], nextCursor: 'c2' },
        { prompts: [{ name: 'three' }] },
      ],
      {
        one: {
          description: 'Say hello',
          messages: [{ role: 'user', content: { type: 'text', text: 'Hello about topic' } }],
        },
      },
    ));

    const listing = await pool.listPrompts('bookmarks');
    expect(listing.truncated).toBe(false);
    expect(listing.prompts.map(prompt => prompt.name)).toEqual(['one', 'two', 'three']);

    const text = await pool.getPromptText('bookmarks', 'one', { topic: 'MCP' });
    expect(text).toBe('Description: Say hello\n\n[user]\nHello about topic');
  });

  it('boundary: a cursor the server repeats ends the walk with truncated: true, instead of looping', async () => {
    const pool = new McpClientPool();
    await registerFixtureClient(pool, 'looping', promptClient(
      [
        { prompts: [{ name: 'a' }], nextCursor: 'same' },
        { prompts: [{ name: 'b' }], nextCursor: 'same' },
      ],
      {},
    ));

    const listing = await pool.listPrompts('looping');
    expect(listing.truncated).toBe(true);
    expect(listing.prompts.map(prompt => prompt.name)).toEqual(['a', 'b']);
  });

  it('a source with no prompts capability is refused with the agent-readable sentence, and a connected capable source with an empty page answers as an empty listing', async () => {
    const pool = new McpClientPool();
    await registerFixtureClient(pool, 'muted', {
      async callTool() { return {}; },
      async close() {},
      async listTools() { return []; },
      getServerCapabilities() { return {}; },
      async listPrompts(): Promise<McpPromptListPage> { return { prompts: [] }; },
      async getPrompt(): Promise<McpPromptGetResult> { return { messages: [] }; },
    });

    // Negative (control): the capability refusal names the source and the capability — the model can act on it.
    expect(pool.listPrompts('muted')).rejects.toThrow('Source "muted" does not offer prompts: its MCP server did not declare the prompts capability.');
    expect(pool.getPromptText('muted', 'p')).rejects.toThrow('does not offer prompts');

    // Positive control on the same instrument: the sentence is DIFFERENT for an
    // API source (missing methods), so the refusal is not one blanket message.
    await registerFixtureClient(pool, 'api-ish', {
      async callTool() { return {}; },
      async close() {},
      async listTools() { return []; },
      getServerCapabilities() { return { prompts: {} } },
    } as PoolClient);
    expect(pool.listPrompts('api-ish')).rejects.toThrow('Source "api-ish" is an API source; only MCP sources offer prompts.');

    // Positive control on the same instrument: an unknown slug reads as not connected.
    expect(pool.listPrompts('ghost')).rejects.toThrow('Source "ghost" is not connected');
  });

  it('a prompt output over the large-result limit goes through the guard: the summary replaces the text, a small one passes through', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'mcp-prompts-guard-'));
    const previousLimit = process.env.NESSY_MCP_OUTPUT_TOKENS;
    delete process.env.NESSY_MCP_OUTPUT_TOKENS;
    process.env.NESSY_MCP_OUTPUT_TOKENS = '20';
    try {
      const pool = new McpClientPool({ sessionPath });
      pool.setSummarizeCallback(async () => 'SUMMARIZED BY THE GUARD');
      await registerFixtureClient(pool, 'noisy', promptClient(
        [{ prompts: [{ name: 'big' }, { name: 'small' }] }],
        {
          big: { messages: [{ role: 'user', content: { type: 'text', text: 'word '.repeat(400) } }] },
          small: { messages: [{ role: 'user', content: { type: 'text', text: 'tiny' } }] },
        },
      ));

      // Negative → positive: the oversized prompt comes back through the guard —
      // its message carries the summary (plus the saved-full-text notice), and
      // the planted body itself does not reach the model inline.
      const guarded = await pool.getPromptText('noisy', 'big');
      expect(guarded).toContain('SUMMARIZED BY THE GUARD');
      expect(guarded).toContain('long_responses/');
      expect(guarded.includes('word '.repeat(50))).toBe(false);

      // Control on the same instrument: under the limit the text passes unguarded.
      const passed = await pool.getPromptText('noisy', 'small');
      expect(passed).toBe('[user]\ntiny');
    } finally {
      if (previousLimit === undefined) delete process.env.NESSY_MCP_OUTPUT_TOKENS;
      else process.env.NESSY_MCP_OUTPUT_TOKENS = previousLimit;
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });
});
