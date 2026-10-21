/**
 * P6.480 — the one-message follow-up chord, as a REGISTERED action.
 *
 * The composer handles the keystroke itself, because it sends that composer's
 * own draft; what it must not do is own the chord. A chord nobody can rebind
 * and nothing collision-checks is exactly what the action registry exists to
 * remove, so the action is declared in `definitions.ts` and the composer
 * matches `hotkeyMatchesEvent` against its CURRENT hotkey.
 *
 * Three properties, and each has already been the wrong way round somewhere in
 * this repo:
 *
 * 1. **The chord is FREE.** W7-t measured Alt/Option+Enter unused on 2026-09-06
 *    — one `altKey` hit in the composer (an ArrowUp guard) and zero `Enter`
 *    bindings in the registry. "Free when it was added" is precisely the
 *    property nobody re-checks when the next action lands, which is what
 *    `findHotkeyCollisions` is for; it is asserted here rather than trusted.
 * 2. **The matcher really matches it, and really refuses its neighbours.** The
 *    composer's own send chords are Enter, Shift+Enter and Cmd/Ctrl+Enter; a
 *    matcher that accepted a bare Enter for `alt+enter` would make every send
 *    an override.
 * 3. **The shortcuts page can name it.** An action absent from
 *    `ACTION_LABEL_KEYS` falls back to the English `label` and silently ships
 *    untranslated — the map is `Partial`, so nothing else would say so.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { actions } from '../definitions'
import { findHotkeyCollisions } from '../hotkey-overrides'

const ACTION = 'chat.sendWithOtherFollowUp'

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../../${relative}`, import.meta.url)), 'utf8')

describe('P6.480 — the send-with-the-other-follow-up action', () => {
  it('is declared with the measured-free chord, in the Chat category and the chat scope', () => {
    const action = actions[ACTION]
    expect(action.defaultHotkey).toBe('alt+enter')
    expect(action.category).toBe('Chat')
    // `scope: 'chat'` and not global: it acts on a composer draft, so firing it
    // from the navigator or the settings page would have nothing to send.
    expect(action.scope).toBe('chat')
  })

  it('collides with no other action, which is the property nobody re-checks', () => {
    const ids = Object.keys(actions)
    const resolve = (id: string): string | null =>
      (actions as Record<string, { defaultHotkey: string | null }>)[id]!.defaultHotkey
    expect(findHotkeyCollisions(ACTION, 'alt+enter', ids, resolve)).toEqual([])
    // POSITIVE CONTROL on the instrument: an id that really is taken must be
    // reported, or the emptiness above proves nothing.
    const taken = actions['chat.cyclePermissionMode'].defaultHotkey
    expect(findHotkeyCollisions(ACTION, taken, ids, resolve)).toEqual(['chat.cyclePermissionMode'])
  })

  it('the shortcuts page has a translated label for it', () => {
    // `ACTION_LABEL_KEYS` is `Partial`, so a missing entry ships the English
    // `label` in every locale with nothing to report it.
    const page = repoFile('apps/electron/src/renderer/pages/settings/ShortcutsPage.tsx')
    expect(page).toContain(`'${ACTION}': 'shortcuts.action.sendWithOtherFollowUp'`)
    const en: Record<string, string> = JSON.parse(repoFile('packages/shared/src/i18n/locales/en.json'))
    const ru: Record<string, string> = JSON.parse(repoFile('packages/shared/src/i18n/locales/ru.json'))
    for (const key of [
      'shortcuts.action.sendWithOtherFollowUp',
      'settings.ai.midStream.oneMessageHint',
      'chat.midStream.overrideSteer',
      'chat.midStream.overrideQueue',
    ]) {
      expect(en[key], `en is missing ${key}`).toBeTruthy()
      expect(ru[key], `ru is missing ${key}`).toBeTruthy()
    }
    // The hint interpolates the chord the registry resolves, so the sentence
    // must carry the placeholder rather than a written-out shortcut.
    expect(en['settings.ai.midStream.oneMessageHint']).toContain('{{shortcut}}')
    expect(ru['settings.ai.midStream.oneMessageHint']).toContain('{{shortcut}}')
  })

  it('the composer reads the action’s hotkey rather than a literal chord', () => {
    // The whole reason the action exists: a hard-coded `e.altKey && e.key ===
    // "Enter"` would ignore a rebind and sit outside the collision check, which
    // is the shape this registry was built to remove.
    const composer = repoFile('apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx')
    expect(composer).toContain(`actionRegistry.getHotkey('${ACTION}')`)
    expect(composer).toContain('hotkeyMatchesEvent(e.nativeEvent, overrideHotkey)')
    // And it sends the INVERSE of the resolved default through the one helper
    // both ends share, never a constant.
    expect(composer).toContain('otherMidStreamBehavior(midStreamDefault)')
  })

  it('P6.946 — the two override sentences have a reader, and it is the send button’s own tooltip', () => {
    // These two keys shipped with P6.480's renderer half and nothing read them,
    // so `lint:i18n:reachable` was red on committed work. Guarded by the CALL
    // form and not the bare key (AGENTS.md §Traps: a bare-identifier guard goes
    // red on the very commit that makes it right, because the comment
    // explaining the change spells the name).
    const composer = repoFile('apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx')
    // UB14.28 — the tooltip is `SendButton`'s now (v0.15.1's control, our table).
    const sendButton = repoFile('apps/electron/src/renderer/components/app-shell/input/SendButton.tsx')
    expect(sendButton).toContain("t('chat.midStream.overrideSteer')")
    expect(sendButton).toContain("t('chat.midStream.overrideQueue')")
    // Which of the two is shown comes from the SAME expression the key handler
    // passes to `submitMessage`, so the tooltip cannot name the wrong direction:
    // the composer hands that expression's value down, the button only reads it.
    expect(composer).toContain('behavior: otherMidStreamBehavior(midStreamDefault)')
    expect(sendButton).toContain("midStreamOverride.behavior === 'steer'")
    // It cannot compute a direction of its own: it does not even import the
    // helper (an IMPORT probe — its docblock names the helper on purpose).
    expect(sendButton).not.toMatch(/import\s*\{[^}]*\botherMidStreamBehavior\b[^}]*\}/)
    // The hotkey is the registry's DISPLAY form here (the handler's `getHotkey`
    // is the matcher's form and is not printable), and the row is gated on it
    // being non-null — no chord for an unbound action — and, F1.331, on no staged files,
    // and, F1.481 (bd6f1027b), on no queued row the host would refuse to steer past.
    expect(composer).toContain(`actionRegistry.getHotkeyDisplay('${ACTION}')`)
    expect(composer).toContain('midStreamOverride={midStreamOverrideHotkey && attachments.length === 0 && !queueHoldsUnsteerableRow')
    expect(composer).toContain('{ hotkey: midStreamOverrideHotkey, behavior: otherMidStreamBehavior(midStreamDefault) }')

    // Boundary: the two sentences describe OPPOSITE effects, so a locale that
    // gave them one string would make the tooltip useless while every parity
    // and reachability check stayed green.
    const en: Record<string, string> = JSON.parse(repoFile('packages/shared/src/i18n/locales/en.json'))
    const ru: Record<string, string> = JSON.parse(repoFile('packages/shared/src/i18n/locales/ru.json'))
    expect(en['chat.midStream.overrideSteer']).not.toBe(en['chat.midStream.overrideQueue'])
    expect(ru['chat.midStream.overrideSteer']).not.toBe(ru['chat.midStream.overrideQueue'])
  })
})
