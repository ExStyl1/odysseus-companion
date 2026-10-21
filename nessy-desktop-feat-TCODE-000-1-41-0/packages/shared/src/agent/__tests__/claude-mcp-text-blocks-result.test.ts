/**
 * F1.909 — claude's MCP tool result arrives as a content array; the row shows the texts, not the array's JSON.
 *
 * SIT-aa (2026-09-25) read claude's `remember` result as `[{"type":"text","text":"Saved memory…"}]`. The lane's
 * artefacts are gone, so the payload below is the SDK's documented shape (`McpOutput`, `ToolResultBlockParam`)
 * carrying the sentence the lane quoted, driven through the real `ClaudeEventAdapter.adapt`.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts';

const SAVED = 'Saved memory to /tmp/f1909/MEMORY.md';

let adapter: ClaudeEventAdapter;

beforeEach(() => {
  adapter = new ClaudeEventAdapter({
    onDebug: undefined,
    mapSDKError: async () => { throw new Error('not reached'); },
  });
  adapter.startTurn();
});

async function start(id: string, name: string): Promise<void> {
  await adapter.adapt({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: {} }], usage: { input_tokens: 1 } },
    parent_tool_use_id: null,
    session_id: 'sess-f1909',
  } as never);
}

async function resultOf(message: Record<string, unknown>): Promise<Extract<AgentEvent, { type: 'tool_result' }>> {
  const events = await adapter.adapt({ type: 'user', session_id: 'sess-f1909', ...message } as never);
  const result = events.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
  if (!result) throw new Error(`no tool_result in ${JSON.stringify(events)}`);
  return result;
}

describe('F1.909 — an MCP result that is a list of text blocks reads as its text', () => {
  it('the remember result (a tool_result block whose content is one text block) is the sentence', async () => {
    await start('toolu_rem', 'mcp__session__remember');
    const result = await resultOf({
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rem', content: [{ type: 'text', text: SAVED }] }] },
    });
    expect(result.toolName).toBe('mcp__session__remember');
    expect(result.result).toBe(SAVED);
    expect(result.isError).toBe(false);
  });

  it("the SDK's no-block fallback (tool_use_result) joins several text blocks by a newline", async () => {
    await start('toolu_fb', 'mcp__docs__search');
    const result = await resultOf({
      parent_tool_use_id: 'toolu_fb',
      message: { role: 'user', content: [] },
      tool_use_result: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    });
    expect(result.result).toBe('first\nsecond');
  });

  it('boundary: an MCP result with a non-text block keeps its serialised form, so the image stays visible', async () => {
    await start('toolu_img', 'mcp__shots__take');
    const content = [{ type: 'text', text: 'shot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
    const result = await resultOf({
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content }] },
    });
    expect(result.result).toBe(JSON.stringify(content, null, 2));
  });

  it('boundary: a built-in tool with a text-block array is not an MCP result and is left as it was', async () => {
    await start('toolu_read', 'Read');
    const content = [{ type: 'text', text: 'file body' }];
    const result = await resultOf({
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content }] },
    });
    expect(result.result).toBe(JSON.stringify(content, null, 2));
  });
});

describe('F1.1146 — an Agent / Task result that is a list of text blocks reads as its text', () => {
  async function startWith(id: string, name: string, input: Record<string, unknown>): Promise<void> {
    await adapter.adapt({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 1 } },
      parent_tool_use_id: null,
      session_id: 'sess-f1909',
    } as never);
  }

  it("a foreground Agent's answer and its resume footer are joined, not shown as the blocks' JSON", async () => {
    await startWith('toolu_agent', 'Agent', { description: 'survey', prompt: 'look' });
    const content = [{ type: 'text', text: 'The parser lives in src/parse.ts.' }, { type: 'text', text: 'agentId: a1b2c3 (for resuming)' }];
    const result = await resultOf({
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content }] },
    });
    expect(result.result).toBe('The parser lives in src/parse.ts.\nagentId: a1b2c3 (for resuming)');
  });

  it('re-pin: a background launch receipt still yields task_backgrounded with its agentId, and the row reads the receipt text', async () => {
    await startWith('toolu_bg', 'Task', { description: 'scan', prompt: 'go', run_in_background: true });
    const text = 'Async agent launched successfully.\nagentId: bg-42 (use it to read the output)';
    const events = await adapter.adapt({
      type: 'user',
      session_id: 'sess-f1909',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text }] }] },
    } as never);
    const backgrounded = events.find(event => event.type === 'task_backgrounded') as { taskId?: string } | undefined;
    expect(backgrounded?.taskId).toBe('bg-42');
    const result = events.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(result?.result).toBe(text);
    // The renderer's backgrounding receipt patterns (`background-task-rows.ts`) read the same `agentId:` wording.
    expect(/agentId:\s*[a-zA-Z0-9_-]+/.test(result?.result ?? '')).toBe(true);
  });

  it('boundary: an Agent result with a non-text block keeps its serialised form', async () => {
    await startWith('toolu_agent_img', 'Agent', { description: 'shot', prompt: 'look' });
    const content = [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
    const result = await resultOf({
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_img', content }] },
    });
    expect(result.result).toBe(JSON.stringify(content, null, 2));
  });
});
