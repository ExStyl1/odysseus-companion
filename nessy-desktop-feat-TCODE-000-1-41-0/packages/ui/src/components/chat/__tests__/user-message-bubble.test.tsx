/**
 * UB14.13 (R3-07) — the user bubble, the inline system marker and the session viewer's mark, as
 * v0.15.1 `packages/ui/src/components/chat/{UserMessageBubble,SystemMessage,SessionViewer}.tsx`.
 *
 * Method (the row's): `SystemMessage` taken 1:1; `UserMessageBubble` and `SessionViewer` taken, then
 * OUR hunks re-applied — the bubble reads the renderer-safe `SessionAttachmentDto` (`previewUrl`,
 * `handleId`, `onAttachmentOpen(handleId)`), never a `data:` URL it builds itself from a stored
 * thumbnail; the viewer draws our `NessyLogo` mark with upstream's new classes.
 *
 * Instruments. packages/ui ships no DOM harness, so markup is read from `renderToStaticMarkup` (the
 * instrument of `turn/__tests__/turn-primitives.test.tsx`); lucide draws `lucide-<kebab-name>` into
 * the svg class. The attachment click is driven the way `markdown/__tests__/code-block-run.test.tsx`
 * drives Run: a probe CALLS `UserMessageBubble(props)` during its own render, so the hooks are the
 * probe's and the returned element tree is in hand; the attachment element's `onClick` is invoked.
 *
 * Loading. All three components reach `pdfjs-dist` through `Markdown` → `MarkdownPdfBlock` (and the
 * viewer through `TurnCard`), whose `pdf.worker.min.mjs?url` import bun cannot link — measured here:
 * a static import fails the file with `Missing 'default' export in module '…/pdf.worker.min.mjs?url'`.
 * So the pdfjs recipe (`apps/electron/…/input/__tests__/queue-paused-banner.test.tsx`) runs first —
 * the two `mock.module` stubs AND the `DOMMatrix` polyfill, one block — and the components are
 * imported INSIDE `beforeAll` on the shared module-graph budget (a static import would hoist above
 * the stubs).
 *
 * Arms:
 * - positive: an image attachment with `previewUrl` renders `<img src={previewUrl}>`; the bubble is
 *   v0.15.1's (radius 16 = `rounded-xl`, 15/24 copy = `text-copy`, max width 82%); clicking the
 *   attachment calls `onAttachmentOpen(handleId)` and its React key is the `handleId`;
 *   `SystemMessage type="error"` is the destructive-tint marker with the circle-alert icon; the
 *   viewer's branding is our mark at `size-8 text-accent/40`.
 * - negative / boundary (the row's control): an image with no `previewUrl` — even one still carrying
 *   a legacy `thumbnailBase64`, which upstream's code turns into a `data:image/png;base64,` src —
 *   renders the file-type placeholder and no `<img>` at all; compact mode widens the bubble to 90%
 *   and drops the 82%; `type="system"` draws the neutral fill with no left rule; the viewer carries
 *   neither upstream's Craft "C" path nor the old hard-coded purple.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import type { SessionAttachmentDto, StoredSession } from '@nessy-agent/core'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import en from '../../../../../shared/src/i18n/locales/en.json'
import ru from '../../../../../shared/src/i18n/locales/ru.json'
import type { UserMessageBubbleProps } from '../UserMessageBubble'

// The pdfjs recipe, one block (see the docblock): the worker-URL stub, the bare-specifier stub, and
// the polyfill for the SECOND, nested pdfjs copy `react-pdf` resolves, which the stubs cannot reach.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let UserMessageBubble: typeof import('../UserMessageBubble')['UserMessageBubble']
let SystemMessage: typeof import('../SystemMessage')['SystemMessage']
let SessionViewer: typeof import('../SessionViewer')['SessionViewer']
// A private instance through the provider, so labels never depend on which other test file
// initialised the global i18next first (the instrument of code-block-run.test.tsx).
let testI18n: I18nInstance

beforeAll(async () => {
  UserMessageBubble = (await import('../UserMessageBubble')).UserMessageBubble
  SystemMessage = (await import('../SystemMessage')).SystemMessage
  SessionViewer = (await import('../SessionViewer')).SessionViewer
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

const PREVIEW = 'blob:nessy-preview/att-image-1'
const IMAGE_WITH_PREVIEW: SessionAttachmentDto = {
  handleId: 'att-image-1',
  type: 'image',
  name: 'screenshot.png',
  mimeType: 'image/png',
  size: 2048,
  previewUrl: PREVIEW,
}
/** No `previewUrl`, but the legacy stored field upstream reads — the control's bait. */
const IMAGE_WITHOUT_PREVIEW = {
  handleId: 'att-image-2',
  type: 'image',
  name: 'diagram.png',
  mimeType: 'image/png',
  size: 4096,
  thumbnailBase64: 'TEVHQUNZ',
} as SessionAttachmentDto

const imgSrcs = (html: string): string[] => [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]!)
const svgClasses = (html: string): string[] => [...html.matchAll(/<svg[^>]*class="([^"]*)"/g)].map((m) => m[1]!)
/** The bubble is the element that carries the user-bubble fill. */
const bubbleClass = (html: string): string =>
  html.match(/<div class="([^"]*bg-user-message-bubble[^"]*text-copy[^"]*)"/)?.[1] ?? ''

