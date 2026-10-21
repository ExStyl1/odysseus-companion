// Re-export everything for convenient imports
export { ActionRegistryProvider, hotkeyMatchesEvent, useActionRegistry } from './registry'
export { useAction } from './useAction'
export { useHotkeyLabel, useActionLabel } from './useHotkeyLabel'
export { actions, actionList, actionsByCategory, type ActionId } from './definitions'
export type { ActionDefinition, ActionHandler, ActionScope } from './types'
// Only what a consumer outside this directory actually imports. Re-exporting
// the rest of `hotkey-overrides` here would recreate, in the barrel, the exact
// shape P6.49 closed: a symbol declared, re-exported and read by nobody.
export { hotkeyFromKeyboardEvent } from './hotkey-overrides'
