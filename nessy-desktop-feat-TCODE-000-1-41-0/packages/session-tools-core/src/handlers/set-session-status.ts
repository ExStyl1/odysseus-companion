import type { ResolvedStatusResult, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SetSessionStatusArgs {
  sessionId?: string;
  status: string;
}

/**
 * UA1.2 (OQ-6) — the sentence an agent gets when it asks for a closed status.
 *
 * Adapted from upstream craft-agents `v0.13.4:packages/session-tools-core/src/handlers/set-session-status.ts`
 * (Apache-2.0): "board" became "the user", because a session's status is closed from the status menu as well as
 * from the board. Exported so the host closure answers with the same words on every runtime (UA1.3).
 */
export function closedStatusRefusal(resolved: string): string {
  return `Refusing to set the closed status "${resolved}". Closing a session (done or cancelled) is the user's decision — leave it to them. If the work is ready for review, set an open status such as "needs-review" instead.`;
}

/**
 * UA1.2 — the agent's status rule, given the workspace's resolution of `input`: an unknown status is refused with
 * the real ids, a status whose category is `closed` is refused, anything else passes as its resolved id.
 *
 * Keyed on CATEGORY rather than on the ids `done`/`cancelled`, so a workspace's own closed status is refused too.
 * The human owns closure; the host, the UI, the Conductor and the mini-agent's auto-`done` set statuses through
 * `SessionManager.setSessionStatus` directly and never reach this rule (spec §8).
 */
export function checkAgentSessionStatus(
  input: string,
  resolution: ResolvedStatusResult,
): { status: string } | { refusal: string } {
  const { resolved, available, category } = resolution;
  if (!resolved) {
    return { refusal: `Unknown status: "${input}". Available status IDs: ${available.join(', ')}` };
  }
  if (category === 'closed') return { refusal: closedStatusRefusal(resolved) };
  return { status: resolved };
}

export async function handleSetSessionStatus(
  ctx: SessionToolContext,
  args: SetSessionStatusArgs
): Promise<ToolResult> {
  if (!ctx.setSessionStatus) {
    return errorResponse('set_session_status is not available in this context.');
  }

  try {
    let status = args.status;

    // Resolve display name → ID, reject unknown and closed statuses (UA1.2)
    if (ctx.resolveStatus) {
      const verdict = checkAgentSessionStatus(status, await ctx.resolveStatus(status));
      if ('refusal' in verdict) return errorResponse(verdict.refusal);
      status = verdict.status;
    }

    await ctx.setSessionStatus(args.sessionId, status);
    const target = args.sessionId ? `session ${args.sessionId}` : 'current session';
    return successResponse(`Status set to "${status}" on ${target}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to set status: ${message}`);
  }
}
