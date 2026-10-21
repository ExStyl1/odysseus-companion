/**
 * F1.386 — the host-authored `PermissionRequest` hook's own contract: a floored
 * automation edit answers exit 2 with the reason on stderr (codex's
 * `Deny { message }`), everything else exit 0 with nothing written (no verdict).
 * The binary's reading of the hook, end to end, is
 * `shared/src/mcp/__tests__/codex-automation-floor-hook-live.test.ts`.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_AUTOMATION_FLOOR_HOOK_FLAG, codexAutomationFloorHookCommand } from '@nessy-agent/shared/agent/backend/codex/automation-floor-hook';
import { PERMISSION_REQUEST_HOOK_FLAG, permissionRequestHookDenial, runPermissionRequestHook } from './permission-request-hook.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'wjrr-f1386-hook-'));
writeFileSync(join(ROOT, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
      { id: 'tidy', name: 'Tidy', cron: '0 4 * * *', permissionMode: 'acceptEdits', actions: [{ type: 'prompt', prompt: 'old' }] },
      // F1.1166 — saved before F1.1050 (explore) and before the vocabulary flip (ask, allow-all).
      { id: 'retired-explore', cron: '0 6 * * *', permissionMode: 'explore', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
      { id: 'legacy-ask', cron: '0 7 * * *', permissionMode: 'ask', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
      { id: 'legacy-allow-all', name: 'Purge', cron: '0 8 * * *', permissionMode: 'allow-all', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}));
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

/** codex's `PermissionRequestRequest` wire, the fields this hook reads. */
const payload = (toolName: string, toolInput: unknown) => ({
  session_id: 's', turn_id: 't', cwd: ROOT, model: 'm', permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput,
});
const REENABLE = { automationId: 'dormant-bypass', patch: { enabled: true } };
const RENAME = { automationId: 'dormant-bypass', patch: { name: 'Weekly purge (renamed)' } };

function run(input: unknown, argv: string[] = ['--permission-request-hook', '--workspace-root', ROOT]) {
  const stderr: string[] = [];
  const code = runPermissionRequestHook(argv, typeof input === 'string' ? input : JSON.stringify(input), t => stderr.push(t));
  return { code, stderr: stderr.join('') };
}

describe('F1.386 · the automation floor as a PermissionRequest hook', () => {
  it('a floored edit (re-enabling a bypass-mode automation) exits 2 with the reason on stderr', () => {
    for (const name of ['mcp__session__automation_update', 'automation_update']) {
      const { code, stderr } = run(payload(name, REENABLE));
      expect(code).toBe(2);
      expect(stderr).toContain('"Weekly purge" (dormant-bypass)');
      expect(stderr).toContain('bypassPermissions mode');
      expect(stderr).toContain('refused rather than reviewed');
    }
  });

  it('CONTROL: a non-floored automation_update (a rename; an automation under the ceiling) gives no verdict', () => {
    expect(run(payload('mcp__session__automation_update', RENAME))).toEqual({ code: 0, stderr: '' });
    expect(run(payload('mcp__session__automation_update', { automationId: 'tidy', patch: { cron: '0 6 * * *' } })))
      .toEqual({ code: 0, stderr: '' });
    expect(permissionRequestHookDenial(payload('mcp__session__automation_update', RENAME), ROOT)).toBeNull();
  });

  it('CONTROL: another tool, an unreadable payload, a missing root or a missing file give no verdict', () => {
    expect(run(payload('mcp__session__automation_create', REENABLE))).toEqual({ code: 0, stderr: '' });
    expect(run('not json')).toEqual({ code: 0, stderr: '' });
    expect(run(payload('mcp__session__automation_update', REENABLE), ['--permission-request-hook'])).toEqual({ code: 0, stderr: '' });
    expect(permissionRequestHookDenial(payload('automation_update', REENABLE), join(ROOT, 'nowhere'))).toBeNull();
  });
});

describe('F1.1166 · the hook ranks a stored retired or legacy mode as the store reads it', () => {
  it('explore (plan) and ask (default): re-enabling one or rewriting its actions gives no verdict', () => {
    for (const automationId of ['retired-explore', 'legacy-ask']) {
      for (const patch of [{ enabled: true }, { actions: [{ type: 'prompt', prompt: 'new' }] }]) {
        expect(run(payload('mcp__session__automation_update', { automationId, patch })), automationId).toEqual({ code: 0, stderr: '' });
      }
    }
  });

  it('CONTROL — a stored alias above the ceiling (allow-all) is still refused, naming bypassPermissions', () => {
    const { code, stderr } = run(payload('automation_update', { automationId: 'legacy-allow-all', patch: { enabled: true } }));
    expect(code).toBe(2);
    expect(stderr).toContain('"Purge" (legacy-allow-all)');
    expect(stderr).toContain('bypassPermissions mode');
  });
});

describe('F1.386 · the two spellings of the hook flag agree', () => {
  it('the host projects exactly the flag this entry point answers to', () => {
    expect(CODEX_AUTOMATION_FLOOR_HOOK_FLAG).toBe(PERMISSION_REQUEST_HOOK_FLAG);
    const command = codexAutomationFloorHookCommand('/opt/node', '/opt/session server.js', "/ws/it's");
    expect(command).toBe(`'/opt/node' '/opt/session server.js' '--permission-request-hook' '--workspace-root' '/ws/it'\\''s'`);
  });
});
