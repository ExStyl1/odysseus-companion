/**
 * RS-117 (plan row UA6.7, 1.42.0 upstream adoption) - publishing a Page on
 * t-artifacts on the shipped build. THE OWNER'S SITTING (O15, with UA1.22 and
 * UA1.27): this case publishes FOR REAL - consented case-authored content,
 * retention lowered to 1 day right after every publish, and every artifact id
 * deleted before the case ends. No lane ever runs it; the sitting ASK it answers
 * is `work/wi16/sitting-asks.md`'s UA6.7 entry, arm for arm.
 *
 * ## What it proves (two case-authored pages, created through `pages:create`)
 *
 * R.  **The review card** (ASK 1). Share on a LIVE page that has a data snapshot
 *     opens the dialog with the host's review of exactly the bytes a publish
 *     would send - `pages:getShareDataScan` rendered by `ArtifactPublishDetails`,
 *     the very component the session's publish card uses - naming the source
 *     (`pages/<slug>`), the size·lines·sha256 line and the access warning.
 *     Nothing was sent: the review is a capture-and-decline run of the chain.
 * P.  **Publish WITHOUT data** (ASK 2). The dialog's Publish publishes; the link
 *     renders (fetched by the case process: 200, HTML, the page's marker); the
 *     published copy's `init` carries a NULL snapshot; an `action` answers the
 *     view-only sentence. The publication's retention is PATCHed to 1 day
 *     through the app's own `artifacts:setRetention`.
 * D.  **Publish WITH data** (ASK 3). With the include-data switch on, the amber
 *     warning names the planted FAKE `apiToken` key (a key NAME the snapshot
 *     scan flags; the VALUE is assembled at runtime and obviously fake, so the
 *     blocking token scan still passes); the review's sha256 CHANGES against
 *     the no-data review; a publish whose `reviewedSha256` names OTHER bytes is
 *     refused and nothing is sent (the review-before-send invariant's negative
 *     arm); "Publish latest" answers `updated` with the SAME link; the fetched
 *     copy carries the inlined snapshot element and the running copy's `init`
 *     answers the data marker, the action still view-only.
 * U.  **Unpublish** (ASK 4). The dialog's two-step Unpublish takes the page's
 *     copy down: the host no longer reports a publication and the link answers
 *     404.
 * X.  **The delete order** (ASK 5). Published again (a fresh row - the old one
 *     left in U), the page's delete confirmation names the published-copy note;
 *     deleting the page takes its SERVICE COPY down first - measured by polling
 *     the workspace's own `artifacts/registry.json` and the page folder from
 *     the case process: a sample with the row gone and the folder still present,
 *     and never the reverse. The registry's delete-pending path is NOT taken:
 *     no row (live or pending) survives, and the delete answers
 *     `publicCopyMayRemain: false`.
 * S.  **A script grant blocks publishing** (ASK 6). A page holding a script
 *     grant shows the dialog's red block, its Publish button stays disabled, and
 *     the review answers `PAGE_SHARE_SCRIPT_GRANT`; revoking the grant restores
 *     a passing review (the control).
 * M.  **The dark playground sweep** (ASK 7) is a MANUAL add-on, recorded in
 *     `meta.credentials`: the packaged build's `will-navigate` admits only the
 *     app's own `index.html` (P6.667) and the playground refuses a bridge it did
 *     not install (P6.668), so no CDP drive reaches it - RS-47 measures the
 *     navigation half on the same artefact. The four markers are pinned against
 *     the playground registry by `scripts/cdp/rs-117-publish-score.test.ts`, so
 *     the sweep spells the variants the registry actually carries.
 *
 * ## Detectors
 *
 * - The host's own answers (`getPageShareDataScan`, `publishPage`,
 *   `unpublishPage`, `getPage`, `deletePage`, `setPublishedArtifactRetention`),
 *   never the model's prose - no turn runs at all.
 * - The dialog is read off the RENDERED DOM and pressed with real pointer
 *   clicks at measured rects, matched by their English or Russian labels.
 * - The published copy's behaviour: the case process FETCHES the link, then
 *   loads those exact bytes in a `sandbox="allow-scripts"` srcdoc iframe in the
 *   app's main world. The page's own script (authored here, running after the
 *   shim) records the shim's `init` snapshot and posts an `action`, relaying
 *   both out through `window.top.postMessage` (the shim replaces `parent`, not
 *   `top`). The app origin's CSP allows `'unsafe-inline'`, so the srcdoc copy
 *   runs the same bytes the service serves.
 * - The delete order: `readArtifactRegistry`'s own file
 *   (`<workspace>/artifacts/registry.json`, torn reads skipped) and the page
 *   folder, polled by the case process around the delete.
 *
 * ## What it writes
 *
 * Under the run's OWN config dir only ({@link writableConfigDir}): two pages
 * (`RS-117 publish <stamp>`, `RS-117 script <stamp>` - the first deleted by arm
 * X, both deleted in the `finally` regardless), the planted snapshot inside
 * `pages/<slug>/data/snapshot.json` (goes with the page), and
 * `<workspace>/rs117-<stamp>/` (the grant's script, removed). On t-artifacts:
 * the rows this case publishes, each PATCHed to retention 1 day and every one
 * deleted (unpublish, or the page delete) before the case ends. No session, no
 * turn, no permission card.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { blocked, main, type CaseRun } from '../lib/report.ts'
import { writableConfigDir } from '../lib/runtime-session-log.ts'
import { assertElectronApi, waitFor } from '../lib/state.ts'
import { pressKey } from '../lib/keys.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta } from '../lib/sitting.ts'

const ID = 'RS-117'
const TITLE = 'Pages publishing: the review card before anything is sent, publish without data (null snapshot, view-only actions), publish with data (sha256 changes, fake-key warning, same link), unpublish 404, the delete order, a script grant blocking Publish'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA6.7',
  // No turn, no card, no runtime surface: publishing is host-side and identical under every runtime (as RS-34 declares).
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner (O15, with UA1.22/UA1.27): the OWNER\'s dp identity signed in - this case PUBLISHES FOR REAL to t-artifacts, '
    + 'using consented case-authored content, lowering every publication\'s retention to 1 day right after it is created '
    + '(artifacts:setRetention), and deleting every artifact id before it ends; it BLOCKS, never fails, when the dp identity '
    + 'cannot publish (artifacts-unavailable / needs-login). English UI (the case reads locale-independent card needles but '
    + 'presses bilingual labels). NESSY_CONFIG_DIR exported to this case (it writes into the workspace: pages, one script '
    + 'file, one planted snapshot; NESSY_CDP_RS117_WORKSPACE_ROOT overrides the root). A desktop-width window. '
    + 'MANUAL ADD-ONS in the same sitting - the dark playground sweep the packaged app keeps out of CDP reach '
    + '(will-navigate admits only index.html, P6.667; the playground refuses a bridge it did not install, P6.668): '
    + 'Share Page Dialog (7 states), Page Tile "Published", Library "Three kinds · one published", '
    + 'Delete dialog "Published page". No key, token or credential file is read; the planted apiToken VALUE is assembled '
    + 'at runtime and obviously fake.',
} as const satisfies CaseMeta

/**
 * The copy this case finds controls by, as the live locale spells it - pinned by
 * `harness.test.ts` ("a case's quoted copy against the live locale").
 */
