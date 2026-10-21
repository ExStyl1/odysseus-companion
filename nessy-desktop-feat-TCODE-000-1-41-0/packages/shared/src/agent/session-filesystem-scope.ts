/**
 * P4: one provider-neutral captured filesystem authority per session
 * (plan deleted at release 1.2.0; recover with
 * `git show 4d038f04^:docs/current-plans/project-local-nessy-agent-and-workspace-roots.md`).
 *
 * A session has exactly ONE primary root: the selected project's canonical
 * path, or the managed Workspace root only when the session has no project.
 * Every read/write/shell path decision flows through `resolveScopedPath`
 * against this captured scope — no backend reconstructs roots from strings.
 * Managed Nessy storage stays excluded even under a broad approved parent.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SOURCE_CREDENTIAL_CACHE_FILENAME } from '../sources/credential-cache.ts';

export type ScopedPathAccess = 'read' | 'write';

export interface SessionFilesystemScopeRoot {
  canonicalRoot: string;
  access: ScopedPathAccess;
  receiptId: string;
  expires: 'request' | 'session';
}

/**
 * A managed-storage subtree the documented agent-authoring flows may reach
 * despite the blanket managed exclusion. `access: 'read'` grants read-only
 * (agent-facing docs); `access: 'write'` grants read+write (the session
 * workspace's own source configs). Per-source credential caches stay blocked even inside a writable allowance.
 */
export interface SessionFilesystemScopeManagedAllowance {
  canonicalRoot: string;
  access: ScopedPathAccess;
  exceptSessionRecords?: boolean; // F1.1046: the root itself and the session's records are not covered ({@link ownSessionFolderAllowances})
}

export interface SessionFilesystemScope {
  session: { workspaceId: string; sessionId: string };
  projectKey?: string;
  /** Canonical project path, or managed Workspace root for no-project sessions. */
  primaryRoot: string;
  cwd: string;
  additionalRoots: SessionFilesystemScopeRoot[];
  /** Managed Nessy storage roots always denied to generic file tools. */
  managedExclusions: string[];
  /**
   * Managed-storage subtrees the documented agent-authoring flows reach through
   * the normal file tools (agent docs read-only, the session workspace's own
   * `sources/` read+write). Evaluated before `managedExclusions` so they
   * override the blanket denial for exactly these paths.
   */
  managedAllowances?: SessionFilesystemScopeManagedAllowance[];
  /** Canonical system temp roots writable without approval (production opt-in). */
  systemTempRoots?: string[];
  generation: string;
}

/** Structured outside-root signal: drives one approval request, no side effect. */
export class OutsideRootError extends Error {
  override readonly name = 'OutsideRootError';

  constructor(
    readonly canonicalTarget: string,
    readonly requestedAccess: ScopedPathAccess,
  ) {
    super(`Path is outside the session filesystem scope: ${canonicalTarget}`);
  }
}

/** Managed storage is never a generic tool root, even inside an approved parent — in EVERY mode, acceptEdits included, for a session that HAS a project; a no-project session writes its own Workspace root (F1.140/F1.763: the note at this file's end). */
export class ManagedRootDeniedError extends Error {
  override readonly name = 'ManagedRootDeniedError';

  constructor(readonly canonicalTarget: string) {
    super(`Managed Nessy storage is not accessible to file tools: ${canonicalTarget}`);
  }
}

/**
 * Git metadata is read-only for file tools: writing hooks/config inside `.git`
 * is arbitrary code execution on the next git operation. Approval cannot
 * broaden this; git itself (via shell) remains the only writer.
 */
export class GitMetadataDeniedError extends Error {
  override readonly name = 'GitMetadataDeniedError';

  constructor(readonly canonicalTarget: string) {
    super(`Git metadata is read-only for file tools: ${canonicalTarget}`);
  }
}

/**
 * Project agent configuration is read-only for file tools (Codex `.codex`/
 * `.agents` parity): an agent must not rewrite its own trusted config, hooks
 * or skills. Humans edit these; approval cannot broaden this.
 */
export class AgentConfigDeniedError extends Error {
  override readonly name = 'AgentConfigDeniedError';

