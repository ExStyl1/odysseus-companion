/**
 * @license
 * Copyright 2025 Nessy Teams
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp } from './initializer.js';

const mockPerformInitialAuth = vi.fn();
const mockEnsureDpBinary = vi.fn();
const mockValidateTheme = vi.fn();
const mockInitializeI18n = vi.fn();

vi.mock('./auth.js', () => ({
  performInitialAuth: (...args: unknown[]) => mockPerformInitialAuth(...args),
}));

vi.mock('./dpBinary.js', () => ({
  ensureDpBinary: (...args: unknown[]) => mockEnsureDpBinary(...args),
}));

vi.mock('./theme.js', () => ({
  validateTheme: (...args: unknown[]) => mockValidateTheme(...args),
}));

vi.mock('../i18n/index.js', () => ({
  initializeI18n: (...args: unknown[]) => mockInitializeI18n(...args),
  resolveLanguageSetting: (settingsLang?: string) =>
    process.env['NESSY_CLI_LANG'] || settingsLang || 'auto',
}));

const mockConnect = vi.fn();
const mockGetInstance = vi.fn().mockResolvedValue({ connect: mockConnect });
const mockLogIdeConnection = vi.fn();

vi.mock('@nestor/nessy-cli-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    IdeClient: { getInstance: () => mockGetInstance() },
    IdeConnectionEvent: vi.fn().mockImplementation((type) => ({ type })),
    IdeConnectionType: { START: 'start' },
    logIdeConnection: (...args: unknown[]) => mockLogIdeConnection(...args),
  };
});

describe('initializeApp', () => {
  let mockConfig: {
    getModelsConfig: ReturnType<typeof vi.fn>;
    getIdeMode: ReturnType<typeof vi.fn>;
    isInteractive: ReturnType<typeof vi.fn>;
    getGeminiMdFileCount: ReturnType<typeof vi.fn>;
    getFastModel: ReturnType<typeof vi.fn>;
    getVisualModel: ReturnType<typeof vi.fn>;
  };
  let mockSettings: {
    merged: Record<string, unknown>;
    isTrusted: boolean;
    user: { settings: Record<string, unknown> };
    workspace: { settings: Record<string, unknown> };
    setValue: ReturnType<typeof vi.fn>;
    forScope: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api_key'),
        getModel: vi.fn().mockReturnValue('selected-model'),
        wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(false),
      }),
      getIdeMode: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(true),
      getGeminiMdFileCount: vi.fn().mockReturnValue(0),
      getFastModel: vi.fn().mockReturnValue(undefined),
      getVisualModel: vi.fn().mockReturnValue(undefined),
    };

    mockSettings = {
      merged: { general: { language: 'en' } },
      isTrusted: false,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
      forScope: vi.fn((scope: string) =>
        scope === 'Workspace' ? mockSettings.workspace : mockSettings.user,
      ),
    };

    mockPerformInitialAuth.mockResolvedValue(null);
    mockEnsureDpBinary.mockResolvedValue(undefined);
    mockValidateTheme.mockReturnValue(null);
    mockInitializeI18n.mockResolvedValue(undefined);
  });

  // [nessy-fork] dp-binary-lifecycle
  // The bundled dp MCP servers spawn the binary from config.initialize(), which
  // runs after initializeApp — so the download must not be tied to auth.
  it('installs the DP binary regardless of the auth type', async () => {
    mockConfig.getModelsConfig = vi.fn().mockReturnValue({
      getCurrentAuthType: vi.fn().mockReturnValue('api_key'),
      getModel: vi.fn().mockReturnValue('selected-model'),
      wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(false),
    });

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockEnsureDpBinary).toHaveBeenCalledTimes(1);
  });

  it('installs the DP binary before authentication runs', async () => {
    const order: string[] = [];
    mockEnsureDpBinary.mockImplementation(() => {
      order.push('binary');
      return Promise.resolve();
    });
    mockPerformInitialAuth.mockImplementation(() => {
      order.push('initialAuth');
      return Promise.resolve(null);
    });

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(order).toEqual(['binary', 'initialAuth']);
  });

  it('should initialize i18n with language from settings', async () => {
    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockInitializeI18n).toHaveBeenCalledWith('en');
  });

  it('should initialize i18n with NESSY_CLI_LANG env var if set', async () => {
    vi.stubEnv('NESSY_CLI_LANG', 'zh');

    await initializeApp(mockConfig as never, mockSettings as never);
    expect(mockInitializeI18n).toHaveBeenCalledWith('zh');

    vi.unstubAllEnvs();
  });

  it('should return no errors on successful initialization', async () => {
    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.authError).toBeNull();
    expect(result.themeError).toBeNull();
    expect(result.geminiMdFileCount).toBe(0);
  });

  // [nessy-fork] dp-auth-coder-model-default
  it('persists a DP Auth fallback model selected during initial auth', async () => {
    let selectedModel = 'tgpt/missing-model';
    const modelsConfig = {
      getCurrentAuthType: vi.fn().mockReturnValue('dp-auth'),
      getModel: vi.fn(() => selectedModel),
      wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(true),
    };
    mockConfig.getModelsConfig.mockReturnValue(modelsConfig);
    mockPerformInitialAuth.mockImplementation(async () => {
      selectedModel = 'tgpt/default-coder';
      return null;
    });

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'User',
      'model.name',
      'tgpt/default-coder',
    );
  });

  // [nessy-fork] dp-auth-runtime-model-catalog
  it('removes persisted DP Auth models without touching other providers', async () => {
    const modelsConfig = {
      getCurrentAuthType: vi.fn().mockReturnValue('dp-auth'),
      getModel: vi.fn().mockReturnValue('tgpt/current-coder'),
      wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(true),
    };
    mockConfig.getModelsConfig.mockReturnValue(modelsConfig);
    mockSettings.merged = {
      general: { language: 'en' },
      modelProviders: {
        'dp-auth': [{ id: 'tgpt/removed-model' }],
        openai: [{ id: 'user-model' }],
      },
    };
    mockSettings.user.settings = {
      model: { baseUrl: 'https://stale-user.example/v1' },
      modelProviders: {
        'dp-auth': [{ id: 'tgpt/user-stale-model' }],
        openai: [{ id: 'user-model' }],
      },
    };
    mockSettings.workspace.settings = {
      model: { baseUrl: 'https://stale-workspace.example/v1' },
      modelProviders: {
        'dp-auth': [{ id: 'tgpt/workspace-stale-model' }],
      },
    };

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'User',
      'modelProviders.dp-auth',
      undefined,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'Workspace',
      'modelProviders.dp-auth',
      undefined,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'User',
      'model.baseUrl',
      undefined,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'Workspace',
      'model.baseUrl',
      undefined,
    );
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'modelProviders.openai',
      expect.anything(),
    );
  });

  it('does not persist an unchanged DP Auth model during initial auth', async () => {
    const modelsConfig = {
      getCurrentAuthType: vi.fn().mockReturnValue('dp-auth'),
      getModel: vi.fn().mockReturnValue('tgpt/selected-coder'),
      wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(true),
    };
    mockConfig.getModelsConfig.mockReturnValue(modelsConfig);

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      'User',
      'model.name',
      expect.anything(),
    );
  });

  it('persists corrected DP Auth fast and visual selections', async () => {
    const modelsConfig = {
      getCurrentAuthType: vi.fn().mockReturnValue('dp-auth'),
      getModel: vi.fn().mockReturnValue('tgpt/selected-coder'),
      wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(true),
    };
    mockConfig.getModelsConfig.mockReturnValue(modelsConfig);
    mockConfig.getFastModel.mockReturnValue('tgpt/current-fast');
    mockConfig.getVisualModel.mockReturnValue(undefined);
    mockSettings.merged = {
      general: { language: 'en' },
      fastModel: 'tgpt/old-fast',
      visualModel: 'tgpt/old-visual',
    };

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'User',
      'fastModel',
      'tgpt/current-fast',
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      'User',
      'visualModel',
      '',
    );
  });

  it('should return authError when auth fails', async () => {
    mockPerformInitialAuth.mockResolvedValue('Auth failed');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.authError).toBe('Auth failed');
    expect(result.shouldOpenAuthDialog).toBe(true);
    // initializeApp does not clear the selected auth type on failure
    expect(mockSettings.setValue).not.toHaveBeenCalled();
  });

  it('should return themeError when theme validation fails', async () => {
    mockValidateTheme.mockReturnValue('Theme not found');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.themeError).toBe('Theme not found');
  });

  it('should set shouldOpenAuthDialog when auth was not explicitly provided', async () => {
    mockConfig
      .getModelsConfig()
      .wasAuthTypeExplicitlyProvided.mockReturnValue(false);

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.shouldOpenAuthDialog).toBe(true);
  });

  it('should set shouldOpenAuthDialog when auth error occurs', async () => {
    mockConfig
      .getModelsConfig()
      .wasAuthTypeExplicitlyProvided.mockReturnValue(true);
    mockPerformInitialAuth.mockResolvedValue('Auth failed');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.shouldOpenAuthDialog).toBe(true);
  });

  it('should not open auth dialog when auth was explicitly provided and succeeds', async () => {
    mockConfig
      .getModelsConfig()
      .wasAuthTypeExplicitlyProvided.mockReturnValue(true);

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.shouldOpenAuthDialog).toBe(false);
  });

  it('should connect to IDE when in IDE mode', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockGetInstance).toHaveBeenCalled();
    await vi.waitFor(() => expect(mockConnect).toHaveBeenCalled());
    await vi.waitFor(() => expect(mockLogIdeConnection).toHaveBeenCalled());
  });

  it('should not block startup while connecting to IDE', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);
    mockConnect.mockReturnValueOnce(new Promise<void>(() => {}));

    await expect(
      initializeApp(mockConfig as never, mockSettings as never),
    ).resolves.toMatchObject({
      authError: null,
      themeError: null,
    });

    expect(mockGetInstance).toHaveBeenCalled();
    await vi.waitFor(() => expect(mockConnect).toHaveBeenCalled());
    expect(mockLogIdeConnection).not.toHaveBeenCalled();
  });

  it('should not connect to IDE when not in IDE mode', async () => {
    mockConfig.getIdeMode.mockReturnValue(false);

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockGetInstance).not.toHaveBeenCalled();
  });

  it('should default language to auto when no setting is provided', async () => {
    mockSettings.merged = {};

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockInitializeI18n).toHaveBeenCalledWith('auto');
  });
});
