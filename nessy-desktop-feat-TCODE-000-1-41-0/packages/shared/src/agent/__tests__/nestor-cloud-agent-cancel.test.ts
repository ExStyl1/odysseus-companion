/**
 * Session teardown on the Nestor Cloud backend (F23).
 *
 * There is no server-side "close session" RPC — cancel is the whole mechanism
 * (connector `close-session.command.ts:13-28`). So a `destroy()` /
 * `disposeForRestart()` that only tears down locally leaves the remote task
 * running on the backend, burning the user's quota against a session nobody is
 * reading any more.
 *
 * Harness mirrors `nestor-cloud-agent-clear.test.ts` — a `FixtureClient` behind
 * the agent's protected `createClient()` — with one addition: the message stream
 * STALLS after opening the task, so teardown happens with a turn genuinely in
 * flight (which is the only state that owns a live task id).
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import type { NestorCloudContextSidecar } from '../backend/nestor-cloud/context-store.ts';
import { getSessionStoragePath } from '../../workspaces/paths.ts';
import {
  DEFAULT_NESTOR_CLOUD_A2A_URL,
  type NestorSendMessageArgs,
  type NestorSendToolResultsArgs,
} from '../backend/nestor-cloud/client.ts';
import type { A2AStreamEvent, NestorAgentCard } from '../backend/nestor-cloud/types.ts';
import type { NestorCloudTurnOptions } from '../backend/nestor-cloud/turn.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import {
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';

const WORKSPACE_ID = 'test-workspace-id';

interface CancelRecord {
  taskId: string;
  signal?: AbortSignal;
}

class FixtureClient {
  retryMarkerCalls: Array<Record<string, unknown>> = [];
  cancels: CancelRecord[] = [];
  messageCalls: NestorSendMessageArgs[] = [];
  toolResultCalls: NestorSendToolResultsArgs[] = [];
  /** Resolves once the turn has consumed the opening `task` frame. */
  readonly opened: Promise<void>;
  private markOpened!: () => void;
  private release!: () => void;
  private readonly gate: Promise<void>;

  constructor() {
    this.opened = new Promise<void>((resolve) => { this.markOpened = resolve; });
    this.gate = new Promise<void>((resolve) => { this.release = resolve; });
  }

  releaseStream(): void {
    this.release();
  }

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
    const self = this;
    return (async function* () {
      yield { task: { id: 'task-live', contextId: 'ctx-live', status: { state: 'TASK_STATE_SUBMITTED' } } };
      // Pulled only after the turn processed the frame above, so awaiting
      // `opened` guarantees the agent is holding a live task id.
      self.markOpened();
      await self.gate;
      yield {
        statusUpdate: {
          taskId: 'task-live',
          contextId: 'ctx-live',
          status: {
            state: 'TASK_STATE_COMPLETED',
            message: { messageId: 'msg-live', role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
          },
        },
      };
    })();
  }

  sendToolResultsStream(args: NestorSendToolResultsArgs): AsyncGenerator<A2AStreamEvent> {
    this.toolResultCalls.push(args);
    return (async function* () {})();
  }

  /** The in-band `-32029` retry send (T14). No taskId by construction. */
  sendRetryMarkerStream(args: { contextId?: string; metadata?: Record<string, unknown>; signal?: AbortSignal }): AsyncGenerator<A2AStreamEvent> {
    this.retryMarkerCalls.push(args);
    return (async function* () {})();
  }

  async cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
    this.cancels.push({ taskId, ...(signal ? { signal } : {}) });
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

function createNestorConfig(sessionId: string): BackendConfig {
  const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-cancel-'));
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

/**
 * Starts a turn and resolves once the remote task id is live in the agent. The
 * in-flight drain is returned WRAPPED — an async function that returned the
 * promise itself would adopt it and only resolve when the turn ends.
 */
async function startLiveTurn(
  agent: NestorCloudAgent,
  client: FixtureClient,
): Promise<{ drained: Promise<AgentEvent[]> }> {
  const drained = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of agent.chat('do the thing')) events.push(event);
    return events;
  })();
  await client.opened;
  return { drained };
}

describe('Nestor cloud session teardown', () => {
  it('cancels the in-flight remote task on destroy()', async () => {
    const { agent, client } = createAgent('nestor-cancel-destroy');
    const { drained } = await startLiveTurn(agent, client);

    agent.destroy();
    await Promise.resolve();

    expect(client.cancels.map(record => record.taskId)).toEqual(['task-live']);

    client.releaseStream();
    await drained.catch(() => undefined);
  });

  it('cancels the in-flight remote task on disposeForRestart(), whose abort fires first', async () => {
    const { agent, client } = createAgent('nestor-cancel-dispose');
    const { drained } = await startLiveTurn(agent, client);

    await agent.disposeForRestart();

    expect(client.cancels.map(record => record.taskId)).toEqual(['task-live']);
    // The turn's own signal is aborted by then — the cancel must not ride it.
    const sent = client.cancels[0]?.signal;
    expect(sent).toBeDefined();
    expect(sent?.aborted).toBe(false);

    client.releaseStream();
    await drained.catch(() => undefined);
  });

  it('aborts the in-flight turn signal on destroy()', async () => {
    // `turn.ts:16-19,200-206` states as fact that every production cancel path
    // aborts the turn's signal one line before calling `cancel()` — which is
    // the whole reason the cancel RPC carries a signal of its own.
    // `destroy()` did not, leaving a live fetch iterating against a disposed
    // tool executor.
    const { agent, client } = createAgent('nestor-cancel-destroy-abort');
    const { drained } = await startLiveTurn(agent, client);

    expect(client.messageCalls[0]?.signal?.aborted).toBe(false);

    agent.destroy();
    await Promise.resolve();

    expect(client.messageCalls[0]?.signal?.aborted).toBe(true);

    client.releaseStream();
    await drained.catch(() => undefined);
  });

  it('leaves the sidecar alone on a teardown cancel', async () => {
    // The cancel is awaited, so its `clearTask` notification lands up to 5s
    // AFTER the agent is gone — and the store rebuilds the file from a cached
    // snapshot, so the write resurrects a sidecar the teardown superseded.
    const sessionId = 'nestor-cancel-sidecar';
    const { agent, client } = createAgent(sessionId);
    const { drained } = await startLiveTurn(agent, client);

    const path = sidecarPath(sessionId);
    expect(readSidecar(sessionId).activeTaskId).toBe('task-live');

    agent.destroy();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(client.cancels.map(record => record.taskId)).toEqual(['task-live']);
    expect(existsSync(path)).toBe(true);
    expect(readSidecar(sessionId).activeTaskId).toBe('task-live');

    client.releaseStream();
    await drained.catch(() => undefined);
  });

  it('sends nothing when no turn is in flight', async () => {
    const { agent, client } = createAgent('nestor-cancel-idle');

    agent.destroy();
    await Promise.resolve();

    expect(client.cancels).toHaveLength(0);
  });
});
