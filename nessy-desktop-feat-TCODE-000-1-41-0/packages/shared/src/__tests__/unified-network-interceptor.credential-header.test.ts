/**
 * P6.691 — a BYO connection whose API key travels in `x-api-key` gets that
 * header on Pi too.
 *
 * The setup form has offered the choice since P6.586 and the model layer has
 * carried it since before that, threaded to the anthropic and codex drivers
 * directly. On Pi there was nothing to thread it through: the request headers
 * are built inside the vendored `@earendil-works/pi-ai`, where `x-api-key`
 * appears only under `providers/cloudflare-auth` and never on the
 * openai-compatible path. So the form offered a control Pi silently ignored.
 *
 * `prepareOutboundHeaders` is the seam under test rather than a stubbed `fetch`:
 * it is the function the installed `fetch` calls for every outbound request, and
 * testing it directly keeps the four guards visible as four cases instead of one
 * end-to-end pass that could be green for the wrong reason.
 */
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts';

let prepareOutboundHeaders: typeof import('../unified-network-interceptor.ts').prepareOutboundHeaders;

const ENV = 'NESSY_UPSTREAM_CREDENTIAL_HEADER';
/** A provider API URL the interceptor's own adapters claim. */
const PROVIDER_URL = 'https://api.openai.com/v1/chat/completions';
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/chat/completions';
/** Not provider traffic: an MCP server the same child might call. */
const OTHER_URL = 'https://mcp.example.internal/sse';

function asObject(headers: unknown): Record<string, string> {
  return Object.fromEntries(new Headers(headers as ConstructorParameters<typeof Headers>[0]).entries());
}

// `delete` before assign, never a bare assign.
function setChoice(value: string | undefined): void {
  delete process.env[ENV];
  if (value !== undefined) process.env[ENV] = value;
}

describe('the credential header on a Pi request', () => {
  beforeAll(async () => {
    process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ prepareOutboundHeaders } = await import('../unified-network-interceptor.ts'));
  }, MODULE_GRAPH_HOOK_BUDGET_MS);

  afterEach(() => { setChoice(undefined) });

  /** ARM ONE: the choice reaches the upstream, and `Authorization` is gone. */
  it('moves the Bearer credential onto x-api-key when the connection chose it', () => {
    setChoice('x-api-key');

    const headers = asObject(prepareOutboundHeaders(PROVIDER_URL, { Authorization: 'Bearer sk-test' }));

    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBeUndefined();
  });

  /**
   * ARM TWO / THE BEARER CONTROL: with no choice made, the request is exactly
   * what it was before this row. `authorization` is carried as ABSENCE at every
   * other reader, so "unset" has to mean untouched.
   */
  it('leaves the request alone when no header was chosen', () => {
    const headers = asObject(prepareOutboundHeaders(PROVIDER_URL, { Authorization: 'Bearer sk-test' }));

    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('leaves the request alone when the choice is the default spelling', () => {
    setChoice('authorization');

    const headers = asObject(prepareOutboundHeaders(PROVIDER_URL, { Authorization: 'Bearer sk-test' }));

    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['x-api-key']).toBeUndefined();
  });

  /**
   * The gateway keeps its own scheme. `rewriteNestorAuthHeaders` turns the
   * Bearer into `Nestor-Token` there, and a second rewrite would either fight it
   * or strip the header it just wrote.
   */
  it('never touches the verified gateway path, which has its own scheme', () => {
    setChoice('x-api-key');

    const headers = asObject(prepareOutboundHeaders(GATEWAY_URL, { Authorization: 'Bearer jwt' }));

    expect(headers['nestor-token']).toBe('jwt');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  /**
   * THE GUARD THAT MATTERS MOST: this file is the Pi child's global `fetch`, so
   * it also sees MCP calls, plugin fetches and anything a tool reaches for. A
   * credential must not ride an arbitrary egress because the same process made
   * the request.
   */
  it('does not rewrite a request that is not provider API traffic', () => {
    setChoice('x-api-key');

    const headers = asObject(prepareOutboundHeaders(OTHER_URL, { Authorization: 'Bearer sk-test' }));

    expect(headers.authorization).toBe('Bearer sk-test');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('does not overwrite an x-api-key the request already carries', () => {
    setChoice('x-api-key');

    const headers = asObject(prepareOutboundHeaders(PROVIDER_URL, {
      Authorization: 'Bearer sk-test',
      'x-api-key': 'already-here',
    }));

    expect(headers['x-api-key']).toBe('already-here');
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  it('leaves a request with no Bearer credential untouched', () => {
    setChoice('x-api-key');

    const headers = asObject(prepareOutboundHeaders(PROVIDER_URL, { 'content-type': 'application/json' }));

    expect(headers['x-api-key']).toBeUndefined();
    expect(Object.keys(headers)).toEqual(['content-type']);
  });
});
