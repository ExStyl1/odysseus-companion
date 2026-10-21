/**
 * Task T3b — stream-integrity contract for the SHARED pipeline
 * (`parseChatSse` + `streamResponsesFromChat`), vendored from opencodex @ 16bef04.
 *
 * Before T3b a cut socket, a mid-200-stream provider error envelope and an empty
 * tool-argument string all reached the client as a clean `response.completed` /
 * `arguments: ""`. Each row below pins one of those to the vendored behaviour, on
 * BOTH front doors — the terminal frames here (`response.failed`,
 * `response.incomplete` on stall/EOF, the trailing `data: [DONE]`) are the frames
 * codex-rs itself recognizes, so unlike the `truncationFrame` gate they are NOT
 * per-route opt-ins.
 *
 * Fixture style follows `conformance.test.ts` / `anthropic-route.test.ts`: a canned
 * chat-completions upstream injected through `fetchImpl`, assertions on wire bytes.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';
import {
  parseChatSse,
  streamResponsesFromChat,
  DEFAULT_HEARTBEAT_MS,
  type ChatChunk,
} from '../from-chat-stream.ts';
import { classifyError, adapterFailureFromMessage } from '../errors.ts';

// ---- helpers ----
interface Ev { event: string; data: Record<string, any> }

/** Parse a Responses SSE body; `data: [DONE]` (no `event:` line) is reported as-is. */
function parseSse(text: string): Ev[] {
  const out: Ev[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) continue;
    if (data.trim() === '[DONE]') { out.push({ event, data: { __done: true } }); continue; }
    try { out.push({ event, data: JSON.parse(data) }); } catch { /* ignore */ }
  }
  return out;
}

function stubUpstream(response: () => Response): typeof fetch {
  return (async () => response()) as unknown as typeof fetch;
}

/** A chat-completions SSE upstream body that ends GRACEFULLY (`[DONE]`). */
function chatSseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A chat-completions SSE upstream body that just STOPS — no `[DONE]`, no finish_reason. */
function truncatedChatSse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function postResponses(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function postMessages(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const MESSAGES_REQUEST = { model: 'claude-sonnet-4-5-20250929', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }], stream: true };

/** Drive the emitter directly over a chunk list and return the raw frames. */
async function collect(chunks: ChatChunk[], opts: Record<string, unknown> = {}): Promise<string[]> {
  const frames: string[] = [];
  async function* gen() { for (const c of chunks) yield c; }
  await streamResponsesFromChat(gen(), (f) => frames.push(f), { model: 'm', responseId: 'r', ...opts });
  return frames;
}

/** Read a chat SSE body string through `parseChatSse`. */
async function parseBody(body: string): Promise<ChatChunk[]> {
  const stream = new Response(body).body as unknown as ReadableStream<Uint8Array>;
  const out: ChatChunk[] = [];
  for await (const c of parseChatSse(stream)) out.push(c);
  return out;
}

