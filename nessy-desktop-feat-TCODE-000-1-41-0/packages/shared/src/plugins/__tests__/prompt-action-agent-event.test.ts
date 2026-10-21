/**
 * UB12.49 (F1.786's sibling, born by lane L-CRIT at UB12.28) — a native
 * `prompt` action bound to an AGENT event never runs, and is now SAID to never
 * run: inert in the hook binding view (`/hooks`) and warned at validation.
 *
 * The premise, read at HEAD 38b018cef: the App-event PromptHandler returns
 * early on every non-App event (`automations/handlers/prompt-handler.ts`, the
 * `APP_EVENTS` guard in `handleEvent`; upstream v0.15.1's has the same guard
 * and its `executeAgentEvent` only counts matches), and the dispatch loop of
 * `executePluginHookAutomations` collects `plugin-prompt` judges only — a
 * native `prompt` matched no branch. `hookBindingHandlerType` still mapped it to
 * a live `prompt` row and `automations/validation.ts` warned for `script` alone,
 * so a configured prompt under `PreToolUse` matched, did nothing and said
 * nothing.
 *
 * The fix is the row's option (a), UA12.33's shape: `isInertHookBinding` marks
 * the pairing inert and validation warns, rather than running it — a native
 * prompt STARTS A SESSION (connection, model, the matcher's labels), which is
 * the PromptHandler's App-event authority and not a hook's answer.
 *
 * The arms:
 *   P1. the view: one row per action, the command sibling live, the prompt row
 *       `handlerType: 'prompt'` AND `inert: true`; the `/hooks` line reads inert;
 *   P2. validation: the pairing loads (valid) with a warning naming the prompt
 *       action and the event;
 *   P3. the run agrees with the view: the command runs, the judge runner is
 *       never consulted for the native prompt;
 *   N.  the same action under an App event (`LabelAdd`) stays live in the view
 *       predicate and is not warned.
 */
import { describe, expect, it } from 'bun:test';
import { executePluginHookAutomations, hookBindingsForMatcher, isInertHookBinding, type CommandHookRunner, type PluginPromptHookRunner } from '../hooks-automation.ts';
import { validateAutomationsConfig } from '../../automations/validation.ts';
import { formatHookBindingLine } from '../../slash-commands/hooks-command.ts';
import type { AutomationMatcher, AutomationsConfig, HookCommandActionResult } from '../../automations/types.ts';

const PROMPT_ACTION = { type: 'prompt' as const, prompt: 'Summarise what the agent just did', llmConnection: 'fixture-connection' };

function commandSpy(commands: string[]): CommandHookRunner {
  return async action => {
    commands.push(action.command);
    return { type: 'command', command: action.command, success: true, exitCode: 0, signal: null, durationMs: 1, stdout: '' } as HookCommandActionResult;
  };
}

describe('UB12.49 — a native prompt action on an agent event is inert and warned', () => {
  it('P1: the binding view shows the prompt row INERT beside its live command sibling', () => {
    const matcher = {
      name: 'summarise-bash',
      matcher: 'Bash',
      actions: [{ type: 'command', command: 'true' }, PROMPT_ACTION],
    } as unknown as AutomationMatcher;
    const rows = hookBindingsForMatcher('PreToolUse', matcher, 'user');
    expect(rows).toEqual([
      { event: 'PreToolUse', tier: 'user', handlerType: 'command', name: 'summarise-bash', matcher: 'Bash', enabled: true },
      { event: 'PreToolUse', tier: 'user', handlerType: 'prompt', inert: true, name: 'summarise-bash', matcher: 'Bash', enabled: true },
    ]);
    // The `/hooks` line is the user-facing half of the same flag.
    expect(formatHookBindingLine(rows[1]!)).toContain('inert (never runs on this event)');
    expect(formatHookBindingLine(rows[0]!)).not.toContain('inert');
    // Every agent event, not only PreToolUse: no path runs a native prompt on any of them.
    expect(isInertHookBinding(PROMPT_ACTION, 'PostToolUse')).toBe(true);
    expect(isInertHookBinding(PROMPT_ACTION, 'UserPromptSubmit')).toBe(true);
  });

  it('P2: validation loads the pairing and warns that the prompt action never runs on PreToolUse', () => {
    const validation = validateAutomationsConfig({
      version: 2,
      automations: { PreToolUse: [{ matcher: 'Bash', actions: [PROMPT_ACTION] }] },
    });
    expect(validation.valid).toBe(true);
    expect(validation.warnings).toEqual([
      'automations.PreToolUse[0].actions[0]: A prompt action runs only on App events '
        + '(LabelAdd, LabelRemove, LabelConfigChange, PermissionModeChange, FlagChange, SessionStatusChange, SchedulerTick); '
        + 'on PreToolUse it never runs',
    ]);
  });

  it('P3: the run agrees with the view — the command runs and no runner is handed the native prompt', async () => {
    const commands: string[] = [];
    const judged: string[] = [];
    const promptRunner: PluginPromptHookRunner = async request => {
      judged.push(request.prompt);
      return { ok: true };
    };
    const config = {
      automations: { PreToolUse: [{ id: 'ub12-49', matcher: 'Bash', actions: [{ type: 'command', command: 'true' }, PROMPT_ACTION] }] },
    } as unknown as AutomationsConfig;
    const result = await executePluginHookAutomations(
      config,
      'PreToolUse',
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo ub12-49' } },
      { workspaceRootPath: '/tmp/ub12-49-workspace', runner: commandSpy(commands), promptRunner, hookSource: 'user' },
    );
    expect(result.matchedCount).toBe(1);
    expect(commands).toEqual(['true']);
    expect(judged).toEqual([]);
    expect(result.decision).toBeUndefined();
    // The stated residue: the dispatch adds no per-call notice — the author is told by validation (P2) and /hooks (P1).
    expect(result.hookErrors ?? []).toEqual([]);
  });

  it('N: the same action under an App event (LabelAdd) stays live and unwarned', () => {
    expect(isInertHookBinding(PROMPT_ACTION, 'LabelAdd' as never)).toBe(false);
    const validation = validateAutomationsConfig({
      version: 2,
      automations: { LabelAdd: [{ matcher: 'urgent', actions: [PROMPT_ACTION] }] },
    });
    expect(validation.valid).toBe(true);
    expect(validation.warnings).toEqual([]);
  });
});
