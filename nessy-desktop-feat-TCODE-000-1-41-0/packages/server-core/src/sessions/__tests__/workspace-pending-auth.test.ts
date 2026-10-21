/**
 * T4 (plugin-install plan § 5): `SessionManager.getWorkspacePendingAuth` runs
 * a workspace-scope resolve through the SAME materialization authority the
 * pools use, WITHOUT connecting anything, and fails soft.
 *
 * The truth-shaping itself is pinned by `pending-auth-summary.test.ts`; this
 * file pins the manager seam: the empty positive control, the fail-soft
 * resolve, and — critically — that fetching the notice is NOT connect-intent
 * (no pool sync happens).
 */

import { describe, expect, mock, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

describe('SessionManager.getWorkspacePendingAuth', () => {
  test('positive control: an empty workspace yields an empty summary and never syncs the pool', async () => {
    const sync = mock(async () => [] as string[])
    const manager = createTestSessionManager({
      createWorkspaceMcpPool: () => ({
        sync,
        health: () => ({ status: 'unavailable', connected: [], failed: [] }),
        authNeededSlugs: () => [],
        hasLeaser: () => false,
        dropLeaser: async () => [] as string[],
        disconnectAll: async () => {},
      }) as never,
    })

    const summary = await manager.getWorkspacePendingAuth('workspace-pending')

    expect(summary).toEqual({ sources: [], failedServers: [] })
    // Reading the notice must never be connect-intent (T10 owns connecting).
    expect(sync).not.toHaveBeenCalled()
  })

  test('fails soft: a resolver error yields an empty summary, not a thrown banner', async () => {
    const manager = createTestSessionManager({
      resolver: {
        resolve: async () => { throw new Error('resolver-down') },
        releaseSnapshot() {},
        invalidate: () => undefined,
        isLeaseActive: () => false,
        referencedInstances: () => new Set(),
        leaseCount: () => 0,
      },
    })

    await expect(manager.getWorkspacePendingAuth('workspace-pending'))
      .resolves.toEqual({ sources: [], failedServers: [] })
  })
})
