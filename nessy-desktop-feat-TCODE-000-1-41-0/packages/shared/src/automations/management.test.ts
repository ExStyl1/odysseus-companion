import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAutomationEntry,
  deleteAutomationEntry,
  listAutomationEntries,
  updateAutomationEntry,
  type AutomationMutationAction,
} from './management.ts';
import { resolveAutomationsConfigPath } from './resolve-config-path.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'automation-management-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('AutomationManagementService', () => {
  it('creates a scheduled automation in an empty workspace', async () => {
    const result = await createAutomationEntry(workspaceRoot, {
      kind: 'scheduled',
      cron: '0 9 * * 1-5',
      actions: [promptAction('Summarize blockers')],
    });

    const config = readConfig();
    const matcher = matcherAt(config, 'SchedulerTick');

    expect(result.event).toBe('SchedulerTick');
    expect(config.version).toBe(2);
    expect(matcher.id).toBe(result.automationId);
    expect(matcher.cron).toBe('0 9 * * 1-5');
  });

  it('creates event automations and rejects cron', async () => {
    const result = await createAutomationEntry(workspaceRoot, {
      kind: 'event',
      event: 'LabelAdd',
      matcher: 'urgent',
      actions: [promptAction('Draft next steps')],
    });

    expect(result.event).toBe('LabelAdd');
    expect(matcherAt(readConfig(), 'LabelAdd').matcher).toBe('urgent');
    await expect(createAutomationEntry(workspaceRoot, {
      kind: 'event',
      event: 'LabelAdd',
      cron: '0 9 * * *',
      actions: [promptAction('Invalid')],
    })).rejects.toThrow('cannot set cron');
  });

  it('creates agentic automations and rejects SchedulerTick', async () => {
    const result = await createAutomationEntry(workspaceRoot, {
      kind: 'agentic',
      event: 'UserPromptSubmit',
      matcher: 'review',
      actions: [promptAction('Review prompt')],
    });

    expect(result.event).toBe('UserPromptSubmit');
    expect(matcherAt(readConfig(), 'UserPromptSubmit').matcher).toBe('review');
    await expect(createAutomationEntry(workspaceRoot, {
      kind: 'agentic',
      event: 'SchedulerTick',
      actions: [promptAction('Invalid')],
    })).rejects.toThrow('agent event');
  });

  it('updates an automation by id and preserves id', async () => {
    const created = await createAutomationEntry(workspaceRoot, {
      kind: 'event',
      event: 'LabelAdd',
      matcher: 'urgent',
      actions: [promptAction('Draft next steps')],
    });

    const updated = await updateAutomationEntry(workspaceRoot, {
      automationId: created.automationId,
      patch: { name: 'Urgent responder', enabled: false },
    });

    const matcher = matcherAt(readConfig(), 'LabelAdd');
    expect(updated.automationId).toBe(created.automationId);
    expect(matcher.id).toBe(created.automationId);
    expect(matcher.name).toBe('Urgent responder');
    expect(matcher.enabled).toBe(false);
  });

  it('moves an automation between event buckets', async () => {
    const created = await createAutomationEntry(workspaceRoot, {
      kind: 'event',
      event: 'LabelAdd',
      matcher: 'urgent',
      actions: [promptAction('Draft next steps')],
    });

    const moved = await updateAutomationEntry(workspaceRoot, {
      automationId: created.automationId,
      patch: { kind: 'agentic', event: 'UserPromptSubmit', matcher: 'review' },
    });

    const config = readConfig();
    expect(moved.event).toBe('UserPromptSubmit');
    expect(config.automations.LabelAdd).toBeUndefined();
    expect(matcherAt(config, 'UserPromptSubmit').id).toBe(created.automationId);
    expect(matcherAt(config, 'UserPromptSubmit').matcher).toBe('review');
  });

  it('rejects invalid actions by validating the full config', async () => {
    await expect(createAutomationEntry(workspaceRoot, {
      kind: 'event',
      event: 'LabelAdd',
      actions: [{} as AutomationMutationAction],
    })).rejects.toThrow('Invalid automations config');
  });

  it('deletes an empty event bucket', async () => {
    const created = await createAutomationEntry(workspaceRoot, {
      kind: 'event',
      event: 'LabelAdd',
      actions: [promptAction('Draft next steps')],
    });

    await deleteAutomationEntry(workspaceRoot, created.automationId);

    expect(readConfig().automations.LabelAdd).toBeUndefined();
  });

  it('concurrent creates do not clobber each other', async () => {
    await Promise.all([
      createAutomationEntry(workspaceRoot, {
        kind: 'event',
        event: 'LabelAdd',
        matcher: 'urgent',
        actions: [promptAction('Draft next steps')],
      }),
      createAutomationEntry(workspaceRoot, {
        kind: 'agentic',
        event: 'UserPromptSubmit',
        matcher: 'review',
        actions: [promptAction('Review prompt')],
      }),
    ]);

    const entries = await listAutomationEntries(workspaceRoot);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.automationId)).size).toBe(2);
  });

  it('backfills missing ids on list', async () => {
    writeFileSync(resolveAutomationsConfigPath(workspaceRoot), JSON.stringify({
      version: 2,
      automations: {
        LabelAdd: [{ matcher: 'urgent', actions: [promptAction('Draft next steps')] }],
      },
    }, null, 2));

    const [entry] = await listAutomationEntries(workspaceRoot);
    if (entry === undefined) throw new Error('listAutomationEntries returned nothing to backfill');

    expect(entry.automationId).toBeTruthy();
    expect(matcherAt(readConfig(), 'LabelAdd').id).toBe(entry.automationId);
  });

  it('persists the per-task worktree toggle through create, list and update', async () => {
    // desktop-scheduled-tasks.md:34. Three validators guard this one key
    // (persisted schema, this RPC surface, the agent tool), which is exactly how
    // a field gets accepted at one door and stripped at another — so the
    // assertion is on the bytes on disk, not on the return value.
    const created = await createAutomationEntry(workspaceRoot, {
      kind: 'scheduled',
      cron: '0 9 * * *',
      worktree: true,
      actions: [promptAction('nightly lint')],
    });

    expect(matcherAt(readConfig(), 'SchedulerTick').worktree).toBe(true);

    const listed = await listAutomationEntries(workspaceRoot);
    expect(listed[0]!.automation.worktree).toBe(true);

    await updateAutomationEntry(workspaceRoot, {
      automationId: created.automationId!,
      patch: { worktree: false },
    });
    expect(matcherAt(readConfig(), 'SchedulerTick').worktree).toBe(false);
  });

  it('rejects a malformed legacy root without rewriting it', async () => {
    const configPath = resolveAutomationsConfigPath(workspaceRoot);
    const legacy = JSON.stringify({
      'beep-on-agent-end': {
        event: 'AgentEnd',
        actions: [{ type: 'bash', command: 'printf "\\a"' }],
      },
    }, null, 2);
    writeFileSync(configPath, legacy);

    await expect(listAutomationEntries(workspaceRoot))
      .rejects.toThrow('Invalid automations config');
    expect(readFileSync(configPath, 'utf8')).toBe(legacy);
  });

  it('F1.1053 — reads a stored explore as plan and never writes explore back, on any edit of the file', async () => {
    // F1.1050 retired explore. A person's automation saved before it keeps the word on disk until the store next
    // writes; that write (an edit of THIS automation or of any other in the file) must persist plan, never explore.
    const configPath = resolveAutomationsConfigPath(workspaceRoot);
    writeFileSync(configPath, JSON.stringify({
      version: 2,
      automations: {
        SchedulerTick: [{ id: 'nightly', cron: '0 9 * * *', permissionMode: 'explore', actions: [promptAction('recap')] }],
        LabelAdd: [{ id: 'triage', matcher: 'urgent', permissionMode: 'explore', actions: [promptAction('triage')] }],
      },
    }, null, 2));

    const listed = await listAutomationEntries(workspaceRoot);
    expect(listed.map(entry => [entry.automationId, entry.automation.permissionMode])).toEqual([
      ['nightly', 'plan'],
      ['triage', 'plan'],
    ]);

    await updateAutomationEntry(workspaceRoot, { automationId: 'triage', patch: { name: 'Triage' } });
    expect(readFileSync(configPath, 'utf8')).not.toContain('explore');
    expect(matcherAt(readConfig(), 'SchedulerTick').permissionMode).toBe('plan');
    expect(matcherAt(readConfig(), 'LabelAdd')).toMatchObject({ id: 'triage', name: 'Triage', permissionMode: 'plan' });
  });
});

