/**
 * P6.297 — a SessionStart directive that is CARRIED AND NOT HONOURED says so.
 *
 * Two of the five session directives are stored by `applyHookSessionDirectives`
 * and read by nothing: `initialUserMessage`, because no surface here can create
 * a turn the user did not start, and `watchPaths`, because `FileChanged` fires
 * when a file-mutating tool completes rather than from a disk watcher (the
 * decision recorded on `BaseAgent._hookWatchPaths`). Both stay inert — the row
 * is explicit that "silence is the defect, not the inertness" — so what this
 * pins is that the hook author is TOLD.
 *
 * Its own file rather than a case inside `hook-session-directives.test.ts`,
 * which drives real spawned hooks through a real Pi turn: the seam under test
 * here is `BaseAgent`'s alone, shared by all four backends, and it needs no
 * subprocess to exercise.
 */
import { describe, expect, it } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import { TestAgent, createMockBackendConfig, collectEvents } from './test-utils.ts';
import { createMockCapabilityTurnRuntime } from './test-utils.ts';

function agent(): TestAgent {
  const created = new TestAgent(createMockBackendConfig());
  created.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
  created.scriptedEvents = [{ type: 'complete' } as AgentEvent];
  return created;
}

function applyDirectives(subject: TestAgent, decision: Record<string, unknown>): Promise<void> {
  return (subject as unknown as {
    applyHookSessionDirectives(decision: unknown): Promise<void>;
  }).applyHookSessionDirectives(decision);
}

describe('P6.297 — the inert SessionStart directives are reported, not swallowed', () => {
  it('warns once per field, on the next turn, naming the paths it will not watch', async () => {
    const subject = agent();
    await applyDirectives(subject, {
      initialUserMessage: 'review the diff',
      watchPaths: ['/tmp/a.ts', '/tmp/b.ts'],
    });
    // The values are still carried — this row adds a voice, it does not add a
    // consumer, and a reader that stopped storing them would be a regression.
    expect(subject.getCarriedHookSessionDirectives()).toEqual({
      initialUserMessage: 'review the diff',
      watchPaths: ['/tmp/a.ts', '/tmp/b.ts'],
    });

    const warnings = (await collectEvents(subject.chat('hello')))
      .filter(event => event.type === 'info' && event.level === 'warning')
      .map(event => (event as { message: string }).message);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('SessionStart hook');
    expect(warnings.some(message => message.includes('/tmp/a.ts, /tmp/b.ts'))).toBe(true);

    // Once per session: a hook that fires again on every resume states its fact
    // once instead of accumulating a column of identical lines.
    subject.scriptedEvents = [{ type: 'complete' } as AgentEvent];
    await applyDirectives(subject, { initialUserMessage: 'review the diff again' });
    expect((await collectEvents(subject.chat('hello again')))
      .filter(event => event.type === 'info' && event.level === 'warning')).toEqual([]);
    subject.destroy();
  });

  it('says nothing for the three directives that ARE honoured — the control', async () => {
    // Without this arm the case above is equally consistent with a turn that
    // warns whenever any hook decided anything. `sessionTitle` and
    // `reloadSkills` are live on all three runtimes and must stay silent.
    const subject = agent();
    await applyDirectives(subject, { sessionTitle: 'A title', reloadSkills: true });
    expect((await collectEvents(subject.chat('hello')))
      .filter(event => event.type === 'info' && event.level === 'warning')).toEqual([]);
    subject.destroy();
  });
});
