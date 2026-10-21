/**
 * P6.43 — the host-side half of the gateway header layer.
 *
 * A claude-runtime turn does not make its own gateway request: the SDK child
 * talks Anthropic Messages to a per-session loopback adapter and the HOST makes
 * the upstream call. The host serves many sessions from one process, so the
 * session id has to be an argument. These rows pin the audience (the verified
 * gateway prefix and nothing else) and the precedence.
 *
 * No real credential appears here: every value is a fixture string.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NESSY_SESSION_ID_HEADER,
  customHeaderNames,
  gatewayHeaderDecisionLine,
  customHeadersOffGatewayNotice,
  gatewayRequestHeaders,
  gatewaySessionFetch,
  operatorHeadersRideOnUpstream,
  parseCustomHeaders,
} from './gateway-headers.ts';

/** `AGENTS.md` §Gateway Facts — the verified prefix. */
const gatewayUrl = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/chat/completions';
/** Same HOST, different path: a custom endpoint keeps normal provider semantics. */
const sameHostCustomEndpoint = 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/v1/chat/completions';
/** What the SDK child is actually pointed at. */
const loopbackAdapterUrl = 'http://127.0.0.1:45671/v1/messages';
const byoUpstream = 'https://llm.example.com/v1/chat/completions';

const ENV_KEYS = ['NESSY_SESSION_ID', 'NESSY_CUSTOM_HEADERS'] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A `fetch` stand-in that records the call instead of opening a socket. */
function recordingFetch(): { calls: Array<{ url: string; headers: Record<string, string> }>; impl: typeof fetch } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries(),
    );
    calls.push({ url, headers });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, impl };
}

describe('gatewayRequestHeaders', () => {
  it('carries the session the CALLER named, not the one in the environment', () => {
    // The host has no NESSY_SESSION_ID and could not usefully have one: one
    // process, many sessions.
    delete process.env.NESSY_SESSION_ID;
    process.env.NESSY_CUSTOM_HEADERS = 'X-Tenant: acme';

    const headers = gatewayRequestHeaders(gatewayUrl, { sessionId: 'claude-session-7' });

    expect(headers[NESSY_SESSION_ID_HEADER]).toBe('claude-session-7');
    expect(headers['X-Tenant']).toBe('acme');
  });

  it('falls back to the environment for a one-session-per-process caller', () => {
    process.env.NESSY_SESSION_ID = 'pi-session-1';

    expect(gatewayRequestHeaders(gatewayUrl)[NESSY_SESSION_ID_HEADER]).toBe('pi-session-1');
  });

  it('sends nothing to any host but the verified gateway', () => {
    process.env.NESSY_SESSION_ID = 'pi-session-1';
    process.env.NESSY_CUSTOM_HEADERS = 'Authorization: Bearer operator-token';

    for (const url of [sameHostCustomEndpoint, loopbackAdapterUrl, byoUpstream]) {
      expect(gatewayRequestHeaders(url, { sessionId: 'claude-session-7' })).toEqual({});
    }
  });

  it('is empty when there is no session and no operator channel', () => {
    delete process.env.NESSY_SESSION_ID;
    delete process.env.NESSY_CUSTOM_HEADERS;

    expect(gatewayRequestHeaders(gatewayUrl, { sessionId: '   ' })).toEqual({});
  });

  it('refuses a session id that could split the request', () => {
    expect(gatewayRequestHeaders(gatewayUrl, { sessionId: 'a\r\nX-Injected: 1' })).toEqual({});
  });

  it('reserves its own header name against the operator channel', () => {
    const raw = 'x-nessy-session-id: forged\nX-NESSY-SESSION-ID: forged-too\nX-Tenant: acme';
    const { headers, invalid } = parseCustomHeaders(raw);

    expect(headers).toEqual({ 'X-Tenant': 'acme' });
    expect(invalid).toEqual(['x-nessy-session-id', 'X-NESSY-SESSION-ID']);

    process.env.NESSY_CUSTOM_HEADERS = raw;
    expect(customHeaderNames()).toEqual(['X-Tenant', '!x-nessy-session-id', '!X-NESSY-SESSION-ID']);
    expect(gatewayRequestHeaders(gatewayUrl, { sessionId: 'claude-session-7' })[NESSY_SESSION_ID_HEADER])
      .toBe('claude-session-7');
  });
});

