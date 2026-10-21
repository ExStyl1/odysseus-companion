/**
 * P6.49 · the hotkey override map now has a writer.
 *
 * `registry.tsx` declared `userOverrides: Map<ActionId, string|null>`, read it
 * in `getHotkey` ahead of `defaultHotkey`, and re-exported it on the context —
 * with zero writes repo-wide, behind the comment
 * `// User hotkey overrides (future: load from config)`. The read half was
 * live, so the map was UNWIRED, not dead, and the fix was to supply the
 * missing half.
 *
 * The semantics under test are read from Claude's own published feature,
 * `keybindings.md`, not invented:
 *
 *   "Set an action to `null` to unbind a default shortcut" — which is why the
 *   declared type has always been `string | null`, and why an absent key and a
 *   `null` value are different states.
 *
 *   "Unknown action names, such as a typo of a registered action. Claude Code
 *   skips the binding and keeps any default binding for that key in effect.
 *   Before v2.1.246, a binding with an unknown action name silently disabled
 *   that key" (`keybindings.md#validation`) — upstream shipped the silent
 *   disable and then fixed it. Storing `null` for an unrecognised id would
 *   reproduce that bug here.
 *
 * The keystroke GRAMMAR is this repo's own, read off `definitions.ts`'s 26
 * `defaultHotkey` values, off `matchesHotkey` in `registry.tsx`, and off
 * `formatHotkeyDisplay`, which P6.1081 moved out of `registry.tsx` into the
 * module under test. Claude's `ctrl+`/`cmd+` vocabulary belongs to a terminal;
 * accepting it here would store bindings `matchesHotkey` can never match.
 */
import { describe, expect, it } from 'bun:test'
import {
  describeHotkeyRejection,
  findHotkeyCollisions,
  formatHotkeyDisplay,
  hotkeyFromKeyboardEvent,
  hotkeyRejectionNotice,
  hotkeyRejectionSignature,
  normalizeHotkey,
  sameHotkeyOverrides,
  mergeHotkeyOverridesIntoPreferences,
  parseHotkeyOverrides,
  readHotkeyOverridesFromPreferences,
  serializeHotkeyOverrides,
  HOTKEY_OVERRIDES_PREFERENCE_KEY,
  type RecordedKeystroke,
} from '../hotkey-overrides'
import { actions } from '../definitions'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const isKnownAction = (id: string) => Object.prototype.hasOwnProperty.call(actions, id)

function keystroke(over: Partial<RecordedKeystroke>): RecordedKeystroke {
  return { key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }
}

