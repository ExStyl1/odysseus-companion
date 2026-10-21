/**
 * DP Content Generator — shared DP credentials for OpenAI and Anthropic.
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  GenerateContentParameters,
  GenerateContentResponse,
  EmbedContentParameters,
  EmbedContentResponse,
} from '@google/genai';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { OpenAIContentGenerator } from '../core/openaiContentGenerator/openaiContentGenerator.js';
import { AnthropicContentGenerator } from '../core/anthropicContentGenerator/anthropicContentGenerator.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { performNessyAuth } from './dp-auth-service.js';
import {
  NestorOpenAICompatibleProvider,
  wrapFetchWithSessionIdHeader,
  wrapFetchWithTraceContext,
} from '../core/openaiContentGenerator/provider/nestor.js';
import { DEFAULT_TIMEOUT } from '../core/openaiContentGenerator/constants.js';
import { buildRuntimeFetchOptions } from '../utils/runtimeFetchOptions.js';
import { wrapFetchWithNestorAuth } from './nestor-auth-header.js';

import { byokError, isDpByokModel, isNestorAuthError } from './byok-policy.js';

const debugLogger = createDebugLogger('DP');

class DpOpenAIContentGenerator extends OpenAIContentGenerator {
  protected override shouldSuppressErrorLogging(
    error: unknown,
    request: GenerateContentParameters,
  ): boolean {
    return (
      isNestorAuthError(error) ||
      super.shouldSuppressErrorLogging(error, request)
    );
  }
}

// [nessy-fork] dp-auth-anthropic-generator
export class DpContentGenerator implements ContentGenerator {
  private generator?: {
    model: string;
    protocol: ContentGeneratorConfig['protocol'];
    baseUrl: string | undefined;
    instance: ContentGenerator;
  };

  constructor(
    private readonly contentGeneratorConfig: ContentGeneratorConfig,
    private readonly cliConfig: Config,
  ) {
    if (!contentGeneratorConfig.apiKey) {
      throw new Error('apiKey not configured');
    }

    this.getGenerator();
  }

  private getGenerator(): ContentGenerator {
    const { model, protocol, baseUrl } = this.contentGeneratorConfig;
    if (
      !this.generator ||
      this.generator.model !== model ||
      this.generator.protocol !== protocol ||
      this.generator.baseUrl !== baseUrl
    ) {
      this.generator = {
        model,
        protocol,
        baseUrl,
        instance: this.createGenerator(),
      };
    }
    return this.generator.instance;
  }

  private createGenerator(): ContentGenerator {
    const config = this.contentGeneratorConfig;
    switch (config.protocol) {
      case undefined:
      case 'openai_chat_completions':
        return new DpOpenAIContentGenerator(
          config,
          this.cliConfig,
          new NestorOpenAICompatibleProvider(config, this.cliConfig),
        );
      case 'anthropic_messages': {
        if (!config.baseUrl) {
          throw new Error(
            'Backend baseUrl not configured for DP Anthropic model',
          );
        }
        const runtimeOptions = buildRuntimeFetchOptions(
          'anthropic',
          this.cliConfig.getProxy(),
        );
        const baseFetch = (runtimeOptions.fetch ?? fetch) as typeof fetch;
        const instrumentedFetch = wrapFetchWithNestorAuth(
          wrapFetchWithSessionIdHeader(
            wrapFetchWithTraceContext(baseFetch),
            () => this.cliConfig.getSessionId?.(),
          ),
          () => this.contentGeneratorConfig.apiKey!,
        );
        const client = new Anthropic({
          apiKey: null,
          authToken: config.apiKey,
          baseURL: config.baseUrl,
          timeout: config.timeout ?? DEFAULT_TIMEOUT,
          maxRetries: config.maxRetries,
          defaultHeaders: {
            ...Object.fromEntries(
              Object.entries(config.customHeaders ?? {}).filter(
                ([name]) => name.toLowerCase() !== 'anthropic-beta',
              ),
            ),
            'User-Agent': `NessyCLI/${this.cliConfig.getCliVersion() || 'unknown'} (${process.platform}; ${process.arch})`,
          },
          ...runtimeOptions,
          fetch: instrumentedFetch as unknown as ClientOptions['fetch'],
        });
        return new AnthropicContentGenerator(config, this.cliConfig, client);
      }
      default:
        throw new Error(`Unsupported DP model protocol: ${config.protocol}`);
    }
  }

  // [nessy-fork] dp-byok-error-handling
  private async executeWithCredentialManagement<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const model = this.contentGeneratorConfig.model;
    this.checkCatalogAvailability();
    try {
      try {
        return await operation();
      } catch (error) {
        if (!isNestorAuthError(error)) throw error;
        debugLogger.info('Nestor auth error detected, re-authenticating...');
        const newCredentials = await performNessyAuth(this.cliConfig);
        this.contentGeneratorConfig.apiKey = newCredentials.jwt;
        this.generator = undefined;
        this.checkCatalogAvailability();
        return await operation();
      }
    } catch (error) {
      throw this.formatError(error, model);
    }
  }

  private checkCatalogAvailability(): void {
    if (
      this.cliConfig.dpByokCatalogUnavailable &&
      isDpByokModel(
        this.contentGeneratorConfig.authType,
        this.contentGeneratorConfig.model,
      )
    ) {
      throw new Error(
        'BYOK is temporarily unavailable. Try /auth again later.',
      );
    }
  }

  private formatError(error: unknown, model: string): unknown {
    if (
      !isDpByokModel(this.contentGeneratorConfig.authType, model) ||
      isNestorAuthError(error)
    )
      return error;
    return byokError(error);
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.executeWithCredentialManagement(() =>
      this.getGenerator().generateContent(request, userPromptId),
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
    mode?: 'sync' | 'stream',
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    if (mode === 'sync') {
      const response = await this.generateContent(request, userPromptId);
      return (async function* () {
        yield response;
      })();
    }
    const stream = await this.executeWithCredentialManagement(() =>
      this.getGenerator().generateContentStream(request, userPromptId, mode),
    );
    return this.wrapStream(stream, request.model);
  }

  private async *wrapStream(
    stream: AsyncGenerator<GenerateContentResponse>,
    model: string,
  ): AsyncGenerator<GenerateContentResponse> {
    try {
      yield* stream;
    } catch (error) {
      // Never refresh auth or replay a request after the stream has started.
      throw this.formatError(error, model);
    }
  }

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    return this.getGenerator().countTokens(request);
  }

  useSummarizedThinking(): boolean {
    return this.getGenerator().useSummarizedThinking();
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return this.executeWithCredentialManagement(() =>
      this.getGenerator().embedContent(request),
    );
  }
}
