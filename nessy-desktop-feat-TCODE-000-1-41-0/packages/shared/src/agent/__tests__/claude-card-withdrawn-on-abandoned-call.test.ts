/**
 * F1.541 (origin WJ-ar P-WJ-ar-3) — a claude permission card whose call the CLI ABANDONED leaves the host at once.
 *
 * ## The measurement this row asked for (vendored `claude` 2.1.267, SDK 0.3.267, WJ-bb's rig under `work/wjbb/`)
 *
 * A background subagent's Bash `rm -rf` in `default` mode raised our PreToolUse `host_gate` card; nobody answered it;
 * the host called `Query.stopTask` on that subagent. The CLI ABORTED the pending hook call — its `signal` fired 1 ms
 * after the stop — ended the task `stopped`, and recorded the call as rejected ("The user doesn't want to proceed with
 * this tool use"). Our side did nothing with that abort: the `case 'prompt'` branch never listens to the hook's
 * signal, so the pending entry was still there 12 s later and nothing withdrew the card. It would have stayed on
 * screen until F1.527's 540 s deadline, answering nothing. The `claude_native` card (`askToolApproval`) did listen —
 * it settled its promise on the abort — and withdrew nothing either, so its card stayed until a restart.
 *
 * ## What this file pins
 *
 * (a) The PreToolUse card: its hook call's signal aborting settles the wait (a deny the CLI no longer reads), removes
 *     the pending entry, and withdraws the card — through the host's out-of-turn channel when no turn is open.
 * (b) The native card, the same: its `canUseTool` signal aborting withdraws the card too, not only the promise.
 * (c) With a host turn open, the withdrawal rides that turn (the in-flight slot, as F1.527 routes an expiry).
 * CONTROL: an ANSWERED card whose signal aborts afterwards withdraws nothing — the answer already removed it.
 *
 * The rig is `claude-card-withdrawal-off-turn.test.ts`'s: a real `ClaudeAgent`, the SDK's `query` faked, and the REAL
 * PreToolUse hook and REAL `canUseTool` the turn registered, read back off the options the fake received.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md).
setDefaultTimeout(120_000);

const realSdk = { ...sdkPackage };

type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;
type HookMatcher = { hooks: HookFn[] };
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID?: string; requestId?: string; agentID?: string; suggestions?: unknown[] },
) => Promise<{ behavior: string; message?: string }>;

const scripts: Array<() => AsyncGenerator<unknown>> = [];
let capturedHooks: Record<string, HookMatcher[]> | undefined;
let capturedCanUseTool: CanUseTool | undefined;

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
    capturedCanUseTool = input.options.canUseTool as CanUseTool | undefined;
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

const WORKSPACE_ROOT = '/tmp/nessy-f1-541';

interface Internals {
  pendingPermissions: Map<string, unknown>;
}

interface HostDouble {
  raised: string[];
  withdrawnOffTurn: string[];
}

let counter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

function freshAgent(): { agent: InstanceType<typeof ClaudeAgent>; host: HostDouble; internals: Internals } {
  counter += 1;
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-541',
      name: 'F1.541',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1-541-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT,
      permissionMode: 'default',
    } as never,
  } as BackendConfig);
  liveAgent = agent;
  // The fixture's runtime is asserted rather than assumed (AGENTS.md, the 2026-09-20 fixture trap).
  expect(agent).toBeInstanceOf(ClaudeAgent);
  const host: HostDouble = { raised: [], withdrawnOffTurn: [] };
  // Exactly what SessionManager installs: the card reaches the screen, and the out-of-turn withdrawal channel.
  agent.onPermissionRequest = request => { host.raised.push(request.requestId); };
  agent.onPermissionRequestWithdrawn = requestId => { host.withdrawnOffTurn.push(requestId); };
  return { agent, host, internals: agent as unknown as Internals };
}

/** A host turn the test holds open (its result withheld) until `end()`. */
function heldTurn(): { end(): void; opened: Promise<void> } {
  let release!: () => void;
  let markOpened!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { markOpened = resolve; });
  scripts.push(async function* held() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-541', uuid: `u-init-${Math.random()}` };
    markOpened();
    await gate;
    yield resultMessage();
  });
  return { end: () => release(), opened };
}

function startTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  return (async () => {
    const events: AgentEvent[] = [];
    for await (const event of chatImpl(message)) events.push(event);
    return events;
  })();
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await tick(10);
  }
  throw new Error(`F1.541 rig: timed out waiting for ${label}`);
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still-pending'> {
  return Promise.race([promise, new Promise<'still-pending'>(resolve => setTimeout(() => resolve('still-pending'), ms))]);
}

