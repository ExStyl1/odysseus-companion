/**
 * UA1.16 — the t-artifacts client. NOTHING here reaches a network: `fetch`,
 * `printToken` and `resolveDpRuntime` are injected on every client, and the
 * token is an obviously fake string assembled at runtime.
 */
import { describe, expect, test } from 'bun:test';
import { isDeniedNetworkTarget } from '../config/network-address-guard.ts';
import { DpAuthError, DpAuthServiceError, DpSpawnFailedError } from '../auth/dp/errors.ts';
import {
  ArtifactClientError,
  T_ARTIFACTS_ORIGIN,
  artifactPolicyRefusal,
  buildPublishRequestBody,
  createTArtifactsClient,
  headerLoggingTransportRefusal,
  resolveArtifactId,
  type ArtifactClientLog,
  type ArtifactFetch,
  type PublishRequest,
  type TArtifactsClientOptions,
} from './t-artifacts-client.ts';

/** Fake, and built at runtime so no token-shaped literal sits in the source. */
const FAKE_TOKEN = ['fake', 'dp', 'token', 'for', 'tests', String(process.pid)].join('-');
const ID = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 characters, the current id length
const PAGE_URL = `${T_ARTIFACTS_ORIGIN}/a/${ID}`;

interface Rig {
  options: TArtifactsClientOptions;
  calls: Array<{ url: string; init: RequestInit }>;
  tokenCalls: number;
  logs: string[];
}

function rig(
  respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => json(200, { id: ID, url: PAGE_URL, title: 'T', expires_at: '2026-10-09T00:00:00Z', retention_days: 7 }),
  overrides: Partial<TArtifactsClientOptions> = {},
): Rig {
  const state: Rig = { options: {}, calls: [], tokenCalls: 0, logs: [] };
  const fetch: ArtifactFetch = async (url, init) => {
    state.calls.push({ url, init });
    return respond(url, init);
  };
  const log: ArtifactClientLog = { info: (message, detail) => { state.logs.push(`${message} ${JSON.stringify(detail)}`); } };
  state.options = {
    fetch,
    printToken: async () => { state.tokenCalls += 1; return FAKE_TOKEN; },
    resolveDpRuntime: () => ({ dpPath: '/nonexistent/dp-for-tests', source: 'system' }),
    env: {},
    log,
    ...overrides,
  };
  return state;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const REQUEST: PublishRequest = {
  content: '<h1>Hello</h1>',
  contentType: 'html',
  title: 'Hello &amp; welcome',
  emoji: '\u{1F4CA}',
  description: 'A test page',
  retentionDays: 3,
};

async function rejection(promise: Promise<unknown>): Promise<ArtifactClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactClientError);
    return error as ArtifactClientError;
  }
  throw new Error('expected a rejection');
}

describe('UA1.16 positive arms', () => {
  test('create is ONE POST to the fixed origin carrying exactly the publishRequest fields', async () => {
    const r = rig();
    const record = await createTArtifactsClient(r.options).createArtifact(REQUEST);
    expect(r.calls).toHaveLength(1);
    const { url, init } = r.calls[0]!;
    expect(url).toBe(`${T_ARTIFACTS_ORIGIN}/api/artifacts`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['content', 'content_type', 'description', 'emoji', 'retention_days', 'title']);
    expect(body).toEqual({ content: '<h1>Hello</h1>', content_type: 'html', title: 'Hello &amp; welcome', emoji: '\u{1F4CA}', description: 'A test page', retention_days: 3 });
    expect(record).toEqual({ id: ID, url: PAGE_URL, title: 'T', expiresAt: '2026-10-09T00:00:00Z', retentionDays: 7 });
  });

  test('optional fields are ABSENT from the body, never null or undefined (boundary)', () => {
    const body = buildPublishRequestBody({ content: '# x', contentType: 'markdown', title: 'x', emoji: '\u{1F4C4}' });
    expect(Object.keys(body).sort()).toEqual(['content', 'content_type', 'emoji', 'title']);
  });

  test('an update is ONE PUT to the same id and keeps the URL', async () => {
    const r = rig();
    const client = createTArtifactsClient(r.options);
    const updated = await client.updateArtifact({ url: PAGE_URL }, { ...REQUEST, retentionDays: undefined });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.init.method).toBe('PUT');
    expect(r.calls[0]!.url).toBe(`${T_ARTIFACTS_ORIGIN}/api/artifacts/${ID}`);
    expect(JSON.parse(String(r.calls[0]!.init.body))).not.toHaveProperty('retention_days');
    expect(updated.url).toBe(PAGE_URL);
    expect(updated.id).toBe(ID);
  });

  test('a token is fetched for EVERY request — never cached', async () => {
    const r = rig();
    const client = createTArtifactsClient(r.options);
    await client.createArtifact(REQUEST);
    await client.createArtifact(REQUEST);
    expect(r.tokenCalls).toBe(2);
  });

  test('list, patch and delete use the documented verbs and paths', async () => {
    const r = rig((url, init) => {
      if (url.endsWith('/mine')) return json(200, [{ id: ID, url: PAGE_URL, title: 'T', emoji: '\u{1F4CA}', expires_at: null, retention_days: 0 }, { url: 'https://elsewhere.example/x' }]);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return json(200, { id: ID, url: PAGE_URL, title: 'T', expires_at: null, retention_days: 0 });
    });
    const client = createTArtifactsClient(r.options);
    const owned = await client.listOwnedArtifacts();
    expect(owned).toEqual([{ id: ID, url: PAGE_URL, title: 'T', emoji: '\u{1F4CA}', expiresAt: null, retentionDays: 0 }]);
    const patched = await client.patchArtifact({ id: ID }, { retentionDays: 0 });
    expect(patched.expiresAt).toBeNull();
    await client.deleteArtifact({ id: ID });
    expect(r.calls.map(call => `${call.init.method} ${call.url.slice(T_ARTIFACTS_ORIGIN.length)}`)).toEqual([
      'GET /api/artifacts/mine',
      `PATCH /api/artifacts/${ID}`,
      `DELETE /api/artifacts/${ID}`,
    ]);
    expect(JSON.parse(String(r.calls[1]!.init.body))).toEqual({ retention_days: 0 });
  });
});

