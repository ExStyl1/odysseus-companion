/**
 * P3.268 — THE MODEL CAPABILITY SELF-REPORT THE RUNTIME ALREADY SENDS US.
 *
 * `resolveClaudeThinkingOptions` decided three things by string-matching the
 * model id — `isClaudeModel(model) && !model.includes('haiku')` — while the SDK
 * declares the answers on `ModelInfo`:
 *
 * | question | the host's string match | the runtime's own field |
 * | --- | --- | --- |
 * | may this model take adaptive thinking? | `isClaude && !isHaiku` | `supportsAdaptiveThinking` |
 * | may it take an effort level at all? | inferred from the same test | `supportsEffort` |
 * | WHICH effort levels? | assumed to be all five | `supportedEffortLevels` |
 * | fast mode? | never asked | `supportsFastMode` |
 *
 * Native-first: this module does not compute a capability. It records what the
 * runtime says and answers lookups from that, so the host keeps exactly one
 * decision — *"what do we do when the runtime has not told us"*.
 *
 * ## Where the rows come from, and why they are free
 *
 * `Query.supportedModels()` is not a round trip. Measured on the shipped bundle
 * at 0.3.233: `async supportedModels(){return(await this.initialization).models}`
 * — the rows ride the `initialize` control response every session already waits
 * for. `SDKControlListModelsRequest`'s own description says why the list is
 * worth reading rather than deriving: *"in a remote thin-client session the
 * worker's provider, settings cascade, and enforcement policy decide which
 * models the session can run, so the thin client must ask rather than read its
 * own getModelOptions()"*.
 *
 * ## Why a cache and not a call at the point of use
 *
 * The thinking options are built BEFORE the child exists — they are part of the
 * `query()` argument. So the first turn of the first session on a given model
 * has no self-report and falls back to the string match; the rows land during
 * that turn and every later turn reads them. The fallback is not a hedge, it is
 * the only answer available at that moment, and {@link lookupClaudeModelCapabilities}
 * returning `undefined` is how the caller knows which one it used.
 *
 * ## The case this exists for is the one the string match cannot see
 *
 * A gateway or BYO model (`tgpt/qwen35-397b-a17b-fp8`) is not in the runtime's
 * list at all, so a lookup misses and nothing changes — deliberately. The rows
 * that DO arrive describe the models the CLI itself will serve, which is exactly
 * the set the string match was guessing about.
 *
 * Process-scoped rather than per-agent: a model's capabilities are a property of
 * the model, and two sessions on one model would otherwise ask twice and could
 * disagree. {@link resetClaudeModelCapabilities} exists for tests only.
 */

/** The four capability fields of the SDK's `ModelInfo`, as read back. */
export interface ClaudeModelCapabilityRow {
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: readonly string[];
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
}

/**
 * The shape we read off `ModelInfo`. Declared structurally rather than imported
 * so this module does not depend on the SDK's type surface moving — the fields
 * are all optional on the SDK side too, and an absent field means *the runtime
 * did not say*, never *no*.
 */
interface ClaudeModelInfoLike {
  value?: unknown;
  resolvedModel?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
  supportsAdaptiveThinking?: unknown;
  supportsFastMode?: unknown;
}

const CAPABILITIES = new Map<string, ClaudeModelCapabilityRow>();

/**
 * The `[1m]` suffix is a MODEL SELECTOR, not a different model.
 *
 * `claude-agent.ts` appends it to opt a 1M-window model into the beta, so the
 * string that reaches `options.model` is not the string the runtime lists. The
 * suffix is stripped before every lookup and before every store, so the two
 * spellings resolve to one row instead of silently missing each other.
 */
function normalizeModelKey(model: string): string {
  const trimmed = model.trim();
  const suffix = trimmed.indexOf('[');
  return (suffix > 0 ? trimmed.slice(0, suffix) : trimmed).toLowerCase();
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  // An EMPTY array is not "no levels" — it is a shape we cannot act on, and
  // treating it as a ceiling would refuse every effort level on that model.
  return entries.length > 0 ? entries : undefined;
}