  constructor(readonly canonicalTarget: string) {
    super(`Project agent configuration is read-only for file tools: ${canonicalTarget}`);
  }
}

// `.codex` is codex's own project config root — the docstring above has named
// it since this floor was written, and it was missing from the list until
// P6.195. It is protected on ALL runtimes, not only codex: the floor is
// host-side and a Pi or claude session must not rewrite a codex config
// either. Our own projection writes into `CODEX_HOME`, never `<repo>/.codex`,
// so nothing of ours is refused by this entry.
export const AGENT_CONFIG_DIRS = ['.nessy-agent', '.agents', '.codex'];

/**
 * The same directories, as the SHELL gate's write-side subject — C3.353.
 *
 * ## What was measured (rig day R2, packaged 1.36.0, HEAD `70d269e46`)
 *
 * The floor above is FILE-TOOL-SCOPED, and the agent walked around it with one
 * `Bash` call: `/bin/zsh -lc "mkdir -p <repo>/.codex/rules && printf
 * 'prefix_rule(…)' > <repo>/.codex/rules/x.rules"` wrote the file with **no
 * permission card and no floor sentence**, and codex then ENFORCED the rule it
 * had just written — the refusal two messages later quoted that file's own
 * justification string. Re-confirmed at HEAD before this list existed:
 * `findNonNegotiableFloors('Write', {file_path:'<r>/.codex/rules/a'}, 'default')`
 * returns the `protectedPath` floor while the same path written by `Bash` —
 * plain redirect, the nested `zsh -lc` shape, or `cp` — returns no floor at all,
 * with `ls -la` as the negative control. `apps/electron/resources/permissions/default.json`
 * names none of these directories in `deniedPaths` (`grep -c codex` → 0), so
 * nothing else on the shell path was gating them either.
 *
 * ## Native mechanism, and why the host is the seam anyway
 *
 * Codex HAS its own protection for exactly these names, read at the shipped
 * tag `rust-v0.150.1` (`codex-rs/protocol/src/permissions.rs`,
 * `default_read_only_subpaths_for_writable_root`; `codex-rs/protocol/src/protocol.rs`,
 * `WritableRoot::is_path_writable`): `<root>/.git`, `<root>/.agents` and
 * `<root>/.codex` are READ-ONLY SUBPATHS of a writable root, `.codex` on the
 * workspace root being protected *"even before the directory exists so
 * first-time creation still goes through the protected-path approval flow"*.
 * It is INERT in this product: those carveouts hang off the `WorkspaceWrite` /
 * restricted filesystem policy, and with the sandbox master switch off — the
 * shipped default and a standing owner decision —
 * `codexSandboxConfigForMode` (`codex-responses-adapter/src/config-writer.ts`)
 * emits `sandbox_mode: 'danger-full-access'`, which carries no writable-root
 * carveouts at all. So step 1 of native-first exists and is switched off by a
 * product posture; step 2, the host, is where the gate has to live, and it is
 * host-side for all three runtimes rather than codex-only for the same reason
 * the comment above gives.
 *
 * ## Why `.claude` is here and NOT in {@link AGENT_CONFIG_DIRS}
 *
 * The file-tool path gates these directories at TWO tiers: this file's
 * {@link AgentConfigDeniedError} is a hard refusal approval cannot broaden, and
 * `pi-harness/protected-paths.ts`'s `PROTECTED_DIRECTORIES` is the ask-or-refuse
 * floor (`protectedPathOutcome`) — and that second list carries `.claude`, the
 * project config of the runtime whose documentation this fork treats as its
 * contract, as well as these three. The shell gate takes the SECOND posture for
 * all four: ask or refuse per the mode, never the hard refusal, because that is
 * the posture the row asks for and because a shell is how a human deliberately
 * edits one of these files through the agent. Adding `.claude` to
 * {@link AGENT_CONFIG_DIRS} instead would change the FILE-tool answer for
 * `.claude` from a prompt into a refusal, which is a different row.
 */
export const SHELL_GATED_AGENT_CONFIG_DIRS: readonly string[] = [...AGENT_CONFIG_DIRS, '.claude'];

