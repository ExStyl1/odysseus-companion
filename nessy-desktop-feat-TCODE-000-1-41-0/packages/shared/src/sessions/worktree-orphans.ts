/**
 * Which worktree leases the retention cutoff may remove.
 *
 * `settings.md`: "The same age cutoff applies to automatic removal of orphaned
 * worktrees at startup." `worktrees.md` scopes it: "A periodic sweep removes
 * worktrees that Claude created for subagents and background sessions once they
 * are older than your `cleanupPeriodDays` setting. The sweep skips a worktree
 * that still holds work: changed or untracked files, or unpushed commits. It
 * never removes worktrees you create with `--worktree`."
 *
 * Two of those scopes hold by construction here and one does not:
 *
 * - "never removes worktrees you create with `--worktree`" — `WorktreeLeaseService`
 *   is the only writer of leases, and this planner walks leases only, so a
 *   user-made worktree in the namespace is never a candidate.
 * - "skips a worktree that still holds work" — needs git state, so it is applied
 *   by the caller after this plan, not here.
 * - the age cutoff — here.
 *
 * ## Absent `lastUsedAt` means UNKNOWN, and never epoch
 *
 * R2 added the field stamped going forward. Every lease persisted before that
 * has none, so reading absent as "infinitely old" would delete every worktree
 * that existed before the field did. Absent is a skip, not a removal.
 */

import type { PiWorktreeLeaseV1 } from './types.ts'

export type WorktreeOrphanSkipReason =
  /** A session currently holds this lease. */
  | 'live-lease'
  /** No `lastUsedAt`, or one that will not parse. Age is unknown, so it stays. */
  | 'unknown-last-used'
  /** Used more recently than the cutoff. */
  | 'recently-used'

export interface WorktreeOrphanCandidate {
  readonly worktreeLeaseId: string
  readonly path: string
  readonly lastUsedAt: string
}

export interface WorktreeOrphanSkip {
  readonly worktreeLeaseId: string
  readonly path: string
  readonly reason: WorktreeOrphanSkipReason
}

export interface WorktreeOrphanPlan {
  readonly candidates: readonly WorktreeOrphanCandidate[]
  readonly skipped: readonly WorktreeOrphanSkip[]
}

export function planWorktreeOrphanSweep(input: {
  readonly leases: readonly PiWorktreeLeaseV1[]
  /** Leases a session currently holds. REQUIRED: defaulting this to empty would delete live worktrees. */
  readonly liveLeaseIds: readonly string[]
  /** Epoch ms; a lease last used strictly before this is a candidate. */
  readonly cutoffMs: number
}): WorktreeOrphanPlan {
  const live = new Set(input.liveLeaseIds)
  const candidates: WorktreeOrphanCandidate[] = []
  const skipped: WorktreeOrphanSkip[] = []

  for (const lease of input.leases) {
    const identity = { worktreeLeaseId: lease.worktreeLeaseId, path: lease.path }
    if (live.has(lease.worktreeLeaseId)) {
      skipped.push({ ...identity, reason: 'live-lease' })
      continue
    }
    const lastUsedAt = lease.lastUsedAt === undefined ? Number.NaN : Date.parse(lease.lastUsedAt)
    if (!Number.isFinite(lastUsedAt)) {
      skipped.push({ ...identity, reason: 'unknown-last-used' })
      continue
    }
    if (lastUsedAt >= input.cutoffMs) {
      skipped.push({ ...identity, reason: 'recently-used' })
      continue
    }
    candidates.push({ ...identity, lastUsedAt: lease.lastUsedAt! })
  }

  return { candidates, skipped }
}
