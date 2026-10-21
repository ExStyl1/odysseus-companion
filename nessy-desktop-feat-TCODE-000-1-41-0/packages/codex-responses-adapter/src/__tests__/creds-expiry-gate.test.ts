/**
 * DA1.12 (T12) — the gateway creds gate honours EXPIRY, with its own 401 code.
 *
 * ## What was wrong
 *
 * `nestor-auth.ts` symbol `readNestorJwt` checked SHAPE only — the string
 * `expiresAt` did not occur anywhere in that file — while the same field's owner,
 * `@nessy-agent/shared` `auth/dp/creds-store.ts` symbol `getValidCreds`, checks
 * shape AND `expiresAt <= Date.now()` over a field its own `DpCredentials`
 * declares as `epoch ms`. So the Claude and Codex arms posted an expired but
 * well-shaped JWT indefinitely, and both routes rendered ONE string — an expired
 * credential was reported as a missing one, which sends the user to re-enter an
 * API key that is fine instead of to the sign-in that re-mints the token.
 *
 * **Target scheme clause 1 is what makes the distinct code load-bearing:** the
 * credential of record is the JWT in the creds file and an EXPIRED one is
 * precisely the re-mint trigger that clause names, so DA1.4's card has something
 * to render.
 *
 * ## What is asserted here
 *
 * The reader's three arms, then the two WIRES, because the row's done-means is
 * about what a user's client receives:
 *  - `/v1/responses` (OpenAI envelope) carries the reason in `error.code`;
 *  - `/v1/messages` (Anthropic envelope) has NO `code` field — see
 *    `anthropic/outbound.ts` symbol `anthropicErrorBody` — so its distinction is
 *    the message and nothing else, which is why the message is asserted there.
 *
 * Every credential in this file is a fabricated three-segment string under a
 * temp directory; nothing reads the real `~/.nessy/dp_auth_creds.json`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relatchHomeDirForTests } from '../home-latch.ts';
import { defaultCredsPath, readNestorCreds, readNestorJwt } from '../nestor-auth.ts';
import { EXPIRED_CREDENTIALS, NO_CREDENTIALS, startAdapter } from '../server.ts';

/** Fabricated: three non-empty dot-separated segments, decoding to nothing. */
const SHAPED_JWT = 'aGVhZA.cGF5bG9hZA.c2ln';

const dir = mkdtempSync(join(tmpdir(), 'creds-expiry-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function credsFile(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

describe('DA1.12 · readNestorCreds names WHY it refused', () => {
  test('(pos) a shaped jwt with a FUTURE expiry passes, and carries the jwt', () => {
    const path = credsFile('future.json', { jwt: SHAPED_JWT, expiresAt: Date.now() + 60_000 });
    expect(readNestorCreds(path)).toEqual({ ok: true, jwt: SHAPED_JWT });
    expect(readNestorJwt(path)).toBe(SHAPED_JWT);
  });

  test('(neg) the same jwt with a PAST expiry is refused as expired, not as missing', () => {
    const path = credsFile('past.json', { jwt: SHAPED_JWT, expiresAt: Date.now() - 1 });
    expect(readNestorCreds(path)).toEqual({ ok: false, reason: 'credentials_expired' });
    // The thin wrapper every other caller still uses gets the expiry fix for free.
    expect(readNestorJwt(path)).toBeNull();
  });

  test('(neg) a missing file is still `no_credentials`, not `credentials_expired`', () => {
    expect(readNestorCreds(join(dir, 'absent.json'))).toEqual({ ok: false, reason: 'no_credentials' });
  });

  test('(neg) a non-JWT value is `no_credentials` however far in the future it expires', () => {
    // Shape is checked BEFORE expiry on purpose: garbage with a future expiry is
    // not an expired credential, it is not a credential.
    const path = credsFile('garbage.json', { jwt: 'sk-not-a-jwt-token', expiresAt: Date.now() + 60_000 });
    expect(readNestorCreds(path)).toEqual({ ok: false, reason: 'no_credentials' });
  });

  test('the DELIBERATE divergence from `getValidCreds`: an absent expiry still passes', () => {
    // `getValidCreds` refuses a file with no numeric `expiresAt`; this gate does
    // not, because a refusal here ends the user's TURN while a null there merely
    // triggers a re-mint. Pinned so the divergence cannot be changed by accident
    // and so a reader meets the reason rather than re-deriving it.
    const path = credsFile('no-expiry.json', { jwt: SHAPED_JWT });
    expect(readNestorCreds(path)).toEqual({ ok: true, jwt: SHAPED_JWT });
  });
});

async function post(port: number, route: string, body: unknown): Promise<{ status: number; json: Record<string, never> }> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, never> };
}

