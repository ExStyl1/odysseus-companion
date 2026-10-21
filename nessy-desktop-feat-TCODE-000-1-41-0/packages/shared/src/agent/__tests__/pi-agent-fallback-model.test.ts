import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
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
    model: 'pi/primary-model',
    isHeadless: true,
  };
}

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function setupAgent(fallbackChain: string[]): {
  agent: PiAgent;
  sent: Array<Record<string, unknown>>;
  automationEvents: string[];
} {
  const agent = new PiAgent(createConfig());
  const sent: Array<Record<string, unknown>> = [];
  const automationEvents: string[] = [];
  const manifestSeed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-fallback-model',
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [],
  };
  const capabilityRuntime = {
    view: {
      generation: manifestSeed.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/tmp/nessy-general-agent-test'; },
      async readText() { return ''; },
      resolveCredential() { throw new Error('not used by fallback-model contract'); },
    },
    piExecutionManifestSeed: manifestSeed,
  } as CapabilityTurnRuntime;

  agent.setCapabilityTurnRuntime(capabilityRuntime);
  const execution = (agent as any).buildExecutionManifestForCurrentTurn();
  (agent as any).activeExecutionManifest = execution.manifest;
  (agent as any).adapter.setExecutionManifest(execution.manifest);

  (agent as any).ensureSubprocess = async () => {};
  (agent as any).emitAutomationEvent = async (event: string) => { automationEvents.push(event); };
  (agent as any).eventQueue.reset = () => {};
  (agent as any).getFallbackModel = () => fallbackChain;
  (agent as any).send = (message: Record<string, unknown>) => {
    sent.push(message);
  };

  return { agent, sent, automationEvents };
}

