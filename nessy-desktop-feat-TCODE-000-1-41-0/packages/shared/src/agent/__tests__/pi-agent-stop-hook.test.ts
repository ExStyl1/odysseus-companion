import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig } from '../backend/types.ts';

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

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function setupAgent(): { agent: PiAgent; hookEvents: string[] } {
  const agent = new PiAgent(createConfig());
  const hookEvents: string[] = [];

  (agent as any).ensureSubprocess = async () => {};
  (agent as any).send = () => {};
  (agent as any).emitAutomationEvent = async (event: string) => {
    hookEvents.push(event);
  };

  return { agent, hookEvents };
}

describe('PiAgent Stop automation hook', () => {
  it('emits Stop once when a turn drains naturally', async () => {
    const { agent, hookEvents } = setupAgent();

    (agent as any).eventQueue.reset = () => {};
    (agent as any).eventQueue.drain = async function* () {
      yield { type: 'complete' };
    };

    await collect((agent as any).chatImpl('hello'));

    expect(hookEvents.filter(event => event === 'Stop')).toHaveLength(1);
    agent.destroy();
  });

  it('does not double emit Stop when abort completes the active turn', async () => {
    const { agent, hookEvents } = setupAgent();

    const run = collect((agent as any).chatImpl('hello'));
    while (!agent.isProcessing()) await Promise.resolve();
    await agent.abort();
    await run;

    expect(hookEvents.filter(event => event === 'Stop')).toHaveLength(1);
    agent.destroy();
  });

  it('does not double emit Stop when forceAbort completes the active turn', async () => {
    const { agent, hookEvents } = setupAgent();

    const run = collect((agent as any).chatImpl('hello'));
    while (!agent.isProcessing()) await Promise.resolve();
    agent.forceAbort(AbortReason.UserStop);
    await run;

    expect(hookEvents.filter(event => event === 'Stop')).toHaveLength(1);
    agent.destroy();
  });
});
