/**
 * LLM Connections
 *
 * Named provider configurations that users can add, configure, and switch between.
 * Each session locks to a specific connection after the first message.
 * Workspaces can set a default connection.
 */

// Import model types and lists from centralized registry
// NOTE: Pi SDK functions (getPiModelsForAuthProvider, getAllPiModels) are NOT imported
// here because @earendil-works/pi-ai transitively pulls in @aws-sdk which uses Node.js
// `stream` module — breaking the Vite renderer build. Instead, Pi model resolution is
// injected at app startup via registerPiModelResolver().
import {
  type ModelDefinition,
  ANTHROPIC_MODELS,
  getModelsByProvider,
  normalizeDeprecatedModelId,
} from './models';
import {
  DEFAULT_BEDROCK_REGION_PREFIX,
  bareToBedrockNativeModelId,
  bedrockNativeToBareModelId,
  deriveBedrockRegionPrefix as deriveBedrockRegionPrefixFromRegion,
  readBedrockRegionPrefixOverride as readBedrockRegionPrefixOverrideFromEnv,
  splitBedrockNativeModelId,
  type BedrockRegionPrefixOverride,
} from './bedrock-model-ids.ts';
export {
  BEDROCK_REGION_PREFIX_ENV_VAR,
  BEDROCK_REGION_PREFIX_OVERRIDE_VALUES,
} from './bedrock-model-ids.ts';
export type { BedrockRegionPrefixOverride } from './bedrock-model-ids.ts';
import type { CredentialManager } from '../credentials/manager.ts';
// Renderer-safe by construction: `managed-model-allowlist.ts` has no imports at
// all, for the reason its header states. Never reach for the policy module here
// — it pulls `node:os`/`node:path` in through the permission DSL and breaks the
// Vite renderer build, exactly like the Pi SDK note above.
import {
  isModelInManagedAllowlist,
  managedModelAllowlist,
} from './managed-model-allowlist.ts';
import {
  CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS,
  CLAUDE_SDK_STRIPPED_ENV_KEYS,
} from './claude-provider-routing-env.ts';
// Same renderer-safe shape as the allowlist above, and for a second reason: the
// Pi subprocess reads this constant too (P3.137). See its header.
import { PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES } from './compat-image-default.ts';
import { normalizeThinkingLevel, type ThinkingLevel } from '../agent/thinking-levels.ts';
// Renderer-safe for the same reason as the two above: `feature-flags.ts` reads
// `process.env` only behind a `typeof process !== 'undefined'` guard and imports
// nothing from node.
import { parseBooleanEnv } from '../feature-flags.ts';
// P6.498 — the gateway HOST, which is the same fact that decides whether a
// session carries `Nestor-Token`. Imported rather than re-spelled: a second
// copy of a hostname is a second thing to rename.
import { NESTOR_GATEWAY_HOST } from '../auth/nestor.ts';

// ============================================================
// Pi Model Resolver (dependency injection to avoid Pi SDK in renderer)
// ============================================================

type PiModelResolver = (piAuthProvider?: string) => ModelDefinition[];
let _piModelResolver: PiModelResolver = () => [];

/**
 * Register the Pi model resolver function.
 * Must be called from main process at app startup (before any Pi connections are used).
 * This avoids pulling @earendil-works/pi-ai into the renderer bundle.
 */
export function registerPiModelResolver(resolver: PiModelResolver): void {
  _piModelResolver = resolver;
}

// ============================================================
// Types
// ============================================================

/**
 * Provider type determines which backend/SDK implementation to use.
 * This is separate from auth mechanism - a provider may support multiple auth types.
 *
 * - 'anthropic': Direct Anthropic API (api.anthropic.com) — uses Claude Agent SDK
 * - 'pi': Pi unified LLM API (20+ providers via @earendil-works/pi-ai)
 * - 'pi_compat': Pi with custom endpoint (Ollama, self-hosted models, Anthropic-compat endpoints)
 * - 'claude-runtime': Claude Agent SDK pointed at a custom Anthropic-compatible
 *   endpoint (Nessy Gateway, self-hosted relay). Same backend class as
 *   'anthropic' (ClaudeAgent) but the endpoint, credentials and model catalog
 *   all come from the connection, never from api.anthropic.com defaults.
 */
export type LlmProviderType =
  | 'anthropic'
  | 'pi'
  | 'pi_compat'
  | 'codex-runtime'
  | 'claude-runtime'
  | 'nestor-cloud-agent';

/**
 * P6.532 — a codex `model_provider` a CONNECTION may declare, as opposed to the
 * loopback provider the writer pins by default.
 *
 * Two members since F1.202, and typed as a union rather than a bare string on purpose:
 * codex publishes several built-in providers, and the next one to be offered as
 * a card has to be added here — which makes it visible — rather than arriving as
 * an arbitrary string that reaches `config.toml` unchecked.
 *
 * `amazon-bedrock` is codex's OWN provider id, not ours: codex reads
 * `model_provider = "amazon-bedrock"` from `config.toml` and takes credentials
 * from `AWS_BEARER_TOKEN_BEDROCK` or the AWS SDK chain. Nothing had to be built
 * for it; our own writer was the only thing standing between an operator and a
 * capability the runtime already has, which is why the row's native clause reads
 * "codex HAS it natively".
 */
export type CodexModelProvider = 'amazon-bedrock' | 'openai'; // F1.202 — `openai`: the ChatGPT (Codex) card, see CODEX_CHATGPT_MODEL_PROVIDER

/** The one declared value, exported so a call site cannot misspell it. */
export const CODEX_BEDROCK_MODEL_PROVIDER: CodexModelProvider = 'amazon-bedrock';

/**
 * Authentication mechanism for the connection.
 * Determines the UI pattern, credential storage format, and how credentials are passed.
 *
 * Simple token auth:
 * - 'api_key': Single API key field, fixed endpoint known
 * - 'api_key_with_endpoint': API key + custom endpoint URL fields
 * - 'bearer_token': Single bearer token (different header than API key)
 *
 * OAuth flows (browser redirect):
 * - 'oauth': Browser OAuth flow, provider determined by providerType
 *
 * Cloud provider auth:
 * - 'iam_credentials': AWS-style (Access Key + Secret Key + Region)
 * - 'service_account_file': GCP-style JSON file upload
 * - 'environment': Auto-detect from environment variables
 *
 * No auth:
 * - 'none': No authentication required (local models like Ollama)
 */
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'iam_credentials'
  | 'bearer_token'
  | 'service_account_file'
  | 'environment'
  | 'none';

/**
 * Ownership mode for a connection's model list.
 * - automaticallySyncedFromProvider: provider defaults are synced automatically.
 * - userDefined3Tier: user-picked Best/Balanced/Fast list is preserved.
 */
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';

/**
 * Protocol for custom API endpoints.
 * Determines which streaming adapter the Pi SDK uses for requests.
 */
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/**
 * Custom endpoint protocol config.
 * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
 */
export interface CustomEndpointConfig {
  api: CustomEndpointApi;
  /**
   * Which header this endpoint reads its credential from (P6.258, denominator
   * C16). `undefined` — the value on every connection that has never set it —
   * means `authorization`, so no existing connection changes.
   *
   * NOT the protocol, which is `api`: an endpoint can speak either wire and read
   * either header, and an `x-api-key`-only gateway in front of an OpenAI-shaped
   * upstream is the case that could not be connected at all before this field.
   * Two values rather than an arbitrary header NAME, deliberately — an arbitrary
   * name in a config file is a credential-exfiltration primitive, and no endpoint
   * we have measured needs one.
   */
  credentialHeader?: 'authorization' | 'x-api-key';
  /** Explicit capability hint for arbitrary endpoints — never guessed automatically. */
  supportsImages?: boolean;
  /**
   * Dialect quirks to force for this connection's models.
   *
   * NOT a protocol — the protocol is `api`, and it is two-valued. Qwen-family
   * models speak ordinary chat-completions and merely need two mitigations
   * (reasoning-block splitting and tool-schema weakening) that
   * `tool-schema-dialect.ts` already applies per request BY MODEL ID. That
   * detection is an allowlist, so a Qwen model served under a house id it has
   * never heard of gets neither mitigation and leaks its reasoning into the
   * answer.
   *
   * `'qwen'` forces both for every model on the connection; absent means the
   * per-id detection decides, which is the behaviour every existing connection
   * keeps.
   */
  dialect?: 'qwen';
}

/**
 * Per-connection behavior when the user sends a message while the agent is
 * still streaming/processing a previous turn.
 *
 * - 'steer': Try to deliver the message into the in-flight turn (Pi's native
 *   `.steer()` or Claude's PreToolUse `additionalContext` hook). Falls back to
 *   abort+queue when the backend can't steer.
 * - 'queue': Hold the message; let the current turn finish naturally; replay
 *   as a new turn afterwards. No abort, no destructive interruption.
 *
 * Default is per-`providerType` via {@link defaultMidStreamBehavior}; reads
 * everywhere should go through {@link resolveMidStreamBehavior} so connections
 * created before this field existed still pick up the right default.
 */
export type MidStreamBehavior = 'steer' | 'queue';

/**
 * LLM Connection configuration.
 * Stored in config.llmConnections array.
 */
export interface LlmConnection {
  /** URL-safe identifier (e.g., 'anthropic-api', 'ollama-local') */
  slug: string;

  /** Display name shown in UI (e.g., 'Anthropic (API Key)', 'Ollama') */
  name: string;

  /** Provider type determines backend/SDK implementation */
  providerType: LlmProviderType;

  /** Custom base URL (required for *_compat providers, optional override for others) */
  baseUrl?: string;

  /** Authentication mechanism */
  authType: LlmAuthType;

  /** Override available models (for custom endpoints that don't support model listing) */
  models?: Array<ModelDefinition | string>;

  /** Default model for this connection */
  defaultModel?: string;

  /**
   * P6.362 · operator-declared aliases: an id this connection is known to serve
   * under a DIFFERENT name, mapped onto the served one.
   *
   * The escape hatch, and deliberately the SECOND tier — see
   * {@link resolveConnectionModelAlias}, which asks the endpoint's own alias
   * field first. It exists because the endpoint that most needs it publishes
   * nothing to ask: a connection whose `defaultModel` is absent from its own
   * catalogue keeps that default (the substitution in
   * `resolveModelForProvider` is pi-only, deliberately — "substituting the
   * user's own declared default is a guess"), and an EXPLICIT alias is the one
   * thing that is not a guess.
   *
   * A target the catalogue does not serve, or one the managed allowlist
   * forbids, is NOT honoured — an alias that cannot land is not an alias, and
   * the unrecognised-model diagnostic must still fire.
   */
  modelAliases?: Record<string, string>;

  /**
   * The utility model — title generation, mini completions, the mini agent.
   *
   * An explicit slot because the heuristic that fills it otherwise
   * ({@link getMiniModel}'s keyword search, then last-in-list) cannot work on a
   * BYO endpoint whose cheap model is named nothing in particular. A gateway
   * publishing `deepseek-v3` and `deepseek-r1` has no `haiku`, no `mini` and no
   * `flash`, so the fallback picks whatever sorts last.
   *
   * Read ONLY through {@link getMiniModel}. {@link getSummarizationModel} keeps
   * its own delegation on purpose — the two tiers are separate so they can
   * diverge, and collapsing them onto one knob is a different decision than
   * this one.
   */
  miniModel?: string;

  /**
   * Ownership mode for the model list.
   * - automaticallySyncedFromProvider: provider defaults are kept in sync.
   * - userDefined3Tier: preserve user-selected Best/Balanced/Fast list.
   */
  modelSelectionMode?: ModelSelectionMode;

  /**
   * Epoch ms of the last successful model-metadata sync from the endpoint's
   * own `/models`. Its PRESENCE is the enrollment marker for the startup
   * refresh (a BYO connection without it is never fetched); its VALUE drives
   * the 24h TTL. `modelSelectionMode` is never consulted for enrollment.
   *
   * `null` means explicitly withdrawn — the update-merge treats `undefined` as
   * "leave as persisted", so a nullable type is what lets the form's toggle
   * turn enrollment back OFF.
   */
  modelsSyncedAt?: number | null;

  /**
   * DA2.12 — WHEN the host last REPLACED this connection's model list from a
   * live catalogue fetch, in epoch ms. Written by
   * `ModelRefreshService._doRefresh` in the same update that writes `models`.
   *
   * A SECOND field, and C3.346 refused the shortcut of borrowing the first one
   * for a reason worth keeping in view: {@link modelsSyncedAt} is the BYO
   * metadata-sync ENROLMENT marker — `isModelSyncEnrolled`
   * (`packages/server-core/src/model-fetchers/index.ts`) returns false for any
   * connection without it — so stamping it where the gateway catalogue is
   * replaced would ENROL the card and give one model list two writers, which is
   * the hazard that module declines by name. The two fields answer two
   * questions: `modelsSyncedAt` is "is this connection enrolled, and when did
   * the metadata MERGE last run", this one is "when was the list last READ".
   *
   * Absent means never fetched, which is the honest answer for a connection
   * whose list was typed by the user or shipped with the app; the renderer's
   * provenance line omits the time rather than inventing one
   * (`apps/electron/src/renderer/lib/model-list-provenance.ts`).
   */
  catalogueRefreshedAt?: number;

  /**
   * Pi auth provider name (e.g., 'anthropic', 'openai', 'github-copilot').
   * Determines which provider credential Pi SDK uses for LLM calls.
   * Only relevant for 'pi' providerType connections.
   */
  piAuthProvider?: string;

  /**
   * P6.532 (C15, Q-den 72 = option b) — this connection's codex `model_provider`,
   * DECLARED. Today the only value is `amazon-bedrock`.
   *
   * Set it and the codex config writer pins codex's own built-in Bedrock
   * provider instead of our loopback adapter; leave it unset and the loopback
   * pin stands exactly as before, byte for byte.
   *
   * **The whole point is that this is a DECLARATION and not a detection.**
   * Option c — honour codex's own ambient AWS credential chain — was refused
   * because it is precisely the reroute C5 exists to refuse, and it would ship
   * silently on the one runtime whose child already inherits the variable: every
   * non-Claude child is built by spreading `process.env`
   * (`codex-agent-server/src/runtime-manager.ts`), and `AWS_BEARER_TOKEN_BEDROCK`
   * survives the boot reset on purpose (P3.346 exists to keep it, because Pi's
   * Bedrock card reads it). So an ambient Bedrock credential ALREADY reaches the
   * codex child today; the only question this field answers is whether anything
   * may ACT on it, and the answer is "only when a connection says so".
   *
   * Read it through {@link resolveCodexModelProvider} — never directly — so the
   * providerType check and the operator's off switch cannot be forgotten at a
   * call site.
   */
  codexModelProvider?: CodexModelProvider;

  /**
   * Custom endpoint protocol config.
   * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
   * Determines which streaming adapter the Pi SDK uses for requests.
   */
  customEndpoint?: CustomEndpointConfig;

