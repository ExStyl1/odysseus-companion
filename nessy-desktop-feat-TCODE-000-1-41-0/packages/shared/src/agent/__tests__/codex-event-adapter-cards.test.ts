/**
 * Task 4.4 gate: every AgentEvent the CodexEventAdapter emits is of a `type` the
 * renderer `event-processor/processor.ts` switch already handles (command /
 * diff / tool / token / text / complete) — no unknown-event `never`
 * fallthrough, no new AgentEvent.type invented.
 *
 * (Lives in shared, where the adapter lives; the plan named codex-agent-server
 * but that package cannot import shared — the shared→adapter dep would cycle.)
 */
import { test, expect, describe } from 'bun:test';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

// The AgentEvent.type values the renderer processEvent switch handles
// (apps/electron/src/renderer/event-processor/processor.ts). Token usage flows
// via UsageTracker → usage_update (not the adapter); the adapter's outputs are a
// subset of the text/tool/complete/error cards.
const RENDERER_HANDLED = new Set<AgentEvent['type']>([
  'text_delta',
  'text_complete',
  'tool_start',
  'tool_result',
  'complete',
  'error',
  'usage_update',
]);

describe('CodexEventAdapter renderer-safety', () => {
  test('a text → command → diff → completed turn emits only renderer-handled types', () => {
    const a = new CodexEventAdapter();
    a.startTurn('t');
    const seq: AgentEvent[] = [
      ...a.adapt('item/agentMessage/delta', { delta: 'working…' }),
      ...a.adapt('item/started', { item: { type: 'commandExecution', id: 'c1', command: 'ls' } }),
      ...a.adapt('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'out' }),
      ...a.adapt('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'out', exitCode: 0 } }),
      ...a.adapt('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] } }),
      ...a.adapt('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [], status: 'completed' } }),
      ...a.adapt('turn/completed', {}),
    ];
    for (const e of seq) {
      expect(RENDERER_HANDLED.has(e.type)).toBe(true);
    }
    expect(seq.map((e) => e.type)).toEqual([
      'text_delta',
      'tool_start', // command
      'tool_result',
      'tool_start', // diff (fileChange → Edit)
      'tool_result',
      'complete',
    ]);
  });

  // Keeps this file's "every AgentEvent the adapter emits" claim true now that
  // mcpToolCall is mapped: an MCP row is an ordinary tool pair, so it lands on
  // the same renderer-handled card types as Bash/Edit — no new AgentEvent.type.
  test('an mcpToolCall item yields a renderer-handled tool pair under its mcp__ name', () => {
    const a = new CodexEventAdapter();
    a.startTurn('t');
    const item = { type: 'mcpToolCall', id: 'm1', server: 'sources', tool: 'plugin_echo__whoami', arguments: {} };
    const seq: AgentEvent[] = [
      ...a.adapt('item/started', { item: { ...item, status: 'inProgress', result: null, error: null } }),
      ...a.adapt('item/completed', {
        item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] }, error: null },
      }),
    ];
    for (const e of seq) {
      expect(RENDERER_HANDLED.has(e.type)).toBe(true);
    }
    expect(seq.map((e) => e.type)).toEqual(['tool_start', 'tool_result']);
    expect(seq[0]).toMatchObject({ toolName: 'mcp__sources__plugin_echo__whoami', toolUseId: 'm1' });
    expect(seq[1]).toMatchObject({ toolName: 'mcp__sources__plugin_echo__whoami', result: 'ok', isError: false });
  });

  test('a file-change item yields a diff-capable tool pair (Edit)', () => {
    const a = new CodexEventAdapter();
    a.startTurn('t');
    const start = a.adapt('item/started', { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'x.ts' }] } });
    const done = a.adapt('item/completed', { item: { type: 'fileChange', id: 'f1', changes: [], status: 'completed' } });
    expect(start[0]).toMatchObject({ type: 'tool_start', toolName: 'Edit', toolUseId: 'f1' });
    expect(done[0]).toMatchObject({ type: 'tool_result', toolName: 'Edit', toolUseId: 'f1', isError: false });
  });
});
