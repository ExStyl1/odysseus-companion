import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR } from '../../workspaces/paths.ts';
import type { StoredSession } from '../../sessions/types.ts';
import { loadSession, saveSession } from '../../sessions/storage.ts';
import type { StoredConfig } from '../storage.ts';
import { runSessionRetentionSweep } from '../storage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): number {
  return Date.now() - (days * DAY_MS);
}

function makeStoredSession(
  workspaceId: string,
  id: string,
  options: { isArchived?: boolean; archivedAt?: number } = {}
): StoredSession {
  return {
    id,
    workspaceId,
    createdAt: daysAgo(12),
    lastUsedAt: options.archivedAt ?? daysAgo(12),
    isArchived: options.isArchived,
    archivedAt: options.archivedAt,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
}

function makeConfig(workspaceId: string, retentionDays: number): StoredConfig {
  return {
    workspaceRefs: [{ id: workspaceId, lastAccessedAt: 1 }],
    activeWorkspaceId: workspaceId,
    activeSessionId: null,
    retentionDays,
  };
}

describe('session retention sweep', () => {
  let workspaceId: string;

  beforeEach(() => {
    workspaceId = `session-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });

  afterEach(() => {
    const dir = join(SESSIONS_DIR, workspaceId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes archived sessions older than the configured retention window', async () => {
    await saveSession(makeStoredSession(workspaceId, 'old-archived', {
      isArchived: true,
      archivedAt: daysAgo(10),
    }));
    await saveSession(makeStoredSession(workspaceId, 'new-archived', {
      isArchived: true,
      archivedAt: daysAgo(2),
    }));
    await saveSession(makeStoredSession(workspaceId, 'old-active', {
      isArchived: false,
      archivedAt: daysAgo(10),
    }));

    expect(runSessionRetentionSweep(makeConfig(workspaceId, 7))).toBe(1);

    expect(loadSession(workspaceId, 'old-archived')).toBeNull();
    expect(loadSession(workspaceId, 'new-archived')).not.toBeNull();
    expect(loadSession(workspaceId, 'old-active')).not.toBeNull();
  });

  it('does not delete archived sessions when retentionDays is disabled', async () => {
    await saveSession(makeStoredSession(workspaceId, 'old-archived', {
      isArchived: true,
      archivedAt: daysAgo(10),
    }));

    expect(runSessionRetentionSweep(makeConfig(workspaceId, 0))).toBe(0);
    expect(loadSession(workspaceId, 'old-archived')).not.toBeNull();
  });
});
