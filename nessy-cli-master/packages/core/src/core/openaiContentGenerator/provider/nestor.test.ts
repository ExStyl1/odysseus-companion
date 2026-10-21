/**
 * Tests for NestorOpenAICompatibleProvider — primary completion path
 * for all model requests. Covers buildHeaders() across all four
 * combinations of (authType, NESSY_CLI_DP_AUTH_TOKEN env), plus customHeaders
 * precedence over defaults.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import {
  context,
  propagation,
  trace,
  ROOT_CONTEXT,
  TraceFlags,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from '@opentelemetry/api';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import {
  NestorOpenAICompatibleProvider,
  SERVING_PLATFORM_SESSION_ID_HEADER,
  wrapFetchWithSessionIdHeader,
  wrapFetchWithTraceContext,
} from './nestor.js';

vi.mock('../../contentGenerator.js', () => ({
  AuthType: {
    USE_OPENAI: 'openai',
    DP_AUTH: 'dp-auth',
    USE_GEMINI: 'gemini',
    USE_VERTEX_AI: 'vertex-ai',
    USE_ANTHROPIC: 'anthropic',
  },
}));

function makeCliConfigStub(version = '0.0.0-test'): Config {
  return {
    getCliVersion: () => version,
    getProxy: () => undefined,
    getSessionId: () => 'test-session',
    getChannel: () => undefined,
    getContentGeneratorConfig: () => undefined,
  } as unknown as Config;
}

function makeProvider(
  contentGeneratorConfig: Partial<ContentGeneratorConfig>,
): NestorOpenAICompatibleProvider {
  return new NestorOpenAICompatibleProvider(
    contentGeneratorConfig as ContentGeneratorConfig,
    makeCliConfigStub(),
  );
}

describe('NestorOpenAICompatibleProvider.buildHeaders', () => {
  const originalEnv = process.env['NESSY_CLI_DP_AUTH_TOKEN'];

  beforeEach(() => {
    delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
    } else {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = originalEnv;
    }
  });

  it('does not add auth headers when authType is not DP_AUTH', () => {
    const provider = makeProvider({
      authType: AuthType.USE_OPENAI,
      apiKey: 'openai-key',
    });

    const headers = provider.buildHeaders();

    expect(headers['Nestor-Token']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['User-Agent']).toContain('NessyCLI/');
  });

  it('sends Nestor-Token for DP_AUTH when NESSY_CLI_DP_AUTH_TOKEN env is not set', () => {
    const provider = makeProvider({
      authType: AuthType.DP_AUTH,
      apiKey: 'dp-exchanged-jwt',
    });

    const headers = provider.buildHeaders();

    expect(headers['Nestor-Token']).toBe('dp-exchanged-jwt');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends Authorization: Bearer for DP_AUTH when NESSY_CLI_DP_AUTH_TOKEN matches apiKey', () => {
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'env-delegated-jwt';
    const provider = makeProvider({
      authType: AuthType.DP_AUTH,
      apiKey: 'env-delegated-jwt',
    });

    const headers = provider.buildHeaders();

    expect(headers['Authorization']).toBe('Bearer env-delegated-jwt');
    expect(headers['Nestor-Token']).toBeUndefined();
  });

  it('falls back to Nestor-Token when NESSY_CLI_DP_AUTH_TOKEN env differs from apiKey', () => {
    // Edge case: env was set in shell, but the JWT in apiKey came from a
    // classic dp-auth login flow. Must not mislabel as a delegated token.
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'env-delegated-jwt';
    const provider = makeProvider({
      authType: AuthType.DP_AUTH,
      apiKey: 'classic-dp-jwt',
    });

    const headers = provider.buildHeaders();

    expect(headers['Nestor-Token']).toBe('classic-dp-jwt');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('lets customHeaders override default auth headers', () => {
    // Guards against regressions in the spread order at the bottom of
    // buildHeaders() — customHeaders must win over defaultHeaders.
    process.env['NESSY_CLI_DP_AUTH_TOKEN'] = 'env-delegated-jwt';
    const provider = makeProvider({
      authType: AuthType.DP_AUTH,
      apiKey: 'env-delegated-jwt',
      customHeaders: { Authorization: 'Bearer custom-x' },
    });

    const headers = provider.buildHeaders();

    expect(headers['Authorization']).toBe('Bearer custom-x');
  });
});

describe('NestorOpenAICompatibleProvider.buildRequest', () => {
  it('keeps cache-control messages while flattening OSS tool content parts', () => {
    const provider = makeProvider({
      authType: AuthType.USE_OPENAI,
      model: 'gpt-oss-120b',
    });

    const request: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'gpt-oss-120b',
      stream: true,
      messages: [
        { role: 'system', content: 'System prompt' },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'tool text' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png' },
            },
          ] as unknown as OpenAI.Chat.ChatCompletionContentPartText[],
        },
        { role: 'user', content: 'Next request' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    };

    const result = provider.buildRequest(request, 'prompt-123');

    expect(result.messages[0].content).toEqual([
      {
        type: 'text',
        text: 'System prompt',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(result.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'tool text[Unsupported content type: image_url]',
    });
    expect(result.messages[2].content).toEqual([
      {
        type: 'text',
        text: 'Next request',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(result.tools?.[0]).toEqual(
      expect.objectContaining({
        cache_control: { type: 'ephemeral' },
      }),
    );
  });

  it('translates nested reasoning.effort into flat reasoning_effort', () => {
    const provider = makeProvider({ authType: AuthType.USE_OPENAI });

    const result = provider.buildRequest(
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'max' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-1',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('max');
    expect(result['reasoning']).toBeUndefined();
  });

  it('passes low/medium effort through verbatim (no normalization)', () => {
    const provider = makeProvider({ authType: AuthType.USE_OPENAI });

    const result = provider.buildRequest(
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'medium' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-1',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('medium');
  });

  it('keeps non-effort reasoning keys (e.g. budget_tokens) after flattening', () => {
    const provider = makeProvider({ authType: AuthType.USE_OPENAI });

    const result = provider.buildRequest(
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'high', budget_tokens: 50_000 },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-1',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('high');
    expect(result['reasoning']).toEqual({ budget_tokens: 50_000 });
  });

  it('drops reasoning remainder when non-effort keys are all undefined', () => {
    const provider = makeProvider({ authType: AuthType.USE_OPENAI });

    const result = provider.buildRequest(
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'medium', budget_tokens: undefined },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-1',
    ) as unknown as Record<string, unknown>;

    // `budget_tokens: undefined` must not survive as a stray `reasoning: {}`
    // on the wire — the empty remainder is dropped entirely.
    expect(result['reasoning_effort']).toBe('medium');
    expect(result['reasoning']).toBeUndefined();
  });

  it('translates reasoning injected via extra_body', () => {
    const provider = makeProvider({
      authType: AuthType.USE_OPENAI,
      extra_body: { reasoning: { effort: 'xhigh' } },
    });

    const result = provider.buildRequest(
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
      } as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-1',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('xhigh');
    expect(result['reasoning']).toBeUndefined();
  });

  it('leaves request untouched when no reasoning.effort is present', () => {
    const provider = makeProvider({ authType: AuthType.USE_OPENAI });

    const request = {
      model: 'qwen3-plus',
      messages: [{ role: 'user', content: 'hi' }],
    } as OpenAI.Chat.ChatCompletionCreateParams;

    const result = provider.buildRequest(request, 'prompt-1') as unknown as Record<
      string,
      unknown
    >;

    expect(result['reasoning_effort']).toBeUndefined();
    expect(result['reasoning']).toBeUndefined();
  });

  it('does not rewrite medium for other models', () => {
    const provider = makeProvider({ authType: AuthType.USE_OPENAI });

    const result = provider.buildRequest(
      {
        model: 'deepseek-reasoner',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'medium' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-1',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('medium');
  });
});

/**
 * Minimal in-memory ContextManager so `context.with(...)` actually activates a
 * context in tests (the API default is a no-op that always returns
 * ROOT_CONTEXT). Faithfully mirrors how NodeSDK's AsyncLocalStorage manager
 * makes the `nessy-cli.llm_request` span active around the outgoing fetch.
 */
