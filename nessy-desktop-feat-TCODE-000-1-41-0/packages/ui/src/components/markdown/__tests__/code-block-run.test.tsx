/**
 * UB14.9 (R3-02) — the code well's "Run in background" button, v0.15.1
 * `packages/ui/src/components/markdown/{CodeBlock.tsx,RunCommandContext.tsx,shell-command.ts}`.
 *
 * The rule under test (upstream's, taken 1:1): a code block shows Run only when (1) a
 * `RunCommandProvider` supplies a handler — the chat transcript does, and passes `null` while the
 * turn streams — (2) the block renders in `mode="full"`, and (3) `shellCommandFromBlock` finds a
 * command in it (shell/console languages only). Clicking Run hands the handler the de-prompted
 * command; the host decides what that means (in the app: a user message asking the agent, so the
 * session's own permission mode applies — UB14.15/UB14.16 wire it).
 *
 * Instruments. packages/ui ships no DOM harness, so presence is read from `renderToStaticMarkup`
 * (the instrument of `chat/turn/__tests__/turn-primitives.test.tsx`). The click is driven by hosting
 * CodeBlock's hooks in a probe: the probe CALLS `CodeBlock(props)` during its own render, so the
 * hooks are the probe's and the returned element tree is in hand; the Run element's `onClick` is
 * then invoked directly. The `setStarted(true)` that follows lands after the render returned, which
 * the server renderer drops (a no-op there) — only the handler call is observed, which is the arm.
 *
 * Arms:
 * - positive: a `bash` block written as a transcript inside `RunCommandProvider value={fn}` renders
 *   Run (named, the play glyph) beside Copy, and Run calls `fn` once with the prompts stripped;
 *   a `console` block hands over only its `$ ` commands, never the output lines.
 * - negative (the row's control): a `ts` block under the same provider, the `null` provider (a
 *   streaming turn), no provider at all, and `mode="terminal"` / `mode="minimal"` render no Run —
 *   while the `full` arms keep Copy, the positive control on the same instrument.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../../../../shared/src/i18n/locales/en.json'
import ru from '../../../../../shared/src/i18n/locales/ru.json'
import { TooltipProvider } from '../../tooltip'
import { TurnIconButton } from '../../chat/turn/TurnIconButton'
import { CodeBlock, type CodeBlockProps } from '../CodeBlock'
import { RunCommandProvider, type RunCommandHandler } from '../RunCommandContext'

// A private instance through the provider, so the labels never depend on which other test file
// initialised the global i18next first (the instrument of BackgroundFinishedChip.test.tsx).
let testI18n: I18nInstance
beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en }, ru: { translation: ru } },
    interpolation: { escapeValue: false },
  })
})

const RUN = 'Run in background'
const COPY = 'Copy code'

function withProviders(node: React.ReactNode): React.ReactElement {
  return (
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>{node}</TooltipProvider>
    </I18nextProvider>
  )
}

/** The static markup of one code block under an optional provider (`undefined` = no provider). */
function render(props: CodeBlockProps, runner?: RunCommandHandler | null): string {
  const block = <CodeBlock {...props} />
  return renderToStaticMarkup(withProviders(runner === undefined ? block : <RunCommandProvider value={runner}>{block}</RunCommandProvider>))
}

type IconButtonElement = React.ReactElement<React.ComponentProps<typeof TurnIconButton>>

function iconButtons(node: React.ReactNode, out: IconButtonElement[] = []): IconButtonElement[] {
  if (Array.isArray(node)) {
    for (const child of node) iconButtons(child, out)
    return out
  }
  if (!React.isValidElement(node)) return out
  if (node.type === TurnIconButton) out.push(node as IconButtonElement)
  iconButtons((node.props as { children?: React.ReactNode }).children, out)
  return out
}

/** CodeBlock's element tree, its hooks hosted by a probe under the provider (see the docblock). */
function codeBlockTree(props: CodeBlockProps, runner: RunCommandHandler | null): React.ReactNode {
  let tree: React.ReactNode = null
  function Probe(): React.ReactElement {
    tree = CodeBlock(props)
    return <>{tree}</>
  }
  renderToStaticMarkup(withProviders(<RunCommandProvider value={runner}><Probe /></RunCommandProvider>))
  return tree
}

const hasRun = (html: string): boolean => html.includes(`aria-label="${RUN}"`)

describe('CodeBlock Run in background (UB14.9)', () => {
  it('positive: a bash block under a provider renders Run (named, play glyph) beside Copy', () => {
    const html = render({ code: 'bun install\nbun test', language: 'bash' }, () => {})
    expect(hasRun(html)).toBe(true)
    expect(html).toContain('lucide-play')
    expect(html).toContain(`aria-label="${COPY}"`)
  })

  it('positive: the Run label reads the ru key under ru (keys commit 3a02333aa)', async () => {
    await testI18n.changeLanguage('ru')
    try {
      const html = render({ code: 'bun test', language: 'bash' }, () => {})
      expect(html).toContain(`aria-label="${ru['chat.runCommandInBackground']}"`)
      expect(ru['chat.runCommandInBackground']).not.toBe(en['chat.runCommandInBackground'])
      expect(ru['chat.runCommandStarted']).not.toBe(en['chat.runCommandStarted'])
    } finally {
      await testI18n.changeLanguage('en')
    }
  })

  it('positive: Run calls the handler once with the de-prompted command', () => {
    const ran: string[] = []
    const tree = codeBlockTree({ code: '$ git status\n$ git diff --stat', language: 'bash' }, command => ran.push(command))
    const run = iconButtons(tree).filter(button => button.props['aria-label'] === RUN)
    expect(run).toHaveLength(1)
    run[0]!.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    expect(ran).toEqual(['git status\ngit diff --stat'])
  })

  it('positive: a console block hands over only its $ commands, never the output', () => {
    const ran: string[] = []
    const code = '$ ls -la\ntotal 8\n$ echo done\ndone'
    const tree = codeBlockTree({ code, language: 'console' }, command => ran.push(command))
    iconButtons(tree).find(button => button.props['aria-label'] === RUN)?.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    expect(ran).toEqual(['ls -la\necho done'])
  })

  it('negative (control): a ts block under the same provider renders Copy and no Run', () => {
    const html = render({ code: "const x = 'no play button'", language: 'ts' }, () => {})
    expect(html).toContain(`aria-label="${COPY}"`)
    expect(hasRun(html)).toBe(false)
    expect(html).not.toContain('lucide-play')
  })

  it('negative (control): the null provider (a streaming turn) and no provider render no Run', () => {
    const streaming = render({ code: 'bun test', language: 'bash' }, null)
    expect(streaming).toContain(`aria-label="${COPY}"`)
    expect(hasRun(streaming)).toBe(false)
    expect(hasRun(render({ code: 'bun test', language: 'bash' }))).toBe(false)
    // the probe sees no Run element either, so nothing could be clicked
    expect(iconButtons(codeBlockTree({ code: 'bun test', language: 'bash' }, null)).map(b => b.props['aria-label'])).toEqual([COPY])
  })

  it('negative (control): mode="terminal" and mode="minimal" render no Run under a provider', () => {
    for (const mode of ['terminal', 'minimal'] as const) {
      const html = render({ code: 'bun test', language: 'bash', mode }, () => {})
      expect({ mode, run: hasRun(html), code: html.includes('bun test') }).toEqual({ mode, run: false, code: true })
    }
  })
})
