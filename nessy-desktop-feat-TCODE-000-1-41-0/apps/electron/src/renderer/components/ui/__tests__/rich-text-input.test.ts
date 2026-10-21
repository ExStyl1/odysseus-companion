import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isEscapeDuringComposition, routePlainTextPaste } from '../rich-text-input'

describe('isEscapeDuringComposition', () => {
  it('returns true for Escape when local composition ref is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, true)).toBe(true)
  })

  it('returns true for Escape when nativeEvent.isComposing is true', () => {
    expect(
      isEscapeDuringComposition(
        { key: 'Escape', nativeEvent: { isComposing: true } },
        false
      )
    ).toBe(true)
  })

  it('returns true for Escape when event.isComposing is true', () => {
    expect(isEscapeDuringComposition({ key: 'Escape', isComposing: true }, false)).toBe(true)
  })

  it('returns false for Escape when no composition signal is active', () => {
    expect(isEscapeDuringComposition({ key: 'Escape' }, false)).toBe(false)
  })

  it('returns false for non-Escape keys even if composing', () => {
    expect(isEscapeDuringComposition({ key: 'Enter', isComposing: true }, true)).toBe(false)
  })
})

/**
 * UB14.21 — `RichTextInput.onTextPaste` (upstream v0.15.0): every plain-text
 * paste reaches it BEFORE it is inserted or turned into an attachment. The
 * order is driven through `routePlainTextPaste`, the paste handler's own pure
 * half (no DOM ships here); the wiring is read where it lives.
 */
describe('UB14.21 — onTextPaste sees every plain-text paste first', () => {
  const recorder = () => {
    const calls: string[] = []
    return {
      calls,
      onTextPaste: (text: string) => { calls.push(`text:${text.length}`) },
      onLongTextPaste: (text: string) => { calls.push(`long:${text.length}`) },
    }
  }

  it('positive — a plain-text paste calls onTextPaste once with the text, and is then inserted', () => {
    const seen: string[] = []
    expect(routePlainTextPaste('npm run build', { onTextPaste: text => { seen.push(text) } })).toBe('insert')
    expect(seen).toEqual(['npm run build'])
  })

  it('positive — a paste that becomes a long-text attachment still calls onTextPaste once, BEFORE the attachment', () => {
    const long = Array.from({ length: 101 }, (_, i) => `line ${i}`).join('\n')
    const r = recorder()
    expect(routePlainTextPaste(long, r)).toBe('attachment')
    expect(r.calls).toEqual([`text:${long.length}`, `long:${long.length}`])
  })

  it('boundary — 100 lines is inserted, not attached; no long-text handler means insert at any length', () => {
    const hundred = Array.from({ length: 100 }, () => 'x').join('\n')
    const r = recorder()
    expect(routePlainTextPaste(hundred, r)).toBe('insert')
    expect(r.calls).toEqual([`text:${hundred.length}`])
    const long = Array.from({ length: 150 }, () => 'x').join('\n')
    expect(routePlainTextPaste(long, { onTextPaste: () => {} })).toBe('insert')
  })

  it('negative — an image paste (empty text/plain) calls neither callback', () => {
    for (const empty of ['', undefined]) {
      const r = recorder()
      expect(routePlainTextPaste(empty, r)).toBe('ignore')
      expect(r.calls).toEqual([])
    }
  })

  it('wiring — the paste handler routes through it with onTextPaste, after the files arm, and re-binds on the prop', () => {
    const source = readFileSync(fileURLToPath(new URL('../rich-text-input.tsx', import.meta.url)), 'utf-8')
    const start = source.indexOf('const handlePasteInternal = React.useCallback(')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('// Handle focus', start))
    expect(body).toContain("if (routePlainTextPaste(text, { onTextPaste, onLongTextPaste }) !== 'insert') return")
    expect(body.indexOf('if (hasFiles && onPaste)')).toBeLessThan(body.indexOf('routePlainTextPaste('))
    expect(body).toContain('}, [onPaste, onLongTextPaste, onTextPaste])')
  })
})

describe('UB14.21 — the mention badge material and its selection tint (upstream v0.15.0)', () => {
  const source = readFileSync(fileURLToPath(new URL('../rich-text-input.tsx', import.meta.url)), 'utf-8')

  it('positive — badges sit on the raised surface at elevation 0, and a selected badge takes the selection tint in place of it', () => {
    expect(source).toContain('class="mention-badge inline-flex items-center gap-1 h-[22px] px-1.5 mx-1 rounded-sm bg-raised shadow-elev-0 text-label-sm font-medium text-foreground')
    expect(source).toContain("const getSelectionColor = () => 'var(--selection)'")
    expect(source).toContain("badge.classList.remove('bg-raised')")
    expect(source).toContain("badge.classList.add('bg-raised')")
  })

  it('negative — the accent-derived oklch tint and the old bg-background toggle are gone', () => {
    expect(source).not.toContain("getPropertyValue('--accent')")
    expect(source).not.toContain("classList.add('bg-background')")
    expect(source).not.toContain('text-muted-foreground')
  })
})
