/**
 * C3.82 (D1.17, born P6.121) — ONE skill declaring BOTH a `PostToolUse` and a
 * `PreToolUse` frontmatter hook, on a codex session, and which of the two the
 * dispatcher actually fires.
 *
 * ## Why the question was open
 *
 * The component-hook layer is provider-NEUTRAL at HEAD — `BaseAgent`'s
 * {@link BaseAgent.getComponentHookLayer} has no provider gate (the
 * `provider !== 'anthropic'` one went with `f32ff0672`) — so a codex session's
 * skill frontmatter hooks reach the dispatcher exactly like Pi's and claude's.
 * What was never watched is the OTHER half: whether anything on the codex path
 * EMITS the event a given tier is registered on. The two halves compose to a
 * user-visible outcome — a skill author writes two hooks and one of them is
 * dead — and no test asked the composed question on codex.
 *
 * ## The reading, 2026-09-11
 *
 * `PostToolUse` fires; `PreToolUse` does not. That is the expectation P6.121
 * wrote down, and it HOLDS. The cause is measured here rather than asserted:
 * the same skill's `PreToolUse` tier fires on the same session the instant
 * something dispatches the event (`CONTROL A`), so the tier is live and
 * correctly registered — what is absent on codex is the EMITTER.
 *
 * ## The controls, and what each one kills
 *
 *  - **CONTROL A — the PreToolUse tier is live.** Dispatching `PreToolUse`
 *    directly through the same automation system runs the same skill's hook.
 *    Without it, "PreToolUse did not fire" would be indistinguishable from a
 *    rig that registered nothing, and the row would have recorded a dead rig as
 *    a finding.
 *  - **CONTROL B — the emitter asymmetry, at the source.** `pi-agent.ts` emits
 *    `PreToolUse` and `codex-agent.ts` does not, which is what
 *    `runtime-hook-events.ts` publishes as `emitted` / `unwired`. Read from the
 *    files rather than restated, so a future codex emitter reddens this instead
 *    of leaving the published table lying.
 *
 * ## Why the execution authority is an injected runner and not a subprocess
 *
 * `component-hooks.test.ts` established the split and the reason: the outcome
 * under test here is WHICH action reaches the execution authority, and the
 * runner IS that authority — `PluginScopedAutomationSystem` hands it the
 * action it decided to run. One real `node -e` spawn adds a process per case
 * and proves nothing this file claims. The end-to-end wiring of the same layer
 * through real spawns is already pinned in `component-hooks.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAgent } from '../codex-agent.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { BackendConfig } from '../backend/types.ts';
import { parseHooksConfigContent } from '../../automations/hooks-config.ts';
import type { AutomationsConfig } from '../../automations/types.ts';
import { PluginScopedAutomationSystem } from '../../plugins/hooks-automation.ts';
import { hookEventEmission } from '../../automations/runtime-hook-events.ts';
import type { SkillInvocationRecord } from '../../capabilities/runtime-skill-content.ts';

/** The two tiers ONE skill's frontmatter declares, in the shape the parser normalizes to. */
function frontmatterHooks(): AutomationsConfig {
  return parseHooksConfigContent(JSON.stringify({
    automations: {
      PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: './pre-tool-use.sh' }] }],
      PostToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: './post-tool-use.sh' }] }],
    },
  })).config;
}

interface Rig {
  agent: CodexAgent;
  system: PluginScopedAutomationSystem;
  /** Every hook command the execution authority was actually handed, in order. */
  ran: string[];
}

/**
 * A codex session with one active skill invocation carrying both tiers.
 *
 * The automation system is built the way `SessionManager` builds it — the
 * component layer resolved LIVE from the agent — and carries no native, user,
 * project or plugin config at all, so any action the runner sees can only have
 * come from the skill.
 */
