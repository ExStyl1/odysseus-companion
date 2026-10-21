import { describe, it, expect } from 'bun:test';
import { exchangeDpToken } from '../exchange.ts';
import { decodeJwtClaims } from '../jwt.ts';
import { DpAuthError, DpAuthServiceError } from '../errors.ts';
import { startStubExchangeServer } from './stub-exchange-server.ts';
import { makeTestJwt } from './test-jwt.ts';

describe('exchangeDpToken', () => {
  it('exchanges the dp token and returns the jwt', async () => {
    const jwt = makeTestJwt({ preferred_username: 'a.user', sub: 'u-1' });
    const stub = await startStubExchangeServer({ jwt });
    try {
      const result = await exchangeDpToken('dp-token-value', { url: stub.url });
      expect(result.jwt).toBe(jwt);
      expect(stub.authTokens).toEqual(['dp-token-value']);
    } finally {
      await stub.close();
    }
  });

  it('maps 401 to ExchangeFailed (dp token rejected)', async () => {
    const stub = await startStubExchangeServer({ status: 401, errorBody: 'nope' });
    try {
      let error: unknown;
      try {
        await exchangeDpToken('dp-token', { url: stub.url });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DpAuthServiceError);
      expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExchangeFailed);
      expect((error as DpAuthServiceError).message).toContain('rejected');
    } finally {
      await stub.close();
    }
  });

  it('maps 500 to ExchangeFailed with the status', async () => {
    const stub = await startStubExchangeServer({ status: 500, errorBody: 'boom' });
    try {
      let error: unknown;
      try {
        await exchangeDpToken('dp-token', { url: stub.url });
      } catch (e) {
        error = e;
      }
      expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExchangeFailed);
      expect((error as DpAuthServiceError).message).toContain('500');
    } finally {
      await stub.close();
    }
  });

  it('times out a slow endpoint', async () => {
    const stub = await startStubExchangeServer({ jwt: makeTestJwt({}), delayMs: 500 });
    try {
      let error: unknown;
      try {
        await exchangeDpToken('dp-token', { url: stub.url, timeoutMs: 20 });
      } catch (e) {
        error = e;
      }
      expect((error as DpAuthServiceError).code).toBe(DpAuthError.Timeout);
    } finally {
      await stub.close();
    }
  });

  it('never leaks the token in an error message', async () => {
    const stub = await startStubExchangeServer({ status: 500, errorBody: 'server error' });
    try {
      await exchangeDpToken('super-secret-token', { url: stub.url });
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-token');
    } finally {
      await stub.close();
    }
  });
});

describe('decodeJwtClaims', () => {
  it('maps preferred_username / sub / exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 1000;
    const jwt = makeTestJwt({ preferred_username: 'jane.doe', sub: 'u-42', exp });
    const claims = decodeJwtClaims(jwt);
    expect(claims.username).toBe('jane.doe');
    expect(claims.userId).toBe('u-42');
    expect(claims.expiresAtMs).toBe(exp * 1000);
  });

  it('throws ExchangeFailed on a malformed jwt', () => {
    let error: unknown;
    try {
      decodeJwtClaims('not-a-jwt');
    } catch (e) {
      error = e;
    }
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExchangeFailed);
  });

  it('throws when exp is missing', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const noExp = `${b64({ alg: 'none' })}.${b64({ sub: 'x' })}.sig`;
    let error: unknown;
    try {
      decodeJwtClaims(noExp);
    } catch (e) {
      error = e;
    }
    expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExchangeFailed);
  });
});
