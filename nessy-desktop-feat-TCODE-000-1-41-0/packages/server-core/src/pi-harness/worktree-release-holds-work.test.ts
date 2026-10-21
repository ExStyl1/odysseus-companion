/**
 * P6.22 — `release(id, { refuseIfHoldsWork: true })`.
 *
 * The age sweep has always applied two refusals — changed or untracked files,
 * and commits that exist nowhere else — but only the FIRST of them lives on the
 * release path. `assertProvenance` deliberately ALLOWS a moved HEAD
 * (`baseShaIsAncestor`), because a caller naming one worktree has said which
 * one, and the drain relies on that.
 *
 * `ExitWorktree({ remove: true })` is the caller that needs the stricter rule:
 * the user is leaving, not deleting, and losing commits on the way out is not
 * something to infer from a cwd change. The option is therefore opt-in, and
 * these tests pin BOTH directions — that it refuses when asked, and that the
 * default is unchanged for the drain and the sweep.
 */
import { describe, expect, it } from 'bun:test'
import type { PiWorktreeLeaseStateV1, PiWorktreeLeaseV1 } from '@nessy-agent/shared/sessions/types'
import { WorktreeLeaseError, WorktreeLeaseService } from './worktree-lease-service.ts'

function lease(): PiWorktreeLeaseV1 {
  return {
    schemaVersion: 1,
    worktreeLeaseId: 'wt',
    workspaceId: 'w1',
    ownerAgentId: 'agent',
    path: '/repo/.nessy-worktrees/proj/wt',
    branch: 'nessy/agent/wt',
    baseSha: 'base-sha',
    status: 'active',
    lastUsedAt: '2026-08-30T00:00:00.000Z',
  }
}

function build(git: { dirty?: boolean; head?: string } = {}) {
  const removed: string[] = []
  const initialState: PiWorktreeLeaseStateV1 = { schemaVersion: 1, revision: 1, leases: [lease()] }
  const service = new WorktreeLeaseService({
    workspaceId: 'w1',
    initialState,
    persist: async () => {},
    policy: { select: async () => ({ path: '/x', branch: 'b', baseSha: 'base-sha' }) },
    git: {
      create: async () => {},
      inspect: async value => ({
        exists: true,
        dirty: git.dirty ?? false,
        branch: value.branch,
        baseSha: git.head ?? value.baseSha,
        // A head that moved FORWARD from the base is an ancestor relationship,
        // which is what makes it legal provenance and therefore removable by
        // default — the exact case this option exists to catch.
        baseShaIsAncestor: true,
      }),
      remove: async value => { removed.push(value.worktreeLeaseId) },
    },
  })
  return { service, removed }
}

async function residualOf(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation
    return undefined
  } catch (error) {
    return error instanceof WorktreeLeaseError ? error.residuals[0]?.code : `unexpected:${String(error)}`
  }
}

describe('releasing a worktree that still holds work', () => {
  it('removes a clean worktree with the option on', async () => {
    const { service, removed } = build()

    await service.release('wt', { refuseIfHoldsWork: true })

    expect(removed).toEqual(['wt'])
    expect(service.list()).toEqual([])
  })

  it('refuses when the worktree holds commits that exist nowhere else', async () => {
    const { service, removed } = build({ head: 'moved-past-base' })

    expect(await residualOf(service.release('wt', { refuseIfHoldsWork: true })))
      .toBe('worktree-holds-commits')
    // Nothing was removed and the lease still stands, so the work survives.
    expect(removed).toEqual([])
    expect(service.list()).toHaveLength(1)
  })

  it('still removes those commits without the option — the drain and the sweep are unchanged', async () => {
    // The default is the byte-identical old behaviour on purpose: the sweep
    // applies the same condition EARLIER, as `reason: "holds-commits"`, and the
    // drain's caller named this specific worktree.
    const { service, removed } = build({ head: 'moved-past-base' })

    await service.release('wt')

    expect(removed).toEqual(['wt'])
  })

  it('refuses uncommitted changes in both directions', async () => {
    const strict = build({ dirty: true })
    const lenient = build({ dirty: true })

    expect(await residualOf(strict.service.release('wt', { refuseIfHoldsWork: true })))
      .toBe('worktree-dirty')
    expect(await residualOf(lenient.service.release('wt'))).toBe('worktree-dirty')
    expect(strict.removed).toEqual([])
    expect(lenient.removed).toEqual([])
  })
})
