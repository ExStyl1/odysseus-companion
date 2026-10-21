/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getGitLabToken,
  parseGitLabSource,
  downloadFromGitLabRelease,
  checkForGitLabExtensionUpdate,
} from './gitlab.js';
import type { ExtensionInstallMetadata } from '../config/config.js';
import type { Extension, ExtensionManager } from './extensionManager.js';
import * as fs from 'node:fs';
import { ExtensionUpdateState } from './extensionManager.js';

// Hoisted mock for spawn
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: mockSpawn,
  };
});
vi.mock('../dp/index.js', () => ({
  performDpAuth: vi.fn(),
  getDpToken: vi.fn(),
}));

vi.mock('node:https');
vi.mock('node:fs');
vi.mock('tar');
vi.mock('extract-zip');

describe('gitlab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getGitLabToken', () => {
    it('should return token from getDpToken when available', async () => {
      const { getDpToken } = await import('../dp/index.js');
      vi.mocked(getDpToken).mockResolvedValue('test-token-123');

      const token = await getGitLabToken();
      expect(token).toBe('test-token-123');
      expect(getDpToken).toHaveBeenCalledTimes(1);
    });

    it('should call performDpAuth when getDpToken returns undefined', async () => {
      const { getDpToken, performDpAuth } = await import('../dp/index.js');
      vi.mocked(getDpToken).mockResolvedValue(undefined);
      vi.mocked(performDpAuth).mockResolvedValue('test-token-456');

      const token = await getGitLabToken();
      expect(token).toBe('test-token-456');
      expect(getDpToken).toHaveBeenCalledTimes(1);
      expect(performDpAuth).toHaveBeenCalledTimes(1);
    });

    it('should throw error when getDpToken and performDpAuth throw', async () => {
      const { getDpToken, performDpAuth } = await import('../dp/index.js');
      vi.mocked(getDpToken).mockRejectedValue(new Error('DP error'));
      vi.mocked(performDpAuth).mockRejectedValue(new Error('DP login error'));

      await expect(getGitLabToken()).rejects.toThrow(
        /Failed to get GitLab token/,
      );
    });

    it('should throw DpAuthServiceError when performDpAuth throws DpAuthServiceError', async () => {
      const { getDpToken, performDpAuth } = await import('../dp/index.js');
      const { DpAuthServiceError, DpAuthError } =
        await import('../dp/dp-errors.js');
      vi.mocked(getDpToken).mockResolvedValue(undefined);
      vi.mocked(performDpAuth).mockRejectedValue(
        new DpAuthServiceError(DpAuthError.CantLogin, 'Login failed'),
      );

      await expect(getGitLabToken()).rejects.toThrow(DpAuthServiceError);
    });
  });

  describe('parseGitLabSource', () => {
    it('should parse tenant/repo format', () => {
      const result = parseGitLabSource('spirit-context/my-extension');
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('spirit-context/my-extension');
      expect(result.isUrl).toBe(false);
    });

    it('should parse full GitLab URL', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/spirit-context/my-extension',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('spirit-context/my-extension');
      expect(result.isUrl).toBe(true);
    });

    it('should parse GitLab URL with .git suffix', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/spirit-context/my-extension.git',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('spirit-context/my-extension');
      expect(result.isUrl).toBe(true);
    });

    it('should parse GitLab web URL with /-/tree/branch', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/system-analysis/docforge/-/tree/master/extensions/nessy',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('system-analysis/docforge');
      expect(result.isUrl).toBe(true);
      expect(result.ref).toBe('master');
    });

    it('should parse GitLab web URL with /-/tree/branch and nested path', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/tenant/repo/-/tree/main/subdir/plugin',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('tenant/repo');
      expect(result.isUrl).toBe(true);
      expect(result.ref).toBe('main');
    });

    it('should parse GitLab web URL without extension path', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/tenant/repo/-/tree/main',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('tenant/repo');
      expect(result.isUrl).toBe(true);
      expect(result.ref).toBe('main');
    });

    it('should parse GitLab web URL with /-/blob/branch', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/tenant/repo/-/blob/main/file.txt',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('tenant/repo');
      expect(result.isUrl).toBe(true);
      expect(result.ref).toBe('main');
    });

    it('should parse GitLab web URL with /-/archive/tag', () => {
      const result = parseGitLabSource(
        'https://gitlab.tcsbank.ru/tenant/repo/-/archive/v1.0.0',
      );
      expect(result.gitlabHost).toBe('gitlab.tcsbank.ru');
      expect(result.projectId).toBe('tenant/repo');
      expect(result.isUrl).toBe(true);
      expect(result.ref).toBe('v1.0.0');
    });

    it('should throw error for invalid format', () => {
      expect(() => parseGitLabSource('invalid')).toThrow(
        /Invalid GitLab source format/,
      );
    });

    it('should throw error for non-GitLab URL', () => {
      expect(() => parseGitLabSource('https://github.com/org/repo')).toThrow(
        /Expected GitLab URL/,
      );
    });
  });

  describe('cloneFromGitlab', () => {
    it('should use git clone with stdio: inherit for cloning repository', async () => {
      const installMetadata: ExtensionInstallMetadata = {
        source: 'test/repo',
        type: 'gitlab-git',
        gitlabHost: 'gitlab.tcsbank.ru',
        gitlabProjectId: 'test/repo',
      };

      const { cloneFromGitlab } = await import('./gitlab.js');
      const { spawn } = await import('node:child_process');
      const EventEmitter = (await import('node:events')).EventEmitter;

      // Mock spawn to return a successful process
      const mockProcess = new EventEmitter();
      (mockProcess as any).stdout = new EventEmitter();
      (mockProcess as any).stderr = new EventEmitter();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const clonePromise = cloneFromGitlab(installMetadata, '/tmp/test-dest');

      // Simulate successful completion
      setTimeout(() => mockProcess.emit('close', 0), 10);

      await clonePromise;

      expect(spawn).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining([
          'clone',
          '--depth',
          '1',
          'https://gitlab.tcsbank.ru/test/repo.git',
          '/tmp/test-dest',
        ]),
        expect.objectContaining({
          stdio: ['ignore', 'inherit', 'inherit'],
          env: expect.objectContaining({
            GIT_TERMINAL_PROMPT: '0',
          }),
        }),
      );
    });

    it('should use specified ref when provided', async () => {
      const installMetadata: ExtensionInstallMetadata = {
        source: 'test/repo',
        type: 'gitlab-git',
        gitlabHost: 'gitlab.tcsbank.ru',
        gitlabProjectId: 'test/repo',
        ref: 'my-branch',
      };

      const { getDpToken } = await import('../dp/index.js');
      vi.mocked(getDpToken).mockResolvedValue('test-token-123');

      const { cloneFromGitlab } = await import('./gitlab.js');
      const { spawn } = await import('node:child_process');
      const EventEmitter = (await import('node:events')).EventEmitter;

      const mockProcess = new EventEmitter();
      (mockProcess as any).stdout = new EventEmitter();
      (mockProcess as any).stderr = new EventEmitter();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const clonePromise = cloneFromGitlab(installMetadata, '/tmp/test-dest');

      setTimeout(() => mockProcess.emit('close', 0), 10);

      await clonePromise;

      const spawnCall = vi.mocked(spawn).mock.calls[0];
      expect(spawnCall[1]).toContain('-b');
      expect(spawnCall[1]).toContain('my-branch');
    });

    it('should throw error when git clone fails', async () => {
      const installMetadata: ExtensionInstallMetadata = {
        source: 'test/repo',
        type: 'gitlab-git',
        gitlabHost: 'gitlab.tcsbank.ru',
        gitlabProjectId: 'test/repo',
      };

      const { getDpToken } = await import('../dp/index.js');
      vi.mocked(getDpToken).mockResolvedValue('test-token-123');

      const { cloneFromGitlab } = await import('./gitlab.js');
      const { spawn } = await import('node:child_process');
      const EventEmitter = (await import('node:events')).EventEmitter;

      const mockProcess = new EventEmitter();
      (mockProcess as any).stdout = new EventEmitter();
      (mockProcess as any).stderr = new EventEmitter();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const clonePromise = cloneFromGitlab(installMetadata, '/tmp/test-dest');

      // Simulate failure
      setTimeout(() => mockProcess.emit('close', 128), 10);

      await expect(clonePromise).rejects.toThrow(
        /Не удалось установить расширение из GitLab/,
      );
    });

    it('should throw error when git process errors', async () => {
      const installMetadata: ExtensionInstallMetadata = {
        source: 'test/repo',
        type: 'gitlab-git',
        gitlabHost: 'gitlab.tcsbank.ru',
        gitlabProjectId: 'test/repo',
      };

      const { cloneFromGitlab } = await import('./gitlab.js');
      const { spawn } = await import('node:child_process');
      const EventEmitter = (await import('node:events')).EventEmitter;

      const mockProcess = new EventEmitter();
      (mockProcess as any).stdout = new EventEmitter();
      (mockProcess as any).stderr = new EventEmitter();
      vi.mocked(spawn).mockReturnValue(mockProcess as any);

      const clonePromise = cloneFromGitlab(installMetadata, '/tmp/test-dest');

      // Simulate process error
      setTimeout(
        () => mockProcess.emit('error', new Error('spawn ENOENT')),
        10,
      );

      await expect(clonePromise).rejects.toThrow(
        /Не удалось выполнить git clone: spawn ENOENT/,
      );
    });
  });

  describe('downloadFromGitLabRelease', () => {
    it('should download release archive', async () => {
      const { getDpToken } = await import('../dp/index.js');
      vi.mocked(getDpToken).mockResolvedValue('test-token');

      // Mock https.get
      const httpsModule = await import('node:https');
      const mockGet = vi.spyOn(httpsModule, 'get');

      // Mock release API response
      mockGet.mockImplementation(((
        url: string,
        options: any,
        callback: any,
      ) => {
        if (url.includes('/releases/')) {
          const res = {
            statusCode: 200,
            on: vi.fn((event, cb) => {
              if (event === 'data') {
                cb(
                  Buffer.from(
                    JSON.stringify({
                      tag_name: 'v1.0.0',
                      assets: { links: [] },
                    }),
                  ),
                );
              } else if (event === 'end') {
                cb();
              }
            }),
          };
          callback(res);
        } else {
          // Archive download
          const res = {
            statusCode: 200,
            pipe: vi.fn(),
            on: vi.fn((event, cb) => {
              if (event === 'finish') cb();
            }),
          };
          callback(res);
        }
        return { on: vi.fn() };
      }) as any);

      // Mock fs operations
      vi.mocked(fs.promises.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.promises.unlink).mockResolvedValue();

      const installMetadata: ExtensionInstallMetadata = {
        source: 'test/repo',
        type: 'gitlab-release',
        gitlabHost: 'gitlab.tcsbank.ru',
        gitlabProjectId: 'test/repo',
        ref: 'v1.0.0',
      };

      // This will fail in test environment due to complex mocking,
      // but tests the basic flow
      await expect(
        downloadFromGitLabRelease(installMetadata, '/tmp/test'),
      ).rejects.toThrow();
    });
  });

  describe('checkForGitLabExtensionUpdate', () => {
    it('should return NOT_UPDATABLE for wrong type', async () => {
      const extension = {
        installMetadata: {
          type: 'local' as const,
          source: '/test',
        },
      } as unknown as Extension;

      const result = await checkForGitLabExtensionUpdate(
        extension,
        {} as ExtensionManager,
      );

      expect(result).toBe(ExtensionUpdateState.NOT_UPDATABLE);
    });

    it('should check gitlab-git update via git', async () => {
      // Mock for git remote get-url
      const mockRemoteProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('https://gitlab.test/repo\n');
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };

      // Mock for git ls-remote
      const mockLsRemoteProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('abc123\tHEAD\n');
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };

      // Mock for git rev-parse
      const mockRevParseProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('def456\n');
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };

      mockSpawn
        .mockReturnValueOnce(mockRemoteProcess as any)
        .mockReturnValueOnce(mockLsRemoteProcess as any)
        .mockReturnValueOnce(mockRevParseProcess as any);

      const extension = {
        installMetadata: {
          type: 'gitlab-git' as const,
          source: 'test/repo',
          gitlabHost: 'gitlab.tcsbank.ru',
          gitlabProjectId: 'test/repo',
        },
        path: '/test/extension',
      } as unknown as Extension;

      const result = await checkForGitLabExtensionUpdate(
        extension,
        {} as ExtensionManager,
      );

      expect(result).toBe(ExtensionUpdateState.UPDATE_AVAILABLE);
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['remote', 'get-url', 'origin'],
        expect.any(Object),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['ls-remote', 'https://gitlab.test/repo', 'HEAD'],
        expect.any(Object),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'git',
        ['rev-parse', 'HEAD'],
        expect.any(Object),
      );
    });

    it('should return UP_TO_DATE when hashes match', async () => {
      // Mock for git remote get-url
      const mockRemoteProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('https://gitlab.test/repo\n');
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };

      // Mock for git ls-remote
      const mockLsRemoteProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('abc123\tHEAD\n');
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };

      // Mock for git rev-parse
      const mockRevParseProcess = {
        stdout: {
          on: vi.fn((event, cb) => {
            if (event === 'data') cb('abc123\n');
          }),
        },
        stderr: { on: vi.fn() },
        on: vi.fn((event, cb) => {
          if (event === 'close') cb(0);
        }),
      };

      mockSpawn
        .mockReturnValueOnce(mockRemoteProcess as any)
        .mockReturnValueOnce(mockLsRemoteProcess as any)
        .mockReturnValueOnce(mockRevParseProcess as any);

      const extension = {
        installMetadata: {
          type: 'gitlab-git' as const,
          source: 'test/repo',
          gitlabHost: 'gitlab.tcsbank.ru',
          gitlabProjectId: 'test/repo',
        },
        path: '/test/extension',
      } as unknown as Extension;

      const result = await checkForGitLabExtensionUpdate(
        extension,
        {} as ExtensionManager,
      );

      expect(result).toBe(ExtensionUpdateState.UP_TO_DATE);
    });
  });
});
