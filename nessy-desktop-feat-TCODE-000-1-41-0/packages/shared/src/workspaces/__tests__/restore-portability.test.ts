import { afterEach, describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const READINESS_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage-readiness.ts')).href;
const WORKSPACE_SERVICE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'service.ts')).href;
const SESSION_STORE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'sessions', 'store-v2.ts')).href;
const PROJECT_HANDLE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'projects', 'project-handle-service.ts')).href;
const RECENT_PROJECT_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'projects', 'recent-store.ts')).href;
const PATHS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'config', 'paths.ts')).href;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function child(configRoot: string, profile: string, body: string): Record<string, unknown> {
  const childTmp = join(profile, 'tmp');
  mkdirSync(childTmp, { recursive: true });
  const result = Bun.spawnSync([process.execPath, '--eval', body], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: profile,
      USERPROFILE: profile,
      CFFIXED_USER_HOME: profile,
      TMPDIR: childTmp,
      NESSY_CONFIG_DIR: configRoot,
      NESSY_DP_AUTH_TOKEN: '',
      DP_AUTH_TOKEN: '',
      NESTOR_TOKEN: '',
      RUN_LIVE_TESTS: '0',
      NESSY_RUN_LIVE_TESTS: '0',
      LIVE_GATEWAY_TESTS: '0',
      NESSY_FEATURE_PROVIDER_CLAUDE: '0',
      NESSY_FEATURE_PROVIDER_CHATGPT: '0',
      NESSY_FEATURE_CODEX_RUNTIME: '0',
      NESSY_FEATURE_PROVIDER_LOCAL: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `restore child exited ${result.exitCode}`);
  }
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

