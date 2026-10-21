/**
 * The `will-navigate` guard: which pages a renderer window may navigate to
 * (P6.667).
 *
 * ## What it admitted, and why that mattered even though nothing reached it
 *
 * `WindowManager.isRendererAppUrl` ended
 * `filePath === join(rendererRoot, 'index.html') ||
 *  filePath.startsWith(rendererRoot + sep)`.
 * The second disjunct admitted every file under `dist/renderer/` — including
 * `playground.html`, the design surface, which SHIPS. Measured 2026-09-07 (W8-x)
 * by driving `app-builder-lib`'s own `FileMatcher.createFilter()` against the
 * real `electron-builder.yml` `files` arrays and the real `dist` tree: the page
 * and its bundle are copied, `asar: false`, so they are plain files inside the
 * packaged app. Three positive controls shipped and five negative controls were
 * skipped in the same run — two of the five under the same `dist/**` subtree —
 * so the matcher was reading the real rules rather than defaulting to true.
 *
 * Latent, not live: four other components independently close every route that
 * could produce such a navigation. This is the one component that can say no by
 * itself, which is why the fix is here and not a new layer.
 *
 * ## Why this file reads the SOURCE rather than constructing a WindowManager
 *
 * `isRendererAppUrl` is private, and reaching it means constructing a
 * `WindowManager`, which means mocking `electron` with `mock.module` — and a
 * `mock.module` without a spread amputates the module for every later test file
 * in the process (AGENTS.md § Traps). The guarantee here is a SHAPE guarantee —
 * *the prefix disjunct is gone and the equality is the whole condition* — so it
 * is checked the same way `denied-path-windows-separators.test.ts` checks its own
 * reachability boundary: on the source text, with the surrounding facts asserted
 * so the check cannot pass for the wrong reason.
 *
 * The BEHAVIOUR half is re-derivable and is asserted below against a copy of the
 * exact predicate, including the `fileURLToPath` query/fragment behaviour that
 * every real load depends on.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RAW_SOURCE = readFileSync(join(import.meta.dir, '..', 'window-manager.ts'), 'utf-8')

/**
 * The source with COMMENT lines removed, which is not fastidiousness: the fix's
 * own docblock quotes the disjunct it removed, so a shape assertion run over the
 * raw text reads the explanation and reports the defect as still present. Same
 * class as the doc-anchor guard that had to stop reading its own examples
 * (`5ab6d5ae1`). `classifyDeniedPathPattern`'s caller-count check in
 * `packages/shared` filters comment lines for exactly this reason.
 */
const SOURCE = RAW_SOURCE
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
  })
  .join('\n')

/** The shipped predicate's `file:` branch, transcribed. */
function isRendererAppFileUrl(url: string, rendererRootDir: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return false
    const filePath = resolve(fileURLToPath(parsed))
    const rendererRoot = resolve(rendererRootDir)
    return filePath === join(rendererRoot, 'index.html')
  } catch {
    return false
  }
}

const RENDERER_ROOT = '/app/dist/renderer'
const fileUrl = (...parts: string[]): string => pathToFileURL(join(RENDERER_ROOT, ...parts)).href