/**
 * The agent-config directory {@link SHELL_GATED_AGENT_CONFIG_DIRS} names inside
 * `target`, or null.
 *
 * SEGMENT matching, not path resolution, for the reason `protected-paths.ts`
 * records for its own list: the shell gate runs where there is no cwd to resolve
 * against, so `.codex/rules/x`, `<repo>/.codex/rules/x`, `~/.codex/rules/x` and
 * an unexpanded `$HOME/.codex/rules/x` must all match — and they do, because the
 * match is on a segment rather than on a resolved prefix. Every entry is a
 * SINGLE segment (unlike `protected-paths.ts`'s `.config/git`), which is what
 * makes a plain membership test sufficient here.
 */
export function agentConfigDirectoryInPath(target: string): string | null {
  const segments = target.split(/[/\\]+/);
  for (const dir of SHELL_GATED_AGENT_CONFIG_DIRS) {
    if (segments.includes(dir)) return dir;
  }
  return null;
}

function isAgentConfigPath(candidate: string, rootPath: string): boolean {
  return AGENT_CONFIG_DIRS.some(dir => isInsideOrEqual(candidate, resolve(rootPath, dir)));
}

/**
 * True when `candidate` falls inside `<root>/.git` — as a directory, as the
 * pointer file itself, or inside the resolved `gitdir:` target of that pointer
 * (worktrees/submodule layouts).
 */
function isGitMetadataPath(candidate: string, rootPath: string): boolean {
  const gitPath = resolve(rootPath, '.git');
  if (isInsideOrEqual(candidate, gitPath)) return true;
  try {
    if (!existsSync(gitPath) || !statSync(gitPath).isFile()) return false;
    const pointer = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitPath, 'utf8').slice(0, 4096));
    if (!pointer?.[1]) return false;
    return isInsideOrEqual(candidate, canonicalizeForDecision(resolve(rootPath, pointer[1])));
  } catch {
    return false;
  }
}

export function isInsideOrEqual(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(sep) && !isAbsolute(relativePath));
}

/**
 * Canonicalize an existing path, or the nearest existing parent for paths
 * being created; the missing tail is re-appended lexically. Called immediately
 * before effect so symlink/rename races are closed at decision time.
 *
 * **A49 · "at decision time" is the whole of what this closes, and on claude the
 * EFFECT is not ours (recorded 2026-09-11, owner answer QA9=C).** This runs when
 * the permission decision is taken; the file is opened afterwards, and on the
 * claude runtime it is opened by the SDK, which owns tool execution. A link
 * replaced in between is therefore the vendor's re-check to make, not ours — and
 * `errors.md#refusing-after-a-symlink-changed` says when it makes it: *"Before
 * v2.1.251, Claude Code re-checked a path's resolution only for file writes, so
 * a link replaced after the permission check could redirect a read or search to
 * a different location without a message. Of these refusals, only the
 * parent-directory write refusal appears on earlier versions."* The vendored
 * bundle self-reports `2.1.247` on both probes, so the read and search halves
 * are not there yet.
 *
 * The refusal is therefore a VERSION, not a posture, and it is pinned as one
 * rather than left in this paragraph to rot: `__tests__/claude-bundle-version-triggers.test.ts`
 * goes red in the commit that lifts the bundle to 2.1.251 or past it, and says
 * what to measure and which ledger cell to re-stamp. On Pi and codex the refusal
 * IS a posture — our gate hands an approved path to the runtime's own file
 * tools, and a host-side re-check here would be a second resolver rather than a
 * fix.
 */
