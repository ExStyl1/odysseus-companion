/**
 * UA6.2 — copied from craft-agents-oss `v0.13.4:packages/server-core/src/pages/tool-callbacks.test.ts` (Apache-2.0),
 * adapted: `NESSY_IS_PACKAGED` (written delete-then-assign, the Bun 1.3.14 `process.env` rule in AGENTS.md), the
 * `nessy-pages-tools-` temp prefix, the required `confirmDelete` port, and the NESSY arms at the end (a declined
 * delete removes nothing; UA6.7's share state is the registry's live page row; UA8.2's refresh is written by the host from content; UA9.3's
 * `get_page` grants are the host-approvals ledger's, stale once the content moves).
 *
 * Module-graph budget (AGENTS.md trap "a timeout with zero assertion failures is usually the MODULE GRAPH"):
 * `tool-callbacks.ts` loads `@nessy-agent/shared/pages` with a dynamic `import()` on its first call, and that cold
 * load measured 6–11 s on a loaded tree (2026-10-02, `bun -e` real 29.7 s / user 0.72 s) — inside the first test's
 * 5 s budget it timed out and leaked its create into the next test. The static value import below makes COLLECTION
 * pay that load (collection has no per-test timeout); every test body then finds the module cached.
 */
import * as sharedPagesWarmup from '@nessy-agent/shared/pages'
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPagesToolCallbacks, pageDeleteUnattendedRefusal, type PageDeleteSubject } from './tool-callbacks'
import { artifactUnattendedRefusal, UNATTENDED_WHY, type ArtifactUnattendedReason } from '../sessions/artifact-publishing'
import { setHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
import { markArtifactPendingDelete, recordArtifactPublish } from '@nessy-agent/shared/artifacts/registry'

// Pin dev-mode runtime resolution: write_page_data spawns the real Bun runtime
// via resolveScriptRuntime; under a packaged Nessy host (agent Bash
// sessions inherit NESSY_IS_PACKAGED=true) it would flip into packaged-mode
// hardening and block the PATH fallback this suite relies on.
const SAVED_IS_PACKAGED = process.env.NESSY_IS_PACKAGED
beforeAll(() => {
  delete process.env.NESSY_IS_PACKAGED
  process.env.NESSY_IS_PACKAGED = 'false'
})
afterAll(() => {
  delete process.env.NESSY_IS_PACKAGED
  if (SAVED_IS_PACKAGED !== undefined) process.env.NESSY_IS_PACKAGED = SAVED_IS_PACKAGED
})

describe('pages tool callbacks (end-to-end against a temp workspace)', () => {
  let workspace: string
  const mutations: string[] = []
  const asked: PageDeleteSubject[] = []
  let callbacks: ReturnType<typeof buildPagesToolCallbacks>

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nessy-pages-tools-'))
    callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      onPagesMutated: (slug) => { mutations.push(slug) },
      confirmDelete: async (page) => { asked.push(page); return { allowed: true } },
    })
  })
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('create → list → get round-trips through real storage', async () => {
    // Boundary arm of the warm-up: the module the callbacks import() is already loaded at collection.
    expect(typeof sharedPagesWarmup.createPage).toBe('function')
    const created = await callbacks.createPage({
      name: 'Build Health',
      kind: 'live',
      description: 'CI dashboard',
      content: '<!doctype html><html><body>hi</body></html>',
    })
    expect(created.slug).toBe('build-health')
    expect(created.hasContent).toBe(true)
    expect(created.contentDigest).toBeDefined()
    expect(created.data).toBeNull()
    expect(mutations).toEqual(['build-health'])

    const listed = await callbacks.listPages()
    expect(listed.map(p => p.slug)).toEqual(['build-health'])

    const details = await callbacks.getPage('build-health', { includeContent: true })
    expect(details?.content).toContain('hi')
    expect(details?.contentPath.endsWith('index.html')).toBe(true)

    expect(await callbacks.getPage('missing')).toBeNull()
  })

  it('rejects path-traversal slugs at the tool boundary without escaping the workspace', async () => {
    const keep = await callbacks.createPage({ name: 'Keep Safe', content: '<p>x</p>' })

    // Reads: an unsafe slug is simply "not found" — never a traversal read.
    expect(await callbacks.getPage('..')).toBeNull()
    expect(await callbacks.getPage('../../etc')).toBeNull()

    // Mutations: rejected as "Page not found" via the loadPage/loadPageConfig
    // guards, never reaching a filesystem path built from the bad slug.
    await expect(callbacks.writePageData('..', { set: { a: 1 } })).rejects.toThrow('Page not found')
    await expect(callbacks.updatePage('../x', { name: 'x' })).rejects.toThrow('Page not found')
    await expect(callbacks.deletePage('../..')).rejects.toThrow('Page not found')

    // The real page and the workspace survive the rejected traversal attempts.
    expect(existsSync(workspace)).toBe(true)
    expect(await callbacks.getPage(keep.slug)).not.toBeNull()
  })

  it('update patches metadata, clears via null, and replaces content', async () => {
    const updated = await callbacks.updatePage('build-health', {
      name: 'Build Health v2',
      description: null,
      content: '<!doctype html><html><body>v2</body></html>',
    })
    expect(updated.name).toBe('Build Health v2')
    expect(updated.description).toBeUndefined()
    expect(updated.contentLength).toBeGreaterThan(0)

    await expect(callbacks.updatePage('missing', { name: 'x' })).rejects.toThrow('Page not found')
    await expect(callbacks.updatePage('build-health', { kind: 'wild' })).rejects.toThrow('Invalid page kind')
  })

  it('writePageData spawns the writer, exports the snapshot, and stamps page.json', async () => {
    const summary = await callbacks.writePageData('build-health', {
      set: { total: 42 },
      appendSeries: { latency: [{ t: 1000, v: 1 }, { t: 2000, v: 2 }] },
    })
    expect(summary.kvCount).toBe(1)
    expect(summary.seriesCount).toBe(1)
    expect(existsSync(summary.snapshotPath)).toBe(true)

    const details = await callbacks.getPage('build-health')
    expect(details?.lastRefresh?.ok).toBe(true)
    expect(details?.data?.kvKeys).toEqual(['total'])
    expect(details?.data?.series).toEqual([{ name: 'latency', points: 2, latest: { t: 2000, v: 2 } }])

    const snapshot = JSON.parse(readFileSync(summary.snapshotPath, 'utf-8'))
    expect(snapshot.kv.total).toBe(42)
  })

  it('delete asks the host once, removes the folder and reports the unpublish outcome', async () => {
    const result = await callbacks.deletePage('build-health')
    expect(result).toEqual({ deleted: true, publicCopyMayRemain: false })
    expect(asked).toEqual([{ slug: 'build-health', name: 'Build Health v2' }])
    expect(await callbacks.getPage('build-health')).toBeNull()
    expect(existsSync(join(workspace, 'pages', 'build-health'))).toBe(false)

    await expect(callbacks.deletePage('build-health')).rejects.toThrow('Page not found')
    // A missing page is never presented to the host as a decision.
    expect(asked).toHaveLength(1)
  })
})

