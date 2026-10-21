/**
 * UB14.15 (R2-10) — ChatDisplay split and wiring, v0.15.1 `app-shell/ChatDisplay.tsx` (+146/−588).
 *
 * What the row moved and wired: the live line, the scroll anchor and the turn frame leave ChatDisplay
 * as `chat-display/{ProcessingIndicator,ScrollOnMount,TurnFrame}.tsx`; the transcript is wrapped in
 * `RunCommandProvider` (Run in background on a settled shell block sends the background request,
 * UB14.16's message); the loading skeleton shows only after 200ms (`useDelayedLoading`); a session
 * switch swaps the transcript in one frame (a keyed `contents` wrapper, no crossfade); a new chat shows
 * `NewChatEmptyState`; and the `sessionStatuses` / `onSessionStatusChange` / `onInsertMessage` props go.
 *
 * Instruments. `ChatDisplay.tsx` cannot be imported by a bare bun process (`ThemeContext.tsx` reaches
 * Vite's `import.meta.glob`; see `never-persist-badge-mount.test.tsx`), so its SHAPE is read from its
 * comment-stripped source, while every BEHAVIOUR is driven on the real module that owns it:
 * `transcriptRunCommand` (the provider's value), the real `CodeBlock` (Run → the runner, the probe of
 * `packages/ui/.../code-block-run.test.tsx`) and the real `ResponseCard` (a settled answer offers Run, a
 * streaming one does not). `@nessy-agent/ui` reaches `pdfjs-dist`, so the pdfjs recipe runs first and
 * the modules are imported inside `beforeAll`.
 *
 * Arms (the row's):
 * - positive: ChatDisplay holds no message-rendering function (a source census); Run on a completed
 *   `bash` block sends the background request through `transcriptRunCommand`.
 * - negative (control): Run is absent while streaming; the census FAILS on a planted inline
 *   `function MessageBubble`; the /btw panel (a side-question session) and no session get no runner.
 *
 * UB12.91 — the runner also needs `ComposerCapabilities.backgroundShell`, the field the composer's
 * pasted-snippet offer reads (UB14.34), so the two Run surfaces cannot disagree. Its arms are driven
 * through the REAL server-side resolver (`resolveComposerCapabilities`, env passed so the host's own env
 * cannot decide them): positive, a Pi and a Claude session keep the runner; negative, a codex session, a
 * Pi or Claude session under `NESSY_DISABLE_BACKGROUND_TASKS=1`, and an older server reporting no
 * capabilities get none.
 */
import { beforeAll, describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import en from '../../../../../../../../packages/shared/src/i18n/locales/en.json'
import ru from '../../../../../../../../packages/shared/src/i18n/locales/ru.json'
import { resolveComposerCapabilities } from '@nessy-agent/shared/agent/backend/composer-capabilities'
import { runCommandMessage } from '@/lib/run-command-message'
import { transcriptRunCommand } from '../transcript-run-command'
import { sideQuestionSessionId } from '../../side-question-composer'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  ;(globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    is2D = true
  }
}

let UI: typeof import('@nessy-agent/ui')
let i18n: I18nInstance

beforeAll(async () => {
  UI = await import('@nessy-agent/ui')
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
}, MODULE_GRAPH_HOOK_BUDGET_MS)

/** Comment-stripped source: these comments quote the very strings the census pins. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * The renderers that live in `chat-display/` since UB14.14/UB14.15. A declaration of any of them in
 * ChatDisplay — a function, a `const X =` component or a memo — is a renderer that came back inline.
 */
const EXTRACTED = [
  'MessageBubble', 'MemoizedMessageBubble', 'ErrorMessage', 'MemoryContextMenu', 'ProcessingIndicator',
  'ScrollOnMount', 'TurnFrame', 'TranscriptSkeleton', 'TranscriptLoadError', 'NoRenderableMessages',
  'CompactEmptyState', 'NewChatEmptyState', 'EarlierMessagesHint',
] as const

/** Every extracted renderer DECLARED in `source` (not merely used). */
function inlineRenderers(source: string): string[] {
  return EXTRACTED.filter(name => new RegExp(
    String.raw`(?:\bfunction\s+${name}\s*[(<]|\b(?:const|let|var)\s+${name}\s*[:=]|\binterface\s+${name}Props\b)`,
  ).test(source))
}

const RUN = 'Run in background'
/** A session whose runtime backgrounds a shell command (the field `resolveComposerCapabilities` sets). */
const WITH_SHELL = { backgroundShell: true as const }
const RUN_LABEL = `aria-label="${RUN}"`

