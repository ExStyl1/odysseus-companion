/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('node:fs');
vi.mock('node:fs/promises');
vi.mock('../telemetry/index.js', () => ({
  NessyLogger: vi.fn().mockImplementation(() => ({
    logStartSessionEvent: vi.fn().mockResolvedValue(undefined),
    logEndSessionEvent: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
  DEFAULT_TELEMETRY_TARGET: 'none',
  DEFAULT_OTLP_ENDPOINT: '',
  isTelemetrySdkInitialized: vi.fn().mockReturnValue(false),
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  refreshSessionContext: vi.fn(),
  initializeTelemetry: vi.fn(),
  initializeStatist: vi.fn(),
  logStartSession: vi.fn(),
  StartSessionEvent: vi.fn(),
}));
vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return {
    ...actual,
    resolveContentGeneratorConfigWithSources: vi
      .fn()
      .mockImplementation((_config, authType, generationConfig) => ({
        config: {
          model: generationConfig.model ?? 'test-model',
          apiKey: 'test-key',
          authType,
          internal:
            generationConfig.internal ??
            String(generationConfig.model ?? '').startsWith('tgpt/'),
        },
        sources: {},
      })),
    createContentGeneratorConfig: vi.fn().mockReturnValue({}),
    createContentGenerator: vi.fn().mockReturnValue({}),
  };
});
vi.mock('../dp/index.js', () => ({
  performNessyAuth: vi.fn().mockResolvedValue({
    username: 'test-user',
    jwt: 'test-jwt',
    models: [
      {
        id: 'tgpt/internal-model',
        label: 'Internal model',
        internal: true,
        alias: 'coder',
      },
      {
        id: 'external-model',
        label: 'External model',
        internal: false,
        alias: 'coder',
      },
    ],
  }),
}));
vi.mock('../core/baseLlmClient.js');
vi.mock('../core/toolHookTriggers.js', () => ({
  fireNotificationHook: vi.fn().mockResolvedValue({}),
}));
vi.mock('../services/skillManager.js', () => {
  const SkillManagerMock = vi.fn();
  SkillManagerMock.prototype.startWatching = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.refreshCache = vi
    .fn()
    .mockResolvedValue(undefined);
  SkillManagerMock.prototype.stopWatching = vi.fn();
  SkillManagerMock.prototype.listSkills = vi.fn().mockResolvedValue([]);
  SkillManagerMock.prototype.addChangeListener = vi.fn();
  SkillManagerMock.prototype.removeChangeListener = vi.fn();
  SkillManagerMock.prototype.matchAndActivateByPath = vi
    .fn()
    .mockResolvedValue([]);
  SkillManagerMock.prototype.matchAndActivateByPaths = vi
    .fn()
    .mockResolvedValue([]);
  return { SkillManager: SkillManagerMock };
});
vi.mock('../subagents/subagent-manager.js', () => {
  const SubagentManagerMock = vi.fn();
  SubagentManagerMock.prototype.loadSessionSubagents = vi.fn();
  SubagentManagerMock.prototype.addChangeListener = vi
    .fn()
    .mockReturnValue(() => {});
  SubagentManagerMock.prototype.listSubagents = vi.fn().mockResolvedValue([]);
  return { SubagentManager: SubagentManagerMock };
});
vi.mock('../ide/ide-client.js', () => ({
  IdeClient: {
    getInstance: vi.fn().mockResolvedValue({
      getConnectionStatus: vi.fn(),
      initialize: vi.fn(),
      shutdown: vi.fn(),
    }),
  },
}));
vi.mock('../memory/const.js', () => ({
  setGeminiMdFilename: vi.fn(),
}));

import * as fs from 'node:fs';
import type { ConfigParameters } from './config.js';
import { Config } from './config.js';
import { AuthType } from '../core/contentGenerator.js';

const baseParams: ConfigParameters = {
  cwd: '/tmp',
  targetDir: '/tmp',
  debugMode: false,
  model: 'test-model',
  telemetry: { enabled: false },
  usageStatisticsEnabled: false,
  overrideExtensions: [],
};

// [nessy-fork] macos-internal-seatbelt-profile
describe('Seatbelt model profile guard', () => {
  const originalSandbox = process.env['SANDBOX'];
  const originalSeatbeltProfile = process.env['SEATBELT_PROFILE'];

  beforeEach(() => {
    (fs.existsSync as Mock).mockReturnValue(true);
    (fs.readdirSync as Mock).mockReturnValue([]);
    (fs.statSync as Mock).mockReturnValue({
      isDirectory: vi.fn().mockReturnValue(true),
    });
    vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
    (fs.mkdirSync as Mock).mockImplementation(() => undefined);
    (fs.writeFileSync as Mock).mockImplementation(() => undefined);
    (fs.renameSync as Mock).mockImplementation(() => undefined);
    (fs.copyFileSync as Mock).mockImplementation(() => undefined);
    (fs.unlinkSync as Mock).mockImplementation(() => undefined);
    (fs.readFileSync as Mock).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalSandbox === undefined) {
      delete process.env['SANDBOX'];
    } else {
      process.env['SANDBOX'] = originalSandbox;
    }

    if (originalSeatbeltProfile === undefined) {
      delete process.env['SEATBELT_PROFILE'];
    } else {
      process.env['SEATBELT_PROFILE'] = originalSeatbeltProfile;
    }
  });

  it('blocks external models inside the internal-model Seatbelt profile', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'internal-model-open';
    const config = new Config(baseParams);

    await expect(config.refreshAuth(AuthType.USE_OPENAI)).rejects.toThrow(
      "Cannot use external model 'test-model' inside internal-model-open",
    );
  });

  it('blocks internal dp-auth models inside the external-model Seatbelt profile', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'external-model-open';
    const config = new Config({
      ...baseParams,
      model: 'tgpt/internal-model',
    });

    await expect(config.refreshAuth(AuthType.DP_AUTH)).rejects.toThrow(
      "Cannot use internal model 'tgpt/internal-model' inside external-model-open",
    );
  });

  it('allows external dp-auth models inside the external-model Seatbelt profile', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'external-model-open';
    const config = new Config({
      ...baseParams,
      model: 'external-model',
    });

    await expect(config.refreshAuth(AuthType.DP_AUTH)).resolves.toBeUndefined();
    expect(config.getContentGeneratorConfig().internal).toBe(false);
  });

  it('allows non-dp auth inside the external-model profile even when model metadata is internal', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'external-model-open';
    const config = new Config({
      ...baseParams,
      model: 'tgpt/internal-model',
    });

    await expect(
      config.refreshAuth(AuthType.USE_OPENAI),
    ).resolves.toBeUndefined();
    expect(config.getContentGeneratorConfig().internal).toBe(true);
  });

  it('allows internal dp-auth models inside the internal-model Seatbelt profile', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'internal-model-open';
    const config = new Config({
      ...baseParams,
      model: 'tgpt/internal-model',
    });

    await expect(config.refreshAuth(AuthType.DP_AUTH)).resolves.toBeUndefined();
    expect(config.getContentGeneratorConfig().internal).toBe(true);
  });

  it('allows explicit non-model Seatbelt profiles', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'restrictive-open';
    const config = new Config({
      ...baseParams,
      model: 'external-model',
    });

    await expect(config.refreshAuth(AuthType.DP_AUTH)).resolves.toBeUndefined();
    expect(config.getContentGeneratorConfig().internal).toBe(false);
  });

  it('blocks external dp-auth models inside the internal-model Seatbelt profile', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'internal-model-open';
    const config = new Config({
      ...baseParams,
      model: 'external-model',
    });

    await expect(config.refreshAuth(AuthType.DP_AUTH)).rejects.toThrow(
      "Cannot use external model 'external-model' inside internal-model-open",
    );
  });

  it('blocks model switches that cross the active Seatbelt profile boundary', async () => {
    process.env['SANDBOX'] = 'sandbox-exec';
    process.env['SEATBELT_PROFILE'] = 'internal-model-open';
    const config = new Config({
      ...baseParams,
      model: 'tgpt/internal-model',
      modelProvidersConfig: {
        [AuthType.USE_OPENAI]: [{ id: 'test-model' }],
      },
    });
    await config.refreshAuth(AuthType.DP_AUTH);

    await expect(
      config.switchModel(AuthType.USE_OPENAI, 'test-model'),
    ).rejects.toThrow(
      "Cannot use external model 'test-model' inside internal-model-open",
    );
  });
});
