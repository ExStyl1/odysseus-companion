import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getIdeInstaller } from './ide-installer.js';
import { IDE_DEFINITIONS } from './detect-ide.js';

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
  fetch: vi.fn(),
  existsSync: vi.fn(),
  homedir: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: mocks.homedir,
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: mocks.execSync,
  spawnSync: mocks.spawnSync,
}));

describe('Nessy IDE installation policy without a marketplace release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(false);
    mocks.homedir.mockReturnValue('/home/nessy-policy-test');
    vi.stubGlobal('fetch', mocks.fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const platforms: NodeJS.Platform[] = ['linux', 'darwin', 'win32'];
  const cases = [
    IDE_DEFINITIONS.vscode,
    IDE_DEFINITIONS.firebasestudio,
  ].flatMap((ide) =>
    platforms.flatMap((platform) =>
      [true, false].map((available) => ({ ide, platform, available })),
    ),
  );

  it.each(cases)(
    'refuses $ide.name installation on $platform, CLI available: $available',
    async ({ ide, platform, available }) => {
      mocks.execSync.mockImplementation(() => {
        if (!available) throw new Error('Command not found');
        return Buffer.from('/opt/nessy-policy-test/code');
      });
      const installer = getIdeInstaller(ide, platform);
      expect(installer).not.toBeNull();

      await expect(installer!.install()).resolves.toEqual({
        success: false,
        message:
          'Automatic extension installation is unavailable for this build. Install the Nessy companion VSIX produced by this source checkout.',
      });

      expect(mocks.spawnSync).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
});
