/**
 * P6.203 (A31) — the judge is told what the working tree holds.
 *
 * Two units, one contract: the parse decides what the counts MEAN, and
 * `describeFacts` decides what the judge reads. Both are pinned here, because a
 * correct parse rendered as silence is the same defect as a wrong parse.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  summarizeGitStatusPorcelain,
  readWorkingTreeSummary,
  clearWorkingTreeMemo,
  isCleanWorkingTree,
  GIT_STATUS_ARGV,
  WORKING_TREE_SAMPLE_LIMIT,
} from '../pi-harness/working-tree-facts.ts';
import { buildGuardianJudgeTask } from '../../prompts/guardian.ts';

describe('summarizeGitStatusPorcelain (P6.203 A31)', () => {
  it('separates the three states the row names', () => {
    const summary = summarizeGitStatusPorcelain(
      'M  staged.ts\n M modified.ts\n?? untracked.ts\n',
    );
    expect(summary).toMatchObject({ staged: 1, modified: 1, untracked: 1, truncated: false });
  });

  it('counts a partially-staged file in BOTH columns, which is not double counting', () => {
    // `MM` is staged changes plus further unstaged ones. "1 staged, 1 modified"
    // and "1 staged, 0 modified" are genuinely different trees, and collapsing
    // them would hide the unstaged half a checkout would discard.
    const summary = summarizeGitStatusPorcelain('MM both.ts\n');
    expect(summary.staged).toBe(1);
    expect(summary.modified).toBe(1);
  });

  it('drops ignored entries — nothing here rules on build output', () => {
    const summary = summarizeGitStatusPorcelain('!! dist/bundle.js\n M real.ts\n');
    expect(summary).toMatchObject({ staged: 0, modified: 1, untracked: 0 });
    expect(summary.sample).toEqual([' M real.ts']);
  });

  it('bounds the sample and SAYS it is bounded, while the counts stay whole', () => {
    const lines = Array.from({ length: WORKING_TREE_SAMPLE_LIMIT + 5 },
      (_, i) => `?? file-${i}.ts`).join('\n');
    const summary = summarizeGitStatusPorcelain(lines);
    expect(summary.untracked).toBe(WORKING_TREE_SAMPLE_LIMIT + 5);
    expect(summary.sample).toHaveLength(WORKING_TREE_SAMPLE_LIMIT);
    expect(summary.truncated).toBe(true);
  });

  it('keeps a rename verbatim — the judge reads prose', () => {
    expect(summarizeGitStatusPorcelain('R  old.ts -> new.ts\n').sample)
      .toEqual(['R  old.ts -> new.ts']);
  });

  it('CONTROL — an empty tree is clean, not absent', () => {
    const summary = summarizeGitStatusPorcelain('');
    expect(isCleanWorkingTree(summary)).toBe(true);
    expect(summary.truncated).toBe(false);
  });
});

describe('readWorkingTreeSummary — the bounds that make it affordable', () => {
  beforeEach(() => { clearWorkingTreeMemo() });

  it('asks git for -unormal, so untracked survives status.showUntrackedFiles=no', () => {
    // The clause a naive implementation drops: `--porcelain` alone honours the
    // repo's own configuration, and on a repo set to `no` the untracked half
    // silently disappears — which is exactly the work a destructive command
    // destroys with no reflog to recover it from.
    let seen: readonly string[] | undefined
    return readWorkingTreeSummary('/repo', async argv => { seen = argv; return '' })
      .then(() => {
        expect(seen).toEqual(GIT_STATUS_ARGV)
        expect(seen).toContain('-unormal')
      })
  });

  it('memoises per cwd, so a burst of consults in one turn costs one spawn', async () => {
    let calls = 0;
    const run = async () => { calls += 1; return ' M a.ts\n' };
    const now = () => 1_000;
    await readWorkingTreeSummary('/repo', run, now);
    await readWorkingTreeSummary('/repo', run, now);
    expect(calls).toBe(1);
    // A different tree is a different answer, never the neighbour's.
    await readWorkingTreeSummary('/other', run, now);
    expect(calls).toBe(2);
  });

  it('re-reads once the TTL has passed', async () => {
    let calls = 0;
    const run = async () => { calls += 1; return '' };
    await readWorkingTreeSummary('/repo', run, () => 1_000);
    await readWorkingTreeSummary('/repo', run, () => 99_000);
    expect(calls).toBe(2);
  });

  it('a failure is UNDEFINED, never a clean tree — the one error that would matter', async () => {
    const summary = await readWorkingTreeSummary('/not-a-repo', async () => {
      throw new Error('fatal: not a git repository');
    });
    expect(summary).toBeUndefined();
  });
});

describe('the judge actually reads it (P6.203 A31)', () => {
  const action = { kind: 'bash' as const, command: 'git checkout .' };

  it('names the untracked work as unrecoverable', () => {
    const task = buildGuardianJudgeTask({
      action,
      trustedIntent: 'clean up',
      facts: {
        mode: 'auto',
        workingTree: { staged: 1, modified: 2, untracked: 3, sample: [' M a.ts'], truncated: false },
      },
    });
    expect(task).toContain('1 staged, 2 modified, 3 untracked');
    expect(task).toContain('NOT recoverable from git');
    expect(task).toContain(' M a.ts');
  });

  it('says a clean tree is clean — "nothing to lose" is a fact, not silence', () => {
    const task = buildGuardianJudgeTask({
      action,
      trustedIntent: 'clean up',
      facts: {
        mode: 'auto',
        workingTree: { staged: 0, modified: 0, untracked: 0, sample: [], truncated: false },
      },
    });
    expect(task).toContain('Working tree: clean');
  });

  it('CONTROL — an ABSENT working tree renders no line at all', () => {
    const task = buildGuardianJudgeTask({ action, trustedIntent: 'clean up', facts: { mode: 'auto' } });
    expect(task).not.toContain('Working tree');
    // Positive control: the block the line would have joined is really there.
    expect(task).toContain('Permission mode: auto');
  });

  it('marks a truncated sample so the judge is not told a big tree is small', () => {
    const task = buildGuardianJudgeTask({
      action,
      trustedIntent: 'clean up',
      facts: {
        mode: 'auto',
        workingTree: { staged: 0, modified: 40, untracked: 0, sample: [' M a.ts'], truncated: true },
      },
    });
    expect(task).toContain('more entries not listed');
    expect(task).toContain('40 modified');
  });
});
