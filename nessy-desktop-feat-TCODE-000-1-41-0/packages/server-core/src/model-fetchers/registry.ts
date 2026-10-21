/**
 * Model Fetcher Registry
 *
 * Type-safe map from FetchableProvider → ModelFetcher.
 * TypeScript enforces that every FetchableProvider key is present.
 * Adding a new fetchable LlmProviderType without registering a fetcher → compile error.
 */

import type { ModelFetcherMap, ModelFetcher, ModelFetchResult, ModelFetcherCredentials, LlmConnection } from '@nessy-agent/shared/config'
import { isNessyGatewayBaseUrl } from '@nessy-agent/shared/agent/backend'
import { AnthropicModelFetcher } from './anthropic'
import { PiModelFetcher } from './pi'
import { fetchNestorModels } from './nestor'

// Shared instances — fetchers are stateless
const anthropicFetcher = new AnthropicModelFetcher()
const piFetcher = new PiModelFetcher()

/**
 * Live model refresh for the two runtime providers that reach their endpoint
 * through the local adapter — `codex-runtime` and `claude-runtime`. Both may
 * point at ANY compatible endpoint, so both refresh from the Nestor
 * `/cli/models` API only when the connection IS the gateway. The distinct
 * setup-time paths are `codexDriver.fetchModels` / `anthropicDriver.fetchModels`
 * (they return already-configured models).
 *
 * The gate is {@link isNessyGatewayBaseUrl} — the same whole-URL match the
 * drivers use to decide whether `Nestor-Token` may be attached — and NOT the
 * `…/api/v1/cli/` prefix match of `isNestorConnection`. AGENTS.md: "Custom
 * endpoints, even on the same host with a different path, must retain normal
 * provider auth semantics" — under the prefix match a BYO endpoint at
 * `…/api/v1/cli/<other>/v1` was BYO for the adapter but "Nestor" here, so a
 * refresh posted the user's own key to the gateway as `Nestor-Token` and
 * overwrote their catalog with the gateway's.
 *
 * For a non-gateway endpoint we return an empty result, which
 * `ModelRefreshService._doRefresh` treats as "no models available from any
 * source" and leaves `connection.models` untouched.
 *
 * One class, one instance, both entries: two copies of "which URL is the
 * gateway" is exactly the drift that produced the hole above.
 */
class GatewayRuntimeModelFetcher implements ModelFetcher {
  readonly refreshIntervalMs = 60 * 60 * 1000
  async fetchModels(connection: LlmConnection, _credentials: ModelFetcherCredentials): Promise<ModelFetchResult> {
    if (!isNessyGatewayBaseUrl(connection.baseUrl)) {
      return { models: [] }
    }
    // DA1.3 — `_credentials` is the stored per-connection snapshot the
    // `ModelFetcher` interface hands every fetcher; the gateway catalogue
    // deliberately does not read it. `fetchNestorModels` authenticates from the
    // live dp creds, so the claude and codex gateway cards use exactly the
    // credential the Pi one does, and an absent or expired snapshot can no
    // longer put an empty `Nestor-Token` on the wire.
    return fetchNestorModels(connection)
  }
}
const gatewayRuntimeFetcher = new GatewayRuntimeModelFetcher()

/**
 * Every FetchableProvider MUST have a fetcher entry.
 * If you add a new fetchable LlmProviderType (e.g., 'gemini') and don't exclude
 * it from FetchableProvider, this object will fail to compile until you add it here.
 */
export const MODEL_FETCHERS: ModelFetcherMap = {
  anthropic: anthropicFetcher,
  pi:        piFetcher,
  'codex-runtime': gatewayRuntimeFetcher,
  'claude-runtime': gatewayRuntimeFetcher,
}
