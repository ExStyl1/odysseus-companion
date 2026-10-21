/**
 * C3.129 — the five documented states of `worktrees.md#reuse-a-worktree-name`,
 * plus the control.
 *
 * Anchor verified on the RENDERED page 2026-09-12. The section's own words, in
 * the order this suite asserts them:
 *
 *  - *"Passing `--worktree` a name whose directory already exists opens that
 *    existing worktree instead of creating a new one."*
 *  - *"With the default `"fresh"` base, a reopened worktree resets to the
 *    repository's default branch instead of continuing at its old tip when all
 *    of the following hold"* — no uncommitted changes or untracked files; still
 *    on the branch Claude Code created for it; no commits of its own, or its
 *    merge request was merged and its remote branch deleted.
 *  - *"Claude Code detects the merged case from git state alone: the remote
 *    branch the worktree pushed to no longer exists, and every commit in the
 *    worktree is already on the default branch."*
 *  - *"In every other case, Claude Code reopens the worktree at its old tip"* —
 *    the worktree fails any of the conditions; Claude Code can't verify its
 *    state; `worktree.baseRef` is `"head"`; the name is a pull request or merge
 *    request reference.
 *
 * Table-driven for the same reason the function is a table: the page states the
 * five as one set, and a chain of separate cases would let a row be deleted
 * without anything going red.
 */
import { describe, expect, test } from 'bun:test'
import {
  parseWorktreeRemoteBranchPresent,
  worktreeReopenProbeCommands,
  worktreeReopenResetCommands,
  worktreeReopenResetDecision,
  type WorktreeReopenResetDecision,
  type WorktreeReopenResetInput,
  type WorktreeReopenState,
} from './worktree-git-plan.ts'

const BRANCH = 'nessy/agent-a/worktree-bold-oak'
const PATH = '/repo/.nessy/worktrees/worktree-bold-oak'

/** A worktree that meets all three conditions: clean, on our branch, merged away. */
function clean(overrides: Partial<WorktreeReopenState> = {}): WorktreeReopenState {
  return {
    exists: true,
    dirty: false,
    branch: BRANCH,
    remoteBranchExists: false,
    headIsAncestorOfDefault: true,
    ...overrides,
  }
}

function decide(overrides: Partial<WorktreeReopenResetInput> = {}) {
  return worktreeReopenResetDecision({
    baseRef: 'fresh',
    name: 'bold-oak-a3f2',
    branch: BRANCH,
    state: clean(),
    ...overrides,
  })
}

describe('C3.129 — the five documented reopen states, and the control', () => {
  // Typed by the module's own union rather than by `string`: a row naming a
  // reason the function cannot answer must not compile.
  const table: Array<{
    documented: string
    input: Partial<WorktreeReopenResetInput>
  } & WorktreeReopenResetDecision> = [
    {
      documented: 'CONTROL — a name with no existing worktree directory creates fresh',
      input: { state: undefined },
      action: 'create',
      reason: 'no-existing-worktree',
    },
    {
      documented: 'the three conditions hold, with the default "fresh" base',
      input: {},
      action: 'reset',
      reason: 'conditions-met',
    },
    {
      documented: '`worktree.baseRef` is "head"',
      input: { baseRef: 'head' },
      action: 'reopen',
      reason: 'base-ref-head',
    },
    {
      documented: 'the name is a merge request reference',
      input: { name: 'https://gitlab.example.com/group/app/-/merge_requests/12' },
      action: 'reopen',
      reason: 'merge-request-name',
    },
    {
      documented: 'the name is a pull request reference',
      input: { name: 'https://github.com/org/app/pull/7' },
      action: 'reopen',
      reason: 'merge-request-name',
    },
    {
      documented: 'it has uncommitted changes or untracked files',
      input: { state: clean({ dirty: true }) },
      action: 'reopen',
      reason: 'dirty',
    },
    {
      documented: 'it is no longer on the branch Claude Code created for it',
      input: { state: clean({ branch: 'main' }) },
      action: 'reopen',
      reason: 'branch-moved',
    },
    {
      documented: 'a detached HEAD is never the branch we created',
      input: { state: clean({ branch: '' }) },
      action: 'reopen',
      reason: 'branch-moved',
    },
    {
      documented: 'it holds commits of its own and they are not the merged case',
      input: {
        state: clean({ remoteBranchExists: true, headIsAncestorOfDefault: false }),
      },
      action: 'reopen',
      reason: 'holds-commits',
    },
    {
      documented: "Claude Code can't verify the worktree's state",
      input: { state: clean({ headIsAncestorOfDefault: undefined }) },
      action: 'reopen',
      reason: 'unverifiable',
    },
  ]

  for (const row of table) {
    test(row.documented, () => {
      expect(decide(row.input)).toEqual({ action: row.action, reason: row.reason })
    })
  }

  test('every documented state is covered, and each reason is reachable exactly once per row', () => {
    // The table is the contract, so a row silently deleted has to be visible.
    // Ten rows over eight reasons: `merge-request-name` and `branch-moved` each
    // carry two.
    expect(table).toHaveLength(10)
    expect(new Set(table.map(row => row.reason)).size).toBe(8)
  })
})

