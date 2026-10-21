/**
 * R20 Task 2 — the four documented task tools and the two documented key repairs.
 *
 * Contract source, quoted where it decides a case:
 * - `agent-sdk/typescript.md:2110-2160` (the four inputs) and `:2682-2740` (the
 *   four outputs). Read raw: a summarising fetch loses both regions.
 * - `agent-sdk/todo-tracking.md` § "Migrate to Task tools": "The assigned task
 *   ID is not in the `TaskCreate` input. It comes back in the matching
 *   `tool_result` as `{ task: { id, subject } }`", and "Claude Code repairs some
 *   close-but-incorrect key names before execution, mapping `id` or `task_id` to
 *   `taskId` and `active_form` to `activeForm`, but that repair is not reflected
 *   in the stream."
 *
 * These run against the REAL reducer through the REAL handler, not a stub that
 * re-implements the semantics: a store the handler writes but `TaskList` reads
 * from somewhere else is this series' recurring defect.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import {
  handleTaskCreate,
  handleTaskGet,
  handleTaskList,
  handleTaskUpdate,
  repairTaskToolInput,
} from './task-tools.ts';
import {
  createDocumentedTaskState,
  runDocumentedTaskCommand,
  type DocumentedTaskCommand,
  type DocumentedTaskListState,
} from '../tasks/documented-tasks.ts';
import {
  areTaskToolsEnabled,
  DOCUMENTED_TASK_TOOL_NAMES,
  LEGACY_TASK_TOOL_NAMES,
  getSessionToolDefs,
  TaskCreateSchema,
  TaskGetSchema,
  TaskListSchema,
  TaskSchema,
  TaskUpdateSchema,
} from '../tool-defs.ts';

/**
 * The production seam: one state, mutated only by the reducer, read back by the
 * same reducer. Every tool in a test shares this, so `TaskList` can only see
 * what `TaskCreate`/`TaskUpdate` actually wrote.
 */
function ctxWithRealStore(): { ctx: SessionToolContext; seen: DocumentedTaskCommand[] } {
  let state: DocumentedTaskListState = createDocumentedTaskState();
  const seen: DocumentedTaskCommand[] = [];
  const ctx = {
    taskPort: {
      execute: async () => ({}),
      executeDocumented: async (command: DocumentedTaskCommand) => {
        seen.push(structuredClone(command));
        const outcome = runDocumentedTaskCommand(state, command);
        state = outcome.state;
        return outcome.result;
      },
    },
  } as unknown as SessionToolContext;
  return { ctx, seen };
}

function payload(result: { content: { text: string }[]; isError?: boolean }): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

async function create(ctx: SessionToolContext, subject: string, description = 'why'): Promise<string> {
  return payload(await handleTaskCreate(ctx, { subject, description })).task.id;
}