describe('UA1.16 token arms', () => {
  test('printToken answering undefined sends NO request and answers needs-login', async () => {
    const r = rig(undefined, { printToken: async () => undefined });
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('needs-login');
    expect(r.calls).toHaveLength(0);
  });

  const throwsCases: Array<[string, () => Error, string]> = [
    ['Timeout', () => new DpAuthServiceError(DpAuthError.Timeout, 'dp print-token timed out'), 'network'],
    ['Cancelled', () => new DpAuthServiceError(DpAuthError.Cancelled, 'dp print-token cancelled'), 'network'],
    ['DpSpawnFailedError', () => new DpSpawnFailedError('dp print-token could not start dp', 'ENOENT'), 'dp-unavailable'],
    ['ExecFailed', () => new DpAuthServiceError(DpAuthError.ExecFailed, 'dp print-token failed'), 'dp-unavailable'],
  ];
  for (const [name, make, kind] of throwsCases) {
    test(`printToken throwing ${name} → ${kind}, no request`, async () => {
      const r = rig(undefined, { printToken: async () => { throw make(); } });
      const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
      expect(error.kind).toBe(kind as ArtifactClientError['kind']);
      expect(r.calls).toHaveLength(0);
    });
  }

  test('no dp on the machine (DpNotFound from the ladder) → dp-unavailable, no request', async () => {
    const r = rig(undefined, { resolveDpRuntime: () => { throw new DpAuthServiceError(DpAuthError.DpNotFound, 'not found'); } });
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('dp-unavailable');
    expect(r.calls).toHaveLength(0);
  });

  test('the resolved dp path and workdir are the ones printToken receives', async () => {
    const seen: Array<{ path: string; workdir?: string; timeoutMs?: number }> = [];
    const r = rig(undefined, {
      resolveDpRuntime: () => ({ dpPath: '/opt/fake/dp', workdir: '/opt/fake/state', source: 'override' }),
      printToken: async (path, opts) => { seen.push({ path, workdir: opts?.workdir, timeoutMs: opts?.timeoutMs }); return FAKE_TOKEN; },
    });
    await createTArtifactsClient(r.options).createArtifact(REQUEST);
    expect(seen).toEqual([{ path: '/opt/fake/dp', workdir: '/opt/fake/state', timeoutMs: 30_000 }]);
  });
});

