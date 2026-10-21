/**
 * The Claude settings writer (permissions.md § Permission system, :15-:23).
 *
 *   "When you choose 'Yes, don't ask again' and the approval saves permanently,
 *   such as for a Bash command, Claude Code saves the rule to
 *   `.claude/settings.local.json` at the root of the git repository, resolved
 *   through worktrees to the main checkout. […] Outside a git repository, and
 *   when the repository root is your home directory, Claude Code saves the rule
 *   in the directory you started it from."
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addClaudePermissionRules,
  claudeSettingsPath,
  resolveClaudeSettingsRoot,
} from '../claude-settings-store.ts';
import { parsePermissionsJson } from '../permissions-config.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe('resolveClaudeSettingsRoot', () => {
  it('finds the repository root from a subdirectory', () => {
    const repo = tmp('nessy-settings-repo-');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const nested = join(repo, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    expect(resolveClaudeSettingsRoot(nested)).toBe(repo);
  });

  it('resolves a linked worktree to the main checkout', () => {
    const repo = tmp('nessy-settings-main-');
    const gitDir = join(repo, '.git');
    const worktreeGitDir = join(gitDir, 'worktrees', 'feature');
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n');
    const worktree = tmp('nessy-settings-wt-');
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`);
    expect(resolveClaudeSettingsRoot(worktree)).toBe(repo);
  });

  it('falls back to the starting directory outside a repository', () => {
    const plain = tmp('nessy-settings-plain-');
    // Home is forced away from tmp so the walk cannot find a real .git above.
    expect(resolveClaudeSettingsRoot(plain, { home: plain })).toBe(plain);
  });

  it('falls back to the starting directory when the repository root is home', () => {
    const home = tmp('nessy-settings-home-');
    mkdirSync(join(home, '.git'), { recursive: true });
    const nested = join(home, 'scratch');
    mkdirSync(nested, { recursive: true });
    expect(resolveClaudeSettingsRoot(nested, { home })).toBe(nested);
  });
});

describe('addClaudePermissionRules', () => {
  it('creates the file and writes a rule the reader compiles', () => {
    const repo = tmp('nessy-settings-write-');
    const result = addClaudePermissionRules('localSettings', repo, 'allow', ['Bash(npm *)']);

    expect(result.added).toEqual(['Bash(npm *)']);
    expect(result.path).toBe(claudeSettingsPath('localSettings', repo));
    const document = parsePermissionsJson(readFileSync(result.path, 'utf8')).permissionDsl?.document as { rules: unknown[] };
    expect(document.rules).toHaveLength(1);
  });

  it('merge-preserves unrelated keys and existing rules, and dedupes', () => {
    const repo = tmp('nessy-settings-merge-');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(claudeSettingsPath('localSettings', repo), JSON.stringify({
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(git *)'], deny: ['Bash(curl:*)'] },
    }));

    addClaudePermissionRules('localSettings', repo, 'allow', ['Bash(npm *)']);
    const second = addClaudePermissionRules('localSettings', repo, 'allow', ['Bash(npm *)']);

    expect(second.added).toEqual([]);
    expect(second.alreadyPresent).toEqual(['Bash(npm *)']);
    const saved = JSON.parse(readFileSync(claudeSettingsPath('localSettings', repo), 'utf8'));
    expect(saved.env).toEqual({ FOO: 'bar' });
    expect(saved.permissions.allow).toEqual(['Bash(git *)', 'Bash(npm *)']);
    // A deny list this module never touched is byte-identical.
    expect(saved.permissions.deny).toEqual(['Bash(curl:*)']);
  });

  it('refuses to write when the existing settings file does not parse', () => {
    const repo = tmp('nessy-settings-broken-');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const path = claudeSettingsPath('localSettings', repo);
    writeFileSync(path, '{ this is not json');

    const result = addClaudePermissionRules('localSettings', repo, 'allow', ['Bash(npm *)']);

    expect(result.refused).toBe('unparseable-settings');
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
  });

  it('routes each destination to its documented file', () => {
    const repo = tmp('nessy-settings-dest-');
    const home = tmp('nessy-settings-userhome-');
    expect(claudeSettingsPath('localSettings', repo)).toBe(join(repo, '.claude', 'settings.local.json'));
    expect(claudeSettingsPath('projectSettings', repo)).toBe(join(repo, '.claude', 'settings.json'));
    expect(claudeSettingsPath('userSettings', repo, { home })).toBe(join(home, '.claude', 'settings.json'));
  });
});
