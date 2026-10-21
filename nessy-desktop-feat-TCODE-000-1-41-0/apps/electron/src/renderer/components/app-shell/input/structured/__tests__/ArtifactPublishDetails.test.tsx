import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enMessages from '../../../../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../../../../packages/shared/src/i18n/locales/ru.json'
import type { PermissionRequest as PermissionRequestData } from '../../../../../../shared/types'
import { PermissionRequest } from '../PermissionRequest'
import {
  ARTIFACT_PREVIEW_CSP,
  artifactPreviewSrcDoc,
  artifactUpdateDiff,
  type ArtifactPublishCardData,
} from '../artifact-publish-card'

/**
 * UA1.18 — the `publish_artifact` card's host-gate variant: the person sees what is about to leave the machine
 * BEFORE answering, the preview cannot run the page, and nothing can be remembered.
 *
 * The i18n bundle is EMPTY on purpose (the `PermissionRequest.test.tsx` convention): `t(key)` returns the key, so
 * the assertions name the key contract rather than today's English copy.
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
    sourcePath: 'report.html',
    contentType: 'html',
    title: 'Q3 report',
    emoji: '📊',
    byteLength: 120,
    lineCount: 4,
    sha256: 'abcdef0123456789'.repeat(4),
    serviceOrigin: 'https://t-artifacts.t-tech.team',
    expiresAt: '2026-10-09T12:00:00.000Z',
    retentionDays: 7,
    previewContent: '<h1>Q3</h1><script>alert(1)</script><img src="https://tracker.example/p.gif">',
    previewTruncated: false,
    sourceHead: '<h1>Q3</h1>',
    scriptCount: 1,
    externalHosts: ['tracker.example'],
    scanSentence: 'Automatic check found no known token formats; it does not detect encoded or free-form secrets or client data.',
    emailCount: 2,
    phoneCount: 0,
    ...overrides,
  }
}

function request(artifactPublish: ArtifactPublishCardData): PermissionRequestData {
  return {
    sessionId: 'session-a',
    requestId: 'publish-artifact-1',
    toolName: 'publish_artifact',
    description: 'Publish "Q3 report" (report.html) on https://t-artifacts.t-tech.team.',
    origin: 'host_gate',
    noAlwaysAllow: true,
    artifactPublish,
  }
}

function render(data: PermissionRequestData): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PermissionRequest request={data} onResponse={() => {}} />
    </I18nextProvider>,
  )
}

describe('UA1.18 — the publish card shows the decision before the answer', () => {
  test('positive: access, owner, expiry, file, size, sha prefix, scripts, hosts, scan sentence and both previews are on the card', () => {
    const html = render(request(card()))
    expect(html).toContain('data-testid="artifact-publish-details"')
    for (const key of [
      'chat.artifactPublish.access',
      'chat.artifactPublish.owner',
      'chat.artifactPublish.expires',
      'chat.artifactPublish.file',
      'chat.artifactPublish.size',
      'chat.artifactPublish.scripts',
      'chat.artifactPublish.externalHosts',
      'chat.artifactPublish.scanSentence',
      'chat.artifactPublish.scanCounts',
      'chat.artifactPublish.preview',
      'chat.artifactPublish.source',
    ]) {
      expect(html, key).toContain(key)
    }
    // The Allow button says what it does; no remembering answer is drawn (noAlwaysAllow).
    expect(html).toContain('chat.artifactPublish.publish')
    expect(html).not.toMatch(/chat\.permissionAlwaysAllow(?!\.)/)
  })

  test('negative: the HTML preview cannot run the page or reach the network', () => {
    const html = render(request(card()))
    expect(html).toContain('data-testid="artifact-publish-frame"')
    expect(html).toContain('sandbox=""')
    // The deny-all CSP precedes the page's own markup in the frame document.
    const doc = artifactPreviewSrcDoc(card().previewContent)
    expect(doc.indexOf(ARTIFACT_PREVIEW_CSP)).toBeGreaterThan(-1)
    expect(doc.indexOf(ARTIFACT_PREVIEW_CSP)).toBeLessThan(doc.indexOf('<h1>Q3</h1>'))
    expect(ARTIFACT_PREVIEW_CSP).toContain("default-src 'none'")
    expect(ARTIFACT_PREVIEW_CSP).not.toContain('script-src')
  })

  test('an update shows its link, the kept expiry and the size/line change; a create shows none of them', () => {
    const update = render(request(card({
      mode: 'update',
      url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv',
      retentionDays: undefined,
      previous: { sha256: 'f'.repeat(64), byteLength: 100, lineCount: 6 },
    })))
    expect(update).toContain('chat.artifactPublish.update')
    expect(update).toContain('chat.artifactPublish.link')
    expect(update).toContain('chat.artifactPublish.expiresKept')
    expect(update).toContain('chat.artifactPublish.diffSized')
    expect(artifactUpdateDiff({ ...card({ mode: 'update', previous: { sha256: 'f'.repeat(64), byteLength: 100, lineCount: 6 } }) }))
      .toEqual({ kind: 'sized', byteDelta: '+20', lineDelta: '-2' })

    const create = render(request(card()))
    expect(create).not.toContain('chat.artifactPublish.link')
    expect(create).not.toContain('data-testid="artifact-publish-diff"')
    expect(artifactUpdateDiff(card())).toBeNull()
  })

  test('boundary: an unchanged update says so; a previous entry without a size says it was not recorded', () => {
    const sha = 'a'.repeat(64)
    expect(artifactUpdateDiff(card({ mode: 'update', sha256: sha, previous: { sha256: sha } }))).toEqual({ kind: 'unchanged' })
    expect(artifactUpdateDiff(card({ mode: 'update', previous: { sha256: 'b'.repeat(64) } }))).toEqual({ kind: 'unknown-size' })
  })

  test('UA12.66 — an update whose expiry the host could not resolve says so instead of claiming "never"', () => {
    const html = render(request(card({
      mode: 'update',
      url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv',
      retentionDays: undefined,
      expiresAt: null,
      expiresUnknown: true,
    })))
    expect(html).toContain('chat.artifactPublish.expiresUnknown')
    expect(html).not.toContain('chat.artifactPublish.expiresNever')
  })

  test('UA12.66 control: a known unlimited page (no marker) still reads "never"', () => {
    const html = render(request(card({ mode: 'update', url: 'https://t-artifacts.t-tech.team/a/abcdefghijklmnopqrstuv', retentionDays: undefined, expiresAt: null })))
    expect(html).toContain('chat.artifactPublish.expiresNever')
  })

  test('a card WITHOUT the payload is the ordinary card (control)', () => {
    const html = render({
      sessionId: 'session-a',
      requestId: 'archive-1',
      toolName: 'archive_session',
      description: 'Archive the session',
      origin: 'host_gate',
      noAlwaysAllow: true,
    })
    expect(html).not.toContain('artifact-publish-details')
    expect(html).not.toContain('chat.artifactPublish.publish')
  })
})

describe('UA12.27 — the owner line names the last known dp login', () => {
  beforeAll(() => {
    // The bundle above is empty on purpose (the key-contract convention); these two keys carry the SHIPPED en
    // values (read from en.json), so a revert of the "last known as" copy turns the named arm red.
    testI18n.addResourceBundle('en', 'translation', {
      'chat.artifactPublish.ownerNamed': (enMessages as Record<string, string>)['chat.artifactPublish.ownerNamed'],
      'chat.artifactPublish.owner': (enMessages as Record<string, string>)['chat.artifactPublish.owner'],
    })
  })

  test('a card carrying the login names it; a card without it keeps the generic line', () => {
    const named = render(request(card({ ownerLogin: 'ivanov.iv' })))
    expect(named).toContain('Owner: the dp account you are signed in with (last known as ivanov.iv)')
    expect(named).not.toMatch(/chat\.artifactPublish\.owner(?!Named)/)

    const generic = render(request(card()))
    expect(generic).toContain('Owner: the dp account you are signed in with')
    expect(generic).not.toContain('ivanov.iv')
    expect(generic).not.toContain('ownerNamed')
  })

  test('the shipped ru copy names the login as the last known one too', () => {
    const ru = (ruMessages as Record<string, string>)['chat.artifactPublish.ownerNamed']
    expect(ru).toContain('(последний известный логин — {{login}})')
    expect((ruMessages as Record<string, string>)['chat.artifactPublish.owner']).not.toContain('{{login}}')
  })
})
