/**
 * F1.527 (origin the 1.41.0 review, finding C-claude-runtime-1) — an EXPIRED claude permission card must leave the
 * host even when the turn it was raised in is gone.
 *
 * ## The defect, re-read at HEAD `f76861bec`
 *
 * F1.76 (the PreToolUse `case 'prompt'` card) and F1.169 (the `claude_native` card `canUseTool` raises) share one
 * withdrawal, `withdrawClaudeCard` (`backend/claude/permission-card-deadline.ts`): on expiry it deletes the pending
 * resolver, denies the tool with our sentence, and pushes `permission_request_cancelled` — ONLY onto the slot the
 * card captured when it was RAISED (`slot: this.openSlot`, evaluated once), and only while that slot is open. A card
 * outlives its turn whenever a BACKGROUND subagent raised it: turn N ends, nothing declines claude's own cards at a
 * turn's end, and 540 s later the deadline finds turn N's settled slot (or none, for a card raised between turns) and
 * pushes nothing. The host keeps the record and the durable `pendingApproval`, the card stays on screen (and comes
 * back after a restart), and the user's Allow reaches a resolver that is gone — while the model was already told the
 * card was withdrawn. The same miss happens when turn N+1 is open at that moment: only the stale slot is consulted.
 *
 * The host has had the channel for exactly this since F1.369: `onPermissionRequestWithdrawn`, which
 * `SessionManager.wireOutOfTurnCardWithdrawal` routes into the SAME `processEvent` arm the in-turn event takes, and
 * `ClaudeAgent.withdrawElicitationDialog` already chooses between the turn in flight and that channel for F1.220's
 * question dialogs. This path never used it.
 *
 * ## The instrument
 *
 * `claude-subagent-tool-origin.test.ts`'s rig: a real `ClaudeAgent`, the SDK's `query` faked, and the REAL PreToolUse
 * hook and REAL `canUseTool` the turn registered, read back off the options the fake received — so both production
 * call sites are driven, not re-implemented. The host is played by exactly what `SessionManager` installs on an
 * agent: `onPermissionRequest` (the card reaches the screen) and `onPermissionRequestWithdrawn` (the out-of-turn
 * channel). The 540 s budget is the agent's `permissionCardBudgetMs`, shortened here as the module's own suite
 * shortens `budgetMs`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { CLAUDE_PERMISSION_CARD_DEADLINE_MS, claudePermissionCardTimeoutNotice } from '../backend/claude/permission-card-deadline.ts';

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

const WORKSPACE_ROOT = '/tmp/nessy-f1-527';
const BUDGET_MS = 60;

interface Internals {
  pendingPermissions: Map<string, unknown>;
  permissionCardBudgetMs?: number;
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
      id: 'ws-f1-527',
      name: 'F1.527',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1-527-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT,
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
  const internals = agent as unknown as Internals;
  internals.permissionCardBudgetMs = BUDGET_MS;
  return { agent, host, internals };
}

/** A host turn the test holds open (its result withheld) until `end()`. */
function heldTurn(): { end(): void; opened: Promise<void> } {
  let release!: () => void;
  let markOpened!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { markOpened = resolve; });
  scripts.push(async function* held() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-527', uuid: `u-init-${Math.random()}` };
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
  throw new Error(`F1.527 rig: timed out waiting for ${label}`);
}

/**
 * The REAL PreToolUse hook the turn registered, fired for a background subagent's Bash call — the shape the review's
 * trigger names (`agent_id` set). In `default` mode a destructive command is a `case 'prompt'` card.
 */
function firePromptCard(toolUseId: string): Promise<unknown> {
  const hook = capturedHooks?.PreToolUse?.[0]?.hooks?.[0];
  if (!hook) throw new Error('F1.527 rig: no PreToolUse hook was registered');
  return hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command: 'rm -rf /tmp/nessy-f1-527/scratch' },
    session_id: 'sdk-f1-527',
    transcript_path: '/tmp/f1-527.jsonl',
    cwd: WORKSPACE_ROOT,
    agent_id: 'a-background-f1-527',
    agent_type: 'general-purpose',
  }, toolUseId, { signal: new AbortController().signal });
}

/**
 * The REAL `canUseTool` the turn registered: the SDK asking about a call no gate approved — a `claude_native` card,
 * here a background subagent's (`agentID`). Its card id is `perm-<the control request's id>`.
 */
