import { afterEach, describe, it, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { shouldAllowToolInMode, type PermissionMode } from '../mode-manager.ts';
import {
  shouldPromptInAskMode,
  shouldPromptInAutoMode,
  type PermissionManagerLike,
} from '../core/pre-tool-use.ts';
import { permissionsConfigCache } from '../permissions-config.ts';

// P2.254: `shouldAllowToolInMode('Bash', …)` reaches `getDeniedPathViolation` ->
// `extractPowerShellWriteTarget`, which spawns `powershell-parser.ps1` once per
// call on a host with a real PowerShell (P2.241 owns the ungated spawn itself).
// One spawn is 0.69-0.88s idle and the every-mode cases make several, so bun's
// 5s default sits BELOW this file's resting cost — measured as a 15.4s "timed
// out after 5000ms" on `blocks denied sensitive paths in every mode`. Until this
// defect was fixed those calls never spawned: the validator THREW. Same value
// and reason as `packages/shared/tests/mode-manager.test.ts`.
setDefaultTimeout(30_000);

const tempWorkspaces: string[] = [];

function createWorkspacePermissions(config: Record<string, unknown>): string {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-mode-gate-'));
  writeFileSync(
    join(workspaceRootPath, 'permissions.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf-8'
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

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: (command) => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

const permissionsContext = {
  workspaceRootPath: '/workspace',
  activeSourceSlugs: ['linear'],
};

describe('permission mode gate', () => {
  it('uses the final six-mode order', () => {
    const modes: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
    for (const mode of modes) {
      expect(shouldAllowToolInMode('Read', { file_path: '/workspace/a.ts' }, mode).allowed).toBe(true);
    }
  });

  it('keeps plan mode read-only while allowing SubmitPlan', () => {
    const write = shouldAllowToolInMode(
      'Write',
      { file_path: '/workspace/.nessy-agent/sessions/abc/plans/plan.md', content: 'x' },
      'plan',
      { plansFolderPath: '/workspace/.nessy-agent/sessions/abc/plans' }
    );
    const bashWrite = shouldAllowToolInMode(
      'Bash',
      { command: 'echo "x" > /workspace/file.txt' },
      'plan',
      { allowPlanShellReview: true }
    );
    const read = shouldAllowToolInMode('Read', { file_path: '/workspace/file.txt' }, 'plan');
    const submitPlan = shouldAllowToolInMode('SubmitPlan', { plan: 'Use the new modes.' }, 'plan');

    expect(write.allowed).toBe(false);
    // R21 — "the classifier reviews shell commands during planning instead of
    // prompting you" (`permission-modes.md:240` on the 2026-08-23 fetch; the
    // sentence is the anchor, the number a convenience): a command outside the
    // read-only set
    // is no longer blocked outright in plan mode. It is handed up as plan
    // mode's shell band, which the classifier reviews (or, failing that,
    // prompts for). Plan mode's WRITE block above is untouched.
    expect(bashWrite).toMatchObject({ allowed: true, requiresPermission: true, planShellReview: true });
    expect(read.allowed).toBe(true);
    expect(submitPlan.allowed).toBe(true);
  });

  it('does not trust protocol-declared MCP metadata in plan', () => {
    const result = shouldAllowToolInMode(
      'mcp__calendar__events',
      {},
      'plan',
    );

    expect(result.allowed).toBe(false);
  });

  it('acceptEdits allows file writes without prompting', () => {
    const allowed = shouldAllowToolInMode('Write', { file_path: '/workspace/file.ts' }, 'acceptEdits');
    const prompt = shouldPromptInAskMode(
      'Write',
      { file_path: '/workspace/file.ts', content: 'x' },
      permissionManager,
      permissionsContext,
      undefined,
      undefined,
      // The same bound production supplies: roots + cwd. A bare
      // `autoAllowFileWrites` with no roots now fails closed on purpose.
      { autoAllowFileWrites: true, autoAllowWriteRoots: ['/workspace'], cwd: '/workspace' }
    );

    expect(allowed.allowed).toBe(true);
    expect(prompt).toBeNull();
  });

  it('acceptEdits still prompts for bash and MCP mutations', () => {
    const bashPrompt = shouldPromptInAskMode(
      'Bash',
      { command: 'npm install express' },
      permissionManager,
      permissionsContext,
      undefined,
      undefined,
      // The same bound production supplies: roots + cwd. A bare
      // `autoAllowFileWrites` with no roots now fails closed on purpose.
      { autoAllowFileWrites: true, autoAllowWriteRoots: ['/workspace'], cwd: '/workspace' }
    );
    const mcpPrompt = shouldPromptInAskMode(
      'mcp__linear__createIssue',
      { title: 'Bug' },
      permissionManager,
      permissionsContext,
      undefined,
      undefined,
      // The same bound production supplies: roots + cwd. A bare
      // `autoAllowFileWrites` with no roots now fails closed on purpose.
      { autoAllowFileWrites: true, autoAllowWriteRoots: ['/workspace'], cwd: '/workspace' }
    );

    expect(bashPrompt?.promptType).toBe('bash');
    expect(mcpPrompt?.promptType).toBe('mcp_mutation');
  });

  it('auto allows low-risk bash but prompts for risky mutations', () => {
    const lowRiskBash = shouldPromptInAutoMode(
      'Bash',
      { command: 'npm test' },
      permissionManager,
      permissionsContext,
    );
    const riskyBash = shouldPromptInAutoMode(
      'Bash',
      { command: 'rm -rf build' },
      permissionManager,
      permissionsContext,
    );
    const mcpPrompt = shouldPromptInAutoMode(
      'mcp__linear__createIssue',
      { title: 'Bug' },
      permissionManager,
      permissionsContext,
    );

    expect(shouldAllowToolInMode('Write', { file_path: '/workspace/file.ts' }, 'auto').allowed).toBe(true);
    expect(lowRiskBash).toBeNull();
    expect(riskyBash?.promptType).toBe('bash');
    expect(mcpPrompt?.promptType).toBe('mcp_mutation');
  });

  it('blocks denied sensitive paths in every mode', () => {
    const modes: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];

    for (const mode of modes) {
      const read = shouldAllowToolInMode('Read', { file_path: '/workspace/.env' }, mode);
      const write = shouldAllowToolInMode('Write', { file_path: '/workspace/.env', content: 'x' }, mode);
      const bash = shouldAllowToolInMode('Bash', { command: 'cat /workspace/.env' }, mode);

      expect(read.allowed).toBe(false);
      expect(write.allowed).toBe(false);
      expect(bash.allowed).toBe(false);
      if (!read.allowed) {
        expect(read.reason).toContain('Sensitive path blocked');
      }
    }
  });

  it('denies tool names matching deniedToolPatterns globs', () => {
    const workspaceRootPath = createWorkspacePermissions({
      deniedToolPatterns: ['mcp__linear__*'],
    });

    const denied = shouldAllowToolInMode('mcp__linear__Read', {}, 'bypassPermissions', {
      permissionsContext: { workspaceRootPath },
    });
    const allowed = shouldAllowToolInMode('mcp__slack__Read', {}, 'bypassPermissions', {
      permissionsContext: { workspaceRootPath },
    });

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toContain('deniedToolPatterns pattern mcp__linear__*');
    }
    expect(allowed.allowed).toBe(true);
  });

  it('keeps exact blockedTools and deny-path floor when deniedToolPatterns are configured', () => {
    const workspaceRootPath = createWorkspacePermissions({
      deniedToolPatterns: ['mcp__linear__*'],
    });

    const write = shouldAllowToolInMode('Write', { file_path: '/workspace/file.txt', content: 'x' }, 'plan', {
      permissionsContext: { workspaceRootPath },
    });
    const readDeniedPath = shouldAllowToolInMode('Read', { file_path: '/workspace/.env' }, 'bypassPermissions', {
      permissionsContext: { workspaceRootPath },
    });

    expect(write.allowed).toBe(false);
    expect(readDeniedPath.allowed).toBe(false);
    if (!readDeniedPath.allowed) {
      expect(readDeniedPath.reason).toContain('Sensitive path blocked');
    }
  });

  /**
   * P2.39 — `blockedTools` is what the schema says it is: "Additional tools to
   * block (extends the hardcoded defaults)". It was parsed by
   * `PermissionsConfigSchema`, listed by the settings page, advertised by the
   * editor's placeholder — and dropped on the floor by `parsePermissionsJson`,
   * so `buildMergedConfig` only ever copied the hardcoded four.
   *
   * UNION, never replacement: the one consumer is
   * `config.blockedTools.has(toolName)` in `shouldAllowToolInMode`, a pure
   * membership test that denies. Nothing reads the set as an allowlist, so
   * adding to it can only ever block more — and a user's list can therefore
   * never shorten the hardcoded four back into being allowed.
   */
  it('blocks a workspace-declared blockedTools entry in the three modes that block', () => {
    const workspaceRootPath = createWorkspacePermissions({
      blockedTools: ['BashOutput', { pattern: 'KillShell', comment: 'no shell teardown while reading' }],
    });
    const options = { permissionsContext: { workspaceRootPath } };

    for (const mode of ['dontAsk', 'plan'] as PermissionMode[]) {
      const blocked = shouldAllowToolInMode('BashOutput', { bash_id: 'shell-1' }, mode, options);
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) {
        expect(blocked.reason).toContain('BashOutput is blocked in');
      }
      // The object form carries the same weight as the bare string.
      expect(shouldAllowToolInMode('KillShell', { shell_id: 'shell-1' }, mode, options).allowed).toBe(false);
    }

    // Mode-scoped by construction: the blocked-tool branch sits below the
    // interactive-write and bypass returns, so the write modes are untouched.
    // `deniedToolPatterns`/`disallowedTools` remain the every-mode levers.
    expect(shouldAllowToolInMode('BashOutput', { bash_id: 'shell-1' }, 'default', options).allowed).toBe(true);
    expect(shouldAllowToolInMode('BashOutput', { bash_id: 'shell-1' }, 'bypassPermissions', options).allowed).toBe(true);
  });

  it('cannot unblock the hardcoded four with a shorter blockedTools list', () => {
    const workspaceRootPath = createWorkspacePermissions({ blockedTools: ['BashOutput'] });
    const options = { permissionsContext: { workspaceRootPath } };

    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(shouldAllowToolInMode(tool, { file_path: '/workspace/file.txt', content: 'x' }, 'plan', options).allowed)
        .toBe(false);
    }
    expect([...permissionsConfigCache.getMergedConfig({ workspaceRootPath }).blockedTools].sort())
      .toEqual(['BashOutput', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
  });

  it('leaves a config that declares no blockedTools exactly as it was', () => {
    const workspaceRootPath = createWorkspacePermissions({ allowedBashPatterns: ['^ls\\b'] });
    const options = { permissionsContext: { workspaceRootPath } };

    expect([...permissionsConfigCache.getMergedConfig({ workspaceRootPath }).blockedTools].sort())
      .toEqual(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    expect(shouldAllowToolInMode('BashOutput', { bash_id: 'shell-1' }, 'plan', options).allowed).toBe(true);
    expect(shouldAllowToolInMode('Write', { file_path: '/workspace/file.txt', content: 'x' }, 'plan', options).allowed)
      .toBe(false);
  });

  it('honors per-tool permission rules before mode defaults', () => {
    const workspaceRootPath = createWorkspacePermissions({
      toolRules: [
        { pattern: 'mcp__linear__*', action: 'deny', comment: 'Linear writes are paused' },
        { pattern: 'Write', action: 'allow' },
        { pattern: 'Bash', action: 'ask' },
      ],
    });
    const options = { permissionsContext: { workspaceRootPath } };

    const denied = shouldAllowToolInMode('mcp__linear__createIssue', {}, 'bypassPermissions', options);
    const allowed = shouldAllowToolInMode('Write', { file_path: '/workspace/file.txt', content: 'x' }, 'plan', options);
    const ask = shouldAllowToolInMode('Bash', { command: 'npm install left-pad' }, 'bypassPermissions', options);

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toContain('toolRules pattern mcp__linear__*');
      expect(denied.reason).toContain('Linear writes are paused');
    }
    expect(allowed.allowed).toBe(true);
    // `ToolCheckResult` has TWO allowed branches — `{ allowed: true }` and
    // `{ allowed: true, requiresPermission: true, description }` — and an `ask`
    // rule promises the second. `expect(ask.allowed).toBe(true)` is satisfied by
    // both, so on its own it cannot tell a prompt from a silent grant, which is
    // the whole difference the rule buys.
    //
    // These assertions used to sit inside `if ('requiresPermission' in ask)` and
    // `if ('description' in ask)`. The condition WAS the claim: a gate that
    // granted Bash outright skipped both bodies and left the case green.
    expect(ask).toMatchObject({
      allowed: true,
      requiresPermission: true,
      description: expect.stringContaining('toolRules pattern Bash'),
    });
  });

  it('keeps deny-path floor above per-tool allow rules', () => {
    const workspaceRootPath = createWorkspacePermissions({
      deniedPaths: ['/workspace/secrets/**'],
      toolRules: [{ pattern: 'Read', action: 'allow' }],
    });

    const result = shouldAllowToolInMode(
      'Read',
      { file_path: '/workspace/secrets/token.txt' },
      'bypassPermissions',
      { permissionsContext: { workspaceRootPath } }
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denyPathBlocked).toBe(true);
      expect(result.reason).toContain('Sensitive path blocked');
    }
  });

  it('blocks tools listed in disallowedTools', () => {
    const workspaceRootPath = createWorkspacePermissions({
      disallowedTools: ['Bash'],
    });

    const denied = shouldAllowToolInMode(
      'Bash',
      { command: 'pwd' },
      'bypassPermissions',
      { permissionsContext: { workspaceRootPath } }
    );
    const allowed = shouldAllowToolInMode(
      'Read',
      { file_path: '/workspace/file.txt' },
      'bypassPermissions',
      { permissionsContext: { workspaceRootPath } }
    );

    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toContain('disallowedTools pattern Bash');
    }
    expect(allowed.allowed).toBe(true);
  });

  it('restricts the tool set when allowedTools is configured', () => {
    const workspaceRootPath = createWorkspacePermissions({
      allowedTools: ['Read', 'mcp__linear__*'],
    });
    const options = { permissionsContext: { workspaceRootPath } };

    const read = shouldAllowToolInMode('Read', { file_path: '/workspace/file.txt' }, 'bypassPermissions', options);
    const mcp = shouldAllowToolInMode('mcp__linear__Read', {}, 'bypassPermissions', options);
    const write = shouldAllowToolInMode('Write', { file_path: '/workspace/file.txt', content: 'x' }, 'bypassPermissions', options);

    expect(read.allowed).toBe(true);
    expect(mcp.allowed).toBe(true);
    expect(write.allowed).toBe(false);
    if (!write.allowed) {
      expect(write.reason).toContain('allowedTools');
    }
  });

  it('keeps deny-path floor above allowedTools', () => {
    const workspaceRootPath = createWorkspacePermissions({
      deniedPaths: ['/workspace/secrets/**'],
      allowedTools: ['Read'],
    });

    const result = shouldAllowToolInMode(
      'Read',
      { file_path: '/workspace/secrets/token.txt' },
      'bypassPermissions',
      { permissionsContext: { workspaceRootPath } }
    );

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.denyPathBlocked).toBe(true);
      expect(result.reason).toContain('Sensitive path blocked');
    }
  });
});
