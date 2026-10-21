/**
 * User hotkey overrides — the writer the map never had (P6.49).
 *
 * `registry.tsx` has always declared `userOverrides: Map<ActionId, string|null>`,
 * consulted it in `getHotkey` ahead of `defaultHotkey`, and re-exported it on
 * the context. Repo-wide it had **zero writes**: the whole feature was one
 * comment, `// User hotkey overrides (future: load from config)`. The read half
 * is live and correct, so this is an UNWIRED feature, not a dead one — the fix
 * is to supply the missing half, not to delete the half that works.
 *
 * The semantics are read from the nearest documented solution rather than
 * invented. Claude Code publishes exactly this feature at
 * `keybindings.md#configuration-file`, and two of its rules are load-bearing
 * here because the shape of our map already encodes them:
 *
 * - `null` means UNBOUND, not "no override". `keybindings.md`, under
 *   "Unbind default shortcuts": "Set an action to `null` to unbind a default
 *   shortcut". That is why the declared type is `string | null` and why
 *   `getHotkey` distinguishes `has()` from the stored value — the existing read
 *   path already implements the documented contract, which is the strongest
 *   evidence that the map was meant to be written.
 *
 * - An unknown action name must be SKIPPED, keeping the default in force.
 *   `keybindings.md#validation`: "Unknown action names, such as a typo of a
 *   registered action. Claude Code skips the binding and keeps any default
 *   binding for that key in effect. Before v2.1.246, a binding with an unknown
 *   action name silently disabled that key". Upstream shipped the silent-
 *   disable and then fixed it; storing `null` for an unrecognised id would
 *   reproduce their bug in our copy.
 *
 * Everything this module rejects, it reports. `keybindings.md#validation` again:
 * "Claude Code reports warnings when the file loads and writes each one to the
 * debug log." A rebind that is quietly ignored is indistinguishable from a
 * broken keyboard.
 *
 * The keystroke grammar is NOT Claude's — it is this repo's own, read off the
 * 26 `defaultHotkey` values in `definitions.ts`, off `matchesHotkey` in
 * `registry.tsx`, and off {@link formatHotkeyDisplay} below. Claude's
 * `ctrl+`/`cmd+` vocabulary belongs to a terminal; ours is `mod+` (⌘ on macOS,
 * Ctrl elsewhere) because the renderer is one app on both platforms. Accepting
 * Claude's spelling here would produce bindings `matchesHotkey` can never match.
 *
 * This module is deliberately free of React, and its whole core is pure:
 * everything above {@link loadHotkeyOverrides} — including the read-modify-write
 * of the preferences body — is directly testable without Electron.
 */

/** Modifiers `matchesHotkey` understands. `mod` is ⌘ on macOS, Ctrl elsewhere. */
export const HOTKEY_MODIFIERS = ['mod', 'shift', 'alt'] as const

/**
 * Non-character keys, taken from `matchesHotkey`'s `specialKeys` map. These are
 * matched by physical `event.code` because their logical value moves with the
 * keyboard layout.
 */
export const HOTKEY_SPECIAL_KEYS = ['left', 'right', 'up', 'down', 'escape', 'tab'] as const

/**
 * Keys `matchesHotkey` matches by LOGICAL name whose name is longer than one
 * character — a third category, and the reason it exists is a measured red.
 *
 * `matchesHotkey` falls back to `e.key.toLowerCase() === key` for anything
 * absent from its `specialKeys` map, so `alt+enter` has always been matchable.
 * The grammar here knew only two categories — one-character keys and the
 * by-`code` specials above — so it REJECTED `alt+enter`, which `4e38638b0`
 * ships as `chat.sendWithOtherFollowUp`'s default. The consequence is the one
 * this module's positive control names: a user who rebinds that action could
 * never type the original back, and a hand-written `alt+enter` in
 * `preferences.json` was reported as an invalid keystroke.
 *
 * Deliberately NOT folded into {@link HOTKEY_SPECIAL_KEYS}: that list is the
 * inverse of `matchesHotkey`'s `specialKeys` map and `CODE_TO_SPECIAL` below
 * mirrors it by physical `event.code`. `Enter` is matched by logical key, so
 * adding it there would make both of those statements false.
 */
