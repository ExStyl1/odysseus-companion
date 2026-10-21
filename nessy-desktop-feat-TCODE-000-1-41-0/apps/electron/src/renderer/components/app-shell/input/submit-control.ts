/**
 * What the composer's one primary control is, at any moment: Send, Queue,
 * Steer, Stop — or Loading — and whether it is allowed to act at all.
 *
 * The mode used to be a bare ternary inside `FreeFormInput`, and it carried a
 * defect that only shows up on the Stop path (L11). `Stop` is offered when a
 * turn is running and the composer is EMPTY. But an explicit Stop deliberately
 * refills the composer: `ChatDisplay.handleStop(silent=false)` puts the
 * in-flight prompt back so the user can tweak and resend. The instant that
 * restore lands, `hasContent` is true while `isProcessing` is STILL true —
 * `cancelProcessing` is an async round trip and the turn only settles on its
 * terminal event — so the mode flipped straight from `stop` to `queue`/`steer`.
 *
 * That means the button MUTATED UNDER THE USER'S FINGER: a second press of the
 * control they had just pressed to stop the turn re-sent the stopped prompt into
 * the still-winding-down turn. `stopRequestedFor` closes that window — while a
 * stop this composer issued is in flight, the control stays a Stop and is inert
 * (it must not re-issue the stop either, or `handleStop` appends the restored
 * prompt to the composer a second time).
 *
 * Deliberately NOT covered here: the Enter key. Enter after Stop is the
 * "tweak and resend" flow the restore exists for, and leaving it live means a
 * session whose terminal event never arrives is never send-locked.
 *
 * F1.92 / D1.397 — A COMPOSER OVER A SESSION THE HOST DOES NOT OWN. Two
 * surfaces mount a whole composer over an id the renderer minted: the `/btw`
 * panel (`side-question:<real id>`) and `EditPopover`'s inline mode (the stub
 * `'pending'`). No server session answers either, so a Stop there would call
 * `cancelProcessing` with an id nothing knows. The panel therefore kept
 * `isProcessing: false` and said "thinking" in WORDS in its message list,
 * because the composer's own affordance was not available to it.
 *
 * So the control takes {@link SubmitControlInput.disableStop} — never a Stop,
 * whatever else is true — and it DEFAULTS from the id itself through
 * {@link isRendererMintedSessionId}, which is D1.383's one spelling of "the
 * renderer minted this". A call site that forgets the flag still cannot arm a
 * Stop no server would answer; a compact embedding that wants the posture
 * without a minted id passes the flag.
 *
 * And such a surface needs an in-flight signal of its own, because
 * `isProcessing` belongs to a session the host runs:
 * {@link SubmitControlInput.awaitingAnswer}. `FreeFormInput` feeds it
 * `disableSend`, whose ONE setter in this tree is the `/btw` panel's
 * `disableSend={pending}` — "one question at a time, the ring holds one
 * in-flight exchange". It is read ONLY for a stop-disabled composer, so it can
 * never change what a real session's control does.
 *
 * F1.179 — AND THEN THE PANEL DID REPORT `isProcessing`. F1.92 measured two
 * blockers and left the flip to its own row: `ChatDisplay`'s
 * `chat.backgroundInFlightTask` chord (gated on `isProcessing` alone, so it
 * would `sessionCommand` an id no server knows) now asks `isHostTurnInFlight`
 * in `./stub-session`, and the thread no longer forks a "thinking" word beside
 * the `ProcessingIndicator` the processing session draws. Nothing changes HERE:
 * a minted id with a turn in flight was already `loading` — the branch below is
 * now the live path for the panel rather than the defensive one.
 */

import type { QueuedMessageDto } from '@nessy-agent/shared/protocol'
import { isRendererMintedSessionId } from './stub-session'

export type SubmitMode = 'send' | 'queue' | 'steer' | 'stop' | 'loading'

export interface SubmitControlInput {
  /** The session has a turn in flight, per the server's own session state. */
  isProcessing: boolean
  /** Composer text, attachments or follow-up items are present. */
  hasContent: boolean
  /** The runtime can queue a message behind the running turn (else: steer). */
  queueSupported: boolean
  /** The session the composer is currently showing. */
  sessionId?: string
  /**
   * The session an explicit Stop was issued for and has not settled yet, or
   * `null`/`undefined` when there is none. Scoped to a session because the
   * composer is NOT remounted on a session switch: a stop issued on session A
   * must not leave session B's button inert.
   */
  stopRequestedFor?: string | null
  /**
   * This composer must never offer a Stop. True by default for an id the
   * RENDERER minted (see the header); pass it explicitly for a compact
   * embedding that wants the same posture over some other id.
   */
  disableStop?: boolean
  /**
   * The surface this composer belongs to is waiting for an answer of its own.
   * Read ONLY when the control is stop-disabled — it is the in-flight signal a
   * host-unknown session has instead of `isProcessing`.
   */
  awaitingAnswer?: boolean
  /**
   * F1.331 — files are staged. The host never steers a payload with files
   * (F1.244, `canSteerTextPayload` in `server-core/src/sessions/mid-stream-interruption.ts`:
   * a steer is a text door on all three runtimes), so a mid-turn send of this
   * draft is QUEUED whatever the connection's default, and the control says so.
   */
  hasAttachments?: boolean
  /**
   * F1.481 (3) — the queue already holds a row the host will not steer (files,
   * a workflow — {@link isUnsteerableQueueRow}). Since F1.338 the host keeps a
   * mid-turn send behind such a row in FIFO order (`queueHoldsUnsteerablePayload`
   * in `effectiveMidStreamBehavior`), so a TEXT draft is queued too — and the
   * control says Queue, where it used to say Steer and then queue.
   */
  queueHoldsUnsteerableRow?: boolean
}

/**
 * F1.481 (2)(3) — a queued row the host keeps queued when Steer is pressed
 * mid-turn: `steerable === false` is the host's own verdict (`queueDto`, from
 * `sendQueuedNow`'s predicate); `attachmentsCount > 0` answers the same for an
 * older host that sends no verdict.
 */
export function isUnsteerableQueueRow(row: Pick<QueuedMessageDto, 'attachmentsCount' | 'steerable'>): boolean {
  return row.steerable === false || row.attachmentsCount > 0
}

export interface SubmitControl {
  mode: SubmitMode
  /**
   * The control must not act on a press. True only while a stop issued from
   * this composer is still in flight, or while a stop-disabled composer is
   * waiting for its own answer.
   */
  inert: boolean
}

export function resolveSubmitControl(input: SubmitControlInput): SubmitControl {
  if (input.disableStop === true || isRendererMintedSessionId(input.sessionId ?? '')) {
    if (input.isProcessing || input.awaitingAnswer === true) return { mode: 'loading', inert: true }
    return { mode: 'send', inert: false }
  }
  if (!input.isProcessing) return { mode: 'send', inert: false }
  if (
    input.stopRequestedFor != null
    && input.stopRequestedFor === (input.sessionId ?? '')
  ) {
    return { mode: 'stop', inert: true }
  }
  if (!input.hasContent) return { mode: 'stop', inert: false }
  return { mode: input.queueSupported || input.hasAttachments === true || input.queueHoldsUnsteerableRow === true ? 'queue' : 'steer', inert: false }
}
