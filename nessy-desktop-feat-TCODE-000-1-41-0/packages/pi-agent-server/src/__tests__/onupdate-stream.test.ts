import { describe, expect, it } from 'bun:test';
import { runAgentLoop, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat';

const pingParameters = Type.Object({});

type PingDetails = {
  progress: {
    kind: 'orchestrator_ping';
    step: number;
    total: number;
  };
};

function createOrchestratorPingTool(): AgentTool<typeof pingParameters, PingDetails> & { promptSnippet: string } {
  return {
    name: 'orchestrator_ping',
    label: 'Orchestrator Ping',
    description: 'Test-only tool that proves custom tool progress reaches JSONL events.',
    promptSnippet: 'Emit three progress updates for orchestration stream verification.',
    parameters: pingParameters,
    async execute(_toolCallId, _params, _signal, onUpdate) {
      for (let step = 1; step <= 3; step += 1) {
        onUpdate?.({
          content: [{ type: 'text', text: `orchestrator ping ${step}/3` }],
          details: { progress: { kind: 'orchestrator_ping', step, total: 3 } },
        });
      }

      return {
        content: [{ type: 'text', text: 'orchestrator ping complete' }],
        details: { progress: { kind: 'orchestrator_ping', step: 3, total: 3 } },
        terminate: true,
      };
    },
  };
}

function frameAsPiServerJsonl(event: AgentEvent): string {
  return JSON.stringify({ type: 'event', event });
}

describe('custom tool onUpdate stream', () => {
  it('forwards custom tool progress as tool_execution_update JSONL events', async () => {
    const faux = registerFauxProvider({
      models: [{ id: 'onupdate-stream-test-model' }],
    });

    try {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall('orchestrator_ping', {}, { id: 'orchestrator-ping-call' }),
          { stopReason: 'toolUse' },
        ),
      ]);

      const events: AgentEvent[] = [];

      await runAgentLoop(
        [
          // 0.87 dropped `AgentContext.systemPrompt`: the prompt is the transcript's
          // leading `system` message (SystemMessage, pi-ai types.d.ts).
          { role: 'system', content: 'Use orchestrator_ping once.', timestamp: Date.now() },
          { role: 'user', content: 'run orchestrator_ping', timestamp: Date.now() },
        ],
        {
          messages: [],
          tools: [createOrchestratorPingTool()],
        },
        {
          model: faux.getModel('onupdate-stream-test-model') ?? faux.getModel(),
          // `AgentMessage` is wider than `Message`: it also carries `custom`,
          // `bashExecution`, `branchSummary` and `compactionSummary`, none of
          // which is an LLM message. Filtering them is this callback's own
          // documented contract — "AgentMessages that cannot be converted ...
          // should be filtered out" (pi-agent-core types.d.ts, `convertToLlm`).
          // Kept as a POSITIVE filter on the LLM roles so a new non-LLM role
          // added upstream is excluded by default rather than silently
          // forwarded. 0.87 added `system` to the LLM roles: the transcript's
          // leading system message IS the prompt. This test feeds one system
          // and one user message, so the filter passes both through.
          convertToLlm: messages => messages.filter(
            message => message.role === 'system' || message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult',
          ),
        },
        event => {
          events.push(event);
        },
        undefined,
        // `runAgentLoop`'s 5th and 6th parameters (`signal`, `streamFn`) are
        // REQUIRED, and this call passed four. That was not a typing nicety: the
        // test has been failing at runtime with "No default stream function
        // configured" — nothing in this repo calls `setDefaultStreamFn` — and
        // the typecheck exclusion hid the error naming the cause.
        // `streamSimple` is the registry-backed dispatcher that
        // `registerFauxProvider` above registers into, so it is what delivers
        // the faux responses; its signature is `StreamFn` exactly.
        streamSimple,
      );

      const updateLines = events
        .filter(event => event.type === 'tool_execution_update')
        .map(frameAsPiServerJsonl);
      const parsedUpdates = updateLines.map(line => JSON.parse(line) as {
        type: 'event';
        event: Extract<AgentEvent, { type: 'tool_execution_update' }>;
      });

      expect(parsedUpdates).toHaveLength(3);
      expect(parsedUpdates.map(update => update.event.partialResult.details)).toEqual([
        { progress: { kind: 'orchestrator_ping', step: 1, total: 3 } },
        { progress: { kind: 'orchestrator_ping', step: 2, total: 3 } },
        { progress: { kind: 'orchestrator_ping', step: 3, total: 3 } },
      ]);
      expect(parsedUpdates.every(update => update.type === 'event')).toBe(true);
      expect(parsedUpdates.every(update => update.event.toolName === 'orchestrator_ping')).toBe(true);

      console.log(['onUpdate JSONL proof:', ...updateLines].join('\n'));
    } finally {
      faux.unregister();
    }
  });
});
