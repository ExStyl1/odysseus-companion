/**
 * F1.366 — the NARROW fallback onto dp's own stored session (owner 2026-09-23).
 *
 * `dp auth print-token` stays the primary path, as in nessy-cli. Only when OUR
 * spawn of it fails for a reason other than needs-login (dp not found, an exec
 * failure, a timeout, an update banner breaking the parse) does the facade read
 * dp's session file — read-only, the `subject.type: user` entry's access token
 * only, strict shape, a 5-minute margin — and exchange it ONCE. Every rule in
 * the row note is an arm below.
 *
 * SAFETY: every session file here is a FIXTURE in a temp dir built from random
 * bytes; the real `~/.dp` is never read, and no token value is ever printed —
 * assertions compare values, they never log them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STORED_SESSION_FALLBACK_CODES,
  STORED_SESSION_MIN_VALIDITY_MS,
  defaultDpSessionFilePath,
  readStoredDpAccessToken,
} from '../dp-session-file.ts';
import { DpAuthError, DpAuthServiceError, ensureNessyGatewayAuth, type GatewayAuthStatus } from '../index.ts';
import { NESSY_DP_AUTH_TOKEN_ENV } from '../env-token.ts';
import { createDpSessionBroker } from '../session-broker.ts';
import { clearDemotedDpBinaries } from '../dp-binary.ts';
import { createFakeDp } from './fake-dp.ts';
import { startStubExchangeServer, type StubServer } from './stub-exchange-server.ts';
import { makeTestJwt } from './test-jwt.ts';

const HOUR = 60 * 60_000;

/** An Ory-shaped value built from random bytes — never a real token. */
const fakeOry = (kind: 'at' | 'rt'): string => `ory_${kind}_${randomBytes(24).toString('base64url')}`;

interface EntryOverrides {
  subjectType?: string;
  expiresInMs?: number;
  createdAgoMs?: number;
  extra?: Record<string, unknown>;
  drop?: string;
}

function entry(over: EntryOverrides = {}): { value: Record<string, unknown>; token: string; refresh: string } {
  const now = Date.now();
  const token = fakeOry('at');
  const refresh = fakeOry('rt');
  const value: Record<string, unknown> = {
    token,
    refresh_token: refresh,
    created_at: new Date(now - (over.createdAgoMs ?? 60_000)).toISOString(),
    expires_at: new Date(now + (over.expiresInMs ?? HOUR)).toISOString(),
    refresh_expires_at: new Date(now + 30 * 24 * HOUR).toISOString(),
    subject: { id: randomBytes(8).toString('hex'), type: over.subjectType ?? 'user', name: 'fixture@example.invalid' },
    type: 'bearer',
    ...over.extra,
  };
  if (over.drop) delete value[over.drop];
  return { value, token, refresh };
}

function sessionFile(entries: Array<Record<string, unknown>>, top: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'dp-session-fixture-'));
  const path = join(dir, 'access_token.json');
  writeFileSync(path, JSON.stringify({ tokens: entries, ...top }), { mode: 0o600 });
  return path;
}

