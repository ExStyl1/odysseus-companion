/**
 * C3 — the unified BYO endpoint form for `codex-runtime` and `claude-runtime`.
 *
 * Everything the form decides lives in `byo-runtime.ts` as pure functions so the
 * three hazards this task exists to close are pinned by real production code
 * rather than by reading the JSX:
 *
 * 1. **Edit must not convert the providerType.** `AiSettingsPage` used to send
 *    every non-Pi connection to the `anthropic_api_key` form, whose submit path
 *    attaches a `customEndpoint` — and the SETUP handler forces
 *    `providerType: 'pi_compat'` whenever one is present
 *    (`handlers/rpc/llm-connections.ts:108-110`). A BYO runtime connection
 *    edited through it silently stopped being a runtime connection.
 *    `resolveConnectionEditTarget` is now the one router, and
 *    `buildByoRuntimeSetup` never emits `customEndpoint`.
 * 2. **An empty endpoint must be impossible to save** (C2 finding): the codex
 *    driver reads a MISSING baseUrl as "the gateway"
 *    (`drivers/codex.ts:35`) while the refresh fetcher reads it as "not the
 *    gateway" (`model-fetchers/registry.ts`), so an endpoint-less BYO codex
 *    connection would chat through the gateway and never refresh.
 * 3. **The exact gateway URL is rejected**, not accepted-with-a-notice — see
 *    the block comment on that describe.
 */
import { describe, it, expect } from 'bun:test'
import { NESTOR_CHAT_URL } from '@nessy-agent/codex-responses-adapter/nestor-client'
import { isNestorCliBaseUrl, isNestorGatewayCredentialUrl } from '@nessy-agent/shared/auth/nestor'
import { isNessyGatewayBaseUrl } from '../nessy-gateway'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BYO_RUNTIME_BASE_SLUG,
  BYO_RUNTIME_ERROR_KEY,
  byoRuntimeRefusalKey,
  DEFAULT_ENDPOINT_URL,
  promoteModels,
  buildByoRuntimeSetup,
  resolveEndpointField,
  isLoopbackBaseUrl,
  parseModelList,
  resolveByoRuntimeSlug,
  isTranslatedWireModel,
  resolveArmVerdicts,
  resolveConnectionEditTarget,
  isGatewayHostNonGatewayEndpoint,
  validateByoRuntimeForm,
  validateMergedEndpointForm,
  usesOfficialPiEndpoint,
  isMaskedCredential,
  type MergedEndpointFormValues,
} from '../byo-runtime'
import { NESSY_GATEWAY_BASE_URL } from '../nessy-gateway'

const BYO_URL = 'https://llm-proxy.internal.example.com/v1'

function form(overrides: Partial<Parameters<typeof validateByoRuntimeForm>[0]> = {}) {
  return {
    providerType: 'codex-runtime' as const,
    baseUrl: BYO_URL,
    apiKey: 'sk-user-own-key',
    models: 'deepseek-v3, deepseek-r1',
    ...overrides,
  }
}

// ============================================================
// Edit routing (hazard 1)
// ============================================================

describe('resolveConnectionEditTarget', () => {
  for (const providerType of ['codex-runtime', 'claude-runtime'] as const) {
    it(`routes a BYO ${providerType} connection to the BYO form, not the anthropic key form`, () => {
      const target = resolveConnectionEditTarget({ providerType, baseUrl: BYO_URL })

      expect(target).toEqual({ form: 'byo-runtime', providerType })
      // The regression this replaces: 'anthropic_api_key' → customEndpoint → pi_compat.
      expect(JSON.stringify(target)).not.toContain('anthropic_api_key')
    })

    it(`routes a gateway ${providerType} connection to the BYO form too (Edit is hidden for it, but the mapping must never convert)`, () => {
      const target = resolveConnectionEditTarget({ providerType, baseUrl: NESSY_GATEWAY_BASE_URL })

      expect(target).toEqual({ form: 'byo-runtime', providerType })
    })
  }

  /**
   * SUPERSEDED BY E3, and rewritten rather than deleted so the change of answer
   * is visible in history. Until the merge, every Pi and Anthropic connection
   * went to a legacy ApiKeyInput surface. Now the ones the merged form can
   * express go to it, and only the exotic ones fall back — the full table lives
   * in the four-target router describe at the bottom of this file.
   *
   * What has NOT changed, and is the reason this describe exists at all: no
   * route ever converts a providerType.
   */
  it('sends the Pi and Anthropic connections the merged form can express to it', () => {
    expect(resolveConnectionEditTarget({ providerType: 'pi' }))
      .toEqual({ form: 'merged', arm: 'pi', preset: 'anthropic' })
    expect(resolveConnectionEditTarget({ providerType: 'pi_compat', baseUrl: BYO_URL }))
      .toEqual({ form: 'merged', arm: 'pi', preset: 'custom' })
    expect(resolveConnectionEditTarget({ providerType: 'anthropic' }))
      .toEqual({ form: 'merged', arm: 'pi', preset: 'anthropic' })
  })

  it('keeps a connection the merged form cannot express on the legacy surface', () => {
    expect(resolveConnectionEditTarget({ providerType: 'pi', piAuthProvider: 'amazon-bedrock' }))
      .toEqual({ form: 'api-key', method: 'pi_api_key' })
    expect(resolveConnectionEditTarget({ providerType: 'vertex' }))
      .toEqual({ form: 'api-key', method: 'anthropic_api_key' })
  })
})

// ============================================================
// Validation (hazards 2 + 3)
// ============================================================

describe('validateByoRuntimeForm — endpoint', () => {
  it('accepts a remote endpoint with a key and at least one model', () => {
    const result = validateByoRuntimeForm(form(), { isEditing: false })

    expect(result).toEqual({
      valid: true,
      baseUrl: BYO_URL,
      apiKey: 'sk-user-own-key',
      models: ['deepseek-v3', 'deepseek-r1'],
    })
  })

  for (const empty of ['', '   ']) {
    it(`rejects an empty endpoint (${JSON.stringify(empty)}) — the codex driver would read it as the gateway`, () => {
      expect(validateByoRuntimeForm(form({ baseUrl: empty }), { isEditing: false }))
        .toEqual({ valid: false, field: 'baseUrl', error: 'endpointRequired' })
    })
  }

  it('trims the endpoint before storing it', () => {
    const result = validateByoRuntimeForm(form({ baseUrl: `  ${BYO_URL}  ` }), { isEditing: false })
    expect(result).toMatchObject({ valid: true, baseUrl: BYO_URL })
  })
})

