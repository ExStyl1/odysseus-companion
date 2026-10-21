/**
 * Thinking Level Configuration
 *
 * Six-tier thinking system for extended reasoning:
 * - OFF: No extended thinking (disabled)
 * - Low: Light reasoning, faster responses
 * - Medium: Balanced speed and reasoning (default)
 * - High: Deep reasoning for complex tasks
 * - XHigh: Extra-high reasoning — Anthropic's recommended level for Opus agentic/coding work
 * - Max: Maximum effort reasoning
 *
 * Session-level setting with workspace defaults.
 *
 * Provider mappings:
 * - Anthropic: adaptive thinking + effort levels (current Opus models). On models that
 *   don't accept `xhigh`, the Anthropic SDK silently falls back to `high`.
 * - Pi/OpenAI: reasoning_effort via Pi SDK levels. This line used to say "Pi's
 *   ceiling is `xhigh`, so Nessy's `max` saturates there"; measured against the
 *   installed `@earendil-works/pi-agent-core` 0.84.0, again on 0.84.2, and again
 *   on 0.84.3 (W11-pi, 2026-09-11), that is false — Pi's own
 *   `ThinkingLevel` includes `max`, and Pi narrows PER MODEL through
 *   `clampThinkingLevel`. See `backend/pi/constants.ts`.
 */

import { getModelById } from '../config/models.ts';

/**
 * Ordered list of valid thinking level IDs. Single source of truth — the
 * `ThinkingLevel` type, `THINKING_LEVELS` metadata, the Zod schema in
 * `validators.ts`, and runtime validation/error messages all derive from this.
 *
 * Order is significant: it determines UI ordering (low → max).
 */
export const THINKING_LEVEL_IDS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVEL_IDS)[number];

export interface ThinkingLevelDefinition {
  id: ThinkingLevel;
  /** Translation key for the display name (resolve with t() at render site) */
  nameKey: string;
  /** Translation key for the description (resolve with t() at render site) */
  descriptionKey: string;
}

/**
 * Available thinking levels with display metadata.
 * Used in UI dropdowns and for validation.
 *
 * Labels use translation keys — resolve with t(level.nameKey) in components.
 */
export const THINKING_LEVELS: readonly ThinkingLevelDefinition[] = [
  { id: 'off', nameKey: 'thinking.off', descriptionKey: 'thinking.offDesc' },
  { id: 'low', nameKey: 'thinking.low', descriptionKey: 'thinking.lowDesc' },
  { id: 'medium', nameKey: 'thinking.medium', descriptionKey: 'thinking.mediumDesc' },
  { id: 'high', nameKey: 'thinking.high', descriptionKey: 'thinking.highDesc' },
  { id: 'xhigh', nameKey: 'thinking.xhigh', descriptionKey: 'thinking.xhighDesc' },
  { id: 'max', nameKey: 'thinking.max', descriptionKey: 'thinking.maxDesc' },
] as const;

/** Default thinking level for new sessions when workspace has no default */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

/**
 * Map ThinkingLevel to Anthropic SDK effort parameter.
 * Used with adaptive thinking (thinking: { type: 'adaptive' }).
 * Returns null for 'off' (thinking should be disabled entirely).
 */
