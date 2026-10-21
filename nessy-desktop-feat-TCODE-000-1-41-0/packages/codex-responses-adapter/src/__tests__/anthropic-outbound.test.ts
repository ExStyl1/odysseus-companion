/**
 * Contract tests for the vendored /v1/responses -> Anthropic Messages outbound
 * translation (`../anthropic/outbound.ts`).
 *
 * Adapted from opencodex `tests/claude-outbound.test.ts` @ 16bef04 (MIT). outbound.ts
 * is vendored near-verbatim (no opencodex-specific stripping; 4 hunks vs upstream —
 * see vendor/opencodex/UPSTREAM.md re-sync warning), so these assertions track the
 * upstream contract exactly; the parallel-tool-call slice is new.
 */
import { describe, expect, test } from 'bun:test';
import {
  anthropicErrorBody,
  anthropicErrorResponse,
  anthropicErrorType,
  anthropicUsage,
  collectAnthropicMessage,
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse,
} from '../anthropic/outbound.ts';

function sse(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // Split into odd chunks so frame-boundary buffering is exercised.
      for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
      controller.close();
    },
  });
}

interface Ev { name: string; data: Record<string, any> }

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<Ev[]> {
  const text = await new Response(stream).text();
  const events: Ev[] = [];
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    let name = '';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

/** No idle pings: keeps event sequences deterministic for order assertions. */
const NO_PING = { pingIntervalMs: 0 };

describe('anthropic outbound SSE: event order', () => {
  test('thinking + text + tool call + completed -> exact Anthropic sequence', async () => {
    const upstream = [
      sse('response.created', { response: { id: 'resp_1', status: 'in_progress' } }),
      sse('response.output_item.added', { output_index: 0, item: { type: 'reasoning', id: 'rs_1' } }),
      sse('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, delta: 'hmm' }),
      sse('response.output_item.done', { output_index: 0, item: { type: 'reasoning', id: 'rs_1' } }),
      sse('response.output_item.added', { output_index: 1, item: { type: 'message', id: 'msg_1' } }),
      sse('response.output_text.delta', { item_id: 'msg_1', output_index: 1, delta: 'Hello ' }),
      sse('response.output_text.delta', { item_id: 'msg_1', output_index: 1, delta: 'world' }),
      sse('response.output_item.done', { output_index: 1, item: { type: 'message', id: 'msg_1' } }),
      sse('response.output_item.added', { output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'toolu_9', name: 'Read', arguments: '' } }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: '{"file_path":' }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: '"/x"}' }),
      sse('response.output_item.done', { output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'toolu_9', name: 'Read' } }),
      sse('response.heartbeat', {}),
      sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 } } } }),
    ].join('');

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'claude-test', NO_PING));
    expect(events.map(e => e.name)).toEqual([
      'message_start', 'ping',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', // thinking (+signature)
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', // text
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', // tool_use
      'ping',
      'message_delta', 'message_stop',
    ]);

    expect(events[0]!.data.type).toBe('message_start');
    expect(events[0]!.data.message).toMatchObject({
      type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, stop_sequence: null,
    });
    expect(events[0]!.data.message.id).toMatch(/^msg_[0-9a-f]{32}$/);

    // thinking block, index 0: thinking_delta then ONE synthetic signature_delta before stop
    expect(events[2]!.data.content_block).toEqual({ type: 'thinking', thinking: '', signature: '' });
    expect(events[3]!.data.delta).toEqual({ type: 'thinking_delta', thinking: 'hmm' });
    expect(events[4]!.data.delta.type).toBe('signature_delta');
    expect(String(events[4]!.data.delta.signature).length).toBeGreaterThan(0);
    expect(events[5]!.data).toEqual({ type: 'content_block_stop', index: 0 });

    // text block, index 1
    expect(events[6]!.data.content_block).toEqual({ type: 'text', text: '' });
    expect(events[7]!.data.delta).toEqual({ type: 'text_delta', text: 'Hello ' });

    // tool_use block, index 2: id is the Responses call_id
    expect(events[10]!.data.content_block).toEqual({ type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} });
    expect(events[11]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: '{"file_path":' });

    const md = events.find(e => e.name === 'message_delta')!.data;
    expect(md.delta).toEqual({ stop_reason: 'tool_use', stop_sequence: null });
    // input_tokens excludes BOTH cache read and cache write (Anthropic convention).
    expect(md.usage).toEqual({ input_tokens: 15, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });

    expect(events.filter(e => e.name === 'content_block_start').map(e => e.data.index)).toEqual([0, 1, 2]);
  });

  test('parallel tool calls: one block per call, input_json_delta routed by index', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'toolu_a', name: 'Read' } }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_a', delta: '{"p":' }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_a', delta: '"a"}' }),
      sse('response.output_item.done', { output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'toolu_a', name: 'Read' } }),
      sse('response.output_item.added', { output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'toolu_b', name: 'Bash' } }),
      sse('response.function_call_arguments.delta', { item_id: 'fc_b', delta: '{"cmd":"ls"}' }),
      sse('response.output_item.done', { output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'toolu_b', name: 'Bash' } }),
      sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 4 } } }),
    ].join('');

    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    const starts = events.filter(e => e.name === 'content_block_start');
    expect(starts.map(e => e.data.index)).toEqual([0, 1]);
    expect(starts.map(e => e.data.content_block.id)).toEqual(['toolu_a', 'toolu_b']);
    expect(starts.map(e => e.data.content_block.name)).toEqual(['Read', 'Bash']);

    const deltas = events.filter(e => e.name === 'content_block_delta');
    expect(deltas.map(e => [e.data.index, e.data.delta.partial_json])).toEqual([
      [0, '{"p":'], [0, '"a"}'], [1, '{"cmd":"ls"}'],
    ]);
    // Each block is closed before the next opens.
    expect(events.map(e => e.name)).toEqual([
      'message_start', 'ping',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop',
    ]);
    expect(events.find(e => e.name === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');

    // Aggregated, the two calls carry their own parsed inputs.
    const msg = await collectAnthropicMessage(
      responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING), 'm',
    ) as Record<string, any>;
    expect(msg.content).toEqual([
      { type: 'tool_use', id: 'toolu_a', name: 'Read', input: { p: 'a' } },
      { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { cmd: 'ls' } },
    ]);
    expect(msg.stop_reason).toBe('tool_use');
  });

  test('no-output completion still emits a valid empty message', async () => {
    const upstream = sse('response.created', { response: {} }) + sse('response.completed', { response: { status: 'completed' } });
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.map(e => e.name)).toEqual(['message_start', 'ping', 'message_delta', 'message_stop']);
    expect(events[2]!.data.delta.stop_reason).toBe('end_turn');
  });

  test('idle keepalive pings flow during upstream silence', async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sse('response.created', { response: {} })));
        await new Promise(r => setTimeout(r, 90));
        controller.enqueue(encoder.encode(sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } })));
        controller.close();
      },
    });
    const events = await collectEvents(responsesSseToAnthropicSse(upstream, 'm', { pingIntervalMs: 25 }));
    expect(events.filter(e => e.name === 'ping').length).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)!.name).toBe('message_stop');
  });
});

