/**
 * R9 — the model's `SlashCommand` seam on the Claude runtime.
 *
 * `SessionToolContext.dispatchSlashCommand` is a SHARED seam with exactly one
 * shared handler (`session-tools-core/src/handlers/slash-command.ts`), and
 * `session-scoped-tools.ts` builds the slot UNCONDITIONALLY as an arrow that
 * throws when the session-scoped callback registry has no
 * `dispatchSlashCommandFn`. `ClaudeAgent` registered four callbacks and not
 * that one, so the shipped behaviour was not "the tool is absent on Claude":
 *
 *   - `mcp__session__SlashCommand` IS advertised (it is a registry tool with a
 *     handler, and `getSessionScopedTools` maps every such def into the SDK-MCP
 *     server),
 *   - our own `/help` answer tells the model
 *     "/compact [instructions]: compact the active session context",
 *   - and every `/compact` came back
 *     `[ERROR] SlashCommand dispatch is not available in this context.`
 *
 * A capability advertised, described as working, and erroring on every call.
 * The first test below is that measurement; it is kept as the permanent
 * negative control, because a suite that can only go green proves nothing.
 *
 * The fix is a TIMING adapter, not a second mechanism. The tool handler runs
 * MID-turn and only Pi can compact mid-turn — the Claude Agent SDK exposes no
 * compaction control request at all, so the documented mechanism is a prompt.
 * `agent-sdk/slash-commands.md` (the Note under the `/compact` example):
 *
 *   "A fresh one-shot `query()` call starts with empty context, so use this
 *   pattern in a session with prior turns, for example in streaming input mode
 *   or when resuming a session."
 *
 * Our Claude turns ARE resumed one-shots, which is why the user-typed
 * `/compact` has worked all along through `chatImpl`'s `SDK_SLASH_COMMANDS`
 * branch. So the model's request is parked and replayed through that same
 * user-typed path at the turn boundary.
 *
 * These tests drive the REAL registered tool — over an in-memory MCP client
 * against the real `getSessionScopedTools` server — and a REAL `chatImpl` turn
 * with the SDK's `query` faked. Nothing here stubs `dispatchSlashCommand`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';

// `mock.module` is process-global and bun runs every file in one process, so
// the real module is spread back in and restored in `afterAll` — the pattern
// `claude-gateway-adapter.test.ts:79` records. Only `query` is replaced;
// `createSdkMcpServer` and `tool` stay real, which is what lets the session
// tools below be the real ones.
const realSdk = { ...sdkPackage };

interface QueryCall { prompt: string }

/** Every `query()` call a turn made, in order. */
const queryCalls: QueryCall[] = [];
/** Scripted SDK streams, consumed one per `query()` call. */
const scripts: Array<(prompt: string) => AsyncGenerator<unknown>> = [];

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * The SDK's own compaction report (`slash-commands.md`, `compact_boundary`).
 *
 * R14 — `post_tokens` is deliberately ABSENT here, and that is not an
 * oversight: it is `post_tokens?: number` in the SDK's own
 * `SDKCompactBoundaryMessage`, so this is the shape a compaction that does not
 * report its result takes. Every pre-R14 test below keeps using it, which makes
 * them the standing proof that the R14 path emits NOTHING when the SDK gives it
 * nothing to emit.
 */
function compactBoundaryMessage(): unknown {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { pre_tokens: 1842, trigger: 'manual' },
  };
}

/** R14 — the same report WITH the optional post-compaction size filled in. */
function compactBoundaryMessageWithPostTokens(preTokens: number, postTokens: number): unknown {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { pre_tokens: preTokens, post_tokens: postTokens, trigger: 'manual' },
  };
}

/**
 * R14 — a result carrying real figures, so the stale number is visible as a
 * number rather than as a `1`.
 *
 * The `inputTokens` a compaction turn's result reports is the compaction
 * REQUEST's own input: the whole pre-compaction conversation that was just
 * summarized. That is why `usageBearingResult(PRE_TOKENS, …)` is the honest
 * fixture for the compaction turn and why the row cannot be fixed by reading
 * the result.
 */
