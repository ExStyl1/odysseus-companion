import { basename, dirname, join, resolve, sep } from 'node:path'

/**
 * WHERE harness-owned worktrees live, as one rule.
 *
 * Claude documents this region as `<repoRoot>/.claude/worktrees/<name>/`, and
 * hangs a security boundary off it: `EnterWorktree` prompts for approval when
 * the target is OUTSIDE that region, because the move relocates the session's
 * working directory, its write access and its project config
 * (code.claude.com/docs/en/tools-reference.md, worktrees.md).
 *
 * This fork does not use that path. `WorktreeLeaseService`'s policy places a
 * worktree at `<dirname(repoRoot)>/.nessy-worktrees/<repo-slug>/<leaseId>` —
 * a sibling of the repository rather than a directory inside it, so a worktree
 * is never itself a candidate for the repository's own tooling. The boundary is
 * the same boundary; only the path differs.
 *
 * The rule lives here, and ONLY here, because two very different callers need
 * the identical answer: the lease policy that CREATES the path, and the
 * permission floor that decides whether entering a path needs a human. Two
 * copies of "where worktrees live" would be a security boundary that drifts.
 */

/** Path segment sanitiser for a repo slug or an owner id. */
export function safeWorktreeSegment(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe || safe === '.' || safe === '..') throw new Error('worktree-policy-selection-invalid')
  return safe.slice(0, 80)
}

export interface WorktreeNamespace {
  /** The repository the worktrees belong to. */
  repoRoot: string
  /** The directory the namespace root sits in — the repository's parent. */
  containmentRoot: string
  /** Every worktree of this repository is a direct child of this directory. */
  namespaceRoot: string
}

/**
 * Resolve the worktree namespace of a repository.
 *
 * Refuses a repository at a filesystem root: the namespace is a SIBLING of the
 * repository, and a root has no usable sibling — the same refusal the lease
 * policy has always made (`worktree-project-root-too-broad`).
 */
export function resolveWorktreeNamespace(repoRoot: string): WorktreeNamespace {
  const root = resolve(repoRoot)
  const containmentRoot = dirname(root)
  if (containmentRoot === root) throw new Error('worktree-project-root-too-broad')
  return {
    repoRoot: root,
    containmentRoot,
    namespaceRoot: join(containmentRoot, '.nessy-worktrees', safeWorktreeSegment(basename(root))),
  }
}

/**
 * Whether `target` is the namespace root of `repoRoot` or a path beneath it.
 *
 * Purely lexical on resolved paths, which is deliberate: this runs at permission
 * time on a path the model supplied, which may not exist yet, and a
 * `realpath` here would both fail on a fresh worktree and add a filesystem
 * dependency to a permission decision. The symlink screen for a path that DOES
 * exist is `resolveHookWorktreePath`'s job at creation time.
 *
 * Fails closed: an empty target, or a repository with no usable namespace, is
 * not inside anything.
 */
export function isInsideWorktreeNamespace(target: string, repoRoot: string): boolean {
  if (!target.trim() || !repoRoot.trim()) return false
  let namespaceRoot: string
  try {
    namespaceRoot = resolveWorktreeNamespace(repoRoot).namespaceRoot
  } catch {
    return false
  }
  const resolved = resolve(target)
  return resolved === namespaceRoot || resolved.startsWith(`${namespaceRoot}${sep}`)
}
