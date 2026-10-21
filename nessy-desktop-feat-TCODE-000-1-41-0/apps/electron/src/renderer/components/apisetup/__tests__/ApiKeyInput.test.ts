import { describe, expect, it } from 'bun:test'
import {
  resolveCustomEndpointPayload,
  resolvePiAuthProviderForSubmit,
  resolvePresetStateForBaseUrlChange,
} from '../submit-helpers'
import { pickTierDefaults, resolveTierModels } from '../tier-models'
import {
  NESSY_GATEWAY_CONTEXT_WINDOW,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODELS,
} from '../nessy-gateway'

const MODELS = [
  { id: 'pi/zai-best', name: 'Best', costInput: 10, costOutput: 20, contextWindow: 200000, reasoning: true },
  { id: 'pi/zai-balanced', name: 'Balanced', costInput: 5, costOutput: 10, contextWindow: 200000, reasoning: true },
  { id: 'pi/zai-fast', name: 'Fast', costInput: 1, costOutput: 2, contextWindow: 128000, reasoning: false },
]

describe('ApiKeyInput tier hydration helpers', () => {
  it('resolveTierModels keeps saved tier selections when all are valid', () => {
    const saved = ['pi/zai-fast', 'pi/zai-balanced', 'pi/zai-best']
    const resolved = resolveTierModels(MODELS, saved)

    expect(resolved).toEqual({
      best: 'pi/zai-fast',
      default_: 'pi/zai-balanced',
      cheap: 'pi/zai-best',
    })
  })

  it('resolveTierModels preserves duplicate tiers when saved models are valid', () => {
    const saved = ['pi/zai-best', 'pi/zai-best', 'pi/zai-fast']
    const resolved = resolveTierModels(MODELS, saved)

    expect(resolved).toEqual({
      best: 'pi/zai-best',
      default_: 'pi/zai-best',
      cheap: 'pi/zai-fast',
    })
  })

  it('resolveTierModels falls back per-slot for invalid/missing saved values', () => {
    const resolved = resolveTierModels(MODELS, ['pi/zai-best', 'pi/not-real'])
    const defaults = pickTierDefaults(MODELS)

    expect(resolved).toEqual({
      best: 'pi/zai-best',
      default_: defaults.default_,
      cheap: defaults.cheap,
    })
  })
})

describe('resolvePiAuthProviderForSubmit', () => {
  it('preserves the last non-custom provider when custom endpoint mode is selected', () => {
    expect(resolvePiAuthProviderForSubmit('custom', 'openai')).toBe('openai')
  })

  it('defaults custom endpoint mode to anthropic routing when none was selected yet', () => {
    expect(resolvePiAuthProviderForSubmit('custom', null)).toBe('anthropic')
  })

  it('passes through non-custom presets unchanged', () => {
    expect(resolvePiAuthProviderForSubmit('google', 'anthropic')).toBe('google')
  })
})

describe('resolvePresetStateForBaseUrlChange', () => {
  it('updates the remembered provider when the typed URL matches a known preset', () => {
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'openrouter',
      activePreset: 'custom',
      activePresetHasEmptyUrl: true,
      lastNonCustomPreset: 'anthropic',
    })).toEqual({
      activePreset: 'openrouter',
      lastNonCustomPreset: 'openrouter',
    })
  })

  it('preserves provider routing when editing a provider with an empty default URL', () => {
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'custom',
      activePreset: 'azure-openai-responses',
      activePresetHasEmptyUrl: true,
      lastNonCustomPreset: 'azure-openai-responses',
    })).toEqual({
      activePreset: 'azure-openai-responses',
      lastNonCustomPreset: 'azure-openai-responses',
    })
  })

  it('falls back to custom while keeping the most recent matched provider', () => {
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'custom',
      activePreset: 'openrouter',
      activePresetHasEmptyUrl: false,
      lastNonCustomPreset: 'openrouter',
    })).toEqual({
      activePreset: 'custom',
      lastNonCustomPreset: 'openrouter',
    })
  })
})