describe('the four documented task tools', () => {
  test('TaskCreate takes the documented input and returns { task: { id, subject } }', async () => {
    const { ctx } = ctxWithRealStore();
    const result = payload(await handleTaskCreate(ctx, {
      subject: 'Implement user authentication',
      description: 'Add login and signup endpoints',
      activeForm: 'Implementing user authentication',
      metadata: { ticket: 'TCODE-000' },
    }));
    // typescript.md:2682 — TaskCreateOutput is exactly `{ task: { id, subject } }`.
    expect(Object.keys(result)).toEqual(['task']);
    expect(Object.keys(result.task).sort()).toEqual(['id', 'subject']);
    expect(result.task.subject).toBe('Implement user authentication');
    expect(typeof result.task.id).toBe('string');
    expect(result.task.id.length).toBeGreaterThan(0);
  });

  test('a model-supplied id on create is IGNORED and the harness id is returned', async () => {
    const { ctx } = ctxWithRealStore();
    const first = payload(await handleTaskCreate(ctx, {
      id: 'model-picked-this',
      task_id: 'and-this',
      subject: 'First',
      description: 'd',
    } as never));
    expect(first.task.id).not.toBe('model-picked-this');
    expect(first.task.id).not.toBe('and-this');

    // And the harness id is the one the store actually keys on.
    const got = payload(await handleTaskGet(ctx, { taskId: first.task.id }));
    expect(got.task?.subject).toBe('First');
    expect(payload(await handleTaskGet(ctx, { taskId: 'model-picked-this' })).task).toBeNull();
  });

  test('TaskUpdate returns { success, taskId, updatedFields, statusChange }', async () => {
    const { ctx } = ctxWithRealStore();
    const id = await create(ctx, 'Ship it');
    const result = payload(await handleTaskUpdate(ctx, { taskId: id, status: 'in_progress', subject: 'Ship it now' }));
    expect(result.success).toBe(true);
    expect(result.taskId).toBe(id);
    expect(result.updatedFields.sort()).toEqual(['status', 'subject']);
    // typescript.md:2702 — statusChange is `{ from, to }`.
    expect(result.statusChange).toEqual({ from: 'pending', to: 'in_progress' });
  });

  test('TaskUpdate on a missing id fails with an error string, not a throw', async () => {
    const { ctx } = ctxWithRealStore();
    const result = payload(await handleTaskUpdate(ctx, { taskId: 'task-404', status: 'completed' }));
    expect(result.success).toBe(false);
    expect(result.taskId).toBe('task-404');
    expect(result.updatedFields).toEqual([]);
    expect(typeof result.error).toBe('string');
  });

  test('TaskGet returns the full record, and null on a miss rather than an error', async () => {
    const { ctx } = ctxWithRealStore();
    const id = await create(ctx, 'Readable', 'the description');
    const hit = payload(await handleTaskGet(ctx, { taskId: id }));
    // typescript.md:2716 — exactly these six keys on the read side.
    expect(Object.keys(hit.task).sort()).toEqual(['blockedBy', 'blocks', 'description', 'id', 'status', 'subject']);
    expect(hit.task.description).toBe('the description');
    expect(hit.task.status).toBe('pending');

    const miss = payload(await handleTaskGet(ctx, { taskId: 'nope' }));
    expect(miss).toEqual({ task: null });
  });

  test('TaskList returns the documented row shape and omits owner when unset', async () => {
    const { ctx } = ctxWithRealStore();
    const first = await create(ctx, 'One');
    const second = await create(ctx, 'Two');
    await handleTaskUpdate(ctx, { taskId: second, owner: 'implementer', addBlockedBy: [first] });

    const list = payload(await handleTaskList(ctx, {}));
    expect(list.tasks.map((task: any) => task.subject)).toEqual(['One', 'Two']);
    // typescript.md:2735 — `owner?` is optional; `blockedBy` always present.
    expect(Object.keys(list.tasks[0]).sort()).toEqual(['blockedBy', 'id', 'status', 'subject']);
    expect(Object.keys(list.tasks[1]).sort()).toEqual(['blockedBy', 'id', 'owner', 'status', 'subject']);
    expect(list.tasks[1].blockedBy).toEqual([first]);
    // TaskList has no `blocks` — the forward edge is read-side on TaskGet only.
    expect(list.tasks[0]).not.toHaveProperty('blocks');
  });
});

