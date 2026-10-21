import { describe, expect, it } from 'bun:test'
import { resolveGuardianJudgeModel } from '../guardian-judge-model.ts'

const CATALOG = ['tgpt/qwen35-397b-a17b-fp8', 'tgpt/fast', 'anthropic/claude-opus-5']
const allowAll = () => true

const base = {
  connectionSlug: 'pi-api-key-3',
  catalog: CATALOG,
  isModelAllowed: allowAll,
}

describe('resolveGuardianJudgeModel', () => {
  it('prefers THIS connection\'s own entry', () => {
    expect(resolveGuardianJudgeModel({
      ...base,
      perConnection: { 'pi-api-key-3': 'anthropic/claude-opus-5' },
      legacyGlobalId: 'tgpt/qwen35-397b-a17b-fp8',
    })).toEqual({ modelId: 'anthropic/claude-opus-5', via: 'connection-preference' })
  })

  it('ignores another connection\'s entry — that is the whole point of the map', () => {
    // One global id 403s wherever the key is not entitled; a per-connection map
    // that leaked across connections would reintroduce exactly that.
    const resolved = resolveGuardianJudgeModel({
      ...base,
      perConnection: { 'some-other-connection': 'anthropic/claude-opus-5' },
    })
    expect(resolved.via).not.toBe('connection-preference')
    expect(resolved.modelId).not.toBe('anthropic/claude-opus-5')
  })

  it('falls THROUGH a stale entry rather than erroring', () => {
    // Model dropped from the catalog since it was chosen. A broken preference
    // must not disable the deny-net it configures.
    expect(resolveGuardianJudgeModel({
      ...base,
      perConnection: { 'pi-api-key-3': 'tgpt/model-that-was-removed' },
    })).toEqual({ modelId: 'tgpt/fast', via: 'fast-alias' })
  })

  it('vetoes a forbidden model and keeps the judge running', () => {
    // A model restriction must not become a SAFETY reduction: the fallback
    // keeps the net and drops only the model.
    expect(resolveGuardianJudgeModel({
      ...base,
      perConnection: { 'pi-api-key-3': 'anthropic/claude-opus-5' },
      isModelAllowed: (id) => id !== 'anthropic/claude-opus-5',
    })).toEqual({ modelId: 'tgpt/fast', via: 'fast-alias' })
  })

  it('uses the legacy global only where it is valid on THIS connection', () => {
    expect(resolveGuardianJudgeModel({
      ...base,
      legacyGlobalId: 'anthropic/claude-opus-5',
    })).toEqual({ modelId: 'anthropic/claude-opus-5', via: 'legacy-global' })

    // The same legacy id on a connection that does not offer it: no migration,
    // no error — it simply stops applying where it never worked.
    expect(resolveGuardianJudgeModel({
      ...base,
      catalog: ['tgpt/qwen35-397b-a17b-fp8'],
      legacyGlobalId: 'anthropic/claude-opus-5',
    })).toEqual({ via: 'default' })
  })

  it('finds the gateway fast alias, plain or namespaced', () => {
    expect(resolveGuardianJudgeModel({ ...base, catalog: ['fast', 'x'] }).modelId).toBe('fast')
    expect(resolveGuardianJudgeModel({ ...base, catalog: ['vendor/fast'] }).modelId).toBe('vendor/fast')
    // NOT a substring match: `breakfast` is not the alias.
    expect(resolveGuardianJudgeModel({ ...base, catalog: ['tgpt/breakfast'] }).via).toBe('default')
  })

  it('lets a single-model connection work with no choice at all', () => {
    // The owner's «если модель вовсе одна — она и будет работать», implemented
    // by NOT special-casing it: nothing matches, the caller's default is the
    // session model, which on a one-model connection is that model.
    expect(resolveGuardianJudgeModel({
      ...base,
      catalog: ['tgpt/only-one'],
    })).toEqual({ via: 'default' })
  })

  it('handles a session with no connection', () => {
    expect(resolveGuardianJudgeModel({
      catalog: CATALOG,
      isModelAllowed: allowAll,
      perConnection: { 'pi-api-key-3': 'anthropic/claude-opus-5' },
    }).via).toBe('fast-alias')
  })

  it('treats a blank entry as no preference', () => {
    expect(resolveGuardianJudgeModel({
      ...base,
      catalog: ['tgpt/qwen35-397b-a17b-fp8'],
      perConnection: { 'pi-api-key-3': '   ' },
    })).toEqual({ via: 'default' })
  })
})
