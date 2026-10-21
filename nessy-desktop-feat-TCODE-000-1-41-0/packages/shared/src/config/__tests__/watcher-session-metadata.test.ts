/**
 * W6 Step 7 / W5 carry-forward: session-metadata fs-watch relocation.
 *
 * Sessions moved to the global SESSIONS_DIR/<workspaceId> partition (W5), which
 * lives OUTSIDE the managed workspace dir, so the recursive workspace watch no
 * longer sees session.jsonl edits. The watcher now watches the session
 * partition directly. Self-writes are still filtered downstream by the consumer
 * (SessionManager write-guard/signature), so this suite only proves the watcher
 * re-fires for external edits to `<sessionId>/session.jsonl`.
 */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher } from '../watcher.ts';
import { getSessionStoragePath, getWorkspaceSessionRootPath } from '../../workspaces/paths.ts';

const WORKSPACE_ID = 'ws-session-meta';

function makeRunningWatcher(
  workspaceRoot: string,
  callbacks: ConstructorParameters<typeof ConfigWatcher>[1],
  explicitWorkspaceId?: string,
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceRoot, callbacks, explicitWorkspaceId);
  (watcher as unknown as { isRunning: boolean }).isRunning = true;
  return watcher;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('ConfigWatcher session metadata (global partition)', () => {
  it('fires onSessionMetadataChange for an external edit to the global session partition', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-ws-'));
    const workspaceRoot = join(wsParent, WORKSPACE_ID);
    mkdirSync(workspaceRoot, { recursive: true });

    const sessionId = 'sess-external';
    const sessionDir = getSessionStoragePath(WORKSPACE_ID, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session.jsonl'),
      JSON.stringify({ sessionId, name: 'External Edit', workspaceId: WORKSPACE_ID }) + '\n',
    );

    const observed = new Promise<string>((resolve) => {
      const watcher = makeRunningWatcher(workspaceRoot, {
        onSessionMetadataChange: (sid) => resolve(sid),
      });
      watcher.notifySessionPartitionFileChange(`${sessionId}/session.jsonl`);
      setTimeout(() => watcher.stop(), 400);
    });

    try {
      expect(await observed).toBe(sessionId);
    } finally {
      rmSync(wsParent, { recursive: true, force: true });
      rmSync(getWorkspaceSessionRootPath(WORKSPACE_ID), { recursive: true, force: true });
    }
  });

  it('resolves the partition by the EXPLICIT workspace ID, not the root basename', async () => {
    // The managed root basename differs from the workspace ID here — the
    // basename fallback would read the wrong SESSIONS_DIR partition (W6 trap).
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-ws-'));
    const workspaceRoot = join(wsParent, 'some-unrelated-folder-name');
    mkdirSync(workspaceRoot, { recursive: true });

    const sessionId = 'sess-explicit-id';
    const sessionDir = getSessionStoragePath(WORKSPACE_ID, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'session.jsonl'),
      JSON.stringify({ sessionId, name: 'Explicit ID', workspaceId: WORKSPACE_ID }) + '\n',
    );

    const observed = new Promise<string>((resolve) => {
      const watcher = makeRunningWatcher(workspaceRoot, {
        onSessionMetadataChange: (sid) => resolve(sid),
      }, WORKSPACE_ID);
      watcher.notifySessionPartitionFileChange(`${sessionId}/session.jsonl`);
      setTimeout(() => watcher.stop(), 400);
    });

    try {
      expect(await observed).toBe(sessionId);
    } finally {
      rmSync(wsParent, { recursive: true, force: true });
      rmSync(getWorkspaceSessionRootPath(WORKSPACE_ID), { recursive: true, force: true });
    }
  });

  it('ignores non-session.jsonl files (e.g. atomic .tmp) under the partition', async () => {
    const wsParent = mkdtempSync(join(tmpdir(), 'nessy-ws-'));
    const workspaceRoot = join(wsParent, WORKSPACE_ID);
    mkdirSync(workspaceRoot, { recursive: true });

    let calls = 0;
    const watcher = makeRunningWatcher(workspaceRoot, {
      onSessionMetadataChange: () => { calls += 1; },
    });

    try {
      watcher.notifySessionPartitionFileChange('sess-x/session.jsonl.tmp');
      watcher.notifySessionPartitionFileChange('sess-x/other.json');
      await wait(200);
      expect(calls).toBe(0);
    } finally {
      watcher.stop();
      rmSync(wsParent, { recursive: true, force: true });
    }
  });
});