describe('normalizeHotkey — accepts exactly what matchesHotkey can match', () => {
  it('accepts every shape the app itself ships as a default', () => {
    // The positive control: if the grammar rejected a shipped default, a user
    // could not re-enter the binding they just replaced.
    const shipped: string[] = []
    for (const action of Object.values(actions)) {
      const defaultHotkey: string | null = action.defaultHotkey
      if (defaultHotkey !== null) shipped.push(defaultHotkey)
    }

    expect(shipped.length).toBeGreaterThan(20)
    for (const hotkey of shipped) {
      expect(normalizeHotkey(hotkey)).toBe(hotkey)
    }
  })

  it('canonicalizes modifier order, because the display formatter is positional', () => {
    // `formatHotkeyDisplay` maps parts in order, so `n+mod` would render "N⌘".
    expect(normalizeHotkey('n+mod')).toBe('mod+n')
    expect(normalizeHotkey('shift+mod+t')).toBe('mod+shift+t')
    expect(normalizeHotkey('alt+shift+mod+k')).toBe('mod+shift+alt+k')
  })

  it('lowercases and trims', () => {
    expect(normalizeHotkey('  MOD+Shift+N  ')).toBe('mod+shift+n')
  })

  it('accepts a bare key, because escape and tab are shipped defaults', () => {
    expect(normalizeHotkey('escape')).toBe('escape')
    expect(normalizeHotkey('tab')).toBe('tab')
  })

  it('accepts the arrow keys matchesHotkey knows', () => {
    for (const key of ['left', 'right', 'up', 'down']) {
      expect(normalizeHotkey(`mod+${key}`)).toBe(`mod+${key}`)
    }
  })

  it('accepts enter, which matchesHotkey matches by LOGICAL name', () => {
    // `4e38638b0` ships `alt+enter` as `composer.sendAlternate`'s default, and
    // `enter` is absent from `matchesHotkey`'s `specialKeys` map — it falls to
    // the `e.key.toLowerCase() === key` branch. The grammar knew only
    // one-character keys and the by-`code` specials, so it rejected the app's
    // own binding: a user who rebound the action could never type the original
    // back. The whole-defaults control above is the other half of this.
    expect(normalizeHotkey('alt+enter')).toBe('alt+enter')
    expect(normalizeHotkey('Enter')).toBe('enter')
  })

  it('still rejects a multi-character word it has no token for, which is the boundary', () => {
    // The negative that stops the line above from becoming "accept any word":
    // `matchesHotkey` would compare these against `e.key`, and nothing in this
    // app produces them, so storing one writes a binding that never fires.
    expect(normalizeHotkey('mod+pageup')).toBeNull()
    expect(normalizeHotkey('mod+f7')).toBeNull()
    expect(normalizeHotkey('mod+backspace')).toBeNull()
  })

  it('rejects a modifier-only chord', () => {
    expect(normalizeHotkey('mod')).toBeNull()
    expect(normalizeHotkey('mod+shift')).toBeNull()
  })

  it('rejects two non-modifier parts, which matchesHotkey would silently truncate', () => {
    // `matchesHotkey` reads only the LAST part as the key, so `mod+a+b` would
    // quietly behave as `mod+b`.
    expect(normalizeHotkey('mod+a+b')).toBeNull()
  })

  it('rejects a repeated modifier, an unknown word, and empty parts', () => {
    expect(normalizeHotkey('mod+mod+n')).toBeNull()
    expect(normalizeHotkey('hyper+n')).toBeNull()
    expect(normalizeHotkey('mod++n')).toBeNull()
    expect(normalizeHotkey('')).toBeNull()
    expect(normalizeHotkey('   ')).toBeNull()
  })

  it("rejects Claude's terminal spelling rather than storing a binding that never fires", () => {
    // `matchesHotkey` knows `mod`, not `ctrl`/`cmd`. Accepting these would
    // write an override that silently does nothing.
    expect(normalizeHotkey('ctrl+n')).toBeNull()
    expect(normalizeHotkey('cmd+n')).toBeNull()
  })

  it('rejects non-strings', () => {
    expect(normalizeHotkey(null)).toBeNull()
    expect(normalizeHotkey(42)).toBeNull()
    expect(normalizeHotkey(undefined)).toBeNull()
  })
})

