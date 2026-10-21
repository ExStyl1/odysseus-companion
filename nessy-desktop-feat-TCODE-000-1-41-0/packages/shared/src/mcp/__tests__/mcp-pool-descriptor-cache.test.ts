import { describe, expect, it } from 'bun:test';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool, toolDescriptorStoreKey } from '../mcp-pool.ts';
import type { ToolDescriptorStore } from '../tool-descriptor-store.ts';
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts';

function memoryStore(seed: Record<string, Tool[]> = {}): ToolDescriptorStore & { written: Record<string, Tool[]> } {
  const written: Record<string, Tool[]> = {};
  return {
    written,
    read: key => seed[key] ?? written[key],
    write: (key, tools) => { written[key] = [...tools]; },
  };
}

const CONFIG: SdkMcpServerConfig = { type: 'stdio', command: '/bin/true', args: [] } as SdkMcpServerConfig;
const TOOL: Tool = { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } } as Tool;

/**
 * DA3.15 — every seed here goes through {@link toolDescriptorStoreKey}, and
 * that is a correction rather than a flourish.
 *
 * `connectionKeyForDesired` answers the pool's CONNECTION identity, which under
 * an isolating posture carries a per-leaser term. The durable store is keyed by
 * the STRIPPED identity on purpose — "what tools did this server report last
 * time" is a property of the server, not of which session holds the socket, and
 * keying it per leaser would make every session's first sync a miss. Seeding
 * these fixtures with the raw connection key therefore wrote records production
 * would never read: three of these cases FAILED under
 * `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` (measured 2026-09-17, 8 failures
 * over the directory) for that reason alone, and they were the only three of the
 * eight that were a defect in the TEST rather than a property of the shared
 * posture.
 *
 * On the default posture the call is a no-op — the key has three parts and comes
 * back unchanged — so nothing about the shipped behaviour is being pinned
 * differently here; the fixture simply stops depending on the default being in
 * force. That is the opposite of pinning `connectionIsolation: 'shared'` on the
 * case, which is what the row forbids: this file now prices the cache under
 * BOTH postures instead of silently under one.
 */
describe('McpClientPool durable descriptor cache', () => {
  it('advertises a desired server with cached descriptors without connecting', async () => {
    // Key derivation is the pool's own; capture it by syncing then reading the
    // store the pool would write to.
    const probe = memoryStore();
    const keyPool = new McpClientPool({ toolDescriptorStore: probe });
    await keyPool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    const connectionKey = keyPool.connectionKeyForDesired('alpha', 'L')!;
    expect(connectionKey).toBeTruthy();

    const store = memoryStore({ [toolDescriptorStoreKey(connectionKey)]: [TOOL] });
    const pool = new McpClientPool({ toolDescriptorStore: store });
    await pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });

    // sync() hydrated from the store; no connect happened.
    expect(pool.isConnected('alpha', 'L')).toBe(false);
    expect(pool.getTools('alpha', 'L')).toEqual([TOOL]);
    expect(pool.getProxyToolDefs(['alpha'], 'L').map(def => def.name)).toEqual(['mcp__alpha__echo']);
  });

  it('round-trips annotations and _meta through the durable descriptor cache', async () => {
    // The store already persists whole `Tool` objects, so this pins that a
    // HYDRATED descriptor projects the same metadata a live one does — the case
    // that matters, since a cold pool's first turn is served entirely from cache.
    const annotated: Tool = {
      ...TOOL,
      annotations: { readOnlyHint: true },
      _meta: { 'anthropic/maxResultSizeChars': 200_000 },
    } as Tool;
    const probe = memoryStore();
    const keyPool = new McpClientPool({ toolDescriptorStore: probe });
    await keyPool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    const connectionKey = keyPool.connectionKeyForDesired('alpha', 'L')!;

    const pool = new McpClientPool({
      toolDescriptorStore: memoryStore({ [toolDescriptorStoreKey(connectionKey)]: [annotated] }),
    });
    await pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });

    expect(pool.isConnected('alpha', 'L')).toBe(false);
    const definition = pool.getProxyToolDefs(['alpha'], 'L')[0]!;
    expect(definition.annotations).toEqual({ readOnlyHint: true });
    expect(definition._meta).toEqual({ 'anthropic/maxResultSizeChars': 200_000 });
  });

  it('prefers a live tool list over the cached record', async () => {
    const probe = memoryStore();
    const keyPool = new McpClientPool({ toolDescriptorStore: probe });
    await keyPool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    const connectionKey = keyPool.connectionKeyForDesired('alpha', 'L')!;

    const stale: Tool = { name: 'stale', description: 'old', inputSchema: {} } as Tool;
    const store = memoryStore({ [toolDescriptorStoreKey(connectionKey)]: [stale] });
    const pool = new McpClientPool({ toolDescriptorStore: store });
    await pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    // Simulate a completed connect for this identity.
    pool.primeConnectedToolsForTest(connectionKey, 'alpha', [TOOL]);

    expect(pool.getTools('alpha', 'L')).toEqual([TOOL]);
  });

  it('never serves a record written under a different connection identity', async () => {
    const store = memoryStore({ [JSON.stringify(['mcp', 'alpha', 'z'.repeat(64)])]: [TOOL] });
    const pool = new McpClientPool({ toolDescriptorStore: store });
    await pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    expect(pool.getTools('alpha', 'L')).toEqual([]);
  });

  it('does not change the tool catalog hash as a side effect of reading tools', async () => {
    const probe = memoryStore();
    const keyPool = new McpClientPool({ toolDescriptorStore: probe });
    await keyPool.sync({ alpha: CONFIG, beta: CONFIG }, {}, { leaserId: 'L' });
    const alphaKey = toolDescriptorStoreKey(keyPool.connectionKeyForDesired('alpha', 'L')!);
    const betaKey = toolDescriptorStoreKey(keyPool.connectionKeyForDesired('beta', 'L')!);

    // `beta`'s record only becomes readable AFTER sync's hydration pass, so a
    // `getTools` that hydrated lazily would populate `toolCache` / `proxyTools`
    // — the two structures `effectiveToolCatalogHash` reads — during a read.
    let betaVisible = false;
    const store: ToolDescriptorStore = {
      read: key => (key === alphaKey || (betaVisible && key === betaKey) ? [TOOL] : undefined),
      write: () => {},
    };
    const pool = new McpClientPool({ toolDescriptorStore: store });
    let toolsChangedEvents = 0;
    pool.subscribeToolsChanged(() => { toolsChangedEvents += 1; });
    await pool.sync({ alpha: CONFIG, beta: CONFIG }, {}, { leaserId: 'L' });
    betaVisible = true;
    const before = toolsChangedEvents;

    expect(pool.getTools('alpha', 'L')).toEqual([TOOL]);
    pool.getProxyToolDefs(['alpha', 'beta'], 'L');

    // Reads stay pure: the catalog cannot grow under a reader, and no
    // tools-changed listener fires.
    expect(pool.getTools('beta', 'L')).toEqual([]);
    expect(pool.getProxyToolDefs(['alpha', 'beta'], 'L').map(def => def.name)).toEqual(['mcp__alpha__echo']);
    expect(toolsChangedEvents).toBe(before);
  });
});

