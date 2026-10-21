/**
 * F1.313 / F1.314 / F1.316 / F1.317 — what `createOpenAiSseStrippingStream`
 * does with the REST of a chunk, measured where it matters: at the Pi SDK.
 *
 * The strip stream buffers every non-empty `tool_calls` delta and emits one
 * consolidated call per logical tool call at flush time; until these rows it
 * then SUPPRESSED the whole chunk that carried one (`if (handledToolCalls)
 * return;`). Two relay shapes put more than tool calls in that chunk:
 *
 * - F1.313 — the call and its `finish_reason` (and usage) in ONE chunk. The
 *   finish was swallowed, so pi-ai ended the turn with `Stream ended without
 *   finish_reason` — an ERROR on a well-formed tool-call turn.
 * - F1.314 — content or reasoning beside the call ("Let me read." + Read):
 *   the text was dropped silently.
 *
 * Fixed by emitting the rest: the chunk's non-tool delta fields first (text
 * precedes the call it introduces), then — when it finishes — the buffered
 * calls, then a synthesized finish chunk carrying the finish_reason and usage.
 * craft-agents-oss v0.13.4 carries the same early return (read-only under
 * `.references/`, `unified-network-interceptor.ts`), so there was nothing to
 * port: this is our own, recorded here.
 *
 * - F1.317 (DECIDED by the controller) — a truthy NON-array `tool_calls` (`{}`)
 *   reached pi-ai verbatim and failed there (`for … of` over an object); it is
 *   now dropped exactly like an empty array. `null` stays verbatim: pi-ai's own
 *   truthiness guard already skips it (control).
 * - F1.316 — F1.237 pinned at the Pi SDK boundary: pi-ai 0.84's
 *   `openai-completions` `stream()` is driven through the strip stream with
 *   `options.fetch`, so the reading is the turn's stopReason/text/usage, not
 *   the bytes. Pinned by the SDK's own parser, it survives F1.255's lift: a
 *   pi-ai that changes what it accepts moves these arms, not a byte snapshot.
 *   Measured 2026-09-24 on hash-restored mutants: the pre-F1.237 file turns S1
 *   and S2 red ('Stream ended without finish_reason', text '', usage 0); with
 *   this file's fix in, reverting ONLY F1.237's guard keeps them green — the
 *   rest path below covers an empty array too, so the shape is held twice.
 *
 * Shapes S1–S7 are the WJ-ee verifier's (`work/wj-ee-verify/f1237/`).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stream as piOpenAiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import { toolMetadataStore } from '../interceptor-common.ts';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts';

let createOpenAiSseStrippingStream: typeof import('../unified-network-interceptor.ts').createOpenAiSseStrippingStream;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sse = (payload: unknown): string => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

function body(chunks: string[], strip: boolean): ReadableStream<Uint8Array> {
  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return strip ? raw.pipeThrough(createOpenAiSseStrippingStream()) : raw;
}

/** The `data:` payloads the strip stream emitted, in order. */
async function dataLines(chunks: string[]): Promise<string[]> {
  const reader = body(chunks, true).getReader();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice('data: '.length));
}

const CALL_FULL = { index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/a.txt","_intent":"read it"}' } };
const CONSOLIDATED = JSON.stringify({
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"/a.txt"}' } }] } }],
});
const TOOL_OPEN = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":' } }] } }] };
const TOOL_ARGS = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/a.txt","_intent":"read it"}' } }] } }] };
const USAGE = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };

