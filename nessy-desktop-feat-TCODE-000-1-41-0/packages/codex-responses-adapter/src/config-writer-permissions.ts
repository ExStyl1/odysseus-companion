/**
 * **P3.273 — the `[permissions.*]` floor, mapping and emission, in a file of
 * its own.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.273.
 * Nothing here is new: every declaration below was moved out of
 * `config-writer.ts` unchanged. The move is the point. Two wave-1 lanes were
 * given halves of that one file by SECTION, which works for READING and fails
 * for COMMITTING — `git commit <pathspec>` takes the file's whole working-tree
 * state, so the second lane to finish cannot land without carrying the first
 * lane's unfinished hunks. Whole files are the only zoning this tree can
 * enforce, so the credential floor gets one.
 *
 * The boundary is drawn where the concern is: everything that decides WHICH
 * paths codex is told to deny, and everything that writes the resulting
 * `[permissions.<profile>]` tables, lives here. What deliberately did NOT move
 * is `CODEX_PERMISSION_MODE_TABLE` in `config-writer.ts` — it maps a permission
 * MODE to `sandbox_mode`/`approval_policy`, two top-level scalars that are not
 * part of the `[permissions.*]` block — so a lane changing an approval policy
 * still holds `config-writer.ts`, and only a lane changing the floor holds this
 * file.
 *
 * This module is a leaf: it imports two TYPES from `config-writer.ts` (erased
 * at runtime) and the shared TOML escaper, and nothing else. The sandbox mode
 * arrives as a parameter rather than being derived here, which is what keeps
 * the dependency one-directional.
 *
 * ## P6.928 — the HOST'S READ FENCE IS DELIBERATELY NOT PROJECTED HERE
 *
 * Owner ruling 2026-09-10, by the balance rule, and written here because this is
 * the file a later reader would reach for to "finish" it. No code changed for
 * this note; it exists so the absence is legible where the mechanism lives.
 *
 * `permissions.blockReadsOutsideWorkingDirectories` is a host setting that binds
 * on Pi and claude: `getReadsOutsideWorkingDirectoriesViolation`
 * (`shared/agent/mode-manager.ts`) is reached from the two gates taking an
 * arbitrary tool name — `runPreToolUseChecks` and
 * `PermissionManager.checkPermission` — and both route those runtimes'
 * `Read`/`Grep`/`Glob`/`Find`/`Ls`. On codex it has NO SUBJECT: codex performs
 * those reads with its own built-ins inside the app-server and initiates no read
 * approval toward this client (`codex-protocol/generated/ServerRequest.ts`, ten
 * methods, of which the two approval members are the positive control and none
 * is a read), so a host gate would never see one.
 *
 * The only native carrier is the surface THIS file writes. `FileSystemAccessMode`
 * is a real three-value `read`/`write`/`deny` and `resolveCodexRuntimePathPolicy`
 * already emits a profile for every real session, so the fence IS expressible:
 * deny the whole filesystem, grant `read` back on the working roots. That is
 * what was refused. Such a profile also refuses toolchains, package caches,
 * `$HOME` and every path outside the project — none of which the fence is about
 * — and this writer emits DENY entries over a grant baseline rather than an
 * allowlist over a denied one, so the inversion is not a parameter here but a
 * different policy shape.
 *
 * So codex stays on its native mechanism, nothing is projected, and the
 * difference is made HONEST rather than uniform: the `readFence` row of
 * `RUNTIME_SWITCH_COSTS`
 * (`apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts`)
 * tells a user moving onto codex that the setting stops applying, and the Codex
 * section of `docs/architecture/runtime-capability-gaps.md` carries the row.
 * Reversing this needs the posture reversed first — it is a product decision
 * about what a codex session may read, not a gap in this file.
 */
import { isAbsolute, parse, resolve } from 'node:path';

import { tomlString } from './config-writer-toml.ts';
import type { CodexConfigOptions, CodexSandboxMode } from './config-writer.ts';

/**
 * The profile name every `[permissions.*]` table this writer opens is keyed by.
 *
 * P2.380 asked for a guard against colliding with a RESERVED codex profile id,
 * on the strength of a page naming `codex_security_scan`. Read at the source
 * (`openai/codex` @ `rust-v0.148.0`), the row's premise does not survive and the
 * real rule is both different and stricter:
 *
 *  - `codex_security_scan` appears **zero times** in the whole tree. Positive
 *    control on the same rig: `security_scan` DOES hit nine times (analytics and
 *    plugin-metrics fixtures), so the tree is being read.
 *  - The reserved namespace is a **prefix, not a name**.
 *    `core/src/config/permissions.rs::validate_user_permission_profile_names`
 *    rejects every `[permissions.<name>]` whose name starts with `:` —
 *    *"permissions profile `{profile_name}` uses a reserved built-in profile
 *    prefix"* — and the three built-ins are the colon-prefixed
 *    `:read-only` / `:workspace` / `:danger-full-access`
 *    (`protocol/src/models.rs:306-312`).
 *  - A collision is therefore **loud, not silent**: an `io::Error` at config
 *    load, not the quiet rebinding the row assumed.
 *
 * So the invariant worth pinning is this name staying OUT of the colon
 * namespace, which is what `config-writer-permission-profile-name.test.ts`
 * asserts. `extends` is the other side of the same rule and is already right:
 * {@link resolveCodexRuntimePathPolicy} emits `:read-only`/`:workspace`, WITH the
 * colon, because there it names a built-in rather than declaring one.
 */
export const NESSY_RUNTIME_PERMISSION_PROFILE = 'nessy_runtime';

