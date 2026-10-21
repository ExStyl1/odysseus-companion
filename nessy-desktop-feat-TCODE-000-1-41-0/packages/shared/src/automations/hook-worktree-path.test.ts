import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeWorktreeIdentityRefusal,
  parseCommandHookWorktreePath,
  resolveHookWorktreePath,
  screenWorktreeIdentity,
  stripAnsi,
} from './hook-worktree-path.ts';

const ESC = String.fromCharCode(27);

describe('WorktreeCreate command-hook path parse', () => {
  it('takes the last non-empty line, ANSI-stripped', () => {
    expect(parseCommandHookWorktreePath('preparing\n\n/repo/worktrees/a\n\n')).toBe('/repo/worktrees/a');
    expect(parseCommandHookWorktreePath(`${ESC}[32m/repo/worktrees/a${ESC}[0m\n`)).toBe('/repo/worktrees/a');
    expect(parseCommandHookWorktreePath('first\nsecond')).toBe('second');
    expect(parseCommandHookWorktreePath('   \n\n')).toBeUndefined();
    expect(stripAnsi(`${ESC}[1mbold${ESC}[0m`)).toBe('bold');
  });
});

describe('WorktreeCreate path screen', () => {
  it('accepts a path inside the repo root', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-screen-')));
    try {
      expect(resolveHookWorktreePath(join(dir, 'worktrees', 'agent-1'), { repoRoot: dir }))
        .toEqual({ path: join(dir, 'worktrees', 'agent-1') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses relative segments, non-absolute paths and escapes', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-screen-')));
    try {
      // Documented refusal: `.`/`..` segments, checked before any normalisation.
      expect(resolveHookWorktreePath(`${dir}/../escape`, { repoRoot: dir }))
        .toEqual({ refusedReason: 'relative-segment' });
      expect(resolveHookWorktreePath(`${dir}/./here`, { repoRoot: dir }))
        .toEqual({ refusedReason: 'relative-segment' });
      expect(resolveHookWorktreePath('worktrees/agent-1', { repoRoot: dir }))
        .toEqual({ refusedReason: 'not-absolute' });
      expect(resolveHookWorktreePath('', { repoRoot: dir }))
        .toEqual({ refusedReason: 'not-absolute' });
      expect(resolveHookWorktreePath('/etc/passwd', { repoRoot: dir }))
        .toEqual({ refusedReason: 'outside-repo' });
      // The root itself is not a worktree path.
      expect(resolveHookWorktreePath(dir, { repoRoot: dir }))
        .toEqual({ refusedReason: 'outside-repo' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path that reaches its target through a symlink below the root', () => {
    // "a symlink committed to the repository could redirect the worktree outside it"
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-symlink-')));
    try {
      const outside = join(dir, 'outside');
      const repo = join(dir, 'repo');
      mkdirSync(outside, { recursive: true });
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(outside, 'marker'), 'x');
      symlinkSync(outside, join(repo, 'linked'));

      expect(resolveHookWorktreePath(join(repo, 'linked', 'agent-1'), { repoRoot: repo }))
        .toEqual({ refusedReason: 'symlink-below-root' });
      // A real directory at the same depth still passes.
      mkdirSync(join(repo, 'real'), { recursive: true });
      expect(resolveHookWorktreePath(join(repo, 'real', 'agent-1'), { repoRoot: repo }))
        .toEqual({ path: join(repo, 'real', 'agent-1') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P6.324 (a) — the identity screen: git decides what a directory IS, and one
 * that resolves back into the main checkout is refused.
 *
 * The path screen above answers whether a path is ALLOWED to be a worktree of
 * this repository. It says nothing about what git thinks the directory already
 * is — and that is the dangerous half: a `git reset --hard` inside a "worktree"
 * that is really the user's own checkout acts on their real tree.
 *
 * Pure, and HANDED git's answer, for the same reason
 * `resolveWorktreeAwareWorkingDirectory` is handed `exists`: what needs testing
 * is the decision, not the subprocess.
 */
describe('screenWorktreeIdentity', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-identity-')));
  const repoRoot = join(root, 'repo');
  const worktree = join(root, 'worktrees', 'w1');
  const elsewhere = join(root, 'elsewhere');
  for (const path of [repoRoot, worktree, elsewhere]) mkdirSync(path, { recursive: true });

  it('accepts a directory git calls its own toplevel', () => {
    // What a genuine linked worktree answers: its own path. Only
    // `--git-common-dir` points back at the main repository, which is normal and
    // is why this screen deliberately does not read that.
    expect(screenWorktreeIdentity({ candidatePath: worktree, repoRoot, toplevel: worktree }))
      .toEqual({ ok: true });
  });

  it('refuses the main checkout itself', () => {
    expect(screenWorktreeIdentity({ candidatePath: repoRoot, repoRoot, toplevel: repoRoot }))
      .toEqual({ ok: false, refusedReason: 'is-the-main-checkout' });
  });

  it('refuses a directory belonging to a different checkout', () => {
    // A `.git` FILE pointing elsewhere, or a `core.worktree` redirect: the
    // directory sits in one place and git answers with another.
    expect(screenWorktreeIdentity({ candidatePath: worktree, repoRoot, toplevel: elsewhere }))
      .toEqual({ ok: false, refusedReason: 'redirected-elsewhere' });
  });

  it('refuses when git answered nothing at all', () => {
    expect(screenWorktreeIdentity({ candidatePath: worktree, repoRoot, toplevel: null }))
      .toEqual({ ok: false, refusedReason: 'not-a-worktree' });
    // Empty is the same answer as absent, never an accidental pass.
    expect(screenWorktreeIdentity({ candidatePath: worktree, repoRoot, toplevel: '   ' }))
      .toEqual({ ok: false, refusedReason: 'not-a-worktree' });
  });

  it('every refusal has a sentence, so callers say the same thing', () => {
    for (const reason of ['not-a-worktree', 'is-the-main-checkout', 'redirected-elsewhere'] as const) {
      expect(describeWorktreeIdentityRefusal(reason).length).toBeGreaterThan(10);
    }
  });
});
