/**
 * Agent Factory
 *
 * Creates the appropriate AI agent based on configuration.
 * Supports two agents:
 * - ClaudeAgent (Anthropic) - Default, using @anthropic-ai/claude-agent-sdk
 * - PiAgent (Pi) - Using @earendil-works/pi-ai SDK
 *
 * All agents implement AgentBackend directly.
 *
 * LLM Connections:
 * - Backends can be created from LLM connection configs
 * - providerType determines SDK selection and credential routing
 * - authType determines how credentials are retrieved
 */
import { cleanupModeState } from '../mode-manager.ts'; // F1.416 — testBackendConnection's temporary agent (its finally)
import type {
  AgentBackend,
  BackendConfig,
  AgentProvider,
  LlmProviderType,
  LlmAuthType,
  CoreBackendConfig,
  BackendHostRuntimeContext,
} from './types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { NestorCloudAgent, DEFAULT_NESTOR_CLOUD_MODEL } from '../nestor-cloud-agent.ts';
import {
  isAnthropicBackendEnabled,
  isClaudeRuntimeEnabled,
  isCodexRuntimeEnabled,
  isProviderEnabled,
} from '../../feature-flags.ts';
import {
  getLlmConnection,
  getDefaultLlmConnection,
  type LlmConnection,
} from '../../config/storage.ts';
import type { CustomEndpointConfig } from '../../config/llm-connections.ts';
// Import validation helpers for provider-auth combinations
import {
  fromBedrockNativeId,
  isAdapterRuntimeProvider,
  isValidProviderAuthCombination,
  resolveConnectionModelAlias,
} from '../../config/llm-connections.ts';
import { applyManagedModelAllowlist } from '../../config/managed-models.ts';
import { isManagedModelSelectable } from '../../config/managed-model-allowlist.ts';
import { parseValidationError, type LlmValidationResult } from '../../config/llm-validation.ts';
import type { ModelFetchResult } from '../../config/model-fetcher.ts';
// Model resolution utilities
import { getModelProvider, DEFAULT_MODEL, normalizeDeprecatedModelId } from '../../config/models.ts';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getCredentialManager } from '../../credentials/index.ts';
import type {
  BackendModelFetchCredentials,
  BackendProviderOptions,
  BackendResolutionContext,
  ProviderDriver,
  ResolvedBackendConfig,
  StoredConnectionValidationResult,
} from './internal/driver-types.ts';
import { getDefaultProviderType } from './internal/driver-types.ts';
import { classifyModelTarget, isGatewayBackedConnection, modelTargetBaseUrlForConnection, noteModelTargetToolEgress } from './internal/drivers/upstream-target.ts';
import {
  resolveBackendHostTooling as resolveHostToolingPaths,
  resolveBackendRuntimePaths,
} from './internal/runtime-resolver.ts';
import {
  isLlmProviderType,
  unknownRuntimeError,
  unreachableRuntime,
} from './runtime-vocabulary.ts';
import { anthropicDriver } from './internal/drivers/anthropic.ts';
import { piDriver } from './internal/drivers/pi.ts';
import { codexDriver } from './internal/drivers/codex.ts';
import { nestorCloudDriver } from './internal/drivers/nestor-cloud.ts';

const DRIVER_REGISTRY: Record<AgentProvider, ProviderDriver> = {
  anthropic: anthropicDriver,
  pi: piDriver,
  'codex-runtime': codexDriver,
  'nestor-cloud-agent': nestorCloudDriver,
};

/**
 * Which runtimes the two Claude build flags gate (P2.205 site 1).
 *
 * The predicate was `provider !== 'anthropic'`, which is not wrong so much as
 * undeclared: a runtime added tomorrow inherits "not gated by the Claude flags"
 * without anyone deciding it. As a total record the compiler asks the question
 * — and the answer for a new runtime is very likely `false`, which is exactly
 * why it must be written down rather than defaulted.
 */
const REQUIRES_CLAUDE_BUILD_FLAGS: Record<AgentProvider, boolean> = {
  anthropic: true,
  pi: false,
  'codex-runtime': false,
  'nestor-cloud-agent': false,
};

const CLAUDE_DISABLED_ERROR = 'Claude support is not included in this build.';
const CLAUDE_RUNTIME_DISABLED_ERROR = 'Claude runtime support is not included in this build.';

/**
 * The single Claude build gate. Both flags land on the same `'anthropic'`
 * AgentProvider, so the decision has to be made in provider-TYPE terms:
 *
 * - the backend itself (ClaudeAgent + the bundled native `claude` binary) ships
 *   under EITHER flag — `NESSY_FEATURE_PROVIDER_CLAUDE` gates only the Pro/Max
 *   subscription card, but that card cannot work without the runtime, so it
 *   implies it (`isAnthropicBackendEnabled()`);
 * - a `claude-runtime` connection (the Nessy Gateway Claude card) additionally
 *   requires `NESSY_FEATURE_CLAUDE_RUNTIME` on its own, and reports a distinct
 *   error so a build that ships the subscription card but not the runtime says
 *   which half is missing.
 *
 * @returns the blocking error message, or undefined when the build allows it.
 */
function claudeBuildGateError(
  provider: AgentProvider,
  providerType?: LlmProviderType,
): string | undefined {
  if (!REQUIRES_CLAUDE_BUILD_FLAGS[provider]) return undefined;
  if (providerType === 'claude-runtime' && !isClaudeRuntimeEnabled()) {
    return CLAUDE_RUNTIME_DISABLED_ERROR;
  }
  if (!isAnthropicBackendEnabled()) return CLAUDE_DISABLED_ERROR;
  return undefined;
}

function getProviderDriver(provider: AgentProvider): ProviderDriver {
  // P2.205 site 2 — `DRIVER_REGISTRY` is `Record<AgentProvider, ProviderDriver>`,
  // so this is compiler-total already and the guard exists for the runtime half:
  // a key that was never in the union. Arm: throw, with the same message shape
  // as every other site so a report names the site that answered.
  const driver = DRIVER_REGISTRY[provider];
  if (!driver) {
    throw unknownRuntimeError('getProviderDriver', provider);
  }
  return driver;
}

function resolveDriverRuntime(
  provider: AgentProvider,
  hostRuntime: BackendHostRuntimeContext,
) {
  const driver = getProviderDriver(provider);
  const resolvedPaths = resolveBackendRuntimePaths(hostRuntime);
  return { driver, resolvedPaths };
}

/**
 * P2.205 site 3 — `detectProvider(authType)` was DELETED rather than converted.
 *
 * It mapped a stored auth type onto a runtime, and both of its arms answered
 * `'anthropic'`: `api_key`/`oauth_token` deliberately, and every other string
 * through a `default:` whose own comment read "Default to Anthropic for unknown
 * types". Its docblock already said the truth — "Provider is now determined by
 * LLM connection type, not auth type. This function is kept for backward
 * compatibility" — and the measurement is that nothing was compatible with it:
 * ZERO production call sites repo-wide, its only references being two barrel
 * re-exports and its own tests. Converting a dead fail-open site would have
 * left a function that answers correctly and is never asked; this repo has
 * already shipped one of those (`normalizeBedrockModelId`, P2.95b).
 *
 * Positive control for the absence claim: the same name is live in three
 * sibling subsystems (`sources/credential-manager.ts`'s `detectProvider`,
 * `renderer/lib/provider-icons.ts`'s `detectProviderFromUrl`), so the search
 * that found no callers was not a search that finds nothing.
 */

