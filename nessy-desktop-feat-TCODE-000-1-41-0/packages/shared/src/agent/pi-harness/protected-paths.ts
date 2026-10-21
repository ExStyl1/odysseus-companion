/**
 * Protected paths: the safety floor that sits ABOVE allow rules.
 *
 * Contract source, fetched with `curl -s https://code.claude.com/docs/en/permission-modes.md`
 * on 2026-07-30, re-fetched 2026-08-23, and re-fetched again 2026-08-25 (598
 * lines, md5 `44fa3a908750c261d5d5282377350a88`). The `sandboxing.md` citations
 * were re-fetched the same day (677 lines, md5
 * `3538c3dd04b83d8bbaa35d0fad0ccb88`).
 *
 * EVERY CITATION IN THIS COMMENT BLOCK was re-measured against that 2026-08-25
 * pair, and every one NAMES A QUOTED SENTENCE OR A NAMED SYMBOL AS ITS ANCHOR:
 * the line numbers are a convenience. They had to move again — the whole
 * "Protected paths" section shifted UP FOURTEEN LINES between 2026-08-23 and
 * 2026-08-25 — which is the third consecutive fetch to invalidate this file's
 * numbers and the reason the sentence, not the number, is the identifier. The
 * numbers this file carried before (`:433`/`:435`-`:441`/`:443`/`:445`-`:456`/
 * `:455`/`:458`-`:469` from 2026-07-30, then `:531`/`:533`-`:539`/`:541`/
 * `:543`-`:554`/`:556`-`:566` and `sandboxing.md:555` from 2026-08-23) all
 * point elsewhere now.
 *
 * `permission-modes.md:517`: "Writes to a small set of paths are never
 * auto-approved, except in `bypassPermissions` mode and in planning sessions with
 * bypass permissions available. This prevents accidental corruption of repository
 * state and Claude's own configuration."
 *
 * `permission-modes.md:519`-`:525`, the per-mode table, TRANSCRIBED FROM THE
 * 2026-08-25 FETCH — and OURS DIFFERS ON TWO ROWS, deliberately and in the
 * strict direction. The page:
 *
 * | Mode                     | Protected-path writes (THE PAGE)                 |
 * | ------------------------ | ------------------------------------------------ |
 * | `default`, `acceptEdits` | Prompted                                         |
 * | `plan`                   | Allowed in sessions with bypass permissions       |
 * |                          | available. Otherwise, routed to the classifier    |
 * |                          | when auto mode is available during planning, and  |
 * |                          | prompted when it isn't                            |
 * | `auto`                   | Routed to the classifier                         |
 * | `dontAsk`                | Denied                                           |
 * | `bypassPermissions`      | Allowed                                          |
 *
 * Ours is `protectedPathOutcome` below, and its docstring carries the whole
 * argument. In one line: `plan` PROMPTS unconditionally and `auto`'s prompt
 * reaches the HUMAN rather than the classifier, so this floor takes the
 * strictest of the page's answers in both rows. Earlier revisions of this
 * comment transcribed the page's `plan` row as a bare "Prompted", which was
 * lossy even against the 2026-07-30 fetch (that row already had three
 * outcomes); what genuinely changed since is that there is no unconditional
 * "Prompted" row on the page at all, which is why the divergence is stated
 * here instead of hidden inside a single word.
 *
 * `permission-modes.md:527` is the load-bearing sentence and the reason a deny
 * rule cannot substitute for this: "`permissions.allow` rules in settings files do
 * not pre-approve protected-path writes. The safety check runs before Claude Code
 * evaluates allow rules from settings, so an entry such as `Edit(.claude/**)` in
 * `~/.claude/settings.json` or `.claude/settings.json` does not change the
 * per-mode outcome in the table above."
 *
 * That ORDERING is the feature. A deny rule is evaluated in the same pass as the
 * allow rules and can be out-specified by one; this check is evaluated first and
 * cannot be reached by any rule at all. `sandboxing.md:557`, the
 * `--dangerously-skip-permissions` row, states the other end of the same rule —
 * "Protected path checks are also skipped" once the row's doc link is collapsed
 * — so the floor really is bypassable at the top of the ladder and is NOT a hard
 * block like the removal circuit breaker. (`sandboxing.md:555` cited here on
 * 2026-08-23 is the `/sandbox` row of that same table on the 2026-08-25 fetch,
 * two rows up.)
 *
 * Pure string semantics, no I/O and no permission decision — the caller
 * (`core/pre-tool-use.ts`) turns a hit into the prompt or the denial, and does so
 * BEFORE step 6, which is where allow rules and remembered approvals are read.
 *
 * ## The decisions, and why
 *
 * - **Segment matching, not path resolution.** A protected DIRECTORY matches when
 *   its (possibly multi-segment) name appears anywhere in the target's segments;
 *   a protected FILE matches on the basename. This is deliberately independent of
 *   the working directory: the documented list mixes repository-relative entries
 *   (`.git`, `.husky`) with home-relative ones (`.zshrc`, `.claude.json`), and a
 *   floor that only fired inside the workspace would miss every shell rc. It also
 *   means the floor holds for a path the gate has not expanded yet, which is where
 *   it runs.
 * - **A false positive is cheap here, a false negative is not.** The outcome in
 *   every mode that can prompt is a PROMPT, not a block, so an over-broad match
 *   costs one click. `.claude` matched as a plain filename, or `.git` inside a
 *   vendored dependency, therefore both fire.
 * - **`.claude/worktrees` and our equivalent.** The documented exception exists
 *   because Claude stores its own git worktrees INSIDE its protected config
 *   directory. Nessy does not: `worktree-layout.ts:13` puts them at
 *   `<dirname(repoRoot)>/.nessy-worktrees/<repo-slug>/<leaseId>`, outside the
 *   repository and outside every config directory, so nothing of ours needs the
 *   carve-out. It is still emitted — verbatim for `.claude`, because we read
 *   Claude project settings and `enabledPlugins` out of that directory and a
 *   Claude-managed `.claude/worktrees` can exist in a Nessy workspace, and
 *   mirrored for `.nessy-agent`/`.agents` so a later layout change cannot turn
 *   this floor into a worktree blocker.
 * - **Our config directories are added to the protected set.** `.claude` is
 *   listed because it is Claude's own configuration; ours are `.nessy-agent` and
 *   `.agents` (`session-filesystem-scope.ts`'s `AGENT_CONFIG_DIRS`, `:107` —
 *   `:106` cited here before is the blank line above it), which carry the same trusted
 *   config, hooks and skills. Leaving them out would protect the imported
 *   vendor's config and not our own.
 *
 * ## Known limits (deliberate)
 *
 * - **File tools only.** The documented mechanism is about writes by the edit
 *   tools, and the prompt it describes ("Yes, and allow Claude to edit its own
 *   settings for this session") is a file-write prompt. A `Bash` redirect into a
 *   protected path is governed by the OS sandbox's deny roots
 *   (`isolation/self-config-deny.ts`, `sandboxing.md:463`: "Inside the
 *   directories that sandboxed commands can write to, the sandbox still denies
 *   writes to the files Claude Code loads configuration and code from.").
 *
 *   **C3.379 — and in the SHIPPED posture that governor is OFF, so read the
 *   sentence above as "governed, WHEN an operator turns the sandbox on".**
 *   `packages/shared/src/config/sandbox-settings.ts` symbol
 *   `SANDBOX_ENABLED_DEFAULT` is `false` (the standing owner decision), and
 *   `packages/server-core/src/pi-harness/process-supervisor.ts` symbol
 *   `resolveIsolationDowngrade` then short-circuits to
 *   `{ reason: 'sandboxDisabled' }` before any isolation plan is resolved, so
 *   `selfConfigDenyWriteRoots` composes nothing on a default install. The
 *   condition and both of its existing pins are restated at that function's own
 *   docblock, so this bullet and the set it names cannot drift apart silently.
 *
 *   What DOES bind on a default install is the shell floor beside this one:
 *   `packages/shared/src/agent/core/pre-tool-use.ts` symbol
 *   `findAgentConfigShellWrite` (C3.353) reads the same four agent-config
 *   directories out of a `Bash` command line and raises the same card.
 *
 *   **C4.50 (owner decision 2026-09-13, option B) closed the FILE half of that
 *   delta, and this bullet asserted the opposite until then.** It read *"it
 *   covers the DIRECTORIES only — the protected FILES and `.git` are not in its
 *   list"*, and the files ARE in its list now, through
 *   {@link findProtectedFileWrite} — this file's own basename test reached by
 *   the shell gate, not copied into it. What survives of the delta is
 *   deliberate: `.git` and the rest of {@link PROTECTED_DIRECTORIES} stay OUT of
 *   the shell gate, because a `.git` entry would refuse the `git commit` this
 *   floor's own docblock says must remain the only writer, so the shell gate's
 *   directory list is `SHELL_GATED_AGENT_CONFIG_DIRS` (four entries) while its
 *   file list is the whole of {@link PROTECTED_FILES}. Its command reading
 *   stopped being a positive word list at C3.378; with no permissions context it
 *   still falls back to one, so on that path alone an in-place editor, an
 *   archive extraction or an inline interpreter walks past it.
 *
 *   **That deny set is OURS, and it is narrower than the page's — the two claims
 *   must not be hung on one citation.** `sandboxing.md:466` lists, as denied in
 *   the working directory, "shell startup files such as `.bashrc` and `.zshrc`,
 *   `.gitconfig`, the `.vscode` and `.idea` directories, and `hooks` and
 *   `config` inside `.git`". `selfConfigDenyWriteRoots` names none of those: its
 *   roots are `<workspace>/.claude`, `.nessy-agent` and `.agents`, six
 *   config-dir entries (five files plus the `permissions` directory),
 *   `~/.claude`, `~/.claude.json`, the managed settings directory and the win32
 *   system roots (re-read 2026-08-25). So "covers the
 *   config directories but not the shell rcs" is a statement about
 *   `self-config-deny.ts` and is FALSE of `sb:463`/`:466`, which is why it now
 *   names its subject. The residual capability delta — a sandboxed `Bash`
 *   redirect may write `.bashrc` here where the page denies it — is recorded in
 *   `plans/2026-07-30-sandbox-mach-and-protected-paths.md` § 5 item 5.
 * - **No session-scoped "and allow my own settings" grant.** The second half of
 *   `:527` — "In modes that prompt, the prompt for a `.claude/` write offers
 *   **Yes, and allow Claude to edit its own settings for this session**, which
 *   approves later `.claude/` writes in that session without prompting again" —
 *   describes a per-session remember for `.claude/` writes. This floor carries no
 *   don't-ask-again at all, which is stricter than documented. Recorded in § 5.
 */

