import { describe, expect, it } from 'bun:test';
import { createWebSearchBudget } from '../../../../shared/src/config/web-search-budget.ts';
import { WEB_SEARCH_ALLOWED_DOMAINS_ENV } from '../../../../shared/src/config/web-search-allowlist.ts';
import { createSearchTool } from './create-search-tool.ts';
import type { WebSearchProvider } from './types.ts';

describe('createSearchTool', () => {
  it('keeps canonical tool identity', () => {
    const provider: WebSearchProvider = {
      name: 'Mock',
      async search() {
        return [];
      },
    };

    const tool = createSearchTool(provider);

    expect(tool.name).toBe('web_search');
    expect(tool.label).toBe('Web Search');
    expect(tool.description).toContain('Search the web');
  });

  it('clamps count to [1, 10] and formats results', async () => {
    let capturedCount = 0;
    const provider: WebSearchProvider = {
      name: 'MockProvider',
      async search(query, count) {
        capturedCount = count;
        return [{ title: `Result for ${query}`, url: 'https://example.com', description: 'desc' }];
      },
    };

    const tool = createSearchTool(provider);
    const result = await tool.execute('tool-1', { query: 'nessy', count: 99 });

    expect(capturedCount).toBe(10);
    expect(result.details?.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any).text).toContain('(via MockProvider)');
  });

  it('automatically falls back when primary provider fails', async () => {
    const provider: WebSearchProvider = {
      name: 'OpenAI',
      async search() {
        throw new Error('401 missing scope');
      },
    };

    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        return [{ title: 'Fallback hit', url: 'https://fallback.example', description: 'ok' }];
      },
    };

    const tool = createSearchTool(provider, fallbackProvider);
    const result = await tool.execute('tool-2', { query: 'nessy', count: 5 });

    expect(result.details?.isError).toBeUndefined();
    expect((result.content[0] as any).text).toContain('automatically fell back to DuckDuckGo');
    expect((result.content[0] as any).text).toContain('401 missing scope');
    expect((result.content[0] as any).text).toContain('https://fallback.example');
  });

  it('marks failures as errors when primary and fallback both fail', async () => {
    const provider: WebSearchProvider = {
      name: 'OpenAI',
      async search() {
        throw new Error('primary boom');
      },
    };

    const fallbackProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        throw new Error('fallback boom');
      },
    };

    const tool = createSearchTool(provider, fallbackProvider);
    const result = await tool.execute('tool-3', { query: 'nessy', count: -1 });

    expect(result.details?.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('primary (OpenAI) failed');
    expect((result.content[0] as any).text).toContain('fallback (DuckDuckGo) failed');
  });

  it('does not recurse fallback when provider is already fallback provider', async () => {
    const ddgProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        throw new Error('ddg boom');
      },
    };

    const tool = createSearchTool(ddgProvider, ddgProvider);
    const result = await tool.execute('tool-4', { query: 'nessy' });

    expect(result.details?.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('Search failed');
    expect((result.content[0] as any).text).toContain('ddg boom');
  });

  // tools-reference.md:449-451 — over the cap, further calls return a NOTICE
  // telling the model to continue with what it already gathered, "rather than
  // an error that would invite a retry". The provider must not be reached.
  it('returns the over-cap notice without isError and without calling the provider', async () => {
    let providerCalls = 0;
    const provider: WebSearchProvider = {
      name: 'MockProvider',
      async search() {
        providerCalls += 1;
        return [{ title: 'hit', url: 'https://example.com', description: 'ok' }];
      },
    };

    const tool = createSearchTool(provider, provider, { budget: createWebSearchBudget(1) });

    const first = await tool.execute('tool-5', { query: 'nessy' });
    expect(first.details?.isError).toBeUndefined();
    expect((first.content[0] as any).text).toContain('(via MockProvider)');

    const second = await tool.execute('tool-6', { query: 'nessy again' });
    expect(providerCalls).toBe(1);
    expect(second.details?.isError).toBeUndefined();
    expect(second.details).toEqual({});
    expect((second.content[0] as any).text).toContain('Web search limit reached for this session (1 searches)');
    expect((second.content[0] as any).text).toContain('Continue with the information you already gathered');
    expect((second.content[0] as any).text).toContain('NESSY_MAX_WEB_SEARCHES_PER_SESSION');
  });

  // env-vars.md:284 counts "WebSearch calls", not successes: the charge lands
  // BEFORE the provider runs, so a failing search cannot loop for free, and
  // the internal fallback attempt does not charge a second call.
  it('a provider failure still consumes exactly one budget unit', async () => {
    const failingProvider: WebSearchProvider = {
      name: 'DuckDuckGo',
      async search() {
        throw new Error('boom');
      },
    };

    const budget = createWebSearchBudget(2);
    const tool = createSearchTool(failingProvider, failingProvider, { budget });

    const failed = await tool.execute('tool-7', { query: 'nessy' });
    expect(failed.details?.isError).toBe(true);
    expect(budget.used()).toBe(1);

    // The second call still has budget; the third gets the notice.
    await tool.execute('tool-8', { query: 'nessy' });
    expect(budget.used()).toBe(2);
    const capped = await tool.execute('tool-9', { query: 'nessy' });
    expect(capped.details?.isError).toBeUndefined();
    expect((capped.content[0] as any).text).toContain('Web search limit reached');
    expect(budget.used()).toBe(2);
  });
});

