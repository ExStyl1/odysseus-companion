/**
 * Connection Setup Logic
 *
 * Pure functions extracted from ipc.ts for testability.
 * No dependency on ipcMain, sessionManager, credential manager, or file I/O.
 */

import type { ModelDefinition } from '@nessy-agent/shared/config/models'
import type { LlmConnectionSetup } from '@nessy-agent/shared/protocol'
import {
  type LlmConnection,
  type LlmProviderType,
  type CustomEndpointApi,
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  defaultMidStreamBehavior,
  isAdapterRuntimeProvider,
  isValidProviderAuthCombination, codexChatGptSubscriptionConnectionSeed, type CodexModelProvider,
} from '@nessy-agent/shared/config'

// ============================================================
// Error Parsing
// ============================================================

/**
 * Parse an error message from a connection test into a user-friendly string.
 */
export function parseTestConnectionError(msg: string): string {
  const lower = msg.toLowerCase()

  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return 'Cannot connect to API server. Check the URL and ensure the server is running.'
  }
  if (lower.includes('no api key found for')) {
    // Same dead UI as the guard below: this used to name two cards that the
    // merged personal-key form replaced. What the upstream error actually means
    // is that the request was routed to a provider whose key is not the one
    // stored, so say that instead of naming a menu.
    return 'Provider mismatch during setup: the endpoint was tested as a different provider than the stored key belongs to. Check the protocol selected for this connection.'
  }
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('authentication')) {
    return 'Invalid API key'
  }
  if (lower.includes('404') && lower.includes('model')) {
    return 'Model not found. Check the model name and try again.'
  }
  if (lower.includes('404')) {
    return 'API endpoint not found. Check the URL.'
  }
  if (lower.includes('429') || lower.includes('rate limit')) {
    return 'Rate limit exceeded. Please try again.'
  }
  if (lower.includes('403')) {
    return 'API key does not have permission to access this resource'
  }

  return msg.slice(0, 300)
}

/**
 * Guard against a Pi custom-endpoint test that names no provider routing.
 *
 * The guard itself is unchanged and still correct: a `pi` test against a custom
 * base URL cannot pick a driver without knowing which wire protocol to speak.
 * Only its MESSAGE changed, because the message described a UI that no longer
 * exists — it told the user to select a provider preset and, failing that, to
 * switch to "Anthropic API Key mode", which was a separate card the merged
 * personal-key form replaced. Both instructions were unfollowable.
 *
 * The merged form now DERIVES the provider from the protocol the user picked,
 * so this branch is unreachable from it. What can still reach it is a caller
 * that assembles the request itself, and the message is written for that reader
 * instead: it names the missing field rather than a menu item.
 */
export function validateSetupTestInput(params: {
  provider: 'anthropic' | 'pi'
  baseUrl?: string
  piAuthProvider?: string
}): { valid: true } | { valid: false; error: string } {
  const hasCustomEndpoint = !!params.baseUrl?.trim()
  if (params.provider === 'pi' && hasCustomEndpoint && !params.piAuthProvider) {
    return {
      valid: false,
      error: 'A Nessy Backend test against a custom endpoint needs piAuthProvider — it selects the wire protocol, and there is no default that is safe to guess.',
    }
  }

  return { valid: true }
}

/**
 * Returns true when a URL points to local loopback.
 * Used to permit keyless setup tests for local model runtimes (e.g. Ollama).
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

/**
 * Setup tests require API keys for non-local endpoints, but local loopback
 * endpoints may be keyless.
 */
export function setupTestRequiresApiKey(baseUrl?: string): boolean {
  return !isLoopbackBaseUrl(baseUrl)
}

/** Placeholder run that stands in for a stored API key in the edit form (GET_API_KEY). */
export const API_KEY_MASK = '••••••••'

/**
 * Mask a stored API key for display: provider prefix + mask + last four, or the
 * mask alone for short keys. The only producer of masked values. (UB3.4, OSS
 * #1048 — upstream v0.15.1's helpers; our GET_API_KEY handler points here.)
 */
export function maskApiKey(key: string): string {
  return key.length > 15 ? key.slice(0, 7) + API_KEY_MASK + key.slice(-4) : API_KEY_MASK
}

/**
 * True for values produced by {@link maskApiKey}, i.e. the edit form echoing a
 * stored key back. Real keys never contain the bullet character.
 */
export function isMaskedApiKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.includes('••')
}

export type SetupTestApiKeyResolution =
  | { ok: true; apiKey: string; source: 'input' | 'stored' }
  | { ok: false; error: string }