export const QUOTED_COPY = {
  'pages.share.title': { en: 'Share Page', ru: 'Поделиться страницей' },
  'pages.share.publish': { en: 'Publish', ru: 'Опубликовать' },
  'pages.share.republish': { en: 'Publish latest', ru: 'Опубликовать последнюю версию' },
  'pages.share.unpublish': { en: 'Unpublish', ru: 'Снять с публикации' },
  'pages.share.includeData': { en: 'Include current data snapshot', ru: 'Включить текущий снимок данных' },
  'pages.share.scriptBlockedTitle': { en: "This page can't be published", ru: 'Эту страницу нельзя опубликовать' },
  'pages.shared': { en: 'Shared', ru: 'Опубликована' },
  'pages.deleteSharedNote': { en: 'The published copy is taken offline as part of deleting.', ru: 'Опубликованная копия тоже будет снята.' },
  'pages.deletePage': { en: 'Delete Page', ru: 'Удалить страницу' },
  'common.cancel': { en: 'Cancel', ru: 'Отмена' },
  'common.more': { en: 'More', ru: 'Ещё' },
} as const

const labels = (key: keyof typeof QUOTED_COPY): readonly string[] => Object.values(QUOTED_COPY[key])

/** The protocol the published-copy probe relays through (a foreign protocol the page bridge ignores). */
const PROBE_PROTOCOL = 'rs117-probe'
/** The kv key that carries the run marker inside the snapshot. */
export const MARKER_KEY = 'rs117Marker'
/** The `<iframe>` attribute that marks the case's published-copy probe frame. */
const COPY_FRAME = 'data-rs117-copy'

/** How long the case waits for a dialog the review must fill (the review runs the whole publish chain). */
const REVIEW_MS = 30_000
/** How long the published link's fetch may take. */
const FETCH_MS = 30_000
/** The minimum delete-order sampling window (the sampler keeps polling past the RPC's return). */
const ORDER_SETTLE_MS = 2_000

// ============================================================================
// Pure pieces (pinned by scripts/cdp/rs-117-publish-score.test.ts)
// ============================================================================

/**
 * The planted fake token VALUE: a `your_…` placeholder, assembled at runtime. The sitting measured the
 * alternatives on RC4 (S7-D, 2026-10-10): a bare `rs117-fake-not-a-secret-…` word is REFUSED by the
 * guard's value rule (a value assigned to a credential-shaped key must read as a placeholder), and a
 * `<…>` placeholder is defeated by the built document — `share-bundle.ts` `inlineJson` escapes `<` to
 * `\u003c`, knocking the value out of placeholder shape, so the document scan refuses a value the part
 * scans passed. A `your_…`-shaped value passes both scans and survives the escaping, so its VALUE stays
 * assertable in the served bytes.
 */
export function fakeApiTokenValue(): string {
  return `your_api_token_rs117_${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`
}

/** The planted snapshot: the run marker beside the fake `apiToken` key (the key NAME is the warning's subject). */
export function snapshotJson(marker: string, fakeToken: string): string {
  return `${JSON.stringify({
    version: 1,
    generatedAt: Date.now(),
    kv: { [MARKER_KEY]: marker, apiToken: fakeToken },
    series: {},
  }, null, 2)}\n`
}

export interface Verdict { ok: boolean; detail: string }

/**
 * Arm R: the dialog shows the host's review of the bytes a publish would send. The needles are the
 * locale-INDEPENDENT parts of `ArtifactPublishDetails`: the card's `File:` line names the registry's source path
 * (`pages/<slug>`), and the size line carries `sha256 <the card's 12-hex prefix>` (`artifactShaPrefix`).
 */
export function scoreReviewCard(text: string, slug: string, shaPrefix: string): Verdict {
  const missing = [`pages/${slug}`, `sha256 ${shaPrefix}`].filter(needle => !text.includes(needle))
  if (missing.length > 0) {
    return { ok: false, detail: `the review card lacks ${JSON.stringify(missing)}: ${JSON.stringify(text.slice(0, 300))}` }
  }
  return { ok: true, detail: 'the card names the source and the reviewed bytes\' sha256' }
}

/** Arm D: including the data changes what is sent - the two reviews' sha256 must differ (64-hex each). */
export function shaChangesVerdict(shaWithoutData: string | null, shaWithData: string | null): Verdict {
  if (shaWithoutData === null || shaWithData === null) {
    return { ok: false, detail: 'UNMEASURED - a review sha256 is unread, so "what is sent" was never pinned on both sides' }
  }
  if (!/^[0-9a-f]{64}$/.test(shaWithoutData) || !/^[0-9a-f]{64}$/.test(shaWithData)) {
    return { ok: false, detail: `a review sha256 is not a digest: ${shaWithoutData.slice(0, 16)}… / ${shaWithData.slice(0, 16)}…` }
  }
  return shaWithoutData === shaWithData
    ? { ok: false, detail: 'the review sha256 is UNCHANGED with the data included - the snapshot is not in the sent bytes' }
    : { ok: true, detail: `sha256 changes (${shaWithoutData.slice(0, 12)}… → ${shaWithData.slice(0, 12)}…)` }
}

/**
 * Arm D's negative: a publish whose `reviewedSha256` names OTHER bytes is refused and nothing is sent. A success
 * here would mean bytes left the machine that nobody reviewed.
 */
export function driftRefusalVerdict(result: { status: string; note: string } | null): Verdict {
  if (result === null) return { ok: false, detail: 'UNMEASURED - the publish call did not answer' }
  if (result.status !== 'refused') {
    return { ok: false, detail: `NOT refused (status ${result.status}) - bytes nobody reviewed may have been sent: ${result.note.slice(0, 200)}` }
  }
  return result.note.includes('changed after you reviewed it')
    ? { ok: true, detail: result.note }
    : { ok: false, detail: `refused for another reason: ${result.note.slice(0, 200)}` }
}

/** What the published copy itself reported, relayed by the page's own script. */
export interface CopyProbe {
  /** The shim's `init` reached the page; `snapshotNull`/`marker` read off its payload. */
  init: { snapshotNull: boolean; marker: string | null; grants: unknown } | null
  /** The shim's answer to the probe's `action`. */
  action: { ok: boolean; error: string | null } | null
}

/**
 * Arms P and D, the published copy's own behaviour: `init` (a NULL snapshot when the data was not included, the
 * marker when it was, and always empty grants) and the view-only `action` answer. Either reading absent is
 * UNMEASURED, never a pass - the copy may never have run.
 */
