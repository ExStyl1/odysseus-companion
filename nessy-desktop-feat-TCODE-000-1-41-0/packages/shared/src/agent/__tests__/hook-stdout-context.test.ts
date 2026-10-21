/**
 * S8 Task 1 — the exit-0 stdout context channel.
 *
 * hooks.md § Exit code output: "For most events, stdout is written to the debug
 * log but not shown in the transcript. The exceptions are `UserPromptSubmit`,
 * `UserPromptExpansion`, and `SessionStart`, where stdout is added as context
 * that Claude can see and act on."
 *
 * hooks-guide.md § Re-inject context after compaction states the same rule as
 * the premise of its only context recipe — "Any text your command writes to
 * stdout is added to Claude's context" — and the recipe it ships is a bare
 * `echo`, with no JSON anywhere.
 *
 * These drive the REAL hook runtime (a spawned `echo`, no injected runner stub)
 * and assert the text in the turn PiAgent actually composes. Asserting the
 * parser alone would prove the parser, which was never the thing that was
 * missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookCommandStdoutContext, hookEventStdoutIsContext, runHookCommand } from '../../automations/hook-command.ts';
import { PluginScopedAutomationSystem } from '../../plugins/hooks-automation.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'hook-stdout-context-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function config(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-stdout-context',
      name: 'Test Workspace',
      rootPath: tempDir,
      workspaceRootPath: tempDir,
      sessionRootPath: join(tempDir, 'sessions'),
    },
    session: {
      id: 'session-stdout-context',
      workspaceRootPath: tempDir,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: tempDir,
    },
    model: 'pi/test-model',
    isHeadless: true,
  } as unknown as BackendConfig;
}

/**
 * The system a Pi session actually runs. `SessionManager` builds exactly this
 * (`runtime-automations.ts`): every hook — native `hooks.json` and imported
 * plugin alike — executes through `executePluginHookAutomations` with a host
 * command runner injected. This sentence used to end "`AutomationSystem.executeAgentEvent`
 * is the OTHER path, used by non-Pi backends"; D1.351 measured that false —
 * that method has no production caller on any backend. The other arm below is
 * the same executor under the other execution AUTHORITY.
 */
function piSystemWithHooks(hooks: Record<string, unknown>): PluginScopedAutomationSystem {
  return new PluginScopedAutomationSystem({
    userGlobalHookConfig: { automations: hooks } as never,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: tempDir,
    workingDir: tempDir,
    pluginCommandRunner: runHookCommand,
  });
}

/**
 * The non-Pi path, and D1.354 moved what that MEANS.
 *
 * It used to be `AutomationSystem` over a real `hooks.json`, on the premise
 * named in the docblock above — "the OTHER path, used by non-Pi backends".
 * D1.351 measured that premise false: no production caller reaches that class's
 * `executeAgentEvent`, on any backend. The real difference between the two
 * arms is the EXECUTION AUTHORITY, and both of them are options
 * `buildPinnedAgentAutomationSystem` really passes: the host runner above
 * (Pi's ProcessSupervisor route) and the explicit direct-spawn opt-in here,
 * which is what the non-Pi providers get. Same real `echo`, same assertions.
 */
function systemWithHooks(hooks: Record<string, unknown>): PluginScopedAutomationSystem {
  return new PluginScopedAutomationSystem({
    userGlobalHookConfig: { automations: hooks } as never,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: tempDir,
    workingDir: tempDir,
    allowDirectCommandRunner: true,
  });
}

