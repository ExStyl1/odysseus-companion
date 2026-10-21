/**
 * L6 — the beta-gated field the shipped Claude CLI puts on every thinking turn,
 * and the two halves of the fix.
 *
 * MEASURED 2026-08-17 with the real CLI (`claude-agent-sdk` 0.3.218) driving the
 * real adapter into a recording upstream: every `/v1/messages` body carried
 * `context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}`
 * and the CLI declared it in `anthropic-beta:
 * …,context-management-2025-06-27,…`. The passthrough forwarded the FIELD and
 * dropped the HEADER, so an upstream that has not implemented the beta answers
 * `400 … Extra inputs are not permitted` and the turn dies before the model.
 *
 * Half one: the beta header rides with the body it authorizes.
 * Half two: a named field is dropped only AFTER the upstream refuses it by name,
 * then remembered — never stripped speculatively, because an upstream that
 * SUPPORTS the beta would lose it silently.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';
import {
  REMOVABLE_BETA_FIELDS,
  UpstreamFieldRefusals,
  findRefusedRemovableFields,
  withoutBetaFor,
  withoutFields,
} from '../anthropic/passthrough-negotiation.ts';

const WIRED = 'anthropic/claude-fable-5';
const PASSTHROUGH = { kind: 'anthropic-messages', baseUrl: 'https://llm-proxy.test', apiKey: 'sk-wire' } as const;

/** The CLI's real field, verbatim from the 2026-08-17 capture. */
const CONTEXT_MANAGEMENT = { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] };

/** llm-proxy's real refusal, verbatim in shape from the L0 measurement. */
const PYDANTIC_400 = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: "[{'type': 'extra_forbidden', 'loc': ('body', 'context_management'), 'msg': 'Extra inputs are not permitted'}]",
  },
});

function messagesRequest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: WIRED,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    context_management: CONTEXT_MANAGEMENT,
    ...extra,
  };
}

interface Seen { url: string; body: any; headers: Record<string, string> }

/** Records each outbound request and replies with the next canned response. */
function scriptedFetch(seen: Seen[], replies: Array<() => Response>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? 'null')), headers });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)]!;
    return reply();
  }) as unknown as typeof fetch;
}

const okJson = () => new Response(JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'ok' }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const refuse400 = () => new Response(PYDANTIC_400, { status: 400, headers: { 'content-type': 'application/json' } });

async function postMessages(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ============================================================
describe('the beta header rides with the body it authorizes', () => {
  test('anthropic-beta is forwarded verbatim to an anthropic-wire upstream', async () => {
    const seen: Seen[] = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [okJson]),
    });
    try {
      const betas = 'claude-code-20250219,context-management-2025-06-27,effort-2025-11-24';
      await postMessages(adapter.port, messagesRequest(), {
        'anthropic-beta': betas,
        'anthropic-version': '2023-06-01',
      });
      expect(seen).toHaveLength(1);
      // The field and the beta that authorizes it leave together, or neither is
      // a request the client composed.
      expect(seen[0]!.body.context_management).toEqual(CONTEXT_MANAGEMENT);
      expect(seen[0]!.headers['anthropic-beta']).toBe(betas);
      expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
    } finally {
      await adapter.close();
    }
  });

  test('CONTROL — no inbound anthropic-beta means no invented one', async () => {
    const seen: Seen[] = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [okJson]),
    });
    try {
      await postMessages(adapter.port, messagesRequest());
      expect(seen[0]!.headers['anthropic-beta']).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});

