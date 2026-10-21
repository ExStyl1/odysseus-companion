import { describe, it, expect } from 'bun:test';
import { isJwtShaped, isUsableJwt, decodeJwtClaims } from '../jwt.ts';
import { DpAuthError, DpAuthServiceError } from '../errors.ts';
import { makeTestJwt } from './test-jwt.ts';

describe('isJwtShaped — the cheap structural gate, unchanged by DA1.26', () => {
  it('accepts three non-empty dot segments, whatever they contain', () => {
    expect(isJwtShaped('a.b.c')).toBe(true);
    expect(isJwtShaped(makeTestJwt({}))).toBe(true);
  });

  it('rejects anything that is not three non-empty segments', () => {
    expect(isJwtShaped('a.b')).toBe(false);
    expect(isJwtShaped('a.b.c.d')).toBe(false);
    expect(isJwtShaped('a..c')).toBe(false);
    expect(isJwtShaped('')).toBe(false);
  });
});

describe('isUsableJwt — DA1.26, the gate for a value about to be sent upstream', () => {
  it('accepts a real-shaped token with decodable claims', () => {
    expect(isUsableJwt(makeTestJwt({ preferred_username: 'u', sub: '1' }))).toBe(true);
  });

  it('REFUSES a.b.c — structurally fine, not a JWT', () => {
    // The whole row: `isJwtShaped` says true here, and this value leaving the
    // machine as `Nestor-Token` is an unfixable 401 loop.
    expect(isJwtShaped('a.b.c')).toBe(true);
    expect(isUsableJwt('a.b.c')).toBe(false);
  });

  it('refuses a base64url payload that is not JSON', () => {
    // 'head'.'payload'.'sig' — every segment decodes, none of it is an object.
    expect(isUsableJwt('aGVhZA.cGF5bG9hZA.c2ln')).toBe(false);
  });

  it('refuses a decodable payload with no numeric exp', () => {
    const noExp = Buffer.from(JSON.stringify({ preferred_username: 'u' })).toString('base64url');
    const stringExp = Buffer.from(JSON.stringify({ exp: '123' })).toString('base64url');
    expect(isUsableJwt(`aGVhZA.${noExp}.sig`)).toBe(false);
    expect(isUsableJwt(`aGVhZA.${stringExp}.sig`)).toBe(false);
  });

  it('does NOT judge expiry — an expired but decodable token is still usable-shaped', () => {
    // The boundary that keeps a re-mintable credential distinguishable from a
    // malformed one: expiry is the caller's check against its own clock.
    const expired = makeTestJwt({ exp: Math.floor(Date.now() / 1000) - 3_600 });
    expect(isUsableJwt(expired)).toBe(true);
  });

  it('is decodeJwtClaims own predicate, so the two can never disagree', () => {
    for (const value of ['a.b.c', 'aGVhZA.cGF5bG9hZA.c2ln', 'a.b']) {
      let threw = false;
      try {
        decodeJwtClaims(value);
      } catch (error) {
        threw = true;
        expect(error).toBeInstanceOf(DpAuthServiceError);
        expect((error as DpAuthServiceError).code).toBe(DpAuthError.ExchangeFailed);
      }
      expect(threw).toBe(true);
      expect(isUsableJwt(value)).toBe(false);
    }
  });
});