export const HOTKEY_LOGICAL_NAMED_KEYS = ['enter'] as const

const MODIFIER_SET = new Set<string>(HOTKEY_MODIFIERS)
const SPECIAL_SET = new Set<string>(HOTKEY_SPECIAL_KEYS)
const LOGICAL_NAMED_SET = new Set<string>(HOTKEY_LOGICAL_NAMED_KEYS)

/**
 * Canonicalize a keystroke, or reject it.
 *
 * Ordering is not cosmetic: {@link formatHotkeyDisplay} maps the parts
 * positionally, so an override stored as `n+mod` would render as "N⌘" in the
 * shortcuts page while still matching correctly. Canonical order is modifiers
 * first, in `HOTKEY_MODIFIERS` order, then the key.
 *
 * Returns `null` for anything unmatchable. A bare key is allowed on purpose:
 * `escape` and `tab` are shipped defaults, so requiring a modifier would reject
 * the app's own bindings.
 */
export function normalizeHotkey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null

  const parts = raw.trim().toLowerCase().split('+').map(part => part.trim())
  if (parts.length === 0 || parts.some(part => part.length === 0)) return null

  const modifiers: string[] = []
  let key: string | null = null

  for (const part of parts) {
    if (MODIFIER_SET.has(part)) {
      // A repeated modifier is a typo, not an intent worth guessing at.
      if (modifiers.includes(part)) return null
      modifiers.push(part)
      continue
    }
    // Exactly one non-modifier part: `mod+a+b` binds nothing `matchesHotkey`
    // could ever produce, because it reads only the LAST part as the key.
    if (key !== null) return null
    if (!SPECIAL_SET.has(part) && !LOGICAL_NAMED_SET.has(part) && Array.from(part).length !== 1) return null
    key = part
  }

  if (key === null) return null

  const ordered = HOTKEY_MODIFIERS.filter(modifier => modifiers.includes(modifier))
  return [...ordered, key].join('+')
}

/**
 * Render a canonical keystroke for the UI.
 *
 * Moved here from `registry.tsx` (P6.1081) with the platform as a PARAMETER,
 * the way {@link hotkeyFromKeyboardEvent} already takes it. It closed over that
 * file's module-level `isMac`, so it could only ever be exercised on whichever
 * platform the runner happened to be, and reaching it at all meant importing
 * React, `react-i18next` and `sonner` — 87.8 s of module graph measured under
 * `bun test` on 2026-09-11. It is the positional counterpart of
 * {@link normalizeHotkey} — that function's canonical order exists for this one
 * — so the two belong in the same React-free module.
 *
 * Both display conventions are read off the arms that were already here rather
 * than invented: modifiers are platform-conditional and macOS concatenates the
 * parts instead of joining them with `+`; a named key is a glyph where one is
 * universally read (the arrows) and a word where it is not (`Esc`, `Tab`).
 *
 * `enter` had no arm at all, so the `alt+enter` default `4e38638b0` ships for
 * `chat.sendWithOtherFollowUp` — the only `enter`-bearing default in
 * `definitions.ts` — fell to `toUpperCase()` and rendered as `⌥ENTER`.
 * It takes the macOS Return glyph rather than the word, and that is not taste:
 * `ShortcutsPage`'s `splitDisplayKeys` chips a macOS display string with a
 * regex whose only multi-character alternatives are `Tab` and `Esc`, so any
 * other word is shredded into one chip per letter — `Enter` would have become
 * five chips. A single glyph falls to that regex's any-character branch and
 * stays one chip. Off macOS the string is split on `+`, where the word is both
 * safe and what those keyboards are labelled with.
 */