const RESPONSES_BODY = { model: 'm', input: 'hi', stream: false };
const MESSAGES_BODY = { model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

const upstreamAlwaysOk = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})) as unknown as typeof fetch;

/**
 * Drive a route through the gate's REAL default creds path, with `~` moved to a
 * temp directory for the duration of one test body.
 *
 * `relatchHomeDirForTests` is the seam `home-latch.ts` ships for exactly this —
 * under `bun test`, moving `process.env.HOME` moves nothing at all (P3.169), so
 * this is the only way to exercise `defaultCredsPath()` without reading the real
 * `~/.nessy/dp_auth_creds.json`. The latch is process-global, so it is restored
 * in a `finally` inside each test rather than held across the file: bun ignores
 * the order of the paths it is given, and a neighbouring suite in the same
 * process calls `readNestorJwt()` at module scope.
 */
async function withHomeCreds<T>(
  creds: unknown | undefined,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gate-home-'));
  mkdirSync(join(home, '.nessy'), { recursive: true });
  if (creds !== undefined) writeFileSync(join(home, '.nessy', 'dp_auth_creds.json'), JSON.stringify(creds));
  // DA1.36 — the latch alone does not isolate this suite. `NESSY_HOME` OUTRANKS the
  // latched home inside the creds resolver (`../nestor-auth.ts` symbol `defaultCredsPath`
  // returns an absolute value verbatim, DA1.5), so a developer with it exported ran every
  // case below against a REAL creds directory. The name is spelled as that resolver
  // spells it (this package does not import `@nessy-agent/shared`). `delete` FIRST, then
  // assign on the restore path too: an assignment to a name Bun pre-creates a slot for is
  // invisible to `Object.keys` and to a spread (AGENTS.md section Traps).
  const savedNessyHome = process.env.NESSY_HOME;
  delete process.env.NESSY_HOME;
  relatchHomeDirForTests(home);
  try {
    const adapter = await startAdapter({ fetchImpl: upstreamAlwaysOk });
    try {
      return await run(adapter.port);
    } finally {
      await adapter.close();
    }
  } finally {
    relatchHomeDirForTests();
    delete process.env.NESSY_HOME;
    if (savedNessyHome !== undefined) process.env.NESSY_HOME = savedNessyHome;
    rmSync(home, { recursive: true, force: true });
  }
}

describe('DA1.12 · both wires refuse an EXPIRED credential with its own code', () => {
  test('(pos) a future expiry passes the gate on /v1/responses', async () => {
    await withHomeCreds({ jwt: SHAPED_JWT, expiresAt: Date.now() + 60_000 }, async (port) => {
      const { status } = await post(port, '/v1/responses', RESPONSES_BODY);
      expect(status).toBe(200);
    });
  });

  test('(neg) a PAST expiry is refused on /v1/responses with code `credentials_expired`', async () => {
    await withHomeCreds({ jwt: SHAPED_JWT, expiresAt: Date.now() - 1 }, async (port) => {
      const { status, json } = await post(port, '/v1/responses', RESPONSES_BODY);
      expect(status).toBe(401);
      expect(json).toEqual({
        error: { message: EXPIRED_CREDENTIALS(), type: 'authentication_error', code: 'credentials_expired' },
      } as never);
    });
  });

  test('(neg) a PAST expiry is refused on /v1/messages with the expired SENTENCE', async () => {
    await withHomeCreds({ jwt: SHAPED_JWT, expiresAt: Date.now() - 1 }, async (port) => {
      const { status, json } = await post(port, '/v1/messages', MESSAGES_BODY);
      expect(status).toBe(401);
      const body = JSON.stringify(json);
      expect(body).toContain(EXPIRED_CREDENTIALS());
      // The Anthropic envelope carries no `code` at all, so the sentence is the
      // whole of the distinction on this route.
      expect(body).not.toContain('"code"');
      expect(body).not.toContain(NO_CREDENTIALS());
    });
  });

  test('(neg) a MISSING file still yields the not-found code on /v1/responses', async () => {
    await withHomeCreds(undefined, async (port) => {
      const { status, json } = await post(port, '/v1/responses', RESPONSES_BODY);
      expect(status).toBe(401);
      expect(json).toEqual({
        error: { message: NO_CREDENTIALS(), type: 'authentication_error', code: 'no_credentials' },
      } as never);
    });
  });

  test('(neg) a MISSING file still yields the not-found sentence on /v1/messages', async () => {
    await withHomeCreds(undefined, async (port) => {
      const { status, json } = await post(port, '/v1/messages', MESSAGES_BODY);
      expect(status).toBe(401);
      expect(JSON.stringify(json)).toContain(NO_CREDENTIALS());
    });
  });

  test('the two refusals are DIFFERENT strings, and the expired one is the re-mint trigger', () => {
    // The row exists because these were one string. Asserting they differ is the
    // regression that matters.
    expect(EXPIRED_CREDENTIALS()).not.toBe(NO_CREDENTIALS());
    // `SessionManager` symbol `messageLooksLikePlainAuthError` matches this
    // substring, so the expired refusal is recognised by the shared auth-retry
    // seam where the not-found one is not. If this pin ever has to change, the
    // heuristic is the thing to read first.
    expect(EXPIRED_CREDENTIALS().toLowerCase()).toContain('token is expired');
    expect(NO_CREDENTIALS().toLowerCase()).not.toContain('token is expired');
    // DA1.29 — the not-found PAIR is load-bearing in the same way, and it is the
    // only channel that reaches the auth retry on the Anthropic route. Both
    // words, over the whole built sentence, so a path that happened to contain
    // one of them could not stand in for it.
    expect(NO_CREDENTIALS().toLowerCase()).toContain('nessy gateway');
    expect(NO_CREDENTIALS().toLowerCase()).toContain('credentials not found');
  });
});

