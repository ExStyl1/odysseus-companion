/**
 * F5 — a terminal tool call (`ask_followup_question` / `plan_mode_respond`)
 * SUSPENDS the remote turn: the question is surfaced to the user, the call is
 * parked in the context sidecar, and the NEXT USER PROMPT is sent back as that
 * call's `tool_result` (reference connector: `src/commands/tool-call.command.ts:126-133`
 * parks it, `src/core/turn.ts:340-357` answers it).
 *
 * Driven through `NestorCloudAgent.chat()` rather than the turn alone, because
 * two of the three properties only exist at that level: the sidecar round trip
 * across agent instances, and the non-reentry of `BaseAgent.chat`'s model-skill
 * continuation loop (`base-agent.ts:3868-3879`).
 */
import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts';
import type {
  NestorSendMessageArgs,
  NestorSendToolResultsArgs,
} from '../backend/nestor-cloud/client.ts';
import type { A2AStreamEvent, NestorAgentCard } from '../backend/nestor-cloud/types.ts';
import type { NestorCloudTurnOptions } from '../backend/nestor-cloud/turn.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { createMockBackendConfig, createMockWorkspace } from './test-utils.ts';

class FixtureClient {
  retryMarkerCalls: Array<Record<string, unknown>> = [];
  retryMarkerStreams: A2AStreamEvent[][] = [];
  readonly messageCalls: NestorSendMessageArgs[] = [];
  readonly toolResultCalls: NestorSendToolResultsArgs[] = [];
  readonly messageStreams: A2AStreamEvent[][] = [];
  readonly toolStreams: A2AStreamEvent[][] = [];

  async loadAgentCard(): Promise<NestorAgentCard> {
    return { capabilities: { streaming: true } };
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

/**
 * The session directory is overridden so the sidecar lands in a temp dir instead
 * of the real `SESSIONS_DIR` — `getSessionStoragePath` is the ONE seam that
 * decides where `nestor-cloud-context.json` is written.
 */
class FixtureNestorCloudAgent extends NestorCloudAgent {
  constructor(
    config: BackendConfig,
    private readonly fixtureClient: FixtureClient,
    private readonly sessionPath: string,
  ) {
    super(config);
  }

  protected override createClient(): NestorCloudTurnOptions['client'] {
    return this.fixtureClient;
  }

  protected override getSessionStoragePath(): string | undefined {
    return this.sessionPath;
  }
}

function stream(events: A2AStreamEvent[]): AsyncGenerator<A2AStreamEvent> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function submitted(): A2AStreamEvent {
  return { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } };
}

function terminalToolFrame(args: Record<string, unknown>, name = 'ask_followup_question'): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_INPUT_REQUIRED',
        message: {
          messageId: 'msg-terminal',
          role: 'ROLE_AGENT',
          parts: [{
            data: {
              data_type: 'tool_call',
              data_version: 1,
              id: 'call-ask',
              index: 0,
              function: { name, arguments: JSON.stringify(args) },
            },
          }],
        },
      },
    },
  };
}

function completed(text: string): A2AStreamEvent {
  return {
    statusUpdate: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: {
        state: 'TASK_STATE_COMPLETED',
        message: { messageId: 'msg-done', role: 'ROLE_AGENT', parts: [{ text }] },
      },
    },
  };
}

function config(root: string): BackendConfig {
  return createMockBackendConfig({
    provider: 'nestor-cloud-agent',
    workspace: createMockWorkspace({
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
  });
}

function capabilityRuntime(withHoneySkill = false): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'nestor-suspension-generation',
      sources: [],
      skills: withHoneySkill ? [{
        key: 'skill:plugin:honey',
        logicalName: 'honey',
        description: 'Honey',
        selectedAsUnqualifiedAlias: true,
        resource: {
          pluginInstanceId: 'plugin://test/honey@1.0.0',
          relativePath: 'skills/honey/SKILL.md',
          contentHash: 'a'.repeat(64),
        },
      }] : [],
      mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [],
      memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/test/SKILL.md'; },
      async readText() { return 'Honey skill body.'; },
      resolveCredential() { throw new CapabilityMaterializationError('credential-not-ready'); },
    },
  } as unknown as CapabilityTurnRuntime;
}

async function collectAgent(agent: NestorCloudAgent, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(message)) events.push(event);
  return events;
}

