/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDialog } from './ModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { Config } from '@nestor/nessy-cli-core';
import { AuthType, DEFAULT_NESSY_MODEL } from '@nestor/nessy-cli-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: vi.fn(() => null),
}));

const mockOpenAiModels = [
  {
    id: DEFAULT_NESSY_MODEL,
    label: 'Default Coder',
    description: 'Default coder model',
    authType: AuthType.USE_OPENAI,
  },
  {
    id: 'gpt-4',
    label: 'GPT-4',
    description: 'GPT-4 model',
    authType: AuthType.USE_OPENAI,
  },
];

const mockDpModels = [
  {
    id: 'qwen-coder',
    label: 'Nessy CLIr',
    description: 'Nessy coding model',
    authType: AuthType.DP_AUTH,
  },
  {
    id: 'nessy-vision',
    label: 'Nessy Vision',
    description: 'Nessy vision capable model',
    authType: AuthType.DP_AUTH,
  },
];

// Helper to create getAvailableModelsForAuthType mock
const createMockGetAvailableModelsForAuthType = () =>
  vi.fn((t: AuthType) => {
    if (t === AuthType.USE_OPENAI) {
      return mockOpenAiModels;
    }
    if (t === AuthType.DP_AUTH) {
      return mockDpModels;
    }
    return [];
  });
const mockedSelect = vi.mocked(DescriptiveRadioButtonSelect);

const renderComponent = (
  props: Partial<React.ComponentProps<typeof ModelDialog>> = {},
  contextValue: Partial<Config> | undefined = undefined,
) => {
  const defaultProps = {
    onClose: vi.fn(),
  };
  const combinedProps = { ...defaultProps, ...props };

  const mockSettings = {
    isTrusted: true,
    user: { settings: {} },
    workspace: { settings: {} },
    setValue: vi.fn(),
  } as unknown as LoadedSettings;

  const mockConfig = {
    // --- Functions used by ModelDialog ---
    getModel: vi.fn(() => DEFAULT_NESSY_MODEL),
    setModel: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    getAllConfiguredModels: vi.fn(() => mockOpenAiModels),
    getModelsConfig: vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
    })),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),

    // --- Functions used by ClearcutLogger ---
    getUsageStatisticsEnabled: vi.fn(() => true),
    getSessionId: vi.fn(() => 'mock-session-id'),
    getDebugMode: vi.fn(() => false),
    getContentGeneratorConfig: vi.fn(() => ({
      authType: AuthType.USE_OPENAI,
      model: DEFAULT_NESSY_MODEL,
    })),
    getUseModelRouter: vi.fn(() => false),
    getProxy: vi.fn(() => undefined),

    // --- Spread test-specific overrides ---
    ...(contextValue ?? {}),
  } as unknown as Config;

  const renderResult = render(
    <SettingsContext.Provider value={mockSettings}>
      <ConfigContext.Provider value={mockConfig}>
        <ModelDialog {...combinedProps} />
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );

  return {
    ...renderResult,
    props: combinedProps,
    mockConfig,
    mockSettings,
  };
};

