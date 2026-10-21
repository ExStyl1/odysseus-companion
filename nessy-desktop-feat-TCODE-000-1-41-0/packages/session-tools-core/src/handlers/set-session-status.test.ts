/**
 * UA1.2 (OQ-6) — an agent cannot close a card.
 *
 * Copied and adapted from upstream craft-agents `v0.13.4:packages/session-tools-core/src/handlers/set-session-status.test.ts`
 * (Apache-2.0). Adapted: the fixture is OUR default status set (`backlog`, `todo`, `needs-review`, `done`,
 * `cancelled` — there is no `in-progress` status here), and the refusal is asserted by the shared sentence
 * {@link closedStatusRefusal}, which the codex bridge's host route answers with too (UA1.3).
 *
 * The guard is on the AGENT tool only. The host and UI path (`SessionManager.setSessionStatus`, reached by the
 * `setSessionStatus` RPC command, the Conductor and the mini-agent's auto-`done`) never runs this handler, so it
 * still closes — measured on the real `SessionManager` by
 * `packages/server-core/src/sessions/__tests__/agent-session-status-closure.test.ts`.
 */
import { describe, it, expect } from 'bun:test';
import { checkAgentSessionStatus, closedStatusRefusal, handleSetSessionStatus } from './set-session-status.ts';
import type { ResolvedStatusResult, SessionToolContext } from '../context.ts';

type StatusEntry = { id: string; label: string; category: 'open' | 'closed' };

const STATUSES: StatusEntry[] = [
  { id: 'backlog', label: 'Backlog', category: 'open' },
  { id: 'todo', label: 'Todo', category: 'open' },
  { id: 'needs-review', label: 'Needs Review', category: 'open' },
  { id: 'done', label: 'Done', category: 'closed' },
  { id: 'cancelled', label: 'Cancelled', category: 'closed' },
];

/** The host's `resolveStatusFn` shape (`SessionManager`): exact id first, then case-insensitive label. */
function resolveStatus(input: string): ResolvedStatusResult {
  const available = STATUSES.map((s) => s.id);
  const hit =
    STATUSES.find((s) => s.id === input) ??
    STATUSES.find((s) => s.label.toLowerCase() === input.toLowerCase());
  return hit ? { resolved: hit.id, available, category: hit.category } : { resolved: null, available };
}

function createCtx(): { ctx: SessionToolContext; sets: Array<{ sessionId?: string; status: string }> } {
  const sets: Array<{ sessionId?: string; status: string }> = [];
  const ctx = {
    setSessionStatus: (sessionId: string | undefined, status: string) => {
      sets.push({ sessionId, status });
    },
    resolveStatus,
  } as unknown as SessionToolContext;
  return { ctx, sets };
}

describe('handleSetSessionStatus — closed-status guard', () => {
  it('allows an open status (needs-review)', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'needs-review' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: undefined, status: 'needs-review' }]);
  });

  it('resolves an open status named by its label to its id (Needs Review)', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { sessionId: 'other', status: 'Needs Review' });
    expect(result.isError).toBeFalsy();
    expect(sets).toEqual([{ sessionId: 'other', status: 'needs-review' }]);
  });

  it('rejects a closed status (done) and does not write it', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'done' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`[ERROR] ${closedStatusRefusal('done')}`);
    expect(result.content[0]?.text).toContain('needs-review');
    expect(sets).toHaveLength(0);
  });

  it('rejects a closed status (cancelled) named by id', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'cancelled' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(`[ERROR] ${closedStatusRefusal('cancelled')}`);
    expect(sets).toHaveLength(0);
  });

  it('rejects a closed status resolved from a display label (Cancelled, Done)', async () => {
    for (const label of ['Cancelled', 'Done', 'DONE']) {
      const { ctx, sets } = createCtx();
      const result = await handleSetSessionStatus(ctx, { status: label });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Refusing to set the closed status');
      expect(sets).toHaveLength(0);
    }
  });

  it('still rejects an unknown status, naming the real ids', async () => {
    const { ctx, sets } = createCtx();
    const result = await handleSetSessionStatus(ctx, { status: 'in_progress' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown status');
    expect(result.content[0]?.text).toContain('backlog, todo, needs-review, done, cancelled');
    expect(sets).toHaveLength(0);
  });
});

describe('checkAgentSessionStatus — the one rule both sides apply', () => {
  it('passes an open status through as its resolved id', () => {
    expect(checkAgentSessionStatus('Todo', resolveStatus('Todo'))).toEqual({ status: 'todo' });
  });

  it('refuses closed and unknown with the handler\'s own sentences', () => {
    expect(checkAgentSessionStatus('Done', resolveStatus('Done'))).toEqual({ refusal: closedStatusRefusal('done') });
    const unknown = checkAgentSessionStatus('banana', resolveStatus('banana'));
    expect('refusal' in unknown && unknown.refusal.startsWith('Unknown status: "banana"')).toBe(true);
  });

  /**
   * CONTROL — the guard is keyed on CATEGORY, not on the two default ids: a workspace's own closed status is
   * refused too, and a resolver that reports no category (an older host) is not read as closed.
   */
  it('keys on category: a custom closed status is refused, a category-less resolution is not', () => {
    expect(checkAgentSessionStatus('shipped', { resolved: 'shipped', available: ['shipped'], category: 'closed' }))
      .toEqual({ refusal: closedStatusRefusal('shipped') });
    expect(checkAgentSessionStatus('todo', { resolved: 'todo', available: ['todo'] })).toEqual({ status: 'todo' });
  });
});
