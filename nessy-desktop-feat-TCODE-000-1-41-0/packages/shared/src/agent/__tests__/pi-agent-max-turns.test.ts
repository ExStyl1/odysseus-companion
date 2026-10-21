import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { SUPPORTED_PI_EVENT_VERSION } from '../backend/pi/event-adapter.ts';
import { AbortReason, type BackendConfig, type CapabilityTurnRuntime } from '../backend/types.ts';
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/nessy-general-agent-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/nessy-general-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  };
}

function toolStart(toolUseId: string) {
  return {
    type: 'tool_start' as const,
    toolName: 'Bash',
    toolUseId,
    input: { command: 'echo hi' },
  };
}

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function setupAgent(maxTurns: number): { agent: PiAgent; abortReasons: AbortReason[] } {
  const agent = new PiAgent(createConfig());
  const abortReasons: AbortReason[] = [];
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-max-turns',
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
    provenance: [],
    mcpSources: [],
    orchestrator: {
      concurrency: 4,
      depth: 2,
      maxParallelTasks: 8,
      maxAgents: 100,
      tierModelMap: null,
      tokenBudget: null,
    },
    staticTools: [],
  };
  const capabilityRuntime = {
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [],
      skills: [],
      mcpServers: [],
      hooks: [],
      automations: [],
      agents: [],
      promptLayers: [],
      memory: [],
      permissionLayers: [],
      commands: [],
      promptCommands: [],
      apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-general-agent-test'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by max-turns contract'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime;

  agent.setCapabilityTurnRuntime(capabilityRuntime);
  const execution = (agent as any).buildExecutionManifestForCurrentTurn();
  (agent as any).activeExecutionManifest = execution.manifest;
  (agent as any).adapter.setExecutionManifest(execution.manifest);

  (agent as any).ensureSubprocess = async () => {};
  (agent as any).send = () => {};
  (agent as any).emitAutomationEvent = async () => {};
  (agent as any).eventQueue.reset = () => {};
  (agent as any).getMaxAgentTurns = () => maxTurns;
  (agent as any).forceAbort = (reason: AbortReason) => {
    abortReasons.push(reason);
    (agent as any)._isProcessing = false;
  };

  return { agent, abortReasons };
}