function fireNativeCard(toolUseId: string, controlRequestId: string): Promise<{ behavior: string; message?: string }> {
  if (!capturedCanUseTool) throw new Error('F1.527 rig: no canUseTool was registered');
  return capturedCanUseTool('Bash', { command: 'rm -rf /tmp/nessy-f1-527/native' }, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: controlRequestId,
    agentID: 'a-background-f1-527',
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

const notice = claudePermissionCardTimeoutNotice('Bash', BUDGET_MS);

describe('F1.527 — an expired card whose turn is gone still leaves the host', () => {
  it('(a) PreToolUse card raised in turn N, expiring with NO turn open: the host\'s out-of-turn channel removes it', async () => {
    const { agent, host, internals } = freshAgent();
    const turnN = heldTurn();
    const turnNEvents = startTurn(agent, 'start a background subagent');
    await turnN.opened;
    await until(() => agent.isProcessing(), 'turn N\'s slot');

    const hookAnswer = firePromptCard('toolu_f1527_prompt');
    await until(() => host.raised.includes('perm-toolu_f1527_prompt'), 'the prompt card to reach the host');

    turnN.end();
    const eventsN = await turnNEvents;
    expect(agent.isProcessing()).toBe(false);

    const answer = await hookAnswer as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    // The model was told the card was withdrawn (F1.76's sentence) ...
    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain(notice);
    expect(internals.pendingPermissions.has('perm-toolu_f1527_prompt')).toBe(false);
    // ... and THE DEFECT: nothing told the host. Turn N's slot had settled, so the cancellation had nowhere to go.
    expect(host.withdrawnOffTurn).toEqual(['perm-toolu_f1527_prompt']);
    expect(eventsN.some(e => e.type === 'permission_request_cancelled')).toBe(false);
  });

  it('(b) native card raised in turn N, expiring while turn N+1 is open: the cancellation rides the turn in flight', async () => {
    const { agent, host, internals } = freshAgent();
    // Long enough that turn N ends and turn N+1 opens first — asserted below, so a slow box fails loudly here
    // instead of measuring the no-turn shape (a) already covers.
    internals.permissionCardBudgetMs = 1_500;
    const turnN = heldTurn();
    const turnNEvents = startTurn(agent, 'start a background subagent');
    await turnN.opened;
    await until(() => agent.isProcessing(), 'turn N\'s slot');

    const requestId = 'perm-req-f1527-native';
    let answeredEarly = false;
    const nativeAnswer = fireNativeCard('toolu_f1527_native', 'req-f1527-native');
    void nativeAnswer.then(() => { answeredEarly = true; });
    await until(() => host.raised.includes(requestId), 'the native card to reach the host');

    turnN.end();
    await turnNEvents;
    const turnN1 = heldTurn();
    const turnN1Events = startTurn(agent, 'the user\'s next message');
    await turnN1.opened;
    await until(() => agent.isProcessing(), 'turn N+1\'s slot');
    expect(answeredEarly).toBe(false); // the card is still up while turn N+1 runs — the shape this arm measures

    const answer = await nativeAnswer;
    expect(answer.behavior).toBe('deny');
    expect(answer.message).toContain(claudePermissionCardTimeoutNotice('Bash', 1_500));
    expect(internals.pendingPermissions.has(requestId)).toBe(false);

    turnN1.end();
    const eventsN1 = await turnN1Events;
    // THE DEFECT's second shape: only turn N's settled slot was consulted, so turn N+1 never carried it.
    const cancelled = eventsN1.filter(e => e.type === 'permission_request_cancelled').map(e => (e as { requestId?: string }).requestId);
    expect(cancelled).toEqual([requestId]);
    expect(host.withdrawnOffTurn).toEqual([]);
  });

  it('CONTROL — a card that expires inside its OWN turn still rides that turn, and the out-of-turn channel hears nothing', async () => {
    const { agent, host, internals } = freshAgent();
    const turnN = heldTurn();
    const turnNEvents = startTurn(agent, 'one turn');
    await turnN.opened;
    await until(() => agent.isProcessing(), 'turn N\'s slot');

    await firePromptCard('toolu_f1527_inturn');
    expect(internals.pendingPermissions.has('perm-toolu_f1527_inturn')).toBe(false);
    turnN.end();
    const events = await turnNEvents;
    const cancelled = events.filter(e => e.type === 'permission_request_cancelled').map(e => (e as { requestId?: string }).requestId);
    expect(cancelled).toEqual(['perm-toolu_f1527_inturn']);
    expect(host.withdrawnOffTurn).toEqual([]);
  });

  it('CONTROL — an ANSWERED card withdraws nothing anywhere, even after its turn ended', async () => {
    const { agent, host, internals } = freshAgent();
    internals.permissionCardBudgetMs = 5_000;
    const turnN = heldTurn();
    const turnNEvents = startTurn(agent, 'one turn');
    await turnN.opened;
    await until(() => agent.isProcessing(), 'turn N\'s slot');

    const hookAnswer = firePromptCard('toolu_f1527_answered');
    await until(() => host.raised.includes('perm-toolu_f1527_answered'), 'the prompt card to reach the host');
    turnN.end();
    await turnNEvents;
    agent.respondToPermission('perm-toolu_f1527_answered', true);
    const answer = await hookAnswer as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(answer.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    await tick(50);
    expect(host.withdrawnOffTurn).toEqual([]);
  });

  it('production takes F1.76\'s budget: the agent\'s default is the named constant', () => {
    const agent = new ClaudeAgent({
      provider: 'anthropic', providerType: 'anthropic', model: 'claude-sonnet-4-6', isHeadless: true, skipConfigWatcher: true,
      workspace: { id: 'ws-f1-527-b', name: 'F1.527', rootPath: WORKSPACE_ROOT, workspaceRootPath: WORKSPACE_ROOT, sessionRootPath: `${WORKSPACE_ROOT}/sessions` } as never,
      session: { id: 'session-f1-527-budget', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT } as never,
    } as BackendConfig);
    try {
      expect((agent as unknown as Internals).permissionCardBudgetMs).toBe(CLAUDE_PERMISSION_CARD_DEADLINE_MS);
    } finally {
      agent.destroy();
    }
  });
});
