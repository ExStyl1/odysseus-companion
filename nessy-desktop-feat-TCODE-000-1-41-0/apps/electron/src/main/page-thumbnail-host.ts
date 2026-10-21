/**
 * Pure helpers for page thumbnail capture — NO electron runtime imports, so this is
 * unit-testable under bun. The Electron capture itself lives in
 * page-thumbnailer.ts and consumes these.
 *
 * The capture renders the page exactly as PageFrame does: the page HTML is the
 * srcdoc of an opaque sandboxed iframe (never `allow-same-origin`), and the
 * trusted host posts the `nessy-pages/v1` init message so data-driven pages
 * paint with their snapshot. No action bridge — a poster never executes source
 * actions.
 *
 * UA7.4 — copied from craft-agents-oss `v0.13.4:apps/electron/src/main/page-thumbnail-host.ts` (Apache-2.0),
 * rebranded (`craft-pages/v1` → `nessy-pages/v1`, `@craft-agent` → `@nessy-agent`) and hardened (spec
 * `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md` §14 "Thumbnailer", threat S4;
 * upstream has no host CSP and escapes only `</script>`):
 * - the srcdoc comes from the frame builder (`shared/page-frame-csp.ts`, UA7.1): doctype first, then the frame CSP,
 *   then the page bytes — the same document PageFrame renders;
 * - the init message is the bridge's own (`buildPageInitMessage`), serialised with EVERY `<` written as JSON's
 *   `<`, so neither `</script>` nor `<!--` (the script-data escape states) survives into the host document;
 * - the host document carries a CSP (`buildThumbnailHostCsp`). DECISION (UA7.4, measured): a srcdoc document
 *   INHERITS its embedder's CSP, so the host policy also binds the page. On Electron 39.8.10 (probe
 *   `work/ua-ak/probe-inherit.cjs`, 2026-10-02) a page's inline script ran under a host `script-src
 *   'unsafe-inline'` and did NOT run under a host `script-src 'sha256-…'`, nor under `'sha256-…' 'unsafe-inline'`
 *   (a hash switches `'unsafe-inline'` off). So the spec's "the host CSP allows only its own script, by sha256
 *   hash" holds for `static` pages (whose frame forbids scripts anyway: the host script is the only script the
 *   window can run), while for `interactive` and `live` the host policy IS the frame's own policy — a hash there
 *   would blank every script-drawn poster. The script-injection control for those kinds is the escaping above;
 *   network, windows and navigation are closed by the window (page-thumbnailer.ts) whatever the kind.
 * - the partition and navigation predicates the window applies live here, beside the document they protect.
 */

import { createHash } from 'node:crypto'
import type { PageDataSnapshot, PageKind } from '@nessy-agent/shared/pages/types'
import { buildPageInitMessage } from '../shared/page-bridge'
import { buildPageFrameCsp, buildPageSrcdoc } from '../shared/page-frame-csp'
import { isDeniedFrameNavigation } from './frame-navigation-guard'

/** Logical render viewport (16:10) the offscreen window uses. */
export const THUMB_LOGICAL_WIDTH = 1000
export const THUMB_LOGICAL_HEIGHT = 625
/** Stored poster width (height derived 16:10); keeps some retina crispness. */
export const THUMB_OUTPUT_WIDTH = 800
export const THUMB_OUTPUT_HEIGHT = 500
/** JPEG quality for the stored poster. */
export const THUMB_JPEG_QUALITY = 82

/**
 * UA7.4 — the capture window's session partition. The NAME lives in the registry
 * (`./session-partitions`, the one place a partition name is written down, re-exported here
 * for this module's importers): in-memory (no `persist:` prefix, so nothing it caches
 * outlives the process) and separate from every renderer window's, so its request filter
 * binds the thumbnail window alone.
 */
export { PAGE_THUMBNAIL_PARTITION } from './session-partitions'

/** UA7.4 — the only URL schemes the capture window may request: its own documents, never the network or disk. */
const ALLOWED_REQUEST_SCHEMES = new Set(['data:', 'blob:', 'about:'])

/** UA7.4 — true when the thumbnail partition lets a request through (`data:`, `blob:`, `about:` only). */
export function isThumbnailRequestAllowed(url: string): boolean {
  try {
    return ALLOWED_REQUEST_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * UA7.4 — true when a navigation in the capture window must be cancelled: EVERY main-frame navigation (the host
 * document is loaded programmatically, which raises neither event), and every subframe navigation that is not the
 * frame's own inline document (the UA7.2 rule, `frame-navigation-guard.ts`).
 */
export function isDeniedThumbnailNavigation(details: { isMainFrame: boolean; url: string }): boolean {
  return details.isMainFrame || isDeniedFrameNavigation(details)
}

/** Same sandbox rule as PageFrame: static = inert, interactive/live = scripts+forms, never same-origin. */
export function sandboxForKind(kind: PageKind): string {
  return kind === 'static' ? '' : 'allow-scripts allow-forms'
}

/** Escape a string for safe embedding inside a double-quoted HTML attribute (srcdoc). */
export function escapeSrcdocAttribute(html: string): string {
  return html
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * UA7.4 — the host document's CSP for a page of `kind` whose one host script is `hostScript` (see the module
 * header for why it is per kind): the frame's own policy, with `script-src` narrowed to the host script's sha256
 * where the frame forbids scripts.
 */
export function buildThumbnailHostCsp(kind: PageKind, hostScript: string): string {
  const framePolicy = buildPageFrameCsp(kind)
  if (kind !== 'static') return framePolicy
  const hash = createHash('sha256').update(hostScript, 'utf8').digest('base64')
  return framePolicy.replace("script-src 'none'", `script-src 'sha256-${hash}'`)
}

/**
 * Build the trusted host document loaded into the offscreen window. It embeds
 * the page content in a sandboxed iframe and delivers the data snapshot once
 * via the same bridge PageFrame uses. Returns a full HTML string; the caller
 * loads it with `loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))`.
 */
export function buildThumbnailHostHtml(input: {
  content: string
  slug: string
  kind: PageKind
  snapshot: PageDataSnapshot | null
}): string {
  const sandbox = sandboxForKind(input.kind)
  const srcdoc = escapeSrcdocAttribute(buildPageSrcdoc(input.content, input.kind))
  // JSON embedded in a script: every `<` becomes `<`, so no `</script>` or `<!--` reaches the HTML parser.
  const init = JSON.stringify(buildPageInitMessage({ slug: input.slug, kind: input.kind }, 'preview', input.snapshot))
    .replace(/</g, '\\u003c')
  const script = `
  var INIT = ${init};
  var frame = document.getElementById('frame');
  function deliver() {
    try {
      frame.contentWindow.postMessage(INIT, '*');
    } catch (e) { /* opaque-origin race — the ready handler retries */ }
  }
  frame.addEventListener('load', deliver);
  window.addEventListener('message', function (event) {
    var m = event.data;
    if (m && m.protocol === INIT.protocol && m.type === 'ready') deliver();
  });
`
  const csp = buildThumbnailHostCsp(input.kind, script)

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { margin: 0; padding: 0; width: ${THUMB_LOGICAL_WIDTH}px; height: ${THUMB_LOGICAL_HEIGHT}px; overflow: hidden; background: #ffffff; }
  iframe { border: 0; width: 100%; height: 100%; display: block; background: #ffffff; }
</style>
</head>
<body>
<iframe id="frame" sandbox="${sandbox}" referrerpolicy="no-referrer" srcdoc="${srcdoc}"></iframe>
<script>${script}</script>
</body>
</html>`
}