describe('PiAgent maxAgentTurns cap', () => {
  it('arms the raw-event terminal latch for explicit and forced aborts', async () => {
    for (const mode of ['abort', 'forceAbort'] as const) {
      const agent = new PiAgent(createConfig());
      const runtime = agent as any;
      const adaptedTypes: string[] = [];
      runtime.send = () => {};
      runtime.eventQueue.complete = () => {};
      runtime.adapter.adaptEvent = function* (event: Record<string, unknown>) {
        adaptedTypes.push(String(event.type));
      };

      if (mode === 'abort') {
        await agent.abort();
      } else {
        agent.forceAbort(AbortReason.MaxBudgetUsd);
      }

      expect(runtime.rawEventAttemptTerminal, mode).toBeTrue();
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      expect(adaptedTypes, mode).toEqual([]);
      agent.destroy();
    }
  });

  it('drops all raw events after a max-turn terminal boundary', () => {
    const { agent, abortReasons } = setupAgent(1);
    const runtime = agent as any;
    const adaptedTypes: string[] = [];
    const enqueued: any[] = [];
    const hookEvents: string[] = [];
    let completions = 0;

    runtime.adapter = {
      adaptEvent(event: Record<string, unknown>) {
        adaptedTypes.push(String(event.type));
        return event.type === 'tool_execution_end'
          ? [{ type: 'tool_result', toolName: 'Bash', result: 'late', isError: false }]
          : [];
      },
      shouldCompleteQueue(isAgentEnd: boolean) { return isAgentEnd; },
      // F1.586 — `handleSubprocessEvent` asks this once per `turn_start` since F1.300; no retry here.
      consumeRetriedRunTurnStart() { return false; },
      setExecutionManifest() {},
      resetOverflowState() {},
    };
    runtime.eventQueue.enqueue = (event: any) => enqueued.push(event);
    runtime.eventQueue.complete = () => { completions += 1; };
    runtime.emitAutomationEvent = async (event: string) => { hookEvents.push(event); };
    runtime.maxPiModelTurnsThisChat = 1;
    runtime.piModelTurnsThisChat = 0;

    runtime.handleSubprocessEvent({ type: 'turn_start' });
    const adaptedBeforeAbort = [...adaptedTypes];
    expect(enqueued).toEqual([]);
    runtime.handleSubprocessEvent({ type: 'turn_start' });
    expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
    // P6.443 — the cap's own verdict, and the ONLY thing the boundary enqueues.
    // Enqueued by the boundary itself rather than by a later raw event, which is
    // what makes it survive `forceAbort` closing the queue.
    expect(enqueued).toEqual([{ type: 'complete', terminalReason: 'max_agent_turns' }]);
    const enqueuedAtBoundary = [...enqueued];

    runtime.handleSubprocessEvent({ type: 'message_update' });
    runtime.handleSubprocessEvent({ type: 'tool_execution_end', toolCallId: 'late-tool' });
    runtime.handleSubprocessEvent({ type: 'agent_end' });

    expect(adaptedTypes).toEqual(adaptedBeforeAbort);
    // The latch's original property, unchanged: NOTHING after the boundary is
    // enqueued — the verdict above is the boundary's, not a late event's.
    expect(enqueued).toEqual(enqueuedAtBoundary);
    expect(hookEvents).toEqual([]);
    expect(completions).toBe(0);
    expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
    agent.destroy();
  });

  // P6.443's negative half: the cap is the ONLY reason that stamps here. A turn
  // under the cap must not acquire a verdict it did not earn, which is what a
  // stamp moved one line up (out of the `>` guard) would produce.
  it('leaves a turn that never hit the cap unstamped', () => {
    const { agent, abortReasons } = setupAgent(3);
    const runtime = agent as any;
    const enqueued: any[] = [];

    runtime.adapter = {
      adaptEvent() { return []; },
      shouldCompleteQueue() { return false; },
      consumeRetriedRunTurnStart() { return false; }, // F1.586, as in the stand-in above
      setExecutionManifest() {}, resetOverflowState() {},
    };
    runtime.eventQueue.enqueue = (event: any) => enqueued.push(event);
    runtime.eventQueue.complete = () => {};
    runtime.emitAutomationEvent = async () => {};
    runtime.maxPiModelTurnsThisChat = 3;
    runtime.piModelTurnsThisChat = 0;

    runtime.handleSubprocessEvent({ type: 'turn_start' });
    runtime.handleSubprocessEvent({ type: 'turn_start' });

    expect(abortReasons).toEqual([]);
    expect(enqueued).toEqual([]);
    agent.destroy();
  });

  // T30 — the ONE class of event that is not the turn's, and therefore the one
  // the latch must not swallow. A detached `subagent`/`workflow` run is started
  // to outlive the turn that spawned it, so its `task_completed` arrives after
  // the latch by design; three real reproductions on 2026-08-21 showed the child
  // reaching `completed` while the host was never told.
  it('lets a DETACHED run report after the terminal latch, and nothing else', () => {
    const { agent } = setupAgent(0);
    const runtime = agent as any;
    const detached: any[] = [];
    const enqueued: any[] = [];
    runtime.config.onBetweenTurnsEvent = (event: any) => detached.push(event);
    runtime.eventQueue.enqueue = (event: any) => enqueued.push(event);
    runtime.eventQueue.complete = () => {};
    runtime.rawEventAttemptTerminal = true;

    runtime.handleSubprocessEvent({
      type: 'task_completed',
      taskId: 'task-subagent-mt38u5ec-x9zwy0',
      status: 'completed',
      summary: '1. scan-inventory - done\nC7E2A-D8D7B-12FCE-344DB',
    });
    // R10's detached MCP result rides the same seam for the same reason.
    runtime.handleSubprocessEvent({ type: 'task_notification', taskId: 'task-mcp-1', text: 'mcp settled' });
    // Everything that belongs to the finished TURN stays dropped — the latch's
    // original contract, which the exception above must not widen.
    runtime.handleSubprocessEvent({ type: 'turn_start' });
    runtime.handleSubprocessEvent({ type: 'message_update' });
    runtime.handleSubprocessEvent({ type: 'agent_end' });

    expect(detached).toEqual([
      {
        type: 'task_completed',
        taskId: 'task-subagent-mt38u5ec-x9zwy0',
        status: 'completed',
        summary: '1. scan-inventory - done\nC7E2A-D8D7B-12FCE-344DB',
      },
      { type: 'task_notification', taskId: 'task-mcp-1', text: 'mcp settled' },
    ]);
    // Never through the closed turn generator.
    expect(enqueued).toEqual([]);
    agent.destroy();
  });

  it('latches an unknown-event contract failure before later raw events', () => {
    const { agent } = setupAgent(0);
    const runtime = agent as any;
    const adaptedTypes: string[] = [];
    const enqueued: any[] = [];
    let completions = 0;
    const originalAdaptEvent = runtime.adapter.adaptEvent.bind(runtime.adapter);

    runtime.adapter.adaptEvent = function* (event: Record<string, unknown>) {
      adaptedTypes.push(String(event.type));
      yield* originalAdaptEvent(event);
    };
    runtime.eventQueue.enqueue = (event: any) => enqueued.push(event);
    runtime.eventQueue.complete = () => { completions += 1; };

    runtime.handleSubprocessEvent({ type: 'future_pi_event', secret: 'must-not-leak' });
    runtime.handleSubprocessEvent({ type: 'turn_start' });

    expect(adaptedTypes).toEqual(['future_pi_event']);
    expect(enqueued).toEqual([{ type: 'error', message: `Unsupported Pi ${SUPPORTED_PI_EVENT_VERSION} event: future_pi_event` }]);
    expect(completions).toBe(1);
    agent.destroy();
  });

  it('force-aborts at N+1 raw Pi turn_start before later output', async () => {
    const { agent, abortReasons } = setupAgent(1);
    const runtime = agent as any;

    runtime.eventQueue.drain = async function* () {
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      expect(abortReasons).toEqual([]);
      yield toolStart('tool-1');
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
      // No later adapted event is needed to enforce the raw turn boundary.
    };

    const events = await collect(runtime.chatImpl('hello'));

    expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
    expect(events.filter(event => event.type === 'tool_start')).toHaveLength(1);
    expect(runtime.maxPiModelTurnsThisChat).toBe(0);
    expect(runtime.piModelTurnsThisChat).toBe(0);
    agent.destroy();
  });

  it('does not count tool or pre-tool events and leaves a zero limit disabled', async () => {
    const { agent, abortReasons } = setupAgent(0);
    const runtime = agent as any;

    runtime.eventQueue.drain = async function* () {
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      yield toolStart('tool-1');
      yield toolStart('tool-2');
      yield { type: 'pre_tool_use' };
      yield { type: 'complete' };
    };

    const events = await collect((agent as any).chatImpl('hello'));

    expect(abortReasons).toEqual([]);
    expect(events.filter(event => event.type === 'tool_start')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'complete' });
    agent.destroy();
  });

  it('resets raw Pi turn_start accounting for each chat', async () => {
    const { agent, abortReasons } = setupAgent(1);
    const runtime = agent as any;

    runtime.eventQueue.drain = async function* () {
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      yield { type: 'complete' };
    };

    expect(await collect(runtime.chatImpl('one'))).toEqual([{ type: 'complete' }]);
    expect(await collect(runtime.chatImpl('two'))).toEqual([{ type: 'complete' }]);
    expect(abortReasons).toEqual([]);
    agent.destroy();
  });

  it('shares one model-turn budget across a nested fallback retry', async () => {
    const { agent, abortReasons } = setupAgent(1);
    const runtime = agent as any;
    let drainCount = 0;

    // The cursor shape, not the old `fallbackModelRetry` boolean: one hop only,
    // because this suite is about the shared turn budget and not the walk.
    runtime.getRetryFallbackModel = (_error: unknown, options?: { fallbackChainIndex?: number }) => (
      options?.fallbackChainIndex === undefined ? { modelId: 'fallback-model', index: 0 } : null
    );
    runtime.setModel = () => {};
    runtime.eventQueue.drain = async function* () {
      drainCount += 1;
      runtime.handleSubprocessEvent({ type: 'turn_start' });
      if (drainCount === 1) {
        yield {
          type: 'typed_error',
          error: {
            code: 'network_error',
            title: 'Network error',
            message: 'retry on fallback',
          },
        };
      }
    };

    await collect(runtime.chatImpl('hello'));

    expect(drainCount).toBe(2);
    expect(abortReasons).toEqual([AbortReason.MaxAgentTurns]);
    expect(runtime.maxPiModelTurnsThisChat).toBe(0);
    expect(runtime.piModelTurnsThisChat).toBe(0);
    agent.destroy();
  });

});
