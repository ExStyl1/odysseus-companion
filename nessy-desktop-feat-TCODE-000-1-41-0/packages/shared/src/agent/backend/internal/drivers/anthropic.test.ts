import { afterEach, describe, expect, it } from 'bun:test';
import {
  anthropicDriver,
  buildClaudeRuntimeWireRouter,
  stripClaudeModelSelectorSuffix,
} from './anthropic.ts';
import type { UpstreamTarget } from '@nessy-agent/codex-responses-adapter/nestor-client';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('anthropicDriver.fetchModels', () => {
  it('filters deprecated Opus models from live startup refresh and prefers Opus 4.8 as default', async () => {
    const inits: Array<{ redirect?: RequestInit['redirect']; hasTimeoutSignal: boolean }> = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      inits.push({
        redirect: init?.redirect,
        hasTimeoutSignal: init?.signal instanceof AbortSignal,
      });
      return new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z', type: 'model' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
      ],
      has_more: false,
      first_id: 'claude-opus-4-6',
      last_id: 'claude-sonnet-4-6',
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(result.serverDefault).toBe('claude-opus-4-8');
    expect(result.models.map(m => m.id)).toEqual([
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    expect(result.models[0]!.name).toBe('Opus 4.8');
    expect(result.models[0]!.contextWindow).toBe(1_000_000);

    // llm-gateway-protocol.md:159 — a redirect on the credentialed model-list
    // request must be a failure (the x-api-key header would be replayed to the
    // redirect target), and the threaded timeoutMs must actually reach fetch.
    expect(inits).toHaveLength(1);
    expect(inits[0]).toEqual({ redirect: 'error', hasTimeoutSignal: true });
  });

  // F1.1214 — the Models API's `max_input_tokens` is read before the registry
  // and the 200K fallback (platform.claude.com/docs/en/api/models/list.md).
  it('takes each model window from max_input_tokens first, then the registry, then 200K', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        // Not in the registry: the API's window is the only source that knows it.
        { id: 'claude-opus-9', display_name: 'Claude Opus 9', created_at: '2027-01-01T00:00:00Z', type: 'model', max_input_tokens: 2_000_000 },
        // In the registry at 200K; the fixture's API states 1M, and the API wins.
        // (F1.1221: Sonnet 4.5, since Sonnet 4.6 is in the registry at 1M now.)
        { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', created_at: '2026-01-01T00:00:00Z', type: 'model', max_input_tokens: 1_000_000 },
        // Boundary: null and the page's example `0` are "not told" — the registry answers.
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model', max_input_tokens: null },
        { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-01T00:00:00Z', type: 'model', max_input_tokens: 0 },
        // Neither source knows it: 200K.
        { id: 'claude-zeta-1', display_name: 'Claude Zeta 1', created_at: '2027-01-01T00:00:00Z', type: 'model' },
      ],
      has_more: false,
      first_id: 'claude-opus-9',
      last_id: 'claude-zeta-1',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    const windows = Object.fromEntries(result.models.map(m => [m.id, m.contextWindow]));
    expect(windows).toEqual({
      'claude-opus-9': 2_000_000,
      'claude-sonnet-4-5-20250929': 1_000_000,
      'claude-opus-4-8': 1_000_000,
      'claude-opus-4-7': 1_000_000,
      'claude-zeta-1': 200_000,
    });
  });

  // T7 / Step 0b(b). `providerTypeToAgentProvider('claude-runtime')` is
  // 'anthropic', so `fetchBackendModels` dispatches a claude-runtime connection
  // to THIS driver. Its endpoint semantics are Anthropic-only: it would GET
  // `<gateway>/v1/models` with the Nestor JWT in `x-api-key`. The live refresh
  // for this provider type is server-core's gateway-aware
  // `MODEL_FETCHERS['claude-runtime']`.
  it('never calls the network for a claude-runtime connection — it returns the stored catalog', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'claude-gateway',
        name: 'Claude Code (Nessy Gateway)',
        providerType: 'claude-runtime',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
        defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
        models: [{ id: 'tgpt/qwen35-397b-a17b-fp8' }, { id: 'tgpt/qwen36-35b-a3b-fp8' }],
        createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'nestor-jwt' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(fetchCalls).toBe(0);
    expect(result.models.map(m => m.id)).toEqual([
      'tgpt/qwen35-397b-a17b-fp8',
      'tgpt/qwen36-35b-a3b-fp8',
    ]);
    expect(result.serverDefault).toBe('tgpt/qwen35-397b-a17b-fp8');
  });

  it('does not throw for a claude-runtime connection with no catalog yet', async () => {
    globalThis.fetch = (async () => { throw new Error('network must not be reached'); }) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'byo-claude',
        name: 'BYO Claude',
        providerType: 'claude-runtime',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://byo.example.test/v1',
        createdAt: Date.now(),
      } as any,
      credentials: {},
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(result.models).toEqual([]);
  });
});