describe('portable v2 restore', () => {
  it('reopens a copied CONFIG_DIR under a different root and revalidates project/session identity', () => {
    const profileA = tempRoot('nessy-restore-profile-a-');
    const profileB = tempRoot('nessy-restore-profile-b-');
    const configRootA = join(profileA, '.nessy-agent');
    const configRootB = join(profileB, '.nessy-agent');
    const externalProject = tempRoot('nessy-restore-project-');
    mkdirSync(externalProject, { recursive: true });
    writeFileSync(join(externalProject, 'sentinel.txt'), 'external-project-unchanged');

    const seed = child(configRootA, profileA, `
      import { join } from 'node:path';
      import { ensureStorageLayoutV2 } from '${READINESS_MODULE}';
      import { createWorkspaceService } from '${WORKSPACE_SERVICE_MODULE}';
      import { createSessionStore } from '${SESSION_STORE_MODULE}';
      import { ProjectHandleService } from '${PROJECT_HANDLE_MODULE}';
      import { RecentProjectStore } from '${RECENT_PROJECT_MODULE}';
      import { CONFIG_DIR } from '${PATHS_MODULE}';

      const readiness = await ensureStorageLayoutV2({ assertHeld() {} });
      if (readiness.status === 'blocked') throw new Error(readiness.code);
      const workspaces = createWorkspaceService({
        configDir: CONFIG_DIR,
        credentialManager: { list: async () => [] },
      });
      const workspace = await workspaces.create({ name: 'Portable Workspace' });
      const resolvedWorkspace = workspaces.resolve(workspace.id);
      const sessions = createSessionStore(readiness.layout);
      const parent = await sessions.create(workspace.id, {
        sessionId: 'parent-session',
        workingDirectory: ${JSON.stringify(externalProject)},
      });
      const branch = await sessions.create(workspace.id, {
        sessionId: 'branch-session',
        workingDirectory: ${JSON.stringify(externalProject)},
        branchFrom: {
          parent: { workspaceId: workspace.id, sessionId: parent.id },
          messageId: 'message-1',
        },
      });
      const handles = new ProjectHandleService({
        newId: () => 'seed-project-handle',
        managedRootPaths: [CONFIG_DIR],
      });
      const issued = await handles.validateProjectDirectory(workspace.id, ${JSON.stringify(externalProject)});
      const project = await handles.resolveHandle({ workspaceId: workspace.id, projectHandleId: issued.id });
      if (!project) throw new Error('seed-project-missing');
      const recents = new RecentProjectStore(readiness.layout, {
        filePath: join(CONFIG_DIR, 'recent-projects.json'),
        newId: () => 'recent-project',
      });
      const recent = recents.recordValidatedProject(project);
      console.log(JSON.stringify({
        readiness: readiness.status,
        configDir: CONFIG_DIR,
        workspaceId: workspace.id,
        workspaceRootPath: resolvedWorkspace.workspaceRootPath,
        sessionRootPath: resolvedWorkspace.sessionRootPath,
        parentId: parent.id,
        branchId: branch.id,
        branchFrom: branch.branchFrom,
        recent,
        projectKey: project.projectKey,
      }));
    `);

    cpSync(configRootA, configRootB, { recursive: true, preserveTimestamps: true });

    const restored = child(configRootB, profileB, `
      import { join } from 'node:path';
      import { ensureStorageLayoutV2 } from '${READINESS_MODULE}';
      import { createWorkspaceService } from '${WORKSPACE_SERVICE_MODULE}';
      import { createSessionStore } from '${SESSION_STORE_MODULE}';
      import { ProjectHandleService } from '${PROJECT_HANDLE_MODULE}';
      import { RecentProjectStore } from '${RECENT_PROJECT_MODULE}';
      import { CONFIG_DIR } from '${PATHS_MODULE}';

      const readiness = await ensureStorageLayoutV2({ assertHeld() {} });
      if (readiness.status === 'blocked') throw new Error(readiness.code);
      const workspaceId = ${JSON.stringify(seed.workspaceId)};
      const workspaces = createWorkspaceService({
        configDir: CONFIG_DIR,
        credentialManager: { list: async () => [] },
      });
      const resolvedWorkspace = workspaces.resolve(workspaceId);
      const sessions = createSessionStore(readiness.layout);
      const parent = sessions.load({ workspaceId, sessionId: 'parent-session' });
      const branch = sessions.load({ workspaceId, sessionId: 'branch-session' });
      const handles = new ProjectHandleService({
        newId: () => 'restored-project-handle',
        managedRootPaths: [CONFIG_DIR],
      });
      const recents = new RecentProjectStore(readiness.layout, {
        filePath: join(CONFIG_DIR, 'recent-projects.json'),
      });
      const recent = recents.listRecentProjects(workspaceId)[0];
      if (!recent) throw new Error('recent-project-missing');
      const issued = await recents.issueRecentProjectHandle({
        workspaceId,
        recentProjectId: recent.id,
      }, handles);
      const project = await handles.resolveHandle({ workspaceId, projectHandleId: issued.id });
      if (!project) throw new Error('restored-project-missing');
      console.log(JSON.stringify({
        readiness: readiness.status,
        configDir: CONFIG_DIR,
        workspaceRootPath: resolvedWorkspace.workspaceRootPath,
        sessionRootPath: resolvedWorkspace.sessionRootPath,
        parentId: parent?.id,
        branchId: branch?.id,
        branchFrom: branch?.branchFrom,
        parentPath: sessions.getSessionPath({ workspaceId, sessionId: 'parent-session' }),
        branchPath: sessions.getSessionPath({ workspaceId, sessionId: 'branch-session' }),
        recent,
        handleId: issued.id,
        trustState: issued.trustState,
        projectKey: project.projectKey,
      }));
    `);

    expect(seed.readiness).toBe('initialized');
    expect(seed.configDir).toBe(configRootA);
    expect(seed.workspaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(seed.branchFrom).toEqual({
      parent: { workspaceId: seed.workspaceId, sessionId: 'parent-session' },
      messageId: 'message-1',
    });

    expect(restored.readiness).toBe('ready');
    expect(restored.configDir).toBe(configRootB);
    for (const path of [
      restored.workspaceRootPath,
      restored.sessionRootPath,
      restored.parentPath,
      restored.branchPath,
    ]) {
      expect(path).toBeString();
      expect(path as string).toStartWith(configRootB);
      expect(path as string).not.toContain(configRootA);
    }
    expect(restored.parentId).toBe('parent-session');
    expect(restored.branchId).toBe('branch-session');
    expect(restored.branchFrom).toEqual(seed.branchFrom);
    expect(restored.recent).toEqual(seed.recent);
    expect(restored.handleId).toBe('restored-project-handle');
    expect(restored.projectKey).toBe(seed.projectKey);
    expect(restored.trustState).toBe('unknown');
    expect(readFileSync(join(externalProject, 'sentinel.txt'), 'utf8')).toBe('external-project-unchanged');
  }, 90_000);
});