/**
 * **P3.175 — our `deniedPaths` credential floor, translated into codex's own
 * `[permissions.<profile>.filesystem]` map and handed to it.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.175.
 *
 * ## Why this exists: the half the Claude SDK could not deliver
 *
 * Isolation is OFF by standing owner decision (2026-08-12/13), so `deniedPaths`
 * is the ONLY read-side credential protection a default install has. P3.147
 * handed that floor to the Claude SDK's own `permissions.deny`; P3.174 then
 * measured that the 2.1.223 binary shipped then denies the READ and still
 * returns the secret's line from `Grep` rooted one level above — reproduced at
 * 2.1.233 and 2.1.247, and repaired by the vendor at 2.1.251 (driven 2026-09-13,
 * C3.380). For the years in between, the vendor's page promised the exclusion and
 * the binary did not perform it; codex never had that gap, which is why this
 * module reads the way it does.
 *
 * **Codex's deny is OS-enforced rather than tool-mediated, and it closes that
 * half.** Measured on `rust-v0.148.0`, darwin-arm64 (macOS 26.6.2), one run,
 * four scenarios sharing one fixture — see
 * `__tests__/sandbox-enforcement.test.ts` §"search RESULTS":
 *
 * | Config | `cat <decoy>` | `grep -rn <secret>` one level above | `grep -rln` | `ls` the dir |
 * | --- | --- | --- | --- | --- |
 * | no profile (control) | leaks | **returns the line** | lists it | lists it |
 * | profile denies an UNRELATED path (control) | leaks | **returns the line** | lists it | lists it |
 * | deny the decoy FILE | refused | **nothing; `Operation not permitted`** | **not listed** | lists the name |
 * | deny the containing DIRECTORY | refused | **nothing** | **not listed** | **refused** |
 *
 * So on codex the RESULTS half closes for both deny shapes, and the DISCOVERY
 * half — the file's NAME — closes only for a directory-scoped deny. That is why
 * a `<dir>/**` entry below is mirrored as its CONTAINER rather than as a glob:
 * the container spelling is the one that also hides the name, and it is what our
 * own matcher already means by that pattern (`deniedContainerPattern`,
 * `mode-manager.ts`).
 *
 * ## What codex's map accepts — read at `rust-v0.148.0`, not from the page
 *
 * `codex-rs/config/src/permissions_toml.rs:224-244` — `FilesystemPermissionsToml`
 * is `glob_scan_max_depth` plus a flattened `BTreeMap<String, FilesystemPermissionToml>`,
 * and each value is either an access mode or a nested `BTreeMap` of subpaths.
 * `codex-rs/core/src/config/permissions.rs` compiles the keys:
 *
 * 1. **`~/` keys, expanded by codex ITSELF.** `parse_absolute_path_for_platform`
 *    (`:796`) admits a key that `is_absolute`, equals `~`, or starts with `~/`;
 *    `AbsolutePathBuf::from_absolute_path` (`codex-rs/utils/absolute-path/src/lib.rs:27-45`)
 *    then splices in `dirs::home_dir()` and joins with `PathBuf::join`, i.e. with
 *    the PLATFORM separator. **This sidesteps P3.108's entire defect class**: the
 *    ten `~/`-anchored entries that are inert on Windows in our own compiler
 *    (backslash-escaped pattern vs forward-slashed, lowercased candidate) are the
 *    exact ten this mirror hands to a matcher that never sees a pattern string.
 * 2. **Absolute keys**, verbatim.
 * 3. **Deny-only glob patterns.** `compile_filesystem_access_path` (`:569`) turns a
 *    key containing `* ? [ ]` into a `FileSystemPath::GlobPattern` only when the
 *    access is `deny`; `compile_read_write_glob_path` (`:676`) rejects the same
 *    shape for `read`/`write`. On macOS a deny glob becomes
 *    `(deny file-read* (regex …))` in the Seatbelt profile
 *    (`codex-rs/sandboxing/src/seatbelt.rs:450-481`).
 * 4. `:root`, `:minimal`, `:workspace_roots`, `:tmpdir`, `:slash_tmp` specials
 *    (`parse_special_path`, `:778`), and scoped subpath tables under a base key.
 *
 * ## The nine `**\/`-anchored entries: why the ROOT spelling is refused, and the
 * one that is not
 *
 * Our `**\/.env` means "any absolute path ending `/.env`". Its faithful codex
 * spelling is a filesystem-root-anchored deny glob, `/**\/.env`. That key is
 * accepted on macOS and is **destructive on the other two platforms we ship**:
 *
 * - **Windows**: `is_windows_absolute_path` (`permissions.rs:850`) requires a
 *   drive letter or a `\\` UNC prefix, so `/**\/.env` is not absolute, does not
 *   start with `~/` or `:`, and `parse_absolute_path_for_platform` returns
 *   `Err`. `compile_permission_profile` propagates it and the WHOLE config.toml
 *   is discarded — the fail-open `sandbox-enforcement.test.ts` documents, which
 *   would take the `credentials.enc` deny down with it.
 * - **Linux**: `split_pattern_for_ripgrep` (`codex-rs/linux-sandbox/src/bwrap.rs:756-782`)
 *   returns `None` when the pattern's static prefix is `"/"`, and its caller
 *   turns that into `CodexErr::Fatal("unreadable glob … cannot be safely
 *   expanded; use a pattern with a non-root directory prefix")` (`:707-731`) —
 *   fatal to sandbox construction, i.e. to every sandboxed exec.
 *
 * **P3.175's open half closes with `:workspace_roots`, and the reason it is
 * portable is that it is not a PATH.** Read at `rust-v0.148.0`, this spelling
 *
 * ```toml
 * [permissions.nessy_runtime.filesystem.":workspace_roots"]
 * "**\/.env" = "deny"
 * ```
 *
 * never meets a platform path parser at all. `compile_filesystem_permission`
 * (`core/src/config/permissions.rs:521-566`) sees a `Scoped` table whose base key
 * `parse_special_path` resolves to `FileSystemSpecialPath::ProjectRoots`, and for
 * a glob subpath with `deny` access hands it to `compile_scoped_filesystem_pattern`
 * (`:637-670`), which returns `project_roots_glob_pattern(&subpath)` — the literal
 * string `codex-project-roots://**\/.env` (`protocol/src/permissions.rs:388-392`).
 * It stays symbolic until `materialize_project_roots_with_workspace_roots`
 * (`:798-830`) resolves it against each workspace root. So:
 *
 * - **Windows** never calls `is_windows_absolute_path` on it. The subpath goes
 *   through `parse_relative_subpath` (`permissions.rs:862-886`), which accepts any
 *   subpath whose components are all `Component::Normal` — `**` and `.env` both
 *   are. The materialized pattern reaches `resolve_windows_deny_read_paths`
 *   (`windows-sandbox-rs/src/deny_read_resolver.rs:22-80`), which snapshot-expands
 *   glob entries to ACL targets and errors ONLY when the scan root has no parent,
 *   i.e. a filesystem root — which a workspace root is not.
 * - **Linux** gets `<workspace-root>/**\/.env`, whose static prefix is the
 *   workspace root rather than `"/"`, so `split_pattern_for_ripgrep` returns a
 *   search root instead of `None` and the fatal above cannot arise.
 * - **macOS** compiles it to the same `(deny file-read* (regex …))` a top-level
 *   deny glob produces (`sandboxing/src/seatbelt.rs:450-481`).
 *
 * **Measured on the shipped `darwin-arm64` binary (`codex-app-server 0.148.0`),
 * one run, four configs over one fixture, both controls present** — see
 * `__tests__/sandbox-enforcement.test.ts` §"the nine":
 *
 * | Config | `cat <ws>/a/b/c/.env` | `grep -rn` two levels above | `ls -1a` the dir |
 * | --- | --- | --- | --- |
 * | no profile (control) | leaks | **returns the line** | lists `.env` |
 * | profile denies an UNRELATED path (control) | leaks | **returns the line** | lists `.env` |
 * | `:workspace_roots` + `**\/.env` | **`Operation not permitted`** | **nothing** | lists `.env` |
 * | the same plus `glob_scan_max_depth = 8` | **`Operation not permitted`** | **nothing** | lists `.env` |
 *
 * So the RESULTS half closes for the nine as well; the DISCOVERY half (the file's
 * NAME) stays open for a glob deny exactly as it does for a file-scoped deny, and
 * only a directory-scoped deny hides a name.
 *
 * **What this spelling is NOT: it is narrower than the pattern it mirrors, and
 * that narrowing is stated rather than hidden.** `**\/.env` in our floor means
 * "anywhere on the filesystem"; under `:workspace_roots` it means "anywhere under
 * a workspace root". Outside the workspace, our own request gate remains the only
 * enforcement — which is what the diagnostic says, per pattern, instead of the
 * flat "NOT mirrored" this file printed before.
 *
 * Which roots those are is codex's question, not ours, and it is answered per
 * thread: the entry stays symbolic in the compiled profile and is resolved by
 * `materialize_project_roots_with_workspace_roots` (or `…_with_cwd`) against the
 * roots active at the time. A session opened on a repository gets that repository;
 * a session with no project gets its own working directory, which is narrower
 * still and harmless. Nothing here has to know the path in advance, which is also
 * why the same emitted config is correct for every session the runtime serves.
 *
 * **`glob_scan_max_depth` is deliberately NOT written**, and it is the one knob a
 * reader will reach for, because codex itself suggests it: with a `**` subpath and
 * no cap, non-macOS startup pushes a warning naming this exact key
 * (`permissions.rs:370-378`). Writing it would silence that warning by CAPPING the
 * Linux/Windows scan depth — a credential one directory deeper than the cap would
 * stop being denied on those two platforms while the config still claimed to deny
 * it. A visible vendor warning beats a silent depth hole. The cost of leaving it
 * unset is named rather than discovered: on Linux an expansion matching more than
 * `MAX_UNREADABLE_GLOB_MATCHES = 8192` paths under one workspace root is
 * `CodexErr::Fatal` (`bwrap.rs:56, :744-748`), which fails sandbox construction
 * loudly and names itself. This repository's own tree measures 43 matches across
 * all nine patterns, so the ceiling is two orders of magnitude away for a workspace
 * of this size.
 *
 * ## Defence in depth, never a replacement
 *
 * Our own `getDeniedPathViolation` gate is unchanged and stays authoritative: it
 * runs first and fails the call before codex is asked. This mirror only adds a
 * second, independent enforcement point — one that reaches where a tool-mediated
 * gate structurally cannot, namely a `grep` the model runs as a shell command.
 *
 * **Stated because it is user-visible**: an OS-level deny on `~/.ssh` or
 * `~/.aws` also stops `ssh`, `git push`, `aws`, `gcloud`, `az` and `kubectl`
 * from reading their own credentials inside a codex shell. That is the declared
 * floor being enforced rather than a new policy — those paths are already listed
 * as denied — but it is a behaviour change, and every mirrored entry is named on
 * the diagnostic channel so a failing CLI has a one-line explanation in the
 * session log. P3.184/P3.221 turned that sentence from a prediction into a
 * measurement; see {@link formatCodexCredentialFloorShellDiagnostics}.
 */
export type CodexDeniedPatternRejectionReason =
  /** Carries a character that cannot survive as a TOML config KEY meaning a path. */
  | 'unsafe-in-config-key'
  /**
   * Contains `[` or `]`. Ours ESCAPES both (`globToRegex`, `mode-manager.ts`),
   * codex's `contains_glob_chars` treats them as a character class — so the
   * mirror would match paths our floor allows, a widening a user would read as
   * a bug.
   */
  | 'glob-class-widens'
  /**
   * A glob that survives container-stripping and is NOT `**\/`-prefixed, so it
   * has no workspace-relative spelling either. Its only faithful codex form is
   * root-anchored, which is rejected on Windows and fatal on Linux; see the
   * module docstring. A `**\/`-prefixed glob is no longer rejected here — it
   * mirrors workspace-scoped, see {@link CodexDeniedPatternMapping.workspaceGlobs}.
   */
  | 'glob-not-portable'
  /**
   * `**\/`-prefixed, but the remainder is not a subpath codex's
   * `parse_relative_subpath` accepts (empty, or carrying a `.`/`..` component).
   * Refused HERE rather than emitted, because a subpath codex rejects makes
   * `compile_permission_profile` return `Err` and discards the WHOLE config —
   * the fail-open that would take the rest of the floor down with it.
   */
  | 'workspace-subpath-invalid'
  /** `~`, `~/` or `~/**` — denying the whole home directory is a policy, not a translation. */
  | 'bare-home'
  /** Neither `~/`-anchored nor absolute; codex's key parser refuses it. */
  | 'unanchored'
  /** The mirrored key is exactly a path this same profile grants writes to. */
  | 'conflicts-with-grant'

/** One floor pattern that did not reach codex, and the reason a reader needs. */
export interface CodexDeniedPatternRejection {
  readonly pattern: string;
  readonly reason: CodexDeniedPatternRejectionReason;
}

/** What {@link mapDeniedPathsToCodexFilesystemKeys} produced, mirror and residue both. */
export interface CodexDeniedPatternMapping {
  /** Filesystem-table keys, deduplicated and sorted so the config is stable across spawns. */
  readonly keys: readonly string[];
  /**
   * Subpaths for the `":workspace_roots"` scoped table — P3.175's nine.
   * Deduplicated and sorted for the same stability reason as {@link keys}.
   *
   * These are enforced only UNDER a workspace root, which is narrower than the
   * floor pattern they mirror. That narrowing is reported per pattern by
   * {@link formatCodexDeniedPathDiagnostics}, never assumed to be understood.
   */
  readonly workspaceGlobs: readonly string[];
  /** Patterns that reached {@link keys} or {@link workspaceGlobs}, in input order. */
  readonly mirrored: readonly string[];
  /** The subset of {@link mirrored} that reached {@link workspaceGlobs} only, in input order. */
  readonly workspaceScoped: readonly string[];
  /** Patterns that did NOT, each with its reason. Our gate is still their only enforcement point. */
  readonly rejected: readonly CodexDeniedPatternRejection[];
}

/**
 * Characters that cannot appear in a key we emit as a codex filesystem path.
 *
 * `\r`/`\n`/`\0` would produce a key no log line renders honestly (this repo has
 * already shipped one newline deny-bypass). A backslash is a separator on
 * Windows and an ordinary filename character on POSIX, and codex's own
 * `contains_glob_chars_for_platform` normalizes Windows device paths before
 * looking — a raw operator-written backslash is dropped by
 * `classifyDeniedPathPattern` on our side too, so nothing legitimate is lost.
 */
const CODEX_UNSAFE_IN_CONFIG_KEY = /[\r\n\0\\]/;

/** `[`/`]` mean different things on the two sides. See `glob-class-widens`. */
const CODEX_GLOB_CLASS = /[[\]]/;

/** `*` and `?` — the two metacharacters both sides agree are wildcards. */
const CODEX_GLOB_WILDCARD = /[*?]/;

/**
 * Translate one floor pattern into a codex filesystem-table key, or say why not.
 *
 * A trailing `/**` is STRIPPED rather than passed through, which is both
 * stronger and more faithful: our own matcher already treats `X/**` as covering
 * `X` itself (`deniedContainerPattern`), a keyless non-glob path denies the node
 * AND its whole subtree on codex's side, and the measurement above shows the
 * container spelling is the one that also hides the file's NAME.
 */
function translateDeniedPatternToCodexKey(
  pattern: string,
):
  | { readonly key: string }
  | { readonly workspaceSubpath: string }
  | { readonly reason: CodexDeniedPatternRejectionReason } {
  if (pattern.trim().length === 0) return { reason: 'unanchored' };
  if (CODEX_UNSAFE_IN_CONFIG_KEY.test(pattern)) return { reason: 'unsafe-in-config-key' };
  if (CODEX_GLOB_CLASS.test(pattern)) return { reason: 'glob-class-widens' };
  if (pattern === '~' || pattern === '~/' || pattern === '~/**') return { reason: 'bare-home' };

  const key = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (key.length === 0 || key === '/' || key === '~') return { reason: 'bare-home' };
  if (CODEX_GLOB_WILDCARD.test(key)) {
    // P3.175 · a `**\/`-prefixed glob has a portable spelling after all, and it
    // is the only glob shape that provably NARROWS rather than widens: our
    // `**\/X` means "any absolute path ending `/X`", and `:workspace_roots` +
    // `**\/X` means the same thing restricted to paths under a workspace root,
    // which is a subset by construction. Any other glob shape anchored at the
    // workspace root would match names our floor does not, so it stays refused.
    if (!key.startsWith('**/')) return { reason: 'glob-not-portable' };
    return isCodexRelativeSubpath(key)
      ? { workspaceSubpath: key }
      : { reason: 'workspace-subpath-invalid' };
  }
  if (!key.startsWith('~/') && !key.startsWith('/')) return { reason: 'unanchored' };
  return { key };
}

