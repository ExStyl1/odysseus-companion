/**
 * Session Options Types
 *
 * Type definitions and helpers for session-scoped settings.
 * The actual hook is in AppShellContext.tsx as useSessionOptionsFor().
 *
 * ADDING A NEW SESSION OPTION:
 * 1. Add field to SessionOptions interface below
 * 2. Update defaultSessionOptions
 * 3. Add UI control in FreeFormInput.tsx (or wherever needed)
 */

import type { PermissionMode } from '../../shared/types'
import type { ThinkingLevel } from '@nessy-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL } from '@nessy-agent/shared/agent/thinking-levels'

/**
 * All session-scoped options in one place.
 */
export interface SessionOptions {
  /** Permission mode ('dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions') */
  permissionMode: PermissionMode
  /** Monotonic version from backend permission mode state (used to ignore stale events) */
  permissionModeVersion?: number
  /** Session-level thinking level — sticky, persisted. See {@link ThinkingLevel}. */
  thinkingLevel: ThinkingLevel
  /**
   * QK5 — the ultracode toggle, PER SESSION and never a saved default.
   *
   * That is the vendor's own scope rather than a shortcut: `sdk.d.ts` calls the
   * setting "Session-scoped … interactive toggles never persist it", and
   * `settings-reference.md#ultracode` says `/effort ultracode` "turns ultracode
   * on for the current session only". It is synced from the session record on
   * mount for the same reason the two options above are — a composer that
   * remounts must not draw OFF while the session is ON.
   */
  ultracode: boolean
}

/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'default', // The manual mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'medium' level
  ultracode: false, // `settings-reference.md#ultracode`: "Default: unset, so ultracode is off"
}

/** Type for partial updates to session options */
export type SessionOptionUpdates = Partial<SessionOptions>

/** Helper to merge session options with updates */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  return {
    ...defaultSessionOptions,
    ...current,
    ...updates,
  }
}
