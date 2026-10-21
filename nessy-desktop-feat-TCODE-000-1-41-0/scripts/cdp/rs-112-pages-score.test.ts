/**
 * UA7.6 — the RS-112 scorers (`cases/rs-112.ts`), offline: a connection on a probe's own port is a LEAK whatever the
 * page said; a BLOCK needs a silent port AND in-page evidence; anything else is UNMEASURED and never a pass. The
 * thumbnail arm needs the poster carrying every probe's issued mark as the positive that the capture ran T's bytes
 * (UA12.116, the poster-mark technique of UA12.106) — a probe with no mark scores UNMEASURED, never a pass. The
 * delete card must name the page and offer no durable answer. The case-authored pages carry no doctype (F, so
 * `compatMode` measures the builder's) and aim every probe at the port the case gave it.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PageDataStore } from '@nessy-agent/shared/pages/data-store'
import {
  ARM_A_WRITE, classifyEgressMark, classifyStunMark, controlledBaseline, framePageHtml, frameViolations, meta, processControl, scoreDeleteCard, scoreDnsCapture,
  scoreEgressProbe, scoreStunProbe, scoreThumbnailEgress, scoreThumbnailStun, selfNavigationEvidence, STUN_MARK_DELAY_MS, STUN_MARK_RGB, tcpRecorder,
  THUMB_PROBE_ORDER, thumbPageHtml, thumbStunPageHtml, udpRecorder, type EgressMark, type FramePorts, type PortRecorder,
  RENAME_FRAME_NAME, renamePageHtml,
} from './cases/rs-112.ts'
import type { CardRead } from './lib/permission-card.ts'

const quiet = { hits: 0, violation: false, refusedInPage: false, loadedInPage: false }
const THUMB_PORTS = { imgHttps: 1, fetch: 2, ws: 3, windowOpen: 4, metaRefresh: 5, location: 6, preconnect: 7 }
const THUMB_STUN_PORTS = { stunUdp: 8, stunRealmUdp: 9 }

describe('RS-112 egress scoring', () => {
  it('a violation over a silent port is blocked; an absent API over a silent port is blocked', () => {
    expect(scoreEgressProbe({ ...quiet, violation: true }).verdict).toBe('blocked')
    expect(scoreEgressProbe({ ...quiet, refusedInPage: true }).verdict).toBe('blocked')
  })

  it('NEGATIVE — a connection is a leak even beside a violation; a file: image that loaded is a leak', () => {
    expect(scoreEgressProbe({ ...quiet, hits: 1, violation: true }).verdict).toBe('leaking')
    expect(scoreEgressProbe({ ...quiet, hits: null, violation: true, loadedInPage: true }).verdict).toBe('leaking')
  })

  it('NEGATIVE — a silent port with no in-page evidence is unmeasured, never blocked', () => {
    const score = scoreEgressProbe(quiet)
    expect(score.verdict).toBe('unmeasured')
    expect(score.detail).toContain('UNMEASURED')
    expect(scoreEgressProbe({ ...quiet, hits: null }).verdict).toBe('unmeasured')
  })

  it('the thumbnail arm passes only with every port silent, the poster seen, and every probe painted issued (UA12.116)', () => {
    const silent = Object.fromEntries(THUMB_PROBE_ORDER.map(name => [name, 0]))
    const issued = Object.fromEntries(THUMB_PROBE_ORDER.map(name => [name, 'issued' as const]))
    expect(scoreThumbnailEgress(silent, issued).ok).toBe(true)
    expect(scoreThumbnailEgress({ fetch: 0, location: 2 }, issued)).toEqual({ ok: false, detail: 'LEAK from the thumbnail window: location=2' })
    const noPoster = scoreThumbnailEgress({ fetch: 0 }, null)
    expect(noPoster.ok).toBe(false)
    expect(noPoster.detail).toContain('UNMEASURED')
  })

  it('NEGATIVE (UA12.116) — a probe with no issued mark scores UNMEASURED, never OK, and names it', () => {
    const marks = Object.fromEntries(THUMB_PROBE_ORDER.map(name => [name, 'issued' as const])) as Record<(typeof THUMB_PROBE_ORDER)[number], EgressMark>
    marks.windowOpen = 'unknown'
    const score = scoreThumbnailEgress(Object.fromEntries(THUMB_PROBE_ORDER.map(name => [name, 0])), marks)
    expect(score.ok).toBe(false)
    expect(score.detail).toContain('UNMEASURED')
    expect(score.detail).toContain('windowOpen')
  })

  it('UA12.116 — the issued mark is the attempted green; pending grey, another mark colour and no sample read unknown', () => {
    expect(classifyEgressMark(STUN_MARK_RGB.attempted)).toBe('issued')
    expect(classifyEgressMark(STUN_MARK_RGB.pending)).toBe('unknown')
    expect(classifyEgressMark(STUN_MARK_RGB.absent)).toBe('unknown')
    expect(classifyEgressMark([50, 130, 50])).toBe('issued') // a jpeg-muddied green, inside the mark tolerance
    expect(classifyEgressMark([150, 140, 140])).toBe('unknown') // a jpeg-muddied pending grey
    expect(classifyEgressMark(null)).toBe('unknown')
  })

  it('dns-prefetch: no capture or no control lookup is unmeasured; the probe host is a leak', () => {
    expect(scoreDnsCapture(null).verdict).toBe('unmeasured')
    expect(scoreDnsCapture('A? example.org').verdict).toBe('unmeasured')
    expect(scoreDnsCapture('A? rs112-dns-control.egress-probe.invalid').verdict).toBe('blocked')
    expect(scoreDnsCapture('A? rs112-dns-control.egress-probe.invalid A? rs112-dns-prefetch.egress-probe.invalid').verdict).toBe('leaking')
  })
})

describe('RS-112 delete card', () => {
  const card = (over: Partial<CardRead>): CardRead => ({
    present: true, text: 'Delete the page "RS-112 pi 1" (rs-112-pi-1) with its content and data.', labels: ['Allow', 'Deny'],
    scope: null, durableOffered: false, ...over,
  })

  it('a one-shot card naming the page passes', () => {
    expect(scoreDeleteCard(card({}), 'RS-112 pi 1').ok).toBe(true)
  })

  it('NEGATIVE — no card, another page, or an Always Allow fails', () => {
    expect(scoreDeleteCard(null, 'RS-112 pi 1').ok).toBe(false)
    expect(scoreDeleteCard(card({ present: false }), 'RS-112 pi 1').ok).toBe(false)
    expect(scoreDeleteCard(card({}), 'RS-112 codex 1').ok).toBe(false)
    expect(scoreDeleteCard(card({ durableOffered: true, labels: ['Allow', 'Always Allow', 'Deny'] }), 'RS-112 pi 1').ok).toBe(false)
  })
})

describe('RS-112 case-authored pages', () => {
  const ports: FramePorts = {
    fetchHttps: 40001, wss: 40002, imgHttps: 40003, formPost: 40004, loopbackFetch: 40005, loopbackWs: 40006,
    windowOpen: 40007, preconnect: 40008, selfNav: 40009, stunUdp: 40010, stunRealmUdp: 40011,
  }

  it('F has no doctype of its own and aims each probe at its own port', () => {
    const html = framePageHtml(ports)
    expect(html.trimStart().toLowerCase().startsWith('<!doctype')).toBe(false)
    expect(html).toContain('https://127.0.0.1:40001/')
    expect(html).toContain('wss://127.0.0.1:40002/')
    expect(html).toContain('stun:127.0.0.1:40010')
    expect(html).toContain("rel = 'dns-prefetch'")
    for (const port of Object.values(ports)) expect(html).toContain(`127.0.0.1:${port}`)
  })

  it('T runs on load (no click gate) and carries the meta refresh and the location assignment', () => {
    const html = thumbPageHtml(THUMB_PORTS)
    expect(html).toContain('http-equiv="refresh" content="0;url=http://127.0.0.1:5/t"')
    expect(html).toContain("location.href = 'http://127.0.0.1:6/t'")
    expect(html).not.toContain('addEventListener(\'click\'')
  })

  it('UA12.116 — T paints one band per recorded probe in THUMB_PROBE_ORDER, and paints it issued at each probe', () => {
    const html = thumbPageHtml(THUMB_PORTS)
    // The bands are created from the very order the drive reads back, one band div per probe, hooked by name:
    expect(html).toContain(JSON.stringify([...THUMB_PROBE_ORDER]))
    expect(html).toContain('band.dataset.rs112Band = name')
    // The two head probes issue before <body> exists, so they record in the head and the body's first script paints them;
    // every body probe paints at its issue, and the location probe paints BEFORE its navigation replaces the document.
    expect(html).toContain(`__rs112Issued = ['metaRefresh', 'preconnect']`)
    for (const name of ['imgHttps', 'fetch', 'ws', 'windowOpen'] as const) expect(html).toContain(`paint('${name}')`)
    expect(html).toMatch(/paint\('location'\); try \{ location\.href = /)
  })

  // The thumbnailer destroys its window right after the first non-empty capture, which it takes RENDER_SETTLE_MS after
  // the host load (apps/electron/src/main/page-thumbnailer.ts renderAndCapture); a navigation probe scheduled later
  // never runs, so its port is silent on a leaking build too. Read the settle from the thumbnailer's source, not a copy.
  const settleMs = (() => {
    const source = readFileSync(join(import.meta.dir, '../../apps/electron/src/main/page-thumbnailer.ts'), 'utf8')
    const match = /const RENDER_SETTLE_MS = ([\d_]+)/.exec(source)
    const value = match?.[1]
    if (!value) throw new Error('RENDER_SETTLE_MS not found in page-thumbnailer.ts - re-point this pin')
    return Number(value.replace(/_/g, ''))
  })()
  const navigationDelaysMs = (html: string): { metaRefresh: number | null; location: number | null } => {
    const refresh = /http-equiv="refresh" content="(\d+(?:\.\d+)?);/.exec(html)
    const location = /setTimeout\(\(\) => \{ paint\('location'\); try \{ location\.href = [^\n]*\}, (\d+)\)/.exec(html)
    return { metaRefresh: refresh ? Number(refresh[1]) * 1000 : null, location: location ? Number(location[1]) : null }
  }

  it('T schedules its meta refresh and location assignment inside the capture window (below RENDER_SETTLE_MS)', () => {
    expect(settleMs).toBeGreaterThan(0)
    const delays = navigationDelaysMs(thumbPageHtml(THUMB_PORTS))
    expect(delays.metaRefresh).not.toBeNull()
    expect(delays.location).not.toBeNull()
    expect(delays.metaRefresh as number).toBeLessThan(settleMs)
    expect(delays.location as number).toBeLessThan(settleMs)
  })

  it('BOUNDARY: a 1 s meta refresh reads as outliving the capture window', () => {
    const delays = navigationDelaysMs(`<meta http-equiv="refresh" content="1;url=http://127.0.0.1:5/t">
  setTimeout(() => { paint('location'); try { location.href = 'http://127.0.0.1:6/t' } catch (e) {} }, 400)`)
    expect(delays).toEqual({ metaRefresh: 1000, location: 400 })
    expect(delays.metaRefresh as number).toBeGreaterThanOrEqual(settleMs)
  })

  it('meta names the plan row and the three runtime families', () => {
    expect(meta).toMatchObject({ id: 'RS-112', row: 'UA7.6' })
    expect([...meta.runtimes]).toEqual(['pi', 'claude', 'codex'])
  })
})

describe('RS-112 arm A write patch', () => {
  /** The patch applied as the product's store applies it: kv set, then one appendSeries batch per series. */
  function applied(patch: { set: Record<string, unknown>; appendSeries: Record<string, ReadonlyArray<{ t?: number; v: number }>> }) {
    const dir = mkdtempSync(join(tmpdir(), 'rs112-arm-a-'))
    const store = new PageDataStore(join(dir, 'data.sqlite'), join(dir, 'snapshot.json'))
    try {
      for (const [key, value] of Object.entries(patch.set)) store.kvSet(key, value)
      for (const [series, points] of Object.entries(patch.appendSeries)) store.seriesAppendMany(series, points.map(point => ({ ...point })))
      return store.exportSnapshot()
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('the patch the agent is told to send leaves the total and all three points, in order, in the real store', () => {
    const snapshot = applied(ARM_A_WRITE)
    expect((snapshot.kv.summary as { total: number }).total).toBe(42)
    expect(snapshot.series['ci.duration_ms']?.map(point => point.v)).toEqual([81000, 79000, 83000])
  })

  it('BOUNDARY — points with no t share one Date.now() and upsert into a single point', () => {
    const snapshot = applied({ set: {}, appendSeries: { 'ci.duration_ms': [{ v: 81000 }, { v: 79000 }, { v: 83000 }] } })
    expect(snapshot.series['ci.duration_ms']?.length).toBeLessThan(3)
  })
})

