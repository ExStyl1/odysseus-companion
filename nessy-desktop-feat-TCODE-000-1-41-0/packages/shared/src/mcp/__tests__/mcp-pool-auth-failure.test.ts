/**
 * H1: a 401 or 403 marks a server as needing sign-in.
 *
 * Before this, the ONLY needs-auth signal in the product was an EMPTY
 * credential slot (`sourceNeedsAuthentication`). A token the provider revoked
 * leaves `isAuthenticated` true, so the server read as broken and the user was
 * never offered the one thing that would fix it. `McpClientPool` already saw
 * the rejection — at connect (`isRetryableDiscoveryError` classifies 4xx as
 * permanent) and on a tool call (`mcp.md:803`, helper-backed connections only)
 * — but the verdict never left the pool.
 *
 * What is pinned here:
 * - a connect answered 401 (and 403) is reported by `authNeededSlugs`
 * - a 500, a transport error and an app-level tool error are NOT — conflating
 *   a broken server with a signed-out one is the mirror-image defect
 * - a tool call answered 401 marks EVERY connection, not just helper-backed
 * - the verdict clears on the next successful connect or call (recoverable)
 * - `mcp.md:803`'s retry-once on a `headersHelper` connection is unchanged:
 *   re-run the helper, reconnect, retry EXACTLY once, mark only then
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { NessyMcpClient, type PoolClient } from '../client.ts';
import { McpClientPool, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;
const CACHED: ToolDescriptorStore = { read: () => [TOOL], write: () => {} };
const HTTP: SdkMcpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp' };

/** The shape the MCP SDK's HTTP transports throw: status on `code`. */
const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { code: status });

/**
 * The shape `NessyMcpClient.connect` produces when the handshake succeeds and
 * the `tools/list` health check is the request that gets rejected: a plain
 * Error whose `cause` carries the status.
 */
const wrappedHttpError = (status: number) =>
  new Error('MCP connection failed health check: forbidden', { cause: httpError(status) });

/**
 * A pool whose transport is faked at `openConnection` — the ONE seam
 * `McpClientPool` offers a fixture (`DA3.6`), so `connect()` keeps the
 * connection IDENTITY it owns and nothing here can drop it.
 *
 * **DA1.74 — this used to substitute the fake in a `registerClient` override,
 * and the reason it moved is not tidiness.** That override was correct: it
 * passed all four arguments, isolated connection key included. But it is the
 * exact shape `DA3.6` built `openConnection` to retire — a fixture reimplementing
 * the FILING method rather than the transport — and the two censuses that watch
 * this class are blind to it in opposite ways: `DA3.16`'s does not count it, and
 * `DA3.6`'s guard does not see it. A correct instance of a shape two guards
 * cannot read is the one that teaches the next fixture to copy it, and `DA3.8`
 * is what a copy costs (`connect` itself passed three arguments where the
 * signature takes four; every client filed under the shared identity while every
 * lookup used the isolated one; thirteen failures, one argument).
 *
 * `super.openConnection(request)` still runs FIRST and its result is discarded,
 * which is deliberate and is the property the old override had: the real
 * `headersHelper` resolution, the ws-target guard and the client construction
 * all live in that method, and this file pins the retry-once behaviour of
 * `mcp.md#use-dynamic-headers-for-custom-authentication`. Faking without
 * calling super would make those cases assert on a path that never ran. Nothing
 * connects — `NessyMcpClient`'s constructor opens no transport; `registerClient`
 * does, through `listTools()`, and it never sees the discarded client.
 */
class FakePool extends McpClientPool {
  readonly connectAttempts: string[] = [];
  readonly toolCalls: string[] = [];
  /** Thrown by the next connect, then consumed (undefined = connect succeeds). */
  connectFailures: unknown[] = [];
  /** Thrown by the next tool call, then consumed. */
  callFailures: unknown[] = [];
  /** When set, the tool call resolves with an app-level error instead. */
  callIsError = false;

