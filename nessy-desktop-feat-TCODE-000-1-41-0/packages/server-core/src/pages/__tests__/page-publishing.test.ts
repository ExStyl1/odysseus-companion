/**
 * UA6.7 — publishing a Page on t-artifacts through the ONE publish chain (`sessions/artifact-publishing.ts`
 * `runArtifactPublish`), driven with the REAL page bundle, the REAL guard scan, the REAL normaliser and the REAL
 * registry over a temporary workspace; only the service client is a fake that records every request (nothing leaves
 * the machine). Plan UA6.7 Tests: a page with a script grant is refused; the scan runs over both the HTML and the
 * snapshot; unpublish sends one DELETE.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArtifactRecord, PublishRequest, TArtifactsClient } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { ArtifactClientError } from '@nessy-agent/shared/artifacts/t-artifacts-client'
import { readArtifactRegistry, recordArtifactPublish } from '@nessy-agent/shared/artifacts/registry'
import {
  createPage,
  deletePageLocal,
  ensurePageDataDir,
  getPageSnapshotPath,
  loadPage,
  loadWorkspacePages,
  pageExists,
  savePageContent,
  type PageShareGrantView,
} from '@nessy-agent/shared/pages'
import {
  pagePublicationSourcePath,
  publishPage,
  reviewPagePublish,
  unpublishBeforeDelete,
  unpublishPage,
  type PagePublishingDeps,
} from '../page-publishing.ts'
import { runArtifactPublish, type ArtifactAuditRecord } from '../../sessions/artifact-publishing.ts'

const ID = 'pageartifactid0123456789'
const URL_ = `https://t-artifacts.t-tech.team/a/${ID}`
const HTML = '<!doctype html><html><head><title>Board</title></head><body><div id="v"></div><script>draw()</script></body></html>'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ua67-publish-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

type Sent =
  | { method: 'create' | 'update'; id?: string; request: PublishRequest }
  | { method: 'delete'; id: string }

function fakeClient(sent: Sent[], failDelete?: ArtifactClientError): TArtifactsClient {
  const record = (request: PublishRequest): ArtifactRecord => ({
    id: ID,
    url: URL_,
    title: request.title,
    // Far future: the loaders and unpublish join the registry with the REAL clock (only the publish chain takes
    // deps.now), so a wall-date here expires as the calendar rolls over — measured 2026-10-10.
    expiresAt: '2099-01-01T00:00:00.000Z',
    retentionDays: request.retentionDays ?? 7,
  })
  return {
    createArtifact: async request => { sent.push({ method: 'create', request }); return record(request) },
    updateArtifact: async (target, request) => {
      sent.push({ method: 'update', id: 'id' in target ? target.id : undefined, request })
      return record(request)
    },
    deleteArtifact: async target => {
      sent.push({ method: 'delete', id: 'id' in target ? target.id : '' })
      if (failDelete) throw failDelete
    },
    listOwnedArtifacts: async () => { throw new Error('not used') },
    patchArtifact: async () => { throw new Error('not used') },
  }
}

function deps(sent: Sent[], options: { grants?: readonly PageShareGrantView[] | null; failDelete?: ArtifactClientError } = {}) {
  const audits: ArtifactAuditRecord[] = []
  const value: PagePublishingDeps = {
    workspaceRoot: root,
    createClient: () => fakeClient(sent, options.failDelete),
    readGrants: async () => (options.grants === undefined ? [] : options.grants),
    audit: record => { audits.push(record) },
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  }
  return { deps: value, audits }
}

function makePage(content = HTML): string {
  return createPage(root, { name: 'Board', description: 'Team board', kind: 'live', content }).slug
}

function writeSnapshot(slug: string, value: unknown): void {
  ensurePageDataDir(root, slug)
  writeFileSync(getPageSnapshotPath(root, slug), typeof value === 'string' ? value : JSON.stringify(value))
}

/** A JWT-shaped FAKE, assembled at runtime so this file never matches the scan itself. */
const FAKE_JWT = ['ey' + 'J' + 'a'.repeat(14), 'b'.repeat(14), 'c'.repeat(14)].join('.')

