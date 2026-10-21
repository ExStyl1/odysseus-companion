/**
 * DA1.7 (T7) — the `opts.jwt` injection seam, PINNED rather than guarded.
 *
 * `server.ts` symbol `resolveGatewayJwt` reads
 * `opts.jwt !== undefined ? opts.jwt : readNestorJwt()`, so an injected value is
 * preferred over the creds file AND never passes `nestor-auth.ts`'s shape gate
 * (symbol `isJwtShaped`). Whatever is injected reaches `Nestor-Token` verbatim.
 *
 * ## Why this file PINS the behaviour instead of guarding it
 *
 * The census, re-run at HEAD on 2026-09-13:
 * `git grep -ahoE "jwt: '[^']*'" HEAD -- packages/codex-responses-adapter | wc -l`
 * answers **71 occurrences** over **13** files (`git grep -alE … | wc -l`), of
 * which **55** are the single character `j` and only **2** are JWT-shaped. So
 * adding the guard costs 69 call-site edits, where the pin costs this file plus
 * one static scan.
 *
 * **And that same census bounds this row's value honestly.** Because 69 of the
 * 71 injected values are non-JWT-shaped, adding the guard later would redden 13
 * files at once — the seam cannot regress silently. This file NAMES an
 * undocumented behaviour; it does not close an otherwise-invisible exposure, and
 * saying so is what keeps the row XS.
 *
 * ## What makes the seam load-bearing rather than academic
 *
 * No PRODUCTION caller injects — both `startAdapter` call sites (`claude-agent.ts`
 * and `codex-agent.ts`) pass no `jwt` key, which is what the sibling static scan
 * `packages/shared/src/agent/__tests__/adapter-jwt-injection-call-sites.test.ts`
 * asserts BY NAME. The only other caller is
 * `packages/codex-responses-adapter/scripts/reliability-probe.mjs`, a probe
 * script and not production. DA1.12 then adds an EXPIRY rule to `readNestorJwt`,
 * and this seam bypasses that rule for the same reason it bypasses the shape one
 * — an injected string has no creds file behind it — which is why the two rows
 * land in one wave.
 *
 * **Native mechanism: none.** The adapter is ours and the seam is host-owned;
 * the nearest documented neighbour is codex's own `cliAuthCredentialsStore`,
 * which governs codex's store and not this loopback gate.
 *
 * The injected literals below are fabricated non-credentials.
 */
import { describe, expect, test } from 'bun:test';
import { startAdapter } from '../server.ts';

/** Fabricated, deliberately NOT three dot-separated segments. */
const NOT_A_JWT = 'sk-not-a-jwt-token';

interface Captured {
  url: string;
  headers: Record<string, string>;
}

function capturingAdapterFetch(calls: Captured[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url: String(input), headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('DA1.7 · the adapter `opts.jwt` seam bypasses the creds-file shape gate', () => {
  test('an injected NON-JWT reaches `Nestor-Token` verbatim on /v1/responses', async () => {
    const calls: Captured[] = [];
    const adapter = await startAdapter({ jwt: NOT_A_JWT, fetchImpl: capturingAdapterFetch(calls) });
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', input: 'hi', stream: false }),
      });
      // NOT a 401: the gate is satisfied by the injected value alone, so the
      // request goes upstream.
      expect(res.status).toBe(200);
    } finally {
      await adapter.close();
    }
    // `readNestorJwt` would have returned null for this string
    // (`nestor-auth.test.ts` pins exactly that), yet it is on the wire.
    expect(calls[0]!.headers['nestor-token']).toBe(NOT_A_JWT);
  });

  test('the same injected NON-JWT reaches `Nestor-Token` verbatim on /v1/messages', async () => {
    const calls: Captured[] = [];
    const adapter = await startAdapter({ jwt: NOT_A_JWT, fetchImpl: capturingAdapterFetch(calls) });
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
    } finally {
      await adapter.close();
    }
    expect(calls[0]!.headers['nestor-token']).toBe(NOT_A_JWT);
  });

  /**
   * The NEGATIVE control, and it is what proves the two cases above measure the
   * injection rather than the absence of a gate: with NO injection and a creds
   * path that cannot resolve a jwt, the same route refuses with the gate's own
   * 401. Injecting `null` is the honest way to spell "no injected value AND no
   * readable creds file" without touching the real `~/.nessy` path — the gate
   * reads `opts.jwt !== undefined`, so `null` reaches the falsy branch that a
   * missing creds file reaches.
   */
  test('without an injected value the same route refuses with the gate 401', async () => {
    const calls: Captured[] = [];
    const adapter = await startAdapter({ jwt: null, fetchImpl: capturingAdapterFetch(calls) });
    try {
      const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', input: 'hi', stream: false }),
      });
      expect(res.status).toBe(401);
    } finally {
      await adapter.close();
    }
    expect(calls).toHaveLength(0);
  });
});