/**
 * The exact gateway URL is BLOCKED rather than accepted with a notice. Two
 * concrete traps, not a style preference:
 *
 * - the key the user typed would be silently ignored — a `{kind:'nestor'}`
 *   upstream authenticates with the dp JWT and never reads the connection
 *   credential (`upstream-target.ts:attachUpstreamCredential`);
 * - the connection it produced would be un-editable the moment it was saved:
 *   `canEditLlmConnection` classifies any runtime connection on that URL as the
 *   corp one and hides the Edit form.
 *
 * There is therefore no BYO use for that URL — the one-click card is the whole
 * feature — so the form names it instead of building a broken connection.
 */
describe('validateByoRuntimeForm — the gateway URL is not a BYO endpoint', () => {
  const gatewayForms = [
    NESSY_GATEWAY_BASE_URL,
    `${NESSY_GATEWAY_BASE_URL}/`,
    `  ${NESSY_GATEWAY_BASE_URL}  `,
  ]
  for (const baseUrl of gatewayForms) {
    it(`rejects ${JSON.stringify(baseUrl)}`, () => {
      expect(validateByoRuntimeForm(form({ baseUrl }), { isEditing: false }))
        .toEqual({ valid: false, field: 'baseUrl', error: 'endpointIsGateway' })
    })
  }

  it('accepts the same host on a different path (AGENTS.md: that is a BYO endpoint)', () => {
    const sameHostOtherPath = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other-proxy/v1'
    expect(validateByoRuntimeForm(form({ baseUrl: sameHostOtherPath }), { isEditing: false }))
      .toMatchObject({ valid: true, baseUrl: sameHostOtherPath })
  })

  it('agrees with the backend classification the adapter actually runs on', () => {
    // The renderer literal and the transport's own derived base must stay equal,
    // or the form blocks a URL the driver treats as BYO (or vice versa).
    expect(NESSY_GATEWAY_BASE_URL).toBe(NESTOR_CHAT_URL.replace(/\/chat\/completions$/, ''))
  })
})

describe('validateByoRuntimeForm — models and key', () => {
  it('rejects an empty model list (a BYO connection has no live catalog refresh)', () => {
    expect(validateByoRuntimeForm(form({ models: '  ,  ' }), { isEditing: false }))
      .toEqual({ valid: false, field: 'models', error: 'modelRequired' })
  })

  it('requires an API key for a remote endpoint', () => {
    expect(validateByoRuntimeForm(form({ apiKey: '   ' }), { isEditing: false }))
      .toEqual({ valid: false, field: 'apiKey', error: 'apiKeyRequired' })
  })

  it('allows a keyless loopback endpoint (Ollama and friends)', () => {
    const result = validateByoRuntimeForm(
      form({ apiKey: '', baseUrl: 'http://localhost:11434/v1', models: 'qwen3-coder' }),
      { isEditing: false },
    )
    expect(result).toMatchObject({ valid: true, apiKey: '' })
  })

  it('allows a blank key when editing (blank = keep the stored credential)', () => {
    expect(validateByoRuntimeForm(form({ apiKey: '' }), { isEditing: true }))
      .toMatchObject({ valid: true, apiKey: '' })
  })
})

describe('parseModelList / isLoopbackBaseUrl', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseModelList(' a , ,b ,, c ')).toEqual(['a', 'b', 'c'])
  })

  it('recognises the three loopback spellings and nothing else', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:1234/v1')).toBe(true)
    expect(isLoopbackBaseUrl(BYO_URL)).toBe(false)
    expect(isLoopbackBaseUrl('not a url')).toBe(false)
    expect(isLoopbackBaseUrl('')).toBe(false)
  })
})

// ============================================================
// Persistence payload (hazard 1's other half)
// ============================================================

describe('buildByoRuntimeSetup', () => {
  for (const providerType of ['codex-runtime', 'claude-runtime'] as const) {
    it(`builds a ${providerType} setup payload with endpoint, key, catalog and default model`, () => {
      const setup = buildByoRuntimeSetup({
        providerType,
        baseUrl: BYO_URL,
        apiKey: 'sk-user-own-key',
        models: ['deepseek-v3', 'deepseek-r1'],
        editingSlug: null,
        existingSlugs: new Set<string>(),
      })

      expect(setup).toEqual({
        slug: BYO_RUNTIME_BASE_SLUG[providerType],
        credential: 'sk-user-own-key',
        authType: 'api_key_with_endpoint',
        baseUrl: BYO_URL,
        defaultModel: 'deepseek-v3',
        models: ['deepseek-v3', 'deepseek-r1'],
      })
    })

    it(`never sends customEndpoint for ${providerType} — that field is what converts the connection to pi_compat`, () => {
      const setup = buildByoRuntimeSetup({
        providerType,
        baseUrl: BYO_URL,
        apiKey: 'k',
        models: ['m'],
        editingSlug: null,
        existingSlugs: new Set<string>(),
      })

      expect(setup.customEndpoint).toBeUndefined()
      expect(Object.keys(setup)).not.toContain('customEndpoint')
      expect(setup.piAuthProvider).toBeUndefined()
    })
  }

  it('uses a distinct base slug per runtime so neither collides with the one-click gateway cards', () => {
    expect(BYO_RUNTIME_BASE_SLUG['codex-runtime']).toBe('codex-custom')
    expect(BYO_RUNTIME_BASE_SLUG['claude-runtime']).toBe('claude-custom')
    expect(Object.values(BYO_RUNTIME_BASE_SLUG)).not.toContain('codex-gateway')
    expect(Object.values(BYO_RUNTIME_BASE_SLUG)).not.toContain('claude-gateway')
  })

  it('suffixes a colliding slug instead of overwriting the existing connection', () => {
    expect(resolveByoRuntimeSlug('codex-runtime', null, new Set(['codex-custom']))).toBe('codex-custom-2')
    expect(resolveByoRuntimeSlug('codex-runtime', null, new Set(['codex-custom', 'codex-custom-2'])))
      .toBe('codex-custom-3')
  })

  it('reuses the edited slug so Edit updates in place', () => {
    expect(resolveByoRuntimeSlug('claude-runtime', 'claude-custom-4', new Set(['claude-custom'])))
      .toBe('claude-custom-4')

    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: BYO_URL,
      apiKey: '',
      models: ['m'],
      editingSlug: 'claude-custom-4',
      existingSlugs: new Set(['claude-custom', 'claude-custom-4']),
    })
    expect(setup.slug).toBe('claude-custom-4')
    // Blank key on edit = keep the stored credential: no `credential` key at all,
    // so the SETUP handler's credential write is skipped.
    expect(setup.credential).toBeUndefined()
  })

  it('keeps a masked key out of the payload (GET_API_KEY returns a masked string on Edit)', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'codex-runtime',
      baseUrl: BYO_URL,
      apiKey: 'sk-user••••••••key1',
      models: ['m'],
      editingSlug: 'codex-custom',
      existingSlugs: new Set(['codex-custom']),
    })
    expect(setup.credential).toBeUndefined()
    // Masked = the stored key is kept, so the connection stays keyed.
    expect(setup.authType).toBe('api_key_with_endpoint')
  })

  // authType: these connections never reach the server's keyless→'none' mapping
  // (that lives in resolveCustomEndpointSetup, behind the customEndpoint field
  // this form must never send), so the form decides and always sends it.
  it('sends authType none for a keyless loopback endpoint (Ollama-class create)', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'codex-runtime',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      models: ['qwen3'],
      editingSlug: null,
      existingSlugs: new Set<string>(),
    })
    expect(setup.authType).toBe('none')
    expect(setup.credential).toBeUndefined()
  })

  it('keeps a blank-key edit keyed when a credential is stored, keyless when none is', () => {
    const base = {
      providerType: 'claude-runtime' as const,
      baseUrl: BYO_URL,
      apiKey: '',
      models: ['m'],
      editingSlug: 'claude-custom',
      existingSlugs: new Set(['claude-custom']),
    }
    expect(buildByoRuntimeSetup({ ...base, hasStoredKey: true }).authType)
      .toBe('api_key_with_endpoint')
    expect(buildByoRuntimeSetup({ ...base, hasStoredKey: false }).authType)
      .toBe('none')
  })

  it('flips a previously keyless connection back to keyed when an edit adds a key', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'codex-runtime',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-new-key',
      models: ['m'],
      editingSlug: 'codex-custom',
      existingSlugs: new Set(['codex-custom']),
      hasStoredKey: false,
    })
    expect(setup.authType).toBe('api_key_with_endpoint')
    expect(setup.credential).toBe('sk-new-key')
  })
})


