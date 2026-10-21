import { describe, expect, it } from 'bun:test'
import { DEFAULT_THINKING_LEVEL, getModelDefaultThinkingLevel } from '../../agent/thinking-levels.ts'
import { resolveModelGenerationDefaults, type LlmConnection } from '../llm-connections.ts'
import {
  NESSY_GATEWAY_DECLARED_TRI_STATES,
  NESSY_GATEWAY_MODEL_IDS,
  NESSY_GATEWAY_MODELS,
} from '../nessy-gateway-models.ts'
import { StoredConfigSchema } from '../validators.ts'

/**
 * DA1.22 — the ONE reader of the generation config the gateway catalogue
 * publishes, and the proof that a PER-MODEL field needs no envelope change.
 *
 * The strict-envelope rule (AGENTS.md, wave-9 rule 19; DA2.12's four sites) is
 * about a CONNECTION-level key: the type, `StoredConfigSchema`, the
 * `updateLlmConnection` merge allowlist and the writer. A per-model key is a
 * different question, and the answer is measured rather than assumed here —
 * `models` is ONE field in both the schema and the allowlist, its element
 * schema is `z.object({ id }).passthrough()`, and the merge carries the array
 * wholesale. The schema half is pinned below; the merge half is pinned by
 * `storage-update-llm-connection.test.ts` (the DA1.22 case), which runs the real
 * load → merge → save round trip in a subprocess.
 */

const GATEWAY: LlmConnection = {
  slug: 'nessy-gateway',
  name: 'Nessy Gateway',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
  createdAt: 1,
}

function withModels(models: LlmConnection['models']): LlmConnection {
  return { ...GATEWAY, models }
}

describe('resolveModelGenerationDefaults (DA1.22)', () => {
  it('returns the catalogue effort and sampling params the fetcher wrote', () => {
    const conn = withModels([
      { id: 'coder', reasoningEffort: 'low', samplingParams: { temperature: 1, top_p: 0.95 } } as never,
      { id: 'fast', samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 } } as never,
    ])
    expect(resolveModelGenerationDefaults(conn, 'coder')).toEqual({
      reasoningEffort: 'low',
      samplingParams: { temperature: 1, top_p: 0.95 },
    })
    // The `fast` row publishes no reasoning block, so only one half comes back —
    // and `top_k` survives, which is the key an allowlisted reader would drop.
    expect(resolveModelGenerationDefaults(conn, 'fast')).toEqual({
      samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 },
    })
  })

  /**
   * The NEGATIVE arm, and it is the load-bearing one: every caller passes the
   * result straight into an optional adapter option, so `undefined` is what
   * makes a pre-DA1.22 connection take exactly the path it took before. An empty
   * object here would read downstream as "the catalogue recommended something".
   */
  it('is undefined for every shape that is not a recommendation', () => {
    expect(resolveModelGenerationDefaults(withModels([{ id: 'plain' } as never]), 'plain')).toBeUndefined()
    expect(resolveModelGenerationDefaults(withModels(['bare-string']), 'bare-string')).toBeUndefined()
    expect(resolveModelGenerationDefaults(withModels([{ id: 'other' } as never]), 'missing')).toBeUndefined()
    expect(resolveModelGenerationDefaults(GATEWAY, 'coder')).toBeUndefined()
    expect(resolveModelGenerationDefaults(null, 'coder')).toBeUndefined()
    expect(resolveModelGenerationDefaults(withModels([{ id: 'coder' } as never]), undefined)).toBeUndefined()
    // Empty / wrong-typed values are not recommendations either.
    expect(resolveModelGenerationDefaults(
      withModels([{ id: 'coder', reasoningEffort: '', samplingParams: {} } as never]),
      'coder',
    )).toBeUndefined()
    expect(resolveModelGenerationDefaults(
      withModels([{ id: 'coder', samplingParams: [1, 2] } as never]),
      'coder',
    )).toBeUndefined()
  })

  it('the stored-config schema carries both per-model keys through untouched', () => {
    const parsed = StoredConfigSchema.parse({
      storageLayoutVersion: 2,
      workspaceRefs: [],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      llmConnections: [{
        ...GATEWAY,
        models: [{ id: 'coder', reasoningEffort: 'low', samplingParams: { temperature: 1, top_k: 20 } }],
      }],
    })
    const model = (parsed.llmConnections?.[0]?.models?.[0] ?? {}) as Record<string, unknown>
    expect(model.reasoningEffort).toBe('low')
    expect(model.samplingParams).toEqual({ temperature: 1, top_k: 20 })
  })
})

