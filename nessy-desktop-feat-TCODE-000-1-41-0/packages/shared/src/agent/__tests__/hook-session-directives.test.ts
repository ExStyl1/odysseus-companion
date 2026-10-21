/**
 * R64 · f010/f216 consumers — the `SessionStart`/`UserPromptSubmit` session
 * directives reaching a host.
 *
 * The contract layer already parsed `sessionTitle`, `reloadSkills`,
 * `initialUserMessage` and `watchPaths`, gated them per event and carried them
 * through the merge. Nothing consumed them, so the whole band was a parse with
 * no effect. These drive REAL spawned hooks through a REAL PiAgent turn and
 * assert what the host is handed — asserting the parser again would prove the
 * half that already worked.
 *
 * hooks.md:1060 — `sessionTitle` "Sets the session title, with the same effect
 * as `/rename`".
 * hooks.md:1062 — `reloadSkills` re-scans "the skill and command directories
 * after the SessionStart hooks complete, so skills the hook installed are
 * available in the same session, starting with the first prompt".
 * hooks.md:1266 — `UserPromptSubmit` documents `sessionTitle` too.
 *
 * TRAP, paid for once already: a hook command is JSON-escaped into the config,
 * so a multi-line script arrives at the shell with a literal `\n` and the hook
 * exits non-zero deciding nothing — which reads exactly like a dropped field.
 * Every command below is ONE line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHookCommand } from '../../automations/hook-command.ts';
import { PluginScopedAutomationSystem } from '../../plugins/hooks-automation.ts';
import { PiAgent } from '../pi-agent.ts';
import type { AgentLifecycleState, BackendConfig } from '../backend/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'hook-session-directives-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function config(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-session-directives',
      name: 'Test Workspace',
      rootPath: tempDir,
      workspaceRootPath: tempDir,
      sessionRootPath: join(tempDir, 'sessions'),
    },
    session: {
      id: 'session-directives',
      workspaceRootPath: tempDir,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: tempDir,
    },
    model: 'pi/test-model',
    isHeadless: true,
  } as unknown as BackendConfig;
}

/** The system a Pi session actually runs (see `hook-stdout-context.test.ts`). */
function piSystemWithHooks(hooks: Record<string, unknown>): PluginScopedAutomationSystem {
  return new PluginScopedAutomationSystem({
    userGlobalHookConfig: { automations: hooks } as never,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: tempDir,
    workingDir: tempDir,
    pluginCommandRunner: runHookCommand,
  });
}

interface TurnRig {
  agent: PiAgent;
  titles: string[];
  order: string[];
  run: (text: string) => Promise<void>;
}

/**
 * One PiAgent turn with the subprocess and the capability manifest stubbed —
 * everything from the spawned hook to the host callback is the real path.
 */
function rig(system: PluginScopedAutomationSystem): TurnRig {
  const agent = new PiAgent(config());
  agent.setAutomationSystem(system);
  const titles: string[] = [];
  const order: string[] = [];
  agent.onSessionTitle = title => { titles.push(title); order.push('title'); };
  agent.onReloadSkills = () => { order.push('reload-skills'); };
  const internals = agent as unknown as Record<string, unknown>;
  internals.ensureSubprocess = async () => undefined;
  internals.syncExecutionManifestForCurrentTurn = async () => {
    order.push('manifest');
    return {
      snapshotGeneration: 'generation-1',
      manifestHash: 'manifest-1',
      tools: [],
      deferredMcp: { candidatePiNames: [] },
    };
  };
  internals.send = (message: Record<string, unknown>) => {
    if (message.type !== 'prompt') return;
    (internals.eventQueue as { complete: () => void }).complete();
  };
  return {
    agent,
    titles,
    order,
    run: async (text: string) => {
      for await (const _ of (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<unknown> }).chatImpl(text)) {
        /* drain */
      }
    },
  };
}

