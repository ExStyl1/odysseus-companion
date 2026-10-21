/**
 * P3.301 — `isolation` is dropped for codex with NO diagnostic, where `model`,
 * `tools` and `permissionMode` each get one.
 *
 * ## Why the silence looked like completeness
 *
 * `buildCodexAgentRoles` (`codex-responses-adapter/src/config-writer.ts`) reports
 * every field it cannot honour: a tool grant and a lowered permission mode DENY
 * the role by name, a foreign `model` is dropped with a sentence. It reports
 * nothing for `isolation` because `isolation` is absent from
 * `CodexAgentRoleDescriptor` ENTIRELY — the writer never receives the field, so
 * it has nothing to report. The full descriptors exist on exactly one side of
 * that boundary, and that is `codex-agent.ts`.
 *
 * ## What is lost
 *
 * `isolation: worktree` is an author's explicit request that the subagent run
 * against a scratch checkout rather than the user's own tree. Pi honours it
 * (`runtime-agent-definition.ts` records the spawner keying on
 * `isolation === 'worktree'`); the claude SDK accepts the field
 * (`claude-runtime-agents.ts`). So the same definition edits a throwaway
 * worktree on two runtimes and the real repository on the third — the
 * silent-divergence class, and P3.205's tripwire is the claude-side twin of this
 * report.
 *
 * WHAT EACH TEST KILLS:
 *  - "reports every definition that asked for isolation" dies if the loop is
 *    dropped — the shipped state.
 *  - "says nothing about a definition that asked for none" dies if the guard is
 *    dropped and every subagent gains a line, which makes the channel useless
 *    for the definitions that did ask.
 *  - "names the value, not just the field" dies if the message stops carrying
 *    the requested isolation: an operator cannot tell which request was refused.
 *    `AgentIsolation` is `'worktree'` alone in this fork (`agents/definitions.ts`)
 *    though the claude SDK's own schema also accepts `remote`, so the message
 *    interpolates the value rather than hard-coding today's single member.
 *  - the source pin dies if the reporter exists and `createRuntime` stops
 *    calling it — a diagnostic nothing invokes is the defect wearing a fix.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BackendConfig } from '../backend/types.ts';
import type { PiRuntimeAgentDefinitionDescriptor } from '../pi-harness/runtime-agent-definition.ts';
import { CodexAgent } from '../codex-agent.ts';

function definition(
  key: string,
  isolation?: PiRuntimeAgentDefinitionDescriptor['isolation'],
): PiRuntimeAgentDefinitionDescriptor {
  return {
    schemaVersion: 2,
    key,
    name: key,
    description: `${key} agent`,
    selectedAsUnqualifiedAlias: false,
    systemPrompt: 'do the thing',
    sha256: 'x'.repeat(64),
    provenance: 'user',
    capabilityGeneration: 'gen-1',
    definitionDigest: 'd'.repeat(64),
    ...(isolation ? { isolation } : {}),
  };
}

function createConfig(definitions: readonly PiRuntimeAgentDefinitionDescriptor[]): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-isolation',
      name: 'Codex Isolation Workspace',
      rootPath: '/tmp/ws-codex-isolation-root',
      workspaceRootPath: '/tmp/ws-codex-isolation-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-isolation',
    } as any,
    session: {
      id: 'session-codex-isolation',
      workspaceRootPath: '/tmp/ws-codex-isolation-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    piRuntimeAgentDefinitions: definitions,
  } as BackendConfig;
}

function reported(definitions: readonly PiRuntimeAgentDefinitionDescriptor[]): string[] {
  const agent = new CodexAgent(createConfig(definitions));
  const lines: string[] = [];
  const internals = agent as unknown as {
    debug: (message: string) => void;
    reportDroppedCodexAgentIsolation: () => void;
  };
  internals.debug = (message: string) => lines.push(message);
  internals.reportDroppedCodexAgentIsolation();
  return lines;
}

describe('P3.301 · a dropped `isolation` is reported, like its three siblings', () => {
  it('reports every definition that asked for isolation', () => {
    const lines = reported([
      definition('scout', 'worktree'),
      definition('planner'),
      definition('worker', 'worktree'),
    ]);
    // FILTERED to the per-definition family on purpose. P3.337 added ONE
    // aggregated operator notice beside these, and with no turn sink attached
    // `surfaceCodexOperatorNotice` defers it and records that on the same debug
    // channel — so a bare length assertion here would count the notice as a
    // third report and read as a regression in the loop below it.
    const perDefinition = lines.filter(line => line.startsWith('Imported agent'));
    expect(perDefinition).toHaveLength(2);
    expect(perDefinition[0]).toContain('Imported agent scout declares isolation "worktree"');
    expect(perDefinition[1]).toContain('Imported agent worker declares isolation "worktree"');
    // And the deferral itself is pinned, because it is what makes the notice
    // survive being raised before any turn exists.
    expect(lines.some(line => line.includes('Codex warning held for the next turn'))).toBe(true);
  });

  it('names the value and what happens instead, not just the field', () => {
    const [line] = reported([definition('scout', 'worktree')]);
    expect(line).toContain('"worktree"');
    expect(line).toContain('codex has no counterpart for');
    expect(line).toContain("this session's own working directory");
  });

  it('says nothing about a definition that asked for none', () => {
    expect(reported([definition('planner'), definition('reviewer')])).toEqual([]);
    expect(reported([])).toEqual([]);
  });
});

/**
 * P3.337 — the same fact, on a channel a packaged build can show.
 *
 * The per-definition lines above go to `debug`, which routes through
 * electron-log, whose transports the packaged main process disables — the trap
 * register's own "an empty packaged `main.log` is not evidence". P3.301 left
 * them there on purpose, because `surfaceCodexOperatorNotice`'s queue holds
 * eight and a per-definition notice would spend it. One AGGREGATED notice costs
 * one slot however many definitions declare isolation, which is what makes the
 * lift affordable.
 */
