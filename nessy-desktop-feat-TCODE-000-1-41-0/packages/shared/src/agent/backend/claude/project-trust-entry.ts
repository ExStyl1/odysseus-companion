/**
 * F1.789 (origin WJ-crit-dd P-WJcritdd-1) — the host's project trust, written as the claude CLI's OWN
 * workspace-trust entry, so a project the user trusted in this app is trusted by the child too.
 *
 * ## Why the child needs it
 *
 * `permissions.md#project-allow-rules-and-workspace-trust`: a project's `permissions.allow` rules and
 * `additionalDirectories` apply *"only after you accept the workspace trust dialog"*, and *"A `claude -p`
 * run or an SDK session never shows it"*. `#what-runs-before-you-trust-a-folder` adds project subagent
 * frontmatter hooks, `@skills-dir` plugins, `extraKnownMarketplaces`, inline subagent `mcpServers` and a
 * `.mcp.json` `headersHelper` to what an SDK session never uses in an untrusted folder, and names the
 * native remedy: *"set `projects["<path>"].hasTrustDialogAccepted` to `true` in `~/.claude.json`, where
 * `<path>` is the repository root, or the folder itself outside a repository."* We are an SDK session,
 * so until this row a trusted project's allow rules never applied (measured by WJ-crit-dd: the CLI
 * printed "Ignoring 1 permissions.allow entry … this workspace has not been trusted"; the arm that wrote
 * the entry applied the rule). Native-first: the CLI's own key, nothing re-implemented.
 *
 * ## Where the file is, and the key
 *
 * Read in the vendored 2.1.274 bundle: the global config is `join(CLAUDE_CONFIG_DIR || homedir(),
 * ".claude.json")`, so with the per-Workspace `CLAUDE_CONFIG_DIR` (`workspaceClaudeConfigDir`) the
 * child reads `<that dir>/.claude.json`, never `~/.claude.json` — this module never touches the
 * user's own file. The key is the repository root (in a linked worktree, the MAIN checkout's root, as
 * the same page says), else the folder itself; the CLI's own runner writes each key in its resolved,
 * realpath and NFC spellings, and so does this.
 *
 * ## Both directions, and what is never written
 *
 * - trusted → the entry is set to `true` where it is not already;
 * - not trusted → an entry left `true` (the project was trusted before) is set to `false`, so "Keep
 *   restricted" after a trust is honoured; no entry is created for an untrusted project;
 * - an unreadable or non-object file is left alone (the CLI repairs its own file), and nothing is
 *   written when nothing changes.
 *
 * RESIDUE, stated: the write is a read-modify-rename, not a lock the CLI shares, so a CLI child of
 * ANOTHER session in the same Workspace rewriting its config in the same instant can lose this entry
 * (the next turn writes it again) or this write can lose its update; a session rooted at the home
 * directory gets no persisted trust from the CLI whatever the file says (`permissions.md`: home trust
 * is session-only).
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_WALK_DEPTH = 64;

/** The repository root the CLI keys trust on: the nearest `.git`, the main checkout for a linked worktree. */
function claudeTrustRoot(cwd: string): string {
  let current = resolve(cwd);
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const marker = join(current, '.git');
    if (existsSync(marker)) {
      try {
        if (statSync(marker).isFile()) {
          // `gitdir: <main>/.git/worktrees/<name>`; a linked worktree's gitdir carries `commondir`
          // (a submodule's does not, and a submodule is its own trust root).
          const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf-8'))?.[1]?.trim();
          if (gitdir) {
            const absoluteGitdir = resolve(current, gitdir);
            const commondirFile = join(absoluteGitdir, 'commondir');
            if (existsSync(commondirFile)) {
              const common = resolve(absoluteGitdir, readFileSync(commondirFile, 'utf-8').trim());
              if (basename(common) === '.git') return dirname(common);
            }
          }
        }
      } catch {
        // Unreadable marker: the folder holding it is still the nearest root.
      }
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(cwd);
}

/** Every spelling the CLI may look the trust root up by: resolved, realpath, and their NFC forms. */
export function claudeProjectTrustKeys(cwd: string): string[] {
  const root = claudeTrustRoot(cwd);
  const spellings = [root];
  try {
    spellings.push(realpathSync(root));
  } catch {
    // Not there: keyed as resolved.
  }
  return [...new Set(spellings.flatMap(spelled => [spelled, spelled.normalize('NFC')]))];
}

export type ClaudeProjectTrustSync = 'written' | 'unchanged' | 'skipped';

/**
 * Bring `<configDir>/.claude.json` in line with the host's trust for `cwd`. Never throws: a failure is
 * reported through `debug` and answered `skipped`, and the turn runs as it did before this row.
 */
export function syncClaudeProjectTrustEntry(args: {
  configDir: string | undefined;
  cwd: string | undefined;
  trusted: boolean;
  debug?: (message: string) => void;
}): ClaudeProjectTrustSync {
  const { configDir, trusted } = args;
  const cwd = args.cwd?.trim();
  if (!configDir || !cwd) return 'skipped';
  const file = join(configDir, '.claude.json');
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        args.debug?.(`[project-trust] ${file} is not a JSON object; the entry is not written (the CLI repairs its own file)`);
        return 'skipped';
      }
      config = parsed as Record<string, unknown>;
    } else if (!trusted) {
      return 'unchanged';
    }
    const projects = (config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? { ...(config.projects as Record<string, unknown>) }
      : {}) as Record<string, Record<string, unknown> | undefined>;
    let changed = false;
    for (const key of claudeProjectTrustKeys(cwd)) {
      const entry = projects[key];
      const current = entry && typeof entry === 'object' ? entry.hasTrustDialogAccepted === true : false;
      if (trusted && !current) {
        projects[key] = { ...(entry && typeof entry === 'object' ? entry : {}), hasTrustDialogAccepted: true };
        changed = true;
      } else if (!trusted && current) {
        projects[key] = { ...entry, hasTrustDialogAccepted: false };
        changed = true;
      }
    }
    if (!changed) return 'unchanged';
    const temp = `${file}.nessy-${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...config, projects }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
    args.debug?.(`[project-trust] ${trusted ? 'trusted' : 'withdrew trust for'} ${cwd} in ${file}`);
    return 'written';
  } catch (error) {
    args.debug?.(`[project-trust] could not sync ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 'skipped';
  }
}