describe('NESSY: the host decides every delete', () => {
  let workspace: string
  beforeAll(() => { workspace = mkdtempSync(join(tmpdir(), 'nessy-pages-tools-deny-')) })
  afterAll(() => { rmSync(workspace, { recursive: true, force: true }) })

  it('a declined delete throws the refusal sentence and removes nothing (folder, content, mutation notice)', async () => {
    const mutations: string[] = []
    const callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      onPagesMutated: (slug) => { mutations.push(slug) },
      confirmDelete: async () => ({ allowed: false, refusal: 'Deleting the page "Keep" (keep) was declined; the page is unchanged.' }),
    })
    const page = await callbacks.createPage({ name: 'Keep', content: '<p>stay</p>' })
    mutations.length = 0
    await expect(callbacks.deletePage(page.slug)).rejects.toThrow('was declined; the page is unchanged.')
    expect(existsSync(join(workspace, 'pages', page.slug, 'index.html'))).toBe(true)
    expect(existsSync(join(workspace, 'pages', page.slug, 'page.json'))).toBe(true)
    expect(mutations).toEqual([])
  })

  it('the unattended refusal names the page and the reason, and promises nothing was deleted', () => {
    const sentence = pageDeleteUnattendedRefusal('no-interactive-client', { slug: 'keep', name: 'Keep' })
    expect(sentence).toContain('"Keep" (keep) was not deleted')
    expect(sentence).toContain('no Nessy window is open')
  })

  it('UA6.7: share state (v0.13.4 L70 + L130) is the registry\'s live page row — shared + shareUrl; a page never published is shared:false with no shareUrl', async () => {
    const callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      confirmDelete: async () => ({ allowed: true }),
    })
    const page = await callbacks.createPage({ name: 'Plain', content: '<p>x</p>' })
    const details = await callbacks.getPage(page.slug)
    expect(details).not.toBeNull()
    expect(details!.shared).toBe(false)
    for (const key of ['shareUrl', 'refresh']) expect(Object.keys(details!)).not.toContain(key)
    const listed = (await callbacks.listPages()).find(entry => entry.slug === page.slug)!
    expect(listed.shared).toBe(false)
    expect(Object.keys(listed)).not.toContain('shareUrl')
    expect(details!.grants).toEqual([])

    // Published from the Share button: the 'page' row in the artifact registry (never page.json).
    const url = 'https://t-artifacts.example.invalid/a/plain-1'
    recordArtifactPublish(workspace, {
      record: { id: 'plain-1', url, title: 'Plain', expiresAt: null, retentionDays: 0 },
      sourceSessionId: '',
      sourcePath: `pages/${page.slug}`,
      contentDigest: 'a'.repeat(64),
      kind: 'page',
      page: { id: page.id, slug: page.slug, includesData: false },
    })
    const published = await callbacks.getPage(page.slug)
    expect([published!.shared, published!.shareUrl]).toEqual([true, url])
    expect((await callbacks.listPages()).find(entry => entry.slug === page.slug)!.shared).toBe(true)
  })

  it('UA6.7 (boundary): a row whose unpublish is pending, or that expired, is not shared and names no shareUrl', async () => {
    const callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      confirmDelete: async () => ({ allowed: true }),
    })
    const pending = await callbacks.createPage({ name: 'Pending', content: '<p>p</p>' })
    const expired = await callbacks.createPage({ name: 'Expired', content: '<p>e</p>' })
    const row = (id: string, p: { id: string; slug: string }, expiresAt: string | null) => recordArtifactPublish(workspace, {
      record: { id, url: `https://t-artifacts.example.invalid/a/${id}`, title: id, expiresAt, retentionDays: expiresAt ? 7 : 0 },
      sourceSessionId: '',
      sourcePath: `pages/${p.slug}`,
      contentDigest: 'b'.repeat(64),
      kind: 'page',
      page: { id: p.id, slug: p.slug, includesData: false },
    })
    row('pending-1', pending, null)
    markArtifactPendingDelete(workspace, 'pending-1', 'network')
    row('expired-1', expired, '2020-01-01T00:00:00.000Z')
    for (const slug of [pending.slug, expired.slug]) {
      const details = await callbacks.getPage(slug)
      expect([slug, details!.shared, Object.keys(details!).includes('shareUrl')]).toEqual([slug, false, false])
      expect([slug, (await callbacks.listPages()).find(entry => entry.slug === slug)!.shared]).toEqual([slug, false])
    }
  })

  it('UA8.2: a refresh is written by the host from content and echoed; an invalid one fails the create before the page exists', async () => {
    const callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      confirmDelete: async () => ({ allowed: true }),
    })
    const page = await callbacks.createPage({ name: 'Refreshed', refresh: { cron: '*/15 * * * *', scriptContent: 'console.log(1)' } })
    expect(page.refresh).toEqual({ cron: '*/15 * * * *', script: `pages/${page.slug}/refresh.ts` })
    expect(readFileSync(join(workspace, 'pages', page.slug, 'refresh.ts'), 'utf-8')).toBe('console.log(1)')

    const before = (await callbacks.listPages()).length
    await expect(callbacks.createPage({ name: 'Bad Refresh', refresh: { cron: '* * * * *', scriptContent: 'x' } })).rejects.toThrow('minimum refresh interval')
    await expect(callbacks.createPage({ name: 'Path Refresh', refresh: { cron: '*/15 * * * *', script: 'x.ts' } as never })).rejects.toThrow('Invalid refresh')
    expect((await callbacks.listPages()).length).toBe(before)

    const cleared = await callbacks.updatePage(page.slug, { refresh: null })
    expect(cleared.refresh).toBeUndefined()
  })
})

