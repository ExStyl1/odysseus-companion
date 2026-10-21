/**
 * UA6.7 — the Share dialog's decisions (`share-page-state.ts`): what is published comes from `LoadedPage.publication`
 * (the artifact registry), never `config.share`; a script approval blocks publishing (even a stale one); a usable
 * source approval needs the view-only acknowledgment; drift is the page's HTML digest against the one published.
 */
import { describe, expect, it } from 'bun:test'
import type { LoadedPage, PageActionGrant, PagePublication } from '@nessy-agent/shared/pages'
import { secretKeysPreview, sharePageState, sharePublishBlocked } from '../share-page-state'

const DIGEST = 'a'.repeat(64)
const NOW = 1_800_000_000_000

function page(publication?: PagePublication, kind: 'static' | 'live' = 'live'): LoadedPage {
  return {
    config: { schemaVersion: 1, id: 'page_1', slug: 'board', name: 'Board', kind, createdAt: 1, updatedAt: 1, contentDigest: DIGEST } as LoadedPage['config'],
    folderPath: '/ws/pages/board',
    contentPath: '/ws/pages/board/index.html',
    dataPath: '/ws/pages/board/data',
    snapshotPath: '/ws/pages/board/data/snapshot.json',
    workspaceRootPath: '/ws',
    workspaceId: 'ws',
    ...(publication ? { publication } : {}),
  }
}

function publication(extra: Partial<PagePublication> = {}): PagePublication {
  return {
    artifactId: 'id', url: 'https://t-artifacts.t-tech.team/a/id', expiresAt: null, publishedAt: '2026-10-02', updatedAt: '2026-10-02',
    contentDigest: 'b'.repeat(64), pageContentDigest: DIGEST, includesData: false, ...extra,
  }
}

function grant(kind: 'api' | 'script', usable: boolean): PageActionGrant {
  const action = kind === 'script' ? { kind: 'script', script: 'scripts/x.ts' } : { kind: 'api', sourceSlug: 's', method: 'GET', pathPattern: '/x' }
  return { id: `g-${kind}`, action, contentDigest: usable ? DIGEST : 'stale', expiresAt: NOW + 60_000 } as unknown as PageActionGrant
}

describe('UA6.7 — share dialog state', () => {
  it('a page with a live publication is published and up to date; a changed page has drifted', () => {
    const state = sharePageState(page(publication()), [], false, NOW)
    expect(state).toMatchObject({ published: true, deletionPending: false, contentDrifted: false })
    expect(sharePageState(page(publication({ pageContentDigest: 'c'.repeat(64) })), [], false, NOW).contentDrifted).toBe(true)
  })

  it('NEGATIVE: no publication is private; a publication owed a deletion is not "published" and never drifts', () => {
    expect(sharePageState(page(), [], false, NOW)).toMatchObject({ published: false, deletionPending: false, contentDrifted: false })
    const pending = sharePageState(page(publication({ pendingDelete: true, pageContentDigest: 'c'.repeat(64) })), [], false, NOW)
    expect(pending).toMatchObject({ published: false, deletionPending: true, contentDrifted: false })
    expect(sharePublishBlocked(pending, false)).toBe(false)
  })

  it('a script approval blocks publishing even when stale and even with the acknowledgment', () => {
    const state = sharePageState(page(), [grant('script', false)], false, NOW)
    expect(state.scriptGrants).toHaveLength(1)
    expect(sharePublishBlocked(state, true)).toBe(true)
  })

  it('a usable source approval needs the acknowledgment; a stale one does not', () => {
    const usable = sharePageState(page(), [grant('api', true)], false, NOW)
    expect(usable.needsViewOnlyAck).toBe(true)
    expect(sharePublishBlocked(usable, false)).toBe(true)
    expect(sharePublishBlocked(usable, true)).toBe(false)
    expect(sharePageState(page(), [grant('api', false)], false, NOW).needsViewOnlyAck).toBe(false)
  })

  it('the data toggle needs a snapshot and a page that runs scripts', () => {
    expect(sharePageState(page(), [], true, NOW).offerIncludeData).toBe(true)
    expect(sharePageState(page(), [], false, NOW).offerIncludeData).toBe(false)
    expect(sharePageState(page(undefined, 'static'), [], true, NOW).offerIncludeData).toBe(false)
  })

  it('the secret-key preview shows three paths and counts the rest', () => {
    expect(secretKeysPreview(['kv.a', 'kv.b'])).toBe('kv.a, kv.b')
    expect(secretKeysPreview(['kv.a', 'kv.b', 'kv.c', 'kv.d', 'kv.e'])).toBe('kv.a, kv.b, kv.c +2')
  })
})
