import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The extra write scope a linked worktree needs, and the two holes inside it. */
export interface SharedGitDirectoryGrant {
  /** The main repository's shared `.git` directory. */
  writableRoot: string
  /** `hooks/` and `config` inside it, which stay denied. */
  deniedWriteRoots: readonly string[]
}

/** A `gitdir:` pointer is a one-line file; anything longer is not one. */
const MAX_GIT_POINTER_BYTES = 4096

/**
 * Local rather than `isolation.ts`'s `isPathContained`: this module is a leaf the
 * resolver imports, and importing back would close a cycle for two lines.
 */
function contains(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * The shared `.git` directory to grant when the workspace root is a LINKED
 * WORKTREE, or `undefined` when it is anything else.
 *
 * `sandboxing.md:314` — "when the working directory is a linked git worktree, the
 * sandbox also allows writes to the main repository's shared `.git` directory so
 * commands such as `git commit` can update refs and the index. Writes to `hooks/`
 * and `config` inside that directory remain denied."
 *
 * Without the grant, ordinary git is broken in a worktree and only there: a
 * worktree's `.git` is a FILE pointing at `<repo>/.git/worktrees/<name>`, whose
 * `commondir` points back at `<repo>/.git` — outside the workspace root, so
 * outside every write scope the profile opens. `git commit` cannot write the index
 * or a ref. Nessy creates worktrees at `<parent-of-repo>/.nessy-worktrees/…`
 * (`SessionManager`'s worktree authority), so this is our own layout as well as
 * the case a user hits by opening a worktree as their project.
 *
 * The two denies are not decoration. A write to `hooks/` is arbitrary code
 * execution on the next git command, and `config` carries `core.hooksPath`,
 * `core.fsmonitor` and the `credential.helper` — each of which turns a later git
 * invocation into a command of the attacker's choosing. That is the same reasoning
 * `session-filesystem-scope.ts` gives for keeping git metadata read-only for file
 * tools, and it is why the grant is not simply the whole directory.
 *
 * `.git` inside an ORDINARY repository is deliberately untouched. It is already
 * writable because it sits inside the workspace root, `sandboxing.md:311` makes
 * the working directory writable by default, and narrowing it would break
 * `husky install` and friends. This function only ever ADDS a scope, and only for
 * the layout that cannot work without one.
 *
 * The pointer file is REPOSITORY CONTENT, so it is untrusted: a checked-out `.git`
 * file reading `gitdir: /` would otherwise hand a sandboxed command the
 * filesystem. Four refusals bound it — the target must exist as a directory, it
 * must actually be a git directory (`HEAD`), it must not be the filesystem root,
 * and it must not CONTAIN the workspace root, which is how a fabricated pointer
 * would turn a narrow grant into a grant of everything above the project.
 * Anything unreadable or unexpected returns `undefined`: narrower, never wider.
 */
export function sharedGitDirectoryGrant(workspaceRoot: string): SharedGitDirectoryGrant | undefined {
  const pointerPath = join(workspaceRoot, '.git')
  // `lstat`, not `stat`: a `.git` symlink is neither the ordinary directory case
  // nor a worktree pointer, and following it would decide from the wrong node.
  const pointerStat = lstatSync(pointerPath, { throwIfNoEntry: false })
  if (!pointerStat?.isFile()) return undefined
  if (pointerStat.size > MAX_GIT_POINTER_BYTES) return undefined

  let gitdir: string | undefined
  try {
    gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(pointerPath, 'utf8'))?.[1]
  } catch {
    return undefined
  }
  if (!gitdir) return undefined
  const worktreeGitDir = isAbsolute(gitdir) ? gitdir : resolve(workspaceRoot, gitdir)

  let commondir: string
  try {
    commondir = readFileSync(join(worktreeGitDir, 'commondir'), 'utf8').trim()
  } catch {
    return undefined
  }
  if (commondir.length === 0) return undefined

  let sharedGitDir: string
  try {
    sharedGitDir = realpathSync(isAbsolute(commondir) ? commondir : resolve(worktreeGitDir, commondir))
  } catch {
    return undefined
  }
  if (!lstatSync(sharedGitDir, { throwIfNoEntry: false })?.isDirectory()) return undefined
  if (!existsSync(join(sharedGitDir, 'HEAD'))) return undefined
  if (dirname(sharedGitDir) === sharedGitDir) return undefined
  if (contains(sharedGitDir, workspaceRoot)) return undefined

  return {
    writableRoot: sharedGitDir,
    deniedWriteRoots: [join(sharedGitDir, 'hooks'), join(sharedGitDir, 'config')],
  }
}
