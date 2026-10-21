import { describe, expect, test } from 'bun:test'
import { shareExpiryLabel, shareToastView } from '../share-result-toast'

/** UA1.26 — the Share menu's toasts as values (both share surfaces read them). */
describe('shareToastView', () => {
  test('share: success names the link and carries its expiry', () => {
    const view = shareToastView('share', { success: true, url: 'https://t-artifacts.t-tech.team/a/x', expiresAt: '2026-10-09T00:00:00.000Z' })
    expect(view).toEqual({
      kind: 'success',
      key: 'toast.linkCopied',
      description: 'https://t-artifacts.t-tech.team/a/x',
      expiresAt: '2026-10-09T00:00:00.000Z',
    })
  })

  test('a declined card is no toast at all, and a failure is an error with its sentence', () => {
    expect(shareToastView('share', { success: false, declined: true, error: 'declined' })).toEqual({ kind: 'none' })
    expect(shareToastView('update', { success: false, error: 'dp is not signed in.' }))
      .toEqual({ kind: 'error', key: 'chat.failedToUpdateShare', description: 'dp is not signed in.' })
    expect(shareToastView('share', undefined)).toEqual({ kind: 'error', key: 'toast.failedToShare' })
  })

  test('stop sharing: a kept deletion is a warning, a clean DELETE a success', () => {
    expect(shareToastView('revoke', { success: true, deletionPending: true, message: 'network' }))
      .toEqual({ kind: 'warning', key: 'settings.workspace.publishedPages.deletePending', description: 'network' })
    expect(shareToastView('revoke', { success: true })).toEqual({ kind: 'success', key: 'chat.sharingStopped' })
  })

  test('the expiry label is absolute; an unparsable value is shown as given', () => {
    expect(shareExpiryLabel('2026-10-09T00:00:00.000Z', 'en')).toContain('2026')
    expect(shareExpiryLabel('soon', 'en')).toBe('soon')
  })
})
