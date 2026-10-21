/**
 * P6.351 (denominator J43) — a dropped remote MCP server comes back on its own.
 *
 * `mcp.md` documents three retries; two were already built (first-connection via
 * `MCP_CONNECT_RETRY`, and the discovery request). This suite is the third, and
 * it also pins the PREMISE CORRECTION the row needed:
 *
 * The row's bounding clause read *"reconnect-on-demand at the next tool call
 * already exists, so the J43 loss is bounded to a stale tool list"*. It is
 * false. `handleUnexpectedConnectionClose` adds the connection to
 * `failedConnections`, and `callTool`'s cold-start branch is guarded by
 * `config && !this.failedConnections.has(connectionKey)` — the set whose own
 * docblock says it "governs on-demand reconnect". So the next tool call did NOT
 * bring the server back: it returned the not-connected soft error and the
 * server stayed down for the rest of the session unless a reconcile ran. The
 * last test here is that correction, asserted rather than described.
 */
import { describe, it, expect } from 'bun:test'
import { McpClientPool } from '../mcp-pool.ts'
import type { PoolClient } from '../client.ts'
import type { SdkMcpServerConfig } from '../../agent/backend/types.ts'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const mockTools: Tool[] = [
  { name: 'test-tool', description: 'A test tool', inputSchema: { type: 'object' as const, properties: {} } },
]

const httpConfig = (token: string): SdkMcpServerConfig => ({
  type: 'http',
  url: 'https://mcp.example.com',
  headers: { Authorization: `Bearer ${token}` },
})

/** Poll rather than sleep a fixed amount: the backoff is small but not zero. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return predicate()
}

/**
 * A pool whose `connect` records every attempt and can be told to fail.
 * `crash()` fires the SDK's unexpected-close bridge for the newest client,
 * which is exactly what `client.ts:553-556` does on a dropped transport.
 */
class DroppingPool extends McpClientPool {
  connects = 0
  failNext = false
  private crashers: Array<() => void> = []

  protected override async openConnection(): Promise<PoolClient> {
    this.connects += 1
    if (this.failNext) throw new Error('transport refused')
    let unexpectedClose: (() => void) | undefined
    // The base files the client, and filing is what installs the close handler,
    // so the crasher is captured through the closure rather than after a
    // `registerClient` call this fixture no longer makes.
    this.crashers.push(() => unexpectedClose?.())
    return {
      async listTools() { return mockTools },
      async callTool() { return { content: [{ type: 'text', text: 'ok' }] } },
      async close() {},
      setUnexpectedCloseHandler(handler: () => void) { unexpectedClose = handler },
    } as unknown as PoolClient
  }

  crash(): void { this.crashers[this.crashers.length - 1]?.() }
}

const RETRY = { attempts: 3, baseDelayMs: 5 }

describe('P6.351 · a mid-session drop reconnects without waiting for a tool call', () => {
  it('reconnects on its own, with no sync and no tool call in between', async () => {
    const pool = new DroppingPool({ retry: RETRY })
    await pool.sync({ remote: httpConfig('t') }, {}, { leaserId: 'A' })
    expect(pool.connects).toBe(1)
    expect(pool.isConnected('remote', 'A')).toBe(true)

    pool.crash()
    // The eviction is synchronous, so this is the state the old code stayed in.
    expect(pool.isConnected('remote', 'A')).toBe(false)

    // Nothing is called, nothing is synced — the pool comes back by itself.
    expect(await waitFor(() => pool.isConnected('remote', 'A'))).toBe(true)
    expect(pool.connects).toBe(2)
    expect(pool.health('A')).toEqual({ status: 'ready', connected: ['remote'], failed: [], failureReasons: {} })
  })

  it('clears the failed verdict, so the reconnected server is callable again', async () => {
    // The half that is easy to get wrong: a reconnect that leaves
    // `failedConnections` set succeeds and STILL refuses every tool call.
    const pool = new DroppingPool({ retry: RETRY })
    await pool.sync({ remote: httpConfig('t') }, {}, { leaserId: 'A' })
    pool.crash()
    expect(await waitFor(() => pool.isConnected('remote', 'A'))).toBe(true)

    const result = await pool.callTool('mcp__remote__test-tool', {}, undefined, { leaserId: 'A' })
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('ok')
  })

  it('spends ONE ladder, not two — the recovery does not multiply the retry budget', async () => {
    // This assertion is why the implementation has no attempt counter of its
    // own. The first shape of the fix carried one on top of `connectWithRetries`
    // and the two multiplied: `connects` came out at 10 for `{attempts: 3}`
    // — nine dials at a dead server — instead of 4. The ceiling below is the
    // whole point, so read it as a cap and not as a count of retries.
    const pool = new DroppingPool({ retry: RETRY })
    await pool.sync({ remote: httpConfig('t') }, {}, { leaserId: 'A' })
    pool.failNext = true
    pool.crash()

    // 1 successful initial connect + exactly one scheduled recovery, whose own
    // ladder is `attempts` dials.
    expect(await waitFor(() => pool.connects >= 1 + RETRY.attempts)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(pool.connects).toBe(1 + RETRY.attempts)
    expect(pool.isConnected('remote', 'A')).toBe(false)
  })

  it('does NOT reconnect a connection no leaser wants any more', async () => {
    // The control that separates "comes back" from "comes back regardless".
    const pool = new DroppingPool({ retry: RETRY })
    await pool.sync({ remote: httpConfig('t') }, {}, { leaserId: 'A' })
    await pool.sync({}, {}, { leaserId: 'A' })
    const afterDrop = pool.connects

    pool.crash()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(pool.connects).toBe(afterDrop)
    expect(pool.isConnected('remote', 'A')).toBe(false)
  })

  it('PREMISE CORRECTION: the next tool call never rescued a dropped server', async () => {
    // With every reconnect refused, the pool sits in exactly the state the old
    // code was PERMANENTLY in — and this is what a tool call got there. The
    // row's clause assumed this call reconnected.
    //
    // Measured, it is worse than the guard alone: without a descriptor store the
    // eviction also drops the proxy ROUTE, so the call fails as an unknown tool
    // before it can reach the cold-start branch at all. With a store the route
    // survives and `!this.failedConnections.has(connectionKey)` refuses it
    // there instead. Both roads end in the same place, which is why the
    // load-bearing assertions here are "it errored" and "it did not even try"
    // rather than a message this pool happens to produce.
    const pool = new DroppingPool({ retry: { attempts: 1, baseDelayMs: 0 } })
    await pool.sync({ remote: httpConfig('t') }, {}, { leaserId: 'A' })
    pool.failNext = true
    pool.crash()
    expect(await waitFor(() => pool.connects === 2)).toBe(true)

    const before = pool.connects
    const result = await pool.callTool('mcp__remote__test-tool', {}, undefined, { leaserId: 'A' })
    expect(result.isError).toBe(true)
    expect(pool.connects).toBe(before)
    expect(pool.isConnected('remote', 'A')).toBe(false)
  })
})
