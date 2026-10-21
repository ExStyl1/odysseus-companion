/**
 * Page frame CSP builder — the ONLY producer of a Page's `srcdoc` (UA7.1).
 *
 * Ours, not a copy: upstream craft-agents v0.13.4 renders the page bytes
 * as-is (`v0.13.4:apps/electron/src/renderer/components/pages/PageFrame.tsx`
 * passes `srcDoc={content}`; `v0.13.4:apps/electron/src/main/page-thumbnail-host.ts`
 * escapes them into a `srcdoc` attribute). Spec
 * `docs/superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md`
 * §14 records why that is not enough here:
 *
 * - A `srcdoc` document INHERITS the embedder's CSP. Ours
 *   (`apps/electron/src/renderer/index.html`) allows `connect-src 'self' https: wss:`
 *   plus `http`/`ws` on `localhost:*` and `127.0.0.1:*`, and `img-src … https: file:`.
 *   Page script could exfiltrate by `fetch`, `WebSocket` or `<img>`, reach host
 *   loopback services, and use a `file:` image as an existence oracle.
 * - CSP policies only ever INTERSECT: a document enforces every policy it
 *   carries. So a policy injected into the page's own document narrows the
 *   inherited one, and nothing a page adds afterwards — its own CSP `<meta>`
 *   included — can widen it back.
 *
 * Shape of the output, in this order (the order is the contract):
 *   1. `<!doctype html>` FIRST, so the page renders in standards mode even when
 *      the agent forgot its own doctype (a later doctype is a parse error the
 *      HTML parser ignores). UA7.6's sitting case reads `document.compatMode`.
 *   2. the CSP `<meta http-equiv>`; the parser opens `<head>` implicitly for it,
 *      so it is in force before a single page byte is parsed.
 *   3. for script-capable kinds, one inline script that deletes the WebRTC
 *      constructors (spec §14 "WebRTC": defence in depth — WebRTC is not governed
 *      by `connect-src`). It is part of the builder because the builder is the
 *      one place every render site goes through (PageFrame, UA7.3; the
 *      thumbnail host, UA7.4).
 *   4. the page bytes, unchanged. The lease digest is computed over the page
 *      bytes, never over this wrapper, so it does not move.
 *
 * The policy carries NO loopback token (`localhost`, `127.0.0.1`) and no scheme
 * source (`https:`, `wss:`, `file:`) — `page-frame-csp.test.ts` pins both.
 * `static` pages get `script-src 'none'` (their frame is also `sandbox=""`).
 *
 * A guard in the same test fails if a Pages render site sets `srcdoc` without
 * calling {@link buildPageSrcdoc}.
 */

import type { PageKind } from '@nessy-agent/shared/pages/types'

/** The directives after `script-src`, identical for every kind (spec §14 "Builder"). */
const COMMON_DIRECTIVES: readonly string[] = [
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
]

/** The CSP a rendered Page document enforces, by kind. */
export function buildPageFrameCsp(kind: PageKind): string {
  const scriptSrc = kind === 'static' ? "script-src 'none'" : "script-src 'unsafe-inline'"
  return ["default-src 'none'", scriptSrc, ...COMMON_DIRECTIVES].join('; ')
}

/**
 * The WebRTC constructors removed before any page script runs. A page could
 * still reach a fresh realm's copy in theory; this is defence in depth beside
 * the CSP, not a boundary (spec §14).
 */
const WEBRTC_CONSTRUCTORS: readonly string[] = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCSessionDescription',
  'RTCIceCandidate',
]

const WEBRTC_REMOVAL_SCRIPT =
  '<script>(function(){var n=' +
  JSON.stringify(WEBRTC_CONSTRUCTORS) +
  ';for(var i=0;i<n.length;i++){try{delete window[n[i]];}catch(e){}}})();</script>'

/**
 * The `srcdoc` for a Page frame: doctype, then the CSP meta, then (script-capable
 * kinds) the WebRTC removal, then the page bytes unchanged.
 */
export function buildPageSrcdoc(content: string, kind: PageKind): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${buildPageFrameCsp(kind)}">`
  const prelude = kind === 'static' ? '' : WEBRTC_REMOVAL_SCRIPT
  return `<!doctype html>${meta}${prelude}${content}`
}

/**
 * UA12.31 — the `name` attribute every Page iframe carries (PageFrame.tsx; the
 * thumbnail poster's frame stays nameless on purpose — its window denies every
 * navigation already). The `will-frame-navigate` guard reads it off
 * `WebFrameMain.name`: a Page's denied self-navigations stay cancelled silently
 * (its link-outs belong to the bridge's confirmed `open-url`). UA12.170: the
 * page's own script can rewrite `window.name`, so the name only buys SILENCE —
 * every other frame's http(s) link-out waits for the user's confirm instead.
 */
export const PAGE_IFRAME_NAME = 'nessy-page'
