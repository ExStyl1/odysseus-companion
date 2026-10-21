/**
 * UA3.5 — `create_board_task`: put a task on the workspace's task board (its `tasks/<slug>/task.yaml` plus an
 * orchestrator session in "todo") WITHOUT running it. Adapted from craft-agents-oss
 * `v0.13.4:packages/session-tools-core/src/handlers/create-task.ts` (Apache-2.0), with the schema and description
 * from `v0.13.4:packages/session-tools-core/src/tool-defs.ts` (`CreateTaskSchema`, `TOOL_DESCRIPTIONS.create_task`).
 *
 * Stated divergences from v0.13.4 (spec §10 "`create_board_task`", OQ-8):
 * - **Renamed** `create_task` → `create_board_task`: "task" already names the in-session checklist and background
 *   work on every runtime (spec §22 item 8), so the board tool says where the task goes. The description contrasts
 *   it with "your in-session checklist or plan tool" and names no tool (each runtime has its own).
 * - **No restriction lives here.** Upstream's handler only checked the two strings; ours does the same. Every rule
 *   on the invoking agent — its own folder (`project-handle-required`), its project or one over that folder, a subset
 *   of its enabled sources, its own connection, no permission mode — is the HOST closure's behind `ctx.createBoardTask`
 *   (`server-core/src/tasks/create-board-task.ts`), the one seam a session tool reaches on all three runtimes: Pi and
 *   Claude in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.taskCreate`. A copy here would be a per-runtime
 *   re-statement of a host decision.
 * - The description says what the host enforces, so a model is not surprised by the refusal.
 */
import { z } from 'zod/v3';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export const CREATE_BOARD_TASK_DESCRIPTION = `Create a task on the workspace's task board: writes tasks/<slug>/task.yaml and creates the task's orchestrator session. CREATION ONLY: the task lands in "todo" and is NOT run; starting it is the user's decision.

Provide title + description (the description becomes the task goal and the prompt of its single node). Optional: acceptanceCriteria (the rubric the result is verified against), sources and skills (workspace slugs), llmConnection + model, workingDirectory, projectId.

The task stays where you are: it runs in your own working folder, on your own connection, with your own permission mode, and with sources taken from the ones enabled in this session (all of them when sources is omitted). It goes to your own project, or to another project only when that project is bound to this session's own folder. A different folder or connection, a project bound elsewhere, or a source this session has not enabled, is refused.

Returns { slug, orchestratorSessionId, taskLabelId, warnings } — unknown source or skill slugs are reported as warnings, not errors. Use it when the user asks to capture or queue work as a task on the board; for the steps you are working through right now, use your in-session checklist or plan tool, and to run work right now use the current session.`;

export const CreateBoardTaskSchema = z.object({
  title: z.string().describe('Short task title shown on the board (also drives the slug)'),
  description: z.string().describe('What the task should accomplish — becomes the task goal and the initial node prompt'),
  acceptanceCriteria: z.string().optional().describe('Freeform rubric the final result is verified against'),
  sources: z.array(z.string()).optional().describe('Source slugs to enable on the task sessions — only sources enabled in this session (default: all of them)'),
  skills: z.array(z.string()).optional().describe('Skill slugs applied to dispatched task prompts'),
  llmConnection: z.string().optional().describe('LLM connection slug serving the model — only this session\'s own connection'),
  model: z.string().optional().describe('Model ID for the task sessions (workspace default when omitted)'),
  workingDirectory: z.string().optional().describe('Working directory for the task sessions — only this session\'s own folder (the default)'),
  projectId: z.string().optional().describe("Project ID to bind the task to (defaults to the invoking session's project; another project only when it is bound to this session's own folder)"),
});

export type CreateBoardTaskArgs = z.infer<typeof CreateBoardTaskSchema>;

export async function handleCreateBoardTask(
  ctx: SessionToolContext,
  args: CreateBoardTaskArgs,
): Promise<ToolResult> {
  if (!ctx.createBoardTask) {
    return errorResponse('create_board_task is not available in this context.');
  }
  if (!args.title?.trim()) {
    return errorResponse('title is required.');
  }
  if (!args.description?.trim()) {
    return errorResponse('description is required.');
  }

  try {
    const result = await ctx.createBoardTask(args);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to create task: ${message}`);
  }
}
