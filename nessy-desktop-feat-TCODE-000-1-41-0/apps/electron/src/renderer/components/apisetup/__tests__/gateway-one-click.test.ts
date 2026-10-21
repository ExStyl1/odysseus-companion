import { describe, it, expect, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildGatewaySetup, createGatewayConnection, CODEX_GATEWAY_SLUG, CLAUDE_GATEWAY_SLUG } from '../gateway-one-click'
import { NESSY_GATEWAY_BASE_URL, NESSY_GATEWAY_DEFAULT_MODEL, NESSY_GATEWAY_MODELS } from '../nessy-gateway'

describe('buildGatewaySetup — Pi card', () => {
  it('produces the pi_compat-yielding gateway payload (mirrors ApiKeyInput submit)', () => {
    const setup = buildGatewaySetup('pi', 'jwt-value')
    // Fixed base slug → SETUP upserts on repeat runs.
    expect(setup.slug).toBe('pi-api-key')
    // DA1.13 — no credential in the payload. The card's credential of record is
    // the live `~/.nessy/dp_auth_creds.json`, and the snapshot this field used to
    // carry had no lifecycle at all.
    expect(setup.credential).toBeUndefined()
    expect(setup.baseUrl).toBe(NESSY_GATEWAY_BASE_URL)
    // customEndpoint present → server maps this to providerType pi_compat.
    expect(setup.customEndpoint).toEqual({ api: 'openai-completions', supportsImages: false })
    expect(setup.piAuthProvider).toBe('openai')
    expect(setup.defaultModel).toBe(NESSY_GATEWAY_DEFAULT_MODEL)
    expect(Array.isArray(setup.models)).toBe(true)
  })

  it('upserts into the confirmed gateway connection slug', () => {
    const setup = buildGatewaySetup('pi', 'jwt', new Set(['pi-api-key']), 'pi-api-key')
    expect(setup.slug).toBe('pi-api-key')
  })

  it('does not clobber a foreign connection holding the base slug', () => {
    // Base slug taken but NOT confirmed as the gateway (e.g. the user's own
    // custom-endpoint connection claimed 'pi-api-key' first) → fresh slug.
    const setup = buildGatewaySetup('pi', 'jwt', new Set(['pi-api-key']))
    expect(setup.slug).toBe('pi-api-key-2')
  })

  it('DA1.13 — never PUTS the jwt in the payload, whatever the caller passes', () => {
    // This assertion was `toBe('secret')` and the flip IS the row: the value is
    // still handed in (the caller must resolve the sign-in before creating the
    // card) and it is deliberately not persisted. The negative control that
    // keeps the suite discriminating is the BYO form next door, which still
    // carries its own key — see `apiSetupMethodToConnectionSetup`.
    expect(buildGatewaySetup('pi', 'secret').credential).toBeUndefined()
    expect(buildGatewaySetup('codex', 'secret').credential).toBeUndefined()
    expect(buildGatewaySetup('claude', 'secret').credential).toBeUndefined()
  })
})

describe('buildGatewaySetup — Codex card', () => {
  it('produces the codex-runtime gateway payload from codexGatewayConnectionDefaults', () => {
    const setup = buildGatewaySetup('codex', 'jwt-value')
    // Fixed slug maps to the codex-gateway built-in template (codex-runtime).
    expect(setup.slug).toBe(CODEX_GATEWAY_SLUG)
    expect(setup.credential).toBeUndefined()
    expect(setup.baseUrl).toBe(NESSY_GATEWAY_BASE_URL)
    expect(setup.defaultModel).toBe(NESSY_GATEWAY_DEFAULT_MODEL)
    // No customEndpoint — the local Responses adapter handles the codex gateway.
    expect(setup.customEndpoint).toBeUndefined()
  })
})

