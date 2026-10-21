/**
 * C3.171 (QK8) — the background tier says which model it was asked for and which
 * one it actually runs on.
 *
 * The rule being surfaced is written in this repo's own words at
 * `packages/shared/src/config/llm-connections.ts`, on
 * {@link PI_MINI_PREFERRED_DEFAULTS}: *"a candidate that does not resolve is
 * skipped, so an invented id silently degrades the pick rather than failing
 * loudly"*. `amazon-bedrock.md` names the price of that silence — *"a deployment
 * that doesn't pin a primary model is billed at the Opus rate"* — which is why
 * the notice is worth its size.
 *
 * The suite's shape follows the reader's own measurement: `getMiniModel`
 * degrades in exactly two ways and both are the managed allowlist, so an install
 * with no allowlist must produce NOTHING. That negative is the load-bearing one
 * — a notice that fires on an ordinary connection would be the crying-wolf
 * failure `warnIfModelIdUnrecognized`'s three narrowings exist to avoid.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  describeMiniModelDegradation,
  formatMiniModelDegradationNotice,
  getMiniModel,
} from '../llm-connections'
import { clearManagedModelPolicy, setManagedModelPolicy } from '../managed-models'
import { parseManagedPiPolicyTolerantV1, type ManagedPiPolicyV1 } from '../../agent/pi-harness/managed-policy'
import type { ModelDefinition } from '../models'

const policyOf = (value: Record<string, unknown>): ManagedPiPolicyV1 =>
  parseManagedPiPolicyTolerantV1(
    { schemaVersion: 1, disabledPermissionModes: [], ...value },
    { source: '/etc/nessy/managed-policy.json' },
  ).policy

const model = (id: string): ModelDefinition => ({
  id,
  name: id,
  shortName: id,
  description: '',
  provider: 'anthropic',
  contextWindow: 200_000,
})

const connection = (over: Record<string, unknown> = {}) => ({
  providerType: 'anthropic' as const,
  models: [model('claude-opus-4-8'), model('claude-haiku-4-5')],
  defaultModel: 'claude-opus-4-8',
  ...over,
})

afterEach(() => { clearManagedModelPolicy() })

describe('C3.171 — a mini pick that is not what the connection asked for', () => {
  it('names the id requested and the id actually used when the allowlist skips an explicit choice', () => {
    setManagedModelPolicy(policyOf({ availableModels: ['claude-opus-4-8', 'claude-haiku-4-5'] }))
    const conn = connection({ miniModel: 'claude-haiku-3-5' })
    // The premise: the explicit choice really is dropped, silently, at HEAD.
    expect(getMiniModel(conn)).toBe('claude-haiku-4-5')

    const degradation = describeMiniModelDegradation(conn)
    expect(degradation).toEqual({
      requested: 'claude-haiku-3-5',
      used: 'claude-haiku-4-5',
      reason: 'explicit-not-honoured',
    })
    const notice = formatMiniModelDegradationNotice(degradation!, 'my-connection')
    expect(notice).toContain('`claude-haiku-3-5`')
    expect(notice).toContain('`claude-haiku-4-5`')
    expect(notice).toContain('my-connection')
  })

  it('names the large model the tier fell through to when the catalogue has no small one', () => {
    // `findSmallModel`'s last line returns "the last allowed model in the list",
    // so this degrades to the FLAGSHIP rather than to `undefined` — the measured
    // shape, and the reason the test is `isSmallClassModelId` and not a null.
    const conn = connection({ models: [model('big-thinker-v2'), model('big-thinker-v1')] })
    expect(getMiniModel(conn)).toBe('big-thinker-v1')

    const degradation = describeMiniModelDegradation(conn)
    expect(degradation).toEqual({
      used: 'big-thinker-v1',
      reason: 'no-small-model',
    })
    // The billing fact, said out loud — the whole point of the row.
    expect(formatMiniModelDegradationNotice(degradation!, 'my-connection'))
      .toContain("billed at that model's rate")
  })

  it('says nothing when a small model does resolve, which is nearly every connection', () => {
    expect(describeMiniModelDegradation(connection())).toBeUndefined()
    expect(describeMiniModelDegradation(connection({ miniModel: 'claude-haiku-4-5' }))).toBeUndefined()
  })

  it('says nothing when the catalogue declares its own cheap tier', () => {
    // The live gateway's fast model matches no keyword in `isSmallClassModelId`
    // and is nonetheless exactly right, because `/cli/models` publishes the
    // alias. Measured 2026-09-11; the endpoint's own word outranks the heuristic.
    const fast: ModelDefinition = { ...model('tgpt/qwen36-35b-a3b-fp8'), shortName: 'fast' }
    const conn = connection({
      providerType: 'pi',
      models: [model('tgpt/deepseek-v4-flash-0731'), fast],
      defaultModel: 'tgpt/deepseek-v4-flash-0731',
    })
    expect(getMiniModel(conn)).toBe('tgpt/qwen36-35b-a3b-fp8')
    expect(describeMiniModelDegradation(conn)).toBeUndefined()
  })

  it('says nothing when the explicit choice IS honoured under an allowlist', () => {
    setManagedModelPolicy(policyOf({ availableModels: ['claude-opus-4-8', 'claude-haiku-4-5'] }))
    expect(describeMiniModelDegradation(connection({ miniModel: 'claude-haiku-4-5' }))).toBeUndefined()
  })

  it('says nothing about a catalogue that was never fetched', () => {
    // P6.362's own narrowing: a warning derived from an absence of data is the
    // kind that teaches people to ignore warnings.
    expect(describeMiniModelDegradation(connection({ models: [] }))).toBeUndefined()
  })
})
