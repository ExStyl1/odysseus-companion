/**
 * P3.334 — a policy refusal must not read as a bad key on the codex route.
 *
 * ## The defect this pins out
 *
 * `/v1/responses` collapsed every upstream status into one of three
 * (`400 → 400`, `401|403 → 401`, everything else `→ 502`), while the SAME file's
 * `/v1/messages` arm passed the status through and carried a comment saying why.
 * The 403 arm is the one that costs a user real time: the gateway in front of
 * these models refuses by policy with
 * `403 {"error":"… Security Guardrail Triggered: Malicious MCP detected …"}`
 * (measured 2026-08-15 on the claude arm of the same gateway, which is why
 * `shared/src/agent/claude-sdk-error-mapper.ts` carries "A 403 IS NOT AN AUTH
 * FAILURE" in as many words). Collapsed to 401 the same refusal arrives as a
 * credential problem, and the user is sent to re-enter a key that works.
 *
 * ## Why the STATUS is the thing to assert, read from the codex source
 *
 * `github.com/openai/codex` at `rust-v0.148.0` — strong evidence, the source the
 * shipped binary is built from — classifies BY STATUS in
 * `codex-rs/codex-api/src/api_bridge.rs::map_api_error`:
 *
 *  - 403 + `error.code == "misalignment_policy_violation"` →
 *    `CodexErr::MisalignmentPolicyViolation`; a Cloudflare-blocked 403 gets its
 *    own `user_message`. And `codex-rs/core/src/client.rs:1525` intercepts a 401
 *    BEFORE the mapper to run `handle_unauthorized` — a credential refresh and a
 *    retry — so the collapse did not merely mislabel the refusal, it made codex
 *    answer it by re-authenticating.
 *  - 429 → `CodexErr::UsageLimitReached` (plan, reset time, rate-limit snapshot).
 *  - 500 → `CodexErr::InternalServerError`; 503 + `server_is_overloaded` →
 *    `CodexErr::ServerOverloaded`.
 *
 * RETRY is NOT what the collapse broke, and the row that opened this said it
 * was: `codex-rs/codex-client/src/retry.rs::RetryOn::should_retry` retries 429
 * and `status.is_server_error()`, and 502 is a server error — the ladder ran
 * either way. Recorded here so the next reader does not re-derive it.
 *
 * ## The other half: the same collapse one layer in
 *
 * A mid-stream failure has no HTTP status of its own, so
 * `inferHttpStatusFromAdapterMessage` reads one out of the text — and it folded
 * `forbidden` / `permission denied` / `access denied` into 401 as well, which
 * `classifyError` then answered with `invalid_api_key`. Both halves are needed:
 * a 403 branch nothing can reach is decoration, and an inferred 403 that still
 * lands in the auth branch changes nothing.
 */
import { test, expect, describe } from 'bun:test';
import { startAdapter } from '../server.ts';
import { adapterFailureFromMessage, classifyError, inferHttpStatusFromAdapterMessage } from '../errors.ts';

const GUARDRAIL = 'Security Guardrail Triggered: Malicious MCP detected. Invalid tools: mcp__x__y';

