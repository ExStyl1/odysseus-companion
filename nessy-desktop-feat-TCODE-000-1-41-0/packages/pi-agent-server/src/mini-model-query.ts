/**
 * UB4.9 — copied from craft-agents-oss `v0.15.1:packages/pi-agent-server/src/mini-model-query.ts`
 * (Apache-2.0, first shipped v0.13.6, unchanged through v0.15.1), with Nessy
 * additions: {@link isUtilityModelRouteAllowed} and its two users
 * {@link pickCustomEndpointUtilityModel} and (UB12.10, the main session's model)
 * {@link resolveRoutedSessionModel}.
 *
 * `queryLlm` (`index.ts`) already had a fallback loop (`fallbackCandidates`,
 * retried on `isModelNotFoundError`). What this module changes, measured against
 * that loop:
 *
 * - **The classifier is NARROWER, not wider.** `isModelRejectionError`
 *   (`model-resolution.ts`, UB4.3) is `isModelNotFoundError` AND (an unambiguous
 *   phrase, or the message names the refused model). The entitlement refusal
 *   ("The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT
 *   account.") already matched the old classifier through "is not supported";
 *   what the new one stops is the same phrase about something that is NOT the
 *   model ("The 'temperature' parameter is not supported") burning every
 *   candidate.
 * - **Two more candidates:** the session's own model, then the provider's
 *   preferred defaults (`PI_PREFERRED_DEFAULTS`).
 * - **One identity per model:** `pi/x` and `x` are the same candidate.
 *
 * Gateway ids: this subprocess holds no alias table (its `customModels` carry no
 * `shortName`), so the gateway's `fast`/`coder` aliases are resolved host-side
 * (`getMiniModel` asks `resolveGatewayFastModelId` first, P6.1080) and arrive here
 * as `miniModel`/`sessionModel` ids, which are tried verbatim — never re-pinned.
 */

