import { describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolRuntime } from '../local-tools/runtime.ts';
import { PiAgent } from '../pi-agent.ts';
import { AbortReason, type BackendConfig } from '../backend/types.ts';
import type { AgentEvent } from '@nessy-agent/core/types';

/**
 * F1.957 (origin SIT-ak, RC #3, 2026-09-25) — an outside-root card outlived the Pi tool call that raised it.
 *
 * Measured live: a `Write` outside the session root raised "Allow write access outside the session root", the call
 * ended "Tool execution timed out" (twice), and both cards stayed on screen after the calls and the turn had ended.
 * The chain has three links and each is pinned where it lives:
 *   1. `LocalToolRuntime.scopedPath` hands the asking call's `abortSignal` to `requestOutsideRootApproval` (here);
 *   2. the subprocess drops the request and sends `outside_root_cancel` when that signal aborts
 *      (`pi-agent-server/src/local-tools/outside-root-call-end.test.ts`);
 *   3. `PiAgent.handleOutsideRootCancel` drops its pending entry and withdraws the host card (here).
 */

function outsideRig() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1957-ws-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1957-out-')));
  const asked: Array<{ canonicalTarget: string; access: string; signal: AbortSignal | undefined }> = [];
  const runtime = new LocalToolRuntime({
    filesystemScope: {
      session: { workspaceId: 'ws-f1957', sessionId: 'session-f1957' },
      primaryRoot: workspace,
      cwd: workspace,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g-f1957',
    },
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    guardLargeResults: false,
    // Never answered: the call can only end by its own signal, as the timed-out Write did.
    requestOutsideRootApproval: (canonicalTarget: string, access: string, signal?: AbortSignal) => {
      asked.push({ canonicalTarget, access, signal });
      return new Promise(() => {});
    },
  } as any);
  return {
    runtime,
    workspace,
    outside,
    asked,
    dispose: () => { for (const dir of [workspace, outside]) rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('F1.957 (1/2) — the outside-root request carries the asking call\'s signal', () => {
  it('a Write outside the root asks with the call\'s own abortSignal, and the call\'s end aborts it', async () => {
    const rig = outsideRig();
    try {
      const controller = new AbortController();
      const target = join(rig.outside, 'note2.txt');
      void rig.runtime.executeAuthorized({
        id: 'call-f1957-write',
        displayName: 'write',
        operation: { kind: 'write_file', path: target, content: 'x' },
        permission: { toolName: 'Write', input: { path: target }, type: 'file_write' },
        abortSignal: controller.signal,
      } as any);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(rig.asked).toHaveLength(1);
      expect(rig.asked[0]).toMatchObject({ canonicalTarget: target, access: 'write' });
      // The link the defect lacked: before F1.957 this was `undefined`, so no ending of the call reached the request.
      expect(rig.asked[0]!.signal).toBe(controller.signal);
      controller.abort();
      expect(rig.asked[0]!.signal?.aborted).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('BOUNDARY: a Read outside the root carries it too, and a path inside the root asks nothing', async () => {
    const rig = outsideRig();
    try {
      const controller = new AbortController();
      const outsideFile = join(rig.outside, 'report.txt');
      void rig.runtime.executeAuthorized({
        id: 'call-f1957-read',
        displayName: 'read',
        operation: { kind: 'read_file', path: outsideFile },
        permission: { toolName: 'Read', input: { path: outsideFile } },
        abortSignal: controller.signal,
      } as any);
      const inside = await rig.runtime.executeAuthorized({
        id: 'call-f1957-inside',
        displayName: 'write',
        operation: { kind: 'write_file', path: join(rig.workspace, 'inside.txt'), content: 'y' },
        permission: { toolName: 'Write', input: { path: 'inside.txt' }, type: 'file_write' },
        abortSignal: new AbortController().signal,
      } as any);
      expect(inside.isError).toBe(false);
      expect(rig.asked.map(entry => ({ canonicalTarget: entry.canonicalTarget, access: entry.access }))).toEqual([
        { canonicalTarget: outsideFile, access: 'read' },
      ]);
      expect(rig.asked[0]!.signal).toBe(controller.signal);
    } finally {
      rig.dispose();
    }
  });
});

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-f1957',
      name: 'F1.957 Workspace',
      rootPath: '/tmp/nessy-f1957',
      workspaceRootPath: '/tmp/nessy-f1957',
      sessionRootPath: '/tmp/nessy-f1957-sessions/ws-f1957',
    } as any,
    session: {
      id: 'session-f1957',
      workspaceRootPath: '/tmp/nessy-f1957',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    skipConfigWatcher: true,
  };
}

/** `pi-agent-sync-dispatch-belt.test.ts`'s rig, reduced: lines go through the real `handleLine`. */
function agentRig() {
  const agent = new PiAgent(createConfig());
  const sent: Array<Record<string, unknown>> = [];
  const published: Array<Record<string, unknown>> = [];
  const withdrawnOffTurn: string[] = [];
  const queued: AgentEvent[] = [];
  const diagnostics: string[] = [];
  (agent as any).send = (message: Record<string, unknown>) => { sent.push(message); };
  (agent as any).debug = (message: string) => { diagnostics.push(message); };
  (agent as any).subprocess = {};
  (agent as any).emitAutomationEvent = async () => {};
  agent.onPermissionRequest = (request: any) => { published.push(request); };
  agent.onPermissionRequestWithdrawn = requestId => { withdrawnOffTurn.push(requestId); };
  const eventQueue = (agent as any).eventQueue;
  const enqueue = eventQueue.enqueue.bind(eventQueue);
  eventQueue.enqueue = (event: AgentEvent) => { queued.push(event); enqueue(event); };
  const line = (message: Record<string, unknown>) => (agent as any).handleLine(JSON.stringify(message));
  return {
    agent,
    sent,
    published,
    withdrawnOffTurn,
    queued,
    diagnostics,
    line,
    dispose: () => { (agent as any).subprocess = null; agent.destroy(); },
  };
}

const cancelled = (queued: AgentEvent[]) => queued.filter(event => event.type === 'permission_request_cancelled');

describe('F1.957 (2/2) — the host withdraws the card when the asking call ended', () => {
  it('during the turn: the card leaves on the turn\'s own stream, and a later Deny or Allow sends nothing', async () => {
    const rig = agentRig();
    try {
      (rig.agent as any)._isProcessing = true;
      await rig.line({ type: 'outside_root_request', requestId: 'pi-oroot-t1', canonicalTarget: '/Users/x/sit-ak-out/note2.txt', access: 'write' });
      expect(rig.published).toHaveLength(1);
      await rig.line({ type: 'outside_root_cancel', requestId: 'pi-oroot-t1', reason: 'aborted' });
      expect(cancelled(rig.queued)).toEqual([{ type: 'permission_request_cancelled', requestId: 'pi-oroot-t1' }]);
      expect(rig.withdrawnOffTurn).toEqual([]);
      expect(rig.diagnostics.some(line => line.includes('F1.957: withdrew the outside-root write card for /Users/x/sit-ak-out/note2.txt'))).toBe(true);
      // No call waits any more: an answer reaching the agent now must neither reply nor grant a root.
      rig.agent.respondToPermission('pi-oroot-t1', true, true);
      expect(rig.sent).toEqual([]);
    } finally {
      rig.dispose();
    }
  });

  it('after the turn: the card leaves through the out-of-turn channel', async () => {
    const rig = agentRig();
    try {
      await rig.line({ type: 'outside_root_request', requestId: 'pi-oroot-t2', canonicalTarget: '/Users/x/out.txt', access: 'read' });
      (rig.agent as any)._isProcessing = false;
      await rig.line({ type: 'outside_root_cancel', requestId: 'pi-oroot-t2', reason: 'timed_out' });
      expect(rig.withdrawnOffTurn).toEqual(['pi-oroot-t2']);
      expect(cancelled(rig.queued)).toEqual([]);
      expect(rig.diagnostics.some(line => line.includes('asked timed out before an answer'))).toBe(true);
    } finally {
      rig.dispose();
    }
  });

  it('CONTROL: a card whose call still waits is not withdrawn, and a stray cancel changes nothing', async () => {
    const rig = agentRig();
    try {
      (rig.agent as any)._isProcessing = true;
      await rig.line({ type: 'outside_root_request', requestId: 'pi-oroot-live', canonicalTarget: '/Users/x/live.txt', access: 'write' });
      // The turn ends with the call still waiting (F1.900: a pending card survives an ordinary turn end).
      (rig.agent as any)._isProcessing = false;
      await rig.line({ type: 'outside_root_cancel', requestId: 'pi-oroot-unknown', reason: 'aborted' });
      expect(cancelled(rig.queued)).toEqual([]);
      expect(rig.withdrawnOffTurn).toEqual([]);
      // The live card still answers its call.
      rig.agent.respondToPermission('pi-oroot-live', false);
      expect(rig.sent).toEqual([{ type: 'outside_root_response', requestId: 'pi-oroot-live', root: null }]);
    } finally {
      rig.dispose();
    }
  });
});

/**
 * F1.1243 (CR-B, the final sitting 2026-10-01, SIT2-e FAIL 2) — a Stop with an outside-root card up took the card off
 * nothing: `forceAbort` denied the call (`outside_root_response root:null`) and dropped its pending entry, so the
 * call's own `outside_root_cancel` that followed found nothing to withdraw, and the host kept the record — counted,
 * persisted, re-shown after a restart, where one Allow re-drove the stopped call (R7). The Stop now withdraws it through
 * the out-of-turn channel (F1.369), which the host wires to `processEvent`'s `permission_request_cancelled` arm.
 */
describe('F1.1243 — a Stop takes the outside-root card off the host', () => {
  for (const reason of [AbortReason.UserStop, AbortReason.Redirect]) {
    it(`THE DEFECT (${reason}) — the call is denied, the card is withdrawn once, and the call's late cancel adds nothing`, async () => {
      const rig = agentRig();
      try {
        (rig.agent as any)._isProcessing = true;
        await rig.line({ type: 'outside_root_request', requestId: 'pi-oroot-stop', canonicalTarget: '/Users/x/stop.txt', access: 'write' });
        expect(rig.published).toHaveLength(1);
        rig.agent.forceAbort(reason);
        expect(rig.sent).toContainEqual({ type: 'outside_root_response', requestId: 'pi-oroot-stop', root: null });
        expect(rig.withdrawnOffTurn).toEqual(['pi-oroot-stop']);
        // The aborted call's own end reaches the host afterwards: a no-op, not a second withdrawal.
        await rig.line({ type: 'outside_root_cancel', requestId: 'pi-oroot-stop', reason: 'aborted' });
        expect(rig.withdrawnOffTurn).toEqual(['pi-oroot-stop']);
        expect(cancelled(rig.queued)).toEqual([]);
      } finally {
        rig.dispose();
      }
    });
  }

  it('F1.1286 — the AgentBackend `abort()` member withdraws the card the same way (no caller today; a future one inherits it)', async () => {
    const rig = agentRig();
    try {
      (rig.agent as any)._isProcessing = true;
      await rig.line({ type: 'outside_root_request', requestId: 'pi-oroot-abort', canonicalTarget: '/Users/x/abort.txt', access: 'write' });
      expect(rig.published).toHaveLength(1);
      await rig.agent.abort('test');
      expect(rig.sent).toContainEqual({ type: 'outside_root_response', requestId: 'pi-oroot-abort', root: null });
      expect(rig.withdrawnOffTurn).toEqual(['pi-oroot-abort']);
    } finally {
      rig.dispose();
    }
  });

  it('BOUNDARY — an answered card is not withdrawn by a later Stop, and a Stop with no card withdraws nothing', async () => {
    const rig = agentRig();
    try {
      (rig.agent as any)._isProcessing = true;
      await rig.line({ type: 'outside_root_request', requestId: 'pi-oroot-answered', canonicalTarget: '/Users/x/a.txt', access: 'read' });
      rig.agent.respondToPermission('pi-oroot-answered', false);
      rig.agent.forceAbort(AbortReason.UserStop);
      expect(rig.withdrawnOffTurn).toEqual([]);
    } finally {
      rig.dispose();
    }
  });
});
