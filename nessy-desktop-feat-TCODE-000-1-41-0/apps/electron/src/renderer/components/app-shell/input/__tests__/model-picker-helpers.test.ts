/**
 * Pure-helper coverage for the model-picker. The helpers are tiny but they
 * back both the desktop dropdown and the compact (drawer) selector — pinning
 * the behavior here so future refactors of the picker can't quietly diverge
 * the two surfaces.
 */

import { describe, it, test, expect } from 'bun:test'
import type { LlmConnection } from '@nessy-agent/shared/config/llm-connections'
import {
  formatTokenCount,
  groupConnectionsByProvider,
  isTranslatedWireSessionModel,
  modelCatalogueMark,
  offeredThinkingLevels,
  stripPiPrefixForDisplay,
} from '../model-picker-helpers'
import { THINKING_LEVELS } from '@nessy-agent/shared/agent/thinking-levels'
import { PROVIDER_DEFAULTS } from '@nessy-agent/shared/agent/backend/composer-capabilities'

// -----------------------------------------------------------------------------
// stripPiPrefixForDisplay
// -----------------------------------------------------------------------------

describe('stripPiPrefixForDisplay', () => {
  test('strips the "pi/" prefix when present', () => {
    expect(stripPiPrefixForDisplay('pi/claude-opus-4-7')).toBe('claude-opus-4-7')
  })

  test('returns input unchanged when prefix is absent', () => {
    expect(stripPiPrefixForDisplay('claude-opus-4-7')).toBe('claude-opus-4-7')
  })

  test('does NOT strip "pi:" (legacy other-form prefix)', () => {
    // The prefix is "pi/" — the alternative "pi:" form is intentionally not
    // collapsed because some IDs use a colon for unrelated purposes.
    expect(stripPiPrefixForDisplay('pi:claude-opus-4-7')).toBe('pi:claude-opus-4-7')
  })

  test('only strips at the start, not mid-string', () => {
    expect(stripPiPrefixForDisplay('foo-pi/bar')).toBe('foo-pi/bar')
  })

  test('handles empty string', () => {
    expect(stripPiPrefixForDisplay('')).toBe('')
  })
})

// -----------------------------------------------------------------------------
// formatTokenCount
// -----------------------------------------------------------------------------

describe('formatTokenCount', () => {
  test('renders zero as "0"', () => {
    expect(formatTokenCount(0)).toBe('0')
  })

  test('renders < 1k literally', () => {
    expect(formatTokenCount(42)).toBe('42')
    expect(formatTokenCount(999)).toBe('999')
  })

  test('renders 1k..<10k with one decimal', () => {
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(1500)).toBe('1.5k')
    expect(formatTokenCount(9999)).toBe('10.0k')
  })

  test('renders ≥ 10k as whole-k', () => {
    expect(formatTokenCount(10_000)).toBe('10k')
    expect(formatTokenCount(200_000)).toBe('200k')
    expect(formatTokenCount(999_999)).toBe('1000k')
  })

  test('renders ≥ 1M with one decimal', () => {
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(12_345_678)).toBe('12.3M')
  })
})

// -----------------------------------------------------------------------------
// groupConnectionsByProvider
// -----------------------------------------------------------------------------

function conn(
  slug: string,
  providerType: LlmConnection['providerType'],
  extras: Partial<LlmConnection> = {},
): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    authType: 'api_key',
    createdAt: 0,
    ...extras,
  }
}