// ============================================================
describe('a refused field is dropped once, then remembered', () => {
  test('a 400 naming context_management is retried without it, and the turn succeeds', async () => {
    const seen: Seen[] = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [refuse400, okJson]),
    });
    try {
      const res = await postMessages(adapter.port, messagesRequest());
      expect(seen).toHaveLength(2);
      // Attempt 1 is verbatim; attempt 2 differs by exactly the refused field.
      expect(seen[0]!.body.context_management).toEqual(CONTEXT_MANAGEMENT);
      expect(seen[1]!.body).not.toHaveProperty('context_management');
      expect(seen[1]!.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(seen[1]!.body.max_tokens).toBe(1024);
      // The client sees the successful turn, not the 400.
      expect(res.status).toBe(200);
      expect((await res.json() as any).content[0].text).toBe('ok');
    } finally {
      await adapter.close();
    }
  });

  test('the retry drops the field AND the beta that authorized it, keeping every other beta', async () => {
    // The mirror image of the defect this row fixed on the way in. We used to
    // forward the field with its beta deleted; a retry that dropped the field
    // while still declaring `context-management-2025-06-27` would be the same
    // incoherence pointing the other way — and an upstream that validates its
    // beta list would then reject the retry for a brand-new reason, which the
    // negotiation cannot recover from (it matches field names, not beta tokens).
    const seen: Seen[] = [];
    const betas = 'claude-code-20250219,context-management-2025-06-27,effort-2025-11-24';
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [refuse400, okJson]),
    });
    try {
      const res = await postMessages(adapter.port, messagesRequest(), { 'anthropic-beta': betas });
      expect(seen).toHaveLength(2);
      // Attempt 1: the client's own header, untouched.
      expect(seen[0]!.headers['anthropic-beta']).toBe(betas);
      // Attempt 2: one token fewer, and only that one.
      expect(seen[1]!.headers['anthropic-beta']).toBe('claude-code-20250219,effort-2025-11-24');
      expect(seen[1]!.body).not.toHaveProperty('context_management');
      expect(res.status).toBe(200);
    } finally {
      await adapter.close();
    }
  });

  test('a remembered refusal drops the beta on the FIRST request of the next turn', async () => {
    // The memo covers the body; without the same treatment of the header, turn
    // two would go out declaring a beta for a field it no longer carries.
    const seen: Seen[] = [];
    const betas = 'claude-code-20250219,context-management-2025-06-27';
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [refuse400, okJson]),
    });
    try {
      await postMessages(adapter.port, messagesRequest(), { 'anthropic-beta': betas });
      await postMessages(adapter.port, messagesRequest(), { 'anthropic-beta': betas });
      expect(seen).toHaveLength(3);
      expect(seen[2]!.headers['anthropic-beta']).toBe('claude-code-20250219');
      expect(seen[2]!.body).not.toHaveProperty('context_management');
    } finally {
      await adapter.close();
    }
  });

  test('the rewrite is observable — a silent one cannot be debugged', async () => {
    const seen: Seen[] = [];
    const negotiations: Array<{ upstream: string; dropped: readonly string[] }> = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [refuse400, okJson]),
      onFieldNegotiation: info => { negotiations.push(info); },
    });
    try {
      await postMessages(adapter.port, messagesRequest());
      expect(negotiations).toEqual([{ upstream: PASSTHROUGH.baseUrl, dropped: ['context_management'] }]);
    } finally {
      await adapter.close();
    }
  });

  test('the refusal is remembered: the SECOND turn omits the field up front', async () => {
    const seen: Seen[] = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [refuse400, okJson]),
    });
    try {
      await postMessages(adapter.port, messagesRequest());
      expect(seen).toHaveLength(2);
      const res = await postMessages(adapter.port, messagesRequest());
      // One request, not two: no second wasted round trip.
      expect(seen).toHaveLength(3);
      expect(seen[2]!.body).not.toHaveProperty('context_management');
      expect(res.status).toBe(200);
    } finally {
      await adapter.close();
    }
  });

  test('CONTROL — an upstream that ACCEPTS the field never loses it', async () => {
    const seen: Seen[] = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [okJson]),
    });
    try {
      await postMessages(adapter.port, messagesRequest());
      await postMessages(adapter.port, messagesRequest());
      expect(seen).toHaveLength(2);
      // Nothing is stripped speculatively — this is the whole reason the removal
      // is reactive rather than a blanket one.
      expect(seen[0]!.body.context_management).toEqual(CONTEXT_MANAGEMENT);
      expect(seen[1]!.body.context_management).toEqual(CONTEXT_MANAGEMENT);
    } finally {
      await adapter.close();
    }
  });

  test('CONTROL — a 400 that names NOTHING removable is passed back verbatim, with no retry', async () => {
    const seen: Seen[] = [];
    const generic = () => new Response('{"type":"error","error":{"message":"messages: at least one message is required"}}', {
      status: 400, headers: { 'content-type': 'application/json' },
    });
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [generic]),
    });
    try {
      const res = await postMessages(adapter.port, messagesRequest());
      expect(seen).toHaveLength(1);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('at least one message is required');
    } finally {
      await adapter.close();
    }
  });

  test('CONTROL — a 400 naming a field that is NOT on the removable list changes nothing', async () => {
    const seen: Seen[] = [];
    const namesMessages = () => new Response(
      JSON.stringify({ error: { message: "loc: ('body', 'messages'), msg: 'Extra inputs are not permitted'" } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [namesMessages]),
    });
    try {
      const res = await postMessages(adapter.port, messagesRequest());
      // `messages` is not, and must never be, a candidate for removal.
      expect(seen).toHaveLength(1);
      expect(res.status).toBe(400);
    } finally {
      await adapter.close();
    }
  });

  test('CONTROL — the retry happens at most ONCE; a second 400 is the answer', async () => {
    const seen: Seen[] = [];
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => PASSTHROUGH,
      fetchImpl: scriptedFetch(seen, [refuse400, refuse400]),
    });
    try {
      const res = await postMessages(adapter.port, messagesRequest());
      expect(seen).toHaveLength(2);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Extra inputs are not permitted');
    } finally {
      await adapter.close();
    }
  });

  test('CONTROL — the TRANSLATING route is untouched by any of this', async () => {
    const seen: Seen[] = [];
    const chatOk = () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const adapter = await startAdapter({
      upstream: { kind: 'openai-compatible', baseUrl: 'https://llm-proxy.test' },
      upstreamForModel: () => undefined,
      fetchImpl: scriptedFetch(seen, [chatOk]),
    });
    try {
      await postMessages(adapter.port, messagesRequest({ model: 'tgpt/qwen35-397b-a17b-fp8' }), {
        'anthropic-beta': 'context-management-2025-06-27',
      });
      expect(seen[0]!.url).toBe('https://llm-proxy.test/chat/completions');
      // The gateway/translation route rebuilds the body from known fields, so it
      // could never carry `context_management` and never sees the beta header.
      expect(seen[0]!.body).not.toHaveProperty('context_management');
      expect(seen[0]!.headers['anthropic-beta']).toBeUndefined();
    } finally {
      await adapter.close();
    }
  });
});

