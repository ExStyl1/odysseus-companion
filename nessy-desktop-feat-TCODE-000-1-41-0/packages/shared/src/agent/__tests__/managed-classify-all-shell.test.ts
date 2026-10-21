/**
 * `autoMode.classifyAllShell` — the managed band control, at the band.
 *
 * `auto-mode-config.md:224`, whole line:
 *
 *   "By default, narrow Bash and PowerShell allow rules such as `Bash(npm
 *   test)` carry over into auto mode and resolve before the classifier runs.
 *   Auto mode suspends only the broad rules that grant arbitrary code
 *   execution, such as `Bash(*)` or wildcarded interpreters. This means a
 *   narrow rule can still let a destructive argument through without the
 *   classifier seeing it, for example a script path or flag the rule's prefix
 *   didn't anticipate."
 *
 * `auto-mode-config.md:226`, whole line:
 *
 *   "Set `autoMode.classifyAllShell` to `true` to suspend every Bash and
 *   PowerShell allow rule while auto mode is active, so the classifier
 *   evaluates every shell command regardless of your allow list."
 *
 * `settings.md`, the `autoMode.classifyAllShell` row, whole line:
 *
 *   "| `autoMode.classifyAllShell`        | {/* min-version: 2.1.193 *\/}**Default**: `false`. When `true`, suspends every Bash and PowerShell allow rule while auto mode is active so all shell commands route through the classifier, not only rules that match arbitrary-code-execution patterns. See [Route all shell commands through the classifier](/docs/en/auto-mode-config#route-all-shell-commands-through-the-classifier). Requires Claude Code v2.1.193 or later | `true` |"
 *
 * Until this suite the key was parsed, validated, composed and delivered, and
 * `resolveAutoModeClassifyAllShell` had ONLY test callers — the administrator
 * believed the fleet was under the guardian and every allow-matched shell
 * command still ran unclassified.
 *
 * Our single shell tool is `Bash`; "Bash and PowerShell" is one tool name here.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shouldPromptInAutoMode, type PermissionManagerLike } from '../core/pre-tool-use.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { resolveAutoModeClassifyAllShell } from '../pi-harness/managed-policy.ts';

const tempWorkspaces: string[] = [];

/** A workspace whose `permissions.json` carries one narrow Bash ALLOW rule. */
function workspaceAllowing(pattern: string): string {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-classify-all-shell-'));
  writeFileSync(
    join(workspaceRootPath, 'permissions.json'),
    `${JSON.stringify({ allowedBashPatterns: [pattern] }, null, 2)}\n`,
    'utf-8',
  );
  tempWorkspaces.push(workspaceRootPath);
  permissionsConfigCache.invalidateWorkspace(workspaceRootPath);
  return workspaceRootPath;
}

afterEach(() => {
  permissionsConfigCache.clear();
  for (const workspaceRootPath of tempWorkspaces.splice(0)) {
    rmSync(workspaceRootPath, { recursive: true, force: true });
  }
});

const plainManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

/** The session whitelist — a human's "don't ask again", which is an allow rule. */
const rememberingManager: PermissionManagerLike = {
  ...plainManager,
  isCommandWhitelisted: () => true,
};

