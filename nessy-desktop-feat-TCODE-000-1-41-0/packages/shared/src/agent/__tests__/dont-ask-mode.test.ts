/**
 * `dontAsk` — the deterministic fail-closed mode for an unattended session.
 *
 * Documented contract (the permission-mode table at
 * https://code.claude.com/docs/en/agent-sdk/agent-loop.md): "Never prompts. Tools
 * pre-approved by permission rules run; everything else is denied.
 * `AskUserQuestion`, connector tools your organization set to `ask`, and MCP tools
 * marked `requiresUserInteraction` are denied even if you've allowed them."
 *
 * Before this mode existed, `ask` blocked waiting for a human who was not there
 * and every mode above it permitted.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsConfigCache } from '../permissions-config.ts';
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState, shouldAllowToolInMode } from '../mode-manager.ts';
import { PERMISSION_MODE_ORDER } from '../mode-types.ts';

const INTERACTION_TOOL = 'mcp__srv__grant_access';

const tempWorkspaces: string[] = [];
const sessionKeys: Array<{ workspaceId: string; sessionId: string }> = [];

function workspaceWithPermissions(config: Record<string, unknown>): string {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-dont-ask-'));
  writeFileSync(join(workspaceRootPath, 'permissions.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  tempWorkspaces.push(workspaceRootPath);
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
  return workspaceRootPath;
}

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

afterEach(() => {
  permissionsConfigCache.clear();
  for (const workspaceRootPath of tempWorkspaces.splice(0)) {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const key of sessionKeys) cleanupModeState(key);
});

function check(
  toolName: string,
  input: Record<string, unknown>,
  overrides: Partial<PreToolUseInput> = {},
) {
  const sessionKey = { workspaceId: 'ws-dont-ask', sessionId: `session-${toolName}-${sessionKeys.length}` };
  sessionKeys.push(sessionKey);
  cleanupModeState(sessionKey);
  initializeModeState(sessionKey, 'dontAsk');
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId: sessionKey.sessionId,
    sessionKey,
    permissionMode: 'dontAsk',
    workspaceRootPath: '/fixture/workspace',
    workspaceId: 'ws-dont-ask',
    workingDirectory: '/fixture/project',
    activeSourceSlugs: ['srv'],
    allSourceSlugs: ['srv'],
    hasSourceActivation: false,
    permissionManager,
    ...overrides,
  });
}

describe('dontAsk mode', () => {
  it('runs pre-approved tools and denies everything else without prompting', () => {
    expect(check('Read', { file_path: '/fixture/project/a.ts' }).type).toBe('allow');

    const write = check('Write', { file_path: '/fixture/project/a.ts', content: 'x' });
    // Denied, never prompted: a prompt in this mode would hang forever.
    expect(write.type).toBe('block');
  });

  it('honours a permission rule that pre-approves a tool', () => {
    const workspaceRootPath = workspaceWithPermissions({
      toolRules: [{ pattern: 'Write', action: 'allow' }],
    });
    expect(check('Write', { file_path: '/fixture/project/a.ts', content: 'x' }, {
      workspaceRootPath,
    }).type).toBe('allow');
  });

  it('denies rather than prompts when a rule says ask', () => {
    // "Never prompts" outranks a rule that asks — there is nobody to ask.
    const workspaceRootPath = workspaceWithPermissions({
      toolRules: [{ pattern: 'Bash', action: 'ask' }],
    });
    const result = shouldAllowToolInMode('Bash', { command: 'npm install left-pad' }, 'dontAsk', {
      permissionsContext: { workspaceRootPath },
    });
    expect(result.allowed).toBe(false);
  });

  it('denies WebFetch and the browser tool — permission-required, and nobody can answer', () => {
    // tools-reference.md marks WebFetch permission-required, so it does NOT
    // belong to dontAsk's auto-run set (allow rules, the read-only set, hook
    // allows). WebSearch left this list with F1.1049 (the two cases below).
    for (const toolName of ['WebFetch', 'browser_tool']) {
      const result = shouldAllowToolInMode(toolName, { url: 'https://example.com' }, 'dontAsk', {
        permissionsContext: { workspaceRootPath: '/fixture/workspace' },
      });
      expect(result.allowed, toolName).toBe(false);
    }
    // The same tools keep their read-only-set membership outside dontAsk.
    expect(shouldAllowToolInMode('WebFetch', { url: 'https://example.com' }, 'plan', {
      permissionsContext: { workspaceRootPath: '/fixture/workspace' },
    }).allowed).toBe(true);
  });

  it('an allow rule re-admits WebFetch in dontAsk — rules are one of the three sources', () => {
    const workspaceRootPath = workspaceWithPermissions({
      toolRules: [{ pattern: 'WebFetch', action: 'allow' }],
    });
    expect(shouldAllowToolInMode('WebFetch', { url: 'https://example.com' }, 'dontAsk', {
      permissionsContext: { workspaceRootPath },
    }).allowed).toBe(true);
  });

  it('F1.1049 — runs WebSearch unasked: web search is pre-approved by default (owner 2026-09-28)', () => {
    expect(shouldAllowToolInMode('WebSearch', { query: 'q' }, 'dontAsk', {
      permissionsContext: { workspaceRootPath: '/fixture/workspace' },
    }).allowed).toBe(true);
    // The whole gate, as claude's PreToolUse hook asks it: an allow, never a card.
    expect(check('WebSearch', { query: 'q' }).type).toBe('allow');
  });

  it('F1.1049 — a user deny rule on WebSearch still refuses it', () => {
    const workspaceRootPath = workspaceWithPermissions({
      toolRules: [{ pattern: 'WebSearch', action: 'deny' }],
    });
    expect(check('WebSearch', { query: 'q' }, { workspaceRootPath }).type).toBe('block');
  });

  it('denies an interaction-requiring tool even when a rule allows it', () => {
    const workspaceRootPath = workspaceWithPermissions({
      toolRules: [{ pattern: 'mcp__srv__*', action: 'allow' }],
    });
    const result = check(INTERACTION_TOOL, {}, {
      workspaceRootPath,
      interactionRequiredToolNames: [INTERACTION_TOOL],
    });
    expect(result.type).toBe('block');
  });

  it('is the strictest entry in the order table', () => {
    // PERMISSION_MODE_ORDER is used to clamp a child to the stricter of its own and
    // its parent's mode, so the index is a security decision, not cosmetics.
    //
    // `dontAsk` permits strictly LESS than every other mode: the calls that can
    // execute are the rule-allowed set plus the built-in read-only allowlist, and
    // that set is a subset of `explore`'s (which adds scoped plans/data/additional
    // -directory writes) and of `default`'s (where a human can approve anything).
    // Index 0 is also the only position at which the clamp cannot widen: a
    // `dontAsk` parent must never resolve a child to a mode that can prompt.
    expect(PERMISSION_MODE_ORDER.indexOf('dontAsk')).toBe(0);
    for (const mode of ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      expect(PERMISSION_MODE_ORDER.indexOf('dontAsk')).toBeLessThan(PERMISSION_MODE_ORDER.indexOf(mode));
    }
  });
});