/**
 * P6.339 — the operator's domain allowlist, on the only runtime that searches.
 *
 * Native-first came back empty on all three: codex publishes the key and cannot
 * carry it while its own search is disabled here (the reason is written at
 * `config-writer.ts`'s `web_search = "disabled"` line), claude has
 * `allowed_domains` only as a MODEL tool input, and Pi's provider filtered
 * nothing. So the host supplies it once, and this is the arm that buys the
 * capability.
 *
 * The environment is passed EXPLICITLY: mutating `process.env` for a name Bun
 * pre-creates a slot for leaves it invisible to a spread, so a suite that did
 * would be asserting a shape no subprocess receives (AGENTS.md, 2026-09-01).
 */
describe('P6.339 · the web-search domain allowlist', () => {
  const threeHosts: WebSearchProvider = {
    name: 'MockProvider',
    async search() {
      return [
        { title: 'docs', url: 'https://docs.example.com/a', description: 'allowed subdomain' },
        { title: 'apex', url: 'https://example.com/b', description: 'allowed apex' },
        { title: 'other', url: 'https://evil-example.com/c', description: 'label-boundary trap' },
      ];
    },
  };

  it('is OFF when unset — every result survives', async () => {
    const tool = createSearchTool(threeHosts, undefined, { env: {} });
    const text = (await tool.execute('t', { query: 'q' })).content[0] as { text: string };
    expect(text.text).toContain('docs.example.com');
    expect(text.text).toContain('evil-example.com');
  });

  it('keeps the host and its subdomains and drops everything else', async () => {
    const tool = createSearchTool(threeHosts, undefined, {
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'example.com' },
    });
    const text = (await tool.execute('t', { query: 'q' })).content[0] as { text: string };
    expect(text.text).toContain('docs.example.com');
    expect(text.text).toContain('https://example.com/b');
    // THE TRAP: a plain `endsWith` would let this through.
    expect(text.text).not.toContain('evil-example.com');
  });

  it('accepts the spellings people write, and a comma or a space between them', async () => {
    const tool = createSearchTool(threeHosts, undefined, {
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'https://Evil-Example.com/path, .example.com' },
    });
    const text = (await tool.execute('t', { query: 'q' })).content[0] as { text: string };
    expect(text.text).toContain('evil-example.com');
    expect(text.text).toContain('docs.example.com');
  });

  it('returns a NOTICE naming the lever when the allowlist keeps nothing', async () => {
    const tool = createSearchTool(threeHosts, undefined, {
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'nothing.invalid' },
    });
    const result = await tool.execute('t', { query: 'q' });
    const text = result.content[0] as { text: string };
    expect(text.text).toContain(WEB_SEARCH_ALLOWED_DOMAINS_ENV);
    // A notice, not an error: a retry cannot help, and the same shape the
    // session budget uses for the same reason.
    expect(result.details?.isError).toBeUndefined();
    expect(text.text).not.toContain('nothing.invalid/');
  });

  it('filters the FALLBACK provider too — a provider swap is not an operator decision', async () => {
    const failing: WebSearchProvider = {
      name: 'Primary',
      async search() {
        throw new Error('401 missing scope');
      },
    };
    const tool = createSearchTool(failing, threeHosts, {
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'example.com' },
    });
    const text = (await tool.execute('t', { query: 'q' })).content[0] as { text: string };
    expect(text.text).toContain('fell back to MockProvider');
    expect(text.text).not.toContain('evil-example.com');
  });

  it('a search that genuinely found nothing is NOT reported as filtered', async () => {
    const empty: WebSearchProvider = { name: 'MockProvider', async search() { return []; } };
    const tool = createSearchTool(empty, undefined, {
      env: { [WEB_SEARCH_ALLOWED_DOMAINS_ENV]: 'example.com' },
    });
    const text = (await tool.execute('t', { query: 'q' })).content[0] as { text: string };
    expect(text.text).not.toContain(WEB_SEARCH_ALLOWED_DOMAINS_ENV);
    expect(text.text).toContain('Search results for');
  });
});
