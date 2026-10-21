/**
 * UA1.19 — the Published pages list's presentation DECISIONS, as values (the `turn-preview.ts` convention): which
 * state a row is in, which actions it offers, which retention choices extend offers, and which sentence a delete
 * outcome shows. `PublishedPagesSection.tsx` renders them; `__tests__/published-pages.test.ts` asserts them without
 * a DOM. Ours — upstream v0.13.4 has no published-pages list (its share service is cut, reason (a)).
 */
import type { ArtifactDeleteResult, PublishedArtifactDto } from '@nessy-agent/shared/protocol'

/** Under 24 h left reads as "expiring soon" (plan UA1.19's playground state "expiring in under 24 h"). */
export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000

export type PublishedPageState = 'live' | 'expiring-soon' | 'expired' | 'pending-deletion'

export function publishedPageState(row: Pick<PublishedArtifactDto, 'expiresAt' | 'pendingDelete'>, now: number): PublishedPageState {
  if (row.pendingDelete) return 'pending-deletion'
  if (row.expiresAt === null) return 'live'
  const expires = Date.parse(row.expiresAt)
  if (!Number.isFinite(expires)) return 'live'
  if (expires <= now) return 'expired'
  return expires - now < EXPIRING_SOON_MS ? 'expiring-soon' : 'live'
}

export interface PublishedPageActions {
  open: boolean
  copy: boolean
  /** An expired link is 404 for good on the service; a row owed a deletion is on its way out. */
  extend: boolean
  /** A row owed a deletion is retried by the host; a second delete would add nothing. */
  delete: boolean
}

export function publishedPageActions(state: PublishedPageState): PublishedPageActions {
  switch (state) {
    case 'expired':
      return { open: false, copy: false, extend: false, delete: true }
    case 'pending-deletion':
      return { open: false, copy: false, extend: false, delete: false }
    default:
      return { open: true, copy: true, extend: true, delete: true }
  }
}

/** Extend's choices in days; 0 = no expiry (unlimited only from the UI, OQ-22 (b)). */
export const EXTEND_RETENTION_CHOICES: readonly number[] = [7, 30, 90, 365, 0]

/** The i18n key naming one retention choice. */
export function extendChoiceLabelKey(days: number): string {
  switch (days) {
    case 0: return 'settings.workspace.publishedPages.extendUnlimited'
    case 365: return 'settings.workspace.publishedPages.extend365'
    case 90: return 'settings.workspace.publishedPages.extend90'
    case 30: return 'settings.workspace.publishedPages.extend30'
    default: return 'settings.workspace.publishedPages.extend7'
  }
}

/** The toast a delete outcome shows: success, kept-for-retry (never silent), or failed. */
export function deleteOutcomeToast(result: ArtifactDeleteResult): { kind: 'success' | 'warning' | 'error'; key: string; description?: string } {
  switch (result.outcome) {
    case 'deleted':
      return { kind: 'success', key: 'settings.workspace.publishedPages.deleteDone' }
    case 'pending':
      return { kind: 'warning', key: 'settings.workspace.publishedPages.deletePending', description: result.message }
    case 'failed':
      return { kind: 'error', key: 'settings.workspace.publishedPages.deleteFailed', description: result.message }
  }
}

/** Absolute date for the row and the chip — a date a reader can act on, not "in 3 days". */
export function formatExpiryDate(iso: string, locale: string | undefined): string {
  const date = new Date(iso)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso
}