/**
 * Our side of codex's `parse_relative_subpath` (`core/src/config/permissions.rs:862-886`,
 * `rust-v0.148.0`): non-empty, and every `/`-separated component `Component::Normal`.
 *
 * Mirrored rather than trusted because the failure is not local. A subpath codex
 * refuses makes `compile_permission_profile` return `Err`, and the app-server
 * answers `Invalid configuration; using defaults` on STDERR ONLY while discarding
 * the WHOLE config.toml — so one bad glob would silently remove every other floor
 * entry, the provider block and the sandbox mode with it.
 */
function isCodexRelativeSubpath(subpath: string): boolean {
  if (subpath.length === 0) return false;
  const components = subpath.split('/');
  return components.every(component =>
    component.length > 0 && component !== '.' && component !== '..');
}

/**
 * Mirror the `deniedPaths` floor onto codex's own `[permissions.*.filesystem]`.
 *
 * Total by construction: every input pattern lands in
 * {@link CodexDeniedPatternMapping.mirrored} or `.rejected`, so a caller can
 * always say which entries reached the native surface and which are ours alone.
 *
 * `grants` are the writable paths of the same profile. A key that IS one of them
 * is dropped rather than emitted, because `deny` beats `write` on codex's side
 * (`FileSystemAccessMode`'s own doc comment: *"`deny` beats `write`, and `write`
 * beats `read`"*), so emitting both would silently revoke a grant the host asked
 * for. Dropped and reported, never resolved by guess.
 */
export function mapDeniedPathsToCodexFilesystemKeys(
  patterns: readonly string[] | undefined,
  grants: readonly string[] = [],
): CodexDeniedPatternMapping {
  const grantSet = new Set(grants);
  const keys = new Set<string>();
  const workspaceGlobs = new Set<string>();
  const mirrored: string[] = [];
  const workspaceScoped: string[] = [];
  const rejected: CodexDeniedPatternRejection[] = [];

  for (const pattern of patterns ?? []) {
    const outcome = translateDeniedPatternToCodexKey(pattern);
    if ('reason' in outcome) {
      rejected.push({ pattern, reason: outcome.reason });
      continue;
    }
    if ('workspaceSubpath' in outcome) {
      // No grant check here, and that is deliberate rather than an omission: a
      // grant is an ABSOLUTE path and this is a relative glob, so the two can
      // never be the same key. They CAN overlap — `<workspace>/**\/*.key` denies
      // reads inside a workspace the same profile grants writes to — and `deny`
      // beating `write` is the intended resolution, because our own gate already
      // refuses `Read`, `Edit` and `Write` on those patterns. Dropping the deny
      // to protect the grant would make codex weaker than the floor it mirrors.
      mirrored.push(pattern);
      workspaceScoped.push(pattern);
      workspaceGlobs.add(outcome.workspaceSubpath);
      continue;
    }
    if (grantSet.has(outcome.key)) {
      rejected.push({ pattern, reason: 'conflicts-with-grant' });
      continue;
    }
    mirrored.push(pattern);
    keys.add(outcome.key);
  }

  return {
    keys: [...keys].sort(),
    workspaceGlobs: [...workspaceGlobs].sort(),
    mirrored,
    workspaceScoped,
    rejected,
  };
}

/**
 * Human-readable lines for the diagnostic channel: what reached codex, and — the
 * load-bearing half — what did not.
 *
 * A dropped pattern means codex's OS-enforced deny will not cover it, so a shell
 * `grep` can still read it while our own request gate closes the tool call.
 * Saying so is the difference between a known subset and a silent one.
 */
export function formatCodexDeniedPathDiagnostics(mapping: CodexDeniedPatternMapping): string[] {
  const lines: string[] = [];
  const absolute = mapping.mirrored.length - mapping.workspaceScoped.length;
  if (mapping.keys.length > 0) {
    lines.push(
      `[CodexAgent] credential floor mirrored to permissions.filesystem: `
      + `${absolute} pattern(s) → ${mapping.keys.length} deny key(s) `
      + `(${mapping.keys.join(', ')}); agent shell commands can no longer read these paths.`,
    );
  }
  // P3.175 · the workspace half gets its OWN line rather than being folded into
  // the one above, because the two make different promises and a reader who
  // saw one number would take the weaker promise for the stronger one.
  if (mapping.workspaceGlobs.length > 0) {
    lines.push(
      `[CodexAgent] credential floor mirrored WORKSPACE-SCOPED to `
      + `permissions.filesystem.":workspace_roots": ${mapping.workspaceScoped.length} pattern(s) → `
      + `${mapping.workspaceGlobs.length} deny glob(s) (${mapping.workspaceGlobs.join(', ')}); `
      + `enforced by the OS under every workspace root — including for shell commands and for the `
      + `user's own build steps — and NOT outside them, where our own request gate stays the only `
      + `enforcement point.`,
    );
  }
  for (const { pattern, reason } of mapping.rejected) {
    lines.push(
      `[CodexAgent] deniedPaths entry ${JSON.stringify(pattern)} was NOT mirrored to codex `
      + `(${reason}); our own gate still denies it, but a shell command codex runs can still `
      + `read it.`,
    );
  }
  return lines;
}

/**
 * **P3.257 (a) — `claudeMdExcludes` has NO codex projection, and the user has to
 * be told rather than left to infer it from a file that reappears.**
 *
 * Measured from `rust-v0.148.0` (strong evidence — source, not the page), by
 * W3-a:
 *
 *  - `project_doc_max_bytes` is a byte BUDGET, not a selector:
 *    `core/src/agents_md.rs::load_project_instructions` seeds `remaining` from
 *    it and `break`s once `remaining == 0`, and `read_agents_md` returns
 *    `Ok(None)` when `max_total == 0`. It can only truncate the whole walk.
 *  - `project_doc_fallback_filenames` only ADDS candidate names.
 *
 * **Neither can drop one file and keep another**, so there is nothing on the
 * codex side to map an exclusion GLOB onto, and mapping one onto either value
 * would be inventing an intent the binary does not have — the move
 * `AGENTS.md`'s own read-do-not-invent rule exists to prevent.
 *
 * So the divergence stays and becomes a SENTENCE: on codex, a file our host
 * excluded is still re-discovered by codex's own project-doc loader and still
 * reaches the model. A user who set `claudeMdExcludes` and switched runtimes
 * gets a different context window with no notice, which is precisely the silent
 * cross-runtime difference this fork keeps paying for.
 *
 * Returns nothing when the session excluded nothing, for the same reason its
 * three siblings do: a line that always prints is a line nobody reads.
 */
export function formatCodexInstructionExcludeDiagnostics(
  instructionExcludes: readonly string[] | undefined,
): string[] {
  const patterns = (instructionExcludes ?? []).filter(pattern => pattern.trim().length > 0);
  if (patterns.length === 0) return [];
  return [
    `[CodexAgent] ${patterns.length} instruction-file exclusion(s) `
    + `(${patterns.join(', ')}) are NOT projected to codex and cannot be: `
    + `codex re-discovers AGENTS.md through its own project-doc loader, whose only knobs are a byte `
    + `budget (project_doc_max_bytes) and extra candidate NAMES `
    + `(project_doc_fallback_filenames) — neither can drop one file and keep another. `
    + `Our own gate still withholds these files from the tools, but their contents can still reach `
    + `the model as project instructions on this runtime, unlike on Pi and claude.`,
  ];
}

/* ------------------------------------------------------------------------- *
 * P6.392 — codex's three instruction-DISCOVERY keys, written by nobody
 * ------------------------------------------------------------------------- */

/**
 * The project-instruction filenames the HOST reads that codex's own candidate
 * list does not know — `project_doc_fallback_filenames`, measured at
 * `rust-v0.148.0` rather than taken from the schema's one-line description.
 *
 * ## What the source says, and where the schema's wording misleads
 *
 * `core/src/agents_md.rs::candidate_filenames` builds
 * `[AGENTS.override.md, AGENTS.md, …project_doc_fallback_filenames]`, skipping
 * empty and already-present entries. The schema calls these "fallback filenames
 * to look for **when AGENTS.md is missing**", which reads like a
 * whole-walk fallback and is not one: the walk in the same file iterates the
 * candidates PER DIRECTORY and `return`s on the first `metadata.is_file` hit, so
 * the rule is *at most one file per directory, first name in this order wins*.
 * Both readings are "additive"; only the second predicts where a file is read.
 *
 * ## Why this is the difference and not a list of its own
 *
 * `@nessy-agent/shared`'s `PROJECT_INSTRUCTION_FILES` is the host's list, and
 * codex already knows its first two entries by name. Projecting the DIFFERENCE
 * is what makes a repository's `CLAUDE.md` steer a codex session the way it
 * already steers Pi and claude, instead of being read by two of three runtimes
 * with nothing saying so. This module is a dependency-free leaf (see the header:
 * `@nessy-agent/shared` depends on it, never the reverse), so the names are
 * duplicated here exactly as `AgentTier` and `PERMISSION_MODE_ORDER` are, and
 * `capabilities/__tests__/codex-project-doc-projection.test.ts` on the shared
 * side fails if the two lists stop agreeing.
 *
 * ## The residue, stated because it is a NARROWED divergence and not a closed one
 *
 * In a directory carrying BOTH `AGENTS.md` and `CLAUDE.md`, codex reads only
 * `AGENTS.md` (first match wins) while the host reads both — its own
 * per-directory rule, `agentsMdSupersededIn`, pairs only `AGENTS.override.md`
 * with `AGENTS.md`. So this closes the case where a repository has no
 * `AGENTS.md` at all — the common one for a Claude-first repository — and leaves
 * the mixed directory differing. Widening it further is not available: codex
 * offers no per-file selector, which is the same measurement
 * {@link formatCodexInstructionExcludeDiagnostics} records for the other
 * direction.
 */
export const CODEX_PROJECT_DOC_FALLBACK_FILENAMES: readonly string[] = Object.freeze([
  'CLAUDE.md',
  'CLAUDE.local.md',
]);

