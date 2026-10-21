/**
 * F1.537 — `spawn_session` takes ONE decision whichever spelling reaches the gate.
 *
 * F1.74's spelling rule (a session tool is judged under one name, Pi's bare
 * `spawn_session` and claude's wire `mcp__session__spawn_session` alike) had one
 * seam left: `runPreToolUseChecks`' step 4 intercepted the WIRE spelling only and
 * answered `spawn_session_intercept`, which both runtimes turn into a plain allow
 * (`claude-agent.ts`: "Claude's session tools run in-process via SDK — just
 * allow"; upstream craft-agents-oss carries the same line). So claude spawned a
 * session with no card in `default`, `acceptEdits` and `auto`, while Pi's
 * bare spelling carded (F1.478's control pins it in `default`; F1.526 carried it
 * to `acceptEdits` and `auto`). (`dontAsk` was already uniform: both refused.)
 *
 * The controller's rule (DECIDED 2026-09-24): read step 4's reason first — unify
 * on it if it is a real host-side approval, otherwise on the card. It is not an
 * approval: the interception routes, and the handler the call reaches
 * (`SessionManager`'s `onSpawnSession`) creates the session with the
 * MODEL-SUPPLIED `permissionMode` (`request.permissionMode ?? managed.permissionMode`,
 * the schema admits `bypassPermissions`), checking only the root/sudo refusal and
 * the managed disabled-mode clamp. So a `default` claude session could start a
 * `bypassPermissions` session with nobody asked. The decision is the card.
 *
 * Driven through `runPreToolUseChecks`, the gate both prompting runtimes run; the
 * Pi spelling's verdicts are the reference (it already took the card), and every
 * row asserts the two spellings agree.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  promptIsNonNegotiable,
  runPreToolUseChecks,
  type PermissionManagerLike,
  type PreToolUseCheckResult,
} from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';
import type { PermissionMode } from '../mode-types.ts';

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

const keys: Array<{ workspaceId: string; sessionId: string }> = [];
afterAll(() => { for (const key of keys) cleanupModeState(key); });

function check(toolName: string, input: Record<string, unknown>, mode: PermissionMode): PreToolUseCheckResult {
  const sessionKey = { workspaceId: 'ws-f1537', sessionId: `f1537-${keys.length}` };
  keys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, mode);
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: mode,
    workspaceRootPath: '/fixture/f1537-workspace',
    workspaceId: 'ws-f1537',
    workingDirectory: '/fixture/f1537-project',
    plansFolderPath: '/fixture/f1537-sessions/s1/plans',
    dataFolderPath: '/fixture/f1537-sessions/s1/data',
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    interactive: true,
    permissionManager,
  });
}

/** `card` = an ordinary negotiable prompt (in `auto`: the classifier band). */
function verdict(result: PreToolUseCheckResult): string {
  if (result.type !== 'prompt') return result.type;
  return promptIsNonNegotiable(result) ? `floor:${result.nonNegotiable}` : `card:${result.promptType}`;
}

/**
 * What the RUNTIME does with a verdict. Until F1.548 both runtimes turned a
 * `spawn_session_intercept` into a plain allow; F1.537 removed its producer and
 * F1.548 the variant, so the verdict IS the effect.
 */
function effect(result: PreToolUseCheckResult): string {
  return verdict(result);
}

// The escalation shape the row is about: the model names the child's mode.
const SPAWN = { prompt: 'refactor the parser', permissionMode: 'bypassPermissions' };

describe('F1.537 — the wire spelling takes the card the bare spelling takes', () => {
  for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
    it(`${mode}: both spellings card (never an intercept that allows)`, () => {
      const bare = verdict(check('spawn_session', SPAWN, mode));
      const wire = verdict(check('mcp__session__spawn_session', SPAWN, mode));
      expect({ mode, bare, wire }).toEqual({ mode, bare: 'card:mcp_mutation', wire: 'card:mcp_mutation' });
    });
  }
});

describe('F1.537 — CONTROLS: the modes that never carded agree as before', () => {
  it('bypassPermissions: both spellings run', () => {
    expect({
      bare: effect(check('spawn_session', SPAWN, 'bypassPermissions')),
      wire: effect(check('mcp__session__spawn_session', SPAWN, 'bypassPermissions')),
    }).toEqual({ bare: 'allow', wire: 'allow' });
  });

  it('dontAsk: both spellings are refused, neither runs', () => {
    const bare = check('spawn_session', SPAWN, 'dontAsk');
    const wire = check('mcp__session__spawn_session', SPAWN, 'dontAsk');
    expect({ bare: bare.type, wire: wire.type }).toEqual({ bare: 'block', wire: 'block' });
  });

  for (const mode of ['plan'] as const) {
    it(`${mode}: both spellings are blocked by the read-only mode`, () => {
      expect({
        bare: verdict(check('spawn_session', SPAWN, mode)),
        wire: verdict(check('mcp__session__spawn_session', SPAWN, mode)),
      }).toEqual({ bare: 'block', wire: 'block' });
    });
  }

  it('call_llm keeps its step-4 interception (read-only plumbing, not a session mutation)', () => {
    expect(check('mcp__session__call_llm', { prompt: 'x' }, 'default').type).toBe('call_llm_intercept');
  });
});
