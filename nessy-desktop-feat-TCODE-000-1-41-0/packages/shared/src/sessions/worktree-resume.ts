import { isInsideWorktreeNamespace } from '../agent/pi-harness/worktree-layout.ts';
import { screenWorktreeIdentity } from '../automations/hook-worktree-path.ts';

/**
 * Where a session should land when it is reopened.
 *
 * Entering a worktree records the session under its NEW working directory, "the
 * same way `/cd` does, so `/desktop` and `--resume` find it there" — so the
 * recorded directory is authoritative most of the time and this helper returns
 * it unchanged. Two documented cases override it, and both return the LAUNCH
 * directory rather than failing:
 *
 * - "If the worktree directory no longer exists, the session resumes in the
 *   directory you launched Claude from." A deleted worktree is an ordinary
 *   outcome — someone ran `git worktree remove`, or R12's sweep did — and it
 *   must not turn a session into one that cannot be opened.
 * - "A resume that forks the session with `--fork-session` starts in the
 *   directory you launched Claude from and leaves the original session's
 *   worktree untouched." A fork inheriting the cwd would put two sessions in one
 *   worktree, and closing either would then be closing the other's workspace.
 *
 * The launch directory is `sdkCwd`, which is set once at creation and never
 * moves — including on `EnterWorktree`, deliberately, because "a worktree
 * created by a `WorktreeCreate` hook keeps its transcript at the launch
 * directory". That invariant is what lets this helper answer at all: without a
 * stable launch directory there would be nothing to fall back TO.
 *
 * `exists` is injected so the decision stays pure and testable; the only real
 * caller passes `existsSync`.
 *
 * P6.324 (a) adds a THIRD case, and it is a refusal rather than a documented
 * fallback: a recorded worktree directory that still exists but is no longer a
 * worktree of its own — the main checkout, or a `.git` redirect into it. Resuming
 * INTO it would put a session that believes it is isolated in the user's real
 * tree, so it takes the same exit the deleted worktree takes: the launch
 * directory, with the directory left on disk and untouched. The screen's answer
 * is injected (`identify`) for the same reason `exists` is; a caller that cannot
 * ask git passes nothing and gets exactly the previous behaviour.
 */
export function resolveWorktreeAwareWorkingDirectory(input: {
  /** The recorded working directory, already expanded. */
  workingDirectory?: string;
  /** The launch directory, already expanded. */
  sdkCwd?: string;
  exists: (path: string) => boolean;
  /** A fork always returns to the launch directory, intact worktree or not. */
  fork?: boolean;
  /**
   * P6.324 (a) — `git -C <path> rev-parse --show-toplevel` for the recorded
   * directory, and the repository it should belong to. Absent ⇒ no identity
   * check, which is the behaviour before that row.
   */
  identify?: (path: string) => { repoRoot: string; toplevel: string | null };
}): string | undefined {
  const { workingDirectory, sdkCwd } = input;
  if (!workingDirectory) return workingDirectory;
  // Not a worktree of this session's own repository: an ordinary `/cd`, and
  // none of the worktree rules apply to it.
  if (!sdkCwd || !isInsideWorktreeNamespace(workingDirectory, sdkCwd)) return workingDirectory;
  if (input.fork) return sdkCwd;
  if (!input.exists(workingDirectory)) return sdkCwd;
  if (input.identify) {
    const probed = input.identify(workingDirectory);
    const screened = screenWorktreeIdentity({
      candidatePath: workingDirectory,
      repoRoot: probed.repoRoot,
      toplevel: probed.toplevel,
    });
    if (!screened.ok) return sdkCwd;
  }
  return workingDirectory;
}
