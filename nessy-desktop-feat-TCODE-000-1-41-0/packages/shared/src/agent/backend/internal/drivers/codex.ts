/**
 * codexDriver — the `ProviderDriver` for `providerType: 'codex-runtime'`.
 *
 * `buildRuntime` passes through the resolver's `codexBinaryPath` (canonical
 * resolution lives in `runtime-resolver.ts:resolveCodexBinaryPath`, Phase 6) +
 * the session-mcp-server launcher paths, and classifies the connection's
 * endpoint into the `UpstreamTarget` the session's adapter and `queryLlm` both
 * run on (C1). `fetchModels` returns the connection's
 * already-configured models (setup-time path) and MUST NOT throw (addendum 6) —
 * the live refresh runs via server-core's `MODEL_FETCHERS['codex-runtime']`.
 */
import type { ProviderDriver } from '../driver-types.ts';
import type { ModelDefinition } from '../../../../config/models.ts';
import type { LlmConnection } from '../../../../config/storage.ts';
import { isLocalConnection } from '../../../../config/llm-connections.ts';
import type { UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';
import { isNessyGatewayBaseUrl, normalizeUpstreamBaseUrl } from './upstream-target.ts'; import { resolveBackendHostTooling } from '../runtime-resolver.ts';

/**
 * Where a `codex-runtime` session's local adapter sends turns — **without** the
 * secret, which is a per-session credential read the agent performs
 * (`attachUpstreamCredential`).
 *
 * Unlike {@link import('./anthropic.ts').buildClaudeRuntimeUpstream}, a missing
 * endpoint resolves to the gateway rather than throwing. The two differ because
 * their fallbacks differ: an endpoint-less `claude-runtime` session would fall
 * through to `api.anthropic.com` and bill a third party, whereas every codex
 * session ever run has gone to the Nessy Gateway — that IS this runtime's
 * historical default, and keeping it makes the C1 change byte-identical for
 * gateway cards (whose one-click creation flow seeds no endpoint of its own).
 */
export function buildCodexRuntimeUpstream(
  connection: Pick<LlmConnection, 'baseUrl' | 'customEndpoint'> | null | undefined,
): UpstreamTarget {
  const baseUrl = normalizeUpstreamBaseUrl(connection?.baseUrl);
  if (!baseUrl || isNessyGatewayBaseUrl(baseUrl)) return { kind: 'nestor' };
  // P6.585 · the twin of the line in `buildClaudeRuntimeUpstream`, and it lands
  // with the sink widening in `codex-agent.ts` rather than before it: an
  // `x-api-key` codex session whose auth-scheme ring could not name the scheme
  // is worse than one that cannot happen. `undefined` means `authorization`, so
  // no existing connection changes, and the gateway arm returns above — the
  // field is structurally unreachable there, where it would be most dangerous.
  return { kind: 'openai-compatible', baseUrl, credentialHeader: connection?.customEndpoint?.credentialHeader };
}

/**
 * Setup-form Test button for a `codex-runtime` connection (C3).
 *
 * Structural, not a probe — the same call the T6 `claude-runtime` arm makes
 * (`drivers/anthropic.ts:testClaudeRuntimeConnection`) and for the same two
 * reasons. The generic fallback in `testBackendConnection` builds a real
 * `CodexAgent` and runs `runMiniCompletion`, which for this runtime means
 * resolving the packaged `codex` binary and spending a turn on the user's
 * endpoint just to answer "is this configured"; and until C3 the driver was not
 * reachable from the RPC path at all, so nothing was gained by declining.
 *
 * Returning `null` is no longer an option for this driver: it is only ever
 * called for `codex-runtime` (its `AgentProvider` has exactly one providerType),
 * so a decline can only mean the expensive fallback.
 */
async function testCodexRuntimeConnection(args: {
  apiKey: string;
  baseUrl?: string;
}): Promise<{ success: boolean; error?: string }> {
  const upstream = buildCodexRuntimeUpstream({ baseUrl: args.baseUrl });
  // Gateway mode: the adapter resolves dp creds per turn and answers 401 itself.
  if (upstream.kind === 'nestor') return { success: true };
  // Mirrors `setupTestRequiresApiKey`: only a non-loopback endpoint must be keyed.
  if (!args.apiKey.trim() && !isLocalConnection({ baseUrl: upstream.baseUrl })) {
    return { success: false, error: 'API key is required for this endpoint' };
  }
  return { success: true };
}

/**
 * The context window of the model this session will spawn on, when the catalogue
 * carries one. Absent otherwise — codex then keeps its own default, which is
 * honest, where a fabricated number would not be.
 */
function resolveCodexContextWindow(
  context: { connection: LlmConnection | null; resolvedModel: string },
): { contextWindow: number } | undefined {
  const entry = context.connection?.models?.find(
    (model): model is ModelDefinition => typeof model !== 'string' && model.id === context.resolvedModel,
  );
  const window = entry?.contextWindow;
  return typeof window === 'number' && Number.isFinite(window) && window > 0
    ? { contextWindow: Math.floor(window) }
    : undefined;
}

export const codexDriver: ProviderDriver = {
  provider: 'codex-runtime',

  buildRuntime: ({ context, resolvedPaths, hostRuntime }) => ({
    paths: {
      codexBinary: resolvedPaths.codexBinaryPath,
      // Bundled session-mcp-server + its node launcher, for [mcp_servers.session].
      sessionServer: resolvedPaths.sessionServerPath,
      node: resolvedPaths.nodeRuntimePath, ...(hostRuntime?.appRootPath ? { ripgrep: resolveBackendHostTooling(hostRuntime).ripgrepPath } : {}), // F1.1301 · the rg the codex shell reaches (as Pi's, F1.727)
    },
    // No `baseUrl` here on purpose: `upstream` already carries the endpoint in
    // the only form anything reads, and a second copy is a second answer to
    // "where does this session send turns" (C1 left the redundant field behind;
    // nothing consumed it — `getBackendRuntime(...).baseUrl` has no readers).
    upstream: buildCodexRuntimeUpstream(context.connection),
    // The spawn model's synced window → `model_context_window` in config.toml.
    // Without it codex meters against its own default for an id it has never
    // heard of, which is the same lie F1 removed from the Pi side.
    ...(resolveCodexContextWindow(context) ?? {}),
  }),

  // Setup-time model list: the Nestor list already stored on the connection.
  // Never throws (addendum 6) — an empty list is valid; the registry fetcher refreshes it.
  fetchModels: async ({ connection }) => ({
    models: (connection.models ?? []) as ModelDefinition[],
    serverDefault: connection.defaultModel,
  }),

  // A real turn is the true test; do not spawn app-server just to validate.
  validateStoredConnection: async () => ({ success: true }),

  testConnection: async ({ apiKey, baseUrl }) => testCodexRuntimeConnection({ apiKey, baseUrl }),
};
