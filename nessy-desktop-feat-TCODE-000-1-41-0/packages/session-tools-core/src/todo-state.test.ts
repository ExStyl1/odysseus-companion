import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getTodoStateFileMode,
  getTodoStateFilePath,
  normalizeTodoItems,
  readTodoStateFile,
  writeTodoStateFile,
} from './todo-state.ts';

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-state-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('todo state store', () => {
  it('returns an empty state for a missing todos.json', () => {
    withTempDir((dir) => {
      const state = readTodoStateFile(join(dir, 'todos.json'));
      expect(state.todos).toEqual([]);
      expect(state.updatedAt).toBeNull();
    });
  });

  it('writes and reads normalized todos with 0600 mode', () => {
    withTempDir((dir) => {
      const filePath = getTodoStateFilePath(dir);
      writeTodoStateFile(filePath, [
        { content: '  Draft plan  ', status: 'pending' },
        { id: 'custom-id', content: 'Ship patch', status: 'in_progress', activeForm: 'Shipping patch' },
      ], new Date('2026-07-06T00:00:00.000Z'));

      const state = readTodoStateFile(filePath);
      expect(state.updatedAt).toBe('2026-07-06T00:00:00.000Z');
      expect(state.todos).toEqual([
        { id: 'todo-1', content: 'Draft plan', status: 'pending', activeForm: 'Draft plan' },
        { id: 'custom-id', content: 'Ship patch', status: 'in_progress', activeForm: 'Shipping patch' },
      ]);
      expect(getTodoStateFileMode(filePath)).toBe(0o600);
    });
  });

  it('rejects empty todo content', () => {
    expect(() => normalizeTodoItems([
      { content: '   ', status: 'pending' },
    ])).toThrow('todos[0].content must not be empty');
  });
});
