import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  ProcessSupervisorPort,
  SupervisedProcessStartRequest,
} from '../../agent/pi-harness/process-supervisor-port.ts';
import { computeNormalizedBundleHash } from '../../plugins/bundle-hash.ts';
import { BLOCKED_ENV_VARS } from '@nessy-agent/session-tools-core';
import { NessyMcpClient } from '../client.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function transport(client: NessyMcpClient): any {
  return (client as any).transport;
}

function stdioEnvironment(client: NessyMcpClient): Record<string, string> {
  // `createManagedStdioTransport` exposes the spawn parameters as `params` on
  // both arms, so this reads the same field on POSIX and on Windows.
  return transport(client).params.env;
}

function fakeSupervisor(options: { stopFailures?: number } = {}) {
  let request: SupervisedProcessStartRequest | undefined;
  let writes: string[] = [];
  let stops = 0;
  let stopFailures = options.stopFailures ?? 0;
  const port: ProcessSupervisorPort = {
    async start(next) {
      request = next;
      await next.beforeStart?.();
      return {
        handle: 'handle-1', output: '', nextCursor: 0, isRunning: true,
        exitCode: null, signal: null, isolationProfile: 'plugin-mcp:test',
        environmentProfile: 'explicit', environmentDigest: 'a'.repeat(64),
      };
    },
    async write(next) { writes.push(next.data); },
    async read() { throw new Error('unused'); },
    async stop() {
      stops++;
      if (stopFailures > 0) {
        stopFailures--;
        throw new Error('process-stop-unproven');
      }
      request?.onClose?.(0, null);
    },
    async drainSession() { return []; },
  };
  return { port, get request() { return request; }, get writes() { return writes; }, get stops() { return stops; } };
}

async function pluginFixture() {
  const root = mkdtempSync(join(tmpdir(), 'nessy-plugin-mcp-'));
  roots.push(root);
  writeFileSync(join(root, 'server.js'), 'process.stdin.resume()');
  return { root, dataPath: join(root, '..', `${root.split('/').pop()}-data`), hash: await computeNormalizedBundleHash(root) };
}

