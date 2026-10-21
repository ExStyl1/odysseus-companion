import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceService,
  normalizeWorkspaceName,
  workspaceNameKey,
  type CreateWorkspaceRequest,
  type WorkspaceCleanupParticipant,
} from '../service.ts';
import { atomicWriteConfigFileSync } from '../../config/storage.ts';
import { saveWorkspaceConfig } from '../storage.ts';
import type { WorkspaceInfo } from '@nessy-agent/core/types';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-workspaces-'));
  tempDirs.push(configDir);
  return configDir;
}

function readDeleteJournalSnapshot(configDir: string, workspaceId: string): {
  ref: { id: string; lastAccessedAt: number };
  refIndex: number;
  wasActive: boolean;
} {
  const registry = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')) as {
    workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
    activeWorkspaceId?: unknown;
  };
  const refIndex = registry.workspaceRefs.findIndex(ref => ref.id === workspaceId);
  const ref = registry.workspaceRefs[refIndex];
  if (!ref) throw new Error('Expected registry ref');
  return { ref, refIndex, wasActive: registry.activeWorkspaceId === workspaceId };
}

function stageCommittedDeleteJournal(
  configDir: string,
  workspaceId: string,
  workspaceRootPath: string,
  transactionId: string,
  phase: 'roots-staged' | 'registry-removed' | 'cleanup-committed',
  participantIds: string[],
): string {
  const trashPath = join(configDir, '.trash', transactionId);
  const snapshot = readDeleteJournalSnapshot(configDir, workspaceId);
  mkdirSync(trashPath, { recursive: true });
  renameSync(workspaceRootPath, join(trashPath, 'workspace'));
  const configPath = join(configDir, 'config.json');
  const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as {
    workspaceRefs: Array<{ id: string }>;
  };
  registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== workspaceId);
  writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
  writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
    transactionId,
    workspaceId,
    phase,
    participantIds,
    ...snapshot,
  }), 'utf-8');
  return trashPath;
}

