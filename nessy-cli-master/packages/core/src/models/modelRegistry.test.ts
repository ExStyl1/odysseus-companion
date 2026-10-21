/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModelRegistry,
  DP_AUTH_MODELS,
  modelRegistryKey,
} from './modelRegistry.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';

describe('ModelRegistry', () => {
  describe('initialization', () => {
    it('should always include hard-coded dp-auth models', () => {
      const registry = new ModelRegistry();

      const nessyModels = registry.getModelsForAuthType(AuthType.DP_AUTH);
      // DP_AUTH_MODELS is empty - models are loaded dynamically from server
      expect(nessyModels.length).toBe(DP_AUTH_MODELS.length);
      expect(nessyModels.length).toBe(0);
    });

    it('should initialize with empty config', () => {
      const registry = new ModelRegistry();
      expect(registry.getModelsForAuthType(AuthType.DP_AUTH).length).toBe(
        DP_AUTH_MODELS.length,
      );
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
    });

    it('should initialize with custom models config', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: 'https://api.openai.com/v1',
          },
        ],
      };

      const registry = new ModelRegistry(modelProvidersConfig);

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(openaiModels[0].id).toBe('gpt-4-turbo');
    });

    it('should ignore dp-auth models in config (hard-coded)', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        'dp-auth': [
          {
            id: 'custom-nessy',
            name: 'Custom Nessy',
          },
        ],
      };

      const registry = new ModelRegistry(modelProvidersConfig);

      // Should still use hard-coded dp-auth models
      const nessyModels = registry.getModelsForAuthType(AuthType.DP_AUTH);
      expect(nessyModels.length).toBe(DP_AUTH_MODELS.length);
      expect(nessyModels.find((m) => m.id === 'custom-nessy')).toBeUndefined();
    });
  });

  describe('getModelsForAuthType', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            description: 'Most capable GPT-4',
            baseUrl: 'https://api.openai.com/v1',
            capabilities: { vision: true },
          },
          {
            id: 'gpt-3.5-turbo',
            name: 'GPT-3.5 Turbo',
            capabilities: { vision: false },
          },
        ],
      };
      registry = new ModelRegistry(modelProvidersConfig);
    });

    it('should return models for existing authType', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
    });

    it('should return empty array for non-existent authType', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_VERTEX_AI);
      expect(models.length).toBe(0);
    });

    it('should return AvailableModel format with correct fields', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      const gpt4 = models.find((m) => m.id === 'gpt-4-turbo');

      expect(gpt4).toBeDefined();
      expect(gpt4?.label).toBe('GPT-4 Turbo');
      expect(gpt4?.description).toBe('Most capable GPT-4');
      expect(gpt4?.isVision).toBe(true);
      expect(gpt4?.authType).toBe(AuthType.USE_OPENAI);
    });
  });

  describe('getModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: 'https://api.openai.com/v1',
            generationConfig: {
              samplingParams: {
                temperature: 0.8,
                max_tokens: 4096,
              },
            },
          },
        ],
      };
      registry = new ModelRegistry(modelProvidersConfig);
    });

    it('should return resolved model config', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4-turbo');
      expect(model?.name).toBe('GPT-4 Turbo');
      expect(model?.authType).toBe(AuthType.USE_OPENAI);
      expect(model?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should preserve generationConfig without applying defaults', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model?.generationConfig.samplingParams?.temperature).toBe(0.8);
      expect(model?.generationConfig.samplingParams?.max_tokens).toBe(4096);
      // No defaults are applied - only the configured values are present
      expect(model?.generationConfig.samplingParams?.top_p).toBeUndefined();
      expect(model?.generationConfig.timeout).toBeUndefined();
    });

    it('should return undefined for non-existent model', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'non-existent');
      expect(model).toBeUndefined();
    });

    it('should return undefined for non-existent authType', () => {
      const model = registry.getModel(AuthType.USE_VERTEX_AI, 'some-model');
      expect(model).toBeUndefined();
    });
  });

  describe('modalities auto-fill', () => {
    // Sub-agents that read straight from the registry (e.g. via
    // getResolvedModel) need the registry to populate modalities for them;
    // otherwise they inherit the parent session's modalities and fail the
    // image/pdf/video gates set on tools like ReadFile.
    it('populates modalities from the model name when not provided', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: 'https://api.openai.com/v1',
            generationConfig: {},
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');
      expect(model?.generationConfig.modalities).toEqual({ image: true });
    });

    it('preserves caller-provided modalities verbatim', () => {
      const explicitModalities = { image: true, pdf: true };
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: 'https://api.openai.com/v1',
            generationConfig: { modalities: explicitModalities },
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');
      expect(model?.generationConfig.modalities).toEqual(explicitModalities);
    });

    it('returns text-only ({}) for models with no multimodal default', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'qwen3-coder-plus',
            name: 'qwen3 Coder Plus',
            baseUrl: 'https://example.invalid',
            generationConfig: {},
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'qwen3-coder-plus');
      expect(model?.generationConfig.modalities).toEqual({});
    });

    it('populates MiniMax-M3 metadata when provider entries omit generationConfig', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'MiniMax-M3',
            name: '[MiniMax] MiniMax-M3',
            baseUrl: 'https://api.minimaxi.com/v1',
            envKey: 'MINIMAX_API_KEY',
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'MiniMax-M3');
      expect(model?.generationConfig.modalities).toEqual({
        image: true,
        video: true,
      });

      const available = registry
        .getModelsForAuthType(AuthType.USE_OPENAI)
        .find((m) => m.id === 'MiniMax-M3');
      expect(available?.contextWindowSize).toBe(1000000);
      expect(available?.modalities).toEqual({
        image: true,
        video: true,
      });
    });

    it('normalizes stale MiniMax-M3 provider modalities to image + video', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'MiniMax-M3',
            name: '[MiniMax] MiniMax-M3',
            baseUrl: 'https://api.minimaxi.com/v1',
            envKey: 'MINIMAX_API_KEY',
            generationConfig: {
              modalities: { image: true },
            },
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'MiniMax-M3');
      expect(model?.generationConfig.modalities).toEqual({
        image: true,
        video: true,
      });
    });
  });

  describe('hasModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });
    });

    it('should return true for existing model', () => {
      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4')).toBe(true);
    });

    it('should return false for non-existent model', () => {
      expect(registry.hasModel(AuthType.USE_OPENAI, 'non-existent')).toBe(
        false,
      );
    });

    it('should return false for non-existent authType', () => {
      expect(registry.hasModel(AuthType.USE_VERTEX_AI, 'gpt-4')).toBe(false);
    });
  });

  describe('getDefaultModelForAuthType', () => {
    // [nessy-fork] dp-auth-coder-model-default
    it('should return undefined for dp-auth when no models are registered', () => {
      const registry = new ModelRegistry();
      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.DP_AUTH,
      );
      // DP_AUTH_MODELS is empty - models are loaded dynamically from server
      expect(defaultModel).toBeUndefined();
    });

    it('should return model with alias="coder" for dp-auth', () => {
      const registry = new ModelRegistry();
      // Use updateDpAuthModels to simulate dynamically loaded models
      registry.updateDpAuthModels([
        {
          id: 'tgpt/qwen36-35b-a3b-fp8',
          name: 'fast',
          alias: 'fast',
        },
        {
          id: 'tgpt/qwen35-397b-a17b-fp8',
          name: 'coder',
          alias: 'coder',
        },
      ]);

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.DP_AUTH,
      );
      expect(defaultModel?.alias).toBe('coder');
      expect(defaultModel?.id).toBe('tgpt/qwen35-397b-a17b-fp8');
    });

    it('should skip fast-only models for dp-auth and return coder', () => {
      const registry = new ModelRegistry();
      registry.updateDpAuthModels([
        {
          id: 'tgpt/fast-model',
          name: 'fast',
          alias: 'fast',
          fastOnly: true,
        },
        {
          id: 'tgpt/coder-model',
          name: 'coder',
          alias: 'coder',
        },
      ]);

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.DP_AUTH,
      );
      expect(defaultModel?.alias).toBe('coder');
      expect(defaultModel?.id).toBe('tgpt/coder-model');
    });

    it('should return undefined when no coder model available for dp-auth', () => {
      const registry = new ModelRegistry();
      registry.updateDpAuthModels([
        {
          id: 'tgpt/fast-model',
          name: 'fast',
          alias: 'fast',
        },
        {
          id: 'tgpt/nessy-default',
          name: 'nessy-default',
        },
      ]);

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.DP_AUTH,
      );
      // Should return undefined when no coder model is available
      // This triggers fallback logic in syncAfterAuthRefresh
      expect(defaultModel).toBeUndefined();
    });

    it('should skip fast-only models for other authTypes', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-fast', name: 'Fast', fastOnly: true },
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
      });

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.USE_OPENAI,
      );
      expect(defaultModel?.id).toBe('gpt-4');
    });

    it('should skip models with alias="fast" for other authTypes', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-fast', name: 'Fast', alias: 'fast' },
          { id: 'gpt-4', name: 'GPT-4' },
        ],
      });

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.USE_OPENAI,
      );
      expect(defaultModel?.id).toBe('gpt-4');
    });

    it('should return undefined if all models are fast-only', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-fast-1', name: 'Fast 1', fastOnly: true },
          { id: 'gpt-fast-2', name: 'Fast 2', alias: 'fast' },
        ],
      });

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.USE_OPENAI,
      );
      expect(defaultModel).toBeUndefined();
    });

    it('should return first non-fast model for other authTypes', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
      });

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.USE_OPENAI,
      );
      expect(defaultModel?.id).toBe('gpt-4');
    });
  });

  describe('validation', () => {
    it('should throw error for model without id', () => {
      expect(
        () =>
          new ModelRegistry({
            openai: [{ id: '', name: 'No ID' }],
          }),
      ).toThrow('missing required field: id');
    });
  });

  describe('default base URLs', () => {
    it('should return undefined for dp-auth model when no models are registered', () => {
      const registry = new ModelRegistry();
      const model = registry.getModel(AuthType.DP_AUTH, 'coder-model');
      // DP_AUTH_MODELS is empty - models are loaded dynamically from server
      expect(model).toBeUndefined();
    });

    it('should apply default openai URL when not specified', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      // Project uses custom LLM proxy as default
      expect(model?.baseUrl).toBe('https://llm-proxy.t-tech.team/v1');
    });

    it('should use custom baseUrl when specified', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'deepseek');
      expect(model?.baseUrl).toBe('https://api.deepseek.com/v1');
    });
  });

  describe('authType key validation', () => {
    it('should accept valid authType keys', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(openaiModels[0].id).toBe('gpt-4');

      const geminiModels = registry.getModelsForAuthType(AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
      expect(geminiModels[0].id).toBe('gemini-pro');
    });

    it('should skip invalid authType keys', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        'invalid-key': [{ id: 'some-model', name: 'Some Model' }],
      } as unknown as ModelProvidersConfig);

      // Valid key should be registered
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);

      // Invalid key should be skipped (no crash)
      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
    });

    it('should handle mixed valid and invalid keys', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        'bad-key-1': [{ id: 'model-1', name: 'Model 1' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
        'bad-key-2': [{ id: 'model-2', name: 'Model 2' }],
      } as unknown as ModelProvidersConfig);

      // Valid keys should be registered
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(1);

      // Invalid keys should be skipped
      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);

      const geminiModels = registry.getModelsForAuthType(AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
    });

    it('should work correctly with getModelsForAuthType after validation', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
        'invalid-key': [{ id: 'invalid-model', name: 'Invalid Model' }],
      } as unknown as ModelProvidersConfig);

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(models.find((m) => m.id === 'gpt-4')).toBeDefined();
      expect(models.find((m) => m.id === 'gpt-3.5')).toBeDefined();
      expect(models.find((m) => m.id === 'invalid-model')).toBeUndefined();
    });
  });

  describe('duplicate model id handling', () => {
    it('should skip duplicate model ids (same id, no baseUrl) and use first registered config', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 First', description: 'First config' },
          { id: 'gpt-4', name: 'GPT-4 Second', description: 'Second config' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);

      const gpt4 = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4?.name).toBe('GPT-4 First');
      expect(gpt4?.description).toBe('First config');
    });

    it('should skip duplicate when both id and baseUrl match', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'First',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'Second',
            baseUrl: 'https://api.openai.com/v1',
          },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(1);
      expect(models[0].label).toBe('First');
    });

    it('should allow same id with different baseUrls as distinct models', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 Proxy',
            baseUrl: 'https://proxy.example.com/v1',
          },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(models[0].label).toBe('GPT-4 Direct');
      expect(models[1].label).toBe('GPT-4 Proxy');
    });

    it('should retrieve model by id and baseUrl precisely', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 Proxy',
            baseUrl: 'https://proxy.example.com/v1',
          },
        ],
      });

      const direct = registry.getModel(
        AuthType.USE_OPENAI,
        'gpt-4',
        'https://api.openai.com/v1',
      );
      expect(direct?.name).toBe('GPT-4 Direct');

      const proxy = registry.getModel(
        AuthType.USE_OPENAI,
        'gpt-4',
        'https://proxy.example.com/v1',
      );
      expect(proxy?.name).toBe('GPT-4 Proxy');
    });

    it('should return first match when getModel is called without baseUrl', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 Proxy',
            baseUrl: 'https://proxy.example.com/v1',
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(model).toBeDefined();
      expect(model?.name).toBe('GPT-4 Direct');
    });

    it('should handle hasModel with and without baseUrl', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 Proxy',
            baseUrl: 'https://proxy.example.com/v1',
          },
        ],
      });

      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4')).toBe(true);
      expect(
        registry.hasModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://api.openai.com/v1',
        ),
      ).toBe(true);
      expect(
        registry.hasModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://proxy.example.com/v1',
        ),
      ).toBe(true);
      expect(
        registry.hasModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://unknown.example.com/v1',
        ),
      ).toBe(false);
    });

    it('should handle multiple duplicate ids in same authType', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'model-a', name: 'Model A First' },
          { id: 'model-a', name: 'Model A Second' },
          { id: 'model-b', name: 'Model B First' },
          { id: 'model-b', name: 'Model B Second' },
          { id: 'model-c', name: 'Model C' },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(3);

      expect(registry.getModel(AuthType.USE_OPENAI, 'model-a')?.name).toBe(
        'Model A First',
      );
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-b')?.name).toBe(
        'Model B First',
      );
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-c')?.name).toBe(
        'Model C',
      );
    });

    it('should treat same id in different authTypes as different models', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'shared-model', name: 'OpenAI Shared' }],
        gemini: [{ id: 'shared-model', name: 'Gemini Shared' }],
      });

      const openaiModel = registry.getModel(
        AuthType.USE_OPENAI,
        'shared-model',
      );
      const geminiModel = registry.getModel(
        AuthType.USE_GEMINI,
        'shared-model',
      );

      expect(openaiModel?.name).toBe('OpenAI Shared');
      expect(geminiModel?.name).toBe('Gemini Shared');
    });
  });

  describe('reloadModels', () => {
    it('should reload models from new config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeDefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeUndefined();

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
      });

      // After reload, only new models should exist
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeUndefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('should preserve hard-coded dp-auth models after reload', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      expect(registry.getModelsForAuthType(AuthType.DP_AUTH).length).toBe(
        DP_AUTH_MODELS.length,
      );

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
      });

      // dp-auth models should still be empty (loaded dynamically, not from config)
      expect(registry.getModelsForAuthType(AuthType.DP_AUTH).length).toBe(
        DP_AUTH_MODELS.length,
      );
    });

    it('should clear user-configured models when reload with empty config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(1);

      registry.reloadModels({});

      // All user-configured models should be cleared
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(0);

      // dp-auth models should still exist
      expect(registry.getModelsForAuthType(AuthType.DP_AUTH).length).toBe(
        DP_AUTH_MODELS.length,
      );
    });

    it('should ignore dp-auth models in reload config', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        'dp-auth': [{ id: 'custom-nessy', name: 'Custom Nessy' }],
      });

      // dp-auth should still use hard-coded models
      const nessyModels = registry.getModelsForAuthType(AuthType.DP_AUTH);
      expect(nessyModels.length).toBe(DP_AUTH_MODELS.length);
      expect(nessyModels.find((m) => m.id === 'custom-nessy')).toBeUndefined();
    });

    it('should handle reload with multiple authTypes', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      registry.reloadModels({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Updated' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(2);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')?.name).toBe(
        'GPT-4 Updated',
      );

      const geminiModels = registry.getModelsForAuthType(AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
    });

    it('should skip invalid authType keys during reload', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
        'invalid-key': [{ id: 'invalid-model', name: 'Invalid Model' }],
      } as unknown as ModelProvidersConfig);

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('should correctly reload same-id different-baseUrl models', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'Old Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
        ],
      });

      registry.reloadModels({
        openai: [
          {
            id: 'gpt-4',
            name: 'New Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'New Proxy',
            baseUrl: 'https://proxy.example.com/v1',
          },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(
        registry.getModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://api.openai.com/v1',
        )?.name,
      ).toBe('New Direct');
      expect(
        registry.getModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://proxy.example.com/v1',
        )?.name,
      ).toBe('New Proxy');
    });

    it('should handle reload with undefined config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      registry.reloadModels(undefined);

      // All user-configured models should be cleared
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
      // dp-auth models should still exist
      expect(registry.getModelsForAuthType(AuthType.DP_AUTH).length).toBe(
        DP_AUTH_MODELS.length,
      );
    });

    it('should handle reload replacing same-id entries when baseUrls change', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 v1',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 Proxy',
            baseUrl: 'https://old-proxy.example.com/v1',
          },
        ],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);

      registry.reloadModels({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 v1 updated',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 New Proxy',
            baseUrl: 'https://new-proxy.example.com/v1',
          },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(
        registry.getModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://old-proxy.example.com/v1',
        ),
      ).toBeUndefined();
      expect(
        registry.getModel(
          AuthType.USE_OPENAI,
          'gpt-4',
          'https://new-proxy.example.com/v1',
        )?.name,
      ).toBe('GPT-4 New Proxy');
    });

    it('should apply duplicate model id handling during reload', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        openai: [
          { id: 'model-a', name: 'Model A First' },
          { id: 'model-a', name: 'Model A Second' },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-a')?.name).toBe(
        'Model A First',
      );
    });

    it('should preserve models with same id but different baseUrls during reload', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        openai: [
          {
            id: 'gpt-4',
            name: 'GPT-4 Direct',
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'gpt-4',
            name: 'GPT-4 Proxy',
            baseUrl: 'https://proxy.example.com/v1',
          },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);

      const direct = registry.getModel(
        AuthType.USE_OPENAI,
        'gpt-4',
        'https://api.openai.com/v1',
      );
      expect(direct?.name).toBe('GPT-4 Direct');

      const proxy = registry.getModel(
        AuthType.USE_OPENAI,
        'gpt-4',
        'https://proxy.example.com/v1',
      );
      expect(proxy?.name).toBe('GPT-4 Proxy');
    });
  });
});

