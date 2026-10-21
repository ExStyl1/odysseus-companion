/**
 * P6.466 — `archive_session`, the agent verb for closing one of your own other
 * sessions.
 *
 * The host verb already existed end to end (`SessionManager.archiveSession` /
 * `unarchiveSession`, with an RPC in front); what was missing was the tool
 * declaration, this handler, and the approval floor. RENAMING was already
 * `partial` through `set_session_labels`; archiving was absent as an agent verb
 * only.
 *
 * This handler deliberately carries NO approval logic of its own. The card is
 * raised by the host closure behind `ctx.archiveSession`, for the reason written
 * on that port in `context.ts`: it is the only seam a session MCP tool reaches
 * on all three runtimes, so a floor placed anywhere else is silently absent on
 * one of them. A second check here would be a per-runtime copy of a host-side
 * decision — the exact shape native-first exists to stop.
 */
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface ArchiveSessionArgs {
  sessionId?: string;
  archived?: boolean;
}

export async function handleArchiveSession(
  ctx: SessionToolContext,
  args: ArchiveSessionArgs
): Promise<ToolResult> {
  if (!ctx.archiveSession) {
    return errorResponse('archive_session is not available in this context.');
  }

  // Absent means archive: the tool's name is the common case, and a model that
  // omits the flag meant the thing the tool is called. Unarchiving is the
  // explicit `archived: false`.
  const archived = args.archived !== false;
  const target = args.sessionId ? `session ${args.sessionId}` : 'the current session';
  const verb = archived ? 'Archived' : 'Unarchived';

  try {
    const verdict = await ctx.archiveSession(args.sessionId, archived);
    switch (verdict.status) {
      case 'applied':
        return successResponse(verdict.note ?? `${verb} ${target}.`);
      case 'unchanged':
        return successResponse(
          verdict.note ?? `${target} was already ${archived ? 'archived' : 'not archived'}; nothing changed.`
        );
      case 'denied':
        // An error rather than a success with a note: `done_means` (c) requires
        // the refusal to reach the caller as a refusal, or a model reads a
        // denial as a completed archive and moves on.
        return errorResponse(
          verdict.note ?? `The request to ${archived ? 'archive' : 'unarchive'} ${target} was declined.`
        );
      case 'not-found':
        return errorResponse(
          verdict.note
            ?? `${target} was not found. Sessions can be addressed only inside your own workspace on this machine — `
              + `use list_sessions to see the ones reachable from here.`
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to ${archived ? 'archive' : 'unarchive'} ${target}: ${message}`);
  }
}
