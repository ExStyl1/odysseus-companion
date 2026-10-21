import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureNessyGatewayAuth,
  DpAuthError,
  DpAuthServiceError,
  type GatewayAuthStatus,
} from '../index.ts';
import { NESSY_DP_AUTH_TOKEN_ENV } from '../env-token.ts';
import { createDpSessionBroker, type DpSessionBroker } from '../session-broker.ts';
import { createFakeDp } from './fake-dp.ts';
import { startStubExchangeServer, type StubServer } from './stub-exchange-server.ts';
import { makeTestJwt } from './test-jwt.ts';

let origPath: string | undefined;
let origEnvToken: string | undefined;
let dir: string;
let credsPath: string;
let stub: StubServer;
const jwt = makeTestJwt({ preferred_username: 'flow.user', sub: 'u-flow' });

beforeEach(async () => {
  origPath = process.env.PATH;
  origEnvToken = process.env[NESSY_DP_AUTH_TOKEN_ENV];
  delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
  dir = mkdtempSync(join(tmpdir(), 'nessy-facade-'));
  credsPath = join(dir, 'dp_auth_creds.json');
  stub = await startStubExchangeServer({ jwt });
});

afterEach(async () => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origEnvToken === undefined) delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
  else process.env[NESSY_DP_AUTH_TOKEN_ENV] = origEnvToken;
  await stub.close();
});

function usePath(fakeDir: string): void {
  process.env.PATH = `${fakeDir}:${origPath ?? ''}`;
}

/** Writes a nessy-cli-shaped `oauth_creds.json` fixture and returns its path. */
function writeOauthFixture(jwtValue: string, extra: Record<string, unknown> = {}): string {
  const p = join(dir, 'oauth_creds.json');
  writeFileSync(
    p,
    JSON.stringify({
      access_token: jwtValue,
      expiry_date: Date.now() + 86_400_000,
      token_type: 'Bearer',
      ...extra,
    }),
  );
  return p;
}

/** A broker whose every method throws — proves the seed path never reaches it. */
const throwingBroker: DpSessionBroker = {
  async probe() {
    throw new Error('sessionBroker.probe should not be called when the oauth seed is valid');
  },
  async ensure() {
    throw new Error('sessionBroker.ensure should not be called when the oauth seed is valid');
  },
  async withAccessToken() {
    throw new Error('sessionBroker.withAccessToken should not be called when the oauth seed is valid');
  },
  subscribe() {
    return () => {};
  },
  cancel() {
    return false;
  },
  dispose() {},
};

