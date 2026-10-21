/* Copied from v0.15.1:apps/electron/src/renderer/atoms/label-value-edit.ts (craft-agents-oss, Apache-2.0) by UB14.6,
   2026-10-16 (added in v0.15.0). Read by `chat-header/ChatHeaderLabels.tsx`; the composer's `#` menu writes it from
   UB14.33 (until then our badge row's `autoOpenLabelId` opens a composer-applied valued label's editor). */
/**
 * A valued label the user just applied from the composer's `#` menu.
 *
 * Label chips live in the chat header (design spec §7.3), not next to the composer, so the composer
 * can't open the new chip's value editor itself. It records the request here; the header's chip for
 * that label opens its value popover once the label arrives in the session's metadata (a server
 * round-trip later), then clears the request.
 */

import { atom } from 'jotai'

export interface PendingLabelValueEdit {
  sessionId: string
  /** Panel whose composer asked (the same session can be open in two panels); undefined outside a panel */
  panelId?: string
  labelId: string
  /** `Date.now()` when requested: a request whose label never arrives must not fire much later */
  requestedAt: number
}

export const pendingLabelValueEditAtom = atom<PendingLabelValueEdit | null>(null)

/** How long a request waits for its label to show up in the session's metadata. */
export const PENDING_LABEL_VALUE_EDIT_TTL_MS = 10_000
