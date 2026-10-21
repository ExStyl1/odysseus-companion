/**
 * F1.171 (origin WJ-d's F1.76-C) — the SDK's per-matcher hook budget, and the
 * UNIT this fork had wrong in the one place it sent the field.
 *
 * ## The row's premise, and its refutation
 *
 * The row reads *"`HookCallbackMatcher.timeout` is never set by this fork"*.
 * Measured, that is false and the truth is worse. `buildSdkHooksForConfig` — the
 * function behind `buildSdkHooks` — has always emitted it, and emitted
 * `action.timeoutMs`, a MILLISECOND number, into a field `sdk.d.ts` declares as
 * *"Timeout in seconds for all hooks in this matcher"* and the shipped binary
 * reads by MULTIPLYING (`hn.timeout ? hn.timeout*1000 : _`, with `_` defaulting
 * to `var Li=600000`). So a hook declaring the stored default of 30 000 ms asked
 * the runtime for 30 000 SECONDS — eight and a half hours — and one declaring
 * this fork's own cap of 600 000 ms asked for nearly seven days. A thousandfold
 * widening, in the one place a backstop is supposed to be a backstop, and
 * nothing ever surfaced it because a backstop that never fires looks exactly
 * like a backstop that is not needed.
 *
 * ## Why the naive repair is a regression, and what is sent instead
 *
 * Dividing by 1000 would send the hook's own budget — but that is not what the
 * callback takes. ONE dispatch runs the host's approval wait (bounded by the
 * hook's own budget, D1.333) and THEN the command (bounded by the same), in
 * series, per command action. So the value is twice each resolved budget,
 * summed, and then FLOORED at the runtime's own default, which is what makes
 * this change incapable of cutting a callback shorter than sending nothing
 * would have: strictly a tightening of an infinite bound.
 *
 * ## The host's own matchers are a decided NULL
 *
 * `claude-agent.ts` builds its own internal matchers and gives none of them a
 * timeout. That is the row's other half answered: they are in-process work whose
 * only long path is the PreToolUse gate, whose card the host already bounds at
 * `CLAUDE_PERMISSION_CARD_DEADLINE_MS` — strictly under the runtime's 600 000 ms
 * default, so that the sentence a person reads is ours. A per-matcher value
 * there could only be shorter than that deadline (re-creating F1.76) or longer
 * (dead code). The decision is written beside the matchers and pinned below.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { bracedRegion } from '../../testing/source-regions.ts';
import { MAX_HOOK_TIMEOUT_MS } from '../../automations/hook-command.ts';
import { HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS, PluginScopedAutomationSystem } from '../hooks-automation.ts';
import type { AutomationsConfig, SdkAutomationCallbackMatcher } from '../../automations/types.ts';

/**
 * The runtime's own default, read from the vendored binary rather than from a
 * page: `grep -aoF 'var Li=600000' <claude>` → 1 occurrence, inside the
 * callback dispatch `hn.timeout?hn.timeout*1000:_`, at SDK self-reports
 * `2.1.251` / `2.1.251`. Our value only means anything relative to it.
 */
const SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS = 600_000;

/**
 * The emitted value as this fork had it before F1.171: the largest declared
 * `timeoutMs`, verbatim, straight into a seconds field. Kept as a PERMANENT
 * negative control — the arms below assert the shipped value differs from it by
 * the factor the binary multiplies, so no later refactor can quietly put the
 * milliseconds back.
 */
const PRE_F1_171_TIMEOUT = (declaredMs: readonly number[]): number => Math.max(...declaredMs);

function matchersFor(actions: Record<string, unknown>[]): SdkAutomationCallbackMatcher[] {
  const config = {
    automations: { PreToolUse: [{ id: 'aaaaaa', actions }] },
  } as unknown as AutomationsConfig;
  // The PLUGIN tier, because that is the one `buildSdkHooks` always builds; the
  // other three are optional and this row is about the value, not the tier.
  const system = new PluginScopedAutomationSystem({
    workspaceRootPath: '/tmp/f1171',
    pluginHookConfig: config,
  } as never);
  const built = system.buildSdkHooks();
  const matchers = built.PreToolUse ?? [];
  // The positive control for every arm: the builder really produced a matcher,
  // so a missing `timeout` below is a decision and not an empty map.
  expect(matchers).toHaveLength(1);
  return matchers;
}