/**
 * `project_root_markers` — the marker set codex's upward walks stop at. The host
 * agrees on the NAME (`.git`), not on what a `.git` has to be (F1.770).
 *
 * `core/src/agents_md.rs`, module doc: the AGENTS.md walk climbs "until a
 * configured `project_root_markers` entry is found" (default `.git`) and takes
 * ANY `.git` entry (`file-system/src/find_up.rs:110`), as the host's walk does
 * (`prompts/output-styles.ts::outputStyleProjectRootFor`, an `existsSync`). The
 * config loader does not: `discover_project_root` (`config/src/loader/mod.rs:1505-1516`,
 * the root of trust and `.codex` layers) and `git-utils/src/trust.rs:45-57` (both
 * `rust-v0.156.1`) skip a `.git` DIRECTORY with no `HEAD`. Only a TRUSTED project
 * differs (`untrusted` is keyed on the cwd): under a HEAD-less `.git` its `trusted`
 * lands on a folder codex never looks up, and codex's `thread/start` auto-trusts it anyway.
 *
 * Writing the key changes nothing TODAY: it PINS the name against a codex default
 * that could move unseen, and the shared-side test above fails if the host's does.
 */
export const CODEX_PROJECT_ROOT_MARKERS: readonly string[] = Object.freeze(['.git']);

/**
 * codex's own default budget for the whole instruction walk, in BYTES —
 * `project_doc_max_bytes`, `32768` in the pinned schema
 * (`packages/codex-protocol/schema/config-schema.json`, `.properties`), and the
 * value `load_project_instructions` seeds `remaining` from before it `break`s at
 * zero.
 *
 * Exported because it is the number a truncation is measured AGAINST, not
 * because it is written: {@link buildCodexProjectDocTomlLines} emits the key
 * only for a caller that set one, so an install that configured nothing keeps
 * codex's default rather than having ours pinned on top of it.
 */
export const CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT = 32_768;

export interface CodexProjectDocOptions {
  /** Extra candidate filenames; defaults to {@link CODEX_PROJECT_DOC_FALLBACK_FILENAMES}. */
  readonly projectDocFallbackFilenames?: readonly string[] | undefined;
  /** Root markers; defaults to {@link CODEX_PROJECT_ROOT_MARKERS}. */
  readonly projectRootMarkers?: readonly string[] | undefined;
  /** The byte budget. Omitted from the file when unset, leaving codex's own default. */
  readonly projectDocMaxBytes?: number | undefined;
}

/**
 * The three top-level scalars of P6.392, in the block BEFORE the first table
 * header.
 *
 * All three are bare top-level keys, so they must be pushed into
 * `buildCodexConfigToml`'s opening `lines` array beside `compact_prompt` and
 * `tool_output_token_limit` — a `[features]` or `[permissions.…]` header opened
 * above would swallow them, the same trap those two record and the reason this
 * function returns lines rather than writing them.
 *
 * Empty and blank names are dropped rather than written: codex skips an empty
 * candidate itself, and an empty marker list means something else entirely
 * ("an empty marker list disables parent traversal"), so emitting `[]` by
 * accident would silently confine discovery to the working directory.
 */
export function buildCodexProjectDocTomlLines(opts: CodexProjectDocOptions = {}): string[] {
  const names = (opts.projectDocFallbackFilenames ?? CODEX_PROJECT_DOC_FALLBACK_FILENAMES)
    .filter(name => name.trim().length > 0);
  const markers = (opts.projectRootMarkers ?? CODEX_PROJECT_ROOT_MARKERS)
    .filter(marker => marker.trim().length > 0);
  const lines: string[] = [];
  if (names.length > 0) {
    lines.push(`project_doc_fallback_filenames = [${names.map(tomlString).join(', ')}]`);
  }
  if (markers.length > 0) {
    lines.push(`project_root_markers = [${markers.map(tomlString).join(', ')}]`);
  }
  if (opts.projectDocMaxBytes !== undefined && Number.isSafeInteger(opts.projectDocMaxBytes)
    && opts.projectDocMaxBytes >= 0) {
    lines.push(`project_doc_max_bytes = ${opts.projectDocMaxBytes}`);
  }
  return lines;
}

/**
 * The truncation sentence codex will not say for us — P6.392(1).
 *
 * `read_agents_md` truncates a project doc that does not fit the remaining
 * budget and records it with `tracing::warn!("project doc exceeds remaining
 * budget; truncating")`. That is a codex-internal log line: it does not travel
 * on the app-server wire, so a user whose `AGENTS.md` chain is being cut sees a
 * model that has read half its instructions and nothing that says so. The host
 * already knows the chain it discovered, so the host is the one that can measure
 * it — native-first step 2, the seam rather than a second loader.
 *
 * Returns nothing when the chain fits, for the same reason its three siblings in
 * this file do: a line that always prints is a line nobody reads.
 */
export function formatCodexProjectDocTruncationDiagnostics(
  discoveredBytes: number | undefined,
  maxBytes: number = CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT,
): string[] {
  if (discoveredBytes === undefined || !Number.isFinite(discoveredBytes)) return [];
  if (discoveredBytes <= maxBytes) return [];
  return [
    `[CodexAgent] the project instruction chain is ${discoveredBytes} bytes and codex reads at most `
    + `${maxBytes} (project_doc_max_bytes): the tail is TRUNCATED on this runtime and read in full on `
    + `Pi and claude, which have no byte cap. codex logs the truncation only to its own tracing output, `
    + `so raise project_doc_max_bytes or shorten the chain.`,
  ];
}

/**
 * **P3.184 + P3.221 — the sentence a user needs when `ssh` stops working.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, rows P3.184 and
 * P3.221. Both describe one consequence of {@link mapDeniedPathsToCodexFilesystemKeys}:
 * codex's deny is enforced by the OPERATING SYSTEM, so it binds every process in
 * the sandbox rather than only the model's tool calls. The controller's decision
 * on P3.184 was **keep the deny, make the refusal legible** — the paths were
 * already declared unreadable and codex's breadth is its documented design, so
 * what changed is that the declaration is finally true. An exception list for
 * `ssh`/`git`/`aws` was considered and refused there: it would re-open the floor
 * for precisely the processes most likely to read a credential.
 *
 * ## Native-first: codex HAS the classifier, and its verdict never reaches us
 *
 * Asked before writing anything, and re-read at `rust-v0.150.1`, where the
 * cited file is byte-identical to the tag it was first read at.
 * `classify_filesystem_sandbox_violation` (`sandboxing/src/violation.rs`)
 * already recognises this exact refusal — `SANDBOX_DENIED_KEYWORDS` leads with
 * `"operation not permitted"` — and `extract_denied_path_from_text` already
 * pulls the path out. But `record_sandbox_violation`, in the same file, does one
 * thing with it: `tracing::warn!` inside the codex process. Its call sites — in
 * `core/src/exec.rs`, `tools/runtimes/apply_patch.rs`,
 * `tools/runtimes/shell/unix_escalation.rs` and `unified_exec/process.rs` —
 * discard the return value, and no protocol event carries it. (Cited by symbol
 * rather than by line since P7.2: those four files all moved under the lift
 * while this one did not, so the line numbers would have rotted at four
 * different rates.) Same shape as the
 * egress finding on {@link formatCodexSandboxEgressDiagnostics}: the mechanism
 * exists, the verdict is unobservable, so the host has to say it.
 *
 * ## What was measured, and what is stated because it could not be
 *
 * Shipped `darwin-arm64` `codex-app-server 0.148.0`, one run, two arms sharing one
 * fixture HOME so no real credential was read. Control = the identical config with
 * an empty floor; every row below leaks the marker in the control and refuses in
 * the treatment:
 *
 * | Command | With the floor mirrored |
 * | --- | --- |
 * | `ssh -F ~/.ssh/config -G <host>` | `Can't open user config file …: Operation not permitted` |
 * | `ssh-keygen -y -f ~/.ssh/id_ed25519` | exit 255, `Operation not permitted` |
 * | `git credential fill` (store helper) | exit 128, `fatal: unable to open ~/.git-credentials: Operation not permitted` |
 * | `kubectl config view --raw`, `config current-context` | `error: error loading config file "~/.kube/config"` |
 * | `docker context ls` | `WARNING: Error loading config file: … operation not permitted` |
 * | `cat ~/.aws/credentials`, `~/.config/gcloud/…`, `~/.azure/…`, `~/.netrc`, `~/.gnupg/…` | `Operation not permitted` |
 *
 * `aws`, `gcloud` and `az` are **not installed on the measuring host**, so the
 * last row is the read each of them performs rather than the CLI itself — stated
 * as the proxy it is instead of being claimed as an end-to-end result. `git push`
 * over ssh was probed and is **inconclusive**: the fixture repository failed for an
 * unrelated reason in BOTH arms, so it proves nothing either way and is not listed
 * above; the `ssh` rows are what carry that claim. `npm` is unaffected and stays
 * unaffected — `~/.npmrc` is deliberately absent from the floor, only `**\/.npmrc`
 * is in it.
 *
 * ## Why it says the runtime, not just the paths
 *
 * P3.221's criterion is goal 1: the same turn must be describable truthfully after
 * a switch. On Pi and claude this floor is TOOL-mediated — `getDeniedPathViolation`
 * refuses the tool call and a shell command runs unimpeded — so every command in
 * the table above still works there. That asymmetry is real, is not a defect on
 * either side, and is the thing a user hitting `Operation not permitted` cannot
 * possibly infer. Saying it is the whole point of this line.
 *
 * Pure, and emitted on the same sink and at the same cadence as its three siblings:
 * once per `writeCodexConfig`, never from the builders.
 */
export function formatCodexCredentialFloorShellDiagnostics(
  mapping: CodexDeniedPatternMapping,
): string[] {
  if (mapping.keys.length === 0 && mapping.workspaceGlobs.length === 0) return [];
  const scopes: string[] = [];
  if (mapping.keys.length > 0) scopes.push(`${mapping.keys.length} absolute/home path(s)`);
  if (mapping.workspaceGlobs.length > 0) {
    scopes.push(`${mapping.workspaceGlobs.length} workspace-scoped glob(s)`);
  }
  return [
    `codex-credential-floor-os-enforced: ${scopes.join(' and ')} from the deniedPaths credential`
    + ' floor are denied by the OPERATING SYSTEM in this codex session, not only to the model\'s'
    + ' tools. Measured on rust-v0.148.0: ssh (config and key files), git credential helpers,'
    + ' kubectl, docker and the aws/gcloud/az credential files all fail with "Operation not'
    + ' permitted" inside an agent shell, and so do the user\'s own build steps that read a'
    + ' matching file. codex reports that refusal with no attribution — its own'
    + ' classify_filesystem_sandbox_violation never reaches the wire — so this line is the'
    + ' attribution. On Pi and claude the same floor is enforced tool-side only, so the identical'
    + ' command succeeds there: this is a per-runtime difference, not a fault. Edit deniedPaths in'
    + ' the permissions config to relax it.',
  ];
}

