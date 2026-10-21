/**
 * F1.482 (3) (origin WJ-rr-a's F1.386 residue, 2026-09-24) — when codex cannot
 * run the host-authored floor hook, the turn says what that meant.
 *
 * ## The source reading (`openai/codex@rust-v0.154.0`)
 *
 * `hooks/src/events/permission_request.rs` `parse_completed`: a run `error` (a
 * spawn failure, "hook timed out after {N}s", a failed stdin write), an exit
 * other than 0 or 2, an exit 2 with no stderr, and invalid JSON are each
 * `HookRunStatus::Failed` with an `Error` entry and NO decision;
 * `resolve_permission_request_decision` then returns `None`, and the module's own
 * header says what `None` does — "decline to decide and let the normal approval
 * flow continue". So a floor hook that cannot run refuses nothing and codex's
 * reviewer (auto-review on) answers the change: the hook fails OPEN.
 *
 * Before this row the user met codex's own line — "Hook config.toml failed:
 * Checking the unattended-automation floor / [error] hook timed out after 30s" —
 * and nothing said the change then went to the reviewer.
 *
 * ## Measured beside it (2026-09-24, not a pin)
 *
 * The hook's own cost, the session server built with the product's flags
 * (`bun build … --target=node --format=cjs`, 8.64 MB) and run as codex runs it
 * (`$SHELL -lc`, system node v24.4.1, load 8.7): 0.35 s real / 0.29 s user,
 * three runs, against the plan's 30 s timeout — so a timeout is not the expected
 * path on this rig; the packaged build's own node is a sitting reading.
 *
 * ## The pins
 *
 * - the detector: a FAILED run of this hook (an `[error]` entry) is one; a
 *   REFUSAL (`blocked`, `[feedback]` only — reported as `outcome: 'blocked'`
 *   since F1.515), a completed run, another hook's failure and another
 *   runtime's run are not;
 * - through the agent's own notification path (`hook/completed` → the event
 *   adapter → `recordHookRun`): the notice lands once, beside the adapter's line;
 * - CONTROL: the floor REFUSING the change says nothing extra.
 */
import { describe, expect, it } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';
import {
  CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE,
  CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE,
  codexAutomationFloorHookRunFailed,
} from '../backend/codex/automation-floor-hook.ts';

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1482-hook', name: 'F1.482 hook', rootPath: '/tmp/ws-f1482-hook',
      workspaceRootPath: '/tmp/ws-f1482-hook', sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-f1482-hook',
    },
    session: { id: 'session-f1482-hook', workspaceRootPath: '/tmp/ws-f1482-hook', createdAt: Date.now(), lastUsedAt: Date.now() },
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** A `hook/completed` notification in the generated `HookRunSummary` shape, for the floor hook unless told otherwise. */
function hookCompleted(status: string, entries: Array<{ kind: string; text: string }>, statusMessage = CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE) {
  return {
    threadId: 'thread-f1482',
    turnId: 'turn-1',
    run: {
      id: 'run-1', eventName: 'permissionRequest', handlerType: 'command', executionMode: 'sync', scope: 'turn',
      sourcePath: '/home/u/.codex/config.toml', source: 'user', displayOrder: 0, status, statusMessage,
      startedAt: 0, completedAt: 1, durationMs: 30_000, entries,
    },
  };
}

const TIMED_OUT = [{ kind: 'error', text: 'hook timed out after 30s' }];
const REFUSED = [{ kind: 'feedback', text: 'This change would alter what an unattended automation does.' }];

describe('F1.482 (3) · codexAutomationFloorHookRunFailed', () => {
  const observation = (outcome: 'error' | 'success' | 'timeout', output: string, extra: Record<string, unknown> = {}) =>
    ({ runtime: 'codex', event: 'permissionRequest', outcome, output, ...extra }) as never;

  it('a failed run of THIS hook is one — a timeout, a crash, a missing command', () => {
    for (const text of ['hook timed out after 30s', 'hook exited with code 1', 'No such file or directory (os error 2)']) {
      expect(codexAutomationFloorHookRunFailed(observation('error', `${CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE}\n[error] ${text}`))).toBe(true);
    }
  });

  it('CONTROL: a refusal, a completed run, another hook, another event and another runtime are not', () => {
    expect(codexAutomationFloorHookRunFailed(observation('error', `${CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE}\n[feedback] refused`))).toBe(false);
    expect(codexAutomationFloorHookRunFailed(observation('success', CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE))).toBe(false);
    expect(codexAutomationFloorHookRunFailed(observation('error', 'Checking something else\n[error] hook timed out after 30s'))).toBe(false);
    expect(codexAutomationFloorHookRunFailed(observation('error', `${CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE}\n[error] x`, { event: 'preToolUse' }))).toBe(false);
    expect(codexAutomationFloorHookRunFailed(observation('error', `${CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE}\n[error] x`, { runtime: 'pi' }))).toBe(false);
  });
});

describe('F1.482 (3) · through the agent\'s own hook/completed path', () => {
  function agent(): CodexAgent {
    const a = new CodexAgent(createConfig() as never);
    (a as any).debug = () => {};
    (a as any).threadId = 'thread-f1482';
    return a;
  }

  it('a timed-out floor hook: the notice is held for the turn, beside the run the store recorded', () => {
    const a = agent();
    try {
      (a as any).handleNotification('hook/completed', hookCompleted('failed', TIMED_OUT));
      expect((a as any).pendingServerWarningNotices).toEqual([CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE]);
      expect(CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE).toContain('refused nothing');
      expect(CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE).toContain('its reviewer answered in the floor\'s place');
    } finally { a.destroy(); }
  });

  it('inside a turn it lands on the turn, beside the adapter\'s own "Hook … failed" line', () => {
    const a = agent();
    try {
      const pushed: Array<{ type: string; message?: string }> = [];
      (a as any).turnSink = { push: (event: { type: string; message?: string }) => pushed.push(event) };
      (a as any).handleNotification('hook/completed', hookCompleted('failed', TIMED_OUT));
      const messages = pushed.filter(e => e.type === 'info').map(e => e.message ?? '');
      // The notice is raised while the adapter records the run, so it is pushed
      // just BEFORE the adapter's own line; the wording does not lean on the order.
      expect(messages).toHaveLength(2);
      expect(messages).toContain(CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE);
      expect(messages.find(m => m !== CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE)).toContain('hook timed out after 30s');
      expect(CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE).not.toContain('above');
    } finally { (a as any).turnSink = null; a.destroy(); }
  });

  it('CONTROL: the floor REFUSING the change, and another hook failing, add nothing', () => {
    const a = agent();
    try {
      (a as any).handleNotification('hook/completed', hookCompleted('blocked', REFUSED));
      (a as any).handleNotification('hook/completed', hookCompleted('failed', TIMED_OUT, 'Running my own check'));
      expect((a as any).pendingServerWarningNotices).toEqual([]);
    } finally { a.destroy(); }
  });
});
