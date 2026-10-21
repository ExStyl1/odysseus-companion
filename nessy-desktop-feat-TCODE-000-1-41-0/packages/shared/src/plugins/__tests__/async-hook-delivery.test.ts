/**
 * C3.301 — a background (`async`) command hook's output is delivered, and an
 * `asyncRewake` hook's exit 2 is the wake the page makes an exception for.
 *
 * This file REPLACES `async-rewake-not-executed.test.ts`, which C3.283 wrote as
 * an inverted guard for its own refusal and whose docblock says a red there *"is
 * the signal to delete this file"*. The executor is built, so the file is gone
 * and the same three stop points are asserted from the other side.
 *
 * ## The contract, verbatim (anchors verified on the RENDERED page 2026-09-12:
 * 516 published ids; `command-hook-fields`, `limitations`,
 * `how-async-hooks-execute` and `json-output` each resolve once; a fabricated
 * control scores 0)
 *
 * - `hooks.md#command-hook-fields`, `asyncRewake`: *"If `true`, runs in the
 *   background and wakes Claude on exit code 2. The hook's stderr, or stdout if
 *   stderr is empty, is shown to Claude as a system reminder so it can react to
 *   a long-running background failure"*.
 * - `hooks.md#how-async-hooks-execute`: *"After the background process exits,
 *   Claude Code delivers the `additionalContext` and `systemMessage` fields from
 *   the hook's JSON response to Claude on the next conversation turn. Unlike a
 *   synchronous hook's `systemMessage`, neither field is shown to you."*
 * - `hooks.md#limitations`: *"Hook output is delivered on the next conversation
 *   turn. If the session is idle, the response waits until the next user
 *   interaction. Exception: an `asyncRewake` hook that exits with code 2 wakes
 *   Claude immediately even when the session is idle."*
 *
 * The two sentences are one rule and its exception, which is why the note
 * carries a `kind` and the HOST — not this module — decides where it lands.
 *
 * ## Why the settle is awaited with a macrotask
 *
 * The branch is still fire-and-forget by contract: `executePluginHookAutomations`
 * returns without waiting for a background hook, so the note necessarily arrives
 * after the call resolves. The `await settle()` below is the test acknowledging
 * that, not a workaround — a note that needed no tick would mean the event had
 * started blocking on a hook the page says never blocks.
 */
import { describe, expect, it } from 'bun:test';
import { executePluginHookAutomations, type PluginAsyncHookNote } from '../hooks-automation.ts';
import { buildPluginHookAutomations } from '../../capabilities/runtime-automations.ts';
import type { AutomationsConfig, HookCommandAction, HookCommandActionResult } from '../../automations/types.ts';
import type { RuntimeHookRegistration } from '../../capabilities/resolver.ts';

const workspaceRootPath = process.cwd();

/** Let the fire-and-forget `.then` run. */
const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

function commandConfig(action: Partial<HookCommandAction>): AutomationsConfig {
  return {
    automations: {
      Stop: [{
        id: 'toolkit/watch',
        name: 'toolkit/watch',
        actions: [{ type: 'command', command: 'echo hi', ...action }],
      }],
    },
  } as unknown as AutomationsConfig;
}

function runResult(over: Partial<HookCommandActionResult>): HookCommandActionResult {
  return {
    type: 'command',
    command: 'echo hi',
    success: true,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...over,
  };
}

/** Runs the event with a fake command runner and collects what the host would receive. */
async function runWith(
  config: AutomationsConfig,
  result: HookCommandActionResult,
  options: { emitter?: boolean } = { emitter: true },
): Promise<{ notes: PluginAsyncHookNote[]; ran: number; matchedCount: number }> {
  const notes: PluginAsyncHookNote[] = [];
  let ran = 0;
  const execution = await executePluginHookAutomations(config, 'Stop', { hook_event_name: 'Stop' }, {
    workspaceRootPath,
    runner: async () => { ran += 1; return result; },
    ...(options.emitter ? { asyncNoteEmitter: (note: PluginAsyncHookNote) => { notes.push(note); } } : {}),
  });
  await settle();
  return { notes, ran, matchedCount: execution.matchedCount };
}

describe('C3.301 — stop 1: the flag survives the action builder', () => {
  it('an imported `asyncRewake` hook reaches the executor with BOTH flags set', () => {
    const registration = {
      key: 'plugin://toolkit/hook.watch@workspace',
      event: 'Stop',
      type: 'command',
      command: './watch.sh',
      async: true,
      asyncRewake: true,
    } as unknown as RuntimeHookRegistration;

    const config = buildPluginHookAutomations([registration]);
    const action = config.automations.Stop?.[0]?.actions[0] as HookCommandAction | undefined;

    // `asyncRewake` implies `async`, and the import path stores both — so the
    // POSITIVE CONTROL is that the half which always worked still does.
    expect(action?.async).toBe(true);
    expect(action?.asyncRewake).toBe(true);
  });

  it('CONTROL: a plain `async` hook does NOT gain the rewake flag', () => {
    const registration = {
      key: 'plugin://toolkit/hook.watch@workspace',
      event: 'Stop',
      type: 'command',
      command: './watch.sh',
      async: true,
    } as unknown as RuntimeHookRegistration;

    const action = buildPluginHookAutomations([registration])
      .automations.Stop?.[0]?.actions[0] as HookCommandAction | undefined;

    expect(action?.async).toBe(true);
    expect(action?.asyncRewake).toBeUndefined();
  });
});