function normalizeRuntimePaths(
  paths: readonly string[] | undefined,
  kind: 'denied-read' | 'writable' | 'read-only',
): string[] {
  const normalized = new Set<string>();
  for (const path of paths ?? []) {
    if (!isAbsolute(path)) throw new Error(`codex-${kind}-path-not-absolute`);
    const absolute = resolve(path);
    if (absolute === parse(absolute).root) throw new Error(`codex-${kind}-path-too-broad`);
    normalized.add(absolute);
  }
  return [...normalized].sort();
}

/**
 * C3.343 — the SENTENCE for the floor above, on the same sink and at the same
 * cadence as {@link formatCodexCredentialFloorShellDiagnostics}, and for the same
 * measured reason: codex reports a policy refusal as a bare
 * `Operation not permitted` and its own `classify_filesystem_sandbox_violation`
 * never reaches the wire, so an unattributed failure is all a user would get.
 *
 * It says the two things that differ from the credential line: this floor refuses
 * WRITES ONLY — reads keep working, which is what keeps `git status` alive — and
 * on Pi and claude the same floor PROMPTS, so the identical request is approvable
 * there and is not here. That asymmetry is the switch cost, said out loud.
 */
export function formatCodexProtectedPathFloorDiagnostics(
  subpaths: readonly string[] | undefined,
): string[] {
  const entries = normalizeWorkspaceProtectedSubpaths(subpaths);
  if (entries.length === 0) return [];
  return [
    `codex-protected-path-floor-os-enforced: ${entries.length} workspace path(s) — ${entries.join(', ')}`
    + ' — are READ-ONLY to this codex session, enforced by the operating system rather than by a'
    + ' tool check. A write to one fails with "Operation not permitted" and codex attributes it to'
    + ' nothing, so this line is the attribution; reads are untouched, so git and every tool that'
    + ' only reads these paths keep working. On Pi and claude the same floor PROMPTS instead (the'
    + ' workspace\'s own automations and permissions records are refused there too), so a write a user'
    + ' could approve there is refused outright here — a per-runtime difference, not a fault. Codex'
    + ' protects .git, .agents and .codex by itself at the top of a writable root; the rest of this'
    + ' list, and a workspace nested inside /tmp or $TMPDIR, are what this adds.',
  ];
}

/**
 * C3.343 — the host's protected-path floor, normalized for codex's own
 * `":workspace_roots"` table.
 *
 * Relative by construction: a `":workspace_roots"` subpath is resolved by codex
 * against EVERY workspace root it knows (`FileSystemSpecialPath::ProjectRoots`
 * with a subpath, `codex-rs/protocol/src/permissions.rs` at `rust-v0.150.1`), so
 * an absolute key here would silently name one machine's directory instead of
 * the session's project. The four refusals are the shapes codex would either
 * reject (discarding the WHOLE config) or misread:
 *
 *  - absolute, or home-relative (`~` alone or `~/…`) — those belong in the
 *    profile's flat map: `parse_relative_subpath` refuses the first, and codex
 *    reads the second under `":workspace_roots"` as a HOME path
 *    (`home_relative_suffix`, `core/src/config/permissions.rs` at `rust-v0.156.1`);
 *  - `..` anywhere — a subpath that escapes the workspace root;
 *  - a glob character — `compile_scoped_filesystem_pattern` accepts a glob
 *    subpath ONLY with `deny` access, and this table's entries are `read`;
 *  - empty (a bare `./` included) — skipped. An explicit `.` is KEPT (F1.664): it is
 *    codex's own "the root itself" spelling, and the host emits it only when the cwd
 *    IS the Nessy config dir, which must then be read-only as a whole.
 *
 * F1.927 — a name that merely STARTS with `~` (`~cfg/…`) is an ordinary relative
 * subpath to codex (`home_relative_suffix` matches `~` and `~/` only), and codex keeps
 * a subpath's spelling verbatim (`relative_subpath`, `core/src/config/permission_path.rs`
 * at `rust-v0.156.1`), so neither is refused nor trimmed here: a trim would protect a
 * different path than the one named.
 */
function normalizeWorkspaceProtectedSubpaths(subpaths: readonly string[] | undefined): string[] {
  const normalized = new Set<string>();
  for (const raw of subpaths ?? []) {
    const subpath = raw === '.' ? '.' : raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (subpath.length === 0) continue;
    const homeRelative = subpath === '~' || subpath.startsWith('~/')
      || (process.platform === 'win32' && subpath.startsWith('~\\'));
    if (isAbsolute(subpath) || homeRelative) {
      throw new Error('codex-protected-workspace-subpath-not-relative');
    }
    const segments = subpath.split('/');
    if (segments.some(segment => segment === '..' || segment.length === 0)) {
      throw new Error('codex-protected-workspace-subpath-escapes');
    }
    if (/[*?[\]]/.test(subpath)) throw new Error('codex-protected-workspace-subpath-glob');
    normalized.add(subpath);
  }
  return [...normalized].sort();
}

function normalizeShellEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error('codex-shell-environment-key-invalid');
    }
    if (value.includes('\0')) throw new Error('codex-shell-environment-value-invalid');
    normalized[key] = value;
  }
  return normalized;
}

/** The floor keys a given options object mirrors, and the residue. Pure. */
export function resolveDeniedPatternMapping(opts: Pick<
  CodexConfigOptions,
  'deniedReadPatterns' | 'writablePaths'
>): CodexDeniedPatternMapping {
  return mapDeniedPathsToCodexFilesystemKeys(
    opts.deniedReadPatterns,
    normalizeRuntimePaths(opts.writablePaths, 'writable'),
  );
}

/**
 * True when this options object writes a `[permissions.*]` profile — as the
 * SCHEMA-DRIFT GUARD asks the question, which is not where the emitters ask it.
 *
 * P3.273 corrected this docblock against a measurement. Neither emitter gates on
 * this function: {@link buildCodexPermissionsTomlLines} and
 * {@link buildCodexPermissionsOverride} both gate on
 * {@link hasCodexFilesystemPolicy}, which reads the RESOLVED policy. This one
 * reads the raw options and has exactly two readers, `validateConfigAgainstSchema`
 * and `writeCodexConfig`, where it decides whether `default_permissions` and
 * `permissions` are DEMANDED of the release schema. Measured: mutating the
 * workspace-glob arm below back to `keys.length > 0` changes no emitted byte and
 * survived the whole 26-file adapter suite, so the arming assertions live in
 * `config-writer-denied-path-mirror.test.ts`.
 */
export function hasCodexRuntimePathPolicy(opts: Pick<
  CodexConfigOptions,
  'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths' | 'protectedWorkspaceSubpaths' | 'readOnlyPaths'
>): boolean {
  if ((opts.deniedReadPaths?.length ?? 0) > 0 || (opts.writablePaths?.length ?? 0) > 0) return true;
  if ((opts.readOnlyPaths?.length ?? 0) > 0) return true; // F1.670 — a profile carrying only `read` keys is still a profile
  // C3.343 · a session whose ONLY filesystem policy is the protected-path floor
  // still writes the profile, so the drift guard must still demand its keys.
  if (normalizeWorkspaceProtectedSubpaths(opts.protectedWorkspaceSubpaths).length > 0) return true;
  const mapping = resolveDeniedPatternMapping(opts);
  // P3.175 · the workspace globs are counted here too, because a floor whose
  // only mirrorable entries are the nine still produces a profile, so the drift
  // guard must still demand the two keys that profile writes. This line used to
  // say that reading `keys` alone would emit no `[permissions]` block at all;
  // P3.273 measured that and it is wrong — the block is emitted regardless. What
  // reading `keys` alone actually loses is the schema demand, for exactly the
  // configs P3.175 added, which is the silent half of the fail-shape this file
  // exists to refuse.
  return mapping.keys.length > 0 || mapping.workspaceGlobs.length > 0;
}

/** What {@link resolveCodexRuntimePathPolicy} resolved: the paths, the parent profile, the environment. */
export interface CodexRuntimePathPolicy {
  environment: Record<string, string>;
  permissionParent: ':read-only' | ':workspace';
  /**
   * F1.670 — `read` joined `write` and `deny`: codex's `FileSystemAccessMode` is a real three-value
   * enum, and an absolute `read` key refuses an agent command's write under it while its reads keep
   * working, where `deny` refused both (measured on the shipped 0.156.1 by WJ-crit-g/WJ-crit-j: an
   * added directory or the home cwd above the key; re-measured on 0.159.3 by BK-8).
   */
  filesystem: Record<string, 'write' | 'read' | 'deny'>;
  /**
   * P3.175 · subpaths for the `":workspace_roots"` scoped deny table, kept OUT
   * of {@link CodexRuntimePathPolicy.filesystem} on purpose. That map is
   * a flat path → access map and four call sites iterate its values
   * expecting a scalar; nesting a table inside it would have type-checked into a
   * `[object Object]` TOML value and a schema check that validated the wrong
   * thing.
   */
  workspaceDenyGlobs: readonly string[];
  /**
   * C3.343 · the host's protected-path floor, as `read` entries in the SAME
   * `":workspace_roots"` scoped table. `read` and never `deny`: the floor is
   * about WRITES — `git status`, and every tool that reads `.git`, must keep
   * working — and `FileSystemAccessMode` is a real three-value
   * `read`/`write`/`deny`, so the middle value says exactly that.
   */
  workspaceProtectedSubpaths: readonly string[];
}

/**
 * Resolve the writable/denied path policy and the profile it extends.
 *
 * `sandboxMode` is a PARAMETER rather than a derivation from `opts.mode`: that
 * derivation needs `codexSandboxConfigForMode`, which lives in
 * `config-writer.ts`, and taking it as an argument is what keeps this module a
 * leaf (P3.273). `config-writer.ts`'s own `resolveRuntimePolicy` does the
 * derivation and calls straight through, so every caller reads as before.
 */
export function resolveCodexRuntimePathPolicy(
  opts: Pick<
    CodexConfigOptions,
    'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths' | 'shellEnvironment'
    | 'protectedWorkspaceSubpaths' | 'mode' | 'readOnlyPaths'
  >,
  sandboxMode: CodexSandboxMode,
): CodexRuntimePathPolicy {
  const deniedReadPaths = normalizeRuntimePaths(opts.deniedReadPaths, 'denied-read');
  const writablePaths = normalizeRuntimePaths(opts.writablePaths, 'writable');
  const readOnlyPaths = normalizeRuntimePaths(opts.readOnlyPaths, 'read-only'); // F1.670
  const denied = new Set(deniedReadPaths);
  const readOnly = new Set(readOnlyPaths);
  // A path both granted and refused (denied, or F1.670's read-only) is one key with two values: refuse
  // the config rather than let the emission order pick a winner silently.
  if (writablePaths.some(path => denied.has(path) || readOnly.has(path))) {
    throw new Error('codex-runtime-path-policy-conflict');
  }
  // P3.175 · the credential-floor mirror. LAST, so a floor entry that lands on
  // the same key as a host-owned exact deny is idempotent (both say `deny`), and
  // one that lands on a GRANT never gets here at all — the mapper drops it,
  // because `deny` beats `write` on codex's side and emitting both would revoke
  // a grant the host asked for.
  const floorMapping = resolveDeniedPatternMapping(opts);
  return {
    environment: normalizeShellEnvironment(opts.shellEnvironment),
    permissionParent: sandboxMode === 'read-only' || codexModeKeepsReadOnlyParent(opts.mode) ? ':read-only' : ':workspace', // F1.787
    filesystem: Object.fromEntries([
      ...writablePaths.map(path => [path, 'write'] as const),
      ...readOnlyPaths.map(path => [path, 'read'] as const), // F1.670 — before the denies, so a path also denied stays denied
      ...deniedReadPaths.map(path => [path, 'deny'] as const),
      ...floorMapping.keys.map(key => [key, 'deny'] as const),
    ]),
    workspaceDenyGlobs: floorMapping.workspaceGlobs,
    workspaceProtectedSubpaths: normalizeWorkspaceProtectedSubpaths(opts.protectedWorkspaceSubpaths),
  };
}

