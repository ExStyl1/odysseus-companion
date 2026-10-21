/**
 * What the working tree looks like, as a fact the judge can weigh
 * (P6.203, denominator A31).
 *
 * ## Why it exists
 *
 * The guardian consult context carried `toolName`, `input`, `cwd`,
 * `workspaceRoot`, `guardian`, the mode and its version, and nothing else — so
 * the judge ruled on `git checkout .` or `git clean -fd` without knowing whether
 * anything would be lost by it. `showUntrackedFiles` scored 0 repo-wide.
 *
 * ## Native mechanism
 *
 * None on any runtime, confirmed at HEAD: our guardian consult context is ours,
 * claude's classifier is inside the closed binary (and silenced by A1), and
 * codex's `[auto_review].policy` is an operator config blob with no session
 * state in it. Host-side, once, for the one runtime that has a judge.
 *
 * ## `-unormal` is the clause, not a flag
 *
 * `git status --porcelain` honours `status.showUntrackedFiles`, so on a repo
 * configured `no` the untracked half of the answer silently disappears — and
 * untracked files are exactly what a destructive command destroys without a
 * reflog to recover them from. `-unormal` overrides that configuration for this
 * one read. It is the clause a naive implementation drops, and the reason the
 * flag is spelled out here rather than left to the default.
 *
 * ## Bounded, and the bound is the point
 *
 * A working tree can hold thousands of entries and this text is prepended to
 * every borderline consult. So the judge gets three COUNTS — which is what a
 * "would this lose work" judgement actually needs — plus a bounded sample of
 * paths for the cases where the identity of the file matters, and an explicit
 * statement when the sample is short of the whole. Counts are never truncated;
 * only the sample is.
 */

/** The three counts plus a bounded sample, as the judge is told them. */
export interface WorkingTreeSummary {
  staged: number;
  modified: number;
  untracked: number;
  /** Up to {@link WORKING_TREE_SAMPLE_LIMIT} paths, staged first. */
  sample: string[];
  /** True when the tree holds more entries than `sample` names. */
  truncated: boolean;
}

/** How many paths reach the judge. Small on purpose — see the docblock. */
export const WORKING_TREE_SAMPLE_LIMIT = 20;

/** The exact argv. Exported so the test cannot drift from the caller. */
export const GIT_STATUS_ARGV = ['status', '--porcelain', '-unormal'] as const;

/**
 * Parse `git status --porcelain -unormal` into the summary above.
 *
 * Porcelain v1 format: two status characters, a space, then the path. The FIRST
 * character is the index (staged) state and the SECOND is the worktree state, so
 * one entry can be both staged and modified — `MM` is a file with staged changes
 * and further unstaged ones — and both counters advance for it. That is not
 * double counting: "2 staged, 1 modified" and "1 staged, 0 modified" describe
 * genuinely different trees, and collapsing them would hide the unstaged half
 * that a checkout would discard.
 *
 * `??` is untracked and `!!` is ignored; ignored entries are dropped, because
 * nothing here is asked to rule on build output. A renamed entry's `->` arrow is
 * kept verbatim in the sample: the judge reads prose, and "old -> new" is the
 * honest rendering of what happened.
 */
export function summarizeGitStatusPorcelain(
  output: string,
  limit: number = WORKING_TREE_SAMPLE_LIMIT,
): WorkingTreeSummary {
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  const sample: string[] = [];
  let total = 0;

  for (const raw of output.split('\n')) {
    // A porcelain line is at least "XY " plus one path character.
    if (raw.length < 4) continue;
    const index = raw[0]!;
    const worktree = raw[1]!;
    if (index === '!' && worktree === '!') continue;
    const path = raw.slice(3).trim();
    if (!path) continue;

    total += 1;
    if (index === '?' && worktree === '?') {
      untracked += 1;
    } else {
      if (index !== ' ' && index !== '?') staged += 1;
      if (worktree !== ' ' && worktree !== '?') modified += 1;
    }
    if (sample.length < limit) sample.push(`${index}${worktree} ${path}`);
  }

  return { staged, modified, untracked, sample, truncated: total > sample.length };
}

/** A working tree with nothing in it is reported as such, never as absent. */
export function isCleanWorkingTree(summary: WorkingTreeSummary): boolean {
  return summary.staged === 0 && summary.modified === 0 && summary.untracked === 0;
}

/**
 * Read the summary for `cwd`, memoised for {@link WORKING_TREE_TTL_MS}.
 *
 * The memo is what makes this affordable: a single turn can raise many
 * borderline consults, and a `git status` per consult would put a subprocess
 * spawn in front of every gated tool call. A couple of seconds is short enough
 * that a judge never rules on a tree the previous tool call already changed
 * beyond recognition, and long enough that a burst inside one turn costs one
 * spawn.
 *
 * `run` is injected: `packages/shared` has no subprocess idiom of its own, and
 * the caller (`pi-agent.ts`) already lazily imports node modules where it needs
 * them. A throw, a non-zero exit, a timeout, or a directory that is not a git
 * repository all yield `undefined` — the judge then sees no working-tree line at
 * all, which is the honest answer and the one the prompt already renders for an
 * absent fact.
 */
export const WORKING_TREE_TTL_MS = 2_000;

interface MemoEntry { at: number; value: WorkingTreeSummary | undefined }

const memo = new Map<string, MemoEntry>();

export async function readWorkingTreeSummary(
  cwd: string,
  run: (argv: readonly string[], cwd: string) => Promise<string>,
  now: () => number = Date.now,
): Promise<WorkingTreeSummary | undefined> {
  const cached = memo.get(cwd);
  const at = now();
  if (cached && at - cached.at < WORKING_TREE_TTL_MS) return cached.value;

  let value: WorkingTreeSummary | undefined;
  try {
    value = summarizeGitStatusPorcelain(await run(GIT_STATUS_ARGV, cwd));
  } catch {
    value = undefined;
  }
  memo.set(cwd, { at, value });
  return value;
}

/** Test seam — the memo is module-scoped, so a suite must be able to clear it. */
export function clearWorkingTreeMemo(): void {
  memo.clear();
}