/**
 * Decide which API key a setup test should use.
 *
 * The edit form shows the stored key as a masked placeholder; when the user
 * leaves it untouched and clicks Test, the placeholder arrives here. Testing
 * with the bullets always failed authentication (OSS #1048, UB3.4), so resolve
 * it to the stored credential by connection slug, and ask for the key when that
 * is not possible. Pure apart from the injected store lookup.
 *
 * Divergence from upstream kept (UB3.4): an EMPTY key with a slug also resolves
 * to the stored credential when one exists — our model-catalog path established
 * that rule before this row (the BYO editor's probe sends a blank field with the
 * slug meaning "the stored one"), and the test path now speaks the same language.
 * Upstream passes an empty key through and lets `allowEmptyApiKey` decide.
 */
export async function resolveSetupTestApiKey(
  input: { apiKey: string | undefined; connectionSlug?: string; allowEmptyApiKey: boolean },
  getStoredApiKey: (slug: string) => Promise<string | null>,
): Promise<SetupTestApiKeyResolution> {
  const trimmed = input.apiKey?.trim() ?? ''

  if (isMaskedApiKey(trimmed)) {
    if (!input.connectionSlug) {
      return { ok: false, error: 'Re-enter the API key to test this connection.' }
    }
    const stored = await getStoredApiKey(input.connectionSlug)
    if (!stored) {
      return { ok: false, error: 'No API key is stored for this connection. Re-enter the key to test it.' }
    }
    return { ok: true, apiKey: stored, source: 'stored' }
  }

  if (!trimmed && input.connectionSlug) {
    const stored = await getStoredApiKey(input.connectionSlug)
    if (stored) {
      return { ok: true, apiKey: stored, source: 'stored' }
    }
  }

  if (!trimmed && !input.allowEmptyApiKey) {
    return { ok: false, error: 'API key is required' }
  }
  return { ok: true, apiKey: trimmed, source: 'input' }
}

/**
 * Decide how a custom OpenAI/Anthropic-compatible endpoint should be persisted.
 *
 * - Loopback URL with no credential → keyless local model (Ollama, LM Studio).
 * - Loopback URL *with* a credential → real local OpenAI-compat server (vLLM, LiteLLM, etc.);
 *   must be treated like a remote custom endpoint so `piAuthProvider` is set, otherwise
 *   `getPiAuth()` returns null at runtime and chat requests fail with 401 (#636).
 * - Remote URL → always keyed with provider hint for the correct icon.
 *
 * Pure: caller spreads the result into the connection updates patch.
 */
export function resolveCustomEndpointSetup(input: {
  baseUrl: string | undefined
  credential: string | undefined
  customEndpointApi: CustomEndpointApi
}): {
  authType: Extract<LlmConnection['authType'], 'none' | 'api_key_with_endpoint'>
  name?: 'Local Model'
  piAuthProvider?: 'openai' | 'anthropic'
} {
  const isKeylessLoopback = isLoopbackBaseUrl(input.baseUrl) && !input.credential
  if (isKeylessLoopback) {
    return { authType: 'none', name: 'Local Model' }
  }
  return {
    authType: 'api_key_with_endpoint',
    piAuthProvider: input.customEndpointApi === 'anthropic-messages' ? 'anthropic' : 'openai',
  }
}

/**
 * Whether a SETUP payload's explicit `authType` may be applied, and to what.
 *
 * Only the adapter-runtime provider types (`codex-runtime` / `claude-runtime`)
 * are allowed to name their own auth type. They are the one class of connection
 * that carries a user-supplied endpoint but NO `customEndpoint` — sending one
 * would rewrite them to `pi_compat` and their local adapter would never start —
 * so they are also the one class that never reaches
 * {@link resolveCustomEndpointSetup}, which is where every other custom-endpoint
 * connection gets its loopback-plus-no-credential → `authType: 'none'` mapping.
 *
 * Without this, a keyless local BYO runtime endpoint (the Ollama-class case the
 * form explicitly offers) persists as `api_key_with_endpoint` with nothing in
 * the credential store, and two separate checks read that as breakage:
 * `validateStoredBackendConnection` returns "No credentials configured"
 * (factory.ts) and `CredentialManager.checkHealth` raises
 * `no_default_credentials` — a standing "re-authenticate" banner whenever it is
 * the default connection, which a first connection always is.
 *
 * Returns `undefined` when the payload asked for nothing, when the provider type
 * is not an adapter runtime, or when the combination is not valid for it — the
 * caller then leaves `authType` alone.
 */
export function resolveAdapterRuntimeAuthType(
  providerType: LlmProviderType,
  requestedAuthType: LlmConnectionSetup['authType'],
): LlmConnection['authType'] | undefined {
  if (!requestedAuthType) return undefined
  if (!isAdapterRuntimeProvider(providerType)) return undefined
  if (!isValidProviderAuthCombination(providerType, requestedAuthType)) return undefined
  return requestedAuthType
}

