import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  resolveBackendHostTooling,
  resolveBackendRuntimePaths,
} from '../runtime-resolver.ts';

const originalNessyCLICli = process.env.NESSY_CLI;
const originalNessyCLIPath = process.env.NESSY_CLI_PATH;
const originalNessyCLIRoot = process.env.NESSY_CLI_ROOT;

function makeExecutable(path: string): void {
  writeFileSync(path, '');
  chmodSync(path, 0o755);
}

function makeRuntimeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
  mkdirSync(join(root, 'packages', 'desktop'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), '');
  writeFileSync(join(root, 'scripts', 'dev.js'), '');
  writeFileSync(join(root, 'packages', 'cli', 'package.json'), '{}');
  writeFileSync(join(root, 'packages', 'desktop', 'package.json'), '{}');
  return root;
}

describe('resolveBackendRuntimePaths', () => {
  beforeEach(() => {
    delete process.env.NESSY_CLI;
    delete process.env.NESSY_CLI_PATH;
    delete process.env.NESSY_CLI_ROOT;
  });

  afterEach(() => {
    if (originalNessyCLICli === undefined) {
      delete process.env.NESSY_CLI;
    } else {
      process.env.NESSY_CLI = originalNessyCLICli;
    }
    if (originalNessyCLIPath === undefined) {
      delete process.env.NESSY_CLI_PATH;
    } else {
      process.env.NESSY_CLI_PATH = originalNessyCLIPath;
    }
    if (originalNessyCLIRoot === undefined) {
      delete process.env.NESSY_CLI_ROOT;
    } else {
      process.env.NESSY_CLI_ROOT = originalNessyCLIRoot;
    }
  });

  it('prefers the current checkout Nessy CLI source entry in dev mode', () => {
    const root = makeRuntimeFixture();
    const appRoot = join(
      root,
      'packages',
      'desktop',
      'apps',
      'electron',
      'dist',
    );
    mkdirSync(appRoot, { recursive: true });

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: appRoot,
        isPackaged: false,
      });

      expect(resolved.nessyCliPath).toBe(join(root, 'scripts', 'dev.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the current checkout Nessy CLI bundle when source dev entry is absent', () => {
    const root = makeRuntimeFixture();
    const appRoot = join(
      root,
      'packages',
      'desktop',
      'apps',
      'electron',
      'dist',
    );
    mkdirSync(appRoot, { recursive: true });
    rmSync(join(root, 'scripts', 'dev.js'));

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: appRoot,
        isPackaged: false,
      });

      expect(resolved.nessyCliPath).toBe(join(root, 'dist', 'cli.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not silently fall back to an unrelated Nessy CLI from a source checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
    const appRoot = join(
      root,
      'packages',
      'desktop',
      'apps',
      'electron',
      'dist',
    );
    const originalCwd = process.cwd();
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    mkdirSync(join(root, 'packages', 'desktop'), { recursive: true });
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(root, 'packages', 'cli', 'package.json'), '{}');
    writeFileSync(join(root, 'packages', 'desktop', 'package.json'), '{}');

    try {
      process.chdir(root);
      const resolved = resolveBackendRuntimePaths({
        appRootPath: appRoot,
        isPackaged: false,
      });

      expect(resolved.nessyCliPath).toBeUndefined();
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a vendored desktop CLI in standalone dev checkouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
    const originalCwd = process.cwd();
    const cliPath = join(
      root,
      'apps',
      'electron',
      'vendor',
      'nessy-cli',
      'dist',
      'cli.js',
    );
    mkdirSync(join(root, 'apps', 'electron', 'vendor', 'nessy-cli', 'dist'), {
      recursive: true,
    });
    writeFileSync(cliPath, '');

    try {
      process.chdir(root);
      const resolved = resolveBackendRuntimePaths({
        appRootPath: root,
        isPackaged: false,
      });

      expect(resolved.nessyCliPath).toBe(cliPath);
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses bundled Node instead of Bun as the Node runtime', () => {
    const root = makeRuntimeFixture();
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const bunPath = join(root, 'vendor', 'bun', bunName);
    const nodePath =
      process.platform === 'win32'
        ? join(root, 'vendor', 'node', nodeName)
        : join(root, 'vendor', 'node', 'bin', nodeName);

    mkdirSync(join(root, 'vendor', 'bun'), { recursive: true });
    mkdirSync(
      process.platform === 'win32'
        ? join(root, 'vendor', 'node')
        : join(root, 'vendor', 'node', 'bin'),
      { recursive: true },
    );
    makeExecutable(bunPath);
    makeExecutable(nodePath);

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: root,
        isPackaged: false,
      });

      expect(resolved.bundledRuntimePath).toBe(bunPath);
      expect(resolved.nodeRuntimePath).toBe(nodePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses an explicit Node runtime override before bundled Bun', () => {
    const root = makeRuntimeFixture();
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    const bunPath = join(root, 'vendor', 'bun', bunName);
    const binDir = join(root, 'bin');
    const nodePath = join(binDir, nodeName);

    mkdirSync(join(root, 'vendor', 'bun'), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    makeExecutable(bunPath);
    makeExecutable(nodePath);

    try {
      const resolved = resolveBackendRuntimePaths({
        appRootPath: root,
        isPackaged: false,
        nodeRuntimePath: nodePath,
      });

      expect(resolved.bundledRuntimePath).toBe(bunPath);
      expect(resolved.nodeRuntimePath).toBe(nodePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveBackendHostTooling', () => {
  it('prefers the bundled ripgrep in development', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
    const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const ripgrepPath = join(
      root,
      'apps',
      'electron',
      'vendor',
      'nessy-cli',
      'vendor',
      'ripgrep',
      `${process.arch}-${process.platform}`,
      binary,
    );
    mkdirSync(dirname(ripgrepPath), { recursive: true });
    makeExecutable(ripgrepPath);

    try {
      expect(
        resolveBackendHostTooling({
          appRootPath: root,
          isPackaged: false,
        }).ripgrepPath,
      ).toBe(ripgrepPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the bundled Windows ripgrep without a system install', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-runtime-'));
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    Object.defineProperty(process, 'arch', {
      value: 'x64',
      configurable: true,
    });
    const ripgrepPath = join(
      root,
      'vendor',
      'nessy-cli',
      'vendor',
      'ripgrep',
      'x64-win32',
      'rg.exe',
    );
    mkdirSync(dirname(ripgrepPath), { recursive: true });
    makeExecutable(ripgrepPath);

    try {
      expect(
        resolveBackendHostTooling({
          appRootPath: root,
          isPackaged: true,
        }).ripgrepPath,
      ).toBe(ripgrepPath);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
      if (originalArch) {
        Object.defineProperty(process, 'arch', originalArch);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