/**
 * The matcher persisted under `event`, or a throw that names what was missing.
 *
 * `noUncheckedIndexedAccess` makes BOTH hops optional here — the event key on
 * `automations` and the slot in its array — and every assertion in this file
 * reads through both. `?.` would compile and would not be vacuous (each
 * assertion is a positive `toBe`, which `undefined` still fails), but it
 * reports "expected 'urgent', got undefined" for two quite different bugs:
 * the automation was written under the wrong event, or it was written under
 * the right one and lost a field. Throwing separates them, and it is the shape
 * P3.117 chose over the optional chain for the same reason.
 */
function matcherAt(
  config: ReturnType<typeof readConfig>,
  event: string,
  index = 0,
): Record<string, unknown> {
  const matchers = config.automations[event];
  if (matchers === undefined) {
    const keys = Object.keys(config.automations);
    throw new Error(`automations config has no \`${event}\` entry (present: ${keys.join(', ') || 'none'})`);
  }
  const matcher = matchers[index];
  if (matcher === undefined) {
    throw new Error(`automations.${event} holds ${matchers.length} matcher(s); none at index ${index}`);
  }
  return matcher;
}

function promptAction(prompt: string): AutomationMutationAction {
  return { type: 'prompt', prompt };
}

function readConfig(): {
  version: number;
  automations: Record<string, Array<Record<string, unknown>>>;
} {
  return JSON.parse(readFileSync(resolveAutomationsConfigPath(workspaceRoot), 'utf8'));
}

