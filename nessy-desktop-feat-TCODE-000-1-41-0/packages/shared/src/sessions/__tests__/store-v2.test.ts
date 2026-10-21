import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSessionStore } from '../store-v2.ts';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';

const STORE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'store-v2.ts')).href;
const PATHS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'workspaces', 'paths.ts')).href;

function createConfigRoot(): string {
  return mkdtempSync(join(tmpdir(), 'nessy-session-store-v2-'));
}

function run(configRoot: string, script: string) {
  return Bun.spawnSync([process.execPath, '--eval', `
    import { createSessionStore } from ${JSON.stringify(STORE_MODULE)};
    import { CONFIG_DIR, SESSIONS_DIR } from ${JSON.stringify(PATHS_MODULE)};
    const layout = { storageLayoutVersion: 2, verificationId: 'test-verification-id' };
    const store = createSessionStore(layout);
    ${script}
  `], {
    env: { ...process.env, NESSY_CONFIG_DIR: configRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>): any {
  expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
  return JSON.parse(result.stdout?.toString() ?? '');
}

function withConfigRoot(fn: (configRoot: string) => void): void {
  const configRoot = createConfigRoot();
  try {
    fn(configRoot);
  } finally {
    rmSync(configRoot, { recursive: true, force: true });
  }
}

describe('SessionStore facade name (W5)', () => {
  it('exposes createSessionStore as the canonical factory', () => {
    expect(typeof createSessionStore).toBe('function');
  });

  it('owns the versioned X7 orchestration state in the existing session header', () => {
    expect(SESSION_PERSISTENT_FIELDS).toEqual(expect.arrayContaining([
      'goalState', 'childSessionState', 'mailboxState', 'worktreeLeaseState',
      'piChildRestrictions', 'piChildBudgets', 'piChildCapabilityGeneration', 'piChildCapabilityView',
    ]));
  });
});

describe('createSessionStore', () => {
  it('derives paths under the global SESSIONS_DIR, partitioned by workspaceId', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        const dir = store.ensureWorkspaceDir('ws-alpha');
        const key = { workspaceId: 'ws-alpha', sessionId: 'sess-1' };
        console.log(JSON.stringify({
          config: CONFIG_DIR,
          sessions: SESSIONS_DIR,
          workspaceDir: dir,
          sessionPath: store.getSessionPath(key),
          sessionFilePath: store.getSessionFilePath(key),
        }));
      `));

      expect(result).toEqual({
        config: configRoot,
        sessions: join(configRoot, 'sessions'),
        workspaceDir: join(configRoot, 'sessions', 'ws-alpha'),
        sessionPath: join(configRoot, 'sessions', 'ws-alpha', 'sess-1'),
        sessionFilePath: join(configRoot, 'sessions', 'ws-alpha', 'sess-1', 'session.jsonl'),
      });
    });
  });

  it('creates a session with a UUID path, fresh workspaceId header, and no managed-path fields on disk', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        import { readFileSync } from 'node:fs';
        const config = await store.create('ws-beta', { name: 'Hello' });
        const raw = readFileSync(store.getSessionFilePath({ workspaceId: 'ws-beta', sessionId: config.id }), 'utf-8');
        const header = JSON.parse(raw.split('\\n')[0]);
        console.log(JSON.stringify({
          id: config.id,
          sessionPath: store.getSessionPath({ workspaceId: 'ws-beta', sessionId: config.id }),
          workspaceId: config.workspaceId,
          name: config.name,
          hasWorkspaceRootPath: 'workspaceRootPath' in header,
          hasBranchFromSessionPath: 'branchFromSessionPath' in header,
          rawContainsWorkspaceRootPath: raw.includes('workspaceRootPath'),
          rawContainsBranchFromSessionPath: raw.includes('branchFromSessionPath'),
          headerWorkspaceId: header.workspaceId,
        }));
      `));

      expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(result.sessionPath).toBe(join(configRoot, 'sessions', 'ws-beta', result.id));
      expect(result).toMatchObject({
        workspaceId: 'ws-beta',
        name: 'Hello',
        hasWorkspaceRootPath: false,
        hasBranchFromSessionPath: false,
        rawContainsWorkspaceRootPath: false,
        rawContainsBranchFromSessionPath: false,
        headerWorkspaceId: 'ws-beta',
      });
    });
  });

  it('round-trips create/load/list for one workspace', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        const created = await store.create('ws-gamma', { name: 'Round Trip' });
        const key = { workspaceId: 'ws-gamma', sessionId: created.id };
        const loaded = store.load(key);
        const listed = store.list('ws-gamma');
        console.log(JSON.stringify({
          createdId: created.id,
          loadedId: loaded?.id,
          loadedMessages: loaded?.messages,
          loadedTokenUsage: loaded?.tokenUsage,
          listedCount: listed.length,
          listedId: listed[0]?.id,
          listedWorkspaceId: listed[0]?.workspaceId,
        }));
      `));

      expect(result.createdId).toBe(result.loadedId);
      expect(result.loadedMessages).toEqual([]);
      expect(result.loadedTokenUsage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 });
      expect(result.listedCount).toBe(1);
      expect(result.listedId).toBe(result.createdId);
      expect(result.listedWorkspaceId).toBe('ws-gamma');
    });
  });

  it('scopes list() to the requested workspace only', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        await store.create('ws-one', { name: 'One' });
        await store.create('ws-two', { name: 'Two' });
        await store.create('ws-two', { name: 'Two-B' });
        console.log(JSON.stringify({
          one: store.list('ws-one').map(s => s.name),
          two: store.list('ws-two').map(s => s.name).sort(),
        }));
      `));

      expect(result.one).toEqual(['One']);
      expect(result.two).toEqual(['Two', 'Two-B']);
    });
  });

  it('derives the session directory as the default cwd for a no-project session', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        const config = await store.create('ws-delta');
        const expectedDir = store.getSessionPath({ workspaceId: 'ws-delta', sessionId: config.id });
        console.log(JSON.stringify({
          workingDirectory: config.workingDirectory ?? null,
          sdkCwd: config.sdkCwd,
          expectedDir,
        }));
      `));

      expect(result.workingDirectory).toBeNull();
      expect(result.sdkCwd).toBe(result.expectedDir);
    });
  });

  it('preserves an explicit external workingDirectory as metadata and sdkCwd', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        import { join } from 'node:path';
        import { mkdtempSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        const externalProject = mkdtempSync(join(tmpdir(), 'nessy-external-project-'));
        const config = await store.create('ws-epsilon', { workingDirectory: externalProject });
        console.log(JSON.stringify({ workingDirectory: config.workingDirectory, sdkCwd: config.sdkCwd, externalProject }));
      `));

      expect(result.workingDirectory).toBe(result.externalProject);
      expect(result.sdkCwd).toBe(result.externalProject);
    });
  });

  it('expands a portable (~) workingDirectory back to an absolute path on load (Q1.3)', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { homedir } from 'node:os';
        const config = await store.create('ws-tilde');
        const file = store.getSessionFilePath({ workspaceId: 'ws-tilde', sessionId: config.id });
        const lines = readFileSync(file, 'utf-8').split('\\n');
        const header = JSON.parse(lines[0]);
        header.workingDirectory = '~/nessy-tilde-project';
        header.sdkCwd = '~/nessy-tilde-project';
        lines[0] = JSON.stringify(header);
        writeFileSync(file, lines.join('\\n'));
        const loaded = await store.load({ workspaceId: 'ws-tilde', sessionId: config.id });
        const metadata = (await store.list('ws-tilde')).find(entry => entry.id === config.id);
        console.log(JSON.stringify({
          loadedWd: loaded.workingDirectory, loadedSdkCwd: loaded.sdkCwd,
          metadataWd: metadata?.workingDirectory ?? null,
          expected: homedir() + '/nessy-tilde-project',
        }));
      `));

      expect(result.loadedWd).toBe(result.expected);
      expect(result.loadedSdkCwd).toBe(result.expected);
      expect(result.metadataWd).toBe(result.expected);
    });
  });

  it('rejects a managed-root candidate passed as an explicit workingDirectory', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        import { join } from 'node:path';
        let rejected = false;
        try {
          await store.create('ws-zeta', { workingDirectory: SESSIONS_DIR });
        } catch {
          rejected = true;
        }
        let rejectedWorkspaces = false;
        try {
          await store.create('ws-zeta-2', { workingDirectory: join(CONFIG_DIR, 'workspaces', 'ws-zeta-2') });
        } catch {
          rejectedWorkspaces = true;
        }
        console.log(JSON.stringify({ rejected, rejectedWorkspaces }));
      `));

      expect(result).toEqual({ rejected: true, rejectedWorkspaces: true });
    });
  });

  it('stores branch lineage as a composite parent SessionKey, never a managed session path', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        import { readFileSync } from 'node:fs';
        const parent = await store.create('ws-eta', { name: 'Parent' });
        const child = await store.create('ws-eta', {
          name: 'Child',
          branchFrom: { parent: { workspaceId: 'ws-eta', sessionId: parent.id }, messageId: 'msg-1' },
        });
        const raw = readFileSync(store.getSessionFilePath({ workspaceId: 'ws-eta', sessionId: child.id }), 'utf-8');
        console.log(JSON.stringify({
          parentId: parent.id,
          branchFrom: child.branchFrom,
          rawContainsBranchFromSessionPath: raw.includes('branchFromSessionPath'),
        }));
      `));

      expect(result.branchFrom).toEqual({ parent: { workspaceId: 'ws-eta', sessionId: result.parentId }, messageId: 'msg-1' });
      expect(result.rawContainsBranchFromSessionPath).toBe(false);
    });
  });

  it('lets equal sessionId values coexist across two different fresh Workspaces', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        const a = await store.create('workspace-a', { sessionId: 'shared-session-id', name: 'A' });
        const b = await store.create('workspace-b', { sessionId: 'shared-session-id', name: 'B' });
        const pathA = store.getSessionPath({ workspaceId: 'workspace-a', sessionId: 'shared-session-id' });
        const pathB = store.getSessionPath({ workspaceId: 'workspace-b', sessionId: 'shared-session-id' });
        const loadedA = store.load({ workspaceId: 'workspace-a', sessionId: 'shared-session-id' });
        const loadedB = store.load({ workspaceId: 'workspace-b', sessionId: 'shared-session-id' });
        console.log(JSON.stringify({
          aId: a.id,
          bId: b.id,
          pathA,
          pathB,
          loadedAName: loadedA?.name,
          loadedBName: loadedB?.name,
          loadedAWorkspaceId: loadedA?.workspaceId,
          loadedBWorkspaceId: loadedB?.workspaceId,
        }));
      `));

      expect(result.aId).toBe('shared-session-id');
      expect(result.bId).toBe('shared-session-id');
      expect(result.pathA).not.toBe(result.pathB);
      expect(result.loadedAName).toBe('A');
      expect(result.loadedBName).toBe('B');
      expect(result.loadedAWorkspaceId).toBe('workspace-a');
      expect(result.loadedBWorkspaceId).toBe('workspace-b');
    });
  });

  it('deletes only the targeted session, leaving a same-ID session in another Workspace intact', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        await store.create('workspace-x', { sessionId: 'dup-id' });
        await store.create('workspace-y', { sessionId: 'dup-id' });
        const deleted = store.delete({ workspaceId: 'workspace-x', sessionId: 'dup-id' });
        const deletedAgain = store.delete({ workspaceId: 'workspace-x', sessionId: 'dup-id' });
        console.log(JSON.stringify({
          deleted,
          deletedAgain,
          xLoaded: store.load({ workspaceId: 'workspace-x', sessionId: 'dup-id' }),
          yLoaded: store.load({ workspaceId: 'workspace-y', sessionId: 'dup-id' })?.id ?? null,
        }));
      `));

      expect(result.deleted).toBe(true);
      expect(result.deletedAgain).toBe(false);
      expect(result.xLoaded).toBeNull();
      expect(result.yLoaded).toBe('dup-id');
    });
  });

  it('rejects a layout token that is not verified storage layout v2', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        let threw = false;
        try {
          createSessionStore({ storageLayoutVersion: 1, verificationId: 'x' });
        } catch {
          threw = true;
        }
        console.log(JSON.stringify({ threw }));
      `));
      expect(result.threw).toBe(true);
    });
  });
});