// ============================================================
// Built-in Connection Templates
// ============================================================

/**
 * Built-in connection templates for the onboarding flow.
 * Each template defines the default configuration for a known connection slug.
 */
export const BUILT_IN_CONNECTION_TEMPLATES: Record<string, {
  name: string | ((hasCustomEndpoint: boolean) => string)
  providerType: LlmConnection['providerType'] | ((hasCustomEndpoint: boolean) => LlmConnection['providerType'])
  authType: LlmConnection['authType'] | ((hasCustomEndpoint: boolean) => LlmConnection['authType'])
  piAuthProvider?: string; /** F1.202 — codex's OWN provider this card routes to (`resolveCodexModelProvider`). */ codexModelProvider?: CodexModelProvider
}> = {
  'anthropic-api': {
    name: (h) => h ? 'Custom Anthropic-Compatible' : 'Anthropic (API Key)',
    providerType: (h) => h ? 'pi_compat' : 'anthropic',
    authType: (h) => h ? 'api_key_with_endpoint' : 'api_key',
  },
  'claude-max': {
    name: 'Claude Max',
    providerType: 'anthropic',
    authType: 'oauth',
  },
  'chatgpt-plus': {
    name: 'ChatGPT Plus',
    providerType: 'pi',
    authType: 'oauth',
    piAuthProvider: 'openai-codex',
  },
  'pi-api-key': {
    name: 'Nessy Backend (API Key)',
    providerType: 'pi',
    authType: 'api_key',
    // piAuthProvider set dynamically from setup.piAuthProvider
  },
  'nessy-cloud-agent': {
    name: 'Nessy Cloud Agent',
    providerType: 'nestor-cloud-agent',
    authType: 'none',
  },
  // One-click Nessy Gateway Codex connection (nessy-gateway-auth plan). The
  // gateway JWT is the credential; models/baseUrl come from the setup payload
  // (codexGatewayConnectionDefaults). Reconcile with the codex-composer plan if
  // it later defines a canonical codex connection shape.
  'codex-gateway': {
    name: 'Codex (Nessy Gateway)',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
  },
  // One-click Nessy Gateway Claude Code connection (T7). Same shape as the codex
  // row above: the gateway JWT is the credential and the endpoint + catalog
  // arrive in the setup payload (claudeGatewayConnectionDefaults).
  //
  // `providerType` is a plain literal, deliberately NOT the
  // `(hasCustomEndpoint) => …` form the `anthropic-api` row uses: that row
  // upgrades to `pi_compat` as soon as a base URL is present, and a
  // `claude-runtime` connection that did the same would never start its local
  // Anthropic-Messages adapter. This card ALWAYS carries an endpoint.
  'claude-gateway': {
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
  },
  // BYO endpoint form (C3): the same two runtimes pointed at the user's own
  // OpenAI-like endpoint with their own key. Deliberately SEPARATE slugs from
  // the `*-gateway` rows above — those are upserted idempotently by the
  // zero-form cards, so sharing a slug would let a BYO save overwrite the corp
  // connection (the trap `gateway-one-click.ts` documents for 'pi-api-key').
  //
  // Both keep the plain-literal `providerType` for the reason spelled out on
  // the claude-gateway row: the `(hasCustomEndpoint) => …` form would upgrade
  // them to `pi_compat` — which is precisely what a BYO connection looks like —
  // and the local adapter would never start.
  'codex-custom': {
    name: 'Codex (Custom Endpoint)',
    providerType: 'codex-runtime',
    authType: 'api_key_with_endpoint',
  },
  'claude-custom': {
    name: 'Claude Code (Custom Endpoint)',
    providerType: 'claude-runtime',
    authType: 'api_key_with_endpoint',
  },
  'chatgpt-codex': { name: 'ChatGPT (Codex)', providerType: 'codex-runtime', authType: 'oauth', codexModelProvider: 'openai' } } // F1.202 — one line so every cited line below stays put; its seed is in createBuiltInConnection

// ============================================================
// Pi Auth Provider Display Names
// ============================================================

const PI_AUTH_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI',
  google: 'Google AI Studio',
  openrouter: 'OpenRouter',
  'azure-openai-responses': 'Azure OpenAI',
  'amazon-bedrock': 'Amazon Bedrock',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI',
  cerebras: 'Cerebras',
  zai: 'z.ai',
  huggingface: 'Hugging Face',
  minimax: 'Minimax',
  'minimax-cn': 'Minimax CN',
  'kimi-coding': 'Kimi (Coding)',
  'vercel-ai-gateway': 'Vercel AI Gateway',
}

