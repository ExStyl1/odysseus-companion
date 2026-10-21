import { describe, expect, it } from 'bun:test';
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service';
import { CapabilityContextError, resolveCapabilityContext } from '../context.ts';

let inoCounter = 10n;
function service(): ProjectHandleService {
  // Distinct inode per service so trust grants (in the test-isolated CONFIG_DIR)
  // never bleed across cases; a stable identity is required to persist trust.
  const ino = inoCounter++;
  return new ProjectHandleService({
    identityOptions: { realpathSync: p => p, statSync: () => ({ dev: 1n, ino }), processSalt: 's' },
    candidateRealpathSync: p => p,
    candidateStatSync: () => ({ isDirectory: () => true }),
  });
}

describe('resolveCapabilityContext', () => {
  it('resolves a Workspace-only ref with trust none and no project', async () => {
    const handleService = service();
    const ctx = await resolveCapabilityContext({ workspaceId: 'ws-1' }, { handleService });
    expect(ctx).toEqual({ workspaceId: 'ws-1', projectTrustState: 'none', projectTrustRevision: '' });
  });

  it('rejects a raw projectRoot smuggled through the ref', async () => {
    const handleService = service();
    await expect(
      resolveCapabilityContext({ workspaceId: 'ws-1', projectRoot: '/etc' }, { handleService }),
    ).rejects.toBeInstanceOf(CapabilityContextError);
  });

  it('derives project root/key/trust from a backend-issued handle', async () => {
    const handleService = service();
    const handle = await handleService.validateProjectDirectory('ws-1', '/home/user/proj');
    await handleService.setProjectTrust({ workspaceId: 'ws-1', projectHandleId: handle.id }, 'trusted');
    const ctx = await resolveCapabilityContext(
      { workspaceId: 'ws-1', projectHandleId: handle.id },
      { handleService },
    );
    expect(ctx.projectRoot).toBe('/home/user/proj');
    expect(ctx.projectKey).toMatch(/^p_[a-f0-9]{32}$/);
    expect(ctx.projectTrustState).toBe('trusted');
    expect(ctx.projectTrustRevision).not.toBe('');
  });

  it('rejects an unknown/expired handle ref', async () => {
    const handleService = service();
    await expect(
      resolveCapabilityContext({ workspaceId: 'ws-1', projectHandleId: 'nope' }, { handleService }),
    ).rejects.toMatchObject({ code: 'unknown-or-expired-handle' });
  });

  it('treats a session with no bound project as Workspace-only', async () => {
    const handleService = service();
    const ctx = await resolveCapabilityContext({ workspaceId: 'ws-1', sessionId: 's-1' }, { handleService });
    expect(ctx).toEqual({ workspaceId: 'ws-1', sessionId: 's-1', projectTrustState: 'none', projectTrustRevision: '' });
  });

  it('restores a session project handle from server-owned persisted state', async () => {
    const handleService = service();
    const ctx = await resolveCapabilityContext(
      { workspaceId: 'ws-1', sessionId: 's-1' },
      {
        handleService,
        resolveSessionWorkingDirectory: (workspaceId, sessionId) => (
          workspaceId === 'ws-1' && sessionId === 's-1' ? '/home/user/restored-project' : undefined
        ),
      },
    );

    expect(ctx).toMatchObject({
      workspaceId: 'ws-1',
      sessionId: 's-1',
      projectRoot: '/home/user/restored-project',
      workingDirectory: '/home/user/restored-project',
      projectTrustState: 'none',
    });
    expect(ctx.projectKey).toMatch(/^p_[a-f0-9]{32}$/);
    expect(await handleService.resolveHandle({ workspaceId: 'ws-1', sessionId: 's-1' })).not.toBeNull();
  });
});
