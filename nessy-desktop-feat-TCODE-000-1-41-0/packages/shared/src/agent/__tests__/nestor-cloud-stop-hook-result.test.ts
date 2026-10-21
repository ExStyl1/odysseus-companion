/**
 * P3.231(b) — the Stop hook's answer was received and thrown away, again.
 *
 * `emitStopHookOnce` ended in `.then(() => undefined)` — the identical discard
 * `76a048c9a` fixed on the codex path, still live here. `hooks.md`'s
 * exit-code-2 table gives a blocking `Stop` hook exactly one effect ("Prevents
 * Claude from stopping, continues the conversation"): it cancels nothing and
 * feeds its reason back so the agent knows what still needs doing. Dropping the
 * result closed that one channel, and nothing recorded the loss — so a plugin
 * whose Stop hook was its whole point looked identical to one that had no effect
 * to have.
 *
 * The other half was never sent at all: `stop_hook_active`, the field the page
 * tells authors to check "to prevent a condition that will never resolve", was
 * absent from every nestor-cloud Stop payload.
 *
 * Both now ride the shared `BaseAgent` implementation Pi and codex already use,
 * and — unlike the codex fix, which found a drain waiting for it — the queue
 * needed a READER here: `applyPromptHooks` drains it onto the next turn, so the
 * recorder is not filling a queue nobody empties.
 */
import { describe, expect, it } from 'bun:test';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import { UNTRUSTED_HOOK_NOTICE } from '../../automations/hook-context-fence.ts';
import { createMockBackendConfig } from './test-utils.ts';

type StopInternals = {
  emitStopHookOnce: () => Promise<void>;
  emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>;
  applyPromptHooks: (message: string, source: 'startup' | 'resume') => Promise<{ message: string } | { blocked: string }>;
  stopHookPromise?: Promise<void>;
  sessionStartHooksApplied?: boolean;
};

/**
 * A real agent with only the automation dispatcher replaced, so every line under
 * test — the recorder, the streak, the drain and the band — is the shipped one.
 */
function agentWith(stopDecision: Record<string, unknown> | undefined) {
  const agent = new NestorCloudAgent(createMockBackendConfig());
  const internals = agent as unknown as StopInternals;
  const payloads: Record<string, unknown>[] = [];
  internals.emitAutomationEvent = async (event, input) => {
    payloads.push({ event, ...input });
    if (event === 'Stop' && stopDecision) return { matchedCount: 1, decision: stopDecision };
    return { matchedCount: 0 };
  };
  // The session-start half is not under test and would fire a second event.
  internals.sessionStartHooksApplied = true;
  return { agent, internals, payloads };
}

describe('a nestor-cloud Stop hook block reaches the next turn (P3.231)', () => {
  it('records the reason and delivers it once, fenced', async () => {
    const { agent, internals } = agentWith({ decision: 'block', reason: 'the migration is only half applied' });
    try {
      await internals.emitStopHookOnce();
      const result = await internals.applyPromptHooks('carry on', 'resume');
      expect('message' in result).toBe(true);
      const message = (result as { message: string }).message;

      // MUTATION KILLED: restoring `.then(() => undefined)`. The hook's reason
      // reached nothing before this row.
      expect(message).toContain('the migration is only half applied');
      expect(message).toContain('<hook_feedback event="Stop">');
      // It rides the shared band, so it is fenced and carries the notice — the
      // body is a hook's stdout like every other hook band.
      expect(message).toContain('<untrusted source="hook_feedback">');
      expect(message).toContain(UNTRUSTED_HOOK_NOTICE);
      // The user's own message is still last.
      expect(message.endsWith('carry on')).toBe(true);

      // EXACTLY ONCE: the queue is drained, not copied.
      internals.stopHookPromise = undefined;
      const second = await internals.applyPromptHooks('and again', 'resume');
      expect((second as { message: string }).message).toBe('and again');
    } finally {
      agent.destroy();
    }
  });

  it('sends stop_hook_active, describing the turn that is ending', async () => {
    const { agent, internals, payloads } = agentWith({ decision: 'block', reason: 'not done' });
    try {
      await internals.emitStopHookOnce();
      const first = payloads.find(payload => payload.event === 'Stop');
      // The first Stop of a session is not continuing from anything.
      expect(first?.stop_hook_active).toBe(false);

      // Sampled BEFORE the recorder updates the streak, so the SECOND emission —
      // the turn entered because the first hook blocked — reports true.
      internals.stopHookPromise = undefined;
      await internals.emitStopHookOnce();
      const second = payloads.filter(payload => payload.event === 'Stop').at(-1);
      expect(second?.stop_hook_active).toBe(true);
    } finally {
      agent.destroy();
    }
  });

  it('leaves a non-blocking Stop hook with no effect at all', async () => {
    const { agent, internals, payloads } = agentWith(undefined);
    try {
      await internals.emitStopHookOnce();
      expect(payloads.some(payload => payload.event === 'Stop')).toBe(true);
      const result = await internals.applyPromptHooks('next', 'resume');
      expect((result as { message: string }).message).toBe('next');
    } finally {
      agent.destroy();
    }
  });
});
