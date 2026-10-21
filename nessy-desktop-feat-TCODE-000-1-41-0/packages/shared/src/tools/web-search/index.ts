/**
 * The host web-search module — one key-free engine for all three runtimes.
 * See `host-web-search.ts` for what each runtime already has natively and why
 * this is a fallback rather than a replacement.
 */

export type { WebSearchProvider, WebSearchResult } from './types.ts';
export {
  DuckDuckGoHtmlSearchEngine,
  extractResultsFromDuckDuckGoHtml,
  extractUrlFromDuckDuckGoHref,
  searchDuckDuckGoHtmlEndpoint,
  searchDuckDuckGoLiteEndpoint,
} from './ddg.ts';
export type { WebSearchBudget } from '../../config/web-search-budget.ts';
export {
  createHostWebSearchBudget,
  HOST_WEB_SEARCH_DEFAULT_COUNT,
  HOST_WEB_SEARCH_MAX_COUNT,
  HOST_WEB_SEARCH_MIN_COUNT,
  runHostWebSearch,
  type HostWebSearchInput,
  type HostWebSearchOutcome,
} from './host-web-search.ts';
