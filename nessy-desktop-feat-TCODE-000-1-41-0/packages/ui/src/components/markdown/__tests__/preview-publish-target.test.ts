/**
 * UA1.23 — the preview block's Publish decision (`preview-publish-target.ts`), asserted on values.
 *
 * UB14.10 (R3-03) — and the action itself, rendered: v0.15.1 moves the doc and html blocks onto
 * `PreviewBlockChrome`, and our Publish (an extension beyond upstream, owner 2026-09-23) is
 * re-applied as a `PreviewBlockAction` (`data-preview-publish`, `t('preview.publish')`, its own
 * `t('preview.publishTitle')` tooltip) placed BEFORE the block's fullscreen/expand action.
 *
 * Instruments. Markup from `renderToStaticMarkup` (no DOM harness in packages/ui); the click is
 * driven the way `code-block-run.test.tsx` drives Run — a probe CALLS the block during its own
 * render, inside the `PlatformProvider`, so `usePlatform()` resolves and the returned element tree
 * (header actions included) is in hand; the Publish element's `onClick` is then invoked.
 *
 * Loading. `MarkdownDocBlock` reaches `pdfjs-dist` through `Markdown` → `MarkdownPdfBlock`, whose
 * `pdf.worker.min.mjs?url` import bun cannot link, so the pdfjs recipe of
 * `chat/__tests__/user-message-bubble.test.tsx` runs first (both stubs and the `DOMMatrix`
 * polyfill, one block) and the blocks are imported INSIDE `beforeAll` on the shared module-graph
 * budget — a static import would hoist above the stubs.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import en from '../../../../../shared/src/i18n/locales/en.json'
import ru from '../../../../../shared/src/i18n/locales/ru.json'
import { PlatformProvider, type PlatformActions } from '../../../context/PlatformContext'
import { previewPublishTarget } from '../preview-publish-target'

const wired = (_path: string) => {}

describe('UA1.23 preview Publish target', () => {
  test('a block whose active item names a file offers Publish for exactly that path', () => {
    expect(previewPublishTarget({ src: '/work/project/out/report.html' }, wired)).toBe('/work/project/out/report.html')
    expect(previewPublishTarget({ src: 'notes/summary.md' }, wired)).toBe('notes/summary.md')
  })

  test('negative: no action without a src, with an empty src, or where no session wired the action', () => {
    expect(previewPublishTarget(undefined, wired)).toBeNull()
    expect(previewPublishTarget({}, wired)).toBeNull()
    expect(previewPublishTarget({ src: '   ' }, wired)).toBeNull()
    expect(previewPublishTarget({ src: 42 }, wired)).toBeNull()
    expect(previewPublishTarget({ src: '/work/project/out/report.html' }, undefined)).toBeNull()
  })
})

// The pdfjs recipe, one block (see the docblock).
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

type BlockProps = { code: string }
let MarkdownDocBlock: (props: BlockProps) => React.ReactNode
let MarkdownHtmlBlock: (props: BlockProps) => React.ReactNode
let testI18n: I18nInstance

beforeAll(async () => {
  MarkdownDocBlock = (await import('../MarkdownDocBlock')).MarkdownDocBlock
  MarkdownHtmlBlock = (await import('../MarkdownHtmlBlock')).MarkdownHtmlBlock
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const PUBLISH = en['preview.publish']
const PUBLISH_TITLE = en['preview.publishTitle']
const EXPAND = en['preview.expandPreview']
const FULLSCREEN = en['common.viewFullscreen']
const PREVIOUS = en['overlay.previousItem']

const DOC = '/work/out/summary.md'
const HTML = '/work/out/report.html'
const single = (src: string) => JSON.stringify({ src, title: 'Report' })
const multi = (...srcs: string[]) => JSON.stringify({ title: 'Drafts', items: srcs.map((src, i) => ({ src, label: `v${i + 1}` })) })

/** A session that reads files (never resolves here: SSR runs no effect) and, when given, publishes. */
function platform(onPublishFile?: (path: string) => void): PlatformActions {
  return { onReadFile: () => new Promise<string>(() => {}), ...(onPublishFile ? { onPublishFile } : {}) }
}

function render(block: (props: BlockProps) => React.ReactNode, code: string, actions: PlatformActions): string {
  return renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: testI18n },
      React.createElement(PlatformProvider, { actions, children: React.createElement(block as React.FC<BlockProps>, { code }) }))
  )
}

