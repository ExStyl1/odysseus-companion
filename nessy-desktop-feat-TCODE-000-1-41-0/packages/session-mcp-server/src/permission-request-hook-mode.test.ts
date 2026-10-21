/**
 * F1.532 — the host-authored floor hook follows the session's permission mode, and its refusal names a
 * remedy the user can take.
 *
 * Found by the 1.41.0 review (B-codex-runtime-1, CONFIRMED LOW). Codex runs a `PermissionRequest` hook
 * BEFORE its reviewer (`core/src/tools/approvals.rs`, "1. Hooks 2. … Guardian. Else, user"), and the
 * payload it hands the hook cannot say the session is in bypass: `hook_permission_mode`
 * (`core/src/hook_runtime.rs`, read at `rust-v0.154.0`) answers `bypassPermissions` only for approval
 * policy `never`, and this host runs bypassPermissions on `on-request` (`CODEX_PERMISSION_MODE_TABLE`),
 * so the payload says `default`. So F1.386's hook refused an unattended-automation edit in
 * bypassPermissions, where the host's own floor (`CodexAgent.unattendedAutomationEditFloor`) and the
 * Pi/claude gate skip it — and it told the user to turn auto-review off, which an administrator's
 * `allowed_approvals_reviewers` (F1.514) can make impossible.
 *
 * The mode therefore reaches the hook through a small state file the host writes where no agent command
 * can (F1.609) and rewrites on every mode change and every turn, named on the hook's command line
 * (`--state-file`). These arms drive the hook's own entry (`runPermissionRequestHook`) over that file;
 * the host's writer is `automation-floor-hook.ts`'s `codexAutomationFloorHookState`, pinned to this
 * reader in the last case.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as host from '@nessy-agent/shared/agent/backend/codex/automation-floor-hook';
import * as hook from './permission-request-hook.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'wjat-f1532-hook-'));
writeFileSync(join(ROOT, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}));
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

/** codex's `PermissionRequestRequest` wire: `permission_mode` is `default` for every on-request session. */
const REENABLE = {
  session_id: 's', turn_id: 't', cwd: ROOT, model: 'm', permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'mcp__session__automation_update',
  tool_input: { automationId: 'dormant-bypass', patch: { enabled: true } },
};

let stateFiles = 0;
/** A state file in the shape the host writes: `{ v, permissionMode, reviewerRequiredByPolicy }`. */
function stateFile(text: string): string {
  const path = join(ROOT, `state-${stateFiles++}.json`);
  writeFileSync(path, text);
  return path;
}
const state = (permissionMode: string, reviewerRequiredByPolicy = false) =>
  stateFile(JSON.stringify({ v: 1, permissionMode, reviewerRequiredByPolicy }));

function run(extraArgv: string[]) {
  const stderr: string[] = [];
  const code = hook.runPermissionRequestHook(
    ['--permission-request-hook', '--workspace-root', ROOT, ...extraArgv],
    JSON.stringify(REENABLE),
    text => stderr.push(text),
  );
  return { code, stderr: stderr.join('') };
}

