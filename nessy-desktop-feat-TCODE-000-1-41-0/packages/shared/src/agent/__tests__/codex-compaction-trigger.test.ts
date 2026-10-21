/**
 * F1.467 — codex's compaction info says WHICH compaction it reports, so F1.241's readiness
 * rule (only a MANUAL compaction marks an Accept & Compact plan ready) holds on codex too.
 *
 * What codex's protocol reports at the pinned tag (`packages/codex-protocol/manifest.json`,
 * `rust-v0.154.0`): the `contextCompaction` thread item is `{ type, id }` and the deprecated
 * `thread/compacted` notification is `{ threadId, turnId }` — neither carries a trigger, and
 * no `Turn` field names a compact turn. The one thing that knows is the host: it asks for a
 * manual compaction with `thread/compact/start`, and `manualCompactionRequestedForTurn` is
 * already the flag codex's `PostCompact` hook reads its documented `trigger` from (P6.118).
 * So the compaction info is stamped from that SAME flag, read at the same moment — the info
 * and the hook can never disagree — and a compaction the host did not ask for is `auto`.
 *
 * Before F1.467 the info was unstamped, and `SessionManager`'s gate (`!== 'auto'`) read every
 * codex compaction — codex's own token-budget one included — as a manual one.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexEventAdapter } from '../backend/codex/event-adapter.ts';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-compaction-trigger',
      name: 'Codex Compaction Trigger Workspace',
      rootPath: '/tmp/ws-codex-compaction-trigger',
      workspaceRootPath: '/tmp/ws-codex-compaction-trigger',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-compaction-trigger',
    } as never,
    session: {
      id: 'session-codex-compaction-trigger',
      workspaceRootPath: '/tmp/ws-codex-compaction-trigger',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Pushed { type: string; message?: string; compactionTrigger?: string }

function harness() {
  const agent = new CodexAgent(createConfig());
  const pushed: Pushed[] = [];
  const hooks: Array<{ event: string; input: Record<string, unknown> }> = [];
  const internals = agent as unknown as {
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>;
    handleNotification: (method: string, params: unknown) => void;
    manualCompactionRequestedForTurn: boolean;
    turnSink: { push: (event: Pushed) => void } | null;
    debug: (message: string) => void;
  };
  internals.emitAutomationEvent = async (event, input) => { hooks.push({ event, input }); return undefined; };
  internals.debug = () => {};
  internals.turnSink = { push: event => { pushed.push(event); } };
  const compactedInfos = () => pushed.filter(event => event.type === 'info' && event.message?.startsWith('Compacted'));
  const postCompactTriggers = () => hooks.filter(hook => hook.event === 'PostCompact').map(hook => hook.input.trigger);
  return { internals, compactedInfos, postCompactTriggers, destroy: () => agent.destroy() };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('F1.467 · a codex compaction info carries its trigger', () => {
  it('a compaction the host did not ask for is auto — on the info AND on PostCompact', async () => {
    const h = harness();
    try {
      h.internals.manualCompactionRequestedForTurn = false;
      h.internals.handleNotification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
      await settle();
      expect(h.compactedInfos()).toEqual([
        { type: 'info', message: 'Compacted context to fit within limits', compactionTrigger: 'auto' },
      ]);
      expect(h.postCompactTriggers()).toEqual(['auto']);
    } finally { h.destroy(); }
  });

  it('the /compact the host asked for is manual, and the NEXT compaction is auto again', async () => {
    const h = harness();
    try {
      h.internals.manualCompactionRequestedForTurn = true;
      h.internals.handleNotification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
      h.internals.handleNotification('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' });
      await settle();
      expect(h.compactedInfos().map(info => info.compactionTrigger)).toEqual(['manual', 'auto']);
      expect(h.postCompactTriggers()).toEqual(['manual', 'auto']);
    } finally { h.destroy(); }
  });

  it('the contextCompaction item channel is stamped the same way', async () => {
    const h = harness();
    try {
      h.internals.manualCompactionRequestedForTurn = false;
      h.internals.handleNotification('item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'contextCompaction', id: 'compaction-1' },
      });
      await settle();
      expect(h.compactedInfos().map(info => info.compactionTrigger)).toEqual(['auto']);
    } finally { h.destroy(); }
  });

  it('BOUNDARY: the adapter alone, with no host to ask, says nothing rather than guess', () => {
    const adapter = new CodexEventAdapter();
    const events = adapter.adapt('thread/compacted', { threadId: 'thread-1', turnId: 'turn-1' }) as unknown as Array<Record<string, unknown>>;
    const info = events.find(event => event.type === 'info')!;
    expect(info).toEqual({ type: 'info', message: 'Compacted context to fit within limits' });
    expect('compactionTrigger' in info).toBe(false);
  });
});
