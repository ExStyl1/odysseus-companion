/**
 * Task T2 — the adapter's outbound target is a parameter, and each mode's auth
 * is scoped to that mode.
 *
 * GOVERNANCE (AGENTS.md "Gateway Facts"): `Nestor-Token` is Nestor-only. Any
 * other upstream gets standard `Authorization: Bearer` semantics and must never
 * see the gateway token, nor cause `~/.nessy/dp_auth_creds.json` to gate the
 * request. These are security assertions — do not relax them.
 *
 * The default (`upstream` omitted) must stay byte-equivalent to the codex path,
 * which constructs the adapter as `startAdapter({})`.
 */
import { test, expect, describe } from 'bun:test';
import { postChat, NESTOR_CHAT_URL, type UpstreamTarget } from '../nestor-client.ts';
import { sendWithRetry } from '../retry.ts';
import { toChatRequest } from '../to-chat.ts';
import { startAdapter } from '../server.ts';

interface Captured {
  url: string;
  headers: Record<string, string>;
}

/** Case-insensitive header lookup over the plain object the client sends. */
function header(c: Captured, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(c.headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}

function capturingFetch(calls: Captured[], respond: () => Response = () => new Response('{}', { status: 200 })): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return respond();
  }) as unknown as typeof fetch;
}

const OPENAI_TARGET: UpstreamTarget = { kind: 'openai-compatible', baseUrl: 'https://byo.example.test/v1', apiKey: 'sk-test-123' };

// ---- (a) + (d): nestor mode, explicit and by default ----
describe('T2 upstream target — nestor mode', () => {
  test('explicit { kind: "nestor" } posts to NESTOR_CHAT_URL with Nestor-Token and NO Authorization', async () => {
    const calls: Captured[] = [];
    await postChat({ model: 'm', messages: [] }, { jwt: 'JWT123', upstream: { kind: 'nestor' }, fetchImpl: capturingFetch(calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(NESTOR_CHAT_URL);
    expect(header(calls[0]!, 'Nestor-Token')).toBe('JWT123');
    expect(header(calls[0]!, 'Authorization')).toBeUndefined();
  });

  test('omitted upstream is byte-identical to explicit nestor', async () => {
    const withDefault: Captured[] = [];
    const withExplicit: Captured[] = [];
    await postChat({ model: 'm', messages: [] }, { jwt: 'JWT123', fetchImpl: capturingFetch(withDefault) });
    await postChat({ model: 'm', messages: [] }, { jwt: 'JWT123', upstream: { kind: 'nestor' }, fetchImpl: capturingFetch(withExplicit) });
    expect(withDefault[0]).toEqual(withExplicit[0]!);
  });
});

// ---- (b) + (c): openai-compatible mode ----
describe('T2 upstream target — openai-compatible mode', () => {
  test('posts to `${baseUrl}/chat/completions` with Authorization: Bearer and NEVER Nestor-Token', async () => {
    const calls: Captured[] = [];
    await postChat({ model: 'm', messages: [] }, { jwt: 'JWT123', upstream: OPENAI_TARGET, fetchImpl: capturingFetch(calls) });
    expect(calls[0]!.url).toBe('https://byo.example.test/v1/chat/completions');
    expect(header(calls[0]!, 'Authorization')).toBe('Bearer sk-test-123');
    expect(header(calls[0]!, 'Nestor-Token')).toBeUndefined();
  });

  test('a jwt in scope is never leaked to a non-nestor upstream', async () => {
    const calls: Captured[] = [];
    await postChat({ model: 'm', messages: [] }, { jwt: 'SECRET-GATEWAY-JWT', upstream: OPENAI_TARGET, fetchImpl: capturingFetch(calls) });
    expect(JSON.stringify(calls[0]!.headers)).not.toContain('SECRET-GATEWAY-JWT');
  });

  test('a trailing slash on baseUrl does not double up the path separator', async () => {
    const calls: Captured[] = [];
    await postChat({ model: 'm', messages: [] }, { upstream: { kind: 'openai-compatible', baseUrl: 'https://byo.example.test/v1/', apiKey: 'k' }, fetchImpl: capturingFetch(calls) });
    expect(calls[0]!.url).toBe('https://byo.example.test/v1/chat/completions');
  });

  test('absent apiKey → no auth header of any kind', async () => {
    const calls: Captured[] = [];
    await postChat({ model: 'm', messages: [] }, { upstream: { kind: 'openai-compatible', baseUrl: 'https://byo.example.test/v1' }, fetchImpl: capturingFetch(calls) });
    expect(header(calls[0]!, 'Authorization')).toBeUndefined();
    expect(header(calls[0]!, 'Nestor-Token')).toBeUndefined();
    expect(Object.keys(calls[0]!.headers).map((k) => k.toLowerCase())).toEqual(['content-type']);
  });
});

// ---- the target survives the retry ladder ----
describe('T2 upstream target — retry ladder', () => {
  test('every rung targets the configured upstream, not the gateway', async () => {
    const calls: Captured[] = [];
    let n = 0;
    const fetchImpl = capturingFetch(calls, () => {
      n += 1;
      return n <= 2 ? new Response(JSON.stringify({ error: { message: 'model is required' } }), { status: 400 }) : new Response('{}', { status: 200 });
    });
    const chat = toChatRequest({ model: 'm', input: [], tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {}, required: [] } }] });
    const { rung } = await sendWithRetry(chat, { upstream: OPENAI_TARGET, fetchImpl });
    expect(rung).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === 'https://byo.example.test/v1/chat/completions')).toBe(true);
    expect(calls.every((c) => header(c, 'Nestor-Token') === undefined)).toBe(true);
  });
});

