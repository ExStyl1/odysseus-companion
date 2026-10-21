/**
 * CodexAutoCompactionThrashGuard — the SECOND producer of
 * `auto_compaction_thrashing` (P6.55).
 *
 * ## The defect this closes
 *
 * The documented behaviour is one behaviour, on one page:
 * `how-claude-code-works.md#when-context-fills-up` — *"If a single file or tool
 * output is so large that context refills immediately after each summary, Claude
 * Code stops auto-compacting after a few attempts and shows an error instead of
 * looping."* — with the shape of "a few" fixed by
 * `troubleshooting.md#auto-compaction-stops-with-a-thrashing-error`: *"automatic
 * compaction succeeded but a file or tool output immediately refilled the
 * context window several times in a row."*
 *
 * Nessy implemented it once, inside the Pi subprocess
 * (`pi-agent-server/src/index.ts` `applyAutoCompactionThrashingGuard`), so the
 * shared wire value `auto_compaction_thrashing` had exactly ONE producer. On
 * codex the same session — one oversized file re-read after every summary —
 * simply kept compacting, and nothing said so.
 *
 * ## Why the mechanic differs from Pi's, and why that is not a divergence
 *
 * Pi hands us the failure directly: an assistant `message_end` with
 * `stopReason: 'error'` that `isContextOverflow` recognises, arriving right
 * after a successful overflow compaction. Codex never surfaces that error — it
 * compacts server-side and continues — so the only thing we can observe is the
 * compaction itself, reported in the past tense (`contextCompaction` item, or
 * the deprecated `thread/compacted` notification the bundled app-server still
 * sends).
 *
 * A REFILL is therefore inferred, and inferred narrowly: *a compaction that
 * follows another compaction with no new user message in between.* The first
 * compaction of a turn is the healthy path and is never a refill. Both runtimes
 * end up counting the same quantity — "the context came straight back after a
 * summary" — from the evidence their own runtime actually emits, and both trip
 * on the SAME shared count ({@link AUTO_COMPACTION_THRASHING_REFILL_LIMIT}), so
 * the number cannot drift.
 *
 * ## The floor, stated because a threshold read against zero is a bug
 *
 * Compactions per turn is NOT a quantity whose resting state is zero. A long
 * agentic turn on a small window compacts once as a matter of course, and can
 * legitimately compact twice. Counting compactions and tripping at one or two
 * would fire on the healthy path and manufacture the failure it claims to
 * detect. Counting REFILLS puts the floor where the resting state actually is:
 * `refills = compactions - 1`, so a turn that compacts once scores zero, and the
 * guard trips on the FOURTH compaction of an uninterrupted run.
 *
 * Nothing here reads a context window. That is deliberate: the window for a
 * gateway or Pi model is absent from the static registry (`getModelById` returns
 * `undefined` for every one of them), and a guard whose arithmetic needs a
 * window that does not exist can never fire on the models this app ships.
 *
 * ## Scope
 *
 * Per-TURN, reset from the event adapter's `onTurnStart` — the same boundary
 * `CodexAutoReviewBreaker` uses, and the same one Pi's guard uses (it resets on
 * a user `message_start`). A user message is the point at which the loop is no
 * longer "in a row".
 *
 * ## What it does NOT do, recorded rather than implied
 *
 * It does not INTERRUPT the running codex turn. The guard observes the
 * notification stream and has no control channel; stopping the turn mid-flight
 * would need `turn/interrupt` on the agent. What it does is what Pi's guard does
 * on its own side of the same wire: it says so once, durably, and stamps the
 * turn's terminal verdict so the ending is named rather than silent.
 */

import { AUTO_COMPACTION_THRASHING_REFILL_LIMIT } from '../../../config/auto-compaction-settings.ts';

export { AUTO_COMPACTION_THRASHING_REFILL_LIMIT } from '../../../config/auto-compaction-settings.ts';

export class CodexAutoCompactionThrashGuard {
  private compactions = 0;
  private tripped = false;

  /** Has the guard tripped for the rest of this turn? */
  get isTripped(): boolean {
    return this.tripped;
  }

  /**
   * Refills seen this turn — compactions minus the first, which is the healthy
   * one. The number the notice reports.
   */
  get refills(): number {
    return Math.max(0, this.compactions - 1);
  }

  /**
   * Feed one observed compaction into the turn.
   *
   * Returns `true` on the SINGLE call that trips the guard, and `false` on every
   * other call — so the adapter emits the notice once rather than on every
   * further compaction. Compactions after the trip still advance the count, so
   * the terminal verdict reports a current number.
   */
  recordCompaction(): boolean {
    this.compactions += 1;
    if (this.refills >= AUTO_COMPACTION_THRASHING_REFILL_LIMIT && !this.tripped) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  /** Turn boundary: a user message means the run is no longer "in a row". */
  resetTurn(): void {
    this.compactions = 0;
    this.tripped = false;
  }
}
