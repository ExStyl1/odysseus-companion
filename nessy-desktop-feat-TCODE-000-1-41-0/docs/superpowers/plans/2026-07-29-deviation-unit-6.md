# Deviation Unit 6 — rule sources and destinations

**Status:** closed
**Source:** `docs/superpowers/specs/2026-07-29-deviation-worklist.md` § 3, Unit 6
**Branch:** `fix/renderer`
**Base:** `f65faf16`

Five rows, each needing a surface that did not exist. Three of the five share
one settings reader/writer, which is built once and used by all three. One
commit per row, each with an explicit pathspec.

## Contract source — re-fetched raw, cites re-derived against the fetched files

```
curl -sL https://code.claude.com/docs/en/permissions.md   #  567 lines
curl -sL https://code.claude.com/docs/en/settings.md      # 1205 lines
curl -sL https://code.claude.com/docs/en/hooks.md         # 3162 lines
```

Every line number below was read out of the file fetched in this session. The
sibling plans record non-uniform drift on these pages, so nothing was carried
over from an earlier unit.

`permissions.md:15` — the tier table this unit turns on twice:

| Tool type | Approval required | "Yes, don't ask again" behavior |
| --- | --- | --- |
| Read-only | No, within the working directory | N/A |
| Bash commands | Yes, except read-only commands | **Permanently per repository and command** |
| File modification | Yes | **Until session end** |

`permissions.md:21` — "When you choose 'Yes, don't ask again' and the approval
saves permanently, such as for a Bash command, Claude Code saves the rule to
`.claude/settings.local.json` at the root of the git repository, resolved
through worktrees to the main checkout. […] Outside a git repository, and when
the repository root is your home directory, Claude Code saves the rule in the
directory you started it from."

`permissions.md:138` — "The permission dialog writes the space-separated form
when you select 'Yes, don't ask again' for a command prefix."

`permissions.md:237`, `:253`, `:255` — the three PowerShell rules: same shape as
Bash rules; "Common aliases are canonicalized before matching […] Matching is
case-insensitive"; and the compound-command split on `|`, `;`, `&&`, `||` where
"A rule must match every subcommand for the compound command to be allowed."

`permissions.md:397`–`:409` — the whole `Cd` section, including the matching
table transcribed verbatim into `cd-permission-rules.test.ts`.

`permissions.md:534` — "`permissions.allow` rules and
`permissions.additionalDirectories` entries in a project's
`.claude/settings.json` grant capability, so Claude Code applies them only after
you accept the workspace trust dialog for that workspace. Until then, Claude
Code reads the rules but doesn't apply them. […] `deny` and `ask` rules aren't
affected, since they only restrict."

`settings.md:22`, `:68` — Local is `.claude/settings.local.json` at the
repository root; the scope table places `~/.claude/settings.json`,
`.claude/settings.json` and `.claude/settings.local.json` across User, Project
and Local.

`hooks.md:1663`, `:1685`–`:1706` — `updatedPermissions` is allow-only; six entry
types; four destinations; and "A hook can echo one of the
`permission_suggestions` it received as its own `updatedPermissions` output,
which is equivalent to the user selecting that 'always allow' option in the
dialog."

## The five rows, in commit order

| # | Row | Commit |
| - | --- | ------ |
| 1 | `Cd(pattern)` rules are inert | `14fc9d0c` |
| 2 | `PowerShell(...)` rules are inert | `0b1e7641` |
| 3 | project `.claude/settings.json` is never parsed | `664d8e01` |
| 4 | "Yes, don't ask again" persists nothing | `cf3f7447` |
| 5 | `updatedPermissions` destinations/types/behaviors | `0dfb9807` |

## What became permitted, per row

Every row changes a permission decision, so each measured its own differential
against real compiled rules. Full numbers are in the commit bodies.

