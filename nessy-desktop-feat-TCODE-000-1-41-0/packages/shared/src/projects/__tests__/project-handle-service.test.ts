import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHandleService } from '../project-handle-service.ts';
import { ProjectTrustStore } from '../../capabilities/project-trust-store.ts';
import {
  onCapabilityCatalogInvalidation,
  type CapabilityCatalogInvalidation,
} from '../../capabilities/invalidation.ts';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function trustStore(): ProjectTrustStore {
  const dir = mkdtempSync(join(tmpdir(), 'phs-'));
  tmpDirs.push(dir);
  return new ProjectTrustStore({ path: join(dir, 'project-trust.json'), newRevision: (() => { let n = 0; return () => `rev-${++n}`; })() });
}

function projectDirectory(name = 'project'): string {
  const root = mkdtempSync(join(tmpdir(), 'phs-project-'));
  tmpDirs.push(root);
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function stableService(
  inoBox: { ino: bigint } = { ino: 42n },
  options: { now?: () => number; ttlMs?: number; managedRootPaths?: string[] } = {},
): ProjectHandleService {
  return new ProjectHandleService({
    trustStore: trustStore(),
    ...options,
    identityOptions: {
      realpathSync: p => p,
      statSync: () => ({ dev: 1n, ino: inoBox.ino }),
      processSalt: 'test-salt',
    },
  });
}

describe('ProjectHandleService — ingress and trust', () => {
  it('issues a Workspace-bound handle, untrusted by default', async () => {
    const service = stableService();
    const path = projectDirectory();
    const handle = await service.validateProjectDirectory('ws-1', path);
    expect(handle.workspaceId).toBe('ws-1');
    expect(handle.displayPath).toBe(path);
    expect(handle.trustState).toBe('unknown');
    expect(handle.expiresAt).toBeGreaterThan(0);
  });

  it('records trust through the ProjectTrustStore and reflects it on resolve', async () => {
    const service = stableService();
    const handle = await service.validateProjectDirectory('ws-1', projectDirectory());
    await service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'trusted');
    const resolved = await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: handle.id });
    expect(resolved).not.toBeNull();
    expect(resolved!.trustDecision).toBe('trusted');
    expect(resolved!.trustState).toBe('trusted');
    expect(resolved!.projectKey).toMatch(/^p_[a-f0-9]{32}$/);
  });

  it('refreshes on trust grant and revokes every context for the project on block', async () => {
    const service = stableService();
    const handle = await service.validateProjectDirectory('ws-1', projectDirectory());
    const events: CapabilityCatalogInvalidation[] = [];
    const off = onCapabilityCatalogInvalidation(event => events.push(event));
    try {
      await service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'trusted');
      await service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'blocked');
    } finally {
      off();
    }

    const projectKey = (await service.resolveHandle({
      workspaceId: 'ws-1',
      projectHandleId: handle.id,
    }))!.projectKey;
    expect(events.map(({ scope, reason, effect }) => ({ scope, reason, effect }))).toEqual([
      {
        scope: { kind: 'project-trust', projectKey },
        reason: 'project-trust-granted',
        effect: 'refresh-before-next-turn',
      },
      {
        scope: { kind: 'project-trust', projectKey },
        reason: 'project-trust-revoked',
        effect: 'revoke-active-snapshot',
      },
    ]);
  });

  it('rejects a Workspace mismatch', async () => {
    const service = stableService();
    const handle = await service.validateProjectDirectory('ws-1', projectDirectory());
    expect(await service.resolveHandle({ workspaceId: 'ws-2', projectHandleId: handle.id })).toBeNull();
    await expect(service.setProjectTrust({ workspaceId: 'ws-2', projectHandleId: handle.id }, 'trusted'))
      .rejects.toThrow('project-handle-invalid');
  });

  it('rejects a handle after its real TTL elapses', async () => {
    let now = 100;
    const service = new ProjectHandleService({
      trustStore: trustStore(),
      ttlMs: 1000,
      now: () => now,
      identityOptions: { realpathSync: p => p, statSync: () => ({ dev: 1n, ino: 42n }), processSalt: 's' },
    });
    const handle = await service.validateProjectDirectory('ws-1', projectDirectory());
    now = 1100;
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: handle.id })).toBeNull();
    await expect(service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'trusted'))
      .rejects.toThrow('project-handle-invalid');
  });

  it('rejects missing paths and regular files before issuing a handle', async () => {
    const service = stableService();
    const root = mkdtempSync(join(tmpdir(), 'phs-invalid-'));
    tmpDirs.push(root);
    const file = join(root, 'file.txt');
    writeFileSync(file, 'not a directory');

    await expect(service.validateProjectDirectory('ws-1', join(root, 'missing')))
      .rejects.toThrow('project-directory-invalid');
    await expect(service.validateProjectDirectory('ws-1', file))
      .rejects.toThrow('project-directory-invalid');
  });

  it('rejects managed storage and a symlink into it before identity resolution', async () => {
    const managedRoot = mkdtempSync(join(tmpdir(), 'phs-managed-'));
    const externalRoot = mkdtempSync(join(tmpdir(), 'phs-external-'));
    tmpDirs.push(managedRoot, externalRoot);
    const managedChild = join(managedRoot, 'workspaces', 'ws-1');
    mkdirSync(managedChild, { recursive: true });
    const link = join(externalRoot, 'managed-link');
    symlinkSync(managedChild, link);
    let identityStatCalls = 0;
    const service = new ProjectHandleService({
      trustStore: trustStore(),
      managedRootPaths: [managedRoot],
      identityOptions: {
        realpathSync: path => path,
        statSync: () => {
          identityStatCalls++;
          return { dev: 1n, ino: 42n };
        },
        processSalt: 'managed-test',
      },
    });

    await expect(service.validateProjectDirectory('ws-1', managedChild))
      .rejects.toThrow('project-directory-managed');
    await expect(service.validateProjectDirectory('ws-1', link))
      .rejects.toThrow('project-directory-managed');
    expect(identityStatCalls).toBe(0);
  });

  it('rejects a handle after the underlying inode is replaced (revalidation)', async () => {
    const inoBox = { ino: 42n };
    const service = stableService(inoBox);
    const handle = await service.validateProjectDirectory('ws-1', projectDirectory());
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: handle.id })).not.toBeNull();
    inoBox.ino = 99n; // delete + recreate at the same path
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: handle.id })).toBeNull();
    await expect(service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'trusted'))
      .rejects.toThrow('project-handle-invalid');
  });

  it('keeps a process-only project trust session-only (re-approval after restart)', async () => {
    const store = trustStore();
    const opts = { realpathSync: (p: string) => p, statSync: () => ({ dev: 0n, ino: 0n }), processSalt: 'p' };
    const service = new ProjectHandleService({ trustStore: store, identityOptions: opts });
    const path = projectDirectory();
    const handle = await service.validateProjectDirectory('ws-1', path);
    await service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'trusted');
    const resolved = await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: handle.id });
    expect(resolved!.persistence).toBe('process-only');
    expect(resolved!.trustDecision).toBe('trusted');

    // Simulate a restart: a fresh store (no in-memory process-only grant).
    const afterRestart = new ProjectHandleService({ trustStore: trustStore(), identityOptions: opts });
    const reissued = await afterRestart.validateProjectDirectory('ws-1', path);
    const reresolved = await afterRestart.resolveHandle({ workspaceId: 'ws-1', projectHandleId: reissued.id });
    expect(reresolved!.trustDecision).toBe('none');
  });

  // glossary.md:231 home carve-out, end-to-end through the sole raw-path
  // ingress: home is NOT refused — the doc allows trusting it — but the grant
  // is session-scoped only.
  it('issues a handle for the home directory and keeps its trust session-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phs-home-'));
    tmpDirs.push(dir);
    const trustFile = join(dir, 'project-trust.json');
    const home = projectDirectory('home');
    const identityOptions = {
      realpathSync: (p: string) => p,
      // Healthy stable root identity — the carve-out is the only process-only route here.
      statSync: () => ({ dev: 1n, ino: 42n }),
      processSalt: 'home-salt',
      // The candidate path is canonicalized before identity resolution, so the
      // injected home must be the realpath of the same directory.
      homeDir: realpathSync(home),
    };
    const service = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: trustFile }),
      identityOptions,
    });

    // Home is not refused: a handle IS issued, untrusted by default.
    const handle = await service.validateProjectDirectory('ws-1', home);
    expect(handle.trustState).toBe('unknown');

    // Trusting it reports trusted inside this process...
    const trusted = await service.setProjectTrust(
      { workspaceId: 'ws-1', projectHandleId: handle.id },
      'trusted',
    );
    expect(trusted.trustState).toBe('trusted');
    const resolved = await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: handle.id });
    expect(resolved!.persistence).toBe('process-only');
    expect(resolved!.trustDecision).toBe('trusted');

    // ...but a second service with a fresh trust store over the SAME file
    // (restart simulation) reports unknown again.
    const afterRestart = new ProjectHandleService({
      trustStore: new ProjectTrustStore({ path: trustFile }),
      identityOptions,
    });
    const reissued = await afterRestart.validateProjectDirectory('ws-1', home);
    expect(reissued.trustState).toBe('unknown');
  });

  /**
   * D1.363 — a trust answer for a folder that is GONE is terminal, not retryable.
   *
   * Measured on the packaged 1.40.0 (measure sitting 5e, case `RS-80`): with the
   * app's "Trust this project?" modal up, the case's `finally` removed the
   * directory the modal named, and from then on every click answered "Could not
   * update project trust" — an error no click could get past, because the folder
   * was gone. The renderer could not tell that from a transient failure, because
   * the service reported the same `project-handle-invalid` for both.
   *
   * The CONTROL is the inode-replacement case above, which is the same `null`
   * from `resolveHandle` with the directory still on disk and must keep reading
   * `project-handle-invalid` — otherwise this would just be renaming every
   * failure.
   */
  it('reports a deleted project folder as terminal, and a live one as before', async () => {
    const inoBox = { ino: 42n };
    const service = stableService(inoBox);
    const gone = projectDirectory('vanishes');
    const goneHandle = await service.validateProjectDirectory('ws-1', gone);
    const live = projectDirectory('stays');
    const liveHandle = await service.validateProjectDirectory('ws-1', live);

    rmSync(gone, { recursive: true, force: true });
    expect(service.describeUnresolvableRef({ workspaceId: 'ws-1', projectHandleId: goneHandle.id }))
      .toBe('project-directory-missing');
    await expect(service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: goneHandle.id }, 'trusted'))
      .rejects.toThrow('project-directory-missing');
    await expect(service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: goneHandle.id }, 'blocked'))
      .rejects.toThrow('project-directory-missing');

    // CONTROL: the directory is still there, only its identity moved.
    inoBox.ino = 99n;
    expect(service.describeUnresolvableRef({ workspaceId: 'ws-1', projectHandleId: liveHandle.id }))
      .toBe('project-handle-invalid');
    await expect(service.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: liveHandle.id }, 'trusted'))
      .rejects.toThrow('project-handle-invalid');
    // CONTROL: a handle id this service never issued is not a missing folder.
    expect(service.describeUnresolvableRef({ workspaceId: 'ws-1', projectHandleId: 'never-issued' }))
      .toBe('project-handle-invalid');
  });

  it('resolves a handle by session ref after binding', async () => {
    const service = stableService();
    const handle = await service.validateProjectDirectory('ws-1', projectDirectory());
    service.bindSession('ws-1', 'sess-1', handle.id);
    const resolved = await service.resolveHandle({ workspaceId: 'ws-1', sessionId: 'sess-1' });
    expect(resolved!.id).toBe(handle.id);
  });

  /**
   * UA12.107 — every read of a foldered project issues a FRESH handle (`projects:get`/`changed` →
   * `resolveStoredProjectFolder` → `validateProjectDirectory`) and nothing reads the old ones again, so without
   * a sweep the record map grows with the renderer's polling forever. Issuing prunes the expired records (and
   * the session bindings that point only at them): the map stays bounded after 1000 reads with a 1 ms TTL.
   */
  it('UA12.107: issuing prunes expired records — the maps stay bounded after 1000 reads with a 1 ms TTL', async () => {
    let now = 0;
    const service = stableService(undefined, { now: () => now, ttlMs: 1 });
    const path = projectDirectory();
    const bound = await service.validateProjectDirectory('ws-1', path);
    service.bindSession('ws-1', 'sess-1', bound.id);

    // One folder, 1000 reads — the renderer polling one projects list — with the clock past every earlier expiry.
    for (let read = 0; read < 1000; read += 1) {
      now = 10_000 + read;
      await service.validateProjectDirectory('ws-1', path);
    }
    const handles = (service as unknown as { handles: Map<string, unknown> }).handles;
    const sessionHandles = (service as unknown as { sessionHandles: Map<string, unknown> }).sessionHandles;
    expect(handles.size).toBeLessThanOrEqual(2);
    expect(sessionHandles.size).toBe(0);
  });

  // CONTROL for the same sweep: it deletes only EXPIRED records — an old-but-live handle survives an issue that
  // pruned an expired one, and still resolves afterwards.
  it('UA12.107: a sweep that prunes an expired record leaves a live one resolving', async () => {
    let now = 0;
    const service = stableService(undefined, { now: () => now, ttlMs: 10 });
    const path = projectDirectory();
    const early = await service.validateProjectDirectory('ws-1', path); // expires at 10
    now = 8;
    const mid = await service.validateProjectDirectory('ws-1', path); // expires at 18; nothing expired yet
    expect(mid.expiresAt).toBe(18);
    now = 12;
    await service.validateProjectDirectory('ws-1', path); // sweep at 12: `early` expired, `mid` (18 > 12) survives
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: mid.id })).not.toBeNull();
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: early.id })).toBeNull();
  });

  // F1.1088 — a caller that issued a handle only to READ its trust answer (the Settings-provenance view) drops it.
  it('F1.1088: a released handle leaves the map and resolves no more', async () => {
    const service = stableService();
    const issued = await service.validateProjectDirectory('ws-1', projectDirectory());
    service.releaseHandle('ws-1', issued.id);
    expect((service as unknown as { handles: Map<string, unknown> }).handles.has(issued.id)).toBe(false);
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: issued.id })).toBeNull();
  });

  it('F1.1088 BOUNDARY: a handle a session is bound to, or one of another workspace, is kept', async () => {
    const service = stableService();
    const bound = await service.validateProjectDirectory('ws-1', projectDirectory());
    service.bindSession('ws-1', 'sess-1', bound.id);
    service.releaseHandle('ws-1', bound.id);
    expect(await service.resolveHandle({ workspaceId: 'ws-1', sessionId: 'sess-1' })).not.toBeNull();
    const other = await service.validateProjectDirectory('ws-1', projectDirectory('other'));
    service.releaseHandle('ws-2', other.id);
    expect(await service.resolveHandle({ workspaceId: 'ws-1', projectHandleId: other.id })).not.toBeNull();
  });

});