describe('parseHotkeyOverrides — validation per keybindings.md#validation', () => {
  it('keeps a valid override, normalized', () => {
    const { overrides, rejected } = parseHotkeyOverrides({ 'app.newChat': 'Shift+MOD+J' }, isKnownAction)
    expect(overrides.get('app.newChat')).toBe('mod+shift+j')
    expect(rejected).toHaveLength(0)
  })

  it('keeps null as the documented UNBIND, distinct from an absent key', () => {
    const { overrides, rejected } = parseHotkeyOverrides({ 'app.newChat': null }, isKnownAction)
    expect(overrides.has('app.newChat')).toBe(true)
    expect(overrides.get('app.newChat')).toBeNull()
    expect(rejected).toHaveLength(0)
  })

  it('SKIPS an unknown action and does not unbind it — the pre-2.1.246 upstream bug', () => {
    const { overrides, rejected } = parseHotkeyOverrides({ 'app.newChatt': 'mod+j' }, isKnownAction)
    // The bug being avoided: storing `null` here would disable the key.
    expect(overrides.has('app.newChatt')).toBe(false)
    expect(overrides.size).toBe(0)
    expect(rejected).toEqual([{ actionId: 'app.newChatt', reason: 'unknown-action', value: 'mod+j' }])
  })

  it('rejects an invalid value type without unbinding', () => {
    const { overrides, rejected } = parseHotkeyOverrides({ 'app.newChat': 42 }, isKnownAction)
    expect(overrides.has('app.newChat')).toBe(false)
    expect(rejected[0]?.reason).toBe('invalid-value')
  })

  it('rejects an unmatchable keystroke without unbinding', () => {
    const { overrides, rejected } = parseHotkeyOverrides({ 'app.newChat': 'ctrl+j' }, isKnownAction)
    expect(overrides.has('app.newChat')).toBe(false)
    expect(rejected[0]?.reason).toBe('invalid-hotkey')
  })

  it('keeps the good entries when one is bad', () => {
    const { overrides, rejected } = parseHotkeyOverrides(
      { 'app.newChat': 'mod+j', 'app.nope': 'mod+k', 'app.search': null },
      isKnownAction,
    )
    expect(overrides.get('app.newChat')).toBe('mod+j')
    expect(overrides.get('app.search')).toBeNull()
    expect(rejected).toHaveLength(1)
  })

  it('survives corrupt storage', () => {
    for (const raw of [null, undefined, 'nonsense', 42, ['a'], true]) {
      const { overrides, rejected } = parseHotkeyOverrides(raw, isKnownAction)
      expect(overrides.size).toBe(0)
      expect(rejected).toHaveLength(0)
    }
  })

  it('round-trips through serialize', () => {
    const record = { 'app.newChat': 'mod+j', 'app.search': null }
    const { overrides } = parseHotkeyOverrides(record, isKnownAction)
    expect(serializeHotkeyOverrides(overrides)).toEqual(record)
  })

  it('describes every rejection reason', () => {
    expect(describeHotkeyRejection({ actionId: 'x', reason: 'unknown-action', value: 'mod+j' }))
      .toContain('default stays in effect')
    expect(describeHotkeyRejection({ actionId: 'x', reason: 'invalid-value', value: 42 })).toContain('expected')
    expect(describeHotkeyRejection({ actionId: 'x', reason: 'invalid-hotkey', value: 'ctrl+j' })).toContain('keystroke')
  })
})

describe('hotkeyFromKeyboardEvent — the exact inverse of matchesHotkey', () => {
  it('reads mod from metaKey on macOS and ctrlKey elsewhere', () => {
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'n', code: 'KeyN', metaKey: true }), true)).toBe('mod+n')
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'n', code: 'KeyN', ctrlKey: true }), false)).toBe('mod+n')
    // ...and does NOT cross the platforms over.
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'n', code: 'KeyN', ctrlKey: true }), true)).toBe('n')
  })

  it('collects every modifier in canonical order', () => {
    const event = keystroke({ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true, altKey: true })
    expect(hotkeyFromKeyboardEvent(event, true)).toBe('mod+shift+alt+k')
  })

  it('prefers the physical code for keys matchesHotkey matches by code', () => {
    // Under a Cyrillic layout `event.key` for BracketLeft is 'х'. Recording the
    // logical key would store a token compared against `event.code` forever.
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'х', code: 'BracketLeft', metaKey: true }), true)).toBe('mod+[')
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }), true)).toBe('mod+left')
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Escape', code: 'Escape' }), true)).toBe('escape')
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Tab', code: 'Tab', shiftKey: true }), true)).toBe('shift+tab')
  })

  it('uses the logical key for letters, which is what makes AZERTY work', () => {
    // `matchesHotkey` compares letters by `e.key`, so the recorder must too.
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'a', code: 'KeyQ', metaKey: true }), true)).toBe('mod+a')
  })

  it('returns null while only modifiers are held', () => {
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true)).toBeNull()
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), true)).toBeNull()
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), false)).toBeNull()
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Alt', code: 'AltLeft', altKey: true }), true)).toBeNull()
  })

  it('returns null for a multi-character key it has no token for', () => {
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'F7', code: 'F7' }), true)).toBeNull()
  })

  it('records Enter, because the app ships alt+enter as a default', () => {
    // The recorder half of the grammar fix: a recorder that could not produce
    // `alt+enter` would leave the user unable to re-enter a binding the
    // grammar now accepts. `Enter` is matched by logical key, so `NumpadEnter`
    // records identically — which is also how `matchesHotkey` reads it.
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Enter', code: 'Enter', altKey: true }), true)).toBe('alt+enter')
    expect(hotkeyFromKeyboardEvent(keystroke({ key: 'Enter', code: 'NumpadEnter', altKey: true }), true)).toBe('alt+enter')
  })

  it('produces bindings normalizeHotkey accepts, so a recording is always storable', () => {
    const recorded = hotkeyFromKeyboardEvent(keystroke({ key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true }), true)
    expect(recorded).not.toBeNull()
    expect(normalizeHotkey(recorded)).toBe(recorded)
  })
})