describe('groupConnectionsByProvider', () => {
  test('returns empty array for empty input', () => {
    expect(groupConnectionsByProvider([])).toEqual([])
  })

  test('groups anthropic providers into "Anthropic"', () => {
    const a = conn('a', 'anthropic')
    const b = conn('b', 'anthropic')
    const result = groupConnectionsByProvider([a, b])
    expect(result).toEqual([['Anthropic', [a, b]]])
  })

  test('preserves intra-group order', () => {
    const a = conn('first', 'anthropic')
    const b = conn('second', 'anthropic')
    const c = conn('third', 'anthropic')
    const result = groupConnectionsByProvider([a, b, c])
    expect(result[0][1].map(c => c.slug)).toEqual(['first', 'second', 'third'])
  })

  test('places "Anthropic" group before pi groups (display order)', () => {
    const piConn = conn('pi-1', 'pi')
    const anth = conn('anthropic-1', 'anthropic')
    const result = groupConnectionsByProvider([piConn, anth])
    expect(result.map(([k]) => k)).toEqual(['Anthropic', 'Nessy Backend'])
  })

  test('"pi_compat" with localhost baseUrl goes to "Local"', () => {
    const local = conn('ollama', 'pi_compat', { baseUrl: 'http://localhost:11434' })
    const result = groupConnectionsByProvider([local])
    expect(result).toEqual([['Local', [local]]])
  })

  test('"pi_compat" with remote baseUrl goes to "Nessy Backend"', () => {
    const remote = conn('openrouter', 'pi_compat', { baseUrl: 'https://openrouter.ai/api/v1' })
    const result = groupConnectionsByProvider([remote])
    expect(result).toEqual([['Nessy Backend', [remote]]])
  })

  test('drops empty groups from the output', () => {
    const a = conn('a', 'anthropic')
    const result = groupConnectionsByProvider([a])
    // Only "Anthropic" appears; "Local" and "Nessy Backend" are dropped.
    expect(result.length).toBe(1)
    expect(result[0][0]).toBe('Anthropic')
  })

  test('full mixed input — anthropic + local + remote pi_compat + pi', () => {
    const anth = conn('a', 'anthropic')
    const local = conn('ollama', 'pi_compat', { baseUrl: 'http://127.0.0.1:1234' })
    const remote = conn('or', 'pi_compat', { baseUrl: 'https://openrouter.ai' })
    const pi = conn('p', 'pi')
    const result = groupConnectionsByProvider([anth, local, remote, pi])
    expect(result.map(([k, conns]) => [k, conns.map(c => c.slug)])).toEqual([
      ['Anthropic', ['a']],
      ['Local', ['ollama']],
      ['Nessy Backend', ['or', 'p']],
    ])
  })

  test('"nestor-cloud-agent" goes to "Nessy Cloud" (regression: was silently dropped)', () => {
    const cloud = conn('nessy-cloud-agent', 'nestor-cloud-agent', { authType: 'none' })
    const result = groupConnectionsByProvider([cloud])
    expect(result).toEqual([['Nessy Cloud', [cloud]]])
  })

  test('"codex-runtime" goes to "Codex"', () => {
    const codex = conn('codex', 'codex-runtime')
    const result = groupConnectionsByProvider([codex])
    expect(result).toEqual([['Codex', [codex]]])
  })

  test('"claude-runtime" goes to "Claude Code", NOT "Anthropic" (T7 card)', () => {
    // Same regression class as the Nessy Cloud row above: no bucket means the
    // connection vanishes from the composer switcher entirely. And it must not
    // land in "Anthropic" — that group is the direct api.anthropic.com
    // subscription/API-key connections, a different product.
    const claude = conn('claude-gateway', 'claude-runtime', {
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    })
    const result = groupConnectionsByProvider([claude])
    expect(result).toEqual([['Claude Code', [claude]]])
  })

  test('a BYO claude-runtime endpoint still gets the bucket (grouping is by provider type)', () => {
    // `isLocalConnection` diverts pi_compat to "Local"; claude-runtime has no
    // such split, so even a loopback BYO endpoint stays in "Claude Code".
    const byo = conn('byo-claude', 'claude-runtime', { baseUrl: 'http://localhost:11434/v1' })
    expect(groupConnectionsByProvider([byo])).toEqual([['Claude Code', [byo]]])
  })

  test('both runtime cards surface side by side, after the Nessy groups', () => {
    const backend = conn('pi-api-key', 'pi_compat', { baseUrl: 'https://code-completion-nestor.tcsbank.ru' })
    const codex = conn('codex-gateway', 'codex-runtime')
    const claude = conn('claude-gateway', 'claude-runtime')
    const result = groupConnectionsByProvider([claude, codex, backend])
    expect(result.map(([k, conns]) => [k, conns.map(c => c.slug)])).toEqual([
      ['Nessy Backend', ['pi-api-key']],
      ['Codex', ['codex-gateway']],
      ['Claude Code', ['claude-gateway']],
    ])
  })

  test('pi_compat default + nestor-cloud both surface (the two-connection switcher case)', () => {
    // Mirrors the real config: a Nessy Backend default alongside the Cloud agent.
    // Both must appear so the empty-session switcher can offer either backend.
    const backend = conn('pi-api-key', 'pi_compat', { baseUrl: 'https://code-completion-nestor.tcsbank.ru' })
    const cloud = conn('nessy-cloud-agent', 'nestor-cloud-agent', { authType: 'none' })
    const result = groupConnectionsByProvider([backend, cloud])
    expect(result.map(([k, conns]) => [k, conns.map(c => c.slug)])).toEqual([
      ['Nessy Backend', ['pi-api-key']],
      ['Nessy Cloud', ['nessy-cloud-agent']],
    ])
  })
})