export const THINKING_TO_EFFORT: Record<ThinkingLevel, 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null> = {
  off: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/**
 * Token budgets per model family.
 * Used as fallback for models that don't support adaptive thinking
 * (e.g., non-Claude models via OpenRouter/Ollama).
 *
 * Haiku max is 8k per Anthropic docs.
 * Sonnet/Opus can use up to 128k, but Anthropic recommends ≤32k for real-time use
 * (above 32k, batch processing is suggested to avoid timeouts).
 */
const TOKEN_BUDGETS = {
  haiku: {
    off: 0,
    low: 2_000,
    medium: 4_000,
    high: 6_000,
    xhigh: 7_000,
    max: 8_000,
  },
  default: {
    off: 0,
    low: 4_000,
    medium: 10_000,
    high: 20_000,
    xhigh: 26_000,
    max: 32_000,
  },
} as const;

/**
 * Get the thinking token budget for a given level and model.
 * Used as fallback for models that don't support adaptive thinking.
 *
 * @param level - The thinking level
 * @param modelId - The model ID (e.g., 'claude-haiku-4-5-20251001')
 * @returns Number of thinking tokens to allocate
 */
export function getThinkingTokens(level: ThinkingLevel, modelId: string): number {
  const isHaiku = modelId.toLowerCase().includes('haiku');
  const budgets = isHaiku ? TOKEN_BUDGETS.haiku : TOKEN_BUDGETS.default;
  return budgets[level];
}

/**
 * Get the translation key for a thinking level's display name.
 * Resolve with t() or i18n.t() at the call site.
 */
export function getThinkingLevelNameKey(level: ThinkingLevel): string {
  const def = THINKING_LEVELS.find((l) => l.id === level);
  return def?.nameKey ?? `thinking.${level}`;
}

/**
 * Validate that a value is a valid ThinkingLevel.
 */
export function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVEL_IDS as readonly string[]).includes(value);
}

/**
 * Normalize a persisted thinking level value, handling legacy values.
 * Maps the old 'think' value to 'medium' for backward compatibility.
 *
 * TODO: Remove the legacy 'think' compatibility path after old persisted session
 * and workspace data has realistically aged out across upgrades.
 *
 * @returns The normalized ThinkingLevel, or undefined if the value is invalid
 */
export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === 'think') return 'medium';
  if (isValidThinkingLevel(value)) return value;
  return undefined;
}

/**
 * P6.30 · the DOCUMENTED ENVIRONMENT TIER, which this file implemented every
 * layer of except the top one.
 *
 * `model-config.md#set-the-effort-level` lists the environment variable among
 * the ways to change effort — "**Environment variable**: set
 * `CLAUDE_CODE_EFFORT_LEVEL` to a level name or `auto`" — and then ranks it:
 * "The environment variable takes precedence over all other methods, then your
 * configured level, then the model default. Frontmatter effort applies when
 * that skill or subagent is active, overriding the session level but not the
 * environment variable."
 *
 * `model-config.md#extended-thinking` adds the off switch, and it outranks the
 * effort level rather than sitting beside it — "Disable regardless of effort:
 * Set `MAX_THINKING_TOKENS=0`, which turns thinking off on the Anthropic API
 * except on Fable 5. On third-party providers this omits the `thinking`
 * parameter instead, and adaptive-reasoning models may still think."
 *
 * ## Why the HOST reads these rather than each runtime
 *
 * Native-first asks whether the runtime already has its own mechanism. Measured
 * 2026-08-28, with a positive and a negative control on each rig:
 *
 * | runtime | reads `CLAUDE_CODE_EFFORT_LEVEL` / `MAX_THINKING_TOKENS` |
 * | --- | --- |
 * | claude | **yes** — 17 and 9 occurrences in the vendored `claude` binary (`ANTHROPIC_API_KEY` 170 as the positive control, a fabricated name 0 as the negative) |
 * | pi | **no** — 0 in every `@earendil-works/*` package, and the SDK's ENTIRE `process.env` surface across `pi-ai`, `pi-agent-core`, `pi-coding-agent` and `pi-protocol` contains no effort/thinking/reasoning variable of any spelling |
 * | codex | **no** — 0 in the bundled `codex-app-server` (`CODEX_HOME` 36 and `model_reasoning_effort` 18 as positive controls, a fabricated name 0) |
 *
 * So the answer is not "we never enabled what Pi has": Pi and codex have
 * nothing to enable. The variables ARRIVE on both — `buildPiSubprocessEnv` and
 * the codex spawn both inherit the host environment — and are read by nobody,
 * which is an operator control that silently stops controlling on two of three
 * runtimes and changes meaning under a runtime switch. The host is the seam
 * that can answer identically for all three, so it answers here.
 *
 * ENFORCEMENT IS ONE LAYER UP, in `BaseAgent.setThinkingLevel` — deliberately,
 * because "takes precedence over all other methods" means every writer of the
 * session level, not just the ones that happen to call {@link resolveEffortLevel}.
 * Putting a second copy of the rule into that resolver would be exactly the
 * two-halves-of-one-sentence drift its own header records.
 */