describe('resolveCustomEndpointPayload', () => {
  const BRANDED = new Set(['manifest'])

  it('routes branded openai-compat presets through openai-completions regardless of toggle', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'manifest',
      baseUrl: 'https://app.manifest.build/v1',
      customApi: 'anthropic-messages',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: { api: 'openai-completions' },
      piAuthProvider: 'openai',
    })
  })

  /**
   * P6.586 — the credential header the API key travels in.
   *
   * `LlmConnection.customEndpoint.credentialHeader` has existed since P6.258 and
   * both wires have honoured it since P6.585 (`534aadcee`); nothing could SET
   * it, so an endpoint reading its key from `x-api-key` was unreachable from the
   * UI. The pair below is the whole contract: `x-api-key` is carried, and
   * `authorization` is carried as ABSENCE — the field's absence already means
   * Authorization at every reader, so writing the default explicitly would
   * rewrite every stored connection to say what it already meant.
   */
  it('carries x-api-key and leaves the default header ABSENT', () => {
    const base = {
      activePreset: 'custom' as const,
      baseUrl: 'https://my-endpoint.example.com',
      customApi: 'openai-completions' as const,
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    }
    expect(resolveCustomEndpointPayload({ ...base, credentialHeader: 'x-api-key' })).toEqual({
      customEndpoint: { api: 'openai-completions', credentialHeader: 'x-api-key' },
      piAuthProvider: 'openai',
    })
    // The negative that keeps every existing connection byte-identical.
    const dflt = resolveCustomEndpointPayload({ ...base, credentialHeader: 'authorization' })
    expect(dflt.customEndpoint).toEqual({ api: 'openai-completions' })
    expect(Object.keys(dflt.customEndpoint ?? {})).not.toContain('credentialHeader')
    // Omitting the field entirely is the same payload — an older caller that
    // does not know about the choice cannot change a connection by upgrading.
    expect(resolveCustomEndpointPayload(base)).toEqual(dflt)
  })

  it('never carries the header on a branded preset, whose scheme is already known', () => {
    // The branded arm is pinned to openai-completions in the same expression;
    // letting a stray form value through here would change a preset the user
    // never configured.
    expect(resolveCustomEndpointPayload({
      activePreset: 'manifest',
      baseUrl: 'https://app.manifest.build/v1',
      customApi: 'openai-completions',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
      credentialHeader: 'x-api-key',
    })).toEqual({
      customEndpoint: { api: 'openai-completions' },
      piAuthProvider: 'openai',
    })
  })

  it('honors the protocol toggle for the generic custom preset', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'custom',
      baseUrl: 'https://my-endpoint.example.com',
      customApi: 'anthropic-messages',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: { api: 'anthropic-messages' },
      piAuthProvider: 'anthropic',
    })
  })

  it('returns no customEndpoint for a standard preset, passing through the fallback piAuth', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      customApi: 'openai-completions',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: 'openrouter',
    })).toEqual({
      customEndpoint: undefined,
      piAuthProvider: 'openrouter',
    })
  })

  it('treats branded preset with empty URL as non-custom (no customEndpoint)', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'manifest',
      baseUrl: '',
      customApi: 'openai-completions',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: undefined,
      piAuthProvider: undefined,
    })
  })

  it('applies branded preset endpoint options', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'nessy-gateway',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      customApi: 'anthropic-messages',
      brandedOpenAiCompatPresets: new Set(['nessy-gateway']),
      brandedOpenAiCompatPresetOptions: { 'nessy-gateway': { supportsImages: false } },
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: { api: 'openai-completions', supportsImages: false },
      piAuthProvider: 'openai',
    })
  })
})