describe('RS-112 F: evidence that outlives the frame', () => {
  const port = 40009
  const frameSrc = { uri: `http://127.0.0.1:${port}/f`, directive: 'frame-src' }

  it('a self-navigation the embedder\'s frame-src refused is blocked even though the frame was replaced (no beats)', () => {
    const evidence = selfNavigationEvidence({ hits: 0, port, frameViolations: [], parentViolations: [frameSrc], aliveBeats: 0 })
    expect(scoreEgressProbe(evidence).verdict).toBe('blocked')
  })

  it('a self-navigation the frame survived (the guard\'s quiet cancel) is blocked', () => {
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 0, port, frameViolations: [], parentViolations: [], aliveBeats: 3 })).verdict).toBe('blocked')
  })

  it('NEGATIVE — no beats and no violation is unmeasured; a connection is a leak beside the violation', () => {
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 0, port, frameViolations: [], parentViolations: [], aliveBeats: 0 })).verdict).toBe('unmeasured')
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 1, port, frameViolations: [], parentViolations: [frameSrc], aliveBeats: 0 })).verdict).toBe('leaking')
  })

  it('BOUNDARY — an embedder violation of another directive or another port is not self-navigation\'s evidence', () => {
    const other = [{ uri: `http://127.0.0.1:${port}/f`, directive: 'connect-src' }, { uri: 'http://127.0.0.1:40001/f', directive: 'frame-src' }]
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 0, port, frameViolations: [], parentViolations: other, aliveBeats: 0 })).verdict).toBe('unmeasured')
  })

  it('frameViolations reads the per-event posts, so a form-action violation survives the frame being replaced', () => {
    const formAction = { uri: 'https://127.0.0.1:40004/f', directive: 'form-action' }
    const read = frameViolations([
      { type: 'results', violations: [] },
      { type: 'form-submitted' },
      { type: 'violation', ...formAction },
    ])
    expect(read).toEqual([formAction])
    // The snapshots still count, and one violation reported twice is read once.
    expect(frameViolations([{ type: 'results', violations: [formAction] }, { type: 'violation', ...formAction }])).toEqual([formAction])
    expect(frameViolations([{ type: 'alive', beats: 1, violations: [] }])).toEqual([])
  })

  it('F posts each violation as it happens, not only inside its beats', () => {
    const html = framePageHtml({
      fetchHttps: 1, wss: 2, imgHttps: 3, formPost: 4, loopbackFetch: 5, loopbackWs: 6, windowOpen: 7, preconnect: 8, selfNav: 9, stunUdp: 10, stunRealmUdp: 11,
    })
    expect(html).toContain("violations.push(v); post('violation', v)")
  })
})

