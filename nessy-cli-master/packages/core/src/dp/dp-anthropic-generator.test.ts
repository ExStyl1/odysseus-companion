import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { propagation } from '@opentelemetry/api';
import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../config/config.js';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { DpContentGenerator } from './dp-content-generator.js';
import { performNessyAuth } from './dp-auth-service.js';
import { retryWithBackoff } from '../utils/retry.js';
import { isRateLimitError } from '../utils/rateLimit.js';
import { isNestorAuthError } from './byok-policy.js';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn<typeof fetch>() }));
vi.mock('./dp-auth-service.js', () => ({ performNessyAuth: vi.fn() }));
vi.mock('../utils/runtimeFetchOptions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/runtimeFetchOptions.js')>()),
  buildRuntimeFetchOptions: () => ({ fetch: mockFetch }),
}));

const anthropicBaseUrl = 'https://nessy.test/api/v1/cli/anthropic';
const openaiBaseUrl = 'https://nessy.test/api/v1/cli/openai-like/v1';
const anthropicModel = 'byok/zai/glm-test';
const gatewayAuthError = {
  kind: 'Error',
  code: 'EUNAUTHORIZED',
  userError: 'Access credentials are invalid',
  systemError: 'Access credentials are invalid',
  detail: { code: 401 },
};

function anthropicMessage(
  content: unknown[] = [{ type: 'text', text: 'hello' }],
) {
  return {
    id: 'msg-1',
    type: 'message',
    role: 'assistant',
    model: anthropicModel,
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  };
}