export function canonicalizeForDecision(absolutePath: string): string {
  let base = absolutePath;
  const tail: string[] = [];
  while (!existsSync(base)) {
    const parent = dirname(base);
    if (parent === base) break;
    tail.unshift(base.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    base = parent;
  }
  let canonicalBase: string;
  try {
    canonicalBase = realpathSync(base);
  } catch {
    canonicalBase = resolve(base);
  }
  return tail.length ? resolve(canonicalBase, ...tail) : canonicalBase;
}

export interface ResolveScopedPathOptions {
  access?: ScopedPathAccess;
}

/** Write-protect git metadata and agent configuration inside an allowed root. */
function assertWritableInsideRoot(candidate: string, rootPath: string, access: ScopedPathAccess): void {
  if (access !== 'write') return;
  if (isGitMetadataPath(candidate, rootPath)) throw new GitMetadataDeniedError(candidate);
  if (isAgentConfigPath(candidate, rootPath)) throw new AgentConfigDeniedError(candidate);
}

/**
 * Resolve `inputPath` (relative paths against scope.cwd) to a canonical
 * absolute path authorized by the captured scope.
 *
 * - inside `primaryRoot` → allowed for read and write;
 * - inside an additional root → allowed per that root's access (write includes
 *   read; read never implies write);
 * - managed exclusions are denied regardless of any containing approval;
 * - anything else raises a structured `OutsideRootError` (no side effect).
 */
export function resolveScopedPath(
  inputPath: string | undefined,
  scope: SessionFilesystemScope,
  options: ResolveScopedPathOptions = {},
): string {
  const access = options.access ?? 'read';
  const cwd = canonicalizeForDecision(resolve(scope.cwd || scope.primaryRoot));
  const candidate = canonicalizeForDecision(resolve(cwd, inputPath || '.'));

  // The primary root wins first: a no-project session's managed Workspace root
  // legitimately lives under the managed config dir. Everything else inside a
  // managed exclusion is denied even under a broad approved parent.
  const primaryRoot = canonicalizeForDecision(resolve(scope.primaryRoot));
  if (isInsideOrEqual(candidate, primaryRoot)) {
    assertWritableInsideRoot(candidate, scope.primaryRoot, access);
    // F1.702 — but not over a data folder the PROJECT contains (a relocated NESSY_CONFIG_DIR inside it): a write
    // there meets the allowances and the managed exclusion below, as from any other project. A data folder that
    // contains the primary root (a no-project session's managed Workspace root) is not "inside" it, so that
    // session keeps its root. Reads are unchanged — the residue: the project's own reads of that folder pass.
    const nestedExclusion = access === 'write' && scope.managedExclusions.some(exclusion => {
      const canonicalExclusion = canonicalizeForDecision(resolve(exclusion));
      return !isInsideOrEqual(primaryRoot, canonicalExclusion) && isInsideOrEqual(candidate, canonicalExclusion);
    });
    if (!nestedExclusion) return candidate;
  }

  // The documented agent-authoring flows (system prompt source setup +
  // /create-skill's normal-Write mechanism) reach specific managed subtrees:
  // agent docs are read-only reference material, and the session workspace's
  // own `sources/` is read+write for config.json/guide.md/permissions.json.
  // These are checked before the managed exclusion so they override the blanket
  // denial — but a per-source credential cache (a decrypted secret) is never a
  // tool target, so it falls through to the managed denial below.
  for (const allowance of scope.managedAllowances ?? []) {
    if (!isInsideOrEqual(candidate, canonicalizeForDecision(resolve(allowance.canonicalRoot)))) continue;
    if (basename(candidate) === SOURCE_CREDENTIAL_CACHE_FILENAME) continue;
    if (access !== 'read' && allowance.access !== 'write') continue;
    if (allowance.exceptSessionRecords && !ownSessionWorkingPath(candidate, canonicalizeForDecision(resolve(allowance.canonicalRoot)))) continue;
    return candidate;
  }

  for (const exclusion of scope.managedExclusions) {
    if (isInsideOrEqual(candidate, canonicalizeForDecision(resolve(exclusion)))) {
      throw new ManagedRootDeniedError(candidate);
    }
  }

  for (const tempRoot of scope.systemTempRoots ?? []) {
    if (isInsideOrEqual(candidate, tempRoot)) return candidate;
  }

  for (const root of scope.additionalRoots) {
    if (!isInsideOrEqual(candidate, root.canonicalRoot)) continue;
    if (access !== 'read' && root.access !== 'write') continue;
    assertWritableInsideRoot(candidate, root.canonicalRoot, access);
    return candidate;
  }

  throw new OutsideRootError(candidate, access);
}

/** The cwd itself must live inside the primary root or an approved root. */
export function assertScopeCwdAuthorized(scope: SessionFilesystemScope): void {
  const cwd = canonicalizeForDecision(resolve(scope.cwd || scope.primaryRoot));
  if (isInsideOrEqual(cwd, canonicalizeForDecision(resolve(scope.primaryRoot)))) return;
  if (scope.additionalRoots.some(root => isInsideOrEqual(cwd, root.canonicalRoot))) return;
  throw new OutsideRootError(cwd, 'read');
}

export interface BuildSessionFilesystemScopeOptions {
  workspaceId: string;
  sessionId: string;
  projectKey?: string;
  /** Canonical project path when a project is selected. */
  projectCanonicalPath?: string;
  /** Managed Workspace root: the fallback primary root for no-project sessions. */
  workspaceRootPath: string;
  workingDirectory?: string;
  /** Managed application root (CONFIG_DIR); covers workspaces/sessions/plugins/credentials. */
  managedConfigDir: string;
  additionalRoots?: SessionFilesystemScopeRoot[];
  /** Allow canonical `$TMPDIR`/`/tmp` writes without approval (Codex parity). */
  includeSystemTempRoots?: boolean;
  generation?: string;
}

function canonicalSystemTempRoots(): string[] {
  const roots = new Set<string>();
  for (const raw of [tmpdir(), '/tmp']) {
    try {
      roots.add(realpathSync(raw));
    } catch {
      // missing temp root on this platform — skip
    }
  }
  return [...roots];
}

export function buildSessionFilesystemScope(
  options: BuildSessionFilesystemScopeOptions,
): SessionFilesystemScope {
  const primaryRoot = options.projectCanonicalPath ?? options.workspaceRootPath;
  // Shallow freeze is deliberate: identity/root fields are immutable while
  // `additionalRoots` stays a live array so a session-lifetime approval can
  // join the running scope (LocalToolRuntime.scopedPath).
  return Object.freeze({
    session: { workspaceId: options.workspaceId, sessionId: options.sessionId },
    ...(options.projectKey ? { projectKey: options.projectKey } : {}),
    primaryRoot,
    cwd: options.workingDirectory ?? primaryRoot,
    additionalRoots: [...(options.additionalRoots ?? [])],
    // Managed Nessy storage is always excluded; the primary root itself is
    // checked first in resolveScopedPath, so a no-project session keeps its
    // managed Workspace root while sibling managed state stays unreachable.
    managedExclusions: [options.managedConfigDir],
    // Narrow re-openings of managed storage for the documented agent flows:
    // agent-facing docs the system prompt points at (read-only), and this
    // workspace's own `sources/` (read+write). Derived from workspaceRootPath so
    // other workspaces' sources — and every other managed path — stay excluded.
    managedAllowances: [
      { canonicalRoot: join(options.managedConfigDir, 'docs'), access: 'read' },
      { canonicalRoot: join(options.workspaceRootPath, 'sources'), access: 'write' },
      // /create-skill authors ~/.nessy-agent/skills/<slug>/ through the same
      // normal permission-gated Write path (CREATE_SKILL_SKILLS_ROOT).
      { canonicalRoot: join(options.managedConfigDir, 'skills'), access: 'write' },
      // F1.725 / F1.1046 — this session's OWN folder: read+write (plans, data,
      // the scratch `job/`, downloads — the mode gate decides which modes may)
      // minus its records; `attachments/` holds the files the user attached,
      // whose stored path is all the prompt carries, and `long_responses/` the
      // results the large-result preview points at (F1.1062) — read-only.
      // Another session's folder stays excluded.
      ...ownSessionFolderAllowances(options.managedConfigDir, options.workspaceId, options.sessionId),
    ],
    ...(options.includeSystemTempRoots ? { systemTempRoots: canonicalSystemTempRoots() } : {}),
    generation: options.generation ?? '',
  }) as SessionFilesystemScope;
}

/*
 * F1.140 — what the managed-storage floor ({@link ManagedRootDeniedError}) means for a reader
 * scoring a live case.
 *
 * The floor is enforced HERE, in the one scope every Pi file tool resolves through (and the
 * cloud agent's executor). Claude's file tools are the SDK's own and never pass through it,
 * and codex writes under its own sandbox profile. So "write a file under the managed
 * Workspace root in acceptEdits → no card" is TRUE on claude and FALSE on Pi, where the write
 * is refused with "Managed Nessy storage is not accessible to file tools" — in every mode,
 * not because acceptEdits changed. F1.763 (SIT-c A18, 2026-09-25, packaged from `5896a66d2`) —
 * the clause holds only for a session that HAS a project: a no-project session's primary root
 * IS the managed Workspace root (`primaryRoot = projectCanonicalPath ?? workspaceRootPath`,
 * `buildSessionFilesystemScope` above), and `resolveScopedPath` returns it before the managed
 * exclusion runs, so the same write in the session's OWN Workspace root succeeds — pinned by
 * "CONTROL: a no-project session writes its own managed workspace"
 * (`session-filesystem-scope.test.ts`). Measured at SIT-10 (2026-09-20, packaged 1.40.0): the D1.438
 * control "a Write to any other workspace file in acceptEdits is still allowed" passed on
 * claude-runtime and was refused on Pi by this floor, in the tree since at least 2026-07-19
 * (`managedExclusions` is the managed config dir, set in `buildSessionFilesystemScope` above).
 *
 * The discriminator is the RUNTIME and the refusal's own sentence, never the mode: D1.438's
 * refusal names Settings > Permissions ("Direct ... operations"), this one names managed
 * storage. A Pi refusal carrying this sentence on a file other than `permissions.json` /
 * `automations.json` is the floor working, not a D1.438 regression. The managed allowances
 * (`managedAllowances` in `buildSessionFilesystemScope` above, own-session folders included,
 * {@link ownSessionFolderAllowances}) are the only managed paths a Pi file tool reaches.
 */

/**
 * F1.725 (WJ-crit-u, 2026-09-25) — this session's OWN storage folder under the data
 * folder, `<managedConfigDir>/sessions/<workspaceId>/<sessionId>` (the global v2
 * layout `sessions/storage.ts` `getSessionDirPath` writes), or `undefined` when
 * either id is not a plain storage id — fail closed, no allowance.
 *
 * MEASURED (release sittings SIT-i, SIT-d, 2026-09-25): the managed exclusion
 * covered it whole, so Pi's file tools refused the session's own plan file in every
 * mode ("Managed Nessy storage is not accessible to file tools: …/plans/…"), which
 * left SubmitPlan nothing to submit, and refused the Read of the user's own
 * attachment. Shared with the protected-path carve-out in `core/pre-tool-use.ts`
 * (`ownSessionPlanFileWrite`), so both answer for the same folder.
 */
export function ownSessionStorageDir(managedConfigDir: string, workspaceId: string, sessionId: string): string | undefined {
  const plainId = (id: string) => /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
  if (!plainId(workspaceId) || !plainId(sessionId)) return undefined;
  return join(managedConfigDir, 'sessions', workspaceId, sessionId);
}

/**
 * F1.725 — the session's own `plans/` (read+write) and `attachments/` (read-only); none when the ids are not plain.
 * F1.917 (DN-235) then opened its scratch folder `job/tmp/` (P6.535, `$CLAUDE_JOB_DIR/tmp`).
 *
 * F1.1046 (DN-245, 2026-09-28; decided under the owner-delegated rule, DECISIONS-2 Q13) — the WHOLE own folder,
 * read+write, minus the folder itself and its records ({@link isOwnSessionRecordName}): the same set F1.703's
 * protected-path carve-out answers for (`ownSessionWorkingFolderWrite` in `core/pre-tool-use.ts`, which reads the same
 * predicate); codex writes the plans and data folders since F1.1003. Measured before, on both data-folder layouts: an explore Write of
 * `<session>/data/findings.md` met no card at the gate and then Pi's Write refused it as managed storage, so explore's
 * data-folder exception could never succeed on Pi (F1.762, `session-plan-file-write.test.ts`); the same refusal met
 * `downloads/`, the rest of `job/` and a file at the folder's root. The allowance is matched on the canonical path, so a
 * symlink inside it is judged where it lands (another session, a record).
 *
 * F1.1062 (DN-247, 2026-09-28) — two records are re-opened READ-ONLY because the host itself points the model at a
 * file inside them: `attachments/` (F1.725, the stored path is all the prompt carries) and `long_responses/`, whose
 * large-result preview (`formatLargeResponseMessage`, `utils/large-response.ts`) names the saved file and says "Use
 * Read/Grep to access specific content". Measured before: Pi's Read of that file was refused as managed storage, while
 * the gate allows it in every mode (`session-working-folder-floor.test.ts`), so claude's hook answers
 * `permissionDecision: 'allow'`, which skips the SDK's own prompt. The other records stay unread on Pi, as
 * `session.jsonl` is — nothing points the model at them; claude reads them, since the gate floors writes only (the
 * residue, named).
 */
function ownSessionFolderAllowances(managedConfigDir: string, workspaceId: string, sessionId: string): SessionFilesystemScopeManagedAllowance[] {
  const own = ownSessionStorageDir(managedConfigDir, workspaceId, sessionId);
  if (!own) return [];
  return [
    { canonicalRoot: own, access: 'write', exceptSessionRecords: true },
    { canonicalRoot: join(own, 'attachments'), access: 'read' },
    { canonicalRoot: join(own, 'long_responses'), access: 'read' },
  ];
}

// The records other than `session.jsonl`, lower-cased ({@link isOwnSessionRecordName}).
const OWN_SESSION_RECORD_NAMES: ReadonlySet<string> = new Set([
  'attachments', 'long_responses', '.pi-carry', 'checkout-move.patch',
  // F1.1174 (DN-291) — the other host and runtime records in the same folder.
  '.pi-sessions', '.pi-agent', '.orchestrator', 'meta', 'hook-env', 'file_checkpoints',
  'tool-metadata.json', 'tool-metadata.json.tmp', 'api-error.json',
]);

/**
 * F1.1046 — the session's own records, by the first segment of a path inside its folder: `session.jsonl` (and the
 * siblings an atomic write leaves, `session.jsonl.tmp`), the user's `attachments` and the host's `long_responses`.
 * F1.1062 (DN-247) adds `.pi-carry/` (Pi's carried history, `PI_CARRY_DIRNAME` in `pi-session-rebuild.ts`) and
 * `checkout-move.patch` (the patch a checkout move travels through, `CHECKOUT_MOVE_PATCH_BASENAME` in server-core's
 * `checkout-move-plan.ts`); a test pins both producers' constants.
 * F1.1174 (DN-291, 2026-09-29) — those were not "the two other files the host writes there": the folder also holds
 * Pi's resumable transcript `.pi-sessions/` (`continueRecent` resumes its newest file) and `.pi-agent/`
 * (pi-agent-server's `index.ts`), the workflow journal `.orchestrator/` (replayed on resume, `orchestrator/journal.ts`),
 * the host's fork and resume anchors `meta/` (SessionManager's `*-turn-anchors.json`, nestor-cloud's
 * `context-store.ts`), the hook env file `hook-env/` (sourced before every later Bash command, `hook-env-file.ts`), the
 * rewind snapshots `file_checkpoints/` (`sessions/file-checkpoints.ts`) and the interceptor's `tool-metadata.json` and
 * `api-error.json` (`interceptor-common.ts`). Measured before: a Write of each met no floor at the gate (allow in
 * acceptEdits and auto with the session folder as cwd) and resolved in Pi's scope. Each producer spells its name as a
 * literal, so a test reads the producer's own line. Still open on purpose: `plans/`, `data/`, `downloads/`, `job/`,
 * the resize scratch `tmp/`, the user's `notes.md` and any other file a no-project session creates in its cwd.
 * Case-insensitive, as the default macOS volume is. The one list both layers read, so they cannot drift: Pi's scope
 * (above) and the protected-path carve-out (`ownSessionWorkingFolderWrite`, F1.703).
 */
export function isOwnSessionRecordName(firstSegment: string): boolean {
  const name = firstSegment.toLowerCase();
  return name.startsWith('session.jsonl') || OWN_SESSION_RECORD_NAMES.has(name);
}

/** Inside the own folder (already checked), below it, and not under one of its records. */
function ownSessionWorkingPath(candidate: string, ownRoot: string): boolean {
  const first = relative(ownRoot, candidate).split(/[/\\]/)[0] ?? '';
  return first.length > 0 && !isOwnSessionRecordName(first);
}