  /**
   * P6.374 (K23) — `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` on this
   * connection's claude child.
   *
   * The escape for one class of gateway 400. `llm-gateway-connect.md
   * #troubleshoot-gateway-errors`, the row for *"`400` errors naming `thinking`
   * or `adaptive`, such as `Input tag 'adaptive' found`"*, verbatim: *"The
   * upstream model build doesn't accept adaptive reasoning, which Claude Code
   * requests for Claude 4.6 and later models … On Opus 4.6 and Sonnet 4.6,
   * `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` works instead."* Present in the
   * shipped bundle (6 occurrences against 0 for a control name) and set by
   * nothing in this tree before this row.
   *
   * PER CONNECTION and not global, because the answer is a property of the
   * upstream a connection points at: one BYO gateway rejects `adaptive` and the
   * next one requires it. The alternative — widening the adapter's reactive
   * removal list — is refused on the module's own advice:
   * `anthropic/passthrough-negotiation.ts` names `thinking` among the fields it
   * must never silently rewrite, so the reactive path cannot rescue this class
   * by design.
   */
  disableAdaptiveThinking?: boolean;

  /**
   * P6.374 (K24) — `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` on this
   * connection's claude child.
   *
   * The escape for the other class. Same page and row set: *"Set
   * `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, which suppresses most
   * pre-release fields"* for *"`400` errors naming `context_management`, `Extra
   * inputs are not permitted`, or other unrecognized fields"*. 7 occurrences in
   * the shipped bundle, 0 in this tree before this row.
   *
   * What we built instead is narrower and better in one direction — reactive
   * per-upstream removal, fired only after a 400 that names the field and
   * remembered per upstream URL — but its removable set is ONE entry
   * (`context_management`) against the four field families
   * `llm-gateway-protocol.md#feature-pass-through` lists. This carries the rest,
   * up front, for a connection whose operator already knows their gateway.
   *
   * TWO CARVE-OUTS THE PAGE STATES, both preserved here rather than assumed:
   * *"The variable doesn't affect adaptive reasoning, which is selected by model
   * rather than by beta"* — which is why K23 above is a SEPARATE field and not a
   * consequence of this one — and *"It never suppresses the OAuth capability
   * that subscription authentication requires."* Our tool search is untouched
   * for a third reason of our own: it is two ordinary tools plus a host catalog,
   * not the API's `defer_loading` beta, as `config/tool-search-settings.ts`
   * records.
   *
   * ## THE PERSISTENCE LINE IS OWED, and it is not in this file
   *
   * `updateLlmConnection` rebuilds a connection from a HARDCODED allowlist
   * (`config/storage.ts`), so a field missing from it is dropped on the next
   * save (`packages/shared/AGENTS.md`, issue #838). `addLlmConnection` spreads
   * the whole object, so a connection CREATED with either flag keeps it — but
   * one EDITED afterwards loses it silently. The two allowlist lines belong to
   * that file's holder and are handed over rather than taken, per the wave's
   * file-zoning rule; until they land, treat these flags as create-time only.
   */
  disableExperimentalBetas?: boolean;

  /**
   * Behavior when the user sends a message while the agent is still streaming.
   * Optional for backward compat with config.json from before this field existed —
   * read via {@link resolveMidStreamBehavior} which falls back to a per-provider
   * default ({@link defaultMidStreamBehavior}).
   */
  midStreamBehavior?: MidStreamBehavior;

  // --- Resolved Anthropic OAuth identity (issue #838) ---
  // Captured from the token-exchange response; lets the UI flag two Claude
  // connections that resolve to the same underlying account. All optional and
  // fail-soft — absent identity simply means nothing is shown.
  oauthAccountUuid?: string;
  oauthAccountEmail?: string;
  oauthOrganizationUuid?: string;
  oauthOrganizationName?: string;
  oauthProfileVerifiedAt?: number; // epoch ms

  // --- Timestamps ---

  /** Timestamp when connection was created */
  createdAt: number;

  /** Timestamp when connection was last used */
  lastUsedAt?: number;
}

/**
 * LLM Connection with authentication status.
 * Used by UI to show which connections are ready to use.
 */
export interface LlmConnectionWithStatus extends LlmConnection {
  /** Whether the connection has valid credentials */
  isAuthenticated: boolean;

  /** Error message if authentication check failed */
  authError?: string;

  /** Whether this is the global default connection */
  isDefault?: boolean; /** F1.979 — the region codex's own Bedrock provider picks, set on the codex Bedrock card only (`resolveCodexBedrockCardRegion`); one line so every cited line below stays put. */ codexBedrockRegion?: import('../agent/bedrock-region.ts').CodexBedrockRegionReading;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Returns true when `modelId` must NOT be used as the mini/summarization model
 * given the current auth flavor.
 *
 * - `codex-mini-latest` is always denied (Pi SDK rejects it outright).
 * - When `piAuthProvider === 'openai-codex'` (ChatGPT Plus/Pro OAuth or
 *   ChatGPT-JWT API key), all `*codex-mini*` variants (e.g. `gpt-5.1-codex-mini`)
 *   are denied — the ChatGPT backend refuses them with: "The '<model>' model is
 *   not supported when using Codex with a ChatGPT account."
 *   A regular OpenAI API key uses provider `'openai'`, which is unaffected.
 */
/**
 * D1.116 — the effort level THIS connection's catalogue publishes for a model,
 * normalized to a thinking level, or `undefined` when it publishes none.
 *
 * The second half of D1.116's decided pair, and the reason it could not live in
 * `thinking-levels.ts`: that module answers from `getModelById`, i.e. from
 * `MODEL_REGISTRY` — nine rows, the documented claude families, and no gateway
 * or BYO id has ever been in it. The fact this reads is on the CONNECTION, put
 * there by the fetcher that read the catalogue (`reasoningEffort`, DA1.22).
 *
 * It is a DEFAULT and never an override: the caller places it below the user's
 * own configured level, so a recommendation can only fill a gap. That is the
 * same posture `toChatRequest` takes with the same value one layer down, and it
 * is what keeps the owner's accepted `low` from being outbid by a `medium`
 * nobody chose.
 *
 * A row that publishes an effort this product has no level for is `undefined`
 * rather than a guess — `normalizeThinkingLevel` decides, and a vocabulary
 * mismatch must not become a silent `medium`.
 */
export function publishedModelThinkingLevel(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  modelId: string | undefined,
): ThinkingLevel | undefined {
  if (!connection || !modelId) return undefined;
  for (const entry of connection.models ?? []) {
    if (typeof entry !== 'object' || entry === null || !('id' in entry)) continue;
    if ((entry as { id?: unknown }).id !== modelId) continue;
    const published = (entry as { reasoningEffort?: unknown }).reasoningEffort;
    if (typeof published !== 'string' || published.length === 0) return undefined;
    return normalizeThinkingLevel(published);
  }
  return undefined;
}

export function isDeniedMiniModelId(modelId: string, piAuthProvider?: string): boolean {
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  if (bare === 'codex-mini-latest') return true;
  if (piAuthProvider === 'openai-codex' && bare.includes('codex-mini')) return true;
  return false;
}

/**
 * Get the mini/utility model ID for a connection.
 * Provider-aware search:
 *   - Anthropic: find any model with "haiku" in its id/name
 *   - Pi: find any model with "mini" or "flash" in its id/name
 *   - Otherwise: last model in the list
 *
 * Auth-flavor-aware: skips models that the user's `piAuthProvider` would reject
 * (e.g. `gpt-5.1-codex-mini` under ChatGPT-account auth). See
 * {@link isDeniedMiniModelId}.
 *
 * Used for mini agent, title generation, and mini completions.
 */
export function getMiniModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider' | 'miniModel'>,
): string | undefined {
  // An explicit choice wins — but it still passes the managed allowlist, which
  // `findSmallModel` applies to its own candidates and which no user selection
  // may escape. A forbidden explicit value falls through to the heuristic
  // rather than being honoured or hard-refused: `model-config.md:167` — the
  // tier "falls back to the inherited or default model rather than failing the
  // request".
  //
  // `isDeniedMiniModelId` is deliberately NOT applied here. It is a
  // provider-auth heuristic (a Codex-flavoured id under ChatGPT-account auth),
  // and `findSmallModel` already lets it be overridden when nothing else
  // survives; second-guessing a value the user typed for their own endpoint is
  // exactly the case that heuristic gets wrong.
  const explicit = connection.miniModel?.trim();
  if (explicit && isModelInManagedAllowlist(managedModelAllowlist(), explicit)) return explicit;
  return findSmallModel(connection);
}

/**
 * C3.171 (QK8) — what the background tier was ASKED for against what it actually
 * runs on, when the two differ, or `undefined` when they do not.
 *
 * ## The rule this makes visible, in this file's own words
 *
 * {@link PI_MINI_PREFERRED_DEFAULTS}'s header states it verbatim — *"a candidate
 * that does not resolve is skipped, so an invented id silently degrades the pick
 * rather than failing loudly"* — with two measured instances (github-copilot's
 * dotted ids, amazon-bedrock's bare ids) where the mini pick resolved to nothing
 * at all. `amazon-bedrock.md` names what the silence costs, verbatim: *"Opus
 * models have a higher per-token price than Sonnet models, so a deployment that
 * doesn't pin a primary model is billed at the Opus rate"*. The pick is a
 * BILLING fact, and the product said nothing about it on any runtime.
 *
 * ## Where the fallback really lands, measured rather than assumed
 *
 * {@link findSmallModel} does not answer `undefined` when its keyword search
 * finds nothing: its last line returns *"the last allowed model in the list"*.
 * So a catalogue with no small-class model degrades to a LARGE one silently,
 * which is P2.97's own finding ("the most expensive model in each list, on every
 * background task") reachable again through any catalogue the keywords miss.
 * That is why the test for a degradation is {@link isSmallClassModelId} on the
 * id the tier really uses, and not `getMiniModel() === undefined`.
 *
 * ## Three narrowings, each of which would otherwise make this cry wolf
 *
 * - **The endpoint's own declaration wins.** A catalogue that publishes an alias
 *   for its cheap tier ({@link resolveGatewayFastModelId}) has ANSWERED the
 *   question, and the keyword heuristic does not get to contradict it — the live
 *   gateway's fast model is `tgpt/qwen36-35b-a3b-fp8`, which matches no keyword
 *   in {@link isSmallClassModelId} and is nonetheless exactly right.
 * - **An explicit choice that IS honoured is never a finding.** A person typed
 *   it; a large model chosen deliberately is a decision, not a degradation.
 * - **An EMPTY catalogue is not a finding.** A connection whose models were never
 *   fetched knows nothing about any id, and a warning derived from an absence of
 *   data is the kind that teaches people to ignore warnings — the same narrowing
 *   `SessionManager.warnIfModelIdUnrecognized` is written with.
 *
 * PURE, and it names no channel: the caller decides where the sentence goes.
 * `SessionManager` drains it beside `warnIfModelIdUnrecognized` and
 * `announceModelDefaultSubstitution`, the one host-side seam that answers
 * identically on Pi, Claude and Codex.
 */
export interface MiniModelDegradation {
  /** The id the connection asked for, when a person typed one. */
  readonly requested?: string;
  /** The id background tasks (titles, summaries, mini completions) really run on. */
  readonly used: string;
  readonly reason: 'explicit-not-honoured' | 'no-small-model';
}

/** @see MiniModelDegradation */
export function describeMiniModelDegradation(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider' | 'miniModel' | 'defaultModel'>,
): MiniModelDegradation | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;
  const resolved = getMiniModel(connection);
  // The caller's own expression, at every mini site in this tree:
  // `getMiniModel(conn) ?? conn.defaultModel`.
  const used = resolved ?? connection.defaultModel?.trim();
  if (!used) return undefined;
  const explicit = connection.miniModel?.trim();
  if (explicit) {
    return explicit === used
      ? undefined
      : { requested: explicit, used, reason: 'explicit-not-honoured' };
  }
  if (resolveGatewayFastModelId({ models: connection.models }) === used) return undefined;
  return isSmallClassModelId(used) ? undefined : { used, reason: 'no-small-model' };
}

/**
 * The sentence {@link describeMiniModelDegradation} is worth saying out loud.
 *
 * English and unlocalised, the rule every other runtime degradation notice in
 * this tree follows (`ClaudeAgent.queueDegradationNotice`,
 * `SessionManager.warnIfModelIdUnrecognized`): it names machine identifiers a
 * translation would have to carry verbatim anyway.
 *
 * The explicit branch names the administrator's list because that is the only
 * thing that refuses an explicit choice here — {@link getMiniModel} returns a
 * typed value unless {@link isModelInManagedAllowlist} says no — and a reader
 * who is not told the cause cannot act on the notice.
 */
export function formatMiniModelDegradationNotice(
  degradation: MiniModelDegradation,
  connectionSlug: string,
): string {
  const tail = `Background tasks on \`${connectionSlug}\` — session titles, summaries and mini`
    + ` completions — run on \`${degradation.used}\` and are billed at that model's rate.`;
  return degradation.reason === 'explicit-not-honoured'
    ? `The small/fast model this connection asks for, \`${degradation.requested}\`, was skipped rather`
      + ` than refused: an administrator's allowed-models list is the only thing that declines one`
      + ` here. ${tail}`
    : `No model in this connection's catalogue looks like a small/fast one, and the catalogue`
      + ` declares no cheap tier of its own, so the background tier fell through to the largest`
      + ` model left. ${tail}`;
}

/**
 * Alias the Nessy Gateway `/cli/models` API reports for its cheap model tier.
 * `fetchNestorModels` maps the API `alias` field onto {@link ModelDefinition.shortName},
 * so a catalog entry whose `shortName` is `fast` (case-insensitive) is the
 * gateway's fast model. The underlying model id rotates (e.g.
 * `tgpt/qwen36-35b-a3b-fp8` as of 2026-07-18) — resolve by alias, never by a
 * pinned id.
 */
export const NESSY_GATEWAY_FAST_ALIAS = 'fast';

/**
 * Resolve the id of the Nessy Gateway "fast" model from a connection's catalog,
 * matching by the gateway alias (surfaced as {@link ModelDefinition.shortName}).
 * Returns `undefined` for connections without a `fast`-aliased entry (every
 * non-gateway provider, and any gateway catalog that predates the alias), so
 * callers keep today's behavior exactly on those.
 *
 * Used host-side to default the orchestrator `small` tier to the cheap model so
 * read-only subagents (e.g. the built-in `scout`) don't burn the flagship (T1).
 */
export function resolveGatewayFastModelId(
  connection: Pick<LlmConnection, 'models'>,
): string | undefined {
  return resolveGatewayAliasModelId(connection, NESSY_GATEWAY_FAST_ALIAS);
}

/**
 * Alias the Nessy Gateway `/cli/models` API reports for its FLAGSHIP coding
 * model — the counterpart of {@link NESSY_GATEWAY_FAST_ALIAS}, and the reason
 * P6.1080 needed one.
 *
 * The gateway rotates the id behind this alias and keeps the alias: measured
 * 2026-09-11 it is `tgpt/deepseek-v4-flash-0731`, and the id it replaced —
 * `tgpt/qwen35-397b-a17b-fp8`, which this repo called "the default coder model"
 * for a year — is now answered `404 … больше не поддерживается`. So the alias is
 * the stable half and the id is not, which is exactly what
 * {@link resolveGatewayFastModelId}'s own docblock already said about the other
 * tier.
 */
export const NESSY_GATEWAY_CODER_ALIAS = 'coder';

/**
 * The id behind a gateway alias, or `undefined` when this catalogue publishes no
 * such alias or the managed allowlist forbids the model it names.
 *
 * Used by the model refresh to REPLACE a stored default the gateway has
 * retired: the catalogue's own `is_default` flag is asked first, but it is not
 * something to depend on alone — W12-e read the live catalogue at 10:00 on
 * 2026-09-11 and recorded that neither row carried it, and a probe forty minutes
 * later found it on the `coder` row. Without this tier a flag that flaps drops
 * the fallback to `models[0]`, which on today's catalogue is the FAST model: a
 * silent downgrade of a coding session to the cheap tier, at the moment the user
 * is least able to see why.
 */
