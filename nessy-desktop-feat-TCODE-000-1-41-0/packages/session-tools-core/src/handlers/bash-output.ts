import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface BashOutputArgs {
  shell_id: string;
  offset?: number;
}

export async function handleBashOutput(
  ctx: SessionToolContext,
  args: BashOutputArgs
): Promise<ToolResult> {
  const shellId = args.shell_id?.trim();
  if (!shellId) {
    return errorResponse('shell_id is required.');
  }

  if (!ctx.readBackgroundShellOutput) {
    return errorResponse('BashOutput is not available in this context.');
  }

  try {
    const result = await ctx.readBackgroundShellOutput(shellId, args.offset);
    if (!result) {
      return errorResponse(`Unknown shell_id: ${shellId}`);
    }

    return successResponse([
      `shell_id: ${result.shellId}`,
      `status: ${result.isRunning ? 'running' : 'exited'}`,
      `next_offset: ${result.nextOffset}`,
      'output:',
      result.output || '(no new output)',
    ].join('\n'));
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
}
