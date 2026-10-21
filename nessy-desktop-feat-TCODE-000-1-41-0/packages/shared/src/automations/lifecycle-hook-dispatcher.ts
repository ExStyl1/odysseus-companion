// F1.10 (D1.366) — typed by the agent-event interface: the workspace facade has no agent-event method.
import type { AgentAutomationSystem, AgentEvent, AgentEventExecutionResult, SdkAutomationInput } from './types.ts';

export type AutomationAgentEventTarget = Pick<AgentAutomationSystem, 'executeAgentEvent'>;

export interface DispatchAutomationAgentEventOptions {
  automationSystem?: AutomationAgentEventTarget;
  event: AgentEvent;
  input: SdkAutomationInput;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

export async function dispatchAutomationAgentEvent({
  automationSystem,
  event,
  input,
  signal,
  onError,
}: DispatchAutomationAgentEventOptions): Promise<AgentEventExecutionResult | undefined> {
  if (!automationSystem) return undefined;

  try {
    return await automationSystem.executeAgentEvent(event, input, signal);
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}