/**
 * Create the appropriate backend based on configuration.
 *
 * @param config - Backend configuration including provider selection
 * @returns An initialized AgentBackend instance
 * @throws Error if the requested provider is not yet implemented
 *
 * @example
 * ```typescript
 * // Create Anthropic (Claude) backend
 * const backend = createBackend({
 *   provider: 'anthropic',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * // Create Pi backend (routes OpenAI / Copilot / Bedrock / etc. via Pi SDK)
 * const piBackend = createBackend({
 *   provider: 'pi',
 *   workspace: myWorkspace,
 * });
 * ```
 */
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.provider) {
    case 'anthropic':
      // ClaudeAgent implements AgentBackend directly
      return new ClaudeAgent(config);

    case 'pi':
      // PiAgent implements AgentBackend directly
      // Auth is API key based via Pi's AuthStorage
      return new PiAgent(config);

    case 'codex-runtime':
      // CodexAgent drives the bundled codex app-server + local Responses adapter
      return new CodexAgent(config);

    case 'nestor-cloud-agent':
      return new NestorCloudAgent(config);

    default:
      // P2.205 site 4 — the arm was ALREADY throw, and it stays throw: there is
      // no backend class to construct for a runtime nobody described, and
      // degrading would mean silently running the session on someone else's
      // SDK. What it lacked was the compiler half. `config.provider` is now
      // consumed as `never`, so adding a member to the union breaks the build
      // HERE instead of compiling into a runtime string.
      return unreachableRuntime(config.provider, 'createBackend');
  }
}

/**
 * Create the appropriate agent based on configuration.
 * Alias for createBackend - prefer this name for new code.
 */
export const createAgent = createBackend;

/**
 * Create backend from a pre-resolved context and provider-agnostic core config.
 * Provider-specific runtime resolution happens via internal driver registry.
 */
export function createBackendFromResolvedContext(args: {
  context: ResolvedBackendContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  providerOptions?: BackendProviderOptions;
}): AgentBackend {
  const { context, coreConfig, hostRuntime, providerOptions } = args;
  const gateError = claudeBuildGateError(context.provider, context.connection?.providerType);
  if (gateError) {
    throw new Error(gateError);
  }

  const { driver, resolvedPaths } = resolveDriverRuntime(context.provider, hostRuntime);

  const buildArgs = {
    context,
    coreConfig,
    hostRuntime,
    resolvedPaths,
    providerOptions,
  };

  driver.prepareRuntime?.(buildArgs);
  const runtime = driver.buildRuntime(buildArgs);

  /**
   * P3.363 — say, ONCE per process per target class, where this session's tool
   * schemas are about to go.
   *
   * This is the only place in the host where the endpoint and the resolved
   * model are both in scope for EVERY provider, which is why the disclosure is
   * here and not on one runtime's path: the three runtimes have three different
   * egress seams (the Pi subprocess's own fetch, and the local adapter for
   * claude-runtime and codex-runtime), and a notice written at either of those
   * would cover one or two of them and read as if it covered all three.
   *
   * The COST of that placement, stated rather than left to be discovered: the
   * session's MCP tool set does not exist yet at backend construction, so the
   * notice names the target and not the tools. `noteModelTargetToolEgress`
   * takes an optional `toolNames` for exactly that reason — the seam that gains
   * it later passes it without a signature change.
   *
   * It withholds nothing. See the module note on `classifyModelTarget` for why
   * a disclosure is separable from the withholding posture the owner has not
   * settled, and it cannot throw.
   */
  // A direct `anthropic` connection stores no endpoint and the SDK defaults
  // to `api.anthropic.com`; for every other provider an absent endpoint means
  // "the provider's own default", which this seam names only where a source
  // names it for us, and otherwise does not claim to.
  //
  // DA2.2 half A — read ONCE and used twice, by the disclosure below and by the
  // verdict on the config. Two derivations of "which endpoint is this session
  // pointed at" is how the line a user is shown and the servers actually
  // withheld would come to disagree.
  //
  // D1.191 — the SECOND named default, and the reason the clause above stops
  // saying "no way to name it". The two SUBSCRIPTION cards were landing on
  // opposite sides of the disclosure by providerType rather than by any
  // decision: Claude Pro/Max (`anthropic`, endpoint-less) took the substitution
  // and disclosed, while ChatGPT Plus (`pi` + `piAuthProvider: 'openai-codex'`,
  // endpoint-less) took none, classified `provider-default` and said NOTHING —
  // although Pi sends that session to its own `DEFAULT_CODEX_BASE_URL`,
  // `https://chatgpt.com/backend-api`, read out of the vendored
  // `@earendil-works/pi-coding-agent` bundle at 0.84.4 rather than guessed.
  //
  // PRODUCT POSTURE, stated because this REMOVES tools from a session: the
  // ChatGPT Plus card now discloses AND, since DA2.14, withholds every
  // non-whitelisted MCP server, exactly as the Claude card already did. Both
  // cards are flag-gated off today (`NESSY_FEATURE_PROVIDER_CLAUDE` /
  // `_CHATGPT`), so nothing shipped changes and A3.14's flip now finds the two
  // symmetric instead of settling it afterwards.
  //
  // DELIBERATELY NOT A VOCABULARY: an endpoint-less connection on any OTHER
  // `piAuthProvider` (`openai`, `anthropic`, `github-copilot`, …) still lands in
  // `provider-default` and still says nothing. Naming those needs either a
  // per-provider map that cannot be complete or a flip of `provider-default` to
  // fail-closed, which would newly withhold from an endpoint-less connection
  // whose egress is INSIDE the perimeter — a posture, and a row of its own.
  const modelTargetBaseUrl = modelTargetBaseUrlForConnection({
    baseUrl: context.connection?.baseUrl, providerType: context.connection?.providerType, piAuthProvider: context.connection?.piAuthProvider, codexModelProvider: context.connection?.codexModelProvider, // F1.202
  });
  noteModelTargetToolEgress({
    baseUrl: modelTargetBaseUrl,
    model: context.resolvedModel,
    // D1.221 — the one input that keeps an endpoint-less Nessy Cloud Agent out
    // of the newly fail-closed `provider-default` arm. Passed to BOTH readers
    // below for the same reason the base URL is derived once: a session must
    // not be told one thing and have another withheld.
    providerType: context.connection?.providerType,
    // DA2.15 — the host's sink. Until this line the only channel was
    // `noteModelTargetToolEgress`'s own `console.warn`, which a packaged
    // Electron build writes nowhere a user can read, so the disclosure DA2.6
    // shipped the copy for had nothing to render from. `undefined` when the host
    // supplies none, and the helper then falls back to `console.warn` exactly as
    // before — every existing caller is unchanged.
    emit: coreConfig.onModelTargetDisclosure,
  });

  const config: ResolvedBackendConfig = {
    ...coreConfig,
    pluginNodeRuntime: resolvedPaths.pluginNodeRuntime,
    provider: context.provider,
    providerType: context.connection?.providerType ?? getDefaultProviderType(context.provider),
    authType: context.authType || getDefaultAuthType(context.provider),
    model: context.resolvedModel,
    connectionSlug: context.connection?.slug,
    /**
     * DA2.2 half A — the verdict the MCP pool filter reads
     * (`mcp/runtime-pool-servers.ts`). Classified from the SAME two inputs the
     * disclosure above was just given, so the session cannot be told one thing
     * and have another withheld. `classifyModelTarget` is pure and synchronous
     * and cannot throw, which is why it may run on this path.
     */
    modelTarget: classifyModelTarget({
      baseUrl: modelTargetBaseUrl,
      model: context.resolvedModel,
      providerType: context.connection?.providerType,
    }),
    runtime,
  };

  return createBackend(config);
}

