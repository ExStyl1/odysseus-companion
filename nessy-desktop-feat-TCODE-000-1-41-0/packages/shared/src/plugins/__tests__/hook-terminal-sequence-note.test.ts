/**
 * F1.558 — a hook's `terminalSequence` is still ignored, and now the run history
 * says so.
 *
 * The measured null this row decides on: the host accepts the field, allowlists
 * it (`automations/hook-command.ts`, `allowlistedTerminalSequence`) and, on
 * claude, forwards it to the SDK (`sdkUniversalHookOutput`) — and NO surface
 * shows it on any runtime: C3.89 on claude and codex (packaged 1.36.0, with a
 * `systemMessage` control that did render) and SIT-5f on Pi (packaged 1.40.0,
 * the same document's `systemMessage` reached the transcript while the OSC
 * marker reached nothing). The page's own limit is "interactive sessions only",
 * and the desktop app has no terminal.
 *
 * DECIDED by the controller (TRANSPARENT and SIMPLE): keep ignoring it, but say
 * so where the user looks at hooks — one line on that run's row in the run
 * history (`/hooks`), never in the transcript on a clean run. The line rides the
 * row's `stderr`, the field this file's other host-authored run lines already use
 * (`prompt-hook-no-verdict`, the http/mcp_tool codes), with its own code prefix so
 * it can never be read as the hook's own output.
 *
 * Driven through the production executor (`PluginScopedAutomationSystem`, the one
 * `host-hook-runs-production-executor.test.ts` measured as the only live
 * agent-event path) with the host's own runner seam — nothing planted.
 */
import { describe, expect, it } from 'bun:test';
import { PluginScopedAutomationSystem, type CommandHookRunner } from '../hooks-automation.ts';
import type { AutomationsConfig, HookCommandActionResult } from '../../automations/types.ts';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** OSC 2 (window title) — on the page's allowlist. */
const OSC_TITLE = `${ESC}]2;F1558-TITLE${BEL}`;
/** OSC 52 (clipboard) — the page and `ALLOWED_OSC_CODES` both reject it. */
const OSC_CLIPBOARD = `${ESC}]52;c;RjE1NTg=${BEL}`;

/** The line itself, spelled out: it is what the user reads in `/hooks`. */
const TERMINAL_SEQUENCE_IGNORED_NOTE = 'terminal-sequence-ignored: the desktop app has no terminal, so the terminalSequence this hook returned was not written anywhere';

const INPUT = { hook_event_name: 'UserPromptSubmit', prompt: 'hello' } as const;

function config(hooks: Array<{ name: string; command: string }>): AutomationsConfig {
  return {
    automations: {
      UserPromptSubmit: hooks.map(hook => ({ name: hook.name, actions: [{ type: 'command', command: hook.command }] })),
    },
  } as unknown as AutomationsConfig;
}

function runnerFor(results: Record<string, Partial<HookCommandActionResult>>): CommandHookRunner {
  return async (action): Promise<HookCommandActionResult> => ({
    type: 'command',
    command: action.command,
    success: true,
    exitCode: 0,
    signal: null,
    durationMs: 1,
    ...results[action.command],
  } as HookCommandActionResult);
}

async function run(hooks: Array<{ name: string; command: string }>, results: Record<string, Partial<HookCommandActionResult>>) {
  const system = new PluginScopedAutomationSystem({
    pluginHookConfig: config(hooks),
    workspaceRootPath: '/tmp/f1558-workspace',
    pluginCommandRunner: runnerFor(results),
  });
  return system.executeAgentEvent('UserPromptSubmit', INPUT);
}

describe('F1.558 · a returned terminalSequence is named as ignored, once, on its run row', () => {
  it('adds exactly one note line to the run that returned an allowlisted sequence', async () => {
    const stdout = JSON.stringify({ terminalSequence: OSC_TITLE });
    const result = await run([{ name: 'bell', command: 'bell.sh' }], { 'bell.sh': { stdout } });
    const runs = [...(result.hookRuns ?? [])];
    expect(runs).toHaveLength(1);
    const row = runs[0]!;
    // Read into locals before asserting (AGENTS.md: toMatchObject mutates).
    const stderr = row.stderr;
    const outcome = row.outcome;
    expect(outcome).toBe('success');
    expect(stderr).toBe(TERMINAL_SEQUENCE_IGNORED_NOTE);
    expect(stderr?.split('\n').filter(line => line === TERMINAL_SEQUENCE_IGNORED_NOTE)).toHaveLength(1);
    // The hook's own stdout is untouched on the row.
    expect(row.stdout).toBe(stdout);
    // "keep ignoring it" — the accepted field still travels exactly as before.
    expect(result.universal?.terminalSequence).toBe(OSC_TITLE);
  });

  it('keeps the hook\'s own stderr first and adds the note after it', async () => {
    const stdout = JSON.stringify({ terminalSequence: BEL, systemMessage: 'done' });
    const result = await run([{ name: 'bell', command: 'bell.sh' }], { 'bell.sh': { stdout, stderr: 'own diagnostics\n' } });
    const stderr = result.hookRuns?.[0]?.stderr;
    expect(stderr).toBe(`own diagnostics\n${TERMINAL_SEQUENCE_IGNORED_NOTE}`);
    expect(result.universal?.systemMessage).toBe('done');
  });

  it('notes each run that returned one, and no run that did not', async () => {
    const result = await run(
      [
        { name: 'bell', command: 'bell.sh' },
        { name: 'quiet', command: 'quiet.sh' },
        { name: 'title', command: 'title.sh' },
      ],
      {
        'bell.sh': { stdout: JSON.stringify({ terminalSequence: BEL }) },
        'quiet.sh': { stdout: JSON.stringify({ systemMessage: 'hi' }) },
        'title.sh': { stdout: JSON.stringify({ terminalSequence: OSC_TITLE }) },
      },
    );
    const stderrs = (result.hookRuns ?? []).map(row => row.stderr);
    expect(stderrs).toEqual([TERMINAL_SEQUENCE_IGNORED_NOTE, undefined, TERMINAL_SEQUENCE_IGNORED_NOTE]);
  });

  it('CONTROL — other outputs are unchanged: no note for plain text, a systemMessage, or a failing hook with no sequence', async () => {
    const result = await run(
      [
        { name: 'text', command: 'text.sh' },
        { name: 'msg', command: 'msg.sh' },
        { name: 'broken', command: 'broken.sh' },
      ],
      {
        'text.sh': { stdout: 'plain words\n' },
        'msg.sh': { stdout: JSON.stringify({ systemMessage: 'shown' }) },
        'broken.sh': { success: false, exitCode: 1, stderr: 'boom\n' },
      },
    );
    const rows = [...(result.hookRuns ?? [])];
    expect(rows.map(row => row.stderr)).toEqual([undefined, undefined, 'boom\n']);
    expect(result.universal?.terminalSequence).toBeUndefined();
  });

  it('BOUNDARY — a sequence the allowlist rejects is dropped whole by the page\'s own rule and gets no note', async () => {
    const result = await run([{ name: 'clip', command: 'clip.sh' }], {
      'clip.sh': { stdout: JSON.stringify({ terminalSequence: OSC_CLIPBOARD }) },
    });
    expect(result.hookRuns?.[0]?.stderr).toBeUndefined();
    expect(result.universal?.terminalSequence).toBeUndefined();
  });
});
