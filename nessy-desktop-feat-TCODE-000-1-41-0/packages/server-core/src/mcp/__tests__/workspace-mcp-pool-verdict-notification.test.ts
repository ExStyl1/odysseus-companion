/**
 * P3.246 — the DELIVERY half of the pool's connection-verdict notification.
 *
 * `McpClientPool` now announces when `authNeededSlugs()`/`health().failed`
 * moved (pinned in `shared/src/mcp/__tests__/mcp-pool-connection-verdict`), but
 * an announcement nobody carries is the same silence it replaced. The chain is
 * pool → registry → `SessionManager` → `capabilities.CHANGED` → the notice's
 * `subscribePendingAuthRefresh` refetch. This file pins the registry link, and
 * the SessionManager link structurally — the renderer link already has its own
 * test (`PendingAuthNotice.test.tsx`).
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpClientPool } from '@nessy-agent/shared/mcp'
import type { CapabilityResolver } from '@nessy-agent/shared/capabilities/resolver'
import type { DpSessionBroker } from '@nessy-agent/shared/auth/dp'
import { WorkspaceMcpPoolRegistry } from '../workspace-mcp-pool-registry'

/**
 * The narrowest pool the registry needs to create an entry: a lease alone
 * builds one, so no resolve or materialization is involved here.
 */
function makeFakePool() {
  const listeners = new Set<() => void>()
  const pool = {
    subscribeConnectionVerdictChanged(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async disconnectAll() {},
  }
  return {
    pool: pool as unknown as McpClientPool,
    /** Stand in for a 401 landing on a connection this pool holds. */
    announce: () => { for (const listener of [...listeners]) listener() },
    get subscriberCount() { return listeners.size },
  }
}

const resolver = {
  resolve: async () => { throw new Error('not used') },
  releaseSnapshot: () => {},
  invalidate: () => {},
  isLeaseActive: () => true,
  referencedInstances: () => new Set(),
  leaseCount: () => 0,
} as unknown as CapabilityResolver

const dpSessionBroker = {
  probe: async () => ({ state: 'ready' as const }),
  subscribe: () => () => {},
} as unknown as Pick<DpSessionBroker, 'probe' | 'subscribe'>

function makeRegistry(fake: ReturnType<typeof makeFakePool>, notified: string[]) {
  return new WorkspaceMcpPoolRegistry({
    resolver,
    resolveCredential: () => ({ ready: false, revision: 0 }),
    resolveWorkspaceRootPath: () => undefined,
    createPool: () => fake.pool,
    dpSessionBroker,
    onConnectionVerdictChanged: workspaceId => { notified.push(workspaceId) },
  })
}

describe('the registry carries a pool verdict change out to its workspace', () => {
  it('subscribes at pool CREATION, so a verdict that never reconciles is still carried', async () => {
    // A 401 on a tool call and a transport that dropped both move the verdict
    // without any reconcile running; a subscription installed at first sync
    // would miss exactly those.
    const fake = makeFakePool()
    const notified: string[] = []
    const registry = makeRegistry(fake, notified)

    registry.lease({ workspaceId: 'ws-1' })
    expect(fake.subscriberCount).toBe(1)

    fake.announce()

    expect(notified).toEqual(['ws-1'])
    await registry.dispose()
  })

  it('releases the subscription on dispose', async () => {
    const fake = makeFakePool()
    const notified: string[] = []
    const registry = makeRegistry(fake, notified)
    registry.lease({ workspaceId: 'ws-1' })

    await registry.dispose()
    fake.announce()

    expect(notified).toEqual([])
  })

  it('does not subscribe when no consumer was wired', async () => {
    // The dep is optional, and a registry without it must not hold a listener
    // on every pool for nobody.
    const fake = makeFakePool()
    const registry = new WorkspaceMcpPoolRegistry({
      resolver,
      resolveCredential: () => ({ ready: false, revision: 0 }),
      resolveWorkspaceRootPath: () => undefined,
      createPool: () => fake.pool,
      dpSessionBroker,
    })

    registry.lease({ workspaceId: 'ws-1' })

    expect(fake.subscriberCount).toBe(0)
    await registry.dispose()
  })
})

describe('the SessionManager link', () => {
  /**
   * A source-text pin, the pattern this repo already uses for a wiring whose
   * only alternative is standing up a whole SessionManager
   * (`PendingAuthNotice.test.tsx` pins its subscription the same way). Deleting
   * either half restores the exact silence P3.246 closed, and neither half has
   * a behavioural test that would notice.
   */
  const source = readFileSync(join(import.meta.dir, '..', '..', 'sessions', 'SessionManager.ts'), 'utf8')

  it('hands the registry a consumer for the verdict change', () => {
    expect(source).toContain('onConnectionVerdictChanged: workspaceId => this.broadcastMcpConnectionVerdictChanged(workspaceId)')
  })

  it('broadcasts it on the channel the pending-auth notice already listens to', () => {
    const broadcast = source.slice(source.indexOf('private broadcastMcpConnectionVerdictChanged('))
    expect(broadcast.slice(0, 600)).toContain('RPC_CHANNELS.capabilities.CHANGED')
    expect(broadcast.slice(0, 600)).toContain("reasonCode: 'mcp-connection-verdict-changed'")
    // The weaker of the two effects: this revokes no snapshot and aborts no
    // session, it only asks the workspace to look again.
    expect(broadcast.slice(0, 600)).toContain("effect: 'refresh-before-next-turn'")
  })
})
