import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNessyGatewayAuth, type GatewayAuthStatus } from '../index.ts';
import { NESSY_DP_AUTH_TOKEN_ENV } from '../env-token.ts';
import { createFakeDp } from './fake-dp.ts';
import { startStubExchangeServer, type StubServer } from './stub-exchange-server.ts';
import { makeTestJwt } from './test-jwt.ts';

// End-to-end: fake dp executable + local stub for /api/v2/token. No real
// gateway, no real browser, runs fully offline.

let origPath: string | undefined;
let origEnvToken: string | undefined;
let credsPath: string;
let oauthCredsPath: string;
let stub: StubServer;
const jwt = makeTestJwt({ preferred_username: 'e2e.user', sub: 'u-e2e' });

beforeEach(async () => {
  origPath = process.env.PATH;
  origEnvToken = process.env[NESSY_DP_AUTH_TOKEN_ENV];
  delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
  const dir = mkdtempSync(join(tmpdir(), 'nessy-e2e-'));
  credsPath = join(dir, 'dp_auth_creds.json');
  // Guaranteed absent unless a test writes to it — keeps the oauth-seed step
  // (T6) from reading the real ~/.nessy/oauth_creds.json on a dev machine.
  oauthCredsPath = join(dir, 'oauth_creds.json');
  stub = await startStubExchangeServer({ jwt });
});

afterEach(async () => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origEnvToken === undefined) delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
  else process.env[NESSY_DP_AUTH_TOKEN_ENV] = origEnvToken;
  await stub.close();
});

function usePath(dir: string): void {
  process.env.PATH = `${dir}:${origPath ?? ''}`;
}

describe('gateway auth e2e', () => {
  it('cold path: login → exchange → creds file (0600, correct shape), statuses in order', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'cold-dp-token' });
    usePath(fake.dir);
    const statuses: GatewayAuthStatus[] = [];

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath,
      exchangeUrl: stub.url,
      onStatus: (s) => statuses.push(s),
    });

    expect(result.jwt).toBe(jwt);
    expect(result.username).toBe('e2e.user');
    expect(statuses).toEqual(['checking', 'waiting-browser', 'exchanging', 'done']);

    expect(existsSync(credsPath)).toBe(true);
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(Object.keys(written).sort()).toEqual(['expiresAt', 'jwt', 'userId', 'username']);
    expect(written.username).toBe('e2e.user');
    expect(written.userId).toBe('u-e2e');
    expect(typeof written.expiresAt).toBe('number');

    expect(fake.countCalls('auth login')).toBe(1);
    expect(stub.authTokens).toEqual(['cold-dp-token']);
  });

  it('warm path: valid creds resolve with ZERO dp invocations and no exchange', async () => {
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

  it('env path: NESSY_DP_AUTH_TOKEN skips dp, exchanges the env token, writes no file', async () => {
    const fake = createFakeDp({ loggedIn: false });
    usePath(fake.dir);
    process.env[NESSY_DP_AUTH_TOKEN_ENV] = 'delegated-token';

    const result = await ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url });

    expect(result.jwt).toBe(jwt);
    expect(fake.calls()).toEqual([]);
    expect(stub.authTokens).toEqual(['delegated-token']);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('expired file behaves as cold path and preserves cachedModels across the rewrite', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'refresh-token' });
    usePath(fake.dir);
    writeFileSync(
      credsPath,
      JSON.stringify({
        jwt: 'old-jwt',
        expiresAt: Date.now() - 1000, // expired
        username: 'old',
        userId: 'old',
        cachedModels: [{ id: 'cached-model' }],
      }),
    );

    const result = await ensureNessyGatewayAuth({ credsPath, oauthCredsPath, exchangeUrl: stub.url });

    expect(result.jwt).toBe(jwt);
    expect(fake.countCalls('auth login')).toBe(1); // re-logged in
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written.jwt).toBe(jwt);
    expect(written.cachedModels).toEqual([{ id: 'cached-model' }]); // survived
  });

  it('malformed creds file follows the mocked cold-login path and is replaced safely', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'malformed-refresh-token' });
    usePath(fake.dir);
    writeFileSync(credsPath, '{ malformed json');
    const statuses: GatewayAuthStatus[] = [];

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath,
      exchangeUrl: stub.url,
      onStatus: (status) => statuses.push(status),
    });

    expect(result.jwt).toBe(jwt);
    expect(statuses).toEqual(['checking', 'waiting-browser', 'exchanging', 'done']);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(stub.authTokens).toEqual(['malformed-refresh-token']);
    const written = JSON.parse(readFileSync(credsPath, 'utf-8'));
    expect(written).toMatchObject({ jwt, username: 'e2e.user', userId: 'u-e2e' });
    expect(statSync(credsPath).mode & 0o777).toBe(0o600);
  });

  it('concurrency: two parallel ensure() run one dp login', async () => {
    const fake = createFakeDp({ loggedIn: false, token: 'concurrent' });
    usePath(fake.dir);

    const [a, b] = await Promise.all([
      ensureNessyGatewayAuth({ credsPath, oauthCredsPath, exchangeUrl: stub.url }),
      ensureNessyGatewayAuth({ credsPath, oauthCredsPath, exchangeUrl: stub.url }),
    ]);

    expect(a.jwt).toBe(jwt);
    expect(b.jwt).toBe(jwt);
    expect(fake.countCalls('auth login')).toBe(1);
    expect(stub.requestCount()).toBe(1);
  });
});
