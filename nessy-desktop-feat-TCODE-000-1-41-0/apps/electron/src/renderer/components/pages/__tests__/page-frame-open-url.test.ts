/**
 * UA7.3 — a page's `open-url` (spec §14, OQ-12): nonce, http(s), user activation AND frame focus,
 * then a host confirmation that shows the full URL; only the user's confirm opens it.
 *
 * Driven through the pure gates PageFrame calls (`page-frame-gates.ts`) — this repo's `bun test`
 * has no DOM — plus a wiring guard over PageFrame.tsx's own source, so the gates cannot be
 * bypassed by a direct `openUrl` in the component.
 */
import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { checkPageOpenUrl, settlePageOpenUrl, type PageOpenUrlRequest } from '../page-frame-gates'
import { PageOpenUrlTarget } from '../PageFrame'

const LEASE_NONCE = ['n', 'once', '-', 'a1'].join('')
const URL_OK = 'https://example.com/report?q=1#top'

function req(over: Partial<PageOpenUrlRequest> = {}): PageOpenUrlRequest {
  return {
    nonce: LEASE_NONCE,
    url: URL_OK,
    leaseNonce: LEASE_NONCE,
    userActivation: true,
    frameFocused: true,
    confirmationPending: false,
    ...over,
  }
}

describe('checkPageOpenUrl — what may be put to the user', () => {
  it('POSITIVE: a gesture inside the focused frame, the lease nonce and an https URL go to the confirmation', () => {
    expect(checkPageOpenUrl(req())).toEqual({ ok: true, url: URL_OK })
    expect(checkPageOpenUrl(req({ url: 'http://example.com/' }))).toEqual({ ok: true, url: 'http://example.com/' })
  })

  it('NEGATIVE: a click on the host toolbar (activation, but the frame does not hold focus) is refused', () => {
    expect(checkPageOpenUrl(req({ frameFocused: false }))).toEqual({ ok: false, reason: 'frame-not-focused' })
  })

  it('NEGATIVE: no user activation is refused even with frame focus', () => {
    expect(checkPageOpenUrl(req({ userActivation: false }))).toEqual({ ok: false, reason: 'no-user-activation' })
  })

  it('NEGATIVE: a non-http(s) URL is refused', () => {
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'nessyagents://action/new-chat', 'data:text/html,x', 'not a url']) {
      expect(checkPageOpenUrl(req({ url }))).toEqual({ ok: false, reason: 'unsafe-url' })
    }
  })

  it('NEGATIVE: a nonce other than the lease nonce is refused', () => {
    expect(checkPageOpenUrl(req({ nonce: 'other' }))).toEqual({ ok: false, reason: 'nonce-mismatch' })
  })

  it('NEGATIVE: a second link-out while a confirmation is on screen is refused (one at a time)', () => {
    expect(checkPageOpenUrl(req({ confirmationPending: true }))).toEqual({ ok: false, reason: 'confirmation-pending' })
  })
})

describe('settlePageOpenUrl — the user decides', () => {
  it('POSITIVE: confirm opens exactly the URL the dialog showed, once', () => {
    const opened: string[] = []
    expect(settlePageOpenUrl(URL_OK, 'confirm', u => opened.push(u))).toBeNull()
    expect(opened).toEqual([URL_OK])
  })

  it('NEGATIVE: cancel opens nothing', () => {
    const opened: string[] = []
    expect(settlePageOpenUrl(URL_OK, 'cancel', u => opened.push(u))).toBeNull()
    expect(opened).toEqual([])
  })

  it('NEGATIVE: confirm with nothing pending, or with a non-http(s) URL, opens nothing', () => {
    const opened: string[] = []
    settlePageOpenUrl(null, 'confirm', u => opened.push(u))
    settlePageOpenUrl('file:///etc/passwd', 'confirm', u => opened.push(u))
    expect(opened).toEqual([])
  })
})

describe('the confirmation shows the full URL', () => {
  it('POSITIVE: a long URL is rendered whole, wrapped (break-all), never truncated', () => {
    const long = `https://example.com/${'segment/'.repeat(60)}end?token=visible`
    const html = renderToStaticMarkup(React.createElement(PageOpenUrlTarget, { url: long }))
    expect(html).toContain(long)
    expect(html).toContain('break-all')
    expect(html).not.toContain('truncate')
  })
})

describe('wiring: PageFrame opens a URL only through the gates', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'PageFrame.tsx'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('POSITIVE: the open-url case calls checkPageOpenUrl with frame focus, and openUrl sits inside settlePageOpenUrl', () => {
    expect(code).toMatch(/checkPageOpenUrl\(\{[\s\S]*frameFocused:\s*frame !== null && document\.activeElement === frame/)
    expect(code).toMatch(/settlePageOpenUrl\([^)]*,\s*decision,\s*url => \{\s*void window\.electronAPI\.openUrl\(url\)/)
  })

  it('NEGATIVE: exactly one openUrl call site in the component (no path around the confirmation)', () => {
    expect(code.match(/electronAPI\.openUrl\(/g)?.length).toBe(1)
    // Control: the same counter sees a second call site when one is planted.
    const planted = `${code}\nvoid window.electronAPI.openUrl(msg.url)\n`
    expect(planted.match(/electronAPI\.openUrl\(/g)?.length).toBe(2)
  })

  // StrictMode (main.tsx) runs a state updater twice in a dev render, so a side effect inside
  // one can open the link twice: settle reads and clears the ref, then opens outside any updater.
  const UPDATER_WITH_EFFECT = /setPendingUrl\(\s*\w+\s*=>[^\n]*settlePageOpenUrl/

  it('POSITIVE: settle takes the pending URL from the ref, clears it, then settles outside setState', () => {
    expect(code).toMatch(
      /const settle = useCallback\([\s\S]*?const pending = pendingUrlRef\.current[\s\S]*?pendingUrlRef\.current = null[\s\S]*?setPendingUrl\(null\)[\s\S]*?settlePageOpenUrl\(pending, decision,/,
    )
  })

  it('NEGATIVE: no state updater calls settlePageOpenUrl', () => {
    expect(code).not.toMatch(UPDATER_WITH_EFFECT)
    // Control: the same pattern sees the updater form when it is planted.
    expect('setPendingUrl(current => settlePageOpenUrl(current, decision, url => {')
      .toMatch(UPDATER_WITH_EFFECT)
  })
})