function usageBearingResult(inputTokens: number, outputTokens: number, costUsd: number): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    total_cost_usd: costUsd,
    modelUsage: {
      'claude-sonnet-4-6': { contextWindow: 200_000, inputTokens, outputTokens },
    },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const PRE_TOKENS = 180_000;
const POST_TOKENS = 24_000;

/**
 * R14 — a faithful MIRROR of the three `SessionManager` cases this row's
 * accounting turns on. It is a mirror and not the real thing because
 * `SessionManager` is outside this row's file zone; every line below is the
 * behaviour of a quoted sentence in `packages/server-core/src/sessions/SessionManager.ts`,
 * not an invention:
 *
 *  - `complete`: *"inputTokens = current context size (full conversation sent
 *    this turn), NOT accumulated"* — ASSIGNED; `outputTokens` and `costUsd`
 *    accumulate; then `recordUsageMetrics` and a goal-turn record.
 *  - `usage_update`: *"Update only inputTokens (current context size) - other
 *    fields accumulate on complete"* — assignment only, then a renderer push.
 *  - `info` starting with `Compacted`: appends the banner, and then
 *    *"Emit usage_update so the context count badge refreshes immediately after
 *    compaction, without waiting for the next message"* — reading
 *    `managed.tokenUsage.inputTokens` AS IT STANDS AT THAT MOMENT.
 *
 * That last one is the mechanism of the whole defect: the badge the user sees
 * next to the banner is pushed by the banner's own handler, from whatever the
 * context size happens to be when the banner lands.
 */
interface MirroredSessionState {
  /** The context size the session ends the turn holding — the durable badge. */
  inputTokens: number;
  /** What the banner's own handler pushed to the renderer beside it. */
  badgeAtBanner: number | null;
  /** Accumulated output tokens — the field a second `complete` would double. */
  outputTokens: number;
  /** Accumulated cost — likewise. */
  costUsd: number;
  /** One entry per `recordUsageMetrics` call (OTLP consumption buckets). */
  metricsInputTokens: number[];
  /** One entry per goal-turn record. */
  goalTurns: number[];
}

function mirrorSessionManager(events: AgentEvent[]): MirroredSessionState {
  const state: MirroredSessionState = {
    inputTokens: 0,
    badgeAtBanner: null,
    outputTokens: 0,
    costUsd: 0,
    metricsInputTokens: [],
    goalTurns: [],
  };
  for (const event of events) {
    if (event.type === 'complete') {
      const usage = event.usage;
      if (usage) {
        // The badge prefers `contextTokens` when the backend reports one, and
        // the metrics do NOT — that split is the whole of R16's correction, so
        // the mirror has to model both or it cannot see the difference between
        // "the badge is right" and "the spend was understated".
        const context = usage.contextTokens;
        state.inputTokens = typeof context === 'number' && Number.isFinite(context) && context > 0
          ? context
          : usage.inputTokens;
        state.outputTokens += usage.outputTokens;
        state.costUsd += usage.costUsd ?? 0;
        state.metricsInputTokens.push(usage.inputTokens);
        state.goalTurns.push(usage.inputTokens + usage.outputTokens);
      }
    } else if (event.type === 'usage_update') {
      const inputTokens = event.usage?.inputTokens;
      if (typeof inputTokens === 'number' && Number.isFinite(inputTokens)) {
        state.inputTokens = inputTokens;
      }
    } else if (event.type === 'info' && event.message.startsWith('Compacted')) {
      state.badgeAtBanner = state.inputTokens;
    }
  }
  return state;
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage();
}

/** The text of one streamed `SDKUserMessage`, as the CLI would read it. */
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

/**
 * L2 — the fake is now a LIVE session, because the thing under test is.
 *
 * `ClaudeAgent` no longer passes a string prompt: it opens one `query()` per
 * agent with an async-iterable prompt and writes each turn's message into it.
 * A fake that only looked at `input.prompt` could therefore see nothing but
 * "(streamed prompt)" — which is exactly what these assertions started
 * reporting, and it is a property of the harness, not of the seam.
 *
 * So the fake reads the channel: one script per message that arrives, and the
 * generator STAYS OPEN between turns, the way the real child does. `queryCalls`
 * consequently counts TURNS SENT rather than processes spawned, which is the
 * quantity every assertion in this file was actually about.
 */
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (typeof input.prompt === 'string') {
      queryCalls.push({ prompt: input.prompt });
      const script = scripts.shift() ?? plainSuccess;
      return script(input.prompt);
    }
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const prompt = promptTextOf(next.value);
        queryCalls.push({ prompt });
        const script = scripts.shift() ?? plainSuccess;
        yield* script(prompt);
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
const { getSessionScopedTools } = await import('../session-scoped-tools.ts');

