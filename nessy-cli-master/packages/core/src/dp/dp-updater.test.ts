/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the forced `dp update` helper.
 */

// [nessy-fork] dp-binary-lifecycle

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execBehavior = vi.hoisted(() => ({
  ok: true,
  stdout: 'dp updated\n',
  calls: [] as Array<{ file: string; args: string[] }>,
  env: undefined as NodeJS.ProcessEnv | undefined,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
    callback: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    execBehavior.calls.push({ file, args });
    execBehavior.env = options?.env;
    if (!execBehavior.ok) {
      return callback(new Error('exit status 1'), '', 'update failed');
    }
    return callback(null, execBehavior.stdout, '');
  };
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    options: unknown,
  ) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        options as { env?: NodeJS.ProcessEnv },
        (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
    });

  return { ...actual, execFile };
});

describe('tryAsyncDpUpdate', () => {
  const originalNessyHome = process.env['NESSY_HOME'];
  let tmpHome: string;
  let dpPath: string;
  let tryAsyncDpUpdate: (typeof import('./dp-updater.js'))['tryAsyncDpUpdate'];

  beforeEach(async () => {
    tmpHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dp-upd-'));
    process.env['NESSY_HOME'] = tmpHome;

    execBehavior.ok = true;
    execBehavior.stdout = 'dp updated\n';
    execBehavior.calls = [];
    execBehavior.env = undefined;

    ({ tryAsyncDpUpdate } = await import('./dp-updater.js'));
    const { getDpFilePath } = await import('./dp-config.js');
    dpPath = getDpFilePath();
  });

  afterEach(async () => {
    if (originalNessyHome === undefined) {
      delete process.env['NESSY_HOME'];
    } else {
      process.env['NESSY_HOME'] = originalNessyHome;
    }
    await fsPromises.rm(tmpHome, { recursive: true, force: true });
  });

  const installBinary = () => {
    fs.mkdirSync(path.dirname(dpPath), { recursive: true });
    fs.writeFileSync(dpPath, 'binary', { mode: 0o700 });
  };

  it('runs dp update and reports success', async () => {
    installBinary();

    await expect(tryAsyncDpUpdate()).resolves.toBe(true);

    expect(execBehavior.calls).toEqual([{ file: dpPath, args: ['update'] }]);
  });

  it('passes DP_WORKDIR to the binary', async () => {
    installBinary();

    await tryAsyncDpUpdate();

    expect(execBehavior.env?.['DP_WORKDIR']).toBe(path.dirname(dpPath));
  });

  it('runs on every call', async () => {
    installBinary();

    await tryAsyncDpUpdate();
    await tryAsyncDpUpdate();

    expect(execBehavior.calls).toHaveLength(2);
  });

  it('reports failure instead of throwing', async () => {
    installBinary();
    execBehavior.ok = false;

    await expect(tryAsyncDpUpdate()).resolves.toBe(false);
  });

  it('skips when the binary is absent', async () => {
    await expect(tryAsyncDpUpdate()).resolves.toBe(false);

    expect(execBehavior.calls).toEqual([]);
  });

  it('shares a single inflight update between concurrent callers', async () => {
    installBinary();

    const results = await Promise.all([
      tryAsyncDpUpdate(),
      tryAsyncDpUpdate(),
      tryAsyncDpUpdate(),
    ]);

    expect(results).toEqual([true, true, true]);
    expect(execBehavior.calls).toHaveLength(1);
  });
});