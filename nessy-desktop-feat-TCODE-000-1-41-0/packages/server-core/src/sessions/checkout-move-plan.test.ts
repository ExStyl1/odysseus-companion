/**
 * P6.333 — a chat moves between the local checkout and its worktree, in either
 * direction, carrying the uncommitted work.
 *
 * `done_means` has two halves and each has a block: the diff CROSSES (HEAD could
 * only move the cwd and refuse to lose work), and the worktree stays held so the
 * chat can come back — the lease-identity half the row calls out as "not only a
 * git one".
 *
 * The ordering test is the one that matters most: a plan that cleaned the source
 * before the destination had the work would pass every other assertion here and
 * lose a person's uncommitted changes on the first failed apply.
 */
import { describe, expect, test } from 'bun:test'

import {
  checkoutMoveIsReversible,
  describeCheckoutMove,
  planCheckoutMove,
  type CheckoutMovePlan,
  type CheckoutMovePlanInput,
} from './checkout-move-plan'

const REPO = '/repo'
const TREE = '/repo/.worktrees/feature'
const PATCH = '/state/checkout-move.patch'

const plan = (over: Partial<CheckoutMovePlanInput> = {}) => planCheckoutMove({
  direction: 'to-local',
  repoRoot: REPO,
  worktreePath: TREE,
  sourceHasUncommittedChanges: true,
  destinationHasUncommittedChanges: false,
  ...over,
}, PATCH)

const asPlan = (result: ReturnType<typeof plan>): CheckoutMovePlan => {
  expect(result.kind).toBe('plan')
  return result as CheckoutMovePlan
}

describe('the direction', () => {
  test('to-local leaves the worktree and lands in the repo root', () => {
    const result = asPlan(plan())
    expect(result.sourcePath).toBe(TREE)
    expect(result.destinationPath).toBe(REPO)
  })

  test('to-worktree is the same move with the ends swapped', () => {
    const result = asPlan(plan({ direction: 'to-worktree' }))
    expect(result.sourcePath).toBe(REPO)
    expect(result.destinationPath).toBe(TREE)
    // Both directions exist because the row asks for "either direction"; HEAD
    // had only the one, and only as a cwd change.
    expect(result.commands.map(c => c.cwd)).toEqual(['repo', 'worktree', 'repo'])
  })

  test('a move to where the session already is is refused, not a no-op plan', () => {
    const result = plan({ worktreePath: REPO })
    expect(result.kind).toBe('refused')
  })
})

describe('the uncommitted work crosses', () => {
  test('the plan is capture, apply, then clean — in that order', () => {
    expect(asPlan(plan()).commands.map(c => c.operation))
      .toEqual(['move-capture', 'move-apply', 'move-clean'])
  })

  test('the apply happens BEFORE the source is cleaned', () => {
    // The property, not the order of a list: a failed apply must leave the work
    // exactly where it was.
    expect(checkoutMoveIsReversible(asPlan(plan()))).toBe(true)
  })

  test('checkoutMoveIsReversible actually fails on a reordered plan', () => {
    // Control for the assertion above — without it, a predicate that always
    // returned `true` would pass.
    const broken = asPlan(plan())
    broken.commands.reverse()
    expect(checkoutMoveIsReversible(broken)).toBe(false)
  })

  test('the capture is --binary, or an uncommitted image breaks the whole move', () => {
    // Without `--binary` git emits "Binary files a/x and b/x differ", which
    // `git apply` refuses.
    const capture = asPlan(plan()).commands.find(c => c.operation === 'move-capture')!
    expect(capture.args).toContain('--binary')
    expect(capture.args).toContain('HEAD')
    expect(capture.args.join(' ')).toContain(PATCH)
  })

  test('the apply keeps staged files staged', () => {
    const apply = asPlan(plan()).commands.find(c => c.operation === 'move-apply')!
    expect(apply.args).toContain('--index')
  })

  test('each command runs in the right directory', () => {
    const commands = asPlan(plan()).commands
    expect(commands.find(c => c.operation === 'move-capture')!.args.slice(0, 2)).toEqual(['-C', TREE])
    expect(commands.find(c => c.operation === 'move-apply')!.args.slice(0, 2)).toEqual(['-C', REPO])
    expect(commands.find(c => c.operation === 'move-clean')!.args.slice(0, 2)).toEqual(['-C', TREE])
  })

  test('a clean source moves with NO git commands at all', () => {
    const result = asPlan(plan({ sourceHasUncommittedChanges: false }))
    expect(result.commands).toEqual([])
    expect(result.carriesUncommittedWork).toBe(false)
  })

  test('a dirty DESTINATION is refused by name rather than merged into', () => {
    // `git apply` on a dirty tree either conflicts and changes nothing, or
    // applies on top of work nobody expected to be touched.
    const result = plan({ destinationHasUncommittedChanges: true })
    expect(result.kind).toBe('refused')
    expect((result as { reason: string }).reason).toContain(REPO)
  })

  test('no command ever touches the stash', () => {
    // The stash is a repository-wide stack shared by every worktree, so two
    // sessions moving at once would pop each other's work.
    for (const direction of ['to-local', 'to-worktree'] as const) {
      const text = asPlan(plan({ direction })).commands.map(c => c.args.join(' ')).join('\n')
      expect(text).not.toContain('stash')
      // …and nothing removes untracked files, which `git clean` would.
      expect(text).not.toContain('clean -')
    }
  })
})

describe('the lease half — not a git question', () => {
  test('the lease is kept by default, so the chat can come back', () => {
    // A released lease is a worktree another session may take; the return trip
    // would land somewhere else wearing the same name.
    expect(asPlan(plan()).retainLease).toBe(true)
    expect(asPlan(plan({ mayReturn: true })).retainLease).toBe(true)
  })

  test('only an explicit false gives it up', () => {
    expect(asPlan(plan({ mayReturn: false })).retainLease).toBe(false)
  })
})

describe('what the session is told', () => {
  test('it names the destination, the carried work and the lease', () => {
    const text = describeCheckoutMove(asPlan(plan()))
    expect(text).toContain(REPO)
    expect(text).toContain('uncommitted changes moved with it')
    expect(text).toContain('still held for this session')
  })

  test('a released lease says the return trip would create a new worktree', () => {
    expect(describeCheckoutMove(asPlan(plan({ mayReturn: false })))).toContain('would create a new one')
  })

  test('a clean move does not claim work was carried', () => {
    const text = describeCheckoutMove(asPlan(plan({ sourceHasUncommittedChanges: false })))
    expect(text).toContain('no uncommitted changes to carry')
    expect(text).not.toContain('moved with it')
  })

  test('the lease sentence is absent when moving INTO a worktree', () => {
    // Moving in is when the lease is taken, not kept, so a sentence about
    // keeping it would describe a decision that has not been made yet.
    const text = describeCheckoutMove(asPlan(plan({ direction: 'to-worktree' })))
    expect(text).not.toContain('still held')
    expect(text).toContain(TREE)
  })
})
