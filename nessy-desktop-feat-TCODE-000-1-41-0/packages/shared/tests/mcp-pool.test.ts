/**
 * Tests for McpClientPool — config change detection during sync().
 *
 * Verifies that when a source's OAuth token is refreshed, sync() reconnects
 * the source with fresh credentials instead of keeping a stale connection.
 * This was the root cause of MCP connection drops every 30-60 minutes:
 * tokens were refreshed but never applied to existing transports.
 */
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpClientPool, MCP_CHANNEL_CAPABILITY, sdkConfigToClientConfig, type ApiServerConfig, type ChannelPolicy, type McpOpenConnectionRequest } from '../src/mcp/mcp-pool.ts';
import type { SdkMcpServerConfig } from '../src/agent/backend/types.ts';
import type { McpChannelMessage, PoolClient } from '../src/mcp/client.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// ============================================================
// Helpers
// ============================================================

const mockTools: Tool[] = [
  {
    name: 'test-tool',
    description: 'A test tool',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

function makeMockClient(): PoolClient {
  return {
    listTools: async () => mockTools,
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => {},
  };
}

/**
 * P6.341 — a channel double must DECLARE itself a channel, because the
 * declaration is now the first of the dispatcher's two preconditions.
 *
 * `channels-reference.md#server-options`:
 * "`capabilities.experimental['claude/channel']` | `object` | Required. Always
 * `{}`. Presence registers the notification listener."
 *
 * `declares: false` is the negative arm, and it is what every ORDINARY source
 * looks like — the state the gate exists to refuse.
 */
function makeChannelClient(declares = true): PoolClient & { emitChannel(message: McpChannelMessage): void } {
  let handler: ((message: McpChannelMessage) => void) | undefined;
  return {
    listTools: async () => mockTools,
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => {},
    getServerCapabilities: () => (declares
      ? { tools: {}, experimental: { [MCP_CHANNEL_CAPABILITY]: {} } }
      : { tools: {} }),
    setChannelHandler(next) { handler = next; },
    emitChannel(message) { handler?.(message); },
  };
}

function httpConfig(token: string, url = 'https://mcp.example.com'): Extract<SdkMcpServerConfig, { type: 'http' | 'sse' }> {
  return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * The headers of a config the pool recorded, narrowed off the union.
 *
 * `headers` lives only on the http/sse arm of `SdkMcpServerConfig`, and what
 * the pool hands back is the whole union. This THROWS rather than returning
 * `undefined` for a stdio config, and that is deliberate: one assertion below
 * is `toEqual(config2.headers)`, so a silent `undefined` on the left would be
 * compared against a right-hand side that could also be `undefined` and pass
 * having verified nothing.
 */
function httpHeaders(config: SdkMcpServerConfig): Record<string, string> | undefined {
  if (config.type !== 'http' && config.type !== 'sse') {
    throw new Error(`expected an http/sse MCP config, got type '${config.type}'`);
  }
  return config.headers;
}

function pluginStdioConfig(hash: string): Extract<SdkMcpServerConfig, { type: 'stdio' }> {
  return {
    type: 'stdio',
    command: process.execPath,
    args: ['/cache/plugin/server.js'],
    cwd: '/cache/plugin',
    env: { NESSY_PLUGIN_DATA: '/data/plugin' },
    inheritProcessEnv: false,
    pluginRuntime: {
      bundleRootPath: '/cache/plugin',
      dataPath: '/data/plugin',
      expectedBundleHash: hash,
    },
  };
}

/**
 * Subclass that intercepts connect/disconnect to avoid real MCP connections
 * while letting sync()'s config-change detection logic run against real state.
 */
class TestablePool extends McpClientPool {
  public connectCalls: Array<{ slug: string; config: SdkMcpServerConfig }> = [];
  public apiConnectCalls: Array<{ slug: string; server: McpServer }> = [];
  public disconnectCalls: string[] = [];

  // DA3.6 — this site is the census's SECOND blind spot: it carries no
  // `override` keyword, so the sweep that counted `override async connect(`
  // scored 13 sites in this file and there are 14.
  protected override async openConnection(
    { slug, config }: McpOpenConnectionRequest,
  ): Promise<PoolClient> {
    this.connectCalls.push({ slug, config });
    return makeMockClient();
  }

  async disconnect(slug: string, connectionKey?: string): Promise<void> {
    this.disconnectCalls.push(slug);
    await super.disconnect(slug, connectionKey);
  }

  async connectInProcess(slug: string, server: McpServer): Promise<void> {
    this.apiConnectCalls.push({ slug, server });
    await this.registerClient(slug, makeMockClient(), server);
  }

  /** Reset tracking arrays between sync phases within a single test */
  resetTracking(): void {
    this.connectCalls = [];
    this.apiConnectCalls = [];
    this.disconnectCalls = [];
  }
}

function apiConfig(server: McpServer): ApiServerConfig {
  return { type: 'sdk', instance: server };
}

// ============================================================
// Tests
// ============================================================

describe('McpClientPool.sync — config change detection', () => {
  let pool: TestablePool;

  beforeEach(() => {
    pool = new TestablePool();
  });

  it('reconnects when Authorization header changes (token refresh)', async () => {
    await pool.sync({ nessy: httpConfig('old-token') });
    expect(pool.isConnected('nessy')).toBe(true);
    pool.resetTracking();

    await pool.sync({ nessy: httpConfig('new-token') });

    expect(pool.disconnectCalls).toEqual(['nessy']);
    expect(pool.connectCalls).toHaveLength(1);
    expect(httpHeaders(pool.connectCalls[0]!.config)?.Authorization).toBe('Bearer new-token');
    expect(pool.isConnected('nessy')).toBe(true);
  });

  it('does not reconnect when config is unchanged', async () => {
    const config = httpConfig('token-1');
    await pool.sync({ nessy: config });
    pool.resetTracking();

    await pool.sync({ nessy: config });

    expect(pool.connectCalls).toHaveLength(0);
    expect(pool.disconnectCalls).toHaveLength(0);
  });

  it('reconnects when URL changes', async () => {
    await pool.sync({ nessy: httpConfig('token', 'https://old.example.com') });
    pool.resetTracking();

    await pool.sync({ nessy: httpConfig('token', 'https://new.example.com') });

    expect(pool.disconnectCalls).toEqual(['nessy']);
    expect(pool.connectCalls).toHaveLength(1);
  });

  it('reconnects supervised plugin stdio when the pinned bundle hash changes', async () => {
    await pool.sync({ plugin: pluginStdioConfig('a'.repeat(64)) });
    pool.resetTracking();

    await pool.sync({ plugin: pluginStdioConfig('b'.repeat(64)) });

    expect(pool.disconnectCalls).toEqual(['plugin']);
    expect(pool.connectCalls).toHaveLength(1);
    expect(pool.connectCalls[0]?.config).toMatchObject({
      pluginRuntime: { expectedBundleHash: 'b'.repeat(64) },
    });
  });

  it('does not reconnect supervised plugin stdio when its exact config is unchanged', async () => {
    const config = pluginStdioConfig('a'.repeat(64));
    await pool.sync({ plugin: config });
    pool.resetTracking();

    await pool.sync({ plugin: { ...config, env: { ...config.env } } });

    expect(pool.disconnectCalls).toEqual([]);
    expect(pool.connectCalls).toEqual([]);
  });

  it('reconnects when a custom authentication header changes', async () => {
    const config1: SdkMcpServerConfig = {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { authorization: 'Bearer same', 'X-API-Key': 'old-key' },
    };
    const config2: SdkMcpServerConfig = {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { authorization: 'Bearer same', 'X-API-Key': 'new-key' },
    };

    await pool.sync({ nessy: config1 });
    pool.resetTracking();

    await pool.sync({ nessy: config2 });

    expect(pool.disconnectCalls).toEqual(['nessy']);
    expect(pool.connectCalls).toHaveLength(1);
    expect(httpHeaders(pool.connectCalls[0]!.config)).toEqual(config2.headers);
  });

  it('disconnects sources removed from config', async () => {
    const config = httpConfig('token');
    await pool.sync({ nessy: config, linear: config });
    pool.resetTracking();

    await pool.sync({ nessy: config });

    expect(pool.disconnectCalls).toEqual(['linear']);
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(false);
  });

  it('handles add + remove + refresh in a single sync', async () => {
    await pool.sync({
      nessy: httpConfig('old-nessy-token'),
      linear: httpConfig('linear-token', 'https://linear.example.com'),
    });
    pool.resetTracking();

    // nessy: token refreshed, linear: removed, github: added
    await pool.sync({
      nessy: httpConfig('new-nessy-token'),
      github: httpConfig('gh-token', 'https://github.example.com'),
    });

    expect(pool.disconnectCalls).toContain('linear');
    expect(pool.disconnectCalls).toContain('nessy');
    expect(httpHeaders(pool.connectCalls.find(c => c.slug === 'nessy')!.config)?.Authorization).toBe('Bearer new-nessy-token');
    expect(pool.connectCalls.find(c => c.slug === 'github')).toBeDefined();
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(false);
    expect(pool.isConnected('github')).toBe(true);
  });

  it('reports failure when reconnect fails after token refresh', async () => {
    let connectAttempts = 0;
    const failPool = new TestablePool();
    const origConnect = failPool.connect.bind(failPool);
    failPool.connect = async (slug: string, config: SdkMcpServerConfig) => {
      connectAttempts++;
      if (connectAttempts > 1) throw new Error('Server unavailable');
      return origConnect(slug, config);
    };

    await failPool.sync({ nessy: httpConfig('old-token') });
    expect(failPool.isConnected('nessy')).toBe(true);

    // Token refresh — disconnect succeeds but reconnect throws
    const failures = await failPool.sync({ nessy: httpConfig('new-token') });

    expect(failures).toContain('nessy');
    expect(failPool.isConnected('nessy')).toBe(false);
  });
});

describe('McpClientPool.sync — refcounted desired-set across leasers', () => {
  it('single implicit leaser is byte-equivalent to the pre-refcount owner', async () => {
    // No leaserId → the default single leaser. A second sync that drops a slug
    // disconnects it exactly as the single-owner pool always did.
    const pool = new TestablePool();
    const config = httpConfig('token');
    await pool.sync({ nessy: config, linear: config });
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(true);
    pool.resetTracking();

    await pool.sync({ nessy: config });

    expect(pool.disconnectCalls).toEqual(['linear']);
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(false);
  });

  it("a second leaser's sync does NOT disconnect the first leaser's server (union)", async () => {
    const pool = new TestablePool();
    const config = httpConfig('token');
    await pool.sync({ nessy: config }, {}, { leaserId: 'session-A' });
    pool.resetTracking();

    // Leaser B contributes only `linear`; the union still contains `nessy`, so
    // it must survive B's sync. Only `linear` is newly connected.
    await pool.sync({ linear: config }, {}, { leaserId: 'browse-B' });

    expect(pool.disconnectCalls).toEqual([]);
    expect(pool.connectCalls.map(c => c.slug)).toEqual(['linear']);
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(true);
  });

  it('pins a shared slug to each leaser config identity across a side-by-side plugin update', async () => {
    const calls: Array<{ token: string; tool: string }> = [];
    class VersionIsolatedPool extends McpClientPool {
      protected override async openConnection({ config }: McpOpenConnectionRequest): Promise<PoolClient> {
        const token = config.type === 'http' ? config.headers?.Authorization ?? 'missing' : 'missing';
        return {
          async listTools() {
            return [{
              name: 'read',
              description: `read with ${token}`,
              inputSchema: { type: 'object', properties: {} },
            }];
          },
          async callTool(tool: string) {
            calls.push({ token, tool });
            return { content: [{ type: 'text', text: `client:${token.slice('Bearer '.length)}` }] };
          },
          async close() {},
        } as unknown as PoolClient;
      }
    }

    const pool = new VersionIsolatedPool();
    await pool.sync({ shared: httpConfig('old-A') }, {}, { leaserId: 'A' });
    await pool.sync({ shared: httpConfig('new-B') }, {}, { leaserId: 'B' });

    expect(pool.getProxyToolDefs(['shared'], 'A')[0]?.description).toBe('read with Bearer old-A');
    expect(pool.getProxyToolDefs(['shared'], 'B')[0]?.description).toBe('read with Bearer new-B');
    expect((await pool.callTool('mcp__shared__read', {}, undefined, { leaserId: 'A' })).content)
      .toBe('client:old-A');
    expect((await pool.callTool('mcp__shared__read', {}, undefined, { leaserId: 'B' })).content)
      .toBe('client:new-B');
    expect(calls).toEqual([
      { token: 'Bearer old-A', tool: 'read' },
      { token: 'Bearer new-B', tool: 'read' },
    ]);

    await pool.dropLeaser('A');
    expect(pool.isConnected('shared', 'A')).toBe(false);
    expect(pool.isConnected('shared', 'B')).toBe(true);
    expect((await pool.callTool('mcp__shared__read', {}, undefined, { leaserId: 'B' })).content)
      .toBe('client:new-B');
  });

  it('fails a new leaser closed when its config cannot connect instead of falling back to another leaser', async () => {
    class FailClosedIdentityPool extends McpClientPool {
      protected override async openConnection({ config }: McpOpenConnectionRequest): Promise<PoolClient> {
        const token = config.type === 'http' ? config.headers?.Authorization ?? '' : '';
        if (token === 'Bearer new-B') throw new Error('new identity unavailable');
        return {
          async listTools() { return mockTools; },
          async callTool() { return { content: [{ type: 'text', text: 'client:old-A' }] }; },
          async close() {},
        } as unknown as PoolClient;
      }
    }

    const pool = new FailClosedIdentityPool();
    await pool.sync({ shared: httpConfig('old-A') }, {}, { leaserId: 'A' });
    expect(await pool.sync({ shared: httpConfig('new-B') }, {}, { leaserId: 'B' })).toEqual(['shared']);

    expect((await pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' })).content)
      .toBe('client:old-A');
    expect(await pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'B' }))
      .toEqual({ content: 'Tool not available in this session', isError: true });
    expect(pool.health('A')).toEqual({ status: 'ready', connected: ['shared'], failed: [], failureReasons: {} });
    // P6.715 — the failed side now says WHY, and the healthy side stays silent.
    expect(pool.health('B')).toEqual({
      status: 'unavailable',
      connected: [],
      failed: ['shared'],
      failureReasons: { shared: 'new identity unavailable' },
    });
  });

  it('does not retry an unchanged failed union when a redundant leaser joins or leaves', async () => {
    let connectAttempts = 0;
    class FailedUnionPool extends McpClientPool {
      protected override async openConnection(): Promise<PoolClient> {
        connectAttempts += 1;
        throw new Error('still unavailable');
      }
    }

    const pool = new FailedUnionPool();
    const config = httpConfig('token');
    expect(await pool.sync({ flaky: config }, {}, { leaserId: 'browse' })).toEqual(['flaky']);
    expect(connectAttempts).toBe(1);

    // A second leaser contributes the exact same connection identity. The
    // union did not change, so joining/leaving must reuse the recorded failed
    // state instead of serially paying another transport timeout.
    expect(await pool.sync({ flaky: config }, {}, { leaserId: 'session' })).toEqual(['flaky']);
    expect(connectAttempts).toBe(1);
    expect(pool.health('session')).toEqual({
      status: 'unavailable',
      connected: [],
      failed: ['flaky'],
      failureReasons: { flaky: 'still unavailable' },
    });

    expect(await pool.dropLeaser('session')).toEqual([]);
    expect(connectAttempts).toBe(1);
    expect(pool.health('browse')).toEqual({
      status: 'unavailable',
      connected: [],
      failed: ['flaky'],
      failureReasons: { flaky: 'still unavailable' },
    });
  });

  it('still reconciles when dropping the last leaser changes the union', async () => {
    const pool = new TestablePool();
    await pool.sync({ only: httpConfig('token') }, {}, { leaserId: 'session' });
    pool.resetTracking();

    await pool.dropLeaser('session');

    expect(pool.disconnectCalls).toEqual(['only']);
    expect(pool.isConnected('only')).toBe(false);
  });

  it('drains an in-flight old-identity call before closing it during a same-leaser rebind', async () => {
    let finishOld!: () => void;
    let oldStarted!: () => void;
    const started = new Promise<void>(resolve => { oldStarted = resolve; });
    const closes: string[] = [];
    class DrainingIdentityPool extends McpClientPool {
      protected override async openConnection({ config }: McpOpenConnectionRequest): Promise<PoolClient> {
        const token = config.type === 'http' ? config.headers?.Authorization ?? '' : '';
        const label = token.slice('Bearer '.length);
        return {
          async listTools() { return mockTools; },
          async callTool() {
            if (label === 'old') {
              oldStarted();
              await new Promise<void>(resolve => { finishOld = resolve; });
            }
            return { content: [{ type: 'text', text: `client:${label}` }] };
          },
          async close() { closes.push(label); },
        } as unknown as PoolClient;
      }
    }

    const pool = new DrainingIdentityPool();
    await pool.sync({ shared: httpConfig('old') }, {}, { leaserId: 'A' });
    const oldCall = pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' });
    await started;
    const rebind = pool.sync({ shared: httpConfig('new') }, {}, { leaserId: 'A' });
    await Promise.resolve();
    await Promise.resolve();
    expect(closes).toEqual([]);

    finishOld();
    expect((await oldCall).content).toBe('client:old');
    await rebind;
    expect(closes).toEqual(['old']);
    expect((await pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' })).content)
      .toBe('client:new');
  });

  it('refuses new calls once a connection identity starts draining', async () => {
    let releaseOld!: () => void;
    let oldStarted!: () => void;
    let drainStarted!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const started = new Promise<void>(resolve => { oldStarted = resolve; });
    const draining = new Promise<void>(resolve => { drainStarted = resolve; });
    let oldCallCount = 0;
    class FencedDrainPool extends McpClientPool {
      protected override async openConnection({ config }: McpOpenConnectionRequest): Promise<PoolClient> {
        const token = config.type === 'http' ? config.headers?.Authorization ?? '' : '';
        const label = token.slice('Bearer '.length);
        return {
          async listTools() { return mockTools; },
          async callTool() {
            if (label === 'old') {
              oldCallCount += 1;
              oldStarted();
              await oldGate;
            }
            return { content: [{ type: 'text', text: `client:${label}` }] };
          },
          async close() {},
        } as unknown as PoolClient;
      }

      override async disconnect(slug: string, connectionKey?: string): Promise<void> {
        const pending = super.disconnect(slug, connectionKey);
        drainStarted();
        await pending;
      }
    }

    const pool = new FencedDrainPool();
    await pool.sync({ shared: httpConfig('old') }, {}, { leaserId: 'A' });
    const oldCall = pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' });
    await started;
    const disconnect = pool.disconnect('shared');
    await draining;

    const lateCall = pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' });
    const callsBeforeRelease = oldCallCount;
    releaseOld();

    expect((await oldCall).content).toBe('client:old');
    expect(await lateCall).toMatchObject({
      content: 'MCP client for source "shared" is disconnecting.',
      isError: true,
      sourceSlug: 'shared',
    });
    expect(callsBeforeRelease).toBe(1);
    await disconnect;
    expect(pool.isConnected('shared', 'A')).toBe(false);
  });

  it('aborts a hung call after the bounded grace and closes the transport', async () => {
    let callStarted!: () => void;
    const started = new Promise<void>(resolve => { callStarted = resolve; });
    let callSignal: AbortSignal | undefined;
    let closes = 0;
    class HungCallPool extends McpClientPool {
      constructor() {
        super({ connectionDrainGraceMs: 5 });
      }

      protected override async openConnection(): Promise<PoolClient> {
        return {
          async listTools() { return mockTools; },
          async callTool(_name: string, _args: Record<string, unknown>, signal?: AbortSignal) {
            callSignal = signal;
            callStarted();
            return new Promise(() => {});
          },
          async close() { closes += 1; },
        } as unknown as PoolClient;
      }
    }

    const pool = new HungCallPool();
    await pool.sync({ shared: httpConfig('old') }, {}, { leaserId: 'A' });
    const hungCall = pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' });
    await started;

    await pool.disconnect('shared');

    expect(callSignal?.aborted).toBe(true);
    expect(closes).toBe(1);
    expect(await hungCall).toMatchObject({
      content: expect.stringContaining('mcp-connection-draining'),
      isError: true,
      sourceSlug: 'shared',
    });
    expect(pool.isConnected('shared', 'A')).toBe(false);
  });

  it('keeps a failed close fenced and propagates it until a proven retry succeeds', async () => {
    let closeAttempts = 0;
    class RetryClosePool extends McpClientPool {
      protected override async openConnection(): Promise<PoolClient> {
        return {
          async listTools() { return mockTools; },
          async callTool() { return { content: [{ type: 'text', text: 'ok' }] }; },
          async close() {
            closeAttempts += 1;
            if (closeAttempts === 1) throw new Error('process-stop-unproven');
          },
        } as unknown as PoolClient;
      }
    }

    const pool = new RetryClosePool();
    await pool.sync({ shared: httpConfig('token') }, {}, { leaserId: 'A' });

    await expect(pool.disconnect('shared')).rejects.toThrow('process-stop-unproven');
    expect(pool.isConnected('shared', 'A')).toBe(true);
    expect(await pool.callTool('mcp__shared__test-tool', {}, undefined, { leaserId: 'A' }))
      .toMatchObject({ content: 'MCP client for source "shared" is disconnecting.', isError: true });

    await pool.disconnect('shared');
    expect(closeAttempts).toBe(2);
    expect(pool.isConnected('shared', 'A')).toBe(false);
  });

  it('evicts only an unexpectedly closed identity and reconnects it on explicit sync', async () => {
    let connectionNumber = 0;
    const crashes: Array<() => void> = [];
    class CrashRecoveringPool extends McpClientPool {
      protected override async openConnection(): Promise<PoolClient> {
        const label = ++connectionNumber;
        let unexpectedClose: (() => void) | undefined;
        // The base files the client, and filing installs the close handler, so
        // the crasher rides the closure instead of a `registerClient` call.
        crashes.push(() => unexpectedClose?.());
        return {
          async listTools() { return mockTools; },
          async callTool() {
            return { content: [{ type: 'text', text: `client:${label}` }] };
          },
          async close() {},
          setUnexpectedCloseHandler(handler: () => void) { unexpectedClose = handler; },
        } as unknown as PoolClient;
      }
    }

    const pool = new CrashRecoveringPool();
    const configA = pluginStdioConfig('a'.repeat(64));
    const configB = pluginStdioConfig('b'.repeat(64));
    await pool.sync({ plugin: configA }, {}, { leaserId: 'A' });
    await pool.sync({ plugin: configB }, {}, { leaserId: 'B' });
    expect((await pool.callTool('mcp__plugin__test-tool', {}, undefined, { leaserId: 'A' })).content)
      .toBe('client:1');
    expect((await pool.callTool('mcp__plugin__test-tool', {}, undefined, { leaserId: 'B' })).content)
      .toBe('client:2');

    crashes[0]?.();

    expect(pool.health('A')).toEqual({
      status: 'unavailable',
      connected: [],
      failed: ['plugin'],
      failureReasons: { plugin: 'The server closed the connection unexpectedly.' },
    });
    expect(pool.health('B')).toEqual({ status: 'ready', connected: ['plugin'], failed: [], failureReasons: {} });
    await pool.sync({ plugin: configA }, {}, { leaserId: 'A' });
    expect(connectionNumber).toBe(3);
    // P6.715 — the reason goes with the verdict: a recovered connection carries no residue.
    expect(pool.health('A')).toEqual({ status: 'ready', connected: ['plugin'], failed: [], failureReasons: {} });
    expect((await pool.callTool('mcp__plugin__test-tool', {}, undefined, { leaserId: 'A' })).content)
      .toBe('client:3');
    expect((await pool.callTool('mcp__plugin__test-tool', {}, undefined, { leaserId: 'B' })).content)
      .toBe('client:2');
  });


  it('a server in ANY leaser set stays connected; leaving ALL sets disconnects it', async () => {
    const pool = new TestablePool();
    const config = httpConfig('token');
    // Both leasers want `shared`; only A wants `a-only`.
    await pool.sync({ shared: config, 'a-only': config }, {}, { leaserId: 'A' });
    await pool.sync({ shared: config }, {}, { leaserId: 'B' });
    pool.resetTracking();

    // A drops everything. `shared` still wanted by B → stays. `a-only` in no
    // set → disconnected.
    await pool.sync({}, {}, { leaserId: 'A' });
    expect(pool.disconnectCalls).toEqual(['a-only']);
    expect(pool.isConnected('shared')).toBe(true);
    expect(pool.isConnected('a-only')).toBe(false);
    pool.resetTracking();

    // Now B drops `shared` too → it leaves the last set → disconnected.
    await pool.sync({}, {}, { leaserId: 'B' });
    expect(pool.disconnectCalls).toEqual(['shared']);
    expect(pool.isConnected('shared')).toBe(false);
  });

  it('interleaved concurrent syncs from two leasers converge to the union', async () => {
    const pool = new TestablePool();
    const config = httpConfig('token');
    // Fire both without awaiting: they race onto the serialized sync chain.
    const a = pool.sync({ nessy: config }, {}, { leaserId: 'A' });
    const b = pool.sync({ linear: config }, {}, { leaserId: 'B' });
    await Promise.all([a, b]);

    // Convergence: BOTH servers connected, neither torn down by the other.
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(true);
    expect(pool.disconnectCalls).toEqual([]);
    expect(pool.connectCalls.map(c => c.slug).sort()).toEqual(['linear', 'nessy']);
  });

  it('a later sync from one leaser never tears down another leaser mid-flight', async () => {
    const pool = new TestablePool();
    const config = httpConfig('token');
    await pool.sync({ nessy: config }, {}, { leaserId: 'A' });
    pool.resetTracking();

    // B connects; concurrently A re-syncs its unchanged set. The union always
    // contains both, so no disconnect happens under any interleaving.
    const b = pool.sync({ linear: config }, {}, { leaserId: 'B' });
    const aAgain = pool.sync({ nessy: config }, {}, { leaserId: 'A' });
    await Promise.all([b, aAgain]);

    expect(pool.disconnectCalls).toEqual([]);
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(true);
  });

  it('each reconcile returns only the failures observed in its own union pass', async () => {
    const pool = new TestablePool();
    const config = httpConfig('token');
    const okA = await pool.sync({ nessy: config }, {}, { leaserId: 'A' });
    expect(okA).toEqual([]);
    // B adds a slug whose connect fails; the failure surfaces on B's call.
    const origConnect = pool.connect.bind(pool);
    pool.connect = async (slug: string, cfg: SdkMcpServerConfig) => {
      if (slug === 'bad') throw new Error('unavailable');
      return origConnect(slug, cfg);
    };
    const failB = await pool.sync({ bad: config }, {}, { leaserId: 'B' });
    expect(failB).toContain('bad');
    // A's server is untouched by B's failed connect.
    expect(pool.isConnected('nessy')).toBe(true);
  });

  it('disconnectAll clears every leaser desired set (empty union afterward)', async () => {
    const pool = new TestablePool();
    const config = httpConfig('token');
    await pool.sync({ nessy: config }, {}, { leaserId: 'A' });
    await pool.sync({ linear: config }, {}, { leaserId: 'B' });
    await pool.disconnectAll();
    pool.resetTracking();

    // A resync of the (now stale) leaser set is a fresh contribution — after
    // disconnectAll the union was empty, so only what A re-asks for connects,
    // and B's old `linear` is gone (its desired set was cleared).
    await pool.sync({ nessy: config }, {}, { leaserId: 'A' });
    expect(pool.isConnected('nessy')).toBe(true);
    expect(pool.isConnected('linear')).toBe(false);
    expect(pool.disconnectCalls).toEqual([]);
  });
});

describe('McpClientPool claude/channel routing', () => {
  it('routes each same-slug identity only to its active leaser subscription', async () => {
    class ChannelPool extends McpClientPool {
      readonly clientsByToken = new Map<string, ReturnType<typeof makeChannelClient>>();
      readonly keysByToken = new Map<string, string>();

      protected override async openConnection(
        { config, connectionKey }: McpOpenConnectionRequest,
      ): Promise<PoolClient> {
        const token = config.type === 'http' ? config.headers?.Authorization ?? '' : '';
        const client = makeChannelClient();
        this.clientsByToken.set(token, client);
        // The key used to come back from `registerClient`; it is handed in now,
        // which is the same string and one fewer thing to get wrong.
        this.keysByToken.set(token, connectionKey);
        return client;
      }
    }

    // Channel push is opt-in (see ChannelPolicy); this suite covers routing
    // once the gate has already permitted the source.
    const pool = new ChannelPool({ channelPolicy: { enabled: true } });
    await pool.sync({ shared: httpConfig('old-A') }, {}, { leaserId: 'A' });
    await pool.sync({ shared: httpConfig('new-B') }, {}, { leaserId: 'B' });
    const a: McpChannelMessage[] = [];
    const b: McpChannelMessage[] = [];
    const unsubscribeA = pool.subscribeChannel('A', event => a.push(event));
    pool.subscribeChannel('B', event => b.push(event));

    expect(pool.activeLeasersForConnection(pool.keysByToken.get('Bearer old-A')!)).toEqual(new Set(['A']));
    expect(pool.activeLeasersForConnection(pool.keysByToken.get('Bearer new-B')!)).toEqual(new Set(['B']));

    pool.clientsByToken.get('Bearer old-A')!.emitChannel({ server: 'shared', text: 'old' });
    pool.clientsByToken.get('Bearer new-B')!.emitChannel({ server: 'shared', text: 'new' });
    pool.clientsByToken.get('Bearer old-A')!.emitChannel({ server: 'shared', text: 'x'.repeat(32 * 1024 + 1) });
    pool.clientsByToken.get('Bearer new-B')!.emitChannel(undefined as unknown as McpChannelMessage);

    expect(a).toEqual([{ server: 'shared', text: 'old' }]);
    expect(b).toEqual([{ server: 'shared', text: 'new' }]);

    unsubscribeA();
    await pool.dropLeaser('B');
    pool.clientsByToken.get('Bearer old-A')!.emitChannel({ server: 'shared', text: 'dropped' });
    pool.clientsByToken.get('Bearer new-B')!.emitChannel({ server: 'shared', text: 'released' });

    expect(a).toEqual([{ server: 'shared', text: 'old' }]);
    expect(b).toEqual([{ server: 'shared', text: 'new' }]);
  });
});

describe('McpClientPool channel message guard', () => {
  class GuardPool extends McpClientPool {
    readonly clientsBySlug = new Map<string, ReturnType<typeof makeChannelClient>>();

    protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
      const client = makeChannelClient();
      this.clientsBySlug.set(slug, client);
      return client;
    }
  }

  async function guarded() {
    const pool = new GuardPool({ channelPolicy: { enabled: true } });
    await pool.sync({ pusher: httpConfig('t') }, {}, { leaserId: 'leaser' });
    const received: McpChannelMessage[] = [];
    pool.subscribeChannel('leaser', event => received.push(event));
    return { pool, received, emit: (m: unknown) => pool.clientsBySlug.get('pusher')!.emitChannel(m as McpChannelMessage) };
  }

  it('carries a sanitized meta record through to subscribers', async () => {
    const { received, emit } = await guarded();
    emit({ server: 'pusher', text: 'alert', meta: { chat_id: '42', severity: 'high' } });
    expect(received).toEqual([{ server: 'pusher', text: 'alert', meta: { chat_id: '42', severity: 'high' } }]);
  });

  /**
   * The ONE rule for a malformed `meta`, and it is REJECT the whole message.
   *
   * The doc's "silently dropped" rule (`channels-reference.md:230`) is honoured
   * at PARSE, in `client.ts`. This guard is the fail-closed boundary a caller
   * that bypassed the parser hits — exactly what these direct `PoolClient`
   * injections are — and a type predicate cannot drop a field without becoming a
   * normalizer that silently rewrites its input.
   */
  it('rejects the whole message when meta is not an identifier-keyed string record', async () => {
    const { received, emit } = await guarded();
    emit({ server: 'pusher', text: 'a', meta: { 'bad-key': 'x' } });
    emit({ server: 'pusher', text: 'b', meta: { ok: 7 } });
    emit({ server: 'pusher', text: 'c', meta: ['nope'] });
    emit({ server: 'pusher', text: 'd', meta: 'nope' });
    emit({ server: 'pusher', text: 'e', meta: null });
    expect(received).toEqual([]);

    // An ABSENT meta is still fine — the widening is backward-compatible.
    emit({ server: 'pusher', text: 'f' });
    expect(received).toEqual([{ server: 'pusher', text: 'f' }]);
  });
});

describe('McpClientPool channel push gate', () => {
  class GatedPool extends McpClientPool {
    readonly clientsBySlug = new Map<string, ReturnType<typeof makeChannelClient>>();
    declaresChannelCapability = true;

    protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
      const client = makeChannelClient(this.declaresChannelCapability);
      this.clientsBySlug.set(slug, client);
      return client;
    }
  }

  function gatedPool(policy: ChannelPolicy): GatedPool {
    return new GatedPool({ channelPolicy: policy });
  }

  /**
   * P6.341 — the gate's FIRST precondition, and the one that was missing.
   *
   * The dispatcher was armed on policy alone, so every ordinary MCP source the
   * user enabled could push. `channels-reference.md#server-options` makes the
   * declaration Required, so a server that did not make it is not a channel
   * however permissive the policy is.
   */
  it('installs nothing for a source that never declared claude/channel', async () => {
    const pool = gatedPool({ enabled: true });
    pool.declaresChannelCapability = false;
    await pool.sync({ ordinary: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('ordinary')).toBe(false);

    const received: McpChannelMessage[] = [];
    pool.subscribeChannel('leaser', event => received.push(event));
    pool.clientsBySlug.get('ordinary')!.emitChannel({ server: 'ordinary', text: 'unasked' });
    expect(received).toEqual([]);
  });

  /** The positive control on the same policy: declaring is what changes it. */
  it('installs for the same source once it declares the capability', async () => {
    const pool = gatedPool({ enabled: true });
    await pool.sync({ ordinary: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('ordinary')).toBe(true);
  });

  it('does not install a channel handler for a source that is not permitted', async () => {
    const pool = gatedPool({ enabled: true, allowedSources: ['allowed'] });
    await pool.sync({ notallowed: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('notallowed')).toBe(false);
  });

  it('installs it for a permitted source', async () => {
    const pool = gatedPool({ enabled: true, allowedSources: ['allowed'] });
    await pool.sync({ allowed: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('allowed')).toBe(true);
  });

  it('installs none at all when the master switch is off', async () => {
    const pool = gatedPool({ enabled: false, allowedSources: ['allowed'] });
    await pool.sync({ allowed: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('allowed')).toBe(false);
  });

  it('is closed by default, with no channel policy configured at all', async () => {
    const pool = new GatedPool();
    await pool.sync({ allowed: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('allowed')).toBe(false);
  });

  it('drops a push from a source that lost permission mid-session', async () => {
    const pool = gatedPool({ enabled: true, allowedSources: ['allowed'] });
    await pool.sync({ allowed: httpConfig('t') }, {}, { leaserId: 'leaser' });
    const received: McpChannelMessage[] = [];
    pool.subscribeChannel('leaser', event => received.push(event));
    pool.clientsBySlug.get('allowed')!.emitChannel({ server: 'allowed', text: 'first' });
    expect(received).toHaveLength(1);

    pool.setChannelPolicy({ enabled: true, allowedSources: [] });
    expect(pool.hasChannelHandler('allowed')).toBe(false);
    pool.clientsBySlug.get('allowed')!.emitChannel({ server: 'allowed', text: 'second' });
    expect(received).toHaveLength(1);
  });

  it('re-arms a source the policy grants back without a reconnect', async () => {
    const pool = gatedPool({ enabled: false, allowedSources: [] });
    await pool.sync({ allowed: httpConfig('t') }, {}, { leaserId: 'leaser' });
    const received: McpChannelMessage[] = [];
    pool.subscribeChannel('leaser', event => received.push(event));

    pool.setChannelPolicy({ enabled: true, allowedSources: ['allowed'] });
    expect(pool.hasChannelHandler('allowed')).toBe(true);
    pool.clientsBySlug.get('allowed')!.emitChannel({ server: 'allowed', text: 'granted' });
    expect(received).toEqual([{ server: 'allowed', text: 'granted' }]);
  });

  it('permits every connected source when the policy names no allowlist', async () => {
    const pool = gatedPool({ enabled: true });
    await pool.sync({ anything: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('anything')).toBe(true);
  });

  it('refuses a denied source under that same absent allowlist', async () => {
    // Deny is terminal and cannot be expressed by subtracting from a list that
    // is not there: without `deniedSources` this source would be armed.
    const pool = gatedPool({ enabled: true, deniedSources: ['blocked'] });
    await pool.sync({ blocked: httpConfig('t'), other: httpConfig('t') }, {}, { leaserId: 'leaser' });
    expect(pool.hasChannelHandler('blocked')).toBe(false);
    expect(pool.hasChannelHandler('other')).toBe(true);
  });
});

describe('sdkConfigToClientConfig', () => {
  it('preserves stdio working directory and environment', () => {
    expect(sdkConfigToClientConfig({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/plugin',
      env: { MODE: 'safe' },
    })).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/plugin',
      env: { MODE: 'safe' },
    });
  });

  it('disables parent environment inheritance for plugin stdio servers', () => {
    expect(sdkConfigToClientConfig({
      type: 'stdio',
      command: '/managed/node',
      env: { DECLARED_TOKEN: 'plugin-token' },
      pluginOrigin: {
        kind: 'plugin',
        pluginInstanceId: 'plugin://test',
        pluginId: 'test',
        marketplaceId: 'internal',
        version: '1.0.0',
        capabilityId: 'mcp',
        scope: 'workspace',
      },
    })).toEqual({
      transport: 'stdio',
      command: '/managed/node',
      env: { DECLARED_TOKEN: 'plugin-token' },
      inheritProcessEnv: false,
    });
  });

  it('keeps http servers on Streamable HTTP transport', () => {
    expect(sdkConfigToClientConfig({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    })).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('keeps sse servers on SSE transport', () => {
    expect(sdkConfigToClientConfig({
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    })).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer token' },
    });
  });
});

// ============================================================
// headersHelper — dynamic connection headers (`mcp.md:768-818`)
// ============================================================

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Minimal Streamable-HTTP MCP server on a loopback Bun server, recording the
 * `Authorization` header of every request — the observable that proves what
 * actually REACHED the transport. Answers `initialize`, `tools/list` and
 * `tools/call`; notifications get the spec's 202; the optional GET SSE stream
 * gets 405 (the SDK treats that as "no stream" and proceeds).
 */
function startHttpMcpServer() {
  const seenAuth: Array<{ method: string; authorization: string | null; staticHeader: string | null }> = [];
  // When set, `tools/call` demands exactly this Authorization value and 401s
  // anything else — the short-lived-token expiry the retry-once branch exists
  // for. Connect-time methods stay open so the reconnect can succeed.
  const gate = { requireCallAuth: null as string | null };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = await request.json() as JsonRpcMessage | JsonRpcMessage[];
      const message = Array.isArray(body) ? body[0]! : body;
      seenAuth.push({
        method: message.method ?? 'response',
        authorization: request.headers.get('authorization'),
        staticHeader: request.headers.get('x-static'),
      });
      if (message.id === undefined) return new Response(null, { status: 202 });
      const respond = (result: unknown) => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
        { headers: { 'content-type': 'application/json' } },
      );
      if (message.method === 'initialize') {
        return respond({
          protocolVersion: (message.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'headers-fixture', version: '1.0.0' },
        });
      }
      if (message.method === 'tools/list') {
        return respond({
          tools: [{ name: 'ping', description: 'Answers with pong.', inputSchema: { type: 'object', properties: {} } }],
        });
      }
      if (message.method === 'tools/call') {
        if (gate.requireCallAuth !== null && request.headers.get('authorization') !== gate.requireCallAuth) {
          return new Response('unauthorized', { status: 401 });
        }
        return respond({ content: [{ type: 'text', text: 'pong' }] });
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { server, seenAuth, gate };
}

describe('McpClientPool.connect — headersHelper', () => {
  const { server: httpServer, seenAuth, gate } = startHttpMcpServer();
  const helperDir = mkdtempSync(join(tmpdir(), 'mcp-headers-helper-'));
  afterAll(() => {
    httpServer.stop(true);
    rmSync(helperDir, { recursive: true, force: true });
  });

  // Each run mints a distinct token, so both the dynamic-over-static merge and
  // the fresh-on-every-connection rule are observable in what the server saw.
  const countingHelper = (name: string) => {
    const counterFile = join(helperDir, `${name}.count`);
    return `N=$(( $(cat "${counterFile}" 2>/dev/null || echo 0) + 1 )); echo "$N" > "${counterFile}"; printf '{"Authorization": "Bearer dyn-%s"}' "$N"`;
  };

  const config = (headersHelper: string): SdkMcpServerConfig => ({
    type: 'http',
    url: `http://localhost:${httpServer.port}/mcp`,
    headers: { Authorization: 'Bearer static', 'X-Static': 'keep' },
    headersHelper: { command: headersHelper },
  });

  it('overrides the static Authorization with helper output, and re-runs on reconnect (no caching)', async () => {
    const pool = new McpClientPool({});
    seenAuth.length = 0;

    await pool.connect('internal', config(countingHelper('rerun')));
    expect(pool.getProxyToolDefs().map(tool => tool.name)).toEqual(['mcp__internal__ping']);
    const firstConnect = seenAuth.map(entry => entry.authorization);
    expect(firstConnect.length).toBeGreaterThan(0);
    // `mcp.md:797`: dynamic overrides static with the same name; other static
    // headers still travel.
    expect(firstConnect.every(value => value === 'Bearer dyn-1')).toBe(true);
    expect(seenAuth.every(entry => entry.staticHeader === 'keep')).toBe(true);

    // `mcp.md:801`: fresh on each connection — a reconnect re-runs the helper.
    await pool.disconnect('internal');
    seenAuth.length = 0;
    await pool.connect('internal', config(countingHelper('rerun')));
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every(entry => entry.authorization === 'Bearer dyn-2')).toBe(true);

    await pool.disconnectAll();
  });

  it.each([
    ['non-zero exit', 'exit 3', 'non-zero-exit'],
    ['non-JSON stdout', 'echo not-json', 'malformed-stdout'],
    ['a non-string value', `echo '{"a": 1}'`, 'malformed-stdout'],
  ])('fail-soft: %s connects with static headers and logs the named reason', async (_label, command, reason) => {
    const messages: string[] = [];
    const pool = new McpClientPool({ debug: message => messages.push(message) });
    seenAuth.length = 0;

    await pool.connect('internal', config(command));

    expect(pool.getProxyToolDefs().map(tool => tool.name)).toEqual(['mcp__internal__ping']);
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every(entry => entry.authorization === 'Bearer static')).toBe(true);
    const log = messages.join('\n');
    expect(log).toContain('headersHelper failed');
    expect(log).toContain(reason);
    expect(log).toContain('static headers only');

    await pool.disconnectAll();
  });

  // `mcp.md:803`: "if a tool call returns `401 Unauthorized` or `403 Forbidden`,
  // Claude Code automatically re-runs the helper, reconnects with the fresh
  // headers, and retries the call once."
  it('recovers a 401 tool call by re-running the helper, reconnecting, and retrying once', async () => {
    const pool = new McpClientPool({});
    try {
      seenAuth.length = 0;
      await pool.connect('internal', config(countingHelper('auth-recover')));

      // The token the first connect minted has now "expired": the server only
      // accepts the NEXT one the helper will mint.
      gate.requireCallAuth = 'Bearer dyn-2';
      const result = await pool.callTool('mcp__internal__ping', {});

      expect(result).toMatchObject({ content: 'pong', isError: false });
      const calls = seenAuth.filter(entry => entry.method === 'tools/call');
      expect(calls.map(entry => entry.authorization)).toEqual(['Bearer dyn-1', 'Bearer dyn-2']);
    } finally {
      gate.requireCallAuth = null;
      await pool.disconnectAll();
    }
  });

  // "…marks the server as needing authentication only if that retry also
  // fails" — and the retry is EXACTLY once, never a general 4xx retry loop.
  it('marks the server as needing authentication only when the once-retried call fails too', async () => {
    const messages: string[] = [];
    const pool = new McpClientPool({ debug: message => messages.push(message) });
    try {
      seenAuth.length = 0;
      await pool.connect('internal', config(countingHelper('auth-fail')));

      gate.requireCallAuth = 'Bearer never';
      const result = await pool.callTool('mcp__internal__ping', {});

      expect(result).toMatchObject({ isError: true });
      // One original attempt plus exactly one retry — the documented bound.
      expect(seenAuth.filter(entry => entry.method === 'tools/call')).toHaveLength(2);
      expect(messages.join('\n')).toContain('needs authentication');
    } finally {
      gate.requireCallAuth = null;
      await pool.disconnectAll();
    }
  });

  // The recovery branch exists ONLY for helper-backed connections: a plain
  // static-header server keeps the old single-attempt behavior on 401.
  it('does not retry a 401 for a server without a headersHelper', async () => {
    const pool = new McpClientPool({});
    try {
      seenAuth.length = 0;
      await pool.connect('internal', {
        type: 'http',
        url: `http://localhost:${httpServer.port}/mcp`,
        headers: { Authorization: 'Bearer static', 'X-Static': 'keep' },
      });

      gate.requireCallAuth = 'Bearer something-else';
      const result = await pool.callTool('mcp__internal__ping', {});

      expect(result).toMatchObject({ isError: true });
      expect(seenAuth.filter(entry => entry.method === 'tools/call')).toHaveLength(1);
    } finally {
      gate.requireCallAuth = null;
      await pool.disconnectAll();
    }
  });
});

/**
 * P6.715 — the pool KEEPS the reason a connect failed.
 *
 * Until this row the pool recorded failures as a `Set<string>` of connection
 * keys and threw the `Error` away at the moment it caught it, so every surface
 * downstream could say THAT a server was broken and none could say WHY:
 * `<source_issue>`'s `Error:` line had no writer at all, and the `/mcp` report's
 * `detail` field was documented as "absent on the pool".
 *
 * Identical on all three runtimes because the pool is ours — there is no
 * per-runtime arm to this one. `McpServerStatusLine.detail` is the field
 * claude's own `McpServerStatus.error` lands in, so the pool-backed report and
 * the claude-backed one now carry the reason in the same place.
 */
describe('P6.715 — the reason a connection failed', () => {
  class RefusingPool extends McpClientPool {
    constructor(private readonly refuse: ReadonlySet<string>) { super(); }
    protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
      if (this.refuse.has(slug)) throw new Error(`spawn ${slug} ENOENT`);
      return makeMockClient();
    }
  }

  it('publishes it on health() and on the server-status line, and the healthy server carries none', async () => {
    const pool = new RefusingPool(new Set(['broken']));
    await pool.sync({ broken: httpConfig('t'), fine: httpConfig('t') }, {}, { leaserId: 'L' });

    expect(pool.health('L')).toEqual({
      status: 'degraded',
      connected: ['fine'],
      failed: ['broken'],
      failureReasons: { broken: 'spawn broken ENOENT' },
    });
    // The same reason, in the field claude's `McpServerStatus.error` lands in.
    expect(pool.serverStatuses('L')).toEqual([
      { name: 'broken', state: 'failed', toolCount: null, detail: 'spawn broken ENOENT' },
      { name: 'fine', state: 'connected', toolCount: 1 },
    ]);
  });

  it('drops the reason when the connection recovers — the control', async () => {
    // A reason outliving its verdict would attach the last transport error to
    // whatever fails next on the same connection identity, which reads exactly
    // like a correct answer. Without this arm the case above is equally
    // consistent with a pool that never forgets.
    const refuse = new Set(['broken']);
    const pool = new RefusingPool(refuse);
    await pool.sync({ broken: httpConfig('t') }, {}, { leaserId: 'L' });
    expect(pool.health('L').failureReasons).toEqual({ broken: 'spawn broken ENOENT' });

    refuse.delete('broken');
    await pool.sync({ broken: httpConfig('t2') }, {}, { leaserId: 'L' });
    expect(pool.health('L')).toEqual({
      status: 'ready',
      connected: ['broken'],
      failed: [],
      failureReasons: {},
    });
    expect(pool.serverStatuses('L')).toEqual([{ name: 'broken', state: 'connected', toolCount: 1 }]);
  });
});

describe('P6.711 — reconnect one server on request', () => {
  /** Counts dials so "it actually redialled" is provable, not inferred. */
  class CountingPool extends McpClientPool {
    connects = 0
    constructor(private readonly refuse: Set<string>) { super(); }
    protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
      this.connects += 1
      if (this.refuse.has(slug)) throw new Error(`spawn ${slug} ENOENT`)
      return makeMockClient();
    }
  }

  it('redials a failed server and clears the verdict that was refusing it', async () => {
    const refuse = new Set(['broken'])
    const pool = new CountingPool(refuse)
    await pool.sync({ broken: httpConfig('t'), fine: httpConfig('t') }, {}, { leaserId: 'L' })
    expect(pool.health('L').failed).toEqual(['broken'])
    const dialsBefore = pool.connects

    // The stub "restarts" — the live case is a server the user just fixed.
    refuse.delete('broken')
    expect(await pool.reconnect('broken', 'L')).toEqual({ ok: true })

    expect(pool.connects).toBe(dialsBefore + 1)
    // The verdict has to go with it: without the clear, `callTool`'s own guard
    // keeps refusing a server that is connected again — the shape P6.351 measured.
    expect(pool.health('L')).toEqual({
      status: 'ready',
      connected: ['broken', 'fine'],
      failed: [],
      failureReasons: {},
    })
  })

  it('leaves a healthy server untouched — the control', async () => {
    const pool = new CountingPool(new Set())
    await pool.sync({ fine: httpConfig('t'), other: httpConfig('t') }, {}, { leaserId: 'L' })
    const dialsBefore = pool.connects

    expect(await pool.reconnect('fine', 'L')).toEqual({ ok: true })

    // Exactly one dial, and it is the named server's: a reconnect that restarted
    // the pool would be indistinguishable from this one on health() alone.
    expect(pool.connects).toBe(dialsBefore + 1)
    expect(pool.health('L').connected).toEqual(['fine', 'other'])
    expect(pool.isConnected('other', 'L')).toBe(true)
  })

  it('names each refusal instead of throwing, and reports a redial that failed', async () => {
    const refuse = new Set(['broken'])
    const pool = new CountingPool(refuse)
    await pool.sync({ broken: httpConfig('t') }, {}, { leaserId: 'L' })

    // A slug this pool knows nothing about — the panel has to say which of the
    // three happened, so none of them may arrive as an exception.
    expect(await pool.reconnect('never-heard-of-it', 'L')).toEqual({ ok: false, reason: 'unknown-server' })
    // Still refusing: the redial runs and fails, and the detail is the reason.
    const failed = await pool.reconnect('broken', 'L')
    expect(failed.ok).toBe(false)
    expect(failed).toMatchObject({ reason: 'failed' })
    expect(pool.health('L').failed).toEqual(['broken'])
  })
})