describe('RS-112 T baseline — the real tcpRecorder + processControl pair', () => {
  const names = ['imgHttps', 'fetch', 'ws', 'windowOpen', 'metaRefresh', 'location', 'preconnect'] as const

  it('with no probe traffic, no hit lands after the baseline (the control connections are all counted before it)', async () => {
    let lateRounds = 0
    let lateHits = 0
    for (let round = 0; round < 40; round += 1) {
      const recorders = Object.fromEntries(names.map(name => [name, tcpRecorder()])) as Record<(typeof names)[number], PortRecorder>
      try {
        const { reach, base } = await controlledBaseline(recorders)
        expect(Object.values(reach).every(Boolean)).toBe(true)
        await Bun.sleep(50)
        const late = names.reduce((sum, name) => sum + recorders[name].hits - base[name], 0)
        if (late > 0) { lateRounds += 1; lateHits += late }
      } finally {
        for (const recorder of Object.values(recorders)) recorder.stop()
      }
    }
    expect({ lateRounds, lateHits }).toEqual({ lateRounds: 0, lateHits: 0 })
  })

  it('BOUNDARY — a connection after the baseline is still counted, and a dead port reads unreached', async () => {
    const live = tcpRecorder()
    const dead = tcpRecorder()
    dead.stop()
    try {
      const { reach, base } = await controlledBaseline({ live, dead })
      expect(reach).toEqual({ live: true, dead: false })
      expect(await processControl(live.port)).toBe(true)
      const deadline = Date.now() + 2_000
      while (live.hits - base.live < 1 && Date.now() < deadline) await Bun.sleep(10)
      expect(live.hits - base.live).toBe(1)
    } finally {
      live.stop()
    }
  })
})

