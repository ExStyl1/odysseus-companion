import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleAutomationCreate,
  handleAutomationList,
  handleAutomationUpdate,
} from '@nessy-agent/session-tools-core';
import { createClaudeContext } from '../claude-context.ts';

/**
 * P3.154. `AutomationManagerInterface` typed every argument
 * `Record<string, unknown>`, and this implementation bridged the erasure with
 * `args as unknown as Parameters<typeof createAutomationEntry>[1]` — a DOUBLE
 * cast, the spelling TypeScript demands exactly when it can see no relation
 * between the two types. It asserted that the bag really was an
 * `AutomationCreateInput` and checked nothing: a value with no `kind`/`actions`
 * would have reached `buildMatcher` and written a malformed matcher to disk.
 *
 * The port now names the parsed shapes its only caller establishes, so the
 * assignment itself is the check. That property is COMPILE-time and was
 * measured with a two-sided control: adding a fourth member to
 * `AutomationKindSchema` turns `claude-context.ts` red at both call sites, and
 * the same drift with the casts restored reports zero errors there.
 *
 * These tests are the RUNTIME half — that deleting the casts left the behaviour
 * the casts were papering over intact end to end: a create reaches the shared
 * writer and lands on disk, an update moves it, and the error path is
 * unchanged. No re-`parse` was added on this side (unlike P3.130, which needed
 * one while the port was still erased) because `handleAutomationCreate` parses
 * one frame earlier — the last test is that control.
 */
describe('claude-context automation manager port (P3.154)', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'claude-auto-port-'));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function context() {
    return createClaudeContext({
      sessionId: 'session-1',
      workspacePath: workspaceRoot,
      workspaceId: 'ws-1',
      sessionPath: join(workspaceRoot, 'sessions', 'session-1'),
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    });
  }

  it('carries a create through the port to the shared writer and onto disk', async () => {
    const result = await handleAutomationCreate(context(), {
      kind: 'scheduled',
      name: 'nightly-sweep',
      cron: '0 3 * * *',
      actions: [{ type: 'prompt', prompt: 'sweep' }],
    });

    expect(result.isError).toBeFalsy();

    // Every field of `AutomationManagementResult` survives the spread that
    // replaced `structuredContent as Record<string, unknown>`; a stripped
    // subset is the regression to catch.
    const structured = result.structuredContent ?? {};
    expect(typeof structured.automationId).toBe('string');
    expect(structured.event).toBe('SchedulerTick');
    expect(structured.matcherIndex).toBe(0);
    expect(structured.configPath).toBe(join(workspaceRoot, 'automations.json'));

    // The shared writer accepted the parsed value — the agreement the double
    // cast asserted without checking.
    const configPath = join(workspaceRoot, 'automations.json');
    expect(existsSync(configPath)).toBe(true);
    const stored = JSON.parse(readFileSync(configPath, 'utf8')) as {
      automations: Record<string, Array<{ id?: string; name?: string; cron?: string }>>;
    };
    const matcher = stored.automations.SchedulerTick?.[0];
    expect(matcher?.name).toBe('nightly-sweep');
    expect(matcher?.cron).toBe('0 3 * * *');
    // Reported id against the on-disk id, in that order: the file is the
    // reference, and the reported value is the one under test.
    expect(structured.automationId).toBe(matcher?.id);
  });

  it('carries an update through the port — the second deleted cast', async () => {
    const created = await handleAutomationCreate(context(), {
      kind: 'agentic',
      event: 'PreToolUse',
      matcher: 'Bash',
      actions: [{ type: 'prompt', prompt: 'check' }],
    });
    const automationId = String((created.structuredContent ?? {}).automationId);
    expect(automationId).not.toBe('undefined');

    const updated = await handleAutomationUpdate(context(), {
      automationId,
      patch: { matcher: 'Read', enabled: false },
    });
    expect(updated.isError).toBeFalsy();

    const listed = await handleAutomationList(context(), { includeDisabled: true });
    const automations = (listed.structuredContent ?? {}).automations as Array<{
      automationId: string;
      enabled: boolean;
      automation: { matcher?: string };
    }>;
    expect(automations).toHaveLength(1);
    expect(automations[0]?.automationId).toBe(automationId);
    expect(automations[0]?.automation.matcher).toBe('Read');
    // `enabled: false` also proves `list`'s own argument survived the port:
    // without `includeDisabled` reaching the implementation this row is filtered
    // out and the length assertion above fails.
    expect(automations[0]?.enabled).toBe(false);
  });

  it('rejects a malformed create one frame BEFORE the port, so no re-parse is owed', async () => {
    // The control for the deliberate absence of a re-`parse` in this
    // implementation: `handleAutomationCreate` runs `AutomationCreateSchema`
    // itself, so a bad payload never reaches `automationManager.create` and the
    // error path is the handler's own `automation_create failed: …`.
    const result = await handleAutomationCreate(context(), {
      kind: 'nope',
      actions: [{ type: 'prompt' }],
    } as unknown as Parameters<typeof handleAutomationCreate>[1]);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('automation_create failed');
    expect(existsSync(join(workspaceRoot, 'automations.json'))).toBe(false);
  });
});
