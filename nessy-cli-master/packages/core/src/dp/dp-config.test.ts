/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import {
  DP_CONFIG,
  getDpCredentialsPath,
  getDpFilePath,
  getDpFolderPath,
} from './dp-config.js';

const mockPlatform = vi.hoisted(() => vi.fn());

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: mockPlatform,
}));

describe('DP paths', () => {
  const originalNessyHome = process.env['NESSY_HOME'];

  beforeEach(() => {
    delete process.env['NESSY_HOME'];
    mockPlatform.mockReset();
  });

  afterEach(() => {
    if (originalNessyHome === undefined) {
      delete process.env['NESSY_HOME'];
    } else {
      process.env['NESSY_HOME'] = originalNessyHome;
    }
  });

  it.each([
    ['win32', 'dp.exe'],
    ['darwin', 'dp'],
    ['linux', 'dp'],
  ] as const)('uses %s binary name', (platform, binaryName) => {
    mockPlatform.mockReturnValue(platform);

    expect(getDpFilePath()).toBe(
      path.join(Storage.getGlobalNessyDir(), DP_CONFIG.workDirName, binaryName),
    );
  });

  it('uses NESSY_HOME for the managed binary and credentials', () => {
    const nessyHome = path.resolve('custom-nessy-home');
    process.env['NESSY_HOME'] = nessyHome;
    mockPlatform.mockReturnValue('linux');

    expect(getDpFolderPath()).toBe(path.join(nessyHome, DP_CONFIG.workDirName));
    expect(getDpFilePath()).toBe(
      path.join(nessyHome, DP_CONFIG.workDirName, 'dp'),
    );
    expect(getDpCredentialsPath()).toBe(
      path.join(nessyHome, DP_CONFIG.credentialsFileName),
    );
  });
});
