/**
 * The cost-reporting verdict: merging it across a session's turns, and
 * resolving what a cost surface is allowed to render.
 *
 * The problem this solves is one shape of defect, not one field. `costUsd` is a
 * plain accumulating number, and the session layer used to add `?? 0` for a
 * backend that reported nothing. The persisted record then said `costUsd: 0`,
 * which is what a genuinely free turn also says — a surface stating something
 * the backend never established. Codex reports no cost at all, and neither the
 * Nessy Gateway nor Nestor Cloud returns one, so that zero covered most of the
 * backends this fork actually ships.
 *
 * Silence is therefore read as "unsupported", never as zero: a backend that
 * cannot report cost needs no code of its own for the marker to be correct.
 */

import type {
  CostReporting,
  PersistedModelUsage,
  TokenUsage,
  TurnCostReporting,
} from '@nessy-agent/core/types';

/**
 * P2.239 — ONE TURN'S VERDICT, COLLAPSED ONCE.
 *
 * `x === 'reported' ? 'reported' : 'unsupported'` was written THREE times with
 * no exported normalizer — here and twice in `SessionManager` — and reasoning
 * about a rule written three times means reading three places to know what it
 * does. OQ-7 spent two rounds on exactly this collapse, so it is a name now.
 *
 * ## Why the collapse is right, and why it is not the same as {@link CostReporting}
 *
 * A TURN's verdict is two-valued ({@link TurnCostReporting}): a backend either
 * priced this turn or it did not. `partial` is a property of an ACCUMULATION —
 * "some turns priced, some did not" — which is {@link mergeCostReporting}'s job
 * and cannot arise from one turn. So everything that is not `reported` folds to
 * `unsupported`, INCLUDING a `partial` that a backend should never have stamped
 * on a single turn: silence and nonsense are both read as "not established",
 * never as zero, which is the whole posture of this module.
 *
 * Takes `unknown` on purpose. Two of the three call sites read the field off a
 * wire-shaped object where the value is only as trustworthy as the backend that
 * stamped it, and a normalizer that has to be handed an already-narrowed type
 * is one the untrusted sites cannot use.
 */
export function toTurnCostReporting(value: unknown): TurnCostReporting {
  return value === 'reported' ? 'reported' : 'unsupported';
}

/**
 * Fold one turn's verdict into the session's.
 *
 * Two agreeing turns keep their verdict; two disagreeing turns become `partial`,
 * and `partial` absorbs everything after it — a total that was ever incomplete
 * stays incomplete.
 */
export function mergeCostReporting(
  previous: CostReporting | undefined,
  turn: TurnCostReporting,
): CostReporting {
  if (previous === undefined) return turn;
  if (previous === 'partial' || previous !== turn) return 'partial';
  return previous;
}

/** An empty per-model accumulator. */
function emptyModelUsage(): PersistedModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    costReporting: 'unsupported',
  };
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * F1.1279 — the id a per-model usage entry is recorded, stored and shown under.
 *
 * The owner's F1.1241 constraint: the `[1m]` selector is an adapter detail that
 * lives only in the id handed to the Claude child, and model names stay the
 * same across runtimes. The SDK keys `modelUsage` by that wire id
 * (`claude-opus-4-8[1m]`), so without this the stored breakdown carried the
 * suffix, and a model reported under both spellings split into two lines.
 *
 * The exact inverse of `claudeModelWithWindowSelector` (`claude-agent.ts`): only
 * a `claude-` id (any casing) loses its trailing selector, sliced at the first
 * `[` like `stripClaudeModelSelectorSuffix`. Any other id is returned exactly as
 * written — a gateway or BYO model keeps its own spelling, brackets and case
 * included. Not the event adapter's `normalizeContextModelKey`: that one
 * case-folds and strips a bracket from ANY id, which is right for an equality
 * test and wrong for a key that is stored and rendered (and the renderer cannot
 * import the adapter).
 */
export function usageModelKey(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.toLowerCase().startsWith('claude-')) return model;
  const selector = trimmed.indexOf('[');
  return selector > 0 ? trimmed.slice(0, selector) : trimmed;
}

/** The per-model fields `foldModelUsageKeys` sums; loose so a renderer's partial shape folds too. */
interface ModelUsageCounters {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  webSearchRequests?: number;
  costUsd?: number;
  costReporting?: string;
}

/**
 * F1.1279 — a per-model map re-keyed by {@link usageModelKey}, entries that
 * land on one key summed field by field. Two verdicts that disagree become
 * `partial`, the session-level meaning of "some of this was priced". A map
 * with nothing to fold comes back with the same entries.
 */