/**
 * Initialize backend host runtime wiring once at app startup.
 * Keeps runtime/bootstrap details (Claude SDK executable, Pi interceptor bundle)
 * behind backend internals.
 */
export function initializeBackendHostRuntime(args: {
  hostRuntime: BackendHostRuntimeContext;
}): void {
  const { hostRuntime } = args;

  for (const provider of getAvailableProviders()) {
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, hostRuntime);
    driver.initializeHostRuntime?.({ hostRuntime, resolvedPaths });
  }
}

/**
 * Resolve backend-managed host tooling paths (e.g. ripgrep) from generic host runtime metadata.
 */
export function resolveBackendHostTooling(args: {
  hostRuntime: BackendHostRuntimeContext;
}): {
  ripgrepPath?: string;
} {
  return resolveHostToolingPaths(args.hostRuntime);
}

/**
 * Whether each runtime's implementation ships in THIS build (P2.205 site 5).
 *
 * Was a four-line `push` chain, which is the shape that fails QUIETLY in the
 * other direction from the rest of this file: a runtime added without a line
 * here is simply never available, and nothing says so. A total record makes the
 * omission a build error.
 *
 * **The key order is the enumeration order** and is deliberately the one the
 * `push` chain had. `getAvailableProviders()`'s output order is pinned by the
 * frozen adjacent-backend fixture
 * (`__tests__/fixtures/adjacent-backends/rpc-and-backends.json`), so iterating
 * `AGENT_PROVIDERS` instead would have been a contract change dressed as a
 * refactor. No production caller reads the order — the two are `.includes()`
 * and a for-of over drivers — but a frozen fixture is a contract whether or not
 * anything depends on it.
 */
const PROVIDER_BUILD_GATES: Record<AgentProvider, () => boolean> = {
  // Either Claude flag ships the ClaudeAgent backend — see claudeBuildGateError.
  anthropic: isAnthropicBackendEnabled,
  // Unconditional, and load-bearing: Pi is what `resolveBackendContext` falls
  // back to when no connection resolves, so a build that could drop it would
  // have no floor at all.
  pi: () => true,
  'nestor-cloud-agent': () => isProviderEnabled('nessy_cloud'),
  'codex-runtime': isCodexRuntimeEnabled,
};

/**
 * Get list of currently available providers.
 *
 * @returns Array of provider identifiers that have working implementations
 */
export function getAvailableProviders(): AgentProvider[] {
  return (Object.keys(PROVIDER_BUILD_GATES) as AgentProvider[])
    .filter(provider => PROVIDER_BUILD_GATES[provider]());
}

/**
 * Check if a provider is available for use.
 *
 * @param provider - Provider to check
 * @returns true if the provider has a working implementation
 */
export function isProviderAvailable(provider: AgentProvider): boolean {
  // P2.205 site 6 — DERIVED from site 5 rather than deciding anything itself,
  // which is why an unknown runtime answers `false` here and always did. Keep it
  // derived: the moment this grows its own list it is the twelfth list.
  return getAvailableProviders().includes(provider);
}

// ============================================================
// LLM Connection Support
// ============================================================

/**
 * Map LlmProviderType to AgentProvider (SDK selection).
 *
 * AgentProvider determines which backend class to instantiate:
 * - 'anthropic' → ClaudeAgent
 * - 'pi' → PiAgent
 *
 * @param providerType - The full provider type from LLM connection
 * @returns The agent provider for SDK selection
 */
const AGENT_PROVIDER_BY_PROVIDER_TYPE: Record<LlmProviderType, AgentProvider> = {
  // Anthropic SDK backend (direct API only)
  anthropic: 'anthropic',
  // Pi backends (includes former bedrock/vertex/anthropic_compat via migration)
  pi: 'pi',
  pi_compat: 'pi',
  // Codex coding runtime
  'codex-runtime': 'codex-runtime',
  // Claude Agent SDK against a custom Anthropic-compatible endpoint — same
  // backend class as 'anthropic', only the endpoint/credentials differ.
  'claude-runtime': 'anthropic',
  // Native Nestor cloud A2A backend
  'nestor-cloud-agent': 'nestor-cloud-agent',
};

/**
 * The same mapping for a value that has NOT been proven to be in the union —
 * `undefined` when it is not one (P2.205 site 7, the degrade half).
 *
 * Read a `providerType` off a stored connection and this is the honest
 * signature: `getLlmConnections()` hands back `config.llmConnections` straight
 * out of the config file with no per-field validation, so the string is
 * `LlmProviderType` by declaration only.
 */
export function tryProviderTypeToAgentProvider(
  providerType: string | undefined,
): AgentProvider | undefined {
  return isLlmProviderType(providerType)
    ? AGENT_PROVIDER_BY_PROVIDER_TYPE[providerType]
    : undefined;
}

export function providerTypeToAgentProvider(providerType: LlmProviderType): AgentProvider {
  // P2.205 site 7 — THE ROOT OF THE FAMILY, and the arm is now THROW.
  //
  // This switch already carried an `const _exhaustive: never` line, so it was
  // compiler-total; what it also carried was `return 'anthropic'` on the same
  // arm, and THAT is the answer an unknown string got at runtime. Measured on
  // the parent commit: `providerTypeToAgentProvider('sonnet-of-nobody')` →
  // `'anthropic'`, which then made `resolveModelForProvider` hand back
  // `claude-opus-4-8` and `validateConnection` route the connection to
  // api.anthropic.com. Every one of the other fail-open answers in this file
  // came through here first.
  //
  // Throwing is right for the construction paths that dominate the call graph
  // (`resolveBackendContext`, `createBackendFromConnection`,
  // `createConfigFromConnection`, `fetchBackendModels`): a session that cannot
  // be classified must fail loudly at start rather than run somewhere else.
  // The two surfaces that must keep ANSWERING use
  // {@link tryProviderTypeToAgentProvider} and report an unsupported
  // connection instead.
  const provider = tryProviderTypeToAgentProvider(providerType);
  if (!provider) throw unknownRuntimeError('providerTypeToAgentProvider', providerType);
  return provider;
}

