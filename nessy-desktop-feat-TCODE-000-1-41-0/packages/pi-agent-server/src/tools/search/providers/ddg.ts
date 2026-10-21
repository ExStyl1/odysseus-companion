/**
 * DuckDuckGo search provider — universal fallback requiring no API key.
 *
 * Uses three endpoints with cascading fallback:
 *   1. duck-duck-scrape library (JS API) — this file
 *   2. html.duckduckgo.com (HTML endpoint) ┐ both in
 *   3. lite.duckduckgo.com (Lite endpoint) ┘ `@nessy-agent/shared`
 *
 * P6.148 — endpoints 2 and 3, their parser and their snippet rule MOVED to
 * `shared/src/tools/web-search/ddg.ts`, so the host session tool and the codex
 * subprocess run the same engine Pi does instead of a second copy of it. Only
 * the JS-API attempt stayed: `duck-duck-scrape` brings its own HTTP stack
 * (`needle`), and the host module is bundled into the Electron main process.
 * The two endpoints that moved are the two P3.342 measured.
 */

import * as DDG from 'duck-duck-scrape';
import {
  DuckDuckGoHtmlSearchEngine,
} from '../../../../../shared/src/tools/web-search/index.ts';
import type { WebSearchProvider, WebSearchResult } from '../types.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDdgError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes('anomaly') ||
    msg.includes('too quickly') ||
    msg.includes('server error') ||
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const canRetry = attempt < retries && isTransientDdgError(error);
      if (!canRetry) {
        throw error;
      }

      const backoff = 250 * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 120);
      await sleep(backoff + jitter);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function searchDDGApi(query: string, count: number): Promise<WebSearchResult[]> {
  const response = await withRetry(
    () => DDG.search(query, { safeSearch: DDG.SafeSearchType.MODERATE }),
    2,
  );

  if (response.noResults || !response.results?.length) {
    throw new Error('No DuckDuckGo results');
  }

  return response.results.slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.rawDescription || '',
  }));
}

export class DDGSearchProvider implements WebSearchProvider {
  name = 'DuckDuckGo';

  private readonly htmlEndpoints = new DuckDuckGoHtmlSearchEngine();

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const failurePath: string[] = [];

    try {
      return await searchDDGApi(query, count);
    } catch (err) {
      failurePath.push(`ddg_primary:${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      return await this.htmlEndpoints.search(query, count);
    } catch (err) {
      // The shared engine already names which of its two endpoints failed and
      // how, so its message is carried through rather than re-wrapped.
      failurePath.push(err instanceof Error ? err.message : String(err));
    }

    throw new Error(`All DuckDuckGo endpoints failed: ${failurePath.join('; ')}`);
  }
}
