/**
 * UA7.5 — playground entries for Pages: the library (the shipped `PagesHome`) empty and populated with the three
 * kinds, one tile (`PageTile`) per kind with its placeholder or its poster, and the delete confirmation
 * (`DeletePageDialog`). Upstream v0.13.4 ships no Pages playground entry, so this file is ours; it mounts the shipped
 * components, never a hand-drawn copy, so a sweep reads what the app draws.
 *
 * The bridge: the library and the tile call four page channels. The playground's mock bridge carries none of them,
 * so each preview overrides them for its lifetime with `overrideElectronApiMethod` (never by assignment — the mock
 * bridge's docblock says why): the poster comes from {@link playgroundPagePoster}, "Refresh preview" answers queued,
 * and New Page / Delete Page REJECT with a sentence saying the playground has no page store — the error toast is the
 * honest answer, since nothing is created or deleted. The overrides are installed ONCE per preview (an effect keyed
 * on nothing) and read the current pages through a ref: React runs every passive cleanup before the mount effects,
 * child first, so an install keyed on `[pages]` was disposed in the very commit where a poster-knob flip made the
 * tile fetch its poster — `getPageThumbnail` was missing (the base mock has none) and the playground unmounted (UA7.5
 * follow-up). On first mount the tile's poster fetch waits for `useInView` to flip, a later commit than the one whose
 * effect installs the overrides.
 *
 * Refresh (UA8.3 follow-up): the `refresh` knob gives the live page a scheduled refresh and the outcome of its last
 * run — `ok` (green dot, the run's relative time) or `failed` (red dot, "Refresh failed") — the freshness
 * `PageFreshness` reads from `lastRefresh` since UA8.3 landed. The static and interactive pages never carry one.
 *
 * Publishing (UA6.7): the `published` knob gives the live page (the library) or the tile a publication — `live`
 * (the share badge) or `pending` (a deletion still owed: no badge) — read from `LoadedPage.publication`, as the app
 * reads it from the artifact registry. The Share dialog entry (`SharePageDialog`) answers its three page channels
 * from mocks: the review is a fixed card (or a refusal, per state), and Publish / Unpublish answer with an error toast —
 * the playground has no artifact service, so nothing is ever sent.
 *
 * The page view (UB14.53): `pages-view` mounts the shipped `PageView` on the library's live page, so the v0.15.1
 * header (back and overflow `IconButton`s, the Share `Button`), the body states (the frame on its raised card, the
 * no-content screen, a refused lease with Retry, a slug no page answers) and the refresh row are a playground state
 * each. PageView reads its channels in its own MOUNT effects, and a parent's passive effect runs after its
 * children's, so this preview installs its overrides in a LAYOUT effect, which runs before every passive one (a
 * static render runs neither). A lease answers with a small HTML page; Rename, Delete, Publish and Unpublish answer
 * with an error toast — the playground has no page store and no artifact service.
 *
 * Staged copies (plan Review Focus 13): no state here leads into a withheld range. No mock page carries grants
 * (UA9.3) or a project (UA5.9); `pages-registry.test.ts` runs `page-frame-source.test.ts`'s needles over this file.
 */
import * as React from 'react'
import { Provider, createStore } from 'jotai'
import type { LoadedPage, PageKind, PageShareCard, PageShareReview } from '@nessy-agent/shared/pages/types'
import type { PageActionGrant } from '@nessy-agent/shared/pages'
import { pagesAtom } from '@/atoms/pages'
import { PagesHome } from '@/components/pages/PagesHome'
import { PageTile } from '@/components/pages/PageTile'
import { DeletePageDialog } from '@/components/pages/DeletePageDialog'
import { SharePageDialog } from '@/components/pages/SharePageDialog'
import { PageView } from '@/components/pages/PageView'
import { overrideElectronApiMethod } from '../mock-utils'
import type { ComponentEntry } from './types'

const WORKSPACE_ID = 'playground-workspace'
const WORKSPACE_ROOT = '/Users/playground/.nessy-agent/workspaces/playground-workspace'
const MINUTE = 60 * 1000

interface MockPageSeed {
  slug: string
  name: string
  description: string
  kind: PageKind
  ageMs: number
}