/** The block's element tree, its hooks hosted by a probe inside the providers (see the docblock). */
function blockTree(block: (props: BlockProps) => React.ReactNode, code: string, actions: PlatformActions): React.ReactNode {
  let tree: React.ReactNode = null
  function Probe(): React.ReactElement {
    tree = block({ code })
    return React.createElement(React.Fragment, null, tree)
  }
  renderToStaticMarkup(
    React.createElement(I18nextProvider, { i18n: testI18n },
      React.createElement(PlatformProvider, { actions, children: React.createElement(Probe) }))
  )
  return tree
}

type AnyElement = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>

function findElements(node: React.ReactNode, match: (props: Record<string, unknown>) => boolean, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, match, out)
    return out
  }
  if (!React.isValidElement(node)) return out
  const element = node as AnyElement
  if (match(element.props)) out.push(element)
  findElements(element.props.children, match, out)
  return out
}

const publishButtons = (tree: React.ReactNode) => findElements(tree, props => props['data-preview-publish'] === true)

/** The `<button …>` opening tag whose aria-label is `name` (static markup). */
function buttonTag(html: string, name: string): string {
  const at = html.indexOf(`aria-label="${name}"`)
  if (at === -1) return ''
  return html.slice(html.lastIndexOf('<button', at), html.indexOf('>', at) + 1)
}

describe('UB14.10 — the Publish action on the doc and html blocks (PreviewBlockChrome)', () => {
  test('positive: a doc block with onPublishFile renders [data-preview-publish], named and titled, before Expand', () => {
    const html = render(MarkdownDocBlock, single(DOC), platform(() => {}))
    const tag = buttonTag(html, PUBLISH)
    expect(tag).toContain('data-preview-publish="true"')
    expect(tag).toContain(`title="${PUBLISH_TITLE}"`)
    expect(tag).toContain('data-slot="icon-button"')
    expect(html).toContain('lucide-upload')
    expect(html.indexOf(`aria-label="${PUBLISH}"`)).toBeLessThan(html.indexOf(`aria-label="${EXPAND}"`))
    // the block is on the well now (v0.15.1), not the old bordered muted card
    expect(html).toContain('bg-sunken')
  })

  test('positive: an html block with onPublishFile renders it before View Fullscreen, and a click publishes the active path', () => {
    const html = render(MarkdownHtmlBlock, single(HTML), platform(() => {}))
    expect(buttonTag(html, PUBLISH)).toContain('data-preview-publish="true"')
    expect(html.indexOf(`aria-label="${PUBLISH}"`)).toBeLessThan(html.indexOf(`aria-label="${FULLSCREEN}"`))

    const published: string[] = []
    const tree = blockTree(MarkdownHtmlBlock, single(HTML), platform(path => published.push(path)))
    const buttons = publishButtons(tree)
    expect(buttons).toHaveLength(1)
    ;(buttons[0]!.props.onClick as () => void)()
    expect(published).toEqual([HTML])
  })

  test('positive: a multi-item doc block draws the navigator with "previous" disabled at index 0, and Publish names the active item', () => {
    const html = render(MarkdownDocBlock, multi(DOC, '/work/out/v2.md'), platform(() => {}))
    expect(buttonTag(html, PREVIOUS)).toContain('disabled=""')
    expect(html.indexOf(`aria-label="${PREVIOUS}"`)).toBeLessThan(html.indexOf(`aria-label="${PUBLISH}"`))

    const published: string[] = []
    const tree = blockTree(MarkdownDocBlock, multi(DOC, '/work/out/v2.md'), platform(path => published.push(path)))
    ;(publishButtons(tree)[0]!.props.onClick as () => void)()
    expect(published).toEqual([DOC])
  })

  test('negative (control): without onPublishFile neither block renders Publish, while the fullscreen action still does', () => {
    const doc = render(MarkdownDocBlock, single(DOC), platform())
    expect(doc).not.toContain('data-preview-publish')
    expect(buttonTag(doc, EXPAND)).not.toBe('')
    const html = render(MarkdownHtmlBlock, single(HTML), platform())
    expect(html).not.toContain('data-preview-publish')
    expect(buttonTag(html, FULLSCREEN)).not.toBe('')
    expect(publishButtons(blockTree(MarkdownHtmlBlock, single(HTML), platform()))).toEqual([])
  })

  test('negative (control): a single item draws no navigator', () => {
    for (const block of [MarkdownDocBlock, MarkdownHtmlBlock]) {
      const html = render(block, single(block === MarkdownDocBlock ? DOC : HTML), platform(() => {}))
      expect(html).not.toContain(`aria-label="${PREVIOUS}"`)
      expect(html).toContain(`aria-label="${PUBLISH}"`)
    }
  })
})
