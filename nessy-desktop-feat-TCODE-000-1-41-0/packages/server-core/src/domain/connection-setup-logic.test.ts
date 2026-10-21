import { describe, expect, it } from 'bun:test'
import {
  validateSetupTestInput,
  isLoopbackBaseUrl,
  setupTestRequiresApiKey,
  resolveCustomEndpointSetup,
  resolveAdapterRuntimeAuthType,
  resolveSetupTestApiKey,
  maskApiKey,
  isMaskedApiKey,
  API_KEY_MASK,
  createBuiltInConnection,
  validateMiniModel,
  BUILT_IN_CONNECTION_TEMPLATES,
} from './connection-setup-logic'

describe('validateSetupTestInput', () => {
  it('rejects pi custom endpoint tests without piAuthProvider', () => {
    const result = validateSetupTestInput({
      provider: 'pi',
      baseUrl: 'https://example.com/v1',
    })

    expect(result.valid).toBe(false)
    if (!result.valid) {
      // Names the missing FIELD, not a menu item: the preset dropdown and the
      // "Anthropic API Key mode" card the old message pointed at are both gone,
      // and this branch is now only reachable by a caller assembling the
      // request itself.
      expect(result.error).toContain('piAuthProvider')
    }
  })

  it('allows pi custom endpoint tests with piAuthProvider', () => {
    expect(validateSetupTestInput({
      provider: 'pi',
      baseUrl: 'https://example.com/v1',
      piAuthProvider: 'openai',
    })).toEqual({ valid: true })
  })
})

