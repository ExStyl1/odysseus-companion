import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates } from './updateCheck.js';

const mocks = vi.hoisted(() => ({
  getPackageJson: vi.fn(),
  updateNotifier: vi.fn(),
  fetchInfo: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../../utils/package.js', () => ({
  getPackageJson: mocks.getPackageJson,
}));
vi.mock('update-notifier', () => ({ default: mocks.updateNotifier }));

describe('Nessy update policy without a release channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetchInfo.mockResolvedValue({
      current: '0.19.1',
      latest: '99.0.0',
    });
    mocks.updateNotifier.mockReturnValue({ fetchInfo: mocks.fetchInfo });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    { version: '0.19.1', dev: false },
    { version: '0.19.1-nightly.1', dev: false },
    { version: '0.19.1', dev: true },
  ])(
    'does not discover updates for $version with DEV=$dev',
    async ({ version, dev }) => {
      vi.stubEnv('DEV', dev);
      mocks.getPackageJson.mockResolvedValue({
        name: '@nestor/nessy-cli',
        version,
      });

      await expect(checkForUpdates()).resolves.toBeNull();

      expect(mocks.getPackageJson).not.toHaveBeenCalled();
      expect(mocks.updateNotifier).not.toHaveBeenCalled();
      expect(mocks.fetchInfo).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});
