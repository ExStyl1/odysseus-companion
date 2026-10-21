/**
 * Codex-responses-adapter conformance suite (blueprint §16.1, addendum 8).
 *
 * Two tiers:
 *  - OFFLINE (always run, deterministic): adversarial adapter-logic cases driven
 *    with a stubbed upstream — invalid JSON args, unknown tool, multi/zero tool
 *    calls, usage mapping, error mapping, retry ladder, cancellation, reasoning
 *    surfaced / matched_stop dropped. These are the CI gate.
 *  - LIVE (gated on a real JWT + reachable gateway): non-stream + streaming text,
 *    function_call generation with valid-JSON args, reasoning extraction, large
 *    context. Skipped cleanly (with a logged note) when the gateway is
 *    unreachable so the suite still passes offline.
 *
 * Live cases read the JWT strictly read-only from ~/.nessy/dp_auth_creds.json.
 */
import { test, expect, describe, beforeAll } from 'bun:test';
import { startAdapter } from '../server.ts';
import { readNestorJwt } from '../nestor-auth.ts';
import { NESTOR_CHAT_URL } from '../nestor-client.ts';
import { toChatRequest } from '../to-chat.ts';
import { streamResponsesFromChat, type ChatChunk } from '../from-chat-stream.ts';

// ---- helpers ----
interface SseEvent { event: string; data: Record<string, unknown>; }

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try {
      events.push({ event: eventLine?.slice(6).trim() ?? '', data: JSON.parse(dataLine.slice(5).trim()) });
    } catch {
      /* ignore */
    }
  }
  return events;
}

function stubUpstream(response: () => Response): typeof fetch {
  return (async () => response()) as unknown as typeof fetch;
}

