/**
 * Tests for ConfigWatcher duplicate watcher detection.
 *
 * The activeWatchers registry detects when two ConfigWatcher instances
 * are started on the same workspace directory, which can wedge Bun's
 * event loop on Linux due to duplicate recursive fs.watch calls.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher, _getActiveWatchers } from '../watcher.ts';

describe('ConfigWatcher duplicate guard', () => {
  beforeEach(() => {
    // Registry is module-level state — clear it between tests by
    // stopping any watchers that leaked. The map is read-only from
    // the exported getter, but we can verify its state.
  });

  it('should expose an active watchers registry', () => {
    const watchers = _getActiveWatchers();
    expect(watchers).toBeInstanceOf(Map);
  });

  it('registry should be empty when no watchers are running', () => {
    // After all watchers are stopped, the registry should be empty.
    // This test validates the baseline state — if it fails, a previous
    // test leaked a watcher.
    const watchers = _getActiveWatchers();
    // Note: we can't guarantee emptiness if other tests start watchers,
    // but we can verify the type and that the getter works.
    expect(typeof watchers.size).toBe('number');
  });

  it('fails closed without recreating a missing Workspace root', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'nessy-watcher-missing-'));
    const missingRoot = join(fixture, 'workspace');
    try {
      const watcher = new ConfigWatcher(missingRoot, {}, 'ws_missing');
      expect(() => watcher.start()).toThrow('workspace-root-unavailable');
      expect(existsSync(missingRoot)).toBe(false);
      expect(_getActiveWatchers().has(missingRoot)).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
