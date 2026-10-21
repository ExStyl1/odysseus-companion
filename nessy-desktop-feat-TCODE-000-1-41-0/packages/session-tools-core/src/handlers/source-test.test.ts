import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleSourceTest } from './source-test.ts';
import type { SessionToolContext } from '../context.ts';
import type { SourceConfig } from '../types.ts';

type ActivateResult = Awaited<
  ReturnType<NonNullable<SessionToolContext['activateSourceInSession']>>
>;

interface CtxOverrides {
  activateSourceInSession?: (slug: string) => Promise<ActivateResult>;
  validateStdioMcpConnection?: SessionToolContext['validateStdioMcpConnection'];
  validateMcpConnection?: SessionToolContext['validateMcpConnection'];
  discoverMcpOAuth?: (url: string) => Promise<boolean>;
  credentialManager?: SessionToolContext['credentialManager'];
}

function createCtx(workspacePath: string, overrides: CtxOverrides = {}): SessionToolContext {
  const saved: { last?: SourceConfig } = {};
  const ctx = {
    sessionId: 'test-session',
    workspacePath,
    get sourcesPath() {
      return join(workspacePath, 'sources');
    },
    get skillsPath() {
      return join(workspacePath, 'skills');
    },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf-8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      readdir: (path: string) => readdirSync(path),
      stat: (path: string) => {
        const s = statSync(path);
        return { size: s.size, isDirectory: () => s.isDirectory() };
      },
    },
    loadSourceConfig: (slug: string) => {
      const configPath = join(workspacePath, 'sources', slug, 'config.json');
      if (!existsSync(configPath)) return null;
      return JSON.parse(readFileSync(configPath, 'utf-8')) as SourceConfig;
    },
    saveSourceConfig: (source: SourceConfig) => {
      saved.last = source;
      const configPath = join(workspacePath, 'sources', source.slug, 'config.json');
      writeFileSync(configPath, JSON.stringify(source, null, 2));
    },
    // Stub the MCP validator so connection tests don't hit the network.
    validateStdioMcpConnection: overrides.validateStdioMcpConnection,
    validateMcpConnection: overrides.validateMcpConnection,
    discoverMcpOAuth: overrides.discoverMcpOAuth,
    credentialManager: overrides.credentialManager,
    activateSourceInSession: overrides.activateSourceInSession,
  } as unknown as SessionToolContext;
  // Expose saved for assertions (test-only — not on real ctx).
  (ctx as unknown as { _saved: typeof saved })._saved = saved;
  return ctx;
}

function writeSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: `Test ${slug}`,
    enabled: true,
    provider: 'test',
    type: 'mcp',
    tagline: 'A test source',
    icon: '🧪',
    mcp: {
      transport: 'stdio',
      command: 'echo',
      args: ['ok'],
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the auto-enable flow and not the completeness check.'
  );
}

function stubMcpOk(): NonNullable<SessionToolContext['validateStdioMcpConnection']> {
  return async () => ({
    success: true,
    toolCount: 1,
    toolNames: ['dummy'],
    serverName: 'stub',
    serverVersion: '0.0.0',
  });
}

function stubMcpFail(): NonNullable<SessionToolContext['validateStdioMcpConnection']> {
  return async () => ({ success: false, error: 'boom' });
}

