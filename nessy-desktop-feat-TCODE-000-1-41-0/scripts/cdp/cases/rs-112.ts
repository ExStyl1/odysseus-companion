/**
 * RS-112 (plan row UA7.6, 1.42.0 upstream adoption) - the Pages 6+7 unit on the
 * shipped build: the six page tools on Pi, Claude Code and Codex, a live page
 * updating while it is open, the one-shot delete card under bypass, and the
 * frame's egress matrix, each probe recorded as BLOCKED or LEAKING beside an
 * out-of-page control. A leak holds the 6+7 unit out of the release and is never
 * recorded as KNOWN (plan UA7.6, UA11.1).
 *
 * ## What it proves
 *
 * Per runtime selected (`NESSY_CDP_RS112_RUNTIMES`, default `pi,claude,codex`),
 * in one fresh session on that runtime's card, in the harness default
 * `bypassPermissions` (read back):
 *
 * A.  **Create and write.** The agent calls `create_page` (kind `live`, a name
 *     unique to the run) and then `write_page_data` (`summary.total` = 42, three
 *     `ci.duration_ms` points). The HOST's record answers: `getPages` lists the
 *     page as `live`, `getPageData` carries the total and three points.
 * B.  **Update.** The agent calls `update_page` with a description unique to the
 *     run; `getPage` reads it back.
 * C.  **A live page updates.** The case's own live page L (below) is OPEN in the
 *     Pages view, a turn is started without the composer
 *     (`electronAPI.sendMessage`), and the agent writes `summary.total` = n to L.
 *     L's frame reports n through `postMessage` WITHOUT reloading: no new `hello`
 *     from L and the same `<iframe>` element (a mark set on it before the turn
 *     survives). On codex this is the bridged `/page/data` route (UA6.3).
 * D.  **The delete card under bypass** (UA6.2). Asked to delete A's page, the
 *     agent's `delete_page` raises ONE card naming the page and offering no
 *     Always Allow (every card of the turn is counted, each answered alike); Deny leaves the page (`getPage` non-null) and the tool says
 *     `was declined; the page is unchanged`; asked again, Allow removes it.
 *
 * Once per run, on case-authored pages created through the app's own
 * `pages:create` channel:
 *
 * F.  **The frame egress matrix** (page F, kind `interactive`, NO doctype of its
 *     own). After a real click inside the frame, the page runs one probe per row
 *     of the plan: https `fetch`, `wss:` WebSocket, an https `<img>` beacon, a
 *     form POST, a `file:` image, `fetch` and `ws` to loopback, `window.open`,
 *     STUN (`RTCPeerConnection`, from F's own realm AND from a fresh realm - a
 *     no-src child `<iframe>`, see {@link scoreStunProbe}), `dns-prefetch` and
 *     `preconnect` hints, and finally self-navigation. Each network probe targets
 *     its OWN case-owned raw TCP port on 127.0.0.1 (each STUN realm its own UDP
 *     port), so any connection, of any protocol, is attributed to exactly one probe. Also from F: `compatMode` is
 *     `CSS1Compat` (the builder's doctype, UA7.1), and `open-url` shows the
 *     confirmation with the FULL URL and Cancel opens nothing (OQ-12, UA7.3).
 * R.  **A renamed frame is never opened silently** (page R, kind `interactive`,
 *     UA12.170). After a real click, R's script sets `window.name` (the frame
 *     then reports the new name to the main process - measured 2026-10-08, the
 *     audit probe on Electron 39.8.10) and self-navigates to its own case port
 *     with data in the query. 58aa92509 (UA12.31) handed such a navigation to
 *     `shell.openExternal` with no dialog, and the system browser connecting to
 *     the port is the leak. Scored as F's self-navigation
 *     ({@link selfNavigationEvidence}): BLOCKED needs the port silent AND the
 *     frame surviving (the guard's cancel) or the embedder's `frame-src`
 *     refusing it. The UA12.170 build shows a NATIVE "Open link?" box instead
 *     (the case cannot see or answer a native sheet): the operator presses
 *     Cancel and records that the box appeared and showed the full URL.
 * T.  **The thumbnail makes no network request** (page T, probes on LOAD, never
 *     opened in a view). Its creation enqueues a poster capture (UA7.4); the
 *     poster carrying EVERY probe's issued mark (UA12.116, the poster-mark
 *     technique of UA12.106: one band per probe, painted the moment the probe
 *     issues) is the positive that the capture demonstrably ran T's bytes - a
 *     probe whose mark is missing is UNMEASURED, never a pass - and none of T's
 *     ports may see a connection: an https `<img>`, `fetch`, `WebSocket`,
 *     `window.open`, a meta refresh, a `location` assignment and a `preconnect`
 *     hint. Every probe must fire inside the
 *     capture window's lifetime: the thumbnailer destroys it right after the
 *     first non-empty capture, RENDER_SETTLE_MS (550 ms) after the host load, so
 *     the two navigations are scheduled at 0 and 100 ms (pinned in the test).
 *     STUN runs on its OWN page TS (UA12.106), never beside those navigations:
 *     they can replace T's document before its STUN sends anything, and the
 *     capture window cannot post out, so a silent port there proved nothing. TS
 *     probes from its realm AND a fresh realm (each its own UDP port, beside the
 *     main world's STUN control - the same builder output renders there) and
 *     paints each realm's outcome into its own half of the page, so the poster
 *     carries the probe's in-page "attempted" mark ({@link thumbStunPageHtml},
 *     {@link classifyStunMark}, {@link scoreThumbnailStun}). No mark is UNMEASURED.
 *
 * ## The detectors, and why each is the one it is
 *
 * - **A leak is a connection on a probe's own port** (`Bun.listen`, raw TCP, so
 *   https and wss count at the ClientHello, a preconnect at the bare socket).
 *   That is hard evidence, never inferred. **A block** needs the port silent AND
 *   in-page evidence of the block: a `securitypolicyviolation` event naming the
 *   probe (CSP, UA7.1), or the API being refused (`window.open` returns null without
 *   `allow-popups`; a self-navigation that the frame survives, or that the
 *   EMBEDDER's `frame-src` refused - {@link selfNavigationEvidence}). A silent port
 *   with no such evidence is UNMEASURED and FAILS - "nothing arrived" alone
 *   cannot tell a block from a listener nobody could reach.
 *   ({@link scoreEgressProbe}, pinned by `scripts/cdp/rs-112-pages-score.test.ts`.)
 * - **The out-of-page control** for every port: the case process connects to
 *   it (the listener is alive) and the app's own MAIN world `fetch`es a control
 *   port (the app origin's CSP allows `127.0.0.1:*`, so the browser itself can
 *   reach loopback here). Without both, a silent probe proves nothing.
 * - **In-page readings travel by `postMessage`** to a listener the case installs
 *   in the main world before the page opens, accepted only from that page's own
 *   `<iframe>`'s `contentWindow`. The PageFrame bridge ignores the foreign
 *   protocol (`rs112-probe`), so this adds no kind to `nessy-pages/v1`.
 * - **STUN** is not governed by `connect-src`; the builder deletes the WebRTC
 *   constructors from F's realm, which its own header calls "defence in depth
 *   ..., not a boundary" (`apps/electron/src/shared/page-frame-csp.ts`). A no-src
 *   child `<iframe>` is about:blank in F's opaque origin and never runs that
 *   script, so F reads its `RTCPeerConnection` too. BLOCKED needs both realms
 *   absent/refused over silent ports, or a constructed connection whose port
 *   stays silent beside the main world's identical connection to a control UDP
 *   port that DID arrive (Chromium sends STUN to loopback here); otherwise
 *   UNMEASURED ({@link scoreStunProbe}).
 * - **`file:` image**: no port exists, so `onload` is the leak (an existence
 *   oracle) and a violation event the block.
 * - **`preconnect`**: CSP does not govern resource hints, so no violation can
 *   name it. Its block is read beside the same hint from the app's own document
 *   to a control port: that one connecting and the page's port staying silent is
 *   the block; both silent is unmeasured (the mechanism never fired here).
 * - **`dns-prefetch`** asks a resolver, not a socket. Measured only when the
 *   operator records DNS for the run (`sudo tcpdump -l -n -i any udp port 53 >
 *   <file>`, the file named by `NESSY_CDP_RS112_DNS_CAPTURE`): the probe host in
 *   the capture is a leak; absent, with the SAME hint from the app's own document
 *   to a control host present (Chromium's prefetch demonstrably fires here; a
 *   lookup by the case process would prove the capture, not the mechanism), a
 *   block. Otherwise it FAILS as unmeasured - see `work/wi16/
 *   QUESTIONS.md` (UA-ao, UA7.6) for the residue question. The probe hosts are
 *   `.invalid` (RFC 2606): nothing is ever sent to a real service.
 * - **Tools and the card**: the host's records (`getPages`, `getPage`,
 *   `getPageData`), the turn's own tool rows (`turnRowsSince`), and the card as
 *   `lib/permission-card.ts` reads it - never the model's prose.
 *
 * ## Stated residues
 *
 * - "The loopback adapter" is the per-session Claude adapter's port, which the
 *   renderer cannot discover; the loopback probes aim at a case-owned 127.0.0.1
 *   port instead. The frame policy has no loopback token and no scheme source at
 *   all, so the decision under test is the same for every loopback port.
 * - "https" probes aim at 127.0.0.1 rather than a remote host (no real service);
 *   a connection there is still the https request leaving the frame.
 * - Spec section 23 lists "whether the loopback adapter authenticates inbound
 *   requests" as UNVERIFIED on this row. Not measured here (driving the adapter
 *   would send a turn to the real gateway). Read from the source on 2026-10-02:
 *   `packages/codex-responses-adapter/src/server.ts` `startAdapter` routes
 *   `POST .../responses` and `POST .../messages` with no inbound credential,
 *   `Origin`, `Host` or content-type check. For a Page this is moot only while
 *   the loopback probes above are BLOCKED; the residue is in
 *   `work/wi16/QUESTIONS.md` (UA-ao, UA7.6, adapter).
 *
 * ## Not automated - the sitting runs these by hand
 *
 * The brief's sitting ASKs from UA6.2/6.3/6.5/7.3/7.4 that RS-112 does not drive:
 * delete_page in `dontAsk` (no card, "was not deleted") and the 110 s card
 * timeout; the tool rows reading Create Page / Write Page Data; codex with the
 * bridge absent and the runtime-switch cost text; the `pages.md` guidance; the
 * sidebar placement, menu entries and deep links; `open-url` refused for
 * `file:`/`javascript:` and from a timer after a host-toolbar click; `update_page`
 * recapturing the poster while `write_page_data` does not; a `for(;;)` page not
 * hanging the thumbnailer.
 *
 * ## What it writes
 *
 * Pages under the active workspace (A's page per runtime, L, F, R, T), deleted in
 * the `finally` through `pages:delete` (the user's own delete - no card); one
 * session per runtime, deleted in the `finally`; `window.electronAPI.openUrl` is
 * shadowed only for the open-url arm and restored at once. No file is written
 * outside the app's own stores.
 */

