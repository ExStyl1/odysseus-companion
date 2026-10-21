/**
 * S8 Task 3 — the `type: "agent"` hook at import.
 *
 * hooks.md § Prompt and agent hook fields lists exactly two fields for prompt
 * AND agent hooks: `prompt` (required) and `model`. § Agent hook configuration
 * repeats it — "Set `type` to `"agent"` and provide a `prompt` string". There is
 * no `agent` or `agentName` key in the format.
 *
 * Nessy demanded one, so the reference's own example hook —
 * `{"type":"agent","prompt":"Verify that all unit tests pass...","timeout":120}`
 * — was dropped at import with "Claude agent hook requires an agent name", a
 * diagnostic naming a key its author could not add.
 *
 * The outcome chosen here is the plan's second option: accept the documented
 * shape and record it as an explained deferral. hooks.md § Agent-based hooks
 * says the type exists for verification that needs "actual files or test
 * output, not just evaluating the hook input data alone" — so degrading it onto
 * the single-turn prompt-hook judge would produce confident verdicts from
 * exactly the input the page says is insufficient.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import type { PluginOrigin } from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-agent-hook-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function origin(): PluginOrigin {
  return { source: 'local-path', localPath: tempDir, resolvedAt: 1 };
}

function bundleWithHooks(id: string, hooks: Record<string, unknown>): string {
  const bundle = join(tempDir, id);
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(bundle, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: id, version: '1.0.0' }),
  );
  mkdirSync(join(bundle, 'hooks'), { recursive: true });
  writeFileSync(join(bundle, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
  return bundle;
}

describe('Claude agent hooks at import', () => {
  it('imports the reference example as a recorded deferral, not a failure', async () => {
    // hooks.md § Agent hook configuration, verbatim shape.
    const bundle = bundleWithHooks('agent-verifier', {
      Stop: [{
        hooks: [{
          type: 'agent',
          prompt: 'Verify that all unit tests pass. Run the test suite and check the results. $ARGUMENTS',
          timeout: 120,
        }],
      }],
    });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    // Not an executable capability: nothing would run it correctly.
    expect(normalized.value?.capabilities ?? []).toEqual([]);
    // But the author is told which hook, on which event, and why.
    expect(normalized.compatibility?.deferred).toEqual([{
      externalKind: 'hook-type-agent-on-Stop',
      reasonCode: 'plugin.deferred.claude_hook_type_agent_experimental',
    }]);
    // The old failure mode: a diagnostic demanding a field the format has no key for.
    expect(normalized.diagnostics).toEqual([]);
  });

  it('records one deferral per event, not one per hook', async () => {
    const bundle = bundleWithHooks('agent-many', {
      Stop: [
        { hooks: [{ type: 'agent', prompt: 'first check $ARGUMENTS' }] },
        { hooks: [{ type: 'agent', prompt: 'second check $ARGUMENTS' }] },
      ],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'agent', prompt: 'third check $ARGUMENTS' }] }],
    });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.compatibility?.deferred).toEqual([
      { externalKind: 'hook-type-agent-on-Stop', reasonCode: 'plugin.deferred.claude_hook_type_agent_experimental' },
      { externalKind: 'hook-type-agent-on-PreToolUse', reasonCode: 'plugin.deferred.claude_hook_type_agent_experimental' },
    ]);
  });

  it('does not read the hook id as an agent name', async () => {
    // `name` is the hook's ID (`id ?? name ?? defaultId`). Reading it as an agent
    // reference turned a self-naming agent hook into a request to spawn a
    // subagent called "verify-tests".
    const bundle = bundleWithHooks('agent-named', {
      Stop: [{ hooks: [{ type: 'agent', name: 'verify-tests', prompt: 'Verify the suite. $ARGUMENTS' }] }],
    });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities ?? []).toEqual([]);
    expect(normalized.compatibility?.deferred).toEqual([{
      externalKind: 'hook-type-agent-on-Stop',
      reasonCode: 'plugin.deferred.claude_hook_type_agent_experimental',
    }]);
  });

  it('still imports Nessy\'s own agent-name flavor', async () => {
    // `agent`/`agentName` is a Nessy extension (native manifests and the Codex
    // adapter both speak it) onto the existing observational subagent runner.
    // It is not in hooks.md, so it can only appear in a bundle written FOR
    // Nessy — and those keep working.
    const bundle = bundleWithHooks('agent-nessy', {
      Stop: [{ hooks: [{ type: 'agent', agent: 'reviewer' }] }],
    });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities ?? []).toMatchObject([
      { kind: 'hook', hook: { event: 'Stop', type: 'agent', agentName: 'reviewer' } },
    ]);
    expect(normalized.compatibility?.deferred ?? []).toEqual([]);
  });

  it('keeps the event-level refusal on SessionStart', async () => {
    // hooks.md § Prompt-based hooks: "`SessionStart` and `Setup` support
    // `command` and `mcp_tool` hooks. They don't support `http`, `prompt`, or
    // `agent` hooks." That refusal is about the EVENT and outranks this one.
    //
    // Only `SessionStart` is exercised: R73 · f001 defers `Setup` at the event
    // name itself, so no hook of any type reaches the type check
    // (`format-adapters.test.ts` pins that).
    const bundle = bundleWithHooks('agent-on-sessionstart', {
      SessionStart: [{ hooks: [{ type: 'agent', prompt: 'inspect the repo $ARGUMENTS' }] }],
    });

    const normalized = await normalizeClaudePluginBundle(bundle, origin());

    expect(normalized.compatibility?.deferred).toEqual([{
      externalKind: 'hook-type-agent-on-SessionStart',
      reasonCode: 'plugin.deferred.claude_hook_type_unsupported_event',
    }]);
  });
});
