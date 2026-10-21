/**
 * The host-side gates a Page frame's messages pass before PageFrame acts on them (UA7.3).
 *
 * Ours, not a copy: the checks are upstream's (v0.13.4 `PageFrame.tsx` L270–L296: `event.source`,
 * the opaque origin, the lease nonce, `isSafeExternalUrl`, user activation), lifted out of the
 * React effect so they are testable without a DOM, plus the two spec §14 adds for `open-url`
 * (OQ-12):
 *
 * - **Frame focus.** User activation alone also holds after a click on the HOST's own toolbar,
 *   so a page could time a link-out to a click that never touched it. The link-out is accepted
 *   only while the frame element is the host document's active element, i.e. the gesture was
 *   inside the frame.
 * - **Confirmation.** An accepted link-out is not opened: it is handed to a host dialog that
 *   shows the full URL, and only the user's confirm opens it (`settlePageOpenUrl`).
 *
 * UA9.3 adds the same two binds to the grant and action kinds (spec §15 "Page actions"):
 *
 * - **Mutating actions** (`isMutatingInvocation`: anything but an API GET) need user activation AND frame focus
 *   (`checkPageAction`); upstream asks activation alone, which a click on the host's toolbar also satisfies.
 * - **Grant requests** need user activation AND frame focus too (upstream: neither), one dialog at a time per page,
 *   and at most {@link GRANT_DIALOGS_PER_MINUTE} dialogs a minute (`checkPageGrantRequest`) — a page cannot open a
 *   prompt from a timer or on load, stack prompts, or re-prompt in a loop after each answer.
 *
 * Plain functions, no React or DOM, so `bun test` (no DOM in this repo) drives them directly.
 */

import type { PageActionDescriptor } from '@nessy-agent/shared/pages/types'
import { isSafeExternalUrl } from '../../../shared/page-bridge'

/** Only this frame's own window, with the opaque origin a sandbox without `allow-same-origin` has. */
export function isFromPageFrame(
  event: { source: unknown; origin: string },
  frameWindow: unknown,
): boolean {
  if (!frameWindow || event.source !== frameWindow) return false
  // No allow-same-origin → the frame's origin is opaque, serialized 'null'.
  return event.origin === 'null'
}

export type PageOpenUrlRefusal =
  | 'nonce-mismatch'
  | 'unsafe-url'
  | 'no-user-activation'
  | 'frame-not-focused'
  | 'confirmation-pending'

export interface PageOpenUrlRequest {
  /** The nonce the page echoed. */
  nonce: string
  url: string
  /** The render lease's nonce. */
  leaseNonce: string
  /** `navigator.userActivation.isActive` in the host window. */
  userActivation: boolean
  /** `document.activeElement === iframe` in the host window. */
  frameFocused: boolean
  /** A confirmation dialog is already up for an earlier link-out. */
  confirmationPending: boolean
}

export type PageOpenUrlDecision = { ok: true; url: string } | { ok: false; reason: PageOpenUrlRefusal }

/** Whether a page's `open-url` may be put to the user; it is never opened without their confirm. */
export function checkPageOpenUrl(req: PageOpenUrlRequest): PageOpenUrlDecision {
  if (req.nonce !== req.leaseNonce) return { ok: false, reason: 'nonce-mismatch' }
  if (!isSafeExternalUrl(req.url)) return { ok: false, reason: 'unsafe-url' }
  if (!req.userActivation) return { ok: false, reason: 'no-user-activation' }
  if (!req.frameFocused) return { ok: false, reason: 'frame-not-focused' }
  // One dialog at a time: a page cannot stack link-outs behind the one on screen.
  if (req.confirmationPending) return { ok: false, reason: 'confirmation-pending' }
  return { ok: true, url: req.url }
}

/**
 * The user's answer to the confirmation dialog. Confirm opens the URL it showed (re-checked:
 * the dialog never opens a non-http(s) URL even if one reached it); cancel opens nothing.
 * Either way the dialog closes — the returned value is the next pending URL (always null).
 */