describe('Nessy Gateway preset models', () => {
  /**
   * P6.784 — BOTH tri-states, not one. This case asserted `supportsImages` and
   * left `supportsThinking` unnamed, which is the weaker of the two to omit:
   * `supportsImages` has no default so an omission means *undeclared*, while
   * `ModelDefinition` documents `supportsThinking` as *"Defaults to true when
   * undefined"* — so a card row that lost the declaration would read as a
   * gateway model that reasons, and this guard would have passed.
   */
  /**
   * WB-d 2026-09-14, fixed in place while landing DA1.32 — this case was RED at
   * HEAD and in no register. It asserted ONE window for BOTH rows, and the seed
   * window has been PER MODEL since P3.79: `NESSY_GATEWAY_CONTEXT_WINDOW` is
   * `gatewaySeedWindow(NESSY_GATEWAY_MODEL_IDS[0])`, the coder row's own value,
   * while the fast row reads its own out of the shared windows table. The two
   * were equal until the 2026-09-11 catalogue rotation (P6.1080) gave the coder
   * model a larger window, at which point the second expectation became a claim
   * the constant never made. The RELATION is what this pins now — the fast row
   * carries its own, SMALLER window — because the ids rotate and the numbers
   * with them.
   */
  it('uses explicit object models with per-model context windows and both tri-states', () => {
    expect(NESSY_GATEWAY_MODELS).toHaveLength(2)
    const [coder, fast] = NESSY_GATEWAY_MODELS

    // D1.440, 2026-09-20 — the coder row's `supportsThinking` was pinned at
    // `false` on both rows, which made the case name ("both tri-states") a
    // claim it was not testing. D1.322 flipped this row to `true` and says so
    // on the seed with its measurement (RS-57 read the catalogue on the
    // packaged 1.40.0: a reasoning block for `coder`, none for `fast`). The
    // DISAGREEMENT is what the case pins now, so a row silently taking its
    // sibling's value fails here rather than in the composer's effort control.
    expect(coder).toEqual(expect.objectContaining({
      id: NESSY_GATEWAY_DEFAULT_MODEL,
      contextWindow: NESSY_GATEWAY_CONTEXT_WINDOW,
      supportsImages: false,
      supportsThinking: true,
    }))
    expect(fast).toEqual(expect.objectContaining({
      id: 'tgpt/qwen36-35b-a3b-fp8',
      supportsImages: false,
      supportsThinking: false,
    }))

    // Read the value out FIRST, then assert on it (AGENTS.md §Traps: asserting a
    // shape with a matcher and re-reading the same object is what mutates it).
    const fastWindow = fast?.contextWindow
    expect(typeof fastWindow).toBe('number')
    expect(fastWindow as number).toBeLessThan(NESSY_GATEWAY_CONTEXT_WINDOW)
  })
})

describe('Nessy Gateway preset credential prefill (DA1.32)', () => {
  const SETUP_DIR = new URL('../', import.meta.url).pathname
  const ONBOARDING_DIR = new URL('../../onboarding/', import.meta.url).pathname

  /**
   * The bridge that answers with the live Nestor JWT is named in WORDS here and
   * never spelled, because the assertion below is a substring guard over this
   * very directory: a comment that spelled the accessor would satisfy the
   * `toContain` it exists to refuse, which is the stale-NAME trap AGENTS.md
   * §Traps records (a guard that fires on the commit that makes it true).
   */
  const jwtBridgeAccessor = ['get', 'Nessy', 'Gateway', 'Jwt'].join('')

  it('the API-key form does not read the gateway JWT bridge (DA1.32)', async () => {
    const source = await Bun.file(`${SETUP_DIR}ApiKeyInput.tsx`).text()

    // The setup RPC refuses to store a gateway credential since DA1.13, so a
    // prefill buys nothing and renders a corporate token in a copyable field.
    expect(source).not.toContain(jwtBridgeAccessor)
    // …and nothing replaced it with a hand-rolled read of the same file.
    expect(source).not.toContain('dp_auth_creds')
  })

  it('POSITIVE CONTROL — the bridge is alive, read by the one-click card step', async () => {
    // Without this arm the guard above would also pass on a tree where the
    // bridge had been deleted outright, which is a different (and wrong) fix:
    // the one-click card needs the value to prove the sign-in happened, and
    // never displays it.
    const step = await Bun.file(`${ONBOARDING_DIR}GatewayConnectStep.tsx`).text()

    expect(step).toContain(jwtBridgeAccessor)
  })
})
