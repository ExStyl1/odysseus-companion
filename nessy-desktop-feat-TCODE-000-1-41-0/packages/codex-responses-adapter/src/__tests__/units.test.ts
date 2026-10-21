/**
 * Offline per-task self-checks for the codex-responses-adapter (Tasks 2.1–2.7).
 * Deterministic, no network. The live + adversarial conformance suite is in
 * `conformance.test.ts`.
 */
import { test, it, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNestorJwt } from '../nestor-auth.ts';
import { postChat } from '../nestor-client.ts';
import { toChatRequest } from '../to-chat.ts';
import { sendWithRetry } from '../retry.ts';
import { toResponsesResponse } from '../from-chat.ts';
import { streamResponsesFromChat, type ChatChunk } from '../from-chat-stream.ts';
import { extractReasoning as extractReasoningShim } from '../reasoning.ts';
import { startAdapter } from '../server.ts';

// ---- Task 2.1: auth + client ----
describe('2.1 auth + Nestor-Token client', () => {
  test('readNestorJwt reads {jwt} and fails soft to null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-'));
    const good = join(dir, 'creds.json');
    // DA1.12 UPDATED this case rather than leaving it. It used to write
    // `expiresAt: 1` — epoch ms 1, i.e. 1970 — and assert the jwt came back,
    // which was the standing proof that the expiry field was unread. With the
    // expiry rule in place the same bytes are the NEGATIVE below, so the
    // positive needs an expiry that is actually in the future.
    writeFileSync(good, JSON.stringify({ jwt: 'aGVhZA.cGF5bG9hZA.c2ln', expiresAt: Date.now() + 60_000 }));
    expect(readNestorJwt(good)).toBe('aGVhZA.cGF5bG9hZA.c2ln');
    writeFileSync(good, JSON.stringify({ jwt: 'aGVhZA.cGF5bG9hZA.c2ln', expiresAt: 1 }));
    expect(readNestorJwt(good)).toBeNull();
    expect(readNestorJwt(join(dir, 'missing.json'))).toBeNull();
    writeFileSync(good, JSON.stringify({ no_jwt: true }));
    expect(readNestorJwt(good)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test('postChat sends Nestor-Token, no Authorization, to chat/completions', async () => {
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await postChat({ model: 'm', messages: [] }, { jwt: 'JWT123', fetchImpl });
    expect(captured!.url).toContain('/openai-like/v1/chat/completions');
    expect(captured!.headers['Nestor-Token']).toBe('JWT123');
    expect(captured!.headers['Authorization']).toBeUndefined();
  });
});