function surfaced(definitions: readonly PiRuntimeAgentDefinitionDescriptor[]): Array<{ message?: string; level?: string; type: string }> {
  const agent = new CodexAgent(createConfig(definitions));
  const events: Array<{ message?: string; level?: string; type: string }> = [];
  const internals = agent as unknown as {
    debug: (message: string) => void;
    turnSink: { push: (e: { type: string; message?: string; level?: string }) => void } | null;
    reportDroppedCodexAgentIsolation: () => void;
  };
  internals.debug = () => { /* the detail channel is asserted above */ };
  internals.turnSink = { push: e => events.push(e) };
  internals.reportDroppedCodexAgentIsolation();
  return events;
}

describe('P3.337 · the dropped isolation reaches a user, once', () => {
  /**
   * KILLS the shipped state: the report existing on `debug` alone. Also kills a
   * naive per-definition lift, by asserting the COUNT is one for three.
   */
  it('surfaces ONE notice naming every definition, not one per definition', () => {
    const events = surfaced([
      definition('scout', 'worktree'),
      definition('planner'),
      definition('worker', 'worktree'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('info');
    // Durable + warning is the one family `SessionManager` persists.
    expect(events[0]!.level).toBe('warning');
    expect(events[0]!.message).toContain('scout');
    expect(events[0]!.message).toContain('worker');
    expect(events[0]!.message).not.toContain('planner');
    // The prefix `CodexAgent` matches its config-writer siblings on.
    expect(events[0]!.message!.startsWith('codex-agent-roles-dropped:')).toBe(true);
  });

  /**
   * NEGATIVE CONTROL on the same rig: a session where nothing asked for
   * isolation spends none of the eight slots.
   */
  it('surfaces nothing when no definition asked for isolation', () => {
    expect(surfaced([definition('planner'), definition('reviewer')])).toEqual([]);
    expect(surfaced([])).toEqual([]);
  });

  it('names what happens instead, so the difference is actionable', () => {
    const [event] = surfaced([definition('scout', 'worktree')]);
    expect(event!.message).toContain("this session's own working directory");
    expect(event!.message).toContain('Pi runtime');
  });
});

describe('P3.301 · the runtime build calls it', () => {
  it('reports before the config is written', () => {
    const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    const call = source.indexOf('this.reportDroppedCodexAgentIsolation();');
    const write = source.indexOf('writeCodexConfig({');
    expect(call).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(call);
  });
});