| Row | Configurations | Differ | Newly permitted | Newly refused | Lost |
| --- | --- | --- | --- | --- | --- |
| 1 | 168 (7 rule forms x 3 actions x 8 targets) | 73 | 0 | 56 | 0 |
| 2 | 216 (6 rule forms x 3 actions x 12 commands) | 54 | 10 allow | 13 deny + 31 ask | 0 |
| 3 | 210 (15 rule forms x 14 calls), trusted | 13 | 7 allow | 2 ask + 4 deny | 0 |
| 3 | 210, untrusted | 0 | 0 | 0 | 0 |
| 4 | 120 (5 prompt types x 24 commands) | 111 | 15 durable + 96 lifetime | 9 refused | 0 |
| 5 | 49 (6 types x 4 destinations x behaviors) | 9 | 9 entries apply | 0 | 0 |

Row 1's 73 changed decisions include 17 that became an explicit `allow` whose
observable outcome is identical to the old implicit prompt-and-proceed; only the
56 refusals are behaviour a user can see. Row 2's 10 grants are all
PowerShell-looking commands matching the rule as written, 7 of them through the
documented alias canonicalization or the `:*` form; 0 grants reach a command
`looksLikePowerShell` rejects. Row 4's 15 durable grants are 13 distinct
`Bash(<base> *)` rules, each a non-dangerous base command the user approved by
name; the 96 lifetime widenings are 10-minute windows becoming session windows,
which is the documented lifetime. Row 5's 9 are the deny/ask rule types that
previously applied nothing.

## The privilege boundary of the new settings writer

Rows 3, 4 and 5 together create a settings surface a model can influence, which
is the thing this unit had to get right.

**WHAT CAN WRITE.** Exactly two callers.
`SessionManager.persistBashAlwaysAllowRule`, reached only from
`respondToPermission` when the USER answered a `bash` prompt with Always Allow;
and `PiAgent.applyPermissionRequestUpdates`, reached only from a
`PermissionRequest` hook whose `allow` decision actually stood.

**WHAT CANNOT.** No tool, MCP server, plugin manifest or model output reaches the
writer directly. The rule string a human answer persists is derived from the
command the card showed, not from anything a caller supplies.

**WHAT STOPS A SESSION GRANTING ITSELF A RULE IT WAS DENIED.** Five independent
properties, each enforced at a different level:

1. **The writer is additive-only.** `claude-settings-store` has `add` and
   nothing else — no remove, no replace, no key deletion. A settings file it has
   touched is a strict superset of what it was, so no caller can delete a `deny`
   rule or shrink a list, whatever it asks for.
2. **It refuses to write when the existing file does not parse.** A file we
   cannot merge into is a file whose rules are currently in force and unknown to
   us; clobbering it would silently drop them.
3. **A persistent GRANT needs an offer.** A hook's `addRules` with
   `behavior: 'allow'` at a settings destination is accepted only when it echoes
   a `permission_suggestion` this host produced for that prompt — the documented
   meaning of the mechanism. Any other allow rule aimed at a file is refused.
   The offered set is threaded from the same `buildPermissionRequestSuggestions`
   call that produced it, so there is no second source of truth for what was
   offered.
4. **Removal is session-only.** `replaceRules`/`removeRules` operate on the
   in-memory session store and are refused outright at any settings destination,
   because "replaces all rules of the given behavior at the destination" would
   otherwise let a hook delete an administrator's deny list.
5. **A grant cannot outrank a restriction anyway.** Deny beats ask beats allow at
   equal weight; the files written are the Local and Project scopes, below
   managed; and a session `allow` goes to the session whitelist — which keeps its
   dangerous-base-command floor — rather than to the DSL layer, where an allow
   rule would bypass that floor.

Two smaller floors sit alongside: a dangerous base command is never persisted,
and neither is one whose LITERAL head is dangerous (`getBaseCommand` strips a
leading `sudo`, which is right for a session whitelist and wrong for a durable
rule — `Bash(apt *)` saved from `sudo apt install x` would grant unprivileged
`apt` in every future session off one privileged answer). An unbound session
persists nothing at all.

## How the "remembers this command for the session" label was resolved

**By changing the behaviour, not the label**, because permissions.md specifies
both halves of what the button should do and neither was implemented. The store
was a ten-minute hash-keyed window (cap 60) for every prompt type, described as
"for the session"; the label was false, and the behaviour was false to the docs
twice over.

