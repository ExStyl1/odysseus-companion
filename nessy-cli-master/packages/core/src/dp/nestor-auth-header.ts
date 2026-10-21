/**
 * Builds outbound auth headers for nestor backend
 * (`code-completion-nestor.tcsbank.ru/api/v1/cli/*`).
 *
 * Two header conventions are accepted by the backend's oathkeeper:
 *   - `Nestor-Token: <jwt>` — handled by the oauth2_introspection
 *     authenticator against `/api/v2/token/introspect`. Works only for
 *     tokens issued by Nestor itself via the DP token-exchange flow.
 *   - `Authorization: Bearer <jwt>` — handled by the spirit_iam
 *     authenticator, verifies JWT signature against Spirit IAM JWKS.
 *     Works for delegated Spirit IAM tokens, which is what
 *     the `NESSY_CLI_DP_AUTH_TOKEN` env var carries.
 *
 * The CLI's classic flow (`dp auth login` → `/api/v2/token` exchange)
 * yields tokens that go through the first path. The env-bypass flow
 * (`NESSY_CLI_DP_AUTH_TOKEN` env var, see `dp/dp-delegated-token.ts`) yields tokens
 * that must go through the second.
 *
 * Discrimination is done by comparing the JWT to `NESSY_CLI_DP_AUTH_TOKEN`: only
 * when the token actually equals the env value do we send Bearer. This
 * avoids sending Bearer for a DP-issued JWT just because env happens
 * to be set at request time.
 */
// [nessy-fork] delegated-token-auth
export function buildNestorAuthHeaders(jwt: string): Record<string, string> {
  const envToken = process.env['NESSY_CLI_DP_AUTH_TOKEN'];
  if (envToken && envToken === jwt) {
    return { Authorization: `Bearer ${jwt}` };
  }
  return { 'Nestor-Token': jwt };
}

// [nessy-fork] dp-auth-anthropic-generator
export function wrapFetchWithNestorAuth(
  baseFetch: typeof fetch,
  getToken: () => string,
): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of [
      'Authorization',
      'Nestor-Token',
      'X-Api-Key',
      'X-Byok-Key',
    ]) {
      headers.delete(name);
    }
    for (const [name, value] of Object.entries(
      buildNestorAuthHeaders(getToken()),
    )) {
      headers.set(name, value);
    }
    return baseFetch(input, { ...init, headers });
  };
}
