/**
 * The composer, and the slash palette that hangs off it.
 *
 * The composer is a contenteditable (`rich-text-input.tsx`: role="textbox",
 * aria-multiline="true"). The palette is `InlineSlashCommand`
 * (`slash-command-menu.tsx`): container `[data-inline-menu]`, one row per item,
 * the highlighted row carrying `data-selected="true"`, keyboard nav bound on
 * `document` keydown.
 *
 * The rule this module encodes: **a command is a command only once its palette
 * entry is SELECTED.** Typing the literal text and pressing Enter submits prose,
 * which is how a fork that never started was recorded as a pass.
 */

import type { CdpSession } from './connect.ts'
import { pressKey, typeText, type TypeOptions } from './keys.ts'

/**
 * The chat composer. `FreeFormInput` passes `data-tutorial="chat-input"` through
 * to the contenteditable itself, which is the only stable hook on it.
 *
 * One of these exists PER CONTENT PANEL, so a multi-panel layout has several.
 * `focusComposer` refuses rather than guessing which one the case meant.
 */
export const COMPOSER_SELECTOR = 'div[data-tutorial="chat-input"][role="textbox"][aria-multiline="true"]'
export const PALETTE_SELECTOR = '[data-inline-menu]'

export interface PaletteItem {
  index: number
  text: string
  selected: boolean
}

export interface PaletteState {
  open: boolean
  items: PaletteItem[]
  selectedIndex: number
}

/**
 * Focus the composer and put the caret at the end of its text.
 *
 * ## `composer-not-focusable` used to name THREE different situations at once
 *
 * C5.24, 2026-09-12, packaged `70d269e46`. The old message was *"no element
 * matched `<selector>`, or focus did not take"* — a sentence a reader cannot
 * act on, because the three things it covers have three different remedies, and
 * one of them is not about the composer at all:
 *
 *  1. **No element matched.** The pane is not showing a chat, or it re-mounted.
 *  2. **An `aria-hidden` / `inert` ANCESTOR.** `HTMLElement.focus()` is a silent
 *     no-op inside such a subtree, so the element is present, visible, and
 *     `contenteditable`, and focus still does not move. Reproduced deliberately:
 *     with the workspace picker's Radix menu open, the pane ancestor
 *     `h-full overflow-hidden relative @container/panel` carries
 *     `aria-hidden="true"`, `document.activeElement` stays on the popover, and
 *     one Escape puts everything back. Every Radix layer this app opens —
 *     dropdown, select, context menu — does the same thing, so ANY case that
 *     types after opening one can meet it.
 *  3. **The element refused focus.** Present, no blocker, still not active.
 *
 * The remedy differs every time: wait for the pane, dismiss the layer, or look
 * at the element. `rs-05`'s own docblock records this failure being attributed
 * to a standing chat-pane dialog — and that attribution is REFUTED at HEAD on
 * the packaged build: with the Rewind dialog up, `focus()` takes and `typeText`
 * works. Naming the blocker is what stops the next lane guessing.
 */
export async function focusComposer(session: CdpSession, selector = COMPOSER_SELECTOR): Promise<void> {
  const outcome = await session.call<{ ok: boolean; reason: string; blocker?: string; active?: string }>(`
    const all = document.querySelectorAll(${JSON.stringify(selector)})
    if (all.length > 1) throw new Error('ambiguous-composer: ' + all.length + ' composers on screen (multi-panel layout) — close the extra panels, a case must not guess which one it is driving')
    const el = all[0]
    if (!el) return { ok: false, reason: 'no-element' }
    // The blocker is read BEFORE focus() is called, because an aria-hidden
    // subtree swallows the call rather than reporting it.
    let blocker
    for (let p = el; p && !blocker; p = p.parentElement) {
      if (p.hasAttribute && (p.hasAttribute('inert') || p.getAttribute('aria-hidden') === 'true')) {
        blocker = (p.tagName || '?') + '.' + String(p.className || '').slice(0, 60)
          + (p.hasAttribute('inert') ? ' [inert]' : ' [aria-hidden]')
      }
    }
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    if (document.activeElement === el) return { ok: true, reason: 'focused' }
    const active = document.activeElement
      ? (document.activeElement.tagName || '?') + '.' + String(document.activeElement.className || '').slice(0, 60)
      : 'null'
    return { ok: false, reason: blocker ? 'hidden-ancestor' : 'refused', blocker, active }
  `)
  if (outcome.ok) return
  if (outcome.reason === 'no-element') {
    throw new Error(`composer-not-focusable: no element matched ${selector} — the pane is not showing a chat`)
  }
  if (outcome.reason === 'hidden-ancestor') {
    throw new Error(
      `composer-not-focusable: the composer is inside a hidden subtree, so focus() is a no-op — ${outcome.blocker}. `
        + `Focus is on ${outcome.active}. An open Radix layer (dropdown, select, context menu) marks the rest of the app `
        + 'aria-hidden; dismiss it (Escape) before typing.',
    )
  }
  throw new Error(`composer-not-focusable: the element matched ${selector} and refused focus; focus is on ${outcome.active}`)
}

