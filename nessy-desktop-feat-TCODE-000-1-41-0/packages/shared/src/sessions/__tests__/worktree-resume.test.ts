import { describe, expect, it } from 'bun:test';
import { resolveWorktreeAwareWorkingDirectory } from '../worktree-resume.ts';

const repoRoot = '/projects/app';
const worktree = '/projects/.nessy-worktrees/app/lease-1';
const present = () => true;
const missing = () => false;

describe('resolveWorktreeAwareWorkingDirectory', () => {
  it('resumes in the worktree the session entered', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: present,
    })).toBe(worktree);
  });

  it('resumes in the launch directory when the worktree is gone, without failing', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: missing,
    })).toBe(repoRoot);
  });

  it('starts a fork in the launch directory even when the worktree is intact', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: present, fork: true,
    })).toBe(repoRoot);
  });

  it('leaves an ordinary working directory alone, present or not', () => {
    // A plain `/cd` target is not a worktree, so a missing one is a different
    // problem and must not be silently rewritten to the launch directory.
    for (const exists of [present, missing]) {
      expect(resolveWorktreeAwareWorkingDirectory({
        workingDirectory: '/somewhere/else', sdkCwd: repoRoot, exists,
      })).toBe('/somewhere/else');
      expect(resolveWorktreeAwareWorkingDirectory({
        workingDirectory: repoRoot, sdkCwd: repoRoot, exists,
      })).toBe(repoRoot);
    }
  });

  it('leaves a worktree of a DIFFERENT repository alone', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: '/projects/.nessy-worktrees/other/lease-1',
      sdkCwd: repoRoot,
      exists: missing,
    })).toBe('/projects/.nessy-worktrees/other/lease-1');
  });

  it('passes through when there is nothing recorded or nothing to fall back to', () => {
    expect(resolveWorktreeAwareWorkingDirectory({ sdkCwd: repoRoot, exists: missing })).toBeUndefined();
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, exists: missing,
    })).toBe(worktree);
  });
});

/**
 * P6.324 (a) — a recorded worktree that still exists but is no longer a worktree
 * of its own.
 *
 * Resuming INTO it would put a session that believes it is isolated in the
 * user's real tree, so it takes the same exit the deleted worktree takes — the
 * launch directory, with the directory left on disk and untouched. The screen's
 * answer is injected for the same reason `exists` is.
 */
describe('resolveWorktreeAwareWorkingDirectory identity refusal', () => {
  const identifyAs = (toplevel: string | null) => () => ({ repoRoot, toplevel });

  it('resumes at the launch directory when the recorded worktree IS the main checkout', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: present, identify: identifyAs(repoRoot),
    })).toBe(repoRoot);
  });

  it('does the same for a directory belonging to another checkout', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: present, identify: identifyAs('/projects/other'),
    })).toBe(repoRoot);
  });

  it('resumes in the worktree when git agrees it is its own — the positive control', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: present, identify: identifyAs(worktree),
    })).toBe(worktree);
  });

  it('a caller that cannot ask git gets exactly the previous behaviour', () => {
    expect(resolveWorktreeAwareWorkingDirectory({
      workingDirectory: worktree, sdkCwd: repoRoot, exists: present,
    })).toBe(worktree);
  });
});
