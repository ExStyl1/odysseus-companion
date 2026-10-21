/**
 * UB14.14 (R3-08) — the transcript messages extracted as v0.15.1
 * `app-shell/chat-display/{MessageBubble,ErrorMessage,TranscriptStates}.tsx`, with OUR specifics
 * re-applied: the runtime-switch marker (now in the compaction divider's material), D1.194/D1.272
 * credential sign-in first and primary, the P2.37 terminal-reason notice, F1.351's task-notification
 * line, P6.712/P6.731's info layout, C3.331's heading through `chat.warning`, and D1.382's label.
 *
 * Instrument: `renderToStaticMarkup` (no DOM library ships in this repo); lucide draws
 * `lucide-<kebab-name>` into the svg class, `Button` its `data-variant`. The components reach
 * `pdfjs-dist` through `Markdown` (the `@nessy-agent/ui` barrel), whose `?url` worker import bun
 * cannot link, so the pdfjs recipe runs first and the modules are imported INSIDE `beforeAll`
 * (a static import would hoist above the stubs) — the recipe of
 * `input/__tests__/queue-paused-banner.test.tsx`. Labels come from a private i18next instance with
 * the real en/ru tables, so no arm depends on which file initialised the global one.
 *
 * Arms (the row's):
 * - positive: an `info` row `runtime_switched:pi:anthropic:{"carry":"native"}` renders the switch
 *   RULE (two separator hairlines, the swap icon, the native-carry sentence) — the plan's
 *   `pi:claude` spelling is not a runtime id (`runtimeLabel` keys are `pi | anthropic |
 *   codex-runtime`), so the measured id is used; an `invalid_api_key` error (a member of
 *   `CREDENTIAL_ERROR_CODES` — the plan's "auth" is that family) renders
 *   `[data-testid=credential-sign-in]` FIRST, as the primary, and drops the backend's `settings`.
 * - negative (control): an unknown `terminal_reason:` renders NOTHING; a `taskNotification` user
 *   entry renders the labelled line and never the user bubble (its unmarked twin does).
 * - the look: the assistant answer is plain copy (no card), the info row is v0.15.1's, a list keeps
 *   its lines, the error title reads once, the warning heading is `chat.warning` in both locales,
 *   and the transcript states (skeleton, load error with `common.retrying`, D1.382's label).
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { Provider as JotaiProvider, createStore } from 'jotai'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import en from '../../../../../../../../packages/shared/src/i18n/locales/en.json'
import ru from '../../../../../../../../packages/shared/src/i18n/locales/ru.json'
import type { Message } from '../../../../../shared/types'

// The pdfjs recipe, one block: the worker-URL stub, the bare-specifier stub, and the polyfill for
// the SECOND, nested pdfjs copy `react-pdf` resolves, which the stubs cannot reach.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let MessageBubble: typeof import('../MessageBubble')['MessageBubble']
let States: typeof import('../TranscriptStates')
let TooltipProvider: typeof import('@nessy-agent/ui/ui/tooltip')['TooltipProvider']
let sessionMetaMapAtom: typeof import('@/atoms/sessions')['sessionMetaMapAtom']
const i18nByLng: Partial<Record<'en' | 'ru', I18nInstance>> = {}

beforeAll(async () => {
  MessageBubble = (await import('../MessageBubble')).MessageBubble
  States = await import('../TranscriptStates')
  TooltipProvider = (await import('@nessy-agent/ui/ui/tooltip')).TooltipProvider
  sessionMetaMapAtom = (await import('@/atoms/sessions')).sessionMetaMapAtom
  // One private instance per language, so no arm waits on a language switch.
  for (const lng of ['en', 'ru'] as const) {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: 'en',
      resources: { en: { translation: en }, ru: { translation: ru } },
      interpolation: { escapeValue: false },
    })
    i18nByLng[lng] = instance
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

const noop = () => {}

function render(node: React.ReactNode, lng: 'en' | 'ru' = 'en'): string {
  const store = createStore()
  // The failing session's connection, as the renderer's own per-session state carries it (D1.272).
  store.set(sessionMetaMapAtom, new Map([['s-1', { llmConnection: 'claude-gateway' }]]) as never)
  return renderToStaticMarkup(
    <JotaiProvider store={store}>
      <I18nextProvider i18n={i18nByLng[lng]!}>
        <TooltipProvider>{node}</TooltipProvider>
      </I18nextProvider>
    </JotaiProvider>,
  )
}

function bubble(message: Partial<Message> & Pick<Message, 'role' | 'content'>, lng: 'en' | 'ru' = 'en'): string {
  const full = { id: `m-${message.role}`, timestamp: 0, ...message } as Message
  return render(
    <MessageBubble message={full} onOpenFile={noop} onOpenUrl={noop} sessionId="s-1" onRetry={noop} onPopOut={noop} />,
    lng,
  )
}

/** Text as `renderToStaticMarkup` escapes it (React's own five). */
const esc = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')
/** An en value, escaped for comparison with rendered markup. */
const tr = (key: string) => esc((en as Record<string, string>)[key]!)

