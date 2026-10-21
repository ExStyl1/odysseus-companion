import { describe, expect, it } from 'bun:test'

import { assertMethodAllowed, FORBIDDEN_METHODS } from './connect.ts'
import { KEY_MODE_KEYDOWN_TEXT, keyEventsForChar, keyEventsForNamedKey, MOD } from './keys.ts'

describe('keyEventsForChar', () => {
  it('produces rawKeyDown + char + keyUp, with text only on the char event', () => {
    const events = keyEventsForChar('a')
    expect(events.map(e => e.type)).toEqual(['rawKeyDown', 'char', 'keyUp'])
    expect(events[0]).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(events[0]!.text).toBeUndefined()
    expect(events[1]).toMatchObject({ type: 'char', text: 'a', unmodifiedText: 'a' })
    expect(events[2]).toMatchObject({ type: 'keyUp', code: 'KeyA' })
  })

  it('types the slash that opens the palette as a real Slash key', () => {
    const [down, char] = keyEventsForChar('/')
    expect(down).toMatchObject({ type: 'rawKeyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 })
    expect(char).toMatchObject({ type: 'char', text: '/' })
  })

  it('marks shift for uppercase letters and shifted punctuation', () => {
    expect(keyEventsForChar('A')[0]).toMatchObject({ code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MOD.shift })
    expect(keyEventsForChar('?')[0]).toMatchObject({ code: 'Slash', modifiers: MOD.shift })
    expect(keyEventsForChar('!')[0]).toMatchObject({ code: 'Digit1', modifiers: MOD.shift })
  })

  it('still carries the text for a character with no US physical key', () => {
    const events = keyEventsForChar('ф')
    expect(events.map(e => e.type)).toEqual(['rawKeyDown', 'char', 'keyUp'])
    expect(events[1]).toMatchObject({ text: 'ф' })
    expect(events[0]!.code).toBeUndefined()
  })

  it('never emits a char event alongside a text-carrying keyDown (that types twice)', () => {
    const fallback = keyEventsForChar('a', KEY_MODE_KEYDOWN_TEXT)
    expect(fallback.map(e => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(fallback[0]).toMatchObject({ text: 'a' })
    expect(fallback.some(e => e.type === 'char')).toBe(false)
  })

  it('refuses anything that is not a single character', () => {
    expect(() => keyEventsForChar('ab')).toThrow(/one character/)
    expect(() => keyEventsForChar('')).toThrow(/one character/)
  })
})

describe('keyEventsForNamedKey', () => {
  it('sends Enter with NO char event — preventDefault cannot suppress a separate one', () => {
    const events = keyEventsForNamedKey('Enter')
    expect(events.map(e => e.type)).toEqual(['rawKeyDown', 'keyUp'])
    expect(events[0]).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    expect(events.some(e => e.text !== undefined)).toBe(false)
  })

  it('sends Tab with no char either, so a selection cannot leave a stray tab behind', () => {
    expect(keyEventsForNamedKey('Tab').map(e => e.type)).toEqual(['rawKeyDown', 'keyUp'])
  })

  it('gives ArrowDown no char event — it inserts nothing', () => {
    const events = keyEventsForNamedKey('ArrowDown')
    expect(events.map(e => e.type)).toEqual(['rawKeyDown', 'keyUp'])
    expect(events[0]).toMatchObject({ key: 'ArrowDown', windowsVirtualKeyCode: 40 })
  })

  it('rejects an unknown key by name', () => {
    expect(() => keyEventsForNamedKey('AnyKey')).toThrow(/unknown named key/)
  })
})

describe('forbidden methods', () => {
  it('bans Input.insertText, the false-pass trap, at the transport', () => {
    expect(Object.keys(FORBIDDEN_METHODS)).toContain('Input.insertText')
    expect(() => assertMethodAllowed('Input.insertText')).toThrow(/cdp-forbidden-method/)
  })

  it('lets ordinary input methods through', () => {
    expect(() => assertMethodAllowed('Input.dispatchKeyEvent')).not.toThrow()
    expect(() => assertMethodAllowed('Runtime.evaluate')).not.toThrow()
  })
})
