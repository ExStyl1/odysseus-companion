/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import {
  AuthType,
  nessyOAuth2Events,
  NessyAuth2Event,
  type DeviceAuthorizationData,
} from '@nestor/nessy-cli-core';

export interface NessyAuthState {
  deviceAuth: DeviceAuthorizationData | null;
  authStatus:
    | 'idle'
    | 'polling'
    | 'success'
    | 'error'
    | 'timeout'
    | 'rate_limit';
  authMessage: string | null;
}

export interface ExternalAuthState {
  title: string;
  message: string;
  detail?: string;
}

export const useNessyAuth = (
  pendingAuthType: AuthType | undefined,
  isAuthenticating: boolean,
) => {
  const [nessyAuthState, setNessyAuthState] = useState<NessyAuthState>({
    deviceAuth: null,
    authStatus: 'idle',
    authMessage: null,
  });

  // [nessy-fork] dp-auth
  const isNessyAuth = pendingAuthType === AuthType.DP_AUTH;

  // Set up event listeners when authentication starts
  useEffect(() => {
    if (!isNessyAuth || !isAuthenticating) {
      // Reset state when not authenticating or not Nessy auth
      setNessyAuthState({
        deviceAuth: null,
        authStatus: 'idle',
        authMessage: null,
      });
      return;
    }

    setNessyAuthState((prev) => ({
      ...prev,
      authStatus: 'idle',
    }));

    // Set up event listeners
    const handleDeviceAuth = (deviceAuth: DeviceAuthorizationData) => {
      setNessyAuthState((prev) => ({
        ...prev,
        deviceAuth: {
          verification_uri: deviceAuth.verification_uri,
          verification_uri_complete: deviceAuth.verification_uri_complete,
          user_code: deviceAuth.user_code,
          expires_in: deviceAuth.expires_in,
          device_code: deviceAuth.device_code,
        },
        authStatus: 'polling',
      }));
    };

    const handleAuthProgress = (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => {
      setNessyAuthState((prev) => ({
        ...prev,
        authStatus: status,
        authMessage: message || null,
      }));
    };

    // Add event listeners
    nessyOAuth2Events.on(NessyAuth2Event.AuthUri, handleDeviceAuth);
    nessyOAuth2Events.on(NessyAuth2Event.AuthProgress, handleAuthProgress);

    // Cleanup event listeners when component unmounts or auth finishes
    return () => {
      nessyOAuth2Events.off(NessyAuth2Event.AuthUri, handleDeviceAuth);
      nessyOAuth2Events.off(NessyAuth2Event.AuthProgress, handleAuthProgress);
    };
  }, [isNessyAuth, isAuthenticating]);

  const cancelNessyAuth = useCallback(() => {
    // Emit cancel event to stop polling
    nessyOAuth2Events.emit(NessyAuth2Event.AuthCancel);

    setNessyAuthState({
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
    });
  }, []);

  return {
    nessyAuthState,
    cancelNessyAuth,
  };
};
