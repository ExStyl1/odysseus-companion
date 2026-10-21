/**
 * Minimal JWT claim decode (no dependency). Reads the base64url payload only —
 * signatures are validated server-side, not here.
 */

import { DpAuthError, DpAuthServiceError } from './errors.ts';

/**
 * Cheap shape check for values about to be sent as `Nestor-Token`. The creds
 * file is shared with nessy-cli and hand-edits happen; a non-JWT value there
 * must read as "signed out" (so the dp exchange re-mints and overwrites)
 * instead of being sent upstream, where it produces an unfixable
 * 401 "token contains an invalid number of segments" loop.
 */
export function isJwtShaped(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * {@link isJwtShaped} PLUS the decode the value's own consumer already performs
 * — DA1.26.
 *
 * The structural gate is three non-empty dot segments and nothing else, so
 * `a.b.c` passes it. That is a fine cheap filter for "is this obviously not a
 * token", and it is the wrong gate for "may this be sent upstream as
 * `Nestor-Token`": a value that cannot decode to an object with a numeric `exp`
 * is not a JWT, and sending it produces the same unfixable 401 loop the
 * structural gate was added to prevent — one step further in.
 *
 * The predicate is {@link decodeJwtClaims}'s own, not a second one: it requires
 * three parts, a base64url payload that parses as JSON, and `typeof exp ===
 * 'number'`, and it throws on each. Calling it is what keeps this check and the
 * decode every consumer runs a few lines later from ever disagreeing.
 *
 * It deliberately does NOT check EXPIRY. Whether a decodable token is still in
 * date is the caller's question and is answered against the caller's own clock
 * and stored `expiresAt` (`creds-store.ts` symbol `getValidCreds`); folding it
 * in here would make a re-mintable credential indistinguishable from a
 * malformed one.
 */
export function isUsableJwt(value: string): boolean {
  if (!isJwtShaped(value)) return false;
  try {
    decodeJwtClaims(value);
    return true;
  } catch {
    return false;
  }
}

export interface JwtClaims {
  username: string;
  userId: string;
  expiresAtMs: number;
}

/**
 * Decode `preferred_username` → username, `sub` → userId, `exp*1000` →
 * expiresAtMs. Malformed input → ExchangeFailed (never leaks the token).
 */
export function decodeJwtClaims(jwt: string): JwtClaims {
  const parts = jwt.split('.');
  const payloadB64 = parts[1];
  if (parts.length !== 3 || !payloadB64) {
    throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'malformed jwt (expected 3 parts)');
  }

  let payload: { preferred_username?: unknown; sub?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch {
    throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'malformed jwt payload');
  }

  if (typeof payload.exp !== 'number') {
    throw new DpAuthServiceError(DpAuthError.ExchangeFailed, 'jwt missing exp claim');
  }

  return {
    username: typeof payload.preferred_username === 'string' ? payload.preferred_username : '',
    userId: typeof payload.sub === 'string' ? payload.sub : '',
    expiresAtMs: payload.exp * 1000,
  };
}
