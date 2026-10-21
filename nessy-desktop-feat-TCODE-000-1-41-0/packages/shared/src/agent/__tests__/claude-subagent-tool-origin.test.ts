/**
 * F1.475 (1/2) — the claude agent can say WHICH subagent made a tool call, and WHEN that subagent ended.
 *
 * Measured on the vendored `claude` 2.1.251 (WJ-yy, 2026-09-24; a stub Messages upstream, a main thread that
 * spawns a background `Agent`, whose subagent calls an in-process MCP tool):
 *
 * - the PreToolUse hook for the subagent's call carries `tool_use_id: toolu_sub_whoami` AND
 *   `agent_id: a4cad016e2165d3af`; the main thread's call carries its `tool_use_id` and no `agent_id`;
 * - that agent id is the `task_id` of the stream's `task_started` / `task_notification` and SubagentStop's
 *   `agent_id`;
 * - the subagent's end arrives as `system/task_notification` — `completed` for a normal end, `stopped` after
 *   `Query.stopTask`, after an interrupt of a foreground subagent, AND after an interrupt with no parent turn
 *   running (a background subagent killed by it) — and it can arrive while NO turn is open, which is exactly when
 *   `routeLiveMessage` drops a message on the floor (`noteBetweenTurnsMessage`).
 *
 * So the agent keeps a bounded tool-use → subagent map from its own PreToolUse hook, reads a terminal
 * `task_notification` ABOVE the slot guard, and tells the host (`onSubagentEnded`). The rig is
 * `claude-steer-fifo.test.ts`'s: a real `ClaudeAgent`, the SDK `query` faked, and the REAL PreToolUse hook
 * `chatImpl` registered, read back off the options the fake received.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

const realSdk = { ...sdkPackage };

type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;
type HookMatcher = { hooks: HookFn[] };

const scripts: Array<() => AsyncGenerator<unknown>> = [];
let capturedHooks: Record<string, HookMatcher[]> | undefined;

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedHooks = input.options.hooks as Record<string, HookMatcher[]> | undefined;
    if (typeof input.prompt === 'string') return (scripts.shift() ?? plainSuccess)();
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield* (scripts.shift() ?? plainSuccess)();
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-475';

type SubagentOrigin = {
  subagentOfToolUse(toolUseId: string): string | undefined;
  subagentEnded(agentId: string): boolean;
  onSubagentEnded?: (agentId: string) => void;
  routeLiveMessage(message: unknown): Promise<void>;
};

let counter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

function freshAgent(): InstanceType<typeof ClaudeAgent> {
  counter += 1;
  liveAgent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-475',
      name: 'F1.475',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: { id: `session-f1-475-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
  } as BackendConfig);
  return liveAgent;
}

async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

/** Fire every PreToolUse hook the turn registered, as the CLI does for one allowed Read with this tool-use id. */
async function firePreToolUse(toolUseId: string, extra: Record<string, unknown> = {}): Promise<void> {
  for (const matcher of capturedHooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      await Promise.race([
        hook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_use_id: toolUseId,
          tool_input: { file_path: `${WORKSPACE_ROOT}/README.md` },
          session_id: 'sdk-session',
          transcript_path: '/tmp/f1-475.jsonl',
          cwd: WORKSPACE_ROOT,
          ...extra,
        }, toolUseId, { signal: new AbortController().signal }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('PreToolUse hook did not answer')), 3_000)),
      ]);
    }
  }
}

const taskNotification = (taskId: string, status: string) => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: 'toolu_main_agent', status,
  output_file: '', summary: '', uuid: 'u-1', session_id: 'sdk-session',
});

beforeEach(() => {
  scripts.length = 0;
  capturedHooks = undefined;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

describe('F1.475 — which subagent made a call, from the agent\'s own PreToolUse hook', () => {
  it('a subagent\'s call is remembered by its tool-use id; a main-thread call names no subagent', async () => {
    const agent = freshAgent();
    scripts.push(async function* turn() {
      await firePreToolUse('toolu_sub_whoami', { agent_id: 'a4cad016e2165d3af', agent_type: 'general-purpose' });
      await firePreToolUse('toolu_main_whoami');
      yield resultMessage();
    });
    await runTurn(agent, 'go');

    const origin = agent as unknown as SubagentOrigin;
    expect({
      sub: origin.subagentOfToolUse('toolu_sub_whoami'),
      main: origin.subagentOfToolUse('toolu_main_whoami'),
      unknown: origin.subagentOfToolUse('toolu_never_seen'),
    }).toEqual({ sub: 'a4cad016e2165d3af', main: undefined, unknown: undefined });
  });

  it('CONTROL — agent_type without agent_id is the main thread of an --agent session, not a subagent', async () => {
    const agent = freshAgent();
    scripts.push(async function* turn() {
      await firePreToolUse('toolu_agent_main', { agent_type: 'code-reviewer' });
      yield resultMessage();
    });
    await runTurn(agent, 'go');
    expect((agent as unknown as SubagentOrigin).subagentOfToolUse('toolu_agent_main')).toBeUndefined();
  });
});

describe('F1.475 — a subagent\'s end reaches the host even when no turn is open', () => {
  it('a terminal task_notification with no slot open calls onSubagentEnded and is remembered', async () => {
    const agent = freshAgent() as unknown as SubagentOrigin;
    const ended: string[] = [];
    agent.onSubagentEnded = agentId => { ended.push(agentId); };

    await agent.routeLiveMessage(taskNotification('a-stopped', 'stopped'));
    await agent.routeLiveMessage(taskNotification('a-completed', 'completed'));
    await agent.routeLiveMessage(taskNotification('a-failed', 'failed'));

    expect(ended).toEqual(['a-stopped', 'a-completed', 'a-failed']);
    expect([agent.subagentEnded('a-stopped'), agent.subagentEnded('a-completed'), agent.subagentEnded('a-still-running')])
      .toEqual([true, true, false]);
  });

  it('CONTROL — a task that STARTED, progressed or had a non-terminal update is not an end', async () => {
    const agent = freshAgent() as unknown as SubagentOrigin;
    const ended: string[] = [];
    agent.onSubagentEnded = agentId => { ended.push(agentId); };

    await agent.routeLiveMessage({ type: 'system', subtype: 'task_started', task_id: 'a-1', tool_use_id: 'toolu_a', is_backgrounded: true, task_type: 'local_agent' });
    await agent.routeLiveMessage({ type: 'system', subtype: 'task_progress', task_id: 'a-1', tool_use_id: 'toolu_a' });
    await agent.routeLiveMessage({ type: 'system', subtype: 'task_notification', status: 'stopped' });

    expect(ended).toEqual([]);
    expect(agent.subagentEnded('a-1')).toBe(false);
  });
});