export const EFFORT_LEVEL_ENV_VAR = 'CLAUDE_CODE_EFFORT_LEVEL';
/** @see EFFORT_LEVEL_ENV_VAR */
export const MAX_THINKING_TOKENS_ENV_VAR = 'MAX_THINKING_TOKENS';

/** A level the environment pinned, plus which variable pinned it (for the diagnostic). */
export interface EnvironmentThinkingOverride {
  level: ThinkingLevel;
  variable: typeof EFFORT_LEVEL_ENV_VAR | typeof MAX_THINKING_TOKENS_ENV_VAR;
  /** The raw value as the operator wrote it, so a diagnostic can quote it back. */
  value: string;
}

/**
 * The level the environment pins for `modelId`, or `undefined` when it pins
 * none.
 *
 * `undefined` is the overwhelmingly common answer — neither variable is set on
 * a normal machine — and it must stay byte-for-byte equivalent to the behaviour
 * before this function existed. Every caller therefore treats `undefined` as
 * "the environment has no opinion", never as a level.
 *
 * Three deliberate narrowings, each recorded rather than guessed:
 *
 *  - **`MAX_THINKING_TOKENS` is honoured for the value `0` only.** The page
 *    gives `0` a meaning ("Disable regardless of effort") and says every other
 *    value "appl[ies] only with a fixed thinking budget", which is a mode this
 *    host does not expose. A non-zero value is therefore left alone rather than
 *    reinterpreted as a level.
 *  - **`auto` resolves to the MODEL default**, which is what the page means by
 *    "`/effort auto` to reset to the model default" and by "then the model
 *    default" in the precedence sentence. It is not the same as unset: unset
 *    lets the configured level win, `auto` outranks it.
 *  - **An unrecognised value pins nothing.** `ultracode` is named by the page as
 *    a value this variable does not accept, and an arbitrary typo must not
 *    silently become an effort level. The caller reports it; it never guesses.
 *
 * `off` is accepted even though the page does not list it, because it is our own
 * sixth level and refusing an operator the one value that means "no reasoning"
 * would be a narrowing we invented.
 */
export function environmentThinkingOverride(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): EnvironmentThinkingOverride | undefined {
  const maxThinkingTokens = env[MAX_THINKING_TOKENS_ENV_VAR]?.trim();
  if (maxThinkingTokens === '0') {
    return { level: 'off', variable: MAX_THINKING_TOKENS_ENV_VAR, value: maxThinkingTokens };
  }

  const raw = env[EFFORT_LEVEL_ENV_VAR]?.trim();
  if (!raw) return undefined;

  const normalized = raw.toLowerCase();
  if (normalized === 'auto') {
    return {
      level: getModelDefaultThinkingLevel(modelId) ?? DEFAULT_THINKING_LEVEL,
      variable: EFFORT_LEVEL_ENV_VAR,
      value: raw,
    };
  }

  const level = normalizeThinkingLevel(normalized);
  return level ? { level, variable: EFFORT_LEVEL_ENV_VAR, value: raw } : undefined;
}

/**
 * The reason an environment value was ignored, or `undefined` when there is
 * nothing to say.
 *
 * Split from {@link environmentThinkingOverride} so the honest-null case is
 * still LOUD: an operator who exports `CLAUDE_CODE_EFFORT_LEVEL=ultracode` gets
 * a line naming the value and the accepted set, rather than a session that
 * quietly runs at the configured level. A silently ignored control is the
 * failure mode this row exists to close, and "we ignored it correctly" is only
 * better than "we ignored it" if somebody can see it.
 */
