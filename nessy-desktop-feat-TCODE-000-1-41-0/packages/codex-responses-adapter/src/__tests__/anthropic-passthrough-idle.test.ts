/**
 * C4.10 (owner answer QF3 = B, 2026-09-11) — the Anthropic PASSTHROUGH relay
 * under the host's idle abort.
 *
 * WHAT THIS FILE PROVES AND WHAT IT DOES NOT. The deadline itself lives in
 * `packages/shared/src/llm/stream-idle.ts` symbol `readWithIdleTimeout` and is
 * pinned there; this package is the dependency LEAF of the pair and cannot
 * import it, which is why {@link AdapterOptions.readWithIdleTimeout} is an
 * INJECTION. So the guard below is a deterministic stand-in — it trips without a
 * timer — and what is proven here is the seam: that an injected guard is
 * actually driven, that its trip becomes an Anthropic `error` frame, that an
 * upstream which broke on its own still gets no invented frame, and that an
 * adapter started WITHOUT the option relays exactly as it did before.
 *
 * The host half — that `claude-agent.ts` binds the real primitive to this option
 * — is pinned in `packages/shared/src/agent/__tests__/claude-gateway-adapter.test.ts`,
 * where the start options are recorded.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter, type RelayByteStreamReader } from '../server.ts';

const PASSTHROUGH = { kind: 'anthropic-messages', baseUrl: 'https://llm-proxy.test', apiKey: 'sk-wire' } as const;
const WIRED = 'anthropic/claude-opus-5';
const FIRST_FRAME = 'event: message_start\ndata: {"type":"message_start"}\n\n';

/** An upstream that speaks one frame and then never says anything again. */
function silentAfterFirstFrame(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(FIRST_FRAME));
      // Deliberately never closed: this is the shape `read()` never settles on.
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubUpstream(reply: () => Response): typeof fetch {
  return (async () => reply()) as unknown as typeof fetch;
}

/**
 * The host's guard, modelled without a clock: relay whatever is already
 * available, cancel the reader, then fail with the error the real primitive
 * throws. `name` is the whole contract the adapter reads — it cannot see the
 * class.
 */
function guardTrippingWith(name: string): (reader: RelayByteStreamReader) => AsyncIterable<Uint8Array> {
  return (reader) => (async function* () {
    const first = await reader.read();
    if (first.value) yield first.value;
    await reader.cancel('idle').catch(() => {});
    const error = new Error('stream idle: no bytes for 300000ms');
    error.name = name;
    throw error;
  })();
}

async function postWired(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: WIRED, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('C4.10 /v1/messages passthrough — the host idle abort', () => {
  test('a tripped guard ends the relay with an Anthropic error event', async () => {
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: stubUpstream(silentAfterFirstFrame),
      readWithIdleTimeout: guardTrippingWith('StreamIdleTimeoutError'),
    });
    try {
      const res = await postWired(adapter.port);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      // The bytes the upstream did send are still the client's, verbatim.
      expect(text.startsWith(FIRST_FRAME)).toBe(true);
      // And the silence is NAMED rather than left as a truncated stream. 504 is
      // the documented Anthropic taxonomy row for a timeout.
      expect(text).toContain('event: error');
      expect(JSON.parse(text.slice(text.indexOf('event: error')).split('data: ')[1]!.trim())).toEqual({
        type: 'error',
        error: { type: 'timeout_error', message: 'stream idle: no bytes for 300000ms' },
      });
    } finally {
      await adapter.close();
    }
  });

  test('an upstream that broke on its own still gets NO invented frame', async () => {
    // The discriminator for the test above: the relay does not dress every
    // failure as a terminal event — only the one WE caused. A truncated stream
    // is the honest report of an upstream that died mid-answer.
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: stubUpstream(silentAfterFirstFrame),
      readWithIdleTimeout: guardTrippingWith('TypeError'),
    });
    try {
      const text = await (await postWired(adapter.port)).text();
      expect(text).toBe(FIRST_FRAME);
      expect(text).not.toContain('event: error');
    } finally {
      await adapter.close();
    }
  });

  test('with no guard injected the relay is the pre-C4.10 one, byte for byte', async () => {
    // The control that the option is OPT-IN: an embedder that is not our host
    // sees exactly the stream it saw before, and nothing new is written into it.
    const sse = FIRST_FRAME + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: stubUpstream(() => new Response(sse, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      })),
    });
    try {
      expect(await (await postWired(adapter.port)).text()).toBe(sse);
    } finally {
      await adapter.close();
    }
  });
});
