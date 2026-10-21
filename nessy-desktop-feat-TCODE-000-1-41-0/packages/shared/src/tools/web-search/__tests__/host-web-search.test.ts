/**
 * P6.148 — the host web-search engine, tested where every runtime reads it.
 *
 * The provider is injected in every case, so no test in this file reaches the
 * network: the reachability of duckduckgo.com is a READING WITH A DATE (P3.342,
 * 2026-09-04) and a suite that depended on it would go red on a rig behind a
 * stricter egress policy while the code was correct.
 */

import { describe, expect, test } from 'bun:test';
import {
  extractResultsFromDuckDuckGoHtml,
  extractUrlFromDuckDuckGoHref,
  runHostWebSearch,
  type WebSearchProvider,
  type WebSearchResult,
} from '../index.ts';
import { createWebSearchBudget } from '../../../config/web-search-budget.ts';
import { WEB_SEARCH_ALLOWED_DOMAINS_ENV } from '../../../config/web-search-allowlist.ts';

function stubProvider(results: WebSearchResult[], name = 'DuckDuckGo'): WebSearchProvider {
  return { name, search: async () => results };
}

const TWO_RESULTS: WebSearchResult[] = [
  { title: 'Bun docs', url: 'https://bun.sh/docs', description: 'The Bun runtime.' },
  { title: 'Node docs', url: 'https://nodejs.org/api', description: 'The Node runtime.' },
];

describe('runHostWebSearch', () => {
  test('returns real result URLs, not the model’s prose', async () => {
    const outcome = await runHostWebSearch({
      query: 'bun runtime',
      provider: stubProvider(TWO_RESULTS),
      env: {},
    });

    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('https://bun.sh/docs');
    expect(outcome.text).toContain('https://nodejs.org/api');
    expect(outcome.text).toContain('via DuckDuckGo');
  });

  test('a provider failure is an ERROR that names the query', async () => {
    const outcome = await runHostWebSearch({
      query: 'bun runtime',
      env: {},
      provider: {
        name: 'DuckDuckGo',
        search: async () => {
          throw new Error('All DuckDuckGo endpoints failed: ddg_html:HTTP 503');
        },
      },
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('Search failed for "bun runtime"');
    expect(outcome.text).toContain('ddg_html:HTTP 503');
  });

  test('an empty query is refused without calling the provider', async () => {
    let calls = 0;
    const outcome = await runHostWebSearch({
      query: '   ',
      env: {},
      provider: {
        name: 'DuckDuckGo',
        search: async () => {
          calls += 1;
          return TWO_RESULTS;
        },
      },
    });

    expect(outcome.isError).toBe(true);
    expect(calls).toBe(0);
  });

  test('the operator allowlist filters BEFORE formatting, and filtering everything is a NOTICE', async () => {
    const kept = await runHostWebSearch({
      query: 'bun runtime',
      provider: stubProvider(TWO_RESULTS),
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'bun.sh' },
    });
    expect(kept.isError).toBe(false);
    expect(kept.text).toContain('https://bun.sh/docs');
    expect(kept.text).not.toContain('nodejs.org');

    const none = await runHostWebSearch({
      query: 'bun runtime',
      provider: stubProvider(TWO_RESULTS),
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'intranet.example.com' },
    });
    // A notice, not an error: retrying cannot help, and the next search would be
    // filtered the same way.
    expect(none.isError).toBe(false);
    expect(none.text).toContain(WEB_SEARCH_ALLOWED_DOMAINS_ENV);
    expect(none.text).not.toContain('nodejs.org');
  });

  test('the per-session cap is charged before the provider runs and is a NOTICE at the limit', async () => {
    const budget = createWebSearchBudget(1);
    let calls = 0;
    const provider: WebSearchProvider = {
      name: 'DuckDuckGo',
      search: async () => {
        calls += 1;
        return TWO_RESULTS;
      },
    };

    const first = await runHostWebSearch({ query: 'one', provider, budget, env: {} });
    expect(first.isError).toBe(false);
    expect(calls).toBe(1);

    const second = await runHostWebSearch({ query: 'two', provider, budget, env: {} });
    expect(second.isError).toBe(false);
    expect(second.text).toContain('Web search limit reached');
    // The gate is BEFORE the provider — an over-cap call must not search.
    expect(calls).toBe(1);
  });
});

describe('the DuckDuckGo HTML parser', () => {
  const html = `<html><body>
    <div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs">Bun docs</a> The Bun runtime.</div>
    <div class="result"><a class="result__a" href="https://nodejs.org/api">Node docs</a> The Node runtime.</div>
    <a href="/settings">Settings</a>
    <a href="javascript:void(0)">Nope</a>
  </body></html>`;

  test('decodes the redirect wrapper and keeps only http(s) results', () => {
    const results = extractResultsFromDuckDuckGoHtml(html, 10);
    expect(results.map(r => r.url)).toEqual(['https://bun.sh/docs', 'https://nodejs.org/api']);
    expect(results[0]!.title).toBe('Bun docs');
    expect(results[0]!.description).toContain('The Bun runtime.');
  });

  test('an HTML page with no result anchors parses to nothing', () => {
    expect(extractResultsFromDuckDuckGoHtml('<html><body><p>no anchors</p></body></html>', 10))
      .toEqual([]);
    expect(extractUrlFromDuckDuckGoHref('/settings')).toBeNull();
    expect(extractUrlFromDuckDuckGoHref('')).toBeNull();
  });
});
