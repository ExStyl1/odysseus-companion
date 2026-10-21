/**
 * UB13.10 — HotkeyKeycaps (ADDED upstream v0.15.1): a registry hotkey display string
 * ("⌘N", "⌘⇧[", "Ctrl+N", "Shift+Tab") becomes one Kbd per key. macOS strings are joined without
 * separators, so modifier glyphs peel off the front; "+"-joined strings split on "+". Renders
 * nothing for a null hotkey (the common case: the action has no binding).
 */
import { describe, expect, it } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HotkeyKeycaps, splitHotkeyDisplay } from '../hotkey-keycaps'

describe('splitHotkeyDisplay (UB13.10)', () => {
  it('positive: mac glyph strings peel modifiers without separators', () => {
    expect(splitHotkeyDisplay('⌘N')).toEqual(['⌘', 'N'])
    expect(splitHotkeyDisplay('⌘⇧[')).toEqual(['⌘', '⇧', '['])
  })

  it('positive: + joined strings split on the plus', () => {
    expect(splitHotkeyDisplay('Ctrl+N')).toEqual(['Ctrl', 'N'])
    expect(splitHotkeyDisplay('Shift+Tab')).toEqual(['Shift', 'Tab'])
  })
})

describe('HotkeyKeycaps (UB13.10)', () => {
  it('positive: renders one keycap per key', () => {
    const html = renderToStaticMarkup(<HotkeyKeycaps hotkey="⌘N" />)
    expect(html).toContain('⌘')
    expect(html).toContain('N')
    expect(html).toContain('keycap')
  })

  it('negative: a null or empty hotkey renders nothing', () => {
    expect(renderToStaticMarkup(<HotkeyKeycaps hotkey={null} />)).toBe('')
    expect(renderToStaticMarkup(<HotkeyKeycaps hotkey={undefined} />)).toBe('')
    expect(renderToStaticMarkup(<HotkeyKeycaps hotkey="" />)).toBe('')
  })
})
