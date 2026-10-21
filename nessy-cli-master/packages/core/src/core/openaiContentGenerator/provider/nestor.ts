import OpenAI from 'openai';
import { context, propagation } from '@opentelemetry/api';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import type {
  DashScopeRequestMetadata,
  ChatCompletionContentPartTextWithCache,
  ChatCompletionContentPartWithCache,
  ChatCompletionToolWithCache,
} from './types.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import {
  buildNestorAuthHeaders,
  wrapFetchWithNestorAuth,
} from '../../../dp/nestor-auth-header.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { translateReasoningEffort } from './utils.js';

// [nessy-fork] AIDT-7315 session-id-header
/**
 * Header carrying the CLI session id to LLM Proxy so requests can be grouped
 * per session server-side.
 */
export const SERVING_PLATFORM_SESSION_ID_HEADER =
  'X-Serving-Platform-Client-Session-ID';

export class NestorOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isNestorProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const { authType, baseUrl } = contentGeneratorConfig;

    if (authType === AuthType.DP_AUTH) return true;
    if (!baseUrl) return true;

    return (
      baseUrl.includes('code-completion-nestor.tcsbank.ru') ||
      baseUrl.includes('llm-proxy')
    );
  }

  override buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `NessyCLI/${version} (${process.platform}; ${process.arch})`;
    const { authType, customHeaders, apiKey } = this.contentGeneratorConfig;
    const defaultHeaders: Record<string, string | undefined> = {
      'User-Agent': userAgent,
    };

    // For DP_AUTH, add the auth header with the JWT.
    // Header name (Nestor-Token vs Authorization: Bearer) depends on
    // whether the JWT came from the NESSY_CLI_DP_AUTH_TOKEN env-bypass flow — see
    // dp/nestor-auth-header.ts for the discrimination logic.
    if (authType === AuthType.DP_AUTH && apiKey) {
      Object.assign(defaultHeaders, buildNestorAuthHeaders(apiKey));
    }

    return customHeaders
      ? { ...defaultHeaders, ...customHeaders }
      : defaultHeaders;
  }

  override buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TIMEOUT,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const defaultHeaders = this.buildHeaders();
    // Configure fetch options to ensure user-configured timeout works as expected
    // bodyTimeout is always disabled (0) to let OpenAI SDK timeout control the request
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    // [nessy-fork] AIDT-6787 trace-propagation: wrap the fetch the OpenAI SDK
    // uses so every outgoing request to Nestor carries a W3C `traceparent`
    // built from the active OTel span (`nessy-cli.llm_request`, whose traceId
    // == deriveTraceId(sessionId)). This lets the Nestor backend continue the
    // same trace under dp-auth, so the trace_id in NESSY_TELEMETRY_OUTFILE
    // matches the server-side trace. HttpInstrumentation only patches
    // node:http, not the undici-based fetch the SDK uses, so we inject at the
    // fetch boundary. When telemetry is disabled the global propagator is a
    // no-op and no header is added.
    const baseFetch = (runtimeOptions?.fetch ?? fetch) as typeof fetch;
    // [nessy-fork] AIDT-7315 session-id-header: injected at the fetch boundary
    // rather than in `defaultHeaders` because the session id changes on
    // /clear, /resume and friends (`Config.startNewSession`) while the OpenAI
    // client — and on the dp-auth path the whole ContentGenerator — is reused.
    const instrumentedFetch = wrapFetchWithSessionIdHeader(
      wrapFetchWithTraceContext(baseFetch),
      () => this.cliConfig.getSessionId?.(),
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...(runtimeOptions || {}),
      // [nessy-fork] dp-auth-anthropic-generator
      fetch:
        this.contentGeneratorConfig.authType === AuthType.DP_AUTH
          ? wrapFetchWithNestorAuth(
              instrumentedFetch,
              () => this.contentGeneratorConfig.apiKey!,
            )
          : instrumentedFetch,
    });
  }

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    let messages = request.messages;
    let tools = request.tools;

    // Apply DashScope cache control if enabled (default is enabled).
    if (this.shouldEnableCacheControl()) {
      const { messages: updatedMessages, tools: updatedTools } =
        this.addDashScopeCacheControl(
          request,
          request.stream ? 'all' : 'system_only',
        );
      messages = updatedMessages;
      tools = updatedTools;
    }

    // Apply output token limits based on model capabilities
    // This ensures max_tokens doesn't exceed the model's maximum output limit
    const requestWithTokenLimits = this.applyOutputTokenLimit(request);

    const extraBody = this.contentGeneratorConfig.extra_body;

    if (this.isOssModel(request.model)) {
      messages = this.buildOssCompatibleMessages(messages);
    }

    // Some reasoning-capable models served through Nestor (DeepSeek V4+,
    // qwen3 hybrid) accept a flat top-level `reasoning_effort` rather than
    // the standard nested `reasoning: { effort, ... }` shape the pipeline
    // passes through. Translate the nested form so user-configured effort
    // levels actually take effect; no-ops when `reasoning.effort` is absent.
    // Applied to the final object so an extra_body-injected `reasoning` is
    // covered too.
    // [nessy-fork] reasoning-effort-wire-translation
    return translateReasoningEffort({
      ...requestWithTokenLimits, // Preserve all original parameters including sampling params and adjusted max_tokens
      messages,
      ...(tools ? { tools } : {}),
      ...(this.buildMetadata(userPromptId) || {}),
      ...(this.isVisionModel(request.model)
        ? { vl_high_resolution_images: true }
        : {}),
      ...(extraBody ? extraBody : {}),
    } as OpenAI.Chat.ChatCompletionCreateParams);
  }

  buildMetadata(userPromptId: string): DashScopeRequestMetadata {
    const channel = this.cliConfig.getChannel?.();

    return {
      metadata: {
        sessionId: this.cliConfig.getSessionId?.(),
        promptId: userPromptId,
        ...(channel ? { channel } : {}),
      },
    };
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {
      temperature: 0.6,
    };
  }

  /**
   * Add cache control flag to specified message(s) for DashScope providers
   */
  private addDashScopeCacheControl(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    cacheControl: 'system_only' | 'all',
  ): {
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: ChatCompletionToolWithCache[];
  } {
    const messages = request.messages;

    const systemIndex = messages.findIndex((msg) => msg.role === 'system');
    const lastIndex = messages.length - 1;

    const updatedMessages =
      messages.length === 0
        ? messages
        : messages.map((message, index) => {
            const shouldAddCacheControl = Boolean(
              (index === systemIndex && systemIndex !== -1) ||
              (index === lastIndex && cacheControl === 'all'),
            );

            if (
              !shouldAddCacheControl ||
              !('content' in message) ||
              message.content === null ||
              message.content === undefined
            ) {
              return message;
            }

            return {
              ...message,
              content: this.addCacheControlToContent(message.content),
            } as OpenAI.Chat.ChatCompletionMessageParam;
          });

    const updatedTools =
      cacheControl === 'all' && request.tools?.length
        ? this.addCacheControlToTools(request.tools)
        : (request.tools as ChatCompletionToolWithCache[] | undefined);

    return {
      messages: updatedMessages,
      tools: updatedTools,
    };
  }

  private addCacheControlToTools(
    tools: OpenAI.Chat.ChatCompletionTool[],
  ): ChatCompletionToolWithCache[] {
    if (tools.length === 0) {
      return tools as ChatCompletionToolWithCache[];
    }

    const updatedTools = [...tools] as ChatCompletionToolWithCache[];
    const lastToolIndex = tools.length - 1;
    updatedTools[lastToolIndex] = {
      ...updatedTools[lastToolIndex],
      cache_control: { type: 'ephemeral' },
    };

    return updatedTools;
  }

  /**
   * Add cache control to message content, handling both string and array formats
   */
  private addCacheControlToContent(
    content: NonNullable<OpenAI.Chat.ChatCompletionMessageParam['content']>,
  ): ChatCompletionContentPartWithCache[] {
    // Convert content to array format if it's a string
    const contentArray = this.normalizeContentToArray(content);

    // Add cache control to the last text item or create one if needed
    return this.addCacheControlToContentArray(contentArray);
  }

  /**
   * Normalize content to array format
   */
  private normalizeContentToArray(
    content: NonNullable<OpenAI.Chat.ChatCompletionMessageParam['content']>,
  ): ChatCompletionContentPartWithCache[] {
    if (typeof content === 'string') {
      return [
        {
          type: 'text',
          text: content,
        } as ChatCompletionContentPartTextWithCache,
      ];
    }
    return [...content] as ChatCompletionContentPartWithCache[];
  }

  /**
   * Add cache control to the content array
   */
  private addCacheControlToContentArray(
    contentArray: ChatCompletionContentPartWithCache[],
  ): ChatCompletionContentPartWithCache[] {
    if (contentArray.length === 0) {
      return contentArray;
    }

    // Add cache_control to the last text item
    const lastItem = contentArray[contentArray.length - 1];
    contentArray[contentArray.length - 1] = {
      ...lastItem,
      cache_control: { type: 'ephemeral' },
    } as ChatCompletionContentPartTextWithCache;

    return contentArray;
  }

  /**
   * Vision-capable model patterns.
   * Supports exact matches and prefix patterns for easy extension.
   */
  private static readonly VISION_MODEL_EXACT_MATCHES = new Set(['coder-model']);

  private static readonly VISION_MODEL_PREFIX_PATTERNS = [
    'qwen-vl', // qwen-vl-max, qwen-vl-max-latest, etc.
    'qwen3-vl-plus', // qwen3-vl-plus variants
    'qwen3.5-plus', // qwen3.5-plus (has built-in vision capabilities)
    // [nessy-fork] model-alias-visual
    '-vl', // Any model with -vl suffix (vision-language models)
  ];

  private isVisionModel(model: string | undefined): boolean {
    if (!model) {
      return false;
    }

    const normalized = model.toLowerCase();

    // Check exact matches
    if (
      NestorOpenAICompatibleProvider.VISION_MODEL_EXACT_MATCHES.has(normalized)
    ) {
      return true;
    }

    // Check prefix patterns
    for (const prefix of NestorOpenAICompatibleProvider.VISION_MODEL_PREFIX_PATTERNS) {
      if (normalized.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if cache control should be disabled based on configuration.
   *
   * @returns true if cache control should be enabled, false otherwise
   */
  private shouldEnableCacheControl(): boolean {
    // Cache control is enabled by default (when enableCacheControl is undefined or true).
    return (
      this.cliConfig.getContentGeneratorConfig()?.enableCacheControl !== false
    );
  }
}

// [nessy-fork] AIDT-6787 trace-propagation
/**
 * Wrap a fetch implementation so each outgoing request carries the active OTel
 * trace context as W3C headers (`traceparent`, and `baggage` when present).
 *
 * Injection reads `context.active()` at call time — inside the OpenAI SDK the
 * request runs within the `nessy-cli.llm_request` span activated via
 * `context.with(...)`, so the propagated `traceparent` carries the session
 * traceId (`deriveTraceId(sessionId)`) and the active span's spanId. The
 * backend can then continue the same trace under dp-auth.
 *
 * Safe by construction: with telemetry disabled the globally-registered
 * propagator is a no-op (and there is no active span), so no header is added.
 * Any failure falls back to the un-instrumented request — trace propagation
 * must never break the actual API call.
 */
export function wrapFetchWithTraceContext(
  baseFetch: typeof fetch,
): typeof fetch {
  return ((input, init) => {
    try {
      const headers = new Headers(init?.headers);
      propagation.inject(context.active(), headers, {
        set: (carrier, key, value) => {
          (carrier as Headers).set(key, value);
        },
      });
      return baseFetch(input, { ...init, headers });
    } catch {
      return baseFetch(input, init);
    }
  }) as typeof fetch;
}

// [nessy-fork] AIDT-7315 session-id-header
/**
 * Wrap a fetch implementation so each outgoing request carries the current CLI
 * session id in `X-Serving-Platform-Client-Session-ID`, letting LLM Proxy group
 * requests by session.
 *
 * The id is read through a getter at request time, not captured once: `/clear`
 * and `/resume` rotate the session id via `Config.startNewSession()` without
 * rebuilding the OpenAI client. Absent or empty session id means no header, and
 * any failure falls back to the un-instrumented request — this must never break
 * the actual API call.
 */
export function wrapFetchWithSessionIdHeader(
  baseFetch: typeof fetch,
  getSessionId: () => string | undefined,
): typeof fetch {
  return ((input, init) => {
    try {
      const sessionId = getSessionId();
      if (!sessionId) return baseFetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set(SERVING_PLATFORM_SESSION_ID_HEADER, sessionId);
      return baseFetch(input, { ...init, headers });
    } catch {
      return baseFetch(input, init);
    }
  }) as typeof fetch;
}
