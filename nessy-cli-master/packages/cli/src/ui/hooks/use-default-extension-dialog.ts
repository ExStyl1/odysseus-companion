/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo } from 'react';
import { isNewExtensionInstalled, type Config } from '@nestor/nessy-cli-core';
import { type LoadedSettings, SettingScope } from '../../config/settings.js';

const DEFAULT_EXTENSION_SOURCE = '@nestor/nessy-cli-extensions';
const DEFAULT_EXTENSION_REGISTRY =
  'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all/';

interface UseDefaultExtensionDialogOptions {
  config: Config;
  settings: LoadedSettings;
  handleSlashCommand: (command: string) => void;
  isConfigInitialized: boolean;
}

export function useDefaultExtensionDialog({
  config,
  settings,
  handleSlashCommand,
  isConfigInitialized,
}: UseDefaultExtensionDialogOptions) {
  const [dismissed, setDismissed] = useState(false);

  const hasSeenPrompt =
    settings.merged.extensions?.hasSeenDefaultExtensionPrompt === true;

  const isDefaultExtensionInstalled = useMemo(() => {
    if (!isConfigInitialized) return false;
    const extensions = config.getExtensions?.() ?? [];

    // [nessy-fork] auto-update-migration
    return isNewExtensionInstalled(extensions);
  }, [config, isConfigInitialized]);

  const showDefaultExtensionDialog =
    isConfigInitialized &&
    !hasSeenPrompt &&
    !isDefaultExtensionInstalled &&
    !dismissed;

  const handleDefaultExtensionInstall = useCallback(() => {
    // [nessy-fork] auto-update-migration
    setDismissed(true);
    handleSlashCommand(
      `/extensions install ${DEFAULT_EXTENSION_SOURCE} --registry=${DEFAULT_EXTENSION_REGISTRY} --auto-update`,
    );
  }, [handleSlashCommand]);

  const handleDefaultExtensionSkip = useCallback(() => {
    settings.setValue(
      SettingScope.User,
      'extensions.hasSeenDefaultExtensionPrompt',
      true,
    );
    setDismissed(true);
  }, [settings]);

  return {
    showDefaultExtensionDialog,
    handleDefaultExtensionInstall,
    handleDefaultExtensionSkip,
  };
}
