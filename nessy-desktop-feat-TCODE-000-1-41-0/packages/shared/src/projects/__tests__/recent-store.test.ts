import { afterEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerifiedStorageLayoutV2 } from '../../workspaces/storage-readiness.ts';
import { ProjectTrustStore } from '../../capabilities/project-trust-store.ts';
import { ProjectHandleService, type ResolvedProjectHandle } from '../project-handle-service.ts';
import {
  RecentProjectStore,
  RecentProjectStoreError,
  type RecentProjectDiagnostic,
} from '../recent-store.ts';

const LAYOUT: VerifiedStorageLayoutV2 = {
  storageLayoutVersion: 2,
  verificationId: 'recent-project-test',
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function projectDirectory(name = 'project'): string {
  const path = join(tempRoot('recent-project-'), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function handleService(
  ino: { value: bigint } = { value: 42n },
  options: { processOnly?: boolean; managedRootPaths?: string[] } = {},
): ProjectHandleService {
  const trustRoot = tempRoot('recent-trust-');
  return new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(trustRoot, 'project-trust.json') }),
    ...(options.managedRootPaths ? { managedRootPaths: options.managedRootPaths } : {}),
    identityOptions: {
      realpathSync: path => path,
      statSync: () => options.processOnly
        ? { dev: 0n, ino: 0n }
        : { dev: 1n, ino: ino.value },
      processSalt: 'recent-test',
    },
  });
}

async function resolvedProject(
  service: ProjectHandleService,
  workspaceId: string,
  path: string,
): Promise<ResolvedProjectHandle> {
  const issued = await service.validateProjectDirectory(workspaceId, path);
  const resolved = await service.resolveHandle({ workspaceId, projectHandleId: issued.id });
  expect(resolved).not.toBeNull();
  return resolved!;
}

