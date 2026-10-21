/**
 * F1.331 — "Steer" on a queued row that carries FILES was a silent press.
 *
 * Since F1.244 the host keeps such a row queued when "Steer" is pressed mid-turn
 * (`SessionManager.sendQueuedNow`: a steer is a text door on all three runtimes,
 * so the files would be dropped). The strip still offered the control, so the
 * press did nothing and said nothing. Steer on a row with `attachmentsCount > 0`
 * is now disabled WITH its reason (`chat.queue.steerBlockedByFiles`), left
 * focusable (`aria-disabled`, not `disabled`) so the tooltip reaches the keyboard,
 * and its press is a no-op. The composer half of the row (the send control's
 * label for a draft with staged files) is pinned in `submit-control.test.ts`.
 *
 * Rig and instrument as in `queue-row-attachments.test.tsx` (F1.339, the Edit
 * half): `renderToStaticMarkup`, the `pdfjs-dist` stubs and `DOMMatrix` polyfill
 * copied as ONE block; a closed Radix tooltip renders nothing, so the reason's key
 * is pinned on the source beside the markup arm.
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
  'chat.queue.attachmentsOnly', 'chat.queue.steerBlockedByFiles', 'chat.queue.steerBlockedWholeTurn',
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

describe('F1.331 — Steer on a queued row with files is disabled with a reason', () => {
  it('THE ROW: a row carrying files offers Steer as aria-disabled, and a text-only row beside it does not', () => {
    const steers = buttonTags(renderStrip([FILE_ROW, TEXT_ROW]), 'chat.queue.steer')

    expect(steers).toHaveLength(2)
    expect(steers[0]).toContain('aria-disabled="true"')
    expect(steers[1]).not.toContain('aria-disabled="')
  })

  it('the press is a no-op on such a row, and the tooltip says why instead of the usual hint', () => {
    const src = readFileSync(LIST_SOURCE, 'utf-8')
    const at = src.indexOf("aria-label={t('chat.queue.steer')}")
    expect(at).toBeGreaterThan(0)
    const steer = src.slice(at, src.indexOf('</Tooltip>', at))
    // Bounded by the Steer tooltip's own close; the move-up control is declared below it.
    expect(steer.length).toBeLessThan(1_100) // F1.481 (2) grew the region to ~917 with its second reason
    expect(steer).not.toContain('chat.queue.moveUp')

    expect(steer).toContain('if (!isUnsteerableQueueRow(m)) onSteer(m.id)')
    expect(steer).toContain("t('chat.queue.steerBlockedByFiles')")
    expect(steer).toContain("m.steerable === false ? t('chat.queue.steerBlockedWholeTurn')")
    expect(steer).toContain("t('chat.queue.steerTooltip')")
  })

  it('CONTROL — Steer on a text-only row is unchanged: enabled', () => {
    const [steer] = buttonTags(renderStrip([TEXT_ROW]), 'chat.queue.steer')

    expect(steer).toBeDefined()
    expect(steer).not.toContain('aria-disabled="')
    expect(steer).not.toMatch(/\sdisabled=""/)
  })
})

/**
 * F1.481 (2) — P-qqb-3: since F1.337 the host keeps a queued WORKFLOW row queued
 * when Steer is pressed mid-turn, and the strip knew only about files, so the
 * press did nothing and said nothing. The DTO now carries the host's verdict
 * (`steerable`), and the strip disables Steer on such a row WITH a reason.
 */
describe('F1.481 (2) — Steer on a queued workflow row is disabled with a reason', () => {
  const WORKFLOW_ROW = { id: 'q-wf', text: 'run the release', attachmentsCount: 0, steerable: false }
  const HOST_TEXT_ROW = { id: 'q-t', text: 'and then deploy it', attachmentsCount: 0, steerable: true }

  it('THE ROW: a host-unsteerable row with no files offers Steer as aria-disabled; a steerable text row beside it does not', () => {
    const steers = buttonTags(renderStrip([WORKFLOW_ROW, HOST_TEXT_ROW]), 'chat.queue.steer')
    expect(steers).toHaveLength(2)
    expect(steers[0]).toContain('aria-disabled="true"')
    expect(steers[1]).not.toContain('aria-disabled="')
  })

  it('CONTROL — an older host that sends no verdict: a text row stays enabled', () => {
    const [steer] = buttonTags(renderStrip([TEXT_ROW]), 'chat.queue.steer')
    expect(steer).not.toContain('aria-disabled="')
  })
})
