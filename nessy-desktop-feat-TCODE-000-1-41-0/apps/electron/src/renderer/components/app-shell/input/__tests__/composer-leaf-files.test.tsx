/**
 * UB14.22 — the composer leaf files on v0.15.1's materials, with our specifics re-applied.
 *
 * - `ImageSupportWarningBanner`: upstream's info-tint material, plus OUR optional `onEnable` (no action
 *   without it) and P6.584's quoted `refusalSentence` (`chat.imageWarning.endpointSaid`). Upstream's
 *   `onEnable` is required and it has no sentence, so a straight take would lose both.
 * - `InputErrorBoundary`: upstream's raised-card fallback, plus OUR no-Sentry `componentDidCatch`.
 * - `FreeFormInputContextBadge` / `ToolbarStatusSlot`: taken 1:1; this file pins the rebrand.
 *
 * Instrument: `renderToStaticMarkup` (no DOM), on files that import no `@nessy-agent/ui` barrel. The
 * strings come from the shipped `en.json`, so a renamed or dropped key fails here too.
 */
import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { ImageSupportWarningBanner } from '../ImageSupportWarningBanner'
import { InputErrorBoundary } from '../InputErrorBoundary'

const INPUT_DIR = join(import.meta.dir, '..')
const EN = JSON.parse(
  readFileSync(join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'), 'utf8'),
) as Record<string, string>
const KEYS = [
  'chat.imageWarning.title',
  'chat.imageWarning.action',
  'chat.imageWarning.endpointSaid',
  'chat.inputFailedTitle',
  'chat.inputFailedDescription',
  'chat.clearDraft',
  'common.retry',
  'common.reload',
]
const SENTENCE = 'Invalid Chat Message Part: Model Does Not Support Image Inputs'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map(key => [key, EN[key]])) } },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

describe('UB14.22 · ImageSupportWarningBanner — upstream material, our two optional props', () => {
  it('the shipped keys exist (a missing one would render the bare key and still "pass")', () => {
    expect(KEYS.filter(key => typeof EN[key] !== 'string')).toEqual([])
  })

  it('POSITIVE — a learned refusal quotes the endpoint\'s own sentence, on the info-tint material', () => {
    const markup = render(<ImageSupportWarningBanner modelName="qwen3-coder" onEnable={() => {}} refusalSentence={SENTENCE} />)
    expect(markup).toContain(EN['chat.imageWarning.endpointSaid']!.replace('{{sentence}}', SENTENCE))
    expect(markup).toContain('bg-info-tint')
    expect(markup).toContain('text-info')
    expect(markup).not.toContain('amber-500')
  })

  it('boundary — without a learned sentence nothing is quoted', () => {
    const markup = render(<ImageSupportWarningBanner modelName="qwen3-coder" onEnable={() => {}} />)
    expect(markup).toContain(EN['chat.imageWarning.title']!.replace('{{modelName}}', 'qwen3-coder'))
    expect(markup).not.toContain(EN['chat.imageWarning.endpointSaid']!.replace('{{sentence}}', ''))
  })

  it('NEGATIVE — without onEnable the banner is the warning alone: no action button', () => {
    const markup = render(<ImageSupportWarningBanner modelName="gpt-5.1-codex" refusalSentence={SENTENCE} />)
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain(EN['chat.imageWarning.action'])
  })

  it('control for the negative — with onEnable the action renders on upstream\'s control-height target', () => {
    const markup = render(<ImageSupportWarningBanner modelName="qwen3-coder" onEnable={() => {}} />)
    expect(markup.match(/<button/g) ?? []).toHaveLength(1)
    expect(markup).toContain(EN['chat.imageWarning.action'])
    expect(markup).toContain('min-h-control-sm')
  })
})

/** The caught state: a render error is the only way in, and SSR runs no error boundary. */
class CrashedInputErrorBoundary extends InputErrorBoundary {
  state = { hasError: true }
}

describe('UB14.22 · InputErrorBoundary — upstream fallback, our no-Sentry catch', () => {
  let errorSpy: ReturnType<typeof spyOn> | undefined
  afterEach(() => errorSpy?.mockRestore())

  it('POSITIVE — the caught state draws the raised card with the destructive ring and three actions', () => {
    const markup = render(<CrashedInputErrorBoundary resetKey="k">{null}</CrashedInputErrorBoundary>)
    expect(markup).toContain('bg-raised')
    expect(markup).toContain('ring-[color:var(--destructive-border)]')
    expect(markup).toContain('bg-destructive-tint')
    expect(markup).toContain(EN['chat.inputFailedTitle'])
    expect(markup.match(/<button/g) ?? []).toHaveLength(3)
  })

  it('control — the healthy state renders its children and no fallback', () => {
    const markup = render(<InputErrorBoundary resetKey="k"><span>composer</span></InputErrorBoundary>)
    expect(markup).toBe('<span>composer</span>')
  })

  it('NEGATIVE — a crash is logged locally with the session and stack; nothing reaches a crash reporter', () => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const boundary = new InputErrorBoundary({ resetKey: 'k', sessionId: 'session-1', children: null })
    const error = new Error('composer blew up')
    boundary.componentDidCatch(error, { componentStack: '\n    at FreeFormInput' } as React.ErrorInfo)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]).toEqual([
      '[InputErrorBoundary] Composer crashed:',
      error,
      { sessionId: 'session-1', componentStack: '\n    at FreeFormInput' },
    ])
    const source = readFileSync(join(INPUT_DIR, 'InputErrorBoundary.tsx'), 'utf8')
    expect(source).not.toMatch(/from '@sentry\//)
    // A CALL, not the word: the header names upstream's `Sentry.captureException` as what was not taken.
    expect(source).not.toMatch(/captureException\(/)
  })
})

describe('UB14.22 · the taken leaves carry the rebrand and their source header', () => {
  const FILES = ['FreeFormInputContextBadge.tsx', 'ToolbarStatusSlot.tsx', 'InputErrorBoundary.tsx', 'ImageSupportWarningBanner.tsx']

  it('every file records its v0.15.1 source and imports no @craft-agent package', () => {
    for (const file of FILES) {
      const source = readFileSync(join(INPUT_DIR, file), 'utf8')
      expect(source).toContain(`Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/${file}`)
      expect(source).not.toContain('@craft-agent')
    }
  })

  it('the status slot takes upstream\'s motion presets from our package', () => {
    const source = readFileSync(join(INPUT_DIR, 'ToolbarStatusSlot.tsx'), 'utf8')
    expect(source).toContain("import { TWEEN } from '@nessy-agent/ui/motion'")
    expect(source).toContain('transition={TWEEN.fast}')
  })
})