describe('UserMessageBubble (UB14.13)', () => {
  it('positive: an image attachment with previewUrl renders <img src={previewUrl}>', () => {
    const html = render(<UserMessageBubble content="Look at this" attachments={[IMAGE_WITH_PREVIEW]} />)
    expect(imgSrcs(html)).toEqual([PREVIEW])
    expect(html).toContain('alt="screenshot.png"')
    // v0.15.1's thumbnail: raised 56px square
    expect(html).toContain('size-14 overflow-hidden rounded-md bg-raised shadow-elev-1')
  })

  it('negative (control): no previewUrl renders the placeholder and never a data:image src', () => {
    const html = render(<UserMessageBubble content="Look at this" attachments={[IMAGE_WITHOUT_PREVIEW]} />)
    expect(imgSrcs(html)).toEqual([])
    expect(html).not.toContain('data:image')
    expect(html).not.toContain('TEVHQUNZ')
    // the placeholder is the file-type glyph inside the same raised square
    expect(html).toContain('size-14 overflow-hidden rounded-md bg-raised shadow-elev-1')
    expect(svgClasses(html).length).toBeGreaterThan(0)
  })

  it('positive: the bubble is v0.15.1\'s — radius 16, 15/24 copy, 82% of the column', () => {
    const cls = bubbleClass(render(<UserMessageBubble content="Hello" />))
    expect(cls).toContain('rounded-xl')
    expect(cls).toContain('text-copy')
    expect(cls).toContain('px-3.5')
    expect(cls).toContain('py-2.25')
    expect(cls).toContain('max-w-[82%]')
    expect(cls).not.toContain('rounded-[16px]')
  })

  it('boundary: compact mode widens the bubble to 90% and drops the 82%', () => {
    const cls = bubbleClass(render(<UserMessageBubble content="Hello" compactMode />))
    expect(cls).toContain('max-w-[90%]')
    expect(cls).not.toContain('max-w-[82%]')
  })

  it('positive: clicking an attachment calls onAttachmentOpen(handleId), keyed by handleId', () => {
    const opened: string[] = []
    const files: string[] = []
    let tree: React.ReactNode = null
    const props: UserMessageBubbleProps = {
      content: 'Look at this',
      attachments: [IMAGE_WITH_PREVIEW],
      onAttachmentOpen: (id) => opened.push(id),
      onFileClick: (path) => files.push(path),
    }
    function Probe(): React.ReactElement {
      tree = UserMessageBubble(props)
      return <></>
    }
    render(<Probe />)

    const keyed: React.ReactElement<{ onClick?: () => void }>[] = []
    const walk = (node: React.ReactNode): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!React.isValidElement(node)) return
      if (node.key === IMAGE_WITH_PREVIEW.handleId) keyed.push(node as React.ReactElement<{ onClick?: () => void }>)
      walk((node.props as { children?: React.ReactNode }).children)
    }
    walk(tree)

    expect(keyed).toHaveLength(1)
    keyed[0]!.props.onClick?.()
    expect(opened).toEqual([IMAGE_WITH_PREVIEW.handleId])
    expect(files).toEqual([])
  })
})

describe('SystemMessage (UB14.13)', () => {
  it('positive: type="error" is the destructive-tint marker with a left rule and the circle-alert icon', () => {
    const html = render(<SystemMessage content="Connection lost." type="error" />)
    expect(html).toContain('bg-destructive-tint')
    expect(html).toContain('border-l-2 border-destructive')
    const [icon] = svgClasses(html)
    expect(icon).toContain('lucide-circle-alert')
    expect(icon).toContain('text-destructive')
    expect(html).toContain('Connection lost.')
  })

  it('positive: warning and info share the info tint, with their own icons', () => {
    const warning = render(<SystemMessage content="Rate limit approaching." type="warning" />)
    expect(warning).toContain('bg-info-tint border-l-2 border-info')
    expect(svgClasses(warning)[0]).toContain('lucide-triangle-alert')
    const info = render(<SystemMessage content="Agent activated." type="info" />)
    expect(info).toContain('bg-info-tint border-l-2 border-info')
    expect(svgClasses(info)[0]).toContain('lucide-info')
  })

  it('negative (control): type="system" draws the neutral fill with no left rule and no destructive role', () => {
    const html = render(<SystemMessage content="Session restored." type="system" />)
    expect(html).toContain('bg-fill-hover')
    expect(html).not.toContain('border-l-2')
    expect(html).not.toContain('destructive')
    expect(svgClasses(html)[0]).toContain('text-tertiary')
  })
})

describe('SessionViewer (UB14.13)', () => {
  const session = (messages: unknown[]): StoredSession =>
    ({ id: 'viewer-session', messages }) as unknown as StoredSession

  it('positive: the branding is our NessyLogo mark at size-8 text-accent/40', () => {
    const html = render(<SessionViewer session={session([])} />)
    expect(html).toContain('M4 20V4h4.4l7.2 9.7V4H20v16h-4.4L8.4 10.3V20H4Z')
    expect(html).toMatch(/<svg[^>]*class="size-8 text-accent\/40"/)
  })

  it('negative (control): no Craft "C" path and no hard-coded purple', () => {
    const html = render(<SessionViewer session={session([])} />)
    expect(html).not.toContain('M3.17890888')
    expect(html).not.toContain('9570BE')
  })

  it('positive: a viewer transcript renders the user bubble and the error marker', () => {
    const html = render(
      <SessionViewer
        session={session([
          { id: 'u1', type: 'user', content: 'Please fix the build', timestamp: 1 },
          { id: 'e1', type: 'error', content: 'Connection lost.', timestamp: 2 },
        ])}
      />,
    )
    expect(bubbleClass(html)).toContain('max-w-[82%]')
    expect(html).toContain('Please fix the build')
    expect(html).toContain('bg-destructive-tint')
    expect(html).toContain('Connection lost.')
  })
})