export function environmentThinkingOverrideRejection(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[EFFORT_LEVEL_ENV_VAR]?.trim();
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === 'auto' || normalizeThinkingLevel(normalized)) return undefined;
  return `${EFFORT_LEVEL_ENV_VAR}="${raw}" is not a level this host accepts`
    + ` (${THINKING_LEVEL_IDS.join(', ')}, or auto); the configured effort level is used instead`;
}

/**
 * C3.167 (QK6) — the operator's PLAN-PHASE effort, and the one name all three
 * runtimes answer to.
 *
 * ## Why the name lives here now
 *
 * P6.368 invented `NESSY_PLAN_MODE_EFFORT` for codex, where it is spent as
 * codex's own `plan_mode_reasoning_effort` key (`codex-responses-adapter`'s
 * `writeCodexConfig`), and declared it privately in `codex-agent.ts` with the
 * reason *"it has exactly one reader and one writer"*. C3.167 gives it a second
 * reader — Pi, which has no native plan-mode effort at all — so the constant is
 * promoted to the module that already owns `CLAUDE_CODE_EFFORT_LEVEL` and
 * `MAX_THINKING_TOKENS`. Two spellings of one operator control is the drift
 * every other note in this file was written to prevent.
 *
 * The name is still OURS and still says so: `env-vars.md#variables` documents no
 * plan-mode effort variable, the vendored binary carries no
 * `CLAUDE_CODE_PLAN_MODE_EFFORT`, and claude's plan-mode lever is a MODEL alias
 * (`opusplan`) rather than an effort — so there is no vendor contract to be
 * compatible with and no `CLAUDE_CODE_` spelling is offered, which would claim
 * one that does not exist.
 *
 * ## The contract, identical on both runtimes that read it
 *
 * Unset, or set to anything that is not one of the six level words, answers
 * `undefined` and NOTHING changes: codex omits its key and keeps its own
 * plan-mode behaviour, Pi keeps the session's level. It deliberately does not
 * fall back to the session's execution effort, which would be this session's own
 * level under a second name — a no-op dressed as a setting.
 */
export const PLAN_MODE_EFFORT_ENV_VAR = 'NESSY_PLAN_MODE_EFFORT';

/**
 * The plan-phase level {@link PLAN_MODE_EFFORT_ENV_VAR} names, or `undefined`.
 *
 * `onRejected` is called with the raw value when it is set but unrecognised, so
 * each caller can route the refusal to the channel its own operator reads
 * (`CodexAgent.debug`, `PiAgent.debug`) rather than this module inventing a
 * third one. A refusal is never a silent default: that is the same rule
 * {@link environmentThinkingOverrideRejection} exists for.
 */
export function planModeEffortLevel(
  env: Record<string, string | undefined> = process.env,
  onRejected?: (raw: string) => void,
): ThinkingLevel | undefined {
  const raw = env[PLAN_MODE_EFFORT_ENV_VAR];
  if (raw === undefined) return undefined;
  const level = normalizeThinkingLevel(raw.trim());
  if (!level) {
    onRejected?.(raw);
    return undefined;
  }
  return level;
}

/** Inputs to {@link resolveEffortLevel}, most explicit first. */
export interface EffortPrecedenceInput {
  /**
   * The session's own level. `undefined` means the session never set one, which
   * is NOT the same fact as a session that chose `off`.
   */
  session?: ThinkingLevel | undefined;
  /** Frontmatter `effort` on the skill or subagent definition. */
  declared?: ThinkingLevel | undefined;
  /**
   * Per-invocation `effort` argument — the workflow DSL's `agent({ effort })`.
   * Nessy-only; the docs give no per-invocation effort parameter.
   */
  invocation?: ThinkingLevel | undefined;
  /** What an unset session resolves to. Defaults to {@link DEFAULT_THINKING_LEVEL}. */
  fallback?: ThinkingLevel;
}

