/**
 * D1.375 — the `/btw` panel is a chat the user can TYPE INTO, and this module
 * holds the three pure decisions that posture needs. No React, so each one is
 * testable on its own (`__tests__/side-question-composer.test.ts`).
 *
 * WHAT CHANGED AND WHY. R36 built the panel as a read-only answer surface, on
 * `interactive-mode.md:369` — "a side question is a single response with no
 * follow-up turns" — and the owner met the result in use on 2026-09-18: a
 * 420x440 box whose body is the compact chat's own empty state ("What would you
 * like to change?" / "Just describe it — I'll handle the rest"), inviting the
 * user to type with nowhere to type. The owner's ruling is the opposite posture,
 * and it is a PRODUCT decision that outranks the page for this surface: a side
 * question is a chat, so the panel carries the same composer the agent-driven
 * add-source / add-skill install renders in its popover (`EditPopover`'s inline
 * mode: the compact {@link ChatDisplay} with its real `ChatInputZone`). We reuse
 * that mount rather than building a second composer — same rule R36 followed
 * when it composed the panel out of `EditPopover`'s shell in the first place.
 */

import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import type { typedOutOfBandCommandSubmission } from './input/slash-command-actions'

/**
 * The prefix of the SYNTHETIC session the panel's chat renders over.
 *
 * The panel must never render over the real session id: the composer syncs its
 * draft per session, so a shared id would mirror what is typed in the panel into
 * the main composer and back. The synthetic id keeps the two drafts apart, and
 * it is also the reason the panel's chat can never touch the real transcript.
 */
export const SIDE_QUESTION_SESSION_PREFIX = 'side-question:'

/** The synthetic session id the panel's chat renders over. */
export function sideQuestionSessionId(sessionId: string): string {
  return `${SIDE_QUESTION_SESSION_PREFIX}${sessionId}`
}

/**
 * True for the synthetic id above.
 *
 * Read by `FreeFormInput` to decide NOT to mount a side-question panel of its
 * own: the panel now mounts a real composer, that composer is a `FreeFormInput`,
 * and `FreeFormInput` mounts the panel — so without this the panel would nest
 * inside itself one level deep and a `/btw` typed INSIDE the panel would ask a
 * question of a session id no server knows. One predicate closes the loop.
 */
export function isSideQuestionSessionId(sessionId: string | undefined): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(SIDE_QUESTION_SESSION_PREFIX)
}

/**
 * What the panel focuses when it opens — and it is NOT a `textarea`.
 *
 * Measured 2026-09-18 while building this row: the composer's editable element
 * is `RichTextInput`'s `contentEditable` DIV (`components/ui/rich-text-input.tsx`
 * — `contentEditable={!disabled}`, so the attribute reads `"true"` whenever it
 * can be typed into), and there is no `textarea` anywhere under it. A first
 * draft of the panel queried `'textarea'`, found nothing, fell back to focusing
 * the panel container — and the very first Space would then have dismissed the
 * panel, which is the owner's bug wearing a different hat. The `textarea` and
 * `input` arms stay for the shape the key guard also accepts, so the two agree.
 */
export const SIDE_QUESTION_COMPOSER_SELECTOR = '[contenteditable="true"], textarea, input'

/**
 * D1.392 — the panel's own rotating placeholder keys.
 *
 * The bug the owner photographed on 2026-09-19: the panel's composer invited
 * "Press B to toggle the sidebar". `ChatInputZone` rotates the MAIN composer's
 * tips whenever no `placeholder` is passed, and the panel passed none — so a
 * popover with no sidebar in it advertised a sidebar shortcut. `EditPopover`
 * has had its own three (`COMPACT_PLACEHOLDER_KEYS`) since inline mode shipped;
 * these are the same idea in the side question's own voice, and they are asked
 * about THIS CHAT rather than about what to change.
 */
export const SIDE_QUESTION_PLACEHOLDER_KEYS = [
  'chat.sideQuestion.placeholder1',
  'chat.sideQuestion.placeholder2',
  'chat.sideQuestion.placeholder3',
] as const

/**
 * Panel width — the reference card's, read rather than guessed.
 *
 * The Sources page's "+" opens an `EditPopover` and passes NO `width`, so the
 * card the owner pointed at is that prop's default: 400. (Its own docblock said
 * 320 until this row; the default in the signature is what renders.) The
 * viewport fraction stays in front of it so a narrow window never gets a panel
 * wider than itself — what shipped before, `min(92vw, 560px)`, was 40 % wider
 * than the surface it was supposed to match.
 */
