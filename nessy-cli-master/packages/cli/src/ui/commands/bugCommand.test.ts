/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import open from 'open';
import { bugCommand } from './bugCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
import * as nessyCore from '@nestor/nessy-cli-core';
import {
  AuthType,
  DEFAULT_NESTOR_BUG_REPORT_URL,
  InstallationManager,
} from '@nestor/nessy-cli-core';
import * as systemInfoUtils from '../../utils/systemInfo.js';
import { MessageType } from '../types.js';

vi.mock('open');
vi.mock('../../utils/systemInfo.js');

describe('bugCommand', () => {
  beforeEach(() => {
    vi.spyOn(
      InstallationManager.prototype,
      'getInstallationId',
    ).mockReturnValue('test-installation-id');
    vi.spyOn(nessyCore, 'performNessyAuth').mockResolvedValue({
      jwt: 'dp-jwt-token',
      expiresAt: Date.now() + 60_000,
      username: 'dp-user',
      userId: 'dp-user-id',
    });
    vi.mocked(systemInfoUtils.getExtendedSystemInfo).mockResolvedValue({
      cliVersion: '0.1.0',
      osPlatform: 'test-platform',
      osArch: 'x64',
      osRelease: '22.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'test',
      modelVersion: 'qwen3-coder-plus',
      selectedAuthType: AuthType.USE_OPENAI,
      ideClient: 'VSCode',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      gitCommit:
        GIT_COMMIT_INFO && !['N/A'].includes(GIT_COMMIT_INFO)
          ? GIT_COMMIT_INFO
          : undefined,
    });
    vi.stubEnv('SANDBOX', 'nessy-test');
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('should use a neutral bug report description', () => {
    expect(bugCommand.description).toBe('submit a bug report');
  });

  it('should submit bug report to backend and show returned Jira URL', async () => {
    const createdTaskUrl = 'https://jira.tcsbank.ru/browse/AIDT-123';
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'Спасибо за репорт! Создали задачу в Jira.',
          url: createdTaskUrl,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const mockContext = createMockCommandContext({
      invocation: {
        raw: '/bug A test bug',
        name: 'bug',
        args: 'A test bug',
      },
      services: {
        config: {
          getCliVersion: () => '0.1.0',
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.com/v1',
          }),
        },
      },
    });

    if (!bugCommand.action) {
      throw new Error('Action is not defined');
    }

    await bugCommand.action(mockContext, 'A test bug');

    expect(nessyCore.performNessyAuth).toHaveBeenCalledWith(
      mockContext.services.config,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      DEFAULT_NESTOR_BUG_REPORT_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Nestor-Token': 'dp-jwt-token',
          'User-Agent': expect.stringContaining('NessyCLI/0.1.0'),
          'device-id': 'test-installation-id',
          'X-Request-Id': expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        }),
        body: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );

    const [, requestInit] = vi.mocked(global.fetch).mock.calls[0];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      description: 'A test bug',
      metadata: expect.any(Array),
      raw_command: '/bug A test bug',
    });

    expect(open).toHaveBeenCalledWith(createdTaskUrl);
    expect(systemInfoUtils.getExtendedSystemInfo).toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining(createdTaskUrl),
      }),
      expect.any(Number),
    );
  });

  it('should send Authorization: Bearer when NESSY_CLI_DP_AUTH_TOKEN env matches the auth JWT', async () => {
    vi.stubEnv('NESSY_CLI_DP_AUTH_TOKEN', 'dp-jwt-token');
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const mockContext = createMockCommandContext({
      invocation: {
        raw: '/bug A test bug',
        name: 'bug',
        args: 'A test bug',
      },
      services: {
        config: {
          getCliVersion: () => '0.1.0',
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.com/v1',
          }),
        },
      },
    });

    if (!bugCommand.action) {
      throw new Error('Action is not defined');
    }

    await bugCommand.action(mockContext, 'A test bug');

    const [, requestInit] = vi.mocked(global.fetch).mock.calls[0];
    const headers = (requestInit as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers['Authorization']).toBe('Bearer dp-jwt-token');
    expect(headers['Nestor-Token']).toBeUndefined();
  });

  it('should show backend thank-you message when Jira task is not created', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Спасибо за репорт!' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const mockContext = createMockCommandContext({
      invocation: {
        raw: '/bug A test bug',
        name: 'bug',
        args: 'A test bug',
      },
      services: {
        config: {
          getCliVersion: () => '0.1.0',
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_GEMINI,
            apiKey: 'gemini-key',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          }),
        },
      },
    });

    if (!bugCommand.action) {
      throw new Error('Action is not defined');
    }

    await bugCommand.action(mockContext, 'A test bug');

    expect(nessyCore.performNessyAuth).toHaveBeenCalledWith(
      mockContext.services.config,
    );
    expect(open).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: 'Спасибо за репорт!',
      }),
      expect.any(Number),
    );
  });

  it('should ignore bug command URL overrides and always use the built-in backend', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Спасибо за репорт!' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const mockContext = createMockCommandContext({
      services: {
        config: {
          getBugCommand: () => ({
            urlTemplate: 'https://internal.bug-tracker.com/new?desc={title}',
            backendBaseUrl: 'http://localhost:8080',
          }),
          getCliVersion: () => '0.1.0',
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.com/v1',
          }),
        },
      },
    });

    if (!bugCommand.action) {
      throw new Error('Action is not defined');
    }

    await bugCommand.action(mockContext, 'Ignored override');

    expect(global.fetch).toHaveBeenCalledWith(
      DEFAULT_NESTOR_BUG_REPORT_URL,
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('should show an error when DP authentication for bug report fails', async () => {
    vi.spyOn(nessyCore, 'performNessyAuth').mockRejectedValue(
      new Error('DP auth failed'),
    );

    const mockContext = createMockCommandContext({
      services: {
        config: {
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            apiKey: 'test-key',
          }),
        },
      },
    });

    if (!bugCommand.action) {
      throw new Error('Action is not defined');
    }

    await bugCommand.action(mockContext, 'A test bug');

    expect(global.fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining(
          'Could not submit bug report: DP auth failed',
        ),
      }),
      expect.any(Number),
    );
  });
});