describe('source_test auto-enable', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-auto-enable-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flips enabled: false → true and calls activation callback on clean run', async () => {
    writeSource(tempDir, 'nessy-kb', { enabled: false });

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'nessy-kb' });

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Source auto-enabled in config');
    expect(text).toContain('turn will auto-restart');
    expect(activated).toBe('nessy-kb');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'nessy-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('already-enabled source still calls activation callback (session may be stale)', async () => {
    writeSource(tempDir, 'nessy-kb', { enabled: true });

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'nessy-kb' });
    const text = result.content[0]?.text ?? '';

    // No "auto-enabled in config" line because enabled was already true.
    expect(text).not.toContain('auto-enabled in config');
    expect(activated).toBe('nessy-kb');
    expect(text).toContain('turn will auto-restart');
  });

  it('autoEnable: false skips both the flag flip and the activation callback', async () => {
    writeSource(tempDir, 'nessy-kb', { enabled: false });

    let activated = false;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'nessy-kb', autoEnable: false });

    expect(activated).toBe(false);
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'nessy-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    // saveSourceConfig still runs (metadata update), but enabled flag must remain false.
    expect(persisted.enabled).toBe(false);
  });

  it('validation errors skip auto-enable entirely (even when autoEnable is default)', async () => {
    writeSource(tempDir, 'broken', { enabled: false });

    let activated = false;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpFail(),
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'broken' });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(activated).toBe(false);
    expect(text).not.toContain('auto-enabled in config');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'broken', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
  });

  it('without activateSourceInSession, flag flip still happens with restart hint', async () => {
    writeSource(tempDir, 'nessy-kb', { enabled: false });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      // activateSourceInSession intentionally undefined
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'nessy-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('auto-enabled in config');
    expect(text).toContain('Restart session to load tools');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'nessy-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('activation failure shows warning but still persists enabled flag', async () => {
    writeSource(tempDir, 'nessy-kb', { enabled: false });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: false, reason: 'build failed' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'nessy-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('session activation failed: build failed');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'nessy-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('successful activation reports a single auto-restart message (backend-agnostic)', async () => {
    writeSource(tempDir, 'nessy-kb', { enabled: true });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'nessy-kb' });
    const text = result.content[0]?.text ?? '';

    // Both backends route through the same source_activated + auto_retry machinery
    // now, so the user-visible message is one line — no Claude vs Pi branching.
    expect(text).toContain('turn will auto-restart');
    expect(text).not.toContain('tools available now');
    expect(text).not.toContain('available on your next message');
  });
});

// ============================================================
// API connection-branch coverage (regression for #683)
// ============================================================
//
// These tests exercise the built-in fetch-based connection probe and the
// auto-enable gate that depends on its result. They drive global fetch via
// a swap-in stub so no network IO happens.

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchStub(
  responder: (call: FetchCall) => Response | Promise<Response>
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function writeApiSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: slug,
    enabled: false,
    provider: 'test',
    type: 'api',
    tagline: 'A test API source',
    icon: '🧪',
    api: {
      baseUrl: 'https://api.example.test',
      authType: 'none',
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the connection-branch behavior.'
  );
}

describe('source_test API connection branches', () => {
  let tempDir: string;
  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-api-conn-'));
  });

  afterEach(() => {
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('200 → connected, source auto-enabled, activation called', async () => {
    writeApiSource(tempDir, 'good-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 200 })));

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'good-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).not.toContain('Skipping activation');
    expect(activated).toBe('good-api');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'good-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('500 → disconnected, NOT auto-enabled, activation NOT called', async () => {
    writeApiSource(tempDir, 'flaky-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 500 })));

    let activated = false;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'flaky-api' });
    const text = result.content[0]?.text ?? '';

    // The summary line must not be "✓ Validation passed" alone — it must be
    // the warnings variant, because the probe got a non-2xx the probe couldn't
    // classify as healthy.
    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 500');
    expect(text).toContain('Skipping activation');

    expect(activated).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'flaky-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    // The enabled flag must not be flipped on a failed probe.
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('disconnected');
  });

  it('404 → disconnected, NOT auto-enabled, activation NOT called', async () => {
    writeApiSource(tempDir, 'wrong-path-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 404 })));

    let activated = false;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'wrong-path-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 404');
    expect(text).toContain('Skipping activation');
    expect(activated).toBe(false);
  });

  it('401 → connected (auth-required), auto-enabled (refresh path runs)', async () => {
    // 401 from an unauthenticated probe is mapped to "reachable, needs auth".
    // The token-refresh case in checkAuthStatus relies on this — gating on
    // connectionStatus must not break it.
    writeApiSource(tempDir, 'auth-needed-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 401 })));

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'auth-needed-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('Skipping activation');
    expect(activated).toBe('auth-needed-api');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'auth-needed-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('basic probe honors testEndpoint.method (no HEAD→GET fallback dance)', async () => {
    // Regression for the HEAD→GET-on-405 fallback that silently passed POST-only
    // endpoints. With a configured method, the basic probe must call it directly.
    writeApiSource(tempDir, 'post-only-api', {
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'none',
        testEndpoint: { method: 'POST', path: '/v1/things' },
      },
    } as Partial<SourceConfig>);

    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;

    await handleSourceTest(ctx_for(tempDir), { sourceSlug: 'post-only-api' });

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.init?.method).toBe('POST');
    expect(stub.calls[0]?.url).toBe('https://api.example.test/v1/things');
  });
});

