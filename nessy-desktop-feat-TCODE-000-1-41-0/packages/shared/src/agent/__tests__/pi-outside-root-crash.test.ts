/**
 * F1.1287 (origin: lane PI-1's report, 2026-10-02, residue 2) — after a Pi subprocess CRASH the outside-root card's
 * host record stayed: counted, durable, and re-projected after a restart (R7), although the call that asked died
 * with the subprocess and the turn had already ended with "Pi subprocess exited unexpectedly". F1.1243 withdraws the
 * card on a Stop (forceAbort) and F1.1286 on `abort()`; a crash took neither path.
 *
 * Measured here first (the red arm): `handleSubprocessExit` denied the call and dropped the agent's entry but sent
 * the host nothing, so the card stayed. Decided (owner rule 2026-10-08): a crash counts as stopped — the card is
 * withdrawn through the same out-of-turn channel. A dispose for a restart (`rejectPendingSubprocessRequests` alone)
 * keeps R7's re-projection, as F1.1243 left it.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1287',
      name: 'F1.1287 Workspace',
      rootPath: '/tmp/nessy-f1287',
      workspaceRootPath: '/tmp/nessy-f1287',
      sessionRootPath: '/tmp/nessy-f1287-sessions/ws-f1287',
    } as any,
    session: {
      id: 'session-f1287',
      workspaceRootPath: '/tmp/nessy-f1287',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
  };
}

function rig() {
  const agent = new PiAgent(createConfig());
  const sent: Array<Record<string, unknown>> = [];
  const published: string[] = [];
  const withdrawn: string[] = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).debug = () => {};
  (agent as any).subprocess = {};
  (agent as any).emitAutomationEvent = async () => {};
  agent.onPermissionRequest = (request: any) => { published.push(request.requestId); };
  agent.onPermissionRequestWithdrawn = requestId => { withdrawn.push(requestId); };
  const ask = (requestId: string) => (agent as any).handleLine(JSON.stringify({
    type: 'outside_root_request', requestId, canonicalTarget: '/Users/x/other/note.txt', access: 'write',
  }));
  return { agent, sent, published, withdrawn, ask, dispose: () => { (agent as any).subprocess = null; agent.destroy(); } };
}

describe('F1.1287 · a Pi subprocess crash withdraws the outside-root card', () => {
  it('the crash denies the dead call AND withdraws its card from the host', async () => {
    const r = rig();
    try {
      await r.ask('pi-oroot-crash');
      expect(r.published).toEqual(['pi-oroot-crash']);
      (r.agent as any).handleSubprocessExit(1, null, null, (r.agent as any).subprocess, null);
      expect(r.withdrawn).toEqual(['pi-oroot-crash']);
      // The answer after the crash reaches nothing: no response is sent for a call that is gone.
      const before = r.sent.length;
      r.agent.respondToPermission('pi-oroot-crash', true, false);
      expect(r.sent.length).toBe(before);
    } finally {
      r.dispose();
    }
  });

  it('CONTROL: a dispose for a restart keeps R7\'s re-projection (no withdrawal)', async () => {
    const r = rig();
    try {
      await r.ask('pi-oroot-restart');
      (r.agent as any).rejectPendingSubprocessRequests(new Error('restarting for a config change'));
      expect(r.withdrawn).toEqual([]);
    } finally {
      r.dispose();
    }
  });
});
