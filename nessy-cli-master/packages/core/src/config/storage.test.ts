/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { Storage } from './storage.js';

const mockRealpathSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mocked = {
    ...actual,
    realpathSync: mockRealpathSync,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');

function createEnoent(pathToResolve: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, realpath '${pathToResolve}'`,
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function mockRealpath(
  resolutions: Map<string, string>,
  missingPaths = new Set<string>(),
): void {
  mockRealpathSync.mockImplementation((pathToResolve) => {
    const resolvedPath = pathToResolve.toString();
    if (missingPaths.has(resolvedPath)) {
      throw createEnoent(resolvedPath);
    }
    return resolutions.get(resolvedPath) ?? resolvedPath;
  });
}

describe('Storage – getGlobalSettingsPath', () => {
  it('returns path to ~/.nessy/settings.json', () => {
    const expected = path.join(os.homedir(), '.nessy', 'settings.json');
    expect(Storage.getGlobalSettingsPath()).toBe(expected);
  });
});

describe('Storage – additional helpers', () => {
  const projectRoot = '/tmp/project';
  const storage = new Storage(projectRoot);

  it('getWorkspaceSettingsPath returns project/.nessy/settings.json', () => {
    const expected = path.join(projectRoot, '.nessy', 'settings.json');
    expect(storage.getWorkspaceSettingsPath()).toBe(expected);
  });

  it('getUserCommandsDir returns ~/.nessy/commands', () => {
    const expected = path.join(os.homedir(), '.nessy', 'commands');
    expect(Storage.getUserCommandsDir()).toBe(expected);
  });

  it('getProjectCommandsDir returns project/.nessy/commands', () => {
    const expected = path.join(projectRoot, '.nessy', 'commands');
    expect(storage.getProjectCommandsDir()).toBe(expected);
  });

  it('getMcpOAuthTokensPath returns ~/.nessy/mcp-oauth-tokens.json', () => {
    const expected = path.join(os.homedir(), '.nessy', 'mcp-oauth-tokens.json');
    expect(Storage.getMcpOAuthTokensPath()).toBe(expected);
  });
});

describe('Storage – getRuntimeBaseDir / setRuntimeBaseDir', () => {
  const originalEnv = process.env['NESSY_RUNTIME_DIR'];

  beforeEach(() => {
    // Reset state before each test
    Storage.setRuntimeBaseDir(null);
    delete process.env['NESSY_RUNTIME_DIR'];
  });

  afterEach(() => {
    // Restore original env
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['NESSY_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['NESSY_RUNTIME_DIR'];
    }
  });

  it('defaults to getGlobalNessyDir() when nothing is configured', () => {
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalNessyDir());
  });

  it('uses setRuntimeBaseDir value when set with absolute path', () => {
    const runtimeDir = path.resolve('custom', 'runtime');
    Storage.setRuntimeBaseDir(runtimeDir);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('env var NESSY_RUNTIME_DIR takes priority over setRuntimeBaseDir', () => {
    const settingsDir = path.resolve('from-settings');
    const envDir = path.resolve('from-env');
    Storage.setRuntimeBaseDir(settingsDir);
    process.env['NESSY_RUNTIME_DIR'] = envDir;
    expect(Storage.getRuntimeBaseDir()).toBe(envDir);
  });

  it('expands tilde (~) in setRuntimeBaseDir', () => {
    Storage.setRuntimeBaseDir('~/custom-runtime');
    const expected = path.join(os.homedir(), 'custom-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('expands Windows-style tilde paths in setRuntimeBaseDir', () => {
    Storage.setRuntimeBaseDir('~\\custom-runtime');
    const expected = path.join(os.homedir(), 'custom-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('expands tilde (~) in NESSY_RUNTIME_DIR env var', () => {
    process.env['NESSY_RUNTIME_DIR'] = '~/env-runtime';
    const expected = path.join(os.homedir(), 'env-runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resolves relative paths in setRuntimeBaseDir using process.cwd by default', () => {
    Storage.setRuntimeBaseDir('relative/path');
    const expected = path.resolve('relative/path');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resolves relative paths in setRuntimeBaseDir using explicit cwd', () => {
    const cwd = path.resolve('workspace', 'projectA');
    Storage.setRuntimeBaseDir('.nessy', cwd);
    expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.nessy'));
  });

  it('ignores cwd when path is absolute', () => {
    const absolutePath = path.resolve('absolute', 'path');
    const cwd = path.resolve('workspace', 'projectA');
    Storage.setRuntimeBaseDir(absolutePath, cwd);
    expect(Storage.getRuntimeBaseDir()).toBe(absolutePath);
  });

  it('ignores cwd when path starts with tilde', () => {
    Storage.setRuntimeBaseDir(
      '~/runtime',
      path.resolve('workspace', 'projectA'),
    );
    const expected = path.join(os.homedir(), 'runtime');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resolves relative paths in NESSY_RUNTIME_DIR env var', () => {
    process.env['NESSY_RUNTIME_DIR'] = 'relative/env-path';
    const expected = path.resolve('relative/env-path');
    expect(Storage.getRuntimeBaseDir()).toBe(expected);
  });

  it('resets to default when setRuntimeBaseDir is called with null', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getRuntimeBaseDir()).toBe(customDir);

    Storage.setRuntimeBaseDir(null);
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalNessyDir());
  });

  it('resets to default when setRuntimeBaseDir is called with undefined', () => {
    Storage.setRuntimeBaseDir(path.resolve('custom'));
    Storage.setRuntimeBaseDir(undefined);
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalNessyDir());
  });

  it('resets to default when setRuntimeBaseDir is called with empty string', () => {
    Storage.setRuntimeBaseDir(path.resolve('custom'));
    Storage.setRuntimeBaseDir('');
    expect(Storage.getRuntimeBaseDir()).toBe(Storage.getGlobalNessyDir());
  });

  it('handles bare tilde (~) as home directory', () => {
    Storage.setRuntimeBaseDir('~');
    expect(Storage.getRuntimeBaseDir()).toBe(os.homedir());
  });
});

describe('Storage – getPlansDir', () => {
  const projectRoot = path.resolve('workspace', 'project');

  beforeEach(() => {
    mockRealpathSync.mockImplementation((pathToResolve) =>
      actualFs.realpathSync(pathToResolve),
    );
  });

  afterEach(() => {
    mockRealpathSync.mockReset();
  });

  it('defaults to ~/.nessy/plans when plansDirectory is not configured', () => {
    expect(Storage.getPlansDir(projectRoot)).toBe(
      path.join(Storage.getGlobalNessyDir(), 'plans'),
    );
  });

  it('resolves relative plansDirectory values against the project root', () => {
    expect(Storage.getPlansDir(projectRoot, './project-plans')).toBe(
      path.join(projectRoot, 'project-plans'),
    );
  });

  it('allows project subdirectories whose names start with two dots', () => {
    expect(Storage.getPlansDir(projectRoot, './..plans')).toBe(
      path.join(projectRoot, '..plans'),
    );
  });

  it('expands tilde in configured plansDirectory values', () => {
    const projectInHome = path.join(os.homedir(), 'workspace', 'project');
    expect(
      Storage.getPlansDir(projectInHome, '~/workspace/project/plans'),
    ).toBe(path.join(projectInHome, 'plans'));
  });

  it('allows absolute plansDirectory values inside the project root', () => {
    const plansDir = path.join(projectRoot, 'nested', 'plans');
    expect(Storage.getPlansDir(projectRoot, plansDir)).toBe(plansDir);
  });

  it('rejects relative plansDirectory values that escape the project root', () => {
    expect(() => Storage.getPlansDir(projectRoot, '../plans')).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('rejects absolute plansDirectory values outside the project root', () => {
    const outsideProject = path.join(path.dirname(projectRoot), 'plans');
    expect(() => Storage.getPlansDir(projectRoot, outsideProject)).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('requires projectRoot when plansDirectory is configured', () => {
    expect(() => Storage.getPlansDir(undefined, './plans')).toThrow(
      'projectRoot is required when plansDirectory is configured',
    );
    expect(() => Storage.getPlansDir(null, './plans')).toThrow(
      'projectRoot is required when plansDirectory is configured',
    );
  });

  it('rejects Windows-style absolute path outside the project root', () => {
    // Simulate project root on C: drive and plansDirectory on D: drive
    const projectOnC = path.resolve('C:', 'work', 'project');
    const plansOnD = path.resolve('D:', 'plans');
    expect(() => Storage.getPlansDir(projectOnC, plansOnD)).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('rejects path with mixed separators that escapes project root', () => {
    // On Windows, path.resolve normalizes backslashes as path separators.
    // On POSIX, backslashes are literal characters, so this traversal
    // is inherently Windows-specific and should be guarded.
    if (process.platform !== 'win32') {
      return;
    }
    const tricky = '..\\..\\plans'; // backslashes with traversal
    expect(() => Storage.getPlansDir(projectRoot, tricky)).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('rejects symlink pointing outside the project root', () => {
    const project = path.resolve('tmp', 'project');
    const outside = path.resolve('tmp', 'outside');
    const symlink = path.join(project, 'escape-link');
    mockRealpath(
      new Map([
        [project, project],
        [symlink, outside],
      ]),
    );

    expect(() => Storage.getPlansDir(project, './escape-link')).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('allows legitimate symlink that stays within project root', () => {
    const project = path.resolve('tmp', 'project');
    const target = path.join(project, 'plans-target');
    const symlink = path.join(project, 'plans-link');
    mockRealpath(
      new Map([
        [project, project],
        [symlink, target],
      ]),
    );

    const result = Storage.getPlansDir(project, './plans-link');
    // The configured symlink path is accepted as long as it stays inside
    // the project root.
    expect(result).toBe(symlink);
  });

  it('rejects missing nested path under symlink that escapes project root', () => {
    const project = path.resolve('tmp', 'project');
    const outside = path.resolve('tmp', 'outside');
    const dataSymlink = path.join(project, 'data');
    const missingSubdir = path.join(dataSymlink, 'subdir');
    const missingPlans = path.join(missingSubdir, 'plans');
    mockRealpath(
      new Map([
        [project, project],
        [dataSymlink, outside],
      ]),
      new Set([missingPlans, missingSubdir]),
    );

    expect(() => Storage.getPlansDir(project, './data/subdir/plans')).toThrow(
      'plansDirectory must resolve within the project root',
    );
  });

  it('uses configured plansDirectory when building plan file paths', () => {
    expect(Storage.getPlanFilePath('session-123', projectRoot, './plans')).toBe(
      path.join(projectRoot, 'plans', 'session-123.md'),
    );
  });

  it('sanitizes session IDs when building plan file paths', () => {
    expect(
      Storage.getPlanFilePath('../../../escape', projectRoot, './plans'),
    ).toBe(path.join(projectRoot, 'plans', 'escape.md'));
  });
});

describe('Storage – runtime path methods use getRuntimeBaseDir', () => {
  const originalEnv = process.env['NESSY_RUNTIME_DIR'];

  beforeEach(() => {
    Storage.setRuntimeBaseDir(null);
    delete process.env['NESSY_RUNTIME_DIR'];
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['NESSY_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['NESSY_RUNTIME_DIR'];
    }
  });

  it('getGlobalTempDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getGlobalTempDir()).toBe(path.join(customDir, 'tmp'));
  });

  it('getGlobalDebugDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getGlobalDebugDir()).toBe(path.join(customDir, 'debug'));
  });

  it('getDebugLogPath uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    expect(Storage.getDebugLogPath('session-123')).toBe(
      path.join(customDir, 'debug', 'session-123.txt'),
    );
  });

  it('getGlobalIdeDir is anchored to the global Nessy dir, not runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    // IDE lock files are discovery anchors shared with the VS Code companion,
    // which can only see env vars (not settings-based runtimeOutputDir), so
    // getGlobalIdeDir must follow getGlobalNessyDir to keep both sides aligned.
    expect(Storage.getGlobalIdeDir()).toBe(
      path.join(Storage.getGlobalNessyDir(), 'ide'),
    );
  });

  it('getProjectDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectDir()).toContain(path.join(customDir, 'projects'));
  });

  it('getProjectTempDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectTempDir()).toContain(path.join(customDir, 'tmp'));
  });

  it('getProjectTempCheckpointsDir uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getProjectTempCheckpointsDir()).toContain(
      path.join(customDir, 'tmp'),
    );
    expect(storage.getProjectTempCheckpointsDir()).toMatch(/checkpoints$/);
  });

  it('getHistoryFilePath uses custom runtime base dir', () => {
    const customDir = path.resolve('custom');
    Storage.setRuntimeBaseDir(customDir);
    const storage = new Storage('/tmp/project');
    expect(storage.getHistoryFilePath()).toContain(path.join(customDir, 'tmp'));
    expect(storage.getHistoryFilePath()).toMatch(/shell_history$/);
  });
});

describe('Storage – config paths remain at ~/.nessy regardless of runtime dir', () => {
  const originalEnv = process.env['NESSY_RUNTIME_DIR'];
  const globalNessyDir = Storage.getGlobalNessyDir();

  beforeEach(() => {
    Storage.setRuntimeBaseDir(path.resolve('custom-runtime'));
    process.env['NESSY_RUNTIME_DIR'] = path.resolve('env-runtime');
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['NESSY_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['NESSY_RUNTIME_DIR'];
    }
  });

  it('getGlobalSettingsPath still uses ~/.nessy', () => {
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(globalNessyDir, 'settings.json'),
    );
  });

  it('getInstallationIdPath still uses ~/.nessy', () => {
    expect(Storage.getInstallationIdPath()).toBe(
      path.join(globalNessyDir, 'installation_id'),
    );
  });

  it('getGoogleAccountsPath still uses ~/.nessy', () => {
    expect(Storage.getGoogleAccountsPath()).toBe(
      path.join(globalNessyDir, 'google_accounts.json'),
    );
  });

  it('getMcpOAuthTokensPath still uses ~/.nessy', () => {
    expect(Storage.getMcpOAuthTokensPath()).toBe(
      path.join(globalNessyDir, 'mcp-oauth-tokens.json'),
    );
  });

  it('getOAuthCredsPath still uses ~/.nessy', () => {
    expect(Storage.getOAuthCredsPath()).toBe(
      path.join(globalNessyDir, 'oauth_creds.json'),
    );
  });

  it('getUserCommandsDir still uses ~/.nessy', () => {
    expect(Storage.getUserCommandsDir()).toBe(
      path.join(globalNessyDir, 'commands'),
    );
  });

  it('getGlobalMemoryFilePath still uses ~/.nessy', () => {
    expect(Storage.getGlobalMemoryFilePath()).toBe(
      path.join(globalNessyDir, 'memory.md'),
    );
  });

  it('getGlobalBinDir still uses ~/.nessy', () => {
    expect(Storage.getGlobalBinDir()).toBe(path.join(globalNessyDir, 'bin'));
  });

  it('getUserSkillsDirs still includes ~/.nessy/skills', () => {
    const storage = new Storage('/tmp/project');
    const skillsDirs = storage.getUserSkillsDirs();
    expect(
      skillsDirs.some((dir) => dir === path.join(globalNessyDir, 'skills')),
    ).toBe(true);
  });
});

describe('Storage – NESSY_HOME env var', () => {
  const originalEnv = process.env['NESSY_HOME'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['NESSY_HOME'] = originalEnv;
    } else {
      delete process.env['NESSY_HOME'];
    }
  });

  it('defaults to ~/.nessy when NESSY_HOME is not set', () => {
    delete process.env['NESSY_HOME'];
    const expected = path.join(os.homedir(), '.nessy');
    expect(Storage.getGlobalNessyDir()).toBe(expected);
  });

  it('uses NESSY_HOME when set to absolute path', () => {
    const configDir = path.resolve('/tmp/custom-nessy');
    process.env['NESSY_HOME'] = configDir;
    expect(Storage.getGlobalNessyDir()).toBe(configDir);
  });

  it('resolves relative NESSY_HOME to absolute path', () => {
    process.env['NESSY_HOME'] = 'relative/config';
    const expected = path.resolve('relative/config');
    expect(Storage.getGlobalNessyDir()).toBe(expected);
  });

  it('config paths follow NESSY_HOME', () => {
    const configDir = path.resolve('/tmp/custom-nessy');
    process.env['NESSY_HOME'] = configDir;
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(configDir, 'settings.json'),
    );
    expect(Storage.getInstallationIdPath()).toBe(
      path.join(configDir, 'installation_id'),
    );
    expect(Storage.getUserCommandsDir()).toBe(path.join(configDir, 'commands'));
    expect(Storage.getMcpOAuthTokensPath()).toBe(
      path.join(configDir, 'mcp-oauth-tokens.json'),
    );
    expect(Storage.getOAuthCredsPath()).toBe(
      path.join(configDir, 'oauth_creds.json'),
    );
    expect(Storage.getGlobalBinDir()).toBe(path.join(configDir, 'bin'));
    expect(Storage.getGlobalMemoryFilePath()).toBe(
      path.join(configDir, 'memory.md'),
    );
  });

  it('project-level paths are NOT affected by NESSY_HOME', () => {
    const configDir = path.resolve('/tmp/custom-nessy');
    const projectDir = path.resolve('/tmp/project');
    process.env['NESSY_HOME'] = configDir;
    const storage = new Storage(projectDir);
    expect(storage.getWorkspaceSettingsPath()).toBe(
      path.join(projectDir, '.nessy', 'settings.json'),
    );
    expect(storage.getProjectCommandsDir()).toBe(
      path.join(projectDir, '.nessy', 'commands'),
    );
  });

  it('expands tilde (~) in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~/custom-nessy';
    const expected = path.join(os.homedir(), 'custom-nessy');
    expect(Storage.getGlobalNessyDir()).toBe(expected);
  });

  it('expands Windows-style tilde in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~\\custom-nessy';
    const expected = path.join(os.homedir(), 'custom-nessy');
    expect(Storage.getGlobalNessyDir()).toBe(expected);
  });

  it('handles bare tilde (~) as home directory in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~';
    expect(Storage.getGlobalNessyDir()).toBe(os.homedir());
  });

  it('NESSY_HOME and NESSY_RUNTIME_DIR are independent', () => {
    const configDir = path.resolve('/tmp/config');
    const runtimeDir = path.resolve('/tmp/runtime');
    process.env['NESSY_HOME'] = configDir;
    process.env['NESSY_RUNTIME_DIR'] = runtimeDir;
    expect(Storage.getGlobalNessyDir()).toBe(configDir);
    expect(Storage.getRuntimeBaseDir()).toBe(runtimeDir);
    expect(Storage.getGlobalSettingsPath()).toBe(
      path.join(configDir, 'settings.json'),
    );
    expect(Storage.getGlobalTempDir()).toBe(path.join(runtimeDir, 'tmp'));
    expect(Storage.getGlobalDebugDir()).toBe(path.join(runtimeDir, 'debug'));
    delete process.env['NESSY_RUNTIME_DIR'];
  });
});

describe('Storage – runtime base dir async context isolation', () => {
  const originalEnv = process.env['NESSY_RUNTIME_DIR'];

  beforeEach(() => {
    Storage.setRuntimeBaseDir(null);
    delete process.env['NESSY_RUNTIME_DIR'];
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    if (originalEnv !== undefined) {
      process.env['NESSY_RUNTIME_DIR'] = originalEnv;
    } else {
      delete process.env['NESSY_RUNTIME_DIR'];
    }
  });

  it('uses contextual runtime dir inside runWithRuntimeBaseDir', async () => {
    Storage.setRuntimeBaseDir(path.resolve('global-runtime'));
    const cwd = path.resolve('workspace', 'project-a');

    await Storage.runWithRuntimeBaseDir('.nessy', cwd, async () => {
      expect(Storage.getRuntimeBaseDir()).toBe(path.join(cwd, '.nessy'));
    });
  });

  it('keeps concurrent contexts isolated', async () => {
    const cwdA = path.resolve('workspace', 'a');
    const cwdB = path.resolve('workspace', 'b');

    const runA = Storage.runWithRuntimeBaseDir('.nessy-a', cwdA, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Storage.getRuntimeBaseDir();
    });

    const runB = Storage.runWithRuntimeBaseDir('.nessy-b', cwdB, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return Storage.getRuntimeBaseDir();
    });

    const [a, b] = await Promise.all([runA, runB]);
    expect(a).toBe(path.join(cwdA, '.nessy-a'));
    expect(b).toBe(path.join(cwdB, '.nessy-b'));
  });
});