Now: a Bash Always Allow writes `Bash(<base> *)` to the repository's
`.claude/settings.local.json` — "Permanently per repository and command" — and
every other Always Allow lasts the session — "Until session end". The label
becomes true, and it now says which of the two it is, because it is two
different things: `chat.permissionRemember.repository` for Bash,
`chat.permissionRemember.session` otherwise.

The privileged `admin_approval` path keeps its timed window and its 60-minute
cap. That class is ours, not Claude's, and the broker TTL is the point of it.

## Deviations recorded

| Subject | Category |
| --- | --- |
| `Cd(pattern)` whole-path matching, `*` one segment, `**` across, trailing `/**` matching its root (`permissions.md:405`) | `documented, implemented` |
| Bare `Cd` deny disables `/cd` entirely (`:399`) | `documented, implemented` |
| Any `Cd` allow rule switches to allowlist mode (`:401`) | `documented, implemented` |
| No `Cd` rules keeps the default prompt-to-trust (`:401`) | `documented, implemented` — the existing project-trust flow |
| The `/cd` surface itself | `documented, implemented` — no slash command exists; the equivalent user surfaces are the folder-picker RPC (`updateWorkingDirectory`) and project binding (`setSessionProject`), both routed through the one `mutateWorkingDirectory` transaction |
| `Cd` rules not applying to model-driven moves (`:397`) | `documented, implemented` — the worktree port does not opt in |
| "Deny rules check every spelling of the target, including each symlink hop" (`:399`) | `documented, not implemented — the transaction receives the user's spelling and its realpath, and both are checked, which covers the documented consequence ("a rule written for one path also blocks targets that resolve to it"). Intermediate links of a multi-hop chain are not enumerated: a rule naming a MIDDLE link would not match. Enumerating them needs a resolver that walks each hop, which the cwd transaction does not have and which no documented example requires` |
| Project-scope `Cd` rules | `documented, not implemented — the target of a cd is by definition a directory the session is not in yet, so the OLD project's rules would decide a move out of it while the NEW project's are not loaded until the move commits. The tier set is managed + global + workspace + source` |
| `Cd` `ask` rules | `documented, not implemented — permissions.md gives Cd only allow and deny semantics. An ask rule compiles and is treated as a pure restriction: it never enables allowlist mode and never grants, and its outcome is the same prompt an unruled session gets` |
| `PowerShell(...)` rule shape, wildcards, `:*`, bare `PowerShell`/`PowerShell(*)` (`:237`) | `documented, implemented` |
| Alias canonicalization and case-insensitive matching (`:253`) | `documented, implemented` |
| Compound-command split and the every-subcommand rule (`:255`) | `documented, implemented — via a pure splitter over the documented separator set with PowerShell quoting rules, not a real `pwsh` AST parse. The AST matcher we ship (`powershell-validator.ts`) `spawnSync`s a PowerShell process; a permission matcher runs on every rule for every call, must be synchronous and total, and must work where PowerShell is not installed` |
| A separate PowerShell tool | `documented, not implemented — this repo runs one shell tool, so a PowerShell rule is entitled to judge exactly the commands our own PowerShell routing treats as PowerShell (`looksLikePowerShell`, now the single predicate shared with `mode-manager`'s routing). The consequence is measurable: `PowerShell(Get-ChildItem *)` does not match a bare `dir`, and `PowerShell(git commit *)` does not match a bare `git commit`, because neither command reads as PowerShell` |
| `curl`/`wget` as `Invoke-WebRequest` aliases | `documented, not implemented — the two aliases exist in Windows PowerShell 5.1 only and were removed in PowerShell 7, and unlike every other alias their Unix meaning is a different and more capable program. An allow rule for `Invoke-WebRequest` must not become an allow rule for real curl` |
| Project `.claude/settings.json` allow/ask/deny (`:534`, `settings.md:68`) | `documented, implemented` |
| `.claude/settings.local.json` allow/ask/deny (`settings.md:22`) | `documented, implemented` |
| Allow rules requiring workspace trust (`:534`) | `documented, implemented` — measured: 7 grants with trust, 0 without |
| "`deny` and `ask` rules aren't affected, since they only restrict" (`:534`) | `documented, not implemented — the project capability inventory withholds EVERY project-scope record when the project is untrusted (`native-sources.ts`, one `blockedLayers` entry covering all `PROJECT_WITHHELD_KINDS`), so no project permission record is emitted at all pre-trust and the DSL's own project gate never sees one. Honouring restrict-only project rules before trust means changing that whole-inventory contract, not this reader. See propagation` |
| `.claude/settings.local.json`'s git-supplied exception (`:538`–`:547`) | `documented, not implemented — we treat the local file exactly like the project file: project scope, trust-gated. The documented exception turns on running git to decide whether the repository could have supplied the file, and on a configuration-home carve-out; both are absent. The direction of the divergence is the safe one — a file the user wrote themselves is gated more tightly than documented, never less` |
| A `/source`-anchored rule from a settings file | `documented, not implemented — the anchor needs the declaring settings file's directory, which the capability layer input does not carry, and compiling it without one fails the WHOLE layer closed, turning one unsupported rule into a deny of everything. Dropped with a diagnostic, which is the posture `parseManagedClaudeRulesV1` already takes on the same case` |
| `permissions.additionalDirectories` from a settings file (`:534`) | `documented, not implemented — no reader; out of this row's scope. See propagation` |
| `~/.claude/settings.json` (User scope) (`settings.md:68`) | `documented, not implemented — no reader exists for the user tier of Claude settings. See propagation` |
| Bash Always Allow saved per repository and command (`:15`, `:21`) | `documented, implemented` |
| Worktree resolved to the main checkout (`:21`) | `documented, implemented` — via `.git` file -> `gitdir:` -> `commondir` |
| Outside a repository, and repo root == home, saved in the starting directory (`:21`) | `documented, implemented` |
| The space-separated rule form (`:138`) | `documented, implemented` |
| File modification remembered until session end (`:15`) | `documented, implemented` — the window is now unbounded and cleared with the session record |
| A dangerous base command persisting a durable rule | `documented, not implemented — a durable repository grant for `rm`, `sudo`, `curl` and the rest of the dangerous list is refused and stays session-scoped. This is the same floor `buildPermissionRequestSuggestions` already applies to the option it offers, and the docs' own "read-only commands" carve-out shows the tier table is not meant to be applied without one` |
| "Until session end" ending at session DELETION or host exit | `documented, not implemented — the window map is in-memory on SessionManager and is cleared on session deletion and with the process. A session closed and reopened inside one app run keeps its answers, which is a longer reading of "session" than a CLI's, and still far shorter than the ten minutes it replaced` |
| `updatedPermissions` `addRules` at `session` for all three behaviors (`hooks.md:1687`) | `documented, implemented` — allow via the session whitelist, deny/ask via a session DSL layer |
| `replaceRules` / `removeRules` at `session` (`:1688`, `:1689`) | `documented, implemented` for deny/ask |
| `addRules` deny/ask at `localSettings` / `projectSettings` (`:1702`–`:1705`) | `documented, implemented` |
| The echo case: a persisted grant equal to an offered suggestion (`:1707`) | `documented, implemented` |
| `replaceRules` / `removeRules` at a settings destination | `documented, not implemented — it would delete rules this session did not author, including an administrator's. The writer has no removal primitive at all, so the refusal is structural rather than a check` |
| `replaceRules` / `removeRules` for `behavior: 'allow'` | `documented, not implemented — a session allow grant lives in the whitelist, which is keyed by base command and carries no rule identity to match a removal against` |
| A session `allow` as a DSL rule rather than a whitelist entry | `documented, not implemented — the whitelist carries the dangerous-base-command floor; a DSL allow rule would bypass it, so a hook could auto-approve `Bash(rm *)` for the rest of the session` |
| `destination: 'userSettings'` (`:1706`) | `documented, not implemented — no reader for `~/.claude/settings.json`, so the write would be a rule that silently does nothing` |
| `setMode` at a settings destination (`:1690`) | `documented, not implemented — `permissions.defaultMode` has no reader (Unit 4's row), so a persisted mode would be inert` |
| `addDirectories` / `removeDirectories` at a settings destination (`:1691`, `:1692`) | `documented, not implemented — `permissions.additionalDirectories` has no reader, so the write would grant nothing` |

