/**
 * `/clear` on the Nestor Cloud backend (F8).
 *
 * The conversation this backend clears does not live in our session file — it
 * lives on the backend, behind the `contextId` in the sidecar. `clearHistory()`
 * IS the `/clear` path (`base-agent.ts:3708-3710`, the one arm that covers every
 * backend), so unless the override drops the sidecar, "context cleared" clears
 * nothing the model can see: the next prompt re-attaches to the same remote
 * conversation.
 *
 * Harness mirrors `nestor-cloud-e2e.test.ts` — a `FixtureClient` behind the
 * agent's protected `createClient()`, so the whole shared `chat()` seam runs.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import {
  DEFAULT_NESTOR_CLOUD_A2A_URL,
  type NestorSendMessageArgs,
  type NestorSendToolResultsArgs,
} from '../backend/nestor-cloud/client.ts';
import type { NestorCloudContextSidecar } from '../backend/nestor-cloud/context-store.ts';
import type { A2AStreamEvent, NestorAgentCard } from '../backend/nestor-cloud/types.ts';
import type { NestorCloudTurnOptions } from '../backend/nestor-cloud/turn.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { getSessionStoragePath } from '../../workspaces/paths.ts';
import {
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'test-workspace-id';

class FixtureClient {
  retryMarkerCalls: Array<Record<string, unknown>> = [];
  retryMarkerStreams: A2AStreamEvent[][] = [];
  cancelCalls: string[] = [];
  messageCalls: NestorSendMessageArgs[] = [];
  toolResultCalls: NestorSendToolResultsArgs[] = [];
  messageStreams: A2AStreamEvent[][] = [];
  toolStreams: A2AStreamEvent[][] = [];

  async loadAgentCard(_signal?: AbortSignal): Promise<NestorAgentCard> {
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

  async cancelTask(taskId: string, _signal?: AbortSignal): Promise<void> {
    this.cancelCalls.push(taskId);
  }
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

async function collectAgent(agent: NestorCloudAgent, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(message)) events.push(event);
  return events;
}

function createNestorConfig(sessionId: string): BackendConfig {
  const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-clear-'));
  return createMockBackendConfig({
    provider: 'nestor-cloud-agent',
    workspace: createMockWorkspace({
      id: WORKSPACE_ID,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: createMockSession({ id: sessionId }),
  });
}

function sidecarPath(sessionId: string): string {
  return join(getSessionStoragePath(WORKSPACE_ID, sessionId), 'meta', 'nestor-cloud-context.json');
}

function readSidecar(sessionId: string): NestorCloudContextSidecar {
  return JSON.parse(readFileSync(sidecarPath(sessionId), 'utf-8')) as NestorCloudContextSidecar;
}

function createAgent(sessionId: string): { agent: FixtureNestorCloudAgent; client: FixtureClient } {
  const client = new FixtureClient();
  const agent = new FixtureNestorCloudAgent(createNestorConfig(sessionId), client);
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId,
  }));
  return { agent, client };
}

/** A completed text turn: `task` opens the context, the final frame closes it. */
function completedTextFlow(text: string): A2AStreamEvent[] {
  return [
    { task: { id: 'task-clear', contextId: 'ctx-clear', status: { state: 'TASK_STATE_SUBMITTED' } } },
    {
      statusUpdate: {
        taskId: 'task-clear',
        contextId: 'ctx-clear',
        status: {
          state: 'TASK_STATE_COMPLETED',
          message: { messageId: 'msg-clear', role: 'ROLE_AGENT', parts: [{ text }] },
        },
      },
    },
  ];
}

/** A turn that ends parked on a question (T9): input-required + a terminal tool. */
function parkedQuestionFlow(): A2AStreamEvent[] {
  return [
    { task: { id: 'task-clear', contextId: 'ctx-clear', status: { state: 'TASK_STATE_SUBMITTED' } } },
    {
      statusUpdate: {
        taskId: 'task-clear',
        contextId: 'ctx-clear',
        status: {
          state: 'TASK_STATE_INPUT_REQUIRED',
          message: {
            messageId: 'msg-ask',
            role: 'ROLE_AGENT',
            parts: [{
              data: {
                data_type: 'tool_call',
                data_version: 1,
                id: 'call-ask',
                index: 0,
                function: {
                  name: 'ask_followup_question',
                  arguments: '{"question":"Which database?","followup":["postgres","sqlite"]}',
                },
              },
            }],
          },
        },
      },
    },
  ];
}

describe('Nestor cloud /clear', () => {
  it('drops the remote context so the next prompt starts a fresh conversation', async () => {
    const sessionId = 'nestor-clear-context';
    const { agent, client } = createAgent(sessionId);
    client.messageStreams.push(completedTextFlow('PONG'), completedTextFlow('PONG AGAIN'));

    await collectAgent(agent, 'ping');
    expect(readSidecar(sessionId).contextId).toBe('ctx-clear');

    const events = await collectAgent(agent, '/clear');

    // The command executes at the seam — `chatImpl` is never entered, so nothing
    // reaches the wire.
    expect(client.messageCalls).toHaveLength(1);
    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(existsSync(sidecarPath(sessionId))).toBe(false);

    await collectAgent(agent, 'ping again');

    expect(client.messageCalls).toHaveLength(2);
    expect(client.messageCalls[1]?.contextId).toBeUndefined();
    expect(client.messageCalls[1]?.taskId).toBeUndefined();
  });

  it('kills the parked terminal question so the cleared conversation cannot answer it', async () => {
    const sessionId = 'nestor-clear-parked';
    const { agent, client } = createAgent(sessionId);
    client.messageStreams.push(parkedQuestionFlow(), completedTextFlow('fresh'));

    await collectAgent(agent, 'set up the database');
    expect(readSidecar(sessionId)).toMatchObject({
      activeTaskId: 'task-clear',
      pendingTerminalTool: { toolCallId: 'call-ask', name: 'ask_followup_question' },
    });

    await collectAgent(agent, '/clear');
    expect(existsSync(sidecarPath(sessionId))).toBe(false);

    // The next prompt is a new conversation's first message — NOT the answer to
    // a question the user cleared away.
    await collectAgent(agent, 'postgres');

    expect(client.toolResultCalls).toHaveLength(0);
    expect(client.messageCalls[1]).toMatchObject({ text: expect.stringContaining('postgres') });
    expect(client.messageCalls[1]?.taskId).toBeUndefined();
    expect(client.messageCalls[1]?.contextId).toBeUndefined();
  });
});
