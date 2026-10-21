import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {
  CONTEXT_WINDOW_SOURCE_KEYS,
  formatContextWindowSource,
  mayFallBackToTokenUsage,
} from '../ChatDisplay.usage-format'

describe('formatContextWindowSource', () => {
  it('has a translated label for every source, in every locale', () => {
    // The exhaustiveness the old `switch (…) default:` could not give: a new
    // wire member with no key rendered as "Unavailable", which reads as "the
    // window has no source" rather than "we forgot to name this one".
    for (const [source, key] of Object.entries(CONTEXT_WINDOW_SOURCE_KEYS)) {
      expect((en as Record<string, string>)[key], `en is missing ${key} for ${source}`).toBeTruthy()
      expect((ru as Record<string, string>)[key], `ru is missing ${key} for ${source}`).toBeTruthy()
    }
  })

  it('distinguishes a fabricated window from a measured one', () => {
    const t = (key: string) => key
    expect(formatContextWindowSource('fallback', t)).toBe('context.source.fallback')
    expect(formatContextWindowSource('runtime', t)).not.toBe(formatContextWindowSource('fallback', t))
  })

  it('falls back to unavailable for an absent or unknown source', () => {
    const t = (key: string) => key
    expect(formatContextWindowSource(undefined, t)).toBe('common.unavailable')
    // A snapshot from a NEWER backend carrying a source this build never heard
    // of: renders as unavailable rather than throwing.
    expect(formatContextWindowSource('invented' as never, t)).toBe('common.unavailable')
  })
})

describe('mayFallBackToTokenUsage', () => {
  it('refuses the fallback for a provider that reports fresh local usage', () => {
    // The defect this closes: before the first snapshot arrives, the renderer
    // divided `tokenUsage.inputTokens` (one turn's provider count) by
    // `tokenUsage.contextWindow` (the STATIC model registry, which holds no id
    // for any Pi or gateway model) and drew a donut from the quotient.
    expect(mayFallBackToTokenUsage({ contextUsage: { kind: 'fresh-local' } })).toBe(false)
  })

  it('keeps the fallback for providers that will never send a snapshot', () => {
    // For these it is not a stopgap, it is the only number there is.
    expect(mayFallBackToTokenUsage({ contextUsage: { kind: 'remote-reported' } })).toBe(true)
    expect(mayFallBackToTokenUsage({ contextUsage: { kind: 'unavailable' } })).toBe(true)
  })

  it('keeps the fallback when the capability is absent entirely', () => {
    // A session whose capabilities have not loaded, and an older backend that
    // sends none, must both behave exactly as they did before this gate.
    expect(mayFallBackToTokenUsage(undefined)).toBe(true)
    expect(mayFallBackToTokenUsage({})).toBe(true)
  })
})