import type { PermissionMode } from '../mode-types.ts'

/** What a protected-path write resolves to in a given permission mode. */
export type ProtectedPathOutcome = 'prompt' | 'deny' | 'allow'

export interface ProtectedPathWrite {
  /** The write target exactly as the tool named it. */
  target: string
  /** The protected entry that matched, as it appears in the documented list. */
  entry: string
  kind: 'directory' | 'file'
  /**
   * F1.858 — how the gate knows this call reaches the entry. Absent: it is a
   * write the gate has seen (a file tool's target, a shell redirect target).
   * `'unproven'`: a shell command that NAMES the path and that the read-only
   * classifier could not prove is a read (`core/pre-tool-use.ts` symbol
   * `findAgentConfigShellWrite`, its reading 2) — fail-closed, so it is judged
   * as a write, but the card must not tell the user it writes (SIT-y: a listing
   * of the session's own folder was worded "This writes to …").
   */
  access?: 'unproven'
}

/**
 * `permission-modes.md:529`-`:540`, the "Protected directories:" list — the
 * heading is on `:529`, it opens on `:531` with "`.git`" and closes on `:540`
 * with "`.claude`, except for `.claude/worktrees` where Claude stores its own git
 * worktrees" — plus our own two config directories. (The `:543`-`:554` cited
 * here on 2026-08-23 now covers the protected-FILES list and ends on the
 * "Critical paths" heading, a DIFFERENT floor.)
 *
 * Multi-segment entries are matched as a segment SEQUENCE, so `.config/git` does
 * not fire on a bare `git/` directory.
 */
