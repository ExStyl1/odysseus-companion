/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthEvent,
  AuthType,
  getErrorMessage,
  logAuth,
  type Config,
  buildInstallPlan,
  applyProviderInstallPlan,
  type ProviderConfig,
  type ProviderSetupInputs,
} from '@nestor/nessy-cli-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { useNessyAuth } from '../hooks/useNessyAuth.js';
import { AuthState, MessageType } from '../types.js';
import type { HistoryItemWithoutId } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Normalize model IDs: split by comma, trim, deduplicate, remove empty.
 */
export function normalizeModelIds(modelIdsInput: string): string[] {
  return modelIdsInput
    .split(',')
    .map((id) => id.trim())
    .filter((id, index, array) => id.length > 0 && array.indexOf(id) === index);
}

/** @deprecated Use normalizeModelIds instead. */
export const normalizeCustomModelIds = normalizeModelIds;

/**
 * Mask an API key for display: show first 3 and last 4 chars.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return '(not set)';
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

export type { NessyAuthState } from '../hooks/useNessyAuth.js';

export type AuthUiState = {
  authError: string | null;
  isAuthDialogOpen: boolean;
  isAuthenticating: boolean;
  pendingAuthType: AuthType | undefined;
  externalAuthState: {
    title: string;
    message: string;
    detail?: string;
  } | null;
  nessyAuthState: ReturnType<typeof useNessyAuth>['nessyAuthState'];
};

export type AuthController = {
  state: AuthUiState;
  actions: {
    setAuthState: (state: AuthState) => void;
    onAuthError: (error: string | null) => void;
    /** Close the /auth dialog without changing the active provider. */
    closeAuthDialog: () => void;
    /** Persist a provider's install plan and switch to it. */
    handleProviderSubmit: (
      providerConfig: ProviderConfig,
      inputs: ProviderSetupInputs,
    ) => Promise<void>;
    openAuthDialog: () => void;
    cancelAuthentication: () => void;
  };
};

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  onAuthChange?: () => void,
) => {
  const unAuthenticated = config.getAuthType() === undefined;

  const [authState, setAuthState] = useState<AuthState>(
    unAuthenticated ? AuthState.Updating : AuthState.Unauthenticated,
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(unAuthenticated);
  const [pendingAuthType, setPendingAuthType] = useState<AuthType | undefined>(
    undefined,
  );
  const [externalAuthState, setExternalAuthState] = useState<{
    title: string;
    message: string;
    detail?: string;
  } | null>(null);

  const { nessyAuthState, cancelNessyAuth } = useNessyAuth(
    pendingAuthType,
    isAuthenticating,
  );

  // -- Shared helpers -------------------------------------------------------

  const onAuthError = useCallback(
    (error: string | null) => {
      setAuthError(error);
      if (error) {
        setAuthState(AuthState.Updating);
        setIsAuthDialogOpen(true);
      }
    },
    [setAuthError, setAuthState],
  );

  const handleAuthFailure = useCallback(
    (error: unknown, protocolForTelemetry?: AuthType) => {
      setIsAuthenticating(false);
      setExternalAuthState(null);
      const msg = t('Failed to authenticate. Message: {{message}}', {
        message: getErrorMessage(error),
      });
      onAuthError(msg);
      // Prefer the explicit argument over the closed-over pendingAuthType:
      // setPendingAuthType(protocol) queues an async React update, but a
      // synchronous throw in handleProviderSubmit reaches the catch before
      // the next render, so the closure may still see `undefined` here.
      // Callers from the new unified flow pass `protocol` explicitly to
      // sidestep that staleness; legacy callers fall back to the closure.
      const effectiveProtocol = protocolForTelemetry ?? pendingAuthType;
      if (effectiveProtocol) {
        logAuth(
          config,
          new AuthEvent(effectiveProtocol, 'manual', 'error', msg),
        );
      }
    },
    [onAuthError, pendingAuthType, config],
  );

  const completeAuthentication = useCallback(() => {
    setAuthError(null);
    setAuthState(AuthState.Authenticated);
    setPendingAuthType(undefined);
    setIsAuthDialogOpen(false);
    setIsAuthenticating(false);
    onAuthChange?.();
  }, [onAuthChange]);

  // -- Provider connect -----------------------------------------------------

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      const protocol = inputs.protocol ?? providerConfig.protocol;
      try {
        setPendingAuthType(protocol);
        setIsAuthenticating(true);
        setAuthError(null);

        // [nessy-fork] dp-auth-runtime-model-catalog
        const plan = buildInstallPlan(providerConfig, inputs);
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: (modelProviders) => {
            const runtimeProviders = { ...modelProviders };
            delete runtimeProviders[AuthType.DP_AUTH];
            config.reloadModelProvidersConfig(runtimeProviders);
          },
          syncAuthState: (authType, modelId) =>
            config.getModelsConfig().syncAfterAuthRefresh(authType, modelId),
          refreshAuth: (authType) => config.refreshAuth(authType),
          onPostAuth: async (authType) => {
            // [nessy-fork] model-alias-fast
            // For DP Auth, after refreshAuth completes, sync the selected model
            // to settings so it persists across restarts.
            if (authType === AuthType.DP_AUTH) {
              const modelsConfig = config.getModelsConfig();
              const selectedModel = modelsConfig.getModel();
              const persistScope = getPersistScopeForModelSelection(settings);

              settings.setValue(persistScope, 'model.name', selectedModel);
              for (const scope of [
                SettingScope.User,
                SettingScope.Workspace,
              ]) {
                const model = settings.forScope(scope).settings.model;
                if (model && Object.hasOwn(model, 'baseUrl')) {
                  settings.setValue(scope, 'model.baseUrl', undefined);
                }
              }

              config
                .getDebugLogger()
                .info(
                  `onPostAuth: synced model '${selectedModel}' to settings`,
                );

              // Sync fast model if it was auto-selected during refreshAuth
              const fastModel = config.getFastModel() ?? '';
              settings.setValue(persistScope, 'fastModel', fastModel);
              config
                .getDebugLogger()
                .info(
                  `onPostAuth: synced fast model '${fastModel}' to settings`,
                );

              // [nessy-fork] model-alias-visual
              const visualModel = config.getVisualModel() ?? '';
              settings.setValue(persistScope, 'visualModel', visualModel);
              config
                .getDebugLogger()
                .info(
                  `onPostAuth: synced visual model '${visualModel}' to settings`,
                );

              // Sync auth state to update internal Config state
              modelsConfig.syncAfterAuthRefresh(authType, selectedModel);

              // Notify UI to update the header/status line with the new model
              config.notifyModelChangeListeners();
            }
          },
        });

        completeAuthentication();

        // Show success message with username for DP Auth
        if (protocol === AuthType.DP_AUTH) {
          const contentGenConfig = config.getContentGeneratorConfig();
          const username = contentGenConfig?.username;
          addItem(
            {
              type: MessageType.SUCCESS,
              text: username
                ? t('Authenticated successfully with dp-auth credentials ({{username}}).', {
                    username,
                  })
                : t('Authenticated successfully with dp-auth credentials.'),
            },
            Date.now(),
          );
        }

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Successfully configured {{provider}}. Use /model to switch models.',
              { provider: providerConfig.label },
            ),
          },
          Date.now(),
        );

        logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
      } catch (error) {
        // Pass protocol explicitly so error telemetry is recorded even when
        // a synchronous throw beats the setPendingAuthType state update.
        handleAuthFailure(error, protocol);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  // -- Dialog open / close / cancel ----------------------------------------

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const closeAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(false);
    setAuthError(null);
  }, []);

  const cancelAuthentication = useCallback(() => {
    // [nessy-fork] dp-auth
    if (isAuthenticating && pendingAuthType === AuthType.DP_AUTH) {
      cancelNessyAuth();
    }
    if (isAuthenticating && pendingAuthType) {
      logAuth(config, new AuthEvent(pendingAuthType, 'manual', 'cancelled'));
    }
    setIsAuthenticating(false);
    setExternalAuthState(null);
    setIsAuthDialogOpen(true);
    setAuthError(null);
  }, [isAuthenticating, pendingAuthType, cancelNessyAuth, config]);

  // -- Validate NESSY_DEFAULT_AUTH_TYPE env var on mount --------------------

  useEffect(() => {
    const val = process.env['NESSY_DEFAULT_AUTH_TYPE'];
    const valid = [
      AuthType.DP_AUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ];
    if (val && !valid.includes(val as AuthType)) {
      onAuthError(
        t(
          'Invalid NESSY_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}',
          { value: val, validValues: valid.join(', ') },
        ),
      );
    }
  }, [onAuthError]);

  // -- Public interface ----------------------------------------------------

  const state = useMemo<AuthUiState>(
    () => ({
      authError,
      isAuthDialogOpen,
      isAuthenticating,
      pendingAuthType,
      externalAuthState,
      nessyAuthState,
    }),
    [
      authError,
      isAuthDialogOpen,
      isAuthenticating,
      pendingAuthType,
      externalAuthState,
      nessyAuthState,
    ],
  );

  const actions = useMemo<AuthController['actions']>(
    () => ({
      setAuthState,
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
      cancelAuthentication,
    }),
    [
      setAuthState,
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
      cancelAuthentication,
    ],
  );

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    isAuthDialogOpen,
    isAuthenticating,
    pendingAuthType,
    externalAuthState,
    nessyAuthState,
    closeAuthDialog,
    handleProviderSubmit,
    openAuthDialog,
    cancelAuthentication,
    state,
    actions,
  };
};