/**
 * Get LLM connection for a session.
 * Resolution order: session.llmConnection > workspace.defaults.defaultLlmConnection > global default
 *
 * ## The managed model allowlist enters here
 *
 * This is the session-side READ of the connection record, and the only one that
 * feeds model resolution: `resolveBackendContext`/`resolveModelForProvider`,
 * `getMiniModel`, `getSummarizationModel`, `resolveGatewayFastModelId` and
 * `updateSessionModel`'s default fallback all reach the catalog through it.
 * Narrowing here is therefore enough to cover every tier at once, and it is safe
 * because no caller of this function writes the record back — the persistence
 * round trip runs through `getLlmConnections()` → the renderer →
 * `llmConnections.SAVE`, which this function is not on. See
 * `config/managed-models.ts` for why that distinction is load-bearing.
 *
 * @param sessionConnection - Connection slug from session (may be undefined)
 * @param workspaceDefaultConnection - Workspace default connection (may be undefined)
 * @returns The resolved LLM connection or null if not found
 */
export function resolveSessionConnection(
  sessionConnection?: string,
  workspaceDefaultConnection?: string
): LlmConnection | null {
  const narrow = (connection: LlmConnection | null): LlmConnection | null =>
    connection === null ? null : applyManagedModelAllowlist(connection);

  // 1. Session-level connection (locked after first message)
  if (sessionConnection) {
    const connection = getLlmConnection(sessionConnection);
    if (connection) return narrow(connection);
  }

  // 2. Workspace default
  if (workspaceDefaultConnection) {
    const connection = getLlmConnection(workspaceDefaultConnection);
    if (connection) return narrow(connection);
  }

  // 3. Global default
  const defaultSlug = getDefaultLlmConnection();
  if (!defaultSlug) return null;
  return narrow(getLlmConnection(defaultSlug));
}

/**
 * Provider-agnostic resolution result used by session/ipc orchestration.
 */
export interface ResolvedBackendContext extends BackendResolutionContext {}

/**
 * Resolve connection + provider/auth/model/capabilities in one call.
 * This keeps main-process orchestration free from provider-specific branching.
 */
export function resolveBackendContext(args: {
  sessionConnectionSlug?: string;
  workspaceDefaultConnectionSlug?: string;
  managedModel?: string;
}): ResolvedBackendContext {
  const connection = resolveSessionConnection(
    args.sessionConnectionSlug,
    args.workspaceDefaultConnectionSlug
  );

  // P2.205 site 8 — the arm here is DEGRADE, and it is about the absence of a
  // CONNECTION rather than an unknown runtime: there is nothing to classify, so
  // a named default is the honest answer. An unknown `providerType` on a
  // connection that DOES resolve throws through `providerTypeToAgentProvider`,
  // because that is a connection the user configured for something we cannot
  // run — silently starting it on Pi would run their gateway session on the
  // wrong runtime.
  const provider = connection
    ? providerTypeToAgentProvider(connection.providerType)
    // No resolvable connection means no endpoint and no credential, so the
    // fallback must be the backend that needs neither: Pi, which
    // `getAvailableProviders` pushes unconditionally while every other entry is
    // gated on a BUILD flag. Reading that list's head made the default depend on
    // which optional runtimes a build bundles — and when the coding-runtime flags
    // became default-on the head silently changed to 'anthropic', turning every
    // unconfigured session into a Claude session that cannot run.
    : 'pi';

  const authType = connection
    ? (connection.authType === 'none' || connection.authType === 'environment'
        ? undefined
        : connection.authType)
    : undefined;

  const resolvedModel = resolveModelForProvider(provider, args.managedModel, connection);

  return {
    connection,
    provider,
    authType,
    resolvedModel,
    capabilities: BACKEND_CAPABILITIES[provider],
  };
}

/**
 * Resolve provider hint for setup-time connection tests.
 * Keeps provider-specific hint mapping out of Electron main IPC handlers.
 */
export interface SetupTestConnectionHintArgs {
  provider: AgentProvider;
  baseUrl?: string;
  piAuthProvider?: string;
  customEndpoint?: CustomEndpointConfig;
  /**
   * The BYO endpoint form (C3) names the runtime outright. It wins over every
   * branch below — including a stray `customEndpoint`, which would otherwise
   * classify the connection `pi_compat` and route the test through Pi, the same
   * conversion the SETUP handler performs on that field.
   */
  runtimeProviderType?: Extract<LlmProviderType, 'codex-runtime' | 'claude-runtime'>;
}

type SetupTestConnectionHint = Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;

/**
 * P2.205 site 9 — what a setup-time connection test is classified as, per
 * runtime, and the arm for the runtimes that used to fall off the end is
 * DECLARE.
 *
 * The final statement was `return { providerType: args.baseUrl ? 'pi_compat' :
 * 'anthropic' }` with no arm of its own, so it answered for `anthropic`
 * (correctly, deliberately) and for `codex-runtime` and `nestor-cloud-agent`
 * (by falling through). Measured on the parent commit:
 * `resolveSetupTestConnectionHint({ provider: 'sonnet-of-nobody' })` →
 * `{ providerType: 'anthropic' }`, i.e. an unknown runtime's endpoint and key
 * were about to be tested against the Claude SDK.
 *
 * The two runtimes that fell through now name themselves. That is reachable
 * only by a caller that passes them — `TestLlmConnectionParams.provider` is
 * `'anthropic' | 'pi'` and `runtimeProviderType` wins outright when set, which
 * is why the fall-through survived — so the change is a correct answer where
 * there was a wrong one, on a path the RPC does not currently take.
 */
const SETUP_TEST_CONNECTION_HINTS: Record<
  AgentProvider,
  (args: SetupTestConnectionHintArgs) => SetupTestConnectionHint
> = {
  pi: args => {
    if (args.customEndpoint && args.baseUrl?.trim()) {
      return {
        providerType: 'pi_compat',
        piAuthProvider: args.customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai',
        customEndpoint: args.customEndpoint,
      };
    }

    return {
      providerType: 'pi',
      piAuthProvider: args.piAuthProvider,
    };
  },
  // A base URL means "not api.anthropic.com", and the Anthropic card's
  // custom-endpoint form is a pi_compat connection.
  anthropic: args => ({ providerType: args.baseUrl ? 'pi_compat' : 'anthropic' }),
  'codex-runtime': () => ({ providerType: 'codex-runtime' }),
  'nestor-cloud-agent': () => ({ providerType: 'nestor-cloud-agent' }),
};

export function resolveSetupTestConnectionHint(
  args: SetupTestConnectionHintArgs,
): SetupTestConnectionHint {
  if (args.runtimeProviderType) {
    return { providerType: args.runtimeProviderType };
  }

  const hint = SETUP_TEST_CONNECTION_HINTS[args.provider];
  if (!hint) throw unknownRuntimeError('resolveSetupTestConnectionHint', args.provider);
  return hint(args);
}

/**
 * Provider-agnostic model discovery for model refresh flows.
 * Dispatches to provider drivers and keeps provider-specific SDK usage internal.
 */