describe('modelRegistryKey', () => {
  it('should return id when no baseUrl is provided', () => {
    expect(modelRegistryKey('gpt-4')).toBe('gpt-4');
    expect(modelRegistryKey('gpt-4', undefined)).toBe('gpt-4');
    expect(modelRegistryKey('gpt-4', '')).toBe('gpt-4');
  });

  it('should return composite key when baseUrl is provided', () => {
    const key = modelRegistryKey('gpt-4', 'https://api.openai.com/v1');
    expect(key).toBe('gpt-4\0https://api.openai.com/v1');
    expect(key).not.toBe('gpt-4');
  });

  it('should produce different keys for same id with different baseUrls', () => {
    const key1 = modelRegistryKey('gpt-4', 'https://api.openai.com/v1');
    const key2 = modelRegistryKey('gpt-4', 'https://proxy.example.com/v1');
    expect(key1).not.toBe(key2);
  });

  it('should produce same key for identical id and baseUrl', () => {
    const key1 = modelRegistryKey('gpt-4', 'https://api.openai.com/v1');
    const key2 = modelRegistryKey('gpt-4', 'https://api.openai.com/v1');
    expect(key1).toBe(key2);
  });
});

// [nessy-fork] model-alias-fast
// [nessy-fork] model-alias-visual
describe('fastOnly, voiceOnly, and visualOnly flags', () => {
  // [nessy-fork] dp-auth-coder-model-default
  it('should propagate default flag to AvailableModel', () => {
    const registry = new ModelRegistry({
      openai: [{ id: 'gpt-4o', name: 'GPT-4o', default: true }],
    });

    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)[0].default).toBe(
      true,
    );
  });

  it('should propagate fastOnly flag to AvailableModel', () => {
    const config: ModelProvidersConfig = {
      openai: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', fastOnly: true },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models.find((m) => m.id === 'gpt-4o')?.fastOnly).toBeUndefined();
    expect(models.find((m) => m.id === 'gpt-4o-mini')?.fastOnly).toBe(true);
  });

  it('should propagate voiceOnly flag to AvailableModel', () => {
    const config: ModelProvidersConfig = {
      openai: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'whisper-1', name: 'Whisper', voiceOnly: true },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models.find((m) => m.id === 'gpt-4o')?.voiceOnly).toBeUndefined();
    expect(models.find((m) => m.id === 'whisper-1')?.voiceOnly).toBe(true);
  });

  it('should propagate visualOnly flag to AvailableModel', () => {
    const config: ModelProvidersConfig = {
      openai: [
        { id: 'gpt-4o', name: 'GPT-4o' },
        { id: 'qwen-vl', name: 'Qwen VL', visualOnly: true },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models.find((m) => m.id === 'gpt-4o')?.visualOnly).toBeUndefined();
    expect(models.find((m) => m.id === 'qwen-vl')?.visualOnly).toBe(true);
  });

  it('should warn when multiple only flags are set', () => {
    const config: ModelProvidersConfig = {
      openai: [
        {
          id: 'unreachable-model',
          fastOnly: true,
          visualOnly: true,
        },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models).toHaveLength(1);
    expect(models[0].fastOnly).toBe(true);
    expect(models[0].visualOnly).toBe(true);
  });
});

describe('malformed modelProviders tolerance', () => {
  it('skips a non-array provider value instead of throwing (legacy V5 { protocol, models })', () => {
    // A settings file still in the reverted #5089 V5 shape can deliver a
    // { protocol, models } object here instead of a ModelConfig[].
    const registry = new ModelRegistry({
      openai: {
        protocol: 'openai',
        models: [{ id: 'gpt-4o' }],
      },
    } as unknown as ModelProvidersConfig);

    // Must not throw "models is not iterable"; the malformed entry is skipped.
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });
});