async function reviewed(d: PagePublishingDeps, slug: string, includeData = false): Promise<string> {
  const review = await reviewPagePublish(d, slug, { includeData })
  if (!review.review.ok) throw new Error(`review refused: ${review.review.message}`)
  return review.review.card.sha256
}

describe('publish (positive)', () => {
  test('the review sends nothing and audits nothing; the publish of the reviewed card sends exactly one POST of the card\'s bytes', async () => {
    const slug = makePage()
    writeSnapshot(slug, { version: 1, generatedAt: 1, kv: { total: 3 }, series: {} })
    const sent: Sent[] = []
    const { deps: d, audits } = deps(sent)
    const review = await reviewPagePublish(d, slug, { includeData: true })
    expect(sent).toHaveLength(0)
    expect(audits).toHaveLength(0)
    expect(review.review.ok).toBe(true)
    if (!review.review.ok) return
    expect(review.review.mode).toBe('create')
    expect(review.review.card.sourcePath).toBe(pagePublicationSourcePath(slug))
    expect(review.review.card.previewContent).toContain('nessy-page-snapshot')

    const result = await publishPage(d, slug, { includeData: true, reviewedSha256: review.review.card.sha256 })
    expect(result.status).toBe('published')
    expect(result.url).toBe(URL_)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('create')
    expect((sent[0] as { request: PublishRequest }).request.content).toBe(review.review.card.previewContent)
    expect(audits.map(record => record.decision)).toEqual(['approved'])

    // The registry holds the page row; the loaders join it — page.json does not carry it.
    const [row] = readArtifactRegistry(root)
    expect(row).toMatchObject({ kind: 'page', sourceSessionId: '', sourcePath: `pages/${slug}` })
    expect(row!.page).toMatchObject({ slug, includesData: true })
    const publication = loadPage(root, slug)!.publication!
    expect(publication).toMatchObject({ artifactId: ID, url: URL_, includesData: true })
    expect(loadWorkspacePages(root)[0]!.publication?.url).toBe(URL_)
  })

  test('a republish is one PUT to the same id, and the link is unchanged', async () => {
    const slug = makePage()
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    await publishPage(d, slug, { includeData: false, reviewedSha256: await reviewed(d, slug) })
    savePageContent(root, slug, HTML.replace('Board', 'Board v2'))
    const review = await reviewPagePublish(d, slug, { includeData: false })
    expect(review.review.ok && review.review.mode).toBe('update')
    const result = await publishPage(d, slug, { includeData: false, reviewedSha256: await reviewed(d, slug) })
    expect(result.status).toBe('updated')
    expect(result.url).toBe(URL_)
    expect(sent.map(entry => entry.method)).toEqual(['create', 'update'])
    expect((sent[1] as { id?: string }).id).toBe(ID)
    expect(readArtifactRegistry(root)).toHaveLength(1)
  })
})