/** The REAL PreToolUse hook, fired for a background subagent's destructive Bash call, with the CLI's own signal. */
function firePromptCard(toolUseId: string, signal: AbortSignal): Promise<unknown> {
  const hook = capturedHooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook) throw new Error('F1.541 rig: no PreToolUse hook was registered');
  return hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command: 'rm -rf /tmp/nessy-f1-541/scratch' },
    session_id: 'sdk-f1-541',
    transcript_path: '/tmp/f1-541.jsonl',
    cwd: WORKSPACE_ROOT,
    agent_id: 'a-background-f1-541',
    agent_type: 'general-purpose',
  }, toolUseId, { signal });
}

/** The REAL `canUseTool`: the SDK asking about a background subagent's call, with the CLI's own signal. */
function fireNativeCard(toolUseId: string, controlRequestId: string, signal: AbortSignal): Promise<{ behavior: string; message?: string }> {
  if (!capturedCanUseTool) throw new Error('F1.541 rig: no canUseTool was registered');
  return capturedCanUseTool('Bash', { command: 'rm -rf /tmp/nessy-f1-541/native' }, {
    signal,
    toolUseID: toolUseId,
    requestId: controlRequestId,
    agentID: 'a-background-f1-541',
  });
}

beforeEach(() => {
  scripts.length = 0;
  capturedHooks = undefined;
  capturedCanUseTool = undefined;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

/** Turn 1 runs and ends, so the hook and `canUseTool` are captured and no turn is open. */
async function betweenTurns(agent: InstanceType<typeof ClaudeAgent>): Promise<void> {
  await startTurn(agent, 'start a background subagent');
  expect(agent.isProcessing()).toBe(false);
}

describe('F1.541 — a card whose call the CLI abandoned leaves the host at once', () => {
  it('(a) PreToolUse card, no turn open: the hook signal aborting settles the wait and withdraws the card', async () => {
    const { agent, host, internals } = freshAgent();
    await betweenTurns(agent);
    const call = new AbortController();
    const hookAnswer = firePromptCard('toolu_f1541_prompt', call.signal);
    await until(() => host.raised.includes('perm-toolu_f1541_prompt'), 'the prompt card to reach the host');

    call.abort(); // what `Query.stopTask` on the raising subagent does to the pending hook call (measured)
    // THE DEFECT: the branch never listened to this signal, so the wait ran on to the 540 s deadline.
    expect(await within(hookAnswer.then(() => 'settled'), 1_000)).toBe('settled');
    expect(internals.pendingPermissions.has('perm-toolu_f1541_prompt')).toBe(false);
    expect(host.withdrawnOffTurn).toEqual(['perm-toolu_f1541_prompt']);
  });

  it('(b) native card, no turn open: the canUseTool signal aborting withdraws the card, not only the promise', async () => {
    const { agent, host, internals } = freshAgent();
    await betweenTurns(agent);
    const call = new AbortController();
    const nativeAnswer = fireNativeCard('toolu_f1541_native', 'req-f1541-native', call.signal);
    await until(() => host.raised.includes('perm-req-f1541-native'), 'the native card to reach the host');

    call.abort();
    const answer = await within(nativeAnswer, 1_000);
    expect(answer).not.toBe('still-pending');
    expect((answer as { behavior: string }).behavior).toBe('deny');
    expect(internals.pendingPermissions.has('perm-req-f1541-native')).toBe(false);
    // THE DEFECT: the promise settled, the card stayed on the host.
    expect(host.withdrawnOffTurn).toEqual(['perm-req-f1541-native']);
  });

  it('(c) with a host turn open, the withdrawal rides that turn', async () => {
    const { agent, host } = freshAgent();
    await betweenTurns(agent);
    const turn = heldTurn();
    const turnEvents = startTurn(agent, 'another message');
    await turn.opened;
    await until(() => agent.isProcessing(), 'the host turn\'s slot');

    const call = new AbortController();
    const hookAnswer = firePromptCard('toolu_f1541_in_turn', call.signal);
    await until(() => host.raised.includes('perm-toolu_f1541_in_turn'), 'the prompt card to reach the host');
    call.abort();
    expect(await within(hookAnswer.then(() => 'settled'), 1_000)).toBe('settled');

    turn.end();
    const events = await turnEvents;
    expect(events.filter(e => e.type === 'permission_request_cancelled').map(e => (e as { requestId?: string }).requestId))
      .toEqual(['perm-toolu_f1541_in_turn']);
    expect(host.withdrawnOffTurn).toEqual([]);
  });

  it('CONTROL — an answered card whose signal aborts afterwards withdraws nothing', async () => {
    const { agent, host, internals } = freshAgent();
    await betweenTurns(agent);
    const call = new AbortController();
    const hookAnswer = firePromptCard('toolu_f1541_answered', call.signal);
    await until(() => host.raised.includes('perm-toolu_f1541_answered'), 'the prompt card to reach the host');

    agent.respondToPermission('perm-toolu_f1541_answered', true);
    const answer = await within(hookAnswer, 1_000) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(answer.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(internals.pendingPermissions.has('perm-toolu_f1541_answered')).toBe(false);

    call.abort();
    await tick();
    expect(host.withdrawnOffTurn).toEqual([]);
  });
});
