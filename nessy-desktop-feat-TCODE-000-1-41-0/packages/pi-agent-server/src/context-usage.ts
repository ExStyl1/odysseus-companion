import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ContextUsageSnapshot } from '../../shared/src/protocol/dto.ts';
import {
  buildContextCategoryBreakdown,
  contextCategoryTotal,
  type ContextCategoryInputs,
} from './context-categories.ts';
import { stripPiPrefix } from './custom-endpoint-models.ts';

export interface LastCompactionSnapshot {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  firstKeptEntryId?: string;
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function finitePositive(value: unknown): number | null {
  const numeric = finiteNonNegative(value);
  return numeric && numeric > 0 ? numeric : null;
}

function maybeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readRuntimeContextWindow(session: AgentSession): number | null {
  const sessionWithUsage = session as AgentSession & {
    getContextUsage?: () => { contextWindow?: number } | undefined;
  };
  const usageContextWindow = finitePositive(sessionWithUsage.getContextUsage?.()?.contextWindow);
  if (usageContextWindow !== null) return usageContextWindow;

  const runtimeModelWindow = finitePositive(
    (session as AgentSession & { agent?: { state?: { model?: { contextWindow?: unknown } } } })
      .agent?.state?.model?.contextWindow,
  );
  if (runtimeModelWindow !== null) return runtimeModelWindow;

  return finitePositive((session as AgentSession & { model?: { contextWindow?: unknown } }).model?.contextWindow);
}

/**
 * Whether the window this session is running on was fabricated rather than known.
 *
 * The SDK cannot tell us — by the time a window is inside a registered model
 * definition, a fabricated 131 072 and a real one are the same number. So the
 * set is built where the definition is (`registerCustomEndpointModels`) and read
 * back here by model id.
 */
function windowIsFallback(
  modelId: string | undefined,
  fallbackWindowModelIds: ReadonlySet<string> | undefined,
): boolean {
  if (!modelId || !fallbackWindowModelIds?.size) return false;
  return fallbackWindowModelIds.has(stripPiPrefix(modelId));
}

export function buildContextUsageSnapshot(
  session: AgentSession,
  lastCompaction?: LastCompactionSnapshot,
  categoryInputs?: ContextCategoryInputs,
  fallbackWindowModelIds?: ReadonlySet<string>,
): ContextUsageSnapshot {
  const sessionWithUsage = session as AgentSession & {
    getContextUsage?: () => { tokens?: number | null; percent?: number | null; contextWindow?: number } | undefined;
    isCompacting?: boolean;
    autoCompactionEnabled?: boolean;
    settingsManager?: { getCompactionSettings?: () => { reserveTokens?: number; enabled?: boolean } };
    model?: { id?: string };
  };
  const usage = sessionWithUsage.getContextUsage?.();
  const contextWindow = readRuntimeContextWindow(session);
  const usageTokens = finiteNonNegative(usage?.tokens);
  const estimatedTokensAfter = finiteNonNegative(lastCompaction?.estimatedTokensAfter);
  const inputTokens = usageTokens ?? estimatedTokensAfter;
  const source: ContextUsageSnapshot['source'] = usageTokens !== null
    ? 'sdk_usage'
    : estimatedTokensAfter !== null
      ? 'estimated_after_compact'
      : 'unavailable';

  const percent = typeof usage?.percent === 'number' && Number.isFinite(usage.percent)
    ? usage.percent
    : inputTokens !== null && contextWindow !== null
      ? (inputTokens / contextWindow) * 100
      : null;

  const settings = sessionWithUsage.settingsManager?.getCompactionSettings?.();
  const reserveTokens = finiteNonNegative(settings?.reserveTokens);
  const autoCompactionThreshold = contextWindow !== null && reserveTokens !== null
    ? Math.max(0, contextWindow - reserveTokens)
    : null;

  // Category breakdown over the production-composed parts. `unattributedTokens`
  // is the provider-reported total minus the accounted estimates: conversation
  // is measured directly from the session's message history, so the remainder
  // covers only what no documented category owns (MCP context resources,
  // provider-side framing, estimator drift) and can be negative when the
  // estimator over-counts relative to the real total.
  const breakdown = categoryInputs ? buildContextCategoryBreakdown(categoryInputs) : undefined;
  const categorized = breakdown
    ? {
        categories: breakdown.categories,
        unattributedTokens: inputTokens !== null
          ? inputTokens - contextCategoryTotal(breakdown.categories)
          : null,
        loadedFiles: breakdown.loadedFiles,
        // Omitted rather than sent empty: an absent field and an empty list mean
        // the same thing to the overlay, and the wire stays byte-identical for
        // the composition that has nothing worth advising about.
        ...(breakdown.suggestions.length > 0 ? { suggestions: breakdown.suggestions } : {}),
      }
    : {};

  return {
    modelId: sessionWithUsage.model?.id,
    inputTokens,
    contextWindow,
    contextWindowSource: contextWindow === null
      ? 'unavailable'
      : windowIsFallback(sessionWithUsage.model?.id, fallbackWindowModelIds)
        ? 'fallback'
        : 'runtime',
    percent,
    remainingWindow: inputTokens !== null && contextWindow !== null
      ? Math.max(0, contextWindow - inputTokens)
      : null,
    autoCompactionEnabled: maybeBoolean(sessionWithUsage.autoCompactionEnabled),
    autoCompactionThreshold,
    remainingBeforeAutoCompact: inputTokens !== null && autoCompactionThreshold !== null
      ? Math.max(0, autoCompactionThreshold - inputTokens)
      : null,
    reserveTokens,
    isCompacting: Boolean(sessionWithUsage.isCompacting),
    source,
    stale: source === 'unavailable',
    ...(lastCompaction ? { lastCompaction } : {}),
    ...categorized,
  };
}