describe('UA1.16 network arms', () => {
  test('a 401 answers needs-login with NO second request and no second dp call', async () => {
    const r = rig(() => json(401, { error: 'unauthorized' }));
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('needs-login');
    expect(error.status).toBe(401);
    expect(r.calls).toHaveLength(1);
    expect(r.tokenCalls).toBe(1);
  });

  test('a 302 to another origin answers network with NO second request', async () => {
    const r = rig(() => new Response(null, { status: 302, headers: { location: 'https://attacker.example/collect' } }));
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('network');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.init.redirect).toBe('error');
  });

  test('a fetch that REJECTS (what redirect:"error" does on a real 3xx) answers network', async () => {
    const r = rig(() => { throw new TypeError(`fetch failed: redirect to https://attacker.example with Bearer ${FAKE_TOKEN}`); });
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain(FAKE_TOKEN);
  });

  test('status → kind table', async () => {
    const table: Array<[number, string]> = [[403, 'forbidden'], [404, 'gone'], [410, 'gone'], [413, 'too-large'], [400, 'invalid'], [422, 'invalid'], [500, 'server'], [503, 'server']];
    for (const [status, kind] of table) {
      const r = rig(() => json(status, { error: 'x' }));
      const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
      expect(`${status} ${error.kind}`).toBe(`${status} ${kind}`);
    }
  });

  test('an answer whose link is on another origin is refused (server), never handed on', async () => {
    const r = rig(() => json(201, { id: ID, url: 'https://elsewhere.example/a/x', title: 'T', expires_at: null, retention_days: 0 }));
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('server');
  });

  test('the 30 s budget is applied as an abort signal (a hung service answers network)', async () => {
    const r = rig((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
    }), { timeoutMs: 20 });
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('30 seconds');
  });
});

describe('UA1.16 local refusals happen before any dp call or request', () => {
  test('an update/delete url on another origin is refused before any network call', async () => {
    const r = rig();
    const client = createTArtifactsClient(r.options);
    for (const url of ['https://claude.ai/artifact/abc', 'http://t-artifacts.t-tech.team/a/' + ID, `https://user:pw@t-artifacts.t-tech.team/a/${ID}`, 'https://t-artifacts.t-tech.team.attacker.example/a/' + ID]) {
      const error = await rejection(client.updateArtifact({ url }, REQUEST));
      expect(error.kind).toBe('invalid');
      const deleteError = await rejection(client.deleteArtifact({ url }));
      expect(deleteError.kind).toBe('invalid');
    }
    expect(r.calls).toHaveLength(0);
    expect(r.tokenCalls).toBe(0);
  });

  test('an id cannot steer the request path', () => {
    expect(() => resolveArtifactId({ id: '../../admin' })).toThrow(ArtifactClientError);
    expect(() => resolveArtifactId({ id: 'a/b' })).toThrow(ArtifactClientError);
    expect(resolveArtifactId({ url: `${PAGE_URL}-my-slug` })).toBe(ID);
    expect(resolveArtifactId({ url: `${T_ARTIFACTS_ORIGIN}/a/AbCdEfGhIjK-old-slug` })).toBe('AbCdEfGhIjK');
  });

  test('T_ARTIFACTS_ORIGIN, ARTIFACT_SERVICE_URL and ARTIFACT_AUTH_TOKEN in process.env change nothing', async () => {
    // The REAL process.env (no `options.env`), read through a FRESH module
    // instance so a load-time read is caught too; compared to the LITERAL
    // origin, never to the module's own constant. Bun 1.3.14: delete, then
    // assign — on the restore path as well (docs/agents/traps.md).
    const names = ['T_ARTIFACTS_ORIGIN', 'ARTIFACT_SERVICE_URL', 'ARTIFACT_AUTH_TOKEN', 'T_ARTIFACTS_TOKEN'] as const;
    const snapshot = names.map(name => [name, process.env[name]] as const);
    const envToken = ['env', 'token', 'must', 'not', 'be', 'used'].join('-');
    try {
      for (const name of names) {
        delete process.env[name];
        process.env[name] = name.endsWith('TOKEN') ? envToken : 'https://attacker.example';
      }
      const fresh = await import(`./t-artifacts-client.ts?env-arm=${Date.now()}`) as typeof import('./t-artifacts-client.ts');
      expect(fresh.T_ARTIFACTS_ORIGIN).toBe('https://t-artifacts.t-tech.team');
      const r = rig();
      delete r.options.env; // production default: process.env at call time
      await fresh.createTArtifactsClient(r.options).createArtifact(REQUEST);
      expect(r.calls.map(call => call.url)).toEqual(['https://t-artifacts.t-tech.team/api/artifacts']);
      expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    } finally {
      for (const [name, value] of snapshot) {
        delete process.env[name];
        if (value !== undefined) process.env[name] = value;
      }
    }
  });

  test('BUN_CONFIG_VERBOSE_FETCH set → no dp call and no request (network, the variable named)', async () => {
    const r = rig(undefined, { env: { BUN_CONFIG_VERBOSE_FETCH: 'curl' } });
    const error = await rejection(createTArtifactsClient(r.options).createArtifact(REQUEST));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('BUN_CONFIG_VERBOSE_FETCH');
    expect(r.calls).toHaveLength(0);
    expect(r.tokenCalls).toBe(0);
  });

  test('NODE_DEBUG naming fetch/undici/http/a wildcard refuses; an unrelated NODE_DEBUG does not', () => {
    for (const value of ['fetch', 'undici', 'http', 'net,HTTP', 'http2', '*']) {
      expect(headerLoggingTransportRefusal({ NODE_DEBUG: value }), value).not.toBeNull();
    }
    expect(headerLoggingTransportRefusal({ NODE_DEBUG: 'module,fs' })).toBeNull();
    expect(headerLoggingTransportRefusal({ BUN_CONFIG_VERBOSE_FETCH: '' })).toBeNull();
    expect(headerLoggingTransportRefusal({})).toBeNull();
  });

  test('a managed deniedDomains / allowlist refuses with kind policy before any dp call', async () => {
    const denied = rig(undefined, { networkPolicy: () => ({ deniedDomains: ['*.t-tech.team'] }) });
    expect((await rejection(createTArtifactsClient(denied.options).createArtifact(REQUEST))).kind).toBe('policy');
    const outside = rig(undefined, { networkPolicy: () => ({ allowManagedDomainsOnly: true, allowedDomains: ['github.com'] }) });
    expect((await rejection(createTArtifactsClient(outside.options).createArtifact(REQUEST))).kind).toBe('policy');
    expect(denied.calls.length + outside.calls.length + denied.tokenCalls + outside.tokenCalls).toBe(0);
    // Control: the same lock with the host on the allowlist sends.
    const allowed = rig(undefined, { networkPolicy: () => ({ allowManagedDomainsOnly: true, allowedDomains: ['t-tech.team'] }) });
    await createTArtifactsClient(allowed.options).createArtifact(REQUEST);
    expect(allowed.calls).toHaveLength(1);
  });

  test('the policy predicate agrees with network-address-guard over a table (no drift)', async () => {
    const domainsTable = ['t-artifacts.t-tech.team', '*.t-tech.team', 't-tech.team', 'tech.team', 'artifacts.t-tech.team', '*', '', 'T-TECH.TEAM.', 'example.com'];
    for (const domain of domainsTable) {
      const ours = artifactPolicyRefusal({ deniedDomains: [domain] }) !== null;
      const theirs = (await isDeniedNetworkTarget('t-artifacts.t-tech.team', { resolve: async () => ['93.184.216.34'], deniedDomains: [domain] })).denied;
      expect(`${domain}: ${ours}`).toBe(`${domain}: ${theirs}`);
      const oursAllow = artifactPolicyRefusal({ allowManagedDomainsOnly: true, allowedDomains: [domain] }) !== null;
      const theirsAllow = (await isDeniedNetworkTarget('t-artifacts.t-tech.team', { resolve: async () => ['93.184.216.34'], deniedDomains: [], managedAllowlist: [domain] })).denied;
      expect(`allow ${domain}: ${oursAllow}`).toBe(`allow ${domain}: ${theirsAllow}`);
    }
  });

  test('retention_days outside 0..36500 is refused locally', async () => {
    const r = rig();
    const error = await rejection(createTArtifactsClient(r.options).createArtifact({ ...REQUEST, retentionDays: 36_501 }));
    expect(error.kind).toBe('invalid');
    expect(r.calls).toHaveLength(0);
  });

  test('content over 16 MiB is refused locally (too-large)', async () => {
    const r = rig();
    const error = await rejection(createTArtifactsClient(r.options).createArtifact({ ...REQUEST, content: 'x'.repeat(16 * 1024 * 1024 + 1) }));
    expect(error.kind).toBe('too-large');
    expect(r.calls).toHaveLength(0);
  });
});