export function resolveGatewayCoderModelId(
  connection: Pick<LlmConnection, 'models'>,
): string | undefined {
  return resolveGatewayAliasModelId(connection, NESSY_GATEWAY_CODER_ALIAS);
}

function resolveGatewayAliasModelId(
  connection: Pick<LlmConnection, 'models'>,
  alias: string,
): string | undefined {
  const match = connection.models?.find(m =>
    typeof m !== 'string' && m.shortName?.toLowerCase() === alias,
  );
  if (!match || typeof match === 'string') return undefined;
  // The gateway's cheap model is the orchestrator `small` tier and the guardian
  // judge's default, so an allowlist that excludes it must not be reached
  // through the alias. `undefined` leaves `tierModelMap` unset and the judge on
  // its default path, which resolves to the session model — the shape
  // `model-config.md:178` prescribes for the classifier: "When it's excluded,
  // the classifier runs on the session's model, which the allowlist already
  // governs."
  return isModelInManagedAllowlist(managedModelAllowlist(), match.id) ? match.id : undefined;
}

/**
 * P6.362 · resolve a model id through this connection's aliases, if any of them
 * can actually land.
 *
 * ## Native first, and the native half is REAL here
 *
 * The Nessy Gateway's `/cli/models` publishes an `alias` per model, which
 * `fetchNestorModels` maps onto {@link ModelDefinition.shortName} — and this
 * file already resolves exactly one of them by hand
 * ({@link resolveGatewayFastModelId}, the `fast` tier). So tier 1 is the
 * endpoint's OWN alias table, generalised: nothing is configured, nothing is
 * invented, and every gateway catalogue already carries it.
 *
 * Tier 2 is {@link LlmConnection.modelAliases}, for the endpoints that publish
 * no aliases at all — which includes the case the row was written for.
 *
 * ## What it refuses, and why each refusal matters
 *
 * - An id the catalogue already SERVES is returned untouched: there is nothing
 *   to alias, and a `modelAliases` entry must never be able to redirect a model
 *   that works.
 * - A target the catalogue does not serve is not honoured. Otherwise an alias
 *   would silence the unrecognised-model diagnostic while changing nothing —
 *   suppression dressed as a mapping, which is worse than the warning.
 * - A target the MANAGED ALLOWLIST forbids is not honoured, for the reason
 *   {@link resolveGatewayFastModelId} states about the same table: an alias is
 *   not a route around an operator's model policy.
 * - An EMPTY catalogue resolves nothing. A connection whose models were never
 *   fetched cannot tell a served id from an unserved one, and neither can this.
 */
export function resolveConnectionModelAlias(
  connection: Pick<LlmConnection, 'models' | 'modelAliases'> | null | undefined,
  modelId: string | undefined,
): string | undefined {
  const wanted = modelId?.trim();
  if (!wanted || !connection) return modelId;
  const entries = connection.models ?? [];
  if (entries.length === 0) return modelId;
  const served = new Set(entries.map(entry => (typeof entry === 'string' ? entry : entry.id)));
  if (served.has(wanted)) return modelId;

  // Tier 1 — the endpoint's own alias field.
  const published = entries.find(entry =>
    typeof entry !== 'string' && entry.shortName?.toLowerCase() === wanted.toLowerCase(),
  );
  const target = (published && typeof published !== 'string' ? published.id : undefined)
    // Tier 2 — the operator's declaration.
    ?? connection.modelAliases?.[wanted]?.trim();

  if (!target || !served.has(target)) return modelId;
  if (!isModelInManagedAllowlist(managedModelAllowlist(), target)) return modelId;
  return target;
}

/**
 * Get the summarization model ID for a connection.
 * Same provider-aware logic as getMiniModel(), but separate
 * so summarization and mini agent models can diverge independently.
 *
 * Used for response summarization and API tool summarization.
 */
export function getSummarizationModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * Provider-aware small model resolution.
 * Shared implementation for getMiniModel() and getSummarizationModel().
 *
 *   - Anthropic: find "haiku"
 *   - Pi: find "mini" or "flash"
 *   - Otherwise: last model in the list
 *
 * Skips models denied by {@link isDeniedMiniModelId} for the connection's
 * auth flavor.
 */
function findSmallModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;

  const toId = (m: ModelDefinition | string) => typeof m === 'string' ? m : m.id;

  // The managed allowlist, applied to the CANDIDATE LIST rather than folded into
  // `isAllowedModel` below. The two filters are not interchangeable: the
  // `isDeniedMiniModelId` fallback on the last line deliberately returns a
  // denied model when nothing else is left (a mini model the provider rejects is
  // still better than none), and a managed allowlist must never be escaped that
  // way. `settings-reference.md#availablemodels` names the delegated tiers this
  // helper feeds — it restricts "which models people can select for the main
  // session, subagents, skills, and the advisor", which here is title
  // generation, mini completions and summarization.
  //
  // Returning `undefined` when nothing survives is the right refusal here: every
  // caller reads it as `getMiniModel(conn) ?? conn.defaultModel`, so the tier
  // falls back to the Default — `model-config.md:167`'s "falls back to the
  // inherited or default model rather than failing the request".
  const allowlist = managedModelAllowlist();
  const models = allowlist === undefined
    ? connection.models
    : connection.models.filter(m => isModelInManagedAllowlist(allowlist, toId(m)));
  if (models.length === 0) return undefined;

  // P6.1080 — the endpoint's OWN declaration of its cheap tier, asked BEFORE the
  // keyword heuristic, and this is a measured bug fix rather than a tidy-up.
  //
  // The keyword search below is for catalogues that declare nothing. This one
  // declares: `/cli/models` publishes `alias: fast`, which `fetchNestorModels`
  // writes onto `shortName`, and `resolveGatewayFastModelId` has read it for the
  // orchestrator `small` tier all along — the mini/summarization tier just never
  // asked. Measured 2026-09-11 on the live two-row catalogue, all three gateway
  // cards (`pi_compat`, `claude-runtime`, `codex-runtime`): `getMiniModel` and
  // `getSummarizationModel` both answered `tgpt/deepseek-v4-flash-0731` — the
  // FLAGSHIP coder model, alias `coder`, 524k window — because its id happens to
  // contain the word "flash", while the model actually aliased `fast` sat beside
  // it unread. Every session title, mini completion and summarization on a
  // gateway connection was being billed at the flagship.
  //
  // That is precisely the failure {@link PI_MINI_PREFERRED_DEFAULTS} was written
  // for ("the most expensive model in each list, on every background task"),
  // recurring because the id rotated into a word the heuristic matches. A
  // heuristic cannot be made safe against that; asking the endpoint can.
  //
  // A no-op for every catalogue without a `fast`-aliased row, which is every
  // non-gateway provider — and it inherits the managed-allowlist refusal
  // `resolveGatewayFastModelId` already applies, so it is not a route around an
  // operator's model policy. `isDeniedMiniModelId` is deliberately not consulted
  // here for the same reason `getMiniModel` does not consult it on an explicit
  // choice: it is a provider-auth heuristic, and this is the endpoint's own word.
  const declaredFast = resolveGatewayFastModelId({ models });
  if (declaredFast) return declaredFast;

  const toSearchStr = (m: ModelDefinition | string) =>
    typeof m === 'string' ? m.toLowerCase() : `${m.id} ${m.name} ${m.shortName}`.toLowerCase();

  const isAllowedModel = (m: ModelDefinition | string): boolean =>
    !isDeniedMiniModelId(toId(m), connection.piAuthProvider);

  // UB3.6 (upstream v0.15.0) — explicit per-provider utility models first (Pi
  // connections): rank the connection's models against PI_MINI_PREFERRED_DEFAULTS
  // through the same preferredModelRank the default seeding uses, so a retired
  // snapshot cannot win the mini tier by inheriting its replacement's rank.
  const preferredMini = (isPiProvider(connection.providerType) && connection.piAuthProvider
    && PI_MINI_PREFERRED_DEFAULTS[connection.piAuthProvider]) || [];
  if (preferredMini.length > 0) {
    let best: ModelDefinition | string | undefined;
    let bestRank = Infinity;
    for (const m of models) {
      const rank = preferredModelRank(toId(m), preferredMini);
      if (rank >= 0 && rank < bestRank && isAllowedModel(m)) {
        best = m;
        bestRank = rank;
      }
    }
    if (best) return toId(best);
  }

  // Provider-aware keyword search
  const keywords: string[] = [];

  if (isAnthropicProvider(connection.providerType)) {
    keywords.push('haiku');
  } else if (isPiProvider(connection.providerType)) {
    keywords.push('mini', 'flash');
  } else {
    // Aggregator providers (copilot, etc.) — try all common small-model keywords
    keywords.push('mini', 'haiku', 'flash');
  }

  if (keywords.length > 0) {
    // UB7.15 (upstream v0.15.0, whole tokens) — a substring match made every
    // Gemini model "mini" (ge-mini): `includes` cannot see token edges, so the
    // first gemini-* row won the keyword arm whenever the mini table had no
    // entry for the provider. Whole tokens only:
    // `(^|[^a-z])keyword([^a-z]|$)`.
    const hasKeyword = (searchStr: string) =>
      keywords.some(k => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(searchStr));
    const match = models.find(m => isAllowedModel(m) && hasKeyword(toSearchStr(m)));
    if (match) {
      return toId(match);
    }
  }

  // Fallback: last allowed model in the list, otherwise final entry.
  const fallback = [...models].reverse().find(isAllowedModel);
  return fallback ? toId(fallback) : toId(models[models.length - 1]!);
}

/**
 * Generate a URL-safe slug from a display name.
 * @param name - Display name to convert
 * @returns URL-safe slug
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a slug is valid (URL-safe, non-empty).
 * @param slug - Slug to validate
 * @returns true if valid
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

/**
 * Get credential key for an LLM connection.
 * Format: llm::{slug}::{credentialType}
 *
 * @param slug - Connection slug
 * @param credentialType - Type of credential ('api_key' or 'oauth_token')
 * @returns Credential key string
 */
export function getLlmCredentialKey(slug: string, credentialType: 'api_key' | 'oauth_token'): string {
  return `llm::${slug}::${credentialType}`;
}

/**
 * Credential storage type for each auth mechanism.
 */
export type LlmCredentialStorageType =
  | 'api_key'           // Single token stored as value
  | 'oauth_token'       // OAuth tokens (access, refresh, expiry)
  | 'iam_credentials'   // AWS-style (accessKeyId, secretAccessKey, region)
  | 'service_account'   // JSON file contents
  | null;               // No storage needed (environment or none)

/**
 * Map LlmAuthType to credential storage type.
 * Determines how credentials are stored in the credential manager.
 *
 * @param authType - LLM auth type
 * @returns Credential storage type or null if no credential storage needed
 */
export function authTypeToCredentialStorageType(authType: LlmAuthType): LlmCredentialStorageType {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
      return 'api_key';
    case 'oauth':
      return 'oauth_token';
    case 'iam_credentials':
      return 'iam_credentials';
    case 'service_account_file':
      return 'service_account';
    case 'environment':
    case 'none':
      return null;
  }
}

/**
 * Check if an auth type requires a custom endpoint URL.
 * @param authType - LLM auth type
 * @returns true if endpoint URL field should be shown in UI
 */
export function authTypeRequiresEndpoint(authType: LlmAuthType): boolean {
  return authType === 'api_key_with_endpoint';
}

/**
 * Check if a provider type is a "compat" provider.
 * Compat providers use custom endpoints and require explicit model lists.
 * @param providerType - Provider type to check
 * @returns true if this is a compat provider (pi_compat)
 */
export function isCompatProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi_compat';
}

/**
 * Provider types whose sessions reach their endpoint through a LOCAL ADAPTER
 * (`codex-responses-adapter`) rather than by handing the URL to an SDK: the
 * Codex runtime and the Claude Code runtime.
 *
 * They share three properties that `pi_compat` also has and `anthropic`/`pi` do
 * not — the connection's `baseUrl` is the real upstream, the endpoint owns the
 * model catalog, and both are user-editable through the BYO endpoint form (C3).
 * Grouping them behind one predicate is what keeps a future third adapter
 * runtime from having to be remembered at each of those sites.
 *
 * NOT a synonym for "is the Nessy Gateway": that is a URL question, answered by
 * `isNessyGatewayBaseUrl` (agent/backend/internal/drivers/upstream-target.ts).
 */
export function isAdapterRuntimeProvider(providerType: LlmProviderType): boolean {
  return providerType === 'codex-runtime' || providerType === 'claude-runtime';
}

/**
 * Check if a provider type uses the Anthropic Claude Agent SDK.
 * Only direct Anthropic API connections use the Claude SDK.
 * @param providerType - Provider type to check
 * @returns true if this provider uses the Anthropic SDK
 */
export function isAnthropicProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic';
}

/**
 * Check if a connection points to a local model runtime (loopback URL).
 */
