import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import {
  handleAutomationCreate,
  handleAutomationList,
  handleAutomationUpdate,
  handleAutomationValidate,
  findUnattendedAutomationEdit,
  PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE,
} from './automation-management.ts';
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/mode-types';
import { AGENT_EVENTS, APP_EVENTS, UNEMITTED_HOOK_EVENT_REASONS } from '@nessy-agent/shared/automations/types';
import { AutomationsConfigSchema } from '@nessy-agent/shared/automations';
import { getToolDefsAsJsonSchema } from '../tool-defs.ts';

let workspaceRoot = '';

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'session-tools-automation-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('automation management session handlers', () => {
  it('creates automations.json using the local filesystem fallback', async () => {
    const result = await handleAutomationCreate(ctx(), {
      kind: 'scheduled',
      cron: '0 9 * * 1-5',
      actions: [{ type: 'prompt', prompt: 'Summarize blockers' }],
    });

    const config = readConfig();
    expect(result.isError).toBe(false);
    expect(result.structuredContent?.event).toBe('SchedulerTick');
    expect(config.automations.SchedulerTick?.[0]?.id).toBe(result.structuredContent?.automationId);
  });

  it('updates an existing automation by id', async () => {
    const created = await handleAutomationCreate(ctx(), {
      kind: 'event',
      event: 'LabelAdd',
      matcher: 'urgent',
      actions: [{ type: 'prompt', prompt: 'Draft next steps' }],
    });

    const updated = await handleAutomationUpdate(ctx(), {
      automationId: String(created.structuredContent?.automationId),
      patch: { name: 'Urgent responder' },
    });

    expect(updated.isError).toBe(false);
    expect(readConfig().automations.LabelAdd?.[0]?.name).toBe('Urgent responder');
  });

  it('lets the agent tool set the per-task worktree toggle', async () => {
    // desktop-scheduled-tasks.md:34, and the only surface that actually creates
    // automations today: without this field in AutomationCreateSchema the flag
    // is dropped before it ever reaches the persisted matcher.
    const created = await handleAutomationCreate(ctx(), {
      kind: 'scheduled',
      cron: '0 3 * * *',
      worktree: true,
      actions: [{ type: 'prompt', prompt: 'nightly refactor' }],
    });

    expect(created.isError).toBe(false);
    expect(readConfig().automations.SchedulerTick?.[0]?.worktree).toBe(true);

    // AutomationUpdateSchema derives from AutomationCreateSchema.partial(), so
    // patching comes free — assert it rather than assume it.
    await handleAutomationUpdate(ctx(), {
      automationId: String(created.structuredContent?.automationId),
      patch: { worktree: false },
    });
    expect(readConfig().automations.SchedulerTick?.[0]?.worktree).toBe(false);
  });

  it('rejects scheduled automations without cron', async () => {
    const result = await handleAutomationCreate(ctx(), {
      kind: 'scheduled',
      actions: [{ type: 'prompt', prompt: 'Invalid' }],
    } as never);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('require cron');
  });

  it('rejects event automations with cron', async () => {
    const result = await handleAutomationCreate(ctx(), {
      kind: 'event',
      event: 'LabelAdd',
      cron: '0 9 * * *',
      actions: [{ type: 'prompt', prompt: 'Invalid' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('cannot set cron');
  });

  it('rejects an agentic automation on an event Nessy does not emit, with the reason (R73 · f001)', async () => {
    // `Setup` is a real Claude event, so a generic "requires an agent event"
    // reads as a spelling complaint and invites a retry. hooks.md#setup fires it
    // only under `--init-only` / `-p --init` / `-p --maintenance`, launch modes
    // this fork does not have, so the answer has to be the reason plus the
    // replacement — otherwise the model writes an automation that never runs.
    const result = await handleAutomationCreate(ctx(), {
      kind: 'agentic',
      event: 'Setup',
      actions: [{ type: 'prompt', prompt: 'install deps' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not supported');
    expect(result.content[0]?.text).toContain('SessionStart');
    expect(existsSync(join(workspaceRoot, 'automations.json'))).toBe(false);
  });

  /**
   * D1.430 — the model-facing tool may not grant itself a mode nobody approved.
   *
   * `automation_create` is invocable by the MODEL, its `permissionMode` is
   * stored verbatim, and `SessionManager.executePromptAutomation` hands it to
   * `createSession`, where the option outranks the project default and the
   * workspace floor. `clampPermissionModeToParent` is applied to SUBAGENTS only,
   * and the first-activation responsibility dialog that guards `bypassPermissions`
   * everywhere else lives in the renderer, which this path never reaches.
   *
   * The precedent for the answer is this fork's own
   * `REMOTE_CLIENT_PERMISSION_MODE_CEILING`: a caller that is not the person at
   * the machine gets a server-side ceiling rather than a hidden control. The
   * ceiling here is LOWER than the remote client's, for a stated reason — a
   * remote client is still a person who answers cards, while an automation run
   * is unattended by construction.
   */
  it('refuses a model-created automation that grants itself bypassPermissions, and says what it will accept', async () => {
    const result = await handleAutomationCreate(ctx(), {
      kind: 'scheduled',
      cron: '* * * * *',
      permissionMode: 'bypassPermissions',
      actions: [{ type: 'prompt', prompt: 'do the thing' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('bypassPermissions');
    // The reason names the highest mode the tool WILL take, so the model can
    // retry correctly instead of guessing; a bare refusal invites a retry loop.
    expect(result.content[0]?.text).toContain('acceptEdits');
    // Nothing was written. A refusal that still persisted the matcher would be
    // the defect with an error message on top.
    expect(existsSync(join(workspaceRoot, 'automations.json'))).toBe(false);
  });

  it('refuses `auto` too, because an automation run is unattended and auto still runs shell on a classifier verdict', async () => {
    const result = await handleAutomationCreate(ctx(), {
      kind: 'agentic',
      event: 'PreToolUse',
      permissionMode: 'auto',
      actions: [{ type: 'prompt', prompt: 'do the thing' }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('auto');
    expect(existsSync(join(workspaceRoot, 'automations.json'))).toBe(false);
  });

  it('refuses the same widening through automation_update\'s patch', async () => {
    const created = await handleAutomationCreate(ctx(), {
      kind: 'scheduled',
      cron: '0 9 * * *',
      actions: [{ type: 'prompt', prompt: 'daily' }],
    });

    const updated = await handleAutomationUpdate(ctx(), {
      automationId: String(created.structuredContent?.automationId),
      patch: { permissionMode: 'bypassPermissions' },
    });

    expect(updated.isError).toBe(true);
    // The record on disk is untouched — not widened, and not destroyed either
    // (the update path removes the matcher before re-adding it, so a refusal
    // that landed late would delete the automation it refused to change).
    const matcher = readConfig().automations.SchedulerTick?.[0];
    expect(matcher?.permissionMode).toBeUndefined();
    expect(matcher?.id).toBe(created.structuredContent?.automationId);
  });

  it('BOUNDARY — every mode at or below the ceiling is accepted, and an omitted mode stays omitted', async () => {
    // The positive control on the same instrument: a refusal that refused
    // everything would satisfy the three cases above and break the feature.
    for (const permissionMode of ['dontAsk', 'plan', 'default', 'acceptEdits'] as const) {
      const created = await handleAutomationCreate(ctx(), {
        kind: 'event',
        event: 'LabelAdd',
        permissionMode,
        actions: [{ type: 'prompt', prompt: permissionMode }],
      });
      expect(created.isError).toBe(false);
      expect(created.structuredContent?.automation).toMatchObject({ permissionMode });
    }

    const plain = await handleAutomationCreate(ctx(), {
      kind: 'event',
      event: 'LabelRemove',
      actions: [{ type: 'prompt', prompt: 'no mode' }],
    });
    expect(plain.isError).toBe(false);
    // `executePromptAutomation` reads `permissionMode || 'plan'`, so an
    // omitted field must stay omitted rather than becoming a stored default.
    expect(readConfig().automations.LabelRemove?.[0]?.permissionMode).toBeUndefined();
  });

  it('F1.1053 — a model that asks for the retired explore gets the schema error naming the six modes; nothing is stored', async () => {
    // Decided (DN-283, 2026-09-29): the model-facing enum validates, it does not coerce. Stored values are read
    // through the alias table where they are stored (shared/src/automations/management.ts); a model's argument is
    // fresh input, and the SDK's documented shape is that a tool handler receives VALIDATED arguments
    // (agent-sdk/custom-tools.md, "Create a custom tool"), so the error teaches the next call the six names.
    const refused = await handleAutomationCreate(ctx(), {
      kind: 'event',
      event: 'LabelAdd',
      permissionMode: 'explore' as never,
      actions: [{ type: 'prompt', prompt: 'retired mode' }],
    });
    expect(refused.isError).toBe(true);
    const text = refused.content.map(part => ('text' in part ? part.text : '')).join('');
    expect(text).toContain('explore');
    expect(text).toContain("'plan'");
    expect(existsSync(join(workspaceRoot, 'automations.json'))).toBe(false);
  });

  it('CONTROL — a user-created bypassPermissions automation survives a tool edit that does not name the mode', async () => {
    // The UI/RPC route (`handlers/rpc/automations.ts`) is a PERSON acting in
    // their own app and is deliberately not clamped. Its records reach this
    // handler on the next `automation_update`, and an unrelated patch must not
    // destroy what the user chose.
    writeFileSync(join(workspaceRoot, 'automations.json'), JSON.stringify({
      version: 2,
      automations: {
        SchedulerTick: [{
          id: 'usr12345',
          cron: '0 4 * * *',
          permissionMode: 'bypassPermissions',
          actions: [{ type: 'prompt', prompt: 'nightly' }],
        }],
      },
    }), 'utf8');

    const updated = await handleAutomationUpdate(ctx(), {
      automationId: 'usr12345',
      patch: { name: 'Nightly' },
    });

    expect(updated.isError).toBe(false);
    expect(readConfig().automations.SchedulerTick?.[0]).toMatchObject({
      name: 'Nightly',
      permissionMode: 'bypassPermissions',
    });
  });

  it('delegates to ctx.automationManager when present', async () => {
    const list = mock(async () => ({
      content: [{ type: 'text' as const, text: 'delegated' }],
      structuredContent: { ok: true },
    }));
    const result = await handleAutomationList(ctx({
      automationManager: {
        list,
        create: mock(async () => ({ content: [], structuredContent: {} })),
        update: mock(async () => ({ content: [], structuredContent: {} })),
        validate: mock(async () => ({ content: [], structuredContent: {} })),
      },
    }), { includeDisabled: true });

    expect(list).toHaveBeenCalledWith({ includeDisabled: true });
    expect(result.structuredContent).toEqual({ ok: true });
  });
});

function ctx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
  return {
    sessionId: 'session-1',
    workspacePath: workspaceRoot,
    get sourcesPath() { return join(workspaceRoot, 'sources'); },
    get skillsPath() { return join(workspaceRoot, 'skills'); },
    plansFolderPath: join(workspaceRoot, 'plans'),
    callbacks: {
      onPlanSubmitted() {},
      onAuthRequest() {},
    },
    fs: {
      exists: (path) => existsSync(path),
      readFile: (path) => readFileSync(path, 'utf8'),
      readFileBuffer: (path) => readFileSync(path),
      writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
      atomicWriteFile: (path, content) => writeFileSync(path, content, 'utf8'),
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
    ...overrides,
    configRoot: overrides.configRoot ?? workspaceRoot,
  };
}

function readConfig(): {
  automations: Record<string, Array<Record<string, unknown>>>;
} {
  return JSON.parse(readFileSync(join(workspaceRoot, 'automations.json'), 'utf8'));
}

/**
 * F1.115 (origin `D1.430`'s residue, measured by WI-bw) — the ceiling has to be
 * on the FIELD, not only in the tool description.
 *
 * `D1.430` shipped a server-side refusal of `auto` and `bypassPermissions` for
 * the two model-facing automation tools, and the refusal names what it will
 * accept, so nothing was unsafe. What it left is a cost paid once per model:
 * the input schema still offers all seven enum members, so a model reading the
 * schema alone tries one and burns a turn on the refusal. The description is
 * what a model reads beside the enum.
 *
 * Driven through `getToolDefsAsJsonSchema` — the MODEL-FACING projection, the
 * same payload `tool-surface.json`'s `live-json-schema` digests hash — rather
 * than over the zod object, so the arm fails if the description is written
 * somewhere the projection drops.
 */
describe('F1.115 · the automation permissionMode field carries its ceiling', () => {
  function modelFacingSchema(tool: string): Record<string, any> {
    const definitions = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', includeDeveloperFeedback: true });
    const found = definitions.find(definition => definition.name === `mcp__session__${tool}`);
    if (!found) throw new Error(`no model-facing definition for ${tool}`);
    return found.inputSchema as Record<string, any>;
  }

  it('automation_create describes the ceiling on the field itself', () => {
    const field = modelFacingSchema('automation_create').properties?.permissionMode;
    expect(field?.description ?? '').toContain('"acceptEdits" or narrower');
    expect(field?.description ?? '').toContain('are refused');
    // The enum keeps all seven ON PURPOSE — see the schema's own comment. A
    // narrowed enum turns a named refusal into a spelling complaint and leaves
    // `assertPermissionModeWithinCeiling` as the only real gate.
    expect(field?.enum).toContain('bypassPermissions');
    expect(field?.enum).toContain('auto');
  });

  /**
   * `AutomationUpdateSchema` is `AutomationCreateSchema.partial()`, so this arm
   * is also the live check that the two are ONE declaration rather than two
   * copies — it is why the re-pin moved exactly two fixture rows and not one.
   */
  it('automation_update inherits it through the partial(), rather than restating it', () => {
    const patch = modelFacingSchema('automation_update').properties?.patch;
    const field = patch?.properties?.permissionMode;
    expect(field?.description ?? '').toContain('"acceptEdits" or narrower');
    expect(field?.description ?? '')
      .toBe(modelFacingSchema('automation_create').properties?.permissionMode?.description);
  });

  /**
   * The negative that keeps the pair honest: a sibling field of the same schema
   * is untouched, so the two arms above are reading a per-field description and
   * not something the projection stamps on everything.
   */
  it('CONTROL — a sibling field of the same schema carries no such text', () => {
    const properties = modelFacingSchema('automation_create').properties ?? {};
    expect(Object.keys(properties)).toContain('worktree');
    expect(properties.worktree?.description ?? '').not.toContain('acceptEdits');
  });
});

/**
 * F1.113 — the rule the host's permission gate asks: does this `automation_update`
 * replace the actions of an automation a PERSON set above the tool ceiling? The
 * card itself is the gate's (`shared/src/agent/__tests__/automation-unattended-edit-card.test.ts`);
 * these arms pin the rule's edges, both ways.
 */
describe('F1.113 — findUnattendedAutomationEdit', () => {
  const stored = {
    version: 2,
    automations: {
      SchedulerTick: [
        { id: 'bypass', name: 'Nightly sweep', permissionMode: 'bypassPermissions', actions: [{ type: 'prompt', prompt: 'old' }] },
        { id: 'auto', permissionMode: 'auto', actions: [{ type: 'prompt', prompt: 'old' }] },
        { id: 'narrow', permissionMode: 'acceptEdits', actions: [{ type: 'prompt', prompt: 'old' }] },
        { id: 'unset', actions: [{ type: 'prompt', prompt: 'old' }] },
        { id: 'legacy', permissionMode: 'allow-all', actions: [{ type: 'prompt', prompt: 'old' }] },
        { id: 'unknown', permissionMode: 'sudo', actions: [{ type: 'prompt', prompt: 'old' }] },
      ],
    },
  };
  const edit = (automationId: string, patch: Record<string, unknown>) =>
    findUnattendedAutomationEdit({ automationId, patch }, stored);
  const newActions = { actions: [{ type: 'prompt', prompt: 'new' }] };

  it('names an actions edit of an automation stored above the ceiling', () => {
    expect(edit('bypass', newActions)).toEqual({ automationId: 'bypass', name: 'Nightly sweep', permissionMode: 'bypassPermissions', changes: ['actions'] });
    expect(edit('auto', newActions)).toEqual({ automationId: 'auto', permissionMode: 'auto', changes: ['actions'] });
  });

  it('CONTROL — at or below the ceiling, or with no stored mode, there is nothing to ask about', () => {
    expect(edit('narrow', newActions)).toBeUndefined();
    expect(edit('unset', newActions)).toBeUndefined();
  });

  it('asks about a stored spelling it cannot rank, rather than assuming it narrow', () => {
    expect(edit('unknown', newActions)?.permissionMode).toBe('sudo');
    // F1.1166: a legacy alias is ranked (and named) as the alias table reads it — allow-all is bypassPermissions.
    expect(edit('legacy', newActions)?.permissionMode).toBe('bypassPermissions');
  });

  it('leaves an edit that touches no actions, or that also sets the mode, to the ordinary path', () => {
    expect(edit('bypass', { name: 'Renamed' })).toBeUndefined();
    // A mode in the patch is either within the ceiling (then that is what runs)
    // or refused by the handler; neither needs the card.
    expect(edit('bypass', { ...newActions, permissionMode: 'acceptEdits' })).toBeUndefined();
    expect(edit('missing', newActions)).toBeUndefined();
  });
});

/**
 * F1.1193 — the ceiling ranks modes by `PERMISSION_MODE_ORDER` itself, not by a
 * hand-synced copy whose docblock claimed the package could not import it.
 */
describe('F1.1193 — the automation ceiling ranks by the shared mode order', () => {
  it('is the shared order itself, so a mode change cannot drift it', () => {
    expect(PERMISSION_MODES_LEAST_TO_MOST_PERMISSIVE).toBe(PERMISSION_MODE_ORDER);
  });

  it('BOUNDARY — every mode the order puts above acceptEdits is refused, every one at or below is stored', async () => {
    const ceiling = PERMISSION_MODE_ORDER.indexOf('acceptEdits');
    for (const [rank, mode] of PERMISSION_MODE_ORDER.entries()) {
      const result = await handleAutomationCreate(ctx(), {
        kind: 'scheduled',
        cron: '0 9 * * *',
        permissionMode: mode,
        actions: [{ type: 'prompt', prompt: `run in ${mode}` }],
      });
      expect({ mode, refused: result.isError === true }).toEqual({ mode, refused: rank > ceiling });
    }
  });
});

/**
 * F1.1193 follow-up — the unemitted-event reasons are shared's
 * `UNEMITTED_HOOK_EVENT_REASONS` itself, not a copy whose text had already
 * drifted from it (the copy dropped "so it would never run").
 */
describe('F1.1193 follow-up — unemitted events answer with the shared reason', () => {
  it('rejects every event shared names as unemitted with its full shared reason', async () => {
    const events = Object.keys(UNEMITTED_HOOK_EVENT_REASONS);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const result = await handleAutomationCreate(ctx(), {
        kind: 'agentic',
        event,
        actions: [{ type: 'prompt', prompt: `on ${event}` }],
      });
      const text = result.content[0]?.text ?? '';
      const reason = `${event} automations are not supported: ${UNEMITTED_HOOK_EVENT_REASONS[event]}`;
      expect({ event, refused: result.isError === true, endsWithSharedReason: text.endsWith(reason), text })
        .toEqual({ event, refused: true, endsWithSharedReason: true, text });
    }
  });

  it('BOUNDARY — an emitted agent event outside the table is stored', async () => {
    expect(UNEMITTED_HOOK_EVENT_REASONS.SessionStart).toBeUndefined();
    const result = await handleAutomationCreate(ctx(), {
      kind: 'agentic',
      event: 'SessionStart',
      actions: [{ type: 'prompt', prompt: 'on start' }],
    });
    expect(result.isError).not.toBe(true);
  });
});

/**
 * F1.1206 — the no-`automationManager` fallback classifies events by shared's
 * own APP_EVENTS and AGENT_EVENTS (`shared/src/automations/types.ts`), the lists
 * the production path (`shared/src/automations/management.ts`) reads. Its hand
 * copy kept 12 of shared's 32 agent events, so a `FileChanged` automation was
 * refused as "not an agent event", and one stored by hand made every later
 * write of the file fail validation.
 */
describe('F1.1206 — the fallback path classifies events by shared\'s lists', () => {
  it('stores every agent event shared lists as agentic and every app event as event, in one file', async () => {
    expect(AGENT_EVENTS.length).toBeGreaterThan(12);
    const refused: string[] = [];
    for (const event of AGENT_EVENTS) {
      const result = await handleAutomationCreate(ctx(), { kind: 'agentic', event, actions: [{ type: 'prompt', prompt: `on ${event}` }] });
      if (result.isError === true) refused.push(`${event}: ${result.content[0]?.text ?? ''}`);
    }
    for (const event of APP_EVENTS.filter(name => name !== 'SchedulerTick')) {
      const result = await handleAutomationCreate(ctx(), { kind: 'event', event, actions: [{ type: 'prompt', prompt: `on ${event}` }] });
      if (result.isError === true) refused.push(`${event}: ${result.content[0]?.text ?? ''}`);
    }
    expect(refused).toEqual([]);
    const fileChanged = readConfig().automations.FileChanged?.[0]?.id as string | undefined;
    expect(typeof fileChanged).toBe('string');
    const update = await handleAutomationUpdate(ctx(), { automationId: fileChanged!, patch: { name: 'Renamed' } });
    expect(update.isError).not.toBe(true);
  });

  it('BOUNDARY — a name in neither list, or in the other kind\'s list, is still refused', async () => {
    const prompt = [{ type: 'prompt', prompt: 'x' }];
    const unknown = await handleAutomationCreate(ctx(), { kind: 'agentic', event: 'NotAnEvent', actions: prompt });
    const appAsAgentic = await handleAutomationCreate(ctx(), { kind: 'agentic', event: 'LabelAdd', actions: prompt });
    const agentAsEvent = await handleAutomationCreate(ctx(), { kind: 'event', event: 'FileChanged', actions: prompt });
    expect([unknown, appAsAgentic, agentAsEvent].map(result => result.isError)).toEqual([true, true, true]);
    expect(unknown.content[0]?.text).toContain('Agentic automations require an agent event.');
    expect(agentAsEvent.content[0]?.text).toContain('Event automations require an app event excluding SchedulerTick.');
    expect(existsSync(join(workspaceRoot, 'automations.json'))).toBe(false);
  });
});

/**
 * F1.228 (origin WJ-l P-WJ-l-5) — DECIDED by the controller 2026-09-23, balance
 * rule: anything that changes WHAT or WHEN an automation stored above the
 * ceiling runs unattended asks the person. F1.113 covered the actions; these
 * arms are WHEN — re-enabling it, and its trigger or schedule — one field each,
 * each red before the rule widened, with the ordinary-path edits as controls.
 */
describe('F1.228 — WHEN an unattended automation runs is gated too', () => {
  const stored = {
    version: 2,
    automations: {
      SchedulerTick: [
        { id: 'nightly', name: 'Nightly sweep', cron: '0 3 * * *', timezone: 'UTC', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
        { id: 'tidy', cron: '0 4 * * *', permissionMode: 'acceptEdits', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
      ],
      LabelAdd: [
        { id: 'on-label', matcher: 'urgent', permissionMode: 'auto', conditions: [{ type: 'label', label: 'a' }], actions: [{ type: 'prompt', prompt: 'old' }] },
      ],
    },
  };
  const edit = (automationId: string, patch: Record<string, unknown>) =>
    findUnattendedAutomationEdit({ automationId, patch }, stored)?.changes;

  it('re-enabling a disabled bypass automation asks', () => {
    expect(edit('nightly', { enabled: true })).toEqual(['enabled']);
  });

  it('moving its schedule asks — cron, and timezone', () => {
    expect(edit('nightly', { cron: '*/5 * * * *' })).toEqual(['cron']);
    expect(edit('nightly', { timezone: 'Europe/Moscow' })).toEqual(['timezone']);
  });

  it('moving its trigger asks — kind, event, matcher, and the conditions that gate it', () => {
    expect(edit('nightly', { kind: 'event', event: 'LabelAdd' })).toEqual(['kind', 'event']);
    expect(edit('on-label', { matcher: '.*' })).toEqual(['matcher']);
    expect(edit('on-label', { conditions: [] })).toEqual(['conditions']);
  });

  it('names every changed field at once, actions first', () => {
    expect(edit('nightly', { enabled: true, cron: '* * * * *', actions: [{ type: 'prompt', prompt: 'new' }] }))
      .toEqual(['actions', 'cron', 'enabled']);
  });

  it('CONTROL — renaming, labels, worktree and DISABLING stay on the ordinary path', () => {
    expect(edit('nightly', { name: 'Renamed' })).toBeUndefined();
    expect(edit('nightly', { labels: ['x'] })).toBeUndefined();
    expect(edit('nightly', { worktree: true })).toBeUndefined();
    expect(edit('on-label', { enabled: false })).toBeUndefined();
  });

  it('CONTROL — resending the stored values unchanged asks for nothing', () => {
    expect(edit('nightly', { cron: '0 3 * * *', timezone: 'UTC', kind: 'scheduled', event: 'SchedulerTick' })).toBeUndefined();
    expect(edit('on-label', { conditions: [{ label: 'a', type: 'label' }] })).toBeUndefined();
  });

  it('CONTROL — the same WHEN edits of an automation at the ceiling need no card', () => {
    expect(edit('tidy', { enabled: true })).toBeUndefined();
    expect(edit('tidy', { cron: '* * * * *' })).toBeUndefined();
  });
});

/**
 * F1.1212 (origin ST-1, 2026-10-01) — the FALLBACK path (no automation manager on the context) read automations.json
 * raw and refused a `TodoStateChange` key, which shared's schema accepts as a deprecated alias of `SessionStatusChange`
 * and rewrites on load (`DEPRECATED_EVENT_ALIASES`, `automations/schemas.ts` + `validation.ts`). The fallback now
 * reads the same table and rewrites the same way. Fallback only: every runtime has a manager in production.
 */
describe('F1.1212 — the fallback path takes the deprecated TodoStateChange alias as shared does', () => {
  const seed = (automations: Record<string, unknown>): void => {
    writeFileSync(join(workspaceRoot, 'automations.json'), JSON.stringify({ version: 2, automations }), 'utf8');
  };

  it('validate accepts a raw TodoStateChange key', async () => {
    seed({ TodoStateChange: [{ id: 'aa0001', matcher: 'done', actions: [{ type: 'prompt', prompt: 'Wrap up' }] }] });
    const result = await handleAutomationValidate(ctx(), {});
    expect(result.content[0]?.text).toBe('Automations config is valid.');
    expect(result.isError).toBe(false);
  });

  it('a write after it stores the entry under SessionStatusChange, merged in the file\'s key order as shared does', async () => {
    seed({
      TodoStateChange: [{ id: 'aa0001', matcher: 'done', actions: [{ type: 'prompt', prompt: 'Wrap up' }] }],
      SessionStatusChange: [{ id: 'aa0002', matcher: 'needs-review', actions: [{ type: 'prompt', prompt: 'Review' }] }],
    });
    const created = await handleAutomationCreate(ctx(), {
      kind: 'event', event: 'LabelAdd', matcher: 'urgent', actions: [{ type: 'prompt', prompt: 'Triage' }],
    });
    expect(created.isError).toBe(false);
    const config = readConfig();
    expect(config.automations.TodoStateChange).toBeUndefined();
    expect(config.automations.SessionStatusChange?.map(entry => entry.id)).toEqual(['aa0001', 'aa0002']);
    // The manager path's own reading of the same keys, for the "as shared does" half.
    const shared = AutomationsConfigSchema.parse({
      version: 2,
      automations: {
        TodoStateChange: [{ id: 'aa0001', matcher: 'done', actions: [{ type: 'prompt', prompt: 'Wrap up' }] }],
        SessionStatusChange: [{ id: 'aa0002', matcher: 'needs-review', actions: [{ type: 'prompt', prompt: 'Review' }] }],
      },
    }) as { automations: Record<string, Array<{ id?: string }>> };
    expect(shared.automations.SessionStatusChange?.map(entry => entry.id)).toEqual(['aa0001', 'aa0002']);
  });

  it('CONTROL — an unknown event key is still refused', async () => {
    seed({ TodoStateChanged: [{ id: 'aa0003', actions: [{ type: 'prompt', prompt: 'x' }] }] });
    const result = await handleAutomationValidate(ctx(), {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unsupported automation event: TodoStateChanged');
  });

  // F1.1212 follow-up — the alias lookup reads only the table's OWN keys, and the rewritten map keeps every key as an
  // own key: a key named after an Object.prototype member is refused under its own name, never as the member's value,
  // and a raw `__proto__` key (JSON.parse makes it an own key) is neither dropped nor turned into a prototype.
  for (const key of ['constructor', 'toString', '__proto__']) {
    it(`BOUNDARY — a raw ${key} key is refused under its own name`, async () => {
      writeFileSync(join(workspaceRoot, 'automations.json'),
        `{"version":2,"automations":{${JSON.stringify(key)}:[{"id":"aa0004","actions":[{"type":"prompt","prompt":"x"}]}]}}`, 'utf8');
      const result = await handleAutomationValidate(ctx(), {});
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(`Unsupported automation event: ${key}`);
      expect(result.content[0]?.text).not.toContain('native code');
    });
  }
});

/** F1.1269 — the fallback path keeps an updated automation's position within its event, like shared's writer. */
describe('F1.1269 — the fallback path updates in place when the event is unchanged', () => {
  it('editing the first of three LabelAdd automations leaves the order as it was', async () => {
    const ids: string[] = [];
    for (const name of ['first', 'second', 'third']) {
      const created = await handleAutomationCreate(ctx(), {
        kind: 'event', event: 'LabelAdd', matcher: name, actions: [{ type: 'prompt', prompt: name }],
      });
      ids.push(String(created.structuredContent?.automationId));
    }
    const updated = await handleAutomationUpdate(ctx(), { automationId: ids[0]!, patch: { name: 'renamed' } });
    expect(updated.isError).toBe(false);
    expect(readConfig().automations.LabelAdd?.map(matcher => matcher.id)).toEqual(ids);
    expect(updated.structuredContent?.matcherIndex).toBe(0);
  });

  it('BOUNDARY — a move to another event appends to the target and keeps the rest in order', async () => {
    const ids: string[] = [];
    for (const name of ['first', 'second']) {
      const created = await handleAutomationCreate(ctx(), {
        kind: 'event', event: 'LabelAdd', matcher: name, actions: [{ type: 'prompt', prompt: name }],
      });
      ids.push(String(created.structuredContent?.automationId));
    }
    await handleAutomationUpdate(ctx(), { automationId: ids[0]!, patch: { kind: 'event', event: 'LabelRemove' } });
    expect(readConfig().automations.LabelAdd?.map(matcher => matcher.id)).toEqual([ids[1]]);
    expect(readConfig().automations.LabelRemove?.map(matcher => matcher.id)).toEqual([ids[0]]);
  });
});

/** F1.1265 — the fallback path's automation_list text carries the compact list, like the two host managers. */
describe('F1.1265 — the fallback automation_list names each automation in its text', () => {
  it('one line per automation: id, name, event, mode, enabled', async () => {
    const created = await handleAutomationCreate(ctx(), {
      kind: 'event', event: 'LabelAdd', matcher: 'urgent', name: 'Urgent', permissionMode: 'plan',
      actions: [{ type: 'prompt', prompt: 'triage' }],
    });
    const result = await handleAutomationList(ctx(), {});
    const text = result.content.map(part => ('text' in part ? part.text : '')).join('\n');
    expect(text).toContain('Found 1 automation(s).');
    expect(text).toContain(`${String(created.structuredContent?.automationId)} · Urgent · LabelAdd · mode plan · enabled`);
  });

  it('NEGATIVE — no automations: the one sentence alone', async () => {
    const result = await handleAutomationList(ctx(), {});
    expect(result.content.map(part => ('text' in part ? part.text : '')).join('\n')).toBe('Found 0 automation(s).');
  });
});