export function scoreCopyProbe(probe: CopyProbe, want: { marker: string | null }): Verdict {
  if (probe.init === null) return { ok: false, detail: 'UNMEASURED - the published copy never reported its init' }
  if (probe.action === null) return { ok: false, detail: 'UNMEASURED - the published copy never answered the probe action' }
  const misses: string[] = []
  if (want.marker === null) {
    if (!probe.init.snapshotNull) misses.push(`init carries a snapshot (marker ${JSON.stringify(probe.init.marker)}) where none was published`)
  } else if (probe.init.marker !== want.marker) {
    misses.push(`init carries ${JSON.stringify(probe.init.marker)}, not the published marker`)
  }
  if (Array.isArray(probe.init.grants) && probe.init.grants.length > 0) misses.push(`init carries grants: ${JSON.stringify(probe.init.grants)}`)
  if (probe.action.ok || !(probe.action.error ?? '').includes('view-only')) {
    misses.push(`the action is not view-only: ${JSON.stringify(probe.action)}`)
  }
  return misses.length === 0
    ? { ok: true, detail: want.marker === null ? 'init with a NULL snapshot; the action answers view-only' : 'init carries the marker; the action answers view-only' }
    : { ok: false, detail: misses.join('; ') }
}

/** The link as the case process fetched it. */
export interface LinkFetch { status: number | null; contentType: string | null; body: string }

/** Arm P: the link renders - 200, HTML, the page's own marker in the served bytes. */
export function scoreLinkRenders(fetch: LinkFetch, marker: string): Verdict {
  if (fetch.status !== 200) return { ok: false, detail: `the link answers ${fetch.status ?? 'no status'}, not 200` }
  if ((fetch.contentType ?? '').toLowerCase().split(';')[0] !== 'text/html') {
    return { ok: false, detail: `the link serves ${JSON.stringify(fetch.contentType)}, not HTML` }
  }
  if (!fetch.body.includes(marker)) return { ok: false, detail: `the served bytes lack the page marker ${JSON.stringify(marker)}` }
  return { ok: true, detail: `200 HTML carrying the marker (${fetch.body.length} bytes)` }
}

/** Arm U (and X's copy): the link is gone - a 404, never a redirect to something else that answers. */
export function scoreLinkGone(status: number | null): Verdict {
  if (status === null) return { ok: false, detail: 'UNMEASURED - the fetch did not answer' }
  return status === 404 ? { ok: true, detail: 'the link answers 404' } : { ok: false, detail: `the link answers ${status}, not 404` }
}

/**
 * The DOCUMENT endpoint behind a published link. The deployed service answers `/a/{id}` with its own JS
 * shell (title and emoji only, `window.__ARTIFACT__`, no page bytes — measured on RC4, S7-D 2026-10-10),
 * so every marker detector fetches `/api/artifacts/{id}/content` on the link's own origin. Pinned by
 * `rs-117-publish-score.test.ts`.
 */
export function contentUrlFor(publishedUrl: string, artifactId: string): string {
  return `${new URL(publishedUrl).origin}/api/artifacts/${artifactId}/content`
}

/** One delete-order sample: the registry row for the artifact (null: the file tore mid-write), the folder on disk. */
export interface OrderSample { row: boolean | null; folder: boolean }

/**
 * Arm X: the service copy goes FIRST. Proven only by a sample with the row gone while the folder is still present;
 * the reverse sample FAILS (the local delete preceded the copy's); no separating sample is UNMEASURED - the polls
 * were too coarse to see the order, which is never a pass.
 */
export function scoreDeleteOrder(samples: readonly OrderSample[]): Verdict {
  const reversed = samples.some(sample => sample.row === true && sample.folder === false)
  if (reversed) {
    return { ok: false, detail: 'the page folder went while the service copy\'s row was still live - the order was reversed' }
  }
  const separating = samples.some(sample => sample.row === false && sample.folder === true)
  if (!separating) {
    return {
      ok: false,
      detail: `UNMEASURED - no sample separates the two deletes (${samples.length} samples; the poll never saw the row gone with `
        + 'the folder present), so the order was not measured',
    }
  }
  return { ok: true, detail: `a sample has the row gone with the folder present (${samples.length} samples)` }
}

/**
 * Arm S: the red block, the disabled Publish, and the review's refusal code - all three, because a block without the
 * disabled button (or vice versa) is a different defect than the one UA6.7 claims.
 */
export function scoreScriptBlocked(evidence: {
  blockShown: boolean; publishDisabled: boolean | null; reviewCode: string | null | undefined
}): Verdict {
  const misses: string[] = []
  if (!evidence.blockShown) misses.push('the dialog shows no script-approval block')
  if (evidence.publishDisabled !== true) misses.push('the Publish button is not disabled')
  if (evidence.reviewCode !== 'PAGE_SHARE_SCRIPT_GRANT') misses.push(`the review answers ${JSON.stringify(evidence.reviewCode)}`)
  return misses.length === 0
    ? { ok: true, detail: 'the red block, Publish disabled, and the review refused PAGE_SHARE_SCRIPT_GRANT' }
    : { ok: false, detail: misses.join('; ') }
}

/**
 * The page whose published copy the case measures. NO doctype (the builder's is what the service sees). Its own
 * script runs AFTER the shim (which is inserted first in `<head>`): it records the shim's `init`, posts one
 * `action`, and relays both out through `window.top` - the shim replaces `parent`, never `top`, so the relay works
 * in the case's sandboxed frame and posts harmlessly to the copy itself anywhere else.
 */
export function publishProbePageHtml(marker: string): string {
  return [
    '<html><head><meta charset="utf-8"><title>RS-117 publish</title></head><body>',
    `<h1>RS-117 publish</h1><div id="marker">${marker}</div>`,
    '<script>',
    '(function () {',
    "  var P = 'nessy-pages/v1'",
    '  window.addEventListener(\'message\', function (event) {',
    '    var m = event.data',
    '    if (!m || m.protocol !== P) return',
    "    if (m.type === 'init') {",
    '      var payload = m.payload || {}',
    '      var s = payload.snapshot || null',
    '      var out = {',
    '        snapshotNull: s === null,',
    `        marker: s && s.kv ? (s.kv[${JSON.stringify(MARKER_KEY)}] || null) : null,`,
    '        grants: payload.grants || []',
    '      }',
    `      try { window.top.postMessage({ protocol: ${JSON.stringify(PROBE_PROTOCOL)}, type: 'copy-init', payload: out }, '*') } catch (e) {}`,
    `      window.postMessage({ protocol: P, type: 'action', requestId: 'rs117-probe', invocation: { kind: 'api', sourceSlug: 'rs117-none', method: 'GET', pathPattern: '/probe' } }, '*')`,
    '    }',
    "    if (m.type === 'action-result') {",
    '      var r = (m.payload && m.payload.result) || {}',
    `      try { window.top.postMessage({ protocol: ${JSON.stringify(PROBE_PROTOCOL)}, type: 'copy-action', payload: { ok: r.ok === true, error: r.error || null } }, '*') } catch (e) {}`,
    '    }',
    '  })',
    '})()',
    '</script></body></html>',
    '',
  ].join('\n')
}