export function formatHotkeyDisplay(hotkey: string, isMacPlatform: boolean): string {
  const parts = hotkey.toLowerCase().split('+')

  const symbols = parts.map(part => {
    if (part === 'mod') return isMacPlatform ? '⌘' : 'Ctrl'
    if (part === 'shift') return isMacPlatform ? '⇧' : 'Shift'
    if (part === 'alt') return isMacPlatform ? '⌥' : 'Alt'
    if (part === 'escape') return 'Esc'
    if (part === 'tab') return 'Tab'
    if (part === 'enter') return isMacPlatform ? '↩' : 'Enter'
    if (part === 'left') return '←'
    if (part === 'right') return '→'
    // `matchesHotkey` has always accepted these; only the display was missing,
    // which no shipped default exercised. A user override can.
    if (part === 'up') return '↑'
    if (part === 'down') return '↓'
    if (part === '[') return '['
    if (part === ']') return ']'
    return part.toUpperCase()
  })

  return isMacPlatform ? symbols.join('') : symbols.join('+')
}

/**
 * `matchesHotkey`'s `specialKeys` map, inverted.
 *
 * That map is the reason a recorder cannot simply read `event.key`: the special
 * keys are matched by physical `event.code`, because their logical value moves
 * with the keyboard layout. Recording `event.key` for them would store a token
 * `matchesHotkey` then compares against `event.code` and never matches.
 */
const CODE_TO_SPECIAL: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Escape: 'escape',
  Tab: 'tab',
}