export async function readComposer(session: CdpSession, selector = COMPOSER_SELECTOR): Promise<string> {
  return session.call<string>(`
    const el = document.querySelector(${JSON.stringify(selector)})
    return el ? (el.innerText ?? el.textContent ?? '') : ''
  `)
}

/** Clear the composer with real Backspace presses, so React state follows. */
export async function clearComposer(session: CdpSession, selector = COMPOSER_SELECTOR): Promise<void> {
  await focusComposer(session, selector)
  const current = await readComposer(session, selector)
  for (let i = 0; i < current.length + 4; i += 1) {
    if ((await readComposer(session, selector)).length === 0) break
    await pressKey(session, 'Backspace')
  }
  const left = await readComposer(session, selector)
  if (left.trim().length > 0) throw new Error(`composer-not-cleared: still holds ${JSON.stringify(left)}`)
}

/** The text's non-empty lines, joined — the shape {@link pasteIntoComposer} compares (UA12.180). */
export function nonEmptyLines(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').filter(line => line.length > 0).join('\n')
}

/**
 * Paste `text` into the composer through the app's OWN paste path (UA12.166).
 *
 * The composer drops every CDP-TYPED newline — four synthetic key shapes measured on both RCs, none inserts a line
 * break (SIT-R's repro: a 21-line prompt arrived with every newline gone; single-line typing is perfect). The real
 * multi-line path is the composer's paste handler (`rich-text-input.tsx` `handlePasteInternal`): plain text from the
 * clipboard, inserted with `document.execCommand('insertText')`. So this dispatches a genuine `paste`
 * ClipboardEvent carrying the text as `text/plain`, and the APP's own handler performs the insert — no text is
 * inserted behind the app's back. That handler turns a paste longer than its 100-line threshold into a file
 * attachment; the read-back below refuses (an empty composer) before anything could be sent.
 *
 * The read-back compares the NON-EMPTY LINES, in order (UA12.180), not the exact string: innerText reads each blank
 * line the paste inserts (`<div><br></div>`) as TWO newlines — measured on Electron 39.8.10 by the 2026-10-08
 * verification: 'a\n\nb' reads back 'a\n\n\nb', 'a\n' reads back 'a\n\n' — so an exact compare refused RS-114
 * arm A's own prompt on every run, while the app's `getTextFromElement` reads that DOM back right. The line compare
 * still refuses the two real failures: merged lines (a newline dropped) and an empty composer (the long-paste
 * attachment). It does not police blank-line counts; `sendPrompt`'s whitespace-normalised compare sits on top.
 */
export async function pasteIntoComposer(session: CdpSession, text: string, selector = COMPOSER_SELECTOR): Promise<void> {
  await focusComposer(session, selector)
  const dispatched = await session.call<boolean>(`
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const data = new DataTransfer()
    data.setData('text/plain', ${JSON.stringify(text)})
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return true
  `)
  if (!dispatched) {
    throw new Error(`composer-paste-failed: no element matched ${selector}, so there was nothing to paste into`)
  }
  const readBack = await readComposer(session, selector)
  if (nonEmptyLines(readBack) !== nonEmptyLines(text)) {
    throw new Error(
      `composer-paste-mismatch: pasted ${JSON.stringify(text)}, composer holds ${JSON.stringify(readBack)}. `
        + 'The app\'s paste handler did not insert the same lines (its long-paste threshold turns a big paste '
        + 'into a file attachment — see rich-text-input.tsx).',
    )
  }
}