describe('gatewaySessionFetch', () => {
  it('stamps the gateway request the loopback adapter makes upstream', async () => {
    delete process.env.NESSY_SESSION_ID;
    process.env.NESSY_CUSTOM_HEADERS = 'X-Tenant: acme';
    const { calls, impl } = recordingFetch();

    await gatewaySessionFetch('claude-session-7', impl)(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Nestor-Token': 'fixture-jwt' },
      body: '{}',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-nessy-session-id']).toBe('claude-session-7');
    expect(calls[0]!.headers['x-tenant']).toBe('acme');
    // The adapter's own credential decision is untouched.
    expect(calls[0]!.headers['nestor-token']).toBe('fixture-jwt');
  });

  it('is a pass-through for the loopback hop and for a BYO upstream', async () => {
    process.env.NESSY_CUSTOM_HEADERS = 'Authorization: Bearer operator-token';
    const { calls, impl } = recordingFetch();
    const wrapped = gatewaySessionFetch('claude-session-7', impl);

    await wrapped(loopbackAdapterUrl, { headers: { 'content-type': 'application/json' } });
    await wrapped(byoUpstream, { headers: { Authorization: 'Bearer byo-key' } });

    expect(calls[0]!.headers['x-nessy-session-id']).toBeUndefined();
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[1]!.headers.authorization).toBe('Bearer byo-key');
    expect(calls[1]!.headers['x-nessy-session-id']).toBeUndefined();
  });

  it('reaches a Request input that carried its own headers', async () => {
    delete process.env.NESSY_CUSTOM_HEADERS;
    const { calls, impl } = recordingFetch();

    await gatewaySessionFetch('claude-session-7', impl)(
      new Request(gatewayUrl, { method: 'POST', headers: { 'Nestor-Token': 'fixture-jwt' }, body: '{}' }),
    );

    expect(calls[0]!.headers['nestor-token']).toBe('fixture-jwt');
    expect(calls[0]!.headers['x-nessy-session-id']).toBe('claude-session-7');
  });
});

/**
 * P6.180 — the narrowing is CORRECT and was stated only in a docblock.
 *
 * Pi's interceptor offers operator headers to any provider URL its own adapter
 * list recognises; this module has none and refuses to invent one, because that
 * would mean sending an operator's token to an endpoint it cannot verify. So an
 * operator set one variable, watched it work on a Pi session, and got silence on
 * a claude- or codex-runtime session pointed anywhere else.
 *
 * The row's own instruction is not to "make the two paths uniform" — that is an
 * owner question about a safety trade — so what is built is the sentence. These
 * cases pin who gets it, who does not, and the invariant that makes it safe to
 * put on a user-visible channel: NAMES, never values.
 */