describe('formatHotkeyDisplay — the shipped defaults reach the eye intact (P6.1081)', () => {
  it('renders the shipped alt+enter default as the platform glyph, not the bare word', () => {
    // Read the binding out of `definitions.ts` rather than spelling it here:
    // the defect is that a SHIPPED default had no arm, so a hard-coded literal
    // would keep passing on the day the default moves.
    const shipped: string[] = []
    for (const action of Object.values(actions)) {
      const defaultHotkey: string | null = action.defaultHotkey
      if (defaultHotkey !== null && defaultHotkey.split('+').includes('enter')) shipped.push(defaultHotkey)
    }
    expect(shipped).toEqual(['alt+enter'])

    // `4e38638b0` shipped this default and the formatter had no `enter` arm,
    // so it fell through to `part.toUpperCase()` and the shortcuts page showed
    // "⌥ENTER". The mac glyph is the macOS Return symbol; off macOS the parts
    // are joined with `+` and the word is what those keyboards are labelled.
    expect(formatHotkeyDisplay('alt+enter', true)).toBe('⌥↩')
    expect(formatHotkeyDisplay('alt+enter', false)).toBe('Alt+Enter')
  })

  it('keeps every macOS part to one chip, which is why enter is a glyph and not a word', () => {
    // `ShortcutsPage`'s `splitDisplayKeys` chips a macOS display string per
    // key, and its only multi-character alternatives are `Tab` and `Esc`.
    // Anything else that is longer than one character is shredded into a chip
    // per letter, so "Enter" on macOS would have rendered as five chips.
    const mac = formatHotkeyDisplay('alt+enter', true)
    expect(Array.from(mac)).toHaveLength(2)
    expect(mac).not.toContain('Enter')

    // The two words that ARE in that alternation stay words, unchanged.
    expect(formatHotkeyDisplay('escape', true)).toBe('Esc')
    expect(formatHotkeyDisplay('tab', true)).toBe('Tab')
  })

  it('still upper-cases a key it has no arm for, on both platforms', () => {
    // The negative that stops the arm above from becoming "glyph everything".
    // The formatter does not validate — `normalizeHotkey` is what refuses a
    // keystroke — so an unknown part must keep falling through unchanged.
    expect(formatHotkeyDisplay('mod+pageup', true)).toBe('⌘PAGEUP')
    expect(formatHotkeyDisplay('mod+pageup', false)).toBe('Ctrl+PAGEUP')
  })
})

describe('findHotkeyCollisions — the shadowing the global handler would hide', () => {
  const ids = ['a.one', 'a.two', 'a.three']
  const defaults: Record<string, string | null> = { 'a.one': 'mod+j', 'a.two': 'mod+j', 'a.three': 'mod+k' }
  const resolve = (id: string) => defaults[id] ?? null

  it('names every other action bound to the same chord', () => {
    expect(findHotkeyCollisions('a.one', 'mod+j', ids, resolve)).toEqual(['a.two'])
  })

  it('never reports the action against itself', () => {
    expect(findHotkeyCollisions('a.one', 'mod+k', ids, resolve)).toEqual(['a.three'])
    expect(findHotkeyCollisions('a.three', 'mod+k', ids, resolve)).toEqual([])
  })

  it('reports nothing for an unbind — nothing can collide with no key', () => {
    expect(findHotkeyCollisions('a.one', null, ids, resolve)).toEqual([])
  })

  it('reports nothing when the chord is free', () => {
    expect(findHotkeyCollisions('a.one', 'mod+z', ids, resolve)).toEqual([])
  })
})

