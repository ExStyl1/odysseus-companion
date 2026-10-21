/**
 * Real key events. The harness never inserts text any other way — ONE exception, with its own module: multi-line
 * text rides the APP's own paste path (`composer.ts` {@link import('./composer.ts').pasteIntoComposer}, UA12.166),
 * because the composer drops every CDP-typed newline (four key shapes measured on both RCs, SIT-R) and an Enter
 * keypress would submit, not break the line.
 *
 * WHY THIS FILE EXISTS. `Input.insertText` commits a string straight into the
 * focused editable and fires no `keydown`/`keypress` at all. Two things in the
 * composer depend on those events:
 *
 *   1. `useInlineSlashCommand.handleInputChange` (slash-command-menu.tsx) opens
 *      the palette only when the text *before the caret* ends with a slash-token
 *      — regex `(?:^|\s)\/([a-zA-Z0-9._-]*)$`. Committing `/subtask do a thing`
 *      in one shot leaves the caret after "thing", so nothing ever matches and
 *      the palette never opens.
 *   2. `InlineSlashCommand` binds ArrowUp/ArrowDown/Enter/Tab/Escape on
 *      `document` keydown. Without key events there is no way to SELECT a row,
 *      and selection is what turns typed text into a command.
 *
 * So a character is typed as three CDP events:
 *
 *     Input.dispatchKeyEvent {type:'rawKeyDown', key, code, vk}   → DOM keydown
 *     Input.dispatchKeyEvent {type:'char', key, text}             → inserts text
 *     Input.dispatchKeyEvent {type:'keyUp',  key, code, vk}       → DOM keyup
 *
 * `rawKeyDown` deliberately carries NO `text`. A `keyDown` that carries `text`
 * inserts the character by itself, so pairing it with a `char` event types every
 * character twice — an earlier driver hit exactly that and left a note about it.
 * `KEY_MODE_KEYDOWN_TEXT` is the fallback encoding if a live run finds a
 * character that `char` will not insert; do not send both.
 */

import type { CdpSession } from './connect.ts'

export type KeyMode = 'raw-char' | 'keydown-text'

/** Default. rawKeyDown + char + keyUp — a faithful keydown/keypress/keyup trio. */
export const KEY_MODE_RAW_CHAR: KeyMode = 'raw-char'
/** Fallback only. keyDown(text) + keyUp — one event does both; never add `char`. */
export const KEY_MODE_KEYDOWN_TEXT: KeyMode = 'keydown-text'

/** CDP modifier bitmask. */
export const MOD = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 })

export interface KeyEventParams {
  type: 'rawKeyDown' | 'keyDown' | 'char' | 'keyUp'
  key: string
  code?: string
  text?: string
  unmodifiedText?: string
  windowsVirtualKeyCode?: number
  nativeVirtualKeyCode?: number
  modifiers?: number
}

/** Named non-printing keys the harness drives. */
export const NAMED_KEYS: Readonly<Record<string, { key: string; code: string; vk: number }>> = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
})

/** Unshifted punctuation → (code, virtual key). */
const PUNCTUATION: Readonly<Record<string, { code: string; vk: number }>> = Object.freeze({
  ' ': { code: 'Space', vk: 32 },
  ';': { code: 'Semicolon', vk: 186 },
  '=': { code: 'Equal', vk: 187 },
  ',': { code: 'Comma', vk: 188 },
  '-': { code: 'Minus', vk: 189 },
  '.': { code: 'Period', vk: 190 },
  '/': { code: 'Slash', vk: 191 },
  '`': { code: 'Backquote', vk: 192 },
  '[': { code: 'BracketLeft', vk: 219 },
  '\\': { code: 'Backslash', vk: 220 },
  ']': { code: 'BracketRight', vk: 221 },
  "'": { code: 'Quote', vk: 222 },
})

/** Shifted character → the unshifted character it is produced from. */
const SHIFTED: Readonly<Record<string, string>> = Object.freeze({
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
})

interface CharDescriptor {
  code: string
  vk: number
  shift: boolean
}

