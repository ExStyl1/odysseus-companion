/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';

// [nessy-fork] dp-auth-runtime-model-catalog
// DP Auth models come from the runtime server response, not from
// modelProviders. User sampling preferences must keep precedence over model
// metadata returned by the server.

import { ModelsConfig } from './modelsConfig.js';
import { AuthType } from '../core/contentGenerator.js';
import {
  DEFAULT_NESTOR_BASE_URL,
  DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
} from '../core/openaiContentGenerator/constants.js';

describe('ModelsConfig dp-auth: user samplingParams preservation', () => {
  it('keeps the selected BYOK ID and protocol when the BYOK catalog is temporarily unavailable', async () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.DP_AUTH,
    });
    modelsConfig.updateDpAuthModels([
      {
        id: 'byok/zai/removed',
        name: 'GLM',
        baseUrl: DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
        generationConfig: { protocol: 'anthropic_messages' },
      },
    ]);
    await modelsConfig.switchModel(AuthType.DP_AUTH, 'byok/zai/removed');
    modelsConfig.updateDpAuthModels([{ id: 'corporate', name: 'Corporate' }]);
    modelsConfig.syncAfterAuthRefresh(
      AuthType.DP_AUTH,
      'byok/zai/removed',
      undefined,
      true,
    );
    expect(modelsConfig.getGenerationConfig()).toMatchObject({
      model: 'byok/zai/removed',
      protocol: 'anthropic_messages',
    });
    await modelsConfig.switchModel(AuthType.DP_AUTH, 'corporate');
    expect(modelsConfig.getModel()).toBe('corporate');
  });

  it('applies protocol, context and generation parameters when switching between BYOK and corporate models', async () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.DP_AUTH,
    });
    modelsConfig.updateDpAuthModels([
      {
        id: 'byok/zai/glm-5.3',
        name: 'GLM 5.3 (byok)',
        baseUrl: DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
        generationConfig: {
          protocol: 'anthropic_messages',
          contextWindowSize: 1_000_000,
          samplingParams: { temperature: 0.3, max_tokens: 4096 },
          reasoning: { budget_tokens: 1024 },
        },
      },
      {
        id: 'tgpt/corporate',
        name: 'Corporate',
        baseUrl: DEFAULT_NESTOR_BASE_URL,
        generationConfig: {
          protocol: 'openai_chat_completions',
          contextWindowSize: 128_000,
          samplingParams: { temperature: 0.7, max_tokens: 8192 },
        },
      },
    ]);
    await modelsConfig.switchModel(AuthType.DP_AUTH, 'byok/zai/glm-5.3');
    expect(modelsConfig.getGenerationConfig()).toMatchObject({
      model: 'byok/zai/glm-5.3',
      protocol: 'anthropic_messages',
      baseUrl: DEFAULT_NESTOR_ANTHROPIC_BASE_URL,
      contextWindowSize: 1_000_000,
      samplingParams: { temperature: 0.3, max_tokens: 4096 },
      reasoning: { budget_tokens: 1024 },
    });
    await modelsConfig.switchModel(AuthType.DP_AUTH, 'tgpt/corporate');
    expect(modelsConfig.getGenerationConfig()).toMatchObject({
      model: 'tgpt/corporate',
      protocol: 'openai_chat_completions',
      baseUrl: DEFAULT_NESTOR_BASE_URL,
      contextWindowSize: 128_000,
      samplingParams: { temperature: 0.7, max_tokens: 8192 },
    });
    expect(modelsConfig.getGenerationConfig().reasoning).toBeUndefined();
  });

  it('keeps user temperature/top_p/top_k when the server model omits samplingParams', async () => {
    // User set these in settings.json; they land in the resolved generationConfig.
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.DP_AUTH,
      generationConfig: {
        model: 'tgpt/qwen35-397b-a17b-fp8',
        samplingParams: { temperature: 1, top_p: 0.85, top_k: 20 },
      },
    } as unknown as ConstructorParameters<typeof ModelsConfig>[0]);

    modelsConfig.updateDpAuthModels([
      {
        id: 'tgpt/qwen35-397b-a17b-fp8',
        name: 'Qwen 3.5 397B',
        generationConfig: {
          samplingParams: { temperature: 0.2, top_p: 0.5, top_k: 5 },
          modalities: { image: true, video: true },
        },
      },
    ]);

    await modelsConfig.switchModel(
      AuthType.DP_AUTH,
      'tgpt/qwen35-397b-a17b-fp8',
    );

    const gc = modelsConfig.getGenerationConfig() as ContentGeneratorConfig;

    // Without the applyResolvedModelDefaults guard, the server model's
    // undefined samplingParams would overwrite these to undefined.
    expect(gc.samplingParams?.temperature).toBe(1);
    expect(gc.samplingParams?.top_p).toBe(0.85);
    expect(gc.samplingParams?.top_k).toBe(20);

    // Modalities advertised by the server model are still applied.
    expect(gc.modalities).toEqual({ image: true, video: true });
  });
});
