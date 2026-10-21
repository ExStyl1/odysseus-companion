/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType,
} from './contentGenerator.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator/index.js';
import { DEFAULT_NESSY_MODEL } from '../config/models.js';

vi.mock('@google/genai');

const openaiMockState = vi.hoisted(() => ({
  importError: null as Error | null,
  generatorError: null as Error | null,
}));

const nessyMockState = vi.hoisted(() => ({
  oauthError: null as Error | null,
}));

vi.mock('./openaiContentGenerator/index.js', () => {
  if (openaiMockState.importError) {
    throw openaiMockState.importError;
  }

  return {
    createOpenAIContentGenerator: () => {
      if (openaiMockState.generatorError) {
        throw openaiMockState.generatorError;
      }
      return {};
    },
  };
});

vi.mock('../qwen/qwenOAuth2.js', () => ({
  getNessyAuthClient: async () => {
    if (nessyMockState.oauthError) {
      throw nessyMockState.oauthError;
    }
    return {};
  },
}));

vi.mock('../nessy/nessyContentGenerator.js', () => ({
  QwenContentGenerator: class {},
}));

describe('createContentGenerator', () => {
  it('should create a Gemini content generator', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      mockConfig,
    );
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: undefined,
      httpOptions: {
        headers: {
          'User-Agent': expect.any(String),
          'x-gemini-api-privileged-user-id': expect.any(String),
        },
      },
    });
    // We expect it to be a LoggingContentGenerator wrapping a GeminiContentGenerator
    expect(generator).toBeInstanceOf(LoggingContentGenerator);
    const wrapped = (generator as LoggingContentGenerator).getWrapped();
    expect(wrapped).toBeDefined();
  });

  it('should create a Gemini content generator with client install id logging disabled', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      mockConfig,
    );
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: undefined,
      httpOptions: {
        headers: {
          'User-Agent': expect.any(String),
        },
      },
    });
    expect(generator).toBeInstanceOf(LoggingContentGenerator);
  });

  it('should throw when the config has no authType', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    await expect(
      createContentGenerator(
        { model: 'test-model', apiKey: 'test-key' } as Parameters<
          typeof createContentGenerator
        >[0],
        mockConfig,
      ),
    ).rejects.toThrow('must have an authType');
  });

  it('should throw on an unsupported authType', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: 'bogus',
        } as unknown as Parameters<typeof createContentGenerator>[0],
        mockConfig,
      ),
    ).rejects.toThrow('Unsupported authType');
  });
});

describe('createContentGenerator - ERR_MODULE_NOT_FOUND handling', () => {
  const mockConfig = {
    getUsageStatisticsEnabled: () => true,
    getContentGeneratorConfig: () => ({}),
    getCliVersion: () => '1.0.0',
    getTelemetryEnabled: () => false,
    getSessionId: () => 'test-session',
  } as unknown as Config;

  beforeEach(() => {
    openaiMockState.importError = null;
    openaiMockState.generatorError = null;
    nessyMockState.oauthError = null;
    vi.resetModules();
  });

  it('should throw friendly restart message with cause when dynamic import fails with ERR_MODULE_NOT_FOUND', async () => {
    const moduleError = new Error(
      "Cannot find module './openaiContentGenerator-STALE.js'",
    );
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    openaiMockState.importError = moduleError;

    try {
      await createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: AuthType.USE_OPENAI,
        },
        mockConfig,
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      // Error message includes module name and error details
      expect(err.message).toMatch(/openai|module/);
      expect(err.cause).toBe(moduleError);
    }
  });

  it('should re-throw non-module errors unchanged', async () => {
    openaiMockState.generatorError = new Error('network timeout');

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: AuthType.USE_OPENAI,
        },
        mockConfig,
      ),
    ).rejects.toThrow('network timeout');
  });

  it('should preserve module-not-found errors from NESSY OAuth setup', async () => {
    const moduleError = new Error("Cannot find module '../nessy/stale.js'");
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    nessyMockState.oauthError = moduleError;

    try {
      await createContentGenerator(
        {
          model: 'test-model',
          authType: AuthType.DP_AUTH,
        },
        mockConfig,
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      // DP_AUTH models are loaded dynamically - when module fails to load,
      // error message reflects the actual failure
      expect(err.message).toMatch(/dp-auth|nessy|module|apiKey/);
    }
  });
});

describe('createContentGeneratorConfig', () => {
  const mockConfig = {
    getProxy: () => undefined,
  } as unknown as Config;

  it('should preserve provided fields and set authType for DP_AUTH', () => {
    const cfg = createContentGeneratorConfig(mockConfig, AuthType.DP_AUTH, {
      model: DEFAULT_NESSY_MODEL,
      apiKey: 'DP_AUTH_DYNAMIC_TOKEN',
    });
    expect(cfg.authType).toBe(AuthType.DP_AUTH);
    expect(cfg.model).toBe(DEFAULT_NESSY_MODEL);
    expect(cfg.apiKey).toBe('DP_AUTH_DYNAMIC_TOKEN');
  });

  it('should not warn or fallback for DP_AUTH (resolution handled by ModelConfigResolver)', () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const cfg = createContentGeneratorConfig(mockConfig, AuthType.DP_AUTH, {
      model: 'some-random-model',
    });
    expect(cfg.model).toBe('some-random-model');
    expect(cfg.apiKey).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // [nessy-fork] external-model-mcp-whitelist
  it('derives internal from the model id prefix for openai auth (tgpt => internal)', () => {
    const cfg = createContentGeneratorConfig(mockConfig, AuthType.USE_OPENAI, {
      model: 'tgpt/internal-model',
      apiKey: 'k',
      baseUrl: 'https://example.com',
    });
    expect(cfg.internal).toBe(true);
  });

  // [nessy-fork] external-model-mcp-whitelist
  it('derives internal as false for an external openai model', () => {
    const cfg = createContentGeneratorConfig(mockConfig, AuthType.USE_OPENAI, {
      model: 'external-model',
      apiKey: 'k',
      baseUrl: 'https://example.com',
    });
    expect(cfg.internal).toBe(false);
  });
});