## Gate evidence

Run from the REPO ROOT throughout. Permission decisions and a new
settings-write surface are two listed immediate risk triggers, so the
permission, mode and config aggregates were run once on the final diff.

```
$ bun run typecheck:all
exit 0, no output — core, shared, server-core, server, session-tools-core,
pi-agent-server, apps/electron, ui all clean. No detached worktree was needed.

$ bun run lint
exit 0 — 122 warnings, 0 errors, none in this diff (the pre-existing unused
eslint-disable directives in session-scoped-tools.ts, setupI18n.ts, debug.ts and
the electron/ui backlog).

$ bun run lint:i18n:sorted && bun run lint:i18n:parity
exit 0 — "i18n parity OK (1 locales, 2017 keys each)" after the three new
chat.permissionRemember.* keys landed in en.json and ru.json.
```

Permission aggregate (22 files — the DSL, all four rule compilers, the Cd
evaluator, the settings store, the project-settings reader, the receipt, managed
policy, the sandbox rule converter, both permission managers, the permission
service, the SessionManager authority/remember/Cd-gate suites, and the worktree
cwd transaction):

```
 317 pass, 0 fail, 954 expect() calls, 22 files
```

Mode aggregate (11 files):

```
 35 pass, 0 fail, 179 expect() calls, 11 files
```

