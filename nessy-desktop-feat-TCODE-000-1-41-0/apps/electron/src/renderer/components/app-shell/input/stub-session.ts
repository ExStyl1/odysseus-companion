/**
 * D1.383 — the session ids the RENDERER mints, spelled once.
 *
 * Two surfaces mount a whole composer over a session the host has never heard
 * of, and both are deliberate:
 *
 * - `EditPopover`'s inline mode shows its chat BEFORE the hidden session that
 *   will carry it exists, over a stub whose id is {@link
 *   EDIT_POPOVER_STUB_SESSION_ID}. That is how the agent-driven add-source /
 *   add-skill install can be typed into on the first frame.
 * - The `/btw` panel (D1.375) renders over a SYNTHETIC id derived from the real
 *   one, so the panel's draft, transcript and composer state can never touch
 *   the real session's (`side-question-composer.ts` says why).
 *
 * What both cost, until this module existed: `ChatInputZone` hydrates its queue
 * with `queueGet(sessionId)` on every mount, so each open made a round trip that
 * can only fail and logged `[ChatInputZone] Failed to hydrate queue` — a console
 * error with no defect behind it, once per `/btw` and once per install popover.
 *
 * WHY A MODULE AND NOT A LITERAL AT THE CALL SITE. A `sessionId === 'pending'`
 * sniff in `ChatInputZone` would be a second spelling of a fact `EditPopover`
 * owns, free to drift the day either side is renamed and silent when it does.
 * Here there is one spelling per minted id, and `__tests__/stub-session.test.ts`
 * reads `EditPopover`'s own source to pin the constant against it.
 *
 * Leaf on purpose — no React, no component import — so both the predicate and
 * everything that reads it stay testable in a bare bun process.
 */

import { isSideQuestionSessionId } from '../side-question-composer'

/**
 * The stub session id `EditPopover` mounts its inline chat over before the real
 * (hidden) session exists. Pinned against `EditPopover.tsx`'s own source by the
 * test beside this module, because the component builds the stub inline.
 */
export const EDIT_POPOVER_STUB_SESSION_ID = 'pending'

/**
 * True when this session id was minted by the RENDERER rather than the host, so
 * no server-side lookup against it can ever succeed.
 *
 * Narrow by design: it answers false for the empty id `EditPopover` passes to
 * `useSession` before it has one (which is not a session at all, minted or
 * otherwise) and for every id the host minted, so a real session keeps every
 * round trip it has today.
 */
export function isRendererMintedSessionId(sessionId: string): boolean {
  return sessionId === EDIT_POPOVER_STUB_SESSION_ID || isSideQuestionSessionId(sessionId)
}

/**
 * F1.179 — a turn is in flight on a session the HOST runs.
 *
 * The gate for anything that answers "a turn is running" with a round trip to
 * the host — today `ChatDisplay`'s `chat.backgroundInFlightTask` chord, whose
 * handler sends `sessionCommand(session.id, …)`. `isProcessing` alone stopped
 * being enough the day the `/btw` panel began reporting its own pending answer
 * as `isProcessing` over a renderer-minted id: the action registry runs the
 * FIRST ENABLED handler for a chord (`actions/registry.tsx`), so an ungated
 * panel registration would be the one that answers whenever the main session is
 * idle — a round trip against an id no server knows, the class D1.383 closed.
 */
export function isHostTurnInFlight(
  session: { id: string; isProcessing?: boolean } | null | undefined,
): boolean {
  return session?.isProcessing === true && !isRendererMintedSessionId(session.id)
}
