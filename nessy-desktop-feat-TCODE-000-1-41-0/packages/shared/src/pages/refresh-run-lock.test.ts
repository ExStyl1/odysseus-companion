/**
 * UA8.3 follow-up — a page refresh never overlaps itself, whichever door started it (spec §15 "a per-matcher lock").
 *
 * The lock used to live only in `ScriptHandler.inFlight`, so `pages:runRefreshNow` (which calls `runApprovedScript`
 * directly with the same `page:<slug>` matcher id) could start a second `refresh.ts` beside a running one — twice
 * "Run now", or "Run now" during a scheduled tick — racing on the page's data files and on page.json `lastRefresh`.
 * `runApprovedScript` now holds a per-page lock for every `page-refresh` run; a run that finds it held is SKIPPED
 * with the host's reason (`SCRIPT_RUN_IN_PROGRESS_REASON`), the shape a skipped scheduled tick already had.
 *
 * - positive (red before the fix): two "Run now" calls of one page at once → one run, one skip with the reason.
 * - cross-door: a scheduled tick while "Run now" is in flight → the tick is recorded in history as skipped.
 * - boundary: another page's refresh runs meanwhile (the lock is per page), and the same page runs again once the
 *   first run has finished (the lock is released).
 *
 * The calls are shaped as `rpc/pages.ts` `pages:runRefreshNow` shapes its own (`pageRefreshAction` of the enabled
 * config, `trigger: 'page-refresh'`, the refresh approval).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationSystem } from '../automations/automation-system.ts';
import { runApprovedScript, SCRIPT_RUN_IN_PROGRESS_REASON } from '../automations/script-executor.ts';
import type { ScriptActionResult } from '../automations/types.ts';
import type { HostApprovalsKeyProvider } from '../approvals/host-approvals.ts';
import { resetManagedLocalAutomationForTests } from '../config/managed-local-automation.ts';
import { createPage, loadPageConfig, updatePage } from './storage.ts';
import {
  approvePageRefresh,
  pageRefreshAction,
  pageRefreshApprovalSubject,
  pageRefreshMatcherId,
  REFRESH_APPROVAL_KIND,
  setPageRefresh,
} from './refresh.ts';

const KEY = randomBytes(32);
const keyProvider: HostApprovalsKeyProvider = { getKey: async () => KEY };
/** Long enough that a second call issued right after the first certainly finds the first still running. */
const RUN_MS = 800;

let root: string;
let systems: AutomationSystem[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'refresh-run-lock-'));
  systems = [];
  resetManagedLocalAutomationForTests();
});

afterEach(async () => {
  for (const system of systems) await system.dispose();
  resetManagedLocalAutomationForTests();
  rmSync(root, { recursive: true, force: true });
});

/** A refresh script that, after RUN_MS, appends one line to `<name>.runs` in the workspace root (its cwd). */
function slowScript(name: string): string {
  return `setTimeout(() => require('node:fs').appendFileSync(${JSON.stringify(`${name}.runs`)}, 'x\\n'), ${RUN_MS})`;
}

function runs(name: string): number {
  const path = join(root, `${name}.runs`);
  return existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).length : 0;
}

function approvedPage(name: string): string {
  const page = createPage(root, { name, content: '<p>x</p>' });
  setPageRefresh(root, page.slug, { cron: '*/15 * * * *', scriptContent: slowScript(name) });
  expect(approvePageRefresh(root, KEY, page.slug).state).toBe('approved');
  return page.slug;
}

/** One "Run now", as `pages:runRefreshNow` issues it. */
function runNow(slug: string): Promise<ScriptActionResult> {
  const config = loadPageConfig(root, slug)!;
  const action = pageRefreshAction({ ...config, refresh: { ...config.refresh!, enabled: true } })!;
  return runApprovedScript({
    action,
    workspaceRootPath: root,
    env: { PATH: process.env.PATH ?? '' },
    trigger: 'page-refresh',
    approval: { kind: REFRESH_APPROVAL_KIND, subject: pageRefreshApprovalSubject(slug) },
    workspaceId: 'ws-ua83',
    matcherId: pageRefreshMatcherId(slug),
    keyProvider,
  });
}

function history(): Array<{ id: string; ok: boolean; script?: Record<string, unknown> }> {
  const path = join(root, 'automations-history.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function cronForThisMinute(): string {
  const now = new Date();
  return `${now.getMinutes()} ${now.getHours()} * * *`;
}

describe('a page refresh never overlaps itself (UA8.3 follow-up)', () => {
  it('positive: a second "Run now" while the first is running is skipped with the host reason — one run', async () => {
    const slug = approvedPage('twice');
    const [first, second] = await Promise.all([runNow(slug), runNow(slug)]);

    expect(runs('twice')).toBe(1);
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    expect(second.skipped).toBe(true);
    expect(second.blocked).toBeUndefined();
    expect(second.stderr).toBe(SCRIPT_RUN_IN_PROGRESS_REASON);
    expect(second.page).toBe(slug);
    // The finished run stamped lastRefresh; the skip wrote nothing over it.
    expect(loadPageConfig(root, slug)!.lastRefresh?.ok).toBe(true);
  });

  it('cross-door: a scheduled tick while "Run now" is in flight is recorded as skipped, not run', async () => {
    const slug = approvedPage('tick');
    const system = new AutomationSystem({
      workspaceRootPath: root,
      workspaceId: 'ws-ua83',
      enableScheduler: false,
      scriptApprovalsKeyProvider: keyProvider,
    });
    systems.push(system);

    const running = runNow(slug);
    let ticked = false;
    for (let attempt = 0; attempt < 3 && !ticked; attempt += 1) {
      const cron = cronForThisMinute();
      updatePage(root, slug, { refresh: { ...loadPageConfig(root, slug)!.refresh!, cron } });
      await system.reloadPageRefreshMatchers();
      if (cronForThisMinute() !== cron) continue;
      await system.eventBus.emit('SchedulerTick', { workspaceId: 'ws-ua83', timestamp: Date.now(), localTime: '', utcTime: new Date().toISOString() });
      ticked = cronForThisMinute() === cron;
    }
    expect(ticked).toBe(true);
    expect((await running).success).toBe(true);

    expect(runs('tick')).toBe(1);
    const entries = history().filter(entry => entry.id === pageRefreshMatcherId(slug));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ok).toBe(false);
    expect(entries[0]!.script?.skipped).toBe(true);
    expect(entries[0]!.script?.error).toBe(SCRIPT_RUN_IN_PROGRESS_REASON);
  });

  it('boundary: another page runs meanwhile (per page), and the same page runs again once the first finished', async () => {
    const a = approvedPage('alpha');
    const b = approvedPage('beta');
    const [ra, rb] = await Promise.all([runNow(a), runNow(b)]);
    expect([ra.success, rb.success]).toEqual([true, true]);
    expect([runs('alpha'), runs('beta')]).toEqual([1, 1]);

    const again = await runNow(a);
    expect(again.success).toBe(true);
    expect(again.skipped).toBeUndefined();
    expect(runs('alpha')).toBe(2);
  });
});