// F1.776 — builds before F1.765 (`cb493486d`) let codex's session-MCP child write a
// session's data into the PRE-storage-v2 folder `<config>/workspaces/<ws>/sessions/<sid>/`.
// Deleting the session must take that folder too, and nothing beside it.
describe('deleting a session removes its pre-storage-v2 folder (F1.776)', () => {
  const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;
  const plantLegacy = `
    import { existsSync as legacyExists, mkdirSync as legacyMkdir, writeFileSync as legacyWrite } from 'node:fs';
    import { join as legacyJoin } from 'node:path';
    const legacy = (ws, sid) => legacyJoin(CONFIG_DIR, 'workspaces', ws, 'sessions', sid);
    for (const [ws, sid] of [['ws-x', 'dup-id'], ['ws-x', 'keep-id'], ['ws-y', 'dup-id']]) {
      legacyMkdir(legacyJoin(legacy(ws, sid), 'data'), { recursive: true });
      legacyWrite(legacyJoin(legacy(ws, sid), 'data', 'MEMORY.md'), 'old codex memory');
    }
    legacyWrite(legacyJoin(CONFIG_DIR, 'workspaces', 'ws-x', 'config.json'), '{}');
    const survivors = () => ({
      deletedLegacy: legacyExists(legacy('ws-x', 'dup-id')),
      siblingLegacy: legacyExists(legacyJoin(legacy('ws-x', 'keep-id'), 'data', 'MEMORY.md')),
      otherWorkspaceLegacy: legacyExists(legacyJoin(legacy('ws-y', 'dup-id'), 'data', 'MEMORY.md')),
      workspaceConfig: legacyExists(legacyJoin(CONFIG_DIR, 'workspaces', 'ws-x', 'config.json')),
      legacySessionsRoot: legacyExists(legacyJoin(CONFIG_DIR, 'workspaces', 'ws-x', 'sessions')),
    });
  `;
  const expectOnlyThatSessionsLegacyFolderGone = (result: any) => {
    expect(result.deleted).toBe(true);
    expect(result.deletedLegacy).toBe(false);
    // Boundary: the same id in another workspace, a sibling session and the
    // workspace's own files are untouched.
    expect(result.siblingLegacy).toBe(true);
    expect(result.otherWorkspaceLegacy).toBe(true);
    expect(result.workspaceConfig).toBe(true);
    expect(result.legacySessionsRoot).toBe(true);
  };

  it('SessionStore.delete (the SessionManager path) removes it', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        ${plantLegacy}
        for (const [ws, sid] of [['ws-x', 'dup-id'], ['ws-x', 'keep-id'], ['ws-y', 'dup-id']]) {
          await store.create(ws, { sessionId: sid });
        }
        const deleted = store.delete({ workspaceId: 'ws-x', sessionId: 'dup-id' });
        console.log(JSON.stringify({ deleted, ...survivors() }));
      `));
      expectOnlyThatSessionsLegacyFolderGone(result);
    });
  });

  it('storage.ts deleteSession (the retention-sweep path) removes it', () => {
    withConfigRoot(configRoot => {
      const result = output(run(configRoot, `
        ${plantLegacy}
        const { deleteSession } = await import(${JSON.stringify(STORAGE_MODULE)});
        for (const [ws, sid] of [['ws-x', 'dup-id'], ['ws-x', 'keep-id'], ['ws-y', 'dup-id']]) {
          await store.create(ws, { sessionId: sid });
        }
        const deleted = deleteSession('ws-x', 'dup-id');
        console.log(JSON.stringify({ deleted, ...survivors() }));
      `));
      expectOnlyThatSessionsLegacyFolderGone(result);
    });
  });
});

describe('the v2 store reads a stored mode the way the JSONL reader does (F1.1234)', () => {
  const JSONL_MODULE = pathToFileURL(join(import.meta.dir, '..', 'jsonl.ts')).href;
  // Each arm spawns a child; under a loaded machine one spawn has measured 3 s.
  const CHILD_TIMEOUT_MS = 30_000;

  // F1.1050: a stored `explore` (and its older spelling `safe`) is read as
  // `plan` forever. store-v2's own header reader was a bare JSON.parse, so the
  // startup restore (which hydrates from `list()`) got the raw `explore`.
  function readBack(configRoot: string, header: Record<string, unknown>) {
    return output(run(configRoot, `
      const { readSessionHeader } = await import(${JSON.stringify(JSONL_MODULE)});
      const { readFileSync, writeFileSync } = await import('node:fs');
      const created = await store.create('ws-modes', { sessionId: 'stored-mode' });
      const key = { workspaceId: 'ws-modes', sessionId: 'stored-mode' };
      const file = store.getSessionFilePath(key);
      const lines = readFileSync(file, 'utf8').split('\\n');
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), ...${JSON.stringify(header)} });
      writeFileSync(file, lines.join('\\n'));
      const before = readFileSync(file, 'utf8');
      const listed = store.list('ws-modes')[0];
      const loaded = store.load(key);
      const jsonl = readSessionHeader(file);
      console.log(JSON.stringify({
        listed: [listed?.permissionMode ?? null, listed?.previousPermissionMode ?? null],
        loaded: [loaded?.permissionMode ?? null, loaded?.previousPermissionMode ?? null],
        loadedPlanPrevious: loaded?.planModeState?.previousMode ?? null,
        jsonl: [jsonl?.permissionMode ?? null, jsonl?.previousPermissionMode ?? null],
        fileUnchanged: readFileSync(file, 'utf8') === before,
      }));
    `));
  }

  it('reads explore and safe as plan in list() and load(), and a read rewrites nothing', () => {
    withConfigRoot(configRoot => {
      const result = readBack(configRoot, {
        permissionMode: 'explore',
        previousPermissionMode: 'safe',
        planModeState: { previousMode: 'explore' },
      });
      expect(result.listed).toEqual(['plan', 'plan']);
      expect(result.loaded).toEqual(['plan', 'plan']);
      expect(result.loadedPlanPrevious).toBe('plan');
      expect(result.jsonl).toEqual(['plan', 'plan']);
      expect(result.fileUnchanged).toBe(true);
    });
  }, CHILD_TIMEOUT_MS);

  it('keeps plan and auto as they are', () => {
    withConfigRoot(configRoot => {
      const kept = readBack(configRoot, { permissionMode: 'plan', previousPermissionMode: 'auto' });
      expect(kept.listed).toEqual(['plan', 'auto']);
      expect(kept.loaded).toEqual(['plan', 'auto']);
    });
  }, CHILD_TIMEOUT_MS);

  it('treats an unknown spelling exactly as the JSONL reader does', () => {
    withConfigRoot(configRoot => {
      const unknown = readBack(configRoot, { permissionMode: 'warp-speed' });
      expect(unknown.listed).toEqual(unknown.jsonl);
      expect(unknown.loaded).toEqual(unknown.jsonl);
      expect(unknown.listed[0]).toBeNull();
    });
  }, CHILD_TIMEOUT_MS);
});
