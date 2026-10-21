/**
 * E1 — the explicit utility-model slot.
 *
 * `getMiniModel` used to be a pure heuristic: an Anthropic connection gets the
 * model with `haiku` in its id, a Pi connection one with `mini` or `flash`,
 * and everything else the LAST model in the list. That last arm is why this
 * slot exists — a BYO gateway publishing `deepseek-v3` and `deepseek-r1` has
 * none of those keywords, so title generation and mini completions ran on
 * whatever happened to sort last.
 *
 * The heuristic is NOT replaced. It stays byte-for-byte as the fallback,
 * because every existing claude-runtime connection relies on its last-entry
 * arm and nothing in this lane may move that.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { getMiniModel, getSummarizationModel } from '../llm-connections'
import { setManagedModelAllowlist } from '../managed-model-allowlist'
import type { ModelDefinition } from '../models'

const model = (id: string): ModelDefinition => ({
  id,
  name: id,
  shortName: id,
  description: '',
  provider: 'pi',
  contextWindow: 128_000,
})

/** The shape this slot was added for: no haiku, no mini, no flash. */
const BYO = {
  models: [model('deepseek-v3'), model('deepseek-r1')],
  providerType: 'pi_compat' as const,
  piAuthProvider: 'openai',
}

afterEach(() => { setManagedModelAllowlist(undefined) })

describe('getMiniModel — explicit slot', () => {
  it('falls back to the heuristic when no explicit model is set', () => {
    // The last-entry arm, unchanged. This is the behaviour every connection
    // created before the slot existed keeps.
    expect(getMiniModel(BYO)).toBe('deepseek-r1')
  })

  it('prefers the explicit model over the heuristic', () => {
    expect(getMiniModel({ ...BYO, miniModel: 'deepseek-v3' })).toBe('deepseek-v3')
  })

  it('ignores a blank explicit model rather than resolving to nothing', () => {
    // A cleared free-text field arrives as whitespace, not as `undefined`;
    // honouring it literally would leave the tier with no model at all.
    expect(getMiniModel({ ...BYO, miniModel: '   ' })).toBe('deepseek-r1')
  })

  it('does not let an explicit choice escape the managed allowlist', () => {
    // The allowlist is the one filter a user selection may not step over.
    // `findSmallModel` applies it to its own candidates; an explicit value has
    // to face the same gate, and falls THROUGH to the heuristic rather than
    // being honoured or hard-refused — `model-config.md:167`, the tier "falls
    // back to the inherited or default model rather than failing the request".
    setManagedModelAllowlist(['deepseek-r1'])
    expect(getMiniModel({ ...BYO, miniModel: 'deepseek-v3' })).toBe('deepseek-r1')
  })

  it('leaves summarization on its own delegation', () => {
    // F8: the two tiers are separate SO THAT they can diverge. One knob driving
    // both is a different decision than this one, and taking it silently here
    // would be the kind of scope creep that is invisible until someone's
    // summaries change model.
    //
    // The type says so too — `getSummarizationModel`'s parameter does not
    // include `miniModel`, so this is passed as a widened value rather than an
    // object literal. That compile error is the contract, not an obstacle.
    const withExplicit: Parameters<typeof getMiniModel>[0] = { ...BYO, miniModel: 'deepseek-v3' }
    expect(getSummarizationModel(withExplicit)).toBe('deepseek-r1')
  })
})
