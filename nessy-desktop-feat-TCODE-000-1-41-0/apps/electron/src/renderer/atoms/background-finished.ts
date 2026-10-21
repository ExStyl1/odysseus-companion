/**
 * UA1.15 — Jotai atoms for the "background session finished" appearance preference.
 *
 * Copied from v0.13.4:apps/electron/src/renderer/atoms/background-finished.ts
 * (craft-agents-oss, Apache-2.0; upstream v0.11.0, made a preference defaulting
 * to off in v0.11.2). Owner 2026-09-23 (OQ-20 item 3): "Да, выключен по
 * умолчанию". Adaptations, each named here:
 *   - the localStorage key is rebranded `craft-*` → `nessy-*`;
 *   - `visibleSessionIdsAtom` lives in `atoms/panel-stack.ts`, upstream's
 *     location — this file held it while no row owned that one (UA1.15), and
 *     UA12.16 moved it there, reading it back from this module's detector;
 *   - the App-level detector upstream inlines in `App.tsx` is
 *     {@link queueBackgroundFinished} here, so `App.tsx` (cited by line in the
 *     docs) calls it from ONE existing line instead of growing ten;
 *   - {@link useBackgroundFinishedChipPreference} is the Appearance toggle's
 *     one import (upstream reads the atom there with `useAtom`).
 *
 * When a session running in the background finishes while the user is viewing a
 * different session, an in-app chip surfaces that completion in the chat input's
 * top-right corner — the in-app complement to the OS notification, which only
 * fires when the whole app is unfocused (`hooks/useNotifications.ts`, unchanged
 * by this row). This atom gates whether that chip is shown.
 *
 * It's an appearance *preference* — a per-user, per-machine choice, not a
 * feature gate and not a StoredConfig key — so it persists to localStorage via
 * `atomWithStorage`: reactive, multi-window, no RPC/disk-config. The value is
 * read reactively in two places (the App-level completion detector and the
 * chat-view render gate), which is exactly what a persisted atom is for.
 *
 * The chip's transient runtime state — the queue of finished sessions plus its
 * push/dismiss action atoms — lives below the preference. The queue is a plain
 * (non-persisted) atom: a "you missed this" signal that should not survive a
 * reload.
 */

import { atom, useAtom, type createStore } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { visibleSessionIdsAtom } from '@/atoms/panel-stack'
import { getSessionTitle } from '@/utils/session'

/** Whether the in-app "background session finished" chip is shown. Default off. */
export const showBackgroundFinishedChipAtom = atomWithStorage<boolean>(
  'nessy-show-background-finished-chip',
  false
)

/** The Appearance page's toggle: `[enabled, setEnabled]`. */
export function useBackgroundFinishedChipPreference() {
  return useAtom(showBackgroundFinishedChipAtom)
}

export interface BackgroundFinishedEntry {
  /** The session that finished in the background. */
  sessionId: string
  /** Resolved display title at completion time (via `getSessionTitle`). */
  title: string
  /** Epoch ms the completion was observed — used to surface the most recent. */
  finishedAt: number
}

/** Transient queue of background completions awaiting acknowledgement. */
export const backgroundFinishedAtom = atom<BackgroundFinishedEntry[]>([])

/**
 * Push (or refresh) a background completion. Re-finishing the same session
 * replaces its prior entry and moves it to the most-recent (tail) position.
 */
export const pushBackgroundFinishedAtom = atom(
  null,
  (get, set, entry: BackgroundFinishedEntry) => {
    const next = get(backgroundFinishedAtom).filter(e => e.sessionId !== entry.sessionId)
    next.push(entry)
    set(backgroundFinishedAtom, next)
  }
)

/**
 * Remove a session's entry — used on navigate, manual dismiss, and whenever the
 * session is opened (a session on screen is never announced as "background").
 * No-ops when the session isn't queued, to avoid spurious re-renders.
 */
export const dismissBackgroundFinishedAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const current = get(backgroundFinishedAtom)
    const next = current.filter(e => e.sessionId !== sessionId)
    if (next.length !== current.length) {
      set(backgroundFinishedAtom, next)
    }
  }
)

type Store = ReturnType<typeof createStore>

/**
 * The App-level detector (upstream inlines it in `App.tsx`'s `complete` branch,
 * right after the OS notification). In-app complement to the OS notification:
 * when a *background* session (one not shown in any open panel) finishes, queue
 * a chip above the chat. The OS notification is suppressed while the window is
 * focused, so the chip is the only completion signal then. The caller has
 * already skipped hidden (mini-agent) sessions. Returns whether it queued.
 */
export function queueBackgroundFinished(
  store: Store,
  sessionId: string,
  session: Parameters<typeof getSessionTitle>[0],
  now: number = Date.now(),
): boolean {
  if (!store.get(showBackgroundFinishedChipAtom)) return false
  if (store.get(visibleSessionIdsAtom).has(sessionId)) return false
  store.set(pushBackgroundFinishedAtom, {
    sessionId,
    title: getSessionTitle(session),
    finishedAt: now,
  })
  return true
}

/**
 * The entry this row announces: the most-recent background completion that is
 * not the session on screen, and only in the FOCUSED session's row, so split
 * views don't double up. Lifted out of the chip's body (upstream computes it
 * inline) so the selection is unit-testable without a DOM.
 */
export function selectBackgroundFinishedEntry(input: {
  enabled: boolean
  queue: readonly BackgroundFinishedEntry[]
  focusedSessionId: string | null
  sessionId: string
}): BackgroundFinishedEntry | undefined {
  if (!input.enabled || input.focusedSessionId !== input.sessionId) return undefined
  return [...input.queue].reverse().find(e => e.sessionId !== input.sessionId)
}
