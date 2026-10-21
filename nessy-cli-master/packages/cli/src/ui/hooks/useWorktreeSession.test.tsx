/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import fsSync, { type FSWatcher } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeWorktreeSession,
  clearWorktreeSession,
  type Config,
  type WorktreeSession,
} from '@nestor/nessy-cli-core';
import { useWorktreeSession } from './useWorktreeSession.js';

const SESSION_ID = 'test-session-id';

function makeMockConfig(sidecarPath: string): Config {
  return {
    getSessionId: () => SESSION_ID,
    getSessionService: () => ({
      getWorktreeSessionPath: (_id: string) => sidecarPath,
    }),
  } as unknown as Config;
}

const sample: WorktreeSession = {
  slug: 'my-feature',
  worktreePath: '/repo/.nessy/worktrees/my-feature',
  worktreeBranch: 'worktree-my-feature',
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHeadCommit: 'a'.repeat(40),
};

describe('useWorktreeSession', () => {
  let tmpDir: string;
  let sidecarPath: string;
  let watcherCallback:
    | ((eventType: string, filename: string | Buffer | null) => void)
    | undefined;

  beforeEach(async () => {
    watcherCallback = undefined;
    vi.spyOn(fsSync, 'watch').mockImplementation((_path, listener) => {
      watcherCallback = listener as typeof watcherCallback;
      return { close: vi.fn() } as unknown as FSWatcher;
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'use-wt-session-'));
    sidecarPath = path.join(tmpDir, 'session.worktree.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no sidecar exists', async () => {
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    // No sidecar yet → load() resolves to null on mount.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toBeNull();
  });

  it('returns the parsed sidecar when one exists at mount time', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    // Wait for the initial async load to complete + flush React state.
    await vi.waitFor(
      () => {
        expect(result.current).not.toBeNull();
      },
      { timeout: 1000 },
    );
    expect(result.current?.slug).toBe(sample.slug);
    expect(result.current?.worktreePath).toBe(sample.worktreePath);
  });

  it('reacts to sidecar deletion (clear)', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    await vi.waitFor(
      () => {
        expect(result.current?.slug).toBe(sample.slug);
        expect(watcherCallback).toBeDefined();
      },
      { timeout: 1000 },
    );
    // Simulate exit_worktree clearing the sidecar.
    await clearWorktreeSession(sidecarPath);
    watcherCallback?.('rename', path.basename(sidecarPath));
    await vi.waitFor(
      () => {
        expect(result.current).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('reacts to sidecar creation (enter_worktree after mount)', async () => {
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    // Starts null because no sidecar at mount.
    await vi.waitFor(() => {
      expect(result.current).toBeNull();
      expect(watcherCallback).toBeDefined();
    });

    // Simulate enter_worktree writing the sidecar after the hook mounted.
    await writeWorktreeSession(sidecarPath, sample);
    watcherCallback?.('rename', path.basename(sidecarPath));

    await vi.waitFor(
      () => {
        expect(result.current?.slug).toBe(sample.slug);
      },
      { timeout: 2000 },
    );
  });
});