import { existsSync, readFileSync } from 'node:fs'

import { sendPrompt } from '../lib/chat.ts'
import { focusWindow, type CdpSession } from '../lib/connect.ts'
import { ensureDarkTheme } from '../lib/mcp-fixture.ts'
import { ensureNoCard, pressCard, readCard, type CardRead } from '../lib/permission-card.ts'
import { BlockedError, blocked, main, type CaseRun } from '../lib/report.ts'
import { buttonTextInPage, CANCEL_BUTTON_TEXTS, listConnections, runtimeOf, switchRuntime, waitForConnection } from '../lib/runtime-switch.ts'
import {
  assertElectronApi, freshSession, transcript, turnBaseline, waitFor, waitForTurn, type SessionKey, type TranscriptMessage,
} from '../lib/state.ts'
import { turnCalledTool, turnReply, turnRowsSince } from '../lib/turn-evidence.ts'
import { clickAt } from '../lib/viewport.ts'
import type { CaseMeta, SittingRuntime } from '../lib/sitting.ts'

const ID = 'RS-112'
const TITLE = 'Pages 6+7: page tools on three runtimes, a live update, the delete card under bypass, and the frame and thumbnail egress matrix'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UA7.6',
  runtimes: ['pi', 'claude', 'codex'],
  credentials:
    'owner: one card per runtime that answers a turn (a `pi` card, a `claude-runtime` card, a `codex-runtime` card with '
    + 'its host-callback bridge up), already signed in; the card is named in the run notes. No key, token or credential '
    + 'file is read. Optional: a DNS capture file for the dns-prefetch probe (NESSY_CDP_RS112_DNS_CAPTURE).',
} as const satisfies CaseMeta

const RUNTIME_WANTED = (process.env.NESSY_CDP_RS112_RUNTIMES ?? 'pi,claude,codex')
  .split(',').map(name => name.trim()).filter(Boolean)

/** One turn's own budget; a cold codex spawn is the long one. */
const TURN_MS = 240_000
/** How long a silent port must stay silent after its probe ran. */
const SETTLE_MS = 6_000
/** The thumbnailer's own capture ceiling is 15 s (UA7.4); T waits past it. */
const THUMB_WAIT_MS = 25_000
const PROBE_PROTOCOL = 'rs112-probe'
const DNS_PROBE_HOST = 'rs112-dns-prefetch.egress-probe.invalid'
const DNS_CONTROL_HOST = 'rs112-dns-control.egress-probe.invalid'
const OPEN_URL = 'https://rs112-open-url.egress-probe.invalid/a/long/path/that-must-show-in-full?q=rs-112&n=1#frag'

// ============================================================================
// Scoring (pure; pinned by scripts/cdp/rs-112-pages-score.test.ts)
// ============================================================================

export type EgressVerdict = 'blocked' | 'leaking' | 'unmeasured'

export interface EgressEvidence {
  /** Connections the probe's own port saw (null: the probe has no port). */
  hits: number | null
  /** A `securitypolicyviolation` event in the page named this probe. */
  violation: boolean
  /** In-page evidence of a block other than CSP (absent API, refused open, the frame survived). */
  refusedInPage: boolean
  /** In-page evidence of a leak with no port (a `file:` image that LOADED). */
  loadedInPage: boolean
}

/**
 * One probe's verdict. A connection is a leak whatever the page said; a block
 * needs a silent port AND the page's own evidence of a block; anything else is
 * unmeasured, never a pass.
 */
export function scoreEgressProbe(evidence: EgressEvidence): { verdict: EgressVerdict; detail: string } {
  if ((evidence.hits ?? 0) > 0) return { verdict: 'leaking', detail: `${evidence.hits} connection(s) reached the probe's own port` }
  if (evidence.loadedInPage) return { verdict: 'leaking', detail: 'the resource loaded inside the page' }
  if (evidence.violation) return { verdict: 'blocked', detail: 'a securitypolicyviolation named the probe and its port stayed silent' }
  if (evidence.refusedInPage) return { verdict: 'blocked', detail: 'the page reported the API absent or refused, and its port stayed silent' }
  return {
    verdict: 'unmeasured',
    detail: 'UNMEASURED - the port stayed silent but the page shows no block (no violation, no refusal): a silent port '
      + 'alone cannot tell a block from a request that never left for another reason',
  }
}

export interface StunRealmRead {
  /** What the page noted: 'absent', 'constructed', 'threw: ...', or undefined when it never reported. */
  outcome: string | undefined
  /** Datagrams on this realm's own UDP port. */
  hits: number
}

/**
 * STUN, read across F's own realm (the builder deleted its constructors) and a fresh realm (a no-src child
 * `<iframe>`, which the builder's script never reaches). Any datagram on either port is a leak. A block needs both
 * realms absent or refused over silent ports - or, where a realm constructed a connection, its silent port beside the
 * main world's identical connection to a control port that DID receive STUN (`controlHits` > 0: Chromium sends STUN to
 * loopback here). A constructed connection with no live control, or a realm that never reported, is unmeasured.
 */
export function scoreStunProbe(evidence: { top: StunRealmRead; realm: StunRealmRead; controlHits: number | null }): { verdict: EgressVerdict; detail: string } {
  const { top, realm, controlHits } = evidence
  if (top.hits > 0 || realm.hits > 0) {
    return { verdict: 'leaking', detail: `STUN datagrams reached the probe ports (F's realm ${top.hits}, fresh realm ${realm.hits})` }
  }
  const state = (outcome: string | undefined) => outcome === 'absent' || (outcome ?? '').startsWith('threw') ? 'refused'
    : outcome === 'constructed' ? 'constructed' : 'unknown'
  const states = [state(top.outcome), state(realm.outcome)]
  const said = `F's realm ${JSON.stringify(top.outcome ?? null)}, fresh realm ${JSON.stringify(realm.outcome ?? null)}`
  if (states.includes('unknown')) return { verdict: 'unmeasured', detail: `UNMEASURED - a realm never reported its STUN probe (${said})` }
  if (states.every(s => s === 'refused')) return { verdict: 'blocked', detail: `both realms lack or refuse RTCPeerConnection and both ports stayed silent (${said})` }
  if ((controlHits ?? 0) > 0) {
    return { verdict: 'blocked', detail: `a connection was constructed (${said}) and its port stayed silent, while the main world's control STUN arrived (${controlHits})` }
  }
  return {
    verdict: 'unmeasured',
    detail: `UNMEASURED - a connection was constructed (${said}) and its port stayed silent, but the main world's control STUN `
      + `never arrived (${controlHits === null ? 'not run' : controlHits}), so silence cannot tell a block from STUN never sent to loopback`,
  }
}

/** The thumbnail arm: every port silent, AND every probe demonstrably ran (its mark painted in the poster, UA12.116). */
export function scoreThumbnailEgress(
  hitsByProbe: Readonly<Record<string, number>>,
  marks: Readonly<Record<string, EgressMark>> | null,
): { ok: boolean; detail: string } {
  const leaks = Object.entries(hitsByProbe).filter(([, hits]) => hits > 0)
  if (leaks.length > 0) return { ok: false, detail: `LEAK from the thumbnail window: ${leaks.map(([name, hits]) => `${name}=${hits}`).join(', ')}` }
  if (!marks) {
    return { ok: false, detail: 'UNMEASURED - no poster appeared or it carried no readable bands, so the capture may never have run T\'s bytes; silent ports prove nothing' }
  }
  const unissued = Object.entries(marks).filter(([, mark]) => mark !== 'issued').map(([name]) => name)
  if (unissued.length > 0) {
    return {
      ok: false,
      detail: `UNMEASURED - the poster lacks an issued mark for ${JSON.stringify(unissued)}, so those probes never demonstrably `
        + 'ran (the capture may show a page the navigations replaced); a silent port proves nothing - re-run',
    }
  }
  return { ok: true, detail: 'every port silent and every probe painted its issued mark in the poster' }
}

/**
 * UA12.116 — what one of T's probe bands read back from the poster: `issued` (the probe's paint landed - the page's
 * script ran and attempted that probe) or `unknown` (still the pending colour, another colour, or no reading: the probe
 * never demonstrably ran, and its silent port proves nothing).
 */
export type EgressMark = 'issued' | 'unknown'

/**
 * UA12.116 — one of T's probe bands from the poster: T paints the SAME colours as TS's realms (the `attempted` green
 * once the probe has been issued, the `pending` grey before), so the classification reuses {@link classifyStunMark}'s
 * nearest-colour read and tolerance; any non-green band is `unknown`.
 */
export function classifyEgressMark(rgb: readonly number[] | null | undefined): EgressMark {
  return classifyStunMark(rgb) === 'attempted' ? 'issued' : 'unknown'
}

/**
 * UA12.106 — what one realm of the thumbnail STUN page (TS) painted into its half of the poster: `attempted` (its
 * `RTCPeerConnection` was constructed, its offer set, ICE gathering began, and the document was still alive
 * {@link STUN_MARK_DELAY_MS} later), `absent` (no constructor in that realm), `threw` (construction or the offer
 * failed), or `unknown` (still the parse-time `pending` colour, or no reading: the probe never demonstrably ran).
 */
export type StunMark = 'attempted' | 'absent' | 'threw' | 'unknown'

/** UA12.106 — the colours TS paints; `pending` is painted at parse time and is never a reading. */
export const STUN_MARK_RGB = {
  pending: [128, 128, 128],
  attempted: [0, 170, 0],
  absent: [0, 0, 210],
  threw: [210, 0, 0],
} as const satisfies Record<'pending' | Exclude<StunMark, 'unknown'>, readonly [number, number, number]>

/** UA12.106 — how long after ICE gathering began TS waits before painting `attempted` (inside RENDER_SETTLE_MS). */
export const STUN_MARK_DELAY_MS = 150

/** The largest per-channel distance a poster sample may sit from a mark colour (the poster is a resized JPEG). */
const STUN_MARK_TOLERANCE = 60

/**
 * UA12.106 — one realm's mark from the poster: the nearest of the four painted colours within
 * {@link STUN_MARK_TOLERANCE} per channel. `pending`, anything else, or no sample is `unknown`.
 */
export function classifyStunMark(rgb: readonly number[] | null | undefined): StunMark {
  if (!rgb || rgb.length < 3) return 'unknown'
  let best: { name: keyof typeof STUN_MARK_RGB; distance: number } | null = null
  for (const [name, colour] of Object.entries(STUN_MARK_RGB) as Array<[keyof typeof STUN_MARK_RGB, readonly number[]]>) {
    const distance = Math.max(...colour.map((channel, i) => Math.abs(channel - (rgb[i] as number))))
    if (distance <= STUN_MARK_TOLERANCE && (!best || distance < best.distance)) best = { name, distance }
  }
  return !best || best.name === 'pending' ? 'unknown' : best.name
}