describe('F1.532 · the floor hook reads the session mode the host wrote', () => {
  it('bypassPermissions: no verdict — the floor is skipped, as the host floor and the Pi/claude gate skip it', () => {
    expect(run(['--state-file', state('bypassPermissions')])).toEqual({ code: 0, stderr: '' });
  });

  it('CONTROL — default mode with auto-review on: refused as before, and the remedy is the Settings toggle', () => {
    const { code, stderr } = run(['--state-file', state('default')]);
    expect(code).toBe(2);
    expect(stderr).toContain('refused rather than reviewed');
    expect(stderr).toContain('Turn Codex auto-review off');
  });

  it('under an administrator policy that requires the reviewer, the refusal names the policy and never the toggle', () => {
    const { code, stderr } = run(['--state-file', state('default', true)]);
    expect(code).toBe(2);
    expect(stderr).toContain('refused rather than reviewed');
    expect(stderr).toContain("organisation's Codex policy");
    expect(stderr).not.toContain('Turn Codex auto-review off');
  });

  it('BOUNDARY — a state file that is missing, unreadable or of another shape keeps the floor (fails closed)', () => {
    for (const argv of [
      ['--state-file', join(ROOT, 'no-such-state.json')],
      ['--state-file', stateFile('not json')],
      ['--state-file', stateFile(JSON.stringify({ v: 2, permissionMode: 'bypassPermissions' }))],
      ['--state-file'],
      [],
    ]) {
      expect(run(argv).code).toBe(2);
    }
  });

  /**
   * F1.516 (3) (origin WJ-an P-WJ-an-3) — with no readable state file the hook cannot know WHO turned the
   * reviewer on: the Settings toggle, or an administrator's `allowed_approvals_reviewers` (F1.514). Its
   * refusal said "Codex auto-review is on … Turn Codex auto-review off" there, which a policy that requires
   * the reviewer does not allow. It now says both, in the words F1.514 gave the two session-facts notices,
   * with a remedy true under either.
   */
  it('BOUNDARY — with no readable state file the refusal names both ways the reviewer can be on, and a remedy true under either', () => {
    for (const argv of [
      ['--state-file', join(ROOT, 'no-such-state.json')],
      ['--state-file', stateFile('not json')],
      ['--state-file'],
      [],
    ]) {
      const { code, stderr } = run(argv);
      expect(code).toBe(2);
      expect(stderr).toContain('refused rather than reviewed');
      expect(stderr).toContain("Codex auto-review is on (in Settings, or required by your organisation's policy)");
      expect(stderr).toContain("Make the change yourself in the automation's configuration");
      expect(stderr).not.toContain('Turn Codex auto-review off to be asked instead');
    }
  });

  it('F1.781 — the host says the reviewer no longer answers (auto-review turned off live): no verdict, the host is asked', () => {
    const off = stateFile(JSON.stringify({ v: 1, permissionMode: 'default', reviewerRequiredByPolicy: false, reviewerAnswers: false }));
    expect(run(['--state-file', off])).toEqual({ code: 0, stderr: '' });
  });

  it('F1.781 CONTROL — any other reviewerAnswers value, the field absent included, keeps the floor', () => {
    for (const value of [true, 'false', 0, null]) {
      const file = stateFile(JSON.stringify({ v: 1, permissionMode: 'default', reviewerRequiredByPolicy: false, reviewerAnswers: value }));
      expect(run(['--state-file', file]).code).toBe(2);
    }
    expect(run(['--state-file', state('default')]).code).toBe(2);
  });

  it('the host writes exactly what this hook reads, under the flag this hook answers to', () => {
    const hostFlag = (host as Record<string, unknown>).CODEX_AUTOMATION_FLOOR_HOOK_STATE_FLAG;
    const hookFlag = (hook as Record<string, unknown>).PERMISSION_REQUEST_HOOK_STATE_FLAG;
    expect(hostFlag).toBe('--state-file');
    expect(hookFlag).toBe(hostFlag);
    const write = (host as Record<string, unknown>).codexAutomationFloorHookState as
      ((mode: string, reviewerRequiredByPolicy: boolean) => string) | undefined;
    expect(typeof write).toBe('function');
    expect(run(['--state-file', stateFile(write!('bypassPermissions', false))])).toEqual({ code: 0, stderr: '' });
    expect(run(['--state-file', stateFile(write!('acceptEdits', true))]).stderr).toContain("organisation's Codex policy");
    // F1.781 — the third argument is the reviewer still answering; `false` is the one value this hook steps aside for.
    const write3 = write as unknown as (mode: string, required: boolean, answers: boolean) => string;
    expect(run(['--state-file', stateFile(write3('default', false, false))])).toEqual({ code: 0, stderr: '' });
    expect(run(['--state-file', stateFile(write3('default', false, true))]).code).toBe(2);
  });
});
