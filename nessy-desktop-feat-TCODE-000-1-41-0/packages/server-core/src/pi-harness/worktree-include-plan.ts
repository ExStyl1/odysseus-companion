import { resolve, sep } from 'node:path'
import { matchGitignoreGlob } from '@nessy-agent/shared/agent/pi-harness/gitignore-glob'
import type { WorktreeGitCommand } from './worktree-git-plan'

/**
 * `.worktreeinclude` — worktrees.md:150-162: a gitignore-syntax file at the
 * PROJECT root names gitignored files to copy into every worktree created with
 * git. "Only files that match a pattern and are also gitignored are copied, so
 * tracked files are never duplicated" — git itself is the ignore engine (the
 * candidate commands below), never a second ignore implementation here.
 *
 * Pure planner in the worktree-git-plan.ts shape: parsing, candidate argv and
 * the copy plan are assertable without a repository. The gitignore rules
 * `matchGitignoreGlob` does NOT carry — `!` negation, leading-`/` anchoring,
 * trailing-`/` directory-only, last-match-wins — live HERE: that module is the
 * permission matcher, pinned to permissions.md's documented subset, and is
 * reused read-only for the per-segment glob core.
 */

/**
 * Mirrors worktree-settings.ts `MAX_LIST_ENTRIES`/`MAX_ENTRY_LENGTH` (those
 * constants are module-private there by design — the settings parser throws on
 * unknown keys and exports nothing it does not have to). A `.worktreeinclude`
 * must not be able to name a file outside the repository, and its size caps
 * match the settings lists'.
 */
const MAX_PATTERNS = 128
const MAX_PATTERN_LENGTH = 512

export interface WorktreeIncludePattern {
  /** Pattern body with `!`, the anchoring `/` and the trailing `/` stripped. */
  body: string
  /** Leading `!`: a matching entry is EXCLUDED when this is the last match. */
  negated: boolean
  /** Leading `/`: matches from the repository root only, no depth float. */
  anchored: boolean
  /** Trailing `/`: names a directory; only files inside it can match. */
  directoryOnly: boolean
}

/**
 * Parse `.worktreeinclude` text. Blank lines and `#` comments are dropped
 * (`\#`/`\!` escape a literal leading character), unescaped trailing whitespace
 * is trimmed — gitignore's own line rules.
 *
 * Refusals THROW (the caller treats a malformed file as a warn-and-skip, never
 * a failed creation): `..` segments and drive-absolute entries, exactly the
 * escapes `repoRelativePaths` in worktree-settings.ts refuses. A single
 * leading `/` is gitignore ANCHORING, not an absolute path — the plan's
 * containment check makes escape impossible regardless.
 */
export function parseWorktreeInclude(text: string): WorktreeIncludePattern[] {
  const patterns: WorktreeIncludePattern[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    // Trailing whitespace is ignored unless backslash-escaped (gitignore rule).
    const line = rawLine.replace(/(?<!\\)[ \t]+$/, '')
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.length > MAX_PATTERN_LENGTH) throw new Error('worktree-include-entry-too-long')
    let body = line
    let negated = false
    if (body.startsWith('!')) {
      negated = true
      body = body.slice(1)
    } else if (body.startsWith('\\#') || body.startsWith('\\!')) {
      body = body.slice(1)
    }
    body = body.replaceAll('\\ ', ' ')
    let directoryOnly = false
    let anchored = false
    if (body.endsWith('/')) {
      directoryOnly = true
      body = body.replace(/\/+$/, '')
    }
    if (body.startsWith('/')) {
      anchored = true
      body = body.replace(/^\/+/, '')
    }
    if (/^[a-zA-Z]:/.test(body)) throw new Error('worktree-include-entry-not-relative')
    if (body.split('/').includes('..')) throw new Error('worktree-include-entry-escapes-repository')
    if (body.length === 0) continue
    if (patterns.length === MAX_PATTERNS) throw new Error('worktree-include-too-many-entries')
    patterns.push({ body, negated, anchored, directoryOnly })
  }
  return patterns
}

export interface WorktreeIncludeCandidateCommand extends WorktreeGitCommand {
  /**
   * Present on `include-check-ignore` probes: the repo-relative path whose
   * ignore status the command asks git for. Exit 0 adds it to the candidate
   * set — this is how a file inside a wholly-collapsed ignored directory
   * (which `ls-files --directory` reports only as `dir/`) stays reachable.
   */
  probePath?: string
}

