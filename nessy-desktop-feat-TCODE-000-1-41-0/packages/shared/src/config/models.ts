/**
 * Centralized Model Registry
 *
 * Single source of truth for all model definitions across the application.
 * All model metadata, capabilities, and costs are defined here.
 *
 * When adding a new model or provider:
 * 1. Add the model(s) to MODEL_REGISTRY
 * 2. The convenience exports (ANTHROPIC_MODELS, OPENAI_MODELS) auto-update
 * 3. Update llm-connections.ts if adding a new built-in connection
 */
// Bedrock-native → bare Anthropic ID reverse mapping. This file used to carry
// its OWN copy of the table, duplicated from llm-connections.ts because the
// import can only run one way, with a comment telling the next reader to keep
// the two in sync. It was already out of sync: every `claude-opus-5` form was
// missing, so the seeded Bedrock default model displayed as
// "Eu.anthropic.opus 5" with an unknown context window (P2.94). Both sides now
// read one leaf module, which derives the mapping instead of listing it.
import { BEDROCK_REGION_PREFIXES, bedrockNativeToBareModelId } from './bedrock-model-ids.ts';

/** Bare Anthropic ids whose replacement is another bare id. */
const DEPRECATED_BARE_REPLACEMENTS: Record<string, string> = {
  'claude-opus-4-5-20251101': 'claude-opus-4-8',
  'claude-opus-4-6': 'claude-opus-4-8',
  // DeepSeek retired the v4 Flash aliases (UB3.7, upstream v0.15.1 models.ts);
  // pi 0.86+ catalogs only list `deepseek-flash`.
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

/**
 * Bedrock-native replacements, WITHOUT a geography prefix. The prefixed rows are
 * derived below.
 *
 * P2.194(2). This table used to carry its Bedrock rows once PER PREFIX — three
 * models × `anthropic.`/`us.`/`eu.`/`global.` — and the `global.` row for the
 * dated 4.5 Opus was never written, so `global.anthropic.claude-opus-4-5-…`
 * displayed as "Opus 4.5" beside its `us.`/`eu.` twins' "Opus 4.8" (measured
 * against the shipped catalog, 2026-08-25). P2.95 repaired that ONE reading by
 * normalizing the bare id a second time inside `toRegistryModelId`, which is why
 * the display is right today — but `normalizeDeprecatedModelId` is called
 * DIRECTLY in eight other places (`resolveModelForProvider`,
 * `fromBedrockNativeId`, `getSummarizationModel`, …), and at every one of those
 * the missing row was still missing.
 *
 * So the shape is the defect, exactly as the row said: a table that invites one
 * omission per geography, in a list that has to agree with another list. The
 * geography is pure syntax — every prefixed row was `<prefix>.` + this row —
 * and it is now derived from {@link BEDROCK_REGION_PREFIXES}, which covers
 * `apac.`, `jp.`, `au.` and `us-gov.` without four more rows each.
 */
const DEPRECATED_BEDROCK_BASE_REPLACEMENTS: Record<string, string> = {
  'anthropic.claude-opus-4-5-20251101-v1:0': 'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-6-v1': 'anthropic.claude-opus-4-8',
  'anthropic.claude-opus-4-7-v1': 'anthropic.claude-opus-4-7',
};

const DEPRECATED_MODEL_REPLACEMENTS: Record<string, string> = {
  ...DEPRECATED_BARE_REPLACEMENTS,
  ...DEPRECATED_BEDROCK_BASE_REPLACEMENTS,
  ...Object.fromEntries(BEDROCK_REGION_PREFIXES.flatMap(prefix =>
    Object.entries(DEPRECATED_BEDROCK_BASE_REPLACEMENTS)
      .map(([from, to]) => [`${prefix}.${from}`, `${prefix}.${to}`]))),
};

/** Normalize deprecated built-in model IDs to the current supported replacement. */
export function normalizeDeprecatedModelId(modelId: string): string {
  if (modelId.startsWith('pi/')) {
    const normalized = normalizeDeprecatedModelId(modelId.slice(3));
    return normalized === modelId.slice(3) ? modelId : `pi/${normalized}`;
  }
  return DEPRECATED_MODEL_REPLACEMENTS[modelId] ?? modelId;
}

// ============================================
// TYPES
// ============================================

/**
 * Provider identifier for AI backends.
 */
export type ModelProvider = 'anthropic' | 'pi' | 'codex-runtime' | 'nestor-cloud-agent';

/**
 * Full model definition with capabilities and costs.
 * Used throughout the application for model selection and display.
 */
export interface ModelDefinition {
  /** Model identifier (e.g., 'claude-sonnet-4-6', 'gpt-5.3-codex') */
  id: string;
  /** Human-readable name (e.g., 'Sonnet 4.6', 'Codex') */
  name: string;
  /** Short display name for compact UI (e.g., 'Sonnet', 'Codex') */
  shortName: string;
  /** Brief description of the model's strengths */
  description: string;
  /** Translation key for the description (for built-in static models only).
   *  UI should resolve: t(descriptionKey) if set, otherwise fall back to description. */
  descriptionKey?: string;
  /** Provider that offers this model */
  provider: ModelProvider;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Whether this model supports thinking/reasoning effort. Defaults to true when undefined. */
  supportsThinking?: boolean;
  /** Explicit per-model image input capability hint, primarily for custom endpoints. */
  supportsImages?: boolean;
  /**
   * The endpoint's own words, when `supportsImages: false` was LEARNED from a
   * refusal rather than declared by a person (P6.482, owner Q12 2026-09-05).
   *
   * One field doing both jobs, which is why it is a sentence and not a boolean:
   * its PRESENCE is the learned-vs-declared distinction the ruling demands be
   * visible, and its CONTENT is what the composer quotes when it greys the
   * attach control — so the user is told what the endpoint said, not what we
   * concluded. Cleared by any explicit write, which is how the one-click
   * reversal un-learns.
   */
  supportsImagesLearnedFrom?: string;
  /**
   * The wire this model answers on, when it is NOT chat-completions (G3).
   *
   * A property of the MODEL, not of the connection: one llm-proxy connection
   * serves a Qwen over chat-completions and a `claude-*` over Anthropic
   * Messages at the same time, so the Claude runtime's loopback adapter routes
   * per request by the model asked for. Absent means chat-completions, which is
   * every model that existed before this field.
   *
   * Written only by a probe that actually got an answer on that wire — never
   * inferred from a chat-completions refusal (`gemini/*` refuses there and
   * speaks neither).
   */
  wire?: 'anthropic-messages';
  /**
   * DA1.22 - the reasoning effort the MODEL'S OWN CATALOGUE recommends.
   *
   * Written today only by `server-core/src/model-fetchers/nestor.ts` off the
   * gateway's `/cli/models` row (`reasoning: {"effort":"low"}` on the default
   * `coder` row, absent on `fast`, measured 2026-09-13 and re-read 2026-09-17).
   * It is the backend's RECOMMENDATION, not a setting the backend applies: a
   * turn that sends no effort key comes back with `reasoning_tokens: 0`, three
   * runs.
   *
   * ADOPTING IT COSTS TIME AND TOKENS, and the owner accepted that with the
   * number in hand (2026-09-17): on the measured arm the same prompt goes from
   * 0.9 s with no effort key to 12 s with `low`, plus the reasoning tokens.
   * That is why it is applied as a DEFAULT and never as an override - see
   * `codex-responses-adapter/src/to-chat.ts` symbol `toChatRequest`, which fills
   * it in only where the caller asked for reasoning and named no level.
   *
   * A free string and not a union on purpose, for the reason `ChatRequest`'s own
   * `reasoning_effort` gives: the accepted set is a per-back-end contract and no
   * single enum is right for every upstream a connection can hold.
   */
  reasoningEffort?: string;
  /**
   * D1.162 — did the endpoint's OWN catalogue still list this id at the last
   * refresh?
   *
   * The model picker's provenance line is one sentence for the whole list, and
   * ledger K34's rule is that the label belongs PER ENTRY. On a metadata-synced
   * BYO connection the list is genuinely mixed: `mergeModelMetadata` keeps an id
   * the user picked and the catalogue has since dropped — deliberately, so a
   * running session cannot lose its model mid-flight — so two rows sitting side
   * by side can have different answers to "where did this come from".
   *
   * Written by the merge and by nothing else. `undefined` is "nobody has asked
   * this endpoint", which is the honest answer for a hand-typed list, for a
   * connection that has never synced, and for the gateway cards, whose list is
   * REPLACED wholesale and whose freshness is the connection-level
   * `catalogueRefreshedAt`. A renderer must render those three as the same
   * "unknown" rather than as `false`.
   */
  catalogueListed?: boolean;
  /**
   * DA1.22 - the sampling parameters the model's own catalogue publishes.
   *
   * Spelled the way the RUNTIME that consumes it spells it: this is Pi's own
   * `Model.samplingParams` field, `Record<string, unknown>`, documented in
   * `@earendil-works/pi-ai`'s `dist/types.d.ts` as *"Default sampling parameters
   * for this model ... per-request keys override these"* and merged into the
   * body by its OpenAI-compatible adapters. Native-first: the gateway publishes
   * `sampling_params` per row (`{temperature, top_p}` on `coder`,
   * `{temperature, top_k, top_p}` on `fast`), Pi has a field of exactly that
   * shape, and the host only has to carry it across.
   *
   * On the loopback adapter the same object supplies the DEFAULTS the adapter
   * used to invent (`temperature: 0.7`, `top_p: 0.8` for every model whatever the
   * catalogue said); the caller's own values still win.
   */
  samplingParams?: Record<string, unknown>;
}

// ============================================
// MODEL REGISTRY (Single Source of Truth)
// ============================================

/**
 * All available models across all providers.
 * This is the authoritative list - all other model arrays derive from this.
 */
export const MODEL_REGISTRY: ModelDefinition[] = [
  // ----------------------------------------
  // Anthropic Claude Models
  // ----------------------------------------
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    shortName: 'Opus',
    description: 'Most capable for complex work',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  // F1.1214 — Opus 5.5, Sonnet 5.5 and Fable 5.1 each sit right AFTER the
  // first row of their family, by the rule the Opus 5 note below states: no new
  // row takes a `shortName` slot, so `DEFAULT_MODEL` and the first Sonnet and
  // Fable rows stay where they were. Window: the models overview's "Context
  // window" row, "1M tokens" for all three
  // (platform.claude.com/docs/en/models/overview.md).
  {
    id: 'claude-opus-5-5',
    name: 'Opus 5.5',
    shortName: 'Opus',
    description: 'Most capable for complex work',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  // Opus 5 sits AFTER Opus 4.8 on purpose. `DEFAULT_MODEL` is declared below as
  // `getModelIdByShortName('Opus')` — the FIRST Opus entry in this array — and
  // that constant is the runtime model fallback (`claude-agent.ts`:
  // `session?.model ?? config.model ?? DEFAULT_MODEL`). Anthropic BYOK is
  // feature-flag-off today, so heading the list with an id no enabled
  // connection can serve would move that fallback for no gain. Promote it when
  // the owner flips the provider flags.
  {
    id: 'claude-opus-5',
    name: 'Opus 5',
    shortName: 'Opus',
    description: 'Most capable for complex work',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    shortName: 'Opus',
    description: 'Previous Opus generation',
    descriptionKey: 'model.opusDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    shortName: 'Sonnet',
    description: 'Best combination of speed and intelligence',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Sonnet 5.5',
    shortName: 'Sonnet',
    description: 'Best combination of speed and intelligence',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  // F1.1221 — 1M, from platform.claude.com/docs/en/build-with-claude/context-windows.md:
  // "Claude Sonnet 4.6 ... have a 1M-token context window" and "For every model
  // with a 1M-token context window, 1M is the default: you don't need a beta
  // header". In Claude Code, Sonnet 4.6 "reach[es] 1M only through [its] `[1m]`
  // variant" (the Extended context section of code.claude.com model-config.md),
  // which is exactly the selector `chatImpl` appends for every `claude-` id known at
  // 1M or more (F1.1241: no Extended context switch, the model's window decides).
  // Residue, stated: the same section says "Sonnet 4.6 with 1M context requires
  // usage credits on every subscription plan, including Max", so a claude.ai
  // login without them gets what Claude Code's own `sonnet[1m]` gets there (its
  // own usage-credits message), not a silent 200K fallback.
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    shortName: 'Sonnet',
    description: 'Previous Sonnet generation',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  // P2.194(3) — `claude-sonnet-4-5-20250929` had NO registry row at all, so it
  // had no context window: `getModelById` missed it, `getModelContextWindow`
  // answered `undefined`, and the display name fell through to the humanizer.
  // Not an obscure id — `bedrock-model-ids.ts` maps it as a supported model, the
  // shipped Pi Bedrock catalog publishes it under six geographies, and
  // `llm-connections.ts` names the `global.` form as a preferred MINI model, so
  // it is the model a Bedrock session bills its background turns to.
  //
  // Position matters and this one is deliberate: `getModelIdByShortName` returns
  // the FIRST row with a given `shortName` (that is how `DEFAULT_MODEL` picks
  // Opus 4.8 over Opus 5), so this sits AFTER `claude-sonnet-4-6` and cannot
  // become anyone's "Sonnet".
  //
  // 200_000 is the documented window: context-windows.md, "Other Claude models,
  // including Claude Sonnet 4.5, have a 200k-token context window" (F1.1221).
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Sonnet 4.5',
    shortName: 'Sonnet',
    description: 'Previous Sonnet generation',
    descriptionKey: 'model.sonnetDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  // UB7.14 (B2-02, OQ-B2.1 (a); upstream v0.15.0 "Claude Sonnet 5.5 and Haiku 5.5")
  // — the FIRST 'Haiku' entry: `getDefaultSummarizationModel()` resolves to it,
  // which is the title/summary default on Anthropic connections. 1M is the
  // documented window (models overview, curled 2026-10-14 by B2: Haiku 5.5 is
  // `claude-haiku-5-5`, 1M tokens, Bedrock `anthropic.claude-haiku-5-5`, Haiku
  // 4.5 legacy). NOT in `isAdaptiveThinkingAlwaysOnModel` — the thinking page
  // gives Haiku 5.5 "accepts `thinking: {type: "disabled"}` at effort `high` or
  // below", so our `off` stays `disabled` (the docs-backed deviation recorded on
  // the row); upstream's own registry row marks it always-on and maps `off` to
  // low-effort adaptive.
  {
    id: 'claude-haiku-5-5',
    name: 'Haiku 5.5',
    shortName: 'Haiku',
    description: 'Fastest for quick answers',
    descriptionKey: 'model.haikuDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Haiku 4.5',
    shortName: 'Haiku',
    description: 'Fastest for quick answers',
    descriptionKey: 'model.haikuDesc',
    provider: 'anthropic',
    contextWindow: 200_000,
  },
  {
    id: 'claude-fable-5',
    name: 'Fable 5',
    shortName: 'Fable',
    description: 'Next-generation model for complex work',
    descriptionKey: 'model.fableDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-fable-5-1',
    name: 'Fable 5.1',
    shortName: 'Fable',
    description: 'Next-generation model for complex work',
    descriptionKey: 'model.fableDesc',
    provider: 'anthropic',
    contextWindow: 1_000_000,
  },

  // ----------------------------------------
  // Pi Models
  // No hardcoded entries — models are discovered dynamically:
  //   - Pi: getModels(provider) from @earendil-works/pi-ai SDK
  // See ModelRefreshService in apps/electron/src/main/model-fetchers/
  // ----------------------------------------
  {
    id: 'nestor-cloud-code-agent',
    name: 'Nestor Cloud Code Agent',
    shortName: 'Nestor Cloud',
    description: 'Nestor cloud A2A code agent',
    provider: 'nestor-cloud-agent',
    contextWindow: 200_000,
    supportsThinking: false,
    supportsImages: false,
  },
];

// ============================================
// PROVIDER-FILTERED EXPORTS
// ============================================

/**
 * Get models filtered by provider.
 */
export function getModelsByProvider(provider: ModelProvider): ModelDefinition[] {
  return MODEL_REGISTRY.filter(m => m.provider === provider);
}

/** All Anthropic Claude models */
export const ANTHROPIC_MODELS = getModelsByProvider('anthropic');


/**
 * Legacy compatibility export.
 * Used by existing code that imports MODELS (expects Claude models only).
 * @deprecated Use ANTHROPIC_MODELS or MODEL_REGISTRY instead
 */
export const MODELS = ANTHROPIC_MODELS;

// ============================================
// MODEL ID HELPERS (Derived from Registry)
// ============================================

/** Get the first model ID matching a short name, or undefined if not found */
function findModelIdByShortName(shortName: string): string | undefined {
  return MODEL_REGISTRY.find(m => m.shortName === shortName)?.id;
}

/** Get the first model ID matching a short name (throws if not found) */
export function getModelIdByShortName(shortName: string): string {
  const id = findModelIdByShortName(shortName);
  if (!id) throw new Error(`Model not found: ${shortName}`);
  return id;
}

// ============================================
// CONNECTION DEFAULTS
// Used ONLY when writing defaults to LLM connection config (not as runtime fallbacks).
// ============================================

/** Default model for Anthropic connections (used when creating/backfilling connections) */
export const DEFAULT_MODEL = getModelIdByShortName('Opus');


// ============================================
// UTILITY MODELS
// ============================================

/**
 * Get the default summarization model ID (Haiku).
 * Used as fallback when no connection context is available
 * (e.g., url-validator, mcp/validation, summarize.ts without modelOverride).
 *
 * For connection-aware summarization model resolution, use
 * getSummarizationModel(connection) from llm-connections.ts instead.
 */
export function getDefaultSummarizationModel(): string {
  return findModelIdByShortName('Haiku') ?? DEFAULT_MODEL;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * The id this registry knows a model by: deprecation-normalized, reverse-mapped
 * out of its Bedrock-native form, then deprecation-normalized AGAIN.
 *
 * The second pass is not belt-and-braces. `DEPRECATED_MODEL_REPLACEMENTS` lists
 * its Bedrock entries once PER GEOGRAPHY PREFIX — and the `global.` row for the
 * dated 4.5 Opus was never added, so `global.anthropic.claude-opus-4-5-…`
 * displayed as "Opus 4.5" while its `us.`/`eu.` twins displayed "Opus 4.8"
 * (measured against the shipped catalog, 2026-08-25). Normalizing the BARE id
 * makes the deprecation table geography-independent, so `au.`, `jp.` and
 * `apac.` are covered without three more rows each.
 */
function toRegistryModelId(modelId: string): string {
  const normalized = normalizeDeprecatedModelId(modelId);
  return normalizeDeprecatedModelId(bedrockNativeToBareModelId(normalized));
}

/**
 * Get a model by ID from the registry.
 * Also handles Bedrock-native IDs (e.g. "anthropic.claude-opus-4-8")
 * by reverse-mapping to the bare Anthropic ID for lookup.
 */
export function getModelById(modelId: string): ModelDefinition | undefined {
  const normalized = normalizeDeprecatedModelId(modelId);
  return MODEL_REGISTRY.find(m => m.id === normalized)
    ?? MODEL_REGISTRY.find(m => m.id === toRegistryModelId(modelId));
}

/**
 * Get display name for a model ID (full name with version).
 */
export function getModelDisplayName(modelId: string): string {
  const model = getModelById(modelId);
  if (model) return model.name;
  // Fallback: normalize deprecated/Bedrock-native IDs, then strip prefix and date suffix
  // e.g., "claude-opus-4-5-20251101" → "Opus 4.8"
  const normalized = toRegistryModelId(modelId);
  const stripped = normalized
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');  // Remove date suffix
  // Split on dashes, capitalize first part, join version parts with dots
  const parts = stripped.split('-');
  const first = parts[0];
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * Get short display name for a model ID (without version number).
 */
export function getModelShortName(modelId: string): string {
  const model = getModelById(modelId);
  if (model) return model.shortName;
  // For provider-prefixed IDs (e.g. "openai/gpt-5"), show just the model part
  if (modelId.includes('/')) {
    return modelId.split('/').pop() || modelId;
  }
  // Fallback: normalize deprecated/Bedrock-native IDs, then humanize (same logic as getModelDisplayName)
  const normalized = toRegistryModelId(modelId);
  const stripped = normalized.replace('claude-', '').replace(/-\d{8}$/, '');
  const parts = stripped.split('-');
  const first = parts[0];
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  const version = parts.slice(1).join('.');
  return version ? `${name} ${version}` : name;
}

/**
 * Get known context window size for a model ID.
 */
export function getModelContextWindow(modelId: string): number | undefined {
  return getModelById(modelId)?.contextWindow;
}

/**
 * Check if model is an Opus model (for cache TTL decisions).
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes('opus');
}

/**
 * Check if a model ID refers to a Claude model.
 * Handles direct Anthropic IDs (e.g. "claude-sonnet-4-6"),
 * provider-prefixed IDs (e.g. "anthropic/claude-sonnet-4" via OpenRouter),
 * and Bedrock-native IDs (e.g. "anthropic.claude-opus-4-8").
 */
export function isClaudeModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('claude-') || lower.includes('/claude') || lower.includes('.claude');
}

/**
 * Models where adaptive thinking is ALWAYS ON and `thinking: { type: 'disabled' }`
 * is rejected by the Messages API: every Fable and Mythos model, Opus 5.5 and
 * Sonnet 5.5. Callers must use adaptive thinking + the `effort` parameter to
 * control depth on these models — there is no way to turn thinking off.
 *
 * Source (F1.1214, re-read 2026-10-01): the per-model table of
 * platform.claude.com/docs/en/build-with-claude/thinking.md gives `"disabled"`
 * as "400 error" for Claude Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1, Fable 5,
 * Mythos 5 and Mythos Preview, and "Thinking off" (accepted) for Opus 5, Sonnet
 * 5, Opus 4.8, Opus 4.7, the 4.6 and 4.5 models and Haiku 4.5 (Opus 5 only at
 * `high` effort or below). Sonnet 5.5's own lowest setting is `between_tools`;
 * adaptive at `low` is the shape every model in this set accepts, so it is the
 * one used here. Matches bare, pi/-prefixed, and Bedrock-native id forms.
 */
export function isAdaptiveThinkingAlwaysOnModel(modelId: string): boolean {
  return /claude-(fable|mythos|opus-5-5|sonnet-5-5)/i.test(modelId);
}


/**
 * Get the provider for a model ID.
 */
export function getModelProvider(modelId: string): ModelProvider | undefined {
  return getModelById(modelId)?.provider;
}
