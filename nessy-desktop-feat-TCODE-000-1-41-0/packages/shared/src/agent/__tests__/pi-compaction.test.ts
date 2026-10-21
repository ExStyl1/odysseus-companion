/**
 * UB2.3 (COR-3; craft-agents-oss #1058/#1060) — Pi's manual /compact is an RPC
 * with no agent loop behind it: a steer sent while it owns the turn vanishes,
 * so `redirect()` refuses (and the host queues), `isCompactionInFlight()` names
 * the state, the RPC deadline aborts the child, and a torn-down agent cancels
 * the pending request.
 *
 * Arms adapted from craft-agents-oss v0.15.1 `pi-compaction.test.ts`
 * (Apache-2.0) onto OUR shapes: our typed /compact answers with
 * `info(compactionTrigger: 'manual')` + `complete` (F1.241/F1.729), not
 * upstream's `compaction_failed` event, and our requestCompact rejections
 * surface as the turn's `error` — the assertions below read OUR contract.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig } from '../backend/types.ts';

const agents: PiAgent[] = [];

function makeAgent(): any {
  const agent = new PiAgent({
    provider: 'pi',
    providerType: 'pi',
    model: '',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: { id: 'pi-compact-ub2-3', name: 'UB2.3', rootPath: '/tmp/pi-compact-ub2-3' } as never,
  } as BackendConfig);
  agents.push(agent);
  (agent as any).ensureSubprocess = async () => {};
  return agent;
}

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
});

async function collect(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const result = {
  summary: 'summary',
  firstKeptEntryId: 'kept',
  tokensBefore: 419_000,
  estimatedTokensAfter: 12_000,
  contextUsage: { tokens: null, contextWindow: 500_000 },
};

describe('UB2.3 — Pi manual compaction RPC', () => {
  it('a successful manual /compact answers once, with the manual trigger, and completes', async () => {
    const agent = makeAgent();
    let finish!: () => void;
    const ready = new Promise<void>(resolve => {
      agent.send = (msg: any) => {
        if (msg.type !== 'compact') return;
        finish = () => agent.handleCompactResult({ type: 'compact_result', id: msg.id, success: true, result });
        resolve();
      };
    });
    const events: any[] = [];
    const done = (async () => { for await (const e of agent.chatImpl('/compact')) events.push(e); })();
    await ready;
    finish();
    await done;
    const info = events.find(e => e.type === 'info');
    expect(info?.compactionTrigger).toBe('manual');
    expect(events.at(-1).type).toBe('complete');
    expect(agent.pendingCompactions.size).toBe(0);
  });

  it('refuses to steer while a manual compaction owns the turn and reports it in flight (#1058)', async () => {
    const agent = makeAgent();
    const sent: any[] = [];
    let requestId!: string;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    agent.send = (msg: any) => { sent.push(msg); if (msg.type === 'compact') { requestId = msg.id; ready(); } };
    expect(agent.isCompactionInFlight()).toBe(false);
    const done = collect(agent.chatImpl('/compact'));
    await started;
    expect(agent.isCompactionInFlight()).toBe(true);

    // THE ARM THIS ROW EXISTS FOR: the steer is refused, nothing is sent into the
    // turn (no steer, no abort), and the compaction keeps running.
    expect(agent.redirect('follow-up question')).toBe(false);
    expect(sent.map((m: any) => m.type)).toEqual(['compact']);
    expect(agent.pendingCompactions.size).toBe(1);
    // F1.540 — the refusal disturbed nothing, so the host must not stamp
    // `wasInterrupted` on the queue entry it now holds.
    expect(agent.redirectFallbackInterruptsTurn()).toBe(false);

    agent.handleCompactResult({ id: requestId, success: true, result });
    const events = await done;
    expect(events.at(-1).type).toBe('complete');
    expect(agent.isCompactionInFlight()).toBe(false);
  });

  it('CONTROL — with no compaction in flight the steer is delivered as before', () => {
    const agent = makeAgent();
    const sent: any[] = [];
    agent.send = (msg: any) => { sent.push(msg); };
    (agent as any)._isProcessing = true;
    (agent as any).subprocess = {};
    expect(agent.isCompactionInFlight()).toBe(false);
    expect(agent.redirect('use the other endpoint')).toBe(true);
    expect(sent.map((m: any) => m.type)).toEqual(['steer']);
  });

  it('the host deadline rejects, aborts the child, and its late success lands nowhere (#1060)', async () => {
    const agent = makeAgent();
    agent.compactTimeoutMs = 20;
    const sent: any[] = [];
    agent.send = (msg: any) => { sent.push(msg); };
    const events = await collect(agent.chatImpl('/compact'));
    // The deadline both rejects locally and tells the subprocess to abort.
    expect(sent.map((m: any) => m.type)).toEqual(['compact', 'abort']);
    expect(agent.pendingCompactions.size).toBe(0);
    expect(events.some(e => e.type === 'error' && String(e.message).includes('timed out'))).toBe(true);
    expect(events.at(-1).type).toBe('complete');
    // A late success from the child no longer has a pending request to land on.
    agent.handleCompactResult({ id: sent[0].id, success: true, result });
    expect(agent.pendingCompactions.size).toBe(0);
  });

  it.each(['forceAbort', 'destroy'] as const)('cancels the pending manual RPC on %s and ignores its late success', async method => {
    const agent = makeAgent();
    let requestId!: string;
    let ready!: () => void;
    const sent = new Promise<void>(resolve => { ready = resolve; });
    agent.send = (msg: any) => { if (msg.type === 'compact') { requestId = msg.id; ready(); } };
    const done = collect(agent.chatImpl('/compact'));
    await sent;
    if (method === 'forceAbort') agent.forceAbort(AbortReason.UserStop);
    else await agent.destroy();
    expect(agent.pendingCompactions.size).toBe(0);
    agent.handleCompactResult({ id: requestId, success: true, result });
    const events = await done;
    expect(events.at(-1).type).toBe('complete');
    expect(events.some(e => e.type === 'info' && e.compactionTrigger === 'manual')).toBe(false);
  });
});
