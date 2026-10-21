import { describe, expect, it } from 'bun:test'
import { resolveModelForProvider } from '../backend/factory.ts'
import { getModelProvider } from '../../config/models.ts'
import type { LlmConnection } from '../../config/llm-connections.ts'

function connection(overrides: Partial<LlmConnection>): LlmConnection {
  return {
    slug: 'target',
    name: 'Target',
    providerType: 'codex-runtime',
    authType: 'bearer_token',
    createdAt: 0,
    ...overrides,
  } as LlmConnection
}

describe('resolveModelForProvider catalog guard', () => {
  // Positive control for the whole file: the cross-provider guard above the
  // catalog guard keys off MODEL_REGISTRY, and every id used here is absent
  // from it. If one of these ever gains a registry entry, the assertions below
  // would pass for the WRONG reason.
  it('operates on ids the cross-provider guard cannot see', () => {
    expect(getModelProvider('tgpt/qwen35-397b-a17b-fp8')).toBeUndefined()
    expect(getModelProvider('gpt-5.3-codex')).toBeUndefined()
    expect(getModelProvider('gpt-5.3-codex-mini')).toBeUndefined()
  })

  it('drops a model absent from a codex connection catalog', () => {
    const conn = connection({ models: ['gpt-5.3-codex'], defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', 'tgpt/qwen35-397b-a17b-fp8', conn)).toBe('gpt-5.3-codex')
  })

  it('drops a model absent from an anthropic connection catalog', () => {
    const conn = connection({
      providerType: 'claude-runtime',
      models: ['gpt-5.3-codex'],
      defaultModel: 'gpt-5.3-codex',
    })
    expect(resolveModelForProvider('anthropic', 'tgpt/qwen35-397b-a17b-fp8', conn)).toBe('gpt-5.3-codex')
  })

  it('keeps a model the catalog does list', () => {
    const conn = connection({ models: ['gpt-5.3-codex', 'gpt-5.3-codex-mini'], defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', 'gpt-5.3-codex-mini', conn)).toBe('gpt-5.3-codex-mini')
  })

  it('leaves a connection without a catalog untouched', () => {
    const conn = connection({ defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', 'some-byo-model', conn)).toBe('some-byo-model')
  })

  // Negative subject. Only the MANAGED-id half of the guard was un-scoped. The
  // DEFAULT substitution stays pi-only, so a non-Pi connection whose declared
  // default is missing from a synced catalogue keeps the user's declared value
  // rather than silently running an arbitrary first row of ~388.
  it('does not substitute an out-of-catalog DEFAULT for a non-Pi connection', () => {
    const conn = connection({ models: ['gpt-5.3-codex-mini'], defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('codex-runtime', undefined, conn)).toBe('gpt-5.3-codex')
  })

  // Positive control for that negative: the same shape on Pi still substitutes,
  // proving the assertion above measures the scope and not a dead branch.
  it('still substitutes an out-of-catalog DEFAULT for a Pi connection', () => {
    const conn = connection({ providerType: 'pi', models: ['gpt-5.3-codex-mini'], defaultModel: 'gpt-5.3-codex' })
    expect(resolveModelForProvider('pi', undefined, conn)).toBe('gpt-5.3-codex-mini')
  })
})
