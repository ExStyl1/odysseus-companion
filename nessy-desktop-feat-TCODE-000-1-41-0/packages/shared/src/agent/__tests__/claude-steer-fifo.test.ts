/**
 * F1.238 — Claude mid-turn steering is a FIFO, delivered in order and handed
 * back by id.
 *
 * Measured at HEAD before this row (`claude-agent.ts`): `redirect()` ASSIGNED
 * one string slot (`pendingSteerMessage = message`) and answered `true` every
 * time, so a second steer in one turn overwrote the first while both showed as
 * delivered; the PreToolUse hook consumed that one string BEFORE its verdict;
 * Stop (`cancelTurnScopedUi`) and a handoff (`interruptForHandoff`) nulled the
 * slot with no `steer_undelivered`; and the event carried the text only, so the
 * host re-queued it under the OLDEST id on a list nothing popped.
 *
 * Reference: craft-agents-oss v0.13.4 `PendingSteers`
 * (`packages/shared/src/agent/backend/claude/pending-steers.ts`, Apache-2.0,
 * #1040): drained in order at a PreToolUse boundary ("Address them in order",
 * "Message 1..n"), `steer_undelivered` per steer carrying its own message id,
 * `takePendingSteers()` for the host.
 *
 * The first three arms drive a REAL `chatImpl` turn with the SDK's `query`
 * faked (the `claude-slash-command-seam.test.ts` rig), and the tool boundary is
 * the REAL PreToolUse hook `chatImpl` registered, read back off the options the
 * fake `query` received — nothing stubs the consume.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@nessy-agent/core/types';
import { AbortReason, type BackendConfig } from '../backend/types.ts';

const realSdk = { ...sdkPackage };

type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;
type HookMatcher = { hooks: HookFn[] };

const scripts: Array<(prompt: string) => AsyncGenerator<unknown>> = [];
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

function promptTextOf(message: unknown): string {
  const content = (message as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: string }).type === 'text')
    .map(block => block.text)
    .join('\n');
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedHooks = input.options.hooks as Record<string, HookMatcher[]> | undefined;
    if (typeof input.prompt === 'string') {
      const script = scripts.shift() ?? plainSuccess;
      return script(input.prompt);
    }
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const script = scripts.shift() ?? plainSuccess;
        yield* script(promptTextOf(next.value));
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

const { ClaudeAgent, buildClaudePreToolUseContinue } = await import('../claude-agent.ts');

const WORKSPACE_ID = 'ws-f1-238';
const WORKSPACE_ROOT = '/tmp/nessy-f1-238';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.238',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: sessionId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: WORKSPACE_ROOT,
    } as never,
  } as BackendConfig;
}

type Steering = {
  redirect(message: string, metadata?: { messageId?: string }): boolean;
  takePendingSteers(): Array<{ message: string; messageId?: string }>;
  interruptForHandoff(reason: AbortReason): void;
};

async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

/**
 * Fire every PreToolUse hook the turn registered, as the CLI would for one allowed Read.
 * `extra` adds hook-input fields — F1.342 passes `agent_id` to fire it as a SUBAGENT's call.
 */
async function firePreToolUse(extra: Record<string, unknown> = {}): Promise<string[]> {
  const matchers = capturedHooks?.PreToolUse ?? [];
  const contexts: string[] = [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const answer = await Promise.race([
        hook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_use_id: 'toolu_f1_238',
          tool_input: { file_path: `${WORKSPACE_ROOT}/README.md` },
          session_id: 'sdk-session',
          transcript_path: '/tmp/f1-238.jsonl',
          cwd: WORKSPACE_ROOT,
          ...extra,
        }, 'toolu_f1_238', { signal: new AbortController().signal }),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('PreToolUse hook did not answer (a permission card?)')), 3_000)),
      ]) as { hookSpecificOutput?: { additionalContext?: string } } | undefined;
      const context = answer?.hookSpecificOutput?.additionalContext;
      if (context) contexts.push(context);
    }
  }
  return contexts;
}

