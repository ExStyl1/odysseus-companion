/**
 * The web-search result shape, shared by every runtime.
 *
 * P6.148 — this file is the canonical home. It was
 * `pi-agent-server/src/tools/search/types.ts`, which is a package neither the
 * host session-tool registry nor the codex subprocess can import, so the one
 * key-free engine we ship could only ever serve Pi. That file now re-exports
 * these declarations, so there is exactly one `WebSearchResult` in the tree.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface WebSearchProvider {
  /** Display name shown in search results attribution (e.g. "Google", "OpenAI") */
  name: string;
  /** Execute a web search and return structured results. */
  search(query: string, count: number): Promise<WebSearchResult[]>;
}
