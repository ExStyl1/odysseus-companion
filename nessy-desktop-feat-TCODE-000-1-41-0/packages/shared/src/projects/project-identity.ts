/**
 * Canonical project identity (W6).
 *
 * A "project" is an external working directory the agent operates in — never
 * managed Workspace storage. Trust, backend handles (W8/W9) and recents all
 * key off ONE canonical identity primitive so no subsystem invents its own
 * path-based key.
 *
 * Identity is derived from the platform filesystem root identity (device +
 * inode) of the resolved realpath, NOT from the absolute path string:
 * - Moving/renaming the project directory (same inode) preserves the key.
 * - Deleting and recreating a directory at the same realpath changes the inode,
 *   so the fingerprint changes and any prior trust grant is invalidated.
 * - A symlink swap resolves to a different realpath/inode, so the key changes.
 *
 * When the platform cannot supply a stable identity (stat failure, or a
 * filesystem that reports a zero/unavailable inode — e.g. some network mounts),
 * we fall back to a `process-only` identity salted with a per-process random
 * value. Process-only identities NEVER enter the persistent trust store; a
 * decision about them expires with the process, so an unstable filesystem can
 * never produce a persistent path-only grant.
 *
 * The home directory is the SECOND route to `process-only` (glossary.md:231:
 * "Acceptance is saved per project directory, except your home directory,
 * where trust is held for the current session only and the prompt reappears
 * on each launch"). The home directory itself — and only itself; its
 * subdirectories keep stable identities — is forced onto the process-only
 * route even when the platform supplies a perfectly stable root identity, so
 * a trust grant for it can never outlive the process.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Opaque, path-free stable identifier for a project root. Callers must treat
 * this as an opaque token — it deliberately does not embed the absolute path.
 */
export type ProjectKey = string;

export interface ResolvedProjectIdentity {
  /** Resolved realpath of the candidate (best-effort when the path is missing). */
  canonicalPath: string;
  /** Path-free stable key; the persistent store and handles key off this. */
  projectKey: ProjectKey;
  /** Root-identity fingerprint; a grant matches only when this still matches. */
  identityFingerprint: string;
  /** `stable` identities may persist; `process-only` ones expire with the process. */
  persistence: 'stable' | 'process-only';
}

/** Test seam: inject filesystem primitives and the process salt. */
export interface ResolveProjectIdentityOptions {
  realpathSync?: (path: string) => string;
  statSync?: (path: string) => { dev: bigint; ino: bigint };
  processSalt?: string;
  /**
   * Test seam for the home-directory carve-out (glossary.md:231); defaults to
   * `os.homedir()`. Canonicalized through the same injected `realpathSync`.
   */
  homeDir?: string;
}

const PROJECT_KEY_PREFIX = 'p_';

// One salt per process. Process-only identities incorporate it so they can
// never collide with a persisted stable key and cannot survive a restart.
const PROCESS_SALT = randomBytes(16).toString('hex');

