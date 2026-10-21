import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { buildPoolProxyBaseName, McpClientPool, redactConfiguredMcpSecrets, sanitizeMcpToolNameSegment, type McpOpenConnectionRequest } from '../mcp-pool.ts';
import { McpPoolServer } from '../pool-server.ts';
import { NessyMcpClient, type McpPromptListPage, type McpResourceListPage, type PoolClient } from '../client.ts';
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';
import { MCP_OUTPUT_TOKENS_ENV } from '../../config/mcp-output-settings.ts';
import { registerFixtureClient } from './pool-fixture.ts';

type CapabilityKind = 'tools' | 'resources' | 'prompts';

// Minimal fake client: lists the given tools, records callTool invocations.
function fakeClient(tools: Tool[], calls: Array<{ name: string; args: unknown }>): PoolClient {
  return {
    async listTools() { return tools; },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ok:${name}` }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient;
}

interface DynamicTestClient {
  client: PoolClient;
  notify(kind: CapabilityKind): void;
  setTools(tools: Tool[]): void;
  setResources(resources: unknown[]): void;
  setPrompts(prompts: unknown[]): void;
  setListTools(listTools: () => Promise<Tool[]>): void;
  setListResources(listResources: () => Promise<McpResourceListPage>): void;
  // UB7.11 — the PoolClient member returns ONE PAGE ({ prompts, nextCursor });
  setListPrompts(listPrompts: (cursor?: string) => Promise<McpPromptListPage>): void;
}

function dynamicClient(tools: Tool[], calls: Array<{ name: string; args: unknown }>): DynamicTestClient {
  let currentTools = tools;
  let currentResources: unknown[] = [];
  let currentPrompts: unknown[] = [];
  let listTools = async () => currentTools;
  let listResources = async (): Promise<McpResourceListPage> => ({ resources: currentResources });
  let listPrompts = async (): Promise<McpPromptListPage> => ({ prompts: currentPrompts });
  let capabilitiesChanged: ((kind: CapabilityKind) => void) | undefined;
  const client = {
    listTools: () => listTools(),
    listResources: () => listResources(),
    listPrompts: () => listPrompts(),
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ok:${name}` }], isError: false };
    },
    async close() {},
    setCapabilitiesChangedHandler(handler: (kind: CapabilityKind) => void) {
      capabilitiesChanged = handler;
    },
  } as PoolClient;
  return {
    client,
    notify(kind) { capabilitiesChanged?.(kind); },
    setTools(next) { currentTools = next; listTools = async () => currentTools; },
    setResources(next) { currentResources = next; listResources = async (): Promise<McpResourceListPage> => ({ resources: currentResources }); },
    setPrompts(next) { currentPrompts = next; listPrompts = async (): Promise<McpPromptListPage> => ({ prompts: currentPrompts }); },
    setListTools(next) { listTools = next; },
    setListResources(next) { listResources = next; },
    setListPrompts(next) { listPrompts = next; },
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await Promise.resolve();
    }
  }
  throw failure;
}

async function eventuallyAsync(assertion: () => Promise<void>): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await Promise.resolve();
    }
  }
  throw failure;
}

const tool = (name: string): Tool =>
  ({ name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } } as Tool);

// A fake transport through the REAL `connect` — DA3.16, see `pool-fixture.ts`.
class TestPool extends McpClientPool {
  async register(slug: string, client: PoolClient, config?: SdkMcpServerConfig) {
    return registerFixtureClient(this, slug, client, config);
  }

  async refresh(connectionKey: string, kind: CapabilityKind) {
    return (this as unknown as {
      refreshConnectionCapabilities(connectionKey: string, kind: CapabilityKind): Promise<void>;
    }).refreshConnectionCapabilities(connectionKey, kind);
  }
}

class DynamicLeaserPool extends McpClientPool {
  constructor(private readonly sources: Map<string, DynamicTestClient>) { super(); }

  protected override async openConnection({ config }: McpOpenConnectionRequest): Promise<PoolClient> {
    if (config.type !== 'http') throw new Error('dynamic-leaser-test-requires-http');
    const source = this.sources.get(config.url);
    if (!source) throw new Error(`missing dynamic test source: ${config.url}`);
    return source.client;
  }
}

class ApiHealthPool extends McpClientPool {
  fail = true
  override async connectInProcess(slug: string, server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer): Promise<void> {
    if (this.fail) throw new Error('api-offline')
    await this.registerClient(slug, fakeClient([], []), server)
  }
}

describe('sanitizeMcpToolNameSegment', () => {
  it('replaces characters outside [A-Za-z0-9_-] with _', () => {
    expect(sanitizeMcpToolNameSegment('foo.bar')).toBe('foo_bar');
    expect(sanitizeMcpToolNameSegment('a b/c:d')).toBe('a_b_c_d');
    expect(sanitizeMcpToolNameSegment('list.repos.v2')).toBe('list_repos_v2');
  });

  it('leaves already-valid names untouched', () => {
    expect(sanitizeMcpToolNameSegment('createIssue')).toBe('createIssue');
    expect(sanitizeMcpToolNameSegment('a-b_c9')).toBe('a-b_c9');
  });
});

describe('buildPoolProxyBaseName', () => {
  it("stays within the 64-char endpoint cap given a slug at the mint's own 40-char ceiling", () => {
    // Review finding (task 2, stable-plugin-mcp-wire-names, 2026-08-10): the
    // 64-char cap this function produces is only sound because every wire name
    // is now capped to 40 chars AT THE MINT (`capMcpNameSegment` in
    // `capabilities/resolver.ts`'s `applyCollisionPolicy`) before it ever
    // becomes a pool slug — this function itself does not truncate the slug.
    // Pins the pool-side half of that contract at its own worst case: a
    // 40-char slug (the max the mint allows) plus an unreasonably long tool
    // name still fits, and the full `mcp__<slug>__` prefix survives intact.
    const slug = 'p'.repeat(40);
    const proxyName = buildPoolProxyBaseName(slug, 'q'.repeat(200));
    expect(proxyName.length).toBeLessThanOrEqual(64);
    expect(proxyName.startsWith(`mcp__${slug}__`)).toBe(true);
  });
});

