/**
 * Coerce untrusted composer/draft values into plain text.
 *
 * The renderer normally stores draft text as a string, but installed builds can
 * encounter stale or malformed persisted values (for example an entire draft
 * object, or an object in the `text` field). Keep input call sites defensive so
 * `.trim()` and rich-text rendering never receive a non-string value.
 */
export function coerceInputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof String) return value.toString()

  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return ''
}

/**
 * C3.363 — the composer's EMPTY-STATE FILLER, which is not a line break.
 *
 * ## What was measured, and what the row it came from got wrong
 *
 * R4's rig read the composer after a Pi `auth-request` turn and found `"\n"`
 * where it expected `""`. The attribution to that turn is REFUTED: the auth
 * card renders inline in the transcript (`ChatDisplay.tsx`, the `auth-request`
 * branch) and touches no composer state, the same reading is recorded against
 * `/compact` on 2026-07-31 in `scripts/cdp/lib/composer.ts`'s own
 * `selectSlashCommand` docblock, and the harness's fresh-session check compares
 * on `text.trim()`, so a bare newline never failed it.
 *
 * ## The narrow thing underneath, which IS real
 *
 * `rich-text-input.tsx` writes `innerHTML = html || '<br>'` in three places —
 * *"Empty contenteditable needs a BR"* — so an EMPTY value is stored in the DOM
 * as a lone `<br>`. Its reader, `getTextFromElement`, maps every `BR` to `'\n'`
 * unconditionally, so the round trip `'' → DOM → ''` is not the identity: it
 * yields `'\n'`. Chromium re-inserts exactly that lone `<br>` when the user
 * backspaces away the last character, and the next `input` event then sets the
 * value to `'\n'` for a composer the user just emptied.
 *
 * What that actually costs, stated rather than guessed: `hasContent` and the
 * send path both read `input.trim()`, so nothing wrong is SENT and the send
 * button stays correctly disabled. The visible half is the placeholder —
 * `showPlaceholder = !safeValue` — which never comes back, so a composer the
 * user emptied by hand keeps a blank prompt line and no hint, and every
 * consumer that does not trim (a persisted draft, a rig's read-back) sees it as
 * non-empty.
 *
 * ## Why a LONE child and nothing wider
 *
 * This predicate is the exact inverse of the one write it undoes, so it can be
 * proved rather than tuned: the component emits `'<br>'` when and only when the
 * rendered html is empty. Two `<br>`s are a user's blank line and must keep
 * their newline; a `<br>` after text is a real line break. RESIDUE, stated: a
 * browser that leaves a different filler shape (`<div><br></div>`, say) is not
 * covered, and deliberately — from the DOM alone that shape is
 * indistinguishable from a user's own empty line, and the value is trimmed
 * everywhere a decision is taken.
 */
export function isEmptyStateFiller(element: { childNodes: ArrayLike<{ nodeName: string }> }): boolean {
  return element.childNodes.length === 1 && element.childNodes[0]?.nodeName === 'BR'
}

/**
 * Combine an existing input draft with text being restored (e.g. the last
 * user message put back on Stop). Appends with a blank line so a half-typed
 * draft isn't clobbered; returns the non-empty side when the other is empty.
 */
export function appendRestoredInput(existing: string | undefined, restored: string | undefined): string {
  const existingText = coerceInputText(existing)
  const restoredText = coerceInputText(restored)
  if (!restoredText) return existingText
  return existingText ? `${existingText}\n\n${restoredText}` : restoredText
}

/** The shape {@link restoredPromptAfterStop} reads. Structural on purpose: this
 *  module is a leaf, and importing the renderer's `Message` would tie it to the
 *  whole transcript type for three fields. */
export interface StoppedTurnMessage {
  role: string
  content?: unknown
  isQueued?: boolean
  /** F1.732 — accepted by the host as a steer into the running turn (`handleUserMessage`). */
  steered?: boolean
  /** UB12.45 — a host-sent row that drives a turn but never renders (UB2.14, `Message.hidden`). */
  hidden?: boolean
}