// A page can reach a FRESH realm's WebRTC constructors through a no-src child <iframe> (about:blank shares the
// sandboxed page's opaque origin and never runs the builder's removal script; apps/electron/src/shared/page-frame-csp.ts
// calls that removal "defence in depth ..., not a boundary"). The top realm's missing constructor is therefore no
// evidence of a block on its own.
describe('RS-112 F: STUN through the top realm AND a fresh realm', () => {
  const silent = { hits: 0 }

  it('F probes a fresh realm through a no-src child iframe, on its own UDP port', () => {
    const html = framePageHtml({
      fetchHttps: 1, wss: 2, imgHttps: 3, formPost: 4, loopbackFetch: 5, loopbackWs: 6, windowOpen: 7, preconnect: 8, selfNav: 9, stunUdp: 10, stunRealmUdp: 11,
    })
    expect(html).toContain("document.createElement('iframe')")
    expect(html).toContain('w.RTCPeerConnection || w.webkitRTCPeerConnection')
    expect(html).toContain('const w = f.contentWindow')
    expect(html).toContain("stunFrom('stun-realm', w, 'stun:127.0.0.1:11')")
    expect(html).toContain('stun:127.0.0.1:11')
    expect(html).toContain('stun:127.0.0.1:10')
  })

  it('NEGATIVE — an absent top realm beside a constructed fresh realm is never blocked without the main-world control', () => {
    const score = scoreStunProbe({ top: { outcome: 'absent', ...silent }, realm: { outcome: 'constructed', ...silent }, controlHits: 0 })
    expect(score.verdict).toBe('unmeasured')
    expect(score.detail).toContain('UNMEASURED')
    expect(scoreStunProbe({ top: { outcome: 'absent', ...silent }, realm: { outcome: 'constructed', ...silent }, controlHits: null }).verdict).toBe('unmeasured')
  })

  it('NEGATIVE — a datagram on either probe port is a leak, whatever the realms said', () => {
    expect(scoreStunProbe({ top: { outcome: 'absent', hits: 0 }, realm: { outcome: 'constructed', hits: 2 }, controlHits: 3 }).verdict).toBe('leaking')
    expect(scoreStunProbe({ top: { outcome: 'absent', hits: 1 }, realm: { outcome: 'absent', hits: 0 }, controlHits: 3 }).verdict).toBe('leaking')
  })

  it('both realms without the constructor (or refusing it) over silent ports is blocked', () => {
    expect(scoreStunProbe({ top: { outcome: 'absent', ...silent }, realm: { outcome: 'absent', ...silent }, controlHits: null }).verdict).toBe('blocked')
    expect(scoreStunProbe({ top: { outcome: 'absent', ...silent }, realm: { outcome: 'threw: SecurityError', ...silent }, controlHits: 0 }).verdict).toBe('blocked')
  })

  it('BOUNDARY — a constructed connection over a silent port is blocked only beside a main-world control that hit', () => {
    expect(scoreStunProbe({ top: { outcome: 'absent', ...silent }, realm: { outcome: 'constructed', ...silent }, controlHits: 1 }).verdict).toBe('blocked')
    // A realm that never reported is unmeasured, even beside a live control.
    expect(scoreStunProbe({ top: { outcome: 'absent', ...silent }, realm: { outcome: undefined, ...silent }, controlHits: 1 }).verdict).toBe('unmeasured')
  })
})

