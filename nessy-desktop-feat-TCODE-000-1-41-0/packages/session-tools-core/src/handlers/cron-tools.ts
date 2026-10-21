/**
 * `CronCreate`, `CronList` and `CronDelete` (R27b Task 3), plus `CronControl`
 * (P6.295 arm (2), documented on its own handler below).
 *
 * Contract source:
 * - `scheduled-tasks.md:164` — "`CronCreate` — Schedule a new task. Accepts a
 *   5-field cron expression, the prompt to run, and whether it recurs or fires
 *   once."
 * - `:165` — "`CronList` — List all scheduled tasks with their IDs, schedules,
 *   and prompts."
 * - `:166` — "`CronDelete` — Cancel a task by ID."
 * - `:168` — an 8-character ID; 50 tasks per session.
 * - `tools-reference.md:25`–`:27` — all three are "Permission required: No".
 *
 * The expression is validated HERE, before the host is asked to store anything,
 * so an unsupported token comes back as a tool error naming the token rather
 * than as a task that silently never fires (`scheduled-tasks.md:202`).
 */
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { CronDialectError, parseCronExpression } from '../scheduling/cron-dialect.ts';
import { CronControlSchema, CronCreateSchema, CronDeleteSchema, CronListSchema, ScheduleWakeupSchema } from '../tool-defs.ts';

type CronPort = NonNullable<SessionToolContext['cronPort']>;

function port(ctx: SessionToolContext, toolName: string): CronPort | ToolResult {
  const value = ctx.cronPort;
  if (!value) return errorResponse(`${toolName} is unavailable for this backend.`);
  return value;
}

function isToolResult(value: CronPort | ToolResult): value is ToolResult {
  return !('create' in value);
}

function invalid(toolName: string, issues: { path: PropertyKey[]; message: string }[]): ToolResult {
  const detail = issues
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return errorResponse(`${toolName} input is invalid — ${detail}`);
}

function failed(toolName: string, error: unknown): ToolResult {
  return errorResponse(`${toolName} failed: ${error instanceof Error ? error.message : String(error)}`);
}

export async function handleCronCreate(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = CronCreateSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid('CronCreate', parsed.error.issues);

  // R39 — a self-paced loop has no expression to validate: its fire times are
  // the wakeups `ScheduleWakeup` arms. Everything else still requires one.
  if (!parsed.data.dynamic) {
    if (!parsed.data.schedule) {
      return errorResponse(
        'CronCreate needs `schedule` (a 5-field cron expression) unless `dynamic: true` starts a self-paced /loop.',
      );
    }
    try {
      parseCronExpression(parsed.data.schedule);
    } catch (error) {
      if (error instanceof CronDialectError) {
        return errorResponse(
          `CronCreate rejected the schedule: ${error.message} Supported syntax is 5 fields ` +
            '(minute hour day-of-month month day-of-week) with wildcards, single values, steps, ' +
            'ranges and comma-separated lists — or a calendar recurrence rule such as ' +
            '"FREQ=MONTHLY;BYMONTHDAY=1".',
        );
      }
      return failed('CronCreate', error);
    }
  }

  const resolved = port(ctx, 'CronCreate');
  if (isToolResult(resolved)) return resolved;

  try {
    const record = await resolved.create({
      ...(parsed.data.schedule ? { schedule: parsed.data.schedule } : {}),
      // `:164` — "whether it recurs or fires once". Recurring is the default,
      // because `/loop`-style polling is what the tool is documented for and a
      // one-shot is the explicitly-asked-for case (`:136`).
      recurring: parsed.data.recurring ?? true,
      prompt: parsed.data.prompt,
      ...(parsed.data.dynamic ? { dynamic: true } : {}),
      ...(parsed.data.promptSource ? { promptSource: parsed.data.promptSource } : {}),
      // P6.376 — forwarded only when given, so the create call for a record
      // with neither is byte-identical to the one made before they existed.
      ...(parsed.data.model ? { model: parsed.data.model } : {}),
      ...(parsed.data.effort ? { effort: parsed.data.effort } : {}),
    });
    return {
      content: [{
        type: 'text',
        text: `Scheduled task ${record.id}: ${record.schedule} (${record.recurring ? 'recurring' : 'one-shot'}) — ${record.prompt}`,
      }],
      structuredContent: { task: record },
      isError: false,
    };
  } catch (error) {
    return failed('CronCreate', error);
  }
}