Config aggregate (`packages/shared/src/config`, the content validators, and the
whole capability inventory — 60 files):

```
 753 pass, 2 fail, 1977 expect() calls, 60 files
```

Both failures are the known pre-existing `paths-default-root` pair.

Whole-package sweep of everything touched:

```
$ bun test packages/shared packages/server-core packages/session-tools-core
 7195 pass, 18 skip, 12 fail, 6 snapshots, 21695 expect() calls, 600 files

$ bun test packages/pi-agent-server
 470 pass, 1 fail, 10905 expect() calls, 64 files

$ bun test apps/electron
 1264 pass, 0 fail, 4142 expect() calls, 155 files
```

Twelve of the thirteen failures are the known pre-existing set and nothing else:
seven `ensureStorageLayoutV2`, two `paths-default-root`, one
`managed paths with NESSY_CONFIG_DIR`, the two `SessionManager.orchestration`
background-authority cases, and `Pi harness R0 baseline > executes golden
foreground and background process contracts`.

The thirteenth, `TaskCreated exit 2 rolls the creation back > the task does NOT
exist afterwards and the model sees stderr`, is a **load-dependent flake, not a
regression**: it fails only inside the 600-file sweep, at 5012ms against a 5s
budget, and `bun test packages/server-core/src/pi-harness/task-hook-decision.test.ts`
runs 10 pass / 0 fail on the same tree. Nothing in this unit touches the task
tools or hook subprocess spawn. The load-order-dependent
`AUTO_MEMORY_MARKER_REGEX_SOURCE` TDZ did not surface in any run.

## Worklist claims that were wrong about the code

1. **Every line anchor in all five rows had drifted, non-uniformly.**
   `mutateWorkingDirectory` is at `SessionManager.ts:12829`, not `:12685` — the
   worklist's own correction of `:12613`→`:12685` was itself already stale by
   144 lines. The `Cd` case was at `claude-permission-rules.ts:350`, not
   `:323-330`; the `PowerShell` case at `:311`, not `:284-290`; the
   `updatedPermissions` applier at `pi-agent.ts:2801`, not `:2759-2865`. Every
   site was found by symbol.

2. **"`parseClaudeRuleString` has exactly 2 production callers".** It has four:
   `hooks-automation.ts`, `sandbox-permission-rules.ts`, `managed-policy.ts` and
   `prerequisite-manager.ts` (now six, with `permissions-config.ts` and
   `pi-agent.ts`). The row's conclusion — that none of them is a settings
   reader — was right; the count was not.

