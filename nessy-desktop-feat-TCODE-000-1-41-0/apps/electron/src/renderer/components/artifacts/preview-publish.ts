/**
 * UA1.23 — what the renderer shows for the host's answer to a preview's "Publish" (`artifacts:publishFile`), as a
 * value. The verdict is UA1.18's (`PublishArtifactVerdict`): the card, the 7-day default and every refusal are the
 * host's; this only picks the toast. A link is shown, never copied silently.
 */
import type { ArtifactPublishFileResult } from '@nessy-agent/shared/protocol'

export interface PreviewPublishToast {
  kind: 'success' | 'info' | 'error'
  key: string
  description?: string
}

export function previewPublishToast(result: ArtifactPublishFileResult): PreviewPublishToast {
  switch (result.status) {
    case 'published':
    case 'updated':
      return { kind: 'success', key: 'preview.publishDone', ...(result.url ? { description: result.url } : {}) }
    case 'denied':
      return { kind: 'info', key: 'preview.publishDeclined' }
    default:
      return { kind: 'error', key: 'preview.publishFailed', description: result.note }
  }
}