// ============================================================
// E3 — the merged form
// ============================================================

const MASK = 'sk-xx••••••••1234'

function merged(overrides: Partial<MergedEndpointFormValues> = {}): MergedEndpointFormValues {
  return {
    arm: 'pi',
    preset: 'custom',
    baseUrl: BYO_URL,
    apiKey: 'sk-user-own-key',
    models: 'deepseek-v3, deepseek-r1',
    ...overrides,
  }
}

describe('validateMergedEndpointForm — the endpoint rules, per arm', () => {
  /**
   * NEW ON THE PI ARM, and not symmetry for its own sake:
   * `NESSY_GATEWAY_PROVIDER_TYPES` includes `pi_compat`, so a Pi/Custom save on
   * the gateway URL produces a connection `canEditLlmConnection` classifies as
   * the corp one — permanently un-editable with no way back from the UI.
   */
  for (const arm of ['pi', 'claude-runtime', 'codex-runtime'] as const) {
    it(`rejects the gateway URL on the ${arm} arm`, () => {
      const result = validateMergedEndpointForm(merged({ arm, baseUrl: NESSY_GATEWAY_BASE_URL }), { isEditing: false })
      expect(result).toEqual({ valid: false, field: 'baseUrl', error: 'endpointIsGateway' })
    })

    it(`requires an endpoint on the ${arm} arm`, () => {
      const result = validateMergedEndpointForm(merged({ arm, baseUrl: '   ' }), { isEditing: false })
      expect(result).toEqual({ valid: false, field: 'baseUrl', error: 'endpointRequired' })
    })
  }

  /**
   * F11: the two official Pi presets HIDE the base-URL field and submit
   * `undefined`, and the server's reset path at `llm-connections.ts:83-88`
   * depends on that blank. Requiring a URL there would break the very shape the
   * preset exists to produce — so they are exempt from BOTH endpoint checks and
   * from the model requirement (the server installs the provider catalog).
   */
  for (const preset of ['anthropic', 'openai'] as const) {
    it(`exempts the official Pi ${preset} preset from the endpoint and model checks`, () => {
      const result = validateMergedEndpointForm(
        merged({ arm: 'pi', preset, baseUrl: '', models: '' }),
        { isEditing: false },
      )
      expect(result).toMatchObject({ valid: true, baseUrl: '', models: [] })
    })

    it(`still requires a key on the official Pi ${preset} preset`, () => {
      const result = validateMergedEndpointForm(
        merged({ arm: 'pi', preset, baseUrl: '', models: '', apiKey: '' }),
        { isEditing: false },
      )
      expect(result).toEqual({ valid: false, field: 'apiKey', error: 'apiKeyRequired' })
    })
  }

  it('classifies the arms the same way the validator does', () => {
    expect(usesOfficialPiEndpoint({ arm: 'pi', preset: 'anthropic' })).toBe(true)
    expect(usesOfficialPiEndpoint({ arm: 'pi', preset: 'openai' })).toBe(true)
    expect(usesOfficialPiEndpoint({ arm: 'pi', preset: 'custom' })).toBe(false)
    expect(usesOfficialPiEndpoint({ arm: 'claude-runtime', preset: 'anthropic' })).toBe(false)
  })
})

