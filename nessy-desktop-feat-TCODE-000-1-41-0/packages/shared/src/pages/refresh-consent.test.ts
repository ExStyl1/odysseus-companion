/**
 * UA8.2 — scheduled page refresh is CONSENTED: the host writes the script from content, and the synthetic
 * `page:<slug>` matcher exists only for a refresh whose current bytes a human approved (`pages/refresh.ts`, spec §15).
 *
 * - positive: an approved refresh has a `page:<slug>` SchedulerTick matcher, and a tick runs it (marker, history,
 *   `lastRefresh` on page.json).
 * - negative: a tool-set spec stays inert (no matcher, and a tick runs nothing); a script edit disables it (the reload
 *   drops the matcher, and a stale matcher's run is refused with the reason in history); with local automation
 *   managed-disabled no refresh runs; the policy turning on after the AutomationSystem was built stops the next
 *   refresh (control: off again, it runs); an agent-supplied path is rejected by the schema and nothing is written;
 *   a page.json naming a script the host did not write never schedules, even with an approval of that path.
 * - boundary: the 5-minute cron floor; an approval of bytes other than the ones the person reviewed is refused.
 *
 * The positive runs use a daily cron for the CURRENT minute (the scheduler's matcher reads the wall clock and
 * page.json keeps the 5-minute floor); `tickThisMinute` re-reads the minute around the tick and retries a rollover.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationSystem } from '../automations/automation-system.ts';
import { scriptApprovalRecord, scriptSha256 } from '../automations/script-executor.ts';
import { recordHostApproval, type HostApprovalsKeyProvider } from '../approvals/host-approvals.ts';
import {
  describeManagedLocalAutomationRefusal,
  isLocalAutomationManagedDisabled,
  recordCodexLocalAutomationRequirement,
  resetManagedLocalAutomationForTests,
} from '../config/managed-local-automation.ts';
import { createPage, getPageConfigPath, loadPageConfig, updatePage } from './storage.ts';
import {
  approvePageRefresh,
  pageRefreshApprovalSubject,
  pageRefreshMatcherId,
  pageRefreshScriptPath,
  readPageRefreshApproval,
  REFRESH_APPROVAL_KIND,
  setPageRefresh,
} from './refresh.ts';

const KEY = randomBytes(32);
const keyProvider: HostApprovalsKeyProvider = { getKey: async () => KEY };

let root: string;
let systems: AutomationSystem[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'refresh-consent-'));
  systems = [];
  resetManagedLocalAutomationForTests();
});

afterEach(async () => {
  for (const system of systems) await system.dispose();
  resetManagedLocalAutomationForTests();
  rmSync(root, { recursive: true, force: true });
});

/** A refresh script that drops `<name>.ran` in the workspace root (its cwd). */
function scriptWriting(name: string): string {
  return `require('node:fs').writeFileSync(${JSON.stringify(`${name}.ran`)}, 'x')`;
}

function ran(name: string): boolean {
  return existsSync(join(root, `${name}.ran`));
}

function pageWithRefresh(name: string, scriptContent = scriptWriting(name)): string {
  const page = createPage(root, { name, content: '<p>x</p>' });
  setPageRefresh(root, page.slug, { cron: '*/15 * * * *', scriptContent });
  return page.slug;
}

/** The AutomationSystem as SessionManager builds it: the scheduler only when the managed policy allows it. */
function build(): AutomationSystem {
  const system = new AutomationSystem({
    workspaceRootPath: root,
    workspaceId: 'ws-ua82',
    enableScheduler: false,
    scriptApprovalsKeyProvider: keyProvider,
  });
  systems.push(system);
  return system;
}

function matcherIds(system: AutomationSystem): string[] {
  return system.getMatchersForEvent('SchedulerTick').map(matcher => matcher.id ?? '');
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

/**
 * Point the page's refresh at the current minute (a daily cron: the floor holds), reload, and emit one SchedulerTick
 * inside that minute. The cron is not part of the approval (stated residue), so the approval still holds.
 */
async function tickThisMinute(system: AutomationSystem, slug: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cron = cronForThisMinute();
    const refresh = loadPageConfig(root, slug)!.refresh!;
    updatePage(root, slug, { refresh: { ...refresh, cron } });
    await system.reloadPageRefreshMatchers();
    if (cronForThisMinute() !== cron) continue;
    await system.eventBus.emit('SchedulerTick', { workspaceId: 'ws-ua82', timestamp: Date.now(), localTime: '', utcTime: new Date().toISOString() });
    if (cronForThisMinute() === cron) return;
  }
  throw new Error('tickThisMinute: the minute rolled over three times');
}