class TestContextManager implements ContextManager {
  private _active: Context = ROOT_CONTEXT;
  active(): Context {
    return this._active;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const prev = this._active;
    this._active = ctx;
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this._active = prev;
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this._active = ROOT_CONTEXT;
    return this;
  }
}

/**
 * Standard-format W3C `traceparent` injector, standing in for the propagator
 * NodeSDK registers globally. This exercises the real inject path of
 * wrapFetchWithTraceContext without pulling in @opentelemetry/core.
 */
const w3cLikePropagator: TextMapPropagator = {
  inject(ctx, carrier, setter) {
    const sc = trace.getSpanContext(ctx);
    if (!sc) return;
    const flags =
      (sc.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED ? '01' : '00';
    setter.set(
      carrier,
      'traceparent',
      `00-${sc.traceId}-${sc.spanId}-${flags}`,
    );
  },
  extract(ctx) {
    return ctx;
  },
  fields() {
    return ['traceparent'];
  },
};

describe('wrapFetchWithTraceContext', () => {
  const TRACE_ID = 'fa203a14b6595a5fff155f661b6636a4';
  const SPAN_ID = 'd7bf2c675b5adf2f';

  beforeAll(() => {
    context.setGlobalContextManager(new TestContextManager());
    propagation.setGlobalPropagator(w3cLikePropagator);
  });

  afterAll(() => {
    context.disable();
    propagation.disable();
  });

  function contextWithSpan(sampled: boolean): Context {
    return trace.setSpan(
      ROOT_CONTEXT,
      trace.wrapSpanContext({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
        isRemote: false,
      }),
    );
  }

  function makeCapturingFetch(): {
    fetch: typeof fetch;
    lastInit: () => RequestInit | undefined;
  } {
    let lastInit: RequestInit | undefined;
    const fn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      lastInit = init;
      return new Response('ok');
    });
    return { fetch: fn as unknown as typeof fetch, lastInit: () => lastInit };
  }

  it('injects a traceparent carrying the active span trace_id and span_id', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithTraceContext(baseFetch);

    await context.with(contextWithSpan(true), () =>
      wrapped('https://nestor.example/v1/chat/completions', { method: 'POST' }),
    );

    const headers = new Headers(lastInit()?.headers);
    expect(headers.get('traceparent')).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it('does not add a traceparent when no span is active (telemetry disabled)', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithTraceContext(baseFetch);

    // No context.with — the default active context has no span.
    await wrapped('https://nestor.example/v1/chat/completions', {
      method: 'POST',
    });

    const headers = new Headers(lastInit()?.headers);
    expect(headers.get('traceparent')).toBeNull();
  });

  it('preserves the original request init and existing headers', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithTraceContext(baseFetch);

    await context.with(contextWithSpan(true), () =>
      wrapped('https://nestor.example/v1/chat/completions', {
        method: 'POST',
        body: '{"model":"x"}',
        headers: { 'Nestor-Token': 'jwt' },
      }),
    );

    const init = lastInit();
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"model":"x"}');
    const headers = new Headers(init?.headers);
    expect(headers.get('Nestor-Token')).toBe('jwt');
    expect(headers.get('traceparent')).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  it('falls back to the un-instrumented request when header handling throws', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithTraceContext(baseFetch);

    // An invalid header field name makes `new Headers(...)` throw inside the
    // wrapper; the request must still go through with the original init.
    const originalInit: RequestInit = {
      method: 'POST',
      headers: { 'Invalid Header Name': 'v' },
    };

    await context.with(contextWithSpan(true), () =>
      wrapped('https://nestor.example/v1/chat/completions', originalInit),
    );

    expect(baseFetch).toHaveBeenCalledOnce();
    // Fell back to the exact original init (no traceparent injected).
    expect(lastInit()).toBe(originalInit);
  });
});