/**
 * The round trip, which is the row's actual claim.
 *
 * "declared, read, re-exported and never written" — the parse tests above prove
 * the map can be BUILT correctly; these prove it can be STORED in
 * `preferences.json` and read back, which is the half that did not exist.
 *
 * The read-modify-write is exercised on the raw preferences BODY rather than
 * through `window.electronAPI`, because that is where the interesting failure
 * lives: this file also holds the user's name, timezone, notes and UI language,
 * and a write that drops them is far worse than one that drops a shortcut.
 */
describe('preferences round trip', () => {
  it('writes the overrides under the documented key and reads them back', () => {
    const body = mergeHotkeyOverridesIntoPreferences('{}', new Map([['app.newChat', 'mod+shift+j']]))
    expect(JSON.parse(body)[HOTKEY_OVERRIDES_PREFERENCE_KEY]).toEqual({ 'app.newChat': 'mod+shift+j' })

    const { overrides, rejected } = readHotkeyOverridesFromPreferences(body, isKnownAction)
    expect(overrides.get('app.newChat')).toBe('mod+shift+j')
    expect(rejected).toHaveLength(0)
  })

  it('round-trips an unbind, which must survive as null and not as an absent key', () => {
    const body = mergeHotkeyOverridesIntoPreferences('{}', new Map([['app.newChat', null]]))
    const { overrides } = readHotkeyOverridesFromPreferences(body, isKnownAction)
    expect(overrides.has('app.newChat')).toBe(true)
    expect(overrides.get('app.newChat')).toBeNull()
  })

  it('preserves every other preference — the whole reason this is a merge', () => {
    const existing = JSON.stringify({
      name: 'Ada',
      timezone: 'Europe/London',
      notes: 'prefers terse answers',
      diffViewer: { diffStyle: 'split' },
      uiLanguage: 'ru',
    })
    const body = mergeHotkeyOverridesIntoPreferences(existing, new Map([['app.newChat', 'mod+j']]))
    const prefs = JSON.parse(body)

    expect(prefs.name).toBe('Ada')
    expect(prefs.timezone).toBe('Europe/London')
    expect(prefs.notes).toBe('prefers terse answers')
    expect(prefs.diffViewer).toEqual({ diffStyle: 'split' })
    expect(prefs.uiLanguage).toBe('ru')
  })

  it('removes the key entirely when the last override is dropped', () => {
    const withOverride = mergeHotkeyOverridesIntoPreferences('{"name":"Ada"}', new Map([['app.newChat', 'mod+j']]))
    const cleared = mergeHotkeyOverridesIntoPreferences(withOverride, new Map())

    expect(HOTKEY_OVERRIDES_PREFERENCE_KEY in JSON.parse(cleared)).toBe(false)
    // ...without taking the rest of the file with it.
    expect(JSON.parse(cleared).name).toBe('Ada')
    expect(readHotkeyOverridesFromPreferences(cleared, isKnownAction).overrides.size).toBe(0)
  })

  it('stamps updatedAt, as every other writer of this file does', () => {
    expect(typeof JSON.parse(mergeHotkeyOverridesIntoPreferences('{}', new Map())).updatedAt).toBe('number')
  })

  it('costs the user their overrides, not their keyboard, when the file is malformed', () => {
    for (const body of ['', '{not json', 'null', '[]', '"a string"']) {
      const { overrides, rejected } = readHotkeyOverridesFromPreferences(body, isKnownAction)
      expect(overrides.size).toBe(0)
      expect(rejected).toHaveLength(0)
    }
    // ...and a malformed file is rewritten rather than merged into.
    expect(JSON.parse(mergeHotkeyOverridesIntoPreferences('{not json', new Map([['app.newChat', 'mod+j']])))[HOTKEY_OVERRIDES_PREFERENCE_KEY])
      .toEqual({ 'app.newChat': 'mod+j' })
  })

  it('reads nothing from a preferences file that has never held an override', () => {
    const { overrides, rejected } = readHotkeyOverridesFromPreferences('{"name":"Ada"}', isKnownAction)
    expect(overrides.size).toBe(0)
    expect(rejected).toHaveLength(0)
  })

  it('still validates what it reads back — a hand-edited file is untrusted input', () => {
    const body = JSON.stringify({ [HOTKEY_OVERRIDES_PREFERENCE_KEY]: { 'app.newChat': 'ctrl+j', 'app.nope': 'mod+k' } })
    const { overrides, rejected } = readHotkeyOverridesFromPreferences(body, isKnownAction)
    expect(overrides.size).toBe(0)
    expect(rejected.map(r => r.reason).sort()).toEqual(['invalid-hotkey', 'unknown-action'])
  })
})