describe('renderer navigation guard (P6.667)', () => {
  it('admits the app shell', () => {
    expect(isRendererAppFileUrl(fileUrl('index.html'), RENDERER_ROOT)).toBe(true)
  })

  it('admits the app shell carrying the query every real load has', () => {
    // All four `loadFile` calls pass `{ query }`, so a guard that compared the
    // whole URL would refuse the app's own navigations. `fileURLToPath` drops
    // the search and the fragment, which is what makes the equality safe.
    expect(isRendererAppFileUrl(`${fileUrl('index.html')}?workspaceId=ws-1`, RENDERER_ROOT)).toBe(true)
    expect(isRendererAppFileUrl(`${fileUrl('index.html')}?workspaceId=ws-1#/session/9`, RENDERER_ROOT)).toBe(true)
  })

  it('REFUSES the playground page, which ships under the same root', () => {
    expect(isRendererAppFileUrl(fileUrl('playground.html'), RENDERER_ROOT)).toBe(false)
  })

  it('refuses every other page under the renderer root', () => {
    // The two the main process loads itself, into `WebContentsView`s that are
    // never a navigation target from a renderer window — so refusing them here
    // costs nothing and is the point of an allowlist of one.
    expect(isRendererAppFileUrl(fileUrl('browser-toolbar.html'), RENDERER_ROOT)).toBe(false)
    expect(isRendererAppFileUrl(fileUrl('browser-empty-state.html'), RENDERER_ROOT)).toBe(false)
    expect(isRendererAppFileUrl(fileUrl('assets', 'playground-DEUy1JxD.js'), RENDERER_ROOT)).toBe(false)
    expect(isRendererAppFileUrl(fileUrl('nested', 'index.html'), RENDERER_ROOT)).toBe(false)
  })

  it('refuses paths outside the renderer root and non-file schemes', () => {
    expect(isRendererAppFileUrl('file:///etc/passwd', RENDERER_ROOT)).toBe(false)
    expect(isRendererAppFileUrl('file:///app/dist/renderer-evil/index.html', RENDERER_ROOT)).toBe(false)
    expect(isRendererAppFileUrl('https://example.com/index.html', RENDERER_ROOT)).toBe(false)
    expect(isRendererAppFileUrl('not a url', RENDERER_ROOT)).toBe(false)
  })

  it('the shipped predicate really is the equality alone', () => {
    // The behaviour cases above run on a transcription, so this is what ties
    // them to the file. Both halves are asserted: the equality is present, and
    // the prefix disjunct that admitted the whole root is gone.
    expect(SOURCE).toContain("return filePath === join(rendererRoot, 'index.html')")
    expect(SOURCE).not.toContain('filePath.startsWith(rendererRoot')
  })

  it('the guard is still the one wired to Electron\'s own will-navigate', () => {
    // Positive control for the source-shape check: a guard nobody consults would
    // satisfy the two assertions above and protect nothing. Native-first means
    // narrowing the platform's mechanism, not adding a layer beside it.
    expect(SOURCE).toContain("window.webContents.on('will-navigate'")
    expect(SOURCE).toContain('if (this.isRendererAppUrl(url)) return')
    expect(SOURCE).toContain('setWindowOpenHandler')
  })

  it('every page this class loads is the one page the guard admits', () => {
    // The reason `index.html` is the correct floor rather than a guess. If a
    // future `loadFile` names another page, this fails and the guard has to be
    // widened deliberately instead of by a prefix.
    const loaded = [...SOURCE.matchAll(/window\.loadFile\(join\(__dirname, '([^']+)'\)/g)].map(m => m[1])
    expect(loaded.length).toBeGreaterThan(0)
    expect(new Set(loaded)).toEqual(new Set(['renderer/index.html']))
  })
})

// ---------------------------------------------------------------------------
// UA7.2 — the `will-frame-navigate` guard (subframes), beside the main-frame one.
// ---------------------------------------------------------------------------

import {
  classifyDeniedFrameNavigation,
  createDeniedFrameNavigationRouter,
  FRAME_LINK_OUT_OPEN_BUTTON,
  frameLinkOutConfirmOptions,
  installSubframeNavigationGuard,
  isDeniedFrameNavigation,
  type DeniedFrameNavigation,
  type FrameLike,
  type FrameNavigationSource,
} from '../frame-navigation-guard'
import { PAGE_IFRAME_NAME } from '../../shared/page-frame-csp'

type FrameNavListener = Parameters<FrameNavigationSource['on']>[1]

/** A fake `webContents` that records the listener and lets a test fire the event. */
function fakeWebContents(): {
  source: FrameNavigationSource
  fire: (isMainFrame: boolean, url: string, frame?: FrameLike | null) => boolean
  events: string[]
} {
  const listeners: FrameNavListener[] = []
  const events: string[] = []
  return {
    events,
    source: {
      on(event, listener) {
        events.push(event)
        listeners.push(listener)
      },
    },
    fire(isMainFrame, url, frame) {
      let prevented = false
      const details = {
        url,
        isMainFrame,
        isSameDocument: false,
        frame: frame ?? null,
        preventDefault: () => { prevented = true },
        defaultPrevented: false,
      } as unknown as Parameters<FrameNavListener>[0]
      for (const listener of listeners) listener(details)
      return prevented
    },
  }
}

describe('subframe navigation guard (UA7.2, will-frame-navigate)', () => {
  it('denies a subframe navigating to the network, a file, or any other document', () => {
    for (const url of [
      'https://attacker.example/?d=secret',
      'http://127.0.0.1:8080/',
      'http://localhost:5173/',
      'file:///etc/passwd',
      'data:text/html,<p>x</p>',
      'blob:null/1234',
      'javascript:alert(1)',
      'nessy://workspace/ws/allSessions',
      'not a url',
    ]) {
      expect(isDeniedFrameNavigation({ isMainFrame: false, url })).toBe(true)
    }
  })

  it("admits a subframe's own inline document (srcdoc, about:blank)", () => {
    // Negative control for the denial above: the renderer's iframes ARE srcdoc
    // documents, so a guard that denied these would blank every preview.
    expect(isDeniedFrameNavigation({ isMainFrame: false, url: 'about:srcdoc' })).toBe(false)
    expect(isDeniedFrameNavigation({ isMainFrame: false, url: 'about:blank' })).toBe(false)
    expect(isDeniedFrameNavigation({ isMainFrame: false, url: 'about:srcdoc#top' })).toBe(false)
  })

  it('leaves every main-frame navigation to will-navigate', () => {
    expect(isDeniedFrameNavigation({ isMainFrame: true, url: 'https://attacker.example/' })).toBe(false)
    expect(isDeniedFrameNavigation({ isMainFrame: true, url: 'file:///app/dist/renderer/index.html' })).toBe(false)
  })

  it('the installed listener cancels a Page frame navigation and reports only the origin', () => {
    // The one frame the renderer NAMES (PAGE_IFRAME_NAME, PageFrame.tsx) is a
    // Page: its link-outs belong to the bridge's confirmed open-url, so a
    // denied self-navigation stays cancelled and only the origin is reported —
    // never the full URL (its path/query is where a page puts exfil data).
    const wc = fakeWebContents()
    const routed: DeniedFrameNavigation[] = []
    installSubframeNavigationGuard(wc.source, denied => routed.push(denied))
    expect(wc.events).toEqual(['will-frame-navigate'])
    expect(wc.fire(false, 'https://attacker.example/x?d=secret', { name: PAGE_IFRAME_NAME })).toBe(true)
    expect(routed).toEqual([{ action: 'deny', origin: 'https://attacker.example' }])
    expect(wc.fire(false, 'about:srcdoc', { name: PAGE_IFRAME_NAME })).toBe(false)
    expect(wc.fire(true, 'https://example.com/', { name: PAGE_IFRAME_NAME })).toBe(false)
    expect(routed).toEqual([{ action: 'deny', origin: 'https://attacker.example' }])
  })

  it('WindowManager installs it on every renderer window, and the top-level will-navigate guard is unchanged', () => {
    // Source shape, for the reason the file header gives (no electron mock).
    expect(SOURCE).toContain('installSubframeNavigationGuard(window.webContents, ')
    expect(SOURCE).toMatch(/import \{[^}]*\binstallSubframeNavigationGuard\b[^}]*\} from '\.\/frame-navigation-guard'/)
    // Positive: the main-frame guard is byte-for-byte what it was.
    expect(RAW_SOURCE).toContain(
      [
        "    window.webContents.on('will-navigate', (event, url) => {",
        '      // Allow only the actual app shell (file:// in prod, Vite dev server in dev).',
        '      // Any other navigation is treated as an external URL and goes through the',
        '      // same URL-safety classifier used by OPEN_URL.',
        '      if (this.isRendererAppUrl(url)) return',
        '',
        '      event.preventDefault()',
        "      this.openExternalFromRenderer(url, 'will-navigate', window)",
        '    })',
        '    installSubframeNavigationGuard(',
      ].join('\n'),
    )
  })
})

