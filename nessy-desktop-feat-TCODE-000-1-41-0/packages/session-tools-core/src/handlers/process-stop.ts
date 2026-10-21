import type { SessionToolContext } from '../context.ts'
import type { ToolResult } from '../types.ts'
import { errorResponse, successResponse } from '../response.ts'

export interface ProcessStopArgs {
  shell_id: string
}

export async function handleProcessStop(
  ctx: SessionToolContext,
  args: ProcessStopArgs,
): Promise<ToolResult> {
  const shellId = args.shell_id?.trim()
  if (!shellId) return errorResponse('shell_id is required.')
  if (!ctx.monitor && !ctx.stopBackgroundShell) {
    return errorResponse('ProcessStop is not available in this context.')
  }
  try {
    // One identifier space, two producers. Monitors are asked first because a
    // monitor taskId is a handle in the SAME owner-bound registry; a `false`
    // answer means "not a monitor of this session", not "not found".
    if (ctx.monitor && await ctx.monitor.stop(shellId)) {
      return successResponse(`Stopped monitor\ntaskId: ${shellId}`)
    }
    if (!ctx.stopBackgroundShell) return errorResponse(`Unknown shell_id: ${shellId}`)
    await ctx.stopBackgroundShell(shellId)
    return successResponse(`Stopped background shell\nshell_id: ${shellId}`)
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error))
  }
}