/** Arm S's script: the file the grant's sha256 is pinned to; it never runs in this case. */
export function grantScriptSource(): string {
  return "console.log('RS-117: this page was never publishable while it held this grant')\n"
}

// ============================================================================
// The app's own channels, the dialog, the relay
// ============================================================================

interface PublicationRead {
  artifactId?: string
  url?: string
  includesData?: boolean
  pendingDelete?: boolean
}

interface ReviewRead {
  snapshotBytes: number | null
  secretCandidates: string[]
  review:
    | { ok: true; mode: 'create' | 'update'; card: { sha256: string; byteLength: number } }
    | { ok: false; message: string; code?: string }
}

async function activeWorkspaceId(session: CdpSession): Promise<string> {
  const id = await session.call<string | null>(`
    const ws = await window.electronAPI.getWindowWorkspace?.()
    if (typeof ws === 'string' && ws) return ws
    const all = await window.electronAPI.getSessions()
    return (all && all[0] && all[0].workspaceId) || null
  `)
  if (!id) blocked('no workspace id could be read from the window (getWindowWorkspace / getSessions)')
  return id
}

async function navigateRoute(session: CdpSession, route: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: ${JSON.stringify(route)} }, bubbles: true }))
    return null
  `)
}

async function publicationOf(session: CdpSession, ws: string, slug: string): Promise<PublicationRead | null> {
  return session.call<PublicationRead | null>(`
    const p = await window.electronAPI.getPage(${JSON.stringify(ws)}, ${JSON.stringify(slug)})
    if (!p || !p.publication) return null
    return {
      artifactId: p.publication.artifactId, url: p.publication.url,
      includesData: p.publication.includesData === true, pendingDelete: p.publication.pendingDelete === true,
    }
  `)
}

async function settledPublication(
  session: CdpSession, ws: string, slug: string, want: (read: PublicationRead | null) => boolean, timeoutMs = 20_000,
): Promise<PublicationRead | null> {
  try {
    return await waitFor(() => publicationOf(session, ws, slug), want, { timeoutMs, intervalMs: 500 })
  } catch {
    return publicationOf(session, ws, slug)
  }
}

async function reviewOf(session: CdpSession, ws: string, slug: string, includeData: boolean): Promise<ReviewRead | null> {
  return session.call<ReviewRead | null>(`
    try {
      const r = await window.electronAPI.getPageShareDataScan(${JSON.stringify(ws)}, ${JSON.stringify(slug)}, { includeData: ${includeData ? 'true' : 'false'} })
      return {
        snapshotBytes: r.snapshotBytes ?? null,
        secretCandidates: Array.isArray(r.secretCandidates) ? r.secretCandidates : [],
        review: r.review && r.review.ok === true
          ? { ok: true, mode: r.review.mode, card: { sha256: r.review.card.sha256, byteLength: r.review.card.byteLength } }
          : { ok: false, message: r.review ? r.review.message : 'no review', code: r.review ? r.review.code : undefined },
      }
    } catch (e) { return null }
  `).catch(() => null)
}

/** Whether a failed publish is the missing OWNER dp identity (a precondition, never a product failure). */
export function needsOwnerIdentity(note: string): boolean {
  return /artifacts-unavailable|needs-login|dp-unavailable|not signed in/i.test(note)
}

async function publishThrough(
  run: CaseRun, session: CdpSession, ws: string, slug: string, options: { includeData: boolean; reviewedSha256: string },
): Promise<{ status: string; note: string; url?: string } | null> {
  const result = await session.call<{ status: string; note: string; url?: string }>(`
    try {
      return await window.electronAPI.publishPage(${JSON.stringify(ws)}, ${JSON.stringify(slug)}, {
        includeData: ${options.includeData ? 'true' : 'false'}, reviewedSha256: ${JSON.stringify(options.reviewedSha256)},
      })
    } catch (e) { return { status: 'threw', note: String((e && (e.code || e.message)) || e).slice(0, 200) } }
  `).catch(error => ({ status: 'threw', note: `case-side: ${String(error).slice(0, 160)}` }))
  if (result.status === 'threw' && needsOwnerIdentity(result.note)) {
    blocked(`this case publishes FOR REAL (O15) and the dp identity cannot publish: ${result.note}. `
      + 'The sitting needs the OWNER\'s signed-in dp identity - a lane never runs this arm.')
  }
  run.observe(`publish (${options.includeData ? 'with' : 'without'} data) answered`, result)
  return result
}

async function unpublishThrough(session: CdpSession, ws: string, slug: string): Promise<{ outcome: string; message?: string }> {
  return session.call<{ outcome: string; message?: string }>(`
    try { return await window.electronAPI.unpublishPage(${JSON.stringify(ws)}, ${JSON.stringify(slug)}) }
    catch (e) { return { outcome: 'threw', message: String((e && (e.code || e.message)) || e).slice(0, 200) } }
  `).catch(error => ({ outcome: 'threw', message: String(error).slice(0, 160) }))
}

async function patchRetention(session: CdpSession, ws: string, artifactId: string, days: number): Promise<{ ok: boolean; read: string }> {
  const result = await session.call<string>(`
    try {
      const r = await window.electronAPI.setPublishedArtifactRetention(${JSON.stringify(ws)}, ${JSON.stringify(artifactId)}, ${days})
      return r && r.ok === true && r.artifact ? 'ok retentionDays=' + String(r.artifact.retentionDays) : 'refused: ' + JSON.stringify(r).slice(0, 200)
    } catch (e) { return 'threw: ' + String((e && (e.code || e.message)) || e).slice(0, 200) }
  `).catch(error => `threw: ${String(error).slice(0, 160)}`)
  return { ok: result.startsWith('ok retentionDays='), read: result }
}

async function fetchLink(url: string): Promise<LinkFetch> {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_MS) })
    return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() }
  } catch (error) {
    return { status: null, contentType: null, body: `fetch failed: ${String(error).slice(0, 200)}` }
  }
}

// ───────────────────────────── the dialog ─────────────────────────────

async function dialogText(session: CdpSession): Promise<string | null> {
  return session.call<string | null>(`
    const d = Array.from(document.querySelectorAll('[role="dialog"]')).pop(); return d ? (d.innerText || '') : null
  `)
}

async function waitForDialogText(session: CdpSession, label: string, timeoutMs = REVIEW_MS): Promise<string> {
  const text = await waitFor(() => dialogText(session), value => value !== null && value.length > 0, { timeoutMs, intervalMs: 300, label })
    .catch(() => null)
  if (text === null) throw new Error(`${label}: no [role="dialog"] with text within ${timeoutMs}ms`)
  return text
}

/** The rect of the last dialog's button labelled `want`, scrolled into view. */
async function dialogButton(session: CdpSession, want: readonly string[]): Promise<{ x: number; y: number } | null> {
  return session.call<{ x: number; y: number } | null>(`
    const roots = Array.from(document.querySelectorAll('[role="dialog"]'))
    const root = roots[roots.length - 1]
    if (!root) return null
    const el = Array.from(root.querySelectorAll('button')).find(x => ${JSON.stringify(want)}.includes((x.innerText || '').trim()))
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  `)
}

/** Whether the last dialog's button labelled `want` exists and is disabled - the S arm's own read. */
async function dialogButtonDisabled(session: CdpSession, want: readonly string[]): Promise<boolean | null> {
  return session.call<boolean | null>(`
    const roots = Array.from(document.querySelectorAll('[role="dialog"]'))
    const root = roots[roots.length - 1]
    if (!root) return null
    const el = Array.from(root.querySelectorAll('button')).find(x => ${JSON.stringify(want)}.includes((x.innerText || '').trim()))
    return el ? el.disabled === true : null
  `)
}

/** The include-data switch inside the last dialog (`SharePageDialog` renders exactly one while no ack is needed). */
async function dialogSwitch(session: CdpSession): Promise<{ x: number; y: number } | null> {
  return session.call<{ x: number; y: number } | null>(`
    const roots = Array.from(document.querySelectorAll('[role="dialog"]'))
    const root = roots[roots.length - 1]
    if (!root) return null
    const el = root.querySelector('[role="switch"]')
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  `)
}

async function pressDialogButton(session: CdpSession, want: readonly string[], label: string): Promise<string> {
  const rect = await waitFor(() => dialogButton(session, want), value => value !== null, { timeoutMs: 10_000, intervalMs: 300, label })
    .catch(() => null)
  if (!rect) return `not-found: no dialog button reading ${JSON.stringify(want)}`
  await clickAt(session, rect, label)
  return 'pressed'
}

/** The rect of a `button[aria-label]` or `[role="menuitem"]` reading `want`, scrolled into view. */
async function labelledRect(session: CdpSession, selector: 'button[aria-label]' | '[role="menuitem"]', want: readonly string[]): Promise<{ x: number; y: number } | null> {
  return session.call<{ x: number; y: number } | null>(`
    const want = ${JSON.stringify(want)}
    const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(x => {
      const key = ${JSON.stringify(selector)} === 'button[aria-label]' ? x.getAttribute('aria-label') : (x.innerText || '').trim()
      return want.includes(key)
    })
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  `)
}

async function openShareDialog(run: CaseRun, session: CdpSession, slug: string, label: string): Promise<string> {
  await navigateRoute(session, `pages/page/${slug}`)
  const entry = await waitFor(
    () => labelledRect(session, 'button[aria-label]', labels('pages.share.title')),
    value => value !== null, { timeoutMs: 15_000, intervalMs: 400, label: `${label}: the Share entry` },
  ).catch(() => null)
  run.require(`${label}: the page's Share entry is on screen`, entry !== null, 'no button[aria-label] reading the Share Page title')
  await clickAt(session, entry!, `${label}: Share`)
  return waitForDialogText(session, `${label}: the Share dialog`)
}

