/**
 * F1.598 (origin WJ-bl P-WJbl-1, 2026-09-24, DECIDED) — the host's per-session
 * web-search cap against codex's OWN search on the ChatGPT (Codex) card.
 *
 * ## The divergence
 *
 * The cap (`NESSY_MAX_WEB_SEARCHES_PER_SESSION`, default 200, J40,
 * `config/web-search-budget.ts`) is charged by the host's `web_search` tool and
 * by Pi's own search. F1.570 withholds the host tool on the ChatGPT (Codex)
 * card, where codex's native hosted search runs instead
 * (`codexConfigFollowsCodexWebSearch`), so on that card the cap charges nothing.
 *
 * ## Codex read first, for a native bound (`rust-v0.156.1`, the local tree)
 *
 * - `WebSearchToolConfig` carries `context_size`, `allowed_domains` and
 *   `location`; `WebSearchMode` is `disabled` / `cached` / `indexed` / `live`
 *   (`protocol/src/config_types.rs`). No count.
 * - The search runs inside the Responses request on OpenAI's backend; nothing
 *   in `core/src` counts `ResponseItem::WebSearchCall` against a limit.
 * - `TurnStartParams` has no per-turn tool override, so the host cannot switch
 *   the search off mid-thread without rebuilding the thread.
 *
 * So there is no native bound to enable (native-first step 1), the host cannot
 * supply one uniformly (step 2), and building one (step 3) would mean tearing
 * the thread down at the cap.
 *
 * ## The decision: count and SAY, once
 *
 * The host counts codex's own `webSearch` item starts on that card — the main
 * thread and every subagent thread the session spawned, because the documented
 * cap is "counted across the main conversation and every subagent it spawns"
 * (`tools-reference.md`) — and on the first search past the cap it says, once
 * and durably, that the cap does not stop them and why. Nothing is refused and
 * nothing is rebuilt. A new thread (a cleared conversation) starts the count
 * again, as "/clear resets the count" says of the cap. The count lives with the
 * agent, so a reopened session starts from zero: a stated residue.
 */
import {
  MAX_WEB_SEARCHES_PER_SESSION_ENV,
  resolveMaxWebSearchesPerSession,
  type WebSearchBudgetEnvRecord,
} from '../../../config/web-search-budget.ts';

/** Is this notification the START of one of codex's own `webSearch` items? */
export function isCodexWebSearchItemStart(method: string, params: unknown): boolean {
  if (method !== 'item/started') return false;
  const item = (params as { item?: { type?: unknown } } | null | undefined)?.item;
  return !!item && item.type === 'webSearch';
}

/** The one notice, said on the first search past the cap. */
export function describeCodexNativeWebSearchPastCap(count: number, limit: number): string {
  return `Codex's own web search has run ${count} times in this session, past the per-session cap of ${limit}`
    + ` (${MAX_WEB_SEARCHES_PER_SESSION_ENV}). That cap bounds the app's own web search, which this card does not`
    + ' use; Codex\'s search has no per-session limit, so further searches are not stopped.';
}

export interface CodexNativeWebSearchTally {
  readonly limit: number;
  /** Count one notification; the notice when it is the first search past the cap, else `null`. */
  note(method: string, params: unknown): string | null;
  count(): number;
}

/**
 * The limit is the host setting, read exactly as the host's own search reads it
 * (`resolveMaxWebSearchesPerSession`), so the two cannot name different caps.
 */
export function createCodexNativeWebSearchTally(
  limit?: number,
  env: WebSearchBudgetEnvRecord = process.env,
): CodexNativeWebSearchTally {
  const cap = limit ?? resolveMaxWebSearchesPerSession(env);
  let count = 0;
  return {
    limit: cap,
    note(method, params) {
      if (!isCodexWebSearchItemStart(method, params)) return null;
      count += 1;
      return count === cap + 1 ? describeCodexNativeWebSearchPastCap(count, cap) : null;
    },
    count: () => count,
  };
}
