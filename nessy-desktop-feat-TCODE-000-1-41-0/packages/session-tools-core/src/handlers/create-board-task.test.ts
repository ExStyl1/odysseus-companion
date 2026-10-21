/**
 * UA3.5 — adapted from craft-agents-oss `v0.13.4:packages/session-tools-core/src/handlers/create-task.test.ts`
 * (Apache-2.0): the handler checks the two strings, hands the input to the host closure unchanged and turns its result
 * (or its refusal) into the tool's text. The restrictions on the invoking agent are the closure's
 * (`server-core/src/tasks/create-board-task.test.ts`).
 */
import { describe, it, expect } from 'bun:test';
import { handleCreateBoardTask, CREATE_BOARD_TASK_DESCRIPTION, CreateBoardTaskSchema } from './create-board-task.ts';
import type { SessionToolContext, CreateBoardTaskInput, CreateBoardTaskResult } from '../context.ts';

function createCtx(result?: Partial<CreateBoardTaskResult>): {
  ctx: SessionToolContext;
  calls: CreateBoardTaskInput[];
} {
  const calls: CreateBoardTaskInput[] = [];
  const ctx = {
    createBoardTask: async (input: CreateBoardTaskInput) => {
      calls.push(input);
      return {
        slug: 'my-task',
        orchestratorSessionId: 'sess-1',
        warnings: [],
        ...result,
      } satisfies CreateBoardTaskResult;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content[0]?.type === 'text' ? result.content[0].text ?? '' : '';

describe('handleCreateBoardTask', () => {
  it('creates a task and returns the structured result as JSON', async () => {
    const { ctx, calls } = createCtx({ taskLabelId: 'label-1' });
    const result = await handleCreateBoardTask(ctx, {
      title: 'Fix login flow',
      description: 'Investigate and fix the OAuth redirect loop',
      acceptanceCriteria: 'Login succeeds on first attempt',
      sources: ['github'],
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.title).toBe('Fix login flow');
    expect(calls[0]!.acceptanceCriteria).toBe('Login succeeds on first attempt');

    expect(JSON.parse(text(result))).toEqual({
      slug: 'my-task',
      orchestratorSessionId: 'sess-1',
      taskLabelId: 'label-1',
      warnings: [],
    });
  });

  it('surfaces backend warnings in the result', async () => {
    const { ctx } = createCtx({ warnings: ['Unknown sources (not added to the task: they don\'t exist in this workspace): nope'] });
    const result = await handleCreateBoardTask(ctx, { title: 'T', description: 'D' });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).warnings).toEqual(['Unknown sources (not added to the task: they don\'t exist in this workspace): nope']);
  });

  it('errors when the callback is not available (a codex spawn without the host-callback bridge)', async () => {
    const ctx = {} as unknown as SessionToolContext;
    const result = await handleCreateBoardTask(ctx, { title: 'T', description: 'D' });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not available');
  });

  it('rejects a missing title or description without calling the backend', async () => {
    const { ctx, calls } = createCtx();

    const noTitle = await handleCreateBoardTask(ctx, { title: '  ', description: 'D' });
    expect(noTitle.isError).toBe(true);
    expect(text(noTitle)).toContain('title');

    const noDescription = await handleCreateBoardTask(ctx, { title: 'T', description: '' });
    expect(noDescription.isError).toBe(true);
    expect(text(noDescription)).toContain('description');

    expect(calls).toHaveLength(0);
  });

  it('wraps backend failures (a host refusal) as tool errors', async () => {
    const ctx = {
      createBoardTask: async () => {
        throw new Error('board-task-connection-refused: a task created by an agent runs on the creating session\'s own connection');
      },
    } as unknown as SessionToolContext;

    const result = await handleCreateBoardTask(ctx, { title: 'T', description: 'D', llmConnection: 'other' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('board-task-connection-refused');
  });

  it('the description contrasts the board with the in-session checklist WITHOUT naming a tool, and the schema has no mode', () => {
    expect(CREATE_BOARD_TASK_DESCRIPTION).toContain('your in-session checklist or plan tool');
    expect(CREATE_BOARD_TASK_DESCRIPTION).toContain('is NOT run');
    for (const tool of ['TodoWrite', 'update_plan', 'task_create', 'TaskCreate', 'Task tool']) {
      expect(CREATE_BOARD_TASK_DESCRIPTION, tool).not.toContain(tool);
    }
    // `model` is the only key spelled with "mode": there is no permission-mode field.
    expect(Object.keys(CreateBoardTaskSchema.shape).filter(key => /mode/i.test(key))).toEqual(['model']);
    expect(CreateBoardTaskSchema.safeParse({ title: 'T' }).success).toBe(false);
  });

  // UA5.2 follow-up — the host closure (`server-core/src/tasks/create-board-task.ts`, f7a2b68f4) accepts a projectId
  // whose project folder carries the caller's STABLE projectKey (spec §10), so the text the model reads must say so
  // rather than "only that project"; a project bound to another folder is still refused, and the text keeps saying so.
  it('UA5.2 — the description and the projectId field name the project bound to this session\'s own folder, and still refuse a wider one', () => {
    const projectId = CreateBoardTaskSchema.shape.projectId.description ?? '';
    const STALE = "(defaults to the invoking session's project; only that project)";
    expect(STALE.includes('only that project')).toBe(true); // CONTROL: the needle matches the f7a2b68f4 text
    expect(projectId).not.toContain('only that project');
    expect(projectId).toContain("bound to this session's own folder");
    expect(CREATE_BOARD_TASK_DESCRIPTION).toContain("another project only when that project is bound to this session's own folder");
    expect(CREATE_BOARD_TASK_DESCRIPTION).toContain('a project bound elsewhere');
    expect(CREATE_BOARD_TASK_DESCRIPTION).toContain('is refused');
  });
});
