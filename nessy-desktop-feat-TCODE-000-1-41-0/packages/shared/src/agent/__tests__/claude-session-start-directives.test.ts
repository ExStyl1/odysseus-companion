/**
 * C4.12 (G17-claude) — the session band of a hook decision reaches the host on
 * the CLAUDE backend too.
 *
 * R64 built the parse, the per-event surface and the `source` gate for
 * `sessionTitle`, `reloadSkills`, `initialUserMessage` and `watchPaths`, and
 * `hook-session-directives.test.ts` drives them end to end — on Pi. On claude
 * the same decision was produced in this process and reached nobody: hooks run
 * inside the SDK child through `buildSdkHooks()`, the four fields are
 * deliberately dropped on the way to the SDK (R64 — the SDK would rename its own
 * record and re-scan its own skill directories), and `claude-agent.ts` called
 * `applyHookSessionDirectives` zero times. A hook author saw a directive vanish,
 * which is indistinguishable from a hook that never ran.
 *
 * So the missing piece was a CONSUMER, and this suite is about the seam that
 * hands the band over: the same producer, the same decision object the three
 * other backends read, before the SDK translation discards it.
 *
 * The negative arms are what make it mean anything: with no sink registered the
 * behaviour is byte-for-byte the old one, and the SDK result still carries none
 * of the four fields — the drop R64 decided on is not being undone.
 *
 * TRAP inherited from the Pi suite's header, and it still bites: a hook command
 * is JSON-escaped into the config, so a multi-line script arrives at the shell
 * with a literal backslash-n and the hook exits non-zero deciding nothing —
 * which reads exactly like a dropped field. Every command below is ONE line.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHookCommand } from '../../automations/hook-command.ts';
import {
  PluginScopedAutomationSystem,
  supportsSessionDirectiveSink,
} from '../../plugins/hooks-automation.ts';
import type { PreToolUseDecision, SdkAutomationInput } from '../../automations/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-session-start-directives-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function systemWithSessionStartHook(command: string): PluginScopedAutomationSystem {
  return new PluginScopedAutomationSystem({
    userGlobalHookConfig: { automations: { SessionStart: [{ actions: [{ type: 'command', command }] }] } } as never,
    pluginHookConfig: { automations: {} },
    workspaceRootPath: tempDir,
    workingDir: tempDir,
    pluginCommandRunner: runHookCommand,
  });
}

/** Dispatch the SessionStart matchers exactly as the SDK child does. */
async function dispatchSessionStart(
  system: PluginScopedAutomationSystem,
  source: string,
): Promise<unknown[]> {
  const hooks = system.buildSdkHooks();
  const matchers = hooks.SessionStart ?? [];
  expect(matchers.length, 'no SessionStart matcher was registered').toBeGreaterThan(0);
  const input = {
    hook_event_name: 'SessionStart',
    session_id: 'session-c4-12',
    source,
  } as unknown as SdkAutomationInput;
  const results: unknown[] = [];
  for (const matcher of matchers) {
    for (const callback of matcher.hooks) {
      results.push(await callback(input, undefined as never, {} as never));
    }
  }
  return results;
}

const QUARTET = `echo '{"hookSpecificOutput":{"hookEventName":"SessionStart","sessionTitle":"auth-refactor","reloadSkills":true}}'`;

describe('C4.12 — the claude backend has a consumer for the SessionStart band', () => {
  it('hands the decision to a registered sink, and still keeps it off the SDK wire', async () => {
    const system = systemWithSessionStartHook(QUARTET);
    const seen: PreToolUseDecision[] = [];
    expect(supportsSessionDirectiveSink(system)).toBe(true);
    system.setSessionDirectiveSink(decision => { seen.push(decision); });

    const results = await dispatchSessionStart(system, 'startup');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionTitle).toBe('auth-refactor');
    expect(seen[0]?.reloadSkills).toBe(true);

    // R64 is NOT being undone: the SDK would apply these to its own session, so
    // they stay off its wire. Both halves in one case, because "the host got it"
    // and "the SDK did not" are the two things this seam has to be true at once.
    const wire = JSON.stringify(results);
    expect(wire).not.toContain('auth-refactor');
    expect(wire).not.toContain('reloadSkills');
  });

  it('delivers nothing when no sink is registered — the control', async () => {
    // Without this, a seam that delivered unconditionally (or a test that read a
    // sink it never registered) would satisfy the case above. The old behaviour
    // has to be exactly what an unregistered host still gets.
    const system = systemWithSessionStartHook(QUARTET);
    const results = await dispatchSessionStart(system, 'startup');
    expect(JSON.stringify(results)).not.toContain('auth-refactor');

    // And registering after the build still works: `buildSdkHooks()` reads the
    // sink LIVE at dispatch rather than capturing it, which is what lets the
    // backend register around the moment the query options are assembled.
    const seen: PreToolUseDecision[] = [];
    system.setSessionDirectiveSink(decision => { seen.push(decision); });
    await dispatchSessionStart(system, 'startup');
    expect(seen.map(decision => decision.sessionTitle)).toEqual(['auth-refactor']);
  });

  it('does not re-derive the source gate — a compact start delivers no title', async () => {
    // hooks.md: `sessionTitle` "Applies when `source` is "startup", "resume", or
    // "fork"; ignored on "clear" and "compact"". The gate belongs to the
    // executor, which applies it "before any consumer can read the field", and
    // `applyHookSessionDirectives` documents that as its precondition. This case
    // is the proof that the seam INHERITS it rather than adding a second copy —
    // two answers to one question is how the two drift apart.
    const system = systemWithSessionStartHook(QUARTET);
    const seen: PreToolUseDecision[] = [];
    system.setSessionDirectiveSink(decision => { seen.push(decision); });

    await dispatchSessionStart(system, 'compact');

    // `reloadSkills` is NOT gated by source and still arrives — which is what
    // makes this a gate test rather than a "nothing was delivered" test.
    expect(seen.map(decision => decision.sessionTitle)).toEqual([undefined]);
    expect(seen.map(decision => decision.reloadSkills)).toEqual([true]);
  });

  it('refuses a host that cannot take a sink — the guard, both directions', () => {
    expect(supportsSessionDirectiveSink(undefined)).toBe(false);
    expect(supportsSessionDirectiveSink({})).toBe(false);
    expect(supportsSessionDirectiveSink({ setSessionDirectiveSink: 'not a function' })).toBe(false);
  });

  /**
   * The registration itself, pinned on the source.
   *
   * Constructing a `ClaudeAgent` to observe it would spawn the SDK child; the
   * seam above is the behaviour and this is the wiring, which is the shape
   * `claude-scheduling-projection.test.ts` already pins the same way. It is a
   * substring of a CALL, never a bare identifier: a guard on the name alone goes
   * red on the commit whose comment explains the name (AGENTS.md §Traps).
   */
  it('is registered by the claude backend where the query options are assembled', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../claude-agent.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('supportsSessionDirectiveSink(this.automationSystem)');
    expect(source).toMatch(/setSessionDirectiveSink\(\s*decision => this\.applyHookSessionDirectives\(decision\),?\s*\)/);
    // The control for the read itself: a string this file would find in any
    // claude backend, and one it must not find at all.
    expect(source).toContain('buildSdkHooks');
    expect(source).not.toContain('nessyNotARealClaudeAgentSymbol');
  });
});
