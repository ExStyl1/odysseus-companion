import type { SDKCompactBoundaryMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  ContextUsageCategory,
  ContextUsageCategoryId,
  ContextUsageCategoryItem,
  ContextUsageSnapshot,
} from '@nessy-agent/core';

/**
 * P6.264 — claude's structured context report, kept instead of thrown away.
 *
 * ## What was wrong
 *
 * The SDK ships the whole `/context` card as data and the host read two fields
 * of it. `Query.getContextUsage()` returns an `SDKContextUsage` whose own
 * docblock calls it *"Structured twin of the /context report — the data a client
 * needs to render the context-usage card without parsing the markdown table"*,
 * carrying `categories`, `mcp_tools`, `memory_files`, `agents` and `skills`,
 * each with per-item token counts, plus `over_limit`. The one consumer took
 * `{ model, rawMaxTokens }` and dropped the rest, so a claude session's
 * `/context` had nothing to draw and fell back to totals — while Pi, which
 * computes the same breakdown locally, drew all three documented clauses.
 *
 * `getContextUsage()` takes **no argument**: the `{ detail }` form claimed
 * upstream does not exist in the vendored `sdk.d.ts`. Nothing needs requesting;
 * the detail was always in the reply.
 *
 * ## The mapping, and the two places it deliberately does not invent
 *
 * The SDK's category rows carry a `kind` — `'used' | 'free' | 'buffer' |
 * 'deferred'` — and a display `name` whose own doc says *"Use `kind` (not this
 * name) to classify the row"*. Our wire vocabulary is the SEVEN documented
 * `/context` categories, which is a different axis: the SDK's `free` and
 * `buffer` rows are window arithmetic rather than content, and its `used` rows
 * are named for display. So the four typed collections are mapped by IDENTITY —
 * `mcp_tools`, `memory_files`, `agents` → `custom_subagents`, `skills` — each
 * with its per-item rows, which is exactly what the row's `done_means` asks to
 * see; and the remaining `used` categories are matched to our ids by their
 * `name` only where the match is unambiguous, never guessed.
 *
 * 1. **`free` and `buffer` rows are dropped.** They are not context content and
 *    our `ContextUsageCategory` has no id for them; the window they describe is
 *    already carried by `contextWindow` and `remainingWindow`.
 * 2. **`suggestions` is not produced.** The row measured this: `grep -a
 *    suggestion sdk.d.ts` finds permission, prompt and file-mention suggestions
 *    only, so the runtime publishes no twin of the page's optimization clause.
 *    Stated absent by name rather than host-computed here, because a suggestion
 *    derived from someone else's numbers is a guess wearing a measurement's
 *    clothes.
 */

/** The SDK shape, structurally typed — the vendored name is not exported from `sdk.mjs`. */
interface SdkContextUsageLike {
  model?: unknown;
  total_tokens?: unknown;
  raw_max_tokens?: unknown;
  rawMaxTokens?: unknown;
  over_limit?: { tokens_over?: unknown; kind?: unknown };
  categories?: readonly { name?: unknown; tokens?: unknown; kind?: unknown }[];
  mcp_tools?: readonly { name?: unknown; server_name?: unknown; tokens?: unknown }[];
  memory_files?: readonly { path?: unknown; type?: unknown; tokens?: unknown }[];
  agents?: readonly { agent_type?: unknown; source?: unknown; tokens?: unknown }[];
  skills?: readonly { name?: unknown; source?: unknown; plugin_name?: unknown; tokens?: unknown }[];
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * The `used` category rows we can name without guessing.
 *
 * Keyed on the CLI's own display names, lower-cased. Deliberately short: a row
 * whose name is not here contributes its tokens to the total (the SDK already
 * counted it) and no per-category row, which reads as unattributed — honest —
 * rather than as a category it may not be.
 */
const NAMED_USED_CATEGORIES: Readonly<Record<string, ContextUsageCategoryId>> = Object.freeze({
  'system prompt': 'system_prompt',
  'system tools': 'system_tools',
  'messages': 'conversation_messages',
  'conversation messages': 'conversation_messages',
});

function itemised(
  id: ContextUsageCategoryId,
  items: ContextUsageCategoryItem[],
): ContextUsageCategory | undefined {
  if (items.length === 0) return undefined;
  return { id, tokens: items.reduce((sum, item) => sum + item.tokens, 0), items };
}

/**
 * `SDKContextUsage` → the host's `ContextUsageSnapshot`, or `undefined` when the
 * payload carries nothing usable.
 *
 * Fails soft in every direction: an older CLI that answers with only `model` and
 * `raw_max_tokens` produces a snapshot with no `categories`, which is exactly
 * the totals-only overlay the wire field was made optional for.
 */
export function claudeContextUsageSnapshot(payload: unknown): ContextUsageSnapshot | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const usage = payload as SdkContextUsageLike;

  const inputTokens = num(usage.total_tokens) ?? null;
  // `rawMaxTokens` is the camelCase alias the vendored `Query` surface returns;
  // `raw_max_tokens` is the wire spelling in `SDKContextUsage`. Both are read
  // because the two have disagreed across bundles and neither is guaranteed.
  const contextWindow = num(usage.raw_max_tokens) ?? num(usage.rawMaxTokens) ?? null;
  const modelId = str(usage.model);
  if (inputTokens === null && contextWindow === null && !modelId) return undefined;

