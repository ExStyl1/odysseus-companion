/**
 * P6.278 — `/diff`: what has changed in the working tree, and the honest answer
 * about a turn's own edits.
 *
 * ## The row, and what is and is not owed here
 *
 * *"There is no diff view for uncommitted changes or for a turn's own edits, on
 * any runtime"*, verdicts pi `partial` / claude `absent` / codex `absent`. Its
 * native-mechanism clause is confirmed at HEAD and is worth restating because
 * it decides the shape: *"Host-side: a diff renderer already exists and the
 * per-turn file-edit history is what F1's checkpoint producer writes. Neither
 * claude's SDK nor codex exposes a turn-diff API to a host."*
 *
 * So there is nothing native to enable on any of the three, and the host is the
 * only place the answer can come from. Two halves, and they are not equally
 * available:
 *
 * - **The working tree.** Uniform by construction — it is `git`, not a runtime.
 *   The producer already existed and had exactly one caller: the isolated
 *   reviewer (`prompts/review-diff.ts`, `computeReviewDiffWithGit` with
 *   `mode: 'uncommitted'` — *"staged + unstaged + untracked, the working-tree
 *   half of every scope"*). This command is its second, and re-deriving the git
 *   invocation beside it would be the second spelling this plan keeps deleting.
 * - **A turn's own edits.** Needs the per-turn snapshot ledger F1 records as
 *   unproduced on claude and codex. Not inventable: this module does not guess,
 *   it says which runtime can answer and why the others cannot
 *   ({@link PER_TURN_UNAVAILABLE_LINE}).
 *
 * ## Why a SUMMARY and not the patch
 *
 * Measured, not assumed. A seam answer reaches the desktop transcript as an
 * `info` message, and `ChatDisplay` renders one as
 * `<span>{infoContent}</span>` inside a `flex items-center` row — no
 * `whitespace-pre-wrap` — so every newline collapses to a space. A 3 000-line
 * unified patch through that renderer is one unreadable paragraph; `/help`'s
 * aligned table already meets the same fate today, and that is a defect this
 * lane reported rather than a reason to emit something worse.
 *
 * The patch itself belongs in the viewer that already renders one:
 * `MultiDiffPreviewOverlay` accepts a `FileChange` carrying a `unifiedDiff` and
 * parses it with `@pierre/diffs`. Wiring the overlay to this producer is a
 * renderer row (one RPC + the composer entry), and it is reported rather than
 * half-built — a menu row that opens nothing would be worse than none.
 *
 * What a summary CAN do honestly, in every mode including `-p`, is answer the
 * question a user actually types `/diff` to ask: which files changed, and by
 * how much.
 */

/** One file's line counts, read from the unified patch itself. */
export interface WorkingTreeDiffFile {
  path: string;
  added: number;
  removed: number;
}

/** The sentence for a clean tree. */
export const WORKING_TREE_CLEAN_LINE = 'Nothing has changed in the working tree.';

/** The sentence for a directory git cannot answer for. */
export const WORKING_TREE_UNAVAILABLE_LINE =
  'The working tree could not be read — this session\'s directory is not a git repository, or git is unavailable.';

/**
 * The per-turn half, stated rather than silently omitted.
 *
 * `done_means` names this control explicitly: *"a claude or codex session
 * states the honest reason (no per-turn snapshot is produced there) rather than
 * showing an empty diff"*. A sentence is the whole of that obligation.
 */
export const PER_TURN_UNAVAILABLE_LINE =
  'A per-turn diff is not available on this runtime: it records no file snapshot for each turn, so there is nothing to compare a turn against. The working-tree view above covers every change made in this directory, whoever made it.';

/** Its counterpart where the snapshots DO exist. */
export const PER_TURN_AVAILABLE_LINE =
  'This runtime does snapshot the files each turn touches, so a per-turn view is possible; it is not offered from this command yet.';

/**
 * Read `+`/`-` counts per file straight out of a unified diff.
 *
 * Deliberately a parser over the patch rather than a second `git` call with
 * `--numstat`: one invocation produced the patch, and a second one a moment
 * later can disagree with it — a file written between the two calls would be
 * counted in one and not the other, and the summary would describe a tree that
 * never existed. Slower agreement beats faster disagreement.
 *
 * `+++ b/<path>` is the name used, falling back to `--- a/<path>` for a
 * deletion (whose `+++` is `/dev/null`). `+++`/`---` header lines are not
 * counted as content, which is the bug every naive version of this has.
 */
