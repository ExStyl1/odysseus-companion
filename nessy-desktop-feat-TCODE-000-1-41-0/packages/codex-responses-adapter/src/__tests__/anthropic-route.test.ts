/**
 * Task T3 — end-to-end tests for the adapter's `POST /v1/messages` route.
 *
 * The Claude Agent SDK points `ANTHROPIC_BASE_URL` at this server and posts to
 * `/v1/messages?beta=true`, so the route matches on PATH (query stripped) and the
 * streaming reply must be Anthropic Messages SSE.
 *
 * These are route-level tests: a canned chat-completions upstream is injected via
 * `fetchImpl` (same fixture style as `conformance.test.ts` / `upstream-target.test.ts`)
 * and the assertions are made on the wire bytes the SDK would actually receive. The
 * two translation halves have their own contract suites (`anthropic-inbound.test.ts`,
 * `anthropic-outbound.test.ts`); what is proven HERE is the glue — that the inbound
 * translation, the existing Responses pipeline and the outbound translation compose
 * into a correct Anthropic turn.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';

// ---- fixtures ----
interface Ev { name: string; data: Record<string, any> }

/** Parse an Anthropic SSE body into `event:`/`data:` pairs, in wire order. */
function parseSse(text: string): Ev[] {
  const events: Ev[] = [];
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    let name = '';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!name || !data) continue;
    events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

function stubUpstream(response: () => Response): typeof fetch {
  return (async () => response()) as unknown as typeof fetch;
}

/** Like `stubUpstream`, but records the chat-completions body actually sent upstream. */
function capturingUpstream(bodies: Record<string, any>[], response: () => Response): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return response();
  }) as unknown as typeof fetch;
}

/** A canned chat-completions SSE upstream body. */
function chatSseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const MODEL = 'claude-sonnet-4-5-20250929';
const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

function messagesRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    ...extra,
  };
}

