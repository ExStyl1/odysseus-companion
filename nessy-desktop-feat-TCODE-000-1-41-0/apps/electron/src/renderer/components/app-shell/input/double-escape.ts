/**
 * P2.447 — double-Esc in the composer: the SECOND documented way to open the
 * rewind menu, the branch that clears the draft instead, and the input history
 * that makes the clear recoverable.
 *
 * `checkpointing.md#rewind-and-summarize` specifies all three, and the second
 * sentence is the half that gets forgotten:
 *
 *   "Run `/rewind`, or press `Esc` twice when the prompt input is empty, to
 *    open the rewind menu."
 *   "If the prompt input contains text, double `Esc` clears it instead of
 *    opening the menu. The cleared text is saved to your input history, so
 *    press `Up` to recall it after you finish in the rewind menu."
 *
 * So there are three behaviours, not one: OPEN when empty, CLEAR when not, and
 * the cleared text must actually land somewhere `Up` can reach.
 *
 * ── MECHANISM, and it is a decision rather than the obvious route ────────────
 *
 * This is a COMPONENT BEHAVIOUR of the composer, deliberately NOT an entry in
 * the hotkey override map (`../../../actions/hotkey-overrides.ts`). P6.49's map
 * canonicalises a binding to ONE accelerator — modifiers plus a single key —
 * and has no grammar for a double press. `escape` is a perfectly valid stored
 * value there, which is exactly what makes the map look applicable when it is
 * not: an action bound to `escape` fires on the FIRST press, so the map can
 * express "Esc" and can never express "Esc Esc". Extending that grammar to
 * sequences is a much larger change (every consumer of `normalizeHotkey`, the
 * collision report, the rebind recorder) and P6.49 already measured that the
 * recorder treats `Escape` as CANCEL, so the chord could not be recorded even
 * if the grammar could hold it.
 *
 * PRODUCT STATEMENT, said here rather than left to be discovered: **`Esc Esc`
 * in the composer is NOT user-rebindable.** It does not appear on the Shortcuts
 * page, `keybindings.json` cannot move it, and unbinding `chat.stopProcessing`
 * does not unbind this. That is the price of the small mechanism, and the two
 * ways out are both bigger than the behaviour: a sequence grammar in the map,
 * or a window-level Escape consumer racing the composer's own handler and the
 * action registry.
 *
 * A window-level consumer is refused for the reason P2.425 refused it: the
 * registry already owns a capture-phase `window` keydown listener that calls
 * `stopPropagation()` when a bound action's `enabled()` passes, so a second
 * window listener would be racing a mechanism whose outcome depends on which
 * one was added first. Living inside the composer's own `onKeyDown` puts this
 * behaviour DOWNSTREAM of that listener by construction.
 *
 * ── THE CONSEQUENCE OF BEING DOWNSTREAM, which is a feature ──────────────────
 *
 * `chat.stopProcessing` is bound to `escape` by default and its `enabled()`
 * returns true only while the session is processing. So while a turn is running
 * the registry consumes Escape in the capture phase and this behaviour never
 * fires — the interrupt wins mid-turn, which is the precedence a user expects
 * and the one the interrupt overlay already advertises. `/rewind` still opens
 * the menu mid-turn (`ChatDisplay.handleSubmit` intercepts it ungated), so the
 * documented capability is not lost while a turn runs; only this keyboard route
 * to it is, and it is lost to a louder documented behaviour.
 *
 * ── DEPTH, and what this history is NOT ──────────────────────────────────────
 *
 * There is no input history in this product to save into: `promptHistory`,
 * `inputHistory`, `recentPrompts` and an `ArrowUp` recall in the composer all
 * measured ZERO before this row (positive control: `ArrowUp` itself is present
 * across the renderer, and the composer's three inline menus intercept it). So
 * the history is built here, and it is built to the sentence rather than to the
 * CLI: its ONLY writer is the double-Esc clear below. Submitted prompts are NOT
 * recorded, it is in-memory for the composer's lifetime, and it is dropped on a
 * session switch — the composer is not remounted when the session changes, so
 * without that drop one session's cleared draft would be recallable in another.
 * Named as scope, not oversight: a general prompt history with multi-step recall
 * is a separate feature and this module is not it.
 *
 * ── THE DIVERGENCE, decided rather than missed (C3.77, owner QF11=B, 2026-09-11)
 *
 * `interactive-mode.md#reverse-search-with-ctrl+r` binds a cross-session prompt
 * history, and this product REFUSES it. The page, verbatim: *"In fullscreen
 * rendering, `Ctrl+R` opens a search dialog instead: type to filter, press `Up`
 * and `Down` to move through matches, and press `Ctrl+S` to cycle the scope
 * through this session, this project, and all projects."*
 *
 * The cost is stated at full size rather than trimmed: SCOPE IS THE FEATURE
 * there, so refusing cross-session recall refuses the documented capability
 * whole, not a corner of it. What is kept is the narrow thing above — in memory,
 * for the composer's lifetime, within one session.
 *
 * The reason sits here because this is where the behaviour is decided: the
 * history ref is dropped on a session switch (the composer is NOT remounted when
 * the session changes), and a prompt typed in one conversation must not surface
 * in another. Nothing reaches disk on any path, so the never-persist environment
 * spellings keep exactly the meaning they already have — there is no new store
 * for them to be asked about.
 *
 * Native-first, asked and answered: no runtime publishes a cross-session prompt
 * store a host could read. The composer is ours; the vendor's own prompt history
 * belongs to its CLI REPL rather than to a hosted SDK session. So the refusal
 * leaves no native lever unwired, and the register carries it as a product
 * divergence (`docs/superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md`,
 * the `interactive-mode` row of the corpus table).
 */

