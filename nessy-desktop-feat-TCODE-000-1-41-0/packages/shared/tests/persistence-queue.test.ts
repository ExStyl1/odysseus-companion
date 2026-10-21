/**
 * Tests for SessionPersistenceQueue in sessions/persistence-queue.ts
 *
 * Key behavior: Writes to the same session must be serialized to prevent
 * race conditions when rapid successive flushes write to the same .tmp file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { SessionPersistenceQueue } from '../src/sessions/persistence-queue.ts';
import { SESSIONS_DIR } from '../src/workspaces/paths.ts';
import type { StoredSession } from '../src/sessions/types.ts';

/**
 * Line 1 of a session.jsonl — the header — or a throw naming the empty file.
 *
 * `split` always yields at least one element, but `noUncheckedIndexedAccess`
 * cannot know that, so `[0]` is `string | undefined` at five call sites here.
 * `JSON.parse(undefined as never)` would throw anyway; throwing HERE says the
 * file was empty instead of surfacing as a JSON syntax error about the word
 * "undefined".
 */
function headerOf(content: string): Record<string, unknown> {
  const [line] = content.split('\n');
  if (line === undefined || line === '') {
    throw new Error('session.jsonl has no header line');
  }
  return JSON.parse(line) as Record<string, unknown>;
}