// ============================================================
// (a) EOF without a terminal signal
// ============================================================
describe('T3b (a) — upstream stream ends without [DONE]/finish_reason', () => {
  test('parseChatSse synthesizes a terminal error chunk instead of ending cleanly', async () => {
    const chunks = await parseBody(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.error?.message).toContain('without a terminal signal');
  });

  test('a graceful [DONE] close is NOT flagged, and neither is finish_reason-without-[DONE]', async () => {
    const withDone = await parseBody(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\ndata: [DONE]\n\n`);
    expect(withDone.some((c) => c.error)).toBe(false);
    const withFinish = await parseBody(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    expect(withFinish.some((c) => c.error)).toBe(false);
  });

  test('a terminal frame with no trailing newline is still parsed (residual-buffer flush)', async () => {
    const residual = await parseBody(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`);
    expect(residual.some((c) => c.error)).toBe(false);
    expect(residual[0]?.choices?.[0]?.finish_reason).toBe('stop');
  });

  test('/v1/responses: a truncated stream ends in response.failed, NOT response.completed', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => truncatedChatSse([{ choices: [{ delta: { content: 'partial' } }] }])) });
    const events = parseSse(await (await postResponses(adapter.port, { model: 'm', input: [], stream: true })).text());
    const names = events.map((e) => e.event);
    expect(names).toContain('response.failed');
    expect(names).not.toContain('response.completed');
    // The partial text still reached the client before the failure.
    expect(names).toContain('response.output_text.delta');
    const failed = events.find((e) => e.event === 'response.failed')!;
    expect(failed.data.response.last_error.message).toContain('without a terminal signal');
    await adapter.close();
  });

  test('/v1/messages: the same truncation becomes an Anthropic error event, never message_stop', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => truncatedChatSse([{ choices: [{ delta: { content: 'partial' } }] }])) });
    const events = parseSse(await (await postMessages(adapter.port, MESSAGES_REQUEST)).text());
    const names = events.map((e) => e.event);
    expect(names).toContain('error');
    expect(names).not.toContain('message_stop');
    expect(events.find((e) => e.event === 'error')!.data.error.message).toContain('without a terminal signal');
    await adapter.close();
  });

  test('the emitter itself fails closed when its chunk source ends with no terminal signal at all', async () => {
    // Belt-and-braces for direct-iterable callers (bridge.ts:669-686): no finish_reason,
    // no usage, no `[DONE]` marker → response.incomplete/adapter_eof, not completed.
    const frames = await collect([{ choices: [{ delta: { content: 'x' } }] }]);
    const last = parseSse(frames.join(''));
    expect(last.map((e) => e.event)).toContain('response.incomplete');
    expect(last.find((e) => e.event === 'response.incomplete')!.data.response.incomplete_details.reason).toBe('adapter_eof');
  });
});

