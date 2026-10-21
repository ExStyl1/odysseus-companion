/**
 * Resolves the best web search provider based on the user's LLM connection.
 *
 * Priority:
 *   1. Provider-native search (OpenAI, ChatGPT, OpenRouter, Google) — best quality,
 *      and ONLY when the connection's own endpoint IS that provider's public API
 *   2. DuckDuckGo — universal fallback, no API key required
 *
 * To add a new Responses API-compatible provider:
 *   1. Add a case here (name + apiBase) and its API host to {@link PROVIDER_PUBLIC_API_HOSTS}
 *   2. The ResponsesApiSearchProvider handles the rest
 *
 * F1.853 — a provider-native search endpoint receives the connection's key only
 * when that key already goes to the same host. `piAuth.provider` names the WIRE
 * a connection speaks, not who issued its key: the one-click Pi gateway card is
 * `provider: 'openai'` over a custom endpoint whose key is the gateway
 * credential, and every BYO OpenAI-compatible endpoint (llm-proxy included) is
 * `provider: 'openai'` too. Measured by SIT-y on the 1.41.0 RC: the gateway
 * card's key left for `https://api.openai.com/v1/responses` on every search.
 */

import type { WebSearchProvider } from './types.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { ChatGPTBackendSearchProvider, extractChatGptAccountId } from './providers/chatgpt.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DDGSearchProvider } from './providers/ddg.ts';

export type SearchProviderCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: string; key?: string; access?: string };

export interface SearchProviderAuthConfig {
  provider?: string;
  credential?: SearchProviderCredential;
}

/**
 * F1.853 — the endpoint the connection itself sends its key to. REQUIRED, and
 * its one field is required too, so a caller cannot forget to say what it knows.
 */
export interface SearchProviderEndpoint {
  /**
   * The connection's own base URL as this process uses it (`baseUrl` of the Pi
   * init config — for the gateway card, the loopback proxy it is rewritten to).
   * `undefined` or blank: the connection talks to Pi's built-in endpoint for its
   * provider, which is that provider's public API.
   */
  baseUrl: string | undefined;
}

/**
 * @param activeModel Bare (no `pi/` prefix) model ID of the active session/connection. Used
 *   by the ChatGPT backend provider to search with a model the account actually supports,
 *   instead of a hardcoded one that may have been retired (craft-agents-oss#1023, UB4.3).
 */
export function resolveSearchProvider(piAuth: SearchProviderAuthConfig | undefined, endpoint: SearchProviderEndpoint, activeModel?: string): WebSearchProvider {
  const provider = piAuth?.provider;
  const apiKey = getApiKey(piAuth);
  const openAiCodexAccess = getOpenAiCodexAccessToken(piAuth);
  const nativeAllowed = (native: keyof typeof PROVIDER_PUBLIC_API_HOSTS) =>
    provider === native && connectionTalksToPublicApi(native, endpoint);

  // OpenAI with API key → standard Responses API
  if (nativeAllowed('openai') && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://api.openai.com/v1',
      apiKey,
    });
  }

  // ChatGPT Plus (OpenAI OAuth bearer token) → ChatGPT backend endpoint
  // Supports both oauth.access and api_key.key token shapes.
  if (nativeAllowed('openai-codex') && openAiCodexAccess) {
    const accountId = extractChatGptAccountId(openAiCodexAccess);
    if (accountId) {
      return new ChatGPTBackendSearchProvider(
        openAiCodexAccess,
        accountId,
        activeModel ? { model: activeModel } : undefined,
      );
    }
    // Can't extract accountId (malformed/non-JWT token) → fall through to DDG
  }

  // OpenRouter → same Responses API format, different base URL
  if (nativeAllowed('openrouter') && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey,
      model: 'openai/gpt-4o-mini',
    });
  }

  // Google → Gemini API with native Google Search grounding
  if (nativeAllowed('google') && apiKey) {
    return new GoogleSearchProvider(apiKey);
  }

  // Vercel AI Gateway is currently not wired to provider-native search routing.
  // It intentionally falls back to DDG until we add an explicit Responses API mapping.

  // Universal fallback — no API key required. Also where every connection whose
  // own endpoint is not its provider's public API lands (F1.853).
  return new DDGSearchProvider();
}

/**
 * F1.853 — the host each provider-native search request goes to (the providers'
 * own `API_BASE`s and the two `apiBase`s above). Pi's BUILT-IN endpoint for each
 * provider is on the same host — pinned through Pi's own registry by the F1.867
 * arm of `resolve-provider.test.ts` (pi-ai 0.85.1: `api.openai.com/v1`,
 * `chatgpt.com/backend-api`, `openrouter.ai/api` (and `/api/v1`),
 * `generativelanguage.googleapis.com/v1beta`) — which is why a connection with no
 * base URL of its own keeps native search.
 */
const PROVIDER_PUBLIC_API_HOSTS = {
  openai: 'api.openai.com',
  'openai-codex': 'chatgpt.com',
  openrouter: 'openrouter.ai',
  google: 'generativelanguage.googleapis.com',
} as const;

/**
 * Exact host equality, never a suffix or prefix match; a base URL that does not
 * parse is not the provider's API, so it fails closed to DuckDuckGo.
 */
function connectionTalksToPublicApi(
  provider: keyof typeof PROVIDER_PUBLIC_API_HOSTS,
  endpoint: SearchProviderEndpoint,
): boolean {
  const baseUrl = endpoint.baseUrl?.trim();
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === PROVIDER_PUBLIC_API_HOSTS[provider];
  } catch {
    return false;
  }
}

function getApiKey(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'api_key') return undefined;
  return typeof piAuth.credential.key === 'string' && piAuth.credential.key.length > 0
    ? piAuth.credential.key
    : undefined;
}

function getOAuthAccess(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'oauth') return undefined;
  const access = (piAuth.credential as { access?: string }).access;
  return typeof access === 'string' && access.length > 0 ? access : undefined;
}

/**
 * openai-codex tokens may arrive as either:
 *  - oauth.access (legacy/explicit oauth shape), or
 *  - api_key.key (current runtime shape for ChatGPT Plus OAuth bearer token)
 */
function getOpenAiCodexAccessToken(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.provider !== 'openai-codex') return undefined;
  return getOAuthAccess(piAuth) ?? getApiKey(piAuth);
}
