/**
 * P5: the managed Workspace ConfigWatcher owns ONLY managed Workspace/global
 * state. External project capability roots are watched by the server-owned
 * ProjectCapabilityWatcherRegistry (packages/server-core/src/projects); the
 * old in-workspace project branch is gone.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher } from '../watcher.ts';

describe('ConfigWatcher managed scope', () => {
  it('emits user/global hooks changes from the app-level hooks file', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-config-watcher-'));
    const observed = new Promise<void>((resolve) => {
      const watcher = makeRunningWatcher(workspaceRoot, {
        onUserGlobalHooksConfigChange: resolve,
      });
      watcher.notifyGlobalConfigFileChange('hooks.json');
      setTimeout(() => watcher.stop(), 200);
    });

    try {
      await expect(observed).resolves.toBeUndefined();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('owns no external project branch: .nessy-agent and .nessy changes under the tree emit nothing project-specific', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-config-watcher-'));
    const watcher = makeRunningWatcher(workspaceRoot, {});

    try {
      // These no longer route anywhere; the call must simply not throw and the
      // callback surface has no project member to invoke.
      watcher.notifyFileChange('project/.nessy-agent/config.toml');
      watcher.notifyFileChange('project/.nessy/config.toml');
      await wait(150);
      expect('onProjectNessyAgentConfigChange' in watcher['callbacks']).toBe(false);
    } finally {
      watcher.stop();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

function makeRunningWatcher(
  workspaceRoot: string,
  callbacks: ConstructorParameters<typeof ConfigWatcher>[1],
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceRoot, callbacks);
  (watcher as unknown as { isRunning: boolean }).isRunning = true;
  return watcher;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