// Tiny helper to build a no-callback ctx for tests that don't care about activation.
function ctx_for(workspacePath: string) {
  return createCtx(workspacePath, {
    activateSourceInSession: async () => ({ ok: true }),
  });
}

// ============================================================
// HTTP MCP probe — credential resolution (regression for #720)
// ============================================================
//
// The probe must forward the same auth token the live runtime would resolve:
// - cached token first
// - refresh fallback only on miss
// - works for `oauth` AND `bearer` whose token lives in the credential store
// - existing `headerNames` flow still merges credential headers, accessToken
//   stays undefined (regression guard).

type ValidateMcpCall = Parameters<NonNullable<SessionToolContext['validateMcpConnection']>>[0];

function writeHttpMcpSource(
  workspacePath: string,
  slug: string,
  overrides: Partial<SourceConfig> = {}
): void {
  const sourcePath = join(workspacePath, 'sources', slug);
  mkdirSync(sourcePath, { recursive: true });
  const config: SourceConfig = {
    id: slug,
    slug,
    name: slug,
    enabled: true,
    provider: 'test',
    type: 'mcp',
    tagline: 'A test HTTP MCP source',
    icon: '🧪',
    mcp: {
      transport: 'http',
      url: 'https://mcp.example.test',
      authType: 'oauth',
    },
    ...overrides,
  } as SourceConfig;
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the probe credential resolution behavior.'
  );
}

interface CredManagerStub {
  manager: NonNullable<SessionToolContext['credentialManager']>;
  getTokenCalls: number;
  refreshCalls: number;
}

function makeCredentialManager({
  cachedToken,
  refreshedToken,
}: {
  cachedToken?: string | null;
  refreshedToken?: string | null;
}): CredManagerStub {
  const stub: CredManagerStub = {
    manager: {
      hasValidCredentials: async () => Boolean(cachedToken),
      getToken: async () => {
        stub.getTokenCalls += 1;
        return cachedToken ?? null;
      },
      refresh: async () => {
        stub.refreshCalls += 1;
        return refreshedToken ?? null;
      },
    },
    getTokenCalls: 0,
    refreshCalls: 0,
  };
  return stub;
}

describe('source_test HTTP MCP probe credential forwarding (regression for #720)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-mcp-cred-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('OAuth MCP with cached token forwards accessToken to the probe (no refresh)', async () => {
    writeHttpMcpSource(tempDir, 'oauth-cached', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'oauth',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: 'cached-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true, toolCount: 2 };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'oauth-cached', autoEnable: false });

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('cached-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(0);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'oauth-cached', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('OAuth MCP without cached token falls back to refresh and forwards the fresh token', async () => {
    writeHttpMcpSource(tempDir, 'oauth-refresh', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'oauth',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: null, refreshedToken: 'fresh-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'oauth-refresh', autoEnable: false });

    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('fresh-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(1);
  });

  it('Bearer MCP without headerNames forwards accessToken (defense-in-depth)', async () => {
    writeHttpMcpSource(tempDir, 'bearer-cached', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'bearer',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: 'bearer-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'bearer-cached', autoEnable: false });

    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('bearer-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(0);
  });

  it('headerNames flow still merges credential headers, accessToken stays undefined', async () => {
    // Multi-header credential — credential value is a JSON object keyed by header name.
    writeHttpMcpSource(tempDir, 'header-style', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        headerNames: ['X-Api-Key'],
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: JSON.stringify({ 'X-Api-Key': 'k1' }) });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'header-style', autoEnable: false });

    expect(calls.length).toBe(1);
    expect(calls[0]?.headers).toEqual({ 'X-Api-Key': 'k1' });
    expect(calls[0]?.accessToken).toBeUndefined();
    expect(cred.refreshCalls).toBe(0);
  });
});