/**
 * Type into the composer with real key events — or, when the text carries newlines, paste it through the app's own
 * paste path ({@link pasteIntoComposer}, UA12.166): the composer drops every CDP-typed newline (four key shapes
 * measured on both RCs, SIT-R), and Enter-as-a-keypress would SUBMIT, not break the line. Single-line prompts keep
 * the faithful per-character key events the slash palette depends on.
 */
export async function typeIntoComposer(session: CdpSession, text: string, options: TypeOptions = {}): Promise<void> {
  await focusComposer(session)
  if (text.includes('\n')) {
    await pasteIntoComposer(session, text)
    return
  }
  await typeText(session, text, options)
}

/**
 * Wait for the palette to open, rather than sampling once and giving up.
 *
 * `useInlineSlashCommand` filters asynchronously — the command set is assembled
 * from workspace, project and plugin sources — so the menu can take well over a
 * frame to appear, and how long depends on what is loaded. A single read a fixed
 * 250ms after the last keystroke reported "palette-did-not-open" for a palette
 * that opened moments later, and failed a case for it. Poll instead.
 */
export async function waitForPalette(session: CdpSession, timeoutMs = 8_000): Promise<PaletteState> {
  const deadline = Date.now() + timeoutMs
  let last = await paletteState(session)
  while (!last.open && Date.now() < deadline) {
    await Bun.sleep(150)
    last = await paletteState(session)
  }
  return last
}

export async function paletteState(session: CdpSession): Promise<PaletteState> {
  return session.call<PaletteState>(`
    const menu = document.querySelector(${JSON.stringify(PALETTE_SELECTOR)})
    if (!menu) return { open: false, items: [], selectedIndex: -1 }
    const rows = Array.from(menu.querySelectorAll('[data-selected]'))
    const items = rows.map((el, index) => ({
      index,
      text: (el.innerText ?? el.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      selected: el.getAttribute('data-selected') === 'true',
    }))
    return { open: items.length > 0, items, selectedIndex: items.findIndex(i => i.selected) }
  `)
}

/**
 * The key presses that move the palette highlight from `fromIndex` to
 * `toIndex` and commit it. Pure — unit tested.
 *
 * The palette wraps in both directions (`slash-command-menu.tsx`: ArrowDown past
 * the end goes to 0, ArrowUp past the start goes to the last), so the shorter of
 * the two directions is taken.
 */
export function paletteKeySequence(fromIndex: number, toIndex: number, itemCount: number): string[] {
  if (itemCount <= 0) throw new Error('paletteKeySequence: palette has no items')
  if (fromIndex < 0 || fromIndex >= itemCount) throw new Error(`paletteKeySequence: fromIndex ${fromIndex} outside 0..${itemCount - 1}`)
  if (toIndex < 0 || toIndex >= itemCount) throw new Error(`paletteKeySequence: toIndex ${toIndex} outside 0..${itemCount - 1}`)
  const down = (toIndex - fromIndex + itemCount) % itemCount
  const up = (fromIndex - toIndex + itemCount) % itemCount
  const steps = down <= up
    ? Array.from({ length: down }, () => 'ArrowDown')
    : Array.from({ length: up }, () => 'ArrowUp')
  return [...steps, 'Enter']
}

export interface SelectSlashCommandOptions {
  /** The token typed after `/`, e.g. `subtask`. No leading slash, no spaces. */
  token: string
  /** Which palette row to commit. Matched against the row's visible text. */
  match: RegExp
  /** What the app is expected to leave in the composer after selection. */
  expectComposer?: string
  charDelayMs?: number
}

export interface SelectSlashCommandResult {
  paletteItems: string[]
  chosenIndex: number
  chosenText: string
  keySequence: string[]
  composerAfter: string
}