describe('readStoredDpAccessToken — the rules, one arm each', () => {
  it('takes the user entry access token and nothing else (rule 3)', async () => {
    const user = entry();
    const read = await readStoredDpAccessToken(sessionFile([user.value]));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.token === user.token).toBe(true);
    // The refresh token and every other field are gone: the result carries two keys.
    expect(Object.keys(read).sort()).toEqual(['expiresAtMs', 'ok', 'token']);
    expect(JSON.stringify(read).includes(user.refresh)).toBe(false);
  });

  it('(boundary) a service-account-only file is not used (rule 3)', async () => {
    const read = await readStoredDpAccessToken(sessionFile([entry({ subjectType: 'service_account' }).value]));
    expect(read).toEqual({ ok: false, reason: 'no-user-entry' });
  });

  it('prefers the most recently created user entry beside a service account', async () => {
    const older = entry({ createdAgoMs: 10 * 60_000 });
    const newer = entry({ createdAgoMs: 60_000 });
    const service = entry({ subjectType: 'service_account', createdAgoMs: 0 });
    const read = await readStoredDpAccessToken(sessionFile([older.value, service.value, newer.value]));
    expect(read.ok && read.token === newer.token).toBe(true);
  });

  it('an access token with less than 5 minutes left is not used (rule 5)', async () => {
    const soon = entry({ expiresInMs: STORED_SESSION_MIN_VALIDITY_MS - 30_000 });
    expect(await readStoredDpAccessToken(sessionFile([soon.value]))).toEqual({ ok: false, reason: 'expiring' });
    const expired = entry({ expiresInMs: -HOUR });
    expect(await readStoredDpAccessToken(sessionFile([expired.value]))).toEqual({ ok: false, reason: 'expiring' });
  });

  it('strict shape: a missing key, an eighth key, a bad timestamp or an extra top-level key is declined (rule 4)', async () => {
    const cases: Array<[string, string]> = [
      ['missing refresh_expires_at', sessionFile([entry({ drop: 'refresh_expires_at' }).value])],
      ['an eighth key', sessionFile([entry({ extra: { scope: 'x' } }).value])],
      ['a non-timestamp expires_at', sessionFile([entry({ extra: { expires_at: 'soon' } }).value])],
      ['a subject with a fourth key', sessionFile([entry({ extra: { subject: { id: 'a', type: 'user', name: 'n', role: 'r' } } }).value])],
      ['an extra top-level key', sessionFile([entry().value], { version: 2 })],
    ];
    for (const [label, path] of cases) {
      expect({ label, read: await readStoredDpAccessToken(path) }).toEqual({ label, read: { ok: false, reason: 'shape' } });
    }
  });

  it('a logged-out file ({"tokens":[]}) is not a session', async () => {
    expect(await readStoredDpAccessToken(sessionFile([]))).toEqual({ ok: false, reason: 'no-user-entry' });
  });

  it('an absent file is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-session-absent-'));
    expect(await readStoredDpAccessToken(join(dir, 'access_token.json'))).toEqual({ ok: false, reason: 'absent' });
  });

  it('a torn read retries ONCE (rule 5)', async () => {
    const user = entry();
    const whole = JSON.stringify({ tokens: [user.value] });
    const reads: string[] = [];
    const recovered = await readStoredDpAccessToken('/fixture/access_token.json', {
      retryDelayMs: 1,
      readFile: (path) => {
        reads.push(path);
        return reads.length === 1 ? whole.slice(0, 40) : whole;
      },
    });
    expect(reads).toHaveLength(2);
    expect(recovered.ok && recovered.token === user.token).toBe(true);

    let calls = 0;
    const torn = await readStoredDpAccessToken('/fixture/access_token.json', {
      retryDelayMs: 1,
      readFile: () => {
        calls += 1;
        return whole.slice(0, 40);
      },
    });
    expect({ calls, torn }).toEqual({ calls: 2, torn: { ok: false, reason: 'unreadable' } });
  });

  it('READ-ONLY: the file keeps its bytes and mtime, and nothing appears beside it (rule 2)', async () => {
    const path = sessionFile([entry().value]);
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    await readStoredDpAccessToken(path);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(readdirSync(join(path, '..'))).toEqual(['access_token.json']);
  });

  it('the file sits in DP_WORKDIR when set, else in ~/.dp of the latched home', () => {
    expect(defaultDpSessionFilePath({ DP_WORKDIR: '/tmp/dp-elsewhere' }, '/home/fixture')).toBe('/tmp/dp-elsewhere/access_token.json');
    expect(defaultDpSessionFilePath({}, '/home/fixture')).toBe('/home/fixture/.dp/access_token.json');
  });

  it('only a non-login failure of the print-token path opens the fallback (rule 1)', () => {
    expect([...STORED_SESSION_FALLBACK_CODES].sort()).toEqual(
      [DpAuthError.DpNotFound, DpAuthError.ExecFailed, DpAuthError.Timeout].sort(),
    );
  });
});

/**
 * The facade arms — the row's CONTROLS, end to end through the real broker and
 * a stub exchange server, with a fake dp standing in for each failure.
 */