// ============================================================
describe('the negotiation primitives', () => {
  test('a field is refused only when it is BOTH present and named', () => {
    const body = { model: 'm', context_management: CONTEXT_MANAGEMENT };
    expect(findRefusedRemovableFields(body, 'context_management')).toEqual(['context_management']);
    expect(findRefusedRemovableFields({ model: 'm' }, 'context_management')).toEqual([]);
    expect(findRefusedRemovableFields(body, 'something else entirely')).toEqual([]);
    expect(findRefusedRemovableFields(body, '')).toEqual([]);
    expect(findRefusedRemovableFields(null, 'context_management')).toEqual([]);
  });

  test('the removable list stays short, and every entry names the beta that gates it', () => {
    // A guard, not decoration: widening this list is how a blanket strip gets in
    // by the back door. `messages`/`system`/`tools`/`model` must never appear.
    //
    // The value half is the guard that matters as much as the key half — an
    // entry with no beta token would be a field we strip while still declaring
    // whatever authorized it, which is the mirror image of the defect this row
    // fixed on the way in.
    expect(REMOVABLE_BETA_FIELDS).toEqual({ context_management: 'context-management-2025-06-27' });
  });

  test('a dropped field takes its beta with it, and leaves every other token alone', () => {
    const header = 'claude-code-20250219,context-management-2025-06-27,effort-2025-11-24';
    expect(withoutBetaFor(header, ['context_management']))
      .toBe('claude-code-20250219,effort-2025-11-24');
    // Nothing dropped, nothing touched — the client's own header, verbatim.
    expect(withoutBetaFor(header, [])).toBe(header);
    expect(withoutBetaFor(undefined, ['context_management'])).toBeUndefined();
    // A header that was ONLY that beta becomes no header at all rather than an
    // empty one, which some upstreams reject as malformed.
    expect(withoutBetaFor('context-management-2025-06-27', ['context_management'])).toBeUndefined();
    expect(withoutBetaFor(' a , context-management-2025-06-27 , b ', ['context_management'])).toBe('a,b');
  });

  test('a 400 that merely ECHOES the request does not count as naming the field', () => {
    // Caught by probe, not by reasoning: an upstream complaining about a
    // DIFFERENT field while echoing the body it rejected contains our field name
    // too. The naive substring match dropped `context_management` and memoized
    // the refusal for the whole session, silently costing the user context
    // editing against an endpoint that never objected to it.
    const body = { model: 'm', max_tokens: 0, context_management: CONTEXT_MANAGEMENT };
    const echoed = JSON.stringify({
      detail: [{
        type: 'greater_than', loc: ['body', 'max_tokens'], msg: 'Input should be greater than 0',
        input: body,
      }],
    });
    expect(findRefusedRemovableFields(body, echoed)).toEqual([]);

    // The real refusal, in llm-proxy's own pydantic shape, still matches.
    const refusal = JSON.stringify({
      detail: [{
        type: 'extra_forbidden', loc: ['body', 'context_management'],
        msg: 'Extra inputs are not permitted', input: CONTEXT_MANAGEMENT,
      }],
    });
    expect(findRefusedRemovableFields(body, refusal)).toEqual(['context_management']);

    // Anthropic's own error shape, and a plain-text 400 with no structure to be
    // precise about — the fallback that keeps the common case working.
    expect(findRefusedRemovableFields(body, JSON.stringify({
      type: 'error', error: { type: 'invalid_request_error', message: 'context_management: extra fields not permitted' },
    }))).toEqual(['context_management']);
    expect(findRefusedRemovableFields(body, 'context_management is not supported')).toEqual(['context_management']);
  });

  test('withoutFields copies rather than mutates, and leaves non-objects alone', () => {
    const body = { a: 1, context_management: CONTEXT_MANAGEMENT };
    const next = withoutFields(body, ['context_management']) as Record<string, unknown>;
    expect(next).toEqual({ a: 1 });
    expect(body).toHaveProperty('context_management');
    expect(withoutFields(body, [])).toBe(body);
    expect(withoutFields('not an object', ['context_management'])).toBe('not an object');
  });

  test('refusals are per upstream URL', () => {
    const refusals = new UpstreamFieldRefusals();
    refusals.remember('https://a.test', ['context_management']);
    expect(refusals.known('https://a.test')).toEqual(['context_management']);
    expect(refusals.known('https://b.test')).toEqual([]);
    refusals.remember('https://a.test', []);
    expect(refusals.known('https://a.test')).toEqual(['context_management']);
  });
});
