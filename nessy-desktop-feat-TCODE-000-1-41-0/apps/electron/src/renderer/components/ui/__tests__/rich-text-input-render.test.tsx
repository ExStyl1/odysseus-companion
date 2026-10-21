/**
 * The composer's contentEditable div, rendered — what reaches the DOM, not what
 * the source says.
 *
 * F1.247 — `RichTextInput` pins `lineHeight: 1.25` inline (its own comment: to
 * override `text-sm`'s built-in line-height), and its only caller,
 * `FreeFormInput`, passes `style={{ maxHeight }}`. Before this row the caller's
 * `style` rode inside `restProps` and the spread after the inline style
 * REPLACED the whole object, so the shipped composer rendered with `text-sm`'s
 * line-height and the 1.25 existed only in the source. Upstream craft-agents-oss
 * v0.13.4 destructures `style` and renders `{ lineHeight: 1.25, ...style }`;
 * the positive arm below is that merge, the negative arm is the no-style
 * default the merge must not lose.
 *
 * F1.249 — upstream v0.11.3 (commit 77316cec, "Disable auto-capitalization/
 * correction that breaks IME (e.g. CJK pinyin) input (#837/#878)") added
 * `autoCapitalize="none"` and `autoCorrect="off"` to this div and nothing else.
 * Our copy had neither; the 0.11.4 adoption plan declined the fix on a grep for
 * the attribute, i.e. on the pre-fix state. A pinyin IME cannot be driven in
 * process, so the attributes are pinned on the RENDERED markup here and the IME
 * itself is a sitting ask. The negative arm pins the half D15 refuted: our own
 * JS capitaliser (`autoCapitaliseFirstCharacter`, spelled with an s) runs
 * only on COMMITTED text — `handleInput` returns while a composition is open —
 * and a committed CJK first character has no upper-case form, so the rewrite
 * `FreeFormInput.handleRichInput` calls leaves it unchanged. F1.460 (5): the arm
 * drives that rewrite itself; it used to call `toUpperCase()` on fixed strings.
 */

import * as React from 'react'
import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { autoCapitaliseFirstCharacter } from '@/lib/auto-capitalise'
import { RichTextInput } from '../rich-text-input'

function renderInput(props: Partial<React.ComponentProps<typeof RichTextInput>> = {}): string {
  return renderToStaticMarkup(
    <RichTextInput value="" onChange={() => {}} {...props} />,
  )
}

/** The opening tag of the contentEditable div (the element carrying `role="textbox"`). */
function textboxTag(html: string): string {
  const tag = html.match(/<div[^>]*role="textbox"[^>]*>/)?.[0]
  expect(tag).toBeDefined()
  return tag ?? ''
}

/** The `style` attribute of the contentEditable div. */
function textboxStyle(html: string): string | undefined {
  return textboxTag(html).match(/style="([^"]*)"/)?.[1]
}

describe('RichTextInput — F1.247 the caller style merges with the inline line-height', () => {
  it('a caller style (the composer passes maxHeight) keeps lineHeight 1.25 AND gains maxHeight', () => {
    const style = textboxStyle(renderInput({ style: { maxHeight: 240 } }))
    expect(style).toContain('line-height:1.25')
    expect(style).toContain('max-height:240px')
  })

  it('no style prop still yields lineHeight 1.25', () => {
    expect(textboxStyle(renderInput())).toBe('line-height:1.25')
  })

  // F1.460 (1) — the two arms above cannot see the merge ORDER: the mutant
  // `{ ...style, lineHeight: 1.25 }` passes both. Upstream v0.13.4's second arm:
  // a caller's own lineHeight is the caller's to set, so it must win.
  it("a caller style's own lineHeight 1.5 wins over the inline 1.25", () => {
    const style = textboxStyle(renderInput({ style: { lineHeight: 1.5 } }))
    expect(style).toBe('line-height:1.5')
  })
})

