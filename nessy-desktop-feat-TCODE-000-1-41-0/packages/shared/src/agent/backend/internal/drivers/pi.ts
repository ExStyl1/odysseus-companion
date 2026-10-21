import type { ProviderDriver, DriverTestConnectionArgs } from '../driver-types.ts';
import type { ModelDefinition } from '../../../../config/models.ts';
import { getAllPiModels, getPiModelsForAuthProvider, isDeprecatedClaudeOpus46Model } from '../../../../config/models-pi.ts';
import { getPiProviderBaseUrl } from '../../../../config/models-pi.ts';
import { resolveBackendHostTooling } from '../runtime-resolver.ts';
// ── Copilot model types ────────────────────────────────────────────────
type RawCopilotModel = {
  id: string;
  name: string;
  supportedReasoningEfforts?: string[];
  policy?: { state: string };
  contextWindow?: number;
};

// ── Direct HTTP approach ─────────────────────────────────────────────

/** Headers that identify us as a VS Code Copilot client (same as Pi SDK). */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

/** Extract API base URL from a Copilot API token's proxy-ep field. */
function getBaseUrlFromToken(token: string): string | null {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match?.[1]) return null;
  const apiHost = match[1].replace(/^proxy\./, 'api.');
  return `https://${apiHost}`;
}

/**
 * Fetch models directly from the Copilot API via HTTP.
 *
 * 1. Exchange GitHub OAuth token → Copilot API token (via Pi SDK)
 * 2. Extract base URL from token's proxy-ep field
 * 3. GET /models to list available models with policy state
 *
 * No CLI subprocess, no PATH issues, no env contamination.
 */