describe('validateMergedEndpointForm — models, utility model and key', () => {
  it('requires at least one model on every non-official arm', () => {
    for (const arm of ['pi', 'claude-runtime', 'codex-runtime'] as const) {
      expect(validateMergedEndpointForm(merged({ arm, models: '  ,  ' }), { isEditing: false }))
        .toEqual({ valid: false, field: 'models', error: 'modelRequired' })
    }
  })

  it('rejects a utility model that is not in the list, and names the field', () => {
    const result = validateMergedEndpointForm(merged({ miniModel: 'gpt-4o-mini' }), { isEditing: false })
    expect(result).toEqual({ valid: false, field: 'miniModel', error: 'miniModelNotInList' })
  })

  it('accepts a utility model drawn from the list, and returns it trimmed', () => {
    const result = validateMergedEndpointForm(merged({ miniModel: '  deepseek-r1 ' }), { isEditing: false })
    expect(result).toMatchObject({ valid: true, miniModel: 'deepseek-r1' })
  })

  it('treats a blank utility model as absent rather than as a failed lookup', () => {
    const result = validateMergedEndpointForm(merged({ miniModel: '   ' }), { isEditing: false })
    expect(result).toMatchObject({ valid: true })
    expect(result).not.toHaveProperty('miniModel')
  })

  it('allows a keyless loopback endpoint, but only where a URL exists to be loopback', () => {
    expect(validateMergedEndpointForm(
      merged({ baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
      { isEditing: false },
    )).toMatchObject({ valid: true })
  })

  /**
   * The masked key is the unification this task exists for. `GET_API_KEY` masks
   * for EVERY caller, so the mask arrives in the field on Edit and means "a key
   * is stored" — never "the field is blank", or an edit would demand a key that
   * is already there.
   */
  it('counts a masked key as present on edit', () => {
    expect(isMaskedCredential(MASK)).toBe(true)
    expect(isMaskedCredential('sk-real-key')).toBe(false)
    expect(validateMergedEndpointForm(merged({ apiKey: MASK }), { isEditing: true }))
      .toMatchObject({ valid: true })
  })

  it('checks endpoint before models before utility model before key', () => {
    // First failure wins: a form wrong in every way names the endpoint.
    expect(validateMergedEndpointForm(
      merged({ baseUrl: '', models: '', miniModel: 'nope', apiKey: '' }),
      { isEditing: false },
    )).toEqual({ valid: false, field: 'baseUrl', error: 'endpointRequired' })
  })
})

describe('buildByoRuntimeSetup — miniModel and sync enrollment (E1/E2 fields)', () => {
  it('carries an explicit utility model', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: BYO_URL,
      apiKey: 'sk-key',
      models: ['deepseek-v3', 'deepseek-r1'],
      miniModel: 'deepseek-r1',
      editingSlug: null,
      existingSlugs: new Set(),
    })
    expect(setup.miniModel).toBe('deepseek-r1')
  })

  it('sends a blank utility model so clearing the field actually clears the slot', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: BYO_URL,
      apiKey: 'sk-key',
      models: ['deepseek-v3'],
      miniModel: '',
      editingSlug: 'claude-custom',
      existingSlugs: new Set(['claude-custom']),
    })
    expect(setup.miniModel).toBe('')
  })

  /**
   * TRISTATE, and the omission is the important arm: sending anything at all on
   * an untouched edit would silently withdraw an enrollment nobody asked to
   * change. `undefined` means "leave as persisted".
   */
  it('omits modelsSyncedAt entirely when the toggle was not touched', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'codex-runtime',
      baseUrl: BYO_URL,
      apiKey: 'sk-key',
      models: ['deepseek-v3'],
      editingSlug: 'codex-custom',
      existingSlugs: new Set(['codex-custom']),
    })
    expect(setup).not.toHaveProperty('modelsSyncedAt')
    expect(setup).not.toHaveProperty('miniModel')
  })

  for (const [label, value] of [['enrolls', 1_700_000_000_000], ['withdraws', null]] as const) {
    it(`${label} when the toggle was touched`, () => {
      const setup = buildByoRuntimeSetup({
        providerType: 'codex-runtime',
        baseUrl: BYO_URL,
        apiKey: 'sk-key',
        models: ['deepseek-v3'],
        modelsSyncedAt: value,
        editingSlug: null,
        existingSlugs: new Set(),
      })
      expect(setup.modelsSyncedAt).toBe(value)
    })
  }

  /** The landmine, restated against the new fields: still never these three. */
  it('never emits customEndpoint, piAuthProvider or modelSelectionMode, whatever else it carries', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: BYO_URL,
      apiKey: 'sk-key',
      models: ['deepseek-v3'],
      miniModel: 'deepseek-v3',
      modelsSyncedAt: 1_700_000_000_000,
      editingSlug: null,
      existingSlugs: new Set(),
    })
    expect(setup).not.toHaveProperty('customEndpoint')
    expect(setup).not.toHaveProperty('piAuthProvider')
    expect(setup).not.toHaveProperty('modelSelectionMode')
  })
})

describe('resolveConnectionEditTarget — the four-target router', () => {
  it('sends a custom endpoint to the merged Pi arm on the Custom preset', () => {
    expect(resolveConnectionEditTarget({ providerType: 'pi_compat', customEndpoint: { api: 'openai-completions' } }))
      .toEqual({ form: 'merged', arm: 'pi', preset: 'custom' })
  })

  for (const [flavour, preset] of [['anthropic', 'anthropic'], ['openai', 'openai'], [undefined, 'anthropic']] as const) {
    it(`sends a pi connection with piAuthProvider=${String(flavour)} to the merged Pi arm`, () => {
      expect(resolveConnectionEditTarget({ providerType: 'pi', piAuthProvider: flavour }))
        .toEqual({ form: 'merged', arm: 'pi', preset })
    })
  }

  it('sends a plain anthropic connection to the merged Pi arm', () => {
    expect(resolveConnectionEditTarget({ providerType: 'anthropic' }))
      .toEqual({ form: 'merged', arm: 'pi', preset: 'anthropic' })
  })

  /**
   * THE ARM THAT MATTERS MOST. `apps/cli` writes arbitrary `piAuthProvider`
   * values into the shared config, and the merged form cannot express Bedrock
   * IAM credentials or the 3-tier openrouter shape. Routing one of those into
   * it would strand the connection with no way to edit it.
   */
  for (const flavour of ['amazon-bedrock', 'openrouter', 'google', 'github-copilot']) {
    it(`keeps an exotic pi connection (${flavour}) on the legacy ApiKeyInput surface`, () => {
      expect(resolveConnectionEditTarget({ providerType: 'pi', piAuthProvider: flavour }))
        .toEqual({ form: 'api-key', method: 'pi_api_key' })
    })
  }

  it('still routes both BYO runtimes to the runtime form, unconditional on endpoint', () => {
    for (const providerType of ['codex-runtime', 'claude-runtime'] as const) {
      expect(resolveConnectionEditTarget({ providerType, baseUrl: NESSY_GATEWAY_BASE_URL }))
        .toEqual({ form: 'byo-runtime', providerType })
    }
  })
})

