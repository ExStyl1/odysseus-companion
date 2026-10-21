/**
 * F1.862 (origin SIT-ae / SIT-ai / SIT-am, 2026-09-25) — on claude-runtime a trusted project's `.claude/skills` skill
 * (and a parent folder's, F1.844) is LOADED by the child (`Loaded 1 unique skills (… project: 1 …)`) and was
 * unreachable: `Skill` was in `CLAUDE_SESSION_DISALLOWED_TOOLS`, the host catalogue reads only the `.agents/skills`
 * tiers, and the model found the skill only by reading its SKILL.md with Bash.
 *
 * Decided (owner rule 2026-10-08, runtime-native): Claude's own `Skill` tool is allowed, so the skills Claude Code
 * loads itself (user, trusted project, parent folders) are invoked the way Claude Code invokes them. The host gate's
 * old step 5d rewrote every `Skill` input to `<plugin>:<slug>` — a plugin-qualified name for the plugin tiers
 * upstream delivered through the SDK's `plugins` option. This fork passes `plugins: []`, so every qualified name
 * resolved nowhere; the gate now leaves the name the model chose alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_SESSION_DISALLOWED_TOOLS } from '../claude-agent.ts';
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState } from '../mode-manager.ts';

const KEY = { workspaceId: 'ws-native-skill', sessionId: 'session-native-skill' };
let sandbox: string;

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-native-skill-')));
  for (const dir of ['project', 'workspace']) mkdirSync(join(sandbox, dir), { recursive: true });
  cleanupModeState(KEY);
  initializeModeState(KEY, 'bypassPermissions');
});

afterAll(() => {
  cleanupModeState(KEY);
  rmSync(sandbox, { recursive: true, force: true });
});

describe('F1.862 · Claude\'s own Skill tool reaches the skills Claude loads', () => {
  it('Skill is not banned for the session', () => {
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain('Skill');
  });

  it('the host gate leaves the skill name the model chose unchanged', () => {
    const ctx: PreToolUseInput = {
      toolName: 'Skill',
      input: { skill: 'f1845' },
      sessionId: KEY.sessionId,
      sessionKey: KEY,
      permissionMode: 'bypassPermissions',
      workspaceRootPath: join(sandbox, 'workspace'),
      workspaceId: KEY.workspaceId,
      workingDirectory: join(sandbox, 'project'),
      activeSourceSlugs: [],
      allSourceSlugs: [],
      hasSourceActivation: false,
      permissionManager,
    };
    const result = runPreToolUseChecks(ctx);
    expect(result.type).not.toBe('block');
    if (result.type === 'modify') expect(result.input.skill).toBe('f1845');
  });
});
