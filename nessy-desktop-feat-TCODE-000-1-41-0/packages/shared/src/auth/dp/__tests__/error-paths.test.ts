import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureNessyGatewayAuth,
  DpAuthError,
  DpAuthServiceError,
  type GatewayAuthStatus,
} from '../index.ts';
import {
  NESSY_DP_AUTH_TOKEN_ENV,
  NESSY_CLI_DP_AUTH_TOKEN_ENV,
  cliEnvTokenIsTheOnlyOne,
  diagnoseGatewayAuthFailure,
} from '../env-token.ts';
import { createFakeDp } from './fake-dp.ts';
import { startStubExchangeServer, type StubServer } from './stub-exchange-server.ts';
import { makeTestJwt } from './test-jwt.ts';

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let origPath: string | undefined;
let credsPath: string;
let oauthCredsPath: string;
let stub: StubServer;
const jwt = makeTestJwt({ preferred_username: 'err.user', sub: 'u-err' });
const DP_TOKEN = 'dp-token-SECRET-value';
const ENV_TOKEN = 'env-token-SECRET-value';

beforeEach(() => {
  origPath = process.env.PATH;
  delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
  // DA1.23 — the preload deletes this too, but a case below SETS it, and the
  // whole point of the member is that its presence changes an outcome.
  delete process.env[NESSY_CLI_DP_AUTH_TOKEN_ENV];
  const dir = mkdtempSync(join(tmpdir(), 'nessy-err-'));
  credsPath = join(dir, 'dp_auth_creds.json');
  // Guaranteed absent unless a test writes to it — keeps the oauth-seed step
  // (T6) from reading the real ~/.nessy/oauth_creds.json on a dev machine.
  oauthCredsPath = join(dir, 'oauth_creds.json');
});

afterEach(async () => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  delete process.env[NESSY_DP_AUTH_TOKEN_ENV];
  delete process.env[NESSY_CLI_DP_AUTH_TOKEN_ENV];
  if (stub) await stub.close();
});

function usePath(dir: string): void {
  process.env.PATH = `${dir}:${origPath ?? ''}`;
}

describe('exchange 401', () => {
  it('emits error:ExchangeFailed, throws, writes no creds', async () => {
    const fake = createFakeDp({ loggedIn: true, token: DP_TOKEN });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ status: 401, errorBody: 'unauthorized' });
    const statuses: GatewayAuthStatus[] = [];

    let error: unknown;
    try {
      await ensureNessyGatewayAuth({ credsPath, oauthCredsPath, exchangeUrl: stub.url, onStatus: (s) => statuses.push(s) });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(statuses).toContain(`error:${DpAuthError.ExchangeFailed}`);
    expect(existsSync(credsPath)).toBe(false);
  });
});

describe('login failure', () => {
  it('emits error:LoginFailed when dp login exits non-zero', async () => {
    // A dp that fails on `auth login` (needs-login on print-token, /usr/bin/false-like login).
    const fake = createFakeDp({ loggedIn: false, failLogin: true });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ jwt });
    const statuses: GatewayAuthStatus[] = [];

    let error: unknown;
    try {
      await ensureNessyGatewayAuth({ credsPath, oauthCredsPath, exchangeUrl: stub.url, onStatus: (s) => statuses.push(s) });
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    expect(statuses).toContain(`error:${DpAuthError.LoginFailed}`);
    expect(existsSync(credsPath)).toBe(false);
  });
});

describe('login cancel', () => {
  it('aborting during waiting-browser kills the dp child (SIGTERM), writes no creds', async () => {
    const fake = createFakeDp({ loggedIn: false, hangLogin: true });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ jwt });
    const controller = new AbortController();
    const statuses: GatewayAuthStatus[] = [];

    const p = ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath,
      exchangeUrl: stub.url,
      signal: controller.signal,
      onStatus: (s) => statuses.push(s),
    });
    // Abort once the login child is actually running.
    await waitFor(() => fake.countCalls('auth login') >= 1);
    controller.abort();

    let error: unknown;
    try {
      await p;
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(statuses).toContain(`error:${DpAuthError.Cancelled}`);
    await waitFor(() => fake.gotSigterm());
    expect(fake.gotSigterm()).toBe(true);
    expect(existsSync(credsPath)).toBe(false);
  });
});

