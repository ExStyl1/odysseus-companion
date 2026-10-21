import React, { createContext, useContext, useCallback, useRef, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { actions, type ActionId } from './definitions'
import type { ActionDefinition, ActionHandler } from './types'
import { isMac } from '@/lib/platform'
import { rendererLog } from '@/lib/logger'
import { getKeybindingContext, evaluateWhen } from './keybinding-context'
import {
  describeHotkeyRejection,
  findHotkeyCollisions,
  formatHotkeyDisplay,
  hotkeyRejectionNotice,
  hotkeyRejectionSignature,
  loadHotkeyOverrides,
  normalizeHotkey,
  sameHotkeyOverrides,
  saveHotkeyOverrides,
} from './hotkey-overrides'

const ACTION_IDS = Object.keys(actions) as ActionId[]

function isKnownAction(actionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(actions, actionId)
}

/** Outcome of a rebind attempt, so the caller can say what happened. */
export type SetHotkeyResult =
  | { ok: true; hotkey: string | null; collidesWith: ActionId[] }
  | { ok: false; reason: 'invalid-hotkey' }

interface ActionRegistryContextType {
  // Register a handler for an action
  register: (handler: ActionHandler) => () => void

  // Execute an action by ID
  execute: (actionId: ActionId) => void

  // Get the current hotkey for an action (respects user overrides)
  getHotkey: (actionId: ActionId) => string | null

  // Get display string for UI (e.g., "⌘N" on Mac, "Ctrl+N" on Windows)
  getHotkeyDisplay: (actionId: ActionId) => string | null

  // Get action definition
  getAction: (actionId: ActionId) => typeof actions[ActionId]

  /**
   * User hotkey overrides, loaded from renderer storage at mount and rewritten
   * by {@link setHotkeyOverride}. A present key with a `null` value is the
   * documented UNBIND (`keybindings.md`, "Unbind default shortcuts"); an absent
   * key means the action keeps its `defaultHotkey`.
   *
   * Read-only for consumers: this is a fresh Map on every change, so mutating
   * it in place would neither persist nor re-render. Rebind through
   * `setHotkeyOverride`.
   */
  userOverrides: ReadonlyMap<ActionId, string | null>

  /**
   * Rebind an action. Pass `null` to unbind it, or call
   * {@link resetHotkeyOverride} to restore its default.
   */
  setHotkeyOverride: (actionId: ActionId, hotkey: string | null) => SetHotkeyResult

  /** Drop the override for one action, restoring its `defaultHotkey`. */
  resetHotkeyOverride: (actionId: ActionId) => void

  /**
   * Suspend the global hotkey handler and return its restore function.
   *
   * The shortcuts page needs this while it records a keystroke: without it the
   * capture-phase listener below would swallow the very chord the user is
   * trying to assign, and fire whatever it is currently bound to.
   */
  suspendHotkeys: () => () => void
}

const ActionRegistryContext = createContext<ActionRegistryContextType | null>(null)

export function ActionRegistryProvider({ children }: { children: React.ReactNode }) {
  const handlersRef = useRef<Map<ActionId, ActionHandler[]>>(new Map())

  /**
   * Overrides live in state, not in a ref, and that is the whole difference
   * between a map that works and one that only appears to. `getHotkeyDisplay`
   * feeds `useHotkeyLabel`, which every shortcut label in the app renders; a
   * ref mutated in place would change what the keyboard does while leaving
   * every printed label showing the old chord.
   */
  const [userOverrides, setUserOverrides] = useState<Map<ActionId, string | null>>(() => new Map())

  // The keydown listener reads through a ref so that rebinding does not have to
  // tear down and re-add a capture-phase window listener on every keystroke.
  const overridesRef = useRef(userOverrides)
  overridesRef.current = userOverrides

  const { t } = useTranslation()

  /**
   * Our own write is in flight.
   *
   * `commitOverrides` publishes before it persists, so between those two the
   * file on disk is still the PREVIOUS one. A re-read landing in that window
   * would undo the rebind the user just made — a control that silently stops
   * controlling, which is the defect class this row exists to close.
   */
  const pendingWritesRef = useRef(0)

  /**
   * Fingerprint of the rejection list we last raised, so returning to the
   * window does not re-announce problems the user has already seen.
   */
  const reportedRejectionsRef = useRef<string | null>(null)

  // Re-armed in the effect body, not only at creation: StrictMode's dev
  // double-mount runs the cleanup once before the real mount, and a ref left
  // false there would make every later read a no-op.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  /**
   * Read `preferences.json` and install what it says.
   *
   * The read is an IPC round trip and therefore asynchronous. For the frames
   * before the first one lands the defaults are in force — including a chord
   * the user has unbound. Stated rather than hidden: the alternative is a
   * synchronous web-storage copy, and the project's own lint rule
   * (`nessy-general-agent/no-localstorage`) rules that out.
   */
  const refreshOverrides = useCallback(async () => {
    if (pendingWritesRef.current > 0) return
    const { overrides, rejected } = await loadHotkeyOverrides(isKnownAction)
    if (!mountedRef.current || pendingWritesRef.current > 0) return

    // Report, never silently drop — `keybindings.md#validation` promises TWO
    // destinations, not one: "Claude Code reports warnings when the file loads
    // and writes each one to the debug log." We shipped only the log, so a
    // typo in `hotkeyOverrides` told the user nothing at all and their
    // keyboard simply behaved as though they had never edited the file.
    const signature = hotkeyRejectionSignature(rejected)
    if (signature !== reportedRejectionsRef.current) {
      reportedRejectionsRef.current = signature
      for (const rejection of rejected) {
        rendererLog.warn(`[hotkeys] ${describeHotkeyRejection(rejection)}`)
        const notice = hotkeyRejectionNotice(rejection)
        toast.error(t('shortcuts.rejected.title'), { description: t(notice.key, notice.values) })
      }
    }

    const next = new Map<ActionId, string | null>()
    for (const [actionId, hotkey] of overrides) next.set(actionId as ActionId, hotkey)
    // Unconditional, including the empty case: an override deleted from the
    // file outside the app has to disappear from the map too. The seed used to
    // bail out early on an empty map, which made emptying the file a no-op.
    if (!sameHotkeyOverrides(overridesRef.current, next)) setUserOverrides(next)
  }, [t])

  /**
   * Seed at mount, and re-read whenever the window regains focus.
   *
   * The focus trigger is what makes a hand-edit to `preferences.json` take
   * effect without a relaunch. Native mechanism: **none** — Electron pushes no
   * preferences-changed event, the main process runs no watcher for this file
   * (`RPC_CHANNELS.preferences` is READ/WRITE only, with no CHANGED sibling of
   * the kind `theme.PREFERENCES_CHANGED` has), and the Agent SDK and codex both
   * own their own key maps rather than ours. So the host supplies it, once, for
   * all three runtimes — and `focus` is the cheapest honest trigger, needing no
   * new IPC channel and no file watcher.
   *
   * Residue, stated: the edit lands on the next return to the window, not the
   * instant the file changes. A user who edits the file while the app is
   * already focused sees it after one alt-tab.
   */
  useEffect(() => {
    void refreshOverrides()
    const onFocus = () => { void refreshOverrides() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus) }
  }, [refreshOverrides])

  const suspendedRef = useRef(0)

  // Register a handler
  const register = useCallback((handler: ActionHandler) => {
    const handlers = handlersRef.current.get(handler.actionId) || []
    handlers.push(handler)
    handlersRef.current.set(handler.actionId, handlers)

    // Return cleanup function
    return () => {
      const handlers = handlersRef.current.get(handler.actionId) || []
      const index = handlers.indexOf(handler)
      if (index > -1) handlers.splice(index, 1)
    }
  }, [])

  // Execute an action
  const execute = useCallback((actionId: ActionId) => {
    const handlers = handlersRef.current.get(actionId) || []
    for (const handler of handlers) {
      if (!handler.enabled || handler.enabled()) {
        handler.handler()
        break // Only execute first enabled handler
      }
    }
  }, [])

  // Get hotkey for action
  const getHotkey = useCallback((actionId: ActionId): string | null => {
    // Check user overrides first. `has` and the value are distinct states: a
    // stored `null` is a deliberate unbind, an absent key is "use the default".
    if (userOverrides.has(actionId)) {
      return userOverrides.get(actionId) ?? null
    }
    return actions[actionId].defaultHotkey
  }, [userOverrides])

  // Get display string
  const getHotkeyDisplay = useCallback((actionId: ActionId): string | null => {
    const hotkey = getHotkey(actionId)
    if (!hotkey) return null
    return formatHotkeyDisplay(hotkey, isMac)
  }, [getHotkey])

  /**
   * Publish an override map change, then persist it.
   *
   * Publish first: the rebind must take effect on the keystroke the user just
   * pressed, not one IPC round trip later. A failed write is reported, never
   * swallowed — losing the setting silently is how a user concludes the feature
   * does not work.
   */
  const commitOverrides = useCallback((next: Map<ActionId, string | null>) => {
    setUserOverrides(next)
    // Held across the write so the focus re-read cannot install the file's
    // pre-write contents over the map we have just published.
    pendingWritesRef.current++
    void saveHotkeyOverrides(next)
      .catch(error => {
        rendererLog.warn('[hotkeys] failed to persist keyboard-shortcut overrides', error)
      })
      .finally(() => {
        pendingWritesRef.current = Math.max(0, pendingWritesRef.current - 1)
      })
  }, [])

  const setHotkeyOverride = useCallback((actionId: ActionId, hotkey: string | null): SetHotkeyResult => {
    const normalized = hotkey === null ? null : normalizeHotkey(hotkey)
    if (hotkey !== null && normalized === null) return { ok: false, reason: 'invalid-hotkey' }

    const next = new Map(overridesRef.current)
    next.set(actionId, normalized)

    // Resolve collisions against the map we are about to install, not the one
    // we are replacing, so the report describes the state the user will get.
    const resolve = (id: string): string | null => {
      const candidate = id as ActionId
      if (next.has(candidate)) return next.get(candidate) ?? null
      return actions[candidate].defaultHotkey
    }
    const collidesWith = findHotkeyCollisions(actionId, normalized, ACTION_IDS, resolve) as ActionId[]
    if (collidesWith.length > 0) {
      // Not refused: the user may be rebinding precisely because the old chord
      // collides with their OS or assistive technology. But the global handler
      // fires only the first match, so say which action loses.
      rendererLog.warn(
        `[hotkeys] "${actionId}" bound to "${normalized}" collides with: ${collidesWith.join(', ')} — only the first registered action will fire`,
      )
    }

    commitOverrides(next)
    return { ok: true, hotkey: normalized, collidesWith }
  }, [commitOverrides])

  const resetHotkeyOverride = useCallback((actionId: ActionId) => {
    if (!overridesRef.current.has(actionId)) return
    const next = new Map(overridesRef.current)
    next.delete(actionId)
    commitOverrides(next)
  }, [commitOverrides])

  const suspendHotkeys = useCallback(() => {
    suspendedRef.current++
    let restored = false
    return () => {
      if (restored) return
      restored = true
      suspendedRef.current = Math.max(0, suspendedRef.current - 1)
    }
  }, [])

  // Get action definition
  const getAction = useCallback((actionId: ActionId) => {
    return actions[actionId]
  }, [])

  // Set up global hotkey listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A keystroke recorder has the keyboard: every chord must reach it
      // untouched, including chords currently bound to an action.
      if (suspendedRef.current > 0) return

      // Build context snapshot from DOM state at event time
      const context = getKeybindingContext(e)

      // Check all actions for matching hotkey
      for (const [actionId, action] of Object.entries(actions)) {
        // Read overrides through the ref, not through `getHotkey`: rebinding
        // must not tear down and re-add a capture-phase window listener.
        const id = actionId as ActionId
        const hotkey = overridesRef.current.has(id)
          ? overridesRef.current.get(id) ?? null
          : actions[id].defaultHotkey
        if (!hotkey || !matchesHotkey(e, hotkey)) continue

        // Evaluate when-clause against current context
        if (!evaluateWhen((action as ActionDefinition).when, context)) continue

        const handlers = handlersRef.current.get(actionId as ActionId) || []
        for (const handler of handlers) {
          if (!handler.enabled || handler.enabled()) {
            e.preventDefault()
            e.stopPropagation()
            handler.handler()
            return
          }
        }
      }
    }

    // Capture phase for reliable interception
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const value = useMemo<ActionRegistryContextType>(() => ({
    register,
    execute,
    getHotkey,
    getHotkeyDisplay,
    getAction,
    userOverrides,
    setHotkeyOverride,
    resetHotkeyOverride,
    suspendHotkeys,
  }), [
    register,
    execute,
    getHotkey,
    getHotkeyDisplay,
    getAction,
    userOverrides,
    setHotkeyOverride,
    resetHotkeyOverride,
    suspendHotkeys,
  ])

  return (
    <ActionRegistryContext.Provider value={value}>
      {children}
    </ActionRegistryContext.Provider>
  )
}