  protected override async openConnection(request: McpOpenConnectionRequest): Promise<PoolClient | undefined> {
    this.connectAttempts.push(request.slug);
    const failure = this.connectFailures.shift();
    if (failure) throw failure;
    const real = await super.openConnection(request);
    // `undefined` is "this config opens no transport, and the reason is already
    // recorded" — an unknown server type, a refused ws target. Handing back a
    // working fake there would make those two paths untestable through this
    // pool and would contradict the base method's own contract.
    if (!real) return undefined;
    const slug = request.slug;
    return {
      listTools: async () => [TOOL],
      callTool: async () => {
        this.toolCalls.push(slug);
        const failure = this.callFailures.shift();
        if (failure) throw failure;
        if (this.callIsError) return { content: [{ type: 'text', text: 'tool blew up' }], isError: true };
        return { content: [{ type: 'text', text: `ok:${slug}` }] };
      },
      close: async () => {},
    };
  }
}

const pool = (options?: ConstructorParameters<typeof McpClientPool>[0]): FakePool =>
  new FakePool({ connectTimeoutMs: 500, toolDescriptorStore: CACHED, ...options });

describe('McpClientPool auth failures (H1)', () => {
  it.each([[401], [403]])('a connect the server answered %i needs sign-in, not repair', async (status) => {
    const subject = pool();
    subject.connectFailures = [httpError(status)];

    expect(await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' })).toEqual(['jira']);

    expect(subject.authNeededSlugs('L')).toEqual(['jira']);
    // Connection health is untouched: the server IS also unusable right now.
    expect(subject.health('L').failed).toEqual(['jira']);
  });

  it('finds the status through the cause chain a rejected health check wraps it in', async () => {
    const subject = pool();
    subject.connectFailures = [wrappedHttpError(403)];

    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });

    expect(subject.authNeededSlugs('L')).toEqual(['jira']);
  });

  it.each([
    ['a 500', httpError(500)],
    ['a 404', httpError(404)],
    ['a transport error', Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })],
  ])('%s is a broken server, NOT a sign-in prompt', async (_label, failure) => {
    const subject = pool();
    subject.connectFailures = [failure];

    expect(await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' })).toEqual(['jira']);

    expect(subject.authNeededSlugs('L')).toEqual([]);
    expect(subject.health('L').failed).toEqual(['jira']);
  });

  it('marks a 401 on a TOOL CALL of a plain connection — no headersHelper needed', async () => {
    const subject = pool();
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    subject.callFailures = [httpError(401)];

    const result = await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

    expect(result.isError).toBe(true);
    expect(subject.authNeededSlugs('L')).toEqual(['jira']);
    // No helper, so no retry: exactly one call was made.
    expect(subject.toolCalls).toEqual(['jira']);
    // The connection itself is healthy; only the credential is not.
    expect(subject.health('L').failed).toEqual([]);
  });

  it('does not mark an app-level tool error or a 500 on a tool call', async () => {
    const subject = pool();
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });

    subject.callFailures = [httpError(500)];
    expect((await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' })).isError).toBe(true);
    expect(subject.authNeededSlugs('L')).toEqual([]);

    subject.callIsError = true;
    expect((await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' })).isError).toBe(true);
    expect(subject.authNeededSlugs('L')).toEqual([]);
  });

  it('clears the verdict when the user signs in again and the call succeeds', async () => {
    const subject = pool();
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    subject.callFailures = [httpError(401)];
    await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });
    expect(subject.authNeededSlugs('L')).toEqual(['jira']);

    // The re-authenticated call goes through.
    const recovered = await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

    expect(recovered).toMatchObject({ content: 'ok:jira', isError: false });
    expect(subject.authNeededSlugs('L')).toEqual([]);
  });

  it('clears the verdict for a re-authenticated source: new credential, new identity', async () => {
    const subject = pool();
    subject.connectFailures = [httpError(401)];
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    expect(subject.authNeededSlugs('L')).toEqual(['jira']);

    // Signing in re-materializes the source with the fresh credential, which is
    // a different connection identity — and the reconcile sweeps the old one.
    const reauthed: SdkMcpServerConfig = { ...HTTP, headers: { Authorization: 'Bearer fresh' } };
    await subject.sync({ jira: reauthed }, {}, { leaserId: 'L' });

    expect(subject.authNeededSlugs('L')).toEqual([]);
    expect(subject.health('L')).toMatchObject({ status: 'ready', failed: [] });
  });

  it('clears the verdict when the same identity reconnects successfully', async () => {
    const subject = pool();
    subject.connectFailures = [httpError(401)];
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    expect(subject.authNeededSlugs('L')).toEqual(['jira']);

    // Same config, so the same connection key — only a successful connect can
    // clear this one. (A `headersHelper` server mints its token per connect and
    // therefore keeps its identity across a re-auth; this is that path.)
    await subject.dropLeaser('L');
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });

    expect(subject.authNeededSlugs('L')).toEqual([]);
  });

  it('scopes the verdict to the leaser that desires the server', async () => {
    const subject = pool();
    subject.connectFailures = [httpError(401)];
    await subject.sync({ jira: HTTP }, {}, { leaserId: 'L' });
    await subject.sync({}, {}, { leaserId: 'M' });

    expect(subject.authNeededSlugs('L')).toEqual(['jira']);
    expect(subject.authNeededSlugs('M')).toEqual([]);
  });
});