describe('no token material leaks', () => {
  it('cold-path statuses + result never contain the dp token or jwt', async () => {
    const fake = createFakeDp({ loggedIn: false, token: DP_TOKEN });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ jwt });
    const statuses: GatewayAuthStatus[] = [];

    const result = await ensureNessyGatewayAuth({ credsPath, oauthCredsPath, exchangeUrl: stub.url, onStatus: (s) => statuses.push(s) });

    const statusBlob = JSON.stringify(statuses);
    expect(statusBlob).not.toContain(DP_TOKEN);
    // The result intentionally carries the jwt for the caller; the STATUS stream must not.
    expect(statusBlob).not.toContain(jwt);
    expect(result.jwt).toBe(jwt); // sanity — the jwt IS returned to the caller
  });

  it('error messages never contain token material', async () => {
    process.env[NESSY_DP_AUTH_TOKEN_ENV] = ENV_TOKEN;
    stub = await startStubExchangeServer({ status: 500, errorBody: 'server error' });

    let error: unknown;
    try {
      await ensureNessyGatewayAuth({ credsPath, exchangeUrl: stub.url });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const blob = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;
    expect(blob).not.toContain(ENV_TOKEN);
  });
});

describe('DpNotFound i18n', () => {
  it('the corp-IT message exists in both locales', () => {
    // dp missing → DpNotFound code → UI maps to onboarding.gatewayConnect.errorDpNotFound.
    const localesDir = join(import.meta.dir, '..', '..', '..', 'i18n', 'locales');
    const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf-8'));
    const ru = JSON.parse(readFileSync(join(localesDir, 'ru.json'), 'utf-8'));
    expect(typeof en['onboarding.gatewayConnect.errorDpNotFound']).toBe('string');
    expect(typeof ru['onboarding.gatewayConnect.errorDpNotFound']).toBe('string');
  });
});

