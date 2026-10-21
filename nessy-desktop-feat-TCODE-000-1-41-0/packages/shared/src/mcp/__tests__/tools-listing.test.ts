import { describe, expect, it } from 'bun:test';
import { readMcpToolsFromPool, type McpToolsPoolReader } from '../tools-listing.ts';

/** Fake pool recording connect-relevant reads so we can assert no connection. */
class FakePool implements McpToolsPoolReader {
  isConnectedCalls = 0;
  getToolsCalls = 0;
  constructor(
    private readonly connected: Set<string>,
    private readonly tools: Record<string, Array<{ name: string; description?: string }>>,
  ) {}
  isConnected(slug: string): boolean {
    this.isConnectedCalls++;
    return this.connected.has(slug);
  }
  getTools(slug: string) {
    this.getToolsCalls++;
    return this.tools[slug] ?? [];
  }
}

describe('readMcpToolsFromPool (U3)', () => {
  it('returns name + description for a connected, active source', () => {
    const pool = new FakePool(new Set(['gh']), {
      gh: [
        { name: 'search_code', description: 'Search code' },
        { name: 'list_repos' }, // no description → omitted
      ],
    });
    const result = readMcpToolsFromPool(pool, { slug: 'gh', active: true });
    expect(result).toEqual({
      status: 'ok',
      tools: [{ name: 'search_code', description: 'Search code' }, { name: 'list_repos' }],
    });
  });

  it('refuses a DISABLED source WITHOUT touching the pool (no connection attempt)', () => {
    const pool = new FakePool(new Set(['gh']), { gh: [{ name: 't' }] });
    const result = readMcpToolsFromPool(pool, { slug: 'gh', active: false });
    expect(result).toEqual({ status: 'refused', reason: 'disabled' });
    // Neither the connection check nor the tools read ran → no connect could fire.
    expect(pool.isConnectedCalls).toBe(0);
    expect(pool.getToolsCalls).toBe(0);
  });

  it('refuses an active-but-not-connected source as disconnected (no getTools)', () => {
    const pool = new FakePool(new Set(), { gh: [{ name: 't' }] });
    const result = readMcpToolsFromPool(pool, { slug: 'gh', active: true });
    expect(result).toEqual({ status: 'refused', reason: 'disconnected' });
    expect(pool.getToolsCalls).toBe(0);
  });

  it('maps a malformed pool reply (missing tool name) to a typed error', () => {
    const pool = new FakePool(new Set(['gh']), {
      gh: [{ name: '' } as { name: string }],
    });
    const result = readMcpToolsFromPool(pool, { slug: 'gh', active: true });
    expect(result).toEqual({ status: 'refused', reason: 'error' });
  });

  it('maps a throwing pool to a typed error', () => {
    const pool: McpToolsPoolReader = {
      isConnected: () => true,
      getTools: () => { throw new Error('boom'); },
    };
    expect(readMcpToolsFromPool(pool, { slug: 'gh', active: true })).toEqual({
      status: 'refused',
      reason: 'error',
    });
  });

  it('returns an empty tools list (no error) for a connected source with zero tools', () => {
    const pool = new FakePool(new Set(['gh']), { gh: [] });
    expect(readMcpToolsFromPool(pool, { slug: 'gh', active: true })).toEqual({
      status: 'ok',
      tools: [],
    });
  });

  /**
   * Since connect left the turn's critical path, "not connected" is the normal
   * resting state for a server nobody has called yet — the pool connects it on
   * demand. A server that actually FAILED to connect is a different thing: it hit
   * the connect deadline and will not be retried, so it must not present the same
   * "Load tools" affordance a cold server does.
   */
  it('distinguishes a server that failed to connect from one merely not connected', () => {
    const failing: McpToolsPoolReader = {
      isConnected: () => false,
      getTools: () => [],
      health: () => ({ status: 'degraded', connected: [], failed: ['gh'] }),
    };
    expect(readMcpToolsFromPool(failing, { slug: 'gh', active: true })).toEqual({
      status: 'refused',
      reason: 'failed',
    });

    const cold: McpToolsPoolReader = {
      isConnected: () => false,
      getTools: () => [],
      health: () => ({ status: 'ready', connected: ['other'], failed: [] }),
    };
    expect(readMcpToolsFromPool(cold, { slug: 'gh', active: true })).toEqual({
      status: 'refused',
      reason: 'disconnected',
    });
  });

  it('reports a connected source as ok even while another server is failed', () => {
    const pool: McpToolsPoolReader = {
      isConnected: slug => slug === 'gh',
      getTools: () => [{ name: 'search_code' }],
      health: () => ({ status: 'degraded', connected: ['gh'], failed: ['other'] }),
    };
    expect(readMcpToolsFromPool(pool, { slug: 'gh', active: true })).toEqual({
      status: 'ok',
      tools: [{ name: 'search_code' }],
    });
  });

  it('falls back to disconnected when the pool exposes no health surface', () => {
    const pool = new FakePool(new Set(), { gh: [{ name: 't' }] });
    expect(readMcpToolsFromPool(pool, { slug: 'gh', active: true })).toEqual({
      status: 'refused',
      reason: 'disconnected',
    });
  });
});