/**
 * The producer half of the cause-chain walk above: a server may accept
 * `initialize` and reject the `tools/list` health check instead, and that error
 * is re-wrapped. Without `cause` the status dies here and the pool sees an
 * unclassifiable failure — i.e. "broken server" — for a plain 401.
 */
describe('NessyMcpClient health-check failure keeps the status', () => {
  it('carries the transport status on `cause`', async () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.test/mcp' });
    const inner = (client as unknown as { client: Record<string, unknown> }).client;
    inner.connect = async () => {};
    inner.request = async () => { throw httpError(401); }; // F1.643: connect lists via `request`
    inner.close = async () => {};

    const error = await client.connect().then(() => undefined, (err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('MCP connection failed health check');
    expect((error as { cause?: { code?: number } }).cause?.code).toBe(401);
  });
});

describe('McpClientPool headersHelper retry-once (mcp.md:803) is unchanged', () => {
  const helperConfig = (counterPath: string): SdkMcpServerConfig => ({
    type: 'http',
    url: 'https://mcp.example.test/mcp',
    headersHelper: { command: `echo x >> ${counterPath}; echo '{"Authorization": "Bearer minted"}'` },
  });

  const helperRuns = (counterPath: string): number =>
    readFileSync(counterPath, 'utf8').split('\n').filter(Boolean).length;

  async function withCounter(run: (counterPath: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-auth-'));
    const counterPath = join(dir, 'helper-runs');
    writeFileSync(counterPath, '');
    try {
      await run(counterPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('re-runs the helper, reconnects, retries ONCE, and marks only if that fails too', async () => {
    await withCounter(async (counterPath) => {
      const subject = pool();
      await subject.sync({ jira: helperConfig(counterPath) }, {}, { leaserId: 'L' });
      expect(helperRuns(counterPath)).toBe(1);
      // Both the first call and the retry are rejected.
      subject.callFailures = [httpError(401), httpError(401)];

      const result = await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

      expect(result.isError).toBe(true);
      // The helper ran fresh on the reconnect (`mcp.md:801`, `mcp.md:803`).
      expect(helperRuns(counterPath)).toBe(2);
      expect(subject.connectAttempts).toEqual(['jira', 'jira']);
      // EXACTLY once — not a retry loop.
      expect(subject.toolCalls).toEqual(['jira', 'jira']);
      expect(subject.authNeededSlugs('L')).toEqual(['jira']);
    });
  }, 20_000);

  it('does NOT mark when the retry with fresh headers succeeds', async () => {
    await withCounter(async (counterPath) => {
      const subject = pool();
      await subject.sync({ jira: helperConfig(counterPath) }, {}, { leaserId: 'L' });
      subject.callFailures = [httpError(401)];

      const result = await subject.callTool('mcp__jira__echo', {}, undefined, { leaserId: 'L' });

      expect(result).toMatchObject({ content: 'ok:jira', isError: false });
      expect(helperRuns(counterPath)).toBe(2);
      expect(subject.toolCalls).toEqual(['jira', 'jira']);
      expect(subject.authNeededSlugs('L')).toEqual([]);
    });
  }, 20_000);
});
