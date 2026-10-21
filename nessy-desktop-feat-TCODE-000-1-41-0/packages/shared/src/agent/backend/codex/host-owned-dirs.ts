/**
 * F1.654 — per-runtime directories the HOST owns under its own config directory, minted with the
 * owning process's pid in their name and swept once that process is gone.
 *
 * Why the host sweeps (native-first asked first): these directories hold the host's own state, not
 * codex's — the unattended-automation floor hook's per-build state file (F1.609,
 * `CodexAgent.newFloorHookStateFile`) — so codex has no mechanism that could remove them, and the OS
 * never sweeps the config directory the way it reaps `$TMPDIR`. A runtime's teardown removes its own
 * directory (`CodexAgent.forgetFloorHookState`); a host that crashes or is killed runs no teardown,
 * and its directory stayed forever.
 *
 * The shape is D1.187's startup sweep (`sweepAbandonedPluginStages`, `plugins/source-resolver.ts`):
 * remove only what can be proven ours and finished. The proof here is the name,
 * `<prefix><pid>-XXXXXX`, written by the same `mkdtemp` call that creates the directory (so there is
 * no moment a directory exists without its owner, and D1.187's minimum-age belt has nothing to
 * cover), plus the owner's liveness:
 *
 * - a name with no pid — made by a build of 1.41.0 before this row, never released — is kept;
 * - this process's own pid is kept: a live runtime here, or one dropped without its teardown, which
 *   the first build after this process exits removes;
 * - a pid `process.kill(pid, 0)` finds is kept, and so is any error but `ESRCH` (`EPERM` is another
 *   user's live process) — only "no such process" removes, the safe direction;
 * - symlinks and files are never touched: only real directories are candidates.
 *
 * Pid reuse can only make a dead owner look alive, which keeps a ~80-byte directory until a later
 * build; it cannot make a live owner look dead. Residue, not handled: pids are per machine, so a
 * config directory used by two MACHINES at once (a shared network home) would see the other
 * machine's live pids as dead here. Best-effort throughout — the sweep never throws, and a removal
 * that fails is left for the next build. F1.681 mints the per-session `CODEX_HOME`s under
 * `<config>/codex-home` through the same two functions (`codex-agent.ts` `mintCodexHome`).
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_DIR } from '../../../config/paths.ts';

/** Whether a host process with this pid may still be running; only `ESRCH` says it is not. */
export function hostProcessMayBeAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0: the existence and permission check only, nothing is sent
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
  }
}

/**
 * Removes every directory directly under `root` named `<prefix><pid>-…` whose pid names no running
 * process, and returns the names it removed. Never throws.
 */
export function sweepHostOwnedDirs(
  root: string,
  prefix: string,
  mayBeAlive: (pid: number) => boolean = hostProcessMayBeAlive,
): string[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    // A positive integer only: `process.kill(0 or a negative pid)` would signal a process GROUP.
    const pid = /^([1-9]\d{0,9})-/.exec(name.slice(prefix.length))?.[1];
    if (!pid || mayBeAlive(Number(pid))) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Left where it was; the next build tries again.
    }
  }
  return removed;
}

/**
 * Sweeps `root` ({@link sweepHostOwnedDirs}), then mints this process's own `<prefix><pid>-XXXXXX`
 * directory in it. Throws only what `mkdtempSync` throws; a sweep that removed something says so
 * through `debug`, naming `label`.
 */
export function mintHostOwnedDir(root: string, prefix: string, label: string, debug?: (line: string) => void): string {
  const removed = sweepHostOwnedDirs(root, prefix);
  if (removed.length > 0) {
    debug?.(`[host dirs] F1.654: removed ${removed.length} ${label} left under ${root} by a host process that is no longer running: ${removed.join(', ')}`);
  }
  return mkdtempSync(join(root, `${prefix}${process.pid}-`));
}

