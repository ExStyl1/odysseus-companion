/**
 * F1.1234 — a session stored as Explore (or its older spelling `safe`) opens in
 * Plan, on the real restore path, and nothing rewrites it as Manual.
 *
 * F1.1050 retired `explore` and decided a stored one is read as `plan` forever
 * (`parsePermissionMode`). The final sitting (SIT2-f, RC 831fde57f) found the
 * startup restore skipped that read: `loadSessionsFromDisk` builds every
 * session from `SessionStore.list()`, whose header reader in store-v2 was a
 * bare `JSON.parse`, so `explore` reached the mode manager
 * (`changedBy=restore`), the composer coerced the unknown value to Manual and
 * the header was written back as `default` — a read-only session widened.
 *
 * Driven end to end in a child with a real v2 store and a real SessionManager:
 * the header is hand-edited exactly as the sitting did, then `reloadSessions()`
 * runs the startup restore. The import door (a bundle exported by 1.40.x
 * still carries `explore`) is the second arm. Boundaries: `plan` and `auto`
 * restore unchanged, and an unknown spelling restores as Manual (`default`),
 * which is what it did before.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * F1.1271 — this file's case spawns a child that pays the whole SessionManager
 * module graph, which is I/O-bound on this rig, so its wall time is the graph's,
 * not the body's. Readings of the case, 2026-10-09: 1.63 s warm at load 12.50 (real 2.00 /
 * user 1.66 / sys 0.58) and 74.81 s cold at load 6.38 (the cold run of the pair: real 383.60 / user 5.29 / sys 2.03, 1.9 % cpu, so I/O wait; its
 * other member read 261.84 s). Lane CR-1 measured the pair at 88-144 s
 * (2026-10-01) against the 180 000 they used to carry. Sized from the family's
 * LARGEST reading (261.84 s), per the sizing rule in `module-graph-budgets.ts`,
 * and declared here because it fits none of that module's three numbers: the
 * shared per-case 300 000 is only 1.15x of it; 600 000 is about 2.3x.
 */
const SESSION_MANAGER_CHILD_CASE_BUDGET_MS = 600_000

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const SESSION_MANAGER_MODULE = pathToFileURL(join(import.meta.dir, '..', 'SessionManager.ts')).href
const WORKSPACE_QUIESCENCE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'workspaces', 'workspace-quiescence.ts')).href
const RESULT_PREFIX = 'F1_1234_RESULT='
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runChild(body: string): Record<string, any> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-stored-explore-')))
  tempRoots.push(root)
  const profile = join(root, 'profile')
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
      NESSY_CONFIG_DIR: join(profile, '.nessy-agent'),
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
    throw new Error(result.stderr.toString() || `stored-explore child exited ${result.exitCode}`)
  }
  const line = result.stdout.toString().split('\n').find(entry => entry.startsWith(RESULT_PREFIX))
  if (!line) throw new Error(`stored-explore child returned no result: ${result.stdout.toString()}`)
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as Record<string, any>
}