// ---- the dp-creds gate is nestor-only ----
describe('T2 upstream target — credential gate scoping', () => {
  test('POSITIVE CONTROL: nestor mode with no credentials still 401s (unchanged)', async () => {
    const adapter = await startAdapter({ jwt: null });
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('no_credentials');
    await adapter.close();
  });

  test('openai-compatible mode with no gateway credentials does NOT 401 and reaches its own upstream', async () => {
    const calls: Captured[] = [];
    const fetchImpl = capturingFetch(calls, () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const adapter = await startAdapter({ jwt: null, upstream: OPENAI_TARGET, fetchImpl });
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: [], stream: false }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://byo.example.test/v1/chat/completions');
    expect(header(calls[0]!, 'Authorization')).toBe('Bearer sk-test-123');
    expect(header(calls[0]!, 'Nestor-Token')).toBeUndefined();
    await adapter.close();
  });

  test('the default adapter (no upstream option) still sends Nestor-Token to the gateway', async () => {
    const calls: Captured[] = [];
    const fetchImpl = capturingFetch(calls, () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const adapter = await startAdapter({ jwt: 'JWT123', fetchImpl });
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: [], stream: false }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(NESTOR_CHAT_URL);
    expect(header(calls[0]!, 'Nestor-Token')).toBe('JWT123');
    expect(header(calls[0]!, 'Authorization')).toBeUndefined();
    await adapter.close();
  });
});

/**
 * G3 — the third member: an upstream that speaks Anthropic Messages natively.
 *
 * The security scoping above extends unchanged: this mode carries a bearer and
 * must never see the gateway token. What is NEW is that it takes a different
 * BODY, which is why `postChat` refuses it rather than posting a chat request
 * to `/v1/messages` and letting the endpoint produce a confusing 400.
 */
describe('anthropic-messages upstream (G3)', () => {
  const TARGET = { kind: 'anthropic-messages', baseUrl: 'https://llm-proxy.test/', apiKey: 'sk-anthropic-wire' } as const;

  test('posts to /v1/messages with a bearer, and no gateway token', async () => {
    const calls: Captured[] = [];
    const { postAnthropicMessages } = await import('../nestor-client.ts');
    await postAnthropicMessages({ model: 'anthropic/claude-opus-5' }, {
      upstream: TARGET,
      fetchImpl: capturingFetch(calls),
    });
    expect(calls).toHaveLength(1);
    // The trailing slash on the base must not double up.
    expect(calls[0]!.url).toBe('https://llm-proxy.test/v1/messages');
    expect(header(calls[0]!, 'authorization')).toBe('Bearer sk-anthropic-wire');
    expect(header(calls[0]!, 'nestor-token')).toBeUndefined();
  });

  test('forwards anthropic-version rather than inventing one', async () => {
    const calls: Captured[] = [];
    const { postAnthropicMessages } = await import('../nestor-client.ts');
    await postAnthropicMessages({}, { upstream: TARGET, anthropicVersion: '2023-06-01', fetchImpl: capturingFetch(calls) });
    expect(header(calls[0]!, 'anthropic-version')).toBe('2023-06-01');
    // Absent when the inbound request carried none: the SDK negotiates it, and
    // picking a value here would silently pin the protocol.
    const bare: Captured[] = [];
    await postAnthropicMessages({}, { upstream: TARGET, fetchImpl: capturingFetch(bare) });
    expect(header(bare[0]!, 'anthropic-version')).toBeUndefined();
  });

  test('postChat REFUSES this target instead of sending a chat body to it', () => {
    expect(() => postChat({ model: 'x' }, { upstream: TARGET, fetchImpl: capturingFetch([]) }))
      .toThrow(/anthropic-messages upstream/);
    // Positive control: the other two targets still work through postChat.
    expect(() => postChat({ model: 'x' }, { upstream: OPENAI_TARGET, fetchImpl: capturingFetch([]) })).not.toThrow();
  });
});

