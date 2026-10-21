/**
 * `web_search` — the HOST's search, for the runtimes whose own cannot reach us.
 *
 * P6.148. This is a REGISTRY handler and not a host-callback dispatcher on
 * purpose: it needs no per-session port, so it runs unchanged in-process for a
 * claude session and inside the external subprocess for a codex one, which is
 * what lets one build serve both cells. The engine is
 * `@nessy-agent/shared`'s relocated DuckDuckGo module — the same one Pi falls
 * back to, so there is no second implementation to drift.
 *
 * Native-first, and neither native mechanism is replaced:
 *
 * - Claude's `WebSearch` is native and SERVER-SIDE
 *   (`tools-reference.md#websearch-tool-behavior`: "WebSearch runs a query
 *   against Anthropic's web search backend and returns result titles and URLs.
 *   It doesn't fetch the result pages."), so it exists only where the request
 *   reaches an endpoint that implements it. It stays withheld exactly where it
 *   is withheld today, and this tool is offered only on those sessions.
 * - Codex's `web_search` is native (`ToolsToml.web_search`) and executes on
 *   OpenAI's backend, which the local adapter never reaches, so it stays
 *   `"disabled"` and this tool is offered on every codex session.
 * - Pi registers its own `web_search`, so this one is `visibility: 'not-pi'`.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import {
  createHostWebSearchBudget,
  runHostWebSearch,
  type WebSearchBudget,
} from '@nessy-agent/shared/tools';

export interface WebSearchArgs {
  query: string;
  count?: number;
}

/**
 * One counter per session, because the documented cap is per session
 * (`tools-reference.md`: "counted across the main conversation and every
 * subagent it spawns"). A module-scope map is the whole mechanism: in the codex
 * subprocess there is one session per process anyway, and in the host process
 * the entry is a number and a limit.
 *
 * Trimmed rather than unbounded — a host process outlives thousands of sessions
 * and a map nothing ever removes from is a leak however small each entry is.
 * Oldest-first, which is Map insertion order.
 */
const sessionBudgets = new Map<string, WebSearchBudget>();
const MAX_TRACKED_SESSION_BUDGETS = 512;

function budgetFor(sessionId: string): WebSearchBudget {
  const existing = sessionBudgets.get(sessionId);
  if (existing) return existing;
  const created = createHostWebSearchBudget();
  sessionBudgets.set(sessionId, created);
  while (sessionBudgets.size > MAX_TRACKED_SESSION_BUDGETS) {
    const oldest = sessionBudgets.keys().next();
    if (oldest.done) break;
    sessionBudgets.delete(oldest.value);
  }
  return created;
}

/** Test seam — the map is process-global and a suite must not inherit a used-up cap. */
export function resetHostWebSearchBudgets(): void {
  sessionBudgets.clear();
}

export async function handleWebSearch(
  ctx: SessionToolContext,
  args: WebSearchArgs,
): Promise<ToolResult> {
  const outcome = await runHostWebSearch({
    query: args?.query ?? '',
    count: args?.count,
    // A session with no id still gets a counter; sharing one bucket is a
    // stricter cap than none, and the alternative is an uncapped surface.
    budget: budgetFor(ctx.sessionId || '<no-session-id>'),
  });

  return outcome.isError ? errorResponse(outcome.text) : successResponse(outcome.text);
}