/**
 * T's STUN (page TS): the thumbnail window renders the same builder output (`allow-scripts` for an interactive page),
 * so a fresh realm's `RTCPeerConnection` is reachable there too, and neither the partition's webRequest filter nor its
 * refused permissions see WebRTC's UDP. Any datagram on either port is a leak, whatever else was read. The capture
 * window cannot post out (its only way out is the egress under test), so the in-page evidence is what TS painted into
 * the poster ({@link StunMark}, UA12.106): a realm with no mark never demonstrably ran its probe, and its silent port
 * proves nothing - UNMEASURED, never blocked. Both realms refused (absent/threw) over silent ports is blocked; a realm
 * that `attempted` over a silent port is blocked only beside the main world's identical STUN to a control port that
 * arrived (Chromium sends STUN to loopback here). Residue: `attempted` proves gathering began and the document lived
 * {@link STUN_MARK_DELAY_MS} more; Chromium sends the binding request as the host socket opens, inside that window.
 */
export function scoreThumbnailStun(evidence: {
  topHits: number; realmHits: number; controlHits: number | null; posterSeen: boolean
  marks: { top: StunMark; realm: StunMark } | null
}): { verdict: EgressVerdict; detail: string } {
  const { topHits, realmHits, controlHits, posterSeen, marks } = evidence
  if (topHits > 0 || realmHits > 0) {
    return { verdict: 'leaking', detail: `STUN datagrams from the thumbnail window (TS's realm ${topHits}, fresh realm ${realmHits})` }
  }
  if (!posterSeen) return { verdict: 'unmeasured', detail: 'UNMEASURED - no poster appeared, so the capture may never have run TS\'s STUN probes' }
  const said = `TS's realm ${marks?.top ?? 'no reading'}, fresh realm ${marks?.realm ?? 'no reading'}`
  if (!marks || marks.top === 'unknown' || marks.realm === 'unknown') {
    return {
      verdict: 'unmeasured',
      detail: `UNMEASURED - the poster lacks a realm's STUN mark (${said}), so that probe never demonstrably ran; a silent port proves nothing`,
    }
  }
  const refused = (mark: StunMark) => mark === 'absent' || mark === 'threw'
  if (refused(marks.top) && refused(marks.realm)) {
    return { verdict: 'blocked', detail: `both realms lack or refuse RTCPeerConnection (${said}) and both ports stayed silent` }
  }
  if ((controlHits ?? 0) > 0) {
    return { verdict: 'blocked', detail: `a realm attempted STUN (${said}) and both ports stayed silent, while the main world's control STUN arrived (${controlHits})` }
  }
  return {
    verdict: 'unmeasured',
    detail: `UNMEASURED - a realm attempted STUN (${said}) and both ports stayed silent, but the main world's control STUN never arrived `
      + `(${controlHits === null ? 'not run' : controlHits}), so silence cannot tell a block from STUN never sent to loopback`,
  }
}

/** D's card: present, names the page, offers no durable button. */
export function scoreDeleteCard(card: CardRead | null, pageName: string): { ok: boolean; detail: string } {
  if (!card || !card.present) return { ok: false, detail: 'no permission card appeared for delete_page' }
  if (!card.text.includes(`Delete the page "${pageName}"`)) {
    return { ok: false, detail: `the card does not name the page: ${JSON.stringify(card.text.slice(0, 200))}` }
  }
  if (card.durableOffered) return { ok: false, detail: `the card offers a durable answer: ${JSON.stringify(card.labels)}` }
  return { ok: true, detail: 'one-shot card naming the page' }
}

/** The DNS capture, read for the probe host beside the app document's own dns-prefetch of the control host. */
export function scoreDnsCapture(capture: string | null): { verdict: EgressVerdict; detail: string } {
  if (capture === null) {
    return { verdict: 'unmeasured', detail: 'UNMEASURED - no DNS capture (NESSY_CDP_RS112_DNS_CAPTURE); dns-prefetch asks a resolver, not a socket' }
  }
  if (capture.includes(DNS_PROBE_HOST)) return { verdict: 'leaking', detail: `${DNS_PROBE_HOST} was resolved` }
  if (!capture.includes(DNS_CONTROL_HOST)) {
    return { verdict: 'unmeasured', detail: `UNMEASURED - the capture lacks the app document's own dns-prefetch of ${DNS_CONTROL_HOST}, so the mechanism never fired where the capture could see it` }
  }
  return { verdict: 'blocked', detail: 'the app document\'s control prefetch is in the capture and the probe host is not' }
}

export interface ViolationRead { uri: string; directive: string }

/** The directives under which the EMBEDDER's policy refuses a subframe navigation (frame-src, then its fallbacks). */
const EMBEDDER_NAVIGATION_DIRECTIVES: ReadonlySet<string> = new Set(['frame-src', 'child-src', 'default-src'])

/** A blocked URI names this port exactly (`:4000` must not match `:40009`). */
function namesPort(uri: string, port: number): boolean {
  return new RegExp(`:${port}(?![0-9])`).test(uri)
}

/**
 * Every violation F reported: its per-event `violation` posts - they reach the inbox even when F's document is
 * replaced right after (the form POST's `form-action` one is followed within 800 ms by the self-navigation) - plus
 * the snapshots its `results` and `alive` messages carry. One violation is read once.
 */
export function frameViolations(messages: ReadonlyArray<Record<string, unknown>>): ViolationRead[] {
  const out: ViolationRead[] = []
  const seen = new Set<string>()
  const add = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const { uri, directive } = value as Record<string, unknown>
    if (typeof uri !== 'string') return
    const read = { uri, directive: String(directive ?? '') }
    const key = `${read.directive} ${read.uri}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(read)
  }
  for (const msg of messages) {
    if (msg.type === 'violation') add(msg)
    else if (Array.isArray(msg.violations)) for (const value of msg.violations) add(value)
  }
  return out
}

/**
 * Self-navigation's evidence. Two correct builds look different here, and both are a block:
 * - the packaged renderer's own CSP (`apps/electron/src/renderer/index.html`: `default-src 'self'`, no `frame-src`)
 *   refuses `location.href = http://127.0.0.1:<port>` first. The navigation fails `ERR_BLOCKED_BY_CSP` (measured
 *   for a srcdoc subframe by UA-ak on Electron 39.8.10, see `apps/electron/src/main/page-thumbnailer.ts`), the
 *   violation belongs to the EMBEDDER's policy, and Chromium's blocked-page document may replace F - so F may never
 *   beat. The case reads the embedder's violation from a main-world listener.
 * - without that CSP the `will-frame-navigate` guard (UA7.2) cancels quietly and F survives to beat (>= 3 beats).
 * A connection on the port is a leak whatever else was seen; a silent port with neither is unmeasured.
 */
export function selfNavigationEvidence(input: {
  hits: number; port: number; frameViolations: readonly ViolationRead[]; parentViolations: readonly ViolationRead[]; aliveBeats: number
}): EgressEvidence {
  const inFrame = input.frameViolations.some(v => namesPort(v.uri, input.port))
  const byEmbedder = input.parentViolations.some(v => namesPort(v.uri, input.port) && EMBEDDER_NAVIGATION_DIRECTIVES.has(v.directive))
  return { hits: input.hits, violation: inFrame || byEmbedder, refusedInPage: input.aliveBeats >= 3, loadedInPage: false }
}

/**
 * Arm A's write_page_data patch, sent to the agent verbatim (pinned against the real store by the scoring test).
 * Each point carries its own `t`: a point without one is stamped `Date.now()` inside one transaction and the
 * `(series, t)` upsert keeps only the last (upstream v0.13.4 data-store.ts, kept by pages/data-write.ts).
 */
export const ARM_A_WRITE = {
  set: { summary: { total: 42 } },
  appendSeries: { 'ci.duration_ms': [{ t: 1000, v: 81000 }, { t: 2000, v: 79000 }, { t: 3000, v: 83000 }] },
} as const
const ARM_A_VALUES = ARM_A_WRITE.appendSeries['ci.duration_ms'].map(point => point.v)

// ============================================================================
// Listeners (the case's own loopback ports)
// ============================================================================

export interface PortRecorder {
  port: number
  hits: number
  firstBytes: string[]
  stop(): void
}

export function tcpRecorder(): PortRecorder {
  const rec = { hits: 0, firstBytes: [] as string[] }
  const listener = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() { rec.hits += 1 },
      data(socket, data) {
        if (rec.firstBytes.length < 4) rec.firstBytes.push(Buffer.from(data).subarray(0, 48).toString('latin1').replace(/[^\x20-\x7e]/g, '.'))
        socket.end()
      },
    },
  })
  return { port: listener.port, get hits() { return rec.hits }, get firstBytes() { return rec.firstBytes }, stop: () => listener.stop(true) }
}

export async function udpRecorder(): Promise<PortRecorder> {
  const rec = { hits: 0 }
  const socket = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0, socket: { data() { rec.hits += 1 } } })
  return { port: socket.port, get hits() { return rec.hits }, firstBytes: [], stop: () => socket.close() }
}

