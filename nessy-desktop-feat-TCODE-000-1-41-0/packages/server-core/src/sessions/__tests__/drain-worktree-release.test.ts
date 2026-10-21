/**
 * P2.427 — the strict drain releases worktree leases on EVERY runtime.
 *
 * `strictDrainPiSessionOwned` has always released them; the non-Pi branch of
 * `strictDrainSessionForMutation` contained no worktree statement at all, so on
 * claude and codex the `git worktree remove` never ran. `cleanup()` drains every
 * loaded session through that branch, which made it fire on every application
 * quit. Measured 2026-08-30 against real git worktrees: three directories, one
 * per runtime, pi reclaimed and the other two surviving.
 *
 * The worktree is a HOST capability — `createSessionWorktreePort` is written
 * into the session-scoped callback registry whatever the provider is, and the
 * automation path creates one at session creation — so the per-runtime verdict
 * is the point of the table below, not an incidental parametrization.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function lease(worktreeLeaseId: string, workspaceId: string): PiWorktreeLeaseV1 {
  return {
    schemaVersion: 1,
    worktreeLeaseId,
    workspaceId,
    ownerAgentId: 'owner',
    path: `/nowhere/${worktreeLeaseId}`,
    branch: `nessy/owner/${worktreeLeaseId}`,
    baseSha: 'abc123',
    status: 'active',
    lastUsedAt: '2026-08-30T00:00:00.000Z',
  }
}

/**
 * A drainable session on one runtime, with a lease service whose `release` is
 * observable. Only the lease service is stubbed — the drain, the mutation
 * boundary and the residual assertions are the real ones.
 */
function fixture(options: {
  provider: 'pi' | 'claude' | 'codex'
  leases?: string[]
  /** Leave the lease listed after release, i.e. a refused removal. */
  refuseRelease?: boolean
}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-drain-worktree-'))
  roots.push(stateRoot)

  const manager = createTestSessionManager() as any
  manager.resolveManagedProvider = () => options.provider

  const workspace = {
    id: 'ws-drain-worktree',
    name: 'Drain Workspace',
    slug: 'drain-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id: 'session-1', workingDirectory: join(stateRoot, 'project') },
    workspace,
    { messagesLoaded: true, ephemeral: true },
  )
  const key = `${workspace.id}:${managed.id}`
  manager.sessions.set(key, managed)

  const listed = (options.leases ?? ['worktree-a']).map(id => lease(id, workspace.id))
  const released: string[] = []
  let built = 0
  const service = {
    list: () => listed.map(value => ({ ...value })),
    release: async (id: string) => {
      released.push(id)
      if (options.refuseRelease) return
      const index = listed.findIndex(value => value.worktreeLeaseId === id)
      if (index >= 0) listed.splice(index, 1)
    },
    recover: async () => [],
    sweepOrphans: async () => ({ dryRun: false, removed: [], skipped: [] }),
    setEmit: () => {},
  }
  manager.createPiWorktreeLeaseService = () => {
    built += 1
    manager.piWorktreeLeaseServices.set(key, service)
    return service
  }

  return {
    manager,
    managed,
    released,
    listed,
    service,
    key,
    buildCount: () => built,
    /** Persisted record with no live service — a session reopened from disk. */
    persistOnly: () => {
      manager.piWorktreeLeaseServices.delete(key)
      managed.worktreeLeaseState = { schemaVersion: 1, revision: 1, leases: listed.map(v => ({ ...v })) }
    },
    /** A live service, the way a session that entered a worktree this run has. */
    live: () => { manager.piWorktreeLeaseServices.set(key, service) },
  }
}

describe('the strict drain releases worktree leases on every runtime', () => {
  for (const provider of ['pi', 'claude', 'codex'] as const) {
    it(`releases the session's leases on ${provider}`, async () => {
      const rig = fixture({ provider })
      rig.live()

      await rig.manager.strictDrainSessionForMutation(rig.managed, 'test drain', false)

      expect(rig.released).toEqual(['worktree-a'])
      expect(rig.listed).toHaveLength(0)
    })
  }

  it('releases every lease, not just the first', async () => {
    const rig = fixture({ provider: 'claude', leases: ['worktree-a', 'worktree-b', 'worktree-c'] })
    rig.live()

    await rig.manager.strictDrainSessionForMutation(rig.managed, 'test drain', false)

    expect(rig.released).toEqual(['worktree-a', 'worktree-b', 'worktree-c'])
  })

  it('builds the service from the persisted record when the session has none', async () => {
    const rig = fixture({ provider: 'codex' })
    rig.persistOnly()

    await rig.manager.strictDrainSessionForMutation(rig.managed, 'test drain', false)

    expect(rig.buildCount()).toBe(1)
    expect(rig.released).toEqual(['worktree-a'])
  })

  it('builds nothing for a session that holds no leases', async () => {
    const rig = fixture({ provider: 'claude', leases: [] })
    rig.manager.piWorktreeLeaseServices.delete(rig.key)

    await rig.manager.strictDrainSessionForMutation(rig.managed, 'test drain', false)

    expect(rig.buildCount()).toBe(0)
    expect(rig.released).toEqual([])
  })

  it('fails the drain when a lease survives the release', async () => {
    const rig = fixture({ provider: 'claude', refuseRelease: true })
    rig.live()

    await expect(
      rig.manager.strictDrainSessionForMutation(rig.managed, 'test drain', false),
    ).rejects.toThrow('session-worktree-residual:worktree-a')
  })
})
