/**
 * CodexAutoReviewBreaker — a per-turn denial circuit breaker for codex's NATIVE
 * auto-review guardian (P3.2).
 *
 * ## Why codex-LOCAL rather than the shared `GuardianConsultState`
 *
 * The 3-consecutive / 10-of-50 mechanic already exists once, in
 * `agent/core/guardian-consult.ts` (`GuardianConsultState.registerConsult`,
 * whose own comment calls it "the Codex pattern"). This breaker REUSES that
 * module's exported THRESHOLDS — `GUARDIAN_CONSECUTIVE_DENY_LIMIT`,
 * `GUARDIAN_WINDOW_DENY_LIMIT`, `GUARDIAN_WINDOW_SIZE` — so the two can never
 * drift apart. It does NOT reuse the class, because the class is a different
 * machine for a different job:
 *
 * - `GuardianConsultState` RUNS the judge (it holds a `GuardianJudgePort`, spawns
 *   a read-only child session, and turns a borderline action into an
 *   allow/deny/ask outcome the Pi permission flow consumes). Codex runs its OWN
 *   reviewer subagent inside the app-server; we never judge — we only OBSERVE the
 *   `item/autoApprovalReview/completed` verdicts it streams back.
 * - Its key is `hashAction(action) + cwd` over a `GuardianJudgeInput`. Codex
 *   gives us a `reviewId` and a `GuardianApprovalReview.status`, not a Nessy
 *   planned action, so none of the cache / override-by-action / loop-guard
 *   machinery keyed on that hash applies.
 *
 * So this is the SURFACING half: it counts the denials codex reports, and when
 * the same pattern codex's own internal breaker trips on emerges, we say so to
 * the user (the event adapter turns {@link recordCompletedReview}'s "just
 * tripped" signal into a durable status line). `never` widens nothing — the
 * breaker only ever reports; codex remains the authority that acts, and what it
 * does is INTERRUPT the turn (F1.388), never hand it back to a person.
 *
 * ## `/approve` override
 *
 * When the user explicitly approves a denied action (codex's
 * `thread/approveGuardianDeniedAction`, surfaced in the UI as `/approve`), the
 * human has overruled the reviewer — {@link override} force-closes the circuit
 * and clears BOTH triggers' counters so surfacing resumes from a clean slate.
 * This mirrors the "human wins" precedence `GuardianConsultState`'s
 * `recordPostDenialOverride` encodes, minus the per-action arming record we have
 * no key for here.
 *
 * ## Scope
 *
 * Per-TURN, like `GuardianConsultState`'s circuit-breaker counters and the event
 * adapter's other bookkeeping ({@link resetTurn} is called from the adapter's
 * `onTurnStart`). The window is "the last 50 consulted actions in one turn",
 * exactly as the shared comment defines it.
 */

import {
  GUARDIAN_CONSECUTIVE_DENY_LIMIT,
  GUARDIAN_WINDOW_DENY_LIMIT,
  GUARDIAN_WINDOW_SIZE,
} from '../../core/guardian-consult.ts';

export {
  GUARDIAN_CONSECUTIVE_DENY_LIMIT,
  GUARDIAN_WINDOW_DENY_LIMIT,
  GUARDIAN_WINDOW_SIZE,
} from '../../core/guardian-consult.ts';

export class CodexAutoReviewBreaker {
  private consecutiveDenies = 0;
  private recentDenies: boolean[] = [];
  private circuitOpen = false;

  /** Is the breaker tripped for the rest of this turn? */
  get isOpen(): boolean {
    return this.circuitOpen;
  }

  /**
   * Feed one completed auto-review verdict into the window. `denied` is true only
   * for a `denied` review status; an approval / timeout / abort resets the
   * consecutive run, exactly as a non-deny verdict does in the shared breaker.
   *
   * Returns `true` on the SINGLE call that trips the circuit (the transition
   * from closed to open), and `false` on every other call — so the adapter emits
   * the "interrupting" notice once, not on every subsequent denial. A verdict
   * arriving while the circuit is already open still advances the window (so the
   * count the notice reports keeps pace) but never re-announces.
   */
  recordCompletedReview(denied: boolean): boolean {
    this.consecutiveDenies = denied ? this.consecutiveDenies + 1 : 0;
    this.recentDenies.push(denied);
    if (this.recentDenies.length > GUARDIAN_WINDOW_SIZE) this.recentDenies.shift();
    const windowDenies = this.recentDenies.reduce((sum, d) => sum + (d ? 1 : 0), 0);
    const shouldOpen = this.consecutiveDenies >= GUARDIAN_CONSECUTIVE_DENY_LIMIT
      || windowDenies >= GUARDIAN_WINDOW_DENY_LIMIT;
    if (shouldOpen && !this.circuitOpen) {
      this.circuitOpen = true;
      return true;
    }
    return false;
  }

  /**
   * How many denials sit in the current window — the number the "interrupting"
   * notice reports. Counts consecutive when that is the trigger, otherwise the
   * windowed count; reports the larger so the message never understates.
   */
  get deniedInWindow(): number {
    const windowDenies = this.recentDenies.reduce((sum, d) => sum + (d ? 1 : 0), 0);
    return Math.max(windowDenies, this.consecutiveDenies);
  }

  /**
   * The `/approve` override: the user overruled a denied action, so close the
   * circuit and clear BOTH triggers' counters. Clearing the window (not just the
   * consecutive run) is deliberate — otherwise a window already at the limit
   * would re-trip on the next denial and the override would buy nothing.
   */
  override(): void {
    this.consecutiveDenies = 0;
    this.recentDenies = [];
    this.circuitOpen = false;
  }

  /** Turn boundary: clear all per-turn state. */
  resetTurn(): void {
    this.override();
  }
}