// [nessy-fork] AIDT-7315 session-id-header
describe('wrapFetchWithSessionIdHeader', () => {
  function makeCapturingFetch(): {
    fetch: typeof fetch;
    lastInit: () => RequestInit | undefined;
  } {
    let lastInit: RequestInit | undefined;
    const fn = vi.fn(async (_input: unknown, init?: RequestInit) => {
      lastInit = init;
      return new Response('ok');
    });
    return { fetch: fn as unknown as typeof fetch, lastInit: () => lastInit };
  }

  it('sets the session-id header and preserves the original init', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithSessionIdHeader(baseFetch, () => 'session-42');

    await wrapped('https://nestor.example/v1/chat/completions', {
      method: 'POST',
      body: '{"model":"x"}',
      headers: { 'Nestor-Token': 'jwt' },
    });

    const init = lastInit();
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"model":"x"}');
    const headers = new Headers(init?.headers);
    expect(headers.get(SERVING_PLATFORM_SESSION_ID_HEADER)).toBe('session-42');
    expect(headers.get('Nestor-Token')).toBe('jwt');
  });

  it('reads the session id per request so /clear rotation is picked up', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    let sessionId = 'first-session';
    const wrapped = wrapFetchWithSessionIdHeader(baseFetch, () => sessionId);

    await wrapped('https://nestor.example/v1/chat/completions');
    expect(
      new Headers(lastInit()?.headers).get(SERVING_PLATFORM_SESSION_ID_HEADER),
    ).toBe('first-session');

    sessionId = 'second-session';
    await wrapped('https://nestor.example/v1/chat/completions');
    expect(
      new Headers(lastInit()?.headers).get(SERVING_PLATFORM_SESSION_ID_HEADER),
    ).toBe('second-session');
  });

  it('sends the request without the header when there is no session id', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithSessionIdHeader(baseFetch, () => undefined);

    const originalInit: RequestInit = { method: 'POST' };
    await wrapped('https://nestor.example/v1/chat/completions', originalInit);

    expect(baseFetch).toHaveBeenCalledOnce();
    expect(lastInit()).toBe(originalInit);
  });

  it('falls back to the un-instrumented request when header handling throws', async () => {
    const { fetch: baseFetch, lastInit } = makeCapturingFetch();
    const wrapped = wrapFetchWithSessionIdHeader(baseFetch, () => 'session-42');

    const originalInit: RequestInit = {
      method: 'POST',
      headers: { 'Invalid Header Name': 'v' },
    };
    await wrapped('https://nestor.example/v1/chat/completions', originalInit);

    expect(baseFetch).toHaveBeenCalledOnce();
    expect(lastInit()).toBe(originalInit);
  });
});
