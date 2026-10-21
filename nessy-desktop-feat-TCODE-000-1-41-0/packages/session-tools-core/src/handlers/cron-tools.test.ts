import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import {
  CRON_TOOL_NAMES,
  getSessionToolDefs,
  getSessionToolNames,
  isCronDisabled,
} from '../tool-defs.ts';
import { handleCronControl, handleCronCreate, handleCronDelete, handleCronList, handleScheduleWakeup } from './cron-tools.ts';

type CronRecord = { id: string; schedule: string; recurring: boolean; prompt: string; paused?: boolean; unreadRuns?: number };
type CreateInput = {
  schedule?: string;
  recurring: boolean;
  prompt: string;
  dynamic?: boolean;
  promptSource?: 'loop-md';
};

function context(overrides: Partial<SessionToolContext> = {}): {
  ctx: SessionToolContext;
  created: CreateInput[];
  removed: string[];
  tasks: CronRecord[];
  rearmed: { delayMs: number }[];
  controlled: { id: string; action: string }[];
  stopped: number;
} {
  const created: CreateInput[] = [];
  const removed: string[] = [];
  const tasks: CronRecord[] = [];
  const rearmed: { delayMs: number }[] = [];
  const controlled: { id: string; action: string }[] = [];
  const counters = { stopped: 0 };
  let next = 0;
  const ctx = {
    cronPort: {
      create: async (input: CreateInput) => {
        created.push(input);
        const record = { id: `abcdef${String(next++).padStart(2, '0')}`, schedule: input.schedule ?? 'dynamic', recurring: input.recurring, prompt: input.prompt };
        tasks.push(record);
        return record;
      },
      list: async () => tasks,
      remove: async (id: string) => {
        removed.push(id);
        const index = tasks.findIndex(task => task.id === id);
        if (index === -1) return false;
        tasks.splice(index, 1);
        return true;
      },
      rearmWakeup: async (input: { delayMs: number }) => {
        rearmed.push(input);
        return { firesAt: 1_700_000_000_000 + input.delayMs };
      },
      stopWakeup: async () => {
        counters.stopped += 1;
        return true;
      },
      // P6.295 arm (2) — the three control members, modelled on the real port:
      // each answers `false` for an unknown id rather than throwing, and
      // `acknowledgeRuns` also answers `false` when there is nothing unread.
      setPaused: async (id: string, paused: boolean) => {
        const task = tasks.find(entry => entry.id === id);
        if (!task) return false;
        controlled.push({ id, action: paused ? 'pause' : 'resume' });
        task.paused = paused;
        return true;
      },
      runNow: async (id: string) => {
        const task = tasks.find(entry => entry.id === id);
        if (!task) return false;
        controlled.push({ id, action: 'runNow' });
        return true;
      },
      acknowledgeRuns: async (id: string) => {
        const task = tasks.find(entry => entry.id === id);
        if (!task || !task.unreadRuns) return false;
        controlled.push({ id, action: 'markRead' });
        task.unreadRuns = 0;
        return true;
      },
    },
    ...overrides,
  } as unknown as SessionToolContext;
  return {
    ctx,
    created,
    removed,
    tasks,
    rearmed,
    controlled,
    get stopped() { return counters.stopped; },
  };
}