// The thumbnail window renders the SAME builder output with `allow-scripts` for an interactive page, and neither its
// partition's webRequest filter nor its refused permissions see WebRTC's UDP, so the thumbnail arm must probe STUN as F
// does: on load, from its own realm and from a fresh realm, each on its own UDP port - on its own page TS (UA12.106).
// The capture window cannot post out, so its silence counts only beside each realm's mark in the poster and a
// main-world STUN control that arrived.
describe('RS-112 T: STUN from the thumbnail window', () => {
  const quietT = { topHits: 0, realmHits: 0, controlHits: 2, posterSeen: true, marks: { top: 'absent', realm: 'attempted' } as const }

  it('TS probes STUN on load from its realm and from a no-src child iframe, each on its own UDP port', () => {
    const html = thumbStunPageHtml(THUMB_STUN_PORTS)
    expect(html).toContain("stunFrom('top', window, 'stun:127.0.0.1:8')")
    expect(html).toContain("document.createElement('iframe')")
    expect(html).toContain("stunFrom('realm', f.contentWindow, 'stun:127.0.0.1:9')")
    expect(html).toContain('w.RTCPeerConnection || w.webkitRTCPeerConnection')
  })

  it('silent ports beside the poster, both marks and a main-world STUN control that arrived read blocked', () => {
    expect(scoreThumbnailStun(quietT).verdict).toBe('blocked')
  })

  it('NEGATIVE — a datagram on the fresh realm\'s port alone is a leak', () => {
    expect(scoreThumbnailStun({ ...quietT, realmHits: 1 }).verdict).toBe('leaking')
    expect(scoreThumbnailStun({ ...quietT, topHits: 1 }).verdict).toBe('leaking')
  })

  it('BOUNDARY — silence without a control that arrived, or without the poster, is unmeasured', () => {
    expect(scoreThumbnailStun({ ...quietT, controlHits: 0 }).verdict).toBe('unmeasured')
    expect(scoreThumbnailStun({ ...quietT, controlHits: null }).verdict).toBe('unmeasured')
    const noPoster = scoreThumbnailStun({ ...quietT, posterSeen: false })
    expect(noPoster.verdict).toBe('unmeasured')
    expect(noPoster.detail).toContain('UNMEASURED')
  })
})