describe('anthropic outbound SSE: stop_reason and failure modes', () => {
  const terminal = (frame: string) => [
    sse('response.created', { response: {} }),
    sse('response.output_text.delta', { delta: 'x' }),
    frame,
  ].join('');

  const stopCases: Array<[string, string, string]> = [
    ['completed', sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 6 } } }), 'end_turn'],
    ['incomplete/max_output_tokens', sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: {} } }), 'max_tokens'],
    ['incomplete/content_filter', sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: {} } }), 'refusal'],
    ['incomplete/unknown reason', sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'other' }, usage: {} } }), 'end_turn'],
  ];

  for (const [label, frame, expected] of stopCases) {
    test(`${label} -> stop_reason ${expected}`, async () => {
      const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(terminal(frame)), 'm', NO_PING));
      expect(events.find(e => e.name === 'message_delta')!.data.delta.stop_reason).toBe(expected);
      expect(events.at(-1)!.name).toBe('message_stop');
    });
  }

  test('a tool call in flight makes an unknown-reason incomplete report tool_use', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'Read' } }),
      sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: {}, usage: {} } }),
    ].join('');
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.find(e => e.name === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
  });

  test('response.failed closes the open block, then emits a taxonomy-typed error', async () => {
    const upstream = terminal(sse('response.failed', { response: { status: 'failed', error: { status: 429, message: 'rate limited' } } }));
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.map(e => e.name)).toEqual([
      'message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error',
    ]);
    expect(events.at(-1)!.data).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } });
  });

  test('EOF without a terminal frame fails CLOSED with a retryable error event', async () => {
    const upstream = sse('response.created', { response: {} }) + sse('response.output_text.delta', { delta: 'y' });
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.map(e => e.name)).toEqual([
      'message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop', 'error',
    ]);
    expect(events.at(-1)!.data).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(String(events.at(-1)!.data.error.message)).toContain('truncated');
  });

  test('frames after a terminal frame are ignored', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.completed', { response: { status: 'completed', usage: {} } }),
      sse('response.output_text.delta', { delta: 'late' }),
    ].join('');
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.map(e => e.name)).toEqual(['message_start', 'ping', 'message_delta', 'message_stop']);
  });

  test('unparseable and unknown frames are skipped without breaking the stream', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      'event: response.output_text.delta\ndata: {not json\n\n',
      'data: {"orphan":true}\n\n',
      sse('response.some_future_event', { whatever: 1 }),
      sse('response.output_text.delta', { delta: 'ok' }),
      sse('response.completed', { response: { status: 'completed', usage: {} } }),
    ].join('');
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.filter(e => e.name === 'content_block_delta').map(e => e.data.delta.text)).toEqual(['ok']);
    expect(events.at(-1)!.name).toBe('message_stop');
  });
});