/** The case process reaches the port itself: the listener is alive. */
export async function processControl(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

/**
 * The out-of-page control on every port, then the baseline the probes are counted from. `processControl` resolves
 * when the CLIENT side opens; the listener's `open()` that counts the connection is a separate callback that usually
 * runs later, so a baseline read straight after the controls missed most of them and their late hits read as probe
 * hits (2026-10-02, Bun 1.3.14, 7 ports: 296 of 300 rounds in the verifier's scratch copy, 35 of 40 in the arm that
 * pins it in rs-112-pages-score.test.ts). The
 * baseline is read only once every reached port has counted its own control; a port whose listener never counts it
 * within `settleMs` reads unreached, so the caller's require fails instead of a silent port proving nothing.
 */
export async function controlledBaseline<K extends string>(
  recorders: Readonly<Record<K, PortRecorder>>,
  settleMs = 5_000,
): Promise<{ reach: Record<K, boolean>; base: Record<K, number> }> {
  const keys = Object.keys(recorders) as K[]
  const before = Object.fromEntries(keys.map(key => [key, recorders[key].hits])) as Record<K, number>
  const reach = Object.fromEntries(await Promise.all(keys.map(async key => [key, await processControl(recorders[key].port)]))) as Record<K, boolean>
  const uncounted = () => keys.filter(key => reach[key] && recorders[key].hits <= before[key])
  const deadline = Date.now() + settleMs
  while (uncounted().length > 0 && Date.now() < deadline) await Bun.sleep(10)
  for (const key of uncounted()) reach[key] = false
  const base = Object.fromEntries(keys.map(key => [key, recorders[key].hits])) as Record<K, number>
  return { reach, base }
}

// ============================================================================
// Pages through the app's own channels, and the main-world probe inbox
// ============================================================================

interface PageRow { slug: string; name: string; kind: string; description?: string }

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

async function createPage(session: CdpSession, workspaceId: string, name: string, kind: string, content: string): Promise<string> {
  return session.call<string>(`
    const created = await window.electronAPI.createPage(${JSON.stringify(workspaceId)}, {
      name: ${JSON.stringify(name)}, kind: ${JSON.stringify(kind)}, content: ${JSON.stringify(content)},
    })
    return created.slug
  `)
}

async function listPages(session: CdpSession, workspaceId: string): Promise<PageRow[]> {
  return session.call<PageRow[]>(`
    const pages = await window.electronAPI.getPages(${JSON.stringify(workspaceId)})
    return (pages ?? []).map(p => ({ slug: p.config.slug, name: p.config.name, kind: p.config.kind, description: p.config.description }))
  `)
}

async function pageRow(session: CdpSession, workspaceId: string, slug: string): Promise<PageRow | null> {
  return session.call<PageRow | null>(`
    const p = await window.electronAPI.getPage(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)})
    return p ? { slug: p.config.slug, name: p.config.name, kind: p.config.kind, description: p.config.description } : null
  `)
}

async function pageData(session: CdpSession, workspaceId: string, slug: string): Promise<{ total: unknown; points: number; values: unknown[] } | null> {
  return session.call<{ total: unknown; points: number; values: unknown[] } | null>(`
    const s = await window.electronAPI.getPageData(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)})
    if (!s) return null
    const summary = (s.kv && s.kv.summary) || {}
    const series = (s.series && s.series['ci.duration_ms']) || []
    return { total: summary.total ?? null, points: series.length, values: series.map(p => p.v) }
  `)
}

async function deletePageQuietly(session: CdpSession, workspaceId: string, slug: string): Promise<string> {
  return session.call<string>(`
    try { await window.electronAPI.deletePage(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)}); return 'deleted' }
    catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
  `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
}

async function navigateRoute(session: CdpSession, route: string): Promise<void> {
  await session.call<null>(`
    window.dispatchEvent(new CustomEvent('nessy-agent-navigate', { detail: { route: ${JSON.stringify(route)} }, bubbles: true }))
    return null
  `)
}

function frameSelector(pageName: string): string {
  return `iframe[title=${JSON.stringify(pageName)}]`
}

/** Install (idempotently) the main-world inbox: messages of our protocol, from the named page's own frame only. */
async function installInbox(session: CdpSession): Promise<void> {
  await session.call<null>(`
    if (!window.__rs112) {
      window.__rs112 = { messages: [] }
      window.addEventListener('message', event => {
        const msg = event.data
        if (!msg || msg.protocol !== ${JSON.stringify(PROBE_PROTOCOL)}) return
        const frame = Array.from(document.querySelectorAll('iframe')).find(f => f.contentWindow === event.source)
        if (!frame) return
        window.__rs112.messages.push({ page: frame.getAttribute('title'), at: Date.now(), msg })
      })
    }
    return null
  `)
}

interface InboxMessage { page: string; at: number; msg: Record<string, unknown> }

async function inbox(session: CdpSession, pageName: string, type?: string): Promise<InboxMessage[]> {
  return session.call<InboxMessage[]>(`
    return (window.__rs112 ? window.__rs112.messages : [])
      .filter(m => m.page === ${JSON.stringify(pageName)} && (${JSON.stringify(type ?? null)} === null || m.msg.type === ${JSON.stringify(type ?? null)}))
  `)
}

/** Click at a point the page reported for one of its own buttons (frame-relative), as a real pointer click. */
async function clickInFrame(session: CdpSession, pageName: string, rect: { x: number; y: number; width: number; height: number }, label: string): Promise<void> {
  const frame = await session.call<{ x: number; y: number } | null>(`
    const el = document.querySelector(${JSON.stringify(frameSelector(pageName))})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y }
  `)
  if (!frame) throw new Error(`${label}: the page's frame is not on screen`)
  await clickAt(session, { x: Math.round(frame.x + rect.x + rect.width / 2), y: Math.round(frame.y + rect.y + rect.height / 2) }, label)
}

// ============================================================================
// The case-authored pages
// ============================================================================

/** L: a live page that reports `summary.total` on every init/data, and a hello on load. */
function livePageHtml(): string {
  return `<html><head><meta charset="utf-8"><title>RS-112 live</title></head><body>
<h1>RS-112 live</h1><div id="total">-</div>
<script>
  const post = (type, extra) => window.parent.postMessage(Object.assign({ protocol: '${PROBE_PROTOCOL}', type }, extra || {}), '*')
  post('hello', { compatMode: document.compatMode })
  function render(s) {
    const total = s && s.kv && s.kv.summary ? s.kv.summary.total : null
    document.getElementById('total').textContent = String(total)
    post('live', { total, generatedAt: s ? s.generatedAt : null })
  }
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (!msg || msg.protocol !== 'nessy-pages/v1') return
    if (msg.type === 'init' || msg.type === 'data') render(msg.payload.snapshot)
  })
  window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'ready' }, '*')
</script></body></html>`
}

export interface FramePorts {
  fetchHttps: number; wss: number; imgHttps: number; formPost: number; loopbackFetch: number; loopbackWs: number
  windowOpen: number; preconnect: number; selfNav: number; stunUdp: number; stunRealmUdp: number
}

/**
 * F: NO doctype (the builder's is what makes standards mode). Probes run only after a real click on "Run probes",
 * so the poster capture of F's own creation runs none of them.
 */
export function framePageHtml(ports: FramePorts): string {
  const p = ports
  return `<html><head><meta charset="utf-8"><title>RS-112 frame</title>
<style>button { font-size: 18px; padding: 16px 24px; margin: 12px; }</style></head><body>
<h1>RS-112 frame probes</h1>
<button id="run">Run probes</button><button id="link">Open link</button>
<script>
  const post = (type, extra) => window.parent.postMessage(Object.assign({ protocol: '${PROBE_PROTOCOL}', type }, extra || {}), '*')
  const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  let nonce = null
  window.addEventListener('message', (event) => {
    const msg = event.data
    if (msg && msg.protocol === 'nessy-pages/v1' && msg.type === 'init') nonce = msg.payload.nonce
  })
  window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'ready' }, '*')
  let started = false
  const hello = setInterval(() => { if (!started) post('hello', { compatMode: document.compatMode, run: rect('run'), link: rect('link'), hasNonce: nonce !== null }) }, 500)
  document.getElementById('link').addEventListener('click', () => {
    post('link-clicked', { hasNonce: nonce !== null })
    window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'open-url', nonce, url: ${JSON.stringify(OPEN_URL)} }, '*')
  })
  const violations = []
  // Posted as it happens, not only in the beats: the self-navigation may replace this document before the first beat.
  document.addEventListener('securitypolicyviolation', e => { const v = { uri: String(e.blockedURI), directive: String(e.effectiveDirective || e.violatedDirective) }; violations.push(v); post('violation', v) })
  document.getElementById('run').addEventListener('click', () => {
    started = true
    clearInterval(hello)
    const out = {}
    const note = (name, value) => { out[name] = value }
    try { fetch('https://127.0.0.1:${p.fetchHttps}/f').then(() => note('fetch-https', 'resolved'), e => note('fetch-https', 'rejected: ' + e)) } catch (e) { note('fetch-https', 'threw: ' + e) }
    try { const ws = new WebSocket('wss://127.0.0.1:${p.wss}/f'); ws.onerror = () => note('websocket', 'error'); ws.onopen = () => note('websocket', 'open') } catch (e) { note('websocket', 'threw: ' + e) }
    try { const img = new Image(); img.onload = () => note('img-beacon', 'loaded'); img.onerror = () => note('img-beacon', 'error'); img.src = 'https://127.0.0.1:${p.imgHttps}/b.gif' } catch (e) { note('img-beacon', 'threw: ' + e) }
    try { const img = new Image(); img.onload = () => note('file-image', 'loaded'); img.onerror = () => note('file-image', 'error'); img.src = 'file:///etc/hosts' } catch (e) { note('file-image', 'threw: ' + e) }
    try { fetch('http://127.0.0.1:${p.loopbackFetch}/f').then(() => note('loopback-fetch', 'resolved'), e => note('loopback-fetch', 'rejected: ' + e)) } catch (e) { note('loopback-fetch', 'threw: ' + e) }
    try { const ws = new WebSocket('ws://127.0.0.1:${p.loopbackWs}/f'); ws.onerror = () => note('loopback-ws', 'error'); ws.onopen = () => note('loopback-ws', 'open') } catch (e) { note('loopback-ws', 'threw: ' + e) }
    try { const w = window.open('http://127.0.0.1:${p.windowOpen}/f'); note('window-open', w ? 'opened' : 'refused (null)') } catch (e) { note('window-open', 'threw: ' + e) }
    // STUN from F's own realm, then from a fresh realm: a no-src child iframe is about:blank in this opaque origin and
    // never runs the builder's constructor removal (scoreStunProbe). Each realm aims at its own UDP port.
    const pcs = window.__rs112pcs = []
    const stunFrom = (key, w, url) => {
      const Ctor = w && (w.RTCPeerConnection || w.webkitRTCPeerConnection)
      if (!Ctor) { note(key, 'absent'); return }
      const pc = new Ctor({ iceServers: [{ urls: url }] }); pcs.push(pc); note(key, 'constructed')
      try { pc.createDataChannel('x'); pc.createOffer().then(o => pc.setLocalDescription(o)).catch(e => note(key + '-offer', 'rejected: ' + e)) } catch (e) { note(key + '-offer', 'threw: ' + e) }
    }
    try { stunFrom('stun', window, 'stun:127.0.0.1:${p.stunUdp}') } catch (e) { note('stun', 'threw: ' + e) }
    try {
      const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f)
      const w = f.contentWindow
      stunFrom('stun-realm', w, 'stun:127.0.0.1:${p.stunRealmUdp}')
    } catch (e) { note('stun-realm', 'threw: ' + e) }
    try { const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = '//${DNS_PROBE_HOST}'; document.head.appendChild(l); note('dns-prefetch', 'inserted') } catch (e) { note('dns-prefetch', 'threw: ' + e) }
    try { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://127.0.0.1:${p.preconnect}'; document.head.appendChild(l); note('preconnect', 'inserted') } catch (e) { note('preconnect', 'threw: ' + e) }
    setTimeout(() => {
      post('results', { outcomes: out, violations: violations.slice() })
      // Last, because a leak here would take the page away: a form POST and a self-navigation.
      try {
        const f = document.createElement('form'); f.method = 'post'; f.action = 'https://127.0.0.1:${p.formPost}/f'
        document.body.appendChild(f); f.submit(); post('form-submitted', {})
      } catch (e) { post('form-submitted', { threw: String(e) }) }
      setTimeout(() => {
        try { location.href = 'http://127.0.0.1:${p.selfNav}/f' } catch (e) { post('self-nav-threw', { error: String(e) }) }
        let beats = 0
        const beat = setInterval(() => { beats += 1; post('alive', { beats, violations: violations.slice() }); if (beats >= 10) clearInterval(beat) }, 500)
      }, 800)
    }, 3000)
  })
</script></body></html>`
}

/** The name R's script gives its own frame before it navigates (UA12.170). */
export const RENAME_FRAME_NAME = 'rs112-renamed-by-script'

/**
 * R (UA12.170): after a real click on "Rename and navigate", the script renames its OWN frame and then self-navigates
 * to the case port with data in the query - the shape that left through `shell.openExternal` on 58aa92509. Then it
 * beats, so a cancel the frame survives is visible (selfNavigationEvidence).
 */
export function renamePageHtml(port: number): string {
  return `<html><head><meta charset="utf-8"><title>RS-112 rename</title>
<style>button { font-size: 18px; padding: 16px 24px; margin: 12px; }</style></head><body>
<h1>RS-112 rename probe</h1>
<button id="go">Rename and navigate</button>
<script>
  const post = (type, extra) => window.parent.postMessage(Object.assign({ protocol: '${PROBE_PROTOCOL}', type }, extra || {}), '*')
  const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  window.parent.postMessage({ protocol: 'nessy-pages/v1', type: 'ready' }, '*')
  let started = false
  const hello = setInterval(() => { if (!started) post('hello', { go: rect('go'), name: window.name }) }, 500)
  const violations = []
  document.addEventListener('securitypolicyviolation', e => { const v = { uri: String(e.blockedURI), directive: String(e.effectiveDirective || e.violatedDirective) }; violations.push(v); post('violation', v) })
  document.getElementById('go').addEventListener('click', () => {
    started = true
    clearInterval(hello)
    const before = window.name
    window.name = '${RENAME_FRAME_NAME}'
    post('renamed', { before, after: window.name })
    try { location.href = 'http://127.0.0.1:${port}/r?d=rs112-rename-exfil' } catch (e) { post('rename-nav-threw', { error: String(e) }) }
    let beats = 0
    const beat = setInterval(() => { beats += 1; post('alive', { beats, violations: violations.slice() }); if (beats >= 10) clearInterval(beat) }, 500)
  })
</script></body></html>`
}

/** T's probes, in the order its poster bands are stacked (top to bottom) and the drive reads them back (UA12.116). */
export const THUMB_PROBE_ORDER = ['imgHttps', 'fetch', 'ws', 'windowOpen', 'metaRefresh', 'location', 'preconnect'] as const

/** T's probe ports, keyed as {@link THUMB_PROBE_ORDER} reads them. */
export type ThumbPorts = Record<(typeof THUMB_PROBE_ORDER)[number], number>

/**
 * T: everything on LOAD, so the only document that ever runs it is the thumbnail window's. Each probe paints an
 * "issued" band into the page (UA12.116, the poster-mark technique of UA12.106) - one horizontal band per probe,
 * stacked in {@link THUMB_PROBE_ORDER}, pending grey until its probe issues, then the attempted green - so the poster
 * carries per-probe in-page evidence and a silent port beside a missing mark is UNMEASURED, never a pass. The two head
 * probes (meta refresh, preconnect) issue before `<body>` exists, so they RECORD in the head and the body's first
 * script paints them; the location probe paints BEFORE its navigation replaces the document.
 */
export function thumbPageHtml(p: ThumbPorts): string {
  const colours = { pending: STUN_MARK_RGB.pending, issued: STUN_MARK_RGB.attempted }
  const css = (rgb: readonly number[]) => `rgb(${rgb.join(', ')})`
  return `<html><head><meta charset="utf-8"><title>RS-112 thumbnail</title>
<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${p.metaRefresh}/t">
<link rel="preconnect" href="http://127.0.0.1:${p.preconnect}">
<script>window.__rs112Issued = ['metaRefresh', 'preconnect']</script>
</head><body style="margin:0">
<img src="https://127.0.0.1:${p.imgHttps}/t.gif" alt="">
<script>
  // No STUN here (UA12.106): the navigations below can replace this document before a STUN probe sends anything;
  // STUN runs on its own page (thumbStunPageHtml).
  const PENDING = '${css(colours.pending)}', ISSUED = '${css(colours.issued)}'
  const ORDER = ${JSON.stringify([...THUMB_PROBE_ORDER])}
  const bands = {}
  ORDER.forEach((name, i) => {
    const band = document.createElement('div')
    band.dataset.rs112Band = name
    band.style.cssText = 'position:fixed;left:0;width:100%;top:' + (i * 100 / ORDER.length) + '%;height:' + (100 / ORDER.length) + '%;background:' + PENDING
    document.body.appendChild(band); bands[name] = band
  })
  const paint = name => { const band = bands[name]; if (band) band.style.background = ISSUED }
  ;(window.__rs112Issued || []).forEach(paint)
  paint('imgHttps')
  try { fetch('http://127.0.0.1:${p.fetch}/t').catch(() => {}) } catch (e) {} paint('fetch')
  try { new WebSocket('ws://127.0.0.1:${p.ws}/t') } catch (e) {} paint('ws')
  try { window.open('http://127.0.0.1:${p.windowOpen}/t') } catch (e) {} paint('windowOpen')
  setTimeout(() => { paint('location'); try { location.href = 'http://127.0.0.1:${p.location}/t' } catch (e) {} }, 100)
</script></body></html>`
}

export interface ThumbStunPorts { stunUdp: number; stunRealmUdp: number }

/**
 * TS (UA12.106): T's STUN probe on a page of its own - no navigation, no other request - so nothing can replace the
 * document before its STUN sends, from TS's realm and from a fresh realm (a no-src child iframe never runs the builder's
 * constructor removal), each on its own UDP port. The capture window cannot post out, so each realm paints its outcome
 * ({@link StunMark}, {@link STUN_MARK_RGB}) into its own half of the page - TS's realm the left, the fresh realm the
 * right - and the poster carries the mark ({@link classifyStunMark}). `attempted` is painted {@link STUN_MARK_DELAY_MS}
 * after ICE gathering began, inside the capture window's RENDER_SETTLE_MS (pinned in the test).
 */
export function thumbStunPageHtml(p: ThumbStunPorts): string {
  const css = (rgb: readonly number[]) => `rgb(${rgb.join(', ')})`
  const colours = Object.fromEntries(Object.entries(STUN_MARK_RGB).map(([name, rgb]) => [name, css(rgb)]))
  return `<html><head><meta charset="utf-8"><title>RS-112 thumbnail STUN</title>
<style>html, body { margin: 0; padding: 0; } .mark { position: fixed; top: 0; height: 100%; width: 50%; }</style>
</head><body>
<div id="top" class="mark" style="left: 0; background: ${colours.pending}"></div>
<div id="realm" class="mark" style="left: 50%; background: ${colours.pending}"></div>
<script>
  const COLOURS = ${JSON.stringify(colours)}
  const paint = (id, mark) => { document.getElementById(id).style.background = COLOURS[mark] }
  const stunFrom = (id, w, url) => {
    const Ctor = w && (w.RTCPeerConnection || w.webkitRTCPeerConnection)
    if (!Ctor) { paint(id, 'absent'); return }
    const pc = new Ctor({ iceServers: [{ urls: url }] }); (window.__rs112pcs = window.__rs112pcs || []).push(pc)
    let began = false
    const mark = () => { if (!began && pc.iceGatheringState !== 'new') { began = true; setTimeout(() => paint(id, 'attempted'), ${STUN_MARK_DELAY_MS}) } }
    pc.addEventListener('icegatheringstatechange', mark)
    pc.createDataChannel('x')
    pc.createOffer().then(o => pc.setLocalDescription(o)).then(mark, () => paint(id, 'threw'))
  }
  try { stunFrom('top', window, 'stun:127.0.0.1:${p.stunUdp}') } catch (e) { paint('top', 'threw') }
  try {
    const f = document.createElement('iframe'); f.style.display = 'none'; document.body.appendChild(f)
    stunFrom('realm', f.contentWindow, 'stun:127.0.0.1:${p.stunRealmUdp}')
  } catch (e) { paint('realm', 'threw') }
</script></body></html>`
}

// ============================================================================
// The arms
// ============================================================================

const isTool = (name: string) => (row: TranscriptMessage): boolean =>
  new RegExp(name).test(`${row.toolName ?? ''} ${row.toolDisplayName ?? ''}`)

function toolReading(rows: readonly TranscriptMessage[], match: (row: TranscriptMessage) => boolean): Record<string, unknown>[] {
  return rows.filter(match).map(row => ({
    toolName: row.toolName ?? null,
    toolStatus: row.toolStatus ?? null,
    toolResult: (row.toolResult ?? '').slice(0, 300),
  }))
}

async function turnRows(run: CaseRun, session: CdpSession, key: SessionKey, label: string, prompt: string): Promise<TranscriptMessage[]> {
  const before = (await transcript(session, key)).length
  let added: TranscriptMessage[] = []
  try {
    added = (await sendPrompt(session, key, prompt, TURN_MS)).added
  } catch (error) {
    run.observe(`${label}: the send threw`, String(error).slice(0, 300))
  }
  return turnRowsSince(() => transcript(session, key), added, before)
}

/** One delete turn with a card watcher beside it (lib/permission-card.ts `shellArm`'s shape). */
async function deleteTurn(
  run: CaseRun,
  session: CdpSession,
  key: SessionKey,
  label: string,
  slug: string,
  answer: 'Deny' | 'Allow',
): Promise<{ card: CardRead | null; pressed: string; cards: number; rows: TranscriptMessage[] }> {
  await ensureNoCard(session, label)
  const before = (await transcript(session, key)).length
  let card: CardRead | null = null
  let pressed = '(no card)'
  // Every card of the turn is counted (UA6.2 asks for exactly ONE): the watcher answers each alike - pressCard waits
  // for the answered card to go - and keeps watching until the turn ends.
  let cards = 0
  let turnDone = false
  const turn = sendPrompt(session, key,
    `Please call the delete_page tool once for the page with slug "${slug}", then reply with the tool's answer word for word.`,
    TURN_MS).catch(error => { run.observe(`${label}: the send threw`, String(error).slice(0, 300)); return undefined })
    .finally(() => { turnDone = true })
  const watch = (async () => {
    const deadline = Date.now() + TURN_MS - 10_000
    while (!turnDone && Date.now() < deadline) {
      await Bun.sleep(1_200)
      const seen = await readCard(session)
      if (!seen.present) continue
      cards += 1
      const said = await pressCard(session, [answer], `${label} (card ${cards})`)
      if (cards === 1) { card = seen; pressed = said }
    }
  })()
  await turn
  await watch
  const rows = await turnRowsSince(() => transcript(session, key), [], before)
  return { card, pressed, cards, rows }
}

async function driveRuntime(
  run: CaseRun,
  session: CdpSession,
  runtime: SittingRuntime,
  slug: string,
  workspaceId: string,
  live: { slug: string; name: string },
  ownedPages: string[],
  ownedSessions: string[],
): Promise<void> {
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const key = await freshSession(session, `CDP ${ID} ${runtime} ${stamp}`)
  ownedSessions.push(key.sessionId)
  run.require(`${runtime}: ran in a session it created`, key.fresh, `inherited ${key.inheritedMessages} messages`)
  run.observe(`${runtime}: the session's permission mode (read back)`, key.permissionMode)
  await switchRuntime(session, key.sessionId, slug)
  run.require(`${runtime}: the session runs on ${slug}`, (await waitForConnection(session, key.sessionId, slug)) === slug, slug)
  await focusWindow(session)

  // ================= A - create and write ===================================
  const pageName = `RS-112 ${runtime} ${stamp}`
  const aRows = await turnRows(run, session, key, `${runtime}/A`,
    `Please call the create_page tool once to create a page named exactly "${pageName}" with kind "live" and a small `
    + 'HTML document that shows summary.total as a number and the ci.duration_ms series as a bar chart (inline SVG, '
    + 'data from the nessy-pages/v1 bridge). Then call write_page_data once for that page with '
    + `set ${JSON.stringify(ARM_A_WRITE.set)} and appendSeries ${JSON.stringify(ARM_A_WRITE.appendSeries)}. `
    + 'Reply with the page slug.')
  const created = await waitFor(() => listPages(session, workspaceId), rows => rows.some(row => row.name === pageName),
    { timeoutMs: 15_000, intervalMs: 1_000 }).catch(() => listPages(session, workspaceId))
  const mine = created.find(row => row.name === pageName)
  if (mine) ownedPages.push(mine.slug)
  const data = mine ? await waitFor(() => pageData(session, workspaceId, mine.slug), d => d !== null && d.points >= 3,
    { timeoutMs: 15_000, intervalMs: 1_000 }).catch(() => pageData(session, workspaceId, mine.slug)) : null
  run.observe(`${runtime}/A: the turn`, {
    create: toolReading(aRows, isTool('create_page')), write: toolReading(aRows, isTool('write_page_data')),
    page: mine ?? null, data, reply: turnReply(aRows).slice(0, 200),
  })
  run.check(`${runtime}/A: the agent called create_page`, turnCalledTool(aRows, isTool('create_page')).ok, 'no create_page row in the turn')
  run.check(`${runtime}/A: the host lists the page as live`, mine?.kind === 'live', `getPages has ${JSON.stringify(mine ?? null)}`)
  run.check(`${runtime}/A: the agent called write_page_data`, turnCalledTool(aRows, isTool('write_page_data')).ok, 'no write_page_data row in the turn')
  run.check(`${runtime}/A: the host's data carries total 42 and three points`,
    data?.total === 42 && data.points === 3 && JSON.stringify(data.values) === JSON.stringify(ARM_A_VALUES),
    `getPageData reads ${JSON.stringify(data)}`)
  if (!mine) return

  // ================= B - update ==============================================
  const marker = `updated by RS-112 ${runtime} ${stamp}`
  const bRows = await turnRows(run, session, key, `${runtime}/B`,
    `Please call the update_page tool once for the page with slug "${mine.slug}" with description "${marker}" and no `
    + 'other change, then reply with the tool\'s answer.')
  const updated = await waitFor(() => pageRow(session, workspaceId, mine.slug), row => row?.description === marker,
    { timeoutMs: 15_000, intervalMs: 1_000 }).catch(() => pageRow(session, workspaceId, mine.slug))
  run.observe(`${runtime}/B: the turn`, { calls: toolReading(bRows, isTool('update_page')), page: updated })
  run.check(`${runtime}/B: the agent called update_page`, turnCalledTool(bRows, isTool('update_page')).ok, 'no update_page row in the turn')
  run.check(`${runtime}/B: the host reads the new description`, updated?.description === marker, `getPage reads ${JSON.stringify(updated)}`)

  // ================= C - a live page updates while open ======================
  // A total L does not already hold, so neither L's first render nor a stale reading can satisfy `seen`.
  const lTotal = (await pageData(session, workspaceId, live.slug))?.total
  let total = 100 + Math.floor(Math.random() * 800)
  if (total === lTotal) total += 1
  // L's inbox carries every earlier runtime's readings: only messages after this navigation count.
  const liveBefore = (await inbox(session, live.name, 'live')).length
  await navigateRoute(session, `pages/page/${live.slug}`)
  const opened = await waitFor(() => inbox(session, live.name, 'live'), rows => rows.length > liveBefore, { timeoutMs: 20_000, intervalMs: 500 })
    .then(() => true).catch(() => false)
  // The first render is in by now: only readings after the turn starts count as the live update.
  const liveOpened = (await inbox(session, live.name, 'live')).length
  const mark = `rs112-${runtime}-${stamp}`
  await session.call<null>(`
    const el = document.querySelector(${JSON.stringify(frameSelector(live.name))}); if (el) el.dataset.rs112Mark = ${JSON.stringify(mark)}; return null
  `)
  const hellosBefore = (await inbox(session, live.name, 'hello')).length
  const baseline = await turnBaseline(session, key)
  await session.call<null>(`
    void window.electronAPI.sendMessage(${JSON.stringify(key.sessionId)}, ${JSON.stringify(
      `Please call the write_page_data tool once for the page with slug "${live.slug}" with set {"summary": {"total": ${total}}} `
      + 'and nothing else, then reply "written".')})
    return null
  `)
  const seen = await waitFor(() => inbox(session, live.name, 'live'), rows => rows.slice(liveOpened).some(row => row.msg.total === total),
    { timeoutMs: TURN_MS, intervalMs: 1_000 }).then(() => true).catch(() => false)
  const cRows = await waitForTurn(session, key, baseline, TURN_MS).then(all => all.slice(baseline.count)).catch(() => [] as TranscriptMessage[])
  const hellosAfter = (await inbox(session, live.name, 'hello')).length
  const sameFrame = await session.call<boolean>(`
    const el = document.querySelector(${JSON.stringify(frameSelector(live.name))}); return !!el && el.dataset.rs112Mark === ${JSON.stringify(mark)}
  `)
  run.observe(`${runtime}/C: the live arm`, { opened, total, seen, hellosBefore, hellosAfter, sameFrame, calls: toolReading(cRows, isTool('write_page_data')) })
  run.check(`${runtime}/C: the open live page showed total ${total} without reloading`,
    opened && seen && sameFrame && hellosAfter === hellosBefore,
    !opened ? 'L never reported its first snapshot - the view did not render it'
      : !seen ? `L never reported total ${total} (the write did not reach the open page)`
        : 'the page reloaded (a new hello or a new <iframe>) instead of updating in place')
  await navigateRoute(session, `allSessions/session/${key.sessionId}`)
  await Bun.sleep(1_000)

  // ================= D - the delete card under bypass ========================
  // D's claim is "under bypass": a session that read back another mode (a `not-applied: …` read-back, or ask) would
  // show a card for a reason that is not this row's, so the read-back is a check here, not only an observation.
  run.check(`${runtime}/D: the session runs in bypassPermissions (read back)`, key.permissionMode === 'bypassPermissions',
    `read back ${JSON.stringify(key.permissionMode)} - D's card is measured under bypass only`)
  const deny = await deleteTurn(run, session, key, `${runtime}/D deny`, mine.slug, 'Deny')
  const afterDeny = await pageRow(session, workspaceId, mine.slug)
  const denyScore = scoreDeleteCard(deny.card, pageName)
  const denyResult = deny.rows.filter(isTool('delete_page')).map(row => row.toolResult ?? '').join(' ')
  run.observe(`${runtime}/D: deny`, { card: deny.card, pressed: deny.pressed, cards: deny.cards, page: afterDeny, calls: toolReading(deny.rows, isTool('delete_page')) })
  run.check(`${runtime}/D: one card naming the page, no Always Allow, in ${key.permissionMode}`, denyScore.ok && deny.cards === 1,
    denyScore.ok ? `${deny.cards} card(s) in the turn` : denyScore.detail)
  run.check(`${runtime}/D: Deny keeps the page and the tool says so`,
    deny.pressed === 'Deny' && afterDeny !== null && denyResult.includes('was declined; the page is unchanged'),
    `pressed ${deny.pressed}; page ${afterDeny ? 'present' : 'GONE'}; tool said ${JSON.stringify(denyResult.slice(0, 200))}`)
  const allow = await deleteTurn(run, session, key, `${runtime}/D allow`, mine.slug, 'Allow')
  const gone = await waitFor(() => pageRow(session, workspaceId, mine.slug), row => row === null, { timeoutMs: 15_000, intervalMs: 1_000 })
    .then(() => true).catch(() => false)
  run.observe(`${runtime}/D: allow`, { card: allow.card, pressed: allow.pressed, cards: allow.cards, gone })
  run.check(`${runtime}/D: Allow removes the page`, allow.pressed === 'Allow' && gone, `pressed ${allow.pressed}; page gone: ${gone}`)
}

async function driveFrame(run: CaseRun, session: CdpSession, workspaceId: string, stamp: string, ownedPages: string[]): Promise<void> {
  const names = ['fetchHttps', 'wss', 'imgHttps', 'formPost', 'loopbackFetch', 'loopbackWs', 'windowOpen', 'preconnect', 'selfNav'] as const
  const recorders = Object.fromEntries(names.map(name => [name, tcpRecorder()])) as Record<(typeof names)[number], PortRecorder>
  const stun = await udpRecorder()
  const stunRealm = await udpRecorder()
  const stunControl = await udpRecorder()
  const control = tcpRecorder()
  const preconnectControl = tcpRecorder()
  try {
    const ports = { ...Object.fromEntries(names.map(name => [name, recorders[name].port])), stunUdp: stun.port, stunRealmUdp: stunRealm.port } as FramePorts
    // The out-of-page controls, before anything runs.
    const processReach = Object.fromEntries(await Promise.all(names.map(async name => [name, await processControl(recorders[name].port)])))
    const mainWorld = await session.call<string>(`
      try { await fetch('http://127.0.0.1:${control.port}/control', { mode: 'no-cors' }); return 'sent' } catch (e) { return 'failed: ' + e }
    `).catch(error => `failed: ${String(error).slice(0, 120)}`)
    // preconnect's positive control on the SAME instrument: the same hint from the app's own document. CSP does not
    // govern hints, so no violation can name the page's; a silent page port means "blocked" only beside this one.
    await session.call<null>(`
      const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://127.0.0.1:${preconnectControl.port}'
      document.head.appendChild(l); setTimeout(() => l.remove(), 5000); return null
    `)
    // STUN's positive control on the SAME mechanism: the app's main world (no constructor removal there) gathers
    // against its own UDP port. Read at scoring time, so ICE has had the whole matrix to send (scoreStunProbe).
    const stunControlOutcome = await mainWorldStunControl(session, stunControl.port, 'stunControlPc')
    await Bun.sleep(2_000)
    run.observe('F: out-of-page controls', {
      processReach, mainWorld, controlHits: control.hits, mainWorldPreconnectHits: preconnectControl.hits, stunControlOutcome,
    })
    run.require('F: the case process reaches every probe port', Object.values(processReach).every(Boolean), JSON.stringify(processReach))
    run.require('F: the app\'s main world reaches a case loopback port', control.hits > 0,
      `main-world fetch ${mainWorld}; the control port saw ${control.hits} connection(s) - without it a silent probe proves nothing`)
    const baseHits = Object.fromEntries(names.map(name => [name, recorders[name].hits]))

    const name = `RS-112 frame ${stamp}`
    const slug = await createPage(session, workspaceId, name, 'interactive', framePageHtml(ports))
    ownedPages.push(slug)
    await installInbox(session)
    await navigateRoute(session, `pages/page/${slug}`)
    const hello = await waitFor(() => inbox(session, name, 'hello'), rows => rows.length > 0, { timeoutMs: 20_000, intervalMs: 500 })
      .then(rows => rows[rows.length - 1]!.msg).catch(() => null)
    run.require('F: the probe page rendered and said hello', hello !== null, 'no hello from the frame within 20 s')
    run.check('F: compatMode is standards mode (the builder\'s doctype)', hello!.compatMode === 'CSS1Compat',
      `document.compatMode reads ${JSON.stringify(hello!.compatMode)}`)
    const rectOf = (key: string) => hello![key] as { x: number; y: number; width: number; height: number }

    // ---- open-url: the full URL, and Cancel opens nothing ----
    await session.call<null>(`
      const api = window.electronAPI
      window.__rs112.openUrlCalls = []
      window.__rs112.openUrlOriginal = Object.getOwnPropertyDescriptor(api, 'openUrl')
      // The playground's overrideElectronApiMethod shape: shadow, never assign. A refusal leaves installed=false (UNMEASURED).
      try { Object.defineProperty(api, 'openUrl', { value: async (url) => { window.__rs112.openUrlCalls.push(String(url)) }, configurable: true, writable: true, enumerable: true }) } catch (e) { /* read back below */ }
      return null
    `)
    let dialogText = ''
    let cancelled = 'not-attempted'
    try {
      await clickInFrame(session, name, rectOf('link'), 'F: Open link')
      dialogText = await waitFor(() => session.call<string>(`
        const d = Array.from(document.querySelectorAll('[role="dialog"]')).pop(); return d ? d.innerText : ''
      `), text => text.length > 0, { timeoutMs: 8_000, intervalMs: 250 }).catch(() => '')
      const cancel = await session.call<{ x: number; y: number } | null>(`
        const d = Array.from(document.querySelectorAll('[role="dialog"]')).pop(); if (!d) return null
        const b = Array.from(d.querySelectorAll('button')).find(${buttonTextInPage(CANCEL_BUTTON_TEXTS)})
        if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      `)
      if (cancel) { await clickAt(session, cancel, 'F: Cancel'); cancelled = 'pressed' } else cancelled = 'no Cancel button'
      await Bun.sleep(1_500)
    } catch (error) {
      cancelled = `failed: ${String(error).slice(0, 200)}`
    }
    const openState = await session.call<{ calls: string[]; dialogOpen: boolean; installed: boolean }>(`
      const calls = window.__rs112.openUrlCalls.slice()
      const installed = Object.getOwnPropertyDescriptor(window.electronAPI, 'openUrl')?.value?.toString().includes('openUrlCalls') === true
      const orig = window.__rs112.openUrlOriginal
      try { if (installed) { if (orig) Object.defineProperty(window.electronAPI, 'openUrl', orig); else delete window.electronAPI.openUrl } } catch (e) { /* nothing to restore */ }
      return { calls, dialogOpen: !!document.querySelector('[role="dialog"]'), installed }
    `)
    run.observe('F: open-url', { dialogText: dialogText.slice(0, 400), cancelled, ...openState })
    run.check('F: the confirmation shows the FULL URL', dialogText.includes(OPEN_URL), `the dialog read ${JSON.stringify(dialogText.slice(0, 300))}`)
    run.check('F: Cancel opens nothing', openState.installed && cancelled === 'pressed' && openState.calls.length === 0 && !openState.dialogOpen,
      !openState.installed ? 'UNMEASURED - the openUrl recorder could not be installed on the bridge'
        : `cancel ${cancelled}; openUrl called ${JSON.stringify(openState.calls)}; dialog still open: ${openState.dialogOpen}`)

    // ---- the egress matrix ----
    // The embedder's own violations: a self-navigation its frame-src refuses is reported HERE, not in F (see
    // selfNavigationEvidence). Installed before the click; the reading is filtered to the self-navigation port.
    await session.call<null>(`
      window.__rs112.parentViolations = []
      if (!window.__rs112.parentListener) {
        window.__rs112.parentListener = e => window.__rs112.parentViolations.push({ uri: String(e.blockedURI), directive: String(e.effectiveDirective || e.violatedDirective) })
        document.addEventListener('securitypolicyviolation', window.__rs112.parentListener)
      }
      return null
    `)
    await clickInFrame(session, name, rectOf('run'), 'F: Run probes')
    const results = await waitFor(() => inbox(session, name, 'results'), rows => rows.length > 0, { timeoutMs: 15_000, intervalMs: 500 })
      .then(rows => rows[0]!.msg).catch(() => null)
    await Bun.sleep(SETTLE_MS)
    const alive = await inbox(session, name, 'alive')
    run.require('F: the probes ran and reported', results !== null, 'no results message within 15 s of the click')
    const outcomes = (results!.outcomes ?? {}) as Record<string, string>
    const violations = frameViolations((await inbox(session, name)).map(row => row.msg))
    const parentViolations = await session.call<ViolationRead[]>(`return (window.__rs112.parentViolations || []).slice()`)
    const hits = (key: (typeof names)[number]) => recorders[key].hits - (baseHits[key] as number)
    const named = (needle: string) => violations.some(v => v.uri.includes(needle))
    const portViolation = (key: (typeof names)[number]) => violations.some(v => namesPort(v.uri, recorders[key].port))
    const rows: Array<[string, EgressEvidence]> = [
      ['https fetch', { hits: hits('fetchHttps'), violation: portViolation('fetchHttps'), refusedInPage: false, loadedInPage: false }],
      ['WebSocket (wss)', { hits: hits('wss'), violation: portViolation('wss'), refusedInPage: false, loadedInPage: false }],
      ['<img> beacon (https)', { hits: hits('imgHttps'), violation: portViolation('imgHttps'), refusedInPage: false, loadedInPage: false }],
      ['form POST', { hits: hits('formPost'), violation: portViolation('formPost'), refusedInPage: false, loadedInPage: false }],
      ['file: image', { hits: null, violation: named('file'), refusedInPage: false, loadedInPage: outcomes['file-image'] === 'loaded' }],
      ['loopback fetch', { hits: hits('loopbackFetch'), violation: portViolation('loopbackFetch'), refusedInPage: false, loadedInPage: false }],
      ['loopback ws', { hits: hits('loopbackWs'), violation: portViolation('loopbackWs'), refusedInPage: false, loadedInPage: false }],
      ['window.open', { hits: hits('windowOpen'), violation: portViolation('windowOpen'), refusedInPage: outcomes['window-open'] === 'refused (null)', loadedInPage: false }],
      ['self-navigation', selfNavigationEvidence({
        hits: hits('selfNav'), port: recorders.selfNav.port, frameViolations: violations, parentViolations, aliveBeats: alive.length,
      })],
      // refusedInPage here = the app document's identical hint DID connect (the mechanism is live) and the page's did not.
      ['preconnect', { hits: hits('preconnect'), violation: portViolation('preconnect'), refusedInPage: preconnectControl.hits > 0, loadedInPage: false }],
    ]
    run.observe('F: in-page outcomes', { outcomes, violations, parentViolations, aliveBeats: alive.length })
    run.observe('F: port first bytes', Object.fromEntries(names.map(key => [key, recorders[key].firstBytes])))
    const matrix: Record<string, string> = {}
    for (const [probe, evidence] of rows) {
      const score = scoreEgressProbe(evidence)
      matrix[probe] = score.verdict
      run.check(`F: ${probe} is blocked`, score.verdict === 'blocked', `${score.verdict.toUpperCase()}: ${score.detail}`)
    }
    const stunScore = scoreStunProbe({
      top: { outcome: outcomes.stun, hits: stun.hits },
      realm: { outcome: outcomes['stun-realm'], hits: stunRealm.hits },
      controlHits: stunControl.hits,
    })
    matrix.STUN = stunScore.verdict
    run.observe('F: STUN', { top: outcomes.stun ?? null, realm: outcomes['stun-realm'] ?? null, topHits: stun.hits, realmHits: stunRealm.hits, controlHits: stunControl.hits })
    run.check('F: STUN is blocked (F\'s realm and a fresh same-origin realm)', stunScore.verdict === 'blocked', `${stunScore.verdict.toUpperCase()}: ${stunScore.detail}`)
    const dns = await dnsVerdict(session)
    matrix['dns-prefetch'] = dns.verdict
    run.check('F: dns-prefetch is blocked', dns.verdict === 'blocked', `${dns.verdict.toUpperCase()}: ${dns.detail}`)
    run.observe('F: the egress matrix', matrix)
  } finally {
    for (const recorder of [...Object.values(recorders), stun, stunRealm, stunControl, control, preconnectControl]) recorder.stop()
  }
}

/**
 * R (UA12.170): a Page script that renames its frame and then self-navigates must never be opened silently. The port's
 * out-of-page control first (the case process reaches it); the leak is any connection on it - the system browser
 * loading the URL the host handed to `shell.openExternal`.
 */
async function driveRename(run: CaseRun, session: CdpSession, workspaceId: string, stamp: string, ownedPages: string[]): Promise<void> {
  const recorder = tcpRecorder()
  try {
    const reach = await processControl(recorder.port)
    run.require('R: the case process reaches the rename port', reach, `127.0.0.1:${recorder.port} refused the case's own connection`)
    const base = recorder.hits
    const name = `RS-112 rename ${stamp}`
    const slug = await createPage(session, workspaceId, name, 'interactive', renamePageHtml(recorder.port))
    ownedPages.push(slug)
    await installInbox(session)
    await navigateRoute(session, `pages/page/${slug}`)
    const hello = await waitFor(() => inbox(session, name, 'hello'), rows => rows.length > 0, { timeoutMs: 20_000, intervalMs: 500 })
      .then(rows => rows[rows.length - 1]!.msg).catch(() => null)
    run.require('R: the rename page rendered and said hello', hello !== null, 'no hello from the frame within 20 s')
    await session.call<null>(`
      window.__rs112.parentViolations = []
      if (!window.__rs112.parentListener) {
        window.__rs112.parentListener = e => window.__rs112.parentViolations.push({ uri: String(e.blockedURI), directive: String(e.effectiveDirective || e.violatedDirective) })
        document.addEventListener('securitypolicyviolation', window.__rs112.parentListener)
      }
      return null
    `)
    await clickInFrame(session, name, hello!.go as { x: number; y: number; width: number; height: number }, 'R: Rename and navigate')
    const renamed = await waitFor(() => inbox(session, name, 'renamed'), rows => rows.length > 0, { timeoutMs: 8_000, intervalMs: 250 })
      .then(rows => rows[0]!.msg).catch(() => null)
    // The UA12.170 build raises a native "Open link?" box here; the operator presses Cancel (the case cannot see it).
    await Bun.sleep(SETTLE_MS)
    const alive = await inbox(session, name, 'alive')
    const violations = frameViolations((await inbox(session, name)).map(row => row.msg))
    const parentViolations = await session.call<ViolationRead[]>(`return (window.__rs112.parentViolations || []).slice()`)
    const evidence = selfNavigationEvidence({
      hits: recorder.hits - base, port: recorder.port, frameViolations: violations, parentViolations, aliveBeats: alive.length,
    })
    const score = scoreEgressProbe(evidence)
    run.observe('R: rename then navigate', {
      renamed, aliveBeats: alive.length, violations, parentViolations, hits: recorder.hits - base, firstBytes: recorder.firstBytes,
    })
    run.check('R: the script really renamed its frame', renamed?.after === RENAME_FRAME_NAME,
      `the frame reported ${JSON.stringify(renamed)} - without the rename this arm measures F's self-navigation again`)
    run.check('R: a renamed frame\'s navigation is never opened silently', score.verdict === 'blocked', `${score.verdict.toUpperCase()}: ${score.detail}`)
  } finally {
    recorder.stop()
  }
}

/**
 * STUN's positive control on the SAME mechanism: the app's main world (no constructor removal there) gathers against
 * a control UDP port. `slot` keeps the connection referenced under `window.__rs112` until it closes itself after 60 s.
 */
async function mainWorldStunControl(session: CdpSession, port: number, slot: string): Promise<string> {
  return await session.call<string>(`
    try {
      const Ctor = window.RTCPeerConnection
      if (!Ctor) return 'absent'
      const pc = new Ctor({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] })
      window.__rs112[${JSON.stringify(slot)}] = pc
      pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer())
      setTimeout(() => { try { pc.close() } catch (e) {} }, 60000)
      return 'constructed'
    } catch (e) { return 'threw: ' + e }
  `).catch(error => `failed: ${String(error).slice(0, 120)}`)
}

async function dnsVerdict(session: CdpSession): Promise<{ verdict: EgressVerdict; detail: string }> {
  const file = process.env.NESSY_CDP_RS112_DNS_CAPTURE
  if (!file) return scoreDnsCapture(null)
  // The positive control on the SAME mechanism, as preconnect's: the identical hint from the app's own document (CSP
  // does not govern hints). Only Chromium's own prefetch reaching the capture makes a silent probe host a block.
  await session.call<null>(`
    const l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = '//${DNS_CONTROL_HOST}'
    document.head.appendChild(l); setTimeout(() => l.remove(), 5000); return null
  `)
  await Bun.sleep(2_000)
  return scoreDnsCapture(existsSync(file) ? readFileSync(file, 'utf8') : null)
}

/**
 * UA12.106 — TS's poster, sampled in the app's main world (its CSP allows `data:` images; a `data:` image never taints
 * the canvas): the mean RGB of a 40 px square at the centre of each half (TS's realm left, the fresh realm right).
 * null while no poster exists.
 */
async function stunPosterSample(session: CdpSession, workspaceId: string, slug: string): Promise<{ top: number[]; realm: number[]; width: number; height: number } | null> {
  return await session.call<{ top: number[]; realm: number[]; width: number; height: number } | null>(`
    const thumb = await window.electronAPI.getPageThumbnail(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)})
    if (!thumb) return null
    const img = new Image(); img.src = thumb.dataUrl; await img.decode()
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
    const mean = (cx) => {
      const d = ctx.getImageData(Math.round(cx) - 20, Math.round(canvas.height / 2) - 20, 40, 40).data
      const sum = [0, 0, 0]
      for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2] }
      return sum.map(v => Math.round(v / (d.length / 4)))
    }
    return { top: mean(canvas.width / 4), realm: mean(canvas.width * 3 / 4), width: canvas.width, height: canvas.height }
  `)
}

/**
 * UA12.116 — T's poster, sampled in the app's main world (the same `data:`-image canvas read as {@link stunPosterSample}):
 * the mean RGB of a square at the centre of each band, top to bottom in {@link THUMB_PROBE_ORDER}. The square's side is a
 * fraction of the poster height so it stays inside its band at any capture size. null while no poster exists.
 */
async function thumbPosterMarks(session: CdpSession, workspaceId: string, slug: string): Promise<number[][] | null> {
  return await session.call<number[][] | null>(`
    const thumb = await window.electronAPI.getPageThumbnail(${JSON.stringify(workspaceId)}, ${JSON.stringify(slug)})
    if (!thumb) return null
    const img = new Image(); img.src = thumb.dataUrl; await img.decode()
    const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
    const side = Math.max(4, Math.floor(canvas.height / 28))
    const names = ${JSON.stringify([...THUMB_PROBE_ORDER])}
    return names.map((_, i) => {
      const d = ctx.getImageData(Math.round(canvas.width / 2) - side / 2, Math.round(canvas.height * (i + 0.5) / names.length) - side / 2, side, side).data
      const sum = [0, 0, 0]
      for (let j = 0; j < d.length; j += 4) { sum[0] += d[j]; sum[1] += d[j + 1]; sum[2] += d[j + 2] }
      return sum.map(v => Math.round(v / (d.length / 4)))
    })
  `)
}

async function driveThumbnail(run: CaseRun, session: CdpSession, workspaceId: string, stamp: string, ownedPages: string[]): Promise<void> {
  const names = THUMB_PROBE_ORDER
  const recorders = Object.fromEntries(names.map(name => [name, tcpRecorder()])) as Record<(typeof names)[number], PortRecorder>
  const stun = await udpRecorder()
  const stunRealm = await udpRecorder()
  const stunControl = await udpRecorder()
  try {
    const { reach: processReach, base } = await controlledBaseline(recorders)
    run.require('T: the case process reaches every probe port', Object.values(processReach).every(Boolean), JSON.stringify(processReach))
    const stunControlOutcome = await mainWorldStunControl(session, stunControl.port, 'thumbStunControlPc')
    const ports = Object.fromEntries(names.map(name => [name, recorders[name].port])) as unknown as ThumbPorts
    const slug = await createPage(session, workspaceId, `RS-112 thumbnail ${stamp}`, 'interactive', thumbPageHtml(ports))
    ownedPages.push(slug)
    // UA12.106: STUN on its own page TS, so T's navigations cannot replace the document before its STUN sends.
    const stunSlug = await createPage(session, workspaceId, `RS-112 thumbnail STUN ${stamp}`, 'interactive', thumbStunPageHtml({ stunUdp: stun.port, stunRealmUdp: stunRealm.port }))
    ownedPages.push(stunSlug)
    // UA12.116: the poster, sampled per probe band - the case's positive that the capture demonstrably ran T's bytes.
    const marksSample = await waitFor(() => thumbPosterMarks(session, workspaceId, slug), rows => rows !== null, { timeoutMs: THUMB_WAIT_MS, intervalMs: 1_000 })
      .catch(() => null)
    const stunSample = await waitFor(() => stunPosterSample(session, workspaceId, stunSlug), sample => sample !== null, { timeoutMs: THUMB_WAIT_MS, intervalMs: 1_000 })
      .catch(() => null)
    await Bun.sleep(THUMB_WAIT_MS - 5_000)
    const hits = Object.fromEntries(names.map(name => [name, recorders[name].hits - (base[name] as number)]))
    const egressMarks = marksSample ? Object.fromEntries(names.map((name, i) => [name, classifyEgressMark(marksSample[i])])) : null
    const score = scoreThumbnailEgress(hits, egressMarks)
    run.observe('T: the thumbnail arm', { posterSeen: marksSample !== null, marksSample, marks: egressMarks, hits, firstBytes: Object.fromEntries(names.map(name => [name, recorders[name].firstBytes])) })
    run.check('T: the thumbnail capture makes no network request', score.ok, score.detail)
    const marks = stunSample ? { top: classifyStunMark(stunSample.top), realm: classifyStunMark(stunSample.realm) } : null
    const stunScore = scoreThumbnailStun({ topHits: stun.hits, realmHits: stunRealm.hits, controlHits: stunControl.hits, posterSeen: stunSample !== null, marks })
    run.observe('T: STUN', {
      topHits: stun.hits, realmHits: stunRealm.hits, controlHits: stunControl.hits, stunControlOutcome, posterSample: stunSample, marks, verdict: stunScore.verdict,
    })
    run.check('T: the thumbnail capture sends no STUN (TS\'s realm and a fresh realm, each with its in-page mark)', stunScore.verdict === 'blocked', `${stunScore.verdict.toUpperCase()}: ${stunScore.detail}`)
  } finally {
    for (const recorder of [...Object.values(recorders), stun, stunRealm, stunControl]) recorder.stop()
  }
}

export async function drive(run: CaseRun, session: CdpSession): Promise<void> {
  await assertElectronApi(session)
  await ensureDarkTheme(session)
  run.observe('window', await focusWindow(session))
  const workspaceId = await activeWorkspaceId(session)
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const ownedPages: string[] = []
  const ownedSessions: string[] = []
  try {
    await installInbox(session)
    // The frame and thumbnail arms first: they need no card and no turn.
    for (const [label, arm] of [['T', driveThumbnail], ['F', driveFrame], ['R', driveRename]] as const) {
      try {
        await arm(run, session, workspaceId, stamp, ownedPages)
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check(`${label}: completed its arms`, false, String(error).slice(0, 300))
      }
    }

    const liveName = `RS-112 live ${stamp}`
    const liveSlug = await createPage(session, workspaceId, liveName, 'live', livePageHtml())
    ownedPages.push(liveSlug)

    const connections = await listConnections(session)
    const cards: Array<[SittingRuntime, string | undefined]> = [
      ['pi', connections.find(row => runtimeOf(row.providerType) === 'pi')?.slug],
      ['claude', connections.find(row => runtimeOf(row.providerType) === 'anthropic')?.slug],
      ['codex', connections.find(row => runtimeOf(row.providerType) === 'codex-runtime')?.slug],
    ]
    run.observe('cards', Object.fromEntries(cards))
    const selected = cards.filter(([name]) => RUNTIME_WANTED.includes(name))
    if (selected.length === 0) blocked(`NESSY_CDP_RS112_RUNTIMES=${RUNTIME_WANTED.join(',')} names no runtime family`)
    for (const [runtime, slug] of selected) {
      if (!slug) {
        run.check(`${runtime}: measured`, false, 'UNMEASURED - no card of this family on the host; the 6+7 unit needs all three runtimes')
        continue
      }
      try {
        await driveRuntime(run, session, runtime, slug, workspaceId, { slug: liveSlug, name: liveName }, ownedPages, ownedSessions)
      } catch (error) {
        if (error instanceof BlockedError) throw error
        run.check(`${runtime}: completed its arms`, false, String(error).slice(0, 300))
      }
    }
  } finally {
    await ensureNoCard(session, `${ID} cleanup`).catch(() => null)
    await navigateRoute(session, 'allSessions').catch(() => undefined)
    const pages: Record<string, string> = {}
    for (const slug of ownedPages) pages[slug] = await deletePageQuietly(session, workspaceId, slug)
    const sessions: Record<string, string> = {}
    for (const id of ownedSessions) {
      sessions[id] = await session.call<string>(`
        try { await window.electronAPI.deleteSession(${JSON.stringify(id)}); return 'deleted' }
        catch (e) { return 'delete failed: ' + String(e && e.message || e).slice(0, 160) }
      `).catch(error => `delete failed: ${String(error).slice(0, 160)}`)
    }
    run.observe('cleanup', { pages, sessions })
  }
}

if (import.meta.main) {
  await main(ID, TITLE, drive)
}
