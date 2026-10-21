/**
 * The four documented task tools (R20).
 *
 * `agent-sdk/todo-tracking.md` § "Migrate to Task tools" scopes key repair
 * exactly: "Claude Code repairs some close-but-incorrect key names before
 * execution, mapping `id` or `task_id` to `taskId` and `active_form` to
 * `activeForm`, but that repair is not reflected in the stream." Two mappings,
 * and the stream keeps the raw model shape — so the repair works on a COPY and
 * the caller's object is never mutated.
 *
 * Placement follows the existing precedent: `handleMonitor` maps `timeout_ms`
 * and `handleBashOutput` maps `shell_id`, both inside the handler, before the
 * port call.
 */
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import type { DocumentedTaskCommand, DocumentedTaskResult } from '../tasks/documented-tasks.ts';
import {
  TaskCreateSchema,
  TaskGetSchema,
  TaskListSchema,
  TaskUpdateSchema,
} from '../tool-defs.ts';

/**
 * The two documented repairs and nothing else. General snake_case coercion is
 * explicitly NOT the contract — `add_blocked_by` stays as the model wrote it.
 *
 * Returns a new object; the input is never touched, because the input is what
 * the stream already carries.
 */
export function repairTaskToolInput(raw: Record<string, unknown>): Record<string, unknown> {
  const repaired: Record<string, unknown> = { ...raw };
  // A canonical key always wins over its alias — repairing over a value the
  // model got right would be a downgrade, not a repair.
  for (const alias of ['id', 'task_id']) {
    if (alias in repaired) {
      if (repaired.taskId === undefined) repaired.taskId = repaired[alias];
      delete repaired[alias];
    }
  }
  if ('active_form' in repaired) {
    if (repaired.activeForm === undefined) repaired.activeForm = repaired.active_form;
    delete repaired.active_form;
  }
  return repaired;
}

type DocumentedTaskPort = {
  executeDocumented(command: DocumentedTaskCommand): Promise<DocumentedTaskResult>;
};

function documentedPort(ctx: SessionToolContext): DocumentedTaskPort | undefined {
  const port = ctx.taskPort as Partial<DocumentedTaskPort> | undefined;
  return typeof port?.executeDocumented === 'function' ? (port as DocumentedTaskPort) : undefined;
}

async function dispatch(
  ctx: SessionToolContext,
  toolName: string,
  build: () => DocumentedTaskCommand,
): Promise<ToolResult> {
  const port = documentedPort(ctx);
  if (!port) return errorResponse(`${toolName} is unavailable for this backend.`);
  try {
    return successResponse(JSON.stringify(await port.executeDocumented(build())));
  } catch (error) {
    return errorResponse(`${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function invalid(toolName: string, issues: { path: PropertyKey[]; message: string }[]): ToolResult {
  const detail = issues
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return errorResponse(`${toolName} input is invalid — ${detail}`);
}

export async function handleTaskCreate(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // A model-supplied `id` is dropped here and ignored by the reducer: the
  // harness mints the id and returns it in the result.
  const parsed = TaskCreateSchema.safeParse(repairTaskToolInput(args));
  if (!parsed.success) return invalid('TaskCreate', parsed.error.issues);
  return dispatch(ctx, 'TaskCreate', () => ({ op: 'create', ...parsed.data }));
}

export async function handleTaskUpdate(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = TaskUpdateSchema.safeParse(repairTaskToolInput(args));
  if (!parsed.success) return invalid('TaskUpdate', parsed.error.issues);
  return dispatch(ctx, 'TaskUpdate', () => ({ op: 'update', ...parsed.data }));
}

export async function handleTaskGet(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = TaskGetSchema.safeParse(repairTaskToolInput(args));
  if (!parsed.success) return invalid('TaskGet', parsed.error.issues);
  return dispatch(ctx, 'TaskGet', () => ({ op: 'get', taskId: parsed.data.taskId }));
}

export async function handleTaskList(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = TaskListSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid('TaskList', parsed.error.issues);
  return dispatch(ctx, 'TaskList', () => ({ op: 'list' }));
}
