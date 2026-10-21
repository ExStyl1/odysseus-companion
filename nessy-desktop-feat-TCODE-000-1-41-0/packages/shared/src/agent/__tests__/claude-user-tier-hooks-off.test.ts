/**
 * P2.496, claude CONSUMER half — the user tier's `disableAllHooks` reaches our
 * own two registrations, and reaches nothing else.
 *
 * W2-z landed the READER
 * (`AgentAutomationSystem.userTierDisableAllHooks`, driven against the real
 * builder in `capabilities/__tests__/user-disabled-hooks-reader.test.ts`); this
 * file is the other end — the gate `claude-agent.ts` applies to it.
 *
 * The vendor's position first, because it is what makes this a DECISION rather
 * than a defect fix. `settings-reference.md#disableallhooks`, verbatim: *"In any
 * other settings file: Claude Code disables user, project, local, and plugin
 * hooks; managed hooks, Agent SDK hooks, and hooks from plugins force-enabled in
 * managed `enabledPlugins` keep running."* Everything `claude-agent.ts`
 * registers is an Agent SDK hook, so those registrations surviving the user's
 * switch is stated behaviour. The owner decided our own host-authored additions
 * should stand down anyway — a narrowing, never a widening.
 *
 * ## The boundary this file can drive, and the one it cannot
 *
 * DRIVEN here: the predicate's three input states, and the negative control that
 * matters — the `PreToolUse` pipeline answers a flag-carrying system EXACTLY as
 * it answers `undefined`, including when a hook denies. `disableAllHooks`
 * governs hooks, a status line and a file-suggestion command, never a permission
 * decision, so a switch that changed that pipeline's answer would be a
 * permission widening wearing a convenience switch's clothes.
 *
 * NOT DRIVEN, and said rather than papered over: the `PermissionDenied` matcher
 * is built inside the `hooks:` IIFE of the `query()` options and there is no
 * seam that hands that object to a test. Its independence from the switch rests
 * on `claudeSubagentDebugHooksWithheld` having exactly one call site — the
 * conditional spread around `SubagentStart`/`SubagentStop`. A source-text guard
 * over that was considered and refused: P3.16 measured one in this repo catching
 * 1 of 8 evasions before it was deleted, and a guard that cries wolf on a rename
 * is worse than the prose it replaces.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentAutomationSystem, SdkAutomationInput } from '../../automations/index.ts';
import { claudeSubagentDebugHooksWithheld, runClaudePreToolUseHookPipeline } from '../claude-agent.ts';

/**
 * A system that answers `executeAgentEvent` and carries whatever tier flag the
 * case is about. Deliberately a stub and not the builder: the builder is already
 * driven by the reader's own file, and what is under test here is the CONSUMER's
 * reading of the three states, which a stub states more sharply than a fixture.
 */
function systemWith(
  flag: boolean | undefined,
  decision?: { decision: string; reason?: string },
): AgentAutomationSystem {
  return {
    ...(flag === undefined ? {} : { userTierDisableAllHooks: flag }),
    async executeAgentEvent() {
      return { matchedCount: decision ? 1 : 0, ...(decision ? { decision } : {}) };
    },
  } as unknown as AgentAutomationSystem;
}

describe('the user tier switch withholds our subagent debug matchers', () => {
  it('withholds them only on an explicit true', () => {
    expect(claudeSubagentDebugHooksWithheld(systemWith(true))).toBe(true);
  });

  it('reads ABSENT as unknown, never as false — a host that cannot answer keeps its hooks', () => {
    // The field's own contract. A truthiness test would pass the case above and
    // this one identically; what separates them is that a system with no opinion
    // must NOT be silenced.
    expect(claudeSubagentDebugHooksWithheld(systemWith(undefined))).toBe(false);
    expect(claudeSubagentDebugHooksWithheld(undefined)).toBe(false);
  });

  it('reads an explicit false as not engaged', () => {
    expect(claudeSubagentDebugHooksWithheld(systemWith(false))).toBe(false);
  });

  it('leaves the PreToolUse pipeline byte-identical, allow arm', async () => {
    const hookInput = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' },
    } as SdkAutomationInput;
    const revalidate = (input: Record<string, unknown>) => ({ seen: input });
    const withFlag = await runClaudePreToolUseHookPipeline({
      automationSystem: systemWith(true), hookInput, revalidate,
    });
    const without = await runClaudePreToolUseHookPipeline({
      automationSystem: systemWith(undefined), hookInput, revalidate,
    });
    expect(withFlag).toEqual(without);
    expect(withFlag.kind).toBe('validated');
  });

  it('leaves the PreToolUse pipeline byte-identical, DENY arm — the switch cannot open a gate', async () => {
    // The arm that would matter if this were ever wired wrong: a user who turned
    // hooks off must not thereby have a denying hook silenced.
    const hookInput = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' },
    } as SdkAutomationInput;
    const revalidate = () => ({ ran: true });
    const denial = { decision: 'deny', reason: 'refused by policy' };
    const withFlag = await runClaudePreToolUseHookPipeline({
      automationSystem: systemWith(true, denial), hookInput, revalidate,
    });
    expect(withFlag).toEqual({ kind: 'blocked', reason: 'refused by policy' });
    expect(withFlag).toEqual(await runClaudePreToolUseHookPipeline({
      automationSystem: systemWith(undefined, denial), hookInput, revalidate,
    }));
  });
});