describe('publish (negative)', () => {
  test('a page with a script grant is refused before any card, with zero requests', async () => {
    const slug = makePage()
    const sent: Sent[] = []
    const { deps: d, audits } = deps(sent, { grants: [{ action: { kind: 'script' }, contentDigest: 'any', expiresAt: 0 }] })
    const review = await reviewPagePublish(d, slug, { includeData: false })
    expect(review.review).toMatchObject({ ok: false, code: 'PAGE_SHARE_SCRIPT_GRANT' })
    const result = await publishPage(d, slug, { includeData: false, reviewedSha256: 'a'.repeat(64) })
    expect(result).toMatchObject({ status: 'refused', code: 'PAGE_SHARE_SCRIPT_GRANT' })
    expect(sent).toHaveLength(0)
    expect(audits.map(record => record.rule)).toEqual(['PAGE_SHARE_SCRIPT_GRANT'])
  })

  test('the scan runs over both the HTML and the snapshot: each refusal names its part, never the value', async () => {
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    const inData = makePage()
    writeSnapshot(inData, { version: 1, generatedAt: 1, kv: { header: FAKE_JWT }, series: {} })
    const dataReview = await reviewPagePublish(d, inData, { includeData: true })
    expect(dataReview.review.ok).toBe(false)
    if (dataReview.review.ok) return
    expect(dataReview.review.code).toBe('PAGE_SHARE_SECRET')
    expect(dataReview.review.message).toContain('data snapshot')
    expect(dataReview.review.message).not.toContain(FAKE_JWT)
    // Without the data, the same page passes: the snapshot was the finding.
    expect((await reviewPagePublish(d, inData, { includeData: false })).review.ok).toBe(true)

    const inHtml = createPage(root, { name: 'Leaky', kind: 'live', content: `<p>${FAKE_JWT}</p>` }).slug
    const htmlReview = await reviewPagePublish(d, inHtml, { includeData: false })
    expect(htmlReview.review.ok).toBe(false)
    if (htmlReview.review.ok) return
    expect(htmlReview.review.message).toContain('HTML')
    // UA12.118 control — a finding in a part the person EDITS (the HTML) keeps the direct instruction.
    expect(htmlReview.review.message).toContain('Remove it or replace it with a placeholder')
    expect(sent).toHaveLength(0)
  })

  test('the scan covers the snapshot AS INLINED: a \\u-escaped token the raw text hides is refused, never sent', async () => {
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    const slug = makePage()
    // The raw file spells the token's first letter as a JSON escape, so no token is contiguous in the raw text; the
    // published copy re-serialises the parsed value, which writes the token out in plain text.
    const escaped = `\\u0065${FAKE_JWT.slice(1)}`
    writeSnapshot(slug, `{"version":1,"generatedAt":1,"kv":{"header":"${escaped}"},"series":{}}`)
    const review = await reviewPagePublish(d, slug, { includeData: true })
    expect(review.review.ok).toBe(false)
    if (review.review.ok) return
    expect(review.review.code).toBe('PAGE_SHARE_SECRET')
    expect(review.review.message).toContain('The copy built from this page')
    expect(review.review.message).not.toContain(FAKE_JWT)
    // UA12.118 — the copy is BUILT from the page, so the refusal sends the fix to the page's content or data;
    // it does not tell the person to edit the copy (and a refusal produces no card, so nothing is previewed).
    // Follow-up: it names no line of a copy the person never sees, and never calls the unsent copy "published".
    expect(review.review.message).toContain('Remove the value from the page\'s content or its data')
    expect(review.review.message).not.toMatch(/line \d+/)
    expect(review.review.message).not.toContain('published copy')
    expect(review.review.message).not.toContain('Remove it or replace it with a placeholder')
    expect(sent).toHaveLength(0)
    // Boundary: the same escape spelling a harmless word passes, so the refusal above is the token, not the escape.
    writeSnapshot(slug, '{"version":1,"generatedAt":1,"kv":{"header":"\\u0065ast"},"series":{}}')
    expect((await reviewPagePublish(d, slug, { includeData: true })).review.ok).toBe(true)
  })

  test('a page changed after its review is not sent; neither is an unreviewed publish', async () => {
    const slug = makePage()
    const sent: Sent[] = []
    const { deps: d, audits } = deps(sent)
    const sha = await reviewed(d, slug)
    savePageContent(root, slug, HTML.replace('draw()', 'draw(2)'))
    const result = await publishPage(d, slug, { includeData: false, reviewedSha256: sha })
    expect(result.status).toBe('denied')
    expect(result.note).toContain('changed after you reviewed it')
    expect(await publishPage(d, slug, { includeData: false, reviewedSha256: 'not-a-digest' })).toMatchObject({ status: 'refused' })
    expect(sent).toHaveLength(0)
    expect(audits.map(record => record.decision)).toEqual(['denied'])
  })

  test('publish_artifact (a session) cannot name a page\'s row as its update target', async () => {
    const slug = makePage()
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    await publishPage(d, slug, { includeData: false, reviewedSha256: await reviewed(d, slug) })
    writeFileSync(join(root, 'other.html'), '<p>other</p>')
    const verdict = await runArtifactPublish({
      workspaceRoot: root,
      sessionId: 'a-session',
      runtime: 'pi',
      permissionMode: 'default',
      sessionCwd: root,
      addedRoots: [],
      unattendedReason: () => null,
      cardPending: () => false,
      raiseCard: async () => ({ allowed: true }),
      createClient: () => fakeClient(sent),
      audit: () => {},
    }, { filePath: 'other.html', url: URL_ })
    expect(verdict.status).toBe('refused')
    expect(sent.map(entry => entry.method)).toEqual(['create'])
  })
})

