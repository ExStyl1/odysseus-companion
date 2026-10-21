import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { hashWorkflowPrompt } from './journal.ts';
import { BackgroundTaskRegistry } from './background-task-registry.ts';
import { clearBackgroundSubagentTasksForTest, createStopTaskTool } from './subagent-tool.ts';
import { createWorkflowTool } from './workflow-tool.ts';
import type { ChildSessionResult, SpawnChildSessionArgs } from './spawner.ts';
import { textPartAt } from '../__tests__/support/tool-result-text.ts';

function result(agent: string, text: string, tokensIn = 1, tokensOut = 1): ChildSessionResult {
  return { agent, status: 'done', text, tokensIn, tokensOut };
}

function failedResult(agent: string, error: string): ChildSessionResult {
  return { agent, status: 'error', text: '', tokensIn: 1, tokensOut: 1, error };
}

function makeTool(
  spawn: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>,
  sessionPath: string,
  recipes?: Map<string, string>,
) {
  return createWorkflowTool({
    getCwd: () => sessionPath,
    getSessionPath: () => sessionPath,
    makeRunId: () => 'workflow-test-run',
    spawn,
    ...(recipes === undefined ? {} : { recipes }),
  });
}

describe('workflow tool', () => {
  afterEach(() => {
    clearBackgroundSubagentTasksForTest();
  });

  it('contains a hostile synchronous script instead of blocking the subprocess', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-hostile-'));
    // The production tool compiles with the default synchronous-slice ceiling; a
    // runaway synchronous loop must be caught and surfaced as an error rather than
    // hang the evaluator. A parallel timer proves the event loop stayed live.
    //
    // `args: {}` is passed EXPLICITLY and is load-bearing for the loop condition.
    // The runtime no longer substitutes `{}` for an omitted invocation
    // (`workflows.md:225` — see the args-contract test below), so an omitted
    // `args` would leave the global `undefined`, the loop body would never run,
    // and this test would assert the evaluation ceiling against a script that
    // never spins.
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);
    let tick = false;
    const timer = new Promise<void>(resolve => setTimeout(() => { tick = true; resolve(); }, 10));
    try {
      const output = await tool.execute('call', {
        script: 'const start = args; while (start !== undefined) { }',
        args: {},
      }, new AbortController().signal);
      await timer;
      expect(tick).toBe(true);
      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('synchronous execution');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('documents the workflow script helper names in prompt metadata', () => {
    const tool = makeTool(async args => result(args.agentDef.name, args.task), '/tmp/workflow-docs');
    const scriptSchema = (tool.parameters as any).properties.script;

    expect(tool.promptSnippet).toContain('agent()');
    expect(tool.promptSnippet).not.toContain('child()');
    expect(tool.promptGuidelines?.some(line => line.includes('agent(promptOrDef, opts)'))).toBe(true);
    expect(tool.promptSnippet).toContain('[workflow:<name>]');
    expect(scriptSchema.description).toContain('agent()');
    expect(scriptSchema.description).not.toContain('child()');
    expect((tool.parameters as any).properties.name).toBeDefined();
    expect((tool.parameters as any).properties.scriptPath).toBeDefined();
  });

  it('runs scriptPath ahead of inline script and name, then returns persisted run paths', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-script-path-'));
    const sourcePath = join(sessionPath, 'source.js');
    const diskScript = "return agent({ agent: 'scout', task: 'disk script' });";
    writeFileSync(
      sourcePath,
      `export const meta = { name: 'disk-workflow', description: 'Disk workflow' };\n${diskScript}`,
    );
    const seen: SpawnChildSessionArgs[] = [];
    const tool = makeTool(async args => {
      seen.push(args);
      return result(args.agentDef.name, args.task);
    }, sessionPath, new Map([['named', "return agent({ agent: 'scout', task: 'named script' });"]]));

    try {
      const output = await tool.execute('call', {
        scriptPath: sourcePath,
        script: "return agent({ agent: 'scout', task: 'inline script' });",
        name: 'named',
      }, new AbortController().signal);

      expect(seen.map(call => call.task)).toEqual(['disk script']);
      expect(output.details?.runId).toBe('workflow-test-run');
      expect(output.details?.transcriptDir).toBe(join(sessionPath, '.orchestrator', 'workflow-test-run'));
      expect(output.details?.scriptPath).toBe(join(
        sessionPath,
        '.orchestrator',
        'workflow-test-run',
        'workflow.js',
      ));
      expect(existsSync(output.details!.scriptPath!)).toBe(true);
      expect(readFileSync(output.details!.scriptPath!, 'utf8')).toBe(diskScript);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('resolves a named workflow as the top-level script', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-name-'));
    const tool = makeTool(
      async args => result(args.agentDef.name, args.task),
      sessionPath,
      new Map([['inspect', "return agent({ agent: 'scout', task: args.task });"]]),
    );

    try {
      const output = await tool.execute('call', {
        name: 'inspect',
        args: { task: 'named recipe task' },
      }, new AbortController().signal);

      expect(output.details?.returnValue).toBe('named recipe task');
      expect(readFileSync(output.details!.scriptPath!, 'utf8')).toContain('agent');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  /**
   * `workflows.md:225` (§ *Pass input to a saved workflow*), whole line verbatim:
   * "Claude passes the list as structured data, so the script can call array and
   * object methods on `args` directly without parsing it first. If `args` is
   * omitted, the global is `undefined` inside the script."
   *
   * THREE shapes, because two of them were indistinguishable from the third
   * until the `input.args ?? {}` coalesce came out: an ABSENT `args` key, an
   * EXPLICIT `undefined`, and an empty object. The first two must both leave the
   * global `undefined` — that is what makes the page's `args ?? default`,
   * `if (!args)` and `args === undefined` idioms reachable at all — and only the
   * third may hand the script a defined, truthy `{}`.
   *
   * The explicit-`undefined` case is not redundant with the omitted one: a
   * default parameter or a `??` applied to an explicit `undefined` silently
   * takes the substituted path, so a suite that only ever omits the key cannot
   * tell a preserved `undefined` from a re-introduced default.
   */
  it('leaves the args global undefined when the invocation omits args or passes undefined, and passes {} through unchanged', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-args-contract-'));
    const probe = 'return { type: typeof args, isUndefined: args === undefined, falsy: !args, nullish: args ?? "DEFAULT-BRANCH" };';
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);

    try {
      const omitted = await tool.execute('call', { script: probe }, new AbortController().signal);
      expect(omitted.details?.returnValue).toEqual({
        type: 'undefined', isUndefined: true, falsy: true, nullish: 'DEFAULT-BRANCH',
      });

      const explicitUndefined = await tool.execute('call', {
        script: probe,
        args: undefined,
      }, new AbortController().signal);
      expect(explicitUndefined.details?.returnValue).toEqual(omitted.details?.returnValue);

      const emptyObject = await tool.execute('call', { script: probe, args: {} }, new AbortController().signal);
      expect(emptyObject.details?.returnValue).toEqual({
        type: 'object', isUndefined: false, falsy: false, nullish: {},
      });

      const supplied = await tool.execute('call', {
        script: 'return args ?? "DEFAULT-BRANCH";',
        args: { input: 'x' },
      }, new AbortController().signal);
      expect(supplied.details?.returnValue).toEqual({ input: 'x' });
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  /**
   * The same contract one level down. `workflow(nameOrRef)` with no second
   * argument is the in-script equivalent of an omitted invocation, so a recipe
   * invoked that way must see `undefined` too — otherwise the divergence
   * survives inside every nested recipe even after the top-level call is fixed.
   */
  it('leaves the args global undefined inside a nested workflow() call that passes no args', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-args-nested-'));
    const probe = 'return { type: typeof args, isUndefined: args === undefined, nullish: args ?? "DEFAULT-BRANCH" };';
    const tool = makeTool(
      async args => result(args.agentDef.name, args.task),
      sessionPath,
      new Map([['probe', probe]]),
    );

    try {
      const omitted = await tool.execute('call', {
        script: "return workflow('probe');",
      }, new AbortController().signal);
      expect(omitted.details?.returnValue).toEqual({
        type: 'undefined', isUndefined: true, nullish: 'DEFAULT-BRANCH',
      });

      const supplied = await tool.execute('call', {
        script: "return workflow('probe', { task: 'nested' });",
      }, new AbortController().signal);
      expect(supplied.details?.returnValue).toEqual({
        type: 'object', isUndefined: false, nullish: { task: 'nested' },
      });
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('rejects scriptPath escapes and symlinks while preserving named execution', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-script-roots-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'workflow-script-outside-'));
    const outsidePath = join(outsideRoot, 'outside.js');
    const symlinkPath = join(sessionPath, 'linked.js');
    writeFileSync(outsidePath, "return 'outside';");
    symlinkSync(outsidePath, symlinkPath);
    const tool = makeTool(
      async args => result(args.agentDef.name, args.task),
      sessionPath,
      new Map([['safe-name', "return 'named';"]]),
    );

    try {
      for (const scriptPath of [outsidePath, join('..', basename(outsideRoot), 'outside.js'), symlinkPath]) {
        const output = await tool.execute('call', { scriptPath }, new AbortController().signal);
        expect(output.details?.result?.status).toBe('error');
        expect(output.details?.error).toMatch(/outside allowed roots|cannot be a symlink/);
      }
      const named = await tool.execute('call', { name: 'safe-name' }, new AbortController().signal);
      expect(named.details?.returnValue).toBe('named');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('persists metadata-prefixed parse failures for every selector without spawning', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-invalid-meta-'));
    const invalid = "export const meta = { name: WORKFLOW_NAME, description: 'bad' };\nreturn agent('never');";
    const invalidPath = join(sessionPath, 'invalid.js');
    writeFileSync(invalidPath, invalid);
    let spawns = 0;
    const tool = makeTool(async args => {
      spawns += 1;
      return result(args.agentDef.name, args.task);
    }, sessionPath, new Map([['invalid-name', invalid]]));

    try {
      for (const params of [
        { script: invalid },
        { name: 'invalid-name' },
        { scriptPath: invalidPath },
      ]) {
        const output = await tool.execute('call', params, new AbortController().signal);
        expect(output.details).toMatchObject({
          runId: 'workflow-test-run',
          error: expect.stringContaining('pure literal'),
          result: { status: 'error' },
        });
        expect(readFileSync(output.details!.scriptPath!, 'utf8')).toBe(invalid);
      }
      expect(spawns).toBe(0);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('accepts a syntax-invalid launch but returns error without spawning', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-invalid-syntax-'));
    let spawns = 0;
    const tool = makeTool(async args => {
      spawns += 1;
      return result(args.agentDef.name, args.task);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: 'return )',
      }, new AbortController().signal);

      expect(spawns).toBe(0);
      expect(output.details).toMatchObject({
        runId: 'workflow-test-run',
        transcriptDir: join(sessionPath, '.orchestrator', 'workflow-test-run'),
        error: expect.stringContaining('Workflow script rejected'),
      });
      expect(readFileSync(output.details!.scriptPath!, 'utf8')).toBe('return )');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('keeps agent() spawns explicitly foreground and returns completed results to the script', async () => {
    // S1 guard: workflow child spawns always pass an explicit background flag,
    // so the spawner's top-level background default never changes what the
    // orchestration script receives — agent() still resolves with the
    // completed child result.
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-foreground-'));
    const seen: SpawnChildSessionArgs[] = [];
    const tool = makeTool(async args => {
      seen.push(args);
      return result(args.agentDef.name, `done:${args.task}`);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: "return await agent({ agent: 'scout', task: 'inspect' });",
      }, new AbortController().signal);

      expect(seen[0]?.background).toBe(false);
      expect(seen[0]?.depth).toBe(0);
      expect(output.details?.returnValue).toBe('done:inspect');
      expect(output.details?.result?.status).toBe('done');
      expect(output.details?.backgrounded).toBeUndefined();
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('resolves a pinned runtime agent without filesystem discovery', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-runtime-agent-'));
    const seen: SpawnChildSessionArgs[] = [];
    const tool = createWorkflowTool({
      getCwd: () => process.cwd(),
      getSessionPath: () => sessionPath,
      getRuntimeAgentDefinitions: () => [{
        name: 'hive-scout', aliases: ['plugin://honey#agent.hive-scout'], description: 'Pinned scout',
        systemPrompt: 'Pinned instructions.', toolset: 'read-only', tools: ['read'], tier: 'small',
        capabilityGeneration: 'generation-1', definitionDigest: 'a'.repeat(64),
      }],
      spawn: async args => { seen.push(args); return result(args.agentDef.name, 'done'); },
    });
    try {
      await tool.execute('call', {
        script: "return agent({ agent: 'plugin://honey#agent.hive-scout', task: 'inspect' });",
      }, new AbortController().signal);
      expect(seen[0]!.agentDef).toMatchObject({
        name: 'hive-scout', systemPrompt: 'Pinned instructions.', capabilityGeneration: 'generation-1',
      });
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('emits declared phases before any workflow agent runs', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-phases-'));
    const updates: any[] = [];
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);

    try {
      const output = await tool.execute('call', {
        phases: [
          { title: 'Discover', detail: 'Read the repo' },
          { title: 'Review' },
          { title: 'Ship' },
        ],
        script: `
          phase('Review');
          return agent({ agent: 'scout', task: 'review task', label: 'Reviewer' });
        `,
      }, new AbortController().signal, update => updates.push(update));

      expect(updates[0]?.details?.progress).toEqual({
        kind: 'workflow',
        runId: 'workflow-test-run',
        phases: [
          { title: 'Discover', detail: 'Read the repo' },
          { title: 'Review' },
          { title: 'Ship' },
        ],
        agents: [],
      });
      expect(output.details?.progress?.phases?.map(phase => phase.title)).toEqual(['Discover', 'Review', 'Ship']);
      expect(output.details?.progress?.agents[0]?.phase).toBe('Review');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('retries workflow agent stages when outputSchema validation fails', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-schema-'));
    let attempts = 0;
    const tasks: string[] = [];
    const requestedIds: string[] = [];
    let seals = 0;
    const tool = createWorkflowTool({
      getCwd: () => process.cwd(), getSessionPath: () => sessionPath, makeRunId: () => 'workflow-test-run',
      childSessionPort: { sealOwnerTask: async () => { seals += 1 } } as any,
      spawn: async args => {
      attempts += 1;
      tasks.push(args.task);
      requestedIds.push(args.requestedAgentId!);
      args.onAdmitted?.(args.requestedAgentId!);
      return result(args.agentDef.name, attempts === 1 ? 'not json' : '{"ok":true}');
      },
    } as any);

    try {
      const output = await tool.execute('call', {
        script: `
          return agent({
            agent: 'scout',
            task: 'return json',
            outputSchema: {
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            },
          });
        `,
      }, new AbortController().signal);

      expect(attempts).toBe(2);
      expect(new Set(requestedIds).size).toBe(2);
      expect(seals).toBe(1);
      expect(tasks[1]).toContain('The previous result did not match outputSchema');
      // R18: BOTH attempts show the child the schema it is judged against.
      for (const task of tasks) {
        expect(task).toContain('You MUST respond with valid JSON matching this schema');
        expect(task).toContain('"ok"');
      }
      expect(output.details?.returnValue).toBe('{"ok":true}');
      expect(output.details?.result?.status).toBe('done');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('routes workflow agent outputSchema through the shared draft-07 engine and default-5 retry loop', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-schema-enum-'));
    // enum violation the old checker passed; always-invalid must exhaust at the
    // shared loop's default of 5 attempts (was: hardcoded 2).
    let attempts = 0;
    const tool = makeTool(async args => {
      attempts += 1;
      args.onAdmitted?.(args.requestedAgentId!);
      return result(args.agentDef.name, '{"ok":"zzz"}');
    }, sessionPath);

    const previousEnv = process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES;
    delete process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES;
    try {
      const output = await tool.execute('call', {
        script: `
          return agent({
            agent: 'scout',
            task: 'return json',
            outputSchema: {
              type: 'object',
              required: ['ok'],
              properties: { ok: { type: 'string', enum: ['a', 'b'] } },
            },
          });
        `,
      }, new AbortController().signal);

      expect(attempts).toBe(5);
      expect(output.details?.result?.status).toBe('error');
      expect(JSON.stringify(output.details?.result)).toContain('outputSchema validation failed');
    } finally {
      if (previousEnv === undefined) delete process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES;
      else process.env.NESSY_MAX_STRUCTURED_OUTPUT_RETRIES = previousEnv;
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('runs pipeline without a stage barrier', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-pipeline-'));
    const order: string[] = [];
    const tool = makeTool(async args => {
      order.push(`spawn:${args.task}`);
      return result(args.agentDef.name, args.task);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          const values = await pipeline(
            ['slow', 'fast'],
            async item => {
              if (item === 'slow') await new Promise(resolve => setTimeout(resolve, 20));
              log('stage1 ' + item);
              return item + '-one';
            },
            async item => {
              log('stage2 ' + item);
              return agent({ agent: 'scout', task: item });
            },
          );
          return values;
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('done');
      expect(output.details?.returnValue).toEqual(['slow-one', 'fast-one']);
      expect(output.details?.logs).toEqual([
        'stage1 fast',
        'stage2 fast-one',
        'stage1 slow',
        'stage2 slow-one',
      ]);
      expect(order).toEqual(['spawn:fast-one', 'spawn:slow-one']);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('settles failed parallel agents to null and records the failure index', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-parallel-null-'));
    const tool = makeTool(async args => (
      args.task === 'fail'
        ? failedResult(args.agentDef.name, 'child failed')
        : result(args.agentDef.name, args.task)
    ), sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          const values = await parallel([
            () => agent({ agent: 'scout', task: 'ok', label: 'first' }),
            () => agent({ agent: 'scout', task: 'fail', label: 'second' }),
          ]);
          return values;
        `,
      }, new AbortController().signal);

      expect(output.details?.returnValue).toEqual(['ok', null]);
      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.result?.failures).toEqual([{
        helper: 'parallel',
        index: 1,
        phase: 'start',
        error: 'child failed',
      }]);
      expect(output.details?.result?.results.some(entry => entry.status === 'error' && entry.error === 'child failed')).toBe(true);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('drops only the failing pipeline item to null', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-pipeline-null-'));
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          const values = await pipeline(
            ['keep', 'drop'],
            item => {
              if (item === 'drop') throw new Error('drop item');
              return item + '-one';
            },
            item => item + '-two',
          );
          return values;
        `,
      }, new AbortController().signal);

      expect(output.details?.returnValue).toEqual(['keep-one-two', null]);
      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.result?.failures).toEqual([{
        helper: 'pipeline',
        index: 1,
        stageIndex: 0,
        phase: 'start',
        error: 'drop item',
      }]);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('replays cached journal results instead of spawning', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-journal-'));
    let spawnCount = 0;
    const first = makeTool(async args => {
      spawnCount += 1;
      return result(args.agentDef.name, 'cached child');
    }, sessionPath);

    try {
      await first.execute('call', {
        script: "return agent({ agent: 'scout', task: 'same task' });",
      }, new AbortController().signal);

      const second = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'workflow-test-run-2',
        spawn: async () => {
          throw new Error('spawn should not run');
        },
      });
      const output = await second.execute('call', {
        resumeRunId: 'workflow-test-run',
        script: "return agent({ agent: 'scout', task: 'same task' });",
      }, new AbortController().signal);

      expect(spawnCount).toBe(1);
      expect(output.details?.result?.status).toBe('done');
      expect(output.details?.returnValue).toBe('cached child');
      expect(output.details?.progress?.agents[0]?.lastActivity).toBe('journal-replay');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('keeps the override-free workflow journal hash stable', () => {
    expect(hashWorkflowPrompt({
      agent: 'scout',
      task: 'same task',
      label: 'scout',
    })).toBe('b0df45143aac3c9ac1d07463fdba883f84a14143e3a0ed57834a4c583ecfad20');
  });

  it('records distinct journal entries for agent calls that only differ by model', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-model-journal-'));
    const spawnedModels: Array<string | undefined> = [];
    const script = `
      const first = await agent({ agent: 'scout', task: 'same task', label: 'Same' }, { model: 'model-a' });
      const second = await agent({ agent: 'scout', task: 'same task', label: 'Same' }, { model: 'model-b' });
      return [first, second];
    `;
    const first = makeTool(async args => {
      const model = (args as SpawnChildSessionArgs & { model?: string }).model;
      spawnedModels.push(model);
      return result(args.agentDef.name, model ?? 'missing-model');
    }, sessionPath);

    try {
      const firstOutput = await first.execute('call', { script }, new AbortController().signal);

      expect(firstOutput.details?.returnValue).toEqual(['model-a', 'model-b']);
      expect(spawnedModels).toEqual(['model-a', 'model-b']);

      const second = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'workflow-test-run-2',
        spawn: async () => {
          throw new Error('spawn should not run during model replay');
        },
      });
      const replay = await second.execute('call', {
        resumeRunId: 'workflow-test-run',
        script,
      }, new AbortController().signal);

      expect(replay.details?.returnValue).toEqual(['model-a', 'model-b']);
      expect(replay.details?.progress?.agents.map(agent => agent.lastActivity)).toEqual(['journal-replay', 'journal-replay']);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('records distinct journal entries for agent calls that only differ by effort', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-effort-journal-'));
    const spawnedEfforts: Array<string | undefined> = [];
    const script = `
      const first = await agent({ agent: 'scout', task: 'same task', label: 'Same' }, { effort: 'low' });
      const second = await agent({ agent: 'scout', task: 'same task', label: 'Same' }, { effort: 'high' });
      return [first, second];
    `;
    const first = makeTool(async args => {
      const effort = (args as SpawnChildSessionArgs & { effort?: string }).effort;
      spawnedEfforts.push(effort);
      return result(args.agentDef.name, effort ?? 'missing-effort');
    }, sessionPath);

    try {
      const firstOutput = await first.execute('call', { script }, new AbortController().signal);

      expect(firstOutput.details?.returnValue).toEqual(['low', 'high']);
      expect(spawnedEfforts).toEqual(['low', 'high']);

      const second = createWorkflowTool({
        getCwd: () => process.cwd(),
        getSessionPath: () => sessionPath,
        makeRunId: () => 'workflow-test-run-2',
        spawn: async () => {
          throw new Error('spawn should not run during effort replay');
        },
      });
      const replay = await second.execute('call', {
        resumeRunId: 'workflow-test-run',
        script,
      }, new AbortController().signal);

      expect(replay.details?.returnValue).toEqual(['low', 'high']);
      expect(replay.details?.progress?.agents.map(agent => agent.lastActivity)).toEqual(['journal-replay', 'journal-replay']);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('counts child tool starts in workflow progress', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-tool-calls-'));
    const updates: any[] = [];
    const tool = makeTool(async args => {
      args.onEvent?.({ type: 'tool_execution_start' } as any);
      args.onEvent?.({ type: 'tool_execution_start' } as any);
      return result(args.agentDef.name, 'ok');
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: "return agent({ agent: 'scout', task: 'use tools' });",
      }, new AbortController().signal, update => updates.push(update.details?.progress));

      expect(updates.flatMap(progress => progress?.agents ?? []).some(agent => agent.toolCalls === 2)).toBe(true);
      expect(output.details?.progress?.agents[0]?.toolCalls).toBe(2);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('runs named workflow recipes inline from the recipe registry', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-recipe-'));
    const recipes = new Map<string, string>([[
      'inspect',
      `
        phase('recipe');
        return agent({ agent: 'scout', task: args.task, label: 'Recipe Scout' });
      `,
    ]]);
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath, recipes);

    try {
      const output = await tool.execute('call', {
        script: "return workflow('inspect', { task: 'recipe task' });",
      }, new AbortController().signal);

      expect(output.details?.returnValue).toBe('recipe task');
      expect(output.details?.result?.status).toBe('done');
      expect(output.details?.progress?.agents[0]?.label).toBe('Recipe Scout');
      expect(output.details?.progress?.agents[0]?.phase).toBe('recipe');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('validates workflow recipe source through the sandbox gate', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-recipe-sandbox-'));
    const recipes = new Map<string, string>([['escape', "const fs = require('node:fs'); return fs;"]]);
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath, recipes);

    try {
      const output = await tool.execute('call', {
        script: "return workflow('escape');",
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('Workflow script rejected');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('rejects recursive inline workflow recipes with a closure-scoped guard', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-recipe-recursion-'));
    const recipes = new Map<string, string>([
      ['outer', "return workflow('inner');"],
      ['inner', "return 'should not run';"],
    ]);
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath, recipes);

    try {
      const output = await tool.execute('call', {
        script: "return workflow('outer');",
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('workflow() recursion is not allowed');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('rejects workflow nameOrRef values that are not registry keys', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-recipe-key-'));
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath, new Map());

    try {
      const output = await tool.execute('call', {
        script: "return workflow('../recipes/escape');",
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('workflow() nameOrRef must be a registry key');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('runs background workflows under a fresh signal and emits completion', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-background-'));
    const events: any[] = [];
    const turn = new AbortController();
    let spawnSignal: AbortSignal | undefined;
    let resolveSpawn!: (value: ChildSessionResult) => void;
    let resolveSpawnStarted!: () => void;
    let resolveCompleted!: (event: any) => void;
    let seals = 0;
    const spawnStarted = new Promise<void>(resolve => {
      resolveSpawnStarted = resolve;
    });
    const spawnResult = new Promise<ChildSessionResult>(resolve => {
      resolveSpawn = resolve;
    });
    const completed = new Promise<any>(resolve => {
      resolveCompleted = resolve;
    });
    const tool = createWorkflowTool({
      getCwd: () => process.cwd(),
      getSessionPath: () => sessionPath,
      makeRunId: () => 'workflow-background-run',
      emitEvent: event => {
        events.push(event);
        if (event.type === 'task_completed') resolveCompleted(event);
      },
      childSessionPort: { sealOwnerTask: async () => { seals += 1 } } as any,
      spawn: async args => {
        spawnSignal = args.signal;
        args.onAdmitted?.(args.requestedAgentId!);
        resolveSpawnStarted();
        return await spawnResult;
      },
    });

    try {
      const output = await tool.execute('call-bg', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'slow workflow' });",
      }, turn.signal);

      expect(textPartAt(output.content)).toContain('run_id: workflow-background-run');
      expect(textPartAt(output.content)).toContain('task_id: task-workflow-background-run');
      expect(textPartAt(output.content)).toContain('agent_ids: agent-workflow-background-run-1');
      expect(textPartAt(output.content)).not.toContain('task_id: workflow-background-run');
      expect(output.details?.backgrounded).toBe(true);
      expect(output.details?.taskId).toBe('task-workflow-background-run');
      expect(output.details?.agentIds).toEqual(['agent-workflow-background-run-1']);
      expect(events[0]).toEqual({
        type: 'task_backgrounded',
        toolUseId: 'call-bg',
        taskId: 'task-workflow-background-run',
        kind: 'workflow',
      });

      await spawnStarted;
      turn.abort();
      expect(spawnSignal?.aborted).toBe(false);

      resolveSpawn(result('scout', 'background done'));
      const completion = await completed;

      expect(completion.status).toBe('completed');
      expect(completion.taskId).toBe('task-workflow-background-run');
      expect(completion.summary).toContain('background done');
      expect(seals).toBe(1);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('stops background workflows by id through stopTask', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-background-stop-'));
    const events: any[] = [];
    let spawnSignal: AbortSignal | undefined;
    let resolveSpawnStarted!: () => void;
    let resolveCompleted!: (event: any) => void;
    let seals = 0;
    const spawnStarted = new Promise<void>(resolve => {
      resolveSpawnStarted = resolve;
    });
    const completed = new Promise<any>(resolve => {
      resolveCompleted = resolve;
    });
    let resolveChild!: (value: ChildSessionResult) => void;
    const stopped: string[] = [];
    const abortStateAtDescendantStop: boolean[] = [];
    const childPort = {
      stopTask: async (taskId: string) => {
        stopped.push(taskId);
        abortStateAtDescendantStop.push(spawnSignal?.aborted === true);
        resolveChild({ agent: 'scout', status: 'aborted', text: '', tokensIn: 0, tokensOut: 0, error: 'aborted' });
      },
      sealOwnerTask: async () => { seals += 1 },
    } as any;
    const backgroundTasks = new BackgroundTaskRegistry();
    const tool = createWorkflowTool({
      getCwd: () => process.cwd(),
      getSessionPath: () => sessionPath,
      makeRunId: () => 'workflow-background-stop',
      emitEvent: event => {
        events.push(event);
        if (event.type === 'task_completed') resolveCompleted(event);
      },
      childSessionPort: childPort,
      backgroundTasks,
      spawn: async args => {
        spawnSignal = args.signal;
        args.onAdmitted?.(args.requestedAgentId!);
        resolveSpawnStarted();
        return await new Promise<ChildSessionResult>(resolve => { resolveChild = resolve; });
      },
    });

    try {
      await tool.execute('call-bg-stop', {
        background: true,
        script: "return agent({ agent: 'scout', task: 'stop me' });",
      }, new AbortController().signal);
      await spawnStarted;

      const stop = await createStopTaskTool(childPort, backgroundTasks).execute('call-stop', {
        task_id: 'task-workflow-background-stop',
      }, undefined, undefined, {} as any);
      const completion = await completed;

      expect(textPartAt(stop.content)).toContain('Stopped task task-workflow-background-stop');
      expect(stop.details?.stopped).toBe(true);
      expect(spawnSignal?.aborted).toBe(true);
      expect(abortStateAtDescendantStop).toEqual([true]);
      expect(stopped).toEqual(['task-workflow-background-stop']);
      expect(completion.status).toBe('stopped');
      expect(completion.taskId).toBe('task-workflow-background-stop');
      expect(seals).toBe(1);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('stops a background run between workflow phases, before any child was admitted', async () => {
    // P2.131 dropped the background race's `setTimeout(0)` arm, so this call no
    // longer answers ahead of the run and the old premise — "returns a
    // background task BEFORE child admission" — is exactly what was traded
    // away. The subject is unchanged and is still the point: a stop that lands
    // while the run sits between phases, with nothing admitted, must reach the
    // run and report it stopped.
    //
    // `recipeRequested` is what replaces the awaited return as the signal that
    // the run is live: it fires from inside the evaluator's own lookup, and the
    // registry entry `stop_task` needs is created in the same synchronous block
    // that call unwinds into.
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-background-between-phases-'));
    const backgroundTasks = new BackgroundTaskRegistry();
    let resolveRecipe!: (source: string) => void;
    const recipe = new Promise<string>(resolve => { resolveRecipe = resolve; });
    let recipeAsked!: () => void;
    const recipeRequested = new Promise<void>(resolve => { recipeAsked = resolve; });
    let resolveCompleted!: (event: any) => void;
    const completed = new Promise<any>(resolve => { resolveCompleted = resolve; });
    const childPort = {
      stopTask: async () => { throw new Error('unknown-task-id:task-workflow-between-phases'); },
      sealOwnerTask: async () => {},
    } as any;
    const tool = createWorkflowTool({
      getCwd: () => process.cwd(),
      getSessionPath: () => sessionPath,
      makeRunId: () => 'workflow-between-phases',
      recipes: { get: async () => { recipeAsked(); return await recipe; } },
      childSessionPort: childPort,
      backgroundTasks,
      emitEvent: event => {
        if (event.type === 'task_completed') resolveCompleted(event);
      },
    });

    try {
      const call = tool.execute('call-between', {
        background: true,
        script: "phase('wait'); return workflow('paused', {});",
      }, new AbortController().signal);
      await recipeRequested;

      const stopping = createStopTaskTool(childPort, backgroundTasks).execute('stop-between', {
        task_id: 'task-workflow-between-phases',
      }, undefined, undefined, {} as any);
      // stopTask owns settlement: release the evaluator's pending recipe lookup,
      // then observe the terminal stopped result before the stop call returns.
      await Promise.resolve();
      resolveRecipe("return 'should not execute';");
      const stopped = await stopping;
      expect(stopped.details?.stopped).toBe(true);
      expect((await completed).status).toBe('stopped');

      // And the tool's OWN answer, now that it waits for the outcome: the run is
      // over and admitted nothing, so it is the refusal shape rather than a task
      // id inviting a stop that has already happened.
      const output = await call;
      expect(output.details?.result?.status).toBe('aborted');
      expect(output.details?.taskId).toBeUndefined();
      expect(output.details?.agentIds).toBeUndefined();
      const answer = output.content[0];
      expect(answer && 'text' in answer ? answer.text : '').not.toContain('Started background workflow run');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('returns an error when token budget is exceeded', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-budget-'));
    const tool = makeTool(async () => result('scout', 'too many tokens', 4, 4), sessionPath);

    try {
      const output = await tool.execute('call', {
        tokenBudget: 2,
        script: "return agent({ agent: 'scout', task: 'spend tokens' });",
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('tokenBudget exceeded');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('enforces maxAgents', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-maxagents-'));
    const tool = makeTool(async () => result('scout', 'ok'), sessionPath);

    try {
      const output = await tool.execute('call', {
        maxAgents: 1,
        script: `
          await agent({ agent: 'scout', task: 'one' });
          await agent({ agent: 'scout', task: 'two' });
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('maxAgents exceeded');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  // workflows.md §Cost: "The warning is advisory: it doesn't pause or limit the
  // run", and "If you choose a size guideline yourself, its agent count
  // replaces the 25-agent threshold." Both halves are asserted here, because a
  // guideline that blocks a run is the exact defect the plan warns about.
  it('warns advisorily past the size-guideline threshold without stopping the run', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-large-run-'));
    const tool = createWorkflowTool({
      getCwd: () => sessionPath,
      getSessionPath: () => sessionPath,
      makeRunId: () => 'workflow-large-run',
      spawn: async () => result('scout', 'ok'),
      getSizeGuideline: () => 'small',
    });

    try {
      const output = await tool.execute('call', {
        script: `
          for (let index = 0; index < 6; index += 1) {
            await agent({ agent: 'scout', task: 'item ' + index });
          }
          return 'done';
        `,
      }, new AbortController().signal);

      // Advice, not a cap: all six agents ran and the run succeeded.
      expect(output.details?.error).toBeUndefined();
      expect(output.details?.result?.status).toBe('done');
      expect(output.details?.progress?.agents).toHaveLength(6);
      expect(output.details?.progress?.warning).toContain('Large workflow');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('stays silent below the threshold and at the unrestricted default', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-small-run-'));
    const script = "await agent({ agent: 'scout', task: 'one' }); return 'done';";

    try {
      const guided = createWorkflowTool({
        getCwd: () => sessionPath,
        getSessionPath: () => sessionPath,
        makeRunId: () => 'workflow-small-run',
        spawn: async () => result('scout', 'ok'),
        getSizeGuideline: () => 'small',
      });
      expect((await guided.execute('call', { script }, new AbortController().signal))
        .details?.progress?.warning).toBeUndefined();

      const defaulted = makeTool(async () => result('scout', 'ok'), sessionPath);
      expect((await defaulted.execute('call', { script }, new AbortController().signal))
        .details?.progress?.warning).toBeUndefined();
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('handles a high-count run under the raised backstop with linear journal/progress growth', async () => {
    // T1 raised the runaway backstop 100 -> 1000. A run well above the old cap
    // must complete without tripping the backstop, and in-memory accumulation
    // must stay linear: one journal line + one progress state per agent, no
    // unbounded growth beyond the states array.
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-highcount-'));
    const AGENT_COUNT = 300; // > old default (100), < new default (1000)
    let spawns = 0;
    const tool = makeTool(async args => { spawns += 1; return result(args.agentDef.name, args.task); }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `for (let i = 0; i < ${AGENT_COUNT}; i++) { await agent({ agent: 'scout', task: 'task-' + i }); }`,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('done');
      expect(spawns).toBe(AGENT_COUNT);
      // Progress states grew exactly linearly — one entry per agent call.
      expect(output.details?.progress?.agents).toHaveLength(AGENT_COUNT);
      expect(output.details?.result?.results).toHaveLength(AGENT_COUNT);
      // Journal persisted exactly one record per agent (distinct prompts).
      const journalLines = readFileSync(join(sessionPath, '.orchestrator', 'workflow-test-run.jsonl'), 'utf-8')
        .split('\n').filter(Boolean);
      expect(journalLines).toHaveLength(AGENT_COUNT);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('aborts the workflow on token budget failures inside parallel', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-parallel-budget-'));
    const spawnedTasks: string[] = [];
    const tool = makeTool(async args => {
      spawnedTasks.push(args.task);
      return result(args.agentDef.name, args.task, 1, 1);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        tokenBudget: 1,
        script: `
          await parallel([
            () => agent({ agent: 'scout', task: 'over budget' }),
          ]);
          await parallel([
            () => agent({ agent: 'scout', task: 'must not run 1' }),
            () => agent({ agent: 'scout', task: 'must not run 2' }),
          ]);
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('tokenBudget exceeded');
      expect(output.details?.result?.failures).toBeUndefined();
      expect(spawnedTasks).toEqual(['over budget']);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('aborts the workflow on maxAgents failures inside parallel', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-parallel-maxagents-'));
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);

    try {
      const output = await tool.execute('call', {
        maxAgents: 1,
        script: `
          await parallel([
            () => agent({ agent: 'scout', task: 'one' }),
            () => agent({ agent: 'scout', task: 'two' }),
          ]);
          log('after parallel');
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('maxAgents exceeded');
      expect(output.details?.logs).toEqual([]);
      expect(output.details?.result?.failures).toBeUndefined();
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('aborts the workflow on token budget failures inside pipeline', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-pipeline-budget-'));
    const spawnedTasks: string[] = [];
    const tool = makeTool(async args => {
      spawnedTasks.push(args.task);
      return result(args.agentDef.name, args.task, 1, 1);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        tokenBudget: 1,
        script: `
          await pipeline(
            ['over budget'],
            item => agent({ agent: 'scout', task: item }),
          );
          await agent({ agent: 'scout', task: 'must not run' });
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('tokenBudget exceeded');
      expect(output.details?.result?.failures).toBeUndefined();
      expect(spawnedTasks).toEqual(['over budget']);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  /**
   * P6.320 — the per-call fan-out cap from `workflows.md#behavior-and-limits`
   * ("Up to 4,096 items in a single `parallel()` or `pipeline()` call: the
   * runtime rejects a longer list with an error").
   *
   * Each helper gets a refusal case whose list would spawn, so `spawnedTasks`
   * being empty is the "BEFORE dispatching anything" assertion rather than a
   * restatement of the throw, and a boundary case at exactly 4,096. The
   * boundary case deliberately does NOT call `agent()`: `DEFAULT_MAX_AGENTS`
   * aborts the run on the 1001st agent, so a spawning 4,096-item list would go
   * red on the OTHER cap and prove nothing about this one.
   */
  it('refuses a parallel() list longer than the documented cap before dispatching anything', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-parallel-fanout-'));
    const spawnedTasks: string[] = [];
    const tool = makeTool(async args => {
      spawnedTasks.push(args.task);
      return result(args.agentDef.name, args.task);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          await parallel(Array.from({ length: 4097 }, () => () => agent({ agent: 'scout', task: 'must not run' })));
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('parallel() accepts at most 4096 items, received 4097');
      expect(spawnedTasks).toEqual([]);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('runs a parallel() list of exactly the documented cap', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-parallel-fanout-ok-'));
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          const values = await parallel(Array.from({ length: 4096 }, (_, index) => () => index));
          log('parallel:' + values.length);
        `,
      }, new AbortController().signal);

      expect(output.details?.error).toBeUndefined();
      expect(output.details?.logs).toContain('parallel:4096');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('refuses a pipeline() list longer than the documented cap before dispatching anything', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-pipeline-fanout-'));
    const spawnedTasks: string[] = [];
    const tool = makeTool(async args => {
      spawnedTasks.push(args.task);
      return result(args.agentDef.name, args.task);
    }, sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          await pipeline(
            Array.from({ length: 4097 }, (_, index) => index),
            () => agent({ agent: 'scout', task: 'must not run' }),
          );
        `,
      }, new AbortController().signal);

      expect(output.details?.result?.status).toBe('error');
      expect(output.details?.error).toContain('pipeline() accepts at most 4096 items, received 4097');
      expect(spawnedTasks).toEqual([]);
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });

  it('runs a pipeline() list of exactly the documented cap', async () => {
    const sessionPath = mkdtempSync(join(tmpdir(), 'workflow-pipeline-fanout-ok-'));
    const tool = makeTool(async args => result(args.agentDef.name, args.task), sessionPath);

    try {
      const output = await tool.execute('call', {
        script: `
          const values = await pipeline(Array.from({ length: 4096 }, (_, index) => index), item => item + 1);
          log('pipeline:' + values.length);
        `,
      }, new AbortController().signal);

      expect(output.details?.error).toBeUndefined();
      expect(output.details?.logs).toContain('pipeline:4096');
    } finally {
      rmSync(sessionPath, { recursive: true, force: true });
    }
  });
});
