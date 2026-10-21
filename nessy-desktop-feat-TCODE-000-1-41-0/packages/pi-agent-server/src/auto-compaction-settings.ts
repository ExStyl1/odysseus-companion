import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';
import { mcpOutputTokenLimit } from '../../shared/src/config/mcp-output-settings.ts';

/**
 * The thrashing refill limit is a SHARED number, not a Pi one — see its own
 * docblock in `shared/src/config/auto-compaction-settings.ts`. Re-exported here
 * so this module stays the single compaction-policy import for `index.ts`, and
 * so the two runtimes that implement the one documented behaviour cannot drift
 * to different counts.
 */
export { AUTO_COMPACTION_THRASHING_REFILL_LIMIT } from '../../shared/src/config/auto-compaction-settings.ts';

export interface PiAutoCompactionPolicy {
  readonly enabled: boolean;
  readonly thresholdPercent?: number;
  readonly contextWindow?: number;
}

export interface ResolvedPiAutoCompactionSettings {
  readonly enabled: boolean;
  readonly reserveTokens?: number;
  readonly thresholdTokens?: number;
}

/**
 * The headroom the threshold must leave for ONE more turn, and why it cannot be
 * the SDK's default.
 *
 * Pi checks `shouldCompact(contextTokens, contextWindow, settings)` AFTER an
 * assistant message, and `contextTokens` is the PROVIDER's own reported usage —
 * so there is no estimator drift to defend against on the healthy path. What the
 * reserve must actually absorb is everything the NEXT turn adds before the check
 * runs again: the user's message plus every tool result it produces.
 *
 * `DEFAULT_COMPACTION_SETTINGS.reserveTokens` is 16 384. The cap on a SINGLE MCP
 * tool result is 25 000 — `MCP_OUTPUT_TOKEN_LIMIT_DEFAULT`, matching `mcp.md`
 * § MCP output limits and warnings: "the default maximum is 25,000 tokens". One
 * permitted tool result can therefore exceed the entire headroom on its own —
 * the session sits just under the threshold, one tool call lands, and the next
 * request is over the window with no check in between. Those two numbers were
 * set independently and never reconciled; this is the reconciliation, not a
 * guessed safety margin.
 *
 * The floor is the tool-result cap (read live, so an operator who raises
 * `NESSY_MCP_OUTPUT_TOKENS` raises this with it) plus room for the user message
 * that carried it.
 *
 * What this does NOT cover, stated rather than implied: the same page says a
 * tool declaring `anthropic/maxResultSizeChars` "use[s] that value instead for
 * text content, regardless of what `MAX_MCP_OUTPUT_TOKENS` is set to". A tool
 * that opts into a larger result can still outgrow this reserve; the general
 * cap is what a reserve can reason about, a per-tool override is not.
 */
const TURN_GROWTH_USER_MESSAGE_ALLOWANCE = 8_192;

/**
 * The most of a context window the one-turn reserve may claim. Keeps the floor
 * proportionate on small-window models — see the call site for why an absolute
 * floor alone is wrong there.
 *
 * A third, and the boundary is the reason: the floor survives uncapped on any
 * window at or above three times it (~99 576 today), which covers every model
 * this app ships — the gateway's 262 144, Claude's 200 000, the 128 000 tier.
 * A tighter share was tried first and rejected by measurement: at a quarter, a
 * 100 000-window model lands on `threshold + one tool result == window` exactly,
 * so the fix would have been inert at a very common size while still looking
 * applied.
 */
const MAX_RESERVE_SHARE_OF_CAPACITY = 1 / 3;

export function minimumReserveTokens(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.max(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    mcpOutputTokenLimit(env) + TURN_GROWTH_USER_MESSAGE_ALLOWANCE,
  );
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Pi exposes no percentage/window threshold fields — re-verified against
 * the installed `CompactionSettings` at 0.84.0, at 0.84.2 (S0-3, 2026-09-03)
 * and at 0.84.3 (W11-pi, 2026-09-11), which is still only
 * `{ enabled?, reserveTokens?, keepRecentTokens? }`. Its live threshold
 * is `model.contextWindow - compaction.reserveTokens`, so translate the lower
 * effective token threshold back into that public reserveTokens setting.
 */
export function resolvePiAutoCompactionSettings(
  actualModelContextWindow: number | undefined,
  policy: PiAutoCompactionPolicy,
  env: Record<string, string | undefined> = process.env,
): ResolvedPiAutoCompactionSettings {
  const modelWindow = positiveInteger(actualModelContextWindow);
  if (modelWindow === undefined) return Object.freeze({ enabled: policy.enabled });

  const configuredWindow = positiveInteger(policy.contextWindow);
  const capacity = Math.min(configuredWindow ?? modelWindow, modelWindow);
  // See `minimumReserveTokens`: the SDK's 16 384 is smaller than one permitted
  // MCP tool result, so the default threshold leaves less headroom than a single
  // tool call may consume.
  //
  // But the one-turn floor is an ABSOLUTE token count, and an absolute floor is
  // proportionate only against a large window. On the gateway's 262 144 it is
  // ~13% of capacity; on a 50 000-window model it would be two thirds, and the
  // session would compact almost immediately — trading an overflow that might
  // not happen for a context loss that certainly would. So the floor is capped
  // at a share of capacity.
  //
  // The honest consequence, recorded rather than hidden: on a window too small
  // to hold one maximal tool result plus any history, NO reserve can prevent an
  // overflow. That is a mismatch between the tool-result cap and the model's
  // window, not something compaction can fix, and the cap is the knob that
  // should move (`NESSY_MCP_OUTPUT_TOKENS`).
  //
  // The outer `max` is not belt-and-braces: the share alone falls BELOW the SDK
  // default on any window under three times it (~49 152), so a raise-the-floor
  // change would have quietly LOWERED the reserve on small models — compacting
  // later than before this fix existed. Caught by the share-cap control, not by
  // reasoning. Whatever the share does, this never ends up worse than the
  // behaviour it replaced.
  const defaultReserve = Math.max(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    Math.min(
      minimumReserveTokens(env),
      Math.floor(capacity * MAX_RESERVE_SHARE_OF_CAPACITY),
    ),
  );
  const defaultThreshold = Math.max(0, capacity - defaultReserve);
  const percentageThreshold = policy.thresholdPercent === undefined
    ? defaultThreshold
    : Math.floor(capacity * (policy.thresholdPercent / 100));
  const thresholdTokens = Math.min(defaultThreshold, percentageThreshold);

  return Object.freeze({
    enabled: policy.enabled,
    reserveTokens: modelWindow - thresholdTokens,
    thresholdTokens,
  });
}
