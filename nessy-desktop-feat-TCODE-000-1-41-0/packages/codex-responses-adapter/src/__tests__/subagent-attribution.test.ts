/**
 * P6.462 — the claude child's subagent attribution reaches the upstream call.
 *
 * ## The measurement these cases stand on
 *
 * The row's own instruction was MEASURE FIRST — "a string in a binary is not a
 * wire". Run 2026-09-06 against the vendored native binary
 * (`claude-cli/2.1.233`, agent-sdk 0.3.260) pointed at a recording
 * Anthropic-Messages server, with one main turn that spawned a subagent which
 * itself spawned a second:
 *
 * | request | `x-claude-code-*` headers carried |
 * | --- | --- |
 * | main thread, all three turns | `session-id` only |
 * | subagent A | `session-id`, `agent-id=a06ff1cf7fdb0d6fc` |
 * | subagent B, spawned by A | `session-id`, `agent-id=ad2740e22b9a4829a`, `parent-agent-id=a06ff1cf7fdb0d6fc` |
 *
 * The fixtures below use those exact ids. Two things they pin that a guessed
 * fixture would have got wrong: `parent-agent-id` appears only on a NESTED
 * spawn, and neither appears on a main-thread turn.
 *
 * ## What is asserted HERE and what is asserted next door
 *
 * This file proves the adapter CARRIES the ids onto the upstream request, on
 * both arms of `/v1/messages`. It deliberately does not assert the Nessy
 * spelling or the audience: this package is the dependency root of the pair and
 * cannot import `@nessy-agent/shared`, so the rename-on-gateway /
 * delete-everywhere-else rule lives in `gatewaySessionFetch` and is pinned by
 * `shared/src/telemetry/gateway-headers.host.test.ts`. One audience rule, one
 * place, one suite.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';

/** Measured off the shipped binary — see the file docblock. */
const AGENT_ID = 'ad2740e22b9a4829a';
const PARENT_AGENT_ID = 'a06ff1cf7fdb0d6fc';

const MODEL = 'claude-sonnet-4-5-20250929';

/** Records the headers of every upstream call and answers with a minimal turn. */
function capturingUpstream(calls: Array<Record<string, string>>, response: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push(Object.fromEntries(headers.entries()));
    return response();
  }) as unknown as typeof fetch;
}

const chatTurn = (): Response => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`
  + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
  + 'data: [DONE]\n\n',
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);

/** An Anthropic-shaped answer, for the PASSTHROUGH arm (no translation either way). */
const anthropicTurn = (): Response => new Response(
  JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

function body(stream: boolean): Record<string, unknown> {
  return { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }], stream };
}

async function post(port: number, headers: Record<string, string>, stream = true): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body(stream)),
  });
}

describe('P6.462 · the translated arm — the gateway wire the claude runtime actually uses', () => {
  test('a nested subagent turn carries both ids to the upstream call', async () => {
    const calls: Array<Record<string, string>> = [];
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: capturingUpstream(calls, chatTurn) });
    try {
      const res = await post(adapter.port, {
        'x-claude-code-agent-id': AGENT_ID,
        'x-claude-code-parent-agent-id': PARENT_AGENT_ID,
      });
      await res.text();
    } finally {
      await adapter.close();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!['x-claude-code-agent-id']).toBe(AGENT_ID);
    expect(calls[0]!['x-claude-code-parent-agent-id']).toBe(PARENT_AGENT_ID);
    // The adapter's own credential decision is untouched by the wrapper.
    expect(calls[0]!['nestor-token']).toBe('j');
  });

  test('a top-level subagent carries the agent id and no parent, as the binary sends it', async () => {
    const calls: Array<Record<string, string>> = [];
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: capturingUpstream(calls, chatTurn) });
    try {
      await (await post(adapter.port, { 'x-claude-code-agent-id': PARENT_AGENT_ID })).text();
    } finally {
      await adapter.close();
    }

    expect(calls[0]!['x-claude-code-agent-id']).toBe(PARENT_AGENT_ID);
    expect(calls[0]!['x-claude-code-parent-agent-id']).toBeUndefined();
  });

  /**
   * CONTROL. Without it every case above is satisfied by an adapter that invents
   * an attribution for every request, which would make the gateway's per-agent
   * view a fiction rather than a measurement.
   */
  test('CONTROL: a main-thread turn sends neither, and the fetchImpl is not even wrapped', async () => {
    const calls: Array<Record<string, string>> = [];
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: capturingUpstream(calls, chatTurn) });
    try {
      await (await post(adapter.port, {})).text();
    } finally {
      await adapter.close();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!['x-claude-code-agent-id']).toBeUndefined();
    expect(calls[0]!['x-claude-code-parent-agent-id']).toBeUndefined();
  });

  test('a blank header value is not an attribution', async () => {
    const calls: Array<Record<string, string>> = [];
    const adapter = await startAdapter({ jwt: 'j', fetchImpl: capturingUpstream(calls, chatTurn) });
    try {
      await (await post(adapter.port, { 'x-claude-code-agent-id': '   ' })).text();
    } finally {
      await adapter.close();
    }

    expect(calls[0]!['x-claude-code-agent-id']).toBeUndefined();
  });
});

describe('P6.462 · the passthrough arm', () => {
  test('an anthropic-messages upstream receives the ids too', async () => {
    const calls: Array<Record<string, string>> = [];
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: capturingUpstream(calls, anthropicTurn),
      upstreamForModel: () => ({ kind: 'anthropic-messages', baseUrl: 'https://llm.example.com', apiKey: 'k' }),
    });
    try {
      await (await post(adapter.port, {
        'x-claude-code-agent-id': AGENT_ID,
        'x-claude-code-parent-agent-id': PARENT_AGENT_ID,
      }, false)).text();
    } finally {
      await adapter.close();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!['x-claude-code-agent-id']).toBe(AGENT_ID);
    expect(calls[0]!['x-claude-code-parent-agent-id']).toBe(PARENT_AGENT_ID);
  });
});