// ============================================================
// (b) inline error envelope inside a 200 stream
// ============================================================
describe('T3b (b) — mid-200-stream {"error":{...}} chunk', () => {
  test('parseChatSse surfaces the envelope and stops reading', async () => {
    const chunks = await parseBody(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n` +
      `data: ${JSON.stringify({ error: { message: 'model overloaded, please retry' } })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'never read' } }] })}\n\n`,
    );
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.error?.message).toBe('model overloaded, please retry');
  });

  test('/v1/responses: response.failed carries the classified last_error', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'a' } }] },
      { error: { message: 'context length exceeded for this model' } },
    ])) });
    const events = parseSse(await (await postResponses(adapter.port, { model: 'm', input: [], stream: true })).text());
    expect(events.map((e) => e.event)).not.toContain('response.completed');
    const failed = events.find((e) => e.event === 'response.failed')!;
    expect(failed.data.response.status).toBe('failed');
    expect(failed.data.response.last_error.code).toBe('context_length_exceeded');
    expect(failed.data.response.error.code).toBe('context_length_exceeded');
    await adapter.close();
  });

  test('/v1/messages: the same envelope becomes an Anthropic error event with the upstream status', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'a' } }] },
      { error: { message: 'upstream is overloaded' } },
    ])) });
    const events = parseSse(await (await postMessages(adapter.port, MESSAGES_REQUEST)).text());
    expect(events.map((e) => e.event)).not.toContain('message_stop');
    const err = events.find((e) => e.event === 'error')!;
    expect(err.data.error.message).toContain('overloaded');
    await adapter.close();
  });

  test('open output items are closed before the failure frame (no dangling message item)', async () => {
    const frames = await collect([
      { choices: [{ delta: { content: 'half an ans' } }] },
      { error: { message: 'boom' } },
    ]);
    const names = parseSse(frames.join('')).map((e) => e.event);
    expect(names.indexOf('response.output_item.done')).toBeGreaterThan(-1);
    expect(names.indexOf('response.output_item.done')).toBeLessThan(names.indexOf('response.failed'));
  });
});

// ============================================================
// (c) error taxonomy
// ============================================================
describe('T3b (c) — classifyError taxonomy (codes codex-rs recognizes)', () => {
    // Classification is by KEYWORD plus an optional status — never by the numerals in
    // the text. A 529 body reads "overloaded", a 429 body reads "rate limit"; those
    // keywords are the contract, and a bare "529"/"429" in the text matches nothing.
  test.each([
    ['"overloaded" keyword (a 529 body)', 0, 'upstream error 529: overloaded', 'server_error', 'server_is_overloaded'],
    ['503 status', 503, 'service unavailable', 'server_error', 'server_is_overloaded'],
    ['"rate limit" keyword (a 429 body)', 0, 'upstream error 429: rate limit reached', 'rate_limit_error', 'rate_limit_exceeded'],
    ['429 status', 429, 'slow down', 'rate_limit_error', 'rate_limit_exceeded'],
    ['a bare numeral matches no keyword', 0, 'upstream error 529', 'api_error', 'api_error'],
    ['context window', 0, 'this model has a maximum context length of 32768 tokens', 'invalid_request_error', 'context_length_exceeded'],
    ['auth', 401, 'token expired', 'authentication_error', 'invalid_api_key'],
    ['generic 5xx', 502, 'bad gateway', 'server_error', 'upstream_server_error'],
  ])('%s → %s/%s', (_label, status, message, type, code) => {
    const out = classifyError(status as number, 'api_error', message as string);
    expect(out.type).toBe(type as string);
    expect(out.code).toBe(code as string);
  });

  test('adapterFailureFromMessage infers the status from bare upstream text', () => {
    expect(adapterFailureFromMessage('the model is overloaded').error.code).toBe('server_is_overloaded');
    expect(adapterFailureFromMessage('the model is overloaded').httpStatus).toBe(503);
    expect(adapterFailureFromMessage('rate limit reached').httpStatus).toBe(429);
    // A retry hint embedded in the message is surfaced in the classified message.
    expect(adapterFailureFromMessage('rate limit reached, retry after 12s').error.message).toContain('12s');
  });
});

// ============================================================
// (d) heartbeat / stall watchdog
// ============================================================
describe('T3b (d) — heartbeat during upstream silence', () => {
  test('the default heartbeat interval is the vendored 2 s', () => {
    expect(DEFAULT_HEARTBEAT_MS).toBe(2_000);
  });

  test('a silent upstream produces response.heartbeat frames on the wire', async () => {
    async function* slow(): AsyncGenerator<ChatChunk> {
      await new Promise((r) => setTimeout(r, 140));
      yield { choices: [{ delta: { content: 'finally' } }, ] } as ChatChunk;
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }
    const frames: string[] = [];
    await streamResponsesFromChat(slow(), (f) => frames.push(f), { model: 'm', responseId: 'r', heartbeatMs: 20 });
    const names = parseSse(frames.join('')).map((e) => e.event);
    expect(names.filter((n) => n === 'response.heartbeat').length).toBeGreaterThan(0);
    // A heartbeat is a keepalive, never a terminator.
    expect(names.at(-2) ?? names.at(-1)).toBe('response.completed');
  });

  test('a heartbeat is skipped whenever real activity happened in the interval', async () => {
    // The run must be long enough to cross several ticks (else the assertion is
    // vacuous) while every individual gap stays far below one tick (else it is flaky):
    // ~60 yields of ~2 ms against a 50 ms tick is a ~18x margin over roughly 3 ticks.
    async function* chatty(): AsyncGenerator<ChatChunk> {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2));
        yield { choices: [{ delta: { content: `${i}` } }] };
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }
    const started = Date.now();
    const frames: string[] = [];
    await streamResponsesFromChat(chatty(), (f) => frames.push(f), { model: 'm', responseId: 'r', heartbeatMs: 50 });
    expect(Date.now() - started).toBeGreaterThan(110); // >2 ticks really elapsed
    expect(frames.filter((f) => f.includes('response.heartbeat'))).toHaveLength(0);
  });

  test('a stalled upstream escalates to response.incomplete/upstream_stall_timeout and cancels', async () => {
    let cancelled = false;
    async function* stalled(): AsyncGenerator<ChatChunk> {
      yield { choices: [{ delta: { content: 'start' } }] };
      await new Promise((r) => setTimeout(r, 400));
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    }
    const frames: string[] = [];
    await streamResponsesFromChat(stalled(), (f) => frames.push(f), {
      model: 'm', responseId: 'r', heartbeatMs: 10, stallTimeoutSec: 0.05, onStall: () => { cancelled = true; },
    });
    const names = parseSse(frames.join('')).map((e) => e.event);
    expect(names).toContain('response.incomplete');
    expect(names).not.toContain('response.completed');
    expect(cancelled).toBe(true);
    const inc = parseSse(frames.join('')).find((e) => e.event === 'response.incomplete')!;
    expect(inc.data.response.incomplete_details.reason).toBe('upstream_stall_timeout');
    // Nothing is written after the terminal frame.
    expect(names.at(-1)).toBe('');   // the trailing `data: [DONE]`
    expect(names.at(-2)).toBe('response.incomplete');
  });

  test('/v1/responses: a stalled turn reaches the wire as response.incomplete (ungated, same as /messages)', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = stubUpstream(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // Enqueued SYNCHRONOUSLY: an `await` inside `start` withholds the first chunk
        // until the promise settles, so the delta would never reach the emitter before
        // the watchdog fires and the fixture would silently prove nothing about text.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'start' } }] })}\n\n`));
        setTimeout(() => { try { controller.close(); } catch { /* aborted */ } }, 600);
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl, heartbeatMs: 10, stallTimeoutSec: 0.05 });
    const events = parseSse(await (await postResponses(adapter.port, { model: 'm', input: [], stream: true })).text());
    const names = events.map((e) => e.event);
    expect(names).toContain('response.incomplete');
    expect(names).not.toContain('response.completed');
    // The text the turn DID produce must survive: the `<think>` splitter withholds
    // text it cannot yet prove is not a `<think>` opener, so a terminal path that
    // skips its flush drops the answer entirely.
    expect(names).toContain('response.output_text.delta');
    expect(events.find((e) => e.event === 'response.output_text.done')!.data.text).toBe('start');
    // The abort that stops the upstream must not also swallow the terminal frames.
    expect(events.at(-1)!.data.__done).toBe(true);
    expect(events.find((e) => e.event === 'response.incomplete')!.data.response.incomplete_details.reason).toBe('upstream_stall_timeout');
    await adapter.close();
  });

  test('/v1/messages: a stalled turn is an Anthropic error event, NOT end_turn', async () => {
    // outbound.ts (vendored, not edited) maps `response.incomplete` by
    // `incomplete_details.reason` and knows only `max_output_tokens` → max_tokens and
    // `content_filter` → refusal; `upstream_stall_timeout` would fall through to
    // end_turn. `server.ts:failUnmappedIncomplete` — OUR bridge — rewrites any other
    // reason to `response.failed` before the vendored consumer sees it.
    const encoder = new TextEncoder();
    const fetchImpl = stubUpstream(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // Enqueued SYNCHRONOUSLY: an `await` inside `start` withholds the first chunk
        // until the promise settles, so the delta would never reach the emitter before
        // the watchdog fires and the fixture would silently prove nothing about text.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'start' } }] })}\n\n`));
        setTimeout(() => { try { controller.close(); } catch { /* aborted */ } }, 600);
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl, heartbeatMs: 10, stallTimeoutSec: 0.05 });
    const events = parseSse(await (await postMessages(adapter.port, MESSAGES_REQUEST)).text());
    const names = events.map((e) => e.event);
    expect(names).toContain('error');
    expect(names).not.toContain('message_stop');
    expect(events.find((e) => e.event === 'message_delta')).toBeUndefined();
    const err = events.find((e) => e.event === 'error')!;
    expect(err.data.error.message).toContain('upstream_stall_timeout');
    expect(err.data.error.message).not.toContain('Nessy Gateway'); // neutral: BYO endpoints too
    // The partial text still reached the client before the failure.
    expect(events.some((e) => e.event === 'content_block_delta')).toBe(true);
    await adapter.close();
  });

  test('/v1/messages: a `max_output_tokens` incomplete is NOT rewritten (the mapped reasons pass through)', async () => {
    // The rewrite must be surgical: `max_tokens` is exactly what outbound.ts CAN name,
    // so `finish_reason: "length"` must keep reaching it as `response.incomplete`.
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'cut o' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ])) });
    const events = parseSse(await (await postMessages(adapter.port, MESSAGES_REQUEST)).text());
    expect(events.map((e) => e.event)).not.toContain('error');
    expect(events.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('max_tokens');
    await adapter.close();
  });

  test('a CLIENT disconnect mid-stream reports nothing and does not wedge the adapter', async () => {
    // The `clientGone` split in `server.ts` has two halves. The WATCHDOG half — an
    // abort that must NOT suppress the terminal frames — is pinned by the two stall
    // tests above; reverting the split to `signal.aborted` fails both.
    //
    // The CLIENT half cannot be pinned at the route level under bun: neither
    // `AbortController` on the client fetch NOR a hard `socket.destroy()` makes bun's
    // `node:http` fire req/res 'close' while a handler is streaming (measured on
    // 1.3.14 — the upstream signal stays unaborted for 800 ms+ in both shapes). That
    // is the same limitation `server.ts`'s ponytail note and `units.test.ts`'s
    // AbortController test already record. So this pins what IS deterministic: a
    // dropped socket must not surface as an error to anyone, and must leave the
    // adapter serving.
    const encoder = new TextEncoder();
    const fetchImpl = stubUpstream(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`));
        setTimeout(() => { try { controller.close(); } catch { /* aborted */ } }, 400);
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });

    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(MESSAGES_REQUEST), signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const seen = new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    expect(seen).not.toContain('event: error'); // nothing reported as a failure
    expect(seen).not.toContain('message_stop'); // the turn was cut, not completed

    // The adapter is still healthy: the next turn on the SAME server is served normally.
    const after = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])) });
    expect(parseSse(await (await postMessages(after.port, MESSAGES_REQUEST)).text()).map((e) => e.event).at(-1)).toBe('message_stop');
    await after.close();
    await adapter.close();
  });

  test('/v1/messages maps a heartbeat to an Anthropic ping, never to garbage', async () => {
    // outbound.ts case "response.heartbeat" → ensureStarted() + ping.
    const encoder = new TextEncoder();
    const fetchImpl = stubUpstream(() => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 60));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl, heartbeatMs: 15 });
    const events = parseSse(await (await postMessages(adapter.port, MESSAGES_REQUEST)).text());
    const names = events.map((e) => e.event);
    expect(names).toContain('ping');
    expect(names).not.toContain('response.heartbeat'); // never leaks through untranslated
    expect(names.at(-1)).toBe('message_stop');
    await adapter.close();
  });
});

// ============================================================
// (e) tool-call hardening
// ============================================================
describe('T3b (e) — empty tool args and missing call ids', () => {
  test('a no-arg tool call serializes as "{}", never ""', async () => {
    const frames = await collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_apps', arguments: '' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events = parseSse(frames.join(''));
    const done = events.find((e) => e.event === 'response.function_call_arguments.done')!;
    expect(done.data.arguments).toBe('{}');
    const itemDone = events.filter((e) => e.event === 'response.output_item.done').find((e) => e.data.item.type === 'function_call')!;
    expect(itemDone.data.item.arguments).toBe('{}');
    expect(JSON.parse(itemDone.data.item.arguments)).toEqual({});
  });

  test('a tool call the provider never gave an id gets a synthesized call_N', async () => {
    const frames = await collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, type: 'function', function: { name: 'g', arguments: '{"b":2}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const items = parseSse(frames.join(''))
      .filter((e) => e.event === 'response.output_item.done' && e.data.item.type === 'function_call')
      .map((e) => e.data.item);
    expect(items.map((i) => i.call_id)).toEqual(['call_1', 'call_2']);
    expect(items.every((i) => i.id === `fc_${i.call_id}`)).toBe(true);
    // sanitize.ts drops a replayed tool message whose call_id is "", poisoning the
    // next turn — a synthesized id is what keeps the round-trip valid.
    expect(items.some((i) => i.call_id === '')).toBe(false);
  });

  test('a provider-supplied id is never overwritten by the synthesizer', async () => {
    const frames = await collect([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'real_id', type: 'function', function: { name: 'f', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    expect(frames.join('')).toContain('"call_id":"real_id"');
  });

  test('the emitter never has two function_call items open at once (what makes outbound.ts\'s single-open-block routing safe)', async () => {
    // outbound.ts routes `input_json_delta` to THE open tool block, not by item_id
    // (T1 review). Genuinely interleaved argument deltas from two concurrently-open
    // calls would misroute — so the emitter must keep each call's added→done run
    // contiguous even when the UPSTREAM interleaves its fragments.
    const frames = await collect([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":' } },
        { index: 1, id: 'b', type: 'function', function: { name: 'g', arguments: '{"y":' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const events = parseSse(frames.join(''));
    let open: string | null = null;
    for (const e of events) {
      if (e.event === 'response.output_item.added' && e.data.item?.type === 'function_call') {
        expect(open).toBeNull(); // a second call opened while one is still open
        open = e.data.item.id;
      } else if (e.event === 'response.function_call_arguments.delta') {
        expect(e.data.item_id).toBe(open); // a delta for a call that is not the open one
      } else if (e.event === 'response.output_item.done' && e.data.item?.type === 'function_call') {
        expect(e.data.item.id).toBe(open);
        open = null;
      }
    }
    expect(open).toBeNull();
    // …and the interleaved fragments still reassemble per call.
    const dones = events.filter((e) => e.event === 'response.function_call_arguments.done');
    expect(Object.fromEntries(dones.map((d) => [d.data.item_id, JSON.parse(d.data.arguments)])))
      .toEqual({ fc_a: { x: 1 }, fc_b: { y: 2 } });
  });

  test('/v1/messages: interleaved upstream fragments still reassemble per tool_use block', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Grep', arguments: '{"pattern"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/a.ts"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])) });
    const events = parseSse(await (await postMessages(adapter.port, {
      ...MESSAGES_REQUEST,
      tools: [
        { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
        { name: 'Grep', input_schema: { type: 'object', properties: { pattern: { type: 'string' } } } },
      ],
    })).text());
    const jsonFor = (index: number) => events
      .filter((e) => e.event === 'content_block_delta' && e.data.index === index)
      .map((e) => e.data.delta.partial_json as string).join('');
    expect(JSON.parse(jsonFor(0))).toEqual({ file_path: '/a.ts' });
    expect(JSON.parse(jsonFor(1))).toEqual({ pattern: 'x' });
    await adapter.close();
  });
});

// ============================================================
// (f) the trailing [DONE] sentinel, and the untouched truncationFrame gate
// ============================================================
describe('T3b (f) — trailing [DONE] and the truncationFrame gate', () => {
  test('/v1/responses ends with a trailing data: [DONE] after the terminal frame', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ])) });
    const body = await (await postResponses(adapter.port, { model: 'm', input: [], stream: true })).text();
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const events = parseSse(body);
    expect(events.at(-1)!.data.__done).toBe(true);
    expect(events.at(-2)!.event).toBe('response.completed');
    await adapter.close();
  });

  test('/v1/messages: the trailing [DONE] is ignored by outbound.ts, not turned into an event', async () => {
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ])) });
    const body = await (await postMessages(adapter.port, MESSAGES_REQUEST)).text();
    expect(body).not.toContain('[DONE]');
    const names = parseSse(body).map((e) => e.event);
    expect(names.at(-1)).toBe('message_stop');
    await adapter.close();
  });

  test('finish_reason "length" is still gated: completed on /responses, max_tokens on /messages', async () => {
    // The new terminal frames are ungated; the pre-existing truncationFrame gate is NOT
    // folded into them and keeps its per-route behaviour.
    const chunks = [
      { choices: [{ delta: { content: 'cut o' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ];
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: stubUpstream(() => chatSseResponse(chunks)) });
    const codex = parseSse(await (await postResponses(adapter.port, { model: 'm', input: [], stream: true })).text()).map((e) => e.event);
    expect(codex).toContain('response.completed');
    expect(codex).not.toContain('response.incomplete');
    const anthropic = parseSse(await (await postMessages(adapter.port, MESSAGES_REQUEST)).text());
    expect(anthropic.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('max_tokens');
    await adapter.close();
  });
});