export const SIDE_QUESTION_PANEL_WIDTH = 'min(92vw, 400px)'

/**
 * Panel height, in the two states it has.
 *
 * The 440 px box the owner photographed could not show an answer AND a composer,
 * which is half of why the composer was left out. The panel now GROWS with its
 * content — one step, because the panel has exactly two contents — and both
 * steps are bounded by a viewport fraction so a short window never gets a panel
 * taller than itself. The empty step's cap is the reference card's own 480 px
 * (`EditPopover` opens its container at 400x480), so a panel with nothing in it
 * is the same card the "+" opens. A fraction rather than a measured height on purpose: the
 * chat inside needs a definite height for its scroll area to scroll, and a
 * content-measured popover would have to give that up.
 */
export function sideQuestionPanelHeight(hasExchange: boolean): string {
  return hasExchange ? 'min(72vh, 640px)' : 'min(56vh, 480px)'
}

/**
 * The session's own composer capabilities, narrowed to what the panel's ask path
 * can actually carry.
 *
 * KEPT, because the row asks for it: `submit` (so the control queues or steers
 * exactly as the runtime does), `reasoning`, and everything else the runtime
 * reported. TURNED OFF, because the panel's ask is ONE STRING through
 * `sessionCommand({ type: 'sideQuestion' })` and nothing else rides with it:
 *
 * - `attachments` / `mentions` — a file picked here would be silently dropped,
 *   which is the advertised-and-unavailable shape `excludedCommandIds` exists in
 *   the protocol to prevent.
 * - `slash` — the panel is a question box, not a second command surface, and the
 *   row says the slash menu is not required. It also keeps `/btw` out of the
 *   panel's own menu.
 * - `connection` switching and the permission-mode control — both act on the
 *   REAL session, which this panel is deliberately not.
 * - `contextMeter` — the meter reads the real session's window; the synthetic
 *   session has none, so it would draw an empty donut.
 * - `backgroundShell` (UB14.34) — the ask is answered on the tool-less `queryLlm`
 *   route, so "Run in background" on a pasted snippet would reach a model that
 *   cannot run anything (the transcript's Run is withheld here for the same
 *   reason, `transcriptRunCommand`).
 *
 * `undefined` in, `undefined` out: an older server that reported no capabilities
 * must keep the composer's own conservative default rather than get an invented
 * one.
 */
export function sideQuestionComposerCapabilities(
  capabilities: ComposerCapabilities | undefined,
): ComposerCapabilities | undefined {
  if (!capabilities) return undefined
  const { backgroundShell: _noBackgroundShell, ...kept } = capabilities
  return {
    ...kept,
    attachments: { files: false, images: 'no', folders: false },
    mentions: { files: false, skills: false, sources: false },
    slash: { commandIds: [] },
    permissions: { ...capabilities.permissions, locked: true },
    connection: { ...capabilities.connection, switchable: false },
    contextMeter: false,
  }
}

/**
 * D1.384 — what a TYPED out-of-band command means inside the panel's composer.
 *
 * The panel's composer is a `FreeFormInput` like every other, so
 * `typedOutOfBandCommandSubmission` classifies `/btw`, `/recap` and `/heapdump`
 * there too — and every route behind that classification acts on the session id
 * the composer is mounted over, which here is the SYNTHETIC one. A `/btw`
 * typed inside the panel therefore asked a question of an id no server knows
 * and opened an overlay that is not mounted: silent, because
 * {@link isSideQuestionSessionId} already stops the panel nesting in itself.
 *
 * THE POSTURE (a product call, decided rather than queued — the documentation
 * describes a side question with no composer at all, which the owner overruled
 * on 2026-09-18): inside the panel there is nothing left to nest into, because
 * the panel already IS the side question. So a typed out-of-band command is
 * ORDINARY TEXT here — it is asked, visibly, never swallowed — with the single
 * exception that a `/btw ` prefix is stripped, since the user plainly means to
 * ask what follows it and a question opening with the command that opened the
 * panel is noise. `/recap` and `/heapdump` are text for the same reason they
 * cannot be commands here: both act on the REAL session, which this is not.
 *
 * Takes the ALREADY-PARSED command rather than re-parsing, so there is exactly
 * one classifier in the product (`parseSessionCommand`, through
 * `typedOutOfBandCommandSubmission`) and this cannot drift from it.
 */
export function nestedSideQuestionText(
  command: ReturnType<typeof typedOutOfBandCommandSubmission>,
  trimmedInput: string,
): string {
  if (command?.kind === 'btw') {
    const question = command.question.trim()
    if (question.length > 0) return question
  }
  return trimmedInput
}