describe('dependencies are additive in BOTH directions', () => {
  test('addBlockedBy adds an edge and maintains the reverse blocks edge', async () => {
    const { ctx } = ctxWithRealStore();
    const a = await create(ctx, 'A');
    const b = await create(ctx, 'B');
    await handleTaskUpdate(ctx, { taskId: b, addBlockedBy: [a] });

    expect(payload(await handleTaskGet(ctx, { taskId: b })).task.blockedBy).toEqual([a]);
    expect(payload(await handleTaskGet(ctx, { taskId: a })).task.blocks).toEqual([b]);
  });

  test('addBlocks adds an edge and maintains the reverse blockedBy edge', async () => {
    const { ctx } = ctxWithRealStore();
    const a = await create(ctx, 'A');
    const b = await create(ctx, 'B');
    await handleTaskUpdate(ctx, { taskId: a, addBlocks: [b] });

    expect(payload(await handleTaskGet(ctx, { taskId: a })).task.blocks).toEqual([b]);
    expect(payload(await handleTaskGet(ctx, { taskId: b })).task.blockedBy).toEqual([a]);
  });

  test('a second addBlockedBy ADDS rather than replacing the set', async () => {
    const { ctx } = ctxWithRealStore();
    const a = await create(ctx, 'A');
    const b = await create(ctx, 'B');
    const c = await create(ctx, 'C');
    await handleTaskUpdate(ctx, { taskId: c, addBlockedBy: [a] });
    await handleTaskUpdate(ctx, { taskId: c, addBlockedBy: [b] });

    // The whole point of `addBlockedBy` over a wholesale `blockedBy`: [a] survives.
    expect(payload(await handleTaskGet(ctx, { taskId: c })).task.blockedBy).toEqual([a, b]);
    // Re-adding the same edge does not duplicate it.
    await handleTaskUpdate(ctx, { taskId: c, addBlockedBy: [a] });
    expect(payload(await handleTaskGet(ctx, { taskId: c })).task.blockedBy).toEqual([a, b]);
  });
});

describe('deleted is a STATUS, not an action', () => {
  test("status: 'deleted' removes the task from list and get", async () => {
    const { ctx } = ctxWithRealStore();
    const keep = await create(ctx, 'Keep');
    const drop = await create(ctx, 'Drop');

    const result = payload(await handleTaskUpdate(ctx, { taskId: drop, status: 'deleted' }));
    expect(result.success).toBe(true);
    expect(result.statusChange).toEqual({ from: 'pending', to: 'deleted' });

    expect(payload(await handleTaskGet(ctx, { taskId: drop })).task).toBeNull();
    expect(payload(await handleTaskList(ctx, {})).tasks.map((task: any) => task.id)).toEqual([keep]);
  });

  test('a deleted id is never reused by a later create', async () => {
    const { ctx } = ctxWithRealStore();
    const first = await create(ctx, 'First');
    await handleTaskUpdate(ctx, { taskId: first, status: 'deleted' });
    const second = await create(ctx, 'Second');
    expect(second).not.toBe(first);
  });
});

describe('key repair — exactly two mappings, applied before execution', () => {
  test.each([
    ['id', { id: 'task-001', status: 'completed' }, { taskId: 'task-001', status: 'completed' }],
    ['task_id', { task_id: 'task-001' }, { taskId: 'task-001' }],
    ['active_form', { taskId: 'task-001', active_form: 'Doing it' }, { taskId: 'task-001', activeForm: 'Doing it' }],
    ['both', { task_id: 'task-001', active_form: 'Doing it' }, { taskId: 'task-001', activeForm: 'Doing it' }],
    ['canonical keys untouched', { taskId: 'task-001', activeForm: 'A' }, { taskId: 'task-001', activeForm: 'A' }],
    ['canonical wins over alias', { taskId: 'real', id: 'alias' }, { taskId: 'real' }],
  ])('repairs %s', (_label, raw, expected) => {
    expect(repairTaskToolInput(raw)).toEqual(expected);
  });

  test('repairs nothing else — snake_case is NOT repaired in general', () => {
    // todo-tracking.md names three keys and only three. `add_blocked_by` is not
    // one of them, so it must not be silently rewritten.
    expect(repairTaskToolInput({ taskId: 'x', add_blocked_by: ['y'] })).toEqual({ taskId: 'x', add_blocked_by: ['y'] });
  });

  test('the executed args are repaired', async () => {
    const { ctx, seen } = ctxWithRealStore();
    const id = await create(ctx, 'Repairable');
    seen.length = 0;
    await handleTaskUpdate(ctx, { task_id: id, active_form: 'Repairing' } as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ op: 'update', taskId: id, activeForm: 'Repairing' });
    expect(seen[0]).not.toHaveProperty('task_id');
    expect(seen[0]).not.toHaveProperty('active_form');
  });

  test('the repair is NOT reflected in the streamed input', async () => {
    // todo-tracking.md: "that repair is not reflected in the stream". The stream
    // carries the object the model emitted, so the handler must not mutate it.
    const { ctx } = ctxWithRealStore();
    const id = await create(ctx, 'Streamed');
    const streamedInput: Record<string, unknown> = { task_id: id, active_form: 'Repairing' };
    const before = structuredClone(streamedInput);

    await handleTaskUpdate(ctx, streamedInput as never);

    expect(streamedInput).toEqual(before);
    expect(streamedInput).toHaveProperty('task_id');
    expect(streamedInput).not.toHaveProperty('taskId');
  });

  test('a repaired id reaches the real store, not just the port', async () => {
    const { ctx } = ctxWithRealStore();
    const id = await create(ctx, 'Round trip');
    await handleTaskUpdate(ctx, { id, status: 'in_progress' } as never);
    expect(payload(await handleTaskList(ctx, {})).tasks[0].status).toBe('in_progress');
  });
});