describe('setup test API key requirements', () => {
  it('detects loopback base URLs', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('requires API key for non-loopback setup tests', () => {
    expect(setupTestRequiresApiKey('https://api.anthropic.com')).toBe(true)
    expect(setupTestRequiresApiKey('https://example.com/v1')).toBe(true)
  })

  it('allows keyless setup tests for loopback endpoints', () => {
    expect(setupTestRequiresApiKey('http://localhost:11434/v1')).toBe(false)
    expect(setupTestRequiresApiKey('http://127.0.0.1:11434/v1')).toBe(false)
  })
})

describe('resolveCustomEndpointSetup', () => {
  it('treats loopback URL with no credential as keyless local model', () => {
    const result = resolveCustomEndpointSetup({
      baseUrl: 'http://localhost:11434/v1',
      credential: undefined,
      customEndpointApi: 'openai-completions',
    })

    expect(result).toEqual({ authType: 'none', name: 'Local Model' })
    expect(result.piAuthProvider).toBeUndefined()
  })

  it('treats loopback URL *with* a credential as a keyed custom endpoint (#636)', () => {
    // Real-world case: vLLM, LiteLLM, or any local OpenAI-compat server with --api-key.
    // Without piAuthProvider, getPiAuth() returns null at runtime → 401 on every chat request.
    const result = resolveCustomEndpointSetup({
      baseUrl: 'http://127.0.0.1:11111/v1',
      credential: 'sk-local-test',
      customEndpointApi: 'openai-completions',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
    expect(result.name).toBeUndefined()
  })

  it('uses the anthropic provider hint for anthropic-messages protocol', () => {
    const result = resolveCustomEndpointSetup({
      baseUrl: 'http://127.0.0.1:8080',
      credential: 'sk-ant-local',
      customEndpointApi: 'anthropic-messages',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'anthropic' })
  })

  it('treats remote endpoints with a credential as keyed custom endpoints', () => {
    expect(resolveCustomEndpointSetup({
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk-remote',
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it('treats remote endpoints without a credential as keyed (still requires a key)', () => {
    // Non-loopback URLs are never assumed keyless, even if credential is missing —
    // setup validation handles "missing key" separately. We still set piAuthProvider
    // so the saved connection has a useful icon.
    expect(resolveCustomEndpointSetup({
      baseUrl: 'https://api.example.com/v1',
      credential: undefined,
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it('treats undefined baseUrl as a non-loopback (keyed) endpoint', () => {
    expect(resolveCustomEndpointSetup({
      baseUrl: undefined,
      credential: 'sk-anything',
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })
})

// New connections must persist a per-provider midStreamBehavior default so the
// per-connection submenu in Settings → AI shows a checkmark on the right item
// out of the box (no read-time fallback needed for fresh connections).
describe('createBuiltInConnection seeds midStreamBehavior', () => {
  // Both were 'queue' until 2026-08-17. Claude's steer is still an emulation via
  // the PreToolUse hook, but both of its arms were finally driven in the app
  // (`scripts/cdp/cases/str-1.ts`, `str-2.ts`) — and the undelivered arm turned
  // out to be LOSING the user's correction rather than merely wasting the turn's
  // tokens, which is what the old default's reasoning had assumed. Fixed, pinned,
  // then flipped.
  it("Anthropic API key → 'steer'", () => {
    const conn = createBuiltInConnection('anthropic-api')
    expect(conn.providerType).toBe('anthropic')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it("Claude Max OAuth → 'steer' (same Claude SDK backend)", () => {
    const conn = createBuiltInConnection('claude-max')
    expect(conn.providerType).toBe('anthropic')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it("ChatGPT Plus → 'steer' (Pi backend, native polite steer)", () => {
    const conn = createBuiltInConnection('chatgpt-plus')
    expect(conn.providerType).toBe('pi')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it('Nessy Gateway preset setup resolves to pi_compat with OpenAI routing', () => {
    const branch = resolveCustomEndpointSetup({
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      credential: 'jwt-token',
      customEndpointApi: 'openai-completions',
    })

    expect(branch).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it("Nessy Cloud Agent setup stays native A2A, not pi_compat or OpenAI-compatible", () => {
    const conn = createBuiltInConnection('nessy-cloud-agent')

    expect(conn.providerType).toBe('nestor-cloud-agent')
    expect(conn.authType).toBe('none')
    expect(conn.baseUrl).toBeUndefined()
    expect(conn.customEndpoint).toBeUndefined()
    expect(conn.piAuthProvider).toBeUndefined()
    expect(conn.defaultModel).toBe('nestor-cloud-code-agent')
    expect(JSON.stringify(conn)).not.toContain('/api/v1/cli/openai-like/v1')
  })

  it("Pi API key (Nessy Backend) → 'steer'", () => {
    const conn = createBuiltInConnection('pi-api-key')
    expect(conn.providerType).toBe('pi')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it("anthropic-api with custom endpoint becomes pi_compat → 'steer'", () => {
    const conn = createBuiltInConnection('anthropic-api', 'http://localhost:11434/v1')
    expect(conn.providerType).toBe('pi_compat')
    expect(conn.midStreamBehavior).toBe('steer')
  })
})

// T7 — the one-click Claude Code gateway card. The template row is the ONLY
// place that maps the `claude-gateway` slug onto `claude-runtime`; the endpoint,
// models and default model arrive in the SETUP payload
// (claudeGatewayConnectionDefaults), exactly like the codex row.
describe('createBuiltInConnection — claude-gateway (Claude Code runtime)', () => {
  const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

  it('maps the slug to claude-runtime with an endpoint-carrying auth type', () => {
    const conn = createBuiltInConnection('claude-gateway', GATEWAY_BASE_URL)

    expect(conn.providerType).toBe('claude-runtime')
    expect(conn.authType).toBe('api_key_with_endpoint')
    expect(conn.name).toBe('Claude Code (Nessy Gateway)')
    // Same ClaudeAgent backend as 'anthropic', and since 2026-08-17 the same
    // default: the emulation is still an emulation, but both of its arms are
    // proven in the app and the undelivered one no longer loses the message.
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it('does NOT mutate into pi_compat when a base URL is present (unlike anthropic-api)', () => {
    // `anthropic-api` upgrades to pi_compat behind a custom endpoint; the claude
    // card must keep its own provider type or the local adapter never starts.
    const withUrl = createBuiltInConnection('claude-gateway', GATEWAY_BASE_URL)
    const withoutUrl = createBuiltInConnection('claude-gateway')

    expect(withUrl.providerType).toBe('claude-runtime')
    expect(withoutUrl.providerType).toBe('claude-runtime')
  })

  it('seeds no catalog of its own — the endpoint owns the models', () => {
    const conn = createBuiltInConnection('claude-gateway', GATEWAY_BASE_URL)

    // A bundled ANTHROPIC_MODELS seed would hand the connection a
    // `claude-opus-*` default the gateway has never heard of.
    expect(conn.models).toEqual([])
    expect(conn.defaultModel).toBe('')
    expect(conn.modelSelectionMode).toBeUndefined()
    expect(conn.piAuthProvider).toBeUndefined()
  })

  it('keeps the derived-slug suffix path working (claude-gateway-2)', () => {
    const conn = createBuiltInConnection('claude-gateway-2', GATEWAY_BASE_URL)

    expect(conn.providerType).toBe('claude-runtime')
    expect(conn.name).toBe('Claude Code (Nessy Gateway) 2')
  })
})

// C3 — the BYO endpoint form's two templates. Separate slugs from the one-click
// gateway rows on purpose: those are upserted idempotently by the zero-form
// cards, so sharing a slug would let a BYO save overwrite the corp connection.
describe('createBuiltInConnection — BYO runtime endpoints (codex-custom / claude-custom)', () => {
  const BYO_BASE_URL = 'https://llm-proxy.internal.example.com/v1'

  const rows = [
    // Both steer, by different means: codex through the app-server's own
    // `turn/steer`, Claude by injecting into the model's next tool call. The
    // mechanisms stay different — Claude's can fail to deliver and re-queues when
    // it does — but the DEFAULT no longer differs, because that arm was measured
    // rather than assumed.
    { slug: 'codex-custom', providerType: 'codex-runtime', name: 'Codex (Custom Endpoint)', midStream: 'steer' },
    { slug: 'claude-custom', providerType: 'claude-runtime', name: 'Claude Code (Custom Endpoint)', midStream: 'steer' },
  ] as const

  for (const row of rows) {
    it(`maps ${row.slug} to ${row.providerType} with an endpoint-carrying auth type`, () => {
      const conn = createBuiltInConnection(row.slug, BYO_BASE_URL)

      expect(conn.providerType).toBe(row.providerType)
      expect(conn.authType).toBe('api_key_with_endpoint')
      expect(conn.name).toBe(row.name)
      expect(conn.midStreamBehavior).toBe(row.midStream)
    })

    it(`${row.slug} does NOT mutate into pi_compat behind a base URL`, () => {
      // The whole point of the row: `anthropic-api` upgrades to pi_compat when a
      // base URL is present, and a runtime connection that did the same would
      // never start its local adapter.
      expect(createBuiltInConnection(row.slug, BYO_BASE_URL).providerType).toBe(row.providerType)
      expect(createBuiltInConnection(row.slug).providerType).toBe(row.providerType)
    })

    it(`${row.slug} seeds no catalog of its own — the user's endpoint owns the models`, () => {
      const conn = createBuiltInConnection(row.slug, BYO_BASE_URL)

      expect(conn.models).toEqual([])
      expect(conn.defaultModel).toBe('')
      expect(conn.piAuthProvider).toBeUndefined()
      expect(conn.customEndpoint).toBeUndefined()
    })

    it(`${row.slug} keeps the derived-slug suffix path working`, () => {
      const conn = createBuiltInConnection(`${row.slug}-2`, BYO_BASE_URL)

      expect(conn.providerType).toBe(row.providerType)
      expect(conn.name).toBe(`${row.name} 2`)
    })

    it(`${row.slug} is a distinct template from the one-click gateway slug`, () => {
      expect(BUILT_IN_CONNECTION_TEMPLATES[row.slug]).toBeDefined()
      expect(row.slug).not.toBe('codex-gateway')
      expect(row.slug).not.toBe('claude-gateway')
    })
  }
})

describe('resolveAdapterRuntimeAuthType — explicit authType from the BYO endpoint form', () => {
  for (const providerType of ['codex-runtime', 'claude-runtime'] as const) {
    it(`honors none and api_key_with_endpoint for ${providerType}`, () => {
      expect(resolveAdapterRuntimeAuthType(providerType, 'none')).toBe('none')
      expect(resolveAdapterRuntimeAuthType(providerType, 'api_key_with_endpoint'))
        .toBe('api_key_with_endpoint')
    })
  }

  it('returns undefined when the payload asked for nothing', () => {
    expect(resolveAdapterRuntimeAuthType('codex-runtime', undefined)).toBeUndefined()
  })

  it('never applies an explicit authType to a non-runtime provider type', () => {
    // These flow through resolveCustomEndpointSetup / the provider branches
    // instead; an explicit authType from a stray payload must not override them.
    expect(resolveAdapterRuntimeAuthType('pi_compat', 'none')).toBeUndefined()
    expect(resolveAdapterRuntimeAuthType('anthropic', 'none')).toBeUndefined()
    expect(resolveAdapterRuntimeAuthType('pi', 'api_key_with_endpoint')).toBeUndefined()
  })
})

/**
 * E1 — the utility-model slot's server-side gate.
 *
 * The list it checks against is the POST-MERGE one (`{...connection,
 * ...updates}`), which is the whole point: an edit that changes only the
 * miniModel carries no `models`, and validating against the payload alone
 * would reject it.
 */
describe('validateMiniModel', () => {
  const models = ['deepseek-v3', 'deepseek-r1']

  it('accepts a model that is in the list', () => {
    expect(validateMiniModel('deepseek-r1', models)).toEqual({ valid: true })
  })

  it('rejects one that is not, and names it', () => {
    const result = validateMiniModel('gpt-4o-mini', models)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('gpt-4o-mini')
  })

  it('accepts when no utility model is set', () => {
    expect(validateMiniModel(undefined, models)).toEqual({ valid: true })
  })

  it('accepts against an absent or empty list rather than blocking a legal save', () => {
    // The Pi `automaticallySyncedFromProvider` path: the server installs the
    // catalog after this point, so there is nothing to check against yet.
    expect(validateMiniModel('deepseek-r1', undefined)).toEqual({ valid: true })
    expect(validateMiniModel('deepseek-r1', [])).toEqual({ valid: true })
  })

  it('reads ModelDefinition entries by id, not by identity', () => {
    const defs = [{ id: 'deepseek-v3' }, { id: 'deepseek-r1' }] as Array<{ id: string }>
    expect(validateMiniModel('deepseek-r1', defs as never)).toEqual({ valid: true })
    expect(validateMiniModel('deepseek-x', defs as never).valid).toBe(false)
  })
})

// F1.202 — the ChatGPT (Codex) card's connection: codex-runtime on the user's
// ChatGPT sign-in, declaring codex's OWN `openai` provider, seeded with codex's
// own catalogue (an adapter-runtime template otherwise seeds no models at all).
describe("createBuiltInConnection — chatgpt-codex (codex's own provider on the ChatGPT subscription)", () => {
  it('declares the openai provider, signs in by oauth, and carries codex\'s catalogue', () => {
    const conn = createBuiltInConnection('chatgpt-codex')
    expect(conn.name).toBe('ChatGPT (Codex)')
    expect(conn.providerType).toBe('codex-runtime')
    expect(conn.authType).toBe('oauth')
    expect(conn.codexModelProvider).toBe('openai')
    expect(conn.baseUrl).toBeUndefined()
    const ids = (conn.models ?? []).map(model => (typeof model === 'string' ? model : model.id))
    expect(ids[0]).toBe(conn.defaultModel)
    expect(ids).toContain('gpt-6-sol')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it('the other codex templates declare nothing — the control', () => {
    for (const slug of ['codex-gateway', 'codex-custom']) {
      const conn = createBuiltInConnection(slug)
      expect(conn.codexModelProvider).toBeUndefined()
      expect(conn.models).toEqual([])
    }
    expect(BUILT_IN_CONNECTION_TEMPLATES['chatgpt-plus']?.providerType).toBe('pi')
  })
})

describe('resolveSetupTestApiKey (UB3.4 — the masked key resolves to the stored credential)', () => {
  const storedLookup = async (slug: string): Promise<string | null> =>
    slug === 'conn-with-key' ? 'sk-live-abcdef1234567890' : null

  it('positive: a masked placeholder with a slug resolves to the stored key', async () => {
    const result = await resolveSetupTestApiKey(
      { apiKey: 'sk-ab••••••••7890', connectionSlug: 'conn-with-key', allowEmptyApiKey: false },
      storedLookup,
    )
    expect(result).toEqual({ ok: true, apiKey: 'sk-live-abcdef1234567890', source: 'stored' })
  })

  it('negative control: a masked placeholder without a slug asks for the key', async () => {
    const result = await resolveSetupTestApiKey(
      { apiKey: 'sk-ab••••••••7890', allowEmptyApiKey: false },
      storedLookup,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('Re-enter the API key to test this connection.')
      // No key material in the refusal — nothing of the store leaks to the UI.
      expect(result.error).not.toContain('sk-live')
    }
  })

  it('negative control: a masked placeholder whose slug has no stored key asks for the key (a foreign or deleted slug resolves to nothing)', async () => {
    const result = await resolveSetupTestApiKey(
      { apiKey: 'sk-ab••••••••7890', connectionSlug: 'some-other-connection', allowEmptyApiKey: false },
      storedLookup,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('No API key is stored for this connection. Re-enter the key to test it.')
      expect(result.error).not.toContain('sk-live')
    }
  })

  it('a typed key wins over the stored one (the create path, and a re-keyed edit)', async () => {
    const result = await resolveSetupTestApiKey(
      { apiKey: '  sk-brand-new-key  ', connectionSlug: 'conn-with-key', allowEmptyApiKey: false },
      storedLookup,
    )
    expect(result).toEqual({ ok: true, apiKey: 'sk-brand-new-key', source: 'input' })
  })

  it('an empty field with a slug resolves to the stored key too (our catalog-path rule, kept)', async () => {
    const result = await resolveSetupTestApiKey(
      { apiKey: '', connectionSlug: 'conn-with-key', allowEmptyApiKey: false },
      storedLookup,
    )
    expect(result).toEqual({ ok: true, apiKey: 'sk-live-abcdef1234567890', source: 'stored' })
  })

  it('an empty field without a slug behaves as before', async () => {
    const required = await resolveSetupTestApiKey(
      { apiKey: '', allowEmptyApiKey: false },
      storedLookup,
    )
    expect(required).toEqual({ ok: false, error: 'API key is required' })

    const loopback = await resolveSetupTestApiKey(
      { apiKey: '', allowEmptyApiKey: true },
      storedLookup,
    )
    expect(loopback).toEqual({ ok: true, apiKey: '', source: 'input' })
  })

  it('maskApiKey is the one producer of masked values, and isMaskedApiKey agrees with it', () => {
    const long = maskApiKey('sk-ant-prefix-abcdef1234567890')
    expect(long).toBe('sk-ant-••••••••7890')
    expect(maskApiKey('short')).toBe(API_KEY_MASK)
    expect(isMaskedApiKey(long)).toBe(true)
    expect(isMaskedApiKey('sk-live-abcdef1234567890')).toBe(false)
    expect(isMaskedApiKey(null)).toBe(false)
  })
})