export function foldModelUsageKeys<T extends ModelUsageCounters>(map: Record<string, T>): Record<string, T> {
  const folded: Record<string, T> = {};
  for (const [model, usage] of Object.entries(map)) {
    const key = usageModelKey(model);
    const before = folded[key];
    if (!before) {
      folded[key] = usage;
      continue;
    }
    folded[key] = {
      ...before,
      inputTokens: nonNegative(before.inputTokens) + nonNegative(usage.inputTokens),
      outputTokens: nonNegative(before.outputTokens) + nonNegative(usage.outputTokens),
      cacheReadTokens: nonNegative(before.cacheReadTokens) + nonNegative(usage.cacheReadTokens),
      cacheCreationTokens: nonNegative(before.cacheCreationTokens) + nonNegative(usage.cacheCreationTokens),
      webSearchRequests: nonNegative(before.webSearchRequests) + nonNegative(usage.webSearchRequests),
      costUsd: nonNegative(before.costUsd) + nonNegative(usage.costUsd),
      costReporting: before.costReporting === usage.costReporting ? before.costReporting : 'partial',
    } as T;
  }
  return folded;
}

/**
 * Accumulate one turn's per-model map into the session's.
 *
 * Every field is additive by construction (`PersistedModelUsage` carries no
 * capacity fields), so this is a per-key sum plus the same verdict merge as
 * above. Returns `previous` unchanged when the turn reported no map, so a
 * backend without one never overwrites a map another turn produced.
 *
 * **`turn` IS ONE TURN'S OWN CONSUMPTION, NOT A RUNNING TOTAL** — the contract
 * this `+` depends on, shared with `recordUsageMetrics`' OTLP counters, and the
 * one a backend can break silently. A provider whose per-model map is cumulative
 * (the Claude SDK's is: `sdk.d.ts:4367`, "each result carries the running total
 * so far") must DIFFERENCE it in its own event adapter first; this function
 * cannot, because only the backend knows when its provider's totals restart.
 * P2.42 is what that costs when it is missed: three results of 1/2/3 merged to
 * 6 against a true 3, in all six fields at once, while P2.35 had already made
 * the session's top-line cost correct — so the breakdown and the total the user
 * reads contradicted each other.
 */
export function mergeModelUsage(
  previous: Record<string, PersistedModelUsage> | undefined,
  turn: Record<string, PersistedModelUsage> | undefined,
): Record<string, PersistedModelUsage> | undefined {
  if (!turn || Object.keys(turn).length === 0) return previous;
  // F1.1279 — a record written before the key was normalised is folded too,
  // so its `[1m]` entry and the bare one become one line on the next turn.
  const merged: Record<string, PersistedModelUsage> = foldModelUsageKeys(previous ?? {});
  for (const [wireModel, usage] of Object.entries(turn)) {
    const model = usageModelKey(wireModel);
    const before = merged[model] ?? emptyModelUsage();
    merged[model] = {
      inputTokens: before.inputTokens + nonNegative(usage.inputTokens),
      outputTokens: before.outputTokens + nonNegative(usage.outputTokens),
      cacheReadTokens: before.cacheReadTokens + nonNegative(usage.cacheReadTokens),
      cacheCreationTokens: before.cacheCreationTokens + nonNegative(usage.cacheCreationTokens),
      webSearchRequests: before.webSearchRequests + nonNegative(usage.webSearchRequests),
      costUsd: before.costUsd + nonNegative(usage.costUsd),
      costReporting: merged[model]
        ? mergeCostReporting(before.costReporting, toTurnCostReporting(usage.costReporting))
        : usage.costReporting,
    };
  }
  return merged;
}

/**
 * What a cost surface may render.
 *
 * `hidden` exists for records written before the verdict did: no marker and no
 * money is genuinely unknown, and inventing "unsupported" for every archived
 * session would be the same kind of claim this module exists to prevent.
 */
export type CostDisplay =
  | { kind: 'amount'; costUsd: number; partial: boolean }
  | { kind: 'unsupported' }
  | { kind: 'hidden' };

/** Resolve a persisted usage record into what a cost surface may say about it. */
export function resolveCostDisplay(
  tokenUsage: Pick<TokenUsage, 'costUsd' | 'costReporting'> | undefined,
): CostDisplay {
  if (!tokenUsage) return { kind: 'hidden' };
  const costUsd = typeof tokenUsage.costUsd === 'number' && Number.isFinite(tokenUsage.costUsd)
    ? tokenUsage.costUsd
    : 0;

  switch (tokenUsage.costReporting) {
    case 'unsupported':
      return { kind: 'unsupported' };
    case 'reported':
      return { kind: 'amount', costUsd, partial: false };
    case 'partial':
      return { kind: 'amount', costUsd, partial: true };
    default:
      // Legacy record. A positive figure came from a backend that reported one;
      // a zero came from nothing we can name.
      return costUsd > 0 ? { kind: 'amount', costUsd, partial: false } : { kind: 'hidden' };
  }
}
