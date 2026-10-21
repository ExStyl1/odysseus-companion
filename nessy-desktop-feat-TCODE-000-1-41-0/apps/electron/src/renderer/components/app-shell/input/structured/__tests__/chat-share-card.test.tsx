import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest as PermissionRequestData } from '../../../../../../shared/types'
import { PermissionRequest } from '../PermissionRequest'
import { chatShareSummary, type ArtifactPublishCardData } from '../artifact-publish-card'
import { PublishedPagesView } from '../../../../artifacts/PublishedPagesSection'

/**
 * UA1.26 — the SAME host card (UA1.18) for a chat share (UA1.25 sets `chatShare`): it names what the snapshot did
 * (secrets masked by rule, paths rewritten, tool outputs cut) instead of a file line, and its Allow says Share. The
 * i18n bundle is empty on purpose (`ArtifactPublishDetails.test.tsx`): `t(key)` returns the key.
 */

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  })
})

function card(overrides: Partial<ArtifactPublishCardData> = {}): ArtifactPublishCardData {
  return {
    mode: 'create',
    sourcePath: 'Fix the build',
    contentType: 'markdown',
    title: 'Fix the build',
    emoji: '💬',
    byteLength: 120,
    lineCount: 4,
    sha256: 'abcdef0123456789'.repeat(4),
    serviceOrigin: 'https://t-artifacts.t-tech.team',
    expiresAt: '2026-10-09T12:00:00.000Z',
    retentionDays: 7,
    previewContent: '# Fix the build',
    previewTruncated: false,
    sourceHead: '# Fix the build',
    scriptCount: 0,
    externalHosts: [],
    scanSentence: 'Automatic check found no known token formats; it does not detect encoded or free-form secrets or client data.',
    emailCount: 0,
    phoneCount: 0,
    ...overrides,
  }
}

function render(artifactPublish: ArtifactPublishCardData): string {
  const data: PermissionRequestData = {
    sessionId: 'session-a',
    requestId: 'publish-artifact-1',
    toolName: 'publish_artifact',
    description: 'Publish "Fix the build" on https://t-artifacts.t-tech.team.',
    origin: 'host_gate',
    noAlwaysAllow: true,
    artifactPublish,
  }
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PermissionRequest request={data} onResponse={() => {}} />
    </I18nextProvider>,
  )
}

const chatShare = {
  maskedSecrets: [{ rule: 'jwt', count: 2 }, { rule: 'bearer', count: 1 }],
  maskedSecretTotal: 3,
  relativisedPaths: 5,
  truncatedPayloads: 1,
}

describe('UA1.26 — the chat share card', () => {
  test('positive: the snapshot counts replace the file line, and Allow says Share', () => {
    const html = render(card({ chatShare }))
    expect(html).toContain('data-testid="artifact-publish-chat"')
    for (const key of ['chat.artifactPublish.chatContent', 'chat.artifactPublish.chatMasked', 'chat.artifactPublish.chatPaths', 'chat.artifactPublish.chatTruncated']) {
      expect(html, key).toContain(key)
    }
    expect(html).not.toContain('chat.artifactPublish.file')
    expect(html).toContain('sessionMenu.share')
    expect(html).not.toContain('chat.artifactPublish.publish')
    expect(chatShareSummary({ chatShare })).toEqual({ maskedTotal: 3, maskedRules: 'jwt ×2, bearer ×1', relativisedPaths: 5, truncatedPayloads: 1 })
  })

  test('negative: a file card shows its file line and no chat lines; nothing masked says so, nothing cut is not drawn', () => {
    const file = render(card({ sourcePath: 'report.md' }))
    expect(file).toContain('chat.artifactPublish.file')
    expect(file).not.toContain('artifact-publish-chat')
    expect(file).toContain('chat.artifactPublish.publish')
    expect(chatShareSummary({})).toBeNull()

    const clean = render(card({ chatShare: { maskedSecrets: [], maskedSecretTotal: 0, relativisedPaths: 0, truncatedPayloads: 0 } }))
    expect(clean).toContain('chat.artifactPublish.chatMaskedNone')
    expect(clean).not.toContain('chat.artifactPublish.chatTruncated')
  })
})

describe('UA1.26 — the Published pages list badges a shared chat', () => {
  test('a chat row carries the badge; a file row and an outside row do not', () => {
    const base = { url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', expiresAt: null, retentionDays: 0 }
    const noop = () => {}
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <PublishedPagesView
          status="ok"
          rows={[
            { ...base, id: 'chat-1', title: 'Fix the build', source: { sessionId: 's1', path: 'Fix the build', kind: 'chat' } },
            { ...base, id: 'file-1', title: 'Report', source: { sessionId: 's1', path: 'report.md', kind: 'file' } },
            { ...base, id: 'outside-1', title: 'Elsewhere' },
          ]}
          now={Date.parse('2026-10-02T00:00:00.000Z')}
          onOpen={noop} onCopy={noop} onExtend={noop} onDelete={noop} onRetry={noop}
        />
      </I18nextProvider>,
    )
    expect(html.split('data-testid="published-page-chat-badge"').length - 1).toBe(1)
    expect(html).toContain('settings.workspace.publishedPages.chatBadge')
  })
})