describe('P6.180 · the operator is told when custom headers will not ride', () => {
  const nestor = { kind: 'nestor' } as const;
  const byo = { kind: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' } as const;
  const byoOnGatewayPrefix = {
    kind: 'openai-compatible',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
  } as const;
  const env = (raw?: string) => (raw === undefined ? {} : { NESSY_CUSTOM_HEADERS: raw });

  it('answers the same question the header stamp asks, so the two cannot disagree', () => {
    expect(operatorHeadersRideOnUpstream(nestor)).toBe(true);
    expect(operatorHeadersRideOnUpstream(byoOnGatewayPrefix)).toBe(true);
    expect(operatorHeadersRideOnUpstream(byo)).toBe(false);
    expect(operatorHeadersRideOnUpstream(undefined)).toBe(false);
    // The control that ties it to the stamp itself, on the same two URLs.
    expect(Object.keys(gatewayRequestHeaders(byoUpstream, { env: env('X-Team: core') }))).toHaveLength(0);
    expect(gatewayRequestHeaders(gatewayUrl, { env: env('X-Team: core') })['X-Team']).toBe('core');
  });

  it('names the headers that will not be sent, and never their values', () => {
    // The documented form is NEWLINE-separated `Name: Value`, and the names keep
    // the case the operator wrote — both read off `parseCustomHeaders` rather
    // than assumed, because a test that invents the format tests nothing.
    const notice = customHeadersOffGatewayNotice('Claude', byo, env('X-Team: core\nX-Secret: hunter2'));

    expect(notice).toContain('Claude CUSTOM HEADERS NOT SENT');
    expect(notice).toContain('X-Team');
    expect(notice).toContain('X-Secret');
    // The module's own rule, and the reason this is safe on a durable channel.
    expect(notice).not.toContain('hunter2');
    expect(notice).not.toContain('core');
  });

  it('says nothing on a gateway session, where the headers DO ride', () => {
    expect(customHeadersOffGatewayNotice('Codex', nestor, env('X-Team: core'))).toBeUndefined();
    expect(customHeadersOffGatewayNotice('Codex', byoOnGatewayPrefix, env('X-Team: core'))).toBeUndefined();
  });

  it('says nothing when the operator set no headers at all', () => {
    expect(customHeadersOffGatewayNotice('Codex', byo, env())).toBeUndefined();
    expect(customHeadersOffGatewayNotice('Codex', byo, env('   '))).toBeUndefined();
  });

  /**
   * The two call sites, read off the sources. Both agents build the adapter
   * before any turn exists, so a behavioural assertion would have to boot a
   * runtime per arm to observe a queued notice — this pins the same wiring, and
   * it fails on exactly the regression the row exists to prevent: the sentence
   * being computed and then dropped, or sent to `debug()`.
   */
  it('is surfaced by BOTH runtimes, each on its own durable channel', () => {
    const agentDir = join(import.meta.dir, '..', 'agent');
    const codex = readFileSync(join(agentDir, 'codex-agent.ts'), 'utf-8');
    const claude = readFileSync(join(agentDir, 'claude-agent.ts'), 'utf-8');

    expect(codex).toContain("customHeadersOffGatewayNotice('Codex', upstream)");
    expect(codex).toContain('this.surfaceCodexOperatorNotice(customHeaderNotice)');
    expect(claude).toContain("customHeadersOffGatewayNotice('Claude', upstream)");
    expect(claude).toContain('this.queueDegradationNotice(customHeaderNotice)');
  });

  it('carries a malformed name marked, because a typo is why nothing arrived', () => {
    const notice = customHeadersOffGatewayNotice('Codex', byo, env('X-Team: core\nnot a header'));

    expect(notice).toContain('!');
    expect(notice).toContain('a name shown with a leading');
  });
});

/**
 * P6.462 — the attribution half, and the audience rule that makes it safe.
 *
 * MEASURED before any of this was written, because the row's own instruction was
 * that "a string in a binary is not a wire": the vendored native binary
 * (`claude-cli/2.1.233`, agent-sdk 0.3.260) pointed at a recording
 * Anthropic-Messages server, 2026-09-06, one main turn spawning a subagent that
 * itself spawned a second.
 *
 * | request | `x-claude-code-*` carried |
 * | --- | --- |
 * | main thread, all three turns | `session-id` only |
 * | subagent A | `session-id`, `agent-id=a06ff1cf7fdb0d6fc` |
 * | subagent B, spawned by A | `session-id`, `agent-id=ad2740e22b9a4829a`, `parent-agent-id=a06ff1cf7fdb0d6fc` |
 *
 * The ids below are those. The loopback adapter forwards the two claude-spelled
 * names onto the outbound request (`codex-responses-adapter/src/server.ts`,
 * pinned by `subagent-attribution.test.ts`); this function is the ONLY thing
 * that knows which URLs may receive a correlation id, so the rename and the
 * stripping are asserted here and nowhere else.
 */
describe('P6.462 · subagent attribution', () => {
  const AGENT_ID = 'ad2740e22b9a4829a';
  const PARENT_AGENT_ID = 'a06ff1cf7fdb0d6fc';
  const inboundBoth = {
    'content-type': 'application/json',
    'x-claude-code-agent-id': AGENT_ID,
    'x-claude-code-parent-agent-id': PARENT_AGENT_ID,
  };

  it('renames both onto the gateway request, and forwards NEITHER claude spelling', async () => {
    delete process.env.NESSY_CUSTOM_HEADERS;
    const { calls, impl } = recordingFetch();

    await gatewaySessionFetch('claude-session-7', impl)(gatewayUrl, { method: 'POST', headers: inboundBoth, body: '{}' });

    expect(calls[0]!.headers['x-nessy-agent-id']).toBe(AGENT_ID);
    expect(calls[0]!.headers['x-nessy-parent-agent-id']).toBe(PARENT_AGENT_ID);
    expect(calls[0]!.headers['x-nessy-session-id']).toBe('claude-session-7');
    // The request that leaves this host is OURS. A `x-claude-code-*` name on it
    // would tell the gateway the claude CLI called it directly.
    expect(calls[0]!.headers['x-claude-code-agent-id']).toBeUndefined();
    expect(calls[0]!.headers['x-claude-code-parent-agent-id']).toBeUndefined();
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  /**
   * The case the whole design turns on. The adapter cannot know which URLs may
   * receive a correlation id — it is the dependency root of the pair — so it
   * carries the ids on every upstream call it makes. If this function did not
   * strip them, forwarding would have put an internal agent id on a request to
   * an endpoint we cannot verify: the exact trade `gatewayRequestHeaders`
   * refuses to make for the operator's own header channel.
   */
  it('DELETES both on a BYO upstream, on the loopback hop and on the gateway host\'s other paths', async () => {
    delete process.env.NESSY_CUSTOM_HEADERS;
    const { calls, impl } = recordingFetch();
    const wrapped = gatewaySessionFetch('claude-session-7', impl);

    for (const url of [byoUpstream, loopbackAdapterUrl, sameHostCustomEndpoint]) {
      await wrapped(url, { headers: inboundBoth });
    }

    for (const call of calls) {
      expect(call.headers['x-claude-code-agent-id']).toBeUndefined();
      expect(call.headers['x-claude-code-parent-agent-id']).toBeUndefined();
      expect(call.headers['x-nessy-agent-id']).toBeUndefined();
      expect(call.headers['x-nessy-parent-agent-id']).toBeUndefined();
      // Stripping must not cost the request anything else it was carrying.
      expect(call.headers['content-type']).toBe('application/json');
    }
  });

  it('CONTROL: a main-thread turn gets the session id and no attribution at all', async () => {
    delete process.env.NESSY_CUSTOM_HEADERS;
    const { calls, impl } = recordingFetch();

    await gatewaySessionFetch('claude-session-7', impl)(gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(calls[0]!.headers['x-nessy-session-id']).toBe('claude-session-7');
    expect(calls[0]!.headers['x-nessy-agent-id']).toBeUndefined();
    expect(calls[0]!.headers['x-nessy-parent-agent-id']).toBeUndefined();
  });

  it('a parent with no child names nothing — the page pairs them, and so does this', () => {
    expect(gatewayRequestHeaders(gatewayUrl, { sessionId: 's', parentAgentId: PARENT_AGENT_ID }))
      .toEqual({ [NESSY_SESSION_ID_HEADER]: 's' });
  });

  it('refuses an agent id that could split the request', () => {
    expect(gatewayRequestHeaders(gatewayUrl, { sessionId: 's', agentId: 'a\r\nX-Injected: 1' }))
      .toEqual({ [NESSY_SESSION_ID_HEADER]: 's' });
  });

  it('reserves both new names against the operator channel, as it does the session id', () => {
    const raw = 'x-nessy-agent-id: forged\nX-Nessy-Parent-Agent-Id: forged-too\nX-Tenant: acme';
    const { headers, invalid } = parseCustomHeaders(raw);

    expect(headers).toEqual({ 'X-Tenant': 'acme' });
    expect(invalid).toEqual(['x-nessy-agent-id', 'X-Nessy-Parent-Agent-Id']);
  });

  /**
   * The switch verdict this row owes, stated as an assertion rather than as
   * prose: attribution below session level exists on ONE runtime of three, and
   * the reason is that Pi and codex have no producer — a Pi child session is its
   * own subprocess with its own session id, and codex's threads never reach this
   * fetch as separate agents. Minting an id for them would be inventing the very
   * fact the header claims to report.
   */
  it('SWITCH VERDICT: a session with no producer sends no attribution, and says so by sending nothing', async () => {
    delete process.env.NESSY_CUSTOM_HEADERS;
    const { calls, impl } = recordingFetch();

    // A Pi or codex turn: same wrapper, same gateway, no inbound attribution
    // because nothing upstream of it produces any.
    await gatewaySessionFetch('pi-session-1', impl)(gatewayUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    expect(Object.keys(calls[0]!.headers).filter(name => name.includes('agent-id'))).toEqual([]);
    expect(calls[0]!.headers['x-nessy-session-id']).toBe('pi-session-1');
  });
});

/**
 * C3.218 — the instrument that makes M2's proof observable on a PACKAGED build.
 *
 * The 1.36.0 release sitting could not drive P6.181 to a verdict because there
 * was no capture point: the correlation seam is a `fetchImpl` in the main
 * process, so the interceptor never sees it, and the request leaves over TLS to
 * a host nothing on the machine may intercept. Every arm of the proof is decided
 * in `gatewaySessionFetch`, so that is where the observation belongs.
 *
 * Two properties are pinned here, and the second is the one that must never
 * regress: the line carries header NAMES and the session id, and never a header
 * VALUE — the operator channel is exactly where a token goes.
 */
describe('C3.218 — the gateway header decision is observable, names only', () => {
  const DEBUG_ON = { NESSY_PROXY_AUTH_DEBUG: '1' } as Record<string, string | undefined>;

  it('names what was added on the gateway prefix, and never a value', () => {
    const extra = gatewayRequestHeaders(gatewayUrl, {
      sessionId: 'sess-c3218',
      env: { NESSY_CUSTOM_HEADERS: 'X-Team: platform-secret-value' },
    });
    const line = gatewayHeaderDecisionLine(gatewayUrl, { sessionId: 'sess-c3218' }, extra, DEBUG_ON);
    expect(line).toContain('gateway request');
    expect(line).toContain('X-Team');
    expect(line).toContain(NESSY_SESSION_ID_HEADER);
    expect(line).toContain('session=sess-c3218');
    // The whole reason this function exists rather than a `JSON.stringify`.
    expect(line).not.toContain('platform-secret-value');
  });

  it('says so when nothing was added, which is what the two absence controls need', () => {
    // Control (b): the loopback hop. `gatewayRequestHeaders` declines by prefix,
    // and an instrument that only spoke when it acted could not evidence that.
    const extra = gatewayRequestHeaders(loopbackAdapterUrl, { sessionId: 'sess-c3218' });
    const line = gatewayHeaderDecisionLine(loopbackAdapterUrl, { sessionId: 'sess-c3218' }, extra, DEBUG_ON);
    expect(line).toContain('off-gateway request');
    expect(line).toContain('no headers added');
    // Control (a): a BYO endpoint, same shape, same verdict.
    const byo = gatewayRequestHeaders(byoUpstream, { sessionId: 'sess-c3218' });
    expect(gatewayHeaderDecisionLine(byoUpstream, { sessionId: 'sess-c3218' }, byo, DEBUG_ON))
      .toContain('no headers added');
  });

  it('stays silent unless the operator asked for it', () => {
    const extra = gatewayRequestHeaders(gatewayUrl, { sessionId: 'sess-c3218' });
    expect(gatewayHeaderDecisionLine(gatewayUrl, { sessionId: 'sess-c3218' }, extra, {})).toBeUndefined();
    expect(gatewayHeaderDecisionLine(gatewayUrl, { sessionId: 'sess-c3218' }, extra, { NESSY_PROXY_AUTH_DEBUG: '0' }))
      .toBeUndefined();
  });
});