describe('McpClientPool dotted proxy names', () => {
  it('does not project advisory protocol metadata into authorization fields', async () => {
    const pool = new TestPool();
    await pool.register('docs', fakeClient([{
      ...tool('lookup'),
      annotations: { readOnlyHint: true },
    }], []));

    const definition = pool.getProxyToolDefs(['docs'])[0];
    expect(definition).toMatchObject({ name: 'mcp__docs__lookup' });
    expect(definition).not.toHaveProperty('readOnly');
  });

  it('carries annotations and _meta from the descriptor into the proxy entry', async () => {
    const pool = new TestPool();
    await pool.register('docs', fakeClient([{
      name: 'write',
      description: 'w',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, title: 'Write' },
      _meta: { 'anthropic/requiresUserInteraction': true },
    } as Tool], []));

    const definition = pool.getProxyToolDefs(['docs'])[0]!;
    expect(definition.annotations).toEqual({ readOnlyHint: false, title: 'Write' });
    expect(definition._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
  });

  it('omits the metadata keys entirely when the server sends none', async () => {
    // Absent, not `undefined`: the catalog hash canonicalizes the projection, and
    // an explicit undefined would be one more key on every server that ships no
    // annotations.
    const pool = new TestPool();
    await pool.register('docs', fakeClient([tool('plain')], []));

    const definition = pool.getProxyToolDefs(['docs'])[0]!;
    expect('annotations' in definition).toBe(false);
    expect('_meta' in definition).toBe(false);
  });

  it('treats a metadata-only change as a tool-catalog change', async () => {
    // The second projection is `effectiveToolCatalogHash`, which decides whether
    // a refresh is worth a tools-changed notification. While it read only
    // description + inputSchema, a server flipping `readOnlyHint` or adding a
    // `_meta` flag was invisible: the metadata reached `toolCache` and no
    // consumer was ever told to re-read it.
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    let invalidations = 0;
    pool.subscribeToolsChanged(() => { invalidations += 1; });

    source.setTools([{ ...tool('read'), annotations: { readOnlyHint: true } } as Tool]);
    source.notify('tools');

    await eventually(() => expect(invalidations).toBe(1));
    expect(pool.getProxyToolDefs(['ctx'])[0]!.annotations).toEqual({ readOnlyHint: true });
  });

  it('registers, advertises, and routes a dotted tool name', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const pool = new TestPool();
    await pool.register('gh', fakeClient([tool('foo.bar')], calls));

    // Advertised name is charset-clean.
    const defs = pool.getProxyToolDefs(['gh']);
    expect(defs.map(d => d.name)).toEqual(['mcp__gh__foo_bar']);
    expect(/^[A-Za-z0-9_-]+$/.test(defs[0]!.name)).toBe(true);

    // The clean name is a recognised proxy tool...
    expect(pool.isProxyTool('mcp__gh__foo_bar')).toBe(true);
    // ...the raw dotted variant is not.
    expect(pool.isProxyTool('mcp__gh__foo.bar')).toBe(false);

    // Calling the clean name reverse-maps to the ORIGINAL tool name.
    const res = await pool.callTool('mcp__gh__foo_bar', { x: 1 });
    expect(res.isError).toBe(false);
    expect(calls).toEqual([{ name: 'foo.bar', args: { x: 1 } }]);
  });

  it('disambiguates two tools that sanitize to the same name', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const pool = new TestPool();
    await pool.register('gh', fakeClient([tool('a.b'), tool('a_b')], calls));

    const names = pool.getProxyToolDefs(['gh']).map(d => d.name).sort();
    // No duplicates: second collision gets a numeric suffix.
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(['mcp__gh__a_b', 'mcp__gh__a_b_2']);

    // Both still route to their distinct originals.
    await pool.callTool('mcp__gh__a_b', {});
    await pool.callTool('mcp__gh__a_b_2', {});
    expect(calls.map(c => c.name).sort()).toEqual(['a.b', 'a_b']);
  });

  it('forwards abort to the actual MCP client and projects immutable context inventory', async () => {
    let receivedSignal: AbortSignal | undefined
    let clientObservedAbort = false
    let resolveClientStarted!: () => void
    const clientStarted = new Promise<void>(resolve => { resolveClientStarted = resolve })
    const pool = new TestPool()
    await pool.register('ctx', {
      listTools: async () => [tool('read')],
      callTool: async (_name, _args, signal) => {
        receivedSignal = signal
        resolveClientStarted()
        return await new Promise((_resolve, reject) => {
          if (!signal) return reject(new Error('missing call signal'))
          const rejectAborted = () => {
            clientObservedAbort = true
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          }
          if (signal.aborted) rejectAborted()
          else signal.addEventListener('abort', rejectAborted, { once: true })
        })
      },
      listResources: async (): Promise<McpResourceListPage> => ({ resources: [{ uri: 'nessy://resource' }] }),
      listPrompts: async () => ({ prompts: [{ name: 'review' }] }),
      close: async () => {},
    })
    await pool.register('broken', {
      listTools: async () => [], callTool: async () => ({}), close: async () => {},
      listResources: async () => { throw new Error('offline') },
      listPrompts: async () => ({ prompts: [] }),
    })
    const controller = new AbortController()
    const call = pool.callTool('mcp__ctx__read', {}, controller.signal)
    await clientStarted
    controller.abort(new Error('caller-aborted'))
    const result = await call
    expect(clientObservedAbort).toBe(true)
    expect(receivedSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ isError: true, sourceSlug: 'ctx' })
    expect(result.content).toContain('caller-aborted')
    expect(await pool.listContextResources()).toEqual([
      { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://resource' } },
      { sourceSlug: 'ctx', kind: 'prompt', value: { name: 'review' } },
    ])
    const inventory = await pool.listContextResources()
    expect(Object.isFrozen(inventory[0]?.value)).toBe(true)
    expect(pool.health()).toMatchObject({ status: 'degraded', connected: ['broken', 'ctx'], failed: ['broken'] })
  })

  it('applies the configured per-server timeout to the actual MCP tool call', async () => {
    let receivedSignal: AbortSignal | undefined
    const pool = new TestPool()
    await pool.register('slow', {
      listTools: async () => [tool('wait')],
      callTool: async (_name, _args, signal) => {
        receivedSignal = signal
        return await new Promise((_resolve, reject) => {
          if (!signal) return reject(new Error('missing timeout signal'))
          const rejectAborted = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
          if (signal.aborted) rejectAborted()
          else signal.addEventListener('abort', rejectAborted, { once: true })
        })
      },
      close: async () => {},
    }, { type: 'http', url: 'https://slow.example.test/mcp', toolTimeoutMs: 10 })

    const result = await pool.callTool('mcp__slow__wait', {})

    expect(receivedSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ isError: true, sourceSlug: 'slow' })
  })

  it('reports and clears API-source connection failures in health', async () => {
    const pool = new ApiHealthPool()
    const apiSources = { api: { type: 'sdk' as const, instance: {} as never } }
    expect(await pool.sync({}, apiSources)).toEqual(['api'])
    expect(pool.health()).toMatchObject({ status: 'unavailable', failed: ['api'] })
    pool.fail = false
    expect(await pool.sync({}, apiSources)).toEqual([])
    expect(pool.health()).toEqual({ status: 'ready', connected: ['api'], failed: [], failureReasons: {} })
    await pool.disconnectAll()
    expect(pool.health()).toEqual({ status: 'unavailable', connected: [], failed: [], failureReasons: {} })
  })
});

it('preserves structured MCP shape while redacting only configured secret values', () => {
  expect(redactConfiguredMcpSecrets({ token: 'Bearer secret-123', harmless: 'token' }, new Set(['secret-123'])))
    .toEqual({ token: 'Bearer [REDACTED]', harmless: 'token' })
})

// ============================================================
// P3 — per-call tool-response persistence context
//
// callTool saves large/binary responses into a session's long_responses/ dir
// and summarizes over-threshold text with that session's callback. These prove
// the identity source can move from the pool-level default to a per-call
// context WITHOUT changing WHAT gets saved — the precondition for one shared
// pool serving many sessions (each saving into its OWN dir with its OWN
// callback) without cross-session leakage.
// ============================================================

