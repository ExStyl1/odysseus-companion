import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import {
  DEFAULT_NESTOR_CLOUD_A2A_URL,
  type NestorSendMessageArgs,
  type NestorSendToolResultsArgs,
} from '../backend/nestor-cloud/client.ts';
import type { A2AStreamEvent, NestorAgentCard } from '../backend/nestor-cloud/types.ts';
import type { NestorCloudTurnOptions } from '../backend/nestor-cloud/turn.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { createMockBackendConfig, createMockWorkspace } from './test-utils.ts';

const SKILL_BODY = 'Ship the release notes exactly like this.';

class FixtureClient {
  retryMarkerCalls: Array<Record<string, unknown>> = [];
  retryMarkerStreams: A2AStreamEvent[][] = [];
  messageCalls: NestorSendMessageArgs[] = [];
  toolResultCalls: NestorSendToolResultsArgs[] = [];
  messageStreams: A2AStreamEvent[][] = [];
  toolStreams: A2AStreamEvent[][] = [];

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

  sendToolResultsStream(args: NestorSendToolResultsArgs): AsyncGenerator<A2AStreamEvent> {
    this.toolResultCalls.push(args);
    return stream(this.toolStreams.shift() ?? []);
  }

  /** The in-band `-32029` retry send (T14). No taskId by construction. */
  sendRetryMarkerStream(args: { contextId?: string; metadata?: Record<string, unknown>; signal?: AbortSignal }): AsyncGenerator<A2AStreamEvent> {
    this.retryMarkerCalls.push(args);
    return stream(this.retryMarkerStreams.shift() ?? []);
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

function activateSkillFlow(skillName: string): A2AStreamEvent[] {
  return [
    { task: { id: 'task-skill', contextId: 'ctx-skill', status: { state: 'TASK_STATE_SUBMITTED' } } },
    {
      statusUpdate: {
        taskId: 'task-skill',
        contextId: 'ctx-skill',
        status: {
          state: 'TASK_STATE_WORKING',
          message: {
            messageId: 'msg-skill',
            role: 'ROLE_AGENT',
            parts: [{
              data: {
                data_type: 'tool_call',
                data_version: 1,
                id: 'call-fixture-skill',
                index: 0,
                function: { name: 'activate_skill', arguments: JSON.stringify({ skill_name: skillName }) },
              },
            }],
          },
        },
      },
    },
    {
      statusUpdate: {
        taskId: 'task-skill',
        contextId: 'ctx-skill',
        status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { messageId: 'msg-skill-input', role: 'ROLE_AGENT', parts: [] } },
      },
    },
  ] as unknown as A2AStreamEvent[];
}

function continuationFlow(): A2AStreamEvent[] {
  return [
    {
      statusUpdate: {
        taskId: 'task-skill',
        contextId: 'ctx-skill',
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: { messageId: 'msg-skill-done', role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
        },
      },
    },
  ] as unknown as A2AStreamEvent[];
}

function createNestorConfig(root: string): BackendConfig {
  return createMockBackendConfig({
    provider: 'nestor-cloud-agent',
    workspace: createMockWorkspace({
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: undefined,
  });
}

function capabilityRuntime(options: {
  skillDirectory?: string;
  disableModelInvocation?: boolean;
} = {}): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'nestor-skill-generation',
      sources: [],
      skills: [{
        key: 'skill:plugin:release-notes',
        logicalName: 'release-notes',
        description: 'Write the release notes',
        selectedAsUnqualifiedAlias: true,
        ...(options.disableModelInvocation ? { disableModelInvocation: true } : {}),
        resource: {
          pluginInstanceId: 'plugin://test/pack@1.0.0',
          relativePath: 'skills/release-notes/SKILL.md',
          contentHash: 'a'.repeat(64),
        },
      }],
      mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [],
      memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/test/SKILL.md'; },
      async readText() { return SKILL_BODY; },
      ...(options.skillDirectory ? { async resolveSkillDirectory() { return options.skillDirectory!; } } : {}),
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

async function collectAgent(agent: NestorCloudAgent, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(message)) events.push(event);
  return events;
}

describe('NestorCloudAgent skills', () => {
  it('advertises the session skills and answers activate_skill with the skill body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-skills-'));
    const client = new FixtureClient();
    client.messageStreams.push(activateSkillFlow('release-notes'));
    client.toolStreams.push(continuationFlow());
    const agent = new FixtureNestorCloudAgent(createNestorConfig(root), client);
    agent.setCapabilityTurnRuntime(capabilityRuntime({ skillDirectory: '/skills/release-notes' }));

    await collectAgent(agent, 'write the notes');
    await agent.endLifecycle();
    agent.destroy();

    expect(client.messageCalls[0]?.metadata).toMatchObject({
      skills: [{ name: 'release-notes', description: 'Write the release notes' }],
    });
    const [result] = client.toolResultCalls[0]?.results ?? [];
    expect(result?.toolCallId).toBe('call-fixture-skill');
    expect(result?.error).toBeUndefined();
    expect(result?.content).toBe(
      `<skill_content name="release-notes">\n${SKILL_BODY}\n\nSkill directory: /skills/release-notes\n</skill_content>`,
    );
  });

  it('sends the backend literal — not a tool error — when the skill is not model-invocable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-skills-refused-'));
    const client = new FixtureClient();
    client.messageStreams.push(activateSkillFlow('release-notes'));
    client.toolStreams.push(continuationFlow());
    const agent = new FixtureNestorCloudAgent(createNestorConfig(root), client);
    agent.setCapabilityTurnRuntime(capabilityRuntime({ disableModelInvocation: true }));

    await collectAgent(agent, 'write the notes');
    await agent.endLifecycle();
    agent.destroy();

    // Not advertised, and the guessed name is refused the same way.
    expect(client.messageCalls[0]?.metadata).not.toHaveProperty('skills');
    const [result] = client.toolResultCalls[0]?.results ?? [];
    expect(result?.error).toBeUndefined();
    expect(result?.content?.startsWith('Skills registry has throw an error:')).toBe(true);
    expect(result?.content).toContain('release-notes');
  });
});