/**
 * Review R6 (2026-09-17) — the parenthetical NAMES THE FILE THE GATE READ.
 *
 * Both sentences hard-coded `(~/.nessy/dp_auth_creds.json)` while
 * `../nestor-auth.ts` symbol `defaultCredsPath` has honoured an absolute
 * `NESSY_HOME` since DA1.5. On a relocated install the gate read one file and
 * told the user to look in another — and this sentence reaches the user, not a
 * log: `processEvent`'s `case 'error'` appends it verbatim as a chat error row
 * once `attemptAuthRetry` has given up.
 *
 * The arm is driven with `NESSY_HOME` SET, which is the half `withHomeCreds`
 * cannot cover: that helper deletes the variable on purpose (DA1.36) so the rest
 * of the file exercises the latch. Here the variable is set to a temp directory
 * and the creds file is written INSIDE it, so a 401 that names the latched
 * `~/.nessy` instead would mean the gate and the sentence had parted company
 * again. `delete` first, then assign, on the restore path too (AGENTS.md
 * section Traps: an assignment to a pre-created slot is invisible to a spread).
 */
describe('review R6 · the 401 parenthetical follows NESSY_HOME', () => {
  test('(pos + neg) a relocated home is named, and the default path is not', async () => {
    const relocated = mkdtempSync(join(tmpdir(), 'r6-nessy-home-'));
    const saved = process.env.NESSY_HOME;
    delete process.env.NESSY_HOME;
    process.env.NESSY_HOME = relocated;
    // Control for the fixture: the resolver must actually have moved, or every
    // assertion below is about the default path under another name.
    expect(defaultCredsPath()).toBe(join(relocated, 'dp_auth_creds.json'));
    try {
      const adapter = await startAdapter({ fetchImpl: upstreamAlwaysOk });
      try {
        // No creds file was written into the relocated directory, so the gate
        // refuses with the not-found sentence.
        const { status, json } = await post(adapter.port, '/v1/responses', RESPONSES_BODY);
        expect(status).toBe(401);
        const message = (json as unknown as { error: { message: string } }).error.message;

        expect(message).toContain(relocated);
        // The negative half, and the one that was RED before this fix: the
        // sentence must not name the un-relocated default any more.
        expect(message).not.toContain('~/.nessy/dp_auth_creds.json');
        // The classifier substrings survive the relocation.
        expect(message.toLowerCase()).toContain('nessy gateway');
        expect(message.toLowerCase()).toContain('credentials not found');
      } finally {
        await adapter.close();
      }
    } finally {
      delete process.env.NESSY_HOME;
      if (saved !== undefined) process.env.NESSY_HOME = saved;
      rmSync(relocated, { recursive: true, force: true });
    }
  });
});