function openaiMessage() {
  return {
    id: 'completion-1',
    object: 'chat.completion',
    created: 0,
    model: 'tgpt/test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
}

function sse(events: Array<{ type: string; [key: string]: unknown }>) {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

async function collect(stream: AsyncGenerator<GenerateContentResponse>) {
  const chunks: GenerateContentResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// [nessy-fork] dp-auth-anthropic-generator
describe('DP protocol transport', () => {
  let generatorConfig: ContentGeneratorConfig;
  let cliConfig: Config;
  let sessionId: string;
  const request = (): GenerateContentParameters => ({
    model: generatorConfig.model,
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  });
  const wireRequest = (index = 0) => {
    const [url, init] = mockFetch.mock.calls[index];
    return {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    };
  };

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(performNessyAuth).mockReset();
    vi.stubEnv('NESSY_CLI_DP_AUTH_TOKEN', '');
    generatorConfig = {
      authType: AuthType.DP_AUTH,
      model: anthropicModel,
      apiKey: 'dp-jwt',
      baseUrl: anthropicBaseUrl,
      protocol: 'anthropic_messages',
      maxRetries: 0,
    };
    sessionId = 'session-1';
    cliConfig = {
      dpByokCatalogUnavailable: false,
      getCliVersion: () => '1.0.0',
      getProxy: () => undefined,
      getSessionId: () => sessionId,
      getChannel: () => undefined,
      getContentGeneratorConfig: () => generatorConfig,
    } as unknown as Config;
    mockFetch.mockImplementation(async () => Response.json(anthropicMessage()));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([401, 403])(
    'does not retry upstream %s or start DP login',
    async (status) => {
      generatorConfig.maxRetries = 3;
      mockFetch.mockResolvedValue(
        Response.json(
          {
            type: 'error',
            error: { type: 'api_error', message: 'provider error' },
          },
          { status, headers: { 'X-Nestor-Error-Source': 'upstream' } },
        ),
      );
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      await expect(
        generator.generateContent(request(), 'prompt-1'),
      ).rejects.toThrow('provider error');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(performNessyAuth).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['anthropic_messages', 429],
    ['anthropic_messages', 503],
    ['openai_chat_completions', 429],
    ['openai_chat_completions', 503],
  ] as const)(
    'retries BYOK %s HTTP %s using the SDK settings',
    async (protocol, status) => {
      generatorConfig.protocol = protocol;
      generatorConfig.baseUrl =
        protocol === 'anthropic_messages' ? anthropicBaseUrl : openaiBaseUrl;
      generatorConfig.maxRetries = 1;
      mockFetch
        .mockResolvedValueOnce(
          Response.json(
            {
              type: 'error',
              error: { type: 'api_error', message: 'try again' },
            },
            {
              status,
              headers: {
                'retry-after-ms': '1',
                'X-Nestor-Error-Source': 'upstream',
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            protocol === 'anthropic_messages'
              ? anthropicMessage()
              : openaiMessage(),
          ),
        );
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      const response = await generator.generateContent(request(), 'prompt-1');
      expect(response.text).toBe('hello');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(wireRequest(1).body.model).toBe(anthropicModel);
      expect(performNessyAuth).not.toHaveBeenCalled();
    },
  );

  it.each(['anthropic_messages', 'openai_chat_completions'] as const)(
    'preserves BYOK errors for wrapper retries over %s',
    async (protocol) => {
      generatorConfig.protocol = protocol;
      generatorConfig.baseUrl =
        protocol === 'anthropic_messages' ? anthropicBaseUrl : openaiBaseUrl;
      mockFetch
        .mockResolvedValueOnce(
          Response.json(
            {
              type: 'error',
              error: { type: 'api_error', message: 'try again' },
            },
            { status: 503 },
          ),
        )
        .mockResolvedValueOnce(
          Response.json(
            protocol === 'anthropic_messages'
              ? anthropicMessage()
              : openaiMessage(),
          ),
        );
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      const response = await retryWithBackoff(
        () => generator.generateContent(request(), 'prompt-1'),
        {
          maxAttempts: 2,
          initialDelayMs: 1,
          maxDelayMs: 1,
          authType: AuthType.DP_AUTH,
        },
      );
      expect(response.text).toBe('hello');
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(wireRequest(1).body.model).toBe(anthropicModel);
      expect(performNessyAuth).not.toHaveBeenCalled();
    },
  );

  it.each([
    [409, 'BYOK_KEY_MISSING'],
    [503, 'BYOK_KEYS_UNAVAILABLE'],
  ])('allows a manual retry after backend %s %s', async (status, code) => {
    mockFetch.mockImplementation(async () =>
      Response.json(
        {
          type: 'error',
          error: { type: 'api_error', code, message: 'backend error' },
        },
        { status },
      ),
    );
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    await expect(
      generator.generateContent(request(), 'prompt-1'),
    ).rejects.toThrow('backend error');
    await expect(
      generator.generateContent(request(), 'prompt-2'),
    ).rejects.toThrow('backend error');
    expect(generatorConfig.model).toBe(anthropicModel);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(performNessyAuth).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue(Response.json(anthropicMessage()));
    await expect(
      generator.generateContent(request(), 'prompt-3'),
    ).resolves.toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    [403, 'BYOK_ACCESS_DENIED', 'permission_error'],
    [503, 'BYOK_KEYS_UNAVAILABLE', 'api_error'],
    [502, 'BYOK_UPSTREAM_ERROR', 'api_error'],
  ])(
    'preserves backend %s %s details without starting login',
    async (status, code, type) => {
      mockFetch.mockResolvedValue(
        Response.json(
          { type: 'error', error: { type, code, message: 'backend error' } },
          { status, headers: { 'retry-after': '2' } },
        ),
      );
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      await expect(
        generator.generateContent(request(), 'prompt-1'),
      ).rejects.toMatchObject({
        message: 'backend error',
        status,
        error: {
          type: 'error',
          error: { type, code, message: 'backend error' },
        },
        headers: expect.objectContaining({ 'retry-after': '2' }),
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(performNessyAuth).not.toHaveBeenCalled();
    },
  );

  it('blocks an unavailable catalog without treating it as a removed connection', async () => {
    cliConfig.dpByokCatalogUnavailable = true;
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    await expect(
      generator.generateContent(request(), 'prompt-1'),
    ).rejects.toThrow('temporarily unavailable');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses the standard non-streaming fallback for an empty BYOK stream', async () => {
    mockFetch.mockResolvedValueOnce(sse([]));
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    const stream = await generator.generateContentStream(request(), 'prompt-1');
    expect((await collect(stream)).map((chunk) => chunk.text).join('')).toBe(
      'hello',
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(wireRequest().body.stream).toBe(true);
    expect(wireRequest(1).body.stream).toBeUndefined();
    expect(wireRequest(1).body.model).toBe(anthropicModel);
    expect(performNessyAuth).not.toHaveBeenCalled();
  });

  it('sends Anthropic Messages to our backend using only DP credentials', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'personal-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'personal-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://provider.invalid');
    generatorConfig.customHeaders = {
      'x-api-key': 'custom-key',
      'X-Byok-Key': 'custom-byok',
      Authorization: 'wrong',
      'X-Test': 'preserved',
    };
    const response = await new DpContentGenerator(
      generatorConfig,
      cliConfig,
    ).generateContent(request(), 'prompt-1');
    const wire = wireRequest();
    expect(wire.url).toBe(`${anthropicBaseUrl}/v1/messages`);
    expect(wire.body.model).toBe(anthropicModel);
    expect(wire.body.messages).toMatchObject([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(response.text).toBe('hello');
    expect(wire.headers.get('nestor-token')).toBe('dp-jwt');
    for (const name of ['authorization', 'x-api-key', 'x-byok-key', 'x-app'])
      expect(wire.headers.get(name)).toBeNull();
    expect(wire.headers.get('x-test')).toBe('preserved');
    expect(wire.headers.get('user-agent')).toMatch(/^NessyCLI\/1\.0\.0 /);
  });

  it('uses delegated Bearer and reads session/trace headers on each request', async () => {
    vi.stubEnv('NESSY_CLI_DP_AUTH_TOKEN', 'dp-jwt');
    vi.spyOn(propagation, 'inject').mockImplementation(
      (_context, carrier, setter) => {
        setter?.set(
          carrier,
          'traceparent',
          '00-11111111111111111111111111111111-2222222222222222-01',
        );
      },
    );
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    await generator.generateContent(request(), 'prompt-1');
    sessionId = 'session-2';
    await generator.generateContent(request(), 'prompt-2');
    expect(wireRequest().headers.get('authorization')).toBe('Bearer dp-jwt');
    expect(wireRequest().headers.get('nestor-token')).toBeNull();
    expect(
      wireRequest().headers.get('x-serving-platform-client-session-id'),
    ).toBe('session-1');
    expect(
      wireRequest(1).headers.get('x-serving-platform-client-session-id'),
    ).toBe('session-2');
    expect(wireRequest(1).headers.get('traceparent')).toBe(
      '00-11111111111111111111111111111111-2222222222222222-01',
    );
  });

  it.each([
    ['anthropic_messages', 'DP_AUTH_REQUIRED'],
    ['anthropic_messages', 'EUNAUTHORIZED'],
    ['openai_chat_completions', 'DP_AUTH_REQUIRED'],
    ['openai_chat_completions', 'EUNAUTHORIZED'],
  ] as const)(
    'refreshes the token on %s after %s and updates actual HTTP headers',
    async (protocol, code) => {
      generatorConfig.protocol = protocol;
      const isAnthropic = protocol === 'anthropic_messages';
      generatorConfig.baseUrl = isAnthropic ? anthropicBaseUrl : openaiBaseUrl;
      const response = isAnthropic ? anthropicMessage() : openaiMessage();
      mockFetch
        .mockResolvedValueOnce(
          Response.json(
            code === 'EUNAUTHORIZED'
              ? gatewayAuthError
              : {
                  error: {
                    message: 'expired',
                    type: 'authentication_error',
                    code,
                  },
                },
            { status: 401 },
          ),
        )
        .mockResolvedValueOnce(Response.json(response))
        .mockResolvedValueOnce(Response.json(response));
      vi.mocked(performNessyAuth).mockResolvedValue({
        jwt: 'refreshed-jwt',
        username: 'user',
        userId: 'id',
        expiresAt: Date.now() + 60000,
        models: [],
      });
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      await generator.generateContent(request(), 'prompt-1');
      await generator.generateContent(request(), 'prompt-2');
      expect(performNessyAuth).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(wireRequest().headers.get('nestor-token')).toBe('dp-jwt');
      for (const index of [1, 2]) {
        expect(wireRequest(index).headers.get('nestor-token')).toBe(
          'refreshed-jwt',
        );
        expect(wireRequest(index).headers.get('authorization')).toBeNull();
      }
      expect(generatorConfig.apiKey).toBe('refreshed-jwt');
    },
  );

  it('refreshes the token after a gateway 401 before an Anthropic stream starts', async () => {
    mockFetch
      .mockResolvedValueOnce(Response.json(gatewayAuthError, { status: 401 }))
      .mockResolvedValueOnce(
        sse([
          { type: 'message_start', message: anthropicMessage([]) },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 0 },
          },
          { type: 'message_stop' },
        ]),
      );
    vi.mocked(performNessyAuth).mockResolvedValue({
      jwt: 'refreshed-jwt',
      username: 'user',
      userId: 'id',
      expiresAt: Date.now() + 60000,
      models: [],
    });
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    const chunks = await collect(
      await generator.generateContentStream(request(), 'prompt-1'),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(performNessyAuth).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(wireRequest().headers.get('nestor-token')).toBe('dp-jwt');
    expect(wireRequest(1).headers.get('nestor-token')).toBe('refreshed-jwt');
    expect(wireRequest(1).body.stream).toBe(true);
  });

  it.each(['sync', 'stream'] as const)(
    'does not refresh or retry upstream EUNAUTHORIZED in %s mode',
    async (mode) => {
      mockFetch.mockResolvedValue(
        Response.json(gatewayAuthError, {
          status: 401,
          headers: { 'X-Nestor-Error-Source': 'upstream' },
        }),
      );
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      await expect(
        mode === 'sync'
          ? generator.generateContent(request(), 'prompt-1')
          : generator.generateContentStream(request(), 'prompt-1'),
      ).rejects.toThrow('EUNAUTHORIZED');
      expect(performNessyAuth).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(generatorConfig.apiKey).toBe('dp-jwt');
    },
  );

  it('keeps legacy OpenAI requests working when protocol is missing', async () => {
    generatorConfig.protocol = undefined;
    generatorConfig.baseUrl = openaiBaseUrl;
    mockFetch.mockResolvedValue(Response.json(openaiMessage()));
    const response = await new DpContentGenerator(
      generatorConfig,
      cliConfig,
    ).generateContent(request(), 'prompt-1');
    expect(response.text).toBe('hello');
    expect(wireRequest().url).toBe(`${openaiBaseUrl}/chat/completions`);
    expect(wireRequest().body.metadata).toMatchObject({
      sessionId: 'session-1',
      promptId: 'prompt-1',
    });
  });

  it('converts tool history when switching Anthropic to OpenAI and back', async () => {
    mockFetch.mockImplementation(async (url) =>
      Response.json(
        String(url).includes('/chat/completions')
          ? openaiMessage()
          : anthropicMessage(),
      ),
    );
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    const contents = [
      { role: 'user', parts: [{ text: 'read a file' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_1',
              name: 'read_file',
              args: { path: 'a.txt' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_1',
              name: 'read_file',
              response: { output: 'file text' },
            },
          },
        ],
      },
    ];
    for (const protocol of [
      'anthropic_messages',
      'openai_chat_completions',
      'anthropic_messages',
    ] as const) {
      generatorConfig.protocol = protocol;
      generatorConfig.baseUrl =
        protocol === 'anthropic_messages' ? anthropicBaseUrl : openaiBaseUrl;
      generatorConfig.model =
        protocol === 'anthropic_messages' ? anthropicModel : 'tgpt/test';
      await generator.generateContent(
        { model: generatorConfig.model, contents },
        'prompt-1',
      );
    }
    expect(wireRequest().body.messages[1].content[0]).toMatchObject({
      type: 'tool_use',
      id: 'call_1',
      name: 'read_file',
    });
    expect(wireRequest(1).body.messages[1].tool_calls[0].id).toBe('call_1');
    expect(wireRequest(1).body.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    });
    expect(wireRequest(2).body.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_1',
    });
    expect(performNessyAuth).not.toHaveBeenCalled();
  });

  it('converts native SSE text and tool calls into internal responses', async () => {
    mockFetch.mockResolvedValue(
      sse([
        { type: 'message_start', message: anthropicMessage([]) },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'call_1',
            name: 'read_file',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]),
    );
    const chunks = await collect(
      await new DpContentGenerator(
        generatorConfig,
        cliConfig,
      ).generateContentStream(request(), 'prompt-1'),
    );
    const parts = chunks.flatMap(
      (chunk) => chunk.candidates?.[0]?.content?.parts ?? [],
    );
    expect(parts).toContainEqual(expect.objectContaining({ text: 'hello' }));
    expect(parts).toContainEqual(
      expect.objectContaining({
        functionCall: {
          id: 'call_1',
          name: 'read_file',
          args: { path: 'a.txt' },
        },
      }),
    );
    expect(wireRequest().body.stream).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['authentication_error', 'permission_error', 'rate_limit_error'])(
    'surfaces SSE %s without starting login',
    async (type) => {
      mockFetch.mockResolvedValue(
        sse([
          { type: 'message_start', message: anthropicMessage([]) },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'partial' },
          },
          {
            type: 'error',
            error: { type, message: 'provider error' },
          },
        ]),
      );
      const stream = await new DpContentGenerator(
        generatorConfig,
        cliConfig,
      ).generateContentStream(request(), 'prompt-1');
      await expect(collect(stream)).rejects.toThrow('provider error');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(performNessyAuth).not.toHaveBeenCalled();
    },
  );

  it('preserves SSE provider codes for standard retry classification', async () => {
    const error = {
      type: 'rate_limit_error',
      code: 1302,
      message: 'please wait before continuing',
    };
    mockFetch.mockResolvedValue(sse([{ type: 'error', error }]));
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    const stream = await generator.generateContentStream(request(), 'prompt-1');
    const failure = await collect(stream).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: error.message, error });
    expect(isRateLimitError(failure)).toBe(true);
    expect(isNestorAuthError(failure)).toBe(false);
    expect(performNessyAuth).not.toHaveBeenCalled();
  });

  it.each(['sync', 'stream'] as const)(
    'passes cancellation to the %s HTTP request',
    async (mode) => {
      const controller = new AbortController();
      mockFetch.mockImplementation(async (_url, init) => {
        controller.abort();
        expect(init?.signal?.aborted).toBe(true);
        throw new DOMException('Aborted', 'AbortError');
      });
      const generator = new DpContentGenerator(generatorConfig, cliConfig);
      const input = {
        ...request(),
        config: { abortSignal: controller.signal },
      };
      await expect(
        mode === 'sync'
          ? generator.generateContent(input, 'prompt-1')
          : generator.generateContentStream(input, 'prompt-1'),
      ).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(performNessyAuth).not.toHaveBeenCalled();
    },
  );

  it('rejects unsupported protocols before sending a request', () => {
    Object.assign(generatorConfig, { protocol: 'unknown_protocol' });
    expect(() => new DpContentGenerator(generatorConfig, cliConfig)).toThrow(
      /protocol/i,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('requires a backend URL instead of falling back to the Anthropic API', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://provider.invalid');
    generatorConfig.baseUrl = undefined;
    expect(() => new DpContentGenerator(generatorConfig, cliConfig)).toThrow(
      /baseUrl/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('honors synchronous generation mode through the streaming interface', async () => {
    const generator = new DpContentGenerator(generatorConfig, cliConfig);
    const chunks = await collect(
      await generator.generateContentStream(request(), 'prompt-1', 'sync'),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('hello');
    expect(wireRequest().body.stream).not.toBe(true);
  });
});