function statIdentity(
  path: string,
  stat: (path: string) => { dev: bigint; ino: bigint },
): { dev: bigint; ino: bigint } | null {
  try {
    const result = stat(path);
    // A zero inode means the platform did not supply a usable identity.
    if (result.ino === 0n) return null;
    return { dev: result.dev, ino: result.ino };
  } catch {
    return null;
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectKeyFromFingerprint(identityFingerprint: string): ProjectKey {
  return `${PROJECT_KEY_PREFIX}${identityFingerprint.slice(0, 32)}`;
}

/**
 * True for a well-formed persisted project key. Rejects anything that looks
 * like an absolute path or carries path separators — the trust store must never
 * round-trip an absolute path.
 */
export function isValidProjectKey(value: unknown): value is ProjectKey {
  return (
    typeof value === 'string'
    && value.startsWith(PROJECT_KEY_PREFIX)
    && /^p_[a-f0-9]{32}$/.test(value)
  );
}

/**
 * Resolve the canonical, path-free identity for a candidate project directory.
 * Callers MUST call this immediately before a trust/handle decision so a
 * replaced inode is detected on every use (revalidation).
 */
export async function resolveProjectIdentity(
  candidatePath: string,
  options: ResolveProjectIdentityOptions = {},
): Promise<ResolvedProjectIdentity> {
  const realpath = options.realpathSync ?? realpathSync;
  const stat = options.statSync
    ?? ((path: string) => statSync(path, { bigint: true }) as unknown as { dev: bigint; ino: bigint });
  const processSalt = options.processSalt ?? PROCESS_SALT;

  let canonicalPath: string;
  try {
    canonicalPath = realpath(candidatePath);
  } catch {
    // Missing/unreadable path: fall back to a lexical resolution and force a
    // process-only identity (we have no stable root identity to key on).
    canonicalPath = resolve(candidatePath);
  }

  // Home-directory carve-out (glossary.md:231): "Acceptance is saved per
  // project directory, except your home directory, where trust is held for the
  // current session only and the prompt reappears on each launch." The home
  // directory is canonicalized through the SAME injected realpath so home
  // reached via a symlink still matches, and only exact equality counts — a
  // subdirectory of home keeps its stable identity.
  const homeDir = options.homeDir ?? homedir();
  let canonicalHome: string;
  try {
    canonicalHome = realpath(homeDir);
  } catch {
    canonicalHome = resolve(homeDir);
  }

  const identity = statIdentity(canonicalPath, stat);
  if (!identity || canonicalPath === canonicalHome) {
    const identityFingerprint = sha256Hex(`process-only:${processSalt}:${canonicalPath}`);
    return {
      canonicalPath,
      projectKey: projectKeyFromFingerprint(identityFingerprint),
      identityFingerprint,
      persistence: 'process-only',
    };
  }

  const identityFingerprint = sha256Hex(`root-identity:${identity.dev}:${identity.ino}`);
  return {
    canonicalPath,
    projectKey: projectKeyFromFingerprint(identityFingerprint),
    identityFingerprint,
    persistence: 'stable',
  };
}

/**
 * F1.11 (origin D1.367, decided 2026-09-24: option (b)) — the directory a LINKED git worktree's project answers
 * to for project-scope plugin ACTIVATION: the same relative directory inside the repository's main checkout.
 *
 * Project identity itself is unchanged: a worktree is still its own directory, its own `ProjectKey`, and its
 * own TRUST decision (trust is asked per directory; option (a), unifying trust too, would transfer whole-project
 * trust into a directory the user never approved). Only the plugin-activation read consults this answer —
 * `CapabilityPolicyStore.resolve` reads the main checkout's project records first and the worktree's own after
 * them — which is what Claude Code does by construction: a plugin enabled for a project lives in the
 * repository's `.claude/settings.json`, which every worktree checks out.
 *
 * Walks up from the realpath of `directory` to the FIRST `.git` entry and answers only when that entry is a
 * FILE naming a linked worktree whose registration is genuine. Everything else answers `undefined`, which
 * means "no main checkout — use the directory's own key" (a narrower, never a wider, answer):
 * - a `.git` DIRECTORY (the main checkout itself, or a plain repository), or no `.git` at all;
 * - a `.git` file with no `commondir` beside its gitdir (a submodule's admin directory);
 * - a common dir not named `.git` (a BARE repository's worktree — there is no main checkout to follow);
 * - a registration whose `gitdir` back-link does not name this very `.git` file — so a directory that only
 *   CLAIMS to be a worktree (a hand-written `.git` file pointing at someone else's admin directory) inherits
 *   nothing: only git itself writes that back-link, inside the main repository;
 * - a relative directory that does not exist in the main checkout.
 */
export function resolveLinkedWorktreeMainCheckoutPath(directory: string): string | undefined {
  let start: string;
  try {
    start = realpathSync(directory);
  } catch {
    return undefined;
  }
  let current = start;
  for (;;) {
    const gitPath = join(current, '.git');
    let entry: ReturnType<typeof lstatSync> | undefined;
    try {
      entry = lstatSync(gitPath);
    } catch {
      entry = undefined;
    }
    if (entry) {
      if (!entry.isFile()) return undefined;
      const mainCheckout = mainCheckoutOfLinkedWorktree(gitPath);
      if (!mainCheckout) return undefined;
      const candidate = join(mainCheckout, relative(current, start));
      try {
        return statSync(candidate).isDirectory() ? realpathSync(candidate) : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function mainCheckoutOfLinkedWorktree(gitFile: string): string | undefined {
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitFile, 'utf8'))?.[1];
    if (!gitdir) return undefined;
    const adminDir = realpathSync(isAbsolute(gitdir) ? gitdir : resolve(dirname(gitFile), gitdir));
    const commondir = readFileSync(join(adminDir, 'commondir'), 'utf8').trim();
    if (!commondir) return undefined;
    const commonGitDir = realpathSync(isAbsolute(commondir) ? commondir : resolve(adminDir, commondir));
    if (basename(commonGitDir) !== '.git') return undefined;
    const backLink = readFileSync(join(adminDir, 'gitdir'), 'utf8').trim();
    const registered = realpathSync(isAbsolute(backLink) ? backLink : resolve(adminDir, backLink));
    if (registered !== realpathSync(gitFile)) return undefined;
    return dirname(commonGitDir);
  } catch {
    return undefined;
  }
}

/**
 * F1.11 — the `ProjectKey` whose project-scope plugin activation a project inside a linked worktree inherits,
 * or `undefined` when there is none (see {@link resolveLinkedWorktreeMainCheckoutPath}). A main-checkout
 * identity that is not `stable` (the home directory, an unstable filesystem) is never inherited: a
 * process-only key cannot carry a persisted record anyway, and answering it would only look like a match.
 */
export async function resolveMainCheckoutProjectKey(
  projectRoot: string | undefined,
  options: ResolveProjectIdentityOptions = {},
): Promise<ProjectKey | undefined> {
  if (!projectRoot) return undefined;
  const mainCheckout = resolveLinkedWorktreeMainCheckoutPath(projectRoot);
  if (!mainCheckout) return undefined;
  const identity = await resolveProjectIdentity(mainCheckout, options);
  return identity.persistence === 'stable' ? identity.projectKey : undefined;
}
