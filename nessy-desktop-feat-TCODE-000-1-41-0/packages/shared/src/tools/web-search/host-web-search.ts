/**
 * One web search, run by the HOST, for a runtime whose own search cannot reach
 * us (P6.148).
 *
 * ## Native-first, and what each runtime already has
 *
 * - **Pi** — `web_search` is registered on every session with its own budget and
 *   falls through to DuckDuckGo with no API key. Nothing here is offered there;
 *   the host tool is `visibility: 'not-pi'`.
 * - **Claude** — `WebSearch` is native and documented
 *   (`tools-reference.md#websearch-tool-behavior`, the id read off the rendered
 *    page 2026-09-08 — the sentence this cited before is gone from the page:
 *    "WebSearch runs a query against Anthropic's web search backend and returns
 *    result titles and URLs."). It is SERVER-SIDE: the Anthropic Messages endpoint
 *   runs the search, so it exists only where the request reaches an endpoint
 *   that implements it. `resolveClaudeHostedWebSearchWithheld` keeps it exactly
 *   for models stamped `wire: 'anthropic-messages'` and withholds it on the
 *   gateway and on every BYO chat-completions upstream. Those withheld sessions
 *   — and only those — are offered this tool, so a passthrough session is never
 *   shown two search tools.
 * - **Codex** — `web_search` is native (`ToolsToml`'s `web_search` field, codex
 *   `rust-v0.148.0`) and executes on OpenAI's backend, which the local adapter
 *   never reaches, so `config-writer.ts` writes `web_search = "disabled"`
 *   unconditionally. There is no per-session case where codex has its own, so
 *   the host tool is offered on every codex session.
 *
 * The host does not replace either native mechanism; it is the uniform fallback
 * for the sessions where the native one is unreachable, and the withholdings
 * that made it necessary stay exactly as they were.
 *
 * ## Operator controls are the SAME ones Pi honours
 *
 * The domain allowlist and the per-session cap are read through the readers Pi
 * already uses, not re-implemented: an operator who narrowed search to a domain
 * list, or capped it, must get that answer on all three runtimes or this build
 * would have manufactured the divergence it exists to close.
 */

import {
  isWebSearchUrlAllowed,
  resolveWebSearchAllowedDomains,
  webSearchAllowlistNotice,
} from '../../config/web-search-allowlist.ts';
import {
  createWebSearchBudget,
  MAX_WEB_SEARCHES_PER_SESSION_ENV,
  resolveMaxWebSearchesPerSession,
  type WebSearchBudget,
} from '../../config/web-search-budget.ts';
import { DuckDuckGoHtmlSearchEngine } from './ddg.ts';
import type { WebSearchProvider, WebSearchResult } from './types.ts';

/** `create-search-tool.ts`'s clamp, restated in one place both callers read. */
export const HOST_WEB_SEARCH_MIN_COUNT = 1;
export const HOST_WEB_SEARCH_MAX_COUNT = 10;
export const HOST_WEB_SEARCH_DEFAULT_COUNT = 5;

/**
 * The session's counter, sized by the documented cap.
 *
 * `tools-reference.md#session-search-limit`: "A session can make at most 200
 * WebSearch calls, counted across the main conversation and every subagent it
 * spawns". Re-exported through this module rather than reached directly so a
 * host caller needs one import and cannot size the budget its own way.
 */
export function createHostWebSearchBudget(
  env?: Record<string, string | undefined>,
): WebSearchBudget {
  return createWebSearchBudget(resolveMaxWebSearchesPerSession(env));
}

export interface HostWebSearchInput {
  query: string;
  count?: number;
  /**
   * The session's counter. Omitted means the caller has none to charge — the
   * search still runs, because a missing counter is not a cap of zero.
   */
  budget?: WebSearchBudget;
  /** Read per call, never cached: a managed `env` block can narrow it mid-session. */
  env?: Record<string, string | undefined>;
  /** Defaults to the key-free engine; injected by tests and by a future provider swap. */
  provider?: WebSearchProvider;
}

export interface HostWebSearchOutcome {
  text: string;
  /**
   * `false` for the two NOTICES (over budget, everything filtered) as well as
   * for a hit: `tools-reference.md` contrasts a notice with "an error that would
   * invite a retry", and neither notice is improved by retrying.
   */
  isError: boolean;
}

function formatResults(
  query: string,
  providerName: string,
  results: readonly WebSearchResult[],
): string {
  const formatted = results
    .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
    .join('\n\n');
  return `Search results for "${query}" (via ${providerName}):\n\n${formatted}`;
}

export async function runHostWebSearch(input: HostWebSearchInput): Promise<HostWebSearchOutcome> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) {
    return { text: 'A non-empty `query` is required.', isError: true };
  }

  // Charged BEFORE the provider runs, the rule the Pi tool records: the cap
  // counts calls, not successes.
  if (input.budget && !input.budget.tryConsume()) {
    return {
      text: `Web search limit reached for this session (${input.budget.limit} searches). `
        + 'Continue with the information you already gathered; if you genuinely need more '
        + `searches, ask the user to raise ${MAX_WEB_SEARCHES_PER_SESSION_ENV}.`,
      isError: false,
    };
  }

  const count = Math.max(
    HOST_WEB_SEARCH_MIN_COUNT,
    Math.min(HOST_WEB_SEARCH_MAX_COUNT, input.count ?? HOST_WEB_SEARCH_DEFAULT_COUNT),
  );
  const allowed = resolveWebSearchAllowedDomains(input.env);
  const provider = input.provider ?? new DuckDuckGoHtmlSearchEngine();

  let results: WebSearchResult[];
  try {
    results = await provider.search(query, count);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Search failed for "${query}": ${message}`, isError: true };
  }

  // Filtered BEFORE formatting, `create-search-tool.ts`'s rule: a result that
  // never reaches the formatter never reaches the turn, so a filtered host
  // cannot be read out of a snippet.
  const kept = allowed.length === 0
    ? results
    : results.filter(result => isWebSearchUrlAllowed(result.url, allowed));

  if (kept.length === 0 && results.length > 0) {
    return { text: webSearchAllowlistNotice(allowed), isError: false };
  }

  return { text: formatResults(query, provider.name, kept), isError: false };
}