// ---- Task 2.2: Responses → chat mapping ----
describe('2.2 to-chat mapping', () => {
  test('instructions + user + function_call/output map to messages[]', () => {
    const chat = toChatRequest({
      model: 'tgpt/qwen35-397b-a17b-fp8',
      instructions: 'be nice',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
      ],
      tools: [{ type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } }],
    });
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'be nice' });
    expect(chat.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(chat.messages[2]!.tool_calls![0]).toEqual({ id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } });
    expect(chat.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file.txt' });
    expect(chat.tools![0]).toEqual({ type: 'function', function: { name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } } });
    expect(chat.model).toBe('tgpt/qwen35-397b-a17b-fp8');
  });

  test('orphan function_call_output (no matching call) is dropped by sanitizer', () => {
    const chat = toChatRequest({
      model: 'm',
      input: [
        { type: 'function_call', name: 'f', arguments: '{}' }, // no call_id → empty id → dropped
        { type: 'function_call_output', call_id: '', output: 'x' },
      ],
    });
    // The empty-id assistant tool_call is dropped, and its orphan tool result too.
    expect(chat.messages.some((m) => m.role === 'tool')).toBe(false);
  });

  test('max_output_tokens maps to chat max_tokens; absent or non-positive leaves the field off', () => {
    expect(toChatRequest({ model: 'm', input: [], max_output_tokens: 512 }).max_tokens).toBe(512);
    // No cap requested → the field must be ABSENT, so the server default wins
    // (sending `max_tokens: 0`/`null` would cap every turn at nothing).
    expect(toChatRequest({ model: 'm', input: [] })).not.toHaveProperty('max_tokens');
    expect(toChatRequest({ model: 'm', input: [], max_output_tokens: 0 })).not.toHaveProperty('max_tokens');
  });

  /**
   * P3.265 — the effort reaches the model. The three shapes are the ones the two
   * inbound paths actually produce, captured rather than imagined: the shipped
   * `codex-app-server` sends `{"effort":"xhigh","summary":"auto"}` with the config
   * key set and `{"summary":"auto"}` (no `effort` member) without it, and
   * `anthropic/inbound.ts` builds the same object from `/effort` or a thinking
   * budget.
   */
  test('reasoning.effort maps to chat reasoning_effort; absent effort leaves the field off', () => {
    // Codex's shape with the config key set.
    expect(toChatRequest({ model: 'm', input: [], reasoning: { effort: 'xhigh', summary: 'auto' } }).reasoning_effort).toBe('xhigh');
    // `none` is a value, not an absence — it is what a user who turned thinking
    // OFF chose, and it is the one level the gateway was measured to honour.
    expect(toChatRequest({ model: 'm', input: [], reasoning: { effort: 'none', summary: 'auto' } }).reasoning_effort).toBe('none');
    // Codex's CONTROL shape (config key absent): reasoning present, effort not.
    expect(toChatRequest({ model: 'm', input: [], reasoning: { summary: 'auto' } })).not.toHaveProperty('reasoning_effort');
    // No reasoning member at all.
    expect(toChatRequest({ model: 'm', input: [] })).not.toHaveProperty('reasoning_effort');
    // Non-string / empty never reaches the wire — an empty `reasoning_effort` is
    // a 400 on a strict endpoint and says nothing the omission does not.
    expect(toChatRequest({ model: 'm', input: [], reasoning: { effort: '' } })).not.toHaveProperty('reasoning_effort');
    expect(toChatRequest({ model: 'm', input: [], reasoning: { effort: 3 } })).not.toHaveProperty('reasoning_effort');
  });

  /**
   * The value is carried VERBATIM: this adapter serves several upstreams whose
   * accepted sets differ (P3.88), so narrowing here would author a policy it
   * cannot know. `ultra` is the live instance — `anthropic/inbound.ts` accepts it
   * from Claude Code's `/effort` and the Nessy gateway's literal set omits it, so
   * it must travel and earn the endpoint's own named refusal.
   */
  test('an effort the local gateway would refuse is still carried, not silently dropped', () => {
    expect(toChatRequest({ model: 'm', input: [], reasoning: { effort: 'ultra' } }).reasoning_effort).toBe('ultra');
  });
});

// ---- Task 2.3: never tool_choice; retry ladder ----
describe('2.3 no tool_choice + retry ladder', () => {
  test('tool_choice is never emitted even if the request carries one', () => {
    const chat = toChatRequest({ model: 'm', tool_choice: 'auto', input: [], tools: [{ type: 'function', name: 'f', parameters: {} }] } as never);
    expect('tool_choice' in chat).toBe(false);
  });

  test('400 "model is required" advances the ladder; final body has no required/no tool_choice', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      call += 1;
      if (call <= 2) return new Response(JSON.stringify({ error: { message: 'model is required' } }), { status: 400 });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const chat = toChatRequest({ model: 'm', input: [], tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string', description: 'x' } }, required: ['a'] } }] });
    const { rung, response } = await sendWithRetry(chat, { jwt: 'j', fetchImpl });
    expect(rung).toBe(2);
    expect(response.status).toBe(200);
    const finalTool = (bodies[2]!.tools as Array<{ function: { parameters: Record<string, unknown>; description?: string } }>)[0]!;
    expect(finalTool.function.parameters.required).toBeUndefined();
    expect(bodies.every((b) => !('tool_choice' in b))).toBe(true);
  });

  test('non-flaky 401 surfaces without retry', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('nope', { status: 401 });
    }) as unknown as typeof fetch;
    const { rung, response } = await sendWithRetry(toChatRequest({ model: 'm', input: [] }), { jwt: 'j', fetchImpl });
    expect(calls).toBe(1);
    expect(rung).toBe(0);
    expect(response.status).toBe(401);
  });
});