import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';
import type { LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import { PI_PREFERRED_DEFAULTS } from '../../shared/src/config/llm-connections.ts';
import { stripPiPrefix } from './custom-endpoint-models.ts';
import { isDeniedMiniModelId, isModelRejectionError, resolvePiModel } from './model-resolution.ts';

interface MiniModelQueryOptions {
  model: string;
  miniModel?: string;
  sessionModel?: string;
  authProvider?: string;
  modelRegistry: PiModelRegistry;
  preferCustomEndpoint: boolean;
  onFallback?: (rejectedModel: string, retryModel: string) => void;
}

/**
 * NESSY (UB4.9, not upstream) — may a utility query run on a model that resolved
 * under `resolvedProvider`?
 *
 * Upstream's rule (the `else` arm): the authenticated provider, or the custom
 * endpoint. It is not enough on a CUSTOM-ENDPOINT connection — the Nessy Gateway
 * Pi card and every BYO endpoint — because there `authProvider` is only the wire
 * protocol (`'openai'` or `'anthropic'`, `resolveCustomEndpointSetup`) while the
 * built-in provider of that name is still registered at its public URL, and the
 * endpoint's credential is stored under the same name. Measured on the shipped Pi
 * catalogue with a gateway-shaped registry (2026-10-16): `pi/gpt-5-mini`, all
 * seven `PI_PREFERRED_DEFAULTS.openai` ids and the entry guard's provider default
 * `gpt-6-luna` each resolve to provider `openai` at `https://api.openai.com/v1` —
 * so a fallback would have sent the prompt and the gateway JWT there. On such a
 * connection only the endpoint's own models (`custom-endpoint`) qualify.
 */
export function isUtilityModelRouteAllowed(
  resolvedProvider: string | undefined,
  authProvider: string | undefined,
  preferCustomEndpoint: boolean,
): boolean {
  if (preferCustomEndpoint) return resolvedProvider === 'custom-endpoint';
  return !authProvider || resolvedProvider === authProvider || resolvedProvider === 'custom-endpoint';
}

/**
 * NESSY (UB4.9) — `queryLlm`'s FIRST-model fallback on a custom-endpoint
 * connection: the first of `candidates` (the host-resolved mini model, then the
 * session's model) that the endpoint itself serves. The provider-default pick
 * (`pickProviderAppropriateMiniModel`) and the Haiku default are public-API ids
 * there (see {@link isUtilityModelRouteAllowed}). `undefined` when no candidate
 * qualifies: the caller then keeps its model and the route refusal in
 * `runQueryWithModel` fails the query instead of sending it elsewhere.
 */
export function pickCustomEndpointUtilityModel(
  candidates: ReadonlyArray<string | undefined>,
  modelRegistry: PiModelRegistry,
  authProvider: string | undefined,
): string | undefined {
  return candidates.find((candidate): candidate is string => !!candidate
    && isUtilityModelRouteAllowed(resolvePiModel(modelRegistry, candidate, authProvider, true)?.provider, authProvider, true));
}

/**
 * NESSY (UB12.10, not upstream) — the MAIN session's model under the same route
 * rule as utility queries ({@link isUtilityModelRouteAllowed}). The three sites
 * that set it in `index.ts` — `buildSessionDefinition` (every session build: an
 * init, a child session's too, and a cwd candidate), `handleSetModel` and
 * `handleUpdateRuntimeConfig` — accepted whatever `resolvePiModel` returned, with
 * upstream's provider check at most. On a custom endpoint that check passes the
 * wire protocol's built-in provider, still registered at its public URL.
 * Measured on the shipped catalogue with a gateway-shaped registry (2026-10-16):
 * `gpt-5.5` and `pi/gpt-5-mini` resolve to `openai` at `https://api.openai.com/v1`
 * on an `openai`-wire endpoint, `claude-haiku-4-5` and `claude-sonnet-4-6` to
 * `anthropic` at `https://api.anthropic.com` on an `anthropic`-wire one, and
 * `getApiKeyAndHeaders` hands the public model the endpoint's stored credential.
 *
 * On a custom endpoint, a model the endpoint does not list is REGISTERED as the
 * endpoint's own (`registerOnEndpoint`, the branch `handleSetModel` has carried
 * since upstream for an id nothing resolves): the endpoint then serves the id or
 * refuses it, which is its answer to give. `undefined` — the caller's refusal —
 * when even that does not land on the endpoint. Off a custom endpoint this is
 * `resolvePiModel` under upstream's provider check, unchanged: with an
 * authenticated provider `resolvePiModel` returns only that provider's models or
 * the endpoint's, and without one the check allows any, so it never refuses what
 * `resolvePiModel` returns there.
 */
export function resolveRoutedSessionModel(
  modelRegistry: PiModelRegistry,
  modelId: string,
  authProvider: string | undefined,
  preferCustomEndpoint: boolean,
  registerOnEndpoint: (bareId: string) => void,
): ReturnType<typeof resolvePiModel> {
  const resolved = resolvePiModel(modelRegistry, modelId, authProvider, preferCustomEndpoint);
  if (resolved && isUtilityModelRouteAllowed(resolved.provider, authProvider, preferCustomEndpoint)) return resolved;
  if (!preferCustomEndpoint) return undefined;
  registerOnEndpoint(stripPiPrefix(modelId));
  const registered = resolvePiModel(modelRegistry, modelId, authProvider, true);
  return registered && isUtilityModelRouteAllowed(registered.provider, authProvider, true) ? registered : undefined;
}

/**
 * Run a utility query, retrying only model rejections within the authenticated provider.
 * A catalog entry can resolve locally yet be unavailable to a ChatGPT account (notably
 * gpt-5.4-mini). Keep cheap fallbacks first, then the selected session model and provider
 * defaults; never assume the first locally resolvable model is accepted by the account.
 * The caller retains the single request deadline/cancellation scope across all attempts.
 */
export async function queryMiniModel(
  options: MiniModelQueryOptions,
  runQuery: (model: string) => Promise<string>,
): Promise<LLMQueryResult> {
  const fallbackCandidates = [
    'pi/gpt-5-mini',
    options.miniModel,
    getDefaultSummarizationModel(),
    options.sessionModel,
    ...(options.authProvider ? PI_PREFERRED_DEFAULTS[options.authProvider] ?? [] : []),
  ].filter((candidate): candidate is string => !!candidate && !isDeniedMiniModelId(candidate, options.authProvider));

  const triedModels = new Set<string>();
  let currentModel = options.model;

  while (true) {
    triedModels.add(stripPiPrefix(currentModel));
    try {
      const text = await runQuery(currentModel);
      return { text, model: currentModel };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isModelRejectionError(message, stripPiPrefix(currentModel))) throw error;

      const retryModel = fallbackCandidates.find(candidate => {
        if (triedModels.has(stripPiPrefix(candidate))) return false;
        const resolved = resolvePiModel(options.modelRegistry, candidate, options.authProvider, options.preferCustomEndpoint);
        if (!resolved) return false;
        // NESSY (UB4.9): upstream's provider check, plus the custom-endpoint route rule.
        return isUtilityModelRouteAllowed(resolved.provider, options.authProvider, options.preferCustomEndpoint);
      });
      if (!retryModel) throw error;

      options.onFallback?.(currentModel, retryModel);
      currentModel = retryModel;
    }
  }
}