describe('buildGatewaySetup — Claude Code card', () => {
  it('produces the claude-runtime gateway payload from claudeGatewayConnectionDefaults', () => {
    const setup = buildGatewaySetup('claude', 'jwt-value')
    // Fixed slug maps to the claude-gateway built-in template (claude-runtime).
    expect(setup.slug).toBe(CLAUDE_GATEWAY_SLUG)
    expect(setup.credential).toBeUndefined()
    expect(setup.baseUrl).toBe(NESSY_GATEWAY_BASE_URL)
    expect(setup.defaultModel).toBe(NESSY_GATEWAY_DEFAULT_MODEL)
    // No customEndpoint — a customEndpoint in the SETUP payload forces
    // providerType pi_compat server-side, which would bypass the local adapter.
    expect(setup.customEndpoint).toBeUndefined()
  })

  it('carries the seeded catalog with the fast model LAST', () => {
    // ClaudeAgent reads the last entry as the mini model; the SETUP payload is
    // the only thing that puts a catalog on this connection.
    const setup = buildGatewaySetup('claude', 'jwt')
    expect(setup.models).toEqual(NESSY_GATEWAY_MODELS)
    const models = setup.models as Array<{ id: string }>
    expect(models[models.length - 1]!.id).toBe('tgpt/qwen36-35b-a3b-fp8')
  })

  it('keeps its own slug, distinct from the codex card', () => {
    expect(buildGatewaySetup('claude', 'jwt').slug).not.toBe(buildGatewaySetup('codex', 'jwt').slug)
  })
})

describe('createGatewayConnection', () => {
  const originalWindow = (globalThis as { window?: unknown }).window

  afterEach(() => {
    ;(globalThis as { window?: unknown }).window = originalWindow
  })

  function mockSetup() {
    const calls: unknown[] = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        setupLlmConnection: (setup: unknown) => {
          calls.push(setup)
          return Promise.resolve({ success: true })
        },
      },
    }
    return calls
  }

  it('calls setupLlmConnection with the pi payload', async () => {
    const calls = mockSetup()
    const result = await createGatewayConnection('pi', 'jwt')
    expect(result).toEqual({ success: true })
    expect((calls[0] as { slug: string }).slug).toBe('pi-api-key')
    expect((calls[0] as { credential?: string }).credential).toBeUndefined()
  })

  it('calls setupLlmConnection with the codex payload', async () => {
    const calls = mockSetup()
    await createGatewayConnection('codex', 'jwt')
    expect((calls[0] as { slug: string }).slug).toBe(CODEX_GATEWAY_SLUG)
  })

  it('calls setupLlmConnection with the claude payload', async () => {
    const calls = mockSetup()
    await createGatewayConnection('claude', 'jwt')
    expect((calls[0] as { slug: string }).slug).toBe(CLAUDE_GATEWAY_SLUG)
    expect((calls[0] as { credential?: string }).credential).toBeUndefined()
  })

  it('surfaces a failure result', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        setupLlmConnection: () => Promise.resolve({ success: false, error: 'boom' }),
      },
    }
    const result = await createGatewayConnection('pi', 'jwt')
    expect(result).toEqual({ success: false, error: 'boom' })
  })

  function mockSetupWithConnections(connections: Array<{ slug: string; providerType?: string; baseUrl?: string }>) {
    const calls: unknown[] = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        listLlmConnections: () => Promise.resolve(connections),
        setupLlmConnection: (setup: unknown) => {
          calls.push(setup)
          return Promise.resolve({ success: true })
        },
      },
    }
    return calls
  }

  it('keeps a personal custom connection on the base slug intact (creates a suffixed one)', async () => {
    const calls = mockSetupWithConnections([
      { slug: 'pi-api-key', providerType: 'pi_compat', baseUrl: 'https://my-corp-endpoint.example/v1' },
    ])
    await createGatewayConnection('pi', 'jwt')
    expect((calls[0] as { slug: string }).slug).toBe('pi-api-key-2')
  })

  it('re-running one-click upserts into the existing gateway connection wherever it lives', async () => {
    const calls = mockSetupWithConnections([
      { slug: 'pi-api-key', providerType: 'pi_compat', baseUrl: 'https://my-corp-endpoint.example/v1' },
      { slug: 'pi-api-key-2', providerType: 'pi_compat', baseUrl: NESSY_GATEWAY_BASE_URL },
    ])
    await createGatewayConnection('pi', 'jwt')
    expect((calls[0] as { slug: string }).slug).toBe('pi-api-key-2')
  })
})

describe('GatewayConnectStep — zero-form guarantee', () => {
  it('renders no text input (source contains no input/textarea element)', () => {
    // No DOM/RTL in this test env; assert structurally that the step source has
    // no text-entry element. If someone adds one, this fails.
    const src = readFileSync(
      join(import.meta.dir, '..', '..', 'onboarding', 'GatewayConnectStep.tsx'),
      'utf-8',
    )
    expect(src).not.toMatch(/<input\b/i)
    expect(src).not.toMatch(/<textarea\b/i)
    expect(src).not.toMatch(/type=["']text["']/i)
  })
})
