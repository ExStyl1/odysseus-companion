/**
 * F1.431 — the FIRST IME composition in an EMPTY composer drew its marked text
 * invisible.
 *
 * Read from source, not driven (a pinyin IME cannot be driven in process —
 * `bun test` has no DOM here, see `double-escape.test.ts`): `showPlaceholder`
 * was `!safeValue`, which adds `text-transparent caret-foreground` to the
 * contentEditable div and mounts the RotatingPlaceholder overlay; `handleInput`
 * returns while `isComposing.current` is set, so `value` stays `''` until
 * `compositionend`. Every glyph of the marked text therefore rendered in the
 * transparent colour under the placeholder for the whole composition. A first
 * Latin keystroke (no composition) was always visible at once: `handleInput`
 * runs and `value` becomes non-empty — the control arm below.
 *
 * The fix keeps a composing STATE beside the ref (the ref still gates
 * `handleInput`); the placeholder decision is the exported
 * `composerShowsPlaceholder`, so it is asserted here as a function and the
 * wiring is asserted on the source. The live confirmation is a sitting ask.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RichTextInput, composerShowsPlaceholder } from '../rich-text-input'

const source = readFileSync(fileURLToPath(new URL('../rich-text-input.tsx', import.meta.url)), 'utf-8')

function callbackBody(name: string): string {
  const start = source.indexOf(`const ${name} = React.useCallback(`)
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('}, [', start))
}

describe('F1.431 — an open IME composition drops the placeholder and the transparent text', () => {
  it('positive — an empty value WITH a composition open shows no placeholder', () => {
    expect(composerShowsPlaceholder('', true)).toBe(false)
  })

  it('negative — an empty value with no composition still shows it; any committed text never does', () => {
    expect(composerShowsPlaceholder('', false)).toBe(true)
    expect(composerShowsPlaceholder('n', false)).toBe(false)
    expect(composerShowsPlaceholder('你', true)).toBe(false)
  })

  it('compositionstart turns the state on and compositionend turns it off; the ref still gates handleInput', () => {
    expect(callbackBody('handleCompositionStart')).toContain('setIsComposingText(true)')
    expect(callbackBody('handleCompositionEnd')).toContain('setIsComposingText(false)')
    expect(callbackBody('handleInput')).toContain('if (isComposing.current) return')
    expect(source).toContain('const showPlaceholder = composerShowsPlaceholder(safeValue, isComposingText)')
  })

  it('control — the rendered empty composer (no composition) is transparent with the overlay, a typed one is not', () => {
    const empty = renderToStaticMarkup(<RichTextInput value="" onChange={() => {}} />)
    expect(empty).toContain('text-transparent caret-foreground')
    const typed = renderToStaticMarkup(<RichTextInput value="n" onChange={() => {}} />)
    expect(typed).not.toContain('text-transparent')
  })
})