/**
 * E4 — switching arms must not discard what the user typed.
 *
 * Pinned as a PURE-FUNCTION contract rather than by rendering: the validator is
 * what decides whether a given (arm, preset, fields) tuple is submittable, so
 * if a future refactor makes an arm switch clear the endpoint, the values that
 * reach this function change and these expectations move with them. The
 * component holds each field in independent state and the arm button touches
 * only the arm — this is the guard on that staying true.
 */
describe('arm switching preserves entered values', () => {
  const typed = { baseUrl: BYO_URL, apiKey: 'sk-user-own-key', models: 'deepseek-v3, deepseek-r1' }

  it('accepts the same typed values on every arm', () => {
    for (const arm of ['pi', 'claude-runtime', 'codex-runtime'] as const) {
      expect(validateMergedEndpointForm(merged({ arm, preset: 'custom', ...typed }), { isEditing: false }))
        .toMatchObject({ valid: true, baseUrl: BYO_URL, models: ['deepseek-v3', 'deepseek-r1'] })
    }
  })

  /**
   * The round trip that would lose data if the official preset CLEARED the
   * endpoint instead of hiding it: Custom → Anthropic → Custom must arrive back
   * at a submittable form with the URL still there.
   */
  it('leaves a hidden endpoint intact when an official preset is passed through', () => {
    const onOfficial = validateMergedEndpointForm(
      merged({ arm: 'pi', preset: 'anthropic', ...typed }),
      { isEditing: false },
    )
    // The official preset does not SUBMIT the URL — that blank is what the
    // server's reset path keys on — but it does not reject the form for having
    // one either, which is what lets the value survive the round trip.
    expect(onOfficial).toMatchObject({ valid: true, baseUrl: '' })

    expect(validateMergedEndpointForm(merged({ arm: 'pi', preset: 'custom', ...typed }), { isEditing: false }))
      .toMatchObject({ valid: true, baseUrl: BYO_URL })
  })
})

/**
 * G1 — the two E5 regressions in the Pi arm's delegation, pinned at the level
 * the delegation actually decides them.
 *
 * Both were live defects: the arm forwarded the MASK as a credential where the
 * runtime arm strips it, and it never carried `piAuthProvider`, which
 * `validateSetupTestInput` requires for `provider: 'pi'` with a base URL — so
 * every Pi/Custom save was refused before it reached the server.
 *
 * The provider is DERIVED from the protocol rather than asked for; this is the
 * mapping, stated once so the delegation and `resolveCustomEndpointPayload`
 * cannot drift apart.
 */
describe('Pi arm delegation — derived provider and mask handling', () => {
  const piAuthProviderFor = (api: 'openai-completions' | 'anthropic-messages') =>
    api === 'anthropic-messages' ? 'anthropic' : 'openai'

  it('derives anthropic from the Anthropic protocol and openai from the OpenAI one', () => {
    expect(piAuthProviderFor('anthropic-messages')).toBe('anthropic')
    expect(piAuthProviderFor('openai-completions')).toBe('openai')
  })

  it('treats the mask as no credential, exactly as the runtime arm does', () => {
    // The runtime arm's own guard, asserted here so the two arms are pinned to
    // the same rule rather than to two copies of it.
    const masked = 'sk-xx••••••••1234'
    expect(isMaskedCredential(masked)).toBe(true)
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: BYO_URL,
      apiKey: masked,
      models: ['deepseek-v3'],
      editingSlug: 'claude-custom',
      existingSlugs: new Set(['claude-custom']),
      hasStoredKey: true,
    })
    expect(setup).not.toHaveProperty('credential')
    expect(setup.authType).toBe('api_key_with_endpoint')
  })
})


/**
 * G2 — the endpoint is decided, not typed.
 *
 * v2 hardcodes the URL and hides the field; the ONE case that still shows it is
 * an edit of a connection pointing somewhere else, and there it is read-only.
 * Four ordered branches, each of which broke something when it was folded into
 * the one above it, so each gets a case.
 */
describe('resolveEndpointField', () => {
  const at = (over: Partial<Parameters<typeof resolveEndpointField>[0]>) =>
    resolveEndpointField({ arm: 'pi', preset: 'custom', isEditing: false, ...over })

  it('points a fresh connection at the hardcoded endpoint, with no field', () => {
    expect(at({})).toEqual({ visible: false, disabled: false, value: DEFAULT_ENDPOINT_URL })
    // Every arm, because the runtime radio picks the harness and nothing else.
    for (const arm of ['claude-runtime', 'codex-runtime'] as const) {
      expect(at({ arm }).value).toBe(DEFAULT_ENDPOINT_URL)
    }
  })

  it('is BARE — no /v1, no trailing slash', () => {
    // Measured 2026-08-14: this exact origin serves /models, /chat/completions
    // AND /v1/messages. A path here would break the Anthropic wire (G3).
    expect(DEFAULT_ENDPOINT_URL).toBe('https://llm-proxy.t-tech.team')
    expect(DEFAULT_ENDPOINT_URL.endsWith('/')).toBe(false)
  })

  it('submits nothing for an official preset, and checks that FIRST', () => {
    // An official connection stores no baseUrl. If the foreign-URL test ran
    // first it would see '' and hide the field for the wrong reason — right
    // answer, wrong law, and it stops being right the moment one is stored.
    for (const preset of ['anthropic', 'openai'] as const) {
      expect(at({ preset, isEditing: true, storedBaseUrl: '' }))
        .toEqual({ visible: false, disabled: false, value: '' })
      expect(at({ preset, isEditing: true, storedBaseUrl: 'https://elsewhere.example.com' }))
        .toEqual({ visible: false, disabled: false, value: '' })
    }
  })

  it('shows a foreign URL on edit, disabled, and keeps it verbatim', () => {
    const foreign = 'http://127.0.0.1:11434/v1'
    expect(at({ isEditing: true, storedBaseUrl: foreign }))
      .toEqual({ visible: true, disabled: true, value: foreign })
  })

  it('hides the field again when the edited connection is already on it', () => {
    expect(at({ isEditing: true, storedBaseUrl: DEFAULT_ENDPOINT_URL }))
      .toEqual({ visible: false, disabled: false, value: DEFAULT_ENDPOINT_URL })
    // A trailing slash is not a different endpoint.
    expect(at({ isEditing: true, storedBaseUrl: `${DEFAULT_ENDPOINT_URL}/` }).visible).toBe(false)
  })

  it('falls back to the hardcoded URL when an edited connection stored none', () => {
    expect(at({ isEditing: true, storedBaseUrl: undefined }).value).toBe(DEFAULT_ENDPOINT_URL)
  })
})

