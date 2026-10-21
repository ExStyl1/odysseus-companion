/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
  getGlobalNessyDir,
  getRuntimeBaseDir,
  resetEnvBootstrapForTesting,
} from './paths.js';

/**
 * Each test gets a clean temp homedir (no `.env` files), so the lazy
 * `bootstrapHomeEnvOverrides()` becomes a no-op unless the test explicitly
 * writes `.env` content into the mocked home. ESM bans spying on `os.homedir`,
 * so we redirect via the underlying `HOME` / `USERPROFILE` env vars.
 */
function withCleanHome() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nessy-paths-test-'));
  const realHome = fs.realpathSync(tempHome);
  const originalHomeEnv = process.env['HOME'];
  const originalUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = realHome;
  process.env['USERPROFILE'] = realHome;
  return {
    tempHome: realHome,
    cleanup: () => {
      if (originalHomeEnv !== undefined) {
        process.env['HOME'] = originalHomeEnv;
      } else {
        delete process.env['HOME'];
      }
      if (originalUserProfile !== undefined) {
        process.env['USERPROFILE'] = originalUserProfile;
      } else {
        delete process.env['USERPROFILE'];
      }
      fs.rmSync(realHome, { recursive: true, force: true });
    },
  };
}

describe('vscode-ide-companion paths – getGlobalNessyDir', () => {
  const originalEnv = process.env['NESSY_HOME'];
  let home: ReturnType<typeof withCleanHome>;

  beforeEach(() => {
    resetEnvBootstrapForTesting();
    home = withCleanHome();
  });

  afterEach(() => {
    home.cleanup();
    if (originalEnv !== undefined) {
      process.env['NESSY_HOME'] = originalEnv;
    } else {
      delete process.env['NESSY_HOME'];
    }
  });

  it('defaults to ~/.nessy when NESSY_HOME is not set', () => {
    delete process.env['NESSY_HOME'];
    expect(getGlobalNessyDir()).toBe(path.join(home.tempHome, '.nessy'));
  });

  it('uses NESSY_HOME when set to absolute path', () => {
    const configDir = path.resolve('/tmp/custom-nessy');
    process.env['NESSY_HOME'] = configDir;
    expect(getGlobalNessyDir()).toBe(configDir);
  });

  it('resolves relative NESSY_HOME against process.cwd', () => {
    process.env['NESSY_HOME'] = 'relative/config';
    expect(getGlobalNessyDir()).toBe(path.resolve('relative/config'));
  });

  it('expands tilde (~/x) in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~/custom-nessy';
    expect(getGlobalNessyDir()).toBe(path.join(home.tempHome, 'custom-nessy'));
  });

  it('expands Windows-style tilde (~\\x) in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~\\custom-nessy';
    expect(getGlobalNessyDir()).toBe(path.join(home.tempHome, 'custom-nessy'));
  });

  it('treats bare tilde (~) as home directory', () => {
    process.env['NESSY_HOME'] = '~';
    expect(getGlobalNessyDir()).toBe(home.tempHome);
  });
});

