/**
 * Creates a `web_search` ToolDefinition backed by the given search provider.
 *
 * The tool name is always `web_search` regardless of the underlying provider,
 * so the model doesn't need to know which backend is used.
 */

// UB4.4 (measured): build this schema with pi-ai's Type, not @sinclair/typebox — the Pi
// SDK's argument validation coerces a numeric string ('5' for `count`) only on schemas its
// own typebox recognizes (see docs/superpowers/specs/2026-10-15-ub4-4-typebox-coercion.md
// and the comment in ../web-fetch.ts).
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { WebSearchBudget } from '../../../../shared/src/config/web-search-budget.ts';
import { MAX_WEB_SEARCHES_PER_SESSION_ENV } from '../../../../shared/src/config/web-search-budget.ts';
// P6.339 · the operator's domain allowlist, resolved by the ONE reader all three
// runtimes share. Reached by relative path, the route `web-search-budget.ts`
// above already travels: this package does not declare `@nessy-agent/shared` as
// a dependency, and a second copy of the host-matching rule is the drift that
// discipline exists to stop.
import {
  isWebSearchUrlAllowed,
  resolveWebSearchAllowedDomains,
  webSearchAllowlistNotice,
} from '../../../../shared/src/config/web-search-allowlist.ts';
import type { WebSearchProvider, WebSearchResult } from './types.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

const schema = Type.Object({
  query: Type.String({ description: 'The search query' }),
  count: Type.Optional(
    Type.Number({
      description: 'Max results (1-10, default 5)',
      minimum: 1,
      maximum: 10,
    }),
  ),
});

/**
 * P6.339 — drop what the operator's allowlist does not cover, BEFORE formatting.
 *
 * Before the format step on purpose: a result that never reaches
 * {@link formatResults} never reaches the turn, so a filtered host cannot be
 * read by the model from a snippet it was not supposed to see. Filtering after
 * formatting would be a redaction, and a redaction of a string already built is
 * one edit away from leaking.
 *
 * An empty allowlist is OFF and returns the same array, so an install that
 * configured nothing pays nothing.
 */
function applyWebSearchAllowlist(
  results: WebSearchResult[],
  allowed: readonly string[],
): WebSearchResult[] {
  if (allowed.length === 0) return results;
  return results.filter(result => isWebSearchUrlAllowed(result.url, allowed));
}

function formatResults(
  query: string,
  providerName: string,
  results: WebSearchResult[],
  note?: string,
) {
  const formatted = results
    .map(
      (r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`,
    )
    .join('\n\n');

  const noteText = note ? `${note}\n\n` : '';

  return {
    content: [
      {
        type: 'text' as const,
        text: `${noteText}Search results for "${query}" (via ${providerName}):\n\n${formatted}`,
      },
    ],
    details: {},
  };
}

function formatErrorSnippet(message: string, max = 180): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  if (!compact) return 'unknown error';
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function createSearchTool(
  provider: WebSearchProvider,
  fallbackProvider: WebSearchProvider = new DDGSearchProvider(),
  options?: {
    budget?: WebSearchBudget;
    /**
     * P6.339 — the environment the allowlist is read from. Passed explicitly so a
     * suite never has to mutate `process.env`: assigning to a name Bun
     * pre-creates a slot for leaves it readable by property and INVISIBLE to a
     * spread, so a test that mutated the real environment would be asserting a
     * shape no subprocess ever receives (AGENTS.md, measured 2026-09-01).
     */
    env?: Record<string, string | undefined>;
  },
): ToolDefinition<typeof schema> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web for current information. Returns titles, URLs, and snippets. Use for current information, documentation lookups, or fact-checking.',
    promptSnippet:
      'Use web_search for up-to-date information, documentation lookups, or fact-checking. Returns titles, URLs, and snippets. Accepts a query string and optional count (1-10).',
    parameters: schema,
    async execute(toolCallId, params) {
      // Session budget gate (tools-reference.md:449-451). Over the cap the
      // result is a NOTICE — deliberately WITHOUT `details.isError`, because
      // the page contrasts it with "an error that would invite a retry" — that
      // tells the model to continue with what it has and names the lever.
      // Under the cap, `tryConsume()` charges the call BEFORE the provider
      // runs: a provider failure still spends the call (the doc counts
      // "WebSearch calls", not successes), and the internal fallback attempt
      // below never charges a second one.
      if (options?.budget && !options.budget.tryConsume()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Web search limit reached for this session (${options.budget.limit} searches). Continue with the information you already gathered; if you genuinely need more searches, ask the user to raise ${MAX_WEB_SEARCHES_PER_SESSION_ENV}.`,
            },
          ],
          details: {},
        };
      }

      const { query } = params;
      const count = Math.max(1, Math.min(10, params.count ?? 5));
      // P6.339 · read per call rather than per process: a managed `env` block can
      // introduce the name mid-session, and a value cached at module scope would
      // keep searching the whole web after the operator had narrowed it.
      const allowed = resolveWebSearchAllowedDomains(options?.env);

      /**
       * The one exit for a search that returned hits and kept none of them.
       *
       * A NOTICE and not an error, the shape the session budget above already
       * uses for the same reason: `tools-reference.md` contrasts a notice with
       * "an error that would invite a retry", and a retry cannot help here — the
       * next search will be filtered the same way. It names the lever, because a
       * model told only "no results" would conclude the web is empty on this
       * topic and say so to the user.
       */
      const formatAllowed = (providerName: string, results: WebSearchResult[], note?: string) => {
        const kept = applyWebSearchAllowlist(results, allowed);
        if (kept.length === 0 && results.length > 0) {
          return {
            content: [{ type: 'text' as const, text: webSearchAllowlistNotice(allowed) }],
            details: {},
          };
        }
        return formatResults(query, providerName, kept, note);
      };

      try {
        const results = await provider.search(query, count);
        return formatAllowed(provider.name, results);
      } catch (err) {
        const primaryMsg = err instanceof Error ? err.message : String(err);

        const canFallback = provider.name !== fallbackProvider.name;
        if (canFallback) {
          try {
            const fallbackResults = await fallbackProvider.search(query, count);
            // The FALLBACK provider is filtered too. A provider swap is not an
            // operator decision, and an allowlist that only held for the primary
            // engine would be one outage away from being no allowlist at all.
            return formatAllowed(
              fallbackProvider.name,
              fallbackResults,
              `Primary search provider (${provider.name}) failed (${formatErrorSnippet(primaryMsg)}), automatically fell back to ${fallbackProvider.name}.`,
            );
          } catch (fallbackErr) {
            const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Search failed for "${query}": primary (${provider.name}) failed with "${primaryMsg}"; fallback (${fallbackProvider.name}) failed with "${fallbackMsg}"`,
                },
              ],
              details: { isError: true },
            };
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Search failed for "${query}": ${primaryMsg}`,
            },
          ],
          details: { isError: true },
        };
      }
    },
  };
}
