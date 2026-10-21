/**
 * F1.180 (origin WJ-g, P-WJ-g-2) — after a Stop with a follow-up queued, is the
 * user told that their message is PAUSED rather than next?
 *
 * ## The row's premise is REFUTED, and this file is what replaces it
 *
 * The plan row reads *"no banner says so"*. Measured at HEAD, every link of the
 * chain already exists — the proposal it was compressed from says as much in its
 * own second sentence — and what was missing is the PIN, which is exactly the
 * control the row names. The three links:
 *
 *  1. the HOST pauses and BROADCASTS. `cancelProcessing` sets
 *     `managed.queuePaused = true` inside the same synchronous frame as
 *     `forceAbort` whenever the queue is non-empty (D1.376) and then calls
 *     `emitQueueChanged`, so the renderer gets `queue_changed` carrying
 *     `paused: true`. `cancel-processing-stop-first.test.ts` owns the ordering
 *     half of that; the arm here reads the block itself, because a pause that is
 *     never broadcast is indistinguishable from no pause at all from the user's
 *     side, and nothing else in the tree asserts the two live together.
 *  2. the RENDERER keeps it. `ChatInputZone` stores `event.paused` into
 *     `queueState` from that one event, and hydrates the same pair from
 *     `queueGet` on mount.
 *  3. the STRIP draws it. `QueuedMessageList` renders the banner and a Resume
 *     action when `paused` — and renders NOTHING AT ALL when the queue is empty,
 *     which is the row's own negative: a Stop with no queue leaves no banner
 *     behind, because there is nothing parked to explain.
 *
 * ## The product posture, stated and NOT taken
 *
 * Whether the follow-up should AUTO-RESUME after a Stop is a product decision
 * and it is the owner's. What ships is the explicit form: the queue stays
 * paused, the banner says why, and a Resume control is offered beside it. This
 * file pins that shape rather than choosing the other one — an arm here would
 * have to encode the posture to test it, which is how a test comes to decide a
 * product question nobody asked it to.
 *
 * ## The instrument
 *
 * `renderToStaticMarkup`, the renderer instrument this repo already uses
 * (`components/ui/__tests__/compact-chat-card.test.tsx`), so no DOM is needed.
 * The `pdfjs-dist` stubs and the `DOMMatrix` polyfill below are ONE block copied
 * together on purpose: `@nessy-agent/ui`'s barrel pulls `pdfjs-dist`, and
 * AGENTS.md records that taking the visible half (the two `mock.module` lines)
 * without the polyfill leaves a second, nested pdfjs copy that throws
 * `ReferenceError: DOMMatrix is not defined` after ~136 s.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

// `@nessy-agent/ui`'s barrel transitively imports pdfjs-dist; its worker URL
// import is unresolvable under bun, and `react-pdf` resolves a SECOND nested
// copy that the bare-specifier stub cannot reach — hence the polyfill.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

const INPUT_DIR = join(import.meta.dir, '..')
const CHAT_INPUT_ZONE = join(INPUT_DIR, 'ChatInputZone.tsx')
const SESSION_MANAGER = join(
  import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..',
  'packages', 'server-core', 'src', 'sessions', 'SessionManager.ts',
)

/** Passthrough translations, so the assertions key on stable i18n keys. */
const KEYS = [
  'chat.queue.pausedBanner', 'chat.queue.resume', 'chat.queue.steer',
  'chat.queue.edit', 'chat.queue.delete', 'chat.queue.moveUp', 'chat.queue.moveDown',
  'chat.queue.attachmentsOnly',
]

// Both are imported INSIDE `beforeAll`: a static import is hoisted above the
// `mock.module` calls, and the pdfjs stub is then registered too late — which
// presents as the unresolvable worker-URL import rather than as anything about
// this test.
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

const FOLLOW_UP = { id: 'q1', text: 'and then deploy it', attachmentsCount: 0 }

function renderStrip(queue: unknown[], paused: boolean): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>
      <QueuedMessageList
        queue={queue as never}
        paused={paused}
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

describe('F1.180 · a stopped-behind follow-up says it is PAUSED', () => {
  it('THE ROW: a Stop with a queued message draws the banner and a Resume action', () => {
    const markup = renderStrip([FOLLOW_UP], true)

    expect(markup).toContain('chat.queue.pausedBanner')
    expect(markup).toContain('chat.queue.resume')
    // The message itself is still there — the banner explains the queue, it does
    // not replace it.
    expect(markup).toContain('and then deploy it')
  })

  it('THE NEGATIVE the row names: a Stop with NOTHING queued leaves no banner', () => {
    // `cancelProcessing` does not pause an empty queue, and the strip renders
    // nothing at all in that state — so the no-queue Stop is silent on both
    // sides. Asserted with `paused` TRUE, which is the stronger form: even a
    // paused flag arriving with an empty queue cannot put a banner in front of
    // a user who parked nothing.
    expect(renderStrip([], true)).toBe('')
    expect(renderStrip([], false)).toBe('')
  })

  it('CONTROL: a queued message with the queue LIVE shows the message and no banner', () => {
    // The arm that separates "the banner is keyed on `paused`" from "the banner
    // appears whenever something is queued" — without it the row's arm would
    // pass on a strip that always shouts.
    const markup = renderStrip([FOLLOW_UP], false)

    expect(markup).toContain('and then deploy it')
    expect(markup).not.toContain('chat.queue.pausedBanner')
    expect(markup).not.toContain('chat.queue.resume')
  })
})

describe('F1.180 · the two links above the strip', () => {
  it('the renderer keeps the paused flag the one queue event carries', () => {
    const src = readFileSync(CHAT_INPUT_ZONE, 'utf-8')
    const at = src.indexOf("if (event.type !== 'queue_changed'")
    expect(at).toBeGreaterThan(0)
    const handler = src.slice(at, src.indexOf('\n    })', at))
    // A runaway slice would swallow the rest of the component and make the
    // assertion below pass for a match anywhere in it.
    expect(handler.length).toBeLessThan(300)

    expect(handler).toContain('setQueueState({ queue: event.queue, paused: event.paused })')
    // And the mount path hydrates the same pair, so a reload does not lose it.
    expect(src).toContain('window.electronAPI.queueGet(sessionId)')
  })

  it('the host sets the flag and BROADCASTS it in the same block', () => {
    // The link that makes the user-facing claim true rather than merely the
    // host-state one. `cancel-processing-stop-first.test.ts` owns the ORDERING
    // (the pause lands in the same synchronous frame as `forceAbort`); what is
    // asserted here is that the pause and its broadcast live together, because
    // a pause the renderer never hears about is, to the user, no pause at all.
    const src = readFileSync(SESSION_MANAGER, 'utf-8')
    const at = src.indexOf('if (managed.messageQueue.length > 0) {\n      managed.queuePaused = true')
    expect(at).toBeGreaterThan(0)
    const block = src.slice(at, src.indexOf('\n    }\n', at))
    expect(block.length).toBeLessThan(600)

    expect(block).toContain('this.emitQueueChanged(managed)')
  })
})
