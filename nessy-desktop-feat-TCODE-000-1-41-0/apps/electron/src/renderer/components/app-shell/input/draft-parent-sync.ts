/**
 * The composer's draft ↔ parent-draft synchronisation, extracted from
 * `FreeFormInput` so that its ORDERING is testable.
 *
 * `FreeFormInput` keeps the text the user is typing in local state (parent
 * re-renders on every keystroke are too expensive), and mirrors it to the
 * parent draft store on a 300 ms debounce. The parent can also push a value
 * back the other way — a session switch, a deep-link prefill, an inserted
 * queued message, and the Stop button's "put the in-flight prompt back in the
 * composer" restore (`ChatDisplay.handleStop`) all arrive as a changed
 * `inputValue` prop.
 *
 * Those two directions race, and the race is the reason this module exists.
 * The clear-on-submit path always cancelled its pending debounced write; the
 * PARENT-DRIVEN RE-SEED path did not, so a write scheduled before the re-seed
 * landed after it and overwrote the parent draft with the pre-seed text —
 * while the composer's own local state kept showing the seeded text. The two
 * then disagreed permanently, because the guard that decides whether to
 * re-seed compares against the last value synced to the parent, which the late
 * write had just moved. `acceptParentValue` cancels the pending write for
 * exactly that reason.
 *
 * The notifier (`onInputChange`) is passed in per call rather than captured
 * once: its identity is bound to the session id in `ChatPage`, and the
 * unmount-time flush deliberately runs with the callback from the render that
 * scheduled it, so a draft in flight during a session switch lands on the
 * session it was typed in.
 *
 * `seedComposerFromParent` carries the ENTIRE parent → composer direction,
 * decision and consequence together, because splitting them is what left the
 * consequence unpinned: while the component held `if (accept(v)) setInput(v)`,
 * deleting that `setInput` — which kills every session switch, deep-link
 * prefill, queued-message insert and Stop restore — left the whole zone suite
 * green, since the only thing watching it was a source-text match on the
 * `accept` call.
 */

import { coerceInputText } from '@/lib/input-text'

export type DraftSyncNotifier = (value: string) => void

type TimerHandle = ReturnType<typeof setTimeout>

export interface DraftParentSyncDeps {
  /** Debounce window for composer → parent writes. */
  debounceMs?: number
  schedule?: (fn: () => void, ms: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
}

export interface DraftParentSync {
  /** Debounced mirror of the composer's own value into the parent draft. */
  syncToParent(value: string, notify?: DraftSyncNotifier): void
  /**
   * A parent-driven value arrived. Returns `true` when the composer must
   * re-seed its local state from it. Cancels any pending composer → parent
   * write, so a stale write cannot land on top of the seeded value.
   */
  acceptParentValue(value: string): boolean
  /** The draft was consumed (submit) or discarded (clear). */
  markCleared(notify?: DraftSyncNotifier): void
  /**
   * Unmount / notifier handover: drop the pending write and flush the live
   * local value if it never reached the parent.
   */
  flushOnUnmount(localValue: string, notify?: DraftSyncNotifier): void
  /** The last value this composer knows the parent draft to hold. */
  readonly lastSyncedValue: string
  /** The value a still-pending debounced write would deliver, if any. */
  readonly pendingValue: string | null
}

export const DRAFT_PARENT_SYNC_DEBOUNCE_MS = 300

export function createDraftParentSync(
  initialValue: string,
  deps: DraftParentSyncDeps = {},
): DraftParentSync {
  const debounceMs = deps.debounceMs ?? DRAFT_PARENT_SYNC_DEBOUNCE_MS
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.cancel ?? ((handle) => clearTimeout(handle))

  let lastSynced = initialValue
  let handle: TimerHandle | null = null
  let pending: string | null = null

  const cancelPending = () => {
    if (handle !== null) cancel(handle)
    handle = null
    pending = null
  }

  return {
    syncToParent(value, notify) {
      if (!notify) return
      cancelPending()
      pending = value
      handle = schedule(() => {
        handle = null
        pending = null
        notify(value)
        lastSynced = value
      }, debounceMs)
    },

    acceptParentValue(value) {
      if (value === lastSynced) return false
      cancelPending()
      lastSynced = value
      return true
    },

    markCleared(notify) {
      cancelPending()
      notify?.('')
      lastSynced = ''
    },

    flushOnUnmount(localValue, notify) {
      cancelPending()
      if (notify && localValue !== lastSynced) notify(localValue)
    },

    get lastSyncedValue() {
      return lastSynced
    },

    get pendingValue() {
      return pending
    },
  }
}

/**
 * Apply a parent-driven draft value to the composer's local state.
 *
 * This is the whole parent → composer direction: the `undefined` guard (the
 * parent has no draft store wired at all — leave the composer alone), the
 * coercion of a stale/malformed persisted draft, the re-seed decision, and the
 * re-seed itself. Every parent-driven composer update goes through here — a
 * session switch, a deep-link prefill, an inserted queued message, and
 * `ChatDisplay.handleStop`'s "put the in-flight prompt back" restore.
 *
 * Returns whether the composer was re-seeded.
 */
export function seedComposerFromParent(
  sync: DraftParentSync,
  parentValue: string | undefined,
  setComposerValue: (value: string) => void,
): boolean {
  if (parentValue === undefined) return false
  const nextValue = coerceInputText(parentValue)
  if (!sync.acceptParentValue(nextValue)) return false
  setComposerValue(nextValue)
  return true
}
