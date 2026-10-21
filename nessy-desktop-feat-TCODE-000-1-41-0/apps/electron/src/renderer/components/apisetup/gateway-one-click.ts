import type { LlmConnectionSetup } from '@nessy-agent/shared/protocol'
import { apiSetupMethodToConnectionSetup } from '@/hooks/useOnboarding'
import { resolveCustomEndpointPayload } from './submit-helpers'
import {
  NESSY_GATEWAY_PRESET_KEY,
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_MODELS,
  NESSY_GATEWAY_MODEL_IDS,
  NESSY_GATEWAY_DEFAULT_MODEL,
  codexGatewayConnectionDefaults,
  claudeGatewayConnectionDefaults,
  isNessyGatewayConnection,
} from './nessy-gateway'

/**
 * Shared zero-form connection-creation logic for the Nessy Gateway cards
 * (`GatewayKind`: Pi, Cloud, Codex, Claude Code).
 * Used by both onboarding (GatewayConnectStep) and AI settings — ONE
 * implementation. The gateway JWT is the credential and it lives in ONE place,
 * `~/.nessy/dp_auth_creds.json` (DA1.13); the user never fills a form.
 * Idempotent by reusing a fixed slug per kind so the SETUP handler upserts on
 * repeat runs instead of creating duplicates — and that upsert is also what
 * discards any credential snapshot a pre-DA1.13 install stored under the slug.
 */

export type GatewayKind = 'pi' | 'cloud' | 'codex' | 'claude'

/** Presets pinned to the OpenAI-completions protocol (mirrors ApiKeyInput). */
const OPENAI_COMPAT_PRESETS: ReadonlySet<string> = new Set([NESSY_GATEWAY_PRESET_KEY])
const OPENAI_COMPAT_PRESET_OPTIONS = {
  [NESSY_GATEWAY_PRESET_KEY]: { supportsImages: false },
}

/** Fixed slug for the Codex gateway connection (matches the built-in template). */
export const CODEX_GATEWAY_SLUG = 'codex-gateway'
/** Fixed slug for the Claude Code gateway connection (matches the built-in template). */
export const CLAUDE_GATEWAY_SLUG = 'claude-gateway'
/** Fixed slug for the native Nestor cloud A2A connection. */
export const NESTOR_CLOUD_AGENT_SLUG = 'nessy-cloud-agent'

/**
 * Build the exact `LlmConnectionSetup` each gateway card submits.
 *
 * Pi: reproduces the Nessy Gateway preset submit ApiKeyInput sends today
 * (customEndpoint `openai-completions`, piAuthProvider `openai`) via the shared
 * `resolveCustomEndpointPayload` + `apiSetupMethodToConnectionSetup` builders —
 * resulting in a `pi_compat` connection. Cloud: fixed built-in template
 * (`nestor-cloud-agent`) and no stored credential. Codex:
 * `codexGatewayConnectionDefaults` → the `codex-gateway` built-in template
 * (`codex-runtime`). Claude: `claudeGatewayConnectionDefaults` → the
 * `claude-gateway` built-in template (`claude-runtime`).
 *
 * Neither runtime card sends `customEndpoint`: the SETUP handler forces
 * `providerType: 'pi_compat'` whenever one is present, which would route the
 * connection through Pi and leave the local adapter unused.
 *
 * DA1.13 — **no card sends a `credential` any more, and `_jwt` is deliberately
 * unused.** All three used to snapshot the sign-in JWT into the credential store
 * under their slug, where it had no lifecycle: no re-mint refreshed it, the
 * Reconnect item never touched it, nothing expired it. The credential of record
 * is the live `~/.nessy/dp_auth_creds.json`, read per turn by whichever runtime
 * serves the card, and the setup RPC now refuses the write and deletes any
 * snapshot an older install left behind
 * (`packages/server-core/src/handlers/rpc/llm-connections.ts`, symbol
 * `isGatewayBackedConnection`). The parameter stays because the ORDER still
 * matters — the caller resolves the sign-in before creating the card, and a card
 * created for a user who never signed in would have nothing to run on — and
 * because dropping it would ripple through every call site for no gain.
 */