async function postMessages(port: number, body: unknown, path = '/v1/messages?beta=true'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Event names with `ping` removed — pings are spec-legal anywhere and not ordered. */
function order(events: Ev[]): string[] {
  return events.filter((e) => e.name !== 'ping').map((e) => e.name);
}

// ============================================================
describe('T3 /v1/messages — streaming text turn', () => {
  test('a plain text turn streams the pinned Anthropic event order', async () => {
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ', world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSse(await res.text());
    expect(order(events)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = events.find((e) => e.name === 'message_start')!;
    expect(start.data.message.type).toBe('message');
    expect(start.data.message.role).toBe('assistant');
    expect(start.data.message.model).toBe(MODEL);

    const blockStart = events.find((e) => e.name === 'content_block_start')!;
    expect(blockStart.data.content_block.type).toBe('text');
    expect(blockStart.data.index).toBe(0);

    const text = events
      .filter((e) => e.name === 'content_block_delta')
      .map((e) => e.data.delta.text)
      .join('');
    expect(text).toBe('Hello, world');
    expect(events.filter((e) => e.name === 'content_block_delta').every((e) => e.data.delta.type === 'text_delta')).toBe(true);

    const messageDelta = events.find((e) => e.name === 'message_delta')!;
    expect(messageDelta.data.delta.stop_reason).toBe('end_turn');
    expect(messageDelta.data.usage.input_tokens).toBe(11);
    expect(messageDelta.data.usage.output_tokens).toBe(7);

    await adapter.close();
  });

  test('the route matches on path, so `?beta=true` and a bare path behave identically', async () => {
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const bare = await postMessages(adapter.port, messagesRequest(), '/v1/messages');
    expect(bare.status).toBe(200);
    expect(order(parseSse(await bare.text()))).toContain('message_stop');
    await adapter.close();
  });
});

describe('T3 /v1/messages — tool calls', () => {
  test('two parallel tool calls become two tool_use blocks with input_json_delta', async () => {
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/a.ts"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Grep', arguments: '{"pattern":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest({
      tools: [
        { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
        { name: 'Grep', description: 'search', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
      ],
    }));
    const events = parseSse(await res.text());

    const starts = events.filter((e) => e.name === 'content_block_start');
    expect(starts).toHaveLength(2);
    expect(starts.map((e) => e.data.content_block.type)).toEqual(['tool_use', 'tool_use']);
    expect(starts.map((e) => e.data.content_block.id)).toEqual(['call_a', 'call_b']);
    expect(starts.map((e) => e.data.content_block.name)).toEqual(['Read', 'Grep']);
    expect(starts.map((e) => e.data.index)).toEqual([0, 1]);

    // Each block's input_json_delta run must reassemble into its own valid JSON.
    const jsonFor = (index: number) => events
      .filter((e) => e.name === 'content_block_delta' && e.data.index === index)
      .map((e) => {
        expect(e.data.delta.type).toBe('input_json_delta');
        return e.data.delta.partial_json as string;
      })
      .join('');
    expect(JSON.parse(jsonFor(0))).toEqual({ file_path: '/a.ts' });
    expect(JSON.parse(jsonFor(1))).toEqual({ pattern: 'x' });

    // Both blocks close, and the turn ends as a tool turn.
    expect(events.filter((e) => e.name === 'content_block_stop').map((e) => e.data.index)).toEqual([0, 1]);
    expect(events.find((e) => e.name === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');

    await adapter.close();
  });
});

describe('T3 /v1/messages — empty tool_calls[] from a relay', () => {
  /**
   * U4's second half. The `tool_calls: []` shape is a chat-completions concept,
   * so the Claude route only meets it after two translations — which is exactly
   * why it needs its own case: the conformance suite proves the Responses side
   * stays clean, and this proves nothing manufactures a `tool_use` block on the
   * way out to an Anthropic client.
   */
  test('an empty tool_calls array still streams an ordinary text turn', async () => {
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'Just text' } }] },
      { choices: [{ delta: { tool_calls: [] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(200);
    const events = parseSse(await res.text());

    const blocks = events.filter((e) => e.name === 'content_block_start').map((e) => e.data.content_block.type);
    expect(blocks).toEqual(['text']);
    // No phantom tool_use anywhere in the stream, and the turn ends normally.
    expect(events.some((e) => JSON.stringify(e.data).includes('tool_use'))).toBe(false);
    expect(events.find((e) => e.name === 'message_delta')!.data.delta.stop_reason).toBe('end_turn');
    expect(events.at(-1)!.name).toBe('message_stop');

    await adapter.close();
  });

  test('an empty tool_calls array announced as finish_reason "tool_calls" still terminates', async () => {
    // The relay says it is calling tools and sends none. The client must still
    // get a terminal message rather than an open stream.
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'Considering' } }] },
      { choices: [{ delta: { tool_calls: [] }, finish_reason: 'tool_calls' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(200);
    const events = parseSse(await res.text());

    expect(events.at(-1)!.name).toBe('message_stop');
    expect(events.some((e) => JSON.stringify(e.data).includes('tool_use'))).toBe(false);

    await adapter.close();
  });
});

describe('T3 /v1/messages — truncation', () => {
  test('upstream finish_reason "length" surfaces as stop_reason "max_tokens"', async () => {
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'a very long answ' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest({ max_tokens: 4 }));
    const events = parseSse(await res.text());

    const messageDelta = events.find((e) => e.name === 'message_delta')!;
    expect(messageDelta.data.delta.stop_reason).toBe('max_tokens');
    // The truncated text is still delivered, and the turn still terminates cleanly.
    expect(events.filter((e) => e.name === 'content_block_delta').map((e) => e.data.delta.text).join('')).toBe('a very long answ');
    expect(order(events).at(-1)).toBe('message_stop');
    expect(messageDelta.data.usage.output_tokens).toBe(7);

    await adapter.close();
  });
});

describe('T3 /v1/messages — request options reach the upstream', () => {
  test('the Anthropic max_tokens survives both translations as chat max_tokens', async () => {
    // Anthropic `max_tokens` → Responses `max_output_tokens` (inbound.ts) → chat
    // `max_tokens` (to-chat.ts). The last hop did not exist and the cap was dropped.
    const bodies: Record<string, any>[] = [];
    const fetchImpl = capturingUpstream(bodies, () => chatSseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest({ max_tokens: 512 }));
    await res.text();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.max_tokens).toBe(512);
    await adapter.close();
  });
});

