import type { SessionToolContext } from '../context.ts';
import { errorResponse, successResponse } from '../response.ts';
import { GoalSchema } from '../tool-defs.ts';
import type { ToolResult } from '../types.ts';

async function execute(ctx: SessionToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.goalPort) return errorResponse('Goal is unavailable for this backend.');
  try {
    return successResponse(JSON.stringify(await ctx.goalPort.execute(args)));
  } catch (error) {
    return errorResponse(`Goal failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function handleGoalGet(ctx: SessionToolContext): Promise<ToolResult> {
  return execute(ctx, { action: 'get' });
}

/**
 * P2.2 — the command is parsed HERE, not only advertised.
 *
 * `GoalSchema` is a discriminated union of `.strict()` objects, and the surface
 * that advertises it is not the same on every runtime: Pi and the external
 * subprocess advertise the union as JSON Schema, while the Claude in-process
 * MCP server can only take a flat object shape (the SDK's `tool()` accepts a
 * Zod RAW SHAPE and nothing else), so it advertises the union FLATTENED. A
 * flattened advertisement cannot express "complete requires evidence", which is
 * why the union is applied to the arguments here: one validator, the same
 * refusal text, on every runtime, whatever each one was able to advertise.
 *
 * The `handleCronCreate` pattern verbatim — a parse failure is a recoverable
 * result naming the offending fields, never a throw.
 */
export function handleGoal(ctx: SessionToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const parsed = GoalSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return Promise.resolve(errorResponse(`Goal input is invalid — ${detail}`));
  }
  return execute(ctx, parsed.data as unknown as Record<string, unknown>);
}