function steersOf(events: AgentEvent[]): Array<{ message: string; messageId?: string }> {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'steer_undelivered' }> => event.type === 'steer_undelivered')
    .map(event => ({ message: event.message, ...(('messageId' in event && event.messageId !== undefined) ? { messageId: event.messageId } : {}) }));
}

let counter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

beforeEach(() => {
  scripts.length = 0;
  capturedHooks = undefined;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

function freshAgent(): InstanceType<typeof ClaudeAgent> {
  counter += 1;
  liveAgent = new ClaudeAgent(agentConfig(`session-f1-238-${counter}`));
  return liveAgent;
}

describe('F1.238 — a real Claude turn', () => {
  it('two steers followed by a tool call BOTH reach additionalContext, in order', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let contexts: string[] = [];
    scripts.push(async function* turnWithToolCall() {
      expect(steering.redirect('first: use the v2 endpoint', { messageId: 'msg-a' })).toBe(true);
      expect(steering.redirect('second: and keep the old one as a fallback', { messageId: 'msg-b' })).toBe(true);
      contexts = await firePreToolUse();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    const joined = contexts.join('\n');
    const first = joined.indexOf('first: use the v2 endpoint');
    const second = joined.indexOf('second: and keep the old one as a fallback');
    // THE DEFECT: the second assignment overwrote the first, so `first` was lost.
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(joined).toContain('Message 1:');
    expect(joined).toContain('Message 2:');
    // Delivered, so nothing comes back at the turn's end.
    expect(steersOf(events)).toEqual([]);
  });

  it('two steers and NO tool call come back as two steer_undelivered, in order, each under its own id', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    scripts.push(async function* plainTurn() {
      steering.redirect('first correction', { messageId: 'msg-a' });
      steering.redirect('second correction', { messageId: 'msg-b' });
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(steersOf(events)).toEqual([
      { message: 'first correction', messageId: 'msg-a' },
      { message: 'second correction', messageId: 'msg-b' },
    ]);
  });

  it('a HANDOFF keeps the accepted steers for the host, in order, and the turn then hands back nothing twice', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let taken: Array<{ message: string; messageId?: string }> = [];
    scripts.push(async function* handoffTurn() {
      steering.redirect('first correction', { messageId: 'msg-a' });
      steering.redirect('second correction', { messageId: 'msg-b' });
      steering.interruptForHandoff(AbortReason.PlanSubmitted);
      taken = steering.takePendingSteers();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(taken).toEqual([
      { message: 'first correction', messageId: 'msg-a' },
      { message: 'second correction', messageId: 'msg-b' },
    ]);
    expect(steersOf(events)).toEqual([]);
  });

  it('CONTROL — a single steer with a tool call is worded exactly as it always was', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let contexts: string[] = [];
    scripts.push(async function* oneSteer() {
      steering.redirect('use the other API', { messageId: 'msg-a' });
      contexts = await firePreToolUse();
      yield resultMessage();
    });

    await runTurn(agent, 'do the work');

    expect(contexts.join('\n')).toContain(
      'The user just sent a new message while you were working. Stop what you are currently doing and address their message instead:\n\nuse the other API',
    );
  });
});

describe('F1.342 — a steer is for the MAIN thread, never a subagent', () => {
  // agent-sdk/hooks.md and the vendored sdk.d.ts (`BaseHookInput.agent_id`): "Present only
  // when the hook fires from within a subagent … Absent for the main thread, even in --agent
  // sessions. Use this field (not agent_type) to distinguish subagent calls from main-thread
  // calls." Measured before this row (work/wj-gg-verify/probe-subagent-drain.test.ts): the
  // subagent's first PreToolUse took the steer and the main thread's context was [].
  const STEER = 'stop, use the v2 endpoint';

  it('a SUBAGENT tool call leaves the steer queued; the next MAIN-thread call carries it', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let subagentContexts: string[] = [];
    let mainContexts: string[] = [];
    scripts.push(async function* subagentThenMain() {
      expect(steering.redirect(STEER, { messageId: 'msg-a' })).toBe(true);
      subagentContexts = await firePreToolUse({ agent_id: 'agent-sub-1', agent_type: 'general-purpose' });
      mainContexts = await firePreToolUse();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(subagentContexts.join('\n')).not.toContain(STEER);
    expect(mainContexts.join('\n')).toContain(STEER);
    expect(steersOf(events)).toEqual([]);
  });

  it('a turn whose only tool calls are a subagent\'s hands the steer back at its end, under its own id', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let subagentContexts: string[] = [];
    scripts.push(async function* subagentOnly() {
      steering.redirect(STEER, { messageId: 'msg-a' });
      subagentContexts = await firePreToolUse({ agent_id: 'agent-sub-1', agent_type: 'general-purpose' });
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(subagentContexts.join('\n')).not.toContain(STEER);
    expect(steersOf(events)).toEqual([{ message: STEER, messageId: 'msg-a' }]);
  });

  it('CONTROL — agent_type WITHOUT agent_id is the main thread of an --agent session, and still delivers', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let contexts: string[] = [];
    scripts.push(async function* agentSessionMainThread() {
      steering.redirect(STEER, { messageId: 'msg-a' });
      contexts = await firePreToolUse({ agent_type: 'code-reviewer' });
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(contexts.join('\n')).toContain(STEER);
    expect(steersOf(events)).toEqual([]);
  });
});

describe('F1.238 — the pieces, on a bare prototype', () => {
  function bareAgent(): Steering & Record<string, unknown> {
    const agent = Object.create(ClaudeAgent.prototype) as Steering & Record<string, unknown>;
    agent.pendingSteers = [];
    agent.debug = () => undefined;
    agent.openSlot = { settled: false };
    return agent;
  }

  it('a Stop (cancelTurnScopedUi) no longer drops an accepted steer', () => {
    const agent = bareAgent();
    agent.modelQuestionAsk = { cancelAll: () => undefined };
    agent.cancelPendingPermissions = () => undefined;
    agent.runTeardownStep = (_label: string, step: () => void) => step();
    agent.redirect('keep me', { messageId: 'msg-a' });

    (agent as unknown as { cancelTurnScopedUi(reason: string): void }).cancelTurnScopedUi('stopped');

    expect(agent.takePendingSteers()).toEqual([{ message: 'keep me', messageId: 'msg-a' }]);
    // Taken means gone: a second take (or the turn's own `finally`) finds nothing.
    expect(agent.takePendingSteers()).toEqual([]);
  });

  it('a DEFERRED PreToolUse answer does not swallow the steers; an allow then carries them', () => {
    const agent = bareAgent();
    agent.redirect('still here', { messageId: 'msg-a' });
    const deliver = (agent as unknown as {
      deliverPendingSteersOn(base: ReturnType<typeof buildClaudePreToolUseContinue>): ReturnType<typeof buildClaudePreToolUseContinue>;
    }).deliverPendingSteersOn.bind(agent);

    const deferred = deliver(buildClaudePreToolUseContinue({ hookDecision: 'defer' }))() as {
      hookSpecificOutput?: { additionalContext?: string; permissionDecision?: string };
    };
    expect(deferred.hookSpecificOutput?.permissionDecision).toBe('defer');
    expect(deferred.hookSpecificOutput?.additionalContext).toBeUndefined();

    const allowed = deliver(buildClaudePreToolUseContinue({ additionalContext: 'hook context' }))() as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    // F1.344 — the steer FIRST, the hook's own context after it (was: hook context first).
    expect(allowed.hookSpecificOutput?.additionalContext).toBe(
      'The user just sent a new message while you were working. Stop what you are currently doing and address their message instead:\n\nstill here\n\nhook context',
    );
    expect(agent.takePendingSteers()).toEqual([]);
  });
});

describe('F1.343 — a steer carries its ORIGIN through both hand-back doors', () => {
  // A plugin monitor's delivery (`armPluginPeripherals`) calls `redirect(text)` into
  // the live turn; before this row the FIFO kept only `{ message, messageId }`, so a
  // monitor text handed back at a Stop, a handoff or the turn's end was
  // indistinguishable from the user's own steer, and the host queued it as a NEW
  // user message holding plugin output (WJ-gg verifier, probe-host-doors case 1).
  type OriginSteering = {
    redirect(message: string, metadata?: { messageId?: string; origin?: 'monitor' }): boolean;
    takePendingSteers(): Array<{ message: string; messageId?: string; origin?: 'monitor' }>;
  };
  function handedBack(events: AgentEvent[]): Array<Record<string, unknown>> {
    return events
      .filter(event => event.type === 'steer_undelivered')
      .map(event => {
        const { type: _type, ...rest } = event as Record<string, unknown>;
        return rest;
      });
  }

  it('the turn-end hand-back names a monitor steer as one, and leaves a user steer unmarked', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as OriginSteering;
    scripts.push(async function* plainTurn() {
      steering.redirect('<monitor> build failed on main', { origin: 'monitor' });
      steering.redirect('user correction', { messageId: 'msg-a' });
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(handedBack(events)).toEqual([
      { message: '<monitor> build failed on main', origin: 'monitor' },
      { message: 'user correction', messageId: 'msg-a' },
    ]);
  });

  it('takePendingSteers (the Stop / handoff / complete door) returns the origin too', () => {
    const agent = Object.create(ClaudeAgent.prototype) as OriginSteering & Record<string, unknown>;
    agent.pendingSteers = [];
    agent.debug = () => undefined;
    agent.openSlot = { settled: false };
    agent.redirect('<monitor> deploy 42 failed', { origin: 'monitor' });
    agent.redirect('user correction', { messageId: 'msg-a' });

    expect(agent.takePendingSteers()).toEqual([
      { message: '<monitor> deploy 42 failed', origin: 'monitor' },
      { message: 'user correction', messageId: 'msg-a' },
    ]);
  });
});

describe('F1.335 — a paused FIFO and a stale hook deliver nothing (upstream PendingSteers.pause + generation)', () => {
  // Ported from craft-agents-oss v0.13.4 `PendingSteers` (Apache-2.0): `pause()` invalidates
  // "hooks suspended in permission/source awaits", and a paused FIFO accepts nothing. Before
  // this row a PreToolUse hook still awaiting from an EARLIER turn drained whatever the LATER
  // turn had queued into an answer for a tool call that turn never made.
  it('a PreToolUse hook suspended in an EARLIER turn does not drain a later turn\'s steer; the later turn\'s own call carries it', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let holdPreToolUse = true;
    let releaseOldHook!: () => void;
    const oldHookGate = new Promise<undefined>(resolve => { releaseOldHook = () => resolve(undefined); });
    (agent as unknown as { setAutomationSystem(system: unknown): void }).setAutomationSystem({
      executeAgentEvent: async (event: string) => (event === 'PreToolUse' && holdPreToolUse ? oldHookGate : undefined),
    });
    let oldHook: Promise<string[]> | undefined;
    scripts.push(async function* turnOne() {
      // Suspended inside the automation pipeline — an await, as a permission or source card would be.
      oldHook = firePreToolUse();
      await new Promise(resolve => setTimeout(resolve, 0));
      // The Stop: the host takes the FIFO first (`recoverPendingSteers`), then the turn ends.
      steering.takePendingSteers();
      yield resultMessage();
    });
    await runTurn(agent, 'turn one');

    holdPreToolUse = false;
    let staleContexts: string[] = [];
    let liveContexts: string[] = [];
    scripts.push(async function* turnTwo() {
      expect(steering.redirect('turn two steer', { messageId: 'msg-b' })).toBe(true);
      releaseOldHook();
      staleContexts = await oldHook!;
      liveContexts = await firePreToolUse();
      yield resultMessage();
    });
    const events = await runTurn(agent, 'turn two');

    // THE DEFECT: the stale answer carried it, so the new turn's own tool call had nothing.
    expect(staleContexts.join('\n')).not.toContain('turn two steer');
    expect(liveContexts.join('\n')).toContain('turn two steer');
    expect(steersOf(events)).toEqual([]);
  });

  it('after the host TAKES (a Stop, a handoff, the turn\'s complete) redirect refuses — and the refusal aborts nothing', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let aborts = 0;
    let refusedAnswer: boolean | undefined;
    scripts.push(async function* stoppedTurn() {
      steering.takePendingSteers();
      const realForceAbort = (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort;
      (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort = () => { aborts += 1; };
      refusedAnswer = steering.redirect('sent into a stopping turn', { messageId: 'msg-late' });
      (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort = realForceAbort;
      yield resultMessage();
    });
    const events = await runTurn(agent, 'turn one');

    // `false` hands the message back to the host synchronously, which queues it.
    expect(refusedAnswer).toBe(false);
    // Our fallback abort is `killLiveSession` (L2): a paused refusal must not reach it.
    expect(aborts).toBe(0);
    expect(steersOf(events)).toEqual([]);

    // CONTROL — the next turn opens the FIFO again.
    scripts.push(async function* nextTurn() {
      expect(steering.redirect('next turn steer', { messageId: 'msg-n' })).toBe(true);
      yield resultMessage();
    });
    const next = await runTurn(agent, 'turn two');
    expect(steersOf(next)).toEqual([{ message: 'next turn steer', messageId: 'msg-n' }]);
  });
});

describe('F1.344 — the steers ride AHEAD of the hook and rule context', () => {
  // hooks.md: a hook's `additionalContext` is "capped at 10,000 characters"; over it Claude
  // Code "replaces it with the file path and a preview of up to the first 2,000 characters"
  // and "doesn't ask Claude to read the file". Before this row the steers were joined AFTER
  // the hook's context and the path-scoped rule bodies, so a long rule pushed the user's
  // correction out of the preview while the host counted it delivered.
  const STEER = 'stop, use the v2 endpoint instead';

  it('with a 9 000-character path-scoped rule and 2 000 characters of hook context, the steer sits inside the first 2 000 characters', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    const rule = `RULE-START ${'r'.repeat(9_000)}`;
    const hookContext = `HOOK-START ${'h'.repeat(2_000)}`;
    (agent as unknown as { consumePendingPathScopedRuleContext(): string | undefined }).consumePendingPathScopedRuleContext = () => rule;
    (agent as unknown as { setAutomationSystem(system: unknown): void }).setAutomationSystem({
      executeAgentEvent: async (event: string) => (event === 'PreToolUse' ? { decision: { additionalContext: hookContext } } : undefined),
    });
    let contexts: string[] = [];
    scripts.push(async function* longRuleTurn() {
      steering.redirect(STEER, { messageId: 'msg-a' });
      contexts = await firePreToolUse();
      yield resultMessage();
    });

    await runTurn(agent, 'do the work');

    const context = contexts.join('\n');
    expect(context.length).toBeGreaterThan(10_000); // CONTROL: this answer is over the cap
    const at = context.indexOf(STEER);
    expect(at).toBeGreaterThan(-1);
    // THE DEFECT: the steer sat past 11 000 characters, outside the 2 000-character preview.
    expect(at + STEER.length).toBeLessThanOrEqual(2_000);
    // Nothing is dropped: the hook's context and the rule still ride the same answer.
    expect(context).toContain(hookContext);
    expect(context).toContain(rule);
  });
});

describe('F1.345 — a BLOCKED or DENIED call leaves the steers queued, through the REAL PreToolUse hook', () => {
  // F1.238's sentence — "a deferred, blocked or denied call leaves them queued" — was pinned
  // for defer only, on the wrapper alone. These fire the REAL hook for each verdict that must
  // not carry the steer, then prove the steer was not lost: the turn hands it back under its
  // own id. The mutation control (the old consume-before-verdict put back in the hook body)
  // fails every arm here.
  const STEER = 'stop, the deploy is frozen';

  async function verdictTurn(
    agent: InstanceType<typeof ClaudeAgent>,
    fire: () => Promise<string[]>,
  ): Promise<{ contexts: string[]; events: AgentEvent[] }> {
    const steering = agent as unknown as Steering;
    let contexts: string[] = [];
    scripts.push(async function* verdictOnly() {
      steering.redirect(STEER, { messageId: 'msg-a' });
      contexts = await fire();
      yield resultMessage();
    });
    const events = await runTurn(agent, 'do the work');
    return { contexts, events };
  }

  it('a trusted PreToolUse hook that BLOCKS', async () => {
    const agent = freshAgent();
    (agent as unknown as { setAutomationSystem(system: unknown): void }).setAutomationSystem({
      executeAgentEvent: async (event: string) => (event === 'PreToolUse' ? { decision: { decision: 'block', reason: 'frozen' } } : undefined),
    });
    const { contexts, events } = await verdictTurn(agent, () => firePreToolUse());
    expect(contexts.join('\n')).not.toContain(STEER);
    expect(steersOf(events)).toEqual([{ message: STEER, messageId: 'msg-a' }]);
  });

  it('a host permission card the user DENIES', async () => {
    const agent = freshAgent();
    const cards: string[] = [];
    (agent as unknown as { onPermissionRequest: (request: { requestId: string }) => void }).onPermissionRequest = request => {
      cards.push(request.requestId);
      (agent as unknown as { respondToPermission(requestId: string, allowed: boolean): void }).respondToPermission(request.requestId, false);
    };
    const { contexts, events } = await verdictTurn(agent, () => firePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/nessy-f1-345-scratch' },
    }));
    expect(cards).toHaveLength(1); // CONTROL: a card was really raised and answered
    expect(contexts.join('\n')).not.toContain(STEER);
    expect(steersOf(events)).toEqual([{ message: STEER, messageId: 'msg-a' }]);
  });

  it('a source-activation DENY (an MCP tool of a source this session cannot use)', async () => {
    const agent = freshAgent();
    const { contexts, events } = await verdictTurn(agent, () => firePreToolUse({
      tool_name: 'mcp__nessy-f1-345-absent__list_issues',
      tool_input: {},
    }));
    expect(contexts.join('\n')).not.toContain(STEER);
    expect(steersOf(events)).toEqual([{ message: STEER, messageId: 'msg-a' }]);
  });
});

describe('F1.485 — a plugin monitor\'s steer is not worded as the user\'s message', () => {
  // A scheduled plugin monitor steers the live turn through `redirect(text, { origin:
  // 'monitor' })` (`armPluginPeripherals`), and the host frames that text as a background
  // task notification BEFORE the call, the same framing on all three runtimes. Before this
  // row the tool-boundary drain still put it under "The user just sent a new message while
  // you were working…", presenting plugin output to the model as the user's words.
  const MONITOR_NOTICE = '<system-reminder>The block below is a background task notification delivered by the host: no human input has occurred.</system-reminder>\n<task-notification>\nPlugin monitor deploy-status:\ndeploy 42 failed\n</task-notification>';
  const USER_LEAD = 'The user just sent a new message while you were working. Stop what you are currently doing and address their message instead:';

  function bareAgent(): { redirect(message: string, metadata?: { messageId?: string; origin?: 'monitor' }): boolean; takePendingSteers(): unknown[] } & Record<string, unknown> {
    const agent = Object.create(ClaudeAgent.prototype) as ReturnType<typeof bareAgent>;
    agent.pendingSteers = [];
    agent.debug = () => undefined;
    agent.openSlot = { settled: false };
    return agent;
  }
  function drain(agent: ReturnType<typeof bareAgent>, hookContext?: string): string | undefined {
    const deliver = (agent as unknown as {
      deliverPendingSteersOn(base: ReturnType<typeof buildClaudePreToolUseContinue>): ReturnType<typeof buildClaudePreToolUseContinue>;
    }).deliverPendingSteersOn.bind(agent);
    const answer = deliver(buildClaudePreToolUseContinue(hookContext === undefined ? {} : { additionalContext: hookContext }))() as {
      hookSpecificOutput?: { additionalContext?: string };
    };
    return answer.hookSpecificOutput?.additionalContext;
  }

  it('a REAL turn: a monitor steer at a tool boundary rides as the host framed it, never under the user\'s sentence', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as { redirect(message: string, metadata?: { origin?: 'monitor' }): boolean };
    let contexts: string[] = [];
    scripts.push(async function* monitorTurn() {
      expect(steering.redirect(MONITOR_NOTICE, { origin: 'monitor' })).toBe(true);
      contexts = await firePreToolUse();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    const context = contexts.join('\n');
    expect(context).toContain(MONITOR_NOTICE); // CONTROL: it was delivered at this boundary
    // THE DEFECT: "The user just sent a new message while you were working. Stop what you are …"
    expect(context).not.toContain('The user');
    expect(steersOf(events)).toEqual([]);
  });

  it('a monitor steer alone is the whole steer context, ahead of the hook\'s own', () => {
    const agent = bareAgent();
    agent.redirect(MONITOR_NOTICE, { origin: 'monitor' });

    expect(drain(agent, 'hook context')).toBe(`${MONITOR_NOTICE}\n\nhook context`);
  });

  it('mixed in one drain: the user\'s steers keep their exact sentence and count, and the monitor\'s text follows them', () => {
    const agent = bareAgent();
    agent.redirect(MONITOR_NOTICE, { origin: 'monitor' });
    agent.redirect('use the v2 endpoint', { messageId: 'msg-a' });

    // One USER message, so the one-message sentence — not "The user sent 2 new messages".
    expect(drain(agent)).toBe(`${USER_LEAD}\n\nuse the v2 endpoint\n\n${MONITOR_NOTICE}`);
  });

  it('CONTROL — user steers alone are worded byte for byte as before (one, and two numbered)', () => {
    const one = bareAgent();
    one.redirect('use the other API', { messageId: 'msg-a' });
    expect(drain(one)).toBe(`${USER_LEAD}\n\nuse the other API`);

    const two = bareAgent();
    two.redirect('first', { messageId: 'msg-a' });
    two.redirect('second', { messageId: 'msg-b' });
    expect(drain(two)).toBe(
      'The user sent 2 new messages while you were working. Stop what you are currently doing and address them, in order:'
      + '\n\nMessage 1:\nfirst\n\nMessage 2:\nsecond',
    );
  });
});

describe('F1.487 (P-WJqqa-3) — a steer that the preview would cut waits for a boundary that carries it whole', () => {
  // hooks.md: over 10,000 characters an `additionalContext` becomes "the file path and a preview
  // of up to the first 2,000 characters", and Claude Code "doesn't ask Claude to read the file".
  // F1.344 put the steers FIRST, which keeps a short steer inside that preview; a steer block
  // longer than the preview was still cut when the whole answer went over the cap. Such a block
  // now stays queued: a later tool boundary whose answer fits carries it, or the turn hands it
  // back whole (`steer_undelivered`) and the host sends it as the next message.
  const LONG_STEER = `LONG-STEER-START ${'s'.repeat(3_000)} LONG-STEER-END`;
  const RULE = `RULE-START ${'r'.repeat(9_000)}`;

  function withRuleOnFirstBoundaryOnly(agent: InstanceType<typeof ClaudeAgent>): void {
    let served = false;
    (agent as unknown as { consumePendingPathScopedRuleContext(): string | undefined }).consumePendingPathScopedRuleContext = () => {
      if (served) return undefined;
      served = true;
      return RULE;
    };
  }

  it('a 9 000-character rule + a 3 000-character steer: the over-cap boundary does not cut it, and the turn hands it back WHOLE', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    withRuleOnFirstBoundaryOnly(agent);
    let contexts: string[] = [];
    scripts.push(async function* longSteerTurn() {
      steering.redirect(LONG_STEER, { messageId: 'msg-long' });
      contexts = await firePreToolUse();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    const context = contexts.join('\n');
    expect(context).toContain(RULE); // the rule still rides its boundary
    // THE DEFECT: the steer rode an over-cap answer, so the model saw its first ~2 000 characters.
    expect(context.includes(LONG_STEER) && context.length > 10_000).toBe(false);
    // …and nothing of it is lost: the turn hands the whole text back under its own id.
    expect(steersOf(events)).toEqual([{ message: LONG_STEER, messageId: 'msg-long' }]);
  });

  it('a later boundary whose answer fits the cap carries the same steer whole', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    withRuleOnFirstBoundaryOnly(agent);
    let first: string[] = [];
    let second: string[] = [];
    scripts.push(async function* twoBoundaries() {
      steering.redirect(LONG_STEER, { messageId: 'msg-long' });
      first = await firePreToolUse();
      second = await firePreToolUse();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    expect(first.join('\n')).not.toContain('LONG-STEER-START');
    const carried = second.join('\n');
    expect(carried).toContain(LONG_STEER);
    expect(carried.length).toBeLessThanOrEqual(10_000);
    expect(steersOf(events)).toEqual([]);
  });

  it('CONTROL — a steer that fits the preview still rides the over-cap boundary FIRST (F1.344 unchanged)', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    // A rule long enough that even a short steer's answer is over the cap (the rule alone is under it).
    (agent as unknown as { consumePendingPathScopedRuleContext(): string | undefined }).consumePendingPathScopedRuleContext = () => `RULE-START ${'r'.repeat(9_950)}`;
    const SHORT = 'stop, use the v2 endpoint instead';
    let contexts: string[] = [];
    scripts.push(async function* shortSteerTurn() {
      steering.redirect(SHORT, { messageId: 'msg-short' });
      contexts = await firePreToolUse();
      yield resultMessage();
    });

    const events = await runTurn(agent, 'do the work');

    const context = contexts.join('\n');
    expect(context.length).toBeGreaterThan(10_000);
    const at = context.indexOf(SHORT);
    expect(at).toBeGreaterThan(-1);
    expect(at + SHORT.length).toBeLessThanOrEqual(2_000);
    expect(steersOf(events)).toEqual([]);
  });
});

describe('F1.487 (P-WJqqa-5) — a send refused by a handoff\'s paused FIFO is not "interrupted by the user"', () => {
  // Since F1.335 a plan/auth handoff pauses the FIFO, so a send during the handoff's drain is
  // refused. SessionManager's refusal branch stamps `wasInterrupted` when the backend says its
  // refusal interrupted the turn (`backendInterruptsOnFailedSteer`, read by
  // `queuedSendInterruptedTurn`) — and the next turn then tells the model the user interrupted a
  // turn the HANDOFF ended. A Stop never reaches `redirect` (F1.335: a send after Stop is always
  // queued, and the Stop stamps on its own), so a paused refusal interrupted nothing the user did.
  async function hostReading(agent: unknown): Promise<{ interrupts: boolean; stamps: boolean }> {
    const { backendInterruptsOnFailedSteer, queuedSendInterruptedTurn } = await import('../../../../server-core/src/sessions/mid-stream-interruption.ts');
    const interrupts = backendInterruptsOnFailedSteer(agent as never);
    return { interrupts, stamps: queuedSendInterruptedTurn('steer', interrupts) };
  }

  it('a send during a handoff drain: refused, nothing aborted, and the host does not stamp the turn', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    let refused: boolean | undefined;
    let aborts = 0;
    let reading: { interrupts: boolean; stamps: boolean } | undefined;
    scripts.push(async function* handoffDrain() {
      steering.interruptForHandoff(AbortReason.PlanSubmitted);
      steering.takePendingSteers();
      const realForceAbort = (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort;
      (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort = () => { aborts += 1; };
      refused = steering.redirect('sent while the plan card opens', { messageId: 'msg-late' });
      (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort = realForceAbort;
      reading = await hostReading(agent);
      yield resultMessage();
    });

    await runTurn(agent, 'plan it');

    expect(refused).toBe(false);
    expect(aborts).toBe(0); // the paused branch: the handoff, not this refusal, ends the turn
    expect(reading).toEqual({ interrupts: false, stamps: false });
  });

  it('CONTROL — a refusal with no turn at all (the abort fallback) still reads as interrupting', async () => {
    const agent = freshAgent();
    const steering = agent as unknown as Steering;
    (agent as unknown as { forceAbort(reason: AbortReason): void }).forceAbort = () => {};
    expect(steering.redirect('no turn open', { messageId: 'msg-idle' })).toBe(false);
    expect(await hostReading(agent)).toEqual({ interrupts: true, stamps: true });
  });
});