describe('DA1.23 — the failure names the env variable the user actually set', () => {
  describe('cliEnvTokenIsTheOnlyOne', () => {
    it('is true for exactly one shape: theirs set, ours not', () => {
      expect(
        cliEnvTokenIsTheOnlyOne({ [NESSY_CLI_DP_AUTH_TOKEN_ENV]: 'their-value' }),
      ).toBe(true);
    });

    it('is false whenever ours is set too — the env path already ran and owns that failure', () => {
      expect(
        cliEnvTokenIsTheOnlyOne({
          [NESSY_CLI_DP_AUTH_TOKEN_ENV]: 'their-value',
          [NESSY_DP_AUTH_TOKEN_ENV]: 'our-value',
        }),
      ).toBe(false);
    });

    it('is false for ours alone, for neither, and for a whitespace-only theirs', () => {
      expect(cliEnvTokenIsTheOnlyOne({ [NESSY_DP_AUTH_TOKEN_ENV]: 'our-value' })).toBe(false);
      expect(cliEnvTokenIsTheOnlyOne({})).toBe(false);
      expect(cliEnvTokenIsTheOnlyOne({ [NESSY_CLI_DP_AUTH_TOKEN_ENV]: '   ' })).toBe(false);
    });
  });

  describe('diagnoseGatewayAuthFailure', () => {
    const theirsOnly = { [NESSY_CLI_DP_AUTH_TOKEN_ENV]: 'their-value' };

    it('re-codes a dp-flow failure and keeps the original code readable', () => {
      const original = new DpAuthServiceError(DpAuthError.LoginFailed, 'dp login exited 1');
      const diagnosed = diagnoseGatewayAuthFailure(original, theirsOnly);

      expect(diagnosed.code).toBe(DpAuthError.CliEnvTokenOnly);
      expect(diagnosed.message).toContain(NESSY_CLI_DP_AUTH_TOKEN_ENV);
      expect(diagnosed.message).toContain(NESSY_DP_AUTH_TOKEN_ENV);
      expect(diagnosed.message).toContain(DpAuthError.LoginFailed);
      expect(diagnosed.cause).toBe(original);
      // The detail is variable NAMES and a code — never a value, ours or theirs.
      expect(diagnosed.message).not.toContain('their-value');
    });

    // R2, owner decision 2026-09-17. The re-code used to cover EVERY member but
    // `Cancelled`; these two tables are the narrowed rule, and the `allMembers`
    // control below is what stops a future member from escaping both of them.
    const narrowed = [
      DpAuthError.DpNotFound,
      DpAuthError.NeedsLogin,
      DpAuthError.LoginFailed,
      // DA3.17. Its parent `Timeout` stays in `kept` two blocks below, and the
      // pair is the whole reason the member exists: a bucket cannot be advised,
      // one dp outcome can.
      DpAuthError.LoginBrowserTimeout,
    ] as const;

    for (const code of narrowed) {
      it(`re-codes ${code} — the env token skips dp entirely, so the advice rescues it`, () => {
        const diagnosed = diagnoseGatewayAuthFailure(
          new DpAuthServiceError(code, `dp answered ${code}`),
          theirsOnly,
        );
        expect(diagnosed.code).toBe(DpAuthError.CliEnvTokenOnly);
        expect(diagnosed.message).toContain(code);
      });
    }

    // One NEGATIVE per kept code. `ExchangeFailed` is the load-bearing one:
    // `tryEnvToken` calls the same `exchangeDpToken`, so a user who took the
    // advice would land on the identical failure. `ExecFailed` and `Timeout` are
    // buckets that span the dp execs AND the exchange.
    const kept = [
      DpAuthError.ExchangeFailed,
      DpAuthError.ExecFailed,
      DpAuthError.Timeout,
      DpAuthError.InteractiveLoginUnavailable,
    ] as const;

    for (const code of kept) {
      it(`leaves ${code} alone — its own reason must still reach the card`, () => {
        const original = new DpAuthServiceError(code, `dp answered ${code}`);
        expect(diagnoseGatewayAuthFailure(original, theirsOnly)).toBe(original);
      });
    }

    it('every DpAuthError member is in exactly one of the two arms above', () => {
      // Anti-vacuum: without this, a member added later is asserted by neither
      // table and the narrowing silently stops describing the enum. Derived from
      // `Object.values`, never from a count — a number-word guard matches its own
      // successor.
      const covered = new Set<string>([
        ...narrowed,
        ...kept,
        // `CliEnvTokenOnly` is the OUTPUT of the re-code and `Cancelled` has its
        // own case below, with the reason that is older than the narrowing.
        DpAuthError.CliEnvTokenOnly,
        DpAuthError.Cancelled,
      ]);
      expect([...Object.values(DpAuthError)].filter((code) => !covered.has(code))).toEqual([]);
      expect(new Set(narrowed).size + new Set(kept).size).toBe(narrowed.length + kept.length);
      for (const code of narrowed) expect(kept as readonly DpAuthError[]).not.toContain(code);
    });

    it('leaves Cancelled alone — the cause of that one is known and is not the environment', () => {
      const cancelled = new DpAuthServiceError(DpAuthError.Cancelled, 'cancelled');
      expect(diagnoseGatewayAuthFailure(cancelled, theirsOnly)).toBe(cancelled);
    });

    it('leaves every failure alone when the variable is absent', () => {
      const original = new DpAuthServiceError(DpAuthError.LoginFailed, 'dp login exited 1');
      expect(diagnoseGatewayAuthFailure(original, {})).toBe(original);
    });
  });

  it('the facade emits and throws the new code when dp fails and only theirs is set', async () => {
    const fake = createFakeDp({ loggedIn: false, failLogin: true });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ jwt });
    process.env[NESSY_CLI_DP_AUTH_TOKEN_ENV] = 'their-value';
    const statuses: GatewayAuthStatus[] = [];

    let error: unknown;
    try {
      await ensureNessyGatewayAuth({
        credsPath,
        oauthCredsPath,
        exchangeUrl: stub.url,
        onStatus: (s) => statuses.push(s),
      });
    } catch (e) {
      error = e;
    }

    expect((error as DpAuthServiceError).code).toBe(DpAuthError.CliEnvTokenOnly);
    expect(statuses).toContain(`error:${DpAuthError.CliEnvTokenOnly}`);
    // The status the run WOULD have carried is gone, so the card cannot show
    // both — the emitted status and the thrown error come from one object.
    expect(statuses).not.toContain(`error:${DpAuthError.LoginFailed}`);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('the facade keeps ExchangeFailed on the card — the advice cannot help there', async () => {
    // The behavioural half of R2's narrowing, end to end: dp works, the exchange
    // refuses, and nessy-cli's variable is exported. Before the narrowing this
    // run reported `CliEnvTokenOnly` and the real reason was unreachable from
    // every surface the user has.
    const fake = createFakeDp({ loggedIn: true, token: DP_TOKEN });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ status: 401, errorBody: 'unauthorized' });
    process.env[NESSY_CLI_DP_AUTH_TOKEN_ENV] = 'their-value';
    const statuses: GatewayAuthStatus[] = [];

    let error: unknown;
    try {
      await ensureNessyGatewayAuth({
        credsPath,
        oauthCredsPath,
        exchangeUrl: stub.url,
        onStatus: (s) => statuses.push(s),
      });
    } catch (e) {
      error = e;
    }

    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExchangeFailed);
    expect(statuses).toContain(`error:${DpAuthError.ExchangeFailed}`);
    expect(statuses).not.toContain(`error:${DpAuthError.CliEnvTokenOnly}`);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('PRESENCE ALONE CHANGES NO OUTCOME — the same variable over a dp that works', async () => {
    // The row's own constraint, and the control for the case above: a user may
    // legitimately have exported nessy-cli's variable on this machine.
    const fake = createFakeDp({ loggedIn: true, token: DP_TOKEN });
    usePath(fake.dir);
    stub = await startStubExchangeServer({ jwt });
    process.env[NESSY_CLI_DP_AUTH_TOKEN_ENV] = 'their-value';
    const statuses: GatewayAuthStatus[] = [];

    const result = await ensureNessyGatewayAuth({
      credsPath,
      oauthCredsPath,
      exchangeUrl: stub.url,
      onStatus: (s) => statuses.push(s),
    });

    expect(result.jwt).toBe(jwt);
    expect(statuses).toContain('done');
    expect(statuses.some((s) => s.startsWith('error:'))).toBe(false);
    expect(existsSync(credsPath)).toBe(true);
  });

  it('the new code has a sentence in BOTH locales', () => {
    const localesDir = join(import.meta.dir, '..', '..', '..', 'i18n', 'locales');
    const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf-8'));
    const ru = JSON.parse(readFileSync(join(localesDir, 'ru.json'), 'utf-8'));
    const key = `chat.dpAuth.errors.${DpAuthError.CliEnvTokenOnly}`;
    expect(typeof en[key]).toBe('string');
    expect(typeof ru[key]).toBe('string');
    // A code the card cannot name is worse than no code: the card falls back to
    // the raw key. Both sentences must name the variable the user set.
    expect(en[key]).toContain(NESSY_CLI_DP_AUTH_TOKEN_ENV);
    expect(ru[key]).toContain(NESSY_CLI_DP_AUTH_TOKEN_ENV);
  });
});