const WORKSPACE_ID = 'ws-r9-slash-seam';
const WORKSPACE_ROOT = '/tmp/nessy-r9-slash-seam';

function agentConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: WORKSPACE_ID,
      name: 'R9 Slash Seam',
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

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * Call `SlashCommand` the way the model does: over MCP, against the real
 * SDK-MCP server `getSessionScopedTools` builds. A fresh server wrapper per
 * call is what `chatImpl` does too (the tools array is cached, the wrapper is
 * not — see the `sessionToolsCache` comment).
 */
async function callSlashCommand(
  sessionId: string,
  args: { command: string; arguments?: string },
): Promise<ToolCallResult> {
  const server = getSessionScopedTools(sessionId, WORKSPACE_ROOT, WORKSPACE_ID) as unknown as {
    instance: { connect(transport: unknown): Promise<void> };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'r9-seam-test', version: '1.0.0' });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name: 'SlashCommand', arguments: args }) as unknown as ToolCallResult;
  } finally {
    await client.close();
  }
}

function textOf(result: ToolCallResult): string {
  return result.content.map(part => part.text ?? '').join('\n');
}

/**
 * A normal turn's prompt is WRAPPED — `buildTextPrompt` prepends the date,
 * `<session_state>`, sources and workspace capabilities, and the user's text is
 * the last line. A session command is NOT wrapped: that is the whole point of
 * the `SDK_SLASH_COMMANDS` branch, and asserting on the bare form is what keeps
 * a regression that starts wrapping `/compact` visible.
 */
function promptShape(prompt: string): string {
  if (prompt.startsWith('/')) return prompt;
  const lines = prompt.trimEnd().split('\n');
  return lines[lines.length - 1] ?? prompt;
}

function promptShapes(): string[] {
  return queryCalls.map(call => promptShape(call.prompt));
}

/** Drive one real `chatImpl` turn and collect the events it emitted. */
async function runTurn(agent: InstanceType<typeof ClaudeAgent>, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as {
    chatImpl: (message: string) => AsyncGenerator<AgentEvent>;
  }).chatImpl.bind(agent);
  const events: AgentEvent[] = [];
  for await (const event of chatImpl(message)) events.push(event);
  return events;
}

let sessionCounter = 0;
let liveAgent: InstanceType<typeof ClaudeAgent> | null = null;

/** A fresh session id per test: the callback registry and the tool cache are
 * both module-global singletons keyed by `{workspaceId, sessionId}`. */
function freshSessionId(): string {
  sessionCounter += 1;
  return `session-r9-${sessionCounter}`;
}

beforeEach(() => {
  queryCalls.length = 0;
  scripts.length = 0;
});

afterEach(() => {
  liveAgent?.destroy();
  liveAgent = null;
});

