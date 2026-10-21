/**
 * UA1.26 — the toasts of the Share menu (Share, Update share, Stop sharing), as values (the `turn-preview.ts`
 * convention: a decision does not live in a component a test can only read as source). Read by BOTH share surfaces —
 * the session menus (`useSessionMenuActions`) and the chat header's Share button (`ChatShareMenu`, on that hook) — so they say the
 * same thing.
 *
 * - Share: the link is copied; the toast shows the link AND when it stops working (the host answers `expiresAt`,
 *   UA1.25: 7 days by default).
 * - A declined card (`declined`) is the person's own answer, not a failure: no toast, and nothing was sent.
 * - Stop sharing whose DELETE could not be sent now is a WARNING: the share is cleared and the deletion is kept and
 *   retried (the Published pages list's own sentence).
 */
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import type { ShareResult } from '@nessy-agent/shared/protocol'

export type ShareAction = 'share' | 'update' | 'revoke'

export type ShareToastView =
  | { kind: 'none' }
  | { kind: 'success' | 'warning' | 'error'; key: string; description?: string; expiresAt?: string | null }

/** The absolute expiry as the person's locale writes it. */
export function shareExpiryLabel(expiresAt: string, language?: string): string {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return expiresAt
  return date.toLocaleString(language, { dateStyle: 'long', timeStyle: 'short' })
}

export function shareToastView(action: ShareAction, result: ShareResult | undefined): ShareToastView {
  if (result?.declined) return { kind: 'none' }
  if (!result?.success) {
    const key = action === 'share' ? 'toast.failedToShare' : action === 'update' ? 'chat.failedToUpdateShare' : 'chat.failedToStopSharing'
    return { kind: 'error', key, ...(result?.error ? { description: result.error } : {}) }
  }
  if (action === 'revoke') {
    return result.deletionPending
      ? { kind: 'warning', key: 'settings.workspace.publishedPages.deletePending', ...(result.message ? { description: result.message } : {}) }
      : { kind: 'success', key: 'chat.sharingStopped' }
  }
  const key = action === 'share' ? 'toast.linkCopied' : 'chat.shareUpdated'
  return {
    kind: 'success',
    key,
    ...(result.url ? { description: result.url } : {}),
    ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
  }
}

/** Show a view: the description carries the link and, when known, `chat.shareExpires` / `chat.shareExpiresNever`. */
export function showShareToast(
  view: ShareToastView,
  t: TFunction,
  language?: string,
  action?: { label: string; onClick: () => void },
): void {
  if (view.kind === 'none') return
  const expiry = view.expiresAt === undefined
    ? undefined
    : view.expiresAt === null
      ? t('chat.shareExpiresNever')
      : t('chat.shareExpires', { date: shareExpiryLabel(view.expiresAt, language) })
  const description = [view.description, expiry].filter(Boolean).join(' · ')
    || (view.kind === 'error' ? t('toast.unknownError') : undefined)
  const options = { ...(description ? { description } : {}), ...(action ? { action } : {}) }
  if (view.kind === 'success') toast.success(t(view.key), options)
  else if (view.kind === 'warning') toast.warning(t(view.key), options)
  else toast.error(t(view.key), options)
}
