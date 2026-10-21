/**
 * P6.158 — both adapters already RECEIVE incremental tool input; until this row
 * neither had a branch for it.
 *
 * Native-first, step 1 on both runtimes: nothing needed enabling. Pi's own SDK
 * declares `toolcall_start`/`toolcall_delta`/`toolcall_end`
 * (`@earendil-works/pi-ai`), and claude's `includePartialMessages: true` has
 * been set on every spawn since long before this row, so `input_json_delta`
 * frames were already arriving. Both adapters dropped them, and a tool call's
 * arguments therefore appeared in ONE block — Pi's at `tool_execution_start`,
 * claude's when the assistant message landed and `extractToolStarts` re-emitted
 * through its `hasNewInput` branch.
 *
 * These are hermetic adapter tests: no runtime, no network, frames fed by hand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import {
  PARTIAL_TOOL_INPUT_FLOOR_CHARS,
  nextPartialToolInputThreshold,
  parsePartialToolInput,
} from '../backend/partial-tool-input.ts';

function claudeCallbacks(): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error',
        title: 'Test Error',
        message: 'unused',
        details: [],
        actions: [],
        canRetry: false,
      },
    }),
  };
}

/** A tool input big enough to arrive in several frames, as a real one does. */
function bigInput(): Record<string, unknown> {
  return {
    file_path: '/tmp/report.md',
    content: 'x'.repeat(600),
    description: 'write the report',
  };
}

/** Split a JSON string into fragments at arbitrary — not JSON — boundaries. */
function fragments(json: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < json.length; i += size) out.push(json.slice(i, i + size));
  return out;
}

describe('parsePartialToolInput', () => {
  it('reads a buffer cut inside a string value', () => {
    expect(parsePartialToolInput('{"command": "git di')).toEqual({ command: 'git di' });
  });

  it('cuts back to the last complete member when the tail is a half-written key', () => {
    expect(parsePartialToolInput('{"command": "ls", "desc')).toEqual({ command: 'ls' });
  });

  it('cuts back when a key has arrived but its value has not', () => {
    expect(parsePartialToolInput('{"a": 1, "b":')).toEqual({ a: 1 });
  });

  it('reads a nested object cut mid-string', () => {
    expect(parsePartialToolInput('{"edit": {"old": "foo')).toEqual({ edit: { old: 'foo' } });
  });

  it('keeps an escaped quote inside the value rather than closing the string on it', () => {
    expect(parsePartialToolInput('{"command": "echo \\"hi')).toEqual({ command: 'echo "hi' });
  });

  it('returns the complete object untouched once the buffer parses', () => {
    expect(parsePartialToolInput('{"a": 1}')).toEqual({ a: 1 });
  });

  it('returns null for an empty buffer and for a non-object', () => {
    expect(parsePartialToolInput('')).toBeNull();
    expect(parsePartialToolInput('   ')).toBeNull();
    expect(parsePartialToolInput('[1, 2')).toBeNull();
  });

  it('bounds the re-emission count — the schedule doubles from a floor', () => {
    expect(nextPartialToolInputThreshold(0)).toBe(PARTIAL_TOOL_INPUT_FLOOR_CHARS);
    expect(nextPartialToolInputThreshold(500)).toBe(1000);
    // A 50 KB input re-emits about ten times, not once per frame.
    let at = PARTIAL_TOOL_INPUT_FLOOR_CHARS;
    let emissions = 0;
    while (at < 50_000) {
      emissions++;
      at = nextPartialToolInputThreshold(at);
    }
    expect(emissions).toBeLessThan(15);
  });
});