export function settlePageOpenUrl(
  pendingUrl: string | null,
  decision: 'confirm' | 'cancel',
  openUrl: (url: string) => void,
): null {
  if (decision === 'confirm' && pendingUrl !== null && isSafeExternalUrl(pendingUrl)) {
    openUrl(pendingUrl)
  }
  return null
}

// ============================================================================
// UA9.3 — actions and grant requests
// ============================================================================

export type PageActionRefusal = 'nonce-mismatch' | 'user-activation-required' | 'frame-focus-required'

/** Whether a page's `action` may go to the host broker (which re-validates lease, nonce, replay and grant). */
export function checkPageAction(req: {
  nonce: string
  leaseNonce: string
  /** `isMutatingInvocation(invocation)` */
  mutating: boolean
  userActivation: boolean
  frameFocused: boolean
}): { ok: true } | { ok: false; reason: PageActionRefusal; error: string } {
  if (req.nonce !== req.leaseNonce) {
    return { ok: false, reason: 'nonce-mismatch', error: 'nonce-mismatch: request nonce does not match the render lease' }
  }
  if (req.mutating && !req.userActivation) {
    return { ok: false, reason: 'user-activation-required', error: 'user-activation-required: mutating actions need a fresh user gesture' }
  }
  if (req.mutating && !req.frameFocused) {
    return { ok: false, reason: 'frame-focus-required', error: 'frame-focus-required: mutating actions need a gesture inside the page' }
  }
  return { ok: true }
}

/** At most this many grant dialogs a page may open in a sliding minute (one at a time besides). */
export const GRANT_DIALOGS_PER_MINUTE = 3
const GRANT_DIALOG_WINDOW_MS = 60_000

export type PageGrantRequestRefusal =
  | 'nonce-mismatch'
  | 'no-user-activation'
  | 'frame-not-focused'
  | 'dialog-open'
  | 'rate-limited'

/**
 * Whether a page's `grant-request` may open a dialog. A refusal opens nothing; the frame answers with its current
 * grants, as upstream does for a request it does not prompt for.
 */
export function checkPageGrantRequest(req: {
  nonce: string
  leaseNonce: string
  userActivation: boolean
  frameFocused: boolean
  /** A grant dialog (or its host validation) is already in progress for this page. */
  dialogOpen: boolean
  /** When this frame's earlier grant dialogs opened (epoch ms). */
  recentDialogs: readonly number[]
  now: number
}): { ok: true } | { ok: false; reason: PageGrantRequestRefusal } {
  if (req.nonce !== req.leaseNonce) return { ok: false, reason: 'nonce-mismatch' }
  if (!req.userActivation) return { ok: false, reason: 'no-user-activation' }
  if (!req.frameFocused) return { ok: false, reason: 'frame-not-focused' }
  if (req.dialogOpen) return { ok: false, reason: 'dialog-open' }
  const recent = req.recentDialogs.filter(at => req.now - at < GRANT_DIALOG_WINDOW_MS)
  if (recent.length >= GRANT_DIALOGS_PER_MINUTE) return { ok: false, reason: 'rate-limited' }
  return { ok: true }
}

/** A grant request entry after the HOST validated it (`pages:describeGrantRequest`): what the dialog shows. */
export interface PendingGrantEntry {
  /** The page's own correlation id. */
  key: string
  /** Page-supplied; shown only under a "written by the page" label, never as the authority. */
  description?: string
  /** The descriptor the host parsed — the authority. */
  action: PageActionDescriptor
  /** For a script: the sha256 of the script's bytes when the host read them; the grant pins exactly this. */
  scriptSha256?: string
}

/** Stable identity for deny-memory and dedupe (upstream `descriptorSignature`, v0.13.4 PageFrame.tsx L84–L89). */
export function descriptorSignature(d: PageActionDescriptor): string {
  if (d.kind === 'mcp') return `mcp:${d.sourceSlug}:${d.toolName}`
  if (d.kind === 'script') return `script:${d.script}:${d.runtime ?? 'bun'}:${(d.args ?? []).join('\u0000')}`
  return `api:${d.sourceSlug}:${d.method}:${d.pathPattern}`
}