/** Physical-key description for a printable character. */
export function describeChar(ch: string): CharDescriptor {
  if (ch >= 'a' && ch <= 'z') return { code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shift: false }
  if (ch >= 'A' && ch <= 'Z') return { code: `Key${ch}`, vk: ch.charCodeAt(0), shift: true }
  if (ch >= '0' && ch <= '9') return { code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false }
  const plain = PUNCTUATION[ch]
  if (plain) return { code: plain.code, vk: plain.vk, shift: false }
  const base = SHIFTED[ch]
  if (base) {
    const basePlain = PUNCTUATION[base] ?? (base >= '0' && base <= '9' ? { code: `Digit${base}`, vk: base.charCodeAt(0) } : undefined)
    if (basePlain) return { code: basePlain.code, vk: basePlain.vk, shift: true }
  }
  // Non-US-layout / non-ASCII: no physical key to name. The `char` event still
  // carries the text, which is what performs the insertion.
  return { code: '', vk: 0, shift: false }
}

/**
 * The exact CDP events one typed character produces. Pure — unit tested.
 */
export function keyEventsForChar(ch: string, mode: KeyMode = KEY_MODE_RAW_CHAR): KeyEventParams[] {
  if (ch.length !== 1) throw new Error(`keyEventsForChar expects one character, got ${JSON.stringify(ch)}`)
  const { code, vk, shift } = describeChar(ch)
  const modifiers = shift ? MOD.shift : 0
  const physical = { key: ch, ...(code ? { code } : {}), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(modifiers ? { modifiers } : {}) }
  if (mode === KEY_MODE_KEYDOWN_TEXT) {
    // One event inserts AND fires keydown. Never follow it with a `char`.
    return [
      { type: 'keyDown', ...physical, text: ch, unmodifiedText: ch },
      { type: 'keyUp', ...physical },
    ]
  }
  return [
    { type: 'rawKeyDown', ...physical },
    { type: 'char', key: ch, text: ch, unmodifiedText: ch, ...(modifiers ? { modifiers } : {}) },
    { type: 'keyUp', ...physical },
  ]
}

/** The events one named key press produces. Pure — unit tested. */
export function keyEventsForNamedKey(name: string, modifiers = 0): KeyEventParams[] {
  const spec = NAMED_KEYS[name]
  if (!spec) throw new Error(`unknown named key ${name}; known: ${Object.keys(NAMED_KEYS).join(', ')}`)
  const physical = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    ...(modifiers ? { modifiers } : {}),
  }
  // No `char` event for ANY named key, including Enter and Tab.
  //
  // In a browser, `preventDefault()` on keydown suppresses the keypress that
  // would follow. CDP does not link the two: a separately dispatched `char`
  // arrives regardless. The palette and the composer both call preventDefault on
  // Enter and Tab, so sending a `char` would still insert a `\r` or `\t` into the
  // contenteditable — corrupting the composer immediately after a successful
  // palette selection, which is precisely where a case would stop trusting its
  // own assertion. Every consumer here handles these keys on keydown.
  return [
    { type: 'rawKeyDown', ...physical },
    { type: 'keyUp', ...physical },
  ]
}

async function dispatch(session: CdpSession, events: KeyEventParams[], delayMs: number): Promise<void> {
  for (const event of events) {
    await session.send('Input.dispatchKeyEvent', event as unknown as Record<string, unknown>)
  }
  if (delayMs > 0) await Bun.sleep(delayMs)
}

export interface TypeOptions {
  mode?: KeyMode
  /** Pause after each character. React state and the palette need a tick. */
  charDelayMs?: number
}

/** Type a string one real character at a time. */
export async function typeText(session: CdpSession, text: string, options: TypeOptions = {}): Promise<void> {
  const mode = options.mode ?? KEY_MODE_RAW_CHAR
  const delay = options.charDelayMs ?? 12
  for (const ch of text) {
    await dispatch(session, keyEventsForChar(ch, mode), delay)
  }
}

/** Press one named key. */
export async function pressKey(session: CdpSession, name: string, modifiers = 0): Promise<void> {
  await dispatch(session, keyEventsForNamedKey(name, modifiers), 20)
}

/** Press a named key n times. */
export async function pressKeyTimes(session: CdpSession, name: string, times: number, modifiers = 0): Promise<void> {
  for (let i = 0; i < times; i += 1) await pressKey(session, name, modifiers)
}