export async function fetchBackendModels(args: {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
}): Promise<ModelFetchResult> {
  const provider = providerTypeToAgentProvider(args.connection.providerType);
  const gateError = claudeBuildGateError(provider, args.connection.providerType);
  if (gateError) {
    throw new Error(gateError);
  }

  const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);
  const timeoutMs = args.timeoutMs ?? 30_000;

  driver.initializeHostRuntime?.({
    hostRuntime: args.hostRuntime,
    resolvedPaths,
  });

  if (!driver.fetchModels) {
    throw new Error(`Model discovery not implemented for provider: ${provider}`);
  }

  return driver.fetchModels({
    connection: args.connection,
    credentials: args.credentials,
    hostRuntime: args.hostRuntime,
    resolvedPaths,
    timeoutMs,
  });
}

/**
 * Provider-agnostic stored-connection validation.
 * Moves provider/auth branching out of Electron main IPC handlers.
 */
export async function validateStoredBackendConnection(args: {
  slug: string;
  hostRuntime: BackendHostRuntimeContext;
}): Promise<StoredConnectionValidationResult> {
  try {
    const connection = getLlmConnection(args.slug);
    if (!connection) {
      return { success: false, error: 'Connection not found' };
    }

    // P2.205 site 11 (first half) — a stored connection whose `providerType`
    // is not in the vocabulary is REPORTED unsupported, not classified as
    // Anthropic. This is a validation surface, so the arm is a typed answer
    // rather than the throw the construction paths take.
    const provider = tryProviderTypeToAgentProvider(connection.providerType);
    if (!provider) {
      return { success: false, error: `Unsupported connection type: ${connection.providerType}` };
    }
    const gateError = claudeBuildGateError(provider, connection.providerType);
    if (gateError) {
      return { success: false, error: gateError };
    }

    const credentialManager = getCredentialManager();
    const hasCredentials = await credentialManager.hasLlmCredentials(
      args.slug,
      connection.authType,
      connection.providerType,
      // DA1.13 — the endpoint is what tells the presence check that this is a
      // gateway card, whose credential of record is the shared dp JWT and not
      // an entry in this store. Without it every gateway connection would
      // validate as "No credentials configured".
      connection.baseUrl,
    );

    if (!hasCredentials && connection.authType !== 'none') {
      return { success: false, error: 'No credentials configured' };
    }

    const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);

    driver.initializeHostRuntime?.({
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });

    if (!driver.validateStoredConnection) {
      // P2.205 site 11 (second half) — this arm used to answer
      // `{ success: true }`: a driver that declares no stored-connection check
      // had its connections reported VALID. All four shipped drivers declare
      // one, and three of them (`pi`, `codex`, `nestor-cloud`) answer
      // `{ success: true }` themselves with the reason written on the
      // declaration — which is the difference this row is about, since the
      // value is identical and the accountability is not. Reaching this line
      // therefore means a NEW driver forgot to decide; it surfaces through this
      // function's own catch as a failure instead of a false pass.
      throw unknownRuntimeError('validateStoredBackendConnection.validateStoredConnection', provider);
    }

    return driver.validateStoredConnection({
      slug: args.slug,
      connection,
      credentialManager,
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: parseValidationError(msg) };
  }
}

/**
 * Create backend configuration from an LLM connection.
 *
 * @param connection - The LLM connection config
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns Complete BackendConfig ready for createBackend()
 */
export function createConfigFromConnection(
  connection: LlmConnection,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType' | 'providerType'>
): BackendConfig {
  const providerType = connection.providerType;
  const provider = providerTypeToAgentProvider(providerType);

  return {
    ...baseConfig,
    provider,
    providerType,
    authType: connection.authType,
    connectionSlug: connection.slug,
    // Use connection's default model if no model specified in baseConfig
    model: baseConfig.model || connection.defaultModel,
  };
}

/**
 * Create backend from an LLM connection slug.
 *
 * @param connectionSlug - The LLM connection slug
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns An initialized AgentBackend instance
 * @throws Error if connection not found or has invalid provider-auth combination
 */
export function createBackendFromConnection(
  connectionSlug: string,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType'>,
  hostRuntime?: BackendHostRuntimeContext,
  providerOptions?: BackendProviderOptions,
): AgentBackend {
  // Narrowed for the same reason `resolveSessionConnection` is: this is a
  // backend-construction READ, never a write, and the resolved model below is
  // derived from `connection.models`/`connection.defaultModel`.
  const stored = getLlmConnection(connectionSlug);
  if (!stored) {
    throw new Error(`LLM connection not found: ${connectionSlug}`);
  }
  const connection = applyManagedModelAllowlist(stored);

  // Validate provider-auth combination before creating backend
  // This catches invalid configurations early with a clear error message
  if (!isValidProviderAuthCombination(connection.providerType, connection.authType)) {
    throw new Error(
      `Invalid LLM connection configuration: provider '${connection.providerType}' ` +
      `does not support auth type '${connection.authType}'. ` +
      `Please update the connection settings for '${connection.name}'.`
    );
  }

  const context: ResolvedBackendContext = {
    connection,
    provider: providerTypeToAgentProvider(connection.providerType),
    authType: connection.authType === 'none' || connection.authType === 'environment'
      ? undefined
      : connection.authType,
    resolvedModel: resolveModelForProvider(
      providerTypeToAgentProvider(connection.providerType),
      baseConfig.model,
      connection
    ),
    capabilities: BACKEND_CAPABILITIES[providerTypeToAgentProvider(connection.providerType)],
  };
  const gateError = claudeBuildGateError(context.provider, connection.providerType);
  if (gateError) {
    throw new Error(gateError);
  }

  if (hostRuntime) {
    return createBackendFromResolvedContext({
      context,
      coreConfig: baseConfig,
      hostRuntime,
      providerOptions,
    });
  }

  const config = createConfigFromConnection(connection, {
    ...baseConfig,
    model: context.resolvedModel,
  });
  return createBackend(config);
}

// ============================================================
// Backend Capabilities
// ============================================================

/**
 * Declarative capabilities for each backend provider.
 * Used by the session layer to make decisions without checking provider strings.
 */
export const BACKEND_CAPABILITIES: Record<AgentProvider, {
  /** Whether the backend needs an HTTP pool server (external subprocess can't access McpClientPool directly) */
  needsHttpPoolServer: boolean;
}> = {
  anthropic: { needsHttpPoolServer: false },
  pi: { needsHttpPoolServer: false },
  'nestor-cloud-agent': { needsHttpPoolServer: false },
  'codex-runtime': { needsHttpPoolServer: true },
};

// ============================================================
// Auth Type Resolution
// ============================================================

/**
 * Get the default auth type for a provider when none is explicitly specified.
 *
 * - anthropic: undefined (Claude uses env vars, not explicit authType)
 * - pi: 'api_key'
 *
 * Accepts an `LlmProviderType` as well, because two provider types collapse onto
 * one `AgentProvider` and disagree about the default: 'claude-runtime' maps to
 * the 'anthropic' backend but always carries an explicit endpoint + key.
 */