export const PROTECTED_DIRECTORIES: readonly string[] = [
  '.git',
  '.config/git',
  '.vscode',
  '.idea',
  '.husky',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
  '.claude',
  // Nessy's own equivalents of `.claude` — same trusted config, hooks and skills.
  '.nessy-agent',
  '.agents',
  // codex's own project config root, the same class of trusted config. Listed on
  // every runtime rather than only codex: this floor is host-side and shared, and
  // `session-filesystem-scope.ts`'s `AgentConfigDeniedError` names `.codex` in its
  // own docstring. No `worktrees` carve-out — codex stores none there.
  '.codex',
]

/**
 * Segments that are NOT protected even though they sit inside a protected
 * directory. `permission-modes.md:540` names exactly one such carve-out —
 * "`.claude`, except for `.claude/worktrees` where Claude stores its own git
 * worktrees" — and it is mirrored onto our config directory names.
 */
export const PROTECTED_DIRECTORY_EXCEPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.claude', ['worktrees']],
  ['.nessy-agent', ['worktrees']],
  ['.agents', ['worktrees']],
])

/**
 * `permission-modes.md:542`-`:552`, the "Protected files:" list — the heading is
 * on `:542`, it opens on `:544` with "`.gitconfig`, `.gitmodules`" and closes on
 * `:552` with "`.mcp.json`, `.claude.json`". Matched on the basename. (The
 * `:556`-`:566` cited here on 2026-08-23 now spans the "Critical paths" intro
 * and the whole of ITS per-mode table — a different floor with different
 * answers, which is the expensive way for a stale range to be wrong.)
 */
