/**
 * ConfigWatcher must survive config.json turning legacy/invalid AFTER startup.
 *
 * handleConfigChange() runs inside a debounce setTimeout (see debounce() in
 * watcher.ts) — an uncaught throw there escapes the event loop entirely. The
 * headless server (packages/server/src/index.ts) registers only an
 * `unhandledRejection` handler, so an uncaught synchronous exception from the
 * timer kills the whole running server.
 *
 * handleConfigChange() reads config.json twice: validateConfig() does its own
 * read, then loadStoredConfig() reads again. The W3/W4 fail-closed guard makes
 * loadStoredConfig() THROW UnsupportedStorageLayoutError for a legacy/corrupt
 * file — correct at startup (crash, don't overwrite), but if the file turns
 * invalid between the two reads (external edit/downgrade TOCTOU), the throw
 * would escape the debounce timer. The watcher must catch it, report through
 * its own onError callback, keep last-known-good state, and never rewrite
 * config.json.
 *
 * NOTE on shared state: CONFIG_DIR is frozen per test run (see
 * packages/shared/tests/setup/isolate-shared-config-dir.ts), and config.json
 * inside it is shared by every in-process test — each test here snapshots and
 * restores it in `finally`.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import { ConfigWatcher, type ConfigWatcherCallbacks } from '../watcher.ts';
import type { ValidationResult } from '../validators.ts';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const LEGACY_CONFIG_CONTENT = JSON.stringify({
  // Pre-v2 shape: no storageLayoutVersion. loadStoredConfig() throws
  // UnsupportedStorageLayoutError on this.
  workspaces: [{ id: 'ws-1', name: 'Legacy Workspace', rootPath: '/tmp/legacy-ws', createdAt: 1 }],
  activeWorkspaceId: 'ws-1',
  activeSessionId: null,
}, null, 2);

function snapshotConfigFile(): string | null {
  return existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
}

function restoreConfigFile(snapshot: string | null): void {
  if (snapshot === null) {
    if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
  } else {
    writeFileSync(CONFIG_FILE, snapshot, 'utf-8');
  }
}

function makeRunningWatcher(
  workspaceRoot: string,
  callbacks: ConfigWatcherCallbacks,
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceRoot, callbacks);
  (watcher as unknown as { isRunning: boolean }).isRunning = true;
  return watcher;
}

describe('ConfigWatcher config.json reload fail-closed survival', () => {
  it('reload step catches UnsupportedStorageLayoutError, reports onError, keeps state, never rewrites', () => {
    // Simulates the second half of the TOCTOU race: validation already passed,
    // then the on-disk file turned legacy before loadStoredConfig()'s read.
    // This is the exact statement that runs inside the debounce timer.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-watcher-failclosed-'));
    const snapshot = snapshotConfigFile();

    const errors: Array<{ file: string; error: Error }> = [];
    let configChangeCalls = 0;
    let llmConnectionsChangeCalls = 0;

    const watcher = makeRunningWatcher(workspaceRoot, {
      onError: (file, error) => errors.push({ file, error }),
      onConfigChange: () => { configChangeCalls += 1; },
      onLlmConnectionsChange: () => { llmConnectionsChangeCalls += 1; },
    });

    try {
      writeFileSync(CONFIG_FILE, LEGACY_CONFIG_CONTENT, 'utf-8');

      // Must not throw — an uncaught throw here escapes the debounce
      // setTimeout in production and kills the headless server process.
      expect(() => {
        (watcher as unknown as { reloadStoredConfig: () => void }).reloadStoredConfig();
      }).not.toThrow();

      // The failure is reported through the watcher's own error channel...
      expect(errors).toHaveLength(1);
      expect(errors[0]!.file).toBe('config.json');
      expect(errors[0]!.error).toBeInstanceOf(Error);
      expect(errors[0]!.error.name).toBe('UnsupportedStorageLayoutError');

      // ...no config callbacks fire (last-known-good state is retained)...
      expect(configChangeCalls).toBe(0);
      expect(llmConnectionsChangeCalls).toBe(0);

      // ...and the on-disk file is untouched — the watcher must never
      // rewrite config.json (byte-for-byte identical).
      expect(readFileSync(CONFIG_FILE, 'utf-8')).toBe(LEGACY_CONFIG_CONTENT);
    } finally {
      watcher.stop();
      restoreConfigFile(snapshot);
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('survives a legacy config.json through the full debounced change-event path', async () => {
    // End-to-end guard for the first half too: when validateConfig() itself
    // sees the legacy file, the watcher reports a validation error, stays
    // alive, and never rewrites the file.
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-watcher-failclosed-'));
    const snapshot = snapshotConfigFile();

    let validationError: { file: string; result: ValidationResult } | null = null;
    let configChangeCalls = 0;
    const validationErrorSeen = new Promise<void>((resolve) => {
      const watcher = makeRunningWatcher(workspaceRoot, {
        onValidationError: (file, result) => {
          validationError = { file, result };
          resolve();
        },
        onConfigChange: () => { configChangeCalls += 1; },
      });
      writeFileSync(CONFIG_FILE, LEGACY_CONFIG_CONTENT, 'utf-8');
      watcher.notifyGlobalConfigFileChange('config.json');
      setTimeout(() => watcher.stop(), 400);
    });

    try {
      await Promise.race([
        validationErrorSeen,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('watcher never reported the invalid config')), 2000)),
      ]);

      expect(validationError!.file).toBe('config.json');
      expect(validationError!.result.valid).toBe(false);
      expect(configChangeCalls).toBe(0);
      expect(readFileSync(CONFIG_FILE, 'utf-8')).toBe(LEGACY_CONFIG_CONTENT);
    } finally {
      restoreConfigFile(snapshot);
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
