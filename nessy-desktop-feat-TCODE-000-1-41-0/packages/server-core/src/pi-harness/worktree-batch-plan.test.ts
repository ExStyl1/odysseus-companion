/**
 * P6.508 — the MR-less batch planner.
 *
 * Three properties carry the row and each has a block: the bound is applied and
 * DEFERS rather than truncates, every unit gets its own branch (two tasks can
 * never share one), and the result NAMES the branches a human must submit
 * because option A opens no merge request.
 */
import { describe, expect, test } from 'bun:test'
import { PROCESS_LIST_READ_CONCURRENCY } from './process-store'
import {
  BATCH_BOUND_REASON,
  MAX_BATCH_UNITS,
  MAX_BRANCH_NAME_LENGTH,
  branchSlug,
  describeBatchSubmission,
  planWorktreeBatch,
} from './worktree-batch-plan'

const tasks = (count: number, name = (i: number) => `Task ${i}`) =>
  Array.from({ length: count }, (_, i) => ({ name: name(i), prompt: `do ${i}` }))

const plan = (count: number, bound?: number) =>
  planWorktreeBatch({ tasks: tasks(count), branchPrefix: 'batch/x', ...(bound === undefined ? {} : { bound }) })

describe('the bound', () => {
  test('a batch inside the row’s own 5–30 range is never truncated', () => {
    // The row says "5–30 agents", so the bound is the top of that range and a
    // request the row itself describes must go through whole.
    for (const count of [5, 17, 30]) expect(plan(count).units).toHaveLength(count)
  })

  test('tasks past the bound are DEFERRED and named, never dropped', () => {
    // A batch that silently ran 30 of 40 is the shape where ten pieces of work
    // are believed done.
    const result = plan(MAX_BATCH_UNITS + 3)
    expect(result.units).toHaveLength(MAX_BATCH_UNITS)
    expect(result.deferred).toHaveLength(3)
    expect(result.deferred.map(t => t.name)).toEqual(['Task 30', 'Task 31', 'Task 32'])
    expect(result.deferred.every(t => t.reason === 'over-bound')).toBe(true)
  })

  test('a caller may narrow the bound and may not widen it', () => {
    expect(plan(10, 3).units).toHaveLength(3)
    expect(plan(10, 3).bound).toBe(3)
    // The ceiling is the measured one; asking for more gets the ceiling.
    expect(plan(50, 500).units).toHaveLength(MAX_BATCH_UNITS)
    expect(plan(50, 500).bound).toBe(MAX_BATCH_UNITS)
    // …and a nonsense bound still starts something rather than nothing.
    expect(plan(5, 0).bound).toBe(1)
  })

  test('the bound is SMALLER than the record-read concurrency, and the reason says why', () => {
    // Both come from one fd measurement; a session costs more than a record
    // read, so equality here would be the copy this constant exists to avoid.
    expect(MAX_BATCH_UNITS).toBeLessThan(PROCESS_LIST_READ_CONCURRENCY);
    expect(BATCH_BOUND_REASON).toContain(String(MAX_BATCH_UNITS))
    expect(BATCH_BOUND_REASON).toContain('ulimit -n')
    expect(BATCH_BOUND_REASON).toContain(String(PROCESS_LIST_READ_CONCURRENCY))
  })

  test('an empty batch plans nothing rather than failing', () => {
    expect(plan(0)).toEqual({ units: [], deferred: [], bound: MAX_BATCH_UNITS })
  })
})

