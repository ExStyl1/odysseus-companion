/**
 * P6.489 — say when an auto-compaction ran WITHOUT the composed compaction
 * instructions, so a project's standing `## Compact Instructions` section being
 * skipped stops being silent.
 *
 * **Owner decision 2026-09-05, Q25, option 1: keep the guard as landed and make
 * the skip VISIBLE.** Option 2 — activating the summary replacement whenever a
 * standing section exists — stays refused BY NAME, because it would newly expose
 * sessions that had the replacement disabled to the host summarizer's
 * `{ cancel: true }` auth arm. Nothing here changes behaviour: this module
 * produces a STRING, and its caller returns exactly where it returned before.
 *
 * Why the case is reachable at all, measured and worth keeping written down: the
 * only sender of the subprocess `prompt` message always sets
 * `autoCompactionInstructions: composePiCompactionInstructions(...)`, which
 * returns at minimum the handoff instructions — so something standing is ALWAYS
 * composed. The queue that carries it drains only on a user-role
 * `message_start`, and tool results carry `role: "toolResult"`, so a compaction
 * that fires mid-turn finds the queue empty and the standing section is dropped
 * with no trace.
 *
 * Its own module rather than an inline string so the two halves — when the notice
 * fires, and what it says — can be tested without spawning the real subprocess.
 */

/**
 * Whether this compaction skipped standing instructions in the way that is worth
 * reporting.
 *
 * `manual` is excluded deliberately and is not the same case: a manual
 * compaction carries the user's own instructions or none by choice, and
 * reporting it would make the notice fire on the ordinary path — a notice that
 * cries wolf is a notice people learn to ignore.
 */
export function isSilentAutoCompactionSkip(
  reason: string,
  instructions: string | undefined,
): boolean {
  return reason !== 'manual' && !instructions;
}

/** The line itself: what did not happen, why it can happen, and that nothing changed. */
export function describeAutoCompactionSkip(reason: string): string {
  return `Auto-compaction (reason=${reason}) ran WITHOUT the composed compaction instructions: `
    + 'the instruction queue drains on a user-role message_start and this compaction did not '
    + 'follow one, so a project\'s standing `## Compact Instructions` section was NOT applied '
    + 'to this summary. Behaviour is unchanged — the summary replacement stays off here by '
    + 'owner decision (Q25) — this line is the record that the skip happened.';
}
