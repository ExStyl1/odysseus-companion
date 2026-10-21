import { describe, expect, it } from 'vitest'
import { hasDefaultExtension } from '../default-extension'

describe('hasDefaultExtension', () => {
  it('finds the default extension by its package source', () => {
    expect(
      hasDefaultExtension(
        JSON.stringify([
          {
            name: 'nessy-default-extension',
            source: '@nestor/nessy-cli-extensions',
          },
        ]),
      ),
    ).toBe(true)
  })

  it('returns false when the default extension is absent', () => {
    expect(hasDefaultExtension('[]')).toBe(false)
  })

  it('returns false for invalid CLI output', () => {
    expect(hasDefaultExtension('not json')).toBe(false)
  })
})

