import { describe, expect, it } from 'bun:test';
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import type { Workspace } from '@craft-agent/shared/config';
import {
  createManagedSession,
  SessionManager,
} from './SessionManager.ts';

type TestManagedSession = ReturnType<typeof createManagedSession>;

describe('session model persistence', () => {
  it('changes and persists only the selected session', async () => {
    const workspace: Workspace = {
      id: 'workspace-model',
      name: 'Model Workspace',
      slug: 'model-workspace',
      rootPath: '/tmp/model-workspace',
      createdAt: 1,
    };
    const manager = new SessionManager();
    const first = createManagedSession(
      {
        id: 'session-model-first',
        sdkSessionId: 'session-model-first',
        createdAt: 1,
        lastUsedAt: 2,
        model: 'model-a',
      },
      workspace,
      { messagesLoaded: true },
    );
    const second = createManagedSession(
      {
        id: 'session-model-second',
        sdkSessionId: 'session-model-second',
        createdAt: 1,
        lastUsedAt: 2,
        model: 'model-b',
      },
      workspace,
      { messagesLoaded: true },
    );

    const internals = manager as unknown as {
      sessions: Map<string, TestManagedSession>;
    };
    internals.sessions.set(first.id, first);
    internals.sessions.set(second.id, second);

    const queue = sessionPersistenceQueue as unknown as {
      enqueue: (session: { id: string; model?: string }) => void;
      flush: (sessionId: string) => Promise<void>;
    };
    const originalEnqueue = queue.enqueue;
    const originalFlush = queue.flush;
    const persisted: Array<{ id: string; model?: string }> = [];
    queue.enqueue = (session) => persisted.push(session);
    queue.flush = async () => {};

    try {
      await manager.updateSessionModel(
        first.id,
        workspace.id,
        'model-c',
      );
    } finally {
      queue.enqueue = originalEnqueue;
      queue.flush = originalFlush;
    }

    expect(first.model).toBe('model-c');
    expect(second.model).toBe('model-b');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: first.id,
      model: 'model-c',
    });
  });
});