export async function handleCronList(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = CronListSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid('CronList', parsed.error.issues);

  const resolved = port(ctx, 'CronList');
  if (isToolResult(resolved)) return resolved;

  try {
    // `:165` — "their IDs, schedules, and prompts". `recurring` rides along
    // because it is one of the four fields `hooks.md:2205-2210` gives a
    // `session_crons` entry, and a list that hid it would make a one-shot
    // indistinguishable from a recurring task at the same time of day.
    const tasks = await resolved.list();
    // P6.295 arm (2) — the two state markers the row's `done_means` asks the
    // list to show. Both are rendered only when set, so a list of untouched
    // tasks is byte-identical to what this tool printed before: `paused`
    // because a task that fires nothing must not look armed, and the unread
    // count because `lastFiredAt` alone cannot tell a task that fired four
    // times overnight from one that fired once.
    const lines = tasks.map(task => {
      const markers = [
        task.paused ? 'paused' : '',
        task.unreadRuns ? `${task.unreadRuns} unread run${task.unreadRuns === 1 ? '' : 's'}` : '',
      ].filter(Boolean);
      const suffix = markers.length === 0 ? '' : `  [${markers.join(', ')}]`;
      return `${task.id}  ${task.schedule}  ${task.recurring ? 'recurring' : 'one-shot'}${suffix}  ${task.prompt}`;
    });
    return {
      content: [{
        type: 'text',
        text: tasks.length === 0 ? 'No scheduled tasks in this session.' : lines.join('\n'),
      }],
      structuredContent: { tasks },
      isError: false,
    };
  } catch (error) {
    return failed('CronList', error);
  }
}

/** `tools-reference.md:46` — the documented reschedule window, in ms. */
const WAKEUP_MIN_DELAY_MS = 60_000;
const WAKEUP_MAX_DELAY_MS = 3_600_000;

/**
 * `ScheduleWakeup` (R39) — re-arm or stop a self-paced `/loop`.
 *
 * `scheduled-tasks.md:130` — `stop: true` "cancels the pending wakeup
 * immediately". `tools-reference.md:46` — the delay window is one minute to
 * one hour; out-of-window values are CLAMPED (with a note) rather than
 * rejected, so an over-eager reschedule degrades to the documented bound
 * instead of leaving the iteration unrescheduled and triggering the fallback.
 */
export async function handleScheduleWakeup(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = ScheduleWakeupSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid('ScheduleWakeup', parsed.error.issues);

  // The wakeup methods are OPTIONAL port members: a backend that has the cron
  // port but no self-paced host fails through the same unavailable path as a
  // backend with no port at all.
  const value = ctx.cronPort;
  if (!value || !value.rearmWakeup || !value.stopWakeup) {
    return errorResponse('ScheduleWakeup is unavailable for this backend.');
  }

  if (parsed.data.stop) {
    try {
      const stopped = await value.stopWakeup();
      if (!stopped) {
        return errorResponse('ScheduleWakeup found no active self-paced loop to stop.');
      }
      return {
        content: [{ type: 'text', text: 'Self-paced loop ended — the pending wakeup is cancelled.' }],
        structuredContent: { stopped: true },
        isError: false,
      };
    } catch (error) {
      return failed('ScheduleWakeup', error);
    }
  }

  if (parsed.data.delaySeconds === undefined) {
    // Neither form was given: name the two valid ones rather than guessing.
    return errorResponse(
      'ScheduleWakeup needs either `delaySeconds` (60-3600) to schedule the next iteration, or `stop: true` to end the loop.',
    );
  }

  const requestedMs = parsed.data.delaySeconds * 1000;
  const delayMs = Math.min(WAKEUP_MAX_DELAY_MS, Math.max(WAKEUP_MIN_DELAY_MS, requestedMs));
  try {
    const { firesAt } = await value.rearmWakeup({ delayMs });
    const chosenSeconds = Math.round(delayMs / 1000);
    const clampNote = delayMs === requestedMs
      ? ''
      : ` (requested ${parsed.data.delaySeconds}s, clamped to the one-minute-to-one-hour window)`;
    const reasonNote = parsed.data.reason ? ` Reason: ${parsed.data.reason}` : '';
    return {
      content: [{
        type: 'text',
        text: `Next iteration in ${chosenSeconds}s${clampNote}, at ${new Date(firesAt).toISOString()}.${reasonNote}`,
      }],
      structuredContent: {
        firesAt,
        delaySeconds: chosenSeconds,
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      },
      isError: false,
    };
  } catch (error) {
    return failed('ScheduleWakeup', error);
  }
}

