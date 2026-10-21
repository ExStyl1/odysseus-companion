import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import {
  DEFAULT_NESTOR_CLOUD_A2A_URL,
  type NestorSendMessageArgs,
  type NestorSendToolResultsArgs,
} from '../backend/nestor-cloud/client.ts';
import type { A2AStreamEvent, NestorAgentCard } from '../backend/nestor-cloud/types.ts';
import type { NestorCloudTurnOptions } from '../backend/nestor-cloud/turn.ts';
import {
  NESTOR_REQUEST_HEADROOM_BYTES,
  NESTOR_REQUEST_LIMIT_BYTES,
} from '../backend/nestor-cloud/metadata-builder.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { createMockBackendConfig, createMockCapabilityTurnRuntime, createMockWorkspace } from './test-utils.ts';

class FixtureClient {
  messageCalls: NestorSendMessageArgs[] = [];
  messageStreams: A2AStreamEvent[][] = [];

  async loadAgentCard(): Promise<NestorAgentCard> {
    return {
      capabilities: { streaming: true },
      supportedInterfaces: [{
        url: DEFAULT_NESTOR_CLOUD_A2A_URL,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      }],
    };
  }

  sendMessageStream(args: NestorSendMessageArgs): AsyncGenerator<A2AStreamEvent> {
    this.messageCalls.push(args);
    return stream(this.messageStreams.shift() ?? []);
  }

  sendToolResultsStream(_args: NestorSendToolResultsArgs): AsyncGenerator<A2AStreamEvent> {
    return stream([]);
  }

  sendRetryMarkerStream(_args: { contextId?: string; metadata?: Record<string, unknown>; signal?: AbortSignal }): AsyncGenerator<A2AStreamEvent> {
    return stream([]);
  }

  async cancelTask(): Promise<void> {}
}

class FixtureNestorCloudAgent extends NestorCloudAgent {
  constructor(config: BackendConfig, private readonly fixtureClient: FixtureClient) {
    super(config);
  }

  protected override createClient(): NestorCloudTurnOptions['client'] {
    return this.fixtureClient;
  }
}

function stream(events: A2AStreamEvent[]): AsyncGenerator<A2AStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function completedFlow(): A2AStreamEvent[] {
  return [
    { task: { id: 'task-budget', contextId: 'ctx-budget', status: { state: 'TASK_STATE_SUBMITTED' } } },
    {
      statusUpdate: {
        taskId: 'task-budget',
        contextId: 'ctx-budget',
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: { messageId: 'msg-budget', role: 'ROLE_AGENT', parts: [{ text: 'ok' }] },
        },
      },
    },
  ] as unknown as A2AStreamEvent[];
}

function createNestorConfig(root: string): BackendConfig {
  return createMockBackendConfig({
    provider: 'nestor-cloud-agent',
    projectTrusted: true,
    workspace: createMockWorkspace({
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: undefined,
  });
}

async function collectAgent(agent: NestorCloudAgent, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(message)) events.push(event);
  return events;
}

describe('NestorCloudAgent request byte budget', () => {
  it('trims the metadata so message + metadata stay under the gateway 500KB byte cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-budget-'));
    // Cyrillic: 1 UTF-16 code unit, 2 UTF-8 bytes each — a code-unit budget
    // would call this AGENTS.md 600,000 "long" and this message "20,000 long".
    writeFileSync(join(root, 'AGENTS.md'), 'я'.repeat(600_000));
    const message = 'ф'.repeat(20_000);

    const client = new FixtureClient();
    client.messageStreams.push(completedFlow());
    const agent = new FixtureNestorCloudAgent(createNestorConfig(root), client);
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());

    await collectAgent(agent, message);
    await agent.endLifecycle();
    agent.destroy();

    const sent = client.messageCalls[0];
    expect(sent).toBeDefined();
    const metadataBytes = Buffer.byteLength(JSON.stringify(sent!.metadata), 'utf8');
    const messageBytes = Buffer.byteLength(sent!.text, 'utf8');

    expect(messageBytes).toBeGreaterThan(40_000);
    expect(metadataBytes).toBeLessThanOrEqual(
      NESTOR_REQUEST_LIMIT_BYTES - messageBytes - NESTOR_REQUEST_HEADROOM_BYTES,
    );
    // The block that was trimmed is the repository prose, and it is still there.
    const agentsMd = (sent!.metadata as { agents_md?: { content: string } }).agents_md;
    expect(agentsMd?.content.length).toBeGreaterThan(0);
    expect(agentsMd?.content.length).toBeLessThan(600_000);
  });

  it('leaves the metadata of a small turn untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-budget-small-'));
    writeFileSync(join(root, 'AGENTS.md'), 'be brief');

    const client = new FixtureClient();
    client.messageStreams.push(completedFlow());
    const agent = new FixtureNestorCloudAgent(createNestorConfig(root), client);
    agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());

    await collectAgent(agent, 'hello');
    await agent.endLifecycle();
    agent.destroy();

    const agentsMd = (client.messageCalls[0]?.metadata as { agents_md?: { content: string } }).agents_md;
    expect(agentsMd?.content).toContain('be brief');
  });
});
