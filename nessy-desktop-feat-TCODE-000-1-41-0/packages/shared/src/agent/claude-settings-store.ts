/**
 * The writer for Claude settings files (`.claude/settings.json`,
 * `.claude/settings.local.json`, `~/.claude/settings.json`).
 *
 * PRIVILEGE BOUNDARY. This module is a mechanism, not a policy: it can write
 * any rule to any of the three destinations, and every caller is responsible
 * for deciding that the write is allowed. Two properties are enforced HERE, in
 * the mechanism, because they cannot be re-derived at a call site:
 *
 * 1. It only ever ADDS entries. There is no remove and no replace, so no
 *    caller — hook, tool or session — can use it to delete a `deny` rule or
 *    shrink an existing list. A settings file this module has touched is a
 *    superset of what it was.
 * 2. It refuses to write at all when the existing file does not parse. A file
 *    we cannot read is a file we cannot merge into, and clobbering it would
 *    silently drop rules that are currently in force.
 *
 * The rule string is written verbatim in `permissions.md` syntax so the file
 * stays the same file Claude Code reads.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parsePermissionJsonc } from './pi-harness/permission-dsl.ts';

export type ClaudeSettingsDestination = 'localSettings' | 'projectSettings' | 'userSettings';
export type ClaudeSettingsBehavior = 'allow' | 'ask' | 'deny';

const CLAUDE_DIR = '.claude';
const FILE_BY_DESTINATION: Readonly<Record<ClaudeSettingsDestination, string>> = {
  localSettings: 'settings.local.json',
  projectSettings: 'settings.json',
  userSettings: 'settings.json',
};

/**
 * The directory a repository-scoped "don't ask again" rule is saved under.
 *
 * permissions.md:21 — "Claude Code saves the rule to `.claude/settings.local.json`
 * at the root of the git repository, resolved through worktrees to the main
 * checkout. The rule applies to future sessions anywhere in that repository,
 * including sessions started in subdirectories and in worktrees. […] Outside a
 * git repository, and when the repository root is your home directory, Claude
 * Code saves the rule in the directory you started it from."
 */
export function resolveClaudeSettingsRoot(startDir: string, options: { home?: string } = {}): string {
  const home = resolve(options.home ?? homedir());
  const start = resolve(startDir);
  let current = start;
  for (;;) {
    const gitPath = join(current, '.git');
    if (existsSync(gitPath)) {
      const mainCheckout = resolveWorktreeMainCheckout(gitPath) ?? current;
      return mainCheckout === home ? start : mainCheckout;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/**
 * "resolved through worktrees to the main checkout": a linked worktree's `.git`
 * is a FILE holding `gitdir: <repo>/.git/worktrees/<name>`, and that directory's
 * `commondir` points back at the main repository's `.git`. Anything unreadable
 * or unexpected falls back to the directory that held the `.git` entry, which is
 * the worktree itself — a narrower, never a wider, destination.
 */
function resolveWorktreeMainCheckout(gitPath: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(gitPath, 'utf8');
  } catch {
    return undefined; // a real .git directory
  }
  const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(contents)?.[1]?.trim();
  if (!gitdir) return undefined;
  const worktreeGitDir = isAbsolute(gitdir) ? gitdir : resolve(dirname(gitPath), gitdir);
  let commondir: string;
  try {
    commondir = readFileSync(join(worktreeGitDir, 'commondir'), 'utf8').trim();
  } catch {
    return undefined;
  }
  if (commondir.length === 0) return undefined;
  const commonGitDir = isAbsolute(commondir) ? commondir : resolve(worktreeGitDir, commondir);
  const mainCheckout = dirname(resolve(commonGitDir));
  return existsSync(mainCheckout) ? mainCheckout : undefined;
}

export function claudeSettingsPath(
  destination: ClaudeSettingsDestination,
  root: string,
  options: { home?: string } = {},
): string {
  const base = destination === 'userSettings' ? resolve(options.home ?? homedir()) : resolve(root);
  return join(base, CLAUDE_DIR, FILE_BY_DESTINATION[destination]);
}

export interface ClaudeSettingsWriteResult {
  path: string;
  /** Rules this call added to the file. */
  added: readonly string[];
  /** Rules the file already carried under this behavior. */
  alreadyPresent: readonly string[];
  /** Set when nothing was written; the file is left byte-identical. */
  refused?: 'unparseable-settings' | 'write-failed';
}

/**
 * Add permission rules to one settings file, merge-preserving everything else.
 *
 * Additive only, by design — see the privilege boundary note at the top. The
 * write is atomic (temp file in the same directory, then rename) so a crash
 * mid-write cannot leave a half-parsed settings file that would then refuse
 * every later merge.
 */
export function addClaudePermissionRules(
  destination: ClaudeSettingsDestination,
  root: string,
  behavior: ClaudeSettingsBehavior,
  rules: readonly string[],
  options: { home?: string } = {},
): ClaudeSettingsWriteResult {
  const path = claudeSettingsPath(destination, root, options);
  const wanted = rules.map(rule => rule.trim()).filter(rule => rule.length > 0);
  if (wanted.length === 0) return { path, added: [], alreadyPresent: [] };

  let document: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = parsePermissionJsonc(readFileSync(path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { path, added: [], alreadyPresent: [], refused: 'unparseable-settings' };
      }
      document = parsed as Record<string, unknown>;
    } catch {
      return { path, added: [], alreadyPresent: [], refused: 'unparseable-settings' };
    }
  }

  const permissionsValue = document.permissions;
  const permissions = permissionsValue !== null && typeof permissionsValue === 'object' && !Array.isArray(permissionsValue)
    ? { ...permissionsValue as Record<string, unknown> }
    : {};
  const existingValue = permissions[behavior];
  const existing = Array.isArray(existingValue) ? existingValue.filter(entry => typeof entry === 'string') as string[] : [];
  const present = new Set(existing);
  const added = wanted.filter(rule => !present.has(rule));
  const alreadyPresent = wanted.filter(rule => present.has(rule));
  if (added.length === 0) return { path, added: [], alreadyPresent };

  permissions[behavior] = [...existing, ...added];
  const next = { ...document, permissions };

  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    return { path, added: [], alreadyPresent, refused: 'write-failed' };
  }
  return { path, added, alreadyPresent };
}
