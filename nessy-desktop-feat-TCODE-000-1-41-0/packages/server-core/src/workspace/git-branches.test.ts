import { beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutBranch, listBranches } from './git-branches'

let repo: string

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-branches-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
  git('init', '-b', 'main')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init')
  git('branch', 'feature/x')
  return dir
}

beforeAll(() => {
  repo = makeRepo()
})

describe('listBranches', () => {
  test('returns branches + current on a healthy repo', async () => {
    const result = await listBranches(repo)

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.current).toBe('main')
    expect(result.branches).toContain('feature/x')
  })

  test('non-repo returns typed not-a-repo (not error)', async () => {
    // A fresh temp dir that is not inside any git repo.
    const nonRepo = mkdtempSync(join(tmpdir(), 'git-branches-none-'))
    expect((await listBranches(nonRepo)).status).toBe('not-a-repo')
  })
})

describe('checkoutBranch — clean tree', () => {
  test('switches branches', async () => {
    const clean = makeRepo()
    const result = await checkoutBranch(clean, 'feature/x')

    expect(result.status).toBe('success')
    const after = await listBranches(clean)
    expect(after.status === 'ok' && after.current).toBe('feature/x')
  })
})

describe('checkoutBranch — dirty tree', () => {
  test('blocks by default without mutating (status: dirty)', async () => {
    const dirty = makeRepo()
    // Modify a tracked file so the checkout would conflict.
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'x'], { cwd: dirty })
    writeFileSync(join(dirty, 'tracked.txt'), 'v1')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: dirty })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'add tracked'], { cwd: dirty })
    // Uncommitted change:
    writeFileSync(join(dirty, 'tracked.txt'), 'v2-uncommitted')

    const result = await checkoutBranch(dirty, 'feature/x')

    expect(result.status).toBe('dirty')
    // No mutation: still on main.
    const after = await listBranches(dirty)
    expect(after.status === 'ok' && after.current).toBe('main')
  })

  test('autoStash stashes → checks out → pops, preserving work (no conflict)', async () => {
    const dirty = makeRepo()
    // Untracked file — stash -u carries it, pop restores it cleanly onto the new branch.
    writeFileSync(join(dirty, 'wip.txt'), 'work in progress')

    const result = await checkoutBranch(dirty, 'feature/x', { autoStash: true })

    expect(result.status).toBe('success')
    expect(result.stashPopConflict).toBeUndefined()
    const after = await listBranches(dirty)
    expect(after.status === 'ok' && after.current).toBe('feature/x')
    // The uncommitted work survived the switch.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dirty }).toString()).toContain('wip.txt')
    // Nothing left stranded on the stash.
    expect(execFileSync('git', ['stash', 'list'], { cwd: dirty }).toString().trim()).toBe('')
  })

  test('surfaces a stash-pop conflict fail-soft (branch switched, stash kept)', async () => {
    const dirty = makeRepo()
    const conflictFile = 'conflict.txt'
    // Create the same tracked file with DIFFERENT content on both branches so a
    // pop back onto feature/x conflicts with the version there.
    writeFileSync(join(dirty, conflictFile), 'main-version\n')
    execFileSync('git', ['add', conflictFile], { cwd: dirty })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main file'], { cwd: dirty })

    execFileSync('git', ['checkout', 'feature/x'], { cwd: dirty })
    writeFileSync(join(dirty, conflictFile), 'feature-version\n')
    execFileSync('git', ['add', conflictFile], { cwd: dirty })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'feature file'], { cwd: dirty })

    execFileSync('git', ['checkout', 'main'], { cwd: dirty })
    // Uncommitted edit on main that will conflict when popped onto feature/x.
    writeFileSync(join(dirty, conflictFile), 'uncommitted-edit\n')

    const result = await checkoutBranch(dirty, 'feature/x', { autoStash: true })

    // Checkout of the target branch succeeded; the pop conflicted and is surfaced.
    expect(result.status).toBe('success')
    expect(result.stashPopConflict).toBe(true)
    const after = await listBranches(dirty)
    expect(after.status === 'ok' && after.current).toBe('feature/x')
    // The stashed work is preserved (still on the stack), not silently lost.
    expect(execFileSync('git', ['stash', 'list'], { cwd: dirty }).toString().trim()).not.toBe('')
  })
})
