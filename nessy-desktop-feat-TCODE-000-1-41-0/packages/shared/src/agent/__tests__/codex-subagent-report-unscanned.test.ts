/**
 * P6.200 — a codex subagent's report reaches the parent model unscanned, and
 * until this notice nothing said so.
 *
 * The gap is STRUCTURAL: the child thread returns to the parent inside the
 * app-server, so no host code sits on that path (measured on the shipped binary
 * by W7-f: `subagent` 172 hits, `output_scan`/`scan_output`/`subagent_output`/
 * `instruction-shaped`/`harness:` 0 each, control `enabled_tools` 17). So the
 * deliverable is the honest sentence, and these cases are about WHEN it fires.
 *
 * WHAT EACH TEST KILLS:
 *  - "says it when a child thread of ours reports" dies if the mount is removed
 *    — the whole row.
 *  - "stays silent for a thread the adapter does not recognise" dies if the
 *    notice moves to the branch itself rather than to an ADMITTED event: a
 *    compaction thread or another session's thread would then make this session
 *    claim a subagent it never spawned.
 *  - "says it once" dies if the latch is dropped; a child streams many
 *    notifications per turn and the queue is eight deep.
 *  - "quotes the marker line the other two runtimes add" dies if the sentence
 *    is reworded into something a user cannot connect to what Pi writes.
 */
import { describe, expect, it } from 'bun:test';
import { SUBAGENT_MARKER_PREFIX } from '../../prompts/untrusted-text.ts';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

interface Event { type: string; message?: string; level?: string }

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-unscanned',
      name: 'Codex Unscanned Workspace',
      rootPath: '/tmp/ws-codex-unscanned-root',
      workspaceRootPath: '/tmp/ws-codex-unscanned-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-unscanned',
    } as any,
    session: {
      id: 'session-codex-unscanned',
      workspaceRootPath: '/tmp/ws-codex-unscanned-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/**
 * The agent with its thread pinned and the adapter's foreign-child reader
 * stubbed, which is the seam the notice hangs on. Stubbing it is the point:
 * `adaptForeignChildThread`'s own recognition is the event-adapter's contract
 * and has its own suite; what is under test here is that the notice follows an
 * ADMITTED event and nothing else.
 */
function harness(admit: (method: string) => Event[]) {
  const agent = new CodexAgent(createConfig());
  const events: Event[] = [];
  const internals = agent as unknown as {
    threadId: string | null;
    turnSink: { push: (e: Event) => void } | null;
    eventAdapter: { adaptForeignChildThread: (method: string, params: unknown) => Event[] };
    handleNotification: (method: string, params: unknown) => void;
  };
  internals.threadId = 'thread-parent';
  internals.turnSink = { push: (e: Event) => events.push(e) };
  internals.eventAdapter.adaptForeignChildThread = (method: string) => admit(method);
  return {
    events,
    notify: (method: string, threadId: string) =>
      internals.handleNotification(method, { threadId, turnId: 'turn-1' }),
  };
}

const CHILD_EVENT: Event = { type: 'info', message: 'child progress' };

describe('P6.200 · the codex subagent report is unscanned, and the session says so', () => {
  it('says it when a child thread of ours reports', () => {
    const h = harness(() => [CHILD_EVENT]);
    h.notify('item/completed', 'thread-child');
    const notice = h.events.find(e => e.message?.startsWith('Codex SUBAGENT REPORT UNSCANNED'));
    expect(notice).toBeDefined();
    expect(notice!.level).toBe('warning');
    // Ahead of the child's own events: the fact is about the reports that follow.
    expect(h.events[0]!.message).toBe(notice!.message);
  });

  it('quotes the marker line Pi and the claude SDK add, verbatim', () => {
    const h = harness(() => [CHILD_EVENT]);
    h.notify('item/completed', 'thread-child');
    const notice = h.events.find(e => e.message?.startsWith('Codex SUBAGENT REPORT UNSCANNED'))!;
    expect(notice.message).toContain(SUBAGENT_MARKER_PREFIX);
  });

  it('stays silent for a foreign thread the adapter does not recognise', () => {
    const h = harness(() => []);
    h.notify('item/completed', 'thread-someone-else');
    h.notify('turn/completed', 'thread-compaction');
    expect(h.events.filter(e => e.message?.startsWith('Codex SUBAGENT REPORT UNSCANNED'))).toHaveLength(0);
    // Positive control on the same rig: the same notification WITH an admitted
    // event does produce the notice, so the silence above is the filter and not
    // a broken harness.
    const live = harness(() => [CHILD_EVENT]);
    live.notify('item/completed', 'thread-child');
    expect(live.events.filter(e => e.message?.startsWith('Codex SUBAGENT REPORT UNSCANNED'))).toHaveLength(1);
  });

  it('says it once, however many child notifications arrive', () => {
    const h = harness(() => [CHILD_EVENT]);
    for (let i = 0; i < 12; i += 1) h.notify('item/completed', `thread-child-${i}`);
    expect(h.events.filter(e => e.message?.startsWith('Codex SUBAGENT REPORT UNSCANNED'))).toHaveLength(1);
  });
});