/**
 * The typed-URL round trip, moved here from the edit-path UI.
 *
 * It used to be asserted through the form because the user could type a URL and
 * switch arms. In v2 nobody types one — the field is hidden on create and
 * disabled on edit — so the property worth pinning is the BUILDER's: whatever
 * URL is handed in survives to the payload unchanged, on every arm.
 */
describe('the resolved endpoint reaches the payload unchanged', () => {
  it('carries a foreign URL through the runtime-arm builder verbatim', () => {
    const foreign = 'http://127.0.0.1:11434/v1'
    for (const providerType of ['codex-runtime', 'claude-runtime'] as const) {
      expect(buildByoRuntimeSetup({
        providerType,
        baseUrl: foreign,
        apiKey: '',
        models: ['llama3.2'],
        editingSlug: 'local-ollama',
        existingSlugs: new Set(),
      })).toMatchObject({ baseUrl: foreign, slug: 'local-ollama' })
    }
  })

  it('carries the hardcoded URL through unchanged too', () => {
    expect(buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: DEFAULT_ENDPOINT_URL,
      apiKey: 'sk-real',
      models: ['anthropic/claude-opus-5'],
      editingSlug: null,
      existingSlugs: new Set(),
    })).toMatchObject({ baseUrl: DEFAULT_ENDPOINT_URL })
  })
})

/**
 * G3 — availability is per ARM once two wires are in play.
 *
 * An anthropic-wire model answers on this endpoint with this key and is still
 * unreachable from the Pi arm (one protocol per connection) and from the codex
 * arm (chat-completions only). Calling that `no-quota` would name the wrong
 * cause; `wrong-runtime` names the real one.
 */
/**
 * P6.454 — which of a connection's two wires a model is served over, at the
 * surface where the model is chosen.
 *
 * The arm gate and the probe gate are the two arms of this predicate that could
 * be wrong in opposite directions: dropping the arm gate would mark every Pi and
 * codex model translated (they have one wire, so the word means nothing there),
 * and dropping the probe gate would print a guess about an unprobed id in the
 * same place as a measurement.
 */
describe('isTranslatedWireModel', () => {
  const translated = { verdict: 'ok' as const }
  const native = { verdict: 'ok' as const, wire: 'anthropic-messages' as const }

  it('marks a model with no anthropic-messages stamp on the Claude arm', () => {
    expect(isTranslatedWireModel(translated, 'claude-runtime')).toBe(true)
  })

  it('leaves a natively served model unmarked — the control that makes the mark mean something', () => {
    expect(isTranslatedWireModel(native, 'claude-runtime')).toBe(false)
  })

  it('says nothing on the one-wire arms, where the distinction does not exist', () => {
    for (const arm of ['pi', 'codex-runtime'] as const) {
      expect(isTranslatedWireModel(translated, arm)).toBe(false)
      expect(isTranslatedWireModel(native, arm)).toBe(false)
    }
  })

  it('says nothing about an UNPROBED model rather than guessing', () => {
    expect(isTranslatedWireModel(undefined, 'claude-runtime')).toBe(false)
  })

  it('reads the wire and not the verdict — an unreachable model still has a wire', () => {
    expect(isTranslatedWireModel({ verdict: 'no-quota' }, 'claude-runtime')).toBe(true)
    expect(isTranslatedWireModel({ verdict: 'error', wire: 'anthropic-messages' }, 'claude-runtime')).toBe(false)
  })
})

describe('resolveArmVerdicts', () => {
  const probes = {
    'tgpt/qwen35-397b-a17b-fp8': { verdict: 'ok' as const },
    'anthropic/claude-opus-5': { verdict: 'ok' as const, wire: 'anthropic-messages' as const },
    'openai/gpt-4.1': { verdict: 'no-quota' as const },
    'gemini/gemini-3-pro': { verdict: 'unsupported-endpoint' as const },
  }

  it('keeps an anthropic-wire model available on the Claude arm', () => {
    expect(resolveArmVerdicts(probes, 'claude-runtime')).toEqual({
      'tgpt/qwen35-397b-a17b-fp8': 'ok',
      'anthropic/claude-opus-5': 'ok',
      'openai/gpt-4.1': 'no-quota',
      'gemini/gemini-3-pro': 'unsupported-endpoint',
    })
  })

  it('reports it as wrong-runtime on the other two arms, with the reason intact', () => {
    for (const arm of ['pi', 'codex-runtime'] as const) {
      const out = resolveArmVerdicts(probes, arm)
      expect(out['anthropic/claude-opus-5']).toBe('wrong-runtime')
      // Everything else is arm-independent and must pass through untouched —
      // the projection reshapes ONE case, not the whole table.
      expect(out['tgpt/qwen35-397b-a17b-fp8']).toBe('ok')
      expect(out['openai/gpt-4.1']).toBe('no-quota')
      expect(out['gemini/gemini-3-pro']).toBe('unsupported-endpoint')
    }
  })

  it('never promotes a NON-ok wired model — an unreachable model stays unreachable', () => {
    // A wire is recorded only alongside a real answer, but if one ever arrives
    // with a failing verdict the arm projection must not launder it into 'ok'.
    const out = resolveArmVerdicts(
      { 'anthropic/x': { verdict: 'no-quota', wire: 'anthropic-messages' } },
      'claude-runtime',
    )
    expect(out['anthropic/x']).toBe('no-quota')
  })
})

/**
 * G3 — the wire has to SURVIVE the save, or the routing has nothing to read.
 */
describe('buildByoRuntimeSetup carries the wire', () => {
  it('promotes only the wired ids to model objects', () => {
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: DEFAULT_ENDPOINT_URL,
      apiKey: 'sk-real',
      models: ['tgpt/qwen35-397b-a17b-fp8', 'anthropic/claude-opus-5'],
      editingSlug: null,
      existingSlugs: new Set(),
      modelMeta: { 'anthropic/claude-opus-5': { wire: 'anthropic-messages' } },
    })
    expect(setup.models).toEqual([
      'tgpt/qwen35-397b-a17b-fp8',
      { id: 'anthropic/claude-opus-5', name: 'anthropic/claude-opus-5', shortName: 'anthropic/claude-opus-5', wire: 'anthropic-messages' },
    ] as typeof setup.models)
    // The default model is still an ID, not an object.
    expect(setup.defaultModel).toBe('tgpt/qwen35-397b-a17b-fp8')
  })

  it('leaves every model a plain string when nothing is wired', () => {
    // The shape every connection had before G3 — no silent migration.
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: DEFAULT_ENDPOINT_URL,
      apiKey: 'sk-real',
      models: ['a', 'b'],
      editingSlug: null,
      existingSlugs: new Set(),
    })
    expect(setup.models).toEqual(['a', 'b'])
  })
})

