/**
 * F1.237 — a `tool_calls: []` delta is not a tool-call chunk.
 *
 * `createOpenAiSseStrippingStream`'s choice loop guarded on the TRUTHINESS of
 * `choice.delta.tool_calls`, so an empty array passed, set `handledToolCalls`,
 * and the chunk was then suppressed as a tool-call delta: its `content` and its
 * `finish_reason` were dropped, and calls already buffered flushed only at
 * `[DONE]`. OpenAI-compatible relays put `tool_calls: []` on ordinary content
 * chunks and on the terminal finish chunk (craft-agents-oss #995, fixed in
 * v0.11.3). The path is Pi's: the interceptor is preloaded into the Pi
 * subprocess and its OpenAI adapter owns every `/chat/completions` stream.
 *
 * The fix, as upstream: a non-array or an empty array is a non-tool delta; an
 * empty array's key is deleted and the chunk re-serialized, so the Pi SDK
 * downstream never sees the key at all. A chunk without the key is forwarded
 * byte-for-byte, as before.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toolMetadataStore } from '../interceptor-common.ts';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts';

let createOpenAiSseStrippingStream: typeof import('../unified-network-interceptor.ts').createOpenAiSseStrippingStream;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function run(chunks: string[]): Promise<string> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const reader = input.pipeThrough(createOpenAiSseStrippingStream()).getReader();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

function sse(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

/** The `data:` payloads the stream emitted, in order. */
function dataLines(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice('data: '.length));
}

const TOOL_OPEN = {
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":' } }] } }],
};
const TOOL_ARGS = {
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/a.txt","_intent":"read it"}' } }] } }],
};

describe('F1.237 — createOpenAiSseStrippingStream and an empty tool_calls array', () => {
  let sessionDir: string;

  beforeAll(async () => {
    process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    const mod = await import('../unified-network-interceptor.ts');
    createOpenAiSseStrippingStream = mod.createOpenAiSseStrippingStream;
  }, MODULE_GRAPH_HOOK_BUDGET_MS);

  afterAll(() => {
    delete process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL;
  });

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'interceptor-empty-tc-'));
    toolMetadataStore.setSessionDir(sessionDir);
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it('a text chunk carrying tool_calls: [] passes through, with the key removed', async () => {
    const out = await run([
      sse({ choices: [{ index: 0, delta: { content: 'Hello', tool_calls: [] } }] }),
      sse('[DONE]'),
    ]);
    const lines = dataLines(out);
    expect(lines).toEqual([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello' } }] }),
      '[DONE]',
    ]);
  });

  it('a stop chunk carrying tool_calls: [] keeps its finish_reason, with the key removed', async () => {
    const out = await run([
      sse({ choices: [{ index: 0, delta: { content: 'Done.' } }] }),
      sse({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'stop' }] }),
      sse('[DONE]'),
    ]);
    const lines = dataLines(out);
    expect(lines).toEqual([
      JSON.stringify({ choices: [{ index: 0, delta: { content: 'Done.' } }] }),
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ]);
    expect(out).not.toContain('tool_calls');
  });

  it('a tool_calls finish chunk carrying [] flushes the buffered call BEFORE the finish, not at [DONE]', async () => {
    const out = await run([
      sse(TOOL_OPEN),
      sse(TOOL_ARGS),
      sse({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'tool_calls' }] }),
      sse('[DONE]'),
    ]);
    const lines = dataLines(out);
    expect(lines.length).toBe(3);
    const consolidated = JSON.parse(lines[0]!);
    expect(consolidated.choices[0].delta.tool_calls).toEqual([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/a.txt"}' } },
    ]);
    expect(JSON.parse(lines[1]!)).toEqual({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    expect(lines[2]).toBe('[DONE]');
  });

  it('negative control: a real tool-call stream still emits ONE consolidated event, then the finish', async () => {
    const finish = JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls' }] });
    const out = await run([sse(TOOL_OPEN), sse(TOOL_ARGS), sse(finish), sse('[DONE]')]);
    const lines = dataLines(out);
    expect(lines.length).toBe(3);
    // The KEY, not the finish_reason VALUE `"tool_calls"` the finish line also spells.
    expect(lines.filter((l) => l.includes('"tool_calls":')).length).toBe(1);
    expect(JSON.parse(lines[0]!).choices[0].delta.tool_calls[0].function.arguments).toBe('{"path":"/a.txt"}');
    // A chunk without the key is forwarded byte-for-byte, never re-serialized.
    expect(lines[1]).toBe(finish);
    expect(toolMetadataStore.get('call_1', sessionDir)?.intent).toBe('read it');
  });

  it('control: a chunk with no tool_calls key is forwarded byte-for-byte', async () => {
    // Spacing JSON.stringify would not reproduce — proves the verbatim path.
    const raw = '{"choices": [{"index": 0, "delta": {"content": "Hi"}}]}';
    const out = await run([sse(raw), sse('[DONE]')]);
    expect(dataLines(out)).toEqual([raw, '[DONE]']);
  });
});