describe('autoMode.classifyAllShell — the band reads the key', () => {
  it('OFF: a permissions.json Bash allow rule resolves before the classifier (today)', () => {
    const workspaceRootPath = workspaceAllowing('^ls -la$');
    const context = { workspaceRootPath, activeSourceSlugs: [] };

    // The allow rule fires: the command never becomes a prompt, so the
    // guardian — which is only consulted for a `prompt` result — never sees it.
    expect(shouldPromptInAutoMode('Bash', { command: 'ls -la' }, plainManager, context)).toBeNull();
  });

  it('ON: the same allow rule is suspended and the command reaches the band', () => {
    const workspaceRootPath = workspaceAllowing('^ls -la$');
    const context = { workspaceRootPath, activeSourceSlugs: [] };

    const band = shouldPromptInAutoMode(
      'Bash',
      { command: 'ls -la' },
      plainManager,
      context,
      undefined,
      undefined,
      { classifyAllShell: true },
    );

    expect(band?.promptType).toBe('bash');
    expect(band?.command).toBe('ls -la');
    // The prompt must stay NEGOTIABLE: `promptIsNonNegotiable` is the gate the
    // guardian consult checks (8c2990ad), so marking this floor-like would
    // route the command straight past the classifier to a human — the exact
    // opposite of what the key buys.
    expect(band?.shellAllowRulesSuspended).toBe(true);
    // And it is not remember-able: a "don't ask again" would mint a session
    // allow rule that this very key suspends on the next call.
    expect(band?.rememberForMinutes).toBeUndefined();
    expect(band?.commandHash).toBeUndefined();
  });

  it('ON: the session whitelist ("previously approved") is suspended too', () => {
    const workspaceRootPath = workspaceAllowing('^never-matches$');
    const context = { workspaceRootPath, activeSourceSlugs: [] };

    expect(shouldPromptInAutoMode('Bash', { command: 'make build' }, rememberingManager, context)).toBeNull();
    expect(shouldPromptInAutoMode(
      'Bash',
      { command: 'make build' },
      rememberingManager,
      context,
      undefined,
      undefined,
      { classifyAllShell: true },
    )?.promptType).toBe('bash');
  });

  it('ON: the low-risk auto fast path is suspended — "all shell commands route through the classifier"', () => {
    const workspaceRootPath = workspaceAllowing('^never-matches$');
    const context = { workspaceRootPath, activeSourceSlugs: [] };

    // `npm test` is the doc's own example of a narrow allow rule. Auto mode's
    // low-risk filter reaches the same outcome without one.
    expect(shouldPromptInAutoMode('Bash', { command: 'npm test' }, plainManager, context)).toBeNull();
    expect(shouldPromptInAutoMode(
      'Bash',
      { command: 'npm test' },
      plainManager,
      context,
      undefined,
      undefined,
      { classifyAllShell: true },
    )?.promptType).toBe('bash');
  });

  it('OFF is byte-identical to today, and a risky command is unchanged either way', () => {
    const workspaceRootPath = workspaceAllowing('^ls -la$');
    const context = { workspaceRootPath, activeSourceSlugs: [] };
    const risky = { command: 'rm -rf build' };

    const off = shouldPromptInAutoMode('Bash', risky, plainManager, context);
    const explicitlyOff = shouldPromptInAutoMode(
      'Bash', risky, plainManager, context, undefined, undefined, { classifyAllShell: false },
    );
    expect(off).toEqual(explicitlyOff);
    expect(off?.promptType).toBe('bash');
    // Unchanged shape: still remember-able, no suspension marker.
    expect(off?.shellAllowRulesSuspended).toBeUndefined();
    expect(off?.rememberForMinutes).toBeDefined();
  });

  it('the key is a SHELL band control — non-Bash tools are untouched', () => {
    const workspaceRootPath = workspaceAllowing('^never-matches$');
    const context = { workspaceRootPath, activeSourceSlugs: [] };
    const on = { classifyAllShell: true } as const;

    for (const call of [
      { toolName: 'mcp__linear__createIssue', input: { title: 'Bug' } },
      { toolName: 'Write', input: { file_path: `${workspaceRootPath}/a.ts`, content: 'x' } },
      { toolName: 'api_github', input: { method: 'POST', path: '/repos' } },
    ]) {
      const off = shouldPromptInAutoMode(call.toolName, call.input, plainManager, context);
      const withKey = shouldPromptInAutoMode(
        call.toolName, call.input, plainManager, context, undefined, undefined, on,
      );
      expect(withKey).toEqual(off);
      expect(withKey?.shellAllowRulesSuspended).toBeUndefined();
    }
    // …and the MCP mutation keeps its own prompt type, not the shell band's.
    expect(shouldPromptInAutoMode(
      'mcp__linear__createIssue', { title: 'Bug' }, plainManager, context, undefined, undefined, on,
    )?.promptType).toBe('mcp_mutation');
  });
});

describe('autoMode.classifyAllShell — composition across scopes', () => {
  it('boolean-OR: managed or user true wins, absent is false', () => {
    expect(resolveAutoModeClassifyAllShell({ managed: { classifyAllShell: true } })).toBe(true);
    expect(resolveAutoModeClassifyAllShell({ user: { classifyAllShell: true } })).toBe(true);
    expect(resolveAutoModeClassifyAllShell({ managed: { allow: ['x'] } })).toBe(false);
    expect(resolveAutoModeClassifyAllShell({})).toBe(false);
  });
});