/**
 * Effort precedence for a delegated run — the ONE resolver behind skill
 * frontmatter, subagent frontmatter and the per-invocation `effort` argument.
 *
 * `model-config.md:504` — "**Skill and subagent frontmatter**: set `effort` in a
 * skill or subagent markdown file to override the effort level when that skill
 * or subagent runs". `model-config.md:506` — "Frontmatter effort applies when
 * that skill or subagent is active, overriding the session level but not the
 * environment variable." Both frontmatter tables repeat it in the same words:
 * `sub-agents.md:289` and `skills.md:268`, "Overrides the session effort level.
 * Default: inherits from session."
 *
 * OVERRIDE, IN BOTH DIRECTIONS. A declared level replaces the session's whether
 * it is lower or higher — a subagent declaring `max` under a session at `low`
 * runs at `max`. The documented rule states no floor and no ceiling. The
 * downward-only clamp this replaced meant a subagent written to think harder
 * than its parent silently ran at the parent's level, and the skill half of the
 * same sentence never had that bug, so the two halves of one rule disagreed
 * inside one codebase.
 *
 * `invocation` outranks `declared` by the same order model resolution already
 * uses: `sub-agents.md:310` resolves "the per-invocation `model` parameter, then
 * the frontmatter", and `resolveAgentModelId` follows it.
 *
 * WHAT THIS DOES NOT DO: narrow the answer to what the active model can run.
 * That is {@link clampThinkingLevelToModel}, a separate rule
 * (`model-config.md:452`) that only ever LOWERS. Keeping the two apart is
 * deliberate: folding a narrowing rule into this one is exactly how the
 * documented override became a clamp the first time.
 */
export function resolveEffortLevel(input: EffortPrecedenceInput): ThinkingLevel {
  return input.invocation
    ?? input.declared
    ?? input.session
    ?? input.fallback
    ?? DEFAULT_THINKING_LEVEL;
}

/**
 * Effort levels a model family cannot run, from the per-model table at
 * `model-config.md:444`–`:450`.
 *
 * DELIBERATELY PARTIAL. Only families we positively know to be narrower appear
 * here. `:444` says "Models not listed here do not support effort", but Nessy
 * runs unlisted models — Haiku on a fixed token budget (`getThinkingTokens`),
 * and every dynamically discovered Pi/gateway model — so reading that sentence
 * as "unlisted ⇒ `off`" would silently disable reasoning on models that
 * demonstrably reason. An absent entry therefore means "not known to be
 * narrower", and the level passes through unchanged.
 */
const NARROWED_EFFORT_MODELS: readonly { readonly match: RegExp; readonly unsupported: readonly ThinkingLevel[] }[] = [
  // `:450` — Opus 4.6 and Sonnet 4.6 run `low`, `medium`, `high`, `max`. `:452`'s
  // own worked example is "`xhigh` runs as `high` on Opus 4.6". Matches bare,
  // slash-prefixed and Bedrock-native (`anthropic.claude-…`) id forms.
  { match: /claude[-.](opus|sonnet)-4-6/i, unsupported: ['xhigh'] },
];

/**
 * `model-config.md:452` — "If you set a level the active model does not support,
 * Claude Code falls back to the highest supported level at or below the one you
 * set. For example, `xhigh` runs as `high` on Opus 4.6."
 *
 * NARROWS ONLY. This never raises a level, and it is never the thing that
 * decides WHICH level was asked for — {@link resolveEffortLevel} does that. Two
 * different rules, kept in two functions on purpose.
 */
export function clampThinkingLevelToModel(level: ThinkingLevel, modelId: string): ThinkingLevel {
  const entry = NARROWED_EFFORT_MODELS.find(candidate => candidate.match.test(modelId));
  if (!entry || !entry.unsupported.includes(level)) return level;
  const unsupported = new Set<ThinkingLevel>(entry.unsupported);
  // "the highest supported level at or below the one you set". `off` is index 0
  // and is never listed as unsupported, so this always terminates.
  for (let index = THINKING_LEVEL_IDS.indexOf(level) - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVEL_IDS[index]!;
    if (!unsupported.has(candidate)) return candidate;
  }
  return 'off';
}