describe('hook session directives reach the host', () => {
  it('renames the session from a SessionStart hook and rescans before the manifest', async () => {
    // The doc's own example object, plus the `reloadSkills` its team-skills
    // recipe returns. One line — see the trap in this file's header.
    const system = piSystemWithHooks({
      SessionStart: [{
        actions: [{
          type: 'command',
          command: `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","sessionTitle":"auth-refactor","reloadSkills":true}}'`,
        }],
      }],
    });
    const turn = rig(system);

    await turn.run('hello');

    expect(turn.titles).toEqual(['auth-refactor']);
    // "available in the same session, starting with the first prompt": the
    // rescan has to precede the manifest this turn is built from, or the skill
    // the hook installed is absent for exactly the turn that asked for it.
    expect(turn.order.indexOf('reload-skills')).toBeGreaterThanOrEqual(0);
    expect(turn.order.indexOf('reload-skills')).toBeLessThan(turn.order.indexOf('manifest'));

    turn.agent.destroy();
  });

  it('renames the session from a UserPromptSubmit hook', async () => {
    // hooks.md:1266 — "Use to name sessions automatically based on the prompt
    // content". Same field, a different event, a different executor path.
    const system = piSystemWithHooks({
      UserPromptSubmit: [{
        actions: [{
          type: 'command',
          command: `echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"ship-the-release"}}'`,
        }],
      }],
    });
    const turn = rig(system);

    await turn.run('ship it');

    expect(turn.titles).toEqual(['ship-the-release']);

    turn.agent.destroy();
  });

  it('does not rename when the same hook blocks the prompt', async () => {
    // A block "prevents the prompt from being processed and erases it from
    // context" (hooks.md:1263) — an erased prompt names nothing. The negative
    // half of the event above: same field, same event, no rename.
    const system = piSystemWithHooks({
      UserPromptSubmit: [{
        actions: [{
          type: 'command',
          command: `echo '{"decision":"block","reason":"not now","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"never-applied"}}'`,
        }],
      }],
    });
    const turn = rig(system);

    await turn.run('ship it');

    expect(turn.titles).toEqual([]);

    turn.agent.destroy();
  });

  it('holds a title parsed before the host wired a callback, and delivers it across a recreate', async () => {
    // `sessionStartHooksApplied` travels with the lifecycle state, so the
    // recreated agent never re-runs the hook: a title dropped because the
    // callback was not wired yet is dropped for the whole session.
    const system = piSystemWithHooks({
      SessionStart: [{
        actions: [{
          type: 'command',
          command: `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","sessionTitle":"carried-over"}}'`,
        }],
      }],
    });
    const turn = rig(system);
    turn.agent.onSessionTitle = null;

    await turn.run('hello');

    const captured: AgentLifecycleState = turn.agent.captureLifecycleState();
    expect(captured.pendingHookSessionTitle).toBe('carried-over');
    turn.agent.destroy();

    const revived = new PiAgent(config());
    const delivered: string[] = [];
    revived.restoreLifecycleState(captured);
    revived.onSessionTitle = title => { delivered.push(title); };
    await Promise.resolve();
    expect(delivered).toEqual(['carried-over']);

    revived.destroy();
  });

  it('carries initialUserMessage and watchPaths without acting on either', async () => {
    // Both are parsed and deliberately inert. `initialUserMessage` "Applies in
    // non-interactive mode with the `-p` flag" (hooks.md:1059) and CREATES the
    // first turn — every Nessy surface runs SessionStart from inside a turn a
    // typed prompt already opened. `watchPaths` needs a disk watcher that does
    // not exist (`2026-07-29-inert-unit-b.md:329-331`). This pins that they are
    // carried rather than lost, so the day either subsystem lands the value is
    // already there.
    const system = piSystemWithHooks({
      SessionStart: [{
        actions: [{
          type: 'command',
          command: `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","initialUserMessage":"review the diff","watchPaths":["${join(tempDir, 'watched.ts')}"]}}'`,
        }],
      }],
    });
    const turn = rig(system);

    await turn.run('hello');

    const carried = turn.agent.getCarriedHookSessionDirectives();
    expect(carried.initialUserMessage).toBe('review the diff');
    expect(carried.watchPaths).toEqual([join(tempDir, 'watched.ts')]);
    expect(turn.titles).toEqual([]);

    turn.agent.destroy();
  });
});