export const PROTECTED_FILES: readonly string[] = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_aliases',
  '.bash_logout',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.profile',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnp.cjs',
  '.pnp.loader.mjs',
  '.pnpmfile.cjs',
  'bunfig.toml',
  '.bunfig.toml',
  '.bazelrc',
  '.bazelversion',
  '.bazeliskrc',
  '.pre-commit-config.yaml',
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  'gradle-wrapper.properties',
  'maven-wrapper.properties',
  '.devcontainer.json',
  '.ripgreprc',
  'pyrightconfig.json',
  '.mcp.json',
  '.claude.json',
]

/**
 * OUR per-mode outcome — not a transcription of the page's table. Two of the
 * seven rows deviate from `permission-modes.md:519`-`:525` deliberately, both
 * toward the strict side, and this docstring is where that is argued. What IS
 * shared with the page: the rows are not interchangeable, and in particular
 * `dontAsk` DENIES where `bypassPermissions` ALLOWS.
 *
 * - `default` (the page's `ask`) and `acceptEdits` prompt, as documented.
 * - `plan` PROMPTS, UNCONDITIONALLY — **deviation, stricter.** The page's `plan`
 *   row (`:522`) has three outcomes: "Allowed in sessions with bypass
 *   permissions available. Otherwise, routed to the classifier when auto mode is
 *   available during planning, and prompted when it isn't". We take the third in
 *   every case. Note this is a CHOICE and no longer a capability gap: a
 *   bypass-availability predicate does exist (`pi-agent.ts`'s
 *   `bypassPermissionsAvailable()`), but it is read on exactly one row — the
 *   removal circuit breaker's plan-mode classifier route — and never here, and
 *   `planClassifierEligible`'s floor branch admits only
 *   `promptIsClassifierAdjudicated` prompts, which the gate stamps on the
 *   breaker alone. So no protected-path write in `plan` reaches the classifier
 *   or an auto-allow, whatever the session can cycle to.
 * - `explore` is a Nessy-only read-only mode with no Claude row (its config is
 *   still spelled `SAFE_MODE_CONFIG` in `mode-types.ts`); it is stricter than
 *   `plan`, so it takes the same answer. `explore` and `plan` are both
 *   unreachable in practice, because `shouldAllowToolInMode` already blocks the
 *   write before the floor's prompt can be returned — stated here so the table
 *   is total rather than relying on that.
 * - `auto` prompts, and the prompt reaches the HUMAN — **deviation, stricter.**
 *   The floor is `nonNegotiable: 'protectedPath'` and carries no
 *   `autoClassifierAdjudicated` marker, so `pi-agent.ts`'s
 *   `autoBorderlineEligible` (`!promptIsNonNegotiable(...) ||
 *   promptIsClassifierAdjudicated(...)`) is false for it and the guardian
 *   classifier is never consulted. That is the opposite of the page's "Routed to
 *   the classifier" row, on purpose: a judge `no_objection` must not convert a
 *   floor into an allow.
 * - `bypassPermissions`: allowed, as documented. Unlike the removal circuit
 *   breaker, this floor is explicitly bypassable at the top of the ladder.
 */
export function protectedPathOutcome(mode: PermissionMode): ProtectedPathOutcome {
  if (mode === 'bypassPermissions') return 'allow'
  if (mode === 'dontAsk') return 'deny'
  return 'prompt'
}

