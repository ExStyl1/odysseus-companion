/**
 * F1.170 — a codex permission card the HOST withdraws tells the host so.
 *
 * ## What was wrong
 *
 * `permission_request_cancelled` is the event the host already has for "this
 * card is gone": `SessionManager.processEvent` routes it into
 * `removePendingPermissionRequest`, which deletes the in-memory record, clears
 * the durable `pendingApproval` (the one an app restart re-presents) and tells
 * the renderer. Census at `80d79caa8` (`git grep -ao "type:
 * 'permission_request_cancelled'"`, positive control `type: 'error'`): pi-agent
 * 1, the claude deadline module 1, **codex-agent 0**. So a codex card withdrawn
 * by a Stop, an abort or a runtime restart settled codex's own request (as an
 * abort — `denyPendingApprovals`) and left the host's record, the durable
 * `pendingApproval` and the card on screen behind it: a card for a request
 * nobody is waiting on, re-presented after a restart, whose click is a no-op.
 *
 * ## The rig
 *
 * The real `CodexAgent`, its real approval bridge (`handleServerRequest`) and
 * its real teardown entry points (`forceAbort`, `abort`). The one planted piece
 * is the turn sink, and production HAS one at this moment: codex raises an
 * approval only inside a turn, and `chatImpl` sets `turnSink` for exactly the
 * life of that turn — the three teardowns finish it right after settling the
 * cards, which is why a push there reaches the host.
 *
 * The shape is the frozen one (`adjacent-backend-frozen-contract.test.ts`,
 * `required: ['requestId']`) and the one Pi's positive arm asserts
 * (`pi-agent-ask-user.test.ts`).
 */
import { describe, expect, it } from 'bun:test';
import { AbortReason, type BackendConfig, type PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const WORKSPACE_ROOT = '/tmp/nessy-codex-withdrawal-ws';
const PROJECT_CWD = '/tmp/nessy-codex-withdrawal-project';
const EXEC_METHOD = 'item/commandExecution/requestApproval';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-withdrawal',
      name: 'Withdrawal Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: '/tmp/nessy-codex-withdrawal-sessions/ws-withdrawal',
    } as any,
    session: {
      id: 'session-withdrawal',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT_CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

type SinkEvent = { type: string; requestId?: string };

/** A codex session mid-turn with ONE approval card on screen. */
function sessionWithCard() {
  const agent = new CodexAgent(createConfig());
  const events: SinkEvent[] = [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.getPermissionManager().setCapabilityPermissionLayers([], 'generation-f1170', true);
  (agent as unknown as { turnSink: { push: (e: SinkEvent) => void; finish: () => void } | null }).turnSink = {
    push: e => { events.push(e); },
    finish: () => {},
  };
  const answer = (agent as any).handleServerRequest(EXEC_METHOD, { command: 'git status', cwd: PROJECT_CWD }) as Promise<Record<string, unknown>>;
  return { agent, events, surfaced, answer };
}

const cancelled = (events: SinkEvent[]) => events.filter(e => e.type === 'permission_request_cancelled');

describe('F1.170 — a codex card the host withdraws is withdrawn from the host too', () => {
  it('a user Stop (forceAbort) withdraws the card it settles', async () => {
    const { agent, events, surfaced, answer } = sessionWithCard();
    expect(surfaced).toHaveLength(1);

    agent.forceAbort(AbortReason.UserStop);

    // codex's own request is settled as a teardown, exactly as before.
    expect(await answer).not.toEqual({ decision: 'accept' });
    expect((agent as any).pendingApprovals.size).toBe(0);
    // …and the host is told, in the frozen shape.
    expect(cancelled(events)).toEqual([{ type: 'permission_request_cancelled', requestId: surfaced[0]!.requestId }]);
  });

  it('an abort() withdraws the card it settles', async () => {
    const { agent, events, surfaced, answer } = sessionWithCard();

    await agent.abort();

    expect(await answer).not.toEqual({ decision: 'accept' });
    expect(cancelled(events)).toEqual([{ type: 'permission_request_cancelled', requestId: surfaced[0]!.requestId }]);
  });

  /**
   * CONTROL. A card the user already ANSWERED is not withdrawn: the answer path
   * removed it, the host cleared it on the answer, and a second event for the
   * same id would be a withdrawal of nothing. Without this arm, "the Stop emits
   * a cancel" is equally satisfied by a teardown that cancels every id it ever
   * saw.
   */
  it('an answered card is NOT withdrawn by the Stop that follows', async () => {
    const { agent, events, surfaced, answer } = sessionWithCard();
    agent.respondToPermission(surfaced[0]!.requestId, true);
    expect(await answer).toEqual({ decision: 'accept' });

    agent.forceAbort(AbortReason.UserStop);

    expect(cancelled(events)).toEqual([]);
  });
});
