import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  customHeaderNames,
  parseCustomHeaders,
} from '../telemetry/gateway-headers.ts';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../testing/module-graph-budgets.ts';

let prepareOutboundHeaders: typeof import('../unified-network-interceptor.ts').prepareOutboundHeaders;

/** The verified gateway prefix (`AGENTS.md` gateway facts). */
const gatewayUrl = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1/chat/completions';
/** Same HOST, different path — a custom endpoint must not get correlation. */
const sameHostCustomEndpoint = 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/v1/chat/completions';
const foreignUrl = 'https://api.openai.com/v1/chat/completions';
/** Not provider API traffic: the interceptor is the Pi subprocess's global fetch. */
const mcpServerUrl = 'https://mcp.example.com/sse';

const ENV_KEYS = ['NESSY_SESSION_ID', 'NESSY_CUSTOM_HEADERS', 'NESSY_PI_MODEL_API'] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

function headersOf(headers: unknown): Record<string, string> {
  return Object.fromEntries(new Headers(headers as Record<string, string> | undefined).entries());
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseCustomHeaders', () => {
  it('reads the documented `Name: Value` newline-separated form', () => {
    // env-vars.md:145 — "Custom headers to add to requests (`Name: Value`
    // format, newline-separated for multiple headers)".
    const { headers, invalid } = parseCustomHeaders('X-Tenant: acme\r\nX-Trace-Id: abc:def\n\n');
    expect(headers).toEqual({ 'X-Tenant': 'acme', 'X-Trace-Id': 'abc:def' });
    expect(invalid).toEqual([]);
  });

  it('drops a malformed line and never reports its value', () => {
    const { headers, invalid } = parseCustomHeaders('no-colon-here\nX-Bad Name: v\nX-Ok: v');
    expect(headers).toEqual({ 'X-Ok': 'v' });
    expect(invalid).toEqual(['line 1', 'line 2']);
    expect(invalid.join()).not.toContain('v');
  });

  it('names, never values, are what a log line can carry', () => {
    process.env.NESSY_CUSTOM_HEADERS = 'Authorization: Bearer super-secret\nbroken';
    const names = customHeaderNames();
    expect(names).toEqual(['Authorization', '!line 2']);
    expect(names.join()).not.toContain('super-secret');
  });
});

