/**
 * F1.1298 — the text a failed manual `compact` answers the host (`handleCompact`'s catch).
 *
 * - A STOP owns the answer: `Compaction cancelled`, Pi's own text for a stopped summary. Pi 0.85.1
 *   throws it for a history summary, but `Turn prefix summarization failed: The operation was
 *   aborted.` when the cut splits a turn (`CompactionError("summarization_failed", …)` on the turn
 *   prefix's `stopReason === "error"`), so the text is decided here by the Stop, not by the SDK's path.
 * - R73 (hooks.md#precompact, "For a manual `/compact`, the stderr message is shown to the user"):
 *   with no Stop, Pi's fixed `Compaction cancelled` after a PreCompact block carries that hook's reason.
 * - Every other failure keeps the SDK's own text.
 */
export function compactFailureText(
  rawMessage: string,
  context: { stopped: boolean; preCompactBlockReason?: string },
): string {
  if (context.stopped) return 'Compaction cancelled';
  if (rawMessage === 'Compaction cancelled' && context.preCompactBlockReason) return context.preCompactBlockReason;
  return rawMessage;
}
