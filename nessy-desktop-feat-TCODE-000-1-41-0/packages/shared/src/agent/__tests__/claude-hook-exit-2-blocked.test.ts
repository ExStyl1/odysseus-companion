/**
 * F1.516 item (2) (origin WJ-an P-WJ-an-2) — a claude hook that REFUSED reads
 * "blocked the action", not "failed", as codex's has since F1.515 (`44f426515`).
 *
 * `hooks.md#exit-code-2`, verbatim: "Exit 2 means a blocking error. On events that
 * can block, exit 2 blocks whether or not you print JSON". The SDK's own
 * `hook_response.outcome` has no word for it (`'success' | 'error' | 'cancelled'`
 * in the vendored `sdk.d.ts`), and the shipped binary emits every blocking run as
 * `exit_code: 2, outcome: 'error'` (read at 2.1.267: each `outcome:"blocking"` yield
 * is preceded by a `hook_response` carrying `exitCode:2,outcome:"error"`). So the
 * adapter maps `error` + exit 2 to `blocked` — but only on an event the page's
 * table ("Exit code 2 behavior per event") says CAN block: on the others exit 2
 * is not a block, and "failed" stays the honest word.
 *
 * CONTROLS: exit 1 on PreToolUse still reads "failed" (the page: "Claude Code
 * treats exit code 1 as a non-blocking error"); exit 2 on a can-not-block event
 * (PostToolUse, SessionStart, PermissionRequest) still reads "failed"; and the
 * binary's one measured exit-2 NON-block — a Stop-family hook whose script is
 * missing (empty stdout, stderr "can't open file"/"No such file") — still reads
 * "failed".
 */
import { describe, expect, it } from 'bun:test';
import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import type { HookRunObservation } from '../hook-run-report.ts';

function adapterWith(runs: HookRunObservation[]): ClaudeEventAdapter {
  const callbacks: ClaudeAdapterCallbacks = {
    onDebug: undefined,
    onHookRun: observation => { runs.push(observation) },
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: { code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false },
    }),
  };
  return new ClaudeEventAdapter(callbacks);
}

async function run(patch: Record<string, unknown>) {
  const runs: HookRunObservation[] = [];
  const events = await adapterWith(runs).adapt({
    type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'guard',
    hook_event: 'PreToolUse', output: '', stdout: '', stderr: '', outcome: 'error',
    uuid: 'u', session_id: 's', ...patch,
  } as never);
  const messages = events.map(event => (event as { message?: string }).message);
  return { outcome: runs[0]?.outcome, messages };
}

describe('F1.516 (2) · a claude exit 2 on an event that can block reads "blocked"', () => {
  it('PreToolUse exit 2 → blocked the action, in the transcript line and the run record', async () => {
    expect(await run({ exit_code: 2, stderr: 'Blocked: rm commands are not allowed' })).toEqual({
      outcome: 'blocked',
      messages: ['Hook guard blocked the action (exit 2): Blocked: rm commands are not allowed'],
    });
  });

  it('Stop, UserPromptSubmit and PreCompact exit 2 → blocked (each a "Yes" row of the page table)', async () => {
    for (const hook_event of ['Stop', 'UserPromptSubmit', 'PreCompact']) {
      expect({ hook_event, ...(await run({ hook_event, exit_code: 2, stderr: 'keep going' })) }).toEqual({
        hook_event,
        outcome: 'blocked',
        messages: ['Hook guard blocked the action (exit 2): keep going'],
      });
    }
  });

  it('CONTROL: PreToolUse exit 1 is a non-blocking error and still reads "failed"', async () => {
    expect(await run({ exit_code: 1, stderr: 'oops' })).toEqual({
      outcome: 'error',
      messages: ['Hook guard failed (exit 1): oops'],
    });
  });

  it('CONTROL: exit 2 on an event that can NOT block still reads "failed"', async () => {
    for (const hook_event of ['PostToolUse', 'SessionStart', 'PermissionRequest']) {
      expect({ hook_event, ...(await run({ hook_event, exit_code: 2, stderr: 'late' })) }).toEqual({
        hook_event,
        outcome: 'error',
        messages: ['Hook guard failed (exit 2): late'],
      });
    }
  });

  it("CONTROL: the binary's missing-script exit 2 on a Stop hook is non-blocking and still reads \"failed\"", async () => {
    expect(await run({
      hook_event: 'Stop', exit_code: 2, stdout: '', stderr: "python3: can't open file '/p/hook.py': [Errno 2] No such file or directory",
    })).toEqual({
      outcome: 'error',
      messages: ["Hook guard failed (exit 2): python3: can't open file '/p/hook.py': [Errno 2] No such file or directory"],
    });
  });

  it('CONTROL: success and cancelled are unchanged', async () => {
    expect((await run({ exit_code: 0, outcome: 'success' })).outcome).toBe('success');
    expect((await run({ outcome: 'cancelled' })).outcome).toBe('cancelled');
  });
});
