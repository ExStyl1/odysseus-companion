/**
 * P6.258 (denominator C16) — a gateway that reads its credential in `x-api-key`.
 *
 * Both non-gateway arms sent `Authorization: Bearer` and only that, so such an
 * endpoint could not be connected on ANY runtime however correct the key was.
 * The verdict was `absent` on all three and the mechanism is host-side by
 * construction — one adapter serves both BYO runtimes — so this is the host
 * supplying it once rather than three per-runtime builds.
 *
 * The load-bearing row here is the DEFAULT: the field is absent on every
 * connection that has never set it, and absent must keep meaning bearer, or this
 * change would silently re-authenticate every BYO session in the product.
 *
 * The requests are captured through the injected `fetchImpl` rather than read
 * off the target, so what is asserted is the request that actually left.
 */
import { describe, expect, it } from 'bun:test';
import { postChat, postAnthropicMessages, type UpstreamTarget } from '../nestor-client.ts';

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function capturing(): { calls: Captured[]; fetchImpl: typeof fetch } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), headers });
    return new Response('{"choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const CHAT = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] } as never;
const MESSAGES = { model: 'house-model', messages: [{ role: 'user', content: 'hi' }] } as never;

describe('the BYO credential header', () => {
  it('defaults to bearer when the field is absent — no existing connection changes', async () => {
    const { calls, fetchImpl } = capturing();
    const target: UpstreamTarget = { kind: 'openai-compatible', baseUrl: 'https://byo.test/v1', apiKey: 'k1' };

    await postChat(CHAT, { upstream: target, fetchImpl });

    expect(calls[0]!.headers.authorization).toBe('Bearer k1');
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('sends the key in `x-api-key` and NOTHING in Authorization when the endpoint asks for it', async () => {
    const { calls, fetchImpl } = capturing();
    const target: UpstreamTarget = {
      kind: 'openai-compatible',
      baseUrl: 'https://byo.test/v1',
      apiKey: 'k2',
      credentialHeader: 'x-api-key',
    };

    await postChat(CHAT, { upstream: target, fetchImpl });

    expect(calls[0]!.headers['x-api-key']).toBe('k2');
    // Sending both would leak the credential to an endpoint that asked for one
    // header, and some proxies reject a request carrying two schemes.
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('an explicit `authorization` is the same as the default', async () => {
    const { calls, fetchImpl } = capturing();
    const target: UpstreamTarget = {
      kind: 'openai-compatible',
      baseUrl: 'https://byo.test/v1',
      apiKey: 'k3',
      credentialHeader: 'authorization',
    };

    await postChat(CHAT, { upstream: target, fetchImpl });

    expect(calls[0]!.headers.authorization).toBe('Bearer k3');
  });

  it('carries on the anthropic-messages arm too — the two BYO arms cannot diverge', async () => {
    const { calls, fetchImpl } = capturing();
    const target: UpstreamTarget = {
      kind: 'anthropic-messages',
      baseUrl: 'https://byo.test',
      apiKey: 'k4',
      credentialHeader: 'x-api-key',
    };

    await postAnthropicMessages(MESSAGES, { upstream: target, fetchImpl });

    expect(calls[0]!.url).toBe('https://byo.test/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('k4');
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('a keyless endpoint still sends no credential header at all', async () => {
    // Ollama and friends (`authType: 'none'`). The header choice must not
    // conjure an empty credential.
    const { calls, fetchImpl } = capturing();
    const target: UpstreamTarget = {
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      credentialHeader: 'x-api-key',
    };

    await postChat(CHAT, { upstream: target, fetchImpl });

    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('the typed auth-scheme sink reports every scheme that rode, `x-api-key` included', async () => {
    // P6.258 could reach only three of the four: the sink's one registered
    // consumer is `codex-agent.ts`, a hot-spot file that lane could not write, so
    // `x-api-key` fell through to the stderr line rather than being reported as
    // something false. P6.585 widened both halves in one commit; the property
    // asserted here is now the whole vocabulary, in the order it rode.
    const seen: string[] = [];
    const { fetchImpl } = capturing();
    await postChat(CHAT, {
      upstream: { kind: 'openai-compatible', baseUrl: 'https://byo.test/v1', apiKey: 'k5', credentialHeader: 'x-api-key' },
      fetchImpl,
      onUpstreamAuth: scheme => seen.push(scheme),
    });
    await postChat(CHAT, {
      upstream: { kind: 'openai-compatible', baseUrl: 'https://byo.test/v1', apiKey: 'k5' },
      fetchImpl,
      onUpstreamAuth: scheme => seen.push(scheme),
    });

    expect(seen).toEqual(['x-api-key', 'bearer']);
  });

  it('the gateway arm is untouched — `Nestor-Token` is the only scheme it may carry', async () => {
    const { calls, fetchImpl } = capturing();
    await postChat(CHAT, { upstream: { kind: 'nestor' }, jwt: 'jwt-1', fetchImpl });

    expect(calls[0]!.headers['nestor-token']).toBe('jwt-1');
    expect(calls[0]!.headers['x-api-key']).toBeUndefined();
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});
