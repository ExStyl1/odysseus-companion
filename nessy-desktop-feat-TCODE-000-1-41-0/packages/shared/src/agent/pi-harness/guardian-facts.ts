/**
 * The guardian consult's `facts` block, built once for both consult sites
 * (P6.64, ledger A1).
 *
 * ## Why it exists
 *
 * `GuardianSessionFacts` declares `gitBranch` and `protectedBranch`, and
 * `describeFacts` renders `Git branch: <name> (PROTECTED/default branch)` or
 * `(feature branch)` off them — but until this module no production site set
 * either one. The only writers in the tree were two test fixtures, so the
 * branch clause of the judge's own policy adjudicated a permanently undefined
 * field and the line never rendered at all. Both live `facts` literals
 * (`pi-agent.ts`, the auto/plan borderline consult and the bypass deny-net)
 * emitted `mode`, `workspaceRoot` and the working tree, and nothing else.
 *
 * ## Native mechanism, asked and answered
 *
 * Ours, host-side, and there is nothing to enable in any runtime. The consult
 * context is the host's own; claude's classifier lives inside the closed binary
 * (and is silenced by A1); codex's `[auto_review].policy` is an operator config
 * blob carrying no session state. Pi is the one runtime with a judge, so this
 * is case (3) of native-first for a reason that is recorded rather than
 * assumed: no runtime publishes a branch-fact builder.
 *
 * ## What *protected* means here, and the alternative that was rejected
 *
 * The prompt's own words define it: `(PROTECTED/default branch)`. So protected
 * is **this repository's default branch**, resolved from
 * `refs/remotes/origin/HEAD` — the same ref `SessionManager`'s worktree base
 * selection already treats as the repository's default. `init.defaultBranch`
 * was considered and REJECTED: it is the branch name *new* repositories get on
 * this machine, not this repository's default, so on a repo whose default is
 * `master` it would have told the judge that `main` is protected and that
 * `master` is a feature branch. That is the shape of a wrong answer that looks
 * obviously right.
 *
 * ## Both fields, or neither
 *
 * The rendering is binary, and the dangerous direction is telling the judge a
 * protected branch is a feature branch. So the branch facts are all-or-nothing:
 * unless BOTH the current branch and the default branch resolve, the fields
 * stay absent and no `Git branch:` line renders — which is exactly today's
 * behaviour. A detached HEAD, a directory that is not a repository, a
 * repository with no cached `origin/HEAD`, git missing, a timeout: every one of
 * them omits the line rather than guessing at protectedness.
 */
import type { GuardianSessionFacts } from '../../prompts/guardian.ts';
import { readWorkingTreeSummary } from './working-tree-facts.ts';

/** How a git read is performed. Injected — `packages/shared` owns no subprocess idiom. */
export type GuardianGitRunner = (argv: readonly string[], cwd: string) => Promise<string>;

/**
 * The exact argv. Exported so the test cannot drift from the caller.
 *
 * ONE spawn answers both halves: `--abbrev-ref` prints the current branch on
 * the first line and the abbreviated `origin/HEAD` (e.g. `origin/master`) on
 * the second. A repository with no cached `origin/HEAD` makes `rev-parse` exit
 * non-zero, which the runner turns into a rejection and this module turns into
 * "no branch facts" — the honest answer.
 */
export const GIT_BRANCH_ARGV = ['rev-parse', '--abbrev-ref', 'HEAD', 'refs/remotes/origin/HEAD'] as const;

/** Both branch fields, produced together or not at all. */
export interface GuardianBranchFacts {
  gitBranch: string;
  protectedBranch: boolean;
}

/**
 * Parse {@link GIT_BRANCH_ARGV}'s two lines.
 *
 * `HEAD` on the first line is a detached HEAD, which is not a branch and must
 * not be rendered as one. An unresolved second line (the literal ref name, what
 * `rev-parse` echoes when it cannot resolve it) means the default branch is
 * unknown, and an unknown default cannot decide protectedness.
 */
export function parseGitBranchFacts(output: string): GuardianBranchFacts | undefined {
  const [branchLine, defaultLine] = output.split('\n');
  const gitBranch = branchLine?.trim();
  if (!gitBranch || gitBranch === 'HEAD') return undefined;
  const rawDefault = defaultLine?.trim();
  if (!rawDefault || rawDefault === 'refs/remotes/origin/HEAD') return undefined;
  const defaultBranch = rawDefault.startsWith('origin/')
    ? rawDefault.slice('origin/'.length)
    : rawDefault;
  if (!defaultBranch) return undefined;
  return { gitBranch, protectedBranch: gitBranch === defaultBranch };
}

/**
 * Memoised per cwd, for the same reason the working-tree read is: one turn can
 * raise many borderline consults, and a branch does not change between two of
 * them often enough to pay a subprocess spawn each time.
 */
export const BRANCH_FACTS_TTL_MS = 2_000;

interface MemoEntry { at: number; value: GuardianBranchFacts | undefined }

const memo = new Map<string, MemoEntry>();

export async function readBranchFacts(
  cwd: string,
  run: GuardianGitRunner,
  now: () => number = Date.now,
): Promise<GuardianBranchFacts | undefined> {
  const cached = memo.get(cwd);
  const at = now();
  if (cached && at - cached.at < BRANCH_FACTS_TTL_MS) return cached.value;

  let value: GuardianBranchFacts | undefined;
  try {
    value = parseGitBranchFacts(await run(GIT_BRANCH_ARGV, cwd));
  } catch {
    value = undefined;
  }
  memo.set(cwd, { at, value });
  return value;
}

/** Test seam — the memo is module-scoped, so a suite must be able to clear it. */
export function clearBranchFactsMemo(): void {
  memo.clear();
}

/**
 * THE production `facts` builder: the one place both consult sites get their
 * facts from, so a fact added here reaches the judge on every path rather than
 * on whichever literal was remembered.
 *
 * The two git reads run concurrently — they are independent, both memoised, and
 * both sit in front of every borderline tool call.
 */
export async function buildGuardianFacts(input: {
  mode: string;
  cwd: string;
  workspaceRoot?: string;
  run: GuardianGitRunner;
  now?: () => number;
}): Promise<GuardianSessionFacts> {
  const [workingTree, branch] = await Promise.all([
    readWorkingTreeSummary(input.cwd, input.run, input.now),
    readBranchFacts(input.cwd, input.run, input.now),
  ]);
  return {
    mode: input.mode,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(branch ?? {}),
    ...(workingTree ? { workingTree } : {}),
  };
}