3. **The PowerShell row's "the AST matcher ships with a live consumer" is true
   but is not the fix.** `powershell-validator.ts` `spawnSync`s a real `pwsh`
   and returns `powershell_unavailable` when there is none. Reaching for it from
   a permission matcher would make every rule evaluation a subprocess spawn and
   would make the answer depend on whether PowerShell is installed. The live
   consumer is also not `:1443` (`getPowerShellRejectionReason`) but the routing
   gate at `mode-manager.ts:1306`, which is the part worth reusing — and is what
   `looksLikePowerShell` now shares.

4. **The `updatedPermissions` row's "pinned green at
   `pi-agent-pretool-hook-decision.test.ts:812-835` (38 pass)" is stale twice.**
   The file held 44 `it(` blocks at this unit's base, not 38, and the pin that
   had to be rewritten is the "a non-session destination defers with a
   diagnostic" case, which asserted the `updated_permissions_deferred` code the
   row is about removing.

5. **The Cd row's claim that the blocking reason is false is right, and
   understates it.** The worklist says `mutateWorkingDirectory` "exists […] with
   four call sites"; what it does not say is that the transaction already
   distinguishes user-driven from agent-driven moves by construction — the
   worktree port passes `preserveSdkCwd` and the RPC does not — so the
   documented "the rules apply only when you run `/cd` yourself" scoping needed
   one flag, not a new discriminator.

Everything else the worklist asserted about these five rows reproduced exactly,
including the `alwaysAllow` premise-false correction (the SessionManager remember
window was measured working before any change), the "0 inert" probe on a verbatim
Claude permissions block, and the `gitignore-glob.ts` bare-literal float being the
single gap between the shared matcher and the documented Cd table.

## Propagation found, not fixed

- **Untrusted-project restrict-only rules.** `native-sources.ts` withholds every
  project-scope record when the project is untrusted, with one `blockedLayers`
  diagnostic covering all of `PROJECT_WITHHELD_KINDS`. permissions.md:534 says
  `deny` and `ask` rules apply anyway, "since they only restrict". Closing that
  means emitting a restrict-only project record pre-trust and teaching
  `compilePermissionDslV1` to keep non-allow rules from an untrusted project
  layer instead of skipping the layer whole. Both halves are needed; neither is
  in this row's scope. It is a tightening, so nothing is currently over-permitted
  by it.

- **The whole User tier of Claude settings has no reader.**
  `~/.claude/settings.json` is never parsed for permissions, which is why
  `destination: 'userSettings'` is refused rather than written. The same file
  carries `permissions.defaultMode` and `permissions.additionalDirectories`,
  which is why `setMode` and `addDirectories` at a settings destination are
  refused too. One reader would unblock all three.

- **`getBaseCommand` strips a leading `sudo` everywhere.** Row 4 guards the
  durable-persistence site, but the session whitelist and
  `buildPermissionRequestSuggestions` still key on the stripped base: approving
  `sudo apt install x` with Always Allow offers, and session-whitelists,
  `apt`. Worth its own small fix in `permission-manager.ts`.

- **`buildPermissionRequestSuggestions` offers `Bash(<base>:*)` while the human
  answer now persists `Bash(<base> *)`.** The two are equivalent by
  permissions.md:136, and the echo comparison in row 5 compares against our own
  offered string so it still matches, but :138 specifically says the dialog
  writes the space-separated form. Aligning the suggestion spelling would remove
  the only place the two disagree.

- **There is no `/permissions`-equivalent surface.** A `Cd` refusal shows as a
  `working_directory_error`, a written `.claude/settings.local.json` rule is
  visible only in the file, and a hook-authored session rule is visible only in
  the `__PERMISSION_UPDATE__` receipt line. Every rule source this unit added is
  enforced but unlistable. The Sources UI divergence note already tracks the
  missing permissions display; this unit gives it four more things to show.

- **`task-hook-decision.test.ts`'s exit-2 rollback case is timing-sensitive
  under load** (5012ms against a 5s budget in a 600-file run, green in
  isolation). Not a parity row and not caused by this unit, but it will keep
  producing false red in full sweeps until its budget or its subprocess wait is
  reworked.
