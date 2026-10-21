import { describe, expect, test } from 'bun:test';
import { TaskService } from './task-service.ts';

describe('TaskService', () => {
  test('rejects invalid DAG mutations and replays deterministically', async () => {
    const service = new TaskService({ workspaceId: 'w', sessionId: 's' });
    await expect(service.execute({ action: 'create', id: 'bad' } as never)).rejects.toThrow('invalid-task-title');
    await expect(service.execute({ action: 'update', id: '', title: 'bad' })).rejects.toThrow('invalid-task-id');
    const created = await service.execute({ action: 'create', id: 'a', title: 'A' });
    await expect(service.execute({ action: 'update', id: 'a', blockedBy: ['a'] })).rejects.toThrow('self-dependency');
    await service.execute({ action: 'create', id: 'b', title: 'B', blockedBy: ['a'] });
    await expect(service.execute({ action: 'update', id: 'a', blockedBy: ['b'] })).rejects.toThrow('cycle');
    await expect(service.execute({ action: 'create', id: 'a', title: 'duplicate' })).rejects.toThrow('duplicate');
    await expect(service.execute({ action: 'create', id: 'c', title: 'dangling', blockedBy: ['missing'] })).rejects.toThrow('dangling');
    await expect(service.execute({ action: 'update', id: 'a', title: 'stale', revision: 1 })).rejects.toThrow('stale-revision');
    await expect(service.execute({ action: 'delete', id: 'a' })).rejects.toThrow('dangling-dependency');
    await service.execute({ action: 'delete', id: 'b' });
    await service.execute({ action: 'update', id: 'a', status: 'completed' });
    await expect(service.execute({ action: 'update', id: 'a', status: 'pending' })).rejects.toThrow('illegal-transition');
    await service.execute({ action: 'delete', id: 'a' });
    await expect(service.execute({ action: 'create', id: 'a', title: 'reused' })).rejects.toThrow('tombstone');
    expect(created.tasks).toHaveLength(1);
  });

  test('publishes only after persistence and rolls back on persistence failure', async () => {
    const events: string[] = [];
    const service = new TaskService({ workspaceId: 'w', sessionId: 's' }, async () => { throw new Error('persist-failed'); }, async event => { events.push(event); });
    await expect(service.execute({ action: 'create', id: 'a', title: 'A' })).rejects.toThrow('persist-failed');
    expect(service.snapshot().tasks).toEqual([]);
    expect(events).toEqual([]);
  });

  test('returns defensive deterministic snapshots and emits durable lifecycle transitions once', async () => {
    const persisted: number[] = [];
    const events: string[] = [];
    const initial = { schemaVersion: 1 as const, revision: 0, tasks: [], tombstones: [] };
    const service = new TaskService(
      { workspaceId: 'w', sessionId: 's' },
      state => { persisted.push(state.revision); },
      // R20 widened the emitter's payload from a bare id to `{ taskId, subject?,
      // description? }`, which is what `hooks.md:2068` says the hooks receive.
      async (event, payload) => { events.push(`${event}:${payload.taskId}`); if (event === 'TaskCompleted') throw new Error('observer-failed'); },
      initial,
    );
    const created = await service.execute({ action: 'create', id: 'a', title: 'A' });
    (created.tasks as any[]).push({ id: 'mutated' });
    await service.execute({ action: 'update', id: 'a', status: 'completed' });
    await service.execute({ action: 'update', id: 'a', status: 'completed' });
    expect(service.snapshot().tasks.map(task => task.id)).toEqual(['a']);
    expect(initial).toEqual({ schemaVersion: 1, revision: 0, tasks: [], tombstones: [] });
    expect(persisted).toEqual([1, 2, 3]);
    expect(events).toEqual(['TaskCreated:a', 'TaskCompleted:a']);

    const replay = new TaskService({ workspaceId: 'w', sessionId: 's' }, undefined, undefined, service.snapshot());
    expect(replay.snapshot()).toEqual(service.snapshot());
  });
});