const DEFAULT_AUTH_TYPE_BY_PROVIDER: Record<LlmProviderType, LlmAuthType | undefined> = {
  // Claude uses env vars, not an explicit authType.
  anthropic: undefined,
  pi: 'api_key',
  // P2.205 site 12 — `pi_compat` had NO arm and fell through to `undefined`,
  // i.e. "this connection needs no credential", for the one provider type that
  // is defined by carrying its own endpoint AND key.
  // `isValidProviderAuthCombination` (llm-connections.ts) accepts exactly
  // `['api_key_with_endpoint', 'none']` for it, and `testBackendConnection`
  // already spells the same answer inline for its synthetic connection
  // (`providerType === 'pi_compat' || isAdapterRuntimeProvider(...)` →
  // `api_key_with_endpoint`), so the two agree now instead of disagreeing.
  //
  // Latent rather than live at the time of writing: the one production caller
  // (`createBackendFromResolvedContext`) passes an `AgentProvider`, and
  // `pi_compat` is not one. A default that is wrong only for the callers that
  // do not exist yet is the shape this row exists to remove.
  pi_compat: 'api_key_with_endpoint',
  'codex-runtime': 'api_key_with_endpoint',
  'claude-runtime': 'api_key_with_endpoint',
  'nestor-cloud-agent': 'none',
};

export function getDefaultAuthType(provider: AgentProvider | LlmProviderType): LlmAuthType | undefined {
  // Keyed by the WIDER vocabulary because two provider types collapse onto one
  // AgentProvider and disagree about the default; every `AgentProvider` is also
  // an `LlmProviderType`, so one record serves both signatures.
  if (!isLlmProviderType(provider)) throw unknownRuntimeError('getDefaultAuthType', provider);
  return DEFAULT_AUTH_TYPE_BY_PROVIDER[provider];
}

// ============================================================
// Model Resolution
// ============================================================

/** A Pi model id carries a `pi/` prefix; the Bedrock helpers want the bare id. */
function withoutPiPrefix(modelId: string): string {
  return modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
}

/**
 * The SAME Bedrock model as `wanted`, under whatever geography the catalog
 * actually publishes — or `undefined` when `wanted` is not a Bedrock-native id
 * or the catalog has no form of that model at all.
 *
 * ## P2.194(1) — why this exists, measured
 *
 * `deriveBedrockRegionPrefix` follows the upstream table, so an `ap-*` user's
 * seeded default is region-corrected to `apac.anthropic.claude-opus-5`. The
 * SHIPPED Pi Bedrock catalog — the thing that has to resolve the id before a
 * request is issued — publishes 55 Claude ids across SIX prefixes and `apac.` is
 * not one of them: 10 unprefixed `anthropic.`, 11 `us.`, 10 `eu.`, 10 `global.`,
 * 7 `au.`, 7 `jp.`, ZERO `apac.` and ZERO `us-gov.` (measured against
 * `@earendil-works/pi-ai`'s `providers/data/amazon-bedrock.json`, 2026-08-26;
 * the connection-shaped list is 100 models with head
 * `pi/us.anthropic.claude-opus-5`).
 *
 * So the correct prefix selected nothing, and the substitution below then
 * replaced it with `connectionModelIds[0]` — which for a Bedrock connection is
 * the preference-sorted head, `pi/us.anthropic.claude-opus-5`. The region
 * correction was silently UNDONE back to `us.`: the exact defect P2.95c fixed in
 * the derivation, re-entering through the catalog.
 *
 * ## Why a fallback rather than more ids
 *
 * The catalog is not ours. Our own forward table (`bedrock-model-ids.ts`) is
 * prefix-independent and already emits `apac.` correctly — there is nothing to
 * add there — and AWS does define APAC as a geography scope
 * (`inference-profiles-support.html`, fetched 2026-08-26: *"if an inference
 * profile is tied to a geography (such as US, EU, or APAC), its destination
 * Region list will never change"*), while moving the per-model profile ids onto
 * each model's own detail page, so no single page enumerates them. The gap is
 * upstream's; the fallback is ours.
 *
 * `global.` is preferred among the alternatives because it is the upstream
 * table's own catch-all row and the one prefix that asserts NO geography — the
 * same reason `PI_MINI_PREFERRED_DEFAULTS` already spells its Bedrock entries
 * `global.`. It is not a data-residency answer (AWS routes a Global profile to
 * all commercial Regions); it is a better answer than silently asserting `us.`,
 * and the real fix is a catalog that ships `apac.`.
 */
function sameBedrockModelInCatalog(
  wanted: string,
  available: readonly string[],
): string | undefined {
  const bare = withoutPiPrefix(wanted);
  const wantedModel = fromBedrockNativeId(bare);
  // Not a Bedrock-native id: `fromBedrockNativeId` is a pass-through for
  // everything else, so an unchanged answer means there is no geography to swap.
  if (wantedModel === bare) return undefined;
  const sameModel = available.filter(id => fromBedrockNativeId(withoutPiPrefix(id)) === wantedModel);
  if (sameModel.length === 0) return undefined;
  return sameModel.find(id => withoutPiPrefix(id).startsWith('global.')) ?? sameModel[0];
}

/**
 * Resolve the model ID for a given provider, validating against the connection's model list.
 *
 * Each provider has different defaults and validation:
 * - Anthropic: falls back to DEFAULT_MODEL (Opus)
 * - Pi: falls back to empty string (Pi selects model internally)
 *
 * @param provider - The agent provider
 * @param managedModel - The model stored on the session (user's choice)
 * @param connection - The LLM connection config (has defaultModel and models[])
 * @returns Resolved model ID string
 */
