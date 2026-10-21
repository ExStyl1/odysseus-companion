import { describe, expect, it } from 'bun:test';
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import type { Message } from '@craft-agent/core/types';
import type { Workspace } from '@craft-agent/shared/config';
import {
  createManagedSession,
  SessionManager,
} from './SessionManager.ts';

type TestManagedSession = ReturnType<typeof createManagedSession>;

describe('permission mode persistence', () => {
  it('changes and persists only the selected session', async () => {
    const workspace: Workspace = {
      id: 'workspace-mode',
      name: 'Mode Workspace',
      slug: 'mode-workspace',
      rootPath: '/tmp/mode-workspace',
      createdAt: 1,
    };
    const manager = new SessionManager();
    const first = createManagedSession(
      {
        id: 'session-mode-first',
        createdAt: 1,
        lastUsedAt: 2,
        lastMessageAt: 2,
        permissionMode: 'ask',
      },
      workspace,
      {
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'hello',
            timestamp: 2,
          } as Message,
        ],
        messagesLoaded: true,
      },
    );
    const second = createManagedSession(
      {
        id: 'session-mode-second',
        createdAt: 1,
        lastUsedAt: 2,
        lastMessageAt: 2,
        permissionMode: 'safe',
      },
      workspace,
      { messagesLoaded: true },
    );
    const legacy = createManagedSession(
      {
        id: 'session-mode-legacy',
        createdAt: 1,
        lastUsedAt: 2,
        lastMessageAt: 2,
      },
      workspace,
      { messagesLoaded: true, permissionMode: 'ask' },
    );

    const internals = manager as unknown as {
      sessions: Map<string, TestManagedSession>;
      sessionsUsingGlobalPermissionMode: Set<string>;
    };
    internals.sessions.set(first.id, first);
    internals.sessions.set(second.id, second);
    internals.sessions.set(legacy.id, legacy);
    internals.sessionsUsingGlobalPermissionMode.add(legacy.id);

    const queue = sessionPersistenceQueue as unknown as {
      enqueue: (session: unknown) => void;
    };
    const originalEnqueue = queue.enqueue;
    let enqueueCalls = 0;
    queue.enqueue = (_session: unknown) => {
      enqueueCalls += 1;
    };

    try {
      await manager.setSessionPermissionMode(first.id, 'allow-all');
      await manager.applyGlobalPermissionMode('auto-edit');
    } finally {
      queue.enqueue = originalEnqueue;
    }

    expect(enqueueCalls).toBe(1);
    expect(first.permissionMode).toBe('allow-all');
    expect(second.permissionMode).toBe('safe');
    expect(legacy.permissionMode).toBe('auto-edit');
  });
});