/** The shape of a `KeyboardEvent` this module needs, so it stays testable without a DOM. */
export interface RecordedKeystroke {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Turn a pressed keystroke into a binding string, or `null` if it is not one
 * yet.
 *
 * This is the exact inverse of `matchesHotkey`, and has to stay that way: it
 * resolves `mod` from `metaKey` on macOS and `ctrlKey` elsewhere, prefers the
 * physical code for keys `matchesHotkey` matches by code, and falls back to the
 * logical key otherwise, which is what makes letters work on AZERTY.
 *
 * Returns `null` while only modifiers are held — the recorder must keep waiting
 * rather than bind ⌘ to something.
 */
export function hotkeyFromKeyboardEvent(event: RecordedKeystroke, isMacPlatform: boolean): string | null {
  const special = CODE_TO_SPECIAL[event.code]
  let key: string | null = special ?? null

  if (key === null) {
    const logical = event.key.toLowerCase()
    // Modifier keypresses report themselves as the key; they are not a binding.
    if (logical === 'shift' || logical === 'alt' || logical === 'control' || logical === 'meta') return null
    // `enter` and its kind are matched by logical name, so the recorder has to
    // produce them or the grammar above would accept a binding no keystroke in
    // this app could ever re-enter.
    if (!LOGICAL_NAMED_SET.has(logical) && Array.from(logical).length !== 1) return null
    key = logical
  }

  const parts: string[] = []
  if (isMacPlatform ? event.metaKey : event.ctrlKey) parts.push('mod')
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  parts.push(key)

  return normalizeHotkey(parts.join('+'))
}

export type HotkeyRejectionReason =
  /** The id is not a registered action. Per `keybindings.md#validation`, the default stays. */
  | 'unknown-action'
  /** The stored value was neither a string nor `null`. */
  | 'invalid-value'
  /** The string is not a keystroke `matchesHotkey` could match. */
  | 'invalid-hotkey'

export interface HotkeyOverrideRejection {
  actionId: string
  reason: HotkeyRejectionReason
  /** The offending value, for the diagnostic. */
  value: unknown
}

export interface ParsedHotkeyOverrides {
  overrides: Map<string, string | null>
  rejected: HotkeyOverrideRejection[]
}

/**
 * Parse a persisted override record into the map `getHotkey` reads.
 *
 * Every rejection is reported rather than silently dropped, and never converted
 * into an unbind — see the `keybindings.md#validation` quote at the top.
 */
export function parseHotkeyOverrides(
  raw: unknown,
  isKnownAction: (actionId: string) => boolean,
): ParsedHotkeyOverrides {
  const overrides = new Map<string, string | null>()
  const rejected: HotkeyOverrideRejection[] = []

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { overrides, rejected }

  for (const [actionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKnownAction(actionId)) {
      rejected.push({ actionId, reason: 'unknown-action', value })
      continue
    }
    // `null` is the documented unbind, and is the one non-string we accept.
    if (value === null) {
      overrides.set(actionId, null)
      continue
    }
    if (typeof value !== 'string') {
      rejected.push({ actionId, reason: 'invalid-value', value })
      continue
    }
    const normalized = normalizeHotkey(value)
    if (normalized === null) {
      rejected.push({ actionId, reason: 'invalid-hotkey', value })
      continue
    }
    overrides.set(actionId, normalized)
  }

  return { overrides, rejected }
}

/** Flatten the map back to the persisted record. */
export function serializeHotkeyOverrides(overrides: ReadonlyMap<string, string | null>): Record<string, string | null> {
  const record: Record<string, string | null> = {}
  for (const [actionId, hotkey] of overrides) record[actionId] = hotkey
  return record
}

/**
 * Other actions that would answer to the same keystroke.
 *
 * The global handler in `registry.tsx` iterates `Object.entries(actions)` and
 * fires the FIRST match, so a colliding rebind silently shadows whichever
 * action happens to be declared later. This does not refuse the binding — the
 * user may well be rebinding *because* the old key collides with their screen
 * reader — it makes the consequence sayable.
 */
export function findHotkeyCollisions(
  actionId: string,
  hotkey: string | null,
  allActionIds: readonly string[],
  resolveHotkey: (actionId: string) => string | null,
): string[] {
  if (hotkey === null) return []
  return allActionIds.filter(other => other !== actionId && resolveHotkey(other) === hotkey)
}

/**
 * The localised notice for a rejection — the SECOND channel
 * `keybindings.md#validation` promises and we did not ship (P6.472).
 *
 * The page names two destinations, not one: "Claude Code reports warnings when
 * the file loads and writes each one to the debug log." We had only the log,
 * so a `hotkeyOverrides` typo told the user nothing at all — their keyboard
 * simply behaved as though they had never edited the file.
 *
 * Returns the key and its interpolation values rather than a rendered string:
 * this module is deliberately React-free and holds no `t`. The keys are
 * literals so `lint:i18n:reachable` can see them.
 */
export interface HotkeyRejectionNotice {
  key: string
  values: Record<string, string>
}

export function hotkeyRejectionNotice(rejection: HotkeyOverrideRejection): HotkeyRejectionNotice {
  const action = rejection.actionId
  switch (rejection.reason) {
    case 'unknown-action':
      return { key: 'shortcuts.rejected.unknownAction', values: { action } }
    case 'invalid-value':
      return { key: 'shortcuts.rejected.invalidValue', values: { action, type: typeof rejection.value } }
    case 'invalid-hotkey':
      return {
        key: 'shortcuts.rejected.invalidHotkey',
        values: { action, value: JSON.stringify(rejection.value) ?? String(rejection.value) },
      }
  }
}

/**
 * A stable fingerprint of a rejection list.
 *
 * The loader now runs again whenever the window regains focus, so without this
 * the same three-line notice would be raised on every alt-tab. Compare, and
 * report only when the file's problems have actually changed.
 */
export function hotkeyRejectionSignature(rejected: readonly HotkeyOverrideRejection[]): string {
  return JSON.stringify(
    rejected.map(rejection => [rejection.reason, rejection.actionId, rejection.value ?? null]),
  )
}

/**
 * Do two override maps bind the same actions to the same keys?
 *
 * The re-read on focus builds a fresh Map every time, and installing it would
 * re-render every hotkey label in the app on every alt-tab: `getHotkey` depends
 * on the map's identity and `useHotkeyLabel` sits under most of the UI. Compare
 * first; publish only a map that says something different.
 */
export function sameHotkeyOverrides(
  a: ReadonlyMap<string, string | null>,
  b: ReadonlyMap<string, string | null>,
): boolean {
  if (a.size !== b.size) return false
  for (const [actionId, hotkey] of a) {
    // `has` first: a stored `null` (the documented UNBIND) and an absent key
    // are different states, and `get` alone cannot tell them apart.
    if (!b.has(actionId) || b.get(actionId) !== hotkey) return false
  }
  return true
}

/** Human-readable form of a rejection, for the debug log. */
export function describeHotkeyRejection(rejection: HotkeyOverrideRejection): string {
  switch (rejection.reason) {
    case 'unknown-action':
      return `unknown action "${rejection.actionId}" — binding skipped, its default stays in effect`
    case 'invalid-value':
      return `override for "${rejection.actionId}" is ${typeof rejection.value}, expected a keystroke string or null`
    case 'invalid-hotkey':
      return `override for "${rejection.actionId}" is not a usable keystroke: ${JSON.stringify(rejection.value)}`
  }
}

// ─────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────

/**
 * Where the overrides live inside `preferences.json`.
 *
 * This is NOT `localStorage`, and the first draft of this module got that
 * wrong. The repo has a standing rule with its own eslint diagnostic — "Avoid
 * localStorage in Nessy Desktop. Store settings in
 * ~/.nessy-agent/preferences.json using
 * window.electronAPI.readPreferences/writePreferences"
 * (`nessy-general-agent/no-localstorage`) — and a preferences file is also much
 * closer to what Claude Code does for exactly this feature: "Run
 * `/keybindings` to create or open your configuration file at
 * `~/.claude/keybindings.json`". A real file is inspectable, backed up with the
 * rest of the config, and survives a cleared web-storage origin.
 *
 * The key is absent from `UpdatePreferencesSchema`, so the
 * `update_user_preferences` tool cannot rewrite a user's keyboard; and
 * `updatePreferences` spread-merges, so a tool write does not erase it either.
 */
export const HOTKEY_OVERRIDES_PREFERENCE_KEY = 'hotkeyOverrides'

/**
 * Pull the overrides out of a raw `preferences.json` body.
 *
 * Takes the raw string rather than the parsed object so a malformed file is
 * this function's problem and not the caller's: a preferences file someone
 * hand-edited badly must cost the user their overrides, not their keyboard.
 */
export function readHotkeyOverridesFromPreferences(
  rawJson: string,
  isKnownAction: (actionId: string) => boolean,
): ParsedHotkeyOverrides {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return { overrides: new Map(), rejected: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { overrides: new Map(), rejected: [] }
  return parseHotkeyOverrides(
    (parsed as Record<string, unknown>)[HOTKEY_OVERRIDES_PREFERENCE_KEY],
    isKnownAction,
  )
}

/**
 * Merge the overrides into a raw `preferences.json` body, preserving every
 * other key.
 *
 * Read-modify-write is the pattern the diff-viewer settings already use, and
 * the preservation is the point: this file also holds the user's name,
 * timezone, notes and UI language.
 */
export function mergeHotkeyOverridesIntoPreferences(
  rawJson: string,
  overrides: ReadonlyMap<string, string | null>,
): string {
  let prefs: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(rawJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      prefs = parsed as Record<string, unknown>
    }
  } catch {
    // A malformed file is rewritten fresh rather than merged into. Merging
    // into nothing and merging into garbage are the same operation.
  }

  if (overrides.size === 0) {
    delete prefs[HOTKEY_OVERRIDES_PREFERENCE_KEY]
  } else {
    prefs[HOTKEY_OVERRIDES_PREFERENCE_KEY] = serializeHotkeyOverrides(overrides)
  }
  prefs.updatedAt = Date.now()

  return JSON.stringify(prefs, null, 2)
}

/**
 * Load the user's overrides from `preferences.json`.
 *
 * Asynchronous, and the caller must cope with that: the shortcuts are the
 * defaults for the first frames after launch, and an unbound chord is briefly
 * live again. That is why `registry.tsx` holds the map in state rather than
 * seeding a ref — the labels correct themselves when this resolves.
 */
export async function loadHotkeyOverrides(
  isKnownAction: (actionId: string) => boolean,
): Promise<ParsedHotkeyOverrides> {
  try {
    const { content } = await window.electronAPI.readPreferences()
    return readHotkeyOverridesFromPreferences(content ?? '', isKnownAction)
  } catch {
    return { overrides: new Map(), rejected: [] }
  }
}

/** Persist the overrides, leaving the rest of `preferences.json` untouched. */
export async function saveHotkeyOverrides(overrides: ReadonlyMap<string, string | null>): Promise<void> {
  const { content } = await window.electronAPI.readPreferences()
  await window.electronAPI.writePreferences(mergeHotkeyOverridesIntoPreferences(content ?? '', overrides))
}