describe('source_test basic-auth header (regression for #824)', () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;
  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-basic-'));
    captured = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBasicAuthSource(slug: string): void {
    const sourcePath = join(tempDir, 'sources', slug);
    mkdirSync(sourcePath, { recursive: true });
    const config = {
      id: slug,
      slug,
      name: `Test ${slug}`,
      enabled: true,
      provider: 'test',
      type: 'api',
      tagline: 'Basic auth API source',
      icon: '🧪',
      isAuthenticated: true,
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'basic',
        testEndpoint: { method: 'GET', path: '/ping' },
      },
    } as unknown as SourceConfig;
    writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(
      join(sourcePath, 'guide.md'),
      '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the basic-auth header path and not the completeness check.'
    );
  }

  function authHeader(): string | undefined {
    const h = captured?.init.headers as Record<string, string> | undefined;
    return h?.['Authorization'];
  }

  it('JSON {username,password} token → base64-encoded header', async () => {
    writeBasicAuthSource('json-basic');
    const cred = makeCredentialManager({
      cachedToken: JSON.stringify({ username: 'u', password: 'p' }),
    });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'json-basic', autoEnable: false });

    expect(authHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('already-base64 token → passed through unchanged', async () => {
    writeBasicAuthSource('legacy-basic');
    const encoded = Buffer.from('u:p').toString('base64');
    const cred = makeCredentialManager({ cachedToken: encoded });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'legacy-basic', autoEnable: false });

    expect(authHeader()).toBe(`Basic ${encoded}`);
  });

  it('non-JSON, non-base64 token → passed through unchanged (no throw)', async () => {
    writeBasicAuthSource('garbage-basic');
    const cred = makeCredentialManager({ cachedToken: 'not-json' });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'garbage-basic', autoEnable: false });

    expect(authHeader()).toBe('Basic not-json');
  });
});

describe('source_test HTTP MCP auth diagnostics', () => {
  const originalFetch = globalThis.fetch;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-mcp-auth-'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('distinguishes a 401 with valid OAuth discovery metadata', async () => {
    writeHttpMcpSource(tempDir, 'oauth-valid');
    const discovered: string[] = [];
    globalThis.fetch = (async () => {
      throw new Error('source_test must use the injected bounded discovery helper');
    }) as unknown as typeof fetch;
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: false, needsAuth: true }),
      discoverMcpOAuth: async (url) => {
        discovered.push(url);
        return true;
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'oauth-valid', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('MCP endpoint returned 401 and advertises OAuth');
    expect(text).not.toContain('supported DP-backed plugin MCP');
    expect(discovered).toEqual(['https://mcp.example.test']);
  });

  it('distinguishes a bearer credential requirement without OAuth discovery', async () => {
    writeHttpMcpSource(tempDir, 'bearer-required', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'bearer',
      },
    });
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: false, needsAuth: true }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'bearer-required', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('MCP endpoint requires a bearer credential');
    expect(text).not.toContain('source_oauth_trigger');
  });

  it('reports the bounded GitLab TCS diagnostic when OAuth metadata is absent', async () => {
    writeHttpMcpSource(tempDir, 'gitlab', {
      name: 'GitLab TCS',
      mcp: {
        transport: 'http',
        url: 'https://gitlab.tcsbank.ru/api/v4/mcp',
        authType: 'oauth',
      },
    });
    const discovered: string[] = [];
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: false, needsAuth: true }),
      discoverMcpOAuth: async (url) => {
        discovered.push(url);
        return false;
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'gitlab', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain(
      'This endpoint does not advertise MCP OAuth. Fix the source configuration or use the supported DP-backed plugin MCP.',
    );
    expect(text).not.toContain('source_oauth_trigger');
    expect(discovered).toEqual(['https://gitlab.tcsbank.ru/api/v4/mcp']);
  });

  it('uses the sanitized false classification for invalid OAuth metadata', async () => {
    writeHttpMcpSource(tempDir, 'oauth-invalid');
    const discovered: string[] = [];
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: false, needsAuth: true }),
      discoverMcpOAuth: async (url) => {
        discovered.push(url);
        return false;
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'oauth-invalid', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('This endpoint does not advertise MCP OAuth.');
    expect(text).not.toContain('source_oauth_trigger');
    expect(discovered).toEqual(['https://mcp.example.test']);
  });
});

describe('F1.665 (c) — a stdio probe that skipped tools is a warning, not a failure', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-f1665-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints the skipped-tools warning line and still auto-enables the source', async () => {
    writeSource(tempDir, 'combinators', { enabled: false });
    const warning = '1 tool skipped: "pick" (it does not have the MCP tool shape (inputSchema.type: invalid))';
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: async () => ({
        success: true,
        toolCount: 1,
        toolNames: ['plain'],
        warning,
      }),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'combinators' })).content[0]?.text ?? '';

    expect(text).toContain(`⚠ ${warning}`);
    expect(text).toContain('Source auto-enabled in config');
  });

  it('CONTROL — a clean stdio probe prints no warning line', async () => {
    writeSource(tempDir, 'clean', { enabled: false });
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'clean' })).content[0]?.text ?? '';

    expect(text).not.toContain('tools skipped');
    expect(text).not.toContain('tool skipped');
    expect(text).toContain('Source auto-enabled in config');
  });
});