export function isLocalConnection(conn: Pick<LlmConnection, 'baseUrl'>): boolean {
  if (!conn.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(conn.baseUrl.trim()).hostname;
    const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Check if a provider type uses Pi unified API.
 * @param providerType - Provider type to check
 * @returns true if this provider uses Pi
 */
export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi' || providerType === 'pi_compat';
}

/**
 * Default mid-stream send behavior for a given provider type.
 *
 * - 'anthropic' → 'steer' (it was 'queue' until `764ee8662`, 2026-08-17): Claude's
 *   emulated steer (PreToolUse hook injection) can fail to land — if no tool
 *   fires before the turn ends it becomes `steer_undelivered` and is re-queued;
 *   why steer is still the default despite that is given further down.
 * - 'pi' / 'pi_compat' → 'steer': Pi's native `.steer()` is non-destructive
 *   (delivers after the current tool finishes, keeps full context). No
 *   downside to defaulting to immediate steering.
 * - 'codex-runtime' → 'steer': the app-server's `turn/steer` is codex's OWN
 *   mechanism, and `CodexAgent.redirect` now wires it. Unlike Claude's
 *   emulation there is nothing to fail to deliver: the request either satisfies
 *   its `expectedTurnId` precondition or is refused, and a refusal is reported
 *   back as `steer_undelivered` and re-queued.
 *
 *   **THE FLIP REACHES NEW CONNECTIONS ONLY, AND THAT IS THE DECISION — NO
 *   MIGRATION.** A connection already on disk carries an explicit
 *   `midStreamBehavior: 'queue'`, persisted at creation when `'queue'` was the
 *   default, and `resolveMidStreamBehavior` honours a stored value over the
 *   default, so today's users keep queueing until they change it in
 *   Settings → AI.
 *
 *   **THE BLAST RADIUS IS NOW A NUMBER (P6.186), measured on a real profile
 *   UPGRADED across the flip rather than a fresh one: 5 of 11 stored rows sit on
 *   the stale side — and the fraction understates it, because those 5 are EVERY
 *   `claude-runtime` and `codex-runtime` row on that profile.** All five were
 *   created 2026-08-13/14, before the flip landed on 2026-08-17 (`764ee8662`).
 *   The four `pi_compat` rows are the control and every one reads `'steer'`,
 *   because Pi was already on `'steer'` when they were written — so the field
 *   faithfully records what the default was at creation, which is precisely the
 *   property that makes it unmigratable. `nestor-cloud-agent` reads `'queue'`,
 *   still correct today. Two older backups of the same store show 2 of 4, so the
 *   ratio has held rather than drifted.
 *
 *   That measurement corrected two things in this paragraph. **The stale rows
 *   are not only built-ins:** three of the five are `claude-custom`,
 *   `claude-custom-2` and `codex-custom`, created through the custom-endpoint
 *   path, so a migration scoped to `createBuiltInConnection`'s slugs would miss
 *   the majority — both paths persist the default through the one call at
 *   `connection-setup-logic.ts:337`. And **`claude-runtime` carries the larger
 *   share, 3 of 5**, although this is the codex bullet.
 *
 *   Rewriting it on load was considered and rejected: the field carries NO
 *   PROVENANCE — re-confirmed at HEAD, and pinned by
 *   `config/__tests__/midstream-stale-default-provenance.test.ts` so it cannot
 *   stop being true in silence — so a migration cannot tell a value the app
 *   wrote as its own default from one the user picked in that submenu (the
 *   checkmark it shows is the whole reason the default is persisted at creation
 *   at all), and it would silently overturn a deliberate choice. The stored
 *   value is also the SAFE side of the flip — `'queue'` never calls
 *   `redirect()`, so nothing regresses; the only cost is a delayed improvement.
 *   Doing it properly means giving the field provenance
 *   (`midStreamBehaviorSource: 'default' | 'user'`, which also has to reach
 *   the allowlist inside `config/storage.ts` (`updateLlmConnection`) or it is
 *   dropped on the next save — that merge is an allowlist by construction and
 *   says so) and migrating only the `'default'`-sourced rows. That is its own
 *   change, and it is ONE change serving both runtimes rather than two:
 *   **`claude-runtime`'s default flipped in the SAME commit as codex's.** This
 *   sentence used to say the question *"arrives verbatim when `claude-runtime`'s
 *   default flips"*, in the future tense, while the very next bullet dated that
 *   flip to 2026-08-17. It has already arrived, and the measurement above says it
 *   arrived larger on that side than on this one.
 * - 'anthropic' / 'claude-runtime' → 'steer' since 2026-08-17, and the flip was
 *   licensed by a live proof rather than by the reasoning that had kept it on
 *   'queue'. Claude's steer is still an EMULATION — `redirect()` parks the text
 *   and a `PreToolUse` hook injects it as `additionalContext` at the model's next
 *   tool call — so the doc here used to argue that a turn making no tool call
 *   "gets re-queued anyway, after paying for the original turn's tokens for
 *   nothing", and that queueing up front skipped a dead round trip.
 *
 *   Both arms were then measured in the app (`scripts/cdp/cases/str-1.ts`,
 *   `str-2.ts`). The delivered arm works: the CLI files a
 *   `hook_additional_context` attachment of its own between the `tool_use` it
 *   names and that call's `tool_result`, the model abandoned its remaining work,
 *   and the correction opened no turn of its own. The undelivered arm ALSO works
 *   now — and it did not when it was first measured: `steer_undelivered`
 *   re-queued under an id no transcript carried and the replay THREW, so the
 *   user's correction was destroyed while the transcript still rendered it as
 *   delivered. That was the real cost hiding behind "pays for tokens for
 *   nothing", it is fixed, and STR-2 pins it.
 *
 *   So the remaining cost of 'steer' on Claude is exactly the documented one — a
 *   turn whose tokens bought nothing when no tool call came — and the benefit is
 *   that a correction typed into a working turn reaches the model instead of
 *   waiting for it to finish. Same product, three runtimes, and Claude was the
 *   last one where it did not.
 * - 'nestor-cloud-agent' → 'queue': A2A steering is not wired in the first
 *   native backend implementation.
 */
export function defaultMidStreamBehavior(providerType: LlmProviderType): MidStreamBehavior {
  return providerType === 'nestor-cloud-agent' ? 'queue' : 'steer';
}

/**
 * Read the effective mid-stream behavior for a connection.
 *
 * Single source of truth — every call site that needs to decide steer-vs-queue
 * should go through here so legacy connections (created before the field
 * existed) and connections with corrupt/unexpected values fall through to the
 * provider-appropriate default.
 */
export function resolveMidStreamBehavior(
  connection: Pick<LlmConnection, 'midStreamBehavior' | 'providerType'>,
): MidStreamBehavior {
  if (connection.midStreamBehavior === 'steer' || connection.midStreamBehavior === 'queue') {
    return connection.midStreamBehavior;
  }
  return defaultMidStreamBehavior(connection.providerType);
}

/**
 * P6.480 — the behaviour the one-message chord asks for: the OTHER one.
 *
 * `learn.chatgpt.com/docs/prompting.md` describes the affordance as *"using the
 * other behavior for one message without changing your default"* (weak tier — a
 * page, not the codex source), so no caller chooses a value: the composer
 * inverts whatever {@link resolveMidStreamBehavior} answered. Kept beside that
 * resolver, and in `shared` rather than in either end, because BOTH ends need
 * it: the renderer to send the override and the server to reason about it, and
 * two spellings of "the other one" would be one spelling too many.
 */
export function otherMidStreamBehavior(behavior: MidStreamBehavior): MidStreamBehavior {
  return behavior === 'steer' ? 'queue' : 'steer';
}

/**
 * Return a new LlmConnection with the given model's `supportsImages` override set.
 *
 * Centralizes the string-vs-object normalization for `connection.models[]`:
 *   - string entry → promoted to `{ id, name, shortName, supportsImages: enabled }`
 *   - object entry → only `supportsImages` is updated
 *   - model not in array → connection returned unchanged (defensive)
 *
 * Pure function — does not mutate the input. Storage round-trip is handled
 * upstream via `saveLlmConnection`. The stored object form for custom-endpoint
 * models is `{ id, name?, shortName?, contextWindow?, supportsImages? }`
 * (passthrough-validated by the storage schema). `name` and `shortName` default
 * to the model's `id` when promoting so that downstream renderer surfaces that
 * read `m.name` (the trigger button display, picker row labels) keep showing a
 * label after the toggle promotes a string entry. The `ModelDefinition` cast
 * matches the existing shape produced by `ApiKeyInput.tsx` and the Pi driver.
 */
export function setModelSupportsImages(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
  learnedFrom?: string,
): LlmConnection {
  if (!connection.models) return connection;
  const idOf = (m: ModelDefinition | string) => (typeof m === 'string' ? m : m.id);
  const idx = connection.models.findIndex(m => idOf(m) === modelId);
  if (idx === -1) return connection;

  const entry = connection.models[idx]!;
  const defaultEntry = getDefaultModelsForConnection(connection.providerType, connection.piAuthProvider)
    .find(model => typeof model !== 'string' && model.id === modelId);
  // Absent unless this write is a LEARNED one, and therefore CLEARED by every
  // ordinary write — which is the whole of the ruling's "reversible in one
  // click": the existing toggle already calls this function, so flipping the
  // model back to vision un-learns the stamp with no new code path.
  const stamp = learnedFrom === undefined
    ? { supportsImagesLearnedFrom: undefined }
    : { supportsImagesLearnedFrom: learnedFrom };
  const nextEntry =
    typeof entry === 'string'
      ? {
          ...(defaultEntry && typeof defaultEntry !== 'string'
            ? defaultEntry
            : { id: entry, name: entry, shortName: entry }),
          supportsImages: enabled,
          ...stamp,
        }
      : { ...entry, supportsImages: enabled, ...stamp };

  const nextModels = connection.models.slice();
  nextModels[idx] = nextEntry as ModelDefinition;
  return { ...connection, models: nextModels };
}

/**
 * P6.482 (ledger J8/claude), owner decision Q12 of 2026-09-05 — is THIS message
 * the endpoint saying it cannot take an image, or is it a generic failure?
 *
 * The ruling amends the 2026-08-28 *"prefer the endpoint's refusal to our
 * prediction of it"* by one narrow clause: a flag MAY be written when the
 * endpoint returns its exact named image refusal, and **a generic 400 never
 * writes**. This predicate is that clause, and it is the whole safety of the
 * feature — everything downstream is bookkeeping. So it is deliberately strict
 * and deliberately dumb:
 *
 * - the message must name the MODALITY, and
 * - it must carry a REFUSAL verb about it, and
 * - it must not be about IMAGE GENERATION, which is an output capability and
 *   says nothing about what the model will accept.
 *
 * Two words, both required, is the smallest rule that separates the measured
 * positive from the failures that sit next to it. The measured positive is the
 * gateway's own named 400, `Invalid Chat Message Part: Model Does Not Support
 * Image Inputs` (2026-08-28, pinned in `model-supports-images.test.ts`); the
 * negatives that must NOT write are a bare `Bad Request`, a context-window
 * message, a tool-schema complaint, and an image-GENERATION refusal.
 *
 * **Where the documentation is silent, this is transparent and simple** (owner
 * rule 2026-08-28): no vendor publishes a machine-readable modality refusal, so
 * the rule is prose-matching and can only ever be approximate. It fails in the
 * SAFE direction — an unrecognised refusal writes nothing and the user is
 * exactly where they were — and the sentence it matched is stored beside the
 * flag, so a wrong match is visible to the person it affects rather than
 * inferred from a silent boolean.
 *
 * ONE writer for all three runtimes, by construction: this takes a string and a
 * connection and knows about no runtime at all, so it cannot become a switch
 * divergence.
 */
const IMAGE_MODALITY_WORDS = /\b(image|images|image_url|vision|multimodal)\b/i;
const REFUSAL_WORDS = /(does\s+not\s+support|doesn'?t\s+support|not\s+supported|unsupported|no\s+support\s+for|cannot\s+(?:accept|process)|can'?t\s+(?:accept|process))/i;
const GENERATION_WORDS = /\b(generat\w*|render\w*|draw\w*|create\s+an?\s+image)\b/i;

export function isNamedImageRefusal(message: string | null | undefined): boolean {
  if (!message) return false;
  if (!IMAGE_MODALITY_WORDS.test(message)) return false;
  if (!REFUSAL_WORDS.test(message)) return false;
  // An output capability. A model that will not DRAW an image may still READ one.
  if (GENERATION_WORDS.test(message)) return false;
  return true;
}

/**
 * P6.584 — the one anchor that carries a named image refusal to the renderer.
 *
 * The write has to happen where the connection is saved, and that is the
 * renderer (`saveLlmConnection`); the sentence is seen where the turn fails,
 * and that is the server. The channel between them already exists and needed
 * no new field, no new RPC and no message-type change: `AgentError.details`
 * crosses the wire verbatim as `Message.errorDetails`
 * (`renderer/event-processor/handlers/session.ts`).
 *
 * So the detail line is the anchor. It REPLACES the generic `API message: …`
 * line for this one case rather than sitting beside it — the panel must not
 * print the same sentence twice — and both ends match on this constant instead
 * of on prose, so a reworded line cannot silently unhook the writer.
 *
 * It lives here, beside {@link isNamedImageRefusal} and {@link learnImageRefusal},
 * because this module is the one both sides already import: the mapper is in
 * `agent/`, the renderer reaches `@config/llm-connections` directly, and
 * `packages/shared`'s export map has no wildcard for `./agent/*`.
 */
export const IMAGE_REFUSAL_DETAIL_PREFIX = 'Image input refused by the endpoint: ';

/**
 * P6.584 — read the endpoint's sentence back out of a turn error's details.
 *
 * `undefined` for every other error, which is what keeps the writer narrow: a
 * generic 400 carries no anchored line, so nothing is learned from it.
 */
export function imageRefusalSentenceFromErrorDetails(
  details: readonly string[] | null | undefined,
): string | undefined {
  const line = details?.find(detail => detail.startsWith(IMAGE_REFUSAL_DETAIL_PREFIX));
  if (!line) return undefined;
  const sentence = line.slice(IMAGE_REFUSAL_DETAIL_PREFIX.length).trim();
  return sentence.length > 0 ? sentence : undefined;
}

/**
 * P6.482 — write the flag once, from the endpoint's own refusal.
 *
 * Returns the connection unchanged (and `learned: false`) unless every one of
 * the ruling's conditions holds, so the caller is a two-line site:
 *
 * - the message is a named image refusal ({@link isNamedImageRefusal});
 * - the model carries NO explicit declaration already — a person's answer, in
 *   either direction, outranks a sentence we pattern-matched;
 * - the model is actually in this connection's list.
 *
 * `learnedFrom` is trimmed and length-capped: it is rendered in a composer
 * banner and stored in `config.json`, and an endpoint that returns a stack
 * trace should not be able to grow either without bound.
 */
export const LEARNED_IMAGE_REFUSAL_MAX_CHARS = 400;

export function learnImageRefusal(
  connection: LlmConnection,
  modelId: string,
  message: string | null | undefined,
): { connection: LlmConnection; learned: boolean } {
  if (!isNamedImageRefusal(message)) return { connection, learned: false };
  const entry = connection.models?.find(m => (typeof m === 'string' ? m : m.id) === modelId);
  if (!entry) return { connection, learned: false };
  const alreadyDeclared = typeof entry !== 'string'
    && typeof entry.supportsImages === 'boolean'
    && entry.supportsImagesLearnedFrom === undefined;
  if (alreadyDeclared) return { connection, learned: false };
  const sentence = message!.trim().slice(0, LEARNED_IMAGE_REFUSAL_MAX_CHARS);
  return { connection: setModelSupportsImages(connection, modelId, false, sentence), learned: true };
}

/**
 * P6.482 — the endpoint's sentence, when this model's `false` was LEARNED.
 *
 * `undefined` means declared-or-defaulted, which is what makes the two visibly
 * distinguishable wherever the flag is shown: a caller that has a sentence
 * quotes it, and one that does not says nothing rather than inventing a reason.
 */
export function modelImageRefusalSentence(
  connection: Pick<LlmConnection, 'models'>,
  modelId: string,
): string | undefined {
  const entry = connection.models?.find(m => (typeof m === 'string' ? m : m.id) === modelId);
  if (!entry || typeof entry === 'string') return undefined;
  return entry.supportsImagesLearnedFrom;
}

/**
 * DA1.22 — the generation config the model's own catalogue published, if any.
 *
 * ## What this is, and what it deliberately is not
 *
 * The Nessy Gateway publishes `reasoning` and `sampling_params` per `/cli/models`
 * row. `server-core/src/model-fetchers/nestor.ts` is the only thing that WRITES
 * them onto a connection's model entries; this is the only thing that READS them
 * back out, and it is the seam the three runtimes are fed from, so there is one
 * spelling of "what did the catalogue recommend for this model" rather than one
 * per runtime — which is the divergence shape this fork pays for most often.
 *
 * NOT gated on the connection being the gateway, and that is a decision. The
 * fields exist on a model entry only because something wrote them, and today the
 * gateway fetcher is the only writer — so the gate is STRUCTURAL rather than a
 * fifth hand-written spelling of "is this the gateway" (`DA1.11` counted five).
 * The one other way a value can get here is a user hand-editing `config.json`,
 * and honouring that is deliberate: it is the only per-model sampling control
 * this product has, and refusing it on a BYO card would refuse the user's own
 * explicit instruction in favour of nothing at all.
 *
 * Returns `undefined` — not an empty object — when the model publishes neither,
 * so a caller can pass the result straight into an optional adapter option and
 * every pre-DA1.22 connection takes exactly the path it took before.
 */
export interface ModelGenerationDefaults {
  /** The catalogue's recommended reasoning effort. Applied as a DEFAULT only. */
  reasoningEffort?: string;
  /** The catalogue's published sampling parameters, verbatim. */
  samplingParams?: Record<string, unknown>;
}

export function resolveModelGenerationDefaults(
  connection: Pick<LlmConnection, 'models'> | null | undefined,
  modelId: string | undefined,
): ModelGenerationDefaults | undefined {
  if (!connection || !modelId) return undefined;
  const entry = connection.models?.find(m => (typeof m === 'string' ? m : m.id) === modelId);
  if (!entry || typeof entry === 'string') return undefined;
  const reasoningEffort = typeof entry.reasoningEffort === 'string' && entry.reasoningEffort.length > 0
    ? entry.reasoningEffort
    : undefined;
  const samplingParams = entry.samplingParams
    && typeof entry.samplingParams === 'object'
    && !Array.isArray(entry.samplingParams)
    && Object.keys(entry.samplingParams).length > 0
    ? entry.samplingParams
    : undefined;
  if (!reasoningEffort && !samplingParams) return undefined;
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(samplingParams ? { samplingParams } : {}),
  };
}

