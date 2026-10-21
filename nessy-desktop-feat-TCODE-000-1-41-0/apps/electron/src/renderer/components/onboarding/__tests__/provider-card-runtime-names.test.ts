/**
 * F1.571 (origin WJ-bf P-WJbf-6, 2026-09-24) — the two ChatGPT subscription
 * cards sit side by side on the provider screen, and each title names the
 * runtime it starts.
 *
 * The Pi card used to read "Codex · ChatGPT Plus": it signs in through Pi's
 * `openai-codex` provider, but the session runs on Pi, not on codex. Beside
 * F1.202's "ChatGPT (Codex)", which DOES run codex, the two read as one thing.
 * The title and its description now name Pi; the codex card keeps its words.
 *
 * WHAT EACH ARM KILLS: a card title that names no runtime or the wrong one, in
 * any locale; a component that stops reading these two keys for these two
 * cards (the locale values would then be pinned on a label nobody shows).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'

const LOCALES = { en, ru } as Record<string, Record<string, string>>

describe('F1.571 · each ChatGPT card names its runtime', () => {
  for (const [code, locale] of Object.entries(LOCALES)) {
    it(`${code}: the Pi card says Pi and not Codex; the codex card says Codex`, () => {
      const pi = locale['onboarding.providerSelect.codexChatGPT'] ?? ''
      const piDesc = locale['onboarding.providerSelect.codexChatGPTDesc'] ?? ''
      const codex = locale['onboarding.providerSelect.codexRuntimeChatGPT'] ?? ''
      expect(pi).toContain('ChatGPT')
      expect(pi).toContain('Pi')
      expect(pi).not.toContain('Codex')
      expect(piDesc).toContain('Pi')
      // CONTROL: the codex card is unchanged and still names its runtime.
      expect(codex).toBe('ChatGPT (Codex)')
    })
  }

  it('ProviderSelectStep shows those keys on those two cards', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'ProviderSelectStep.tsx'), 'utf8')
    const card = (id: string) => {
      const start = source.indexOf(`id: '${id}',`)
      expect(start).toBeGreaterThan(-1)
      return source.slice(start, source.indexOf('}', start))
    }
    expect(card('chatgpt')).toContain('t("onboarding.providerSelect.codexChatGPT")')
    expect(card('chatgpt_codex')).toContain('t("onboarding.providerSelect.codexRuntimeChatGPT")')
  })
})
