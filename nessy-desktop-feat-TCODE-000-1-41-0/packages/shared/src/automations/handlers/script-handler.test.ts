/**
 * UA8.1 — the script action's dispatch through the host `AutomationSystem` (`ScriptHandler`), the managed
 * local-automation policy at use time, and the plan's BOUNDARY arm: with managed `disableAllHooks` alone, which
 * path runs a script action for each trigger kind and what happens to it.
 *
 * Measured answer, pinned below (spec §6 "The managed hook policy"):
 * - **App events** (the seven of `APP_EVENTS`: LabelAdd, LabelRemove, LabelConfigChange, PermissionModeChange,
 *   FlagChange, SessionStatusChange, SchedulerTick) run through the host `AutomationSystem` → `ScriptHandler` →
 *   `runApprovedScript`. `disableAllHooks` does NOT reach that path (nothing under `automations/` reads it): an
 *   approved script still runs. Only `isLocalAutomationManagedDisabled()` stops it, at use time.
 * - **Agent events** (PreToolUse, Stop, …) never run a script action on any path: the host handler ignores them
 *   (App events only, as upstream), and the runtime hook dispatch (`executePluginHookAutomations`) has no `script`
 *   arm — even with direct command spawning allowed. With `disableAllHooks` the runtime hook system is not built at
 *   all (`capabilities/runtime-automations.ts`), which changes nothing for a script action. Validation warns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationSystem } from '../automation-system.ts';
import { APP_EVENTS, type AutomationsConfig, type ScriptAction } from '../types.ts';
import { scriptApprovalRecord, scriptApprovalSubject, scriptSha256, SCRIPT_APPROVAL_KIND } from '../script-executor.ts';
import { pageRefreshApprovalSubject, REFRESH_APPROVAL_KIND } from '../../pages/refresh.ts';
import { validateAutomationsConfig } from '../validation.ts';
import { recordHostApproval, type HostApprovalsKeyProvider } from '../../approvals/host-approvals.ts';
import {
  describeManagedLocalAutomationRefusal,
  isLocalAutomationManagedDisabled,
  recordCodexLocalAutomationRequirement,
  resetManagedLocalAutomationForTests,
} from '../../config/managed-local-automation.ts';
import { registerManagedPiPolicyProvider, resolveManagedPiPolicyFloor, isManagedAllHooksDisabled, type ManagedPiPolicyV1 } from '../../agent/pi-harness/managed-policy.ts';
import { executePluginHookAutomations } from '../../plugins/hooks-automation.ts';

const KEY = randomBytes(32);
const keyProvider: HostApprovalsKeyProvider = { getKey: async () => KEY };

let workspaceDir: string;
let systems: AutomationSystem[];

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'script-handler-test-'));
  systems = [];
  resetManagedLocalAutomationForTests();
});

afterEach(async () => {
  for (const system of systems) await system.dispose();
  registerManagedPiPolicyProvider(undefined);
  resetManagedLocalAutomationForTests();
  rmSync(workspaceDir, { recursive: true, force: true });
});

function marker(name: string): string {
  return join(workspaceDir, `${name}.ran`);
}

/** A script that writes `<name>.ran` in the workspace (cwd), approved unless `approved: false`. */
function script(name: string, approved = true): ScriptAction {
  const action: ScriptAction = { type: 'script', script: `${name}.ts`, runtime: 'bun' };
  writeFileSync(join(workspaceDir, action.script), `require('node:fs').writeFileSync(${JSON.stringify(`${name}.ran`)}, 'x')`);
  if (approved) {
    recordHostApproval(workspaceDir, KEY, {
      kind: SCRIPT_APPROVAL_KIND,
      subject: scriptApprovalSubject(action),
      ...scriptApprovalRecord(action, scriptSha256(readFileSync(join(workspaceDir, action.script)))),
    });
  }
  return action;
}

function build(automations: AutomationsConfig['automations']): AutomationSystem {
  writeFileSync(join(workspaceDir, 'automations.json'), JSON.stringify({ version: 2, automations }, null, 2));
  const system = new AutomationSystem({
    workspaceRootPath: workspaceDir,
    workspaceId: 'ws-ua81',
    scriptApprovalsKeyProvider: keyProvider,
  });
  systems.push(system);
  return system;
}