/**
 * Resolve whether a given model on a connection accepts image input.
 *
 * **The host's job is a faithful translation, not a capability oracle** (owner
 * ruling 2026-08-28). A modality is carried in the shape the endpoint documents
 * and the ENDPOINT answers. Measured against the Nessy gateway the same day: it
 * PARSES the standard chat image part and refuses on model capability with its
 * own named error — `Invalid Chat Message Part: Model Does Not Support Image
 * Inputs` — while a vision-capable BYO upstream simply works. An undeclared
 * default here is therefore a guess standing in for an answer we can already
 * get, so this function keeps a local flag only where there is an explicit
 * declaration to honour.
 *
 * Precedence, and it is now the same on every provider type:
 *   1. per-model `supportsImages` — an explicit declaration, always authoritative
 *   2. connection-level `customEndpoint.supportsImages` — the same, one scope up
 *   3. `pi_compat` → `false`; every other provider type → `true` (no gate)
 *
 * **Honouring (1) everywhere is a fix, not a tidy-up.** The previous shape
 * returned `true` UNCONDITIONALLY for every provider type that was neither
 * `pi_compat` nor one of the two runtimes, so an explicit `supportsImages: false`
 * on a `pi` or `anthropic` model was overruled — the same defect P3.101 measured
 * on `codex-runtime`, still live for the rest of the union.
 *
 * **Why `pi_compat`'s undeclared `false` is NOT a guess, and stays.** It is the
 * value we ourselves write into Pi's registry: `buildCustomEndpointModelDef`
 * (`pi-agent-server/src/custom-endpoint-models.ts`) applies the identical
 * `overrides ?? defaults ?? false` and turns it into `input: ['text']`, and pi-ai
 * then honours it — `api/transform-messages.js` `downgradeUnsupportedImages`
 * replaces every image block with `(image omitted: model does not support
 * images)` when `model.input` lacks `"image"`. Answering `true` here while that
 * default stays `false` would stop the host reporting the omission and leave Pi
 * quietly substituting a placeholder: less gating on our side, and still no
 * endpoint answer. The two defaults move together or not at all, which P3.137
 * made structural: the value is `PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES` in
 * `compat-image-default.ts` and that module's header carries the rule.
 *
 * P3.136 struck this paragraph's last clause, which said `pi_compat` "is the one
 * provider type with a UI writer for the declaration". It was true when written
 * and false by the time it was read: `claude-runtime` reaches
 * {@link setModelSupportsImages} through the composer's staged-image banner
 * (`attachment-capability.ts` `resolveStagedImagePolicy`). The model picker's
 * per-row vision toggle is still `isCompatProvider`-gated, so `pi_compat` remains
 * the only type with TWO writers — a difference worth knowing and not the one
 * this sentence claimed.
 *
 * **What the undeclared `true` costs elsewhere: nothing silent.** `claude-runtime`
 * carries an image end to end since `30628c7d0` — `anthropic/inbound.ts`
 * `imageBlockToInputImage` maps the Anthropic image block onto `input_image`, and
 * `to-chat.ts` `toChatContent` (the renamed `flattenContent`, which used to keep
 * only parts carrying a string `text`) maps that onto the chat `image_url` part.
 * `codex-runtime` carries it on codex's own `LocalImageUserInput` wire (P6.28).
 * A text-only model on either therefore fails AT THE ENDPOINT, in the endpoint's
 * own words — which is the condition this default depends on, pinned by the
 * legibility test in `__tests__/model-supports-images.test.ts`.
 *
 * THE NULL, recorded rather than invented: nothing reports per-model modality on
 * these connections. The Nestor gateway's `GET /api/v1/cli/models` has no
 * modality field (`server-core/src/model-fetchers/nestor.ts` parses
 * id/name/alias/desc/is_default/context window and nothing else). Codex DOES
 * publish it — `Model.inputModalities: Array<"text"|"image"|"audio">` in
 * `codex-protocol/schema/v2/ModelListResponse.json` — but we never call
 * `model/list` (P3.115), and that catalog describes codex's own provider, not the
 * endpoint a `codex-runtime` connection points at.
 *
 * P3.115 — THAT LAST CLAUSE WAS A SUSPICION AND IS NOW A MEASUREMENT, which
 * settles the row against wiring it. Driven directly against the shipped binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`,
 * self-reporting `0.148.0`, darwin-arm64, 2026-08-28), `model/list` answers with
 * codex's OWN eight-model OpenAI catalog — `gpt-5.6-sol`, `-terra`, `-luna`,
 * `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`, `codex-auto-review`, every one
 * of them `inputModalities: ["text","image"]` — and it returns the SAME eight
 * whether the config names our `nessy_gateway` provider or no provider at all
 * (the positive control for "the config does not reach this catalog"). The model
 * we actually run, `tgpt/qwen35-397b-a17b-fp8`, is in NEITHER list. And
 * `buildCodexConfigToml` writes `model_provider = "nessy_gateway"`
 * unconditionally, so codex's own provider is never the one in use on any path.
 *
 * So reading `model/list` here would not answer this question — it would answer
 * a DIFFERENT model's question and look authoritative doing it: `["text","image"]`
 * borrowed from `gpt-5.6-sol` and stamped on a Qwen turn. The runtime does not in
 * fact tell us, per model, for any model we run. The endpoint's own refusal stays
 * the only true source, which is what the 2026-08-28 ruling already says.
 *
 * (Codex has a mechanism for teaching it a custom catalog — `model_catalog_json`,
 * "applied on startup only", a `{ models: [...] }` file whose snake_case entries
 * carry `input_modalities`. It is not the answer either: WE would be authoring
 * the modality claim, which is the capability oracle the ruling deletes. Recorded
 * so the next reader does not have to re-derive that it exists.)
 *
 * ## AUDIO IS THE THIRD MODALITY, AND ITS NULL IS WIDER (P3.126, scoped 2026-09-02)
 *
 * The `InputModality` union quoted above admits `"audio"`, and codex carries it
 * for real: `local_audio_content_items` (`codex-rs/protocol/src/models.rs` at
 * `rust-v0.148.0`) emits a three-item frame — an open tag, an
 * `ContentItem::InputAudio { audio_url }` base64 data URL, a close tag — for wav,
 * mp3, m4a, webm and ogg, classified BY FILE EXTENSION in
 * `local_media.rs::audio_mime_for_path`, capped at 50 MB, and **gated on no model
 * capability at all**: codex builds the item unconditionally and lets the
 * endpoint refuse. That is the same posture the 2026-08-28 ruling sets for us.
 *
 * **We do not reach that posture, and the enumeration says where it stops.** The
 * composer accepts an audio file at every ingress (no `accept` filter on the
 * picker, unfiltered drop and paste), and every one of the three runtime
 * attachment mappers then drops the MODALITY and carries a text pointer
 * (`[Attached file: …]` + `[Stored at: …]`) instead — `codex-agent.ts`'s emitted
 * turn-input union is two of codex's seven members and names `localAudio` as a
 * deliberate omission. There is one audio-aware line in the tree,
 * `codex-responses-adapter`'s `to-chat.ts`, which turns an `input_audio` part
 * into a marked omission rather than dropping it silently — and it is
 * unreachable from our composer, because nothing upstream ever produces such a
 * part.
 *
 * **So the gateway's audio refusal is not merely unmeasured, it is currently
 * unreachable through the product**, and this is the null: `Model Does Not
 * Support Image Inputs` has an audio twin that nobody has ever seen, because no
 * audio byte has ever left this host. `grep -ran` over the tree finds no
 * `supportsAudio`, no audio axis on `ComposerCapabilities.attachments`, and no
 * probe in any spec or plan. Building a capability table for audio is refused by
 * the same ruling that refuses one for images; what is owed is the CARRY, and it
 * lands in files this lane does not hold. Recorded here, beside the image null,
 * so the next reader starts from the enumeration rather than from the symptom.
 *
 * ### TWO of the three runtimes CANNOT carry audio at all, measured 2026-09-03 (P3.126)
 *
 * The scoping above left the carry as work spanning several lanes. Most of it is
 * now settled in the direction that removes work rather than adding it: on claude
 * and on Pi there is **no audio content shape to be faithful to**, so the
 * ruling's *let the endpoint refuse* has nothing to refuse and a carry would mean
 * inventing a wire neither vendor publishes.
 *
 * **Claude — the Anthropic Messages wire has no audio content block.** Three
 * probes, each with the positive control that makes an absence claim admissible:
 *
 * | Artefact | audio | control |
 * | --- | --- | --- |
 * | `@anthropic-ai/claude-agent-sdk@0.3.247` `sdk.d.ts` | `audio` ×0 | `image` ×5 |
 * | `@anthropic-ai/sdk` `resources/messages/messages.d.ts` | `input_audio`/`audio_url`/`InputAudio` ×0 | `ImageBlockParam` ×5 |
 * | vendored native binary, `claudeCodeVersion 2.1.247` darwin-arm64 | `input_audio` ×0 | `"image"` ×225 |
 *
 * (Re-measured 2026-09-12, C3.252. Every ×N in this table is OCCURRENCES
 * (`grep -aoF … \| wc -l`) — named because LINES answers differently on a
 * minified artefact, 124 for that last cell (C3.294). The 0.3.233 / 2.1.233
 * readings were ×0 / ×3 and ×0 / ×199; the ZEROS are what the table is for and
 * they are unchanged.)
 *
 * `ContentBlockParam` is a seventeen-member union carrying `ImageBlockParam` and
 * `DocumentBlockParam` and no audio member. The binary's only `audio/*` strings
 * are a mime-db table, a file-extension mapper, and an asset-serving mime
 * allowlist that sits beside `text/html`, `application/wasm`, the web fonts and
 * `application/pdf` — none of them a message content block.
 *
 * **Pi — the same answer, from its own types.** `@earendil-works/pi-ai` (read at
 * `0.84.2`, re-read unchanged at `0.84.3` — W11-pi, 2026-09-11)
 * declares a model's modalities as `input: ("text" | "image")[]` (and the same
 * union for `output`), and its content-part `type` literals are `text`, `image`,
 * `thinking`, `toolCall` and the streaming deltas — **no audio kind**. The one
 * `audio` in `types.d.ts` is a PRICE field (*"Price per audio unit"*), which is
 * the tell worth keeping: the pricing model knows audio exists and the content
 * model does not, so a reader grepping for the word finds a hit that means the
 * opposite of what it looks like.
 *
 * **So the asymmetry is decidable, and it runs the other way from the usual
 * one:** codex CAN carry audio (`local_audio_content_items`, gated on no model
 * capability at all) and it is the ONLY one of the three that can; claude and Pi
 * cannot, by their vendors' own type surfaces. That is a runtime-capability fact
 * rather than an omission of ours and belongs in the ledger as one. What remains
 * of the carry is therefore a codex-only question — reach that runtime's own
 * audio wire from the composer, or keep the visible text pointer `30628c7d0`
 * left — and not a three-runtime parity item.
 */
export function modelSupportsImages(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'customEndpoint'>,
  modelId: string,
): boolean {
  const entry = connection.models?.find(m =>
    (typeof m === 'string' ? m : m.id) === modelId,
  );
  const declared = entry && typeof entry !== 'string' && typeof entry.supportsImages === 'boolean'
    ? entry.supportsImages
    : undefined;
  if (declared !== undefined) return declared;

  const connectionDefault = connection.customEndpoint?.supportsImages;
  if (typeof connectionDefault === 'boolean') return connectionDefault;

  // The last undeclared `false`, and it is lockstep with a default we author
  // rather than a prediction about a model — see the docstring. P3.137 moved the
  // value itself into `compat-image-default.ts`, whose header carries the second
  // reader and the both-or-neither rule: the literal used to live here and in
  // `pi-agent-server/src/custom-endpoint-models.ts` with nothing connecting them.
  if (isCompatProvider(connection.providerType)) return PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES;

  return true;
}

/**
 * Get the default model list for a provider type from the registry.
 * For *_compat providers, returns empty array - those should use connection.models instead.
 *
 * @param providerType - Provider type
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Model list from registry, or empty array for compat providers
 */
export function getModelsForProviderType(providerType: LlmProviderType, piAuthProvider?: string): ModelDefinition[] {
  // Compat providers require explicit model lists from the connection
  if (isCompatProvider(providerType)) {
    return [];
  }

  // Codex model lists are gateway-fetched into connection.models (like compat).
  if (providerType === 'codex-runtime') {
    return [];
  }

  // claude-runtime points at a custom Anthropic-compatible endpoint, so the
  // bundled ANTHROPIC_MODELS catalog does not describe it — models are fetched
  // into connection.models (gateway) or entered by the user.
  if (providerType === 'claude-runtime') {
    return [];
  }

  if (providerType === 'nestor-cloud-agent') {
    return getModelsByProvider('nestor-cloud-agent');
  }

  // Pi: fetch models via registered resolver (avoids Pi SDK import in renderer)
  if (providerType === 'pi') {
    return _piModelResolver(piAuthProvider);
  }

  // Anthropic uses Claude models with bare Anthropic IDs.
  return ANTHROPIC_MODELS;
}

/**
 * Get the default model list for a connection's provider type.
 * Unlike getModelsForProviderType(), this handles compat providers by returning
 * the appropriate compat-prefixed model IDs instead of an empty array.
 *
 * Use this whenever you need to populate or backfill a connection's models.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model list (ModelDefinition[] for standard, string[] for compat)
 */
/**
 * P6.498 — the operator's "gateway sign-in only" lock, host-side for all three
 * runtimes.
 *
 * ## The decision, and the one option that turned out not to exist
 *
 * Delegated decision 2026-09-05, Q-den 15 = **option A**: host-side enforcement
 * that HIDES and REFUSES every non-gateway connection card, with the disclosure
 * line as its refusal text. Option C — project claude's own `forceLoginMethod`
 * and stop there — was already ruled out as enforcing on one runtime of three;
 * it is now ruled out on a stronger ground, MEASURED on the vendored `2.1.247`
 * (re-extracted 2026-09-12, C3.252; the same was true at `2.1.233`):
 * the SDK's restrictive managed-settings filter copies `forceLoginOrgUUID` and
 * **not** `forceLoginMethod`, so a projection through our tier would be a silent
 * no-op — the P6.688 / P6.237 failure. That refusal is recorded by name in
 * `pi-harness/managed-policy.ts`'s `DOCUMENTED_UNENFORCED_KEYS`.
 *
 * ## Why the predicate lives in this module
 *
 * This is the card catalogue: the renderer reads it through the `@config/*`
 * alias and the server imports it directly, so one answer serves the hide, the
 * refusal and any later gate. A second copy in the renderer is how the hidden
 * card and the refused submit would come to disagree about what counts as a
 * gateway connection.
 *
 * ## What counts as the gateway, and why not a slug list
 *
 * The BASE URL host, plus the native cloud agent, which has no base URL of its
 * own because it IS the gateway's agent. A slug list was rejected: the four
 * one-click cards pin fixed slugs, but a user can rename a connection and an
 * operator's lock must not turn on a display name. The host is the fact that
 * decides whether `Nestor-Token` is attached, which is the same question.
 */