describe('vscode-ide-companion paths – getRuntimeBaseDir', () => {
  const originalHome = process.env['NESSY_HOME'];
  const originalRuntime = process.env['NESSY_RUNTIME_DIR'];
  let home: ReturnType<typeof withCleanHome>;

  beforeEach(() => {
    resetEnvBootstrapForTesting();
    home = withCleanHome();
  });

  afterEach(() => {
    home.cleanup();
    if (originalHome !== undefined) {
      process.env['NESSY_HOME'] = originalHome;
    } else {
      delete process.env['NESSY_HOME'];
    }
    if (originalRuntime !== undefined) {
      process.env['NESSY_RUNTIME_DIR'] = originalRuntime;
    } else {
      delete process.env['NESSY_RUNTIME_DIR'];
    }
  });

  it('falls back to getGlobalNessyDir() when neither env var is set', () => {
    delete process.env['NESSY_HOME'];
    delete process.env['NESSY_RUNTIME_DIR'];
    expect(getRuntimeBaseDir()).toBe(getGlobalNessyDir());
  });

  it('uses NESSY_RUNTIME_DIR when set to absolute path', () => {
    delete process.env['NESSY_HOME'];
    const runtimeDir = path.resolve('/tmp/custom-runtime');
    process.env['NESSY_RUNTIME_DIR'] = runtimeDir;
    expect(getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('resolves relative NESSY_RUNTIME_DIR against process.cwd', () => {
    delete process.env['NESSY_HOME'];
    process.env['NESSY_RUNTIME_DIR'] = 'relative/runtime';
    expect(getRuntimeBaseDir()).toBe(path.resolve('relative/runtime'));
  });

  it('expands tilde (~/x) in NESSY_RUNTIME_DIR', () => {
    delete process.env['NESSY_HOME'];
    process.env['NESSY_RUNTIME_DIR'] = '~/custom-runtime';
    expect(getRuntimeBaseDir()).toBe(
      path.join(home.tempHome, 'custom-runtime'),
    );
  });

  it('falls back to NESSY_HOME when NESSY_RUNTIME_DIR is unset', () => {
    delete process.env['NESSY_RUNTIME_DIR'];
    const configDir = path.resolve('/tmp/custom-nessy');
    process.env['NESSY_HOME'] = configDir;
    expect(getRuntimeBaseDir()).toBe(configDir);
  });

  it('NESSY_RUNTIME_DIR takes priority over NESSY_HOME', () => {
    const configDir = path.resolve('/tmp/custom-nessy');
    const runtimeDir = path.resolve('/tmp/custom-runtime');
    process.env['NESSY_HOME'] = configDir;
    process.env['NESSY_RUNTIME_DIR'] = runtimeDir;
    expect(getRuntimeBaseDir()).toBe(runtimeDir);
  });
});

describe('vscode-ide-companion paths – .env bootstrap', () => {
  const originalHome = process.env['NESSY_HOME'];
  const originalRuntime = process.env['NESSY_RUNTIME_DIR'];
  let home: ReturnType<typeof withCleanHome>;

  beforeEach(() => {
    resetEnvBootstrapForTesting();
    home = withCleanHome();
    delete process.env['NESSY_HOME'];
    delete process.env['NESSY_RUNTIME_DIR'];
  });

  afterEach(() => {
    home.cleanup();
    if (originalHome !== undefined) {
      process.env['NESSY_HOME'] = originalHome;
    } else {
      delete process.env['NESSY_HOME'];
    }
    if (originalRuntime !== undefined) {
      process.env['NESSY_RUNTIME_DIR'] = originalRuntime;
    } else {
      delete process.env['NESSY_RUNTIME_DIR'];
    }
  });

  it('reads NESSY_HOME from <homedir>/.nessy/.env', () => {
    const configDir = path.resolve('/tmp/from-nessy-dotenv');
    fs.mkdirSync(path.join(home.tempHome, '.nessy'), { recursive: true });
    fs.writeFileSync(
      path.join(home.tempHome, '.nessy', '.env'),
      `NESSY_HOME=${configDir}\n`,
    );
    expect(getGlobalNessyDir()).toBe(configDir);
    expect(process.env['NESSY_HOME']).toBe(configDir);
  });

  it('reads NESSY_HOME from <homedir>/.env when ~/.nessy/.env is absent', () => {
    const configDir = path.resolve('/tmp/from-home-dotenv');
    fs.writeFileSync(
      path.join(home.tempHome, '.env'),
      `NESSY_HOME=${configDir}\n`,
    );
    expect(getGlobalNessyDir()).toBe(configDir);
    expect(process.env['NESSY_HOME']).toBe(configDir);
  });

  it('process env wins over .env file', () => {
    const envDir = path.resolve('/tmp/from-process-env');
    const dotenvDir = path.resolve('/tmp/from-dotenv');
    process.env['NESSY_HOME'] = envDir;
    fs.mkdirSync(path.join(home.tempHome, '.nessy'), { recursive: true });
    fs.writeFileSync(
      path.join(home.tempHome, '.nessy', '.env'),
      `NESSY_HOME=${dotenvDir}\n`,
    );
    expect(getGlobalNessyDir()).toBe(envDir);
  });

  it('reads NESSY_RUNTIME_DIR from <NESSY_HOME>/.env when NESSY_HOME is preset', () => {
    const configDir = path.join(home.tempHome, 'custom-nessy');
    const runtimeDir = path.resolve('/tmp/from-runtime-dotenv');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, '.env'),
      `NESSY_RUNTIME_DIR=${runtimeDir}\n`,
    );
    process.env['NESSY_HOME'] = configDir;
    expect(getRuntimeBaseDir()).toBe(runtimeDir);
  });

  it('does not read <homedir>/.env when NESSY_HOME is preset', () => {
    const configDir = path.resolve('/tmp/preset-nessy-home');
    process.env['NESSY_HOME'] = configDir;
    fs.writeFileSync(
      path.join(home.tempHome, '.env'),
      `NESSY_RUNTIME_DIR=/tmp/should-be-ignored\n`,
    );
    expect(getRuntimeBaseDir()).toBe(configDir);
    expect(process.env['NESSY_RUNTIME_DIR']).toBeUndefined();
  });

  it('reads NESSY_RUNTIME_DIR from <new NESSY_HOME>/.env after discovery via ~/.nessy/.env', () => {
    const configDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nessy-bootstrap-cfg-')),
    );
    const runtimeDir = path.resolve('/tmp/from-discovered-runtime');
    fs.mkdirSync(path.join(home.tempHome, '.nessy'), { recursive: true });
    fs.writeFileSync(
      path.join(home.tempHome, '.nessy', '.env'),
      `NESSY_HOME=${configDir}\n`,
    );
    fs.writeFileSync(
      path.join(configDir, '.env'),
      `NESSY_RUNTIME_DIR=${runtimeDir}\n`,
    );
    try {
      expect(getRuntimeBaseDir()).toBe(runtimeDir);
      expect(process.env['NESSY_HOME']).toBe(configDir);
      expect(process.env['NESSY_RUNTIME_DIR']).toBe(runtimeDir);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
