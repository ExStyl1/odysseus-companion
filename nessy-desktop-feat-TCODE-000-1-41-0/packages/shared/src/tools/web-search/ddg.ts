/**
 * The key-free DuckDuckGo engine, in the one package all three runtimes reach.
 *
 * ## Why it moved here (P6.148)
 *
 * The engine shipped inside `pi-agent-server`, so a capability that needs no
 * API key and no vendor entitlement was available on exactly one runtime. The
 * two endpoints below are the ones P3.342 actually measured from a corporate
 * rig on 2026-09-04 — `html.duckduckgo.com` 200 with 21 result anchors,
 * `lite.duckduckgo.com` 200 with 10, `example.com` 200 as the control and
 * `api.anthropic.com` 404 as the "a proxy is not answering everything with a
 * success page" control — which is why they, and not the JS-API endpoint, are
 * what the host tool runs on.
 *
 * ## What deliberately did NOT move
 *
 * `pi-agent-server`'s `DDGSearchProvider` keeps `duck-duck-scrape` as its own
 * first attempt and delegates the rest here. That library carries its own HTTP
 * stack (`needle`), and this module is bundled into the Electron main process
 * by `esbuild --bundle --platform=node`; the host tool gains nothing from a
 * second HTTP client, and the measured endpoints are these two. One parser, one
 * pair of URLs, one snippet rule — the drift this relocation exists to prevent
 * is a SECOND implementation of those, not a second entry point.
 */

import { parse as parseHtml } from 'node-html-parser';
import type { WebSearchProvider, WebSearchResult } from './types.ts';

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html',
} as const;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractUrlFromDuckDuckGoHref(href: string): string | null {
  if (!href) return null;

  const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]!);
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(href)) {
    return href;
  }

  if (href.startsWith('//')) {
    return `https:${href}`;
  }

  return null;
}

function buildSnippetFromAnchorText(anchorText: string, containerText: string): string {
  const normalizedAnchor = normalizeWhitespace(anchorText);
  const normalizedContainer = normalizeWhitespace(containerText);

  if (!normalizedContainer) return '';
  if (!normalizedAnchor) return normalizedContainer.slice(0, 280);

  const snippet = normalizeWhitespace(
    normalizedContainer.replace(normalizedAnchor, ''),
  );

  return snippet.slice(0, 280);
}

export function extractResultsFromDuckDuckGoHtml(
  html: string,
  count: number,
): WebSearchResult[] {
  const root = parseHtml(html);
  const anchors = root.querySelectorAll('a');

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const anchor of anchors) {
    if (results.length >= count) break;

    const href = anchor.getAttribute('href') || '';
    const decodedUrl = extractUrlFromDuckDuckGoHref(href);
    if (!decodedUrl) continue;

    let parsed: URL;
    try {
      parsed = new URL(decodedUrl);
    } catch {
      continue;
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) continue;

    const normalizedUrl = parsed.toString();
    if (seenUrls.has(normalizedUrl)) continue;

    const title = normalizeWhitespace(anchor.textContent || '');
    if (!title) continue;

    const containerText =
      anchor.parentNode?.textContent ||
      anchor.parentNode?.parentNode?.textContent ||
      '';

    const description = buildSnippetFromAnchorText(title, containerText);

    seenUrls.add(normalizedUrl);
    results.push({ title, url: normalizedUrl, description });
  }

  return results;
}

async function fetchDuckDuckGoHtml(url: string, endpointName: string): Promise<string> {
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`${endpointName} returned HTTP ${response.status}`);
  }

  return response.text();
}

export async function searchDuckDuckGoHtmlEndpoint(
  query: string,
  count: number,
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchDuckDuckGoHtml(url, 'DDG HTML');
  const results = extractResultsFromDuckDuckGoHtml(html, count);

  if (results.length === 0) {
    throw new Error('No results parsed from DDG HTML');
  }

  return results;
}

export async function searchDuckDuckGoLiteEndpoint(
  query: string,
  count: number,
): Promise<WebSearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const html = await fetchDuckDuckGoHtml(url, 'DDG Lite');
  const results = extractResultsFromDuckDuckGoHtml(html, count);

  if (results.length === 0) {
    throw new Error('No results parsed from DDG Lite HTML');
  }

  return results;
}

/**
 * The two measured endpoints, cascaded, with every failure named in the thrown
 * message — a search that returns nothing and a search that could not run are
 * different facts and the model is told which it met.
 */
export class DuckDuckGoHtmlSearchEngine implements WebSearchProvider {
  name = 'DuckDuckGo';

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const failurePath: string[] = [];

    for (const [label, run] of [
      ['ddg_html', searchDuckDuckGoHtmlEndpoint],
      ['ddg_lite', searchDuckDuckGoLiteEndpoint],
    ] as const) {
      try {
        return await run(query, count);
      } catch (err) {
        failurePath.push(`${label}:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(`All DuckDuckGo endpoints failed: ${failurePath.join('; ')}`);
  }
}
