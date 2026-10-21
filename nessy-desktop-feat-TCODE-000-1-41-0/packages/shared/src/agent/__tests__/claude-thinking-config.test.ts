import { describe, expect, it } from 'bun:test'
import { resolveClaudeThinkingOptions } from '../claude-agent.ts'
import { getThinkingTokens } from '../thinking-levels.ts'

describe('resolveClaudeThinkingOptions', () => {
  it('uses adaptive thinking for true Anthropic backends', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'medium',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'medium',
    })
  })

  it('uses token budgets for Haiku on true Anthropic backends', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'high',
      model: 'claude-haiku-4-5-20251001',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      maxThinkingTokens: 6_000,
    })
  })

  it('uses correct max budget for Haiku', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'max',
      model: 'claude-haiku-4-5-20251001',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      maxThinkingTokens: 8_000,
    })
  })

  it('disables thinking for Haiku when level is off', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'off',
      model: 'claude-haiku-4-5-20251001',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      maxThinkingTokens: 0,
    })
  })

  it('disables thinking entirely when level is off on adaptive backends', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'off',
      model: 'claude-sonnet-4-6',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  it('passes xhigh as effort on adaptive backends (Opus 4.7+)', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'xhigh',
      model: 'claude-opus-4-7',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'xhigh',
    })
  })

  it('uses xhigh token budget on Haiku (non-adaptive)', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'xhigh',
      model: 'claude-haiku-4-5-20251001',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      maxThinkingTokens: 7_000,
    })
  })

  // --- Mythos-class models (Fable 5): adaptive thinking always on -----------
  // These reject `thinking: { type: 'disabled' }`, so the "off"/minimize case
  // must fall back to adaptive + lowest effort instead of disabling.

  it('uses adaptive thinking + effort for Fable 5 (normal level)', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'high',
      model: 'claude-fable-5',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'high',
    })
  })

  it('never disables thinking on Fable 5 when level is off (adaptive + low instead)', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'off',
      model: 'claude-fable-5',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'low',
    })
  })

  it('never disables thinking on Fable 5 when minimizeThinking is set', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'medium',
      model: 'claude-fable-5',
      providerType: 'anthropic',
      minimizeThinking: true,
    })

    expect(result).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'low',
    })
  })

  it('still disables thinking on Opus 4.8 when level is off (unchanged for non-Mythos models)', () => {
    const result = resolveClaudeThinkingOptions({
      thinkingLevel: 'off',
      model: 'claude-opus-4-8',
      providerType: 'anthropic',
      minimizeThinking: false,
    })

    expect(result).toEqual({
      thinking: { type: 'disabled' },
    })
  })

  // F1.1214 — thinking.md's per-model table: `"disabled"` is a "400 error" on
  // Claude Opus 5.5 and Sonnet 5.5 (and every Fable/Mythos), "Thinking off" on
  // Opus 5 and Sonnet 5. Bare and Bedrock-native forms both.
  it('never disables thinking on Opus 5.5 or Sonnet 5.5 (adaptive + low instead)', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'us.anthropic.claude-opus-5-5', 'claude-fable-5-1']) {
      for (const [thinkingLevel, minimizeThinking] of [['off', false], ['high', true]] as const) {
        expect(resolveClaudeThinkingOptions({ thinkingLevel, model, providerType: 'anthropic', minimizeThinking }))
          .toEqual({ thinking: { type: 'adaptive' }, effort: 'low' })
      }
    }
  })

  it('still disables thinking on Opus 5 and Sonnet 5 when level is off (the page accepts it there)', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5']) {
      expect(resolveClaudeThinkingOptions({ thinkingLevel: 'off', model, providerType: 'anthropic', minimizeThinking: false }))
        .toEqual({ thinking: { type: 'disabled' } })
    }
  })

  // --- UB7.14 — Haiku 5.5 is adaptive-capable; pre-5.5 Haiku keeps the budget form
  // (the thinking page, curled 2026-10-14 by B2: claude-haiku-5-5 is adaptive and
  // "accepts `thinking: {type: "disabled"}` at effort `high` or below"; the budget
  // form the old heuristic sent for every haiku id is a documented 400 there).

  it('sends adaptive + effort for Haiku 5.5, not the budget form that 400s there', () => {
    for (const model of ['claude-haiku-5-5', 'us.anthropic.claude-haiku-5-5']) {
      expect(resolveClaudeThinkingOptions({ thinkingLevel: 'high', model, providerType: 'anthropic', minimizeThinking: false }))
        .toEqual({ thinking: { type: 'adaptive' }, effort: 'high' })
      // And a later Haiku major is adaptive-capable by the same reading.
      expect(resolveClaudeThinkingOptions({ thinkingLevel: 'medium', model: 'claude-haiku-6-0', providerType: 'anthropic', minimizeThinking: false }))
        .toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' })
    }
  })

  it('keeps our "off" as `disabled` on Haiku 5.5 — the docs-backed deviation from upstream\'s always-on mapping', () => {
    expect(resolveClaudeThinkingOptions({ thinkingLevel: 'off', model: 'claude-haiku-5-5', providerType: 'anthropic', minimizeThinking: false }))
      .toEqual({ thinking: { type: 'disabled' } })
  })

  it('control: pre-5.5 Haiku and an unknown bare alias keep today\'s budget shape', () => {
    expect(resolveClaudeThinkingOptions({ thinkingLevel: 'high', model: 'claude-haiku-4-5-20251001', providerType: 'anthropic', minimizeThinking: false }))
      .toEqual({ maxThinkingTokens: 6_000 })
    expect(resolveClaudeThinkingOptions({ thinkingLevel: 'off', model: 'claude-haiku-4-5-20251001', providerType: 'anthropic', minimizeThinking: false }))
      .toEqual({ maxThinkingTokens: 0 })
    // A bare `haiku` alias is not isClaude at all — the minimize branch answers
    // 0 today exactly as it did before this row (no behaviour change there).
    expect(resolveClaudeThinkingOptions({ thinkingLevel: 'high', model: 'haiku', providerType: 'anthropic', minimizeThinking: false }))
      .toEqual({ maxThinkingTokens: 0 })
  })
})

describe('getThinkingTokens', () => {
  it('returns the default (non-haiku) xhigh budget', () => {
    // Any non-haiku model id — provider routing happens elsewhere.
    expect(getThinkingTokens('xhigh', 'claude-sonnet-4-6')).toBe(26_000)
  })

  it('returns the haiku xhigh budget', () => {
    expect(getThinkingTokens('xhigh', 'claude-haiku-4-5-20251001')).toBe(7_000)
  })
})
