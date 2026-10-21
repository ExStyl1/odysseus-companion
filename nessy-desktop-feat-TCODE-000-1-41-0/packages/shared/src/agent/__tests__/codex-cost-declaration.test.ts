/**
 * P2.195 — CODEX SAYS OUT LOUD THAT IT CANNOT PRICE A TURN.
 *
 * `BaseAgent.reportsCostUsd()` (P2.128) is the per-RUNTIME half of the budget
 * honesty surface: `classifyEventCost` can only answer from what an event
 * CARRIES, so a `complete` with no `usage` object at all is `absent` — the same
 * verdict a `status` event gets — and `takeUnenforceableBudgetNotice` stays
 * silent. On a runtime that never establishes a USD figure, that silence means
 * a configured `maxBudgetUsd` reads as a satisfied budget check forever.
 *
 * Codex is such a runtime: the app-server's token-usage payload carries token
 * counts and no money field at all, which is why `withCodexUsage` stamps
 * `costReporting: 'unsupported'` on every `complete` it decorates. But it
 * decorates NOTHING until `thread/tokenUsage/updated` has fed the tracker
 * (`getLastMessageUsage()` starts `null`), so an ordinary turn that ends before
 * any token-usage notification yields a BARE `complete` — the `absent` hole.
 *
 * THE DISTINCTION THESE TESTS KEEP (P2.128's control, restated because
 * collapsing it is the one change that breaks healthy sessions): the question is
 * whether the RUNTIME can price, never whether one completion carried usage.
 * `claude-agent.ts` and `pi-agent.ts` both emit usage-less `complete`s on error
 * and abort paths and CAN price; making every usage-less `complete` unavailable
 * would latch a false "your limit cannot be enforced" on the runtimes whose cap
 * actually works.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent } from '../codex-agent.ts';
import {
  TestAgent,
  collectEvents,
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
} from './test-utils.ts';

const WORKSPACE_ID = 'ws-cost-declaration';
const SESSION_ID = 'session-cost-declaration';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Cost Declaration Workspace',
      rootPath: '/tmp/ws-cost-declaration-root',
      workspaceRootPath: '/tmp/ws-cost-declaration-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-cost-declaration',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-cost-declaration-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/**
 * Stand in for the app-server. `tokenUsage` decides whether the turn is
 * preceded by a `thread/tokenUsage/updated` notification — i.e. whether
 * `withCodexUsage` has a snapshot to decorate the `complete` with.
 */
