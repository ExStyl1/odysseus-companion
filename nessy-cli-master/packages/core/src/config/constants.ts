/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_NESSY_CUSTOM_IGNORE_FILE_NAMES } from '../utils/nessyIgnoreParser.js';

export interface FileFilteringOptions {
  respectGitIgnore: boolean;
  respectNessyIgnore: boolean;
  customIgnoreFiles?: string[];
}

// For memory files
export const DEFAULT_MEMORY_FILE_FILTERING_OPTIONS: FileFilteringOptions = {
  respectGitIgnore: false,
  respectNessyIgnore: true,
  customIgnoreFiles: [...DEFAULT_NESSY_CUSTOM_IGNORE_FILE_NAMES],
};

// For all other files
export const DEFAULT_FILE_FILTERING_OPTIONS: FileFilteringOptions = {
  respectGitIgnore: true,
  respectNessyIgnore: true,
  customIgnoreFiles: [...DEFAULT_NESSY_CUSTOM_IGNORE_FILE_NAMES],
};