describe('unpublish', () => {
  test('one DELETE; the row leaves the registry and the page is private again', async () => {
    const slug = makePage()
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    await publishPage(d, slug, { includeData: false, reviewedSha256: await reviewed(d, slug) })
    sent.length = 0
    expect(await unpublishPage(d, slug)).toEqual({ outcome: 'deleted' })
    expect(sent).toEqual([{ method: 'delete', id: ID }])
    expect(readArtifactRegistry(root)).toHaveLength(0)
    expect(loadPage(root, slug)!.publication).toBeUndefined()
    // Nothing to take down → nothing sent.
    expect(await unpublishPage(d, slug)).toEqual({ outcome: 'not-published' })
    expect(sent).toHaveLength(1)
  })

  test('a failed DELETE is kept as a pending deletion, never dropped; the page shows it', async () => {
    const slug = makePage()
    const sent: Sent[] = []
    const { deps: published } = deps(sent)
    await publishPage(published, slug, { includeData: false, reviewedSha256: await reviewed(published, slug) })
    const { deps: offline } = deps(sent, { failDelete: new ArtifactClientError('network', 'The artifact service could not be reached.') })
    expect((await unpublishPage(offline, slug)).outcome).toBe('pending')
    expect(sent.filter(entry => entry.method === 'delete')).toHaveLength(1)
    expect(loadPage(root, slug)!.publication).toMatchObject({ artifactId: ID, pendingDelete: true })
  })

  test('deleting a published page takes the copy down first (one DELETE); without the port it says the copy may remain', async () => {
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    const first = makePage()
    await publishPage(d, first, { includeData: false, reviewedSha256: await reviewed(d, first) })
    sent.length = 0
    const outcome = await deletePageLocal(root, 'ws', first, { unpublish: unpublishBeforeDelete(d) })
    expect(outcome.publicCopyMayRemain).toBe(false)
    expect(sent).toEqual([{ method: 'delete', id: ID }])
    expect(pageExists(root, first)).toBe(false)

    const second = makePage()
    await publishPage(d, second, { includeData: false, reviewedSha256: await reviewed(d, second) })
    sent.length = 0
    const unported = await deletePageLocal(root, 'ws', second)
    expect(unported.publicCopyMayRemain).toBe(true)
    expect(sent).toHaveLength(0)
    expect(pageExists(root, second)).toBe(false)
  })
})

describe('an expired publication (the service answers 404 and cannot renew it)', () => {
  function recordPublication(slug: string, pageId: string, expiresAt: string): void {
    recordArtifactPublish(root, {
      record: { id: ID, url: URL_, title: 'Board', expiresAt, retentionDays: 7 },
      sourceSessionId: '',
      sourcePath: `pages/${slug}`,
      contentDigest: 'd'.repeat(64),
      kind: 'page',
      page: { id: pageId, slug, includesData: false },
    })
  }

  test('NEGATIVE: past its expiry the page reads as private, and the next publish is a NEW link (one POST, no PUT)', async () => {
    const created = createPage(root, { name: 'Board', kind: 'live', content: HTML })
    recordPublication(created.slug, created.id, '2026-10-01T00:00:00.000Z') // before the deps' now (2026-10-02)
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    expect(loadPage(root, created.slug)!.publication).toBeUndefined()
    const review = await reviewPagePublish(d, created.slug, { includeData: false })
    expect(review.review.ok && review.review.mode).toBe('create')
    await publishPage(d, created.slug, { includeData: false, reviewedSha256: await reviewed(d, created.slug) })
    expect(sent.map(entry => entry.method)).toEqual(['create'])
  })

  test('POSITIVE control: before its expiry the same row is the publication, and a publish is its PUT', async () => {
    const created = createPage(root, { name: 'Board', kind: 'live', content: HTML })
    recordPublication(created.slug, created.id, '2099-01-01T00:00:00.000Z')
    const sent: Sent[] = []
    const { deps: d } = deps(sent)
    expect(loadPage(root, created.slug)!.publication?.artifactId).toBe(ID)
    await publishPage(d, created.slug, { includeData: false, reviewedSha256: await reviewed(d, created.slug) })
    expect(sent.map(entry => entry.method)).toEqual(['update'])
  })
})
