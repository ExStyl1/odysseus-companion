/**
 * P6.64 (ledger A1) — the judge is told which branch it is on, and whether that
 * branch is the protected/default one.
 *
 * The row's own clause is why this suite drives `buildGuardianFacts` — THE
 * production builder both `pi-agent.ts` consult sites now call — rather than a
 * fixture literal. `gitBranch` and `protectedBranch` were declared in
 * `GuardianSessionFacts`, rendered by `describeFacts`, and set by nothing but
 * two test fixtures; a suite that fed the renderer another literal would have
 * gone green on exactly that defect.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  buildGuardianFacts,
  parseGitBranchFacts,
  readBranchFacts,
  clearBranchFactsMemo,
  GIT_BRANCH_ARGV,
} from '../pi-harness/guardian-facts.ts';
import { clearWorkingTreeMemo } from '../pi-harness/working-tree-facts.ts';
import { buildGuardianJudgeTask } from '../../prompts/guardian.ts';

/** A runner that answers the branch argv and nothing else (empty tree elsewhere). */
function gitStub(branchOutput: string | Error, seen?: { argv: string[][] }) {
  return async (argv: readonly string[], _cwd: string) => {
    seen?.argv.push([...argv]);
    if (argv[0] !== 'rev-parse') return '';
    if (branchOutput instanceof Error) throw branchOutput;
    return branchOutput;
  };
}

beforeEach(() => { clearBranchFactsMemo(); clearWorkingTreeMemo() });

describe('parseGitBranchFacts (P6.64 A1)', () => {
  it('marks the repository default branch as protected', () => {
    expect(parseGitBranchFacts('master\norigin/master\n'))
      .toEqual({ gitBranch: 'master', protectedBranch: true });
  });

  it('marks any other branch as a feature branch', () => {
    expect(parseGitBranchFacts('feat/TCODE-000\norigin/master\n'))
      .toEqual({ gitBranch: 'feat/TCODE-000', protectedBranch: false });
  });

  it('a detached HEAD is NOT a branch — both fields stay absent', () => {
    expect(parseGitBranchFacts('HEAD\norigin/master\n')).toBeUndefined();
  });

  it('an unresolved origin/HEAD yields NEITHER field, never a guessed "feature branch"', () => {
    // `rev-parse` echoes the ref name it could not resolve. Rendering the branch
    // without knowing the default would tell the judge that a protected branch
    // is a feature branch — the one direction that matters.
    expect(parseGitBranchFacts('master\nrefs/remotes/origin/HEAD\n')).toBeUndefined();
    expect(parseGitBranchFacts('master\n')).toBeUndefined();
  });
});

describe('buildGuardianFacts — the PRODUCTION facts builder', () => {
  it('asks git for both halves in one spawn, and hands the judge both fields', async () => {
    const seen: { argv: string[][] } = { argv: [] };
    const facts = await buildGuardianFacts({
      mode: 'auto',
      cwd: '/repo',
      workspaceRoot: '/repo',
      run: gitStub('feat/TCODE-000\norigin/master\n', seen),
    });
    expect(seen.argv).toContainEqual([...GIT_BRANCH_ARGV]);
    expect(facts.gitBranch).toBe('feat/TCODE-000');
    expect(facts.protectedBranch).toBe(false);
    // The builder still carries what it carried before (P6.203).
    expect(facts.mode).toBe('auto');
    expect(facts.workspaceRoot).toBe('/repo');
  });

  it('renders the row\'s two sentences through the real prompt', async () => {
    const onDefault = await buildGuardianFacts({
      mode: 'auto', cwd: '/repo', run: gitStub('master\norigin/master\n'),
    });
    expect(buildGuardianJudgeTask({
      action: { command: 'git push --force' }, trustedIntent: 'ship', facts: onDefault,
    })).toContain('Git branch: master (PROTECTED/default branch)');

    clearBranchFactsMemo();
    const onFeature = await buildGuardianFacts({
      mode: 'auto', cwd: '/repo', run: gitStub('feat/TCODE-000\norigin/master\n'),
    });
    expect(buildGuardianJudgeTask({
      action: { command: 'git push --force' }, trustedIntent: 'ship', facts: onFeature,
    })).toContain('Git branch: feat/TCODE-000 (feature branch)');
  });

  it('NEGATIVE — a failed read omits the line entirely, as today', async () => {
    const facts = await buildGuardianFacts({
      mode: 'auto', cwd: '/nowhere',
      run: gitStub(new Error('fatal: not a git repository')),
    });
    expect(facts.gitBranch).toBeUndefined();
    expect(facts.protectedBranch).toBeUndefined();
    const task = buildGuardianJudgeTask({
      action: { command: 'git push --force' }, trustedIntent: 'ship', facts,
    });
    expect(task).not.toContain('Git branch');
    // Positive control: the block the line would have joined is really there.
    expect(task).toContain('Permission mode: auto');
  });

  it('memoises per cwd, so a burst of consults in one turn costs one spawn', async () => {
    let calls = 0;
    const run = async (argv: readonly string[]) => {
      if (argv[0] === 'rev-parse') calls += 1;
      return 'master\norigin/master\n';
    };
    const now = () => 1_000;
    await readBranchFacts('/repo', run, now);
    await readBranchFacts('/repo', run, now);
    expect(calls).toBe(1);
    await readBranchFacts('/other', run, now);
    expect(calls).toBe(2);
  });
});
