import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import {
  getTodoStateFilePath,
  readTodoStateFile,
  writeTodoStateFile,
  type TodoItemInput,
} from '../todo-state.ts';

export interface TodoWriteArgs {
  todos?: TodoItemInput[];
}

export async function handleTodoWrite(
  ctx: SessionToolContext,
  args: TodoWriteArgs
): Promise<ToolResult> {
  if (!ctx.dataPath) {
    return errorResponse('TodoWrite requires dataPath in context.');
  }

  try {
    const filePath = getTodoStateFilePath(ctx.dataPath);
    const state = Array.isArray(args.todos)
      ? writeTodoStateFile(filePath, args.todos)
      : readTodoStateFile(filePath);

    return successResponse(JSON.stringify({
      filePath,
      todos: state.todos,
      updatedAt: state.updatedAt,
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`TodoWrite failed: ${message}`);
  }
}
