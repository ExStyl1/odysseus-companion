/**
 * UB7.6 — ported/adapted from craft-agents-oss `v0.15.1:packages/shared/src/agent/__tests__/mode-manager-allowed-write-paths.test.ts`
 * (Apache-2.0; the `~/.craft-agent` arm re-homed to `~/.nessy-agent`), plus the
 * row's drive arms: a write inside an allowed glob in the DEFAULT (Ask) mode
 * runs CARD-FREE (`shouldPromptInAskMode` → null), a write outside still
 * prompts, and — the OQ-43.7 (a) control — the SAME write in PLAN is refused by
 * `shouldAllowToolInMode` whatever the allowlist says (F1.1050's plan
 * absorption stands; the plan gate never reads the list).
 */
import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { matchesAllowedWritePath, shouldAllowToolInMode } from '../mode-manager.ts'
import { shouldPromptInAskMode } from '../core/pre-tool-use.ts'
import { permissionsConfigCache } from '../permissions-config.ts'
import { PermissionManager } from '../core/permission-manager.ts'

// The matcher is shared by the DEFAULT mode's prompt suppression
// (core/pre-tool-use.ts:shouldPromptInAskMode) and compiled by the same
// bidirectional `globToRegex` as the deny floor; both modes must agree on what
// "inside the allowlist" means.
describe('matchesAllowedWritePath', () => {
  it('matches nested paths under a /** glob', () => {
    expect(matchesAllowedWritePath('/tmp/out/a/b.txt', ['/tmp/out/**'])).toBe(true);
    expect(matchesAllowedWritePath('/tmp/out/a.txt', ['/tmp/out/**'])).toBe(true);
  });

  it('does not match a sibling directory that shares the prefix', () => {
    expect(matchesAllowedWritePath('/tmp/output/a.txt', ['/tmp/out/**'])).toBe(false);
  });

  it('expands ~ in patterns', () => {
    expect(matchesAllowedWritePath(join(homedir(), '.nessy-agent', 'x.json'), ['~/.nessy-agent/**'])).toBe(true);
  });

  it('checks every pattern and ignores invalid ones', () => {
    expect(matchesAllowedWritePath('/srv/site/index.html', ['/tmp/**', '/srv/site/**'])).toBe(true);
    expect(matchesAllowedWritePath('/srv/site/index.html', ['/tmp/**'])).toBe(false);
    expect(matchesAllowedWritePath('/srv/site/index.html', [])).toBe(false);
  });
});

describe('allowedWritePaths in the default mode (UB7.6 / OQ-43.7 (a))', () => {
  const allowedRoot = '/tmp/ub7-6-allowed';

  function workspaceWithAllowlist(): { root: string; manager: PermissionManager; context: { workspaceRootPath: string; activeSourceSlugs: string[] } } {
    const root = mkdtempSync(join(tmpdir(), 'nessy-ub7-6-ws-'));
    // The workspace permissions.json is the merged config's source for
    // allowedWritePaths; the cache must drop its stale entry for the fresh dir.
    writeFileSync(
      join(root, 'permissions.json'),
      JSON.stringify({ allowedWritePaths: [`${allowedRoot}/**`] }, null, 2),
      'utf-8',
    );
    permissionsConfigCache.invalidateWorkspace(root);
    const manager = new PermissionManager({ workspaceRootPath: root } as never);
    return { root, manager, context: { workspaceRootPath: root, activeSourceSlugs: [] } };
  }

  it('a write inside an allowed glob runs card-free in the default mode', () => {
    const { manager, context } = workspaceWithAllowlist();
    const prompt = shouldPromptInAskMode(
      'Write',
      { file_path: join(allowedRoot, 'src', 'a.ts') },
      manager,
      context,
    );
    expect(prompt).toBeNull();
  });

  it('a write outside the allowlist still prompts (the negative)', () => {
    const { manager, context } = workspaceWithAllowlist();
    const prompt = shouldPromptInAskMode(
      'Write',
      { file_path: '/tmp/ub7-6-outside/a.ts' },
      manager,
      context,
    );
    expect(prompt).not.toBeNull();
    expect(prompt?.promptType).toBe('file_write');
  });

  it('the SAME write in plan is refused whatever the allowlist says (OQ-43.7 (a): never plan)', () => {
    const { root, manager, context } = workspaceWithAllowlist();
    void manager;
    void context;
    const plansFolderPath = join(root, 'plans');
    const dataFolderPath = join(root, 'data');
    mkdirSync(plansFolderPath, { recursive: true });
    mkdirSync(dataFolderPath, { recursive: true });

    const verdict = shouldAllowToolInMode(
      'Write',
      { file_path: join(allowedRoot, 'src', 'a.ts') },
      'plan',
      { plansFolderPath, dataFolderPath, workingDirectory: root },
    );
    expect(verdict.allowed).toBe(false);
  });
});