describe('CronCreate (`scheduled-tasks.md:164`)', () => {
  test('accepts a documented expression and returns the 8-character id', async () => {
    const { ctx, created } = context();
    const result = await handleCronCreate(ctx, { schedule: '0 9 * * 1-5', prompt: 'check the build' });
    expect(result.isError).toBe(false);
    expect(created).toEqual([{ schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' }]);
    const task = (result.structuredContent as { task: CronRecord }).task;
    expect(task.id).toHaveLength(8);
    expect(result.content[0]!.text).toContain(task.id);
  });

  test('`recurring: false` is carried through for a one-time reminder (`:136`)', async () => {
    const { ctx, created } = context();
    await handleCronCreate(ctx, { schedule: '17 15 * * *', prompt: 'push the release branch', recurring: false });
    expect(created[0]!.recurring).toBe(false);
  });

  test('an unsupported token is refused BEFORE the host stores anything, and is named (`:202`)', async () => {
    for (const [schedule, token] of [
      ['0 9 L * *', 'L'],
      ['0 9 * * MON', 'MON'],
      ['0 9 ? * 1', '?'],
      ['0 9 1W * *', 'W'],
      ['0 9 * JAN *', 'JAN'],
    ] as const) {
      const { ctx, created } = context();
      const result = await handleCronCreate(ctx, { schedule, prompt: 'x' });
      expect(result.isError, schedule).toBe(true);
      expect(result.content[0]!.text, schedule).toContain(token);
      // Nothing reached the store — a silent no-match task is exactly what
      // `:202` makes an error to avoid.
      expect(created, schedule).toEqual([]);
    }
  });

  test('a store refusal (the 50 cap, a symlinked path) comes back as a tool error', async () => {
    const { ctx } = context();
    (ctx.cronPort as { create: unknown }).create = async () => {
      throw new Error('This session already holds the maximum of 50 scheduled tasks.');
    };
    const result = await handleCronCreate(ctx, { schedule: '*/5 * * * *', prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('50');
  });

  test('a missing prompt is an input error, not a scheduled empty prompt', async () => {
    const { ctx, created } = context();
    const result = await handleCronCreate(ctx, { schedule: '*/5 * * * *' });
    expect(result.isError).toBe(true);
    expect(created).toEqual([]);
  });

  test('without a host port the tool says so rather than pretending', async () => {
    const result = await handleCronCreate({} as SessionToolContext, { schedule: '*/5 * * * *', prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unavailable');
  });

  test('`dynamic: true` starts a self-paced loop with no schedule (R39)', async () => {
    const { ctx, created } = context();
    const result = await handleCronCreate(ctx, { dynamic: true, prompt: 'check whether CI passed' });
    expect(result.isError).toBe(false);
    expect(created).toEqual([{ recurring: true, prompt: 'check whether CI passed', dynamic: true }]);
  });

  test('`promptSource: "loop-md"` is forwarded for the default-prompt loop (R39)', async () => {
    const { ctx, created } = context();
    await handleCronCreate(ctx, { dynamic: true, prompt: 'maintenance loop', promptSource: 'loop-md' });
    expect(created[0]!.promptSource).toBe('loop-md');
  });

  test('a missing schedule WITHOUT dynamic stays an error naming both forms', async () => {
    const { ctx, created } = context();
    const result = await handleCronCreate(ctx, { prompt: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('schedule');
    expect(result.content[0]!.text).toContain('dynamic');
    expect(created).toEqual([]);
  });
});

describe('ScheduleWakeup (R39, `tools-reference.md:46`, `scheduled-tasks.md:130`)', () => {
  test('an in-window delay re-arms and echoes the reason', async () => {
    const { ctx, rearmed } = context();
    const result = await handleScheduleWakeup(ctx, { delaySeconds: 300, reason: 'build still running' });
    expect(result.isError).toBe(false);
    expect(rearmed).toEqual([{ delayMs: 300_000 }]);
    expect(result.content[0]!.text).toContain('300s');
    expect(result.content[0]!.text).toContain('build still running');
    expect(result.content[0]!.text).not.toContain('clamped');
    expect((result.structuredContent as { delaySeconds: number }).delaySeconds).toBe(300);
  });

  test('a delay BELOW one minute is clamped to 60s with a note', async () => {
    const { ctx, rearmed } = context();
    const result = await handleScheduleWakeup(ctx, { delaySeconds: 5 });
    expect(result.isError).toBe(false);
    expect(rearmed).toEqual([{ delayMs: 60_000 }]);
    expect(result.content[0]!.text).toContain('clamped');
    expect((result.structuredContent as { delaySeconds: number }).delaySeconds).toBe(60);
  });

  test('a delay ABOVE one hour is clamped to 3600s with a note', async () => {
    const { ctx, rearmed } = context();
    const result = await handleScheduleWakeup(ctx, { delaySeconds: 86_400 });
    expect(result.isError).toBe(false);
    expect(rearmed).toEqual([{ delayMs: 3_600_000 }]);
    expect(result.content[0]!.text).toContain('clamped');
    expect((result.structuredContent as { delaySeconds: number }).delaySeconds).toBe(3600);
  });

  test('`stop: true` cancels the pending wakeup immediately (`:130`)', async () => {
    const harness = context();
    const result = await handleScheduleWakeup(harness.ctx, { stop: true });
    expect(result.isError).toBe(false);
    expect(harness.stopped).toBe(1);
    expect(result.content[0]!.text).toContain('cancelled');
    expect(harness.rearmed).toEqual([]);
  });

  test('stopping with no active loop is an error, not a quiet success', async () => {
    const { ctx } = context();
    (ctx.cronPort as { stopWakeup: unknown }).stopWakeup = async () => false;
    const result = await handleScheduleWakeup(ctx, { stop: true });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('no active self-paced loop');
  });

  test('neither delay nor stop names the two valid forms', async () => {
    const { ctx, rearmed } = context();
    const result = await handleScheduleWakeup(ctx, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('delaySeconds');
    expect(result.content[0]!.text).toContain('stop');
    expect(rearmed).toEqual([]);
  });

  test('a backend without the port fails through the unavailable path', async () => {
    const result = await handleScheduleWakeup({} as SessionToolContext, { delaySeconds: 300 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unavailable');
  });

  test('a backend whose port LACKS the wakeup methods fails the same way', async () => {
    const { ctx } = context();
    delete (ctx.cronPort as { rearmWakeup?: unknown }).rearmWakeup;
    delete (ctx.cronPort as { stopWakeup?: unknown }).stopWakeup;
    const result = await handleScheduleWakeup(ctx, { delaySeconds: 300 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unavailable');
  });

  test('a host refusal (no active loop to re-arm) comes back as a tool error', async () => {
    const { ctx } = context();
    (ctx.cronPort as { rearmWakeup: unknown }).rearmWakeup = async () => {
      throw new Error('No self-paced /loop is active in this session.');
    };
    const result = await handleScheduleWakeup(ctx, { delaySeconds: 300 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No self-paced /loop is active');
  });
});

describe('CronList (`:165`) and CronDelete (`:166`)', () => {
  test('lists ids, schedules, recurrence and prompts', async () => {
    const { ctx } = context();
    await handleCronCreate(ctx, { schedule: '*/5 * * * *', prompt: 'poll' });
    await handleCronCreate(ctx, { schedule: '0 9 * * *', prompt: 'daily', recurring: false });

    const result = await handleCronList(ctx, {});
    expect(result.isError).toBe(false);
    const tasks = (result.structuredContent as { tasks: CronRecord[] }).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.schedule).toBe('*/5 * * * *');
    expect(tasks[1]!.recurring).toBe(false);
    expect(result.content[0]!.text).toContain(tasks[0]!.id);
    expect(result.content[0]!.text).toContain('poll');
  });

  test('an empty list says so instead of returning nothing', async () => {
    const { ctx } = context();
    const result = await handleCronList(ctx, {});
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('No scheduled tasks');
  });

  test('delete by id cancels, and the task leaves the list', async () => {
    const { ctx, removed } = context();
    const created = await handleCronCreate(ctx, { schedule: '*/5 * * * *', prompt: 'poll' });
    const id = (created.structuredContent as { task: CronRecord }).task.id;

    const result = await handleCronDelete(ctx, { id });
    expect(result.isError).toBe(false);
    expect(removed).toEqual([id]);
    const after = await handleCronList(ctx, {});
    expect((after.structuredContent as { tasks: CronRecord[] }).tasks).toEqual([]);
  });

  test('an unknown id is an error, not a quiet success', async () => {
    const { ctx } = context();
    const result = await handleCronDelete(ctx, { id: 'deadbeef' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('deadbeef');
  });
});

describe('the disable flag removes the tools from the SURFACE (`:208`)', () => {
  const previous = { nessy: process.env.NESSY_DISABLE_CRON, claude: process.env.CLAUDE_CODE_DISABLE_CRON };

  afterEach(() => {
    if (previous.nessy === undefined) delete process.env.NESSY_DISABLE_CRON;
    else process.env.NESSY_DISABLE_CRON = previous.nessy;
    if (previous.claude === undefined) delete process.env.CLAUDE_CODE_DISABLE_CRON;
    else process.env.CLAUDE_CODE_DISABLE_CRON = previous.claude;
  });

  test('the three tools are on the Pi surface by default', () => {
    delete process.env.NESSY_DISABLE_CRON;
    delete process.env.CLAUDE_CODE_DISABLE_CRON;
    const names = getSessionToolNames({ projection: 'pi' });
    for (const name of CRON_TOOL_NAMES) expect(names.has(name), name).toBe(true);
  });

  test('`NESSY_DISABLE_CRON=1` takes them off the surface, not merely their effect', () => {
    process.env.NESSY_DISABLE_CRON = '1';
    const names = getSessionToolNames({ projection: 'pi' });
    for (const name of CRON_TOOL_NAMES) expect(names.has(name), name).toBe(false);
    // And nothing else moved.
    expect(getSessionToolDefs({ projection: 'pi' }).length).toBe(
      getSessionToolDefs({ projection: 'pi' }).filter(def => !CRON_TOOL_NAMES.has(def.name)).length,
    );
  });

  test('the Claude spelling is honoured as a compat alias', () => {
    delete process.env.NESSY_DISABLE_CRON;
    process.env.CLAUDE_CODE_DISABLE_CRON = '1';
    expect(isCronDisabled()).toBe(true);
    const names = getSessionToolNames({ projection: 'pi' });
    for (const name of CRON_TOOL_NAMES) expect(names.has(name), name).toBe(false);
  });

  test('the Nessy name wins when both are set', () => {
    process.env.NESSY_DISABLE_CRON = '0';
    process.env.CLAUDE_CODE_DISABLE_CRON = '1';
    expect(isCronDisabled()).toBe(false);
  });

  test.each([['0'], ['false'], ['no'], ['off'], [''], ['maybe']])(
    '`%s` leaves the scheduler enabled',
    value => {
      process.env.NESSY_DISABLE_CRON = value;
      expect(isCronDisabled()).toBe(false);
    },
  );

  test.each([['1'], ['true'], ['yes'], ['on'], ['ON'], [' 1 ']])('`%s` disables it', value => {
    process.env.NESSY_DISABLE_CRON = value;
    expect(isCronDisabled()).toBe(true);
  });
});

/**
 * P6.295 arm (2) — the fifth cron tool.
 *
 * The row's `done_means` (2): "a task can be paused without deletion, resumed,
 * and run now, and `CronList` shows which runs have not been read." Each half
 * is a row here, positive and negative.
 */
describe('CronControl (P6.295 arm (2))', () => {
  test('pauses without deleting, and CronList marks the paused task', async () => {
    const { ctx, controlled, tasks } = context();
    const created = await handleCronCreate(ctx, { schedule: '0 9 * * *', prompt: 'check the build' });
    const id = (created.structuredContent as { task: CronRecord }).task.id;

    const paused = await handleCronControl(ctx, { id, action: 'pause' });
    expect(paused.isError).toBe(false);
    expect(controlled).toEqual([{ id, action: 'pause' }]);
    // The record is still there — the whole point of pause over CronDelete.
    expect(tasks.map(task => task.id)).toEqual([id]);

    const listed = await handleCronList(ctx, {});
    expect(listed.content[0]!.text).toContain('paused');

    const resumed = await handleCronControl(ctx, { id, action: 'resume' });
    expect(resumed.isError).toBe(false);
    expect(controlled.at(-1)).toEqual({ id, action: 'resume' });
    expect((await handleCronList(ctx, {})).content[0]!.text).not.toContain('paused');
  });

  test('runNow asks for a delivery and leaves the schedule alone', async () => {
    const { ctx, controlled, tasks } = context();
    const created = await handleCronCreate(ctx, { schedule: '0 9 * * *', prompt: 'check the build' });
    const id = (created.structuredContent as { task: CronRecord }).task.id;

    const result = await handleCronControl(ctx, { id, action: 'runNow' });
    expect(result.isError).toBe(false);
    expect(controlled).toEqual([{ id, action: 'runNow' }]);
    expect(tasks[0]!.schedule).toBe('0 9 * * *');
  });

  test('CronList shows the unread-run count and markRead clears it', async () => {
    const { ctx, tasks } = context();
    const created = await handleCronCreate(ctx, { schedule: '0 9 * * *', prompt: 'check the build' });
    const id = (created.structuredContent as { task: CronRecord }).task.id;
    // What the store does at every non-final delivery.
    tasks[0]!.unreadRuns = 4;

    expect((await handleCronList(ctx, {})).content[0]!.text).toContain('4 unread runs');
    const acked = await handleCronControl(ctx, { id, action: 'markRead' });
    expect(acked.isError).toBe(false);
    expect((await handleCronList(ctx, {})).content[0]!.text).not.toContain('unread');
    // The singular is not cosmetic: it is the shape a reader checks a count by.
    tasks[0]!.unreadRuns = 1;
    expect((await handleCronList(ctx, {})).content[0]!.text).toContain('1 unread run');
  });

  test('an untouched task lists exactly as it did before the two markers existed', async () => {
    const { ctx } = context();
    await handleCronCreate(ctx, { schedule: '0 9 * * *', prompt: 'check the build' });
    const text = (await handleCronList(ctx, {})).content[0]!.text!;
    expect(text).not.toContain('[');
    expect(text).toMatch(/^\w{8}  0 9 \* \* \*  recurring  check the build$/);
  });

  // NEGATIVE 1 — an unknown id is a tool error, exactly as CronDelete's is.
  test('an unknown id is refused rather than silently succeeding', async () => {
    const { ctx, controlled } = context();
    const result = await handleCronControl(ctx, { id: 'nosuchid', action: 'pause' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('nosuchid');
    expect(controlled).toEqual([]);
    // markRead's `false` has two causes, so it must name both rather than
    // asserting the one it cannot tell apart from here.
    const marked = await handleCronControl(ctx, { id: 'nosuchid', action: 'markRead' });
    expect(marked.isError).toBe(true);
    expect(marked.content[0]!.text).toContain('no unread runs');
  });

  // NEGATIVE 2 — the members are OPTIONAL on the port, so a host with the cron
  // port but no control slot must fail the documented "unavailable" way rather
  // than report a pause it never made.
  test('a port without the control members answers unavailable, not success', async () => {
    const { ctx } = context();
    const port = (ctx as unknown as { cronPort: Record<string, unknown> }).cronPort;
    delete port.setPaused;
    delete port.runNow;
    delete port.acknowledgeRuns;
    for (const action of ['pause', 'resume', 'runNow', 'markRead'] as const) {
      const result = await handleCronControl(ctx, { id: 'abcdef00', action });
      expect(result.isError, action).toBe(true);
      expect(result.content[0]!.text, action).toContain('unavailable for this backend');
    }
    // A session with no cron port at all still fails on the port, not the action.
    const bare = await handleCronControl({} as unknown as SessionToolContext, { id: 'abcdef00', action: 'pause' });
    expect(bare.isError).toBe(true);
    expect(bare.content[0]!.text).toContain('CronControl is unavailable for this backend.');
  });

  // NEGATIVE 3 — the action is a closed set, so a fifth verb is refused by the
  // schema rather than falling through to `setPaused`.
  test('an action outside the four is refused by the schema', async () => {
    const { ctx, controlled } = context();
    const result = await handleCronControl(ctx, { id: 'abcdef00', action: 'delete' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('CronControl input is invalid');
    expect(controlled).toEqual([]);
  });
});
