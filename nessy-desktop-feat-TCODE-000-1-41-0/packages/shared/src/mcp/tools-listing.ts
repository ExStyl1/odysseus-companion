/**
 * U3 MCP tools projection.
 *
 * Pure, fail-soft projection of an MCP source's tools from the EXISTING
 * McpClientPool cache into the safe wire result — no new pool, no connection.
 * Shared so the session engine (which owns the pool) and the handler tests both
 * use the identical contract.
 */

import type { SafeMcpToolsResult } from '../protocol/capabilities.ts';

/**
 * The minimal read surface of McpClientPool this projection touches — cache
 * reads only, never a connect. Structural so a fake pool satisfies it in tests.
 */
export interface McpToolsPoolReader {
  isConnected(slug: string, leaserId?: string): boolean;
  getTools(slug: string, leaserId?: string): Array<{ name: string; description?: string }>;
  /**
   * Per-leaser connection health. Optional so a pre-existing fake pool still
   * satisfies the reader; absent it, a not-connected source is reported as
   * merely `disconnected` exactly as before.
   */
  health?(leaserId?: string): { failed: readonly string[] };
}

/**
 * Project a source's tools into the safe result. Fail-soft:
 *   - a DISABLED source refuses WITHOUT any pool call (so no connection is
 *     attempted — the pool is never touched for an inactive source)
 *   - a source the pool recorded as FAILED is 'failed'
 *   - an active-but-not-connected source is 'disconnected'
 *   - a malformed / throwing pool reply maps to 'error'
 * `getTools` reads only the pool's cache; this never triggers `connect()`.
 *
 * `failed` is checked before `disconnected` and the two are deliberately
 * distinct. Since connect left the turn's critical path, "not connected" became
 * the normal resting state of a server nobody has called yet — the pool connects
 * it on demand. A server that hit the connect deadline will NOT be retried, so
 * presenting it with the same "Load tools" affordance a cold server gets would
 * just fail again and tell the user nothing.
 */
export function readMcpToolsFromPool(
  pool: McpToolsPoolReader,
  binding: { slug: string; active: boolean; leaserId?: string },
): SafeMcpToolsResult {
  if (!binding.active) return { status: 'refused', reason: 'disabled' };
  try {
    if (!pool.isConnected(binding.slug, binding.leaserId)) {
      const failed = pool.health?.(binding.leaserId)?.failed ?? [];
      return { status: 'refused', reason: failed.includes(binding.slug) ? 'failed' : 'disconnected' };
    }
    const raw = pool.getTools(binding.slug, binding.leaserId);
    if (!Array.isArray(raw)) return { status: 'refused', reason: 'error' };
    const tools = raw.map(tool => {
      if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
        throw new Error('malformed-tool');
      }
      return {
        name: tool.name,
        ...(typeof tool.description === 'string' && tool.description.length > 0
          ? { description: tool.description }
          : {}),
      };
    });
    return { status: 'ok', tools };
  } catch {
    return { status: 'refused', reason: 'error' };
  }
}