describe('scheduled refresh consent (UA8.2)', () => {
  it('positive: an approved refresh has a page:<slug> matcher, and a tick runs it and stamps lastRefresh', async () => {
    const slug = pageWithRefresh('approved');
    expect(approvePageRefresh(root, KEY, slug).state).toBe('approved');
    const system = build();
    await system.reloadPageRefreshMatchers();
    expect(matcherIds(system)).toEqual([pageRefreshMatcherId(slug)]);

    await tickThisMinute(system, slug);
    expect(ran('approved')).toBe(true);
    const entries = history();
    expect(entries.map(entry => [entry.id, entry.ok])).toEqual([[`page:${slug}`, true]]);
    expect(loadPageConfig(root, slug)!.lastRefresh?.ok).toBe(true);
  });

  it('negative: a tool-set spec stays inert — no matcher, unapproved, and a tick runs nothing', async () => {
    const slug = pageWithRefresh('inert');
    const config = loadPageConfig(root, slug)!;
    expect(config.refresh?.script).toBe(pageRefreshScriptPath(slug));
    expect(readFileSync(join(root, pageRefreshScriptPath(slug)), 'utf-8')).toBe(scriptWriting('inert'));
    expect(readPageRefreshApproval(root, KEY, config).state).toBe('unapproved');
    const system = build();
    await system.reloadPageRefreshMatchers();
    expect(matcherIds(system)).toEqual([]);
    await tickThisMinute(system, slug);
    expect(ran('inert')).toBe(false);
    expect(history()).toEqual([]);
  });

  it('negative: a script edit disables it — the reload drops the matcher, and a stale matcher\'s run is refused', async () => {
    const slug = pageWithRefresh('edited');
    approvePageRefresh(root, KEY, slug);
    const system = build();
    await system.reloadPageRefreshMatchers();
    expect(matcherIds(system)).toEqual([pageRefreshMatcherId(slug)]);

    // An edit through the tool (new content) or by any writer of the file: the approval no longer matches.
    writeFileSync(join(root, pageRefreshScriptPath(slug)), `${scriptWriting('edited')}\n// changed`);
    expect(readPageRefreshApproval(root, KEY, loadPageConfig(root, slug)!).state).toBe('changed');
    await system.reloadPageRefreshMatchers();
    expect(matcherIds(system)).toEqual([]);

    // The race: the file changes AFTER a reload built the matcher — the run re-verifies and refuses. A minute
    // rollover retries (as `tickThisMinute` does) rather than skipping the assertions; three rollovers throw.
    for (let attempt = 0; ; attempt += 1) {
      if (attempt === 3) throw new Error('script-edit race: the minute rolled over three times');
      approvePageRefresh(root, KEY, slug);
      const cron = cronForThisMinute();
      updatePage(root, slug, { refresh: { ...loadPageConfig(root, slug)!.refresh!, cron } });
      await system.reloadPageRefreshMatchers();
      expect(matcherIds(system)).toEqual([pageRefreshMatcherId(slug)]);
      writeFileSync(join(root, pageRefreshScriptPath(slug)), `${scriptWriting('edited')}\n// swapped ${attempt}`);
      if (cronForThisMinute() !== cron) continue;
      await system.eventBus.emit('SchedulerTick', { workspaceId: 'ws-ua82', timestamp: Date.now(), localTime: '', utcTime: new Date().toISOString() });
      if (cronForThisMinute() !== cron) continue;
      expect(ran('edited')).toBe(false);
      const entry = history().at(-1);
      expect(entry?.ok).toBe(false);
      expect(entry?.script?.blocked).toBe(true);
      expect(String(entry?.script?.error)).toContain('changed since it was approved');
      break;
    }
  });

  it('negative: with local automation managed-disabled no refresh runs (no scheduler, and a tick is refused by name)', async () => {
    const slug = pageWithRefresh('managed');
    approvePageRefresh(root, KEY, slug);
    recordCodexLocalAutomationRequirement(true);
    expect(isLocalAutomationManagedDisabled()).toBe(true);
    const system = new AutomationSystem({
      workspaceRootPath: root,
      workspaceId: 'ws-ua82',
      enableScheduler: !isLocalAutomationManagedDisabled(),
      scriptApprovalsKeyProvider: keyProvider,
    });
    systems.push(system);
    expect(system.schedulerRunning).toBe(false);
    await tickThisMinute(system, slug);
    expect(ran('managed')).toBe(false);
    expect(String(history()[0]?.script?.error)).toBe(describeManagedLocalAutomationRefusal());
  });

  it('negative: the policy turning on after the AutomationSystem was built stops the next refresh; off again, it runs', async () => {
    const slug = pageWithRefresh('late');
    approvePageRefresh(root, KEY, slug);
    const system = build();
    recordCodexLocalAutomationRequirement(true);
    await tickThisMinute(system, slug);
    expect(ran('late')).toBe(false);
    expect(String(history()[0]?.script?.blocked)).toBe('true');

    resetManagedLocalAutomationForTests();
    await tickThisMinute(system, slug);
    expect(ran('late')).toBe(true);
  });

  it('negative: an agent-supplied path is rejected by the schema, and nothing is written', () => {
    const page = createPage(root, { name: 'Pathy', content: '<p>x</p>' });
    for (const input of [
      { cron: '*/15 * * * *', script: 'scripts/refresh.ts' },
      { cron: '*/15 * * * *', script: 'scripts/refresh.ts', scriptContent: 'console.log(1)' },
    ]) {
      expect(() => setPageRefresh(root, page.slug, input)).toThrow(/Invalid refresh/);
    }
    expect(loadPageConfig(root, page.slug)!.refresh).toBeUndefined();
    expect(existsSync(join(root, pageRefreshScriptPath(page.slug)))).toBe(false);
  });

  it('negative: a page.json naming a script the host did not write never schedules, even with an approval of that path', async () => {
    const page = createPage(root, { name: 'Foreign', content: '<p>x</p>' });
    writeFileSync(join(root, 'evil.ts'), scriptWriting('foreign'));
    const configPath = getPageConfigPath(root, page.slug);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf-8'));
    writeFileSync(configPath, JSON.stringify({ ...onDisk, refresh: { cron: '*/15 * * * *', script: 'evil.ts' } }));
    const action = { type: 'script' as const, script: 'evil.ts', page: page.slug };
    recordHostApproval(root, KEY, {
      kind: REFRESH_APPROVAL_KIND,
      subject: pageRefreshApprovalSubject(page.slug),
      ...scriptApprovalRecord(action, scriptSha256(readFileSync(join(root, 'evil.ts')))),
    });
    expect(readPageRefreshApproval(root, KEY, loadPageConfig(root, page.slug)!).state).toBe('foreign-script');
    expect(() => approvePageRefresh(root, KEY, page.slug)).toThrow(/did not write/);
    const system = build();
    await system.reloadPageRefreshMatchers();
    expect(matcherIds(system)).toEqual([]);
  });

  it('boundary: the 5-minute floor refuses an every-minute cron; an approval of bytes other than the reviewed ones is refused', () => {
    const page = createPage(root, { name: 'Floor', content: '<p>x</p>' });
    expect(() => setPageRefresh(root, page.slug, { cron: '* * * * *', scriptContent: 'console.log(1)' })).toThrow(/minimum refresh interval/);
    expect(existsSync(join(root, pageRefreshScriptPath(page.slug)))).toBe(false);

    const slug = pageWithRefresh('reviewed');
    const shown = readPageRefreshApproval(root, KEY, loadPageConfig(root, slug)!).sha256!;
    writeFileSync(join(root, pageRefreshScriptPath(slug)), 'console.log("swapped")');
    expect(() => approvePageRefresh(root, KEY, slug, shown)).toThrow(/changed while it was being reviewed/);
    expect(readPageRefreshApproval(root, KEY, loadPageConfig(root, slug)!).state).toBe('unapproved');
    // Control: the digest of the bytes on disk is accepted.
    const current = readPageRefreshApproval(root, KEY, loadPageConfig(root, slug)!).sha256!;
    expect(approvePageRefresh(root, KEY, slug, current).state).toBe('approved');
  });

  it('null removes the refresh and its host-written script', () => {
    const slug = pageWithRefresh('removed');
    setPageRefresh(root, slug, null);
    expect(loadPageConfig(root, slug)!.refresh).toBeUndefined();
    expect(existsSync(join(root, pageRefreshScriptPath(slug)))).toBe(false);
  });
});