/**
 * The Codex adapter's own auth instrument (walk C / CODEX-TURN assertion 2).
 *
 * Symmetric with the Pi reasoning proxy's line and built the same way: the
 * SCHEME is the whole vocabulary, so a log can never carry a credential.
 */
describe('upstream auth scheme logging', () => {
  function capture(fn: () => void): string[] {
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true }) as typeof process.stderr.write;
    try { fn() } finally { process.stderr.write = real }
    return written;
  }

  test('names bearer for a BYO upstream and nestor-token for the gateway', () => {
    process.env.NESSY_PROXY_AUTH_DEBUG = '1';
    try {
      const written = capture(() => {
        postChat({ model: 'x' }, { upstream: OPENAI_TARGET, fetchImpl: capturingFetch([]) });
        postChat({ model: 'x' }, { upstream: { kind: 'nestor' }, jwt: 'JWT-SECRET-VALUE', fetchImpl: capturingFetch([]) });
      });
      const lines = written.filter(l => l.includes('[codex-adapter] upstream auth:'));
      expect(lines.some(l => l.includes('bearer'))).toBe(true);
      expect(lines.some(l => l.includes('nestor-token'))).toBe(true);
      // THE assertion that makes this safe to ship: neither credential appears.
      expect(written.join('')).not.toContain('sk-test-123');
      expect(written.join('')).not.toContain('JWT-SECRET-VALUE');
    } finally {
      delete process.env.NESSY_PROXY_AUTH_DEBUG;
    }
  });

  test('stays silent without the flag', () => {
    delete process.env.NESSY_PROXY_AUTH_DEBUG;
    const written = capture(() => {
      postChat({ model: 'x' }, { upstream: OPENAI_TARGET, fetchImpl: capturingFetch([]) });
    });
    expect(written.filter(l => l.includes('upstream auth:'))).toEqual([]);
  });
});


/**
 * The sink, because stderr was the wrong one for this adapter.
 *
 * The Pi proxy writes to a SUBPROCESS's stderr and the host captures it; this
 * adapter runs in-process, so the same line reached no reader — `CODEX-TURN`
 * saw zero lines with the flag on. The caller now supplies the sink.
 */
describe('the auth-scheme sink', () => {
  const TARGET = { kind: 'openai-compatible', baseUrl: 'https://byo.example.test/v1', apiKey: 'sk-test-123' } as const;

  test('reports the scheme to the caller, with no flag and no stderr', () => {
    const seen: string[] = [];
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true }) as typeof process.stderr.write;
    delete process.env.NESSY_PROXY_AUTH_DEBUG;
    try {
      postChat({ model: 'x' }, { upstream: TARGET, fetchImpl: capturingFetch([]), onUpstreamAuth: (s) => seen.push(s) });
      postChat({ model: 'x' }, { upstream: { kind: 'nestor' }, jwt: 'JWT-SECRET', fetchImpl: capturingFetch([]), onUpstreamAuth: (s) => seen.push(s) });
    } finally {
      process.stderr.write = realWrite;
    }
    expect(seen).toEqual(['bearer', 'nestor-token']);
    // The sink REPLACES stderr — one line per request, not two.
    expect(written.filter(l => l.includes('upstream auth:'))).toEqual([]);
    // And the vocabulary is still three words, so no credential can ride it.
    expect(seen.join('')).not.toContain('sk-test-123');
    expect(seen.join('')).not.toContain('JWT-SECRET');
  });
});
