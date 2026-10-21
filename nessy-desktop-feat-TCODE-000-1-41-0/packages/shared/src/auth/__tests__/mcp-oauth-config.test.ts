import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  discoverOAuthMetadata as discoverOAuthMetadataImpl,
  prepareMcpOAuth as prepareMcpOAuthImpl,
  resolveMcpOAuthScopes,
  withOAuthNetworkDependenciesForTests,
  type OAuthMetadata,
} from '../oauth.ts';

let mockFetch: ReturnType<typeof mock>;
const withTestNetwork = <T>(action: () => T): T => (
  withOAuthNetworkDependenciesForTests({
    fetchImpl: (url, options, addresses) => mockFetch(url, options, addresses),
    resolveHost: async () => [{ address: '203.0.114.10', family: 4 }],
  }, action)
);
const discoverOAuthMetadata: typeof discoverOAuthMetadataImpl = (...args) => (
  withTestNetwork(() => discoverOAuthMetadataImpl(...args))
);
const prepareMcpOAuth: typeof prepareMcpOAuthImpl = (...args) => (
  withTestNetwork(() => prepareMcpOAuthImpl(...args))
);

const AUTH_METADATA = {
  authorization_endpoint: 'https://auth.example.test/authorize',
  token_endpoint: 'https://auth.example.test/token',
};

/**
 * `mcp.md:713`: "Point Claude Code at a specific OAuth authorization server
 * metadata URL to bypass the default discovery chain."
 */
describe('authServerMetadataUrl overrides discovery', () => {
  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
  });

  it('fetches the configured URL and never touches the well-known chain', async () => {
    const configured = 'https://proxy.example.test/.well-known/openid-configuration';
    mockFetch.mockImplementation((url: string) => (
      url === configured
        ? Promise.resolve(new Response(JSON.stringify(AUTH_METADATA), { status: 200 }))
        : Promise.resolve(new Response('Not Found', { status: 404 }))
    ));

    const metadata = await discoverOAuthMetadata(
      'https://mcp.example.test/mcp',
      undefined,
      { authServerMetadataUrl: configured },
    );

    expect(metadata).toMatchObject(AUTH_METADATA);
    const fetched = mockFetch.mock.calls.map(([url]) => url as string);
    expect(fetched).toEqual([configured]);
    expect(fetched.some(url => url.includes('/.well-known/oauth-authorization-server'))).toBe(false);
    expect(fetched.some(url => url.includes('/.well-known/oauth-protected-resource'))).toBe(false);
  });

  it('fails rather than falling back when the configured URL yields nothing', async () => {
    const metadata = await discoverOAuthMetadata(
      'https://mcp.example.test/mcp',
      undefined,
      { authServerMetadataUrl: 'https://proxy.example.test/.well-known/openid-configuration' },
    );

    expect(metadata).toBeNull();
    // One attempt, at the configured URL. A fallback here would reach the very
    // public endpoints the override exists to bypass.
    expect(mockFetch.mock.calls).toHaveLength(1);
  });

  it('still walks the documented chain when no override is configured', async () => {
    mockFetch.mockImplementation((url: string) => (
      url === 'https://mcp.example.test/.well-known/oauth-authorization-server'
        ? Promise.resolve(new Response(JSON.stringify(AUTH_METADATA), { status: 200 }))
        : Promise.resolve(new Response('Not Found', { status: 404 }))
    ));

    const metadata = await discoverOAuthMetadata('https://mcp.example.test/mcp');

    expect(metadata).toMatchObject(AUTH_METADATA);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
  });
});

/**
 * `mcp.md:735`, `:751`, `:753`, `:755` — plus the narrowing rule: a pinned scope
 * the server does not advertise is never requested.
 */