/**
 * F1.1269 — an update that keeps the automation's event keeps its POSITION in
 * that event's list. It used to splice the entry out and push it at the end,
 * so editing the first of three LabelAdd automations reordered the list (seen
 * in SIT2-f through `automation_update`). A move to another event still lands
 * at the end of the target list.
 */
describe('F1.1269 · updateAutomationEntry keeps the position within the same event', () => {
  async function threeLabelAdd(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of ['first', 'second', 'third']) {
      const created = await createAutomationEntry(workspaceRoot, {
        kind: 'event', event: 'LabelAdd', matcher: name, name, actions: [promptAction(name)],
      });
      ids.push(created.automationId);
    }
    return ids;
  }

  it('editing the first of three leaves it first, and the result reports index 0', async () => {
    const ids = await threeLabelAdd();
    const updated = await updateAutomationEntry(workspaceRoot, { automationId: ids[0]!, patch: { name: 'renamed' } });
    expect(readConfig().automations.LabelAdd!.map(matcher => matcher.id)).toEqual(ids);
    expect(matcherAt(readConfig(), 'LabelAdd', 0).name).toBe('renamed');
    expect(updated.matcherIndex).toBe(0);
  });

  it('BOUNDARY — a move to another event still leaves the old list in order and appends to the target', async () => {
    const ids = await threeLabelAdd();
    const moved = await updateAutomationEntry(workspaceRoot, {
      automationId: ids[0]!, patch: { kind: 'event', event: 'LabelRemove' },
    });
    const config = readConfig();
    expect(config.automations.LabelAdd!.map(matcher => matcher.id)).toEqual([ids[1], ids[2]]);
    expect(config.automations.LabelRemove!.map(matcher => matcher.id)).toEqual([ids[0]]);
    expect(moved.event).toBe('LabelRemove');
  });
});
