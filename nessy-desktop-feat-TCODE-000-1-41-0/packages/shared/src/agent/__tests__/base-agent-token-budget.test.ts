/**
 * P6.645 — a host-side TOKEN budget every runtime honours.
 *
 * Step 1 of native-first was measured absent on all three: codex refused all
 * three ceilings at `rust-v0.148.0` (P6.507), claude's `Options.taskBudget` has
 * zero production references, Pi's per-turn cap is USD-only. Step 2 — the host
 * — is the seam, and the comparison sits in `BaseAgent.chat`, the one loop every
 * backend runs through.
 *
 * ## "One test per runtime" means the three properties that actually DIFFER
 *
 * Every runtime reaches this cap through the same `chat()` loop, so three copies
 * of one assertion would prove nothing three times. What differs between them,
 * measured, is exactly two things — and the token cap must be indifferent to
 * both, which is the whole reason it exists beside the USD one:
 *
 * - **codex declares it reports no cost** (`reportsCostUsd() === false`), which
 *   makes the USD ceiling refuse to arm at all (P2.258). Tokens are reported by
 *   every runtime, so the token ceiling MUST still fire there. This is the case
 *   the row is for.
 * - **Pi enforces the USD cap inside its own `chatImpl`**
 *   (`enforcesMaxBudgetUsdInChatImpl`), so the shared loop is handed `0` for
 *   money. No runtime enforces a token ceiling of its own, so the token check is
 *   unconditional and must fire for Pi too.
 * - claude/Nestor is the plain case: both caps live in this loop.
 *
 * ## The accumulation rule is the part that can be silently wrong
 *
 * `inputTokens` is a SNAPSHOT (every call resends the conversation) while
 * `outputTokens` is an INCREMENT — `SessionManager` is the reference and this
 * mirrors it. Summing the input would be the N(N+1)/2 walk-past P2.35 records
 * for cost, one field along, and it would make the cap fire EARLY, which looks
 * like the cap working. The last two cases drive that difference directly.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { TestAgent, createMockBackendConfig, collectEvents, createMockCapabilityTurnRuntime } from './test-utils.ts';

interface RuntimeShape {
  readonly reportsCostUsd: boolean;
  readonly enforcesMaxBudgetUsdInChatImpl: boolean;
}

function agent(
  maxBudgetTokens: number,
  scripted: AgentEvent[],
  shape: RuntimeShape,
  /** P6.794 - the session's already-accumulated OUTPUT tokens, as SessionManager reports them. */
  recordedOutputTokens?: number,
): TestAgent {
  const built = new TestAgent(createMockBackendConfig(
    recordedOutputTokens === undefined ? {} : { getSessionOutputTokens: () => recordedOutputTokens },
  ));
  built.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  built.scriptedEvents = scripted;
  const internals = built as unknown as {
    getMaxBudgetTokens(): number;
    getMaxBudgetUsd(): number;
    reportsCostUsd(): boolean;
    enforcesMaxBudgetUsdInChatImpl: boolean;
  };
  internals.getMaxBudgetTokens = () => maxBudgetTokens;
  // The USD cap stays OFF in every case here: the row's done_means is that it is
  // untouched, and leaving it on would let a green run come from the wrong cap.
  internals.getMaxBudgetUsd = () => 0;
  internals.reportsCostUsd = () => shape.reportsCostUsd;
  internals.enforcesMaxBudgetUsdInChatImpl = shape.enforcesMaxBudgetUsdInChatImpl;
  return built;
}

const usage = (inputTokens: number, outputTokens: number, extra: Record<string, unknown> = {}) =>
  ({ inputTokens, outputTokens, ...extra }) as never;

function terminalReasons(events: AgentEvent[]): Array<string | undefined> {
  return events
    .filter(event => event.type === 'complete')
    .map(event => (event as { terminalReason?: string }).terminalReason);
}

const RUNTIMES: ReadonlyArray<readonly [string, RuntimeShape]> = [
  ['claude / nestor — both caps live in the shared loop', { reportsCostUsd: true, enforcesMaxBudgetUsdInChatImpl: false }],
  ['codex — declares it reports NO cost, so the USD cap cannot arm', { reportsCostUsd: false, enforcesMaxBudgetUsdInChatImpl: false }],
  ['pi — enforces the USD cap in its own loop, so the shared one is handed 0', { reportsCostUsd: true, enforcesMaxBudgetUsdInChatImpl: true }],
];