describe('F1.684 — a probe that skipped tools ends "passed with warnings", not "passed"', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-f1684-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const warning = '1 tool skipped: "pick" (it does not have the MCP tool shape (inputSchema.type: invalid))';

  it('stdio: the summary reads "passed with warnings", and the source is still auto-enabled', async () => {
    writeSource(tempDir, 'stdio-skipped', { enabled: false });
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: async () => ({ success: true, toolCount: 1, toolNames: ['plain'], warning }),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'stdio-skipped' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain(`⚠ ${warning}`);
    expect(text).toContain('**Result: ⚠ Validation passed with warnings**');
    expect(text).not.toContain('**Result: ✓ Validation passed**');
    expect(result.isError).toBe(false);
    expect(text).toContain('Source auto-enabled in config');
  });

  it('HTTP: the summary reads "passed with warnings"', async () => {
    writeHttpMcpSource(tempDir, 'http-skipped', {
      mcp: { transport: 'http', url: 'https://mcp.example.test', authType: 'none' },
    });
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: true, toolCount: 1, warning }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'http-skipped', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain(`⚠ ${warning}`);
    expect(text).toContain('**Result: ⚠ Validation passed with warnings**');
    expect(result.isError).toBe(false);
  });

  it('CONTROL — a clean stdio probe still reads "Validation passed"', async () => {
    writeSource(tempDir, 'stdio-clean', { enabled: false });
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'stdio-clean' })).content[0]?.text ?? '';

    expect(text).toContain('**Result: ✓ Validation passed**');
    expect(text).not.toContain('with warnings');
  });
});

describe('F1.987 — an HTTP probe that answers "requires authentication" ends "passed with warnings"', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-f1987-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('authType none: a 401 probe reads "passed with warnings", and the source still counts as connected', async () => {
    writeHttpMcpSource(tempDir, 'none-401', {
      mcp: { transport: 'http', url: 'https://mcp.example.test', authType: 'none' },
    });
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: false, needsAuth: true }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'none-401' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('⚠ MCP server requires authentication');
    expect(text).toContain('ℹ Source does not require authentication');
    expect(text).toContain('**Result: ⚠ Validation passed with warnings**');
    expect(text).not.toContain('**Result: ✓ Validation passed**');
    expect(result.isError).toBe(false);
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'none-401', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('an authenticated bearer source whose valid token still gets a 401 reads "passed with warnings"', async () => {
    writeHttpMcpSource(tempDir, 'bearer-401', {
      isAuthenticated: true,
      mcp: { transport: 'http', url: 'https://mcp.example.test', authType: 'bearer' },
    } as Partial<SourceConfig>);
    const cred = makeCredentialManager({ cachedToken: 'cached-tok' });
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async () => ({ success: false, needsAuth: true }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'bearer-401', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('⚠ MCP server requires authentication');
    // UB3.2 re-spelled the auth-status line (upstream v0.15.1): presence and
    // expiry only, whether the API accepts it is the connection test's job.
    expect(text).toContain('✓ Credential stored and not expired');
    expect(text).toContain('**Result: ⚠ Validation passed with warnings**');
    expect(result.isError).toBe(false);
  });

  it('CONTROL — a clean HTTP probe of an authType none source still reads "Validation passed"', async () => {
    writeHttpMcpSource(tempDir, 'none-clean', {
      mcp: { transport: 'http', url: 'https://mcp.example.test', authType: 'none' },
    });
    const ctx = createCtx(tempDir, {
      validateMcpConnection: async () => ({ success: true, toolCount: 1 }),
    });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'none-clean', autoEnable: false })).content[0]?.text ?? '';

    expect(text).not.toContain('requires authentication');
    expect(text).toContain('**Result: ✓ Validation passed**');
    expect(text).not.toContain('with warnings');
  });
});

