import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TODO_STATE_FILE_NAME = 'todos.json';
export const TODO_STATE_VERSION = 1;
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export type TodoStatus = typeof TODO_STATUSES[number];

export interface TodoItemInput {
  id?: string;
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  activeForm: string;
}

export interface TodoState {
  version: typeof TODO_STATE_VERSION;
  updatedAt: string | null;
  todos: TodoItem[];
}

export function getTodoStateFilePath(dataPath: string): string {
  return join(dataPath, TODO_STATE_FILE_NAME);
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (TODO_STATUSES as readonly string[]).includes(value);
}

export function normalizeTodoItems(todos: TodoItemInput[]): TodoItem[] {
  return todos.map((todo, index) => {
    const content = todo.content.trim();
    if (!content) {
      throw new Error(`todos[${index}].content must not be empty`);
    }
    if (!isTodoStatus(todo.status)) {
      throw new Error(`todos[${index}].status must be pending, in_progress, or completed`);
    }

    return {
      id: todo.id?.trim() || `todo-${index + 1}`,
      content,
      status: todo.status,
      activeForm: todo.activeForm?.trim() || content,
    };
  });
}

function emptyTodoState(): TodoState {
  return {
    version: TODO_STATE_VERSION,
    updatedAt: null,
    todos: [],
  };
}

function parseTodoState(raw: string): TodoState {
  const parsed = JSON.parse(raw) as Partial<TodoState>;
  if (!Array.isArray(parsed.todos)) {
    throw new Error('Todo state file is missing todos array');
  }
  return {
    version: TODO_STATE_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    todos: normalizeTodoItems(parsed.todos as TodoItemInput[]),
  };
}

export function readTodoStateFile(filePath: string): TodoState {
  if (!existsSync(filePath)) return emptyTodoState();
  return parseTodoState(readFileSync(filePath, 'utf-8'));
}

export function writeTodoStateFile(
  filePath: string,
  todos: TodoItemInput[],
  now: Date = new Date(),
): TodoState {
  const state: TodoState = {
    version: TODO_STATE_VERSION,
    updatedAt: now.toISOString(),
    todos: normalizeTodoItems(todos),
  };

  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, filePath);
  chmodSync(filePath, 0o600);
  return state;
}

export function getTodoStateFileMode(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mode & 0o777;
}