describe('the runtime-switch marker is a divider (ours, in v0.15.1 material)', () => {
  it('POSITIVE — a native-carry marker renders the rule with the swap icon and its sentence', () => {
    const html = bubble({ role: 'info', content: 'runtime_switched:pi:anthropic:{"carry":"native"}' })
    expect(html).toContain('data-runtime-switch-marker=""')
    expect(html).toContain('lucide-arrow-left-right')
    // Two hairlines on v0.15.1's separator role, like the compaction divider.
    expect(html.match(/h-px flex-1 bg-separator/g)?.length).toBe(2)
    const sentence = tr('chat.runtimeSwitch.noticeNative').replaceAll('{{from}}', 'Pi').replaceAll('{{to}}', 'Claude')
    expect(sentence).toContain('Pi → Claude')
    expect(html).toContain(sentence)
    // The marker never falls through to the notice line, which would print the raw marker.
    expect(html).not.toContain('runtime_switched:')
  })

  it('the compaction divider is v0.15.1\'s: separator hairlines, a tertiary label-sm caption', () => {
    const html = bubble({ role: 'info', content: '', statusType: 'compaction_complete' })
    expect(html).toContain('my-4 flex items-center gap-3')
    expect(html).toContain('select-none text-label-sm text-tertiary')
    expect(html).toContain(tr('chat.conversationCompacted'))
  })
})

describe('the error marker: credential sign-in first (D1.194/D1.272)', () => {
  const authError: Partial<Message> & Pick<Message, 'role' | 'content'> = {
    role: 'error',
    errorCode: 'invalid_api_key',
    errorTitle: 'Authentication failed',
    content: 'Authentication failed: the API key for this connection was rejected.',
    errorActions: [
      { key: 'settings', label: 'Settings', action: 'settings' },
      { key: 'retry', label: 'Retry', action: 'retry' },
    ],
  }

  it('POSITIVE — the sign-in is the first button, the primary, and the backend settings action is gone', () => {
    const html = bubble(authError)
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(m => m[0])
    expect(buttons[0]).toContain('data-testid="credential-sign-in"')
    expect(buttons[0]).toContain('data-variant="primary"')
    expect(html).toContain(`>${tr('chat.credentialSignIn')}</button>`)
    // The replaced action is dropped; the other stays, quiet.
    expect(html).not.toContain('>Settings</button>')
    const retry = buttons.find(b => !b.includes('credential-sign-in'))
    expect(retry).toContain('data-variant="ghost"')
  })

  it('control — a non-credential error has no sign-in, keeps every action, and its FIRST action is the primary', () => {
    const html = bubble({ ...authError, errorCode: 'rate_limited' })
    expect(html).not.toContain('credential-sign-in')
    expect(html).toContain('>Settings</button>')
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map(m => m[0])
    expect(buttons[0]).toContain('data-variant="primary"')
    expect(buttons[1]).toContain('data-variant="ghost"')
  })

  it('the look: the destructive tint marker, and the title reads once (stripRepeatedTitle)', () => {
    const html = bubble(authError)
    expect(html).toContain('bg-destructive-tint')
    expect(html).toContain('lucide-circle-alert')
    expect(html).toContain('>Authentication failed</div>')
    expect(html).toContain('>the API key for this connection was rejected.</p>')
  })
})

describe('the terminal-reason notice (P2.37)', () => {
  it('POSITIVE — a known reason renders its sentence on the notice line', () => {
    const html = bubble({ role: 'info', content: 'terminal_reason:max_agent_turns', infoLevel: 'warning' })
    expect(html).toContain(tr('chat.terminalReason.maxAgentTurns'))
    expect(html).toContain('lucide-triangle-alert')
  })

  it('NEGATIVE (control) — an unknown reason renders nothing at all', () => {
    expect(bubble({ role: 'info', content: 'terminal_reason:some_future_reason' })).toBe('')
  })
})