describe('the model-facing SlashCommand seam on Claude', () => {
  /**
   * NEGATIVE CONTROL and the measured BEFORE-state in one. No `ClaudeAgent`
   * exists for this session, so the callback registry has no
   * `dispatchSlashCommandFn` — precisely the shipped Claude situation. If a
   * future change makes the shared arrow succeed unconditionally, this goes
   * red and the rest of the file loses its meaning quietly otherwise.
   */
  it('errors when nothing registered a dispatcher — the shipped Claude behaviour', async () => {
    const result = await callSlashCommand(freshSessionId(), {
      command: 'compact',
      arguments: 'keep the decisions',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('SlashCommand dispatch is not available in this context.');
  });

  /**
   * `/help` never touches the dispatcher — the shared handler answers it
   * first. That is why `ClaudeAgent.dispatchSlashCommand` deliberately does
   * NOT carry its own copy of the help text: the answer is already identical
   * on every runtime by construction, and a third copy would only be drift
   * surface. This asserts the identity across the registered and the
   * unregistered case.
   */
  it('answers /help identically with and without a dispatcher registered', async () => {
    const withoutDispatcher = await callSlashCommand(freshSessionId(), { command: 'help' });

    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));
    const withDispatcher = await callSlashCommand(sessionId, { command: 'help' });

    expect(withoutDispatcher.isError).toBeFalsy();
    expect(withDispatcher.isError).toBeFalsy();
    expect(textOf(withDispatcher)).toBe(textOf(withoutDispatcher));
    expect(textOf(withDispatcher)).toContain('/compact [instructions]: compact the active session context.');
  });

  it('answers /compact instead of erroring once a ClaudeAgent owns the session', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    const result = await callSlashCommand(sessionId, {
      command: 'compact',
      arguments: 'keep the decisions',
    });

    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain('compacted as soon as this turn ends');
    // Truthful about WHY it is deferred: the model must not read this as
    // "your context is smaller now" and change what it does next.
    expect(text).toContain('cannot compact mid-turn');
    // The prefix hazard. `SessionManager`'s `info` case stamps
    // `compaction_complete` on any message that starts with "Compacted", and
    // the pre-plan-execution flow waits on that event — a completion fired
    // before anything was compacted is silent and wrong.
    expect(text.startsWith('Compacted')).toBe(false);
  });

  /**
   * The whole point of the row: the parked request must actually run, and it
   * must run through the path the USER's `/compact` already uses — a bare
   * resumed `query({ prompt: '/compact …' })` from `chatImpl`'s
   * `SDK_SLASH_COMMANDS` branch. The tool is called MID-stream here, exactly
   * where the SDK-MCP server would call it.
   */
  it('runs the parked /compact at the turn boundary, through the user-typed path', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* turnWithToolCall() {
      const toolResult = await callSlashCommand(sessionId, {
        command: 'compact',
        arguments: 'keep the decisions',
      });
      expect(toolResult.isError).toBeFalsy();
      yield resultMessage();
    });
    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessage();
      yield resultMessage();
    });

    const events = await runTurn(liveAgent, 'do the work');

    expect(promptShapes()).toEqual([
      'do the work',
      '/compact keep the decisions',
    ]);
    // The compaction's own report reaches the session — this is the `info`
    // whose "Compacted" prefix SessionManager keys `compaction_complete` off.
    expect(events.some(event => event.type === 'info' && event.message === 'Compacted Conversation')).toBe(true);
    // Exactly one `complete`: the nested turn is a continuation, and
    // SessionManager's `complete` case accumulates usage, records usage
    // metrics and records a goal turn.
    expect(events.filter(event => event.type === 'complete').length).toBe(1);

    // ORDER, pinned rather than left to chance — `some`/`filter` are
    // order-blind, which is how the ordering below went unnoticed.
    //
    // THE HISTORY, kept because it is the record R14 was opened against. This
    // used to assert `indexOf('info') > indexOf('complete')` and was labelled a
    // KNOWN RESIDUAL: the compaction banner lands AFTER the turn's own
    // `complete`, because the SDK's result is yielded inside the streaming loop
    // and the drain runs after it, whereas on the USER-typed path the order is
    // the other way round. That much is still true and is still asserted below
    // — R14 did NOT reorder the stream.
    //
    // What R14 changed is the finding underneath it. The residual was recorded
    // as "the context surfaces are refreshed from the outer `complete`'s
    // pre-compaction numbers while the banner says the conversation was
    // compacted", with the ordering as its cause. Measured, the ordering was
    // NOT the cause and reordering would not have fixed it: the USER-typed
    // path, whose order was held up as the correct reference, carried the very
    // same stale number, because the result a compaction turn reports counts
    // the compaction REQUEST — the whole pre-compaction conversation. The real
    // cause was that `compact_metadata.post_tokens`, the only post-compaction
    // context size the SDK ever emits, was read by nothing in this repo. It is
    // read now. See the two tests below.
    //
    // R16 THEN REORDERED IT AFTER ALL, for a reason neither row had: measured
    // live, `SessionManager` RETURNS out of `sendMessage` on `complete` and
    // unwinds this generator, so everything that used to run after the loop —
    // the drain included — never ran in production at all. The drain moved to
    // the `complete` yield itself, which puts the banner BEFORE the completion,
    // matching the user-typed path. The ordering was never the defect; it is
    // now incidentally correct because the fix for the real one required it.
    const order = events.map(event => event.type);
    expect(order.indexOf('info')).toBeLessThan(order.indexOf('complete'));
  });

  /**
   * R14 — THE BAR: after a model-requested compaction the context indicator
   * must not contradict the banner sitting next to it.
   *
   * Asserted against a mirror of `SessionManager`'s own three cases rather than
   * against the event list, because the contradiction is a property of the
   * state those cases build, not of the stream. The badge the user sees beside
   * the banner is the one the banner's OWN handler pushes.
   */
  it('R14 — the badge beside the banner is the post-compaction size, not the pre-compaction one', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* turnWithToolCall() {
      await callSlashCommand(sessionId, { command: 'compact', arguments: 'keep the decisions' });
      yield usageBearingResult(PRE_TOKENS, 500, 0.9);
    });
    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessageWithPostTokens(PRE_TOKENS, POST_TOKENS);
      // The compaction's own result: its input is the conversation it just
      // summarized, i.e. the PRE-compaction size. This is why forwarding the
      // nested `complete` was measured and rejected as the fix.
      yield usageBearingResult(PRE_TOKENS, 3000, 0.4);
    });

    const events = await runTurn(liveAgent, 'do the work');
    const state = mirrorSessionManager(events);

    // BEFORE R14 both of these were PRE_TOKENS.
    expect(state.badgeAtBanner).toBe(POST_TOKENS);
    expect(state.inputTokens).toBe(POST_TOKENS);

    // R16 — the correction rides the `complete` itself, on `contextTokens`, so
    // there is no separate refresh event to order against any more. What makes
    // the badge agree with the banner is that the banner arrives first and the
    // completion that follows carries the corrected size. An earlier draft sent
    // a `usage_update` before the banner instead; live measurement showed it
    // was then overwritten by the very `complete` that ends the stream.
    const order = events.map(event => event.type);
    expect(order.indexOf('info')).toBeLessThan(order.indexOf('complete'));

    // ...and the accounting the fix promised NOT to disturb. The nested turn's
    // `complete` is still dropped, so none of the three things a second one
    // would repeat happened twice: usage accumulation, the OTLP consumption
    // record, the goal turn.
    expect(events.filter(event => event.type === 'complete').length).toBe(1);
    expect(state.outputTokens).toBe(500);
    expect(state.costUsd).toBeCloseTo(0.9, 10);
    expect(state.metricsInputTokens).toEqual([PRE_TOKENS]);
    expect(state.goalTurns).toEqual([PRE_TOKENS + 500]);
  });

  /**
   * R14 — THE REFERENCE PATH WAS BROKEN TOO, and this is the test that says so.
   *
   * The row was written on the reading that the user-typed `/compact` is the
   * correct behaviour the model's path should be made to match. It is not: it
   * emits the banner FIRST, so the badge its handler pushes is whatever the
   * previous turn left behind, and the `complete` that arrives a moment later
   * overwrites the context size with the compaction request's own input. Both
   * numbers are pre-compaction. Fixing only the model path would have left the
   * commoner path — a user typing `/compact` — wrong.
   *
   * The fix lives in `chatImpl`'s message loop, which both paths share, so both
   * are covered by construction; this test is what proves that claim rather
   * than asserting it.
   */
  it('R14 — the USER-typed /compact gets the same correction, and needed it', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessageWithPostTokens(PRE_TOKENS, POST_TOKENS);
      yield usageBearingResult(PRE_TOKENS, 3000, 0.4);
    });

    const events = await runTurn(liveAgent, '/compact keep the decisions');
    const state = mirrorSessionManager(events);

    expect(promptShapes()).toEqual(['/compact keep the decisions']);
    expect(state.badgeAtBanner).toBe(POST_TOKENS);

    // The durable half. On this path the `complete` arrives AFTER the banner
    // and assigns the compaction request's input over the fresh number, so a
    // single pre-banner refresh is not enough — without the reassert that
    // follows the turn's `complete`, this is PRE_TOKENS and the contradiction
    // returns on the next render or reload.
    expect(state.inputTokens).toBe(POST_TOKENS);

    // Consumption is still reported honestly: the compaction really did send
    // the whole conversation, and the OTLP bucket says so.
    expect(state.metricsInputTokens).toEqual([PRE_TOKENS]);
    expect(state.outputTokens).toBe(3000);
  });

  /**
   * R14 — `post_tokens` is OPTIONAL in the SDK's own type. When the SDK does
   * not report it, we invent nothing: a fabricated context size would be worse
   * than a stale one because it would look authoritative. `pre_tokens` is
   * present in this fixture and is deliberately not used — it is the size the
   * banner is telling the user is no longer true.
   */
  it('R14 — invents no count when the SDK reports no post_tokens, and (F1.240) marks the context snapshot stale instead', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessage(); // pre_tokens only
      yield usageBearingResult(PRE_TOKENS, 3000, 0.4);
    });

    const events = await runTurn(liveAgent, '/compact');

    expect(events.some(event => event.type === 'info' && event.message === 'Compacted Conversation')).toBe(true);
    // F1.240 — this arm used to pin ZERO usage updates here. Since P6.264 the
    // claude donut reads ONLY the ContextUsageSnapshot (a `fresh-local`
    // provider), which no boundary replaced, so after a /context refresh it kept
    // the pre-compaction count with nothing marking it stale. Now ONE update
    // carries a snapshot marked stale with an UNKNOWN count — and still no
    // number: neither `inputTokens` nor the snapshot's count is invented from
    // `pre_tokens`, which is the size the banner says is no longer true.
    const updates = events.filter(event => event.type === 'usage_update');
    expect(updates.length).toBe(1);
    const usage = updates[0]?.type === 'usage_update' ? updates[0].usage : undefined;
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.contextUsage?.stale).toBe(true);
    expect(usage?.contextUsage?.inputTokens).toBeNull();
    expect(usage?.contextUsage?.source).toBe('unavailable');
    expect(usage?.contextUsage?.lastCompaction?.tokensBefore).toBe(1842);
    expect(usage?.contextUsage?.lastCompaction?.estimatedTokensAfter).toBeUndefined();
    // F1.460 (12) — and it lands BEFORE the banner. The host's compaction `info`
    // case re-sends `managed.contextUsage` at the moment the banner lands, so a
    // stale snapshot that arrived after it would be re-sent as current. The count
    // and field checks above cannot see the order: moving the push below the
    // adapted events passed every one of them. The banner is found BY ITS TEXT:
    // this turn carries an earlier `info` row too, so the first `info` is not it
    // (the verifier's `indexOf('info')` form reads that one and fails on HEAD).
    const staleAt = events.findIndex(event => event.type === 'usage_update');
    const bannerAt = events.findIndex(event => event.type === 'info' && event.message === 'Compacted Conversation');
    expect(staleAt).toBeGreaterThanOrEqual(0);
    expect(bannerAt).toBeGreaterThan(staleAt);
  });

  it('F1.240 — a boundary WITH post_tokens replaces the context snapshot too, not only tokenUsage', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessageWithPostTokens(PRE_TOKENS, POST_TOKENS);
      yield usageBearingResult(PRE_TOKENS, 3000, 0.4);
    });

    const events = await runTurn(liveAgent, '/compact');
    const usage = events.find(event => event.type === 'usage_update');
    const snapshot = usage?.type === 'usage_update' ? usage.usage.contextUsage : undefined;

    // The donut on claude reads THIS, not tokenUsage — before F1.240 it was absent
    // here, so the host kept (and the info re-send re-shipped) the old snapshot.
    expect(snapshot?.inputTokens).toBe(POST_TOKENS);
    expect(snapshot?.source).toBe('estimated_after_compact');
    expect(snapshot?.stale).toBeUndefined();
    expect(snapshot?.lastCompaction).toEqual({ tokensBefore: PRE_TOKENS, estimatedTokensAfter: POST_TOKENS });
    // R14's own number is unchanged.
    expect(usage?.type === 'usage_update' ? usage.usage.inputTokens : undefined).toBe(POST_TOKENS);
  });

  it('F1.240 — the AUTO shape: the boundary snapshot is post_tokens, and the turn\'s later reading still owns tokenUsage', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* autoCompactedTurn() {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: PRE_TOKENS, post_tokens: 14_748, trigger: 'auto' },
      };
      yield usageBearingResult(38_000, 900, 0.2);
    });

    const events = await runTurn(liveAgent, 'keep going');
    const usage = events.find(event => event.type === 'usage_update');
    const snapshot = usage?.type === 'usage_update' ? usage.usage.contextUsage : undefined;

    expect(snapshot?.inputTokens).toBe(14_748);
    expect(snapshot?.source).toBe('estimated_after_compact');
    // CONTROL — R14's auto rule is untouched: the later reading is the truth.
    expect(mirrorSessionManager(events).inputTokens).toBe(38_000);
  });

  /**
   * R14 — THE POSITIVE CONTROL for the two tests above. Without it, "the badge
   * equals POST_TOKENS" and "this rig cannot produce any other number" look
   * identical. A turn that compacts to a DIFFERENT size must move the badge to
   * that other size, and a turn that does not compact at all must leave the
   * context size at the turn's own reported input.
   */
  it('R14 — THE POSITIVE CONTROL: the badge tracks the reported size, and a turn with no compaction moves nothing', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    // A different post size, to prove the number is read rather than constant.
    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessageWithPostTokens(PRE_TOKENS, 9_001);
      yield usageBearingResult(PRE_TOKENS, 3000, 0.4);
    });
    const compacted = mirrorSessionManager(await runTurn(liveAgent, '/compact'));
    expect(compacted.badgeAtBanner).toBe(9_001);
    expect(compacted.inputTokens).toBe(9_001);

    // A plain turn: no compact_boundary, so no refresh, and the context size is
    // the turn's own reported input.
    scripts.push(async function* plainTurn() {
      yield usageBearingResult(77_000, 120, 0.1);
    });
    const plain = mirrorSessionManager(await runTurn(liveAgent, 'do the work'));
    expect(plain.badgeAtBanner).toBeNull();
    expect(plain.inputTokens).toBe(77_000);
  });

  /**
   * R14 — THE AUTO SHAPE, and the reason the first version of this row shipped a
   * worse number than the one it removed.
   *
   * `compact_metadata.trigger` is `'manual' | 'auto'`, and the SDK's own
   * auto-compaction is the only path that fires without a user or the model
   * asking — the one this repo has live evidence of. Its shape is different in
   * the way that matters: the boundary arrives MID-turn and the turn then
   * CONTINUES, so assistant frames after it report a context that has grown
   * again past `post_tokens`.
   *
   * Every other fixture here is `trigger: 'manual'` with nothing after the
   * boundary, which is exactly the shape where an unconditional reassert is
   * harmless. Reasserting the boundary value on THIS shape pinned the badge to
   * it and under-reported by as much as 72% — a stale-LOW number in place of a
   * stale-HIGH one, in the same direction of dishonesty the row exists to end.
   */
  it('R14 — a later reading beats post_tokens, so auto-compaction is not pinned to the boundary', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* autoCompactedTurn() {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { pre_tokens: PRE_TOKENS, post_tokens: 14_748, trigger: 'auto' },
      };
      // The turn carries on. This assistant frame is the truth after the
      // boundary, and the SDK reports it through the adapter's own usage path.
      yield usageBearingResult(38_000, 900, 0.2);
    });

    const auto = mirrorSessionManager(await runTurn(liveAgent, 'keep going'));

    // The badge beside the banner is still the boundary value — that is the
    // moment it describes, and it is correct there.
    expect(auto.badgeAtBanner).toBe(14_748);
    // But what the session is LEFT with is the later reading, not the boundary.
    expect(auto.inputTokens).toBe(38_000);
  });

  it('does NOT destroy a steer the user typed mid-turn — the drain re-enters chatImpl', async () => {
    // REGRESSION. `chatImpl`'s first statement cleared the steer slot then (F1.238: it hands steers back now),
    // and the drain nests a whole `chat()` inside `chatImpl`. Without the guard
    // in `drainPendingModelCompaction`, the nested turn wiped the OUTER turn's
    // undelivered steer before the outer `finally` could emit it — so
    // SessionManager never re-queued the user's message and the text was
    // silently destroyed. No error, no queue entry.
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* turnWithToolCall() {
      await callSlashCommand(sessionId, { command: 'compact', arguments: 'keep the decisions' });
      // The user types while the turn is still running. No tool call follows,
      // so the steer is never delivered and must come back as undelivered.
      liveAgent!.redirect('and also update the changelog');
      yield resultMessage();
    });
    scripts.push(async function* compactionTurn() {
      yield compactBoundaryMessage();
      yield resultMessage();
    });

    const events = await runTurn(liveAgent, 'do the work');

    const undelivered = events.filter(event => event.type === 'steer_undelivered');
    expect(undelivered.length).toBe(1);
    expect((undelivered[0] as { message: string }).message).toBe('and also update the changelog');
    // The compaction still ran — the guard restores the steer, it does not
    // suppress the drain.
    expect(promptShapes()).toEqual(['do the work', '/compact keep the decisions']);
  });

  it('THE POSITIVE CONTROL — the same steer survives a turn with no model /compact', async () => {
    // Without this, the test above proves nothing: an absence of
    // `steer_undelivered` and a rig that never emits it look identical.
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* plainTurn() {
      liveAgent!.redirect('and also update the changelog');
      yield resultMessage();
    });

    const events = await runTurn(liveAgent, 'do the work');

    expect(events.filter(event => event.type === 'steer_undelivered').length).toBe(1);
    expect(promptShapes()).toEqual(['do the work']);
  });

  it('carries the bare form through with no arguments', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* turnWithToolCall() {
      await callSlashCommand(sessionId, { command: 'compact' });
      yield resultMessage();
    });

    await runTurn(liveAgent, 'do the work');

    expect(promptShapes()).toEqual(['do the work', '/compact']);
  });

  it('fires once per request, not on every later turn', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* turnWithToolCall() {
      await callSlashCommand(sessionId, { command: 'compact' });
      yield resultMessage();
    });

    await runTurn(liveAgent, 'first');
    await runTurn(liveAgent, 'second');

    expect(promptShapes()).toEqual(['first', '/compact', 'second']);
  });

  /**
   * A request made in a turn that then failed must die with that turn. Without
   * this, a `/compact` the model asked for during a broken turn lands at the
   * end of an unrelated later one, compacting a conversation nobody asked to
   * compact.
   *
   * R16 SHARPENED WHAT "FAILED" MEANS HERE, and the fixture changed with it.
   * It used to yield the result and THEN throw — which is not a failed turn at
   * all: the SDK had already reported its result, so the turn finished and the
   * stream died afterwards. That distinction did not matter while the drain sat
   * after the loop, because an exception skipped it either way. It matters now
   * that the drain runs at the `complete` yield, which is the only placement
   * the session ever reaches. A turn that completes and then loses its stream
   * has earned its compaction; a turn that never completes has not.
   *
   * So the fixture throws BEFORE any result. No `complete` is emitted, the
   * drain is never reached, and the parked request is cleared on the way out.
   */
  it('discards the request when the turn errors instead of draining', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    scripts.push(async function* failingTurn() {
      await callSlashCommand(sessionId, { command: 'compact', arguments: 'keep the decisions' });
      throw new Error('stream blew up before the turn could complete');
    });

    const failed = await runTurn(liveAgent, 'first');
    expect(failed.some(event => event.type === 'error')).toBe(true);
    expect(promptShapes()).toEqual(['first']);

    // And it does not resurrect on the next, unrelated turn.
    await runTurn(liveAgent, 'second');
    expect(promptShapes()).toEqual(['first', 'second']);
  });

  /**
   * The model-callable allowlist stays `compact | help`. It is enforced in the
   * tool schema (`z.enum(['compact','help'])`) and in the shared handler's
   * `ALLOWED_SLASH_COMMANDS`, and R9 adds no second list — so a command the
   * classifier understands perfectly well is still refused before it can reach
   * the session.
   */
  it('still refuses every command outside compact|help', async () => {
    const sessionId = freshSessionId();
    liveAgent = new ClaudeAgent(agentConfig(sessionId));

    for (const command of ['clear', 'subtask', 'btw', 'recap', 'heapdump']) {
      const result = await callSlashCommand(sessionId, { command });
      expect(result.isError).toBe(true);
    }
    expect(queryCalls.length).toBe(0);
  });
});
