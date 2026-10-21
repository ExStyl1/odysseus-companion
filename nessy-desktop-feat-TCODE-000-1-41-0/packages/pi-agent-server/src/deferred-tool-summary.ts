/**
 * F1.197 (origin WJ-l P-WJ-l-2) — the model is TOLD which tools are deferred.
 *
 * `agent-sdk/tool-search.md#how-tool-search-works`, verbatim: "When it is
 * active, tool definitions are withheld from the context window. The agent
 * receives a summary of available tools and searches for relevant ones when the
 * task requires a capability not already loaded."
 *
 * Pi withheld the definitions and sent no summary. The hidden names reached the
 * EXECUTION side only (`createDeferredMcpRegistrationController`) and one debug
 * line, and the two discovery tools described themselves as MCP-only while the
 * catalogue also carries the nine on-demand built-ins and ~45 session tools. So
 * a model that needed `review`, `web_fetch` or a session tool had no reason to
 * look behind `mcp__tool_search` — F1.147's live symptom (SIT-11 `P-SIT11-3`:
 * a gateway `pi` session reported `review` unavailable).
 *
 * ## What the summary is, and where it rides
 *
 * The NAMES, sorted, under one sentence saying how to reach them. The page says
 * "a summary" and specifies no shape; names are the smallest honest one, and
 * listing the definitions instead would re-spend exactly the context deferral
 * saves (a decision, stated here because the page is silent).
 *
 * Appended to the host-built system prompt at the one place the subprocess
 * applies it (`applySystemPromptOverride` in `index.ts`), because the tool
 * DEFINITIONS cannot carry it: each discovery tool's model contract is
 * hash-pinned (`PI_STATIC_MODEL_CONTRACT_HASHES`), so a per-session list inside
 * a description or `promptSnippet` would fail `projectPiManifestTools` on every
 * session. The list is recomputed whenever the session is rebuilt, i.e. on the
 * next handlePrompt after a `mcp__tool_load`.
 *
 * F1.838 — and inside the request that loads a tool, too. Since F1.803 a loaded
 * tool is callable from the model's next step, because Pi re-reads the active
 * tools before every model call (`_installAgentNextTurnRefresh`). Pi re-reads
 * the system prompt at that same point, but only its own base prompt or the
 * override `before_agent_start` returned when the request STARTED — no public
 * extension call replaces the override mid-request. So the load callback in
 * `index.ts` drops the loaded names here and re-applies the host prompt, and
 * the adapter's own next-turn hook (`compat/pi-runtime-adapter.ts`, the one
 * that already re-reads the tools) carries that prompt into the next model
 * call. Without it the list kept naming the tool for the rest of the request
 * while the tool list already carried it.
 *
 * Residue, stated: child sessions (subagents) are built from their own tool
 * pools and get no summary; the main session's system prompt is the one the
 * page's sentence is about.
 */

import { renderSubagentCatalogue } from './subagent-catalogue.ts';

let deferredToolNames: readonly string[] = [];

/** Record the hidden set of the session just built; `[]` when deferral is off. */
export function setDeferredToolSummaryNames(names: readonly string[]): void {
  deferredToolNames = [...new Set(names)].sort();
}

/**
 * F1.838 — take names a `mcp__tool_load` just made callable off the list.
 * Returns whether the list changed, so the caller re-applies the prompt only
 * when the model would see a different one.
 */
export function dropDeferredToolSummaryNames(loaded: readonly string[]): boolean {
  const drop = new Set(loaded);
  const next = deferredToolNames.filter(name => !drop.has(name));
  if (next.length === deferredToolNames.length) return false;
  deferredToolNames = next;
  return true;
}

/** The block itself, or `''` when nothing is deferred. */
export function renderDeferredToolSummary(names: readonly string[]): string {
  if (names.length === 0) return '';
  return [
    '<deferred-tools>',
    'These tools exist in this session but their definitions are not loaded, to keep them out of your context. '
      + 'When a task needs one, find it with mcp__tool_search and load it with mcp__tool_load; '
      + 'a loaded tool is callable from your next step in this same request.',
    names.join(', '),
    '</deferred-tools>',
  ].join('\n');
}

/**
 * The host's system prompt with the current summary appended, unchanged when there is none. F1.1262 — the session's
 * subagent catalogue (`subagent-catalogue.ts`) rides the same appendix, for the same hash-pin reason.
 */
export function withDeferredToolSummary(systemPrompt: string): string {
  const appendix = [renderDeferredToolSummary(deferredToolNames), renderSubagentCatalogue()].filter(Boolean);
  return appendix.length > 0 ? `${systemPrompt}\n\n${appendix.join('\n\n')}` : systemPrompt;
}
