import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '../../../../shared/src/testing/module-graph-budgets.ts';
import { resolveSearchProvider, type SearchProviderAuthConfig, type SearchProviderEndpoint } from './resolve-provider.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { ChatGPTBackendSearchProvider } from './providers/chatgpt.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DDGSearchProvider } from './providers/ddg.ts';
import { NESTOR_GATEWAY_BASE_URL } from '../../gateway-proxy/tool-schema-dialect.ts';

/** Build a minimal JWT with a chatgpt_account_id claim. */
function makeJwt(accountId: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  );
  return `${header}.${payload}.fakesig`;
}

/** A connection that talks to its provider's built-in endpoint: no base URL of its own. */
const NO_CUSTOM_BASE_URL: SearchProviderEndpoint = { baseUrl: undefined };

describe('resolveSearchProvider', () => {
  // --- OpenAI (API key) ---

  it('selects ResponsesApiSearchProvider for openai + api_key', () => {
    const provider = resolveSearchProvider({
      provider: 'openai',
      credential: { type: 'api_key', key: 'sk-test' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(ResponsesApiSearchProvider);
    expect(provider.name).toBe('OpenAI');
  });

  // --- ChatGPT Plus (OAuth) ---

  it('selects ChatGPTBackendSearchProvider for openai-codex + oauth with valid JWT', () => {
    const provider = resolveSearchProvider({
      provider: 'openai-codex',
      credential: {
        type: 'oauth',
        access: makeJwt('acc_123'),
        refresh: 'r',
        expires: Date.now() + 60_000,
      },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(ChatGPTBackendSearchProvider);
    expect(provider.name).toBe('ChatGPT');
  });

  it('selects ChatGPTBackendSearchProvider for openai-codex + api_key with valid JWT token', () => {
    const provider = resolveSearchProvider({
      provider: 'openai-codex',
      credential: { type: 'api_key', key: makeJwt('acc_999') },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(ChatGPTBackendSearchProvider);
    expect(provider.name).toBe('ChatGPT');
  });

  it('falls back to DDG for openai-codex + oauth with malformed JWT', () => {
    const provider = resolveSearchProvider({
      provider: 'openai-codex',
      credential: {
        type: 'oauth',
        access: 'not-a-jwt',
        refresh: 'r',
        expires: Date.now() + 60_000,
      },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DDG for openai-codex + api_key with malformed non-JWT token', () => {
    const provider = resolveSearchProvider({
      provider: 'openai-codex',
      credential: { type: 'api_key', key: 'not-a-jwt' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  // --- OpenRouter ---

  it('selects ResponsesApiSearchProvider for openrouter + api_key', () => {
    const provider = resolveSearchProvider({
      provider: 'openrouter',
      credential: { type: 'api_key', key: 'sk-or-test' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(ResponsesApiSearchProvider);
    expect(provider.name).toBe('OpenRouter');
  });

  // --- Google ---

  it('selects Google provider for google + api_key', () => {
    const provider = resolveSearchProvider({
      provider: 'google',
      credential: { type: 'api_key', key: 'g-test' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(GoogleSearchProvider);
  });

  // --- Fallback cases ---

  it('falls back to DDG for openai + oauth (no ChatGPT backend for plain openai)', () => {
    const provider = resolveSearchProvider({
      provider: 'openai',
      credential: {
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: Date.now() + 60_000,
      },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DDG when provider is unknown', () => {
    const provider = resolveSearchProvider({
      provider: 'unknown',
      credential: { type: 'api_key', key: 'x' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DDG when key is empty', () => {
    const provider = resolveSearchProvider({
      provider: 'openai',
      credential: { type: 'api_key', key: '' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DDG when no piAuth is provided', () => {
    expect(resolveSearchProvider(undefined, NO_CUSTOM_BASE_URL)).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DDG for github-copilot (no search API available)', () => {
    const provider = resolveSearchProvider({
      provider: 'github-copilot',
      credential: {
        type: 'oauth',
        access: 'ghu_token',
        refresh: 'r',
        expires: Date.now() + 60_000,
      },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DDG for vercel-ai-gateway (not yet wired for provider-native search)', () => {
    const provider = resolveSearchProvider({
      provider: 'vercel-ai-gateway',
      credential: { type: 'api_key', key: 'vercel-test-key' },
    }, NO_CUSTOM_BASE_URL);

    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });
});

/**
 * F1.853 — SIT-y (2026-09-25, RC build `69a6d33da`) recorded
 * `POST https://api.openai.com/v1/responses` carrying the one-click Pi gateway
 * card's credential, answered by OpenAI's edge with `401 … invalid_issuer`: the
 * card is `piAuthProvider: 'openai'` over a custom endpoint, and the resolver
 * handed every `openai` api key to OpenAI's public search endpoint whatever
 * host the connection itself talks to. Any BYO OpenAI-compatible endpoint took
 * the same branch, and the `openrouter` / `google` branches had the same shape.
 *
 * The instrument is a stub `fetch` that records the HOST of every request and
 * whether the connection's key rode it (in a header or in the URL), plus
 * `DDGSearchProvider.prototype.search` replaced by a counter — its first attempt
 * runs over `duck-duck-scrape`'s own HTTP stack (needle), not `fetch`, so the
 * real engine would reach the real network from a unit test. Every arm runs the
 * resolved provider's `search` for real, so what is asserted is where the key
 * WENT, not which class was picked.
 */
describe('F1.853 — a provider key is sent only to the host its own connection talks to', () => {
  const originalFetch = globalThis.fetch;
  const originalDdgSearch = DDGSearchProvider.prototype.search;
  let requests: Array<{ host: string; carriesKey: boolean }>;
  let ddgSearches: number;
  let key: string;

  beforeEach(() => {
    requests = [];
    ddgSearches = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headerValues: string[] = [];
      new Headers(init?.headers).forEach(value => { headerValues.push(value); });
      requests.push({
        host: new URL(url).host,
        carriesKey: url.includes(key) || headerValues.some(value => value.includes(key)),
      });
      return new Response(JSON.stringify({ output: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    DDGSearchProvider.prototype.search = async () => {
      ddgSearches += 1;
      return [];
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    DDGSearchProvider.prototype.search = originalDdgSearch;
  });

  async function searchWith(piAuth: SearchProviderAuthConfig, endpoint: SearchProviderEndpoint) {
    const provider = resolveSearchProvider(piAuth, endpoint);
    // The stub's empty payload is not a parseable result for every provider;
    // the arm reads where the request went, not what came back.
    await provider.search('latest released version of bun', 3).catch(() => undefined);
    return provider;
  }

  // --- The finding: a key that is NOT the provider's own never leaves for it ---

  // The gateway card's real shape at the resolver's caller: `piAuth` is the
  // gateway JWT under `provider: 'openai'`, and `generationConfig.baseUrl` is the
  // gateway URL — or, once `applyNestorReasoningProxy` has started, the loopback
  // proxy it was rewritten to (`localBaseUrl` keeps the upstream's path).
  it.each([
    ['the gateway URL', NESTOR_GATEWAY_BASE_URL],
    ['the loopback reasoning proxy fronting it', 'http://127.0.0.1:54321/api/v1/cli/openai-like/v1'],
  ])('the one-click Pi gateway card (%s) searches on DuckDuckGo and sends nothing to api.openai.com', async (_label, baseUrl) => {
    key = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJmaXh0dXJlLWdhdGV3YXkifQ.fixture-signature';
    const provider = await searchWith({ provider: 'openai', credential: { type: 'api_key', key } }, { baseUrl });

    expect(provider.name).toBe('DuckDuckGo');
    expect(ddgSearches).toBe(1);
    expect(requests).toEqual([]);
  });

  it.each([
    ['a BYO OpenAI-compatible endpoint', 'openai', 'https://llm-proxy.example.internal/v1'],
    ['a host that only STARTS with api.openai.com', 'openai', 'https://api.openai.com.attacker.example/v1'],
    ['a base URL that does not parse', 'openai', 'not a url'],
    ['an OpenRouter-shaped key over a custom endpoint', 'openrouter', 'https://openrouter-proxy.example.internal/api/v1'],
    ['a Google key over a custom endpoint', 'google', 'https://gemini-proxy.example.internal/v1beta'],
  ])('%s searches on DuckDuckGo and the key goes nowhere', async (_label, provider, baseUrl) => {
    key = 'sk-fixture-custom-endpoint-key';
    const resolved = await searchWith({ provider, credential: { type: 'api_key', key } }, { baseUrl });

    expect(resolved.name).toBe('DuckDuckGo');
    expect(ddgSearches).toBe(1);
    expect(requests).toEqual([]);
  });

  it('an openai-codex token over a base URL that is not chatgpt.com searches on DuckDuckGo', async () => {
    key = makeJwt('acc_fixture');
    const resolved = await searchWith(
      { provider: 'openai-codex', credential: { type: 'api_key', key } },
      { baseUrl: 'https://codex-proxy.example.internal/backend-api' },
    );

    expect(resolved.name).toBe('DuckDuckGo');
    expect(ddgSearches).toBe(1);
    expect(requests).toEqual([]);
  });

  // --- CONTROLS: a key issued for the provider still gets the provider's search ---

  it.each([
    ['a plain api.openai.com key (no base URL of its own)', 'openai', undefined, 'api.openai.com', 'OpenAI'],
    ['an openai key whose base URL IS api.openai.com', 'openai', 'https://api.openai.com/v1', 'api.openai.com', 'OpenAI'],
    ['an OpenRouter key (no base URL)', 'openrouter', undefined, 'openrouter.ai', 'OpenRouter'],
    ['an OpenRouter key whose base URL IS openrouter.ai', 'openrouter', 'https://openrouter.ai/api/v1', 'openrouter.ai', 'OpenRouter'],
    ['a Google key (no base URL)', 'google', undefined, 'generativelanguage.googleapis.com', 'Google'],
    ['a Google key whose base URL IS the Gemini API', 'google', 'https://generativelanguage.googleapis.com/v1beta', 'generativelanguage.googleapis.com', 'Google'],
  ])('CONTROL: %s still gets provider-native search, on that host only', async (_label, provider, baseUrl, host, name) => {
    key = 'sk-fixture-provider-issued-key';
    const resolved = await searchWith({ provider, credential: { type: 'api_key', key } }, { baseUrl });

    expect(resolved.name).toBe(name);
    expect(ddgSearches).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect([...new Set(requests.map(request => request.host))]).toEqual([host]);
    expect(requests.every(request => request.carriesKey)).toBe(true);
  });

  it('CONTROL: ChatGPT OAuth (openai-codex, no base URL) is unchanged — it searches on chatgpt.com', async () => {
    key = makeJwt('acc_fixture');
    const resolved = await searchWith(
      { provider: 'openai-codex', credential: { type: 'oauth', access: key, refresh: 'r', expires: Date.now() + 60_000 } },
      NO_CUSTOM_BASE_URL,
    );

    expect(resolved.name).toBe('ChatGPT');
    expect(ddgSearches).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    expect([...new Set(requests.map(request => request.host))]).toEqual(['chatgpt.com']);
  });

  it('CONTROL: the DuckDuckGo fallback is unchanged — no credential means no request of ours', async () => {
    key = 'no-key-at-all';
    const resolved = resolveSearchProvider(undefined, NO_CUSTOM_BASE_URL);
    await resolved.search('latest released version of bun', 3);

    expect(resolved.name).toBe('DuckDuckGo');
    expect(ddgSearches).toBe(1);
    expect(requests).toEqual([]);
  });

  /**
   * F1.867 — the no-base-URL branch above (`connectionTalksToPublicApi` answers
   * yes for a blank base URL without reading `PROVIDER_PUBLIC_API_HOSTS`) rests
   * on Pi's BUILT-IN endpoint for each native-search provider sitting on the
   * host that provider's search request goes to. F1.853 read that from pi-ai
   * 0.85.1's generated model table (outside pi-ai's `exports` map) on
   * 2026-09-25 and nothing pinned it: a Pi lift that moved a provider's host
   * would send a no-base-URL connection's key to one host for its turns and to
   * another for its searches, with every arm above still green.
   *
   * Read through the runtime's own registry — the production composition
   * `createPiRuntimeAdapter().createRegistry()`, and `find(provider, id)`, the
   * call `findPiModel` resolves a no-base-URL connection's model with — and
   * asserted through the table's only consumer, the resolver: each distinct
   * built-in base URL, handed over as the connection's own, must get native
   * search (its host IS the table's entry) with every request on that same host
   * (the table's entry IS where the search goes). Every built-in model of the
   * provider rather than one id: ids rotate, and a lift that moved ONE model's
   * host would slip past a one-id pin.
   *
   * CONTROL: the same arm with a planted wrong host lands on DuckDuckGo and
   * sends nothing, so the instrument goes red when registry and table disagree.
   */
  describe('F1.867 — Pi\'s built-in endpoint for each native-search provider is on the host its search goes to', () => {
    const NATIVE_SEARCH_PROVIDERS = [
      ['openai', 'OpenAI'],
      ['openai-codex', 'ChatGPT'],
      ['openrouter', 'OpenRouter'],
      ['google', 'Google'],
    ] as const;
    let builtInBaseUrls: Map<string, string[]>;

    beforeAll(async () => {
      const { createPiRuntimeAdapter } = await import('../../compat/pi-runtime-adapter.ts');
      const { modelRegistry } = await createPiRuntimeAdapter().createRegistry();
      builtInBaseUrls = new Map();
      for (const [provider] of NATIVE_SEARCH_PROVIDERS) {
        const baseUrls = modelRegistry.getAll()
          .filter(model => model.provider === provider)
          .map(model => modelRegistry.find(provider, model.id)?.baseUrl ?? `<find(${provider}, ${model.id}) returned nothing>`);
        builtInBaseUrls.set(provider, [...new Set(baseUrls)]);
      }
    }, MODULE_GRAPH_HOOK_BUDGET_MS);

    function credentialFor(provider: string): SearchProviderAuthConfig {
      key = provider === 'openai-codex' ? makeJwt('acc_fixture') : 'sk-fixture-provider-issued-key';
      return { provider, credential: { type: 'api_key', key } };
    }

    /** Where a search over `baseUrl` went: the provider it resolved to, and the hosts its requests reached. */
    async function searchVerdict(provider: string, baseUrl: string) {
      requests = [];
      ddgSearches = 0;
      const resolved = await searchWith(credentialFor(provider), { baseUrl });
      return {
        name: resolved.name,
        requestHosts: [...new Set(requests.map(request => request.host))],
        everyRequestCarriesKey: requests.every(request => request.carriesKey),
        ddgSearches,
      };
    }

    it.each(NATIVE_SEARCH_PROVIDERS)('%s: every built-in base URL gets native search, on that base URL\'s own host only', async (provider, name) => {
      const baseUrls = builtInBaseUrls.get(provider) ?? [];
      // Positive control: the registry really lists this provider's built-in models.
      expect(baseUrls.length).toBeGreaterThan(0);
      for (const baseUrl of baseUrls) {
        const builtInHost = new URL(baseUrl).host;
        expect({ baseUrl, ...(await searchVerdict(provider, baseUrl)) }).toEqual({
          baseUrl,
          name,
          requestHosts: [builtInHost],
          everyRequestCarriesKey: true,
          ddgSearches: 0,
        });
      }
    });

    it.each(NATIVE_SEARCH_PROVIDERS)('CONTROL: %s over its built-in base URL moved to a planted host lands on DuckDuckGo and sends nothing', async provider => {
      const planted = new URL((builtInBaseUrls.get(provider) ?? [])[0] ?? 'https://unlisted.example/');
      planted.hostname = `${provider}.moved-by-a-pi-lift.example`;

      expect(await searchVerdict(provider, planted.href)).toEqual({
        name: 'DuckDuckGo',
        requestHosts: [],
        everyRequestCarriesKey: true,
        ddgSearches: 1,
      });
    });
  });
});
