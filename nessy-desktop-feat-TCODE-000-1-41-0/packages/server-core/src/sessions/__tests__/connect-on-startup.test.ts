/**
 * T10 (plugin-install plan § 9b, owner § 0b-4): plugin servers connect at
 * session start; intent-only stays reachable behind the policy switch.
 *
 * Policy ON (the Claude-parity default): creating a session warms the shared
 * workspace pool — the pool's sync (whose reconcile IS the connect pass) runs
 * before any send or tool call.
 *
 * Policy OFF (the bank posture): the registry is NEVER touched from session
 * start — not even a cold pool is created — which is the byte-identical
 * pre-T10 behaviour this gate exists to protect.
 *
 * Mutation probe (§ 9b): make `maybeConnectSourcesAtSessionStart` ignore the
 * resolved policy → the policy-off test goes red.
 *
 * P3.356. The policy-ON case did not EXECUTE its assertion between P3.246 and
 * this commit: `627c7af05` made `WorkspaceMcpPoolRegistry` subscribe to the
 * pool's connection verdicts AT POOL CREATION, and the duck below predates
 * that method, so `lease()` threw `pool.subscribeConnectionVerdictChanged is
 * not a function` before `sync` was ever reached. Production was never
 * affected (the real pool defines the method, and the registry gates the call
 * on the dep); what broke was the guard — and its red was pre-attributed in
 * the known-failing register, so a real regression of the default-ON
 * connect-at-session-start policy would have landed inside an expected
 * failure.
 *
 * Two consequences are built into the duck and the assertions below:
 *  - The duck carries BOTH methods the interface grew, not just the one on the
 *    reached path. `subscribeConnectionVerdictChanged` is the reached one
 *    (`getOrCreateEntry`); `notifyRootsChanged` is only reachable through the
 *    registry's own public `notifyRootsChanged()` fan-out, never from `lease`,
 *    and is here so the next method that arrives on this surface does not
 *    reproduce the same silent break one call deeper.
 *  - A re-anchor alone would restore a VISIBLE failure while leaving nothing
 *    able to tell a re-anchored pin from a dead one, so the policy-ON case now
 *    asserts the sync it observed was the SESSION-START one: exactly one pool
 *    created, for THIS session's workspace root, synced under the registry's
 *    own browse leaser id for that workspace key.
 */

import { createHash } from 'node:crypto'
import { describe, expect, mock, test } from 'bun:test'
import type { McpClientPool } from '@nessy-agent/shared/mcp'
import { createTestSessionManager } from './test-session-manager.ts'

type PoolFactoryOptions = { workspaceRootPath?: string; debug?: (msg: string) => void }

/**
 * The registry's own identity for the pool it leases on behalf of a workspace
 * (`workspace-mcp-pool-registry.ts`: `browse:${sha256(poolMapKey(key))}`, and
 * `poolMapKey` is the bare workspace id when there is no project key). Recomputed
 * here rather than imported because it is the thing under test: the assertion is
 * that the sync arrived through the registry for THIS workspace.
 */
function browseLeaserIdFor(workspaceId: string): string {
  return `browse:${createHash('sha256').update(workspaceId).digest('hex')}`
}

type SyncCall = {
  mcpServers: Record<string, unknown>
  apiServers: Record<string, unknown>
  options: { leaserId?: string }
}

function fakePoolFactory() {
  const syncCalls: SyncCall[] = []
  const factoryOptions: PoolFactoryOptions[] = []
  const sync = mock(async (
    mcpServers: Record<string, unknown> = {},
    apiServers: Record<string, unknown> = {},
    options: { leaserId?: string } = {},
  ) => {
    syncCalls.push({ mcpServers, apiServers, options })
    return [] as string[]
  })
  // Typed as a Pick rather than cast through `never`: the previous `as never`
  // type-checked nothing at all, so neither the missing methods nor a changed
  // signature could be seen. A Pick still cannot catch a method ADDED to the
  // interface — that is what the runtime shape below plus this file's own red
  // is for — but it does hold the seven we do implement to their real types.
  const pool: Pick<
    McpClientPool,
    'sync' | 'health' | 'hasLeaser' | 'dropLeaser' | 'disconnectAll'
    | 'subscribeConnectionVerdictChanged' | 'notifyRootsChanged'
  > = {
    sync: sync as unknown as McpClientPool['sync'],
    health: () => ({ status: 'unavailable', connected: [], failed: [] }),
    hasLeaser: () => false,
    dropLeaser: async () => [] as string[],
    disconnectAll: async () => {},
    // On the reached path: `getOrCreateEntry` subscribes at CREATION.
    subscribeConnectionVerdictChanged: () => () => {},
    // Not on the reached path — drift resistance only (see the file docblock).
    notifyRootsChanged: async () => {},
  }
  const create = mock((options: PoolFactoryOptions = {}) => {
    factoryOptions.push(options)
    return pool as unknown as McpClientPool
  })
  return { create, sync, syncCalls, factoryOptions }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('T10 — connect at session start', () => {
  test('policy ON (default): a fresh session connects its workspace servers before any send', async () => {
    const factory = fakePoolFactory()
    const manager = createTestSessionManager({
      createWorkspaceMcpPool: factory.create,
      resolveConnectSourcesOnStartup: () => true,
    })

    await manager.createSession('workspace-connect')

    // Fire-and-forget by design — the create returns immediately; the connect
    // pass (the pool sync's reconcile) lands right after.
    await waitFor(() => factory.sync.mock.calls.length > 0)
    expect(factory.sync).toHaveBeenCalledTimes(1)

    // ...and it was THIS session's connect pass, not an incidental sync: one
    // pool, created for this workspace's root, synced under the registry's
    // browse leaser id for this workspace key.
    expect(factory.create).toHaveBeenCalledTimes(1)
    expect(factory.factoryOptions[0]?.workspaceRootPath ?? '').toEndWith('workspace-connect')
    expect(factory.syncCalls[0]?.options.leaserId).toBe(browseLeaserIdFor('workspace-connect'))
  })

  test('policy OFF: byte-identical to intent-only — session start never touches the registry', async () => {
    const factory = fakePoolFactory()
    const manager = createTestSessionManager({
      createWorkspaceMcpPool: factory.create,
      resolveConnectSourcesOnStartup: () => false,
    })

    await manager.createSession('workspace-intent')
    await new Promise(resolve => setTimeout(resolve, 50))

    // Not even a COLD pool exists: the policy check returns before the
    // registry lease. This is the mutation probe's tripwire — code that
    // ignores the resolved policy creates the pool and syncs it.
    expect(factory.create).not.toHaveBeenCalled()
  })

  test('an ephemeral helper session never initiates outbound connects', async () => {
    const factory = fakePoolFactory()
    const manager = createTestSessionManager({
      createWorkspaceMcpPool: factory.create,
      resolveConnectSourcesOnStartup: () => true,
    })

    await manager.createSession('workspace-ephemeral', { ephemeral: true })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(factory.create).not.toHaveBeenCalled()
  })
})
