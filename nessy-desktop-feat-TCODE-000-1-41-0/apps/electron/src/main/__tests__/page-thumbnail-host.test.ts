/**
 * UA7.4 — the thumbnail host document (adapted from craft-agents-oss
 * `v0.13.4:apps/electron/src/main/__tests__/page-thumbnail-host.test.ts`, Apache-2.0; the upstream arms are kept,
 * rebranded to `nessy-pages/v1`, and the hardening arms are ours).
 *
 * Positive: the kind sandbox; the escaped srcdoc comes from the frame builder (doctype, then the frame CSP);
 * the snapshot reaches the page through the `nessy-pages/v1` init message; the host CSP's hash is the sha256 of
 * the one host script actually embedded; data:, blob: and about: requests are allowed.
 * Negative: no `allow-same-origin` for any kind; a snapshot carrying `<!--<script>` or `</script>` yields exactly
 * one host script; the host CSP names no network or loopback source; `https:`, `http:`, `file:`, `ws:` and custom
 * schemes are cancelled; every main-frame navigation and every subframe navigation that is not an inline document
 * is denied.
 */
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import type { PageDataSnapshot } from '@nessy-agent/shared/pages/types'
import { buildPageFrameCsp } from '../../shared/page-frame-csp'
import {
  buildThumbnailHostCsp,
  buildThumbnailHostHtml,
  escapeSrcdocAttribute,
  isDeniedThumbnailNavigation,
  isThumbnailRequestAllowed,
  sandboxForKind,
  THUMB_LOGICAL_WIDTH,
} from '../page-thumbnail-host'

/** The host CSP the document carries in its `<meta http-equiv>`. */
function hostCspOf(html: string): string {
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)
  if (!match) throw new Error('no host CSP meta')
  return match[1]!
}

/** Every `<script>` element body of the HOST document (the srcdoc is an escaped attribute, so it holds none). */
function hostScriptsOf(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
}

/** Undo the attribute escaping, to read the srcdoc the iframe receives. */
function srcdocOf(html: string): string {
  const match = html.match(/ srcdoc="([^"]*)"/)
  if (!match) throw new Error('no srcdoc')
  return match[1]!
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

const snapshotWith = (value: string): PageDataSnapshot => ({ version: 1, generatedAt: 1, kv: { x: value }, series: {} })

describe('page-thumbnail-host (upstream arms)', () => {
  it('applies the same sandbox rule as PageFrame, never same-origin', () => {
    expect(sandboxForKind('static')).toBe('')
    expect(sandboxForKind('interactive')).toBe('allow-scripts allow-forms')
    expect(sandboxForKind('live')).toBe('allow-scripts allow-forms')
    for (const kind of ['static', 'interactive', 'live'] as const) {
      expect(sandboxForKind(kind)).not.toContain('allow-same-origin')
      expect(buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind, snapshot: null })).not.toContain('allow-same-origin')
    }
  })

  it('escapes content for safe srcdoc embedding', () => {
    const escaped = escapeSrcdocAttribute('<img src="x" onerror=\'a&b\'>')
    expect(escaped).not.toContain('"')
    expect(escaped).not.toContain('<img')
    expect(escaped).toContain('&quot;')
    expect(escaped).toContain('&lt;img')
    expect(escaped).toContain('&amp;')
  })

  it('embeds the page content as an escaped srcdoc iframe with the kind sandbox', () => {
    const html = buildThumbnailHostHtml({ content: '<h1>Hello "world"</h1>', slug: 'demo', kind: 'interactive', snapshot: null })
    expect(html).toContain(`width: ${THUMB_LOGICAL_WIDTH}px`)
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    // Raw content must not appear unescaped in the host doc.
    expect(html).not.toContain('<h1>Hello')
    expect(html).toContain('&lt;h1&gt;Hello &quot;world&quot;')
  })

  it('delivers the data snapshot via the nessy-pages/v1 init message', () => {
    const snapshot: PageDataSnapshot = { version: 1, generatedAt: 5, kv: { total: 42 }, series: {} }
    const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind: 'live', snapshot })
    expect(html).toContain('nessy-pages/v1')
    expect(html).not.toContain('craft-pages/v1')
    expect(html).toContain('"type":"init"')
    expect(html).toContain('"total":42')
  })

  it('neutralizes a </script> sequence inside snapshot data', () => {
    const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind: 'live', snapshot: snapshotWith('</script><script>alert(1)') })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(hostScriptsOf(html)).toHaveLength(1)
  })

  it('static pages still embed content (no scripts, snapshot irrelevant)', () => {
    const html = buildThumbnailHostHtml({ content: '<p>static</p>', slug: 's', kind: 'static', snapshot: null })
    expect(html).toContain('sandbox=""')
    expect(html).toContain('&lt;p&gt;static&lt;/p&gt;')
  })
})