describe('the task notification line (F1.351)', () => {
  const delivery = '<task-notification>\nBackground subagent task t-1 finished (completed).\n</task-notification>'

  it('NEGATIVE (control) — a marked user entry is the labelled line, never the user bubble', () => {
    const marked = bubble({ role: 'user', content: delivery, taskNotification: true })
    const unmarked = bubble({ role: 'user', content: 'Plain user text' })
    expect(marked).toContain('data-task-notification=""')
    expect(marked).toContain(tr('chat.taskNotification.label'))
    expect(marked).not.toContain('flex w-full flex-col items-end gap-2')
    // The instrument can see the bubble: its unmarked twin draws it.
    expect(unmarked).toContain('flex w-full flex-col items-end gap-2')
    expect(unmarked).not.toContain('data-task-notification')
  })
})

describe('the rest of v0.15.1\'s look', () => {
  it('the assistant answer is plain copy with a named pop-out icon button, not a card', () => {
    const html = bubble({ role: 'assistant', content: 'The answer.' })
    expect(html).toContain('group relative min-w-0 select-text break-words text-copy text-foreground')
    expect(html).toContain('data-slot="icon-button"')
    expect(html).toContain(`aria-label="${tr('sidebarMenu.openInNewWindow')}"`)
    expect(html).not.toContain('shadow-minimal')
  })

  it('an info row is v0.15.1\'s line; a list keeps its lines and can be selected (P6.712/P6.731)', () => {
    const one = bubble({ role: 'info', content: 'Plan approved.', infoLevel: 'success' })
    expect(one).toContain('min-h-7')
    expect(one).toContain('select-none')
    expect(one).toContain('items-center')
    expect(one).toContain('lucide-circle-check')
    const list = bubble({ role: 'info', content: '/help — this list\n/mcp — servers' })
    expect(list).toContain('whitespace-pre-wrap')
    expect(list).toContain('select-text')
    expect(list).not.toContain('select-none')
  })

  it('the warning marker reads chat.warning in both locales (C3.331)', () => {
    const content = 'Two attachments could not be stored.'
    expect(bubble({ role: 'warning', content })).toContain(`>${tr('chat.warning')}</div>`)
    expect(bubble({ role: 'warning', content }, 'ru')).toContain(`>${esc((ru as Record<string, string>)['chat.warning']!)}</div>`)
    expect(bubble({ role: 'warning', content })).toContain('bg-info-tint')
  })

  it('the status line is the live line: label text, the accent spinner', () => {
    const html = bubble({ role: 'status', content: 'Compacting conversation...' })
    expect(html).toContain('flex min-h-7 min-w-0 items-center gap-2 text-label text-secondary')
    expect(html).toContain('Compacting conversation...')
  })
})

describe('the transcript states', () => {
  it('the skeleton is a labelled status with the exchange shape', () => {
    const html = render(<States.TranscriptSkeleton />)
    expect(html).toContain('role="status"')
    expect(html).toContain(`aria-label="${tr('common.loading')}"`)
    expect(html.match(/data-slot="skeleton"/g)?.length).toBe(9)
  })

  it('the load error retries under common.retrying (the retired chat.retrying has no reader)', () => {
    const idle = render(<States.TranscriptLoadError error="EACCES" onRetry={noop} />)
    const busy = render(<States.TranscriptLoadError error="EACCES" onRetry={noop} isRetrying />)
    expect(idle).toContain(tr('chat.failedToLoadConversation'))
    expect(idle).toContain(`>${tr('common.retry')}</button>`)
    expect(busy).toContain(`>${tr('common.retrying')}</button>`)
    expect(busy).toContain('disabled=""')
    expect((en as Record<string, string>)['chat.retrying']).toBeUndefined()
  })

  it('D1.382 — a caller label replaces BOTH compact lines; with none, the edit popover keeps its two', () => {
    const own = render(<States.CompactEmptyState label="Ask a side question." />)
    const popover = render(<States.CompactEmptyState />)
    expect(own).toContain('Ask a side question.')
    expect(own).not.toContain(tr('editPopover.whatToChange'))
    expect(own).not.toContain(tr('editPopover.justDescribe'))
    expect(popover).toContain(tr('editPopover.whatToChange'))
    expect(popover).toContain(tr('editPopover.justDescribe'))
  })

  it('the new-chat moment is the serif display heading with our product name, never Craft', () => {
    const html = render(<States.NewChatEmptyState />)
    expect(html).toContain('font-serif text-foreground text-display')
    expect(html).toContain(tr('chat.newChatTitle'))
    expect(html).toContain(tr('chat.newChatSubtitle'))
    expect(html).not.toContain('Craft')
  })
})