const LIBRARY: readonly MockPageSeed[] = [
  { slug: 'build-health', name: 'Build Health', description: 'CI duration and pass rate', kind: 'live', ageMs: 4 * MINUTE },
  { slug: 'release-checklist', name: 'Release Checklist', description: 'What is left before the cut', kind: 'interactive', ageMs: 2 * 60 * MINUTE },
  { slug: 'q3-gateway-report', name: 'Q3 Gateway Report', description: 'Requests per model alias', kind: 'static', ageMs: 3 * 24 * 60 * MINUTE },
]

function digestFor(slug: string): string {
  return `playground-digest-${slug}`.padEnd(64, '0')
}

/** The outcome of a page's last scheduled refresh run, as the executor stamps it on page.json (`lastRefresh`). */
export type MockRefreshOutcome = 'none' | 'ok' | 'failed'

function refreshFields(slug: string, refresh: MockRefreshOutcome, now: number): Partial<LoadedPage['config']> {
  if (refresh === 'none') return {}
  return {
    refresh: { cron: '*/15 * * * *', script: `pages/${slug}/refresh.ts` },
    lastRefresh: refresh === 'ok'
      ? { at: now - 3 * MINUTE, ok: true, durationMs: 1840 }
      : { at: now - 3 * MINUTE, ok: false, durationMs: 60_000, error: 'fetch https://ci.example.com/api/builds: ECONNREFUSED' },
  }
}

/** UA6.7 — a page's publication as the registry would report it: none, live (badged), or a deletion still owed. */
export type MockPublishState = 'none' | 'live' | 'pending'

function publicationFor(slug: string, state: MockPublishState, contentDigest: string, now: number): LoadedPage['publication'] {
  if (state === 'none') return undefined
  return {
    artifactId: `playground${slug.replace(/-/g, '')}`.slice(0, 24),
    url: `https://t-artifacts.t-tech.team/a/playground-${slug}`,
    expiresAt: new Date(now + 6 * 24 * 60 * MINUTE).toISOString(),
    publishedAt: new Date(now - 24 * 60 * MINUTE).toISOString(),
    updatedAt: new Date(now - 24 * 60 * MINUTE).toISOString(),
    contentDigest: digestFor(`${slug}-sent`),
    pageContentDigest: contentDigest,
    includesData: false,
    ...(state === 'pending' ? { pendingDelete: true } : {}),
  }
}

function loadedPage(
  seed: MockPageSeed,
  posters: boolean,
  now: number,
  refresh: MockRefreshOutcome = 'none',
  published: MockPublishState = 'none',
): LoadedPage {
  const folderPath = `${WORKSPACE_ROOT}/pages/${seed.slug}`
  const updatedAt = now - seed.ageMs
  const contentDigest = digestFor(seed.slug)
  return {
    config: {
      schemaVersion: 1,
      id: `page_${seed.slug.replace(/-/g, '').slice(0, 8)}`,
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      kind: seed.kind,
      createdAt: updatedAt - 60 * MINUTE,
      updatedAt,
      contentDigest,
      ...(posters ? { thumbnail: { digest: contentDigest, capturedAt: updatedAt, width: 640, height: 400 } } : {}),
      ...refreshFields(seed.slug, refresh, now),
    },
    folderPath,
    contentPath: `${folderPath}/index.html`,
    dataPath: `${folderPath}/data`,
    snapshotPath: `${folderPath}/data/snapshot.json`,
    workspaceRootPath: WORKSPACE_ROOT,
    workspaceId: WORKSPACE_ID,
    ...(published !== 'none' ? { publication: publicationFor(seed.slug, published, contentDigest, now) } : {}),
  }
}

/**
 * The populated library: one page per kind, newest first. Only `posters` gives a page a fresh thumbnail, and only
 * `refresh` gives the LIVE page a schedule and a last-run outcome.
 */
export function mockPagesLibrary(
  { posters, now = Date.now(), refresh = 'none', published = 'none' }:
  { posters: boolean; now?: number; refresh?: MockRefreshOutcome; published?: MockPublishState },
): LoadedPage[] {
  return LIBRARY.map(seed => loadedPage(
    seed, posters, now, seed.kind === 'live' ? refresh : 'none', seed.kind === 'live' ? published : 'none',
  ))
}