describe('prepareOutboundHeaders', () => {
  beforeAll(async () => {
    process.env.NESSY_INTERCEPTOR_DISABLE_AUTO_INSTALL = '1';
    ({ prepareOutboundHeaders } = await import('../unified-network-interceptor.ts'));
  }, MODULE_GRAPH_HOOK_BUDGET_MS);

  it('carries the correlation header on a gateway request', () => {
    process.env.NESSY_SESSION_ID = 'session-42';

    const headers = headersOf(prepareOutboundHeaders(gatewayUrl, {
      Authorization: 'Bearer jwt-token',
      'Content-Type': 'application/json',
    }));

    expect(headers['x-nessy-session-id']).toBe('session-42');
    // The auth rewrite still runs, and still runs after the operator layer.
    expect(headers['nestor-token']).toBe('jwt-token');
    expect(headers.authorization).toBeUndefined();
  });

  it('does not carry it on a custom endpoint that only shares the gateway host', () => {
    process.env.NESSY_SESSION_ID = 'session-42';

    const sameHost = headersOf(prepareOutboundHeaders(sameHostCustomEndpoint, {
      Authorization: 'Bearer personal-token',
    }));
    const foreign = headersOf(prepareOutboundHeaders(foreignUrl, {
      Authorization: 'Bearer personal-token',
    }));

    expect(sameHost['x-nessy-session-id']).toBeUndefined();
    expect(foreign['x-nessy-session-id']).toBeUndefined();
    // And normal provider auth semantics are retained on both.
    expect(sameHost.authorization).toBe('Bearer personal-token');
    expect(foreign.authorization).toBe('Bearer personal-token');
  });

  it('in the Pi subprocess, adds operator headers to every provider URL, and the verified gateway credential still wins', () => {
    // The Pi shape: pi-agent-server writes this hint once it has a model. Without
    // it this process is the headless-server shape (the arm below, F1.517).
    process.env.NESSY_PI_MODEL_API = 'openai-completions';
    process.env.NESSY_SESSION_ID = 'session-42';
    process.env.NESSY_CUSTOM_HEADERS = 'X-Tenant: acme\nAuthorization: Bearer operator-token';

    const gateway = headersOf(prepareOutboundHeaders(gatewayUrl, { Authorization: 'Bearer sdk-token' }));
    const custom = headersOf(prepareOutboundHeaders(sameHostCustomEndpoint, { Authorization: 'Bearer sdk-token' }));

    expect(gateway['x-tenant']).toBe('acme');
    expect(custom['x-tenant']).toBe('acme');
    // Layer 1 replaced the SDK's value case-insensitively; layer 2 then moved it.
    expect(gateway['nestor-token']).toBe('operator-token');
    expect(gateway.authorization).toBeUndefined();
    expect(custom.authorization).toBe('Bearer operator-token');
  });

  it('outside Pi (the headless server), adds operator headers on the verified gateway only', () => {
    // F1.517: the same rule `gatewayRequestHeaders` applies on the desktop, where
    // no interceptor runs — so a codex/claude hop's BYO upstream gets none of them
    // on either host. The end-to-end rig is
    // `unified-network-interceptor.headless-operator-headers.test.ts`.
    delete process.env.NESSY_PI_MODEL_API;
    process.env.NESSY_CUSTOM_HEADERS = 'X-Tenant: acme\nAuthorization: Bearer operator-token';

    const gateway = headersOf(prepareOutboundHeaders(gatewayUrl, { Authorization: 'Bearer sdk-token' }));
    const sameHost = headersOf(prepareOutboundHeaders(sameHostCustomEndpoint, { Authorization: 'Bearer sdk-token' }));
    const foreign = headersOf(prepareOutboundHeaders(foreignUrl, { Authorization: 'Bearer sdk-token' }));

    expect(gateway['x-tenant']).toBe('acme');
    expect(gateway['nestor-token']).toBe('operator-token');
    expect({ sameHost: sameHost['x-tenant'], foreign: foreign['x-tenant'] }).toEqual({ sameHost: undefined, foreign: undefined });
    // The request's own credential is untouched on both.
    expect(sameHost.authorization).toBe('Bearer sdk-token');
    expect(foreign.authorization).toBe('Bearer sdk-token');
  });

  it('never sends an operator header to non-provider egress', () => {
    // The interceptor patches the Pi subprocess's global fetch, so it also sees
    // MCP calls and tool fetches. An operator header is where a token lives.
    process.env.NESSY_CUSTOM_HEADERS = 'Authorization: Bearer operator-token\nX-Tenant: acme';

    const headers = headersOf(prepareOutboundHeaders(mcpServerUrl, { Accept: 'text/event-stream' }));

    expect(headers['x-tenant']).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers.accept).toBe('text/event-stream');
  });

  it('cannot be spoofed through the operator channel', () => {
    process.env.NESSY_SESSION_ID = 'session-42';
    process.env.NESSY_CUSTOM_HEADERS = 'x-nessy-session-id: forged';

    const headers = headersOf(prepareOutboundHeaders(gatewayUrl, { Authorization: 'Bearer jwt' }));

    expect(headers['x-nessy-session-id']).toBe('session-42');
  });

  it('cannot be spoofed in a process that has no session id of its own', () => {
    // The ordering guard only wins when layer (3) has a value to write. A host
    // process serving many sessions has none, and the headless server preloads
    // this file — so an operator line would otherwise choose the id the gateway
    // aggregates on. The name is reserved instead, unconditionally.
    delete process.env.NESSY_SESSION_ID;
    process.env.NESSY_CUSTOM_HEADERS = 'X-Tenant: acme\nx-nessy-session-id: forged';

    const headers = headersOf(prepareOutboundHeaders(gatewayUrl, { Authorization: 'Bearer jwt' }));

    expect(headers['x-nessy-session-id']).toBeUndefined();
    // The rest of the operator's channel is untouched by the reservation.
    expect(headers['x-tenant']).toBe('acme');
    expect(customHeaderNames()).toEqual(['X-Tenant', '!x-nessy-session-id']);
  });

  it('is a byte-identical no-op when neither layer is configured', () => {
    delete process.env.NESSY_SESSION_ID;
    delete process.env.NESSY_CUSTOM_HEADERS;

    const untouched = { Authorization: 'Bearer personal-token' };
    expect(prepareOutboundHeaders(foreignUrl, untouched)).toBe(untouched);
    expect(prepareOutboundHeaders(gatewayUrl, undefined)).toBeUndefined();
  });

  it('reaches a request that carried no headers of its own', () => {
    process.env.NESSY_SESSION_ID = 'session-42';

    expect(headersOf(prepareOutboundHeaders(gatewayUrl, undefined))['x-nessy-session-id']).toBe('session-42');
  });
});
