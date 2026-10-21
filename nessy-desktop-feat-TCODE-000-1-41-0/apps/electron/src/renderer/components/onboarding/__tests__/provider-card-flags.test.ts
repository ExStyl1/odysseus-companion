/**
 * F1.202 — the ChatGPT flag off means no ChatGPT card of EITHER runtime.
 *
 * `isProviderCardOffered` is the one gate `ProviderSelectStep` filters its
 * cards through (the settings page's "add connection" opens the same step, and
 * the dormant `APISetupStep` offers no codex method at all), so reading the
 * rule is reading every place a card can appear. The `ProviderSelectStep`
 * arm below pins that the component consults it rather than a copy.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isProviderCardOffered, type ProviderCardFlags, type ProviderChoice } from '../provider-card-flags'

const ALL_OFF: ProviderCardFlags = {
  nessy: false, nessy_cloud: false, nessy_codex: false, nessy_claude: false,
  claude: false, chatgpt: false, api_key: false, local: false,
}

describe('F1.202 · the ChatGPT (Codex) card', () => {
  it('is offered only with the ChatGPT flag AND the codex runtime in the build', () => {
    expect(isProviderCardOffered('chatgpt_codex', { ...ALL_OFF, chatgpt: true, nessy_codex: true })).toBe(true)
    // The flag off (the shipped default) — no card, whatever else is on.
    expect(isProviderCardOffered('chatgpt_codex', { ...ALL_OFF, nessy_codex: true, api_key: true, nessy: true })).toBe(false)
    // A build without codex never offers a card whose sessions cannot start.
    expect(isProviderCardOffered('chatgpt_codex', { ...ALL_OFF, chatgpt: true })).toBe(false)
  })

  it('the ChatGPT flag off withdraws BOTH ChatGPT cards; the other cards are untouched', () => {
    const shipped: ProviderCardFlags = { ...ALL_OFF, nessy: true, nessy_cloud: true, api_key: true, nessy_codex: true, nessy_claude: true }
    const offered = (['nessy', 'nessy_cloud', 'nessy_codex', 'nessy_claude', 'claude', 'chatgpt', 'chatgpt_codex', 'custom_runtime', 'local'] as ProviderChoice[])
      .filter(choice => isProviderCardOffered(choice, shipped))
    expect(offered).toEqual(['nessy', 'nessy_cloud', 'nessy_codex', 'nessy_claude', 'custom_runtime'])
    expect(isProviderCardOffered('chatgpt', { ...shipped, chatgpt: true })).toBe(true)
  })

  it('ProviderSelectStep filters through the rule and offers the card', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'ProviderSelectStep.tsx'), 'utf8')
    expect(source).toContain('isProviderCardOffered(option.id, flags)')
    expect(source).toContain("id: 'chatgpt_codex'")
  })
})
