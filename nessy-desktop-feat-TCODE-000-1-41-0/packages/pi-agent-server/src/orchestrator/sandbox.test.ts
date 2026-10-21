import { describe, expect, it } from 'bun:test';

import {
  WorkflowEvaluationLimitError,
  compileWorkflowScript,
  validateWorkflowScript,
} from './sandbox.ts';

const noopApi = () => ({
  agent: async (prompt: unknown) => `saw ${String(prompt)}`,
  workflow: async () => 'unused',
  parallel: async (thunks: Array<() => unknown>) => Promise.all(thunks.map(thunk => thunk())),
  pipeline: async (items: unknown[]) => items,
  phase: (title: unknown) => String(title),
  log: (message: unknown) => String(message),
  args: {},
  budget: { spent: () => 0, remaining: () => undefined },
});

describe('workflow sandbox', () => {
  it('allows normal orchestration scripts', () => {
    expect(() => validateWorkflowScript(`
      phase('inspect');
      const result = await agent('read the workspace', { agent: 'scout' });
      log(result);
      return result;
    `)).not.toThrow();
  });

  it('rejects escape attempts', () => {
    const rejected = [
      "import fs from 'node:fs'",
      "const fs = require('node:fs')",
      'process.env.HOME',
      'globalThis.fetch',
      "eval('1 + 1')",
      "Function('return 1')()",
      "({}).constructor.constructor('return process')()",
    ];

    for (const script of rejected) {
      expect(() => validateWorkflowScript(script)).toThrow(/Workflow script rejected/);
    }
  });

  it('rejects nondeterministic time and random APIs', () => {
    const rejected = [
      { script: 'Date.now()', message: /Date/ },
      { script: 'new Date()', message: /Date/ },
      { script: 'Math.random()', message: /random/ },
    ];

    for (const { script, message } of rejected) {
      expect(() => validateWorkflowScript(script)).toThrow(message);
    }
  });

  it('executes via injected APIs', async () => {
    const run = compileWorkflowScript(`
      phase('one');
      const value = await agent(args.prompt, { agent: 'scout' });
      return value;
    `);

    await expect(run({
      agent: async prompt => `saw ${prompt}`,
      workflow: async () => 'unused',
      parallel: async thunks => Promise.all(thunks.map(thunk => thunk())),
      pipeline: async items => items,
      phase: title => title,
      log: message => message,
      args: { prompt: 'hello' },
      budget: { spent: () => 0, remaining: () => undefined },
    })).resolves.toBe('saw hello');
  });

  it('executes workflow recipes via the injected workflow helper', async () => {
    const run = compileWorkflowScript(`
      return workflow('recipe-key', { prompt: args.prompt });
    `);

    await expect(run({
      agent: async prompt => `saw ${prompt}`,
      workflow: async (name, recipeArgs) => `${name}:${(recipeArgs as any).prompt}`,
      parallel: async thunks => Promise.all(thunks.map(thunk => thunk())),
      pipeline: async items => items,
      phase: title => title,
      log: message => message,
      args: { prompt: 'hello' },
      budget: { spent: () => 0, remaining: () => undefined },
    })).resolves.toBe('recipe-key:hello');
  });

  it('bounds a synchronous infinite loop instead of blocking the event loop', async () => {
    const run = compileWorkflowScript('while (true) {}', { maxSyncMs: 50 });
    let looped = false;
    // A parallel timer proves the event loop is not permanently blocked: it must
    // still fire, and the workflow must reject with a deadline error, not hang.
    const timer = new Promise<void>(resolve => setTimeout(() => { looped = true; resolve(); }, 10));
    await expect(run(noopApi())).rejects.toBeInstanceOf(WorkflowEvaluationLimitError);
    await timer;
    expect(looped).toBe(true);
  });

  it('bounds every synchronous loop back-edge shape, not just block bodies', async () => {
    // Each of these is an uninterrupted synchronous loop with a NON-block or
    // otherwise easily-missed body; every one must be bounded by the deadline
    // guard rather than block the event loop.
    const hostileLoops = [
      'for (;;);',                       // empty-statement body
      'for (;;) {}',                     // empty block body
      'while (true) {}',                 // classic
      'let a = 0; while (true) a;',      // single non-block statement body
      'do {} while (true);',             // do-while
      'let n = 0; do n++; while (true);',// do-while non-block body
      'outer: while (true) { continue outer; }', // labeled loop
      'for (let i = 0; i >= 0; i++) i--;',       // for with non-block body
      'label: for (;;) continue label;',         // labeled non-block for
    ];
    for (const script of hostileLoops) {
      const run = compileWorkflowScript(script, { maxSyncMs: 50 });
      await expect(run(noopApi()), script).rejects.toBeInstanceOf(WorkflowEvaluationLimitError);
    }
  });

  it('bounds a synchronous loop that never awaits via a recursive helper', async () => {
    const run = compileWorkflowScript(
      'function spin() { return spin(); } return spin();',
      { maxSyncMs: 50 },
    );
    await expect(run(noopApi())).rejects.toBeInstanceOf(WorkflowEvaluationLimitError);
  });

  it('bounds concise-arrow tail-call recursion (no block body)', async () => {
    const run = compileWorkflowScript(
      'const spin = () => spin(); return spin();',
      { maxSyncMs: 50 },
    );
    await expect(run(noopApi())).rejects.toBeInstanceOf(WorkflowEvaluationLimitError);
  });

  it('preserves concise-arrow value and object-literal bodies through the guard wrap', async () => {
    // A concise arrow returning an object literal, and precedence-sensitive
    // expressions, must compute the same values after the guard-sequence wrap.
    const run = compileWorkflowScript(`
      const make = (n) => ({ n, doubled: n * 2 });
      const add = (a, b) => a + b;
      const first = (await parallel([() => agent('x', { agent: 'scout' })]))[0];
      const obj = make(3);
      return first + '|' + obj.doubled + '|' + add(1, 2);
    `, { maxSyncMs: 200 });
    await expect(run(noopApi())).resolves.toBe('saw x|6|3');
  });

  it('bounds oversized synchronous output', async () => {
    const run = compileWorkflowScript(
      'let s = "x"; for (let i = 0; i < 1e9; i++) { s = log(s + s); } return s;',
      { maxSyncMs: 1000, maxOutputBytes: 4096 },
    );
    await expect(run(noopApi())).rejects.toBeInstanceOf(WorkflowEvaluationLimitError);
  });

  it('preserves evaluation order and results through nested awaits and concise arrows', async () => {
    // Nested await operands and concise-body arrows must instrument without
    // changing what the script computes.
    const run = compileWorkflowScript(`
      const outer = await agent(await agent('inner', { agent: 'scout' }), { agent: 'scout' });
      const mapped = (await parallel([() => agent('a', { agent: 'scout' })])).map(x => x);
      return outer + '|' + mapped[0];
    `, { maxSyncMs: 200 });
    await expect(run(noopApi())).resolves.toBe('saw saw inner|saw a');
  });

  it('does not kill a legitimate workflow whose awaits yield the loop', async () => {
    // Each await resets the synchronous-slice budget, so a workflow that awaits
    // between light synchronous work must complete even with a small ceiling.
    const run = compileWorkflowScript(`
      let acc = '';
      for (let i = 0; i < 5; i++) {
        acc = await agent('step ' + i, { agent: 'scout' });
      }
      return acc;
    `, { maxSyncMs: 50 });
    await expect(run(noopApi())).resolves.toBe('saw step 4');
  });

  it('does not inject the removed child compatibility alias', async () => {
    const run = compileWorkflowScript(`
      return child(args.prompt, { agent: 'scout' });
    `);

    await expect(run({
      agent: async prompt => `saw ${prompt}`,
      workflow: async () => 'unused',
      parallel: async thunks => Promise.all(thunks.map(thunk => thunk())),
      pipeline: async items => items,
      phase: title => title,
      log: message => message,
      args: { prompt: 'alias' },
      budget: { spent: () => 0, remaining: () => undefined },
    })).rejects.toThrow('child is not defined');
  });
});
