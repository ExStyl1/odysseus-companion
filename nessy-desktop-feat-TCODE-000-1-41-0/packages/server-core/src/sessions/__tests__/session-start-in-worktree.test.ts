/**
 * P6.20 — a session can START isolated in a git worktree.
 *
 * Before this, a worktree could only be ENTERED mid-session: the only caller
 * that isolated at creation was the scheduled-task path, and nothing exposed
 * that for a session a person starts. `CreateSessionOptions.worktree` reaches
 * the same host port at the same point in the lifecycle.
 *
 * The mechanism is the HOST one on all three runtimes — `createSession` reads no
 * provider on this path — so these tests drive the real
 * `createSessionWorktreePort` and the real `mutateWorkingDirectory`
 * transaction; only the lease service's git side is stubbed.
 *
 * Claude's binary has a native `-w, --worktree [name]` (shipped 2.1.223) that
 * is deliberately not preferred here: a worktree the binary creates for itself
 * has a path the host never learns, so it gets no lease and no reclamation —
 * P2.427's defect, on the runtime where it was worst.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { failWith?: string } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-start-worktree-'))
  roots.push(stateRoot)
  const manager = createTestSessionManager() as any

  const acquired: Array<{ ownerAgentId: string; worktreeLeaseId?: string }> = []
  const leases: PiWorktreeLeaseV1[] = []
  manager.createPiWorktreeLeaseService = () => ({
    list: () => leases.map(value => ({ ...value })),
    touch: async () => {},
    release: async () => {},
    sweepOrphans: async ({ dryRun }: { dryRun?: boolean }) => ({
      dryRun: dryRun === true, removed: [], skipped: [],
    }),
    acquire: async (input: { ownerAgentId: string; worktreeLeaseId?: string }) => {
      acquired.push(input)
      if (options.failWith) throw new Error(options.failWith)
      const path = join(stateRoot, 'worktrees', input.worktreeLeaseId ?? 'lease')
      mkdirSync(path, { recursive: true })
      const value: PiWorktreeLeaseV1 = {
        schemaVersion: 1,
        worktreeLeaseId: input.worktreeLeaseId ?? 'lease',
        workspaceId: 'ws',
        ownerAgentId: input.ownerAgentId,
        path,
        branch: `nessy/${input.ownerAgentId}/lease`,
        baseSha: 'abc123',
        status: 'active',
        lastUsedAt: '2026-08-30T00:00:00.000Z',
      }
      leases.push(value)
      return { ...value }
    },
  })
  manager.registerPiWorktreeLease = async (
    _managed: unknown,
    _service: unknown,
    _lease: unknown,
    create: () => Promise<PiWorktreeLeaseV1>,
  ) => create()

  return { manager, acquired, stateRoot }
}

describe('a session can start already isolated in a worktree', () => {
  it('moves the new session into a worktree before the create returns', async () => {
    const { manager, acquired } = fixture()

    const session = await manager.createSession('ws-start-worktree', { worktree: true })

    expect(acquired).toHaveLength(1)
    // The lease id — and so the directory — is derived per session, the same
    // rule the scheduled-task path uses to keep run #2 off run #1's directory.
    expect(acquired[0]?.ownerAgentId).toBe(`session-${session.id}`)
    const managed = (manager as any).getManaged(session.id, session.workspaceId)
    expect(managed.workingDirectory).toContain(join('worktrees', `worktree-session-${session.id}`))
  })

  it('names the worktree when the request names it', async () => {
    const { manager, acquired } = fixture()

    await manager.createSession('ws-start-worktree', { worktree: 'review-pass' })

    expect(acquired[0]?.ownerAgentId).toBe('review-pass')
  })

  it('starts in the live checkout when nothing asked for isolation', async () => {
    const { manager, acquired } = fixture()

    await manager.createSession('ws-start-worktree')

    expect(acquired).toHaveLength(0)
  })

  it('refuses rather than falling back to the live checkout, and leaves no session behind', async () => {
    const { manager } = fixture({ failWith: 'worktree-project-required' })

    await expect(
      manager.createSession('ws-start-worktree', { worktree: true }),
    ).rejects.toThrow('session-worktree-failed: worktree-project-required')

    // A session that asked for isolation and got the live checkout is the one
    // outcome the request ruled out — so there is no half-made session either.
    expect([...(manager as any).sessions.keys()]).toEqual([])
  })
})