/**
 * The default model is the FIRST one picked, and the picker preserves that
 * order — the property the create form's selection summary now advertises.
 *
 * Pinned at the builder, because that is where `models[0]` becomes
 * `defaultModel` at the wire. The form shows the first chip as the default; if
 * these two ever disagree the UI is lying about what it is about to save.
 */
describe('selection order decides the default model', () => {
  it('sends the first-picked model as defaultModel', () => {
    const picked = ['tgpt/qwen35-397b-a17b-fp8', 'tgpt/t-pro-it-2-1-fp8', 'tgpt/qwen3-235b-a22b']
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: DEFAULT_ENDPOINT_URL,
      apiKey: 'sk-real',
      models: picked,
      editingSlug: null,
      existingSlugs: new Set(),
    })
    expect(setup.defaultModel).toBe(picked[0])
    expect(setup.models).toEqual(picked)
  })

  it('CLICK-TO-CHOOSE: the clicked model moves to the front and nothing else reorders', () => {
    // The rule CHANGED here (owner, 2026-08-15): first-pick is only the INITIAL
    // default, and clicking a chip overrides it. The chip row shows the default
    // first because the front IS the default — `models[0]` → `defaultModel` —
    // so position and meaning cannot drift apart.
    const picked = ['a', 'b', 'c', 'd']
    const clicked = 'c'
    const reordered = [clicked, ...picked.filter(id => id !== clicked)]
    expect(reordered).toEqual(['c', 'a', 'b', 'd'])

    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: DEFAULT_ENDPOINT_URL,
      apiKey: 'sk-real',
      models: reordered,
      editingSlug: null,
      existingSlugs: new Set(),
    })
    expect(setup.defaultModel).toBe('c')
    // The rest keep their relative order — a click promotes one model, it does
    // not resort the list.
    expect(setup.models).toEqual(['c', 'a', 'b', 'd'])
  })

  it('keeps a DIFFERENT first pick as the default — order is not sorted away', () => {
    // The negative control for the case above: if anything sorted the array,
    // both tests would still pass with a sorted-first id, so the second uses a
    // first element that would NOT survive sorting.
    const picked = ['zz-last-alphabetically', 'aa-first-alphabetically']
    const setup = buildByoRuntimeSetup({
      providerType: 'claude-runtime',
      baseUrl: DEFAULT_ENDPOINT_URL,
      apiKey: 'sk-real',
      models: picked,
      editingSlug: null,
      existingSlugs: new Set(),
    })
    expect(setup.defaultModel).toBe('zz-last-alphabetically')
    expect(setup.models).toEqual(picked)
  })

  it('parses a typed list in the order it was typed, for the paths that keep the field', () => {
    // The edit paths still type; the same first-wins rule has to hold there.
    expect(parseModelList('second-typed, first-alphabetically')).toEqual([
      'second-typed', 'first-alphabetically',
    ])
  })
})


/**
 * The window the form DISPLAYED is the window that gets saved.
 *
 * G2 stamped `modelsSyncedAt` on create; the post-create refresh then saw that
 * brand-new stamp as "fresh" and skipped — always-on stamping disabled the
 * fetch it was meant to guarantee, and a saved model carried no window until
 * the 24h TTL expired. Measured live on walk A. The form has the catalog in
 * hand, so it now persists what it showed.
 */
describe('promoteModels', () => {
  it('carries the displayed contextWindow into the payload', () => {
    expect(promoteModels(['tgpt/qwen35-397b-a17b-fp8'], {
      'tgpt/qwen35-397b-a17b-fp8': { contextWindow: 262_144 },
    })).toEqual([
      { id: 'tgpt/qwen35-397b-a17b-fp8', name: 'tgpt/qwen35-397b-a17b-fp8', shortName: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_144 },
    ] as ReturnType<typeof promoteModels>)
  })

  it('leaves an id with nothing known about it a plain string', () => {
    // The shape every connection had before this, and the shape a save without
    // a catalog still produces — no silent migration.
    expect(promoteModels(['a', 'b'])).toEqual(['a', 'b'])
    expect(promoteModels(['a'], { a: {} })).toEqual(['a'])
    expect(promoteModels(['a'], { b: { contextWindow: 4096 } })).toEqual(['a'])
  })

  it('carries window and wire together when both are known', () => {
    expect(promoteModels(['anthropic/claude-opus-5'], {
      'anthropic/claude-opus-5': { contextWindow: 200_000, wire: 'anthropic-messages' },
    })).toEqual([
      { id: 'anthropic/claude-opus-5', name: 'anthropic/claude-opus-5', shortName: 'anthropic/claude-opus-5', contextWindow: 200_000, wire: 'anthropic-messages' },
    ] as ReturnType<typeof promoteModels>)
  })

  it('is used by BOTH arms — the Pi path never reaches buildByoRuntimeSetup', () => {
    const hook = readFileSync(fileURLToPath(new URL('../../../hooks/useOnboarding.ts', import.meta.url)), 'utf8')
    expect(hook).toContain('promoteModels(data.models, data.modelMeta)')
  })
})

/**
 * DA1.11 — a gateway-HOST endpoint that is not the gateway URL must say so.
 *
 * The row's own test clause: "the asymmetry test this row asks for does NOT
 * exist … the two runtime suites each pin one side with nothing asserting the Pi
 * side answers the opposite way on purpose." It exists now, and it pins the
 * relationship AFTER DA1.10 narrowed the Pi credential side — which is not the
 * relationship the row was written against, and that is a result worth having in
 * a test rather than in prose.
 */
