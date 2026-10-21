/**
 * W6 Step 8 — workspace permission files load from the managed Workspace root,
 * never the project workingDirectory. Setting/changing a custom working
 * directory (the command/file cwd) must not move the permissions.json lookup.
 */
import { describe, expect, it } from 'bun:test';
import { PermissionManager } from '../permission-manager.ts';
import { getWorkspacePermissionsPath, permissionsConfigCache } from '../../permissions-config.ts';
import { parseManagedPiPolicyV1 } from '../../pi-harness/managed-policy.ts';
import { evaluatePermissionDslV1 } from '../../pi-harness/permission-dsl.ts';

const MANAGED_ROOT = '/managed/workspaces/ws-uuid';
const PROJECT_CWD = '/home/user/repos/project';

describe('PermissionManager — permission context boundary', () => {
  it('resolves workspace permissions from the managed root even with a custom project cwd', () => {
    const pm = new PermissionManager({
      workspaceId: 'ws-uuid',
      sessionId: 'sess-1',
      workspaceRootPath: MANAGED_ROOT,
      workingDirectory: PROJECT_CWD,
    });

    const ctx = pm.getPermissionsContext();
    expect(ctx.workspaceRootPath).toBe(MANAGED_ROOT);
    expect(getWorkspacePermissionsPath(ctx.workspaceRootPath)).toBe(`${MANAGED_ROOT}/permissions.json`);
  });

  it('keeps the permissions root fixed when the working directory changes', () => {
    const pm = new PermissionManager({
      workspaceId: 'ws-uuid',
      sessionId: 'sess-1',
      workspaceRootPath: MANAGED_ROOT,
      workingDirectory: PROJECT_CWD,
    });

    pm.updateWorkingDirectory('/home/user/repos/other-project');
    expect(pm.getPermissionsContext().workspaceRootPath).toBe(MANAGED_ROOT);
  });

  it('pins a managed DSL into every capability context, rebinds its generation, and keys the cache by its digest', () => {
    permissionsConfigCache.clear();
    const deny = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      permissionDsl: {
        version: 1,
        rules: [{ id: 'managed-deny', action: 'deny', match: { kind: 'tool', semanticId: 'Bash' } }],
      },
    }).permissionDsl!;
    const allow = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      permissionDsl: {
        version: 1,
        rules: [{ id: 'managed-allow', action: 'allow', match: { kind: 'tool', semanticId: 'Bash' } }],
      },
    }).permissionDsl!;
    const first = new PermissionManager({ workspaceId: 'ws-uuid', sessionId: 'sess-1', workspaceRootPath: MANAGED_ROOT });
    first.setCapabilityPermissionLayers([], 'generation-1', false, deny);
    const firstContext = first.getCapabilityPermissionsContext()!;
    const firstPolicy = permissionsConfigCache.getMergedConfig(firstContext).permissionDsl!;
    expect(firstPolicy.generation).toBe('generation-1');
    expect(evaluatePermissionDslV1(firstPolicy, {
      generation: 'generation-1', semanticId: 'Bash', toolName: 'Bash', input: {}, cwd: MANAGED_ROOT,
    }).action).toBe('deny');

    const second = new PermissionManager({ workspaceId: 'ws-uuid', sessionId: 'sess-2', workspaceRootPath: MANAGED_ROOT });
    second.setCapabilityPermissionLayers([], 'generation-1', false, allow);
    const secondPolicy = permissionsConfigCache.getMergedConfig(second.getCapabilityPermissionsContext()!).permissionDsl!;
    expect(secondPolicy.rules[0]?.id).toBe('managed-allow');

    second.setCapabilityPermissionLayers([], 'generation-2', false, allow);
    expect(permissionsConfigCache.getMergedConfig(second.getCapabilityPermissionsContext()!).permissionDsl?.generation).toBe('generation-2');
  });
});