describe('RecentProjectStore', () => {
  it('requires verified v2 readiness and starts empty without importing adjacent history', () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    writeFileSync(join(root, 'recent-working-dirs.json'), JSON.stringify(['/legacy/path']));

    expect(() => new RecentProjectStore(undefined as never, { filePath }))
      .toThrow('verified-storage-layout-required');

    const store = new RecentProjectStore(LAYOUT, { filePath });
    expect(store.listRecentProjects('ws-1')).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  it('persists a validated external project under an opaque id and emits only a safe summary', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const service = handleService();
    const projectPath = projectDirectory();
    const project = await resolvedProject(service, 'ws-1', projectPath);
    const store = new RecentProjectStore(LAYOUT, {
      filePath,
      now: () => 123,
      newId: () => 'recent-opaque-1',
    });

    const summary = store.recordValidatedProject(project);
    expect(summary).toEqual({ id: 'recent-opaque-1', displayPath: projectPath, lastUsedAt: 123 });
    expect(store.listRecentProjects('ws-1')).toEqual([summary]);
    expect(store.listRecentProjects('ws-2')).toEqual([]);

    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      version: number;
      records: Array<Record<string, unknown>>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.records).toEqual([{
      id: 'recent-opaque-1',
      workspaceId: 'ws-1',
      workingDirectory: projectPath,
      projectKey: project.projectKey,
      lastUsedAt: 123,
    }]);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('never persists a process-only project key', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const service = handleService({ value: 0n }, { processOnly: true });
    const project = await resolvedProject(service, 'ws-1', projectDirectory());
    const store = new RecentProjectStore(LAYOUT, { filePath, newId: () => 'recent-process' });

    store.recordValidatedProject(project);

    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    };
    expect(persisted.records[0]).not.toHaveProperty('projectKey');
  });

  it('revalidates a stale key hint, quarantines the old record and issues an unknown handle for the replacement', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const diagnostics: RecentProjectDiagnostic[] = [];
    const ino = { value: 42n };
    let now = 100;
    const service = handleService(ino);
    const original = await resolvedProject(service, 'ws-1', projectDirectory());
    await service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: original.id }, 'trusted');
    const store = new RecentProjectStore(LAYOUT, {
      filePath,
      now: () => now,
      newId: () => 'recent-stale',
      quarantineId: () => 'quarantine-1',
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    });
    const summary = store.recordValidatedProject(original);
    const oldProjectKey = original.projectKey;

    ino.value = 99n;
    now = 200;
    const issued = await store.issueRecentProjectHandle({
      workspaceId: 'ws-1',
      recentProjectId: summary.id,
    }, service);

    expect(issued.trustState).toBe('unknown');
    expect(diagnostics).toEqual([{ code: 'recent-project-stale', recentProjectId: summary.id }]);
    expect(JSON.stringify(diagnostics)).not.toContain(original.canonicalPath);
    expect(readdirSync(root).some(name => name.includes('quarantine-1'))).toBe(true);
    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      records: Array<{ projectKey?: string; lastUsedAt: number }>;
    };
    expect(persisted.records[0]?.projectKey).not.toBe(oldProjectKey);
    expect(persisted.records[0]?.lastUsedAt).toBe(200);
  });

  it('rejects an identity-changed stored default instead of following the replacement', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const ino = { value: 42n };
    const service = handleService(ino);
    const original = await resolvedProject(service, 'ws-1', projectDirectory());
    const store = new RecentProjectStore(LAYOUT, {
      filePath,
      newId: () => 'recent-default',
      quarantineId: () => 'quarantine-default',
    });
    const summary = store.recordValidatedProject(original);

    ino.value = 99n;
    const attempt = store.issueDefaultProjectHandle({
      workspaceId: 'ws-1',
      recentProjectId: summary.id,
    }, service);

    await expect(attempt).rejects.toMatchObject({ code: 'recent-project-stale' });
    expect(store.listRecentProjects('ws-1')).toEqual([]);
  });

  // Compat guard for the glossary.md:231 home carve-out: a record written
  // while the directory resolved stable (pre-carve-out $HOME) keeps working
  // once the same directory resolves process-only — the stored key can never
  // match a per-process salted key, and that is key omission, not an identity
  // change.
  it('does not quarantine or reject a stored key once the directory resolves process-only', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const diagnostics: RecentProjectDiagnostic[] = [];
    const projectPath = projectDirectory('home');
    // Pre-carve-out state: the directory resolved stable, so the record holds a key.
    const stableService = handleService();
    const original = await resolvedProject(stableService, 'ws-1', projectPath);
    const store = new RecentProjectStore(LAYOUT, {
      filePath,
      newId: () => 'recent-home',
      quarantineId: () => 'quarantine-home',
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    });
    const summary = store.recordValidatedProject(original);
    expect(
      (JSON.parse(readFileSync(filePath, 'utf8')) as { records: Array<Record<string, unknown>> })
        .records[0],
    ).toHaveProperty('projectKey');

    // Post-carve-out: the same directory is now the home directory, so its
    // identity resolves process-only and the stored key can never match again.
    const homeService = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: join(tempRoot('recent-trust-'), 'project-trust.json') }),
      identityOptions: {
        realpathSync: path => path,
        statSync: () => ({ dev: 1n, ino: 42n }),
        processSalt: 'recent-test',
        homeDir: realpathSync(projectPath),
      },
    });

    // Even the rejectIdentityChange path (stored default project) must not throw...
    const issued = await store.issueDefaultProjectHandle({
      workspaceId: 'ws-1',
      recentProjectId: summary.id,
    }, homeService);

    expect(issued.trustState).toBe('unknown');
    // ...no quarantine, no stale diagnostic...
    expect(diagnostics).toEqual([]);
    expect(readdirSync(root).some(name => name.includes('quarantine'))).toBe(false);
    // ...and the record self-heals to key-less instead of being removed.
    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    };
    expect(persisted.records[0]).not.toHaveProperty('projectKey');
    expect(store.listRecentProjects('ws-1')).toHaveLength(1);
  });

  it('quarantines a vanished recent entry, removes it and returns only a safe error code', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const diagnostics: RecentProjectDiagnostic[] = [];
    const service = handleService();
    const projectPath = projectDirectory();
    const project = await resolvedProject(service, 'ws-1', projectPath);
    const store = new RecentProjectStore(LAYOUT, {
      filePath,
      newId: () => 'recent-vanished',
      quarantineId: () => 'quarantine-missing',
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    });
    const summary = store.recordValidatedProject(project);
    rmSync(projectPath, { recursive: true, force: true });

    const attempt = store.issueRecentProjectHandle({
      workspaceId: 'ws-1',
      recentProjectId: summary.id,
    }, service);
    await expect(attempt).rejects.toBeInstanceOf(RecentProjectStoreError);
    await expect(attempt).rejects.toMatchObject({ code: 'recent-project-stale' });
    expect(store.listRecentProjects('ws-1')).toEqual([]);
    expect(diagnostics).toEqual([{ code: 'recent-project-stale', recentProjectId: summary.id }]);
    expect(JSON.stringify(diagnostics)).not.toContain(projectPath);
  });

  it('quarantines a corrupt store and resumes from an empty safe state', () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const diagnostics: RecentProjectDiagnostic[] = [];
    writeFileSync(filePath, '{"version":1,"records":[', { mode: 0o600 });

    const store = new RecentProjectStore(LAYOUT, {
      filePath,
      quarantineId: () => 'corrupt-1',
      onDiagnostic: diagnostic => diagnostics.push(diagnostic),
    });

    expect(store.listRecentProjects('ws-1')).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(root).some(name => name.includes('corrupt-1'))).toBe(true);
    expect(diagnostics).toEqual([{ code: 'recent-project-store-corrupt' }]);
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });

  /**
   * P6.800 — a permanent worktree appears as its own project root.
   *
   * Measured at HEAD before this was written: `recordValidatedProject` is called
   * from three sites, all of them behind `mutateWorkingDirectory`'s
   * `intent: 'bind'` (or `setWorkspaceDefaultProject`), while the worktree
   * create path mutates with `intent: 'keep'` and resolves no project at all —
   * so a worktree's directory never reached this store, and a permanent one
   * (P6.336 (b): exempt from the sweep BY NAME) was kept and reachable only
   * through the session that made it.
   */
  it('records a directory as its own project root, validating it like any other', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const service = handleService();
    // A worktree is a DIRECTORY; nothing about worktrees is encoded in the store.
    const worktreePath = projectDirectory('worktrees-permanent-feature');
    const store = new RecentProjectStore(LAYOUT, {
      filePath, now: () => 555, newId: () => 'recent-worktree-1',
    });

    const summary = await store.recordProjectDirectory(
      { workspaceId: 'ws-1', directory: worktreePath }, service,
    );

    // Reachable from the picker, which lists exactly this.
    expect(summary).toEqual({ id: 'recent-worktree-1', displayPath: worktreePath, lastUsedAt: 555 });
    expect(store.listRecentProjects('ws-1')).toEqual([summary!]);
    // ...and it went through the SAME validation, so the record carries the
    // stable project key rather than a path someone asserted was a project.
    const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as {
      records: Array<Record<string, unknown>>;
    };
    expect(persisted.records).toHaveLength(1);
    expect(typeof persisted.records[0]!.projectKey).toBe('string');
    // Recording the same directory twice keeps one record, exactly as the
    // validated-project path does: re-entering a worktree is the normal case.
    await store.recordProjectDirectory({ workspaceId: 'ws-1', directory: worktreePath }, service);
    expect(store.listRecentProjects('ws-1')).toHaveLength(1);
  });

  it('refuses what the handle service refuses, and never throws', async () => {
    // The negative arm, and the reason the method is total: registering a
    // project is a convenience on top of creating a worktree, so a refusal must
    // return "not recorded" rather than take the worktree down with it.
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    const managedRoot = tempRoot('recent-managed-');
    const managed = join(managedRoot, 'inside');
    mkdirSync(managed, { recursive: true });
    const service = handleService({ value: 42n }, { managedRootPaths: [managedRoot] });
    const store = new RecentProjectStore(LAYOUT, { filePath });

    // A managed root is never a valid external project...
    expect(await store.recordProjectDirectory(
      { workspaceId: 'ws-1', directory: managed }, service,
    )).toBeNull();
    // ...nor is a path that does not exist, nor a malformed workspace id.
    expect(await store.recordProjectDirectory(
      { workspaceId: 'ws-1', directory: join(managedRoot, 'nope', 'gone') }, service,
    )).toBeNull();
    expect(await store.recordProjectDirectory(
      { workspaceId: '../escape', directory: projectDirectory('ok') }, service,
    )).toBeNull();
    // Nothing was written, and the store still works afterwards — the positive
    // control that the refusals above are refusals and not a broken store.
    expect(store.listRecentProjects('ws-1')).toEqual([]);
    const good = handleService();
    expect(await store.recordProjectDirectory(
      { workspaceId: 'ws-1', directory: projectDirectory('good') }, good,
    )).not.toBeNull();
  });

  it('provides the recent-projects Workspace cleanup participant', async () => {
    const root = tempRoot('recent-store-');
    const filePath = join(root, 'recent-projects.json');
    let id = 0;
    const store = new RecentProjectStore(LAYOUT, { filePath, newId: () => `recent-${++id}` });
    const service = handleService();
    store.recordValidatedProject(await resolvedProject(service, 'ws-1', projectDirectory('one')));
    store.recordValidatedProject(await resolvedProject(service, 'ws-2', projectDirectory('two')));
    const participant = store.cleanupParticipant();

    expect(participant.id).toBe('recent-projects');
    await participant.stage('ws-1', 'txn-1');
    await participant.commit('txn-1');

    expect(store.listRecentProjects('ws-1')).toEqual([]);
    expect(store.listRecentProjects('ws-2')).toHaveLength(1);
    await participant.rollback('txn-1');
    expect(store.listRecentProjects('ws-2')).toHaveLength(1);
  });
});