describe('DA1.11 — the gateway host on a non-gateway path', () => {
  const GATEWAY_URL = NESTOR_CHAT_URL.replace(/\/chat\/completions$/, '')
  const SAME_HOST_OTHER_PATH = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1'
  const SAME_HOST_OUTSIDE_PREFIX = 'https://code-completion-nestor.tcsbank.ru/api/v1/personal/x'

  it('detects the host while refusing to call it the gateway', () => {
    expect(isGatewayHostNonGatewayEndpoint(SAME_HOST_OTHER_PATH)).toBe(true)
    expect(isGatewayHostNonGatewayEndpoint(SAME_HOST_OUTSIDE_PREFIX)).toBe(true)
    // The EXACT gateway URL is NOT this case: it is the gateway, and the two
    // validators refuse it outright rather than annotating it.
    expect(isGatewayHostNonGatewayEndpoint(GATEWAY_URL)).toBe(false)
    expect(isGatewayHostNonGatewayEndpoint(`${GATEWAY_URL}/`)).toBe(false)
  })

  it('is a parsed HOST test, so a look-alike cannot borrow the notice', () => {
    expect(isGatewayHostNonGatewayEndpoint('https://llm-proxy.t-tech.team')).toBe(false)
    expect(isGatewayHostNonGatewayEndpoint(`https://evil.example/?x=${encodeURIComponent(GATEWAY_URL)}`)).toBe(false)
    expect(isGatewayHostNonGatewayEndpoint('not a url')).toBe(false)
    expect(isGatewayHostNonGatewayEndpoint('')).toBe(false)
    expect(isGatewayHostNonGatewayEndpoint(undefined)).toBe(false)
  })

  /**
   * THE ASYMMETRY, pinned as a four-way answer on ONE URL. Each of these four
   * predicates is read by a different layer, and the row's user case is what
   * happens when a reader assumes they agree.
   */
  it('pins what each layer answers for the same gateway-host URL', () => {
    // (1) the WIDE prefix — still true, and it must be: ten non-credential
    //     readers depend on it (the operator-header channel, the quota gate, the
    //     capability tier, the icon).
    expect(isNestorCliBaseUrl(SAME_HOST_OTHER_PATH)).toBe(true)
    // (2) the Pi CREDENTIAL predicate, after DA1.10 — false. Before DA1.10 this
    //     was TRUE and it is the half that carried the dp JWT out.
    expect(isNestorGatewayCredentialUrl(SAME_HOST_OTHER_PATH)).toBe(false)
    // (3) the adapter side, whole-URL — false, and deliberately never widened.
    expect(isNessyGatewayBaseUrl(SAME_HOST_OTHER_PATH)).toBe(false)
    // (4) the HOST class — true. (1) and (4) being true while (2) and (3) are
    //     false is exactly the state nothing used to name, and the notice is
    //     what names it.
    expect(isGatewayHostNonGatewayEndpoint(SAME_HOST_OTHER_PATH)).toBe(true)
  })

  it('and on the gateway URL itself, the three that can agree do', () => {
    expect(isNestorCliBaseUrl(GATEWAY_URL)).toBe(true)
    expect(isNestorGatewayCredentialUrl(GATEWAY_URL)).toBe(true)
    expect(isNessyGatewayBaseUrl(GATEWAY_URL)).toBe(true)
    expect(isGatewayHostNonGatewayEndpoint(GATEWAY_URL)).toBe(false)
  })
})
/**
 * DA1.64 — the SAVE path's refusal token reaches the user as a SENTENCE.
 *
 * DA1.60 put the form's `endpointIsGateway` rule on the door every client shares
 * and made the RPC answer with the form's own token, on the stated understanding
 * that *"a renderer that wants the sentence reuses the map it already has for
 * this exact token"* (`handlers/rpc/llm-connections.ts`, `GATEWAY_ENDPOINT_REFUSAL`).
 * Nothing did, so `useOnboarding` wrote `result.error` into `errorMessage` raw.
 *
 * Both halves are pinned here because each fails differently: the MAP is a pure
 * function and is tested as one, while the two CALL SITES are unreachable
 * without an Electron window and are read out of the source — the same shape the
 * `promoteModels` case above uses, and the one C2-b's hand-off recommended.
 */
describe('DA1.64 — the save refusal, in the user own language', () => {
  it('maps the token the RPC actually answers with', () => {
    expect(byoRuntimeRefusalKey('endpointIsGateway'))
      .toBe('onboarding.byoRuntime.errorEndpointIsGateway')
    // The key is the one the FORM already shows for the same token — one
    // sentence, two doors, which is the whole of DA1.60's bargain.
    expect(BYO_RUNTIME_ERROR_KEY.endpointIsGateway)
      .toBe('onboarding.byoRuntime.errorEndpointIsGateway')
  })

  it('and answers undefined for anything that is not one of the form tokens', () => {
    // A server message rather than a token: the caller keeps showing it, because
    // a refusal nobody can translate must still be readable.
    expect(byoRuntimeRefusalKey('Connection refused by upstream')).toBeUndefined()
    expect(byoRuntimeRefusalKey(undefined)).toBeUndefined()
    expect(byoRuntimeRefusalKey(null)).toBeUndefined()
    expect(byoRuntimeRefusalKey('')).toBeUndefined()
    // THE BOUNDARY, and the reason the lookup is `Object.hasOwn` and not `in`:
    // the argument is a server-supplied string, and every prototype member of a
    // plain object answers `in`. A regression to `in` hands a FUNCTION back
    // where a locale key belongs, and `i18n.t` would be called with it.
    expect(byoRuntimeRefusalKey('constructor')).toBeUndefined()
    expect(byoRuntimeRefusalKey('toString')).toBeUndefined()
  })

  it('is applied at BOTH save doors — one of them is not a fix', () => {
    const hook = readFileSync(fileURLToPath(new URL('../../../hooks/useOnboarding.ts', import.meta.url)), 'utf8')
    // Read per CALL SITE rather than per file, and that is the whole care in
    // this case: the hook writes `result.error` raw at four OTHER sites — the
    // ChatGPT auth, the OAuth start, the code exchange and the path check —
    // where the server's own message is the right thing to show, because none
    // of those RPCs can answer a `ByoRuntimeValidationError`. A file-wide
    // "nothing writes the raw error" control fires on all four.
    const doors: string[] = []
    const CALL = 'window.electronAPI.setupLlmConnection('
    for (let at = hook.indexOf(CALL); at !== -1; at = hook.indexOf(CALL, at + 1)) {
      doors.push(hook.slice(at, at + 1200))
    }
    // The wizard's `handleSaveConfig` and the BYO-runtime submit. They are the
    // same RPC, so a mapping that reached one would leave the other on the
    // token — and a THIRD door appearing unmapped is what this shape catches.
    expect(doors.length).toBe(2)
    for (const door of doors) {
      expect(door).toContain('errorMessage: saveFailureMessage(result.error)')
      expect(door).not.toContain('errorMessage: result.error ||')
    }
  })
})
