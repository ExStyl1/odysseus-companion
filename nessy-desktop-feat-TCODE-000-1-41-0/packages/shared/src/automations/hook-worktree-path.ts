/**
 * `WorktreeCreate` path return (R9) — the fifth decision pattern.
 *
 * hooks.md: the event's hook returns the path the worktree should use. A
 * `command` hook returns it as the last non-empty stdout line, ANSI-stripped; an
 * `http` hook returns it as `hookSpecificOutput.worktreePath`. An `mcp_tool` hook
 * is permitted on the event by the type table but has NO documented return
 * channel, so it can never contribute a path.
 *
 * Security screen (v2.1.216+): the returned path is refused when it contains
 * `.`/`..` segments, and when reaching it traverses a symlink below the repo
 * root — "because a symlink committed to the repository could redirect the
 * worktree outside it".
 */

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** CSI sequences and OSC strings; enough to clean a path off a decorated stdout. */
const ANSI_PATTERN = new RegExp(
  '\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)',
  'g',
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/** A command hook's worktree path: the LAST non-empty stdout line, ANSI-stripped. */
export function parseCommandHookWorktreePath(stdout: string): string | undefined {
  const lines = stripAnsi(stdout).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.at(-1);
}

export type HookWorktreePathResult =
  | { path: string }
  | { refusedReason: 'not-absolute' | 'relative-segment' | 'outside-repo' | 'symlink-below-root' };

function isInsideRelative(rel: string): boolean {
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function realpathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/**
 * Validate a hook-returned worktree path against the documented refusals.
 * `repoRoot` is the repository the worktree belongs to; the path must resolve
 * inside it without passing through a symlink under it.
 */
export function resolveHookWorktreePath(
  candidate: string,
  options: { repoRoot: string },
): HookWorktreePathResult {
  const raw = candidate.trim();
  if (!raw || !isAbsolute(raw)) return { refusedReason: 'not-absolute' };
  // Checked on the RAW value: `resolve()` collapses `..` and would hide exactly
  // the traversal this screen exists to catch.
  if (raw.split(/[\\/]+/).some(segment => segment === '.' || segment === '..')) {
    return { refusedReason: 'relative-segment' };
  }
  const target = resolve(raw);
  // The root itself may legitimately be a symlink (macOS `/tmp`), so judge
  // containment against both spellings before walking for symlinks below it.
  const rootPlain = resolve(options.repoRoot);
  const rootReal = realpathOrSelf(options.repoRoot);
  const fromReal = relative(rootReal, target);
  const fromPlain = relative(rootPlain, target);
  const base = isInsideRelative(fromReal)
    ? { root: rootReal, rel: fromReal }
    : isInsideRelative(fromPlain) ? { root: rootPlain, rel: fromPlain } : undefined;
  if (!base) return { refusedReason: 'outside-repo' };

  let cursor = base.root;
  for (const segment of base.rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return { refusedReason: 'symlink-below-root' };
    } catch {
      // Missing is expected: the worktree's own leaf does not exist yet.
    }
  }
  return { path: target };
}


/**
 * P6.324 (a) — the IDENTITY screen, the half the path screen above cannot do.
 *
 * `resolveHookWorktreePath` answers "is this path allowed to be a worktree of
 * this repository": absolute, no `.`/`..` segment, inside the repo root, no
 * symlink below it. It says nothing about what git thinks the directory IS —
 * and that is the dangerous half. A directory whose `.git` resolves back into
 * the MAIN repository is not an isolated checkout at all: a `git reset --hard`
 * or a branch switch inside a supposedly isolated worktree then acts on the
 * user's real tree.
 *
 * git supplies the answer and we do not invent one: `git -C <path> rev-parse
 * --show-toplevel` names the checkout a directory belongs to. Three refusals
 * fall out of comparing it with the two paths we already know, and each is a
 * different real shape:
 *
 * - `not-a-worktree` — git could not answer at all (no repository there, or the
 *   command failed). For ENTER and RESUME that is a refusal; a CREATE caller
 *   simply does not run the probe on a path that does not exist yet;
 * - `is-the-main-checkout` — the toplevel IS the repository root. This is the
 *   defect in its plainest form: the "worktree" is the user's own working tree;
 *   - `redirected-elsewhere` — the toplevel is neither the main root nor the
 *   candidate itself, which is what a `.git` FILE pointing somewhere else or a
 *   `core.worktree` redirect produces. A genuine linked worktree does NOT trip
 *   this: its `--show-toplevel` is its own directory (only `--git-common-dir`
 *   points back at the main repository, which is normal and is why this screen
 *   deliberately does not read that).
 *
 * Pure, and given git's answer rather than running it, for the same reason
 * `resolveWorktreeAwareWorkingDirectory` injects `exists`: the decision is what
 * needs testing, not the subprocess.
 */
export type WorktreeIdentityRefusal =
  | 'not-a-worktree'
  | 'is-the-main-checkout'
  | 'redirected-elsewhere';

export interface WorktreeIdentityScreenInput {
  /** The directory being used, or about to be used, as a worktree. */
  candidatePath: string;
  /** The repository the worktree belongs to. */
  repoRoot: string;
  /**
   * `git -C <candidatePath> rev-parse --show-toplevel`, trimmed. `null` when the
   * command failed or answered nothing — which is a refusal, never a pass.
   */
  toplevel: string | null;
}

export function screenWorktreeIdentity(
  input: WorktreeIdentityScreenInput,
): { ok: true } | { ok: false; refusedReason: WorktreeIdentityRefusal } {
  const toplevel = input.toplevel?.trim();
  if (!toplevel) return { ok: false, refusedReason: 'not-a-worktree' };
  const answered = realpathOrSelf(toplevel);
  if (answered === realpathOrSelf(input.repoRoot)) {
    return { ok: false, refusedReason: 'is-the-main-checkout' };
  }
  if (answered !== realpathOrSelf(input.candidatePath)) {
    return { ok: false, refusedReason: 'redirected-elsewhere' };
  }
  return { ok: true };
}

/** The sentence a refused identity gets, so every caller says the same thing. */
export function describeWorktreeIdentityRefusal(reason: WorktreeIdentityRefusal): string {
  switch (reason) {
    case 'is-the-main-checkout':
      return 'that directory is the repository itself, not an isolated worktree';
    case 'redirected-elsewhere':
      return 'that directory belongs to a different checkout than the one it sits in';
    case 'not-a-worktree':
      return 'git does not recognise that directory as a worktree';
  }
}