const CHILD = `
  import { readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service';
  import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store';
  import { createSessionStore, writeSessionJsonl } from '@nessy-agent/shared/sessions';
  import { getPermissionMode } from '@nessy-agent/shared/agent/mode-manager';
  import { CONFIG_DIR, createWorkspaceService, ensureStorageLayoutV2 } from '@nessy-agent/shared/workspaces';
  import { SessionManager } from '${SESSION_MANAGER_MODULE}';
  import { WorkspaceQuiescenceCoordinator } from '${WORKSPACE_QUIESCENCE_MODULE}';

  const readiness = await ensureStorageLayoutV2({ assertHeld() {} });
  if (readiness.status === 'blocked') throw new Error(readiness.code);
  const workspaces = createWorkspaceService({ configDir: CONFIG_DIR, credentialManager: { list: async () => [] } });
  const workspace = await workspaces.create({ name: 'Stored Explore' });
  const store = createSessionStore(readiness.layout);
  const leases = new Set();
  let generation = 0;
  const manager = new SessionManager(store, {
    resolver: {
      resolve: async context => {
        const leaseId = 'lease-' + (++generation);
        leases.add(leaseId);
        return { context, generation: 'g-' + generation, leaseId, entries: [], installedPlugins: [], diagnostics: [] };
      },
      releaseSnapshot: leaseId => { leases.delete(leaseId); },
      invalidate() {},
      isLeaseActive: leaseId => leases.has(leaseId),
      referencedInstances: () => new Set(),
      leaseCount: () => leases.size,
    },
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
  const fileOf = id => store.getSessionFilePath({ workspaceId: workspace.id, sessionId: id });
  const headerOf = id => JSON.parse(readFileSync(fileOf(id), 'utf8').split('\\n')[0]);

  // SIT2-f's repro: an ordinary session on disk, then its header's mode is
  // hand-set to the stored value with the manager not holding it.
  const STORED = {
    'old-explore': { permissionMode: 'explore' },
    'old-safe': { permissionMode: 'safe' },
    'old-explore-previous': { permissionMode: 'plan', previousPermissionMode: 'explore' },
    'kept-plan': { permissionMode: 'plan' },
    'kept-auto': { permissionMode: 'auto' },
    'unknown-mode': { permissionMode: 'warp-speed' },
  };
  for (const [id, modes] of Object.entries(STORED)) {
    const created = await store.create(workspace.id, { sessionId: id, name: id });
    writeSessionJsonl(fileOf(id), { ...created, messages: [], tokenUsage: usage });
    const lines = readFileSync(fileOf(id), 'utf8').split('\\n');
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), ...modes });
    writeFileSync(fileOf(id), lines.join('\\n'));
  }

  manager.reloadSessions();
  const listed = Object.fromEntries(manager.getSessions(workspace.id).map(s => [s.id, s.permissionMode]));
  const modeManager = Object.fromEntries(Object.keys(STORED).map(id => [id, getPermissionMode({ workspaceId: workspace.id, sessionId: id })]));
  const opened = {};
  for (const id of Object.keys(STORED)) opened[id] = (await manager.getSession(id, workspace.id))?.permissionMode;
  const previous = (await manager.getSession('old-explore-previous', workspace.id))?.previousPermissionMode;
  // Let any persist the restore queued land before reading the files back.
  await new Promise(resolve => setTimeout(resolve, 300));
  const onDisk = Object.fromEntries(Object.keys(STORED).map(id => [id, headerOf(id).permissionMode]));

  // The import door: a bundle exported before the retirement still says explore.
  const bundle = await manager.exportSession('kept-plan', workspace.id);
  if (!bundle) throw new Error('export-failed');
  bundle.session.header = { ...bundle.session.header, permissionMode: 'explore', previousPermissionMode: 'safe' };
  const imported = await manager.importSession(workspace.id, bundle, 'fork');
  const importedSession = await manager.getSession(imported.sessionId, workspace.id);
  await new Promise(resolve => setTimeout(resolve, 300));
  const importedHeader = headerOf(imported.sessionId);
  const importedModeManager = getPermissionMode({ workspaceId: workspace.id, sessionId: imported.sessionId });
  manager.cleanup();

  console.log('${RESULT_PREFIX}' + JSON.stringify({
    listed, modeManager, opened, previous, onDisk,
    imported: {
      mode: importedSession?.permissionMode,
      previous: importedSession?.previousPermissionMode,
      modeManager: importedModeManager,
      onDisk: [importedHeader.permissionMode, importedHeader.previousPermissionMode],
    },
  }));
`

describe('a session stored as Explore restores as Plan (F1.1234)', () => {
  it('reads a stored explore or safe as plan on the startup restore and the import, and writes neither default nor explore', () => {
    const result = runChild(CHILD)

    // The SIT2-f repro: the startup restore, the listing the renderer reads, and
    // the opened session all hold plan; the old spelling `safe` too.
    for (const id of ['old-explore', 'old-safe']) {
      expect({ id, listed: result.listed[id] }).toEqual({ id, listed: 'plan' })
      expect({ id, modeManager: result.modeManager[id] }).toEqual({ id, modeManager: 'plan' })
      expect({ id, opened: result.opened[id] }).toEqual({ id, opened: 'plan' })
      // A pure read does not rewrite the file, and never as Manual.
      expect(result.onDisk[id]).not.toBe('default')
    }
    // The plan-exit target is read the same way, so leaving Plan cannot land on
    // a retired value.
    expect(result.previous).toBe('plan')

    // The import door: the stored session and the mode manager hold plan, and
    // what the import writes says plan, never explore.
    expect(result.imported).toEqual({
      mode: 'plan',
      previous: 'plan',
      modeManager: 'plan',
      onDisk: ['plan', 'plan'],
    })

    // Boundaries: plan and auto restore unchanged; an unknown spelling restores
    // as Manual, as it did before.
    expect(result.opened['kept-plan']).toBe('plan')
    expect(result.modeManager['kept-plan']).toBe('plan')
    expect(result.onDisk['kept-plan']).toBe('plan')
    expect(result.opened['kept-auto']).toBe('auto')
    expect(result.modeManager['kept-auto']).toBe('auto')
    expect(result.modeManager['unknown-mode']).toBe('default')
  }, SESSION_MANAGER_CHILD_CASE_BUDGET_MS) // F1.1271 — sized in the header
})