const POSTER_ACCENT: Record<PageKind, string> = { static: '#64748b', interactive: '#0284c7', live: '#059669' }

/** A poster as the thumbnailer would hand it back: a small picture of a page (a data: SVG, no network). */
export function playgroundPagePoster(kind: PageKind, name: string): string {
  const accent = POSTER_ACCENT[kind]
  const bars = [38, 62, 47, 80, 55, 70].map((h, i) =>
    `<rect x="${36 + i * 44}" y="${190 - h}" width="28" height="${h}" rx="3" fill="${accent}" opacity="0.8"/>`).join('')
  const label = name.replace(/[<>&"']/g, '')
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">',
    '<rect width="320" height="200" fill="#ffffff"/>',
    `<rect width="320" height="34" fill="${accent}" opacity="0.12"/>`,
    `<text x="16" y="22" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="#0f172a">${label}</text>`,
    `<text x="16" y="70" font-family="system-ui,sans-serif" font-size="30" font-weight="700" fill="${accent}">42</text>`,
    bars,
    '</svg>',
  ].join('')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * The four page channels the library and the tile call, answered from `readPages()` at CALL time (so a re-render that
 * changes the pages needs no reinstall). Returns the disposer that puts the bridge back.
 */
export function installPlaygroundPagesBridge(readPages: () => readonly LoadedPage[]): () => void {
  const disposers = [
    overrideElectronApiMethod('getPageThumbnail', async (_workspaceId: string, slug: string) => {
      const page = readPages().find(p => p.config.slug === slug)
      if (!page?.config.thumbnail) return null
      return { dataUrl: playgroundPagePoster(page.config.kind, page.config.name), digest: page.config.thumbnail.digest }
    }),
    overrideElectronApiMethod('regeneratePageThumbnail', async () => true),
    overrideElectronApiMethod('createPage', async () => {
      throw new Error('The playground has no page store: nothing was created.')
    }),
    overrideElectronApiMethod('deletePage', async () => {
      throw new Error('The playground has no page store: nothing was deleted.')
    }),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** Installed for the preview's lifetime — never re-keyed on `pages` (the file header says why). */
function usePlaygroundPagesBridge(pages: readonly LoadedPage[]) {
  const pagesRef = React.useRef(pages)
  pagesRef.current = pages
  React.useEffect(() => installPlaygroundPagesBridge(() => pagesRef.current), [])
}

type LibraryState = 'empty' | 'populated'

function PagesLibraryPreview(
  { library, posters, refresh = 'none', published = 'none' }:
  { library: LibraryState; posters: boolean; refresh?: MockRefreshOutcome; published?: MockPublishState },
) {
  const pages = React.useMemo(
    () => (library === 'populated' ? mockPagesLibrary({ posters, refresh, published }) : []),
    [library, posters, refresh, published],
  )
  const store = React.useMemo(() => {
    const s = createStore()
    s.set(pagesAtom, pages)
    return s
  }, [pages])
  usePlaygroundPagesBridge(pages)
  return (
    <Provider store={store}>
      <div className="h-full w-full">
        <PagesHome />
      </div>
    </Provider>
  )
}

function PageTilePreview(
  { kind, name, poster, refresh = 'none', published = 'none' }:
  { kind: PageKind; name: string; poster: boolean; refresh?: MockRefreshOutcome; published?: MockPublishState },
) {
  const pages = React.useMemo(() => {
    const seed: MockPageSeed = { slug: 'playground-page', name, description: '', kind, ageMs: 7 * MINUTE }
    return [loadedPage(seed, poster, Date.now(), refresh, published)]
  }, [kind, name, poster, refresh, published])
  usePlaygroundPagesBridge(pages)
  const log = (what: string) => () => console.log(`[Playground] PageTile ${what}`)
  return (
    <div className="w-[300px]">
      <PageTile page={pages[0]!} onOpen={log('open')} onDelete={log('delete')} />
    </div>
  )
}

const REFRESH_OPTIONS = [
  { label: 'No scheduled refresh', value: 'none' },
  { label: 'Last refresh ok', value: 'ok' },
  { label: 'Last refresh failed', value: 'failed' },
]

const PUBLISHED_OPTIONS = [
  { label: 'Not published', value: 'none' },
  { label: 'Published (share badge)', value: 'live' },
  { label: 'Deletion pending (no badge)', value: 'pending' },
]

/** UA6.7 — the Share dialog's states (each answers the review differently; nothing is ever sent). */
export type MockShareState = 'unpublished' | 'published' | 'drifted' | 'pending' | 'script-blocked' | 'needs-ack' | 'review-refused'

const SHARE_STATE_OPTIONS: Array<{ label: string; value: MockShareState }> = [
  { label: 'Not published — review card', value: 'unpublished' },
  { label: 'Published, up to date', value: 'published' },
  { label: 'Published, page changed since', value: 'drifted' },
  { label: 'Earlier copy\'s deletion pending', value: 'pending' },
  { label: 'Script approval blocks publishing', value: 'script-blocked' },
  { label: 'Source approval needs the view-only ack', value: 'needs-ack' },
  { label: 'Review refused (a token in the page)', value: 'review-refused' },
]

const SHARE_PREVIEW_HTML = '<h1>Build Health</h1><p>Pass rate 97% · median 6m 12s</p>'

/** The host's review card for the Share dialog's playground page (what `pages:getShareDataScan` answers). */
export function mockPageShareCard(mode: 'create' | 'update'): PageShareCard {
  return {
    mode,
    sourcePath: 'pages/build-health',
    contentType: 'html',
    title: 'Build Health',
    emoji: '\u{1F4C4}',
    byteLength: 2_418,
    lineCount: 41,
    sha256: digestFor('build-health-review'),
    serviceOrigin: 'https://t-artifacts.t-tech.team',
    expiresAt: mode === 'create' ? new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString() : new Date(Date.now() + 6 * 24 * 60 * MINUTE).toISOString(),
    ...(mode === 'create' ? { retentionDays: 7 } : { url: 'https://t-artifacts.t-tech.team/a/playground-build-health' }),
    previewContent: SHARE_PREVIEW_HTML,
    previewTruncated: false,
    sourceHead: SHARE_PREVIEW_HTML,
    scriptCount: 2,
    externalHosts: [],
    scanSentence: 'Automatic check found no known token formats; it does not detect encoded or free-form secrets or client data.',
    emailCount: 0,
    phoneCount: 0,
    ...(mode === 'update' ? { previous: { sha256: digestFor('build-health-sent'), byteLength: 2_301, lineCount: 39 } } : {}),
  }
}

/** What the playground's `pages:getShareDataScan` answers for a state (and whether the data toggle is on). */
export function mockPageShareReview(state: MockShareState, includeData: boolean): PageShareReview {
  const scan = { snapshotBytes: 1_204, secretCandidates: includeData ? ['kv.apiToken'] : [] }
  if (state === 'script-blocked') {
    return { ...scan, review: { ok: false, code: 'PAGE_SHARE_SCRIPT_GRANT', message: 'This page has permission to run a script on this computer, so it cannot be published — not even as a view-only copy.' } }
  }
  if (state === 'review-refused') {
    return { ...scan, review: { ok: false, code: 'PAGE_SHARE_SECRET', message: 'The page\'s HTML line 12 contains what looks like a jwt value, so nothing was published. Remove it or replace it with a placeholder, then publish again.' } }
  }
  return { ...scan, review: { ok: true, mode: state === 'published' || state === 'drifted' ? 'update' : 'create', card: mockPageShareCard(state === 'published' || state === 'drifted' ? 'update' : 'create') } }
}

function sharePreviewPage(state: MockShareState): LoadedPage {
  const seed = LIBRARY[0]!
  const now = Date.now()
  const published: MockPublishState = state === 'published' || state === 'drifted' ? 'live' : state === 'pending' ? 'pending' : 'none'
  const page = loadedPage(seed, false, now, 'none', published)
  if (state === 'drifted' && page.publication) page.publication = { ...page.publication, pageContentDigest: digestFor('older-build-health') }
  return page
}

function sharePreviewGrants(state: MockShareState): PageActionGrant[] {
  const expiresAt = Date.now() + 24 * 60 * MINUTE
  if (state === 'script-blocked') {
    return [{ id: 'grant_script', action: { kind: 'script', script: 'scripts/rerun-ci.ts' }, contentDigest: digestFor('build-health'), expiresAt } as unknown as PageActionGrant]
  }
  if (state === 'needs-ack') {
    return [{ id: 'grant_api', action: { kind: 'api', sourceSlug: 'ci', method: 'POST', pathPattern: '/builds/.*/rerun' }, contentDigest: digestFor('build-health'), expiresAt } as unknown as PageActionGrant]
  }
  return []
}

function PageShareDialogPreview({ state, snapshot }: { state: MockShareState; snapshot: boolean }) {
  const page = React.useMemo(() => sharePreviewPage(state), [state])
  const grants = React.useMemo(() => sharePreviewGrants(state), [state])
  const stateRef = React.useRef(state)
  stateRef.current = state
  React.useEffect(() => {
    const disposers = [
      overrideElectronApiMethod('getPageShareDataScan', async (_ws: string, _slug: string, options: { includeData: boolean }) =>
        mockPageShareReview(stateRef.current, options?.includeData === true)),
      overrideElectronApiMethod('publishPage', async () => ({ status: 'failed', note: 'The playground has no artifact service: nothing was published.' })),
      overrideElectronApiMethod('unpublishPage', async () => ({ outcome: 'failed', message: 'The playground has no artifact service: nothing was unpublished.' })),
      overrideElectronApiMethod('revokePageGrant', async () => false),
    ]
    return () => { for (const dispose of disposers.reverse()) dispose() }
  }, [])
  return (
    <SharePageDialog
      workspaceId={WORKSPACE_ID}
      page={page}
      grants={grants}
      hasSnapshot={snapshot}
      open
      onOpenChange={next => console.log(`[Playground] SharePageDialog open → ${next}`)}
    />
  )
}

/** UB14.53 — what the page view's body shows. */
export type MockPageViewContent = 'frame' | 'empty' | 'load-failed' | 'not-found'

const PAGE_VIEW_SLUG = LIBRARY[0]!.slug

/** The bytes a playground lease hands the frame (the starter template's shape: dark text on an unset canvas). */
const PAGE_VIEW_HTML = [
  '<!doctype html><html><head><meta charset="utf-8"><title>Build Health</title>',
  '<style>body{font-family:-apple-system,system-ui,sans-serif;margin:24px}.metric{font-size:40px;font-weight:700}',
  '.muted{opacity:.6;font-size:12px}</style></head>',
  '<body><h1>Build Health</h1><div class="metric">97%</div><div class="muted">median 6m 12s</div></body></html>',
].join('')

/** The page the view shows for a content state: none for `not-found`, no content digest for `empty`. */
export function mockPageViewPage(
  content: MockPageViewContent,
  refresh: MockRefreshOutcome = 'none',
  published: MockPublishState = 'none',
): LoadedPage | null {
  if (content === 'not-found') return null
  const page = loadedPage(LIBRARY[0]!, false, Date.now(), refresh, published)
  if (content !== 'empty') return page
  const { contentDigest: _digest, ...config } = page.config
  return { ...page, config }
}

const NO_PAGE_STORE = (what: string) => new Error(`The playground has no page store: ${what}.`)

/**
 * Every page channel the view (and the Share dialog it opens) calls, answered from `read()` at CALL time. Returns
 * the disposer that puts the bridge back.
 */
export function installPlaygroundPageViewBridge(
  read: () => { page: LoadedPage | null; content: MockPageViewContent; published: MockPublishState },
): () => void {
  const disposers = [
    overrideElectronApiMethod('getPage', async () => read().page),
    overrideElectronApiMethod('createPageLease', async (_workspaceId: string, slug: string) => {
      const { page, content } = read()
      if (!page || content === 'load-failed') throw NO_PAGE_STORE('no render lease was issued')
      const issuedAt = Date.now()
      return {
        lease: {
          leaseId: `playground-lease-${slug}`,
          nonce: 'playground-nonce',
          pageSlug: slug,
          contentDigest: page.config.contentDigest ?? '',
          issuedAt,
          expiresAt: issuedAt + 60 * MINUTE,
        },
        content: PAGE_VIEW_HTML,
      }
    }),
    overrideElectronApiMethod('releasePageLease', async () => undefined),
    overrideElectronApiMethod('getPageData', async () => null),
    overrideElectronApiMethod('listPageGrants', async () => []),
    overrideElectronApiMethod('getPageRefreshStatus', async (_workspaceId: string, slug: string) => (
      { state: 'approved' as const, script: `pages/${slug}/refresh.ts`, sha256: digestFor(`${slug}-refresh`) }
    )),
    overrideElectronApiMethod('getProjects', async () => []),
    overrideElectronApiMethod('onProjectsChanged', () => () => undefined),
    overrideElectronApiMethod('updatePage', async () => { throw NO_PAGE_STORE('nothing was changed') }),
    overrideElectronApiMethod('regeneratePageThumbnail', async () => true),
    overrideElectronApiMethod('deletePage', async () => { throw NO_PAGE_STORE('nothing was deleted') }),
    overrideElectronApiMethod('getPageShareDataScan', async (_workspaceId: string, _slug: string, options: { includeData: boolean }) =>
      mockPageShareReview(read().published === 'live' ? 'published' : 'unpublished', options?.includeData === true)),
    overrideElectronApiMethod('publishPage', async () => ({ status: 'failed', note: 'The playground has no artifact service: nothing was published.' })),
    overrideElectronApiMethod('unpublishPage', async () => ({ outcome: 'failed', message: 'The playground has no artifact service: nothing was unpublished.' })),
  ]
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** A layout effect where there is a document (it runs before every passive effect); a static render has none. */
const useBridgeEffect = typeof document === 'undefined' ? React.useEffect : React.useLayoutEffect

function PageViewPreview(
  { content, refresh = 'none', published = 'none' }:
  { content: MockPageViewContent; refresh?: MockRefreshOutcome; published?: MockPublishState },
) {
  const page = React.useMemo(() => mockPageViewPage(content, refresh, published), [content, refresh, published])
  const store = React.useMemo(() => {
    const s = createStore()
    s.set(pagesAtom, page ? [page] : [])
    return s
  }, [page])
  const stateRef = React.useRef({ page, content, published })
  stateRef.current = { page, content, published }
  useBridgeEffect(() => installPlaygroundPageViewBridge(() => stateRef.current), [])
  return (
    <Provider store={store}>
      <div className="h-full w-full">
        {/* Keyed on the knobs: the view's lease and fallback effects re-run against the new answers. */}
        <PageView key={`${content}-${refresh}-${published}`} pageSlug={PAGE_VIEW_SLUG} />
      </div>
    </Provider>
  )
}

const PAGE_VIEW_CONTENT_OPTIONS: Array<{ label: string; value: MockPageViewContent }> = [
  { label: 'The page in its frame', value: 'frame' },
  { label: 'No content yet', value: 'empty' },
  { label: 'Render lease refused (Retry)', value: 'load-failed' },
  { label: 'Page not found (Back to Pages)', value: 'not-found' },
]

const KIND_OPTIONS = [
  { label: 'Static', value: 'static' },
  { label: 'Interactive', value: 'interactive' },
  { label: 'Live', value: 'live' },
]

export const pagesComponents: ComponentEntry[] = [
  {
    id: 'pages-library',
    name: 'Pages Library',
    category: 'Pages',
    description:
      'The Pages home grid (PagesHome): header with the page count and New Page, then one tile per page, newest first. Empty shows the "No pages yet" screen with Ask an agent and Create blank Page. Tiles carry the kind badge (Static / Interactive / Live) and the relative update time; the poster knob gives each page a fresh preview poster. A tile\'s context menu offers Open, Refresh preview and Delete Page — Delete opens the confirmation. New Page and Delete answer with an error toast: the playground has no page store.',
    component: PagesLibraryPreview,
    layout: 'full',
    props: [
      {
        name: 'library',
        description: 'Empty library or one page of each kind',
        control: { type: 'select', options: [{ label: 'Empty', value: 'empty' }, { label: 'Populated', value: 'populated' }] },
        defaultValue: 'populated',
      },
      {
        name: 'posters',
        description: 'Each page has a fresh preview poster (else the kind placeholder: its icon in a raised circle on a role-toned well)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'refresh',
        description: 'The live page\'s scheduled refresh and its last run: none, ok (green dot + time) or failed (red dot + "Refresh failed")',
        control: { type: 'select', options: REFRESH_OPTIONS },
        defaultValue: 'none',
      },
      {
        name: 'published',
        description: 'UA6.7 — the live page\'s copy on t-artifacts: none, published (the share badge) or a deletion still owed (no badge)',
        control: { type: 'select', options: PUBLISHED_OPTIONS },
        defaultValue: 'none',
      },
    ],
    variants: [
      { name: 'Empty', description: 'No pages yet', props: { library: 'empty', posters: false } },
      { name: 'Three kinds', description: 'A live, an interactive and a static page, placeholders', props: { library: 'populated', posters: false } },
      { name: 'Three kinds · posters', description: 'The same pages with fresh posters', props: { library: 'populated', posters: true } },
      {
        name: 'Three kinds · refresh failed',
        description: 'The live page\'s last scheduled refresh failed: red dot + "Refresh failed" on its tile',
        props: { library: 'populated', posters: false, refresh: 'failed' },
      },
      {
        name: 'Three kinds · one published',
        description: 'The live page is published on t-artifacts: the share badge on its tile',
        props: { library: 'populated', posters: false, published: 'live' },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'pages-tile',
    name: 'Page Tile',
    category: 'Pages',
    description:
      'One library tile (PageTile), v0.15.1\'s raised 16:10 poster card with a hover lift: the poster when its digest matches the content, else the kind placeholder (its icon in a raised circle on a role-toned well) — then the title and one meta row: the kind chip (a success dot for live), the freshness dot with the relative update time (or, with a scheduled refresh, the last run\'s time, or "Refresh failed" in the destructive role), and "Shared" while a copy is live. Right-click for Open, Refresh preview ("Refreshing preview…" toast) and Delete Page.',
    component: PageTilePreview,
    layout: 'centered',
    props: [
      {
        name: 'kind',
        description: 'The page kind (drives the badge, glyph and the frame policy in the app)',
        control: { type: 'select', options: KIND_OPTIONS },
        defaultValue: 'live',
      },
      {
        name: 'name',
        description: 'Page title',
        control: { type: 'string', placeholder: 'Build Health' },
        defaultValue: 'Build Health',
      },
      {
        name: 'poster',
        description: 'A fresh preview poster',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'refresh',
        description: 'A scheduled refresh and its last run: none (update time), ok (green dot + run time) or failed (red dot + "Refresh failed")',
        control: { type: 'select', options: REFRESH_OPTIONS },
        defaultValue: 'none',
      },
      {
        name: 'published',
        description: 'UA6.7 — the page\'s copy on t-artifacts: none, published (the share badge) or a deletion still owed (no badge)',
        control: { type: 'select', options: PUBLISHED_OPTIONS },
        defaultValue: 'none',
      },
    ],
    variants: [
      { name: 'Static', props: { kind: 'static', poster: false } },
      { name: 'Interactive', props: { kind: 'interactive', poster: false } },
      { name: 'Live', props: { kind: 'live', poster: false } },
      { name: 'Poster', description: 'A fresh poster in place of the placeholder', props: { kind: 'live', poster: true } },
      { name: 'Refreshed', description: 'The last scheduled refresh succeeded: green dot + its time', props: { kind: 'live', poster: false, refresh: 'ok' } },
      { name: 'Refresh failed', description: 'The last scheduled refresh failed: red dot + "Refresh failed"', props: { kind: 'live', poster: false, refresh: 'failed' } },
      { name: 'Published', description: 'Published on t-artifacts: the share badge beside the freshness', props: { kind: 'live', poster: false, published: 'live' } },
      {
        name: 'Long title',
        description: 'Truncated on one line',
        props: { name: 'Gateway request volume by model alias, region and hour of day — last 30 days', poster: false },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'pages-delete-dialog',
    name: 'Delete Page Dialog',
    category: 'Pages',
    description:
      'The destructive confirmation the tile menu and the page menu open (DeletePageDialog): it names the page and says its data goes too. Cancel and Delete Page only log here.',
    component: DeletePageDialog,
    layout: 'centered',
    props: [
      {
        name: 'pageName',
        description: 'The page named in the confirmation',
        control: { type: 'string', placeholder: 'Build Health' },
        defaultValue: 'Build Health',
      },
      {
        name: 'shared',
        description: 'UA6.7 — the page is published: the note that its copy is taken offline too',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Default', props: { pageName: 'Build Health' } },
      { name: 'Published page', props: { pageName: 'Build Health', shared: true } },
      { name: 'Long name', props: { pageName: 'Gateway request volume by model alias, region and hour of day — last 30 days' } },
    ],
    mockData: () => ({
      onConfirm: () => console.log('[Playground] DeletePageDialog confirm'),
      onCancel: () => console.log('[Playground] DeletePageDialog cancel'),
    }),
  },
  {
    id: 'pages-share-dialog',
    name: 'Share Page Dialog',
    category: 'Pages',
    description:
      'UA6.7 — publish a page on the internal artifact service (SharePageDialog): the review card (the same component as the session publish card: access line, owner, expiry, size and sha256, the scan sentence, scripts and hosts, a script-free preview), the include-data switch with its secret-key warning, the script-approval block, the view-only acknowledgment; published, the link with Copy, the drift line with "Publish latest" and the two-step Unpublish. Publish and Unpublish answer with an error toast: the playground has no artifact service.',
    component: PageShareDialogPreview,
    layout: 'centered',
    props: [
      {
        name: 'state',
        description: 'Which page and review the dialog shows',
        control: { type: 'select', options: SHARE_STATE_OPTIONS },
        defaultValue: 'unpublished',
      },
      {
        name: 'snapshot',
        description: 'The page has a data snapshot (offers "Include current data snapshot"; on, the review lists a secret-looking key)',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: SHARE_STATE_OPTIONS.map(option => ({ name: option.label, props: { state: option.value, snapshot: true } })),
    mockData: () => ({}),
  },
  {
    id: 'pages-view',
    name: 'Page View',
    category: 'Pages',
    description:
      'UB14.53 — one page (PageView) on v0.15.1\'s look: the 48px header with Back and More as icon buttons, the title (double-click renames), the kind chip and freshness, and the Share entry (the accent globe and "Shared" while a copy is live on t-artifacts); under it the scheduled-refresh row and a failed refresh\'s alert; then the body — the page\'s frame as a raised card on the paper, the no-content screen (Design this with an agent, Open Folder), a refused render lease (the alert and Retry), or Page not found (Back to Pages). Rename, Delete, Publish and Unpublish answer with an error toast: the playground has no page store and no artifact service.',
    component: PageViewPreview,
    layout: 'full',
    props: [
      {
        name: 'content',
        description: 'What the body shows',
        control: { type: 'select', options: PAGE_VIEW_CONTENT_OPTIONS },
        defaultValue: 'frame',
      },
      {
        name: 'refresh',
        description: 'A scheduled refresh and its last run: none, ok (the refresh row) or failed (the row and the alert)',
        control: { type: 'select', options: REFRESH_OPTIONS },
        defaultValue: 'none',
      },
      {
        name: 'published',
        description: 'The page\'s copy on t-artifacts: none, published (the accent globe and "Shared") or a deletion still owed',
        control: { type: 'select', options: PUBLISHED_OPTIONS },
        defaultValue: 'none',
      },
    ],
    variants: [
      { name: 'Frame', props: { content: 'frame' } },
      { name: 'Frame · published', props: { content: 'frame', published: 'live' } },
      { name: 'Frame · refreshed', props: { content: 'frame', refresh: 'ok' } },
      { name: 'Frame · refresh failed', props: { content: 'frame', refresh: 'failed' } },
      { name: 'No content', props: { content: 'empty' } },
      { name: 'Load failed', props: { content: 'load-failed' } },
      { name: 'Not found', props: { content: 'not-found' } },
    ],
    mockData: () => ({}),
  },
]