describe('NessyMcpClient remote transports', () => {
  it('uses Streamable HTTP for http MCP servers', () => {
    expect(transport(new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' })).constructor.name)
      .toBe('StreamableHTTPClientTransport');
  });

  it('uses SSE for sse MCP servers', () => {
    expect(transport(new NessyMcpClient({ transport: 'sse', url: 'https://mcp.example.com/sse' })).constructor.name)
      .toBe('SSEClientTransport');
  });

  // R24: both elicitation modes are implemented, so both are advertised. The
  // keys are the SDK's own (`ElicitationCapabilitySchema` = `{form?, url?}`),
  // and the url key is what makes a spec-compliant server willing to send
  // `mode: "url"` at all.
  it('registers form and url elicitation capabilities and the handler when provided', () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
      elicitationHandler: async () => ({ action: 'decline' }),
    });
    const sdkClient = (client as any).client;
    expect(sdkClient._capabilities.elicitation).toEqual({ form: {}, url: {} });
    expect(sdkClient._requestHandlers.has('elicitation/create')).toBe(true);
  });

  it('advertises no elicitation capability without a handler', () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' });
    expect((client as any).client._capabilities.elicitation).toBeUndefined();
  });

  // `mcp.md:108` — "Claude Code answers `roots/list` with the session's launch
  // directory plus every additional working directory you've granted" and "sends
  // `notifications/roots/list_changed` when that set changes."
  describe('MCP roots capability', () => {
    it('declares roots.listChanged and registers roots/list only with a provider', () => {
      const withRoots = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
        rootsProvider: () => ['/tmp/launch'],
      });
      expect((withRoots as any).client._capabilities.roots).toEqual({ listChanged: true });
      expect((withRoots as any).client._requestHandlers.has('roots/list')).toBe(true);

      const without = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' });
      expect((without as any).client._capabilities.roots).toBeUndefined();
      expect((without as any).client._requestHandlers.has('roots/list')).toBe(false);
    });

    // The capabilities object is ACCUMULATED, not an either/or ternary: a naive
    // key append to the old ternary would have dropped elicitation in one branch.
    it('carries elicitation and roots together', () => {
      const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
        elicitationHandler: async () => ({ action: 'decline' }),
        rootsProvider: () => ['/tmp/launch'],
      });
      expect((client as any).client._capabilities).toEqual({
        elicitation: { form: {}, url: {} },
        roots: { listChanged: true },
      });
    });

    it('answers roots/list with file:// URIs for the launch dir and additional dirs', async () => {
      const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
        rootsProvider: () => ['/tmp/launch dir', '/tmp/extra'],
      });
      const handler = (client as any).client._requestHandlers.get('roots/list');
      const result = await handler({ method: 'roots/list' }, { signal: new AbortController().signal });
      expect(result).toEqual({
        roots: [
          // A space in the path must be percent-encoded, which a bare path is not.
          { uri: 'file:///tmp/launch%20dir', name: 'launch dir' },
          { uri: 'file:///tmp/extra', name: 'extra' },
        ],
      });
    });

    it('notifyRootsChanged is a no-op without the capability, and does not throw', async () => {
      // The SDK throws when the capability was not declared
      // (`client/index.js:394`); one client without roots must not be able to
      // fail a fan-out across every other connection.
      const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' });
      await client.notifyRootsChanged();

      // Declared but not connected is also a no-op: there is nowhere to write.
      const declared = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
        rootsProvider: () => ['/tmp/launch'],
      });
      await declared.notifyRootsChanged();
    });
  });

  it('maps list-changed notifications to bounded capability kinds without forwarding payloads', async () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' });
    const received: unknown[][] = [];
    client.setCapabilitiesChangedHandler(function(kind) {
      received.push([...arguments]);
    });
    const handlers = (client as any).client._notificationHandlers as Map<string, (notification: unknown) => Promise<void>>;

    for (const [method, kind] of [
      ['notifications/tools/list_changed', 'tools'],
      ['notifications/resources/list_changed', 'resources'],
      ['notifications/prompts/list_changed', 'prompts'],
    ] as const) {
      await handlers.get(method)!({ jsonrpc: '2.0', method, params: { credential: 'must-not-cross-boundary' } });
      expect(received.at(-1)).toEqual([kind]);
    }
  });

  // `channels-reference.md:48`/`:221` — the method is
  // `notifications/claude/channel`; `:229` — the body is `params.content`. The
  // bare `claude/channel` we used to register is the CAPABILITY KEY on that page
  // (`:198`, `:212`), not a method.
  const CHANNEL_METHOD = 'notifications/claude/channel';

  it('emits only bounded sanitized text from notifications/claude/channel', async () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
      channelServer: 'server-a',
    });
    const received: Array<{ server: string; text: string; meta?: Record<string, string> }> = [];
    client.setChannelHandler(event => received.push(event));
    const handlers = (client as any).client._notificationHandlers as Map<string, (notification: unknown) => Promise<void>>;
    const handler = handlers.get(CHANNEL_METHOD)!;

    await handler({
      jsonrpc: '2.0',
      method: CHANNEL_METHOD,
      params: { content: 'safe\u0000\u001btext\n\tkept' },
    });
    await handler({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: { content: ['not text'] } });
    await handler({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: { message: 'not text' } });
    // The OLD param name is no longer read: `content` is the contract.
    await handler({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: { text: 'legacy key' } });
    await handler({
      jsonrpc: '2.0',
      method: CHANNEL_METHOD,
      params: { content: '\u{1F600}'.repeat(10_000) },
    });

    expect(received[0]).toEqual({ server: 'server-a', text: 'safetext\n\tkept' });
    expect(received).toHaveLength(2);
    expect(Buffer.byteLength(received[1]!.text, 'utf8')).toBe(32 * 1024);
    expect(received[1]!.text.endsWith('\uFFFD')).toBe(false);
  });

  it('registers no handler for the bare capability key', () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
      channelServer: 'server-a',
    });
    const handlers = (client as any).client._notificationHandlers as Map<string, unknown>;
    expect(handlers.has(CHANNEL_METHOD)).toBe(true);
    // No legacy alias — nothing in this repo or in any shipped server ever
    // emitted the un-prefixed form, so there is no producer to stay compatible
    // with, and the SDK's dispatch is an exact string map either way.
    expect(handlers.has('claude/channel')).toBe(false);
  });

  it('keeps only identifier-keyed string meta entries, dropping the rest silently', async () => {
    const client = new NessyMcpClient({ transport: 'http', url: 'https://mcp.example.com/mcp' }, {
      channelServer: 'server-a',
    });
    const received: Array<{ server: string; text: string; meta?: Record<string, string> }> = [];
    client.setChannelHandler(event => received.push(event));
    const handler = ((client as any).client._notificationHandlers as Map<string, (n: unknown) => Promise<void>>)
      .get(CHANNEL_METHOD)!;

    await handler({
      jsonrpc: '2.0',
      method: CHANNEL_METHOD,
      params: {
        content: 'alert',
        meta: {
          chat_id: '4\u00002',            // control chars stripped like the body
          'bad-key': 'dropped',        // `:230` — hyphenated keys silently dropped
          count: 7,                    // non-string value dropped
          source: 'trusted-host',      // `source` is ours to set
          huge: 'x'.repeat(2000),      // over the per-value bound
        },
      },
    });
    // No surviving entry at all => the key is omitted, not set to `{}`.
    await handler({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: { content: 'plain', meta: { 'a-b': 'x' } } });
    // A non-object `meta` is ignored; the event still arrives (drops are silent,
    // never a rejection, per `:230`).
    await handler({ jsonrpc: '2.0', method: CHANNEL_METHOD, params: { content: 'array', meta: ['nope'] } });

    expect(received[0]).toEqual({ server: 'server-a', text: 'alert', meta: { chat_id: '42' } });
    expect(received[1]).toEqual({ server: 'server-a', text: 'plain' });
    expect(received[2]).toEqual({ server: 'server-a', text: 'array' });
  });
});