function history(): Array<{ id: string; ok: boolean; script?: Record<string, unknown> }> {
  const path = join(workspaceDir, 'automations-history.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const labelPayload = { sessionId: 's1', workspaceId: 'ws-ua81', timestamp: Date.now(), label: 'urgent' };

describe('ScriptHandler (UA8.1)', () => {
  it('schema: a valid script action loads; an absolute path, a ".." segment or an unknown key fails the document with the script schema\'s own message', () => {
    const ok = validateAutomationsConfig({ version: 2, automations: { LabelAdd: [{ actions: [{ type: 'script', script: 'scripts/a.ts', args: ['x'], runtime: 'node', timeoutMs: 5000 }] }] } });
    expect(ok.valid).toBe(true);
    for (const [bad, message] of [
      [{ type: 'script', script: '/etc/x.ts' }, 'relative to the workspace root'],
      [{ type: 'script', script: 'a/../../x.ts' }, '".." segments'],
      [{ type: 'script', script: 'a.ts', shell: true }, 'shell'],
      [{ type: 'script', script: 'a.ts', runtime: 'ruby' }, 'runtime'],
    ] as const) {
      const result = validateAutomationsConfig({ version: 2, automations: { LabelAdd: [{ actions: [bad] }] } });
      expect(result.valid).toBe(false);
      expect(result.errors.join('\n')).toContain(message);
    }
  });

  it('positive: an approved script action runs on its App event and the run is recorded in history', async () => {
    const action = script('label');
    const system = build({ LabelAdd: [{ id: 'm-label', actions: [action] }] });
    await system.eventBus.emit('LabelAdd', labelPayload);
    expect(existsSync(marker('label'))).toBe(true);
    const entries = history();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('m-label');
    expect(entries[0]!.ok).toBe(true);
  });

  it('negative: an unapproved script action is refused and the refusal is recorded in history', async () => {
    const action = script('unapproved', false);
    const system = build({ LabelAdd: [{ id: 'm-unapproved', actions: [action] }] });
    await system.eventBus.emit('LabelAdd', labelPayload);
    expect(existsSync(marker('unapproved'))).toBe(false);
    const entries = history();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ok).toBe(false);
    expect(entries[0]!.script?.blocked).toBe(true);
    expect(String(entries[0]!.script?.error)).toContain('not approved');
  });

  it('negative: the managed policy turning on AFTER the AutomationSystem was built stops the next run', async () => {
    const action = script('managed');
    const system = build({ LabelAdd: [{ id: 'm-managed', actions: [action] }] });
    recordCodexLocalAutomationRequirement(true);
    await system.eventBus.emit('LabelAdd', labelPayload);
    expect(existsSync(marker('managed'))).toBe(false);
    const entries = history();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.script?.blocked).toBe(true);
    expect(String(entries[0]!.script?.error)).toBe(describeManagedLocalAutomationRefusal().slice(0, 2000));
  });

  describe('boundary: managed disableAllHooks alone, per trigger kind', () => {
    beforeEach(() => {
      registerManagedPiPolicyProvider(() => ({ disableAllHooks: true }) as unknown as ManagedPiPolicyV1);
    });

    it('control: the managed floor really says disableAllHooks, and local automation is NOT managed-disabled', () => {
      const floor = resolveManagedPiPolicyFloor();
      expect(floor !== undefined && isManagedAllHooksDisabled(floor)).toBe(true);
      expect(isLocalAutomationManagedDisabled()).toBe(false);
    });

    it('App events (host AutomationSystem path): disableAllHooks does not reach it — the approved script runs on SchedulerTick and LabelAdd', async () => {
      const tick = script('tick');
      const label = script('label-boundary');
      const system = build({
        SchedulerTick: [{ id: 'm-tick', cron: '* * * * *', actions: [tick] }],
        LabelAdd: [{ id: 'm-label-boundary', actions: [label] }],
      });
      await system.eventBus.emit('SchedulerTick', { workspaceId: 'ws-ua81', timestamp: Date.now(), localTime: '10:00', utcTime: new Date().toISOString() });
      await system.eventBus.emit('LabelAdd', labelPayload);
      expect(existsSync(marker('tick'))).toBe(true);
      expect(existsSync(marker('label-boundary'))).toBe(true);
      // Every App event kind is on this path (the handler's own filter is APP_EVENTS).
      expect([...APP_EVENTS].sort()).toEqual(['FlagChange', 'LabelAdd', 'LabelConfigChange', 'LabelRemove', 'PermissionModeChange', 'SchedulerTick', 'SessionStatusChange']);
    });

    it('agent events: no path runs a script action — the host handler ignores them and the runtime hook dispatch has no script arm', async () => {
      const action = script('agent');
      const automations = { PreToolUse: [{ id: 'm-agent', actions: [action] }] } as AutomationsConfig['automations'];
      const system = build(automations);
      await system.eventBus.emit('PreToolUse' as never, { workspaceId: 'ws-ua81', timestamp: Date.now() } as never);
      const runtime = await executePluginHookAutomations(
        { automations },
        'PreToolUse',
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'true' }, session_id: 's1', cwd: workspaceDir } as never,
        { workspaceRootPath: workspaceDir, allowDirectCommandRunner: true },
      );
      expect(existsSync(marker('agent'))).toBe(false);
      expect(history()).toEqual([]);
      expect(runtime.matchedCount).toBe(1);
      expect(runtime.decision).toBeUndefined();
      // And the author is told: validation warns that the script never runs there.
      const validation = validateAutomationsConfig({ version: 2, automations });
      expect(validation.valid).toBe(true);
      expect(validation.warnings?.some(warning => warning.includes('runs only on App events') && warning.includes('PreToolUse'))).toBe(true);
    });
  });

  // UA12.96 — the stated behaviour, pinned: a USER automations.json matcher whose id carries the
  // synthetic page-refresh prefix (`page:<slug>`, `pages/refresh.ts` PAGE_REFRESH_MATCHER_PREFIX) and
  // whose script action sets `page` runs under THAT page's refresh approval, and the executor's
  // binding check means only the approved bytes, path, args and runtime can run. The branch adds no
  // power beyond the ledger: it swaps WHICH ledger entry gates the run (the page's `refresh-approval` /
  // `page:<slug>` instead of a `script-approval`) and puts the run under the page's own refresh lock
  // (`runApprovedScript`'s per-page lock). Decided against refusing such a matcher: the approval
  // already binds the script and not the schedule (refresh.ts's stated residue), so re-running the
  // approved binding on a hand-written cron is schedule freedom the posture already records; refusing
  // would add a refusal class without a security gain. Upstream has no such branch (v0.13.4 read):
  // this is ours from UA8.2, so the behaviour is stated here rather than cited upstream.
  describe('UA12.96 — a user matcher with a page:<slug> id runs under the page refresh approval', () => {
    /** A refresh-like script approved under the PAGE's refresh approval for slug `x` (not a script approval). */
    function refreshScript(name: string, approved = true): ScriptAction {
      const action: ScriptAction = { type: 'script', script: `${name}.ts`, runtime: 'bun', page: 'x' };
      writeFileSync(join(workspaceDir, action.script), `require('node:fs').writeFileSync(${JSON.stringify(`${name}.ran`)}, 'x')`);
      if (approved) {
        recordHostApproval(workspaceDir, KEY, {
          kind: REFRESH_APPROVAL_KIND,
          subject: pageRefreshApprovalSubject('x'),
          ...scriptApprovalRecord(action, scriptSha256(readFileSync(join(workspaceDir, action.script)))),
        });
      }
      return action;
    }

    it('runs: the user matcher id page:x re-uses the page refresh approval for the exact approved binding', async () => {
      const action = refreshScript('user-refresh');
      const system = build({ SchedulerTick: [{ id: 'page:x', cron: '* * * * *', actions: [action] }] });
      await system.eventBus.emit('SchedulerTick', { workspaceId: 'ws-ua81', timestamp: Date.now(), localTime: '10:00', utcTime: new Date().toISOString() });
      expect(existsSync(marker('user-refresh'))).toBe(true);
      const entries = history();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.id).toBe('page:x');
      expect(entries[0]!.ok).toBe(true);
    });

    it('boundary: only the approved bytes, path, args and runtime — an args change is refused by the same branch', async () => {
      const approved = refreshScript('user-refresh-boundary');
      const action: ScriptAction = { ...approved, args: ['--extra'] };
      const system = build({ SchedulerTick: [{ id: 'page:x', cron: '* * * * *', actions: [action] }] });
      await system.eventBus.emit('SchedulerTick', { workspaceId: 'ws-ua81', timestamp: Date.now(), localTime: '10:00', utcTime: new Date().toISOString() });
      expect(existsSync(marker('user-refresh-boundary'))).toBe(false);
      const entries = history();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.ok).toBe(false);
      expect(entries[0]!.script?.blocked).toBe(true);
      expect(String(entries[0]!.script?.error)).toContain('approved with a different path, arguments or runtime');
    });
  });
});