const SHAPES = {
  S1_text_and_stop_carry_empty: [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello', tool_calls: [] } }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'stop' }], usage: USAGE }),
    sse('[DONE]'),
  ],
  S2_toolcall_finish_carries_empty: [sse(TOOL_OPEN), sse(TOOL_ARGS), sse({ choices: [{ index: 0, delta: { tool_calls: [] }, finish_reason: 'tool_calls' }] }), sse('[DONE]')],
  S3_nonempty_toolcall_and_finish_same_chunk: [sse({ choices: [{ index: 0, delta: { tool_calls: [CALL_FULL] }, finish_reason: 'tool_calls' }], usage: USAGE }), sse('[DONE]')],
  S4_control_toolcall_then_bare_finish: [sse({ choices: [{ index: 0, delta: { tool_calls: [CALL_FULL] } }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), sse('[DONE]')],
  S5_content_and_nonempty_toolcall_same_chunk: [sse({ choices: [{ index: 0, delta: { content: 'Let me read.', tool_calls: [CALL_FULL] } }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), sse('[DONE]')],
  S6_nonarray_object_toolcalls: [sse({ choices: [{ index: 0, delta: { content: 'Hi', tool_calls: {} } }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), sse('[DONE]')],
  S7_null_toolcalls_control: [sse({ choices: [{ index: 0, delta: { content: 'Hi', tool_calls: null } }] }), sse({ choices: [{ index: 0, delta: { tool_calls: null }, finish_reason: 'stop' }] }), sse('[DONE]')],
} as const;

const MODEL = {
  id: 'strip-model', name: 'strip', api: 'openai-completions', provider: 'nessy-strip-probe',
  baseUrl: 'http://127.0.0.1:9/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
};
const CONTEXT = {
  systemPrompt: 's',
  messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
  tools: [{ name: 'Read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
};

interface PiReading {
  stopReason: string;
  error?: string;
  text: string;
  toolCalls: Array<{ name: string; args: unknown }>;
  usageIn: number | undefined;
}

/** One turn through pi-ai's own parser, the strip stream in front of it (or not). */
async function throughPi(chunks: readonly string[], strip = true): Promise<PiReading> {
  const fetch = async () => new Response(body([...chunks], strip), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  // The probe model/context are the SDK's own shapes, built by hand.
  const message: any = await piOpenAiCompletionsStream(MODEL as any, CONTEXT as any, { apiKey: 'x', maxRetries: 0, fetch } as any).result();
  return {
    stopReason: message.stopReason,
    ...(message.errorMessage ? { error: String(message.errorMessage) } : {}),
    text: message.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
    toolCalls: message.content.filter((block: any) => block.type === 'toolCall').map((block: any) => ({ name: block.name, args: block.arguments })),
    usageIn: message.usage?.input,
  };
}

describe('F1.313 / F1.314 / F1.316 / F1.317 — the rest of a tool-call chunk', () => {
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
    sessionDir = mkdtempSync(join(tmpdir(), 'interceptor-chunk-rest-'));
    toolMetadataStore.setSessionDir(sessionDir);
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  describe('the bytes', () => {
    it('F1.313 — a call and its finish_reason + usage in ONE chunk: the call, then a synthesized finish carrying both', async () => {
      expect(await dataLines([...SHAPES.S3_nonempty_toolcall_and_finish_same_chunk])).toEqual([
        CONSOLIDATED,
        JSON.stringify({ usage: USAGE, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);
    });

    it('F1.314 — text beside a call is forwarded FIRST, the call is still consolidated, the finish unchanged', async () => {
      expect(await dataLines([...SHAPES.S5_content_and_nonempty_toolcall_same_chunk])).toEqual([
        JSON.stringify({ choices: [{ index: 0, delta: { content: 'Let me read.' } }] }),
        CONSOLIDATED,
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);
    });

    it('F1.314 — reasoning beside a call survives too; a bare role beside it is not a remainder', async () => {
      const lines = await dataLines([
        sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking', tool_calls: [CALL_FULL] } }] }),
        sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, function: { arguments: '' } }] } }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        sse('[DONE]'),
      ]);
      expect(lines[0]).toBe(JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking' } }] }));
      expect(lines.slice(1)).toEqual([CONSOLIDATED, JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]']);
    });

    it('F1.317 — a truthy non-array tool_calls is dropped like an empty array', async () => {
      expect((await dataLines([...SHAPES.S6_nonarray_object_toolcalls]))[0])
        .toBe(JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi' } }] }));
    });

    it('CONTROL — null tool_calls and a call-then-bare-finish stream are forwarded as before', async () => {
      const nullLines = await dataLines([...SHAPES.S7_null_toolcalls_control]);
      expect(nullLines[0]).toBe(JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi', tool_calls: null } }] }));
      expect(await dataLines([...SHAPES.S4_control_toolcall_then_bare_finish])).toEqual([
        CONSOLIDATED,
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        '[DONE]',
      ]);
    });
  });

  describe('at the Pi SDK boundary (pi-ai openai-completions stream())', () => {
    it('F1.316 — S1: a stop chunk carrying tool_calls: [] ends in stop, with its text and its usage', async () => {
      expect(await throughPi(SHAPES.S1_text_and_stop_carry_empty)).toEqual({
        stopReason: 'stop', text: 'Hello', toolCalls: [], usageIn: 7,
      });
    });

    it('F1.316 — S2: a tool_calls finish chunk carrying [] ends in toolUse', async () => {
      expect(await throughPi(SHAPES.S2_toolcall_finish_carries_empty)).toMatchObject({
        stopReason: 'toolUse', toolCalls: [{ name: 'Read', args: { path: '/a.txt' } }],
      });
    });

    it('F1.313 — S3 ends in toolUse with its usage, not "Stream ended without finish_reason"', async () => {
      expect(await throughPi(SHAPES.S3_nonempty_toolcall_and_finish_same_chunk)).toEqual({
        stopReason: 'toolUse', text: '', toolCalls: [{ name: 'Read', args: { path: '/a.txt' } }], usageIn: 7,
      });
    });

    it('F1.314 — S5 keeps "Let me read." beside the call', async () => {
      expect(await throughPi(SHAPES.S5_content_and_nonempty_toolcall_same_chunk)).toMatchObject({
        stopReason: 'toolUse', text: 'Let me read.', toolCalls: [{ name: 'Read', args: { path: '/a.txt' } }],
      });
    });

    it('F1.317 — S6 ends in stop with its text, where the raw chunk fails the turn in pi-ai', async () => {
      expect(await throughPi(SHAPES.S6_nonarray_object_toolcalls)).toMatchObject({ stopReason: 'stop', text: 'Hi' });
      // CONTROL — the same bytes WITHOUT the strip stream: pi-ai's own verdict on `{}`.
      expect((await throughPi(SHAPES.S6_nonarray_object_toolcalls, false)).stopReason).toBe('error');
    });

    it('CONTROL — S4 and S7 end the same way with and without the strip stream', async () => {
      for (const shape of [SHAPES.S4_control_toolcall_then_bare_finish, SHAPES.S7_null_toolcalls_control]) {
        const stripped = await throughPi(shape);
        const raw = await throughPi(shape, false);
        expect(stripped.stopReason).toBe(raw.stopReason);
        expect(stripped.text).toBe(raw.text);
      }
    });
  });
});