// -----------------------------------------------------------------------------
// isTranslatedWireSessionModel (P6.454, session half)
// -----------------------------------------------------------------------------

describe('isTranslatedWireSessionModel', () => {
  const claude = { providerType: 'claude-runtime' } as Pick<LlmConnection, 'providerType'>

  test('marks a model the router will translate, and leaves a native one unmarked', () => {
    // One connection, both wires: `buildClaudeRuntimeWireRouter` decides per
    // request from the model's own `wire`, so the answer is per MODEL.
    expect(isTranslatedWireSessionModel(claude, { wire: 'anthropic-messages' })).toBe(false)
    expect(isTranslatedWireSessionModel(claude, {})).toBe(true)
  })

  test('a bare model id on a claude-runtime connection is translated', () => {
    // `models.ts`: "Absent means chat-completions, which is every model that
    // existed before this field" — so absence is an ANSWER on a stored entry,
    // unlike the BYO form's probe, where absence means "not probed" and the
    // form deliberately marks nothing.
    expect(isTranslatedWireSessionModel(claude, 'qwen3-coder')).toBe(true)
  })

  test('no other runtime is ever marked, and a missing connection is not either', () => {
    for (const providerType of ['anthropic', 'pi', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      expect(
        isTranslatedWireSessionModel({ providerType } as Pick<LlmConnection, 'providerType'>, {}),
        providerType,
      ).toBe(false)
    }
    expect(isTranslatedWireSessionModel(null, {})).toBe(false)
    expect(isTranslatedWireSessionModel(claude, null)).toBe(false)
  })
})

/**
 * D1.162 — the provenance label PER ENTRY, and the third value is the case.
 *
 * Ledger K34 cannot move off `partial` on C3.346's one-line form alone, because
 * the page's rule is per ENTRY and a list sentence cannot answer *which of these
 * did the provider actually publish?* — a connection keeps stored models a
 * refresh no longer lists.
 *
 * `catalogueListed` has THREE values and the third is the one a mark gets wrong:
 * `undefined` means nobody ever asked (a built-in list, a connection that has
 * never refreshed, a host with no fetcher for that provider). Rendering it as
 * `false` would mark every model on a never-refreshed connection as missing from
 * a catalogue that was never read, which is the opposite of the fact.
 */
describe('D1.162 — modelCatalogueMark', () => {
  it('marks the entry a refresh did NOT carry, and nothing else', () => {
    expect(modelCatalogueMark({ catalogueListed: false })).toBe('unlisted')
    // The two silent arms, and they are silent for DIFFERENT reasons: the
    // provider published this one, and nobody asked about that one.
    expect(modelCatalogueMark({ catalogueListed: true })).toBeNull()
    expect(modelCatalogueMark({})).toBeNull()
  })

  it('is silent for a model that has no stored entry at all', () => {
    // A bare id is a model with nothing that could have been compared against a
    // catalogue; `null`/`undefined` are the empty list and the absent selection.
    expect(modelCatalogueMark('tgpt/qwen36-35b-a3b-fp8')).toBeNull()
    expect(modelCatalogueMark(null)).toBeNull()
    expect(modelCatalogueMark(undefined)).toBeNull()
  })
})

// -----------------------------------------------------------------------------
// offeredThinkingLevels (UB14.30) — the effort levels BOTH pickers offer
// -----------------------------------------------------------------------------

describe('offeredThinkingLevels (UB14.30)', () => {
  test('POSITIVE — codex offers its four, in THINKING_LEVELS order, with their display keys', () => {
    // The server's real answer for the runtime, not a hand-written list.
    const codex = offeredThinkingLevels(PROVIDER_DEFAULTS['codex-runtime'].reasoningLevels)
    expect(codex.map(level => level.id)).toEqual(['off', 'low', 'medium', 'high'])
    expect(codex[3]).toEqual({ id: 'high', nameKey: 'thinking.high', descriptionKey: 'thinking.highDesc' })
    // Order is THINKING_LEVELS', whatever order the answer arrives in.
    expect(offeredThinkingLevels(['high', 'off']).map(level => level.id)).toEqual(['off', 'high'])
    // Control: a runtime offering everything gets the whole global list back, so the filter is not a constant.
    expect(offeredThinkingLevels(PROVIDER_DEFAULTS.pi.reasoningLevels)).toEqual(THINKING_LEVELS)
  })

  test('NEGATIVE — an empty answer (nestor-cloud, an older server) offers nothing at all', () => {
    expect(offeredThinkingLevels(PROVIDER_DEFAULTS['nestor-cloud-agent'].reasoningLevels)).toEqual([])
    expect(offeredThinkingLevels([])).toEqual([])
  })
})