// Emit a text block big enough to exceed the default TOKEN_LIMIT (12000 tokens
// ≈ 48000 plain-text chars) so guardLargeResult persists + summarizes it.
function bigTextClient(): PoolClient {
  const big = 'x '.repeat(60_000); // ~120k chars, well over threshold
  return {
    async listTools() {
      return [tool('big')];
    },
    async callTool() {
      return { content: [{ type: 'text', text: big }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient;
}

/**
 * Emits a plain-text result of exactly `chars` characters. Space-separated for
 * the same reason as `declaredLimitClient` below: an unbroken alphanumeric run
 * is treated as base64 and routed to asset extraction before the size guard.
 */
function sizedTextClient(chars: number): PoolClient {
  return {
    async listTools() {
      return [tool('big')];
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'x '.repeat(chars / 2) }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient;
}

/** Same, but the tool declares its own result-size allowance and length. */
function declaredLimitClient(declared: number, chars: number): PoolClient {
  return {
    async listTools() {
      return [{ ...tool('big'), _meta: { 'anthropic/maxResultSizeChars': declared } } as Tool];
    },
    async callTool() {
      // Space-separated so the payload is plain text: an unbroken alphanumeric
      // run of this length is treated as base64 and routed to asset extraction
      // before the size guard is ever consulted.
      return { content: [{ type: 'text', text: 'x '.repeat(chars / 2) }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient;
}

describe('McpClientPool per-call response-persistence context', () => {
  const tmpDirs: string[] = [];
  const mkSessionDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-pool-p3-'));
    tmpDirs.push(dir);
    return dir;
  };
  // Save/restore the MCP output-limit env var so a case that moves the
  // threshold cannot leak into the rest of the file (mirrors
  // mcp-pool-call-idle-timeout.test.ts).
  const previousOutputTokens = process.env[MCP_OUTPUT_TOKENS_ENV];
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    if (previousOutputTokens === undefined) delete process.env[MCP_OUTPUT_TOKENS_ENV];
    else process.env[MCP_OUTPUT_TOKENS_ENV] = previousOutputTokens;
  });

  // A fake transport through the REAL `connect` (mirrors TestPool) — DA3.16.
  const register = (pool: McpClientPool, slug: string, client: PoolClient) =>
    registerFixtureClient(pool, slug, client);

  // `mcp.md:1041` — the env limit "applies to tools that don't declare their own
  // limit. Tools that set `anthropic/maxResultSizeChars` use that value INSTEAD
  // for text content", i.e. the declared value is the sole text gate and moves
  // the threshold in both directions, capped at the documented hard ceiling of
  // 500,000 characters (`mcp.md:1058`). It is not a truncation limit.
  it('lets a tool declaring maxResultSizeChars return a result the default threshold would persist', async () => {
    const sessionDir = mkSessionDir();
    const summarized: string[] = [];
    const pool = new McpClientPool({ sessionPath: sessionDir });
    pool.setSummarizeCallback(async prompt => { summarized.push(prompt); return 'pool-summary'; });
    await register(pool, 'gh', declaredLimitClient(200_000, 120_000));

    const res = await pool.callTool('mcp__gh__big', {});

    expect(res.isError).toBe(false);
    expect(res.content.length).toBe(120_000);
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(false);
    expect(summarized).toEqual([]);
  });

  // `agent-sdk/mcp.md:894` / `mcp.md:1040` — "When a tool result is larger than
  // 25,000 tokens, the full output is saved to a file"; "the default maximum is
  // 25,000 tokens". An MCP result is NOT governed by the local-tool
  // TOKEN_LIMIT (12,000), which is what used to persist everything in the
  // ~12k–25k token band.
  it('returns a ~20,000-token MCP result inline under the documented 25,000-token limit', async () => {
    const sessionDir = mkSessionDir();
    const summarized: string[] = [];
    const pool = new McpClientPool({ sessionPath: sessionDir });
    pool.setSummarizeCallback(async prompt => { summarized.push(prompt); return 'pool-summary'; });
    // 80,000 plain-text chars ≈ 20,000 tokens at the 4-chars/token heuristic.
    await register(pool, 'gh', sizedTextClient(80_000));

    const res = await pool.callTool('mcp__gh__big', {});

    expect(res.isError).toBe(false);
    expect(res.content.length).toBe(80_000);
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(false);
    expect(summarized).toEqual([]);
  });

  // `mcp.md:1039` — the limit is adjusted with the env var (`MAX_MCP_OUTPUT_TOKENS`,
  // spelled `NESSY_MCP_OUTPUT_TOKENS` here). Same payload as above, lowered
  // threshold, opposite outcome.
  it('lets NESSY_MCP_OUTPUT_TOKENS move the threshold for the same result', async () => {
    process.env[MCP_OUTPUT_TOKENS_ENV] = '15000';
    const sessionDir = mkSessionDir();
    const summarized: string[] = [];
    const pool = new McpClientPool({ sessionPath: sessionDir });
    pool.setSummarizeCallback(async prompt => { summarized.push(prompt); return 'pool-summary'; });
    await register(pool, 'gh', sizedTextClient(80_000));

    const res = await pool.callTool('mcp__gh__big', {});

    // ~20,000 tokens now exceeds the configured 15,000 → persisted + summarized.
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(true);
    expect(summarized.length).toBe(1);
    expect(res.content).toContain('pool-summary');
  });

  // The other direction of "use that value instead" (`mcp.md:1041`): a tool
  // declaring LESS than the default is honoured downward. Under the old
  // raise-only composition this 20,000-char result passed inline, because
  // 5,000 estimated tokens sat under the token threshold.
  it('honours a declared allowance BELOW the default, persisting a result the token limit would inline', async () => {
    const sessionDir = mkSessionDir();
    const pool = new McpClientPool({ sessionPath: sessionDir });
    await register(pool, 'gh', declaredLimitClient(5_000, 20_000));

    const res = await pool.callTool('mcp__gh__big', {});

    expect(res.isError).toBe(false);
    expect(res.content.length).toBeLessThan(20_000);
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(true);
  });

  it('caps the declared allowance at the documented 500,000-character ceiling', async () => {
    const sessionDir = mkSessionDir();
    const pool = new McpClientPool({ sessionPath: sessionDir });
    await register(pool, 'gh', declaredLimitClient(2_000_000, 600_000));

    const res = await pool.callTool('mcp__gh__big', {});

    // Past the ceiling the normal guard applies again, so the result is
    // persisted and replaced with a file reference instead of being inlined.
    expect(res.content.length).toBeLessThan(600_000);
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(true);
  });

  it('falls back to the pool-level sessionPath + summarize callback when no per-call context is given (byte-equivalent to today)', async () => {
    const sessionDir = mkSessionDir();
    const summarized: string[] = [];
    const pool = new McpClientPool({ sessionPath: sessionDir });
    pool.setSummarizeCallback(async prompt => {
      summarized.push(prompt);
      return 'pool-summary';
    });
    await register(pool, 'gh', bigTextClient());

    // No 4th arg → pool default drives the save + summarize.
    const res = await pool.callTool('mcp__gh__big', {});
    expect(res.isError).toBe(false);
    // Large response was persisted into the pool-level session dir + summarized.
    expect(existsSync(join(sessionDir, 'long_responses'))).toBe(true);
    expect(summarized.length).toBe(1);
    expect(res.content).toContain('pool-summary');
  });

  it('two callTools with DIFFERENT per-call contexts on ONE shared pool save into their OWN dirs and summarize with their OWN callbacks', async () => {
    // Simulate the post-sharing world: ONE pool, no session identity of its own,
    // two sessions each supplying their own context per call.
    const dirA = mkSessionDir();
    const dirB = mkSessionDir();
    const summarizedByA: string[] = [];
    const summarizedByB: string[] = [];
    const pool = new McpClientPool(); // shared: no pool-level sessionPath/callback
    await register(pool, 'gh', bigTextClient());

    const resA = await pool.callTool('mcp__gh__big', {}, undefined, {
      sessionPath: dirA,
      summarize: async () => { summarizedByA.push('A'); return 'summary-A'; },
    });
    const resB = await pool.callTool('mcp__gh__big', {}, undefined, {
      sessionPath: dirB,
      summarize: async () => { summarizedByB.push('B'); return 'summary-B'; },
    });

    // Each response saved under ITS OWN session dir — no cross-session leak.
    expect(existsSync(join(dirA, 'long_responses'))).toBe(true);
    expect(existsSync(join(dirB, 'long_responses'))).toBe(true);
    // Session A's dir never received session B's response and vice versa.
    expect(resA.content).toContain(dirA);
    expect(resA.content).not.toContain(dirB);
    expect(resB.content).toContain(dirB);
    expect(resB.content).not.toContain(dirA);
    // Each call used ITS OWN summarize callback exactly once.
    expect(summarizedByA).toEqual(['A']);
    expect(summarizedByB).toEqual(['B']);
    expect(resA.content).toContain('summary-A');
    expect(resB.content).toContain('summary-B');
  });

  it('a missing per-call context AND no pool default skips persistence without crashing', async () => {
    const pool = new McpClientPool(); // no sessionPath, no summarize callback
    await register(pool, 'gh', bigTextClient());

    // No dir anywhere → guardLargeResult is skipped; the raw text is returned.
    const res = await pool.callTool('mcp__gh__big', {});
    expect(res.isError).toBe(false);
    expect(res.content.startsWith('x x')).toBe(true);
  });
});

describe('McpClientPool dynamic capability refresh', () => {
  it('serializes a connection refresh and keeps old routes until the replacement succeeds', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const source = dynamicClient([tool('a.b'), tool('a_b')], calls);
    const pool = new TestPool();
    await pool.register('gh', source.client);
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let refreshes = 0;
    let active = 0;
    let maxActive = 0;
    source.setListTools(async () => {
      refreshes++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (refreshes === 1) {
        start();
        await blocked;
      }
      active--;
      return [tool('a_b'), tool('next')];
    });

    source.notify('tools');
    await started;
    for (let index = 0; index < 100; index++) source.notify('tools');
    expect(pool.getProxyToolDefs(['gh']).map(definition => definition.name).sort())
      .toEqual(['mcp__gh__a_b', 'mcp__gh__a_b_2']);

    release();
    await eventually(() => expect(refreshes).toBe(2));
    await eventually(() => expect(pool.getProxyToolDefs(['gh']).map(definition => definition.name).sort())
      .toEqual(['mcp__gh__a_b_2', 'mcp__gh__next']));
    expect(maxActive).toBe(1);
    expect(pool.getProxyName('gh', 'a_b')).toBe('mcp__gh__a_b_2');
  });

  it('revokes a withdrawn route before an immediate next call', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const source = dynamicClient([tool('read')], calls);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    let started!: () => void;
    const refreshStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    source.setListTools(async () => {
      started();
      await blocked;
      return [];
    });

    source.notify('tools');
    await refreshStarted;
    const call = pool.callTool('mcp__ctx__read', {});
    await Promise.resolve();
    expect(calls).toEqual([]);

    release();
    await expect(call).resolves.toMatchObject({
      isError: true,
      content: 'Unknown MCP proxy tool: mcp__ctx__read',
    });
    expect(calls).toEqual([]);
  });

  it('restarts the drain when a notification arrives at the completion edge', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    let refreshes = 0;
    source.setListTools(async () => {
      refreshes++;
      return refreshes === 1 ? [tool('read')] : [tool('write')];
    });
    const internals = pool as unknown as {
      drainConnectionCapabilityNotifications: (connectionKey: string) => Promise<void>;
    };
    const drain = internals.drainConnectionCapabilityNotifications.bind(pool);
    let injected = false;
    internals.drainConnectionCapabilityNotifications = async connectionKey => {
      await drain(connectionKey);
      if (injected) return;
      injected = true;
      source.notify('tools');
    };

    source.notify('tools');
    await eventually(() => expect(refreshes).toBe(2));
    await eventually(() => expect(pool.getProxyToolDefs(['ctx']).map(definition => definition.name))
      .toEqual(['mcp__ctx__write']));
  });

  it('keeps a resource failure degraded until resources recover, despite a prompts refresh', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    source.setResources([{ uri: 'nessy://old' }]);
    source.setPrompts([{ name: 'old-prompt' }]);
    await pool.listContextResources();
    expect(await pool.listContextResources()).toEqual([
      { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://old' } },
      { sourceSlug: 'ctx', kind: 'prompt', value: { name: 'old-prompt' } },
    ]);

    source.setListResources(async () => { throw new Error('resource-refresh-failed'); });
    source.notify('resources');
    await eventually(() => expect(pool.health()).toMatchObject({ status: 'degraded', failed: ['ctx'] }));
    expect(await pool.listContextResources()).toContainEqual(
      { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://old' } },
    );

    source.setPrompts([{ name: 'new-prompt' }]);
    source.notify('prompts');
    await eventuallyAsync(async () => {
      expect(await pool.listContextResources()).toContainEqual(
        { sourceSlug: 'ctx', kind: 'prompt', value: { name: 'new-prompt' } },
      );
    });
    expect(pool.health()).toMatchObject({ status: 'degraded', failed: ['ctx'] });

    source.setResources([{ uri: 'nessy://new' }]);
    source.notify('resources');
    await eventuallyAsync(async () => {
      expect(await pool.listContextResources()).toContainEqual(
        { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://new' } },
      );
    });
    expect(pool.health()).toMatchObject({ status: 'ready', failed: [] });
  });

  it('refreshes resource and prompt catalogs from protocol list-changed notifications', async () => {
    let resources = [{ uri: 'nessy://old', name: 'old-resource' }];
    let prompts = [{ name: 'old-prompt' }];
    // P6.553 — KEPT on the low-level `Server`: this case exists to mutate the backing
    // catalogs and THEN fire `notifications/*/list_changed` at a chosen moment.
    // `McpServer.registerResource`/`registerPrompt` own both halves and emit the
    // notification themselves, so the two could not be separated — which is the thing
    // under test.
    const server = new Server({ name: 'dynamic-test', version: '1.0.0' }, {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [tool('read')] }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources }));
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new NessyMcpClient(
      { transport: 'http', url: 'https://mcp.example.test/mcp' },
      { transport: clientTransport },
    );
    const pool = new TestPool();
    try {
      await pool.register('ctx', client);
      expect(await client.listResources()).toEqual({ resources: [{ uri: 'nessy://old', name: 'old-resource' }] });
      await pool.listContextResources();
      resources = [{ uri: 'nessy://new', name: 'new-resource' }];
      prompts = [{ name: 'new-prompt' }];

      await server.notification({ method: 'notifications/resources/list_changed' });
      await server.notification({ method: 'notifications/prompts/list_changed' });
      await eventuallyAsync(async () => {
        expect(await pool.listContextResources()).toEqual([
          { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://new', name: 'new-resource' } },
          { sourceSlug: 'ctx', kind: 'prompt', value: { name: 'new-prompt' } },
        ]);
      });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it('serializes lazy context catalog reads behind source notifications', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let resourceReads = 0;
    source.setListResources(async (): Promise<McpResourceListPage> => {
      resourceReads++;
      if (resourceReads === 1) {
        await blocked;
        return { resources: [{ uri: 'nessy://old' }] };
      }
      return { resources: [{ uri: 'nessy://new' }] };
    });

    const inventory = pool.listContextResources();
    await eventually(() => expect(resourceReads).toBe(1));
    source.notify('resources');
    await Promise.resolve();
    await Promise.resolve();
    release();
    await inventory;
    await eventuallyAsync(async () => {
      expect(await pool.listContextResources()).toContainEqual(
        { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://new' } },
      );
    });
  });

  it('does not invalidate a model turn when the effective tool catalog is unchanged', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    const connectionKey = await pool.register('ctx', source.client);
    let invalidations = 0;
    pool.onToolsChanged = () => { invalidations++; };

    await pool.refresh(connectionKey, 'tools');
    expect(invalidations).toBe(0);

    source.setTools([tool('write')]);
    await pool.refresh(connectionKey, 'tools');
    expect(invalidations).toBe(1);
  });

  it('retains last-good tool routes and reports degraded health when a tool refresh fails', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    const connectionKey = await pool.register('ctx', source.client);

    source.setListTools(async () => { throw new Error('tool-refresh-failed'); });
    await pool.refresh(connectionKey, 'tools');

    expect(pool.getProxyToolDefs(['ctx']).map(definition => definition.name)).toEqual(['mcp__ctx__read']);
    expect(pool.health()).toMatchObject({ status: 'degraded', failed: ['ctx'] });
  });

  it('keeps an existing proxy name when a newly added collision appears first', async () => {
    const source = dynamicClient([tool('a.b')], []);
    const pool = new TestPool();
    const connectionKey = await pool.register('gh', source.client);

    source.setTools([tool('a/b'), tool('a.b')]);
    await pool.refresh(connectionKey, 'tools');

    expect(pool.getProxyName('gh', 'a.b')).toBe('mcp__gh__a_b');
    expect(pool.getProxyName('gh', 'a/b')).toBe('mcp__gh__a_b_2');
  });

  it('refuses a removed leased route without falling through to another session connection', async () => {
    const callsA: Array<{ name: string; args: unknown }> = [];
    const callsB: Array<{ name: string; args: unknown }> = [];
    const sourceA = dynamicClient([tool('read')], callsA);
    const sourceB = dynamicClient([tool('read')], callsB);
    const pool = new DynamicLeaserPool(new Map([
      ['https://a.example.test/mcp', sourceA],
      ['https://b.example.test/mcp', sourceB],
    ]));
    const configA = { type: 'http' as const, url: 'https://a.example.test/mcp' };
    const configB = { type: 'http' as const, url: 'https://b.example.test/mcp' };
    await pool.sync({ shared: configA }, {}, { leaserId: 'A' });
    await pool.sync({ shared: configB }, {}, { leaserId: 'B' });

    sourceA.setTools([]);
    sourceA.notify('tools');
    await eventually(() => expect(pool.getProxyToolDefs(['shared'], 'A')).toEqual([]));

    const removed = await pool.callTool('mcp__shared__read', {}, undefined, { leaserId: 'A' });
    expect(removed).toMatchObject({ isError: true, content: 'Tool not available in this session' });
    expect(callsA).toEqual([]);
    expect(callsB).toEqual([]);

    const retained = await pool.callTool('mcp__shared__read', {}, undefined, { leaserId: 'B' });
    expect(retained.isError).toBe(false);
    expect(callsB).toEqual([{ name: 'read', args: {} }]);
  });

  it('fans tool changes out to each started pool server and removes stopped listeners', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    const first = new McpPoolServer(pool);
    const second = new McpPoolServer(pool);
    let firstNotifications = 0;
    let secondNotifications = 0;
    try {
      await first.start();
      await second.start();
      (first as unknown as { notifyToolsChanged: () => void }).notifyToolsChanged = () => { firstNotifications++; };
      (second as unknown as { notifyToolsChanged: () => void }).notifyToolsChanged = () => { secondNotifications++; };

      source.setTools([tool('write')]);
      source.notify('tools');
      await eventually(() => expect([firstNotifications, secondNotifications]).toEqual([1, 1]));

      await first.stop();
      source.setTools([tool('delete')]);
      source.notify('tools');
      await eventually(() => expect(secondNotifications).toBe(2));
      expect(firstNotifications).toBe(1);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('serves repeated Streamable HTTP requests through one stateful client session', async () => {
    const source = dynamicClient([tool('read')], []);
    const pool = new TestPool();
    await pool.register('ctx', source.client);
    const server = new McpPoolServer(pool);
    const client = new Client({ name: 'http-test-client', version: '1.0.0' });
    let notifications = 0;
    try {
      await server.start();
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${server.bearerToken}` } },
      }));
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
      expect((await client.listTools()).tools.map(entry => entry.name)).toEqual(['ctx__read']);
      expect((await client.listTools()).tools.map(entry => entry.name)).toEqual(['ctx__read']);
      source.setTools([tool('write')]);
      source.notify('tools');
      await eventuallyAsync(async () => {
        await Bun.sleep(10);
        expect(notifications).toBe(1);
      });
      expect((await client.listTools()).tools.map(entry => entry.name)).toEqual(['ctx__write']);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });

  it('rejects missing and wrong bearer credentials before MCP protocol handling', async () => {
    const pool = new TestPool();
    const server = new McpPoolServer(pool);
    try {
      await server.start();
      for (const authorization of [undefined, 'Bearer wrong']) {
        const response = await fetch(server.url, {
          headers: authorization ? { authorization } : {},
        });
        expect(response.status).toBe(401);
      }
      expect((server as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

// ============================================================
// P2a — pool primitives: leaser release + per-session view/call guard
//
// The shared pool reconciles against the UNION of every leaser's desired set
// (P1). P2a adds the DORMANT, ADDITIVE primitives a session wiring (P2b) will
// use: drop a leaser (release its slugs, disconnecting only the ones no other
// leaser wants), and scope reads/calls to a single leaser's slugs. Every guard
// is a no-op when no leaserId is passed — today's global behavior byte-for-byte.
// ============================================================

// Per-slug fake client factory: records this slug's callTool invocations so a
// refused call can be proven to have executed ZERO times.
function spyClient(slug: string, calls: Array<{ slug: string; name: string }>): PoolClient {
  return {
    async listTools() { return [tool(`t_${slug}`)]; },
    async callTool(name: string) {
      calls.push({ slug, name });
      return { content: [{ type: 'text', text: `ok:${slug}` }], isError: false };
    },
    async close() {},
  } as unknown as PoolClient;
}

// Drive sync()/reconcileUnion() with real per-leaser desired-map bookkeeping,
// but register a spyable fake instead of a live NessyMcpClient (mirrors the
// TestablePool pattern in tests/mcp-pool.test.ts). The stdio configs below
// name a slug; connect() ignores the config and registers that slug's spy.
class LeaserTestPool extends McpClientPool {
  constructor(private readonly calls: Array<{ slug: string; name: string }>) { super(); }
  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    return spyClient(slug, this.calls);
  }
}

// A desired-set entry for a slug (config content is irrelevant — connect() is
// overridden). stdio + workspaceRootPath unset ⇒ localEnabled ⇒ not filtered.
const src = (slug: string): Record<string, import('../../agent/backend/types.ts').SdkMcpServerConfig> =>
  ({ [slug]: { type: 'stdio', command: `cmd-${slug}` } });
const proxyOf = (slug: string) => `mcp__${slug}__t_${slug}`;

describe('McpClientPool leaser-scoped drop + per-session guards (P2a)', () => {
  /**
   * DA3.15 — "a SHARED slug" is the posture's name, and the case is only true
   * under it. `A` and `B` both want `s1`, and the assertion that dropping `B`
   * leaves `s1` alive depends on those two wants being ONE connection.
   *
   * Under `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` they are two, and the very
   * first assertion already parts company: `getConnectedSlugs()` answers
   * `['s2']` where the case expects `['s1', 's2']` (measured 2026-09-17). Left
   * unpinned on purpose — see the sibling note below and DA3.15's row.
   */
  it('dropLeaser disconnects only a leaser-EXCLUSIVE server; a shared slug survives', async () => {
    const calls: Array<{ slug: string; name: string }> = [];
    const pool = new LeaserTestPool(calls);
    // A wants {s1}; B wants {s1, s2}. Union = {s1, s2}.
    await pool.sync({ ...src('s1') }, {}, { leaserId: 'A' });
    await pool.sync({ ...src('s1'), ...src('s2') }, {}, { leaserId: 'B' });
    expect(pool.getConnectedSlugs().sort()).toEqual(['s1', 's2']);

    // Dropping B leaves s1 (A still wants it) but removes s2 (B's exclusive slug).
    await pool.dropLeaser('B');
    expect(pool.getConnectedSlugs()).toEqual(['s1']);
    // s2's proxy tool is gone from the pool; s1's remains.
    expect(pool.getProxyToolDefs().map(d => d.name).sort()).toEqual([proxyOf('s1')]);
  });

  it('leaser-scoped callTool refuses a FOREIGN slug without executing, but runs an OWNED one', async () => {
    const calls: Array<{ slug: string; name: string }> = [];
    const pool = new LeaserTestPool(calls);
    // A owns only s1; the pool also connects s2 for B.
    await pool.sync({ ...src('s1') }, {}, { leaserId: 'A' });
    await pool.sync({ ...src('s2') }, {}, { leaserId: 'B' });

    // A calls s2's tool → refused, s2's client NEVER invoked.
    const foreign = await pool.callTool(proxyOf('s2'), {}, undefined, { leaserId: 'A' });
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toBe('Tool not available in this session');
    expect(calls.filter(c => c.slug === 's2')).toEqual([]);

    // A calls its OWN s1 tool → executes normally.
    const owned = await pool.callTool(proxyOf('s1'), {}, undefined, { leaserId: 'A' });
    expect(owned.isError).toBe(false);
    expect(calls.filter(c => c.slug === 's1')).toEqual([{ slug: 's1', name: 't_s1' }]);
  });

  it('a slug shared by two leasers is callable under EITHER leaser identity', async () => {
    const calls: Array<{ slug: string; name: string }> = [];
    const pool = new LeaserTestPool(calls);
    await pool.sync({ ...src('s1') }, {}, { leaserId: 'A' });
    await pool.sync({ ...src('s1') }, {}, { leaserId: 'B' });

    const asA = await pool.callTool(proxyOf('s1'), {}, undefined, { leaserId: 'A' });
    const asB = await pool.callTool(proxyOf('s1'), {}, undefined, { leaserId: 'B' });
    expect(asA.isError).toBe(false);
    expect(asB.isError).toBe(false);
    expect(calls.filter(c => c.slug === 's1').length).toBe(2);
  });

  it('isProxyTool with a leaserId scopes to owned slugs; without one, it is unchanged', async () => {
    const calls: Array<{ slug: string; name: string }> = [];
    const pool = new LeaserTestPool(calls);
    await pool.sync({ ...src('s1') }, {}, { leaserId: 'A' });
    await pool.sync({ ...src('s2') }, {}, { leaserId: 'B' });

    // A owns s1, not s2.
    expect(pool.isProxyTool(proxyOf('s1'), 'A')).toBe(true);
    expect(pool.isProxyTool(proxyOf('s2'), 'A')).toBe(false);
    // No leaserId → global behavior: both connected proxies match, unknown does not.
    expect(pool.isProxyTool(proxyOf('s1'))).toBe(true);
    expect(pool.isProxyTool(proxyOf('s2'))).toBe(true);
    expect(pool.isProxyTool('mcp__nope__x')).toBe(false);
  });

  it('slugsForLeaser unions MCP + API keys and is empty for an unknown leaser', async () => {
    const pool = new LeaserTestPool([]);
    await pool.sync({ ...src('s1'), ...src('s2') }, {}, { leaserId: 'A' });
    expect([...pool.slugsForLeaser('A')].sort()).toEqual(['s1', 's2']);
    expect(pool.slugsForLeaser('B').size).toBe(0);
  });

  it('hasLeaser distinguishes an empty synced desired set from an unknown leaser', async () => {
    const pool = new LeaserTestPool([]);
    await pool.sync({}, {}, { leaserId: 'empty' });
    expect(pool.hasLeaser('empty')).toBe(true);
    expect(pool.hasLeaser('unknown')).toBe(false);
    await pool.dropLeaser('empty');
    expect(pool.hasLeaser('empty')).toBe(false);
  });
});

// ============================================================
// P2b — McpPoolServer per-session view over the SHARED pool
//
// The poolServer stays per-session (per-subprocess) but the underlying pool is
// shared. Configured with leaserId=A over a pool where A={s1}, B={s1,s2}:
// ListTools serves ONLY s1's tools, a CallTool for s2's proxy is refused
// (call-authz guard) without touching s2, and a CallTool for s1 executes with
// A's per-call context (sessionPath) so its large response persists into A's
// dir. Drives the REAL server handlers (createMcpServer) via an MCP Client over
// an in-memory transport pair.
// ============================================================

// A pool whose connect() registers a per-slug client: s1 returns an over-threshold
// text (to prove per-call persistence), every other slug is a recorded spy.
class ViewTestPool extends McpClientPool {
  constructor(private readonly calls: Array<{ slug: string; name: string }>) { super(); }
  protected override async openConnection({ slug }: McpOpenConnectionRequest): Promise<PoolClient> {
    // R13 (RF-c) found this INNER BRANCH half-repaired while the census that
    // counted override SITES scored the file green: the `s1` arm called
    // `registerClient` with three arguments and dropped the key. DA3.6 retires
    // the class — there is no `registerClient` call here to get wrong.
    if (slug === 's1') {
      const big = 'x '.repeat(60_000);
      return {
        async listTools() { return [tool('read')]; },
        async callTool(_name: string) { return { content: [{ type: 'text', text: big }], isError: false }; },
        async close() {},
      } as unknown as PoolClient;
    }
    return spyClient(slug, this.calls);
  }
}

describe('McpPoolServer per-session view (P2b)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });

  // Drive the REAL server handlers (createMcpServer) over an in-memory transport
  // pair — the same wiring start() uses, minus the stateless HTTP handshake
  // (which subprocesses drive with a full SSE client; awkward for a unit test).
  async function connectClient(server: McpPoolServer): Promise<{ client: Client; close: () => Promise<void> }> {
    const inner = (server as unknown as { createMcpServer(): Server }).createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await inner.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    return { client, close: async () => { await client.close().catch(() => {}); await inner.close().catch(() => {}); } };
  }

  /**
   * DA3.15 — same dependency as the `dropLeaser` case above, and it fails the
   * same way: the "union connects both" line assumes `A`'s `s1` and `B`'s `s1`
   * are one connection, which is what `shared` means. Under `per-leaser`,
   * `getConnectedSlugs()` answers `['s2']` (measured 2026-09-17).
   *
   * Everything the case is ABOUT — the per-session view, the foreign-slug
   * refusal, the persisted call — is posture-independent; it is only the fixture
   * arrangement that leans on sharing. Not pinned to `shared`: these cases are
   * the only instrument that would fire if `DA3.2`'s default moved.
   */
  it('lists only the leaser view, refuses a foreign slug, and persists an owned call into the session dir', async () => {
    const calls: Array<{ slug: string; name: string }> = [];
    const pool = new ViewTestPool(calls);
    // A owns {s1}; B additionally owns {s2}. Union connects both.
    await pool.sync({ ...src('s1') }, {}, { leaserId: 'A' });
    await pool.sync({ ...src('s1'), ...src('s2') }, {}, { leaserId: 'B' });
    expect(pool.getConnectedSlugs().sort()).toEqual(['s1', 's2']);

    const dirA = mkdtempSync(join(tmpdir(), 'pool-server-view-'));
    tmpDirs.push(dirA);
    const server = new McpPoolServer(pool, { leaserId: 'A', getCallContext: () => ({ sessionPath: dirA }) });
    const { client, close } = await connectClient(server);
    try {
      // ListTools exposes ONLY s1's tool (mcp__ prefix stripped by the server).
      const listed = (await client.listTools()).tools.map(t => t.name).sort();
      expect(listed).toEqual(['s1__read']);

      // A CallTool for s2 (foreign to leaser A) is refused; s2's spy never runs.
      const foreign = await client.callTool({ name: 's2__t_s2', arguments: {} });
      expect(foreign.isError).toBe(true);
      expect(calls.filter(c => c.slug === 's2')).toEqual([]);

      // A CallTool for s1 (owned) executes; the over-threshold response persists
      // into leaser A's session dir via the per-call context (getCallContext).
      const owned = await client.callTool({ name: 's1__read', arguments: {} });
      expect(owned.isError).toBeFalsy();
      expect(existsSync(join(dirA, 'long_responses'))).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('McpClientPool resource/prompt read paths', () => {
  it('readResource routes to the addressed source and returns its contents', async () => {
    const reads: string[] = [];
    const client = {
      listTools: async () => [tool('read')],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
      readResource: async (uri: string) => {
        reads.push(uri);
        return { contents: [{ uri, mimeType: 'text/plain', text: `body:${uri}` }] };
      },
      getPrompt: async () => ({ messages: [] }),
    } as unknown as PoolClient;
    const pool = new TestPool();
    await pool.register('ctx', client);

    const result = await pool.readResource('ctx', 'file:///x.txt');
    expect(reads).toEqual(['file:///x.txt']);
    expect(result).toEqual({ contents: [{ uri: 'file:///x.txt', mimeType: 'text/plain', text: 'body:file:///x.txt' }] });
  });

  it('getPrompt forwards the name and args and returns the prompt messages', async () => {
    const calls: Array<{ name: string; args?: Record<string, string> }> = [];
    const client = {
      listTools: async () => [tool('read')],
      callTool: async () => ({ content: [], isError: false }),
      close: async () => {},
      readResource: async () => ({ contents: [] }),
      getPrompt: async (name: string, args?: Record<string, string>) => {
        calls.push({ name, args });
        return { messages: [{ role: 'user', content: { type: 'text', text: `hi ${args?.who ?? ''}` } }] };
      },
    } as unknown as PoolClient;
    const pool = new TestPool();
    await pool.register('ctx', client);

    const result = await pool.getPrompt('ctx', 'greet', { who: 'bob' });
    expect(calls).toEqual([{ name: 'greet', args: { who: 'bob' } }]);
    expect(result).toEqual({ messages: [{ role: 'user', content: { type: 'text', text: 'hi bob' } }] });
  });

  it('throws when the source is unknown or does not advertise the capability', async () => {
    const pool = new TestPool();
    // No readResource/getPrompt on this fake -> unsupported.
    await pool.register('bare', fakeClient([tool('read')], []));
    await expect(pool.readResource('missing', 'file:///x')).rejects.toThrow(/not-connected/);
    await expect(pool.readResource('bare', 'file:///x')).rejects.toThrow(/unsupported/);
    await expect(pool.getPrompt('bare', 'p')).rejects.toThrow(/unsupported/);
  });
});

describe('McpClientPool capability-discovery retry classification', () => {
  // Zero the backoff so the bounded retry runs without real timers.
  class RetryTestPool extends TestPool {
    protected override discoveryRetryDelayMs(): number { return 0; }
  }
  const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { code: status });

  it('retries a 5xx discovery failure up to three attempts, then keeps the prior list', async () => {
    let attempts = 0;
    const source = dynamicClient([tool('read')], []);
    const pool = new RetryTestPool();
    const key = await pool.register('ctx', source.client);
    source.setResources([{ uri: 'nessy://old' }]);
    await pool.refresh(key, 'resources');
    expect(await pool.listContextResources()).toContainEqual(
      { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://old' } },
    );

    source.setListResources(async () => { attempts++; throw httpError(503); });
    await pool.refresh(key, 'resources');

    expect(attempts).toBe(3);
    expect(await pool.listContextResources()).toContainEqual(
      { sourceSlug: 'ctx', kind: 'resource', value: { uri: 'nessy://old' } },
    );
    expect(pool.health()).toMatchObject({ status: 'degraded', failed: ['ctx'] });
  });

  it('does not retry an auth/4xx discovery failure', async () => {
    let attempts = 0;
    const source = dynamicClient([tool('read')], []);
    const pool = new RetryTestPool();
    const key = await pool.register('ctx', source.client);
    source.setListResources(async () => { attempts++; throw httpError(401); });

    await pool.refresh(key, 'resources');
    expect(attempts).toBe(1);
  });
});

describe('McpClientPool resource-capability gating', () => {
  const capClient = (declares: { resources?: boolean }): PoolClient => ({
    listTools: async () => [tool('read')],
    callTool: async () => ({ content: [], isError: false }),
    close: async () => {},
    getServerCapabilities: () => ({ tools: {}, ...(declares.resources ? { resources: {} } : {}) }),
  } as unknown as PoolClient);

  it('is true once a connected source advertises the resources capability', async () => {
    const pool = new TestPool();
    await pool.register('no-res', capClient({}));
    expect(pool.hasResourceCapability()).toBe(false);
    await pool.register('with-res', capClient({ resources: true }));
    expect(pool.hasResourceCapability()).toBe(true);
  });

  it('is false when no connected source advertises resources', async () => {
    const pool = new TestPool();
    await pool.register('a', capClient({}));
    await pool.register('b', capClient({}));
    expect(pool.hasResourceCapability()).toBe(false);
  });
});

// ============================================================
// T6 — three-runtime naming conformance (2026-08-10,
// stable-plugin-mcp-wire-names plan). The naming mint
// (`capabilities/mcp-wire-name.ts` + `applyCollisionPolicy`'s `byMcp` branch)
// is the ONE authority for MCP wire names; every runtime is expected to read
// names from it through THIS pool and agree with each other. Pi's own
// conformance (resolver -> manifest seed, plus the incident repro) is proven
// end to end in
// `capabilities/__tests__/plugin-builtin-collision.integration.test.ts`; the
// two blocks below pin the Claude and Codex runtimes' consumption of the same
// pool contract.
// ============================================================

describe('Claude runtime conformance: the pool contract createSourceProxyServers consumes (T6 Step 2)', () => {
  // `createSourceProxyServers` (`agent/claude-agent.ts:593`) is a module-private,
  // unexported function reached only from inside a live `ClaudeAgent` turn —
  // instantiating that class means a real SDK subprocess/session config, far
  // too heavy for a unit test. Per the plan's own fallback, this asserts the
  // POOL CONTRACT that function consumes instead: `getTools` + `getProxyName`,
  // iterated the exact same way it does (one SDK server keyed by slug, one
  // tool per proxy def, `toolSegment = proxyName.slice('mcp__<slug>__'.length)`
  // so the SDK's own `mcp__{serverKey}__{toolSegment}` prefixing reproduces
  // `proxyName` exactly) — proving the same naming-mint output Claude's SDK
  // option builder would receive, without paying for a real agent.
  it('two servers under t-tracker / plugin_x_t-tracker mint distinct, correctly-prefixed proxy names', async () => {
    const pool = new TestPool();
    const builtinCalls: Array<{ name: string; args: unknown }> = [];
    const pluginCalls: Array<{ name: string; args: unknown }> = [];
    await pool.register('t-tracker', fakeClient([tool('list')], builtinCalls));
    await pool.register('plugin_x_t-tracker', fakeClient([tool('list')], pluginCalls));

    expect(pool.getProxyName('t-tracker', 'list')).toBe('mcp__t-tracker__list');
    expect(pool.getProxyName('plugin_x_t-tracker', 'list')).toBe('mcp__plugin_x_t-tracker__list');
    expect(pool.getProxyName('t-tracker', 'list').length).toBeLessThanOrEqual(64);
    expect(pool.getProxyName('plugin_x_t-tracker', 'list').length).toBeLessThanOrEqual(64);

    // Reproduce createSourceProxyServers's own per-slug SDK-server construction.
    const slugs = pool.getConnectedSlugs();
    expect(new Set(slugs)).toEqual(new Set(['t-tracker', 'plugin_x_t-tracker']));

    const sdkServers = new Map<string, Array<{ toolSegment: string; finalName: string }>>();
    for (const slug of slugs) {
      const mcpTools = pool.getTools(slug);
      const proxyTools = mcpTools.map(mcpTool => {
        const proxyName = pool.getProxyName(slug, mcpTool.name);
        const toolSegment = proxyName.slice(`mcp__${slug}__`.length);
        // What the SDK reconstructs: `mcp__{serverKey}__{toolSegment}`, serverKey === slug.
        return { toolSegment, finalName: `mcp__${slug}__${toolSegment}` };
      });
      sdkServers.set(slug, proxyTools);
    }

    // Distinct entries for both servers — the exact "yields distinct entries
    // for both servers" the brief asks for.
    expect(sdkServers.size).toBe(2);
    const builtinTool = sdkServers.get('t-tracker')?.[0];
    const pluginTool = sdkServers.get('plugin_x_t-tracker')?.[0];
    expect(builtinTool?.finalName).toBe('mcp__t-tracker__list');
    expect(pluginTool?.finalName).toBe('mcp__plugin_x_t-tracker__list');
    // Equality by construction, not assumption: the SDK's own reconstructed
    // name must equal what registerClient actually minted and what callTool
    // will route on — the two sides Claude's proxy layer must agree on.
    expect(builtinTool?.finalName).toBe(pool.getProxyName('t-tracker', 'list'));
    expect(pluginTool?.finalName).toBe(pool.getProxyName('plugin_x_t-tracker', 'list'));

    // And the reconstructed names actually route to the right underlying
    // server — what the SDK's own tool handler calls at runtime.
    await pool.callTool(builtinTool!.finalName, {});
    await pool.callTool(pluginTool!.finalName, {});
    expect(builtinCalls).toEqual([{ name: 'list', args: {} }]);
    expect(pluginCalls).toEqual([{ name: 'list', args: {} }]);
  });
});

describe('Codex runtime conformance: pool-server strip/re-route with qualified names (T6 Step 3)', () => {
  // Same in-memory wiring the "McpPoolServer per-session view (P2b)" block
  // above uses: drives the REAL server handlers (createMcpServer) over a
  // linked in-memory transport pair, without the stateless HTTP/SSE handshake
  // subprocesses actually use (awkward for a unit test). Duplicated locally
  // rather than hoisted, since the original is scoped inside its own describe.
  async function connectClient(server: McpPoolServer): Promise<{ client: Client; close: () => Promise<void> }> {
    const inner = (server as unknown as { createMcpServer(): Server }).createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await inner.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    return { client, close: async () => { await client.close().catch(() => {}); await inner.close().catch(() => {}); } };
  }

  it('tools/list exposes t-tracker__list and plugin_x_t-tracker__list (mcp__ stripped, nothing else); tools/call routes each to its own server', async () => {
    const pool = new TestPool();
    const builtinCalls: Array<{ name: string; args: unknown }> = [];
    const pluginCalls: Array<{ name: string; args: unknown }> = [];
    await pool.register('t-tracker', fakeClient([tool('list')], builtinCalls));
    await pool.register('plugin_x_t-tracker', fakeClient([tool('list')], pluginCalls));

    const server = new McpPoolServer(pool);
    const { client, close } = await connectClient(server);
    try {
      const listed = (await client.listTools()).tools.map(t => t.name).sort();
      expect(listed).toEqual(['plugin_x_t-tracker__list', 't-tracker__list']);

      const builtinResult = await client.callTool({ name: 't-tracker__list', arguments: {} });
      expect(builtinResult.isError).toBeFalsy();
      expect(builtinCalls).toEqual([{ name: 'list', args: {} }]);
      expect(pluginCalls).toEqual([]); // the builtin call never touched the plugin server

      const pluginResult = await client.callTool({ name: 'plugin_x_t-tracker__list', arguments: {} });
      expect(pluginResult.isError).toBeFalsy();
      expect(pluginCalls).toEqual([{ name: 'list', args: {} }]);
      expect(builtinCalls).toEqual([{ name: 'list', args: {} }]); // still exactly one — untouched by the plugin call
    } finally {
      await close();
    }
  });

  it('a name long enough to hit the 64-char cap round-trips: list and call agree on the SAME capped name, not merely both present', async () => {
    const pool = new TestPool();
    const calls: Array<{ name: string; args: unknown }> = [];
    const longToolName = 'a'.repeat(50);
    await pool.register('plugin_x_t-tracker', fakeClient([tool(longToolName)], calls));

    // The cap happens at proxy-name MINT (buildPoolProxyBaseName), so the
    // authoritative capped name is whatever the pool itself minted — this is
    // independent verification via getProxyName, not a hand-recomputed hash.
    const mintedProxyName = pool.getProxyName('plugin_x_t-tracker', longToolName);
    expect(mintedProxyName.length).toBeLessThanOrEqual(64);
    // Sanity: this fixture actually exercises the cap, not a no-op.
    expect(mintedProxyName).not.toBe(`mcp__plugin_x_t-tracker__${longToolName}`);

    const server = new McpPoolServer(pool);
    const { client, close } = await connectClient(server);
    try {
      const listed = (await client.listTools()).tools.map(t => t.name);
      expect(listed).toHaveLength(1);
      // list and call must agree BY CONSTRUCTION: assert the equality itself
      // (both sides deriving the name from the same buildPoolProxyBaseName
      // call), not merely that some capped-looking name is present.
      expect(`mcp__${listed[0]}`).toBe(mintedProxyName);

      const result = await client.callTool({ name: listed[0]!, arguments: {} });
      expect(result.isError).toBeFalsy();
      // The capped name reaches the ORIGINAL, uncapped tool.
      expect(calls).toEqual([{ name: longToolName, args: {} }]);
    } finally {
      await close();
    }
  });
});
