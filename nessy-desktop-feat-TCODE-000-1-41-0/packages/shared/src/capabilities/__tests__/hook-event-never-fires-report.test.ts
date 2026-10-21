/**
 * P6.13 — "the codex import registers a PostToolUse hook that can never fire,
 * and records no deferral."
 *
 * The refutation first, because it decides where the fix belongs: the deferral
 * table the row points at (`DEFERRED_EXTERNAL_HOOK_EVENT_REASONS`, beside
 * `Setup`) is read by `mapExternalHookEventName` at IMPORT time, which knows no
 * runtime. `PostToolUse` fires on Pi and on claude-runtime, so a global deferral
 * would have deleted a working capability on two runtimes to describe an absence
 * on a third. The runtime-scoped answer is a report at REGISTRATION, which is
 * the one place the registered vocabulary and the session's provider are both
 * in hand — and that is what these pins hold.
 */
import { describe, expect, it } from 'bun:test';
import type { SdkAutomationInput } from '../../automations/index.ts';
import type { CapabilitySnapshotMaterializer } from '../materializer.ts';
import { buildPinnedAgentAutomationSystem } from '../runtime-automations.ts';
import type { AgentRuntimeView } from '../views.ts';

function runtimeWithHooks(hooks: Record<string, unknown>) {
  const materializer = {
    assertActive() {},
    async readText() { return JSON.stringify({ hooks }); },
  } as unknown as CapabilitySnapshotMaterializer;
  const resource = {
    source: 'workspace' as const,
    scope: { kind: 'workspace' as const, workspaceId: 'ws-1' },
    resourceId: 'hook:workspace:codex.json',
    absolutePath: '/codex/hooks.json',
    revision: '1',
    contentHash: 'b'.repeat(64),
  };
  const view = {
    generation: 'generation-1',
    sources: [], skills: [], mcpServers: [],
    hooks: [{ key: resource.resourceId, event: 'hooks.json', resource, executableHash: resource.contentHash }],
    automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
  } as AgentRuntimeView;
  return { view, materializer };
}

/**
 * The `unwired`-on-codex exemplar. It was `PostToolUse` until 2026-09-04, when
 * P3.335 (`0e9eae3ff`) built the codex emitter and moved that cell to `emitted`
 * — leaving these four cases asserting a report for an event that now fires,
 * which is the drift the cells exist to prevent, one layer out. `PermissionRequest`
 * is still `unwired` on codex AND is one of codex's own eleven `[hooks]` keys,
 * so it exercises both halves the way `PostToolUse` did. Read
 * `CODEX_HOOK_EVENT_EMISSION` before changing it: an `emitted` exemplar makes
 * every case here vacuous.
 */
const unwiredOnCodex = { PermissionRequest: [{ matcher: 'Edit', actions: [{ type: 'command', command: 'node scan.js' }] }] };