function codexRigWithSkill(): Rig {
  const agent = new CodexAgent({
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
  const invocation = { key: 'skill:guard', componentHooks: { always: frontmatterHooks() } } as SkillInvocationRecord;
  (agent as unknown as { activeSkillInvocations: Map<string, SkillInvocationRecord> })
    .activeSkillInvocations = new Map([[invocation.key, invocation]]);

  const ran: string[] = [];
  const system = new PluginScopedAutomationSystem({
    pluginHookConfig: { automations: {} },
    workspaceRootPath: process.cwd(),
    componentHookLayer: () => agent.getComponentHookLayer(),
    pluginCommandRunner: async (action) => {
      ran.push(action.command);
      return { type: 'command' as const, command: action.command, success: true, exitCode: 0, signal: null, durationMs: 1 };
    },
  });
  agent.setAutomationSystem(system);
  return { agent, system, ran };
}

/** The production emitter, driven with the pair of adapter events one codex tool call produces. */
async function driveOneCodexToolCall(rig: Rig): Promise<void> {
  const note = (agent: CodexAgent, event: unknown): void => {
    (agent as unknown as { noteCodexToolCallForHooks(e: unknown): void }).noteCodexToolCallForHooks(event);
  };
  note(rig.agent, { type: 'tool_start', toolUseId: 'call-1', toolName: 'Bash', input: { command: 'ls' } });
  note(rig.agent, { type: 'tool_result', toolUseId: 'call-1', toolName: 'Bash', result: 'ok', isError: false });
  await rig.agent.drainAutomationEvents();
}

describe('C3.82 — a skill declaring both tool-use hooks, on codex', () => {
  it('fires the PostToolUse tier and not the PreToolUse tier for one codex tool call', async () => {
    const rig = codexRigWithSkill();
    await driveOneCodexToolCall(rig);

    // The reading. `PostToolUse` is minted host-side by
    // `CodexAgent.noteCodexToolCallForHooks` from the item stream (P3.335);
    // nothing on this path mints `PreToolUse`, so the skill's other tier is
    // registered, matched by nobody, and silent.
    expect(rig.ran).toEqual(['./post-tool-use.sh']);
  });

  it('CONTROL A: the same skill\'s PreToolUse tier IS live — dispatch it and it runs', async () => {
    // Kills the dead-rig reading of the case above: the tier is registered on
    // this very session and fires the moment anything emits the event. So what
    // is missing on codex is the emitter, not the registration.
    const rig = codexRigWithSkill();
    const result = await rig.system.executeAgentEvent('PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });

    expect(result.matchedCount).toBe(1);
    expect(rig.ran).toEqual(['./pre-tool-use.sh']);
  });

  it('CONTROL B: the emitter asymmetry is in the sources, and the published table says the same', () => {
    const agentDir = join(import.meta.dir, '..');
    const codexSource = readFileSync(join(agentDir, 'codex-agent.ts'), 'utf8');
    const piSource = readFileSync(join(agentDir, 'pi-agent.ts'), 'utf8');

    // Pi emits it; codex does not. Read rather than restated — the day a codex
    // emitter lands, this fails and the published verdict below must move with it.
    expect(piSource).toContain("emitAutomationEvent('PreToolUse'");
    expect(codexSource.includes("emitAutomationEvent('PreToolUse'")).toBe(false);
    // Both halves of the pair, so a rename of the emitter cannot satisfy this by
    // making BOTH sides absent.
    expect(codexSource).toContain("emitAutomationEvent(eventName,");

    expect(hookEventEmission('codex-runtime', 'PreToolUse').kind).toBe('unwired');
    expect(hookEventEmission('codex-runtime', 'PostToolUse').kind).toBe('emitted');
    expect(hookEventEmission('pi', 'PreToolUse').kind).toBe('emitted');
  });

  it('splits a FAILING codex tool call onto PostToolUseFailure, so the skill\'s PostToolUse stays quiet', async () => {
    // The boundary arm: `noteCodexToolCallForHooks` reads `isError` and emits
    // the other event, which this skill does not declare. Without it, "the
    // PostToolUse tier fired" could be satisfied by an emitter that ignores the
    // error split and fires PostToolUse for everything.
    const rig = codexRigWithSkill();
    const note = (event: unknown): void => {
      (rig.agent as unknown as { noteCodexToolCallForHooks(e: unknown): void }).noteCodexToolCallForHooks(event);
    };
    note({ type: 'tool_start', toolUseId: 'call-2', toolName: 'Bash', input: { command: 'ls' } });
    note({ type: 'tool_result', toolUseId: 'call-2', toolName: 'Bash', result: 'boom', isError: true });
    await rig.agent.drainAutomationEvents();

    expect(rig.ran).toEqual([]);
  });
});