describe('the documented input schemas', () => {
  test('TaskCreate requires subject AND description', () => {
    expect(TaskCreateSchema.safeParse({ subject: 's', description: 'd' }).success).toBe(true);
    // typescript.md:2112 — `description: string`, not optional.
    expect(TaskCreateSchema.safeParse({ subject: 's' }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ description: 'd' }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ subject: '  ', description: 'd' }).success).toBe(false);
  });

  test('TaskUpdate requires taskId and accepts every documented optional', () => {
    expect(TaskUpdateSchema.safeParse({}).success).toBe(false);
    const full = TaskUpdateSchema.safeParse({
      taskId: 'task-001',
      status: 'deleted',
      subject: 's',
      description: 'd',
      activeForm: 'a',
      addBlocks: ['task-002'],
      addBlockedBy: ['task-003'],
      owner: 'implementer',
      metadata: { k: 'v' },
    });
    expect(full.success).toBe(true);
  });

  test('status accepts the four documented values and nothing else', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'deleted']) {
      expect(TaskUpdateSchema.safeParse({ taskId: 't', status }).success).toBe(true);
    }
    expect(TaskUpdateSchema.safeParse({ taskId: 't', status: 'cancelled' }).success).toBe(false);
  });

  test('TaskGet requires taskId; TaskList takes no input', () => {
    expect(TaskGetSchema.safeParse({ taskId: 't' }).success).toBe(true);
    expect(TaskGetSchema.safeParse({}).success).toBe(false);
    expect(TaskListSchema.safeParse({}).success).toBe(true);
  });

  test('unknown keys are stripped, not rejected', () => {
    // The documented posture is repair-and-proceed, never hard-fail: the legacy
    // `.strict()` arms are exactly why a Claude-shaped payload could not degrade.
    const parsed = TaskCreateSchema.safeParse({ subject: 's', description: 'd', speculative: 1 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('speculative');
  });
});