/**
 * Containment — the write path has to be reachable from the read path, and from
 * a real user surface.
 *
 * Read from source because `registry.tsx` and the settings page pull the
 * renderer component graph, which the bun runner cannot load (the same measured
 * trade `SessionStatusIcon.test.tsx` documents). Without this arm, a perfectly
 * tested override module could sit beside a registry that still never writes —
 * which is precisely the defect being closed.
 */
/**
 * P6.472 (denominator O13) — the SECOND destination.
 *
 * `keybindings.md#validation`: "Claude Code reports warnings when the file
 * loads and writes each one to the debug log." The fork shipped only the log,
 * so a typo in `hotkeyOverrides` told the user nothing at all.
 */
describe('hotkeyRejectionNotice — a rejection the user can read', () => {
  const LOCALES = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
  const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, string>
  const ru = JSON.parse(readFileSync(join(LOCALES, 'ru.json'), 'utf8')) as Record<string, string>

  it('names the action for an unknown-action rejection', () => {
    expect(hotkeyRejectionNotice({ actionId: 'chat.nope', reason: 'unknown-action', value: 'mod+k' }))
      .toEqual({ key: 'shortcuts.rejected.unknownAction', values: { action: 'chat.nope' } })
  })

  it('names the offending TYPE for an invalid value, without echoing the value', () => {
    const notice = hotkeyRejectionNotice({ actionId: 'chat.send', reason: 'invalid-value', value: 42 })
    expect(notice.key).toBe('shortcuts.rejected.invalidValue')
    expect(notice.values).toEqual({ action: 'chat.send', type: 'number' })
  })

  it('quotes the unusable keystroke, which is the one case the user must see verbatim', () => {
    const notice = hotkeyRejectionNotice({ actionId: 'chat.send', reason: 'invalid-hotkey', value: 'ctrl+k' })
    expect(notice.key).toBe('shortcuts.rejected.invalidHotkey')
    expect(notice.values).toEqual({ action: 'chat.send', value: '"ctrl+k"' })
  })

  it('every key it can emit exists in BOTH locales, with the title the toast pairs it with', () => {
    const reasons = ['unknown-action', 'invalid-value', 'invalid-hotkey'] as const
    const keys = reasons.map(reason => hotkeyRejectionNotice({ actionId: 'a', reason, value: 'x' }).key)
    for (const key of [...keys, 'shortcuts.rejected.title']) {
      expect(en[key]).toBeString()
      expect(ru[key]).toBeString()
    }
  })
})

describe('hotkeyRejectionSignature — the same problem is announced once', () => {
  const one = { actionId: 'chat.nope', reason: 'unknown-action', value: 'mod+k' } as const
  const two = { actionId: 'chat.send', reason: 'invalid-hotkey', value: 'ctrl+k' } as const

  it('is stable across reads of an unchanged file', () => {
    expect(hotkeyRejectionSignature([one, two])).toBe(hotkeyRejectionSignature([one, two]))
  })

  it('changes when a rejection changes — otherwise a fixed-then-rebroken file stays silent', () => {
    expect(hotkeyRejectionSignature([one])).not.toBe(hotkeyRejectionSignature([two]))
    expect(hotkeyRejectionSignature([one])).not.toBe(hotkeyRejectionSignature([one, two]))
    expect(hotkeyRejectionSignature([one])).not.toBe(
      hotkeyRejectionSignature([{ ...one, value: 'mod+j' }]),
    )
  })

  it('an empty list has its own signature, distinct from a populated one', () => {
    expect(hotkeyRejectionSignature([])).not.toBe(hotkeyRejectionSignature([one]))
  })
})