/** The `style` attribute of the rotating placeholder overlay (the element carrying `pointer-events-none`). */
function overlayStyle(html: string): string | undefined {
  const tag = html.match(/<div[^>]*pointer-events-none[^>]*>/)?.[0]
  expect(tag).toBeDefined()
  return tag?.match(/style="([^"]*)"/)?.[1]
}

describe('RichTextInput — F1.460 (2) the placeholder overlay shares the textbox line box', () => {
  // Since F1.247 the textbox's line box is 1.25 (17.5px at text-sm); the overlay
  // carried only `text-sm`'s own line-height (20px), so the empty-state caret and
  // the placeholder text sat in line boxes 2.5px apart.
  it('the empty composer overlay renders line-height 1.25, the same as the textbox', () => {
    const html = renderInput()
    expect(textboxStyle(html)).toBe('line-height:1.25')
    expect(overlayStyle(html)).toContain('line-height:1.25')
  })

  // UB14.32 — the composer now passes v0.15.0's copy line-height (`var(--lh-copy)`, 24px at 15px); an overlay
  // still pinned to 1.25 (18.75px) would sit 5px off the caret again. It follows the textbox's line box.
  it('POSITIVE (UB14.32) — a caller line-height reaches the overlay too, so the two keep one line box', () => {
    const html = renderInput({ style: { maxHeight: 240, lineHeight: 'var(--lh-copy)' } })
    expect(textboxStyle(html)).toContain('line-height:var(--lh-copy)')
    expect(overlayStyle(html)).toContain('line-height:var(--lh-copy)')
    expect(overlayStyle(html)).not.toContain('line-height:1.25')
  })

  it('negative — a non-empty composer renders no overlay at all', () => {
    expect(renderInput({ value: 'hello' })).not.toContain('pointer-events-none')
  })
})

describe('RichTextInput — F1.249 the IME attributes upstream v0.11.3 added', () => {
  // React's server renderer spells these two camelCase (`autoCapitalize="none"`)
  // where it lowercases `contenteditable`; an HTML parser lowercases every
  // attribute name either way, so the match is case-insensitive on the NAME only.
  it('the contentEditable div carries autocapitalize="none" and autocorrect="off"', () => {
    const tag = textboxTag(renderInput())
    expect(tag).toContain('contenteditable="true"')
    expect(tag).toMatch(/ autocapitalize="none"/i)
    expect(tag).toMatch(/ autocorrect="off"/i)
  })

  it('a disabled input carries both too — they are not tied to the editable state', () => {
    const tag = textboxTag(renderInput({ disabled: true }))
    expect(tag).toContain('contenteditable="false"')
    expect(tag).toMatch(/ autocapitalize="none"/i)
    expect(tag).toMatch(/ autocorrect="off"/i)
  })

  it('the JS capitaliser leaves a committed CJK first character unchanged (it runs on committed text only)', () => {
    for (const committed of ['你好', 'こんにちは', '안녕하세요']) {
      // The rewrite the composer calls returns it IDENTICAL, so the branch does not fire.
      expect(autoCapitaliseFirstCharacter(committed)).toBe(committed)
    }
    // Positive control on the same instrument: a Latin first letter IS rewritten.
    expect(autoCapitaliseFirstCharacter('pinyin')).toBe('Pinyin')
    // And the rewrite never sees an OPEN composition: handleInput returns first.
    const source = readFileSync(fileURLToPath(new URL('../rich-text-input.tsx', import.meta.url)), 'utf-8')
    const handleInput = source.slice(source.indexOf('const handleInput = React.useCallback('))
    expect(handleInput.split('\n')[1]?.trim()).toBe('if (isComposing.current) return')
    // The guard the comment above leans on, read where it lives (FreeFormInput, read-only here).
    const composer = readFileSync(
      fileURLToPath(new URL('../../app-shell/input/FreeFormInput.tsx', import.meta.url)),
      'utf-8',
    )
    expect(composer).toContain('const capitalized = autoCapitaliseFirstCharacter(nextValue)')
    expect(composer).toContain('if (capitalized !== nextValue) {')
  })
})
