/**
 * C3.197 (QM2 = A, owner 2026-09-11) — every host hook run says which PROMPT it
 * belongs to.
 *
 * NOT an invented field. `hooks.md` § Common input fields documents it by name:
 * *"`prompt_id` | UUID identifying the user prompt currently being processed.
 * Matches the `prompt.id` attribute on OpenTelemetry events, so you can
 * correlate hook output with telemetry for a single prompt. Absent until the
 * first user input."* This fork filled every other common field and not this
 * one, which is the same shape P6.300 closed for `transcript_path` — and it is
 * filled in the same place, `BaseAgent`'s one hook funnel, so the three runtimes
 * cannot answer differently.
 *
 * The RESIDUE is stated at the site and repeated here so a reader of either
 * finds it: the page's second clause — the same value on the exporters'
 * `prompt.id` — is not wired yet, and the correlation it promises is only real
 * once it is.
 */
import { describe, it, expect } from 'bun:test';
import type { AgentAutomationSystem, SdkAutomationInput } from '../../automations/types.ts';
import { TestAgent, createMockBackendConfig, createMockCapabilityTurnRuntime } from './test-utils.ts';

function capture(): { system: AgentAutomationSystem; seen: SdkAutomationInput[] } {
  const seen: SdkAutomationInput[] = [];
  return {
    seen,
    system: {
      async executeAgentEvent(_event, input) {
        seen.push(input);
        return { matchedCount: 1 };
      },
    } as AgentAutomationSystem,
  };
}

function makeAgent(): TestAgent {
  const agent = new TestAgent(createMockBackendConfig());
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  return agent;
}

/** One whole turn through the shared template method, events discarded. */
async function turn(agent: TestAgent, message: string): Promise<void> {
  for await (const _event of agent.chat(message)) { /* drained */ }
}

describe('C3.197 · prompt_id on hook input', () => {
  it('is ABSENT before the first user input, as the page says', async () => {
    const agent = makeAgent();
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    // The `SessionStart` case exactly: a hook that fires on a cold session must
    // carry no field rather than an id for a prompt that does not exist.
    await agent.runAutomationForTest('SessionStart');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt_id).toBeUndefined();
  });

  it('is one id for one turn — every hook of that turn carries the SAME value', async () => {
    const agent = makeAgent();
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await turn(agent, 'first');
    await agent.runAutomationForTest('PreToolUse');
    await agent.runAutomationForTest('PostToolUse');
    await agent.runAutomationForTest('Stop');

    expect(seen).toHaveLength(3);
    const ids = new Set(seen.map(input => input.prompt_id));
    expect(ids.size).toBe(1);
    const [only] = [...ids];
    // Opaque, and a v4 UUID as the page's own sibling attribute specifies. The
    // shape is asserted rather than the value: what matters is that it names
    // nobody and is not derived from the prompt.
    expect(only).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(only).not.toContain('first');
  });

  it('mints a NEW id for the next turn — the control that it is per prompt, not per session', async () => {
    const agent = makeAgent();
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await turn(agent, 'first');
    await agent.runAutomationForTest('Stop');
    await turn(agent, 'second');
    await agent.runAutomationForTest('Stop');

    expect(seen).toHaveLength(2);
    expect(seen[0]!.prompt_id).toBeDefined();
    expect(seen[1]!.prompt_id).toBeDefined();
    expect(seen[0]!.prompt_id).not.toBe(seen[1]!.prompt_id);
  });

  it('never overwrites an id the calling site set deliberately', async () => {
    const agent = makeAgent();
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await turn(agent, 'first');
    await agent.emitAutomationEventForTest('PreToolUse', {
      hook_event_name: 'PreToolUse',
      prompt_id: 'set-by-the-caller',
    });

    expect(seen[0]!.prompt_id).toBe('set-by-the-caller');
  });

  it('exposes the same value the exporters must carry on `prompt.id`', async () => {
    const agent = makeAgent();
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    expect(agent.promptId).toBeUndefined();
    await turn(agent, 'first');
    await agent.runAutomationForTest('Stop');

    expect(agent.promptId).toBe(seen[0]!.prompt_id!);
  });
});