describe('UA7.4: a content change asks the host for a poster', () => {
  let workspace: string
  beforeAll(() => { workspace = mkdtempSync(join(tmpdir(), 'nessy-pages-tools-poster-')) })
  afterAll(() => { rmSync(workspace, { recursive: true, force: true }) })

  it('fires on create-with-content and update-with-content, never on a metadata-only create or update', async () => {
    const changed: string[] = []
    const callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      onContentChanged: (slug) => { changed.push(slug) },
      confirmDelete: async () => ({ allowed: true }),
    })
    await callbacks.createPage({ name: 'Blank' })
    await callbacks.updatePage('blank', { name: 'Blank v2' })
    expect(changed).toEqual([])
    await callbacks.createPage({ name: 'Drawn', content: '<p>v1</p>' })
    await callbacks.updatePage('blank', { content: '<p>now drawn</p>' })
    expect(changed).toEqual(['drawn', 'blank'])
  })
})

describe('UA9.3: get_page lists the ledger\'s grants, stale once the content moves', () => {
  let workspace: string
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nessy-pages-tools-grants-'))
    setHostApprovalsKeyProvider({ getKey: async () => Buffer.alloc(32, 3) })
  })
  afterAll(() => {
    setHostApprovalsKeyProvider(undefined)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('an issued grant lists stale:false; after update_page changes the content it lists stale:true; no grant lists []', async () => {
    const callbacks = buildPagesToolCallbacks({
      workspaceId: 'test-ws',
      workspaceRootPath: workspace,
      confirmDelete: async () => ({ allowed: true }),
    })
    const page = await callbacks.createPage({ name: 'Granted', content: '<p>v1</p>' })
    expect((await callbacks.getPage(page.slug))!.grants).toEqual([])

    sharedPagesWarmup.issuePageGrant(workspace, Buffer.alloc(32, 3), page.slug, {
      id: 'grant_tool',
      description: 'List issues',
      action: { kind: 'mcp', sourceSlug: 'linear', toolName: 'list_issues' },
      contentDigest: page.contentDigest!,
    })
    const fresh = (await callbacks.getPage(page.slug))!.grants
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ id: 'grant_tool', kind: 'mcp', sourceSlug: 'linear', description: 'List issues', stale: false })

    await callbacks.updatePage(page.slug, { content: '<p>v2</p>' })
    expect((await callbacks.getPage(page.slug))!.grants.map(grant => grant.stale)).toEqual([true])
    // page.json never carries the grant.
    expect(JSON.parse(readFileSync(join(workspace, 'pages', page.slug, 'page.json'), 'utf-8')).grants).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// UA12.61 — ONE unattended-reason phrase map: the delete_page refusal reads
// the same exported UNATTENDED_WHY the publish_artifact refusal does, so the
// two sentences cannot drift.
// ---------------------------------------------------------------------------

describe('UA12.61 — the unattended-reason phrases are one map', () => {
  const reasons = Object.keys(UNATTENDED_WHY) as ArtifactUnattendedReason[]

  it('every ArtifactUnattendedReason yields the SAME clause in both refusals', () => {
    // The row's control: for each reason the publish and the delete sentence
    // embed the identical clause — both read the one exported map.
    expect(reasons.length).toBeGreaterThanOrEqual(7)
    for (const reason of reasons) {
      const clause = UNATTENDED_WHY[reason]
      expect(clause.length).toBeGreaterThan(0)
      expect(artifactUnattendedRefusal(reason)).toContain(clause)
      expect(pageDeleteUnattendedRefusal(reason, { slug: 'keep', name: 'Keep' })).toContain(clause)
    }
  })

  it('the map carries EXACTLY the union — nothing phrase-less slips in at runtime', () => {
    // The strong half is the type itself (`Readonly<Record<ArtifactUnattendedReason,
    // string>>`: a reason added without a phrase fails tsc — measured by mutation);
    // this census is the runtime net and keeps the iteration above exhaustive.
    expect(reasons.slice().sort()).toEqual([
      'automation',
      'dont-ask',
      'goal-continuation',
      'no-interactive-client',
      'schedule',
      'subagent',
      'workflow-child',
    ])
  })

  it('tool-callbacks imports the shared map and declares no local copy', () => {
    // Source shape: the drift this row closes was a second `const UNATTENDED_WHY`
    // living here; the pin fails the moment one reappears.
    const source = readFileSync(join(import.meta.dir, 'tool-callbacks.ts'), 'utf-8')
    expect(source).toContain(
      "import { UNATTENDED_WHY, type ArtifactUnattendedReason } from '../sessions/artifact-publishing.ts'",
    )
    expect(source).not.toContain('const UNATTENDED_WHY')
  })
})
