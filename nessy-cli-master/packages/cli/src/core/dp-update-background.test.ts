/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

// [nessy-fork] dp-binary-lifecycle

import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  checkForDpUpdateAvailable: vi.fn(),
  tryAsyncDpUpdate: vi.fn(),
  installDpVersion: vi.fn(),
  createDebugLogger: vi.fn(() => ({
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  })),
}));

const emitter = vi.hoisted(() => {
  const listeners = new Map<string, Array<(data: { message: string }) => void>>();
  return {
    on(event: string, fn: (data: { message: string }) => void) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    off(event: string, fn: (data: { message: string }) => void) {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((existing) => existing !== fn),
      );
    },
    emit(event: string, data: { message: string }) {
      for (const fn of listeners.get(event) ?? []) {
        fn(data);
      }
    },
  };
});

vi.mock('@nestor/nessy-cli-core', () => core);
vi.mock('../utils/updateEventEmitter.js', () => ({
  updateEventEmitter: emitter,
}));
vi.mock('../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) =>
    params ? `${key} :: ${JSON.stringify(params)}` : key,
}));

import { startBackgroundDpUpdate } from './dp-update-background.js';

const flush = () =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('startBackgroundDpUpdate', () => {
  const VERSION_INFO = { current: '13.65.1', latest: '13.66.0' };

  beforeEach(() => {
    vi.clearAllMocks();
    core.checkForDpUpdateAvailable.mockResolvedValue(null);
    core.tryAsyncDpUpdate.mockResolvedValue(true);
    core.installDpVersion.mockResolvedValue(false);
  });

  it('does nothing when no update is available', async () => {
    core.checkForDpUpdateAvailable.mockResolvedValue(null);

    startBackgroundDpUpdate();
    await flush();

    expect(core.checkForDpUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(core.tryAsyncDpUpdate).not.toHaveBeenCalled();
  });

  it('emits update-info then update-success when an update applies', async () => {
    core.checkForDpUpdateAvailable.mockResolvedValue(VERSION_INFO);
    core.tryAsyncDpUpdate.mockResolvedValue(true);
    const received: string[] = [];
    const success: string[] = [];
    const onReceived = (data: { message: string }) => received.push(data.message);
    const onSuccess = (data: { message: string }) => success.push(data.message);
    emitter.on('update-info', onReceived);
    emitter.on('update-success', onSuccess);

    try {
      startBackgroundDpUpdate();
      await flush();

      expect(core.tryAsyncDpUpdate).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain('A new version of the dp CLI');
      expect(received[0]).toContain('13.65.1');
      expect(received[0]).toContain('13.66.0');
      expect(success).toHaveLength(1);
      expect(success[0]).toContain('dp CLI updated');
      expect(success[0]).toContain('13.65.1');
      expect(success[0]).toContain('13.66.0');
    } finally {
      emitter.off('update-info', onReceived);
      emitter.off('update-success', onSuccess);
    }
  });

  it('emits update-failed when the update and the fallback both fail', async () => {
    core.checkForDpUpdateAvailable.mockResolvedValue(VERSION_INFO);
    core.tryAsyncDpUpdate.mockResolvedValue(false);
    core.installDpVersion.mockResolvedValue(false);
    const failed: string[] = [];
    const onFailed = (data: { message: string }) => failed.push(data.message);
    emitter.on('update-failed', onFailed);

    try {
      startBackgroundDpUpdate();
      await flush();

      expect(core.installDpVersion).toHaveBeenCalledWith(VERSION_INFO.latest);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toContain('dp');
    } finally {
      emitter.off('update-failed', onFailed);
    }
  });

  it('falls back to a direct download when dp update fails', async () => {
    core.checkForDpUpdateAvailable.mockResolvedValue(VERSION_INFO);
    core.tryAsyncDpUpdate.mockResolvedValue(false);
    core.installDpVersion.mockResolvedValue(true);
    const success: string[] = [];
    const onSuccess = (data: { message: string }) => success.push(data.message);
    emitter.on('update-success', onSuccess);

    try {
      startBackgroundDpUpdate();
      await flush();

      expect(core.installDpVersion).toHaveBeenCalledWith(VERSION_INFO.latest);
      expect(success).toHaveLength(1);
      expect(success[0]).toContain('dp CLI updated');
      expect(success[0]).toContain('13.65.1');
      expect(success[0]).toContain('13.66.0');
    } finally {
      emitter.off('update-success', onSuccess);
    }
  });

  it('shares a single inflight check between concurrent callers', async () => {
    core.checkForDpUpdateAvailable.mockResolvedValue(null);

    startBackgroundDpUpdate();
    startBackgroundDpUpdate();
    startBackgroundDpUpdate();
    await flush();

    expect(core.checkForDpUpdateAvailable).toHaveBeenCalledTimes(1);
  });

  it('tolerates a failing availability check', async () => {
    core.checkForDpUpdateAvailable.mockRejectedValue(new Error('network'));

    startBackgroundDpUpdate();
    await flush();

    expect(core.tryAsyncDpUpdate).not.toHaveBeenCalled();
  });
});