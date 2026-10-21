import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts';

let rewriteNestorAuthHeaders: typeof import('../unified-network-interceptor.ts').rewriteNestorAuthHeaders;
let prepareOutboundHeaders: typeof import('../unified-network-interceptor.ts').prepareOutboundHeaders;

const gatewayUrl = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/chat/completions';
const modelsUrl = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/models';

function toHeadersObject(headers: Headers | Record<string, string> | string[][] | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

describe('rewriteNestorAuthHeaders', () => {
  beforeAll(async () => {
    process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ rewriteNestorAuthHeaders, prepareOutboundHeaders } = await import('../unified-network-interceptor.ts'));
  }, MODULE_GRAPH_HOOK_BUDGET_MS);

  it('rewrites Bearer auth to Nestor-Token for the gateway host', () => {
    const headers = rewriteNestorAuthHeaders(gatewayUrl, {
      Authorization: 'Bearer jwt-token',
      'Content-Type': 'application/json',
    });

    expect(toHeadersObject(headers)['nestor-token']).toBe('jwt-token');
    expect(toHeadersObject(headers).authorization).toBeUndefined();
    expect(toHeadersObject(headers)['content-type']).toBe('application/json');
  });

  it('rewrites Bearer auth for the CLI-scoped models URL', () => {
    const headers = rewriteNestorAuthHeaders(modelsUrl, {
      Authorization: 'Bearer jwt-token',
    });

    expect(toHeadersObject(headers)['nestor-token']).toBe('jwt-token');
    expect(toHeadersObject(headers).authorization).toBeUndefined();
  });

  it('leaves non-gateway hosts untouched', () => {
    const headers = {
      Authorization: 'Bearer jwt-token',
      'Content-Type': 'application/json',
    };

    expect(rewriteNestorAuthHeaders('https://api.openai.com/v1/chat/completions', headers)).toBe(headers);
  });

  it('leaves same-host non-CLI paths untouched', () => {
    const headers = {
      Authorization: 'Bearer personal-token',
      'Content-Type': 'application/json',
    };

    expect(rewriteNestorAuthHeaders('https://code-completion-nestor.tcsbank.ru/api/v1/personal/x', headers)).toBe(headers);
    expect(toHeadersObject(headers).authorization).toBe('Bearer personal-token');
  });

  it('preserves Request-instance headers while rewriting auth', () => {
    const request = new Request(gatewayUrl, {
      headers: {
        Authorization: 'Bearer request-jwt',
        'X-Request-ID': 'req-1',
      },
    });

    const headers = rewriteNestorAuthHeaders(request.url, request.headers);

    expect(toHeadersObject(headers)['nestor-token']).toBe('request-jwt');
    expect(toHeadersObject(headers).authorization).toBeUndefined();
    expect(toHeadersObject(headers)['x-request-id']).toBe('req-1');
  });

  it('ignores malformed URLs and non-Bearer auth values', () => {
    const malformed = { Authorization: 'Bearer jwt-token' };
    const basic = { Authorization: 'Basic abc' };

    expect(rewriteNestorAuthHeaders('not a url', malformed)).toBe(malformed);
    expect(rewriteNestorAuthHeaders(gatewayUrl, basic)).toBe(basic);
  });
});

/**
 * DA1.10 — the JWT rewrite is scoped to the NAMED gateway endpoints.
 *
 * The two positives above (`gatewayUrl`, `modelsUrl`) are the named set and stay
 * green. What was missing is the negative INSIDE the prefix: the file's only
 * same-host negative (`…/api/v1/personal/x`) sits OUTSIDE it, so it could not
 * cover the path a BYO `pi_compat` connection actually takes.
 */
describe('DA1.10 — an unknown path under the CLI prefix is not the gateway', () => {
  const CREDENTIAL_HEADER_ENV = 'NESSY_UPSTREAM_CREDENTIAL_HEADER';
  const unknownUnderPrefix = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/personal/x';
  const providerUrl = 'https://api.openai.com/v1/chat/completions';

  // `delete` before assign, never a bare assign (AGENTS.md §Traps).
  function setCredentialHeaderChoice(value: string | undefined): void {
    delete process.env[CREDENTIAL_HEADER_ENV];
    if (value !== undefined) process.env[CREDENTIAL_HEADER_ENV] = value;
  }

  afterEach(() => { setCredentialHeaderChoice(undefined) });

  it('leaves Authorization alone on an unknown path under the prefix', () => {
    const headers = {
      Authorization: 'Bearer byo-token',
      'Content-Type': 'application/json',
    };

    // Identity return: nothing was rewritten, and the caller's object is intact.
    expect(rewriteNestorAuthHeaders(unknownUnderPrefix, headers)).toBe(headers);
    expect(toHeadersObject(headers).authorization).toBe('Bearer byo-token');
    expect(toHeadersObject(headers)['nestor-token']).toBeUndefined();
  });

  it('still rewrites the two named endpoints — the control for the case above', () => {
    // Without this, "leaves it alone" would also be true of a predicate that
    // stopped matching anything at all.
    expect(toHeadersObject(rewriteNestorAuthHeaders(gatewayUrl, { Authorization: 'Bearer jwt' }))['nestor-token'])
      .toBe('jwt');
    expect(toHeadersObject(rewriteNestorAuthHeaders(modelsUrl, { Authorization: 'Bearer jwt' }))['nestor-token'])
      .toBe('jwt');
  });

  /**
   * The DELIBERATE NON-MOVE, pinned. `rewriteCredentialHeader` reads the WIDE
   * prefix to EXCLUDE, so it must keep leaving this path alone even though the
   * JWT rewrite no longer claims it. Narrowing it with its neighbour would start
   * moving a BYO Bearer onto `x-api-key` on gateway-host paths — a leak
   * introduced by a "narrow everything" sweep.
   */
  it('does not move the excluder: no x-api-key rewrite on a prefix path either', () => {
    setCredentialHeaderChoice('x-api-key');

    const headers = toHeadersObject(prepareOutboundHeaders(unknownUnderPrefix, { Authorization: 'Bearer byo-token' }));

    expect(headers.authorization).toBe('Bearer byo-token');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['nestor-token']).toBeUndefined();
  });

  it('and the probe can see: the same choice DOES rewrite a real provider URL', () => {
    setCredentialHeaderChoice('x-api-key');

    const headers = toHeadersObject(prepareOutboundHeaders(providerUrl, { Authorization: 'Bearer sk-test' }));

    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBeUndefined();
  });
});