describe('C3.129 — the merged case needs BOTH halves of the page\'s sentence', () => {
  // "the remote branch ... no longer exists, AND every commit in the worktree is
  // already on the default branch". Each half alone must NOT reset: a live
  // remote branch means the work is still someone's, and commits missing from
  // the default branch are work that exists nowhere else.
  test('a deleted remote branch alone is not enough', () => {
    expect(decide({
      state: clean({ remoteBranchExists: false, headIsAncestorOfDefault: false }),
    })).toEqual({ action: 'reopen', reason: 'holds-commits' })
  })

  test('commits already on the default branch alone is not enough', () => {
    expect(decide({
      state: clean({ remoteBranchExists: true, headIsAncestorOfDefault: true }),
    })).toEqual({ action: 'reopen', reason: 'holds-commits' })
  })

  test('an unreadable probe resolves to reopen, never to reset', () => {
    // The direction that cannot destroy work. A stale remote-tracking ref reads
    // as "the branch still exists" for the same reason.
    for (const unreadable of [
      { remoteBranchExists: undefined },
      { headIsAncestorOfDefault: undefined },
      { remoteBranchExists: undefined, headIsAncestorOfDefault: undefined },
    ]) {
      expect(decide({ state: clean(unreadable) }))
        .toEqual({ action: 'reopen', reason: 'unverifiable' })
    }
  })
})

describe('C3.129 — the two probes and the reset command', () => {
  test('both probes are local, allowFailure, and run in the worktree', () => {
    const [remote, merged] = worktreeReopenProbeCommands(PATH, BRANCH)
    expect(remote).toEqual({
      operation: 'reopen-remote-branch',
      cwd: 'worktree',
      args: ['-C', PATH, 'branch', '--remotes', '--list', `origin/${BRANCH}`],
      allowFailure: true,
    })
    expect(merged).toEqual({
      operation: 'reopen-head-merged',
      cwd: 'worktree',
      args: ['-C', PATH, 'merge-base', '--is-ancestor', 'HEAD', 'origin/HEAD'],
      allowFailure: true,
    })
    // NEGATIVE: neither may reach the network. `ls-remote` and `fetch` are the
    // two that would, and a session open must not wait on a forge.
    const argv = JSON.stringify([remote, merged])
    expect(argv).not.toContain('ls-remote')
    expect(argv).not.toContain('fetch')
  })

  test('the ancestor probe asks about the DEFAULT branch, not the lease base', () => {
    // This is what makes it a different question from the `merge-base
    // --is-ancestor <lease base> HEAD` the `inspect` probe already runs.
    const merged = worktreeReopenProbeCommands(PATH, BRANCH)[1]!
    expect(merged.args.slice(-2)).toEqual(['HEAD', 'origin/HEAD'])
  })

  test('the remote-branch reading is emptiness, not the exit code', () => {
    expect(parseWorktreeRemoteBranchPresent('  origin/feature\n')).toBe(true)
    expect(parseWorktreeRemoteBranchPresent('')).toBe(false)
    expect(parseWorktreeRemoteBranchPresent('\n   \n')).toBe(false)
  })

  test('the reset is one atomic checkout -B onto the resolved default sha', () => {
    const commands = worktreeReopenResetCommands(PATH, BRANCH, 'a'.repeat(40))
    expect(commands).toEqual([{
      operation: 'reopen-reset',
      cwd: 'worktree',
      args: ['-C', PATH, 'checkout', '-B', BRANCH, 'a'.repeat(40)],
    }])
    // NEGATIVE: never `--force`, and never a `reset --hard` beside it. The
    // conditions guarantee a clean tree, and if that ever stops being true git's
    // own refusal is the check we want rather than a flag that overrides it.
    const argv = JSON.stringify(commands)
    expect(argv).not.toContain('--force')
    expect(argv).not.toContain('--hard')
    expect(argv).not.toContain('clean')
  })
})