// Create a minimal stored session for testing (global v2 layout, keyed by workspaceId)
function createTestSession(
  id: string,
  workspaceId: string,
  sdkSessionId?: string
): StoredSession {
  return {
    id,
    workspaceId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastMessageAt: Date.now(),
    messages: [],
    sdkSessionId,
    // `tokenUsage` is REQUIRED on StoredSession and this fixture omitted it,
    // which the `as StoredSession` cast below used to hide. A fixture less
    // specified than the type it stands for is the shape that manufactures a
    // false red the day a default is removed — so it is filled in and the cast
    // is gone, leaving the compiler to check the literal against the type.
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
}

describe('SessionPersistenceQueue', () => {
  let workspaceId: string;
  let queue: SessionPersistenceQueue;

  beforeEach(() => {
    // Unique throwaway workspace partition under the global sessions dir
    workspaceId = `pq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Use 0ms debounce for immediate writes in tests
    queue = new SessionPersistenceQueue(0);
  });

  afterEach(() => {
    const dir = join(SESSIONS_DIR, workspaceId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically replaces an existing session file', async () => {
    const session = createTestSession('test-session', workspaceId, 'sdk-123');
    queue.enqueue(session);
    await queue.flush({ workspaceId, sessionId: 'test-session' });

    const filePath = join(SESSIONS_DIR, workspaceId, 'test-session', 'session.jsonl');
    expect(existsSync(filePath)).toBe(true);

    queue.enqueue(createTestSession('test-session', workspaceId, 'sdk-456'));
    await queue.flush({ workspaceId, sessionId: 'test-session' });

    const content = readFileSync(filePath, 'utf-8');
    const header = headerOf(content);
    expect(header.sdkSessionId).toBe('sdk-456');
  });

  it('serializes concurrent flushes for the same session', async () => {
    // This test verifies the fix for the race condition where
    // clearSessionForRecovery() + onSdkSessionIdUpdate() would
    // both flush rapidly and corrupt each other's writes.

    // Simulate the problematic sequence:
    // 1. First write with sdkSessionId = undefined (clearing)
    const session1 = createTestSession('test-session', workspaceId, undefined);
    queue.enqueue(session1);
    const flush1 = queue.flush({ workspaceId, sessionId: 'test-session' });

    // 2. Second write with new sdkSessionId (before first completes)
    const session2 = createTestSession('test-session', workspaceId, 'new-thread-id');
    queue.enqueue(session2);
    const flush2 = queue.flush({ workspaceId, sessionId: 'test-session' });

    // Wait for both to complete
    await Promise.all([flush1, flush2]);

    // The final file should have the NEWER data (new-thread-id)
    const filePath = join(SESSIONS_DIR, workspaceId, 'test-session', 'session.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const header = headerOf(content);

    // Before the fix, this could randomly be undefined due to race condition
    expect(header.sdkSessionId).toBe('new-thread-id');
  });

  it('serializes a debounced write with an immediate flush for the same session', async () => {
    const key = { workspaceId, sessionId: 'test-session' };
    const write = (
      queue as unknown as {
        // The parameter was named `key` and typed `typeof key`, which resolves
        // to the parameter, not to the const above it (TS2502). Spelling the
        // shape breaks the cycle and does not depend on a name in scope.
        write(target: { workspaceId: string; sessionId: string }, strict: boolean): Promise<void>;
      }
    ).write.bind(queue);

    queue.enqueue(createTestSession(key.sessionId, workspaceId, 'debounced-write'));
    const debouncedWrite = write(key, true);

    queue.enqueue(createTestSession(key.sessionId, workspaceId, 'immediate-flush'));
    const immediateFlush = queue.flush(key, { strict: true });

    await expect(Promise.all([debouncedWrite, immediateFlush])).resolves.toBeDefined();

    const content = readFileSync(
      join(SESSIONS_DIR, workspaceId, key.sessionId, 'session.jsonl'),
      'utf-8'
    );
    expect(headerOf(content).sdkSessionId).toBe('immediate-flush');
  });

  it('allows parallel writes to different sessions', async () => {
    // Different sessions should write in parallel without blocking each other
    const sessionA = createTestSession('session-a', workspaceId, 'id-a');
    const sessionB = createTestSession('session-b', workspaceId, 'id-b');

    queue.enqueue(sessionA);
    queue.enqueue(sessionB);

    // Flush both in parallel
    await Promise.all([
      queue.flush({ workspaceId, sessionId: 'session-a' }),
      queue.flush({ workspaceId, sessionId: 'session-b' }),
    ]);

    // Both should be written correctly
    const contentA = readFileSync(
      join(SESSIONS_DIR, workspaceId, 'session-a', 'session.jsonl'),
      'utf-8'
    );
    const contentB = readFileSync(
      join(SESSIONS_DIR, workspaceId, 'session-b', 'session.jsonl'),
      'utf-8'
    );

    expect(headerOf(contentA).sdkSessionId).toBe('id-a');
    expect(headerOf(contentB).sdkSessionId).toBe('id-b');
  });

  it('propagates a real write failure only through the strict flush seam', async () => {
    const key = { workspaceId, sessionId: 'strict-write-failure' };
    const session = createTestSession(key.sessionId, workspaceId);
    const sessionDir = join(SESSIONS_DIR, workspaceId, key.sessionId);
    mkdirSync(join(sessionDir, 'session.jsonl.tmp'), { recursive: true });

    queue.enqueue(session);
    await expect(queue.flush(key, { strict: true })).rejects.toThrow();

    queue.enqueue(session);
    await expect(queue.flush(key)).resolves.toBeUndefined();
  });

  it('fences persistence and waits for an atomic writer before deletion', async () => {
    const key = { workspaceId, sessionId: 'delete-barrier' };
    let releaseWrite!: () => void;
    let markWriteEntered!: () => void;
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    const writeEntered = new Promise<void>(resolve => { markWriteEntered = resolve; });
    queue = new SessionPersistenceQueue(0, {
      beforeAtomicRename: async () => {
        markWriteEntered();
        await writeGate;
      },
    });

    queue.enqueue(createTestSession(key.sessionId, workspaceId, 'held-write'));
    const flush = queue.flush(key, { strict: true });
    await writeEntered;
    let barrierSettled = false;
    const barrier = queue.cancelAndWait(key).then(() => { barrierSettled = true; });
    queue.enqueue(createTestSession(key.sessionId, workspaceId, 'must-not-resurrect'));
    await Bun.sleep(5);
    expect(barrierSettled).toBe(false);
    expect(queue.isDeleteFenced(key)).toBe(true);

    releaseWrite();
    await expect(Promise.all([flush, barrier])).resolves.toBeDefined();
    const sessionDir = join(SESSIONS_DIR, workspaceId, key.sessionId);
    rmSync(sessionDir, { recursive: true, force: true });
    await queue.flush(key, { strict: true });
    await Bun.sleep(5);
    expect(existsSync(sessionDir)).toBe(false);
    expect(queue.hasPending(key)).toBe(false);
  });
});
