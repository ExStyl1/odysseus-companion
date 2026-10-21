/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { checkForUpdates } from './updateCheck.js';
import { NPM_REGISTRY_URL } from '../../constants.js';

const getPackageJson = vi.hoisted(() => vi.fn());
vi.mock('../../utils/package.js', () => ({
  getPackageJson,
}));

const packageJsonMock = vi.hoisted(() => vi.fn());
vi.mock('package-json', () => ({
  default: packageJsonMock,
}));

describe('checkForUpdates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    // Clear DEV environment variable before each test
    delete process.env['DEV'];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return null when running from source (DEV=true)', async () => {
    process.env['DEV'] = 'true';
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    packageJsonMock.mockResolvedValue({ version: '1.1.0' });
    const result = await checkForUpdates();
    expect(result).toBeNull();
    expect(getPackageJson).not.toHaveBeenCalled();
    expect(packageJsonMock).not.toHaveBeenCalled();
  });

  it('should return null if package.json is missing', async () => {
    getPackageJson.mockResolvedValue(null);
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if there is no update', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    packageJsonMock.mockRejectedValue(new Error('not found'));
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return a message if a newer version is available', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    packageJsonMock.mockResolvedValue({ version: '1.1.0' });

    const result = await checkForUpdates();
    expect(result?.message).toContain('1.0.0 → 1.1.0');
    expect(result?.update).toEqual({
      current: '1.0.0',
      latest: '1.1.0',
      type: 'latest',
      name: 'test-package',
    });
  });

  it('should return null if the latest version is the same as the current version', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    packageJsonMock.mockResolvedValue({ version: '1.0.0' });
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if the latest version is older than the current version', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.1.0',
    });
    packageJsonMock.mockResolvedValue({ version: '1.0.0' });
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should return null if fetch rejects', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    packageJsonMock.mockRejectedValue(new Error('Timeout'));

    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should handle errors gracefully', async () => {
    getPackageJson.mockRejectedValue(new Error('test error'));
    const result = await checkForUpdates();
    expect(result).toBeNull();
  });

  it('should pass registryUrl to package-json', async () => {
    getPackageJson.mockResolvedValue({
      name: 'test-package',
      version: '1.0.0',
    });
    packageJsonMock.mockResolvedValue({ version: '1.1.0' });

    await checkForUpdates();
    expect(packageJsonMock).toHaveBeenCalledWith('test-package', {
      version: 'latest',
      registryUrl: NPM_REGISTRY_URL,
    });
  });

  describe('nightly updates', () => {
    it('should notify for a newer nightly version when current is nightly', async () => {
      getPackageJson.mockResolvedValue({
        name: 'test-package',
        version: '1.2.3-nightly.1',
      });

      packageJsonMock.mockImplementation(
        (_name: string, opts: { version: string }) => {
          if (opts.version === 'nightly') {
            return Promise.resolve({ version: '1.2.3-nightly.2' });
          }
          if (opts.version === 'latest') {
            return Promise.resolve({ version: '1.2.3' });
          }
          return Promise.reject(new Error('not found'));
        },
      );

      const result = await checkForUpdates();
      expect(result?.message).toContain('1.2.3-nightly.1 → 1.2.3-nightly.2');
      expect(result?.update.latest).toBe('1.2.3-nightly.2');
    });
  });
});
