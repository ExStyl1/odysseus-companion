import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { GitBranchesResult, GitCheckoutResult } from '@nessy-agent/shared/protocol'

const run = promisify(execFile)

/**
 * True when the working tree at `cwd` is inside a git repository. Uses
 * `rev-parse --is-inside-work-tree` so we can distinguish "not a repo" from a
 * genuine git failure (missing binary, permission, corruption) instead of
 * collapsing every failure to a single opaque result.
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * True when the working tree has uncommitted changes (staged, unstaged, or
 * untracked). `--porcelain` output is empty for a clean tree.
 */
async function isDirtyTree(cwd: string): Promise<boolean> {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd })
  return stdout.trim().length > 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function listBranches(cwd: string): Promise<GitBranchesResult> {
  if (!(await isGitRepo(cwd))) {
    return { status: 'not-a-repo' }
  }

  try {
    const { stdout } = await run('git', ['branch', '--list', '--format=%(refname:short)\t%(HEAD)'], { cwd })
    const branches: string[] = []
    let current: string | null = null

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const [name, head] = line.split('\t')
      if (!name) continue
      branches.push(name)
      if (head === '*') current = name
    }

    return { status: 'ok', current, branches }
  } catch (error) {
    return { status: 'error', error: errorMessage(error) }
  }
}

/**
 * Check out `branch` in `cwd`.
 *
 * With a clean working tree the checkout proceeds directly. With a dirty tree
 * the default is to REFUSE (`status: 'dirty'`, no mutation) so the caller can
 * explain the situation and offer an explicit auto-stash confirm — never lose
 * uncommitted work implicitly.
 *
 * When `autoStash` is true and the tree is dirty, the changes are stashed
 * (`git stash push -u`), the branch is checked out, and the stash is popped
 * back. A pop conflict is surfaced fail-soft (`stashPopConflict: true`) — the
 * checkout succeeded but the stashed changes remain on the stash stack for the
 * user to resolve, rather than leaving the tree silently broken.
 */
export async function checkoutBranch(
  cwd: string,
  branch: string,
  options?: { autoStash?: boolean },
): Promise<GitCheckoutResult> {
  let dirty: boolean
  try {
    dirty = await isDirtyTree(cwd)
  } catch (error) {
    return { status: 'error', error: errorMessage(error) }
  }

  if (dirty && !options?.autoStash) {
    return { status: 'dirty' }
  }

  if (!dirty) {
    try {
      await run('git', ['checkout', branch], { cwd })
      return { status: 'success' }
    } catch (error) {
      return { status: 'error', error: errorMessage(error) }
    }
  }

  // Dirty tree + explicit auto-stash: stash → checkout → pop.
  try {
    await run('git', ['stash', 'push', '-u', '-m', `nessy: switch to ${branch}`], { cwd })
  } catch (error) {
    return { status: 'error', error: errorMessage(error) }
  }

  try {
    await run('git', ['checkout', branch], { cwd })
  } catch (error) {
    // Checkout failed — restore the stashed work so nothing is lost.
    try {
      await run('git', ['stash', 'pop'], { cwd })
    } catch {
      // Pop after a failed checkout also failed; the stash is preserved on the
      // stack. Report the original checkout error but flag the stranded stash.
      return { status: 'error', error: errorMessage(error), stashPopConflict: true }
    }
    return { status: 'error', error: errorMessage(error) }
  }

  // Checkout succeeded on the new branch; re-apply the stashed changes.
  try {
    await run('git', ['stash', 'pop'], { cwd })
    return { status: 'success' }
  } catch (error) {
    // Pop conflicted or failed. The branch switch is done, but the stashed
    // changes could not be re-applied and remain on the stash stack. Surface it.
    return { status: 'success', error: errorMessage(error), stashPopConflict: true }
  }
}