/**
 * Per-model DEFAULT effort, from `model-config.md#adjust-effort-level` (step 3
 * of the resolution order, re-read 2026-10-01 for F1.1214) — "The model's
 * default effort: `high` on every model that supports effort, except that Opus
 * 5.5 and Sonnet 5.5 default to `medium`, Opus 4.7 defaults to `xhigh`, and,
 * when your organization sets a default effort level for its organization
 * default model, that level is the default when you run that model." The
 * organization clause has no Nessy equivalent (no organization default model
 * reaches this host), so it has no row.
 *
 * A SIBLING of {@link NARROWED_EFFORT_MODELS}, never folded into it and never
 * folded into {@link resolveEffortLevel}: this table SUPPLIES a level when
 * nothing above it did, the narrowing table LOWERS one that was already chosen,
 * and {@link resolveEffortLevel} decides which of the explicit tiers answered.
 * Three rules, three places — the comment above `resolveEffortLevel` records
 * what merging two of them cost the first time.
 *
 * DELIBERATELY PARTIAL, by the same convention the narrowing table documents:
 * an id with no entry returns `undefined`, and the caller lands on
 * {@link DEFAULT_THINKING_LEVEL}. That is the load-bearing case here — every
 * dynamically discovered Pi/gateway model is absent from the `:443`–`:450`
 * tables, so their effort is exactly what it was before this table existed.
 *
 * Matches bare, slash-prefixed and Bedrock-native (`anthropic.claude-…`) id
 * forms, the way `NARROWED_EFFORT_MODELS` already does.
 */
const MODEL_DEFAULT_EFFORT: readonly { readonly match: RegExp; readonly level: ThinkingLevel }[] = [
  // The exceptions are listed first so the generic row below can never shadow
  // them (its `opus-5` and `sonnet-5` prefixes also match the 5.5 ids).
  { match: /claude[-.]opus-4-7/i, level: 'xhigh' },
  { match: /claude[-.](opus|sonnet)-5-5/i, level: 'medium' },
  // Every other model the page's effort-levels table lists: Fable 5.1 and Fable 5
  // (the `fable-5` prefix), Opus 5, Sonnet 5, Opus 4.8, Opus 4.6 and Sonnet 4.6.
  // `high` is inside every one of those rows' level sets, so no entry here ever
  // needs `clampThinkingLevelToModel` to rescue it.
  { match: /claude[-.](fable-5|opus-5|sonnet-5|opus-4-8|opus-4-6|sonnet-4-6)/i, level: 'high' },
];

/**
 * The `:453` default for one model, or `undefined` when the model is not one of
 * the documented effort-capable families.
 *
 * `undefined` is not "no opinion about reasoning" — it is "this page says
 * nothing about this model", and the caller must fall through to
 * {@link DEFAULT_THINKING_LEVEL}.
 */
export function getModelDefaultThinkingLevel(modelId: string): ThinkingLevel | undefined {
  if (!modelId) return undefined;
  return MODEL_DEFAULT_EFFORT.find(candidate => candidate.match.test(modelId))?.level;
}