/**
 * The git commands that produce the authoritative "also gitignored" candidate
 * set. All `allowFailure`: an unlistable repo means no copies, never a failed
 * worktree creation, and `check-ignore -q` exits 1 for a non-ignored path as
 * its normal answer.
 */
export function worktreeIncludeCandidateCommands(
  repoRoot: string,
  patterns: readonly WorktreeIncludePattern[],
): WorktreeIncludeCandidateCommand[] {
  const commands: WorktreeIncludeCandidateCommand[] = [{
    // `--directory --no-empty-directory` collapses a wholly-ignored directory
    // to one entry — what keeps a repo with `node_modules` from emitting
    // hundreds of thousands of paths.
    operation: 'include-list',
    cwd: 'repo',
    args: ['-C', repoRoot, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory'],
    allowFailure: true,
  }]
  for (const pattern of patterns) {
    if (pattern.negated || pattern.directoryOnly || /[*?]/.test(pattern.body)) continue
    commands.push({
      operation: 'include-check-ignore',
      cwd: 'repo',
      args: ['-C', repoRoot, 'check-ignore', '-q', '--', pattern.body],
      allowFailure: true,
      probePath: pattern.body,
    })
  }
  return commands
}

export interface WorktreeIncludeCopy {
  /** Absolute path of the gitignored file in the main checkout. */
  source: string
  /** Absolute path inside the worktree the copy lands at. */
  destination: string
}

/**
 * The copies one worktree gets. Only entries in `ignoredEntries` are eligible
 * (tracked files are never duplicated — the candidate set IS the gitignore
 * filter), the LAST matching pattern wins with `!` negation, and both ends are
 * containment-checked: these are secrets, so a candidate that resolves outside
 * the checkout or a destination outside the worktree is dropped, not trusted.
 */
export function worktreeIncludePlan(input: {
  repoRoot: string
  worktreePath: string
  patterns: readonly WorktreeIncludePattern[]
  /**
   * Output of the candidate commands: NUL-split `include-list` entries plus
   * every `probePath` whose `check-ignore` exited 0.
   */
  ignoredEntries: readonly string[]
}): WorktreeIncludeCopy[] {
  const repoRoot = resolve(input.repoRoot)
  const worktreePath = resolve(input.worktreePath)
  const planned: WorktreeIncludeCopy[] = []
  const seen = new Set<string>()
  for (const entry of input.ignoredEntries) {
    // A trailing `/` is a wholly-ignored directory `ls-files --directory`
    // collapsed. A pattern matching it never expands into the directory's
    // contents — only file entries are planned.
    if (entry.length === 0 || entry.endsWith('/')) continue
    const relative = entry.replace(/^(\.\/)+/, '')
    if (seen.has(relative)) continue
    seen.add(relative)
    if (!lastMatchIncludes(input.patterns, relative)) continue
    const source = resolve(repoRoot, relative)
    const destination = resolve(worktreePath, relative)
    if (!contains(repoRoot, source) || !contains(worktreePath, destination)) continue
    planned.push({ source, destination })
  }
  return planned
}

function contains(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** gitignore's decision rule: the LAST matching pattern decides. */
function lastMatchIncludes(patterns: readonly WorktreeIncludePattern[], relative: string): boolean {
  let included = false
  for (const pattern of patterns) {
    if (patternMatches(pattern, relative)) included = !pattern.negated
  }
  return included
}

function patternMatches(pattern: WorktreeIncludePattern, relative: string): boolean {
  // gitignore depth rules: a body containing `/` (or a leading `/`) is
  // anchored to the repository root; a bare body floats to any depth.
  // `bareLiteralFloat: false` because the float is expressed through
  // `anyDepth` here — an anchored bare literal must NOT float.
  const opts = {
    anyDepth: !pattern.anchored && !pattern.body.includes('/'),
    bareLiteralFloat: false,
  }
  if (!pattern.directoryOnly && matchGitignoreGlob(pattern.body, relative, opts)) return true
  // A pattern matching a parent directory covers the files inside it.
  const segments = relative.split('/')
  for (let depth = 1; depth < segments.length; depth++) {
    if (matchGitignoreGlob(pattern.body, segments.slice(0, depth).join('/'), opts)) return true
  }
  return false
}