describe('sameHotkeyOverrides — the focus re-read must not re-render the whole app', () => {
  it('is true for maps binding the same actions to the same keys', () => {
    expect(sameHotkeyOverrides(
      new Map([['chat.send', 'mod+enter'], ['chat.cancel', null]]),
      new Map([['chat.cancel', null], ['chat.send', 'mod+enter']]),
    )).toBe(true)
  })

  it('is false when a binding changed', () => {
    expect(sameHotkeyOverrides(
      new Map([['chat.send', 'mod+enter']]),
      new Map([['chat.send', 'mod+k']]),
    )).toBe(false)
  })

  it('separates a stored UNBIND from an absent key — the documented distinction', () => {
    expect(sameHotkeyOverrides(new Map([['chat.send', null]]), new Map())).toBe(false)
    expect(sameHotkeyOverrides(new Map(), new Map([['chat.send', null]]))).toBe(false)
  })

  it('is false when one map has an extra binding of the same size elsewhere', () => {
    expect(sameHotkeyOverrides(
      new Map([['chat.send', 'mod+enter']]),
      new Map([['chat.cancel', 'mod+enter']]),
    )).toBe(false)
  })
})

describe('containment — the map is actually written now', () => {
  const registry = readFileSync(join(import.meta.dir, '..', 'registry.tsx'), 'utf8')
  const overrides = readFileSync(join(import.meta.dir, '..', 'hotkey-overrides.ts'), 'utf8')
  const page = readFileSync(
    join(import.meta.dir, '..', '..', 'pages', 'settings', 'ShortcutsPage.tsx'),
    'utf8',
  )

  it('registry holds the overrides in state, not in a ref', () => {
    // A ref mutated in place changes what the keyboard does while leaving every
    // rendered hotkey label showing the old chord.
    expect(registry).toContain('useState<Map<ActionId, string | null>>')
    expect(registry).not.toContain('useRef<Map<ActionId, string | null>>(new Map())')
  })

  it('registry seeds the map from preferences.json and reports what it rejected', () => {
    expect(registry).toContain('loadHotkeyOverrides(isKnownAction)')
    expect(registry).toContain('describeHotkeyRejection(rejection)')
    // Not web storage: the project's own lint rule forbids it for settings.
    expect(registry).not.toContain('localStorage')
    expect(overrides).not.toContain("from '@/lib/local-storage'")
  })

  it('registry persists on every write, and reports a failed write', () => {
    expect(registry).toContain('saveHotkeyOverrides(next)')
    expect(registry).toContain('failed to persist keyboard-shortcut overrides')
  })

  it('getHotkey depends on the override state, so labels re-render on a rebind', () => {
    expect(registry).toContain('}, [userOverrides])')
  })

  it('the settings page calls the writer — the map has a real user surface', () => {
    expect(page).toContain('setHotkeyOverride')
    expect(page).toContain('resetHotkeyOverride')
  })

  it('the recorder suspends the global handler while it listens', () => {
    // Otherwise the chord being assigned fires whatever it is bound to today.
    expect(registry).toContain('suspendedRef.current > 0')
    expect(page).toContain('suspendHotkeys()')
  })

  it('a rejection reaches a notice surface, not only the renderer log (P6.472/O13)', () => {
    // `keybindings.md#validation` promises both destinations; we shipped one.
    expect(registry).toContain('hotkeyRejectionNotice(rejection)')
    expect(registry).toContain("toast.error(t('shortcuts.rejected.title')")
    // The log line stays: a toast is gone in five seconds.
    expect(registry).toContain('describeHotkeyRejection(rejection)')
  })

  it('the file is re-read when the window regains focus, so a hand-edit needs no relaunch (P6.472/O14)', () => {
    expect(registry).toContain("window.addEventListener('focus', onFocus)")
    expect(registry).toContain("window.removeEventListener('focus', onFocus)")
    // The single-shot seed is gone: an effect with [] deps and an early return
    // on an empty map is what made an external edit inert.
    expect(registry).not.toContain('if (overrides.size === 0) return')
  })

  it('our own write is not clobbered by a re-read that lands mid-flight', () => {
    expect(registry).toContain('pendingWritesRef.current++')
    expect(registry).toContain('if (pendingWritesRef.current > 0) return')
  })

  it('a re-read publishes a new map only when the file changed', () => {
    expect(registry).toContain('sameHotkeyOverrides(overridesRef.current, next)')
  })
})