// UA12.106 — the capture window cannot post out, so silence on T's STUN ports proved nothing once T's own navigation
// probes could replace the document before its STUN sent: a probe that never ran read BLOCKED beside the poster and
// the control. A BLOCKED now needs the probe's own in-page mark (painted into the poster) beside the silent ports.
describe('RS-112 T: an unsent STUN probe is never blocked (UA12.106)', () => {
  const quietT = { topHits: 0, realmHits: 0, controlHits: 2, posterSeen: true }

  it('NEGATIVE — a STUN probe that never sent (no mark in the poster) scores UNMEASURED, never BLOCKED', () => {
    const unsent = scoreThumbnailStun({ ...quietT, marks: { top: 'unknown', realm: 'unknown' } })
    expect(unsent.verdict).toBe('unmeasured')
    expect(unsent.detail).toContain('UNMEASURED')
    expect(scoreThumbnailStun({ ...quietT, marks: { top: 'absent', realm: 'unknown' } }).verdict).toBe('unmeasured')
    expect(scoreThumbnailStun({ ...quietT, marks: null }).verdict).toBe('unmeasured')
  })

  it('both realms refused (absent / threw) over silent ports is blocked, with or without a control', () => {
    expect(scoreThumbnailStun({ ...quietT, controlHits: 0, marks: { top: 'absent', realm: 'threw' } }).verdict).toBe('blocked')
  })

  it('a planted leak — a real datagram on the fresh realm\'s recorder — scores LEAK even with no mark', async () => {
    const realm = await udpRecorder()
    const sender = await Bun.udpSocket({ hostname: '127.0.0.1', port: 0 })
    try {
      sender.send('rs112-planted', realm.port, '127.0.0.1')
      const deadline = Date.now() + 2_000
      while (realm.hits < 1 && Date.now() < deadline) await Bun.sleep(10)
      expect(realm.hits).toBeGreaterThan(0)
      expect(scoreThumbnailStun({ ...quietT, realmHits: realm.hits, marks: null }).verdict).toBe('leaking')
      expect(scoreThumbnailStun({ ...quietT, realmHits: realm.hits, posterSeen: false, marks: { top: 'unknown', realm: 'unknown' } }).verdict).toBe('leaking')
    } finally {
      sender.close()
      realm.stop()
    }
  })

  it('the poster classifier reads each painted colour, through JPEG-sized noise; pending, other colours and no sample are unknown', () => {
    expect(classifyStunMark([...STUN_MARK_RGB.attempted])).toBe('attempted')
    expect(classifyStunMark([...STUN_MARK_RGB.absent])).toBe('absent')
    expect(classifyStunMark([...STUN_MARK_RGB.threw])).toBe('threw')
    expect(classifyStunMark([22, 150, 18])).toBe('attempted')
    expect(classifyStunMark([...STUN_MARK_RGB.pending])).toBe('unknown')
    expect(classifyStunMark([255, 255, 255])).toBe('unknown')
    expect(classifyStunMark(null)).toBe('unknown')
    expect(classifyStunMark([0, 170])).toBe('unknown')
  })

  it('TS paints exactly the classifier\'s colours: pending at parse, a mark per realm, each in its own half', () => {
    const html = thumbStunPageHtml(THUMB_STUN_PORTS)
    for (const rgb of Object.values(STUN_MARK_RGB)) expect(html).toContain(`rgb(${rgb.join(', ')})`)
    expect(html).toContain('id="top" class="mark" style="left: 0; background: rgb(128, 128, 128)"')
    expect(html).toContain('id="realm" class="mark" style="left: 50%; background: rgb(128, 128, 128)"')
    expect(html).toContain("if (!Ctor) { paint(id, 'absent'); return }")
    expect(html).toContain("then(mark, () => paint(id, 'threw'))")
    expect(html).toContain("pc.iceGatheringState !== 'new'")
  })

  it('NEGATIVE — TS carries no navigation and no other request, and T carries no STUN (the two are isolated)', () => {
    const ts = thumbStunPageHtml(THUMB_STUN_PORTS)
    for (const needle of ['http-equiv', 'location', 'window.open', 'fetch(', 'WebSocket', '<img', 'preconnect', 'setInterval']) expect(ts).not.toContain(needle)
    const t = thumbPageHtml(THUMB_PORTS)
    expect(t).not.toContain('stun:')
    expect(t).not.toContain('RTCPeerConnection')
  })

  it('TS paints its attempted mark inside the capture window (below RENDER_SETTLE_MS)', () => {
    const source = readFileSync(join(import.meta.dir, '../../apps/electron/src/main/page-thumbnailer.ts'), 'utf8')
    const settle = Number(/const RENDER_SETTLE_MS = ([\d_]+)/.exec(source)?.[1]?.replace(/_/g, '') ?? Number.NaN)
    expect(settle).toBeGreaterThan(0)
    expect(STUN_MARK_DELAY_MS).toBeLessThan(settle)
    expect(thumbStunPageHtml(THUMB_STUN_PORTS)).toContain(`paint(id, 'attempted'), ${STUN_MARK_DELAY_MS})`)
  })
})