describe('PiAgent fallbackModel retry', () => {
  it('retries with the configured fallback model and restores the primary at turn end', async () => {
    const { agent, sent, automationEvents } = setupAgent(['pi/fallback-model']);
    let drainCount = 0;

    (agent as any).eventQueue.drain = async function* () {
      drainCount += 1;
      if (drainCount === 1) {
        throw new Error('upstream returned 503');
      }
      yield { type: 'complete' };
    };

    const events = await collect((agent as any).chatImpl('hello'));

    // THIS ASSERTION IS INVERTED FROM WHAT IT USED TO BE, and the inversion is
    // the fix, not a test edit. It used to expect 'pi/fallback-model' — the
    // switch outlived the turn for the whole session. `model-config.md:364`:
    // "The switch lasts for the current turn only, so your next message tries
    // the primary model first again."
    expect(agent.getModel()).toBe('pi/primary-model');
    expect(sent.filter(message => message.type === 'prompt')).toHaveLength(2);
    expect(events[0]?.type).toBe('info');
    expect(String(events[0]?.message ?? '')).toContain('pi/fallback-model');
    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(automationEvents.filter(event => event === 'StopFailure')).toEqual([]);
    agent.destroy();
  });

  it('keeps the original typed error when no fallback model is configured', async () => {
    const { agent, sent, automationEvents } = setupAgent([]);

    (agent as any).eventQueue.drain = async function* () {
      throw new Error('upstream returned 503');
    };

    const events = await collect((agent as any).chatImpl('hello'));

    expect(agent.getModel()).toBe('pi/primary-model');
    expect(sent.filter(message => message.type === 'prompt')).toHaveLength(1);
    expect(events[0]?.type).toBe('typed_error');
    expect(events[0]?.error?.code).toBe('service_error');
    expect(events[1]).toEqual({ type: 'complete' });
    expect(automationEvents.filter(event => event === 'StopFailure')).toEqual(['StopFailure']);
    agent.destroy();
  });

  /**
   * `model-config.md:385` — "When a request fails over, Claude Code tries each
   * entry in order until one accepts it. An entry that can't be reached either
   * … fails over to the next one the same way."
   */
  it('walks a three-entry chain in order until one accepts the turn', async () => {
    const { agent, sent, automationEvents } = setupAgent(['pi/one', 'pi/two', 'pi/three']);
    let drainCount = 0;
    const modelsPrompted: string[] = [];

    (agent as any).eventQueue.drain = async function* () {
      drainCount += 1;
      modelsPrompted.push(agent.getModel());
      if (drainCount <= 3) {
        throw new Error('upstream returned 503');
      }
      yield { type: 'complete' };
    };

    const events = await collect((agent as any).chatImpl('hello'));

    expect(modelsPrompted).toEqual(['pi/primary-model', 'pi/one', 'pi/two', 'pi/three']);
    expect(sent.filter(message => message.type === 'prompt')).toHaveLength(4);
    // `:364` — "showing a notice when it switches", once per hop.
    const notices = events.filter(event => event.type === 'info').map(event => String(event.message));
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain('pi/one');
    expect(notices[1]).toContain('pi/two');
    expect(notices[2]).toContain('pi/three');
    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(automationEvents.filter(event => event === 'StopFailure')).toEqual([]);
    // Turn-scoped even after three hops.
    expect(agent.getModel()).toBe('pi/primary-model');
    agent.destroy();
  });

  it('does not undo a model change that came from somewhere else', async () => {
    // The restore is turn-scoped, not model-scoped: `updateSessionModel` has no
    // in-flight gate, so a user can switch models while a turn runs. Restoring
    // blindly would silently revert that pick at turn end.
    const { agent } = setupAgent(['pi/fallback-model']);
    let drainCount = 0;

    (agent as any).eventQueue.drain = async function* () {
      drainCount += 1;
      if (drainCount === 1) {
        throw new Error('upstream returned 503');
      }
      agent.setModel('pi/user-picked');
      yield { type: 'complete' };
    };

    await collect((agent as any).chatImpl('hello'));

    expect(agent.getModel()).toBe('pi/user-picked');
    agent.destroy();
  });

  it('surfaces the original error once the chain is exhausted', async () => {
    const { agent, sent, automationEvents } = setupAgent(['pi/one', 'pi/two', 'pi/three']);

    (agent as any).eventQueue.drain = async function* () {
      throw new Error('upstream returned 503');
    };

    const events = await collect((agent as any).chatImpl('hello'));

    expect(sent.filter(message => message.type === 'prompt')).toHaveLength(4);
    expect(events.filter(event => event.type === 'info')).toHaveLength(3);
    const typedError = events.find(event => event.type === 'typed_error');
    expect(typedError?.error?.code).toBe('service_error');
    expect(events.at(-1)).toEqual({ type: 'complete' });
    expect(automationEvents.filter(event => event === 'StopFailure')).toEqual(['StopFailure']);
    expect(agent.getModel()).toBe('pi/primary-model');
    agent.destroy();
  });

  /**
   * P6.734 — the trigger set, both arms.
   *
   * `model-config.md#fallback-model-chains`, verbatim: "When the primary model
   * is overloaded, unavailable, or returns another non-retryable server error,
   * Claude Code can switch to a fallback model instead of failing the request.
   * Authentication, billing, rate-limit, request-size, and transport errors, and
   * a denial by your organization's policy check, never trigger a switch; those
   * follow their normal retry and error handling."
   *
   * `network_error` is that sentence's "transport errors", and it sat in Pi's
   * set while codex's ladder (`16b691036`) already read the same sentence and
   * excluded it — one chain, two runtimes, switching on different failures.
   */
  describe('P6.734 — a transport error is not a statement about the model', () => {
    it('a network error keeps the SAME model and spends no chain entry', async () => {
      const { agent, sent, automationEvents } = setupAgent(['pi/one', 'pi/two']);

      (agent as any).eventQueue.drain = async function* () {
        throw new Error('network fetch failed');
      };

      const events = await collect((agent as any).chatImpl('hello'));

      // One prompt: the primary, and no hop. Before this row the same run spent
      // both entries and reported the failure from `pi/two`.
      expect(sent.filter(message => message.type === 'prompt')).toHaveLength(1);
      expect(events.filter(event => event.type === 'info')).toHaveLength(0);
      expect(events[0]?.type).toBe('typed_error');
      expect(events[0]?.error?.code).toBe('network_error');
      expect(agent.getModel()).toBe('pi/primary-model');
      expect(automationEvents.filter(event => event === 'StopFailure')).toEqual(['StopFailure']);
      agent.destroy();
    });

    it('the control: the same chain still switches on a server error', async () => {
      // The positive arm on the identical harness, so the test above cannot
      // pass because the chain was inert.
      const { agent, sent } = setupAgent(['pi/one', 'pi/two']);
      let drainCount = 0;

      (agent as any).eventQueue.drain = async function* () {
        drainCount += 1;
        if (drainCount === 1) throw new Error('upstream returned 503');
        yield { type: 'complete' };
      };

      const events = await collect((agent as any).chatImpl('hello'));

      expect(sent.filter(message => message.type === 'prompt')).toHaveLength(2);
      const notices = events.filter(event => event.type === 'info').map(event => String(event.message));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('pi/one');
      agent.destroy();
    });
  });
});
