/**
 * UA7.1 — the Page frame CSP builder, and the guard that every Pages render
 * site goes through it.
 *
 * What is pinned here is the TEXT the builder emits: order (doctype first, then
 * the CSP meta), the directive set per kind, and the absence of every
 * loopback / scheme source the embedder's CSP would otherwise hand the page.
 * Whether Chromium enforces it inside an Electron 39 `srcdoc` frame is a live
 * measurement, owned by UA7.6's sitting case (it reads `document.compatMode`
 * and drives a `fetch`, an `<img>` and a WebSocket from a page).
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildPageFrameCsp, buildPageSrcdoc } from '../page-frame-csp'
import type { PageKind } from '@nessy-agent/shared/pages/types'

const KINDS: PageKind[] = ['static', 'interactive', 'live']
const META_PREFIX = '<meta http-equiv="Content-Security-Policy" content="'

function directives(kind: PageKind): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of buildPageFrameCsp(kind).split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    map.set(name, values.join(' '))
  }
  return map
}

describe('buildPageSrcdoc — order', () => {
  it.each(KINDS)('%s: the doctype is the first bytes, the CSP meta the next', kind => {
    const out = buildPageSrcdoc('<html><body>hi</body></html>', kind)
    expect(out.startsWith(`<!doctype html>${META_PREFIX}${buildPageFrameCsp(kind)}">`)).toBe(true)
  })

  it.each(KINDS)('%s: the page bytes follow unchanged, at the end', kind => {
    const page = '<!DOCTYPE html><html><head><title>t</title></head><body><p>x &amp; y</p></body></html>'
    const out = buildPageSrcdoc(page, kind)
    expect(out.endsWith(page)).toBe(true)
    expect(out.indexOf(page)).toBeGreaterThan(out.indexOf(META_PREFIX))
  })

  it('script-capable kinds remove the WebRTC constructors before any page byte; static carries no script', () => {
    const page = '<script>window.ok = 1</script>'
    for (const kind of ['interactive', 'live'] as const) {
      const out = buildPageSrcdoc(page, kind)
      const removal = out.indexOf('RTCPeerConnection')
      expect(removal).toBeGreaterThan(out.indexOf(META_PREFIX))
      expect(removal).toBeLessThan(out.indexOf(page))
    }
    const staticOut = buildPageSrcdoc('<p>x</p>', 'static')
    expect(staticOut).toBe(`<!doctype html>${META_PREFIX}${buildPageFrameCsp('static')}"><p>x</p>`)
    expect(staticOut).not.toContain('<script')
  })
})

describe('buildPageFrameCsp — the policy', () => {
  it('static gets script-src none; interactive and live get inline script only', () => {
    expect(directives('static').get('script-src')).toBe("'none'")
    expect(directives('interactive').get('script-src')).toBe("'unsafe-inline'")
    expect(directives('live').get('script-src')).toBe("'unsafe-inline'")
  })

  it.each(KINDS)('%s: default none, connect none, and every fetch-capable directive closed', kind => {
    const d = directives(kind)
    expect(d.get('default-src')).toBe("'none'")
    expect(d.get('connect-src')).toBe("'none'")
    expect(d.get('form-action')).toBe("'none'")
    expect(d.get('base-uri')).toBe("'none'")
    expect(d.get('frame-src')).toBe("'none'")
    expect(d.get('worker-src')).toBe("'none'")
    expect(d.get('object-src')).toBe("'none'")
    expect(d.get('img-src')).toBe('data: blob:')
    expect(d.get('media-src')).toBe('data: blob:')
    expect(d.get('font-src')).toBe('data:')
    expect(d.get('style-src')).toBe("'unsafe-inline'")
  })

  it.each(KINDS)('%s: no loopback token, no network scheme, no eval', kind => {
    const policy = buildPageFrameCsp(kind)
    for (const token of ['localhost', '127.0.0.1', '[::1]', 'https:', 'http:', 'wss:', 'ws:', 'file:', "'self'", '*', 'unsafe-eval']) {
      expect(policy).not.toContain(token)
    }
  })

  it('an agent CSP meta in the page cannot loosen the policy: ours precedes it and is emitted unchanged', () => {
    // CSP policies intersect — every delivered policy is enforced — so a second,
    // looser meta can only add restrictions. What the builder must guarantee is
    // that ours is present, first, and not rewritten by what the page carries.
    const agentMeta = '<meta http-equiv="Content-Security-Policy" content="default-src *; connect-src *">'
    const out = buildPageSrcdoc(`<html><head>${agentMeta}</head><body></body></html>`, 'live')
    const ours = `${META_PREFIX}${buildPageFrameCsp('live')}">`
    expect(out.indexOf(ours)).toBe('<!doctype html>'.length)
    expect(out.indexOf(agentMeta)).toBeGreaterThan(out.indexOf(ours))
    expect(out.split(META_PREFIX).length - 1).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Guard: a Pages render site never sets srcdoc without the builder.
// ---------------------------------------------------------------------------

const ELECTRON_SRC = join(import.meta.dir, '..', '..')

/** The two render sites spec §14 names, plus anything else under the Pages UI dir. */
function pagesRenderSites(): string[] {
  const named = [
    join(ELECTRON_SRC, 'renderer', 'components', 'pages', 'PageFrame.tsx'),
    join(ELECTRON_SRC, 'main', 'page-thumbnail-host.ts'),
  ]
  const pagesDir = join(ELECTRON_SRC, 'renderer', 'components', 'pages')
  const more = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter(f => /\.tsx?$/.test(f)).map(f => join(pagesDir, f))
    : []
  return [...new Set([...named, ...more])].filter(p => existsSync(p))
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
}