describe('ensureNessyGatewayAuth falls back onto the stored dp session (F1.366)', () => {
  let dir: string;
  let credsPath: string;
  let stub: StubServer;
  let origEnvToken: string | undefined;
  const jwt = makeTestJwt({ preferred_username: 'stored.session', sub: 'u-stored' });

  beforeEach(async () => {
    clearDemotedDpBinaries();
    origEnvToken = process.env[NESSY_DP_AUTH_TOKEN_ENV];
    delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
    dir = mkdtempSync(join(tmpdir(), 'nessy-f1366-'));
    credsPath = join(dir, 'dp_auth_creds.json');
    stub = await startStubExchangeServer({ jwt });
  });
  afterEach(async () => {
    if (origEnvToken === undefined) delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
    else process.env[NESSY_DP_AUTH_TOKEN_ENV] = origEnvToken;
    await stub.close();
  });

  /** A dp whose X bit is set and which cannot exec (ENOEXEC) — the DA1.77 fixture. */
  function deadDp(): string {
    const path = join(mkdtempSync(join(tmpdir(), 'dead-dp-')), 'dp');
    writeFileSync(path, '');
    chmodSync(path, 0o755);
    return path;
  }

  async function run(binary: string, sessionPath: string, readFile?: (path: string) => string) {
    const statuses: GatewayAuthStatus[] = [];
    const outcome = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath: join(dir, 'oauth_creds.json'), // absent — no seed
      exchangeUrl: stub.url,
      forceRefresh: true,
      sessionBroker: createDpSessionBroker({ resolveBinary: () => binary }),
      dpSessionFile: { path: sessionPath, readFile },
      onStatus: (s) => statuses.push(s),
    }).then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: undefined, error }),
    );
    return { ...outcome, statuses };
  }

  it('(+) a dp that fails to exec + a fresh user entry → ONE exchange, the JWT saved, the note emitted', async () => {
    const user = entry();
    const { result, error, statuses } = await run(deadDp(), sessionFile([user.value]));

    expect(error).toBeUndefined();
    expect(result?.jwt).toBe(jwt);
    expect(stub.requestCount()).toBe(1);
    expect(stub.authTokens.length === 1 && stub.authTokens[0] === user.token).toBe(true);
    expect(JSON.parse(readFileSync(credsPath, 'utf-8')).jwt).toBe(jwt);
    // Rule 6 — the user is TOLD the stored session was used.
    expect(statuses).toContain('dp-session-file');
    expect(statuses[statuses.length - 1]).toBe('done');
  });

  it('(+) an update banner breaking the print-token parse is a non-login failure too', async () => {
    const user = entry();
    const fake = createFakeDp({ loggedIn: true, printTokenStdoutBanner: 'a new Spirit CLI version is available' });
    const { result, statuses } = await run(fake.binary, sessionFile([user.value]));

    expect(result?.jwt).toBe(jwt);
    expect(statuses).toContain('dp-session-file');
    expect(stub.authTokens.length === 1 && stub.authTokens[0] === user.token).toBe(true);
  });

  it('(-) a dp answering needs-login → the file is NEVER read, and the ordinary login path runs', async () => {
    const fake = createFakeDp({ loggedIn: false, failLogin: true });
    const reads: string[] = [];
    const { error, statuses } = await run(fake.binary, sessionFile([entry().value]), (path) => {
      reads.push(path);
      return readFileSync(path, 'utf-8');
    });

    expect(reads).toEqual([]);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.LoginFailed);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(statuses).not.toContain('dp-session-file');
    expect(stub.requestCount()).toBe(0);
  });

  it('(-) an expired or a malformed file → the ORDINARY error, and the file untouched', async () => {
    for (const path of [
      sessionFile([entry({ expiresInMs: -HOUR }).value]),
      sessionFile([entry({ extra: { scope: 'x' } }).value]),
    ]) {
      const bytes = readFileSync(path);
      const mtime = statSync(path).mtimeMs;
      const { error, statuses } = await run(deadDp(), path);

      expect(error).toBeInstanceOf(DpAuthServiceError);
      expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExecFailed);
      expect(statuses).not.toContain('dp-session-file');
      expect(readFileSync(path).equals(bytes)).toBe(true);
      expect(statuses.includes('exchanging')).toBe(false);
      expect(statSync(path).mtimeMs).toBe(mtime);
    }
    expect(stub.requestCount()).toBe(0);
  });

  it('(boundary) a service-account-only file → not used', async () => {
    const { error } = await run(deadDp(), sessionFile([entry({ subjectType: 'service_account' }).value]));
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExecFailed);
    expect(stub.requestCount()).toBe(0);
  });

  it('ONE exchange: when the stored token is rejected, the ORIGINAL failure is what the caller gets', async () => {
    await stub.close();
    stub = await startStubExchangeServer({ status: 401 });
    const { error, statuses } = await run(deadDp(), sessionFile([entry().value]));

    expect(stub.requestCount()).toBe(1);
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExecFailed);
    expect(statuses[statuses.length - 1]).toBe(`error:${DpAuthError.ExecFailed}`);
    expect(existsSync(credsPath)).toBe(false);
  });
});
