/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('node:child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 0 })),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({ version: '0.8.0' })),
    promises: {
      ...actual.promises,
      mkdtemp: vi.fn(),
      writeFile: vi.fn(),
      rm: vi.fn(),
    },
  };
});
vi.mock('os');

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getIdeInstaller } from './ide-installer.js';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IDE_DEFINITIONS, type IdeInfo } from './detect-ide.js';

describe('ide-installer', () => {
  const HOME_DIR = '/home/user';
  const VSIX_DIR = '/tmp/nessy-vsix-123';
  const VSIX_PATH = path.join(VSIX_DIR, 'nessy-cli-vscode-ide-companion.vsix');

  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue(HOME_DIR);
    vi.spyOn(os, 'tmpdir').mockReturnValue('/tmp');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );
    vi.mocked(fs.promises.mkdtemp).mockResolvedValue(VSIX_DIR);
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('getIdeInstaller', () => {
    it.each([
      { ide: IDE_DEFINITIONS.vscode },
      { ide: IDE_DEFINITIONS.firebasestudio },
    ])('returns a VsCodeInstaller for "$ide.name"', ({ ide }) => {
      const installer = getIdeInstaller(ide);

      expect(installer).not.toBeNull();
      expect(installer?.install).toEqual(expect.any(Function));
    });
  });

  describe('VsCodeInstaller', () => {
    function setup({
      ide = IDE_DEFINITIONS.vscode,
      existsResult = false,
      execSync = () => '',
      platform = 'linux' as NodeJS.Platform,
    }: {
      ide?: IdeInfo;
      existsResult?: boolean;
      execSync?: () => string;
      platform?: NodeJS.Platform;
    } = {}) {
      vi.spyOn(child_process, 'execSync').mockImplementation(execSync);
      vi.spyOn(fs, 'existsSync').mockReturnValue(existsResult);
      const installer = getIdeInstaller(ide, platform)!;

      return { installer };
    }

    describe('install', () => {
      it.each([
        {
          platform: 'win32' as NodeJS.Platform,
          expectedLookupPaths: [
            path.join('C:\\Program Files', 'Microsoft VS Code/bin/code.cmd'),
            path.join(
              HOME_DIR,
              '/AppData/Local/Programs/Microsoft VS Code/bin/code.cmd',
            ),
          ],
        },
        {
          platform: 'darwin' as NodeJS.Platform,
          expectedLookupPaths: [
            '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
            path.join(HOME_DIR, 'Library/Application Support/Code/bin/code'),
          ],
        },
        {
          platform: 'linux' as NodeJS.Platform,
          expectedLookupPaths: ['/usr/share/code/bin/code'],
        },
      ])(
        'identifies the path to code cli on platform: $platform',
        async ({ platform, expectedLookupPaths }) => {
          const { installer } = setup({
            platform,
            execSync: () => {
              throw new Error('Command not found'); // `code` is not in PATH
            },
          });
          await installer.install();
          for (const [idx, path] of expectedLookupPaths.entries()) {
            expect(fs.existsSync).toHaveBeenNthCalledWith(idx + 1, path);
          }
        },
      );

      it('installs the latest extension from S3 using code cli', async () => {
        const { installer } = setup({
          platform: 'linux',
        });
        await installer.install();

        // Note: The implementation uses process.platform, not the mocked platform
        const isActuallyWindows = process.platform === 'win32';
        const expectedCommand = isActuallyWindows ? '"code"' : 'code';

        expect(fetch).toHaveBeenCalledWith(
          'https://s3-msk.tinkoff.ru/nestor-companion/vscode/nessy-cli-vscode-ide-companion-latest.vsix',
        );
        expect(child_process.spawnSync).toHaveBeenCalledWith(
          expectedCommand,
          ['--install-extension', VSIX_PATH, '--force'],
          { stdio: 'pipe', shell: isActuallyWindows },
        );
      });

      it.each([
        {
          ide: IDE_DEFINITIONS.vscode,
          expectedMessage:
            'VS Code companion extension was installed successfully',
        },
        {
          ide: IDE_DEFINITIONS.firebasestudio,
          expectedMessage:
            'Firebase Studio companion extension was installed successfully',
        },
      ])(
        'returns that the cli was installed successfully',
        async ({ ide, expectedMessage }) => {
          const { installer } = setup({ ide });
          const result = await installer.install();
          expect(result.success).toBe(true);
          expect(result.message).toContain(expectedMessage);
        },
      );

      it.each([
        {
          ide: IDE_DEFINITIONS.vscode,
          expectedErr: 'VS Code CLI not found',
        },
        {
          ide: IDE_DEFINITIONS.firebasestudio,
          expectedErr: 'Firebase Studio CLI not found',
        },
      ])(
        'should return a failure message if $ide is not installed',
        async ({ ide, expectedErr }) => {
          const { installer } = setup({
            ide,
            execSync: () => {
              throw new Error('Command not found');
            },
            existsResult: false,
          });
          const result = await installer.install();
          expect(result.success).toBe(false);
          expect(result.message).toContain(expectedErr);
        },
      );
    });
  });
});