describe('C3.301 — stop 2: the background run is no longer discarded', () => {
  it('a plain `async` hook delivers `additionalContext` and `systemMessage`', async () => {
    const { notes, ran, matchedCount } = await runWith(
      commandConfig({ async: true }),
      runResult({ stdout: JSON.stringify({ additionalContext: 'tests passed', systemMessage: 'suite green' }) }),
    );

    expect(ran).toBe(1);
    expect(matchedCount).toBe(1);
    // Both documented fields, both as `delivery` — the page's rule, not its
    // exception, so the host must not wake an idle session for them.
    expect(notes.map(note => ({ kind: note.kind, text: note.text }))).toEqual([
      { kind: 'delivery', text: 'tests passed' },
      { kind: 'delivery', text: 'suite green' },
    ]);
    expect(notes.every(note => note.hookName === 'toolkit/watch' && note.event === 'Stop')).toBe(true);
  });

  it('a background hook that printed nothing usable delivers nothing', async () => {
    // NEGATIVE, and the one that keeps the surface quiet: the overwhelming
    // majority of background hooks print a log line, not a JSON response.
    const { notes, ran } = await runWith(
      commandConfig({ async: true }),
      runResult({ stdout: 'building...\n' }),
    );

    expect(ran).toBe(1);
    expect(notes).toEqual([]);
  });

  it('no emitter means no delivery, and the hook still runs', async () => {
    // The pre-C3.301 behaviour, kept reachable: an absent emitter may not throw
    // into the event that started the hook.
    const { notes, ran } = await runWith(
      commandConfig({ async: true }),
      runResult({ stdout: JSON.stringify({ additionalContext: 'tests passed' }) }),
      { emitter: false },
    );

    expect(ran).toBe(1);
    expect(notes).toEqual([]);
  });
});

describe('C3.301 — the exception: `asyncRewake` plus exit 2', () => {
  it('exit 2 wakes with stderr', async () => {
    const { notes } = await runWith(
      commandConfig({ async: true, asyncRewake: true }),
      runResult({ success: false, exitCode: 2, stderr: 'deploy failed: 3 checks red', stdout: 'ignored' }),
    );

    expect(notes).toEqual([
      { kind: 'rewake', hookName: 'toolkit/watch', event: 'Stop', text: 'deploy failed: 3 checks red' },
    ]);
  });

  it('exit 2 with EMPTY stderr wakes with stdout — the page names the fallback', async () => {
    const { notes } = await runWith(
      commandConfig({ async: true, asyncRewake: true }),
      runResult({ success: false, exitCode: 2, stderr: '   ', stdout: 'deploy failed on stdout' }),
    );

    expect(notes).toEqual([
      { kind: 'rewake', hookName: 'toolkit/watch', event: 'Stop', text: 'deploy failed on stdout' },
    ]);
  });

  it('NEGATIVE: a plain `async` hook exiting 2 is NOT a wake', async () => {
    // The exception belongs to `asyncRewake`, and this is the case the whole
    // `kind` field exists to keep apart. Its stdout is still read for the
    // documented delivery, which is the POSITIVE half of the same run.
    const { notes } = await runWith(
      commandConfig({ async: true }),
      runResult({
        success: false,
        exitCode: 2,
        stderr: 'noisy',
        stdout: JSON.stringify({ additionalContext: 'still context' }),
      }),
    );

    expect(notes.map(note => note.kind)).toEqual(['delivery']);
    expect(notes[0]?.text).toBe('still context');
  });

  it('NEGATIVE: an `asyncRewake` hook that SUCCEEDS takes the ordinary delivery', async () => {
    const { notes } = await runWith(
      commandConfig({ async: true, asyncRewake: true }),
      runResult({ stdout: JSON.stringify({ systemMessage: 'watch finished' }) }),
    );

    expect(notes).toEqual([
      { kind: 'delivery', hookName: 'toolkit/watch', event: 'Stop', text: 'watch finished' },
    ]);
  });

  it('NEGATIVE: a non-background hook emits no note at all', async () => {
    // A synchronous hook's output rides the decision contract, which is a
    // different seam; a note here would deliver the same bytes twice.
    const { notes, ran } = await runWith(
      commandConfig({}),
      runResult({ stdout: JSON.stringify({ additionalContext: 'sync context' }) }),
    );

    expect(ran).toBe(1);
    expect(notes).toEqual([]);
  });
});