/** True when the source sets a srcdoc (JSX prop, HTML attribute or DOM property) without calling the builder. */
function setsSrcdocWithoutBuilder(source: string): boolean {
  const code = stripComments(source)
  const setsSrcdoc = /\bsrcdoc\s*=|\.srcdoc\s*=/i.test(code)
  const callsBuilder = /\bbuildPageSrcdoc\s*\(/.test(code) && /from\s+['"][^'"]*page-frame-csp['"]/.test(code)
  return setsSrcdoc && !callsBuilder
}

describe('guard: Pages render sites use the builder', () => {
  it('positive control: the guard flags each way of setting srcdoc without the builder', () => {
    expect(setsSrcdocWithoutBuilder('return <iframe sandbox="" srcDoc={content} />')).toBe(true)
    expect(setsSrcdocWithoutBuilder('`<iframe srcdoc="${escape(input.content)}"></iframe>`')).toBe(true)
    expect(setsSrcdocWithoutBuilder('frame.srcdoc = html')).toBe(true)
    // A builder named in a comment only is not a call.
    expect(setsSrcdocWithoutBuilder('// buildPageSrcdoc(content, kind)\nreturn <iframe srcDoc={content} />')).toBe(true)
  })

  it('negative control: the builder imported and called passes; no srcdoc at all passes', () => {
    const viaBuilder = [
      "import { buildPageSrcdoc } from '../../../shared/page-frame-csp'",
      'const doc = useMemo(() => buildPageSrcdoc(content, kind), [content, kind])',
      'return <iframe sandbox="" srcDoc={doc} />',
    ].join('\n')
    expect(setsSrcdocWithoutBuilder(viaBuilder)).toBe(false)
    expect(setsSrcdocWithoutBuilder('export const x = 1')).toBe(false)
  })

  it('every Pages render site that exists sets srcdoc only through the builder', () => {
    // PageFrame.tsx lands with UA7.3 and page-thumbnail-host.ts with UA7.4; until
    // then the list is shorter, never wrong.
    const offenders = pagesRenderSites().filter(p => setsSrcdocWithoutBuilder(readFileSync(p, 'utf8')))
    expect(offenders).toEqual([])
  })
})
