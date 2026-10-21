import { describe, expect, it } from 'bun:test';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: previousPermissionMode', () => {
  it('persists the current mode but not the previous mode', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('permissionMode');
    expect(SESSION_PERSISTENT_FIELDS).not.toContain('previousPermissionMode');
  });

  it('pickSessionFields includes only the current approval mode', () => {
    const source = {
      id: 's1',
      workspaceRootPath: '/tmp/ws',
      permissionMode: 'allow-all',
      previousPermissionMode: 'safe',
      createdAt: 1,
      lastUsedAt: 2,
      ignoredRuntimeField: 'nope',
    } as const;

    const picked = pickSessionFields(source);
    const pickedRecord = picked as Record<string, unknown>;
    expect(pickedRecord.permissionMode).toBe('allow-all');
    expect(pickedRecord.previousPermissionMode).toBeUndefined();
    expect(pickedRecord.ignoredRuntimeField).toBeUndefined();
  });
});
