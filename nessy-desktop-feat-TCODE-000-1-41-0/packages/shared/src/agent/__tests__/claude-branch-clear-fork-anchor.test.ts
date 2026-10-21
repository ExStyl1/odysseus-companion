/**
 * UB12.8 — `/clear` in a BRANCHED Claude chat, before its first ask, starts a
 * fresh conversation instead of forking the parent again.
 *
 * The defect (born 2026-10-16 from the controller review, w2-bk8-9 finding 1;
 * lane BK-8's P-BK8-1): `ClaudeAgent` copies `config.session.branchFrom`'s fork
 * anchor into `branchFromSdkSessionId` / `branchFromSdkCwd` /
 * `branchFromSdkTurnId` at construction and retires the copy only when the
 * child's own `session_id` arrives. `/clear` keeps the agent
 * (`BaseAgent.chat`'s `clear` arm calls `clearHistory()`), and
 * `clearHistory()` nulled `sessionId` alone — so the next turn took the
 * `resume: <parent>, forkSession: true` arm and the model saw the history the
 * user had just cleared. The host's copy was dropped by F1.1290 (094565caf),
 * codex's agent copy by F1.1278 (e307ce2b6), Pi's twin by UA12.217
 * (30cff0403); this is the Claude agent's copy.
 *
 * The rig drives the REAL `BaseAgent.chat('/clear')` seam and a REAL
 * `chatImpl` turn with the SDK's `query` faked (the
 * `claude-resume-recovery-stop.test.ts` rig), and reads the `Options` the
 * agent handed the SDK plus the first user message it streamed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

const realSdk = { ...sdkPackage };

const PARENT_SDK_SESSION = 'sdk-parent-ub12-8';
const PARENT_TURN = 'parent-turn-ub12-8';
const CHILD_SDK_SESSION = 'sdk-child-ub12-8';

const queryOptions: Array<Record<string, unknown>> = [];
const firstPrompts: string[] = [];

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    session_id: CHILD_SDK_SESSION,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

/**
 * One answered turn. The assistant content matters: a fork counts as resuming,
 * and a resumed turn with no assistant content takes the empty-response
 * recovery (which retires the anchor itself and would hide what is measured).
 */
async function* answeredTurn(): AsyncGenerator<unknown> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
    session_id: CHILD_SDK_SESSION,
    parent_tool_use_id: null,
  };
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    queryOptions.push(input.options);
    if (typeof input.prompt === 'string') {
      firstPrompts.push(input.prompt);
      return answeredTurn();
    }
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    let first = true;
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        if (first) {
          firstPrompts.push(JSON.stringify(next.value));
          first = false;
        }
        yield* answeredTurn();
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> };
    stream.interrupt = async () => ({ still_queued: [] });
    return stream;
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const WORKSPACE_ID = 'ws-ub12-8';
const WORKSPACE_ROOT = '/tmp/nessy-ub12-8';

function branchedConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'UB12.8',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
      // A branch made today: lineage plus the provider fork anchor, no own sdkSessionId yet.
      branchFrom: {
        parent: { workspaceId: WORKSPACE_ID, sessionId: 'session-parent-ub12-8' },
        messageId: 'msg-parent-ub12-8',
        sdkSessionId: PARENT_SDK_SESSION,
        sdkTurnId: PARENT_TURN,
      },
    } as never,
  } as BackendConfig;
}

type Agent = InstanceType<typeof ClaudeAgent>;
type ForkFields = {
  sessionId: string | null;
  branchFromSdkSessionId: string | null;
  branchFromSdkCwd: string | null;
  branchFromSdkTurnId: string | null;
};

let counter = 0;
let liveAgent: Agent | null = null;

beforeEach(() => {
  queryOptions.length = 0;
  firstPrompts.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshBranchedAgent(): Agent {
  counter += 1;
  liveAgent = new ClaudeAgent(branchedConfig(`session-ub12-8-${counter}`));
  return liveAgent;
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** `/clear` through the real session-command seam every backend shares. */
function clearCommand(agent: Agent): Promise<AgentEvent[]> {
  return drain(agent.chat('/clear'));
}

/** One ordinary turn through the real `chatImpl`. */
function runTurn(agent: Agent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  return drain(chatImpl(message));
}

function fields(agent: Agent): ForkFields {
  return agent as unknown as ForkFields;
}

describe('UB12.8 — /clear in a branched Claude chat before its first ask', () => {
  it('control: an uncleared branch still forks the parent at the branch point and says so to the model', async () => {
    const agent = freshBranchedAgent();

    await runTurn(agent, 'what did we discuss?');

    expect(queryOptions).toHaveLength(1);
    const options = queryOptions[0]!;
    expect(options.resume).toBe(PARENT_SDK_SESSION);
    expect(options.forkSession).toBe(true);
    expect(options.resumeSessionAt).toBe(PARENT_TURN);
    expect(firstPrompts[0]).toContain('<branch_context>');
    // The fork established, the in-memory anchor is retired as before.
    expect(fields(agent).branchFromSdkSessionId).toBeNull();
    expect(fields(agent).sessionId).toBe(CHILD_SDK_SESSION);
  });

  it('after /clear the next turn neither resumes nor forks the parent, and carries no branch hint', async () => {
    const agent = freshBranchedAgent();

    const cleared = await clearCommand(agent);
    expect(cleared.some(e => e.type === 'info' && e.message.startsWith('Context cleared'))).toBe(true);
    const anchorAfterClear = {
      sessionId: fields(agent).branchFromSdkSessionId,
      cwd: fields(agent).branchFromSdkCwd,
      turnId: fields(agent).branchFromSdkTurnId,
    };

    await runTurn(agent, 'what did we discuss?');

    // What the model is handed is the user-facing fact: no resume of the parent, no fork.
    expect(queryOptions).toHaveLength(1);
    const options = queryOptions[0]!;
    expect({ resume: options.resume, forkSession: options.forkSession, resumeSessionAt: options.resumeSessionAt }).toEqual({
      resume: undefined,
      forkSession: undefined,
      resumeSessionAt: undefined,
    });
    expect(firstPrompts[0]).not.toContain('<branch_context>');
    // And the cause: the clear itself dropped the agent's copy of the fork anchor.
    expect(anchorAfterClear).toEqual({ sessionId: null, cwd: null, turnId: null });
    // The fresh conversation's own id is adopted as usual.
    expect(fields(agent).sessionId).toBe(CHILD_SDK_SESSION);
  });
});
