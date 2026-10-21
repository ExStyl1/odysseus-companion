/**
 * F1.789 — the claude CLI's own workspace-trust entry, written for a project the host trusted.
 *
 * The key and the file are the CLI's (read in the vendored 2.1.274 bundle, see the module header):
 * `<CLAUDE_CONFIG_DIR>/.claude.json`, `projects[<repo root | main checkout root | folder>]`, in the
 * resolved and realpath spellings. The integrated arm (a real `chatImpl` turn writes it) is in
 * `agent/__tests__/claude-project-trust-setting-sources.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectTrustKeys, syncClaudeProjectTrustEntry } from '../project-trust-entry.ts';

let base = '';
let configDir = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1789-')));
  configDir = join(base, 'claude-config');
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const readConfig = (): Record<string, any> => JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'));

function makeRepo(name: string): string {
  const repo = join(base, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
  return repo;
}

describe('F1.789 — the trust key is the CLI\'s', () => {
  it('a subfolder of a repository is keyed on the repository root', () => {
    const repo = makeRepo('repo');
    expect(claudeProjectTrustKeys(join(repo, 'packages', 'app'))).toEqual([repo]);
  });

  it('a linked worktree is keyed on the MAIN checkout\'s root; a submodule on its own root', () => {
    const main = makeRepo('main');
    const worktreeGitdir = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(worktreeGitdir, { recursive: true });
    writeFileSync(join(worktreeGitdir, 'commondir'), '../..\n');
    const worktree = join(base, 'wt');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${worktreeGitdir}\n`);
    expect(claudeProjectTrustKeys(worktree)).toEqual([main]);

    const moduleGitdir = join(main, '.git', 'modules', 'sub');
    mkdirSync(moduleGitdir, { recursive: true });
    const sub = join(main, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
    expect(claudeProjectTrustKeys(sub)).toEqual([sub]);
  });

  it('outside a repository the folder itself is the key, in its realpath spelling too', () => {
    const folder = join(base, 'plain');
    mkdirSync(folder);
    expect(claudeProjectTrustKeys(folder)).toEqual([folder]);
    // macOS: the temp dir is reached through the `/var` → `/private/var` symlink.
    const viaLink = folder.replace(/^\/private\//, '/');
    expect(viaLink !== folder && existsSync(viaLink)).toBe(process.platform === 'darwin');
    if (viaLink !== folder) expect(claudeProjectTrustKeys(viaLink)).toEqual([viaLink, folder]);
  });
});

describe('F1.789 — syncClaudeProjectTrustEntry', () => {
  it('trusted: writes hasTrustDialogAccepted and keeps every other key of the CLI\'s file', () => {
    const repo = makeRepo('repo');
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
      numStartups: 3, projects: { '/elsewhere': { allowedTools: [] }, [repo]: { lastCost: 1 } },
    }));
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: join(repo, 'packages'), trusted: true })).toBe('written');
    const config = readConfig();
    expect(config.numStartups).toBe(3);
    expect(config.projects['/elsewhere']).toEqual({ allowedTools: [] });
    expect(config.projects[repo]).toEqual({ lastCost: 1, hasTrustDialogAccepted: true });
    // Idempotent: the next turn writes nothing.
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: repo, trusted: true })).toBe('unchanged');
  });

  it('trusted with no file yet: creates it with the entry alone', () => {
    const repo = makeRepo('repo');
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: repo, trusted: true })).toBe('written');
    expect(readConfig()).toEqual({ projects: { [repo]: { hasTrustDialogAccepted: true } } });
  });

  it('NEGATIVE: an untrusted project gets no entry, and no file is created', () => {
    const repo = makeRepo('repo');
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: repo, trusted: false })).toBe('unchanged');
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false);
  });

  it('a project trusted earlier and now kept restricted has its entry withdrawn', () => {
    const repo = makeRepo('repo');
    syncClaudeProjectTrustEntry({ configDir, cwd: repo, trusted: true });
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: repo, trusted: false })).toBe('written');
    expect(readConfig().projects[repo].hasTrustDialogAccepted).toBe(false);
  });

  it('BOUNDARY: an unparseable file is left byte-identical, and no config dir or cwd writes nothing', () => {
    const repo = makeRepo('repo');
    writeFileSync(join(configDir, '.claude.json'), '{ not json');
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: repo, trusted: true })).toBe('skipped');
    expect(readFileSync(join(configDir, '.claude.json'), 'utf-8')).toBe('{ not json');
    expect(syncClaudeProjectTrustEntry({ configDir: undefined, cwd: repo, trusted: true })).toBe('skipped');
    expect(syncClaudeProjectTrustEntry({ configDir, cwd: undefined, trusted: true })).toBe('skipped');
  });
});