/**
 * D1.322 — the flip D1.116 refused, taken, with the reading that unblocked it.
 *
 * D1.116's refusal was right for its own build and is now superseded rather than
 * reversed: it rested on a gateway session falling through to
 * `DEFAULT_THINKING_LEVEL` because a gateway id is in no `MODEL_DEFAULT_EFFORT`
 * row, so a bare flip would have sent `medium` where the owner accepted `low` at
 * DA1.22. `ab7a45128` added `publishedModelThinkingLevel` and the
 * `SessionManager` tier that reads it, and D1.322 seeds the catalogue's own
 * `low` on the flipped row so the pre-refresh window cannot send `medium`
 * either. Both halves are asserted below.
 *
 * The reading that made the flip possible at all is RS-57 (packaged 1.40.0,
 * 2026-09-18): the catalogue publishes a reasoning block for `coder` and none
 * for `fast`, with `samplingParams` on BOTH rows as the control that the second
 * absence is a silence rather than a missing reader. Sitting 4 could not make
 * that distinction on the 1.39.0 artefact, which predates DA1.22's reader — and
 * scoring its empty catalogue would have produced a confident false finding.
 *
 * Every case here is written to FAIL the day one of those facts moves — a
 * gateway entry added to the default-effort table, a default level that happens
 * to equal the catalogue's recommendation, or a second row starting to publish
 * a reasoning block.
 */
describe('D1.322 · the seed carries the catalogue reading RS-57 took, per row', () => {
  it('flips ONLY the row the catalogue publishes a reasoning block for', () => {
    // RS-57, on the packaged 1.40.0, read off `config.json` — the file the
    // refresh itself writes — with the app's live record agreeing:
    // `coder` → `reasoningEffort: 'low'`, `fast` → none, and BOTH rows carrying
    // `samplingParams`, which is the control that `fast`'s absence is the
    // catalogue being silent rather than the reader being missing.
    const [coder, fast] = NESSY_GATEWAY_MODELS
    expect(coder!.shortName).toBe('coder')
    expect(fast!.shortName).toBe('fast')
    expect(coder!.supportsThinking).toBe(true)
    expect(fast!.supportsThinking).toBe(false)
  })

  it('seeds the catalogue\'s own effort beside the flip, so the pre-refresh window cannot send `medium`', () => {
    // The pair D1.116 demanded, and the half `ab7a45128` could not supply on its
    // own: `publishedModelThinkingLevel` reads `connection.models[].reasoningEffort`,
    // which the FETCHER writes — so between seeding a card and its first
    // successful refresh there is nothing to read, and the ladder would fall to
    // `DEFAULT_THINKING_LEVEL`. The owner accepted `low` at DA1.22; nobody has
    // accepted `medium`, and the two assertions below are what makes the
    // difference load-bearing rather than cosmetic.
    const [coder, fast] = NESSY_GATEWAY_MODELS
    expect(coder!.reasoningEffort).toBe('low')
    expect(fast!.reasoningEffort).toBeUndefined()
    expect(DEFAULT_THINKING_LEVEL).not.toBe('low')
    expect(DEFAULT_THINKING_LEVEL).toBe('medium')
  })

  it('still leaves both gateway ids out of the documented default table', () => {
    // Unchanged by the flip, and asserted because the seed above is the ONLY
    // thing now standing between a gateway session and `DEFAULT_THINKING_LEVEL`.
    for (const id of NESSY_GATEWAY_MODEL_IDS) {
      expect(getModelDefaultThinkingLevel(id)).toBeUndefined()
    }
  })

  it('CAN answer for a model the page documents — the control for the case above', () => {
    // The negative control: `undefined` above is a real absence and not a
    // function that never answers.
    expect(getModelDefaultThinkingLevel('claude-opus-4-7')).toBe('xhigh')
    expect(getModelDefaultThinkingLevel('claude-sonnet-4-6')).toBe('high')
  })

  it('drops the disagreeing field out of the derived map, by that map\'s own rule', () => {
    // The cost the row priced and took. `supportsImages` is the control: the
    // rows still agree on it, so it stays — without which "the map is empty"
    // and "the map dropped one field" would read the same.
    expect('supportsThinking' in NESSY_GATEWAY_DECLARED_TRI_STATES).toBe(false)
    expect(NESSY_GATEWAY_DECLARED_TRI_STATES.supportsImages).toBe(false)
  })
})
