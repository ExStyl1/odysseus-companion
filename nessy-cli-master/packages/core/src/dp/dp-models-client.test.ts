/**
 * Tests for DP Models API client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchModels } from './dp-models-client.js';
import {
  NESTOR_SERVER_URL,
  DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
  DEFAULT_NESTOR_BASE_URL,
} from '../core/openaiContentGenerator/constants.js';
import type { Config } from '../config/config.js';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('dp-models-client', () => {
  const originalEnv = process.env['NESSY_CLI_DP_AUTH_TOKEN'];

  beforeEach(() => {
    mockFetch.mockReset();
    delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env['NESSY_CLI_DP_AUTH_TOKEN'];
    } else {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = originalEnv;
    }
  });

  const mockJwt = 'test.jwt.token.here';
  const mockConfig = {
    getCliVersion: () => '1.2.3',
  } as Config;
  const mockModelsResponse = {
    models: [
      {
        name: 'tgpt/qwen3-next-80b-a3b-instruct',
        desc: 'Latest Nessy model',
        is_internal: true,
      },
      {
        name: 'tgpt/qwen-coder',
        desc: 'Coding specialist',
        is_internal: false,
      },
    ],
  };

  describe('fetchModels', () => {
    it('distinguishes a failed BYOK catalog from a removed connection using the response header', async () => {
      const config = {
        ...mockConfig,
        dpByokCatalogUnavailable: false,
      } as Config;
      const corporate = [{ name: 'corporate' }];
      mockFetch.mockResolvedValueOnce(
        Response.json(corporate, {
          headers: { 'X-Byok-Status': 'unavailable' },
        }),
      );
      expect(await fetchModels(mockJwt, undefined, config)).toHaveLength(1);
      expect(config.dpByokCatalogUnavailable).toBe(true);
      mockFetch.mockResolvedValueOnce(Response.json(corporate));
      await fetchModels(mockJwt, undefined, config);
      expect(config.dpByokCatalogUnavailable).toBe(false);
      mockFetch.mockResolvedValueOnce(
        Response.json([{ name: 'byok/zai/glm' }]),
      );
      await fetchModels(mockJwt, undefined, config);
      expect(config.dpByokCatalogUnavailable).toBe(false);
    });
    it('keeps technical IDs separate from BYOK and corporate display names', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 'byok/zai/glm-5.3',
            name: 'legacy-id',
            display_name: 'GLM 5.3',
            access_source: 'byok',
          },
          {
            id: 'zai/glm-5.3',
            display_name: 'GLM 5.3',
            access_source: 'corporate',
          },
          {
            id: 'byok/zai/glm-5.2',
            display_name: 'GLM 5.2 (byok)',
            access_source: 'byok',
          },
          { name: 'tgpt/legacy' },
        ],
      });
      const models = await fetchModels(mockJwt);
      expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: 'byok/zai/glm-5.3', name: 'GLM 5.3 (byok)' },
        { id: 'zai/glm-5.3', name: 'GLM 5.3' },
        { id: 'byok/zai/glm-5.2', name: 'GLM 5.2 (byok)' },
        { id: 'tgpt/legacy', name: 'tgpt/legacy' },
      ]);
    });

    it('maps model protocols to backend routes and defaults legacy models to OpenAI', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { name: 'byok/zai/glm-test', protocol: 'anthropic_messages' },
          { name: 'tgpt/legacy' },
        ],
      });
      const models = await fetchModels(mockJwt);
      expect(models[0]).toMatchObject({
        id: 'byok/zai/glm-test',
        baseUrl: DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
        generationConfig: { protocol: 'anthropic_messages' },
      });
      expect(models[1]).toMatchObject({
        id: 'tgpt/legacy',
        baseUrl: DEFAULT_NESTOR_BASE_URL,
        generationConfig: { protocol: 'openai_chat_completions' },
      });
    });
    it('should fetch models successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => mockModelsResponse,
      });

      const models = await fetchModels(mockJwt, undefined, mockConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        `${NESTOR_SERVER_URL}/api/v2/cli/models`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Nestor-Token': mockJwt,
            'User-Agent': `NessyCLI/1.2.3 (${process.platform}; ${process.arch})`,
          }),
        }),
      );

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('tgpt/qwen3-next-80b-a3b-instruct');
      expect(models[0].name).toBe('tgpt/qwen3-next-80b-a3b-instruct');
      expect(models[0].description).toBe('Latest Nessy model');
      expect(models[0].internal).toBe(true);
      expect(models[1].id).toBe('tgpt/qwen-coder');
      expect(models[1].name).toBe('tgpt/qwen-coder');
      expect(models[1].description).toBe('Coding specialist');
      expect(models[1].internal).toBe(false);
    });

    it('should send Authorization: Bearer when NESSY_CLI_DP_AUTH_TOKEN env matches the JWT', async () => {
      process.env['NESSY_CLI_DP_AUTH_TOKEN'] = mockJwt;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => mockModelsResponse,
      });

      await fetchModels(mockJwt);

      const [, requestInit] = mockFetch.mock.calls[0];
      const headers = (requestInit as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['Authorization']).toBe(`Bearer ${mockJwt}`);
      expect(headers['Nestor-Token']).toBeUndefined();
    });

    it('should use custom server URL when provided', async () => {
      const customUrl = 'https://custom-server.example.com';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockModelsResponse,
      });

      await fetchModels(mockJwt, customUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        customUrl,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Nestor-Token': mockJwt,
          }),
        }),
      );
    });

    it('should reject on 401 error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized',
      });

      await expect(fetchModels(mockJwt)).rejects.toThrow('HTTP 401');
    });

    it('should reject on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(fetchModels(mockJwt)).rejects.toThrow('Network error');
    });

    it('should reject on timeout', async () => {
      mockFetch.mockRejectedValueOnce(
        new DOMException('Aborted', 'AbortError'),
      );

      await expect(fetchModels(mockJwt)).rejects.toThrow('Aborted');
    });

    it('should handle empty models array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ models: [] }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toEqual([]);
    });

    it.each([{}, null, { models: {} }, [{ display_name: 'No ID' }], [null]])(
      'rejects malformed response %j',
      async (response) => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => response,
        });

        await expect(fetchModels(mockJwt)).rejects.toThrow(
          'DP model list is unavailable',
        );
      },
    );

    it('should support backend format with name/desc/is_internal and convert alias to array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/backend-model',
              desc: 'Backend format model',
              is_internal: true,
              alias: 'fast',
              // [nessy-fork] dp-auth-coder-model-default
              default: true,
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('tgpt/backend-model');
      expect(models[0].name).toBe('tgpt/backend-model');
      expect(models[0].description).toBe('Backend format model');
      expect(models[0].internal).toBe(true);
      expect(models[0].alias).toBe('fast');
      expect(models[0].default).toBe(true);
      // [nessy-fork] model-alias-fast
      expect(models[0].fastOnly).toBe(true);
    });

    it('should preserve modalities from backend in generationConfig', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/vision-model',
              desc: 'Vision model with image support',
              is_internal: false,
              modalities: { image: true },
            },
            {
              name: 'tgpt/text-model',
              desc: 'Text-only model',
              is_internal: false,
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(2);

      // First model has modalities
      expect(models[0].id).toBe('tgpt/vision-model');
      expect(models[0].generationConfig).toBeDefined();
      expect(models[0].generationConfig?.modalities).toEqual({ image: true });
      // [nessy-fork] model-alias-visual
      expect(models[0].visualOnly).toBeFalsy();

      // Second model has no modalities
      expect(models[1].id).toBe('tgpt/text-model');
      expect(models[1].generationConfig).toEqual({
        protocol: 'openai_chat_completions',
      });
    });

    it('should map context_window_size from backend to generationConfig.contextWindowSize', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/large-context-model',
              desc: 'Model with large context',
              is_internal: true,
              context_window_size: 128000,
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].generationConfig).toBeDefined();
      expect(models[0].generationConfig?.contextWindowSize).toBe(128000);
    });

    it('should map sampling_params from backend to generationConfig.samplingParams', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/sampling-model',
              desc: 'Model with custom sampling params',
              is_internal: true,
              sampling_params: {
                temperature: 0.6,
                top_k: 50,
                top_p: 0.95,
                max_tokens: 8000,
                repetition_penalty: 1.1,
                presence_penalty: 0.5,
                frequency_penalty: 0.5,
              },
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].generationConfig).toBeDefined();
      expect(models[0].generationConfig?.samplingParams).toEqual({
        temperature: 0.6,
        top_k: 50,
        top_p: 0.95,
        max_tokens: 8000,
        repetition_penalty: 1.1,
        presence_penalty: 0.5,
        frequency_penalty: 0.5,
      });
    });

    it('should map reasoning from backend to generationConfig.reasoning', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/deepseek-v4',
              desc: 'DeepSeek V4 reasoning model',
              is_internal: true,
              reasoning: {
                effort: 'max',
                budget_tokens: 64000,
              },
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].generationConfig).toBeDefined();
      expect(models[0].generationConfig?.reasoning).toEqual({
        effort: 'max',
        budget_tokens: 64000,
      });
    });

    it('does not emit undefined budget_tokens when backend omits it', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/deepseek-v4',
              desc: 'DeepSeek V4 reasoning model',
              is_internal: true,
              reasoning: {
                effort: 'medium',
              },
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      // No stray `budget_tokens: undefined` key — otherwise it would survive
      // translateReasoningEffort and serialize to a misleading `reasoning: {}`
      // in openai logs.
      expect(models[0].generationConfig?.reasoning).toEqual({
        effort: 'medium',
      });
      expect(
        Object.prototype.hasOwnProperty.call(
          models[0].generationConfig?.reasoning,
          'budget_tokens',
        ),
      ).toBe(false);
    });

    it('should map extra_body from backend to generationConfig.extra_body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/custom-model',
              desc: 'Model with extra body params',
              is_internal: true,
              extra_body: {
                custom_field: 'custom_value',
                another_field: 42,
              },
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].generationConfig).toBeDefined();
      expect(models[0].generationConfig?.extra_body).toEqual({
        custom_field: 'custom_value',
        another_field: 42,
      });
    });

    it('should map all generation config fields together', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/full-model',
              desc: 'Model with all generation config fields',
              is_internal: true,
              modalities: { image: true, pdf: false },
              context_window_size: 256000,
              sampling_params: {
                temperature: 0.2,
                top_k: 20,
                top_p: 0.9,
                max_tokens: 4000,
              },
              reasoning: {
                effort: 'high',
                budget_tokens: 32000,
              },
              extra_body: {
                provider_specific: 'value',
              },
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      const genConfig = models[0].generationConfig;
      expect(genConfig).toBeDefined();
      expect(genConfig?.modalities).toEqual({ image: true, pdf: false });
      expect(genConfig?.contextWindowSize).toBe(256000);
      expect(genConfig?.samplingParams).toEqual({
        temperature: 0.2,
        top_k: 20,
        top_p: 0.9,
        max_tokens: 4000,
      });
      expect(genConfig?.reasoning).toEqual({
        effort: 'high',
        budget_tokens: 32000,
      });
      expect(genConfig?.extra_body).toEqual({
        provider_specific: 'value',
      });
    });

    it('should only set the default protocol when no generation fields are provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/basic-model',
              desc: 'Basic model without generation config',
              is_internal: false,
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].generationConfig).toEqual({
        protocol: 'openai_chat_completions',
      });
    });

    // [nessy-fork] model-alias-visual
    it('should set visualOnly for models with alias=visual', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/visual-model',
              desc: 'Visual model',
              alias: 'visual',
              modalities: { image: true },
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].alias).toBe('visual');
      expect(models[0].visualOnly).toBe(true);
    });

    it('temporarily treats qwen35 vl as visual alias when backend omits alias', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/qwen35-397b-a17b-fp8-vl',
              desc: 'Temporary visual model',
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(1);
      expect(models[0].alias).toBe('visual');
      expect(models[0].visualOnly).toBe(true);
    });

    it('should not set fastOnly for models without alias=fast', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'tgpt/coder-model',
              desc: 'Coder model',
              alias: 'coder',
            },
            {
              name: 'tgpt/regular-model',
              desc: 'Regular model',
            },
          ],
        }),
      });

      const models = await fetchModels(mockJwt);

      expect(models).toHaveLength(2);
      // [nessy-fork] model-alias-fast
      // Models without alias='fast' should not have fastOnly set (undefined or false)
      expect(models[0].fastOnly).toBeFalsy();
      expect(models[1].fastOnly).toBeFalsy();
    });
  });
});
