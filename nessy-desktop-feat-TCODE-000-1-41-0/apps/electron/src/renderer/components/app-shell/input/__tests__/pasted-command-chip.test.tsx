/**
 * UB14.34 (R4-14) — the paste-a-console-snippet offer: v0.15.0 `ChatInputZone.tsx` `PastedCommandChip` ("Run in
 * background" + dismiss, cleared when the pasted text leaves the draft) and `FreeFormInput.tsx` `handleTextPaste`,
 * gated on the session's runtime starting a background shell with its own tool (`ComposerCapabilities.backgroundShell`).
 *
 * Instruments, without a DOM (this repo ships none):
 * - the pure decisions in `pasted-command.ts`, DRIVEN with upstream's own classifier (`consoleSnippetCommand`, the
 *   source file rather than the `@nessy-agent/ui` barrel, which reaches pdfjs workers);
 * - `renderToStaticMarkup` of the chip, strings from the shipped `en.json`;
 * - the comment-stripped SOURCE of the three mounts (ChatInputZone, FreeFormInput, ChatDisplay): their module graphs
 *   reach Vite-only imports, so they are not rendered here (the chip's dark playground states are swept by
 *   `registry-render.test.ts`).
 *
 * Before the row none of this existed (`rg 'onConsoleSnippetPaste|PastedCommandChip'` → 0), so every POSITIVE arm
 * fails on it.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import { consoleSnippetCommand } from '../../../../../../../../packages/ui/src/components/markdown/shell-command'
import { PastedCommandChip, type PastedCommandChipProps } from '../PastedCommandChip'
import { pastedCommandRunner, runPastedSnippet, trackPastedSnippet, type PastedSnippet } from '../pasted-command'

const EN = LOCALE_REGISTRY.en.messages as Record<string, string>
let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    resources: { en: { translation: EN } },
    interpolation: { escapeValue: false },
  })
})

/** The chip's markup, without the `<!-- -->` separators a static render puts between adjacent text nodes. */
const renderChip = (props: PastedCommandChipProps) =>
  renderToStaticMarkup(<I18nextProvider i18n={testI18n}><PastedCommandChip {...props} /></I18nextProvider>).replaceAll('<!-- -->', '')

/** What FreeFormInput's `handleTextPaste` hands the zone for a pasted text (upstream's two lines, as a value). */
const pasteOf = (text: string): PastedSnippet | null => {
  const command = consoleSnippetCommand(text)
  return command ? { command, text } : null
}

const WITH_SHELL = { backgroundShell: true as const }