/** The `":workspace_roots"` scoped deny table as codex's JSON config shape. */
function workspaceRootsDenyTable(globs: readonly string[]): Record<string, 'deny'> {
  return Object.fromEntries(globs.map(glob => [glob, 'deny'] as const));
}

/** TOML key for the `":workspace_roots"` scoped table under a profile's filesystem map. */
const CODEX_WORKSPACE_ROOTS_KEY = ':workspace_roots';

/** True when this policy produces a `[permissions.<profile>]` block at all. */
export function hasCodexFilesystemPolicy(policy: CodexRuntimePathPolicy): boolean {
  return Object.keys(policy.filesystem).length > 0
    || policy.workspaceDenyGlobs.length > 0
    || policy.workspaceProtectedSubpaths.length > 0;
}

/**
 * The `":workspace_roots"` scoped table's contents — the protected-path `read`
 * entries first, then the credential floor's deny globs.
 *
 * One builder for both emitters, because the TOML and the per-thread JSON
 * override are hashed against each other: `codexThreadConfigSignature`
 * (`shared/agent/codex-agent.ts`) is a `JSON.stringify` of the override, so two
 * copies of this ordering that drifted would refork every thread once and blame
 * the plugin runtime.
 */
function workspaceRootsScopedTable(policy: CodexRuntimePathPolicy): Record<string, 'read' | 'deny'> {
  return {
    ...Object.fromEntries(policy.workspaceProtectedSubpaths.map(subpath => [subpath, 'read'] as const)),
    ...workspaceRootsDenyTable(policy.workspaceDenyGlobs),
  };
}

/** True when the `":workspace_roots"` sub-table has any entry at all. */
function hasWorkspaceRootsScopedTable(policy: CodexRuntimePathPolicy): boolean {
  return policy.workspaceDenyGlobs.length > 0 || policy.workspaceProtectedSubpaths.length > 0;
}

/**
 * The `permissions` half of the per-thread config layer, as codex's JSON shape.
 *
 * Returns an EMPTY object when there is no filesystem policy, so the caller can
 * spread it unconditionally — the same "emit nothing rather than an empty
 * table" posture the TOML side takes.
 */
export function buildCodexPermissionsOverride(
  policy: CodexRuntimePathPolicy,
): Record<string, unknown> {
  if (!hasCodexFilesystemPolicy(policy)) return {};
  return {
    default_permissions: NESSY_RUNTIME_PERMISSION_PROFILE,
    permissions: {
      [NESSY_RUNTIME_PERMISSION_PROFILE]: {
        description: CODEX_RUNTIME_PROFILE_DESCRIPTION,
        extends: policy.permissionParent,
        filesystem: {
          ...policy.filesystem,
          // P3.175 · a nested table beside the scalar entries, which is
          // exactly what `FilesystemPermissionToml` is:
          // `#[serde(untagged)] Access(FileSystemAccessMode) |
          // Scoped(BTreeMap<String, FileSystemAccessMode>)`
          // (`config/src/permissions_toml.rs`, `enum FilesystemPermissionToml`,
          // re-read at rust-v0.150.1 where that file is byte-identical).
          ...(hasWorkspaceRootsScopedTable(policy)
            ? { [CODEX_WORKSPACE_ROOTS_KEY]: workspaceRootsScopedTable(policy) }
            : {}),
        },
      },
    },
  };
}

/**
 * The `[permissions.<profile>]` tables as config.toml lines.
 *
 * Returns `[]` when there is no filesystem policy, so the caller pushes the
 * result unconditionally.
 */
export function buildCodexPermissionsTomlLines(policy: CodexRuntimePathPolicy): string[] {
  if (!hasCodexFilesystemPolicy(policy)) return [];
  const lines: string[] = [
    `[permissions.${NESSY_RUNTIME_PERMISSION_PROFILE}]`,
    `description = ${tomlString(CODEX_RUNTIME_PROFILE_DESCRIPTION)}`,
    `extends = ${tomlString(policy.permissionParent)}`,
    '',
    `[permissions.${NESSY_RUNTIME_PERMISSION_PROFILE}.filesystem]`,
    ...Object.entries(policy.filesystem).map(([path, access]) => `${tomlString(path)} = ${tomlString(access)}`),
    '',
  ];
  // P3.175 · the scoped table goes AFTER every scalar entry of its parent, and
  // the ordering is load-bearing rather than cosmetic: in TOML a bare
  // `key = value` line following a sub-table header belongs to the SUB-table,
  // so an absolute deny emitted after this header would silently become a
  // workspace-relative subpath — and `parse_relative_subpath` would refuse it,
  // discarding the whole config. Same trap as the `approvals_reviewer` and
  // `multi_agent` scalars elsewhere in this builder.
  if (hasWorkspaceRootsScopedTable(policy)) {
    lines.push(
      `[permissions.${NESSY_RUNTIME_PERMISSION_PROFILE}.filesystem.${tomlString(CODEX_WORKSPACE_ROOTS_KEY)}]`,
      ...Object.entries(workspaceRootsScopedTable(policy))
        .map(([subpath, access]) => `${tomlString(subpath)} = ${tomlString(access)}`),
      '',
    );
  }
  return lines;
}

/**
 * **P6.167 — which `.claude/settings.json` FAMILIES reach a codex session, and
 * which cannot.**
 *
 * ## The premise this table corrects
 *
 * Ledger L1 read `absent` for codex, i.e. *a user's `.claude/settings.json` does
 * nothing here*. That is stale, and the whole point of the table is that the
 * true answer is neither `absent` nor `covered` but PER FAMILY:
 *
 *  - the `permissions` block **does** take effect on codex. Measured at HEAD:
 *    `capabilities/native-sources.ts` pushes `.claude/settings.json` and
 *    `.claude/settings.local.json` as project/local permission records with
 *    `sourceTier: 'portable'` and **no provider gate**;
 *    `agent/permissions-config.ts` runs `claudeSettingsPermissionDsl(...)`
 *    BEFORE `PermissionsConfigSchema.safeParse`, so the Claude-shaped block is
 *    recognised rather than rejected as an invalid Nessy document; and
 *    `CodexAgent` calls `consultPermissionRules(...)` on its approval path.
 *  - the rest are silent, and they are silent for four DIFFERENT reasons, which
 *    is exactly what a single `absent`/`covered` cell cannot say.
 *
 * ## The four verdicts, and why a fifth would be dishonest
 *
 * | Verdict | Means |
 * | --- | --- |
 * | `projected` | written into codex's own `config.toml`, so codex enforces it |
 * | `host-enforced` | the HOST applies it identically on all three runtimes, so there is nothing to project and no divergence to disclose |
 * | `unprojectable` | codex has no counterpart; the residue is a stated diagnostic |
 * | `refused` | we deliberately do not honour it ANYWHERE, by an owner decision, so codex projecting it would be strictly wrong |
 *
 * `host-enforced` is the verdict a naive audit gets wrong in the expensive
 * direction: a family the host reads once and applies to every runtime looks
 * "not projected to codex" to a grep and is in fact uniform, which is the outcome
 * `AGENTS.md`'s native-first rule asks for (*the host is the smooth seam*). Calling
 * it a gap would queue work that must not be done.
 *
 * ## Membership: the families this HOST reads, not the families the page documents
 *
 * Every entry below names its reader, and the readers were enumerated rather than
 * recalled — the two settings files have exactly these readers in-tree. A key that
 * is in `settings-reference.md` and in NO reader here is not a codex gap at all: it
 * is a HOST gap on every runtime, which is P2.313's subject and not this table's.
 * {@link CLAUDE_SETTINGS_UNREAD_BY_HOST} is the verdict such a key gets, and it is
 * deliberately not `unprojectable` — saying "codex cannot express it" about a value
 * nothing in this product has ever read would invent a codex-specific failure out
 * of a product-wide silence.
 */
export type ClaudeSettingsCodexVerdict =
  | 'projected'
  | 'host-enforced'
  | 'unprojectable'
  | 'refused';

/** The verdict for a documented key no reader in this product consults. */
export const CLAUDE_SETTINGS_UNREAD_BY_HOST = 'unread-by-host' as const;

export interface ClaudeSettingsCodexProjection {
  /** Top-level key(s) in `.claude/settings.json` / `.claude/settings.local.json`. */
  readonly keys: readonly string[];
  readonly verdict: ClaudeSettingsCodexVerdict;
  /** Where the host reads it — named so the next reader can check this row. */
  readonly reader: string;
  /** Why the verdict is what it is, in one sentence a user could be shown. */
  readonly reason: string;
}

/**
 * One entry per family, keyed by the family NAME rather than by a settings key,
 * because two keys can be one family (`instructionExcludes` and its Claude
 * spelling `claudeMdExcludes` are the same setting under two names).
 *
 * Frozen, and asserted TOTAL over its own key union by
 * `config-writer-claude-settings-projection.test.ts`, so a family added to the
 * host's readers without a verdict here is a test failure rather than a silence.
 */