describe('page-thumbnail-host (UA7.4 hardening)', () => {
  it('the srcdoc comes from the frame builder: doctype first, then the frame CSP for the kind', () => {
    for (const kind of ['static', 'interactive', 'live'] as const) {
      const doc = srcdocOf(buildThumbnailHostHtml({ content: '<p>body</p>', slug: 's', kind, snapshot: null }))
      expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="')).toBe(true)
      expect(doc).toContain(buildPageFrameCsp(kind))
      expect(doc.endsWith('<p>body</p>')).toBe(true)
    }
  })

  it('a snapshot containing <!--<script> yields exactly one host script, and no raw < survives in it', () => {
    for (const hostile of ['<!--<script>', '<!--<script>alert(1)</script>-->', '</script><!--<script>']) {
      const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind: 'interactive', snapshot: snapshotWith(hostile) })
      const scripts = hostScriptsOf(html)
      expect(scripts).toHaveLength(1)
      expect(scripts[0]).not.toContain('<')
      // The data still arrives: the escape is JSON's own, so the page reads the original string back.
      expect(scripts[0]).toContain('\\u003c!--\\u003cscript>')
    }
  })

  it('the host CSP carries the sha256 of the one host script it embeds (static: the only script in the window)', () => {
    const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind: 'static', snapshot: snapshotWith('v') })
    const [script] = hostScriptsOf(html)
    const hash = createHash('sha256').update(script!, 'utf8').digest('base64')
    const csp = hostCspOf(html)
    expect(csp).toContain(`script-src 'sha256-${hash}'`)
    expect(csp).not.toContain("'unsafe-inline' 'sha256")
    expect(buildThumbnailHostCsp('static', script!)).toBe(csp)
  })

  it("script-capable kinds: the host policy is the frame's own, with no hash (a hash would switch 'unsafe-inline' off for the inheriting srcdoc)", () => {
    for (const kind of ['interactive', 'live'] as const) {
      const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind, snapshot: null })
      const csp = hostCspOf(html)
      expect(csp).toBe(buildPageFrameCsp(kind))
      expect(csp).toContain("script-src 'unsafe-inline'")
      expect(csp).not.toContain("'sha256-")
    }
  })

  it('the host CSP names no network, scheme or loopback source and closes connect, frame and form targets', () => {
    for (const kind of ['static', 'interactive', 'live'] as const) {
      const csp = hostCspOf(buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', kind, snapshot: null }))
      expect(csp.startsWith("default-src 'none'")).toBe(true)
      for (const needle of ['https:', 'http:', 'wss:', 'ws:', 'file:', 'localhost', '127.0.0.1', "'self'", '*']) {
        expect(csp).not.toContain(needle)
      }
      expect(csp).toContain("connect-src 'none'")
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("form-action 'none'")
    }
  })

  it('the partition allows only data:, blob: and about: requests', () => {
    for (const url of ['data:text/html,<p>x</p>', 'blob:null/1f2e', 'about:srcdoc', 'about:blank']) {
      expect(isThumbnailRequestAllowed(url)).toBe(true)
    }
    for (const url of [
      'https://example.invalid/beacon?d=1',
      'http://127.0.0.1:8080/v1/responses',
      'http://localhost:3000/',
      'wss://example.invalid/',
      'ws://localhost:1/',
      'file:///etc/hosts',
      'nessy://open',
      'thumbnail://thumb/x',
      'not a url',
      '',
    ]) {
      expect(isThumbnailRequestAllowed(url)).toBe(false)
    }
  })

  it('denies every main-frame navigation, and every subframe navigation except the inline documents', () => {
    expect(isDeniedThumbnailNavigation({ isMainFrame: true, url: 'https://example.invalid/' })).toBe(true)
    expect(isDeniedThumbnailNavigation({ isMainFrame: true, url: 'data:text/html,<p>swap</p>' })).toBe(true)
    expect(isDeniedThumbnailNavigation({ isMainFrame: false, url: 'https://example.invalid/leak?d=1' })).toBe(true)
    expect(isDeniedThumbnailNavigation({ isMainFrame: false, url: 'data:text/html,<p>swapped</p>' })).toBe(true)
    expect(isDeniedThumbnailNavigation({ isMainFrame: false, url: 'javascript:alert(1)' })).toBe(true)
    expect(isDeniedThumbnailNavigation({ isMainFrame: false, url: 'about:srcdoc' })).toBe(false)
    expect(isDeniedThumbnailNavigation({ isMainFrame: false, url: 'about:blank' })).toBe(false)
  })
})