// F1.685 (origin WJ-crit-k P-WJcritk-3) — F1.665 (b) re-checks a cached record at hydration and does not serve a
// tool that fails the check, but the skip went only to the debug log: `/mcp` named nothing until a live connect's
// own listing landed. The pool keeps the hydration skips per connection and its status line falls back to them
// while no live client exists.
describe('F1.685 — a tool skipped while loading the descriptor cache shows in /mcp before a live connect', () => {
  const BAD = { name: 'broken', description: 'No schema' } as unknown as Tool;

  /**
   * The status is read in the window this row is about: `sync` hydrates from the store synchronously, before its
   * first await, and the connect it then starts has not settled — so the line is `pending` and no client exists.
   * (`CONFIG`'s spawn is refused a moment later and the line turns `failed` with the spawn error, which is why the
   * read happens before the sync is awaited.)
   */
  async function pendingLineAfterHydration(seed: Tool[]) {
    const keyPool = new McpClientPool({ toolDescriptorStore: memoryStore() });
    await keyPool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    const connectionKey = keyPool.connectionKeyForDesired('alpha', 'L')!;
    const pool = new McpClientPool({ toolDescriptorStore: memoryStore({ [toolDescriptorStoreKey(connectionKey)]: seed }) });
    const syncing = pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' });
    const connected = pool.isConnected('alpha', 'L');
    const tools = pool.getTools('alpha', 'L');
    const line = pool.serverStatuses('L').find(entry => entry.name === 'alpha');
    await syncing;
    await pool.disconnectAll();
    return { connected, tools, line };
  }

  it('the not-yet-connected server names the skipped tool and why', async () => {
    const { connected, tools, line } = await pendingLineAfterHydration([TOOL, BAD]);
    expect(connected).toBe(false); // the premise: no live client
    expect(tools).toEqual([TOOL]); // F1.665 (b): the bad one is not served
    expect(line?.state).toBe('pending');
    expect(line?.detail).toContain('1 tool skipped: "broken" (it does not have the MCP tool shape');
  });

  it('CONTROL: a clean cached record gives the same pending line with no detail', async () => {
    const { line } = await pendingLineAfterHydration([TOOL]);
    expect(line).toEqual({ name: 'alpha', state: 'pending', toolCount: null });
  });
});