describe('registering a hook for an event this runtime never fires', () => {
  it('reports the codex PostToolUse registration, with the verdict that says it is buildable', async () => {
    const reports: Array<{ event: string; kind: string; note: string }> = [];

    await buildPinnedAgentAutomationSystem(runtimeWithHooks(unwiredOnCodex), {
      workspaceRootPath: '/workspace',
      provider: 'codex-runtime',
      onHookEventNeverFires: report => { reports.push(report) },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ event: 'PermissionRequest', kind: 'unwired' });
    // The note must name what the native-first question found, not restate the
    // verdict: codex fires this event itself.
    expect(reports[0]?.note).toContain('HookEventName');
  });

  it('the hook stays REGISTERED — the report removes the silence, not the capability', async () => {
    // Withholding it would be indistinguishable from the plugin not being
    // installed, and `unwired` says an emitter may land tomorrow.
    const system = await buildPinnedAgentAutomationSystem(runtimeWithHooks(unwiredOnCodex), {
      workspaceRootPath: '/workspace',
      provider: 'codex-runtime',
      onHookEventNeverFires: () => {},
    });

    const input = { hook_event_name: 'PermissionRequest', tool_name: 'Edit' } as SdkAutomationInput;
    expect(await system!.executeAgentEvent('PermissionRequest', input)).toMatchObject({ matchedCount: 1 });
  });

  it('says nothing for an event codex does emit', async () => {
    const reports: string[] = [];

    await buildPinnedAgentAutomationSystem(
      runtimeWithHooks({ SessionStart: [{ actions: [{ type: 'command', command: 'node start.js' }] }] }),
      {
        workspaceRootPath: '/workspace',
        provider: 'codex-runtime',
        onHookEventNeverFires: report => { reports.push(report.event) },
      },
    );

    expect(reports).toEqual([]);
  });

  it('says nothing on a runtime with no measured column, and nothing with no provider', async () => {
    // The negative that matters most: a false "never fires" on claude would tell
    // a user their working hook is dead. Silence is the honest answer where the
    // emitter lives inside a binary we cannot read.
    const claude: string[] = [];
    await buildPinnedAgentAutomationSystem(runtimeWithHooks(unwiredOnCodex), {
      workspaceRootPath: '/workspace',
      provider: 'anthropic',
      onHookEventNeverFires: report => { claude.push(report.event) },
    });
    expect(claude).toEqual([]);

    const noProvider: string[] = [];
    await buildPinnedAgentAutomationSystem(runtimeWithHooks(unwiredOnCodex), {
      workspaceRootPath: '/workspace',
      onHookEventNeverFires: report => { noProvider.push(report.event) },
    });
    expect(noProvider).toEqual([]);
  });

  it('reports each event once even when several hooks register it', async () => {
    const reports: string[] = [];

    await buildPinnedAgentAutomationSystem(
      runtimeWithHooks({
        PermissionRequest: [
          { matcher: 'Edit', actions: [{ type: 'command', command: 'node a.js' }] },
          { matcher: 'Write', actions: [{ type: 'command', command: 'node b.js' }] },
        ],
        PreToolUse: [{ matcher: 'Bash', actions: [{ type: 'command', command: 'node c.js' }] }],
      }),
      {
        workspaceRootPath: '/workspace',
        provider: 'codex-runtime',
        onHookEventNeverFires: report => { reports.push(report.event) },
      },
    );

    expect(reports.sort()).toEqual(['PermissionRequest', 'PreToolUse']);
  });

  // -------------------------------------------------------------------------
  // P6.14 — the half P6.13's report could not say
  // -------------------------------------------------------------------------

  it("carries codex's OWN key for the moment, so 'never fires' cannot read as 'cannot work here'", async () => {
    // The distinction the native-first rule exists to keep: `PermissionRequest`
    // is absent because of OUR configuration, not because codex lacks the moment
    // — `permissionRequest` is a key its own binary parses and registers.
    // Reporting the KEY rather than a flag is what makes that actionable.
    const reports: Array<{ event: string; nativeRoute?: string }> = [];

    await buildPinnedAgentAutomationSystem(runtimeWithHooks(unwiredOnCodex), {
      workspaceRootPath: '/workspace',
      provider: 'codex-runtime',
      onHookEventNeverFires: report => { reports.push(report) },
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.nativeRoute).toBe('PermissionRequest');
  });

  it('omits the route entirely for an event codex has no counterpart for', async () => {
    // P6.883 — the exemplar is `WorktreeCreate`, and the event this case used to
    // name is registered BESIDE it rather than deleted.
    //
    // `WorktreeCreate` is OUR vocabulary — codex's eleven have no member for it,
    // and a codex session never reaches the worktree isolation state either
    // (`CODEX_HOOK_EVENT_EMISSION`, `unreachable`) — so the field must be ABSENT
    // rather than `undefined`, and a consumer keying off its presence is never
    // told there is a route when there is none.
    //
    // `StopFailure` held this part until P6.118 (`de4eb26bf`) minted it host-side
    // from `ErrorNotification`, which moved that cell to `emitted`; asserting its
    // absence any longer would assert the opposite of what ships. Registering it
    // here makes the report's SILENCE about it the thing the length assertion
    // pins — it goes red again the day the cell moves back.
    // (`PostToolUseFailure` played the part before that, until `0e9eae3ff`.)
    const reports: Array<Record<string, unknown>> = [];

    await buildPinnedAgentAutomationSystem(
      runtimeWithHooks({
        WorktreeCreate: [{ matcher: 'Edit', actions: [{ type: 'command', command: 'node scan.js' }] }],
        StopFailure: [{ matcher: 'Edit', actions: [{ type: 'command', command: 'node stop.js' }] }],
      }),
      {
        workspaceRootPath: '/workspace',
        provider: 'codex-runtime',
        onHookEventNeverFires: report => { reports.push(report as unknown as Record<string, unknown>) },
      },
    );

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ event: 'WorktreeCreate', kind: 'unreachable' });
    expect('nativeRoute' in reports[0]!).toBe(false);
  });
});
