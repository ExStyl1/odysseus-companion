/**
 * Shared parser for the OpenAI Responses API format.
 *
 * Both `api.openai.com/v1/responses` and `chatgpt.com/backend-api/codex/responses`
 * return the same shape: output items with text content and URL-citation annotations.
 * OpenRouter also mirrors this format at `openrouter.ai/api/v1/responses`.
 */

import { wrapUntrusted } from '../../../../../shared/src/prompts/untrusted-text.ts';
import type { WebSearchResult } from '../types.ts';

/**
 * P6.231(b) — the ceiling on the fallback branch's provider text.
 *
 * The citation path bounds every snippet at 280 characters and the tool's own
 * schema caps `count` at 10, so a citation-shaped answer costs the turn at most
 * 2 800 characters of provider text. The fallback branch had NO bound at all: it
 * put the provider's entire output text into one result's `description`, so the
 * cheaper-looking branch was the unbounded one.
 *
 * This number is that worst case, derived rather than picked — "bounded like the
 * citation path" read as *the same worst-case cost*, not as the same per-item
 * number, because 280 characters is a snippet beside a URL while this is the
 * whole answer and a 280-character cap here would make the branch useless.
 * Stated here so the next reader can disagree with the derivation rather than
 * with a bare literal.
 */
export const SEARCH_FALLBACK_MAX_CHARS = 10 * 280;

/**
 * The fence source name for provider text nobody summarised.
 *
 * The same `wrapUntrusted` fence the transcript entries use, for the same
 * reason: this is text a third party wrote, arriving in a tool result the model
 * reads as instruction-adjacent.
 *
 * P6.609 closed the residue this docblock used to record. It read "the citation
 * branch stays as it was … that narrowing is a stated residue, not an argument
 * that a 280-character snippet is trustworthy" — and the row agreed with its own
 * last clause: being bounded is not being trusted, so the snippets are fenced
 * too, under {@link SEARCH_CITATION_FENCE_SOURCE}. The two names stay SEPARATE
 * because they mark different things, and a reader of the turn should be able to
 * tell an excerpt beside a URL from a whole unsummarised answer.
 */
export const SEARCH_FALLBACK_FENCE_SOURCE = 'web_search_provider_text';

/**
 * The fence source name for one citation excerpt (P6.609).
 *
 * The fence is OURS, not the vendor's. `security.md`
 * § *Protect against prompt injection* lists safeguards and best practices —
 * "Avoid piping untrusted content directly to Claude" — and publishes no fencing
 * mechanism at all, so the shape comes from `prompts/untrusted-text.ts`, the
 * wrapper the transcript entries and subagent reports already use. What the page
 * does NOT do is scale the concern with length, and neither does this: a
 * 280-character excerpt a third party wrote is the same class of text as the
 * whole answer, arriving in the same tool result the model reads as
 * instruction-adjacent. Bounding it caps the COST; the fence is what stops it
 * reading as structure.
 *
 * **Stated residue, so it is visible rather than assumed away.** This fences the
 * Responses-API path only. `ddg.ts` and `google.ts` cap their own snippets at the
 * same 280 characters and remain unfenced, so `web_search` output is fenced when
 * the Responses API answered and not when DuckDuckGo did. The uniform fix is one
 * fence at `formatResults` in `create-search-tool.ts` — the single seam every
 * provider's results pass through — which would also make the two fences here
 * redundant. That is a wider change than this row, and it is proposed as its own.
 */
export const SEARCH_CITATION_FENCE_SOURCE = 'web_search_citation_snippet';

interface UrlCitation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface ResponsesOutputTextPart {
  type?: string;
  text?: string;
  annotations?: UrlCitation[];
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesOutputTextPart[];
}

export interface ResponsesApiResponse {
  output?: ResponsesOutputItem[];
  output_text?: string;
}

export function collectOutputText(data: ResponsesApiResponse): string {
  const pieces: string[] = [];

  for (const item of data.output || []) {
    if (!Array.isArray(item.content)) continue;

    for (const part of item.content) {
      if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        pieces.push(part.text);
      }
    }
  }

  if (pieces.length > 0) return pieces.join('\n').trim();
  return typeof data.output_text === 'string' ? data.output_text.trim() : '';
}

export function collectUrlCitations(data: ResponsesApiResponse): UrlCitation[] {
  const citations: UrlCitation[] = [];

  for (const item of data.output || []) {
    if (!Array.isArray(item.content)) continue;

    for (const part of item.content) {
      if (!Array.isArray(part.annotations)) continue;

      for (const ann of part.annotations) {
        if (ann?.type === 'url_citation' && ann.url) {
          citations.push(ann);
        }
      }
    }
  }

  return citations;
}

/**
 * Parse a Responses API response into WebSearchResult[].
 *
 * Extracts URL citations first (structured results), falls back to a
 * plain-text summary if no citations are found.
 */
export function parseResponsesApiResults(
  data: ResponsesApiResponse,
  query: string,
  count: number,
): WebSearchResult[] {
  const text = collectOutputText(data);
  const annotations = collectUrlCitations(data);

  if (annotations.length > 0) {
    const seen = new Set<string>();
    const results: WebSearchResult[] = [];

    for (const ann of annotations) {
      if (results.length >= count) break;
      if (!ann.url || seen.has(ann.url)) continue;
      seen.add(ann.url);

      const description =
        typeof ann.start_index === 'number' && typeof ann.end_index === 'number' && text
          ? text.slice(ann.start_index, ann.end_index).slice(0, 280)
          : '';

      results.push({
        title: ann.title || ann.url,
        url: ann.url,
        // P6.609 — fenced like the fallback below. An EMPTY excerpt stays empty:
        // an empty fence is noise the model has to read past, the same reason
        // the fallback throws rather than returning one.
        description: description ? wrapUntrusted(SEARCH_CITATION_FENCE_SOURCE, description) : '',
      });
    }

    if (results.length > 0) return results;
  }

  if (!text) {
    throw new Error('Search returned no content');
  }

  // Fallback: the provider answered in prose with no citations. P6.231(b) — it
  // is BOUNDED and FENCED, and the title says what it is: a caller cannot tell
  // this branch from the citation branch by shape, and the two used to differ by
  // the whole of the provider's output. Since P6.609 both branches fence; what
  // still separates them is the TITLE and the fence's own source name.
  const bounded = text.length > SEARCH_FALLBACK_MAX_CHARS
    ? `${text.slice(0, SEARCH_FALLBACK_MAX_CHARS - 1).trimEnd()}…`
    : text;
  return [
    {
      title: `Unsummarized provider text for "${query}"`,
      url: '',
      description: wrapUntrusted(SEARCH_FALLBACK_FENCE_SOURCE, bounded),
    },
  ];
}