/** Splits on both separators so a win32 path is matched the same way. */
function pathSegments(target: string): string[] {
  return target.split(/[/\\]+/).filter(segment => segment.length > 0 && segment !== '.')
}

function matchesDirectory(segments: string[], entry: string): number {
  const entrySegments = entry.split('/')
  for (let index = 0; index + entrySegments.length <= segments.length; index += 1) {
    if (entrySegments.every((part, offset) => segments[index + offset] === part)) {
      const exceptions = PROTECTED_DIRECTORY_EXCEPTIONS.get(entry)
      const next = segments[index + entrySegments.length]
      if (exceptions && next !== undefined && exceptions.includes(next)) continue
      return index
    }
  }
  return -1
}

/**
 * The protected entry this write target falls under, or null.
 *
 * `target` is the path as the tool named it — relative, `~`-prefixed or absolute
 * all work, because the match is on segments.
 */
export function findProtectedPathWrite(target: string | undefined): ProtectedPathWrite | null {
  if (!target || target.trim().length === 0) return null
  const segments = pathSegments(target)
  if (segments.length === 0) return null

  for (const entry of PROTECTED_DIRECTORIES) {
    if (matchesDirectory(segments, entry) >= 0) return { target, entry, kind: 'directory' }
  }
  return findProtectedFileWrite(target)
}

/**
 * The FILE half of {@link findProtectedPathWrite}, on its own — the basename
 * test against {@link PROTECTED_FILES} and nothing else.
 *
 * C4.50 (owner decision 2026-09-13, option B). It exists so the SHELL gate
 * (`core/pre-tool-use.ts` symbol `findAgentConfigShellWrite`) can reach the
 * protected FILES without reaching {@link PROTECTED_DIRECTORIES} — and that
 * exclusion is the whole reason it is a separate export rather than a second
 * call to `findProtectedPathWrite`. `.git` is a protected DIRECTORY, `git
 * commit` writes there on every turn, and
 * `session-filesystem-scope.ts` says git-via-shell *"remains the only writer"*;
 * a shell gate that called the whole matcher would refuse it. The shell gate's
 * directory list stays `SHELL_GATED_AGENT_CONFIG_DIRS` (four entries, no
 * `.git`), and this function supplies the file list unchanged.
 *
 * ONE basename test, shared: the file tool and the shell path now answer for
 * `.zshrc` out of the same array and the same comparison, so the same byte
 * written two ways cannot get two answers — which is exactly the hole C4.50
 * was born for (`>> ~/.zshrc` through `Bash` raised no card at HEAD while
 * `Write {file_path:'~/.zshrc'}` raised the floor; measured 2026-09-13).
 */
export function findProtectedFileWrite(target: string | undefined): ProtectedPathWrite | null {
  if (!target || target.trim().length === 0) return null
  const segments = pathSegments(target)
  const basename = segments[segments.length - 1]
  if (basename !== undefined && PROTECTED_FILES.includes(basename)) {
    return { target, entry: basename, kind: 'file' }
  }
  return null
}

/**
 * The description the user reads on the prompt. It names the entry that matched
 * and why the prompt appeared despite the mode — a prompt indistinguishable from
 * every other prompt collects the same reflexive approval.
 *
 * F1.858 — an `'unproven'` hit (see {@link ProtectedPathWrite.access}) opens with
 * what the gate actually knows, "could not be confirmed as read-only", instead of
 * "This writes to": the prompt and its outcome are the same, only the claim is.
 */
export function describeProtectedPathWrite(hit: ProtectedPathWrite): string {
  const what = hit.kind === 'directory'
    ? `the protected directory \`${hit.entry}\``
    : `the protected file \`${hit.entry}\``
  const opening = hit.access === 'unproven'
    ? `This command names ${what}: \`${hit.target}\`, and it could not be confirmed as read-only, `
      + 'so it is treated as a write there. '
    : `This writes to ${what}: \`${hit.target}\`. `
  const closing = hit.access === 'unproven'
    ? 'Approve if it only reads there, or if you meant to change how this project or this machine runs commands.'
    : 'Approve only if you meant to change how this project or this machine runs commands.'
  return opening
    + 'Repository state, shell startup files and agent configuration are never approved '
    + 'automatically — a permission rule that names this path does not skip this prompt, '
    + 'because the check runs before those rules are read. ' + closing
}