async function closeDialog(session: CdpSession): Promise<void> {
  await pressKey(session, 'Escape').catch(() => undefined)
  await waitFor(() => dialogText(session), value => value === null, { timeoutMs: 8_000, intervalMs: 250 }).catch(() => undefined)
}

// ─────────────────────────── the published copy ───────────────────────────

async function installRelay(session: CdpSession): Promise<void> {
  await session.call<null>(`
    if (!window.__rs117) {
      window.__rs117 = { messages: [] }
      window.addEventListener('message', event => {
        const msg = event.data
        if (!msg || msg.protocol !== ${JSON.stringify(PROBE_PROTOCOL)}) return
        const frames = Array.from(document.querySelectorAll('iframe[${COPY_FRAME}]'))
        if (!event.source || !frames.some(f => f.contentWindow === event.source)) return
        window.__rs117.messages.push({ at: Date.now(), msg })
      })
    }
    return null
  `)
}

/**
 * Load the FETCHED bytes of the published copy in a sandboxed srcdoc frame and read what the copy itself reports:
 * the shim's `init` (snapshot, grants) and its answer to one `action`. The frame is removed before returning.
 */
async function runPublishedCopy(session: CdpSession, html: string): Promise<CopyProbe> {
  await session.call<null>(`
    window.__rs117.messages.length = 0
    document.querySelectorAll('iframe[${COPY_FRAME}]').forEach(el => el.remove())
    const frame = document.createElement('iframe')
    frame.setAttribute('${COPY_FRAME}', '1')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.style.display = 'none'
    frame.srcdoc = ${JSON.stringify(html)}
    document.body.appendChild(frame)
    return null
  `)
  const messages = await waitFor(
    () => session.call<Array<{ msg: { type: string; payload: unknown } }>>(
      `return (window.__rs117 ? window.__rs117.messages : []).map(m => ({ msg: m.msg }))`),
    rows => rows.some(row => row.msg.type === 'copy-init') && rows.some(row => row.msg.type === 'copy-action'),
    { timeoutMs: 20_000, intervalMs: 300, label: 'the published copy\'s report' },
  ).catch(() => [] as Array<{ msg: { type: string; payload: unknown } }>)
  await session.call<null>(`document.querySelectorAll('iframe[${COPY_FRAME}]').forEach(el => el.remove()); return null`).catch(() => undefined)
  const init = messages.find(row => row.msg.type === 'copy-init')?.msg.payload as CopyProbe['init']
  const action = messages.find(row => row.msg.type === 'copy-action')?.msg.payload as CopyProbe['action']
  return { init: init ?? null, action: action ?? null }
}

// ─────────────────────────── the registry sampler ───────────────────────────

/** The page's registry row presence for its artifact id (null: the file tore mid-write). */
export function registryRowPresent(registryText: string | null, artifactId: string): boolean | null {
  if (registryText === null) return null
  try {
    const entries = JSON.parse(registryText) as Array<{ id?: string }>
    return entries.some(entry => entry.id === artifactId)
  } catch {
    return null
  }
}

/**
 * Poll the workspace's own `artifacts/registry.json` and the page folder while `delete` runs, until it settles.
 * The case process reads both directly - the app's own account of the order is what is being measured.
 */
async function sampleDeleteOrder(
  registryPath: string, pageFolder: string, artifactId: string, settled: () => boolean, settleMs = ORDER_SETTLE_MS,
): Promise<OrderSample[]> {
  const samples: OrderSample[] = []
  const startedAt = Date.now()
  do {
    let text: string | null
    try {
      text = readFileSync(registryPath, 'utf8')
    } catch {
      text = null
    }
    samples.push({ row: registryRowPresent(text, artifactId), folder: existsSync(pageFolder) })
    await Bun.sleep(25)
  } while (!settled() || Date.now() - startedAt < settleMs)
  return samples
}