// ---------------------------------------------------------------------------
// UA12.31 — a denial routes: a preview frame's http(s) link-out reaches the
// browser, a Page frame's self-navigation stays cancelled and silent.
// UA12.170 — never SILENTLY: the link-out waits for the user's confirm of the
// full URL, because a frame's name is written by the frame's own script.
// ---------------------------------------------------------------------------

/** A WebFrameMain-shaped frame: a child of the window's main frame unless `parent` says otherwise. */
function childFrame(name: string, frameTreeNodeId: number, parent: FrameLike | null = { name: '', frameTreeNodeId: 1, parent: null }): FrameLike {
  return { name, frameTreeNodeId, parent }
}

describe('denied-subframe routing (UA12.31, UA12.170)', () => {
  it("CONTROL: a preview frame's denied https link routes to the CONFIRMED open, and the frame still does not load it", () => {
    // UA12.31's control. An `<a target="_self">` in an HTML preview overrides
    // the `<base target="_top">` the preview injects: before UA7.2 it loaded
    // the remote page INSIDE the frame, since UA7.2 it was cancelled silently.
    // The navigation stays cancelled; since UA12.170 the URL goes to the
    // browser only behind the user's confirm (never a direct open).
    const wc = fakeWebContents()
    const routed: DeniedFrameNavigation[] = []
    installSubframeNavigationGuard(wc.source, denied => routed.push(denied))
    expect(wc.fire(false, 'https://example.com/report?d=1', childFrame('', 7))).toBe(true)
    expect(routed).toEqual([{ action: 'confirm-external', url: 'https://example.com/report?d=1', origin: 'https://example.com', frameKey: 7 }])
  })

  it('UA12.170 RED ARM: a frame whose script renamed it (window.name) and then navigated never gets a silent open', () => {
    // The 2026-10-08 audit probe (Electron 39.8.10): a sandboxed srcdoc frame
    // that sets window.name reports the NEW name to the main process. The
    // name therefore proves nothing a Page could not forge — the denial must
    // land on the confirmed route whatever the frame is called.
    const wc = fakeWebContents()
    const routed: DeniedFrameNavigation[] = []
    installSubframeNavigationGuard(wc.source, denied => routed.push(denied))
    expect(wc.fire(false, 'https://attacker.example/?d=secret', childFrame('renamed-by-script', 9))).toBe(true)
    expect(routed).toHaveLength(1)
    expect(routed[0]!.action).toBe('confirm-external')
    expect(routed.some(r => (r.action as string) === 'open-external')).toBe(false)
  })

  it('a frame that proves nothing (absent, or the `null` the typings allow) is confirmed, never trusted', () => {
    const wc = fakeWebContents()
    const routed: DeniedFrameNavigation[] = []
    installSubframeNavigationGuard(wc.source, denied => routed.push(denied))
    expect(wc.fire(false, 'https://example.com/')).toBe(true)
    expect(wc.fire(false, 'https://example.com/2', null)).toBe(true)
    expect(routed).toEqual([
      { action: 'confirm-external', url: 'https://example.com/', origin: 'https://example.com', frameKey: null },
      { action: 'confirm-external', url: 'https://example.com/2', origin: 'https://example.com', frameKey: null },
    ])
  })

  it("a nested frame's key is its embed root (the child of the main frame), so a Page cannot mint fresh keys with child iframes", () => {
    const pageRoot = childFrame('renamed', 11)
    const nested = { name: 'inner', frameTreeNodeId: 12, parent: { name: 'inner-parent', frameTreeNodeId: 13, parent: pageRoot } }
    const routed = classifyDeniedFrameNavigation({ isMainFrame: false, url: 'https://a.example/x', frame: nested })
    expect(routed).toEqual({ action: 'confirm-external', url: 'https://a.example/x', origin: 'https://a.example', frameKey: 11 })
  })

  it('CONTROL: the named Page frame keeps its silent, origin-only denial', () => {
    const wc = fakeWebContents()
    const routed: DeniedFrameNavigation[] = []
    installSubframeNavigationGuard(wc.source, denied => routed.push(denied))
    expect(wc.fire(false, 'https://attacker.example/x?d=secret', childFrame(PAGE_IFRAME_NAME, 5))).toBe(true)
    expect(routed).toEqual([{ action: 'deny', origin: 'https://attacker.example' }])
  })

  it('CONTROL: non-http(s) denials stay denied from any frame, origin alone in the log', () => {
    const wc = fakeWebContents()
    const routed: DeniedFrameNavigation[] = []
    installSubframeNavigationGuard(wc.source, denied => routed.push(denied))
    expect(wc.fire(false, 'javascript:alert(1)', childFrame('', 7))).toBe(true)
    expect(routed).toEqual([{ action: 'deny', origin: 'javascript:…' }])
    expect(wc.fire(false, 'not a url', childFrame('renamed', 8))).toBe(true)
    expect(routed[1]).toEqual({ action: 'deny', origin: '(unparseable URL)' })
  })
})