export function useActionRegistry() {
  const context = useContext(ActionRegistryContext)
  if (!context) {
    throw new Error('useActionRegistry must be used within ActionRegistryProvider')
  }
  return context
}

/**
 * UB14.33 — the registry when one is mounted, else `null`. For a component that ALSO renders outside
 * `ActionRegistryProvider` (the composer zone under a test probe or a structured-only playground state) and only
 * reads a binding, falling back to the shipped default where there is no registry to ask.
 */
export function useOptionalActionRegistry(): ActionRegistryContextType | null {
  return useContext(ActionRegistryContext)
}

// ─────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────

/**
 * P6.480 — exported so a component that must handle a chord ITSELF can still
 * ask the registry which chord that is.
 *
 * The composer's send chords are its own (`Enter`, `Shift+Enter`,
 * `Cmd/Ctrl+Enter`) because they act on the draft, the attachments and the
 * mention state that live in that component; routing them through a global
 * handler would mean pushing all three out. But a chord nobody can rebind and
 * nothing collision-checks is the shape this registry exists to remove, so the
 * ACTION is registered here and the composer matches this function against the
 * action's CURRENT hotkey rather than against a literal.
 */
export function hotkeyMatchesEvent(e: KeyboardEvent, hotkey: string): boolean {
  return matchesHotkey(e, hotkey)
}

function matchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  const needsMod = parts.includes('mod')
  const needsShift = parts.includes('shift')
  const needsAlt = parts.includes('alt')

  const modPressed = isMac ? e.metaKey : e.ctrlKey
  const logicalKeyMatches = e.key.toLowerCase() === key

  // Handle special keys via physical code where logical values can vary by layout.
  const specialKeys: Record<string, string> = {
    '[': 'BracketLeft',
    ']': 'BracketRight',
    ',': 'Comma',
    '.': 'Period',
    'left': 'ArrowLeft',
    'right': 'ArrowRight',
    'up': 'ArrowUp',
    'down': 'ArrowDown',
    'escape': 'Escape',
    'tab': 'Tab',
  }

  const specialCode = specialKeys[key]

  // Important: for text shortcuts (A-Z/0-9), match logical key only.
  // Mixing in physical code (e.g. KeyQ) causes AZERTY/QWERTZ collisions such as
  // Cmd+A incorrectly matching a Cmd+Q binding.
  const codeMatches = specialCode
    ? e.code === specialCode
    : logicalKeyMatches

  // Check modifier requirements
  const modCorrect = needsMod ? modPressed : !modPressed
  const shiftCorrect = needsShift ? e.shiftKey : !e.shiftKey
  const altCorrect = needsAlt ? e.altKey : !e.altKey

  return codeMatches && modCorrect && shiftCorrect && altCorrect
}
