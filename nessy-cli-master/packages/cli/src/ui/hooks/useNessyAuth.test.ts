/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DeviceAuthorizationData } from '@nestor/nessy-cli-core';
import { useNessyAuth } from './useNessyAuth.js';
import {
  AuthType,
  nessyOAuth2Events,
  NessyAuth2Event,
} from '@nestor/nessy-cli-core';

// Mock the nessyOAuth2Events
vi.mock('@nestor/nessy-cli-core', async () => {
  const actual = await vi.importActual('@nestor/nessy-cli-core');
  const mockEmitter = {
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnThis(),
  };
  return {
    ...actual,
    nessyOAuth2Events: mockEmitter,
    NessyAuth2Event: {
      AuthUri: 'authUri',
      AuthProgress: 'authProgress',
    },
  };
});

const mockNessyAuth2Events = vi.mocked(nessyOAuth2Events);

describe('useNessyAuth', () => {
  const mockDeviceAuth: DeviceAuthorizationData = {
    verification_uri: 'https://oauth.nessy.com/device',
    verification_uri_complete: 'https://oauth.nessy.com/device?user_code=ABC123',
    user_code: 'ABC123',
    expires_in: 1800,
    device_code: 'device_code_123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state when not Nessy auth', () => {
    const { result } = renderHook(() =>
      useNessyAuth(AuthType.USE_GEMINI, false),
    );

    expect(result.current.nessyAuthState).toEqual({
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
    });
    expect(result.current.cancelNessyAuth).toBeInstanceOf(Function);
  });

  it('should initialize with default state when Nessy auth but not authenticating', () => {
    const { result } = renderHook(() =>
      useNessyAuth(AuthType.DP_AUTH, false),
    );

    expect(result.current.nessyAuthState).toEqual({
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
    });
    expect(result.current.cancelNessyAuth).toBeInstanceOf(Function);
  });

  it('should set up event listeners when Nessy auth and authenticating', () => {
    renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    expect(mockNessyAuth2Events.on).toHaveBeenCalledWith(
      NessyAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockNessyAuth2Events.on).toHaveBeenCalledWith(
      NessyAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should handle device auth event', () => {
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.nessyAuthState.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.nessyAuthState.authStatus).toBe('polling');
  });

  it('should handle auth progress event - success', () => {
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    act(() => {
      handleAuthProgress!('success', 'Authentication successful!');
    });

    expect(result.current.nessyAuthState.authStatus).toBe('success');
    expect(result.current.nessyAuthState.authMessage).toBe(
      'Authentication successful!',
    );
  });

  it('should handle auth progress event - error', () => {
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    act(() => {
      handleAuthProgress!('error', 'Authentication failed');
    });

    expect(result.current.nessyAuthState.authStatus).toBe('error');
    expect(result.current.nessyAuthState.authMessage).toBe(
      'Authentication failed',
    );
  });

  it('should handle auth progress event - polling', () => {
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    act(() => {
      handleAuthProgress!('polling', 'Waiting for user authorization...');
    });

    expect(result.current.nessyAuthState.authStatus).toBe('polling');
    expect(result.current.nessyAuthState.authMessage).toBe(
      'Waiting for user authorization...',
    );
  });

  it('should handle auth progress event - rate_limit', () => {
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    act(() => {
      handleAuthProgress!(
        'rate_limit',
        'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
      );
    });

    expect(result.current.nessyAuthState.authStatus).toBe('rate_limit');
    expect(result.current.nessyAuthState.authMessage).toBe(
      'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
    );
  });

  it('should handle auth progress event without message', () => {
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    act(() => {
      handleAuthProgress!('success');
    });

    expect(result.current.nessyAuthState.authStatus).toBe('success');
    expect(result.current.nessyAuthState.authMessage).toBe(null);
  });

  it('should clean up event listeners when auth type changes', () => {
    const { rerender } = renderHook(
      ({ pendingAuthType, isAuthenticating }) =>
        useNessyAuth(pendingAuthType, isAuthenticating),
      {
        initialProps: {
          pendingAuthType: AuthType.DP_AUTH,
          isAuthenticating: true,
        },
      },
    );

    // Change to non-Nessy auth
    rerender({ pendingAuthType: AuthType.USE_GEMINI, isAuthenticating: true });

    expect(mockNessyAuth2Events.off).toHaveBeenCalledWith(
      NessyAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockNessyAuth2Events.off).toHaveBeenCalledWith(
      NessyAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should clean up event listeners when authentication stops', () => {
    const { rerender } = renderHook(
      ({ isAuthenticating }) =>
        useNessyAuth(AuthType.DP_AUTH, isAuthenticating),
      { initialProps: { isAuthenticating: true } },
    );

    // Stop authentication
    rerender({ isAuthenticating: false });

    expect(mockNessyAuth2Events.off).toHaveBeenCalledWith(
      NessyAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockNessyAuth2Events.off).toHaveBeenCalledWith(
      NessyAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should clean up event listeners on unmount', () => {
    const { unmount } = renderHook(() =>
      useNessyAuth(AuthType.DP_AUTH, true),
    );

    unmount();

    expect(mockNessyAuth2Events.off).toHaveBeenCalledWith(
      NessyAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockNessyAuth2Events.off).toHaveBeenCalledWith(
      NessyAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should reset state when switching from Nessy auth to another auth type', () => {
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result, rerender } = renderHook(
      ({ pendingAuthType, isAuthenticating }) =>
        useNessyAuth(pendingAuthType, isAuthenticating),
      {
        initialProps: {
          pendingAuthType: AuthType.DP_AUTH,
          isAuthenticating: true,
        },
      },
    );

    // Simulate device auth
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.nessyAuthState.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.nessyAuthState.authStatus).toBe('polling');

    // Switch to different auth type
    rerender({ pendingAuthType: AuthType.USE_GEMINI, isAuthenticating: true });

    expect(result.current.nessyAuthState.deviceAuth).toBe(null);
    expect(result.current.nessyAuthState.authStatus).toBe('idle');
    expect(result.current.nessyAuthState.authMessage).toBe(null);
  });

  it('should reset state when authentication stops', () => {
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result, rerender } = renderHook(
      ({ isAuthenticating }) =>
        useNessyAuth(AuthType.DP_AUTH, isAuthenticating),
      { initialProps: { isAuthenticating: true } },
    );

    // Simulate device auth
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.nessyAuthState.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.nessyAuthState.authStatus).toBe('polling');

    // Stop authentication
    rerender({ isAuthenticating: false });

    expect(result.current.nessyAuthState.deviceAuth).toBe(null);
    expect(result.current.nessyAuthState.authStatus).toBe('idle');
    expect(result.current.nessyAuthState.authMessage).toBe(null);
  });

  it('should handle cancelNessyAuth function', () => {
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockNessyAuth2Events.on.mockImplementation((event, handler) => {
      if (event === NessyAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockNessyAuth2Events;
    });

    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    // Set up some state
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.nessyAuthState.deviceAuth).toEqual(mockDeviceAuth);

    // Cancel auth
    act(() => {
      result.current.cancelNessyAuth();
    });

    expect(result.current.nessyAuthState.deviceAuth).toBe(null);
    expect(result.current.nessyAuthState.authStatus).toBe('idle');
    expect(result.current.nessyAuthState.authMessage).toBe(null);
  });

  it('should handle different auth types correctly', () => {
    // Test with DP Auth - should set up event listeners when authenticating
    const { result: nessyResult } = renderHook(() =>
      useNessyAuth(AuthType.DP_AUTH, true),
    );
    expect(nessyResult.current.nessyAuthState.authStatus).toBe('idle');
    expect(mockNessyAuth2Events.on).toHaveBeenCalled();

    // Test with other auth types - should not set up event listeners
    const { result: geminiResult } = renderHook(() =>
      useNessyAuth(AuthType.USE_GEMINI, true),
    );
    expect(geminiResult.current.nessyAuthState.authStatus).toBe('idle');

    const { result: oauthResult } = renderHook(() =>
      useNessyAuth(AuthType.USE_OPENAI, true),
    );
    expect(oauthResult.current.nessyAuthState.authStatus).toBe('idle');
  });

  it('should initialize with idle status when starting authentication with Nessy auth', () => {
    const { result } = renderHook(() => useNessyAuth(AuthType.DP_AUTH, true));

    expect(result.current.nessyAuthState.authStatus).toBe('idle');
    expect(mockNessyAuth2Events.on).toHaveBeenCalled();
  });
});