export function summarizeUnifiedDiff(patch: string): readonly WorkingTreeDiffFile[] {
  const files: WorkingTreeDiffFile[] = [];
  let current: WorkingTreeDiffFile | undefined;
  let pendingOldPath: string | undefined;

  const stripPrefix = (raw: string): string => {
    const trimmed = raw.trim().split('\t')[0] ?? '';
    if (trimmed === '/dev/null') return '';
    return trimmed.replace(/^[ab]\//, '');
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ')) {
      pendingOldPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      const newPath = stripPrefix(line.slice(4));
      const path = newPath || pendingOldPath || '(unknown)';
      current = files.find(file => file.path === path);
      if (!current) {
        current = { path, added: 0, removed: 0 };
        files.push(current);
      }
      pendingOldPath = undefined;
      continue;
    }
    if (!current) continue;
    // `+++`/`---` are already consumed above, so a bare `+`/`-` here is content.
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }

  return files;
}

/** One file's own patch, cut out of the working-tree diff. */
export interface WorkingTreeDiffFilePatch {
  path: string;
  unifiedDiff: string;
}

/**
 * Cut the working-tree patch into one patch per file — the shape the diff
 * VIEWER takes.
 *
 * P6.278's remaining half. `MultiDiffPreviewOverlay` renders a `FileChange`
 * carrying a `unifiedDiff`, one per file, and the producer
 * (`computeReviewDiffWithGit`) emits one patch for the whole tree, so the only
 * thing between them was this cut. Doing it here rather than in the renderer
 * keeps the ONE parser of this format in the module that already owns it: the
 * summary above and the viewer below now read the same bytes the same way, and
 * a rename in git's output cannot make them disagree.
 *
 * The cut is on `diff --git`, not on `+++`, and that difference is the point.
 * A file's patch has to carry its OWN headers for the viewer to parse it, and
 * `+++` sits in the middle of them — cutting there would hand the viewer a
 * fragment whose first line is already content. Where a patch has no
 * `diff --git` line at all (`git diff --no-index`, some porcelain), the whole
 * text is returned as one entry named from its `+++`, which is worse than a
 * per-file split and much better than nothing.
 *
 * The path is taken from {@link summarizeUnifiedDiff}'s own rule — `+++ b/<path>`,
 * falling back to `--- a/<path>` for a deletion — rather than from the
 * `diff --git a/x b/x` line, because that line quotes and escapes paths
 * containing spaces and the `+++` line is what the counts above already agree
 * with.
 */
export function splitUnifiedDiffByFile(patch: string): readonly WorkingTreeDiffFilePatch[] {
  if (!patch.trim()) return [];

  const lines = patch.split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => { if (line.startsWith('diff --git ')) starts.push(index); });
  const chunks = starts.length > 0
    ? starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length).join('\n'))
    : [patch];

  const out: WorkingTreeDiffFilePatch[] = [];
  for (const chunk of chunks) {
    const [file] = summarizeUnifiedDiff(chunk);
    // A chunk with no `+++` header names no file — a mode-only or
    // binary-file stanza. It is carried under the name git gave it rather than
    // dropped, because a viewer showing four of five changes silently is worse
    // than one showing a stanza the user can read.
    const path = file?.path ?? chunk.split('\n')[0]?.replace(/^diff --git a\//, '').split(' b/')[0] ?? '(unknown)';
    out.push({ path, unifiedDiff: chunk });
  }
  return out;
}

/**
 * The report `/diff` prints.
 *
 * `patch === null` means git could not answer (not a repository, git missing),
 * which is a different statement from an empty patch — the same absent-versus-
 * empty rule every other seam answer in this product follows.
 */
export function formatWorkingTreeDiffReport(
  patch: string | null,
  options: { perTurnSnapshots: boolean },
): string {
  const perTurn = options.perTurnSnapshots ? PER_TURN_AVAILABLE_LINE : PER_TURN_UNAVAILABLE_LINE;
  if (patch === null) return [WORKING_TREE_UNAVAILABLE_LINE, perTurn].join('\n');

  const files = summarizeUnifiedDiff(patch);
  if (files.length === 0) return [WORKING_TREE_CLEAN_LINE, perTurn].join('\n');

  const width = Math.max(...files.map(file => file.path.length));
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);

  return [
    `Uncommitted changes — staged, unstaged and untracked (${files.length === 1 ? '1 file' : `${files.length} files`}, +${totalAdded} −${totalRemoved}):`,
    ...files.map(file => `  ${file.path.padEnd(width)}  +${file.added} −${file.removed}`),
    '',
    perTurn,
  ].join('\n');
}