// T7 / Step 0b(a). The setup form's Test button lands on
// `testBackendConnection`, which — for the 'anthropic' AgentProvider — sets a raw
// `ANTHROPIC_BASE_URL` + key and runs `runMiniCompletion` WITHOUT calling
// `postInit`. For a claude-runtime connection that points the direct Claude SDK
// at an OpenAI-shaped gateway URL and reports a healthy connection as broken.
// The driver intercepts and answers with the same structural check T6 gave
// `validateStoredConnection`; every other connection still falls through
// (`null` = declined) to the generic subprocess test.
describe('anthropicDriver.testConnection', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    provider: 'anthropic' as const,
    apiKey: 'sk-test',
    model: 'tgpt/qwen35-397b-a17b-fp8',
    baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
    connection: { providerType: 'claude-runtime' } as any,
    hostRuntime: {} as any,
    resolvedPaths: {} as any,
    timeoutMs: 20_000,
    ...over,
  });

  it('declines (null) for a direct anthropic connection — generic path unchanged', async () => {
    expect(await anthropicDriver.testConnection!(args({
      connection: { providerType: 'anthropic' } as any,
      baseUrl: undefined,
    }))).toBeNull();
    expect(await anthropicDriver.testConnection!(args({ connection: undefined }))).toBeNull();
  });

  it('accepts the gateway endpoint without spending a turn or opening a socket', async () => {
    globalThis.fetch = (async () => { throw new Error('network must not be reached'); }) as unknown as typeof fetch;

    expect(await anthropicDriver.testConnection!(args())).toEqual({ success: true });
  });

  it('accepts a BYO endpoint that carries a key', async () => {
    globalThis.fetch = (async () => { throw new Error('network must not be reached'); }) as unknown as typeof fetch;

    expect(await anthropicDriver.testConnection!(args({
      baseUrl: 'https://byo.example.test/v1',
    }))).toEqual({ success: true });
  });

  it('rejects a claude-runtime connection with no endpoint rather than falling back to Anthropic', async () => {
    const result = await anthropicDriver.testConnection!(args({ baseUrl: '   ' }));

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('no endpoint URL configured');
  });

  it('rejects a remote BYO endpoint with no key', async () => {
    const result = await anthropicDriver.testConnection!(args({
      baseUrl: 'https://byo.example.test/v1',
      apiKey: '   ',
    }));

    expect(result?.success).toBe(false);
    expect(result?.error).toContain('API key');
  });

  it('accepts a keyless loopback endpoint (Ollama and friends)', async () => {
    // Mirrors `setupTestRequiresApiKey`: only a non-loopback endpoint must be keyed.
    expect(await anthropicDriver.testConnection!(args({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    }))).toEqual({ success: true });
  });
});

/**
 * P3.319 — the wire router must match the model the SDK NAMES, not only the
 * spelling the catalogue happens to use.
 *
 * `chatImpl` appends `[1m]` per query for a 1M-window model, so an exact
 * `Set.has` missed precisely the model whose endpoint speaks Messages natively
 * and sent it through the OpenAI-wire translator instead — silently, and with
 * the literal `…[1m]` id forwarded to an endpoint that does not know it.
 *
 * Every case here comes in a PAIR: a spelling that must route natively and one
 * that must not. "Strip the suffix" and "match everything" are indistinguishable
 * from the positive cases alone, which is what the controls below exist to
 * separate.
 */
