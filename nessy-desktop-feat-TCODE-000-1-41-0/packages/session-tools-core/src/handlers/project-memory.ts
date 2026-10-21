/**
 * UB1.12 — `project_memory_append`: add a dated note to the session's project MEMORY.md.
 * Copied from craft-agents-oss `v0.15.1:packages/session-tools-core/src/handlers/project-memory.ts`
 * (Apache-2.0); the docblock's storage reference rebranded. Append-only by design: sessions that
 * rewrote the file from their start-of-session snapshot dropped notes other sessions had added
 * meanwhile (measured at the premise, the row's two-session Pi drive). The file write lives behind
 * `ctx.appendProjectMemory` (projects storage in `@nessy-agent/shared`, bound by `SessionManager`
 * as `appendProjectMemoryFn` for every runtime).
 *
 * Same posture as `create_board_task` (UA3.5): every rule on the caller — which project, which
 * workspace, which session name — is the HOST closure's; the schema and description live here.
 */
import { z } from 'zod/v3';
import type { SessionToolContext, ProjectMemoryAppendInput } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

/** v0.15.1 `ProjectMemoryAppendSchema` (its `tool-defs.ts`), kept with the handler (the `create_board_task` rule). */
export const ProjectMemoryAppendSchema = z.object({
  note: z.string().max(4000).describe('Short Markdown note to add to the project memory (a dated heading naming this session is added)'),
});

export type ProjectMemoryAppendArgs = ProjectMemoryAppendInput;

export const PROJECT_MEMORY_APPEND_DESCRIPTION = `Add a note to this session's project memory (MEMORY.md, shown to every session in the project as <project_memory>). Append-only: the note is added at the end under a dated heading naming this session, and nothing else in the file changes.

Use it for durable project knowledge: a decision, a gotcha, a convention, a user preference. Keep notes short. Never rewrite MEMORY.md with Write/Edit — other sessions add notes while you work, and your <project_memory> is a snapshot from when this session started. To correct an outdated note, append the correction. Fails when the session has no project.`;

export async function handleProjectMemoryAppend(
  ctx: SessionToolContext,
  args: ProjectMemoryAppendArgs,
): Promise<ToolResult> {
  if (!ctx.appendProjectMemory) {
    return errorResponse('project_memory_append is not available in this context.');
  }
  if (!args.note?.trim()) {
    return errorResponse('note is required.');
  }

  try {
    const result = await ctx.appendProjectMemory(args);
    return successResponse(`Added to ${result.path} under "## ${result.heading}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to add the note: ${message}`);
  }
}