  const categories: ContextUsageCategory[] = [];

  for (const row of usage.categories ?? []) {
    // `free` and `buffer` are window arithmetic, `deferred` is out-of-window by
    // the SDK's own definition ("excluded from usage math").
    if (row?.kind !== 'used') continue;
    const id = NAMED_USED_CATEGORIES[(str(row.name) ?? '').toLowerCase()];
    const tokens = num(row.tokens);
    if (!id || tokens === undefined) continue;
    categories.push({ id, tokens });
  }

  const mcpTools = itemised('mcp_tools', (usage.mcp_tools ?? []).flatMap(tool => {
    const name = str(tool?.name);
    const tokens = num(tool?.tokens);
    if (!name || tokens === undefined) return [];
    const source = str(tool?.server_name);
    return [{ name, tokens, ...(source ? { source } : {}) }];
  }));
  if (mcpTools) categories.push(mcpTools);

  const memoryFiles = itemised('memory_files', (usage.memory_files ?? []).flatMap(file => {
    const name = str(file?.path);
    const tokens = num(file?.tokens);
    if (!name || tokens === undefined) return [];
    const source = str(file?.type);
    return [{ name, tokens, ...(source ? { source } : {}) }];
  }));
  if (memoryFiles) categories.push(memoryFiles);

  const agents = itemised('custom_subagents', (usage.agents ?? []).flatMap(agent => {
    const name = str(agent?.agent_type);
    const tokens = num(agent?.tokens);
    if (!name || tokens === undefined) return [];
    // "Raw source identifier, e.g. 'projectSettings', 'userSettings', 'plugin'.
    // Display labels are the renderer's concern" — carried verbatim.
    const source = str(agent?.source);
    return [{ name, tokens, ...(source ? { source } : {}) }];
  }));
  if (agents) categories.push(agents);

  const skills = itemised('skills', (usage.skills ?? []).flatMap(skill => {
    const name = str(skill?.name);
    const tokens = num(skill?.tokens);
    if (!name || tokens === undefined) return [];
    const source = str(skill?.plugin_name) ?? str(skill?.source);
    return [{ name, tokens, ...(source ? { source } : {}) }];
  }));
  if (skills) categories.push(skills);

  const attributed = categories.reduce((sum, category) => sum + category.tokens, 0);

  return {
    ...(modelId ? { modelId } : {}),
    inputTokens,
    contextWindow,
    contextWindowSource: contextWindow === null ? 'unavailable' : 'runtime',
    remainingWindow: inputTokens !== null && contextWindow !== null
      ? contextWindow - inputTokens
      : null,
    source: 'sdk_usage',
    ...(categories.length > 0
      ? { categories, unattributedTokens: inputTokens === null ? null : inputTokens - attributed }
      : {}),
  };
}

/**
 * F1.240 — the context SNAPSHOT a compaction boundary leaves behind, or
 * `undefined` when `message` is not a `compact_boundary`.
 *
 * Since P6.264 claude is a `fresh-local` context provider: the composer donut
 * and the usage overlay read ONLY `ContextUsageSnapshot`, and nothing but an
 * explicit `/context` refresh ({@link claudeContextUsageSnapshot}) ever wrote
 * one. R14 already reads `compact_metadata.post_tokens` into `tokenUsage`, but
 * the snapshot was never replaced at the boundary, so after a refresh the donut
 * kept the PRE-compaction count — and the host's compaction `info` re-send
 * re-shipped it as current. Upstream craft-agents-oss v0.13.4's
 * `contextAfterCompaction` (Apache-2.0) is the shape ported here, in this
 * snapshot's own fields:
 *
 * - **`post_tokens` present** — a snapshot counting it, marked
 *   `estimated_after_compact` (the SDK's own after-count, not a measured
 *   `/context` breakdown: no categories), over the window the adapter reports.
 * - **`post_tokens` absent** (it is OPTIONAL in `SDKCompactBoundaryMessage`) —
 *   the count is UNKNOWN (`inputTokens: null`, `stale: true`), never invented:
 *   `pre_tokens` is the size the banner says is no longer true, so it is kept
 *   only as `lastCompaction.tokensBefore`, where it is labelled for what it is.
 */
export function claudeContextAfterCompaction(
  message: unknown,
  contextWindow: number | null | undefined,
): ContextUsageSnapshot | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const candidate = message as Partial<SDKCompactBoundaryMessage>;
  if (candidate.type !== 'system' || candidate.subtype !== 'compact_boundary') return undefined;
  const preTokens = num(candidate.compact_metadata?.pre_tokens);
  const post = num(candidate.compact_metadata?.post_tokens);
  const postTokens = post !== undefined && post > 0 ? post : null;
  const window = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : null;
  const lastCompaction = {
    ...(preTokens !== undefined ? { tokensBefore: preTokens } : {}),
    ...(postTokens !== null ? { estimatedTokensAfter: postTokens } : {}),
  };
  return {
    inputTokens: postTokens,
    contextWindow: window,
    contextWindowSource: window === null ? 'unavailable' : 'runtime',
    remainingWindow: postTokens !== null && window !== null ? window - postTokens : null,
    source: postTokens !== null ? 'estimated_after_compact' : 'unavailable',
    ...(postTokens === null ? { stale: true } : {}),
    lastCompaction,
  };
}
