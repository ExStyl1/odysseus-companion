/**
 * P6.333 — the checkout-move EXECUTOR.
 *
 * `checkout-move-plan.test.ts` pins the PLANNER (the refusals, the command
 * order, the lease verdict, the reversibility predicate). This file pins the
 * half W8-r handed on: `SessionManager.carryCheckoutWork`, which supplies the
 * two `git status --porcelain` probes the pure planner cannot run, executes the
 * plan's commands STOP-ON-FAILURE, and reports rather than throws.
 *
 * Driven through a partial manager built with `Object.create`, the pattern this
 * suite already uses: the method reaches `runWorktreeGit` and
 * `sessionStore.getSessionPath` and nothing else.
 */
import { describe, expect, test } from 'bun:test'
import { createTestSessionManager } from './test-session-manager.ts'

type Run = { cwd: string; args: string[]; operation: string }

function rig(options: {
  dirty?: Record<string, boolean>
  failOn?: string
} = {}) {
  const runs: Run[] = []
  const managed = { id: 'sess-a', workspace: { id: 'ws-a' } }
  const manager = createTestSessionManager() as unknown as {
    carryCheckoutWork(managed: unknown, input: {
      direction: 'to-local' | 'to-worktree'
      repoRoot: string
      worktreePath: string
      mayReturn?: boolean
    }): Promise<{ carried: boolean; summary: string }>
  }
  Object.assign(manager, {
    sessionStore: { getSessionPath: () => '/state/sessions/sess-a' },
    runWorktreeGit: async (
      _key: unknown, _root: string, cwd: string, args: string[], operation: string,
    ) => {
      runs.push({ cwd, args, operation })
      if (options.failOn && operation === options.failOn) throw new Error(`git ${operation} failed`)
      if (operation === 'move-probe') {
        const target = args[1]!
        return { output: options.dirty?.[target] ? ' M src/a.ts\n' : '', exitCode: 0 }
      }
      return { output: '', exitCode: 0 }
    },
  })
  return { manager, managed, runs }
}

const REPO = '/projects/app'
const TREE = '/projects/.nessy-worktrees/app/lease-1'

describe('P6.333 · carryCheckoutWork', () => {
  test('probes both ends, then runs capture, apply and clean in that order', async () => {
    const { manager, managed, runs } = rig({ dirty: { [TREE]: true } })
    const outcome = await manager.carryCheckoutWork(managed, {
      direction: 'to-local', repoRoot: REPO, worktreePath: TREE,
    })
    expect(outcome.carried).toBe(true)
    expect(runs.map(run => run.operation)).toEqual([
      'move-probe', 'move-probe', 'move-capture', 'move-apply', 'move-clean',
    ])
    // The order is the whole safety property: the destination has the work
    // before the source gives it up.
    const capture = runs.find(run => run.operation === 'move-capture')!
    expect(capture.args).toContain('--binary')
    expect(capture.args[1]).toBe(TREE)
    expect(runs.find(run => run.operation === 'move-apply')!.args[1]).toBe(REPO)
    expect(runs.find(run => run.operation === 'move-clean')!.args[1]).toBe(TREE)
    expect(outcome.summary.length).toBeGreaterThan(0)
  })

  test('the other direction moves the same three commands the other way', async () => {
    const { manager, managed, runs } = rig({ dirty: { [REPO]: true } })
    const outcome = await manager.carryCheckoutWork(managed, {
      direction: 'to-worktree', repoRoot: REPO, worktreePath: TREE,
    })
    expect(outcome.carried).toBe(true)
    expect(runs.find(run => run.operation === 'move-capture')!.args[1]).toBe(REPO)
    expect(runs.find(run => run.operation === 'move-apply')!.args[1]).toBe(TREE)
    expect(runs.find(run => run.operation === 'move-clean')!.args[1]).toBe(REPO)
  })

  // A clean source is a move with nothing to carry — not a refusal, and not
  // three git commands run for nothing.
  test('a clean source runs no git beyond the two probes', async () => {
    const { manager, managed, runs } = rig()
    const outcome = await manager.carryCheckoutWork(managed, {
      direction: 'to-local', repoRoot: REPO, worktreePath: TREE,
    })
    expect(outcome.carried).toBe(false)
    expect(runs.map(run => run.operation)).toEqual(['move-probe', 'move-probe'])
  })

  // NEGATIVE 1 — a dirty DESTINATION is refused by the planner, and the
  // executor must report that refusal without running anything.
  test('a dirty destination is refused and nothing is executed', async () => {
    const { manager, managed, runs } = rig({ dirty: { [TREE]: true, [REPO]: true } })
    const outcome = await manager.carryCheckoutWork(managed, {
      direction: 'to-local', repoRoot: REPO, worktreePath: TREE,
    })
    expect(outcome.carried).toBe(false)
    expect(outcome.summary).toContain(REPO)
    expect(outcome.summary).toContain('uncommitted changes')
    expect(runs.map(run => run.operation)).toEqual(['move-probe', 'move-probe'])
  })

  // NEGATIVE 2 — STOP-ON-FAILURE. A failed apply must not be followed by the
  // clean, or the source would be reverted with the work nowhere. And the
  // failure is reported, not thrown: the session has already moved.
  test('a failed apply stops before the clean and says where the work still is', async () => {
    const { manager, managed, runs } = rig({ dirty: { [TREE]: true }, failOn: 'move-apply' })
    const outcome = await manager.carryCheckoutWork(managed, {
      direction: 'to-local', repoRoot: REPO, worktreePath: TREE,
    })
    expect(outcome.carried).toBe(false)
    expect(runs.map(run => run.operation)).toEqual([
      'move-probe', 'move-probe', 'move-capture', 'move-apply',
    ])
    expect(runs.some(run => run.operation === 'move-clean')).toBe(false)
    expect(outcome.summary).toContain(TREE)
  })

  // The lease half: this method NEVER releases, whatever `mayReturn` says.
  // Giving a worktree up stays `ExitWorktree`'s explicit `remove`, which has its
  // own refusal for a worktree that still holds work.
  test('no lease is released, in either mayReturn state', async () => {
    for (const mayReturn of [true, false]) {
      const { manager, managed, runs } = rig({ dirty: { [TREE]: true } })
      await manager.carryCheckoutWork(managed, {
        direction: 'to-local', repoRoot: REPO, worktreePath: TREE, mayReturn,
      })
      expect(runs.some(run => run.args.includes('worktree')), String(mayReturn)).toBe(false)
    }
  })
})