export function resolveModelForProvider(
  provider: AgentProvider,
  managedModel: string | undefined,
  connection: LlmConnection | null
): string {
  // Cross-provider guard: if the model belongs to a different provider, fall back
  // to the connection's default. This prevents e.g. sending a Claude model to Pi.
  if (managedModel) {
    managedModel = normalizeDeprecatedModelId(managedModel);
    const modelProvider = getModelProvider(managedModel);
    if (modelProvider && modelProvider !== provider) {
      managedModel = undefined; // Clear — will fall through to connection default
    }
  }

  // The managed allowlist, applied for EVERY provider.
  //
  // `model-config.md:166` — "**`--model` flag, `ANTHROPIC_MODEL`, or the `model`
  // setting**: the value is replaced at startup with a warning naming both the
  // requested and substituted models, and the session starts on the default
  // model." That is what clearing `managedModel` here does: the switch below
  // falls through to the connection default, which
  // `applyManagedModelAllowlist` has already resolved under
  // `enforceAvailableModels`.
  //
  // The pi-only catalog guard below is NOT a substitute. It is scoped to
  // `provider === 'pi'` and to connections that carry a `models` list, so an
  // Anthropic connection, a Codex connection, or any connection whose catalog
  // has not been fetched yet would keep running a forbidden model — the
  // declared-versus-enforced split this whole seam exists to close.
  if (managedModel && !isManagedModelSelectable(managedModel)) {
    managedModel = undefined;
  }

  let connectionDefault = connection?.defaultModel
    ? normalizeDeprecatedModelId(connection.defaultModel)
    : undefined;

  if (connection?.models?.length) {
    const connectionModelIds = connection.models.map(m => typeof m === 'string' ? m : m.id);
    // P6.362 · an id this connection serves under another name, resolved BEFORE
    // either catalogue test below — so an aliased id is kept rather than cleared
    // (the managed arm) or left standing unserved (the declared default, whose
    // substitution is pi-only on purpose). A no-op when nothing aliases: see
    // `resolveConnectionModelAlias`, which refuses a target the catalogue does
    // not serve or the managed allowlist forbids.
    managedModel = resolveConnectionModelAlias(connection, managedModel);
    connectionDefault = resolveConnectionModelAlias(connection, connectionDefault);
    // Applies to EVERY provider, not just Pi. A gateway model id such as
    // `tgpt/qwen35-397b-a17b-fp8` is absent from MODEL_REGISTRY, so the
    // cross-provider guard above cannot see it — under the old pi-only scope a
    // stale id survived a session switching onto an `anthropic` or
    // `codex-runtime` connection and was sent to a provider that has never
    // heard of it. Read-boundary only: nothing here writes the connection, so
    // it is not the persistence-boundary filter the owner rejected
    // (`2026-07-29-inert-worklist.md` §3.2).
    if (managedModel && !connectionModelIds.includes(managedModel)) {
      managedModel = undefined;
    }
    // The DEFAULT substitution stays pi-only, deliberately. Non-Pi connections
    // now carry SYNCED catalogues (llm-proxy returns ~388 rows), so replacing a
    // user's configured default with `connectionModelIds[0]` would silently run
    // an arbitrary first row instead of surfacing "that default is not in this
    // catalogue". Substituting a stale MANAGED id is a clamp; substituting the
    // user's own declared default is a guess.
    if (provider === 'pi' && connectionDefault && !connectionModelIds.includes(connectionDefault)) {
      // P2.194(1) — SAME MODEL, ANOTHER GEOGRAPHY, before the blind head.
      connectionDefault = sameBedrockModelInCatalog(connectionDefault, connectionModelIds)
        ?? connectionModelIds[0];
    }
  }

  // `claude-runtime` collapses onto the 'anthropic' AgentProvider, so it would
  // otherwise land on the DEFAULT_MODEL fallback below — and that id
  // (`claude-opus-4-8`) is an api.anthropic.com model the custom endpoint has
  // very likely never heard of. Its catalog lives on the connection, so fall
  // back to nothing, exactly like `pi`, and let the caller surface "no model".
  if (connection?.providerType === 'claude-runtime') {
    return managedModel || connectionDefault || '';
  }

  switch (provider) {
    // Pi picks its own model when nothing is configured, so an empty answer is
    // a real answer here rather than a missing one.
    case 'pi':
      return managedModel || connectionDefault || '';
    case 'nestor-cloud-agent':
      return managedModel || connectionDefault || DEFAULT_NESTOR_CLOUD_MODEL;
    // P2.205 site 13 — codex was decided by the `default:` arm, which means it
    // was decided by `DEFAULT_MODEL`, and that constant is `claude-opus-4-8`: a
    // BYO codex connection carrying no `defaultModel` was handed an
    // api.anthropic.com model id to send to the codex app-server. Its catalog is
    // gateway-fetched onto the connection exactly like `claude-runtime`'s —
    // `getModelsForProviderType('codex-runtime')` and
    // `getDefaultModelsForConnection('codex-runtime')` both answer `[]` — so it
    // falls back to nothing for the same stated reason as the `claude-runtime`
    // branch above, and the caller surfaces "no model" instead of a model the
    // runtime has never heard of.
    case 'codex-runtime':
      return managedModel || connectionDefault || '';
    case 'anthropic':
      return managedModel || connectionDefault || DEFAULT_MODEL;
    default:
      // The measured headline of this row: an undescribed runtime used to leave
      // here holding `claude-opus-4-8`.
      return unreachableRuntime(provider, 'resolveModelForProvider');
  }
}

// ============================================================
// Runtime Artifact Helpers
// ============================================================

/**
 * Remove backend runtime artifacts for disabled sources.
 * Currently removes bridge credential cache files in source directories.
 */
export async function cleanupSourceRuntimeArtifacts(
  workspaceRootPath: string,
  disabledSourceSlugs: string[],
): Promise<void> {
  for (const sourceSlug of disabledSourceSlugs) {
    const cachePath = join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
    await rm(cachePath, { force: true });
  }
}

// ============================================================
// Provider-Agnostic Connection Testing
// ============================================================

/**
 * Which runtimes read the connection test's key and base URL out of the
 * `ANTHROPIC_*` environment (P2.205 site 14).
 *
 * Was `effectiveProvider === 'anthropic'`. Benign as written — the other three
 * runtimes carry their credentials on the synthetic connection instead — and
 * still a per-runtime decision no new runtime should inherit silently: the
 * failure mode is a test that runs with NO credentials at all and reports the
 * connection broken.
 */
const PROVIDER_TAKES_ANTHROPIC_TEST_ENV: Record<AgentProvider, boolean> = {
  anthropic: true,
  pi: false,
  'codex-runtime': false,
  'nestor-cloud-agent': false,
};