describe('the offer (pasted-command.ts)', () => {
  it('POSITIVE — pasting `$ bun test` makes an offer, and Run hands `bun test` to onRunCommand and clears the draft', () => {
    const ran: string[] = []
    const runner = pastedCommandRunner(command => { ran.push(command) }, WITH_SHELL)
    expect(runner).toBeDefined()
    const snippet = pasteOf('$ bun test')
    expect(snippet).toEqual({ command: 'bun test', text: '$ bun test' })
    // The paste lands in the draft: the offer has seen it and stays.
    expect(trackPastedSnippet(snippet!, '$ bun test', false)).toEqual({ seen: true, keep: true })
    expect(runPastedSnippet(snippet!, '$ bun test', runner!)).toEqual({ clearDraft: true })
    expect(ran).toEqual(['bun test'])
  })

  it('POSITIVE — the chip names the action and the command\'s first line; a multi-line command is marked " …" with the whole in its title', () => {
    const single = renderChip({ command: 'bun test', onRun: () => {}, onDismiss: () => {} })
    expect(single).toContain(`>${EN['chat.runCommandInBackground']}</span>`)
    expect(single).toContain('>bun test</span>')
    expect(single).toContain(`aria-label="${EN['common.dismiss']}"`)
    expect(single).toContain('data-pasted-command')
    // Upstream's look: the composer meta chip with an accent play glyph, the command in tertiary mono.
    for (const part of ['h-control-sm', 'rounded-full', 'bg-raised', 'size-3.5 shrink-0 text-accent', 'font-mono font-normal text-tertiary']) {
      expect({ part, drawn: single.includes(part) }).toEqual({ part, drawn: true })
    }
    const fenced = pasteOf('```console\n$ git status\nOn branch main\n$ git diff --stat\n```')
    expect(fenced?.command).toBe('git status\ngit diff --stat')
    const multi = renderChip({ command: fenced!.command, onRun: () => {}, onDismiss: () => {} })
    expect(multi).toContain('>git status …</span>')
    expect(multi).toContain('title="git status\ngit diff --stat"')
  })

  it('NEGATIVE (control) — without the runtime\'s background shell there is no offer; nor without a caller that can send', () => {
    const run = () => {}
    expect(pastedCommandRunner(run, {})).toBeUndefined()
    expect(pastedCommandRunner(run, undefined)).toBeUndefined()
    expect(pastedCommandRunner(undefined, WITH_SHELL)).toBeUndefined()
    // Control on the same instrument: both halves present → the runner itself.
    expect(pastedCommandRunner(run, WITH_SHELL)).toBe(run)
  })

  it('NEGATIVE — deleting the pasted text clears the offer; before the paste lands it waits (boundary)', () => {
    const snippet = pasteOf('$ bun test\n12 pass\n')!
    // The paste event comes BEFORE the text is in the draft: not seen yet, so the offer stays.
    expect(trackPastedSnippet(snippet, '', false)).toEqual({ seen: false, keep: true })
    // The text arrives (with more typed around it): seen.
    expect(trackPastedSnippet(snippet, 'try this: $ bun test\n12 pass', false)).toEqual({ seen: true, keep: true })
    // The user deletes it: withdrawn.
    expect(trackPastedSnippet(snippet, 'try this: ', true)).toEqual({ seen: true, keep: false })
  })

  it('NEGATIVE — plain text is never a command; a draft with other text around the snippet is kept when it runs', () => {
    expect(pasteOf('bun test')).toBeNull()
    expect(pasteOf('Here is what I ran:\n$ bun test')).toBeNull()
    const ran: string[] = []
    const snippet = pasteOf('$ ls -la')!
    expect(runPastedSnippet(snippet, 'please explain the output of $ ls -la', command => { ran.push(command) })).toEqual({ clearDraft: false })
    expect(ran).toEqual(['ls -la'])
  })
})

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the mounts (source)', () => {
  const zone = stripped('../ChatInputZone.tsx')
  const input = stripped('../FreeFormInput.tsx')
  const display = stripped('../../ChatDisplay.tsx')

  it('ChatInputZone offers only through the gate, mounts the chip directly above the card, and hands the paste hook down', () => {
    expect(zone).toContain('const runPasted = pastedCommandRunner(onRunCommand, composerCapabilities)')
    const chip = zone.indexOf('{pastedSnippet && runPasted && (')
    expect({ chip: chip > -1, afterQueue: chip > zone.indexOf('<QueuedMessageList'), beforeCard: chip < zone.indexOf('<InputErrorBoundary') })
      .toEqual({ chip: true, afterQueue: true, beforeCard: true })
    expect(zone).toContain('onConsoleSnippetPaste={runPasted ? handleSnippetPaste : undefined}')
    expect(zone).toContain('React.useEffect(() => { setPastedSnippet(null) }, [sessionId])')
    expect(zone).toContain('if (runPastedSnippet(pastedSnippet, draft, runPasted).clearDraft) inputProps.onInputChange?.(\'\')')
    // Native-first: the runtime's capability decides, never a providerType or runtime name in the renderer.
    expect(zone).not.toMatch(/providerType|activeRuntime|codex-runtime/)
  })

  it('FreeFormInput classifies every text paste with upstream\'s classifier and reports only a snippet', () => {
    expect(input).toContain('onTextPaste={handleTextPaste}')
    expect(input).toContain('const command = consoleSnippetCommand(text)')
    expect(input).toContain('if (command) onConsoleSnippetPaste?.({ command, text })')
  })

  it('ChatDisplay passes the transcript\'s runner (null on /btw) to the zone', () => {
    const mount = display.slice(display.indexOf('<ChatInputZone'), display.indexOf('inputProps={{', display.indexOf('<ChatInputZone')))
    expect(mount).toContain('onRunCommand={handleRunCommand ?? undefined}')
  })
})
