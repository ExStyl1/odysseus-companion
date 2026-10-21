/**
 * W5b: duplicate-session-ID isolation across two live workspaces.
 *
 * Every shared session-keyed singleton must key by the composite
 * {workspaceId, sessionId}, so two workspaces that happen to reuse the same
 * bare sessionId keep fully distinct state. Equal composite keys (built as
 * separate objects) must still resolve to the same entry.
 */
import { describe, it, expect } from 'bun:test';
import type { SessionKey } from '../../sessions/session-key.ts';
import {
  getPermissionMode,
  setPermissionMode,
  cleanupModeState,
} from '../mode-manager.ts';
import {
  registerSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  setLastPlanFilePath,
  getLastPlanFilePath,
  clearPlanFileState,
} from '../session-scoped-tools.ts';

describe('W5b composite session key isolation across workspaces', () => {
  it('mode-manager keeps two workspaces with the same sessionId distinct', () => {
    const sessionId = `dup-mode-${Date.now()}`;
    const keyA: SessionKey = { workspaceId: 'ws-alpha', sessionId };
    const keyB: SessionKey = { workspaceId: 'ws-beta', sessionId };

    setPermissionMode(keyA, 'bypassPermissions', { changedBy: 'user' });

    // A freshly-built key equal to keyA must resolve to the same entry.
    expect(getPermissionMode({ workspaceId: 'ws-alpha', sessionId })).toBe('bypassPermissions');
    // The other workspace's session is untouched (default mode).
    expect(getPermissionMode(keyB)).toBe('default');

    cleanupModeState(keyA);
    cleanupModeState(keyB);
  });

  it('callback registry keeps two workspaces with the same sessionId distinct', () => {
    const sessionId = `dup-cb-${Date.now()}`;
    const keyA: SessionKey = { workspaceId: 'ws-alpha', sessionId };
    const keyB: SessionKey = { workspaceId: 'ws-beta', sessionId };

    unregisterSessionScopedToolCallbacks(keyA);
    unregisterSessionScopedToolCallbacks(keyB);

    const queryFn = async () => ({ text: 'a', model: 'test' });
    registerSessionScopedToolCallbacks(keyA, { queryFn });

    expect(getSessionScopedToolCallbacks({ workspaceId: 'ws-alpha', sessionId })?.queryFn).toBe(queryFn);
    expect(getSessionScopedToolCallbacks(keyB)).toBeUndefined();

    unregisterSessionScopedToolCallbacks(keyA);
    unregisterSessionScopedToolCallbacks(keyB);
  });

  it('plan-file state keeps two workspaces with the same sessionId distinct', () => {
    const sessionId = `dup-plan-${Date.now()}`;
    const keyA: SessionKey = { workspaceId: 'ws-alpha', sessionId };
    const keyB: SessionKey = { workspaceId: 'ws-beta', sessionId };

    setLastPlanFilePath(keyA, '/plans/alpha.md');

    expect(getLastPlanFilePath({ workspaceId: 'ws-alpha', sessionId })).toBe('/plans/alpha.md');
    expect(getLastPlanFilePath(keyB)).toBeNull();

    clearPlanFileState(keyA);
    clearPlanFileState(keyB);
  });
});