describe('ensureNessyGatewayAuth', () => {
  it('cold path: login → exchange → creds written, statuses in order', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'cold-token' });
    usePath(fake.dir);
    const statuses: GatewayAuthStatus[] = [];

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath: join(dir, 'oauth_creds.json'), // absent — no seed
      exchangeUrl: stub.url,
      onStatus: (s) => statuses.push(s),
    });

    expect(result.jwt).toBe(jwt);
    expect(result.username).toBe('flow.user');
    expect(statuses).toEqual(['checking', 'waiting-browser', 'exchanging', 'done']);
    // dp token (not the env value) was exchanged
    expect(stub.authTokens).toEqual(['cold-token']);
    // creds persisted with the CLI-compatible shape
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(Object.keys(written).sort()).toEqual(['expiresAt', 'jwt', 'userId', 'username']);
    expect(written.jwt).toBe(jwt);
    expect(fake.countCalls('auth login')).toBe(1);
  });

  it('routes the raw DP cold path through an injected session broker', async () => {
    const fake = createFakeDp({ loggedIn: true, token: 'broker-token' });

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath: join(dir, 'oauth_creds.json'), // absent — no seed
      exchangeUrl: stub.url,
      sessionBroker: createDpSessionBroker({
        resolveBinary: () => fake.binary,
      }),
    });

    expect(result.jwt).toBe(jwt);
    expect(stub.authTokens).toEqual(['broker-token']);
    expect(fake.countCalls('auth login')).toBe(0);
  });

  it('warm path: valid creds resolve with ZERO dp invocations', async () => {
    const fake = createFakeDp({ loggedIn: true });
    usePath(fake.dir);
    const warmJwt = makeTestJwt({ preferred_username: 'w', sub: 'wi' });
    writeFileSync(
      credsPath,
      JSON.stringify({ jwt: warmJwt, expiresAt: Date.now() + 1_000_000, username: 'w', userId: 'wi' }),
    );

    const result = await ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url });

    expect(result.jwt).toBe(warmJwt);
    expect(fake.calls()).toEqual([]);
    expect(stub.requestCount()).toBe(0);
  });

  it('DA1.26: a cached credential that is NOT a decodable jwt re-mints instead of being returned', async () => {
    // `a.b.c` passes `isJwtShaped`; sent as `Nestor-Token` it is a 401 nothing
    // in the product can break, because the warm path succeeded and this facade
    // is never re-entered. Refusing it falls through to the dp flow, which is
    // what "signed out" means.
    //
    // DA1.50 moved WHERE the refusal happens and this arm deliberately still
    // asserts the same outcome. When DA1.26 wrote it, `getValidCreds` handed the
    // value back and the check below in this facade was the only thing refusing
    // it; `getValidCreds` now gates on `isUsableJwt` itself, so the facade's
    // check is a second line rather than the first. The arm is kept — and kept
    // worded this way — because it pins the USER-VISIBLE contract (a cached
    // non-decodable credential re-mints and is erased from the file) rather than
    // which of the two gates did it, and that contract must survive either one
    // being changed.
    const fake = createFakeDp({ loggedIn: true, token: 'remint-token' });
    usePath(fake.dir);
    writeFileSync(
      credsPath,
      JSON.stringify({ jwt: 'a.b.c', expiresAt: Date.now() + 1_000_000, username: 'u', userId: 'i' }),
    );

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath: join(dir, 'oauth_creds.json'), // absent — no seed
      exchangeUrl: stub.url,
    });

    expect(result.jwt).toBe(jwt);
    expect(result.jwt).not.toBe('a.b.c');
    expect(stub.authTokens).toEqual(['remint-token']);
    // The unusable value is GONE from the file, not merely bypassed in memory.
    expect(JSON.parse(readFileSync(credsPath, 'utf-8')).jwt).toBe(jwt);
  });

  it('DA1.26 control: the SAME flow keeps a decodable cached jwt and never execs dp', async () => {
    // Without this arm the one above would also pass against a warm path that
    // had simply stopped working. Same file, same expiry, decodable jwt.
    const fake = createFakeDp({ loggedIn: true, token: 'should-not-run' });
    usePath(fake.dir);
    const warmJwt = makeTestJwt({ preferred_username: 'warm', sub: 'warm-id' });
    writeFileSync(
      credsPath,
      JSON.stringify({ jwt: warmJwt, expiresAt: Date.now() + 1_000_000, username: 'warm', userId: 'warm-id' }),
    );

    const result = await ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url });

    expect(result.jwt).toBe(warmJwt);
    expect(fake.calls()).toEqual([]);
    expect(stub.requestCount()).toBe(0);
  });

  it('forceRefresh skips warm cached creds and re-mints through dp', async () => {
    // A well-formed, unexpired cached jwt that the gateway has REJECTED
    // server-side (the 401-retry scenario) must not win: forceRefresh skips
    // the warm path and re-mints through dp, yielding a DIFFERENT jwt.
    const fake = createFakeDp({ loggedIn: true, token: 'force-refresh-token' });
    usePath(fake.dir);
    const staleJwt = makeTestJwt({ preferred_username: 'stale', sub: 'stale-id' });
    writeFileSync(
      credsPath,
      JSON.stringify({ jwt: staleJwt, expiresAt: Date.now() + 1_000_000, username: 'stale', userId: 'stale-id' }),
    );

    const result = await ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url, forceRefresh: true });

    expect(result.jwt).toBe(jwt);
    expect(result.jwt).not.toBe(staleJwt);
    expect(stub.authTokens).toEqual(['force-refresh-token']);
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written.jwt).toBe(jwt);
  });

  it('warm miss + valid cli oauth seed: returns seeded jwt and persists it to our creds file', async () => {
    // credsPath's file is absent (warm path misses) but nessy-cli's
    // oauth_creds.json carries a fresh Nestor-shaped token.
    const seedJwt = makeTestJwt({ preferred_username: 'seed.user', sub: 'seed-id' });
    const oauthCredsPath = writeOauthFixture(seedJwt);

    const result = await ensureNessyGatewayAuth({ credsPath, oauthCredsPath, sessionBroker: throwingBroker });

    expect(result.jwt).toBe(seedJwt);
    expect(result.username).toBe('seed.user');
    // seeded into OUR file — every other reader still has one file to read
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written.jwt).toBe(seedJwt);
  });

  it('forceRefresh skips the oauth seed and goes to dp', async () => {
    // A just-rejected token means "mint fresh through dp", not "try another
    // cache" — the cli's oauth seed must not win under forceRefresh either.
    const seedJwt = makeTestJwt({ preferred_username: 'seed2.user', sub: 'seed2-id' });
    const oauthCredsPath = writeOauthFixture(seedJwt);
    const fake = createFakeDp({ loggedIn: true, token: 'force-refresh-oauth-token' });
    usePath(fake.dir);

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath,
      forceRefresh: true,
      exchangeUrl: stub.url,
    });

    expect(result.jwt).toBe(jwt);
    expect(result.jwt).not.toBe(seedJwt);
    expect(stub.authTokens).toEqual(['force-refresh-oauth-token']);
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written.jwt).toBe(jwt);
  });

  it('concurrency: two parallel calls run dp login once', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'concurrent-token' });
    usePath(fake.dir);

    const noSeed = join(dir, 'oauth_creds.json'); // absent — no seed
    const [a, b] = await Promise.all([
      ensureNessyGatewayAuth({ credsPath, oauthCredsPath: noSeed, exchangeUrl: stub.url }),
      ensureNessyGatewayAuth({ credsPath, oauthCredsPath: noSeed, exchangeUrl: stub.url }),
    ]);

    expect(a.jwt).toBe(jwt);
    expect(b.jwt).toBe(jwt);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(stub.requestCount()).toBe(1);
  });

  it('forceRefresh arriving during a warm in-flight run re-mints instead of joining it', async () => {
    // DA1.1: the join used to answer the forced caller with the warm run's
    // CACHED jwt — precisely the token a gateway 401 has just rejected. Both
    // calls are issued in the same tick, so the warm run already owns the
    // single-flight slot when the forced one arrives.
    const fake = createFakeDp({ loggedIn: true, token: 'after-warm-token' });
    usePath(fake.dir);
    const warmJwt = makeTestJwt({ preferred_username: 'warm', sub: 'warm-id' });
    writeFileSync(
      credsPath,
      JSON.stringify({ jwt: warmJwt, expiresAt: Date.now() + 1_000_000, username: 'warm', userId: 'warm-id' }),
    );

    const warm = ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url });
    const forced = ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url, forceRefresh: true });

    // the non-forced caller keeps today's semantics: it gets the warm jwt
    expect((await warm).jwt).toBe(warmJwt);

    const result = await forced;
    expect(result.jwt).toBe(jwt);
    expect(result.jwt).not.toBe(warmJwt);
    // the dp exchange ran for the forced caller, exactly once
    expect(stub.authTokens).toEqual(['after-warm-token']);
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written.jwt).toBe(jwt);
  });

  it('two concurrent forceRefresh callers share ONE forced run', async () => {
    // The boundary of the same fix: forced callers must still coalesce, or a
    // 401 retry racing the Sign-in click would mint twice and could open two
    // browser logins.
    const fake = createFakeDp({ loggedIn: true, token: 'shared-forced-token' });
    usePath(fake.dir);
    const noSeed = join(dir, 'oauth_creds.json'); // absent — no seed

    const [a, b] = await Promise.all([
      ensureNessyGatewayAuth({ credsPath, oauthCredsPath: noSeed, exchangeUrl: stub.url, forceRefresh: true }),
      ensureNessyGatewayAuth({ credsPath, oauthCredsPath: noSeed, exchangeUrl: stub.url, forceRefresh: true }),
    ]);

    expect(a.jwt).toBe(jwt);
    expect(b.jwt).toBe(jwt);
    // ONE exchange, with the single dp token the shared run minted. (The
    // print-token COUNT is not the instrument here: the broker's probe spawns
    // one of its own beside the one `withAccessToken` uses.)
    expect(stub.requestCount()).toBe(1);
    expect(stub.authTokens).toEqual(['shared-forced-token']);
  });

  it('env path: NESSY_DP_AUTH_TOKEN skips dp and exchanges the env token', async () => {
    const fake = createFakeDp({ loggedIn: false });
    usePath(fake.dir);
    process.env[NESSY_DP_AUTH_TOKEN_ENV] = 'delegated-env-token';

    const result = await ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url });

    expect(result.jwt).toBe(jwt);
    expect(fake.calls()).toEqual([]);
    expect(stub.authTokens).toEqual(['delegated-env-token']);
    // env path is transient — no creds file written
    expect(existsSync(credsPath)).toBe(false);
  });

  it('non-interactive path: missing dp token does not open browser login', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'silent-token' });
    usePath(fake.dir);
    const statuses: GatewayAuthStatus[] = [];

    try {
      await ensureNessyGatewayAuth({
        credsPath,
        oauthCredsPath: join(dir, 'oauth_creds.json'), // absent — no seed
        exchangeUrl: stub.url,
        interactive: false,
        onStatus: (s) => statuses.push(s),
      });
      throw new Error('expected ensureNessyGatewayAuth to fail');
    } catch (err) {
      expect(err).toBeInstanceOf(DpAuthServiceError);
      expect((err as DpAuthServiceError).code).toBe(DpAuthError.NeedsLogin);
    }

    expect(statuses).toEqual(['checking', 'error:NeedsLogin']);
    expect(fake.countCalls('auth print-token')).toBe(1);
    expect(fake.countCalls('auth login')).toBe(0);
    expect(stub.requestCount()).toBe(0);
  });
});