describe('canonical workspace lifecycle', () => {
  it('normalizes names exactly', () => {
    expect(normalizeWorkspaceName('  A\u00a0\u00a0Workspace  ')).toBe('A Workspace');
    expect(workspaceNameKey('  A\u00a0\u00a0Workspace  ')).toBe('a workspace');
    expect(() => normalizeWorkspaceName('')).toThrow('Workspace name must be 1–80 characters');
    expect(() => normalizeWorkspaceName('x'.repeat(81))).toThrow('Workspace name must be 1–80 characters');
    expect(() => normalizeWorkspaceName('bad/name')).toThrow('Workspace name contains unsupported characters');
  });

  it('uses one generated ID in the registry, managed root, and folder config', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [{ type: 'workspace_oauth', workspaceId: 'ignored' }] },
    });

    const info = await service.create({ name: '  Alpha   Team  ', defaults: { model: 'model-a' } });
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')) as {
      storageLayoutVersion: number;
      workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
      workspaces?: unknown;
    };
    const resolved = service.resolve(info.id);
    const folderConfig = JSON.parse(readFileSync(join(resolved.workspaceRootPath, 'config.json'), 'utf-8')) as {
      id: string;
      name: string;
      defaults?: { model?: string; workingDirectory?: string };
    };

    expect(config.workspaceRefs).toHaveLength(1);
    expect(config.storageLayoutVersion).toBe(2);
    expect(config.workspaces).toBeUndefined();
    expect(config.workspaceRefs[0]?.id).toBe(info.id);
    expect(folderConfig.id).toBe(info.id);
    expect(folderConfig.name).toBe('Alpha Team');
    expect(folderConfig.defaults?.model).toBe('model-a');
    expect(folderConfig.defaults?.workingDirectory).toBeUndefined();
    expect(resolved.workspaceRootPath).toBe(join(configDir, 'workspaces', info.id));
    expect(service.listResolved()).toEqual([resolved]);
    expect(info.hasCredential).toBe(false);
    expect(JSON.stringify(info)).not.toContain('file://');
    expect(JSON.stringify(info)).not.toContain(configDir);
  });

  it('reconciles new Workspace-owned resources before committing the registry ref', async () => {
    const configDir = makeConfigDir();
    const seen: string[] = [];
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      onWorkspaceCreated: workspace => {
        seen.push(workspace.id);
        mkdirSync(join(workspace.workspaceRootPath, 'sources', 'connector'), { recursive: true });
        writeFileSync(join(workspace.workspaceRootPath, 'sources', 'connector', 'config.json'), '{}');
      },
    });

    const created = await service.create({ name: 'Connector Policy' });
    const resolved = service.resolve(created.id);
    expect(seen).toEqual([created.id]);
    expect(existsSync(join(resolved.workspaceRootPath, 'sources', 'connector', 'config.json'))).toBe(true);
  });

  it('maps the durable default-project identity to a fresh handle without exposing a path', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      defaultProjectResolver: {
        async getProject(workspaceId, project) {
          expect(workspaceId).toBeTruthy();
          expect(project.workingDirectory).toBe('/external/project');
          return { handleId: 'current-handle', name: 'Trusted Project', trusted: true };
        },
      },
    });
    const created = await service.create({ name: 'Project Workspace' });
    const workspaceRootPath = service.resolve(created.id).workspaceRootPath;
    await service.setDefaultProject(created.id, { workingDirectory: '/external/project' });

    const info = (await service.list())[0];

    expect(info?.defaults?.defaultProject).toEqual({ handleId: 'current-handle', name: 'Trusted Project', trusted: true });
    expect(JSON.stringify(info)).not.toContain(workspaceRootPath);
    expect(JSON.stringify(info)).not.toContain('/external/project');
  });

  it('rejects duplicate normalized names and raw working directories', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });

    await service.create({ name: 'Example Workspace' });
    await expect(service.create({ name: '  example   workspace  ' })).rejects.toThrow('Workspace name already exists');
    await expect(service.create({
      name: 'Another Workspace',
      defaults: { workingDirectory: '/tmp/outside' } as unknown as CreateWorkspaceRequest['defaults'],
    })).rejects.toThrow('Workspace defaults must not include workingDirectory');

    const typeCheckedInput: CreateWorkspaceRequest = {
      name: 'Type Checked',
      defaults: {
        // @ts-expect-error raw workspace paths are not part of lifecycle creation
        workingDirectory: '/tmp/outside',
      },
    };
    void typeCheckedInput;
  });

  it('renames metadata only and rejects missing or corrupt registered folders', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await service.create({ name: 'Before Rename' });
    const rootPath = service.resolve(created.id).workspaceRootPath;

    const renamed = await service.rename(created.id, 'After Rename');
    expect(renamed.name).toBe('After Rename');
    expect(service.resolve(created.id).workspaceRootPath).toBe(rootPath);

    const corrupt = await service.create({ name: 'Corrupt Workspace' });
    writeFileSync(join(service.resolve(corrupt.id).workspaceRootPath, 'config.json'), '{', 'utf-8');
    expect(() => service.resolve(corrupt.id)).toThrow('Registered workspace data is corrupt');

    rmSync(rootPath, { recursive: true, force: true });
    expect(() => service.resolve(created.id)).toThrow('Registered workspace data is missing');
    await expect(service.updateSettings(created.id, {
      defaults: { model: 'must-not-recreate' },
    })).rejects.toThrow('Registered workspace data is missing');
    expect(existsSync(rootPath)).toBe(false);
  });

  it('does not recreate a missing root through the internal config writer', () => {
    const rootPath = join(makeConfigDir(), 'workspaces', 'missing');
    expect(() => saveWorkspaceConfig(rootPath, {
      id: 'missing',
      name: 'Missing',
      createdAt: 1,
      updatedAt: 1,
    })).toThrow('Managed Workspace root is missing');
    expect(existsSync(rootPath)).toBe(false);
  });

  it('deletes only derived managed roots after quiescence and cleanup staging', async () => {
    const configDir = makeConfigDir();
    const outsidePath = join(configDir, 'outside');
    const calls: string[] = [];
    const participant: WorkspaceCleanupParticipant = {
      id: 'test-cleanup',
      async stage(workspaceId, transactionId) {
        calls.push(`stage:${workspaceId}:${transactionId}`);
      },
      async commit(transactionId) {
        calls.push(`commit:${transactionId}`);
      },
      async rollback(transactionId) {
        calls.push(`rollback:${transactionId}`);
      },
    };
    const service = createWorkspaceService({
      configDir,
      credentialManager: {
        list: async () => [],
        deleteWorkspaceCredentials: async () => {},
      },
      cleanupParticipants: [participant],
      quiescence: {
        async acquire(workspaceId) {
          calls.push(`acquire:${workspaceId}`);
          return { release: async () => { calls.push(`release:${workspaceId}`); } };
        },
      },
    });
    const created = await service.create({ name: 'Delete Me' });
    const rootPath = service.resolve(created.id).workspaceRootPath;
    writeFileSync(outsidePath, 'must survive', 'utf-8');
    const folderConfig = JSON.parse(readFileSync(join(rootPath, 'config.json'), 'utf-8')) as Record<string, unknown>;
    folderConfig.rootPath = outsidePath;
    writeFileSync(join(rootPath, 'config.json'), JSON.stringify(folderConfig), 'utf-8');

    const result = await service.delete(created.id);

    expect(result).toEqual({ deleted: true, cleanupFailures: [] });
    expect(existsSync(rootPath)).toBe(false);
    expect(readFileSync(outsidePath, 'utf-8')).toBe('must survive');
    expect(calls[0]).toBe(`acquire:${created.id}`);
    expect(calls.some(call => call.startsWith(`stage:${created.id}:`))).toBe(true);
    expect(calls.some(call => call.startsWith('commit:'))).toBe(true);
    expect(calls.at(-1)).toBe(`release:${created.id}`);
  });

  it('stages and removes the disjoint global session root during delete, tolerating an absent one', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      quiescence: { async acquire() { return { release: async () => {} }; } },
    });

    const withSessions = await service.create({ name: 'Delete With Sessions' });
    const sessionRootPath = join(configDir, 'sessions', withSessions.id);
    mkdirSync(join(sessionRootPath, 'sess-1'), { recursive: true });
    writeFileSync(join(sessionRootPath, 'sess-1', 'session.jsonl'), '{"id":"sess-1"}\n', 'utf-8');

    const withSessionsResult = await service.delete(withSessions.id);

    expect(withSessionsResult).toEqual({ deleted: true, cleanupFailures: [] });
    expect(existsSync(sessionRootPath)).toBe(false);
    expect(
      readdirSync(join(configDir, '.trash'), { withFileTypes: true }).filter(entry => entry.isDirectory()),
    ).toHaveLength(0);

    const withoutSessions = await service.create({ name: 'Delete Without Sessions' });
    const withoutSessionsResult = await service.delete(withoutSessions.id);

    expect(withoutSessionsResult).toEqual({ deleted: true, cleanupFailures: [] });
    expect(() => service.resolve(withoutSessions.id)).toThrow('Workspace is not registered');
  });

  it('restores both disjoint roots when a staged delete cannot commit', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      quiescence: { async acquire() { return { release: async () => {} }; } },
      cleanupParticipants: [{
        id: 'runtime',
        async stage() {},
        async commit() { throw new Error('commit failed'); },
        async rollback() {},
      }],
    });
    const created = await service.create({ name: 'Both Roots Inline Rollback' });
    const rootPath = service.resolve(created.id).workspaceRootPath;
    const sessionRootPath = join(configDir, 'sessions', created.id);
    mkdirSync(join(sessionRootPath, 'sess-1'), { recursive: true });
    writeFileSync(join(sessionRootPath, 'sess-1', 'session.jsonl'), 'session-data', 'utf-8');

    const result = await service.delete(created.id);

    expect(result.deleted).toBe(false);
    expect(existsSync(rootPath)).toBe(true);
    expect(readFileSync(join(sessionRootPath, 'sess-1', 'session.jsonl'), 'utf-8')).toBe('session-data');
    expect(service.resolve(created.id).id).toBe(created.id);
  });

  it('restores both disjoint roots when recovering a roots-staged delete journal', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await service.create({ name: 'Both Roots Recovery Rollback' });
    const rootPath = service.resolve(created.id).workspaceRootPath;
    const sessionRootPath = join(configDir, 'sessions', created.id);
    mkdirSync(join(sessionRootPath, 'sess-1'), { recursive: true });
    writeFileSync(join(sessionRootPath, 'sess-1', 'session.jsonl'), 'session-data', 'utf-8');
    const transactionId = 'both-roots-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    renameSync(sessionRootPath, join(trashPath, 'sessions'));
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'roots-staged',
      participantIds: [],
      ...readDeleteJournalSnapshot(configDir, created.id),
    }), 'utf-8');

    const recovered = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    await recovered.list();

    expect(recovered.resolve(created.id).workspaceRootPath).toBe(rootPath);
    expect(readFileSync(join(sessionRootPath, 'sess-1', 'session.jsonl'), 'utf-8')).toBe('session-data');
    expect(existsSync(trashPath)).toBe(false);
  });

  it('removes both disjoint staged roots when committing an interrupted delete', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Both Roots Recovery Commit' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const sessionRootPath = join(configDir, 'sessions', created.id);
    mkdirSync(sessionRootPath, { recursive: true });
    writeFileSync(join(sessionRootPath, 'orphan.txt'), 'must not survive', 'utf-8');
    const transactionId = 'both-roots-commit';
    const trashPath = join(configDir, '.trash', transactionId);
    const journalSnapshot = readDeleteJournalSnapshot(configDir, created.id);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    renameSync(sessionRootPath, join(trashPath, 'sessions'));
    const configPath = join(configDir, 'config.json');
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
    };
    registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'roots-staged',
      participantIds: [],
      ...journalSnapshot,
    }), 'utf-8');

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    await recovered.list();

    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(sessionRootPath)).toBe(false);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('restores the ref and managed root when staged cleanup cannot commit', async () => {
    const configDir = makeConfigDir();
    let released = false;
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      quiescence: {
        async acquire() {
          return { release: async () => { released = true; } };
        },
      },
      cleanupParticipants: [{
        id: 'runtime',
        async stage() {},
        async commit() { throw new Error('commit failed'); },
        async rollback() {},
      }],
    });
    const created = await service.create({ name: 'Rollback Me' });
    const rootPath = service.resolve(created.id).workspaceRootPath;

    const result = await service.delete(created.id);

    expect(result.deleted).toBe(false);
    expect(result.cleanupFailures[0]?.code).toBe('workspace-delete-failed');
    expect(existsSync(rootPath)).toBe(true);
    expect(service.resolve(created.id).id).toBe(created.id);
    expect(released).toBe(true);
  });

  it('preserves staged data when a rollback cannot restore the managed root', async () => {
    const configDir = makeConfigDir();
    let rootPath = '';
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      quiescence: { async acquire() { return { release: async () => {} }; } },
      cleanupParticipants: [{
        id: 'runtime',
        async stage() {},
        async commit() {
          mkdirSync(rootPath, { recursive: true });
          throw new Error('commit failed');
        },
        async rollback() {},
      }],
    });
    const created = await service.create({ name: 'Preserve Staged Data' });
    rootPath = service.resolve(created.id).workspaceRootPath;

    const result = await service.delete(created.id);
    const entries = readdirSync(join(configDir, '.trash'), { withFileTypes: true })
      .filter(entry => entry.isDirectory());
    const entry = entries[0];

    expect(result.deleted).toBe(false);
    expect(entry).toBeDefined();
    if (!entry) throw new Error('Expected staged delete journal');
    expect(existsSync(join(configDir, '.trash', entry.name, 'workspace', 'config.json'))).toBe(true);
  });

  it('recovers a roots-staged delete journal before resolving registered data', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await service.create({ name: 'Interrupted Delete' });
    const rootPath = service.resolve(created.id).workspaceRootPath;
    const transactionId = 'delete-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    const stagedWorkspacePath = join(trashPath, 'workspace');
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, stagedWorkspacePath);
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'roots-staged',
      participantIds: [],
      ...readDeleteJournalSnapshot(configDir, created.id),
      workspaceRootPath: rootPath,
      sessionRootPath: join(rootPath, 'sessions'),
    }), 'utf-8');

    const recovered = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });

    await recovered.list();
    expect(recovered.resolve(created.id).workspaceRootPath).toBe(rootPath);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('rolls back staged participants from a quiesced delete journal', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Quiesced Recovery' });
    const transactionId = 'quiesced-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'quiesced',
      participantIds: ['plugin-data'],
      ...readDeleteJournalSnapshot(configDir, created.id),
    }), 'utf-8');
    const calls: string[] = [];

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit(transaction) { calls.push(`commit:${transaction}`); },
        async rollback(transaction) { calls.push(`rollback:${transaction}`); },
      }],
    });
    await recovered.list();

    expect(calls).toEqual([`rollback:${transactionId}`]);
    expect(recovered.resolve(created.id).id).toBe(created.id);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('does not resolve a workspace while its participant recovery is pending', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Pending Recovery' });
    const transactionId = 'pending-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    let finishRollback: () => void = () => {};
    const rollbackPending = new Promise<void>(resolve => { finishRollback = resolve; });
    mkdirSync(trashPath, { recursive: true });
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'quiesced',
      participantIds: ['plugin-data'],
      ...readDeleteJournalSnapshot(configDir, created.id),
    }), 'utf-8');

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit() {},
        async rollback() { await rollbackPending; },
      }],
    });

    expect(() => recovered.resolve(created.id)).toThrow('Workspace delete recovery is in progress');
    finishRollback();
    await recovered.list();
    expect(recovered.resolve(created.id).id).toBe(created.id);
  });

  it('does not resolve a workspace after its participant recovery fails', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Failed Recovery' });
    const transactionId = 'failed-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'quiesced',
      participantIds: ['plugin-data'],
      ...readDeleteJournalSnapshot(configDir, created.id),
    }), 'utf-8');

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit() {},
        async rollback() { throw new Error('rollback failed'); },
      }],
    });

    await expect(recovered.list()).rejects.toThrow('rollback failed');
    expect(() => recovered.resolve(created.id)).toThrow('rollback failed');
  });

  it('reports unavailable credential cleanup without claiming it ran', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      quiescence: { async acquire() { return { release: async () => {} }; } },
    });
    const created = await service.create({ name: 'Credential Cleanup' });

    const result = await service.delete(created.id);

    expect(result.deleted).toBe(true);
    expect(result.cleanupFailures).toEqual([{
      resource: 'credentials',
      code: 'credential-cleanup-unavailable',
      message: 'Workspace cleanup did not complete.',
    }]);
  });

  it('keeps a committed delete truthful when releasing its lease fails', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: {
        list: async () => [],
        deleteWorkspaceCredentials: async () => {},
      },
      quiescence: {
        async acquire() {
          return { release: async () => { throw new Error('release failed'); } };
        },
      },
    });
    const created = await service.create({ name: 'Lease Release' });

    const result = await service.delete(created.id);

    expect(result.deleted).toBe(true);
    expect(result.cleanupFailures).toEqual([{
      resource: 'runtime',
      code: 'quiescence-release-failed',
      message: 'Workspace cleanup did not complete.',
    }]);
  });

  it('returns the created WorkspaceInfo when registry rename commits before parent fsync fails', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [] },
      configWriteFailpoint: step => {
        if (step === 'after-rename') throw new Error('parent fsync failed');
      },
    });

    const info = await service.create({ name: 'Committed Registry' });
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')) as {
      workspaceRefs: Array<{ id: string }>;
    };
    const id = config.workspaceRefs[0]?.id;

    expect(typeof id).toBe('string');
    if (!id) throw new Error('Expected committed registry ref');
    expect(info.id).toBe(id);
    expect(existsSync(join(configDir, 'workspaces', id!))).toBe(true);
    expect(createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }).resolve(id).id).toBe(id);
    await expect(createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }).create({ name: 'Committed Registry' })).rejects.toThrow('Workspace name already exists');
  });

  it('treats a post-rename registry removal as committed deletion', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Committed Delete' });
    const service = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      quiescence: { async acquire() { return { release: async () => {} }; } },
      configWriteFailpoint: step => {
        if (step === 'after-rename') throw new Error('registry parent fsync failed');
      },
    });

    const result = await service.delete(created.id);

    expect(result.deleted).toBe(true);
    expect(result.cleanupFailures).toEqual([{
      resource: 'runtime',
      code: 'registry-parent-sync-failed',
      message: 'Workspace cleanup did not complete.',
    }]);
    expect(() => service.resolve(created.id)).toThrow('Workspace is not registered');
  });

  it('finishes a roots-staged journal when its registry ref was already removed', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Roots Staged Committed' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const transactionId = 'roots-staged-committed';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    const configPath = join(configDir, 'config.json');
    const journalSnapshot = readDeleteJournalSnapshot(configDir, created.id);
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
    };
    registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'roots-staged',
      participantIds: [],
      ...journalSnapshot,
    }), 'utf-8');

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    await recovered.list();

    expect(() => recovered.resolve(created.id)).toThrow('Workspace is not registered');
    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('finishes a registry-removed journal through its staged participant', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Participant Recovery' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const transactionId = 'participant-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    const configPath = join(configDir, 'config.json');
    const journalSnapshot = readDeleteJournalSnapshot(configDir, created.id);
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
    };
    registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'registry-removed',
      participantIds: ['plugin-data'],
      ...journalSnapshot,
    }), 'utf-8');
    const calls: string[] = [];

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit(transaction) { calls.push(`commit:${transaction}`); },
        async rollback(transaction) { calls.push(`rollback:${transaction}`); },
      }],
    });
    await recovered.list();

    expect(calls).toEqual([`commit:${transactionId}`]);
    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('compensates a partial recovered participant commit and resumes the workspace', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Compensated Recovery' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const transactionId = 'compensated-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    const configPath = join(configDir, 'config.json');
    const journalSnapshot = readDeleteJournalSnapshot(configDir, created.id);
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
    };
    registry.workspaceRefs = registry.workspaceRefs.filter(candidate => candidate.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'registry-removed',
      participantIds: ['plugin-data', 'capability-policy'],
      ...journalSnapshot,
    }), 'utf-8');
    const calls: string[] = [];

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit(transaction) { calls.push(`commit:plugin-data:${transaction}`); },
        async rollback(transaction) { calls.push(`rollback:plugin-data:${transaction}`); },
      }, {
        id: 'capability-policy',
        async stage() {},
        async commit(transaction) {
          calls.push(`commit:capability-policy:${transaction}`);
          throw new Error('second participant failed');
        },
        async rollback(transaction) { calls.push(`rollback:capability-policy:${transaction}`); },
      }],
    });

    expect((await recovered.list()).map(workspace => workspace.id)).toEqual([created.id]);
    expect(calls).toEqual([
      `commit:plugin-data:${transactionId}`,
      `commit:capability-policy:${transactionId}`,
      `rollback:capability-policy:${transactionId}`,
      `rollback:plugin-data:${transactionId}`,
    ]);
    expect(recovered.resolve(created.id).workspaceRootPath).toBe(rootPath);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('fails closed when rollback registry durability is unconfirmed', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Unconfirmed Rollback Registry' });
    const trashPath = stageCommittedDeleteJournal(
      configDir,
      created.id,
      setup.resolve(created.id).workspaceRootPath,
      'unconfirmed-rollback-registry',
      'registry-removed',
      ['plugin-data'],
    );
    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit() { throw new Error('participant commit failed'); },
        async rollback() {},
      }],
      configWriteFailpoint: step => {
        if (step === 'after-rename') throw new Error('parent fsync failed');
      },
    });

    await expect(recovered.list()).rejects.toThrow('Workspace registry recovery durability is unconfirmed');
    expect(() => recovered.resolve(created.id)).toThrow('Workspace registry recovery durability is unconfirmed');
    expect(existsSync(trashPath)).toBe(true);
  });

  it('removes a cleanup-committed journal without replaying participants', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
    });
    const created = await setup.create({ name: 'Committed Cleanup Recovery' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const transactionId = 'cleanup-committed-recovery';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    const configPath = join(configDir, 'config.json');
    const journalSnapshot = readDeleteJournalSnapshot(configDir, created.id);
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      workspaceRefs: Array<{ id: string; lastAccessedAt: number }>;
    };
    registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'cleanup-committed',
      participantIds: ['plugin-data'],
      ...journalSnapshot,
    }), 'utf-8');
    const calls: string[] = [];

    const recovered = createWorkspaceService({
      configDir,
      credentialManager: { list: async () => [], deleteWorkspaceCredentials: async () => {} },
      cleanupParticipants: [{
        id: 'plugin-data',
        async stage() {},
        async commit(transaction) { calls.push(`commit:${transaction}`); },
        async rollback(transaction) { calls.push(`rollback:${transaction}`); },
      }],
    });
    await recovered.list();

    expect(calls).toEqual([]);
    expect(existsSync(rootPath)).toBe(false);
    expect(existsSync(trashPath)).toBe(false);
  });

  it('retains a zero-participant cleanup journal when credential cleanup is unavailable', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Unavailable Recovery Credentials' });
    const trashPath = stageCommittedDeleteJournal(
      configDir,
      created.id,
      setup.resolve(created.id).workspaceRootPath,
      'unavailable-recovery-credentials',
      'cleanup-committed',
      [],
    );
    const recovered = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });

    expect(() => recovered.resolve(created.id)).toThrow('Workspace delete recovery is in progress');
    await expect(recovered.list()).rejects.toThrow('Workspace credential cleanup is unavailable during recovery');
    expect(() => recovered.resolve(created.id)).toThrow('Workspace credential cleanup is unavailable during recovery');
    expect(existsSync(trashPath)).toBe(true);
  });

  it('retains a committed cleanup journal when credential cleanup fails', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Failed Recovery Credentials' });
    const trashPath = stageCommittedDeleteJournal(
      configDir,
      created.id,
      setup.resolve(created.id).workspaceRootPath,
      'failed-recovery-credentials',
      'cleanup-committed',
      [],
    );
    const recovered = createWorkspaceService({
      configDir,
      credentialManager: {
        list: async () => [],
        deleteWorkspaceCredentials: async () => { throw new Error('credential delete failed'); },
      },
    });

    await expect(recovered.list()).rejects.toThrow('Workspace credential cleanup failed during recovery');
    expect(existsSync(trashPath)).toBe(true);
  });

  it('fails closed when a rollback journal omits restoration metadata', async () => {
    for (const omitted of ['ref', 'refIndex', 'wasActive'] as const) {
      const configDir = makeConfigDir();
      const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
      const created = await setup.create({ name: `Missing ${omitted}` });
      const transactionId = `missing-${omitted}`;
      const trashPath = join(configDir, '.trash', transactionId);
      const snapshot = readDeleteJournalSnapshot(configDir, created.id);
      mkdirSync(trashPath, { recursive: true });
      renameSync(setup.resolve(created.id).workspaceRootPath, join(trashPath, 'workspace'));
      const journal: Record<string, unknown> = {
        transactionId,
        workspaceId: created.id,
        phase: 'roots-staged',
        participantIds: [],
        ...snapshot,
      };
      delete journal[omitted];
      writeFileSync(join(trashPath, 'journal.json'), JSON.stringify(journal), 'utf-8');

      expect(() => createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }))
        .toThrow('Workspace delete journal is corrupt');
    }
  });

  it('fails closed when a committed recovery journal omits participant identities', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Missing Participants' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const transactionId = 'missing-participants';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    const configPath = join(configDir, 'config.json');
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as { workspaceRefs: Array<{ id: string }> };
    registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'registry-removed',
    }), 'utf-8');

    expect(() => createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }))
      .toThrow('Workspace delete journal is corrupt');
  });

  it('fails closed when a committed recovery journal lacks its registry snapshot', async () => {
    const configDir = makeConfigDir();
    const setup = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await setup.create({ name: 'Missing Recovery Ref' });
    const rootPath = setup.resolve(created.id).workspaceRootPath;
    const transactionId = 'missing-recovery-ref';
    const trashPath = join(configDir, '.trash', transactionId);
    mkdirSync(trashPath, { recursive: true });
    renameSync(rootPath, join(trashPath, 'workspace'));
    const configPath = join(configDir, 'config.json');
    const registry = JSON.parse(readFileSync(configPath, 'utf-8')) as { workspaceRefs: Array<{ id: string }> };
    registry.workspaceRefs = registry.workspaceRefs.filter(ref => ref.id !== created.id);
    writeFileSync(configPath, JSON.stringify(registry), 'utf-8');
    writeFileSync(join(trashPath, 'journal.json'), JSON.stringify({
      transactionId,
      workspaceId: created.id,
      phase: 'roots-staged',
      participantIds: [],
    }), 'utf-8');

    expect(() => createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }))
      .toThrow('Workspace delete journal is corrupt');
  });

  it('projects remote binding metadata without its token', async () => {
    const configDir = makeConfigDir();
    const service = createWorkspaceService({ configDir, credentialManager: { list: async () => [] } });
    const created = await service.create({ name: 'Remote Binding' });
    const resolved = service.resolve(created.id);
    saveWorkspaceConfig(resolved.workspaceRootPath, {
      ...resolved.config,
      remoteServer: {
        url: 'wss://remote.example.test',
        remoteWorkspaceId: 'remote-1',
      },
    });

    const info = (await service.list())[0]!;
    const clientInfo: WorkspaceInfo = {
      id: 'client',
      name: 'Client',
      remoteServer: { url: 'wss://remote.example.test', remoteWorkspaceId: 'remote-1' },
    };
    const invalidClientInfo: WorkspaceInfo = {
      id: 'invalid',
      name: 'Invalid',
      slug: '',
      remoteServer: {
        url: 'wss://remote.example.test',
        remoteWorkspaceId: 'remote-1',
        // @ts-expect-error remote tokens are server-only
        token: 'secret-token',
      },
    };
    void invalidClientInfo;

    expect(info.remoteServer).toEqual({ url: 'wss://remote.example.test', remoteWorkspaceId: 'remote-1' });
    expect(JSON.stringify(info)).not.toContain('secret-token');
    expect(JSON.stringify(clientInfo)).not.toContain('token');
  });

  it('fails closed on duplicate refs and invalid last-accessed timestamps', () => {
    const configDir = makeConfigDir();
    const configPath = join(configDir, 'config.json');
    const writeRegistry = (workspaceRefs: unknown) => writeFileSync(configPath, JSON.stringify({
      activeWorkspaceId: null,
      activeSessionId: null,
      workspaceRefs,
    }), 'utf-8');

    writeRegistry([
      { id: 'ws_1', lastAccessedAt: 1 },
      { id: 'ws_1', lastAccessedAt: 2 },
    ]);
    expect(() => createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }).resolve('ws_1')).toThrow('Workspace registry is corrupt');

    for (const lastAccessedAt of [-1, 1.5]) {
      writeRegistry([{ id: 'ws_1', lastAccessedAt }]);
      expect(() => createWorkspaceService({ configDir, credentialManager: { list: async () => [] } }).resolve('ws_1')).toThrow('Workspace registry is corrupt');
    }
  });

  it('preserves the prior registry file through every pre-rename interrupted write', () => {
    const configDir = makeConfigDir();
    const configPath = join(configDir, 'config.json');
    const previous = '{"workspaceRefs":[]}';
    const next = '{"workspaceRefs":[{"id":"ws_1","lastAccessedAt":1}]}';

    for (const failpoint of ['before-temp-write', 'after-temp-write', 'after-file-sync', 'before-rename'] as const) {
      writeFileSync(configPath, previous, 'utf-8');
      expect(() => atomicWriteConfigFileSync(configPath, next, step => {
        if (step === failpoint) throw new Error(failpoint);
      })).toThrow(failpoint);
      expect(readFileSync(configPath, 'utf-8')).toBe(previous);
    }
  });
});