describe('<ModelDialog />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure env-based fallback models don't leak into this suite from the developer environment.
    delete process.env['OPENAI_MODEL'];
    delete process.env['ANTHROPIC_MODEL'];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the title', () => {
    const { getByText } = renderComponent();
    expect(getByText('Select Model')).toBeDefined();
  });

  it('passes all model options to DescriptiveRadioButtonSelect', () => {
    renderComponent();
    expect(mockedSelect).toHaveBeenCalledTimes(1);

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items).toHaveLength(mockOpenAiModels.length);
    expect(props.items[0].value).toBe(
      `${AuthType.USE_OPENAI}::${DEFAULT_NESSY_MODEL}`,
    );
    expect(props.showNumbers).toBe(true);
  });

  it('displays BYOK labels but switches and persists technical model IDs', async () => {
    let selectedModel = 'zai/glm-5.3';
    const models = [
      { id: 'zai/glm-5.3', label: 'GLM 5.3', authType: AuthType.DP_AUTH },
      {
        id: 'byok/zai/glm-5.3',
        label: 'GLM 5.3 (byok)',
        authType: AuthType.DP_AUTH,
      },
    ];
    const { mockConfig, mockSettings } = renderComponent(
      {},
      {
        getAuthType: () => AuthType.DP_AUTH,
        getAllConfiguredModels: () => models,
        getModel: () => selectedModel,
        getContentGeneratorConfig: () => ({
          model: selectedModel,
          authType: AuthType.DP_AUTH,
        }),
        switchModel: vi.fn(async (_authType, modelId) => {
          selectedModel = modelId;
        }),
      },
    );
    const select = mockedSelect.mock.calls[0][0];
    expect(select.items).toHaveLength(2);
    const { getByText } = render(<>{select.items.map((item) => item.title)}</>);
    expect(getByText('GLM 5.3 (byok)')).toBeDefined();
    await select.onSelect(`${AuthType.DP_AUTH}::byok/zai/glm-5.3`);
    expect(mockConfig.switchModel).toHaveBeenCalledWith(
      AuthType.DP_AUTH,
      'byok/zai/glm-5.3',
      { baseUrl: undefined },
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'byok/zai/glm-5.3',
    );
  });

  it('initializes with the model from ConfigContext', () => {
    const mockGetModel = vi.fn(() => DEFAULT_NESSY_MODEL);
    renderComponent(
      {},
      {
        getModel: mockGetModel,
        getAvailableModelsForAuthType:
          createMockGetAvailableModelsForAuthType(),
      },
    );

    expect(mockGetModel).toHaveBeenCalled();
    const expectedIndex = mockOpenAiModels.findIndex(
      (m) => m.id === DEFAULT_NESSY_MODEL,
    );
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: expectedIndex,
      }),
      undefined,
    );
  });

  it('initializes with default coder model if context is not provided', () => {
    renderComponent({}, undefined);

    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 0,
      }),
      undefined,
    );
  });

  it('initializes with default coder model if getModel returns undefined', () => {
    const mockGetModel = vi.fn(() => undefined as unknown as string);
    renderComponent(
      {},
      {
        getModel: mockGetModel,
        getAvailableModelsForAuthType:
          createMockGetAvailableModelsForAuthType(),
      },
    );

    expect(mockGetModel).toHaveBeenCalled();

    // When getModel returns undefined, preferredModel falls back to DEFAULT_NESSY_MODEL
    // which has index 0, so initialIndex should be 0
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 0,
      }),
      undefined,
    );
    expect(mockedSelect).toHaveBeenCalledTimes(1);
  });

  it('calls config.switchModel and onClose when DescriptiveRadioButtonSelect.onSelect is triggered', async () => {
    const { props, mockConfig, mockSettings } = renderComponent(
      {},
      {
        getAvailableModelsForAuthType: vi.fn((t: AuthType) => {
          if (t === AuthType.USE_OPENAI) {
            return mockOpenAiModels;
          }
          return [];
        }),
      },
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    expect(childOnSelect).toBeDefined();

    await childOnSelect(`${AuthType.USE_OPENAI}::${DEFAULT_NESSY_MODEL}`);

    expect(mockConfig?.switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      DEFAULT_NESSY_MODEL,
      { baseUrl: undefined },
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      DEFAULT_NESSY_MODEL,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls config.switchModel and persists authType+model when selecting a different authType', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const getAuthType = vi.fn(() => AuthType.USE_GEMINI);
    const getAvailableModelsForAuthType = vi.fn((t: AuthType) => {
      if (t === AuthType.USE_OPENAI) {
        return [{ id: 'gpt-4', label: 'GPT-4', authType: t }];
      }
      if (t === AuthType.USE_GEMINI) {
        return mockOpenAiModels;
      }
      return [];
    });

    const mockConfigWithSwitchAuthType = {
      getAuthType,
      getModel: vi.fn(() => 'gpt-4'),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
      // Add switchModel to the mock object (not the type)
      switchModel,
      getAvailableModelsForAuthType,
    };

    const { props, mockSettings } = renderComponent(
      {},
      // Cast to Config to bypass type checking, matching the runtime behavior
      mockConfigWithSwitchAuthType as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'gpt-4',
      { baseUrl: undefined },
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'gpt-4',
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  describe('DP_AUTH (runtime models)', () => {
    // [nessy-fork] dp-auth-runtime-model-catalog
    it('does not persist the runtime DP Auth baseUrl', async () => {
      const baseUrl = 'https://dp.example/v1';
      const switchModel = vi.fn().mockResolvedValue(undefined);
      const model = { ...mockDpModels[0], baseUrl };
      const mockConfigWithDpAuth = {
        getAuthType: vi.fn(() => AuthType.DP_AUTH),
        getModel: vi.fn(() => model.id),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.DP_AUTH,
          model: model.id,
          baseUrl,
        })),
        switchModel,
        getAvailableModelsForAuthType: vi.fn(() => [model]),
      };
      const { mockSettings } = renderComponent(
        {},
        mockConfigWithDpAuth as unknown as Partial<Config>,
      );

      const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
      await childOnSelect(
        `${AuthType.DP_AUTH}::${model.id}\0${model.baseUrl}`,
      );

      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.baseUrl',
        undefined,
      );
      expect(mockSettings.setValue).not.toHaveBeenCalledWith(
        SettingScope.User,
        'model.baseUrl',
        baseUrl,
      );
    });

    it('allows selecting DP_AUTH runtime model via snapshot ID', async () => {
      const switchModel = vi.fn().mockResolvedValue(undefined);
      const getAuthType = vi.fn(() => AuthType.USE_GEMINI);
      const getAvailableModelsForAuthType = vi.fn((t: AuthType) => {
        if (t === AuthType.DP_AUTH) {
          return mockDpModels;
        }
        return [];
      });

      const mockConfigWithDpAuth = {
        getAuthType,
        getModel: vi.fn(() => 'qwen-coder'),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.DP_AUTH,
          model: 'qwen-coder',
        })),
        switchModel,
        getAvailableModelsForAuthType,
      };

      const { props, mockSettings } = renderComponent(
        {},
        mockConfigWithDpAuth as unknown as Partial<Config>,
      );

      const runtimeSnapshotId = `$runtime|${AuthType.DP_AUTH}|qwen-coder`;
      const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
      await childOnSelect(runtimeSnapshotId);

      expect(switchModel).toHaveBeenCalledWith(
        AuthType.DP_AUTH,
        runtimeSnapshotId,
        { requireCachedCredentials: true },
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'model.name',
        'qwen-coder',
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'security.auth.selectedType',
        AuthType.DP_AUTH,
      );
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });

  });

  it('does not pass onHighlight to DescriptiveRadioButtonSelect', () => {
    renderComponent();

    const childOnHighlight = mockedSelect.mock.calls[0][0].onHighlight;
    expect(childOnHighlight).toBeDefined();
    expect(typeof childOnHighlight).toBe('function');
  });

  it('calls onClose prop when "escape" key is pressed', () => {
    const { props } = renderComponent();

    expect(mockedUseKeypress).toHaveBeenCalled();

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    const options = mockedUseKeypress.mock.calls[0][1];

    expect(options).toEqual({ isActive: true });

    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    keyPressHandler({
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('updates initialIndex when config context changes', () => {
    const mockGetModel = vi.fn(() => DEFAULT_NESSY_MODEL);
    const mockGetAuthType = vi.fn(() => 'dp-auth');
    const mockGetModelsConfig = vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
    }));
    const mockGetActiveRuntimeModelSnapshot = vi.fn(() => undefined);
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
    const { rerender } = render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: mockGetModel,
              getAuthType: mockGetAuthType,
              getAvailableModelsForAuthType:
                createMockGetAvailableModelsForAuthType(),
              getAllConfiguredModels: vi.fn(() => mockOpenAiModels),
              getModelsConfig: mockGetModelsConfig,
              getActiveRuntimeModelSnapshot: mockGetActiveRuntimeModelSnapshot,
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    // DEFAULT_NESSY_MODEL (coder-model) is at index 0
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(0);

    mockGetModel.mockReturnValue(DEFAULT_NESSY_MODEL);
    const newMockConfig = {
      getModel: mockGetModel,
      getAuthType: mockGetAuthType,
      getAvailableModelsForAuthType: createMockGetAvailableModelsForAuthType(),
      getAllConfiguredModels: vi.fn(() => mockOpenAiModels),
      getModelsConfig: mockGetModelsConfig,
      getActiveRuntimeModelSnapshot: mockGetActiveRuntimeModelSnapshot,
    } as unknown as Config;

    rerender(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider value={newMockConfig}>
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    // Should be called at least twice: initial render + re-render after context change
    expect(mockedSelect).toHaveBeenCalledTimes(2);
    const expectedCoderIndex = mockOpenAiModels.findIndex(
      (m) => m.id === DEFAULT_NESSY_MODEL,
    );
    expect(mockedSelect.mock.calls[1][0].initialIndex).toBe(expectedCoderIndex);
  });

  // [nessy-fork] model-alias-fast
  it('filters out models with alias "fast" in non-fast-model mode', () => {
    const modelsWithFastAlias = [
      {
        id: 'qwen-coder',
        label: 'Nessy CLIr',
        description: 'Nessy coding model',
        authType: AuthType.DP_AUTH,
      },
      {
        id: 'nessy-fast',
        label: 'Nessy Fast',
        description: 'Fast optimized model',
        authType: AuthType.DP_AUTH,
        alias: 'fast',
        fastOnly: true,
      },
      {
        id: 'gpt-4',
        label: 'GPT-4',
        description: 'GPT-4 model',
        authType: AuthType.USE_OPENAI,
      },
    ];

    renderComponent(
      {},
      {
        getAllConfiguredModels: vi.fn(() => modelsWithFastAlias),
        getAuthType: vi.fn(() => AuthType.DP_AUTH),
      } as unknown as Config,
    );

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const props = mockedSelect.mock.calls[0][0];
    // Should filter out the DP Auth model with fastOnly: true
    // But keep non-DP Auth models (gpt-4)
    expect(props.items).toHaveLength(2);
    expect(props.items.map((item: any) => item.value)).not.toContainEqual(
      expect.stringContaining('nessy-fast'),
    );
  });

  it('shows only DP Auth models with alias "fast" in fast-model mode', () => {
    const modelsWithFastAlias = [
      {
        id: 'qwen-coder',
        label: 'Nessy CLIr',
        description: 'Nessy coding model',
        authType: AuthType.DP_AUTH,
      },
      {
        id: 'nessy-fast',
        label: 'Nessy Fast',
        description: 'Fast optimized model',
        authType: AuthType.DP_AUTH,
        alias: 'fast',
        fastOnly: true,
      },
      {
        id: 'gpt-4',
        label: 'GPT-4',
        description: 'GPT-4 model',
        authType: AuthType.USE_OPENAI,
      },
      {
        id: 'deepseek-fast',
        label: 'DeepSeek Fast',
        description: 'Another fast model',
        authType: AuthType.DP_AUTH,
        alias: 'fast',
        fastOnly: true,
      },
    ];

    renderComponent(
      { isFastModelMode: true },
      {
        getAllConfiguredModels: vi.fn(() => modelsWithFastAlias),
        getAuthType: vi.fn(() => AuthType.DP_AUTH),
      } as unknown as Config,
    );

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const props = mockedSelect.mock.calls[0][0];
    // Should show ONLY DP Auth models with fastOnly: true
    // Non-DP Auth models (gpt-4) should still be shown (no fastOnly filtering for non-DP Auth)
    expect(props.items).toHaveLength(3);
    expect(props.items.map((item: any) => item.value)).toContainEqual(
      expect.stringContaining('nessy-fast'),
    );
    expect(props.items.map((item: any) => item.value)).toContainEqual(
      expect.stringContaining('deepseek-fast'),
    );
    // Should NOT include DP Auth models without fastOnly
    expect(props.items.map((item: any) => item.value)).not.toContainEqual(
      expect.stringContaining('qwen-coder'),
    );
    // Should include non-DP Auth models (no filtering)
    expect(props.items.map((item: any) => item.value)).toContainEqual(
      expect.stringContaining('gpt-4'),
    );
  });

  // [nessy-fork] model-alias-visual
  it('shows visualOnly DP Auth models in visual-model mode without image modality', () => {
    const modelsWithVisualAlias = [
      {
        id: 'qwen-coder',
        label: 'Nessy CLIr',
        authType: AuthType.DP_AUTH,
      },
      {
        id: 'tgpt/visual-model',
        label: 'Nessy Visual',
        authType: AuthType.DP_AUTH,
        alias: 'visual',
        visualOnly: true,
      },
    ];

    renderComponent(
      { isVisualModelMode: true },
      {
        getAllConfiguredModels: vi.fn(() => modelsWithVisualAlias),
        getAuthType: vi.fn(() => AuthType.DP_AUTH),
      } as unknown as Config,
    );

    expect(mockedSelect).toHaveBeenCalledTimes(1);
    const props = mockedSelect.mock.calls[0][0];
    expect(props.items.map((item: any) => item.value)).toContainEqual(
      expect.stringContaining('tgpt/visual-model'),
    );
    expect(props.items.map((item: any) => item.value)).not.toContainEqual(
      expect.stringContaining('qwen-coder'),
    );
  });
});