let managedNonGatewayConnectionsDisabledProvider: (() => boolean | undefined) | undefined

export function registerManagedNonGatewayConnectionsDisabledProvider(
  provider: (() => boolean | undefined) | undefined,
): void {
  managedNonGatewayConnectionsDisabledProvider = provider
}

/**
 * Whether the operator has required gateway sign-in.
 *
 * Only an explicit `true` locks: `false` and unset are both "no constraint",
 * which keeps a managed deployment that spells the key `false` on exactly the
 * path an unmanaged one takes. A throwing provider reads as no opinion — an
 * unreadable policy file must not lock every card in the product.
 */
export function areNonGatewayConnectionsManagedDisabled(): boolean {
  try {
    return managedNonGatewayConnectionsDisabledProvider?.() === true
  } catch {
    return false
  }
}

/** Is this connection one of the operator's own gateway cards? */
export function isNessyGatewayConnectionShape(connection: {
  providerType?: string | null
  baseUrl?: string | null
}): boolean {
  if (connection.providerType === 'nestor-cloud-agent') return true
  const raw = connection.baseUrl?.trim()
  if (!raw) return false
  try {
    return new URL(raw).hostname.toLowerCase() === NESTOR_GATEWAY_HOST.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Is this connection refused by the operator's gateway-only lock?
 *
 * A PREDICATE and not a sentence, unlike `describeManagedInAppBrowserRefusal`
 * next door, and the difference is deliberate: that one is read by the electron
 * main process, which has no i18n, while every reader of this one is a renderer
 * surface the user is looking at in their own language. The sentence therefore
 * has ONE home, the locale files
 * (`settings.ai.gatewayOnly.refusal`), and the decision has one home here.
 *
 * IDENTICAL on Pi, claude and codex by construction: nothing on this path takes
 * a runtime term. That is the whole reason the lock is host-side — the row's
 * measurement is that only claude has a login-method gate at all, so enforcing
 * on the vendor's key would have manufactured the divergence it set out to
 * close.
 */
export function isNonGatewayConnectionRefused(connection: {
  providerType?: string | null
  baseUrl?: string | null
}): boolean {
  if (!areNonGatewayConnectionsManagedDisabled()) return false
  return !isNessyGatewayConnectionShape(connection)
}

/**
 * Preferred default model IDs per Pi auth provider./**
 * Preferred default model IDs per Pi auth provider.
 * The Pi SDK returns models in arbitrary order (alphabetical by ID), which means
 * deprecated models like claude-3-5-haiku-20241022 can end up first.
 * This map ensures getDefaultModelForConnection() picks a modern, capable model.
 *
 * Format: bare model IDs (without pi/ prefix). Matched against pi/{id} or pi/{id}-*.
 */
export const PI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  anthropic: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // P2.318 — DECORATIVE TODAY, and left that way deliberately (owner 2026-09-05,
  // D16 = option B). Measured: of these seven ids only `gpt-5.5` exists in the
  // codex catalogue, two of the rest are documented as already deprecated for
  // this sign-in, and none of the three models codex currently Recommends
  // (`gpt-5.6-sol` / `terra` / `luna`) is here. The list is therefore mostly
  // decoration.
  //
  // It is not refreshed because the key is `openai-codex`, the ChatGPT Plus/Pro
  // OAuth card, which is FLAG-OFF in this build — and the owner's 2026-08-29
  // ruling on that surface is *do not build, do not delete, do not clean up*.
  // Refreshing it would also CHANGE WHICH MODEL A CONNECTION TALKS TO, which is
  // a product call rather than a lane's. Refresh it against the shipped codex
  // catalogue (not the page alone — that is how P2.309 verified its own
  // replacement) on the day that card is enabled.
  'openai-codex': ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // Stable models first so the connection-setup test (which uses
  // getDefaultModelForConnection) lands on a reliable model.
  // gemini-3-pro-preview and gemini-3.1-pro-preview are intermittently
  // unresponsive on generateContent — verified against the live API in
  // April 2026 — and are deliberately excluded from defaults.
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
  // Pi 0.86.0 replaced the retired `deepseek-v4-flash` alias (and the experimental
  // vision variant) with `deepseek-flash` (UB3.7); stored ids migrate via
  // DEPRECATED_MODEL_REPLACEMENTS.
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  'github-copilot': ['claude-sonnet-4-6', 'gpt-5', 'o4-mini', 'claude-haiku-4-5'],
  // Opus 5 heads the list because it is upstream's built-in Bedrock primary
  // model (see BEDROCK_MODEL_MAP's citation), and the Pi SDK registry ships the
  // us./eu./global. profile ids that reverse-map onto it.
  'amazon-bedrock': ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};

/**
 * P2.97 — preferred MINI/background model ids per Pi auth provider.
 *
 * `PI_PREFERRED_DEFAULTS` answers "which model should this connection TALK to",
 * and it is ordered most-capable-first, which is right for a primary model and
 * wrong for the slot that generates session titles and summaries. Walking that
 * list for a mini model returned an Opus for `anthropic` and the *pro* DeepSeek
 * for `deepseek` — the most expensive model in each list, on every background
 * task (measured against the shipped Pi catalog, 2026-08-25).
 *
 * Upstream states the rule and the price of getting it wrong.
 * `code.claude.com/docs/en/amazon-bedrock.md` (fetched 2026-08-25):
 * *"Background tasks such as session title generation use the small/fast model,
 * normally a Haiku-class model. On Amazon Bedrock, Claude Code uses the default
 * Sonnet model for background tasks because Haiku may not be enabled in every
 * account or region."* and, in a warning on the same page, *"Opus models have a
 * higher per-token price than Sonnet models, so a deployment that doesn't pin a
 * primary model is billed at the Opus rate"*.
 *
 * Every id here was verified present in the shipped Pi catalog for that
 * provider — a candidate that does not resolve is skipped, so an invented id
 * silently degrades the pick rather than failing loudly:
 * - `github-copilot` spells its Claude ids with DOTS (`claude-haiku-4.5`), which
 *   is why its `PI_PREFERRED_DEFAULTS` dashed ids resolved to NOTHING and its
 *   mini pick fell through entirely.
 * - `amazon-bedrock` needs an inference-profile id: the bare `claude-*` ids in
 *   `PI_PREFERRED_DEFAULTS` are absent from that catalog, so its mini pick also
 *   resolved to nothing and every background query fell back to a Haiku id that
 *   cannot resolve under Bedrock auth either. `global.` is used because this
 *   seam has no access to the connection's AWS region and `global.` is the one
 *   prefix that asserts no geography — the upstream table's own catch-all row.
 *
 * ## P2.309 — a ONE-ELEMENT list is a pin with a nothing behind it
 *
 * `'openai-codex'` was `['gpt-5.4-mini']` — a single id, on a DATED expiry. The
 * `'openai-codex'` provider is the ChatGPT Plus/Pro OAuth path (see
 * {@link isDeniedMiniModelId}), i.e. exactly the sign-in boundary the retirement
 * covers and exactly the one its carve-out does not protect.
 * `learn.chatgpt.com/docs/enterprise/workspace-model-availability.md#prepare-for-the-gpt-54-retirement`
 * (fetched 2026-08-28, date re-verified on the rendered page):
 * *"On August 31, 2026, GPT-5.4 and GPT-5.4 mini retire from Codex for users
 * signed in with ChatGPT."* and, in the same section, *"Replace `gpt-5.4-mini`
 * with `gpt-5.6-luna` (GPT-5.6 Luna)."* The carve-out — *"The OpenAI API and
 * Codex authenticated with your own API key aren't affected."* — is why the
 * `openai` row keeps its `gpt-5.4-mini` (and why it was never at risk: it sits
 * behind `gpt-5-mini` and degrades gracefully).
 *
 * With ONE element and the skip-if-unresolvable rule two paragraphs up, the
 * codex-subscription mini pick degraded to NOTHING on the 31st — no error, no
 * notice. `gpt-5.6-luna` therefore heads the list, and the retirement has since
 * HAPPENED: the shipped Pi catalog re-read at 0.87.1 (2026-10-10) holds
 * `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`,
 * `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol` — eight, `gpt-5.4`/`gpt-5.4-mini` gone
 * and exactly two small-class ids, so the retired tail became `gpt-6-luna`.
 * `gpt-5.3-codex-spark` is deliberately NOT a third entry: the models
 * page marks it *"Available to ChatGPT Pro users"*, so pinning it would trade
 * this silent degradation for a Plus-account refusal at request time.
 */
export const PI_MINI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  // UB7.14 / OQ-B2.1 (a) — Haiku 5.5 heads the utility tier on Anthropic
  // connections (upstream v0.15.0's list, verbatim). The pin runs ahead of the
  // shipped 0.87.1 catalogue (which still carries only claude-haiku-4-5), so
  // the pick warns missing-pin per process and degrades to the second entry
  // until UB8.2 lifts the catalogue — P2.309's loudness working as designed.
  anthropic: ['claude-haiku-5-5', 'claude-haiku-4-5'],
  // UB7.15 (upstream v0.15.0) — `gpt-6-luna` heads the openai row: it is in the
  // shipped 0.87.1 catalogue and is the family's named cheap tier ("Fast and
  // affordable … lowest cost in the family", learn.chatgpt.com models.md); our
  // older verified-present entries stay behind it as the degrade path.
  openai: ['gpt-6-luna', 'gpt-5-mini', 'gpt-5.4-mini', 'gpt-5-nano', 'o4-mini'],
  'openai-codex': ['gpt-5.6-luna', 'gpt-6-luna'],
  google: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash'],
  deepseek: ['deepseek-flash'], // renamed to this from deepseek-v4-flash in the 0.87.1 shipped catalog (PI_MINI is the one-element pin)
  'github-copilot': ['claude-haiku-4.5', 'gpt-5-mini', 'claude-sonnet-4.6'],
  // UB7.15 (upstream v0.15.0, with UB7.7's labels) — Moonshot's utility tier is
  // its Kimi family; both hosts carry `kimi-k2.6` in the shipped 0.87.1
  // catalogue (verified before landing, not assumed — the P2.97 rule).
  moonshotai: ['kimi-k2.6'],
  'moonshotai-cn': ['kimi-k2.6'],
  'amazon-bedrock': [
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'global.anthropic.claude-sonnet-4-6',
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  ],
};

/**
 * Is `modelId` a small/fast-class model — the kind a background task should be
 * billed at?
 *
 * Keyword-based on purpose: the id is all we have for a catalog we do not own,
 * and every provider spells its cheap tier with one of these words. `sonnet` is
 * in the list because upstream puts it there for Bedrock, where *"Haiku may not
 * be enabled in every account or region"* (amazon-bedrock.md, fetched
 * 2026-08-25) — a Sonnet is the small/fast default there.
 *
 * `luna` joins them for the same reason `sonnet` did: GPT-5.6 does not spell its
 * cheap tier with any of the generic words, it names it. It is the id the Codex
 * page nominates as the replacement for `gpt-5.4-mini`, and the models page
 * describes it as the *"Fast and affordable GPT-5.6 model that delivers strong
 * capability at the lowest cost in the family"*
 * (`learn.chatgpt.com/docs/models.md`, fetched 2026-08-28). Its two siblings —
 * `gpt-5.6-sol` (flagship) and `gpt-5.6-terra` (the everyday workhorse) — are
 * deliberately NOT matched: naming one family member is the point.
 *
 * `kimi` joins them with UB7.15 (upstream v0.15.0 pins Moonshot's mini default
 * `kimi-k2.6`): the Kimi family IS Moonshot's utility tier, the same
 * provider-names-its-cheap-tier shape as `luna`.
 *
 * Used to keep {@link PI_MINI_PREFERRED_DEFAULTS} honest (every entry must
 * satisfy it) and to decide whether a mini pick deserves a warning.
 */
export function isSmallClassModelId(modelId: string): boolean {
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  return /haiku|mini|nano|flash|lite|small|sonnet|luna|kimi/i.test(bare);
}

/**
 * Index of a model id in a preferred list (bare ids, `pi/` optional, `{id}-*`
 * snapshots and Bedrock inference profiles match their bare id), or -1.
 * (UB3.6, upstream v0.15.0 — replaces the `findPreferredIndex` closure.)
 */
export function preferredModelRank(id: string, preferred: readonly string[]): number {
  const bare = id.startsWith('pi/') ? id.slice(3) : id
  // Deprecated IDs normalize to their replacement for stored-config migration.
  // Rank them as unranked: fromBedrockNativeId() applies the same normalization,
  // and letting a retired snapshot (e.g. claude-opus-4-5-20251101) inherit its
  // replacement's rank made the stable sort pick it as the connection default.
  if (normalizeDeprecatedModelId(bare) !== bare) return -1
  const matchIndex = (candidate: string): number =>
    preferred.findIndex(p => candidate === p || candidate.startsWith(`${p}-`))
  const direct = matchIndex(bare)
  if (direct >= 0) return direct
  // Bedrock: reverse-map the native inference-profile ID to bare, then match
  const reversed = fromBedrockNativeId(bare)
  return reversed !== bare ? matchIndex(reversed) : -1
}