describe('resolveMcpOAuthScopes', () => {
  const metadata = (scopes?: string[]): OAuthMetadata => ({
    ...AUTH_METADATA,
    ...(scopes ? { scopes_supported: scopes } : {}),
  });

  it('sends no scope parameter when nothing is pinned and nothing is configured', () => {
    expect(resolveMcpOAuthScopes(metadata(['a', 'b', 'c']))).toEqual({
      unadvertised: [],
      offlineAccessAppended: false,
    });
  });

  it('pins exactly the configured subset when the server advertises more', () => {
    const decision = resolveMcpOAuthScopes(
      metadata(['channels:read', 'chat:write', 'search:read', 'admin:all']),
      { scopes: 'channels:read chat:write search:read' },
    );

    expect(decision.scope).toBe('channels:read chat:write search:read');
    expect(decision.unadvertised).toEqual([]);
  });

  it('drops a pinned scope the server does not advertise and reports it', () => {
    const decision = resolveMcpOAuthScopes(
      metadata(['channels:read']),
      { scopes: 'channels:read admin:all' },
    );

    expect(decision.scope).toBe('channels:read');
    expect(decision.unadvertised).toEqual(['admin:all']);
  });

  it('sends the pinned set unchanged when the server advertises no catalogue', () => {
    const decision = resolveMcpOAuthScopes(metadata(), { scopes: 'channels:read admin:all' });

    expect(decision.scope).toBe('channels:read admin:all');
    expect(decision.unadvertised).toEqual([]);
  });

  it('appends offline_access when the server advertises it (mcp.md:755)', () => {
    const decision = resolveMcpOAuthScopes(
      metadata(['channels:read', 'offline_access']),
      { scopes: 'channels:read' },
    );

    expect(decision.scope).toBe('channels:read offline_access');
    expect(decision.offlineAccessAppended).toBe(true);
  });

  it('uses a configured metadata URL scopes_supported as the requested scopes (mcp.md:753)', () => {
    const decision = resolveMcpOAuthScopes(
      metadata(['a', 'b']),
      { authServerMetadataUrl: 'https://proxy.example.test/.well-known/openid-configuration' },
    );

    expect(decision.scope).toBe('a b');
  });
});

describe('prepareMcpOAuth carries the pinned scopes into the authorization request', () => {
  beforeEach(() => {
    mockFetch = mock(() => Promise.resolve(new Response('Not Found', { status: 404 })));
  });

  const respondWithMetadata = (scopes?: string[]) => {
    mockFetch.mockImplementation((url: string) => (
      url === 'https://proxy.example.test/.well-known/openid-configuration'
        ? Promise.resolve(new Response(JSON.stringify({
            ...AUTH_METADATA,
            ...(scopes ? { scopes_supported: scopes } : {}),
          }), { status: 200 }))
        : Promise.resolve(new Response('Not Found', { status: 404 }))
    ));
  };

  it('sets scope on the authorization URL', async () => {
    respondWithMetadata(['channels:read', 'chat:write', 'admin:all']);

    const prepared = await prepareMcpOAuth('https://mcp.example.test/mcp', {
      callbackUrl: 'http://127.0.0.1/oauth/callback',
      clientId: 'test-client',
      oauth: {
        authServerMetadataUrl: 'https://proxy.example.test/.well-known/openid-configuration',
        scopes: 'channels:read chat:write',
      },
    });

    expect(new URL(prepared.authUrl).searchParams.get('scope')).toBe('channels:read chat:write');
  });

  it('leaves the authorization URL exactly as before when no oauth object is given', async () => {
    mockFetch.mockImplementation((url: string) => (
      url === 'https://mcp.example.test/.well-known/oauth-authorization-server'
        ? Promise.resolve(new Response(JSON.stringify(AUTH_METADATA), { status: 200 }))
        : Promise.resolve(new Response('Not Found', { status: 404 }))
    ));

    const prepared = await prepareMcpOAuth('https://mcp.example.test/mcp', {
      callbackUrl: 'http://127.0.0.1/oauth/callback',
      clientId: 'test-client',
    });

    expect(new URL(prepared.authUrl).searchParams.get('scope')).toBeNull();
  });

  it('never logs a token, a code, or a client secret while reporting a scope decision', async () => {
    respondWithMetadata(['channels:read']);
    const logged: string[] = [];

    await prepareMcpOAuth('https://mcp.example.test/mcp', {
      callbackUrl: 'http://127.0.0.1/oauth/callback',
      clientId: 'test-client',
      oauth: {
        authServerMetadataUrl: 'https://proxy.example.test/.well-known/openid-configuration',
        scopes: 'channels:read admin:all',
      },
      onLog: message => logged.push(message),
    });

    expect(logged.join('\n')).toContain('admin:all');
    for (const forbidden of ['access_token', 'client_secret', 'code=', 'Bearer ']) {
      expect(logged.join('\n')).not.toContain(forbidden);
    }
  });
});