// ---- Task 2.4: non-stream chat → Responses ----
describe('2.4 non-stream from-chat', () => {
  test('content + tool_call yields message + function_call items', () => {
    const out = toResponsesResponse(
      { choices: [{ message: { content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
      { model: 'm', responseId: 'r1' },
    );
    const types = (out.output as Array<{ type: string }>).map((o) => o.type);
    expect(types).toEqual(['message', 'function_call']);
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  });

  test('only tool_calls → no message item; reasoning_content → reasoning item not text', () => {
    const noMsg = toResponsesResponse({ choices: [{ message: { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: 'not json' } }] } }] }, { model: 'm', responseId: 'r' });
    expect((noMsg.output as Array<{ type: string }>).map((o) => o.type)).toEqual(['function_call']);
    // malformed args passed raw
    expect((noMsg.output as Array<{ arguments?: string }>)[0]!.arguments).toBe('not json');

    const withReasoning = toResponsesResponse({ choices: [{ message: { content: 'answer', reasoning_content: 'the plan' } }] }, { model: 'm', responseId: 'r' });
    const items = withReasoning.output as Array<{ type: string; content?: Array<{ text?: string }> }>;
    expect(items[0]!.type).toBe('reasoning');
    expect(items[0]!.content![0]!.text).toBe('the plan');
    expect(items[1]!.type).toBe('message');
  });
});

// ---- Task 2.5: streaming ----
describe('2.5 stream conversion', () => {
  async function collect(chunks: ChatChunk[]): Promise<string[]> {
    const frames: string[] = [];
    async function* gen() {
      for (const c of chunks) yield c;
    }
    await streamResponsesFromChat(gen(), (f) => frames.push(f), { model: 'm', responseId: 'r1' });
    return frames;
  }

  test('text then tool_call (args reconstructed by index; null continuation tolerated)', async () => {
    const frames = await collect([
      { choices: [{ delta: { content: 'hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: null, type: null, function: { name: null, arguments: '"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]);
    const joined = frames.join('');
    const events = frames.map((f) => f.match(/event: (\S+)/)?.[1] ?? '');
    expect(events[0]).toBe('response.created');
    // T3b: the stream now ends with the trailing `data: [DONE]` sentinel, which is
    // deliberately unnamed (no `event:` line). The contract this pinned — the last
    // NAMED frame is the terminal one — is unchanged.
    expect(events.filter(Boolean).at(-1)).toBe('response.completed');
    expect(frames.at(-1)).toBe('data: [DONE]\n\n');
    // reconstructed function_call arguments parse to valid JSON
    const doneFrame = frames.find((f) => f.includes('response.function_call_arguments.done'))!;
    const args = JSON.parse(doneFrame.match(/"arguments":("(?:[^"\\]|\\.)*")/)![1]!);
    expect(JSON.parse(args)).toEqual({ cmd: 'ls' });
    expect(joined).toContain('"name":"exec_command"');
    expect(joined).toContain('response.output_text.delta');
  });

  test('reasoning via inline <think> is surfaced as reasoning events, never output_text', async () => {
    const frames = await collect([
      { choices: [{ delta: { content: '<think>plan' } }] },
      { choices: [{ delta: { content: 'ning</think>the answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    // Reassemble the delta values (a single logical string may span several frames).
    const deltaValues = (needle: string) =>
      frames
        .filter((f) => f.includes(needle))
        .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)).delta as string)
        .join('');
    const reasoning = deltaValues('response.reasoning_text.delta');
    const answer = deltaValues('response.output_text.delta');
    expect(reasoning).toBe('planning');
    expect(answer).toBe('the answer');
    // no <think> leaked into output_text
    expect(answer).not.toContain('<think>');
    expect(answer).not.toContain('plan');
  });
});

// ---- Task 2.6: reasoning shim ----
describe('2.6 reasoning shim', () => {
  test('adapter reasoning subpath re-exports the shared splitter', () => {
    expect(extractReasoningShim('<think>plan</think>answer')).toEqual({ reasoning: 'plan', answer: 'answer' });
  });
});

// ---- Task 2.7: errors + cancellation ----
describe('2.7 errors + cancellation', () => {
  test('missing JWT → 401 OpenAI error envelope', async () => {
    const adapter = await startAdapter({ jwt: null });
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe('authentication_error');
    await adapter.close();
  });

  // P3.334 — this asserted `500 → 502` until the /responses route stopped
  // collapsing the upstream status. codex-rs maps 500 to
  // `CodexErr::InternalServerError` and 502 to a bare `UnexpectedStatus`
  // (`codex-api/src/api_bridge.rs`, `rust-v0.150.1`), so the collapse cost a
  // class for nothing; the reasoning is at the emit site in `server.ts`.
  test('a gateway 500 surfaces AS 500, with the upstream status carried in the code', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, { method: 'POST', body: JSON.stringify({ model: 'm', input: [], stream: false }) });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string | null } };
    expect(body.error?.code).toBe('500');
    await adapter.close();
  });

  test('the request AbortController threads to the upstream fetch signal', async () => {
    // The server wires its per-request AbortController (fired on client
    // disconnect) into sendWithRetry -> postChat -> fetch `signal`. We test that
    // threading directly: aborting the signal aborts the in-flight upstream.
    // (Full HTTP-disconnect detection relies on node:http 'close', which fires
    //  under node but not bun's http server — see server.ts ponytail note.)
    let upstreamSignal: AbortSignal | null = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? null;
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = sendWithRetry(toChatRequest({ model: 'm', input: [], stream: true } as never), { jwt: 'j', signal: ac.signal, fetchImpl }).catch(() => null);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await p;
    expect(upstreamSignal).not.toBeNull();
    expect(upstreamSignal!.aborted).toBe(true);
  });
});

describe('namespace tools (codex multi_agent_v1)', () => {
  const NS_BODY = {
    model: 'm',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [
      { type: 'function', name: 'exec_command', parameters: { type: 'object', properties: {} } },
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        description: 'Tools for spawning and managing sub-agents.',
        tools: [
          { type: 'function', name: 'spawn_agent', description: 'spawn', parameters: { type: 'object', properties: { message: { type: 'string' } } } },
          { type: 'function', name: 'wait_agent', parameters: { type: 'object', properties: { targets: { type: 'array' } } } },
        ],
      },
      { type: 'web_search', external_web_access: false },
    ],
  } as never

  it('flattens namespace sub-tools into chat function tools and drops hosted web_search', async () => {
    const { toChatRequest } = await import('../to-chat.ts')
    const chat = toChatRequest(NS_BODY)
    const names = (chat.tools ?? []).map((t) => t.function.name)
    expect(names).toEqual(['exec_command', 'spawn_agent', 'wait_agent'])
    const spawn = (chat.tools ?? []).find((t) => t.function.name === 'spawn_agent')
    expect(spawn?.function.parameters).toEqual({ type: 'object', properties: { message: { type: 'string' } } })
  })

  it('extractToolNamespaces maps sub-tool names to their namespace', async () => {
    const { extractToolNamespaces } = await import('../to-chat.ts')
    expect(extractToolNamespaces(NS_BODY)).toEqual({ spawn_agent: 'multi_agent_v1', wait_agent: 'multi_agent_v1' })
  })

  it('non-stream function_call carries namespace for namespaced tools only', async () => {
    const { toResponsesResponse } = await import('../from-chat.ts')
    const chat = {
      choices: [{ message: { content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'spawn_agent', arguments: '{"message":"go"}' } },
        { id: 'c2', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } },
      ] }, finish_reason: 'tool_calls' }],
    } as never
    const resp = toResponsesResponse(chat, { model: 'm', responseId: 'r', toolNamespaces: { spawn_agent: 'multi_agent_v1' } })
    const calls = (resp.output as Array<Record<string, unknown>>).filter(o => o.type === 'function_call')
    expect(calls[0]!.namespace).toBe('multi_agent_v1')
    expect('namespace' in calls[1]!).toBe(false)
  })

  it('streamed function_call items carry namespace', async () => {
    const { streamResponsesFromChat } = await import('../from-chat-stream.ts')
    async function* chunks() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'spawn_agent', arguments: '{"mes' } }] } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'sage":"go"}' } }] } }], usage: null }
    }
    const frames: string[] = []
    await streamResponsesFromChat(chunks() as never, (f) => frames.push(f), {
      model: 'm', responseId: 'r', toolNamespaces: { spawn_agent: 'multi_agent_v1' },
    })
    const itemFrames = frames.filter((f) => f.includes('"function_call"'))
    expect(itemFrames.length).toBeGreaterThan(0)
    for (const f of itemFrames) expect(f).toContain('"namespace":"multi_agent_v1"')
  })
})