describe('RS-112 R: a renamed frame is never opened silently (UA12.170)', () => {
  it('R renames its OWN frame before it self-navigates, to its own port with data in the query, only after a click', () => {
    const html = renamePageHtml(40021)
    const rename = html.indexOf(`window.name = '${RENAME_FRAME_NAME}'`)
    const navigate = html.indexOf("location.href = 'http://127.0.0.1:40021/r?d=rs112-rename-exfil'")
    expect(rename).toBeGreaterThan(-1)
    expect(navigate).toBeGreaterThan(rename)
    // Run on the click, never on load: the poster capture of R's creation must not fire it.
    expect(html.indexOf("getElementById('go').addEventListener('click'")).toBeLessThan(rename)
    expect(RENAME_FRAME_NAME).not.toBe('nessy-page')
  })

  it('R is scored as a self-navigation: a connection on its port (the system browser) is a leak, a surviving frame a block', () => {
    const port = 40021
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 1, port, frameViolations: [], parentViolations: [], aliveBeats: 10 })).verdict).toBe('leaking')
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 0, port, frameViolations: [], parentViolations: [], aliveBeats: 3 })).verdict).toBe('blocked')
    expect(scoreEgressProbe(selfNavigationEvidence({ hits: 0, port, frameViolations: [], parentViolations: [], aliveBeats: 0 })).verdict).toBe('unmeasured')
  })

  it('the drive runs R after F', () => {
    const source = readFileSync(join(import.meta.dir, 'cases', 'rs-112.ts'), 'utf-8')
    expect(source).toContain("[['T', driveThumbnail], ['F', driveFrame], ['R', driveRename]]")
  })
})