export function getDefaultModelsForConnection(providerType: LlmProviderType, piAuthProvider?: string): Array<ModelDefinition | string> {
  if (providerType === 'pi') {
    const models = _piModelResolver(piAuthProvider);
    // Sort preferred defaults first so getDefaultModelForConnection picks a modern model.
    // For Bedrock models, the Pi SDK returns IDs like pi/us.anthropic.claude-opus-4-8
    // but preferred defaults use bare IDs (claude-opus-4-8). We match via both direct
    // comparison and reverse Bedrock ID mapping.
    const preferred = (piAuthProvider && PI_PREFERRED_DEFAULTS[piAuthProvider]) || [];
    if (preferred.length > 0) {
      // P2.95a — THE TIE-BREAK, and why the seeded Bedrock default was an EU
      // profile id for every user on earth.
      //
      // Bedrock ships the SAME model under one id per geography, and all of them
      // reverse-map to one bare id — so `au.`, `eu.`, `global.`, `jp.` and `us.`
      // Opus 5 all score index 0 here. `Array.prototype.sort` is stable, the
      // catalog arrives alphabetically, and `au.`, `jp.` were the two prefixes the
      // old reverse table did not know: the first RECOGNIZED id was
      // `eu.anthropic.claude-opus-5`, which is exactly what
      // `getDefaultModelForConnection` handed every new connection (measured
      // against the shipped catalog, 2026-08-25).
      //
      // Ranking the documented default prefix first makes the answer a decision
      // instead of an artifact of catalog order and table gaps. It is only a
      // SEED: the setup handler re-prefixes it with the connection's configured
      // region (`toBedrockNativeId(bare, deriveBedrockRegionPrefix(awsRegion))`),
      // which is the half that now also works on an already-native id.
      const prefixRank = (id: string): number => {
        const bare = id.startsWith('pi/') ? id.slice(3) : id
        const split = splitBedrockNativeModelId(bare)
        if (!split) return 0
        return split.regionPrefix === DEFAULT_BEDROCK_REGION_PREFIX ? 0 : 1
      }
      // UB3.6 (upstream v0.15.0) — preferredModelRank ranks a DEPRECATED id
      // (one that normalizes to its replacement) as unranked, so a retired
      // snapshot can no longer inherit its replacement's rank and win the
      // stable sort into the connection default. Unranked entries sort after
      // every preferred model, keeping the SDK's catalog order.
      const rank = (id: string): number => {
        const r = preferredModelRank(id, preferred)
        return r < 0 ? preferred.length : r
      }
      models.sort((a, b) => {
        const byPreference = rank(a.id) - rank(b.id);
        return byPreference !== 0 ? byPreference : prefixRank(a.id) - prefixRank(b.id);
      });
    }
    return models;
  }
  if (providerType === 'pi_compat') return [];  // Dynamic — user specifies
  // Same reason as pi_compat: the endpoint owns the catalog. Seeding a
  // claude-runtime connection from ANTHROPIC_MODELS would give it a
  // `defaultModel` of `claude-opus-4-8` that a custom endpoint cannot serve.
  //
  // `codex-runtime` belongs here for exactly the same reason and was missing
  // (C3): its sibling `getModelsForProviderType` already returns [] for it, so
  // the two disagreed. Latent until now — every codex connection was created by
  // the one-click card, whose SETUP payload overwrites both fields — but the BYO
  // form makes `createBuiltInConnection('codex-custom')` reachable, and an empty
  // model list would otherwise leave the connection defaulting to a Claude id
  // the endpoint has never heard of.
  if (isAdapterRuntimeProvider(providerType)) return [];
  if (providerType === 'nestor-cloud-agent') return getModelsByProvider('nestor-cloud-agent');
  // anthropic
  return ANTHROPIC_MODELS;
}

/**
 * Get the default model ID for a connection's provider type.
 * Derived from the first entry in getDefaultModelsForConnection() — single source of truth.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model ID string
 */
export function getDefaultModelForConnection(providerType: LlmProviderType, piAuthProvider?: string): string {
  const models = getDefaultModelsForConnection(providerType, piAuthProvider);
  const first = models[0];
  if (!first) return '';  // Dynamic provider — no default
  return typeof first === 'string' ? first : first.id;
}

/**
 * Resolve the effective LLM connection slug from available fallbacks.
 *
 * Single source of truth for the fallback chain used everywhere in the UI:
 *   1. Explicit session connection (locked after first message)
 *   2. Workspace-level default override
 *   3. Global default (isDefault flag on a connection)
 *   4. First available connection
 *
 * @param sessionConnection  - Per-session connection slug (session.llmConnection)
 * @param workspaceDefault   - Workspace-level default connection slug
 * @param connections        - All available connections (with status metadata)
 * @returns The resolved slug, or undefined when no connections exist
 */
export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  return sessionConnection
    ?? workspaceDefault
    ?? connections.find(c => c.isDefault)?.slug
    ?? connections[0]?.slug
}

/**
 * Check if a session's locked connection is unavailable (deleted/removed).
 * Returns true only when a session has an explicit llmConnection that doesn't
 * match any current connection. Sessions without a stored connection (using
 * the fallback chain) are never "unavailable".
 *
 * @param sessionConnection - Per-session connection slug (session.llmConnection)
 * @param connections - All available connections
 * @returns true if the session's connection no longer exists
 */
export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false
  return !connections.some(c => c.slug === sessionConnection)
}

/**
 * Check if an auth type uses browser OAuth flow.
 * @param authType - LLM auth type
 * @returns true if OAuth browser flow should be triggered
 */
export function authTypeIsOAuth(authType: LlmAuthType): boolean {
  return authType === 'oauth';
}

/**
 * Check if a provider supports a given auth type.
 * Returns valid combinations for the type system.
 *
 * @param providerType - Provider type
 * @param authType - Auth type to check
 * @returns true if this is a valid combination
 */
export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType
): boolean {
  const validCombinations: Record<LlmProviderType, LlmAuthType[]> = {
    anthropic: ['api_key', 'oauth'],
    pi: ['api_key', 'oauth', 'iam_credentials', 'environment', 'none'],
    pi_compat: ['api_key_with_endpoint', 'none'],
    // F1.202 — `oauth`: the ChatGPT (Codex) card, signed in through the host's
    // ChatGPT OAuth and handed to codex's own login (claude-runtime stays without).
    'codex-runtime': ['api_key_with_endpoint', 'api_key', 'none', 'oauth'],
    // Custom-endpoint Claude runtime: the endpoint owns auth, so no browser
    // OAuth — Claude subscription login stays on the 'anthropic' provider type.
    'claude-runtime': ['api_key_with_endpoint', 'api_key', 'none'],
    'nestor-cloud-agent': ['none'],
  };

  return validCombinations[providerType]?.includes(authType) ?? false;
}

/**
 * Bedrock id mapping — the DATA and the syntax live in
 * `bedrock-model-ids.ts`; these three exports are the thin wrappers that add
 * this module's one extra step, `normalizeDeprecatedModelId`, and keep the
 * package's public names stable.
 *
 * The two hand-written tables that used to sit here (`BEDROCK_MODEL_MAP` and
 * `BEDROCK_REVERSE_MAP`) are gone with the third copy in `models.ts`: three
 * lists of the same facts, one of which had already drifted (P2.94).
 *
 * `normalizeBedrockModelId` is gone too (P2.95b). It had ZERO production call
 * sites — the one place that needs it, the Pi+Bedrock arm of the
 * `SETUP_LLM_CONNECTION` handler, spells the same two steps inline in its own
 * `toPiModelId` — so it was a second implementation of a mapping this row
 * exists to de-duplicate. Its `pi/`-strip is what a caller adds; the mapping is
 * `toBedrockNativeId`.
 */

/**
 * Derive the Bedrock inference profile region prefix from an AWS region string.
 *
 * Since P6.375 an operator's `ANTHROPIC_BEDROCK_REGION_PREFIX` wins over the
 * region table — the page's *"tries first"* — and it is the only route to `jp`
 * and `au`, which no region derives. `env` is threaded for tests; production
 * reads `process.env` inside the leaf module.
 */
export function deriveBedrockRegionPrefix(
  awsRegion?: string,
  env?: Record<string, string | undefined>,
): string {
  return deriveBedrockRegionPrefixFromRegion(awsRegion, env)
}

/**
 * What the environment says about the prefix override, so the caller that owns
 * an operator-facing surface can NAME a rejected value. The leaf module refuses
 * to grow a logger (its header says why), and a silently ignored override is
 * exactly the shape this fork keeps finding: a setting that looks applied and
 * is not.
 */
export function readBedrockRegionPrefixOverride(
  env?: Record<string, string | undefined>,
): BedrockRegionPrefixOverride {
  return readBedrockRegionPrefixOverrideFromEnv(env)
}

/**
 * Map a bare Anthropic model ID to its Bedrock-native equivalent, at
 * `regionPrefix` (default `us`, the documented built-in). An id that is ALREADY
 * native is re-prefixed when a region is named and left alone when none is —
 * see `bareToBedrockNativeModelId`. Pass-through for an unknown model.
 */
export function toBedrockNativeId(modelId: string, regionPrefix?: string): string {
  return bareToBedrockNativeModelId(normalizeDeprecatedModelId(modelId), regionPrefix)
}

/** Map a Bedrock-native model ID back to its bare Anthropic equivalent. Pass-through if already bare or unknown. */
export function fromBedrockNativeId(modelId: string): string {
  return bedrockNativeToBareModelId(normalizeDeprecatedModelId(modelId))
}

/**
 * P6.532 — the operator's off switch for the BYO Bedrock CARD.
 *
 * The row's `done_means` asks that *"the card's existence is a disclosure an
 * operator can switch off"*. It is a DISCLOSURE rather than a security control,
 * and the difference matters: turning it off does not make an ambient AWS
 * credential unreachable (it already reaches the codex child by env inheritance
 * and always did), it makes the CARD unavailable, so no connection in this
 * install can declare Bedrock and the loopback pin is unconditional again.
 *
 * Default ON — the card exists — because Q-den 72 refused option a ("keep the
 * pin and say so") on the ground that a capability the runtime already has must
 * not stay unavailable on one runtime of three.
 */
export const CODEX_BEDROCK_CARD_ENV_VAR = 'NESSY_CODEX_BEDROCK_CARD'

/** Is the BYO Bedrock card offered in this install? Unset, or unreadable, is on. */
export function isCodexBedrockCardEnabled(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): boolean {
  return parseBooleanEnv(env[CODEX_BEDROCK_CARD_ENV_VAR]) ?? true
}

/**
 * P6.532 — the codex `model_provider` this connection routes to, or `undefined`
 * when the writer must keep its loopback pin.
 *
 * **This function reads the CONNECTION and the operator switch, and NOTHING
 * ELSE.** It never looks at `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`,
 * `AWS_ACCESS_KEY_ID` or any other ambient name, and that absence is the row's
 * entire safety property rather than an oversight: a session pinned to the
 * gateway stays pinned to the gateway on a machine whose shell exports a full
 * AWS identity. P6.80 measured the same guarantee on the other two runtimes —
 * pi-ai's ambient reads are keyed by provider id and a pinned session is
 * registered as `custom-endpoint`, which is in none of its tables — so all three
 * now answer the reroute question the same way, which is what makes this a
 * closed gap rather than a new divergence.
 *
 * The `providerType` guard is not decoration. `codexModelProvider` on a `pi`
 * connection would be a field nothing reads; answering `undefined` there keeps
 * the meaning of the field exactly one thing.
 */
export function resolveCodexModelProvider(
  connection: Pick<LlmConnection, 'providerType' | 'codexModelProvider'>,
  env?: Record<string, string | undefined>,
): CodexModelProvider | undefined {
  if (connection.providerType !== 'codex-runtime') return undefined
  // F1.202 — the ChatGPT (Codex) card. NOT behind the Bedrock operator switch,
  // which is that card's disclosure, and NOT behind the ChatGPT provider flag
  // either: the flag gates the CARD (build-time, `feature-flags.ts`), exactly as
  // it gates the Pi `chatgpt-plus` card, and a connection that already exists
  // keeps working. Undeclaring it here would do worse than refuse — the writer
  // would fall back to the loopback pin and the session would send its turns
  // to the Nessy Gateway, a different endpoint on a different credential.
  if (connection.codexModelProvider === CODEX_CHATGPT_MODEL_PROVIDER) return CODEX_CHATGPT_MODEL_PROVIDER
  if (connection.codexModelProvider !== CODEX_BEDROCK_MODEL_PROVIDER) return undefined
  return isCodexBedrockCardEnabled(env) ? CODEX_BEDROCK_MODEL_PROVIDER : undefined
}

/**
 * F1.202 option (a) (OWNER-approved 2026-09-24) — codex's OWN built-in
 * `openai` provider, the one the ChatGPT (Codex) card declares.
 *
 * Source, `rust-v0.156.1` (the tag `codex-protocol/manifest.json` pins, STRONG
 * tier): `built_in_model_providers` (`codex-rs/model-provider-info/src/lib.rs`)
 * registers `openai` with no `base_url` and `requires_openai_auth: true`, and
 * `ModelProviderInfo::to_api_provider` sends a session whose auth mode is
 * `ChatgptAuthTokens` to `CHATGPT_CODEX_BASE_URL` =
 * `https://chatgpt.com/backend-api/codex` — the subscription. So the card's turns
 * spend the subscription because codex routes them there, not because this
 * host proxies anything: no loopback adapter is started for a declared session
 * (`CodexAgent.createRuntime`, P6.532's mechanism) and the credential is codex's
 * external auth (`backend/codex/chatgpt-subscription-auth.ts`).
 */
export const CODEX_CHATGPT_MODEL_PROVIDER: CodexModelProvider = 'openai'

/**
 * F1.202 — the card's seed catalogue: codex's OWN bundled catalogue at
 * `rust-v0.159.3` (`codex-rs/models-manager/models.json`; re-seeded by F1.1215,
 * where `gpt-6.1-sol` arrived at priority 1), the entries whose
 * `visibility` is `list`, in its `priority` order, with its display names,
 * descriptions and `context_window`. Every one lists `plus` in
 * `available_in_plans`.
 *
 * A SEED with a date, not a live catalogue: codex fetches the account's own
 * model list from the ChatGPT backend once signed in, and a codex lift can move
 * this file. Refreshing the seed from the live app-server's `model/list` is a
 * follow-up, stated rather than built (P3.115's measurement that `model/list`
 * answers codex's OWN catalogue is exactly why it would be the right source for
 * THIS card, and the wrong one for every other codex card).
 */
export const CODEX_CHATGPT_SUBSCRIPTION_MODELS: ModelDefinition[] = [
  ['gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.'],
  ['gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.'],
  ['gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.'],
  ['gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.'],
  ['gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.'],
  ['gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.'],
  ['gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.'],
  ['gpt-5.5', 'GPT-5.5', 'Legacy coding model.'],
].map(([id, name, description]) => ({
  id: id!,
  name: name!,
  shortName: name!,
  description: description!,
  provider: 'codex-runtime' as const,
  contextWindow: 272_000,
}))

/**
 * F1.202 — codex's own default: *"default is the highest priority available
 * model"* (`codex-rs/protocol/src/openai_models.rs`), i.e. the first entry above.
 */
export const CODEX_CHATGPT_DEFAULT_MODEL = CODEX_CHATGPT_SUBSCRIPTION_MODELS[0]!.id

/**
 * F1.202 — what a built-in template that declares a codex provider adds to the
 * connection it creates (`server-core` `createBuiltInConnection`): the
 * declaration itself, and — for the ChatGPT card — codex's own catalogue,
 * because an adapter-runtime template otherwise seeds no models at all.
 */
export function codexChatGptSubscriptionConnectionSeed(
  provider: CodexModelProvider,
): Pick<LlmConnection, 'codexModelProvider'> & Partial<Pick<LlmConnection, 'models' | 'defaultModel'>> {
  if (provider !== CODEX_CHATGPT_MODEL_PROVIDER) return { codexModelProvider: provider }
  return {
    codexModelProvider: provider,
    models: CODEX_CHATGPT_SUBSCRIPTION_MODELS.map(model => ({ ...model })),
    defaultModel: CODEX_CHATGPT_DEFAULT_MODEL,
  }
}

/**
 * F1.202 — the ONE predicate for "this connection is the ChatGPT (Codex) card",
 * read by the `/quota` menu row (`backend/composer-capabilities.ts`) and, through
 * `resolveCodexModelProvider`, by every `CodexAgent` branch — so the menu and
 * the session cannot disagree about which card this is.
 */
export function isCodexChatGptSubscriptionConnection(
  connection: Pick<LlmConnection, 'providerType' | 'codexModelProvider'> | null | undefined,
): boolean {
  return !!connection && resolveCodexModelProvider(connection) === CODEX_CHATGPT_MODEL_PROVIDER
}

// ============================================================
// Auth Environment Variable Resolution
// ============================================================

// The stripped-key list itself lives in `claude-provider-routing-env.ts` (a
// leaf module both this file and `agent/options.ts` import) so the two strip
// sites cannot drift apart again — that duplication is how Vertex/Foundry/
// Mantle went missing from one list and not the other. Both sites read the
// UNION (`CLAUDE_SDK_STRIPPED_ENV_KEYS`), which since P3.113 is the seven
// provider toggles plus their four documented companions plus the one
// non-provider name `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`.
const CLAUDE_SDK_STRIPPED_ENV_KEY_SET = new Set<string>(
  CLAUDE_SDK_STRIPPED_ENV_KEYS,
)