export function buildGatewaySetup(
  kind: GatewayKind,
  _jwt: string,
  existingSlugs: Set<string> = new Set(),
  existingPiGatewaySlug?: string | null,
): LlmConnectionSetup {
  if (kind === 'codex' || kind === 'claude') {
    const defaults = kind === 'claude'
      ? claudeGatewayConnectionDefaults()
      : codexGatewayConnectionDefaults()
    return {
      slug: kind === 'claude' ? CLAUDE_GATEWAY_SLUG : CODEX_GATEWAY_SLUG,
      baseUrl: defaults.baseUrl,
      defaultModel: defaults.defaultModel,
      models: defaults.models,
    }
  }
  if (kind === 'cloud') {
    return {
      slug: NESTOR_CLOUD_AGENT_SLUG,
    }
  }

  // Pi card — mirror today's prefilled gateway APISetup submit exactly.
  const { customEndpoint, piAuthProvider } = resolveCustomEndpointPayload({
    activePreset: NESSY_GATEWAY_PRESET_KEY,
    baseUrl: NESSY_GATEWAY_BASE_URL,
    customApi: 'openai-completions',
    brandedOpenAiCompatPresets: OPENAI_COMPAT_PRESETS,
    brandedOpenAiCompatPresetOptions: OPENAI_COMPAT_PRESET_OPTIONS,
    fallbackPiAuthProvider: undefined,
  })

  // Upsert only into a CONFIRMED gateway connection (existingPiGatewaySlug,
  // resolved by createGatewayConnection from the live connection list).
  // 'pi-api-key' is the shared base slug for ALL manual custom-endpoint
  // connections, so a user's own connection may hold it — blind slug reuse
  // would overwrite their endpoint and key with gateway values. Without a
  // confirmed target the setup allocates a fresh (possibly suffixed) slug:
  // worst case a duplicate gateway card, never a clobbered personal connection.
  const editingSlug = existingPiGatewaySlug ?? null

  return apiSetupMethodToConnectionSetup(
    'pi_api_key',
    {
      baseUrl: NESSY_GATEWAY_BASE_URL,
      connectionDefaultModel: NESSY_GATEWAY_DEFAULT_MODEL,
      models: NESSY_GATEWAY_MODELS,
      piAuthProvider,
      modelSelectionMode: 'userDefined3Tier',
      customEndpoint,
    },
    editingSlug,
    existingSlugs,
  )
}

/**
 * Create (or upsert) the gateway connection via the existing SETUP RPC. The JWT
 * is fetched by the caller after `ensure()` resolves (via the getGatewayJwt
 * bridge) and passed in — no new credential path, and since DA1.13 no stored
 * copy either: the value proves the sign-in happened, and the card reads the
 * live file from then on.
 */
export async function createGatewayConnection(
  kind: GatewayKind,
  jwt: string,
  existingSlugs?: Set<string>,
): Promise<{ success: boolean; error?: string }> {
  // Resolve the live connection list to (a) allocate a non-colliding slug and
  // (b) find the existing Pi gateway connection to upsert into. Falls back to
  // the caller-provided slug set when the listing IPC is unavailable — an
  // unconfirmed base-slug holder is then treated as foreign (no upsert).
  let slugs = existingSlugs ?? new Set<string>()
  let piGatewaySlug: string | undefined
  try {
    const connections = await window.electronAPI.listLlmConnections()
    slugs = new Set(connections.map((c) => c.slug))
    piGatewaySlug = connections.find(
      (c) => c.providerType === 'pi_compat' && isNessyGatewayConnection(c),
    )?.slug
  } catch {
    // Listing unavailable (e.g. stale preload) — proceed without an upsert target.
  }
  const setup = buildGatewaySetup(kind, jwt, slugs, piGatewaySlug)
  const result = await window.electronAPI.setupLlmConnection(setup)
  return result
}

// Keep the model-id export reachable for consumers that only need the ids.
export { NESSY_GATEWAY_MODEL_IDS }