/**
 * F1.1074 (DN-273, 2026-09-29) — a codex session's rollouts outlive the runtime build, so a rebuild resumes its
 * thread. Every build after a session's first (an app restart, the idle-agent reaper, a live-agent-ceiling eviction,
 * any `disposeManagedAgentRuntime`) mints a fresh `CODEX_HOME` and removes the old one, and P6.649 resumes by thread
 * id alone, so `thread/resume` answered `no rollout found for thread id …` and the model lost the conversation.
 *
 * Native first, asked and measured on the shipped `codex-app-server` 0.156.1
 * (`codex-resume-after-rebuild-live.test.ts`): codex's own experimental `thread/resume.path`, naming the old rollout
 * outside the running home, is refused with the same sentence; a fresh home whose `sessions/` holds the old tree
 * resumes by id and the model sees the earlier turn (codex's `read_thread` falls back to searching THIS home's
 * `sessions/` when its state DB has no row). So the host keeps that one subtree per session and links it in: each
 * build's home gets `sessions -> <root>/nessy-codex-sessions-<workspace>--<session>/` (0700, beside the homes, so
 * F1.652's "outside every agent-writable root" holds for it too). The teardown's `rmSync` of the home unlinks the
 * link and leaves the tree (measured); F1.681's sweep matches only `nessy-codex-home-<pid>-`. The tree goes with the
 * session ({@link removeCodexKeptSessions}, from `SessionManager.deleteSession`) — the lifetime claude's own
 * transcript already has (C3.311, `deleteClaudeVendorSession`).
 *
 * F1.1076 — a BRANCH is a new session with its own tree, so codex's `thread/fork` by the PARENT's thread id found
 * no rollout (measured: `threadForkFailed`, and the model saw none of the parent's turn). The child's build therefore
 * seeds its tree with a copy of the parent session's rollout of that one thread ({@link seedCodexBranchRollout}) — a
 * copy, not a link, because the parent keeps appending to its own.
 *
 * Residue, stated: the `$TMPDIR` fallback home keeps nothing (resume there fails as before, with the notice); every
 * re-fork's rollout is kept until the session is deleted; a session deleted by a path that does not reach
 * `deleteSession` leaves its tree.
 */
export const CODEX_KEPT_SESSIONS_PREFIX = 'nessy-codex-sessions-';

/** Ids are reduced to a safe file-name alphabet; the replacement is idempotent. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The kept tree's directory name for one host session; ids are reduced to a safe file-name alphabet. */
export function codexKeptSessionsDirName(workspaceId: string, sessionId: string): string {
  return `${CODEX_KEPT_SESSIONS_PREFIX}${safeId(workspaceId)}--${safeId(sessionId)}`;
}

/**
 * F1.1181 — the link's type. A Windows `'dir'` symlink needs SeCreateSymbolicLinkPrivilege or Developer Mode, so for an
 * ordinary user it threw EPERM and the session kept nothing (resume and branch forking failed as before F1.1074/F1.1076).
 * A junction needs neither; Node's `fs.symlink`: "Windows junction points require the destination path to be absolute",
 * and `kept` is. The type is ignored off Windows. Residue, stated: not measured on Windows (no runner builds it today).
 */
export function codexKeptSessionsLinkType(platform: NodeJS.Platform = process.platform): 'junction' | 'dir' {
  return platform === 'win32' ? 'junction' : 'dir';
}

/**
 * Links `<home>/sessions` to this session's kept tree under `root` (created 0700 when absent), and returns the tree,
 * or `null` — no session key, or a failure, which `debug` names — in which case the home keeps codex's own
 * `sessions/` and a later rebuild cannot resume from it. A kept path that is not a real directory is refused.
 */
export function linkCodexKeptSessions(
  home: string,
  root: string,
  key: { workspaceId?: string; sessionId?: string; branchFrom?: CodexBranchAnchor },
  debug?: (line: string) => void,
): string | null {
  if (!key.workspaceId || !key.sessionId) return null;
  const kept = join(root, codexKeptSessionsDirName(key.workspaceId, key.sessionId));
  try {
    mkdirSync(kept, { recursive: true, mode: 0o700 });
    if (!lstatSync(kept).isDirectory()) throw new Error(`${kept} is not a directory`);
    chmodSync(kept, 0o700);
    symlinkSync(kept, join(home, 'sessions'), codexKeptSessionsLinkType()); // F1.1181 — a junction on Windows
    seedCodexBranchRollout(kept, root, key.branchFrom, debug); // F1.1076
    return kept;
  } catch (error) {
    debug?.(`[codex home] F1.1074: this session's rollouts could not be kept beside its home (${error instanceof Error ? error.message : String(error)}), so the next runtime build cannot resume its codex thread`);
    return null;
  }
}

