import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { readTodoStateFile, getTodoStateFilePath } from '../todo-state.ts';
import { handleTodoWrite } from './todo-write.ts';

function makeContext(dataPath?: string): SessionToolContext {
  return {
    configRoot: '/config',
    sessionId: 'session-1',
    workspacePath: '/workspace',
    get sourcesPath() { return '/workspace/sources'; },
    get skillsPath() { return '/workspace/skills'; },
    plansFolderPath: '/workspace/sessions/session-1/plans',
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    fs: {} as SessionToolContext['fs'],
    loadSourceConfig: () => null,
    dataPath,
  } as SessionToolContext;
}

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-write-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function text(result: Awaited<ReturnType<typeof handleTodoWrite>>): string {
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('handleTodoWrite', () => {
  it('writes a todo list to the session data folder', async () => {
    await withTempDir(async (dir) => {
      const result = await handleTodoWrite(makeContext(dir), {
        todos: [
          { content: 'Investigate', status: 'completed' },
          { content: 'Patch', status: 'in_progress' },
        ],
      });

      expect(result.isError).toBe(false);
      const persisted = readTodoStateFile(getTodoStateFilePath(dir));
      expect(persisted.todos.map(todo => todo.status)).toEqual(['completed', 'in_progress']);
      expect(text(result)).toContain('"content": "Patch"');
    });
  });

  it('lists the saved todo list when todos is omitted', async () => {
    await withTempDir(async (dir) => {
      await handleTodoWrite(makeContext(dir), {
        todos: [{ id: 'task-a', content: 'List me', status: 'pending' }],
      });

      const result = await handleTodoWrite(makeContext(dir), {});
      expect(result.isError).toBe(false);
      expect(text(result)).toContain('"id": "task-a"');
      expect(text(result)).toContain('"status": "pending"');
    });
  });

  it('updates by replacing the saved list', async () => {
    await withTempDir(async (dir) => {
      await handleTodoWrite(makeContext(dir), {
        todos: [{ id: 'task-a', content: 'Original', status: 'pending' }],
      });
      await handleTodoWrite(makeContext(dir), {
        todos: [{ id: 'task-a', content: 'Original', status: 'completed' }],
      });

      const state = readTodoStateFile(getTodoStateFilePath(dir));
      expect(state.todos).toEqual([
        { id: 'task-a', content: 'Original', status: 'completed', activeForm: 'Original' },
      ]);
    });
  });

  it('returns an error when dataPath is unavailable', async () => {
    const result = await handleTodoWrite(makeContext(undefined), {
      todos: [{ content: 'No path', status: 'pending' }],
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('TodoWrite requires dataPath');
  });
});