/**
 * F1.89 / D1.393 — what an explicit Stop puts back in the composer, and WHEN IT
 * PUTS BACK NOTHING.
 *
 * An explicit Stop deliberately refills the composer with the in-flight prompt
 * so the user can tweak and resend (`ChatDisplay.handleStop(silent=false)`, the
 * flow `input/submit-control.ts` guards the button for). That is right when the
 * Stop is all the user asked for. It is WRONG when a follow-up is queued behind
 * the turn, and SIT-7 measured what it costs: after a Stop with a message
 * queued, the session starts another turn re-sending the ORIGINAL prompt while
 * the queued message keeps `isQueued` and is never answered — the model's own
 * next words were *"The user re-sent the task"*.
 *
 * THE READING D1.393 ASKED FOR — which of the two supplies the re-sent turn:
 *
 * - NOT the host's queue drain. `SessionManager.cancelProcessing` sets
 *   `queuePaused = true` whenever the queue is non-empty (D1.376), so
 *   `onProcessingStopped`'s step 5 takes the else-arm and `processNextQueuedMessage`
 *   never runs; and when it does run it sends the QUEUED entry's own text, never
 *   the original prompt. The parked message stays visible with its paused banner
 *   (`input/QueuedMessageList.tsx`), which is the D1.376 posture, not a defect.
 * - THE RESTORE. It is the only producer of the original prompt's text after a
 *   Stop, and it skips queued messages while choosing — so with a follow-up
 *   parked it reaches PAST it and refills the composer with the very prompt the
 *   user just stopped, one Enter away from being sent again, and in front of
 *   whatever they type next (`appendRestoredInput` joins with a blank line).
 *
 * So the restore declines when a user message is still queued: the user's next
 * intent is already parked, and the composer belongs to it. With nothing queued
 * the tweak-and-resend flow is untouched, which is this row's control.
 *
 * UB12.45 — a HIDDEN user row (UB2.14: today only the source-activation
 * auto-retry, `<original>\n\n[<slug> activated]`) is the host's, never the
 * user's words, so the scan steps over it to the visible prompt it restates;
 * restoring it put the activation suffix in the composer. A DEVIATION from
 * upstream v0.15.1, whose `handleStop` reads the newest non-queued user row
 * unfiltered. Two boundaries, both deliberate: the F1.89 queued check still
 * counts a hidden row (a parked retry is a send already scheduled, so restoring
 * its original would make a second copy), and stepping over a hidden row can
 * land on a steer the activated turn accepted, which declines as F1.732 says.
 */
export function restoredPromptAfterStop(
  messages: readonly StoppedTurnMessage[] | undefined,
): string | undefined {
  if (!messages || messages.length === 0) return undefined
  // A user message still carrying `isQueued` is one the host is holding right
  // now: the flag is cleared the moment a queued message is replayed.
  if (messages.some(message => message.role === 'user' && message.isQueued === true)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (message.hidden === true) continue // UB12.45 — the host's own row; the visible prompt behind it is the user's
    // F1.732 — a STEER is the host's after a Stop: an undelivered one is re-queued into the paused
    // queue (SIT-f C4 measured both copies, so Enter after Resume sent it twice), a delivered one is
    // part of the stopped turn. One copy, the queued one — the composer is left alone.
    if (message.steered === true) return undefined
    return coerceInputText(message.content) || undefined
  }
  return undefined
}

/**
 * F1.181 — what the composer holds after a Stop, the WHOLE decision in one
 * place: `ChatDisplay.handleStop` calls this and applies the answer, so the
 * seam is driven by unit tests instead of a rendered `ChatDisplay` (~136 s
 * under bun) or a slice of its source.
 *
 * `undefined` means "leave the composer alone". A restore happens only on an
 * explicit Stop (`silent` is the redirect path — a new message is being sent)
 * of a turn actually in flight, and only when {@link restoredPromptAfterStop}
 * finds a prompt to put back — which it declines while a follow-up is queued
 * (F1.89). The prompt joins a half-typed draft below a blank line
 * ({@link appendRestoredInput}).
 */
export function composerTextAfterStop(input: {
  silent: boolean
  isProcessing: boolean | undefined
  messages: readonly StoppedTurnMessage[] | undefined
  inputValue: string | undefined
}): string | undefined {
  if (input.silent || input.isProcessing !== true) return undefined
  const restoredText = restoredPromptAfterStop(input.messages)
  if (!restoredText) return undefined
  return appendRestoredInput(input.inputValue, restoredText)
}

/**
 * UB12.45 — the user message an error row's Retry resends (`ChatDisplay`, the
 * `onRetry` it hands an error bubble): the newest user row BEFORE the error,
 * skipping a hidden one (UB2.14). The source-activation auto-retry is sent
 * hidden, so the old pick resent `<original>\n\n[<slug> activated]` as a
 * VISIBLE message — a bubble with the host's suffix in the user's words. The
 * visible prompt the hidden row restates is what the user asked, so that is
 * what Retry sends.
 *
 * A DEVIATION from upstream v0.15.1, whose ChatDisplay reads
 * `msgs.slice(0, errorIdx).findLast(m => m.role === 'user')` unfiltered; the
 * slice is kept as upstream wrote it (an unknown error id scans all rows but
 * the last). Generic so the call site keeps the transcript's own `Message`.
 */
export function userMessageToRetry<T extends { id: string; role: string; hidden?: boolean }>(
  messages: readonly T[],
  errorId: string,
): T | undefined {
  const errorIdx = messages.findIndex(message => message.id === errorId)
  return messages.slice(0, errorIdx).findLast(message => message.role === 'user' && message.hidden !== true)
}
