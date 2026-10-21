/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { getUserSettingsDir, getUserSettingsPath } from './settings.js';
import { getTrustedFoldersPath } from './trustedFolders.js';

// Regression guard: `NESSY_HOME` is resolved by `preResolveHomeEnvOverrides()`
// AFTER any module that imports a settings/trustedFolders path has loaded.
// A top-level `const` would freeze the pre-bootstrap value and split state
// across callers. Each test mutates `process.env.NESSY_HOME` post-load and
// asserts the exported path getters reflect the new value.

describe('settings/trustedFolders path getters are lazy', () => {
  let originalNessyHome: string | undefined;
  let originalTrustedPath: string | undefined;

  beforeEach(() => {
    originalNessyHome = process.env['NESSY_HOME'];
    originalTrustedPath = process.env['NESSY_CLI_TRUSTED_FOLDERS_PATH'];
    delete process.env['NESSY_HOME'];
    delete process.env['NESSY_CLI_TRUSTED_FOLDERS_PATH'];
  });

  afterEach(() => {
    if (originalNessyHome === undefined) delete process.env['NESSY_HOME'];
    else process.env['NESSY_HOME'] = originalNessyHome;
    if (originalTrustedPath === undefined)
      delete process.env['NESSY_CLI_TRUSTED_FOLDERS_PATH'];
    else process.env['NESSY_CLI_TRUSTED_FOLDERS_PATH'] = originalTrustedPath;
  });

  it('getUserSettingsPath() reflects NESSY_HOME set after module load', () => {
    const defaultPath = getUserSettingsPath();
    expect(defaultPath).toBe(path.join(homedir(), '.nessy', 'settings.json'));

    process.env['NESSY_HOME'] = '/tmp/nessy-lazy-test';
    expect(getUserSettingsPath()).toBe(
      path.join('/tmp/nessy-lazy-test', 'settings.json'),
    );
  });

  it('getUserSettingsDir() reflects NESSY_HOME set after module load', () => {
    expect(getUserSettingsDir()).toBe(path.join(homedir(), '.nessy'));

    process.env['NESSY_HOME'] = '/tmp/nessy-lazy-test';
    expect(getUserSettingsDir()).toBe(path.normalize('/tmp/nessy-lazy-test'));
  });

  it('getTrustedFoldersPath() reflects NESSY_HOME set after module load', () => {
    expect(getTrustedFoldersPath()).toBe(
      path.join(homedir(), '.nessy', 'trustedFolders.json'),
    );

    process.env['NESSY_HOME'] = '/tmp/nessy-lazy-test';
    expect(getTrustedFoldersPath()).toBe(
      path.join('/tmp/nessy-lazy-test', 'trustedFolders.json'),
    );
  });
});
