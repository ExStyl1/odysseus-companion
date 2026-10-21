/** UA1.19 — the Published pages list's decisions (`published-pages.ts`), asserted on values. */
import { describe, expect, test } from 'bun:test'
import {
  EXTEND_RETENTION_CHOICES,
  deleteOutcomeToast,
  publishedPageActions,
  publishedPageState,
} from '../published-pages'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

describe('UA1.19 published-pages decisions', () => {
  test('states: live, expiring in under 24 h, expired, no expiry, pending deletion', () => {
    expect(publishedPageState({ expiresAt: new Date(NOW + 72 * HOUR).toISOString() }, NOW)).toBe('live')
    expect(publishedPageState({ expiresAt: new Date(NOW + 23 * HOUR).toISOString() }, NOW)).toBe('expiring-soon')
    expect(publishedPageState({ expiresAt: new Date(NOW - HOUR).toISOString() }, NOW)).toBe('expired')
    expect(publishedPageState({ expiresAt: null }, NOW)).toBe('live')
    // A pending deletion wins over any expiry.
    expect(publishedPageState({ expiresAt: null, pendingDelete: { requestedAt: '2026-10-01T00:00:00.000Z' } }, NOW)).toBe('pending-deletion')
  })

  test('a live row offers open, copy, extend and delete', () => {
    expect(publishedPageActions('live')).toEqual({ open: true, copy: true, extend: true, delete: true })
    expect(publishedPageActions('expiring-soon').extend).toBe(true)
  })

  test('negative: an expired row offers no extend (and no open or copy of a dead link); a pending deletion offers nothing', () => {
    expect(publishedPageActions('expired')).toEqual({ open: false, copy: false, extend: false, delete: true })
    expect(publishedPageActions('pending-deletion')).toEqual({ open: false, copy: false, extend: false, delete: false })
  })

  test('extend offers unlimited (0) — the one place it can be set — and nothing outside 0..36500', () => {
    expect(EXTEND_RETENTION_CHOICES).toContain(0)
    expect(EXTEND_RETENTION_CHOICES.every(days => Number.isInteger(days) && days >= 0 && days <= 36_500)).toBe(true)
  })

  test('a delete kept for retry is a WARNING with the reason, never a silent success', () => {
    expect(deleteOutcomeToast({ outcome: 'deleted' }).kind).toBe('success')
    const pending = deleteOutcomeToast({ outcome: 'pending', errorKind: 'needs-login', message: 'dp is not signed in.' })
    expect(pending).toEqual({ kind: 'warning', key: 'settings.workspace.publishedPages.deletePending', description: 'dp is not signed in.' })
    expect(deleteOutcomeToast({ outcome: 'failed', errorKind: 'forbidden', message: 'x' }).kind).toBe('error')
  })
})
