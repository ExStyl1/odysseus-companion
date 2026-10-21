import { describe, expect, it } from 'bun:test';
import { delimiter } from 'node:path';
import type { AgentEvent as AutomationAgentEvent, SdkAutomationInput } from '../../automations/types.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { fenceHookBand } from '../../automations/hook-context-fence.ts';
import { getSessionFilePath } from '../../sessions/storage.ts';

// P6.300 (`5dcc08249`) filled `transcript_path` in `BaseAgent.emitAutomationEvent`,
// the one funnel every runtime's automation events pass through, so EVERY hook
// payload below carries it. Derived from the same helper the production path
// uses rather than restated as a literal — a temp-dir path cannot be written out,
// and a restated one would pin a storage layout this file does not own.
const TRANSCRIPT_PATH = getSessionFilePath('ws-test', 'session-test');

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    pluginNodeRuntime: {
      command: '/private/nessy/runtime/bun',
      nodeShimDirectory: '/private/nessy/runtime/bin',
    },
  };
}

async function drain(agent: CodexAgent, prompt: string): Promise<void> {
  for await (const _event of (agent as any).chatImpl(prompt)) { /* drain */ }
}

describe('CodexAgent plugin runtime and lifecycle hooks', () => {
  it('applies selected plugin runtime per turn and emits the logical lifecycle exactly once', async () => {
    const agent = new CodexAgent(createConfig());
    const events: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
    const requests: Array<{ method: string; params: any }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event, input) {
        events.push({ event, input });
        if (event === 'SessionStart') {
          return { matchedCount: 1, decision: { additionalContext: 'Honey session directive' } };
        }
        if (event === 'UserPromptSubmit') {
          return { matchedCount: 1, decision: { additionalContext: `Prompt directive: ${input.prompt}` } };
        }
        return { matchedCount: 1 };
      },
    });
    const client = {
      request(method: string, params: any) {
        requests.push({ method, params });
        if (method === 'thread/fork') {
          const forkNumber = requests.filter(entry => entry.method === 'thread/fork').length;
          return Promise.resolve({ thread: { id: `thread-fork-${forkNumber}` } });
        }
        if (method === 'turn/start') {
          queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
        }
        return Promise.resolve({ thread: { id: 'thread-1' } });
      },
      notify() {},
      close() {},
    };
    (agent as any).ensureRuntime = async () => {
      (agent as any).client = client;
      (agent as any).threadId = 'thread-1';
    };
    (agent as any).activePluginSkillRuntimes = [{
      pluginInstanceId: 'plugin://honey@1.1.0',
      runtime: {
        profile: 'claude-plugin-env-v1',
        rootPath: '/private/nessy/plugins/honey',
        dataPath: '/private/nessy/plugin-data/honey',
      },
    }];

    await drain(agent, 'hello');
    await drain(agent, 'again');
    (agent as any).activePluginSkillRuntimes = [];
    await drain(agent, 'plain');
    await agent.endLifecycle();
    await agent.endLifecycle();

    expect(events.map(entry => entry.event)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'Stop',
      'UserPromptSubmit', 'Stop',
      'UserPromptSubmit', 'Stop',
      'SessionEnd',
    ]);
    expect(events[0]?.input).toEqual({
      hook_event_name: 'SessionStart', source: 'startup', transcript_path: TRANSCRIPT_PATH,
    });
    expect(events[1]?.input).toEqual({
      hook_event_name: 'UserPromptSubmit', prompt: 'hello', transcript_path: TRANSCRIPT_PATH,
    });
    const forks = requests.filter(entry => entry.method === 'thread/fork');
    expect(forks).toHaveLength(2);
    expect(forks[0]?.params.config.shell_environment_policy.set).toMatchObject({
      CLAUDE_PLUGIN_ROOT: '/private/nessy/plugins/honey',
      CLAUDE_CONFIG_DIR: '/private/nessy/plugin-data/honey',
      NESSY_BUN: '/private/nessy/runtime/bun',
      PATH: `/private/nessy/runtime/bin${delimiter}${process.env.PATH ?? ''}`,
    });
    expect(forks[0]?.params.config.permissions.nessy_runtime.filesystem).toMatchObject({
      '/private/nessy/plugin-data/honey': 'write',
    });
    // C4.11 · the plugin aliases are gone from the second fork, and the map is
    // no longer ABSENT: the effort pair rides it on every turn whose model has
    // an effort control. Asserted as "the plugin keys went and the pair stayed"
    // rather than as absence — an absence assertion here would have to be
    // deleted the day the pair was added, which is exactly what happened.
    expect(forks[1]?.params.config.shell_environment_policy.set)
      .not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
    expect(forks[1]?.params.config.shell_environment_policy.set)
      .not.toHaveProperty('NESSY_BUN');
    expect(forks[1]?.params.config.permissions.nessy_runtime.filesystem)
      .not.toHaveProperty('/private/nessy/plugin-data/honey');
    const turns = requests.filter(entry => entry.method === 'turn/start');
    // The hook context still leads the user's own text, and both still trail the
    // PromptBuilder context parts the turn now carries (see
    // `codex-context-parts.test.ts`), so this pins the tail rather than the whole
    // message.
    //
    // P2.59 — the two hook bodies now ride ONE `<hook_context>` element with the
    // shared `<untrusted source="...">` fence inside it, in the order they
    // always had. This assertion is what would catch the fence being dropped
    // back to a raw compose; the defang half is pinned in
    // `codex-hook-context-fence.test.ts`.
    //
    // P3.281 — composed by the SHARED `fenceHookBand` rather than restated, so
    // this assertion cannot drift from the band the agent actually emits. It
    // restated the expression until the notice was added, and then it was a
    // test pinning a shape nothing produced.
    const fencedTail = (session: string, prompt: string, message: string) => [
      fenceHookBand({ element: 'hook_context', source: 'hook_context', body: `${session}\n\n${prompt}` }),
      message,
    ].join('\n\n');
    expect(turns[0]?.params.input[0].text.endsWith(
      fencedTail('Honey session directive', 'Prompt directive: hello', 'hello'),
    )).toBe(true);
    expect(turns[1]?.params.input[0].text.endsWith(
      fencedTail('Honey session directive', 'Prompt directive: again', 'again'),
    )).toBe(true);
    expect(turns[2]?.params.threadId).toBe('thread-fork-2');

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  /**
   * T5 — `hooks.md:2194`: `background_tasks` / `session_crons` are PRESENT on a
   * `Stop` payload whenever the task registry is reachable, EMPTY rather than
   * absent when nothing is in flight, and missing ONLY when it is unreachable.
   *
   * T3 widened `hookTaskRegistryPort` to every scheduled runtime and recorded
   * that codex's Stop still omitted the keys — so a codex session could hold
   * cron records its own Stop hooks were structurally unable to see. These two
   * rows are that gap closed, and its negative control.
   */
  it('a codex Stop payload carries session_crons from the session\'s own registry', async () => {
    const config = createConfig();
    (config as any).hookTaskRegistryPort = {
      backgroundTasks: () => [],
      sessionCrons: () => [{ id: 'ab12cd34', schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' }],
    };
    const agent = new CodexAgent(config);
    const inputs: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event, input) {
        inputs.push({ event, input });
        return { matchedCount: 1 };
      },
    });
    (agent as any).ensureRuntime = async () => {
      (agent as any).client = {
        request(method: string) {
          if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
          return Promise.resolve({ thread: { id: 'thread-1' } });
        },
        notify() {},
        close() {},
      };
      (agent as any).threadId = 'thread-1';
    };

    await drain(agent, 'hello');

    const stop = inputs.find(entry => entry.event === 'Stop')?.input as Record<string, unknown> | undefined;
    expect(stop).toBeDefined();
    expect(stop!.session_crons).toEqual([
      { id: 'ab12cd34', schedule: '0 9 * * *', recurring: true, prompt: 'daily standup' },
    ]);
    // Both keys ride the one helper — a Stop that reported crons but not
    // background tasks would be a second, divergent projection.
    expect(stop!.background_tasks).toEqual([]);

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('omits both keys when no registry port is bound — the one documented absence', async () => {
    const agent = new CodexAgent(createConfig());
    const inputs: Array<{ event: AutomationAgentEvent; input: SdkAutomationInput }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event, input) {
        inputs.push({ event, input });
        return { matchedCount: 1 };
      },
    });
    (agent as any).ensureRuntime = async () => {
      (agent as any).client = {
        request(method: string) {
          if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
          return Promise.resolve({ thread: { id: 'thread-1' } });
        },
        notify() {},
        close() {},
      };
      (agent as any).threadId = 'thread-1';
    };

    await drain(agent, 'hello');

    const stop = inputs.find(entry => entry.event === 'Stop')?.input as Record<string, unknown> | undefined;
    // P6.11 added `stop_hook_active` (`hooks.md#stop`) to this payload and P6.300
    // added `transcript_path` to every payload; the two registry keys are still
    // the documented absence this row pins.
    expect(stop).toEqual({
      hook_event_name: 'Stop', stop_hook_active: false, transcript_path: TRANSCRIPT_PATH,
    });

    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('ends the turn when a UserPromptSubmit hook blocks, without starting one', async () => {
    // hooks.md: `UserPromptSubmit` "ends the turn on `decision: block` regardless
    // of `continue`" — so `continue: true` must NOT rescue the prompt.
    const agent = new CodexAgent(createConfig());
    const requests: Array<{ method: string }> = [];
    agent.setAutomationSystem({
      async executeAgentEvent(event) {
        if (event === 'UserPromptSubmit') {
          return {
            matchedCount: 1,
            decision: { decision: 'block', reason: 'prompt refused by policy' },
            universal: { continue: true },
          };
        }
        return { matchedCount: 1 };
      },
    });
    (agent as any).ensureRuntime = async () => {
      (agent as any).client = {
        request(method: string) {
          requests.push({ method });
          if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
          return Promise.resolve({ thread: { id: 'thread-1' } });
        },
        notify() {},
        close() {},
      };
      (agent as any).threadId = 'thread-1';
    };

    const events: any[] = [];
    for await (const event of (agent as any).chatImpl('do the thing')) events.push(event);

    expect(events).toEqual([{ type: 'error', message: 'prompt refused by policy' }]);
    expect(requests.filter(entry => entry.method === 'turn/start')).toHaveLength(0);
    agent.setAutomationSystem(undefined);
    agent.destroy();
  });

  it('transfers lifecycle state across a provider runtime replacement without a false boundary', async () => {
    const original = new CodexAgent(createConfig());
    (original as any)._sessionStartEmitted = true;
    (original as any)._sessionStartHooksApplied = true;
    (original as any)._sessionHookContext = 'pinned context';
    const state = original.captureLifecycleState();
    original.setAutomationSystem(undefined);
    original.destroy();

    const replacement = new CodexAgent(createConfig());
    const events: AutomationAgentEvent[] = [];
    replacement.setAutomationSystem({
      async executeAgentEvent(event) {
        events.push(event);
        return { matchedCount: 1 };
      },
    });
    replacement.restoreLifecycleState(state);
    expect((replacement as any)._sessionHookContext).toBe('pinned context');
    await replacement.endLifecycle();
    await replacement.endLifecycle();
    expect(events).toEqual(['SessionEnd']);
    replacement.setAutomationSystem(undefined);
    replacement.destroy();
  });

  it('awaits app-server and adapter teardown exactly once before restart disposal resolves', async () => {
    const agent = new CodexAgent(createConfig());
    const events: string[] = [];
    let releaseKill!: () => void;
    const killGate = new Promise<void>(resolve => { releaseKill = resolve; });
    (agent as any).client = {
      close() { events.push('client-close'); },
    };
    (agent as any).manager = {
      async kill() {
        events.push('manager-kill-start');
        await killGate;
        events.push('manager-kill-end');
      },
    };
    (agent as any).adapter = {
      async close() { events.push('adapter-close'); },
    };

    let settled = false;
    const first = agent.disposeForRestart().then(() => { settled = true; });
    const second = agent.disposeForRestart();
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(events).toEqual(['client-close', 'manager-kill-start']);

    releaseKill();
    await Promise.all([first, second]);
    expect(events).toEqual([
      'client-close',
      'manager-kill-start',
      'manager-kill-end',
      'adapter-close',
    ]);
    expect((agent as any).client).toBeNull();
    expect((agent as any).manager).toBeNull();
    expect((agent as any).adapter).toBeNull();
  });
});