function sidecar(sessionPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sessionPath, 'meta', 'nestor-cloud-context.json'), 'utf-8'));
}

function createAgent(root: string, sessionPath: string, client: FixtureClient, withHoneySkill = false) {
  const agent = new FixtureNestorCloudAgent(config(root), client, sessionPath);
  agent.setCapabilityTurnRuntime(capabilityRuntime(withHoneySkill));
  return agent;
}

describe('Nestor cloud terminal-tool suspension', () => {
  it('parks the question in the sidecar and answers it with the next user prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-suspend-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nestor-suspend-session-'));

    const askClient = new FixtureClient();
    askClient.messageStreams.push([
      submitted(),
      terminalToolFrame({ question: 'Which database?', followup: ['postgres', 'sqlite'] }),
    ]);
    const asking = createAgent(root, sessionPath, askClient);
    const askEvents = await collectAgent(asking, 'set up the database');
    asking.destroy();

    expect(askClient.toolResultCalls).toEqual([]);
    expect(askEvents.some(event => event.type === 'tool_start' || event.type === 'tool_result')).toBe(false);
    expect(askEvents.filter(event => event.type === 'text_complete').map(event => event.text))
      .toEqual(['Which database?\n1. postgres\n2. sqlite']);
    expect(askEvents.at(-1)).toMatchObject({
      type: 'complete',
      terminalReason: 'tool_deferred',
      deferredToolUse: { id: 'call-ask', name: 'ask_followup_question' },
    });
    expect(sidecar(sessionPath)).toMatchObject({
      contextId: 'ctx-1',
      activeTaskId: 'task-1',
      pendingTerminalTool: { toolCallId: 'call-ask', name: 'ask_followup_question' },
    });

    // A fresh agent instance: the parked call survives only through the sidecar.
    const answerClient = new FixtureClient();
    answerClient.toolStreams.push([completed('Using postgres then.')]);
    const answering = createAgent(root, sessionPath, answerClient);
    const answerEvents = await collectAgent(answering, 'postgres');
    answering.destroy();

    expect(answerClient.messageCalls).toEqual([]);
    expect(answerClient.toolResultCalls).toHaveLength(1);
    const [answerCall] = answerClient.toolResultCalls;
    expect(answerCall).toMatchObject({ contextId: 'ctx-1', taskId: 'task-1' });
    expect(answerCall?.results).toHaveLength(1);
    expect(answerCall?.results[0]?.toolCallId).toBe('call-ask');
    // The answer is the turn's effective prompt — the same text a normal send
    // would carry (pinned capability block and all), ending in what the user typed.
    expect(answerCall?.results[0]?.content?.endsWith('postgres')).toBe(true);
    // The turn's metadata rides the answer: it is the first send of a user turn,
    // so dropping it would leave that turn with no MCP tools and no skills.
    expect(answerCall?.metadata).toBeDefined();
    expect(answerEvents.filter(event => event.type === 'text_complete').map(event => event.text))
      .toEqual(['Using postgres then.']);
    expect(sidecar(sessionPath).pendingTerminalTool).toBeUndefined();
  });

  it('does not re-enter the backend when the parked question carries a [skill:…] marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nestor-suspend-skill-'));
    const sessionPath = mkdtempSync(join(tmpdir(), 'nestor-suspend-skill-session-'));
    const client = new FixtureClient();
    client.messageStreams.push([
      submitted(),
      terminalToolFrame({ response: 'Shall I follow [skill:honey] for the release notes?' }, 'plan_mode_respond'),
    ]);
    // Second stream, deliberately loaded: if the turn re-entered, it would be consumed.
    client.messageStreams.push([completed('re-entered')]);

    const agent = createAgent(root, sessionPath, client, true);
    const events = await collectAgent(agent, 'draft the release notes');
    agent.destroy();

    // The suspension's `complete` carries a terminalReason, so `BaseAgent.chat`
    // holds back nothing and builds no model-skill continuation — the question is
    // the user's to answer, not a prompt to feed back to the model.
    expect(client.messageCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'tool_deferred' });
    expect(sidecar(sessionPath)).toMatchObject({
      pendingTerminalTool: { toolCallId: 'call-ask', name: 'plan_mode_respond' },
    });
  });
});