describe('P6.645 — the token ceiling fires on every runtime', () => {
  for (const [label, shape] of RUNTIMES) {
    it(`stops the turn and names the reason — ${label}`, async () => {
      const built = agent(100, [{ type: 'complete', usage: usage(400, 50) }], shape);
      const events = await collectEvents(built.chat('hi'));
      expect(terminalReasons(events)).toContain('max_budget_tokens');
      // The sentence, not only the verdict: `sendMessage`'s chat loop stops at
      // the first `complete`, so a notice yielded after it would never be read.
      const notice = events.find(event => event.type === 'info');
      expect(notice).toBeDefined();
      built.destroy();
    });
  }

  it('NEGATIVE — a session under the ceiling is untouched', async () => {
    const built = agent(100_000, [{ type: 'complete', usage: usage(400, 50) }], RUNTIMES[0]![1]);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toEqual([undefined]);
    built.destroy();
  });

  it('NEGATIVE — no ceiling configured means no comparison at all', async () => {
    // 0 is "off", the same value the USD cap uses, and it is what an absent
    // `maxBudgetTokens` resolves to while the declaration half is unlanded.
    const built = agent(0, [{ type: 'complete', usage: usage(9_999_999, 9_999_999) }], RUNTIMES[0]![1]);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toEqual([undefined]);
    built.destroy();
  });

  it('BOUNDARY — input is a SNAPSHOT, so three turns of the same context do not triple it', async () => {
    // The trap: summing `inputTokens` would reach 240 here and trip a ceiling of
    // 200, which reads exactly like the cap working. The honest total is the
    // LATEST input (80) plus the ACCUMULATED output (3), i.e. 83.
    const built = agent(200, [
      { type: 'usage_update', usage: usage(80, 1) },
      { type: 'usage_update', usage: usage(80, 1) },
      { type: 'complete', usage: usage(80, 1) },
    ], RUNTIMES[0]![1]);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toEqual([undefined]);
    built.destroy();
  });

  it('BOUNDARY — output DOES accumulate, and `contextTokens` outranks `inputTokens` after a compaction', async () => {
    // Output is an increment: 3 x 40 = 120 against a ceiling of 100, with the
    // input pinned low so only the output can breach it. `contextTokens` is what
    // a backend that compacted reports as the context it is LEFT holding, and
    // `SessionManager` prefers it for exactly that reason.
    const built = agent(100, [
      { type: 'usage_update', usage: usage(5_000, 40, { contextTokens: 5 }) },
      { type: 'usage_update', usage: usage(5_000, 40, { contextTokens: 5 }) },
      { type: 'complete', usage: usage(5_000, 40, { contextTokens: 5 }) },
    ], RUNTIMES[0]![1]);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toContain('max_budget_tokens');
    built.destroy();
  });

  it('NEGATIVE — an event with no usage at all can never arm the cap', async () => {
    // A `text` delta must not be able to end a turn: with no usage there is
    // nothing to count, and returning 0 for it would read as a free turn.
    const built = agent(1, [
      { type: 'text_complete', text: 'a lot of words' } as AgentEvent,
      { type: 'complete' },
    ], RUNTIMES[0]![1]);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toEqual([undefined]);
    built.destroy();
  });
});

/**
 * P6.794 - the ceiling resumes the session's output instead of restarting it.
 *
 * The residue P6.645 recorded and left open: `sessionOutputTokens` is a field on
 * an AGENT and a session outlives its agent, so every connection change, reopen
 * or app restart started the accumulator at zero and a ceiling of N was really N
 * PER INSTANCE. This is P2.44's measurement one field along, and the fix is its
 * twin - with one difference these cases exist to pin.
 */
describe('P6.794 - the token ceiling survives the agent instance being replaced', () => {
  it('resumes the recorded output, so a replaced instance does not restart the count', async () => {
    // 90 already spent by earlier instances of this session; this turn adds 20.
    const resumed = agent(100, [{ type: 'complete', usage: usage(0, 20) }], RUNTIMES[0]![1], 90);
    expect(terminalReasons(await collectEvents(resumed.chat('hi')))).toContain('max_budget_tokens');
    resumed.destroy();

    // The control that makes the assertion above mean something: the identical
    // turn on a session with nothing recorded is far under the ceiling.
    const fresh = agent(100, [{ type: 'complete', usage: usage(0, 20) }], RUNTIMES[0]![1]);
    expect(terminalReasons(await collectEvents(fresh.chat('hi')))).toEqual([undefined]);
    fresh.destroy();
  });

  it('resumes ONCE, so the instance cannot add the session total to itself', async () => {
    // Latched, exactly as `sessionCostUsdHydrated` is: both counters advance on
    // the same event, so a second read mid-life would double the resumed value.
    // 90 + 5 + 4 = 99 is under 100; re-hydrating would reach 189 and trip.
    const built = agent(100, [
      { type: 'usage_update', usage: usage(0, 5) },
      { type: 'usage_update', usage: usage(0, 4) },
      { type: 'complete', usage: usage(0, 0) },
    ], RUNTIMES[0]![1], 90);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toEqual([undefined]);
    built.destroy();
  });

  it('resumes the OUTPUT half and not the total, so the input snapshot is not counted twice', async () => {
    // THE CASE THE HAND-OFF GOT WRONG. The session's recorded TOTAL here is 140
    // (a 50-token input snapshot plus 90 accumulated output). The honest total
    // after this turn is 50 + 90 = 140, under a ceiling of 150. Had the twin
    // been wired to `tokenUsage.totalTokens`, this instance would start at 140
    // and the first event's snapshot assignment would add the input half a
    // second time - 190, and the cap would fire on a session that never reached
    // it. `inputTokens` is a snapshot the next event ASSIGNS; only the output
    // half ever needed resuming.
    const built = agent(150, [{ type: 'complete', usage: usage(50, 0) }], RUNTIMES[0]![1], 90);
    expect(terminalReasons(await collectEvents(built.chat('hi')))).toEqual([undefined]);
    built.destroy();
  });
});
