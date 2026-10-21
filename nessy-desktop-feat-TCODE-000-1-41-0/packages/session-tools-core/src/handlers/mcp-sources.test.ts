import { describe, it, expect } from 'bun:test';
import {
  handleSourceListPrompts,
  handleSourceGetPrompt,
} from './mcp-sources.ts';
import type { SessionToolContext, McpSourceToolCallbacks } from '../context.ts';

function createCtx(overrides?: Partial<McpSourceToolCallbacks>): {
  ctx: SessionToolContext;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
  const mcpSources: McpSourceToolCallbacks = {
    listPrompts: async (slug) => {
      record('listPrompts', slug);
      return { prompts: [{ name: 'write-entry', arguments: [{ name: 'topic', required: true }] }], truncated: true };
    },
    getPrompt: async (slug, name, args) => { record('getPrompt', slug, name, args); return '[user]\nWrite an entry about MCP.'; },
    ...overrides,
  };
  return { ctx: { mcpSources } as unknown as SessionToolContext, calls };
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;

describe('MCP source prompts handlers', () => {
  it('both handlers degrade gracefully without the mcpSources callbacks', async () => {
    const ctx = {} as unknown as SessionToolContext;
    for (const result of [
      await handleSourceListPrompts(ctx, { sourceSlug: 'liza' }),
      await handleSourceGetPrompt(ctx, { sourceSlug: 'liza', name: 'p' }),
    ]) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not available');
    }
  });

  it('validates required arguments before calling the backend', async () => {
    const { ctx, calls } = createCtx();
    expect(text(await handleSourceListPrompts(ctx, { sourceSlug: ' ' }))).toContain('sourceSlug is required');
    expect(text(await handleSourceGetPrompt(ctx, { sourceSlug: 'liza', name: '' }))).toContain('name is required');
    expect(calls).toHaveLength(0);
  });

  it('source_list_prompts reports truncation and the prompts with their arguments', async () => {
    const { ctx, calls } = createCtx();
    const output = text(await handleSourceListPrompts(ctx, { sourceSlug: ' liza ' }));
    expect(output.startsWith('1 prompt from "liza" (the server has more; the list stops at the page limit). Get one with source_get_prompt')).toBe(true);
    expect(JSON.parse(output.split('\n\n')[1]!).prompts[0].arguments).toEqual([{ name: 'topic', required: true }]);
    expect(calls[0]).toEqual({ method: 'listPrompts', args: ['liza'] });
  });

  it('source_list_prompts says so when a source publishes no prompts (no invented prompt, no error)', async () => {
    const { ctx } = createCtx({ listPrompts: async () => ({ prompts: [] }) });
    const result = await handleSourceListPrompts(ctx, { sourceSlug: 'liza' });
    expect(result.isError).toBe(false);
    expect(text(result)).toBe('Source "liza" publishes no prompts.');
  });

  it('source_get_prompt returns the backend text with the arguments filled in', async () => {
    const { ctx, calls } = createCtx();
    expect(text(await handleSourceGetPrompt(ctx, { sourceSlug: 'liza', name: 'write-entry', arguments: { topic: 'MCP' } })))
      .toBe('[user]\nWrite an entry about MCP.');
    expect(calls).toEqual([
      { method: 'getPrompt', args: ['liza', 'write-entry', { topic: 'MCP' }] },
    ]);
  });

  it('wraps backend errors such as a slug of an inactive source', async () => {
    const notEnabled = async () => { throw new Error('Source "nope" is not enabled in this session (enabled: liza).'); };
    const { ctx } = createCtx({ listPrompts: notEnabled, getPrompt: notEnabled });

    const list = await handleSourceListPrompts(ctx, { sourceSlug: 'nope' });
    expect(list.isError).toBe(true);
    expect(text(list)).toBe('[ERROR] Failed to list prompts: Source "nope" is not enabled in this session (enabled: liza).');
    expect(text(await handleSourceGetPrompt(ctx, { sourceSlug: 'nope', name: 'p' }))).toContain('Failed to get prompt "p"');
  });
});