describe('NESSY_ENABLE_TASKS — the task tools are the default', () => {
  /** The production seam the Pi backend actually advertises from. */
  const piToolNames = (value?: string): string[] => {
    const previous = process.env.NESSY_ENABLE_TASKS;
    if (value === undefined) delete process.env.NESSY_ENABLE_TASKS;
    else process.env.NESSY_ENABLE_TASKS = value;
    try {
      return getSessionToolDefs({ projection: 'pi' }).map(def => def.name);
    } finally {
      if (previous === undefined) delete process.env.NESSY_ENABLE_TASKS;
      else process.env.NESSY_ENABLE_TASKS = previous;
    }
  };

  test('unset means enabled — the documented default since v2.1.142', () => {
    expect(areTaskToolsEnabled({})).toBe(true);
    const visible = piToolNames(undefined);
    for (const name of DOCUMENTED_TASK_TOOL_NAMES) expect(visible).toContain(name);
    // `tools-reference.md:57`: TodoWrite is "Disabled by default as of v2.1.142".
    for (const name of LEGACY_TASK_TOOL_NAMES) expect(visible).not.toContain(name);
  });

  test.each(['0', 'false', 'no', 'off', 'OFF'])('%s reverts to the legacy checklist', value => {
    expect(areTaskToolsEnabled({ NESSY_ENABLE_TASKS: value })).toBe(false);
    const visible = piToolNames(value);
    for (const name of LEGACY_TASK_TOOL_NAMES) expect(visible).toContain(name);
    for (const name of DOCUMENTED_TASK_TOOL_NAMES) expect(visible).not.toContain(name);
  });

  test.each(['1', 'true', 'yes', 'on', 'nonsense'])('%s keeps the task tools', value => {
    expect(areTaskToolsEnabled({ NESSY_ENABLE_TASKS: value })).toBe(true);
    expect(piToolNames(value)).toContain('TaskCreate');
  });

  /**
   * P6.303 (3) — the Claude spelling is an alias now, one test per spelling.
   *
   * `CLAUDE_CODE_ENABLE_TASKS` is the name this fork's own comments call *"our
   * `CLAUDE_CODE_ENABLE_TASKS`"*, and until this row nothing read it: a user or
   * a managed policy carrying it got it honoured by nobody. The alias is
   * consulted ONLY when the Nessy name is absent, which is what the third case
   * pins — an existing configuration cannot change meaning.
   */
  test.each(['0', 'false', 'no', 'off', 'OFF'])('the Claude spelling %s reverts the checklist too', value => {
    expect(areTaskToolsEnabled({ CLAUDE_CODE_ENABLE_TASKS: value })).toBe(false);
  });

  test.each(['1', 'true', 'yes', 'on', 'nonsense'])('the Claude spelling %s keeps the task tools', value => {
    expect(areTaskToolsEnabled({ CLAUDE_CODE_ENABLE_TASKS: value })).toBe(true);
  });

  test('the Nessy name wins whenever it is present, in both directions', () => {
    // The precedence, asserted in BOTH directions rather than once: a rule
    // checked only where the two agree proves nothing about which one decided.
    expect(areTaskToolsEnabled({ NESSY_ENABLE_TASKS: '1', CLAUDE_CODE_ENABLE_TASKS: '0' })).toBe(true);
    expect(areTaskToolsEnabled({ NESSY_ENABLE_TASKS: '0', CLAUDE_CODE_ENABLE_TASKS: '1' })).toBe(false);
    // An unrecognised Nessy value is still a PRESENT one, so it keeps the
    // default and does not fall through to the alias — the semantics the Nessy
    // name already had, unchanged.
    expect(areTaskToolsEnabled({ NESSY_ENABLE_TASKS: 'nonsense', CLAUDE_CODE_ENABLE_TASKS: '0' })).toBe(true);
  });

  test('the switch never strips the checklist from a non-Pi backend', () => {
    // The four tools are `pi-only`; suppressing TodoWrite outside Pi would leave
    // the Claude and session-mcp-server backends with no checklist tool at all.
    expect(getSessionToolDefs().map(def => def.name)).toContain('TodoWrite');
  });

  test('the legacy Task schema is untouched by R20', () => {
    // `revision` has no documented counterpart, so it stays here and only here.
    expect(TaskSchema.safeParse({ action: 'create', id: 'a', title: 'A' }).success).toBe(true);
    expect(TaskSchema.safeParse({ action: 'update', id: 'a', revision: 2, status: 'completed' }).success).toBe(true);
    // ...and never leaks onto the new surface.
    const parsed = TaskUpdateSchema.safeParse({ taskId: 'a', revision: 2 });
    expect(parsed.success && parsed.data).not.toHaveProperty('revision');
  });
});

describe('backend availability', () => {
  test('every tool reports unavailability instead of throwing when no port is bound', async () => {
    const ctx = {} as SessionToolContext;
    for (const result of [
      await handleTaskCreate(ctx, { subject: 's', description: 'd' }),
      await handleTaskUpdate(ctx, { taskId: 't' }),
      await handleTaskGet(ctx, { taskId: 't' }),
      await handleTaskList(ctx, {}),
    ]) {
      expect(result.isError).toBe(true);
    }
  });
});