describe('UA1.16 the token never leaves the request', () => {
  test('the token value appears in no error, log line or result across every path', async () => {
    const seen: string[] = [];
    const responders: Array<(url: string, init: RequestInit) => Response> = [
      () => json(201, { id: ID, url: PAGE_URL, title: 'T', expires_at: null, retention_days: 0 }),
      () => json(401, { error: `bad token ${FAKE_TOKEN}` }),
      () => json(500, { echo: FAKE_TOKEN }),
      () => new Response(null, { status: 302, headers: { location: `https://x.example/?t=${FAKE_TOKEN}` } }),
      () => { throw new Error(`socket hang up Authorization: Bearer ${FAKE_TOKEN}`); },
      () => new Response('not json', { status: 200 }),
    ];
    for (const respond of responders) {
      const r = rig(respond);
      try {
        seen.push(JSON.stringify(await createTArtifactsClient(r.options).createArtifact(REQUEST)));
      } catch (error) {
        seen.push(String(error), (error as Error).message, JSON.stringify(error), String((error as Error).stack));
      }
      seen.push(...r.logs);
      // Positive control: the token DID go out, on the header and nowhere else.
      expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toContain(FAKE_TOKEN);
    }
    expect(seen.length).toBeGreaterThan(10);
    for (const line of seen) expect(line).not.toContain(FAKE_TOKEN);
  });
});
