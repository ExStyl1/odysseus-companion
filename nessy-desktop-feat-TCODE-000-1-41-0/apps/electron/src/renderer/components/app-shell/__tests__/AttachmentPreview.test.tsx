/**
 * F1.733 — no control in the attachment strip may submit the composer.
 *
 * `FreeFormInput` renders `AttachmentPreview` INSIDE its `<form onSubmit>`, and
 * a `<button>` with no `type` is a submit button. The 1.41.0 sitting (lane
 * SIT-d) saw a scripted `.click()` on the remove "X" submit the form: the staged
 * image went out past the vision block, because only the Send button's
 * `disabled` carries that block and a submit from any other button skips it. A
 * real mouse click only removed the chip — React's re-render runs in the
 * microtask checkpoint after the listener, so the button has left the form
 * before the browser's activation step looks for a form owner; a scripted
 * click has no such checkpoint. The defect is the attribute either way.
 *
 * The positive case counts the buttons first, so "every button has the type"
 * cannot pass by finding none; the boundary case pins that a disabled strip
 * offers no control at all.
 */

import * as React from 'react'
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import type { FileAttachment } from '../../../../shared/types'

// The component imports `@nessy-agent/ui`, whose barrel pulls `pdfjs-dist`: the
// stubs and the `DOMMatrix` polyfill are ONE block, copied together from
// `input/__tests__/queue-paused-banner.test.tsx` for the reason recorded there.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

// Imported INSIDE `beforeAll`: a static import is hoisted above the stubs.
let AttachmentPreview: typeof import('../AttachmentPreview')['AttachmentPreview']
let i18n: I18nInstance

beforeAll(async () => {
  AttachmentPreview = (await import('../AttachmentPreview')).AttachmentPreview
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: enMessages as Record<string, string> } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const IMAGE: FileAttachment = {
  type: 'image',
  path: '/tmp/f1-733/shot.png',
  name: 'shot.png',
  mimeType: 'image/png',
  base64: 'iVBORw0KGgo=',
  size: 8,
}
const DOCUMENT: FileAttachment = {
  type: 'text',
  path: '/tmp/f1-733/note.txt',
  name: 'note.txt',
  mimeType: 'text/plain',
  text: 'hello',
  size: 5,
}
const PASTED: FileAttachment = {
  type: 'text',
  path: '/tmp/f1-733/pasted.txt',
  name: 'pasted.txt',
  mimeType: 'text/plain',
  text: 'a long paste',
  size: 12,
  origin: 'pasted-text',
}

const render = (props: { disabled?: boolean }): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AttachmentPreview
        attachments={[IMAGE, DOCUMENT, PASTED]}
        onRemove={() => {}}
        onRestoreText={() => {}}
        {...props}
      />
    </I18nextProvider>,
  )

const buttonTags = (markup: string): string[] => markup.match(/<button\b[^>]*>/g) ?? []

const textFile = (name: string): FileAttachment => ({
  type: 'text',
  path: `/tmp/ub14-27/${name}`,
  name,
  mimeType: 'text/plain',
  text: 'x',
  size: 1,
})

const renderStrip = (attachments: FileAttachment[]): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AttachmentPreview attachments={attachments} onRemove={() => {}} onRestoreText={() => {}} />
    </I18nextProvider>,
  )

/** The one-line name span (`FileName`) for `title`, as markup. */
const nameSpan = (markup: string, title: string): string => {
  const open = `<span class="flex min-w-0 text-label-sm font-medium text-foreground" title="${title}">`
  const at = markup.indexOf(open)
  expect(at).toBeGreaterThan(-1)
  return markup.slice(at + open.length, markup.indexOf('</span></span>', at) + '</span>'.length)
}

/**
 * UB14.27 (R2-19) — v0.15.1's one-line `FileName`: the stem truncates and a short extension stays
 * visible ("q3-planning-no….md"); the old two-line `line-clamp-2 break-all` broke names mid-word.
 */
describe('AttachmentPreview names on one line (UB14.27, v0.15.1)', () => {
  test('POSITIVE — q3-planning-notes.md keeps .md outside the truncating stem', () => {
    expect(nameSpan(renderStrip([textFile('q3-planning-notes.md')]), 'q3-planning-notes.md')).toBe(
      '<span class="truncate">q3-planning-notes</span><span class="shrink-0">.md</span>',
    )
  })

  test('BOUNDARY — no extension, a leading dot, or one longer than 8 characters truncates whole', () => {
    for (const name of ['Makefile', '.env', 'settings.reference-snapshot']) {
      expect({ name, span: nameSpan(renderStrip([textFile(name)]), name) }).toEqual({
        name,
        span: `<span class="truncate">${name}</span>`,
      })
    }
    // The 8-character edge itself still splits (dot included): `.markdown` is 9, `.ts-node` is 8.
    expect(nameSpan(renderStrip([textFile('a.ts-node')]), 'a.ts-node')).toContain('<span class="shrink-0">.ts-node</span>')
  })

  test('the remove dot names what it removes, and a long paste keeps its title and restore link (ours)', () => {
    const markup = renderStrip([textFile('q3-planning-notes.md'), PASTED])
    expect(markup).toContain(`aria-label="${enMessages['common.remove']}: q3-planning-notes.md"`)
    expect(nameSpan(markup, enMessages['chat.pastedText.title']!)).toBe(
      `<span class="truncate">${enMessages['chat.pastedText.title']}</span>`,
    )
    expect(markup).toContain(`>${enMessages['chat.pastedText.showInTextField']}</button>`)
    // The Codex-parity radius coupling left with the glass composer.
    expect(markup).not.toContain('composer-attachment-surface')
    expect(markup).not.toContain('--composer-radius-eff')
  })
})

describe('AttachmentPreview inside the composer form (F1.733)', () => {
  test('every button in the strip is type="button" — three remove X plus the pasted-text restore link', () => {
    const buttons = buttonTags(render({}))
    expect(buttons).toHaveLength(4)
    expect(buttons.filter(tag => !/\btype="button"/.test(tag))).toEqual([])
  })

  test('a disabled strip renders no button at all', () => {
    expect(buttonTags(render({ disabled: true }))).toEqual([])
  })
})