describe('ChatDisplay holds no message-rendering function (the census)', () => {
  const display = stripped('../../ChatDisplay.tsx')

  it('POSITIVE — none of the extracted renderers is declared in ChatDisplay; each is imported', () => {
    expect(inlineRenderers(display)).toEqual([])
    for (const file of ['MessageBubble', 'ProcessingIndicator', 'ScrollOnMount', 'TurnFrame', 'TranscriptStates', 'MemoryContextMenu']) {
      expect(display).toContain(`from "./chat-display/${file}"`)
    }
  })

  it('NEGATIVE (control) — the census reports a planted inline `function MessageBubble`', () => {
    const planted = `${display}\nfunction MessageBubble({ message }: MessageBubbleProps) { return null }\n`
    expect(inlineRenderers(planted)).toEqual(['MessageBubble'])
    // …and a memoised component and a props interface are caught the same way.
    expect(inlineRenderers('const ProcessingIndicator = React.memo(() => null)')).toEqual(['ProcessingIndicator'])
    expect(inlineRenderers('interface TurnFrameProps { a: 1 }')).toEqual(['TurnFrame'])
  })
})

describe('ChatDisplay wiring is v0.15.1\'s (source shape)', () => {
  const display = stripped('../../ChatDisplay.tsx')

  it('the whole pane is inside RunCommandProvider, valued by transcriptRunCommand', () => {
    expect(display).toContain('<RunCommandProvider value={handleRunCommand}>')
    expect(display.trimEnd().endsWith('</RunCommandProvider>\n  )\n})')).toBe(true)
    expect(display).toContain('transcriptRunCommand(session?.id, session?.composerCapabilities, (message) => onSendMessage(message))')
    expect(display).toContain('[session?.id, session?.composerCapabilities, onSendMessage]')
  })

  it('the skeleton waits 200ms; a session switch is a keyed `contents` swap with no crossfade', () => {
    expect(display).toContain('const showTranscriptSkeleton = useDelayedLoading(messagesLoading)')
    expect(display).toContain('showTranscriptSkeleton ? <TranscriptSkeleton /> : null')
    expect(display).toContain(`<div key={compactMode ? 'compact-session' : session?.id} className="contents">`)
    expect(display).not.toMatch(/from "motion\/react"/)
    expect(display).not.toContain('AnimatePresence')
    expect(display).not.toContain('<Spinner')
  })

  it('every turn is framed by TurnFrame (the search ring lives there, not inline)', () => {
    expect(display.match(/<TurnFrame\b/g)).toHaveLength(4)
    expect(display.match(/registerRef=\{registerTurnRef\}/g)).toHaveLength(4)
    expect(display).not.toContain('ring-info')
  })

  it('an empty chat in the app gets NewChatEmptyState; an embedding keeps the compact one (D1.382)', () => {
    expect(display).toContain('const isCompactEmbedding = compactMode && (emptyStateLabel !== undefined || !enableCompactModelPicker)')
    expect(display).toContain('{isCompactEmbedding && turns.length === 0 && <CompactEmptyState label={emptyStateLabel} />}')
    expect(display).toContain('{!isCompactEmbedding && turns.length === 0 && !hasUnrenderedLoadedMessages && (')
    expect(display).toContain('<NewChatEmptyState compact={compactMode} />')
  })

  it('the props v0.15.1 removed are gone', () => {
    for (const gone of ['sessionStatuses', 'onSessionStatusChange', 'onInsertMessage']) {
      expect(display).not.toContain(gone)
    }
    // CONTROL on the same instrument: a prop that stays is still read.
    expect(display).toContain('onLabelsChange={onLabelsChange}')
  })
})

describe('Run in background sends the background request (transcriptRunCommand)', () => {
  it('POSITIVE — a session runner sends UB14.16\'s message for the command', () => {
    const sent: string[] = []
    const run = transcriptRunCommand('session-1', WITH_SHELL, message => sent.push(message))
    expect(run).not.toBeNull()
    run!('bun test')
    expect(sent).toEqual([runCommandMessage('bun test')])
    expect(sent[0]).toContain('run_in_background: true')
  })

  it('NEGATIVE (control) — no session and the /btw panel get no runner, even with the capability', () => {
    const send = () => { throw new Error('must not send') }
    expect(transcriptRunCommand(undefined, WITH_SHELL, send)).toBeNull()
    expect(transcriptRunCommand(null, WITH_SHELL, send)).toBeNull()
    expect(transcriptRunCommand(sideQuestionSessionId('session-1'), WITH_SHELL, send)).toBeNull()
  })
})