/**
 * How long the first Escape stays armed.
 *
 * 2 s, matching `ESC_TIMEOUT_MS` in `@/context/EscapeInterruptContext` — the
 * app's other double-Esc. One product, one double-press feel; a composer that
 * wanted 400 ms while the interrupt wanted 2 000 ms would teach the user two
 * different Escapes.
 */
export const DOUBLE_ESCAPE_WINDOW_MS = 2000

/** Entries kept. A recall reads the head, so depth exists for future recall
 * steps rather than for this row; the cap is what stops an unbounded ref. */
export const COMPOSER_INPUT_HISTORY_LIMIT = 20

export type DoubleEscapeOutcome =
  /** First press (or the window expired): remember it and do nothing visible. */
  | { kind: 'arm'; armedAt: number }
  /** Second press with text in the input — `checkpointing.md`'s clear branch. */
  | { kind: 'clear-draft'; armedAt: null }
  /** Second press with an empty input — `checkpointing.md`'s opener branch. */
  | { kind: 'open-rewind-menu'; armedAt: null }
  /**
   * F1.166 — the same second press in a chat that has NO rewind to open (a
   * renderer-minted session: the `/btw` panel's synthetic id, `EditPopover`'s
   * stub). Nothing happens: the opener works by submitting `/rewind`, and since
   * F1.87 a `/rewind` in such a chat is sent as ordinary text — right for text
   * the user typed, a question they never asked when the chord made it up.
   */
  | { kind: 'decline'; armedAt: null }

/**
 * Decide what one Escape press in the composer means.
 *
 * `armedAt` is the caller's stored timestamp of the previous press, or `null`
 * for "not armed"; the returned `armedAt` is what the caller must store next,
 * so the state machine has exactly one owner of that transition.
 */
export function resolveDoubleEscape(input: {
  now: number
  armedAt: number | null
  /** Whether the prompt input "contains text" — `checkpointing.md`'s wording. */
  hasDraftText: boolean
  /**
   * F1.166 — whether this chat has a rewind to open. Defaults to true, the main
   * composer's case; the caller passes false for a renderer-minted session.
   * Only the opener reads it: the clear branch belongs to the draft.
   */
  rewindAvailable?: boolean
}): DoubleEscapeOutcome {
  const { now, armedAt, hasDraftText, rewindAvailable = true } = input

  // `now - armedAt >= 0` is not paranoia about arithmetic: `Date.now()` is a
  // wall clock and can step BACKWARDS (NTP correction, a laptop waking with a
  // corrected clock). Without it a backwards step leaves the composer armed for
  // as long as the offset lasts, and the next lone Escape silently wipes a
  // draft. A backwards step re-arms instead.
  if (armedAt === null) return { kind: 'arm', armedAt: now }
  const elapsed = now - armedAt
  if (elapsed < 0 || elapsed > DOUBLE_ESCAPE_WINDOW_MS) return { kind: 'arm', armedAt: now }

  if (hasDraftText) return { kind: 'clear-draft', armedAt: null }
  return rewindAvailable
    ? { kind: 'open-rewind-menu', armedAt: null }
    : { kind: 'decline', armedAt: null }
}

/**
 * Record a cleared draft. Returns a new array — the caller holds this in a ref,
 * and a mutated array would let a stale render see the new head.
 *
 * The text is stored RAW, not trimmed: a recall should hand back what was
 * cleared, trailing newlines and all. Whitespace-only drafts are not recorded
 * (they are not text the user would want back), and a repeat of the current
 * head is not duplicated — clear, recall with `Up`, clear again is the
 * documented round trip and it must not grow the history by one each lap.
 */
export function pushComposerInputHistory(
  entries: readonly string[],
  text: string,
): string[] {
  if (text.trim().length === 0) return [...entries]
  if (entries[0] === text) return [...entries]
  return [text, ...entries].slice(0, COMPOSER_INPUT_HISTORY_LIMIT)
}

/**
 * What `Up` should put back, or `null` for "leave the key alone".
 *
 * Recall happens ONLY into an EMPTY input, and the reason is the composer this
 * lives in: it is multi-line, so `Up` is caret movement. An input with any
 * content — including a lone newline — has a caret with somewhere to go, and
 * stealing that to serve a recall the page never asked for would break ordinary
 * editing. An empty input has no caret movement to steal, which is precisely
 * the state the documented round trip leaves behind.
 */
export function recallComposerInputHistory(input: {
  entries: readonly string[]
  draftText: string
}): string | null {
  if (input.draftText.length > 0) return null
  return input.entries[0] ?? null
}
