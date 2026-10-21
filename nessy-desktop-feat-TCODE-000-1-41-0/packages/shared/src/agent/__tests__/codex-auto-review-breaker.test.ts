/**
 * P3.2 · CodexAutoReviewBreaker — the per-turn denial breaker for codex's native
 * auto-review guardian. Reuses the shared thresholds from
 * `agent/core/guardian-consult.ts` (3 consecutive / 10-of-50).
 */
import { describe, it, expect } from 'bun:test';
import {
  CodexAutoReviewBreaker,
  GUARDIAN_CONSECUTIVE_DENY_LIMIT,
  GUARDIAN_WINDOW_DENY_LIMIT,
} from '../backend/codex/auto-review-breaker.ts';

describe('CodexAutoReviewBreaker', () => {
  it('reuses the shared guardian-consult thresholds (3 consecutive / 10)', () => {
    // The whole point of importing them: a drift in guardian-consult.ts moves
    // this breaker too. Guard the values the brief pins so a silent change fails.
    expect(GUARDIAN_CONSECUTIVE_DENY_LIMIT).toBe(3);
    expect(GUARDIAN_WINDOW_DENY_LIMIT).toBe(10);
  });

  it('trips on 3 CONSECUTIVE denies, not before, and only once', () => {
    const b = new CodexAutoReviewBreaker();
    expect(b.recordCompletedReview(true)).toBe(false); // 1
    expect(b.isOpen).toBe(false);
    expect(b.recordCompletedReview(true)).toBe(false); // 2
    expect(b.isOpen).toBe(false);
    expect(b.recordCompletedReview(true)).toBe(true);  // 3 → trips, one-shot true
    expect(b.isOpen).toBe(true);
    // A 4th denial while already open advances the window but never re-announces.
    expect(b.recordCompletedReview(true)).toBe(false);
    expect(b.isOpen).toBe(true);
  });

  it('a non-deny verdict resets the consecutive run', () => {
    const b = new CodexAutoReviewBreaker();
    b.recordCompletedReview(true);
    b.recordCompletedReview(true);
    b.recordCompletedReview(false); // approval breaks the streak
    expect(b.recordCompletedReview(true)).toBe(false); // only 1 consecutive now
    expect(b.isOpen).toBe(false);
  });

  it('trips on 10 denies within the window even when never 3 in a row', () => {
    const b = new CodexAutoReviewBreaker();
    // 9 isolated denies (each followed by an approval → consecutive never > 1).
    for (let i = 0; i < 9; i++) {
      expect(b.recordCompletedReview(true)).toBe(false);
      b.recordCompletedReview(false);
    }
    expect(b.isOpen).toBe(false);
    // The 10th deny reaches the windowed limit and trips it.
    expect(b.recordCompletedReview(true)).toBe(true);
    expect(b.isOpen).toBe(true);
  });

  it('override() closes the circuit AND clears both triggers so a re-trip needs a fresh 3', () => {
    const b = new CodexAutoReviewBreaker();
    b.recordCompletedReview(true);
    b.recordCompletedReview(true);
    expect(b.recordCompletedReview(true)).toBe(true); // open
    b.override();
    expect(b.isOpen).toBe(false);
    // One deny after the override must NOT immediately re-trip — the window was
    // cleared, so both triggers start over.
    expect(b.recordCompletedReview(true)).toBe(false);
    expect(b.recordCompletedReview(true)).toBe(false);
    expect(b.recordCompletedReview(true)).toBe(true); // fresh 3 → re-trips
  });

  it('resetTurn() clears the breaker for the next turn', () => {
    const b = new CodexAutoReviewBreaker();
    b.recordCompletedReview(true);
    b.recordCompletedReview(true);
    b.recordCompletedReview(true);
    expect(b.isOpen).toBe(true);
    b.resetTurn();
    expect(b.isOpen).toBe(false);
    expect(b.deniedInWindow).toBe(0);
  });

  it('deniedInWindow reports the denial count for the fall-back notice', () => {
    const b = new CodexAutoReviewBreaker();
    b.recordCompletedReview(true);
    b.recordCompletedReview(true);
    b.recordCompletedReview(true);
    expect(b.deniedInWindow).toBe(3);
  });
});
