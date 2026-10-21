/**
 * P3.98 + P3.122 — the PRODUCER half: the adapter hands every completed
 * non-streaming `/v1/messages` call up, so the host can tell a turn the user
 * asked for apart from model spend the host caused.
 *
 * The adapter deliberately classifies NOTHING. This package is the dependency
 * root of the pair (`@nessy-agent/shared` depends on it, never the reverse), so
 * the classifier's recognition marker stays in shared and the raw `system`
 * field travels up by reference. These tests therefore assert the OBSERVATION —
 * that the inbound system field and the upstream's own token counts arrive
 * together and unaltered — and never that a request "is the classifier".
 *
 * The streaming arm is here as a boundary rather than as an aspiration: the
 * classifier's hops were captured off the binary as non-streaming JSON replies
 * (`claude-auto-mode-classifier-gateway-e2e.test.ts` reads `usage.input_tokens`
 * / `usage.output_tokens` straight off them). A streaming host-overhead source
 * would need the counts pulled out of the SSE tail; there is no such source
 * today and this test is what says so out loud.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter, type UpstreamCallObservation } from '../server.ts';

const MODEL = 'claude-sonnet-4-5-20250929';

function jsonUpstream(usage: Record<string, number>): typeof fetch {
  return (async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage,
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

function sseUpstream(): typeof fetch {
  const body = 'data: ' + JSON.stringify({
    choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
  }) + '\n\ndata: [DONE]\n\n';
  return (async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })) as unknown as typeof fetch;
}

async function postMessages(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('P3.98 — onUpstreamCall', () => {
  test('reports the inbound system field and the upstream counts on a non-streaming call', async () => {
    const seen: UpstreamCallObservation[] = [];
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: jsonUpstream({ prompt_tokens: 24_231, completion_tokens: 335, total_tokens: 24_566 }),
      onUpstreamCall: call => { seen.push(call); },
    });
    try {
      const res = await postMessages(adapter.port, {
        model: MODEL,
        max_tokens: 64,
        // The shape the classifier sends: a block array, not a bare string.
        system: [{ type: 'text', text: 'You are a security monitor for autonomous AI coding agents' }],
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expect(seen.length).toBe(1);
      // Verbatim, so the host's own classifier reads what the runtime sent
      // rather than something this layer reshaped.
      expect(seen[0]!.system).toEqual([
        { type: 'text', text: 'You are a security monitor for autonomous AI coding agents' },
      ]);
      // The same counts the client is told, from the same `mapUsage`.
      expect(seen[0]!.inputTokens).toBe(24_231);
      expect(seen[0]!.outputTokens).toBe(335);
      expect(seen[0]!.model).toBe(MODEL);
    } finally {
      await adapter.close();
    }
  });

  test('THE CONTROL — an ordinary request reports too, with its system field intact', async () => {
    // Without this the assertion above cannot tell "the call is observed" from
    // "a classifier call is observed", and the adapter must NOT be the thing
    // that decides which is which — that is the whole point of the split.
    const seen: UpstreamCallObservation[] = [];
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: jsonUpstream({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
      onUpstreamCall: call => { seen.push(call); },
    });
    try {
      await postMessages(adapter.port, {
        model: MODEL,
        max_tokens: 64,
        system: 'You are Nessy, a helpful coding assistant.',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(seen.length).toBe(1);
      expect(seen[0]!.system).toBe('You are Nessy, a helpful coding assistant.');
      expect(seen[0]!.inputTokens).toBe(3);
    } finally {
      await adapter.close();
    }
  });

  test('a throwing sink cannot fail the request', async () => {
    // Telemetry on a request path must never be able to break the turn. This is
    // the arm that keeps the try/catch from being deleted as decoration.
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: jsonUpstream({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      onUpstreamCall: () => { throw new Error('sink exploded'); },
    });
    try {
      const res = await postMessages(adapter.port, {
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { type?: string }).type).toBe('message');
    } finally {
      await adapter.close();
    }
  });

  test('THE BOUNDARY — a streaming call is not observed, and that is recorded rather than assumed', async () => {
    const seen: UpstreamCallObservation[] = [];
    const adapter = await startAdapter({
      jwt: 'j',
      fetchImpl: sseUpstream(),
      onUpstreamCall: call => { seen.push(call); },
    });
    try {
      const res = await postMessages(adapter.port, {
        model: MODEL,
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });
      await res.text();
      expect(seen).toEqual([]);
    } finally {
      await adapter.close();
    }
  });
});