describe('the branches', () => {
  test('every unit gets its own branch under the requested prefix', () => {
    const branches = plan(5).units.map(u => u.branch)
    expect(new Set(branches).size).toBe(5)
    expect(branches.every(b => b.startsWith('batch/x/'))).toBe(true)
  })

  test('two tasks that slug the same still get DIFFERENT branches', () => {
    // The failure this prevents is not a name collision: two agents attached to
    // one branch write to one tree.
    const result = planWorktreeBatch({
      tasks: [
        { name: 'Fix the bug!', prompt: 'a' },
        { name: 'fix the bug', prompt: 'b' },
        { name: 'Fix  the   bug', prompt: 'c' },
      ],
      branchPrefix: 'batch/x',
    })
    expect(new Set(result.units.map(u => u.branch)).size).toBe(3)
    expect(result.units.map(u => u.branch)).toEqual(['batch/x/fix-the-bug', 'batch/x/fix-the-bug-2', 'batch/x/fix-the-bug-3'])
  })

  test('a name of only refused characters still yields a usable branch', () => {
    // `''` would produce a branch ending in the prefix separator — a different
    // branch than asked for, and the same one twice for two such names.
    const result = planWorktreeBatch({
      tasks: [{ name: '???', prompt: 'a' }, { name: '***', prompt: 'b' }],
      branchPrefix: 'batch/x',
    })
    expect(result.units.map(u => u.branch)).toEqual(['batch/x/task', 'batch/x/task-2'])
  })

  test('the slug refuses every character git check-ref-format does', () => {
    // Enumerated as a control rather than trusted: each of these makes
    // `git worktree add` fail at RUN time with the batch half-started.
    for (const bad of [' ', '~', '^', ':', '?', '*', '[', '\\', '..', '@{', '\t']) {
      expect(branchSlug(`a${bad}b`), bad).not.toContain(bad.length === 1 ? bad : bad[0]!)
    }
    // Positive control: an ordinary name survives intact.
    expect(branchSlug('Add retry to the fetcher')).toBe('add-retry-to-the-fetcher')
  })

  test('a long name is capped, suffix included', () => {
    const result = planWorktreeBatch({
      tasks: [{ name: 'x'.repeat(400), prompt: 'a' }, { name: 'x'.repeat(400), prompt: 'b' }],
      branchPrefix: 'batch/x',
    })
    for (const unit of result.units) expect(unit.branch.length).toBeLessThanOrEqual(MAX_BRANCH_NAME_LENGTH)
    expect(new Set(result.units.map(u => u.branch)).size).toBe(2)
  })

  test('a trailing slash on the prefix does not double up', () => {
    expect(planWorktreeBatch({ tasks: tasks(1), branchPrefix: 'batch/x//' }).units[0]?.branch)
      .toBe('batch/x/task-0')
  })

  test('a blank prefix is refused rather than defaulted', () => {
    // Thirty branches in whatever namespace the repository already uses is not a
    // default anybody can want.
    expect(() => planWorktreeBatch({ tasks: tasks(1), branchPrefix: '   ' })).toThrow(/branchPrefix/)
  })

  test('an explicit id wins over the index', () => {
    const result = planWorktreeBatch({
      tasks: [{ id: 'own', name: 'A', prompt: 'a' }, { name: 'B', prompt: 'b' }],
      branchPrefix: 'batch/x',
    })
    expect(result.units.map(u => u.id)).toEqual(['own', 'task-2'])
  })
})

describe('the result a human reads', () => {
  test('it NAMES the branches and says no merge request was opened', () => {
    // This sentence IS option A: Q-den 31 refused the forge write, so the batch
    // has to hand the work back or thirty branches sit unmerged unnoticed.
    const text = describeBatchSubmission(plan(2))
    expect(text).toContain('No merge request was opened')
    expect(text).toContain('batch/x/task-0')
    expect(text).toContain('batch/x/task-1')
    expect(text).toContain('own worktree on its own branch')
  })

  test('deferred tasks are reported with the bound that refused them', () => {
    const text = describeBatchSubmission(plan(MAX_BATCH_UNITS + 1))
    expect(text).toContain('NOT started')
    expect(text).toContain(`at most ${MAX_BATCH_UNITS} agents`)
    expect(text).toContain('Run them as a second batch')
  })

  test('an empty plan says nothing ran rather than reporting success', () => {
    expect(describeBatchSubmission(plan(0))).toBe('No work was started.')
  })

  test('the text never claims a forge action', () => {
    // The negative half: option B and its per-MR confirmation were refused, so
    // no wording here may imply one happened.
    const text = describeBatchSubmission(plan(MAX_BATCH_UNITS + 1)).toLowerCase()
    for (const forbidden of ['opened a merge request', 'pull request was', 'submitted for review', 'pushed']) {
      expect(text).not.toContain(forbidden)
    }
  })
})