function stubTransport(agent: CodexAgent, tokenUsage?: unknown): void {
  const client = {
    request(method: string) {
      if (method === 'turn/start') {
        queueMicrotask(() => {
          if (tokenUsage !== undefined) {
            (agent as any).handleNotification('thread/tokenUsage/updated', { tokenUsage });
          }
          (agent as any).handleNotification('turn/completed', {});
        });
      }
      return Promise.resolve({ thread: { id: 'thread-1' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = 'thread-1';
  };
}

function codexAgentWithBudget(maxBudgetUsd: number, tokenUsage?: unknown): CodexAgent {
  cleanupModeState(SESSION_KEY);
  const agent = new CodexAgent(createConfig());
  stubTransport(agent, tokenUsage);
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    provider: 'codex-runtime',
  }));
  ;(agent as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => maxBudgetUsd;
  return agent;
}

function noticesIn(events: AgentEvent[]): AgentEvent[] {
  return events.filter(event => event.type === 'info' && (event as { level?: string }).level === 'warning');
}

function messageOf(event: AgentEvent): string {
  return (event as unknown as { message: string }).message;
}

describe('P2.195 — codex declares that it never reports cost', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('says the ceiling cannot be enforced when the turn carried no usage at all', async () => {
    // No `thread/tokenUsage/updated`, so `withCodexUsage` returns the adapter's
    // bare `complete` undecorated — `classifyEventCost` = `absent`. Before the
    // declaration this was silence, and a $5 ceiling read as satisfied.
    const agent = codexAgentWithBudget(5);
    try {
      const events = await collectEvents(agent.chat('hi'));

      const notices = noticesIn(events);
      expect(notices).toHaveLength(1);
      expect(messageOf(notices[0]!)).toContain('$5');
      // The unmetered wording, not the per-turn one: on codex it is permanent.
      expect(messageOf(notices[0]!)).toContain('does not report spending');
    } finally {
      // In a `finally` so a failing assertion above cannot leak the agent, and
      // cannot leave the module-scope capability runtime pointing at a destroyed
      // one for whatever test runs next.
      agent.setCapabilityTurnRuntime(null);
      agent.destroy();
    }
  });

  it('says it about the RUNTIME even when a usage notification arrived with no `last`', async () => {
    // The sub-case the test above does NOT reach. `handleNotification` feeds the
    // tracker only `if (usage?.last)`, so a `thread/tokenUsage/updated` that
    // carries a context window and no breakdown sets the context window and
    // leaves `getLastMessageUsage()` null — the `complete` is still bare, so the
    // permanent wording is still the right one. "No notification at all" does not
    // cover it: loosen that guard to `if (usage)` and every other test in this
    // file stays green while this one fails on the wording, because the tracker
    // would then hold a zeroed snapshot and the turn would look merely
    // unpriced-this-time.
    const agent = codexAgentWithBudget(5, { modelContextWindow: 32_000 });
    try {
      const events = await collectEvents(agent.chat('hi'));

      const notices = noticesIn(events);
      expect(notices).toHaveLength(1);
      expect(messageOf(notices[0]!)).toContain('does not report spending');
    } finally {
      agent.setCapabilityTurnRuntime(null);
      agent.destroy();
    }
  });

  it('keeps saying it about the RUNTIME, so a decorated turn gets the SAME permanent wording', async () => {
    // With a snapshot in the tracker the `complete` IS decorated, and its
    // `costReporting: 'unsupported'` classifies as `unavailable` — a path that
    // already fired before this row.
    //
    // This assertion USED to pin the per-turn sentence, and its own comment said
    // so: *"if you are executing P2.238, this assertion is expected to change to
    // the permanent wording, and its green is not a reason to leave it alone."*
    // P2.238 landed in `90fbcfc1e`, which keyed `notMetered` on the runtime's own
    // declaration (`!reportsCostUsd() && (absent || unavailable)`) instead of on
    // whether a `thread/tokenUsage/updated` had arrived first — so the wording no
    // longer depends on notification TIMING, which was the whole defect. The case
    // is now what the row always meant it to be: the decorated turn and the bare
    // one say the identical thing about the identical runtime.
    const agent = codexAgentWithBudget(5, { last: { inputTokens: 10, outputTokens: 20 }, modelContextWindow: 32_000 });
    try {
      const events = await collectEvents(agent.chat('hi'));

      const notices = noticesIn(events);
      expect(notices).toHaveLength(1);
      expect(messageOf(notices[0]!)).toContain('does not report spending');
      // The predecessor asserted ABSENT beside the successor: without this pair a
      // regression back to the timing-keyed rule would leave the case green on
      // the arm above and silent here, which is exactly how it went red.
      expect(messageOf(notices[0]!)).not.toContain('reported no cost for the turn');
    } finally {
      agent.setCapabilityTurnRuntime(null);
      agent.destroy();
    }
  });

  it('CONTROL: a bare complete on a runtime that CAN price still says nothing', async () => {
    // The mutation this kills, and the reason the fix is a per-runtime
    // declaration instead of a change to `classifyEventCost`: claude and pi emit
    // usage-less completes on error and abort paths, and a collapsed rule would
    // latch a false notice on them for the rest of the session.
    const metered = new TestAgent(createMockBackendConfig());
    metered.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime());
    metered.scriptedEvents = [{ type: 'complete' }];
    ;(metered as unknown as { getMaxBudgetUsd(): number }).getMaxBudgetUsd = () => 5;

    try {
      const events = await collectEvents(metered.chat('hi'));
      expect(noticesIn(events)).toHaveLength(0);
    } finally {
      metered.setCapabilityTurnRuntime(null);
      metered.destroy();
    }
  });
});
