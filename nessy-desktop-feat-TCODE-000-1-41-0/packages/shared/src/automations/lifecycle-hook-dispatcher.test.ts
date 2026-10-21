import { describe, expect, it, jest } from 'bun:test';
import { dispatchAutomationAgentEvent } from './lifecycle-hook-dispatcher.ts';

describe('lifecycle hook dispatcher', () => {
  it('dispatches agent events through AutomationSystem', async () => {
    const signal = new AbortController().signal;
    const automationSystem = {
      executeAgentEvent: jest.fn(async () => ({ matchedCount: 1 })),
    };

    const result = await dispatchAutomationAgentEvent({
      automationSystem,
      event: 'SubagentStart',
      input: {
        hook_event_name: 'SubagentStart',
        agent_id: 'subagent-1',
        agent_type: 'scout',
      },
      signal,
    });

    expect(automationSystem.executeAgentEvent).toHaveBeenCalledTimes(1);
    expect(automationSystem.executeAgentEvent).toHaveBeenCalledWith(
      'SubagentStart',
      {
        hook_event_name: 'SubagentStart',
        agent_id: 'subagent-1',
        agent_type: 'scout',
      },
      signal,
    );
    expect(result).toEqual({ matchedCount: 1 });
  });

  it('returns hook decisions from AutomationSystem', async () => {
    const decision = { decision: 'block' as const, reason: 'blocked by hook' };
    const automationSystem = {
      executeAgentEvent: jest.fn(async () => ({ matchedCount: 1, decision })),
    };

    const result = await dispatchAutomationAgentEvent({
      automationSystem,
      event: 'PreToolUse',
      input: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      },
    });

    expect(result).toEqual({ matchedCount: 1, decision });
  });

  it('keeps automation failures out of agent flow', async () => {
    const onError = jest.fn();
    const automationSystem = {
      executeAgentEvent: jest.fn(async () => {
        throw new Error('webhook failed');
      }),
    };

    await dispatchAutomationAgentEvent({
      automationSystem,
      event: 'SessionEnd',
      input: { hook_event_name: 'SessionEnd' },
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
  });
});