describe('exit-0 stdout as context', () => {
  it('reaches the turn PiAgent composes when a SessionStart hook only echoes', async () => {
    // hooks-guide.md's re-inject recipe, verbatim in shape: one `echo`, no JSON.
    const system = systemWithHooks({
      SessionStart: [{
        actions: [{ type: 'command', command: "echo 'Reminder: use Bun, not npm.'" }],
      }],
    });
    const agent = new PiAgent(config());
    agent.setAutomationSystem(system);
    const prompts: Array<Record<string, unknown>> = [];
    const internals = agent as unknown as Record<string, unknown>;
    // The subprocess and the capability manifest are the parts of a turn this
    // test is not about; everything from the hook run to the composed prompt is
    // the real code path.
    internals.ensureSubprocess = async () => undefined;
    internals.syncExecutionManifestForCurrentTurn = async () => ({
      snapshotGeneration: 'generation-1',
      manifestHash: 'manifest-1',
      tools: [],
      deferredMcp: { candidatePiNames: [] },
    });
    internals.send = (message: Record<string, unknown>) => {
      if (message.type !== 'prompt') return;
      prompts.push(message);
      (internals.eventQueue as { complete: () => void }).complete();
    };

    for await (const _ of (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<unknown> }).chatImpl('hello')) {
      /* drain */
    }

    expect(prompts).toHaveLength(1);
    const composed = `${String(prompts[0]!.systemPrompt ?? '')}\n${String(prompts[0]!.message ?? '')}`;
    expect(composed).toContain('Reminder: use Bun, not npm.');

    agent.destroy();
  });

  it('injects on all four documented events and on no other', async () => {
    // The closed list, read back from the module rather than restated here.
    // UB12.69: hooks.md § Exit code 0 (curl'd 2026-10-17) names `PostModelSwitch`
    // as the fourth; its sibling `PreModelSwitch` is not one.
    for (const event of ['UserPromptSubmit', 'UserPromptExpansion', 'SessionStart', 'PostModelSwitch'] as const) {
      expect(hookEventStdoutIsContext(event)).toBe(true);
    }
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd', 'PreModelSwitch'] as const) {
      expect(hookEventStdoutIsContext(event)).toBe(false);
    }
  });

  it('UB12.69 — a PostModelSwitch hook that only echoes gives its text as context, on both authorities', async () => {
    // hooks.md#postmodelswitch's own example, minus its matcher: one `echo`, no
    // JSON. The host keeps this `additionalContext` for the next prompt
    // (server-core `post-model-switch-context.test.ts`).
    const guidance = 'On Opus, delegate implementation work to subagents and keep this conversation for planning and review.';
    const hooks = {
      PostModelSwitch: [{ actions: [{ type: 'command', command: `echo '${guidance}'` }] }],
    };
    const input = {
      hook_event_name: 'PostModelSwitch' as const,
      from_model: 'claude-sonnet-5',
      to_model: 'claude-opus-5',
      requested_model: 'claude-opus-5',
      source: 'sdk',
    };
    for (const system of [piSystemWithHooks(hooks), systemWithHooks(hooks)]) {
      const result = await system.executeAgentEvent('PostModelSwitch', input);
      expect(result.matchedCount).toBe(1);
      expect(result.decision?.additionalContext).toBe(guidance);
    }
    // NEGATIVE: the same `echo` on the sibling event the page gives no context
    // channel stays a debug line.
    const pre = await piSystemWithHooks({
      PreModelSwitch: [{ actions: [{ type: 'command', command: `echo '${guidance}'` }] }],
    }).executeAgentEvent('PreModelSwitch', { ...input, hook_event_name: 'PreModelSwitch' as const });
    expect(pre.matchedCount).toBe(1);
    expect(pre.decision?.additionalContext).toBeUndefined();
  });

  it('does not inject for an event outside the documented list, on either path', async () => {
    // Same hook, same `echo`, an event the docs route to the debug log only.
    const hooks = {
      PostToolUse: [{
        actions: [{ type: 'command', command: "echo 'this belongs in the debug log'" }],
      }],
    };
    const input = {
      hook_event_name: 'PostToolUse' as const,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      tool_response: 'hi',
    };

    const piResult = await piSystemWithHooks(hooks).executeAgentEvent('PostToolUse', input);
    expect(piResult.matchedCount).toBe(1);
    expect(piResult.decision?.additionalContext).toBeUndefined();

    const system = systemWithHooks(hooks);
    const legacyResult = await system.executeAgentEvent('PostToolUse', input);
    expect(legacyResult.matchedCount).toBe(1);
    expect(legacyResult.decision?.additionalContext).toBeUndefined();
  });

  it('concatenates the values of several hooks on one event', async () => {
    // hooks.md § Add context for Claude: "When several hooks return
    // `additionalContext` for the same event, Claude receives all of the values."
    const system = piSystemWithHooks({
      UserPromptSubmit: [
        { actions: [{ type: 'command', command: "echo 'branch: release-42'" }] },
        { actions: [{ type: 'command', command: "echo 'deploy freeze until Friday'" }] },
      ],
    });

    const result = await system.executeAgentEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'ship it',
    });

    expect(result.decision?.additionalContext).toBe('branch: release-42\n\ndeploy freeze until Friday');
  });

  it('reads a bare JSON object as a decision, never as context', () => {
    // hooks.md § JSON output: "Your hook's stdout must contain only the JSON
    // object", so a bare object is the decision form even on a context event.
    expect(hookCommandStdoutContext('UserPromptSubmit', {
      success: true,
      stdout: '{"decision":"block","reason":"nope"}',
    })).toBeUndefined();
    // Anything that is not that form is text: an array, a scalar, and an object
    // with prose around it are all things a hook may legitimately echo.
    expect(hookCommandStdoutContext('UserPromptSubmit', {
      success: true,
      stdout: '["a","b"]',
    })).toBe('["a","b"]');
    expect(hookCommandStdoutContext('UserPromptSubmit', {
      success: true,
      stdout: 'Open PRs: {"id":4211}',
    })).toBe('Open PRs: {"id":4211}');
  });

  it('ignores stdout from a non-zero exit', () => {
    // hooks.md: "JSON output is only processed on exit 0" and exit 2 "ignores
    // stdout" — the text channel is gated the same way, or a hook that failed
    // halfway would inject its partial output.
    expect(hookCommandStdoutContext('SessionStart', {
      success: false,
      stdout: 'half-written context',
    })).toBeUndefined();
  });

  it('runs the guide\'s re-inject-after-compaction recipe end to end', async () => {
    // hooks-guide.md § Re-inject context after compaction, verbatim: a
    // `SessionStart` hook, `"matcher": "compact"`, one `echo`, no JSON. Every
    // link is real here — the matcher runs against the emitted `source`, the
    // hook is spawned, its plain stdout becomes context, and the text is read
    // back out of the turn PiAgent composed. This is the recipe the unit exists
    // for, and it needed both halves: the `compact` source AND the stdout
    // channel.
    const system = piSystemWithHooks({
      SessionStart: [{
        matcher: 'compact',
        actions: [{ type: 'command', command: "echo 'Reminder: use Bun, not npm. Current sprint: auth refactor.'" }],
      }],
    });
    const agent = new PiAgent(config());
    agent.setAutomationSystem(system);
    const prompts: Array<Record<string, unknown>> = [];
    const internals = agent as unknown as Record<string, unknown>;
    internals.ensureSubprocess = async () => undefined;
    internals.syncExecutionManifestForCurrentTurn = async () => ({
      snapshotGeneration: 'generation-1',
      manifestHash: 'manifest-1',
      tools: [],
      deferredMcp: { candidatePiNames: [] },
    });
    internals.send = (message: Record<string, unknown>) => {
      if (message.type === 'prompt') {
        prompts.push(message);
        (internals.eventQueue as { complete: () => void }).complete();
        return;
      }
      if (message.type !== 'compact') return;
      queueMicrotask(() => {
        (internals as { handleSubprocessEvent(event: Record<string, unknown>): void })
          .handleSubprocessEvent({ type: 'compaction_end', reason: 'manual', result: { ok: true }, aborted: false });
        (internals as { handleLine(line: string): void }).handleLine(JSON.stringify({
          type: 'compact_result', id: message.id, success: true,
          result: { summary: 'compacted', firstKeptEntryId: 'entry-2', tokensBefore: 120_000 },
        }));
      });
    };
    const run = async (text: string) => {
      for await (const _ of (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<unknown> }).chatImpl(text)) {
        /* drain */
      }
    };

    await run('hello');
    await run('/compact');
    await run('carry on');

    // Turn 1 is before the compaction, so the `compact` matcher did not match it.
    expect(String(prompts[0]!.message)).not.toContain('Current sprint: auth refactor.');
    // Turn 2 (`/compact`) sends no prompt; turn 3 carries the re-injection.
    expect(String(prompts[1]!.message)).toContain('Reminder: use Bun, not npm. Current sprint: auth refactor.');
    expect(String(prompts[1]!.systemPrompt)).not.toContain('Current sprint: auth refactor.');

    agent.destroy();
  });

  it('caps injected text at the documented 10,000 characters', () => {
    // hooks.md § JSON output: "Hook output strings, including
    // `additionalContext`, `systemMessage`, and plain stdout, are capped at
    // 10,000 characters."
    const injected = hookCommandStdoutContext('SessionStart', {
      success: true,
      stdout: 'x'.repeat(20_000),
    });
    expect(injected?.length).toBe(10_000);
  });
});
