import { describe, it, expect } from 'bun:test'
import '../../../tests/setup/register-pi-model-resolver.ts'
import {
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  getMiniModel,
  preferredModelRank,
  isCompatProvider,
  isAnthropicProvider,
  isPiProvider,
  toBedrockNativeId,
  fromBedrockNativeId,
  deriveBedrockRegionPrefix,
  setModelSupportsImages,
  resolveGatewayFastModelId,
  isSmallClassModelId,
  PI_MINI_PREFERRED_DEFAULTS,
  PI_PREFERRED_DEFAULTS,
} from '../llm-connections'
import { ANTHROPIC_MODELS, getModelDisplayName, getModelContextWindow, getModelShortName, isClaudeModel, normalizeDeprecatedModelId } from '../models'
import { BEDROCK_REGION_PREFIXES } from '../bedrock-model-ids'

// ============================================================
// getDefaultModelsForConnection
// ============================================================

describe('getDefaultModelsForConnection', () => {
  it('anthropic returns ANTHROPIC_MODELS (ModelDefinition[])', () => {
    const models = getDefaultModelsForConnection('anthropic')
    expect(models).toEqual(ANTHROPIC_MODELS)
    expect(models.length).toBeGreaterThan(0)
    // Verify they are ModelDefinition objects, not strings
    const first = models[0]!
    expect(typeof first).toBe('object')
    expect(typeof (first as any).id).toBe('string')
  })

  it('pi with piAuthProvider returns filtered models without deprecated Opus 4.6', () => {
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    expect(models.length).toBeGreaterThan(0)
    const ids = models.map(m => typeof m === 'string' ? m : m.id)
    expect(ids).not.toContain('pi/claude-opus-4-6')
    // All should have pi/ prefix in their id
    for (const id of ids) {
      expect(id.startsWith('pi/')).toBe(true)
    }
  })

  it('pi without piAuthProvider returns all Pi models', () => {
    const models = getDefaultModelsForConnection('pi')
    expect(models.length).toBeGreaterThan(0)
  })

})

// ============================================================
// getDefaultModelForConnection
// ============================================================

describe('getDefaultModelForConnection', () => {
  it('returns first model ID for anthropic', () => {
    const modelId = getDefaultModelForConnection('anthropic')
    expect(typeof modelId).toBe('string')
    expect(modelId.length).toBeGreaterThan(0)
    // Should match the first ANTHROPIC_MODELS entry
    expect(modelId).toBe(ANTHROPIC_MODELS[0]!.id)
  })

  // Regression: Pi 'anthropic' default must be present in its own model list
  it('regression: Pi anthropic default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'anthropic')
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi openai default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'openai')
    const models = getDefaultModelsForConnection('pi', 'openai')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi deepseek default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'deepseek')
    const models = getDefaultModelsForConnection('pi', 'deepseek')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('returns empty string for pi_compat (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('pi_compat')
    expect(defaultModel).toBe('')
  })
})

// ============================================================
// Provider type guards
// ============================================================

describe('isCompatProvider', () => {
  it('returns true for pi_compat', () => {
    expect(isCompatProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isCompatProvider('anthropic')).toBe(false)
  })

  it('returns false for pi', () => {
    expect(isCompatProvider('pi')).toBe(false)
  })
})

describe('isAnthropicProvider', () => {
  it('returns true for anthropic', () => {
    expect(isAnthropicProvider('anthropic')).toBe(true)
  })

  it('returns false for pi', () => {
    expect(isAnthropicProvider('pi')).toBe(false)
  })
})

describe('isPiProvider', () => {
  it('returns true for pi', () => {
    expect(isPiProvider('pi')).toBe(true)
  })

  it('returns true for pi_compat', () => {
    expect(isPiProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isPiProvider('anthropic')).toBe(false)
  })
})

// ============================================================
// Bedrock model ID mapping
// ============================================================