/**
 * `model-config.md#adjust-effort-level` (re-read 2026-10-01, F1.1214) — "Opus
 * 5.5 starts at `medium` unless one of the sources above sets a level for it,
 * and a top-level `effortLevel` in your user settings file doesn't count for
 * Opus 5.5. That key is the older form `/effort` wrote before Claude Code saved
 * levels per model: it keeps applying where it applied before, on Opus 5, Fable
 * 5.1, and earlier models, while Opus 5.5 and models released after it start at
 * their own default until you choose a level for them with `/effort` or the
 * `/model` picker."
 *
 * Two documented holds, one list (F1.1214). Nessy's mapping: the user's
 * configured default that predates an explicit choice is the "older form" (the
 * user-settings top-level `effortLevel`); it is the ONLY thing this hold
 * outranks, since every explicit setter releases it.
 *
 * 1. Opus 5.5 and Sonnet 5.5 (added in 2.1.28x) start at their own default over
 *    it — the page above, and Claude Code 2.1.280's changelog: "Changed an
 *    effort level saved before `/effort` became per-model to no longer apply to
 *    newly released models such as Opus 5.5; they start at their default until
 *    you pick a level".
 * 2. Fable 5, Opus 4.8 and Opus 4.7 KEEP their launch-default hold over it. The
 *    same release only NARROWED that hold, in full: "Changed Opus 4.7, Opus 4.8
 *    and Fable 5 to stop holding their launch-default effort over `/effort` in
 *    `-p` or the Agent SDK, a project, managed or `--settings` `effortLevel`, or
 *    a per-model level". The user-settings older form is not on that list, and
 *    the page keeps it applying only "where it applied before" — on these three
 *    it did not, they held their default. (A first F1.1214 pass quoted the line
 *    without its "over …" clause and dropped them; that was a misreading.)
 *
 * Fable 5.1 is named as keeping the older level, so the `fable-5` row is
 * anchored to refuse `fable-5-1` (and any `fable-5-<digit>` successor).
 * Residue: Nessy releases the hold on ANY explicit choice (the existing global
 * flag), where the page releases it per model; a later model needs a row here.
 *
 * A SEPARATE LIST from {@link MODEL_DEFAULT_EFFORT}: that table gives every
 * effort-capable model a default, this one names the models whose default
 * OUTRANKS a previously-stored level. Merging them is the mistake this
 * comment exists to prevent.
 */
const MODEL_DEFAULT_EFFORT_HOLD: readonly RegExp[] = [
  /claude[-.]opus-5-5/i,
  /claude[-.]sonnet-5-5/i,
  /claude[-.]fable-5(?![-.]\d)/i,
  /claude[-.]opus-4-8/i,
  /claude[-.]opus-4-7/i,
];

/**
 * The level the hold above would assert for this model, or `undefined` when the
 * model has no hold. Whether a hold is IN FORCE is a persisted fact and lives
 * in `config/storage.ts` — this function only answers "is this model on the
 * list, and what is its default".
 */
export function getHeldModelDefaultThinkingLevel(modelId: string): ThinkingLevel | undefined {
  if (!modelId) return undefined;
  if (!MODEL_DEFAULT_EFFORT_HOLD.some(candidate => candidate.test(modelId))) return undefined;
  return getModelDefaultThinkingLevel(modelId);
}

/**
 * The effort level to REPORT for a turn, or `undefined` when there is none to
 * report.
 *
 * hooks.md `:707` scopes the hook input's `effort` field twice over: it is
 * present only "when the current model supports the effort parameter", and when
 * it is present it holds "the downgraded level the model actually used", not
 * the requested one. Both narrowings live here so the hook input, the
 * `$CLAUDE_EFFORT` hook environment and the Bash-tool child environment can
 * never answer differently.
 *
 * Returns `undefined` in exactly two cases, and neither may become a default:
 *
 * 1. `off` — Nessy's sixth level, which the page does not list. No effort
 *    parameter is sent to the model at all, so there is no level to name. Same
 *    withholding rule the skills path already uses
 *    (`BaseAgent.runtimeSkillHostContext`).
 * 2. `supportsThinking === false` on the model's registry entry — Nessy's own
 *    "this model has no effort control" signal, the one the `/model` UI already
 *    hides the effort picker on.
 *
 * An ABSENT registry entry is NOT case 2. `supportsThinking` is documented as
 * defaulting to true when undefined, and every dynamically discovered Pi and
 * gateway model is absent from the static registry — reading absence as
 * "unsupported" would silently withhold the field on the default runtime, which
 * is the population the field exists for.
 */
export function activeEffortLevelForModel(
  level: ThinkingLevel,
  modelId: string,
): Exclude<ThinkingLevel, 'off'> | undefined {
  if (level === 'off') return undefined;
  if (getModelById(modelId)?.supportsThinking === false) return undefined;
  const clamped = clampThinkingLevelToModel(level, modelId);
  return clamped === 'off' ? undefined : clamped;
}
