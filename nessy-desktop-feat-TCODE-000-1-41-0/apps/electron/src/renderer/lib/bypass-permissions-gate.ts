/**
 * The bypassPermissions responsibility gate (permission-modes.md).
 *
 * Claude makes bypass launch-only and shows a one-time responsibility
 * acknowledgment, saved "to user settings". The desktop analog: the FIRST
 * activation of `bypassPermissions` on this install raises a confirmation
 * dialog; accepting records the acknowledgment durably in the user config
 * tier (`bypassPermissionsAcknowledged` in config.json, via
 * `getBypassPermissionsAcknowledged`/`setBypassPermissionsAcknowledged` in
 * `@nessy-agent/shared/config/storage`) and every later activation switches
 * directly. Declining leaves the session in its current mode.
 *
 * T5 (2026-08-12): config.json is now the single durable source — it used to
 * live only in renderer localStorage. A legacy localStorage flag from an
 * older build is migrated into config on first read (one-way: the
 * localStorage entry is never deleted, so a downgrade to an older build does
 * not re-prompt endlessly).
 *
 * Async by necessity, not by choice: unlike some settings, the renderer does
 * not receive a bundled "config snapshot" object at startup that this value
 * could piggyback on — every sibling config boolean in this app (
 * notificationsEnabled, autoCapitalisation, spellCheck, ...) is its own
 * separate async IPC round trip, called from within whichever component
 * needs it. This gate follows the same shape. Its two call sites (App.tsx's
 * `handleSessionOptionsChange` and the BypassPermissionsDialog's `onConfirm`)
 * are both callbacks that can await.
 *
 * NOT writable through any model-invocable surface: the config key lives in
 * config.json (storage.ts), a wholly separate file/loader from
 * preferences.json (config/preferences.ts), which is the only thing
 * `update_user_preferences` can touch — and that tool's own args schema
 * (`UpdatePreferencesArgs` in session-tools-core) does not carry this field
 * even by name. The SET IPC channel has exactly two callers, both in this
 * module and both inside the trusted renderer: the dialog's accept handler via
 * `recordBypassPermissionsAcknowledgment`, and the one-way legacy migration
 * inside `needsBypassPermissionsAcknowledgment` below. Neither is reachable by
 * a model or a remote peer.
 */

const BYPASS_ACK_STORAGE_KEY = 'nessy:bypass-permissions-acknowledged';

type StringStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The two config IPC methods this gate needs — a structural subset of ElectronAPI. */
export interface BypassAckConfigApi {
  getBypassPermissionsAcknowledged(): Promise<boolean>;
  setBypassPermissionsAcknowledged(acknowledged: boolean): Promise<void>;
}

/**
 * Arbitrates overlapping gate checks: only the LATEST one may act on its result.
 *
 * The gate check became an IPC round trip in T5. Before that it ran in a single
 * JS tick, so "check then act" was implicitly atomic. Now a second option change
 * can complete while the first is still awaiting; when the first resumes it
 * would raise the responsibility dialog for a request the user has already moved
 * past — and the dialog names neither the session nor the mode, so confirming it
 * looks like confirming the latest action and silently switches a session into
 * `bypassPermissions` nobody asked for.
 *
 * Lives here rather than inline in the component so the rule is testable: this
 * app has no React test harness, and its renderer tests cover extracted logic
 * (see `utils/__tests__/session-list-collapse.test.ts` for the same shape).
 */
export interface BypassGateArbiter {
  /** Take a ticket before awaiting the check. */
  begin(): number;
  /** True only if no later check has begun since this ticket was taken. */
  isCurrent(ticket: number): boolean;
}

export function createBypassGateArbiter(): BypassGateArbiter {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (ticket: number) => ticket === generation,
  };
}

/**
 * True when switching to bypassPermissions must first show the dialog.
 *
 * Reads the durable config key first. If it is not yet true, falls back to
 * the legacy localStorage flag as a ONE-WAY migration source: finding it set
 * writes the config key (best effort) and answers "no need to ask" without
 * ever deleting the legacy entry. Any failure (IPC unavailable, storage
 * unavailable) is treated as "not yet acknowledged" — fail toward asking
 * again, never toward silently skipping the dialog.
 */
export async function needsBypassPermissionsAcknowledgment(
  storage: StringStorage = window.localStorage,
  configApi: BypassAckConfigApi = window.electronAPI,
): Promise<boolean> {
  try {
    if (await configApi.getBypassPermissionsAcknowledged()) return false;
  } catch {
    // Can't confirm durably right now — fall through to the legacy check and,
    // failing that, ask again rather than silently skip.
  }

  try {
    if (storage.getItem(BYPASS_ACK_STORAGE_KEY) === '1') {
      // One-way migration: legacy localStorage becomes the durable config
      // key. The localStorage entry itself is never deleted here — a
      // downgrade to an older build must not re-prompt endlessly.
      try {
        await configApi.setBypassPermissionsAcknowledged(true);
      } catch {
        // Best effort: if this didn't stick, the dialog simply asks again
        // next time (same as any other write failure below).
      }
      return false;
    }
  } catch {
    // No storage (tests, corrupted profile): keep asking rather than skip.
  }

  return true;
}

/** Record that the user accepted responsibility for bypassPermissions. */
export async function recordBypassPermissionsAcknowledgment(
  configApi: BypassAckConfigApi = window.electronAPI,
): Promise<void> {
  try {
    await configApi.setBypassPermissionsAcknowledged(true);
  } catch {
    // Best effort: the dialog will simply show again next time.
  }
}
