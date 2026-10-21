/**
 * @license
 * Copyright 2025 Nessy CLI
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performInitialAuth } from './auth.js';

const { mockDecodeJwt, mockGetStatistClient, mockLogAuth, mockPushEvent } =
  vi.hoisted(() => ({
    mockDecodeJwt: vi.fn(),
    mockGetStatistClient: vi.fn(),
    mockLogAuth: vi.fn(),
    mockPushEvent: vi.fn(),
  }));
// [nessy-fork] dp-auth-runtime-model-catalog
vi.mock('@nestor/nessy-cli-core', () => ({
  AuthType: { DP_AUTH: 'dp-auth' },
  createDebugLogger: () => ({ warn: vi.fn() }),
  decodeJwt: mockDecodeJwt,
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  getStatistClient: mockGetStatistClient,
  logAuth: (...args: unknown[]) => mockLogAuth(...args),
  StatistEventName: { Auth: 'events.auth' },
  AuthEvent: vi.fn().mockImplementation((type, method, status, message?) => ({
    type,
    method,
    status,
    message,
  })),
}));

describe('performInitialAuth', () => {
  let mockConfig: {
    refreshAuth: ReturnType<typeof vi.fn>;
    getCliVersion: ReturnType<typeof vi.fn>;
    getContentGeneratorConfig: ReturnType<typeof vi.fn>;
    getModelsConfig: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStatistClient.mockReturnValue({ pushEvent: mockPushEvent });
    mockConfig = {
      refreshAuth: vi.fn(),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api_key'),
      }),
    };
  });

  it('should return null when authType is undefined', async () => {
    const result = await performInitialAuth(mockConfig as never, undefined);

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
    expect(mockLogAuth).not.toHaveBeenCalled();
    expect(mockPushEvent).not.toHaveBeenCalled();
  });

  it('should return null on successful authentication', async () => {
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const result = await performInitialAuth(
      mockConfig as never,
      'api_key' as never,
    );

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith('api_key', true);
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
    expect(mockPushEvent).toHaveBeenCalledWith('events.auth', {
      success: true,
      userId: undefined,
      username: undefined,
      error: undefined,
      cliVersion: '1.0.0',
      authType: 'api_key',
    });
  });

  it('should return error message on authentication failure', async () => {
    mockConfig.refreshAuth.mockRejectedValue(new Error('Invalid API key'));

    const result = await performInitialAuth(
      mockConfig as never,
      'api_key' as never,
    );

    expect(result).toBe('Failed to login. Message: Invalid API key');
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
    expect(mockPushEvent).toHaveBeenCalledWith('events.auth', {
      success: false,
      userId: undefined,
      username: undefined,
      error: 'Failed to login. Message: Invalid API key',
      cliVersion: '1.0.0',
      authType: 'api_key',
    });
  });

  it('performs DP authentication once and records its identity', async () => {
    mockConfig.refreshAuth.mockResolvedValue(undefined);
    mockConfig.getModelsConfig.mockReturnValue({
      getCurrentAuthType: vi.fn().mockReturnValue('dp-auth'),
    });
    mockConfig.getContentGeneratorConfig.mockReturnValue({ apiKey: 'jwt' });
    mockDecodeJwt.mockReturnValue({
      sub: 'user-123',
      preferred_username: 'alice',
    });

    const result = await performInitialAuth(
      mockConfig as never,
      'dp-auth' as never,
    );

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).toHaveBeenCalledTimes(1);
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith('dp-auth', true);
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
    expect(mockPushEvent).toHaveBeenCalledTimes(1);
    expect(mockPushEvent).toHaveBeenCalledWith('events.auth', {
      success: true,
      userId: 'user-123',
      username: 'alice',
      error: undefined,
      cliVersion: '1.0.0',
      authType: 'dp-auth',
    });
  });

  it('does not attribute a failed DP authentication to a stale identity', async () => {
    mockConfig.refreshAuth.mockRejectedValue(new Error('DP unavailable'));
    mockConfig.getModelsConfig.mockReturnValue({
      getCurrentAuthType: vi.fn().mockReturnValue('dp-auth'),
    });
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      apiKey: 'stale-jwt',
    });

    const result = await performInitialAuth(
      mockConfig as never,
      'dp-auth' as never,
    );

    expect(result).toBe('Failed to login. Message: DP unavailable');
    expect(mockConfig.refreshAuth).toHaveBeenCalledTimes(1);
    expect(mockDecodeJwt).not.toHaveBeenCalled();
    expect(mockPushEvent).toHaveBeenCalledWith('events.auth', {
      success: false,
      userId: undefined,
      username: undefined,
      error: 'Failed to login. Message: DP unavailable',
      cliVersion: '1.0.0',
      authType: 'dp-auth',
    });
  });

  it('does not fail or retry authentication when Statist throws', async () => {
    mockConfig.refreshAuth.mockResolvedValue(undefined);
    mockPushEvent.mockImplementation(() => {
      throw new Error('Statist unavailable');
    });

    const result = await performInitialAuth(
      mockConfig as never,
      'api_key' as never,
    );

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).toHaveBeenCalledTimes(1);
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
    expect(mockPushEvent).toHaveBeenCalledTimes(1);
  });
});