async function listModelsViaHttp(
  githubToken: string,
  timeoutMs: number,
): Promise<RawCopilotModel[]> {
  const { refreshGitHubCopilotCredential } = await import('../../pi/copilot-oauth.ts');

  // Step 1: Exchange GitHub OAuth token → Copilot API token
  const creds = await refreshGitHubCopilotCredential(githubToken);
  const copilotToken = creds.access;

  // Step 2: Extract base URL from token
  const baseUrl = getBaseUrlFromToken(copilotToken);
  if (!baseUrl) {
    throw new Error('Could not extract API base URL from Copilot token (missing proxy-ep)');
  }

  console.warn(`[listModelsViaHttp] token exchange OK, baseUrl=${baseUrl}`);

  // Step 3: GET /models
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${copilotToken}`,
        ...COPILOT_HEADERS,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Copilot API ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json() as Record<string, unknown>;
    // Handle both { models: [...] } and { data: [...] } response formats
    const models = (data.models || data.data || []) as Record<string, unknown>[];

    console.warn(`[listModelsViaHttp] GET /models returned ${models.length} models`);

    return models.map(m => ({
      id: m.id as string,
      name: (m.name || m.id) as string,
      supportedReasoningEfforts: (m.supportedReasoningEfforts || m.supported_reasoning_efforts) as string[] | undefined,
      policy: m.policy as { state: string } | undefined,
      contextWindow: ((m.capabilities as Record<string, unknown>)?.limits as Record<string, unknown>)?.max_context_window_tokens as number | undefined,
    }));
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('Copilot models API timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Model ID prefixes to exclude — legacy models that clutter the selector. */
const EXCLUDED_MODEL_PREFIXES = ['gpt-4', 'gpt-3.5'];

/** Filter raw models to only those explicitly enabled by policy, excluding legacy models. */
function filterEnabledModels(models: RawCopilotModel[]): RawCopilotModel[] {
  return models.filter(m =>
    m.policy?.state === 'enabled'
    && !EXCLUDED_MODEL_PREFIXES.some(prefix => m.id.startsWith(prefix))
    && !isDeprecatedClaudeOpus46Model(m.id),
  );
}

/** Convert raw Copilot models to our ModelDefinition format. */
function toModelDefinitions(models: RawCopilotModel[]): ModelDefinition[] {
  return models.map(m => ({
    id: m.id,
    name: m.name,
    shortName: m.name,
    description: '',
    provider: 'pi' as const,
    contextWindow: m.contextWindow || 200_000,
    supportsThinking: !!(m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0),
  }));
}

/** Log a breakdown of models by policy state. */
function logModelBreakdown(tag: string, models: RawCopilotModel[]): void {
  const byState = new Map<string, string[]>();
  for (const m of models) {
    const state = m.policy?.state ?? 'no-policy';
    const list = byState.get(state) ?? [];
    list.push(m.id);
    byState.set(state, list);
  }
  const breakdown = [...byState.entries()].map(([s, ids]) => `${s}=${ids.length}(${ids.join(',')})`).join('; ');
  console.warn(`[fetchCopilotModels] ${tag}: total=${models.length} enabled=${filterEnabledModels(models).length} | ${breakdown}`);
}

/**
 * Fetch Copilot models with a 2-tier fallback chain:
 *
 * 1. **Direct HTTP API** – exchange the Pi SDK's GitHub OAuth token for
 *    a Copilot API token, then GET /models. Returns the live model list
 *    with policy state, so we show only enabled models. No CLI subprocess,
 *    no PATH issues, no env contamination.
 * 2. **Pi SDK static catalog** – hardcoded model registry shipped with
 *    the Pi SDK. Not filtered by the user's policy but always available
 *    as a last resort.
 */
async function fetchCopilotModels(
  piSdkGitHubToken: string,
  timeoutMs: number,
): Promise<ModelDefinition[]> {

  // ── Tier 1: Direct HTTP API ──────────────────────────────────────
  try {
    const raw = await listModelsViaHttp(piSdkGitHubToken, timeoutMs);
    if (raw.length > 0) {
      logModelBreakdown('tier1-httpApi', raw);
      const enabled = filterEnabledModels(raw);
      if (enabled.length > 0) {
        return toModelDefinitions(enabled);
      }
      // All models disabled by policy — unusual but possible.
      // Log it clearly and fall through to static catalog.
      console.warn(`[fetchCopilotModels] tier1-httpApi: ${raw.length} models returned but 0 enabled by policy`);
    }
  } catch (err) {
    console.warn(`[fetchCopilotModels] tier1-httpApi failed: ${(err as Error).message}`);
  }

  // ── Tier 2: Pi SDK static catalog (last resort) ──────────────────
  const staticModels = getPiModelsForAuthProvider('github-copilot');
  if (staticModels.length > 0) {
    console.warn(`[fetchCopilotModels] tier2-staticCatalog: falling back to ${staticModels.length} Pi SDK models`);
    return staticModels;
  }

  throw new Error('No Copilot models available from any source.');
}

/**
 * Lightweight direct HTTP test for Pi providers that expose an Anthropic-compatible
 * messages endpoint. Avoids spawning a full Pi subprocess (which can exceed the
 * 20s test timeout due to SDK initialization overhead).
 */
async function testAnthropicCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    });

    if (res.ok) return { success: true };

    const text = await res.text().catch(() => '');
    return { success: false, error: `${res.status} ${text}`.slice(0, 500) };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, error: 'Connection test timed out' };
    }
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify an OpenAI-compatible `GET /v1/models` probe by HTTP status.
 *
 * Philosophy: a reachable, authenticating endpoint = connection OK. We deliberately
 * do NOT require a successful chat completion here (that path false-negatives when a
 * working model returns empty text — see #783). Only auth (401/403) and service/
 * network failures (5xx) are treated as failure.
 *
 * - 401/403       → auth failure (bad or missing key)
 * - 5xx           → service error / unreachable upstream
 * - other 4xx     → endpoint reachable but the probe route is unhappy — 404/405
 *                   (route absent on vLLM subpaths/gateways), 400 (rejects a bare
 *                   GET), 429 (throttled but up + authenticating) → reachable = pass
 * - 2xx/3xx       → reachable + authorized = pass
 */
export function classifyModelsProbe(status: number): { success: boolean; error?: string } {
  if (status === 401 || status === 403) {
    return { success: false, error: `Authentication failed (${status}). Check your API key.` };
  }
  if (status >= 500) {
    return { success: false, error: `Endpoint returned a service error (${status}).` };
  }
  return { success: true };
}

/**
 * Lightweight direct HTTP test for OpenAI-compatible endpoints. Probes `GET /v1/models`
 * rather than running a chat completion, so a reachable+authorized endpoint passes even
 * when a working model would return empty mini-completion text (#783). Avoids spawning a
 * full Pi subprocess (which can exceed the 20s test timeout).
 */
async function testOpenAiCompatible(
  apiKey: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    return classifyModelsProbe(res.status);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, error: 'Connection test timed out' };
    }
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export const piDriver: ProviderDriver = {
  provider: 'pi',
  buildRuntime: ({ context, providerOptions, resolvedPaths, hostRuntime }) => ({
    paths: {
      piServer: resolvedPaths.piServerPath,
      interceptor: resolvedPaths.interceptorBundlePath,
      node: resolvedPaths.nodeRuntimePath, ...(hostRuntime ? { ripgrep: resolveBackendHostTooling(hostRuntime).ripgrepPath } : {}), // F1.727 · the search service's own rg
    },
    piAuthProvider: providerOptions?.piAuthProvider || context.connection?.piAuthProvider,
    baseUrl: context.connection?.baseUrl,
    customEndpoint: context.connection?.customEndpoint,
    // P6.367 — this mapper WHITELISTS by name, which is why the row needed it:
    // an operator's `supportsThinking` on a connection model reached nothing,
    // because a field this list does not mention is dropped here in silence.
    // The identical whitelist in `SessionManager`'s runtime builder is the other
    // half; both must name a capability or neither does.
    customModels: context.connection?.models?.map(m => {
      if (typeof m === 'string') return m;
      const supportsImages = typeof m.supportsImages === 'boolean'
        ? m.supportsImages
        : undefined;
      const supportsThinking = typeof m.supportsThinking === 'boolean'
        ? m.supportsThinking
        : undefined;
      // DA1.22 — the catalogue's published sampling params, the third name this
      // whitelist has had to learn. Object-shaped and non-empty only: an empty
      // object would read downstream as "the catalogue recommended something".
      const samplingParams = m.samplingParams
        && typeof m.samplingParams === 'object'
        && !Array.isArray(m.samplingParams)
        && Object.keys(m.samplingParams).length > 0
        ? m.samplingParams
        : undefined;
      if (m.contextWindow || supportsImages !== undefined || supportsThinking !== undefined || samplingParams) {
        return {
          id: m.id,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(supportsImages !== undefined ? { supportsImages } : {}),
          ...(supportsThinking !== undefined ? { supportsThinking } : {}),
          ...(samplingParams ? { samplingParams } : {}),
        };
      }
      return m.id;
    }),
  }),
  fetchModels: async ({ connection, credentials, timeoutMs }) => {
    // Copilot OAuth: fetch models directly from the Copilot API via HTTP.
    // Uses the GitHub OAuth token (our refreshToken) to exchange for a
    // Copilot API token, then queries GET /models for the live model list.
    const copilotGitHubToken = credentials.oauthRefreshToken || credentials.oauthAccessToken;
    if (connection.piAuthProvider === 'github-copilot' && copilotGitHubToken) {
      const models = await fetchCopilotModels(copilotGitHubToken, timeoutMs);
      return { models };
    }

    // All other Pi providers: use static Pi SDK model registry
    const models = connection.piAuthProvider
      ? getPiModelsForAuthProvider(connection.piAuthProvider)
      : getAllPiModels();

    if (models.length === 0) {
      throw new Error(
        `No Pi models found for provider: ${connection.piAuthProvider ?? 'all'}`,
      );
    }

    return { models };
  },
  testConnection: async (args: DriverTestConnectionArgs): Promise<{ success: boolean; error?: string } | null> => {
    const piAuthProvider = args.connection?.piAuthProvider;

    // Custom OpenAI-compatible endpoints route by customEndpoint.api and may have
    // no piAuthProvider. A reachable + authorized endpoint passes without a
    // completion (chat can work even when a mini-completion returns empty — #783).
    if (args.connection?.customEndpoint?.api === 'openai-completions') {
      const customBaseUrl = args.baseUrl?.trim();
      if (customBaseUrl) {
        return testOpenAiCompatible(args.apiKey, customBaseUrl, args.timeoutMs);
      }
      // No base URL to probe — let factory.ts handle it via subprocess
      return null;
    }

    if (!piAuthProvider) {
      // No provider hint — fall back to generic subprocess path
      return null;
    }

    // Resolve the model's API type from the Pi SDK registry.
    // For anthropic-messages / openai-completions providers, do a lightweight direct
    // HTTP test instead of spawning a full Pi subprocess (which can exceed the timeout).
    let modelApi: string | undefined;
    let modelBaseUrl: string | undefined;
    try {
      const { getModels } = await import('@earendil-works/pi-ai/compat');
      const models = getModels(piAuthProvider as Parameters<typeof getModels>[0]);
      const requestedId = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
      const match = models.find(m => m.id === requestedId) || models[0];
      if (match) {
        modelApi = (match as { api?: string }).api;
        modelBaseUrl = (match as { baseUrl?: string }).baseUrl;
      }
    } catch { /* ignore — fall through to subprocess */ }

    const baseUrl = args.baseUrl?.trim() || modelBaseUrl || getPiProviderBaseUrl(piAuthProvider);

    if (modelApi === 'openai-completions') {
      if (!baseUrl) {
        return { success: false, error: 'Could not determine API endpoint for provider' };
      }
      return testOpenAiCompatible(args.apiKey, baseUrl, args.timeoutMs);
    }

    if (modelApi !== 'anthropic-messages') {
      // Unknown API types need the full Pi SDK — let factory.ts handle it
      return null;
    }

    if (!baseUrl) {
      return { success: false, error: 'Could not determine API endpoint for provider' };
    }

    // Strip Pi SDK's 'pi/' prefix — Anthropic-compatible endpoints only accept bare model IDs
    let bareModel = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
    // MiniMax CN API doesn't accept the 'MiniMax-' prefix on model names
    if (piAuthProvider === 'minimax-cn' && bareModel.startsWith('MiniMax-')) {
      bareModel = bareModel.slice('MiniMax-'.length);
    }
    return testAnthropicCompatible(args.apiKey, baseUrl, bareModel, args.timeoutMs);
  },
  validateStoredConnection: async () => ({ success: true }),
};
