/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';
import {
  findProviderByCredentials,
  customProvider,
  dpAuthProvider,
  type ProviderConfig,
} from '@nestor/nessy-cli-core';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';
import { AuthInProgress } from './AuthInProgress.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewLevel = 'main' | 'provider-setup';

type MainOption = 'DP_AUTH' | 'API_KEY';

// ---------------------------------------------------------------------------
// Step label for provider-setup title bar
// ---------------------------------------------------------------------------

function getStepLabel(step: string | null, p: ProviderConfig): string {
  if (step === 'protocol') return t('Protocol');
  if (step === 'baseUrl') {
    if (p.uiLabels?.baseUrlStepTitle) return t(p.uiLabels.baseUrlStepTitle);
    return Array.isArray(p.baseUrl) ? t('Endpoint') : t('Base URL');
  }
  if (step === 'apiKey') return t('API Key');
  if (step === 'models') return t('Model IDs');
  if (step === 'advancedConfig') return t('Advanced Config');
  if (step === 'review') return t('Review');
  return '';
}

// ---------------------------------------------------------------------------
// View titles
// ---------------------------------------------------------------------------

const VIEW_TITLES: Record<string, string> = {
  main: t('Connect a Provider'),
};

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

export function AuthDialog(): React.JSX.Element {
  const {
    auth: { authError, isAuthenticating },
  } = useUIState();
  const {
    auth: { closeAuthDialog, handleProviderSubmit, onAuthError },
  } = useUIActions();
  const config = useConfig();
  const settings = useSettings();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);

  const [mainIndex, setMainIndex] = useState<number | null>(null);

  const setupFlow = useProviderSetupFlow(handleProviderSubmit);

  // Check if API-KEY option should be shown from modelsConfig (default is false - hidden)
  const showApiKeyOption = config.getModelsConfig().getShowApiKeyOption();

  // Main authentication entries - conditionally include API_KEY based on showApiKeyOption
  const MAIN_ITEMS_WITH_CONDITIONAL_API_KEY = useMemo(
    () => [
      // [nessy-fork] dp-auth
      {
        key: 'DP_AUTH',
        title: t('DP Authentication'),
        label: t('DP Authentication'),
        description: t(
          'Recommended · sign in via DP CLI (shared with IDE plugins)',
        ),
        value: 'DP_AUTH' as MainOption,
      },
      ...(showApiKeyOption
        ? [
            {
              key: 'API_KEY',
              title: t('API Key'),
              label: t('API Key'),
              description: t(
                'Manually connect an OpenAI-compatible provider with an API key',
              ),
              value: 'API_KEY' as MainOption,
            },
          ]
        : []),
    ],
    [showApiKeyOption],
  );

  // -- Navigation -----------------------------------------------------------

  const clearErrors = () => {
    setErrorMessage(null);
    onAuthError(null);
  };

  const pushView = (view: ViewLevel) => {
    setViewStack((prev) => [...prev, viewLevel]);
    setViewLevel(view);
  };

  const goBack = () => {
    clearErrors();

    if (viewLevel === 'provider-setup') {
      if (setupFlow.goBack()) return;
    }

    setViewStack((prev) => {
      const next = [...prev];
      const parent = next.pop() ?? 'main';
      setViewLevel(parent);
      return next;
    });
  };

  const existingEnv = (settings.merged.env ?? {}) as Record<string, string>;

  // -- Default main index from current auth state ---------------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const matchedProvider = findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  );

  // DP Auth is index 0, anything else (API key providers) → index 1.
  const defaultMainIndex = useMemo(() => {
    if (matchedProvider?.id === 'dp-auth') return 0;
    return matchedProvider ? 1 : 0;
  }, [matchedProvider]);

  // -- Handlers -------------------------------------------------------------

  const handleMainSelect = (value: MainOption) => {
    clearErrors();
    switch (value) {
      case 'DP_AUTH':
        // OAuth flow — useAuth.handleProviderSubmit detects oauthFlow: true
        // and calls refreshAuth(DP_AUTH) directly; no setup steps to render.
        void handleProviderSubmit(dpAuthProvider, {
          baseUrl: '',
          apiKey: '',
          modelIds: [],
        });
        break;
      case 'API_KEY':
        setupFlow.start(customProvider, undefined, existingEnv);
        pushView('provider-setup');
        break;
      default:
        break;
    }
  };

  // -- Keyboard handling ----------------------------------------------------

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (viewLevel !== 'main') {
          goBack();
          return;
        }
        if (errorMessage) return;
        if (config.getAuthType() === undefined) {
          setErrorMessage(
            t(
              'You must connect a provider to proceed. Press Ctrl+C again to exit.',
            ),
          );
          return;
        }
        closeAuthDialog();
      }
    },
    { isActive: true },
  );

  // -- View title -----------------------------------------------------------

  const viewTitle = useMemo(() => {
    if (viewLevel !== 'provider-setup') {
      return VIEW_TITLES[viewLevel] ?? VIEW_TITLES['main'];
    }
    const p = setupFlow.state.provider;
    if (!p) return t('Provider Setup');
    const flowTitle = p.uiLabels?.flowTitle ?? p.label;
    const { stepIndex, totalSteps, step } = setupFlow.state;
    return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
      flowTitle,
      step: String(stepIndex),
      total: String(totalSteps),
      stepLabel: getStepLabel(step, p),
    });
  }, [viewLevel, setupFlow.state]);

  // -- Render ---------------------------------------------------------------

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{viewTitle}</Text>

      {isAuthenticating ? (
        <Box marginTop={1}>
          <AuthInProgress onTimeout={closeAuthDialog} />
        </Box>
      ) : (
        <>
          {viewLevel === 'main' && (
            <Box marginTop={1}>
              <DescriptiveRadioButtonSelect
                items={MAIN_ITEMS_WITH_CONDITIONAL_API_KEY}
                initialIndex={mainIndex != null ? mainIndex : defaultMainIndex}
                onSelect={handleMainSelect}
                onHighlight={(value) => {
                  setMainIndex(
                    MAIN_ITEMS_WITH_CONDITIONAL_API_KEY.findIndex(
                      (item) => item.value === value,
                    ),
                  );
                }}
                itemGap={1}
              />
            </Box>
          )}

          {viewLevel === 'provider-setup' && (
            <ProviderSetupSteps flow={setupFlow} />
          )}

          {(authError || errorMessage) && (
            <Box marginTop={1}>
              <Text color={theme.status.error}>
                {authError || errorMessage}
              </Text>
            </Box>
          )}

          {viewLevel === 'main' && (
            <>
              <Box marginY={1}>
                <Text color={theme.border.default}>{'─'.repeat(80)}</Text>
              </Box>
              <Box>
                <Text color={theme.text.primary}>
                  {t('Terms of Services and Privacy Notice')}:
                </Text>
              </Box>
              <Box>
                <Link
                  url="https://nestor.pages.devplatform.tcsbank.ru/assistant/docs/main/nessy-cli/users/work/support/tos-privacy/"
                  fallback={false}
                >
                  <Text color={theme.text.secondary} underline>
                    https://nestor.pages.devplatform.tcsbank.ru/assistant/docs/main/nessy-cli/users/work/support/tos-privacy/
                  </Text>
                </Link>
              </Box>
            </>
          )}
        </>
      )}
    </Box>
  );
}
