/**
 * The bounded wait for `nessy:compaction-complete`.
 *
 * "Accept & Compact" sends `/compact` and then waits for the compaction to
 * finish before it submits the plan-execution message. That wait used to be a
 * bare `addEventListener` with no timeout and no unmount cleanup: when the event
 * did not arrive — which is what a broken `/compact` produced for as long as the
 * command reached the model as prose — the user sat in silence forever, the
 * listener leaked, and the persisted `awaitingCompaction` flag kept even a reload
 * from recovering the plan.
 *
 * A listener with no timeout is a defect independent of its cause. This module
 * removes the class: exactly one of `onComplete` / `onTimeout` runs, the
 * listener is always removed, and the caller gets a disposer so an unmount or a
 * session switch cancels the wait instead of orphaning it.
 */

/**
 * `PiAgent.requestCompact` bounds the compaction itself at 300 s, and a
 * GPT-backed compaction of a large conversation legitimately takes 60–120 s. The
 * wait must outlast that RPC or it would abandon a compaction that is still
 * about to succeed, so this is the backend's own ceiling plus delivery margin.
 */
export const COMPACTION_WAIT_TIMEOUT_MS = 330_000;

export interface CompactionWaitOptions {
  /** Only a `compaction-complete` for THIS session ends the wait. */
  sessionId: string;
  /** Runs once, when the compaction reports complete. */
  onComplete: () => void | Promise<void>;
  /** Runs once, when the event never arrived inside the bound. */
  onTimeout: () => void | Promise<void>;
  /**
   * F1.856 — asked when the bound expires: is the plan STILL awaiting its compaction? A plan
   * that no longer is — sent through the host's readiness (a compaction refused as having
   * nothing to compact counts as done), or cleared by a later message — did not fail, so the
   * wait then ends with neither callback. Absent, the timeout always reports.
   */
  isStillAwaiting?: () => Promise<boolean>;
  timeoutMs?: number;
  /** Injectable for tests; defaults to `window`. */
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Starts the wait. Returns a disposer that cancels it without running either
 * callback; calling it after the wait has settled is a no-op.
 */
export function awaitCompactionComplete(options: CompactionWaitOptions): () => void {
  const {
    sessionId,
    onComplete,
    onTimeout,
    isStillAwaiting,
    timeoutMs = COMPACTION_WAIT_TIMEOUT_MS,
    target = window,
  } = options;

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    target.removeEventListener('nessy:compaction-complete', handleCompactionComplete as EventListener);
  };

  function handleCompactionComplete(event: Event) {
    const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
    // A completion for another session must not settle this wait, and must not
    // consume it either — the listener stays until our own session reports.
    if (detail?.sessionId !== sessionId) return;
    if (settled) return;
    settled = true;
    stop();
    void onComplete();
  }

  target.addEventListener('nessy:compaction-complete', handleCompactionComplete as EventListener);
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    stop();
    // A failed read reports, as before the question existed: silence is the worse error.
    void (isStillAwaiting ? isStillAwaiting().catch(() => true) : Promise.resolve(true))
      .then(awaiting => (awaiting ? onTimeout() : undefined));
  }, timeoutMs);

  return () => {
    if (settled) return;
    settled = true;
    stop();
  };
}

/**
 * F1.241 — the other half of Accept & Compact: the wait above is only a WAKEUP (and the
 * timeout); the plan is sent by the one persisted-state dispatcher. Re-exported here so the
 * composer imports the flow's two halves from one module (and keeps its import block's line
 * count — `FreeFormInput.tsx` is cited by line).
 */
export { createPendingPlanDispatcher } from './pending-plan-dispatch'


/** The part of a chat turn `compactTurnLeftPlanOpen` reads (`turn-utils`' `Turn` fits it). */
export interface PlanFollowingTurn {
  type: string;
  message?: { role?: string; content?: string; statusType?: string };
}

/**
 * F1.856 — does the user turn at `index` leave the plan above it OPEN (its Accept still on
 * offer)? `ChatDisplay` offers a plan's Accept only while no user turn follows it, and Accept &
 * Compact's own `/compact` IS one — so a compaction that FAILED took the Accept away with it and
 * the flow dead-ended (SIT-x: only Copy and Markdown left). A `/compact` whose own turn ended in
 * an error, before any other user turn and with no completed compaction, ran nothing, so it
 * leaves the plan open. Every other user turn — the plan's own "Plan approved…" included —
 * supersedes it, exactly as before.
 */
export function compactTurnLeftPlanOpen(turns: readonly PlanFollowingTurn[], index: number): boolean {
  const content = turns[index]?.type === 'user' ? turns[index]?.message?.content?.trim() : undefined;
  if (content !== '/compact' && !content?.startsWith('/compact ')) return false;
  for (const next of turns.slice(index + 1)) {
    if (next.type === 'user' || next.message?.statusType === 'compaction_complete') return false;
    if (next.type === 'system' && next.message?.role === 'error') return true;
  }
  return false;
}