// ============================================================================
// The drive
// ============================================================================

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))
  const configDir = writableConfigDir(`${ID}'s pages, snapshot and grant script`)
  const ws = await activeWorkspaceId(session)
  const root = process.env.NESSY_CDP_RS117_WORKSPACE_ROOT?.trim() || join(configDir, 'workspaces', ws)
  if (!existsSync(root)) blocked(`the workspace root ${root} does not exist (set NESSY_CDP_RS117_WORKSPACE_ROOT)`)
  const registryPath = join(root, 'artifacts', 'registry.json')

  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const marker = `RS117-${stamp}`
  const fakeToken = fakeApiTokenValue()
  const scriptRel = `rs117-${stamp}/never-publish.ts`
  run.observe('the run marker and the fake token VALUE (assembled, obviously fake)', { marker, fakeToken })

  let main = ''
  let scriptPage = ''
  let mainFolder = ''
  /** Every artifact id this run created (the finally unpublishes any that outlived its arm). */
  const ownedIds = new Set<string>()
  try {
    // Two case-authored pages, through the app's own channels.
    const slugs = await session.call<{ main: string; script: string }>(`
      const a = await window.electronAPI.createPage(${JSON.stringify(ws)}, {
        name: ${JSON.stringify(`RS-117 publish ${stamp}`)}, kind: 'live', content: ${JSON.stringify(publishProbePageHtml(marker))},
      })
      const b = await window.electronAPI.createPage(${JSON.stringify(ws)}, {
        name: ${JSON.stringify(`RS-117 script ${stamp}`)}, kind: 'interactive',
        content: ${JSON.stringify('<html><head><meta charset="utf-8"><title>RS-117 script</title></head><body><h1>RS-117 script grant page</h1></body></html>')},
      })
      return { main: a.slug, script: b.slug }
    `)
    main = slugs.main
    scriptPage = slugs.script
    mkdirSync(join(root, `rs117-${stamp}`), { recursive: true })
    writeFileSync(join(root, scriptRel), grantScriptSource(), 'utf8')
    mainFolder = await session.call<string>(`
      const p = await window.electronAPI.getPage(${JSON.stringify(ws)}, ${JSON.stringify(main)})
      return p && p.folderPath ? p.folderPath : ''
    `)
    run.require('the main page exists with its folder on disk', mainFolder !== '' && existsSync(mainFolder), mainFolder)
    // The snapshot: the marker beside the FAKE apiToken key - planted before anything reads it.
    mkdirSync(join(mainFolder, 'data'), { recursive: true })
    writeFileSync(join(mainFolder, 'data', 'snapshot.json'), snapshotJson(marker, fakeToken), 'utf8')
    await installRelay(session)

    // ================= R - the review card, before anything is sent ==========
    const reviewOff = await reviewOf(session, ws, main, false)
    run.require('R: the no-data review answers a card', reviewOff !== null && reviewOff.review.ok === true,
      JSON.stringify(reviewOff?.review ?? reviewOff))
    const shaOff = reviewOff?.review.ok === true ? reviewOff.review.card.sha256 : null
    await openShareDialog(run, session, main, 'R')
    const hasCard = await waitFor(() => session.call<boolean>(`
      const roots = Array.from(document.querySelectorAll('[role="dialog"]'))
      const root = roots[roots.length - 1]
      return !!root && root.querySelector('[data-testid="artifact-publish-details"]') !== null
    `), value => value, { timeoutMs: REVIEW_MS, intervalMs: 300, label: 'R: the review card' }).catch(() => false)
    const textR = (await dialogText(session)) ?? ''
    const rScore = scoreReviewCard(textR, main, (shaOff ?? '').slice(0, 12))
    run.observe('R: the dialog', textR.slice(0, 600))
    run.check('R: Share on a live page WITH a snapshot shows the review card (names what will be sent)',
      hasCard && rScore.ok,
      !hasCard ? 'no [data-testid="artifact-publish-details"] inside the dialog' : rScore.detail)
    await closeDialog(session)

    // ================= P - publish WITHOUT data ==============================
    await openShareDialog(run, session, main, 'P')
    const pressed = await pressDialogButton(session, labels('pages.share.publish'), 'P: Publish')
    run.require('P: the dialog\'s Publish button was pressed', pressed === 'pressed', pressed)
    const firstRow = await settledPublication(session, ws, main, read => read !== null && read.pendingDelete !== true)
    run.require('P: the host reports the publication',
      firstRow !== null && firstRow.artifactId !== undefined && firstRow.url !== undefined, JSON.stringify(firstRow))
    const url = firstRow!.url!
    const contentUrl = contentUrlFor(url, firstRow!.artifactId!)
    ownedIds.add(firstRow!.artifactId!)
    run.check('P: the publication carries no data', firstRow!.includesData === false, `includesData ${JSON.stringify(firstRow!.includesData)}`)
    const retention = await patchRetention(session, ws, firstRow!.artifactId!, 1)
    run.observe('P: retention lowered to 1 day (the sitting\'s rule)', retention)
    run.check('P: the publication\'s retention is 1 day', retention.ok, retention.read)
    const shell = await fetchLink(url)
    run.observe('P: the /a/ shell as fetched (the deployed service serves a JS shell here)', { status: shell.status, contentType: shell.contentType, bytes: shell.body.length })
    const fetched = await fetchLink(contentUrl)
    const renders = scoreLinkRenders(fetched, marker)
    run.observe('P: the document endpoint as fetched', { url: contentUrl, status: fetched.status, contentType: fetched.contentType, bytes: fetched.body.length })
    run.check('P: the link renders (200 HTML with the page\'s marker)', renders.ok, renders.detail)
    const probeOff = await runPublishedCopy(session, fetched.body)
    const probeScore = scoreCopyProbe(probeOff, { marker: null })
    run.observe('P: the published copy\'s own report', probeOff)
    run.check('P: the copy\'s init carries a NULL snapshot and an action answers view-only', probeScore.ok, probeScore.detail)
    await closeDialog(session).catch(() => undefined)

    // ================= D - publish WITH data ==================================
    const reviewOn = await reviewOf(session, ws, main, true)
    run.require('D: the with-data review answers a card', reviewOn !== null && reviewOn.review.ok === true,
      JSON.stringify(reviewOn?.review ?? reviewOn))
    const shaOn = reviewOn?.review.ok === true ? reviewOn.review.card.sha256 : null
    const shaScore = shaChangesVerdict(shaOff, shaOn)
    run.check('D: the sha256 of what is sent changes when the data is included', shaScore.ok, shaScore.detail)
    run.check('D: the scan flags the planted FAKE apiToken key (by name, a warning)',
      reviewOn!.secretCandidates.includes('kv.apiToken'),
      `secretCandidates ${JSON.stringify(reviewOn!.secretCandidates)} (snapshotBytes ${JSON.stringify(reviewOn!.snapshotBytes)})`)

    await openShareDialog(run, session, main, 'D')
    const switchRect = await waitFor(() => dialogSwitch(session), value => value !== null, { timeoutMs: 10_000, intervalMs: 300, label: 'D: the include-data switch' })
      .catch(() => null)
    run.require('D: the include-data switch is offered (the page has a snapshot)', switchRect !== null, 'no [role="switch"] in the dialog')
    await clickAt(session, switchRect!, 'D: include-data switch')
    const warned = await waitFor(
      () => dialogText(session), text => text !== null && text.includes('kv.apiToken'), { timeoutMs: REVIEW_MS, intervalMs: 300, label: 'D: the warning' },
    ).catch(() => null)
    run.observe('D: the dialog after the switch', (warned ?? '').slice(0, 600))
    run.check('D: the amber warning names the fake apiToken key', warned !== null,
      warned === null ? 'no warning naming kv.apiToken after the switch' : 'read but no kv.apiToken in it')

    // The review-before-send invariant's negative arm: bytes that moved since the review are refused, nothing sent.
    const before = await publicationOf(session, ws, main)
    const drift = await publishThrough(run, session, ws, main, { includeData: true, reviewedSha256: shaOff! })
    const driftScore = driftRefusalVerdict(drift)
    const afterDrift = await publicationOf(session, ws, main)
    run.check('D: a publish reviewed against OTHER bytes is refused and nothing is sent',
      driftScore.ok && JSON.stringify(before) === JSON.stringify(afterDrift),
      `${driftScore.detail}; publication ${JSON.stringify(before)} → ${JSON.stringify(afterDrift)}`)

    const latest = await pressDialogButton(session, labels('pages.share.republish'), 'D: Publish latest')
    run.require('D: "Publish latest" was pressed', latest === 'pressed', latest)
    const updated = await settledPublication(session, ws, main, read => read !== null && read.url === url && read.includesData === true)
    run.check('D: "Publish latest" keeps the same link and the copy now carries the data',
      updated !== null && updated.url === url && updated.includesData === true,
      `publication ${JSON.stringify(updated)}; the first link was ${url}`)
    const retentionD = await patchRetention(session, ws, firstRow!.artifactId!, 1)
    run.observe('D: retention re-lowered to 1 day', retentionD)
    const fetchedD = await fetchLink(contentUrl)
    run.check('D: the served bytes carry the inlined snapshot element and the fake key\'s VALUE',
      fetchedD.status === 200 && fetchedD.body.includes('nessy-page-snapshot') && fetchedD.body.includes(fakeToken),
      `status ${fetchedD.status}; snapshot element ${fetchedD.body.includes('nessy-page-snapshot')}; fake value present ${fetchedD.body.includes(fakeToken)}`)
    const probeOn = await runPublishedCopy(session, fetchedD.body)
    const probeOnScore = scoreCopyProbe(probeOn, { marker })
    run.observe('D: the published copy\'s own report', probeOn)
    run.check('D: the copy\'s init answers the data marker and the action is still view-only', probeOnScore.ok, probeOnScore.detail)
    await closeDialog(session)

    // ================= U - unpublish ==========================================
    await openShareDialog(run, session, main, 'U')
    const first = await pressDialogButton(session, labels('pages.share.unpublish'), 'U: Unpublish (arm)')
    run.require('U: the Unpublish step was pressed', first === 'pressed', first)
    const confirmed = await pressDialogButton(session, labels('pages.share.unpublish'), 'U: Unpublish (confirm)')
    run.require('U: the destructive Unpublish was pressed', confirmed === 'pressed', confirmed)
    const gone = await settledPublication(session, ws, main, read => read === null)
    run.check('U: the host reports no publication after the dialog\'s Unpublish', gone === null, JSON.stringify(gone))
    const fetchedU = await fetchLink(contentUrl)
    const goneScore = scoreLinkGone(fetchedU.status)
    run.observe('U: the document endpoint after the unpublish', { status: fetchedU.status, bytes: fetchedU.body.length })
    run.check('U: the document endpoint answers 404 (the served bytes are gone)', goneScore.ok, goneScore.detail)
    const shellU = await fetchLink(url)
    run.observe('U: the /a/ shell after the unpublish', { status: shellU.status, bytes: shellU.body.length })
    await closeDialog(session).catch(() => undefined)

    // ================= X - publish again, then delete the page ================
    const reviewX = await reviewOf(session, ws, main, false)
    run.require('X: a fresh review answers a card', reviewX !== null && reviewX.review.ok === true, JSON.stringify(reviewX?.review ?? reviewX))
    const publishedX = await publishThrough(run, session, ws, main, {
      includeData: false, reviewedSha256: reviewX?.review.ok === true ? reviewX.review.card.sha256 : '',
    })
    run.require('X: the page is published again',
      publishedX !== null && (publishedX.status === 'published' || publishedX.status === 'updated'), JSON.stringify(publishedX))
    const rowX = await settledPublication(session, ws, main, read => read !== null && read.pendingDelete !== true)
    run.require('X: the new publication is readable', rowX !== null && rowX.artifactId !== undefined, JSON.stringify(rowX))
    const artifactX = rowX!.artifactId!
    const urlX = rowX!.url ?? publishedX!.url ?? ''
    ownedIds.add(artifactX)
    run.observe('X: the new row', { artifactId: artifactX, url: urlX, earlierLink: url })
    const retentionX = await patchRetention(session, ws, artifactX, 1)
    run.observe('X: retention lowered to 1 day', retentionX)

    // The delete confirmation names the published copy (the REAL dialog, cancelled - the delete itself follows).
    await navigateRoute(session, `pages/page/${main}`)
    const more = await waitFor(
      () => labelledRect(session, 'button[aria-label]', labels('common.more')),
      value => value !== null, { timeoutMs: 15_000, intervalMs: 400, label: 'X: the page\'s More menu' },
    ).catch(() => null)
    let deleteNoteSeen = false
    if (more !== null) {
      await clickAt(session, more, 'X: the page\'s More menu')
      const menuItem = await waitFor(
        () => labelledRect(session, '[role="menuitem"]', labels('pages.deletePage')),
        value => value !== null, { timeoutMs: 8_000, intervalMs: 250, label: 'X: the Delete Page item' },
      ).catch(() => null)
      if (menuItem !== null) {
        await clickAt(session, menuItem, 'X: Delete Page (menu item)')
        const confirmText = await waitForDialogText(session, 'X: the delete confirmation', 10_000).catch(() => '')
        deleteNoteSeen = labels('pages.deleteSharedNote').some(sentence => confirmText.includes(sentence))
        run.observe('X: the delete confirmation', confirmText.slice(0, 400))
        const cancel = await dialogButton(session, labels('common.cancel'))
        if (cancel !== null) await clickAt(session, cancel, 'X: Cancel')
        await closeDialog(session).catch(() => undefined)
      }
    }
    run.check('X: deleting a PUBLISHED page names that its copy is taken offline too', deleteNoteSeen,
      more === null ? 'the More menu was not reachable - the page view did not come up' : 'the confirmation lacks the published-copy note')

    // The delete itself, with the order sampler running beside it.
    let deleteDone = false
    const sampler = sampleDeleteOrder(registryPath, mainFolder, artifactX, () => deleteDone)
    const deleted = await session.call<{ publicCopyMayRemain?: boolean; error?: string }>(`
      try { return await window.electronAPI.deletePage(${JSON.stringify(ws)}, ${JSON.stringify(main)}) }
      catch (e) { return { error: String((e && (e.code || e.message)) || e).slice(0, 200) } }
    `).catch((error: unknown): { publicCopyMayRemain?: boolean; error?: string } => ({ error: String(error).slice(0, 200) }))
    deleteDone = true
    const samples = await sampler
    let registryFinal: string | null
    try {
      registryFinal = readFileSync(registryPath, 'utf8')
    } catch {
      registryFinal = null
    }
    const orderScore = scoreDeleteOrder(samples)
    const pageStillThere = await session.call<boolean>(
      `return (await window.electronAPI.getPage(${JSON.stringify(ws)}, ${JSON.stringify(main)})) !== null`,
    ).catch(() => true)
    run.observe('X: the delete and its order samples', {
      deleted,
      samples: samples.length,
      sawRowGoneFolderPresent: samples.some(sample => sample.row === false && sample.folder === true),
      sawFolderGoneRowLive: samples.some(sample => sample.row === true && sample.folder === false),
      rowPresentAfter: registryRowPresent(registryFinal, artifactX),
      registryMentionsId: registryFinal !== null && registryFinal.includes(artifactX),
      pageAfter: pageStillThere,
    })
    run.check('X: the service copy is deleted FIRST (never the folder before it)', orderScore.ok, orderScore.detail)
    run.check('X: the registry\'s delete-pending path is not taken (no row survives, nothing owed)',
      deleted.error === undefined && deleted.publicCopyMayRemain === false
        && registryRowPresent(registryFinal, artifactX) === false
        && !(registryFinal ?? '').includes(artifactX),
      `delete answered ${JSON.stringify(deleted)}; rowPresentAfter ${JSON.stringify(registryRowPresent(registryFinal, artifactX))}`)
    const fetchedX = await fetchLink(urlX === '' ? '' : contentUrlFor(urlX, artifactX))
    const goneX = scoreLinkGone(fetchedX.status)
    run.check('X: the deleted page\'s link answers 404', goneX.ok, `${goneX.detail} (url ${urlX || 'unread'})`)

    // ================= S - a script grant blocks publishing ===================
    const grantAction = { kind: 'script', script: scriptRel }
    const described = await session.call<{ scriptSha256?: string; error?: string }>(`
      try {
        const d = await window.electronAPI.describePageGrantRequest(${JSON.stringify(ws)}, ${JSON.stringify(scriptPage)}, ${JSON.stringify(grantAction)})
        return { scriptSha256: d.scriptSha256 }
      } catch (e) { return { error: String((e && (e.code || e.message)) || e).slice(0, 200) } }
    `)
    run.require('S: the host describes the script grant (its pinned sha256)', described.scriptSha256 !== undefined, JSON.stringify(described))
    const digest = await session.call<string>(`
      return (await window.electronAPI.getPageContent(${JSON.stringify(ws)}, ${JSON.stringify(scriptPage)})).contentDigest
    `)
    run.require('S: the page\'s content digest is readable', typeof digest === 'string' && digest.length > 0, JSON.stringify(digest))
    const grantId = await session.call<string>(`
      try {
        const g = await window.electronAPI.issuePageGrant(${JSON.stringify(ws)}, ${JSON.stringify(scriptPage)}, {
          action: ${JSON.stringify(grantAction)}, contentDigest: digest, scriptSha256: ${JSON.stringify(described.scriptSha256)},
          description: 'RS-117: the grant whose only purpose is to be refused',
        })
        return g.id
      } catch (e) { return 'failed: ' + String((e && (e.code || e.message)) || e).slice(0, 200) }
    `)
    run.require('S: the script grant is issued to the ledger', !grantId.startsWith('failed:'), grantId)
    const refusedReview = await reviewOf(session, ws, scriptPage, false)
    await openShareDialog(run, session, scriptPage, 'S')
    const blockedText = await waitFor(
      () => dialogText(session),
      text => text !== null && labels('pages.share.scriptBlockedTitle').some(sentence => text.includes(sentence)),
      { timeoutMs: REVIEW_MS, intervalMs: 300, label: 'S: the script-approval block' },
    ).catch(() => null)
    const publishDisabled = await dialogButtonDisabled(session, labels('pages.share.publish'))
    const sScore = scoreScriptBlocked({
      blockShown: blockedText !== null,
      publishDisabled,
      reviewCode: refusedReview !== null && !refusedReview.review.ok ? refusedReview.review.code : undefined,
    })
    run.observe('S: the dialog and the review', {
      dialog: (blockedText ?? (await dialogText(session)) ?? '').slice(0, 500),
      publishDisabled,
      review: refusedReview === null ? null : refusedReview.review,
    })
    run.check('S: a page with a script grant shows the red block and Publish stays disabled', sScore.ok, sScore.detail)
    await closeDialog(session)

    // The control: revoking the grant restores a passing review.
    const revoked = await session.call<boolean>(`
      try { return await window.electronAPI.revokePageGrant(${JSON.stringify(ws)}, ${JSON.stringify(scriptPage)}, ${JSON.stringify(grantId)}) }
      catch { return false }
    `)
    const reviewAfterRevoke = await reviewOf(session, ws, scriptPage, false)
    run.check('S: revoking the grant restores a passing review (the control)',
      revoked && reviewAfterRevoke !== null && reviewAfterRevoke.review.ok === true,
      `revoked ${revoked}; review ${JSON.stringify(reviewAfterRevoke?.review ?? null)}`)
  } finally {
    const cleanup: Record<string, unknown> = {}
    for (const slug of [main, scriptPage]) {
      if (!slug) continue
      const stillThere = await session.call<boolean>(
        `return (await window.electronAPI.getPage(${JSON.stringify(ws)}, ${JSON.stringify(slug)})) !== null`,
      ).catch(() => true)
      if (!stillThere) {
        cleanup[slug] = 'already-gone'
        continue
      }
      const read = await publicationOf(session, ws, slug).catch(() => null)
      if (read !== null && read.artifactId !== undefined) {
        cleanup[`${slug}:unpublish`] = await unpublishThrough(session, ws, slug)
          .catch(error => ({ outcome: 'threw', message: String(error).slice(0, 160) }))
      }
      cleanup[`${slug}:delete`] = await session.call<string>(`
        try { await window.electronAPI.deletePage(${JSON.stringify(ws)}, ${JSON.stringify(slug)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    rmSync(join(root, `rs117-${stamp}`), { recursive: true, force: true })
    let registryEnd: string | null
    try {
      registryEnd = readFileSync(registryPath, 'utf8')
    } catch {
      registryEnd = null
    }
    cleanup.scriptDirRemoved = !existsSync(join(root, `rs117-${stamp}`))
    cleanup.registryStillMentions = registryEnd === null
      ? 'registry-unreadable'
      : [...ownedIds].filter(id => registryEnd.includes(id))
    run.observe('cleanup (every artifact id deleted, pages and script removed)', cleanup)
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