/**
 * Open the palette by typing `/<token>` and SELECT the matching entry with
 * arrow keys + Enter.
 *
 * Selection — not typing — is what makes a command a command: the palette's
 * Enter handler calls `onSelectCommand(item.id)`, and for `/subtask` that
 * prefills the composer with the app's own `"/subtask "` string. Asserting that
 * prefill is the cheapest available proof that the app, not the harness, put the
 * command there.
 *
 * The palette closes as soon as the caret stops sitting on a slash-token, so the
 * entry must be selected BEFORE any argument text is typed.
 */
export async function selectSlashCommand(session: CdpSession, options: SelectSlashCommandOptions): Promise<SelectSlashCommandResult> {
  if (!/^[a-zA-Z0-9._-]+$/.test(options.token)) {
    throw new Error(`selectSlashCommand: token ${JSON.stringify(options.token)} must match the palette's own filter charset [a-zA-Z0-9._-]`)
  }
  await focusComposer(session)
  await typeText(session, `/${options.token}`, { charDelayMs: options.charDelayMs ?? 25 })

  const state = await waitForPalette(session)
  if (!state.open) {
    const composer = await readComposer(session)
    throw new Error(
      `palette-did-not-open after typing "/${options.token}". Composer holds ${JSON.stringify(composer)}. ` +
        'If the composer is empty the key events are not reaching it (focus); if it holds the text but no menu ' +
        'appeared, no command matched the filter.',
    )
  }
  const chosenIndex = state.items.findIndex(item => options.match.test(item.text))
  if (chosenIndex < 0) {
    throw new Error(`palette-entry-not-found: ${options.match} matched none of [${state.items.map(i => JSON.stringify(i.text)).join(', ')}]`)
  }
  const from = state.selectedIndex >= 0 ? state.selectedIndex : 0
  const keySequence = paletteKeySequence(from, chosenIndex, state.items.length)
  const chosenText = state.items[chosenIndex]!.text

  for (const key of keySequence) {
    if (key === 'Enter') {
      // Confirm the highlight really is on the intended row before committing.
      const before = await paletteState(session)
      if (before.selectedIndex !== chosenIndex) {
        throw new Error(`palette-highlight-drifted: expected index ${chosenIndex} (${JSON.stringify(chosenText)}), highlight is on ${before.selectedIndex}`)
      }
    }
    await pressKey(session, key)
  }
  await Bun.sleep(200)

  const composerAfter = await readComposer(session)
  // A contenteditable composer keeps a residual "\n" after a self-executing
  // command clears it (measured on /compact, 2026-07-31: expected "" got
  // "\n" while the command HAD run). Whitespace is not prose — compare
  // trimmed, so a truly unselected entry (real text remains) still throws.
  const normalizedAfter = composerAfter.trim() === '' ? '' : composerAfter
  if (options.expectComposer !== undefined && normalizedAfter !== options.expectComposer && composerAfter !== options.expectComposer) {
    throw new Error(
      `palette-selection-did-not-prefill: expected composer ${JSON.stringify(options.expectComposer)}, got ${JSON.stringify(composerAfter)}. ` +
        'The entry was not selected — anything submitted from here is prose, not a command.',
    )
  }
  return {
    paletteItems: state.items.map(i => i.text),
    chosenIndex,
    chosenText,
    keySequence,
    composerAfter,
  }
}

/** Read the palette's entries for a token without committing anything. */
export async function peekPalette(session: CdpSession, token: string): Promise<string[]> {
  await focusComposer(session)
  await typeText(session, `/${token}`, { charDelayMs: 25 })
  const state = await waitForPalette(session)
  await pressKey(session, 'Escape')
  await clearComposer(session)
  return state.items.map(i => i.text)
}

/**
 * Submit the composer. Refuses while the palette is open, because Enter would be
 * eaten by the palette's own handler and select a row instead of sending.
 */
export async function submitComposer(session: CdpSession): Promise<void> {
  const state = await paletteState(session)
  if (state.open) {
    throw new Error(
      `submit refused: the slash palette is open (${state.items.length} entries). Enter would select a row, not send. ` +
        'Press Escape, or finish the slash-token before typing an argument.',
    )
  }
  await focusComposer(session)
  await pressKey(session, 'Enter')
}