/** Removes one host session's kept tree (session deletion). Never throws; `false` when a removal failed. */
export function removeCodexKeptSessions(workspaceId: string, sessionId: string, root: string = join(CONFIG_DIR, 'codex-home')): boolean {
  try {
    rmSync(join(root, codexKeptSessionsDirName(workspaceId, sessionId)), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

/**
 * F1.1272 — the ONE kept tree a moved or fork-imported session's id names under `root`, or null:
 * no match (a cross-server import — the origin tree lives on the exporting host), or two or more
 * (the id names trees in several workspaces; picking one would be a guess). The workspace segment
 * answers in the tree name's OWN spelling of the workspace id ({@link safeId} — the replacement
 * is idempotent, and {@link codexKeptSessionsDirName} re-encodes it identically).
 */
export function findCodexKeptSessionsWorkspace(
  sessionId: string,
  root: string = join(CONFIG_DIR, 'codex-home'),
): { workspaceSegment: string; name: string } | null {
  const suffix = `--${safeId(sessionId)}`;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const matches = names.filter(name => name.startsWith(CODEX_KEPT_SESSIONS_PREFIX) && name.endsWith(suffix));
  if (matches.length !== 1) return null;
  const name = matches[0]!;
  return { workspaceSegment: name.slice(CODEX_KEPT_SESSIONS_PREFIX.length, name.length - suffix.length), name };
}

/**
 * F1.1272 — a MOVE's carry: renames the single kept tree the session id names to the target
 * workspace's key, so the next build's `sessions -> kept` link (F1.1074) finds the rollouts and
 * `thread/resume` by the stored thread id works instead of showing the resume-failed notice.
 * Refused, leaving today's behaviour standing: a tree already at the target key (a return move —
 * it is already the right tree), more or fewer than one source tree
 * ({@link findCodexKeptSessionsWorkspace}), or a rename that throws. A SHARED id is the caller's
 * refusal (`importSession` knows the live sessions; a live session holding the same id in another
 * workspace keeps its tree): this function deliberately does not read them.
 */
export function carryCodexKeptSessions(
  targetWorkspaceId: string,
  sessionId: string,
  root: string = join(CONFIG_DIR, 'codex-home'),
): 'carried' | 'target-exists' | 'not-found' | 'ambiguous' | 'failed' {
  const target = codexKeptSessionsDirName(targetWorkspaceId, sessionId);
  if (existsSync(join(root, target))) return 'target-exists';
  const found = findCodexKeptSessionsWorkspace(sessionId, root);
  if (!found) return 'not-found';
  try {
    renameSync(join(root, found.name), join(root, target));
    return 'carried';
  } catch {
    return 'failed';
  }
}

/** F1.1076 — the part of a session's `branchFrom` (P6.102) that names the parent session and its codex thread. */
export interface CodexBranchAnchor {
  readonly parent?: { readonly workspaceId?: string; readonly sessionId?: string };
  readonly sdkSessionId?: string;
}

/**
 * F1.1076 — copies the parent session's kept rollout(s) of the branched thread (`rollout-…-<thread id>.jsonl`, codex's
 * own name, at the same relative path) into the child's tree, so the child's `thread/fork` by that id finds it.
 * A file the child already has is left alone, so a later build copies nothing. Never throws; a parent folder holding
 * no rollout of that thread is said through `debug` (the fork then answers `no rollout found`, as before).
 */
export function seedCodexBranchRollout(kept: string, root: string, branch: CodexBranchAnchor | undefined, debug?: (line: string) => void): number {
  const threadId = branch?.sdkSessionId;
  if (!branch?.parent?.workspaceId || !branch.parent.sessionId || !threadId) return 0;
  const parent = join(root, codexKeptSessionsDirName(branch.parent.workspaceId, branch.parent.sessionId));
  if (parent === kept) return 0;
  const needle = `-${threadId}.jsonl`;
  let copied = 0;
  let found = 0;
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.includes(needle)) {
        found += 1;
        const target = join(kept, relPath);
        if (existsSync(target)) continue;
        try {
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          copyFileSync(join(dir, entry.name), target);
          copied += 1;
        } catch (error) {
          debug?.(`[codex home] F1.1076: could not copy the parent's rollout ${relPath} into this branch (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  };
  walk(parent, '');
  if (found === 0) debug?.(`[codex home] F1.1076: the parent session's kept folder holds no rollout of thread ${threadId}, so this branch's fork cannot find it`);
  return copied;
}
