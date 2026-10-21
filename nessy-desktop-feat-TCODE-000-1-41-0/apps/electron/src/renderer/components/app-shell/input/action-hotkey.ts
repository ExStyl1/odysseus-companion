/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/action-hotkey.ts (UB14.20; ADDED in v0.15.0).
 * Taken 1:1 (Apache-2.0), plus one export of ours (UB14.29): `hotkeyKeycaps`, the same split for a hotkey
 * string the caller already holds. Our registry HAS user overrides (P6.49, `actions/hotkey-overrides.ts`),
 * so a caller inside `ActionRegistryProvider` passes `getHotkey(id)` — the binding the user actually has —
 * instead of reading the shipped default the way `actionHotkeyKeys` does.
 */
import { actions, type ActionId } from '@/actions/definitions'
import { isMac } from '@/lib/platform'

/** Platform glyph/word for one hotkey part, matching the action registry's display format. */
function keyLabel(part: string): string {
  switch (part) {
    case 'mod': return isMac ? '⌘' : 'Ctrl'
    case 'shift': return isMac ? '⇧' : 'Shift'
    case 'alt': return isMac ? '⌥' : 'Alt'
    case 'escape': return 'Esc'
    case 'tab': return 'Tab'
    case 'enter': return '↵'
    default: return part.toUpperCase()
  }
}

/**
 * Keycaps for an action's binding from the action definitions — the source of truth the registry
 * reads (it has no user overrides yet). Used where the composer renders outside
 * `ActionRegistryProvider` too (playground), where `useActionLabel` would throw.
 */
export function actionHotkeyKeys(actionId: ActionId): string[] {
  return hotkeyKeycaps(actions[actionId].defaultHotkey)
}

/**
 * Keycaps for a hotkey string in the registry's canonical form (`shift+tab`, `mod+n`). `null` (an
 * unbound action, P6.49) and `undefined` give none, so the caller draws no keycap row.
 */
export function hotkeyKeycaps(hotkey: string | null | undefined): string[] {
  return hotkey ? hotkey.toLowerCase().split('+').map(keyLabel) : []
}

/** Keycaps for the composer's own send / new-line keys (FreeFormInput handles them locally). */
export function composerSendKeys(sendMessageKey: 'enter' | 'cmd-enter'): { send: string[]; newLine: string[] } {
  return sendMessageKey === 'enter'
    ? { send: [keyLabel('enter')], newLine: [keyLabel('shift'), keyLabel('enter')] }
    : { send: [keyLabel('mod'), keyLabel('enter')], newLine: [keyLabel('enter')] }
}