/** Get a human-readable display name for a Pi auth provider key */
export function piAuthProviderDisplayName(piAuthProvider: string): string | null {
  return PI_AUTH_PROVIDER_DISPLAY_NAMES[piAuthProvider] ?? null
}

// ============================================================
// Connection Creation
// ============================================================

/**
 * Create an LLM connection configuration from a connection slug.
 * Uses built-in templates for known slugs, throws for unknown slugs
 * (custom connections are created through the settings UI).
 */
export function createBuiltInConnection(slug: string, baseUrl?: string | null): LlmConnection {
  // Try exact match first, then strip numeric suffix for derived slugs (e.g. 'anthropic-api-2' → 'anthropic-api')
  const baseSlug = slug.replace(/-\d+$/, '')
  const template = BUILT_IN_CONNECTION_TEMPLATES[slug] ?? BUILT_IN_CONNECTION_TEMPLATES[baseSlug]
  if (!template) {
    throw new Error(`Unknown built-in connection slug: ${slug}. Custom connections should be created through settings.`)
  }

  const hasCustomEndpoint = !!baseUrl
  const providerType = typeof template.providerType === 'function'
    ? template.providerType(hasCustomEndpoint)
    : template.providerType
  const authType = typeof template.authType === 'function'
    ? template.authType(hasCustomEndpoint)
    : template.authType
  let name = typeof template.name === 'function'
    ? template.name(hasCustomEndpoint)
    : template.name

  // Append suffix number to name for derived connections (e.g. 'anthropic-api-2' → 'Anthropic (API Key) 2')
  const suffixMatch = slug.match(/-(\d+)$/)
  if (suffixMatch && !BUILT_IN_CONNECTION_TEMPLATES[slug]) {
    name = `${name} ${suffixMatch[1]}`
  }

  return {
    slug,
    name,
    providerType,
    authType,
    models: getDefaultModelsForConnection(providerType, template.piAuthProvider),
    defaultModel: getDefaultModelForConnection(providerType, template.piAuthProvider),
    modelSelectionMode: providerType === 'pi' ? 'automaticallySyncedFromProvider' : undefined,
    piAuthProvider: template.piAuthProvider,
    midStreamBehavior: defaultMidStreamBehavior(providerType),
    createdAt: Date.now(),
    // F1.202 — a card that declares codex's own provider carries codex's own
    // model catalogue: an adapter-runtime template seeds NO models (the
    // endpoint owns the catalogue, `getDefaultModelsForConnection`), and this
    // card has no endpoint of ours to own one. Spread last, so it replaces the
    // two empty seed fields above rather than sitting beside them.
    ...(template.codexModelProvider ? codexChatGptSubscriptionConnectionSeed(template.codexModelProvider) : {}),
  }
}

// ============================================================
// Model Validation
// ============================================================

/**
 * Validate that the default model exists in the provided model list.
 * Handles both string and ModelDefinition model entries.
 *
 * This was extracted from inline logic in the setupLlmConnection IPC handler
 * to fix a bug where Array.includes() compared strings against ModelDefinition
 * objects, always returning false for Pi connections.
 */
/**
 * E1 — the utility-model slot must name a model this connection actually has.
 *
 * Deliberately checked against the POST-MERGE list rather than the payload's
 * `models`: an edit may carry `miniModel` alone, and validating against an
 * absent list would reject every such save. The caller passes
 * `{...connection, ...updates}` for exactly that reason.
 *
 * An EMPTY list is not a failure. A provider whose catalog the server installs
 * (the Pi `automaticallySyncedFromProvider` path) has nothing to check against
 * at this point, and refusing there would block a legal save.
 */
export function validateMiniModel(
  miniModel: string | undefined,
  models: Array<ModelDefinition | string> | undefined,
): { valid: boolean; error?: string } {
  if (!miniModel || !models || models.length === 0) return { valid: true }
  const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
  if (modelIds.includes(miniModel)) return { valid: true }
  return {
    valid: false,
    error: `Utility model "${miniModel}" is not in this connection's model list.`,
  }
}

export function validateModelList(
  models: Array<ModelDefinition | string>,
  defaultModel: string | undefined,
): { valid: boolean; error?: string; resolvedDefaultModel?: string } {
  if (!models || models.length === 0) {
    return { valid: true }
  }

  const modelIds = models.map(m => typeof m === 'string' ? m : m.id)

  if (defaultModel && !modelIds.includes(defaultModel)) {
    return {
      valid: false,
      error: `Default model "${defaultModel}" is not in the provided model list.`,
    }
  }

  if (!defaultModel) {
    const firstModel = models[0]
    const firstModelId = typeof firstModel === 'string' ? firstModel : firstModel!.id
    return {
      valid: true,
      resolvedDefaultModel: firstModelId,
    }
  }

  return { valid: true }
}