/**
 * The names this HOST-env reset must NOT delete, even though the CHILD env
 * builder strips them (P3.346).
 *
 * ## The defect, measured with a grandchild
 *
 * `MANAGED_ANTHROPIC_AUTH_ENV_BASELINE` recorded `undefined` for every name in
 * {@link CLAUDE_SDK_STRIPPED_ENV_KEYS}, so `resetManagedAnthropicAuthEnvVars`
 * — awaited by `SessionManager.reinitializeAuth` from `initialize()` in BOTH
 * hosts — deleted them from the host `process.env` at boot. Driven on
 * 2026-09-04 in a throwaway child (the Bun env unlock is sticky in-process) that
 * then spawned a grandchild from `{...process.env}`, so the verdict is "the
 * subprocess received it" rather than "an object literal contained it":
 *
 * | name                         | at launch | after reset | grandchild |
 * | ---------------------------- | --------- | ----------- | ---------- |
 * | `AWS_BEARER_TOKEN_BEDROCK`   | set       | **gone**    | **gone**   |
 * | `ANTHROPIC_BEDROCK_BASE_URL` | set       | **gone**    | **gone**   |
 * | `CLAUDE_CODE_USE_BEDROCK`    | set       | gone        | gone       |
 * | `AWS_REGION`                 | set       | kept        | kept       |
 * | `AWS_ACCESS_KEY_ID`          | set       | kept        | kept       |
 *
 * `AWS_REGION`/`AWS_ACCESS_KEY_ID` are the surviving controls: they are in the
 * baseline but not in the stripped set, so the fixture demonstrably restores
 * what it is supposed to.
 *
 * ## Why the deletion is wrong for these four specifically
 *
 * Every child that is not the Claude SDK is built by spreading the host
 * `process.env`, and we ship a Bedrock provider card that runs on Pi. `pi-ai`'s
 * `amazon-bedrock` resolver reads the token as credential source 3 of 6 —
 * `if (await env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source:
 * "AWS_BEARER_TOKEN_BEDROCK" }` — and the next two arms are `AWS_PROFILE` and
 * then `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. So deleting it does not fail
 * loudly: it falls through to a DIFFERENT AWS identity, on a runtime this reset
 * is not about. `buildAwsEnv` never re-supplies it.
 *
 * Claude loses nothing. `agent/options.ts` still strips all twelve names when it
 * builds the SDK subprocess env, which is the layer that has to strip them; the
 * host-level deletion was belt-and-braces that cost another runtime its
 * credentials. The in-tree precedent is explicit — `CLAUDE_LAUNCHER_ENV_KEYS`'
 * docblock already says to scrub the CHILD only, because "clearing it there
 * would silently change a runtime this row is not about".
 *
 * The four toggles and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` are NOT here:
 * a toggle is a provider SELECTION with no credential value of its own, nothing
 * else on the host reads it, and `Mn()` returning `"firstParty"` is exactly what
 * the host strip is for.
 *
 * ## P6.85 — this asymmetry is NOT a disclosable divergence, and here is the
 * measurement instead of a row
 *
 * The obvious gaps row would read *"claude scrubs twelve routing names, Pi and
 * codex scrub none"*, and it would ship a false sentence: the seven provider
 * toggles and `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` have `undefined` in
 * {@link MANAGED_ANTHROPIC_AUTH_ENV_BASELINE}, so the boot reset deletes them
 * from the host `process.env` and they reach NO child of ANY runtime. Only the
 * four names in this set survive to a Pi or codex child, and only because a
 * runtime that is not claude reads them.
 *
 * **Both of those runtimes really do read them, which is the point — and one of
 * them was a surprise.** Pi: `pi-ai`'s `amazon-bedrock` resolver, credential
 * source 3 of 6. Codex: probed on the staged `codex-app-server`
 * (178 126 224 B, 2026-09-05), `AWS_BEARER_TOKEN_BEDROCK` is **present**, beside
 * `bedrock-mantle` and the operator sentence *"If `AWS_BEARER_TOKEN_BEDROCK` is
 * set, update or unset it, then restart Codex"* — codex ships a Bedrock
 * bearer-token provider of its own. The other three score **absent** on that
 * same binary, against `CODEX_HOME` present and a nonsense name absent as the
 * controls. So the surviving four are a CAPABILITY two runtimes have, not a
 * control claude has and they lack, and the switch-cost shape (*"the source
 * runtime has a control the target lacks"*) does not fit in either direction.
 *
 * **And it cannot reroute anything.** P6.80 measured the reroute half: pi-ai's
 * ambient reads are keyed by PROVIDER ID and a pinned session is registered as
 * `custom-endpoint`, which is in none of its tables; codex selects its provider
 * from the `model_provider` key we write, and this repo configures
 * `amazon-bedrock` nowhere (`git grep` over the two codex packages and
 * `codex-agent.ts` returns only a quoted SDK predicate in a comment). An ambient
 * name can decide WHICH AWS identity an explicitly-Bedrock connection uses on
 * either runtime; it cannot move a session off the connection it is pinned to.
 *
 * So P6.85's `done_means` resolves to its second arm — this comment and NO gaps
 * row. `runtime-capability-gaps.md`'s only line in this area is the
 * out-of-surface tally (*"Bedrock/Vertex/Foundry/Mantle routing … the cloud
 * toggles are deliberately stripped"*, re-read 2026-09-05), which is true as
 * written and names the TOGGLE constant rather than the union. Filling the rest
 * of that silence with a false shape is worse than the silence.
 */
const HOST_PRESERVED_ENDPOINT_CREDENTIAL_KEY_SET = new Set<string>(
  CLAUDE_PROVIDER_ENDPOINT_CREDENTIAL_ENV_KEYS,
)

const MANAGED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_SDK_STRIPPED_ENV_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

function getRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined
  }
  return process.env[key]
}

const MANAGED_ANTHROPIC_AUTH_ENV_BASELINE: Record<string, string | undefined> =
  Object.fromEntries(
    MANAGED_ANTHROPIC_AUTH_ENV_KEYS.map((key) => [
      key,
      CLAUDE_SDK_STRIPPED_ENV_KEY_SET.has(key)
        && !HOST_PRESERVED_ENDPOINT_CREDENTIAL_KEY_SET.has(key)
        ? undefined
        : getRuntimeEnvValue(key),
    ]),
  )

/**
 * Delete every name in {@link CLAUDE_SDK_STRIPPED_ENV_KEYS} from `targetEnv` —
 * except, on the HOST env, the endpoint/credential four.
 *
 * **The name is narrower than the behaviour, deliberately and visibly.** Since
 * P3.113 this also clears `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, which is
 * not a cloud provider: it is the boolean that makes the child treat our
 * loopback gateway adapter as `api.anthropic.com`. Renaming the function would
 * touch `claude-agent.ts`, so the honest move here is to say so rather than to
 * let the name imply a smaller list; the union constant's header carries what
 * the flag does and why an ambient value is stripped rather than honoured.
 *
 * ## P6.80 — THIS WAS THE SECOND COPY OF THE DEFECT P3.346 FIXED, AND IT WAS LIVE
 *
 * P3.346 stopped `resetManagedAnthropicAuthEnvVars` deleting
 * {@link HOST_PRESERVED_ENDPOINT_CREDENTIAL_KEY_SET} from the host
 * `process.env`, because Pi's Bedrock card reads `AWS_BEARER_TOKEN_BEDROCK` and
 * falls through SILENTLY to a different AWS identity when it is gone. It left
 * this function alone, and this function is called with NO ARGUMENT — i.e. on
 * `process.env` — from `claude-agent.ts`'s auth-injection path, once per claude
 * session. So the ordering `claude session → Pi Bedrock session` in one host
 * process reproduced the whole defect, with no connection change and nothing
 * saying so.
 *
 * ## P6.80 half (b), RE-MEASURED AT HEAD — the enumeration is NOT twelve
 *
 * An earlier reading of this row counted `env("LITERAL")` call sites in the
 * vendored `@earendil-works/pi-ai` (175 dist JS files, read with
 * `find … -type f -exec grep` rather than a star-star pathspec, which git reads
 * without glob magic), got TWELVE, and concluded that every ambient name pi-ai
 * reads is an AWS or GCP credential. **That form is a SUBSET and the conclusion
 * drawn from it is false.** pi-ai reads ambient names through two further doors:
 * `ctx.env(<variable>)` — `auth/helpers.js`'s `envApiKeyAuth` walking a
 * per-provider list, and `providers/anthropic.js` walking its own three — and
 * `getProviderEnvValue(<literal>)`, whose 25 literal arguments include a REAL
 * base URL (`AZURE_OPENAI_BASE_URL`, spliced in at
 * `api/azure-openai-responses.js:164` when no `azureBaseUrl` is passed), a
 * skip-auth flag (`AWS_BEDROCK_SKIP_AUTH`), `AZURE_OPENAI_RESOURCE_NAME`, and
 * three OAuth hosts. So an ambient name CAN move a base URL inside pi-ai, and a
 * flat claim that none can is wrong.
 *
 * **The verdict this row wanted survives anyway, and for a stronger reason:
 * every one of those reads is keyed by PROVIDER ID, and the id a pinned session
 * uses is in none of the tables.** `env-api-keys.js`'s `getApiKeyEnvVars`
 * answers `undefined` for any provider outside its 36-entry map plus
 * `github-copilot` and `anthropic`; `getEnvApiKey`'s two extra arms are
 * `google-vertex` and `amazon-bedrock` only. Every custom endpoint we register
 * — the Nessy gateway included — is registered as `custom-endpoint` with its
 * `baseUrl` and `apiKey` handed in at `registerProvider`
 * (`pi-agent-server/src/index.ts:1518`), and its api is `openai-completions` or
 * `anthropic-messages`, never `azure-openai-responses`. So pi-ai never consults
 * the environment for a pinned session at all. **Verdict: no ambient name can
 * reroute a session pinned to the gateway connection, or change the credential
 * it sends.** What an ambient name CAN still decide is which AWS identity the
 * `amazon-bedrock` card authenticates as — which is exactly the half below.
 *
 * So the fix is scoped to the credential half, and only on the host: a caller
 * that hands in an explicit env object — a CHILD env being built — still gets
 * all twelve deleted, because that is the layer which has to strip them.
 * `agent/options.ts` is that layer and does exactly this. Claude loses nothing;
 * the host-level deletion of these four was belt-and-braces that cost another
 * runtime its credentials, which is the same argument P3.346 already accepted
 * and the same one `CLAUDE_LAUNCHER_ENV_KEYS`' header makes for scrubbing the
 * child only.
 */
export function clearClaudeCloudProviderRoutingEnvVars(
  targetEnv?: Record<string, string | undefined>,
): void {
  // No argument, or `process.env` itself, is the HOST case. Anything else is a
  // child env under construction and keeps the old all-twelve behaviour.
  const isHostEnv = targetEnv === undefined || targetEnv === process.env
  const target = targetEnv ?? process.env
  for (const key of CLAUDE_SDK_STRIPPED_ENV_KEYS) {
    if (isHostEnv && HOST_PRESERVED_ENDPOINT_CREDENTIAL_KEY_SET.has(key)) continue
    delete target[key]
  }
}

/**
 * Return the host `process.env` to its LAUNCH state for every managed-auth
 * name, with the provider TOGGLES additionally forced off.
 *
 * "Launch state" is the load-time snapshot in
 * {@link MANAGED_ANTHROPIC_AUTH_ENV_BASELINE}. The endpoint/credential four are
 * restored rather than deleted — see
 * {@link HOST_PRESERVED_ENDPOINT_CREDENTIAL_KEY_SET} for the measurement and
 * for why deleting them changed which AWS identity Pi uses.
 */
export function resetManagedAnthropicAuthEnvVars(): void {
  if (typeof process === 'undefined' || !process?.env) {
    return
  }

  for (const key of MANAGED_ANTHROPIC_AUTH_ENV_KEYS) {
    const originalValue = MANAGED_ANTHROPIC_AUTH_ENV_BASELINE[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

/**
 * Result of resolving auth env vars for an LLM connection.
 */
export interface ResolvedAuthEnvVars {
  /** Environment variables to set (e.g., ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) */
  envVars: Record<string, string>;
  /** Whether credentials were successfully resolved */
  success: boolean;
  /** Warning message if auth resolution encountered issues */
  warning?: string;
}

/**
 * Resolve authentication environment variables for an LLM connection.
 *
 * Provider-agnostic: switches on providerType to determine which env vars
 * to set and how to retrieve credentials. Shared by:
 * - `SessionManager.reinitializeAuth()` (logs the names only; never applied to process.env, F1.963)
 * - `ClaudeAgent.postInit()` (applies to THIS session's envOverrides only, F1.958)
 *
 * Providers that handle auth internally (openai, copilot, pi) return
 * empty envVars — their auth is managed in postInit() via native mechanisms.
 *
 * @param connection - The LLM connection config
 * @param connectionSlug - Connection slug for credential lookup
 * @param credentialManager - Credential manager instance
 * @param getValidOAuthToken - Function to get a valid (refreshed) OAuth token
 * @returns Resolved env vars and status
 */
export async function resolveAuthEnvVars(
  connection: LlmConnection,
  connectionSlug: string,
  credentialManager: CredentialManager,
  getValidOAuthToken: (slug: string) => Promise<{ accessToken?: string | null }>,
): Promise<ResolvedAuthEnvVars> {
  const envVars: Record<string, string> = {};

  // Only Anthropic-SDK-based providers use env var auth
  // OpenAI (Codex), Copilot, and Pi handle auth internally in their postInit()
  if (!isAnthropicProvider(connection.providerType)) {
    return { envVars, success: true };
  }

  // Set base URL if configured
  if (connection.baseUrl) {
    envVars.ANTHROPIC_BASE_URL = connection.baseUrl;
  }

  const authType = connection.authType;

  if (authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token') {
    const apiKey = await credentialManager.getLlmApiKey(connectionSlug);
    if (apiKey) {
      envVars.ANTHROPIC_API_KEY = apiKey;
    } else if (connection.baseUrl) {
      // Keyless provider (e.g. Ollama)
      envVars.ANTHROPIC_API_KEY = 'not-needed';
    } else {
      return { envVars, success: false, warning: `No API key found for: ${connectionSlug}` };
    }
  } else if (authType === 'oauth') {
    if (connection.providerType === 'anthropic') {
      // Anthropic OAuth uses getValidClaudeOAuthToken which handles token refresh
      const tokenResult = await getValidOAuthToken(connectionSlug);
      if (tokenResult.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = tokenResult.accessToken;
      } else {
        return { envVars, success: false, warning: `Failed to get OAuth token for: ${connectionSlug}` };
      }
    } else {
      // Non-Anthropic OAuth credentials use the connection-scoped store.
      const llmOAuth = await credentialManager.getLlmOAuth(connectionSlug);
      if (llmOAuth?.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = llmOAuth.accessToken;
      } else {
        return { envVars, success: false, warning: `No OAuth token found for: ${connectionSlug}` };
      }
    }
  } else if (authType === 'environment') {
    // Environment auth — credentials come from process.env, nothing to inject
    return { envVars, success: true };
  }

  return { envVars, success: true };
}