export const CLAUDE_SETTINGS_CODEX_PROJECTION: Readonly<Record<string, ClaudeSettingsCodexProjection>> = Object.freeze({
  permissions: {
    keys: ['permissions'],
    verdict: 'projected',
    reader: 'agent/permissions-config.ts (claudeSettingsPermissionDsl)',
    reason:
      'the allow/ask/deny rules are compiled into the same permission DSL every runtime consults, and '
      + "the credential floor is additionally mirrored into codex's own [permissions.<profile>.filesystem] "
      + 'table, where the operating system enforces it',
  },
  writableRoots: {
    keys: ['permissions.additionalDirectories'],
    verdict: 'projected',
    reader: 'agent/codex-agent.ts (codexAdditionalWritableRoots)',
    reason:
      "the added roots reach codex's own writable-roots list in config.toml, so a write outside them is "
      + 'refused by the runtime rather than only by our gate',
  },
  instructionExcludes: {
    keys: ['instructionExcludes', 'claudeMdExcludes'],
    verdict: 'unprojectable',
    reader: 'agent/memory/instruction-excludes.ts (INSTRUCTION_EXCLUDE_SETTING_KEYS)',
    reason:
      "codex re-discovers AGENTS.md through its own project-doc loader, whose only knobs are a byte budget "
      + '(project_doc_max_bytes) and extra candidate NAMES (project_doc_fallback_filenames) — neither can '
      + 'drop one file and keep another, so an excluded file still reaches the model here',
  },
  skillOverrides: {
    keys: ['skillOverrides'],
    verdict: 'host-enforced',
    reader: 'config/skill-overrides.ts',
    reason:
      'skill visibility is resolved in the capability layer before any runtime sees a skill, so the same '
      + 'override hides the same skill on all three runtimes with nothing to project',
  },
  crossSessionInbound: {
    keys: ['crossSessionInbound'],
    verdict: 'host-enforced',
    reader: 'server-core/src/sessions/cross-session-inbound.ts',
    reason:
      'the accept/hold/refuse ladder gates the HOST\'s own delivery of a cross-session message, which no '
      + 'runtime participates in',
  },
  useAutoModeDuringPlan: {
    keys: ['useAutoModeDuringPlan'],
    verdict: 'host-enforced',
    reader: 'config/auto-mode-during-plan.ts',
    reason:
      'it selects which of OUR mode managers answers during plan, and the answer path is the host\'s on '
      + 'every runtime',
  },
  env: {
    keys: ['env'],
    verdict: 'refused',
    reader: 'config/managed-env.ts + config/network-trust-scope.test.ts (the refusal, pinned)',
    reason:
      'a settings-file environment block is not honoured on ANY runtime by owner decision of 2026-09-05 '
      + '(refuse permanently and disclose the env-vars.md divergence), because once OS containment is off '
      + 'the table the only remaining control is a name allowlist against a threat model whose worst item '
      + 'is PATH — so projecting it into codex would be strictly wrong rather than merely absent',
  },
});

/**
 * The verdict for ONE top-level settings key, including the keys no family
 * claims.
 *
 * Exists so a caller never has to decide what an unlisted key means: the honest
 * answer for `statusLine`, `cleanupPeriodDays`, `apiKeyHelper` and the rest of
 * `settings-reference.md` is {@link CLAUDE_SETTINGS_UNREAD_BY_HOST} — nothing in
 * this product reads them on ANY runtime — and that is a different fact from
 * "codex cannot express it". Reporting the second where the first is true is how
 * a product-wide silence gets recorded as a codex defect.
 */
export function classifyClaudeSettingsFamilyKey(
  key: string,
): { family: string; entry: ClaudeSettingsCodexProjection } | typeof CLAUDE_SETTINGS_UNREAD_BY_HOST {
  for (const [family, entry] of Object.entries(CLAUDE_SETTINGS_CODEX_PROJECTION)) {
    if (entry.keys.some(spelling => spelling.split('.')[0] === key)) return { family, entry };
  }
  return CLAUDE_SETTINGS_UNREAD_BY_HOST;
}

/**
 * The line a codex session owes when its project settings carry a family this
 * runtime cannot honour.
 *
 * Same shape as {@link formatCodexInstructionExcludeDiagnostics} and its three
 * siblings, deliberately: pure, at most one line, and **empty when the session
 * carries none of these families** — a line that always prints is a line nobody
 * reads, which is the bound every diagnostic in this module respects.
 *
 * `host-enforced` and `projected` families are NOT named. Telling a user that a
 * setting which takes effect identically on every runtime "is not projected" is
 * the false-divergence direction, and it is worse than silence: it teaches the
 * reader to distrust the lines that are true.
 *
 * The families are passed IN — as the top-level keys the session's own settings
 * files carry — rather than read here, because this module is a dependency-free
 * leaf and the two files' readers live in `@nessy-agent/shared`.
 */
export function formatCodexClaudeSettingsProjectionDiagnostics(
  settingsKeys: readonly string[] | undefined,
): string[] {
  const present = new Set(settingsKeys ?? []);
  const named: string[] = [];
  for (const [family, entry] of Object.entries(CLAUDE_SETTINGS_CODEX_PROJECTION)) {
    if (entry.verdict !== 'unprojectable' && entry.verdict !== 'refused') continue;
    // A family is "carried" when ANY of its spellings is present: the two
    // instruction-exclude keys are one setting, and naming it twice would read
    // as two separate losses.
    const spelling = entry.keys.find(key => present.has(key.split('.')[0]!));
    if (!spelling) continue;
    named.push(`${family} (${spelling}) — ${entry.reason}`);
  }
  if (named.length === 0) return [];
  return [
    `codex-claude-settings-unprojected: this project's .claude settings carry ${named.length} `
    + `family${named.length === 1 ? '' : 's'} codex does not honour: ${named.join('; ')}. `
    + 'The permission block in the same file DOES take effect here, and every other family it carries is '
    + 'applied by the host identically on all three runtimes — so this line names the whole of the '
    + 'difference, not the whole file.',
  ];
}

/**
 * F1.192 — anchor the `~/` credential floor on the LATCHED home, absolute, when
 * the codex child will expand `~` against a DIFFERENT home.
 *
 * **codex expands a `~/` key with its OWN home.** Read at `rust-v0.154.0` (the tag
 * `codex-protocol/manifest.json` pins): a `~/` filesystem key reaches
 * `parse_absolute_path_for_platform` (`codex-rs/core/src/config/permissions.rs`)
 * and then `AbsolutePathBuf::from_absolute_path`, whose `maybe_expand_home_directory`
 * (`codex-rs/utils/absolute-path/src/lib.rs`) splices in a thread-local home that is
 * set only inside `AbsolutePathBufGuard::with_home_directory`, and otherwise
 * `dirs::home_dir()` — on unix the child's `HOME` when non-empty, else the passwd
 * entry. The app-server is spawned with `{ ...process.env, … }` (`codex-agent-server`
 * `runtime-manager.ts`), so once `applyManagedEnv` writes a confirmed administrator
 * `HOME` the next spawn compiles `~/.nessy` against THAT home, while
 * `~/.nessy/dp_auth_creds.json` stays under the latch (`getCredsPath`, P3.143).
 *
 * Measured with the vendored binary on 2026-09-23 (WJ-kk), fake creds files only:
 * `HOME=<managed>` with `"~/.nessy" = "deny"` → `command/exec cat
 * <latched>/.nessy/dp_auth_creds.json` exit 0 with the fake token printed, and the
 * managed twin refused; the absolute latched key → the latched read refused.
 * `__tests__/credential-floor-managed-home-live.test.ts` keeps that reading armed.
 *
 * **Only when the two homes differ — that is the control, not caution.** With an
 * unmoved `HOME` the input array comes back itself, so the emitted keys are
 * byte-identical to before and keep the platform-separator property recorded in
 * {@link mapDeniedPathsToCodexFilesystemKeys}'s docblock. Pinning `HOME` on the spawn
 * instead was refused (the row's reason): it would move codex's own home-relative
 * state, and `managed-env.ts`'s promise is about the credential source, not every path.
 *
 * Left alone, each for a stated reason: the bare-home shapes (`~`, `~/`, `~/**`),
 * so the mapper still refuses them as `bare-home` — rewriting `~/**` would deny the
 * whole home; every non-`~/` pattern (absolute and `**\/` globs do not depend on a
 * home); win32, where `dirs::home_dir()` is the profile known-folder rather than
 * `HOME`, so a managed `HOME` does not move codex's `~`; and an unset or empty child
 * `HOME`, where codex falls back to the passwd entry — the latch's own startup
 * source in the ordinary case (the residue: a latch taken from a non-passwd `HOME`
 * that an administrator later EMPTIES is not re-anchored).
 */