describe('buildClaudeRuntimeWireRouter — selector-suffix normalisation (P3.319)', () => {
  // `as const satisfies` rather than a `: UpstreamTarget` annotation: the
  // annotation widens these to the whole union, which both hides `baseUrl` from
  // the passthrough expectation below and lets `kind` widen to `string`.
  const BYO = { kind: 'openai-compatible', baseUrl: 'https://llm.example/v1' } as const satisfies UpstreamTarget;
  const passthrough = { kind: 'anthropic-messages', baseUrl: BYO.baseUrl } as const satisfies UpstreamTarget;

  function routerFor(models: readonly unknown[], upstream: UpstreamTarget = BYO) {
    return buildClaudeRuntimeWireRouter({ models } as never, upstream);
  }

  it('routes both spellings of a marked model to the native passthrough', () => {
    const router = routerFor([{ id: 'claude-opus-4-6', wire: 'anthropic-messages' }]);
    // The measured case: `getModelContextWindow('claude-opus-4-6')` is 1_000_000,
    // so this is the id the SDK actually names on such a session.
    expect(router?.('claude-opus-4-6[1m]')).toEqual(passthrough);
    expect(router?.('claude-opus-4-6')).toEqual(passthrough);
  });

  it('normalises the CATALOGUE side too, so a suffixed entry still pairs', () => {
    // A gateway alias may carry the selector itself (`tgpt/qwen35[1m]` is a real
    // shape — see `claude-1m-context-correction-env.test.ts`). Normalising only
    // the incoming id would have broken this pairing while fixing the other one.
    const router = routerFor([{ id: 'anthropic/opus[1m]', wire: 'anthropic-messages' }]);
    expect(router?.('anthropic/opus[1m]')).toEqual(passthrough);
    expect(router?.('anthropic/opus')).toEqual(passthrough);
  });

  it('does NOT route an unmarked model, in either spelling', () => {
    const router = routerFor([
      { id: 'claude-opus-4-6', wire: 'anthropic-messages' },
      { id: 'qwen' },
    ]);
    expect(router?.('qwen')).toBeUndefined();
    expect(router?.('qwen[1m]')).toBeUndefined();
  });

  it('does NOT route a model absent from the catalogue', () => {
    const router = routerFor([{ id: 'claude-opus-4-6', wire: 'anthropic-messages' }]);
    expect(router?.('some-other-model[1m]')).toBeUndefined();
  });

  it('still builds no router at all where there is nothing to route', () => {
    // Unchanged by this row, and asserted so the normalisation cannot be read as
    // having widened the router's existence: gateway mode publishes no Messages
    // endpoint, and a catalogue with no marked model has nothing to pair.
    expect(routerFor([{ id: 'claude-opus-4-6', wire: 'anthropic-messages' }], { kind: 'nestor' }))
      .toBeUndefined();
    expect(routerFor(['plain', { id: 'qwen' }])).toBeUndefined();
  });
});

describe('stripClaudeModelSelectorSuffix', () => {
  it('removes a trailing selector and leaves everything else alone', () => {
    expect(stripClaudeModelSelectorSuffix('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(stripClaudeModelSelectorSuffix('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(stripClaudeModelSelectorSuffix('  claude-opus-4-6[1m]  ')).toBe('claude-opus-4-6');
  });

  it('does not collapse an id that opens with a bracket to the empty string', () => {
    // The `> 0` guard. An id spelled `[1m]` is not a selector on nothing; slicing
    // at index 0 would key every such model to `''` and pair them all together.
    expect(stripClaudeModelSelectorSuffix('[1m]')).toBe('[1m]');
  });

  it('does not fold case, unlike its capability-row sibling', () => {
    // `claude-model-capabilities.ts` lowercases because it is looking up a row;
    // a wire id is matched against the catalogue the user wrote.
    expect(stripClaudeModelSelectorSuffix('Claude-Opus-4-6[1m]')).toBe('Claude-Opus-4-6');
  });
});