describe('anthropic outbound: non-streaming JSON', () => {
  test('responses JSON -> anthropic message', () => {
    const msg = responsesJsonToAnthropicMessage({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'think' }] },
        { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', id: 'f', call_id: 'toolu_1', name: 'Read', arguments: '{"a":1}' },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    }, 'claude-test') as Record<string, any>;
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.model).toBe('claude-test');
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.stop_sequence).toBeNull();
    expect(msg.content[0]).toMatchObject({ type: 'thinking', thinking: 'think' });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'hi' });
    expect(msg.content[2]).toEqual({ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { a: 1 } });
    expect(msg.usage).toEqual({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test('stop_reason: end_turn / tool_use / max_tokens', () => {
    const of = (body: Record<string, unknown>) => (responsesJsonToAnthropicMessage(body, 'm') as Record<string, any>).stop_reason;
    const text = { type: 'message', content: [{ type: 'output_text', text: 'hi' }] };
    expect(of({ status: 'completed', output: [text] })).toBe('end_turn');
    expect(of({ status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' }] })).toBe('tool_use');
    expect(of({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [text] })).toBe('max_tokens');
    expect(of({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [text] })).toBe('end_turn');
  });

  test('malformed function_call arguments degrade to an empty input object', () => {
    const msg = responsesJsonToAnthropicMessage({
      output: [{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{oops' }],
    }, 'm') as Record<string, any>;
    expect(msg.content[0].input).toEqual({});
  });

  test('reasoning content and summary both feed the thinking block', () => {
    const msg = responsesJsonToAnthropicMessage({
      output: [{ type: 'reasoning', summary: [{ text: 'a' }], content: [{ text: 'b' }] }],
    }, 'm') as Record<string, any>;
    expect(msg.content[0].thinking).toBe('a\n\nb');
    expect(String(msg.content[0].signature).length).toBeGreaterThan(0);
  });

  test('non-object input yields an empty end_turn message', () => {
    const msg = responsesJsonToAnthropicMessage(null, 'm') as Record<string, any>;
    expect(msg.content).toEqual([]);
    expect(msg.stop_reason).toBe('end_turn');
  });
});

describe('anthropic outbound: error taxonomy and usage', () => {
  const taxonomy: Array<[number, string]> = [
    [400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'],
    [403, 'permission_error'], [404, 'not_found_error'], [409, 'conflict_error'],
    [413, 'request_too_large'], [429, 'rate_limit_error'], [504, 'timeout_error'],
    [529, 'overloaded_error'], [500, 'api_error'], [502, 'api_error'], [418, 'invalid_request_error'],
  ];

  for (const [status, type] of taxonomy) {
    test(`status ${status} -> ${type}`, () => {
      expect(anthropicErrorType(status)).toBe(type);
      expect(anthropicErrorBody(status, 'boom')).toEqual({ type: 'error', error: { type, message: 'boom' } });
    });
  }

  test('an explicit type overrides the status mapping', () => {
    expect(anthropicErrorBody(500, 'x', 'overloaded_error'))
      .toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'x' } });
  });

  test('anthropicErrorResponse carries the status and a JSON content type', async () => {
    const res = anthropicErrorResponse(429, 'slow down');
    expect(res.status).toBe(429);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  });

  const usageCases: Array<[string, unknown, number, Record<string, unknown>]> = [
    ['missing usage', undefined, 0, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
    ['plain counts', { input_tokens: 7, output_tokens: 2 }, 0, { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
    ['cache read + write subtracted', { input_tokens: 120, output_tokens: 3, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 5 } }, 0,
      { input_tokens: 15, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }],
    ['never goes negative', { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 50 } }, 0,
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }],
    ['web search requests reported when non-zero', { input_tokens: 1, output_tokens: 1 }, 2,
      { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2 } }],
  ];

  for (const [label, usage, searches, expected] of usageCases) {
    test(`usage: ${label}`, () => {
      expect(anthropicUsage(usage, searches)).toEqual(expected);
    });
  }
});

describe('anthropic outbound: collectAnthropicMessage', () => {
  test('folds our own SSE vocabulary back into a message JSON', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.reasoning_text.delta', { delta: 'thinking' }),
      sse('response.output_item.added', { output_index: 1, item: { type: 'message', id: 'm1' } }),
      sse('response.output_text.delta', { delta: 'Hello ' }),
      sse('response.output_text.delta', { delta: 'world' }),
      sse('response.output_item.done', { output_index: 1, item: { type: 'message', id: 'm1' } }),
      sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 2 } } }),
    ].join('');
    const msg = await collectAnthropicMessage(
      responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING), 'm',
    ) as Record<string, any>;
    expect(msg.content.map((c: Record<string, unknown>) => c.type)).toEqual(['thinking', 'text']);
    expect(msg.content[0].thinking).toBe('thinking');
    expect(String(msg.content[0].signature).length).toBeGreaterThan(0);
    expect(msg.content[1].text).toBe('Hello world');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage).toEqual({ input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test('a mid-stream error event is returned verbatim instead of a message', async () => {
    const upstream = sse('response.created', { response: {} })
      + sse('response.failed', { response: { error: { status: 503, message: 'nope' } } });
    const msg = await collectAnthropicMessage(
      responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING), 'm',
    ) as Record<string, any>;
    expect(msg).toEqual({ type: 'error', error: { type: 'api_error', message: 'nope' } });
  });
});

