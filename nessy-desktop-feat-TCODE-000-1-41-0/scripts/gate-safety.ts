/**
 * gate-safety — the refusal that keeps a gate runner from executing a string
 * that names a real home or filesystem root.
 *
 * The gate runners in this directory build argv out of package.json script
 * names and directory arguments. Both are data. A runner that shells out
 * without checking them is one bad manifest edit away from executing
 * `rm -rf ~/…`, and "we would notice" is not a mechanism. So the refusal lives
 * in the harness rather than in whoever is reading the diff:
 *
 *   - `~` and `$HOME` in any quoting form,
 *   - any absolute path (`/…`), including a bare `/`.
 *
 * Deliberately blunt. Every string these runners actually execute is a script
 * NAME or a repo-relative path, so a hit is a bug, not a special case. If a
 * probe of your own trips it, rename the probe — do not widen the hole.
 *
 * Containment is a SEPARATE question and is answered by `realpath`
 * (`assertInsideRepo`), never by comparing string prefixes: `/a/b-evil` has
 * `/a/b` as a textual prefix and is not inside it.
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

interface UnsafePattern {
  readonly description: string
  readonly pattern: RegExp
}

export const UNSAFE_PATH_PATTERNS: readonly UnsafePattern[] = [
  { description: 'a `~` home reference', pattern: /(?:^|[\s"'=])~/ },
  { description: 'a `$HOME` expansion', pattern: /\$\{?HOME\b/ },
  { description: 'an absolute path', pattern: /(?:^|[\s"'=])\// },
]

export class GateSafetyRefusal extends Error {}

/**
 * Refuse `value` if it names a home directory or an absolute path.
 * `label` says where the string came from, because the operator's next
 * question is always "which one".
 */
export function assertNoHomeOrRootPath(label: string, value: string): void {
  for (const { description, pattern } of UNSAFE_PATH_PATTERNS) {
    if (!pattern.test(value)) continue
    throw new GateSafetyRefusal(
      `REFUSED: ${label} contains ${description} and will not be executed.\n` +
      `  value: ${JSON.stringify(value)}\n` +
      '  Gate runners execute script names and repo-relative paths only. Nothing\n' +
      '  they run should ever name a home directory or the filesystem root.',
    )
  }
}

/**
 * Resolve `relativePath` under `repoRoot` and refuse anything that escapes it.
 * Both sides go through `realpathSync` first, so a symlink out of the tree is
 * caught — which a `startsWith` on the unresolved strings would not catch.
 */
export function assertInsideRepo(repoRoot: string, relativePath: string): string {
  assertNoHomeOrRootPath('the target directory', relativePath)

  const rootReal = realpathSync(repoRoot)
  let targetReal: string
  try {
    targetReal = realpathSync(resolve(rootReal, relativePath))
  } catch {
    throw new GateSafetyRefusal(
      `REFUSED: ${JSON.stringify(relativePath)} does not exist under the repo root.`,
    )
  }

  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
    throw new GateSafetyRefusal(
      `REFUSED: ${JSON.stringify(relativePath)} resolves to ${targetReal},\n` +
      `  which is outside the repository at ${rootReal}.`,
    )
  }

  return targetReal
}

/**
 * A scratch directory INSIDE the repo, for the side-channel files these gates
 * pass to the tools they wrap.
 *
 * `os.tmpdir()` would be the obvious home and is not usable: its path is
 * absolute, and an absolute path handed to a child process is precisely what
 * `assertNoHomeOrRootPath` refuses. Rather than carve an exception into the
 * guard for our own convenience — which is how guards stop being guards — the
 * scratch file moves to somewhere a REPO-RELATIVE path can reach.
 * `node_modules/` is gitignored wholesale, so nothing lands in a diff.
 */
export function createGateScratchDir(repoRoot: string, prefix: string): {
  absolute: string
  /** Repo-relative, POSIX separators — safe to hand to a child process. */
  fromRepoRoot: string
} {
  const parent = join(repoRoot, 'node_modules', '.cache', 'nessy-gates')
  mkdirSync(parent, { recursive: true })
  const absolute = mkdtempSync(join(parent, `${prefix}-`))
  return { absolute, fromRepoRoot: relative(repoRoot, absolute) }
}