/**
 * F1.2 — the facade's status ALLOW-LIST is where a new broker status reaches
 * a surface or does not; `auth-url:` must pass it (the banner, the onboarding
 * step and Settings read the facade's stream, not the broker's).
 */
describe('F1.2 · the facade relays the authorization URL', () => {
  it('forwards auth-url:<url> from the broker to its own onStatus', async () => {
    const url = 'https://as.example.invalid/oauth2/auth?state=relay';
    const statuses: GatewayAuthStatus[] = [];
    const relayingBroker: DpSessionBroker = {
      probe: async () => ({ state: 'needs-login', version: null, outdated: false }),
      ensure: async () => ({ state: 'ready', version: null, outdated: false }),
      withAccessToken: async (operation, options) => {
        options?.onStatus?.('waiting-browser');
        options?.onStatus?.(`auth-url:${url}`);
        return operation('broker-token');
      },
      subscribe: () => () => {},
      cancel: () => false,
      dispose: () => {},
    };

    await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath: join(dir, 'oauth_creds.json'), // absent — no seed
      exchangeUrl: stub.url,
      forceRefresh: true,
      sessionBroker: relayingBroker,
      onStatus: (s) => statuses.push(s),
    });

    expect(statuses).toContain(`auth-url:${url}`);
    expect(statuses.indexOf(`auth-url:${url}`)).toBeGreaterThan(statuses.indexOf('waiting-browser'));
  });
});
