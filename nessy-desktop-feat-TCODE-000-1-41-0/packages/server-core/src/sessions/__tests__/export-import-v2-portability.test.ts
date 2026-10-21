import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * F1.1271 — this file's case spawns a child that pays the whole SessionManager
 * module graph, which is I/O-bound on this rig, so its wall time is the graph's,
 * not the body's. Readings of the case, 2026-10-09: 1.93 s warm at load 11.70 (real 2.31 /
 * user 2.86 / sys 1.02) and 261.84 s cold at load 6.38 (the cold run of the pair: real 383.60 / user 5.29 / sys 2.03, 1.9 % cpu, so I/O wait; its
 * other member read 74.81 s). Lane CR-1 measured the pair at 88-144 s
 * (2026-10-01) against the 180 000 they used to carry. Sized from the family's
 * LARGEST reading (261.84 s), per the sizing rule in `module-graph-budgets.ts`,
 * and declared here because it fits none of that module's three numbers: the
 * shared per-case 300 000 is only 1.15x of it; 600 000 is about 2.3x.
 */
const SESSION_MANAGER_CHILD_CASE_BUDGET_MS = 600_000

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const SESSION_MANAGER_MODULE = pathToFileURL(join(import.meta.dir, '..', 'SessionManager.ts')).href
const WORKSPACE_QUIESCENCE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'workspaces', 'workspace-quiescence.ts')).href
const RESULT_PREFIX = 'W12_RESULT='
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempRoots.push(root)
  return root
}

function runChild(root: string, body: string): Record<string, unknown> {
  const profile = join(root, 'profile')
  const configRoot = join(profile, '.nessy-agent')
  const childTmp = join(root, 'tmp')
  const bunfig = join(root, 'bunfig.toml')
  mkdirSync(profile, { recursive: true })
  mkdirSync(childTmp, { recursive: true })
  writeFileSync(bunfig, '# no test preloads\n')

  const result = Bun.spawnSync([process.execPath, `--config=${bunfig}`, '--eval', body], {
    cwd: REPO_ROOT,
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
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `session portability child exited ${result.exitCode}`)
  }
  const line = result.stdout.toString().split('\n').find(entry => entry.startsWith(RESULT_PREFIX))
  if (!line) throw new Error(`session portability child returned no result: ${result.stdout.toString()}`)
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, unknown>
}

const runtimeSetup = `
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service';
  import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store';
  import { createSessionStore, writeSessionJsonl } from '@nessy-agent/shared/sessions';
  import { CONFIG_DIR, createWorkspaceService, ensureStorageLayoutV2 } from '@nessy-agent/shared/workspaces';
  import { SessionManager } from '${SESSION_MANAGER_MODULE}';
  import { WorkspaceQuiescenceCoordinator } from '${WORKSPACE_QUIESCENCE_MODULE}';

  const readiness = await ensureStorageLayoutV2({ assertHeld() {} });
  if (readiness.status === 'blocked') throw new Error(readiness.code);
  const workspaces = createWorkspaceService({
    configDir: CONFIG_DIR,
    credentialManager: { list: async () => [] },
  });
  const workspace = await workspaces.create({ name: 'Portable Target' });
  const store = createSessionStore(readiness.layout);
  const leases = new Set();
  let generation = 0;
  const resolver = {
    resolve: async context => {
      const leaseId = 'portable-lease-' + (++generation);
      leases.add(leaseId);
      return { context, generation: 'portable-' + generation, leaseId, entries: [], installedPlugins: [], diagnostics: [] };
    },
    releaseSnapshot: leaseId => { leases.delete(leaseId); },
    invalidate() {},
    isLeaseActive: leaseId => leases.has(leaseId),
    referencedInstances: () => new Set(),
    leaseCount: () => leases.size,
  };
  const manager = new SessionManager(store, {
    resolver,
    workspaceService: workspaces,
    projectHandleService: new ProjectHandleService({ managedRootPaths: [CONFIG_DIR] }),
    recentProjectStore: new RecentProjectStore(readiness.layout, { filePath: join(CONFIG_DIR, 'recent-projects.json') }),
    workspaceQuiescence: new WorkspaceQuiescenceCoordinator(),
    resolveCredential: () => ({ ready: false, revision: 0 }),
    dpSessionBroker: {
      probe: async () => ({ state: 'needs-login', version: null, outdated: false }),
      subscribe: () => () => undefined,
    },
    subscribeInvalidation: () => () => undefined,
  });
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 };
`