describe('anthropic outbound: server-side web_search', () => {
  const wsItem = (over: Record<string, unknown> = {}) => ({
    type: 'web_search_call', id: 'ws_1', status: 'completed',
    action: { type: 'search', query: 'latest bun release' },
    sources: [
      { url: 'https://bun.sh/blog', title: 'Bun Blog' },
      { url: 'https://github.com/oven-sh/bun/releases' },
    ],
    ...over,
  });

  test('a single search streams the server_tool_use + web_search_tool_result pair', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.output_item.done', { output_index: 0, item: wsItem() }),
      sse('response.output_item.added', { output_index: 1, item: { type: 'message', id: 'm1' } }),
      sse('response.output_text.delta', { delta: 'answer' }),
      sse('response.output_item.done', { output_index: 1, item: { type: 'message', id: 'm1' } }),
      sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 9, output_tokens: 3 } } }),
    ].join('');
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.map(e => e.name)).toEqual([
      'message_start', 'ping',
      'content_block_start', 'content_block_delta', 'content_block_stop', // server_tool_use
      'content_block_start', 'content_block_stop', // web_search_tool_result
      'content_block_start', 'content_block_delta', 'content_block_stop', // text
      'message_delta', 'message_stop',
    ]);
    expect(events[2]!.data.content_block).toEqual({ type: 'server_tool_use', id: 'ws_1', name: 'web_search' });
    expect(events[3]!.data.delta).toEqual({ type: 'input_json_delta', partial_json: JSON.stringify({ query: 'latest bun release' }) });
    expect(events[5]!.data.content_block.content).toEqual([
      { type: 'web_search_result', title: 'Bun Blog', url: 'https://bun.sh/blog' },
      { type: 'web_search_result', title: '', url: 'https://github.com/oven-sh/bun/releases' },
    ]);
    const md = events.find(e => e.name === 'message_delta')!.data;
    expect(md.usage.server_tool_use).toEqual({ web_search_requests: 1 });
    // A server-side search is not a client tool call: stop_reason stays end_turn.
    expect(md.delta.stop_reason).toBe('end_turn');
  });

  test('batched queries keep the plural form; a failed search is not counted', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.output_item.done', { output_index: 0, item: wsItem({ id: 'ws_2', action: { type: 'search', queries: ['a', 'b'] }, sources: [] }) }),
      sse('response.output_item.done', { output_index: 1, item: wsItem({ id: 'ws_3', status: 'failed', sources: undefined }) }),
      sse('response.completed', { response: { status: 'completed', usage: {} } }),
    ].join('');
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    const starts = events.filter(e => e.name === 'content_block_start');
    expect(starts.map(e => e.data.content_block.type)).toEqual([
      'server_tool_use', 'web_search_tool_result', 'server_tool_use', 'web_search_tool_result',
    ]);
    expect(starts.map(e => e.data.index)).toEqual([0, 1, 2, 3]);
    expect(events.filter(e => e.name === 'content_block_delta')[0]!.data.delta.partial_json)
      .toBe(JSON.stringify({ queries: ['a', 'b'] }));
    expect(starts[1]!.data.content_block.content).toEqual([]);
    expect(starts[3]!.data.content_block.content).toEqual({ type: 'web_search_tool_result_error', error_code: 'unavailable' });
    expect(events.find(e => e.name === 'message_delta')!.data.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  test('JSON path emits the same pair and omits the counter when nothing succeeded', () => {
    const msg = responsesJsonToAnthropicMessage({
      status: 'completed',
      output: [wsItem(), wsItem({ id: 'ws_9', status: 'failed' }), { type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 5, output_tokens: 1 },
    }, 'm') as Record<string, any>;
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.content.map((c: Record<string, unknown>) => c.type)).toEqual([
      'server_tool_use', 'web_search_tool_result', 'server_tool_use', 'web_search_tool_result', 'text',
    ]);
    expect(msg.content[0]).toEqual({ type: 'server_tool_use', id: 'ws_1', name: 'web_search', input: { query: 'latest bun release' } });
    expect(msg.content[3].content).toEqual({ type: 'web_search_tool_result_error', error_code: 'unavailable' });
    expect(msg.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });

  test('a turn without web_search reports no server_tool_use usage field', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.output_text.delta', { delta: 'plain' }),
      sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } } }),
    ].join('');
    const events = await collectEvents(responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING));
    expect(events.some(e => e.name === 'content_block_start' && e.data.content_block.type === 'server_tool_use')).toBe(false);
    expect(events.find(e => e.name === 'message_delta')!.data.usage.server_tool_use).toBeUndefined();
  });

  test('collect path: the server_tool_use query survives aggregation', async () => {
    const upstream = [
      sse('response.created', { response: {} }),
      sse('response.output_item.done', { output_index: 0, item: wsItem() }),
      sse('response.output_text.delta', { delta: 'hi' }),
      sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 4, output_tokens: 2 } } }),
    ].join('');
    const msg = await collectAnthropicMessage(
      responsesSseToAnthropicSse(streamFrom(upstream), 'm', NO_PING), 'm',
    ) as Record<string, any>;
    expect(msg.content.map((c: Record<string, unknown>) => c.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
    expect(msg.content[0].input).toEqual({ query: 'latest bun release' });
    expect(msg.content[1].tool_use_id).toBe('ws_1');
    expect(msg.usage.server_tool_use).toEqual({ web_search_requests: 1 });
  });
});