describe('T3 /v1/messages — non-streaming', () => {
  test('stream:false returns a single Anthropic message JSON', async () => {
    const fetchImpl = stubUpstream(() => new Response(
      JSON.stringify({ choices: [{ message: { content: 'plain answer' } }], usage: USAGE }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest({ stream: false }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe(MODEL);
    expect(body.content).toEqual([{ type: 'text', text: 'plain answer' }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage.input_tokens).toBe(11);
    expect(body.usage.output_tokens).toBe(7);

    await adapter.close();
  });
});

describe('T3 /v1/messages — mid-stream upstream failure', () => {
  test('an upstream socket failure after headers becomes an Anthropic error event, not a silent truncation', async () => {
    // Exercises the bridge's `response.failed` synthesis: the pipeline throws, the
    // bridge hands the vendored translator a terminal Responses `response.failed`,
    // and the translator maps that to an Anthropic `error` event.
    const encoder = new TextEncoder();
    const fetchImpl = stubUpstream(() => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`));
          controller.error(new Error('socket hang up'));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(200); // the failure happened after the headers went out
    const events = parseSse(await res.text());
    const error = events.find((e) => e.name === 'error');
    expect(error).toBeDefined();
    expect(error!.data.type).toBe('error');
    expect(error!.data.error.message).toContain('upstream stream error');
    // A failed turn must NOT look like a finished one.
    expect(order(events)).not.toContain('message_stop');

    await adapter.close();
  });
});

describe('T3 /v1/messages — errors are Anthropic-shaped', () => {
  test('F1.1089 — an upstream quota 429 carries x-should-retry: false, because the shipped SDK retries it otherwise (measured 2026-10-11)', async () => {
    // The rig measurement behind this arm (work/l5e/claude-retry-probe.ts,
    // 2026-10-11, binary 0.3.280): pointed at a stub answering 429
    // insufficient_quota with NO header, the shipped binary attempted
    // /v1/messages 8 times (backoff gaps 837→33961 ms) before its own log said
    // "no more retries left"; the SAME 429 with x-should-retry: false got ONE
    // attempt and surfaced the quota error in 602 ms. The adapter is the only
    // place the pair can be set — the gateway speaks OpenAI-ish, the SDK speaks
    // Anthropic, and this mapping is the seam.
    const fetchImpl = stubUpstream(() => new Response(JSON.stringify({
      error: { message: 'insufficient_quota: You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' },
    }), { status: 429 }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('x-should-retry')).toBe('false');
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toContain('insufficient_quota');
    await adapter.close();
  });

  test('F1.1089 control — a plain 429 stays headerless, because a real rate limit SHOULD be retried', async () => {
    const fetchImpl = stubUpstream(() => new Response(JSON.stringify({
      error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' },
    }), { status: 429 }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('x-should-retry')).toBeNull();
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.type).toBe('rate_limit_error');
    await adapter.close();
  });

  test('an upstream 401 becomes an Anthropic authentication_error, not an OpenAI envelope', async () => {
    const fetchImpl = stubUpstream(() => new Response('{"detail":"token expired"}', { status: 401 }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postMessages(adapter.port, messagesRequest());

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(typeof body.error.message).toBe('string');
    // Neutral wording: this route also serves BYO endpoints (T6), not just the gateway.
    expect(body.error.message).not.toContain('Nessy Gateway');
    expect(body).not.toHaveProperty('error.code');

    await adapter.close();
  });

  test('a malformed Anthropic request is a 400 invalid_request_error', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => new Response('{}', { status: 200 })) });
    const res = await postMessages(adapter.port, { messages: [{ role: 'user', content: 'hi' }] }); // no model
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('model');
    await adapter.close();
  });

  test('the gateway credential gate 401s in Anthropic shape too', async () => {
    const adapter = await startAdapter({ jwt: null });
    const res = await postMessages(adapter.port, messagesRequest());
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, any>;
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    await adapter.close();
  });
});

describe('T3 /v1/messages — count_tokens stays unimplemented', () => {
  test('POST and GET /v1/messages/count_tokens both 404 (the SDK then estimates locally)', async () => {
    const adapter = await startAdapter({ jwt: 'j' });
    const post = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages/count_tokens`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, messages: [] }),
    });
    expect(post.status).toBe(404);
    const get = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages/count_tokens`);
    expect(get.status).toBe(404);
    await adapter.close();
  });
});

// ============================================================
/**
 * G3 — per-request wire routing, and the passthrough it selects.
 *
 * The routing decision is made on the RAW inbound body, before any translation,
 * because for these models translating is the bug: llm-proxy serves
 * `anthropic/*` on `/v1/messages` only. So the assertion is not "the output
 * looks right" but "nothing touched it" — the upstream's own bytes come back.
 */
describe('G3 /v1/messages — anthropic-wire passthrough', () => {
  const WIRED = 'anthropic/claude-opus-5';
  const PASSTHROUGH = { kind: 'anthropic-messages', baseUrl: 'https://llm-proxy.test', apiKey: 'sk-wire' } as const;

  /** Captures the outbound request and replies with a body of our choosing. */
  function captureFetch(seen: Array<{ url: string; body: unknown }>, reply: Response) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')) });
      return reply;
    }) as unknown as typeof fetch;
  }

  test('sends the INBOUND body verbatim and returns the upstream answer untouched', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const upstreamJson = { id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'from upstream' }] };
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test', apiKey: 'sk-wire' },
      upstreamForModel: (model) => (model === WIRED ? PASSTHROUGH : undefined),
      fetchImpl: captureFetch(seen, new Response(JSON.stringify(upstreamJson), {
        status: 200, headers: { 'content-type': 'application/json' },
      })),
    });
    try {
      const sent = messagesRequest({ model: WIRED, stream: false });
      const res = await postMessages(adapter.port, sent);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe('https://llm-proxy.test/v1/messages');
      // Verbatim: not re-shaped through Responses and back.
      expect(seen[0]!.body).toEqual(sent);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(upstreamJson);
    } finally {
      await adapter.close();
    }
  });

  test('leaves every OTHER model on the translating path', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test', apiKey: 'sk-wire' },
      upstreamForModel: (model) => (model === WIRED ? PASSTHROUGH : undefined),
      fetchImpl: captureFetch(seen, new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    try {
      await postMessages(adapter.port, messagesRequest({ model: 'tgpt/qwen35-397b-a17b-fp8', stream: false }));
      expect(seen[0]!.url).toBe('https://llm-proxy.test/chat/completions');
      // Translated, not passed through: a chat body has `messages` and no
      // `max_tokens`-shaped Anthropic envelope.
      expect(seen[0]!.body).toHaveProperty('messages');
    } finally {
      await adapter.close();
    }
  });

  test('streams a passthrough SSE response through as SSE', async () => {
    const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    const seen: Array<{ url: string; body: unknown }> = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: captureFetch(seen, new Response(sse, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })),
    });
    try {
      const res = await postMessages(adapter.port, messagesRequest({ model: WIRED }));
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(await res.text()).toBe(sse);
    } finally {
      await adapter.close();
    }
  });

  test('routes nothing when no resolver is supplied — the pre-G3 world', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      fetchImpl: captureFetch(seen, new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    try {
      await postMessages(adapter.port, messagesRequest({ model: WIRED, stream: false }));
      expect(seen[0]!.url).toBe('https://llm-proxy.test/chat/completions');
    } finally {
      await adapter.close();
    }
  });
});
