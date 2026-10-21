import { describe, it, expect } from 'bun:test'
import {
  resolveSlugForMethod,
  apiSetupMethodToConnectionSetup,
  BASE_SLUG_FOR_METHOD,
} from '../useOnboarding'
import type { ApiSetupMethod } from '@/components/onboarding'
import { NESSY_GATEWAY_CONTEXT_WINDOW, NESSY_GATEWAY_MODELS } from '@/components/apisetup/nessy-gateway'

// ============================================================
// resolveSlugForMethod
// ============================================================

describe('resolveSlugForMethod', () => {
  it('returns the base slug when it is available', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set())
    expect(slug).toBe('anthropic-api')
  })

  it('reuses editingSlug when editing an existing connection', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', 'my-custom-slug', new Set(['anthropic-api']))
    expect(slug).toBe('my-custom-slug')
  })

  it('appends -2 when base slug is taken', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set(['anthropic-api']))
    expect(slug).toBe('anthropic-api-2')
  })

  it('appends -3 when both base and -2 are taken', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set(['anthropic-api', 'anthropic-api-2']))
    expect(slug).toBe('anthropic-api-3')
  })

  it('works for all setup methods', () => {
    const methods: ApiSetupMethod[] = [
      'anthropic_api_key', 'claude_oauth',
      'pi_chatgpt_oauth', 'pi_api_key',
    ]
    for (const method of methods) {
      const slug = resolveSlugForMethod(method, null, new Set())
      expect(slug).toBe(BASE_SLUG_FOR_METHOD[method])
    }
  })
})

// ============================================================
// apiSetupMethodToConnectionSetup
// ============================================================

describe('apiSetupMethodToConnectionSetup', () => {
  it('anthropic_api_key includes credential, baseUrl, defaultModel, models', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'anthropic_api_key',
      { credential: 'sk-ant-test', baseUrl: 'https://custom.api', connectionDefaultModel: 'claude-sonnet-4-6', models: ['model-a'] },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('anthropic-api')
    expect(setup.credential).toBe('sk-ant-test')
    expect(setup.baseUrl).toBe('https://custom.api')
    expect(setup.defaultModel).toBe('claude-sonnet-4-6')
    expect(setup.models).toEqual(['model-a'])
  })

  it('claude_oauth includes only credential', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'claude_oauth',
      { credential: 'oauth-token-123' },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('claude-max')
    expect(setup.credential).toBe('oauth-token-123')
    expect(setup.baseUrl).toBeUndefined()
  })

  it('pi_chatgpt_oauth maps to chatgpt-plus slug', () => {
    const setup = apiSetupMethodToConnectionSetup('pi_chatgpt_oauth', {}, null, new Set())
    expect(setup.slug).toBe('chatgpt-plus')
  })

  it('pi_api_key includes piAuthProvider and modelSelectionMode', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'pi_api_key',
      {
        credential: 'sk-pi',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
      },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('pi-api-key')
    expect(setup.credential).toBe('sk-pi')
    expect(setup.piAuthProvider).toBe('anthropic')
    expect(setup.modelSelectionMode).toBe('userDefined3Tier')
  })

  it('preserves Nessy Gateway object models with context windows', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'pi_api_key',
      {
        credential: 'jwt',
        baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
        connectionDefaultModel: NESSY_GATEWAY_MODELS[0]!.id,
        models: NESSY_GATEWAY_MODELS,
        piAuthProvider: 'openai',
        modelSelectionMode: 'userDefined3Tier',
        customEndpoint: { api: 'openai-completions', supportsImages: false },
      },
      null,
      new Set(),
    )

    expect(setup.models).toEqual(NESSY_GATEWAY_MODELS)
    // P6.784 — the tri-states survive the mapping too, and `supportsThinking`
    // is the one worth naming: `ModelDefinition` documents it as *"Defaults to
    // true when undefined"*, so a mapping that dropped it would not leave the
    // field unset, it would flip it — on whichever row declares `false`.
    //
    // D1.440, 2026-09-20 — this pin named `tgpt/qwen35-397b-a17b-fp8`, an id
    // the gateway answers `404 … больше не поддерживается` since the 2026-09-11
    // rotation (AGENTS.md §Gateway Facts), and `supportsThinking: false` on a
    // row D1.322 measured as `true`. Both are read off the seed now rather than
    // restated, because the ids rotate; what stays literal is the FAST row's
    // `false`, which is the only one a dropped field could flip, so the arm
    // that can actually fail is the one that is spelled out.
    expect(setup.models?.[0]).toEqual(expect.objectContaining({
      id: NESSY_GATEWAY_MODELS[0]!.id,
      contextWindow: NESSY_GATEWAY_CONTEXT_WINDOW,
      supportsThinking: true,
      supportsImages: false,
    }))
    expect(setup.models?.[1]).toEqual(expect.objectContaining({
      id: NESSY_GATEWAY_MODELS[1]!.id,
      supportsThinking: false,
      supportsImages: false,
    }))
  })

  it('uses editingSlug when editing', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'anthropic_api_key',
      { credential: 'sk-ant' },
      'existing-connection',
      new Set(['anthropic-api']),
    )
    expect(setup.slug).toBe('existing-connection')
  })

  it('generates unique slug when base is taken', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'claude_oauth',
      {},
      null,
      new Set(['claude-max']),
    )
    expect(setup.slug).toBe('claude-max-2')
  })
})

// ============================================================
// Reauth slug regression tests
// ============================================================

describe('reauth slug resolution', () => {
  it('slug override wins over null editingSlug (stale closure scenario)', () => {
    // Simulates the reauth bug: editingSlug is null (stale closure),
    // but connectionSlugOverride provides the correct slug.
    const existingSlugs = new Set(['chatgpt-plus'])

    // Without override: generates -2 (the bug)
    const wrongSlug = resolveSlugForMethod('pi_chatgpt_oauth', null, existingSlugs)
    expect(wrongSlug).toBe('chatgpt-plus-2')

    // With override: reuses existing slug (the fix)
    const correctSlug = resolveSlugForMethod('pi_chatgpt_oauth', 'chatgpt-plus', existingSlugs)
    expect(correctSlug).toBe('chatgpt-plus')
  })

  it('apiSetupMethodToConnectionSetup uses override slug for reauth', () => {
    const existingSlugs = new Set(['chatgpt-plus'])
    const setup = apiSetupMethodToConnectionSetup(
      'pi_chatgpt_oauth',
      {},
      'chatgpt-plus',  // override slug (reauth)
      existingSlugs,
    )
    expect(setup.slug).toBe('chatgpt-plus')
  })

  it('new connection flow still generates unique slugs when base is taken', () => {
    const existingSlugs = new Set(['chatgpt-plus'])
    const setup = apiSetupMethodToConnectionSetup(
      'pi_chatgpt_oauth',
      {},
      null,  // no editing slug (new connection)
      existingSlugs,
    )
    expect(setup.slug).toBe('chatgpt-plus-2')
  })

})