describe('P6.158 · Pi — toolcall_start / toolcall_delta / toolcall_end', () => {
  let adapter: PiEventAdapter;
  let sessionDir: string;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-live-input-'));
    adapter.setSessionDir(sessionDir);
    adapter.startTurn();
  });

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true });
  });

  function feed(json: string, opts?: { frame?: number }): any[] {
    const events: any[] = [];
    const partial = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'Write', arguments: {} }],
    };
    events.push(...adapter.adaptEvent({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    } as any));
    for (const delta of fragments(json, opts?.frame ?? 120)) {
      events.push(...adapter.adaptEvent({
        type: 'message_update',
        message: partial,
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta, partial },
      } as any));
    }
    events.push(...adapter.adaptEvent({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call-1', name: 'Write', arguments: JSON.parse(json) },
        partial,
      },
    } as any));
    return events;
  }

  it('emits at least two incremental input events before the call completes', () => {
    const json = JSON.stringify(bigInput());
    const starts = feed(json).filter(e => e.type === 'tool_start');
    expect(starts.length).toBeGreaterThanOrEqual(2);
    for (const start of starts) {
      expect(start.toolUseId).toBe('call-1');
      expect(start.toolName).toBe('Write');
      expect(Object.keys(start.input).length).toBeGreaterThan(0);
    }
    // Each re-emission carries at least as much as the one before it.
    const sizes = starts.map(s => JSON.stringify(s.input).length);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]!);
  });

  it('the last incremental view equals the reassembled input', () => {
    const input = bigInput();
    const starts = feed(JSON.stringify(input)).filter(e => e.type === 'tool_start');
    expect(starts.at(-1)!.input).toEqual(input);
  });

  it('emits nothing extra for a tool input that fits in one frame — the floor', () => {
    const starts = feed('{"a":1}', { frame: 500 }).filter(e => e.type === 'tool_start');
    expect(starts.length).toBe(0);
  });

  it('emits nothing when the accumulating message carries no tool call to name', () => {
    const events: any[] = [];
    const partial = { role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
    events.push(...adapter.adaptEvent({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial },
    } as any));
    for (const delta of fragments(JSON.stringify(bigInput()), 120)) {
      events.push(...adapter.adaptEvent({
        type: 'message_update',
        message: partial,
        assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta, partial },
      } as any));
    }
    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(0);
  });
});

describe('P6.158 · claude — content_block_start(tool_use) + input_json_delta', () => {
  let adapter: ClaudeEventAdapter;

  beforeEach(() => {
    adapter = new ClaudeEventAdapter(claudeCallbacks());
    adapter.startTurn();
  });

  async function feed(json: string, opts?: { frame?: number }): Promise<any[]> {
    const events: any[] = [];
    events.push(...await adapter.adapt({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'Write', input: {} },
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
    } as any));
    for (const partial_json of fragments(json, opts?.frame ?? 120)) {
      events.push(...await adapter.adapt({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      } as any));
    }
    events.push(...await adapter.adapt({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
      parent_tool_use_id: null,
      session_id: 'sess-1',
    } as any));
    return events;
  }

  it('emits at least two incremental input events after the empty-input start', async () => {
    const events = await feed(JSON.stringify(bigInput()));
    const starts = events.filter(e => e.type === 'tool_start');
    // The first is the SDK's own empty-input start, which this fork already had.
    expect(starts[0]!.input).toEqual({});
    const incremental = starts.slice(1);
    expect(incremental.length).toBeGreaterThanOrEqual(2);
    for (const start of incremental) {
      expect(start.toolUseId).toBe('toolu_1');
      expect(start.toolName).toBe('Write');
    }
  });

  it('the reassembled JSON equals the final tool_start input', async () => {
    const input = bigInput();
    const events = await feed(JSON.stringify(input));
    const starts = events.filter(e => e.type === 'tool_start');
    expect(starts.at(-1)!.input).toEqual(input);
  });

  it('emits nothing extra for a tool input that fits in one frame — the floor', async () => {
    const events = await feed('{"a":1}', { frame: 500 });
    const starts = events.filter(e => e.type === 'tool_start');
    expect(starts).toHaveLength(1);
    expect(starts[0]!.input).toEqual({});
  });

  it('a delta for a content block that never opened emits nothing', async () => {
    const events = await adapter.adapt({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 7,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(bigInput()) },
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
    } as any);
    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(0);
  });
});