const command = (timeoutMs?: number) => ({
  type: 'command',
  command: 'echo f1171',
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

describe('F1.171 — the per-matcher timeout is SECONDS', () => {
  test('a 30 000 ms hook no longer asks the runtime for 30 000 seconds', () => {
    const [matcher] = matchersFor([command(30_000)]);
    const timeout = matcher?.timeout;

    expect(typeof timeout).toBe('number');
    // The before-state, and the claim against it in the same breath.
    expect(PRE_F1_171_TIMEOUT([30_000])).toBe(30_000);
    expect(timeout).not.toBe(30_000);
    // A seconds value the binary will multiply by 1000: an hour is already far
    // beyond anything this callback can legitimately take.
    expect(timeout!).toBeLessThanOrEqual(3_600);
  });

  test('it is FLOORED at the runtime default, so it can never cut short what sending nothing allowed', () => {
    for (const declared of [1_000, 5_000, 30_000, 120_000]) {
      const [matcher] = matchersFor([command(declared)]);
      expect(matcher?.timeout! * 1000).toBeGreaterThanOrEqual(SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS);
    }
  });

  test('a hook at this fork\'s own cap gets room for BOTH phases of one dispatch', () => {
    // The approval wait and the run are bounded by the same budget and happen
    // in series, so the ceiling is twice it — the reason a plain divide-by-1000
    // would have been a regression rather than a repair.
    const [matcher] = matchersFor([command(MAX_HOOK_TIMEOUT_MS)]);

    expect(matcher?.timeout! * 1000).toBeGreaterThanOrEqual(MAX_HOOK_TIMEOUT_MS * 2);
  });

  test('several command actions in one matcher are SUMMED, not maxed', () => {
    const [one] = matchersFor([command(120_000)]);
    const [three] = matchersFor([command(120_000), command(120_000), command(120_000)]);

    expect(three?.timeout!).toBeGreaterThan(one?.timeout!);
    // An undeclared action is counted at its RESOLVED default rather than
    // skipped, which is what keeps a mixed matcher from being under-budgeted.
    const [mixed] = matchersFor([command(600_000), command()]);
    expect(mixed?.timeout!).toBeGreaterThan(one?.timeout!);
  });

  test('a matcher whose commands declare no budget now sends the runtime default itself (F1.188)', () => {
    const [matcher] = matchersFor([command()]);

    // This arm read "still sends no timeout at all" until F1.188: F1.171 kept
    // the gate on `timeoutMs !== undefined` so that no silent matcher started
    // speaking. The gate was measured wrong on `UserPromptSubmit`, where the
    // runtime's default is 30 000 ms and a callback timeout blocks the prompt,
    // so every matcher now carries the floor — which on this event, and on
    // every event whose default is 600 000 ms, is the value sending nothing
    // meant anyway.
    expect(matcher?.timeout).toBe(SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS / 1000);
  });

  test('the field the value is written into is the one the SDK declares in seconds', () => {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');

    expect(typings).toContain('Timeout in seconds for all hooks in this matcher');
  });
});

/**
 * F1.188 (origin WJ-h P-WJ-h-3) — the ceiling counts EVERY action kind, and a
 * matcher is never left on a runtime default shorter than the host's own bound.
 *
 * ## What the row said, and what the binary adds to it
 *
 * The row: `sdkMatcherTimeoutSeconds` summed `type === 'command'` only, so a
 * `plugin-prompt`, `plugin-agent`, `plugin-mcp-tool` or `plugin-http` action
 * contributed zero. Measured, that half alone could never move a value — each
 * of the four is bounded by the HOST at 60 000 ms at most (the prompt clamp) or
 * 30 000 ms (the host runners' effect budget), ten times under `Li`. The half
 * that bites is the GATE, and it bites on one event: the vendored 2.1.251
 * declares `var Li=600000,I_e=30000` in one statement, and both of its
 * `UserPromptSubmit` executors pass `timeoutMs:I_e` (`grep -aoF
 * 'timeoutMs:I_e' <claude>` → 2), so a callback matcher sent WITHOUT a
 * `timeout` is killed there at 30 s — and on that event the binary turns a
 * callback timeout into a BLOCKING error ("hook callback timed out after
 * …ms"), which `hooks.md#userpromptsubmit` documents: *"An Agent SDK callback
 * hook on `UserPromptSubmit` that reaches its timeout blocks the prompt"*. The
 * F1.171 gate sent nothing unless a COMMAND declared a budget, so a plugin's
 * prompt judge declaring 45 s — fail-OPEN by this fork's own contract — blocked
 * the user's prompt at 30 s on claude alone.
 */
const SDK_USER_PROMPT_SUBMIT_CALLBACK_DEFAULT_MS = 30_000;

function matchersOn(event: string, actions: Record<string, unknown>[]): SdkAutomationCallbackMatcher[] {
  const config = {
    automations: { [event]: [{ id: 'bbbbbb', actions }] },
  } as unknown as AutomationsConfig;
  const system = new PluginScopedAutomationSystem({
    workspaceRootPath: '/tmp/f1188',
    pluginHookConfig: config,
  } as never);
  const matchers = (system.buildSdkHooks() as Record<string, SdkAutomationCallbackMatcher[] | undefined>)[event] ?? [];
  expect(matchers).toHaveLength(1);
  return matchers;
}

const promptAction = (timeoutMs?: number) => ({
  type: 'plugin-prompt', prompt: 'is this prompt acceptable?',
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});
const agentAction = { type: 'plugin-agent', agentName: 'reviewer' };
const mcpAction = { type: 'plugin-mcp-tool', mcpTool: 'mcp__policy__check' };
const httpAction = { type: 'plugin-http', http: { url: 'https://example.invalid/hook' } };

describe('F1.188 — every action kind is counted, and no matcher is left on a shorter default', () => {
  test('a UserPromptSubmit prompt judge declaring 45 s is no longer killed by the 30 s runtime default', () => {
    const [matcher] = matchersOn('UserPromptSubmit', [promptAction(45_000)]);

    expect(typeof matcher?.timeout).toBe('number');
    // Strictly above both the judge's own bound and the event's runtime default.
    expect(matcher!.timeout! * 1000).toBeGreaterThan(45_000);
    expect(matcher!.timeout! * 1000).toBeGreaterThan(SDK_USER_PROMPT_SUBMIT_CALLBACK_DEFAULT_MS);
  });

  test('each host-bounded kind alone on UserPromptSubmit gets a ceiling strictly above its own 30 s', () => {
    for (const action of [agentAction, mcpAction, httpAction]) {
      const [matcher] = matchersOn('UserPromptSubmit', [action]);
      expect({ type: action.type, sent: typeof matcher?.timeout }).toEqual({ type: action.type, sent: 'number' });
      expect(matcher!.timeout! * 1000).toBeGreaterThan(HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS);
    }
  });

  test('the four kinds are SUMMED with the commands, visible once the sum clears the floor', () => {
    // 2 x 600 000 (a command at this fork's cap) + 60 000 (the prompt clamp's
    // ceiling) + 3 x 30 000 (agent, mcp-tool, http) = 1 350 000 ms.
    const [all] = matchersOn('PreToolUse', [
      command(MAX_HOOK_TIMEOUT_MS), promptAction(60_000), agentAction, mcpAction, httpAction,
    ]);
    expect(all?.timeout).toBe((2 * MAX_HOOK_TIMEOUT_MS + 60_000 + 3 * HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS) / 1000);
    // The before-state counted the command alone.
    const [commandOnly] = matchersOn('PreToolUse', [command(MAX_HOOK_TIMEOUT_MS)]);
    expect(commandOnly?.timeout).toBe((2 * MAX_HOOK_TIMEOUT_MS) / 1000);
  });

  test('a prompt budget above the clamp is counted at the clamp, not at what it spells', () => {
    const [clamped] = matchersOn('PreToolUse', [command(MAX_HOOK_TIMEOUT_MS), promptAction(900_000)]);
    expect(clamped?.timeout).toBe((2 * MAX_HOOK_TIMEOUT_MS + 60_000) / 1000);
  });

  test('control: a command-only matcher under the floor is unchanged at the runtime default', () => {
    const [matcher] = matchersOn('PreToolUse', [command(120_000)]);
    expect(matcher?.timeout).toBe(SDK_DEFAULT_HOOK_CALLBACK_BUDGET_MS / 1000);
  });

  test('the host constant this sum reads is the one the host runners really apply', () => {
    const host = readFileSync(
      new URL('../../../../server-core/src/sessions/SessionManager.ts', import.meta.url),
      'utf8',
    );
    // The positive control that the file really is the host: the three runners.
    expect(host).toContain('private pluginHttpHookRunner(');
    expect(host).toContain(`const PLUGIN_HOOK_EFFECT_TIMEOUT_MS = ${HOST_PLUGIN_HOOK_EFFECT_BUDGET_MS.toLocaleString('en-US').replace(/,/g, '_')}`);
  });
});

describe('F1.171 — the host\'s own matchers are a decided null', () => {
  test('the decision is written beside them, not merely absent', () => {
    const source = readFileSync(
      new URL('../../agent/claude-agent.ts', import.meta.url),
      'utf8',
    );
    const anchor = source.indexOf('const internalHooks: Record<string, SdkAutomationCallbackMatcher[]> = {');
    expect(anchor).toBeGreaterThan(0);
    const region = bracedRegion(source, anchor);

    // No matcher in the host's own map carries the field …
    expect(region).not.toContain('timeout:');
    // Boundary control, declared BELOW this region: `private wrapUserText(` is a
    // later method of the same class and must sit outside these braces.
    expect(region).not.toContain('private wrapUserText(');
    // … and the REASON is written where the next reader meets it, which is what
    // separates a decided null from an omission.
    expect(source).toContain('F1.171 — NONE of the matchers above carries a `timeout`');
  });
});