export async function handleCronDelete(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = CronDeleteSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid('CronDelete', parsed.error.issues);

  const resolved = port(ctx, 'CronDelete');
  if (isToolResult(resolved)) return resolved;

  try {
    const cancelled = await resolved.remove(parsed.data.id);
    if (!cancelled) {
      // An unknown id is a tool error rather than a quiet success: the model
      // asked to cancel something and needs to know it is still scheduled.
      return errorResponse(`CronDelete found no scheduled task with id "${parsed.data.id}".`);
    }
    return {
      content: [{ type: 'text', text: `Cancelled scheduled task ${parsed.data.id}.` }],
      structuredContent: { cancelled: parsed.data.id },
      isError: false,
    };
  } catch (error) {
    return failed('CronDelete', error);
  }
}

/**
 * `CronControl` (P6.295 arm (2)) — pause, resume, run now, mark read.
 *
 * No page documents this tool: `scheduled-tasks.md` describes create, list,
 * delete and the `/loop` wakeup, and codex ships no embeddable scheduler, so
 * the shape is decided here and the decision is written down (§"Where the
 * documentation is silent"). Two things it deliberately copies from the
 * neighbouring handlers rather than inventing:
 *
 * - the three port members are OPTIONAL, so a backend whose host has no such
 *   slot fails through the same "unavailable for this backend" path
 *   `ScheduleWakeup` uses instead of reporting a pause that never happened;
 * - an unknown id is a tool ERROR, exactly as in `handleCronDelete`: the model
 *   asked to change something and needs to know it did not change.
 */
export async function handleCronControl(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = CronControlSchema.safeParse(args ?? {});
  if (!parsed.success) return invalid('CronControl', parsed.error.issues);

  const resolved = port(ctx, 'CronControl');
  if (isToolResult(resolved)) return resolved;

  const { id, action } = parsed.data;
  // Resolved as a THUNK rather than as a member plus a later non-null call:
  // the presence check and the call then read the same binding, so a port that
  // gains a member between the two cannot make the second line lie.
  const invoke: (() => Promise<boolean>) | undefined =
    action === 'markRead'
      ? resolved.acknowledgeRuns && (() => resolved.acknowledgeRuns!(id))
      : action === 'runNow'
        ? resolved.runNow && (() => resolved.runNow!(id))
        : resolved.setPaused && (() => resolved.setPaused!(id, action === 'pause'));
  if (!invoke) {
    return errorResponse(`CronControl (${action}) is unavailable for this backend.`);
  }

  try {
    const changed = await invoke();
    if (!changed) {
      // `markRead` is the one action whose `false` has TWO causes — no such
      // task, or a task with nothing unread — so it says both rather than
      // asserting the one it cannot distinguish from here.
      return errorResponse(
        action === 'markRead'
          ? `CronControl found nothing to mark read on task "${id}" — no such task, or it has no unread runs.`
          : `CronControl found no scheduled task with id "${id}".`,
      );
    }
    const text = action === 'pause'
      ? `Paused scheduled task ${id}. It keeps its schedule and its prompt, and fires nothing until resumed.`
      : action === 'resume'
        ? `Resumed scheduled task ${id}. Fires that came due while it was paused are not caught up.`
        : action === 'runNow'
          ? `Scheduled task ${id} will deliver its prompt at the next turn boundary; its own schedule is unchanged.`
          : `Marked scheduled task ${id} read.`;
    return {
      content: [{ type: 'text', text }],
      structuredContent: { id, action },
      isError: false,
    };
  } catch (error) {
    return failed('CronControl', error);
  }
}
