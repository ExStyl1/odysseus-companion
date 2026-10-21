/**
 * UA1.18 — `list_artifacts`: the pages the CALLING session published, read from this workspace's artifact registry
 * (`packages/shared/src/artifacts/registry.ts` `listSessionArtifacts`) by the host closure behind
 * `ctx.listArtifacts`. Other sessions' pages are never returned, and the service's full `/mine` list (every page the
 * user owns, from any session or tool) is UI-only (UA1.19): a model that could enumerate it could update pages it
 * never wrote.
 *
 * Read-only by nature (`safeMode: 'allow'`, `readOnly: true`): it reads a host file and makes no request, so it
 * carries `readOnlyHint` and runs in Plan on every runtime, as `list_sessions` does (UA1.8's rule).
 */
import { z } from 'zod/v3';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export const LIST_ARTIFACTS_DESCRIPTION = `List the pages THIS session published with publish_artifact: id, title, link and expiry (null = never expires).

Use it to find the link to pass as url when the user asks to update a page. Pages published from other sessions are not listed; the user sees all of their pages in the app.`;

export const ListArtifactsSchema = z.object({});

export async function handleListArtifacts(
  ctx: SessionToolContext,
  _args: Record<string, never>,
): Promise<ToolResult> {
  if (!ctx.listArtifacts) {
    return errorResponse('list_artifacts is not available in this context.');
  }
  try {
    const result = await ctx.listArtifacts();
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to list artifacts: ${message}`);
  }
}
