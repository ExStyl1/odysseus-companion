/**
 * UA12.172 — the loopback model adapter refuses a request whose `Host` is not `127.0.0.1:<its port>` and any request
 * carrying an `Origin` header (403), before any route runs.
 *
 * Why (DECISIONS-1.42.0.md #20, option (b)): the adapter spends the user's gateway access for whoever reaches its
 * ephemeral port. A browser page that learns the port can reach it two ways — DNS rebinding (its own hostname resolved
 * to 127.0.0.1, so the request carries `Host: <that hostname>`) and a CORS-simple cross-origin POST (`text/plain`, no
 * preflight, carrying `Origin`). The adapter's two real clients send neither: measured 2026-10-09 against a recording
 * server in the adapter's place (rig `work/lf-2/host-probe.ts`, not committed) — the shipped `codex-app-server`
 * 0.159.3 posted `/v1/responses` with `Host: 127.0.0.1:<port>` and no `Origin` (its `originator` header is not
 * `Origin`), and the bundled Claude Code 2.1.274 posted `/v1/messages?beta=true` with `Host: 127.0.0.1:<port>` and no
 * `Origin`. A per-adapter bearer (option (a)) was not taken: it needs plumbing through both runtimes, and a same-user
 * process can read the gateway credential file anyway.
 *
 * Requests are written on a raw socket so the test, not a client library, decides the `Host` line.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { startAdapter, type AdapterHandle } from '../server.ts';

let adapter: AdapterHandle | null = null;
let upstreamCalls = 0;

afterEach(async () => {
  await adapter?.close();
  adapter = null;
  upstreamCalls = 0;
});

function chatSse(): Response {
  const chunks = [
    { choices: [{ delta: { content: 'hi' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
}

async function start(): Promise<number> {
  // `jwt: 'test'` keeps every arm away from the credential file; the upstream is a stub that counts its calls.
  adapter = await startAdapter({
    jwt: 'test',
    fetchImpl: (async () => { upstreamCalls += 1; return chatSse(); }) as unknown as typeof fetch,
  });
  return adapter.port;
}

/** One HTTP/1.1 request on a raw socket; `headers` are written verbatim (a `null` Host writes no Host line). */
function raw(port: number, method: string, path: string, headers: Record<string, string | null>, body = ''): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (d: Buffer) => { data += d.toString('utf8'); });
    socket.on('error', reject);
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(data)?.[1] ?? 0);
      resolve({ status, text: data.slice(data.indexOf('\r\n\r\n') + 4) });
    });
    const lines = [`${method} ${path} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) if (value !== null) lines.push(`${name}: ${value}`);
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body);
    socket.write(lines.join('\r\n'));
  });
}

const RESPONSES_BODY = JSON.stringify({ model: 'coder', input: 'hi', stream: true });
const MESSAGES_BODY = JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true });

describe('UA12.172 — the adapter answers only its own loopback clients', () => {
  test('POSITIVE: the clients\' own shape (Host 127.0.0.1:<port>, no Origin) reaches both routes', async () => {
    const port = await start();
    const host = `127.0.0.1:${port}`;
    const responses = await raw(port, 'POST', '/v1/responses', { Host: host, 'Content-Type': 'application/json' }, RESPONSES_BODY);
    expect(responses.status).toBe(200);
    const messages = await raw(port, 'POST', '/v1/messages?beta=true', { Host: host, 'Content-Type': 'application/json' }, MESSAGES_BODY);
    expect(messages.status).toBe(200);
    expect(upstreamCalls).toBe(2);
  });

  test('NEGATIVE: a rebinding Host (evil.example), another port, localhost or no Host is refused 403 before the upstream', async () => {
    const port = await start();
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost:${port}`, '127.0.0.1']) {
      const res = await raw(port, 'POST', '/v1/responses', { Host: host, 'Content-Type': 'application/json' }, RESPONSES_BODY);
      expect({ host, status: res.status }).toEqual({ host, status: 403 });
    }
    // An HTTP/1.1 request with no Host line never reaches the handler: the server's own HTTP layer answers 400
    // (measured under bun's node:http; Node's `requireHostHeader` defaults to the same). Refused either way.
    const hostless = await raw(port, 'POST', '/v1/responses', { Host: null, 'Content-Type': 'application/json' }, RESPONSES_BODY);
    expect([400, 403]).toContain(hostless.status);
    const messages = await raw(port, 'POST', '/v1/messages?beta=true', { Host: 'evil.example', 'Content-Type': 'application/json' }, MESSAGES_BODY);
    expect(messages.status).toBe(403);
    expect(upstreamCalls).toBe(0);
  });

  test('NEGATIVE: any Origin is refused 403 even with the right Host — the CORS-simple text/plain POST included', async () => {
    const port = await start();
    const host = `127.0.0.1:${port}`;
    for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${port}`]) {
      const res = await raw(port, 'POST', '/v1/responses', { Host: host, Origin: origin, 'Content-Type': 'text/plain' }, RESPONSES_BODY);
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
    }
    expect(upstreamCalls).toBe(0);
    // The refusal names why, so a misconfigured client is diagnosable.
    const res = await raw(port, 'GET', '/v1/models', { Host: host, Origin: 'http://evil.example' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('Origin');
  });
});