/** Build a stubbed chat SSE Response from chat chunks. */
function chatSseResponse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function postResponses(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ============================================================
// OFFLINE (CI gate)
// ============================================================
describe('conformance — offline (stubbed upstream)', () => {
  test('invalid JSON tool args are passed through raw (non-stream)', async () => {
    const fetchImpl = stubUpstream(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'exec_command', arguments: '{bad json' } }] } }] }), { status: 200 }),
    );
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
    const json = (await res.json()) as { output: Array<{ type: string; arguments?: string }> };
    const fc = json.output.find((o) => o.type === 'function_call')!;
    expect(fc.arguments).toBe('{bad json');
    await adapter.close();
  });

  test('unknown tool call is still surfaced (adapter does not validate names)', async () => {
    const fetchImpl = stubUpstream(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'not_a_real_tool', arguments: '{}' } }] } }] }), { status: 200 }),
    );
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postResponses(adapter.port, { model: 'm', input: [], tools: [{ type: 'function', name: 'exec_command', parameters: {} }], stream: false });
    const json = (await res.json()) as { output: Array<{ type: string; name?: string }> };
    expect(json.output.find((o) => o.type === 'function_call')?.name).toBe('not_a_real_tool');
    await adapter.close();
  });

  test('multiple tool calls → multiple function_call items; zero → none', async () => {
    const multi = stubUpstream(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{}' } }, { id: 'b', function: { name: 'g', arguments: '{}' } }] } }] }), { status: 200 }),
    );
    let adapter = await startAdapter({ jwt: 'j', fetchImpl: multi });
    let json = (await (await postResponses(adapter.port, { model: 'm', input: [], stream: false })).json()) as { output: Array<{ type: string }> };
    expect(json.output.filter((o) => o.type === 'function_call').length).toBe(2);
    await adapter.close();

    const none = stubUpstream(() => new Response(JSON.stringify({ choices: [{ message: { content: 'just text' } }] }), { status: 200 }));
    adapter = await startAdapter({ jwt: 'j', fetchImpl: none });
    json = (await (await postResponses(adapter.port, { model: 'm', input: [], stream: false })).json()) as { output: Array<{ type: string }> };
    expect(json.output.filter((o) => o.type === 'function_call').length).toBe(0);
    expect(json.output.some((o) => o.type === 'message')).toBe(true);
    await adapter.close();
  });

  test('usage mapped; matched_stop ignored; reasoning surfaced not dropped', async () => {
    const fetchImpl = stubUpstream(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'answer', reasoning_content: 'my plan' }, matched_stop: 151645 }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, reasoning_tokens: 5 } }), { status: 200 }),
    );
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const json = (await (await postResponses(adapter.port, { model: 'm', input: [], stream: false })).json()) as { output: Array<{ type: string; content?: Array<{ text?: string }> }>; usage: Record<string, number> };
    expect(json.usage).toEqual({ input_tokens: 10, output_tokens: 20, total_tokens: 30 }); // reasoning_tokens not surfaced
    const reasoning = json.output.find((o) => o.type === 'reasoning');
    expect(reasoning?.content?.[0]?.text).toBe('my plan');
    // reasoning must NOT be in the message text
    const msg = json.output.find((o) => o.type === 'message');
    expect(JSON.stringify(msg)).not.toContain('my plan');
    await adapter.close();
  });

  // P3.334 — the second arm asserted `500 → 502`; the route no longer collapses
  // the upstream status (see `server.ts`, the `!upstream.ok` block).
  test('error mapping: non-flaky 400 → 400, 500 → 500', async () => {
    const bad = stubUpstream(() => new Response(JSON.stringify({ error: { message: 'bad params' } }), { status: 400 }));
    let adapter = await startAdapter({ jwt: 'j', fetchImpl: bad });
    let res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
    expect(res.status).toBe(400);
    await adapter.close();

    const boom = stubUpstream(() => new Response('boom', { status: 500 }));
    adapter = await startAdapter({ jwt: 'j', fetchImpl: boom });
    res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
    expect(res.status).toBe(500);
    await adapter.close();
  });

  test('streaming: text + tool_call → well-ordered Responses SSE with valid-JSON args', async () => {
    const fetchImpl = stubUpstream(() =>
      chatSseResponse([
        { choices: [{ delta: { content: 'hi ' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]),
    );
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postResponses(adapter.port, { model: 'm', input: [], stream: true });
    const events = parseSse(await res.text());
    expect(events[0]?.event).toBe('response.created');
    expect(events.at(-1)?.event).toBe('response.completed');
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    expect(JSON.parse(done!.data.arguments as string)).toEqual({ cmd: 'ls' });
    await adapter.close();
  });
});

// ============================================================
// §16.1 translation conformance (offline, pure functions)
// ============================================================
describe('conformance — §16.1 translation (offline)', () => {
  async function streamFrames(chunks: ChatChunk[]): Promise<string[]> {
    const frames: string[] = [];
    async function* gen() { for (const c of chunks) yield c; }
    await streamResponsesFromChat(gen(), (f) => frames.push(f), { model: 'm', responseId: 'r' });
    return frames;
  }

  test('tools[] → OpenAI {type:function,function:{...}}; never tool_choice; consumer-only', () => {
    const chat = toChatRequest({
      model: 'm',
      tool_choice: 'auto', // codex may send it; must be dropped
      input: [],
      tools: [{ type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } }],
    } as never);
    expect(chat.tools![0]).toEqual({ type: 'function', function: { name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } } });
    expect('tool_choice' in chat).toBe(false);
    // consumer-only: never mutate server behavior
    expect('chat_template_kwargs' in chat).toBe(false);
    expect('enable_thinking' in chat).toBe(false);
  });

  test('sampling defaults: temperature 0.7 / top_p 0.8; temperature 0 is clamped', () => {
    const def = toChatRequest({ model: 'm', input: [] });
    expect(def.temperature).toBe(0.7);
    expect(def.top_p).toBe(0.8);
    const zero = toChatRequest({ model: 'm', input: [], temperature: 0 });
    expect(zero.temperature).not.toBe(0);
    const explicit = toChatRequest({ model: 'm', input: [], temperature: 0.4 });
    expect(explicit.temperature).toBe(0.4);
  });

  /**
   * U4 — relays that send an empty `tool_calls: []`.
   *
   * Upstream v0.11.3 fixed stream completion breaking on this shape, and our BYO
   * endpoints are exactly that class of relay. Two ways it could break here, and
   * the second is the one a "does it crash" test would miss: an empty array
   * could leave the flush waiting for a call that never arrives, or it could
   * manufacture a `function_call` item out of nothing. Neither may happen, and
   * the turn must still complete as ordinary text.
   */
  test('empty tool_calls[] in a delta completes as a normal text turn', async () => {
    const frames = await streamFrames([
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { tool_calls: [] } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    expect(frames.some((f) => f.includes('response.completed'))).toBe(true);
    // No phantom call: not one function_call item, not one arguments frame.
    expect(frames.some((f) => f.includes('function_call'))).toBe(false);
    expect(frames.some((f) => f.includes('response.function_call_arguments'))).toBe(false);
    // The text still arrives — an empty array must not swallow the answer.
    expect(frames.some((f) => f.includes('output_text') || f.includes('output_text.delta'))).toBe(true);
  });

  test('empty tool_calls[] alongside finish_reason "tool_calls" still terminates', async () => {
    // The nastier shape: the relay ANNOUNCES tool calls and sends none. The
    // stream must still reach a terminal frame rather than hang waiting.
    const frames = await streamFrames([
      { choices: [{ delta: { content: 'thinking about it' } }] },
      { choices: [{ delta: { tool_calls: [] }, finish_reason: 'tool_calls' }] },
    ]);

    expect(frames.some((f) => f.includes('response.completed') || f.includes('response.incomplete'))).toBe(true);
    expect(frames.some((f) => f.includes('function_call'))).toBe(false);
  });

  test('streaming N parallel tool calls: 0, 1, and N indices, no cross-contamination', async () => {
    const frames = await streamFrames([
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
        { index: 1, id: 'b', type: 'function', function: { name: 'g', arguments: '{"y":' } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: null, function: { arguments: '2}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
    );
    const dones = frames.filter((f) => f.includes('response.function_call_arguments.done')).map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)));
    expect(dones.length).toBe(2);
    const byCall = Object.fromEntries(dones.map((d) => [d.item_id, JSON.parse(d.arguments)]));
    expect(byCall['fc_a']).toEqual({ x: 1 });
    expect(byCall['fc_b']).toEqual({ y: 2 }); // fragment on index 1 with id:null appended to the right call
  });

  test('finish_reason "length" still ends the CODEX stream with response.completed', async () => {
    // Regression guard for the `truncationFrame` option: the Anthropic route opts
    // into `response.incomplete` (to reach `stop_reason: "max_tokens"`), but codex's
    // consumer reads a stream that never reaches `response.completed` as a stream
    // error — a worse outcome than reporting a truncated turn as a finished one.
    // The default must stay `completed` for this route.
    const fetchImpl = stubUpstream(() => chatSseResponse([
      { choices: [{ delta: { content: 'cut o' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
    ]));
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await postResponses(adapter.port, { model: 'm', input: [], stream: true });
    const names = parseSse(await res.text()).map((e) => e.event);
    expect(names).toContain('response.completed');
    expect(names).not.toContain('response.incomplete');
    await adapter.close();
  });

  test('continuation chunk {id:null,type:null,name:null} is tolerated, not an error', async () => {
    const frames = await streamFrames([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }],
    );
    const done = frames.find((f) => f.includes('response.function_call_arguments.done'))!;
    expect(JSON.parse(JSON.parse(done.slice(done.indexOf('data: ') + 6)).arguments)).toEqual({ a: 'b' });
  });
});

// ============================================================
// LIVE (gated on JWT + reachability; strictly read-only)
// ============================================================
const jwt = readNestorJwt();
let live = false;
let retryRungs: number[] = [];

/**
 * The model the live cases drive, taken from the gateway's OWN catalogue.
 *
 * Never a pinned id again. These three cases pinned `tgpt/qwen35-397b-a17b-fp8`
 * — the gateway's default coder model when they were written, and the one
 * `AGENTS.md` §Gateway Facts still names — and on 2026-09-11 the gateway
 * answered `404 {"error":{"code":404,"message":"Модель
 * tgpt/qwen35-397b-a17b-fp8 больше не поддерживается…"}}`: the model was
 * RETIRED. `/models` returned 200 the whole time, so `live` was true and all
 * three cases ran against a dead id; the third only warns when it finds no tool
 * call, so it went GREEN on the 404's empty SSE stream.
 *
 * A catalogue this suite does not control will retire another id, so the id is
 * read rather than written down: `is_default` first, then the `coder` alias,
 * then whatever is first. The catalogue on that date held two models and
 * neither was flagged default, which is why the alias fallback exists.
 */
let liveModel = '';

function pickLiveModel(catalogue: unknown): string {
  if (!Array.isArray(catalogue)) return '';
  const rows = catalogue.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  const byDefault = rows.find((row) => row.is_default === true);
  const byAlias = rows.find((row) => row.alias === 'coder');
  const id = (byDefault ?? byAlias ?? rows[0])?.id;
  return typeof id === 'string' ? id : '';
}

describe.if(!!jwt)('conformance — live gateway', () => {
  beforeAll(async () => {
    try {
      const res = await fetch(NESTOR_CHAT_URL.replace('/openai-like/v1/chat/completions', '/models'), {
        headers: { 'Nestor-Token': jwt as string },
        signal: AbortSignal.timeout(10_000),
      });
      liveModel = res.ok ? pickLiveModel(await res.json().catch(() => null)) : '';
      // A reachable gateway that names no model is not a live rig: running the
      // cases against `''` would fail for a reason that is not the adapter's.
      live = res.ok && liveModel !== '';
    } catch {
      live = false;
    }
    if (!live) console.warn('[conformance] gateway unreachable or named no model — live cases skipped (offline suite still gates).');
    else console.warn(`[conformance] live model from the gateway catalogue: ${liveModel}`);
  });

  test('non-stream text', async () => {
    if (!live) return;
    const adapter = await startAdapter({ jwt, onRetryRung: (r) => retryRungs.push(r) });
    const res = await postResponses(adapter.port, { model: liveModel, instructions: 'Answer tersely.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say the single word: pong' }] }], stream: false, temperature: 0.7, top_p: 0.8 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { output: Array<{ type: string; content?: Array<{ text?: string }> }>; usage: Record<string, number> };
    const msgText = JSON.stringify(json.output.filter((o) => o.type === 'message'));
    expect(msgText.toLowerCase()).toContain('pong');
    expect(msgText).not.toContain('<think>'); // reasoning must be split out
    expect(json.usage.total_tokens).toBeGreaterThan(0);
    await adapter.close();
  }, 60_000);

  test('streaming text surfaces reasoning in a reasoning item, never in output_text', async () => {
    if (!live) return;
    const adapter = await startAdapter({ jwt, onRetryRung: (r) => retryRungs.push(r) });
    const res = await postResponses(adapter.port, { model: liveModel, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Briefly, what is 2+2? Think first.' }] }], stream: true, temperature: 0.7, top_p: 0.8 });
    const events = parseSse(await res.text());
    expect(events[0]?.event).toBe('response.created');
    expect(events.at(-1)?.event).toBe('response.completed');
    const textDeltas = events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta as string).join('');
    expect(textDeltas).not.toContain('<think>');
    expect(textDeltas).not.toContain('</think>');
    await adapter.close();
  }, 60_000);

  test('function_call generation yields valid-JSON args (best-effort, records retry rate)', async () => {
    if (!live) return;
    const adapter = await startAdapter({ jwt, onRetryRung: (r) => retryRungs.push(r) });
    const res = await postResponses(adapter.port, {
      model: liveModel,
      instructions: 'You must call the exec_command tool to run the command. Do not answer in text.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run: echo hi' }] }],
      tools: [{ type: 'function', name: 'exec_command', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }],
      stream: true,
      temperature: 0.7,
      top_p: 0.8,
    });
    const events = parseSse(await res.text());
    const done = events.find((e) => e.event === 'response.function_call_arguments.done');
    if (done) {
      // If the model called the tool, its reconstructed args must be valid JSON.
      expect(() => JSON.parse(done.data.arguments as string)).not.toThrow();
    } else {
      console.warn('[conformance] live model returned text instead of a tool call (non-deterministic) — args-validity assertion skipped this run.');
    }
    await adapter.close();
  }, 60_000);
});
