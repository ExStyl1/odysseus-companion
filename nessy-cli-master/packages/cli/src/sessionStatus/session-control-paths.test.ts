/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionControlDir } from './session-control-paths.js';

// POSIX permission bits — not applicable on Windows.
const skipIfWin32 = process.platform === 'win32';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'nessy-session-ctl-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(skipIfWin32)('createSessionControlDir', () => {
  it('creates the per-session directory and both files', async () => {
    const paths = await createSessionControlDir('sess-1', tmpDir);
    expect(paths.dir).toBe(path.join(tmpDir, 'ctl', 'sess-1'));
    expect(paths.eventsFile).toBe(
      path.join(tmpDir, 'ctl', 'sess-1', 'events.jsonl'),
    );
    expect(paths.inputFile).toBe(
      path.join(tmpDir, 'ctl', 'sess-1', 'input.jsonl'),
    );

    const dirMode = (await stat(paths.dir)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    for (const file of [paths.eventsFile, paths.inputFile]) {
      const info = await stat(file);
      expect(info.isFile()).toBe(true);
      expect(info.size).toBe(0);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it('sanitizes hostile session ids into a single path segment', async () => {
    const paths = await createSessionControlDir('../../evil\nid', tmpDir);
    // Slashes and newlines are replaced; the id collapses into one legal
    // directory name under ctl/ — no path traversal.
    expect(path.basename(paths.dir)).toBe('.._.._evil_id');
    expect(paths.dir).toBe(path.join(tmpDir, 'ctl', '.._.._evil_id'));
    await expect(stat(paths.eventsFile)).resolves.toBeTruthy();
    await expect(stat(paths.inputFile)).resolves.toBeTruthy();
  });

  it('reuses the directory, preserves content, re-applies file modes', async () => {
    const first = await createSessionControlDir('sess-2', tmpDir);
    // Simulate a previous run with looser permissions and pre-existing
    // content; recreation must preserve the content and tighten the modes.
    await writeFile(first.inputFile, '{"type":"submit","text":"hi"}\n');
    await chmod(first.inputFile, 0o644);

    const second = await createSessionControlDir('sess-2', tmpDir);
    expect(second.dir).toBe(first.dir);
    const info = await stat(second.inputFile);
    expect(info.mode & 0o777).toBe(0o600);
    await expect(readFile(second.inputFile, 'utf-8')).resolves.toBe(
      '{"type":"submit","text":"hi"}\n',
    );
  });

  it('tightens a pre-existing loose directory', async () => {
    const dir = path.join(tmpDir, 'ctl', 'sess-3');
    await mkdir(dir, { recursive: true, mode: 0o755 });
    await chmod(dir, 0o755);
    await createSessionControlDir('sess-3', tmpDir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
});
