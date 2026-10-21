import type { ProviderDriver, StoredConnectionValidationResult } from '../driver-types.ts';
import { applyAnthropicRuntimeBootstrap } from '../runtime-resolver.ts';
import { validateAnthropicConnection } from '../../../../config/llm-validation.ts';
import { DEFAULT_MODEL, getModelById, getModelContextWindow, normalizeDeprecatedModelId, type ModelDefinition } from '../../../../config/models.ts';
import { isLocalConnection } from '../../../../config/llm-connections.ts';
import type { LlmConnection } from '../../../../config/storage.ts';
import type { CredentialManager } from '../../../../credentials/manager.ts';
import type { UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';
// The gateway whole-URL match and the credential read are shared with
// `codex-runtime` (drivers/codex.ts) — the reason lives on that module.
import { attachUpstreamCredential, isNessyGatewayBaseUrl, normalizeUpstreamBaseUrl } from './upstream-target.ts';

/**
 * Where a `claude-runtime` session's local Anthropic-Messages adapter posts
 * turns — **without** the secret, which is a per-session credential read rather
 * than a config value (see {@link resolveClaudeRuntimeUpstream}).
 *
 * Callers must already know the connection is `claude-runtime`; this decides
 * only *which upstream mode* it gets. Throws rather than guessing when the
 * connection carries no endpoint: a `claude-runtime` session that silently fell
 * back to `api.anthropic.com` would send the user's gateway turns to Anthropic.
 */
export function buildClaudeRuntimeUpstream(
  connection: Pick<LlmConnection, 'baseUrl' | 'name' | 'customEndpoint'>,
): UpstreamTarget {
  const baseUrl = normalizeUpstreamBaseUrl(connection.baseUrl);
  if (isNessyGatewayBaseUrl(baseUrl)) return { kind: 'nestor' };
  if (!baseUrl) {
    throw new Error(`Claude runtime connection "${connection.name}" has no endpoint URL configured`);
  }
  // P6.258: which header the endpoint reads its key from. Absent on every
  // connection that has never set it, and `undefined` means `authorization`, so
  // this line changes no existing session. The gateway arm above is deliberately
  // NOT reachable from here — `Nestor-Token` is the one scheme it may carry.
  return { kind: 'openai-compatible', baseUrl, credentialHeader: connection.customEndpoint?.credentialHeader };
}

/**
 * {@link buildClaudeRuntimeUpstream} plus the connection credential
 * ({@link attachUpstreamCredential} — gateway mode never reads one).
 */
export async function resolveClaudeRuntimeUpstream(args: {
  connection: Pick<LlmConnection, 'baseUrl' | 'name'>;
  slug: string;
  credentialManager: Pick<CredentialManager, 'getLlmApiKey'>;
}): Promise<UpstreamTarget> {
  return attachUpstreamCredential({
    target: buildClaudeRuntimeUpstream(args.connection),
    slug: args.slug,
    credentialManager: () => args.credentialManager,
  });
}

/**
 * One model, one key — the trailing selector a caller may have appended removed.
 *
 * Exported so the ROUTING decision and anything that has to agree with it read
 * the same rule from one place (P3.319). Sliced at the first `[` and never at
 * index 0, so an id that merely opens with a bracket is left whole rather than
 * normalised to the empty string — the same shape, deliberately, as
 * `claude-model-capabilities.ts`'s private `normalizeModelKey`; see the router's
 * docblock for why the case-folding half of that function is not copied.
 */
export function stripClaudeModelSelectorSuffix(model: string): string {
  const trimmed = model.trim();
  const selector = trimmed.indexOf('[');
  return selector > 0 ? trimmed.slice(0, selector) : trimmed;
}

/**
 * Per-request wire routing for a `claude-runtime` session's local adapter (G3).
 *
 * One connection can hold models on two wires: llm-proxy serves a Qwen over
 * chat-completions and `anthropic/*` over Anthropic Messages, from the same
 * base URL and the same key. So the wire cannot be a session-level setting —
 * the adapter asks this per request, with the model the SDK actually named.
 *
 * Returns `undefined` for every model that is not explicitly marked, which is
 * the whole existing world: the caller then uses the session upstream and
 * nothing about its behaviour changes.
 *
 * GATEWAY MODE ROUTES NOTHING. `kind: 'nestor'` is the corp gateway, which
 * publishes no Anthropic Messages endpoint and authenticates by `Nestor-Token`
 * rather than a bearer; handing it a passthrough target would send a turn to a
 * URL that does not exist. The router only exists for BYO endpoints.
 *
 * ## P3.319 — the id the SDK names is not always the id the catalogue spells
 *
 * The lookup used to be an exact `Set.has` against the catalogue's own
 * spelling, and `claude-agent.ts` appends `[1m]` per query for a model whose
 * window is 1M or more (`claudeModelWithWindowSelector`). So the match missed **exactly
 * where it mattered most**: a BYO `claude-opus-4-6` marked
 * `wire: 'anthropic-messages'` — a model whose endpoint speaks Messages
 * natively — arrived here as `claude-opus-4-6[1m]`, missed the set, and was
 * rewritten through the OpenAI-wire translator. Silently: no diagnostic, a
 * different translation of every content block, and the literal `…[1m]` id
 * forwarded to an endpoint that does not know it. Measured 2026-09-03:
 * `getModelContextWindow('claude-opus-4-6')` is `1_000_000`, against `200_000` for `claude-sonnet-4-6`
 * then (1M since F1.1221, re-read 2026-10-09) and `undefined` for a prefixed or unknown id — so the
 * reachable case is a BYO catalogue listing a **bare** Anthropic id the registry
 * scores at 1M. P3.314's WebSearch withholding then keys on this same router, so
 * that model also lost a tool its own endpoint serves.
 *
 * Normalised on BOTH sides rather than only the query, which is the half easy to
 * miss: a catalogue id may itself carry a selector (`tgpt/qwen35[1m]` is a real
 * gateway-alias shape — see `claude-1m-context-correction-env.test.ts`), and
 * stripping only the incoming id would break that pairing while fixing this one.
 * Every spelling of one model therefore resolves to one key, in both directions.
 *
 * ONE CONSEQUENCE THE ROW DID NOT NAME, written here rather than left to be
 * discovered: a catalogue holding BOTH spellings of one model, with only the
 * suffixed one marked, now routes the bare one natively too. That follows from
 * the premise the fix rests on — one model, one wire — but it is a behaviour
 * change on an input nobody measured, so it is stated at the site.
 *
 * The rule is deliberately the SAME one `claude-model-capabilities.ts`'s
 * `normalizeModelKey` already applies — *"the `[1m]` suffix is a MODEL SELECTOR,
 * not a different model"*, sliced at the first `[` — because both functions are
 * answering *which model is this id naming*, and two answers to one question is
 * how this tree grows a defect it cannot see. What is NOT copied is that
 * function's `toLowerCase()`: it needs case-insensitive lookup for a capability
 * row, while a wire id is matched against the catalogue the user wrote and
 * folding case here would silently pair two ids the endpoint treats as distinct.
 */
export function buildClaudeRuntimeWireRouter(
  connection: Pick<LlmConnection, 'models'>,
  upstream: UpstreamTarget,
): ((model: string) => UpstreamTarget | undefined) | undefined {
  if (upstream.kind !== 'openai-compatible') return undefined;
  const anthropicWire = new Set(
    (connection.models ?? [])
      .filter((entry): entry is ModelDefinition =>
        typeof entry !== 'string' && entry.wire === 'anthropic-messages')
      .map(entry => stripClaudeModelSelectorSuffix(entry.id)),
  );
  if (anthropicWire.size === 0) return undefined;
  const passthrough: UpstreamTarget = {
    kind: 'anthropic-messages',
    baseUrl: upstream.baseUrl,
    ...(upstream.apiKey ? { apiKey: upstream.apiKey } : {}),
  };
  return (model: string) => (
    anthropicWire.has(stripClaudeModelSelectorSuffix(model)) ? passthrough : undefined
  );
}

/**
 * Structural validation for a `claude-runtime` connection.
 *
 * Deliberately NOT a probe. The stored `baseUrl` is an OpenAI-shaped
 * chat/completions endpoint that only the local adapter knows how to speak, so
 * pointing the direct Claude SDK at it (what the `anthropic` arm of
 * `validateStoredConnection` does via `validateAnthropicConnection`) reports a
 * healthy gateway connection as broken. Probing it for real means
 * starting an adapter and spending a gateway turn for every stored connection
 * at startup — the same disproportion `codexDriver.validateStoredConnection`
 * already declines ("a real turn is the true test").
 */
async function validateClaudeRuntimeConnection(args: {
  slug: string;
  connection: LlmConnection;
  credentialManager: Pick<CredentialManager, 'getLlmApiKey'>;
}): Promise<StoredConnectionValidationResult> {
  let upstream: UpstreamTarget;
  try {
    upstream = buildClaudeRuntimeUpstream(args.connection);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Gateway mode: the adapter resolves dp creds per turn and answers 401 itself.
  // Reading them here would add a second reader of a file this repo keeps to one.
  if (upstream.kind === 'nestor' || args.connection.authType === 'none') {
    return { success: true };
  }
  const apiKey = await args.credentialManager.getLlmApiKey(args.slug);
  if (!apiKey) {
    return { success: false, error: `Could not retrieve credentials for: ${args.slug}` };
  }
  return { success: true };
}

/**
 * Setup-form Test button for a `claude-runtime` connection.
 *
 * `testBackendConnection` (factory.ts) builds a synthetic connection, sets a raw
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` and runs `runMiniCompletion`
 * WITHOUT calling `postInit` — for this provider type that points the direct
 * Claude SDK at an OpenAI-shaped endpoint only the local adapter speaks, and
 * reports a healthy gateway connection as broken. So the same structural check
 * T6 gave {@link validateClaudeRuntimeConnection} answers here instead; the two
 * differ only in where the credential comes from (this path is handed the key
 * the user just typed, before any slug exists to store it under).
 *
 * Returning `null` for every other connection leaves the direct-`anthropic`
 * behavior exactly as it was.
 */
async function testClaudeRuntimeConnection(args: {
  apiKey: string;
  baseUrl?: string;
}): Promise<{ success: boolean; error?: string }> {
  let upstream: UpstreamTarget;
  try {
    upstream = buildClaudeRuntimeUpstream({ baseUrl: args.baseUrl, name: 'Claude Code (setup test)' });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Gateway mode: the adapter resolves dp creds per turn and answers 401 itself.
  if (upstream.kind === 'nestor') return { success: true };
  // Mirrors `setupTestRequiresApiKey`: only a non-loopback endpoint must be keyed.
  if (!args.apiKey.trim() && !isLocalConnection({ baseUrl: upstream.baseUrl })) {
    return { success: false, error: 'API key is required for this endpoint' };
  }
  return { success: true };
}

export const anthropicDriver: ProviderDriver = {
  provider: 'anthropic',
  initializeHostRuntime: ({ hostRuntime, resolvedPaths }) => {
    // Set paths opportunistically — don't throw on missing.
    // Missing paths will be caught at session start (prepareRuntime).
    applyAnthropicRuntimeBootstrap(hostRuntime, resolvedPaths, { strict: false });
  },
  prepareRuntime: ({ hostRuntime, resolvedPaths }) => {
    applyAnthropicRuntimeBootstrap(hostRuntime, resolvedPaths);
  },
  buildRuntime: () => ({}),
  fetchModels: async ({ connection, credentials, timeoutMs }) => {
    // A `claude-runtime` connection reaches this driver (T4 — same
    // AgentProvider), and everything below is Anthropic-only: it would GET
    // `<its endpoint>/v1/models` with the connection credential in `x-api-key`,
    // i.e. the Nestor JWT at the gateway. Its live refresh is server-core's
    // gateway-aware `MODEL_FETCHERS['claude-runtime']`; here we answer with the
    // catalog already on the connection and never touch the network, mirroring
    // `codexDriver.fetchModels`. Never throws — an empty list is valid.
    if (connection.providerType === 'claude-runtime') {
      return {
        models: (connection.models ?? []) as ModelDefinition[],
        serverDefault: connection.defaultModel,
      };
    }

    // iam_credentials and service_account_file are no longer valid auth types
    // for anthropic.
    const apiKey = credentials.apiKey;
    const oauthAccessToken = credentials.oauthAccessToken;

    if (!apiKey && !oauthAccessToken) {
      throw new Error('Anthropic credentials required to fetch models');
    }

    const baseUrl = connection.baseUrl || 'https://api.anthropic.com';
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    } else {
      headers.authorization = `Bearer ${oauthAccessToken}`;
    }

    const allRawModels: Array<{
      id: string;
      display_name: string;
      created_at: string;
      type: string; max_input_tokens?: number | null;
    }> = [];
    let afterId: string | undefined;

    do {
      const params = new URLSearchParams({ limit: '100' });
      if (afterId) params.set('after_id', afterId);

      // llm-gateway-protocol.md:159 — a redirect on the model-list endpoint is
      // a failure, never followed: the credential header (`x-api-key` here)
      // would be replayed to the redirect target verbatim. The per-request
      // timeout wires the `timeoutMs` every server-core fetcher supplies
      // (previously threaded in and silently ignored). Both reject, and the
      // existing throw path already funnels failures to the refresh catch.
      const response = await fetch(`${baseUrl}/v1/models?${params}`, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Anthropic /v1/models failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as {
        data: Array<{ id: string; display_name: string; created_at: string; type: string; max_input_tokens?: number | null }>;
        has_more: boolean;
        first_id: string;
        last_id: string;
      };
      if (data.data) allRawModels.push(...data.data);

      if (data.has_more && data.last_id) {
        afterId = data.last_id;
      } else {
        break;
      }
    } while (true);

    if (allRawModels.length === 0) {
      throw new Error('No models returned from Anthropic API');
    }

    const seen = new Set<string>();
    const models = allRawModels
      .filter(m => m.id.startsWith('claude-') && !m.id.startsWith('claude-2') && !m.id.startsWith('claude-instant') && !m.id.startsWith('claude-1'))
      // The live Anthropic API can still list deprecated models. Do not persist
      // them back into active connection catalogs at startup.
      .filter(m => normalizeDeprecatedModelId(m.id) === m.id)
      .filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .map(m => {
        const registryModel = getModelById(m.id);
        return {
          id: m.id,
          name: registryModel?.name ?? m.display_name,
          shortName: registryModel?.shortName ?? (() => {
            const stripped = m.id
              .replace('claude-', '')
              .replace(/-\d{8}$/, '')
              .replace(/-latest$/, '');
            const variant = stripped
              .replace(/^[\d.-]+/, '')
              .replace(/-[\d.]+$/, '')
              .replace(/^-/, '');
            return variant ? variant.charAt(0).toUpperCase() + variant.slice(1) : stripped;
          })(),
          description: registryModel?.description ?? '',
          descriptionKey: registryModel?.descriptionKey,
          provider: 'anthropic' as const,
          // F1.1214 — native first: the Models API states each model's window
          // ("`max_input_tokens: number or null` — Maximum input context window
          // size in tokens for this model", platform.claude.com/docs/en/api/models/list.md),
          // so a model released after this build is not listed at 200K. Then the
          // registry, then 200K. A non-positive or non-integer value (the page's
          // own example prints `0`) is "not told", never a window.
          contextWindow: (Number.isInteger(m.max_input_tokens) && (m.max_input_tokens as number) > 0
            ? m.max_input_tokens as number
            : undefined) ?? getModelContextWindow(m.id) ?? 200_000,
          supportsThinking: registryModel?.supportsThinking,
          supportsImages: registryModel?.supportsImages,
        };
      });

    return {
      models,
      serverDefault: models.some(m => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : models[0]?.id,
    };
  },
  testConnection: async ({ apiKey, baseUrl, connection }) => (
    connection?.providerType === 'claude-runtime'
      ? testClaudeRuntimeConnection({ apiKey, baseUrl })
      : null
  ),
  validateStoredConnection: async ({ slug, connection, credentialManager }) => {
    // TWO provider types reach this driver: direct 'anthropic' (api.anthropic.com
    // or an Anthropic-shaped custom endpoint) and 'claude-runtime' (T4), which
    // maps to the same AgentProvider but speaks to its endpoint only through the
    // local adapter. They cannot share a validation strategy — the reason lives
    // on `validateClaudeRuntimeConnection`.
    if (connection.providerType === 'claude-runtime') {
      return validateClaudeRuntimeConnection({ slug, connection, credentialManager });
    }

    if (connection.providerType === 'anthropic' && connection.authType === 'oauth') {
      const { getValidClaudeOAuthToken } = await import('../../../../auth/state.ts');
      const tokenResult = await getValidClaudeOAuthToken(slug);
      if (!tokenResult.accessToken) {
        const errorMsg = tokenResult.migrationRequired?.message || 'OAuth token expired. Please re-authenticate.';
        return { success: false, error: errorMsg };
      }
      return { success: true };
    }

    let apiKey: string | null = null;
    let oauthToken: string | null = null;

    if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint') {
      apiKey = await credentialManager.getLlmApiKey(slug);
    } else if (connection.authType === 'bearer_token') {
      oauthToken = await credentialManager.getLlmApiKey(slug);
    } else if (connection.authType === 'environment') {
      apiKey = process.env.ANTHROPIC_API_KEY || null;
      if (!apiKey) {
        return { success: false, error: 'ANTHROPIC_API_KEY environment variable not set' };
      }
    } else if (connection.authType === 'none') {
      apiKey = 'ollama';
    }

    if (!apiKey && !oauthToken && connection.authType !== 'none') {
      return { success: false, error: 'Could not retrieve credentials' };
    }

    // Not asserted non-null: a connection whose catalog was never seeded (or was
    // cleared by a managed-model allowlist) reaches here with no default, and the
    // SDK probe below would fail with an opaque model error instead of naming the
    // real problem.
    const testModel = connection.defaultModel;
    if (!testModel) {
      return { success: false, error: `No default model configured for connection: ${slug}` };
    }
    const validationResult = await validateAnthropicConnection({
      model: testModel,
      apiKey: apiKey || undefined,
      oauthToken: oauthToken || undefined,
      baseUrl: connection.baseUrl || undefined,
    });

    if (!validationResult.success) {
      return { success: false, error: validationResult.error };
    }

    return { success: true };
  },
};
