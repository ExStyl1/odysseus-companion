/**
 * P6.300 — every hook event carries the session's own transcript path, on every
 * runtime.
 *
 * `hooks.md`'s common-input table lists `transcript_path` beside `session_id`
 * and `cwd` — *"Path to conversation JSON. The transcript file is written
 * asynchronously and may lag the in-memory conversation, so it may not yet
 * include the current turn's most recent messages when a hook fires"* — and
 * every event example in the page carries it, `SessionStart` and `SessionEnd`
 * included. No hook of ours received it: the only populated field in the tree
 * was `agent_transcript_path` on `SubagentStop`, which is a DIFFERENT file (the
 * subagent's own), so a hook that wanted to read the conversation had no path to
 * open.
 *
 * Filled in `BaseAgent.emitAutomationEvent`, the single funnel every backend's
 * automation events pass through — native-first condition (2), the host
 * supplying it once so the three runtimes cannot answer differently.
 */
import { describe, it, expect } from 'bun:test';
import { getSessionFilePath } from '../../sessions/storage.ts';
import type { AgentAutomationSystem, SdkAutomationInput } from '../../automations/types.ts';
import { TestAgent, createMockBackendConfig, createMockSession } from './test-utils.ts';

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

describe('P6.300 transcript_path on hook input', () => {
  it('is this session\'s own transcript, on a lifecycle event', async () => {
    const agent = new TestAgent(createMockBackendConfig());
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await agent.runAutomationForTest('SessionEnd');

    expect(seen).toHaveLength(1);
    // The exact path the host writes the session to, not a guess about a
    // storage layout: the same function `agent_transcript_path` uses for a
    // CHILD session.
    expect(seen[0]!.transcript_path).toBe(getSessionFilePath('test-workspace-id', 'test-session-id'));
  });

  it('reaches every event, not only the lifecycle ones', async () => {
    const agent = new TestAgent(createMockBackendConfig());
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await agent.runAutomationForTest('SessionStart');
    await agent.runAutomationForTest('Stop');
    await agent.runAutomationForTest('Notification');

    expect(seen).toHaveLength(3);
    for (const input of seen) {
      expect(input.transcript_path).toBe(getSessionFilePath('test-workspace-id', 'test-session-id'));
    }
  });

  it('carries no field at all for an agent with no session, rather than a path that opens nothing', async () => {
    const config = createMockBackendConfig();
    delete (config as { session?: unknown }).session;
    const agent = new TestAgent(config);
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await agent.runAutomationForTest('SessionEnd');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.transcript_path).toBeUndefined();
  });

  it('never overwrites a path the calling site set deliberately', async () => {
    const agent = new TestAgent(createMockBackendConfig({ session: createMockSession() }));
    const { system, seen } = capture();
    agent.setAutomationSystem(system);

    await agent.emitAutomationEventForTest('SubagentStop', {
      hook_event_name: 'SubagentStop',
      transcript_path: '/deliberate/path.jsonl',
      agent_transcript_path: '/the/child/transcript.jsonl',
    });

    // Both fields survive and they are different files: this session's
    // conversation, and the subagent's own.
    expect(seen[0]!.transcript_path).toBe('/deliberate/path.jsonl');
    expect(seen[0]!.agent_transcript_path).toBe('/the/child/transcript.jsonl');
  });
});