describe('UB12.91 — the transcript runner follows ComposerCapabilities.backgroundShell', () => {
  const on: Record<string, string | undefined> = {}
  const off: Record<string, string | undefined> = { NESSY_DISABLE_BACKGROUND_TASKS: '1' }

  it('POSITIVE — a Pi and a Claude session (the resolver sets the field) keep the runner, and it sends', () => {
    for (const provider of ['pi', 'anthropic'] as const) {
      const sent: string[] = []
      const run = transcriptRunCommand('session-1', resolveComposerCapabilities({ provider, env: on }), message => sent.push(message))
      expect(run, provider).not.toBeNull()
      run!('bun test')
      expect(sent, provider).toEqual([runCommandMessage('bun test')])
    }
  })

  it('NEGATIVE (control) — a codex session, a session under the off switch and no capabilities get null', () => {
    const send = () => { throw new Error('must not send') }
    expect(transcriptRunCommand('session-1', resolveComposerCapabilities({ provider: 'codex-runtime', env: on }), send)).toBeNull()
    for (const provider of ['pi', 'anthropic'] as const) {
      expect(transcriptRunCommand('session-1', resolveComposerCapabilities({ provider, env: off }), send), provider).toBeNull()
    }
    // An older server that reported no capabilities: the conservative default, as `pastedCommandRunner`.
    expect(transcriptRunCommand('session-1', undefined, send)).toBeNull()
    expect(transcriptRunCommand('session-1', {}, send)).toBeNull()
  })
})

/** Elements carrying `aria-label === label` anywhere in an element tree. */
function labelled(node: React.ReactNode, label: string, out: React.ReactElement[] = []): React.ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) labelled(child, label, out)
    return out
  }
  if (!React.isValidElement(node)) return out
  const props = node.props as { 'aria-label'?: string; children?: React.ReactNode }
  if (props['aria-label'] === label) out.push(node)
  labelled(props.children, label, out)
  return out
}

describe('a completed bash block in the transcript runs through the runner; a streaming one offers no Run', () => {
  function withProviders(node: React.ReactNode): React.ReactElement {
    return (
      <I18nextProvider i18n={i18n}>
        <UI.TooltipProvider>{node}</UI.TooltipProvider>
      </I18nextProvider>
    )
  }

  it('POSITIVE — Run on a bash block sends the background request with the de-prompted command', () => {
    const sent: string[] = []
    const runner = transcriptRunCommand('session-1', WITH_SHELL, message => sent.push(message))
    let tree: React.ReactNode = null
    function Probe(): React.ReactElement {
      // The probe hosts CodeBlock's hooks so its element tree is in hand (code-block-run.test.tsx).
      tree = UI.CodeBlock({ code: '$ git status', language: 'bash' })
      return <>{tree}</>
    }
    renderToStaticMarkup(withProviders(<UI.RunCommandProvider value={runner}><Probe /></UI.RunCommandProvider>))
    const run = labelled(tree, RUN)
    expect(run).toHaveLength(1)
    ;(run[0]!.props as { onClick?: (event: unknown) => void }).onClick?.({})
    expect(sent).toEqual([runCommandMessage('git status')])
  })

  const ANSWER = [
    'Run the suite with this command and then share the output with me so we can compare the numbers:',
    '',
    '```bash',
    'bun test ./packages/ui',
    '```',
  ].join('\n')

  function answer(isStreaming: boolean): string {
    const runner = transcriptRunCommand('session-1', WITH_SHELL, () => {})
    return renderToStaticMarkup(withProviders(
      <UI.RunCommandProvider value={runner}>
        <UI.ResponseCard text={ANSWER} isStreaming={isStreaming} streamStartTime={Date.now() - 5_000} />
      </UI.RunCommandProvider>,
    ))
  }

  it('POSITIVE — a settled answer under the transcript runner offers Run on its bash block', () => {
    expect(answer(false)).toContain(RUN_LABEL)
  })

  it('NEGATIVE (control) — the same answer while streaming offers no Run, and still draws the block', () => {
    const html = answer(true)
    expect(html).not.toContain(RUN_LABEL)
    // The block is on screen (Copy is its control on the same instrument), so the absence is Run's.
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain('bun test ./packages/ui')
  })
})