describe('v2 SessionManager export/import portability', () => {
  it('moves equal IDs and content into a fresh root while preserving target-local branch lineage', () => {
    const sourceRoot = tempRoot('nessy-session-export-')
    const targetRoot = tempRoot('nessy-session-import-')
    const transferPath = join(sourceRoot, 'session-bundles.json')

    const source = runChild(sourceRoot, `${runtimeSetup}
      const parent = await store.create(workspace.id, { sessionId: 'portable-parent', name: 'Portable Parent' });
      const parentPath = store.getSessionPath({ workspaceId: workspace.id, sessionId: parent.id });
      const parentMessages = [{ id: 'parent-turn', type: 'user', content: 'parent content', timestamp: 1 }];
      writeSessionJsonl(store.getSessionFilePath({ workspaceId: workspace.id, sessionId: parent.id }), {
        ...parent,
        sdkSessionId: 'portable-parent-sdk',
        sdkCwd: parentPath,
        messages: parentMessages,
        tokenUsage: usage,
      });
      const branch = await store.create(workspace.id, {
        sessionId: 'portable-branch',
        name: 'Portable Branch',
        branchFrom: {
          parent: { workspaceId: workspace.id, sessionId: parent.id },
          messageId: 'parent-turn',
          sdkSessionId: 'portable-parent-sdk',
          sdkCwd: parentPath,
          sdkTurnId: 'portable-parent-turn',
        },
      });
      const branchMessages = [
        ...parentMessages,
        { id: 'branch-turn', type: 'assistant', content: 'branch content', timestamp: 2 },
      ];
      writeSessionJsonl(store.getSessionFilePath({ workspaceId: workspace.id, sessionId: branch.id }), {
        ...branch, messages: branchMessages, tokenUsage: usage,
      });
      manager.reloadSessions();
      const parentBundle = await manager.exportSession(parent.id, workspace.id);
      const branchBundle = await manager.exportSession(branch.id, workspace.id);
      if (!parentBundle || !branchBundle) throw new Error('source-export-failed');
      manager.cleanup();
      console.log('${RESULT_PREFIX}' + JSON.stringify({
        readiness: readiness.status,
        configRoot: CONFIG_DIR,
        workspaceId: workspace.id,
        parentPath,
        branchMessages,
        bundles: [parentBundle, branchBundle],
      }));
    `)

    writeFileSync(transferPath, JSON.stringify(source.bundles))

    const target = runChild(targetRoot, `${runtimeSetup}
      const [parentBundle, branchBundle] = JSON.parse(readFileSync(${JSON.stringify(transferPath)}, 'utf8'));
      const malformedBundle = {
        ...branchBundle,
        session: {
          ...branchBundle.session,
          header: { ...branchBundle.session.header, id: 'malformed-branch', branchFrom: {} },
        },
      };
      let malformedRejected = false;
      try {
        await manager.importSession(workspace.id, malformedBundle, 'move');
      } catch {
        malformedRejected = true;
      }
      const sessionsAfterMalformed = store.list(workspace.id).length;
      const importedParent = await manager.importSession(workspace.id, parentBundle, 'move');
      const importedBranch = await manager.importSession(workspace.id, branchBundle, 'move');
      const branch = await manager.getSession(importedBranch.sessionId, workspace.id);
      const storedBranch = store.load({ workspaceId: workspace.id, sessionId: importedBranch.sessionId });
      const sessionPath = manager.getSessionPath(importedBranch.sessionId, workspace.id);
      manager.cleanup();
      console.log('${RESULT_PREFIX}' + JSON.stringify({
        readiness: readiness.status,
        configRoot: CONFIG_DIR,
        workspaceId: workspace.id,
        malformedRejected,
        sessionsAfterMalformed,
        parentId: importedParent.sessionId,
        branchId: importedBranch.sessionId,
        messages: branch?.messages.map(({ id, role, content, timestamp }) => ({ id, type: role, content, timestamp })),
        branchFrom: storedBranch?.branchFrom,
        sessionPath,
      }));
    `)

    expect(source.readiness).toBe('initialized')
    expect(target.readiness).toBe('initialized')
    expect(target.workspaceId).not.toBe(source.workspaceId)
    expect(target.malformedRejected).toBe(true)
    expect(target.sessionsAfterMalformed).toBe(0)
    expect(target.parentId).toBe('portable-parent')
    expect(target.branchId).toBe('portable-branch')
    expect(target.messages).toEqual(source.branchMessages)
    expect(target.branchFrom).toEqual({
      parent: { workspaceId: target.workspaceId, sessionId: 'portable-parent' },
      messageId: 'parent-turn',
      sdkSessionId: 'portable-parent-sdk',
      sdkTurnId: 'portable-parent-turn',
    })
    expect(target.sessionPath).toBeString()
    expect(target.sessionPath as string).toStartWith(target.configRoot as string)
    expect(target.sessionPath as string).not.toContain(source.configRoot as string)
    expect(JSON.stringify(source.bundles)).not.toContain(source.configRoot as string)
    expect(JSON.stringify(source.bundles)).not.toContain(source.parentPath as string)
  }, SESSION_MANAGER_CHILD_CASE_BUDGET_MS) // F1.1271 — sized in the header
})
