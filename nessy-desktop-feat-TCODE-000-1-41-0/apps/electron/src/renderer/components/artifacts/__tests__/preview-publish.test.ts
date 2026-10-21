/** UA1.23 — the toast a preview Publish shows for each host verdict (`preview-publish.ts`). */
import { describe, expect, test } from 'bun:test'
import { previewPublishToast } from '../preview-publish'

describe('UA1.23 preview Publish toast', () => {
  test('a published page shows its link', () => {
    expect(previewPublishToast({ status: 'published', note: 'Published.', url: 'https://t-artifacts.t-tech.team/a/x', expiresAt: null }))
      .toEqual({ kind: 'success', key: 'preview.publishDone', description: 'https://t-artifacts.t-tech.team/a/x' })
  })

  test('negative: a declined card is not an error; a refusal or a failure shows the host sentence', () => {
    expect(previewPublishToast({ status: 'denied', note: 'declined' })).toEqual({ kind: 'info', key: 'preview.publishDeclined' })
    expect(previewPublishToast({ status: 'refused', note: 'outside the roots' })).toEqual({ kind: 'error', key: 'preview.publishFailed', description: 'outside the roots' })
    expect(previewPublishToast({ status: 'failed', note: 'needs-login' }).kind).toBe('error')
  })
})