describe('the confirmed link-out route (UA12.170)', () => {
  function harness(answers: boolean[]) {
    const confirms: string[] = []
    const opened: string[] = []
    const logs: string[] = []
    const settle: Array<(ok: boolean) => void> = []
    const route = createDeniedFrameNavigationRouter({
      confirm: url => {
        confirms.push(url)
        return new Promise<boolean>(resolve => settle.push(resolve))
      },
      open: url => opened.push(url),
      log: line => logs.push(line),
    })
    const answer = async () => {
      settle.shift()!(answers.shift()!)
      await new Promise(r => setTimeout(r, 0))
    }
    return { route, confirms, opened, logs, answer }
  }
  const linkOut = (url: string, frameKey: number | null): DeniedFrameNavigation =>
    ({ action: 'confirm-external', url, origin: new URL(url).origin, frameKey })

  it('opens the FULL URL only after the user confirms it (the preview link still reaches the browser)', async () => {
    const h = harness([true])
    h.route(linkOut('https://example.com/report?d=1', 7))
    expect(h.confirms).toEqual(['https://example.com/report?d=1'])
    expect(h.opened).toEqual([])
    await h.answer()
    expect(h.opened).toEqual(['https://example.com/report?d=1'])
  })

  it('Cancel opens nothing, and that frame is not asked again (no dialog loop from a script)', async () => {
    const h = harness([false, true])
    h.route(linkOut('https://attacker.example/?d=1', 9))
    await h.answer()
    expect(h.opened).toEqual([])
    h.route(linkOut('https://attacker.example/?d=2', 9))
    expect(h.confirms).toHaveLength(1)
    // CONTROL: another frame is still asked.
    h.route(linkOut('https://example.com/', 10))
    expect(h.confirms).toEqual(['https://attacker.example/?d=1', 'https://example.com/'])
    await h.answer()
    expect(h.opened).toEqual(['https://example.com/'])
  })

  it('one confirmation at a time: a burst while one is open is dropped, logged by origin alone', async () => {
    const h = harness([false])
    h.route(linkOut('https://attacker.example/?d=1', null))
    h.route(linkOut('https://attacker.example/?d=2', null))
    h.route(linkOut('https://attacker.example/?d=3', null))
    expect(h.confirms).toHaveLength(1)
    expect(h.logs.join('\n')).not.toContain('d=2')
    expect(h.logs.filter(l => l.includes('https://attacker.example')).length).toBeGreaterThanOrEqual(3)
    await h.answer()
    // Settled: the next one is asked again (an unkeyed frame cannot be muted).
    h.route(linkOut('https://attacker.example/?d=4', null))
    expect(h.confirms).toHaveLength(2)
  })

  it('a deny is logged by origin alone and asks nobody', () => {
    const h = harness([])
    h.route({ action: 'deny', origin: 'https://attacker.example' })
    expect(h.confirms).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.logs).toEqual(['[navigation] subframe navigation denied (UA7.2): https://attacker.example'])
  })

  it("the dialog shows the full URL with UA7.3's strings, Cancel the default and the escape answer", () => {
    const t = (key: string) => `<${key}>`
    const opts = frameLinkOutConfirmOptions('https://example.com/a?b=c', t)
    expect(opts.detail).toBe('https://example.com/a?b=c')
    expect(opts.message).toBe('<pages.openUrlConfirmTitle>')
    expect(opts.buttons).toEqual(['<common.cancel>', '<common.openLink>'])
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(0)
    expect(opts.buttons[FRAME_LINK_OUT_OPEN_BUTTON]).toBe('<common.openLink>')
  })

  it('WindowManager wires the router per window: the open is reachable only through the native confirm', () => {
    // Source shape, for the reason the file header gives (no electron mock).
    expect(RAW_SOURCE).toContain('installSubframeNavigationGuard(window.webContents, this.createDeniedFrameNavigationRoute(window))')
    expect(SOURCE).toContain('dialog.showMessageBox(window, frameLinkOutConfirmOptions(url, i18n.t.bind(i18n)))')
    expect(SOURCE).toContain('response === FRAME_LINK_OUT_OPEN_BUTTON')
    expect(SOURCE).toContain("open: (url) => this.openExternalFromRenderer(url, 'will-frame-navigate', window)")
    // NEGATIVE: the UA12.31 direct route is gone — no denial reaches openExternalFromRenderer unconfirmed.
    expect(SOURCE).not.toContain("this.openExternalFromRenderer(denied.url, 'will-frame-navigate', window)")
    expect(SOURCE).not.toContain('routeDeniedFrameNavigation')
  })

  it("PageFrame's iframe is the one named PAGE_IFRAME_NAME — the marker that buys the Page its silent denial", () => {
    const pageFrame = readFileSync(
      join(import.meta.dir, '..', '..', 'renderer', 'components', 'pages', 'PageFrame.tsx'),
      'utf-8',
    )
    expect(pageFrame).toContain('name={PAGE_IFRAME_NAME}')
    expect(pageFrame).toContain("from '../../../shared/page-frame-csp'")
  })
})
