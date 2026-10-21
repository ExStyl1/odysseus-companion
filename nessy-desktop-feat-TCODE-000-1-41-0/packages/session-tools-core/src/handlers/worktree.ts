import type { SessionToolContext, WorktreeEnterInput } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface EnterWorktreeArgs {
  path?: string;
  name?: string;
  /** P6.333 — carry the checkout's uncommitted changes in with the session. */
  carryWork?: boolean;
  /** P6.336 (b) — create it permanent: exempt from the automatic sweep by name. */
  permanent?: boolean;
}

/**
 * `EnterWorktree` — create a worktree, or switch into an existing one.
 *
 * The handler does NO permission work. Whether entering this path needed a
 * human was decided by the gate before the call reached here (the
 * `worktreeApproval` floor in `runPreToolUseChecks`), and whether the target is
 * a legal one for a worktree-scoped session was decided there too. Re-deciding
 * either here would be a second copy of a security rule.
 */
export async function handleEnterWorktree(
  ctx: SessionToolContext,
  args: EnterWorktreeArgs,
): Promise<ToolResult> {
  if (!ctx.worktree) {
    return errorResponse('EnterWorktree is not available: this session has no repository to create or enter a worktree in.');
  }

  const path = typeof args.path === 'string' ? args.path.trim() : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const input: WorktreeEnterInput = {
    ...(path ? { path } : (name ? { name } : {})),
    ...(args?.carryWork === true ? { carryWork: true } : {}),
    ...(args?.permanent === true ? { permanent: true } : {}),
  };

  try {
    const location = await ctx.worktree.enter(input);
    return successResponse([
      location.created
        ? `Created worktree ${location.path}`
        : `Entered worktree ${location.path}`,
      `Branch: ${location.branch}`,
      `Working directory moved from ${location.previousWorkingDirectory}.`,
      // P6.333 — a REFUSED carry is reported here, not thrown, for the same
      // reason a refused removal is on the way out: the destination already
      // holding work is a normal outcome of asking, and the session HAS moved.
      ...(location.carry ? [location.carry.summary] : []),
      'Call ExitWorktree to move back.',
    ].join('\n'));
  } catch (error) {
    return errorResponse(`EnterWorktree failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface ExitWorktreeArgs {
  remove?: boolean;
  /** P6.333 — carry the worktree's uncommitted changes back to the checkout. */
  carryWork?: boolean;
}

/**
 * `ExitWorktree` — move back to the launch directory, keeping or removing the
 * worktree.
 *
 * `Permission required: No`. Calling it outside a worktree is a no-op success,
 * not an error: a tool the model is told it may always call must not be able to
 * fail a turn by being called when there is nothing to undo.
 *
 * P6.22 — a REFUSED removal is reported the same way, as a success carrying the
 * reason and the branch. The worktree still holding work is the normal outcome
 * of asking to remove one, not a tool failure, and the branch is what the user
 * needs to reach that work afterwards.
 */
export async function handleExitWorktree(
  ctx: SessionToolContext,
  args: ExitWorktreeArgs,
): Promise<ToolResult> {
  if (!ctx.worktree) {
    return errorResponse('ExitWorktree is not available: this session has no repository.');
  }

  try {
    const moved = await ctx.worktree.exit({
      ...(args?.remove === true ? { remove: true } : {}),
      ...(args?.carryWork === true ? { carryWork: true } : {}),
    });
    if (!moved) return successResponse('This session is not in a worktree; nothing to exit.');
    const lines = [
      `Left worktree ${moved.previousWorkingDirectory}.`,
      `Working directory is now ${moved.path}.`,
      // P6.333 — before the removal lines, because the carry decides whether
      // the worktree still holds work at all.
      ...(moved.carry ? [moved.carry.summary] : []),
    ];
    if (moved.removal?.removed === true) {
      lines.push(`Removed the worktree and its branch ${moved.removal.branch}.`);
    } else if (moved.removal) {
      lines.push(
        `Kept the worktree: ${moved.removal.keptReason ?? 'it still holds work'}.`,
        `The work is on branch ${moved.removal.branch}; \`git checkout ${moved.removal.branch}\` reaches it from here.`,
      );
    }
    return successResponse(lines.join('\n'));
  } catch (error) {
    return errorResponse(`ExitWorktree failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface WorktreeBatchArgs {
  tasks?: { name?: string; prompt?: string }[];
  branchPrefix?: string;
  bound?: number;
}

/**
 * `WorktreeBatch` (P6.508) — one request, N worktree-isolated agents.
 *
 * The tool is thin on purpose: the BOUND, the branch slugs and the deferral
 * list are `planWorktreeBatch`'s (`server-core/pi-harness/worktree-batch-plan.ts`),
 * and the fan-out is the host's. What lives here is the refusal path and the
 * rendering — including the one thing the row insists on, that `deferred` is
 * never swallowed: a caller has to be able to say which work did not start.
 *
 * `batch` is an OPTIONAL port member, so a host with no session factory behind
 * it answers "unavailable for this backend" instead of reporting a fan-out that
 * never happened — the same shape `ScheduleWakeup` uses.
 */
export async function handleWorktreeBatch(
  ctx: SessionToolContext,
  args: WorktreeBatchArgs,
): Promise<ToolResult> {
  if (!ctx.worktree?.batch) {
    return errorResponse('WorktreeBatch is not available: this session has no repository to create worktrees in.');
  }

  const tasks = (args?.tasks ?? [])
    .map(task => ({ name: String(task?.name ?? '').trim(), prompt: String(task?.prompt ?? '').trim() }))
    .filter(task => task.name.length > 0 && task.prompt.length > 0);
  if (tasks.length === 0) {
    return errorResponse('WorktreeBatch needs at least one task with a name and a prompt.');
  }
  const branchPrefix = String(args?.branchPrefix ?? '').trim();
  if (branchPrefix.length === 0) {
    // Not defaulted: a batch that quietly wrote to `feature/<name>` would put
    // its branches into whatever namespace the repository already uses, and the
    // caller is the only thing that knows which one is safe.
    return errorResponse('WorktreeBatch needs a branchPrefix, for example "batch/2026-09-08" — every branch it creates goes under that namespace.');
  }

  try {
    const outcome = await ctx.worktree.batch({
      tasks,
      branchPrefix,
      ...(typeof args?.bound === 'number' ? { bound: args.bound } : {}),
    });
    return successResponse(outcome.summary);
  } catch (error) {
    return errorResponse(`WorktreeBatch failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
