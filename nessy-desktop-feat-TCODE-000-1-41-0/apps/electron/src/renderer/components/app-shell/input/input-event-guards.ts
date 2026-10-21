export interface ScopedInputEventTarget {
  sessionId?: string | null
  isFocusedPanel: boolean
  targetSessionId?: string
}

/**
 * Decide whether an input-affecting custom event should be handled by
 * this FreeFormInput instance.
 */
export function shouldHandleScopedInputEvent({
  sessionId,
  isFocusedPanel,
  targetSessionId,
}: ScopedInputEventTarget): boolean {
  if (targetSessionId) {
    return targetSessionId === sessionId
  }
  return isFocusedPanel
}

// ── UA1.13 — Up-arrow in an empty composer during a turn stops it ────────────
//
// Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/input/input-event-guards.ts
// (craft-agents-oss, Apache-2.0; upstream v0.11.2), adapted in two places, both
// Nessy-specific and both narrowing:
//   1. `stopAvailable` — the Stop button's own gate (`resolveSubmitControl`:
//      mode `stop` and not inert), so the key never stops where the button would
//      not: a Stop already in flight, or a renderer-minted chat (`/btw`) that has
//      no turn of its own to stop.
//   2. The owner's condition (OQ-20 item 1, 2026-09-23): a draft that double-Esc
//      cleared (P2.447, `./double-escape`) and that is waiting for `Up` keeps
//      today's behaviour — `Up` restores it and the turn is NOT stopped. That
//      precedence lives at the call site (`FreeFormInput.handleKeyDown` runs
//      `recallClearedDraft()` FIRST, `||`-short-circuited before
//      {@link stopTurnOnArrowUp}), because the history is component state.

export interface RecallPromptArrowUpState {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing: boolean
  isProcessing: boolean
  input: string
  attachmentCount: number
  loadingAttachmentCount: number
  followUpItemCount: number
  inlineMenuOpen: boolean
  disabled: boolean
  disableSend: boolean
  /** Nessy: the Stop button would act now (`submitControl.mode === 'stop' && !submitControl.inert`). */
  stopAvailable: boolean
}

/**
 * Plain Arrow Up recalls/cancels only when there is truly no editable draft.
 * Whitespace, attachments, loading files, and follow-up context are all content.
 */
export function shouldRecallPromptOnArrowUp({
  key,
  shiftKey,
  metaKey,
  ctrlKey,
  altKey,
  isComposing,
  isProcessing,
  input,
  attachmentCount,
  loadingAttachmentCount,
  followUpItemCount,
  inlineMenuOpen,
  disabled,
  disableSend,
  stopAvailable,
}: RecallPromptArrowUpState): boolean {
  return key === 'ArrowUp'
    && !shiftKey
    && !metaKey
    && !ctrlKey
    && !altKey
    && !isComposing
    && isProcessing
    && !disabled
    && !disableSend
    && input === ''
    && attachmentCount === 0
    && loadingAttachmentCount === 0
    && followUpItemCount === 0
    && !inlineMenuOpen
    && stopAvailable
}

/**
 * Run `stop` when {@link shouldRecallPromptOnArrowUp} fires; report whether the
 * key was consumed. `stop` is the caller's Stop-button path — upstream's
 * `handleStop()`; ours is `handleStop(false)`, a NON-silent stop, which is what
 * makes `ChatDisplay.handleStop` put the stopped prompt back in the input
 * (`composerTextAfterStop`, F1.181).
 */
export function stopTurnOnArrowUp(state: RecallPromptArrowUpState, stop: () => void): boolean {
  if (!shouldRecallPromptOnArrowUp(state)) return false
  stop()
  return true
}
