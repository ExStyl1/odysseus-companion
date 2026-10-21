/**
 * Build a syntactically valid (unsigned) JWT for tests. The dp-auth module
 * never verifies signatures — it only base64url-decodes the payload — so a
 * fake signature is fine.
 */
export function makeTestJwt(claims: {
  preferred_username?: string;
  sub?: string;
  /** Seconds since epoch; defaults to now + 2 years. */
  exp?: number;
}): string {
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    iss: 'nestor-backend',
    preferred_username: claims.preferred_username ?? 'test.user',
    sub: claims.sub ?? 'user-123',
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60,
  };
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64(header)}.${b64(payload)}.fake-signature`;
}