describe('toBedrockNativeId', () => {
  it('maps bare Anthropic IDs to US inference profile IDs', () => {
    expect(toBedrockNativeId('claude-opus-4-8')).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId('claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
    expect(toBedrockNativeId('claude-haiku-4-5-20251001')).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
  })

  it('UB7.14 — maps Haiku 5.5 forward and reverse like its 5-5 siblings', () => {
    expect(toBedrockNativeId('claude-haiku-5-5')).toBe('us.anthropic.claude-haiku-5-5')
    expect(fromBedrockNativeId('us.anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(fromBedrockNativeId('global.anthropic.claude-haiku-5-5')).toBe('claude-haiku-5-5')
  })

  it('keeps Opus 4.7 mapped and selectable', () => {
    expect(toBedrockNativeId('claude-opus-4-7')).toBe('us.anthropic.claude-opus-4-7')
    expect(fromBedrockNativeId('us.anthropic.claude-opus-4-7')).toBe('claude-opus-4-7')
  })

  // Upstream contract, code.claude.com/docs/en/amazon-bedrock.md (fetched
  // 2026-08-24): "Primary model | Opus 5, for example
  // `us.anthropic.claude-opus-5` in a `us-*` region".
  it('maps Opus 5 forward and reverse across regions and base IDs', () => {
    expect(toBedrockNativeId('claude-opus-5')).toBe('us.anthropic.claude-opus-5')
    expect(toBedrockNativeId('claude-opus-5', 'eu')).toBe('eu.anthropic.claude-opus-5')
    expect(toBedrockNativeId('anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5')
    expect(fromBedrockNativeId('us.anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(fromBedrockNativeId('eu.anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(fromBedrockNativeId('global.anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(fromBedrockNativeId('anthropic.claude-opus-5')).toBe('claude-opus-5')
  })

  it('maps Sonnet 5 forward and reverse across regions and base IDs', () => {
    expect(toBedrockNativeId('claude-sonnet-5')).toBe('us.anthropic.claude-sonnet-5')
    expect(toBedrockNativeId('claude-sonnet-5', 'eu')).toBe('eu.anthropic.claude-sonnet-5')
    expect(toBedrockNativeId('anthropic.claude-sonnet-5')).toBe('us.anthropic.claude-sonnet-5')
    expect(fromBedrockNativeId('us.anthropic.claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(fromBedrockNativeId('eu.anthropic.claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(fromBedrockNativeId('global.anthropic.claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('normalizes deprecated Opus IDs to Opus 4.8 before mapping', () => {
    expect(toBedrockNativeId('claude-opus-4-6')).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId('anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId('eu.anthropic.claude-opus-4-6-v1')).toBe('eu.anthropic.claude-opus-4-8')
  })

  it('maps base Bedrock IDs to US inference profile IDs', () => {
    expect(toBedrockNativeId('anthropic.claude-opus-4-8')).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId('anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('passes through already US-prefixed IDs', () => {
    expect(toBedrockNativeId('us.anthropic.claude-opus-4-8')).toBe('us.anthropic.claude-opus-4-8')
  })

  it('passes through unknown IDs', () => {
    expect(toBedrockNativeId('some-custom-model')).toBe('some-custom-model')
    expect(toBedrockNativeId('gpt-5')).toBe('gpt-5')
  })

  it('maps to EU inference profiles when regionPrefix is eu', () => {
    expect(toBedrockNativeId('claude-opus-4-8', 'eu')).toBe('eu.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId('claude-sonnet-4-6', 'eu')).toBe('eu.anthropic.claude-sonnet-4-6')
  })

  it('defaults to US when regionPrefix is omitted or us', () => {
    expect(toBedrockNativeId('claude-opus-4-8')).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId('claude-opus-4-8', 'us')).toBe('us.anthropic.claude-opus-4-8')
  })

  it('passes through unknown IDs regardless of regionPrefix', () => {
    expect(toBedrockNativeId('some-custom-model', 'eu')).toBe('some-custom-model')
  })
})

// P2.95c — THE UPSTREAM TABLE, ROW BY ROW.
//
// This function used to have two branches: `eu-` → `eu`, everything else → `us`.
// So an `ap-*`, `ca-*`, `sa-*` or `me-*` user was handed a US cross-region
// profile id for a geography they are not in, and a GovCloud user was handed the
// one prefix that cannot route inside the GovCloud partition.
//
// `code.claude.com/docs/en/amazon-bedrock.md` § "Cross-region inference profile
// prefixes" (fetched 2026-08-25): "This table shows the prefix Claude Code
// prefers for each resolved AWS region:" — `us-gov-*` (AWS GovCloud) →
// `us-gov.`, `us-*` → `us.`, `eu-*` → `eu.`, `ap-*` → `apac.`, "All other
// regions" → `global.`. Each row below is one of those rows.
describe('deriveBedrockRegionPrefix', () => {
  it('follows the upstream region → prefix table, row by row', () => {
    const rows: Array<[string | undefined, string]> = [
      // `us-gov-` is tested first upstream and must be tested first here: it
      // also starts with `us-`, so a table in the wrong order answers `us`.
      ['us-gov-west-1', 'us-gov'],
      ['us-gov-east-1', 'us-gov'],
      ['us-east-1', 'us'],
      ['us-west-2', 'us'],
      ['eu-west-1', 'eu'],
      ['eu-central-1', 'eu'],
      ['ap-southeast-1', 'apac'],
      ['ap-northeast-1', 'apac'],
      // "All other regions".
      ['ca-central-1', 'global'],
      ['sa-east-1', 'global'],
      ['me-south-1', 'global'],
      ['af-south-1', 'global'],
    ]
    for (const [region, prefix] of rows) {
      expect(deriveBedrockRegionPrefix(region), String(region)).toBe(prefix)
    }
  })

  it('answers us when no region is known at all', () => {
    // NOT the table's `global.` catch-all: an absent region means the AWS SDK
    // will resolve one of its own, and every pinning example on the upstream
    // page spells its ids `us.`. The catch-all row is for a region we KNOW and
    // cannot classify.
    expect(deriveBedrockRegionPrefix(undefined)).toBe('us')
    expect(deriveBedrockRegionPrefix('')).toBe('us')
    expect(deriveBedrockRegionPrefix('   ')).toBe('us')
  })

  it('is case-insensitive, because a region string comes from user input', () => {
    expect(deriveBedrockRegionPrefix('EU-WEST-1')).toBe('eu')
    expect(deriveBedrockRegionPrefix('AP-SOUTHEAST-2')).toBe('apac')
  })
})

describe('Bedrock preferred defaults ordering', () => {
  it('sorts preferred models first for amazon-bedrock', () => {
    const models = getDefaultModelsForConnection('pi', 'amazon-bedrock')
    if (models.length === 0) return // Pi resolver not registered in test env
    const firstId = typeof models[0] === 'string' ? models[0] : (models[0] as any).id
    // The first model must reverse-map onto the HEAD of the preferred list — a
    // version regex let a deprecated 4.5 profile id pass as "preferred".
    const bare = firstId.startsWith('pi/') ? firstId.slice(3) : firstId
    expect(fromBedrockNativeId(bare)).toBe(PI_PREFERRED_DEFAULTS['amazon-bedrock']![0]!)
    expect(fromBedrockNativeId(bare)).toBe('claude-opus-5')
  })
})

describe('fromBedrockNativeId', () => {
  it('maps US inference profile IDs back to bare Anthropic', () => {
    expect(fromBedrockNativeId('us.anthropic.claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(fromBedrockNativeId('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(fromBedrockNativeId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5-20251001')
  })

  it('maps EU/Global inference profile IDs back to bare', () => {
    expect(fromBedrockNativeId('eu.anthropic.claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(fromBedrockNativeId('global.anthropic.claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('maps base Bedrock IDs back to bare', () => {
    expect(fromBedrockNativeId('anthropic.claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('passes through bare IDs', () => {
    expect(fromBedrockNativeId('claude-opus-4-8')).toBe('claude-opus-4-8')
  })

  it('normalizes deprecated Opus native IDs back to Opus 4.8', () => {
    expect(fromBedrockNativeId('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-8')
  })
})

// P2.95b — `normalizeBedrockModelId` is DELETED, and this is the test that
// replaces its describe block. It had zero production call sites (the only place
// that needs the behaviour, the Pi+Bedrock arm of `SETUP_LLM_CONNECTION`, spells
// the `pi/`-strip and the mapping inline), so it was a second implementation of
// the mapping this row exists to de-duplicate. The two steps it composed are
// still covered: the strip is the caller's, the mapping is `toBedrockNativeId`.
describe('the deleted pi/-stripping wrapper leaves no gap', () => {
  it('is exactly a pi/ strip composed with toBedrockNativeId', () => {
    const stripPi = (id: string) => (id.startsWith('pi/') ? id.slice(3) : id)
    expect(toBedrockNativeId(stripPi('pi/claude-opus-4-8'))).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId(stripPi('pi/claude-opus-4-6'))).toBe('us.anthropic.claude-opus-4-8')
    expect(toBedrockNativeId(stripPi('pi/claude-opus-4-8'), 'eu')).toBe('eu.anthropic.claude-opus-4-8')
  })

  it('is gone from the module surface', async () => {
    const surface = await import('../llm-connections')
    expect('normalizeBedrockModelId' in surface).toBe(false)
  })
})

// ============================================================
// Bedrock-aware display and lookup
// ============================================================

describe('Bedrock-native model display', () => {
  it('getModelDisplayName resolves US inference profile IDs', () => {
    expect(getModelDisplayName('us.anthropic.claude-opus-4-8')).toBe('Opus 4.8')
    expect(getModelDisplayName('us.anthropic.claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(getModelDisplayName('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5')
  })

  it('getModelDisplayName resolves EU/base Bedrock IDs', () => {
    expect(getModelDisplayName('eu.anthropic.claude-opus-4-8')).toBe('Opus 4.8')
    expect(getModelDisplayName('anthropic.claude-opus-4-8')).toBe('Opus 4.8')
  })

  it('getModelShortName resolves Bedrock IDs', () => {
    expect(getModelShortName('us.anthropic.claude-opus-4-8')).toBe('Opus')
    expect(getModelShortName('us.anthropic.claude-sonnet-4-6')).toBe('Sonnet')
  })

  it('getModelContextWindow resolves Bedrock IDs', () => {
    expect(getModelContextWindow('us.anthropic.claude-opus-4-8')).toBe(1_000_000)
    expect(getModelContextWindow('us.anthropic.claude-sonnet-4-6')).toBe(1_000_000)
    expect(getModelContextWindow('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(200_000)
  })

  it('isClaudeModel recognizes Bedrock IDs', () => {
    expect(isClaudeModel('us.anthropic.claude-opus-4-8')).toBe(true)
    expect(isClaudeModel('anthropic.claude-sonnet-4-6')).toBe(true)
    expect(isClaudeModel('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true)
  })
})

// ============================================================
// Claude Fable 5 registration (Claude Agent SDK path)
// ============================================================

describe('Claude Fable 5', () => {
  it('is registered as an Anthropic model with the expected metadata', () => {
    const fable = ANTHROPIC_MODELS.find(m => m.id === 'claude-fable-5')
    expect(fable).toBeDefined()
    expect(fable!.provider).toBe('anthropic')
    expect(fable!.name).toBe('Fable 5')
    expect(fable!.shortName).toBe('Fable')
    expect(fable!.contextWindow).toBe(1_000_000)
    expect(fable!.descriptionKey).toBe('model.fableDesc')
  })

  it('resolves display/short name, context window, and Claude detection', () => {
    expect(getModelDisplayName('claude-fable-5')).toBe('Fable 5')
    expect(getModelShortName('claude-fable-5')).toBe('Fable')
    expect(getModelContextWindow('claude-fable-5')).toBe(1_000_000)
    expect(isClaudeModel('claude-fable-5')).toBe(true)
  })

  it('does NOT become the Anthropic default (Opus 4.8 stays default)', () => {
    expect(getDefaultModelForConnection('anthropic')).toBe('claude-opus-4-8')
  })

  it('round-trips through the Bedrock inference-profile mapping', () => {
    expect(toBedrockNativeId('claude-fable-5')).toBe('us.anthropic.claude-fable-5')
    expect(toBedrockNativeId('claude-fable-5', 'eu')).toBe('eu.anthropic.claude-fable-5')
    expect(fromBedrockNativeId('us.anthropic.claude-fable-5')).toBe('claude-fable-5')
    expect(fromBedrockNativeId('eu.anthropic.claude-fable-5')).toBe('claude-fable-5')
    expect(fromBedrockNativeId('global.anthropic.claude-fable-5')).toBe('claude-fable-5')
    expect(fromBedrockNativeId('anthropic.claude-fable-5')).toBe('claude-fable-5')
    // Bedrock-native id resolves to display metadata too
    expect(getModelDisplayName('us.anthropic.claude-fable-5')).toBe('Fable 5')
  })
})

// F1.1214 — the models overview's "Amazon Bedrock ID" row for the three
// current models (platform.claude.com/docs/en/models/overview.md).
describe('Claude Fable 5.1, Opus 5.5 and Sonnet 5.5 Bedrock ids', () => {
  it('map to the inference-profile form and back', () => {
    for (const bare of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']) {
      expect(toBedrockNativeId(bare)).toBe(`us.anthropic.${bare}`)
      expect(toBedrockNativeId(bare, 'eu')).toBe(`eu.anthropic.${bare}`)
      expect(fromBedrockNativeId(`global.anthropic.${bare}`)).toBe(bare)
    }
  })

  it('leaves an id the overview does not list unmapped', () => {
    expect(toBedrockNativeId('claude-opus-5-6')).toBe('claude-opus-5-6')
  })
})

// ============================================================
// Claude Opus 5 preferred default (Pi `anthropic` auth provider)
// ============================================================

describe('Claude Opus 5 in PI_PREFERRED_DEFAULTS', () => {
  it('heads the anthropic list, ahead of Opus 4.8', () => {
    const preferred = PI_PREFERRED_DEFAULTS.anthropic!
    expect(preferred[0]).toBe('claude-opus-5')
    expect(preferred[1]).toBe('claude-opus-4-8')
  })

  it('heads the Bedrock list too, now that the profile id is mapped', () => {
    // This used to pin Bedrock to Opus 4.8 on the stated grounds that "Opus 5
    // has no Bedrock inference-profile mapping in BEDROCK_MODEL_MAP, so heading
    // the bedrock list with it would resolve to nothing". That precondition is
    // gone: the mapping exists, so assert the head RESOLVES rather than
    // asserting a frozen id.
    expect(PI_PREFERRED_DEFAULTS['amazon-bedrock']![0]!).toBe('claude-opus-5')
    expect(toBedrockNativeId(PI_PREFERRED_DEFAULTS['amazon-bedrock']![0]!))
      .toBe('us.anthropic.claude-opus-5')
    // Untouched by this change.
    expect(PI_PREFERRED_DEFAULTS['github-copilot']![0]).toBe('claude-sonnet-4-6')
  })
})

describe('setModelSupportsImages', () => {
  it('promotes string Pi model entries with default context-window metadata', () => {
    const defaultModel = getDefaultModelsForConnection('pi', 'anthropic')
      .find(model => typeof model !== 'string' && model.contextWindow > 0)
    expect(defaultModel).toBeDefined()
    if (!defaultModel || typeof defaultModel === 'string') return

    const updated = setModelSupportsImages({
      slug: 'pi-anthropic',
      name: 'Pi Anthropic',
      providerType: 'pi',
      authType: 'api_key',
      piAuthProvider: 'anthropic',
      createdAt: 1,
      models: [defaultModel.id],
    }, defaultModel.id, true)

    expect(updated.models?.[0]).toMatchObject({
      id: defaultModel.id,
      contextWindow: defaultModel.contextWindow,
      supportsImages: true,
    })
  })
})

describe('resolveGatewayFastModelId (T1 orchestrator small-tier default)', () => {
  it('resolves the fast-aliased model id by the gateway alias (case-insensitive shortName)', () => {
    // fetchNestorModels maps the gateway `alias` onto ModelDefinition.shortName
    // and produces partial entries (no provider/contextWindow) — mirror that shape.
    const id = resolveGatewayFastModelId({
      models: [
        { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'default (…)', shortName: 'default' } as any,
        { id: 'tgpt/qwen36-35b-a3b-fp8', name: 'fast (…)', shortName: 'Fast' } as any,
      ],
    })
    expect(id).toBe('tgpt/qwen36-35b-a3b-fp8')
  })

  it('returns undefined when no fast-aliased model exists (non-gateway providers keep today\'s behavior)', () => {
    expect(resolveGatewayFastModelId({
      models: [
        { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'default (…)', shortName: 'default' } as any,
        { id: 'claude-opus-4-8', name: 'Opus 4.8', shortName: 'Opus' } as any,
      ],
    })).toBeUndefined()
    // No models at all, and string-only entries, both resolve to undefined.
    expect(resolveGatewayFastModelId({ models: [] })).toBeUndefined()
    expect(resolveGatewayFastModelId({ models: undefined })).toBeUndefined()
    expect(resolveGatewayFastModelId({ models: ['tgpt/qwen36-35b-a3b-fp8'] })).toBeUndefined()
  })
})

// ============================================================
// P2.94 / P2.95a — ONE REVERSE MAPPING, MEASURED AGAINST THE SHIPPED CATALOG
//
// The reverse mapping existed three times: here, in `models.ts`, and (as the
// forward table) once more. `models.ts`'s copy was missing every
// `claude-opus-5` form, so the id the app SEEDS as the Bedrock default rendered
// as "Eu.anthropic.opus 5" with no context window. A fourth hand-written copy
// would have the same fate, so the assertions below are pinned against the
// SHIPPED Pi catalog rather than a list typed in this file — a third list is
// exactly what a two-lists-must-agree guard needs.
// ============================================================

describe('Bedrock display metadata', () => {
  /** Every Claude Bedrock id the shipped Pi catalog offers, without the pi/ prefix. */
  function catalogClaudeIds(): string[] {
    return getDefaultModelsForConnection('pi', 'amazon-bedrock')
      .map(model => (typeof model === 'string' ? model : model.id))
      .map(id => (id.startsWith('pi/') ? id.slice(3) : id))
      .filter(id => id.includes('.anthropic.claude-'))
  }

  it('resolves Opus 5 in every geography the catalog ships', () => {
    // The exact P2.94 defect: `getModelDisplayName('us.anthropic.claude-opus-5')`
    // answered "Us.anthropic.opus 5" and the context window was unknown.
    for (const prefix of ['us', 'eu', 'global', 'au', 'jp', 'apac']) {
      const id = `${prefix}.anthropic.claude-opus-5`
      expect(getModelDisplayName(id), id).toBe('Opus 5')
      expect(getModelShortName(id), id).toBe('Opus')
      expect(getModelContextWindow(id), id).toBe(1_000_000)
      expect(fromBedrockNativeId(id), id).toBe('claude-opus-5')
    }
  })

  it('never leaks a wire id shape into a display name, for any catalog model', () => {
    const ids = catalogClaudeIds()
    // Positive control: the catalog is actually loaded. Without this the loop
    // below passes vacuously on an empty list.
    expect(ids.length).toBeGreaterThan(20)
    for (const id of ids) {
      const display = getModelDisplayName(id)
      expect(display, id).not.toContain('anthropic.')
      expect(display, id).not.toContain('claude-')
      // A geography prefix capitalized into a product name is the shape the old
      // gap produced ("Au.anthropic.opus 5", "Jp.anthropic.sonnet 5").
      expect(display, id).not.toMatch(/^(Us|Eu|Global|Au|Jp|Apac)\./)
    }
  })

  it('agrees with the registry lookup for every catalog model', () => {
    // `models.ts` and this module used to answer this question from two
    // different tables. They now read one, so a model either resolves in both
    // or in neither — and re-introducing a private copy that drifts fails here.
    for (const id of catalogClaudeIds()) {
      const viaNative = getModelDisplayName(id)
      const viaBare = getModelDisplayName(fromBedrockNativeId(id))
      expect(viaNative, id).toBe(viaBare)
    }
  })
})

describe('Bedrock region correction', () => {
  it('re-prefixes an id that is ALREADY native when a region is named', () => {
    // P2.95a's second half. The setup handler calls
    // `toBedrockNativeId(bare, deriveBedrockRegionPrefix(awsRegion))`; a stored
    // `eu.` profile used to sail through unchanged because the forward table has
    // no key for a native id, so nothing region-corrected the seeded default.
    expect(toBedrockNativeId('eu.anthropic.claude-opus-5', 'us')).toBe('us.anthropic.claude-opus-5')
    expect(toBedrockNativeId('us.anthropic.claude-opus-5', 'apac')).toBe('apac.anthropic.claude-opus-5')
    expect(toBedrockNativeId('eu.anthropic.claude-sonnet-4-6', 'us-gov')).toBe('us-gov.anthropic.claude-sonnet-4-6')
    // Normalizing on the way through: a `-v1` shape from an older release comes
    // out canonical rather than relocated verbatim.
    expect(toBedrockNativeId('eu.anthropic.claude-opus-4-7-v1', 'us')).toBe('us.anthropic.claude-opus-4-7')
  })

  it('leaves a native id alone when no region is named', () => {
    // A caller that names no region is asking for a mapping, not a move.
    expect(toBedrockNativeId('eu.anthropic.claude-opus-5')).toBe('eu.anthropic.claude-opus-5')
    expect(toBedrockNativeId('global.anthropic.claude-sonnet-5')).toBe('global.anthropic.claude-sonnet-5')
  })

  it('never rewrites a model it has no mapping for', () => {
    expect(toBedrockNativeId('us.anthropic.claude-imaginary-9', 'eu')).toBe('us.anthropic.claude-imaginary-9')
    expect(toBedrockNativeId('amazon.nova-pro-v1:0', 'eu')).toBe('amazon.nova-pro-v1:0')
    expect(toBedrockNativeId('arn:aws:bedrock:us-east-1:1:application-inference-profile/x', 'eu'))
      .toBe('arn:aws:bedrock:us-east-1:1:application-inference-profile/x')
  })
})

describe('the seeded Bedrock default is region-neutral', () => {
  it('seeds the documented us. profile rather than whatever sorts first', () => {
    // MEASURED before the fix: `pi/eu.anthropic.claude-opus-5`, for every user
    // in every region. The catalog is alphabetical, all five geographies of Opus
    // 5 tie on preference, `Array.sort` is stable, and `au.`/`jp.` were the two
    // prefixes the old reverse table did not recognize — so the first
    // RECOGNIZED id won, and that is `eu.`.
    const seeded = getDefaultModelForConnection('pi', 'amazon-bedrock')
    if (!seeded) return // Pi resolver not registered in this environment
    expect(seeded).toBe('pi/us.anthropic.claude-opus-5')
  })

  it('still heads the list with the preferred model family', () => {
    const models = getDefaultModelsForConnection('pi', 'amazon-bedrock')
    if (models.length === 0) return
    const firstId = typeof models[0] === 'string' ? models[0]! : (models[0] as { id: string }).id
    const bare = firstId.startsWith('pi/') ? firstId.slice(3) : firstId
    expect(fromBedrockNativeId(bare)).toBe(PI_PREFERRED_DEFAULTS['amazon-bedrock']![0]!)
  })
})

// ============================================================
// P2.97 — the mini/background slot prefers SMALL models
// ============================================================

describe('PI_MINI_PREFERRED_DEFAULTS', () => {
  it('UB7.14 / OQ-B2.1 (a) — the Anthropic utility tier heads with Haiku 5.5 and keeps Haiku 4.5 as the degrade path', () => {
    expect(PI_MINI_PREFERRED_DEFAULTS.anthropic).toEqual(['claude-haiku-5-5', 'claude-haiku-4-5'])
  })

  it('contains only small-class candidates', () => {
    // The mutation this kills: an Opus (or a `-pro`) added to the mini table,
    // which is exactly what walking PI_PREFERRED_DEFAULTS did.
    for (const [provider, candidates] of Object.entries(PI_MINI_PREFERRED_DEFAULTS)) {
      expect(candidates.length, provider).toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(isSmallClassModelId(candidate), `${provider}: ${candidate}`).toBe(true)
      }
    }
  })

  it('covers every provider that has a primary-model preference', () => {
    // A provider added to one table and not the other keeps working, but on a
    // large model — so the tables must not drift apart silently.
    for (const provider of Object.keys(PI_PREFERRED_DEFAULTS)) {
      expect(PI_MINI_PREFERRED_DEFAULTS[provider], provider).toBeDefined()
    }
  })

  it('classifies large models as not small', () => {
    // Negative side of the predicate: without this the invariant above passes
    // for a predicate that returns true for everything.
    for (const id of ['claude-opus-5', 'claude-opus-4-8', 'gpt-5.5', 'deepseek-v4-pro', 'us.anthropic.claude-opus-5']) {
      expect(isSmallClassModelId(id), id).toBe(false)
    }
  })

  it('resolves Bedrock candidates as native inference-profile ids', () => {
    // Bare `claude-*` ids do not exist in the Bedrock catalog, which is why the
    // Bedrock mini pick resolved to nothing at all before this row.
    for (const candidate of PI_MINI_PREFERRED_DEFAULTS['amazon-bedrock']!) {
      expect(candidate.startsWith('global.anthropic.'), candidate).toBe(true)
      expect(fromBedrockNativeId(candidate), candidate).not.toBe(candidate)
    }
  })
})

// ============================================================
// P2.194 — the three things the catalog was short, and the shape that let each
// one survive the guard above it.
//
// The `6803a17ff` guard pins a PROPERTY: no display name may leak a wire shape.
// None of these three violate it, which is why they came through — a property
// guard catches the class it names and nothing else.
// ============================================================

describe('P2.194 · the deprecation table is geography-derived', () => {
  /**
   * Every prefix `deriveBedrockRegionPrefix` can emit, plus the two the upstream
   * table lists as choosable. Read from the module rather than typed here, so
   * this cannot be the list that drifts.
   */
  const EVERY_PREFIX = BEDROCK_REGION_PREFIXES

  it('normalizes a deprecated Bedrock id under EVERY geography, not just the three typed by hand', () => {
    // MUTATION KILLED: restoring the hand-listed per-prefix table. It carried
    // `us.`/`eu.`/`global.` rows for two of the three models and only
    // `us.`/`eu.` for the dated 4.5 Opus, so this loop fails at
    // `global.anthropic.claude-opus-4-5-…` — the exact omission that made one
    // model read "Opus 4.5" beside its twins' "Opus 4.8" — and again at every
    // `apac.`, `jp.`, `au.` and `us-gov.` form, which the hand table never had.
    expect(EVERY_PREFIX.length).toBeGreaterThan(4)
    for (const prefix of EVERY_PREFIX) {
      expect(normalizeDeprecatedModelId(`${prefix}.anthropic.claude-opus-4-5-20251101-v1:0`), prefix)
        .toBe(`${prefix}.anthropic.claude-opus-4-8`)
      expect(normalizeDeprecatedModelId(`${prefix}.anthropic.claude-opus-4-6-v1`), prefix)
        .toBe(`${prefix}.anthropic.claude-opus-4-8`)
      // The `-v1` shape of a model that was NOT superseded still canonicalizes.
      expect(normalizeDeprecatedModelId(`${prefix}.anthropic.claude-opus-4-7-v1`), prefix)
        .toBe(`${prefix}.anthropic.claude-opus-4-7`)
      // And the display agrees, which is the reading the omission corrupted.
      expect(getModelDisplayName(`${prefix}.anthropic.claude-opus-4-5-20251101-v1:0`), prefix)
        .toBe('Opus 4.8')
    }
  })

  it('leaves an unprefixed and a non-deprecated id alone', () => {
    // The control: a derivation that rewrote everything would satisfy the loop
    // above. `pi/` prefixing is preserved through the recursion, too.
    expect(normalizeDeprecatedModelId('anthropic.claude-opus-4-6-v1')).toBe('anthropic.claude-opus-4-8')
    expect(normalizeDeprecatedModelId('us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5')
    expect(normalizeDeprecatedModelId('pi/eu.anthropic.claude-opus-4-6-v1')).toBe('pi/eu.anthropic.claude-opus-4-8')
    expect(normalizeDeprecatedModelId('tgpt/qwen35-397b-a17b-fp8')).toBe('tgpt/qwen35-397b-a17b-fp8')
  })
})

describe('P2.194 · claude-sonnet-4-5-20250929 is in the catalog', () => {
  it('has a context window and a real display name', () => {
    // MUTATION KILLED: deleting the registry row. `getModelContextWindow`
    // answered `undefined` — so nothing downstream could compute a compaction
    // threshold for the model a Bedrock session bills its background turns to
    // (`PI_MINI_PREFERRED_DEFAULTS['amazon-bedrock']` heads with its `global.`
    // form) — and the display name came from the humanizer.
    expect(getModelContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(getModelDisplayName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(getModelShortName('claude-sonnet-4-5-20250929')).toBe('Sonnet')
    // Through its Bedrock forms too, in every geography the catalog ships.
    for (const prefix of ['us', 'eu', 'global', 'au', 'jp']) {
      const id = `${prefix}.anthropic.claude-sonnet-4-5-20250929-v1:0`
      expect(getModelDisplayName(id), id).toBe('Sonnet 4.5')
      expect(getModelContextWindow(id), id).toBe(200_000)
    }
  })

  it('did not become anybody else"s Sonnet', () => {
    // MUTATION KILLED: inserting the row ABOVE `claude-sonnet-4-6` or
    // `claude-sonnet-5`. `getModelIdByShortName` returns the FIRST row with a
    // shortName — the same mechanism that makes `DEFAULT_MODEL` Opus 4.8 rather
    // than Opus 5 — so position is behaviour, not tidiness.
    const sonnets = ANTHROPIC_MODELS.filter(model => model.shortName === 'Sonnet').map(model => model.id)
    expect(sonnets[0]).toBe('claude-sonnet-5')
    expect(sonnets).toContain('claude-sonnet-4-5-20250929')
    expect(sonnets.indexOf('claude-sonnet-4-5-20250929'))
      .toBeGreaterThan(sonnets.indexOf('claude-sonnet-4-6'))
  })
})

describe('P2.194 · the tripwire: the catalog ships apac. ids since 0.87.1', () => {
  it('MEASURES the prefixes the shipped Pi Bedrock catalog actually publishes', () => {
    const prefixes = new Set(getDefaultModelsForConnection('pi', 'amazon-bedrock')
      .map(model => (typeof model === 'string' ? model : model.id))
      .map(id => (id.startsWith('pi/') ? id.slice(3) : id))
      .filter(id => id.includes('.anthropic.claude-'))
      .map(id => id.slice(0, id.indexOf('.'))))
    // Positive control: the catalog is loaded and does carry geographies.
    expect(prefixes.has('us')).toBe(true)
    expect(prefixes.has('global')).toBe(true)
    // THE MEASUREMENT: `deriveBedrockRegionPrefix` emits `apac` for every `ap-*`
    // region and `us-gov` for GovCloud. At the 0.85.1 catalog neither was published
    // — which is why `resolveModelForProvider` carries a same-model geography
    // fallback; the tripwire this test carries FIRED at 0.87.1: the catalog now ships
    // `apac.` ids (measured 2026-10-10), so the fallback's apac arm is redundant
    // and can narrow — recorded for the owner, not narrowed in this lift.
    expect(prefixes.has('apac')).toBe(true)
    expect(prefixes.has('us-gov')).toBe(false)
    // Both are nonetheless derivable by our own prefix-independent table — the
    // gap is upstream's catalog, not our mapping.
    expect(toBedrockNativeId('us.anthropic.claude-opus-5', 'apac')).toBe('apac.anthropic.claude-opus-5')
    expect(deriveBedrockRegionPrefix('ap-southeast-1')).toBe('apac')
  })
})

// ============================================================
// UB3.6 (upstream v0.15.0) — preferredModelRank: a deprecated model id does
// not become the default. The old findPreferredIndex closure let a retired
// snapshot (`claude-opus-4-5-20251101`) inherit its replacement's rank through
// the `{id}-*` snapshot match, and the stable sort then picked it as the
// connection default.
// ============================================================

describe('preferredModelRank (UB3.6)', () => {
  const preferred = ['claude-opus-5', 'claude-opus-4-8']

  it('positive: the preferred current id ranks first, the second entry second', () => {
    expect(preferredModelRank('claude-opus-5', preferred)).toBe(0)
    expect(preferredModelRank('claude-opus-4-8', preferred)).toBe(1)
  })

  it('a pi/-prefixed id ranks as its bare id', () => {
    expect(preferredModelRank('pi/claude-opus-5', preferred)).toBe(0)
    expect(preferredModelRank('pi/claude-opus-4-8', preferred)).toBe(1)
  })

  it('a snapshot id of a CURRENT model matches its bare id ({id}-* is a feature, not a bug)', () => {
    expect(preferredModelRank('claude-opus-5-20260101', preferred)).toBe(0)
  })

  it('a Bedrock inference profile reverse-maps to its bare id', () => {
    expect(preferredModelRank('us.anthropic.claude-opus-5', preferred)).toBe(0)
  })

  it('negative control: a RETIRED snapshot whose replacement is preferred ranks unranked (-1)', () => {
    // `claude-opus-4-5-20251101` normalizes to `claude-opus-4-8` (deprecated);
    // against preferred ['claude-opus-4-5'] the OLD closure ranked it 0 through
    // the snapshot match and the stable sort made it the default.
    expect(normalizeDeprecatedModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-8')
    expect(preferredModelRank('claude-opus-4-5-20251101', ['claude-opus-4-5'])).toBe(-1)
  })

  it('a deprecated Bedrock-native form ranks unranked too', () => {
    expect(preferredModelRank('us.anthropic.claude-opus-4-6-v1', ['claude-opus-4-8'])).toBe(-1)
  })

  it('an unmatched id ranks unranked', () => {
    expect(preferredModelRank('gpt-5.5', preferred)).toBe(-1)
  })
})

describe('getDefaultModelsForConnection keeps preferred first under UB3.6 ranking', () => {
  it('positive: the current preferred id sorts first for the real anthropic Pi catalog', () => {
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    const ids = models.map(m => typeof m === 'string' ? m : m.id)
    // The real catalog spells the head id `pi/claude-opus-5`; the RANK is the
    // contract, not the spelling (the driver caught the same naive expectation).
    expect(preferredModelRank(ids[0]!, PI_PREFERRED_DEFAULTS.anthropic!)).toBe(0)
    // Every preferred entry that exists in the catalog sorts before every
    // unranked one; the deprecated claude-opus-4-6, if the catalog carries it,
    // must NOT sit inside the preferred block.
    const preferred = PI_PREFERRED_DEFAULTS.anthropic!
    const firstUnranked = ids.findIndex(id => preferredModelRank(id, preferred) < 0)
    // UB12.30: asserted, not branched on. The real catalog carries unranked
    // (retired) ids after a ranked head, so the boundary exists and the next
    // line cannot pass vacuously. (The loop this replaces re-checked the ids
    // BEFORE `firstUnranked`, which `findIndex` already made ranked, and ran
    // only inside `if (firstUnranked >= 0)` — it could not fail.)
    expect(firstUnranked).toBeGreaterThan(0)
    // No preferred id sorts after the first unranked one.
    expect(ids.slice(firstUnranked).filter(id => preferredModelRank(id, preferred) >= 0)).toEqual([])
  })
})

describe('getMiniModel uses preferredModelRank over PI_MINI_PREFERRED_DEFAULTS (UB3.6)', () => {
  const conn = (models: string[]) => ({
    models,
    providerType: 'pi' as const,
    piAuthProvider: 'anthropic',
  })

  it('picks the best-ranked preferred mini model present in the connection', () => {
    // UB7.14 moved the head: PI_MINI_PREFERRED_DEFAULTS.anthropic = ['claude-haiku-5-5', 'claude-haiku-4-5'].
    expect(PI_MINI_PREFERRED_DEFAULTS.anthropic![0]).toBe('claude-haiku-5-5')
    expect(getMiniModel(conn(['claude-opus-5', 'claude-haiku-4-5', 'claude-sonnet-5']))).toBe('claude-haiku-4-5')
    // No ranked candidate present → the keyword/fallback arms answer, as before.
    expect(getMiniModel(conn(['claude-opus-5', 'claude-sonnet-5']))).toBe('claude-sonnet-5')
  })

  it('negative control: a retired snapshot is skipped for the mini tier instead of inheriting its replacement rank', () => {
    expect(getMiniModel(conn(['claude-opus-4-5-20251101', 'claude-haiku-4-5', 'claude-sonnet-5']))).toBe('claude-haiku-4-5')
  })
})

// ============================================================
// UB7.15 (B2-05/S-06, upstream v0.15.0 "Cheaper titles and summaries") — the
// whole-token keyword match, the openai `gpt-6-luna` head and the Moonshot
// entries. The substring `includes` matched "mini" inside "ge-mini", so the
// first gemini-* row won the keyword arm for every provider the mini table
// had no entry for.
// ============================================================

describe('UB7.15 — whole-token keywords, the luna head, the Kimi entries', () => {
  const conn = (models: string[], piAuthProvider?: string) => ({
    models,
    providerType: 'pi' as const,
    piAuthProvider,
  })

  it('positive: a provider with no mini-table entry whose list leads with gemini-* picks the flash row, not ge-mini', () => {
    // No PI_MINI_PREFERRED_DEFAULTS entry for 'madeup' → the keyword arm runs;
    // `includes` answered 'gemini-3-pro' here ("mini" inside "gemini").
    expect(PI_MINI_PREFERRED_DEFAULTS['madeup-provider-ub715']).toBeUndefined()
    expect(getMiniModel(conn(['gemini-3-pro', 'gemini-3-flash'], 'madeup-provider-ub715'))).toBe('gemini-3-flash')
  })

  it('positive: OpenAI heads with gpt-6-luna and a Luna-bearing connection picks it', () => {
    expect(PI_MINI_PREFERRED_DEFAULTS.openai![0]).toBe('gpt-6-luna')
    expect(getMiniModel(conn(['gpt-5.5', 'gpt-6-luna', 'gpt-5-mini'], 'openai'))).toBe('gpt-6-luna')
  })

  it('positive: Moonshot hosts carry the Kimi utility tier for both geo keys', () => {
    expect(PI_MINI_PREFERRED_DEFAULTS.moonshotai).toEqual(['kimi-k2.6'])
    expect(PI_MINI_PREFERRED_DEFAULTS['moonshotai-cn']).toEqual(['kimi-k2.6'])
    expect(getMiniModel(conn(['kimi-k3', 'kimi-k2.6'], 'moonshotai'))).toBe('kimi-k2.6')
    // The Kimi family is Moonshot's named cheap tier — the honesty predicate
    // reads it as small-class, or the table pin below would refuse the entry.
    expect(isSmallClassModelId('kimi-k2.6')).toBe(true)
  })

  it('control: an Anthropic connection still finds haiku through the whole-token arm', () => {
    // providerType 'anthropic' (no Pi auth provider) → the keyword arm is
    // ['haiku']; 'haiku' is a whole token in 'claude-haiku-4-5'.
    expect(getMiniModel({
      models: ['claude-opus-5', 'claude-haiku-4-5', 'claude-sonnet-5'],
      providerType: 'anthropic' as const,
    })).toBe('claude-haiku-4-5')
  })

  it('control: the gateway fast alias still wins before any table or keyword arm (P6.1080, untouched)', () => {
    expect(getMiniModel({
      models: [
        { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'default (…)', shortName: 'default' } as any,
        { id: 'tgpt/qwen36-35b-a3b-fp8', name: 'fast (…)', shortName: 'Fast' } as any,
        { id: 'tgpt/something-flash', name: 'flash (…)', shortName: 'flash' } as any,
      ],
      providerType: 'pi' as const,
      piAuthProvider: 'openai',
    })).toBe('tgpt/qwen36-35b-a3b-fp8')
  })

  it('control: a mini-table hit still beats the keyword arm, and google still resolves Flash over a leading Pro', () => {
    // google's mini table is ['gemini-2.5-flash', …]: the table arm answers
    // before keywords are consulted (UB3.6's shape, unchanged).
    expect(getMiniModel(conn(['gemini-3-pro', 'gemini-2.5-flash', 'gemini-3-flash'], 'google'))).toBe('gemini-2.5-flash')
  })

  it('boundary: a name that merely CONTAINS a keyword substring no longer wins, one that carries the token does', () => {
    // 'dominus-2-pro' contains no whole keyword; 'nominal-2-mini' does. The
    // old `includes` would have matched 'dominus' for… no keyword — this pair
    // pins the edge directly: 'pro' is not a keyword and 'mini' inside
    // 'dominium' would have been, so both rows keep their honest verdicts.
    expect(getMiniModel(conn(['dominus-2-flash-lite-preview', 'plain-2-model'], 'madeup-provider-ub715'))).toBe('dominus-2-flash-lite-preview')
  })
})

// ============================================================
// UB3.7 (R14-48, upstream v0.13.5, unchanged at v0.15.1) — the retired
// `deepseek-v4-flash` alias: PI_PREFERRED_DEFAULTS names `deepseek-flash`
// (the shipped 0.87.1+ catalog's only flash row), and the deprecated table
// migrates stored ids at read (factory.ts normalizes connection.defaultModel).
// The gateway's own `tgpt/deepseek-v4-flash-0731` is a DIFFERENT id on a
// DIFFERENT surface and is out of scope.
// ============================================================

describe('UB3.7 — the deepseek-v4-flash retirement', () => {
  it('positive: a new BYO DeepSeek connection defaults to a CURRENT catalog row, never the retired alias', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'deepseek')
    const catalog = getDefaultModelsForConnection('pi', 'deepseek').map(m => typeof m === 'string' ? m : m.id)
    // Upstream's preferred order is ['deepseek-v4-pro', 'deepseek-flash']: the
    // default is the rank-0 row (the shipped catalog carries both, pi/-prefixed),
    // the renamed `deepseek-flash` is preferred second, and the retired alias is
    // in neither the catalog nor the list.
    expect(catalog).toContain('pi/deepseek-flash')
    expect(catalog).not.toContain('pi/deepseek-v4-flash')
    expect(defaultModel).toBe('pi/deepseek-v4-pro')
    expect(preferredModelRank(defaultModel, PI_PREFERRED_DEFAULTS.deepseek!)).toBe(0)
    expect(preferredModelRank('pi/deepseek-flash', PI_PREFERRED_DEFAULTS.deepseek!)).toBe(1)
  })

  it('PI_PREFERRED_DEFAULTS names the renamed alias, never the retired one', () => {
    expect(PI_PREFERRED_DEFAULTS.deepseek).toEqual(['deepseek-v4-pro', 'deepseek-flash'])
    expect(PI_PREFERRED_DEFAULTS.deepseek).not.toContain('deepseek-v4-flash')
  })

  it('the deprecated table migrates both retired forms to deepseek-flash', () => {
    expect(normalizeDeprecatedModelId('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(normalizeDeprecatedModelId('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash')
    // A STORED connection defaulting to either old id resolves to the
    // replacement at read (factory.ts normalizes connection.defaultModel), and
    // the preference machinery ranks the retired forms unranked so they can
    // neither seed nor win a tier.
    expect(preferredModelRank('deepseek-v4-flash', PI_MINI_PREFERRED_DEFAULTS.deepseek!)).toBe(-1)
    expect(preferredModelRank('deepseek-v4-flash-vision-exp', PI_MINI_PREFERRED_DEFAULTS.deepseek!)).toBe(-1)
  })

  it('negative control: the gateway tgpt id is a different id on a different surface and is untouched', () => {
    // Not a deprecated key: normalization leaves it verbatim, and the deepseek
    // preferred list does not rank it (its alias read is resolveGatewayFastModelId's).
    expect(normalizeDeprecatedModelId('tgpt/deepseek-v4-flash-0731')).toBe('tgpt/deepseek-v4-flash-0731')
    expect(preferredModelRank('tgpt/deepseek-v4-flash-0731', PI_PREFERRED_DEFAULTS.deepseek!)).toBe(-1)
  })
})