async function postResponses(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('P3.334 · the /v1/responses route carries the upstream status', () => {
  /**
   * The row's own case, and the reason the whole file exists. KILLS: the
   * `401 || 403 → 401` collapse coming back.
   */
  test('a 403 policy refusal reaches the caller AS 403, with its reason intact', async () => {
    const body = JSON.stringify({ error: { message: GUARDRAIL, type: 'invalid_request_error', code: null } });
    const fetchImpl = (async () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    try {
      const res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error?: { message?: string; code?: string | null } };
      expect(json.error?.message).toContain(GUARDRAIL);
      expect(json.error?.code).toBe('403');
    } finally {
      await adapter.close();
    }
  });

  /**
   * NEGATIVE CONTROL on the same rig: 401 still means 401. Without it a route
   * that answered every failure with the upstream number would pass the case
   * above while having learned nothing — and 401 is the one status codex acts on
   * before its own mapper runs.
   */
  test('a 401 is still a 401 — the credential class is not widened', async () => {
    const fetchImpl = (async () => new Response('token is malformed', { status: 401 })) as unknown as typeof fetch;
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    try {
      const res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
      expect(res.status).toBe(401);
      const json = (await res.json()) as { error?: { code?: string | null } };
      expect(json.error?.code).toBe('401');
    } finally {
      await adapter.close();
    }
  });

  /**
   * The statuses the `→ 502` arm used to swallow, each named by `map_api_error`
   * as its own `CodexErr`. Table-driven because the failure mode is a partial
   * fix: a route that special-cases 403 and leaves 429 collapsed still hands
   * codex a rate limit it cannot recognise.
   */
  for (const [upstream, label] of [
    [429, 'UsageLimitReached'],
    [500, 'InternalServerError'],
    [503, 'ServerOverloaded'],
    [529, 'an overload the Anthropic consumer names'],
  ] as const) {
    test(`an upstream ${upstream} arrives as ${upstream} (codex: ${label})`, async () => {
      const fetchImpl = (async () => new Response('boom', { status: upstream })) as unknown as typeof fetch;
      const adapter = await startAdapter({ jwt: 'j', fetchImpl });
      try {
        const res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
        expect(res.status).toBe(upstream);
      } finally {
        await adapter.close();
      }
    });
  }

  /**
   * The floor the passthrough keeps, and it is reachable: `!upstream.ok` is true
   * for a 3xx too, and a redirect is not an error the client can act on. Only
   * 400-599 passes through; everything else is still 502.
   */
  test('a 3xx upstream is not passed through — it is still 502', async () => {
    const fetchImpl = (async () => new Response('moved', { status: 302, headers: { location: '/elsewhere' } })) as unknown as typeof fetch;
    const adapter = await startAdapter({ jwt: 'j', fetchImpl });
    try {
      const res = await postResponses(adapter.port, { model: 'm', input: [], stream: false });
      expect(res.status).toBe(502);
      const json = (await res.json()) as { error?: { code?: string | null } };
      // The upstream's own number survives in the code even when the status does not.
      expect(json.error?.code).toBe('302');
    } finally {
      await adapter.close();
    }
  });
});

describe('P3.334 · the mid-stream text classifier splits 403 from 401', () => {
  /**
   * KILLS: the vendored table's 401-or-nothing reading of a refusal word. Each
   * left value is a decision about an accepted credential; each right value in
   * the control below names the credential itself.
   */
  for (const text of ['permission_denied', 'permission denied on this resource', 'Forbidden', 'access denied by policy']) {
    test(`"${text}" infers 403 and classifies as a refusal`, () => {
      expect(inferHttpStatusFromAdapterMessage(text)).toBe(403);
      const classified = classifyError(403, 'permission_error', text);
      expect(classified.type).toBe('permission_error');
      expect(classified.code).toBe('permission_denied');
      expect(classified.code).not.toBe('invalid_api_key');
    });
  }

  /** POSITIVE CONTROL: the credential words must NOT have moved. */
  for (const text of ['unauthenticated', 'unauthorized', 'invalid token', 'expired token', 'authentication failed']) {
    test(`"${text}" still infers 401 and still classifies as an auth failure`, () => {
      expect(inferHttpStatusFromAdapterMessage(text)).toBe(401);
      expect(classifyError(401, 'authentication_error', text).code).toBe('invalid_api_key');
    });
  }

  /**
   * The pair, driven through the ONE production entry point, because that is
   * what makes either half reachable — `from-chat-stream.ts` calls exactly this.
   */
  test('adapterFailureFromMessage carries a refusal end to end', () => {
    const out = adapterFailureFromMessage('upstream error: access denied by the security guardrail');
    expect(out.httpStatus).toBe(403);
    expect(out.error.code).toBe('permission_denied');
    const auth = adapterFailureFromMessage('unauthorized: token is malformed');
    expect(auth.httpStatus).toBe(401);
    expect(auth.error.code).toBe('invalid_api_key');
  });

  /**
   * THE LIMIT OF THE TEXT HALF, stated rather than implied. The gateway's own
   * measured guardrail sentence carries none of the four refusal words, and it
   * DOES carry "Invalid" — so the inferrer reads it as a 400, not a 403, and no
   * keyword table would have caught it. That is exactly why the fix at the
   * transport site (the status passthrough above) is the load-bearing half: when
   * a real status exists it is never guessed from prose.
   */
  test('the measured guardrail sentence alone does not infer 403 — the status does the work', () => {
    expect(inferHttpStatusFromAdapterMessage(GUARDRAIL)).toBe(400);
  });
});