export async function testBackendConnection(args: {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
  allowEmptyApiKey?: boolean;
  connection?: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;
}): Promise<{ success: boolean; error?: string }> {
  const trimmedKey = args.apiKey.trim();
  if (!trimmedKey && !args.allowEmptyApiKey) {
    return { success: false, error: 'API key is required' };
  }
  // The hint's providerType, not the RPC's legacy `provider` field, selects the
  // driver for an adapter-runtime connection (C3): `TestLlmConnectionParams.provider`
  // is `'anthropic' | 'pi'` and cannot name `codex-runtime` at all, and for
  // `claude-runtime` the two agree anyway. Resolved BEFORE the gate so a codex
  // test in a build without the Claude flags is not refused as "Claude disabled".
  const effectiveProvider: AgentProvider = args.connection?.providerType
    && isAdapterRuntimeProvider(args.connection.providerType)
    ? providerTypeToAgentProvider(args.connection.providerType)
    : args.provider;
  const gateError = claudeBuildGateError(effectiveProvider, args.connection?.providerType);
  if (gateError) {
    return { success: false, error: gateError };
  }

  const tempSlug = `__test-${Date.now()}`;
  const cm = getCredentialManager();
  // DA1.13 — the SECOND production writer of a gateway JWT into the credential
  // store, and the only one whose delete can silently fail: the `finally` below
  // is `.catch(() => {})`, so a store that refuses the delete leaves a real
  // corporate token behind under a `__test-<ms>` slug no connection owns and
  // nothing ever reads or cleans up. The gateway cards are zero-form and have no
  // Test button of their own, but `ApiKeyInput` PREFILLS the JWT whenever the
  // gateway preset is active, so the form's Test button reaches here with one.
  // Nothing is lost by not staging it: a gateway target resolves to
  // `kind: 'nestor'` and both runtime drivers' test arms return early without
  // reading the store, while a Pi gateway session reads the live creds file.
  const staged = !!trimmedKey
    && !isGatewayBackedConnection({ providerType: args.connection?.providerType, baseUrl: args.baseUrl });
  if (staged) {
    await cm.setLlmApiKey(tempSlug, trimmedKey);
  }

  try {
    const testModel = args.model;
    const providerType = args.connection?.providerType ?? getDefaultProviderType(effectiveProvider);
    const now = Date.now();
    const authType: LlmAuthType = (
      providerType === 'pi_compat' || isAdapterRuntimeProvider(providerType)
    )
      ? 'api_key_with_endpoint'
      : 'api_key';

    const syntheticConnection = {
      slug: tempSlug,
      name: 'Temporary Connection Test',
      providerType,
      authType,
      defaultModel: testModel,
      createdAt: now,
      piAuthProvider: args.connection?.piAuthProvider,
      customEndpoint: args.connection?.customEndpoint,
      ...(args.baseUrl?.trim() ? { baseUrl: args.baseUrl.trim() } : {}),
    } as LlmConnection;

    const context: ResolvedBackendContext = {
      connection: syntheticConnection,
      provider: effectiveProvider,
      authType,
      resolvedModel: testModel,
      capabilities: BACKEND_CAPABILITIES[effectiveProvider],
    };

    const { driver, resolvedPaths } = resolveDriverRuntime(effectiveProvider, args.hostRuntime);
    if (driver.testConnection) {
      const driverResult = await driver.testConnection({
        provider: effectiveProvider,
        apiKey: trimmedKey,
        model: testModel,
        baseUrl: args.baseUrl,
        connection: args.connection,
        hostRuntime: args.hostRuntime,
        resolvedPaths,
        timeoutMs: args.timeoutMs ?? 20000,
      });
      // null = driver declined to handle; fall through to generic subprocess test
      if (driverResult !== null) return driverResult;
    }

    const cwd = tmpdir();
    const agent = createBackendFromResolvedContext({
      context,
      coreConfig: {
        workspace: {
          id: '__test',
          workspaceRootPath: cwd,
          sessionRootPath: cwd,
          config: { id: '__test', name: 'Connection Test', createdAt: 0, updatedAt: 0 },
          lastAccessedAt: 0,
        },
        session: { id: `test-${now}`, workspaceId: '__test', createdAt: 0, lastUsedAt: 0 },
        isHeadless: true,
        miniModel: testModel,
        envOverrides: PROVIDER_TAKES_ANTHROPIC_TEST_ENV[effectiveProvider]
          ? {
            ANTHROPIC_API_KEY: trimmedKey,
            ...(args.baseUrl?.trim() ? { ANTHROPIC_BASE_URL: args.baseUrl.trim() } : {}),
          }
          : undefined,
      },
      hostRuntime: args.hostRuntime,
      providerOptions: { piAuthProvider: args.connection?.piAuthProvider },
    });

    const readAgentStderr = (): string => {
      const maybe = agent as unknown as { getRecentStderr?: () => string };
      return typeof maybe.getRecentStderr === 'function' ? maybe.getRecentStderr() : '';
    };
    const withStderrContext = (message: string): string => {
      const stderr = readAgentStderr();
      if (!stderr) return `${message} (subprocess produced no stderr output)`;
      return `${message}\n--- subprocess stderr (last ~8KB) ---\n${stderr}`;
    };

    try {
      const timeoutMs = args.timeoutMs ?? 20000;
      const text = await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(withStderrContext(`Connection test timed out after ${timeoutMs}ms`))),
            timeoutMs
          )
        ),
      ]);

      return text
        ? { success: true }
        : { success: false, error: 'No response from provider. Check your API key.' };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      // Avoid double-appending if the timeout branch already included stderr context.
      const enriched = base.includes('subprocess stderr') ? base : withStderrContext(base);
      return { success: false, error: enriched };
    } finally {
      agent.destroy();
      // F1.416 — since F1.257 `destroy()` keeps its key's mode entry (for a real session that entry is the
      // host's); this synthetic key belongs to no session, so the test clears it itself.
      cleanupModeState({ workspaceId: '__test', sessionId: `test-${now}` });
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cm.deleteLlmApiKey(tempSlug).catch(() => {});
  }
}

// ============================================================
// Connection Validation
// ============================================================

/**
 * Validate an LLM connection by dispatching to provider-specific validation.
 *
 * - Anthropic/compat/Bedrock/Vertex: validates via Claude Agent SDK (query with maxTurns:1)
 * - OpenAI/Copilot/Pi: returns success (these providers validate on connect, no pre-flight check available)
 *
 * For more thorough provider-specific validation (model list checks, OAuth refresh, etc.),
 * see the IPC handler in apps/electron/src/main/ipc.ts.
 *
 * @param connection - The LLM connection to validate
 * @param credentials - API key or OAuth token for validation
 * @returns Validation result
 */
export async function validateConnection(
  connection: LlmConnection,
  credentials: { apiKey?: string; oauthToken?: string },
): Promise<LlmValidationResult> {
  // P2.205 site 15, the degrade half: an unrecognised `providerType` is
  // reported unsupported instead of being classified as Anthropic and
  // validated against api.anthropic.com. Measured on the parent commit, this
  // is what the row's headline looked like from the outside — a connection
  // named `sonnet-of-nobody` came back with Anthropic's own auth-failure
  // string, because it had been sent there.
  const provider = tryProviderTypeToAgentProvider(connection.providerType);
  if (!provider) {
    return { success: false, error: `Unsupported connection type: ${connection.providerType}` };
  }

  switch (provider) {
    case 'anthropic': {
      const gateError = claudeBuildGateError(provider, connection.providerType);
      if (gateError) {
        return { success: false, error: gateError };
      }

      // Anthropic-based providers can be validated via the Claude Agent SDK
      const { validateAnthropicConnection } = await import('../../config/llm-validation.ts');
      return validateAnthropicConnection({
        model: connection.defaultModel || DEFAULT_MODEL,
        apiKey: credentials.apiKey,
        oauthToken: credentials.oauthToken,
        baseUrl: connection.baseUrl,
      });
    }

    case 'pi':
      // Pi validates on connect via its auth storage — no pre-flight check available
      return { success: true };

    // P2.205 site 15, the declaration half. These two answered `{ success: true }`
    // through the `default:` arm — a runtime nobody described was VALIDATED AS
    // WORKING, and so were these two, without anyone deciding it. The value is
    // unchanged and now belongs to a runtime that owns it: codex is validated by
    // the app-server handshake on first use (`codexDriver.testConnection` is the
    // real pre-flight, reached from the setup path), and a nestor-cloud
    // connection carries no credential to check at all (`authType: 'none'`,
    // `nestorCloudDriver.testConnection` returns `null` on purpose).
    case 'codex-runtime':
      return { success: true };

    case 'nestor-cloud-agent':
      return { success: true };

    default:
      return unreachableRuntime(provider, 'validateConnection');
  }
}
