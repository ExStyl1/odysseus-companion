/**
 * Source Manage Handler
 *
 * Turning a source off, or removing it, from inside a session.
 *
 * Before this, an agent asked to remove a source could only raw-edit files —
 * forking the UI's DELETE channel, which does three things, not one. Both
 * actions run the same writers the UI runs: the validated `saveSourceConfig`
 * for `disable`, and the shared `removeSourceEverywhere` for `remove`.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import { sourceExists } from '../source-helpers.ts';

export interface SourceManageArgs {
  sourceSlug: string;
  action: 'disable' | 'remove';
}

export async function handleSourceManage(
  ctx: SessionToolContext,
  args: SourceManageArgs,
): Promise<ToolResult> {
  const { sourceSlug, action } = args;

  if (!sourceSlug) return errorResponse('sourceSlug is required.');
  if (action !== 'disable' && action !== 'remove') {
    return errorResponse(`Unknown action "${action}". Use "disable" or "remove".`);
  }
  if (!sourceExists(ctx.workspacePath, sourceSlug)) {
    return errorResponse(`Source "${sourceSlug}" does not exist in this workspace.`);
  }

  if (action === 'disable') {
    const config = ctx.loadSourceConfig(sourceSlug);
    if (!config) return errorResponse(`Source "${sourceSlug}" has no readable config.json.`);
    if (!ctx.saveSourceConfig) {
      return errorResponse('Disabling a source is not available in this context.');
    }
    // Through the VALIDATED writer, not a file write: the same path the UI and
    // `source_test`'s auto-enable use.
    ctx.saveSourceConfig({ ...config, enabled: false });
    return successResponse(`Source "${sourceSlug}" is disabled. Its config and credentials are untouched; enable it again from Sources or with source_test.`);
  }

  if (!ctx.removeSource) {
    return errorResponse('Removing a source is not available in this context.');
  }
  try {
    await ctx.removeSource(sourceSlug);
  } catch (error) {
    // F1.409 — the removal LANDED and only revoking it from the running sessions failed: a success, with the failure
    // and the host's per-session counts beside it (F1.211's rule, F1.265's summary).
    const revokeFailure = revokeFailureAfterRemoval(error);
    if (revokeFailure) {
      return successResponse(`Source "${sourceSlug}" was removed: its folder is deleted and the workspace default list no longer names it. ${revokeFailure}`);
    }
    // A host that wired the seam but not its callback throws here; that is a
    // refusal to report, not a crash to propagate into the turn.
    return errorResponse(`Removing "${sourceSlug}" failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return successResponse(`Source "${sourceSlug}" was removed: its folder is deleted, the workspace default list no longer names it, and active sessions have had it revoked.`);
}

/**
 * F1.409 — the sentence for a removal whose folder and default-list steps landed and whose revoke threw
 * (`removeSourceEverywhere` marks that throw `sourceRemoved`; this package cannot import it, so the shape is read
 * structurally, as `plugin-management-tools.ts` reads the same summary). Returns undefined for every other throw.
 */
function revokeFailureAfterRemoval(error: unknown): string | undefined {
  if ((error as { sourceRemoved?: unknown } | null)?.sourceRemoved !== true) return undefined;
  const reason = error instanceof Error ? error.message : String(error);
  const summary = ((error as { cause?: unknown }).cause as { summary?: unknown } | null | undefined)?.summary as {
    applied?: number; reloaded?: number; deferred?: number; untouched?: number; failed?: number;
    failures?: Array<{ sessionId?: string }>; otherWorkspaces?: { sessions?: number; failed?: number };
  } | undefined;
  let counts = '';
  if (summary && typeof summary.failed === 'number') {
    const failedIds = (summary.failures ?? []).map(failure => String(failure.sessionId));
    counts = ` — sessions: ${summary.applied ?? 0} applied, ${summary.reloaded ?? 0} reloaded, ${summary.deferred ?? 0} deferred, `
      + `${summary.untouched ?? 0} untouched, ${summary.failed} failed${failedIds.length > 0 ? ` (${failedIds.join(', ')})` : ''}`
      + (summary.otherWorkspaces
        ? `; plus ${summary.otherWorkspaces.sessions ?? 0} in other workspaces, ${summary.otherWorkspaces.failed ?? 0} of them failed`
        : '');
  }
  return `Revoking it from the sessions that were already running failed (${reason})${counts}. `
    + 'A session that was open during the removal may keep using it until its runtime restarts.';
}
