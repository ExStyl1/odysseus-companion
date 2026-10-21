/**
 * Reading a rewind result honestly. The rewind surfaces used to render a green
 * success whenever the server said `success: true`, and `restoredCheckpoints: 0`
 * beside it read as "there was nothing to restore". On a runtime with no
 * checkpoint producer it means "nothing could be restored" — the user asked for
 * their files back, was told it succeeded, and got nothing. This module owns
 * that one-line distinction, because that line has a trap in it, and the
 * sentence a files-restoring rewind says (F1.989), so its wording has a pin.
 */
import { distinctSkipReasonKeys } from './checkpoint-skip'

/**
 * Did the server say, in so many words, that this session's runtime does not
 * track file edits?
 *
 * The trap is the third state. `fileCheckpointsTracked` is `true`, `false`, or
 * ABSENT, and absent means the server could not resolve the runtime — not that
 * the runtime is untracked. A truthiness test (`!result?.fileCheckpointsTracked`)
 * would warn on every older server and on every config read that failed, which
 * is a different false statement in the other direction. Only an explicit
 * `false` is a warning.
 */
export function fileCheckpointsUntracked(
  result: { fileCheckpointsTracked?: boolean } | undefined,
): boolean {
  return result?.fileCheckpointsTracked === false
}

/**
 * An edit category a rewind structurally CANNOT restore (P6.268).
 *
 * `checkpointing.md` scopes checkpoints to the edits the harness mediates, and
 * our producer inventory says the same from the other side: Pi's checkpoint
 * producer is keyed by `descriptor.checkpointAdapter` in `beforeDispatch`
 * (`packages/shared/src/sessions/file-checkpoints.ts`), so which tools it
 * covers is a property of that keying. A file a shell command rewrote, or one a
 * background subagent wrote through its own dispatch, was never snapshotted —
 * the rewind restores what it has and says "restored N", which reads as "that
 * was everything".
 *
 * The limitation is real on every runtime and was stated on none. What was
 * missing is the SENTENCE, not the machine.
 */
export type UncoveredRewindCategory = 'bash' | 'subagent'

/**
 * Tool names whose edits arrive outside the checkpoint adapter.
 *
 * Lower-cased at the comparison, because the three runtimes do not agree on
 * the casing of a tool name and a case-sensitive list would report the
 * limitation on one runtime and not the others — which is the silent
 * divergence this row exists to remove rather than create.
 *
 * `Monitor` is here for the same reason `Bash` is: it runs a command. The
 * background-shell family (`BashOutput`, `KillShell`) reads output rather than
 * producing edits, so naming them would over-warn.
 */
const UNCHECKPOINTED_COMMAND_TOOLS = new Set(['bash', 'monitor'])

/**
 * The categories a rewind over `messages` could not have covered.
 *
 * The span is the messages the rewind is about to remove, read BEFORE the call
 * — the same ordering `handleRewindConversation` already uses for the restored
 * prompt, and for the same reason: the transcript is truncated by the time the
 * await returns.
 *
 * Empty for a span whose only tools are foreground editors, which is the
 * control the sentence must not fire on. External edits — a file changed by
 * something outside the session entirely — are deliberately NOT a member: no
 * signal in the transcript can distinguish them from a file nobody touched, and
 * a category asserted without evidence would make the honest ones look like
 * boilerplate.
 */
export function uncoveredRewindCategories(
  messages: readonly {
    toolName?: string
    taskId?: string
    isBackground?: boolean
  }[],
): UncoveredRewindCategory[] {
  const categories: UncoveredRewindCategory[] = []
  const hasCommandTool = messages.some(message => (
    UNCHECKPOINTED_COMMAND_TOOLS.has((message.toolName ?? '').toLowerCase())
  ))
  if (hasCommandTool) categories.push('bash')
  // A background subagent is `taskId` (a Task with `run_in_background`) or the
  // explicit flag; a FOREGROUND subagent's tool calls ran through the same
  // dispatch as the parent's and are checkpointed with them.
  const hasBackgroundSubagent = messages.some(message => (
    message.taskId !== undefined || message.isBackground === true
  ))
  if (hasBackgroundSubagent) categories.push('subagent')
  return categories
}

/** The locale key naming one uncovered category. */
export function uncoveredRewindCategoryKey(category: UncoveredRewindCategory): string {
  return category === 'bash'
    ? 'toast.conversationRewoundUncoveredBash'
    : 'toast.conversationRewoundUncoveredSubagent'
}

/** The counts a files-restoring rewind reports, as the server summed them. */
export interface RewindFilesCounts {
  restored: number
  failed: number
  /** Tracked paths left alone for link safety (`ConversationRewindResult.skippedLinks`). */
  skipped: number
  /** The paths behind `skipped`, each with its reason. */
  skippedPaths?: Parameters<typeof distinctSkipReasonKeys>[0]
}

/**
 * The sentence a rewind that asked for its files back says about them (F1.989).
 *
 * A rewind that left any file alone for link safety is a PARTIAL rewind, and
 * "restored N" alone would be the lie: the count of paths left unchanged and
 * the distinct reasons (each once, first-seen order) belong in the same line,
 * so the user learns them here and not from a diff. With nothing skipped it is
 * the plain restored/failed count.
 *
 * Pure so the wording has a unit pin: `handleRewindConversation` in
 * `ChatDisplay.tsx` built it inline, and that component cannot be mounted in
 * the test runner. The toast's tone, the untracked-runtime clause and the
 * uncovered categories still compose around this sentence at the call site.
 */
export function rewindFilesDescription(
  counts: RewindFilesCounts,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (counts.skipped > 0) {
    const reasons = distinctSkipReasonKeys(counts.skippedPaths).map(key => t(key)).join('; ')
    return `${t('toast.conversationRewoundWithSkipsDescription', {
      restored: counts.restored,
      failed: counts.failed,
      skipped: counts.skipped,
    })} — ${reasons}`
  }
  return t('toast.conversationRewoundWithFilesDescription', {
    restored: counts.restored,
    failed: counts.failed,
  })
}

/**
 * F1.1134 — the files sentence of a rewind on a runtime that tracks no file
 * edits. `handleRewindConversation` kept {@link rewindFilesDescription}'s
 * sentence only when something was RESTORED, so a rewind whose older
 * checkpoints were all skipped for link safety lost the skip count and the
 * reasons and said only "does not track file edits". The sentence now stays
 * whenever the counts carry anything — restored, failed or skipped — and the
 * untracked clause follows it; with nothing to count it is the clause alone.
 */
export function rewindUntrackedDescription(
  filesDescription: string,
  counts: Pick<RewindFilesCounts, 'restored' | 'failed' | 'skipped'>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const notTracked = t('toast.conversationRewoundFilesNotTracked')
  return counts.restored > 0 || counts.failed > 0 || counts.skipped > 0
    ? `${filesDescription} — ${notTracked}`
    : notTracked
}