/**
 * Record what the runtime said. Returns how many models carried at least one of
 * the four fields, which is what the caller logs — a list that arrives with the
 * capability fields absent is a real state (an older CLI) and must be
 * distinguishable from a list that never arrived.
 *
 * Rows are keyed by BOTH `value` and `resolvedModel`. `ModelInfo.resolvedModel`
 * is documented as the reason: *"Canonical wire model id this row's `value`
 * resolves to (e.g. 'sonnet' → 'claude-sonnet-5'). Lets hosts match a persisted
 * explicit id against the alias row that covers it."* — a session persists the
 * explicit id and the runtime lists the alias, so keying on one of them alone
 * misses half the time. An alias row never overwrites an explicit row.
 */
export function recordClaudeModelCapabilities(models: readonly unknown[]): number {
  let informative = 0;
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const info = raw as ClaudeModelInfoLike;
    const row: ClaudeModelCapabilityRow = {
      ...(booleanOrUndefined(info.supportsEffort) === undefined ? {} : { supportsEffort: booleanOrUndefined(info.supportsEffort) }),
      ...(stringArrayOrUndefined(info.supportedEffortLevels) === undefined ? {} : { supportedEffortLevels: stringArrayOrUndefined(info.supportedEffortLevels) }),
      ...(booleanOrUndefined(info.supportsAdaptiveThinking) === undefined ? {} : { supportsAdaptiveThinking: booleanOrUndefined(info.supportsAdaptiveThinking) }),
      ...(booleanOrUndefined(info.supportsFastMode) === undefined ? {} : { supportsFastMode: booleanOrUndefined(info.supportsFastMode) }),
    };
    if (Object.keys(row).length === 0) continue;
    informative += 1;

    const value = typeof info.value === 'string' ? info.value : null;
    const resolved = typeof info.resolvedModel === 'string' ? info.resolvedModel : null;
    if (value) CAPABILITIES.set(normalizeModelKey(value), row);
    // The canonical id only if nothing explicit already claimed it: two aliases
    // can resolve to one wire id, and the last one written would otherwise win
    // arbitrarily.
    if (resolved && !CAPABILITIES.has(normalizeModelKey(resolved))) {
      CAPABILITIES.set(normalizeModelKey(resolved), row);
    }
  }
  return informative;
}

/** `undefined` means THE RUNTIME HAS NOT TOLD US — never "no". */
export function lookupClaudeModelCapabilities(model: string | undefined | null): ClaudeModelCapabilityRow | undefined {
  if (typeof model !== 'string' || model.trim().length === 0) return undefined;
  return CAPABILITIES.get(normalizeModelKey(model));
}

/** Tests only. Production never forgets a capability it was told. */
export function resetClaudeModelCapabilities(): void {
  CAPABILITIES.clear();
}

/**
 * Clamp a requested effort level to what the model says it accepts.
 *
 * The reason this is not cosmetic is in `thinking-levels.ts`'s own header:
 * *"On models that don't accept `xhigh`, the Anthropic SDK silently falls back
 * to `high`."* A silent fallback is a divergence with no reporter — the user
 * asked for one level and got another. When the runtime has published
 * `supportedEffortLevels`, this returns the highest supported level at or below
 * the request, so the degradation is decided here, once, where it can be logged.
 *
 * Returns the input unchanged when the runtime published nothing, and `null`
 * when it published `supportsEffort: false` — the caller must then not send an
 * effort at all.
 */
export function clampClaudeEffortLevel(
  requested: string,
  capabilities: ClaudeModelCapabilityRow | undefined,
  order: readonly string[],
): string | null {
  if (!capabilities) return requested;
  if (capabilities.supportsEffort === false) return null;
  const supported = capabilities.supportedEffortLevels;
  if (!supported || supported.includes(requested)) return requested;

  const requestedRank = order.indexOf(requested);
  if (requestedRank < 0) return requested;
  let best: string | null = null;
  let bestRank = -1;
  for (const level of supported) {
    const rank = order.indexOf(level);
    if (rank < 0 || rank > requestedRank) continue;
    if (rank > bestRank) { bestRank = rank; best = level; }
  }
  // Nothing at or below the request: the model supports only HIGHER levels,
  // which no clamp can honour downward. Send the lowest it does support rather
  // than an unsupported one — the runtime would otherwise pick for us in
  // silence.
  if (best === null) {
    let lowest: string | null = null;
    let lowestRank = Number.POSITIVE_INFINITY;
    for (const level of supported) {
      const rank = order.indexOf(level);
      if (rank >= 0 && rank < lowestRank) { lowestRank = rank; lowest = level; }
    }
    return lowest;
  }
  return best;
}
