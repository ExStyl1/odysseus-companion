/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@nestor/nessy-cli-core';
import type { LoadedSettings } from '../../config/settings.js';
import { useDefaultExtensionDialog } from './use-default-extension-dialog.js';

describe('useDefaultExtensionDialog', () => {
  it('recognizes the installed npm extension regardless of source casing', () => {
    const config = {
      getExtensions: () => [
        {
          name: 'nessy-default-extension',
          installMetadata: {
            type: 'npm',
            source: '@Nestor/nessy-cli-extensions',
          },
        },
      ],
    } as unknown as Config;
    const settings = {
      merged: {},
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const { result } = renderHook(() =>
      useDefaultExtensionDialog({
        config,
        settings,
        handleSlashCommand: vi.fn(),
        isConfigInitialized: true,
      }),
    );

    expect(result.current.showDefaultExtensionDialog).toBe(false);
  });
});