describe('NessyMcpClient stdio transport', () => {
  it('requires plugin process authority before accepting an injected transport', () => {
    const [injectedTransport] = InMemoryTransport.createLinkedPair();

    expect(() => new NessyMcpClient({
      transport: 'stdio',
      command: process.execPath,
      pluginRuntime: {
        bundleRootPath: '/plugin',
        expectedBundleHash: 'a'.repeat(64),
        dataPath: '/plugin-data',
      },
    }, { transport: injectedTransport })).toThrow('plugin-mcp-process-supervisor-required');
  });

  it('gives native/project stdio the group-killing transport with legacy sanitized inheritance', () => {
    const name = 'NESSY_TEST_NATIVE_ENV';
    const previous = process.env[name];
    process.env[name] = 'native-value';
    try {
      const client = new NessyMcpClient({ transport: 'stdio', command: process.execPath });
      // NOT the SDK's own `StdioClientTransport`: that one closes by signalling
      // the direct child, which leaves a wrapper's descendants running (DA3.1).
      // The teardown itself is proven against real processes in
      // `managed-stdio-transport.test.ts`; this only pins which transport the
      // non-plugin branch selects.
      expect(transport(client).constructor.name).not.toBe('StdioClientTransport');
      expect(transport(client).pid).toBeNull();
      expect(stdioEnvironment(client)[name]).toBe('native-value');
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  /**
   * DA2.22 — the ONE list, read here and by `session-tools-core`'s script-runtime
   * sanitizer. There used to be two copies kept in step by a comment in each
   * file pointing at the other; this asserts the behaviour rather than the
   * agreement, so it fails if a future edit re-introduces a local filter that
   * drifts from the shared array.
   *
   * The positive control matters and is not decoration. The production path
   * iterates `Object.entries(process.env)`, and AGENTS.md records that a name
   * Bun pre-creates a slot for is INVISIBLE to exactly that enumeration after a
   * plain assignment — so "the blocked name is absent" could pass while nothing
   * was stripped at all. The sentinel is assigned the same way and must be
   * PRESENT, which is what makes the absences above it mean something.
   */
  it('strips every name in the shared BLOCKED_ENV_VARS from inherited stdio env', () => {
    const sentinel = 'NESSY_TEST_UNBLOCKED_ENV';
    const previous = new Map<string, string | undefined>();
    for (const name of [...BLOCKED_ENV_VARS, sentinel]) {
      previous.set(name, process.env[name]);
      // `delete` first: AGENTS.md — assigning over an absent name Bun pre-created
      // a slot for leaves it readable by property and invisible to enumeration.
      delete process.env[name];
      process.env[name] = `secret-for-${name}`;
    }
    try {
      const env = stdioEnvironment(new NessyMcpClient({ transport: 'stdio', command: process.execPath }));
      expect(env[sentinel]).toBe(`secret-for-${sentinel}`);
      for (const name of BLOCKED_ENV_VARS) {
        expect(env).not.toHaveProperty(name);
      }
      // The list is not empty, so the loop above is not a vacuous pass.
      expect(BLOCKED_ENV_VARS.length).toBeGreaterThan(0);
    } finally {
      for (const [name, value] of previous) {
        delete process.env[name];
        if (value !== undefined) process.env[name] = value;
      }
    }
  });

  it('reports an unexpected native/project stdio close through the common SDK bridge', () => {
    const client = new NessyMcpClient({ transport: 'stdio', command: process.execPath });
    let unexpectedCloses = 0;
    client.setUnexpectedCloseHandler(() => { unexpectedCloses += 1; });
    (client as any).connected = true;

    (client as any).client.onclose?.();

    expect(unexpectedCloses).toBe(1);
    expect((client as any).connected).toBe(false);
  });

  it('uses the supervisor with exact managed data authority, bounded startup preamble compatibility, strict framing, backpressure, and idempotent cleanup', async () => {
    const fixture = await pluginFixture();
    const supervisor = fakeSupervisor();
    const client = new NessyMcpClient({
      transport: 'stdio',
      command: process.execPath,
      args: [join(fixture.root, 'server.js')],
      env: { NESSY_PLUGIN_DATA: fixture.dataPath },
      cwd: fixture.root,
      inheritProcessEnv: false,
      pluginRuntime: {
        bundleRootPath: fixture.root,
        expectedBundleHash: fixture.hash,
        dataPath: fixture.dataPath,
        hostWritableRoots: [join(fixture.root, '..', 'host-dp-state')],
      },
    }, {
      pluginProcessAuthority: {
        processSupervisor: supervisor.port,
        sessionKey: { workspaceId: 'ws', sessionId: 'mcp-pool:test' },
      },
    });
    const stdio = transport(client);
    const messages: unknown[] = [];
    const errors: Error[] = [];
    let closes = 0;
    stdio.onmessage = (message: unknown) => messages.push(message);
    stdio.onerror = (error: Error) => errors.push(error);
    stdio.onclose = () => closes++;

    await stdio.start();
    expect(supervisor.request).toMatchObject({
      profile: 'plugin-mcp',
      persistent: true,
      persistOutput: false,
      environmentProfile: 'explicit',
      additionalWritableRoots: [fixture.dataPath, join(fixture.root, '..', 'host-dp-state')],
      cwd: fixture.root,
      workspaceRoot: fixture.root,
    });
    expect(supervisor.request?.env).toMatchObject({
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NESSY_PLUGIN_DATA: fixture.dataPath,
    });
    expect(supervisor.request?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    supervisor.request?.onStdout?.(Buffer.from('dp update available\nplease update\n\n'));
    supervisor.request?.onStdout?.(Buffer.from('{"jsonrpc":"2.0","method":"notifications/'));
    supervisor.request?.onStdout?.(Buffer.from('tools/list_changed"}\n'));
    expect(messages).toEqual([{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }]);
    expect(errors).toEqual([]);
    await stdio.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(supervisor.writes).toEqual(['{"jsonrpc":"2.0","method":"notifications/initialized"}\n']);

    supervisor.request?.onStdout?.(Buffer.from('not-json-after-handshake\n'));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);

    await stdio.close();
    await stdio.close();
    expect(supervisor.stops).toBe(1);
    expect(closes).toBe(1);
  });

  it('reports an unexpected supervised process exit to its pool owner', async () => {
    const fixture = await pluginFixture();
    const supervisor = fakeSupervisor();
    const client = new NessyMcpClient({
      transport: 'stdio', command: process.execPath, cwd: fixture.root,
      pluginRuntime: {
        bundleRootPath: fixture.root,
        expectedBundleHash: fixture.hash,
        dataPath: fixture.dataPath,
      },
    }, {
      pluginProcessAuthority: {
        processSupervisor: supervisor.port,
        sessionKey: { workspaceId: 'ws', sessionId: 'mcp-pool:test' },
      },
    });
    let unexpectedCloses = 0;
    client.setUnexpectedCloseHandler(() => { unexpectedCloses += 1; });
    // `Client.connect()` installs this transport → protocol bridge in
    // production; this transport-only test drives the same callback directly.
    transport(client).onclose = () => (client as any).client.onclose?.();

    await transport(client).start();
    supervisor.request?.onClose?.(1, null);

    expect(unexpectedCloses).toBe(1);
  });

  it('propagates an unproven supervised stop and retries with the retained handle', async () => {
    const fixture = await pluginFixture();
    const supervisor = fakeSupervisor({ stopFailures: 1 });
    const client = new NessyMcpClient({
      transport: 'stdio', command: process.execPath, cwd: fixture.root,
      pluginRuntime: {
        bundleRootPath: fixture.root,
        expectedBundleHash: fixture.hash,
        dataPath: fixture.dataPath,
      },
    }, {
      pluginProcessAuthority: {
        processSupervisor: supervisor.port,
        sessionKey: { workspaceId: 'ws', sessionId: 'mcp-pool:test' },
      },
    });
    const stdio = transport(client);
    let closes = 0;
    stdio.onclose = () => { closes += 1; };
    await stdio.start();

    await expect(stdio.close()).rejects.toThrow('process-stop-unproven');
    expect(supervisor.stops).toBe(1);
    expect(closes).toBe(0);

    await stdio.close();
    expect(supervisor.stops).toBe(2);
    expect(closes).toBe(1);
  });

  it('closes a supervised plugin MCP that exceeds the startup preamble bound', async () => {
    const fixture = await pluginFixture();
    const supervisor = fakeSupervisor();
    const client = new NessyMcpClient({
      transport: 'stdio', command: process.execPath, cwd: fixture.root,
      pluginRuntime: {
        bundleRootPath: fixture.root,
        expectedBundleHash: fixture.hash,
        dataPath: fixture.dataPath,
      },
    }, {
      pluginProcessAuthority: {
        processSupervisor: supervisor.port,
        sessionKey: { workspaceId: 'ws', sessionId: 'mcp-pool:test' },
      },
    });
    const stdio = transport(client);
    const errors: Error[] = [];
    stdio.onerror = (error: Error) => errors.push(error);

    await stdio.start();
    supervisor.request?.onStdout?.(Buffer.from(`${'banner\n'.repeat(33)}`));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.map(error => error.message)).toEqual(['plugin-mcp-stdio-startup-preamble-too-large']);
    expect(supervisor.stops).toBe(1);
  });

  it('fails before spawn when the immutable plugin bundle hash changed', async () => {
    const fixture = await pluginFixture();
    const supervisor = fakeSupervisor();
    writeFileSync(join(fixture.root, 'server.js'), 'tampered');
    const client = new NessyMcpClient({
      transport: 'stdio', command: process.execPath,
      pluginRuntime: {
        bundleRootPath: fixture.root,
        expectedBundleHash: fixture.hash,
        dataPath: fixture.dataPath,
      },
    }, {
      pluginProcessAuthority: {
        processSupervisor: supervisor.port,
        sessionKey: { workspaceId: 'ws', sessionId: 'mcp-pool:test' },
      },
    });
    await expect(transport(client).start()).rejects.toThrow('plugin-mcp-bundle-hash-mismatch');
  });
});
