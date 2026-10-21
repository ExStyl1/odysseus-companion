import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface TaskArgs { action: 'create' | 'update' | 'delete' | 'list'; id?: string; title?: string; status?: 'pending' | 'in_progress' | 'completed'; blockedBy?: string[]; revision?: number; }

export async function handleTask(ctx: SessionToolContext, args: TaskArgs): Promise<ToolResult> {
  if (!ctx.taskPort) return errorResponse('Task is unavailable for this backend.');
  try { return successResponse(JSON.stringify(await ctx.taskPort.execute(args as unknown as Record<string, unknown>))); }
  catch (error) { return errorResponse(`Task failed: ${error instanceof Error ? error.message : String(error)}`); }
}