export function anchorCodexFloorOnCredentialHome(
  patterns: readonly string[],
  opts: {
    /** The latched credential home. Default: {@link latchedHomeDir}. */
    readonly credentialHome?: string;
    /** The `HOME` the codex child will inherit. Default: this process's `HOME`. */
    readonly childHome?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): readonly string[] {
  if ((opts.platform ?? process.platform) === 'win32') return patterns;
  const childHome = 'childHome' in opts ? opts.childHome : process.env.HOME;
  if (!childHome) return patterns;
  const credentialHome = resolve(opts.credentialHome ?? latchedHomeDir());
  if (resolve(childHome) === credentialHome) return patterns;
  return patterns.map(pattern =>
    pattern.startsWith('~/') && pattern !== '~/' && pattern !== '~/**'
      ? `${credentialHome}${pattern.slice(1)}`
      : pattern);
}

// F1.192 — the one latch every credential reader shares; imported at the end so no
// line this file's citations name moves.
import { latchedHomeDir } from './home-latch.ts';

/**
 * **F1.787 — `plan` (and the retired `explore`) keeps codex's `:read-only` parent whatever the
 * sandbox master switch says.** Owner decision 2026-09-26 (option B of the
 * decisions analysis, revisiting QX4 = A for these two modes).
 *
 * The parent used to follow the RESOLVED `sandbox_mode` alone, and with the
 * switch off (the shipped default) {@link resolveCodexRuntimePathPolicy} is
 * handed `danger-full-access` for every mode, so these two modes got
 * `:workspace` and an in-workspace `printf` or `apply_patch` landed with no
 * approval at all (WJ-crit-ff, 3 of 3). Native-first: codex's own built-in
 * `:read-only` (`BUILT_IN_PERMISSION_PROFILE_READ_ONLY`, `protocol/src/models.rs`)
 * is what the switch-ON table already selects for them, and the profile is emitted in both switch positions
 * whenever it has an entry (a `write` grant, a protected subpath or record deny, or the user's or an operator's own `deniedPaths`;
 * F1.1057 removed the shipped credential floor) — so this changes only the PARENT of a sandbox codex already runs, in two modes.
 *
 * Every other key is unchanged: the `write` grants from `writablePaths`, the
 * `deny` entries and the `":workspace_roots"` table ride on the new parent as they
 * do with the switch on. F1.1056 (2026-09-29) adds `dontAsk`, which that decision did not name: its
 * switch-ON row is `read-only` too, and Claude's `dontAsk` denies whatever Manual would prompt, so a
 * `:workspace` parent off the switch let an in-workspace write land unasked (C3.10's recorded finding).
 * In `dontAsk` a raised patch is then refused by the host unless a rule pre-approves it. (F1.1003
 * since passes plan's plans and data folders as `write` keys: `codexModeWritablePaths`, `CodexAgent`.)
 * Residue, stated: any folder outside a grant, as with the switch ON — a shell write is refused and a
 * patch raises an approval, which is why `formatCodexModeGuidance` (`mode-manager.ts`) says to write
 * the plan file "when you can".
 */
export function codexModeKeepsReadOnlyParent(mode: CodexConfigOptions['mode']): boolean { // F1.1124 — exported: CodexAgent.noteResolvedSandboxPolicy reads it
  return mode === 'plan' || mode === 'dontAsk'; // F1.1050: `explore` retired (read as plan upstream); F1.1056: dontAsk
}

/**
 * **F1.1027 — a deny-read entry's second cost: every codex thread open is slow.**
 * Stated because it is a latency the user feels and cannot explain (DN-198 measured
 * it, DN-221 read the source). Since F1.1057 the host adds no deny entry of its own
 * ({@link codexDenyReadEntryCount}), so this now fires only for the user's or an
 * administrator's `deniedPaths` entries and the host's protected-record denies.
 *
 * The mechanism, read in `openai/codex` at `rust-v0.156.1` (the shipped binary) and
 * unchanged at `rust-v0.157.1`, `rust-v0.158.0` and `main` (`44fe510ce3ee`, 2026-09-28):
 *
 *  - `core/src/agents_md.rs::load_project_instructions` hands its AGENTS.md walk a
 *    sandbox context whenever the profile lacks `has_full_disk_read_access()`, and
 *    `protocol/src/permissions.rs::has_denied_read_restrictions_for_convention` is
 *    true for ANY `Deny` entry. An exact path and a glob pattern (a top-level one or
 *    one under `":workspace_roots"`) are the same `Deny` entry there, so writing the
 *    floor as a pattern does not avoid it.
 *  - `exec-server/src/local_file_system.rs::file_system_for_reads` then routes each
 *    `get_metadata` through the sandboxed file system, and
 *    `exec-server/src/fs_sandbox.rs::run_command` spawns one `sandbox-exec` →
 *    `codex-app-server --codex-run-as-fs-helper` process PER REQUEST.
 *  - The walk asks many of them at once: `file-system/src/find_up.rs` probes the
 *    root marker in EVERY ancestor of the cwd concurrently (`MAX_CONCURRENT_PROBES`
 *    = 256), then `agents_md_paths` probes up to four names per directory from the
 *    project root down (`MAX_CONCURRENT_ANCESTOR_PROBES` = 256).
 *
 * Measured on the shipped darwin-arm64 binary, scratch `CODEX_HOME`, one exact
 * deny path, cwd nine directories deep and outside git: `thread/start` 17.2 s and
 * `thread/fork` 18.5 s, with ten helper processes alive at once, each for 7-16 s,
 * then four more one at a time. The cost is the EXEC, not the sandbox: the helper
 * replayed outside codex took 1.7-1.8 s alone and 17.6-18.2 s for ten in parallel
 * UNSANDBOXED, 2.5-2.8 s and 21.7-23.2 s under codex's own 14.7 KB profile, and
 * `sandbox-exec` running `/usr/bin/true` 1.5-2.8 s, on a host whose
 * endpoint-security agents gate every exec and serialise parallel ones (`/bin/echo`
 * 3 ms there). DN-198's range over deeper cwds is 13-49 s, against 2.4 s and
 * 267 ms with no deny entry, where no helper is spawned at all.
 *
 * No native lever exists. codex has no key that keeps discovery unsandboxed or
 * bounds its probes, and the three that shrink it each drop instructions:
 * `project_doc_max_bytes = 0` skips AGENTS.md entirely, `project_root_markers = []`
 * stops reading the parent directories, and an untrusted project skips the walk.
 * So codex's own loader stays and this line names the price of a deny entry.
 * Emitted on the same sink and cadence as its siblings, and only while a deny
 * entry reaches codex: a write grant alone leaves full-disk read in place and
 * spawns nothing.
 */
export function formatCodexDenyReadDiscoveryCostDiagnostics(
  opts: Pick<CodexConfigOptions, 'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths'>,
): string[] {
  const denyEntries = codexDenyReadEntryCount(opts);
  if (denyEntries === 0) return [];
  return [
    `codex-deny-read-slows-thread-open: ${denyEntries} deny-read entr${denyEntries === 1 ? 'y' : 'ies'}`
    + ' reach this codex session (your deniedPaths entries, or the protected records an added'
    + ' directory covers; Nessy adds no credential entry of its own on codex), so codex reads its'
    + ' AGENTS.md chain through its sandboxed file-system helper, one helper process per probe (every'
    + ' parent folder of the working directory, then up to four file names per folder). Opening,'
    + ' resuming, branching or re-forking a codex thread measured 13-49 s on codex 0.156.1 on a host'
    + ' whose security agent checks every process start, against 0.1-2.5 s with no deny entry. codex'
    + ' has no setting that keeps this walk unsandboxed without dropping the instructions, and writing'
    + ' an entry as a pattern instead of a path does not change it; remove the entry from deniedPaths'
    + ' to open threads fast.',
  ];
}

/**
 * **F1.1057 — how many `Deny` entries this options object puts in codex's
 * permission profile**: the exact `deniedReadPaths`, the mirrored `deniedPaths`
 * keys and the `":workspace_roots"` deny globs, as {@link resolveCodexRuntimePathPolicy}
 * writes them (a mirrored key landing on an exact deny is one TOML key, so one entry).
 *
 * Owner decision 2026-09-28: "делаем ровно так как делает сам кодекс" — codex runs
 * with its OWN defaults, so the host no longer adds its shipped credential floor
 * (the `deniedPaths` of `default.json`) or its `credentials.enc` exact deny to this
 * profile; only the user's or an administrator's own `deniedPaths` entries, and the
 * host's protected-record denies, still arrive here (`CodexAgent.credentialFloorPatterns`
 * reads `deniedPathsBeyondShippedFloor`, `permissions-config.ts`). Measured on the
 * shipped 0.156.1 (DN-242, scratch CODEX_HOME, product config, cwd five deep outside
 * git): with the host floor `thread/start` 27.2 s and 30.4 s, `thread/fork` 23.9 s and
 * 23.7 s; without it start 0.09-2.5 s and fork 0.10-0.25 s with no `sandbox_execute`
 * span at all. Stated consequence: a codex command can read Nessy's credential files,
 * `~/.ssh` and the rest of that list like any file codex's own sandbox allows.
 *
 * Non-zero is also the one condition under which codex keeps an APPROVED command
 * inside its sandbox (`sandbox_override_for_first_attempt`, `core/src/tools/sandboxing.rs`
 * at `rust-v0.156.1`), which is what F1.780's `codexCommandStaysSandboxed` asks.
 *
 * UA12.3 (DECIDED 2026-10-09, the same posture): the four UA1.10 PATTERN records
 * (`GUARDED_WORKSPACE_RECORD_PATTERNS` in `@nessy-agent/shared` `agent/core/pre-tool-use.ts`:
 * a task spec, a page config, a project config and its context) never enter this profile as
 * `deny` globs. Read at the shipped `rust-v0.159.3`: a glob is accepted only as `deny`
 * (`codex-rs/core/src/config/permissions.rs`, "only supports `deny` access"), and ANY `Deny`
 * entry makes `has_denied_read_restrictions_for_convention` true, so `has_full_disk_read_access`
 * is false and `codex-rs/core/src/agents_md.rs` sandboxes the AGENTS.md walk
 * (`codex-rs/protocol/src/permissions.rs`) — the thread-open cost above, in every codex session
 * — and a `deny` would also refuse agent commands every READ of those files. Residue, stated: a
 * codex command whose writable root holds the workspace root can write the four records unasked;
 * the host trusts the MACed ledger digest for them (`approvals/host-approvals.ts`), never the
 * file, and Pi and Claude keep the host's own refusal.
 *
 * UA12.8 (DECIDED 2026-10-09, the same posture): the t-artifacts registry pattern
 * `**\/workspaces/*\/artifacts/registry.json` (UA1.16) is part of the shipped floor (`default.json`
 * and `SAFE_MODE_CONFIG`), so it never reaches this profile either: a codex command can read
 * `<config dir>/workspaces/<id>/artifacts/registry.json` (and, by code reading, write it when its
 * cwd is the workspace root). Residue, stated: the file holds no credential (artifact ids, URLs,
 * titles, source paths, digests, pending deletions) and the service, not the file, is the source
 * of truth for the list. The finding's premise — this mirror scopes the glob to the workspace, so it
 * misses the config-dir copy — now holds only for a user's or operator's own entry spelled that way.
 * The WRITE side is NOT left as a residue (UA12.8 follow-up, LF-2-fix 2026-10-09, P-LF-2-1 landed
 * as CRITICAL): the host TRUSTS this file, and one of its decisions is irreversible. An entry
 * carrying `pendingDelete` is DELETED on the service with the user's token and no card, at the
 * next Artifacts list or dp `ready` boundary (`retryOwedArtifactDeletes` in `@nessy-agent/server-core`
 * `handlers/rpc/artifacts.ts`), so a command that ADDS the field deletes the user's published pages
 * silently; a forged `sourceSessionId` reaches the `publish_artifact` update card (still asked), and
 * a dropped `pendingDelete` leaves the page on `/api/artifacts/mine`. So `codexWorkspaceRecordNames`
 * in `@nessy-agent/shared` `agent/codex-agent.ts` carries the exact `artifacts/registry.json` beside
 * the guarded records: a `":workspace_roots"` `read` subpath when the cwd covers the workspace root
 * (no `Deny` entry, so no thread-open cost; reads kept), the records' absolute `deny` when only an
 * added directory does. Measured 2026-10-09 on the shipped codex-app-server 0.159.3 (`default`,
 * `command/exec`, cwd a workspace root under `$HOME`): without it the write, an unlink, a create
 * and `mv artifacts` exit 0; with it all four fail `Operation not permitted`, the read and a
 * sibling `artifacts/other.txt` write still work. Residue, stated: the read side above; a project
 * session needs nothing (the workspace root is outside codex's roots, so codex asks); the host still
 * trusts an owed deletion it did not record (a MACed ledger for owed deletes is proposed, DEFERRED).
 * Pi and Claude refuse a TOOL write through the deniedPaths floor; for a shell command there the
 * floor is the host's path scan under the mode's ask, not an OS refusal (not measured here).
 */
export function codexDenyReadEntryCount(
  opts: Pick<CodexConfigOptions, 'deniedReadPaths' | 'deniedReadPatterns' | 'writablePaths'>,
): number {
  const mapping = resolveDeniedPatternMapping(opts);
  const denyKeys = new Set([...normalizeRuntimePaths(opts.deniedReadPaths, 'denied-read'), ...mapping.keys]);
  return denyKeys.size + mapping.workspaceGlobs.length;
}

/**
 * F1.1075 (DN-273, 2026-09-29) — the profile's own `description`, one string for the TOML table and the per-thread
 * JSON layer. It named a "host credentials policy" after F1.1057 removed the credential floor from the profile; what
 * keeps a profile in every session is the protected-folder floor (C3.343), beside the plugin data and any denied
 * paths. The text rides `codexThreadConfigSignature` through the JSON layer, but that signature lives in memory for
 * one runtime build and both of its sides are computed by the same code, so rewording it forces no re-fork.
 */
const CODEX_RUNTIME_PROFILE_DESCRIPTION = 'Nessy runtime: protected folders, managed plugin data and denied paths';
