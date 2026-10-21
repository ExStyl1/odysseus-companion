/**
 * A queued row that carries FILES, and the two row actions that could only ever
 * carry its text.
 *
 * Since F1.244 every mid-turn send with attachments lands in the queue (a steer
 * is a text door on all three runtimes), so a row with `attachmentsCount > 0` is
 * on the default path, not a corner.
 *
 * - **F1.339 — Edit.** `ChatInputZone.handleQueueEdit` DELETES the row on the
 *   server and puts back only `text` (`onInputChange(text)`): the files were
 *   silently gone. Nothing on the renderer side can put them back — the composer
 *   takes `FileAttachment`s with bytes, a queue row reaches the renderer as
 *   `QueuedMessageDto { id, text, attachmentsCount }`, and the stored copies'
 *   paths are backend-only by contract (`SessionAttachmentDto`). The row names two
 *   acceptable fixes; the one taken is the smaller and the transparent one: Edit
 *   on such a row is DISABLED WITH A REASON (`chat.queue.editBlockedByFiles`),
 *   keyboard-focusable so the reason is reachable, and its press does nothing.
 *
 * The instrument is `renderToStaticMarkup` (this repo ships no DOM), as in
 * `queue-paused-banner.test.tsx`, whose `pdfjs-dist` stubs and `DOMMatrix`
 * polyfill are copied here as ONE block for the reason recorded there. A Radix
 * tooltip renders nothing while closed, so the reason's KEY is pinned on the
 * source beside the markup arm.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

const LIST_SOURCE = join(import.meta.dir, '..', 'QueuedMessageList.tsx')
const KEYS = [
  'chat.queue.pausedBanner', 'chat.queue.resume', 'chat.queue.steer', 'chat.queue.steerTooltip',
  'chat.queue.edit', 'chat.queue.delete', 'chat.queue.moveUp', 'chat.queue.moveDown',
  'chat.queue.attachmentsOnly', 'chat.queue.editBlockedByFiles',
]

let QueuedMessageList: typeof import('../QueuedMessageList')['QueuedMessageList']
let TooltipProvider: typeof import('@nessy-agent/ui')['TooltipProvider']
let testI18n: I18nInstance

beforeAll(async () => {
  QueuedMessageList = (await import('../QueuedMessageList')).QueuedMessageList
  TooltipProvider = (await import('@nessy-agent/ui')).TooltipProvider
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map(k => [k, k])) } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const TEXT_ROW = { id: 'q-text', text: 'and then deploy it', attachmentsCount: 0 }
const FILE_ROW = { id: 'q-file', text: 'what is on line 3 of it?', attachmentsCount: 1 }

function renderStrip(queue: unknown[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>
      <QueuedMessageList
        queue={queue as never}
        paused={false}
        onSteer={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onReorder={() => {}}
        onResume={() => {}}
      />
      </TooltipProvider>
    </I18nextProvider>,
  )
}

/** Every opening tag of a button labelled `label` in `markup`, in order. */
function buttonTags(markup: string, label: string): string[] {
  return [...markup.matchAll(new RegExp(`<button[^>]*aria-label="${label.replace(/\./g, '\\.')}"[^>]*>`, 'g'))].map(m => m[0])
}

describe('F1.339 — Edit on a queued row with files is disabled with a reason', () => {
  it('THE ROW: a row carrying files offers Edit as aria-disabled, and a text-only row beside it does not', () => {
    const edits = buttonTags(renderStrip([FILE_ROW, TEXT_ROW]), 'chat.queue.edit')

    expect(edits).toHaveLength(2)
    expect(edits[0]).toContain('aria-disabled="true"')
    expect(edits[1]).not.toContain('aria-disabled="')
  })

  it('the press is a no-op on such a row, and the tooltip carries the reason', () => {
    const src = readFileSync(LIST_SOURCE, 'utf-8')
    const at = src.indexOf("aria-label={t('chat.queue.edit')}")
    expect(at).toBeGreaterThan(0)
    const edit = src.slice(at, src.indexOf('</Tooltip>', at))
    // A runaway slice would reach the Delete button and pass on anything.
    expect(edit.length).toBeLessThan(900)
    expect(edit).not.toContain('chat.queue.delete')

    expect(edit).toContain('if (m.attachmentsCount === 0) onEdit(m.id, m.text)')
    expect(edit).toContain("t('chat.queue.editBlockedByFiles')")
  })

  it('CONTROL — Edit on a text-only row is unchanged: enabled, no reason attached', () => {
    const [edit] = buttonTags(renderStrip([TEXT_ROW]), 'chat.queue.edit')

    expect(edit).toBeDefined()
    expect(edit).not.toContain('aria-disabled="')
    expect(edit).not.toMatch(/\sdisabled=""/)
  })
})