// ============================================================
// UB3.2 (R14-17, upstream v0.15.1) — source_test refuses a missing or expired
// stored credential and surfaces the API's error body.
//
// Before: an authenticated source with no usable credential fell through to the
// UNAUTHENTICATED basic probe, whose 401 read as "reachable, needs auth" and left
// the source green while every api_<source> call failed; a rejected key answered
// 400 with no body shown, reading as a bad endpoint.
// ============================================================

describe('UB3.2 — a missing or expired stored credential fails source_test', () => {
  let tempDir: string;
  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-ub32-'));
  });

  afterEach(() => {
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAuthedApiSource(slug: string, api: Partial<NonNullable<SourceConfig['api']>> = {}): void {
    writeApiSource(tempDir, slug, {
      isAuthenticated: true,
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'bearer',
        testEndpoint: { method: 'GET', path: '/ping' },
        ...api,
      },
    } as Partial<SourceConfig>);
  }

  it('positive: a valid stored credential passes and the request carries it', async () => {
    writeAuthedApiSource('valid-cred', { authType: 'header', headerName: 'x-goog-api-key' });
    const stub = installFetchStub(() => new Response('{"ok":true}', { status: 200 }));
    restoreFetch = stub.restore;
    const cred = makeCredentialManager({ cachedToken: 'AIzaSy' + 'k'.repeat(33) });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'valid-cred', autoEnable: false })).content[0]?.text ?? '';

    expect(text).toContain('✓ Credential loaded, sent as header x-goog-api-key');
    expect(text).toContain('Authenticated request succeeded (HTTP 200)');
    const sent = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(sent?.['x-goog-api-key']).toBe('AIzaSy' + 'k'.repeat(33));
  });

  it('negative control: marked authenticated with no stored credential is an auth error, and the unauthenticated probe never runs', async () => {
    writeAuthedApiSource('missing-cred');
    const stub = installFetchStub(() => new Response(null, { status: 401 }));
    restoreFetch = stub.restore;
    const cred = makeCredentialManager({ cachedToken: null, refreshedToken: null });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    const result = await handleSourceTest(ctx, { sourceSlug: 'missing-cred', autoEnable: false });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('no usable credential');
    // Refresh tried before giving up (the credential may have been expired, not absent).
    expect(cred.refreshCalls).toBeGreaterThanOrEqual(1);
    // The old failure mode: falling through to the unauthenticated basic probe, whose
    // 401 read as "reachable". No probe call may happen without a credential.
    expect(stub.calls.length).toBe(0);
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'missing-cred', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.connectionStatus).toBe('error');
    expect(persisted.enabled).toBe(false);
  });

  it('an expired but refreshable credential is refreshed and the refreshed token reaches the wire', async () => {
    writeAuthedApiSource('refreshable');
    const stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;
    const cred = makeCredentialManager({ cachedToken: null, refreshedToken: 'fresh-tok' });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'refreshable', autoEnable: false });

    expect(cred.refreshCalls).toBeGreaterThanOrEqual(1);
    const sent = stub.calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(sent?.['Authorization']).toBe('Bearer fresh-tok');
  });

  it('a 401 authed probe reads as failing, with the response excerpt', async () => {
    writeAuthedApiSource('expired');
    ({ restore: restoreFetch } = installFetchStub(() => new Response('{"message":"token expired"}', { status: 401 })));
    const cred = makeCredentialManager({ cachedToken: 'stale-token' });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'expired', autoEnable: false })).content[0]?.text ?? '';

    expect(text).toContain('API returned 401 (credentials invalid or expired)');
    expect(text).toContain('token expired');
    expect(text).not.toContain('Validation passed**');
  });

  it('a 400 that rejects the key surfaces the body and the re-auth hint, not a pass', async () => {
    writeAuthedApiSource('rejected', { authType: 'header', headerName: 'x-goog-api-key' });
    ({ restore: restoreFetch } = installFetchStub(() =>
      new Response(
        JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }),
        { status: 400 }
      )
    ));
    const cred = makeCredentialManager({ cachedToken: 'AIzaSy' + 'k'.repeat(33) });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    const text = (await handleSourceTest(ctx, { sourceSlug: 'rejected', autoEnable: false })).content[0]?.text ?? '';

    expect(text).not.toContain('Authenticated request succeeded');
    expect(text).toContain('API returned 400');
    expect(text).toContain('API key not valid');
    expect(text).toContain('re-authenticate the source');
    expect(text).toContain('Validation passed with warnings');
  });
});
