/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  IdeClient,
  IdeConnectionEvent,
  IdeConnectionType,
  logIdeConnection,
  type Config,
} from '@nestor/nessy-cli-core';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import { getPersistScopeForModelSelection } from '../config/modelProvidersScope.js';
import { performInitialAuth } from './auth.js';
import { ensureDpBinary } from './dpBinary.js';
import { validateTheme } from './theme.js';
import { initializeI18n, resolveLanguageSetting } from '../i18n/index.js';

export interface InitializationResult {
  authError: string | null;
  themeError: string | null;
  shouldOpenAuthDialog: boolean;
  geminiMdFileCount: number;
}

/**
 * Orchestrates the application's startup initialization.
 * This runs BEFORE the React UI is rendered.
 * @param config The application config.
 * @param settings The loaded application settings.
 * @returns The results of the initialization.
 */
export async function initializeApp(
  config: Config,
  settings: LoadedSettings,
): Promise<InitializationResult> {
  // Initialize i18n system
  await initializeI18n(
    resolveLanguageSetting(settings.merged.general?.language as string),
  );

  // [nessy-fork] dp-binary-lifecycle
  // Install the managed `dp` binary before anything can spawn it. The bundled
  // dp MCP servers (dpWiki, codeSearch, dpJira, …) are started from
  // config.initialize() and would fail with ENOENT otherwise. This is
  // independent of auth because cached credentials live in oauth_creds.json,
  // outside dp_latest, so auth cannot be relied on to put the binary in place.
  await ensureDpBinary();

  // Use authType from modelsConfig which respects CLI --auth-type argument
  // over settings.security.auth.selectedType
  const modelsConfig = config.getModelsConfig();
  const authType = modelsConfig.getCurrentAuthType();
  const persistScope = getPersistScopeForModelSelection(settings);

  // [nessy-fork] dp-auth-runtime-model-catalog
  for (const scope of [SettingScope.User, SettingScope.Workspace]) {
    const scopedSettings = settings.forScope(scope).settings;
    const modelProviders = scopedSettings.modelProviders;
    if (modelProviders && Object.hasOwn(modelProviders, AuthType.DP_AUTH)) {
      settings.setValue(scope, 'modelProviders.dp-auth', undefined);
    }
    if (
      authType === AuthType.DP_AUTH &&
      scopedSettings.model &&
      Object.hasOwn(scopedSettings.model, 'baseUrl')
    ) {
      settings.setValue(scope, 'model.baseUrl', undefined);
    }
  }

  const modelBeforeInitialAuth = modelsConfig.getModel();
  // [nessy-fork] dp-auth-single-startup-auth
  const authError = await performInitialAuth(config, authType);

  if (authType === AuthType.DP_AUTH && !authError) {
    // [nessy-fork] dp-auth-coder-model-default
    const selectedModel = modelsConfig.getModel();
    if (selectedModel !== modelBeforeInitialAuth) {
      settings.setValue(persistScope, 'model.name', selectedModel);
    }
    const fastModel = config.getFastModel() ?? '';
    if ((settings.merged.fastModel ?? '') !== fastModel) {
      settings.setValue(persistScope, 'fastModel', fastModel);
    }
    const visualModel = config.getVisualModel() ?? '';
    if ((settings.merged.visualModel ?? '') !== visualModel) {
      settings.setValue(persistScope, 'visualModel', visualModel);
    }
  }

  const themeError = validateTheme(settings);

  const shouldOpenAuthDialog =
    !config.getModelsConfig().wasAuthTypeExplicitlyProvided() || !!authError;

  if (config.getIdeMode() && config.isInteractive()) {
    void IdeClient.getInstance()
      .then(async (ideClient) => {
        await ideClient.connect();
        logIdeConnection(
          config,
          new IdeConnectionEvent(IdeConnectionType.START),
        );
      })
      .catch(() => {
        // IDE integration is optional and should never block CLI startup.
      });
  }

  return {
    authError,
    themeError,
    shouldOpenAuthDialog,
    geminiMdFileCount: config.getGeminiMdFileCount(),
  };
}
